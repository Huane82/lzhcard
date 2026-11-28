import admin from 'firebase-admin';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface FirebaseClients {
  app: admin.app.App;
  auth: admin.auth.Auth;
  firestore: admin.firestore.Firestore;
  rtdb: admin.database.Database;
}

export async function initFirebaseAdmin(): Promise<FirebaseClients> {
  if (admin.apps.length > 0 && admin.apps[0]) {
    const app = admin.apps[0];
    return {
      app,
      auth: admin.auth(app),
      firestore: admin.firestore(app),
      rtdb: admin.database(app)
    };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || 'flashcards-5f514';
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL?.trim() ||
    'https://flashcards-5f514-default-rtdb.asia-southeast1.firebasedatabase.app';

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  let credential: admin.credential.Credential;

  if (credPath) {
    const resolved = path.resolve(credPath);
    const raw = await fs.readFile(resolved, 'utf8');
    const json = JSON.parse(raw) as admin.ServiceAccount;
    credential = admin.credential.cert(json);
  } else {
    credential = admin.credential.applicationDefault();
  }

  const app = admin.initializeApp({
    credential,
    projectId,
    databaseURL
  });

  return {
    app,
    auth: admin.auth(app),
    firestore: admin.firestore(app),
    rtdb: admin.database(app)
  };
}

export async function listAllAuthUsers(auth: admin.auth.Auth): Promise<admin.auth.UserRecord[]> {
  const users: admin.auth.UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

/**
 * Extracts raw cards from all 4 legacy & v2 Firestore storage layouts:
 *  A) manifest_v2 (deckChunkCount === -1 -> deckChunks/{deckId})
 *  B) legacy_chunk (deckChunkCount > 0 -> deckChunks/chunk_i)
 *  C) inline (userDoc.decks or userDoc.cards)
 *  D) legacy_wordlist (userDoc.wordList)
 */
export async function extractUserRawCards(
  userDocRef: admin.firestore.DocumentReference,
  userData: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const deckChunkCount = typeof userData.deckChunkCount === 'number' ? userData.deckChunkCount : null;
  const rawCards: Array<Record<string, unknown>> = [];

  if (deckChunkCount === -1 || (deckChunkCount !== null && deckChunkCount > 0)) {
    const chunksSnap = await userDocRef.collection('deckChunks').get();
    const sortedDocs = [...chunksSnap.docs].sort((a, b) => {
      const aData = a.data() || {};
      const bData = b.data() || {};
      const idxA = typeof aData.index === 'number' ? aData.index : Number.MAX_SAFE_INTEGER;
      const idxB = typeof bData.index === 'number' ? bData.index : Number.MAX_SAFE_INTEGER;
      if (idxA !== idxB) return idxA - idxB;
      return a.id.localeCompare(b.id);
    });

    for (const chunkDoc of sortedDocs) {
      const cData = chunkDoc.data() || {};
      const arr = Array.isArray(cData.decks)
        ? cData.decks
        : (Array.isArray(cData.cards) ? cData.cards : []);
      for (const item of arr) {
        if (item && typeof item === 'object') {
          rawCards.push(item as Record<string, unknown>);
        }
      }
    }
  }

  // Fallback / union if inline arrays still exist alongside or instead of deckChunks
  if (rawCards.length === 0) {
    const inlineArr = Array.isArray(userData.decks)
      ? userData.decks
      : (Array.isArray(userData.cards)
          ? userData.cards
          : (Array.isArray(userData.wordList) ? userData.wordList : []));
    for (const item of inlineArr) {
      if (item && typeof item === 'object') {
        rawCards.push(item as Record<string, unknown>);
      }
    }
  }

  return rawCards;
}
