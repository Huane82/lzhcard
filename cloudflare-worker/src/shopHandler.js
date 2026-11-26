import {
  FIREBASE_PROJECT_ID,
  TIER_ORDER,
  VALID_FEATURES,
  buildQuotaSnapshotPayload,
  enforceNotBanned,
  extractBearerToken,
  isUserAdminFromFields,
  parseUserQuotaState,
  verifyFirebaseToken
} from "./quotaManager.js";
import {
  decodeFirestoreDoc,
  firestoreGetDoc,
  firestorePatchDoc,
  getFirestoreAuthHeader
} from "./firestoreAdmin.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_SHIELD_COST = 80;
const STREAK_SHIELD_MAX = 3;

export const COIN_REDEEM_PACKS = {
  pack_trial_starter_7d: {
    id: "pack_trial_starter_7d",
    name: "7 天 Starter 入門會員體驗卡",
    costCoins: 80,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 7,
    trialTier: "supporter_30",
    fullMembershipDays: 0,
    fullMembershipTier: ""
  },
  redeem_starter_30d: {
    id: "redeem_starter_30d",
    name: "30 天 Starter 入門會員",
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
    name: "30 天 Plus 進階會員",
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
    name: "30 天 Pro 專業會員",
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
  },
  redeem_teacher_30d: {
    id: "redeem_teacher_30d",
    name: "30 天班級教師方案 (含50人共享)",
    costCoins: 1960,
    credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
    trialDays: 0,
    trialTier: "",
    fullMembershipDays: 30,
    fullMembershipTier: "teacher_class",
    priceNtdValue: 490,
    frameId: "supporter_celestial_crown",
    bannerId: "supporter_imperial_aurora",
    titleId: "supporter_crown"
  }
};

export const PAID_COSMETICS_CATALOG = {
  "frames:paid_gold_dragon": {
    type: "frames",
    id: "paid_gold_dragon",
    name: "金龍聖環",
    coinPrice: 80
  },
  "frames:paid_nebula_prism": {
    type: "frames",
    id: "paid_nebula_prism",
    name: "星雲稜鏡",
    coinPrice: 120
  },
  "frames:paid_jade_emperor": {
    type: "frames",
    id: "paid_jade_emperor",
    name: "翡翠帝冠",
    coinPrice: 160
  },
  "banners:paid_cyber_tokyo": {
    type: "banners",
    id: "paid_cyber_tokyo",
    name: "賽博東京夜",
    coinPrice: 100
  },
  "banners:paid_golden_sanctuary": {
    type: "banners",
    id: "paid_golden_sanctuary",
    name: "黃金聖殿",
    coinPrice: 150
  },
  "banners:paid_celestial_eclipse": {
    type: "banners",
    id: "paid_celestial_eclipse",
    name: "天穹日蝕",
    coinPrice: 200
  },
  "titles:paid_vocab_tycoon": {
    type: "titles",
    id: "paid_vocab_tycoon",
    name: "詞彙大亨",
    coinPrice: 80
  },
  "titles:paid_polyglot_legend": {
    type: "titles",
    id: "paid_polyglot_legend",
    name: "多語傳奇",
    coinPrice: 150
  }
};

