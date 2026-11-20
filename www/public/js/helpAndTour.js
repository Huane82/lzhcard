/**
 * LZHCard - 啟動深層連結排隊器 (StartupDeepLinkQueue)、
 * 9 步驟全景互動新手教學 (OnboardingTour) 與 App 獨家特色指南 & FSRS 百科 (HelpManualModal)
 */
(function (global) {
    'use strict';

    const ONBOARDING_V2_KEY = 'lzhcard_onboarding_v2_done';
    const ONBOARDING_V1_KEY = 'lzhcard_onboarding_completed';

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isFirstTimeV2User() {
        try {
            return localStorage.getItem(ONBOARDING_V2_KEY) !== 'true';
        } catch (e) {
            return true;
        }
    }

    function isModalVisible(id) {
        if (typeof document === 'undefined') return false;
        const el = document.getElementById(id);
        return Boolean(el && !el.classList.contains('hidden'));
    }

    /* ==========================================================================
       1. 啟動深層連結排隊器 (StartupDeepLinkQueue)
       ========================================================================== */

    let readyDeepLinkAction = null;
    let deepLinkExecuted = false;

    async function handleStoreDeckDeepLink(deckId) {
        const cleanDeckId = String(deckId || '').trim();
        if (!cleanDeckId) return false;

        if (typeof global.switchTab === 'function') {
            global.switchTab('store');
        }

        if ((!Array.isArray(global.storeDecks) || global.storeDecks.length === 0) && typeof global.renderStore === 'function') {
            try {
                await global.renderStore();
            } catch (e) {
                console.warn('載入商店字庫失敗：', e);
            }
        }

        let targetDeck = Array.isArray(global.storeDecks)
            ? global.storeDecks.find(d => d && d.id === cleanDeckId)
            : null;

        if (!targetDeck && typeof db !== 'undefined' && db) {
            try {
                const snap = await db.collection('storeDecks').doc(cleanDeckId).get();
                if (snap.exists) {
                    targetDeck = { id: snap.id, ...snap.data() };
                    if (Array.isArray(global.storeDecks)) {
                        global.storeDecks.unshift(targetDeck);
                    }
                }
            } catch (e) {
                console.warn('讀取深層連結商店字庫失敗：', e);
            }
        }

        if (targetDeck && typeof global.openStoreDeckPreview === 'function') {
            global.openStoreDeckPreview(targetDeck.id);
            return true;
        }

        if (typeof global.showToast === 'function') {
            global.showToast('找不到該分享字庫（可能已下架或連結失效）', 'warning');
        }
        return false;
    }

    async function handleProfileDeepLink(uid) {
        const cleanUid = String(uid || '').trim();
        if (!cleanUid) {
            if (typeof global.showToast === 'function') {
                global.showToast('找不到該玩家檔案（可能已註銷）', 'warning');
            }
            return false;
        }
        if (typeof global.openProfileByUid === 'function') {
            return await global.openProfileByUid(cleanUid);
        }
        if (typeof global.openPlayerProfileModal === 'function') {
            return await global.openPlayerProfileModal(cleanUid, '', { strictLookup: true });
        }
        return false;
    }

    function handleDuelDeepLink(rawCode) {
        const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code) return false;
        if (typeof global.MultiplayerEngine !== 'undefined' && typeof global.MultiplayerEngine.openDuelFromDeepLink === 'function') {
            return global.MultiplayerEngine.openDuelFromDeepLink(code);
        }
        if (typeof global.MultiplayerEngine !== 'undefined' && typeof global.MultiplayerEngine.checkUrlDuelInvite === 'function') {
            return global.MultiplayerEngine.checkUrlDuelInvite(code);
        }
        return false;
    }

    function buildDeepLinkPayloadFromLocation(loc) {
        if (!loc) return null;
        const searchStr = loc.search || '';
        const hashStr = loc.hash || '';
        let params;
        try {
            params = new URLSearchParams(searchStr);
        } catch (e) {
            params = null;
        }

        const deckParam = params ? (params.get('deck') || params.get('share')) : '';
        const profileParam = params ? params.get('profile') : '';
        const duelParam = params ? params.get('duel') : '';
        const hashDeck = (!deckParam && hashStr.startsWith('#share='))
            ? (() => {
                try { return decodeURIComponent(hashStr.slice(7)); } catch (e) { return hashStr.slice(7); }
            })()
            : '';

        const resolvedDeck = String(deckParam || hashDeck || '').trim();
        const resolvedProfile = String(profileParam || '').trim();
        const resolvedDuel = String(duelParam || '').trim();

        if (resolvedDeck) {
            return {
                type: 'deck',
                value: resolvedDeck,
                action: () => handleStoreDeckDeepLink(resolvedDeck)
            };
        }
        if (resolvedProfile) {
            return {
                type: 'profile',
                value: resolvedProfile,
                action: () => handleProfileDeepLink(resolvedProfile)
            };
        }
        if (resolvedDuel) {
            return {
                type: 'duel',
                value: resolvedDuel,
                action: () => handleDuelDeepLink(resolvedDuel)
            };
        }
        return null;
    }

    function clearBrowserUrlParams() {
        if (typeof window === 'undefined' || !window.history || typeof window.history.replaceState !== 'function') return;
        try {
            const cleanPath = window.location.pathname || '/';
            window.history.replaceState({}, document.title || '', cleanPath);
        } catch (e) {}
    }

    function captureInitialDeepLinks(customLocation = null) {
        const loc = customLocation || (typeof window !== 'undefined' ? window.location : null);
        const payload = buildDeepLinkPayloadFromLocation(loc);
        if (!payload) return null;

        deepLinkExecuted = false;

        // 統一立即清理網址列參數，防止使用者重新整理時重複觸發
        if (!customLocation) {
            clearBrowserUrlParams();
        }

        if (isFirstTimeV2User()) {
            // 新手優先權鎖定：暫緩彈窗，封裝動作至 window.__pendingDeepLinkAction 待教學結束後接力
            global.__pendingDeepLinkAction = payload.action;
            readyDeepLinkAction = null;
        } else {
            // 老玩家不需經過教學，待 App 資料載入就緒後立即放行
            global.__pendingDeepLinkAction = null;
            readyDeepLinkAction = payload.action;
        }

        return payload;
    }

    function flushPendingDeepLink() {
        if (typeof global.__pendingDeepLinkAction === 'function') {
            const action = global.__pendingDeepLinkAction;
            global.__pendingDeepLinkAction = null;
            readyDeepLinkAction = null;
            deepLinkExecuted = true;
            return Promise.resolve(action());
        }
        if (!deepLinkExecuted && typeof readyDeepLinkAction === 'function') {
            const action = readyDeepLinkAction;
            readyDeepLinkAction = null;
            deepLinkExecuted = true;
            return Promise.resolve(action());
        }
        return Promise.resolve(false);
    }

    function processWhenReady() {
        if (isFirstTimeV2User()) {
            return false;
        }
        if (isModalVisible('welcomeModal') || isModalVisible('onboardingSetupModal') || isModalVisible('onboardingTourOverlay')) {
            return false;
        }
        if (typeof readyDeepLinkAction === 'function' && !deepLinkExecuted) {
            flushPendingDeepLink();
            return true;
        }
        return false;
    }

    // 腳本載入當下立即攔截並清除網址列參數，避免任何 DOMContentLoaded 搶先彈窗
    if (typeof window !== 'undefined') {
        captureInitialDeepLinks();
    }

    /* ==========================================================================
       2. 全景互動式新手教學 (OnboardingTour，完整 9 大核心步驟)
       ========================================================================== */

    const ONBOARDING_V2_STEPS = [
        {
            targetId: 'headerCategorySelector',
            tab: 'home',
            badge: '智慧字庫 1 / 9',
            title: '1. 智慧去重與跨字庫連動',
            desc: 'LZHCard 擁有獨特的「同字庫自動去重複、不同字庫保留分類但共用記憶進度」引擎！無論同一個單字同時出現在「7000 單 L3」還是「模擬考錯題本」，刷卡升級都會雙向同步，徹底告別換書重背的痛苦。'
        },
        {
            targetId: 'homeCardFlashcard',
            tab: 'home',
            badge: '雙軌引擎 2 / 9',
            title: '2. 雙軌記憶（FSRS 排程 vs. 自由練習）',
            desc: '正式「FSRS 排程」依科學遺忘曲線計算記憶穩定度，適合每日長期累積；「自由加練」採用 6 字焦點池與臨時等級 freeLevel，專為考前衝刺設計，絕不打亂你的正式排程！'
        },
        {
            targetId: 'bnav-list',
            tab: 'home',
            badge: '自動分級 3 / 9',
            title: '3. 一鍵字庫與 7000 單自動分級',
            desc: '切換至「字庫管理」可一鍵匯入或批次新增單字，系統會自動標記 108 課綱 7000 單 L1～L6 與冷門字難度標籤，並透過 AI 自動補齊音標、詞性、道地例句與中文翻譯。'
        },
        {
            targetId: 'homeCardQuiz',
            tab: 'home',
            badge: 'AI 實戰考場 4 / 9',
            title: '4. 四大實戰 AI 考試模式',
            desc: '內建「語境挖空拼寫」、「三步驟句構重組翻譯」、「學測型閱讀篇章（支援點字即時翻譯）」與「10 選 10 文意選填」。所有考試只會增減臨時等級 freeLevel，放心刷題不傷正式記憶排程！'
        },
        {
            targetId: 'homeGamePortalContainer',
            tab: 'home',
            badge: '單人冒險 5 / 9',
            title: '5. 單人遊戲化與深淵魔王討伐',
            desc: '刷卡連擊可啟動 Fever 2x XP 光環，累計 10 次複習可開啟「每日神秘寶箱」！還能挑戰「60 秒街機衝刺」，以及專治錯 3 次以上頑固單字的「深淵魔王懸賞」。'
        },
        {
            targetId: 'homeMultiplayerEntry',
            fallbackTargetId: 'homeGamePortalContainer',
            tab: 'home',
            badge: '多人連線 6 / 9',
            title: '6. 即時連線對戰與賽季排位',
            desc: '隨時邀請好友來場「1v1 拔河排位賽」、挑戰「10 題幽靈競速」超越歷史影子，或加入「四人共鬥打王」協力消滅 BOSS，累積賽季積分衝刺傳說段位！'
        },
        {
            targetId: 'bnav-settings',
            tab: 'home',
            badge: '檔案與商城 7 / 9',
            title: '7. 個人檔案、連結分享與隱私商城',
            desc: '在個人檔案自訂頭像框與稱號、分享專屬名片連結，或逛逛社群字庫商店！接下來帶你看看系統設定裡的兩個超實用學習開關。'
        },
        {
            targetId: 'settingsAudioSlot',
            tab: 'home',
            openSettings: true,
            badge: '語音偏好 8 / 9',
            title: '8. 設定：單字卡自動播放發音',
            desc: '在設定抽屜的「學習與語音偏好」中，可隨時切換「單字卡自動播放發音」（預設為關閉）。開啟後每次進入或切換下一張單字卡時都會自動朗讀發音，並內建防重疊機制！'
        },
        {
            targetId: 'settingsFrontSentenceSlot',
            tab: 'home',
            openSettings: true,
            badge: '語境推理 9 / 9',
            title: '9. 設定：字卡正面／背面顯示例句',
            desc: '這裡可自由切換「字卡正面顯示例句（語境推理模式）」（預設例句僅在背面顯示）。開啟後翻牌前就會在正面顯示原句並高亮目標單字，訓練從上下文推敲字義的能力！'
        }
    ];

    let tourCurrentIndex = 0;
    let tourIsActive = false;
    let tourResizeHandler = null;

    function ensureSettingsDrawerState(shouldOpen) {
        if (typeof document === 'undefined') return;
        const drawer = document.getElementById('settingsDrawer');
        const isCurrentlyOpen = Boolean(drawer && !drawer.classList.contains('hidden'));

        if (shouldOpen) {
            if (!isCurrentlyOpen) {
                if (typeof global.openSettingsDrawer === 'function') {
                    global.openSettingsDrawer();
                } else if (drawer) {
                    const backdrop = document.getElementById('settingsDrawerBackdrop');
                    const panel = document.getElementById('settingsDrawerPanel');
                    drawer.classList.remove('hidden');
                    if (backdrop) backdrop.classList.remove('opacity-0');
                    if (panel) panel.classList.remove('-translate-x-full');
                }
            }
        } else if (isCurrentlyOpen) {
            if (typeof global.closeSettingsDrawer === 'function') {
                global.closeSettingsDrawer();
            } else if (drawer) {
                drawer.classList.add('hidden');
            }
        }
    }

    function resolveTourTarget(step) {
        if (typeof document === 'undefined' || !step) return null;
        const primary = step.targetId ? document.getElementById(step.targetId) : null;
        if (primary) {
            const rect = primary.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return primary;
        }
        if (step.fallbackTargetId) {
            const fb = document.getElementById(step.fallbackTargetId);
            if (fb) {
                const rect = fb.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return fb;
            }
        }
        return null;
    }

    function positionTourPopover(stepIndex) {
        if (typeof document === 'undefined') return;
        const step = ONBOARDING_V2_STEPS[stepIndex];
        if (!step) return;

        const highlightBox = document.getElementById('tourHighlightBox');
        const popover = document.getElementById('tourPopover');
        const badgeEl = document.getElementById('tourStepBadge');
        const titleEl = document.getElementById('tourStepTitle');
        const descEl = document.getElementById('tourStepDesc');
        const prevBtn = document.getElementById('tourPrevBtn');
        const nextBtn = document.getElementById('tourNextBtn');

        if (!highlightBox || !popover) return;

        if (badgeEl) badgeEl.textContent = step.badge || `${stepIndex + 1} / ${ONBOARDING_V2_STEPS.length}`;
        if (titleEl) titleEl.textContent = step.title;
        if (descEl) descEl.textContent = step.desc;

        if (prevBtn) prevBtn.disabled = (stepIndex === 0);
        if (nextBtn) {
            if (stepIndex === ONBOARDING_V2_STEPS.length - 1) {
                nextBtn.innerHTML = '<span>開始學習</span> <i class="fa-solid fa-check ml-1"></i>';
                nextBtn.className = 'px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-extrabold transition shadow-xs cursor-pointer';
            } else {
                nextBtn.innerHTML = '<span>下一步</span> <i class="fa-solid fa-chevron-right ml-1"></i>';
                nextBtn.className = 'px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-extrabold transition shadow-xs cursor-pointer';
            }
        }

        const winW = window.innerWidth || 375;
        const winH = window.innerHeight || 667;
        const safeMarginTop = 16;
        const safeMarginBottom = 20;

        if (step.openSettings && step.targetId && typeof global.expandSettingsAccordionForElement === 'function') {
            const rawTarget = document.getElementById(step.targetId);
            if (rawTarget) global.expandSettingsAccordionForElement(rawTarget);
        }

        const targetElem = resolveTourTarget(step);
        if (targetElem) {
            try {
                if (typeof targetElem.scrollIntoView === 'function') {
                    targetElem.scrollIntoView({
                        block: step.openSettings ? 'center' : 'nearest',
                        behavior: 'auto'
                    });
                }
            } catch (e) {}

            const rect = targetElem.getBoundingClientRect();
            const pad = 6;
            const boxTop = Math.max(4, rect.top - pad);
            const boxLeft = Math.max(4, rect.left - pad);
            const boxWidth = Math.min(winW - 8, rect.width + pad * 2);
            const boxHeight = Math.min(winH - 8, rect.height + pad * 2);

            highlightBox.classList.remove('hidden');
            highlightBox.style.top = `${boxTop}px`;
            highlightBox.style.left = `${boxLeft}px`;
            highlightBox.style.width = `${Math.max(24, boxWidth)}px`;
            highlightBox.style.height = `${Math.max(24, boxHeight)}px`;

            const popWidth = Math.min(340, winW - 24);
            popover.style.width = `${popWidth}px`;
            const popHeight = Math.min(popover.offsetHeight || 220, winH - safeMarginTop - safeMarginBottom);

            let popTop = rect.bottom + 14;
            if (popTop + popHeight > winH - safeMarginBottom) {
                popTop = rect.top - popHeight - 14;
            }
            if (popTop < safeMarginTop) {
                popTop = Math.max(safeMarginTop, Math.round((winH - popHeight) / 2));
            }
            popTop = Math.min(popTop, Math.max(safeMarginTop, winH - popHeight - safeMarginBottom));

            let popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
            popLeft = Math.max(12, Math.min(popLeft, winW - popWidth - 12));

            popover.style.top = `${popTop}px`;
            popover.style.left = `${popLeft}px`;
        } else {
            highlightBox.classList.add('hidden');
            const popWidth = Math.min(340, winW - 24);
            popover.style.width = `${popWidth}px`;
            const popHeight = Math.min(popover.offsetHeight || 220, winH - 40);
            popover.style.top = `${Math.max(safeMarginTop, Math.round((winH - popHeight) / 2))}px`;
            popover.style.left = `${Math.max(12, Math.round((winW - popWidth) / 2))}px`;
        }
    }

    function renderTourStep(index) {
        if (index < 0 || index >= ONBOARDING_V2_STEPS.length) {
            finishOnboardingTour();
            return;
        }
        tourCurrentIndex = index;
        const step = ONBOARDING_V2_STEPS[index];

        if (step.tab && typeof global.switchTab === 'function') {
            global.switchTab(step.tab);
        }

        ensureSettingsDrawerState(Boolean(step.openSettings));

        positionTourPopover(index);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (tourIsActive && tourCurrentIndex === index) {
                    positionTourPopover(index);
                }
            });
        }
        if (step.openSettings) {
            setTimeout(() => {
                if (tourIsActive && tourCurrentIndex === index) {
                    positionTourPopover(index);
                }
            }, 240);
        }
    }

    function startOnboardingTour(options = {}) {
        const replay = Boolean(options && options.replay);
        if (!replay && !isFirstTimeV2User()) {
            return false;
        }
        if (!replay && (isModalVisible('welcomeModal') || isModalVisible('onboardingSetupModal'))) {
            return false;
        }
        if (typeof document === 'undefined') return false;

        if (typeof global.closeSettingsDrawer === 'function') global.closeSettingsDrawer();
        if (typeof global.closeModal === 'function') {
            global.closeModal('onboardingSetupModal');
            global.closeModal('helpManualModal');
        }

        const overlay = document.getElementById('onboardingTourOverlay');
        if (!overlay) return false;

        tourIsActive = true;
        tourCurrentIndex = 0;
        overlay.classList.remove('hidden');
        overlay.style.pointerEvents = 'auto';

        if (!tourResizeHandler) {
            tourResizeHandler = () => {
                if (tourIsActive) positionTourPopover(tourCurrentIndex);
            };
            window.addEventListener('resize', tourResizeHandler);
        }

        renderTourStep(0);
        return true;
    }

    function prevTourStep() {
        if (!tourIsActive) return;
        if (tourCurrentIndex > 0) {
            renderTourStep(tourCurrentIndex - 1);
        }
    }

    function nextTourStep() {
        if (!tourIsActive) return;
        if (tourCurrentIndex < ONBOARDING_V2_STEPS.length - 1) {
            renderTourStep(tourCurrentIndex + 1);
        } else {
            finishOnboardingTour();
        }
    }

    function finishOnboardingTour() {
        tourIsActive = false;
        ensureSettingsDrawerState(false);

        if (tourResizeHandler && typeof window !== 'undefined') {
            window.removeEventListener('resize', tourResizeHandler);
            tourResizeHandler = null;
        }

        if (typeof document !== 'undefined') {
            const overlay = document.getElementById('onboardingTourOverlay');
            const highlightBox = document.getElementById('tourHighlightBox');
            const popover = document.getElementById('tourPopover');
            if (overlay) {
                overlay.classList.add('hidden');
                overlay.style.pointerEvents = 'none';
            }
            if (highlightBox) {
                highlightBox.style.top = '';
                highlightBox.style.left = '';
                highlightBox.style.width = '';
                highlightBox.style.height = '';
            }
            if (popover) {
                popover.style.top = '';
                popover.style.left = '';
            }
        }

        try {
            localStorage.setItem(ONBOARDING_V2_KEY, 'true');
            localStorage.setItem(ONBOARDING_V1_KEY, 'true');
        } catch (e) {}

        if (typeof global.saveStorage === 'function') {
            global.saveStorage();
        }
        if (typeof global.switchTab === 'function') {
            global.switchTab('home');
        }

        // 教學關閉並徹底清除遮罩後的 250ms（<= 300ms），檢查並接力執行排隊中的深層連結彈窗
        setTimeout(() => {
            if (typeof global.__pendingDeepLinkAction === 'function') {
                flushPendingDeepLink();
            }
        }, 250);

        return true;
    }

    /* ==========================================================================
       3. App 獨家特色指南 & FSRS 記憶原理百科 (HelpManualModal)
       ========================================================================== */

    const HELP_MANUAL_TABS = [
        {
            id: 'features',
            label: '🌟 獨家特色指南',
            heading: '【為什麼選 LZHCard？獨家設計與常見疑慮解答】',
            faqs: [
                {
                    q: 'Q1：為什麼很多單字 App 換一本單字書就要重頭背？LZHCard 如何解決？',
                    a: 'LZHCard 採用獨家「雙層智慧去重與跨字庫連動」引擎：在同一字庫內匯入相同單字會自動去重複；而在不同字庫（例如「7000 單 L3」與「模擬考錯題本」）之間則會保留各自的分類標籤方便篩選，但底層記憶進度（包含 FSRS 正式等級、Stability 穩定度與自由練習 freeLevel）雙向連動共用。只要在任一字庫熟練這個字，其他字庫裡的同一單字也會同步升級！'
                },
                {
                    q: 'Q2：考前臨時抱佛腳會不會打亂我累積了好幾個月的 FSRS 排程？',
                    a: '完全不會！系統實作了「雙軌記憶隔離架構」：正式卡片排程使用 FSRS 欄位（level、stability、difficulty、nextReview），負責精準追蹤長期遺忘曲線；而當你切換為「自由加練」模式，或是進入「四大實戰 AI 考試模式」、「60 秒街機」、「深淵魔王」刷題時，系統只會修改「臨時等級 freeLevel / freeStreak」與 6 字焦點池排序，絕對不會污染或重置正式 FSRS 排程。此外，每日也會貼心提供將正式等級對齊至臨時等級的同步機制。'
                },
                {
                    q: 'Q3：同時學英文和日文、或跟家人共用同一台手機時，單字和進度會混在一起嗎？',
                    a: '不會混雜。首先，在「跨語言隔離」方面，系統透過字卡 lang 欄位與假名／JLPT 字庫正則自動辨識（isCardMatchingTargetLang），確保英語出題、干擾項與對戰打怪題庫絕不混入日文單字；其次，在「多帳號隔離」方面，本機 IndexedDB（LocalIDB）與 localStorage 快取全面採用 Firebase UID 命名空間隔離，登出或切換帳號時會自動清空前一位使用者的暫存設定與未完成同步狀態。'
                },
                {
                    q: 'Q4：AI 學測考試模式中，遇到文章有沒背過的字或不知道怎麼翻成英文怎麼辦？',
                    a: '完全不用怕卡關！在「中翻英句構重組」模式中，AI 若使用了勾選字庫以外的實詞，題目下方會自動亮出「💡 本題額外單字提示區（附原型、詞性與中文）」，且透過「Step 1 語塊調語序 → Step 2 補功能詞 → Step 3 寫完評分」三段引導，讓你聚焦訓練真正的中英句法差異；而在「學測綜合閱讀」與「10 選 10 文意選填」中，文章每個單字都支援「即時點擊翻譯彈窗」，一點就能查釋義、聽發音或一鍵加入字庫！'
                },
                {
                    q: 'Q5：搭捷運沒有網路，或在圖書館不想外放音效時怎麼使用？',
                    a: 'LZHCard 具備 Offline-First 本機離線架構，所有單字卡與複習進度皆優先儲存於瀏覽器／App 內建的 IndexedDB（LocalIDB），沒有網路依然能流暢刷字卡、跑 FSRS 排程或玩單人競技場，待恢復連線後再自動同步回雲端；音效則完全由 Web Audio API 即時程式化合成（無外部音檔延遲），點擊戰鬥 HUD 或首頁的小喇叭按鈕即可一鍵靜音，靜音狀態也會記憶保留。'
                }
            ]
        },
        {
            id: 'fsrs',
            label: '🧠 FSRS 記憶百科',
            heading: '【FSRS 記憶演算法百科（自問自答 FAQ）】',
            faqs: [
                {
                    q: 'Q1：什麼是「記憶穩定度（Stability）」？90% 保留率跟傳統 SM-2（舊版 Anki）差在哪？',
                    a: '「記憶穩定度（Stability, S）」代表你對一個單字從記憶保留率 100% 下降到 90% 所需要的天數。傳統 SM-2 只用固定的簡易係數（Ease Factor）做倍數乘法，常導致「太簡單一直複習」或「太難反覆被卡死（Ease Hell）」；而現代 FSRS 演算法會同時追蹤記憶難度（Difficulty, D）與經過時間的保留率（Retrievability, R），精準抓在遺忘機率剛接近 10%（保留率約 90%）的黃金臨界點才安排你複習，用最少時間換取最大記憶效率。'
                },
                {
                    q: 'Q2：為什麼每天建議控制新字上限？一次背 200 個新字會發生什麼「雪崩效應」？',
                    a: '在 FSRS 遺忘曲線下，今天新增的 200 個新字會在隔天、第 3 天、第 7 天同時湧入「待複習佇列」。如果每天都灌入過量新字，第 5 天開始每天會累積超過 400～600 張待複習卡片，一旦某天沒空刷完就會產生龐大「複習雪崩」，進而拖垮學習動力。建議配合每日學習時間，以「先清空今日到期複習，再穩定推進 15～30 個新字」的節奏最為持久！'
                },
                {
                    q: 'Q3：錯 3 次以上的單字進了「深淵魔王」是什麼原理？跟記憶「再鞏固」有什麼關聯？',
                    a: '在認知神經科學中，單字反覆答錯（FSRS 紀錄 lapses >= 3）往往是因為大腦產生了「錯誤編碼」或「形近字干擾」。深淵魔王機制會將這些頑固字抓出來，結合主動回想測驗與即時視覺回饋強迫觸發記憶的「再鞏固（Reconsolidation）」窗口，打破原本的錯誤神經連結；同時提供高達 3 倍 XP 的討伐獎勵，鼓勵你正面擊破弱點而非逃避難字！'
                },
                {
                    q: 'Q4：學測 7000 單（108 課綱完整分級 L1～L6）為什麼背好 L1～L4 就涵蓋大考 95% 閱讀字彙？',
                    a: 'LZHCard 內建對齊最新 108 課綱的完整 7000 單分級詞庫（L1～L6）。其中 Level 1～Level 4 屬於英文最高頻的基礎與核心動詞、形容詞及轉折功能詞，在大考中心學測歷屆閱讀測驗與克漏字文本中佔了約 95% 的出現頻率；L5～L6 則多用於高階寫作、精準替換與閱讀進階理解。建議高一二或衝刺期先透過等級標籤篩選出 L1～L4 交給 FSRS 穩固打底，再逐步攻克 L5～L6。'
                }
            ]
        },
        {
            id: 'exams',
            label: '📝 四大考試心法',
            heading: '【四大考試模式與解題心法】',
            faqs: [
                {
                    q: 'Q1：考試模式答對或答錯，會影響正式 FSRS 等級嗎？',
                    a: '絕不會！所有四大考試模式（句意挖空拼寫、三步驟句構翻譯、學測閱讀、10 選 10 文意選填）一律僅影響該單字的「臨時等級（freeLevel 與 freeStreak）」與發放冒險 XP，完全不會更動 FSRS 的 stability、difficulty 與 nextReview。考前請大膽刷題檢測弱點！'
                },
                {
                    q: 'Q2：【模式一：句意挖空拼寫】只給母語釋義跟頭尾字母要怎麼寫才不會錯詞態？',
                    a: '作答前先觀察題目例句中挖空處前後的文法提示：若空格前有 to / can / will 通常是原形；若有 was / were 或時間副詞 yesterday 要留意過去式 (-ed)；複數名詞則要檢查是否需加 -s / -es。系統也會提示詞性與頭尾字母（如 s _ _ _ e），幫助你精準鎖定答案！'
                },
                {
                    q: 'Q3：【模式二：三步驟句構重組翻譯】為什麼不直接讓我輸入整句英文就好？',
                    a: '台灣學生中翻英最常扣分的不是單字拼錯，而是「中式語序（時間／地點放太前面）」與「漏掉英文必備功能詞（例如逗號直接串子句沒加 and/because、可數單數名詞忘記加 a/the、缺少介系詞）」。透過 Step 1 調語序 → Step 2 補功能詞 → Step 3 寫出完整英文送 AI 批改（0～100 分，達 70 分過關升臨時等級），能真正修正你的英文句法直覺！'
                },
                {
                    q: 'Q4：【模式三＆四：學測綜合閱讀 ＆ 10 選 10 文意選填】有哪些高分實戰技巧？',
                    a: '做「學測閱讀」時建議先看主旨題與段落結構題型，遇到關鍵長難字可直接點擊文章內任意單字呼出「即時翻譯小卡」，不中斷閱讀節奏；做「10 選 10 文意選填」時，心法是先將 10 個選項標記詞性（名詞、動詞、形容詞、副詞），再對照空格前後的介系詞、冠詞與主被動關係快速縮小候選範圍，送出後系統會顯示詳解與詞性結構解析。'
                }
            ]
        },
        {
            id: 'multiplayer',
            label: '⚔️ 對戰排位與隱私',
            heading: '【對戰模式、賽季排位、寶箱與隱私規則】',
            faqs: [
                {
                    q: 'Q1：即時連線「1v1 拔河排位」、「10 題幽靈競速」與「四人共鬥打王」怎麼玩？',
                    a: '• 1v1 拔河排位：雙方搶答推進拔河條，答對往己方拉近、答錯則會觸發短暫冰凍懲罰（Frozen）暫停作答，先拉到底線或結算領先者勝出，並結算賽季 RP 積分！\n• 10 題幽靈競速：挑戰其他玩家留下的真實作答時間軸（影子紀錄），即使好友不在線上也能來一場高張力競速。\n• 四人共鬥打王：最多 4 名玩家組隊輪流或即時輸出傷害擊倒高血量世界魔王；請注意魔王設有「午夜回血機制」，別忘了揪團在結算前一起清掉 BOSS 血量！'
                },
                {
                    q: 'Q2：賽季排位段位門檻與「連勝冷凍護盾」怎麼運作？',
                    a: '進行 1v1 排位對戰可獲得 RP 積分，依序晉級「青銅 III～I → 白銀 → 黃金 → 白金 → 鑽石 → 傳說」。\n而每日連續學習天數（Streak）若遇到忙碌漏學 1 天時，只要你背包裡擁有「🛡️ 連勝冷凍護盾」（可於首頁或個人檔案花費 80 金幣購買，或從每日寶箱機率掉落，上限 3 個），系統會自動消耗 1 個護盾幫你保住連勝紀錄不斷鏈！'
                },
                {
                    q: 'Q3：每天的「神秘寶箱」怎麼領？會掉什麼獎勵？',
                    a: '每天在卡片輪播累計完成 10 次記憶評分，首頁冒險狀態列的寶箱就會閃耀提示可開啟！開啟寶箱必得大量金幣與經驗值，還有機會直接解鎖稀有外觀（如「霓虹脈衝／琥珀學者」頭像框、「櫻吹初曉／深空星雲」橫幅）或額外掉落「連勝冷凍護盾」！'
                },
                {
                    q: 'Q4：我不想讓別人看到我的學習數據，或想備份聊天與字庫資料該怎麼做？',
                    a: '打開左上設定抽屜滑至「4. 隱私設定與資料管理」：\n• 開啟「隱藏線上狀態與訊息已讀」：別人將無法看到你是否上線與已讀時間。\n• 關閉「公開我的學習統計資料」：別人點開你的個人公開名片或分享連結時，等級／掌握字數／勝率數據將全面顯示為上鎖保密狀態。\n• 你也能隨時使用「字庫 JSON 備份與還原」匯出完整單字進度，或點擊「匯出聊天紀錄（.txt / .json）」安全保存聊天室與私訊對話。'
                }
            ]
        }
    ];

    let activeHelpTab = 'features';
    let expandedFaqKey = 'features_0';

    function renderHelpManualContent() {
        if (typeof document === 'undefined') return;
        const tabsContainer = document.getElementById('helpManualTabs');
        const contentContainer = document.getElementById('helpManualBody');
        if (!tabsContainer || !contentContainer) return;

        tabsContainer.innerHTML = HELP_MANUAL_TABS.map(tab => {
            const isActive = tab.id === activeHelpTab;
            return `
                <button type="button" onclick="HelpManualModal.switchTab('${tab.id}')"
                    class="px-3 py-2 rounded-xl text-xs font-extrabold whitespace-nowrap transition cursor-pointer ${isActive
                        ? 'bg-brand-600 text-white shadow-xs'
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}">
                    ${escapeHtml(tab.label)}
                </button>
            `;
        }).join('');

        const currentTabObj = HELP_MANUAL_TABS.find(t => t.id === activeHelpTab) || HELP_MANUAL_TABS[0];
        const faqsHtml = currentTabObj.faqs.map((item, idx) => {
            const key = `${currentTabObj.id}_${idx}`;
            const isExpanded = expandedFaqKey === key;
            return `
                <div class="rounded-2xl border ${isExpanded ? 'border-brand-300 dark:border-brand-700 bg-brand-50/40 dark:bg-brand-950/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/60'} overflow-hidden transition">
                    <button type="button" aria-expanded="${isExpanded ? 'true' : 'false'}"
                        onclick="HelpManualModal.toggleFaq('${key}')"
                        class="w-full px-4 py-3.5 text-left flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/70 transition">
                        <span class="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white leading-snug">${escapeHtml(item.q)}</span>
                        <i class="fa-solid fa-chevron-down text-xs text-slate-400 shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-brand-500' : ''}"></i>
                    </button>
                    <div class="${isExpanded ? 'block' : 'hidden'} px-4 pb-4 pt-1 border-t border-slate-100 dark:border-slate-700/70 text-xs sm:text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line">${escapeHtml(item.a)}</div>
                </div>
            `;
        }).join('');

        contentContainer.innerHTML = `
            <div class="space-y-3">
                <div class="px-3.5 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100">
                    ${escapeHtml(currentTabObj.heading)}
                </div>
                <div class="space-y-2.5">
                    ${faqsHtml}
                </div>
            </div>
        `;
    }

    function openHelpManual(tabId = null) {
        if (tabId && HELP_MANUAL_TABS.some(t => t.id === tabId)) {
            activeHelpTab = tabId;
            expandedFaqKey = `${tabId}_0`;
        }
        renderHelpManualContent();
        if (typeof global.openModal === 'function') {
            global.openModal('helpManualModal');
        } else if (typeof document !== 'undefined') {
            const modal = document.getElementById('helpManualModal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }
    }

    function closeHelpManual() {
        if (typeof global.closeModal === 'function') {
            global.closeModal('helpManualModal');
        } else if (typeof document !== 'undefined') {
            const modal = document.getElementById('helpManualModal');
            if (modal) {
                modal.classList.remove('flex');
                modal.classList.add('hidden');
            }
        }
    }

    function switchHelpTab(tabId) {
        if (!HELP_MANUAL_TABS.some(t => t.id === tabId)) return;
        activeHelpTab = tabId;
        expandedFaqKey = `${tabId}_0`;
        renderHelpManualContent();
    }

    function toggleFaq(key) {
        expandedFaqKey = (expandedFaqKey === key) ? '' : key;
        renderHelpManualContent();
    }

    function replayOnboardingFromManual() {
        closeHelpManual();
        startOnboardingTour({ replay: true });
    }

    /* ==========================================================================
       對外公開 API 與全域相容橋接
       ========================================================================== */

    const StartupDeepLinkQueue = {
        captureInitialDeepLinks,
        buildDeepLinkPayloadFromLocation,
        flushPendingDeepLink,
        processWhenReady,
        hasPending: () => typeof global.__pendingDeepLinkAction === 'function' || typeof readyDeepLinkAction === 'function'
    };

    const OnboardingTour = {
        steps: ONBOARDING_V2_STEPS,
        start: startOnboardingTour,
        renderStep: renderTourStep,
        next: nextTourStep,
        prev: prevTourStep,
        finish: finishOnboardingTour,
        isOpen: () => tourIsActive
    };

    const HelpManualModal = {
        tabs: HELP_MANUAL_TABS,
        open: openHelpManual,
        close: closeHelpManual,
        switchTab: switchHelpTab,
        toggleFaq,
        replayTour: replayOnboardingFromManual,
        getActiveTab: () => activeHelpTab,
        getExpandedKey: () => expandedFaqKey
    };

    global.StartupDeepLinkQueue = StartupDeepLinkQueue;
    global.OnboardingTour = OnboardingTour;
    global.HelpManualModal = HelpManualModal;

    // 向下相容舊版全域呼叫名稱
    global.startInteractiveTour = (opts) => startOnboardingTour(opts || { replay: true });
    global.finishTour = finishOnboardingTour;
    global.finishOnboardingTour = finishOnboardingTour;
    global.prevTourStep = prevTourStep;
    global.nextTourStep = nextTourStep;
})(typeof window !== 'undefined' ? window : globalThis);
