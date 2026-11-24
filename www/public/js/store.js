/**
 * LZHCard - 社群字庫商店系統模組 (store.js - 計數防護 / 跨月熱度重置 / 多維度排行榜)
 */

window.storeDecks = [];
window.currentStoreSortMode = localStorage.getItem('lzhcard_store_sort') || 'hot_monthly';

/**
 * 🛡️ HTML 跳脫防 XSS 攻擊
 */
function escapeStoreHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeStoreUrl(rawUrl, fallbackUrl = '') {
    if (typeof window !== 'undefined' && typeof window.sanitizeSafeUrl === 'function') {
        return window.sanitizeSafeUrl(rawUrl, fallbackUrl);
    }
    const val = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!val) return fallbackUrl;
    if (/^https?:\/\//i.test(val)) return val;
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(val)) return val;
    return fallbackUrl;
}

/**
 * 🏅 計算商店作者聲望與成就徽章 (downloads * 5 + views)
 */
function getStoreAuthorStats(authorId, authorName = '') {
    const decks = Array.isArray(window.storeDecks) ? window.storeDecks : [];
    const cleanUid = (authorId || '').trim();
    const cleanName = (authorName || '').trim().toLowerCase();

    const matched = decks.filter(d => {
        if (!d) return false;
        if (cleanUid && d.authorId === cleanUid) return true;
        if (!cleanUid && cleanName && String(d.author || '').trim().toLowerCase() === cleanName) return true;
        return false;
    });

    const totalDownloads = matched.reduce((s, d) => s + Math.max(0, Number(d.downloads ?? d.downloadCount) || 0), 0);
    const totalViews = matched.reduce((s, d) => s + Math.max(0, Number(d.views) || 0), 0);
    const reputation = totalDownloads * 5 + totalViews;

    return {
        deckCount: matched.length,
        totalDownloads,
        totalViews,
        reputation
    };
}

function getAuthorReputationBadge(reputation, deckCount = 0) {
    const rep = Math.max(0, Number(reputation) || 0);
    const count = Math.max(0, Number(deckCount) || 0);
    if (rep >= 500) {
        return {
            tier: 'gold',
            icon: '👑',
            label: '金牌大師',
            badgeClass: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-700'
        };
    }
    if (rep >= 150) {
        return {
            tier: 'silver',
            icon: '🏅',
            label: '銀牌導師',
            badgeClass: 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-500'
        };
    }
    if (rep >= 30 || count >= 2) {
        return {
            tier: 'rising',
            icon: '🌟',
            label: '新星作者',
            badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
        };
    }
    return null;
}

let storeSearchDebounceTimer = null;
function debouncedRenderStore(delayMs = 180) {
    if (storeSearchDebounceTimer) clearTimeout(storeSearchDebounceTimer);
    storeSearchDebounceTimer = setTimeout(() => {
        storeSearchDebounceTimer = null;
        renderStore({ skipFetch: true });
    }, Math.max(0, Number(delayMs) || 180));
}

/**
 * 🌐 i18n 安全轉接函式（支援 {key} 動態參數替換）
 */
function storeTr(key, fallback, params = null) {
    let text = fallback;
    if (typeof t === 'function') {
        const translated = t(key);
        if (translated && translated !== key) {
            text = translated;
        }
    }
    if (params && typeof text === 'string') {
        Object.keys(params).forEach(k => {
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
        });
    }
    return text;
}

/**
 * 📅 取得目前系統月份鍵值 (YYYY-MM)
 */
function getCurrentMonthKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * ⏱️ 安全取得字庫建立時間毫秒數
 */
