import { handleAudioStt, handleFastRefine, handleGeminiAi } from "./src/aiHandler.js";
import {
  handleVerifyAndroidPurchase,
  handleVerifyIosPurchase,
  handleVerifyPlayPurchase,
  handleVerifyWebPurchase,
  handleWebCheckout
} from "./src/billingHandler.js";
import { handleGetQuotaStatus } from "./src/quotaManager.js";
import {
  handleBuyCosmetic,
  handleBuyDeck,
  handleBuyStreakShield,
  handleRedeemCoinsForQuota
} from "./src/shopHandler.js";
import { handleYoutubeSubtitles } from "./src/youtubeHandler.js";

export default {
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

    // 1. 檢測 User-Agent 與請求類型
    const ua = request.headers.get("user-agent") || "";
    const isIosInApp = /iPhone|iPad|iPod/i.test(ua) && (ua.includes("Instagram") || ua.includes("FB") || ua.includes("FBAV") || ua.includes("FBAN"));

    // 2. 僅針對 iOS 的 IG / FB「網頁開啟 (GET)」請求傳送下載標頭，觸發系統呼叫外部 Safari
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
      // 路由 1：三通道購買驗證與防重放（Android Play / Apple App Store / Web）
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

      // 路由 2：商店金幣交易（字庫購買）
      if (pathname.endsWith("/buy-deck") && request.method === "POST") {
        return await handleBuyDeck(request, env, corsHeaders);
      }

      // 路由 3：商店金幣兌換 AI 配額補充包 / 體驗卡 / 30天正式會員
      if (pathname.endsWith("/membership/redeem-coins") && request.method === "POST") {
        return await handleRedeemCoinsForQuota(request, env, corsHeaders);
      }

      // 路由 4：付費專屬外觀購買
      if (pathname.endsWith("/cosmetics/buy") && request.method === "POST") {
        return await handleBuyCosmetic(request, env, corsHeaders);
      }

      // 路由 5：連勝冷凍護盾購買
      if (pathname.endsWith("/shop/buy-shield") && request.method === "POST") {
        return await handleBuyStreakShield(request, env, corsHeaders);
      }

      // 路由 6：查詢即時 AI 配額狀態
      if (pathname.endsWith("/ai/quota-status") && (request.method === "GET" || request.method === "POST")) {
        return await handleGetQuotaStatus(request, env, corsHeaders);
      }

      // 路由 7：YouTube / 跨平台時間軸字幕解析（含 24 小時 Edge Cache，不快取空值）
      if (pathname.endsWith("/youtube/subtitles") && (request.method === "GET" || request.method === "POST")) {
        return await handleYoutubeSubtitles(request, env, corsHeaders);
      }

      // 路由 8：即時雙語字幕 Tier-2 語境快速精修 (Groq -> Gemini Flash-Lite)
      if (pathname.endsWith("/ai/fast-refine") && request.method === "POST") {
        return await handleFastRefine(request, env, corsHeaders);
      }

      // 路由 9：語音字幕 MediaRecorder 音訊轉文字 (Groq Whisper -> Gemini 音訊)
      if (pathname.endsWith("/api/ai/stt") && request.method === "POST") {
        return await handleAudioStt(request, env, corsHeaders);
      }

      // 預設路由：Gemini / Groq 智能路由 AI 解析與配額管控 (/ 或 /ai/proxy)
      return await handleGeminiAi(request, env, corsHeaders);

    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Worker 內部例外: " + err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};