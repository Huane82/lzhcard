import {
  TIER_CONFIGS,
  extractBearerToken,
  isUserAdminFromFields,
  parseUserBanState,
  verifyFirebaseToken
} from "./quotaManager.js";
import {
  checkAdminsDocExists,
  decodeFirestoreDoc,
  firestoreGetDoc,
  firestoreListCollection,
  firestorePatchDoc,
  getFirestoreAuthHeader
} from "./firestoreAdmin.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN_ALLOWED_ORIGINS = new Set([
  "https://flashcards-5f514.web.app",
  "https://flashcards-5f514.firebaseapp.com",
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://lzhcard.tomlin980415.workers.dev"
]);

function isAllowedAdminOrigin(origin) {
  if (!origin) return false;
  if (ADMIN_ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/i.test(origin)) return true;
  return false;
}

export function buildAdminCorsHeaders(request) {
  const origin = String(request.headers.get("Origin") || "").trim();
  const allowedOrigin = isAllowedAdminOrigin(origin)
    ? origin
    : "https://flashcards-5f514.web.app";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Platform",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonOut(payload, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function docIdFromName(name) {
  const parts = String(name || "").split("/");
  return parts[parts.length - 1] || "";
}

async function authenticateAdmin(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return { ok: false, response: jsonOut({ ok: false, error: "缺少管理員登入憑證" }, 401, corsHeaders) };
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return { ok: false, response: jsonOut({ ok: false, error: "登入憑證無效或已過期" }, 401, corsHeaders) };
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  if (!fsAuth.isAdminToken || !fsAuth.Authorization) {
    return {
      ok: false,
      response: jsonOut(
        { ok: false, code: "SERVER_ADMIN_NOT_CONFIGURED", error: "伺服器未設定 FIREBASE_SERVICE_ACCOUNT" },
        503,
        corsHeaders
      )
    };
  }

  const [inAdmins, userRes] = await Promise.all([
    checkAdminsDocExists(verified.uid, fsAuth.Authorization),
    firestoreGetDoc(`users/${encodeURIComponent(verified.uid)}`, fsAuth.Authorization)
  ]);

  const isFieldAdmin = Boolean(userRes.exists && isUserAdminFromFields((userRes.doc && userRes.doc.fields) || {}));
  if (!inAdmins && !isFieldAdmin) {
    return {
      ok: false,
      response: jsonOut({ ok: false, code: "FORBIDDEN", error: "僅限管理員帳號存取此功能" }, 403, corsHeaders)
    };
  }

  return { ok: true, uid: verified.uid, email: verified.email || "", fsAuth };
}

function sanitizeProgressionForRead(prog) {
  const p = prog && typeof prog === "object" ? prog : {};
  return {
    xp: Math.max(0, Math.floor(Number(p.xp) || 0)),
    level: Math.max(1, Math.floor(Number(p.level) || 1)),
    streakDays: Math.max(0, Math.floor(Number(p.streakDays) || 0)),
    streakShields: Math.max(0, Math.floor(Number(p.streakShields) || 0)),
    lastActiveDate: String(p.lastActiveDate || ""),
    rankTier: String(p.rankTier || "青銅 III"),
    rankPoints: Math.max(0, Math.floor(Number(p.rankPoints) || 0)),
    duelWins: Math.max(0, Math.floor(Number(p.duelWins) || 0)),
    duelTotal: Math.max(0, Math.floor(Number(p.duelTotal) || 0))
  };
}

function parseTimestampMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return asNum;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function formatPlayerSummary(doc, nowMs = Date.now(), pubFallback = null) {
  const uid = docIdFromName(doc.name);
  const data = decodeFirestoreDoc(doc);
  const pubData = pubFallback || {};
  const ban = parseUserBanState(doc, nowMs);
  const progression = sanitizeProgressionForRead(
    data.progression && typeof data.progression === "object"
      ? data.progression
      : (pubData.stats || {})
  );
  const membership = data.membership && typeof data.membership === "object"
    ? {
        tier: String(data.membership.tier || "free"),
        expiresAt: Number(data.membership.expiresAt) || 0,
        startedAt: Number(data.membership.startedAt) || 0,
        source: String(data.membership.source || "")
      }
    : { tier: "free", expiresAt: 0, startedAt: 0, source: "" };

  const cosSource = (data.cosmetics && typeof data.cosmetics === "object")
    ? data.cosmetics
    : (pubData.cosmetics && typeof pubData.cosmetics === "object" ? pubData.cosmetics : null);

  const cosmetics = cosSource
    ? {
        frame: String(cosSource.frame || "default"),
        banner: String(cosSource.banner || "default"),
        title: String(cosSource.title || "newcomer"),
        unlockedFrames: Array.isArray(cosSource.unlockedFrames) ? cosSource.unlockedFrames : [],
        unlockedBanners: Array.isArray(cosSource.unlockedBanners) ? cosSource.unlockedBanners : [],
        unlockedTitles: Array.isArray(cosSource.unlockedTitles) ? cosSource.unlockedTitles : []
      }
    : {
        frame: "default",
        banner: "default",
        title: "newcomer",
        unlockedFrames: [],
        unlockedBanners: [],
        unlockedTitles: []
      };

  const nickname = String(data.nickname || data.displayName || pubData.nickname || "學習者");
  const lastActiveAt = Math.max(
    parseTimestampMs(data.lastSyncedAt),
    parseTimestampMs(data.updatedAt),
    parseTimestampMs(pubData.updatedAt)
  );

  return {
    uid,
    email: String(data.email || ""),
    nickname,
    nicknameLower: String(data.nicknameLower || nickname).trim().toLowerCase(),
    coins: Math.max(0, Math.floor(Number(data.coins) || 0)),
    role: String(data.role || "user"),
    isAdmin: Boolean(data.isAdmin || String(data.role || "").toLowerCase() === "admin"),
    membership,
    aiUsage: data.aiUsage && typeof data.aiUsage === "object" ? data.aiUsage : null,
    coinBoost: data.coinBoost && typeof data.coinBoost === "object" ? data.coinBoost : null,
    progression,
    cosmetics,
    purchasedCosmetics: Array.isArray(data.purchasedCosmetics) ? data.purchasedCosmetics : [],
    ban,
    lastActiveAt
  };
}

export async function handleAdminListPlayers(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const sortBy = String(url.searchParams.get("sort") || "rankPoints").trim();
  const nowMs = Date.now();

  const [userDocs, publicDocs] = await Promise.all([
    firestoreListCollection("users", auth.fsAuth.Authorization, {
      pageSize: 200,
      maxPages: 15
    }),
    firestoreListCollection("publicProfiles", auth.fsAuth.Authorization, {
      pageSize: 200,
      maxPages: 15
    }).catch(() => [])
  ]);

  const pubByUid = new Map();
  for (const pd of publicDocs) {
    const pid = docIdFromName(pd.name);
    if (pid) pubByUid.set(pid, decodeFirestoreDoc(pd));
  }

  const playersByUid = new Map();
  for (const d of userDocs) {
    const uid = docIdFromName(d.name);
    if (!uid) continue;
    playersByUid.set(uid, formatPlayerSummary(d, nowMs, pubByUid.get(uid)));
  }

  // 若有舊帳號僅存在於 publicProfiles 而尚未寫入 users，也一併列出
  for (const pd of publicDocs) {
    const pid = docIdFromName(pd.name);
    if (!pid || playersByUid.has(pid)) continue;
    playersByUid.set(pid, formatPlayerSummary({ name: pd.name, fields: {} }, nowMs, pubByUid.get(pid)));
  }

  let players = Array.from(playersByUid.values());

  if (q) {
    players = players.filter((p) => {
      return (
        p.uid.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.nickname.toLowerCase().includes(q) ||
        p.nicknameLower.includes(q)
      );
    });
  }

  players.sort((a, b) => {
    if (sortBy === "level") {
      return (b.progression.level - a.progression.level) || (b.progression.xp - a.progression.xp);
    }
    if (sortBy === "coins") {
      return b.coins - a.coins;
    }
    if (sortBy === "banned") {
      return Number(b.ban.isBanned) - Number(a.ban.isBanned);
    }
    if (sortBy === "lastActive") {
      return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
    }
    // default rankPoints
    return (b.progression.rankPoints - a.progression.rankPoints) || (b.progression.level - a.progression.level);
  });

  return jsonOut({ ok: true, total: players.length, players }, 200, corsHeaders);
}

