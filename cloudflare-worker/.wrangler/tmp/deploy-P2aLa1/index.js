var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/firestoreAdmin.js
var FIRESTORE_DOC_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
var ANDROID_PUBLISHER_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
var tokenCache = {
  firestore: { token: "", expiresAt: 0 },
  play: { token: "", expiresAt: 0 }
};
function base64UrlEncode(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function pemToArrayBuffer(pem) {
  const b64 = String(pem || "").replace(/-----BEGIN [A-Z0-9 ]+-----/g, "").replace(/-----END [A-Z0-9 ]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
__name(pemToArrayBuffer, "pemToArrayBuffer");
function parseServiceAccountJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}
__name(parseServiceAccountJson, "parseServiceAccountJson");
function getServiceAccount(env, preferPlay = false) {
  if (!env) return null;
  const primary = preferPlay ? env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT : env.FIREBASE_SERVICE_ACCOUNT || env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  return parseServiceAccountJson(primary);
}
__name(getServiceAccount, "getServiceAccount");
async function getGoogleAccessToken(sa, scope, cacheSlot = "firestore") {
  if (!sa || !sa.client_email || !sa.private_key) return "";
  const nowSec = Math.floor(Date.now() / 1e3);
  const cached = tokenCache[cacheSlot];
  if (cached && cached.token && cached.expiresAt > nowSec + 60) {
    return cached.token;
  }
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: sa.token_uri || "https://oauth2.googleapis.com/token",
      scope,
      iat: nowSec,
      exp: nowSec + 3600
    })
  );
  const signingInput = `${header}.${payload}`;
  const keyData = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncode(sigBuf)}`;
  const tokenRes = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => "");
    throw new Error(`Service account OAuth2 failed (${tokenRes.status}): ${errText.slice(0, 160)}`);
  }
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token || "";
  if (accessToken) {
    tokenCache[cacheSlot] = {
      token: accessToken,
      expiresAt: nowSec + (Number(tokenJson.expires_in) || 3500)
    };
  }
  return accessToken;
}
__name(getGoogleAccessToken, "getGoogleAccessToken");
async function getFirestoreAuthHeader(env, fallbackIdToken = "") {
  const sa = getServiceAccount(env, false);
  if (sa) {
    try {
      const token = await getGoogleAccessToken(
        sa,
        "https://www.googleapis.com/auth/datastore",
        "firestore"
      );
      if (token) {
        return {
          Authorization: `Bearer ${token}`,
          isAdminToken: true
        };
      }
    } catch (e) {
      console.warn("Firestore Admin token acquisition failed:", e.message);
    }
  }
  return {
    Authorization: fallbackIdToken ? `Bearer ${fallbackIdToken}` : "",
    isAdminToken: false
  };
}
__name(getFirestoreAuthHeader, "getFirestoreAuthHeader");
function encodeFirestoreValue(val) {
  if (val === null || val === void 0) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map((item) => encodeFirestoreValue(item))
      }
    };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== void 0) {
        fields[k] = encodeFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}
__name(encodeFirestoreValue, "encodeFirestoreValue");
function decodeFirestoreValue(fieldObj) {
  if (!fieldObj || typeof fieldObj !== "object") return void 0;
  if (fieldObj.nullValue !== void 0) return null;
  if (fieldObj.booleanValue !== void 0) return Boolean(fieldObj.booleanValue);
  if (fieldObj.integerValue !== void 0) return Number(fieldObj.integerValue);
  if (fieldObj.doubleValue !== void 0) return Number(fieldObj.doubleValue);
  if (fieldObj.stringValue !== void 0) return fieldObj.stringValue;
  if (fieldObj.timestampValue !== void 0) return fieldObj.timestampValue;
  if (fieldObj.arrayValue) {
    const vals = Array.isArray(fieldObj.arrayValue.values) ? fieldObj.arrayValue.values : [];
    return vals.map((v) => decodeFirestoreValue(v));
  }
  if (fieldObj.mapValue) {
    const out = {};
    const fields = fieldObj.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return void 0;
}
__name(decodeFirestoreValue, "decodeFirestoreValue");
function decodeFirestoreDoc(doc) {
  if (!doc || !doc.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}
__name(decodeFirestoreDoc, "decodeFirestoreDoc");
async function firestoreGetDoc(docPath, authHeader) {
  const url = `${FIRESTORE_DOC_BASE}/${docPath}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeader ? { Authorization: authHeader } : {}
    }
  });
  if (res.status === 404) return { exists: false, doc: null, status: 404 };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { exists: false, doc: null, status: res.status, error: text };
  }
  const doc = await res.json();
  return { exists: true, doc, status: res.status };
}
__name(firestoreGetDoc, "firestoreGetDoc");
async function firestorePatchDoc(docPath, plainFields, maskPaths, authHeader) {
  const params = (maskPaths || []).map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  const encodedFields = {};
  for (const [k, v] of Object.entries(plainFields)) {
    encodedFields[k] = encodeFirestoreValue(v);
  }
  const res = await fetch(`${FIRESTORE_DOC_BASE}/${docPath}${query}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeader ? { Authorization: authHeader } : {}
    },
    body: JSON.stringify({ fields: encodedFields })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firestore PATCH failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  return await res.json();
}
__name(firestorePatchDoc, "firestorePatchDoc");
async function firestoreCreateDocIfAbsent(collectionPath, docId, plainFields, authHeader) {
  const encodedFields = {};
  for (const [k, v] of Object.entries(plainFields)) {
    encodedFields[k] = encodeFirestoreValue(v);
  }
  const res = await fetch(
    `${FIRESTORE_DOC_BASE}/${collectionPath}?documentId=${encodeURIComponent(docId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader ? { Authorization: authHeader } : {}
      },
      body: JSON.stringify({ fields: encodedFields })
    }
  );
  if (res.status === 409) {
    return { created: false, alreadyExists: true };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firestore CREATE failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  return { created: true, alreadyExists: false, doc: await res.json() };
}
__name(firestoreCreateDocIfAbsent, "firestoreCreateDocIfAbsent");
async function verifyGooglePlayProductReceipt(env, { packageName, productId, purchaseToken, isSubscription = false }) {
  const sa = getServiceAccount(env, true);
  if (!sa || !sa.client_email || !sa.private_key) {
    return {
      ok: false,
      code: "PLAY_BILLING_NOT_CONFIGURED",
      status: 503,
      error: "\u4F3A\u670D\u5668\u5C1A\u672A\u8A2D\u5B9A GOOGLE_PLAY_SERVICE_ACCOUNT_JSON\uFF0C\u7121\u6CD5\u9A57\u8B49 Google Play \u6536\u64DA\u3002"
    };
  }
  let playToken = "";
  try {
    playToken = await getGoogleAccessToken(
      sa,
      "https://www.googleapis.com/auth/androidpublisher",
      "play"
    );
  } catch (e) {
    return {
      ok: false,
      code: "PLAY_AUTH_ERROR",
      status: 502,
      error: `Google Play API \u6191\u8B49\u6388\u6B0A\u5931\u6557\uFF1A${e.message}`
    };
  }
  const pkg = encodeURIComponent(packageName);
  const pid = encodeURIComponent(productId);
  const ptok = encodeURIComponent(purchaseToken);
  if (isSubscription) {
    const subUrl = `${ANDROID_PUBLISHER_BASE}/applications/${pkg}/purchases/subscriptionsv2/tokens/${ptok}`;
    const res2 = await fetch(subUrl, {
      headers: { Authorization: `Bearer ${playToken}` }
    });
    if (!res2.ok) {
      const txt = await res2.text().catch(() => "");
      return {
        ok: false,
        code: "PLAY_RECEIPT_INVALID",
        status: 400,
        error: `Google Play \u8A02\u95B1\u6536\u64DA\u9A57\u8B49\u5931\u6557 (${res2.status}): ${txt.slice(0, 120)}`
      };
    }
    const subData = await res2.json();
    const state = String(subData.subscriptionState || "");
    const active = state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
    if (!active) {
      return {
        ok: false,
        code: "PLAY_SUBSCRIPTION_INACTIVE",
        status: 400,
        error: `Google Play \u8A02\u95B1\u72C0\u614B\u7121\u6548\uFF1A${state || "UNKNOWN"}`
      };
    }
    return {
      ok: true,
      orderId: subData.latestOrderId || "",
      acknowledged: subData.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      raw: subData
    };
  }
  const prodUrl = `${ANDROID_PUBLISHER_BASE}/applications/${pkg}/purchases/products/${pid}/tokens/${ptok}`;
  const res = await fetch(prodUrl, {
    headers: { Authorization: `Bearer ${playToken}` }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      code: "PLAY_RECEIPT_INVALID",
      status: 400,
      error: `Google Play \u5546\u54C1\u6536\u64DA\u9A57\u8B49\u5931\u6557 (${res.status}): ${txt.slice(0, 120)}`
    };
  }
  const prodData = await res.json();
  if (Number(prodData.purchaseState) !== 0) {
    return {
      ok: false,
      code: "PLAY_PURCHASE_NOT_COMPLETED",
      status: 400,
      error: `\u6B64 Google Play \u4EA4\u6613\u5C1A\u672A\u5B8C\u6210\u6216\u5DF2\u53D6\u6D88 (state=${prodData.purchaseState})`
    };
  }
  return {
    ok: true,
    orderId: String(prodData.orderId || "").trim(),
    consumptionState: Number(prodData.consumptionState) || 0,
    acknowledgementState: Number(prodData.acknowledgementState) || 0,
    raw: prodData
  };
}
__name(verifyGooglePlayProductReceipt, "verifyGooglePlayProductReceipt");
async function consumeOrAckGooglePlayPurchase(env, { packageName, productId, purchaseToken, consumable = false }) {
  const sa = getServiceAccount(env, true);
  if (!sa) return;
  try {
    const playToken = await getGoogleAccessToken(
      sa,
      "https://www.googleapis.com/auth/androidpublisher",
      "play"
    );
    const pkg = encodeURIComponent(packageName);
    const pid = encodeURIComponent(productId);
    const ptok = encodeURIComponent(purchaseToken);
    const action = consumable ? "consume" : "acknowledge";
    await fetch(`${ANDROID_PUBLISHER_BASE}/applications/${pkg}/purchases/products/${pid}/tokens/${ptok}:${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${playToken}`
      },
      body: JSON.stringify({})
    });
  } catch (e) {
    console.warn("Google Play consume/ack warning:", e.message);
  }
}
__name(consumeOrAckGooglePlayPurchase, "consumeOrAckGooglePlayPurchase");
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");

