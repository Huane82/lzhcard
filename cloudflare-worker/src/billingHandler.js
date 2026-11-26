import {
  TIER_ORDER,
  enforceNotBanned,
  extractBearerToken,
  isUserAdminFromFields,
  verifyFirebaseToken
} from "./quotaManager.js";
import {
  consumeOrAckGooglePlayPurchase,
  decodeFirestoreDoc,
  firestoreCreateDocIfAbsent,
  firestoreGetDoc,
  firestorePatchDoc,
  getFirestoreAuthHeader,
  sha256Hex,
  verifyGooglePlayProductReceipt
} from "./firestoreAdmin.js";

const EXPECTED_PACKAGE_NAME = "com.lzhcard.app";
const DAY_MS = 24 * 60 * 60 * 1000;
const APPLE_VERIFY_RECEIPT_PROD = "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_VERIFY_RECEIPT_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";

export const BILLING_SKU_CATALOG = {
  // 2:8 金幣儲值方案（NT$ 1 = 4 金幣）
  lzhcard_coins_120: {
    sku: "lzhcard_coins_120",
    kind: "coins",
    priceNtd: 30,
    coins: 120,
    consumable: true,
    title: "120 商店金幣包"
  },
  lzhcard_coins_360: {
    sku: "lzhcard_coins_360",
    kind: "coins",
    priceNtd: 90,
    coins: 360,
    consumable: true,
    title: "360 商店金幣包"
  },
  lzhcard_coins_720: {
    sku: "lzhcard_coins_720",
    kind: "coins",
    priceNtd: 180,
    coins: 720,
    consumable: true,
    title: "720 商店金幣包"
  },
  lzhcard_coins_1200: {
    sku: "lzhcard_coins_1200",
    kind: "coins",
    priceNtd: 300,
    coins: 1200,
    consumable: true,
    title: "1,200 商店金幣包"
  },

  // Google Play / Apple App Store / Web 共用會員 SKU（純月繳 30 天制）
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
    title: "入門方案 Starter (30天)"
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
    title: "進階方案 Plus (30天)"
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
    title: "專業方案 Pro (30天)"
  },
  lzhcard_mem_teacher_30d: {
    sku: "lzhcard_mem_teacher_30d",
    kind: "membership",
    tier: "teacher_class",
    cycle: "monthly",
    days: 30,
    priceNtd: 490,
    consumable: true,
    frameId: "supporter_celestial_crown",
    bannerId: "supporter_imperial_aurora",
    titleId: "supporter_crown",
    title: "班級教師方案 Teacher Class (30天)"
  }
};

export const IOS_PRICE_NTD_BY_SKU = {
  lzhcard_coins_120: 33,
  lzhcard_coins_360: 99,
  lzhcard_coins_720: 198,
  lzhcard_coins_1200: 330,
  lzhcard_mem_starter_30d: 43,
  lzhcard_mem_plus_30d: 109,
  lzhcard_mem_pro_30d: 219,
  lzhcard_mem_teacher_30d: 539
};

export function getSkuPriceNtd(skuId, platform = "android") {
  const meta = BILLING_SKU_CATALOG[skuId];
  if (!meta) return 0;
  if (String(platform || "").toLowerCase() === "ios") {
    return IOS_PRICE_NTD_BY_SKU[skuId] ?? Math.round(Number(meta.priceNtd || 0) * 1.1);
  }
  return Number(meta.priceNtd || 0);
}

function formatDateYmd(ts) {
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function jsonResponse(payload, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function authenticateBillingRequest(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, error: "請先登入帳號後再進行購買驗證" }, 401, corsHeaders)
    };
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, error: "身份憑證無效或已過期，請重新登入" }, 403, corsHeaders)
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
          error: "伺服器尚未配置 FIREBASE_SERVICE_ACCOUNT 管理權限，已拒絕任何前端直寫入庫。"
        },
        503,
        corsHeaders
      )
    };
  }

  return { ok: true, uid: verified.uid, email: verified.email || "", idToken, fsAuth };
}