function formatDateYmd(ts) {
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function handleBuyDeck(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ error: "未授權請求，缺少身份憑證 Token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ error: "身份憑證無效或已過期，請重新登入" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const buyerUid = verified.uid;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "無效的 JSON 請求內容" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const normalizedDeckId = String((body && body.deckId) || "").trim();
  if (!normalizedDeckId) {
    return new Response(
      JSON.stringify({ error: "缺少商品字庫 ID" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;

  // 1. 伺服器端讀取字庫真實定價與作者，絕不信任前端傳來的 price / authorId
  const deckRes = await firestoreGetDoc(`storeDecks/${encodeURIComponent(normalizedDeckId)}`, authHeader);
  if (!deckRes.exists) {
    return new Response(
      JSON.stringify({ error: "找不到該商城字庫" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const deckData = decodeFirestoreDoc(deckRes.doc);
  const price = Math.max(0, Math.floor(Number(deckData.price) || 0));
  const authorId = String(deckData.authorId || "").trim();

  // 2. 讀取買家資料與管理員狀態
  const buyerPath = `users/${encodeURIComponent(buyerUid)}`;
  const buyerRes = await firestoreGetDoc(buyerPath, authHeader);
  if (!buyerRes.exists) {
    return new Response(
      JSON.stringify({ error: "找不到買家使用者資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const buyerData = decodeFirestoreDoc(buyerRes.doc);
  const banCheck = await enforceNotBanned(buyerUid, buyerRes.doc, fsAuth, Date.now());
  if (banCheck.banned) {
    return new Response(
      JSON.stringify({ ok: false, code: "ACCOUNT_BANNED", error: `此帳號已被封鎖：${banCheck.ban.reason || "違反規範"}`, ban: banCheck.ban }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const isAdminUser = isUserAdminFromFields(buyerRes.doc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(buyerData.coins) || 0));
  const purchasedIds = Array.isArray(buyerData.purchasedDeckIds)
    ? buyerData.purchasedDeckIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  if (purchasedIds.includes(normalizedDeckId)) {
    return new Response(
      JSON.stringify({
        success: true,
        alreadyPurchased: true,
        newCoins: currentCoins,
        message: "您已購買過此字庫，本次免費重新取得"
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const effectiveCharge = (isAdminUser || authorId === buyerUid) ? 0 : price;
  if (currentCoins < effectiveCharge) {
    return new Response(
      JSON.stringify({ error: `金幣不足！購買需要 ${effectiveCharge} 金幣，您目前只有 ${currentCoins} 金幣` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const newBuyerCoins = currentCoins - effectiveCharge;
  const sellerEarnings = Math.floor(effectiveCharge * 0.7);
  const nextPurchasedIds = Array.from(new Set([...purchasedIds, normalizedDeckId]));

  try {
    await firestorePatchDoc(
      buyerPath,
      { coins: newBuyerCoins, purchasedDeckIds: nextPurchasedIds },
      ["coins", "purchasedDeckIds"],
      authHeader
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "伺服器金幣扣款失敗，請確認已設定管理員服務帳號憑證" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 寫入伺服器權威 purchaser 標記（配合 firestore.rules 封鎖前端自寫 purchasers）
  try {
    await firestorePatchDoc(
      `storeDecks/${encodeURIComponent(normalizedDeckId)}/purchasers/${encodeURIComponent(buyerUid)}`,
      { uid: buyerUid, price: effectiveCharge, purchasedAtMs: Date.now() },
      ["uid", "price", "purchasedAtMs"],
      authHeader
    );
  } catch (e) {}

  // 賣家收益劃轉 (70%)
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
      console.warn("劃轉賣家收益失敗:", e.message);
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      alreadyPurchased: false,
      newCoins: newBuyerCoins,
      charged: effectiveCharge,
      message: isAdminUser ? "管理員特權：已免費解鎖此字庫" : `交易成功！扣除 ${effectiveCharge} 金幣`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

export async function handleRedeemCoinsForQuota(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "請先使用 Google 帳號登入後再進行金幣兌換" }),
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

  const packId = String((body && body.packId) || "").trim();
  const pack = COIN_REDEEM_PACKS[packId];
  if (!pack) {
    return new Response(
      JSON.stringify({ ok: false, error: "無效的兌換方案代碼" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);

  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "找不到使用者雲端資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const userDoc = userRes.doc;
  const userData = decodeFirestoreDoc(userDoc);
  const banCheck = await enforceNotBanned(verified.uid, userDoc, fsAuth, Date.now());
  if (banCheck.banned) {
    return new Response(
      JSON.stringify({ ok: false, code: "ACCOUNT_BANNED", error: `此帳號已被封鎖：${banCheck.ban.reason || "違反規範"}`, ban: banCheck.ban }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const isAdminUser = isUserAdminFromFields(userDoc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const nowMs = Date.now();

  // 若兌換正式會員天數方案，先檢查是否已有有效同級或更高級會員
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
            error: `目前已是有效會員（到期日：${formatDateYmd(curExp)}），無需重複兌換同級或較低方案。`
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
        error: `商店金幣不足！需要 ${effectiveCost} 金幣，您目前共有 ${currentCoins} 金幣`
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const newCoins = currentCoins - effectiveCost;

  // A. 30天完整會員兌換
  if (pack.fullMembershipDays > 0 && pack.fullMembershipTier) {
    const newExpiresAt = nowMs + pack.fullMembershipDays * DAY_MS;
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
    const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object"
      ? { ...userData.cosmetics }
      : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
    if (pack.frameId) nextCosmetics.frame = pack.frameId;
    if (pack.bannerId) nextCosmetics.banner = pack.bannerId;
    if (pack.titleId) nextCosmetics.title = pack.titleId;

    const updatedDoc = await firestorePatchDoc(
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
    const nextQuota = buildQuotaSnapshotPayload(parseUserQuotaState(updatedDoc, nowMs));

    return new Response(
      JSON.stringify({
        ok: true,
        packId: pack.id,
        packName: pack.name,
        newCoins,
        membership: nextMembership,
        membershipHistory: history.slice(0, 20),
        cosmetics: nextCosmetics,
        quota: nextQuota,
        message: `🎉 成功以金幣兌換「${pack.name}」！`
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // B. 配額補充包或 7 天體驗卡
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
    const addMs = pack.trialDays * DAY_MS;
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
      message: `🎉 成功兌換「${pack.name}」！`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

export async function handleBuyCosmetic(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "請先登入帳號再購買專屬外觀" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "身份憑證無效或已過期" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "無效的 JSON 請求" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const type = String((body && body.type) || "").trim();
  const id = String((body && body.id) || "").trim();
  const catalogKey = `${type}:${id}`;
  const item = PAID_COSMETICS_CATALOG[catalogKey];
  if (!item) {
    return new Response(
      JSON.stringify({ ok: false, error: "找不到該付費外觀商品" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "找不到使用者雲端資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const userData = decodeFirestoreDoc(userRes.doc);
  const banCheck = await enforceNotBanned(verified.uid, userRes.doc, fsAuth, Date.now());
  if (banCheck.banned) {
    return new Response(
      JSON.stringify({ ok: false, code: "ACCOUNT_BANNED", error: `此帳號已被封鎖：${banCheck.ban.reason || "違反規範"}`, ban: banCheck.ban }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const purchasedCosmetics = Array.isArray(userData.purchasedCosmetics)
    ? userData.purchasedCosmetics.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  if (purchasedCosmetics.includes(catalogKey)) {
    return new Response(
      JSON.stringify({
        ok: true,
        alreadyOwned: true,
        newCoins: currentCoins,
        purchasedCosmetics,
        cosmetics: userData.cosmetics || null,
        message: "您已擁有此限定外觀，已可直接裝備！"
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const cost = isAdminUser ? 0 : item.coinPrice;
  if (currentCoins < cost) {
    return new Response(
      JSON.stringify({ ok: false, error: `金幣不足！需要 ${cost} 金幣，目前僅有 ${currentCoins} 金幣` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const newCoins = currentCoins - cost;
  const nextPurchasedCosmetics = Array.from(new Set([...purchasedCosmetics, catalogKey]));
  const nextCosmetics = userData.cosmetics && typeof userData.cosmetics === "object"
    ? { ...userData.cosmetics }
    : { frame: "default", banner: "default", title: "newcomer", unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };

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
      message: isAdminUser
        ? `管理員特權：已免費解鎖並裝備「${item.name}」！`
        : `🎉 成功購買並裝備「${item.name}」！`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

export async function handleBuyStreakShield(request, env, corsHeaders) {
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "請先登入帳號再購買連勝護盾" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "身份憑證無效或已過期" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const userPath = `users/${encodeURIComponent(verified.uid)}`;
  const userRes = await firestoreGetDoc(userPath, authHeader);
  if (!userRes.exists) {
    return new Response(
      JSON.stringify({ ok: false, error: "找不到使用者資料" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const userData = decodeFirestoreDoc(userRes.doc);
  const banCheck = await enforceNotBanned(verified.uid, userRes.doc, fsAuth, Date.now());
  if (banCheck.banned) {
    return new Response(
      JSON.stringify({ ok: false, code: "ACCOUNT_BANNED", error: `此帳號已被封鎖：${banCheck.ban.reason || "違反規範"}`, ban: banCheck.ban }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const isAdminUser = isUserAdminFromFields(userRes.doc.fields || {});
  const progression = userData.progression && typeof userData.progression === "object"
    ? { ...userData.progression }
    : { xp: 0, level: 1, streakDays: 0, streakShields: 0, lastActiveDate: "", rankTier: "青銅 III", rankPoints: 0, duelWins: 0, duelTotal: 0 };

  const currentShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Math.floor(Number(progression.streakShields) || 0)));
  if (currentShields >= STREAK_SHIELD_MAX) {
    return new Response(
      JSON.stringify({ ok: false, error: `連勝冷凍護盾已達上限（最多 ${STREAK_SHIELD_MAX} 個）` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const currentCoins = Math.max(0, Math.floor(Number(userData.coins) || 0));
  const cost = isAdminUser ? 0 : STREAK_SHIELD_COST;
  if (currentCoins < cost) {
    return new Response(
      JSON.stringify({ ok: false, error: `金幣不足！需要 ${cost} 金幣，目前僅有 ${currentCoins} 金幣` }),
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
      message: `🛡️ 成功購買連勝冷凍護盾！（目前持有 ${progression.streakShields}/${STREAK_SHIELD_MAX} 個）`
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}