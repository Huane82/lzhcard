import { createPgPool } from '../db/pool.js';
import { initFirebaseAdmin, listAllAuthUsers, extractUserRawCards } from './firebaseSource.js';
import { dedupeNormalizedCards, toFiniteInt } from './normalizers.js';

interface SampleMismatch {
  firebaseUid: string;
  field: string;
  firebaseValue: unknown;
  pgValue: unknown;
}

async function runReconcile(): Promise<void> {
  const fb = await initFirebaseAdmin();
  const pool = createPgPool();

  try {
    const [
      authUsers,
      fsUsersSnap,
      adminsSnap,
      storeDecksSnap,
      processedTxSnap,
      processedOrdersSnap
    ] = await Promise.all([
      listAllAuthUsers(fb.auth),
      fb.firestore.collection('users').get(),
      fb.firestore.collection('admins').get(),
      fb.firestore.collection('storeDecks').get(),
      fb.firestore.collection('processedTransactions').get(),
      fb.firestore.collection('processedOrders').get()
    ]);

    const pgCountsRes = await pool.query<{
      users_cnt: string;
      admins_cnt: string;
      store_decks_cnt: string;
      iap_cnt: string;
      coins_sum: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM users)::text AS users_cnt,
        (SELECT COUNT(*) FROM users WHERE role = 'admin')::text AS admins_cnt,
        (SELECT COUNT(*) FROM store_decks WHERE is_deleted = FALSE)::text AS store_decks_cnt,
        (SELECT COUNT(*) FROM iap_transactions)::text AS iap_cnt,
        (SELECT COALESCE(SUM(coins_balance), 0) FROM users)::text AS coins_sum
    `);
    const pgCounts = pgCountsRes.rows[0];

    // 1. Coin ledger invariant check: SUM(coin_ledger.delta) == users.coins_balance for every user
    const coinDriftRes = await pool.query<{ id: string; firebase_uid: string | null }>(
      `SELECT u.id, u.firebase_uid
       FROM users u
       LEFT JOIN (
         SELECT user_id, COALESCE(SUM(delta), 0) AS ledger_sum
         FROM coin_ledger
         GROUP BY user_id
       ) l ON l.user_id = u.id
       WHERE u.coins_balance <> COALESCE(l.ledger_sum, 0)`
    );

    // 2. Orphan checks on decks / cards / purchases
    const orphanRes = await pool.query<{ orphan_cards: string; orphan_purchases: string }>(`
      SELECT
        (SELECT COUNT(*) FROM word_cards wc LEFT JOIN decks d ON d.id = wc.deck_id WHERE d.id IS NULL)::text AS orphan_cards,
        (SELECT COUNT(*) FROM store_deck_purchases sdp LEFT JOIN users u ON u.id = sdp.buyer_user_id WHERE u.id IS NULL)::text AS orphan_purchases
    `);

    // 3. Expected Firebase aggregate coins & decks across users
    let fbTotalCoins = 0;
    let fbTotalCards = 0;
    const fsUserMap = new Map(fsUsersSnap.docs.map((d) => [d.id, d]));

    const allSourceUids = Array.from(
      new Set([...authUsers.map((u) => u.uid), ...fsUsersSnap.docs.map((d) => d.id)])
    );

    // Stratified sample up to 20 users: admins first, coin holders, richest decks, remaining users
    const scoredSamplePool: Array<{ uid: string; priority: number }> = [];
    const adminIds = new Set(adminsSnap.docs.map((d) => d.id));

    for (const doc of fsUsersSnap.docs) {
      const d = doc.data() || {};
      const coins = toFiniteInt(d.coins, 0, 0);
      fbTotalCoins += coins;
      const rawCards = await extractUserRawCards(doc.ref, d);
      const deduped = dedupeNormalizedCards(rawCards);
      fbTotalCards += deduped.length;

      let priority = deduped.length;
      if (adminIds.has(doc.id) || d.isAdmin === true || d.role === 'admin') priority += 100_000;
      if (coins > 0) priority += 10_000;
      if (d.membership && typeof d.membership === 'object' && d.membership.tier !== 'free') {
        priority += 5_000;
      }
      scoredSamplePool.push({ uid: doc.id, priority });
    }

    scoredSamplePool.sort((a, b) => b.priority - a.priority);
    const sampleUids = scoredSamplePool.slice(0, 20).map((s) => s.uid);

    const sampleMismatches: SampleMismatch[] = [];
    for (const sUid of sampleUids) {
      const fsDoc = fsUserMap.get(sUid);
      if (!fsDoc) continue;
      const fsData = fsDoc.data() || {};
      const rawCards = await extractUserRawCards(fsDoc.ref, fsData);
      const expectedCards = dedupeNormalizedCards(rawCards);
      const expectedCoins = toFiniteInt(fsData.coins, 0, 0);
      const expectedRankPoints = toFiniteInt(
        (fsData.progression as Record<string, unknown> | undefined)?.rankPoints,
        0,
        0
      );

      const pgRow = await pool.query<{
        coins_balance: number;
        rank_points: number;
        card_count: string;
      }>(
        `SELECT u.coins_balance,
                COALESCE(up.rank_points, 0) AS rank_points,
                (SELECT COUNT(*) FROM word_cards wc WHERE wc.user_id = u.id)::text AS card_count
         FROM users u
         LEFT JOIN user_progression up ON up.user_id = u.id
         WHERE u.firebase_uid = $1`,
        [sUid]
      );

      if (pgRow.rowCount === 0) {
        sampleMismatches.push({
          firebaseUid: sUid,
          field: 'user_exists',
          firebaseValue: true,
          pgValue: false
        });
        continue;
      }

      const row = pgRow.rows[0];
      if (row.coins_balance !== expectedCoins) {
        sampleMismatches.push({
          firebaseUid: sUid,
          field: 'coins_balance',
          firebaseValue: expectedCoins,
          pgValue: row.coins_balance
        });
      }
      if (Number(row.card_count) !== expectedCards.length) {
        sampleMismatches.push({
          firebaseUid: sUid,
          field: 'word_cards_count',
          firebaseValue: expectedCards.length,
          pgValue: Number(row.card_count)
        });
      }
      if (row.rank_points !== expectedRankPoints) {
        sampleMismatches.push({
          firebaseUid: sUid,
          field: 'rank_points',
          firebaseValue: expectedRankPoints,
          pgValue: row.rank_points
        });
      }
    }

    const pgCardsRes = await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM word_cards');
    const pgCardsTotal = Number(pgCardsRes.rows[0]?.cnt || 0);
    const expectedIapTotal = processedTxSnap.size + processedOrdersSnap.size;

    const report = {
      source: {
        totalUniqueUsers: allSourceUids.length,
        authUsers: authUsers.length,
        firestoreUsers: fsUsersSnap.size,
        storeDecks: storeDecksSnap.size,
        iapTransactions: expectedIapTotal,
        totalCards: fbTotalCards,
        totalCoins: fbTotalCoins
      },
      postgresql: {
        users: Number(pgCounts.users_cnt),
        admins: Number(pgCounts.admins_cnt),
        storeDecks: Number(pgCounts.store_decks_cnt),
        iapTransactions: Number(pgCounts.iap_cnt),
        totalCards: pgCardsTotal,
        totalCoins: Number(pgCounts.coins_sum)
      },
      invariants: {
        coinLedgerDriftUsers: coinDriftRes.rowCount || 0,
        orphanCards: Number(orphanRes.rows[0]?.orphan_cards || 0),
        orphanPurchases: Number(orphanRes.rows[0]?.orphan_purchases || 0),
        sampledUsersChecked: sampleUids.length,
        sampleMismatches
      }
    };

    console.log(JSON.stringify(report, null, 2));

    const hasError =
      report.postgresql.users < report.source.totalUniqueUsers ||
      report.postgresql.totalCoins !== report.source.totalCoins ||
      report.postgresql.totalCards !== report.source.totalCards ||
      report.postgresql.storeDecks !== report.source.storeDecks ||
      report.postgresql.iapTransactions < report.source.iapTransactions ||
      report.invariants.coinLedgerDriftUsers > 0 ||
      report.invariants.orphanCards > 0 ||
      report.invariants.orphanPurchases > 0 ||
      report.invariants.sampleMismatches.length > 0;

    if (hasError) {
      console.error('[RECONCILE] Verification failed with discrepancies.');
      process.exitCode = 1;
    } else {
      console.log('[RECONCILE] PASSED 100%: zero drift, zero orphans, all samples matched.');
    }
  } finally {
    await pool.end();
    try {
      fb.rtdb.goOffline();
    } catch {
      // ignore if already offline
    }
    await fb.app.delete().catch(() => {});
  }
}

runReconcile().catch((err) => {
  console.error('[RECONCILE] Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

