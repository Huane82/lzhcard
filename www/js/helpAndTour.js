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
            if (typeof global.hasSeenOnboardingTour === 'function' && global.hasSeenOnboardingTour()) {
                return false;
            }
            if (localStorage.getItem(ONBOARDING_V2_KEY) === 'true') return false;
            if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
                const uid = firebase.auth().currentUser.uid;
                if (uid && localStorage.getItem(`${ONBOARDING_V2_KEY}__${uid}`) === 'true') return false;
            }
            if (global.userData?.settings?.onboardingV2Done === true) return false;
            return true;
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
       2. 全功能互動式新手教學 (OnboardingTour，涵蓋設定、模式與內外懸浮視窗)
       ========================================================================== */

    function tr(key, fallback, vars = null) {
        let out = '';
        if (typeof global.t === 'function') {
            const res = global.t(key);
            if (res && res !== key) out = res;
        }
        if (!out) out = fallback || key;
        if (vars && typeof out === 'string') {
            Object.keys(vars).forEach((k) => {
                out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]));
            });
        }
        return out;
    }

    function getStarterCategoryName(targetLang) {
        const lang = String(targetLang || 'en').trim();
        if (lang === 'ja') return '新手入門日語包';
        if (lang === 'zh-TW' || lang === 'zh') return '新手入門中文包';
        return '新手入門字卡包';
    }

    function getStarterBatchDemoText(targetLang) {
        const lang = String(targetLang || 'en').trim();
        if (lang === 'ja') {
            return [
                '食べる,吃,v.,たべる',
                '1."毎朝パンを食べます。"',
                '2."我每天早上吃麵包。"',
                '大切,重要的,na.,たいせつ',
                '1."健康はとても大切です。"',
                '2."健康非常重要。"',
                '約束,約定,n.,やくそく',
                '1."友達との約束を守ります。"',
                '2."我遵守和朋友的約定。"'
            ].join('\n');
        }
        if (lang === 'zh-TW' || lang === 'zh') {
            return [
                '韌性,resilience,n.,ㄖㄣˋ ㄒㄧㄥˋ',
                '1."面對挑戰時，他展現了極強的心理韌性。"',
                '2."He showed remarkable mental resilience when facing challenges."',
                '專注,focus,v.,ㄓㄨㄢ ㄓㄨˋ',
                '1."請專注於當下的每一個學習步驟。"',
                '2."Please focus on every learning step in the present."',
                '共鳴,resonance,n.,ㄍㄨㄥˋ ㄇㄧㄥˊ',
                '1."這篇文章深刻引起許多讀者的共鳴。"',
                '2."This essay deeply resonated with many readers."'
            ].join('\n');
        }
        // 英文與自訂語言一律以英文示範字卡包為主
        return [
            'preview,預覽；提前看,v.,[ˈpriːvjuː]',
            '1."You can preview the starter vocabulary pack before saving."',
            '2."在儲存之前，你可以先預覽這份新手字卡包。"',
            'resilient,有韌性的,adj.,[rɪˈzɪljənt]',
            '1."She remained resilient despite every obstacle."',
            '2."儘管面臨重重阻礙，她依然充滿韌性。"',
            'transform,轉變；改造,v.,[trænsˈfɔːrm]',
            '1."Daily reading habits can transform your memory."',
            '2."每天的閱讀習慣能徹底轉變你的記憶力。"'
        ].join('\n');
    }

    const ONBOARDING_V2_STEPS = [
        {
            targetId: 'batchModal',
            fallbackTargetId: 'batchRawInput',
            tab: 'list',
            prepareStarterBatch: true,
            badgeKey: 'tourNewBadge1',
            badgeFallback: '1 / 8 · 新手包匯入',
            titleKey: 'tourNewTitle1',
            titleFallback: '1. 先從字庫匯入新手向字卡包',
            descKey: 'tourNewDesc1',
            descFallback: '已依你選擇的目標語言（若選自訂語言則以英文示範）預先在框框內備妥含釋義與例句的示範單字！統一格式為「目標單字,釋義,詞性,發音」與 1."例句" / 2."翻譯"。點擊「確認匯入至字庫」即可加入（按「下一步」也會自動幫你完成匯入）。'
        },
        {
            targetId: 'headerCategorySelector',
            tab: 'home',
            ensureStarterImported: true,
            closeBatchModal: true,
            badgeKey: 'tourNewBadge2',
            badgeFallback: '2 / 8 · 勾選字庫',
            titleKey: 'tourNewTitle2',
            titleFallback: '2. 回到首頁右上角勾選字卡包',
            descKey: 'tourNewDesc2',
            descFallback: '在首頁右上角的字庫選單中，勾選剛剛匯入的新手字卡包（支援多字庫同時複習與跨裝置差異化雲端同步）。'
        },
        {
            targetId: 'homeCardFlashcard',
            fallbackTargetId: 'cardWord',
            tab: 'home',
            ensureStarterImported: true,
            ensureFlashcardReady: true,
            badgeKey: 'tourNewBadge3',
            badgeFallback: '3 / 8 · 刷字卡體驗',
            titleKey: 'tourNewTitle3',
            titleFallback: '3. 體驗刷字卡（自動標示字首／字根／字尾）',
            descKey: 'tourNewDesc3',
            descFallback: '點擊字卡翻面或進行記憶評分體驗刷卡！系統預設以三色底線標出字首（藍）、字根（綠）、字尾（琥珀），點擊詞素可直接查看詳解而不翻卡。'
        },
        {
            targetId: 'ftScreenTapToggle',
            fallbackTargetId: 'floatingTranslatorBall',
            tab: 'home',
            floatingTab: 'screen',
            badgeKey: 'tourNewBadge4',
            badgeFallback: '4 / 8 · 懸浮球點譯',
            titleKey: 'tourNewTitle4',
            titleFallback: '4. 透過懸浮球勾選「螢幕點譯」',
            descKey: 'tourNewDesc4',
            descFallback: '展開懸浮球並切至「點詞」分頁，勾選「螢幕點譯」開關！開啟後即可隨時點擊畫面與卡片上的單字進行即時查詢與翻譯。'
        },
        {
            targetId: 'cardFrontSentence',
            fallbackTargetId: 'cardSentence',
            tab: 'home',
            closeFloatingPanel: true,
            ensureSentenceVisible: true,
            badgeKey: 'tourNewBadge5',
            badgeFallback: '5 / 8 · 句子單字點擊',
            titleKey: 'tourNewTitle5',
            titleFallback: '5. 點擊字卡上的句子單字即時查看',
            descKey: 'tourNewDesc5',
            descFallback: '現在試著點擊字卡例句裡的任一個單字，即可立即查看釋義、聽發音或一鍵收錄至字庫！'
        },
        {
            targetId: 'bnav-stats',
            tab: 'home',
            badgeKey: 'tourNewBadge6',
            badgeFallback: '6 / 8 · 統計分析',
            titleKey: 'tourNewTitle6',
            titleFallback: '6. 統計分析 ＆ ✨ AI 學習診斷',
            descKey: 'tourNewDesc6',
            descFallback: '點擊底部「統計」可查看詞彙分佈與熟悉度；點統計頁左上角「☰」還可呼叫 ✨ AI 綜合分析你的考試與刷卡學習狀況。'
        },
        {
            targetId: 'headerChatBtn',
            tab: 'home',
            badgeKey: 'tourNewBadge7',
            badgeFallback: '7 / 8 · 聊天與班級',
            titleKey: 'tourNewTitle7',
            titleFallback: '7. 聊天室與班級老師模式',
            descKey: 'tourNewDesc7',
            descFallback: '點擊右上角聊天室按鈕，除了排行榜、公開頻道與好友 1v1 私訊外，也可建立「班級老師模式」群組（最多 50 人，支援禁言、同步/限時挑戰與每日任務派發）。'
        },
        {
            targetId: 'settingsAccBody_display',
            fallbackTargetId: 'settingsStudyModeSlot',
            tab: 'settings',
            openSettings: true,
            settingsAccordion: 'display',
            badgeKey: 'tourNewBadge8',
            badgeFallback: '8 / 8 · 字卡設定',
            titleKey: 'tourNewTitle8',
            titleFallback: '8. 字卡顯示設定（導覽完成）',
            descKey: 'tourNewDesc8',
            descFallback: '在設定的「字卡顯示設定」中可調整 FSRS／自由模式、正背面與音標位置、自動播放發音、正面顯示例句及三色字根字首開關。祝學習愉快！'
        }
    ];

    let tourCurrentIndex = 0;
    let tourPhase = 'explain'; // 'explain' -> 先文字解說 | 'action' -> 高亮實際操作 (只留 下一步 與 全部略過)
    let tourIsActive = false;
    let tourAbortController = null;
    let tourRepositionTimer = null;
    let tourInteractiveSwitched = false;
    let tourSnapshotFloatingOpen = false;
    let tourSnapshotFloatingEnabled = null;
    let tourSnapshotShowSentenceFront = null;

    function abortTourListeners() {
        if (tourRepositionTimer) {
            clearTimeout(tourRepositionTimer);
            tourRepositionTimer = null;
        }
        if (tourAbortController) {
            try { tourAbortController.abort(); } catch (e) {}
            tourAbortController = null;
        }
    }

    function setInteractiveStatusBanner(visible, text = '', completed = false) {
        if (typeof document === 'undefined') return;
        const box = document.getElementById('tourInteractiveStatus');
        if (!box) return;
        if (!visible) {
            box.classList.add('hidden');
            box.textContent = '';
            return;
        }
        box.classList.remove('hidden');
        box.textContent = text;
        if (completed) {
            box.className = 'mt-2.5 p-2.5 rounded-xl bg-emerald-50/90 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-700 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 space-y-1';
        } else {
            box.className = 'mt-2.5 p-2.5 rounded-xl bg-brand-50/90 dark:bg-brand-950/50 border border-brand-200 dark:border-brand-800 text-[11px] font-bold text-brand-700 dark:text-brand-300 space-y-1';
        }
    }

    function setBackdropPassThrough(passThrough) {
        if (typeof document === 'undefined') return;
        const backdrop = document.getElementById('tourBackdrop');
        if (!backdrop) return;
        if (passThrough) {
            backdrop.classList.remove('pointer-events-auto', 'bg-slate-900/75', 'bg-slate-900/35');
            backdrop.classList.add('pointer-events-none', 'bg-transparent');
        } else {
            backdrop.classList.remove('pointer-events-none', 'bg-slate-900/75', 'bg-slate-900/35');
            backdrop.classList.add('pointer-events-auto', 'bg-transparent');
        }
    }

    function ensureChatDrawerState(step) {
        if (typeof document === 'undefined') return;
        const drawer = document.getElementById('chatDrawer');
        const isCurrentlyOpen = Boolean(drawer && !drawer.classList.contains('hidden'));
        const wantsChat = Boolean(step && step.openChat);

        if (wantsChat) {
            if (!isCurrentlyOpen && typeof global.openChatDrawer === 'function') {
                global.openChatDrawer({ tourPreview: true, initialTab: step.chatTab || 'leaderboard' });
            } else if (isCurrentlyOpen && step.chatTab && typeof global.switchChatTab === 'function') {
                global.switchChatTab(step.chatTab);
            }
        } else if (isCurrentlyOpen) {
            if (typeof global.closeChatDrawer === 'function') {
                global.closeChatDrawer();
            } else if (drawer) {
                drawer.classList.add('hidden');
            }
        }
    }

    function ensureSettingsDrawerState(shouldOpen, accordionKey = null) {
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
            if (accordionKey && typeof global.setSettingsAccordionOpen === 'function') {
                if (typeof global.resetSettingsAccordions === 'function') {
                    global.resetSettingsAccordions();
                }
                global.setSettingsAccordionOpen(accordionKey, true);
            }
        } else if (isCurrentlyOpen) {
            if (typeof global.closeSettingsDrawer === 'function') {
                global.closeSettingsDrawer();
            } else if (drawer) {
                drawer.classList.add('hidden');
            }
        }
    }

    function ensureStarterPackImported() {
        const targetLang = (typeof localStorage !== 'undefined' ? localStorage.getItem('lzhcard_target_lang') : 'en') || 'en';
        const starterCat = getStarterCategoryName(targetLang);
        const demoText = getStarterBatchDemoText(targetLang);

        if (typeof global.wordList !== 'undefined' && Array.isArray(global.wordList)) {
            const hasDeck = global.wordList.some(w => w && w.category === starterCat);
            if (!hasDeck && typeof global.parseBatchText === 'function') {
                const items = global.parseBatchText(demoText);
                const now = Date.now();
                const deckId = typeof global.generateDeterministicDeckId === 'function' ? global.generateDeterministicDeckId(starterCat) : undefined;
                const resolvedLang = targetLang === 'custom' ? 'en' : targetLang;
                items.forEach(item => {
                    if (!item || !item.word) return;
                    const card = {
                        id: typeof global.generateDeterministicCardId === 'function' ? global.generateDeterministicCardId(starterCat, item.word) : ('w_' + now + '_' + Math.random().toString(36).slice(2, 7)),
                        deckId,
                        category: starterCat,
                        word: item.word,
                        pos: item.pos || '',
                        phonetic: item.phonetic || '',
                        meaning: item.meaning || '',
                        sentence: item.sentence || '',
                        translation: item.translation || '',
                        lang: resolvedLang,
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
                    };
                    if (typeof global.migrateCardFSRS === 'function') global.migrateCardFSRS(card);
                    global.wordList.unshift(card);
                });
                if (typeof global.saveStorage === 'function') global.saveStorage();
            }
            global.selectedCategories = [starterCat];
            if (typeof global.updateCategorySelects === 'function') global.updateCategorySelects();
            if (typeof global.updateUI === 'function') global.updateUI();
        }
    }

    function ensureBatchStarterPrepared(step) {
        if (!step || !step.prepareStarterBatch) return;
        const targetLang = (typeof localStorage !== 'undefined' ? localStorage.getItem('lzhcard_target_lang') : 'en') || 'en';
        const starterCat = getStarterCategoryName(targetLang);
        const demoText = getStarterBatchDemoText(targetLang);

        if (typeof global.openModal === 'function') global.openModal('batchModal');
        if (typeof global.setCategorySelectorValue === 'function') {
            global.setCategorySelectorValue('batch', starterCat);
        }
        const rawInput = document.getElementById('batchRawInput');
        if (rawInput) {
            rawInput.value = demoText;
        }
        if (typeof global.handleParseBatchText === 'function') {
            global.handleParseBatchText();
        }
    }

    function closeFloatingPanelSafe(ft) {
        if (!ft) return;
        if (typeof ft.closePipWindow === 'function') {
            try { ft.closePipWindow(); } catch (e) {}
        }
        if (typeof ft.collapsePanel === 'function') {
            ft.collapsePanel();
        } else if (typeof ft.collapse === 'function') {
            ft.collapse();
        } else if (typeof ft.close === 'function') {
            ft.close();
        }
        if (typeof document !== 'undefined') {
            const panelEl = document.getElementById('ftPanelHost') || document.getElementById('ftPanel');
            if (panelEl) panelEl.classList.add('hidden');
        }
    }

    function ensureFloatingPanelState(step) {
        const ft = global.FloatingTranslator;
        if (!ft) return;

        const wantsFloating = Boolean(step && (step.floatingTab || step.floatingView));
        if (wantsFloating) {
            if (typeof ft.setEnabled === 'function') ft.setEnabled(true);
            if (step.floatingView === 'chat') {
                if (typeof ft.open === 'function') ft.open('subtitle');
                if (typeof ft.setViewMode === 'function') ft.setViewMode('chat');
            } else if (step.floatingTab) {
                if (typeof ft.setViewMode === 'function') ft.setViewMode('translator');
                if (typeof ft.open === 'function') ft.open(step.floatingTab);
            }
        } else if (step && step.closeFloatingPanel) {
            closeFloatingPanelSafe(ft);
        } else if (!tourSnapshotFloatingOpen) {
            const isPanelDomOpen = typeof document !== 'undefined' && Boolean(
                (document.getElementById('ftPanelHost') && !document.getElementById('ftPanelHost').classList.contains('hidden')) ||
                (document.getElementById('ftPanel') && !document.getElementById('ftPanel').classList.contains('hidden'))
            );
            if ((typeof ft.isOpen === 'function' && ft.isOpen()) || isPanelDomOpen) {
                closeFloatingPanelSafe(ft);
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

    function setTourPhaseUI(phase, stepIndex) {
        if (typeof document === 'undefined') return;
        const isAction = phase === 'action';
        const isLastStep = stepIndex === ONBOARDING_V2_STEPS.length - 1;

        const popover = document.getElementById('tourPopover');
        const highlightBox = document.getElementById('tourHighlightBox');
        const headerRow = document.getElementById('tourHeaderRow');
        const textBody = document.getElementById('tourTextBody');
        const footerRow = document.getElementById('tourFooterRow');
        const prevBtn = document.getElementById('tourPrevBtn');
        const skipAllCompactBtn = document.getElementById('tourSkipAllCompactBtn');
        const nextBtn = document.getElementById('tourNextBtn');

        setBackdropPassThrough(isAction);

        if (highlightBox) {
            highlightBox.classList.toggle('lzh-tour-highlight-explain', !isAction);
            highlightBox.classList.toggle('lzh-tour-highlight-action', isAction);
        }

        if (headerRow) headerRow.classList.toggle('hidden', isAction);
        if (textBody) textBody.classList.toggle('hidden', isAction);
        if (prevBtn) {
            prevBtn.classList.toggle('hidden', isAction);
            prevBtn.disabled = (!isAction && stepIndex === 0);
        }
        if (skipAllCompactBtn) {
            skipAllCompactBtn.classList.toggle('hidden', !isAction);
            skipAllCompactBtn.textContent = tr('btnSkipAllTour', '全部略過');
        }

        if (footerRow) {
            footerRow.className = isAction
                ? 'flex items-center justify-end gap-2'
                : 'flex justify-between items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-700';
        }

        if (popover) {
            popover.classList.toggle('lzh-tour-popover--action', isAction);
            popover.classList.toggle('space-y-3', !isAction);
            popover.classList.toggle('space-y-0', isAction);
            popover.classList.toggle('p-5', !isAction);
            popover.classList.toggle('w-80', !isAction);
        }

        if (nextBtn) {
            if (isAction && isLastStep) {
                nextBtn.innerHTML = `<span>${escapeHtml(tr('btnFinishTour', '完成教學'))}</span> <i class="fa-solid fa-check ml-1"></i>`;
                nextBtn.className = 'px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-extrabold transition shadow-xs cursor-pointer shrink-0';
            } else {
                nextBtn.innerHTML = `<span>${escapeHtml(tr('btnNextStep', '下一步'))}</span> <i class="fa-solid fa-chevron-right ml-1"></i>`;
                nextBtn.className = 'px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-extrabold transition shadow-xs cursor-pointer shrink-0';
            }
        }
    }

    function positionTourPopover(stepIndex, phase = tourPhase) {
        if (typeof document === 'undefined') return;
        const step = ONBOARDING_V2_STEPS[stepIndex];
        if (!step) return;

        const highlightBox = document.getElementById('tourHighlightBox');
        const popover = document.getElementById('tourPopover');
        const badgeEl = document.getElementById('tourStepBadge');
        const titleEl = document.getElementById('tourStepTitle');
        const descEl = document.getElementById('tourStepDesc');

        if (!highlightBox || !popover) return;

        setTourPhaseUI(phase, stepIndex);

        if (badgeEl) badgeEl.textContent = tr(step.badgeKey, step.badgeFallback || `${stepIndex + 1} / ${ONBOARDING_V2_STEPS.length}`);
        if (titleEl) titleEl.textContent = tr(step.titleKey, step.titleFallback);
        if (descEl) {
            descEl.textContent = tr(step.descKey, step.descFallback);
            descEl.classList.add('whitespace-pre-line');
        }

        if (phase === 'explain' && step.interactiveModeSwitch) {
            if (tourInteractiveSwitched) {
                const curMode = (typeof global.getStudyMode === 'function' && global.getStudyMode() === 'free')
                    ? tr('optStudyModeFree', '⚡ 自由練習模式')
                    : tr('optStudyModeFsrs', '🧠 FSRS 模式');
                setInteractiveStatusBanner(true, tr('tourInteractiveModeDone', `✅ 已完成切換體驗！目前已切換為「${curMode}」，可點「下一步」開始實作或繼續。`, { mode: curMode }), true);
            } else {
                setInteractiveStatusBanner(true, tr('tourInteractiveModePrompt', '👆 點擊「下一步」後即可直接在高亮框切換「⚡ 自由練習模式」或「🧠 FSRS 模式」！'), false);
            }
        } else {
            setInteractiveStatusBanner(false);
        }

        const winW = window.innerWidth || 375;
        const winH = window.innerHeight || 667;
        let effTop = 0;
        let effBottom = 0;
        try {
            const rootStyle = window.getComputedStyle(document.documentElement);
            const rawTop = parseFloat(rootStyle.getPropertyValue('--lzh-safe-top')) || 0;
            const rawBottom = parseFloat(rootStyle.getPropertyValue('--lzh-safe-bottom')) || 0;
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:var(--lzh-effective-top, env(safe-area-inset-top, 0px));padding-bottom:var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px));';
            document.body.appendChild(probe);
            const ps = window.getComputedStyle(probe);
            effTop = Math.max(rawTop, parseFloat(ps.paddingTop) || 0);
            effBottom = Math.max(rawBottom, parseFloat(ps.paddingBottom) || 0);
            probe.remove();
        } catch (e) {}
        const safeMarginTop = Math.max(16, Math.round(effTop + 12));
        const safeMarginBottom = Math.max(20, Math.round(effBottom + 14));

        if (step.openSettings && step.targetId && typeof global.expandSettingsAccordionForElement === 'function') {
            const rawTarget = document.getElementById(step.targetId);
            if (rawTarget) global.expandSettingsAccordionForElement(rawTarget);
        }

        const isAction = phase === 'action';
        const targetElem = resolveTourTarget(step);
        if (targetElem) {
            try {
                if (typeof targetElem.scrollIntoView === 'function' && !step.floatingTab && !step.floatingView && !step.openChat) {
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

            if (isAction) {
                popover.style.width = '';
            } else {
                const popWExplain = Math.min(344, winW - 24);
                popover.style.width = `${popWExplain}px`;
            }

            const popWidth = isAction ? Math.min(popover.offsetWidth || 210, winW - 24) : Math.min(344, winW - 24);
            const popHeight = Math.min(popover.offsetHeight || (isAction ? 52 : 230), winH - safeMarginTop - safeMarginBottom);

            let popTop;
            let popLeft;

            const spaceRight = winW - rect.right - 16;
            const spaceLeft = rect.left - 16;
            const spaceBottom = winH - rect.bottom - safeMarginBottom;
            const spaceTop = rect.top - safeMarginTop;

            if (isAction) {
                if (spaceBottom >= popHeight + 12) {
                    popTop = rect.bottom + 12;
                    popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
                } else if (spaceTop >= popHeight + 12) {
                    popTop = rect.top - popHeight - 12;
                    popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
                } else if (spaceLeft >= popWidth + 12) {
                    popLeft = Math.max(12, rect.left - popWidth - 12);
                    popTop = Math.max(safeMarginTop, winH - popHeight - safeMarginBottom);
                } else if (spaceRight >= popWidth + 12) {
                    popLeft = Math.min(winW - popWidth - 12, rect.right + 12);
                    popTop = Math.max(safeMarginTop, winH - popHeight - safeMarginBottom);
                } else {
                    popTop = Math.max(safeMarginTop, winH - popHeight - safeMarginBottom);
                    popLeft = step.openChat ? 12 : (winW - popWidth - 12);
                }
            } else if (step.floatingTab || step.floatingView || rect.height > winH * 0.55) {
                if (spaceLeft >= popWidth) {
                    popLeft = Math.max(12, rect.left - popWidth - 14);
                    popTop = Math.max(safeMarginTop, Math.min(rect.top + 12, winH - popHeight - safeMarginBottom));
                } else if (spaceRight >= popWidth) {
                    popLeft = Math.min(winW - popWidth - 12, rect.right + 14);
                    popTop = Math.max(safeMarginTop, Math.min(rect.top + 12, winH - popHeight - safeMarginBottom));
                } else {
                    popLeft = Math.max(12, Math.min(rect.left + (rect.width / 2) - (popWidth / 2), winW - popWidth - 12));
                    popTop = Math.max(safeMarginTop, winH - popHeight - safeMarginBottom);
                }
            } else if (spaceBottom >= popHeight + 14) {
                popTop = rect.bottom + 14;
                popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
            } else if (spaceTop >= popHeight + 14) {
                popTop = rect.top - popHeight - 14;
                popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
            } else {
                popTop = Math.max(safeMarginTop, Math.round((winH - popHeight) / 2));
                popLeft = rect.left + (rect.width / 2) - (popWidth / 2);
            }

            popTop = Math.max(safeMarginTop, Math.min(popTop, Math.max(safeMarginTop, winH - popHeight - safeMarginBottom)));
            popLeft = Math.max(12, Math.min(popLeft, winW - popWidth - 12));

            popover.style.top = `${popTop}px`;
            popover.style.left = `${popLeft}px`;
        } else {
            highlightBox.classList.add('hidden');
            if (isAction) {
                popover.style.width = '';
                const popWidth = Math.min(popover.offsetWidth || 210, winW - 24);
                const popHeight = popover.offsetHeight || 52;
                popover.style.top = `${Math.max(safeMarginTop, winH - popHeight - safeMarginBottom)}px`;
                popover.style.left = `${Math.max(12, Math.round((winW - popWidth) / 2))}px`;
            } else {
                const popWidth = Math.min(344, winW - 24);
                popover.style.width = `${popWidth}px`;
                const popHeight = Math.min(popover.offsetHeight || 230, winH - 40);
                popover.style.top = `${Math.max(safeMarginTop, Math.round((winH - popHeight) / 2))}px`;
                popover.style.left = `${Math.max(12, Math.round((winW - popWidth) / 2))}px`;
            }
        }
    }

    function bindTourGlobalListeners() {
        abortTourListeners();
        if (typeof window === 'undefined' || typeof AbortController === 'undefined') return;

        tourAbortController = new AbortController();
        const sig = tourAbortController.signal;

        window.addEventListener('resize', () => {
            if (tourIsActive) positionTourPopover(tourCurrentIndex, tourPhase);
        }, { signal: sig });

        window.addEventListener('keydown', (e) => {
            if (!tourIsActive) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                finishOnboardingTour();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                nextTourStep();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                prevTourStep();
            }
        }, { signal: sig });

        const fsrsBtn = document.getElementById('settingsStudyModeFsrsBtn');
        const freeBtn = document.getElementById('settingsStudyModeFreeBtn');
        const onInteractiveModeClick = () => {
            if (!tourIsActive) return;
            const step = ONBOARDING_V2_STEPS[tourCurrentIndex];
            if (!step || !step.interactiveModeSwitch) return;
            tourInteractiveSwitched = true;
            setTimeout(() => {
                if (tourIsActive && ONBOARDING_V2_STEPS[tourCurrentIndex]?.interactiveModeSwitch) {
                    positionTourPopover(tourCurrentIndex, tourPhase);
                }
            }, 30);
        };
        if (fsrsBtn) fsrsBtn.addEventListener('click', onInteractiveModeClick, { signal: sig });
        if (freeBtn) freeBtn.addEventListener('click', onInteractiveModeClick, { signal: sig });
    }

    function renderTourStep(index, phase = 'explain') {
        if (index < 0 || index >= ONBOARDING_V2_STEPS.length) {
            finishOnboardingTour();
            return;
        }
        tourCurrentIndex = index;
        tourPhase = phase === 'action' ? 'action' : 'explain';
        const step = ONBOARDING_V2_STEPS[index];

        if (tourRepositionTimer) {
            clearTimeout(tourRepositionTimer);
            tourRepositionTimer = null;
        }

        if (step.closeBatchModal && typeof global.closeModal === 'function') {
            global.closeModal('batchModal');
        }
        if (step.ensureStarterImported) {
            ensureStarterPackImported();
        }
        if (step.tab && typeof global.switchTab === 'function') {
            global.switchTab(step.tab);
        }
        if (step.prepareStarterBatch) {
            ensureBatchStarterPrepared(step);
        }
        if (step.ensureFlashcardReady && typeof global.nextCard === 'function') {
            global.nextCard(false);
        }
        if (step.ensureSentenceVisible) {
            if (typeof localStorage !== 'undefined' && localStorage.getItem('lzhcard_show_sentence_front') !== 'true') {
                localStorage.setItem('lzhcard_show_sentence_front', 'true');
            }
            const ftToggle = document.getElementById('ftScreenTapToggle');
            if (ftToggle && !ftToggle.checked) {
                ftToggle.checked = true;
                ftToggle.dispatchEvent(new Event('change'));
            }
            if (typeof global.renderFrontContextSentence === 'function' && typeof global.currentCard !== 'undefined') {
                global.renderFrontContextSentence(global.currentCard);
            }
        }

        ensureChatDrawerState(step);
        ensureSettingsDrawerState(Boolean(step.openSettings), step.settingsAccordion || null);
        ensureFloatingPanelState(step);

        positionTourPopover(index, tourPhase);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (tourIsActive && tourCurrentIndex === index) {
                    positionTourPopover(index, tourPhase);
                }
            });
        }
        if (step.openSettings || step.openChat || step.floatingTab || step.floatingView || step.prepareStarterBatch) {
            tourRepositionTimer = setTimeout(() => {
                if (tourIsActive && tourCurrentIndex === index) {
                    positionTourPopover(index, tourPhase);
                }
            }, 260);
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
        if (typeof global.closeChatDrawer === 'function') global.closeChatDrawer();
        if (typeof global.closeModal === 'function') {
            global.closeModal('onboardingSetupModal');
            global.closeModal('helpManualModal');
            global.closeModal('overlayPermissionGuideModal');
            global.closeModal('desktopWidgetGuideModal');
        }

        const overlay = document.getElementById('onboardingTourOverlay');
        if (!overlay) return false;

        const ft = global.FloatingTranslator;
        tourSnapshotFloatingOpen = Boolean(ft && typeof ft.isOpen === 'function' && ft.isOpen());
        try {
            tourSnapshotFloatingEnabled = localStorage.getItem('lzhcard_floating_translator_enabled');
            tourSnapshotShowSentenceFront = localStorage.getItem('lzhcard_show_sentence_front');
        } catch (e) {
            tourSnapshotFloatingEnabled = null;
            tourSnapshotShowSentenceFront = null;
        }

        tourIsActive = true;
        tourCurrentIndex = 0;
        tourPhase = 'explain';
        tourInteractiveSwitched = false;
        overlay.classList.remove('hidden');
        // 保持 overlay 為 pointer-events-none，由 #tourBackdrop 與 #tourPopover 個別管理點擊攔截
        overlay.style.pointerEvents = 'none';

        if (typeof global.markOnboardingTourSeen === 'function') {
            global.markOnboardingTourSeen(true);
        } else {
            try {
                localStorage.setItem(ONBOARDING_V2_KEY, 'true');
                localStorage.setItem(ONBOARDING_V1_KEY, 'true');
            } catch (e) {}
        }

        bindTourGlobalListeners();
        renderTourStep(0, 'explain');
        return true;
    }

    function prevTourStep() {
        if (!tourIsActive) return;
        if (tourPhase === 'action') {
            renderTourStep(tourCurrentIndex, 'explain');
        } else if (tourCurrentIndex > 0) {
            renderTourStep(tourCurrentIndex - 1, 'explain');
        }
    }

    function nextTourStep() {
        if (!tourIsActive) return;
        if (tourPhase === 'explain') {
            renderTourStep(tourCurrentIndex, 'action');
        } else if (tourCurrentIndex < ONBOARDING_V2_STEPS.length - 1) {
            renderTourStep(tourCurrentIndex + 1, 'explain');
        } else {
            finishOnboardingTour();
        }
    }

    function finishOnboardingTour() {
        tourIsActive = false;
        tourPhase = 'explain';
        tourInteractiveSwitched = false;
        abortTourListeners();
        setTourPhaseUI('explain', 0);
        setBackdropPassThrough(false);
        setInteractiveStatusBanner(false);
        ensureChatDrawerState(null);
        ensureSettingsDrawerState(false);
        if (typeof global.closeModal === 'function') {
            global.closeModal('batchModal');
        }
        try {
            if (tourSnapshotShowSentenceFront === null) {
                localStorage.removeItem('lzhcard_show_sentence_front');
            } else {
                localStorage.setItem('lzhcard_show_sentence_front', tourSnapshotShowSentenceFront);
            }
            if (typeof global.renderFrontContextSentence === 'function' && typeof global.currentCard !== 'undefined') {
                global.renderFrontContextSentence(global.currentCard);
            }
        } catch (e) {}

        const ft = global.FloatingTranslator;
        if (ft) {
            if (!tourSnapshotFloatingOpen) {
                closeFloatingPanelSafe(ft);
            }
            if (tourSnapshotFloatingEnabled === 'false' && typeof ft.setEnabled === 'function') {
                ft.setEnabled(false);
            }
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
                popover.style.width = '';
            }
        }

        if (typeof global.markOnboardingTourSeen === 'function') {
            global.markOnboardingTourSeen(true);
        } else {
            try {
                localStorage.setItem(ONBOARDING_V2_KEY, 'true');
                localStorage.setItem(ONBOARDING_V1_KEY, 'true');
            } catch (e) {}
        }

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
        },
        {
            id: 'morphology_ai',
            label: '🧩 字根字首 ＆ AI 工具',
            heading: '【字根字首拆解、全局搜尋、批量格式與 AI 額度說明】',
            faqs: [
                {
                    q: 'Q1：刷字卡時出現的藍色／綠色／琥珀色底線是什麼？怎麼切換開關？',
                    a: 'LZHCard 會自動偵測英文單字的「字首（藍色底線）」、「字根（綠色底線）」與「字尾（琥珀色底線）」。刷卡時直接點擊底線片段即可打開字源意義小卡，系統已做點擊隔離處理，不會誤翻卡片；預設為開啟，亦可至「設定 → 字卡顯示設定 → 刷卡自動標示字首／字根／字尾」關閉。'
                },
                {
                    q: 'Q2：字庫管理左上角「☰」與分析頁左上角「☰」各有什麼功能？',
                    a: '• 字庫管理頁左上角「☰」提供兩大工具：\n  1) 字根字首字典與問答：優先貼出內建資料庫收錄的字根字首詳解；未收錄字根可點擊 ✨ AI 額度查詢並進行多輪自訂問答（消耗解析額度）。\n  2) 全局查字：橫跨玩家既有字庫與 7000 單分級庫（L1～L6），即時顯示難易度分級並可一鍵加入指定字庫；查無收錄可改用 ✨ AI 查詢（消耗解析額度）。\n• 分析（統計）頁左上角「☰」則可呼叫 ✨ AI 學習狀況診斷（消耗長文額度），整合考試錯題與刷卡留存數據給出改善建議。'
                },
                {
                    q: 'Q3：新版批量匯入的統一格式是什麼？遇到非格式文字或考卷圖片怎麼辦？',
                    a: '統一格式嚴格採用逗號分隔：「目標單字,釋義,詞性,發音」，換行代表下一個字（空白保留以支援片語）；中間欄位留空需保留逗號（例：happy,,adj.,[ˈhæpɪ]），末端欄位省略可直接不打（例：happy,開心 或 happy,,）。例句與翻譯則用 1."例句" 與 2."翻譯" 表示。\n若是文章筆記、混合格式或考卷截圖，請點擊批量匯入彈窗左上角「☰」，即可貼上任意文字或上傳圖片搭配自訂提示詞交由 ✨ AI 解析（純文字消耗解析額度／附圖片消耗識圖額度）。'
                },
                {
                    q: 'Q4：考試模式有哪些針對日文與同語（母語＝目標語言）的進階設計？',
                    a: '• 英文拼寫測驗支援切換「詞性／時態變化拼寫」，優先由玩家字庫衍生詞與內建變化題庫出題，不足時可選用 ✨ AI 生成變化題（消耗解析額度）。\n• 日文提供科學實證題型：包含「文脈漢字読み」、「助詞精準辨析」與「動詞/形容詞活用変換」。\n• 當目標語言與母語相同（例如繁中對繁中），考試頁面將開放「同語進階考題」，收錄經嚴格查證之歷屆學測／會考經典文言實詞古今異義，以及完全對齊中華民國教育部最新《國語一字多音審訂表》之標準讀音（絕不臆測，✨ AI 僅做標準答案後的深化舉例輔助）。'
                }
            ]
        },
        {
            id: 'classroom_policy',
            label: '🎓 班級方案與規範',
            heading: '【班級老師模式、月訂閱制與自訂語言維護規範】',
            faqs: [
                {
                    q: 'Q1：「班級老師模式」怎麼開啟？有哪些控場與教學工具？',
                    a: '在聊天室建立群組時勾選開啟「班級老師模式」（每班上限 50 人）即可啟動教學空間：老師可一鍵全體禁言或個別禁言學生；支援發起自訂單字／勾選字庫／✨ AI 出題挑戰，可設定拼字或選擇題、題數與選項數量（2～6 個），並支援「老師同步跳題／立刻結束」與「限時自由作答」雙節奏，排行榜嚴格依「正確率優先、作答總時間次之」排序；老師亦可派發每日刷卡／做題任務並檢視成員進度（預設成員互看，可於設定切換為僅限老師查看）。'
                },
                {
                    q: 'Q2：老師班級會員方案價格與 AI 共享規則為何？',
                    a: '本平台全面採用月訂閱制（不設一年期買斷方案）。其中「老師班級方案」為每月 NT$ 490（iOS App Store NT$ 539／或 1,960 金幣），只要老師開通此方案，該班級群組內最多 50 名學生在班級活動期間即可共同享用 ✨ AI 出題與 AI 輔助額度；若老師未開通班級方案，則僅限個別擁有對應會員資格者可使用進階 AI 功能。'
                },
                {
                    q: 'Q3：為什麼換手機或直接滑掉 App 都能不漏資料且更省雲端額度？',
                    a: '系統於雲端架構導入「差異化字庫分片同步（Deck Manifest Diff）」與離線 Beacon 保護（sync/beacon），僅上傳有變動的字庫分片而非整包重寫，在大幅降低 Firestore 讀寫次數的同時，確保跨裝置登入即時銜接不掉進度。'
                },
                {
                    q: 'Q4：系統支援哪些語言？選擇「自訂語言」有什麼說明？',
                    a: 'LZHCard 內建繁體中文、英文與日文三語介面與專屬題庫。當您選用「自訂語言」時，新手示範包、快速收錄與教學範例皆以英文作為示範基準並配合 AI 彈性提示處理。如果您希望為特定語言購買長期的專屬語言包更新與維護服務，歡迎聯繫開發者（tomlin980415@gmail.com）依需求約定固定月費專案維護。'
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