function getStoreDeckTimestampMs(deck) {
    if (!deck || !deck.createdAt) return 0;
    if (typeof deck.createdAt.toMillis === 'function') return deck.createdAt.toMillis();
    if (typeof deck.createdAt.seconds === 'number') return deck.createdAt.seconds * 1000;
    if (typeof deck.createdAt === 'number') return deck.createdAt;
    const parsed = Date.parse(deck.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 📊 標準化字庫統計數值（含跨月自動歸零與本月熱度計算）
 * 熱度公式：monthlyDownloads * 3 + monthlyViews * 1
 */
function normalizeStoreDeckMetrics(deck, monthKey = getCurrentMonthKey()) {
    const views = Math.max(0, Number(deck?.views) || 0);
    const downloads = Math.max(0, Number(deck?.downloads ?? deck?.downloadCount) || 0);
    const likesCount = Math.max(0, Number(deck?.likesCount) || 0);
    const favoritesCount = Math.max(0, Number(deck?.favoritesCount) || 0);
    const isSameMonth = deck?.monthKey === monthKey;
    const monthlyViews = isSameMonth ? Math.max(0, Number(deck?.monthlyViews) || 0) : 0;
    const monthlyDownloads = isSameMonth ? Math.max(0, Number(deck?.monthlyDownloads) || 0) : 0;
    const hotScore = monthlyDownloads * 3 + monthlyViews * 1;

    return {
        views,
        downloads,
        likesCount,
        favoritesCount,
        monthlyViews,
        monthlyDownloads,
        hotScore,
        monthKey,
        isMonthReset: !isSameMonth
    };
}

// 避免覆蓋 chat.js 中較完整的全域 isGuestUser()
if (typeof window.isGuestUser !== 'function') {
    window.isGuestUser = function () {
        const isGuestMode = localStorage.getItem('lzhcard_guest_mode') === 'true';
        const isFirebaseUser = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
        return isGuestMode || !isFirebaseUser;
    };
}

function getStoreCurrentUser() {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser;
    }
    if (typeof auth !== 'undefined' && auth.currentUser) {
        return auth.currentUser;
    }
    return null;
}

/**
 * 🏆 切換商城排序與排行榜維度
 */
function setStoreSortMode(mode) {
    const allowed = ['hot_monthly', 'downloads_desc', 'views_desc', 'likes_desc', 'favorites_desc', 'newest'];
    const targetMode = allowed.includes(mode) ? mode : 'hot_monthly';
    window.currentStoreSortMode = targetMode;
    localStorage.setItem('lzhcard_store_sort', targetMode);
    updateStoreSortBarUI();
    renderStore({ skipFetch: true });
}

function updateStoreSortBarUI() {
    const currentMode = window.currentStoreSortMode || 'hot_monthly';
    const buttons = document.querySelectorAll('#storeSortBar .store-sort-btn');
    buttons.forEach(btn => {
        const btnSort = btn.getAttribute('data-sort');
        const isActive = btnSort === currentMode;
        if (isActive) {
            btn.className = 'store-sort-btn px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-amber-500 text-white shadow-2xs cursor-pointer';
        } else {
            btn.className = 'store-sort-btn px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 cursor-pointer';
        }
    });

    const monthBadge = document.getElementById('storeCurrentMonthBadge');
    if (monthBadge) {
        const monthKey = getCurrentMonthKey();
        monthBadge.innerText = storeTr('storeMonthBadge', '📅 {month} 本月榜單', { month: monthKey });
    }
}

/**
 * 🔢 依據選擇的維度對字庫陣列排序
 */
function sortStoreDecks(decks, sortMode = window.currentStoreSortMode || 'hot_monthly', monthKey = getCurrentMonthKey()) {
    const list = Array.isArray(decks) ? [...decks] : [];
    list.sort((a, b) => {
        const ma = normalizeStoreDeckMetrics(a, monthKey);
        const mb = normalizeStoreDeckMetrics(b, monthKey);
        const ta = getStoreDeckTimestampMs(a);
        const tb = getStoreDeckTimestampMs(b);

        if (sortMode === 'downloads_desc') {
            if (mb.downloads !== ma.downloads) return mb.downloads - ma.downloads;
            if (mb.views !== ma.views) return mb.views - ma.views;
            return tb - ta;
        }
        if (sortMode === 'views_desc') {
            if (mb.views !== ma.views) return mb.views - ma.views;
            if (mb.downloads !== ma.downloads) return mb.downloads - ma.downloads;
            return tb - ta;
        }
        if (sortMode === 'likes_desc') {
            if (mb.likesCount !== ma.likesCount) return mb.likesCount - ma.likesCount;
            if (mb.favoritesCount !== ma.favoritesCount) return mb.favoritesCount - ma.favoritesCount;
            if (mb.downloads !== ma.downloads) return mb.downloads - ma.downloads;
            return tb - ta;
        }
        if (sortMode === 'favorites_desc') {
            if (mb.favoritesCount !== ma.favoritesCount) return mb.favoritesCount - ma.favoritesCount;
            if (mb.likesCount !== ma.likesCount) return mb.likesCount - ma.likesCount;
            if (mb.downloads !== ma.downloads) return mb.downloads - ma.downloads;
            return tb - ta;
        }
        if (sortMode === 'newest') {
            if (tb !== ta) return tb - ta;
            return mb.hotScore - ma.hotScore;
        }
        // 預設：本月熱度排行 (hot_monthly)
        if (mb.hotScore !== ma.hotScore) return mb.hotScore - ma.hotScore;
        if (mb.monthlyDownloads !== ma.monthlyDownloads) return mb.monthlyDownloads - ma.monthlyDownloads;
        if (mb.downloads !== ma.downloads) return mb.downloads - ma.downloads;
        if (mb.views !== ma.views) return mb.views - ma.views;
        return tb - ta;
    });
    return list;
}

/**
 * 👁️ 記錄字庫觀看次數（sessionStorage 同工作階段去重 + 跨月重置 + Firestore 原子遞增）
 */
async function recordStoreDeckView(deckId) {
    if (!deckId) return false;
    const monthKey = getCurrentMonthKey();
    const currentUser = getStoreCurrentUser();
    const uid = currentUser ? currentUser.uid : 'guest';
    const sessionKey = `lzhcard_store_viewed_${monthKey}_${uid}`;

    let viewedIds = [];
    try {
        const raw = sessionStorage.getItem(sessionKey);
        viewedIds = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(viewedIds)) viewedIds = [];
    } catch (e) {
        viewedIds = [];
    }

    if (viewedIds.includes(deckId)) {
        return false; // 本工作階段已計數過，略過防刷
    }

    viewedIds.push(deckId);
    try {
        sessionStorage.setItem(sessionKey, JSON.stringify(viewedIds));
    } catch (e) {}

    // 即時更新本地快取，確保預覽與列表數字立刻反映
    const localDeck = window.storeDecks.find(d => d.id === deckId);
    if (localDeck) {
        const m = normalizeStoreDeckMetrics(localDeck, monthKey);
        localDeck.views = m.views + 1;
        localDeck.monthlyViews = m.monthlyViews + 1;
        localDeck.monthlyDownloads = m.monthlyDownloads;
        localDeck.monthKey = monthKey;
    }

    // 更新預覽彈窗數據標籤
    renderPreviewStatsBadge(localDeck, monthKey);
    renderStore({ skipFetch: true });

    // 未登入訪客不觸發受規則保護的雲端寫入，避免 console 報 permission-denied
    if (!currentUser || typeof db === 'undefined' || typeof firebase === 'undefined') {
        return true;
    }

    try {
        const deckRef = db.collection('storeDecks').doc(deckId);
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(deckRef);
            if (!snap.exists) return;
            const data = snap.data() || {};
            if (data.monthKey === monthKey) {
                tx.update(deckRef, {
                    views: firebase.firestore.FieldValue.increment(1),
                    monthlyViews: firebase.firestore.FieldValue.increment(1)
                });
            } else {
                // 跨月自動歸零本月數據並更新 monthKey
                tx.update(deckRef, {
                    views: firebase.firestore.FieldValue.increment(1),
                    monthlyViews: 1,
                    monthlyDownloads: 0,
                    monthKey: monthKey
                });
            }
        });
        return true;
    } catch (err) {
        console.warn("記錄字庫觀看次數失敗：", err);
        return false;
    }
}

/**
 * ⬇️ 記錄字庫下載次數（依 uid 嚴格去重 + 跨月自動重置 + Firestore Transaction 原子遞增）
 */
