import type pg from 'pg';
import type admin from 'firebase-admin';
import { createPgPool } from '../db/pool.js';
import { initFirebaseAdmin, listAllAuthUsers, extractUserRawCards } from './firebaseSource.js';
import {
  dedupeNormalizedCards,
  msToDateOrNull,
  normalizeMembershipTier,
  normalizeStoreDeckCounters,
  parseTimestampMs,
  sanitizeJsonValue,
  toFiniteInt
} from './normalizers.js';

type EtlMode = 'full' | 'incremental';

interface CliOptions {
  mode: EtlMode;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  let mode: EtlMode = 'full';
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--mode=incremental') mode = 'incremental';
    if (arg === '--mode=full') mode = 'full';
    if (arg === '--dry-run') dryRun = true;
  }
  return { mode, dryRun };
}

function mapProviderId(rawProviderId: string): 'google' | 'apple' | 'email' | null {
  if (rawProviderId === 'google.com') return 'google';
  if (rawProviderId === 'apple.com') return 'apple';
  if (rawProviderId === 'password') return 'email';
  return null;
}

function sanitizeUidSafeForLog(uid: string): string {
  return uid.length <= 8 ? uid : `${uid.slice(0, 4)}...${uid.slice(-4)}`;
}

async function getLastIncrementalWatermarkMs(client: pg.PoolClient): Promise<number> {
  const res = await client.query<{ watermark_ms: string | null }>(
    `SELECT COALESCE((source_watermarks->>'maxUserUpdatedMs')::bigint, 0) AS watermark_ms
     FROM etl_runs
     WHERE status = 'completed'
     ORDER BY started_at DESC
     LIMIT 1`
  );
  return res.rows[0]?.watermark_ms ? Number(res.rows[0].watermark_ms) || 0 : 0;
}

async function resolveUserUuid(
  client: pg.PoolClient,
  uidMap: Map<string, string>,
  firebaseUid: string | undefined | null
): Promise<string | null> {
  const clean = String(firebaseUid || '').trim();
  if (!clean) return null;
  const cached = uidMap.get(clean);
  if (cached) return cached;
  const res = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE firebase_uid = $1',
    [clean]
  );
  if (res.rows[0]?.id) {
    uidMap.set(clean, res.rows[0].id);
    return res.rows[0].id;
  }
  return null;
}

async function ensureStubUserForOrphanUid(
  client: pg.PoolClient,
  uidMap: Map<string, string>,
  usedNicknames: Set<string>,
  firebaseUid: string,
  fallbackName = '歷史玩家'
): Promise<string> {
  const existing = await resolveUserUuid(client, uidMap, firebaseUid);
  if (existing) return existing;

  const userRes = await client.query<{ id: string }>(
    `INSERT INTO users (firebase_uid, role, coins_balance)
     VALUES ($1, 'user', 0)
     ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [firebaseUid]
  );
  const userId = userRes.rows[0].id;
  uidMap.set(firebaseUid, userId);

  let nickLower = `${fallbackName.toLowerCase()}_${firebaseUid.slice(0, 6).toLowerCase()}`;
  if (usedNicknames.has(nickLower)) {
    nickLower = `u_${firebaseUid.slice(0, 12).toLowerCase()}`;
  }
  usedNicknames.add(nickLower);

  await client.query(
    `INSERT INTO user_profiles (user_id, nickname, nickname_lower)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, fallbackName, nickLower]
  );
  return userId;
}