// src/quotaManager.js
var FIREBASE_PROJECT_ID = "flashcards-5f514";
var TIER_ORDER = ["free", "supporter_30", "supporter_90", "supporter_180"];
var TIER_CONFIGS = {
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
    monthly: { def_fill: 1800, article_gen: 180, vision_ocr: 300, fast_refine: 3e3 }
  },
  supporter_180: {
    id: "supporter_180",
    priority: 4,
    daily: { def_fill: 300, article_gen: 25, vision_ocr: 50, fast_refine: 600 },
    monthly: { def_fill: 4500, article_gen: 400, vision_ocr: 750, fast_refine: 8e3 }
  }
};
var GUEST_DAILY_LIMITS = {
  def_fill: 5,
  article_gen: 1,
  vision_ocr: 0,
  fast_refine: 0
};
var VALID_FEATURES = ["def_fill", "article_gen", "vision_ocr", "fast_refine"];
function normalizeFeatureName(rawFeature, hasInlineMedia = false) {
  const f = String(rawFeature || "").trim().toLowerCase();
  if (f === "vision_ocr" || f === "ocr" || f === "photo") return "vision_ocr";
  if (f === "article_gen" || f === "article" || f === "cloze" || f === "reading" || f === "translation_gen") return "article_gen";
  if (f === "fast_refine" || f === "subtitle" || f === "refine") return "fast_refine";
  if (hasInlineMedia) return "vision_ocr";
  return "def_fill";
}
__name(normalizeFeatureName, "normalizeFeatureName");
function getTaiwanDateKeys(nowMs = Date.now()) {
  const utc8 = new Date(nowMs + 8 * 60 * 60 * 1e3);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  return {
    dailyDate: `${y}-${m}-${d}`,
    monthlyKey: `${y}-${m}`
  };
}
__name(getTaiwanDateKeys, "getTaiwanDateKeys");
function extractBearerToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}
__name(extractBearerToken, "extractBearerToken");
async function verifyFirebaseToken(idToken) {
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
__name(verifyFirebaseToken, "verifyFirebaseToken");
function readFirestoreNumber(fieldObj, fallback = 0) {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  if (fieldObj.integerValue !== void 0) return Number(fieldObj.integerValue) || 0;
  if (fieldObj.doubleValue !== void 0) return Number(fieldObj.doubleValue) || 0;
  return fallback;
}
__name(readFirestoreNumber, "readFirestoreNumber");
function readFirestoreString(fieldObj, fallback = "") {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  return typeof fieldObj.stringValue === "string" ? fieldObj.stringValue : fallback;
}
__name(readFirestoreString, "readFirestoreString");
function readFirestoreBoolean(fieldObj, fallback = false) {
  if (!fieldObj || typeof fieldObj !== "object") return fallback;
  if (fieldObj.booleanValue !== void 0) return Boolean(fieldObj.booleanValue);
  return fallback;
}
__name(readFirestoreBoolean, "readFirestoreBoolean");
function isUserAdminFromFields(fields = {}) {
  const role = readFirestoreString(fields.role, "user").trim().toLowerCase();
  const isAdminFlag = readFirestoreBoolean(fields.isAdmin, false);
  return role === "admin" || isAdminFlag;
}
__name(isUserAdminFromFields, "isUserAdminFromFields");
function readUsageMap(mapField) {
  const fields = mapField && mapField.mapValue && mapField.mapValue.fields || {};
  return {
    def_fill: Math.max(0, Math.floor(readFirestoreNumber(fields.def_fill, 0))),
    article_gen: Math.max(0, Math.floor(readFirestoreNumber(fields.article_gen, 0))),
    vision_ocr: Math.max(0, Math.floor(readFirestoreNumber(fields.vision_ocr, 0))),
    fast_refine: Math.max(0, Math.floor(readFirestoreNumber(fields.fast_refine, 0)))
  };
}
__name(readUsageMap, "readUsageMap");
function encodeUsageMapField(counts) {
  const fields = {};
  for (const k of VALID_FEATURES) {
    fields[k] = { integerValue: String(Math.max(0, Math.floor(Number(counts[k]) || 0))) };
  }
  return { mapValue: { fields } };
}
__name(encodeUsageMapField, "encodeUsageMapField");
function resolveEffectiveTier(userFields, nowMs = Date.now()) {
  if (isUserAdminFromFields(userFields || {})) {
    return "supporter_180";
  }
  const memFields = userFields?.membership?.mapValue?.fields || {};
  let baseTier = readFirestoreString(memFields.tier, "free");
  if (!TIER_CONFIGS[baseTier]) baseTier = "free";
  const baseExpiresAt = readFirestoreNumber(memFields.expiresAt, 0);
  if (baseTier !== "free" && baseExpiresAt > 0 && baseExpiresAt <= nowMs) {
    baseTier = "free";
  }
  const boostFields = userFields?.coinBoost?.mapValue?.fields || {};
  let trialTier = readFirestoreString(boostFields.trialTier, "free");
  const trialExpiresAt = readFirestoreNumber(boostFields.trialExpiresAt, 0);
  if (!TIER_CONFIGS[trialTier] || trialExpiresAt <= nowMs) {
    trialTier = "free";
  }
  const baseIdx = TIER_ORDER.indexOf(baseTier);
  const trialIdx = TIER_ORDER.indexOf(trialTier);
  return TIER_ORDER[Math.max(baseIdx, trialIdx, 0)] || "free";
}
__name(resolveEffectiveTier, "resolveEffectiveTier");
function parseUserQuotaState(userDoc, nowMs = Date.now()) {
  const fields = userDoc && userDoc.fields || {};
  const isAdmin = isUserAdminFromFields(fields);
  const { dailyDate, monthlyKey } = getTaiwanDateKeys(nowMs);
  const tier = resolveEffectiveTier(fields, nowMs);
  const tierCfg = TIER_CONFIGS[tier] || TIER_CONFIGS.free;
  const usageFields = fields.aiUsage && fields.aiUsage.mapValue && fields.aiUsage.mapValue.fields || {};
  const storedDailyDate = readFirestoreString(usageFields.dailyDate, "");
  const storedMonthlyKey = readFirestoreString(usageFields.monthlyKey, "");
  const daily = storedDailyDate === dailyDate ? readUsageMap(usageFields.daily) : { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
  const monthly = storedMonthlyKey === monthlyKey ? readUsageMap(usageFields.monthly) : { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
  const boostFields = fields.coinBoost && fields.coinBoost.mapValue && fields.coinBoost.mapValue.fields || {};
  const credits = readUsageMap(boostFields.credits);
  const trialTier = readFirestoreString(boostFields.trialTier, "free");
  const trialExpiresAt = readFirestoreNumber(boostFields.trialExpiresAt, 0);
  return {
    isAdmin,
    tier,
    priority: isAdmin ? 4 : tierCfg.priority,
    dailyDate,
    monthlyKey,
    limits: isAdmin ? {
      id: "supporter_180",
      priority: 4,
      daily: { def_fill: 999999, article_gen: 999999, vision_ocr: 999999, fast_refine: 999999 },
      monthly: { def_fill: 999999, article_gen: 999999, vision_ocr: 999999, fast_refine: 999999 }
    } : tierCfg,
    daily,
    monthly,
    coinBoost: {
      trialTier: trialExpiresAt > nowMs ? trialTier : "free",
      trialExpiresAt: trialExpiresAt > nowMs ? trialExpiresAt : 0,
      credits
    }
  };
}
__name(parseUserQuotaState, "parseUserQuotaState");
function buildQuotaSnapshotPayload(quotaState) {
  const remainingDaily = {};
  const remainingMonthly = {};
  for (const f of VALID_FEATURES) {
    if (quotaState.isAdmin) {
      remainingDaily[f] = 999999;
      remainingMonthly[f] = 999999;
    } else {
      const dLim = quotaState.limits.daily[f] || 0;
      const mLim = quotaState.limits.monthly[f] || 0;
      const extra = quotaState.coinBoost && quotaState.coinBoost.credits && quotaState.coinBoost.credits[f] || 0;
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
__name(buildQuotaSnapshotPayload, "buildQuotaSnapshotPayload");
async function checkGuestCacheQuota(request, feature, nowMs) {
  const limit = GUEST_DAILY_LIMITS[feature] || 0;
  if (limit <= 0) {
    return {
      allowed: false,
      tier: "free",
      priority: 1,
      used: 0,
      limit,
      reason: "\u6B64\u9AD8\u8017\u80FD AI \u529F\u80FD\u50C5\u63D0\u4F9B\u767B\u5165\u4E26\u8A02\u95B1\u5165\u9580\uFF0F\u9032\u968E\uFF0F\u5C08\u696D\u65B9\u6848\uFF0C\u6216\u586B\u5BEB\u500B\u4EBA Groq / Google API Key \u4F7F\u7528\uFF01",
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
  } catch (e) {
  }
  if (used >= limit) {
    return {
      allowed: false,
      tier: "free",
      priority: 1,
      used,
      limit,
      reason: `\u8A2A\u5BA2\u4ECA\u65E5\u300C${feature}\u300D\u514D\u8CBB\u984D\u5EA6\u5DF2\u9054\u4E0A\u9650 (${used}/${limit})\uFF0C\u767B\u5165\u3001\u5347\u7D1A\u65B9\u6848\u6216\u586B\u5BEB\u500B\u4EBA Groq / Google API Key \u5373\u53EF\u7E7C\u7E8C\u4F7F\u7528\uFF01`,
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
  } catch (e) {
  }
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
__name(checkGuestCacheQuota, "checkGuestCacheQuota");
async function authorizeAndConsumeQuota(request, featureName, env = null) {
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
  } catch (e) {
  }
  if (!userDoc) {
    return await checkGuestCacheQuota(request, feature, nowMs);
  }
  const quotaState = parseUserQuotaState(userDoc, nowMs);
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
  const creditAvail = quotaState.coinBoost && quotaState.coinBoost.credits && quotaState.coinBoost.credits[feature] || 0;
  let consumeFrom = "tier";
  if (dailyUsed >= dailyLimit || monthlyUsed >= monthlyLimit) {
    if (creditAvail > 0) {
      consumeFrom = "credit";
    } else {
      const reason = dailyLimit === 0 ? `\u76EE\u524D\u300C\u514D\u8CBB\u65B9\u6848\u300D\u672A\u5305\u542B\u96F2\u7AEF ${feature === "vision_ocr" ? "AI \u62CD\u7167\u8B58\u5225" : "AI \u5B57\u5E55\u7CBE\u4FEE"}\uFF0C\u5DF2\u81EA\u52D5\u5207\u63DB\u70BA\u514D\u8CBB\u672C\u5730\uFF0F\u6975\u901F\u5F15\u64CE\uFF01\u5EFA\u8B70\u7533\u8ACB\u4E26\u586B\u5BEB\u500B\u4EBA\u514D\u8CBB Groq / Google API Key\u3002` : monthlyUsed >= monthlyLimit ? `\u672C\u6708\u300C${feature}\u300DAI \u914D\u984D\u5DF2\u7528\u7562 (${monthlyUsed}/${monthlyLimit})\uFF0C\u53EF\u5347\u7D1A\u65B9\u6848\u3001\u7528\u5546\u5E97\u91D1\u5E63\u514C\u63DB\u6216\u6539\u7528\u500B\u4EBA Groq / Google API Key\u3002` : `\u4ECA\u65E5\u300C${feature}\u300DAI \u914D\u984D\u5DF2\u7528\u7562 (${dailyUsed}/${dailyLimit})\uFF0C\u660E\u65E5\u91CD\u7F6E\uFF0C\u6216\u53EF\u4F7F\u7528\u91D1\u5E63\u5305\uFF0F\u500B\u4EBA Groq / Google API Key\u3002`;
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
  } catch (e) {
  }
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
__name(authorizeAndConsumeQuota, "authorizeAndConsumeQuota");
async function handleGetQuotaStatus(request, env, corsHeaders) {
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
      JSON.stringify({ ok: false, error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F" }),
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
      JSON.stringify({ ok: false, error: "\u7121\u6CD5\u8B80\u53D6\u96F2\u7AEF\u914D\u984D\u8CC7\u6599" }),
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
__name(handleGetQuotaStatus, "handleGetQuotaStatus");

// src/aiHandler.js
function contentsHasInlineMedia(contents) {
  if (!Array.isArray(contents)) return false;
  for (const item of contents) {
    const parts = Array.isArray(item && item.parts) ? item.parts : [];
    for (const part of parts) {
      if (part && (part.inlineData || part.inline_data || part.fileData || part.file_data)) {
        return true;
      }
    }
  }
  return false;
}
__name(contentsHasInlineMedia, "contentsHasInlineMedia");
function extractPlainTextPrompt(contents) {
  if (!Array.isArray(contents)) return "";
  const chunks = [];
  for (const item of contents) {
    const parts = Array.isArray(item && item.parts) ? item.parts : [];
    for (const part of parts) {
      if (part && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join("\n\n");
}
__name(extractPlainTextPrompt, "extractPlainTextPrompt");
function stripThinkTags(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
__name(stripThinkTags, "stripThinkTags");
function stripSubtitleQuotes(text) {
  return stripThinkTags(text).replace(/^["'「『]|["'」』]$/g, "").trim();
}
__name(stripSubtitleQuotes, "stripSubtitleQuotes");
async function callGroqTextCompletion(promptText, env, priority = 1) {
  if (!env.GROQ_API_KEY || !promptText) return null;
  const models = priority >= 3 ? [env.GROQ_MODEL || "qwen/qwen3-32b", "llama-3.1-8b-instant"] : ["llama-3.1-8b-instant", env.GROQ_MODEL || "qwen/qwen3-32b"];
  for (const model of models) {
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.25,
          max_tokens: 1800,
          messages: [
            {
              role: "system",
              content: "Follow all formatting rules strictly. If JSON is requested, return pure valid JSON only without markdown fences or commentary."
            },
            { role: "user", content: promptText }
          ]
        })
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const rawOut = data?.choices?.[0]?.message?.content || "";
      const cleaned = stripThinkTags(rawOut);
      if (cleaned) {
        return { text: cleaned, provider: `groq:${model}` };
      }
    } catch (e) {
    }
  }
  return null;
}
__name(callGroqTextCompletion, "callGroqTextCompletion");
async function handleGeminiAi(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const hasMedia = contentsHasInlineMedia(body && body.contents);
  const feature = normalizeFeatureName(
    body && body.feature || request.headers.get("X-AI-Feature") || "",
    hasMedia
  );
  const quotaCheck = await authorizeAndConsumeQuota(request, feature, env);
  if (!quotaCheck.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "QUOTA_EXCEEDED",
        error: quotaCheck.reason,
        feature,
        tier: quotaCheck.tier,
        quota: quotaCheck.snapshot,
        fallbackTier1: true
      }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (!hasMedia && feature === "def_fill" && env.GROQ_API_KEY) {
    const promptText = extractPlainTextPrompt(body.contents);
    const groqRes = await callGroqTextCompletion(promptText, env, quotaCheck.priority || 1);
    if (groqRes && groqRes.text) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: groqRes.text }]
              }
            }
          ],
          _provider: groqRes.provider,
          _feature: feature,
          _quota: quotaCheck.snapshot
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "\u4F3A\u670D\u5668\u672A\u8A2D\u5B9A GEMINI_API_KEY \u74B0\u5883\u8B8A\u6578" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const GEMINI_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.8-flash"
  ];
  let lastErrorData = null;
  for (const model of GEMINI_MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: body.contents })
      });
      const data = await response.json();
      if (response.ok) {
        data._provider = `gemini:${model}`;
        data._feature = feature;
        data._quota = quotaCheck.snapshot;
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      lastErrorData = data;
    } catch (e) {
      lastErrorData = { error: e.message };
    }
  }
  return new Response(
    JSON.stringify(lastErrorData || { error: "\u6240\u6709 Gemini \u6A21\u578B\u7686\u56DE\u61C9\u5931\u6557" }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleGeminiAi, "handleGeminiAi");
async function handleFastRefine(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const text = String(body && body.text || "").trim();
  if (!text) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7F3A\u4E4F\u5F85\u7CBE\u4FEE\u539F\u6587" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const quotaCheck = await authorizeAndConsumeQuota(request, "fast_refine", env);
  if (!quotaCheck.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "QUOTA_EXCEEDED",
        error: quotaCheck.reason,
        feature: "fast_refine",
        tier: quotaCheck.tier,
        quota: quotaCheck.snapshot,
        fallbackTier1: true
      }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const targetLangName = String(body && body.targetLangName || "Traditional Chinese (\u7E41\u9AD4\u4E2D\u6587)").trim();
  const draftTranslation = String(body && body.draftTranslation || "").trim();
  const contextLines = Array.isArray(body && body.contextLines) ? body.contextLines.map((l) => String(l || "").trim()).filter(Boolean).slice(-4) : [];
  const contextBlock = contextLines.length > 0 ? `\u524D\u6587\u8A9E\u5883\uFF08\u50C5\u4F9B\u9023\u8CAB\u53C3\u8003\uFF0C\u52FF\u91CD\u8907\u7FFB\u8B6F\uFF09\uFF1A
${contextLines.join("\n")}

` : "";
  const draftHint = draftTranslation ? `\u521D\u6B65\u76F4\u8B6F\u53C3\u8003\uFF1A${draftTranslation}
` : "";
  const systemPrompt = `You are a low-latency subtitle interpreter. Translate the current subtitle line naturally and idiomatically into ${targetLangName} using the prior context lines.
Rules:
1. Automatically ignore residual OCR gibberish, stray symbols, or broken character fragments at the beginning or end of the text (e.g., "| ar Ss = 5"), and translate only the coherent, meaningful sentence(s). If the entire input is pure OCR noise with no coherent meaning, output an empty string.
2. Translate colloquialisms, idioms, and slang naturally by context rather than literally (e.g., "new whip" -> "\u65B0\u8ECA\uFF0F\u5EA7\u99D5").
3. Output ONLY the final translated subtitle string with zero explanation, no quotes, and no markdown.`;
  const userPrompt = `${contextBlock}${draftHint}\u76EE\u524D\u9019\u53E5\u539F\u6587\uFF1A
${text}`;
  if (env.GROQ_API_KEY) {
    const groqModels = (quotaCheck.priority || 1) >= 3 ? [env.GROQ_MODEL || "qwen/qwen3-32b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"] : ["llama-3.1-8b-instant", env.GROQ_MODEL || "qwen/qwen3-32b"];
    for (const model of groqModels) {
      try {
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 220,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const rawOut = data?.choices?.[0]?.message?.content || "";
          const cleaned = stripSubtitleQuotes(rawOut);
          if (cleaned) {
            return new Response(
              JSON.stringify({
                ok: true,
                translation: cleaned,
                provider: `groq:${model}`,
                quota: quotaCheck.snapshot
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      } catch (e) {
      }
    }
  }
  if (env.GEMINI_API_KEY) {
    const geminiFastModels = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
    for (const model of geminiFastModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemPrompt}

${userPrompt}` }] }]
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const rawOut = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          const cleaned = stripSubtitleQuotes(rawOut);
          if (cleaned) {
            return new Response(
              JSON.stringify({
                ok: true,
                translation: cleaned,
                provider: `gemini:${model}`,
                quota: quotaCheck.snapshot
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      } catch (e) {
      }
    }
  }
  return new Response(
    JSON.stringify({
      ok: true,
      translation: draftTranslation || text,
      provider: "fallback",
      quota: quotaCheck.snapshot
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleFastRefine, "handleFastRefine");
function base64ToUint8Array(b64) {
  const clean = String(b64 || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return { bytes, cleanBase64: clean };
}
__name(base64ToUint8Array, "base64ToUint8Array");
function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
__name(uint8ArrayToBase64, "uint8ArrayToBase64");
function mimeTypeToAudioExt(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";
  return "webm";
}
__name(mimeTypeToAudioExt, "mimeTypeToAudioExt");
function normalizeWhisperLangCode(rawLang) {
  const l = String(rawLang || "").trim().toLowerCase();
  if (!l || l === "auto") return "";
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  if (l.startsWith("en")) return "en";
  return l.split(/[-_]/)[0];
}
__name(normalizeWhisperLangCode, "normalizeWhisperLangCode");
async function handleAudioStt(request, env, corsHeaders) {
  let audioBytes = null;
  let cleanBase64 = "";
  let mimeType = "audio/webm";
  let language = "";
  let promptHint = "";
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file") || form.get("audio");
      if (file && typeof file.arrayBuffer === "function") {
        audioBytes = new Uint8Array(await file.arrayBuffer());
        mimeType = file.type || "audio/webm";
        cleanBase64 = uint8ArrayToBase64(audioBytes);
      }
      language = String(form.get("language") || "").trim();
      promptHint = String(form.get("prompt") || "").trim();
    } else {
      const body = await request.json();
      const rawB64 = String(body && (body.audioBase64 || body.audio || body.data) || "").trim();
      mimeType = String(body && body.mimeType || "audio/webm").trim();
      language = String(body && body.language || "").trim();
      promptHint = String(body && body.prompt || "").trim();
      if (rawB64) {
        const decoded = base64ToUint8Array(rawB64);
        audioBytes = decoded.bytes;
        cleanBase64 = decoded.cleanBase64;
      }
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7121\u6CD5\u89E3\u6790\u8A9E\u97F3\u8FA8\u8B58\u97F3\u8A0A\u8ACB\u6C42" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (!audioBytes || audioBytes.length < 120) {
    return new Response(
      JSON.stringify({ ok: true, text: "", engine: "empty_audio" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (audioBytes.length > 15 * 1024 * 1024) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u97F3\u8A0A\u7247\u6BB5\u904E\u5927\uFF0C\u8ACB\u7E2E\u77ED\u9304\u97F3\u6642\u9593" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userApiKey = String(request.headers.get("X-User-Api-Key") || "").trim();
  const groqKey = userApiKey.startsWith("gsk_") ? userApiKey : String(env.GROQ_API_KEY || "").trim();
  const geminiKey = !userApiKey.startsWith("gsk_") && userApiKey ? userApiKey : String(env.GEMINI_API_KEY || "").trim();
  if (groqKey) {
    try {
      const ext = mimeTypeToAudioExt(mimeType);
      const blob = new Blob([audioBytes], { type: mimeType.split(";")[0] || "audio/webm" });
      const form = new FormData();
      form.append("file", blob, `speech.${ext}`);
      form.append("model", "whisper-large-v3-turbo");
      form.append("response_format", "json");
      form.append("temperature", "0");
      const isoLang = normalizeWhisperLangCode(language);
      if (isoLang) form.append("language", isoLang);
      if (promptHint) form.append("prompt", promptHint);
      const groqResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form
      });
      if (groqResp.ok) {
        const groqData = await groqResp.json();
        const text = String(groqData && groqData.text || "").trim();
        return new Response(
          JSON.stringify({ ok: true, text, engine: "groq:whisper-large-v3-turbo" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } catch (e) {
    }
  }
  if (geminiKey) {
    const cleanMime = mimeType.split(";")[0].trim() || "audio/webm";
    const GEMINI_STT_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash-lite"];
    const sttPrompt = language && language !== "auto" ? `Transcribe the spoken audio accurately (expected language: ${language}). Output ONLY the exact spoken transcript with zero explanation, no quotes, and no timestamps. If there is only silence or noise, return an empty string.` : "Transcribe the spoken audio accurately in its original language. Output ONLY the exact spoken transcript with zero explanation, no quotes, and no timestamps. If there is only silence or noise, return an empty string.";
    for (const model of GEMINI_STT_MODELS) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const resp = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: sttPrompt },
                  { inlineData: { mimeType: cleanMime, data: cleanBase64 } }
                ]
              }
            ]
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const text = stripThinkTags(
            data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
          );
          return new Response(
            JSON.stringify({ ok: true, text, engine: `gemini:${model}` }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch (e) {
      }
    }
  }
  return new Response(
    JSON.stringify({ ok: false, error: "\u8A9E\u97F3\u8F49\u6587\u5B57\u670D\u52D9\u66AB\u6642\u7121\u6CD5\u9023\u7DDA\uFF08\u8ACB\u78BA\u8A8D GROQ_API_KEY \u6216 GEMINI_API_KEY\uFF09" }),
    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleAudioStt, "handleAudioStt");

// src/billingHandler.js
var EXPECTED_PACKAGE_NAME = "com.lzhcard.app";
var DAY_MS = 24 * 60 * 60 * 1e3;
var APPLE_VERIFY_RECEIPT_PROD = "https://buy.itunes.apple.com/verifyReceipt";
var APPLE_VERIFY_RECEIPT_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";
var BILLING_SKU_CATALOG = {
  // 2:8 金幣儲值方案（NT$ 1 = 4 金幣）
  lzhcard_coins_120: {
    sku: "lzhcard_coins_120",
    kind: "coins",
    priceNtd: 30,
    coins: 120,
    consumable: true,
    title: "120 \u5546\u5E97\u91D1\u5E63\u5305"
  },
  lzhcard_coins_360: {
    sku: "lzhcard_coins_360",
    kind: "coins",
    priceNtd: 90,
    coins: 360,
    consumable: true,
    title: "360 \u5546\u5E97\u91D1\u5E63\u5305"
  },
  lzhcard_coins_720: {
    sku: "lzhcard_coins_720",
    kind: "coins",
    priceNtd: 180,
    coins: 720,
    consumable: true,
    title: "720 \u5546\u5E97\u91D1\u5E63\u5305"
  },
  lzhcard_coins_1200: {
    sku: "lzhcard_coins_1200",
    kind: "coins",
    priceNtd: 300,
    coins: 1200,
    consumable: true,
    title: "1,200 \u5546\u5E97\u91D1\u5E63\u5305"
  },
  // Google Play / Apple App Store / Web 共用會員 SKU
  lzhcard_mem_starter_30d: {
    sku: "lzhcard_mem_starter_30d",
    kind: "membership",
    tier: "supporter_30",
    cycle: "monthly",
    days: 30,
    priceNtd: 39,
    consumable: true,
    frameId: "supporter_warm_amber",
    bannerId: "supporter_warm_horizon",
    titleId: "supporter_coffee",
    title: "\u5165\u9580\u65B9\u6848 Starter (30\u5929)"
  },
  lzhcard_mem_starter_365d: {
    sku: "lzhcard_mem_starter_365d",
    kind: "membership",
    tier: "supporter_30",
    cycle: "annual",
    days: 365,
    priceNtd: 390,
    consumable: true,
    frameId: "supporter_warm_amber",
    bannerId: "supporter_warm_horizon",
    titleId: "supporter_coffee",
    title: "\u5165\u9580\u65B9\u6848 Starter \u5E74\u7E73 (365\u5929)"
  },
  lzhcard_mem_plus_30d: {
    sku: "lzhcard_mem_plus_30d",
    kind: "membership",
    tier: "supporter_90",
    cycle: "monthly",
    days: 30,
    priceNtd: 99,
    consumable: true,
    frameId: "supporter_sapphire_aura",
    bannerId: "supporter_aurora_palace",
    titleId: "supporter_diamond",
    title: "\u9032\u968E\u65B9\u6848 Plus (30\u5929)"
  },
  lzhcard_mem_plus_365d: {
    sku: "lzhcard_mem_plus_365d",
    kind: "membership",
    tier: "supporter_90",
    cycle: "annual",
    days: 365,
    priceNtd: 990,
    consumable: true,
    frameId: "supporter_sapphire_aura",
    bannerId: "supporter_aurora_palace",
    titleId: "supporter_diamond",
    title: "\u9032\u968E\u65B9\u6848 Plus \u5E74\u7E73 (365\u5929)"
  },
  lzhcard_mem_pro_30d: {
    sku: "lzhcard_mem_pro_30d",
    kind: "membership",
    tier: "supporter_180",
    cycle: "monthly",
    days: 30,
    priceNtd: 199,
    consumable: true,
    frameId: "supporter_celestial_crown",
    bannerId: "supporter_imperial_aurora",
    titleId: "supporter_crown",
    title: "\u5C08\u696D\u65B9\u6848 Pro (30\u5929)"
  },
  lzhcard_mem_pro_365d: {
    sku: "lzhcard_mem_pro_365d",
    kind: "membership",
    tier: "supporter_180",
    cycle: "annual",
    days: 365,
    priceNtd: 1990,
    consumable: true,
    frameId: "supporter_celestial_crown",
    bannerId: "supporter_imperial_aurora",
    titleId: "supporter_crown",
    title: "\u5C08\u696D\u65B9\u6848 Pro \u5E74\u7E73 (365\u5929)"
  }
};
function formatDateYmd(ts) {
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1e3);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
__name(formatDateYmd, "formatDateYmd");
function jsonResponse(payload, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");
async function authenticateBillingRequest(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, error: "\u8ACB\u5148\u767B\u5165\u5E33\u865F\u5F8C\u518D\u9032\u884C\u8CFC\u8CB7\u9A57\u8B49" }, 401, corsHeaders)
    };
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" }, 403, corsHeaders)
    };
  }
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  if (!fsAuth.isAdminToken) {
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          code: "SERVER_ADMIN_NOT_CONFIGURED",
          error: "\u4F3A\u670D\u5668\u5C1A\u672A\u914D\u7F6E FIREBASE_SERVICE_ACCOUNT \u7BA1\u7406\u6B0A\u9650\uFF0C\u5DF2\u62D2\u7D55\u4EFB\u4F55\u524D\u7AEF\u76F4\u5BEB\u5165\u5EAB\u3002"
        },
        503,
        corsHeaders
      )
    };
  }
  return { ok: true, uid: verified.uid, email: verified.email || "", idToken, fsAuth };
}
__name(authenticateBillingRequest, "authenticateBillingRequest");
async function grantVerifiedPurchase(uid, productId, transactionId, platform, extraMeta = {}, env = null, fsAuth = null) {
  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return { ok: false, status: 400, error: `\u7121\u6548\u7684\u5546\u54C1\u4EE3\u78BC (${productId})` };
  }
  const cleanPlatform = String(platform || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const cleanTxRaw = String(transactionId || "").trim();
  if (!cleanTxRaw) {
    return { ok: false, status: 400, error: "\u7F3A\u5C11\u6709\u6548\u4EA4\u6613\u7DE8\u865F (transactionId)" };
  }
  const safeTxHash = cleanTxRaw.length > 96 ? await sha256Hex(cleanTxRaw) : cleanTxRaw;
  const safeTxDocId = `${cleanPlatform}_${safeTxHash}`.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 120);
  const userPath = `users/${encodeURIComponent(uid)}`;
  const userRes = await firestoreGetDoc(userPath, fsAuth.Authorization);
  if (!userRes.exists) {
    return { ok: false, status: 404, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005\u96F2\u7AEF\u8CC7\u6599" };
  }
  const userData = decodeFirestoreDoc(userRes.doc);
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const nowMs = Date.now();
  const existingTxRes = await firestoreGetDoc(`processedTransactions/${encodeURIComponent(safeTxDocId)}`, fsAuth.Authorization);
  if (existingTxRes.exists) {
    const txData = decodeFirestoreDoc(existingTxRes.doc);
    if (txData.uid && txData.uid !== uid) {
      return {
        ok: false,
        status: 409,
        code: "TX_OWNED_BY_OTHER_ACCOUNT",
        error: "\u6B64\u8CFC\u8CB7\u6191\u8B49\u5DF2\u7D81\u5B9A\u65BC\u5176\u4ED6\u5E33\u865F\uFF0C\u7121\u6CD5\u91CD\u8907\u5165\u5E33\u3002"
      };
    }
    return {
      ok: true,
      alreadyProcessed: true,
      transactionId: safeTxDocId,
      orderId: extraMeta.safeOrderDocId || safeTxDocId,
      kind: skuMeta.kind,
      productId,
      coins: Math.max(0, Math.floor(Number(userData.coins) || 0)),
      membership: userData.membership || null,
      membershipHistory: userData.membershipHistory || [],
      cosmetics: userData.cosmetics || null,
      message: "\u6B64\u8A02\u55AE\u5DF2\u5B8C\u6210\u9A57\u8B49\u8207\u767C\u653E\uFF0C\u4E0D\u6703\u91CD\u8907\u5165\u5E33\u3002"
    };
  }
  if (skuMeta.kind === "membership" && !isAdminUser && !extraMeta.skipActiveTierCheck) {
    const mem = userData.membership && typeof userData.membership === "object" ? userData.membership : {};
    const curTier = String(mem.tier || "free");
    const curExpires = Number(mem.expiresAt) || 0;
    const isActivePaid = curTier !== "free" && curExpires > nowMs;
    if (isActivePaid) {
      const curIdx = TIER_ORDER.indexOf(curTier);
      const targetIdx = TIER_ORDER.indexOf(skuMeta.tier);
      if (curIdx >= targetIdx) {
        return {
          ok: false,
          status: 409,
          code: "ACTIVE_HIGHER_OR_SAME_TIER",
          expiresAt: curExpires,
          error: `\u76EE\u524D\u5DF2\u662F\u6709\u6548\u6703\u54E1\uFF08\u5230\u671F\u65E5\uFF1A${formatDateYmd(curExpires)}\uFF09\uFF0C\u7121\u9700\u91CD\u8907\u8CFC\u8CB7\u540C\u7D1A\u6216\u8F03\u4F4E\u65B9\u6848\u3002`
        };
      }
    }
  }
  if (cleanPlatform === "android" && extraMeta.safeOrderDocId) {
    const orderRecord = {
      orderId: extraMeta.safeOrderDocId,
      rawOrderId: extraMeta.rawOrderId || cleanTxRaw,
      uid,
      productId,
      purchaseTokenHash: extraMeta.tokenHash || "",
      packageName: extraMeta.packageName || EXPECTED_PACKAGE_NAME,
      kind: skuMeta.kind,
      coinsGranted: skuMeta.kind === "coins" ? skuMeta.coins : 0,
      tierGranted: skuMeta.kind === "membership" ? skuMeta.tier : "",
      processedAt: nowMs
    };
    const legacyLock = await firestoreCreateDocIfAbsent(
      "processedOrders",
      extraMeta.safeOrderDocId,
      orderRecord,
      fsAuth.Authorization
    );
    if (legacyLock.alreadyExists) {
      return {
        ok: true,
        alreadyProcessed: true,
        orderId: extraMeta.safeOrderDocId,
        transactionId: safeTxDocId,
        coins: Math.max(0, Math.floor(Number(userData.coins) || 0)),
        membership: userData.membership || null,
        message: "\u6B64 Google Play \u8A02\u55AE\u5DF2\u5B8C\u6210\u6838\u92B7\uFF0C\u4E0D\u6703\u91CD\u8907\u767C\u653E\u6216\u6263\u6B3E\u3002"
      };
    }
  }
  const txRecord = {
    txDocId: safeTxDocId,
    transactionId: cleanTxRaw,
    platform: cleanPlatform,
    uid,
    productId,
    kind: skuMeta.kind,
    coinsGranted: skuMeta.kind === "coins" ? skuMeta.coins : 0,
    tierGranted: skuMeta.kind === "membership" ? skuMeta.tier : "",
    environment: String(extraMeta.environment || "Production"),
    processedAt: nowMs
  };
  const lockRes = await firestoreCreateDocIfAbsent("processedTransactions", safeTxDocId, txRecord, fsAuth.Authorization);
  if (lockRes.alreadyExists) {
    return {
      ok: true,
      alreadyProcessed: true,
      transactionId: safeTxDocId,
      orderId: extraMeta.safeOrderDocId || safeTxDocId,
      coins: Math.max(0, Math.floor(Number(userData.coins) || 0)),
      membership: userData.membership || null,
      message: "\u6B64\u4EA4\u6613\u5DF2\u5B8C\u6210\u6838\u92B7\uFF0C\u4E0D\u6703\u91CD\u8907\u5165\u5E33\u3002"
    };
  }
  let updatedPatch = {};
  let updateMasks = [];
  let newCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  let nextMembership = userData.membership && typeof userData.membership === "object" ? { ...userData.membership } : { tier: "free", tierPriceNtd: 0, startedAt: 0, expiresAt: 0, billingCycle: "monthly", totalDonatedNtd: 0, autoDowngradedAt: 0 };
  const sourceLabel = cleanPlatform === "ios" ? "apple_app_store" : cleanPlatform === "web" ? "web_checkout" : "google_play";
  if (skuMeta.kind === "coins") {
    newCoins += skuMeta.coins;
    updatedPatch = { coins: newCoins };
    updateMasks = ["coins"];
  } else {
    const durationMs = skuMeta.days * DAY_MS;
    const baseStart = Number(extraMeta.purchaseDateMs) > 0 ? Number(extraMeta.purchaseDateMs) : nowMs;
    const newExpiresAt = Math.max(nowMs + 6e4, baseStart + durationMs);
    nextMembership = {
      tier: skuMeta.tier,
      tierPriceNtd: skuMeta.priceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: baseStart,
      expiresAt: newExpiresAt,
      totalDonatedNtd: (Number(nextMembership.totalDonatedNtd) || 0) + skuMeta.priceNtd,
      autoDowngradedAt: 0,
      lastOrderId: safeTxDocId
    };
    const history = Array.isArray(userData.membershipHistory) ? [...userData.membershipHistory] : [];
    history.unshift({
      tier: skuMeta.tier,
      priceNtd: skuMeta.priceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: baseStart,
      expiresAt: newExpiresAt,
      source: sourceLabel,
      orderId: safeTxDocId
    });
    const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object" ? { ...userData.cosmetics } : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
    nextCosmetics.frame = skuMeta.frameId;
    nextCosmetics.banner = skuMeta.bannerId;
    nextCosmetics.title = skuMeta.titleId;
    updatedPatch = {
      membership: nextMembership,
      membershipHistory: history.slice(0, 20),
      cosmetics: nextCosmetics
    };
    updateMasks = ["membership", "membershipHistory", "cosmetics"];
  }
  await firestorePatchDoc(userPath, updatedPatch, updateMasks, fsAuth.Authorization);
  return {
    ok: true,
    status: 200,
    alreadyProcessed: false,
    transactionId: safeTxDocId,
    orderId: extraMeta.safeOrderDocId || safeTxDocId,
    kind: skuMeta.kind,
    productId,
    coins: newCoins,
    membership: nextMembership,
    membershipHistory: updatedPatch.membershipHistory || userData.membershipHistory || [],
    cosmetics: updatedPatch.cosmetics || userData.cosmetics || null,
    message: skuMeta.kind === "coins" ? `\u{1F389} \u5132\u503C\u6210\u529F\uFF01\u5DF2\u767C\u653E ${skuMeta.coins} \u91D1\u5E63` : `\u{1F389} \u8CFC\u8CB7\u9A57\u8B49\u6210\u529F\uFF01\u5DF2\u958B\u901A\u300C${skuMeta.title}\u300D`
  };
}
__name(grantVerifiedPurchase, "grantVerifiedPurchase");
async function handleVerifyAndroidPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }, 400, corsHeaders);
  }
  const productId = String(body && body.productId || "").trim();
  const purchaseToken = String(body && body.purchaseToken || "").trim();
  const clientOrderId = String(body && body.orderId || "").trim();
  const packageName = String(body && body.packageName || EXPECTED_PACKAGE_NAME).trim();
  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684\u5546\u54C1\u4EE3\u78BC (Unknown SKU)" }, 400, corsHeaders);
  }
  if (packageName !== EXPECTED_PACKAGE_NAME) {
    return jsonResponse({ ok: false, error: "\u5957\u4EF6\u540D\u7A31\u8207\u61C9\u7528\u7A0B\u5F0F\u4E0D\u76F8\u7B26" }, 403, corsHeaders);
  }
  if (!purchaseToken || purchaseToken.length < 12) {
    return jsonResponse({ ok: false, error: "\u7F3A\u5C11\u6709\u6548\u7684 Google Play \u8CFC\u8CB7\u6191\u8B49 (purchaseToken)" }, 400, corsHeaders);
  }
  const playVerify = await verifyGooglePlayProductReceipt(env, {
    packageName,
    productId,
    purchaseToken,
    isSubscription: false
  });
  if (!playVerify.ok) {
    return jsonResponse({ ok: false, code: playVerify.code, error: playVerify.error }, playVerify.status || 400, corsHeaders);
  }
  const tokenHash = await sha256Hex(purchaseToken);
  const rawOrderId = playVerify.orderId || clientOrderId || `tok_${tokenHash.slice(0, 32)}`;
  const safeOrderDocId = rawOrderId.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 120);
  const grantRes = await grantVerifiedPurchase(
    auth.uid,
    productId,
    rawOrderId,
    "android",
    {
      safeOrderDocId,
      rawOrderId,
      tokenHash,
      packageName
    },
    env,
    auth.fsAuth
  );
  if (!grantRes.ok) {
    return jsonResponse(grantRes, grantRes.status || 400, corsHeaders);
  }
  if (!grantRes.alreadyProcessed) {
    await consumeOrAckGooglePlayPurchase(env, {
      packageName,
      productId,
      purchaseToken,
      consumable: Boolean(skuMeta.consumable)
    });
  }
  return jsonResponse(grantRes, 200, corsHeaders);
}
__name(handleVerifyAndroidPurchase, "handleVerifyAndroidPurchase");
function base64UrlToUint8Array(b64u) {
  const b64 = String(b64u || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - b64.length % 4);
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
__name(base64UrlToUint8Array, "base64UrlToUint8Array");
function base64ToArrayBuffer(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
__name(base64ToArrayBuffer, "base64ToArrayBuffer");
function extractSpkiFromX509Der(derBytes) {
  const bytes = derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes);
  const ecOid = [6, 7, 42, 134, 72, 206, 61, 2, 1];
  for (let i = 4; i < bytes.length - ecOid.length - 12; i++) {
    let match = true;
    for (let j = 0; j < ecOid.length; j++) {
      if (bytes[i + j] !== ecOid[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
      if (bytes[k] === 48) {
        const lenByte = bytes[k + 1];
        let totalLen = 0;
        let headerLen = 2;
        if (lenByte < 128) {
          totalLen = lenByte;
        } else if (lenByte === 129) {
          totalLen = bytes[k + 2];
          headerLen = 3;
        } else if (lenByte === 130) {
          totalLen = bytes[k + 2] << 8 | bytes[k + 3];
          headerLen = 4;
        }
        if (totalLen > 40 && totalLen < 160 && k + headerLen + totalLen <= bytes.length) {
          if (bytes[k + headerLen] === 48) {
            return bytes.slice(k, k + headerLen + totalLen).buffer;
          }
        }
      }
    }
  }
  return null;
}
__name(extractSpkiFromX509Der, "extractSpkiFromX509Der");
async function decodeAndVerifyAppleJws(jwsToken, expectedBundleId) {
  const parts = String(jwsToken || "").trim().split(".");
  if (parts.length !== 3) return { ok: false, error: "Apple JWS \u683C\u5F0F\u932F\u8AA4" };
  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[1])));
  } catch (e) {
    return { ok: false, error: "\u7121\u6CD5\u89E3\u6790 Apple JWS \u5167\u5BB9" };
  }
  if (header && header.alg === "ES256" && Array.isArray(header.x5c) && header.x5c.length > 0) {
    try {
      const leafDer = base64ToArrayBuffer(header.x5c[0]);
      const spki = extractSpkiFromX509Der(leafDer);
      if (spki) {
        const key = await crypto.subtle.importKey(
          "spki",
          spki,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"]
        );
        const sigBytes = base64UrlToUint8Array(parts[2]);
        const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const sigValid = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          sigBytes,
          dataBytes
        );
        if (!sigValid) {
          return { ok: false, error: "Apple JWS \u7C3D\u7AE0\u9A57\u8B49\u5931\u6557" };
        }
      }
    } catch (e) {
      return { ok: false, error: `Apple JWS \u6191\u8B49\u9A57\u8B49\u5931\u6557: ${e.message}` };
    }
  }
  if (expectedBundleId && payload.bundleId && payload.bundleId !== expectedBundleId) {
    return { ok: false, error: "Apple \u8CFC\u8CB7\u6191\u8B49 Bundle ID \u4E0D\u7B26" };
  }
  if (payload.revocationDate) {
    return { ok: false, error: "\u6B64 Apple \u4EA4\u6613\u5DF2\u9000\u6B3E\u6216\u64A4\u92B7" };
  }
  return {
    ok: true,
    transactions: [
      {
        productId: String(payload.productId || "").trim(),
        transactionId: String(payload.transactionId || payload.originalTransactionId || "").trim(),
        originalTransactionId: String(payload.originalTransactionId || "").trim(),
        purchaseDateMs: Number(payload.purchaseDate) || Date.now(),
        environment: String(payload.environment || "Production")
      }
    ]
  };
}
__name(decodeAndVerifyAppleJws, "decodeAndVerifyAppleJws");
async function verifyAppleReceiptLegacy(receiptData, env, expectedBundleId) {
  const sharedSecret = String(env.APPLE_SHARED_SECRET || "").trim();
  const reqBody = {
    "receipt-data": receiptData,
    "exclude-old-transactions": true
  };
  if (sharedSecret) {
    reqBody.password = sharedSecret;
  }
  const postVerify = /* @__PURE__ */ __name(async (endpoint) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      throw new Error(`Apple verifyReceipt HTTP ${res.status}`);
    }
    return await res.json();
  }, "postVerify");
  let data = await postVerify(APPLE_VERIFY_RECEIPT_PROD);
  let environment = "Production";
  if (Number(data && data.status) === 21007) {
    data = await postVerify(APPLE_VERIFY_RECEIPT_SANDBOX);
    environment = "Sandbox";
  }
  if (!data || Number(data.status) !== 0) {
    return {
      ok: false,
      status: 400,
      error: `Apple \u6536\u64DA\u9A57\u8B49\u5931\u6557 (status=${data ? data.status : "unknown"})`
    };
  }
  const bundleId = String(data.receipt && data.receipt.bundle_id || "").trim();
  if (expectedBundleId && bundleId && bundleId !== expectedBundleId) {
    return { ok: false, status: 403, error: "Apple \u6536\u64DA Bundle ID \u8207\u61C9\u7528\u7A0B\u5F0F\u4E0D\u7B26" };
  }
  const inAppList = [
    ...Array.isArray(data.latest_receipt_info) ? data.latest_receipt_info : [],
    ...Array.isArray(data.receipt && data.receipt.in_app) ? data.receipt.in_app : []
  ];
  const validTxs = [];
  const seenIds = /* @__PURE__ */ new Set();
  for (const item of inAppList) {
    if (!item || item.cancellation_date_ms || item.cancellation_date) continue;
    const pid = String(item.product_id || "").trim();
    const txId = String(item.transaction_id || item.original_transaction_id || "").trim();
    if (!pid || !txId || !BILLING_SKU_CATALOG[pid]) continue;
    if (seenIds.has(txId)) continue;
    seenIds.add(txId);
    validTxs.push({
      productId: pid,
      transactionId: txId,
      originalTransactionId: String(item.original_transaction_id || "").trim(),
      purchaseDateMs: Number(item.purchase_date_ms) || Date.now(),
      environment
    });
  }
  if (validTxs.length === 0) {
    return { ok: false, status: 400, error: "Apple \u6536\u64DA\u4E2D\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u5546\u54C1\u4EA4\u6613\u9805\u76EE" };
  }
  return { ok: true, environment, transactions: validTxs };
}
__name(verifyAppleReceiptLegacy, "verifyAppleReceiptLegacy");
async function handleVerifyIosPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }, 400, corsHeaders);
  }
  const productId = String(body && body.productId || "").trim();
  const transactionId = String(body && body.transactionId || "").trim();
  const receipt = String(body && (body.receipt || body.appStoreReceipt || body.jwsRepresentation) || "").trim();
  const isRestore = Boolean(body && body.restore);
  const expectedBundleId = String(env.APPLE_BUNDLE_ID || EXPECTED_PACKAGE_NAME).trim();
  if (!receipt && !transactionId) {
    return jsonResponse({ ok: false, error: "\u7F3A\u5C11 Apple StoreKit \u8CFC\u8CB7\u6536\u64DA (receipt) \u6216\u4EA4\u6613\u7DE8\u865F" }, 400, corsHeaders);
  }
  let verifiedTxs = [];
  if (receipt && receipt.split(".").length === 3 && receipt.startsWith("eyJ")) {
    const jwsRes = await decodeAndVerifyAppleJws(receipt, expectedBundleId);
    if (!jwsRes.ok) {
      return jsonResponse({ ok: false, error: jwsRes.error }, 400, corsHeaders);
    }
    verifiedTxs = jwsRes.transactions;
  } else if (receipt) {
    if (!env.APPLE_SHARED_SECRET) {
      return jsonResponse(
        {
          ok: false,
          code: "APPLE_SECRET_NOT_CONFIGURED",
          error: "\u4F3A\u670D\u5668\u5C1A\u672A\u8A2D\u5B9A APPLE_SHARED_SECRET\uFF0C\u7121\u6CD5\u5411 Apple verifyReceipt \u9032\u884C\u6536\u64DA\u9A57\u8B49\u3002"
        },
        503,
        corsHeaders
      );
    }
    const legacyRes = await verifyAppleReceiptLegacy(receipt, env, expectedBundleId);
    if (!legacyRes.ok) {
      return jsonResponse({ ok: false, error: legacyRes.error }, legacyRes.status || 400, corsHeaders);
    }
    verifiedTxs = legacyRes.transactions;
  } else {
    return jsonResponse({ ok: false, error: "\u7F3A\u5C11\u53EF\u9A57\u8B49\u7684 Apple \u6536\u64DA\u8CC7\u6599" }, 400, corsHeaders);
  }
  if (productId && !isRestore) {
    const filtered = verifiedTxs.filter(
      (tx) => tx.productId === productId && (!transactionId || tx.transactionId === transactionId || tx.originalTransactionId === transactionId)
    );
    if (filtered.length > 0) {
      verifiedTxs = [filtered[0]];
    } else if (!BILLING_SKU_CATALOG[productId]) {
      return jsonResponse({ ok: false, error: "\u7121\u6548\u7684\u5546\u54C1\u4EE3\u78BC (Unknown SKU)" }, 400, corsHeaders);
    }
  }
  let lastGrant = null;
  let restoredCount = 0;
  for (const tx of verifiedTxs) {
    if (!BILLING_SKU_CATALOG[tx.productId]) continue;
    const grantRes = await grantVerifiedPurchase(
      auth.uid,
      tx.productId,
      tx.transactionId,
      "ios",
      {
        environment: tx.environment,
        purchaseDateMs: tx.purchaseDateMs,
        skipActiveTierCheck: isRestore
      },
      env,
      auth.fsAuth
    );
    if (grantRes.ok) {
      lastGrant = grantRes;
      if (!grantRes.alreadyProcessed) restoredCount += 1;
    } else if (!isRestore) {
      return jsonResponse(grantRes, grantRes.status || 400, corsHeaders);
    }
  }
  if (!lastGrant) {
    return jsonResponse({ ok: false, error: "\u627E\u4E0D\u5230\u53EF\u6838\u92B7\u7684 App Store \u5546\u54C1\u4EA4\u6613" }, 400, corsHeaders);
  }
  return jsonResponse({ ...lastGrant, restoredCount }, 200, corsHeaders);
}
__name(handleVerifyIosPurchase, "handleVerifyIosPurchase");
async function computeHmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(computeHmacSha256Hex, "computeHmacSha256Hex");
async function handleWebCheckout(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }, 400, corsHeaders);
  }
  const productId = String(body && body.productId || "").trim();
  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684\u5546\u54C1\u4EE3\u78BC (Unknown SKU)" }, 400, corsHeaders);
  }
  if (env.STRIPE_SECRET_KEY) {
    try {
      const returnUrl = String(body && body.returnUrl || "https://flashcards-5f514.web.app").split("#")[0];
      const sep = returnUrl.includes("?") ? "&" : "?";
      const params = new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": "twd",
        "line_items[0][price_data][product_data][name]": skuMeta.title,
        "line_items[0][price_data][unit_amount]": String(skuMeta.priceNtd * 100),
        "line_items[0][quantity]": "1",
        success_url: `${returnUrl}${sep}web_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}${sep}web_checkout=cancel`,
        "metadata[uid]": auth.uid,
        "metadata[productId]": productId
      });
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });
      const session = await stripeRes.json();
      if (stripeRes.ok && session && session.url) {
        return jsonResponse({ ok: true, checkoutUrl: session.url, sessionId: session.id }, 200, corsHeaders);
      }
    } catch (e) {
    }
  }
  return jsonResponse(
    {
      ok: false,
      code: "WEB_CHECKOUT_MAINTENANCE",
      error: "\u7DB2\u9801\u7248\u7DDA\u4E0A\u91D1\u6D41\u7DAD\u8B77\u4E2D\uFF0C\u8ACB\u4F7F\u7528 Android \u6216 iOS App \u5167\u8CFC\u5132\u503C\uFF0C\u6216\u65BC\u8A2D\u5B9A\u9801\u586B\u5165\u500B\u4EBA API Key\uFF08BYOK\uFF09"
    },
    503,
    corsHeaders
  );
}
__name(handleWebCheckout, "handleWebCheckout");
async function handleVerifyWebPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }, 400, corsHeaders);
  }
  const sessionId = String(body && body.sessionId || "").trim();
  if (sessionId && env.STRIPE_SECRET_KEY) {
    const sRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    if (!sRes.ok) {
      return jsonResponse({ ok: false, error: "\u7121\u6CD5\u67E5\u8A62\u7DB2\u9801\u7D50\u5E33\u8A02\u55AE\u72C0\u614B" }, 400, corsHeaders);
    }
    const session = await sRes.json();
    if (session.payment_status !== "paid") {
      return jsonResponse({ ok: false, error: "\u6B64\u7DB2\u9801\u8A02\u55AE\u5C1A\u672A\u5B8C\u6210\u4ED8\u6B3E" }, 402, corsHeaders);
    }
    const metaUid = String(session.metadata && session.metadata.uid || "").trim();
    const metaProductId = String(session.metadata && session.metadata.productId || "").trim();
    if (metaUid && metaUid !== auth.uid) {
      return jsonResponse({ ok: false, error: "\u8A02\u55AE\u6240\u5C6C\u5E33\u865F\u8207\u76EE\u524D\u767B\u5165\u8005\u4E0D\u7B26" }, 403, corsHeaders);
    }
    const grantRes2 = await grantVerifiedPurchase(
      auth.uid,
      metaProductId,
      session.payment_intent || session.id,
      "web",
      { environment: "WebStripe" },
      env,
      auth.fsAuth
    );
    return jsonResponse(grantRes2, grantRes2.status || 200, corsHeaders);
  }
  const productId = String(body && body.productId || "").trim();
  const transactionId = String(body && body.transactionId || "").trim();
  const signature = String(body && body.signature || "").trim();
  const secret = String(env.WEB_CHECKOUT_SECRET || "").trim();
  if (!secret || !productId || !transactionId || !signature) {
    return jsonResponse(
      { ok: false, error: "\u7DB2\u9801\u7248\u7DDA\u4E0A\u91D1\u6D41\u5C1A\u672A\u8A2D\u5B9A\u5B8C\u6210\u6216\u7F3A\u5C11\u6709\u6548\u9A57\u7C3D\u6191\u8B49" },
      503,
      corsHeaders
    );
  }
  const expectedSig = await computeHmacSha256Hex(secret, `${auth.uid}:${productId}:${transactionId}`);
  if (expectedSig.toLowerCase() !== signature.toLowerCase()) {
    return jsonResponse({ ok: false, error: "\u7DB2\u9801\u4EA4\u6613\u7C3D\u7AE0\u9A57\u8B49\u5931\u6557" }, 403, corsHeaders);
  }
  const grantRes = await grantVerifiedPurchase(
    auth.uid,
    productId,
    transactionId,
    "web",
    { environment: "WebHmac" },
    env,
    auth.fsAuth
  );
  return jsonResponse(grantRes, grantRes.status || 200, corsHeaders);
}
__name(handleVerifyWebPurchase, "handleVerifyWebPurchase");

// src/shopHandler.js
var DAY_MS2 = 24 * 60 * 60 * 1e3;
var STREAK_SHIELD_COST = 80;
var STREAK_SHIELD_MAX = 3;
var COIN_REDEEM_PACKS = {
  pack_ai_text: {
    id: "pack_ai_text",
    name: "AI \u55AE\u5B57\u586B\u88DC + \u6587\u7AE0\u751F\u6210\u88DC\u5145\u5305",
    costCoins: 60,
    credits: { def_fill: 15, article_gen: 3, vision_ocr: 0, fast_refine: 0 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 0,
    fullMembershipTier: ""
  },
  pack_ai_vision: {
    id: "pack_ai_vision",
    name: "AI \u62CD\u7167 OCR + \u5B57\u5E55\u7CBE\u4FEE\u88DC\u5145\u5305",
    costCoins: 120,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 15, fast_refine: 150 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 0,
    fullMembershipTier: ""
  },
  pack_trial_starter_7d: {
    id: "pack_trial_starter_7d",
    name: "7 \u5929 Starter \u5165\u9580\u6703\u54E1\u9AD4\u9A57\u5361",
    costCoins: 80,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 7,
    trialTier: "supporter_30",
    fullMembershipDays: 0,
    fullMembershipTier: ""
  },
  redeem_starter_30d: {
    id: "redeem_starter_30d",
    name: "30 \u5929 Starter \u5165\u9580\u6703\u54E1",
    costCoins: 160,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 30,
    fullMembershipTier: "supporter_30",
    priceNtdValue: 39,
    frameId: "supporter_warm_amber",
    bannerId: "supporter_warm_horizon",
    titleId: "supporter_coffee"
  },
  redeem_plus_30d: {
    id: "redeem_plus_30d",
    name: "30 \u5929 Plus \u9032\u968E\u6703\u54E1",
    costCoins: 400,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 30,
    fullMembershipTier: "supporter_90",
    priceNtdValue: 99,
    frameId: "supporter_sapphire_aura",
    bannerId: "supporter_aurora_palace",
    titleId: "supporter_diamond"
  },
  redeem_pro_30d: {
    id: "redeem_pro_30d",
    name: "30 \u5929 Pro \u5C08\u696D\u6703\u54E1",
    costCoins: 800,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 30,
    fullMembershipTier: "supporter_180",
    priceNtdValue: 199,
    frameId: "supporter_celestial_crown",
    bannerId: "supporter_imperial_aurora",
    titleId: "supporter_crown"
  }
};
var PAID_COSMETICS_CATALOG = {
  "frames:paid_gold_dragon": {
    type: "frames",
    id: "paid_gold_dragon",
    name: "\u91D1\u9F8D\u8056\u74B0",
    coinPrice: 80
  },
  "frames:paid_nebula_prism": {
    type: "frames",
    id: "paid_nebula_prism",
    name: "\u661F\u96F2\u7A1C\u93E1",
    coinPrice: 120
  },
  "frames:paid_jade_emperor": {
    type: "frames",
    id: "paid_jade_emperor",
    name: "\u7FE1\u7FE0\u5E1D\u51A0",
    coinPrice: 160
  },
  "banners:paid_cyber_tokyo": {
    type: "banners",
    id: "paid_cyber_tokyo",
    name: "\u8CFD\u535A\u6771\u4EAC\u591C",
    coinPrice: 100
  },
  "banners:paid_golden_sanctuary": {
    type: "banners",
    id: "paid_golden_sanctuary",
    name: "\u9EC3\u91D1\u8056\u6BBF",
    coinPrice: 150
  },
  "banners:paid_celestial_eclipse": {
    type: "banners",
    id: "paid_celestial_eclipse",
    name: "\u5929\u7A79\u65E5\u8755",
    coinPrice: 200
  },
  "titles:paid_vocab_tycoon": {
    type: "titles",
    id: "paid_vocab_tycoon",
    name: "\u8A5E\u5F59\u5927\u4EA8",
    coinPrice: 80
  },
  "titles:paid_polyglot_legend": {
    type: "titles",
    id: "paid_polyglot_legend",
    name: "\u591A\u8A9E\u50B3\u5947",
    coinPrice: 150
  }
};
function formatDateYmd2(ts) {
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1e3);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
__name(formatDateYmd2, "formatDateYmd");
async function handleBuyDeck(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ error: "\u672A\u6388\u6B0A\u8ACB\u6C42\uFF0C\u7F3A\u5C11\u8EAB\u4EFD\u6191\u8B49 Token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const buyerUid = verified.uid;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const normalizedDeckId = String(body && body.deckId || "").trim();
  if (!normalizedDeckId) {
    return new Response(
      JSON.stringify({ error: "\u7F3A\u5C11\u5546\u54C1\u5B57\u5EAB ID" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const deckRes = await firestoreGetDoc(`storeDecks/${encodeURIComponent(normalizedDeckId)}`, authHeader);
  if (!deckRes.exists) {
    return new Response(
      JSON.stringify({ error: "\u627E\u4E0D\u5230\u8A72\u5546\u57CE\u5B57\u5EAB" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const deckData = decodeFirestoreDoc(deckRes.doc);
  const price = Math.max(0, Math.floor(Number(deckData.price) || 0));
  const authorId = String(deckData.authorId || "").trim();
  const buyerPath = `users/${encodeURIComponent(buyerUid)}`;
  const buyerRes = await firestoreGetDoc(buyerPath, authHeader);
  if (!buyerRes.exists) {
    return new Response(
      JSON.stringify({ error: "\u627E\u4E0D\u5230\u8CB7\u5BB6\u4F7F\u7528\u8005\u8CC7\u6599" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const buyerData = decodeFirestoreDoc(buyerRes.doc);
  const isAdminUser = isUserAdminFromFields(buyerRes.doc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(buyerData.coins) || 0));
  const purchasedIds = Array.isArray(buyerData.purchasedDeckIds) ? buyerData.purchasedDeckIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (purchasedIds.includes(normalizedDeckId)) {
    return new Response(
      JSON.stringify({
        success: true,
        alreadyPurchased: true,
        newCoins: currentCoins,
        message: "\u60A8\u5DF2\u8CFC\u8CB7\u904E\u6B64\u5B57\u5EAB\uFF0C\u672C\u6B21\u514D\u8CBB\u91CD\u65B0\u53D6\u5F97"
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const effectiveCharge = isAdminUser || authorId === buyerUid ? 0 : price;
  if (currentCoins < effectiveCharge) {
    return new Response(
      JSON.stringify({ error: `\u91D1\u5E63\u4E0D\u8DB3\uFF01\u8CFC\u8CB7\u9700\u8981 ${effectiveCharge} \u91D1\u5E63\uFF0C\u60A8\u76EE\u524D\u53EA\u6709 ${currentCoins} \u91D1\u5E63` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const newBuyerCoins = currentCoins - effectiveCharge;
  const sellerEarnings = Math.floor(effectiveCharge * 0.7);
  const nextPurchasedIds = Array.from(/* @__PURE__ */ new Set([...purchasedIds, normalizedDeckId]));
  try {
    await firestorePatchDoc(
      buyerPath,
      { coins: newBuyerCoins, purchasedDeckIds: nextPurchasedIds },
      ["coins", "purchasedDeckIds"],
      authHeader
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "\u4F3A\u670D\u5668\u91D1\u5E63\u6263\u6B3E\u5931\u6557\uFF0C\u8ACB\u78BA\u8A8D\u5DF2\u8A2D\u5B9A\u7BA1\u7406\u54E1\u670D\u52D9\u5E33\u865F\u6191\u8B49" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  try {
    await firestorePatchDoc(
      `storeDecks/${encodeURIComponent(normalizedDeckId)}/purchasers/${encodeURIComponent(buyerUid)}`,
      { uid: buyerUid, price: effectiveCharge, purchasedAtMs: Date.now() },
      ["uid", "price", "purchasedAtMs"],
      authHeader
    );
  } catch (e) {
  }
  if (authorId && authorId !== buyerUid && sellerEarnings > 0) {
    try {
      const sellerPath = `users/${encodeURIComponent(authorId)}`;
      const sellerRes = await firestoreGetDoc(sellerPath, authHeader);
      if (sellerRes.exists) {
        const sellerData = decodeFirestoreDoc(sellerRes.doc);
        const sellerCurrentCoins = Math.max(0, Math.floor(Number(sellerData.coins) || 0));
        await firestorePatchDoc(
          sellerPath,
          { coins: sellerCurrentCoins + sellerEarnings },
          ["coins"],
          authHeader
        );
      }
    } catch (e) {
      console.warn("\u5283\u8F49\u8CE3\u5BB6\u6536\u76CA\u5931\u6557:", e.message);
    }
  }
  return new Response(
    JSON.stringify({
      success: true,
      alreadyPurchased: false,
      newCoins: newBuyerCoins,
      charged: effectiveCharge,
      message: isAdminUser ? "\u7BA1\u7406\u54E1\u7279\u6B0A\uFF1A\u5DF2\u514D\u8CBB\u89E3\u9396\u6B64\u5B57\u5EAB" : `\u4EA4\u6613\u6210\u529F\uFF01\u6263\u9664 ${effectiveCharge} \u91D1\u5E63`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleBuyDeck, "handleBuyDeck");
async function handleRedeemCoinsForQuota(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8ACB\u5148\u4F7F\u7528 Google \u5E33\u865F\u767B\u5165\u5F8C\u518D\u9032\u884C\u91D1\u5E63\u514C\u63DB" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42\u5167\u5BB9" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const packId = String(body && body.packId || "").trim();
  const pack = COIN_REDEEM_PACKS[packId];
  if (!pack) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7121\u6548\u7684\u514C\u63DB\u65B9\u6848\u4EE3\u78BC" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005\u96F2\u7AEF\u8CC7\u6599" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userDoc = userRes.doc;
  const userData = decodeFirestoreDoc(userDoc);
  const isAdminUser = isUserAdminFromFields(userDoc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const nowMs = Date.now();
  if (pack.fullMembershipDays > 0 && pack.fullMembershipTier && !isAdminUser) {
    const mem = userData.membership && typeof userData.membership === "object" ? userData.membership : {};
    const curTier = String(mem.tier || "free");
    const curExp = Number(mem.expiresAt) || 0;
    if (curTier !== "free" && curExp > nowMs) {
      const curIdx = TIER_ORDER.indexOf(curTier);
      const targetIdx = TIER_ORDER.indexOf(pack.fullMembershipTier);
      if (curIdx >= targetIdx) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: "ACTIVE_HIGHER_OR_SAME_TIER",
            error: `\u76EE\u524D\u5DF2\u662F\u6709\u6548\u6703\u54E1\uFF08\u5230\u671F\u65E5\uFF1A${formatDateYmd2(curExp)}\uFF09\uFF0C\u7121\u9700\u91CD\u8907\u514C\u63DB\u540C\u7D1A\u6216\u8F03\u4F4E\u65B9\u6848\u3002`
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  }
  const effectiveCost = isAdminUser ? 0 : pack.costCoins;
  if (currentCoins < effectiveCost) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `\u5546\u5E97\u91D1\u5E63\u4E0D\u8DB3\uFF01\u9700\u8981 ${effectiveCost} \u91D1\u5E63\uFF0C\u60A8\u76EE\u524D\u5171\u6709 ${currentCoins} \u91D1\u5E63`
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const newCoins = currentCoins - effectiveCost;
  if (pack.fullMembershipDays > 0 && pack.fullMembershipTier) {
    const newExpiresAt = nowMs + pack.fullMembershipDays * DAY_MS2;
    const prevMem = userData.membership && typeof userData.membership === "object" ? userData.membership : {};
    const nextMembership = {
      tier: pack.fullMembershipTier,
      tierPriceNtd: pack.priceNtdValue || 0,
      billingCycle: "monthly",
      startedAt: nowMs,
      expiresAt: newExpiresAt,
      totalDonatedNtd: Number(prevMem.totalDonatedNtd) || 0,
      autoDowngradedAt: 0,
      source: "coin_redeem"
    };
    const history = Array.isArray(userData.membershipHistory) ? [...userData.membershipHistory] : [];
    history.unshift({
      tier: pack.fullMembershipTier,
      priceNtd: 0,
      coinsSpent: effectiveCost,
      billingCycle: "monthly",
      startedAt: nowMs,
      expiresAt: newExpiresAt,
      source: "coin_redeem"
    });
    const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object" ? { ...userData.cosmetics } : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
    if (pack.frameId) nextCosmetics.frame = pack.frameId;
    if (pack.bannerId) nextCosmetics.banner = pack.bannerId;
    if (pack.titleId) nextCosmetics.title = pack.titleId;
    const updatedDoc2 = await firestorePatchDoc(
      userPath,
      {
        coins: newCoins,
        membership: nextMembership,
        membershipHistory: history.slice(0, 20),
        cosmetics: nextCosmetics
      },
      ["coins", "membership", "membershipHistory", "cosmetics"],
      authHeader
    );
    const nextQuota2 = buildQuotaSnapshotPayload(parseUserQuotaState(updatedDoc2, nowMs));
    return new Response(
      JSON.stringify({
        ok: true,
        packId: pack.id,
        packName: pack.name,
        newCoins,
        membership: nextMembership,
        membershipHistory: history.slice(0, 20),
        cosmetics: nextCosmetics,
        quota: nextQuota2,
        message: `\u{1F389} \u6210\u529F\u4EE5\u91D1\u5E63\u514C\u63DB\u300C${pack.name}\u300D\uFF01`
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const boost = userData.coinBoost && typeof userData.coinBoost === "object" ? userData.coinBoost : {};
  const existingCredits = boost.credits && typeof boost.credits === "object" ? boost.credits : {};
  const nextCredits = {};
  for (const f of VALID_FEATURES) {
    nextCredits[f] = Math.max(0, Math.floor(Number(existingCredits[f]) || 0)) + (pack.credits[f] || 0);
  }
  let nextTrialTier = String(boost.trialTier || "free");
  let nextTrialExpiresAt = Math.max(0, Number(boost.trialExpiresAt) || 0);
  if (nextTrialExpiresAt <= nowMs) {
    nextTrialTier = "free";
    nextTrialExpiresAt = 0;
  }
  if (pack.trialDays > 0 && pack.trialTier) {
    const addMs = pack.trialDays * DAY_MS2;
    const baseTime = nextTrialExpiresAt > nowMs ? nextTrialExpiresAt : nowMs;
    nextTrialTier = pack.trialTier;
    nextTrialExpiresAt = baseTime + addMs;
  }
  const nextCoinBoost = {
    trialTier: nextTrialTier || "free",
    trialExpiresAt: nextTrialExpiresAt || 0,
    credits: nextCredits,
    lastRedeemedAt: nowMs
  };
  const updatedDoc = await firestorePatchDoc(
    userPath,
    { coins: newCoins, coinBoost: nextCoinBoost },
    ["coins", "coinBoost"],
    authHeader
  );
  const nextQuota = buildQuotaSnapshotPayload(parseUserQuotaState(updatedDoc, nowMs));
  return new Response(
    JSON.stringify({
      ok: true,
      packId: pack.id,
      packName: pack.name,
      newCoins,
      coinBoost: nextCoinBoost,
      quota: nextQuota,
      message: `\u{1F389} \u6210\u529F\u514C\u63DB\u300C${pack.name}\u300D\uFF01`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleRedeemCoinsForQuota, "handleRedeemCoinsForQuota");
async function handleBuyCosmetic(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8ACB\u5148\u767B\u5165\u5E33\u865F\u518D\u8CFC\u8CB7\u5C08\u5C6C\u5916\u89C0" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u7121\u6548\u7684 JSON \u8ACB\u6C42" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const type = String(body && body.type || "").trim();
  const id = String(body && body.id || "").trim();
  const catalogKey = `${type}:${id}`;
  const item = PAID_COSMETICS_CATALOG[catalogKey];
  if (!item) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u627E\u4E0D\u5230\u8A72\u4ED8\u8CBB\u5916\u89C0\u5546\u54C1" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005\u96F2\u7AEF\u8CC7\u6599" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userData = decodeFirestoreDoc(userRes.doc);
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const purchasedCosmetics = Array.isArray(userData.purchasedCosmetics) ? userData.purchasedCosmetics.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (purchasedCosmetics.includes(catalogKey)) {
    return new Response(
      JSON.stringify({
        ok: true,
        alreadyOwned: true,
        newCoins: currentCoins,
        purchasedCosmetics,
        cosmetics: userData.cosmetics || null,
        message: "\u60A8\u5DF2\u64C1\u6709\u6B64\u9650\u5B9A\u5916\u89C0\uFF0C\u5DF2\u53EF\u76F4\u63A5\u88DD\u5099\uFF01"
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const cost = isAdminUser ? 0 : item.coinPrice;
  if (currentCoins < cost) {
    return new Response(
      JSON.stringify({ ok: false, error: `\u91D1\u5E63\u4E0D\u8DB3\uFF01\u9700\u8981 ${cost} \u91D1\u5E63\uFF0C\u76EE\u524D\u50C5\u6709 ${currentCoins} \u91D1\u5E63` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const newCoins = currentCoins - cost;
  const nextPurchasedCosmetics = Array.from(/* @__PURE__ */ new Set([...purchasedCosmetics, catalogKey]));
  const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object" ? { ...userData.cosmetics } : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
  if (item.type === "frames") {
    const arr = Array.isArray(nextCosmetics.unlockedFrames) ? [...nextCosmetics.unlockedFrames] : [];
    if (!arr.includes(item.id)) arr.push(item.id);
    nextCosmetics.unlockedFrames = arr;
    nextCosmetics.frame = item.id;
  } else if (item.type === "banners") {
    const arr = Array.isArray(nextCosmetics.unlockedBanners) ? [...nextCosmetics.unlockedBanners] : [];
    if (!arr.includes(item.id)) arr.push(item.id);
    nextCosmetics.unlockedBanners = arr;
    nextCosmetics.banner = item.id;
  } else if (item.type === "titles") {
    const arr = Array.isArray(nextCosmetics.unlockedTitles) ? [...nextCosmetics.unlockedTitles] : [];
    if (!arr.includes(item.id)) arr.push(item.id);
    nextCosmetics.unlockedTitles = arr;
    nextCosmetics.title = item.id;
  }
  await firestorePatchDoc(
    userPath,
    {
      coins: newCoins,
      purchasedCosmetics: nextPurchasedCosmetics,
      cosmetics: nextCosmetics
    },
    ["coins", "purchasedCosmetics", "cosmetics"],
    authHeader
  );
  return new Response(
    JSON.stringify({
      ok: true,
      alreadyOwned: false,
      type: item.type,
      id: item.id,
      newCoins,
      purchasedCosmetics: nextPurchasedCosmetics,
      cosmetics: nextCosmetics,
      message: isAdminUser ? `\u7BA1\u7406\u54E1\u7279\u6B0A\uFF1A\u5DF2\u514D\u8CBB\u89E3\u9396\u4E26\u88DD\u5099\u300C${item.name}\u300D\uFF01` : `\u{1F389} \u6210\u529F\u8CFC\u8CB7\u4E26\u88DD\u5099\u300C${item.name}\u300D\uFF01`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleBuyCosmetic, "handleBuyCosmetic");
async function handleBuyStreakShield(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8ACB\u5148\u767B\u5165\u5E33\u865F\u518D\u8CFC\u8CB7\u9023\u52DD\u8B77\u76FE" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u8EAB\u4EFD\u6191\u8B49\u7121\u6548\u6216\u5DF2\u904E\u671F" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005\u8CC7\u6599" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userData = decodeFirestoreDoc(userRes.doc);
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const progression = userData.progression && typeof userData.progression === "object" ? { ...userData.progression } : { xp: 0, level: 1, streakDays: 0, streakShields: 0, lastActiveDate: "", rankTier: "\u9752\u9285 III", rankPoints: 0, duelWins: 0, duelTotal: 0 };
  const currentShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Math.floor(Number(progression.streakShields) || 0)));
  if (currentShields >= STREAK_SHIELD_MAX) {
    return new Response(
      JSON.stringify({ ok: false, error: `\u9023\u52DD\u51B7\u51CD\u8B77\u76FE\u5DF2\u9054\u4E0A\u9650\uFF08\u6700\u591A ${STREAK_SHIELD_MAX} \u500B\uFF09` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const cost = isAdminUser ? 0 : STREAK_SHIELD_COST;
  if (currentCoins < cost) {
    return new Response(
      JSON.stringify({ ok: false, error: `\u91D1\u5E63\u4E0D\u8DB3\uFF01\u9700\u8981 ${cost} \u91D1\u5E63\uFF0C\u76EE\u524D\u50C5\u6709 ${currentCoins} \u91D1\u5E63` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const newCoins = currentCoins - cost;
  progression.streakShields = currentShields + 1;
  await firestorePatchDoc(
    userPath,
    { coins: newCoins, progression },
    ["coins", "progression"],
    authHeader
  );
  return new Response(
    JSON.stringify({
      ok: true,
      newCoins,
      streakShields: progression.streakShields,
      message: `\u{1F6E1}\uFE0F \u6210\u529F\u8CFC\u8CB7\u9023\u52DD\u51B7\u51CD\u8B77\u76FE\uFF01\uFF08\u76EE\u524D\u6301\u6709 ${progression.streakShields}/${STREAK_SHIELD_MAX} \u500B\uFF09`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
__name(handleBuyStreakShield, "handleBuyStreakShield");

// src/youtubeHandler.js
function decodeHtmlEntities(str) {
  return String(str || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 32)).replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16) || 32));
}
__name(decodeHtmlEntities, "decodeHtmlEntities");
function cleanCueText(raw) {
  return decodeHtmlEntities(String(raw || "").replace(/<[^>]+>/g, " ")).replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}
__name(cleanCueText, "cleanCueText");
function extractBalancedJsonObject(text, startToken) {
  const tokenIdx = text.indexOf(startToken);
  if (tokenIdx < 0) return null;
  const braceStart = text.indexOf("{", tokenIdx + startToken.length);
  if (braceStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(braceStart, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}
__name(extractBalancedJsonObject, "extractBalancedJsonObject");
function parseTimestampToMs(rawTs) {
  const s = String(rawTs || "").trim().replace(",", ".");
  if (!s) return 0;
  const parts = s.split(":").map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return Math.max(0, Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1e3));
  }
  if (parts.length === 2) {
    return Math.max(0, Math.round((parts[0] * 60 + parts[1]) * 1e3));
  }
  return Math.max(0, Math.round(parts[0] * 1e3));
}
__name(parseTimestampToMs, "parseTimestampToMs");
function parseJson3Captions(json3Data) {
  const events = Array.isArray(json3Data && json3Data.events) ? json3Data.events : [];
  const cues = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs.map((s) => s && s.utf8 ? String(s.utf8) : "").join("");
    const text = cleanCueText(rawText);
    if (!text) continue;
    const startMs = Math.max(0, Number(ev.tStartMs) || 0);
    const durMs = Math.max(800, Number(ev.dDurationMs) || 2600);
    cues.push({
      startMs,
      endMs: startMs + durMs,
      text
    });
  }
  return cues;
}
__name(parseJson3Captions, "parseJson3Captions");
function parseXmlCaptions(xmlText) {
  const cues = [];
  const rawXml = String(xmlText || "");
  const textRegex = /<text\s+[^>]*start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(rawXml)) !== null) {
    const startMs = Math.max(0, Math.round((parseFloat(match[1]) || 0) * 1e3));
    const durMs = Math.max(800, Math.round((parseFloat(match[2]) || 2.5) * 1e3));
    const cleaned = cleanCueText(match[3]);
    if (!cleaned) continue;
    cues.push({
      startMs,
      endMs: startMs + durMs,
      text: cleaned
    });
  }
  if (cues.length === 0) {
    const pRegex = /<p\s+[^>]*\bt="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
    while ((match = pRegex.exec(rawXml)) !== null) {
      const startMs = Math.max(0, Number(match[1]) || 0);
      const durMs = Math.max(800, Number(match[2]) || 2600);
      const cleaned = cleanCueText(match[3]);
      if (!cleaned) continue;
      cues.push({
        startMs,
        endMs: startMs + durMs,
        text: cleaned
      });
    }
  }
  return cues;
}
__name(parseXmlCaptions, "parseXmlCaptions");
function parseVttOrSrtCaptions(rawText) {
  const lines = String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const cues = [];
  const tsLineRe = /^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(tsLineRe);
    if (!m) {
      i++;
      continue;
    }
    const startMs = parseTimestampToMs(m[1]);
    const endMs = Math.max(startMs + 600, parseTimestampToMs(m[2]));
    i++;
    const textParts = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textParts.push(lines[i].trim());
      i++;
    }
    const text = cleanCueText(textParts.join(" "));
    if (text && !/^WEBVTT/i.test(text)) {
      cues.push({ startMs, endMs, text });
    }
    i++;
  }
  return cues;
}
__name(parseVttOrSrtCaptions, "parseVttOrSrtCaptions");
function parseBilibiliBccCaptions(bccJson) {
  const body = Array.isArray(bccJson && bccJson.body) ? bccJson.body : [];
  const cues = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (!item) continue;
    const text = cleanCueText(item.content || "");
    if (!text) continue;
    const startMs = Math.max(0, Math.round((Number(item.from) || 0) * 1e3));
    const endMs = Math.max(startMs + 600, Math.round((Number(item.to) || (Number(item.from) || 0) + 2.5) * 1e3));
    cues.push({ startMs, endMs, text });
  }
  return cues;
}
__name(parseBilibiliBccCaptions, "parseBilibiliBccCaptions");
function normalizeTrackLanguageScore(track, preferLang) {
  const code = String(track && (track.languageCode || track.lang) || "").toLowerCase();
  const pref = String(preferLang || "").toLowerCase();
  const prefPrefix = pref.split(/[-_]/)[0];
  const isAsr = track && (track.kind === "asr" || track.ai_type === 1);
  let score = isAsr ? 0 : 10;
  if (pref && code === pref) score += 200;
  else if (prefPrefix && (code === prefPrefix || code.startsWith(`${prefPrefix}-`) || code.startsWith(`${prefPrefix}_`))) score += 140;
  else if (code === "en" || code.startsWith("en-")) score += 40;
  else if (code === "ja" || code.startsWith("ja-")) score += 35;
  else if (code === "zh-tw" || code === "zh-hant") score += 25;
  return score;
}
__name(normalizeTrackLanguageScore, "normalizeTrackLanguageScore");
function selectPreferredCaptionTracks(tracks, preferLang) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const pref = String(preferLang || "").trim().toLowerCase();
  const prefPrefix = pref.split(/[-_]/)[0];
  if (pref) {
    const hasLangMatch = tracks.some((t) => {
      const code = String(t && (t.languageCode || t.lang) || "").toLowerCase();
      return code === pref || prefPrefix && (code === prefPrefix || code.startsWith(`${prefPrefix}-`));
    });
    if (!hasLangMatch) {
      const rest = tracks.slice(1).sort(
        (a, b) => normalizeTrackLanguageScore(b, preferLang) - normalizeTrackLanguageScore(a, preferLang)
      );
      return [tracks[0], ...rest];
    }
  }
  return [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore(b, preferLang) - normalizeTrackLanguageScore(a, preferLang)
  );
}
__name(selectPreferredCaptionTracks, "selectPreferredCaptionTracks");
function smoothCueTimelines(cues) {
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endMs > cues[i + 1].startMs) {
      cues[i].endMs = Math.max(cues[i].startMs + 400, cues[i + 1].startMs - 40);
    }
  }
  return cues;
}
__name(smoothCueTimelines, "smoothCueTimelines");
function extractYouTubeVideoId(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const segments = u.pathname.split("/").filter(Boolean);
    if (u.hostname.includes("youtu.be") && segments[0] && /^[a-zA-Z0-9_-]{11}$/.test(segments[0])) {
      return segments[0];
    }
    const markerIdx = segments.findIndex((s) => s === "shorts" || s === "embed" || s === "live");
    if (markerIdx >= 0 && segments[markerIdx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(segments[markerIdx + 1])) {
      return segments[markerIdx + 1];
    }
  } catch (e) {
  }
  const fallback = input.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
  return fallback ? fallback[1] : "";
}
__name(extractYouTubeVideoId, "extractYouTubeVideoId");
function detectVideoPlatform(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return { platform: "", videoId: "" };
  if (/^BV[0-9A-Za-z]{10}$/.test(input)) {
    return { platform: "bilibili", videoId: input };
  }
  if (/^av\d+$/i.test(input)) {
    return { platform: "bilibili", videoId: input };
  }
  if (/^sm\d+$/i.test(input)) {
    return { platform: "niconico", videoId: input.toLowerCase() };
  }
  let parsed = null;
  try {
    parsed = new URL(input);
  } catch (e) {
  }
  const host = parsed ? parsed.hostname.toLowerCase() : "";
  const pathname = parsed ? parsed.pathname : "";
  if (host.includes("bilibili.com") || host.includes("b23.tv")) {
    const bvMatch = input.match(/(BV[0-9A-Za-z]{10})/);
    const avMatch = input.match(/\/av(\d+)/i);
    return {
      platform: "bilibili",
      videoId: bvMatch ? bvMatch[1] : avMatch ? `av${avMatch[1]}` : input,
      rawUrl: input
    };
  }
  if (host.includes("vimeo.com")) {
    const vm = pathname.match(/\/(?:video\/|channels\/[^/]+\/)?(\d+)/);
    return {
      platform: "vimeo",
      videoId: vm ? vm[1] : ""
    };
  }
  if (host.includes("dailymotion.com") || host.includes("dai.ly")) {
    const dm = pathname.match(/\/(?:video\/)?([a-zA-Z0-9]+)$/) || pathname.match(/\/video\/([a-zA-Z0-9]+)/);
    return {
      platform: "dailymotion",
      videoId: dm ? dm[1] : ""
    };
  }
  if (host.includes("nicovideo.jp") || host.includes("nico.ms")) {
    const nm = pathname.match(/(?:watch\/)?((?:sm|nm|so)\d+)/i);
    return {
      platform: "niconico",
      videoId: nm ? nm[1].toLowerCase() : ""
    };
  }
  if (host.includes("twitch.tv")) {
    const tw = pathname.match(/\/videos\/(\d+)/);
    return {
      platform: "twitch",
      videoId: tw ? tw[1] : ""
    };
  }
  const ytId = extractYouTubeVideoId(input);
  if (ytId) {
    return { platform: "youtube", videoId: ytId };
  }
  return { platform: "", videoId: "" };
}
__name(detectVideoPlatform, "detectVideoPlatform");
function buildFallbackResponse(platform, videoId, title, errorMsg, corsHeaders) {
  return new Response(
    JSON.stringify({
      ok: false,
      platform: platform || "unknown",
      videoId: videoId || "",
      title: title || "",
      fallbackSuggested: true,
      suggestedModes: ["video", "stt"],
      error: errorMsg || "\u6B64\u5F71\u7247\u672A\u63D0\u4F9B\u516C\u958B\u6587\u5B57\u5B57\u5E55\u8ECC\uFF0C\u5EFA\u8B70\u5207\u63DB\u300C\u756B\u9762\u5B57\u5E55\u300D\u6216\u300C\u8A9E\u97F3\u5B57\u5E55\u300D\u5373\u6642\u7FFB\u8B6F\u3002"
    }),
    {
      status: 404,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    }
  );
}
__name(buildFallbackResponse, "buildFallbackResponse");
function hasCaptionTracksInPlayer(playerResponse) {
  return Boolean(
    playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer && Array.isArray(playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks.length > 0
  );
}
__name(hasCaptionTracksInPlayer, "hasCaptionTracksInPlayer");
async function fetchYouTubeSubtitles(videoId, preferLang) {
  let playerResponse = null;
  try {
    const innertubeRes = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip"
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.09.37",
            androidSdkVersion: 34,
            hl: "en",
            gl: "US"
          }
        }
      })
    });
    if (innertubeRes.ok) {
      playerResponse = await innertubeRes.json();
    }
  } catch (e) {
  }
  if (!hasCaptionTracksInPlayer(playerResponse)) {
    try {
      const tvRes = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36"
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
              clientVersion: "2.0",
              hl: "en",
              gl: "US"
            },
            thirdParty: {
              embedUrl: "https://www.youtube.com/"
            }
          }
        })
      });
      if (tvRes.ok) {
        const tvData = await tvRes.json();
        if (hasCaptionTracksInPlayer(tvData) || !playerResponse) {
          playerResponse = tvData;
        }
      }
    } catch (e) {
    }
  }
  if (!hasCaptionTracksInPlayer(playerResponse)) {
    try {
      const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
      const pageResp = await fetch(watchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9,ja;q=0.8,zh-TW;q=0.7",
          "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+678"
        }
      });
      if (pageResp.ok) {
        const html = await pageResp.text();
        const scraped = extractBalancedJsonObject(html, "ytInitialPlayerResponse = ") || extractBalancedJsonObject(html, "var ytInitialPlayerResponse = ");
        if (scraped) playerResponse = scraped;
      }
    } catch (e) {
    }
  }
  const title = String(
    playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.title || ""
  ).trim();
  const tracks = playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks || [];
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return {
      ok: false,
      platform: "youtube",
      videoId,
      title,
      error: "\u6B64 YouTube \u5F71\u7247\u5C1A\u672A\u63D0\u4F9B\u5167\u5EFA\u5B57\u5E55\u8ECC\uFF0C\u5EFA\u8B70\u4F7F\u7528\u300C\u756B\u9762\u5B57\u5E55\u300D\u6216\u300C\u8A9E\u97F3\u5B57\u5E55\u300D\u6A21\u5F0F"
    };
  }
  const sortedTracks = selectPreferredCaptionTracks(tracks, preferLang);
  const chosen = sortedTracks[0];
  const baseUrl = String(chosen.baseUrl || "");
  if (!baseUrl) {
    return { ok: false, platform: "youtube", videoId, title, error: "\u627E\u4E0D\u5230\u6709\u6548\u7684 YouTube \u5B57\u5E55\u4E0B\u8F09\u9023\u7D50" };
  }
  let cues = [];
  try {
    const json3Url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
    const json3Resp = await fetch(json3Url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (json3Resp.ok) {
      const json3Data = await json3Resp.json();
      cues = parseJson3Captions(json3Data);
    }
  } catch (e) {
  }
  if (cues.length === 0) {
    try {
      const xmlResp = await fetch(baseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (xmlResp.ok) {
        const xmlText = await xmlResp.text();
        cues = parseXmlCaptions(xmlText);
        if (cues.length === 0) {
          cues = parseVttOrSrtCaptions(xmlText);
        }
      }
    } catch (e) {
    }
  }
  if (cues.length === 0) {
    return { ok: false, platform: "youtube", videoId, title, error: "YouTube \u5B57\u5E55\u8ECC\u5167\u5BB9\u70BA\u7A7A" };
  }
  return {
    ok: true,
    platform: "youtube",
    videoId,
    title,
    languageCode: chosen.languageCode || "en",
    tracks: sortedTracks.slice(0, 6).map((t) => ({
      languageCode: t.languageCode,
      name: t.name && t.name.simpleText || t.languageCode,
      kind: t.kind || ""
    })),
    cues: smoothCueTimelines(cues)
  };
}
__name(fetchYouTubeSubtitles, "fetchYouTubeSubtitles");
async function fetchBilibiliSubtitles(rawIdOrUrl, preferLang) {
  let idToken = String(rawIdOrUrl || "").trim();
  if (/b23\.tv/i.test(idToken)) {
    try {
      const redir = await fetch(idToken, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      const bvMatch = String(redir.url || "").match(/(BV[0-9A-Za-z]{10})/);
      if (bvMatch) idToken = bvMatch[1];
    } catch (e) {
    }
  }
  const isAv = /^av(\d+)$/i.test(idToken);
  const queryParam = isAv ? `aid=${encodeURIComponent(idToken.replace(/^av/i, ""))}` : `bvid=${encodeURIComponent(idToken)}`;
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www.bilibili.com/"
    }
  });
  if (!viewRes.ok) {
    return { ok: false, platform: "bilibili", videoId: idToken, title: "", error: "\u7121\u6CD5\u8B80\u53D6 Bilibili \u5F71\u7247\u8CC7\u8A0A" };
  }
  const viewJson = await viewRes.json();
  const data = viewJson && viewJson.data;
  if (!data || !data.cid) {
    return { ok: false, platform: "bilibili", videoId: idToken, title: "", error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684 Bilibili \u5F71\u7247 CID" };
  }
  const bvid = data.bvid || idToken;
  const aid = data.aid;
  const cid = data.cid;
  const title = String(data.title || "").trim();
  const playerRes = await fetch(
    `https://api.bilibili.com/x/player/v2?cid=${encodeURIComponent(cid)}&aid=${encodeURIComponent(aid)}&bvid=${encodeURIComponent(bvid)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": `https://www.bilibili.com/video/${bvid}`
      }
    }
  );
  let tracks = [];
  if (playerRes.ok) {
    const pJson = await playerRes.json();
    tracks = pJson && pJson.data && pJson.data.subtitle && pJson.data.subtitle.subtitles || [];
  }
  if ((!Array.isArray(tracks) || tracks.length === 0) && data.subtitle && Array.isArray(data.subtitle.list)) {
    tracks = data.subtitle.list;
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return {
      ok: false,
      platform: "bilibili",
      videoId: bvid,
      title,
      error: "\u6B64 Bilibili \u5F71\u7247\u672A\u63D0\u4F9B\u958B\u653E CC \u5B57\u5E55\uFF08\u6216\u9700\u767B\u5165\u8B80\u53D6\uFF09\uFF0C\u5EFA\u8B70\u5207\u63DB\u300C\u756B\u9762\u5B57\u5E55\u300D\u8FA8\u8B58\u786C\u5B57\u5E55\u3002"
    };
  }
  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.lan, ai_type: b.ai_type }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.lan, ai_type: a.ai_type }, preferLang)
  );
  const chosen = sortedTracks[0];
  let subUrl = String(chosen.subtitle_url || "").trim();
  if (subUrl.startsWith("//")) subUrl = "https:" + subUrl;
  if (!subUrl) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili \u5B57\u5E55\u6A94\u7DB2\u5740\u7121\u6548" };
  }
  const subRes = await fetch(subUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!subRes.ok) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili \u5B57\u5E55\u5167\u5BB9\u4E0B\u8F09\u5931\u6557" };
  }
  const bccJson = await subRes.json();
  const cues = parseBilibiliBccCaptions(bccJson);
  if (cues.length === 0) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili \u5B57\u5E55\u5167\u5BB9\u70BA\u7A7A" };
  }
  return {
    ok: true,
    platform: "bilibili",
    videoId: bvid,
    title,
    languageCode: chosen.lan || "zh-CN",
    tracks: sortedTracks.slice(0, 6).map((t) => ({
      languageCode: t.lan || "",
      name: t.lan_doc || t.lan || "CC",
      kind: t.ai_type === 1 ? "asr" : ""
    })),
    cues: smoothCueTimelines(cues)
  };
}
__name(fetchBilibiliSubtitles, "fetchBilibiliSubtitles");
async function fetchVimeoSubtitles(videoId, preferLang) {
  const cfgRes = await fetch(`https://player.vimeo.com/video/${encodeURIComponent(videoId)}/config`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://vimeo.com/"
    }
  });
  if (!cfgRes.ok) {
    return { ok: false, platform: "vimeo", videoId, title: "", error: "\u7121\u6CD5\u53D6\u5F97 Vimeo \u64AD\u653E\u5668\u8A2D\u5B9A" };
  }
  const cfg = await cfgRes.json();
  const title = String(cfg && cfg.video && cfg.video.title || "").trim();
  const tracks = cfg && cfg.request && Array.isArray(cfg.request.text_tracks) ? cfg.request.text_tracks : [];
  if (tracks.length === 0) {
    return { ok: false, platform: "vimeo", videoId, title, error: "\u6B64 Vimeo \u5F71\u7247\u5C1A\u672A\u63D0\u4F9B\u6587\u5B57\u5B57\u5E55\u8ECC" };
  }
  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.lang }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.lang }, preferLang)
  );
  const chosen = sortedTracks[0];
  let trackUrl = String(chosen.url || "").trim();
  if (trackUrl.startsWith("/")) trackUrl = `https://player.vimeo.com${trackUrl}`;
  if (!trackUrl) {
    return { ok: false, platform: "vimeo", videoId, title, error: "\u627E\u4E0D\u5230 Vimeo \u5B57\u5E55\u6A94\u9023\u7D50" };
  }
  const vttRes = await fetch(trackUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!vttRes.ok) {
    return { ok: false, platform: "vimeo", videoId, title, error: "Vimeo \u5B57\u5E55\u6A94\u4E0B\u8F09\u5931\u6557" };
  }
  const cues = parseVttOrSrtCaptions(await vttRes.text());
  if (cues.length === 0) {
    return { ok: false, platform: "vimeo", videoId, title, error: "Vimeo \u5B57\u5E55\u8ECC\u5167\u5BB9\u70BA\u7A7A" };
  }
  return {
    ok: true,
    platform: "vimeo",
    videoId,
    title,
    languageCode: chosen.lang || "en",
    tracks: sortedTracks.slice(0, 6).map((t) => ({
      languageCode: t.lang || "",
      name: t.label || t.lang || "CC",
      kind: t.kind || ""
    })),
    cues: smoothCueTimelines(cues)
  };
}
__name(fetchVimeoSubtitles, "fetchVimeoSubtitles");
async function fetchDailymotionSubtitles(videoId, preferLang) {
  const apiRes = await fetch(
    `https://api.dailymotion.com/video/${encodeURIComponent(videoId)}?fields=title,subtitles`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  let title = "";
  let tracks = [];
  if (apiRes.ok) {
    const meta = await apiRes.json();
    title = String(meta && meta.title || "").trim();
  }
  try {
    const subListRes = await fetch(
      `https://api.dailymotion.com/video/${encodeURIComponent(videoId)}/subtitles?fields=language,url`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (subListRes.ok) {
      const subJson = await subListRes.json();
      if (subJson && Array.isArray(subJson.list)) {
        tracks = subJson.list;
      }
    }
  } catch (e) {
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return {
      ok: false,
      platform: "dailymotion",
      videoId,
      title,
      error: "\u6B64 Dailymotion \u5F71\u7247\u7121\u5167\u5EFA\u5916\u639B\u5B57\u5E55\u8ECC\uFF0C\u5EFA\u8B70\u6539\u7528\u300C\u756B\u9762\u5B57\u5E55\u300D\u6216\u300C\u8A9E\u97F3\u5B57\u5E55\u300D\u3002"
    };
  }
  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.language }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.language }, preferLang)
  );
  const chosen = sortedTracks[0];
  if (!chosen || !chosen.url) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion \u5B57\u5E55\u6A94\u7DB2\u5740\u7121\u6548" };
  }
  const subRes = await fetch(chosen.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!subRes.ok) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion \u5B57\u5E55\u4E0B\u8F09\u5931\u6557" };
  }
  const cues = parseVttOrSrtCaptions(await subRes.text());
  if (cues.length === 0) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion \u5B57\u5E55\u5167\u5BB9\u70BA\u7A7A" };
  }
  return {
    ok: true,
    platform: "dailymotion",
    videoId,
    title,
    languageCode: chosen.language || "en",
    tracks: sortedTracks.slice(0, 6).map((t) => ({
      languageCode: t.language || "",
      name: t.language || "CC",
      kind: ""
    })),
    cues: smoothCueTimelines(cues)
  };
}
__name(fetchDailymotionSubtitles, "fetchDailymotionSubtitles");
async function fetchNiconicoSubtitles(videoId) {
  let title = "";
  try {
    const pageRes = await fetch(`https://www.nicovideo.jp/watch/${encodeURIComponent(videoId)}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) title = decodeHtmlEntities(titleMatch[1]).replace(/\s*-\s*ニコニコ動画.*$/i, "").trim();
      const dataMatch = html.match(/data-api-data="([^"]+)"/);
      if (dataMatch) {
        const apiData = JSON.parse(decodeHtmlEntities(dataMatch[1]));
        const videoTitle = apiData && apiData.video && apiData.video.title;
        if (videoTitle) title = String(videoTitle).trim();
        const subTracks = apiData && apiData.media && apiData.media.delivery && apiData.media.delivery.movie && apiData.media.delivery.movie.subtitles || [];
        if (Array.isArray(subTracks) && subTracks.length > 0 && subTracks[0].url) {
          const vttRes = await fetch(subTracks[0].url, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (vttRes.ok) {
            const cues = parseVttOrSrtCaptions(await vttRes.text());
            if (cues.length > 0) {
              return {
                ok: true,
                platform: "niconico",
                videoId,
                title,
                languageCode: subTracks[0].language || "ja",
                tracks: subTracks.map((t) => ({ languageCode: t.language || "ja", name: t.label || "CC", kind: "" })),
                cues: smoothCueTimelines(cues)
              };
            }
          }
        }
      }
    }
  } catch (e) {
  }
  return {
    ok: false,
    platform: "niconico",
    videoId,
    title,
    error: "\u6B64 Niconico \u5F71\u7247\u7121\u516C\u958B\u5B57\u5E55\u8ECC\uFF0C\u5EFA\u8B70\u4E00\u9375\u5207\u63DB\u300C\u756B\u9762\u5B57\u5E55\u300D\u6216\u300C\u8A9E\u97F3\u5B57\u5E55\u300D\u5373\u6642\u7FFB\u8B6F\u3002"
  };
}
__name(fetchNiconicoSubtitles, "fetchNiconicoSubtitles");
async function fetchTwitchSubtitles(videoId) {
  return {
    ok: false,
    platform: "twitch",
    videoId,
    title: `Twitch VOD ${videoId}`,
    error: "Twitch \u76F4\u64AD\u8207 VOD \u5B57\u5E55\u591A\u70BA HLS \u5167\u5D4C\u4E32\u6D41\uFF0C\u5EFA\u8B70\u4E00\u9375\u5207\u63DB\u300C\u756B\u9762\u5B57\u5E55\u300D\u6216\u300C\u8A9E\u97F3\u5B57\u5E55\u300D\u5373\u6642\u8FA8\u8B58\u3002"
  };
}
__name(fetchTwitchSubtitles, "fetchTwitchSubtitles");
async function handleYoutubeSubtitles(request, env, corsHeaders) {
  const url = new URL(request.url);
  let rawVideoUrl = url.searchParams.get("url") || url.searchParams.get("videoId") || "";
  let preferLang = url.searchParams.get("lang") || "";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body && (body.url || body.videoId)) rawVideoUrl = body.url || body.videoId;
      if (body && body.lang) preferLang = body.lang;
    } catch (e) {
    }
  }
  const detected = detectVideoPlatform(rawVideoUrl);
  if (!detected.platform || !detected.videoId) {
    return new Response(
      JSON.stringify({
        ok: false,
        fallbackSuggested: true,
        suggestedModes: ["video", "stt"],
        error: "\u7121\u6CD5\u8FA8\u8B58\u5F71\u7247\u7DB2\u5740\uFF0C\u652F\u63F4 YouTube / Bilibili / Vimeo / Dailymotion / Niconico / Twitch\u3002"
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const normalizedPref = String(preferLang || "auto").toLowerCase();
  const cache = caches.default;
  const cacheReq = new Request(
    `https://yt-cache.lzhcard.internal/subtitles/${encodeURIComponent(detected.platform)}/${encodeURIComponent(detected.videoId)}/${encodeURIComponent(normalizedPref)}`
  );
  try {
    const cachedHit = await cache.match(cacheReq);
    if (cachedHit) {
      const hitText = await cachedHit.text();
      let isValidCached = false;
      try {
        const parsedHit = JSON.parse(hitText);
        isValidCached = Boolean(parsedHit && parsedHit.ok && Array.isArray(parsedHit.cues) && parsedHit.cues.length > 0);
      } catch (e) {
      }
      if (isValidCached) {
        return new Response(hitText, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "X-Cache": "HIT"
          }
        });
      }
    }
  } catch (e) {
  }
  try {
    let result = null;
    if (detected.platform === "youtube") {
      result = await fetchYouTubeSubtitles(detected.videoId, preferLang);
    } else if (detected.platform === "bilibili") {
      result = await fetchBilibiliSubtitles(detected.rawUrl || detected.videoId, preferLang);
    } else if (detected.platform === "vimeo") {
      result = await fetchVimeoSubtitles(detected.videoId, preferLang);
    } else if (detected.platform === "dailymotion") {
      result = await fetchDailymotionSubtitles(detected.videoId, preferLang);
    } else if (detected.platform === "niconico") {
      result = await fetchNiconicoSubtitles(detected.videoId);
    } else if (detected.platform === "twitch") {
      result = await fetchTwitchSubtitles(detected.videoId);
    }
    if (!result || !result.ok || !Array.isArray(result.cues) || result.cues.length === 0) {
      return buildFallbackResponse(
        detected.platform,
        detected.videoId,
        result && result.title,
        result && result.error || "\u627E\u4E0D\u5230\u53EF\u7528\u5B57\u5E55\u8ECC",
        corsHeaders
      );
    }
    const payloadString = JSON.stringify(result);
    try {
      await cache.put(
        cacheReq,
        new Response(payloadString, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400"
          }
        })
      );
    } catch (e) {
    }
    return new Response(payloadString, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "MISS"
      }
    });
  } catch (err) {
    return buildFallbackResponse(
      detected.platform,
      detected.videoId,
      "",
      "\u89E3\u6790\u5F71\u7247\u5B57\u5E55\u5931\u6557: " + (err && err.message ? err.message : String(err)),
      corsHeaders
    );
  }
}
__name(handleYoutubeSubtitles, "handleYoutubeSubtitles");

