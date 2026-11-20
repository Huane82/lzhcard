import { getFirestoreAuthHeader } from "./firestoreAdmin.js";

export const FIREBASE_PROJECT_ID = "flashcards-5f514";

export const TIER_ORDER = ["free", "supporter_30", "supporter_90", "supporter_180"];

export const TIER_CONFIGS = {
  free: {
    id: "free",
    priority: 1,
    daily: { def_fill: 10, article_gen: 1, vision_ocr: 0, fast_refine: 0 },
    monthly: { def_fill: 120, article_gen: 10, vision_ocr: 0, fast_refine: 0 }
  },
  supporter_30: {
    id: "supporter_30",
    priority: 2,
    daily: { def_fill: 40, article_gen: 5, vision_ocr: 5, fast_refine: 60 },
    monthly: { def_fill: 600, article_gen: 80, vision_ocr: 80, fast_refine: 800 }
  },
  supporter_90: {
    id: "supporter_90",
    priority: 3,
    daily: { def_fill: 120, article_gen: 12, vision_ocr: 20, fast_refine: 250 },
    monthly: { def_fill: 1800, article_gen: 180, vision_ocr: 300, fast_refine: 3000 }
  },
  supporter_180: {
    id: "supporter_180",
    priority: 4,
    daily: { def_fill: 300, article_gen: 25, vision_ocr: 50, fast_refine: 600 },
    monthly: { def_fill: 4500, article_gen: 400, vision_ocr: 750, fast_refine: 8000 }
  }
};

export const GUEST_DAILY_LIMITS = {
  def_fill: 5,
  article_gen: 1,
  vision_ocr: 0,
  fast_refine: 0
};

export const VALID_FEATURES = ["def_fill", "article_gen", "vision_ocr", "fast_refine"];

export function normalizeFeatureName(rawFeature, hasInlineMedia = false) {
  const f = String(rawFeature || "").trim().toLowerCase();
  if (f === "vision_ocr" || f === "ocr" || f === "photo") return "vision_ocr";
  if (f === "article_gen" || f === "article" || f === "cloze" || f === "reading" || f === "translation_gen") return "article_gen";
  if (f === "fast_refine" || f === "subtitle" || f === "refine") return "fast_refine";
  if (hasInlineMedia) return "vision_ocr";
  return "def_fill";
}

export function getTaiwanDateKeys(nowMs = Date.now()) {
  const utc8 = new Date(nowMs + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  return {
    dailyDate: `${y}-${m}-${d}`,
    monthlyKey: `${y}-${m}`
  };
}

export function extractBearerToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}

export async function verifyFirebaseToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const uid = String(data.user_id || data.sub || "").trim();
    if (!uid) return null;
    return { uid, email: data.email || "" };
  } catch (e) {
    return null;
  }
}

export function readFirestoreNumber(fieldObj, fallback = 0) {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  if (fieldObj.integerValue !== undefined) return Number(fieldObj.integerValue) || 0;
  if (fieldObj.doubleValue !== undefined) return Number(fieldObj.doubleValue) || 0;
  return fallback;
}

export function readFirestoreString(fieldObj, fallback = "") {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  return typeof fieldObj.stringValue === "string" ? fieldObj.stringValue : fallback;
}

export function readFirestoreBoolean(fieldObj, fallback = false) {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  if (fieldObj.booleanValue !== undefined) return Boolean(fieldObj.booleanValue);
  return fallback;
}

export function isUserAdminFromFields(fields = {}) {
  const role = readFirestoreString(fields.role, "user").trim().toLowerCase();
  const isAdminFlag = readFirestoreBoolean(fields.isAdmin, false);
  return role === "admin" || isAdminFlag;
}

function readUsageMap(mapField) {
  const fields = (mapField && mapField.mapValue && mapField.mapValue.fields) || {};
  return {
    def_fill: Math.max(0, Math.floor(readFirestoreNumber(fields.def_fill, 0))),
    article_gen: Math.max(0, Math.floor(readFirestoreNumber(fields.article_gen, 0))),
    vision_ocr: Math.max(0, Math.floor(readFirestoreNumber(fields.vision_ocr, 0))),
    fast_refine: Math.max(0, Math.floor(readFirestoreNumber(fields.fast_refine, 0)))
  };
}

function encodeUsageMapField(counts) {
  const fields = {};
  for (const k of VALID_FEATURES) {
    fields[k] = { integerValue: String(Math.max(0, Math.floor(Number(counts[k]) || 0))) };
  }
  return { mapValue: { fields } };
}