export async function handleAdminUpdatePlayer(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonOut({ ok: false, error: "無效的 JSON 請求" }, 400, corsHeaders);
  }

  const targetUid = String((body && body.targetUid) || "").trim();
  if (!targetUid) {
    return jsonOut({ ok: false, error: "缺少 targetUid" }, 400, corsHeaders);
  }

  const userPath = `users/${encodeURIComponent(targetUid)}`;
  const userRes = await firestoreGetDoc(userPath, auth.fsAuth.Authorization);
  let userData = userRes.exists ? decodeFirestoreDoc(userRes.doc) : null;
  if (!userRes.exists) {
    const pubFallbackRes = await firestoreGetDoc(`publicProfiles/${encodeURIComponent(targetUid)}`, auth.fsAuth.Authorization);
    if (!pubFallbackRes.exists) {
      return jsonOut({ ok: false, error: "找不到該玩家資料" }, 404, corsHeaders);
    }
    const pubData = decodeFirestoreDoc(pubFallbackRes.doc);
    userData = {
      nickname: pubData.nickname || "學習者",
      progression: pubData.stats || {},
      cosmetics: pubData.cosmetics || {}
    };
  }
  const nowMs = Date.now();
  const patchPayload = {};
  const maskPaths = [];

  if (body.coins !== undefined && body.coins !== null && Number.isFinite(Number(body.coins))) {
    patchPayload.coins = Math.max(0, Math.floor(Number(body.coins)));
    maskPaths.push("coins");
  }

  if (body.membership && typeof body.membership === "object") {
    const reqTier = String(body.membership.tier || "free").trim();
    const validTier = TIER_CONFIGS[reqTier] ? reqTier : "free";
    const days = Math.max(0, Math.floor(Number(body.membership.days) || 0));
    const prevMem = userData.membership && typeof userData.membership === "object" ? userData.membership : {};
    if (validTier === "free" || days === 0) {
      patchPayload.membership = {
        tier: "free",
        tierPriceNtd: 0,
        billingCycle: "monthly",
        startedAt: 0,
        expiresAt: 0,
        totalDonatedNtd: Number(prevMem.totalDonatedNtd) || 0,
        autoDowngradedAt: 0,
        source: "admin_grant"
      };
    } else {
      patchPayload.membership = {
        tier: validTier,
        tierPriceNtd: Number(prevMem.tierPriceNtd) || 0,
        billingCycle: "monthly",
        startedAt: nowMs,
        expiresAt: nowMs + days * DAY_MS,
        totalDonatedNtd: Number(prevMem.totalDonatedNtd) || 0,
        autoDowngradedAt: 0,
        source: "admin_grant"
      };
    }
    maskPaths.push("membership");
  }

  if (body.resetQuota === true) {
    patchPayload.aiUsage = {
      dailyDate: "",
      monthlyKey: "",
      daily: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
      monthly: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
      updatedAt: nowMs
    };
    maskPaths.push("aiUsage");
  }

  let nextProgression = null;
  if (body.progression && typeof body.progression === "object") {
    const prev = sanitizeProgressionForRead(userData.progression);
    nextProgression = {
      ...prev,
      level: body.progression.level !== undefined
        ? Math.max(1, Math.floor(Number(body.progression.level) || 1))
        : prev.level,
      xp: body.progression.xp !== undefined
        ? Math.max(0, Math.floor(Number(body.progression.xp) || 0))
        : prev.xp,
      rankPoints: body.progression.rankPoints !== undefined
        ? Math.max(0, Math.floor(Number(body.progression.rankPoints) || 0))
        : prev.rankPoints,
      rankTier: body.progression.rankTier !== undefined && String(body.progression.rankTier).trim()
        ? String(body.progression.rankTier).trim()
        : prev.rankTier
    };
    patchPayload.progression = nextProgression;
    maskPaths.push("progression");
  }

  if (body.cosmetics && typeof body.cosmetics === "object") {
    const prevCos = userData.cosmetics && typeof userData.cosmetics === "object"
      ? { ...userData.cosmetics }
      : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
    if (Array.isArray(body.cosmetics.unlockedFrames)) {
      prevCos.unlockedFrames = Array.from(new Set(body.cosmetics.unlockedFrames.map((x) => String(x || "").trim()).filter(Boolean)));
    }
    if (Array.isArray(body.cosmetics.unlockedBanners)) {
      prevCos.unlockedBanners = Array.from(new Set(body.cosmetics.unlockedBanners.map((x) => String(x || "").trim()).filter(Boolean)));
    }
    if (Array.isArray(body.cosmetics.unlockedTitles)) {
      prevCos.unlockedTitles = Array.from(new Set(body.cosmetics.unlockedTitles.map((x) => String(x || "").trim()).filter(Boolean)));
    }
    patchPayload.cosmetics = prevCos;
    maskPaths.push("cosmetics");
  }

  if (Array.isArray(body.purchasedCosmetics)) {
    patchPayload.purchasedCosmetics = Array.from(
      new Set(body.purchasedCosmetics.map((x) => String(x || "").trim()).filter(Boolean))
    );
    maskPaths.push("purchasedCosmetics");
  }

  if (maskPaths.length === 0) {
    return jsonOut({ ok: false, error: "沒有可更新的欄位" }, 400, corsHeaders);
  }

  const updatedDoc = await firestorePatchDoc(userPath, patchPayload, maskPaths, auth.fsAuth.Authorization);

  // 同步 publicProfiles 排行相關數據
  if (nextProgression || patchPayload.cosmetics) {
    try {
      const pubRes = await firestoreGetDoc(`publicProfiles/${encodeURIComponent(targetUid)}`, auth.fsAuth.Authorization);
      if (pubRes.exists) {
        const pubData = decodeFirestoreDoc(pubRes.doc);
        const pubPatch = {};
        const pubMask = [];
        if (nextProgression) {
          const prevStats = pubData.stats && typeof pubData.stats === "object" ? { ...pubData.stats } : {};
          prevStats.level = nextProgression.level;
          prevStats.rankPoints = nextProgression.rankPoints;
          prevStats.rankTier = nextProgression.rankTier;
          pubPatch.stats = prevStats;
          pubMask.push("stats");
        }
        if (patchPayload.cosmetics) {
          pubPatch.cosmetics = {
            frame: patchPayload.cosmetics.frame || "default",
            banner: patchPayload.cosmetics.banner || "default",
            title: patchPayload.cosmetics.title || "newcomer"
          };
          pubMask.push("cosmetics");
        }
        if (pubMask.length > 0) {
          await firestorePatchDoc(`publicProfiles/${encodeURIComponent(targetUid)}`, pubPatch, pubMask, auth.fsAuth.Authorization);
        }
      }
    } catch (e) {}
  }

  return jsonOut({ ok: true, player: formatPlayerSummary(updatedDoc, nowMs) }, 200, corsHeaders);
}

