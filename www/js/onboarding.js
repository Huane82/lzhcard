/**
 * 🚀 新手客製化設定與互動導覽教學模組 (js/onboarding.js)
 */

let currentTourIndex = 0;

// 🎯 備援 9 步驟導覽 (若 helpAndTour.js 未載入時使用)
const TOUR_STEPS = [
    {
        targetId: 'headerCategorySelector',
        titleKey: 'tourCatTitle',
        descKey: 'tourCatDesc',
        tab: 'home'
    },
    {
        targetId: 'headerChatBtn',
        titleKey: 'tourChatTitle',
        descKey: 'tourChatDesc',
        tab: 'home'
    },
    {
        targetId: 'sec-home',
        titleKey: 'tourHomeTitle',
        descKey: 'tourHomeDesc',
        tab: 'home'
    },
    {
        targetId: 'bnav-list',
        titleKey: 'tourListTitle',
        descKey: 'tourListDesc',
        tab: 'home'
    },
    {
        targetId: 'bnav-store',
        titleKey: 'tourStoreTitle',
        descKey: 'tourStoreDesc',
        tab: 'home'
    },
    {
        targetId: 'bnav-stats',
        titleKey: 'tourStatsTitle',
        descKey: 'tourStatsDesc',
        tab: 'home'
    },
    {
        targetId: 'bnav-settings',
        titleKey: 'tourSettingsTitle',
        descKey: 'tourSettingsDesc',
        tab: 'home'
    },
    {
        targetId: 'settingsAudioSlot',
        titleKey: 'lblAutoPlayAudio',
        descKey: 'descAutoPlayAudio',
        tab: 'home',
        openSettings: true
    },
    {
        targetId: 'settingsFrontSentenceSlot',
        titleKey: 'lblShowSentenceFront',
        descKey: 'descShowSentenceFront',
        tab: 'home',
        openSettings: true
    }
];

/**
 * 🗣️ 切換母語選單時，即時觸發全站與 Modal 文字翻譯
 */
function handleObNativeChange(langCode) {
    localStorage.setItem('lzhcard_native_lang', langCode);
    if (typeof applyLanguageUI === 'function') {
        applyLanguageUI();
    }
    if (typeof syncSettingsUI === 'function') {
        syncSettingsUI();
    }
}

/**
 * 🛠️ 控制新手設定 Modal 中個人 API Key 輸入框的顯隱狀態，並即時記憶選擇
 */
function toggleObApiKeyBox() {
    const isPersonal = Boolean(document.getElementById('obApiModePersonal')?.checked);
    const box = document.getElementById('obApiKeyBox');
    if (box) {
        box.classList.toggle('hidden', !isPersonal);
    }
    if (document.getElementById('obApiModePersonal') || document.getElementById('obApiModeShared')) {
        const mode = isPersonal ? 'personal' : 'shared';
        localStorage.setItem('lzhcard_api_mode', mode);
        if (typeof updateSettingsApiModeBadge === 'function') updateSettingsApiModeBadge(mode);
        if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
    }
}

/**
 * 📍 步驟 1 轉 步驟 2：儲存語言偏好並即時更新全站多語系 UI
 */
function confirmOnboardingLanguageStep() {
    const nativeLang = document.getElementById('obNativeLang')?.value || 'zh-TW';
    const targetLang = document.getElementById('obTargetLang')?.value || 'en';

    localStorage.setItem('lzhcard_native_lang', nativeLang);
    localStorage.setItem('lzhcard_target_lang', targetLang);

    if (typeof applyLanguageUI === 'function') {
        applyLanguageUI();
    }
    if (typeof syncSettingsUI === 'function') {
        syncSettingsUI();
    }

    const step1 = document.getElementById('obStep1');
    const step2 = document.getElementById('obStep2');
    if (step1) step1.classList.add('hidden');
    if (step2) step2.classList.remove('hidden');

    toggleObApiKeyBox();
}

/**
 * 🔙 步驟 2 返回 步驟 1
 */
function backToOnboardingStep1() {
    const step1 = document.getElementById('obStep1');
    const step2 = document.getElementById('obStep2');
    if (step2) step2.classList.add('hidden');
    if (step1) step1.classList.remove('hidden');
}

function getActiveOnboardingUid() {
    try {
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            return firebase.auth().currentUser.uid || '';
        }
    } catch (e) {}
    return '';
}

function getScopedOnboardingKey(baseKey, explicitUid = '') {
    const uid = explicitUid || getActiveOnboardingUid() || 'guest';
    return `${baseKey}__${uid}`;
}