export function resolveEffectiveTier(userFields, nowMs = Date.now()) {
  if (isUserAdminFromFields(userFields || {})) {
    return "supporter_180";
  }

  const memFields = (userFields?.membership?.mapValue?.fields) || {};
  let baseTier = readFirestoreString(memFields.tier, "free");
  if (!TIER_CONFIGS[baseTier]) baseTier = "free";
  const baseExpiresAt = readFirestoreNumber(memFields.expiresAt, 0);
  if (baseTier !== "free" && baseExpiresAt > 0 && baseExpiresAt <= nowMs) {
    baseTier = "free";
  }

  const boostFields = (userFields?.coinBoost?.mapValue?.fields) || {};
  let trialTier = readFirestoreString(boostFields.trialTier, "free");
  const trialExpiresAt = readFirestoreNumber(boostFields.trialExpiresAt, 0);
  if (!TIER_CONFIGS[trialTier] || trialExpiresAt <= nowMs) {
    trialTier = "free";
  }

  const baseIdx = TIER_ORDER.indexOf(baseTier);
  const trialIdx = TIER_ORDER.indexOf(trialTier);
  return TIER_ORDER[Math.max(baseIdx, trialIdx, 0)] || "free";
}

export function parseUserQuotaState(userDoc, nowMs = Date.now()) {
  const fields = (userDoc && userDoc.fields) || {};
  const isAdmin = isUserAdminFromFields(fields);
  const { dailyDate, monthlyKey } = getTaiwanDateKeys(nowMs);
  const tier = resolveEffectiveTier(fields, nowMs);
  const tierCfg = TIER_CONFIGS[tier] || TIER_CONFIGS.free;

  const usageFields = (fields.aiUsage && fields.aiUsage.mapValue && fields.aiUsage.mapValue.fields) || {};
  const storedDailyDate = readFirestoreString(usageFields.dailyDate, "");
  const storedMonthlyKey = readFirestoreString(usageFields.monthlyKey, "");

  const daily = storedDailyDate === dailyDate
    ? readUsageMap(usageFields.daily)
    : { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };

  const monthly = storedMonthlyKey === monthlyKey
    ? readUsageMap(usageFields.monthly)
    : { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };

  const boostFields = (fields.coinBoost && fields.coinBoost.mapValue && fields.coinBoost.mapValue.fields) || {};
  const credits = readUsageMap(boostFields.credits);
  const trialTier = readFirestoreString(boostFields.trialTier, "free");
  const trialExpiresAt = readFirestoreNumber(boostFields.trialExpiresAt, 0);

  return {
    isAdmin,
    tier,
    priority: isAdmin ? 4 : tierCfg.priority,
    dailyDate,
    monthlyKey,
    limits: isAdmin
      ? {
          id: "supporter_180",
          priority: 4,
          daily: { def_fill: 999999, article_gen: 999999, vision_ocr: 999999, fast_refine: 999999 },
          monthly: { def_fill: 999999, article_gen: 999999, vision_ocr: 999999, fast_refine: 999999 }
        }
      : tierCfg,
    daily,
    monthly,
    coinBoost: {
      trialTier: trialExpiresAt > nowMs ? trialTier : "free",
      trialExpiresAt: trialExpiresAt > nowMs ? trialExpiresAt : 0,
      credits
    }
  };
}

