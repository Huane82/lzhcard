import {
  authorizeAndConsumeQuota,
  normalizeFeatureName
} from "./quotaManager.js";

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

function stripThinkTags(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function stripSubtitleQuotes(text) {
  return stripThinkTags(text)
    .replace(/^["'「『]|["'」』]$/g, "")
    .trim();
}

async function callGroqTextCompletion(promptText, env, priority = 1) {
  if (!env.GROQ_API_KEY || !promptText) return null;
  const models = priority >= 3
    ? [env.GROQ_MODEL || "qwen/qwen3-32b", "llama-3.1-8b-instant"]
    : ["llama-3.1-8b-instant", env.GROQ_MODEL || "qwen/qwen3-32b"];

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
    } catch (e) {}
  }
  return null;
}

export async function handleGeminiAi(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "無效的 JSON 請求內容" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const hasMedia = contentsHasInlineMedia(body && body.contents);
  const feature = normalizeFeatureName(
    (body && body.feature) || request.headers.get("X-AI-Feature") || "",
    hasMedia
  );

  // 1. 伺服器端強制驗證會員方案與每日/每月硬上限
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

  // 2. 模型智能路由：純文字查詞/單字卡欄位優先走極速低成本 Groq，多模態視覺與長文題組走 Gemini
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
      JSON.stringify({ error: "伺服器未設定 GEMINI_API_KEY 環境變數" }),
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
    JSON.stringify(lastErrorData || { error: "所有 Gemini 模型皆回應失敗" }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

export async function handleFastRefine(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "無效的 JSON 請求內容" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const text = String((body && body.text) || "").trim();
  if (!text) {
    return new Response(
      JSON.stringify({ ok: false, error: "缺乏待精修原文" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 伺服器端強制驗證 fast_refine 配額（Free 方案自動回傳 429 並引導前端留守免費極速直譯）
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

  const targetLangName = String((body && body.targetLangName) || "Traditional Chinese (繁體中文)").trim();
  const draftTranslation = String((body && body.draftTranslation) || "").trim();
  const contextLines = Array.isArray(body && body.contextLines)
    ? body.contextLines.map((l) => String(l || "").trim()).filter(Boolean).slice(-4)
    : [];

  const contextBlock = contextLines.length > 0
    ? `前文語境（僅供連貫參考，勿重複翻譯）：\n${contextLines.join("\n")}\n\n`
    : "";
  const draftHint = draftTranslation ? `初步直譯參考：${draftTranslation}\n` : "";

  const systemPrompt = `You are a low-latency subtitle interpreter. Translate the current subtitle line naturally and concisely into ${targetLangName} using the prior context lines. Output ONLY the final translated subtitle string with zero explanation, no quotes, and no markdown.`;
  const userPrompt = `${contextBlock}${draftHint}目前這句原文：\n${text}`;

  // Tier-2 優先通道：Groq (高階用戶優先走高精度 Qwen3-32B，標準方案優先走極速 Llama-3.1-8B)
  if (env.GROQ_API_KEY) {
    const groqModels = (quotaCheck.priority || 1) >= 3
      ? [env.GROQ_MODEL || "qwen/qwen3-32b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
      : ["llama-3.1-8b-instant", env.GROQ_MODEL || "qwen/qwen3-32b"];

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
      } catch (e) {}
    }
  }

  // Tier-2 後援通道：Gemini Flash-Lite
  if (env.GEMINI_API_KEY) {
    const geminiFastModels = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
    for (const model of geminiFastModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }]
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
      } catch (e) {}
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