function hasSeenOnboardingSetup() {
    try {
        const uid = getActiveOnboardingUid();
        const activeOwner = localStorage.getItem('lzhcard_active_uid') || (uid || 'guest');
        if (uid) {
            if (typeof window !== 'undefined' && window.userData?.settings?.onboardingCompleted === true) return true;
            if (localStorage.getItem(`lzhcard_onboarding_completed__${uid}`) === 'true') return true;
            if (activeOwner === uid && localStorage.getItem('lzhcard_onboarding_completed') === 'true') return true;
            return false;
        }
        if (localStorage.getItem('lzhcard_onboarding_completed__guest') === 'true') return true;
        if (activeOwner === 'guest' && localStorage.getItem('lzhcard_onboarding_completed') === 'true') return true;
    } catch (e) {}
    return false;
}

function markOnboardingSetupSeen(syncCloud = true) {
    const uid = getActiveOnboardingUid();
    try {
        localStorage.setItem('lzhcard_onboarding_completed', 'true');
        localStorage.setItem(getScopedOnboardingKey('lzhcard_onboarding_completed', uid), 'true');
    } catch (e) {}
    if (typeof window !== 'undefined') {
        if (!window.userData || typeof window.userData !== 'object') window.userData = {};
        if (!window.userData.settings || typeof window.userData.settings !== 'object') window.userData.settings = {};
        window.userData.settings.onboardingCompleted = true;
    }
    if (syncCloud !== false && uid && typeof db !== 'undefined' && db) {
        try {
            db.collection('users').doc(uid).set({
                settings: { onboardingCompleted: true },
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(() => {});
        } catch (e) {}
    }
}

function hasSeenOnboardingTour() {
    try {
        const uid = getActiveOnboardingUid();
        const activeOwner = localStorage.getItem('lzhcard_active_uid') || (uid || 'guest');
        if (uid) {
            if (typeof window !== 'undefined' && window.userData?.settings?.onboardingV2Done === true) return true;
            if (localStorage.getItem(`lzhcard_onboarding_v2_done__${uid}`) === 'true') return true;
            if (activeOwner === uid && localStorage.getItem('lzhcard_onboarding_v2_done') === 'true') return true;
            return false;
        }
        if (localStorage.getItem('lzhcard_onboarding_v2_done__guest') === 'true') return true;
        if (activeOwner === 'guest' && localStorage.getItem('lzhcard_onboarding_v2_done') === 'true') return true;
    } catch (e) {}
    return false;
}

function markOnboardingTourSeen(syncCloud = true) {
    markOnboardingSetupSeen(false);
    const uid = getActiveOnboardingUid();
    try {
        localStorage.setItem('lzhcard_onboarding_v2_done', 'true');
        localStorage.setItem(getScopedOnboardingKey('lzhcard_onboarding_v2_done', uid), 'true');
    } catch (e) {}
    if (typeof window !== 'undefined') {
        if (!window.userData || typeof window.userData !== 'object') window.userData = {};
        if (!window.userData.settings || typeof window.userData.settings !== 'object') window.userData.settings = {};
        window.userData.settings.onboardingCompleted = true;
        window.userData.settings.onboardingV2Done = true;
    }
    if (syncCloud !== false && uid && typeof db !== 'undefined' && db) {
        try {
            db.collection('users').doc(uid).set({
                settings: { onboardingCompleted: true, onboardingV2Done: true },
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(() => {});
        } catch (e) {}
    }
}

if (typeof window !== 'undefined') {
    window.hasSeenOnboardingSetup = hasSeenOnboardingSetup;
    window.markOnboardingSetupSeen = markOnboardingSetupSeen;
    window.hasSeenOnboardingTour = hasSeenOnboardingTour;
    window.markOnboardingTourSeen = markOnboardingTourSeen;
}

/**
 * 1. 同意條款/登入後觸發：開啟新手客製化設定 Modal (重置回 Step 1)
 */
function startOnboardingFlow() {
    if (typeof closeModal === 'function') closeModal('welcomeModal');
    
    // 若曾開啟或完成過新手設定則不再自動彈出
    if (hasSeenOnboardingSetup()) {
        return;
    }

    // 🛡️ 防止 Firebase 同步完成後重複觸發，導致使用者操作一半被重置回 Step 1 或共用 Key
    const setupModal = document.getElementById('onboardingSetupModal');
    if (setupModal && !setupModal.classList.contains('hidden')) {
        return;
    }

    // 只要開啟過新手初始設定，立即標記為已看過（同步本機與雲端），避免下次登入重複彈出
    markOnboardingSetupSeen(true);

    let savedNative = localStorage.getItem('lzhcard_native_lang');
    if (!savedNative) {
        const navLang = (navigator.language || '').toLowerCase();
        if (navLang.startsWith('zh')) savedNative = 'zh-TW';
        else if (navLang.startsWith('ja')) savedNative = 'ja';
        else savedNative = 'en';
        localStorage.setItem('lzhcard_native_lang', savedNative);
    }

    if (typeof applyLanguageUI === 'function') {
        applyLanguageUI();
    }

    const step1 = document.getElementById('obStep1');
    const step2 = document.getElementById('obStep2');
    if (step1) step1.classList.remove('hidden');
    if (step2) step2.classList.add('hidden');

    const nativeSelect = document.getElementById('obNativeLang');
    const targetSelect = document.getElementById('obTargetLang');
    const cardSelect = document.getElementById('obCardDisplayMode');
    const sentencePosSelect = document.getElementById('obSentencePos');
    const autoAudioSelect = document.getElementById('obAutoPlayAudio');
    const groqKeyInput = document.getElementById('obGroqApiKey');
    const keyInput = document.getElementById('obApiKey');

    if (nativeSelect) nativeSelect.value = savedNative;
    if (targetSelect) targetSelect.value = localStorage.getItem('lzhcard_target_lang') || 'en';
    if (cardSelect) cardSelect.value = localStorage.getItem('lzhcard_display_mode') || 'target_front';

    // 🔒 若使用者先前已設定過則保留原設定；未設定過才套用預設（句子在背面、自動語音關閉）
    const savedSentenceFront = localStorage.getItem('lzhcard_show_sentence_front');
    if (sentencePosSelect) {
        sentencePosSelect.value = (savedSentenceFront === 'true') ? 'front' : 'back';
    }

    const savedAutoAudio = localStorage.getItem('lzhcard_auto_audio');
    if (autoAudioSelect) {
        autoAudioSelect.value = (savedAutoAudio === 'true') ? 'true' : 'false';
    }
    
    const savedMode = localStorage.getItem('lzhcard_api_mode') || 'shared';
    const radShared = document.getElementById('obApiModeShared');
    const radPersonal = document.getElementById('obApiModePersonal');
    if (radShared) radShared.checked = (savedMode === 'shared');
    if (radPersonal) radPersonal.checked = (savedMode === 'personal');

    const savedGroq = localStorage.getItem('lzhcard_groq_key_v1') || '';
    const savedGemini = (typeof getValidApiKey === 'function')
        ? (getValidApiKey() || '')
        : (localStorage.getItem('flashcard_gemini_key_v1') || '');
    if (groqKeyInput) groqKeyInput.value = savedMode === 'personal' ? savedGroq : '';
    if (keyInput) keyInput.value = savedMode === 'personal' ? savedGemini : '';

    toggleObApiKeyBox();

    if (typeof openModal === 'function') openModal('onboardingSetupModal');
}

/**
 * 2. 略過設定 Modal（僅在尚未設定過時寫入預設值，不覆蓋使用者原有設定）
 */
async function skipOnboardingSetup() {
    if (localStorage.getItem('lzhcard_auto_audio') === null) {
        localStorage.setItem('lzhcard_auto_audio', 'false');
    }
    if (localStorage.getItem('lzhcard_show_sentence_front') === null) {
        localStorage.setItem('lzhcard_show_sentence_front', 'false');
    }
    markOnboardingSetupSeen(false);
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof renderFrontContextSentence === 'function' && typeof currentCard !== 'undefined') {
        renderFrontContextSentence(currentCard);
    }
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.saveSettingsOnly === 'function') {
        await StorageEngine.saveSettingsOnly({ onboardingCompleted: true });
    } else if (typeof saveStorage === 'function') {
        saveStorage();
    }
    if (typeof closeModal === 'function') closeModal('onboardingSetupModal');
    if (!hasSeenOnboardingTour()) {
        if (typeof OnboardingTour !== 'undefined' && typeof OnboardingTour.start === 'function') {
            OnboardingTour.start();
        } else {
            startInteractiveTour();
        }
    }
}

/**
 * 3. 儲存步驟 2 設定並即時同步至本機與 Firebase 雲端
 */
async function saveOnboardingSetupAndContinue() {
    const nativeLang = document.getElementById('obNativeLang')?.value || 'zh-TW';
    const targetLang = document.getElementById('obTargetLang')?.value || 'en';
    const cardMode = document.getElementById('obCardDisplayMode')?.value || 'target_front';
    const sentencePos = document.getElementById('obSentencePos')?.value || 'back';
    const autoAudioVal = document.getElementById('obAutoPlayAudio')?.value || 'false';
    const groqKey = document.getElementById('obGroqApiKey')?.value?.trim() || '';
    const apiKey = document.getElementById('obApiKey')?.value?.trim() || '';

    const apiMode = document.querySelector('input[name="obApiMode"]:checked')?.value || 'shared';
    const showFrontBool = sentencePos === 'front';
    const autoAudioBool = autoAudioVal === 'true';

    localStorage.setItem('lzhcard_native_lang', nativeLang);
    localStorage.setItem('lzhcard_target_lang', targetLang);
    localStorage.setItem('lzhcard_display_mode', cardMode);
    localStorage.setItem('lzhcard_show_sentence_front', showFrontBool ? 'true' : 'false');
    localStorage.setItem('lzhcard_auto_audio', autoAudioBool ? 'true' : 'false');
    localStorage.setItem('lzhcard_api_mode', apiMode);

    if (apiMode === 'personal') {
        if (groqKey) {
            localStorage.setItem('lzhcard_groq_key_v1', groqKey);
        } else {
            localStorage.removeItem('lzhcard_groq_key_v1');
        }
        if (apiKey) {
            localStorage.setItem('flashcard_gemini_key_v1', apiKey);
        } else {
            localStorage.removeItem('flashcard_gemini_key_v1');
        }
    } else {
        localStorage.removeItem('lzhcard_groq_key_v1');
        localStorage.removeItem('flashcard_gemini_key_v1');
    }

    if (typeof LZHEntitlements !== 'undefined' && typeof LZHEntitlements.backupPersonalKeysForUid === 'function') {
        LZHEntitlements.backupPersonalKeysForUid();
    }

    markOnboardingSetupSeen(false);

    if (typeof applyLanguageUI === 'function') applyLanguageUI();
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof updateApiKeyStatusUI === 'function') updateApiKeyStatusUI();
    if (typeof syncConfigToNativeOverlay === 'function') syncConfigToNativeOverlay();
    if (typeof FloatingTranslator !== 'undefined' && typeof FloatingTranslator.syncApiModeFromGlobal === 'function') {
        FloatingTranslator.syncApiModeFromGlobal(apiMode);
    }
    if (typeof LZHEntitlements !== 'undefined' && typeof LZHEntitlements.notifyStateChange === 'function') {
        LZHEntitlements.notifyStateChange('byok_key_saved', { finalMode: apiMode });
    }
    if (typeof updateUI === 'function') updateUI();
    if (typeof renderFrontContextSentence === 'function' && typeof currentCard !== 'undefined') {
        renderFrontContextSentence(currentCard);
    }
    if (typeof nextCard === 'function') nextCard(false);

    // 💾 立刻將設定獨立寫入 Firebase，避免 debounce 未執行或尚未完成載入就被覆蓋
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.saveSettingsOnly === 'function') {
        await StorageEngine.saveSettingsOnly({
            nativeLang,
            targetLang,
            displayMode: cardMode,
            showSentenceFront: showFrontBool,
            autoPlayAudio: autoAudioBool,
            apiMode,
            onboardingCompleted: true
        });
    } else {
        markOnboardingSetupSeen(true);
        if (typeof saveStorage === 'function') saveStorage(true);
    }

    if (typeof closeModal === 'function') closeModal('onboardingSetupModal');
    if (!hasSeenOnboardingTour()) {
        if (typeof OnboardingTour !== 'undefined' && typeof OnboardingTour.start === 'function') {
            OnboardingTour.start();
        } else {
            startInteractiveTour();
        }
    }
}

