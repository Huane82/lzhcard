/**
 * LZHCard - 隱藏式管理員控制台與帳號封鎖/申訴中心 (js/admin-console.js)
 * 1. 管理員點擊左上角 Logo 三次召喚 Admin Console（玩家查詢/編輯、金幣/會員/額度/排位/外觀、Ban 帳號、申訴審核、賽季重置/排程）
 * 2. 遭封鎖帳號於登入及任何系統操作被攔截時顯示不可關閉之封鎖說明視窗，附即時倒數與申訴表單
 */
(function (global) {
    'use strict';

    const DEFAULT_WORKER_BASE = 'https://lzhcard.tomlin980415.workers.dev';
    const RANK_TIER_OPTIONS = [
        '青銅 III',
        '青銅 II',
        '青銅 I',
        '白銀',
        '黃金',
        '白金',
        '鑽石',
        '傳說宗師'
    ];
    const MEMBERSHIP_TIER_OPTIONS = [
        { value: 'free', label: '免費方案 (Free)' },
        { value: 'supporter_30', label: 'Starter 入門會員 (NT$ 30)' },
        { value: 'supporter_90', label: 'Plus 進階會員 (NT$ 90)' },
        { value: 'supporter_180', label: 'Pro 至尊會員 (NT$ 180)' }
    ];

    let activeTab = 'players'; // 'players' | 'appeals' | 'season'
    let allPlayersList = [];
    let playersList = [];
    let playerSearchQuery = '';
    let playerSortBy = 'rankPoints';
    let playersLoadError = '';
    let selectedPlayer = null;
    let appealsList = [];
    let appealsLoadError = '';
    let seasonState = {
        seasonNumber: 1,
        lastResetAt: 0,
        nextScheduledResetAt: 0,
        autoResetEnabled: false
    };
    let isLoadingPlayers = false;
    let isLoadingAppeals = false;
    let banCountdownTimer = null;
    let activeBanState = null;

    function getWorkerBase() {
        return (typeof global.SHARED_BACKEND_URL === 'string' && global.SHARED_BACKEND_URL)
            ? global.SHARED_BACKEND_URL.replace(/\/+$/, '')
            : DEFAULT_WORKER_BASE;
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toast(msg, type = 'info') {
        if (typeof global.showToast === 'function') {
            global.showToast(msg, type);
        }
    }

    function isCurrentUserAdmin() {
        if (global.LZHEntitlements && typeof global.LZHEntitlements.isAdmin === 'function') {
            return Boolean(global.LZHEntitlements.isAdmin(global.userData));
        }
        const u = global.userData;
        return Boolean(u && (u.role === 'admin' || u.isAdmin === true));
    }

    async function getFirebaseToken(forceRefresh = false) {
        try {
            if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
                return await firebase.auth().currentUser.getIdToken(forceRefresh);
            }
        } catch (e) {}
        return '';
    }

    async function adminApiFetch(path, options = {}) {
        let token = await getFirebaseToken(false);
        if (!token) {
            throw new Error('請先登入管理員帳號');
        }

        const executeRequest = async (authToken) => {
            const headers = {
                ...(options.headers || {}),
                Authorization: `Bearer ${authToken}`
            };
            if (options.body && !headers['Content-Type']) {
                headers['Content-Type'] = 'application/json';
            }
            return await fetch(`${getWorkerBase()}${path}`, {
                method: options.method || 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined
            });
        };

        let res = await executeRequest(token);
        if (res.status === 401) {
            const refreshed = await getFirebaseToken(true);
            if (refreshed && refreshed !== token) {
                res = await executeRequest(refreshed);
            }
        }

        let data = {};
        try {
            data = await res.json();
        } catch (e) {}
        if (!res.ok || data.ok === false) {
            throw new Error(data.error || `管理員 API 請求失敗 (HTTP ${res.status})`);
        }
        return data;
    }

    function formatDateTime(ms) {
        const n = Number(ms) || 0;
        if (n <= 0) return '—';
        try {
            const d = new Date(n);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${y}/${m}/${day} ${hh}:${mm}`;
        } catch (e) {
            return '—';
        }
    }

    function formatCountdown(msRemaining) {
        const ms = Math.max(0, Number(msRemaining) || 0);
        if (ms <= 0) return '00:00:00';
        const totalSec = Math.floor(ms / 1000);
        const days = Math.floor(totalSec / 86400);
        const hrs = Math.floor((totalSec % 86400) / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const hms = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return days > 0 ? `${days} 天 ${hms}` : hms;
    }

    function getCatalogCosmetics() {
        const cat = global.PROFILE_COSMETIC_CATALOG || { frames: [], banners: [], titles: [] };
        return {
            frames: Array.isArray(cat.frames) ? cat.frames : [],
            banners: Array.isArray(cat.banners) ? cat.banners : [],
            titles: Array.isArray(cat.titles) ? cat.titles : []
        };
    }

    /* ======================================================================
       1. 管理員控制台 (#adminConsoleModal)
       ====================================================================== */

    async function openAdminConsole() {
        if (!isCurrentUserAdmin()) {
            return false;
        }
        const modal = document.getElementById('adminConsoleModal');
        if (!modal) return false;

        activeTab = 'players';
        selectedPlayer = null;
        playerSearchQuery = '';
        playerSortBy = 'rankPoints';
        playersLoadError = '';

        modal.classList.remove('hidden');
        modal.classList.add('flex');

        renderAdminTabs();
        await Promise.all([
            fetchPlayersList({ resetFilter: true }),
            fetchSeasonState()
        ]);
        renderAdminBody();
        return true;
    }

    function closeAdminConsole() {
        const modal = document.getElementById('adminConsoleModal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        selectedPlayer = null;
    }

    function switchAdminTab(tab) {
        activeTab = ['players', 'appeals', 'season'].includes(tab) ? tab : 'players';
        selectedPlayer = null;
        renderAdminTabs();
        if (activeTab === 'players') {
            if (allPlayersList.length === 0) {
                fetchPlayersList().then(renderAdminBody);
            } else {
                applyClientFilterAndSort();
                renderAdminBody();
            }
        } else if (activeTab === 'appeals') {
            fetchAppealsList().then(renderAdminBody);
        } else {
            fetchSeasonState().then(renderAdminBody);
        }
        renderAdminBody();
    }

    function renderAdminTabs() {
        const tabs = [
            { id: 'players', elId: 'adminTabPlayersBtn' },
            { id: 'appeals', elId: 'adminTabAppealsBtn' },
            { id: 'season', elId: 'adminTabSeasonBtn' }
        ];
        tabs.forEach((t) => {
            const btn = document.getElementById(t.elId);
            if (!btn) return;
            const active = activeTab === t.id;
            btn.className = active
                ? 'flex-1 min-h-[42px] py-2 px-3 rounded-xl text-xs font-extrabold bg-rose-600 text-white shadow-xs cursor-pointer transition'
                : 'flex-1 min-h-[42px] py-2 px-3 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer transition';
        });
    }

    function applyClientFilterAndSort() {
        const q = String(playerSearchQuery || '').trim().toLowerCase();
        const sortBy = String(playerSortBy || 'rankPoints').trim();

        let filtered = allPlayersList.slice();
        if (q) {
            filtered = filtered.filter((p) => {
                return (
                    String(p.uid || '').toLowerCase().includes(q) ||
                    String(p.email || '').toLowerCase().includes(q) ||
                    String(p.nickname || '').toLowerCase().includes(q) ||
                    String(p.nicknameLower || '').toLowerCase().includes(q)
                );
            });
        }

        filtered.sort((a, b) => {
            const pa = a.progression || { level: 1, xp: 0, rankPoints: 0 };
            const pb = b.progression || { level: 1, xp: 0, rankPoints: 0 };
            if (sortBy === 'level') {
                return ((pb.level || 1) - (pa.level || 1)) || ((pb.xp || 0) - (pa.xp || 0));
            }
            if (sortBy === 'coins') {
                return (Number(b.coins) || 0) - (Number(a.coins) || 0);
            }
            if (sortBy === 'banned') {
                return Number(Boolean(b.ban && b.ban.isBanned)) - Number(Boolean(a.ban && a.ban.isBanned));
            }
            if (sortBy === 'lastActive') {
                return (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0);
            }
            return ((pb.rankPoints || 0) - (pa.rankPoints || 0)) || ((pb.level || 1) - (pa.level || 1));
        });

        playersList = filtered;
        if (selectedPlayer) {
            selectedPlayer = allPlayersList.find((p) => p.uid === selectedPlayer.uid) || null;
        }
    }

    function updatePlayersRowsDomOnly() {
        const rowsBox = document.getElementById('adminPlayersRowsContainer');
        const countEl = document.getElementById('adminPlayersCountLabel');
        if (!rowsBox) {
            renderAdminBody();
            return;
        }
        if (countEl) {
            const totalText = allPlayersList.length !== playersList.length
                ? `顯示 ${playersList.length} / ${allPlayersList.length} 位玩家（點擊玩家即可修改數值與封鎖控制）`
                : `共 ${playersList.length} 位玩家（點擊玩家即可修改數值與封鎖控制）`;
            countEl.textContent = totalText;
        }
        rowsBox.innerHTML = buildPlayerRowsMarkup();
        bindPlayerRowClicks();
    }

    async function fetchPlayersList({ resetFilter = false } = {}) {
        if (resetFilter) {
            playerSearchQuery = '';
        }
        isLoadingPlayers = true;
        playersLoadError = '';
        renderAdminBody();
        try {
            const params = new URLSearchParams();
            params.set('sort', playerSortBy || 'rankPoints');
            const data = await adminApiFetch(`/admin/players?${params.toString()}`);
            allPlayersList = Array.isArray(data.players) ? data.players : [];
            applyClientFilterAndSort();
        } catch (err) {
            playersLoadError = err.message || '載入玩家列表失敗';
            toast(playersLoadError, 'error');
        } finally {
            isLoadingPlayers = false;
            renderAdminBody();
        }
    }

    async function fetchAppealsList() {
        isLoadingAppeals = true;
        appealsLoadError = '';
        renderAdminBody();
        try {
            const data = await adminApiFetch('/admin/appeals');
            appealsList = Array.isArray(data.appeals) ? data.appeals : [];
        } catch (err) {
            appealsLoadError = err.message || '載入申訴紀錄失敗';
            toast(appealsLoadError, 'error');
        } finally {
            isLoadingAppeals = false;
            renderAdminBody();
        }
    }

    async function fetchSeasonState() {
        try {
            const res = await fetch(`${getWorkerBase()}/season/status`);
            const data = await res.json();
            if (data && data.ok && data.season) {
                seasonState = data.season;
            }
        } catch (e) {}
    }

    function renderAdminBody() {
        const body = document.getElementById('adminConsoleBody');
        if (!body) return;

        if (activeTab === 'players') {
            if (selectedPlayer) {
                body.innerHTML = renderPlayerEditorHtml(selectedPlayer);
                bindPlayerEditorEvents(selectedPlayer);
            } else {
                body.innerHTML = renderPlayersListHtml();
                bindPlayersListEvents();
            }
            return;
        }

        if (activeTab === 'appeals') {
            body.innerHTML = renderAppealsHtml();
            bindAppealsEvents();
            return;
        }

        body.innerHTML = renderSeasonHtml();
        bindSeasonEvents();
    }

    function buildPlayerRowsMarkup() {
        if (isLoadingPlayers && allPlayersList.length === 0) {
            return `<div class="py-10 text-center text-xs text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>正在讀取全站玩家資料...</div>`;
        }
        if (playersLoadError && allPlayersList.length === 0) {
            return `
                <div class="p-6 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-center space-y-2.5">
                    <div class="text-xs font-extrabold text-rose-600 dark:text-rose-300">⚠️ 無法取得玩家資料：${escapeHtml(playersLoadError)}</div>
                    <button type="button" id="adminPlayersRetryBtn" class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">🔄 重新載入玩家列表</button>
                </div>
            `;
        }
        if (playersList.length === 0) {
            return `<div class="py-10 text-center text-xs text-slate-400">${allPlayersList.length > 0 ? '找不到符合搜尋關鍵字的玩家' : '目前尚無玩家資料'}</div>`;
        }
        return playersList.map((p) => {
            const isBanned = Boolean(p.ban && p.ban.isBanned);
            const tier = (p.membership && p.membership.tier) || 'free';
            const prog = p.progression || { level: 1, xp: 0, rankPoints: 0, rankTier: '青銅 III' };
            return `
                <button type="button" data-admin-select-uid="${escapeHtml(p.uid)}"
                    class="w-full p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/70 hover:bg-rose-50/60 dark:hover:bg-slate-800 border ${isBanned ? 'border-rose-400 dark:border-rose-700' : 'border-slate-200 dark:border-slate-700'} text-left transition flex items-center justify-between gap-3 cursor-pointer">
                    <div class="min-w-0 space-y-1">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-xs font-extrabold text-slate-900 dark:text-white truncate">${escapeHtml(p.nickname || '學習者')}</span>
                            ${p.isAdmin ? '<span class="px-1.5 py-0.5 rounded-md text-[10px] font-black bg-rose-600 text-white">ADMIN</span>' : ''}
                            ${isBanned ? '<span class="px-1.5 py-0.5 rounded-md text-[10px] font-black bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border border-rose-300 dark:border-rose-700">🚫 已封鎖</span>' : ''}
                            ${tier !== 'free' ? `<span class="px-1.5 py-0.5 rounded-md text-[10px] font-extrabold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 uppercase">${escapeHtml(tier)}</span>` : ''}
                        </div>
                        <div class="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">${escapeHtml(p.email || p.uid)}</div>
                        <div class="text-[11px] text-slate-600 dark:text-slate-300 font-semibold">
                            🪙 ${Number(p.coins || 0).toLocaleString()} · Lv.${prog.level} (${prog.xp} XP) · 🏆 ${escapeHtml(prog.rankTier)} (${prog.rankPoints} 分)
                        </div>
                    </div>
                    <i class="fa-solid fa-chevron-right text-slate-400 shrink-0 text-xs"></i>
                </button>
            `;
        }).join('');
    }

    function renderPlayersListHtml() {
        const searchVal = playerSearchQuery || '';
        const sortVal = playerSortBy || 'rankPoints';
        const totalText = allPlayersList.length !== playersList.length
            ? `顯示 ${playersList.length} / ${allPlayersList.length} 位玩家（點擊玩家即可修改數值與封鎖控制）`
            : `共 ${playersList.length} 位玩家（點擊玩家即可修改數值與封鎖控制）`;

        return `
            <div class="space-y-3">
                <div class="flex flex-col sm:flex-row gap-2">
                    <div class="flex-1 flex items-center gap-1.5">
                        <input type="text" id="adminPlayerSearchInput" value="${escapeHtml(searchVal)}" placeholder="輸入暱稱、Email 或 UID 即時篩選..." class="flex-1 min-w-0 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs outline-none focus:ring-2 focus:ring-rose-500">
                        <button type="button" id="adminPlayerRefreshBtn" title="重新從伺服器載入" class="min-h-[38px] px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer shrink-0">🔄 更新</button>
                    </div>
                    <select id="adminPlayerSortSelect" class="px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none cursor-pointer">
                        <option value="rankPoints" ${sortVal === 'rankPoints' ? 'selected' : ''}>排序：排位積分高到低</option>
                        <option value="level" ${sortVal === 'level' ? 'selected' : ''}>排序：等級經驗高到低</option>
                        <option value="coins" ${sortVal === 'coins' ? 'selected' : ''}>排序：金幣數高到低</option>
                        <option value="banned" ${sortVal === 'banned' ? 'selected' : ''}>排序：封鎖帳號優先</option>
                        <option value="lastActive" ${sortVal === 'lastActive' ? 'selected' : ''}>排序：最近活躍時間</option>
                    </select>
                </div>
                <div id="adminPlayersCountLabel" class="text-[11px] font-bold text-slate-500 dark:text-slate-400">${escapeHtml(totalText)}</div>
                <div id="adminPlayersRowsContainer" class="space-y-2">${buildPlayerRowsMarkup()}</div>
            </div>
        `;
    }

    function bindPlayerRowClicks() {
        const retryBtn = document.getElementById('adminPlayersRetryBtn');
        if (retryBtn) {
            retryBtn.onclick = () => fetchPlayersList();
        }
        document.querySelectorAll('[data-admin-select-uid]').forEach((btn) => {
            btn.onclick = () => {
                const uid = btn.getAttribute('data-admin-select-uid');
                selectedPlayer = allPlayersList.find((p) => p.uid === uid) || playersList.find((p) => p.uid === uid) || null;
                renderAdminBody();
            };
        });
    }

    function bindPlayersListEvents() {
        const refreshBtn = document.getElementById('adminPlayerRefreshBtn');
        const searchInp = document.getElementById('adminPlayerSearchInput');
        const sortSel = document.getElementById('adminPlayerSortSelect');

        if (refreshBtn) {
            refreshBtn.onclick = () => fetchPlayersList();
        }
        if (searchInp) {
            searchInp.oninput = () => {
                playerSearchQuery = searchInp.value || '';
                applyClientFilterAndSort();
                updatePlayersRowsDomOnly();
            };
            searchInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    playerSearchQuery = searchInp.value || '';
                    applyClientFilterAndSort();
                    updatePlayersRowsDomOnly();
                }
            };
        }
        if (sortSel) {
            sortSel.onchange = () => {
                playerSortBy = sortSel.value || 'rankPoints';
                applyClientFilterAndSort();
                updatePlayersRowsDomOnly();
            };
        }
        bindPlayerRowClicks();
    }

    function renderPlayerEditorHtml(player) {
        const prog = player.progression || {};
        const mem = player.membership || {};
        const cos = player.cosmetics || {};
        const unlockedFrames = new Set(Array.isArray(cos.unlockedFrames) ? cos.unlockedFrames : []);
        const unlockedBanners = new Set(Array.isArray(cos.unlockedBanners) ? cos.unlockedBanners : []);
        const unlockedTitles = new Set(Array.isArray(cos.unlockedTitles) ? cos.unlockedTitles : []);
        const purchasedSet = new Set(Array.isArray(player.purchasedCosmetics) ? player.purchasedCosmetics : []);
        const catalog = getCatalogCosmetics();
        const isBanned = Boolean(player.ban && player.ban.isBanned);
        const remDays = mem.expiresAt > Date.now() ? Math.max(1, Math.ceil((mem.expiresAt - Date.now()) / 86400000)) : 0;

        const renderCosGroup = (title, items, selectedSet, attrName) => `
            <div class="space-y-1.5">
                <div class="text-[11px] font-extrabold text-slate-600 dark:text-slate-300">${escapeHtml(title)}</div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    ${items.map((item) => {
                        const checked = selectedSet.has(item.id) || purchasedSet.has(item.id);
                        return `
                            <label class="flex items-center gap-1.5 p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-bold cursor-pointer">
                                <input type="checkbox" data-${attrName}="${escapeHtml(item.id)}" ${checked ? 'checked' : ''} class="accent-rose-600">
                                <span class="truncate">${escapeHtml(item.name || item.id)}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        return `
            <div class="space-y-4">
                <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-700">
                    <button type="button" id="adminBackToPlayersBtn" class="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-xs font-bold cursor-pointer">
                        <i class="fa-solid fa-chevron-left mr-1"></i>返回列表
                    </button>
                    <div class="text-right min-w-0">
                        <div class="text-sm font-black text-slate-900 dark:text-white truncate">${escapeHtml(player.nickname)}</div>
                        <div class="text-[10.5px] font-mono text-slate-400 truncate">${escapeHtml(player.email || player.uid)}</div>
                    </div>
                </div>

                <!-- 數值與會員編修 -->
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="text-xs font-black text-slate-800 dark:text-slate-100">數值、會員與 AI 額度設定</div>
                    <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                        <label class="space-y-1 font-bold">
                            <span>🪙 金幣數量</span>
                            <input type="number" id="adminEditCoins" min="0" value="${Number(player.coins || 0)}" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        </label>
                        <label class="space-y-1 font-bold">
                            <span>👑 會員方案</span>
                            <select id="adminEditMemTier" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                                ${MEMBERSHIP_TIER_OPTIONS.map((opt) => `<option value="${opt.value}" ${(mem.tier || 'free') === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                            </select>
                        </label>
                        <label class="space-y-1 font-bold">
                            <span>📅 有效天數 (0=清除)</span>
                            <input type="number" id="adminEditMemDays" min="0" max="3650" value="${remDays || ((mem.tier && mem.tier !== 'free') ? 30 : 0)}" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        </label>
                        <label class="space-y-1 font-bold">
                            <span>⭐ 等級 (Level)</span>
                            <input type="number" id="adminEditLevel" min="1" value="${Math.max(1, Number(prog.level) || 1)}" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        </label>
                        <label class="space-y-1 font-bold">
                            <span>⚡ 經驗值 (XP)</span>
                            <input type="number" id="adminEditXp" min="0" value="${Math.max(0, Number(prog.xp) || 0)}" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        </label>
                        <label class="space-y-1 font-bold">
                            <span>🏆 排位積分</span>
                            <input type="number" id="adminEditRankPoints" min="0" value="${Math.max(0, Number(prog.rankPoints) || 0)}" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        </label>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                        <label class="space-y-1 font-bold">
                            <span>🎖️ 牌位名稱</span>
                            <select id="adminEditRankTier" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                                ${RANK_TIER_OPTIONS.map((rt) => `<option value="${escapeHtml(rt)}" ${(prog.rankTier || '青銅 III') === rt ? 'selected' : ''}>${escapeHtml(rt)}</option>`).join('')}
                            </select>
                        </label>
                        <div class="flex items-end">
                            <button type="button" id="adminResetPlayerQuotaBtn" class="w-full min-h-[38px] px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-extrabold cursor-pointer">
                                🔄 立即重置今日與本月 AI 額度
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 外觀解鎖狀態 -->
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="text-xs font-black text-slate-800 dark:text-slate-100">自訂外觀解鎖狀態</div>
                    ${renderCosGroup('頭像框 (Frames)', catalog.frames, unlockedFrames, 'admin-frame')}
                    ${renderCosGroup('背景橫幅 (Banners)', catalog.banners, unlockedBanners, 'admin-banner')}
                    ${renderCosGroup('稱號 (Titles)', catalog.titles, unlockedTitles, 'admin-title')}
                </div>

                <button type="button" id="adminSavePlayerBtn" class="w-full min-h-[44px] py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-black shadow-md cursor-pointer">
                    💾 儲存玩家所有數值與外觀變更
                </button>

                <!-- 帳號封鎖 / 解封 -->
                <div class="p-3.5 rounded-2xl border-2 ${isBanned ? 'border-rose-400 bg-rose-50/70 dark:bg-rose-950/30' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/70'} space-y-3">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-xs font-black text-rose-600 dark:text-rose-400">🛡️ 帳號封鎖管理</span>
                        <span class="text-[11px] font-bold ${isBanned ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-400'}">
                            ${isBanned ? (player.ban.expiresAt > 0 ? `封鎖中 · 到期：${formatDateTime(player.ban.expiresAt)}` : '永久封鎖中') : '目前狀態正常'}
                        </span>
                    </div>
                    ${isBanned && player.ban.reason ? `<div class="text-xs font-bold text-rose-700 dark:text-rose-300">目前封鎖原因：${escapeHtml(player.ban.reason)}</div>` : ''}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        <input type="text" id="adminBanReasonInput" value="${escapeHtml((player.ban && player.ban.reason) || '')}" placeholder="輸入封鎖原因（玩家登入時可見）..." class="px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                        <select id="adminBanDurationSelect" class="px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">
                            <option value="60">封鎖 1 小時 (60 分鐘)</option>
                            <option value="1440">封鎖 24 小時 (1 天)</option>
                            <option value="10080" selected>封鎖 7 天</option>
                            <option value="43200">封鎖 30 天</option>
                            <option value="0">永久封鎖</option>
                        </select>
                    </div>
                    <div class="flex items-center gap-2">
                        <button type="button" id="adminBanSubmitBtn" class="flex-1 min-h-[42px] py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">
                            🚫 封鎖此玩家帳號
                        </button>
                        ${isBanned ? `
                            <button type="button" id="adminUnbanSubmitBtn" class="flex-1 min-h-[42px] py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
                                ✅ 立即解除封鎖
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    function bindPlayerEditorEvents(player) {
        const backBtn = document.getElementById('adminBackToPlayersBtn');
        if (backBtn) {
            backBtn.onclick = () => {
                selectedPlayer = null;
                renderAdminBody();
            };
        }

        const resetQuotaBtn = document.getElementById('adminResetPlayerQuotaBtn');
        if (resetQuotaBtn) {
            resetQuotaBtn.onclick = async () => {
                resetQuotaBtn.disabled = true;
                try {
                    const res = await adminApiFetch('/admin/player/update', {
                        method: 'POST',
                        body: { targetUid: player.uid, resetQuota: true }
                    });
                    if (res.player) {
                        selectedPlayer = res.player;
                        allPlayersList = allPlayersList.map((p) => (p.uid === res.player.uid ? res.player : p));
                        applyClientFilterAndSort();
                    }
                    toast('已重置該玩家今日與本月 AI 額度', 'success');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '重置額度失敗', 'error');
                } finally {
                    resetQuotaBtn.disabled = false;
                }
            };
        }

        const saveBtn = document.getElementById('adminSavePlayerBtn');
        if (saveBtn) {
            saveBtn.onclick = async () => {
                saveBtn.disabled = true;
                try {
                    const coins = Math.max(0, Math.floor(Number(document.getElementById('adminEditCoins')?.value) || 0));
                    const tier = document.getElementById('adminEditMemTier')?.value || 'free';
                    const days = Math.max(0, Math.floor(Number(document.getElementById('adminEditMemDays')?.value) || 0));
                    const level = Math.max(1, Math.floor(Number(document.getElementById('adminEditLevel')?.value) || 1));
                    const xp = Math.max(0, Math.floor(Number(document.getElementById('adminEditXp')?.value) || 0));
                    const rankPoints = Math.max(0, Math.floor(Number(document.getElementById('adminEditRankPoints')?.value) || 0));
                    const rankTier = document.getElementById('adminEditRankTier')?.value || '青銅 III';

                    const unlockedFrames = Array.from(document.querySelectorAll('[data-admin-frame]:checked')).map((el) => el.getAttribute('data-admin-frame'));
                    const unlockedBanners = Array.from(document.querySelectorAll('[data-admin-banner]:checked')).map((el) => el.getAttribute('data-admin-banner'));
                    const unlockedTitles = Array.from(document.querySelectorAll('[data-admin-title]:checked')).map((el) => el.getAttribute('data-admin-title'));
                    const catalog = getCatalogCosmetics();
                    const paidIds = new Set([
                        ...catalog.frames.filter((c) => c.paidOnly).map((c) => c.id),
                        ...catalog.banners.filter((c) => c.paidOnly).map((c) => c.id),
                        ...catalog.titles.filter((c) => c.paidOnly).map((c) => c.id)
                    ]);
                    const purchasedCosmetics = [...unlockedFrames, ...unlockedBanners, ...unlockedTitles].filter((id) => paidIds.has(id));

                    const res = await adminApiFetch('/admin/player/update', {
                        method: 'POST',
                        body: {
                            targetUid: player.uid,
                            coins,
                            membership: { tier, days },
                            progression: { level, xp, rankPoints, rankTier },
                            cosmetics: { unlockedFrames, unlockedBanners, unlockedTitles },
                            purchasedCosmetics
                        }
                    });
                    if (res.player) {
                        selectedPlayer = res.player;
                        allPlayersList = allPlayersList.map((p) => (p.uid === res.player.uid ? res.player : p));
                        applyClientFilterAndSort();
                    }
                    toast('已儲存玩家資料與外觀設定', 'success');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '儲存玩家資料失敗', 'error');
                } finally {
                    saveBtn.disabled = false;
                }
            };
        }

        const banBtn = document.getElementById('adminBanSubmitBtn');
        if (banBtn) {
            banBtn.onclick = async () => {
                const reason = (document.getElementById('adminBanReasonInput')?.value || '').trim() || '違反社群或服務使用規範';
                const durationMinutes = Math.max(0, Number(document.getElementById('adminBanDurationSelect')?.value) || 0);
                const label = durationMinutes === 0 ? '永久封鎖' : `${durationMinutes} 分鐘`;
                const ok = typeof global.lzhConfirm === 'function'
                    ? await global.lzhConfirm(`確定要封鎖玩家「${player.nickname}」嗎？\n封鎖時長：${label}\n封鎖原因：${reason}`)
                    : true;
                if (!ok) return;

                banBtn.disabled = true;
                try {
                    const res = await adminApiFetch('/admin/player/ban', {
                        method: 'POST',
                        body: {
                            targetUid: player.uid,
                            action: 'ban',
                            reason,
                            durationMinutes
                        }
                    });
                    if (res.player) {
                        selectedPlayer = res.player;
                        allPlayersList = allPlayersList.map((p) => (p.uid === res.player.uid ? res.player : p));
                        applyClientFilterAndSort();
                    }
                    toast('已封鎖該玩家帳號', 'warning');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '封鎖操作失敗', 'error');
                } finally {
                    banBtn.disabled = false;
                }
            };
        }

        const unbanBtn = document.getElementById('adminUnbanSubmitBtn');
        if (unbanBtn) {
            unbanBtn.onclick = async () => {
                unbanBtn.disabled = true;
                try {
                    const res = await adminApiFetch('/admin/player/ban', {
                        method: 'POST',
                        body: { targetUid: player.uid, action: 'unban' }
                    });
                    if (res.player) {
                        selectedPlayer = res.player;
                        allPlayersList = allPlayersList.map((p) => (p.uid === res.player.uid ? res.player : p));
                        applyClientFilterAndSort();
                    }
                    toast('已解除該玩家封鎖', 'success');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '解封失敗', 'error');
                } finally {
                    unbanBtn.disabled = false;
                }
            };
        }
    }

    function renderAppealsHtml() {
        if (isLoadingAppeals && appealsList.length === 0) {
            return `<div class="py-10 text-center text-xs text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>正在讀取帳號申訴紀錄...</div>`;
        }
        if (appealsLoadError && appealsList.length === 0) {
            return `
                <div class="p-6 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-center space-y-2.5">
                    <div class="text-xs font-extrabold text-rose-600 dark:text-rose-300">⚠️ 無法取得申訴紀錄：${escapeHtml(appealsLoadError)}</div>
                    <button type="button" id="adminAppealsRetryBtn" class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">🔄 重新載入申訴紀錄</button>
                </div>
            `;
        }
        if (appealsList.length === 0) {
            return `<div class="py-10 text-center text-xs text-slate-400">目前沒有任何玩家封鎖申訴案件</div>`;
        }
        return `
            <div class="space-y-2.5">
                ${appealsList.map((a) => {
                    const badgeCls = a.status === 'approved'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : (a.status === 'rejected'
                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300');
                    const statusLabel = a.status === 'approved' ? '已核准解封' : (a.status === 'rejected' ? '已駁回' : '待審核');
                    return `
                        <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-2 text-xs">
                            <div class="flex items-center justify-between gap-2">
                                <div class="min-w-0">
                                    <span class="font-extrabold text-slate-900 dark:text-white">${escapeHtml(a.nickname || '玩家')}</span>
                                    <span class="ml-1.5 font-mono text-[10.5px] text-slate-400">${escapeHtml(a.email || a.uid)}</span>
                                </div>
                                <span class="px-2 py-0.5 rounded-full text-[10px] font-black shrink-0 ${badgeCls}">${statusLabel}</span>
                            </div>
                            <div class="text-[11px] text-rose-600 dark:text-rose-400 font-bold">原封鎖原因：${escapeHtml(a.banReason || '未填寫')}</div>
                            <div class="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">${escapeHtml(a.message)}</div>
                            <div class="text-[10px] text-slate-400">送出時間：${formatDateTime(a.createdAt)}</div>
                            ${a.status === 'pending' ? `
                                <div class="flex items-center gap-2 pt-1">
                                    <button type="button" data-appeal-action="approve" data-appeal-id="${escapeHtml(a.id)}" class="flex-1 min-h-[38px] py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">✅ 核准並解封</button>
                                    <button type="button" data-appeal-action="reject" data-appeal-id="${escapeHtml(a.id)}" class="flex-1 min-h-[38px] py-1.5 rounded-xl bg-slate-200 dark:bg-slate-700 hover:bg-rose-600 hover:text-white text-slate-700 dark:text-slate-200 text-xs font-extrabold cursor-pointer">✖ 駁回申訴</button>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    function bindAppealsEvents() {
        const retryBtn = document.getElementById('adminAppealsRetryBtn');
        if (retryBtn) {
            retryBtn.onclick = () => fetchAppealsList();
        }
        document.querySelectorAll('[data-appeal-action]').forEach((btn) => {
            btn.onclick = async () => {
                const appealId = btn.getAttribute('data-appeal-id');
                const decision = btn.getAttribute('data-appeal-action');
                btn.disabled = true;
                try {
                    await adminApiFetch('/admin/appeal/resolve', {
                        method: 'POST',
                        body: { appealId, decision }
                    });
                    toast(decision === 'approve' ? '已核准申訴並立即解封帳號' : '已駁回該筆申訴', 'success');
                    await fetchAppealsList();
                } catch (err) {
                    toast(err.message || '審核申訴失敗', 'error');
                } finally {
                    btn.disabled = false;
                }
            };
        });
    }

    function renderSeasonHtml() {
        const sNum = Math.max(1, Number(seasonState.seasonNumber) || 1);
        const lastResetTxt = seasonState.lastResetAt > 0 ? formatDateTime(seasonState.lastResetAt) : '尚未重置';
        const schedTxt = seasonState.autoResetEnabled && seasonState.nextScheduledResetAt > Date.now()
            ? `${formatDateTime(seasonState.nextScheduledResetAt)}（剩餘 ${formatCountdown(seasonState.nextScheduledResetAt - Date.now())}）`
            : '目前未排程自動重置';

        return `
            <div class="space-y-4 text-xs">
                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="font-black text-sm text-slate-900 dark:text-white">🏆 目前賽季：第 ${sNum} 賽季</span>
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">S${sNum}</span>
                    </div>
                    <div class="text-slate-600 dark:text-slate-300">上次賽季重置時間：<span class="font-bold">${escapeHtml(lastResetTxt)}</span></div>
                    <div class="text-slate-600 dark:text-slate-300">排程自動重置時間：<span class="font-bold text-amber-600 dark:text-amber-400">${escapeHtml(schedTxt)}</span></div>
                </div>

                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="font-black text-slate-800 dark:text-slate-100">📅 設定自動賽季重置排程</div>
                    <p class="text-[11px] text-slate-500 dark:text-slate-400">可設定於幾天後自動重置賽季（例如 90 天後）。玩家在排行榜上方將能即時看到賽季重置倒數時間。</p>
                    <div class="flex items-center gap-2">
                        <label class="flex items-center gap-1.5 font-bold shrink-0">
                            <span>於</span>
                            <input type="number" id="adminSeasonScheduleDaysInput" min="1" max="3650" value="90" class="w-20 px-2.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold text-center">
                            <span>天後自動重置</span>
                        </label>
                        <button type="button" id="adminScheduleSeasonBtn" class="flex-1 min-h-[40px] px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold cursor-pointer">設定排程</button>
                        ${seasonState.autoResetEnabled ? `<button type="button" id="adminClearSeasonScheduleBtn" class="min-h-[40px] px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold cursor-pointer">取消排程</button>` : ''}
                    </div>
                </div>

                <div class="p-4 rounded-2xl bg-rose-50/70 dark:bg-rose-950/30 border-2 border-rose-300 dark:border-rose-700 space-y-2.5">
                    <div class="font-black text-rose-700 dark:text-rose-300">⚠️ 立即手動重置賽季</div>
                    <p class="text-[11px] text-rose-700/90 dark:text-rose-200 leading-relaxed">
                        執行後將清空全站所有玩家的<strong>排位積分、牌位、等級、經驗與對戰勝敗</strong>；<strong>金幣、個人字庫與已解鎖外觀將 100% 保留</strong>。
                    </p>
                    <button type="button" id="adminResetSeasonNowBtn" class="w-full min-h-[44px] py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black shadow-md cursor-pointer">
                        🔄 立即結束本賽季並重置排位與等級經驗
                    </button>
                </div>
            </div>
        `;
    }

    function bindSeasonEvents() {
        const schedBtn = document.getElementById('adminScheduleSeasonBtn');
        const clrBtn = document.getElementById('adminClearSeasonScheduleBtn');
        const nowBtn = document.getElementById('adminResetSeasonNowBtn');

        if (schedBtn) {
            schedBtn.onclick = async () => {
                const days = Math.max(1, Math.floor(Number(document.getElementById('adminSeasonScheduleDaysInput')?.value) || 90));
                schedBtn.disabled = true;
                try {
                    const res = await adminApiFetch('/admin/season/schedule', {
                        method: 'POST',
                        body: { days }
                    });
                    if (res.season) seasonState = res.season;
                    toast(`已設定於 ${days} 天後自動重置賽季`, 'success');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '設定排程失敗', 'error');
                } finally {
                    schedBtn.disabled = false;
                }
            };
        }

        if (clrBtn) {
            clrBtn.onclick = async () => {
                clrBtn.disabled = true;
                try {
                    const res = await adminApiFetch('/admin/season/schedule', {
                        method: 'POST',
                        body: { clear: true }
                    });
                    if (res.season) seasonState = res.season;
                    toast('已取消賽季自動重置排程', 'info');
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '取消排程失敗', 'error');
                } finally {
                    clrBtn.disabled = false;
                }
            };
        }

        if (nowBtn) {
            nowBtn.onclick = async () => {
                const ok = typeof global.lzhConfirm === 'function'
                    ? await global.lzhConfirm('確定要立即重置賽季嗎？所有玩家的排位、等級與經驗將清空並進入下一賽季；金幣、字庫與外觀將完整保留。')
                    : false;
                if (!ok) return;

                nowBtn.disabled = true;
                nowBtn.textContent = '正在重置全站賽季數據...';
                try {
                    const res = await adminApiFetch('/admin/season/reset', {
                        method: 'POST',
                        body: {}
                    });
                    if (res.season) seasonState = res.season;
                    toast(`已完成賽季重置（共更新 ${res.resetUsersCount || 0} 位玩家），已進入第 ${seasonState.seasonNumber} 賽季`, 'success');
                    if (typeof global.loadAndRenderGlobalLeaderboard === 'function') {
                        global.loadAndRenderGlobalLeaderboard(null, { force: true });
                    }
                    renderAdminBody();
                } catch (err) {
                    toast(err.message || '賽季重置失敗', 'error');
                } finally {
                    nowBtn.disabled = false;
                    renderAdminBody();
                }
            };
        }
    }

    /* ======================================================================
       2. 封鎖公告與申訴系統 (#banNoticeModal)
       ====================================================================== */

    function stopBanCountdown() {
        if (banCountdownTimer) {
            clearInterval(banCountdownTimer);
            banCountdownTimer = null;
        }
    }

    function showBanNoticeModal(banInfo = {}) {
        const modal = document.getElementById('banNoticeModal');
        if (!modal) {
            global.__pendingBanNotice = banInfo;
            return false;
        }
        global.__pendingBanNotice = null;
        activeBanState = banInfo || {};

        const reasonEl = document.getElementById('banNoticeReasonText');
        const expiryEl = document.getElementById('banNoticeExpiryText');
        const countdownEl = document.getElementById('banNoticeCountdownText');
        const statusMsgEl = document.getElementById('banAppealStatusMsg');

        if (reasonEl) {
            reasonEl.textContent = String(banInfo.reason || '違反社群或服務使用規範');
        }
        const expiresAt = Number(banInfo.expiresAt) || 0;
        if (expiryEl) {
            expiryEl.textContent = expiresAt > 0
                ? `解鎖時間：${formatDateTime(expiresAt)}`
                : '封鎖期限：永久封鎖（可透過下方表單提交申訴）';
        }
        if (statusMsgEl) {
            statusMsgEl.classList.add('hidden');
            statusMsgEl.textContent = '';
        }

        stopBanCountdown();
        if (countdownEl) {
            if (expiresAt > 0) {
                const tick = async () => {
                    const rem = expiresAt - Date.now();
                    if (rem <= 0) {
                        countdownEl.textContent = '封鎖期限已屆滿，正在自動解鎖...';
                        stopBanCountdown();
                        try {
                            const token = await getFirebaseToken();
                            if (token) {
                                const res = await fetch(`${getWorkerBase()}/ban/status`, {
                                    headers: { Authorization: `Bearer ${token}` }
                                });
                                const data = await res.json().catch(() => ({}));
                                if (data && data.ok && (!data.ban || !data.ban.isBanned)) {
                                    hideBanNoticeModal();
                                    toast('您的帳號封鎖時間已屆滿並已自動解鎖，請重新整理頁面。', 'success');
                                    global.location?.reload();
                                }
                            }
                        } catch (e) {}
                        return;
                    }
                    countdownEl.textContent = `距離自動解鎖還有：${formatCountdown(rem)}`;
                };
                tick();
                banCountdownTimer = setInterval(tick, 1000);
            } else {
                countdownEl.textContent = '目前為永久封鎖狀態';
            }
        }

        const submitBtn = document.getElementById('banAppealSubmitBtn');
        if (submitBtn) {
            submitBtn.onclick = submitBanAppealFromModal;
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        return true;
    }

    function hideBanNoticeModal() {
        stopBanCountdown();
        const modal = document.getElementById('banNoticeModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    async function submitBanAppealFromModal() {
        const inp = document.getElementById('banAppealMessageInput');
        const btn = document.getElementById('banAppealSubmitBtn');
        const statusMsgEl = document.getElementById('banAppealStatusMsg');
        const message = (inp?.value || '').trim();
        if (!message) {
            toast('請先填寫申訴原因或說明內容', 'warning');
            return;
        }
        const token = await getFirebaseToken();
        if (!token) {
            toast('請保持登入狀態再送出申訴', 'warning');
            return;
        }
        if (btn) btn.disabled = true;
        try {
            const res = await fetch(`${getWorkerBase()}/ban/appeal`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ message })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || '送出申訴失敗');
            }
            if (inp) inp.value = '';
            if (statusMsgEl) {
                statusMsgEl.textContent = '✅ 申訴已送出，管理員將會儘速審核。';
                statusMsgEl.className = 'text-xs font-bold text-emerald-600 dark:text-emerald-400';
                statusMsgEl.classList.remove('hidden');
            }
            toast('申訴已送出', 'success');
        } catch (err) {
            if (statusMsgEl) {
                statusMsgEl.textContent = `❌ ${err.message || '送出申訴失敗'}`;
                statusMsgEl.className = 'text-xs font-bold text-rose-600 dark:text-rose-400';
                statusMsgEl.classList.remove('hidden');
            }
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    global.AdminConsole = {
        open: openAdminConsole,
        close: closeAdminConsole,
        switchTab: switchAdminTab,
        showBanNoticeModal,
        hideBanNoticeModal
    };

    const bootCheckPending = () => {
        if (global.__pendingBanNotice) {
            showBanNoticeModal(global.__pendingBanNotice);
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootCheckPending);
    } else {
        bootCheckPending();
    }
})(typeof window !== 'undefined' ? window : globalThis);
