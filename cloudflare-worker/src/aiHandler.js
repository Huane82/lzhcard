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

function base64ToUint8Array(b64) {
  const clean = String(b64 || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return { bytes, cleanBase64: clean };
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function mimeTypeToAudioExt(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";
  return "webm";
}

function normalizeWhisperLangCode(rawLang) {
  const l = String(rawLang || "").trim().toLowerCase();
  if (!l || l === "auto") return "";
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  if (l.startsWith("en")) return "en";
  return l.split(/[-_]/)[0];
}

export async function handleAudioStt(request, env, corsHeaders) {
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
      const rawB64 = String((body && (body.audioBase64 || body.audio || body.data)) || "").trim();
      mimeType = String((body && body.mimeType) || "audio/webm").trim();
      language = String((body && body.language) || "").trim();
      promptHint = String((body && body.prompt) || "").trim();
      if (rawB64) {
        const decoded = base64ToUint8Array(rawB64);
        audioBytes = decoded.bytes;
        cleanBase64 = decoded.cleanBase64;
      }
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "無法解析語音辨識音訊請求" }),
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
      JSON.stringify({ ok: false, error: "音訊片段過大，請縮短錄音時間" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const userApiKey = String(request.headers.get("X-User-Api-Key") || "").trim();
  const groqKey = userApiKey.startsWith("gsk_") ? userApiKey : String(env.GROQ_API_KEY || "").trim();
  const geminiKey = (!userApiKey.startsWith("gsk_") && userApiKey) ? userApiKey : String(env.GEMINI_API_KEY || "").trim();

  // 1. Primary: Groq Whisper (whisper-large-v3-turbo)
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
        const text = String((groqData && groqData.text) || "").trim();
        return new Response(
          JSON.stringify({ ok: true, text, engine: "groq:whisper-large-v3-turbo" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } catch (e) {}
  }

  // 2. Fallback: Gemini inline audio transcription
  if (geminiKey) {
    const cleanMime = mimeType.split(";")[0].trim() || "audio/webm";
    const GEMINI_STT_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash-lite"];
    const sttPrompt = language && language !== "auto"
      ? `Transcribe the spoken audio accurately (expected language: ${language}). Output ONLY the exact spoken transcript with zero explanation, no quotes, and no timestamps. If there is only silence or noise, return an empty string.`
      : "Transcribe the spoken audio accurately in its original language. Output ONLY the exact spoken transcript with zero explanation, no quotes, and no timestamps. If there is only silence or noise, return an empty string.";

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
      } catch (e) {}
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: "語音轉文字服務暫時無法連線（請確認 GROQ_API_KEY 或 GEMINI_API_KEY）" }),
    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}