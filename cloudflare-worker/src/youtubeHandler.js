function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 32))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16) || 32));
}

function cleanCueText(raw) {
  return decodeHtmlEntities(String(raw || "").replace(/<[^>]+>/g, " "))
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function parseTimestampToMs(rawTs) {
  const s = String(rawTs || "").trim().replace(",", ".");
  if (!s) return 0;
  const parts = s.split(":").map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return Math.max(0, Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000));
  }
  if (parts.length === 2) {
    return Math.max(0, Math.round((parts[0] * 60 + parts[1]) * 1000));
  }
  return Math.max(0, Math.round(parts[0] * 1000));
}

function parseJson3Captions(json3Data) {
  const events = Array.isArray(json3Data && json3Data.events) ? json3Data.events : [];
  const cues = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs.map((s) => (s && s.utf8 ? String(s.utf8) : "")).join("");
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

function parseXmlCaptions(xmlText) {
  const cues = [];
  const rawXml = String(xmlText || "");

  const textRegex = /<text\s+[^>]*start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(rawXml)) !== null) {
    const startMs = Math.max(0, Math.round((parseFloat(match[1]) || 0) * 1000));
    const durMs = Math.max(800, Math.round((parseFloat(match[2]) || 2.5) * 1000));
    const cleaned = cleanCueText(match[3]);
    if (!cleaned) continue;
    cues.push({
      startMs,
      endMs: startMs + durMs,
      text: cleaned
    });
  }

  if (cues.length === 0) {
    // YouTube timedtext format 3 uses <p t="ms" d="ms"><s>...</s></p>
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

function parseBilibiliBccCaptions(bccJson) {
  const body = Array.isArray(bccJson && bccJson.body) ? bccJson.body : [];
  const cues = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (!item) continue;
    const text = cleanCueText(item.content || "");
    if (!text) continue;
    const startMs = Math.max(0, Math.round((Number(item.from) || 0) * 1000));
    const endMs = Math.max(startMs + 600, Math.round((Number(item.to) || (Number(item.from) || 0) + 2.5) * 1000));
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

function normalizeTrackLanguageScore(track, preferLang) {
  const code = String((track && (track.languageCode || track.lang)) || "").toLowerCase();
  const pref = String(preferLang || "").toLowerCase();
  const prefPrefix = pref.split(/[-_]/)[0];
  const isAsr = track && (track.kind === "asr" || track.ai_type === 1);
  // 人工作字幕優先於自動產生(asr)，但絕不丟棄 asr 自動字幕
  let score = isAsr ? 0 : 10;
  if (pref && code === pref) score += 200;
  else if (prefPrefix && (code === prefPrefix || code.startsWith(`${prefPrefix}-`) || code.startsWith(`${prefPrefix}_`))) score += 140;
  else if (code === "en" || code.startsWith("en-")) score += 40;
  else if (code === "ja" || code.startsWith("ja-")) score += 35;
  else if (code === "zh-tw" || code === "zh-hant") score += 25;
  return score;
}

function selectPreferredCaptionTracks(tracks, preferLang) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const pref = String(preferLang || "").trim().toLowerCase();
  const prefPrefix = pref.split(/[-_]/)[0];
  if (pref) {
    const hasLangMatch = tracks.some((t) => {
      const code = String((t && (t.languageCode || t.lang)) || "").toLowerCase();
      return code === pref || (prefPrefix && (code === prefPrefix || code.startsWith(`${prefPrefix}-`)));
    });
    if (!hasLangMatch) {
      // 若無指定語系前綴，直接保底使用 captionTracks[0] 在首位，其餘依權重排列
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

function smoothCueTimelines(cues) {
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endMs > cues[i + 1].startMs) {
      cues[i].endMs = Math.max(cues[i].startMs + 400, cues[i + 1].startMs - 40);
    }
  }
  return cues;
}

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
  } catch (e) {}
  const fallback = input.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
  return fallback ? fallback[1] : "";
}

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
  } catch (e) {}

  const host = parsed ? parsed.hostname.toLowerCase() : "";
  const pathname = parsed ? parsed.pathname : "";

  if (host.includes("bilibili.com") || host.includes("b23.tv")) {
    const bvMatch = input.match(/(BV[0-9A-Za-z]{10})/);
    const avMatch = input.match(/\/av(\d+)/i);
    return {
      platform: "bilibili",
      videoId: bvMatch ? bvMatch[1] : (avMatch ? `av${avMatch[1]}` : input),
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

function buildFallbackResponse(platform, videoId, title, errorMsg, corsHeaders) {
  return new Response(
    JSON.stringify({
      ok: false,
      platform: platform || "unknown",
      videoId: videoId || "",
      title: title || "",
      fallbackSuggested: true,
      suggestedModes: ["video", "stt"],
      error: errorMsg || "此影片未提供公開文字字幕軌，建議切換「畫面字幕」或「語音字幕」即時翻譯。"
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

function hasCaptionTracksInPlayer(playerResponse) {
  return Boolean(
    playerResponse &&
    playerResponse.captions &&
    playerResponse.captions.playerCaptionsTracklistRenderer &&
    Array.isArray(playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) &&
    playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks.length > 0
  );
}

async function fetchYouTubeSubtitles(videoId, preferLang) {
  let playerResponse = null;

  // 1. Primary: YouTube InnerTube ANDROID Player API
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
  } catch (e) {}

  // 2. Second Fallback: TVHTML5_SIMPLY_EMBEDDED_PLAYER InnerTube client (bypasses ANDROID client restrictions)
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
    } catch (e) {}
  }

  // 3. Third Fallback: Watch page HTML scraping (ytInitialPlayerResponse)
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
        const scraped =
          extractBalancedJsonObject(html, "ytInitialPlayerResponse = ") ||
          extractBalancedJsonObject(html, "var ytInitialPlayerResponse = ");
        if (scraped) playerResponse = scraped;
      }
    } catch (e) {}
  }

  const title = String(
    (playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.title) || ""
  ).trim();

  const tracks =
    (playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer &&
      playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) ||
    [];

  if (!Array.isArray(tracks) || tracks.length === 0) {
    return {
      ok: false,
      platform: "youtube",
      videoId,
      title,
      error: "此 YouTube 影片尚未提供內建字幕軌，建議使用「畫面字幕」或「語音字幕」模式"
    };
  }

  const sortedTracks = selectPreferredCaptionTracks(tracks, preferLang);
  const chosen = sortedTracks[0];
  const baseUrl = String(chosen.baseUrl || "");
  if (!baseUrl) {
    return { ok: false, platform: "youtube", videoId, title, error: "找不到有效的 YouTube 字幕下載連結" };
  }

  let cues = [];
  try {
    const json3Url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
    const json3Resp = await fetch(json3Url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (json3Resp.ok) {
      const json3Data = await json3Resp.json();
      cues = parseJson3Captions(json3Data);
    }
  } catch (e) {}

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
    } catch (e) {}
  }

  if (cues.length === 0) {
    return { ok: false, platform: "youtube", videoId, title, error: "YouTube 字幕軌內容為空" };
  }

  return {
    ok: true,
    platform: "youtube",
    videoId,
    title,
    languageCode: chosen.languageCode || "en",
    tracks: sortedTracks.slice(0, 6).map((t) => ({
      languageCode: t.languageCode,
      name: (t.name && t.name.simpleText) || t.languageCode,
      kind: t.kind || ""
    })),
    cues: smoothCueTimelines(cues)
  };
}

