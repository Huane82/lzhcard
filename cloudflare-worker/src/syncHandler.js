import {
  FIREBASE_PROJECT_ID,
  enforceNotBanned,
  extractBearerToken,
  verifyFirebaseToken
} from "./quotaManager.js";
import {
  firestoreGetDoc,
  firestorePatchDoc,
  getFirestoreAuthHeader
} from "./firestoreAdmin.js";

const FIRESTORE_DOC_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function firestoreDeleteDoc(docPath, authHeader) {
  const res = await fetch(`${FIRESTORE_DOC_BASE}/${docPath}`, {
    method: "DELETE",
    headers: {
      ...(authHeader ? { Authorization: authHeader } : {})
    }
  });
  return res.ok || res.status === 404;
}

export async function handleSyncBeacon(request, env, corsHeaders) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid JSON payload" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const headerToken = extractBearerToken(request);
  const bodyToken = body && typeof body.idToken === "string" ? body.idToken.trim() : "";
  const idToken = headerToken || bodyToken;

  if (!idToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing auth token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const verified = await verifyFirebaseToken(idToken);
  if (!verified || !verified.uid) {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid or expired token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const uid = verified.uid;
  const fsAuth = await getFirestoreAuthHeader(env, idToken);
  const authHeader = fsAuth.Authorization || `Bearer ${idToken}`;
  const nowMs = Date.now();

  try {
    const existingUserRes = await firestoreGetDoc(`users/${encodeURIComponent(uid)}`, authHeader);
    if (existingUserRes.exists && existingUserRes.doc) {
      const banCheck = await enforceNotBanned(uid, existingUserRes.doc, fsAuth, nowMs);
      if (banCheck && banCheck.isBanned) {
        return new Response(
          JSON.stringify({ ok: false, code: "ACCOUNT_BANNED", error: banCheck.reason || "Account is banned" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  } catch (e) {}

  const dirtyChunks = Array.isArray(body?.dirtyChunks) ? body.dirtyChunks : [];
  const deletedChunkIds = Array.isArray(body?.deletedChunkIds) ? body.deletedChunkIds : [];
  const meta = body && body.meta && typeof body.meta === "object" ? body.meta : null;

  let writtenChunks = 0;
  let deletedChunks = 0;

  // 1. 先寫入異動過的字庫分片 (users/{uid}/deckChunks/{deckId})
  for (const chunk of dirtyChunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const rawId = String(chunk.deckId || chunk.chunkId || "").trim();
    if (!rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) continue;
    const decks = Array.isArray(chunk.decks) ? chunk.decks : [];
    const payload = {
      deckId: rawId,
      hash: String(chunk.hash || ""),
      cardCount: decks.length,
      decks,
      updatedAt: Number(chunk.updatedAt) || nowMs
    };
    const masks = ["deckId", "hash", "cardCount", "decks", "updatedAt"];
    await firestorePatchDoc(
      `users/${encodeURIComponent(uid)}/deckChunks/${encodeURIComponent(rawId)}`,
      payload,
      masks,
      authHeader
    );
    writtenChunks += 1;
  }

  // 2. 更新主文件 metadata（僅在有傳送 meta 時）
  if (meta) {
    const cleanMeta = {};
    const maskPaths = [];
    if (meta.settings && typeof meta.settings === "object") {
      cleanMeta.settings = meta.settings;
      maskPaths.push("settings");
    }
    if (meta.quizScore && typeof meta.quizScore === "object") {
      cleanMeta.quizScore = meta.quizScore;
      maskPaths.push("quizScore");
    }
    if (meta.deletedDecks && typeof meta.deletedDecks === "object") {
      cleanMeta.deletedDecks = meta.deletedDecks;
      maskPaths.push("deletedDecks");
    }
    if (meta.deletedCards && typeof meta.deletedCards === "object") {
      cleanMeta.deletedCards = meta.deletedCards;
      maskPaths.push("deletedCards");
    }
    if (meta.deckManifest && typeof meta.deckManifest === "object") {
      cleanMeta.deckManifest = meta.deckManifest;
      maskPaths.push("deckManifest");
      cleanMeta.deckChunkCount = -1;
      maskPaths.push("deckChunkCount");
      cleanMeta.decks = [];
      maskPaths.push("decks");
    }
    cleanMeta.updatedAt = new Date(nowMs).toISOString();
    maskPaths.push("updatedAt");

    if (maskPaths.length > 0) {
      await firestorePatchDoc(
        `users/${encodeURIComponent(uid)}`,
        cleanMeta,
        maskPaths,
        authHeader
      );
    }
  }

  // 3. 清理已刪除字庫或過時分片文件
  for (const rawDelId of deletedChunkIds) {
    const delId = String(rawDelId || "").trim();
    if (!delId || !/^[A-Za-z0-9_-]{1,128}$/.test(delId)) continue;
    const ok = await firestoreDeleteDoc(
      `users/${encodeURIComponent(uid)}/deckChunks/${encodeURIComponent(delId)}`,
      authHeader
    );
    if (ok) deletedChunks += 1;
  }

  return new Response(
    JSON.stringify({ ok: true, writtenChunks, deletedChunks, syncedAt: nowMs }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
