var wordList = [];
if (typeof window !== 'undefined') {
  window.wordList = wordList;
}

/**
 * 🌐 取得預設字庫名稱（相容 i18n）
 */
function getStorageDefaultCatName() {
  if (typeof t === 'function') {
    const val = t('defaultCategoryName');
    if (val && val !== 'defaultCategoryName') return val;
  }
  return '預設字庫';
}

/**
 * 🔐 決定性 64-bit FNV1a + 混淆雙雜湊 (穩定產生跨裝置一致的唯一 ID)
 */
function hashStringStableHex(inputStr) {
  const str = String(inputStr || '');
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (ch + ((i + 1) * 31));
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function normalizeDeckCategoryName(categoryName, fallbackName = null) {
  const fallback = fallbackName || getStorageDefaultCatName();
  const clean = String(categoryName || '').trim().replace(/\s+/g, ' ');
  return clean || fallback;
}

function normalizeCardWordText(word) {
  return String(word || '').trim().replace(/\s+/g, ' ');
}

function generateDeterministicDeckId(categoryName) {
  const cleanCat = normalizeDeckCategoryName(categoryName).toLowerCase();
  return 'deck_' + hashStringStableHex('deck::' + cleanCat);
}

function generateDeterministicCardId(categoryName, word) {
  const cleanCat = normalizeDeckCategoryName(categoryName).toLowerCase();
  const cleanWord = normalizeCardWordText(word).toLowerCase();
  return 'card_' + hashStringStableHex('card::' + cleanCat + '::' + cleanWord);
}

if (typeof window !== 'undefined') {
  window.generateDeterministicDeckId = generateDeterministicDeckId;
  window.generateDeterministicCardId = generateDeterministicCardId;
}

/**
 * 🔢 安全數值轉換（徹底阻絕 NaN / Infinity 進入 Firestore 導致整包寫入失敗）
 */
function toFiniteNumber(val, fallback = 0) {
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * 🧹 遞迴淨化任何物件，移除 undefined / NaN / Infinity / function
 */
function deepSanitizeForFirestore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => deepSanitizeForFirestore(item));
  }
  if (typeof value === 'object') {
    const cleanObj = {};
    Object.keys(value).forEach(key => {
      const v = value[key];
      if (v !== undefined && typeof v !== 'function') {
        cleanObj[key] = deepSanitizeForFirestore(v);
      }
    });
    return cleanObj;
  }
  return String(value);
}

/**
 * 🗄️ IndexedDB 本機大型資料庫封裝（突破 localStorage 5MB 上限，支援數萬筆完整單字）
 */
const LocalIDB = {
  DB_NAME: 'LZHCard_LocalDB',
  DB_VERSION: 1,
  STORE_NAME: 'kv_store',
  _dbPromise: null,

  isSupported() {
    return typeof indexedDB !== 'undefined';
  },

  open() {
    if (!this.isSupported()) {
      return Promise.reject(new Error('IndexedDB not supported'));
    }
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            db.createObjectStore(this.STORE_NAME);
          }
        };

        request.onsuccess = (event) => {
          const db = event.target.result;
          db.onclose = () => { this._dbPromise = null; };
          db.onversionchange = () => {
            db.close();
            this._dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = (event) => {
          this._dbPromise = null;
          reject(event.target.error || new Error('IndexedDB open error'));
        };
      } catch (err) {
        this._dbPromise = null;
        reject(err);
      }
    });

    return this._dbPromise;
  },

  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
  },

  async remove(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

/**
 * 🏆 比較兩張單字卡的學習進度（回傳 > 0 代表 a 進度高於 b）
 */
function compareCardProgress(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const aLearned = (a.state && a.state !== 'new') ? 1 : 0;
  const bLearned = (b.state && b.state !== 'new') ? 1 : 0;
  if (aLearned !== bLearned) return aLearned - bLearned;

  const aLv = toFiniteNumber(a.level, 1);
  const bLv = toFiniteNumber(b.level, 1);
  if (aLv !== bLv) return aLv - bLv;

  const aStab = toFiniteNumber(a.stability, 0);
  const bStab = toFiniteNumber(b.stability, 0);
  if (Math.abs(aStab - bStab) > 0.001) return aStab - bStab;

  const aReps = toFiniteNumber(a.reps, 0) + toFiniteNumber(a.knowStreak ?? a.streak, 0);
  const bReps = toFiniteNumber(b.reps, 0) + toFiniteNumber(b.knowStreak ?? b.streak, 0);
  if (aReps !== bReps) return aReps - bReps;

  const completeness = (c) =>
    (c.meaning ? 1 : 0) +
    (c.sentence ? 1 : 0) +
    (c.phonetic ? 1 : 0) +
    (c.pos ? 1 : 0) +
    (c.translation ? 1 : 0);

  return completeness(a) - completeness(b);
}

/**
 * 🔍 跨字庫去重（依單字小寫去重，只保留進度最高的那一張）
 */
function deduplicateWordsByHighestProgress(cards) {
  if (!Array.isArray(cards)) return [];
  const result = [];
  const indexByWord = new Map();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card || typeof card !== 'object') continue;

    const norm = (card.word || '').trim().toLowerCase();
    if (!norm) {
      result.push(card);
      continue;
    }

    if (!indexByWord.has(norm)) {
      indexByWord.set(norm, result.length);
      result.push(card);
    } else {
      const existingIdx = indexByWord.get(norm);
      if (compareCardProgress(card, result[existingIdx]) > 0) {
        result[existingIdx] = card;
      }
    }
  }

  return result;
}

/**
 * 🔄 跨字庫進度同步（同步更新其他字庫中的同名單字，含 FSRS 與自由加練進度）
 */
function syncDuplicateWordsProgress(sourceCard, decks = wordList) {
  if (!sourceCard || !Array.isArray(decks)) return 0;
  const norm = (sourceCard.word || '').trim().toLowerCase();
  if (!norm) return 0;

  let syncedCount = 0;
  for (let i = 0; i < decks.length; i++) {
    const target = decks[i];
    if (!target || target === sourceCard) continue;
    if ((target.word || '').trim().toLowerCase() === norm) {
      target.level = toFiniteNumber(sourceCard.level, 1);
      target.state = sourceCard.state || 'new';
      target.stability = toFiniteNumber(sourceCard.stability, 0);
      target.difficulty = toFiniteNumber(sourceCard.difficulty, 5.5);
      target.reps = toFiniteNumber(sourceCard.reps, 0);
      target.lapses = toFiniteNumber(sourceCard.lapses, 0);
      target.knowStreak = toFiniteNumber(sourceCard.knowStreak, 0);
      target.lastReview = toFiniteNumber(sourceCard.lastReview, 0);
      target.nextReview = toFiniteNumber(sourceCard.nextReview, 0);
      target.freeLevel = toFiniteNumber(sourceCard.freeLevel, 1);
      target.freeStreak = toFiniteNumber(sourceCard.freeStreak, 0);
      target.updatedAt = toFiniteNumber(sourceCard.updatedAt, Date.now());
      syncedCount++;
    }
  }
  return syncedCount;
}

