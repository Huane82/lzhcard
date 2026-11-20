/**
 * LZHCard - Android App 外系統級懸浮視窗橋接模組 (js/system-overlay.js)
 */
(function (global) {
    'use strict';

    const SYSTEM_OVERLAY_STORAGE_KEY = 'lzhcard_system_overlay_enabled';
    let pendingOverlayAutoStart = false;
    let foregroundListenersBound = false;
    let lastForegroundRefreshAt = 0;

    function getSystemOverlayPlugin() {
        if (!global || !global.Capacitor) return null;
        if (global.Capacitor.Plugins && global.Capacitor.Plugins.SystemOverlay) {
            return global.Capacitor.Plugins.SystemOverlay;
        }
        if (typeof global.Capacitor.registerPlugin === 'function') {
            try {
                return global.Capacitor.registerPlugin('SystemOverlay');
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    function isAndroidNativeEnvironment() {
        if (!global || !global.Capacitor) return false;
        if (typeof global.Capacitor.isNativePlatform === 'function') {
            return global.Capacitor.isNativePlatform();
        }
        return /android/i.test(navigator.userAgent || '');
    }

    function notifyUser(message, type = 'info') {
        if (typeof global.showToast === 'function') {
            global.showToast(message, type);
        }
    }

    function getCurrentDecksList() {
        if (typeof global.getAllCategories === 'function') {
            const list = global.getAllCategories();
            if (Array.isArray(list) && list.length > 0) return list;
        }
        const set = new Set(['我的單字本']);
        const wl = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        wl.forEach(c => { if (c && c.category) set.add(c.category); });
        return Array.from(set);
    }

    const RTDB_URL = 'https://flashcards-5f514-default-rtdb.asia-southeast1.firebasedatabase.app';

    function buildChatSessionSummaryObject(idToken = '') {
        let uid = '';
        let nickname = '';
        let avatar = '';
        let frame = 'default';
        try {
            const authUser = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) ? firebase.auth().currentUser : null;
            if (authUser && !authUser.isAnonymous) {
                uid = authUser.uid || '';
                avatar = authUser.photoURL || '';
                nickname = authUser.displayName || (authUser.email ? authUser.email.split('@')[0] : '');
            }
        } catch (e) {}

        const ud = (typeof global.userData !== 'undefined' && global.userData) ? global.userData : null;
        if (ud) {
            if (ud.nickname) nickname = ud.nickname;
            if (ud.photoURL) avatar = ud.photoURL;
            if (ud.cosmetics && ud.cosmetics.frame) frame = ud.cosmetics.frame;
        }
        if (uid && !avatar) {
            avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(uid)}`;
        }

        const friendsMap = (ud && ud.friends && typeof ud.friends === 'object') ? ud.friends : {};
        const friends = Object.keys(friendsMap).map(fKey => {
            const f = friendsMap[fKey] || {};
            const fUid = f.uid || fKey;
            const name = f.nickname || f.username || f.name || '好友';
            const liveStatus = (typeof global.onlineUsersMap !== 'undefined' && global.onlineUsersMap) ? global.onlineUsersMap[fUid] : null;
            return {
                uid: fUid,
                name,
                avatar: f.avatar || (liveStatus && liveStatus.avatar) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(fUid)}`,
                online: Boolean(liveStatus && liveStatus.online && !liveStatus.hidePrivacy),
                lastSeen: (liveStatus && liveStatus.lastSeen) || 0
            };
        });

        const rawThreads = Array.isArray(global.userChatThreads) ? global.userChatThreads : [];
        const threads = rawThreads.slice(0, 30).map(th => ({
            id: th.id || '',
            type: th.type || 'private',
            name: th.name || '對話',
            lastMessage: th.lastMessage || '',
            lastSenderUid: th.lastSenderUid || '',
            updatedAt: th.updatedAt || 0,
            readBy: th.readBy || {}
        })).filter(th => th.id);

        return {
            uid,
            nickname: nickname || 'LZHCard 玩家',
            avatar,
            frame,
            idToken: idToken || '',
            databaseURL: RTDB_URL,
            friends,
            threads
        };
    }

    function getActivePrimaryDeckName(fallbackDecks = []) {
        if (typeof selectedCategories !== 'undefined') {
            if (Array.isArray(selectedCategories)) {
                const picked = selectedCategories.find(c => c && c !== 'ALL');
                if (picked) return picked;
            } else if (selectedCategories instanceof Set && selectedCategories.size > 0) {
                const picked = Array.from(selectedCategories).find(c => c && c !== 'ALL');
                if (picked) return picked;
            }
        }
        return (Array.isArray(fallbackDecks) && fallbackDecks[0]) ? fallbackDecks[0] : '我的單字本';
    }

    function getCurrentOverlayConfigPayload(idToken = '') {
        const nativeLang =
            localStorage.getItem('lzhcard_ft_target_native_lang_v1') ||
            localStorage.getItem('lzhcard_native_lang') ||
            'zh-TW';
        const theme = localStorage.getItem('theme_preference') || 'system';
        const groqApiKey = localStorage.getItem('lzhcard_groq_key_v1') || '';
        const apiKey = localStorage.getItem('flashcard_gemini_key_v1') || '';
        const apiMode = (groqApiKey.trim() || apiKey.trim()) ? 'personal' : (localStorage.getItem('lzhcard_api_mode') || 'shared');
        const decks = getCurrentDecksList();
        const defaultDeck = getActivePrimaryDeckName(decks);

        let membershipTier = 'free';
        let aiUsageObj = {};
        if (global.MembershipEngine && typeof global.MembershipEngine.getQuotaSnapshot === 'function') {
            try {
                const snap = global.MembershipEngine.getQuotaSnapshot();
                membershipTier = snap.tier || 'free';
                aiUsageObj = {
                    dailyDate: snap.dailyDate || '',
                    daily: snap.daily || {},
                    credits: snap.credits || {}
                };
            } catch (e) {}
        }

        const videoRoiMode = localStorage.getItem('lzhcard_ft_video_roi_mode_v1') || 'bottom25';
        const videoRoiRectJson = localStorage.getItem('lzhcard_ft_video_roi_cfg_v1') || '{}';

        return {
            nativeLang,
            theme,
            apiMode,
            apiKey,
            groqApiKey,
            decksJson: JSON.stringify(decks),
            defaultDeck,
            inForeground: document.visibilityState === 'visible',
            membershipTier,
            aiUsageJson: JSON.stringify(aiUsageObj),
            chatSessionJson: JSON.stringify(buildChatSessionSummaryObject(idToken)),
            videoRoiMode,
            videoRoiRectJson
        };
    }

    async function getCurrentOverlayConfigPayloadAsync() {
        let token = '';
        try {
            const authUser = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) ? firebase.auth().currentUser : null;
            if (authUser && !authUser.isAnonymous && typeof authUser.getIdToken === 'function') {
                token = await authUser.getIdToken(false);
            }
        } catch (e) {}
        return getCurrentOverlayConfigPayload(token);
    }

    function getSystemOverlayDomElements() {
        const toggle =
            document.getElementById('systemOverlayToggle') ||
            document.getElementById('nativeOverlayToggle') ||
            document.getElementById('androidOverlayToggle') ||
            document.querySelector('[data-system-overlay-toggle]');

        const statusEl =
            document.getElementById('systemOverlayStatusText') ||
            document.getElementById('systemOverlayStatus') ||
            document.getElementById('overlayPermissionStatus') ||
            document.getElementById('nativeOverlayStatusText') ||
            document.querySelector('[data-system-overlay-status]');

        return { toggle, statusEl };
    }

    function updateSystemOverlayUIState({ supported, granted, running }) {
        global._nativeSystemOverlayStatus = {
            supported: Boolean(supported),
            granted: Boolean(granted),
            running: Boolean(running)
        };

        const { toggle, statusEl } = getSystemOverlayDomElements();
        const activeOn = Boolean(granted && running);

        if (toggle) {
            toggle.checked = activeOn;
        }

        if (supported) {
            const ftToggle = document.getElementById('floatingTranslatorToggle');
            if (ftToggle) {
                ftToggle.checked = activeOn || (localStorage.getItem('lzhcard_floating_translator_enabled') !== 'false');
            }
        }

        if (statusEl) {
            if (!supported) {
                statusEl.textContent = '僅限 Android 安裝版 App 使用（電腦/網頁版請使用懸浮球或桌面小工具）';
                statusEl.className = 'text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-0.5';
            } else if (granted && running) {
                statusEl.textContent = '● 已啟用（App 內自動隱藏，切出至其他 App 時自動浮現 🌐）';
                statusEl.className = 'text-[11px] font-bold text-emerald-600 dark:text-emerald-400 mt-0.5';
            } else if (granted && !running) {
                statusEl.textContent = '✓ 已取得懸浮權限（目前為關閉狀態）';
                statusEl.className = 'text-[11px] font-semibold text-brand-600 dark:text-brand-400 mt-0.5';
            } else {
                statusEl.textContent = '⚠️ 尚未開啟「顯示在其他應用程式上層」權限';
                statusEl.className = 'text-[11px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5';
            }
        }

        const badge = document.getElementById('overlayPermStatusBadge');
        if (badge) {
            if (!supported) {
                badge.textContent = '🌐 目前為瀏覽器 / 桌面版';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
            } else if (granted && running) {
                badge.textContent = '✅ 已授權並啟用中';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300';
            } else if (granted) {
                badge.textContent = '✓ 系統已授權';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300';
            } else {
                badge.textContent = '⚠️ 尚未授權';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
            }
        }

        if (typeof global.updateFloatingMasterSwitchUI === 'function') {
            global.updateFloatingMasterSwitchUI();
        }
    }

    async function syncPendingDataFromNativeOverlay() {
        const plugin = getSystemOverlayPlugin();
        if (!isAndroidNativeEnvironment() || !plugin || typeof plugin.consumePendingData !== 'function') {
            return;
        }
        try {
            const data = await plugin.consumePendingData();
            if (!data) return;

            if (Array.isArray(data.cards) && data.cards.length > 0 && global.FloatingTranslator && typeof global.FloatingTranslator.upsertCardsIntoWordList === 'function') {
                const byDeck = new Map();
                data.cards.forEach(card => {
                    const deck = (card && card.targetDeck) ? String(card.targetDeck).trim() : '懸浮快譯字庫';
                    if (!byDeck.has(deck)) byDeck.set(deck, []);
                    byDeck.get(deck).push(card);
                });
                let totalAdded = 0;
                byDeck.forEach((cards, deck) => {
                    const res = global.FloatingTranslator.upsertCardsIntoWordList(cards, deck);
                    totalAdded += (res.addedCount || 0);
                });
                if (totalAdded > 0) {
                    notifyUser(`📥 已自動匯入 ${totalAdded} 張跨 App 懸浮翻譯單字至字庫`, 'success');
                }
            }
        } catch (err) {
            console.warn('[SystemOverlay] consumePendingData skipped:', err);
        }
    }

    async function syncConfigToNativeOverlay() {
        const plugin = getSystemOverlayPlugin();
        if (!isAndroidNativeEnvironment() || !plugin || typeof plugin.syncOverlayConfig !== 'function') {
            return;
        }
        try {
            const payload = await getCurrentOverlayConfigPayloadAsync();
            await plugin.syncOverlayConfig(payload);
        } catch (e) {}
    }

    async function refreshSystemOverlayStatus(silent = false) {
        const plugin = getSystemOverlayPlugin();
        if (!isAndroidNativeEnvironment() || !plugin) {
            updateSystemOverlayUIState({ supported: false, granted: false, running: false });
            if (!silent) notifyUser('此功能僅限 Android 安裝版 App 使用', 'info');
            return { supported: false, granted: false, running: false };
        }

        try {
            const res = await plugin.checkOverlayPermission();
            const granted = Boolean(res && res.granted);
            let running = Boolean(res && res.running);

            if (granted && !running && pendingOverlayAutoStart) {
                pendingOverlayAutoStart = false;
                const payload = await getCurrentOverlayConfigPayloadAsync();
                const startRes = await plugin.startOverlayService(payload);
                running = Boolean(startRes && startRes.running);
                if (running) {
                    localStorage.setItem(SYSTEM_OVERLAY_STORAGE_KEY, 'true');
                    localStorage.setItem('lzhcard_floating_translator_enabled', 'true');
                    if (global.FloatingTranslator && typeof global.FloatingTranslator.setEnabled === 'function') {
                        global.FloatingTranslator.setEnabled(true);
                    }
                    notifyUser('✅ 已授權並啟用懸浮視窗（App 內隱藏，切出至其他 App 自動顯示）', 'success');
                }
            } else if (!granted) {
                localStorage.setItem(SYSTEM_OVERLAY_STORAGE_KEY, 'false');
            }

            updateSystemOverlayUIState({ supported: true, granted, running });

            if (!silent) {
                notifyUser(
                    granted
                        ? (running ? 'App 外懸浮球已啟用（離開 App 時自動顯示）' : '已取得懸浮權限，可隨時開啟開關')
                        : '尚未取得「顯示在其他應用程式上層」權限',
                    granted ? 'success' : 'warning'
                );
            }

            return {
                supported: true,
                granted,
                running,
                manufacturer: (res && res.manufacturer) || '',
                brand: (res && res.brand) || ''
            };
        } catch (err) {
            updateSystemOverlayUIState({ supported: false, granted: false, running: false });
            return { supported: false, granted: false, running: false };
        }
    }

    async function ensureAndToggleAndroidOverlayPermission(enable) {
        const wantEnable = Boolean(enable);
        const plugin = getSystemOverlayPlugin();

        if (!isAndroidNativeEnvironment() || !plugin) {
            updateSystemOverlayUIState({ supported: false, granted: false, running: false });
            notifyUser('App 外系統懸浮球僅限 Android 安裝版 App 使用', 'warning');
            return false;
        }

        try {
            if (!wantEnable) {
                pendingOverlayAutoStart = false;
                localStorage.setItem(SYSTEM_OVERLAY_STORAGE_KEY, 'false');
                await plugin.stopOverlayService();
                await refreshSystemOverlayStatus(true);
                notifyUser('已關閉系統懸浮視窗', 'info');
                return true;
            }

            const perm = await plugin.checkOverlayPermission();
            if (!perm || !perm.granted) {
                updateSystemOverlayUIState({ supported: true, granted: false, running: false });
                pendingOverlayAutoStart = true;
                notifyUser('請先開啟「顯示在其他應用程式上層」權限，授權後返回即自動啟用', 'warning');
                await plugin.requestOverlayPermission();
                return false;
            }

            const payload = await getCurrentOverlayConfigPayloadAsync();
            const startRes = await plugin.startOverlayService(payload);
            const isRunning = Boolean(startRes && startRes.running);
            localStorage.setItem(SYSTEM_OVERLAY_STORAGE_KEY, isRunning ? 'true' : 'false');
            if (isRunning) {
                localStorage.setItem('lzhcard_floating_translator_enabled', 'true');
                if (global.FloatingTranslator && typeof global.FloatingTranslator.setEnabled === 'function') {
                    global.FloatingTranslator.setEnabled(true);
                }
            }
            await refreshSystemOverlayStatus(true);

            if (isRunning) {
                notifyUser('🌐 已啟用系統懸浮視窗（App 內自動隱藏，切出至其他 App 立即浮現）', 'success');
            }
            return isRunning;
        } catch (err) {
            updateSystemOverlayUIState({ supported: true, granted: false, running: false });
            notifyUser('啟動系統懸浮球失敗：' + (err && err.message ? err.message : '請確認權限設定'), 'error');
            return false;
        }
    }

    async function handleSystemOverlayToggle(enable) {
        return ensureAndToggleAndroidOverlayPermission(enable);
    }

    async function requestNativeOverlayPermission() {
        const plugin = getSystemOverlayPlugin();
        if (!isAndroidNativeEnvironment() || !plugin) {
            notifyUser('此功能僅限 Android 安裝版 App 使用', 'info');
            return false;
        }

        try {
            const current = await plugin.checkOverlayPermission();
            if (current && current.granted) {
                await handleSystemOverlayToggle(true);
                return true;
            }
            pendingOverlayAutoStart = true;
            const res = await plugin.requestOverlayPermission();
            if (res && res.granted) {
                pendingOverlayAutoStart = false;
                await handleSystemOverlayToggle(true);
                return true;
            }
            notifyUser('請在系統設定中找到「LZHCard」並開啟上層顯示權限', 'info');
            return false;
        } catch (err) {
            notifyUser('無法自動開啟系統設定頁，請依下方品牌步驟手動開啟', 'warning');
            return false;
        }
    }

    const OVERLAY_BRAND_GUIDES = [
        {
            id: 'xiaomi',
            label: '小米 / Redmi / POCO',
            os: 'HyperOS / MIUI',
            steps: [
                '前往「設定 → 應用程式 → 應用程式管理 → LZHCard → 權限管理 / 其他權限」。',
                '開啟「顯示懸浮窗」以及「後台彈出介面」（非常關鍵，沒開會無法在桌面顯示）。',
                '前往「隱私與安全 → 特殊權限 → 顯示在其他應用程式上層」，確認 LZHCard 已開啟。',
                '若切換 App 後被系統清理，請於最近工作頁向下鎖定 LZHCard 卡片並關閉省電限制。'
            ],
            note: 'HyperOS / MIUI 預設禁止背景彈出視窗，請務必同時打開「顯示懸浮窗」與「後台彈出介面」。'
        },
        {
            id: 'oppo',
            label: 'OPPO / realme / OnePlus',
            os: 'ColorOS / OxygenOS',
            steps: [
                '點擊上方「一鍵前往系統授權設定」，或開啟「設定 → 應用程式 → 特殊應用程式存取權 → 顯示在其他應用程式上層」。',
                '在清單找到 LZHCard，切換為「允許顯示在其他應用程式上層」。',
                '至「應用程式資訊 → 耗電管理」，開啟「允許背景執行 / 完全允許背景活動」。'
            ],
            note: 'OPPO 與 realme 建議於多工介面鎖定 App，防止長時間停留在瀏覽器時被省電回收。'
        },
        {
            id: 'vivo',
            label: 'vivo / iQOO',
            os: 'OriginOS / Funtouch OS',
            steps: [
                '打開系統「i 管家 → 應用程式管理 → 權限管理 → 權限 → 懸浮窗」。',
                '找到 LZHCard 並開啟「懸浮窗」與「後台彈出介面」。',
                '於「設定 → 電池 → 後台高耗電」，將 LZHCard 加入允許名單。'
            ],
            note: 'OriginOS 若未開啟「後台彈出介面」，按下 Home 鍵後可能無法浮出懸浮球。'
        },
        {
            id: 'samsung',
            label: 'Samsung 三星',
            os: 'One UI',
            steps: [
                '開啟「設定 → 應用程式 → 右上角 ⋮ 選單 → 特殊存取 → 出現在最上層」。',
                '搜尋並開啟 LZHCard 的「允許權限」開關。',
                '至「應用程式資訊 → 電池」，將模式改為「不受限制」以確保穩定常駐。'
            ],
            note: 'Samsung 平板與手機搭配「出現在最上層 + 電池不受限制」可長時間流暢點詞翻譯。'
        },
        {
            id: 'huawei',
            label: '華為 / 榮耀',
            os: 'HarmonyOS / MagicOS',
            steps: [
                '開啟「設定 → 應用程式和服務 → 權限管理 → 懸浮窗」。',
                '找到 LZHCard，將「懸浮窗」開關切換為開啟。',
                '在「應用程式啟動管理」中改為「手動管理」，並勾選「允許自動啟動」與「允許後台活動」。'
            ],
            note: 'HarmonyOS / MagicOS 務必於啟動管理設為手動並允許背景執行。'
        },
        {
            id: 'asus',
            label: 'ASUS / ROG',
            os: 'ZenUI / ROG UI',
            steps: [
                '開啟「設定 → 應用程式和通知 → 進階 → 特殊應用程式存取權 → 顯示在其他應用程式上層」。',
                '找到 LZHCard 並開啟開關。',
                '至「智慧管家 → 權限管理 → 自啟動管理」允許 LZHCard，並於遊戲精靈中設為不清理白名單。'
            ],
            note: 'ROG Phone 在遊戲期間可透過無障礙與懸浮窗權限直接於畫面上方點詞。'
        },
        {
            id: 'pixel',
            label: 'Pixel / 原生 Android',
            os: 'Android 13 / 14 / 15+',
            steps: [
                '點擊上方「一鍵前往系統授權設定」（或至「設定 → 應用程式 → 特殊應用程式存取權 → 顯示在其他應用程式上層」）。',
                '在清單中點擊 LZHCard 並開啟「允許顯示在其他應用程式上層」。',
                '返回 LZHCard 後即可隨時切換系統懸浮球開關，離開 App 時即自動浮現。'
            ],
            note: '原生 Android 與大多數平板（如 Lenovo /小米 Pad 國際版）僅需這一步授權即可完整運作。'
        }
    ];

    let activeOverlayBrandId = 'pixel';

    function detectBrandIdFromDevice(manufacturerStr) {
        const mfr = String(manufacturerStr || navigator.userAgent || '').toLowerCase();
        if (mfr.includes('xiaomi') || mfr.includes('redmi') || mfr.includes('poco')) return 'xiaomi';
        if (mfr.includes('oppo') || mfr.includes('realme') || mfr.includes('oneplus')) return 'oppo';
        if (mfr.includes('vivo') || mfr.includes('iqoo')) return 'vivo';
        if (mfr.includes('samsung')) return 'samsung';
        if (mfr.includes('huawei') || mfr.includes('honor')) return 'huawei';
        if (mfr.includes('asus') || mfr.includes('rog')) return 'asus';
        return 'pixel';
    }

    function renderOverlayBrandGuideContent() {
        const tabsEl = document.getElementById('overlayBrandTabs');
        const detailEl = document.getElementById('overlayBrandDetailCard');
        if (!tabsEl || !detailEl) return;

        tabsEl.innerHTML = OVERLAY_BRAND_GUIDES.map(brand => {
            const active = brand.id === activeOverlayBrandId;
            return `
                <button type="button" data-overlay-brand="${brand.id}" class="px-3 py-1.5 rounded-xl text-xs font-extrabold whitespace-nowrap transition cursor-pointer shrink-0 ${active
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}">
                    ${brand.label}
                </button>
            `;
        }).join('');

        tabsEl.querySelectorAll('[data-overlay-brand]').forEach(btn => {
            btn.onclick = () => {
                activeOverlayBrandId = btn.getAttribute('data-overlay-brand');
                renderOverlayBrandGuideContent();
            };
        });

        const cur = OVERLAY_BRAND_GUIDES.find(b => b.id === activeOverlayBrandId) || OVERLAY_BRAND_GUIDES[0];
        detailEl.innerHTML = `
            <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-3">
                <div class="flex items-center justify-between gap-2">
                    <div class="text-sm font-black text-slate-900 dark:text-white">${cur.label}</div>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">${cur.os}</span>
                </div>
                <ol class="text-xs leading-relaxed text-slate-700 dark:text-slate-200 list-decimal pl-5 space-y-1.5">
                    ${cur.steps.map(s => `<li>${s}</li>`).join('')}
                </ol>
                <div class="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] font-semibold text-amber-800 dark:text-amber-200 leading-relaxed">
                    💡 提示：${cur.note}
                </div>
            </div>
        `;
    }

    async function openOverlayPermissionGuideModal() {
        const existingModal = document.getElementById('overlayPermissionGuideModal');
        const status = await refreshSystemOverlayStatus(true);
        const detectedId = detectBrandIdFromDevice(status.manufacturer || status.brand || '');
        activeOverlayBrandId = detectedId;

        if (existingModal) {
            const brandBadge = document.getElementById('overlayDetectedBrandBadge');
            if (brandBadge) {
                const rawMfr = String(status.manufacturer || status.brand || '').trim();
                if (rawMfr) {
                    brandBadge.textContent = `裝置：${rawMfr}`;
                    brandBadge.classList.remove('hidden');
                } else {
                    brandBadge.classList.add('hidden');
                }
            }
            renderOverlayBrandGuideContent();
            existingModal.classList.remove('hidden');
            existingModal.classList.add('flex');
            return;
        }
    }

    function closeOverlayPermissionGuideModal() {
        const modal = document.getElementById('overlayPermissionGuideModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    global.ensureAndToggleAndroidOverlayPermission = ensureAndToggleAndroidOverlayPermission;
    global.handleSystemOverlayToggle = handleSystemOverlayToggle;
    global.requestNativeOverlayPermission = requestNativeOverlayPermission;
    global.refreshSystemOverlayStatus = refreshSystemOverlayStatus;
    global.syncConfigToNativeOverlay = syncConfigToNativeOverlay;
    global.openOverlayPermissionGuideModal = openOverlayPermissionGuideModal;
    global.closeOverlayPermissionGuideModal = closeOverlayPermissionGuideModal;

    if (typeof global.applyTheme === 'function' && !global.applyTheme.__overlayWrapped) {
        const origApplyTheme = global.applyTheme;
        const wrappedTheme = function (...args) {
            const res = origApplyTheme.apply(this, args);
            syncConfigToNativeOverlay();
            return res;
        };
        wrappedTheme.__overlayWrapped = true;
        global.applyTheme = wrappedTheme;
    }

    if (typeof global.syncSettingsUI === 'function' && !global.syncSettingsUI.__overlayWrapped) {
        const origSyncSettingsUI = global.syncSettingsUI;
        const wrappedSync = function (...args) {
            const res = origSyncSettingsUI.apply(this, args);
            refreshSystemOverlayStatus(true);
            syncConfigToNativeOverlay();
            return res;
        };
        wrappedSync.__overlayWrapped = true;
        global.syncSettingsUI = wrappedSync;
    }

    async function handleAppReturnedToForeground() {
        const now = Date.now();
        if (now - lastForegroundRefreshAt < 250) return;
        lastForegroundRefreshAt = now;

        const plugin = getSystemOverlayPlugin();
        if (isAndroidNativeEnvironment() && plugin && typeof plugin.setAppForeground === 'function') {
            plugin.setAppForeground({ inForeground: true }).catch(() => {});
        }
        await refreshSystemOverlayStatus(true);
        await syncPendingDataFromNativeOverlay();
        syncConfigToNativeOverlay();
    }

    function bindOverlayLifecycleListeners() {
        if (foregroundListenersBound) return;
        foregroundListenersBound = true;

        document.addEventListener('visibilitychange', () => {
            const inFg = document.visibilityState === 'visible';
            const plugin = getSystemOverlayPlugin();
            if (isAndroidNativeEnvironment() && plugin && typeof plugin.setAppForeground === 'function') {
                plugin.setAppForeground({ inForeground: inFg }).catch(() => {});
            }
            if (inFg) {
                handleAppReturnedToForeground();
            }
        });

        document.addEventListener('resume', () => {
            handleAppReturnedToForeground();
        });

        if (typeof global.addEventListener === 'function') {
            global.addEventListener('resume', () => {
                handleAppReturnedToForeground();
            });
            global.addEventListener('focus', () => {
                if (isAndroidNativeEnvironment()) {
                    handleAppReturnedToForeground();
                }
            });
            global.addEventListener('lzh:state-updated', () => {
                syncConfigToNativeOverlay();
            });
        }

        try {
            const capApp = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.App;
            if (capApp && typeof capApp.addListener === 'function') {
                capApp.addListener('appStateChange', (state) => {
                    const plugin = getSystemOverlayPlugin();
                    if (isAndroidNativeEnvironment() && plugin && typeof plugin.setAppForeground === 'function') {
                        plugin.setAppForeground({ inForeground: Boolean(state && state.isActive) }).catch(() => {});
                    }
                    if (state && state.isActive) {
                        handleAppReturnedToForeground();
                    }
                });
            }
        } catch (e) {}
    }

    async function initSystemOverlayBridge() {
        bindOverlayLifecycleListeners();
        const status = await refreshSystemOverlayStatus(true);
        await syncPendingDataFromNativeOverlay();
        if (status.supported && status.granted && !status.running && localStorage.getItem(SYSTEM_OVERLAY_STORAGE_KEY) === 'true') {
            handleSystemOverlayToggle(true);
        } else if (status.running) {
            syncConfigToNativeOverlay();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSystemOverlayBridge);
    } else {
        initSystemOverlayBridge();
    }
})(typeof window !== 'undefined' ? window : globalThis);