async function runEtl(): Promise<void> {
  const { mode, dryRun } = parseCliArgs(process.argv.slice(2));
  console.log(`[ETL] Starting Firebase -> PostgreSQL 18 migration (mode=${mode}, dryRun=${dryRun})`);

  const fb = await initFirebaseAdmin();
  const pool = createPgPool();
  const client = await pool.connect();

  const stats = {
    authUsers: 0,
    firestoreUsers: 0,
    skippedUnchangedUsers: 0,
    decksUpserted: 0,
    cardsUpserted: 0,
    tombstonesUpserted: 0,
    storeDecksUpserted: 0,
    storePurchasesUpserted: 0,
    iapTxUpserted: 0,
    chatThreadsUpserted: 0,
    chatMessagesUpserted: 0,
    duelsUpserted: 0,
    raidsUpserted: 0,
    warnings: [] as string[]
  };

  let etlRunId: string | null = null;
  let maxUserUpdatedMs = 0;

  try {
    await client.query('BEGIN');

    if (!dryRun) {
      const runRow = await client.query<{ id: string }>(
        `INSERT INTO etl_runs (mode, status) VALUES ($1, 'running') RETURNING id`,
        [mode]
      );
      etlRunId = runRow.rows[0].id;
    }

    const incrementalWatermarkMs =
      mode === 'incremental' ? await getLastIncrementalWatermarkMs(client) : 0;

    // 1. Read Auth, Firestore core collections & RTDB
    const [
      authUsers,
      adminsSnap,
      usersSnap,
      publicProfilesSnap,
      nicknameIndexSnap,
      storeDecksSnap,
      processedTxSnap,
      processedOrdersSnap,
      reportsSnap,
      banAppealsSnap,
      systemConfigSnap
    ] = await Promise.all([
      listAllAuthUsers(fb.auth),
      fb.firestore.collection('admins').get(),
      fb.firestore.collection('users').get(),
      fb.firestore.collection('publicProfiles').get(),
      fb.firestore.collection('nicknameIndex').get(),
      fb.firestore.collection('storeDecks').get(),
      fb.firestore.collection('processedTransactions').get(),
      fb.firestore.collection('processedOrders').get(),
      fb.firestore.collection('reports').get(),
      fb.firestore.collection('banAppeals').get(),
      fb.firestore.collection('systemConfig').get()
    ]);

    stats.authUsers = authUsers.length;
    stats.firestoreUsers = usersSnap.size;

    const adminUidSet = new Set<string>(adminsSnap.docs.map((d) => d.id));
    const authByUid = new Map<string, admin.auth.UserRecord>(
      authUsers.map((u) => [u.uid, u])
    );
    const fsUserByUid = new Map<string, admin.firestore.QueryDocumentSnapshot>(
      usersSnap.docs.map((d) => [d.id, d])
    );
    const pubProfileByUid = new Map<string, Record<string, unknown>>(
      publicProfilesSnap.docs.map((d) => [d.id, d.data() || {}])
    );

    // Preferred nickname owner from nicknameIndex
    const nicknameOwnerByUid = new Map<string, string>();
    for (const nd of nicknameIndexSnap.docs) {
      const nData = nd.data() || {};
      const ownerUid = typeof nData.uid === 'string' ? nData.uid.trim() : '';
      if (ownerUid) {
        nicknameOwnerByUid.set(ownerUid, nd.id.toLowerCase());
      }
    }

    const allUids = new Set<string>([
      ...authByUid.keys(),
      ...fsUserByUid.keys(),
      ...pubProfileByUid.keys()
    ]);

    // Preload already allocated nicknames and emails from PG so incremental runs avoid collisions
    const [existingNickRes, existingEmailRes] = await Promise.all([
      client.query<{ user_id: string; nickname_lower: string }>(
        'SELECT user_id, nickname_lower FROM user_profiles'
      ),
      client.query<{ id: string; email: string }>(
        'SELECT id, LOWER(email) AS email FROM users WHERE email IS NOT NULL'
      )
    ]);
    const nickByUserId = new Map(existingNickRes.rows.map((r) => [r.user_id, r.nickname_lower]));
    const usedNicknames = new Set(existingNickRes.rows.map((r) => r.nickname_lower));
    const emailOwnerByLower = new Map(existingEmailRes.rows.map((r) => [r.email, r.id]));

    const uidToUuid = new Map<string, string>();
    const deferredSocial: Array<{ uid: string; data: Record<string, unknown> }> = [];
    const deferredPurchasedSnapshots: Array<{ uid: string; items: unknown[] }> = [];

    // 2. Upsert Users, Auth Identities, Profiles, Settings, Progression, Memberships, Quotas, Decks & Cards
    for (const uid of allUids) {
      const authRec = authByUid.get(uid);
      const fsDoc = fsUserByUid.get(uid);
      const fsData: Record<string, unknown> = fsDoc ? fsDoc.data() || {} : {};
      const pubData = pubProfileByUid.get(uid) || {};

      const docUpdatedMs = Math.max(
        parseTimestampMs(fsData.updatedAt),
        parseTimestampMs(fsData.lastSyncedAt),
        parseTimestampMs(pubData.updatedAt)
      );
      if (docUpdatedMs > maxUserUpdatedMs) {
        maxUserUpdatedMs = docUpdatedMs;
      }

      if (
        mode === 'incremental' &&
        incrementalWatermarkMs > 0 &&
        docUpdatedMs > 0 &&
        docUpdatedMs <= incrementalWatermarkMs - 60_000
      ) {
        const existingId = await resolveUserUuid(client, uidToUuid, uid);
        if (existingId) {
          stats.skippedUnchangedUsers += 1;
          continue;
        }
      }

      const emailRaw = String(authRec?.email || fsData.email || '').trim();
      let email: string | null = emailRaw ? emailRaw.toLowerCase() : null;
      const existingPgIdForUidRes = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE firebase_uid = $1',
        [uid]
      );
      const existingPgIdForUid = existingPgIdForUidRes.rows[0]?.id || null;
      if (email) {
        const ownerId = emailOwnerByLower.get(email);
        if (ownerId && ownerId !== existingPgIdForUid) {
          stats.warnings.push(`Duplicate legacy email skipped for uid=${sanitizeUidSafeForLog(uid)}`);
          email = null;
        }
      }
      const emailVerified = Boolean(authRec?.emailVerified);
      const passwordHash = authRec?.passwordHash || null;
      const passwordSalt = authRec?.passwordSalt || null;
      const passwordAlgo = passwordHash ? 'firebase_scrypt' : null;

      const isAdmin =
        adminUidSet.has(uid) ||
        fsData.isAdmin === true ||
        String(fsData.role || '').trim().toLowerCase() === 'admin' ||
        pubData.isAdmin === true;
      const role = isAdmin ? 'admin' : 'user';

      const ban = (fsData.ban && typeof fsData.ban === 'object' ? fsData.ban : {}) as Record<
        string,
        unknown
      >;
      const isBanned = Boolean(ban.isBanned);
      const banReason = String(ban.reason || '');
      const bannedAt = msToDateOrNull(ban.bannedAt);
      const banExpiresAt = msToDateOrNull(ban.expiresAt);
      const unbannedAt = msToDateOrNull(ban.unbannedAt);
      const coinsBalance = toFiniteInt(fsData.coins, 0, 0);
      const createdAt =
        msToDateOrNull(authRec?.metadata.creationTime) ||
        msToDateOrNull(fsData.createdAt) ||
        new Date();

      const userRes = await client.query<{ id: string }>(
        `INSERT INTO users (
           firebase_uid, email, email_verified, password_hash, password_algo, password_salt,
           role, is_banned, ban_reason, banned_at, ban_expires_at, unbanned_at,
           coins_balance, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12,
           $13, $14, now()
         )
         ON CONFLICT (firebase_uid) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, users.email),
           email_verified = EXCLUDED.email_verified OR users.email_verified,
           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
           password_algo = COALESCE(EXCLUDED.password_algo, users.password_algo),
           password_salt = COALESCE(EXCLUDED.password_salt, users.password_salt),
           role = EXCLUDED.role,
           is_banned = EXCLUDED.is_banned,
           ban_reason = EXCLUDED.ban_reason,
           banned_at = COALESCE(EXCLUDED.banned_at, users.banned_at),
           ban_expires_at = EXCLUDED.ban_expires_at,
           unbanned_at = COALESCE(EXCLUDED.unbanned_at, users.unbanned_at),
           coins_balance = EXCLUDED.coins_balance,
           updated_at = now()
         RETURNING id`,
        [
          uid,
          email,
          emailVerified,
          passwordHash,
          passwordAlgo,
          passwordSalt,
          role,
          isBanned,
          banReason,
          bannedAt,
          banExpiresAt,
          unbannedAt,
          coinsBalance,
          createdAt
        ]
      );
      const userId = userRes.rows[0].id;
      uidToUuid.set(uid, userId);
      if (email) {
        emailOwnerByLower.set(email, userId);
      }

      // Identities (Google / Apple / Email)
      if (authRec) {
        for (const pInfo of authRec.providerData || []) {
          const provider = mapProviderId(pInfo.providerId);
          const subject = String(pInfo.uid || '').trim();
          if (!provider || !subject) continue;
          await client.query(
            `INSERT INTO user_identities (user_id, provider, provider_subject, provider_email, raw_profile)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (user_id, provider) DO UPDATE SET
               provider_subject = EXCLUDED.provider_subject,
               provider_email = EXCLUDED.provider_email,
               raw_profile = EXCLUDED.raw_profile`,
            [
              userId,
              provider,
              subject,
              String(pInfo.email || email || ''),
              JSON.stringify({ displayName: pInfo.displayName || '', photoURL: pInfo.photoURL || '' })
            ]
          );
        }
      }

      // Coin ledger opening / incremental delta entry (immutable & zero-drift)
      const ledgerSumRes = await client.query<{ ledger_sum: string }>(
        'SELECT COALESCE(SUM(delta), 0)::text AS ledger_sum FROM coin_ledger WHERE user_id = $1',
        [userId]
      );
      const currentLedgerSum = Number(ledgerSumRes.rows[0]?.ledger_sum || 0);
      const coinDelta = coinsBalance - currentLedgerSum;
      if (coinDelta !== 0) {
        const idempKey =
          currentLedgerSum === 0
            ? `etl:opening:${uid}`
            : `etl:sync:${uid}:${currentLedgerSum}:${coinsBalance}`;
        await client.query(
          `INSERT INTO coin_ledger (
             user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key, metadata
           ) VALUES ($1, $2, $3, 'legacy_opening_balance', 'firebase_user', $4, $5, $6::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            userId,
            coinDelta,
            coinsBalance,
            uid,
            idempKey,
            JSON.stringify({ source: 'firestore_users_doc', previousLedgerSum: currentLedgerSum })
          ]
        );
      }

      // Profile
      const rawNick = String(
        fsData.nickname || pubData.nickname || fsData.displayName || authRec?.displayName || '學習者'
      ).trim() || '學習者';
      const preferredLower =
        nicknameOwnerByUid.get(uid) ||
        String(fsData.nicknameLower || rawNick).trim().toLowerCase() ||
        `u_${uid.slice(0, 8).toLowerCase()}`;

      let finalNickLower = nickByUserId.get(userId) || preferredLower;
      if (!nickByUserId.has(userId) && usedNicknames.has(finalNickLower)) {
        finalNickLower = `${preferredLower.slice(0, 40)}_${uid.slice(0, 6).toLowerCase()}`;
        let suffixCounter = 1;
        while (usedNicknames.has(finalNickLower)) {
          finalNickLower = `${preferredLower.slice(0, 32)}_${uid.slice(0, 8).toLowerCase()}_${suffixCounter++}`;
        }
        stats.warnings.push(`Disambiguated duplicate nicknameLower for uid=${sanitizeUidSafeForLog(uid)}`);
      }
      usedNicknames.add(finalNickLower);
      nickByUserId.set(userId, finalNickLower);

      const cos = ((fsData.cosmetics || pubData.cosmetics || {}) as Record<string, unknown>);
      const priv = ((fsData.privacy || pubData.privacy || {}) as Record<string, unknown>);
      const avatarUrl = String(
        pubData.avatar || fsData.photoURL || authRec?.photoURL || ''
      );

      await client.query(
        `INSERT INTO user_profiles (
           user_id, nickname, nickname_lower, display_name, username, bio, avatar_url,
           is_stats_public, hide_on_leaderboard, privacy_hide_status,
           cosmetic_frame, cosmetic_banner, cosmetic_title,
           unlocked_frames, unlocked_banners, unlocked_titles, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10,
           $11, $12, $13,
           $14::jsonb, $15::jsonb, $16::jsonb, now()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           nickname = EXCLUDED.nickname,
           display_name = EXCLUDED.display_name,
           username = EXCLUDED.username,
           bio = EXCLUDED.bio,
           avatar_url = EXCLUDED.avatar_url,
           is_stats_public = EXCLUDED.is_stats_public,
           hide_on_leaderboard = EXCLUDED.hide_on_leaderboard,
           privacy_hide_status = EXCLUDED.privacy_hide_status,
           cosmetic_frame = EXCLUDED.cosmetic_frame,
           cosmetic_banner = EXCLUDED.cosmetic_banner,
           cosmetic_title = EXCLUDED.cosmetic_title,
           unlocked_frames = EXCLUDED.unlocked_frames,
           unlocked_banners = EXCLUDED.unlocked_banners,
           unlocked_titles = EXCLUDED.unlocked_titles,
           updated_at = now()`,
        [
          userId,
          rawNick,
          finalNickLower,
          String(fsData.displayName || authRec?.displayName || ''),
          String(fsData.username || ''),
          String(fsData.bio || pubData.bio || ''),
          avatarUrl,
          priv.isStatsPublic !== false,
          Boolean(priv.hideOnLeaderboard),
          Boolean(fsData.privacyHideStatus),
          String(cos.frame || 'default'),
          String(cos.banner || 'default'),
          String(cos.title || 'newcomer'),
          JSON.stringify(Array.isArray(cos.unlockedFrames) ? cos.unlockedFrames : []),
          JSON.stringify(Array.isArray(cos.unlockedBanners) ? cos.unlockedBanners : []),
          JSON.stringify(Array.isArray(cos.unlockedTitles) ? cos.unlockedTitles : [])
        ]
      );

      // Owned cosmetics
      if (Array.isArray(fsData.purchasedCosmetics)) {
        for (const cId of fsData.purchasedCosmetics) {
          const cleanCId = String(cId || '').trim();
          if (!cleanCId) continue;
          await client.query(
            `INSERT INTO user_owned_cosmetics (user_id, cosmetic_id, source)
             VALUES ($1, $2, 'legacy_migrated')
             ON CONFLICT (user_id, cosmetic_id) DO NOTHING`,
            [userId, cleanCId]
          );
        }
      }

      // Settings
      const s = (fsData.settings && typeof fsData.settings === 'object' ? fsData.settings : {}) as Record<
        string,
        unknown
      >;
      const knownSettingKeys = new Set([
        'nativeLang',
        'targetLang',
        'customNative',
        'customTarget',
        'displayMode',
        'phoneticPos',
        'theme',
        'studyMode',
        'autoPlayAudio',
        'showSentenceFront',
        'showMorphemes',
        'notifFriendMsg',
        'notifAnnouncements',
        'notifFriendRequests',
        'notifTeamInvites',
        'onboardingCompleted',
        'onboardingV2Done'
      ]);
      const extraSettings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) {
        if (!knownSettingKeys.has(k) && v !== undefined) {
          extraSettings[k] = sanitizeJsonValue(v);
        }
      }
      await client.query(
        `INSERT INTO user_settings (
           user_id, native_lang, target_lang, custom_native, custom_target,
           display_mode, phonetic_pos, theme, study_mode,
           auto_play_audio, show_sentence_front, show_morphemes,
           notif_friend_msg, notif_announcements, notif_friend_requests, notif_team_invites,
           onboarding_completed, onboarding_v2_done,
           selected_categories, custom_categories, chat_prefs, extra_settings, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18,
           $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, now()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           native_lang = EXCLUDED.native_lang,
           target_lang = EXCLUDED.target_lang,
           custom_native = EXCLUDED.custom_native,
           custom_target = EXCLUDED.custom_target,
           display_mode = EXCLUDED.display_mode,
           phonetic_pos = EXCLUDED.phonetic_pos,
           theme = EXCLUDED.theme,
           study_mode = EXCLUDED.study_mode,
           auto_play_audio = EXCLUDED.auto_play_audio,
           show_sentence_front = EXCLUDED.show_sentence_front,
           show_morphemes = EXCLUDED.show_morphemes,
           notif_friend_msg = EXCLUDED.notif_friend_msg,
           notif_announcements = EXCLUDED.notif_announcements,
           notif_friend_requests = EXCLUDED.notif_friend_requests,
           notif_team_invites = EXCLUDED.notif_team_invites,
           onboarding_completed = EXCLUDED.onboarding_completed,
           onboarding_v2_done = EXCLUDED.onboarding_v2_done,
           selected_categories = EXCLUDED.selected_categories,
           custom_categories = EXCLUDED.custom_categories,
           chat_prefs = EXCLUDED.chat_prefs,
           extra_settings = EXCLUDED.extra_settings,
           updated_at = now()`,
        [
          userId,
          String(s.nativeLang || 'zh-TW'),
          String(s.targetLang || 'en'),
          String(s.customNative || ''),
          String(s.customTarget || ''),
          String(s.displayMode || 'target_front'),
          String(s.phoneticPos || 'front'),
          String(s.theme || 'system'),
          s.studyMode === 'free' ? 'free' : 'fsrs',
          Boolean(s.autoPlayAudio),
          Boolean(s.showSentenceFront),
          s.showMorphemes !== false,
          s.notifFriendMsg !== false,
          s.notifAnnouncements !== false,
          s.notifFriendRequests !== false,
          s.notifTeamInvites !== false,
          Boolean(s.onboardingCompleted),
          Boolean(s.onboardingV2Done),
          JSON.stringify(Array.isArray(fsData.selectedCategories) ? fsData.selectedCategories : []),
          JSON.stringify(
            Array.isArray(fsData.customCategories || fsData.categories)
              ? (fsData.customCategories || fsData.categories)
              : []
          ),
          JSON.stringify(sanitizeJsonValue(fsData.chatPrefs || {}) || {}),
          JSON.stringify(extraSettings)
        ]
      );

      // Progression & Quiz Score
      const prog = ((fsData.progression || pubData.stats || {}) as Record<string, unknown>);
      const quiz = ((fsData.quizScore || {}) as Record<string, unknown>);
      await client.query(
        `INSERT INTO user_progression (
           user_id, xp, level, streak_days, streak_shields, last_active_date,
           rank_tier, rank_points, duel_wins, duel_total,
           quiz_correct, quiz_total, quiz_updated_at, last_synced_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13, $14, now()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           xp = EXCLUDED.xp,
           level = EXCLUDED.level,
           streak_days = EXCLUDED.streak_days,
           streak_shields = EXCLUDED.streak_shields,
           last_active_date = EXCLUDED.last_active_date,
           rank_tier = EXCLUDED.rank_tier,
           rank_points = EXCLUDED.rank_points,
           duel_wins = EXCLUDED.duel_wins,
           duel_total = EXCLUDED.duel_total,
           quiz_correct = EXCLUDED.quiz_correct,
           quiz_total = EXCLUDED.quiz_total,
           quiz_updated_at = EXCLUDED.quiz_updated_at,
           last_synced_at = COALESCE(EXCLUDED.last_synced_at, user_progression.last_synced_at),
           updated_at = now()`,
        [
          userId,
          toFiniteInt(prog.xp, 0, 0),
          toFiniteInt(prog.level, 1, 1),
          toFiniteInt(prog.streakDays, 0, 0),
          toFiniteInt(prog.streakShields, 0, 0, 3),
          String(prog.lastActiveDate || ''),
          String(prog.rankTier || '青銅 III'),
          toFiniteInt(prog.rankPoints, 0, 0),
          toFiniteInt(prog.duelWins, 0, 0),
          toFiniteInt(prog.duelTotal, 0, 0),
          toFiniteInt(quiz.correct, 0, 0),
          toFiniteInt(quiz.total, 0, 0),
          parseTimestampMs(quiz.updatedAt),
          msToDateOrNull(fsData.lastSyncedAt || fsData.updatedAt)
        ]
      );

      // Daily activity (verbatim, zero fabrication)
      if (fsData.dailyActivity && typeof fsData.dailyActivity === 'object') {
        for (const [dateKey, payload] of Object.entries(fsData.dailyActivity as Record<string, unknown>)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
          await client.query(
            `INSERT INTO daily_study_activity (user_id, activity_date, payload)
             VALUES ($1, $2::date, $3::jsonb)
             ON CONFLICT (user_id, activity_date) DO UPDATE SET
               payload = EXCLUDED.payload,
               updated_at = now()`,
            [userId, dateKey, JSON.stringify(sanitizeJsonValue(payload) || {})]
          );
        }
      }

      // Membership + History
      const mem = ((fsData.membership || {}) as Record<string, unknown>);
      const tier = normalizeMembershipTier(mem.tier);
      await client.query(
        `INSERT INTO user_memberships (
           user_id, tier, tier_price_ntd, billing_cycle, started_at, expires_at,
           total_donated_ntd, auto_downgraded_at, source, last_order_id, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (user_id) DO UPDATE SET
           tier = EXCLUDED.tier,
           tier_price_ntd = EXCLUDED.tier_price_ntd,
           billing_cycle = EXCLUDED.billing_cycle,
           started_at = EXCLUDED.started_at,
           expires_at = EXCLUDED.expires_at,
           total_donated_ntd = EXCLUDED.total_donated_ntd,
           auto_downgraded_at = EXCLUDED.auto_downgraded_at,
           source = EXCLUDED.source,
           last_order_id = EXCLUDED.last_order_id,
           updated_at = now()`,
        [
          userId,
          tier,
          toFiniteInt(mem.tierPriceNtd, 0, 0),
          String(mem.billingCycle || 'monthly'),
          msToDateOrNull(mem.startedAt),
          msToDateOrNull(mem.expiresAt),
          toFiniteInt(mem.totalDonatedNtd, 0, 0),
          msToDateOrNull(mem.autoDowngradedAt),
          String(mem.source || ''),
          String(mem.lastOrderId || '')
        ]
      );

      if (Array.isArray(fsData.membershipHistory)) {
        const existingHist = await client.query<{ cnt: string }>(
          'SELECT COUNT(*)::text AS cnt FROM membership_history WHERE user_id = $1',
          [userId]
        );
        if (Number(existingHist.rows[0]?.cnt || 0) === 0) {
          for (const h of fsData.membershipHistory) {
            if (!h || typeof h !== 'object') continue;
            const hr = h as Record<string, unknown>;
            await client.query(
              `INSERT INTO membership_history (
                 user_id, tier, price_ntd, billing_cycle, started_at, expires_at, source, order_id
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                userId,
                String(hr.tier || 'free'),
                toFiniteInt(hr.priceNtd, 0, 0),
                String(hr.billingCycle || 'monthly'),
                msToDateOrNull(hr.startedAt),
                msToDateOrNull(hr.expiresAt),
                String(hr.source || ''),
                String(hr.orderId || '')
              ]
            );
          }
        }
      }

      // AI Quotas & CoinBoost
      const aiUsage = ((fsData.aiUsage || {}) as Record<string, unknown>);
      const aiDaily = ((aiUsage.daily || {}) as Record<string, unknown>);
      const aiMonthly = ((aiUsage.monthly || {}) as Record<string, unknown>);
      const boost = ((fsData.coinBoost || {}) as Record<string, unknown>);
      const boostCredits = ((boost.credits || {}) as Record<string, unknown>);
      await client.query(
        `INSERT INTO user_ai_quotas (
           user_id, daily_date, monthly_key,
           daily_def_fill, daily_article_gen, daily_vision_ocr, daily_fast_refine,
           monthly_def_fill, monthly_article_gen, monthly_vision_ocr, monthly_fast_refine,
           trial_tier, trial_expires_at,
           credit_def_fill, credit_article_gen, credit_vision_ocr, credit_fast_refine,
           last_redeemed_at, updated_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13,
           $14, $15, $16, $17,
           $18, now()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           daily_date = EXCLUDED.daily_date,
           monthly_key = EXCLUDED.monthly_key,
           daily_def_fill = EXCLUDED.daily_def_fill,
           daily_article_gen = EXCLUDED.daily_article_gen,
           daily_vision_ocr = EXCLUDED.daily_vision_ocr,
           daily_fast_refine = EXCLUDED.daily_fast_refine,
           monthly_def_fill = EXCLUDED.monthly_def_fill,
           monthly_article_gen = EXCLUDED.monthly_article_gen,
           monthly_vision_ocr = EXCLUDED.monthly_vision_ocr,
           monthly_fast_refine = EXCLUDED.monthly_fast_refine,
           trial_tier = EXCLUDED.trial_tier,
           trial_expires_at = EXCLUDED.trial_expires_at,
           credit_def_fill = EXCLUDED.credit_def_fill,
           credit_article_gen = EXCLUDED.credit_article_gen,
           credit_vision_ocr = EXCLUDED.credit_vision_ocr,
           credit_fast_refine = EXCLUDED.credit_fast_refine,
           last_redeemed_at = EXCLUDED.last_redeemed_at,
           updated_at = now()`,
        [
          userId,
          String(aiUsage.dailyDate || ''),
          String(aiUsage.monthlyKey || ''),
          toFiniteInt(aiDaily.def_fill, 0, 0),
          toFiniteInt(aiDaily.article_gen, 0, 0),
          toFiniteInt(aiDaily.vision_ocr, 0, 0),
          toFiniteInt(aiDaily.fast_refine, 0, 0),
          toFiniteInt(aiMonthly.def_fill, 0, 0),
          toFiniteInt(aiMonthly.article_gen, 0, 0),
          toFiniteInt(aiMonthly.vision_ocr, 0, 0),
          toFiniteInt(aiMonthly.fast_refine, 0, 0),
          String(boost.trialTier || 'free'),
          msToDateOrNull(boost.trialExpiresAt),
          toFiniteInt(boostCredits.def_fill, 0, 0),
          toFiniteInt(boostCredits.article_gen, 0, 0),
          toFiniteInt(boostCredits.vision_ocr, 0, 0),
          toFiniteInt(boostCredits.fast_refine, 0, 0),
          msToDateOrNull(boost.lastRedeemedAt)
        ]
      );

      // FSRS Decks & Word Cards (supports all 4 storage formats)
      if (fsDoc) {
        const rawCards = await extractUserRawCards(fsDoc.ref, fsData);
        const dedupedCards = dedupeNormalizedCards(rawCards);
        const manifest = ((fsData.deckManifest || {}) as Record<string, Record<string, unknown>>);

        const cardsByDeck = new Map<string, typeof dedupedCards>();
        for (const c of dedupedCards) {
          const list = cardsByDeck.get(c.clientDeckId) || [];
          list.push(c);
          cardsByDeck.set(c.clientDeckId, list);
        }

        const deckUuidByClientId = new Map<string, string>();
        for (const [clientDeckId, cards] of cardsByDeck.entries()) {
          const deckCategory = cards[0].category;
          const mInfo = manifest[clientDeckId] || {};
          const maxUpdated = cards.reduce((acc, c) => Math.max(acc, c.updatedAtMs), 0);
          const deckRes = await client.query<{ id: string }>(
            `INSERT INTO decks (
               user_id, client_deck_id, category, deck_hash, card_count, updated_at_ms, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (user_id, client_deck_id) DO UPDATE SET
               category = EXCLUDED.category,
               deck_hash = EXCLUDED.deck_hash,
               card_count = EXCLUDED.card_count,
               updated_at_ms = EXCLUDED.updated_at_ms,
               updated_at = now()
             RETURNING id`,
            [
              userId,
              clientDeckId,
              deckCategory,
              String(mInfo.hash || ''),
              cards.length,
              Math.max(maxUpdated, parseTimestampMs(mInfo.updatedAt))
            ]
          );
          deckUuidByClientId.set(clientDeckId, deckRes.rows[0].id);
          stats.decksUpserted += 1;
        }

        for (const c of dedupedCards) {
          const deckId = deckUuidByClientId.get(c.clientDeckId);
          if (!deckId) continue;
          await client.query(
            `INSERT INTO word_cards (
               user_id, deck_id, client_card_id, client_deck_id, category, word,
               pos, phonetic, meaning, sentence, translation, lang,
               level, know_streak, fsrs_state, stability, difficulty, reps, lapses,
               last_review_ms, next_review_ms, free_level, free_streak,
               boss_wrong_count, last_boss_wrong_at_ms, diff_level, diff_level_manual,
               extra_fields, updated_at_ms, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23,
               $24, $25, $26, $27,
               $28::jsonb, $29, now()
             )
             ON CONFLICT (user_id, client_card_id) DO UPDATE SET
               deck_id = EXCLUDED.deck_id,
               client_deck_id = EXCLUDED.client_deck_id,
               category = EXCLUDED.category,
               word = EXCLUDED.word,
               pos = EXCLUDED.pos,
               phonetic = EXCLUDED.phonetic,
               meaning = EXCLUDED.meaning,
               sentence = EXCLUDED.sentence,
               translation = EXCLUDED.translation,
               lang = EXCLUDED.lang,
               level = EXCLUDED.level,
               know_streak = EXCLUDED.know_streak,
               fsrs_state = EXCLUDED.fsrs_state,
               stability = EXCLUDED.stability,
               difficulty = EXCLUDED.difficulty,
               reps = EXCLUDED.reps,
               lapses = EXCLUDED.lapses,
               last_review_ms = EXCLUDED.last_review_ms,
               next_review_ms = EXCLUDED.next_review_ms,
               free_level = EXCLUDED.free_level,
               free_streak = EXCLUDED.free_streak,
               boss_wrong_count = EXCLUDED.boss_wrong_count,
               last_boss_wrong_at_ms = EXCLUDED.last_boss_wrong_at_ms,
               diff_level = EXCLUDED.diff_level,
               diff_level_manual = EXCLUDED.diff_level_manual,
               extra_fields = EXCLUDED.extra_fields,
               updated_at_ms = EXCLUDED.updated_at_ms,
               updated_at = now()`,
            [
              userId,
              deckId,
              c.clientCardId,
              c.clientDeckId,
              c.category,
              c.word,
              c.pos,
              c.phonetic,
              c.meaning,
              c.sentence,
              c.translation,
              c.lang,
              c.level,
              c.knowStreak,
              c.fsrsState,
              c.stability,
              c.difficulty,
              c.reps,
              c.lapses,
              c.lastReviewMs,
              c.nextReviewMs,
              c.freeLevel,
              c.freeStreak,
              c.bossWrongCount,
              c.lastBossWrongAtMs,
              c.diffLevel,
              c.diffLevelManual,
              JSON.stringify(c.extraFields),
              c.updatedAtMs
            ]
          );
          stats.cardsUpserted += 1;
        }

        // 90-day Tombstones
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        const upsertTombstones = async (
          entityType: 'deck' | 'card',
          mapObj: unknown
        ): Promise<void> => {
          if (!mapObj || typeof mapObj !== 'object') return;
          for (const [eid, rawTs] of Object.entries(mapObj as Record<string, unknown>)) {
            const deletedMs = parseTimestampMs(rawTs);
            if (!eid || deletedMs <= 0) continue;
            await client.query(
              `INSERT INTO sync_tombstones (user_id, entity_type, client_entity_id, deleted_at_ms, expires_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (user_id, entity_type, client_entity_id) DO UPDATE SET
                 deleted_at_ms = GREATEST(sync_tombstones.deleted_at_ms, EXCLUDED.deleted_at_ms),
                 expires_at = GREATEST(sync_tombstones.expires_at, EXCLUDED.expires_at)`,
              [userId, entityType, eid, deletedMs, new Date(deletedMs + ninetyDaysMs)]
            );
            stats.tombstonesUpserted += 1;
          }
        };
        await upsertTombstones('deck', fsData.deletedDecks);
        await upsertTombstones('card', fsData.deletedCards);
      }

      deferredSocial.push({ uid, data: fsData });
      if (Array.isArray(fsData.purchasedDecks) && fsData.purchasedDecks.length > 0) {
        deferredPurchasedSnapshots.push({ uid, items: fsData.purchasedDecks });
      }
    }

    // 3. Deferred Blocks & Friendships
    for (const { uid, data } of deferredSocial) {
      const userId = uidToUuid.get(uid);
      if (!userId) continue;

      if (Array.isArray(data.blockedUids)) {
        for (const targetRaw of data.blockedUids) {
          const targetUid = String(targetRaw || '').trim();
          if (!targetUid || targetUid === uid) continue;
          const targetId = await resolveUserUuid(client, uidToUuid, targetUid);
          if (!targetId || targetId === userId) continue;
          await client.query(
            `INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, targetId]
          );
        }
      }

      if (Array.isArray(data.friends)) {
        for (const fr of data.friends) {
          const fUid =
            fr && typeof fr === 'object'
              ? String((fr as Record<string, unknown>).uid || '').trim()
              : '';
          if (!fUid || fUid === uid) continue;
          const friendId = await resolveUserUuid(client, uidToUuid, fUid);
          if (!friendId) continue;
          const [lowId, highId] = userId < friendId ? [userId, friendId] : [friendId, userId];
          await client.query(
            `INSERT INTO friendships (user_low_id, user_high_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [lowId, highId]
          );
        }
      }
    }

    // 4. Store Decks + Subcollections + Buyer Snapshot Preservation
    const storeUuidByLegacyId = new Map<string, string>();
    for (const sDoc of storeDecksSnap.docs) {
      const d = (sDoc.data() || {}) as Record<string, unknown>;
      const legacyId = sDoc.id;
      const authorUid = String(d.authorUid || d.uid || '').trim();
      const authorUserId = await resolveUserUuid(client, uidToUuid, authorUid);
      const counters = normalizeStoreDeckCounters(d);
      const cardsArr = Array.isArray(d.cards) ? d.cards : [];
      const previewArr = Array.isArray(d.cardsPreview) ? d.cardsPreview : cardsArr.slice(0, 6);

      const sdRes = await client.query<{ id: string }>(
        `INSERT INTO store_decks (
           legacy_firestore_id, author_user_id, author_uid_snapshot, author_name_snapshot,
           author_avatar_snapshot, title, description, category, target_lang, native_lang,
           is_paid, price_coins, card_count, cards_json, cards_preview_json,
           likes_count, favorites_count, downloads_count, views_count,
           monthly_views, monthly_downloads, stat_month_key,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14::jsonb, $15::jsonb,
           $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24
         )
         ON CONFLICT (legacy_firestore_id) DO UPDATE SET
           author_user_id = COALESCE(EXCLUDED.author_user_id, store_decks.author_user_id),
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           category = EXCLUDED.category,
           is_paid = EXCLUDED.is_paid,
           price_coins = EXCLUDED.price_coins,
           card_count = EXCLUDED.card_count,
           cards_json = EXCLUDED.cards_json,
           cards_preview_json = EXCLUDED.cards_preview_json,
           likes_count = EXCLUDED.likes_count,
           favorites_count = EXCLUDED.favorites_count,
           downloads_count = EXCLUDED.downloads_count,
           views_count = EXCLUDED.views_count,
           monthly_views = EXCLUDED.monthly_views,
           monthly_downloads = EXCLUDED.monthly_downloads,
           stat_month_key = EXCLUDED.stat_month_key,
           updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [
          legacyId,
          authorUserId,
          authorUid,
          String(d.authorName || '創作者'),
          String(d.authorAvatar || ''),
          String(d.title || d.category || '未命名單字庫'),
          String(d.description || ''),
          String(d.category || ''),
          String(d.targetLang || 'en'),
          String(d.nativeLang || 'zh-TW'),
          Boolean(d.isPaid),
          toFiniteInt(d.priceCoins, 0, 0),
          toFiniteInt(d.cardCount, cardsArr.length, 0),
          JSON.stringify(sanitizeJsonValue(cardsArr) || []),
          JSON.stringify(sanitizeJsonValue(previewArr) || []),
          counters.likesCount,
          counters.favoritesCount,
          counters.downloadsCount,
          counters.viewsCount,
          counters.monthlyViews,
          counters.monthlyDownloads,
          counters.statMonthKey,
          msToDateOrNull(d.createdAt) || new Date(),
          msToDateOrNull(d.updatedAt) || new Date()
        ]
      );
      const storeDeckId = sdRes.rows[0].id;
      storeUuidByLegacyId.set(legacyId, storeDeckId);
      stats.storeDecksUpserted += 1;

      const [likersSnap, favsSnap, dlsSnap, purchasersSnap] = await Promise.all([
        sDoc.ref.collection('likers').get(),
        sDoc.ref.collection('favoriters').get(),
        sDoc.ref.collection('downloaders').get(),
        sDoc.ref.collection('purchasers').get()
      ]);

      const insertReaction = async (
        snap: admin.firestore.QuerySnapshot,
        type: 'like' | 'favorite' | 'download'
      ) => {
        for (const rDoc of snap.docs) {
          const rUserId = await resolveUserUuid(client, uidToUuid, rDoc.id);
          if (!rUserId) continue;
          await client.query(
            `INSERT INTO store_deck_reactions (store_deck_id, user_id, reaction_type)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [storeDeckId, rUserId, type]
          );
        }
      };
      await insertReaction(likersSnap, 'like');
      await insertReaction(favsSnap, 'favorite');
      await insertReaction(dlsSnap, 'download');

      for (const pDoc of purchasersSnap.docs) {
        const pData = (pDoc.data() || {}) as Record<string, unknown>;
        const buyerId = await resolveUserUuid(client, uidToUuid, pDoc.id);
        if (!buyerId) continue;
        const paid = toFiniteInt(pData.priceCoins ?? d.priceCoins, 0, 0);
        const royalty = toFiniteInt(pData.royaltyCoins, Math.floor(paid * 0.7), 0);
        await client.query(
          `INSERT INTO store_deck_purchases (
             buyer_user_id, store_deck_id, deck_key, author_user_id, author_uid_snapshot,
             price_coins_paid, author_royalty_coins, deck_title_snapshot, deck_snapshot_json, purchased_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (buyer_user_id, deck_key) DO NOTHING`,
          [
            buyerId,
            storeDeckId,
            legacyId,
            authorUserId,
            authorUid,
            paid,
            royalty,
            String(d.title || ''),
            JSON.stringify(
              sanitizeJsonValue({
                id: legacyId,
                title: d.title || '',
                category: d.category || '',
                cards: cardsArr
              })
            ),
            msToDateOrNull(pData.purchasedAt) || new Date()
          ]
        );
        stats.storePurchasesUpserted += 1;
      }
    }

    // Fallback: user.purchasedDecks snapshots (for deleted store decks)
    for (const { uid, items } of deferredPurchasedSnapshots) {
      const buyerId = uidToUuid.get(uid);
      if (!buyerId) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const deckKey = String(rec.deckId || rec.id || '').trim();
        if (!deckKey) continue;
        const authorUid = String(rec.authorUid || '').trim();
        const authorUserId = await resolveUserUuid(client, uidToUuid, authorUid);
        const paid = toFiniteInt(rec.priceCoins, 0, 0);
        const res = await client.query(
          `INSERT INTO store_deck_purchases (
             buyer_user_id, store_deck_id, deck_key, author_user_id, author_uid_snapshot,
             price_coins_paid, author_royalty_coins, deck_title_snapshot, deck_snapshot_json, purchased_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (buyer_user_id, deck_key) DO NOTHING`,
          [
            buyerId,
            storeUuidByLegacyId.get(deckKey) || null,
            deckKey,
            authorUserId,
            authorUid,
            paid,
            Math.floor(paid * 0.7),
            String(rec.title || rec.category || ''),
            JSON.stringify(sanitizeJsonValue(rec)),
            msToDateOrNull(rec.purchasedAt) || new Date()
          ]
        );
        if ((res.rowCount || 0) > 0) stats.storePurchasesUpserted += 1;
      }
    }

    // 5. IAP Transactions (strictly marked legacy_migrated)
    const upsertIapDoc = async (docId: string, d: Record<string, unknown>, isLegacyOrder: boolean) => {
      const uid = String(d.uid || '').trim();
      const userId = await resolveUserUuid(client, uidToUuid, uid);
      const rawPlatform = String(d.platform || (isLegacyOrder ? 'android' : 'legacy')).toLowerCase();
      const platform =
        rawPlatform === 'android' || rawPlatform === 'ios' || rawPlatform === 'web'
          ? rawPlatform
          : 'legacy';
      const txDocId = isLegacyOrder ? `legacy_order_${docId}` : String(d.txDocId || docId);
      const extTxId = String(d.transactionId || d.rawOrderId || d.orderId || docId);
      const extOrderId = String(d.orderId || d.rawOrderId || '').trim() || null;
      const kind =
        d.kind === 'coins' || d.kind === 'membership'
          ? d.kind
          : (toFiniteInt(d.coinsGranted, 0, 0) > 0 ? 'coins' : 'other');

      const res = await client.query(
        `INSERT INTO iap_transactions (
           user_id, firebase_uid_snapshot, platform, tx_doc_id, external_transaction_id,
           external_order_id, purchase_token_hash, package_or_bundle_id, product_id,
           kind, price_ntd, coins_granted, tier_granted, environment, verification_status,
           raw_payload, processed_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13, $14, 'legacy_migrated',
           $15::jsonb, $16
         )
         ON CONFLICT DO NOTHING`,
        [
          userId,
          uid,
          platform,
          txDocId,
          extTxId,
          extOrderId,
          String(d.purchaseTokenHash || '') || null,
          String(d.packageName || ''),
          String(d.productId || ''),
          kind,
          toFiniteInt(d.priceNtd, 0, 0),
          toFiniteInt(d.coinsGranted, 0, 0),
          String(d.tierGranted || ''),
          String(d.environment || 'Production'),
          JSON.stringify(sanitizeJsonValue(d) || {}),
          msToDateOrNull(d.processedAt) || new Date()
        ]
      );
      if ((res.rowCount || 0) > 0) stats.iapTxUpserted += 1;
    };

    for (const txDoc of processedTxSnap.docs) {
      await upsertIapDoc(txDoc.id, (txDoc.data() || {}) as Record<string, unknown>, false);
    }
    for (const ordDoc of processedOrdersSnap.docs) {
      await upsertIapDoc(ordDoc.id, (ordDoc.data() || {}) as Record<string, unknown>, true);
    }

    // 6. Moderation Reports, Ban Appeals & System Config
    for (const rDoc of reportsSnap.docs) {
      const r = (rDoc.data() || {}) as Record<string, unknown>;
      const reporterId = await resolveUserUuid(client, uidToUuid, String(r.reporterUid || ''));
      const targetId = await resolveUserUuid(client, uidToUuid, String(r.targetUid || ''));
      const reviewerId = await resolveUserUuid(client, uidToUuid, String(r.reviewedBy || ''));
      const status =
        r.status === 'resolved' || r.status === 'dismissed' ? r.status : 'pending';
      await client.query(
        `INSERT INTO moderation_reports (
           legacy_firestore_id, reporter_user_id, target_user_id, target_type, target_id,
           chat_id, message_id, reason, content_preview, status, reviewed_by, reviewed_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (legacy_firestore_id) DO UPDATE SET
           status = EXCLUDED.status,
           reviewed_by = EXCLUDED.reviewed_by,
           reviewed_at = EXCLUDED.reviewed_at`,
        [
          rDoc.id,
          reporterId,
          targetId,
          String(r.targetType || 'message'),
          String(r.targetId || ''),
          String(r.chatId || ''),
          String(r.messageId || ''),
          String(r.reason || ''),
          String(r.contentPreview || ''),
          status,
          reviewerId,
          msToDateOrNull(r.reviewedAt),
          msToDateOrNull(r.createdAt) || new Date()
        ]
      );
    }

    for (const aDoc of banAppealsSnap.docs) {
      const a = (aDoc.data() || {}) as Record<string, unknown>;
      const userId = await resolveUserUuid(client, uidToUuid, String(a.uid || ''));
      const resolvedBy = await resolveUserUuid(client, uidToUuid, String(a.resolvedBy || ''));
      const status =
        a.status === 'approved' || a.status === 'rejected' ? a.status : 'pending';
      await client.query(
        `INSERT INTO ban_appeals (
           legacy_firestore_id, user_id, email_snapshot, nickname_snapshot,
           ban_reason_snapshot, ban_expires_at, message, status,
           resolved_by, resolved_at, admin_note, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (legacy_firestore_id) DO UPDATE SET
           status = EXCLUDED.status,
           resolved_by = EXCLUDED.resolved_by,
           resolved_at = EXCLUDED.resolved_at,
           admin_note = EXCLUDED.admin_note`,
        [
          aDoc.id,
          userId,
          String(a.email || ''),
          String(a.nickname || ''),
          String(a.banReason || ''),
          msToDateOrNull(a.banExpiresAt),
          String(a.message || ''),
          status,
          resolvedBy,
          msToDateOrNull(a.resolvedAt),
          String(a.adminNote || ''),
          msToDateOrNull(a.createdAt) || new Date()
        ]
      );
    }

    for (const scDoc of systemConfigSnap.docs) {
      const scData = (scDoc.data() || {}) as Record<string, unknown>;
      const updatedBy = await resolveUserUuid(client, uidToUuid, String(scData.updatedBy || ''));
      await client.query(
        `INSERT INTO system_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           updated_by = COALESCE(EXCLUDED.updated_by, system_settings.updated_by),
           updated_at = now()`,
        [scDoc.id, JSON.stringify(sanitizeJsonValue(scData) || {}), updatedBy]
      );
      if (scDoc.id === 'season' && parseTimestampMs(scData.lastResetAt) > 0) {
        const seasonNum = toFiniteInt(scData.seasonNumber, 1, 1);
        await client.query(
          `INSERT INTO season_resets (season_number, reset_users_count, triggered_by_user_id, trigger_mode, reset_at)
           VALUES ($1, 0, $2, $3, $4)
           ON CONFLICT (season_number) DO NOTHING`,
          [
            seasonNum,
            updatedBy,
            String(scData.updatedBy || '') === 'auto_schedule' ? 'auto_schedule' : 'manual',
            msToDateOrNull(scData.lastResetAt) || new Date()
          ]
        );
      }
    }

    // 7. RTDB Migration (Announcements, Friend Requests/Removals, Chats + Classroom, Group Invites, Duels, Raids, Ghost Snapshots)
    const rtdbRootSnap = await fb.rtdb.ref('/').once('value');
    const rtdb = (rtdbRootSnap.val() || {}) as Record<string, Record<string, unknown>>;

    if (rtdb.announcements && typeof rtdb.announcements === 'object') {
      for (const [annId, rawAnn] of Object.entries(rtdb.announcements)) {
        if (!rawAnn || typeof rawAnn !== 'object') continue;
        const a = rawAnn as Record<string, unknown>;
        const authorId = await resolveUserUuid(client, uidToUuid, String(a.authorUid || a.uid || ''));
        await client.query(
          `INSERT INTO announcements (
             legacy_rtdb_id, author_user_id, author_name_snapshot, title, content, priority, payload, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (legacy_rtdb_id) DO UPDATE SET
             title = EXCLUDED.title,
             content = EXCLUDED.content`,
          [
            annId,
            authorId,
            String(a.author || a.authorName || '官方管理員'),
            String(a.title || ''),
            String(a.content || a.text || a.message || ''),
            String(a.priority || 'normal'),
            JSON.stringify(sanitizeJsonValue(a) || {}),
            msToDateOrNull(a.createdAt || a.timestamp) || new Date()
          ]
        );
      }
    }

    if (rtdb.friendRequests && typeof rtdb.friendRequests === 'object') {
      for (const [reqId, rawReq] of Object.entries(rtdb.friendRequests)) {
        if (!rawReq || typeof rawReq !== 'object') continue;
        const r = rawReq as Record<string, unknown>;
        const fromUid = String(r.fromUid || '').trim();
        const toUid = String(r.toUid || '').trim();
        if (!fromUid || !toUid || fromUid === toUid) continue;
        const fromId = await ensureStubUserForOrphanUid(client, uidToUuid, usedNicknames, fromUid);
        const toId = await ensureStubUserForOrphanUid(client, uidToUuid, usedNicknames, toUid);
        if (fromId === toId) continue;
        const status =
          r.status === 'accepted' || r.status === 'rejected' || r.status === 'cancelled'
            ? r.status
            : 'pending';
        await client.query(
          `INSERT INTO friend_requests (legacy_rtdb_id, from_user_id, to_user_id, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (legacy_rtdb_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
          [reqId, fromId, toId, status, msToDateOrNull(r.createdAt || r.timestamp) || new Date()]
        );
      }
    }

    const threadUuidByLegacyId = new Map<string, string>();
    if (rtdb.chats && typeof rtdb.chats === 'object') {
      for (const [chatId, rawChat] of Object.entries(rtdb.chats)) {
        if (!rawChat || typeof rawChat !== 'object') continue;
        const c = rawChat as Record<string, unknown>;
        const threadType =
          chatId === 'public_room' || c.type === 'public'
            ? 'public'
            : (c.isGroup || c.teacherMode || c.type === 'group' ? 'group' : 'direct');
        const ownerId = await resolveUserUuid(client, uidToUuid, String(c.ownerUid || ''));
        const cs = ((c.classroomSettings || {}) as Record<string, unknown>);

        const tRes = await client.query<{ id: string }>(
          `INSERT INTO chat_threads (
             legacy_rtdb_id, thread_type, name, owner_user_id, teacher_mode,
             classroom_mute_all, classroom_progress_visibility, muted_uids,
             last_message_preview, last_message_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, now())
           ON CONFLICT (legacy_rtdb_id) DO UPDATE SET
             name = EXCLUDED.name,
             teacher_mode = EXCLUDED.teacher_mode,
             classroom_mute_all = EXCLUDED.classroom_mute_all,
             classroom_progress_visibility = EXCLUDED.classroom_progress_visibility,
             muted_uids = EXCLUDED.muted_uids,
             last_message_preview = EXCLUDED.last_message_preview,
             last_message_at = COALESCE(EXCLUDED.last_message_at, chat_threads.last_message_at),
             updated_at = now()
           RETURNING id`,
          [
            chatId,
            threadType,
            String(c.name || ''),
            ownerId,
            Boolean(c.teacherMode),
            Boolean(cs.muteAll),
            String(cs.progressVisibility || 'teacher_only'),
            JSON.stringify(sanitizeJsonValue(cs.mutedUids || {}) || {}),
            String(c.lastMessage || ''),
            msToDateOrNull(c.lastTimestamp || c.updatedAt),
            msToDateOrNull(c.createdAt) || new Date()
          ]
        );
        const threadId = tRes.rows[0].id;
        threadUuidByLegacyId.set(chatId, threadId);
        stats.chatThreadsUpserted += 1;

        const readByMap = ((c.readBy || {}) as Record<string, unknown>);
        const mutedMap = ((cs.mutedUids || {}) as Record<string, unknown>);
        if (c.members && typeof c.members === 'object') {
          for (const [mUid, mVal] of Object.entries(c.members as Record<string, unknown>)) {
            if (mVal !== true) continue;
            const mId = await resolveUserUuid(client, uidToUuid, mUid);
            if (!mId) continue;
            const role = ownerId && mId === ownerId ? 'owner' : 'member';
            await client.query(
              `INSERT INTO chat_members (thread_id, user_id, role, last_read_at, is_muted)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (thread_id, user_id) DO UPDATE SET
                 last_read_at = COALESCE(EXCLUDED.last_read_at, chat_members.last_read_at),
                 is_muted = EXCLUDED.is_muted`,
              [threadId, mId, role, msToDateOrNull(readByMap[mUid]), Boolean(mutedMap[mUid])]
            );
          }
        }

        if (c.messages && typeof c.messages === 'object') {
          for (const [msgId, rawMsg] of Object.entries(c.messages as Record<string, unknown>)) {
            if (!rawMsg || typeof rawMsg !== 'object') continue;
            const m = rawMsg as Record<string, unknown>;
            const senderId = await resolveUserUuid(
              client,
              uidToUuid,
              String(m.uid || m.senderUid || '')
            );
            const insMsg = await client.query(
              `INSERT INTO chat_messages (
                 legacy_rtdb_id, thread_id, sender_user_id,
                 sender_name_snapshot, sender_avatar_snapshot, sender_frame_snapshot,
                 msg_type, content, payload, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
               ON CONFLICT (thread_id, legacy_rtdb_id) WHERE legacy_rtdb_id IS NOT NULL DO NOTHING`,
              [
                msgId,
                threadId,
                senderId,
                String(m.sender || m.nickname || ''),
                String(m.avatar || ''),
                String(m.frame || 'default'),
                String(m.type || 'text'),
                String(m.text || m.content || ''),
                JSON.stringify(sanitizeJsonValue(m) || {}),
                msToDateOrNull(m.timestamp || m.createdAt) || new Date()
              ]
            );
            if ((insMsg.rowCount || 0) > 0) stats.chatMessagesUpserted += 1;
          }
        }

        if (c.dailyTasks && typeof c.dailyTasks === 'object') {
          for (const [taskId, rawTask] of Object.entries(c.dailyTasks as Record<string, unknown>)) {
            if (!rawTask || typeof rawTask !== 'object') continue;
            const tObj = rawTask as Record<string, unknown>;
            const creatorId = await resolveUserUuid(client, uidToUuid, String(tObj.createdBy || ''));
            await client.query(
              `INSERT INTO classroom_daily_tasks (thread_id, legacy_task_id, created_by_user_id, payload, created_at)
               VALUES ($1, $2, $3, $4::jsonb, $5)
               ON CONFLICT (thread_id, legacy_task_id) DO UPDATE SET payload = EXCLUDED.payload`,
              [
                threadId,
                taskId,
                creatorId,
                JSON.stringify(sanitizeJsonValue(tObj) || {}),
                msToDateOrNull(tObj.createdAt) || new Date()
              ]
            );
          }
        }

        if (c.challenges && typeof c.challenges === 'object') {
          for (const [chId, rawCh] of Object.entries(c.challenges as Record<string, unknown>)) {
            if (!rawCh || typeof rawCh !== 'object') continue;
            const ch = rawCh as Record<string, unknown>;
            const creatorId = await resolveUserUuid(client, uidToUuid, String(ch.createdBy || ''));
            const chRes = await client.query<{ id: string }>(
              `INSERT INTO classroom_challenges (
                 thread_id, legacy_challenge_id, created_by_user_id, status, current_question_index, payload, created_at, updated_at
               ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
               ON CONFLICT (thread_id, legacy_challenge_id) DO UPDATE SET
                 status = EXCLUDED.status,
                 current_question_index = EXCLUDED.current_question_index,
                 payload = EXCLUDED.payload,
                 updated_at = now()
               RETURNING id`,
              [
                threadId,
                chId,
                creatorId,
                String(ch.status || 'active'),
                toFiniteInt(ch.currentQuestionIndex, 0, 0),
                JSON.stringify(sanitizeJsonValue(ch) || {}),
                msToDateOrNull(ch.createdAt) || new Date()
              ]
            );
            const challengeUuid = chRes.rows[0].id;
            if (ch.responses && typeof ch.responses === 'object') {
              for (const [rUid, rVal] of Object.entries(ch.responses as Record<string, unknown>)) {
                const rUserId = await resolveUserUuid(client, uidToUuid, rUid);
                if (!rUserId || !rVal || typeof rVal !== 'object') continue;
                const rObj = rVal as Record<string, unknown>;
                await client.query(
                  `INSERT INTO classroom_challenge_responses (challenge_id, user_id, score, answers_payload, updated_at)
                   VALUES ($1, $2, $3, $4::jsonb, now())
                   ON CONFLICT (challenge_id, user_id) DO UPDATE SET
                     score = EXCLUDED.score,
                     answers_payload = EXCLUDED.answers_payload,
                     updated_at = now()`,
                  [
                    challengeUuid,
                    rUserId,
                    toFiniteInt(rObj.score, 0, 0),
                    JSON.stringify(sanitizeJsonValue(rObj) || {})
                  ]
                );
              }
            }
          }
        }

        if (c.studentSnapshots && typeof c.studentSnapshots === 'object') {
          for (const [sUid, sVal] of Object.entries(c.studentSnapshots as Record<string, unknown>)) {
            const sUserId = await resolveUserUuid(client, uidToUuid, sUid);
            if (!sUserId || !sVal || typeof sVal !== 'object') continue;
            await client.query(
              `INSERT INTO classroom_student_snapshots (thread_id, user_id, payload, updated_at)
               VALUES ($1, $2, $3::jsonb, now())
               ON CONFLICT (thread_id, user_id) DO UPDATE SET
                 payload = EXCLUDED.payload,
                 updated_at = now()`,
              [threadId, sUserId, JSON.stringify(sanitizeJsonValue(sVal) || {})]
            );
          }
        }
      }
    }

    // Group Invites
    if (rtdb.groupInvites && typeof rtdb.groupInvites === 'object') {
      for (const [invId, rawInv] of Object.entries(rtdb.groupInvites)) {
        if (!rawInv || typeof rawInv !== 'object') continue;
        const inv = rawInv as Record<string, unknown>;
        const threadId = threadUuidByLegacyId.get(String(inv.targetId || inv.chatId || ''));
        const fromId = await resolveUserUuid(client, uidToUuid, String(inv.fromUid || ''));
        const toId = await resolveUserUuid(client, uidToUuid, String(inv.toUid || ''));
        if (!threadId || !fromId || !toId) continue;
        const status =
          inv.status === 'accepted' || inv.status === 'rejected' || inv.status === 'expired'
            ? inv.status
            : 'pending';
        await client.query(
          `INSERT INTO group_invites (legacy_rtdb_id, thread_id, from_user_id, to_user_id, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (legacy_rtdb_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
          [invId, threadId, fromId, toId, status, msToDateOrNull(inv.createdAt) || new Date()]
        );
      }
    }

    // Ghost Snapshots
    if (rtdb.ghostSnapshots && typeof rtdb.ghostSnapshots === 'object') {
      for (const [gUid, rawGhost] of Object.entries(rtdb.ghostSnapshots)) {
        if (!rawGhost || typeof rawGhost !== 'object') continue;
        const g = rawGhost as Record<string, unknown>;
        const userId = await resolveUserUuid(client, uidToUuid, gUid);
        if (!userId) continue;
        await client.query(
          `INSERT INTO ghost_snapshots (
             user_id, display_name, avatar_url, rank_tier, membership_tier, membership_expires_at,
             total_score, duration_ms, timeline_json, questions_json, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             rank_tier = EXCLUDED.rank_tier,
             membership_tier = EXCLUDED.membership_tier,
             membership_expires_at = EXCLUDED.membership_expires_at,
             total_score = EXCLUDED.total_score,
             duration_ms = EXCLUDED.duration_ms,
             timeline_json = EXCLUDED.timeline_json,
             questions_json = EXCLUDED.questions_json,
             updated_at = now()`,
          [
            userId,
            String(g.name || g.displayName || ''),
            String(g.avatar || ''),
            String(g.rankTier || '青銅 III'),
            String(g.membershipTier || 'free'),
            parseTimestampMs(g.membershipExpiresAt),
            toFiniteInt(g.totalScore, 0, 0),
            toFiniteInt(g.durationMs, 0, 0),
            JSON.stringify(sanitizeJsonValue(g.timeline || []) || []),
            JSON.stringify(sanitizeJsonValue(g.questions || []) || [])
          ]
        );
      }
    }

    // Duels
    if (rtdb.duels && typeof rtdb.duels === 'object') {
      for (const [roomCode, rawDuel] of Object.entries(rtdb.duels)) {
        if (!rawDuel || typeof rawDuel !== 'object') continue;
        const d = rawDuel as Record<string, unknown>;
        const hostId = await resolveUserUuid(client, uidToUuid, String(d.hostUid || ''));
        const guestId = await resolveUserUuid(client, uidToUuid, String(d.guestUid || ''));
        const isDraw = d.winnerUid === 'DRAW';
        const winnerId = isDraw
          ? null
          : await resolveUserUuid(client, uidToUuid, String(d.winnerUid || ''));
        const forfeitedBy = await resolveUserUuid(client, uidToUuid, String(d.forfeitedBy || ''));
        const status =
          d.status === 'waiting' || d.status === 'playing' || d.status === 'finished'
            ? d.status
            : 'abandoned';
        await client.query(
          `INSERT INTO duel_rooms (
             room_code, status, host_user_id, guest_user_id, winner_user_id, is_draw,
             forfeited_by_user_id, host_score, guest_score, tug_position, questions_json,
             created_at, finished_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
           ON CONFLICT (room_code) DO UPDATE SET
             status = EXCLUDED.status,
             winner_user_id = EXCLUDED.winner_user_id,
             is_draw = EXCLUDED.is_draw,
             host_score = EXCLUDED.host_score,
             guest_score = EXCLUDED.guest_score,
             tug_position = EXCLUDED.tug_position,
             finished_at = EXCLUDED.finished_at`,
          [
            roomCode,
            status,
            hostId,
            guestId,
            winnerId,
            isDraw,
            forfeitedBy,
            toFiniteInt(d.hostScore, 0, 0),
            toFiniteInt(d.guestScore, 0, 0),
            toFiniteInt(d.tugPosition, 50, 0, 100),
            JSON.stringify(sanitizeJsonValue(d.questions || []) || []),
            msToDateOrNull(d.createdAt) || new Date(),
            msToDateOrNull(d.finishedAt)
          ]
        );
        stats.duelsUpserted += 1;
      }
    }

    // Raids
    if (rtdb.raids && typeof rtdb.raids === 'object') {
      for (const [raidCode, rawRaid] of Object.entries(rtdb.raids)) {
        if (!rawRaid || typeof rawRaid !== 'object') continue;
        const r = rawRaid as Record<string, unknown>;
        const hostId = await resolveUserUuid(client, uidToUuid, String(r.hostUid || ''));
        const status =
          r.status === 'waiting' ||
          r.status === 'playing' ||
          r.status === 'cleared' ||
          r.status === 'failed'
            ? r.status
            : 'abandoned';
        const rRes = await client.query<{ id: string }>(
          `INSERT INTO raid_rooms (
             raid_code, status, host_user_id, boss_name, boss_hp, boss_max_hp, questions_json, cleared_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           ON CONFLICT (raid_code) DO UPDATE SET
             status = EXCLUDED.status,
             boss_hp = EXCLUDED.boss_hp,
             cleared_at = EXCLUDED.cleared_at
           RETURNING id`,
          [
            raidCode,
            status,
            hostId,
            String(r.bossName || ''),
            toFiniteInt(r.bossHp, 0, 0),
            toFiniteInt(r.bossMaxHp, 0, 0),
            JSON.stringify(sanitizeJsonValue(r.questions || []) || []),
            msToDateOrNull(r.clearedAt),
            msToDateOrNull(r.createdAt) || new Date()
          ]
        );
        const raidId = rRes.rows[0].id;
        stats.raidsUpserted += 1;

        if (r.members && typeof r.members === 'object') {
          for (const [mUid, mVal] of Object.entries(r.members as Record<string, unknown>)) {
            const memberId = await resolveUserUuid(client, uidToUuid, mUid);
            if (!memberId || !mVal || typeof mVal !== 'object') continue;
            const mObj = mVal as Record<string, unknown>;
            await client.query(
              `INSERT INTO raid_participants (raid_id, user_id, damage, hits, reward_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (raid_id, user_id) DO UPDATE SET
                 damage = GREATEST(raid_participants.damage, EXCLUDED.damage),
                 hits = GREATEST(raid_participants.hits, EXCLUDED.hits)`,
              [
                raidId,
                memberId,
                toFiniteInt(mObj.damage, 0, 0),
                toFiniteInt(mObj.hits, 0, 0),
                status === 'cleared'
              ]
            );
          }
        }
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('[ETL DRY-RUN] Rolled back cleanly. Summary:', JSON.stringify(stats, null, 2));
      return;
    }

    if (etlRunId) {
      await client.query(
        `UPDATE etl_runs
         SET status = 'completed',
             source_watermarks = $2::jsonb,
             reconciliation_report = $3::jsonb,
             finished_at = now()
         WHERE id = $1`,
        [etlRunId, JSON.stringify({ maxUserUpdatedMs }), JSON.stringify(stats)]
      );
    }

    await client.query('COMMIT');
    console.log('[ETL] Completed successfully. Summary:', JSON.stringify(stats, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!dryRun && etlRunId) {
      await pool
        .query(`UPDATE etl_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [etlRunId])
        .catch(() => {});
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
    try {
      fb.rtdb.goOffline();
    } catch {
      // ignore if already offline
    }
    await fb.app.delete().catch(() => {});
  }
}

runEtl().catch((err) => {
  console.error('[ETL] Failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