export async function handleAdminBanPlayer(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonOut({ ok: false, error: "無效的 JSON 請求" }, 400, corsHeaders);
  }

  const targetUid = String((body && body.targetUid) || "").trim();
  if (!targetUid) {
    return jsonOut({ ok: false, error: "缺少 targetUid" }, 400, corsHeaders);
  }
  if (targetUid === auth.uid) {
    return jsonOut({ ok: false, error: "無法封鎖目前正在操作中的管理員帳號" }, 400, corsHeaders);
  }

  const userPath = `users/${encodeURIComponent(targetUid)}`;
  const userRes = await firestoreGetDoc(userPath, auth.fsAuth.Authorization);
  if (!userRes.exists) {
    const pubFallbackRes = await firestoreGetDoc(`publicProfiles/${encodeURIComponent(targetUid)}`, auth.fsAuth.Authorization);
    if (!pubFallbackRes.exists) {
      return jsonOut({ ok: false, error: "找不到該玩家資料" }, 404, corsHeaders);
    }
  }

  const nowMs = Date.now();
  const action = String((body && body.action) || "ban").trim().toLowerCase();

  let banPayload;
  let isBannedFlag = false;
  if (action === "unban") {
    isBannedFlag = false;
    banPayload = {
      isBanned: false,
      reason: "",
      bannedAt: 0,
      bannedBy: "",
      expiresAt: 0,
      unbannedAt: nowMs,
      unbannedBy: auth.uid
    };
  } else {
    const reason = String((body && body.reason) || "違反社群或服務使用規範").trim().slice(0, 300);
    const durationMinutes = Number((body && body.durationMinutes) || 0);
    const durationDays = Number((body && body.durationDays) || 0);
    const explicitExpiresAt = Number((body && body.expiresAt) || 0);
    let expiresAt = 0;
    if (explicitExpiresAt > nowMs) {
      expiresAt = Math.floor(explicitExpiresAt);
    } else if (durationMinutes > 0) {
      expiresAt = nowMs + Math.floor(durationMinutes * 60 * 1000);
    } else if (durationDays > 0) {
      expiresAt = nowMs + Math.floor(durationDays * DAY_MS);
    }
    isBannedFlag = true;
    banPayload = {
      isBanned: true,
      reason: reason || "違反社群或服務使用規範",
      bannedAt: nowMs,
      bannedBy: auth.uid,
      expiresAt
    };
  }

  const updatedDoc = await firestorePatchDoc(userPath, { ban: banPayload }, ["ban"], auth.fsAuth.Authorization);
  try {
    await firestorePatchDoc(
      `publicProfiles/${encodeURIComponent(targetUid)}`,
      { isBanned: isBannedFlag },
      ["isBanned"],
      auth.fsAuth.Authorization
    );
  } catch (e) {}

  return jsonOut({ ok: true, player: formatPlayerSummary(updatedDoc, nowMs) }, 200, corsHeaders);
}