const StorageEngine = {
  LOCAL_DECKS_KEY: 'flashcards_decks',
  LOCAL_APIKEY_KEY: 'flashcard_gemini_key_v1',
  LOCAL_DIRTY_KEY: 'lzhcard_dirty_sync',
  LOCAL_DELETED_KEY: 'lzhcard_deleted_keys',
  LOCAL_QUIZ_SCORE_KEY: 'lzhcard_quiz_score',
  LOCAL_OWNER_KEY: 'lzhcard_active_uid',
  CHUNK_TARGET_BYTES: 350000, // 每個雲端分片上限約 350 KB（遠低於 Firestore 1MB 限制）
  _cloudSaveTimer: null,
  _retryTimer: null,
  _retryCount: 0,
  _inFlightLoad: null,
  _isFlushing: false,
  _hasPendingFlush: false,
  _lastSyncErrorToastAt: 0,
  _lastKnownDecks: null,
  _deletedKeysCache: null,
  _deletedKeysCacheUid: undefined,
  _hasLoadedOnce: false,
  _loadedUid: undefined,
  _loadedOffline: false,
  _needsReconnectSync: false,
  _isReconnectingSync: false,
  _reconnectTimer: null,
  _saveQueue: Promise.resolve(),

  getCurrentUid() {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
      return firebase.auth().currentUser.uid;
    }
    if (typeof auth !== 'undefined' && auth && auth.currentUser) {
      return auth.currentUser.uid;
    }
    return null;
  },

  getScopedKey(baseKey, uid = this.getCurrentUid()) {
    return `${baseKey}__${uid || 'guest'}`;
  },

  clearCrossAccountLocalCache() {
    localStorage.removeItem(this.LOCAL_APIKEY_KEY);
    localStorage.removeItem('lzhcard_onboarding_completed');
    localStorage.removeItem('lzhcard_onboarding_v2_done');
    localStorage.removeItem('lzhcard_native_lang');
    localStorage.removeItem('lzhcard_target_lang');
    localStorage.removeItem('lzhcard_custom_native');
    localStorage.removeItem('lzhcard_custom_target');
    localStorage.removeItem('lzhcard_display_mode');
    localStorage.removeItem('lzhcard_phonetic_pos');
    localStorage.removeItem('theme_preference');
    localStorage.removeItem('lzhcard_api_mode');
    localStorage.removeItem('lzhcard_auto_audio');
    localStorage.removeItem('lzhcard_show_sentence_front');
    localStorage.removeItem('lzhcard_floating_translator_enabled');
    localStorage.removeItem('lzhcard_notif_friend_msg');
    localStorage.removeItem('lzhcard_notif_announcements');
    localStorage.removeItem('lzhcard_notif_friend_requests');
    localStorage.removeItem('lzhcard_notif_team_invites');
    if (typeof FloatingTranslator !== 'undefined' && typeof FloatingTranslator.setEnabled === 'function') {
      FloatingTranslator.setEnabled(true);
    }
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
  },

  cancelPendingSync() {
    if (this._cloudSaveTimer) {
      clearTimeout(this._cloudSaveTimer);
      this._cloudSaveTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._hasPendingFlush = false;
    this._retryCount = 0;
  },

  async clearUserLocalData(uid = this.getCurrentUid()) {
    this.cancelPendingSync();
    this._hasLoadedOnce = false;
    this._loadedUid = undefined;
    this._lastKnownDecks = null;
    this._deletedKeysCache = null;
    this._deletedKeysCacheUid = undefined;

    const targetUid = uid || 'guest';
    const idbKeys = [
      this.getScopedKey(this.LOCAL_DECKS_KEY, targetUid),
      this.getScopedKey(this.LOCAL_DELETED_KEY, targetUid)
    ];

    for (const k of idbKeys) {
      try {
        await LocalIDB.remove(k);
      } catch (e) {}
    }

    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (
          key.endsWith(`__${targetUid}`) ||
          key === `lzhcard_profile_cache_${targetUid}` ||
          key === `lzhcard_last_daily_fsrs_sync__${targetUid}` ||
          key.startsWith('lzhcard_last_read_chat_') ||
          key === 'lzhcard_last_read_announcements' ||
          key === 'lzhcard_selected_categories' ||
          key === 'lzhcard_guest_mode' ||
          key === this.LOCAL_OWNER_KEY
        ) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {}

    this.clearCrossAccountLocalCache();

    if (typeof wordList !== 'undefined' && Array.isArray(wordList)) {
      wordList.length = 0;
    }
    if (typeof window !== 'undefined' && Array.isArray(window.wordList)) {
      window.wordList.length = 0;
    }
    return true;
  },

  /**
   * 📅 每日開啟時，由 FSRS 等級單向覆蓋自由練習臨時等級（臨時等級完全不影響 FSRS，但每日重置回 FSRS 水準）
   * @param {boolean} force 是否強制忽略今天已同步標記並立即執行
   * @param {Array|null} targetList 指定單字庫清單（若未指定則自動讀取全局 wordList）
   * @returns {boolean} 是否有任何單字等級或連對數發生異動
   */
  checkAndApplyDailyFSRSToFreeSync(force = false, targetList = null) {
    const list = (targetList && Array.isArray(targetList))
      ? targetList
      : ((typeof wordList !== 'undefined' && Array.isArray(wordList) && wordList.length > 0)
          ? wordList
          : (typeof window !== 'undefined' && Array.isArray(window.wordList) ? window.wordList : []));

    if (!Array.isArray(list) || list.length === 0) return false;

    const uid = this.getCurrentUid();
    const lastSyncKey = this.getScopedKey('lzhcard_last_daily_fsrs_sync', uid);
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const lastSyncDate = localStorage.getItem(lastSyncKey);
    if (!force && lastSyncDate === todayStr) {
      return false; // 今日已執行過同步
    }

    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const card = list[i];
      if (!card || typeof card !== 'object') continue;

      // FSRS 等級 (1~5)
      const fsrsLv = Math.min(5, Math.max(1, toFiniteNumber(card.level, 1)));
      const curFreeLv = toFiniteNumber(card.freeLevel, 1);
      const curFreeStreak = toFiniteNumber(card.freeStreak, 0);

      // 單向以 FSRS 等級覆蓋自由練習臨時等級，並重置臨時連對次數為 0
      if (curFreeLv !== fsrsLv || curFreeStreak !== 0) {
        card.freeLevel = fsrsLv;
        card.freeStreak = 0;
        card.updatedAt = Date.now();
        changed = true;
      }
    }

    localStorage.setItem(lastSyncKey, todayStr);

    if (changed) {
      console.log(`[LZHCard] 📅 每日同步完成：已將 ${todayStr} 自由練習臨時等級覆蓋為 FSRS 等級`);
      this.saveData(list, false);
      if (typeof window !== 'undefined' && typeof window.refreshFSRSUIBadges === 'function') {
        window.refreshFSRSUIBadges();
      }
    }

    return changed;
  },

  buildCardCompositeKey(card, defaultCatName = getStorageDefaultCatName()) {
    if (!card || typeof card !== 'object') return null;
    const norm = normalizeCardWordText(card.word).toLowerCase();
    if (!norm) return null;
    const cat = normalizeDeckCategoryName(card.category, defaultCatName).toLowerCase();
    return `${cat}::${norm}`;
  },

  buildLegacyCaseCompositeKey(card, defaultCatName = getStorageDefaultCatName()) {
    if (!card || typeof card !== 'object') return null;
    const norm = (card.word || '').trim().toLowerCase();
    if (!norm) return null;
    const cat = (card.category || defaultCatName).trim();
    return `${cat}::${norm}`;
  },

  updateLastKnownDecksSnapshot(decks) {
    if (!Array.isArray(decks)) {
      this._lastKnownDecks = [];
      return;
    }
    this._lastKnownDecks = decks.map(c => ({
      id: c.id,
      deckId: c.deckId || generateDeterministicDeckId(c.category),
      word: c.word,
      category: c.category
    }));
  },

  /**
   * 📥 從 IndexedDB 讀取本機單字庫（依帳號 UID 分區隔離，避免訪客與不同帳號互相覆蓋）
   */
  async getLocalDecks(uid = this.getCurrentUid()) {
    const scopedKey = this.getScopedKey(this.LOCAL_DECKS_KEY, uid);
    try {
      const idbDecks = await LocalIDB.get(scopedKey);
      if (Array.isArray(idbDecks)) {
        if (localStorage.getItem(scopedKey) !== null) {
          localStorage.removeItem(scopedKey);
        }
        return idbDecks;
      }

      // 舊版未分區本機資料僅保留給訪客（!uid），避免登入或切換帳號時誤繼承舊資料
      if (!uid) {
        const legacyIdb = await LocalIDB.get(this.LOCAL_DECKS_KEY);
        if (Array.isArray(legacyIdb)) {
          await LocalIDB.set(scopedKey, legacyIdb);
          await LocalIDB.remove(this.LOCAL_DECKS_KEY);
          return legacyIdb;
        }

        const rawLegacy = localStorage.getItem(this.LOCAL_DECKS_KEY);
        if (rawLegacy) {
          const parsed = JSON.parse(rawLegacy);
          if (Array.isArray(parsed)) {
            await LocalIDB.set(scopedKey, parsed);
            localStorage.removeItem(this.LOCAL_DECKS_KEY);
            return parsed;
          }
        }
      }
      return [];
    } catch (e) {
      console.warn("IndexedDB 讀取單字失敗，降級使用 LocalStorage:", e);
      try {
        const rawLocal = localStorage.getItem(scopedKey);
        if (rawLocal) {
          const parsed = JSON.parse(rawLocal);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (err) {}
      return [];
    }
  },

  /**
   * 💾 寫入本機單字庫至 IndexedDB（直接儲存 JS 物件陣列，無 5MB 限制）
   */
  async setLocalDecks(decks, uid = this.getCurrentUid()) {
    const scopedKey = this.getScopedKey(this.LOCAL_DECKS_KEY, uid);
    const safeArray = Array.isArray(decks) ? decks : [];
    try {
      await LocalIDB.set(scopedKey, safeArray);
      if (localStorage.getItem(scopedKey) !== null) {
        localStorage.removeItem(scopedKey);
      }
    } catch (e) {
      console.warn("IndexedDB 寫入單字失敗，降級使用 LocalStorage:", e);
      try {
        localStorage.setItem(scopedKey, JSON.stringify(safeArray));
      } catch (quotaErr) {
        console.error("本機儲存空間已滿:", quotaErr);
      }
    }
  },

  async getDeletedKeysSet(uid = this.getCurrentUid()) {
    const scopeId = uid || 'guest';
    if (this._deletedKeysCache instanceof Set && this._deletedKeysCacheUid === scopeId) {
      return this._deletedKeysCache;
    }

    const scopedKey = this.getScopedKey(this.LOCAL_DELETED_KEY, uid);
    try {
      const idbDeleted = await LocalIDB.get(scopedKey);
      if (Array.isArray(idbDeleted)) {
        if (localStorage.getItem(scopedKey) !== null) {
          localStorage.removeItem(scopedKey);
        }
        this._deletedKeysCache = new Set(idbDeleted);
        this._deletedKeysCacheUid = scopeId;
        return this._deletedKeysCache;
      }

      if (!uid) {
        const rawLegacy = localStorage.getItem(this.LOCAL_DELETED_KEY);
        if (rawLegacy) {
          const parsed = JSON.parse(rawLegacy);
          if (Array.isArray(parsed)) {
            await LocalIDB.set(scopedKey, parsed);
            localStorage.removeItem(this.LOCAL_DELETED_KEY);
            this._deletedKeysCache = new Set(parsed);
            this._deletedKeysCacheUid = scopeId;
            return this._deletedKeysCache;
          }
        }
      }
    } catch (e) {
      try {
        const raw = localStorage.getItem(scopedKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this._deletedKeysCache = new Set(parsed);
            this._deletedKeysCacheUid = scopeId;
            return this._deletedKeysCache;
          }
        }
      } catch (err) {}
    }

    this._deletedKeysCache = new Set();
    this._deletedKeysCacheUid = scopeId;
    return this._deletedKeysCache;
  },

  async saveDeletedKeysSet(deletedSet, uid = this.getCurrentUid()) {
    const scopeId = uid || 'guest';
    const scopedKey = this.getScopedKey(this.LOCAL_DELETED_KEY, uid);
    const normalizedSet = deletedSet instanceof Set ? deletedSet : new Set();
    this._deletedKeysCache = normalizedSet;
    this._deletedKeysCacheUid = scopeId;

    if (normalizedSet.size === 0) {
      try { await LocalIDB.remove(scopedKey); } catch (e) {}
      localStorage.removeItem(scopedKey);
      return;
    }

    const arr = Array.from(normalizedSet);
    try {
      await LocalIDB.set(scopedKey, arr);
      if (localStorage.getItem(scopedKey) !== null) {
        localStorage.removeItem(scopedKey);
      }
    } catch (e) {
      try {
        localStorage.setItem(scopedKey, JSON.stringify(arr));
      } catch (err) {}
    }
  },

  /**
   * 🗑️ 同字庫重複單字自動清理（依決定性分類與單字鍵值去重，保留較新/較高進度並補齊欄位）
   */
  deduplicateSameDeckWords(decks) {
    if (!Array.isArray(decks) || decks.length === 0) return false;
    const defaultCatName = getStorageDefaultCatName();
    const seen = new Map();
    const deduped = [];
    let removed = false;

    const mergeMissingFields = (winner, loser) => {
      const fields = ['pos', 'phonetic', 'meaning', 'sentence', 'translation', 'lang'];
      fields.forEach(f => {
        if ((!winner[f] || !String(winner[f]).trim()) && loser[f] && String(loser[f]).trim()) {
          winner[f] = loser[f];
        }
      });
    };

    for (let i = 0; i < decks.length; i++) {
      const card = decks[i];
      if (!card || typeof card !== 'object') continue;

      const normWord = normalizeCardWordText(card.word).toLowerCase();
      if (!normWord) {
        deduped.push(card);
        continue;
      }

      const cat = normalizeDeckCategoryName(card.category, defaultCatName);
      const detId = generateDeterministicCardId(cat, normWord);
      const key = `${cat.toLowerCase()}::${normWord}::${detId}`;

      if (!seen.has(key)) {
        seen.set(key, deduped.length);
        deduped.push(card);
      } else {
        removed = true;
        const existingIdx = seen.get(key);
        const existing = deduped[existingIdx];

        const curTs = toFiniteNumber(card.updatedAt, 0);
        const extTs = toFiniteNumber(existing.updatedAt, 0);
        const cardWins = (curTs !== extTs)
          ? (compareCardProgress(card, existing) > 0 || (compareCardProgress(card, existing) === 0 && curTs > extTs))
          : (compareCardProgress(card, existing) > 0);

        if (cardWins) {
          card.updatedAt = Math.max(curTs, extTs);
          mergeMissingFields(card, existing);
          deduped[existingIdx] = card;
        } else {
          existing.updatedAt = Math.max(curTs, extTs);
          mergeMissingFields(existing, card);
        }
      }
    }

    if (removed) {
      decks.length = 0;
      decks.push(...deduped);
    }

    return removed;
  },

  migrateAllCardsFSRS(decks) {
    if (!Array.isArray(decks)) return false;
    let hasMigrated = false;

    for (let i = 0; i < decks.length; i++) {
      const card = decks[i];
      if (!card || typeof card !== 'object') continue;

      const neededMigration = (
        !Number.isFinite(card.stability) ||
        !Number.isFinite(card.difficulty) ||
        !Number.isFinite(card.nextReview) ||
        !card.state ||
        !card.deckId ||
        !String(card.id || '').startsWith('card_')
      );

      if (typeof migrateCardFSRS === 'function') {
        migrateCardFSRS(card);
      }

      const cleanCat = normalizeDeckCategoryName(card.category);
      const cleanWord = normalizeCardWordText(card.word);
      card.category = cleanCat;
      card.deckId = generateDeterministicDeckId(cleanCat);
      if (cleanWord) {
        card.word = cleanWord;
        card.id = generateDeterministicCardId(cleanCat, cleanWord);
      }

      card.level = toFiniteNumber(card.level, 1);
      card.knowStreak = toFiniteNumber(card.knowStreak, 0);
      card.stability = toFiniteNumber(card.stability, 0);
      card.difficulty = toFiniteNumber(card.difficulty, 5.5);
      card.reps = toFiniteNumber(card.reps, 0);
      card.lapses = toFiniteNumber(card.lapses, 0);
      card.lastReview = toFiniteNumber(card.lastReview, 0);
      card.nextReview = toFiniteNumber(card.nextReview, 0);
      card.freeLevel = toFiniteNumber(card.freeLevel, 1);
      card.freeStreak = toFiniteNumber(card.freeStreak, 0);
      card.updatedAt = toFiniteNumber(card.updatedAt, Date.now());

      if (neededMigration) {
        hasMigrated = true;
      }
    }

    return hasMigrated;
  },

  /**
   * 🧱 還原完整欄位結構並賦予決定性唯一 ID（供記憶體與 UI 使用）
   */
  sanitizeDecksForStorage(decks) {
    if (!Array.isArray(decks)) return [];
    const workingDecks = decks.filter(card => card && typeof card === 'object').map(c => ({ ...c }));
    this.deduplicateSameDeckWords(workingDecks);

    const seenIds = new Set();
    const defaultCat = getStorageDefaultCatName();

    return workingDecks.map((card, idx) => {
      if (typeof migrateCardFSRS === 'function') {
        migrateCardFSRS(card);
      }

      const catStr = normalizeDeckCategoryName(card.category, defaultCat);
      const wordStr = normalizeCardWordText(card.word);
      const deckId = generateDeterministicDeckId(catStr);

      let safeId = wordStr
        ? generateDeterministicCardId(catStr, wordStr)
        : (card.id !== undefined && card.id !== null && String(card.id).trim() ? String(card.id).trim() : `card_empty_${hashStringStableHex(catStr + '::' + idx)}`);

      if (seenIds.has(safeId)) {
        safeId = `${safeId}_${idx}`;
      }
      seenIds.add(safeId);

      const isManualDiff = card.diffLevelManual === true;
      let resolvedDiffLevel = null;
      if (isManualDiff && card.diffLevel !== undefined && card.diffLevel !== null && card.diffLevel !== '') {
        const parsedDiff = parseInt(card.diffLevel, 10);
        if (!Number.isNaN(parsedDiff) && parsedDiff >= 0 && parsedDiff <= 6) {
          resolvedDiffLevel = parsedDiff;
        }
      }
      if (resolvedDiffLevel === null) {
        if (typeof window !== 'undefined' && typeof window.getWordDifficultyInfo === 'function') {
          resolvedDiffLevel = window.getWordDifficultyInfo(wordStr).level;
        } else if (typeof getWordDifficultyInfo === 'function') {
          resolvedDiffLevel = getWordDifficultyInfo(wordStr).level;
        } else if (card.diffLevel !== undefined && card.diffLevel !== null && card.diffLevel !== '') {
          const parsedFallback = parseInt(card.diffLevel, 10);
          resolvedDiffLevel = (!Number.isNaN(parsedFallback) && parsedFallback >= 0 && parsedFallback <= 6) ? parsedFallback : 0;
        } else {
          resolvedDiffLevel = 0;
        }
      }

      const rawLang = typeof card.lang === 'string' ? card.lang.trim() : '';
      const normalized = {
        id: safeId,
        deckId,
        category: catStr,
        word: wordStr,
        pos: String(card.pos || '').trim(),
        phonetic: String(card.phonetic || '').trim(),
        meaning: String(card.meaning || '').trim(),
        sentence: String(card.sentence || '').trim(),
        translation: String(card.translation || '').trim(),
        ...(rawLang ? { lang: rawLang } : {}),
        level: toFiniteNumber(card.level, 1),
        knowStreak: toFiniteNumber(card.knowStreak, 0),
        state: typeof card.state === 'string' && card.state ? card.state : 'new',
        stability: toFiniteNumber(card.stability, 0),
        difficulty: toFiniteNumber(card.difficulty, 5.5),
        reps: toFiniteNumber(card.reps, 0),
        lapses: toFiniteNumber(card.lapses, 0),
        lastReview: toFiniteNumber(card.lastReview, 0),
        nextReview: toFiniteNumber(card.nextReview, 0),
        freeLevel: toFiniteNumber(card.freeLevel, 1),
        freeStreak: toFiniteNumber(card.freeStreak, 0),
        diffLevel: resolvedDiffLevel,
        diffLevelManual: isManualDiff,
        updatedAt: toFiniteNumber(card.updatedAt, Date.now())
      };

      return deepSanitizeForFirestore(normalized);
    });
  },

  /**
   * 🗜️ 精簡雲端傳輸負載（保留決定性 id 與 deckId，省略空字串與預設初期值）
   */
  compactDecksForCloud(sanitizedDecks) {
    return sanitizedDecks.map(c => {
      const out = {
        id: c.id,
        deckId: c.deckId || generateDeterministicDeckId(c.category),
        category: c.category,
        word: c.word,
        updatedAt: c.updatedAt
      };
      if (c.lang) out.lang = c.lang;
      if (c.pos) out.pos = c.pos;
      if (c.phonetic) out.phonetic = c.phonetic;
      if (c.meaning) out.meaning = c.meaning;
      if (c.sentence) out.sentence = c.sentence;
      if (c.translation) out.translation = c.translation;
      if (c.level !== 1) out.level = c.level;
      if (c.knowStreak !== 0) out.knowStreak = c.knowStreak;
      if (c.state && c.state !== 'new') out.state = c.state;
      if (c.stability !== 0) out.stability = c.stability;
      if (Math.abs(c.difficulty - 5.5) > 0.001) out.difficulty = c.difficulty;
      if (c.reps !== 0) out.reps = c.reps;
      if (c.lapses !== 0) out.lapses = c.lapses;
      if (c.lastReview !== 0) out.lastReview = c.lastReview;
      if (c.nextReview !== 0) out.nextReview = c.nextReview;
      if (c.freeLevel !== 1) out.freeLevel = c.freeLevel;
      if (c.freeStreak !== 0) out.freeStreak = c.freeStreak;
      if (c.diffLevelManual === true && typeof c.diffLevel === 'number') {
        out.diffLevelManual = true;
        out.diffLevel = c.diffLevel;
      }
      return out;
    });
  },

  /**
   * 📦 將單字陣列依位元組大小切分為多個安全分片（每片 <= 350 KB）
   */
  splitIntoChunks(compactDecks, maxChunkBytes = this.CHUNK_TARGET_BYTES) {
    if (!Array.isArray(compactDecks) || compactDecks.length === 0) return [];
    const chunks = [];
    let currentChunk = [];
    let currentBytes = 64;

    for (let i = 0; i < compactDecks.length; i++) {
      const item = compactDecks[i];
      const itemBytes = new Blob([JSON.stringify(item)]).size + 2;

      if (currentChunk.length > 0 && currentBytes + itemBytes > maxChunkBytes) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 64;
      }

      currentChunk.push(item);
      currentBytes += itemBytes;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  },

  /**
   * 🔀 嚴格依決定性 id 進行 Upsert 合併去重（保留 updatedAt 較新者，徹底杜絕斷網重連字庫重複）
   */
  async mergeRemoteAndLocalDecks(remoteDecks, localDecks, isLocalDirty, uid = this.getCurrentUid()) {
    const defaultCatName = getStorageDefaultCatName();
    const deletedSet = await this.getDeletedKeysSet(uid);
    const hasPendingDeletions = deletedSet.size > 0;

    if (isLocalDirty && Array.isArray(localDecks) && localDecks.length === 0) {
      return { decks: [], needsCloudSync: true };
    }

    const remoteArr = Array.isArray(remoteDecks) ? remoteDecks : [];
    const localArr = Array.isArray(localDecks) ? localDecks : [];

    if (localArr.length === 0 && !hasPendingDeletions) {
      const sanitizedRemote = this.sanitizeDecksForStorage(remoteArr);
      const changedRemoteIds = sanitizedRemote.length !== remoteArr.length || remoteArr.some((c, i) => !c || !String(c.id || '').startsWith('card_') || c.id !== sanitizedRemote[i]?.id);
      return { decks: sanitizedRemote, needsCloudSync: changedRemoteIds };
    }

    if (remoteArr.length === 0) {
      const sanitizedLocal = this.sanitizeDecksForStorage(localArr);
      return { decks: sanitizedLocal, needsCloudSync: sanitizedLocal.length > 0 || isLocalDirty };
    }

    const isCardDeleted = (card) => {
      if (!card || typeof card !== 'object') return true;
      const cat = normalizeDeckCategoryName(card.category, defaultCatName);
      const word = normalizeCardWordText(card.word);
      const detId = word ? generateDeterministicCardId(cat, word) : '';
      const normCompKey = this.buildCardCompositeKey(card, defaultCatName);
      const legacyCompKey = this.buildLegacyCaseCompositeKey(card, defaultCatName);
      return Boolean(
        (card.id && deletedSet.has(card.id)) ||
        (detId && deletedSet.has(detId)) ||
        (normCompKey && deletedSet.has(normCompKey)) ||
        (legacyCompKey && deletedSet.has(legacyCompKey))
      );
    };

    const mergeNonEmptyFields = (winner, loser) => {
      const fields = ['pos', 'phonetic', 'meaning', 'sentence', 'translation', 'lang'];
      fields.forEach(f => {
        if ((!winner[f] || !String(winner[f]).trim()) && loser[f] && String(loser[f]).trim()) {
          winner[f] = loser[f];
        }
      });
    };

    const canonicalizeCard = (card, fallbackIdx) => {
      const cat = normalizeDeckCategoryName(card.category, defaultCatName);
      const word = normalizeCardWordText(card.word);
      const detId = word
        ? generateDeterministicCardId(cat, word)
        : (card.id ? String(card.id).trim() : `card_empty_${fallbackIdx}`);
      return {
        ...card,
        id: detId,
        deckId: generateDeterministicDeckId(cat),
        category: cat,
        word
      };
    };

    let needsCloudSync = Boolean(isLocalDirty || hasPendingDeletions);
    const upsertedMap = new Map();

    const upsertRecord = (rawCard, source, idx) => {
      if (!rawCard || typeof rawCard !== 'object') return;
      if (isCardDeleted(rawCard)) {
        if (source === 'remote') needsCloudSync = true;
        return;
      }

      const normalized = canonicalizeCard(rawCard, idx);
      if (rawCard.id !== normalized.id || !rawCard.deckId) {
        needsCloudSync = true;
      }
      const key = normalized.id;

      if (!upsertedMap.has(key)) {
        upsertedMap.set(key, normalized);
        if (source === 'local') {
          needsCloudSync = true;
        }
        return;
      }

      const existing = upsertedMap.get(key);
      const existingTs = toFiniteNumber(existing.updatedAt, 0);
      const incomingTs = toFiniteNumber(normalized.updatedAt, 0);

      let winner = existing;
      let loser = normalized;
      let incomingWins = false;

      if (incomingTs > existingTs) {
        incomingWins = true;
      } else if (incomingTs === existingTs) {
        if (compareCardProgress(normalized, existing) > 0) {
          incomingWins = true;
        }
      }

      if (incomingWins) {
        winner = { ...existing, ...normalized, updatedAt: Math.max(incomingTs, existingTs) };
        loser = existing;
        mergeNonEmptyFields(winner, loser);
        upsertedMap.set(key, winner);
        if (source === 'local') needsCloudSync = true;
      } else {
        winner = { ...normalized, ...existing, updatedAt: Math.max(incomingTs, existingTs) };
        loser = normalized;
        mergeNonEmptyFields(winner, loser);
        upsertedMap.set(key, winner);
      }

      if (source === 'remote') {
        needsCloudSync = true;
      }
    };

    remoteArr.forEach((c, idx) => upsertRecord(c, 'remote', idx));
    localArr.forEach((c, idx) => upsertRecord(c, 'local', idx));

    const mergedList = this.sanitizeDecksForStorage(Array.from(upsertedMap.values()));
    return { decks: mergedList, needsCloudSync };
  },

  getLocalQuizScore(uid = this.getCurrentUid()) {
    const scopedKey = this.getScopedKey(this.LOCAL_QUIZ_SCORE_KEY, uid);
    try {
      const raw = localStorage.getItem(scopedKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.correct === 'number' && typeof parsed.total === 'number') {
          return {
            correct: toFiniteNumber(parsed.correct, 0),
            total: toFiniteNumber(parsed.total, 0),
            updatedAt: toFiniteNumber(parsed.updatedAt, 0)
          };
        }
      }
    } catch (e) {}
    return { correct: 0, total: 0, updatedAt: 0 };
  },

  applyQuizScoreState(scoreObj, uid = this.getCurrentUid()) {
    if (!scoreObj || typeof scoreObj.correct !== 'number' || typeof scoreObj.total !== 'number') return;
    const scopedKey = this.getScopedKey(this.LOCAL_QUIZ_SCORE_KEY, uid);
    const cleanScore = {
      correct: toFiniteNumber(scoreObj.correct, 0),
      total: toFiniteNumber(scoreObj.total, 0),
      updatedAt: toFiniteNumber(scoreObj.updatedAt, 0)
    };
    localStorage.setItem(scopedKey, JSON.stringify(cleanScore));
    if (typeof window.syncQuizScoreFromStorage === 'function') {
      window.syncQuizScoreFromStorage(cleanScore);
    } else {
      const scoreElem = document.getElementById('quizScore');
      if (scoreElem) scoreElem.innerText = `${cleanScore.correct}/${cleanScore.total}`;
    }
  },

  getLocalSettings() {
    return deepSanitizeForFirestore({
      nativeLang: localStorage.getItem('lzhcard_native_lang') || 'zh-TW',
      targetLang: localStorage.getItem('lzhcard_target_lang') || 'en',
      customNative: localStorage.getItem('lzhcard_custom_native') || '',
      customTarget: localStorage.getItem('lzhcard_custom_target') || '',
      displayMode: localStorage.getItem('lzhcard_display_mode') || 'target_front',
      phoneticPos: localStorage.getItem('lzhcard_phonetic_pos') || 'front',
      theme: localStorage.getItem('theme_preference') || 'system',
      apiMode: localStorage.getItem('lzhcard_api_mode') || 'shared',
      autoPlayAudio: localStorage.getItem('lzhcard_auto_audio') === 'true',
      showSentenceFront: localStorage.getItem('lzhcard_show_sentence_front') === 'true',
      floatingTranslatorEnabled: localStorage.getItem('lzhcard_floating_translator_enabled') !== 'false',
      notifFriendMsg: localStorage.getItem('lzhcard_notif_friend_msg') !== 'false',
      notifAnnouncements: localStorage.getItem('lzhcard_notif_announcements') !== 'false',
      notifFriendRequests: localStorage.getItem('lzhcard_notif_friend_requests') !== 'false',
      notifTeamInvites: localStorage.getItem('lzhcard_notif_team_invites') !== 'false',
      onboardingCompleted: localStorage.getItem('lzhcard_onboarding_completed') === 'true',
      onboardingV2Done: localStorage.getItem('lzhcard_onboarding_v2_done') === 'true'
    });
  },

  applyRemoteSettings(settings) {
    if (!settings) return;
    if (settings.nativeLang) localStorage.setItem('lzhcard_native_lang', settings.nativeLang);
    if (settings.targetLang) localStorage.setItem('lzhcard_target_lang', settings.targetLang);
    if (typeof settings.customNative === 'string') localStorage.setItem('lzhcard_custom_native', settings.customNative);
    if (typeof settings.customTarget === 'string') localStorage.setItem('lzhcard_custom_target', settings.customTarget);
    if (settings.displayMode) localStorage.setItem('lzhcard_display_mode', settings.displayMode);
    if (settings.phoneticPos) localStorage.setItem('lzhcard_phonetic_pos', settings.phoneticPos);
    if (settings.theme) localStorage.setItem('theme_preference', settings.theme);
    if (typeof settings.autoPlayAudio === 'boolean') {
      localStorage.setItem('lzhcard_auto_audio', settings.autoPlayAudio ? 'true' : 'false');
    }
    if (typeof settings.showSentenceFront === 'boolean') {
      localStorage.setItem('lzhcard_show_sentence_front', settings.showSentenceFront ? 'true' : 'false');
    }
    if (typeof settings.floatingTranslatorEnabled === 'boolean') {
      localStorage.setItem('lzhcard_floating_translator_enabled', settings.floatingTranslatorEnabled ? 'true' : 'false');
      if (typeof FloatingTranslator !== 'undefined' && typeof FloatingTranslator.setEnabled === 'function') {
        FloatingTranslator.setEnabled(settings.floatingTranslatorEnabled);
      }
    }
    if (typeof settings.notifFriendMsg === 'boolean') {
      localStorage.setItem('lzhcard_notif_friend_msg', settings.notifFriendMsg ? 'true' : 'false');
    }
    if (typeof settings.notifAnnouncements === 'boolean') {
      localStorage.setItem('lzhcard_notif_announcements', settings.notifAnnouncements ? 'true' : 'false');
    }
    if (typeof settings.notifFriendRequests === 'boolean') {
      localStorage.setItem('lzhcard_notif_friend_requests', settings.notifFriendRequests ? 'true' : 'false');
    }
    if (typeof settings.notifTeamInvites === 'boolean') {
      localStorage.setItem('lzhcard_notif_team_invites', settings.notifTeamInvites ? 'true' : 'false');
    }

    if (settings.apiMode === 'personal' || settings.apiMode === 'shared') {
      localStorage.setItem('lzhcard_api_mode', settings.apiMode);
    }

    if (settings.onboardingCompleted === true) {
      localStorage.setItem('lzhcard_onboarding_completed', 'true');
      if (typeof closeModal === 'function') closeModal('onboardingSetupModal');
    }
    if (settings.onboardingV2Done === true) {
      localStorage.setItem('lzhcard_onboarding_v2_done', 'true');
    }

    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof syncChatNotificationMuteIndicators === 'function') syncChatNotificationMuteIndicators();
    if (typeof applyLanguageUI === 'function') applyLanguageUI();
    if (typeof applyTheme === 'function') applyTheme(settings.theme || 'system');
    if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
  },

  async fetchRemoteUserDocAndDecks(uid) {
    if (!uid || typeof db === 'undefined') return null;
    const docRef = db.collection('users').doc(uid);
    const doc = await docRef.get();
    if (!doc.exists) {
      return { exists: false, data: null, remoteDecks: [] };
    }

    const data = doc.data() || {};
    let remoteDecks = [];

    if (typeof data.deckChunkCount === 'number' && data.deckChunkCount > 0) {
      try {
        const chunksSnap = await docRef.collection('deckChunks').get();
        const chunkDocs = chunksSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            const idxA = typeof a.index === 'number' ? a.index : parseInt(String(a.id).replace('chunk_', ''), 10) || 0;
            const idxB = typeof b.index === 'number' ? b.index : parseInt(String(b.id).replace('chunk_', ''), 10) || 0;
            return idxA - idxB;
          });
        chunkDocs.forEach(cd => {
          if (Array.isArray(cd.decks)) {
            remoteDecks.push(...cd.decks);
          }
        });
      } catch (chunkErr) {
        console.warn("讀取分片子集合失敗，嘗試讀取主文件 decks：", chunkErr);
      }
    }

    if (remoteDecks.length === 0) {
      if (data.decks && Array.isArray(data.decks)) {
        remoteDecks = data.decks;
      } else if (data.wordList && Array.isArray(data.wordList)) {
        remoteDecks = data.wordList;
      }
    }

    return { exists: true, data, remoteDecks };
  },

  async loadData() {
    const uid = this.getCurrentUid();
    const loadKey = uid || 'guest';

    // 若上一位登入者為其他已登入帳號，清空其殘留的 API Key 與設定，避免新切換的空帳號繼承
    const prevOwner = localStorage.getItem(this.LOCAL_OWNER_KEY);
    if (prevOwner && prevOwner !== 'guest' && prevOwner !== loadKey) {
      this.clearCrossAccountLocalCache();
    }
    localStorage.setItem(this.LOCAL_OWNER_KEY, loadKey);

    // 偵測到帳號切換（與上次載入的 UID 不同）時，立即清空記憶體殘留與掛起計時器
    if (this._loadedUid !== undefined && this._loadedUid !== uid) {
      if (this._cloudSaveTimer) {
        clearTimeout(this._cloudSaveTimer);
        this._cloudSaveTimer = null;
      }
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      this._hasLoadedOnce = false;
      this._loadedOffline = false;
      this._needsReconnectSync = false;
      this._lastKnownDecks = null;
      this._deletedKeysCache = null;
      this._deletedKeysCacheUid = undefined;
      if (Array.isArray(wordList)) {
        wordList.length = 0;
      }
    }

    if (this._inFlightLoad && this._inFlightLoad.key === loadKey) {
      return this._inFlightLoad.promise;
    }

    const runLoad = async () => {
      const dirtyKey = this.getScopedKey(this.LOCAL_DIRTY_KEY, uid);
      const localDecks = await this.getLocalDecks(uid);
      const isLocalDirty = localStorage.getItem(dirtyKey) === 'true';

      if (uid && typeof db !== 'undefined') {
        try {
          const fetched = await this.fetchRemoteUserDocAndDecks(uid);

          // 若等待雲端回應期間又切換了帳號，直接中止這次過期的載入
          if (this.getCurrentUid() !== uid) return wordList;

          if (fetched && fetched.exists) {
            const { data, remoteDecks } = fetched;
            const { decks: mergedDecks, needsCloudSync } = await this.mergeRemoteAndLocalDecks(
              remoteDecks,
              localDecks,
              isLocalDirty,
              uid
            );

            if (this.getCurrentUid() !== uid) return wordList;

            wordList = this.sanitizeDecksForStorage(mergedDecks);
            const migrated = this.migrateAllCardsFSRS(wordList);
            const deduped = this.deduplicateSameDeckWords(wordList);
            await this.setLocalDecks(wordList, uid);
            this.updateLastKnownDecksSnapshot(wordList);
            this._hasLoadedOnce = true;
            this._loadedUid = uid;
            this._loadedOffline = false;
            this._needsReconnectSync = false;

            const localQuiz = this.getLocalQuizScore(uid);
            const remoteQuiz = data.quizScore || { correct: 0, total: 0, updatedAt: 0 };
            const bestQuiz = (localQuiz.updatedAt || 0) > (remoteQuiz.updatedAt || 0) ? localQuiz : remoteQuiz;
            this.applyQuizScoreState(bestQuiz, uid);

            const hasLegacyWordListField = Array.isArray(data.wordList);
            if (migrated || deduped || needsCloudSync || hasLegacyWordListField || (localQuiz.updatedAt || 0) > (remoteQuiz.updatedAt || 0)) {
              await this.flushCloudSave();
            } else {
              localStorage.removeItem(dirtyKey);
              await this.saveDeletedKeysSet(new Set(), uid);
            }

            if (data.apiKey) {
              localStorage.setItem(this.LOCAL_APIKEY_KEY, data.apiKey);
              if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
            }

            if (data.settings) {
              this.applyRemoteSettings(data.settings);
            }

            if (typeof checkAndOpenOnboardingModal === 'function') {
              checkAndOpenOnboardingModal();
            }

            this.checkAndApplyDailyFSRSToFreeSync();
            return wordList;
          } else if (fetched && !fetched.exists) {
            if (this.getCurrentUid() !== uid) return wordList;

            const initialDecks = Array.isArray(localDecks) ? localDecks : [];
            this.migrateAllCardsFSRS(initialDecks);
            this.deduplicateSameDeckWords(initialDecks);
            wordList = this.sanitizeDecksForStorage(initialDecks);
            await this.setLocalDecks(wordList, uid);
            this.updateLastKnownDecksSnapshot(wordList);
            this._hasLoadedOnce = true;
            this._loadedUid = uid;
            this._loadedOffline = false;
            this._needsReconnectSync = false;
            this.applyQuizScoreState(this.getLocalQuizScore(uid), uid);
            await this.flushCloudSave();

            if (typeof checkAndOpenOnboardingModal === 'function') {
              checkAndOpenOnboardingModal();
            }

            this.checkAndApplyDailyFSRSToFreeSync();
            return wordList;
          }
        } catch (e) {
          this._loadedOffline = true;
          this._needsReconnectSync = true;
          console.warn("Firestore 讀取失敗（離線降級使用 IndexedDB 本機資料）:", e);
          if (typeof checkAndOpenOnboardingModal === 'function') {
            checkAndOpenOnboardingModal();
          }
        }
      }

      if (this.getCurrentUid() !== uid) return wordList;

      wordList = this.sanitizeDecksForStorage(Array.isArray(localDecks) ? localDecks : []);
      const migratedLocal = this.migrateAllCardsFSRS(wordList);
      const dedupedLocal = this.deduplicateSameDeckWords(wordList);
      if (migratedLocal || dedupedLocal) {
        await this.setLocalDecks(wordList, uid);
      }
      this.updateLastKnownDecksSnapshot(wordList);
      this._hasLoadedOnce = true;
      this._loadedUid = uid;
      if (uid && (typeof navigator === 'undefined' || navigator.onLine === false)) {
        this._loadedOffline = true;
        this._needsReconnectSync = true;
      }
      this.applyQuizScoreState(this.getLocalQuizScore(uid), uid);
      this.checkAndApplyDailyFSRSToFreeSync();
      return wordList;
    };

    const promise = runLoad().finally(() => {
      if (this._inFlightLoad && this._inFlightLoad.promise === promise) {
        this._inFlightLoad = null;
      }
    });

    this._inFlightLoad = { key: loadKey, promise };
    return promise;
  },

  async syncOnReconnect(reason = 'online') {
    if (this._isReconnectingSync) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

    const uid = this.getCurrentUid();
    if (!uid || typeof db === 'undefined') return false;

    const dirtyKey = this.getScopedKey(this.LOCAL_DIRTY_KEY, uid);
    const isLocalDirty = localStorage.getItem(dirtyKey) === 'true';
    const deletedSet = await this.getDeletedKeysSet(uid);
    const hasOfflinePending = Boolean(
      this._needsReconnectSync ||
      this._loadedOffline ||
      isLocalDirty ||
      deletedSet.size > 0 ||
      this._cloudSaveTimer ||
      this._retryTimer
    );

    if (!hasOfflinePending && reason !== 'online') return false;

    this._isReconnectingSync = true;
    try {
      if (this._inFlightLoad && this._inFlightLoad.key === uid) {
        await this._inFlightLoad.promise.catch(() => {});
      }

      const currentLocal = Array.isArray(wordList) && wordList.length > 0 && this._loadedUid === uid
        ? [...wordList]
        : await this.getLocalDecks(uid);

      const fetched = await this.fetchRemoteUserDocAndDecks(uid);
      if (this.getCurrentUid() !== uid || !fetched) return false;

      const remoteDecks = fetched.exists ? fetched.remoteDecks : [];
      const { decks: mergedDecks, needsCloudSync } = await this.mergeRemoteAndLocalDecks(
        remoteDecks,
        currentLocal,
        isLocalDirty,
        uid
      );

      if (this.getCurrentUid() !== uid) return false;

      const cleanDecks = this.sanitizeDecksForStorage(mergedDecks);
      this.migrateAllCardsFSRS(cleanDecks);
      this.deduplicateSameDeckWords(cleanDecks);

      if (Array.isArray(wordList)) {
        wordList.length = 0;
        wordList.push(...cleanDecks);
      }
      if (typeof window !== 'undefined' && Array.isArray(window.wordList) && window.wordList !== wordList) {
        window.wordList.length = 0;
        window.wordList.push(...cleanDecks);
      }

      await this.setLocalDecks(cleanDecks, uid);
      this.updateLastKnownDecksSnapshot(cleanDecks);
      this._hasLoadedOnce = true;
      this._loadedUid = uid;
      this._loadedOffline = false;
      this._needsReconnectSync = false;

      if (needsCloudSync || isLocalDirty || !fetched.exists) {
        await this.flushCloudSave();
      } else {
        localStorage.removeItem(dirtyKey);
        await this.saveDeletedKeysSet(new Set(), uid);
      }

      if (typeof updateCategorySelects === 'function') updateCategorySelects();
      if (typeof updateUI === 'function') updateUI();
      if (typeof nextCard === 'function' && (!currentCard || !cleanDecks.some(c => c.id === currentCard.id))) {
        nextCard(false);
      }

      if ((needsCloudSync || isLocalDirty) && typeof showToast === 'function') {
        const msg = (typeof t === 'function' && t('toastReconnectSynced') !== 'toastReconnectSynced')
          ? t('toastReconnectSynced')
          : '☁️ 網路已恢復，字庫已自動比對去重並完成雲端同步！';
        showToast(msg, 'success');
      }
      return true;
    } catch (err) {
      this._needsReconnectSync = true;
      console.warn("斷網重連同步失敗（保留本機變更待下次同步）:", err);
      return false;
    } finally {
      this._isReconnectingSync = false;
    }
  },

  async flushCloudSave() {
    if (this._cloudSaveTimer) {
      clearTimeout(this._cloudSaveTimer);
      this._cloudSaveTimer = null;
    }

    if (this._isFlushing) {
      this._hasPendingFlush = true;
      return;
    }

    const uid = this.getCurrentUid();
    if (!uid || typeof db === 'undefined') {
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._needsReconnectSync = true;
      return;
    }

    if (!this._hasLoadedOnce || this._loadedUid !== uid) {
      console.warn("尚在等待雲端首次載入，略過本次雲端寫入以避免舊資料覆蓋雲端字庫");
      return;
    }

    this._isFlushing = true;
    try {
      do {
        if (this.getCurrentUid() !== uid) break;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          this._needsReconnectSync = true;
          break;
        }
        this._hasPendingFlush = false;

        const currentApiKey = String(localStorage.getItem(this.LOCAL_APIKEY_KEY) || '');
        const currentSettings = this.getLocalSettings();
        const sanitizedDecks = this.sanitizeDecksForStorage(wordList);
        const compactDecks = this.compactDecksForCloud(sanitizedDecks);
        const currentQuizScore = this.getLocalQuizScore(uid);

        const userDocRef = db.collection('users').doc(uid);
        const chunksColRef = userDocRef.collection('deckChunks');

        const basePayload = deepSanitizeForFirestore({
          apiKey: currentApiKey,
          settings: currentSettings,
          quizScore: currentQuizScore
        });
        basePayload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

        const compactBytes = new Blob([JSON.stringify({
          decks: compactDecks,
          apiKey: currentApiKey,
          settings: currentSettings,
          quizScore: currentQuizScore
        })]).size;

        // 策略 1：精簡後若在 750 KB 以內，直接存入主文件並清理舊分片
        if (compactBytes <= 750000) {
          try {
            const oldChunksSnap = await chunksColRef.get();
            if (!oldChunksSnap.empty) {
              const delBatch = db.batch();
              oldChunksSnap.docs.forEach(d => delBatch.delete(d.ref));
              await delBatch.commit();
            }
          } catch (cleanErr) {}

          await userDocRef.set({
            ...basePayload,
            decks: compactDecks,
            deckChunkCount: 0
          }, { merge: true });
        } else {
          // 策略 2：資料超過 750 KB，自動切分為多個 350 KB 子集合分片寫入（支援無限容量）
          const chunks = this.splitIntoChunks(compactDecks, this.CHUNK_TARGET_BYTES);

          try {
            const existingSnap = await chunksColRef.get();
            const batch = db.batch();

            chunks.forEach((chunkItems, idx) => {
              const chunkRef = chunksColRef.doc(`chunk_${idx}`);
              batch.set(chunkRef, {
                index: idx,
                decks: chunkItems,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              });
            });

            existingSnap.docs.forEach(docSnap => {
              const idx = parseInt(String(docSnap.id).replace('chunk_', ''), 10);
              if (Number.isNaN(idx) || idx >= chunks.length) {
                batch.delete(docSnap.ref);
              }
            });

            batch.set(userDocRef, {
              ...basePayload,
              decks: [],
              deckChunkCount: chunks.length
            }, { merge: true });

            await batch.commit();
          } catch (chunkWriteErr) {
            if (compactBytes <= 980000) {
              await userDocRef.set({
                ...basePayload,
                decks: compactDecks,
                deckChunkCount: 0
              }, { merge: true });
            } else {
              throw chunkWriteErr;
            }
          }
        }

        if (!this._hasPendingFlush) {
          this._retryCount = 0;
          this._needsReconnectSync = false;
          localStorage.removeItem(this.getScopedKey(this.LOCAL_DIRTY_KEY, uid));
          await this.saveDeletedKeysSet(new Set(), uid);
        }
      } while (this._hasPendingFlush);
    } catch (e) {
      console.error("雲端同步失敗:", e && e.code, e && e.message, e);
      this._needsReconnectSync = true;
      const now = Date.now();
      const isOfflineNow = (typeof navigator !== 'undefined' && navigator.onLine === false) || (e && e.code === 'unavailable');
      const isPermErr = e && e.code === 'permission-denied';

      if (!isOfflineNow && typeof showToast === 'function' && now - this._lastSyncErrorToastAt > 5000) {
        this._lastSyncErrorToastAt = now;
        const hint = isPermErr
          ? '（Firestore 權限遭拒，目前僅保留於本機瀏覽器）'
          : (e && (e.code || e.message) ? ` (${e.code || e.message})` : '');
        showToast(`⚠️ 雲端同步失敗${hint}`, 'error');
      }

      // 若為暫時性網路錯誤，做有限次數重試；離線時交由 online 事件重連觸發
      if (!isPermErr && !isOfflineNow && this._retryCount < 3 && !this._retryTimer) {
        this._retryCount++;
        const delayMs = 5000 * this._retryCount;
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.flushCloudSave();
        }, delayMs);
      }
    } finally {
      this._isFlushing = false;
    }
  },

  async saveData(decks, immediate = false) {
    const uid = this.getCurrentUid();
    if ((uid && !this._hasLoadedOnce) || (this._loadedUid !== undefined && this._loadedUid !== uid)) {
      console.warn("帳號切換或雲端首次載入尚未完成，略過本次寫入以避免跨帳號污染");
      return;
    }

    // 立即同步標記本機有未同步變更，避免離線或快速重新整理時遺失狀態
    localStorage.setItem(this.getScopedKey(this.LOCAL_DIRTY_KEY, uid), 'true');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._needsReconnectSync = true;
    }
    this._retryCount = 0;

    const defaultCatName = getStorageDefaultCatName();
    if (Array.isArray(decks)) {
      this.deduplicateSameDeckWords(decks);
    }
    const sanitizedDecks = this.sanitizeDecksForStorage(decks);

    if (Array.isArray(wordList)) {
      wordList.length = 0;
      wordList.push(...sanitizedDecks);
    }
    if (typeof window !== 'undefined' && Array.isArray(window.wordList) && window.wordList !== wordList) {
      window.wordList.length = 0;
      window.wordList.push(...sanitizedDecks);
    }

    const prevSnapshot = Array.isArray(this._lastKnownDecks)
      ? [...this._lastKnownDecks]
      : null;

    // 立即更新記憶體快照，確保後續連續操作拿到最新前態
    this.updateLastKnownDecksSnapshot(sanitizedDecks);

    const runPersistTask = async () => {
      const prevLocalDecks = prevSnapshot !== null
        ? prevSnapshot
        : await this.getLocalDecks(uid);

      await this.setLocalDecks(sanitizedDecks, uid);

      const nextIds = new Set();
      const nextKeys = new Set();
      const nextLegacyKeys = new Set();
      sanitizedDecks.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (c.id) nextIds.add(c.id);
        const compKey = this.buildCardCompositeKey(c, defaultCatName);
        if (compKey) nextKeys.add(compKey);
        const legKey = this.buildLegacyCaseCompositeKey(c, defaultCatName);
        if (legKey) nextLegacyKeys.add(legKey);
      });

      const deletedSet = await this.getDeletedKeysSet(uid);
      nextIds.forEach(id => deletedSet.delete(id));
      nextKeys.forEach(key => deletedSet.delete(key));
      nextLegacyKeys.forEach(key => deletedSet.delete(key));

      let hasNewDeletion = false;
      if (Array.isArray(prevLocalDecks)) {
        prevLocalDecks.forEach(prevCard => {
          if (!prevCard || typeof prevCard !== 'object') return;
          const compKey = this.buildCardCompositeKey(prevCard, defaultCatName);
          const legKey = this.buildLegacyCaseCompositeKey(prevCard, defaultCatName);
          const prevDetId = prevCard.word
            ? generateDeterministicCardId(normalizeDeckCategoryName(prevCard.category, defaultCatName), normalizeCardWordText(prevCard.word))
            : '';

          const stillExists = (prevCard.id && nextIds.has(prevCard.id))
            || (prevDetId && nextIds.has(prevDetId))
            || (compKey && nextKeys.has(compKey))
            || (legKey && nextLegacyKeys.has(legKey));

          if (!stillExists) {
            hasNewDeletion = true;
            if (prevCard.id) deletedSet.add(prevCard.id);
            if (prevDetId) deletedSet.add(prevDetId);
            if (compKey) deletedSet.add(compKey);
            if (legKey) deletedSet.add(legKey);
          }
        });
      }

      await this.saveDeletedKeysSet(deletedSet, uid);
      return hasNewDeletion;
    };

    const taskPromise = this._saveQueue.then(runPersistTask, runPersistTask);
    this._saveQueue = taskPromise.catch(() => false);
    const hasNewDeletion = await taskPromise;

    if (this._cloudSaveTimer) {
      clearTimeout(this._cloudSaveTimer);
      this._cloudSaveTimer = null;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._needsReconnectSync = true;
      return;
    }

    if (immediate || hasNewDeletion) {
      await this.flushCloudSave();
    } else {
      this._cloudSaveTimer = setTimeout(() => {
        this.flushCloudSave();
      }, 400);
    }
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const dirtyKey = StorageEngine.getScopedKey(StorageEngine.LOCAL_DIRTY_KEY);
    if (document.visibilityState === 'hidden') {
      if (StorageEngine._cloudSaveTimer || localStorage.getItem(dirtyKey) === 'true') {
        StorageEngine.flushCloudSave();
      }
    } else if (document.visibilityState === 'visible') {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        if (StorageEngine._needsReconnectSync || StorageEngine._loadedOffline || localStorage.getItem(dirtyKey) === 'true') {
          StorageEngine.syncOnReconnect('visibility');
        }
      }
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const dirtyKey = StorageEngine.getScopedKey(StorageEngine.LOCAL_DIRTY_KEY);
    if (StorageEngine._cloudSaveTimer || localStorage.getItem(dirtyKey) === 'true') {
      StorageEngine.flushCloudSave();
    }
  });

  window.addEventListener('offline', () => {
    StorageEngine._needsReconnectSync = true;
    if (StorageEngine._reconnectTimer) {
      clearTimeout(StorageEngine._reconnectTimer);
      StorageEngine._reconnectTimer = null;
    }
  });

  window.addEventListener('online', () => {
    if (StorageEngine._reconnectTimer) {
      clearTimeout(StorageEngine._reconnectTimer);
    }
    StorageEngine._reconnectTimer = setTimeout(() => {
      StorageEngine._reconnectTimer = null;
      StorageEngine.syncOnReconnect('online');
    }, 800);
  });
}

async function loadStorage() {
  await StorageEngine.loadData();
  StorageEngine.checkAndApplyDailyFSRSToFreeSync();
  if (typeof updateCategorySelects === 'function') updateCategorySelects();
  if (typeof updateUI === 'function') updateUI();
  if (typeof nextCard === 'function') nextCard();
  if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
}

async function saveStorage(immediate = false) {
  await StorageEngine.saveData(wordList, immediate);
}

if (typeof window !== 'undefined') {
  window.StorageEngine = StorageEngine;
  window.applyDailyFSRSToFreeSync = function (force = false, targetList = null) {
    return StorageEngine.checkAndApplyDailyFSRSToFreeSync(force, targetList);
  };
}