/**
 * 三端共用冪等發放核心：鎖定 processedTransactions/{platform}_{txId} 並寫入金幣或會員
 */
export async function grantVerifiedPurchase(
  uid,
  productId,
  transactionId,
  platform,
  extraMeta = {},
  env = null,
  fsAuth = null
) {
  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return { ok: false, status: 400, error: `無效的商品代碼 (${productId})` };
  }

  const cleanPlatform = String(platform || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const cleanTxRaw = String(transactionId || "").trim();
  if (!cleanTxRaw) {
    return { ok: false, status: 400, error: "缺少有效交易編號 (transactionId)" };
  }

  const safeTxHash = cleanTxRaw.length > 96 ? await sha256Hex(cleanTxRaw) : cleanTxRaw;
  const safeTxDocId = `${cleanPlatform}_${safeTxHash}`.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 120);

  const userPath = `users/${encodeURIComponent(uid)}`;
  const userRes = await firestoreGetDoc(userPath, fsAuth.Authorization);
  if (!userRes.exists) {
    return { ok: false, status: 404, error: "找不到使用者雲端資料" };
  }

  const userData = decodeFirestoreDoc(userRes.doc);
  const banCheck = await enforceNotBanned(uid, userRes.doc, fsAuth, Date.now());
  if (banCheck.banned) {
    return {
      ok: false,
      status: 403,
      code: "ACCOUNT_BANNED",
      error: `此帳號已被封鎖（原因：${banCheck.ban.reason || "違反規範"}），無法進行購買入帳。`
    };
  }
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const nowMs = Date.now();

  // 先檢查是否已核銷過同一筆交易（支援 iOS Restore Purchases 冪等回傳）
  const existingTxRes = await firestoreGetDoc(`processedTransactions/${encodeURIComponent(safeTxDocId)}`, fsAuth.Authorization);
  if (existingTxRes.exists) {
    const txData = decodeFirestoreDoc(existingTxRes.doc);
    if (txData.uid && txData.uid !== uid) {
      return {
        ok: false,
        status: 409,
        code: "TX_OWNED_BY_OTHER_ACCOUNT",
        error: "此購買憑證已綁定於其他帳號，無法重複入帳。"
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
      message: "此訂單已完成驗證與發放，不會重複入帳。"
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
          error: `目前已是有效會員（到期日：${formatDateYmd(curExpires)}），無需重複購買同級或較低方案。`
        };
      }
    }
  }

  // Android 舊版 processedOrders 相容防重放鎖
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
        message: "此 Google Play 訂單已完成核銷，不會重複發放或扣款。"
      };
    }
  }

  const effectivePriceNtd = getSkuPriceNtd(productId, cleanPlatform);

  const txRecord = {
    txDocId: safeTxDocId,
    transactionId: cleanTxRaw,
    platform: cleanPlatform,
    uid,
    productId,
    kind: skuMeta.kind,
    priceNtd: effectivePriceNtd,
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
      message: "此交易已完成核銷，不會重複入帳。"
    };
  }

  let updatedPatch = {};
  let updateMasks = [];
  let newCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  let nextMembership = userData.membership && typeof userData.membership === "object"
    ? { ...userData.membership }
    : { tier: "free", tierPriceNtd: 0, startedAt: 0, expiresAt: 0, billingCycle: "monthly", totalDonatedNtd: 0, autoDowngradedAt: 0 };

  const sourceLabel = cleanPlatform === "ios"
    ? "apple_app_store"
    : (cleanPlatform === "web" ? "web_checkout" : "google_play");

  if (skuMeta.kind === "coins") {
    newCoins += skuMeta.coins;
    updatedPatch = { coins: newCoins };
    updateMasks = ["coins"];
  } else {
    const durationMs = skuMeta.days * DAY_MS;
    const baseStart = Number(extraMeta.purchaseDateMs) > 0 ? Number(extraMeta.purchaseDateMs) : nowMs;
    const newExpiresAt = Math.max(nowMs + 60000, baseStart + durationMs);
    nextMembership = {
      tier: skuMeta.tier,
      tierPriceNtd: effectivePriceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: baseStart,
      expiresAt: newExpiresAt,
      totalDonatedNtd: (Number(nextMembership.totalDonatedNtd) || 0) + effectivePriceNtd,
      autoDowngradedAt: 0,
      lastOrderId: safeTxDocId
    };
    const history = Array.isArray(userData.membershipHistory) ? [...userData.membershipHistory] : [];
    history.unshift({
      tier: skuMeta.tier,
      priceNtd: effectivePriceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: baseStart,
      expiresAt: newExpiresAt,
      source: sourceLabel,
      orderId: safeTxDocId
    });
    const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object"
      ? { ...userData.cosmetics }
      : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
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
    message: skuMeta.kind === "coins"
      ? `🎉 儲值成功！已發放 ${skuMeta.coins} 金幣`
      : `🎉 購買驗證成功！已開通「${skuMeta.title}」`
  };
}