/**
 * 4. 開啟高亮聚焦導覽教學
 */
function startInteractiveTour() {
    if (typeof closeModal === 'function') closeModal('onboardingSetupModal');
    if (typeof OnboardingTour !== 'undefined' && typeof OnboardingTour.start === 'function') {
        OnboardingTour.start({ replay: true });
        return;
    }

    currentTourIndex = 0;
    const tourOverlay = document.getElementById('onboardingTourOverlay');
    if (tourOverlay) tourOverlay.classList.remove('hidden');

    renderTourStep(currentTourIndex);
}

/**
 * 繪製目前導覽步驟 (計算 Element 位置並高亮)
 */
function renderTourStep(index) {
    if (index < 0 || index >= TOUR_STEPS.length) {
        finishTour();
        return;
    }

    const step = TOUR_STEPS[index];

    if (step.tab && typeof switchTab === 'function') {
        switchTab(step.tab);
    }

    if (step.openSettings) {
        if (typeof openSettingsDrawer === 'function') openSettingsDrawer();
    } else {
        if (typeof closeSettingsDrawer === 'function') closeSettingsDrawer();
    }

    const applyHighlightPosition = () => {
        const targetElem = document.getElementById(step.targetId);
        const highlightBox = document.getElementById('tourHighlightBox');
        const popover = document.getElementById('tourPopover');

        if (!targetElem || !highlightBox || !popover) return;

        if (step.openSettings && typeof expandSettingsAccordionForElement === 'function') {
            expandSettingsAccordionForElement(targetElem);
        }

        if (step.openSettings && typeof targetElem.scrollIntoView === 'function') {
            try { targetElem.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
        }

        const rect = targetElem.getBoundingClientRect();

        highlightBox.style.top = `${rect.top - 6}px`;
        highlightBox.style.left = `${rect.left - 6}px`;
        highlightBox.style.width = `${rect.width + 12}px`;
        highlightBox.style.height = `${rect.height + 12}px`;

        const badgeText = `${index + 1} / ${TOUR_STEPS.length}`;
        const titleText = (typeof t === 'function') ? t(step.titleKey) : step.titleKey;
        const descText = (typeof t === 'function') ? t(step.descKey) : step.descKey;

        const badgeElem = document.getElementById('tourStepBadge');
        const titleElem = document.getElementById('tourStepTitle');
        const descElem = document.getElementById('tourStepDesc');

        if (badgeElem) badgeElem.innerText = badgeText;
        if (titleElem) titleElem.innerText = titleText;
        if (descElem) descElem.innerText = descText;

        const windowHeight = window.innerHeight;
        const windowWidth = window.innerWidth;
        const popoverHeight = popover.offsetHeight || 180;
        const popoverWidth = popover.offsetWidth || 320;

        let popoverTop = rect.bottom + 16;
        let popoverLeft = rect.left + (rect.width / 2) - (popoverWidth / 2);

        if (popoverTop + popoverHeight > windowHeight - 20) {
            popoverTop = rect.top - popoverHeight - 16;
        }

        if (popoverLeft < 10) popoverLeft = 10;
        if (popoverLeft + popoverWidth > windowWidth - 10) popoverLeft = windowWidth - popoverWidth - 10;

        popover.style.top = `${Math.max(10, popoverTop)}px`;
        popover.style.left = `${popoverLeft}px`;

        const prevBtn = document.getElementById('tourPrevBtn');
        const nextBtn = document.getElementById('tourNextBtn');

        if (prevBtn) prevBtn.disabled = (index === 0);

        if (nextBtn) {
            const finishText = (typeof t === 'function') ? t('btnFinishTour') : '完成導覽';
            const nextText = (typeof t === 'function') ? t('btnNextStep') : '下一步';

            if (index === TOUR_STEPS.length - 1) {
                nextBtn.innerText = finishText;
                nextBtn.className = "px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-xs";
            } else {
                nextBtn.innerHTML = `${nextText} <i class="fa-solid fa-chevron-right ml-1"></i>`;
                nextBtn.className = "px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-bold transition shadow-xs";
            }
        }
    };

    applyHighlightPosition();
    if (step.openSettings) {
        setTimeout(applyHighlightPosition, 240);
    }
}

function prevTourStep() {
    if (currentTourIndex > 0) {
        currentTourIndex--;
        renderTourStep(currentTourIndex);
    }
}

function nextTourStep() {
    if (currentTourIndex < TOUR_STEPS.length - 1) {
        currentTourIndex++;
        renderTourStep(currentTourIndex);
    } else {
        finishTour();
    }
}

function finishTour() {
    if (typeof finishOnboardingTour === 'function' && finishOnboardingTour !== finishTour) {
        return finishOnboardingTour();
    }
    if (typeof closeSettingsDrawer === 'function') closeSettingsDrawer();
    const tourOverlay = document.getElementById('onboardingTourOverlay');
    if (tourOverlay) {
        tourOverlay.classList.add('hidden');
        tourOverlay.style.pointerEvents = 'none';
    }

    markOnboardingTourSeen(true);
    if (typeof saveStorage === 'function') saveStorage();
    if (typeof switchTab === 'function') switchTab('home');
}
