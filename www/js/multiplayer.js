/**
 * LZHCard - 即時連線對戰、排位賽、幽靈影子競速與四人打王共鬥模組 (MultiplayerEngine)
 * Part 4: RTDB 1v1 Tug-of-War, Ranked Matchmaking, 10-Q Ghost Shadow Race, 4-Player Co-op Raid
 */
(function (global) {
    'use strict';

    const RANK_TIERS = [
        { min: 1200, name: '傳說宗師' },
        { min: 900, name: '鑽石' },
        { min: 650, name: '白金' },
        { min: 450, name: '黃金' },
        { min: 300, name: '白銀' },
        { min: 200, name: '青銅 I' },
        { min: 100, name: '青銅 II' },
        { min: 0, name: '青銅 III' }
    ];

    let activeModalTab = 'duel';
    let pendingDuelCode = null;
    let activeDuelCode = null;
    let activeDuelRef = null;
    let activeDuelListener = null;
    let activeDuelData = null;
    let duelAnswerLocked = false;
    let duelFeedbackHold = null;
    let duelDeferredFinishRoom = null;
    let duelTimeline = [];
    let duelStartMs = 0;
    const settledDuelCodes = new Set();

    let activeQueueRef = null;
    let activeQueueListener = null;
    let matchmakingScanRef = null;
    let matchmakingScanListener = null;
    let matchmakingScanTimer = null;
    let matchmakingHeartbeatTimer = null;
    let matchmakingEnteredAt = 0;
    let isClaimingOpponent = false;
    let isMatchmaking = false;

    let activeRaidCode = null;
    let activeRaidRef = null;
    let activeRaidListener = null;
    let activeRaidData = null;
    let raidQuestionIdx = 0;
    let raidPersonalDamage = 0;
    let raidPersonalCorrect = 0;
    let raidAnswerLocked = false;
    let raidFeedback = null;
    let raidFeedbackTimer = null;
    const settledRaidCodes = new Set();

    let ghostSession = null;
    let ghostTimerHandle = null;

    function escapeMP(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getRankTierFromPoints(rp) {
        const pts = Math.max(0, Number(rp) || 0);
        for (let i = 0; i < RANK_TIERS.length; i++) {
            if (pts >= RANK_TIERS[i].min) return RANK_TIERS[i].name;
        }
        return '青銅 III';
    }

    function sanitizeMPUrl(rawUrl, fallbackUrl = '') {
        if (typeof global.sanitizeSafeUrl === 'function') {
            return global.sanitizeSafeUrl(rawUrl, fallbackUrl);
        }
        const val = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        if (!val) return fallbackUrl;
        if (/^https?:\/\//i.test(val)) return val;
        if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(val)) return val;
        return fallbackUrl;
    }

    function getActiveAuthUser() {
        if (global.auth && global.auth.currentUser) return global.auth.currentUser;
        try {
            if (global.firebase && typeof global.firebase.auth === 'function') {
                return global.firebase.auth().currentUser || null;
            }
        } catch (e) {}
        return null;
    }

    function getActiveRtdb() {
        if (global.rtdb) return global.rtdb;
        try {
            if (global.firebase && typeof global.firebase.database === 'function') {
                const instance = global.firebase.database();
                if (instance) {
                    global.rtdb = instance;
                    return instance;
                }
            }
        } catch (e) {}
        return null;
    }

    function renderMpMemberBadge(tierOrObj, expiresAt = 0, size = '2xs') {
        if (!global.MembershipEngine || typeof global.MembershipEngine.renderBadgeHtml !== 'function') return '';
        const input = (tierOrObj && typeof tierOrObj === 'object')
            ? tierOrObj
            : { tier: tierOrObj || 'free', expiresAt: Number(expiresAt) || 0 };
        return global.MembershipEngine.renderBadgeHtml(input, { size });
    }

    function getCurrentPlayerIdentity() {
        const user = getActiveAuthUser();
        if (!user) return null;
        const nickname = (global.userData && global.userData.nickname) || user.displayName || 'LZH 學習者';
        const cosmetics = (global.userData && global.userData.cosmetics) || {};
        const prog = (global.userData && global.userData.progression) || {};
        const memPayload = (global.MembershipEngine && typeof global.MembershipEngine.getMyOnlineMembershipPayload === 'function')
            ? global.MembershipEngine.getMyOnlineMembershipPayload()
            : { membershipTier: 'free', membershipExpiresAt: 0 };
        const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=0ea5e9&color=fff`;
        return {
            uid: user.uid,
            name: nickname,
            avatar: sanitizeMPUrl(user.photoURL || fallbackAvatar, fallbackAvatar),
            avatarFrame: cosmetics.frame || cosmetics.avatarFrame || 'default',
            rankPoints: Number(prog.rankPoints) || 0,
            rankTier: prog.rankTier || getRankTierFromPoints(prog.rankPoints || 0),
            membershipTier: memPayload.membershipTier || 'free',
            membershipExpiresAt: Number(memPayload.membershipExpiresAt) || 0
        };
    }

    function ensureLoggedInAndRtdb() {
        const user = getActiveAuthUser();
        if (!user) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號才能使用即時連線對戰功能！', 'warning');
            }
            return false;
        }
        if (!getActiveRtdb()) {
            if (typeof global.showToast === 'function') {
                global.showToast('即時連線資料庫尚未初始化', 'error');
            }
            return false;
        }
        return true;
    }

    function generateRoomCode(prefix = '') {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let out = prefix;
        for (let i = 0; i < 6 - prefix.length; i++) {
            out += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return out;
    }

    function buildTenQuestionDeck() {
        if (global.GameEngine && typeof global.GameEngine.buildQuestionPool === 'function' && typeof global.GameEngine.createMcqQuestion === 'function') {
            const pool = [...global.GameEngine.buildQuestionPool()].sort(() => Math.random() - 0.5);
            const qs = [];
            for (let i = 0; i < 10; i++) {
                const target = pool[i % pool.length];
                const q = global.GameEngine.createMcqQuestion(target, pool);
                qs.push({
                    word: q.word || '',
                    phonetic: target.phonetic || q.phonetic || '',
                    options: Array.isArray(q.options) ? q.options : [],
                    correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0,
                    correctMeaning: q.correctMeaning || q.meaning || ''
                });
            }
            return qs;
        }

        const list = Array.isArray(global.wordList) && global.wordList.length >= 4
            ? global.wordList.filter(w => w && w.word && w.meaning)
            : [
                { word: 'resilient', phonetic: '/rɪˈzɪl.jənt/', meaning: '有彈性的；能迅速恢復的' },
                { word: 'meticulous', phonetic: '/məˈtɪk.jə.ləs/', meaning: '一絲不苟的' },
                { word: 'ephemeral', phonetic: '/ɪˈfem.ər.əl/', meaning: '短暫的' },
                { word: 'pragmatic', phonetic: '/præɡˈmæt.ɪk/', meaning: '務實的' },
                { word: 'coherent', phonetic: '/koʊˈhɪr.ənt/', meaning: '連貫的；有條理的' },
                { word: 'diligent', phonetic: '/ˈdɪl.ə.dʒənt/', meaning: '勤奮的' },
                { word: 'abundant', phonetic: '/əˈbʌn.dənt/', meaning: '豐富的' },
                { word: 'versatile', phonetic: '/ˈvɜːr.sə.təl/', meaning: '多才多藝的' },
                { word: 'inevitable', phonetic: '/ɪnˈev.ə.tə.bəl/', meaning: '不可避免的' },
                { word: 'persevere', phonetic: '/ˌpɜːr.səˈvɪr/', meaning: '堅持不懈' }
            ];

        const shuffled = [...list].sort(() => Math.random() - 0.5);
        const qs = [];
        for (let i = 0; i < 10; i++) {
            const target = shuffled[i % shuffled.length];
            const distractors = list
                .filter(w => w.word !== target.word && w.meaning !== target.meaning)
                .sort(() => Math.random() - 0.5)
                .slice(0, 3)
                .map(w => w.meaning);
            while (distractors.length < 3) distractors.push(`選項 ${distractors.length + 2}`);
            const opts = [target.meaning, ...distractors].sort(() => Math.random() - 0.5);
            qs.push({
                word: target.word,
                phonetic: target.phonetic || '',
                options: opts,
                correctIndex: opts.indexOf(target.meaning),
                correctMeaning: target.meaning
            });
        }
        return qs;
    }

    const DUEL_EXPIRE_MS = 600000;
    const MATCHMAKING_STALE_MS = 45000;
    const RAID_EXPIRE_MS = 1800000;
    const activeOnDisconnectRefs = new Set();

    function registerOnDisconnectRemove(ref) {
        if (!ref || typeof ref.onDisconnect !== 'function') return;
        try {
            ref.onDisconnect().remove().catch(() => {});
            activeOnDisconnectRefs.add(ref);
        } catch (e) {}
    }

    function cancelOnDisconnectRef(ref) {
        if (!ref || typeof ref.onDisconnect !== 'function') return;
        try {
            ref.onDisconnect().cancel().catch(() => {});
        } catch (e) {}
        activeOnDisconnectRefs.delete(ref);
    }

    function cancelAllOnDisconnectHandlers() {
        activeOnDisconnectRefs.forEach((ref) => {
            try { ref.onDisconnect().cancel().catch(() => {}); } catch (e) {}
        });
        activeOnDisconnectRefs.clear();
    }

    function detachActiveDuelListener() {
        if (activeDuelRef && activeDuelListener) {
            try { activeDuelRef.off('value', activeDuelListener); } catch (e) {}
        }
        activeDuelRef = null;
        activeDuelListener = null;
    }

    function detachActiveQueueListener() {
        if (matchmakingScanTimer) {
            clearInterval(matchmakingScanTimer);
            matchmakingScanTimer = null;
        }
        if (matchmakingHeartbeatTimer) {
            clearInterval(matchmakingHeartbeatTimer);
            matchmakingHeartbeatTimer = null;
        }
        if (matchmakingScanRef && matchmakingScanListener) {
            try { matchmakingScanRef.off('value', matchmakingScanListener); } catch (e) {}
        }
        matchmakingScanRef = null;
        matchmakingScanListener = null;
        if (activeQueueRef && activeQueueListener) {
            try { activeQueueRef.off('value', activeQueueListener); } catch (e) {}
        }
        activeQueueRef = null;
        activeQueueListener = null;
        isClaimingOpponent = false;
    }

    function clearRaidFeedbackTimer() {
        if (raidFeedbackTimer) {
            clearTimeout(raidFeedbackTimer);
            raidFeedbackTimer = null;
        }
    }

    function detachActiveRaidListener() {
        if (activeRaidRef && activeRaidListener) {
            try { activeRaidRef.off('value', activeRaidListener); } catch (e) {}
        }
        activeRaidRef = null;
        activeRaidListener = null;
    }

    function stopGhostTimer() {
        if (ghostTimerHandle) {
            clearInterval(ghostTimerHandle);
            ghostTimerHandle = null;
        }
    }

    function cleanupMultiplayerListeners() {
        detachActiveDuelListener();
        detachActiveQueueListener();
        detachActiveRaidListener();
        cancelAllOnDisconnectHandlers();
        clearRaidFeedbackTimer();
        stopGhostTimer();
        raidFeedback = null;
        raidAnswerLocked = false;
        duelAnswerLocked = false;
        duelFeedbackHold = null;
        duelDeferredFinishRoom = null;
        isMatchmaking = false;
    }

    function getModalBody() {
        return document.getElementById('multiplayerModalBody');
    }

    function setModalTitle(titleHtml) {
        const el = document.getElementById('multiplayerModalTitle');
        if (el) el.innerHTML = titleHtml;
    }

    function openModal(tab = 'duel') {
        activeModalTab = tab === 'coop' ? 'coop' : 'duel';
        if (typeof global.openModal === 'function') {
            global.openModal('multiplayerModal');
        } else {
            const modal = document.getElementById('multiplayerModal');
            if (modal) modal.classList.remove('hidden');
        }
        renderMultiplayerHub();
    }

    function closeModal() {
        cancelMatchmaking(true);
        cleanupMultiplayerListeners();
        activeDuelCode = null;
        activeDuelData = null;
        activeRaidCode = null;
        activeRaidData = null;
        ghostSession = null;
        if (typeof global.closeModal === 'function') {
            global.closeModal('multiplayerModal');
        } else {
            const modal = document.getElementById('multiplayerModal');
            if (modal) modal.classList.add('hidden');
        }
    }

    function switchHubTab(tab) {
        activeModalTab = tab;
        renderMultiplayerHub();
    }

    function renderMultiplayerHub() {
        const body = getModalBody();
        if (!body) return;

        const identity = getCurrentPlayerIdentity();
        const prog = (global.userData && global.userData.progression) || {};
        const rp = Number(prog.rankPoints) || 0;
        const tier = prog.rankTier || getRankTierFromPoints(rp);
        const wins = Number(prog.duelWins) || 0;
        const total = Number(prog.duelTotal) || 0;
        const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

        setModalTitle('<i class="fa-solid fa-trophy text-amber-500 mr-1.5"></i>即時競技與多人副本');

        const tabBtnClass = (tab) => activeModalTab === tab
            ? 'flex-1 py-2 px-3 rounded-xl text-xs font-extrabold bg-brand-600 text-white shadow-xs transition cursor-pointer'
            : 'flex-1 py-2 px-3 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer';

        body.innerHTML = `
            <div class="space-y-4">
                <!-- 排位個人名片橫條 -->
                <div class="p-3.5 rounded-2xl bg-gradient-to-r from-slate-900 to-indigo-950 text-white flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-[11px] font-bold text-amber-300 uppercase tracking-wider">排位賽賽季戰績</div>
                        <div class="text-base font-extrabold mt-0.5 flex items-center gap-2 flex-wrap">
                            <span>🏆 ${escapeMP(tier)}</span>
                            ${identity ? renderMpMemberBadge(identity, 0, 'xs') : ''}
                            <span class="text-xs font-mono text-sky-300">${rp} RP</span>
                        </div>
                    </div>
                    <div class="text-right shrink-0">
                        <div class="text-xs font-bold text-slate-200">${wins} 勝 / ${total} 場</div>
                        <div class="text-[11px] text-emerald-400 font-bold">勝率 ${winRate}%</div>
                    </div>
                </div>

                ${!identity ? `
                    <div class="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl text-xs text-amber-800 dark:text-amber-200 font-bold flex items-center justify-between gap-2">
                        <span>⚠️ 即時連線對戰與共鬥需要登入帳號，幽靈單人影子練習則可離線搶先體驗。</span>
                    </div>
                ` : ''}

                <!-- 分頁切換 -->
                <div class="flex gap-2">
                    <button type="button" onclick="MultiplayerEngine.switchHubTab('duel')" class="${tabBtnClass('duel')}">⚔️ 1v1 拔河 & 排位配對</button>
                    <button type="button" onclick="MultiplayerEngine.switchHubTab('coop')" class="${tabBtnClass('coop')}">🐉 四人打王 & 幽靈競速</button>
                </div>

                ${activeModalTab === 'duel' ? `
                    <div class="space-y-3">
                        <!-- 排位即時配對 -->
                        <div class="p-4 rounded-2xl border border-brand-200 dark:border-brand-800 bg-brand-50/60 dark:bg-brand-950/30 space-y-2.5">
                            <div class="flex items-center justify-between">
                                <div>
                                    <h4 class="text-sm font-extrabold text-slate-900 dark:text-white">🏆 排位賽即時配對</h4>
                                    <p class="text-[11px] text-slate-500 dark:text-slate-400">勝場 +25 RP / 敗場 -10 RP，10 題即時拔河決戰</p>
                                </div>
                                <button type="button" onclick="MultiplayerEngine.startMatchmaking()" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold rounded-xl shadow-sm transition cursor-pointer">
                                    開始配對
                                </button>
                            </div>
                        </div>

                        <!-- 好友房間邀請 / 加入 -->
                        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 space-y-3">
                            <h4 class="text-sm font-extrabold text-slate-900 dark:text-white">🤝 好友開房 & 邀請碼對戰</h4>
                            <div class="flex gap-2">
                                <button type="button" onclick="MultiplayerEngine.createDuelRoom()" class="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-xs font-extrabold rounded-xl transition cursor-pointer">
                                    <i class="fa-solid fa-plus mr-1"></i>建立 1v1 房間
                                </button>
                            </div>
                            <div class="flex gap-2 pt-1">
                                <input type="text" id="duelJoinCodeInput" maxlength="10" placeholder="輸入 6 碼房間代號..." class="flex-1 px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono uppercase font-bold focus:outline-none focus:ring-2 focus:ring-brand-500">
                                <button type="button" onclick="MultiplayerEngine.joinDuelFromInput()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition cursor-pointer">
                                    加入對戰
                                </button>
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="space-y-3">
                        <!-- 四人打王共鬥 -->
                        <div class="p-4 rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20 space-y-3">
                            <div>
                                <h4 class="text-sm font-extrabold text-slate-900 dark:text-white">🐉 四人組隊討伐深淵魔王</h4>
                                <p class="text-[11px] text-slate-500 dark:text-slate-400">最多 4 人同房共鬥 1,200 HP 巨獸，答對即時扣除團隊共享血量！</p>
                            </div>
                            <div class="flex gap-2">
                                <button type="button" onclick="MultiplayerEngine.createRaidRoom()" class="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold rounded-xl transition cursor-pointer">
                                    發起共鬥討伐
                                </button>
                            </div>
                            <div class="flex gap-2">
                                <input type="text" id="raidJoinCodeInput" maxlength="10" placeholder="輸入共鬥房號..." class="flex-1 px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono uppercase font-bold focus:outline-none focus:ring-2 focus:ring-rose-500">
                                <button type="button" onclick="MultiplayerEngine.joinRaidFromInput()" class="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-extrabold rounded-xl transition cursor-pointer">
                                    參戰
                                </button>
                            </div>
                        </div>

                        <!-- 10 題幽靈影子競速 -->
                        <div class="p-4 rounded-2xl border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 space-y-2.5">
                            <div class="flex items-center justify-between gap-2">
                                <div>
                                    <h4 class="text-sm font-extrabold text-slate-900 dark:text-white">👻 10 題幽靈影子競速</h4>
                                    <p class="text-[11px] text-slate-500 dark:text-slate-400">挑選全服玩家的實戰時間軸幽靈進行即時影子對決！</p>
                                </div>
                                <button type="button" onclick="MultiplayerEngine.loadGhostSelector()" class="px-3.5 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-extrabold rounded-xl transition cursor-pointer shrink-0">
                                    挑選幽靈開跑
                                </button>
                            </div>
                        </div>
                    </div>
                `}
            </div>
        `;
    }

    /* ==========================================================================
       ⚔️ 1v1 拔河對戰室 (duels/{roomCode}) & Deep Link (?duel=XXXX)
       ========================================================================== */

    function getDuelInviteUrl(roomCode) {
        try {
            const base = (typeof global.resolvePublicShareBaseUrl === 'function')
                ? global.resolvePublicShareBaseUrl()
                : (() => {
                    const loc = window.location;
                    const proto = String(loc?.protocol || '').toLowerCase();
                    const host = String(loc?.hostname || '').toLowerCase();
                    const isPublicHttp = (proto === 'https:' || proto === 'http:') && host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
                    return isPublicHttp ? `${loc.origin}${loc.pathname || '/'}` : 'https://flashcards-5f514.web.app/';
                })();
            const url = new URL(base);
            url.searchParams.set('duel', roomCode);
            return url.toString();
        } catch (e) {
            return `https://flashcards-5f514.web.app/?duel=${encodeURIComponent(roomCode)}`;
        }
    }

    function copyDuelInviteLink(roomCode) {
        const link = getDuelInviteUrl(roomCode);
        const copied = (typeof global.copyPlainUrlToClipboardSync === 'function')
            ? global.copyPlainUrlToClipboardSync(link)
            : false;
        if (copied) {
            if (typeof global.showToast === 'function') global.showToast(`📋 已複製對戰邀請連結（房號 ${roomCode}）`, 'success');
            return;
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(link).then(() => {
                if (typeof global.showToast === 'function') global.showToast(`📋 已複製對戰邀請連結（房號 ${roomCode}）`, 'success');
            }).catch(() => {
                if (typeof global.showToast === 'function') global.showToast(`對戰房號：${roomCode}`, 'info');
            });
        } else if (typeof global.showToast === 'function') {
            global.showToast(`對戰房號：${roomCode}`, 'info');
        }
    }

    function openDuelFromDeepLink(explicitCode = '') {
        const rawCode = explicitCode || pendingDuelCode;
        if (!rawCode) return false;
        const code = String(rawCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code) return false;

        const user = getActiveAuthUser();
        if (!user) {
            pendingDuelCode = code;
            if (typeof global.showToast === 'function') {
                global.showToast(`📩 偵測到對戰邀請房號 ${code}，登入後將自動帶您進入房間！`, 'info');
            }
            return true;
        }

        pendingDuelCode = null;
        openModal('duel');
        joinDuelRoom(code);
        return true;
    }

    function checkUrlDuelInvite(explicitCode = '') {
        try {
            const params = new URLSearchParams(window.location.search);
            const rawCode = explicitCode || params.get('duel') || pendingDuelCode;
            if (!rawCode) return false;
            const code = String(rawCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (!code) return false;

            const user = getActiveAuthUser();
            if (!user) {
                pendingDuelCode = code;
                if (typeof global.showToast === 'function') {
                    global.showToast(`📩 偵測到對戰邀請房號 ${code}，登入後將自動帶您進入房間！`, 'info');
                }
                return true;
            }

            pendingDuelCode = null;
            try {
                const cleanUrl = new URL(window.location.href);
                cleanUrl.searchParams.delete('duel');
                window.history.replaceState({}, document.title, cleanUrl.toString());
            } catch (e) {}

            openModal('duel');
            joinDuelRoom(code);
            return true;
        } catch (e) {
            return false;
        }
    }

    async function createDuelRoom(opponentPreset = null, options = {}) {
        if (!ensureLoggedInAndRtdb()) return null;
        const me = getCurrentPlayerIdentity();
        const code = generateRoomCode('');
        const questions = buildTenQuestionDeck();

        const nowMs = Date.now();
        const roomPayload = {
            roomCode: code,
            hostUid: me.uid,
            hostName: me.name,
            hostAvatar: me.avatar,
            hostTier: me.rankTier,
            hostMemberTier: me.membershipTier || 'free',
            hostMemberExpiresAt: me.membershipExpiresAt || 0,
            guestUid: opponentPreset ? opponentPreset.uid : '',
            guestName: opponentPreset ? opponentPreset.name : '',
            guestAvatar: opponentPreset ? opponentPreset.avatar : '',
            guestTier: opponentPreset ? opponentPreset.rankTier : '',
            guestMemberTier: opponentPreset ? (opponentPreset.membershipTier || 'free') : 'free',
            guestMemberExpiresAt: opponentPreset ? (Number(opponentPreset.membershipExpiresAt) || 0) : 0,
            status: opponentPreset ? 'playing' : 'waiting',
            tugPosition: 50,
            hostScore: 0,
            guestScore: 0,
            hostIndex: 0,
            guestIndex: 0,
            winnerUid: '',
            isRanked: Boolean(opponentPreset),
            questions,
            createdAt: nowMs,
            updatedAt: nowMs
        };

        try {
            const dbRef = getActiveRtdb();
            const roomRef = dbRef.ref(`duels/${code}`);
            await roomRef.set(roomPayload);
            if (!options || !options.skipSubscribe) {
                if (!opponentPreset) {
                    registerOnDisconnectRemove(roomRef);
                }
                subscribeToDuelRoom(code);
            }
            return code;
        } catch (e) {
            console.error('建立對戰房間失敗:', e);
            if (!options || !options.silentError) {
                if (typeof global.showToast === 'function') global.showToast('建立房間失敗：' + e.message, 'error');
            }
            return null;
        }
    }

    function joinDuelFromInput() {
        const input = document.getElementById('duelJoinCodeInput');
        const code = input ? input.value.trim().toUpperCase() : '';
        if (!code) {
            if (typeof global.showToast === 'function') global.showToast('請輸入房間代號！', 'warning');
            return;
        }
        joinDuelRoom(code);
    }

    async function joinDuelRoom(rawCode) {
        if (!ensureLoggedInAndRtdb()) return false;
        const me = getCurrentPlayerIdentity();
        const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code) return false;

        try {
            const dbRef = getActiveRtdb();
            const ref = dbRef.ref(`duels/${code}`);
            const nowMs = Date.now();

            const preSnap = await ref.once('value');
            if (!preSnap.exists()) {
                if (typeof global.showToast === 'function') global.showToast(`找不到對戰房間「${code}」`, 'error');
                return false;
            }
            const preVal = preSnap.val() || {};
            const preCreatedAt = Number(preVal.createdAt) || 0;
            if (preVal.status === 'waiting' && preCreatedAt > 0 && (nowMs - preCreatedAt) > DUEL_EXPIRE_MS) {
                if (preVal.hostUid === me.uid) {
                    await ref.remove().catch(() => {});
                }
                if (typeof global.showToast === 'function') global.showToast('該對戰房間已逾時（超過 10 分鐘未開局）並自動失效', 'warning');
                return false;
            }

            if (preVal.hostUid === me.uid || preVal.guestUid === me.uid) {
                subscribeToDuelRoom(code);
                return true;
            }

            if (preVal.guestUid && preVal.guestUid !== '' && preVal.guestUid !== me.uid) {
                if (typeof global.showToast === 'function') global.showToast('該對戰房間人數已滿！', 'warning');
                return false;
            }

            let rejectReason = '';
            const txResult = await ref.transaction((data) => {
                if (data === null) {
                    return undefined;
                }
                const createdAt = Number(data.createdAt) || 0;
                const isWaitingExpired = data.status === 'waiting' && createdAt > 0 && (Date.now() - createdAt) > DUEL_EXPIRE_MS;
                if (isWaitingExpired) {
                    rejectReason = 'expired';
                    return undefined;
                }
                if (data.hostUid !== me.uid && data.guestUid && data.guestUid !== '' && data.guestUid !== me.uid) {
                    rejectReason = 'full';
                    return undefined;
                }
                if (data.hostUid !== me.uid && (!data.guestUid || data.guestUid === '')) {
                    const ts = Date.now();
                    data.guestUid = me.uid;
                    data.guestName = me.name;
                    data.guestAvatar = me.avatar;
                    data.guestTier = me.rankTier;
                    data.guestMemberTier = me.membershipTier || 'free';
                    data.guestMemberExpiresAt = me.membershipExpiresAt || 0;
                    data.status = 'playing';
                    data.startedAt = ts;
                    data.updatedAt = ts;
                }
                return data;
            }, undefined, false);

            const finalVal = txResult && txResult.snapshot ? txResult.snapshot.val() : null;
            if (!finalVal) {
                if (typeof global.showToast === 'function') global.showToast(`找不到對戰房間「${code}」`, 'error');
                return false;
            }
            if (!txResult.committed) {
                if (rejectReason === 'expired') {
                    if (finalVal.hostUid === me.uid) {
                        await ref.remove().catch(() => {});
                    }
                    if (typeof global.showToast === 'function') global.showToast('該對戰房間已逾時並自動失效', 'warning');
                    return false;
                }
                if (rejectReason === 'full') {
                    if (typeof global.showToast === 'function') global.showToast('該對戰房間人數已滿！', 'warning');
                    return false;
                }
                if (finalVal.hostUid !== me.uid && finalVal.guestUid !== me.uid) {
                    if (typeof global.showToast === 'function') global.showToast('加入對戰房間失敗，請再試一次', 'warning');
                    return false;
                }
            }

            subscribeToDuelRoom(code);
            return true;
        } catch (e) {
            console.error('加入對戰房間失敗:', e);
            const msg = String(e && e.message ? e.message : e || '');
            if (/permission_denied|permission denied/i.test(msg)) {
                if (typeof global.showToast === 'function') {
                    global.showToast('無權限加入對戰房間（請確認雙方已登入且 Firebase 即時資料庫規則已發布更新）', 'error');
                }
            } else if (typeof global.showToast === 'function') {
                global.showToast('加入對戰失敗：' + msg, 'error');
            }
            return false;
        }
    }

    function subscribeToDuelRoom(code) {
        cleanupMultiplayerListeners();
        activeDuelCode = code;
        duelAnswerLocked = false;
        duelFeedbackHold = null;
        duelDeferredFinishRoom = null;
        duelTimeline = [{ tMs: 0, score: 0 }];
        duelStartMs = Date.now();

        if (typeof global.openModal === 'function') {
            global.openModal('multiplayerModal');
        } else {
            const modal = document.getElementById('multiplayerModal');
            if (modal) modal.classList.remove('hidden');
        }

        const dbRef = getActiveRtdb();
        if (!dbRef) return;
        const me = getCurrentPlayerIdentity();
        activeDuelRef = dbRef.ref(`duels/${code}`);
        activeDuelListener = (snap) => {
            const val = snap.val();
            if (!val) {
                renderMultiplayerHub();
                return;
            }
            if (val.status === 'playing' || val.status === 'finished') {
                cancelOnDisconnectRef(activeDuelRef);
            } else if (me && val.hostUid === me.uid && val.status === 'waiting') {
                registerOnDisconnectRemove(activeDuelRef);
            }
            activeDuelData = val;
            if (val.status === 'finished' && duelFeedbackHold && duelFeedbackHold.roomCode === code) {
                duelDeferredFinishRoom = val;
            }
            renderDuelRoomView(val);
        };
        activeDuelRef.on('value', activeDuelListener);
    }

    function renderDuelRoomView(room) {
        const body = getModalBody();
        if (!body || !room) return;
        const me = getCurrentPlayerIdentity();
        if (!me) return;

        const isHost = room.hostUid === me.uid;
        const myIndex = isHost ? (Number(room.hostIndex) || 0) : (Number(room.guestIndex) || 0);
        const myScore = isHost ? (Number(room.hostScore) || 0) : (Number(room.guestScore) || 0);
        const oppName = isHost ? (room.guestName || '等待對手中...') : (room.hostName || '房主');
        const oppScore = isHost ? (Number(room.guestScore) || 0) : (Number(room.hostScore) || 0);
        const oppMemTier = isHost ? (room.guestMemberTier || 'free') : (room.hostMemberTier || 'free');
        const oppMemExp = isHost ? (Number(room.guestMemberExpiresAt) || 0) : (Number(room.hostMemberExpiresAt) || 0);
        const myBadgeHtml = renderMpMemberBadge(me, 0, '2xs');
        const oppBadgeHtml = renderMpMemberBadge(oppMemTier, oppMemExp, '2xs');
        const tug = Math.max(0, Math.min(100, Number(room.tugPosition != null ? room.tugPosition : 50)));
        const questions = Array.isArray(room.questions) ? room.questions : [];
        const hold = (duelFeedbackHold && duelFeedbackHold.roomCode === room.roomCode) ? duelFeedbackHold : null;

        setModalTitle(`<i class="fa-solid fa-bolt text-brand-500 mr-1.5"></i>1v1 拔河排位賽 ・房號 ${escapeMP(room.roomCode)}`);

        if (room.status === 'waiting') {
            body.innerHTML = `
                <div class="py-6 text-center space-y-4">
                    <div class="w-14 h-14 mx-auto rounded-2xl bg-brand-100 dark:bg-brand-950/60 text-brand-600 flex items-center justify-center text-2xl animate-pulse">
                        <i class="fa-solid fa-tower-broadcast"></i>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-slate-400">邀請好友輸入房號或開啟連結加入</div>
                        <div class="text-3xl font-mono font-black tracking-widest text-slate-900 dark:text-white mt-1">${escapeMP(room.roomCode)}</div>
                    </div>
                    <div class="flex justify-center gap-2">
                        <button type="button" onclick="MultiplayerEngine.copyDuelInviteLink('${escapeMP(room.roomCode)}')" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold rounded-xl shadow-xs cursor-pointer">
                            <i class="fa-solid fa-link mr-1"></i>複製邀請連結
                        </button>
                        <button type="button" onclick="MultiplayerEngine.leaveDuelRoom()" class="px-4 py-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer">
                            離開房間
                        </button>
                    </div>
                </div>
            `;
            return;
        }

        if (room.status === 'finished' && hold) {
            duelDeferredFinishRoom = room;
            const heldQ = questions[hold.qIdx] || null;
            const myTugPct = isHost ? tug : (100 - tug);
            if (heldQ) {
                body.innerHTML = `
                    <div class="space-y-4">
                        <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                            <div class="flex items-center justify-between gap-2 flex-wrap text-xs font-extrabold">
                                <span class="text-brand-600 dark:text-brand-400 inline-flex items-center gap-1 flex-wrap">🔵 你：${myScore} 分 ${myBadgeHtml}</span>
                                <span class="text-rose-500 inline-flex items-center gap-1 flex-wrap">🔴 ${escapeMP(oppName)} ${oppBadgeHtml}：${oppScore} 分</span>
                            </div>
                            <div class="relative w-full h-4 rounded-full bg-rose-500/80 overflow-hidden shadow-inner">
                                <div class="h-full bg-gradient-to-r from-brand-500 to-sky-400 transition-all duration-300" style="width:${myTugPct}%"></div>
                                <div class="absolute top-0 bottom-0 left-1/2 w-0.5 bg-white/80"></div>
                            </div>
                        </div>

                        <div class="p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-3">
                            <div class="text-center py-2 space-y-1">
                                <div class="text-2xl font-black text-slate-900 dark:text-white">${escapeMP(heldQ.word)}</div>
                                ${heldQ.phonetic ? `<div class="text-xs font-mono text-slate-400 mt-0.5">${escapeMP(heldQ.phonetic)}</div>` : ''}
                                <div class="text-xs font-extrabold text-rose-600 dark:text-rose-400 pt-1">❌ 答錯了！正解：${escapeMP(hold.correctMeaning)}</div>
                            </div>
                            <div class="grid grid-cols-1 gap-2">
                                ${(heldQ.options || []).map((opt, idx) => {
                                    const isCorr = idx === hold.correctIdx;
                                    const isSel = idx === hold.selectedIdx;
                                    const cls = isCorr
                                        ? 'p-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60 text-left text-xs font-extrabold text-emerald-800 dark:text-emerald-200 pointer-events-none flex items-center gap-2'
                                        : (isSel
                                            ? 'p-3 rounded-xl border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/60 text-left text-xs font-extrabold text-rose-800 dark:text-rose-200 pointer-events-none flex items-center gap-2'
                                            : 'p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-left text-xs font-bold text-slate-400 opacity-55 pointer-events-none flex items-center gap-2');
                                    const badge = isCorr ? '✓' : (isSel ? '✕' : `${idx + 1}.`);
                                    return `<button type="button" disabled class="${cls}"><span class="inline-block w-5 font-mono font-black">${badge}</span><span>${escapeMP(opt)}</span></button>`;
                                }).join('')}
                            </div>
                            <button type="button" onclick="MultiplayerEngine.confirmDuelWrongNext()" class="min-h-[44px] w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-sm transition cursor-pointer flex items-center justify-center gap-1.5">
                                <span>查看戰果</span>
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                `;
                return;
            }
        }

        if (room.status === 'finished') {
            settleFinishedDuel(room, me);
            const iWon = room.winnerUid === me.uid;
            const isDraw = room.winnerUid === 'DRAW';
            body.innerHTML = `
                <div class="space-y-4 text-center py-2">
                    <div class="text-4xl">${isDraw ? '🤝' : (iWon ? '🏆' : '💪')}</div>
                    <h4 class="text-xl font-black text-slate-900 dark:text-white">
                        ${isDraw ? '勢均力敵・平手收場！' : (iWon ? '勝出！拔河霸主就是你！' : '惜敗！下次討回來！')}
                    </h4>
                    <div class="grid grid-cols-2 gap-3 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                        <div>
                            <div class="text-[11px] font-bold text-brand-500 inline-flex items-center justify-center gap-1 flex-wrap">你 (${escapeMP(me.name)}) ${myBadgeHtml}</div>
                            <div class="text-2xl font-black text-slate-900 dark:text-white">${myScore} 分</div>
                        </div>
                        <div>
                            <div class="text-[11px] font-bold text-rose-500 inline-flex items-center justify-center gap-1 flex-wrap">${escapeMP(oppName)} ${oppBadgeHtml}</div>
                            <div class="text-2xl font-black text-slate-900 dark:text-white">${oppScore} 分</div>
                        </div>
                    </div>
                    <div class="flex flex-wrap justify-center gap-2">
                        <button type="button" onclick="MultiplayerEngine.renderDuelReport('${escapeMP(room.roomCode)}')" class="px-4 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-extrabold rounded-xl shadow-sm cursor-pointer">
                            <i class="fa-solid fa-image mr-1"></i>生成 IG 戰績圖卡
                        </button>
                        <button type="button" onclick="MultiplayerEngine.renderMultiplayerHub()" class="px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">
                            返回對戰大廳
                        </button>
                    </div>
                    <div id="duelReportContainer"></div>
                </div>
            `;
            return;
        }

        const q = questions[myIndex];
        const waitingForOpponentFinish = myIndex >= questions.length || !q;
        const myTugPct = isHost ? tug : (100 - tug);
        const activeHold = (hold && hold.qIdx === myIndex) ? hold : null;

        body.innerHTML = `
            <div class="space-y-4">
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                    <div class="flex items-center justify-between gap-2 flex-wrap text-xs font-extrabold">
                        <span class="text-brand-600 dark:text-brand-400 inline-flex items-center gap-1 flex-wrap">🔵 你 ${myBadgeHtml}：${myScore} 分 (${Math.min(myIndex, questions.length)}/${questions.length})</span>
                        <span class="text-rose-500 inline-flex items-center gap-1 flex-wrap">🔴 ${escapeMP(oppName)} ${oppBadgeHtml}：${oppScore} 分</span>
                    </div>
                    <div class="relative w-full h-4 rounded-full bg-rose-500/80 overflow-hidden shadow-inner">
                        <div class="h-full bg-gradient-to-r from-brand-500 to-sky-400 transition-all duration-300" style="width:${myTugPct}%"></div>
                        <div class="absolute top-0 bottom-0 left-1/2 w-0.5 bg-white/80"></div>
                    </div>
                    <div class="text-center text-[11px] font-bold text-slate-400">拔河優勢值：${myTugPct}%（拉至 100% 立即奪勝！）</div>
                </div>

                ${waitingForOpponentFinish ? `
                    <div class="py-8 text-center space-y-2">
                        <i class="fa-solid fa-hourglass-half text-3xl text-brand-500 animate-spin"></i>
                        <div class="text-sm font-extrabold text-slate-800 dark:text-white">你已完成全部 10 題！</div>
                        <div class="text-xs text-slate-400">正在等待對手作答完畢結算...</div>
                    </div>
                ` : `
                    <div class="p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-3">
                        <div class="flex items-center justify-between text-[11px] font-bold text-slate-400">
                            <span>第 ${myIndex + 1} / ${questions.length} 題</span>
                            <span class="text-brand-500">答對拉動 +10% 拔河條</span>
                        </div>
                        <div class="text-center py-2">
                            <div class="text-2xl font-black text-slate-900 dark:text-white">${escapeMP(q.word)}</div>
                            ${q.phonetic ? `<div class="text-xs font-mono text-slate-400 mt-0.5">${escapeMP(q.phonetic)}</div>` : ''}
                            ${activeHold ? `<div class="text-xs font-extrabold text-rose-600 dark:text-rose-400 pt-1">❌ 答錯了！正解：${escapeMP(activeHold.correctMeaning)}</div>` : ''}
                        </div>
                        <div class="grid grid-cols-1 gap-2">
                            ${(q.options || []).map((opt, idx) => {
                                if (!activeHold) {
                                    return `
                                        <button type="button" onclick="MultiplayerEngine.answerDuelQuestion(${idx})" class="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:bg-brand-50 dark:hover:bg-brand-950/50 hover:border-brand-400 text-left text-xs font-bold text-slate-800 dark:text-slate-100 transition cursor-pointer">
                                            <span class="inline-block w-5 text-slate-400 font-mono">${idx + 1}.</span>${escapeMP(opt)}
                                        </button>
                                    `;
                                }
                                const isCorr = idx === activeHold.correctIdx;
                                const isSel = idx === activeHold.selectedIdx;
                                const cls = isCorr
                                    ? 'p-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60 text-left text-xs font-extrabold text-emerald-800 dark:text-emerald-200 pointer-events-none flex items-center gap-2'
                                    : (isSel
                                        ? 'p-3 rounded-xl border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/60 text-left text-xs font-extrabold text-rose-800 dark:text-rose-200 pointer-events-none flex items-center gap-2'
                                        : 'p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-left text-xs font-bold text-slate-400 opacity-55 pointer-events-none flex items-center gap-2');
                                const badge = isCorr ? '✓' : (isSel ? '✕' : `${idx + 1}.`);
                                return `
                                    <button type="button" disabled class="${cls}">
                                        <span class="inline-block w-5 font-mono font-black">${badge}</span><span>${escapeMP(opt)}</span>
                                    </button>
                                `;
                            }).join('')}
                        </div>
                        ${activeHold ? `
                            <button type="button" onclick="MultiplayerEngine.confirmDuelWrongNext()" class="min-h-[44px] w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-sm transition cursor-pointer flex items-center justify-center gap-1.5">
                                <span>${myIndex + 1 >= questions.length ? '確認結果' : '下一題'}</span>
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        ` : ''}
                    </div>
                `}
            </div>
        `;
    }

    async function answerDuelQuestion(optionIdx) {
        if (duelAnswerLocked || !activeDuelCode || !activeDuelData) return;
        const me = getCurrentPlayerIdentity();
        if (!me) return;

        const isHost = activeDuelData.hostUid === me.uid;
        const myIndex = isHost ? (Number(activeDuelData.hostIndex) || 0) : (Number(activeDuelData.guestIndex) || 0);
        const questions = Array.isArray(activeDuelData.questions) ? activeDuelData.questions : [];
        const q = questions[myIndex];
        if (!q || activeDuelData.status !== 'playing') return;

        duelAnswerLocked = true;
        const isCorrect = optionIdx === q.correctIndex;
        if (isCorrect) {
            setTimeout(() => {
                if (!duelFeedbackHold) duelAnswerLocked = false;
            }, 120);
        } else {
            duelFeedbackHold = {
                roomCode: activeDuelCode,
                qIdx: myIndex,
                selectedIdx: optionIdx,
                correctIdx: q.correctIndex,
                correctMeaning: q.correctMeaning || (Array.isArray(q.options) ? q.options[q.correctIndex] : '') || '',
                isHost
            };
        }

        if (isCorrect && global.GameEngine) {
            global.GameEngine.playComboSfx(3);
        } else if (!isCorrect && global.GameEngine) {
            global.GameEngine.playMissSfx();
        }

        const currentScore = isHost ? (Number(activeDuelData.hostScore) || 0) : (Number(activeDuelData.guestScore) || 0);
        const projectedScore = isCorrect ? currentScore + 10 : currentScore;
        duelTimeline.push({
            tMs: Math.max(100, Date.now() - duelStartMs),
            score: projectedScore
        });

        const totalQ = questions.length || 10;
        const dbRef = getActiveRtdb();
        if (!dbRef) return;
        const ref = dbRef.ref(`duels/${activeDuelCode}`);
        await ref.transaction((room) => {
            if (!room || room.status !== 'playing') return room;
            const hostTurn = room.hostUid === me.uid;
            const curIdx = hostTurn ? (Number(room.hostIndex) || 0) : (Number(room.guestIndex) || 0);
            if (curIdx >= totalQ) return room;

            const deltaTug = isCorrect ? (hostTurn ? 10 : -10) : (hostTurn ? -6 : 6);
            const nextTug = Math.max(0, Math.min(100, (Number(room.tugPosition != null ? room.tugPosition : 50)) + deltaTug));
            room.tugPosition = nextTug;

            if (isCorrect) {
                if (hostTurn) {
                    room.hostIndex = curIdx + 1;
                    room.hostScore = (Number(room.hostScore) || 0) + 10;
                } else {
                    room.guestIndex = curIdx + 1;
                    room.guestScore = (Number(room.guestScore) || 0) + 10;
                }
            }

            if (nextTug >= 100) {
                room.status = 'finished';
                room.winnerUid = room.hostUid;
                room.finishedAt = Date.now();
            } else if (nextTug <= 0) {
                room.status = 'finished';
                room.winnerUid = room.guestUid;
                room.finishedAt = Date.now();
            } else if ((Number(room.hostIndex) || 0) >= totalQ && (Number(room.guestIndex) || 0) >= totalQ) {
                room.status = 'finished';
                const hs = Number(room.hostScore) || 0;
                const gs = Number(room.guestScore) || 0;
                if (hs > gs) room.winnerUid = room.hostUid;
                else if (gs > hs) room.winnerUid = room.guestUid;
                else if (nextTug > 50) room.winnerUid = room.hostUid;
                else if (nextTug < 50) room.winnerUid = room.guestUid;
                else room.winnerUid = 'DRAW';
                room.finishedAt = Date.now();
            }
            return room;
        });

        if (!isCorrect && activeDuelData) {
            renderDuelRoomView(activeDuelData);
        }
    }

    async function confirmDuelWrongNext() {
        const hold = duelFeedbackHold;
        const deferredFinish = duelDeferredFinishRoom;
        duelFeedbackHold = null;
        duelDeferredFinishRoom = null;
        duelAnswerLocked = false;

        if (deferredFinish && deferredFinish.status === 'finished') {
            renderDuelRoomView(deferredFinish);
            return;
        }
        if (activeDuelData && activeDuelData.status === 'finished') {
            renderDuelRoomView(activeDuelData);
            return;
        }
        if (!hold || !activeDuelCode || hold.roomCode !== activeDuelCode) {
            if (activeDuelData) renderDuelRoomView(activeDuelData);
            return;
        }

        const me = getCurrentPlayerIdentity();
        const dbRef = getActiveRtdb();
        if (!me || !dbRef) return;

        const questions = Array.isArray(activeDuelData?.questions) ? activeDuelData.questions : [];
        const totalQ = questions.length || 10;
        const ref = dbRef.ref(`duels/${activeDuelCode}`);

        await ref.transaction((room) => {
            if (!room || room.status !== 'playing') return room;
            const hostTurn = room.hostUid === me.uid;
            const curIdx = hostTurn ? (Number(room.hostIndex) || 0) : (Number(room.guestIndex) || 0);
            if (curIdx !== hold.qIdx) return room;

            if (hostTurn) {
                room.hostIndex = curIdx + 1;
            } else {
                room.guestIndex = curIdx + 1;
            }

            if ((Number(room.hostIndex) || 0) >= totalQ && (Number(room.guestIndex) || 0) >= totalQ) {
                room.status = 'finished';
                const hs = Number(room.hostScore) || 0;
                const gs = Number(room.guestScore) || 0;
                const tugVal = Number(room.tugPosition != null ? room.tugPosition : 50);
                if (hs > gs) room.winnerUid = room.hostUid;
                else if (gs > hs) room.winnerUid = room.guestUid;
                else if (tugVal > 50) room.winnerUid = room.hostUid;
                else if (tugVal < 50) room.winnerUid = room.guestUid;
                else room.winnerUid = 'DRAW';
                room.finishedAt = Date.now();
            }
            return room;
        });
    }

    function settleFinishedDuel(room, me) {
        if (!room || !room.roomCode || settledDuelCodes.has(room.roomCode)) return;
        settledDuelCodes.add(room.roomCode);

        const isHost = room.hostUid === me.uid;
        const myScore = isHost ? (Number(room.hostScore) || 0) : (Number(room.guestScore) || 0);
        const iWon = room.winnerUid === me.uid;
        const isDraw = room.winnerUid === 'DRAW';

        if (global.userData) {
            if (!global.userData.progression) global.userData.progression = {};
            const p = global.userData.progression;
            const rpDelta = isDraw ? 5 : (iWon ? 25 : -10);
            p.rankPoints = Math.max(0, (Number(p.rankPoints) || 0) + rpDelta);
            p.rankTier = getRankTierFromPoints(p.rankPoints);
            p.duelTotal = (Number(p.duelTotal) || 0) + 1;
            if (iWon) p.duelWins = (Number(p.duelWins) || 0) + 1;
        }

        if (global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            global.GameEngine.awardProgression({ xp: iWon ? 45 : 20 });
        } else if (typeof global.saveUserData === 'function') {
            global.saveUserData();
        }
        if (typeof global.renderProfileSection === 'function' && global.currentTab === 'profile') {
            global.renderProfileSection();
        }

        saveGhostSnapshot({
            uid: me.uid,
            name: me.name,
            avatar: me.avatar,
            rankTier: (global.userData?.progression?.rankTier) || me.rankTier,
            membershipTier: me.membershipTier || 'free',
            membershipExpiresAt: me.membershipExpiresAt || 0,
            totalScore: myScore,
            durationMs: Math.max(1000, Date.now() - duelStartMs),
            timeline: duelTimeline,
            questions: room.questions || []
        });
    }

    function renderDuelReport(roomCode) {
        if (!global.GameEngine || !activeDuelData) return;
        const me = getCurrentPlayerIdentity();
        const isHost = me && activeDuelData.hostUid === me.uid;
        const myScore = isHost ? (Number(activeDuelData.hostScore) || 0) : (Number(activeDuelData.guestScore) || 0);
        const oppScore = isHost ? (Number(activeDuelData.guestScore) || 0) : (Number(activeDuelData.hostScore) || 0);
        const iWon = me && activeDuelData.winnerUid === me.uid;
        const isDraw = activeDuelData.winnerUid === 'DRAW';
        global.GameEngine.showBattleReportInContainer('duelReportContainer', {
            modeTitle: '1v1 TUG-OF-WAR DUEL',
            outcomeText: isDraw ? 'DRAW MATCH' : (iWon ? 'VICTORY!' : 'GOOD FIGHT!'),
            scoreLabel: `${myScore} vs ${oppScore}`,
            accuracy: `${Math.min(100, Math.round(myScore))}%`,
            maxCombo: (global.userData?.progression?.rankTier) || '青銅 III',
            words: (activeDuelData.questions || []).slice(0, 3).map(q => q.word)
        });
    }

    function leaveDuelRoom() {
        const roomRef = activeDuelRef;
        const roomData = activeDuelData;
        const me = getCurrentPlayerIdentity();
        if (roomRef) {
            cancelOnDisconnectRef(roomRef);
            if (me && roomData && roomData.hostUid === me.uid && roomData.status === 'waiting') {
                roomRef.remove().catch(() => {});
            }
        }
        detachActiveDuelListener();
        duelFeedbackHold = null;
        duelDeferredFinishRoom = null;
        duelAnswerLocked = false;
        activeDuelCode = null;
        activeDuelData = null;
        renderMultiplayerHub();
    }

    /* ==========================================================================
       🏆 排位即時配對佇列 (matchmakingQueue/{uid})
       ========================================================================== */

    async function tryClaimMatchmakingCandidate(snap, dbRef, me, options = {}) {
        if (!isMatchmaking || isClaimingOpponent || !snap || !dbRef || !me) return false;
        const now = Date.now();
        const candidates = [];

        snap.forEach((child) => {
            const v = child.val();
            if (!v || child.key === me.uid) return;
            const updatedAt = Number(v.updatedAt) || 0;
            if (now - updatedAt > MATCHMAKING_STALE_MS) {
                dbRef.ref(`matchmakingQueue/${child.key}`).remove().catch(() => {});
                return;
            }
            if (v.matchedRoom && String(v.matchedRoom).trim() !== '') return;
            candidates.push({ uid: child.key, ...v });
        });

        if (candidates.length === 0) return false;

        candidates.sort((a, b) => {
            const diffA = Math.abs((Number(a.rankPoints) || 0) - (Number(me.rankPoints) || 0));
            const diffB = Math.abs((Number(b.rankPoints) || 0) - (Number(me.rankPoints) || 0));
            if (diffA !== diffB) return diffA - diffB;
            return (Number(a.createdAt || a.updatedAt) || 0) - (Number(b.createdAt || b.updatedAt) || 0);
        });

        const respectTieBreak = Boolean(options && options.respectTieBreak);
        isClaimingOpponent = true;

        try {
            for (const opponent of candidates) {
                if (!isMatchmaking) return false;
                if (respectTieBreak && (Date.now() - matchmakingEnteredAt) < 1500 && String(me.uid) > String(opponent.uid)) {
                    continue;
                }

                const roomCode = await createDuelRoom({
                    uid: opponent.uid,
                    name: opponent.name || '挑戰者',
                    avatar: opponent.avatar || '',
                    rankTier: opponent.rankTier || '青銅 III',
                    membershipTier: opponent.membershipTier || 'free',
                    membershipExpiresAt: Number(opponent.membershipExpiresAt) || 0
                }, { skipSubscribe: true, silentError: true });
                if (!roomCode) continue;

                let claimTx = null;
                try {
                    const oppRef = dbRef.ref(`matchmakingQueue/${opponent.uid}`);
                    claimTx = await oppRef.transaction((curr) => {
                        if (!curr || (curr.matchedRoom && String(curr.matchedRoom).trim() !== '')) return undefined;
                        if (Date.now() - (Number(curr.updatedAt) || 0) > MATCHMAKING_STALE_MS) return undefined;
                        curr.matchedRoom = roomCode;
                        curr.matchedByUid = me.uid;
                        curr.updatedAt = Date.now();
                        return curr;
                    }, undefined, false);
                } catch (txErr) {
                    console.warn('配對認領對手交易失敗:', txErr);
                }

                if (claimTx && claimTx.committed) {
                    const myQueueRef = dbRef.ref(`matchmakingQueue/${me.uid}`);
                    cancelOnDisconnectRef(myQueueRef);
                    detachActiveQueueListener();
                    myQueueRef.remove().catch(() => {});
                    isMatchmaking = false;
                    subscribeToDuelRoom(roomCode);
                    return true;
                }

                await dbRef.ref(`duels/${roomCode}`).remove().catch(() => {});
            }
            return false;
        } finally {
            isClaimingOpponent = false;
        }
    }

    async function startMatchmaking() {
        if (!ensureLoggedInAndRtdb()) return false;
        const me = getCurrentPlayerIdentity();
        if (isMatchmaking) return false;

        detachActiveQueueListener();
        isMatchmaking = true;
        matchmakingEnteredAt = Date.now();

        const body = getModalBody();
        if (body) {
            body.innerHTML = `
                <div class="py-10 text-center space-y-4">
                    <div class="w-14 h-14 mx-auto rounded-full bg-brand-100 dark:bg-brand-950/60 text-brand-600 flex items-center justify-center text-2xl animate-spin">
                        <i class="fa-solid fa-compass"></i>
                    </div>
                    <div>
                        <div class="text-sm font-extrabold text-slate-900 dark:text-white">正在搜尋旗鼓相當的對手...</div>
                        <div class="text-xs text-slate-400 mt-1">段位：${escapeMP(me.rankTier)} (${me.rankPoints} RP)</div>
                    </div>
                    <button type="button" onclick="MultiplayerEngine.cancelMatchmaking()" class="px-5 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">
                        取消配對
                    </button>
                </div>
            `;
        }

        try {
            const dbRef = getActiveRtdb();
            const queueRef = dbRef.ref('matchmakingQueue');
            const initialSnap = await queueRef.once('value');
            const immediateMatched = await tryClaimMatchmakingCandidate(initialSnap, dbRef, me, { respectTieBreak: false });
            if (immediateMatched || !isMatchmaking) {
                return immediateMatched;
            }

            activeQueueRef = dbRef.ref(`matchmakingQueue/${me.uid}`);
            await activeQueueRef.set({
                uid: me.uid,
                name: me.name,
                avatar: me.avatar,
                rankTier: me.rankTier,
                rankPoints: me.rankPoints,
                membershipTier: me.membershipTier || 'free',
                membershipExpiresAt: me.membershipExpiresAt || 0,
                matchedRoom: '',
                createdAt: matchmakingEnteredAt,
                updatedAt: Date.now()
            });
            registerOnDisconnectRemove(activeQueueRef);

            activeQueueListener = (mySnap) => {
                const val = mySnap.val();
                if (!val || !val.matchedRoom || !isMatchmaking) return;
                const matchedCode = String(val.matchedRoom).trim();
                if (!matchedCode) return;
                const qRef = activeQueueRef;
                cancelOnDisconnectRef(qRef);
                detachActiveQueueListener();
                dbRef.ref(`matchmakingQueue/${me.uid}`).remove().catch(() => {});
                isMatchmaking = false;
                joinDuelRoom(matchedCode);
            };
            activeQueueRef.on('value', activeQueueListener);

            matchmakingScanRef = queueRef;
            matchmakingScanListener = (allSnap) => {
                if (!isMatchmaking || isClaimingOpponent) return;
                tryClaimMatchmakingCandidate(allSnap, dbRef, me, { respectTieBreak: true }).catch(() => {});
            };
            matchmakingScanRef.on('value', matchmakingScanListener);

            matchmakingScanTimer = setInterval(() => {
                if (!isMatchmaking || isClaimingOpponent) return;
                queueRef.once('value').then((s) => {
                    if (isMatchmaking && !isClaimingOpponent) {
                        return tryClaimMatchmakingCandidate(s, dbRef, me, { respectTieBreak: true });
                    }
                    return false;
                }).catch(() => {});
            }, 1500);

            matchmakingHeartbeatTimer = setInterval(() => {
                if (!isMatchmaking || !activeQueueRef) return;
                activeQueueRef.update({ updatedAt: Date.now() }).catch(() => {});
            }, 10000);

            return true;
        } catch (e) {
            detachActiveQueueListener();
            isMatchmaking = false;
            console.error('排位配對失敗:', e);
            const msg = String(e && e.message ? e.message : e || '');
            if (/permission_denied|permission denied/i.test(msg)) {
                if (typeof global.showToast === 'function') {
                    global.showToast('排位配對失敗：Firebase 即時資料庫權限不足，請確認已登入並部署最新 realtime 規則', 'error');
                }
            } else if (typeof global.showToast === 'function') {
                global.showToast('排位配對失敗：' + msg, 'error');
            }
            renderMultiplayerHub();
            return false;
        }
    }

    function cancelMatchmaking(silent = false) {
        isMatchmaking = false;
        const qRef = activeQueueRef;
        if (qRef) cancelOnDisconnectRef(qRef);
        detachActiveQueueListener();
        const me = getCurrentPlayerIdentity();
        const dbRef = getActiveRtdb();
        if (me && dbRef) {
            const myRef = dbRef.ref(`matchmakingQueue/${me.uid}`);
            cancelOnDisconnectRef(myRef);
            myRef.remove().catch(() => {});
        }
        if (!silent) renderMultiplayerHub();
    }

    /* ==========================================================================
       👻 10 題幽靈影子紀錄競速 (ghostSnapshots/{uid})
       ========================================================================== */

    async function saveGhostSnapshot(snapshot) {
        const dbRef = getActiveRtdb();
        if (!dbRef || !snapshot || !snapshot.uid) return;
        try {
            await dbRef.ref(`ghostSnapshots/${snapshot.uid}`).set({
                uid: snapshot.uid,
                name: snapshot.name || '匿名影子',
                avatar: snapshot.avatar || '',
                rankTier: snapshot.rankTier || '青銅 III',
                membershipTier: snapshot.membershipTier || 'free',
                membershipExpiresAt: Number(snapshot.membershipExpiresAt) || 0,
                totalScore: Number(snapshot.totalScore) || 0,
                durationMs: Number(snapshot.durationMs) || 30000,
                timeline: Array.isArray(snapshot.timeline) ? snapshot.timeline : [],
                questions: Array.isArray(snapshot.questions) ? snapshot.questions.slice(0, 10) : [],
                updatedAt: Date.now()
            });
        } catch (e) {
            console.warn('儲存幽靈快照失敗:', e);
        }
    }

    function getGhostScoreAtTime(timeline, elapsedMs) {
        if (!Array.isArray(timeline) || timeline.length === 0) return 0;
        let score = 0;
        for (let i = 0; i < timeline.length; i++) {
            const point = timeline[i];
            if ((Number(point.tMs) || 0) <= elapsedMs) {
                score = Number(point.score) || score;
            } else {
                break;
            }
        }
        return score;
    }

    function createAiShadowGhost() {
        const questions = buildTenQuestionDeck();
        const timeline = [];
        for (let i = 1; i <= 10; i++) {
            timeline.push({ tMs: i * 3200, score: i * 10 });
        }
        return {
            uid: 'ai_shadow_master',
            name: 'LZH 幽靈教官 (AI 紀錄)',
            rankTier: '黃金',
            totalScore: 100,
            durationMs: 32000,
            timeline,
            questions
        };
    }

    async function loadGhostSelector() {
        const body = getModalBody();
        if (!body) return;
        setModalTitle('<i class="fa-solid fa-ghost text-purple-500 mr-1.5"></i>10 題幽靈影子競速');

        let ghosts = [];
        const dbRef = getActiveRtdb();
        if (dbRef && getActiveAuthUser()) {
            try {
                const snap = await dbRef.ref('ghostSnapshots').limitToLast(10).once('value');
                snap.forEach((child) => {
                    const v = child.val();
                    if (v && Array.isArray(v.questions) && v.questions.length > 0) {
                        ghosts.push(v);
                    }
                });
            } catch (e) {}
        }

        const aiGhost = createAiShadowGhost();
        global.__cachedGhosts = [aiGhost, ...ghosts];

        body.innerHTML = `
            <div class="space-y-3">
                <div class="text-xs text-slate-500 dark:text-slate-400">選擇要挑戰的影子紀錄，系統將重播對方當時的每一秒得分進度與你同時競速！</div>
                <div class="space-y-2 max-h-72 overflow-y-auto pr-1">
                    ${global.__cachedGhosts.map((g, idx) => `
                        <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-between gap-2">
                            <div class="min-w-0">
                                <div class="text-xs font-extrabold text-slate-900 dark:text-white truncate inline-flex items-center gap-1 flex-wrap">👻 ${escapeMP(g.name)} ${renderMpMemberBadge(g.membershipTier, g.membershipExpiresAt, '2xs')}</div>
                                <div class="text-[11px] text-slate-400">${escapeMP(g.rankTier || '青銅 III')} ・總分 ${Number(g.totalScore) || 0} 分 ・耗時 ${((Number(g.durationMs) || 30000) / 1000).toFixed(1)}s</div>
                            </div>
                            <button type="button" onclick="MultiplayerEngine.startGhostRace(${idx})" class="px-3.5 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-extrabold rounded-xl shrink-0 cursor-pointer">
                                挑戰影子
                            </button>
                        </div>
                    `).join('')}
                </div>
                <button type="button" onclick="MultiplayerEngine.renderMultiplayerHub()" class="w-full py-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer">
                    返回大廳
                </button>
            </div>
        `;
    }

    function startGhostRace(cacheIdx) {
        const ghosts = global.__cachedGhosts || [createAiShadowGhost()];
        const ghost = ghosts[cacheIdx] || ghosts[0];
        const questions = (Array.isArray(ghost.questions) && ghost.questions.length >= 4)
            ? ghost.questions.slice(0, 10)
            : buildTenQuestionDeck();

        stopGhostTimer();
        ghostSession = {
            ghost,
            questions,
            index: 0,
            myScore: 0,
            startMs: Date.now(),
            timeline: [{ tMs: 0, score: 0 }],
            locked: false,
            wrongFeedback: null,
            finished: false
        };

        ghostTimerHandle = setInterval(() => {
            if (!ghostSession || ghostSession.finished) return;
            const gScoreEl = document.getElementById('ghostLiveScoreLabel');
            const gTimerEl = document.getElementById('ghostLiveTimerLabel');
            const elapsed = Date.now() - ghostSession.startMs;
            const gScore = getGhostScoreAtTime(ghostSession.ghost.timeline, elapsed);
            if (gScoreEl) gScoreEl.innerText = `${gScore} 分`;
            if (gTimerEl) gTimerEl.innerText = `${(elapsed / 1000).toFixed(1)}s`;
        }, 150);

        renderGhostRaceView();
    }

    function renderGhostRaceView() {
        const body = getModalBody();
        if (!body || !ghostSession) return;

        if (ghostSession.finished || ghostSession.index >= ghostSession.questions.length) {
            finishGhostRace();
            return;
        }

        const q = ghostSession.questions[ghostSession.index];
        const wf = ghostSession.wrongFeedback;
        const elapsed = Date.now() - ghostSession.startMs;
        const ghostScore = getGhostScoreAtTime(ghostSession.ghost.timeline, elapsed);

        body.innerHTML = `
            <div class="space-y-4">
                <div class="p-3.5 rounded-2xl bg-purple-950 text-white flex items-center justify-between text-xs font-extrabold">
                    <div>🔵 你：<span class="text-sky-300">${ghostSession.myScore} 分</span> (${ghostSession.index + 1}/${ghostSession.questions.length})</div>
                    <div id="ghostLiveTimerLabel" class="font-mono text-amber-300">${(elapsed / 1000).toFixed(1)}s</div>
                    <div>👻 影子：<span id="ghostLiveScoreLabel" class="text-purple-300">${ghostScore} 分</span></div>
                </div>

                <div class="p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="text-center py-2 space-y-1">
                        <div class="text-2xl font-black text-slate-900 dark:text-white">${escapeMP(q.word)}</div>
                        ${q.phonetic ? `<div class="text-xs font-mono text-slate-400 mt-0.5">${escapeMP(q.phonetic)}</div>` : ''}
                        ${wf ? `<div class="text-xs font-extrabold text-rose-600 dark:text-rose-400 pt-1">❌ 正解：${escapeMP(wf.correctMeaning)}</div>` : ''}
                    </div>
                    <div class="grid grid-cols-1 gap-2">
                        ${(q.options || []).map((opt, idx) => {
                            if (!wf) {
                                return `
                                    <button type="button" onclick="MultiplayerEngine.answerGhostOption(${idx})" class="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 hover:border-purple-400 text-left text-xs font-bold text-slate-800 dark:text-slate-100 transition cursor-pointer">
                                        <span class="inline-block w-5 text-slate-400 font-mono">${idx + 1}.</span>${escapeMP(opt)}
                                    </button>
                                `;
                            }
                            const isCorr = idx === wf.correctIdx;
                            const isSel = idx === wf.selectedIdx;
                            const cls = isCorr
                                ? 'p-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60 text-left text-xs font-extrabold text-emerald-800 dark:text-emerald-200 pointer-events-none flex items-center gap-2'
                                : (isSel
                                    ? 'p-3 rounded-xl border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/60 text-left text-xs font-extrabold text-rose-800 dark:text-rose-200 pointer-events-none flex items-center gap-2'
                                    : 'p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-left text-xs font-bold text-slate-400 opacity-55 pointer-events-none flex items-center gap-2');
                            const badge = isCorr ? '✓' : (isSel ? '✕' : `${idx + 1}.`);
                            return `
                                <button type="button" disabled class="${cls}">
                                    <span class="inline-block w-5 font-mono font-black">${badge}</span><span>${escapeMP(opt)}</span>
                                </button>
                            `;
                        }).join('')}
                    </div>
                    ${wf ? `
                        <button type="button" onclick="MultiplayerEngine.confirmGhostNext()" class="min-h-[44px] w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-extrabold shadow-sm transition cursor-pointer flex items-center justify-center gap-1.5">
                            <span>${ghostSession.index + 1 >= ghostSession.questions.length ? '查看競速結果' : '下一題'}</span>
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    function answerGhostOption(optionIdx) {
        if (!ghostSession || ghostSession.locked || ghostSession.finished) return;
        const q = ghostSession.questions[ghostSession.index];
        if (!q) return;

        ghostSession.locked = true;
        const isCorrect = optionIdx === q.correctIndex;
        if (isCorrect) {
            ghostSession.myScore += 10;
            if (global.GameEngine) global.GameEngine.playComboSfx(4);
        } else {
            if (global.GameEngine) global.GameEngine.playMissSfx();
        }

        const elapsed = Math.max(100, Date.now() - ghostSession.startMs);
        ghostSession.timeline.push({ tMs: elapsed, score: ghostSession.myScore });

        if (isCorrect) {
            ghostSession.wrongFeedback = null;
            ghostSession.index += 1;
            setTimeout(() => {
                if (!ghostSession) return;
                ghostSession.locked = false;
                renderGhostRaceView();
            }, 120);
        } else {
            ghostSession.wrongFeedback = {
                selectedIdx: optionIdx,
                correctIdx: q.correctIndex,
                correctMeaning: q.correctMeaning || (Array.isArray(q.options) ? q.options[q.correctIndex] : '') || ''
            };
            renderGhostRaceView();
        }
    }

    function confirmGhostNext() {
        if (!ghostSession || ghostSession.finished) return;
        ghostSession.wrongFeedback = null;
        ghostSession.locked = false;
        ghostSession.index += 1;
        renderGhostRaceView();
    }

    function finishGhostRace() {
        if (!ghostSession || ghostSession.finished) return;
        ghostSession.finished = true;
        stopGhostTimer();

        const durationMs = Math.max(500, Date.now() - ghostSession.startMs);
        const ghostScore = Number(ghostSession.ghost.totalScore) || 0;
        const ghostDuration = Number(ghostSession.ghost.durationMs) || 30000;
        const myScore = ghostSession.myScore;
        const iWon = myScore > ghostScore || (myScore === ghostScore && durationMs < ghostDuration);

        const me = getCurrentPlayerIdentity();
        if (me) {
            saveGhostSnapshot({
                uid: me.uid,
                name: me.name,
                avatar: me.avatar,
                rankTier: me.rankTier,
                membershipTier: me.membershipTier || 'free',
                membershipExpiresAt: me.membershipExpiresAt || 0,
                totalScore: myScore,
                durationMs,
                timeline: ghostSession.timeline,
                questions: ghostSession.questions
            });
        }

        if (global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            global.GameEngine.awardProgression({ xp: iWon ? 35 : 15 });
        }

        const myBadgeHtml = me ? renderMpMemberBadge(me, 0, '2xs') : '';
        const ghostBadgeHtml = renderMpMemberBadge(ghostSession.ghost.membershipTier, ghostSession.ghost.membershipExpiresAt, '2xs');
        const body = getModalBody();
        if (!body) return;
        body.innerHTML = `
            <div class="space-y-4 text-center py-2">
                <div class="text-4xl">${iWon ? '👻⚡' : '👻'}</div>
                <h4 class="text-xl font-black text-slate-900 dark:text-white">${iWon ? '超越影子紀錄！極速勝出！' : '影子略勝一籌，再接再厲！'}</h4>
                <div class="grid grid-cols-2 gap-3 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs">
                    <div>
                        <div class="font-bold text-brand-500 inline-flex items-center justify-center gap-1 flex-wrap">你的成績 ${myBadgeHtml}</div>
                        <div class="text-lg font-black text-slate-900 dark:text-white">${myScore} 分</div>
                        <div class="text-slate-400 font-mono">${(durationMs / 1000).toFixed(1)}s</div>
                    </div>
                    <div>
                        <div class="font-bold text-purple-500 inline-flex items-center justify-center gap-1 flex-wrap">${escapeMP(ghostSession.ghost.name)} ${ghostBadgeHtml}</div>
                        <div class="text-lg font-black text-slate-900 dark:text-white">${ghostScore} 分</div>
                        <div class="text-slate-400 font-mono">${(ghostDuration / 1000).toFixed(1)}s</div>
                    </div>
                </div>
                <div class="flex flex-wrap justify-center gap-2">
                    <button type="button" onclick="MultiplayerEngine.renderGhostReport(${myScore}, ${durationMs})" class="px-4 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-extrabold rounded-xl shadow-sm cursor-pointer">
                        <i class="fa-solid fa-image mr-1"></i>生成 IG 戰績圖卡
                    </button>
                    <button type="button" onclick="MultiplayerEngine.renderMultiplayerHub()" class="px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">
                        返回大廳
                    </button>
                </div>
                <div id="ghostReportContainer"></div>
            </div>
        `;
    }

    function renderGhostReport(score, durationMs) {
        if (!global.GameEngine) return;
        global.GameEngine.showBattleReportInContainer('ghostReportContainer', {
            modeTitle: '10-Q GHOST SHADOW RACE',
            outcomeText: `${(durationMs / 1000).toFixed(1)}s FINISH`,
            scoreLabel: `${score} PTS`,
            accuracy: `${Math.min(100, Math.round(score))}%`,
            maxCombo: 'SHADOW RACE',
            words: ghostSession && Array.isArray(ghostSession.questions) ? ghostSession.questions.slice(0, 3).map(q => q.word) : []
        });
    }

    /* ==========================================================================
       🐉 四人組隊打魔王副本 (raids/{raidCode})
       ========================================================================== */

    async function createRaidRoom() {
        if (!ensureLoggedInAndRtdb()) return null;
        const me = getCurrentPlayerIdentity();
        const code = generateRoomCode('R');
        const questions = buildTenQuestionDeck();

        const raidPayload = {
            raidCode: code,
            hostUid: me.uid,
            bossName: '深淵終焉魔龍・詞彙領主',
            bossMaxHp: 1200,
            bossHp: 1200,
            status: 'active',
            questions,
            members: {
                [me.uid]: {
                    name: me.name,
                    membershipTier: me.membershipTier || 'free',
                    membershipExpiresAt: me.membershipExpiresAt || 0,
                    damage: 0,
                    joinedAt: Date.now()
                }
            },
            logs: [
                { text: `🛡️ ${me.name} 發起了四人共鬥討伐戰！`, time: Date.now() }
            ],
            createdAt: Date.now()
        };

        try {
            const dbRef = getActiveRtdb();
            const raidRef = dbRef.ref(`raids/${code}`);
            await raidRef.set(raidPayload);
            registerOnDisconnectRemove(dbRef.ref(`raids/${code}/members/${me.uid}`));
            subscribeToRaidRoom(code);
            return code;
        } catch (e) {
            console.error('建立共鬥房失敗:', e);
            if (typeof global.showToast === 'function') global.showToast('建立共鬥房失敗：' + e.message, 'error');
            return null;
        }
    }

    function joinRaidFromInput() {
        const input = document.getElementById('raidJoinCodeInput');
        const code = input ? input.value.trim().toUpperCase() : '';
        if (!code) {
            if (typeof global.showToast === 'function') global.showToast('請輸入共鬥房號！', 'warning');
            return;
        }
        joinRaidRoom(code);
    }

    async function joinRaidRoom(rawCode) {
        if (!ensureLoggedInAndRtdb()) return false;
        const me = getCurrentPlayerIdentity();
        const code = String(rawCode || '').trim().toUpperCase();
        if (!code) return false;

        try {
            const dbRef = getActiveRtdb();
            const ref = dbRef.ref(`raids/${code}`);
            const nowMs = Date.now();
            let rejectReason = '';

            const txResult = await ref.transaction((data) => {
                if (data === null) return data;
                const createdAt = Number(data.createdAt) || 0;
                if (data.status !== 'cleared' && createdAt > 0 && (nowMs - createdAt) > RAID_EXPIRE_MS) {
                    rejectReason = 'expired';
                    return undefined;
                }
                const members = data.members || {};
                const memberCount = Object.keys(members).length;
                if (!members[me.uid] && memberCount >= 4) {
                    rejectReason = 'full';
                    return undefined;
                }
                if (!members[me.uid]) {
                    if (!data.members) data.members = {};
                    data.members[me.uid] = {
                        name: me.name,
                        membershipTier: me.membershipTier || 'free',
                        membershipExpiresAt: me.membershipExpiresAt || 0,
                        damage: 0,
                        joinedAt: nowMs
                    };
                }
                return data;
            });

            const finalVal = txResult && txResult.snapshot ? txResult.snapshot.val() : null;
            if (!finalVal) {
                if (typeof global.showToast === 'function') global.showToast(`找不到共鬥房「${code}」`, 'error');
                return false;
            }
            if (!txResult.committed) {
                if (rejectReason === 'expired') {
                    await ref.remove().catch(() => {});
                    if (typeof global.showToast === 'function') global.showToast('該共鬥房間已逾時關閉', 'warning');
                    return false;
                }
                if (rejectReason === 'full') {
                    if (typeof global.showToast === 'function') global.showToast('該共鬥房間已滿 4 人！', 'warning');
                    return false;
                }
            }
            registerOnDisconnectRemove(dbRef.ref(`raids/${code}/members/${me.uid}`));
            subscribeToRaidRoom(code);
            return true;
        } catch (e) {
            console.error('加入共鬥房失敗:', e);
            if (typeof global.showToast === 'function') global.showToast('加入共鬥失敗：' + e.message, 'error');
            return false;
        }
    }

    function subscribeToRaidRoom(code) {
        cleanupMultiplayerListeners();
        activeRaidCode = code;
        raidQuestionIdx = 0;
        raidPersonalDamage = 0;
        raidPersonalCorrect = 0;
        raidAnswerLocked = false;
        raidFeedback = null;

        if (typeof global.openModal === 'function') {
            global.openModal('multiplayerModal');
        } else {
            const modal = document.getElementById('multiplayerModal');
            if (modal) modal.classList.remove('hidden');
        }

        const dbRef = getActiveRtdb();
        if (!dbRef) return;
        const me = getCurrentPlayerIdentity();
        activeRaidRef = dbRef.ref(`raids/${code}`);
        activeRaidListener = (snap) => {
            const val = snap.val();
            if (!val) {
                renderMultiplayerHub();
                return;
            }
            if (val.status === 'cleared' && me) {
                cancelOnDisconnectRef(dbRef.ref(`raids/${code}/members/${me.uid}`));
            }
            activeRaidData = val;
            renderRaidRoomView(val);
        };
        activeRaidRef.on('value', activeRaidListener);
    }

    function getRaidOptionButtonStyle(idx, feedback) {
        if (!feedback) {
            return {
                btnClass: 'p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:border-rose-400 text-left text-xs font-bold text-slate-800 dark:text-slate-100 transition flex items-center gap-2 cursor-pointer',
                badgeClass: 'inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-200/70 dark:bg-slate-800 text-slate-500 font-mono text-[11px] shrink-0',
                badgeText: String(idx + 1),
                disabledAttr: ''
            };
        }
        if (idx === feedback.correctIdx) {
            return {
                btnClass: 'p-2.5 rounded-xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60 text-left text-xs font-extrabold text-emerald-800 dark:text-emerald-200 ring-2 ring-emerald-500/30 transition flex items-center gap-2 pointer-events-none',
                badgeClass: 'inline-flex items-center justify-center w-5 h-5 rounded-md bg-emerald-500 text-white font-black text-[11px] shrink-0',
                badgeText: '✓',
                disabledAttr: 'disabled'
            };
        }
        if (!feedback.isCorrect && idx === feedback.selectedIdx) {
            return {
                btnClass: 'p-2.5 rounded-xl border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/60 text-left text-xs font-extrabold text-rose-800 dark:text-rose-200 ring-2 ring-rose-500/30 transition flex items-center gap-2 pointer-events-none',
                badgeClass: 'inline-flex items-center justify-center w-5 h-5 rounded-md bg-rose-500 text-white font-black text-[11px] shrink-0',
                badgeText: '✕',
                disabledAttr: 'disabled'
            };
        }
        return {
            btnClass: 'p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-left text-xs font-bold text-slate-400 dark:text-slate-500 opacity-55 transition flex items-center gap-2 pointer-events-none',
            badgeClass: 'inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-200/70 dark:bg-slate-800 text-slate-400 font-mono text-[11px] shrink-0',
            badgeText: String(idx + 1),
            disabledAttr: 'disabled'
        };
    }

    function renderRaidRoomView(raid) {
        const body = getModalBody();
        if (!body || !raid) return;

        const hp = Math.max(0, Number(raid.bossHp) || 0);
        const maxHp = Math.max(1, Number(raid.bossMaxHp) || 1200);
        const hpPct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
        const members = raid.members ? Object.values(raid.members) : [];
        const logs = Array.isArray(raid.logs) ? raid.logs.slice(-4).reverse() : [];
        const questions = (Array.isArray(raid.questions) && raid.questions.length > 0) ? raid.questions : buildTenQuestionDeck();

        setModalTitle(`<i class="fa-solid fa-dragon text-rose-500 mr-1.5"></i>四人共鬥打王・房號 ${escapeMP(raid.raidCode)}`);

        if (hp <= 0 || raid.status === 'cleared') {
            clearRaidFeedbackTimer();
            raidFeedback = null;
            raidAnswerLocked = false;
            settleFinishedRaid(raid);
            body.innerHTML = `
                <div class="space-y-4 text-center py-2">
                    <div class="text-5xl">🎉⚔️</div>
                    <h4 class="text-xl font-black text-slate-900 dark:text-white">共鬥勝利！魔王已遭討伐！</h4>
                    <p class="text-xs text-slate-500 dark:text-slate-400">你本次貢獻傷害：${raidPersonalDamage} DMG（答對 ${raidPersonalCorrect} 題）</p>
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-1.5 text-left text-xs">
                        <div class="font-extrabold text-slate-700 dark:text-slate-200">隊伍輸出排行榜</div>
                        ${members.sort((a, b) => (Number(b.damage) || 0) - (Number(a.damage) || 0)).map(m => `
                            <div class="flex justify-between items-center gap-2">
                                <span class="font-bold text-slate-800 dark:text-slate-100 inline-flex items-center gap-1 flex-wrap">${escapeMP(m.name)} ${renderMpMemberBadge(m.membershipTier, m.membershipExpiresAt, '2xs')}</span>
                                <span class="font-mono font-extrabold text-rose-500">${Number(m.damage) || 0} DMG</span>
                            </div>
                        `).join('')}
                    </div>
                    <div class="flex flex-wrap justify-center gap-2">
                        <button type="button" onclick="MultiplayerEngine.renderRaidReport('${escapeMP(raid.raidCode)}')" class="px-4 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-extrabold rounded-xl shadow-sm cursor-pointer">
                            <i class="fa-solid fa-image mr-1"></i>生成 IG 戰績圖卡
                        </button>
                        <button type="button" onclick="MultiplayerEngine.renderMultiplayerHub()" class="px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">
                            返回大廳
                        </button>
                    </div>
                    <div id="raidReportContainer"></div>
                </div>
            `;
            return;
        }

        const currentIdx = raidQuestionIdx;
        const q = questions[currentIdx % questions.length];
        const activeFeedback = (raidFeedback && raidFeedback.questionIdx === currentIdx) ? raidFeedback : null;

        body.innerHTML = `
            <div class="space-y-3.5">
                <!-- 魔王血條與房號 -->
                <div class="p-4 rounded-2xl bg-gradient-to-br from-rose-950 to-slate-900 text-white space-y-2.5">
                    <div class="flex items-center justify-between text-xs">
                        <span class="font-extrabold text-rose-300">🐉 ${escapeMP(raid.bossName)}</span>
                        <span class="font-mono text-amber-300">房號 ${escapeMP(raid.raidCode)} (${members.length}/4人)</span>
                    </div>
                    <div class="w-full h-3.5 bg-slate-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-rose-500 to-amber-400 transition-all duration-200" style="width:${hpPct}%"></div>
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-slate-300">
                        <span>團隊累計輸出：${maxHp - hp}</span>
                        <span class="font-mono font-bold">${hp} / ${maxHp} HP</span>
                    </div>
                    ${members.length < 4 ? `
                        <div class="pt-1 flex justify-end">
                            <button type="button" onclick="if(typeof openFriendOnlyInviteModal==='function') openFriendOnlyInviteModal({ mode: 'raid', raidCode: '${escapeMP(raid.raidCode)}', groupName: decodeURIComponent('${encodeURIComponent(raid.bossName || '四人共鬥打王')}') })" class="px-2.5 py-1 bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-[11px] rounded-lg transition cursor-pointer flex items-center gap-1 shadow-xs">
                                <i class="fa-solid fa-user-plus"></i>
                                <span>邀請好友組隊</span>
                            </button>
                        </div>
                    ` : ''}
                </div>

                <!-- 隊友即時動態 -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px]">
                    ${members.map(m => `
                        <div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-0.5 min-w-0">
                            <div class="font-bold text-slate-800 dark:text-slate-100 truncate">${escapeMP(m.name)}</div>
                            ${renderMpMemberBadge(m.membershipTier, m.membershipExpiresAt, '2xs')}
                            <div class="font-mono font-extrabold text-rose-500">${Number(m.damage) || 0} DMG</div>
                        </div>
                    `).join('')}
                </div>

                <!-- 題目區 -->
                <div class="p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="text-center space-y-1">
                        <div class="text-2xl font-black text-slate-900 dark:text-white">${escapeMP(q.word)}</div>
                        ${q.phonetic ? `<div class="text-xs font-mono text-slate-400">${escapeMP(q.phonetic)}</div>` : ''}
                        ${activeFeedback && activeFeedback.message ? `
                            <div class="text-xs font-extrabold pt-1 ${activeFeedback.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
                                ${escapeMP(activeFeedback.message)}
                            </div>
                        ` : ''}
                    </div>
                    <div class="grid grid-cols-1 gap-2">
                        ${(q.options || []).map((opt, idx) => {
                            const style = getRaidOptionButtonStyle(idx, activeFeedback);
                            return `
                                <button type="button" ${style.disabledAttr} onclick="MultiplayerEngine.attackRaidBoss(${idx}, ${currentIdx})" class="${style.btnClass}">
                                    <span class="${style.badgeClass}">${style.badgeText}</span>
                                    <span class="flex-1">${escapeMP(opt)}</span>
                                </button>
                            `;
                        }).join('')}
                    </div>
                    ${activeFeedback && !activeFeedback.isCorrect ? `
                        <button type="button" onclick="MultiplayerEngine.confirmRaidWrongNext()" class="min-h-[44px] w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold shadow-xs transition cursor-pointer flex items-center justify-center gap-1.5">
                            <span>下一題</span>
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    ` : ''}
                </div>

                <!-- 戰場即時紀錄 -->
                ${logs.length > 0 ? `
                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
                        ${logs.map(l => `<div class="truncate">${escapeMP(l.text)}</div>`).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    async function attackRaidBoss(optionIdx, expectedIdx = null) {
        if (raidAnswerLocked || !activeRaidCode || !activeRaidData) return;
        if (expectedIdx !== null && Number(expectedIdx) !== raidQuestionIdx) return;

        const me = getCurrentPlayerIdentity();
        if (!me) return;

        const questions = (Array.isArray(activeRaidData.questions) && activeRaidData.questions.length > 0)
            ? activeRaidData.questions
            : buildTenQuestionDeck();
        const targetIdx = raidQuestionIdx;
        const q = questions[targetIdx % questions.length];
        if (!q || activeRaidData.status === 'cleared' || (Number(activeRaidData.bossHp) || 0) <= 0) return;

        const selectedIdx = Number(optionIdx);
        const correctIdx = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
        const isCorrect = selectedIdx === correctIdx;
        const correctText = q.correctMeaning || (Array.isArray(q.options) ? q.options[correctIdx] : '') || '';
        const roomCodeSnap = activeRaidCode;

        // 1. 立即上鎖並保存當下題號快照，先在畫面上高亮顯示正確/錯誤選項
        raidAnswerLocked = true;
        raidFeedback = {
            questionIdx: targetIdx,
            selectedIdx,
            correctIdx,
            isCorrect,
            message: isCorrect ? '⚔️ 命中要害！造成 120 點暴擊傷害！' : `❌ 閃避了！正解：${correctText}`
        };
        renderRaidRoomView(activeRaidData);

        if (isCorrect) {
            const dmg = 120;
            raidPersonalDamage += dmg;
            raidPersonalCorrect += 1;
            if (global.GameEngine) global.GameEngine.playComboSfx(5);

            const dbRef = getActiveRtdb();
            if (dbRef) {
                try {
                    await dbRef.ref(`raids/${roomCodeSnap}`).transaction((raid) => {
                        if (!raid || raid.status === 'cleared') return raid;
                        const nextHp = Math.max(0, (Number(raid.bossHp) || 0) - dmg);
                        raid.bossHp = nextHp;
                        if (!raid.members) raid.members = {};
                        if (!raid.members[me.uid]) {
                            raid.members[me.uid] = {
                                name: me.name,
                                membershipTier: me.membershipTier || 'free',
                                membershipExpiresAt: me.membershipExpiresAt || 0,
                                damage: 0
                            };
                        } else {
                            raid.members[me.uid].membershipTier = me.membershipTier || 'free';
                            raid.members[me.uid].membershipExpiresAt = me.membershipExpiresAt || 0;
                        }
                        raid.members[me.uid].damage = (Number(raid.members[me.uid].damage) || 0) + dmg;
                        if (!Array.isArray(raid.logs)) raid.logs = [];
                        raid.logs.push({ text: `⚔️ ${me.name} 命中「${q.word}」，造成 ${dmg} 點暴擊傷害！`, time: Date.now() });
                        if (raid.logs.length > 15) raid.logs = raid.logs.slice(-15);
                        if (nextHp <= 0) {
                            raid.status = 'cleared';
                            raid.clearedAt = Date.now();
                        }
                        return raid;
                    });
                } catch (e) {
                    console.error('共鬥傷害同步失敗:', e);
                }
            }

            // 2. 答對後短暫展示命中回饋，接著自動推進下一題
            clearRaidFeedbackTimer();
            raidFeedbackTimer = setTimeout(() => {
                raidFeedbackTimer = null;
                if (activeRaidCode !== roomCodeSnap || !activeRaidData) return;
                if (activeRaidData.status === 'cleared' || (Number(activeRaidData.bossHp) || 0) <= 0) {
                    raidFeedback = null;
                    raidAnswerLocked = false;
                    return;
                }
                raidFeedback = null;
                raidQuestionIdx = targetIdx + 1;
                raidAnswerLocked = false;
                renderRaidRoomView(activeRaidData);
            }, 280);
        } else {
            if (global.GameEngine) global.GameEngine.playMissSfx();
            clearRaidFeedbackTimer();
        }
    }

    function confirmRaidWrongNext() {
        clearRaidFeedbackTimer();
        if (!activeRaidData) {
            raidFeedback = null;
            raidAnswerLocked = false;
            return;
        }
        if (activeRaidData.status === 'cleared' || (Number(activeRaidData.bossHp) || 0) <= 0) {
            raidFeedback = null;
            raidAnswerLocked = false;
            renderRaidRoomView(activeRaidData);
            return;
        }
        const curQ = raidFeedback ? raidFeedback.questionIdx : raidQuestionIdx;
        raidFeedback = null;
        raidQuestionIdx = curQ + 1;
        raidAnswerLocked = false;
        renderRaidRoomView(activeRaidData);
    }

    function settleFinishedRaid(raid) {
        if (!raid || !raid.raidCode || settledRaidCodes.has(raid.raidCode)) return;
        settledRaidCodes.add(raid.raidCode);
        if (global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            global.GameEngine.awardProgression({ xp: 80 });
        }
        if (typeof global.renderProfileSection === 'function' && global.currentTab === 'profile') {
            global.renderProfileSection();
        }
    }

    function renderRaidReport() {
        if (!global.GameEngine || !activeRaidData) return;
        global.GameEngine.showBattleReportInContainer('raidReportContainer', {
            modeTitle: '4-PLAYER CO-OP RAID',
            outcomeText: 'BOSS SLAIN!',
            scoreLabel: `${raidPersonalDamage} DMG`,
            accuracy: `${raidPersonalCorrect} HITS`,
            maxCombo: 'CO-OP VICTORY',
            words: Array.isArray(activeRaidData.questions) ? activeRaidData.questions.slice(0, 3).map(q => q.word) : []
        });
    }

    const MultiplayerEngine = {
        getRankTierFromPoints,
        openModal,
        closeModal,
        switchHubTab,
        renderMultiplayerHub,
        openDuelFromDeepLink,
        checkUrlDuelInvite,
        getPendingDuelCode: () => pendingDuelCode,
        createDuelRoom,
        joinDuelRoom,
        joinDuelFromInput,
        copyDuelInviteLink,
        answerDuelQuestion,
        confirmDuelWrongNext,
        renderDuelReport,
        leaveDuelRoom,
        startMatchmaking,
        cancelMatchmaking,
        saveGhostSnapshot,
        getGhostScoreAtTime,
        loadGhostSelector,
        startGhostRace,
        answerGhostOption,
        confirmGhostNext,
        renderGhostReport,
        createRaidRoom,
        joinRaidRoom,
        joinRaidFromInput,
        attackRaidBoss,
        confirmRaidWrongNext,
        renderRaidReport,
        cleanupMultiplayerListeners
    };

    global.MultiplayerEngine = MultiplayerEngine;
})(typeof window !== 'undefined' ? window : globalThis);
