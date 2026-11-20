import {
  TIER_ORDER,
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

  // Google Play 會員方案（消耗性／週期憑證驗證後寫入效期）
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
    title: "入門方案 Starter 年繳 (365天)"
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
    title: "進階方案 Plus 年繳 (365天)"
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
    title: "專業方案 Pro 年繳 (365天)"
  }
};

function formatDateYmd(ts) {
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function handleVerifyPlayPurchase(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "請先登入帳號後再進行購買驗證" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "身份憑證無效或已過期，請重新登入" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "無效的 JSON 請求內容" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const productId = String((body && body.productId) || "").trim();
  const purchaseToken = String((body && body.purchaseToken) || "").trim();
  const clientOrderId = String((body && body.orderId) || "").trim();
  const packageName = String((body && body.packageName) || EXPECTED_PACKAGE_NAME).trim();

  const skuMeta = BILLING_SKU_CATALOG[productId];
  if (!skuMeta) {
    return new Response(
      JSON.stringify({ ok: false, error: "無效的商品代碼 (Unknown SKU)" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (packageName !== EXPECTED_PACKAGE_NAME) {
    return new Response(
      JSON.stringify({ ok: false, error: "套件名稱與發卡應用程式不相符" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!purchaseToken || purchaseToken.length < 12) {
    return new Response(
      JSON.stringify({ ok: false, error: "缺少有效的 Google Play 購買憑證 (purchaseToken)" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. 取得 Firestore Admin 權限標頭（processedOrders 與寫入 coins/membership 必須具備後端管理員憑證）
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  if (!fsAuth.isAdminToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "SERVER_ADMIN_NOT_CONFIGURED",
        error: "伺服器尚未配置 FIREBASE_SERVICE_ACCOUNT 管理權限，已拒絕任何前端直寫入庫。"
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. 向 Google Play Developer API 驗證真實收據（絕不相信未驗證的用戶端請求）
  const playVerify = await verifyGooglePlayProductReceipt(env, {
    packageName,
    productId,
    purchaseToken,
    isSubscription: false
  });
  if (!playVerify.ok) {
    return new Response(
      JSON.stringify({ ok: false, code: playVerify.code, error: playVerify.error }),
      { status: playVerify.status || 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const tokenHash = await sha256Hex(purchaseToken);
  const rawOrderId = playVerify.orderId || clientOrderId || `tok_${tokenHash.slice(0, 32)}`;
  const safeOrderDocId = rawOrderId.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 120);

  // 3. 讀取使用者目前錢包與會員狀態
  const uid = verified.uid;
  const userPath = `users/${encodeURIComponent(uid)}`;
  const userRes = await firestoreGetDoc(userPath, fsAuth.Authorization);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "找不到使用者雲端資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const userData = decodeFirestoreDoc(userRes.doc);
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const nowMs = Date.now();

  // 4. 若購買會員方案，檢查是否已有有效同級或更高級會員（防止重複訂閱扣款）
  if (skuMeta.kind === "membership" && !isAdminUser) {
    const mem = userData.membership && typeof userData.membership === "object" ? userData.membership : {};
    const curTier = String(mem.tier || "free");
    const curExpires = Number(mem.expiresAt) || 0;
    const isActivePaid = curTier !== "free" && curExpires > nowMs;
    if (isActivePaid) {
      const curIdx = TIER_ORDER.indexOf(curTier);
      const targetIdx = TIER_ORDER.indexOf(skuMeta.tier);
      if (curIdx >= targetIdx) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: "ACTIVE_HIGHER_OR_SAME_TIER",
            expiresAt: curExpires,
            error: `目前已是有效會員（到期日：${formatDateYmd(curExpires)}），無需重複購買同級或較低方案。`
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  }

  // 5. 防重放帳本：先以 createIfAbsent 鎖定 processedOrders/{orderId}，確保一筆訂單只會核銷一次
  const orderRecord = {
    orderId: safeOrderDocId,
    rawOrderId,
    uid,
    productId,
    purchaseTokenHash: tokenHash,
    packageName,
    kind: skuMeta.kind,
    coinsGranted: skuMeta.kind === "coins" ? skuMeta.coins : 0,
    tierGranted: skuMeta.kind === "membership" ? skuMeta.tier : "",
    processedAt: nowMs
  };
  const lockRes = await firestoreCreateDocIfAbsent("processedOrders", safeOrderDocId, orderRecord, fsAuth.Authorization);
  if (lockRes.alreadyExists) {
    return new Response(
      JSON.stringify({
        ok: true,
        alreadyProcessed: true,
        orderId: safeOrderDocId,
        coins: Math.max(0, Math.floor(Number(userData.coins) || 0)),
        membership: userData.membership || null,
        message: "此 Google Play 訂單已完成核銷，不會重複發放或扣款。"
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 6. 原子發放金幣或開通會員天數
  let updatedPatch = {};
  let updateMasks = [];
  let newCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  let nextMembership = userData.membership && typeof userData.membership === "object"
    ? { ...userData.membership }
    : { tier: "free", tierPriceNtd: 0, startedAt: 0, expiresAt: 0, billingCycle: "monthly", totalDonatedNtd: 0, autoDowngradedAt: 0 };

  if (skuMeta.kind === "coins") {
    newCoins += skuMeta.coins;
    updatedPatch = { coins: newCoins };
    updateMasks = ["coins"];
  } else {
    const durationMs = skuMeta.days * DAY_MS;
    const newExpiresAt = nowMs + durationMs;
    nextMembership = {
      tier: skuMeta.tier,
      tierPriceNtd: skuMeta.priceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: nowMs,
      expiresAt: newExpiresAt,
      totalDonatedNtd: (Number(nextMembership.totalDonatedNtd) || 0) + skuMeta.priceNtd,
      autoDowngradedAt: 0,
      lastOrderId: safeOrderDocId
    };
    const history = Array.isArray(userData.membershipHistory) ? [...userData.membershipHistory] : [];
    history.unshift({
      tier: skuMeta.tier,
      priceNtd: skuMeta.priceNtd,
      billingCycle: skuMeta.cycle,
      startedAt: nowMs,
      expiresAt: newExpiresAt,
      source: "google_play",
      orderId: safeOrderDocId
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

  // 7. 核銷 / 確認 Google Play 訂單（避免 3 天未 acknowledge 自動退款）
  await consumeOrAckGooglePlayPurchase(env, {
    packageName,
    productId,
    purchaseToken,
    consumable: Boolean(skuMeta.consumable)
  });

  return new Response(
    JSON.stringify({
      ok: true,
      alreadyProcessed: false,
      orderId: safeOrderDocId,
      kind: skuMeta.kind,
      productId,
      coins: newCoins,
      membership: nextMembership,
      membershipHistory: updatedPatch.membershipHistory || userData.membershipHistory || [],
      cosmetics: updatedPatch.cosmetics || userData.cosmetics || null,
      message: skuMeta.kind === "coins"
        ? `🎉 儲值成功！已發放 ${skuMeta.coins} 金幣`
        : `🎉 Google Play 購買驗證成功！已開通「${skuMeta.title}」`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