async function recordStoreDeckDownload(deckId) {
    if (!deckId) return false;
    const currentUser = getStoreCurrentUser();
    const uid = currentUser ? currentUser.uid : '';
    if (!uid) return false;

    const monthKey = getCurrentMonthKey();
    const localDlKey = `lzhcard_store_dl_${uid}`;
    let localDlSet = new Set();
    try {
        const raw = localStorage.getItem(localDlKey);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) localDlSet = new Set(arr);
    } catch (e) {}

    if (localDlSet.has(deckId)) {
        return false; // 該 uid 本機已知下載過，不再重複計次
    }

    if (typeof db === 'undefined' || typeof firebase === 'undefined') {
        return false;
    }

    try {
        const deckRef = db.collection('storeDecks').doc(deckId);
        const downloaderRef = deckRef.collection('downloaders').doc(uid);

        const didIncrement = await db.runTransaction(async (tx) => {
            const downloaderSnap = await tx.get(downloaderRef);
            if (downloaderSnap.exists) {
                return false; // 雲端已記錄此 uid 下載過，防止跨裝置灌水
            }
            const deckSnap = await tx.get(deckRef);
            if (!deckSnap.exists) return false;

            const data = deckSnap.data() || {};
            tx.set(downloaderRef, {
                uid: uid,
                monthKey: monthKey,
                downloadedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            if (data.monthKey === monthKey) {
                tx.update(deckRef, {
                    downloads: firebase.firestore.FieldValue.increment(1),
                    downloadCount: firebase.firestore.FieldValue.increment(1),
                    monthlyDownloads: firebase.firestore.FieldValue.increment(1)
                });
            } else {
                // 跨月自動歸零本月計數並設定為本月第 1 次下載
                tx.update(deckRef, {
                    downloads: firebase.firestore.FieldValue.increment(1),
                    downloadCount: firebase.firestore.FieldValue.increment(1),
                    monthlyDownloads: 1,
                    monthlyViews: 0,
                    monthKey: monthKey
                });
            }
            return true;
        });

        localDlSet.add(deckId);
        try {
            localStorage.setItem(localDlKey, JSON.stringify(Array.from(localDlSet)));
        } catch (e) {}

        if (didIncrement) {
            const localDeck = window.storeDecks.find(d => d.id === deckId);
            if (localDeck) {
                const m = normalizeStoreDeckMetrics(localDeck, monthKey);
                localDeck.downloads = m.downloads + 1;
                localDeck.downloadCount = localDeck.downloads;
                localDeck.monthlyDownloads = m.monthlyDownloads + 1;
                localDeck.monthlyViews = m.monthlyViews;
                localDeck.monthKey = monthKey;
            }
            renderStore({ skipFetch: true });
        }

        return didIncrement;
    } catch (err) {
        console.warn("記錄字庫下載次數失敗：", err);
        return false;
    }
}

const STORE_REACTION_LOCKS = new Set();
let _currentPreviewDeckId = null;

function getStoreReactionStorageKey(kind, uid) {
    const prefix = kind === 'favorite' ? 'lzhcard_store_favs' : 'lzhcard_store_likes';
    return `${prefix}_${uid || 'guest'}`;
}

function getStoreReactionSet(kind, uid = null) {
    const resolvedUid = uid || (getStoreCurrentUser()?.uid || '');
    if (!resolvedUid) return new Set();
    try {
        const raw = localStorage.getItem(getStoreReactionStorageKey(kind, resolvedUid));
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch (e) {
        return new Set();
    }
}

function saveStoreReactionSet(kind, setObj, uid = null) {
    const resolvedUid = uid || (getStoreCurrentUser()?.uid || '');
    if (!resolvedUid) return;
    try {
        localStorage.setItem(
            getStoreReactionStorageKey(kind, resolvedUid),
            JSON.stringify(Array.from(setObj instanceof Set ? setObj : []))
        );
    } catch (e) {}
}

function isStoreDeckLiked(deckId, uid = null) {
    return Boolean(deckId && getStoreReactionSet('like', uid).has(deckId));
}

function isStoreDeckFavorited(deckId, uid = null) {
    return Boolean(deckId && getStoreReactionSet('favorite', uid).has(deckId));
}

async function syncUserStoreReactions(decks = window.storeDecks) {
    const currentUser = getStoreCurrentUser();
    if (!currentUser || !currentUser.uid || typeof db === 'undefined' || !Array.isArray(decks) || decks.length === 0) {
        return false;
    }
    const uid = currentUser.uid;
    const likedSet = getStoreReactionSet('like', uid);
    const favSet = getStoreReactionSet('favorite', uid);
    let changed = false;

    await Promise.allSettled(decks.map(async (deck) => {
        if (!deck || !deck.id) return;
        try {
            const deckRef = db.collection('storeDecks').doc(deck.id);
            const [likeSnap, favSnap] = await Promise.all([
                deckRef.collection('likers').doc(uid).get(),
                deckRef.collection('favoriters').doc(uid).get()
            ]);
            if (likeSnap.exists && !likedSet.has(deck.id)) {
                likedSet.add(deck.id);
                changed = true;
            } else if (!likeSnap.exists && likedSet.has(deck.id)) {
                likedSet.delete(deck.id);
                changed = true;
            }
            if (favSnap.exists && !favSet.has(deck.id)) {
                favSet.add(deck.id);
                changed = true;
            } else if (!favSnap.exists && favSet.has(deck.id)) {
                favSet.delete(deck.id);
                changed = true;
            }
        } catch (e) {}
    }));

    if (changed) {
        saveStoreReactionSet('like', likedSet, uid);
        saveStoreReactionSet('favorite', favSet, uid);
        renderStore({ skipFetch: true });
        if (_currentPreviewDeckId) {
            const previewDeck = window.storeDecks.find(d => d.id === _currentPreviewDeckId);
            if (previewDeck) renderPreviewInteractionActions(previewDeck);
        }
    }
    return changed;
}

async function toggleStoreDeckReaction(deckId, kind) {
    if (!deckId) return false;
    const currentUser = getStoreCurrentUser();
    const uid = currentUser ? currentUser.uid : '';
    if (isGuestUser() || !uid) {
        if (typeof showToast === 'function') {
            showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城互動功能！'), 'warning');
        }
        return false;
    }

    const lockKey = `${kind}:${deckId}`;
    if (STORE_REACTION_LOCKS.has(lockKey)) return false;
    if (typeof db === 'undefined') return false;

    STORE_REACTION_LOCKS.add(lockKey);
    const subCol = kind === 'favorite' ? 'favoriters' : 'likers';
    const countField = kind === 'favorite' ? 'favoritesCount' : 'likesCount';

    try {
        const deckRef = db.collection('storeDecks').doc(deckId);
        const reactionRef = deckRef.collection(subCol).doc(uid);

        const result = await db.runTransaction(async (tx) => {
            const [reactionSnap, deckSnap] = await Promise.all([
                tx.get(reactionRef),
                tx.get(deckRef)
            ]);
            if (!deckSnap.exists) return null;

            const deckData = deckSnap.data() || {};
            const currentCount = Math.max(0, Number(deckData[countField]) || 0);
            const willActivate = !reactionSnap.exists;
            const nextCount = willActivate ? currentCount + 1 : Math.max(0, currentCount - 1);

            if (willActivate) {
                tx.set(reactionRef, {
                    uid: uid,
                    createdAt: typeof firebase !== 'undefined' && firebase.firestore?.FieldValue
                        ? firebase.firestore.FieldValue.serverTimestamp()
                        : Date.now()
                });
            } else {
                tx.delete(reactionRef);
            }

            tx.update(deckRef, { [countField]: nextCount });
            return { active: willActivate, count: nextCount };
        });

        if (!result) return false;

        const reactionSet = getStoreReactionSet(kind, uid);
        if (result.active) reactionSet.add(deckId);
        else reactionSet.delete(deckId);
        saveStoreReactionSet(kind, reactionSet, uid);

        const localDeck = window.storeDecks.find(d => d.id === deckId);
        if (localDeck) {
            localDeck[countField] = result.count;
        }

        renderStore({ skipFetch: true });
        if (_currentPreviewDeckId === deckId && localDeck) {
            renderPreviewStatsBadge(localDeck);
            renderPreviewInteractionActions(localDeck);
        }

        if (typeof showToast === 'function') {
            if (kind === 'favorite') {
                showToast(result.active ? '⭐ 已收藏此字庫！' : '已取消收藏', 'info');
            } else {
                showToast(result.active ? '❤️ 已按讚支持作者！' : '已取消讚', 'info');
            }
        }
        return true;
    } catch (err) {
        console.warn(`切換字庫${kind === 'favorite' ? '收藏' : '按讚'}失敗：`, err);
        if (typeof showToast === 'function') {
            showToast('操作失敗，請稍後再試：' + (err.message || ''), 'error');
        }
        return false;
    } finally {
        STORE_REACTION_LOCKS.delete(lockKey);
    }
}

function toggleStoreDeckLike(deckId) {
    return toggleStoreDeckReaction(deckId, 'like');
}

function toggleStoreDeckFavorite(deckId) {
    return toggleStoreDeckReaction(deckId, 'favorite');
}

function renderPreviewInteractionActions(deck) {
    const actionsEl = document.getElementById('previewInteractionActions');
    if (!actionsEl || !deck) return;
    const m = normalizeStoreDeckMetrics(deck);
    const liked = isStoreDeckLiked(deck.id);
    const favorited = isStoreDeckFavorited(deck.id);
    const safeId = escapeStoreHTML(deck.id);

    actionsEl.innerHTML = `
        <button type="button" onclick="toggleStoreDeckLike('${safeId}')" class="px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 cursor-pointer ${liked
            ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border-rose-300 dark:border-rose-700'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:bg-rose-50 dark:hover:bg-rose-950/30'}">
            <i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
            <span>${m.likesCount}</span>
        </button>
        <button type="button" onclick="toggleStoreDeckFavorite('${safeId}')" class="px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 cursor-pointer ${favorited
            ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-300 border-amber-300 dark:border-amber-700'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:bg-amber-50 dark:hover:bg-amber-950/30'}">
            <i class="${favorited ? 'fa-solid' : 'fa-regular'} fa-star"></i>
            <span>${m.favoritesCount}</span>
        </button>
    `;
}

function renderPreviewStatsBadge(deck, monthKey = getCurrentMonthKey()) {
    const statsEl = document.getElementById('previewStatsBadge');
    if (!statsEl || !deck) return;
    const m = normalizeStoreDeckMetrics(deck, monthKey);
    statsEl.innerHTML = `
        <span class="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <i class="fa-solid fa-fire mr-1"></i>${storeTr('storeHotLabel', '本月熱度')} ${m.hotScore}
        </span>
        <span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
            <i class="fa-solid fa-eye mr-1"></i>${m.views} (${storeTr('storeMonthlyShort', '本月')} ${m.monthlyViews})
        </span>
        <span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
            <i class="fa-solid fa-download mr-1"></i>${m.downloads} (${storeTr('storeMonthlyShort', '本月')} ${m.monthlyDownloads})
        </span>
        <span class="px-2 py-0.5 rounded-md bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
            <i class="fa-solid fa-heart mr-1"></i>${m.likesCount}
        </span>
        <span class="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <i class="fa-solid fa-star mr-1"></i>${m.favoritesCount}
        </span>
    `;
}

async function renderStore(options = {}) {
    const container = document.getElementById('storeContainer');
    if (!container) return;

    updateStoreSortBarUI();

    const skipFetch = options && options.skipFetch === true;
    const query = (document.getElementById('storeSearchInput')?.value || '').trim().toLowerCase();
    const currentUser = getStoreCurrentUser();
    const currentUid = currentUser ? currentUser.uid : '';
    const isAdmin = window.userData ? window.userData.role === 'admin' : false;
    const monthKey = getCurrentMonthKey();

    if (!skipFetch || !Array.isArray(window.storeDecks) || window.storeDecks.length === 0) {
        try {
            if (typeof db !== 'undefined') {
                const snapshot = await db.collection('storeDecks').orderBy('createdAt', 'desc').get();
                window.storeDecks = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                syncUserStoreReactions(window.storeDecks);
            }
        } catch (err) {
            console.warn("無法從雲端拉取商店資料，嘗試讀取快取：", err);
        }
    }

    const filtered = window.storeDecks.filter(deck =>
        (deck.title || '').toLowerCase().includes(query) ||
        (deck.desc || '').toLowerCase().includes(query) ||
        (deck.category || '').toLowerCase().includes(query) ||
        (deck.author || '').toLowerCase().includes(query)
    );

    const sortMode = window.currentStoreSortMode || 'hot_monthly';
    const sorted = sortStoreDecks(filtered, sortMode, monthKey);

    if (sorted.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10 text-xs">${escapeStoreHTML(storeTr('storeEmptyResult', '未找到符合的字庫作品'))}</div>`;
        return;
    }

    const anonymousText = storeTr('storeAnonymous', '匿名');
    const generalCatText = storeTr('storeGeneralCategory', '通用');
    const noDescText = storeTr('storeNoDesc', '無簡介');
    const previewTip = storeTr('storeTipPreview', '預覽字庫內容');
    const shareTip = storeTr('storeTipShare', '複製分享連結');
    const adminUnpublishTip = storeTr('storeTipAdminDelete', '管理員強制下架');
    const selfUnpublishTip = storeTr('storeTipSelfDelete', '下架自己的字庫');
    const hotLabel = storeTr('storeHotLabel', '本月熱度');
    const monthlyShort = storeTr('storeMonthlyShort', '本月');

    container.innerHTML = sorted.map((deck, index) => {
        const isAuthor = currentUid && deck.authorId === currentUid;
        const canDelete = (isAuthor || isAdmin) && !isGuestUser();
        const wordCount = Array.isArray(deck.words) ? deck.words.length : 0;
        const authorName = deck.author || anonymousText;
        const safeAuthorName = escapeStoreHTML(authorName);
        const safeTitle = escapeStoreHTML(deck.title);
        const safeDesc = escapeStoreHTML(deck.desc || noDescText);
        const safeCategory = escapeStoreHTML(deck.category || generalCatText);
        const safeId = escapeStoreHTML(deck.id);
        const safeAuthorId = escapeStoreHTML(deck.authorId || '');

        const metrics = normalizeStoreDeckMetrics(deck, monthKey);
        const actionBtnText = deck.price > 0
            ? storeTr('storePriceCoins', '{price} 金幣', { price: deck.price })
            : storeTr('storeGetCount', '取得 ({count})', { count: wordCount });

        let rankBadgeHtml = '';
        if (sortMode !== 'newest' && index < 3) {
            const rankStyles = [
                'bg-amber-500 text-white border-amber-600',
                'bg-slate-400 text-white border-slate-500',
                'bg-orange-600 text-white border-orange-700'
            ];
            const rankIcons = ['🥇', '🥈', '🥉'];
            rankBadgeHtml = `<span class="px-2 py-0.5 text-[10px] font-black rounded-full border shadow-2xs ${rankStyles[index]}">${rankIcons[index]} Top ${index + 1}</span>`;
        }

        const fallbackAvatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authorName)}`;
        const safeAvatarUrl = escapeStoreHTML(
            sanitizeStoreUrl(deck.authorAvatar || fallbackAvatarUrl, fallbackAvatarUrl)
        );
        const liveAuthorStatus = (typeof onlineUsersMap !== 'undefined' && deck.authorId && onlineUsersMap[deck.authorId])
            ? onlineUsersMap[deck.authorId]
            : null;
        const authorFrameId = liveAuthorStatus?.frame || liveAuthorStatus?.cosmetics?.frame || 'default';
        const authorFrameRing = typeof getFrameMeta === 'function'
            ? getFrameMeta(authorFrameId).ringClass
            : 'border border-slate-200 dark:border-slate-600';
        const authorStats = getStoreAuthorStats(deck.authorId, authorName);
        const repBadge = getAuthorReputationBadge(authorStats.reputation, authorStats.deckCount);
        const repBadgeHtml = repBadge
            ? `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-extrabold border shrink-0 ${repBadge.badgeClass}" title="作者聲望 ★${authorStats.reputation} (${authorStats.deckCount} 部作品 · 累計下載 ${authorStats.totalDownloads})"><span>${repBadge.icon}</span><span>${escapeStoreHTML(repBadge.label)}</span></span>`
            : '';

        return `
            <div class="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm flex flex-col justify-between space-y-4 hover:border-brand-300 dark:hover:border-brand-700 transition">
                <div class="space-y-2.5">
                    <div class="flex justify-between items-start gap-2">
                        <div class="flex items-center flex-wrap gap-1.5">
                            ${rankBadgeHtml}
                            <span class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400 border border-brand-200 dark:border-brand-800">
                                ${safeCategory}
                            </span>
                        </div>
                        ${deck.badge ? `<span class="px-2 py-0.5 text-[10px] font-extrabold bg-amber-500 text-white rounded-full shrink-0">${escapeStoreHTML(deck.badge)}</span>` : ''}
                    </div>

                    <h3 onclick="openStoreDeckPreview('${safeId}')" class="font-bold text-slate-900 dark:text-white text-base hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer transition flex items-center justify-between group">
                        <span class="truncate pr-2">${safeTitle}</span>
                        <i class="fa-solid fa-eye text-xs text-slate-400 group-hover:text-brand-500 transition shrink-0"></i>
                    </h3>
                    <p class="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">${safeDesc}</p>

                    <!-- 📊 觀看次數、下載次數、按讚、收藏與本月熱度指標列 -->
                    <div class="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/70 font-bold" title="${escapeStoreHTML(hotLabel)} = ${escapeStoreHTML(monthlyShort)}下載×3 + ${escapeStoreHTML(monthlyShort)}觀看×1">
                            <i class="fa-solid fa-fire text-[10px]"></i>
                            <span>${escapeStoreHTML(hotLabel)} ${metrics.hotScore}</span>
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300" title="歷史觀看 / 本月觀看">
                            <i class="fa-solid fa-eye text-[10px]"></i>
                            <span>${metrics.views}</span>
                            <span class="text-[10px] opacity-70">(${escapeStoreHTML(monthlyShort)}+${metrics.monthlyViews})</span>
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300" title="歷史下載 / 本月下載">
                            <i class="fa-solid fa-download text-[10px]"></i>
                            <span>${metrics.downloads}</span>
                            <span class="text-[10px] opacity-70">(${escapeStoreHTML(monthlyShort)}+${metrics.monthlyDownloads})</span>
                        </span>
                        <button type="button" onclick="event.stopPropagation(); toggleStoreDeckLike('${safeId}')" title="讚此字庫" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border transition cursor-pointer ${isStoreDeckLiked(deck.id, currentUid)
                            ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border-rose-300 dark:border-rose-700'
                            : 'bg-slate-100 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300 border-transparent hover:border-rose-200 hover:text-rose-600'}">
                            <i class="${isStoreDeckLiked(deck.id, currentUid) ? 'fa-solid' : 'fa-regular'} fa-heart text-[10px]"></i>
                            <span>${metrics.likesCount}</span>
                        </button>
                        <button type="button" onclick="event.stopPropagation(); toggleStoreDeckFavorite('${safeId}')" title="收藏此字庫" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border transition cursor-pointer ${isStoreDeckFavorited(deck.id, currentUid)
                            ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                            : 'bg-slate-100 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300 border-transparent hover:border-amber-200 hover:text-amber-600'}">
                            <i class="${isStoreDeckFavorited(deck.id, currentUid) ? 'fa-solid' : 'fa-regular'} fa-star text-[10px]"></i>
                            <span>${metrics.favoritesCount}</span>
                        </button>
                    </div>
                </div>
                
                <div class="pt-3 border-t border-slate-100 dark:border-slate-700 flex justify-between items-center gap-2">
                    <button type="button" onclick="openAuthorProfile('${encodeURIComponent(authorName)}', '${safeAuthorId}')" class="flex items-center space-x-2 text-left group min-w-0 cursor-pointer">
                        <img src="${safeAvatarUrl}" class="w-6 h-6 rounded-full object-cover shrink-0 ${authorFrameRing}">
                        <span class="text-xs font-semibold text-slate-600 dark:text-slate-300 group-hover:text-brand-600 transition truncate">${safeAuthorName}</span>
                        ${repBadgeHtml}
                    </button>

                    <div class="flex items-center space-x-1.5 shrink-0">
                        <button type="button" onclick="openStoreDeckPreview('${safeId}')" title="${escapeStoreHTML(previewTip)}" class="p-1.5 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition">
                            <i class="fa-solid fa-list text-sm"></i>
                        </button>

                        ${canDelete ? `
                            <button type="button" onclick="deleteStoreDeck('${safeId}')" title="${escapeStoreHTML(isAdmin && !isAuthor ? adminUnpublishTip : selfUnpublishTip)}" class="p-1.5 text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition">
                                <i class="fa-solid fa-trash-can text-sm"></i>
                            </button>
                        ` : ''}

                        <button type="button" onclick="shareDeck('${safeId}')" title="${escapeStoreHTML(shareTip)}" class="p-1.5 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition">
                            <i class="fa-solid fa-share-nodes text-sm"></i>
                        </button>

                        <button type="button" onclick="${deck.price > 0 ? `purchaseStoreDeck('${safeId}')` : `importStoreDeck('${safeId}')`}" class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-xl shadow-sm transition flex items-center space-x-1">
                            <i class="fa-solid fa-download"></i>
                            <span>${escapeStoreHTML(actionBtnText)}</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function openStoreDeckPreview(deckId) {
    const deck = window.storeDecks.find(d => d.id === deckId);
    if (!deck) return;

    _currentPreviewDeckId = deckId;
    const titleEl = document.getElementById('previewDeckTitle');
    const subEl = document.getElementById('previewDeckSub');
    const container = document.getElementById('previewWordsContainer');
    const actionBtn = document.getElementById('previewActionBtn');
    const anonymousText = storeTr('storeAnonymous', '匿名');
    const noMeaningText = storeTr('noMeaning', '無中文釋義');

    if (titleEl) titleEl.textContent = deck.title;
    if (subEl) {
        subEl.textContent = storeTr(
            'storePreviewSub',
            '作者：{author} · 共 {count} 個單字',
            { author: deck.author || anonymousText, count: deck.words ? deck.words.length : 0 }
        );
    }

    renderPreviewStatsBadge(deck);
    renderPreviewInteractionActions(deck);

    if (container) {
        if (!deck.words || deck.words.length === 0) {
            container.innerHTML = `<div class="text-center text-slate-400 py-8">${escapeStoreHTML(storeTr('storePreviewEmpty', '此字庫暫無單字內容'))}</div>`;
        } else {
            container.innerHTML = deck.words.map((w) => `
                <div class="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-100 dark:border-slate-700 space-y-1">
                    <div class="flex justify-between items-center">
                        <div class="flex items-center space-x-2">
                            <span class="font-extrabold text-sm text-slate-800 dark:text-slate-100">${escapeStoreHTML(w.word)}</span>
                            ${w.pos ? `<span class="px-1.5 py-0.2 rounded bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400 font-bold text-[10px]">${escapeStoreHTML(w.pos)}</span>` : ''}
                            ${w.phonetic ? `<span class="text-[11px] text-slate-400 font-mono">${escapeStoreHTML(w.phonetic)}</span>` : ''}
                        </div>
                    </div>
                    <p class="text-xs text-amber-600 dark:text-amber-400 font-semibold">${escapeStoreHTML(w.meaning || noMeaningText)}</p>
                    ${w.sentence ? `<p class="text-[11px] text-slate-500 italic mt-1">"${escapeStoreHTML(w.sentence)}" ${w.translation ? `(${escapeStoreHTML(w.translation)})` : ''}</p>` : ''}
                </div>
            `).join('');
        }
    }

    if (actionBtn) {
        actionBtn.onclick = () => {
            if (typeof closeModal === 'function') closeModal('storePreviewModal');
            if (deck.price > 0) purchaseStoreDeck(deck.id);
            else importStoreDeck(deck.id);
        };
    }

    if (typeof openModal === 'function') openModal('storePreviewModal');

    // 👁️ 觸發防刷觀看次數統計
    recordStoreDeckView(deckId);
}

function openPublishModal() {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城功能！'), 'warning');
        return;
    }

    const select = document.getElementById('pubCategorySelect');
    if (!select) return;

    const categories = Array.from(new Set((typeof wordList !== 'undefined' ? wordList : []).map(w => w.category).filter(Boolean)));
    if (categories.length === 0) {
        if (typeof showToast === 'function') showToast(storeTr('toastNoCategoryToPublish', '您目前沒有建立任何單字分類！'), 'warning');
        return;
    }

    select.innerHTML = categories.map(c => `<option value="${escapeStoreHTML(c)}">${escapeStoreHTML(c)}</option>`).join('');
    
    const currentUser = getStoreCurrentUser();
    const pubAuthorDisplay = document.getElementById('pubAuthorDisplay');
    const fixedNickname = (window.userData && window.userData.nickname)
        ? window.userData.nickname
        : (currentUser ? (currentUser.displayName || currentUser.email.split('@')[0]) : storeTr('storeAnonymousUser', '匿名使用者'));
    
    if (pubAuthorDisplay) {
        pubAuthorDisplay.textContent = fixedNickname;
    }

    if (typeof openModal === 'function') openModal('publishModal');
}

async function submitPublishDeck() {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城功能！'), 'warning');
        return;
    }

    const categoryName = document.getElementById('pubCategorySelect').value;
    const title = (document.getElementById('pubTitle').value || '').trim();
    const desc = (document.getElementById('pubDesc').value || '').trim();

    const priceInput = document.getElementById('pubPrice');
    const price = Math.max(0, parseInt(priceInput?.value, 10) || 0);

    if (!title) {
        if (typeof showToast === 'function') showToast(storeTr('toastEnterDeckTitle', '請填寫字庫名稱！'), 'warning');
        return;
    }

    const currentUser = getStoreCurrentUser();
    if (!currentUser) return;

    const authorNickname = (window.userData && window.userData.nickname)
        ? window.userData.nickname
        : (currentUser.displayName || currentUser.email.split('@')[0]);

    const targetWords = (typeof wordList !== 'undefined' ? wordList : []).filter(w => w.category === categoryName);
    if (targetWords.length === 0) {
        if (typeof showToast === 'function') showToast(storeTr('toastEmptyCategoryPublish', '該分類下無單字，無法發布！'), 'warning');
        return;
    }

    try {
        // 🔒 嚴格過濾：僅上傳純單字內容（單字、詞性、音標、釋義、例句、翻譯），絕不包含個人學習進度與權重
        const cleanWordsForStore = targetWords
            .filter(w => w && w.word && String(w.word).trim())
            .map(w => ({
                word: String(w.word).trim(),
                pos: w.pos ? String(w.pos).trim() : '',
                phonetic: w.phonetic ? String(w.phonetic).trim() : '',
                meaning: w.meaning ? String(w.meaning).trim() : '',
                sentence: w.sentence ? String(w.sentence).trim() : '',
                translation: w.translation ? String(w.translation).trim() : ''
            }));

        const monthKey = getCurrentMonthKey();
        const newDeckData = {
            title: title,
            category: categoryName,
            desc: desc || storeTr('storeDefaultDeckDesc', '由社群使用者分享的實用字庫'),
            author: authorNickname,
            authorId: currentUser.uid,
            authorAvatar: currentUser.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authorNickname)}`,
            price: price,
            words: cleanWordsForStore,
            views: 0,
            downloads: 0,
            downloadCount: 0,
            likesCount: 0,
            favoritesCount: 0,
            monthlyViews: 0,
            monthlyDownloads: 0,
            monthKey: monthKey,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('storeDecks').add(newDeckData);
        await renderStore();

        if (typeof closeModal === 'function') closeModal('publishModal');
        if (typeof showToast === 'function') {
            showToast(storeTr('toastPublishSuccess', '「{title}」已成功發布至雲端商店！', { title }), 'success');
        }
    } catch (error) {
        console.error("發布字庫至雲端失敗:", error);
        if (typeof showToast === 'function') {
            showToast(storeTr('toastPublishFailed', '發布失敗：{error}', { error: error.message }), 'error');
        }
    }
}

function openAuthorProfile(encodedAuthor, authorUid = '') {
    // 跨模組玩家公開面板入口橋接
    if ((authorUid || encodedAuthor) && typeof window.openPlayerProfileModal === 'function') {
        window.openPlayerProfileModal(authorUid, decodeURIComponent(encodedAuthor || ''));
        return;
    }

    const authorName = decodeURIComponent(encodedAuthor);
    const authorDecks = window.storeDecks.filter(d => (d.author || '').toLowerCase() === authorName.toLowerCase());

    const nameEl = document.getElementById('authorModalName');
    const countEl = document.getElementById('authorModalCount');
    const avatarEl = document.getElementById('authorModalAvatar');
    const container = document.getElementById('authorDecksContainer');

    if (nameEl) nameEl.textContent = authorName;
    if (countEl) countEl.textContent = storeTr('storeAuthorDeckCount', '共發布了 {count} 個字庫作品', { count: authorDecks.length });
    if (avatarEl) avatarEl.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authorName)}`;

    const previewBtnText = storeTr('btnPreview', '預覽');
    const getBtnText = storeTr('btnGet', '取得');

    if (container) {
        container.innerHTML = authorDecks.map(deck => {
            const safeId = escapeStoreHTML(deck.id);
            const m = normalizeStoreDeckMetrics(deck);
            return `
            <div class="p-3.5 bg-slate-50 dark:bg-slate-900 rounded-xl flex justify-between items-center border border-slate-200 dark:border-slate-700 gap-2">
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">${escapeStoreHTML(deck.title)}</h4>
                    <p class="text-xs text-slate-400 mt-0.5">${(deck.words || []).length} ${escapeStoreHTML(storeTr('unitWord', '個單字'))} · ${escapeStoreHTML(deck.category)} · 👁️ ${m.views} · ⬇️ ${m.downloads}</p>
                </div>
                <div class="flex space-x-1.5 shrink-0">
                    <button type="button" onclick="openStoreDeckPreview('${safeId}')" class="px-2.5 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg transition">
                        ${escapeStoreHTML(previewBtnText)}
                    </button>
                    <button type="button" onclick="${deck.price > 0 ? `purchaseStoreDeck('${safeId}')` : `importStoreDeck('${safeId}')`}" class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-lg shadow-sm transition">
                        ${escapeStoreHTML(deck.price > 0 ? storeTr('storePriceCoins', '{price} 金幣', { price: deck.price }) : getBtnText)}
                    </button>
                </div>
            </div>
        `;
        }).join('');
    }

    if (typeof openModal === 'function') openModal('authorModal');
}

function shareDeck(deckId) {
    const shareUrl = `${window.location.origin}${window.location.pathname}?deck=${encodeURIComponent(deckId)}`;
    const deck = Array.isArray(window.storeDecks) ? window.storeDecks.find(d => d.id === deckId) : null;

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        navigator.share({
            title: deck ? `LZHCard 字庫：${deck.title}` : 'LZHCard 精選單字庫',
            text: '推薦你這個超實用的單字字庫包！',
            url: shareUrl
        }).catch((err) => {
            if (err && err.name === 'AbortError') return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(shareUrl).then(() => {
                    if (typeof showToast === 'function') showToast(storeTr('toastShareLinkCopied', '已複製字庫分享連結！'), 'success');
                }).catch(() => {});
            }
        });
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).then(() => {
            if (typeof showToast === 'function') showToast(storeTr('toastShareLinkCopied', '已複製字庫分享連結！'), 'success');
        }).catch(() => {
            if (typeof showToast === 'function') showToast(`分享連結：${shareUrl}`, 'info');
        });
    } else if (typeof showToast === 'function') {
        showToast(`分享連結：${shareUrl}`, 'info');
    }
}

function importStoreDeck(deckId) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城功能！'), 'warning');
        return;
    }

    const deck = window.storeDecks.find(d => d.id === deckId);
    if (!deck) return;

    const now = Date.now();
    let addedCount = 0;

    (deck.words || []).forEach(w => {
        if (!w || !w.word) return;
        const cleanWord = String(w.word).trim();
        const exists = wordList.some(item => item.word.trim().toLowerCase() === cleanWord.toLowerCase() && item.category === deck.title);
        if (!exists) {
            // 🔒 下載匯入時強制重置為全新單字狀態，確保絕不夾帶任何外部進度與權重
            wordList.push({
                id: 'w_' + now + '_' + Math.random().toString(36).substr(2, 4),
                category: deck.title,
                word: cleanWord,
                pos: w.pos ? String(w.pos).trim() : '',
                phonetic: w.phonetic ? String(w.phonetic).trim() : '',
                meaning: w.meaning ? String(w.meaning).trim() : '',
                sentence: w.sentence ? String(w.sentence).trim() : '',
                translation: w.translation ? String(w.translation).trim() : '',
                level: 1,
                knowStreak: 0,
                state: 'new',
                stability: 0,
                difficulty: 5.5,
                reps: 0,
                lapses: 0,
                lastReview: 0,
                nextReview: 0,
                freeLevel: 1,
                freeStreak: 0,
                updatedAt: now
            });
            addedCount++;
        }
    });

    if (typeof saveStorage === 'function') saveStorage();
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();
    if (typeof showToast === 'function') {
        showToast(storeTr('toastStoreImportSuccess', '成功匯入「{title}」（共 {count} 個單字）', { title: deck.title, count: addedCount }), 'success');
    }

    // ⬇️ 觸發依 uid 去重與跨月重置之下載統計
    recordStoreDeckDownload(deckId);
}

async function purchaseStoreDeck(deckId) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城功能！'), 'warning');
        return;
    }

    const deck = window.storeDecks.find(d => d.id === deckId);
    if (!deck) return;

    const price = deck.price || 0;
    const currentUser = getStoreCurrentUser();
    if (!currentUser) return;

    // 1. 自己發布的字庫免費取得
    if (deck.authorId && deck.authorId === currentUser.uid) {
        if (typeof showToast === 'function') showToast(storeTr('toastOwnDeckFree', '這是您發布的字庫，無需花費金幣即可直接取得！'), 'info');
        importStoreDeck(deckId);
        return;
    }

    const backendUrl = typeof SHARED_BACKEND_URL !== 'undefined'
        ? SHARED_BACKEND_URL
        : 'https://lzhcard.tomlin980415.workers.dev';

    const confirmMsg = storeTr('confirmPurchaseDeck', '確認花費 {price} 金幣購買「{title}」？', { price, title: deck.title });

    if (confirm(confirmMsg)) {
        try {
            const idToken = await currentUser.getIdToken();

            const res = await fetch(`${backendUrl}/buy-deck`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    deckId: deckId,
                    price: price,
                    authorId: deck.authorId || ''
                })
            });

            const result = await res.json();

            if (!res.ok || !result.success) {
                throw new Error(result.error || storeTr('errTradeFailed', '交易失敗'));
            }

            if (window.userData) window.userData.coins = result.newCoins;

            importStoreDeck(deckId);

            if (typeof updateUserCoinsUI === 'function') updateUserCoinsUI();
            if (typeof showToast === 'function') {
                showToast(
                    storeTr('toastPurchaseSuccess', '成功花費 {price} 金幣購買「{title}」！剩餘金幣：{coins}', {
                        price,
                        title: deck.title,
                        coins: result.newCoins
                    }),
                    'success'
                );
            }
        } catch (err) {
            console.error("交易失敗:", err);
            if (typeof showToast === 'function') {
                showToast(storeTr('toastPurchaseFailed', '交易失敗：{error}', { error: err.message }), 'error');
            }
        }
    }
}

async function deleteStoreDeck(deckId) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(storeTr('toastStoreLoginRequired', '請先登入帳號才能使用商城功能！'), 'warning');
        return;
    }

    const deck = window.storeDecks.find(d => d.id === deckId);
    if (!deck) return;

    const currentUser = getStoreCurrentUser();
    const currentUid = currentUser ? currentUser.uid : '';
    const userRole = window.userData ? window.userData.role : 'user';

    const isAuthor = currentUid && deck.authorId === currentUid;
    const isAdmin = userRole === 'admin';

    if (!isAuthor && !isAdmin) {
        if (typeof showToast === 'function') showToast(storeTr('toastNoPermissionUnpublish', '您沒有權限下架此字庫！'), 'error');
        return;
    }

    const confirmMsg = (isAdmin && !isAuthor)
        ? storeTr('confirmAdminUnpublish', '👑 管理員警告：確定強制下架「{title}」？', { title: deck.title })
        : storeTr('confirmSelfUnpublish', '確定要將您的作品「{title}」從商店下架嗎？', { title: deck.title });

    if (confirm(confirmMsg)) {
        try {
            await db.collection('storeDecks').doc(deckId).delete();
            await renderStore();
            if (typeof showToast === 'function') {
                showToast(storeTr('toastUnpublishSuccess', '已成功將「{title}」下架！', { title: deck.title }), 'info');
            }
        } catch (error) {
            console.error("下架字庫失敗:", error);
            if (typeof showToast === 'function') {
                showToast(storeTr('toastUnpublishFailed', '下架失敗：{error}', { error: error.message }), 'error');
            }
        }
    }
}

if (typeof window !== 'undefined') {
    window.getCurrentMonthKey = getCurrentMonthKey;
    window.normalizeStoreDeckMetrics = normalizeStoreDeckMetrics;
    window.setStoreSortMode = setStoreSortMode;
    window.sortStoreDecks = sortStoreDecks;
    window.recordStoreDeckView = recordStoreDeckView;
    window.recordStoreDeckDownload = recordStoreDeckDownload;
    window.toggleStoreDeckLike = toggleStoreDeckLike;
    window.toggleStoreDeckFavorite = toggleStoreDeckFavorite;
    window.syncUserStoreReactions = syncUserStoreReactions;
    window.getStoreAuthorStats = getStoreAuthorStats;
    window.getAuthorReputationBadge = getAuthorReputationBadge;
    window.debouncedRenderStore = debouncedRenderStore;
    window.renderStore = renderStore;
}

document.addEventListener('DOMContentLoaded', async () => {
    updateStoreSortBarUI();
    await renderStore();

    if (typeof StartupDeepLinkQueue !== 'undefined' && typeof StartupDeepLinkQueue.processWhenReady === 'function') {
        if (typeof firebase === 'undefined' || window.__authInitialLoadDone === true) {
            StartupDeepLinkQueue.processWhenReady();
        }
    } else if (window.location.hash.startsWith('#share=')) {
        const deckId = decodeURIComponent(window.location.hash.replace('#share=', ''));
        const targetDeck = window.storeDecks.find(d => d.id === deckId);
        if (targetDeck) {
            if (typeof switchTab === 'function') switchTab('store');
            openStoreDeckPreview(targetDeck.id);
        }
    }
});