async function fetchBilibiliSubtitles(rawIdOrUrl, preferLang) {
  let idToken = String(rawIdOrUrl || "").trim();
  if (/b23\.tv/i.test(idToken)) {
    try {
      const redir = await fetch(idToken, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      const bvMatch = String(redir.url || "").match(/(BV[0-9A-Za-z]{10})/);
      if (bvMatch) idToken = bvMatch[1];
    } catch (e) {}
  }

  const isAv = /^av(\d+)$/i.test(idToken);
  const queryParam = isAv
    ? `aid=${encodeURIComponent(idToken.replace(/^av/i, ""))}`
    : `bvid=${encodeURIComponent(idToken)}`;

  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www.bilibili.com/"
    }
  });
  if (!viewRes.ok) {
    return { ok: false, platform: "bilibili", videoId: idToken, title: "", error: "無法讀取 Bilibili 影片資訊" };
  }
  const viewJson = await viewRes.json();
  const data = viewJson && viewJson.data;
  if (!data || !data.cid) {
    return { ok: false, platform: "bilibili", videoId: idToken, title: "", error: "找不到對應的 Bilibili 影片 CID" };
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
    tracks = (pJson && pJson.data && pJson.data.subtitle && pJson.data.subtitle.subtitles) || [];
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
      error: "此 Bilibili 影片未提供開放 CC 字幕（或需登入讀取），建議切換「畫面字幕」辨識硬字幕。"
    };
  }

  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.lan, ai_type: b.ai_type }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.lan, ai_type: a.ai_type }, preferLang)
  );
  const chosen = sortedTracks[0];
  let subUrl = String(chosen.subtitle_url || "").trim();
  if (subUrl.startsWith("//")) subUrl = "https:" + subUrl;
  if (!subUrl) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili 字幕檔網址無效" };
  }

  const subRes = await fetch(subUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!subRes.ok) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili 字幕內容下載失敗" };
  }
  const bccJson = await subRes.json();
  const cues = parseBilibiliBccCaptions(bccJson);
  if (cues.length === 0) {
    return { ok: false, platform: "bilibili", videoId: bvid, title, error: "Bilibili 字幕內容為空" };
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

async function fetchVimeoSubtitles(videoId, preferLang) {
  const cfgRes = await fetch(`https://player.vimeo.com/video/${encodeURIComponent(videoId)}/config`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://vimeo.com/"
    }
  });
  if (!cfgRes.ok) {
    return { ok: false, platform: "vimeo", videoId, title: "", error: "無法取得 Vimeo 播放器設定" };
  }
  const cfg = await cfgRes.json();
  const title = String((cfg && cfg.video && cfg.video.title) || "").trim();
  const tracks = (cfg && cfg.request && Array.isArray(cfg.request.text_tracks)) ? cfg.request.text_tracks : [];
  if (tracks.length === 0) {
    return { ok: false, platform: "vimeo", videoId, title, error: "此 Vimeo 影片尚未提供文字字幕軌" };
  }

  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.lang }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.lang }, preferLang)
  );
  const chosen = sortedTracks[0];
  let trackUrl = String(chosen.url || "").trim();
  if (trackUrl.startsWith("/")) trackUrl = `https://player.vimeo.com${trackUrl}`;
  if (!trackUrl) {
    return { ok: false, platform: "vimeo", videoId, title, error: "找不到 Vimeo 字幕檔連結" };
  }

  const vttRes = await fetch(trackUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!vttRes.ok) {
    return { ok: false, platform: "vimeo", videoId, title, error: "Vimeo 字幕檔下載失敗" };
  }
  const cues = parseVttOrSrtCaptions(await vttRes.text());
  if (cues.length === 0) {
    return { ok: false, platform: "vimeo", videoId, title, error: "Vimeo 字幕軌內容為空" };
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

async function fetchDailymotionSubtitles(videoId, preferLang) {
  const apiRes = await fetch(
    `https://api.dailymotion.com/video/${encodeURIComponent(videoId)}?fields=title,subtitles`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  let title = "";
  let tracks = [];

  if (apiRes.ok) {
    const meta = await apiRes.json();
    title = String((meta && meta.title) || "").trim();
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
  } catch (e) {}

  if (!Array.isArray(tracks) || tracks.length === 0) {
    return {
      ok: false,
      platform: "dailymotion",
      videoId,
      title,
      error: "此 Dailymotion 影片無內建外掛字幕軌，建議改用「畫面字幕」或「語音字幕」。"
    };
  }

  const sortedTracks = [...tracks].sort(
    (a, b) => normalizeTrackLanguageScore({ languageCode: b.language }, preferLang) - normalizeTrackLanguageScore({ languageCode: a.language }, preferLang)
  );
  const chosen = sortedTracks[0];
  if (!chosen || !chosen.url) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion 字幕檔網址無效" };
  }

  const subRes = await fetch(chosen.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!subRes.ok) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion 字幕下載失敗" };
  }
  const cues = parseVttOrSrtCaptions(await subRes.text());
  if (cues.length === 0) {
    return { ok: false, platform: "dailymotion", videoId, title, error: "Dailymotion 字幕內容為空" };
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
        const subTracks = (apiData && apiData.media && apiData.media.delivery && apiData.media.delivery.movie && apiData.media.delivery.movie.subtitles) || [];
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
  } catch (e) {}

  return {
    ok: false,
    platform: "niconico",
    videoId,
    title,
    error: "此 Niconico 影片無公開字幕軌，建議一鍵切換「畫面字幕」或「語音字幕」即時翻譯。"
  };
}