// ==========================================
// 通道 1：Android Google Play Billing
// ==========================================
export async function handleVerifyAndroidPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "無效的 JSON 請求內容" }, 400, corsHeaders);
  }

  const productId = String((body && body.productId) || "").trim();
  const purchaseToken = String((body && body.purchaseToken) || "").trim();
  const clientOrderId = String((body && body.orderId) || "").trim();
  const packageName = String((body && body.packageName) || EXPECTED_PACKAGE_NAME).trim();

  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return jsonResponse({ ok: false, error: "無效的商品代碼 (Unknown SKU)" }, 400, corsHeaders);
  }
  if (packageName !== EXPECTED_PACKAGE_NAME) {
    return jsonResponse({ ok: false, error: "套件名稱與應用程式不相符" }, 403, corsHeaders);
  }
  if (!purchaseToken || purchaseToken.length < 12) {
    return jsonResponse({ ok: false, error: "缺少有效的 Google Play 購買憑證 (purchaseToken)" }, 400, corsHeaders);
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

export async function handleVerifyPlayPurchase(request, env, corsHeaders) {
  return handleVerifyAndroidPurchase(request, env, corsHeaders);
}

// ==========================================
// 通道 2：iOS Apple App Store StoreKit / verifyReceipt
// ==========================================
function base64UrlToUint8Array(b64u) {
  const b64 = String(b64u || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64ToArrayBuffer(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * 嘗試從 X.509 DER 憑證提取 SubjectPublicKeyInfo (SPKI) 以供 crypto.subtle.verify 驗證 Apple x5c JWS 簽章
 */
function extractSpkiFromX509Der(derBytes) {
  const bytes = derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes);
  // 搜尋 EC P-256 OID (1.2.840.10045.2.1 = 06 07 2A 86 48 CE 3D 02 01) 的前一個 SEQUENCE (SPKI)
  const ecOid = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  for (let i = 4; i < bytes.length - ecOid.length - 12; i++) {
    let match = true;
    for (let j = 0; j < ecOid.length; j++) {
      if (bytes[i + j] !== ecOid[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    // 回溯找出包住 AlgorithmIdentifier 與 BIT STRING 的外層 SPKI SEQUENCE
    for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
      if (bytes[k] === 0x30) {
        const lenByte = bytes[k + 1];
        let totalLen = 0;
        let headerLen = 2;
        if (lenByte < 0x80) {
          totalLen = lenByte;
        } else if (lenByte === 0x81) {
          totalLen = bytes[k + 2];
          headerLen = 3;
        } else if (lenByte === 0x82) {
          totalLen = (bytes[k + 2] << 8) | bytes[k + 3];
          headerLen = 4;
        }
        if (totalLen > 40 && totalLen < 160 && k + headerLen + totalLen <= bytes.length) {
          // 確認緊接在 AlgId SEQUENCE 後面的是 BIT STRING (0x03)
          if (bytes[k + headerLen] === 0x30) {
            return bytes.slice(k, k + headerLen + totalLen).buffer;
          }
        }
      }
    }
  }
  return null;
}

async function decodeAndVerifyAppleJws(jwsToken, expectedBundleId) {
  const parts = String(jwsToken || "").trim().split(".");
  if (parts.length !== 3) return { ok: false, error: "Apple JWS 格式錯誤" };

  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[1])));
  } catch (e) {
    return { ok: false, error: "無法解析 Apple JWS 內容" };
  }

  // 若含 x5c 憑證鏈與 ES256 簽章，於 Worker 端以 Web Crypto 驗證簽章完整性
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
          return { ok: false, error: "Apple JWS 簽章驗證失敗" };
        }
      }
    } catch (e) {
      return { ok: false, error: `Apple JWS 憑證驗證失敗: ${e.message}` };
    }
  }

  if (expectedBundleId && payload.bundleId && payload.bundleId !== expectedBundleId) {
    return { ok: false, error: "Apple 購買憑證 Bundle ID 不符" };
  }
  if (payload.revocationDate) {
    return { ok: false, error: "此 Apple 交易已退款或撤銷" };
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

async function verifyAppleReceiptLegacy(receiptData, env, expectedBundleId) {
  const sharedSecret = String(env.APPLE_SHARED_SECRET || "").trim();
  const reqBody = {
    "receipt-data": receiptData,
    "exclude-old-transactions": true
  };
  if (sharedSecret) {
    reqBody.password = sharedSecret;
  }

  const postVerify = async (endpoint) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      throw new Error(`Apple verifyReceipt HTTP ${res.status}`);
    }
    return await res.json();
  };

  let data = await postVerify(APPLE_VERIFY_RECEIPT_PROD);
  let environment = "Production";
  // 21007 = Sandbox 收據打到正式機，必須自動 fallback 到 Sandbox 重新驗證（Apple 審核必走路徑）
  if (Number(data && data.status) === 21007) {
    data = await postVerify(APPLE_VERIFY_RECEIPT_SANDBOX);
    environment = "Sandbox";
  }

  if (!data || Number(data.status) !== 0) {
    return {
      ok: false,
      status: 400,
      error: `Apple 收據驗證失敗 (status=${data ? data.status : "unknown"})`
    };
  }

  const bundleId = String((data.receipt && data.receipt.bundle_id) || "").trim();
  if (expectedBundleId && bundleId && bundleId !== expectedBundleId) {
    return { ok: false, status: 403, error: "Apple 收據 Bundle ID 與應用程式不符" };
  }

  const inAppList = [
    ...(Array.isArray(data.latest_receipt_info) ? data.latest_receipt_info : []),
    ...(Array.isArray(data.receipt && data.receipt.in_app) ? data.receipt.in_app : [])
  ];

  const validTxs = [];
  const seenIds = new Set();
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
    return { ok: false, status: 400, error: "Apple 收據中找不到對應的商品交易項目" };
  }

  return { ok: true, environment, transactions: validTxs };
}