export function buildQuotaSnapshotPayload(quotaState) {
  const remainingDaily = {};
  const remainingMonthly = {};
  for (const f of VALID_FEATURES) {
    if (quotaState.isAdmin) {
      remainingDaily[f] = 999999;
      remainingMonthly[f] = 999999;
    } else {
      const dLim = quotaState.limits.daily[f] || 0;
      const mLim = quotaState.limits.monthly[f] || 0;
      const extra = (quotaState.coinBoost && quotaState.coinBoost.credits && quotaState.coinBoost.credits[f]) || 0;
      remainingDaily[f] = Math.max(0, dLim - (quotaState.daily[f] || 0)) + extra;
      remainingMonthly[f] = Math.max(0, mLim - (quotaState.monthly[f] || 0)) + extra;
    }
  }
  return {
    isAdmin: Boolean(quotaState.isAdmin),
    tier: quotaState.tier,
    priority: quotaState.priority,
    dailyDate: quotaState.dailyDate,
    monthlyKey: quotaState.monthlyKey,
    daily: quotaState.daily,
    monthly: quotaState.monthly,
    limits: {
      daily: quotaState.limits.daily,
      monthly: quotaState.limits.monthly
    },
    credits: quotaState.coinBoost ? quotaState.coinBoost.credits : { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialTier: quotaState.coinBoost ? quotaState.coinBoost.trialTier : "free",
    trialExpiresAt: quotaState.coinBoost ? quotaState.coinBoost.trialExpiresAt : 0,
    remainingDaily,
    remainingMonthly
  };
}

async function checkGuestCacheQuota(request, feature, nowMs) {
  const limit = GUEST_DAILY_LIMITS[feature] || 0;
  if (limit <= 0) {
    return {
      allowed: false,
      tier: "free",
      priority: 1,
      used: 0,
      limit,
      reason: "此高耗能 AI 功能僅提供登入並訂閱入門／進階／專業方案，或填寫個人 Groq / Google API Key 使用！",
      snapshot: null
    };
  }

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "guest";
  const { dailyDate, monthlyKey } = getTaiwanDateKeys(nowMs);
  const cache = caches.default;
  const cacheKey = new Request(`https://quota-guest.lzhcard.internal/${encodeURIComponent(ip)}/${dailyDate}/${feature}`);

  let used = 0;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const json = await hit.json();
      used = Number(json.used) || 0;
    }
  } catch (e) {}

  if (used >= limit) {
    return {
      allowed: false,
      tier: "free",
      priority: 1,
      used,
      limit,
      reason: `訪客今日「${feature}」免費額度已達上限 (${used}/${limit})，登入、升級方案或填寫個人 Groq / Google API Key 即可繼續使用！`,
      snapshot: null
    };
  }

  const nextUsed = used + 1;
  try {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ used: nextUsed }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
      })
    );
  } catch (e) {}

  const dailyCounts = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0, [feature]: nextUsed };
  return {
    allowed: true,
    isGuest: true,
    tier: "free",
    priority: 1,
    snapshot: {
      isAdmin: false,
      tier: "free",
      priority: 1,
      dailyDate,
      monthlyKey,
      daily: dailyCounts,
      monthly: dailyCounts,
      limits: {
        daily: GUEST_DAILY_LIMITS,
        monthly: GUEST_DAILY_LIMITS
      },
      credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
      remainingDaily: {
        def_fill: Math.max(0, GUEST_DAILY_LIMITS.def_fill - (feature === "def_fill" ? nextUsed : 0)),
        article_gen: Math.max(0, GUEST_DAILY_LIMITS.article_gen - (feature === "article_gen" ? nextUsed : 0)),
        vision_ocr: 0,
        fast_refine: 0
      },
      remainingMonthly: {
        def_fill: Math.max(0, GUEST_DAILY_LIMITS.def_fill - (feature === "def_fill" ? nextUsed : 0)),
        article_gen: Math.max(0, GUEST_DAILY_LIMITS.article_gen - (feature === "article_gen" ? nextUsed : 0)),
        vision_ocr: 0,
        fast_refine: 0
      }
    }
  };
}