async function fetchTwitchSubtitles(videoId) {
  return {
    ok: false,
    platform: "twitch",
    videoId,
    title: `Twitch VOD ${videoId}`,
    error: "Twitch 直播與 VOD 字幕多為 HLS 內嵌串流，建議一鍵切換「畫面字幕」或「語音字幕」即時辨識。"
  };
}

export async function handleYoutubeSubtitles(request, env, corsHeaders) {
  const url = new URL(request.url);
  let rawVideoUrl = url.searchParams.get("url") || url.searchParams.get("videoId") || "";
  let preferLang = url.searchParams.get("lang") || "";

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body && (body.url || body.videoId)) rawVideoUrl = body.url || body.videoId;
      if (body && body.lang) preferLang = body.lang;
    } catch (e) {}
  }

  const detected = detectVideoPlatform(rawVideoUrl);
  if (!detected.platform || !detected.videoId) {
    return new Response(
      JSON.stringify({
        ok: false,
        fallbackSuggested: true,
        suggestedModes: ["video", "stt"],
        error: "無法辨識影片網址，支援 YouTube / Bilibili / Vimeo / Dailymotion / Niconico / Twitch。"
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
      } catch (e) {}
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
  } catch (e) {}

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
        (result && result.error) || "找不到可用字幕軌",
        corsHeaders
      );
    }

    const payloadString = JSON.stringify(result);

    // 僅於成功且確定擁有非空字幕 cues 時才寫入 Edge Cache（24 小時）
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
    } catch (e) {}

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
      "解析影片字幕失敗: " + (err && err.message ? err.message : String(err)),
      corsHeaders
    );
  }
}