export async function handleVerifyIosPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "無效的 JSON 請求內容" }, 400, corsHeaders);
  }

  const productId = String((body && body.productId) || "").trim();
  const transactionId = String((body && body.transactionId) || "").trim();
  const receipt = String((body && (body.receipt || body.appStoreReceipt || body.jwsRepresentation)) || "").trim();
  const isRestore = Boolean(body && body.restore);
  const expectedBundleId = String(env.APPLE_BUNDLE_ID || EXPECTED_PACKAGE_NAME).trim();

  if (!receipt && !transactionId) {
    return jsonResponse({ ok: false, error: "缺少 Apple StoreKit 購買收據 (receipt) 或交易編號" }, 400, corsHeaders);
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
          error: "伺服器尚未設定 APPLE_SHARED_SECRET，無法向 Apple verifyReceipt 進行收據驗證。"
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
    return jsonResponse({ ok: false, error: "缺少可驗證的 Apple 收據資料" }, 400, corsHeaders);
  }

  // 若指定了單一 productId 或 transactionId（非整包 restore），優先過濾目標交易
  if (productId && !isRestore) {
    const filtered = verifiedTxs.filter(
      (tx) => tx.productId === productId && (!transactionId || tx.transactionId === transactionId || tx.originalTransactionId === transactionId)
    );
    if (filtered.length > 0) {
      verifiedTxs = [filtered[0]];
    } else if (!BILLING_SKU_CATALOG[productId]) {
      return jsonResponse({ ok: false, error: "無效的商品代碼 (Unknown SKU)" }, 400, corsHeaders);
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
    return jsonResponse({ ok: false, error: "找不到可核銷的 App Store 商品交易" }, 400, corsHeaders);
  }

  return jsonResponse({ ...lastGrant, restoredCount }, 200, corsHeaders);
}

