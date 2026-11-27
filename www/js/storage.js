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
  LOCAL_DIRTY_KEY: 'lzhcard_dirty_sync',
  LOCAL_DELETED_KEY: 'lzhcard_deleted_keys',
  LOCAL_TOMBSTONES_KEY: 'lzhcard_tombstones',
  LOCAL_QUIZ_SCORE_KEY: 'lzhcard_quiz_score',
  LOCAL_OWNER_KEY: 'lzhcard_active_uid',
  LOCAL_SETTINGS_DIRTY_KEY: 'lzhcard_settings_dirty',
  LOCAL_MANIFEST_KEY: 'lzhcard_deck_manifest_v2',
  SYNC_BEACON_URL: 'https://lzhcard.tomlin980415.workers.dev/sync/beacon',
  TOMBSTONE_TTL_MS: 90 * 24 * 60 * 60 * 1000,
  MAX_DECK_TOMBSTONES: 400,
  MAX_CARD_TOMBSTONES: 1200,
  CHUNK_TARGET_BYTES: 350000, // 每個雲端分片上限約 350 KB（遠低於 Firestore 1MB 限制）
  _cloudSaveTimer: null,
  _retryTimer: null,
  _retryCount: 0,
  _inFlightLoad: null,
  _lastLoadCompletedAt: 0,
  _isFlushing: false,
  _activeFlushPromise: null,
  _hasPendingFlush: false,
  _lastSyncErrorToastAt: 0,
  _lastKnownDecks: null,
  _deletedKeysCache: null,
  _deletedKeysCacheUid: undefined,
  _tombstonesCache: null,
  _tombstonesCacheUid: undefined,
  _cachedIdToken: '',
  _cachedIdTokenUid: '',
  _syncedManifestByUid: {},
  _syncedMetaHashByUid: {},
  _remoteChunkModeByUid: {},
  _hasLoadedOnce: false,
  _loadedUid: undefined,
  _loadedOffline: false,
  _needsReconnectSync: false,
  _isReconnectingSync: false,
  _reconnectTimer: null,
  _saveQueue: Promise.resolve(),

  withTimeout(promise, ms = 10000, label = 'Firestore') {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} timeout (${ms}ms)`));
      }, Math.max(500, Number(ms) || 10000));
      Promise.resolve(promise).then(
        (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  },

  setWordListInPlace(nextList) {
    const safeList = Array.isArray(nextList) ? nextList : [];
    if (typeof wordList !== 'undefined' && Array.isArray(wordList)) {
      wordList.length = 0;
      wordList.push(...safeList);
      if (typeof window !== 'undefined') {
        window.wordList = wordList;
      }
      return wordList;
    }
    if (typeof window !== 'undefined') {
      if (!Array.isArray(window.wordList)) window.wordList = [];
      window.wordList.length = 0;
      window.wordList.push(...safeList);
      return window.wordList;
    }
    return safeList;
  },

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

  getDefaultSettingsObject() {
    let defaultNative = 'zh-TW';
    try {
      const navLang = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language.toLowerCase() : '';
      if (navLang.startsWith('zh')) defaultNative = 'zh-TW';
      else if (navLang.startsWith('ja')) defaultNative = 'ja';
      else defaultNative = 'en';
    } catch (e) {}
    return {
      nativeLang: defaultNative,
      targetLang: 'en',
      customNative: '',
      customTarget: '',
      displayMode: 'target_front',
      phoneticPos: 'front',
      theme: 'system',
      studyMode: 'fsrs',
      autoPlayAudio: false,
      showSentenceFront: false,
      notifFriendMsg: true,
      notifAnnouncements: true,
      notifFriendRequests: true,
      notifTeamInvites: true,
      onboardingCompleted: false,
      onboardingV2Done: false
    };
  },

  applyDefaultSettings(options = {}) {
    const defaults = this.getDefaultSettingsObject();
    localStorage.setItem('lzhcard_native_lang', defaults.nativeLang);
    localStorage.setItem('lzhcard_target_lang', defaults.targetLang);
    localStorage.removeItem('lzhcard_custom_native');
    localStorage.removeItem('lzhcard_custom_target');
    localStorage.setItem('lzhcard_display_mode', defaults.displayMode);
    localStorage.setItem('lzhcard_phonetic_pos', defaults.phoneticPos);
    localStorage.setItem('theme_preference', defaults.theme);
    localStorage.setItem('lzhcard_study_mode', defaults.studyMode);
    localStorage.setItem('lzhcard_auto_audio', 'false');
    localStorage.setItem('lzhcard_show_sentence_front', 'false');
    localStorage.setItem('lzhcard_show_morphemes', 'true');
    localStorage.setItem('lzhcard_floating_translator_enabled', 'false');
    localStorage.setItem('lzhcard_notif_friend_msg', 'true');
    localStorage.setItem('lzhcard_notif_announcements', 'true');
    localStorage.setItem('lzhcard_notif_friend_requests', 'true');
    localStorage.setItem('lzhcard_notif_team_invites', 'true');
    localStorage.removeItem('flashcard_gemini_key_v1');
    localStorage.removeItem('lzhcard_groq_key_v1');
    localStorage.removeItem('lzhcard_api_mode');

    if (options && options.resetOnboardingFlags !== false) {
      localStorage.removeItem('lzhcard_onboarding_completed');
      localStorage.removeItem('lzhcard_onboarding_v2_done');
      if (typeof window !== 'undefined') {
        if (!window.userData || typeof window.userData !== 'object') window.userData = {};
        window.userData.settings = {};
      }
    }

    if (typeof window !== 'undefined') {
      window.isManualFreePractice = false;
    }

    if (options && options.syncUI !== false) {
      if (typeof syncSettingsUI === 'function') syncSettingsUI();
      if (typeof syncChatNotificationMuteIndicators === 'function') syncChatNotificationMuteIndicators();
      if (typeof applyLanguageUI === 'function') applyLanguageUI();
      if (typeof applyTheme === 'function') applyTheme(defaults.theme);
      if (typeof renderFrontContextSentence === 'function' && typeof currentCard !== 'undefined') {
        renderFrontContextSentence(currentCard);
      }
    }
    return defaults;
  },

  resetGuestToDefaultSettings(options = {}) {
    this.clearCrossAccountLocalCache();
    localStorage.setItem(this.LOCAL_OWNER_KEY, 'guest');
    if (options && options.resetGuestOnboarding) {
      localStorage.removeItem('lzhcard_onboarding_completed__guest');
      localStorage.removeItem('lzhcard_onboarding_v2_done__guest');
    }
    return this.applyDefaultSettings({
      syncUI: options?.syncUI !== false,
      resetOnboardingFlags: true
    });
  },

  clearCrossAccountLocalCache() {
    localStorage.removeItem('flashcard_gemini_key_v1');
    localStorage.removeItem('lzhcard_groq_key_v1');
    localStorage.removeItem('lzhcard_ios_screen_translate_cfg_v1');
    localStorage.removeItem('lzhcard_native_lang');
    localStorage.removeItem('lzhcard_target_lang');
    localStorage.removeItem('lzhcard_custom_native');
    localStorage.removeItem('lzhcard_custom_target');
    localStorage.removeItem('lzhcard_display_mode');
    localStorage.removeItem('lzhcard_phonetic_pos');
    localStorage.removeItem('theme_preference');
    localStorage.removeItem('lzhcard_api_mode');
    localStorage.removeItem('lzhcard_study_mode');
    localStorage.removeItem('lzhcard_auto_audio');
    localStorage.removeItem('lzhcard_show_sentence_front');
    localStorage.removeItem('lzhcard_show_morphemes');
    localStorage.removeItem('lzhcard_floating_translator_enabled');
    localStorage.removeItem('lzhcard_notif_friend_msg');
    localStorage.removeItem('lzhcard_notif_announcements');
    localStorage.removeItem('lzhcard_notif_friend_requests');
    localStorage.removeItem('lzhcard_notif_team_invites');
    localStorage.removeItem('lzhcard_selected_categories');
    localStorage.removeItem('lzhcard_onboarding_completed');
    localStorage.removeItem('lzhcard_onboarding_v2_done');
    if (typeof window !== 'undefined') {
      window.isManualFreePractice = false;
      window.selectedCategories = ['ALL'];
      if (window.userData && typeof window.userData !== 'object') {
        window.userData = {};
      }
      if (window.userData && typeof window.userData === 'object') {
        window.userData.settings = {};
      }
    }
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
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
    this._lastLoadCompletedAt = 0;
    this._activeFlushPromise = null;
    this._lastKnownDecks = null;
    this._deletedKeysCache = null;
    this._deletedKeysCacheUid = undefined;
    this._tombstonesCache = null;
    this._tombstonesCacheUid = undefined;

    const targetUid = uid || 'guest';
    const idbKeys = [
      this.getScopedKey(this.LOCAL_DECKS_KEY, targetUid),
      this.getScopedKey(this.LOCAL_DELETED_KEY, targetUid),
      this.getScopedKey(this.LOCAL_TOMBSTONES_KEY, targetUid)
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

  pruneTombstones(rawTombstones, now = Date.now()) {
    const cutoff = now - this.TOMBSTONE_TTL_MS;
    const cleanMap = (inputMap, maxEntries) => {
      if (!inputMap || typeof inputMap !== 'object' || Array.isArray(inputMap)) return {};
      const valid = [];
      Object.keys(inputMap).forEach((k) => {
        const cleanKey = String(k || '').trim();
        const ts = toFiniteNumber(inputMap[k], 0);
        if (cleanKey && ts > 0 && ts >= cutoff) {
          valid.push([cleanKey, ts]);
        }
      });
      if (valid.length > maxEntries) {
        valid.sort((a, b) => b[1] - a[1]);
        valid.length = maxEntries;
      }
      const out = {};
      valid.forEach(([k, ts]) => {
        out[k] = ts;
      });
      return out;
    };

    const src = (rawTombstones && typeof rawTombstones === 'object') ? rawTombstones : {};
    return {
      deletedDecks: cleanMap(src.deletedDecks, this.MAX_DECK_TOMBSTONES),
      deletedCards: cleanMap(src.deletedCards, this.MAX_CARD_TOMBSTONES)
    };
  },

  mergeTombstones(baseTombstones, incomingTombstones, now = Date.now()) {
    const a = this.pruneTombstones(baseTombstones, now);
    const b = this.pruneTombstones(incomingTombstones, now);
    const merged = {
      deletedDecks: { ...a.deletedDecks },
      deletedCards: { ...a.deletedCards }
    };
    let changedFromBase = false;

    ['deletedDecks', 'deletedCards'].forEach((bucket) => {
      Object.keys(b[bucket]).forEach((key) => {
        const bTs = b[bucket][key];
        const aTs = merged[bucket][key] || 0;
        if (bTs > aTs) {
          merged[bucket][key] = bTs;
          changedFromBase = true;
        }
      });
    });

    const pruned = this.pruneTombstones(merged, now);
    return { merged: pruned, changedFromBase };
  },

  async getTombstones(uid = this.getCurrentUid()) {
    const scopeId = uid || 'guest';
    if (this._tombstonesCache && this._tombstonesCacheUid === scopeId) {
      return this.pruneTombstones(this._tombstonesCache);
    }

    const scopedKey = this.getScopedKey(this.LOCAL_TOMBSTONES_KEY, uid);
    try {
      const idbVal = await LocalIDB.get(scopedKey);
      if (idbVal && typeof idbVal === 'object') {
        if (localStorage.getItem(scopedKey) !== null) {
          localStorage.removeItem(scopedKey);
        }
        const pruned = this.pruneTombstones(idbVal);
        this._tombstonesCache = pruned;
        this._tombstonesCacheUid = scopeId;
        return this.pruneTombstones(pruned);
      }
    } catch (e) {
      try {
        const raw = localStorage.getItem(scopedKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          const pruned = this.pruneTombstones(parsed);
          this._tombstonesCache = pruned;
          this._tombstonesCacheUid = scopeId;
          return this.pruneTombstones(pruned);
        }
      } catch (err) {}
    }

    const empty = { deletedDecks: {}, deletedCards: {} };
    this._tombstonesCache = empty;
    this._tombstonesCacheUid = scopeId;
    return { deletedDecks: {}, deletedCards: {} };
  },

  async saveTombstones(tombstones, uid = this.getCurrentUid()) {
    const scopeId = uid || 'guest';
    const scopedKey = this.getScopedKey(this.LOCAL_TOMBSTONES_KEY, uid);
    const pruned = this.pruneTombstones(tombstones);
    this._tombstonesCache = pruned;
    this._tombstonesCacheUid = scopeId;

    const hasEntries = Object.keys(pruned.deletedDecks).length > 0 || Object.keys(pruned.deletedCards).length > 0;
    if (!hasEntries) {
      try { await LocalIDB.remove(scopedKey); } catch (e) {}
      localStorage.removeItem(scopedKey);
      return pruned;
    }

    try {
      await LocalIDB.set(scopedKey, pruned);
      if (localStorage.getItem(scopedKey) !== null) {
        localStorage.removeItem(scopedKey);
      }
    } catch (e) {
      try {
        localStorage.setItem(scopedKey, JSON.stringify(pruned));
      } catch (err) {}
    }
    return pruned;
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
        bossWrongCount: toFiniteNumber(card.bossWrongCount, 0),
        lastBossWrongAt: toFiniteNumber(card.lastBossWrongAt, 0),
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
      if (c.bossWrongCount > 0) out.bossWrongCount = c.bossWrongCount;
      if (c.lastBossWrongAt > 0) out.lastBossWrongAt = c.lastBossWrongAt;
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
   * 🔀 嚴格依決定性 id 與時間戳記墓碑（Tombstone）進行 Upsert 合併去重（保留 updatedAt 較新者，徹底杜絕已刪除字庫復活）
   */
  async mergeRemoteAndLocalDecks(remoteDecks, localDecks, isLocalDirty, uid = this.getCurrentUid(), remoteTombstones = null) {
    const now = Date.now();
    const defaultCatName = getStorageDefaultCatName();
    const legacyDeletedSet = await this.getDeletedKeysSet(uid);
    const localTombstones = await this.getTombstones(uid);

    // 將舊版 LOCAL_DELETED_KEY 中的 card_ / deck_ 鍵值遷移至新版含時間戳記的 Tombstones
    const migratedFromLegacy = { deletedDecks: {}, deletedCards: {} };
    const residualLegacyKeys = new Set();
    if (legacyDeletedSet.size > 0) {
      legacyDeletedSet.forEach((k) => {
        const keyStr = String(k || '').trim();
        if (!keyStr) return;
        if (keyStr.startsWith('deck_')) {
          migratedFromLegacy.deletedDecks[keyStr] = now;
        } else if (keyStr.startsWith('card_')) {
          migratedFromLegacy.deletedCards[keyStr] = now;
        } else {
          residualLegacyKeys.add(keyStr);
        }
      });
    }

    const withLegacy = this.mergeTombstones(localTombstones, migratedFromLegacy, now).merged;
    const remotePruned = this.pruneTombstones(remoteTombstones, now);
    const { merged: mergedTombstones, changedFromBase: localHadNewerThanRemote } = this.mergeTombstones(
      remotePruned,
      withLegacy,
      now
    );

    const remoteArr = Array.isArray(remoteDecks) ? remoteDecks : [];
    const localArr = Array.isArray(localDecks) ? localDecks : [];

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

    const matchesResidualLegacy = (rawCard) => {
      if (residualLegacyKeys.size === 0 || !rawCard || typeof rawCard !== 'object') return false;
      const normCompKey = this.buildCardCompositeKey(rawCard, defaultCatName);
      const legacyCompKey = this.buildLegacyCaseCompositeKey(rawCard, defaultCatName);
      return Boolean(
        (rawCard.id && residualLegacyKeys.has(rawCard.id)) ||
        (normCompKey && residualLegacyKeys.has(normCompKey)) ||
        (legacyCompKey && residualLegacyKeys.has(legacyCompKey))
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

    let needsCloudSync = Boolean(isLocalDirty || localHadNewerThanRemote || legacyDeletedSet.size > 0);
    const upsertedMap = new Map();

    const upsertRecord = (rawCard, source, idx) => {
      if (!rawCard || typeof rawCard !== 'object') return;

      const normalized = canonicalizeCard(rawCard, idx);
      const detId = normalized.id;
      const deckId = normalized.deckId;
      const rawId = rawCard.id ? String(rawCard.id).trim() : '';
      const cardUpdatedAt = toFiniteNumber(rawCard.updatedAt, 0);

      if (matchesResidualLegacy(rawCard)) {
        if (source === 'remote' || !isLocalDirty) {
          mergedTombstones.deletedCards[detId] = Math.max(mergedTombstones.deletedCards[detId] || 0, now);
          needsCloudSync = true;
          return;
        }
      }

      const cardTombstoneTs = Math.max(
        mergedTombstones.deletedCards[detId] || 0,
        (rawId && mergedTombstones.deletedCards[rawId]) || 0
      );
      const deckTombstoneTs = mergedTombstones.deletedDecks[deckId] || 0;
      const tombstoneTs = Math.max(cardTombstoneTs, deckTombstoneTs);

      if (tombstoneTs > 0) {
        if (cardUpdatedAt <= tombstoneTs) {
          if (source === 'remote') {
            needsCloudSync = true;
          }
          return;
        }
        // 使用者於刪除之後重新加入/匯入此單字：保留單字並清除過期單卡墓碑
        if (cardTombstoneTs > 0 && cardUpdatedAt > cardTombstoneTs) {
          delete mergedTombstones.deletedCards[detId];
          if (rawId) delete mergedTombstones.deletedCards[rawId];
          needsCloudSync = true;
        }
      }

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

    const savedTombstones = await this.saveTombstones(mergedTombstones, uid);
    if (legacyDeletedSet.size > 0) {
      await this.saveDeletedKeysSet(new Set(), uid);
    }

    const mergedList = this.sanitizeDecksForStorage(Array.from(upsertedMap.values()));
    return { decks: mergedList, needsCloudSync, tombstones: savedTombstones };
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
      studyMode: (localStorage.getItem('lzhcard_study_mode') === 'free' || (typeof window !== 'undefined' && window.isManualFreePractice)) ? 'free' : 'fsrs',
      autoPlayAudio: localStorage.getItem('lzhcard_auto_audio') === 'true',
      showSentenceFront: localStorage.getItem('lzhcard_show_sentence_front') === 'true',
      showMorphemes: localStorage.getItem('lzhcard_show_morphemes') !== 'false',
      notifFriendMsg: localStorage.getItem('lzhcard_notif_friend_msg') !== 'false',
      notifAnnouncements: localStorage.getItem('lzhcard_notif_announcements') !== 'false',
      notifFriendRequests: localStorage.getItem('lzhcard_notif_friend_requests') !== 'false',
      notifTeamInvites: localStorage.getItem('lzhcard_notif_team_invites') !== 'false',
      onboardingCompleted: (typeof window !== 'undefined' && typeof window.hasSeenOnboardingSetup === 'function')
        ? window.hasSeenOnboardingSetup()
        : (localStorage.getItem('lzhcard_onboarding_completed') === 'true'),
      onboardingV2Done: (typeof window !== 'undefined' && typeof window.hasSeenOnboardingTour === 'function')
        ? window.hasSeenOnboardingTour()
        : (localStorage.getItem('lzhcard_onboarding_v2_done') === 'true')
    });
  },

  applyRemoteSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (settings.nativeLang) localStorage.setItem('lzhcard_native_lang', settings.nativeLang);
    if (settings.targetLang) localStorage.setItem('lzhcard_target_lang', settings.targetLang);
    if (typeof settings.customNative === 'string') localStorage.setItem('lzhcard_custom_native', settings.customNative);
    if (typeof settings.customTarget === 'string') localStorage.setItem('lzhcard_custom_target', settings.customTarget);
    if (settings.displayMode) localStorage.setItem('lzhcard_display_mode', settings.displayMode);
    if (settings.phoneticPos) localStorage.setItem('lzhcard_phonetic_pos', settings.phoneticPos);
    if (settings.theme) localStorage.setItem('theme_preference', settings.theme);
    if (settings.studyMode === 'free' || settings.studyMode === 'fsrs') {
      localStorage.setItem('lzhcard_study_mode', settings.studyMode);
      if (typeof window !== 'undefined') {
        window.isManualFreePractice = (settings.studyMode === 'free');
      }
    }
    if (typeof settings.autoPlayAudio === 'boolean') {
      localStorage.setItem('lzhcard_auto_audio', settings.autoPlayAudio ? 'true' : 'false');
    }
    if (typeof settings.showSentenceFront === 'boolean') {
      localStorage.setItem('lzhcard_show_sentence_front', settings.showSentenceFront ? 'true' : 'false');
    }
    if (typeof settings.showMorphemes === 'boolean') {
      localStorage.setItem('lzhcard_show_morphemes', settings.showMorphemes ? 'true' : 'false');
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

    if (settings.onboardingCompleted === true) {
      if (typeof window !== 'undefined' && typeof window.markOnboardingSetupSeen === 'function') {
        window.markOnboardingSetupSeen(false);
      } else {
        localStorage.setItem('lzhcard_onboarding_completed', 'true');
        const uid = this.getCurrentUid();
        if (uid) localStorage.setItem(`lzhcard_onboarding_completed__${uid}`, 'true');
      }
      if (typeof closeModal === 'function') closeModal('onboardingSetupModal');
    }
    if (settings.onboardingV2Done === true) {
      if (typeof window !== 'undefined' && typeof window.markOnboardingTourSeen === 'function') {
        window.markOnboardingTourSeen(false);
      } else {
        localStorage.setItem('lzhcard_onboarding_v2_done', 'true');
        const uid = this.getCurrentUid();
        if (uid) localStorage.setItem(`lzhcard_onboarding_v2_done__${uid}`, 'true');
      }
    }

    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof syncChatNotificationMuteIndicators === 'function') syncChatNotificationMuteIndicators();
    if (typeof applyLanguageUI === 'function') applyLanguageUI();
    if (typeof applyTheme === 'function') applyTheme(settings.theme || 'system');
    if (typeof refreshFSRSUIBadges === 'function') refreshFSRSUIBadges();
    if (typeof updateStudyQueueUI === 'function') updateStudyQueueUI();
    if (typeof renderFrontContextSentence === 'function' && typeof currentCard !== 'undefined') {
      renderFrontContextSentence(currentCard);
    }
  },

  async saveSettingsOnly(extraPatch = {}) {
    const uid = this.getCurrentUid();
    const currentSettings = deepSanitizeForFirestore({
      ...this.getLocalSettings(),
      ...(extraPatch && typeof extraPatch === 'object' ? extraPatch : {})
    });

    if (typeof window !== 'undefined') {
      if (!window.userData || typeof window.userData !== 'object') window.userData = {};
      window.userData.settings = { ...(window.userData.settings || {}), ...currentSettings };
    }

    if (!uid || typeof db === 'undefined' || !db) {
      return true;
    }

    const dirtyKey = this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid);
    localStorage.setItem(dirtyKey, 'true');

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._needsReconnectSync = true;
      return false;
    }

    try {
      const payload = {
        settings: currentSettings,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('users').doc(uid).set(payload, { merge: true });
      localStorage.removeItem(dirtyKey);
      return true;
    } catch (e) {
      console.warn('即時儲存個人設定至雲端失敗（已保留待重連同步）:', e);
      this._needsReconnectSync = true;
      return false;
    }
  },

  async refreshCachedIdToken(uid = this.getCurrentUid()) {
    try {
      const user = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser)
        || (typeof auth !== 'undefined' && auth && auth.currentUser)
        || null;
      if (user && !user.isAnonymous && typeof user.getIdToken === 'function') {
        const tok = await user.getIdToken(false);
        if (tok) {
          this._cachedIdToken = tok;
          this._cachedIdTokenUid = user.uid || uid || '';
        }
        return tok || '';
      }
    } catch (e) {}
    return '';
  },

  readSyncedManifestState(uid = this.getCurrentUid()) {
    const key = this.getScopedKey(this.LOCAL_MANIFEST_KEY, uid || 'guest');
    if (this._syncedManifestByUid[uid || 'guest']) {
      return this._syncedManifestByUid[uid || 'guest'];
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const state = {
            deckHashes: parsed.deckHashes && typeof parsed.deckHashes === 'object' ? parsed.deckHashes : {},
            metaHash: typeof parsed.metaHash === 'string' ? parsed.metaHash : '',
            chunkMode: typeof parsed.chunkMode === 'string' ? parsed.chunkMode : ''
          };
          this._syncedManifestByUid[uid || 'guest'] = state;
          return state;
        }
      }
    } catch (e) {}
    return { deckHashes: {}, metaHash: '', chunkMode: '' };
  },

  writeSyncedManifestState(uid, state) {
    const scope = uid || 'guest';
    const cleanState = {
      deckHashes: state && state.deckHashes && typeof state.deckHashes === 'object' ? state.deckHashes : {},
      metaHash: state && typeof state.metaHash === 'string' ? state.metaHash : '',
      chunkMode: state && typeof state.chunkMode === 'string' ? state.chunkMode : ''
    };
    this._syncedManifestByUid[scope] = cleanState;
    try {
      localStorage.setItem(this.getScopedKey(this.LOCAL_MANIFEST_KEY, scope), JSON.stringify(cleanState));
    } catch (e) {}
  },

  buildDeckChunksAndManifest(compactDecks) {
    const byDeck = new Map();
    const arr = Array.isArray(compactDecks) ? compactDecks : [];
    arr.forEach(card => {
      if (!card || typeof card !== 'object') return;
      const dId = card.deckId || generateDeterministicDeckId(card.category);
      if (!byDeck.has(dId)) byDeck.set(dId, []);
      byDeck.get(dId).push(card);
    });

    const deckManifest = {};
    const deckChunks = [];
    let hasOversizedDeck = false;

    byDeck.forEach((cards, deckId) => {
      const sorted = cards.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
      const serialized = JSON.stringify(sorted);
      const byteSize = typeof Blob !== 'undefined' ? new Blob([serialized]).size : serialized.length * 2;
      if (byteSize > 720000) {
        hasOversizedDeck = true;
      }
      const hash = hashStringStableHex(serialized);
      let maxUpdated = 0;
      sorted.forEach(c => {
        const ts = toFiniteNumber(c.updatedAt, 0);
        if (ts > maxUpdated) maxUpdated = ts;
      });
      deckManifest[deckId] = {
        hash,
        count: sorted.length,
        updatedAt: maxUpdated
      };
      deckChunks.push({
        deckId,
        hash,
        cardCount: sorted.length,
        updatedAt: maxUpdated,
        decks: sorted,
        byteSize
      });
    });

    return { deckManifest, deckChunks, hasOversizedDeck };
  },

  async fetchRemoteUserDocAndDecks(uid, cachedLocalDecks = null) {
    if (!uid || typeof db === 'undefined') return null;
    this.refreshCachedIdToken(uid);
    const docRef = db.collection('users').doc(uid);
    const doc = await this.withTimeout(docRef.get(), 10000, 'userDocGet');
    if (!doc.exists) {
      return { exists: false, data: null, remoteDecks: [] };
    }

    const data = doc.data() || {};
    let remoteDecks = [];

    // 策略 A：新版每字庫獨立分片 + Manifest 差異讀取（未變動字庫 0 讀取）
    if (data.deckChunkCount === -1 && data.deckManifest && typeof data.deckManifest === 'object') {
      this._remoteChunkModeByUid[uid] = 'manifest_v2';
      const remoteManifest = data.deckManifest;
      const localList = Array.isArray(cachedLocalDecks) ? cachedLocalDecks : await this.getLocalDecks(uid);
      const localState = this.readSyncedManifestState(uid);
      const localByDeck = new Map();
      localList.forEach(c => {
        if (!c || typeof c !== 'object') return;
        const dId = c.deckId || generateDeterministicDeckId(c.category);
        if (!localByDeck.has(dId)) localByDeck.set(dId, []);
        localByDeck.get(dId).push(c);
      });

      const manifestKeys = Object.keys(remoteManifest);
      const decksToFetch = [];

      manifestKeys.forEach(deckId => {
        const rMeta = remoteManifest[deckId] || {};
        const lHash = localState.deckHashes[deckId];
        const lCards = localByDeck.get(deckId);
        if (lHash && rMeta.hash && lHash === rMeta.hash && Array.isArray(lCards) && lCards.length === Number(rMeta.count || 0)) {
          remoteDecks.push(...lCards);
        } else {
          decksToFetch.push(deckId);
        }
      });

      if (decksToFetch.length > 0) {
        if (decksToFetch.length > 6 && decksToFetch.length === manifestKeys.length) {
          const chunksSnap = await this.withTimeout(docRef.collection('deckChunks').get(), 12000, 'deckChunksGet');
          chunksSnap.docs.forEach(cd => {
            const cData = cd.data() || {};
            if (Array.isArray(cData.decks)) {
              remoteDecks.push(...cData.decks);
            }
          });
        } else {
          const chunkDocs = await Promise.all(
            decksToFetch.map(deckId => this.withTimeout(docRef.collection('deckChunks').doc(deckId).get(), 10000, 'deckChunkDocGet').catch(() => null))
          );
          chunkDocs.forEach((docSnap, idx) => {
            if (docSnap && docSnap.exists) {
              const cData = docSnap.data() || {};
              if (Array.isArray(cData.decks)) {
                remoteDecks.push(...cData.decks);
              }
            } else {
              const fallbackLocal = localByDeck.get(decksToFetch[idx]);
              if (Array.isArray(fallbackLocal) && fallbackLocal.length > 0) {
                remoteDecks.push(...fallbackLocal);
              }
            }
          });
        }
      }

      const nextSyncedDeckHashes = {};
      manifestKeys.forEach(k => {
        if (remoteManifest[k] && remoteManifest[k].hash) {
          nextSyncedDeckHashes[k] = remoteManifest[k].hash;
        }
      });
      this.writeSyncedManifestState(uid, {
        ...localState,
        deckHashes: nextSyncedDeckHashes,
        chunkMode: 'manifest_v2'
      });
    } else if (typeof data.deckChunkCount === 'number' && data.deckChunkCount > 0) {
      this._remoteChunkModeByUid[uid] = 'legacy_chunk';
      const chunksSnap = await this.withTimeout(docRef.collection('deckChunks').get(), 12000, 'legacyDeckChunksGet');
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
    } else if (Array.isArray(data.decks)) {
      this._remoteChunkModeByUid[uid] = 'inline';
      remoteDecks = data.decks;
    } else if (Array.isArray(data.wordList)) {
      this._remoteChunkModeByUid[uid] = 'legacy_wordlist';
      remoteDecks = data.wordList;
    }

    return { exists: true, data, remoteDecks };
  },

  async loadData() {
    const uid = this.getCurrentUid();
    const loadKey = uid || 'guest';

    // 若 Firebase Auth 首次狀態尚未回調，且本機有已登入帳號紀錄，避免啟動競態誤將身分覆寫為訪客並清空快取
    const authResolvedOnce = (typeof window !== 'undefined' && window.__authStateResolvedOnce === true);
    const prevOwner = localStorage.getItem(this.LOCAL_OWNER_KEY);
    if (!uid && !authResolvedOnce && prevOwner && prevOwner !== 'guest') {
      // 保留 prevOwner 快取與設定，靜待 onAuthStateChanged 接手
    } else {
      if (prevOwner && prevOwner !== loadKey) {
        this.clearCrossAccountLocalCache();
      }
      localStorage.setItem(this.LOCAL_OWNER_KEY, loadKey);

      if (!uid && (!prevOwner || prevOwner !== 'guest')) {
        this.applyDefaultSettings({ syncUI: true, resetOnboardingFlags: prevOwner && prevOwner !== 'guest' });
      }
    }

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
      this._lastLoadCompletedAt = 0;
      this._loadedOffline = false;
      this._needsReconnectSync = false;
      this._lastKnownDecks = null;
      this._deletedKeysCache = null;
      this._deletedKeysCacheUid = undefined;
      this._tombstonesCache = null;
      this._tombstonesCacheUid = undefined;
      this.setWordListInPlace([]);
    }

    if (this._inFlightLoad && this._inFlightLoad.key === loadKey) {
      return this._inFlightLoad.promise;
    }

    if (
      uid &&
      this._hasLoadedOnce &&
      this._loadedUid === uid &&
      !this._loadedOffline &&
      !this._needsReconnectSync &&
      (Date.now() - (this._lastLoadCompletedAt || 0)) < 1200
    ) {
      return wordList;
    }

    const runLoad = async () => {
      const dirtyKey = this.getScopedKey(this.LOCAL_DIRTY_KEY, uid);
      const settingsDirtyKey = this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid);
      const isSettingsDirty = Boolean(uid && localStorage.getItem(settingsDirtyKey) === 'true');
      const localDecks = await this.getLocalDecks(uid);
      const isLocalDirty = localStorage.getItem(dirtyKey) === 'true';

      if (uid && typeof db !== 'undefined' && db) {
        try {
          const fetched = await this.fetchRemoteUserDocAndDecks(uid, localDecks);

          // 若等待雲端回應期間又切換了帳號，直接中止這次過期的載入
          if (this.getCurrentUid() !== uid) return wordList;

          if (fetched && fetched.exists) {
            const { data, remoteDecks } = fetched;
            const remoteTombstones = {
              deletedDecks: data.deletedDecks || {},
              deletedCards: data.deletedCards || {}
            };
            const { decks: mergedDecks, needsCloudSync } = await this.mergeRemoteAndLocalDecks(
              remoteDecks,
              localDecks,
              isLocalDirty,
              uid,
              remoteTombstones
            );

            if (this.getCurrentUid() !== uid) return wordList;

            const cleanMerged = this.sanitizeDecksForStorage(mergedDecks);
            const migrated = this.migrateAllCardsFSRS(cleanMerged);
            const deduped = this.deduplicateSameDeckWords(cleanMerged);
            this.setWordListInPlace(cleanMerged);
            await this.setLocalDecks(wordList, uid);
            this.updateLastKnownDecksSnapshot(wordList);
            this._hasLoadedOnce = true;
            this._loadedUid = uid;
            this._lastLoadCompletedAt = Date.now();
            this._loadedOffline = false;
            this._needsReconnectSync = false;

            const localQuiz = this.getLocalQuizScore(uid);
            const remoteQuiz = data.quizScore || { correct: 0, total: 0, updatedAt: 0 };
            const bestQuiz = (localQuiz.updatedAt || 0) > (remoteQuiz.updatedAt || 0) ? localQuiz : remoteQuiz;
            this.applyQuizScoreState(bestQuiz, uid);

            if (typeof window !== 'undefined') {
              if (!window.userData || typeof window.userData !== 'object') window.userData = {};
              if (data.role === 'admin' || data.isAdmin === true) {
                window.userData.role = 'admin';
                window.userData.isAdmin = true;
              } else if (window.userData.role !== 'admin' && window.userData.isAdmin !== true && data.role) {
                window.userData.role = data.role;
                if (typeof data.isAdmin === 'boolean') window.userData.isAdmin = data.isAdmin;
              }
              if (Array.isArray(data.blockedUids)) {
                window.userData.blockedUids = Array.from(new Set(data.blockedUids.filter(Boolean)));
              }
              if (typeof checkAdminPermissions === 'function') checkAdminPermissions();
              if (typeof renderBlockedUsersSettingsList === 'function') renderBlockedUsersSettingsList();
            }

            // 🔥 關鍵：必須先套用雲端 settings 與金鑰模式，再執行 flushCloudSave()，徹底杜絕預設值反蓋雲端設定！
            if (data.settings && typeof data.settings === 'object') {
              if (isSettingsDirty) {
                const mergedSettings = { ...data.settings, ...this.getLocalSettings() };
                if (typeof window !== 'undefined') {
                  if (!window.userData || typeof window.userData !== 'object') window.userData = {};
                  window.userData.settings = mergedSettings;
                }
                this.applyRemoteSettings(mergedSettings);
              } else {
                if (typeof window !== 'undefined') {
                  if (!window.userData || typeof window.userData !== 'object') window.userData = {};
                  window.userData.settings = { ...data.settings };
                }
                this.applyRemoteSettings(data.settings);
              }
            } else if (!isSettingsDirty) {
              this.applyDefaultSettings({ syncUI: true, resetOnboardingFlags: true });
            }

            localStorage.removeItem('flashcard_gemini_key_v1');
            localStorage.removeItem('lzhcard_groq_key_v1');
            localStorage.removeItem('lzhcard_api_mode');

            const hasLegacyWordListField = Array.isArray(data.wordList);
            if (migrated || deduped || needsCloudSync || hasLegacyWordListField || isSettingsDirty || (localQuiz.updatedAt || 0) > (remoteQuiz.updatedAt || 0)) {
              await this.flushCloudSave();
            } else {
              localStorage.removeItem(dirtyKey);
              localStorage.removeItem(settingsDirtyKey);
            }

            if (typeof syncSettingsUI === 'function') syncSettingsUI();
            if (typeof syncConfigToNativeOverlay === 'function') syncConfigToNativeOverlay();
            if (typeof LZHEntitlements !== 'undefined' && typeof LZHEntitlements.notifyStateChange === 'function') {
              LZHEntitlements.notifyStateChange('storage_loaded_settings', {});
            }

            if (typeof checkAndOpenOnboardingModal === 'function') {
              checkAndOpenOnboardingModal();
            }

            this.checkAndApplyDailyFSRSToFreeSync();
            return wordList;
          } else if (fetched && !fetched.exists) {
            if (this.getCurrentUid() !== uid) return wordList;

            if (!isSettingsDirty) {
              this.applyDefaultSettings({ syncUI: true, resetOnboardingFlags: true });
            }

            const initialDecks = Array.isArray(localDecks) ? localDecks : [];
            const { decks: mergedInitial } = await this.mergeRemoteAndLocalDecks(
              [],
              initialDecks,
              isLocalDirty,
              uid,
              null
            );
            this.migrateAllCardsFSRS(mergedInitial);
            this.deduplicateSameDeckWords(mergedInitial);
            this.setWordListInPlace(this.sanitizeDecksForStorage(mergedInitial));
            await this.setLocalDecks(wordList, uid);
            this.updateLastKnownDecksSnapshot(wordList);
            this._hasLoadedOnce = true;
            this._loadedUid = uid;
            this._lastLoadCompletedAt = Date.now();
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

      const cleanLocal = this.sanitizeDecksForStorage(Array.isArray(localDecks) ? localDecks : []);
      const migratedLocal = this.migrateAllCardsFSRS(cleanLocal);
      const dedupedLocal = this.deduplicateSameDeckWords(cleanLocal);
      this.setWordListInPlace(cleanLocal);
      if (migratedLocal || dedupedLocal) {
        await this.setLocalDecks(wordList, uid);
      }
      this.updateLastKnownDecksSnapshot(wordList);
      this._hasLoadedOnce = true;
      this._loadedUid = uid;
      this._lastLoadCompletedAt = Date.now();
      if (uid && (typeof db === 'undefined' || !db || typeof navigator === 'undefined' || navigator.onLine === false)) {
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
    const settingsDirtyKey = this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid);
    const isLocalDirty = localStorage.getItem(dirtyKey) === 'true';
    const isSettingsDirty = localStorage.getItem(settingsDirtyKey) === 'true';
    const deletedSet = await this.getDeletedKeysSet(uid);
    const localTombstones = await this.getTombstones(uid);
    const hasTombstones = Object.keys(localTombstones.deletedDecks).length > 0 || Object.keys(localTombstones.deletedCards).length > 0;
    const hasOfflinePending = Boolean(
      this._needsReconnectSync ||
      this._loadedOffline ||
      isLocalDirty ||
      isSettingsDirty ||
      deletedSet.size > 0 ||
      hasTombstones ||
      this._cloudSaveTimer ||
      this._retryTimer
    );

    if (!hasOfflinePending && reason !== 'online') return false;

    this._isReconnectingSync = true;
    try {
      if (this._inFlightLoad && this._inFlightLoad.key === uid) {
        await this._inFlightLoad.promise.catch(() => {});
      }

      const currentLocal = (this._hasLoadedOnce && this._loadedUid === uid && Array.isArray(wordList))
        ? [...wordList]
        : await this.getLocalDecks(uid);

      const fetched = await this.fetchRemoteUserDocAndDecks(uid, currentLocal);
      if (this.getCurrentUid() !== uid || !fetched) return false;

      const remoteDecks = fetched.exists ? fetched.remoteDecks : [];
      const remoteTombstones = (fetched.exists && fetched.data)
        ? { deletedDecks: fetched.data.deletedDecks || {}, deletedCards: fetched.data.deletedCards || {} }
        : null;
      const { decks: mergedDecks, needsCloudSync } = await this.mergeRemoteAndLocalDecks(
        remoteDecks,
        currentLocal,
        isLocalDirty,
        uid,
        remoteTombstones
      );

      if (this.getCurrentUid() !== uid) return false;

      const cleanDecks = this.sanitizeDecksForStorage(mergedDecks);
      this.migrateAllCardsFSRS(cleanDecks);
      this.deduplicateSameDeckWords(cleanDecks);

      this.setWordListInPlace(cleanDecks);

      await this.setLocalDecks(cleanDecks, uid);
      this.updateLastKnownDecksSnapshot(cleanDecks);
      this._hasLoadedOnce = true;
      this._loadedUid = uid;
      this._loadedOffline = false;
      this._needsReconnectSync = false;

      if (needsCloudSync || isLocalDirty || isSettingsDirty || !fetched.exists) {
        if (fetched.exists && fetched.data && fetched.data.settings && !isSettingsDirty) {
          this.applyRemoteSettings(fetched.data.settings);
        }
        await this.flushCloudSave();
      } else {
        if (fetched.exists && fetched.data && fetched.data.settings) {
          this.applyRemoteSettings(fetched.data.settings);
        }
        localStorage.removeItem(dirtyKey);
        localStorage.removeItem(settingsDirtyKey);
      }

      if (typeof updateCategorySelects === 'function') updateCategorySelects();
      if (typeof updateUI === 'function') updateUI();
      if (typeof nextCard === 'function' && (typeof currentCard === 'undefined' || !currentCard || !cleanDecks.some(c => c.id === currentCard.id))) {
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

  async commitBatchOpsInChunks(ops, chunkSize = 400) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const slice = ops.slice(i, i + chunkSize);
      const batch = db.batch();
      slice.forEach((op) => {
        if (op.type === 'set') {
          batch.set(op.ref, op.data, op.options || undefined);
        } else if (op.type === 'delete') {
          batch.delete(op.ref);
        }
      });
      await batch.commit();
    }
  },

  async flushCloudSave() {
    if (this._cloudSaveTimer) {
      clearTimeout(this._cloudSaveTimer);
      this._cloudSaveTimer = null;
    }

    if (this._isFlushing) {
      this._hasPendingFlush = true;
      return this._activeFlushPromise || Promise.resolve();
    }

    const uid = this.getCurrentUid();
    if (!uid || typeof db === 'undefined') {
      return;
    }

    const activeBan = typeof window !== 'undefined' && window.userData && window.userData.ban;
    if (activeBan && activeBan.isBanned && (!activeBan.expiresAt || Date.now() < Number(activeBan.expiresAt))) {
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

    const runFlush = async () => {
      this._isFlushing = true;
      try {
        do {
          if (this.getCurrentUid() !== uid) break;
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this._needsReconnectSync = true;
            break;
          }
          this._hasPendingFlush = false;

          const currentSettings = this.getLocalSettings();
          const sanitizedDecks = this.sanitizeDecksForStorage(wordList);
          const compactDecks = this.compactDecksForCloud(sanitizedDecks);
          const currentQuizScore = this.getLocalQuizScore(uid);
          const tombstones = await this.getTombstones(uid);

          const userDocRef = db.collection('users').doc(uid);
          const chunksColRef = userDocRef.collection('deckChunks');

          const { deckManifest, deckChunks, hasOversizedDeck } = this.buildDeckChunksAndManifest(compactDecks);
          const prevSyncState = this.readSyncedManifestState(uid);
          const prevDeckHashes = prevSyncState.deckHashes || {};
          const remoteMode = this._remoteChunkModeByUid[uid] || prevSyncState.chunkMode || '';

          const basePayload = deepSanitizeForFirestore({
            settings: currentSettings,
            quizScore: currentQuizScore,
            deletedDecks: tombstones.deletedDecks,
            deletedCards: tombstones.deletedCards
          });

          if (!hasOversizedDeck) {
            const metaHash = hashStringStableHex(JSON.stringify({
              ...basePayload,
              deckManifest
            }));
            const dirtyDeckChunks = deckChunks.filter(c => prevDeckHashes[c.deckId] !== c.hash);
            const activeDeckIds = new Set(Object.keys(deckManifest));
            const removedDeckIds = Object.keys(prevDeckHashes).filter(id => !activeDeckIds.has(id));
            const needsMigration = remoteMode && remoteMode !== 'manifest_v2';

            if (!needsMigration && metaHash === prevSyncState.metaHash && dirtyDeckChunks.length === 0 && removedDeckIds.length === 0) {
              this._retryCount = 0;
              this._needsReconnectSync = false;
              localStorage.removeItem(this.getScopedKey(this.LOCAL_DIRTY_KEY, uid));
              localStorage.removeItem(this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid));
              continue;
            }

            if (dirtyDeckChunks.length > 0) {
              const writeOps = dirtyDeckChunks.map(chunk => ({
                type: 'set',
                ref: chunksColRef.doc(chunk.deckId),
                data: {
                  deckId: chunk.deckId,
                  hash: chunk.hash,
                  cardCount: chunk.cardCount,
                  decks: chunk.decks,
                  updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }
              }));
              await this.commitBatchOpsInChunks(writeOps, 400);
            }

            if (needsMigration || metaHash !== prevSyncState.metaHash || dirtyDeckChunks.length > 0 || removedDeckIds.length > 0) {
              const mainDocPayload = {
                ...basePayload,
                deckManifest,
                deckChunkCount: -1,
                decks: [],
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              };
              if (firebase?.firestore?.FieldValue?.delete) {
                mainDocPayload.wordList = firebase.firestore.FieldValue.delete();
                mainDocPayload.apiKey = firebase.firestore.FieldValue.delete();
              }
              await userDocRef.set(mainDocPayload, { merge: true });
            }

            if (removedDeckIds.length > 0 || needsMigration) {
              try {
                const deleteOps = removedDeckIds.map(id => ({ type: 'delete', ref: chunksColRef.doc(id) }));
                if (needsMigration) {
                  const existingSnap = await chunksColRef.get();
                  existingSnap.docs.forEach(docSnap => {
                    if (docSnap.id.startsWith('chunk_') || !activeDeckIds.has(docSnap.id)) {
                      if (!deleteOps.some(op => op.ref.id === docSnap.id)) {
                        deleteOps.push({ type: 'delete', ref: docSnap.ref });
                      }
                    }
                  });
                }
                if (deleteOps.length > 0) {
                  await this.commitBatchOpsInChunks(deleteOps, 400);
                }
              } catch (cleanErr) {}
            }

            const nextHashes = {};
            Object.keys(deckManifest).forEach(k => { nextHashes[k] = deckManifest[k].hash; });
            this._remoteChunkModeByUid[uid] = 'manifest_v2';
            this.writeSyncedManifestState(uid, {
              deckHashes: nextHashes,
              metaHash,
              chunkMode: 'manifest_v2'
            });
          } else {
            // 超大單字庫 (>720KB 單一分類) 安全退回依位元組分片寫入
            basePayload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
            if (firebase?.firestore?.FieldValue?.delete) {
              basePayload.wordList = firebase.firestore.FieldValue.delete();
              basePayload.apiKey = firebase.firestore.FieldValue.delete();
            }
            const chunks = this.splitIntoChunks(compactDecks, this.CHUNK_TARGET_BYTES);
            const existingSnap = await chunksColRef.get();
            const writeOps = chunks.map((chunkItems, idx) => ({
              type: 'set',
              ref: chunksColRef.doc(`chunk_${idx}`),
              data: {
                index: idx,
                decks: chunkItems,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              }
            }));
            await this.commitBatchOpsInChunks(writeOps, 400);
            await userDocRef.set({
              ...basePayload,
              decks: [],
              deckChunkCount: chunks.length
            }, { merge: true });

            const deleteOps = [];
            existingSnap.docs.forEach(docSnap => {
              const idx = parseInt(String(docSnap.id).replace('chunk_', ''), 10);
              if (Number.isNaN(idx) || idx >= chunks.length) {
                deleteOps.push({ type: 'delete', ref: docSnap.ref });
              }
            });
            if (deleteOps.length > 0) {
              await this.commitBatchOpsInChunks(deleteOps, 400);
            }
            this._remoteChunkModeByUid[uid] = 'legacy_chunk';
          }

          if (!this._hasPendingFlush) {
            this._retryCount = 0;
            this._needsReconnectSync = false;
            localStorage.removeItem(this.getScopedKey(this.LOCAL_DIRTY_KEY, uid));
            localStorage.removeItem(this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid));
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
        this._activeFlushPromise = null;
      }
    };

    this._activeFlushPromise = runFlush();
    return this._activeFlushPromise;
  },

  async saveData(decks, immediate = false) {
    const uid = this.getCurrentUid();

    // 若雲端首次載入正在進行中，等待載入完成並保留剛發生的刪除差異，避免刪除操作被靜默丟棄
    if (uid && !this._hasLoadedOnce) {
      if (this._inFlightLoad && this._inFlightLoad.key === uid) {
        const defaultCatPre = getStorageDefaultCatName();
        const preSnapshot = Array.isArray(this._lastKnownDecks) ? this._lastKnownDecks : [];
        const incomingArr = Array.isArray(decks) ? decks : [];
        const incomingDetIds = new Set();
        incomingArr.forEach(c => {
          if (!c || typeof c !== 'object') return;
          const cw = normalizeCardWordText(c.word);
          if (cw) {
            incomingDetIds.add(generateDeterministicCardId(normalizeDeckCategoryName(c.category, defaultCatPre), cw));
          } else if (c.id) {
            incomingDetIds.add(c.id);
          }
        });
        const removedIds = new Set();
        preSnapshot.forEach(p => {
          if (!p) return;
          const pw = normalizeCardWordText(p.word);
          const pid = pw ? generateDeterministicCardId(normalizeDeckCategoryName(p.category, defaultCatPre), pw) : p.id;
          if (pid && !incomingDetIds.has(pid)) {
            removedIds.add(pid);
          }
        });
        try {
          await this._inFlightLoad.promise;
        } catch (e) {}
        if (this.getCurrentUid() !== uid || !this._hasLoadedOnce) return;
        if (removedIds.size > 0 && Array.isArray(wordList)) {
          this.setWordListInPlace(wordList.filter(w => {
            if (!w) return false;
            const ww = normalizeCardWordText(w.word);
            const wid = ww ? generateDeterministicCardId(normalizeDeckCategoryName(w.category, defaultCatPre), ww) : w.id;
            return !removedIds.has(wid) && !removedIds.has(w.id);
          }));
        }
        decks = wordList;
      } else {
        console.warn("帳號切換或雲端首次載入尚未完成，略過本次寫入以避免跨帳號污染");
        return;
      }
    }

    if (this._loadedUid !== undefined && this._loadedUid !== uid) {
      console.warn("偵測到帳號已切換，略過舊帳號寫入以避免跨帳號污染");
      return;
    }

    // 立即同步標記本機有未同步變更，避免離線或快速重新整理時遺失狀態
    localStorage.setItem(this.getScopedKey(this.LOCAL_DIRTY_KEY, uid), 'true');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._needsReconnectSync = true;
    }
    this._retryCount = 0;

    const now = Date.now();
    const defaultCatName = getStorageDefaultCatName();
    if (Array.isArray(decks)) {
      this.deduplicateSameDeckWords(decks);
    }
    const sanitizedDecks = this.sanitizeDecksForStorage(decks);

    const prevSnapshot = Array.isArray(this._lastKnownDecks)
      ? [...this._lastKnownDecks]
      : null;

    const prevLocalDecksSync = prevSnapshot || [];
    const prevByDeckSync = new Map();
    const prevDetIdsSync = new Set();
    prevLocalDecksSync.forEach(prevCard => {
      if (!prevCard || typeof prevCard !== 'object') return;
      const pCat = normalizeDeckCategoryName(prevCard.category, defaultCatName);
      const pWord = normalizeCardWordText(prevCard.word);
      const pDeckId = prevCard.deckId || generateDeterministicDeckId(pCat);
      const pDetId = pWord ? generateDeterministicCardId(pCat, pWord) : (prevCard.id || '');
      if (pDetId) prevDetIdsSync.add(pDetId);
      if (prevCard.id) prevDetIdsSync.add(prevCard.id);
      if (!prevByDeckSync.has(pDeckId)) prevByDeckSync.set(pDeckId, []);
      prevByDeckSync.get(pDeckId).push({ detId: pDetId, rawId: prevCard.id || '' });
    });

    if (this._tombstonesCache && this._tombstonesCacheUid === (uid || 'guest')) {
      sanitizedDecks.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (!prevDetIdsSync.has(c.id)) {
          const cardTs = (this._tombstonesCache.deletedCards && this._tombstonesCache.deletedCards[c.id]) || 0;
          const deckTs = (this._tombstonesCache.deletedDecks && this._tombstonesCache.deletedDecks[c.deckId]) || 0;
          const blockingTs = Math.max(cardTs, deckTs);
          if (blockingTs > 0) {
            c.updatedAt = Math.max(toFiniteNumber(c.updatedAt, 0), blockingTs + 1, now);
          }
        }
      });
    }

    this.setWordListInPlace(sanitizedDecks);
    this.updateLastKnownDecksSnapshot(sanitizedDecks);

    const runPersistTask = async () => {
      const tombstones = await this.getTombstones(uid);
      const prevLocalDecks = prevSnapshot !== null
        ? prevSnapshot
        : await this.getLocalDecks(uid);

      const prevByDeck = new Map();
      const prevDetIds = new Set();
      if (Array.isArray(prevLocalDecks)) {
        prevLocalDecks.forEach(prevCard => {
          if (!prevCard || typeof prevCard !== 'object') return;
          const pCat = normalizeDeckCategoryName(prevCard.category, defaultCatName);
          const pWord = normalizeCardWordText(prevCard.word);
          const pDeckId = prevCard.deckId || generateDeterministicDeckId(pCat);
          const pDetId = pWord ? generateDeterministicCardId(pCat, pWord) : (prevCard.id || '');
          if (pDetId) prevDetIds.add(pDetId);
          if (prevCard.id) prevDetIds.add(prevCard.id);
          if (!prevByDeck.has(pDeckId)) prevByDeck.set(pDeckId, []);
          prevByDeck.get(pDeckId).push({ detId: pDetId, rawId: prevCard.id || '' });
        });
      }

      const nextByDeck = new Map();
      let bumpedTimestamp = false;
      sanitizedDecks.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (!nextByDeck.has(c.deckId)) nextByDeck.set(c.deckId, new Set());
        nextByDeck.get(c.deckId).add(c.id);

        if (!prevDetIds.has(c.id)) {
          const cardTs = tombstones.deletedCards[c.id] || 0;
          const deckTs = tombstones.deletedDecks[c.deckId] || 0;
          const blockingTs = Math.max(cardTs, deckTs);
          if (blockingTs > 0) {
            const bumped = Math.max(toFiniteNumber(c.updatedAt, 0), blockingTs + 1, now);
            if (c.updatedAt !== bumped) {
              c.updatedAt = bumped;
              bumpedTimestamp = true;
            }
            if (cardTs > 0) {
              delete tombstones.deletedCards[c.id];
            }
          }
        }
      });

      if (bumpedTimestamp && Array.isArray(wordList)) {
        const bumpedById = new Map(sanitizedDecks.map(c => [c.id, c.updatedAt]));
        wordList.forEach(w => {
          if (w && bumpedById.has(w.id)) {
            w.updatedAt = Math.max(toFiniteNumber(w.updatedAt, 0), bumpedById.get(w.id));
          }
        });
      }

      await this.setLocalDecks(sanitizedDecks, uid);

      let hasNewDeletion = false;
      prevByDeck.forEach((prevCardsInDeck, deckId) => {
        const remainingInDeck = nextByDeck.get(deckId);
        if (!remainingInDeck || remainingInDeck.size === 0) {
          hasNewDeletion = true;
          tombstones.deletedDecks[deckId] = Math.max(tombstones.deletedDecks[deckId] || 0, now);
          prevCardsInDeck.forEach(({ detId, rawId }) => {
            if (detId) delete tombstones.deletedCards[detId];
            if (rawId) delete tombstones.deletedCards[rawId];
          });
        } else {
          prevCardsInDeck.forEach(({ detId, rawId }) => {
            const stillExists = (detId && remainingInDeck.has(detId)) || (rawId && remainingInDeck.has(rawId));
            if (!stillExists) {
              hasNewDeletion = true;
              if (detId) tombstones.deletedCards[detId] = Math.max(tombstones.deletedCards[detId] || 0, now);
              if (rawId && rawId !== detId) tombstones.deletedCards[rawId] = Math.max(tombstones.deletedCards[rawId] || 0, now);
            }
          });
        }
      });

      await this.saveTombstones(tombstones, uid);
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
  },
  sendKeepaliveSyncBeacon(reason = 'pagehide') {
    try {
      const uid = this.getCurrentUid();
      if (!uid || !this._hasLoadedOnce || this._loadedUid !== uid) return false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      const dirtyKey = this.getScopedKey(this.LOCAL_DIRTY_KEY, uid);
      const settingsDirtyKey = this.getScopedKey(this.LOCAL_SETTINGS_DIRTY_KEY, uid);
      const hasDirty = Boolean(
        this._cloudSaveTimer ||
        localStorage.getItem(dirtyKey) === 'true' ||
        localStorage.getItem(settingsDirtyKey) === 'true'
      );
      if (!hasDirty) return false;

      const token = (this._cachedIdTokenUid === uid && this._cachedIdToken) ? this._cachedIdToken : '';
      if (!token || typeof fetch !== 'function') return false;

      const currentSettings = this.getLocalSettings();
      const sanitizedDecks = this.sanitizeDecksForStorage(typeof wordList !== 'undefined' ? wordList : []);
      const compactDecks = this.compactDecksForCloud(sanitizedDecks);
      const currentQuizScore = this.getLocalQuizScore(uid);
      const tombstones = (this._tombstonesCache && this._tombstonesCacheUid === uid)
        ? this._tombstonesCache
        : { deletedDecks: {}, deletedCards: {} };

      const { deckManifest, deckChunks, hasOversizedDeck } = this.buildDeckChunksAndManifest(compactDecks);
      if (hasOversizedDeck) return false;

      const prevSyncState = this.readSyncedManifestState(uid);
      const prevDeckHashes = prevSyncState.deckHashes || {};
      const dirtyDeckChunks = deckChunks.filter(c => prevDeckHashes[c.deckId] !== c.hash);
      const activeDeckIds = new Set(Object.keys(deckManifest));
      const deletedChunkIds = Object.keys(prevDeckHashes).filter(id => !activeDeckIds.has(id));

      const baseMeta = deepSanitizeForFirestore({
        settings: currentSettings,
        quizScore: currentQuizScore,
        deletedDecks: tombstones.deletedDecks || {},
        deletedCards: tombstones.deletedCards || {},
        deckManifest
      });

      const sendOneBeacon = (payload) => {
        try {
          fetch(this.SYNC_BEACON_URL, {
            method: 'POST',
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
          }).catch(() => {});
        } catch (e) {}
      };

      const fullPayload = { dirtyChunks: dirtyDeckChunks, deletedChunkIds, meta: baseMeta, reason };
      const fullJson = JSON.stringify(fullPayload);

      // 瀏覽器 keepalive 單次限制為 64KB，超過時拆分逐字庫發送確保必達
      if (fullJson.length <= 56000) {
        sendOneBeacon(fullPayload);
      } else {
        dirtyDeckChunks.forEach(chunk => {
          const singleChunkJson = JSON.stringify({ dirtyChunks: [chunk], reason });
          if (singleChunkJson.length <= 58000) {
            sendOneBeacon({ dirtyChunks: [chunk], reason });
          }
        });
        sendOneBeacon({ dirtyChunks: [], deletedChunkIds, meta: baseMeta, reason });
      }
      return true;
    } catch (e) {
      return false;
    }
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const dirtyKey = StorageEngine.getScopedKey(StorageEngine.LOCAL_DIRTY_KEY);
    const settingsDirtyKey = StorageEngine.getScopedKey(StorageEngine.LOCAL_SETTINGS_DIRTY_KEY);
    if (document.visibilityState === 'hidden') {
      if (StorageEngine._cloudSaveTimer || localStorage.getItem(dirtyKey) === 'true' || localStorage.getItem(settingsDirtyKey) === 'true') {
        StorageEngine.sendKeepaliveSyncBeacon('visibility_hidden');
        StorageEngine.flushCloudSave();
      }
    } else if (document.visibilityState === 'visible') {
      StorageEngine.refreshCachedIdToken();
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
    const settingsDirtyKey = StorageEngine.getScopedKey(StorageEngine.LOCAL_SETTINGS_DIRTY_KEY);
    if (StorageEngine._cloudSaveTimer || localStorage.getItem(dirtyKey) === 'true' || localStorage.getItem(settingsDirtyKey) === 'true') {
      StorageEngine.sendKeepaliveSyncBeacon('pagehide');
      StorageEngine.flushCloudSave();
    }
  });

  try {
    const capApp = window.Capacitor?.Plugins?.App;
    if (capApp && typeof capApp.addListener === 'function') {
      capApp.addListener('appStateChange', (state) => {
        if (state && state.isActive === false) {
          StorageEngine.sendKeepaliveSyncBeacon('capacitor_background');
          StorageEngine.flushCloudSave();
        } else if (state && state.isActive === true) {
          StorageEngine.refreshCachedIdToken();
          StorageEngine.syncOnReconnect('capacitor_resume');
        }
      });
    }
  } catch (e) {}

  window.addEventListener('offline', () => {
    StorageEngine._needsReconnectSync = true;
    if (StorageEngine._reconnectTimer) {
      clearTimeout(StorageEngine._reconnectTimer);
      StorageEngine._reconnectTimer = null;
    }
    if (typeof updateOfflineBannerUI === 'function') {
      updateOfflineBannerUI();
    }
  });

  window.addEventListener('online', () => {
    if (typeof updateOfflineBannerUI === 'function') {
      updateOfflineBannerUI();
    }
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