// index.js
var index_default = {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AI-Feature, X-Client-Platform, X-User-Api-Key",
      "Access-Control-Max-Age": "86400"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const ua = request.headers.get("user-agent") || "";
    const isIosInApp = /iPhone|iPad|iPod/i.test(ua) && (ua.includes("Instagram") || ua.includes("FB") || ua.includes("FBAV") || ua.includes("FBAN"));
    if (request.method === "GET" && isIosInApp) {
      return new Response("Redirecting to Safari...", {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="redirect.pdf"'
        }
      });
    }
    const url = new URL(request.url);
    const pathname = url.pathname;
    try {
      if ((pathname.endsWith("/api/verify-purchase/android") || pathname.endsWith("/billing/verify-purchase")) && request.method === "POST") {
        return await handleVerifyAndroidPurchase(request, env, corsHeaders);
      }
      if (pathname.endsWith("/api/verify-purchase/ios") && request.method === "POST") {
        return await handleVerifyIosPurchase(request, env, corsHeaders);
      }
      if (pathname.endsWith("/api/verify-purchase/web") && request.method === "POST") {
        return await handleVerifyWebPurchase(request, env, corsHeaders);
      }
      if (pathname.endsWith("/api/payment/web-checkout") && request.method === "POST") {
        return await handleWebCheckout(request, env, corsHeaders);
      }
      if (pathname.endsWith("/buy-deck") && request.method === "POST") {
        return await handleBuyDeck(request, env, corsHeaders);
      }
      if (pathname.endsWith("/membership/redeem-coins") && request.method === "POST") {
        return await handleRedeemCoinsForQuota(request, env, corsHeaders);
      }
      if (pathname.endsWith("/cosmetics/buy") && request.method === "POST") {
        return await handleBuyCosmetic(request, env, corsHeaders);
      }
      if (pathname.endsWith("/shop/buy-shield") && request.method === "POST") {
        return await handleBuyStreakShield(request, env, corsHeaders);
      }
      if (pathname.endsWith("/ai/quota-status") && (request.method === "GET" || request.method === "POST")) {
        return await handleGetQuotaStatus(request, env, corsHeaders);
      }
      if (pathname.endsWith("/youtube/subtitles") && (request.method === "GET" || request.method === "POST")) {
        return await handleYoutubeSubtitles(request, env, corsHeaders);
      }
      if (pathname.endsWith("/ai/fast-refine") && request.method === "POST") {
        return await handleFastRefine(request, env, corsHeaders);
      }
      if (pathname.endsWith("/api/ai/stt") && request.method === "POST") {
        return await handleAudioStt(request, env, corsHeaders);
      }
      return await handleGeminiAi(request, env, corsHeaders);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Worker \u5167\u90E8\u4F8B\u5916: " + err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
