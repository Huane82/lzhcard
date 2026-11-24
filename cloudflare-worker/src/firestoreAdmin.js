export const FIREBASE_PROJECT_ID = "flashcards-5f514";
const FIRESTORE_DOC_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const ANDROID_PUBLISHER_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

const tokenCache = {
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

function pemToArrayBuffer(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

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

export function getServiceAccount(env, preferPlay = false) {
  if (!env) return null;
  const primary = preferPlay
    ? (env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT)
    : (env.FIREBASE_SERVICE_ACCOUNT || env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  return parseServiceAccountJson(primary);
}

export async function getGoogleAccessToken(sa, scope, cacheSlot = "firestore") {
  if (!sa || !sa.client_email || !sa.private_key) return "";
  const nowSec = Math.floor(Date.now() / 1000);
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

export async function getFirestoreAuthHeader(env, fallbackIdToken = "") {
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

export function encodeFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
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
      if (v !== undefined) {
        fields[k] = encodeFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

export function decodeFirestoreValue(fieldObj) {
  if (!fieldObj || typeof fieldObj !== "object") return undefined;
  if (fieldObj.nullValue !== undefined) return null;
  if (fieldObj.booleanValue !== undefined) return Boolean(fieldObj.booleanValue);
  if (fieldObj.integerValue !== undefined) return Number(fieldObj.integerValue);
  if (fieldObj.doubleValue !== undefined) return Number(fieldObj.doubleValue);
  if (fieldObj.stringValue !== undefined) return fieldObj.stringValue;
  if (fieldObj.timestampValue !== undefined) return fieldObj.timestampValue;
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
  return undefined;
}

export function decodeFirestoreDoc(doc) {
  if (!doc || !doc.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}

export async function firestoreGetDoc(docPath, authHeader) {
  const url = `${FIRESTORE_DOC_BASE}/${docPath}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {})
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

export async function firestorePatchDoc(docPath, plainFields, maskPaths, authHeader) {
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
      ...(authHeader ? { Authorization: authHeader } : {})
    },
    body: JSON.stringify({ fields: encodedFields })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firestore PATCH failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  return await res.json();
}

export async function firestoreCreateDocIfAbsent(collectionPath, docId, plainFields, authHeader) {
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
        ...(authHeader ? { Authorization: authHeader } : {})
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

export async function firestoreDeleteDoc(docPath, authHeader) {
  const res = await fetch(`${FIRESTORE_DOC_BASE}/${docPath}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {})
    }
  });
  if (res.status === 404) return { deleted: false, notFound: true };
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firestore DELETE failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  return { deleted: true };
}

export async function firestoreListCollection(collectionPath, authHeader, { pageSize = 200, maxPages = 15 } = {}) {
  const docs = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(`${FIRESTORE_DOC_BASE}/${collectionPath}?${qs.toString()}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {})
      }
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Firestore LIST failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    if (Array.isArray(json.documents)) {
      docs.push(...json.documents);
    }
    pageToken = json.nextPageToken || "";
    if (!pageToken) break;
  }
  return docs;
}

export async function checkAdminsDocExists(uid, authHeader) {
  if (!uid || !authHeader) return false;
  try {
    const res = await firestoreGetDoc(`admins/${encodeURIComponent(uid)}`, authHeader);
    return Boolean(res && res.exists);
  } catch (e) {
    return false;
  }
}

export async function verifyGooglePlayProductReceipt(env, { packageName, productId, purchaseToken, isSubscription = false }) {
  const sa = getServiceAccount(env, true);
  if (!sa || !sa.client_email || !sa.private_key) {
    return {
      ok: false,
      code: "PLAY_BILLING_NOT_CONFIGURED",
      status: 503,
      error: "伺服器尚未設定 GOOGLE_PLAY_SERVICE_ACCOUNT_JSON，無法驗證 Google Play 收據。"
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
      error: `Google Play API 憑證授權失敗：${e.message}`
    };
  }

  const pkg = encodeURIComponent(packageName);
  const pid = encodeURIComponent(productId);
  const ptok = encodeURIComponent(purchaseToken);

  if (isSubscription) {
    const subUrl = `${ANDROID_PUBLISHER_BASE}/applications/${pkg}/purchases/subscriptionsv2/tokens/${ptok}`;
    const res = await fetch(subUrl, {
      headers: { Authorization: `Bearer ${playToken}` }
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        ok: false,
        code: "PLAY_RECEIPT_INVALID",
        status: 400,
        error: `Google Play 訂閱收據驗證失敗 (${res.status}): ${txt.slice(0, 120)}`
      };
    }
    const subData = await res.json();
    const state = String(subData.subscriptionState || "");
    const active = state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
    if (!active) {
      return {
        ok: false,
        code: "PLAY_SUBSCRIPTION_INACTIVE",
        status: 400,
        error: `Google Play 訂閱狀態無效：${state || "UNKNOWN"}`
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
      error: `Google Play 商品收據驗證失敗 (${res.status}): ${txt.slice(0, 120)}`
    };
  }
  const prodData = await res.json();
  // purchaseState: 0 = Purchased, 1 = Canceled, 2 = Pending
  if (Number(prodData.purchaseState) !== 0) {
    return {
      ok: false,
      code: "PLAY_PURCHASE_NOT_COMPLETED",
      status: 400,
      error: `此 Google Play 交易尚未完成或已取消 (state=${prodData.purchaseState})`
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

export async function consumeOrAckGooglePlayPurchase(env, { packageName, productId, purchaseToken, consumable = false }) {
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

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