// ==========================================
// 通道 3：Web 線上金流結帳與 HMAC/Stripe 驗證
// ==========================================
async function computeHmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function handleWebCheckout(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "無效的 JSON 請求內容" }, 400, corsHeaders);
  }

  const productId = String((body && body.productId) || "").trim();
  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return jsonResponse({ ok: false, error: "無效的商品代碼 (Unknown SKU)" }, 400, corsHeaders);
  }

  if (env.STRIPE_SECRET_KEY) {
    try {
      const returnUrl = String((body && body.returnUrl) || "https://flashcards-5f514.web.app").split("#")[0];
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
    } catch (e) {}
  }

  return jsonResponse(
    {
      ok: false,
      code: "WEB_CHECKOUT_MAINTENANCE",
      error: "網頁版線上金流維護中，請使用 Android 或 iOS App 內購儲值，或於商店以金幣兌換會員方案"
    },
    503,
    corsHeaders
  );
}

export async function handleVerifyWebPurchase(request, env, corsHeaders) {
  const auth = await authenticateBillingRequest(request, env, corsHeaders);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "無效的 JSON 請求內容" }, 400, corsHeaders);
  }

  const sessionId = String((body && body.sessionId) || "").trim();
  if (sessionId && env.STRIPE_SECRET_KEY) {
    const sRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    if (!sRes.ok) {
      return jsonResponse({ ok: false, error: "無法查詢網頁結帳訂單狀態" }, 400, corsHeaders);
    }
    const session = await sRes.json();
    if (session.payment_status !== "paid") {
      return jsonResponse({ ok: false, error: "此網頁訂單尚未完成付款" }, 402, corsHeaders);
    }
    const metaUid = String((session.metadata && session.metadata.uid) || "").trim();
    const metaProductId = String((session.metadata && session.metadata.productId) || "").trim();
    if (metaUid && metaUid !== auth.uid) {
      return jsonResponse({ ok: false, error: "訂單所屬帳號與目前登入者不符" }, 403, corsHeaders);
    }
    const grantRes = await grantVerifiedPurchase(
      auth.uid,
      metaProductId,
      session.payment_intent || session.id,
      "web",
      { environment: "WebStripe" },
      env,
      auth.fsAuth
    );
    return jsonResponse(grantRes, grantRes.status || 200, corsHeaders);
  }

  const productId = String((body && body.productId) || "").trim();
  const transactionId = String((body && body.transactionId) || "").trim();
  const signature = String((body && body.signature) || "").trim();
  const secret = String(env.WEB_CHECKOUT_SECRET || "").trim();
  if (!secret || !productId || !transactionId || !signature) {
    return jsonResponse(
      { ok: false, error: "網頁版線上金流尚未設定完成或缺少有效驗簽憑證" },
      503,
      corsHeaders
    );
  }

  const expectedSig = await computeHmacSha256Hex(secret, `${auth.uid}:${productId}:${transactionId}`);
  if (expectedSig.toLowerCase() !== signature.toLowerCase()) {
    return jsonResponse({ ok: false, error: "網頁交易簽章驗證失敗" }, 403, corsHeaders);
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