export async function authorizeAndConsumeQuota(request, featureName, env = null) {
  const feature = normalizeFeatureName(featureName);
  const nowMs = Date.now();
  const idToken = extractBearerToken(request);

  if (!idToken) {
    return await checkGuestCacheQuota(request, feature, nowMs);
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return await checkGuestCacheQuota(request, feature, nowMs);
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(verified.uid)}`;
  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": fsAuth.Authorization || `Bearer ${idToken}`
  };

  let userDoc = null;
  try {
    const userRes = await fetch(userUrl, { headers: authHeaders });
    if (userRes.ok) {
      userDoc = await userRes.json();
    }
  } catch (e) {}

  if (!userDoc) {
    return await checkGuestCacheQuota(request, feature, nowMs);
  }

  const quotaState = parseUserQuotaState(userDoc, nowMs);

  // 管理員豁免：無需扣額度、享有全配額與 VIP 優先通道
  if (quotaState.isAdmin) {
    return {
      allowed: true,
      isAdmin: true,
      uid: verified.uid,
      idToken,
      consumeFrom: "admin",
      tier: "supporter_180",
      priority: 4,
      snapshot: buildQuotaSnapshotPayload(quotaState)
    };
  }

  const dailyLimit = quotaState.limits.daily[feature] || 0;
  const monthlyLimit = quotaState.limits.monthly[feature] || 0;
  const dailyUsed = quotaState.daily[feature] || 0;
  const monthlyUsed = quotaState.monthly[feature] || 0;
  const creditAvail = (quotaState.coinBoost && quotaState.coinBoost.credits && quotaState.coinBoost.credits[feature]) || 0;

  let consumeFrom = "tier";
  if (dailyUsed >= dailyLimit || monthlyUsed >= monthlyLimit) {
    if (creditAvail > 0) {
      consumeFrom = "credit";
    } else {
      const reason = dailyLimit === 0
        ? `目前「免費方案」未包含雲端 ${feature === "vision_ocr" ? "AI 拍照識別" : "AI 字幕精修"}，已自動切換為免費本地／極速引擎！建議申請並填寫個人免費 Groq / Google API Key。`
        : (monthlyUsed >= monthlyLimit
            ? `本月「${feature}」AI 配額已用畢 (${monthlyUsed}/${monthlyLimit})，可升級方案、用商店金幣兌換或改用個人 Groq / Google API Key。`
            : `今日「${feature}」AI 配額已用畢 (${dailyUsed}/${dailyLimit})，明日重置，或可使用金幣包／個人 Groq / Google API Key。`);
      return {
        allowed: false,
        tier: quotaState.tier,
        priority: quotaState.priority,
        used: dailyUsed,
        limit: dailyLimit,
        monthlyUsed,
        monthlyLimit,
        reason,
        snapshot: buildQuotaSnapshotPayload(quotaState)
      };
    }
  }

  const nextDaily = { ...quotaState.daily };
  const nextMonthly = { ...quotaState.monthly };
  const nextCredits = { ...quotaState.coinBoost.credits };

  if (consumeFrom === "credit") {
    nextCredits[feature] = Math.max(0, creditAvail - 1);
  } else {
    nextDaily[feature] = dailyUsed + 1;
    nextMonthly[feature] = monthlyUsed + 1;
  }

  const nextState = {
    ...quotaState,
    daily: nextDaily,
    monthly: nextMonthly,
    coinBoost: {
      ...quotaState.coinBoost,
      credits: nextCredits
    }
  };

  const patchFields = {
    aiUsage: {
      mapValue: {
        fields: {
          dailyDate: { stringValue: quotaState.dailyDate },
          monthlyKey: { stringValue: quotaState.monthlyKey },
          daily: encodeUsageMapField(nextDaily),
          monthly: encodeUsageMapField(nextMonthly),
          updatedAt: { integerValue: String(nowMs) }
        }
      }
    }
  };
  const updateMasks = ["updateMask.fieldPaths=aiUsage"];

  if (consumeFrom === "credit") {
    updateMasks.push("updateMask.fieldPaths=coinBoost");
    patchFields.coinBoost = {
      mapValue: {
        fields: {
          trialTier: { stringValue: quotaState.coinBoost.trialTier || "free" },
          trialExpiresAt: { integerValue: String(quotaState.coinBoost.trialExpiresAt || 0) },
          credits: encodeUsageMapField(nextCredits)
        }
      }
    };
  }

  try {
    await fetch(`${userUrl}?${updateMasks.join("&")}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ fields: patchFields })
    });
  } catch (e) {}

  return {
    allowed: true,
    uid: verified.uid,
    idToken,
    consumeFrom,
    tier: nextState.tier,
    priority: nextState.priority,
    snapshot: buildQuotaSnapshotPayload(nextState)
  };
}

export async function handleGetQuotaStatus(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  const nowMs = Date.now();
  if (!idToken) {
    const { dailyDate, monthlyKey } = getTaiwanDateKeys(nowMs);
    return new Response(
      JSON.stringify({
        ok: true,
        authenticated: false,
        quota: {
          isAdmin: false,
          tier: "free",
          priority: 1,
          dailyDate,
          monthlyKey,
          daily: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
          monthly: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
          limits: { daily: GUEST_DAILY_LIMITS, monthly: GUEST_DAILY_LIMITS },
          credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
          remainingDaily: GUEST_DAILY_LIMITS,
          remainingMonthly: GUEST_DAILY_LIMITS
        }
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "身份憑證無效或已過期" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(verified.uid)}`;
  const userRes = await fetch(userUrl, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": fsAuth.Authorization || `Bearer ${idToken}`
    }
  });
  if (!userRes.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: "無法讀取雲端配額資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userDoc = await userRes.json();
  const state = parseUserQuotaState(userDoc, nowMs);
  return new Response(
    JSON.stringify({ ok: true, authenticated: true, quota: buildQuotaSnapshotPayload(state) }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