export async function handleAdminListAppeals(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  const docs = await firestoreListCollection("banAppeals", auth.fsAuth.Authorization, {
    pageSize: 100,
    maxPages: 5
  });

  const appeals = docs
    .map((d) => {
      const id = docIdFromName(d.name);
      const data = decodeFirestoreDoc(d);
      return {
        id,
        uid: String(data.uid || ""),
        email: String(data.email || ""),
        nickname: String(data.nickname || ""),
        banReason: String(data.banReason || ""),
        banExpiresAt: Number(data.banExpiresAt) || 0,
        message: String(data.message || ""),
        status: String(data.status || "pending"),
        createdAt: Number(data.createdAt) || 0,
        resolvedAt: Number(data.resolvedAt) || 0,
        resolvedBy: String(data.resolvedBy || ""),
        adminNote: String(data.adminNote || "")
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return jsonOut({ ok: true, appeals }, 200, corsHeaders);
}

export async function handleAdminResolveAppeal(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonOut({ ok: false, error: "無效的 JSON 請求" }, 400, corsHeaders);
  }

  const appealId = String((body && body.appealId) || "").trim();
  const decision = String((body && body.decision) || "").trim().toLowerCase();
  const adminNote = String((body && body.adminNote) || "").trim().slice(0, 300);

  if (!appealId || (decision !== "approve" && decision !== "reject")) {
    return jsonOut({ ok: false, error: "請提供有效的 appealId 與 decision (approve/reject)" }, 400, corsHeaders);
  }

  const appealPath = `banAppeals/${encodeURIComponent(appealId)}`;
  const appealRes = await firestoreGetDoc(appealPath, auth.fsAuth.Authorization);
  if (!appealRes.exists) {
    return jsonOut({ ok: false, error: "找不到該申訴紀錄" }, 404, corsHeaders);
  }

  const appealData = decodeFirestoreDoc(appealRes.doc);
  const targetUid = String(appealData.uid || "").trim();
  const nowMs = Date.now();
  const newStatus = decision === "approve" ? "approved" : "rejected";

  await firestorePatchDoc(
    appealPath,
    {
      status: newStatus,
      resolvedAt: nowMs,
      resolvedBy: auth.uid,
      adminNote
    },
    ["status", "resolvedAt", "resolvedBy", "adminNote"],
    auth.fsAuth.Authorization
  );

  if (decision === "approve" && targetUid) {
    await firestorePatchDoc(
      `users/${encodeURIComponent(targetUid)}`,
      {
        ban: {
          isBanned: false,
          reason: "",
          bannedAt: 0,
          bannedBy: "",
          expiresAt: 0,
          unbannedAt: nowMs,
          unbannedBy: auth.uid
        }
      },
      ["ban"],
      auth.fsAuth.Authorization
    ).catch(() => {});
    await firestorePatchDoc(
      `publicProfiles/${encodeURIComponent(targetUid)}`,
      { isBanned: false },
      ["isBanned"],
      auth.fsAuth.Authorization
    ).catch(() => {});
  }

  return jsonOut({ ok: true, appealId, status: newStatus }, 200, corsHeaders);
}

/**
 * 賽季重置核心：只清空排位、等級、經驗與對戰勝敗，保留所有金幣、字庫與外觀！
 */
async function executeSeasonReset(authHeader, triggeredBy, nowMs = Date.now()) {
  const userDocs = await firestoreListCollection("users", authHeader, { pageSize: 200, maxPages: 20 });
  let resetUsersCount = 0;

  for (const uDoc of userDocs) {
    const uid = docIdFromName(uDoc.name);
    if (!uid) continue;
    const data = decodeFirestoreDoc(uDoc);
    const prevProg = sanitizeProgressionForRead(data.progression);

    const resetProg = {
      ...prevProg,
      level: 1,
      xp: 0,
      rankTier: "青銅 III",
      rankPoints: 0,
      duelWins: 0,
      duelTotal: 0
    };

    try {
      await firestorePatchDoc(
        `users/${encodeURIComponent(uid)}`,
        { progression: resetProg },
        ["progression"],
        authHeader
      );
      resetUsersCount++;
    } catch (e) {}

    try {
      const pubRes = await firestoreGetDoc(`publicProfiles/${encodeURIComponent(uid)}`, authHeader);
      if (pubRes.exists) {
        const pubData = decodeFirestoreDoc(pubRes.doc);
        const prevStats = pubData.stats && typeof pubData.stats === "object" ? { ...pubData.stats } : {};
        prevStats.level = 1;
        prevStats.rankPoints = 0;
        prevStats.rankTier = "青銅 III";
        await firestorePatchDoc(
          `publicProfiles/${encodeURIComponent(uid)}`,
          { stats: prevStats },
          ["stats"],
          authHeader
        );
      }
    } catch (e) {}
  }

  const seasonDocRes = await firestoreGetDoc("systemConfig/season", authHeader);
  const prevSeason = seasonDocRes.exists ? decodeFirestoreDoc(seasonDocRes.doc) : {};
  const nextSeasonNum = Math.max(1, (Number(prevSeason.seasonNumber) || 1) + 1);
  const nextSeasonConfig = {
    seasonNumber: nextSeasonNum,
    lastResetAt: nowMs,
    nextScheduledResetAt: 0,
    autoResetEnabled: false,
    updatedBy: String(triggeredBy || "system"),
    updatedAt: nowMs
  };

  await firestorePatchDoc(
    "systemConfig/season",
    nextSeasonConfig,
    ["seasonNumber", "lastResetAt", "nextScheduledResetAt", "autoResetEnabled", "updatedBy", "updatedAt"],
    authHeader
  );

  return { resetUsersCount, season: nextSeasonConfig };
}

export async function handleAdminSeasonReset(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  const nowMs = Date.now();
  const result = await executeSeasonReset(auth.fsAuth.Authorization, auth.uid, nowMs);
  return jsonOut({ ok: true, ...result }, 200, corsHeaders);
}

export async function handleAdminSeasonSchedule(request, env) {
  const corsHeaders = buildAdminCorsHeaders(request);
  const auth = await authenticateAdmin(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonOut({ ok: false, error: "無效的 JSON 請求" }, 400, corsHeaders);
  }

  const nowMs = Date.now();
  const clearSchedule = Boolean(body && body.clear);
  const days = Number((body && body.days) || 0);
  const explicitAt = Number((body && body.nextScheduledResetAt) || 0);

  let nextAt = 0;
  if (!clearSchedule) {
    if (explicitAt > nowMs) {
      nextAt = Math.floor(explicitAt);
    } else if (days > 0) {
      nextAt = nowMs + Math.floor(days * DAY_MS);
    } else {
      return jsonOut({ ok: false, error: "請設定有效的天數或未來的排程時間" }, 400, corsHeaders);
    }
  }

  const prevRes = await firestoreGetDoc("systemConfig/season", auth.fsAuth.Authorization);
  const prev = prevRes.exists ? decodeFirestoreDoc(prevRes.doc) : {};
  const seasonConfig = {
    seasonNumber: Math.max(1, Number(prev.seasonNumber) || 1),
    lastResetAt: Number(prev.lastResetAt) || 0,
    nextScheduledResetAt: nextAt,
    autoResetEnabled: !clearSchedule && nextAt > nowMs,
    updatedBy: auth.uid,
    updatedAt: nowMs
  };

  await firestorePatchDoc(
    "systemConfig/season",
    seasonConfig,
    ["seasonNumber", "lastResetAt", "nextScheduledResetAt", "autoResetEnabled", "updatedBy", "updatedAt"],
    auth.fsAuth.Authorization
  );

  return jsonOut({ ok: true, season: seasonConfig }, 200, corsHeaders);
}

export async function handleGetSeasonStatus(request, env, corsHeaders) {
  const nowMs = Date.now();
  const fsAuth = await getFirestoreAuthHeader(env, "");
  const fallbackSeason = {
    seasonNumber: 1,
    lastResetAt: 0,
    nextScheduledResetAt: 0,
    autoResetEnabled: false
  };

  if (!fsAuth.isAdminToken || !fsAuth.Authorization) {
    return jsonOut({ ok: true, season: fallbackSeason }, 200, corsHeaders);
  }

  const res = await firestoreGetDoc("systemConfig/season", fsAuth.Authorization);
  if (!res.exists) {
    return jsonOut({ ok: true, season: fallbackSeason }, 200, corsHeaders);
  }

  const data = decodeFirestoreDoc(res.doc);
  const autoResetEnabled = Boolean(data.autoResetEnabled);
  const nextScheduledResetAt = Number(data.nextScheduledResetAt) || 0;

  if (autoResetEnabled && nextScheduledResetAt > 0 && nowMs >= nextScheduledResetAt) {
    try {
      // 先清除排程標記，避免併發重複觸發重置
      await firestorePatchDoc(
        "systemConfig/season",
        { autoResetEnabled: false, nextScheduledResetAt: 0 },
        ["autoResetEnabled", "nextScheduledResetAt"],
        fsAuth.Authorization
      );
      const resetRes = await executeSeasonReset(fsAuth.Authorization, "auto_schedule", nowMs);
      return jsonOut({ ok: true, autoTriggered: true, season: resetRes.season }, 200, corsHeaders);
    } catch (e) {}
  }

  return jsonOut(
    {
      ok: true,
      season: {
        seasonNumber: Math.max(1, Number(data.seasonNumber) || 1),
        lastResetAt: Number(data.lastResetAt) || 0,
        nextScheduledResetAt,
        autoResetEnabled
      }
    },
    200,
    corsHeaders
  );
}

export async function handleGetBanStatus(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return jsonOut({ ok: false, error: "缺少身份憑證" }, 401, corsHeaders);
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return jsonOut({ ok: false, error: "身份憑證無效" }, 401, corsHeaders);
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userRes = await firestoreGetDoc(`users/${encodeURIComponent(verified.uid)}`, authHeader);
  if (!userRes.exists) {
    return jsonOut({ ok: true, ban: { isBanned: false, reason: "", expiresAt: 0 } }, 200, corsHeaders);
  }

  const nowMs = Date.now();
  const ban = parseUserBanState(userRes.doc, nowMs);
  if (ban.expired && fsAuth.isAdminToken) {
    await firestorePatchDoc(
      `users/${encodeURIComponent(verified.uid)}`,
      {
        ban: {
          isBanned: false,
          reason: "",
          bannedAt: 0,
          bannedBy: "",
          expiresAt: 0,
          unbannedAt: nowMs,
          autoUnlocked: true
        }
      },
      ["ban"],
      fsAuth.Authorization
    ).catch(() => {});
    await firestorePatchDoc(
      `publicProfiles/${encodeURIComponent(verified.uid)}`,
      { isBanned: false },
      ["isBanned"],
      fsAuth.Authorization
    ).catch(() => {});
    return jsonOut(
      { ok: true, autoUnlocked: true, ban: { isBanned: false, reason: "", expiresAt: 0, bannedAt: 0 } },
      200,
      corsHeaders
    );
  }

  return jsonOut({ ok: true, ban }, 200, corsHeaders);
}

export async function handleSubmitBanAppeal(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return jsonOut({ ok: false, error: "缺少身份憑證" }, 401, corsHeaders);
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return jsonOut({ ok: false, error: "身份憑證無效或已過期" }, 401, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonOut({ ok: false, error: "無效的 JSON 請求" }, 400, corsHeaders);
  }

  const message = String((body && body.message) || "").trim().slice(0, 600);
  if (!message) {
    return jsonOut({ ok: false, error: "請填寫申訴說明內容" }, 400, corsHeaders);
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  if (!fsAuth.isAdminToken || !fsAuth.Authorization) {
    return jsonOut({ ok: false, error: "伺服器未配置管理權限" }, 503, corsHeaders);
  }

  const userRes = await firestoreGetDoc(`users/${encodeURIComponent(verified.uid)}`, fsAuth.Authorization);
  if (!userRes.exists) {
    return jsonOut({ ok: false, error: "找不到帳號資料" }, 404, corsHeaders);
  }

  const nowMs = Date.now();
  const ban = parseUserBanState(userRes.doc, nowMs);
  if (!ban.isBanned) {
    return jsonOut({ ok: false, error: "目前帳號未被封鎖，無需提交申訴" }, 400, corsHeaders);
  }

  const userData = decodeFirestoreDoc(userRes.doc);
  const appealId = `${verified.uid}_${nowMs}`.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 120);

  await firestorePatchDoc(
    `banAppeals/${encodeURIComponent(appealId)}`,
    {
      uid: verified.uid,
      email: String(userData.email || verified.email || ""),
      nickname: String(userData.nickname || userData.displayName || "學習者"),
      banReason: ban.reason || "",
      banExpiresAt: ban.expiresAt || 0,
      message,
      status: "pending",
      createdAt: nowMs,
      resolvedAt: 0,
      resolvedBy: "",
      adminNote: ""
    },
    ["uid", "email", "nickname", "banReason", "banExpiresAt", "message", "status", "createdAt", "resolvedAt", "resolvedBy", "adminNote"],
    fsAuth.Authorization
  );

  return jsonOut({ ok: true, appealId, message: "申訴已送出，請等待管理員審核。" }, 200, corsHeaders);
}
