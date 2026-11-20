/**
 * LZHCard - 多語系、顯示模式、主題與系統設定模組 (settings.js)
 */

const API_KEY_STORAGE_NAME = typeof STORAGE_KEY_APIKEY !== 'undefined' ? STORAGE_KEY_APIKEY : 'flashcard_gemini_key_v1';

/**
 * 🛡️ 確保跨頁彈窗（API Key 視窗、全域 Toast 提示）層級高於設定抽屜，避免被遮擋
 */
function ensureHighZIndexOverlays() {
    if (typeof document === 'undefined') return;

    const keyModalEl = document.getElementById('keyModal');
    if (keyModalEl) {
        keyModalEl.classList.remove('z-40', 'z-50');
        keyModalEl.classList.add('z-[65]');
    }

    const toastSelectors = ['#toastContainer', '#toast-container', '#toast', '#appToast', '[data-toast-container]'];
    toastSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
            el.classList.remove('z-40', 'z-50', 'z-[60]');
            el.classList.add('z-[80]');
            el.style.zIndex = '80';
        });
    });

    document.querySelectorAll('[id*="toast" i], [id*="Toast"]').forEach((el) => {
        if (el.id === 'settingsDrawer' || el.id === 'settingsDrawerPanel') return;
        const pos = window.getComputedStyle ? window.getComputedStyle(el).position : '';
        if (pos === 'fixed' || el.classList.contains('fixed')) {
            el.classList.remove('z-40', 'z-50', 'z-[60]');
            el.classList.add('z-[80]');
            el.style.zIndex = '80';
        }
    });
}

/**
 * 🔔 包裝全域 showToast，確保從設定抽屜內觸發任何提示時都不會被蓋住
 */
function bindHighZIndexToastWrapper() {
    if (typeof window === 'undefined' || typeof window.showToast !== 'function') return;
    if (window.showToast.__zIndexWrapped) return;

    const originalShowToast = window.showToast;
    const wrappedShowToast = function (...args) {
        ensureHighZIndexOverlays();
        const result = originalShowToast.apply(this, args);
        ensureHighZIndexOverlays();
        return result;
    };
    wrappedShowToast.__zIndexWrapped = true;
    window.showToast = wrappedShowToast;
}

/**
 * 🎨 變更主題設定 (light / dark / system)
 */
function handleThemeChange(mode) {
    localStorage.setItem('theme_preference', mode);
    applyTheme(mode);
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * 🌓 依據模式套用主題至 <html> DOM
 */
function applyTheme(mode) {
    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (mode === 'dark' || (mode === 'system' && isSystemDark)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

// 監聽系統深色模式變更
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const preference = localStorage.getItem('theme_preference') || 'system';
    if (preference === 'system') {
        applyTheme('system');
    }
});

/**
 * 🔄 同步設定頁面 UI 狀態
 */
function syncSettingsUI() {
    ensureHighZIndexOverlays();
    bindHighZIndexToastWrapper();

    const savedNative = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
    const savedTarget = localStorage.getItem('lzhcard_target_lang') || 'en';
    const customNative = localStorage.getItem('lzhcard_custom_native') || '';
    const customTarget = localStorage.getItem('lzhcard_custom_target') || '';
    const savedDisplayMode = localStorage.getItem('lzhcard_display_mode') || 'target_front';
    const savedPhoneticPos = localStorage.getItem('lzhcard_phonetic_pos') || 'front';
    const savedTheme = localStorage.getItem('theme_preference') || 'system';
    const savedApiMode = localStorage.getItem('lzhcard_api_mode') || 'shared';

    const nativeSelect = document.getElementById('nativeLangSelect');
    if (nativeSelect) nativeSelect.value = savedNative;

    const targetSelect = document.getElementById('targetLangSelect');
    if (targetSelect) targetSelect.value = savedTarget;

    const displaySelect = document.getElementById('cardDisplayModeSelect');
    if (displaySelect) displaySelect.value = savedDisplayMode;

    const phoneticPosSelect = document.getElementById('phoneticPosSelect');
    if (phoneticPosSelect) phoneticPosSelect.value = savedPhoneticPos;

    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) themeSelect.value = savedTheme;

    // 同步 API Key 模式單選框、已儲存金鑰與輸入框顯示狀態
    const radShared = document.getElementById('apiModeShared');
    const radPersonal = document.getElementById('apiModePersonal');
    const apiKeyInput = document.getElementById('geminiApiKeyInput');
    if (radShared) radShared.checked = (savedApiMode === 'shared');
    if (radPersonal) radPersonal.checked = (savedApiMode === 'personal');
    if (apiKeyInput) {
        apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE_NAME) || '';
    }
    switchApiMode(savedApiMode);

    const customNativeInput = document.getElementById('customNativeInput');
    if (customNativeInput) {
        customNativeInput.value = customNative;
        customNativeInput.classList.toggle('hidden', savedNative !== 'custom');
    }

    const customTargetInput = document.getElementById('customTargetInput');
    if (customTargetInput) {
        customTargetInput.value = customTarget;
        customTargetInput.classList.toggle('hidden', savedTarget !== 'custom');
    }

    // 同步暱稱輸入框
    const nicknameInput = document.getElementById('profileNicknameInput') || document.getElementById('settingsNicknameInput');
    if (nicknameInput && window.userData && window.userData.nickname) {
        nicknameInput.value = window.userData.nickname;
    }

    // 🟢 同步「隱藏線上狀態與已讀」切換開關 (privacyStatusToggle)
    const privacyToggle = document.getElementById('privacyStatusToggle');
    if (privacyToggle) {
        privacyToggle.checked = !!(window.userData && window.userData.privacyHideStatus);
    }

    // 🔊 同步「切換單字卡自動播放發音」開關 (autoPlayAudioToggle)
    const autoAudioToggle = document.getElementById('autoPlayAudioToggle');
    if (autoAudioToggle) {
        autoAudioToggle.checked = localStorage.getItem('lzhcard_auto_audio') === 'true';
    }

    // 📖 同步「字卡正面顯示例句（語境推理模式）」開關 (showSentenceFrontToggle)
    const sentenceFrontToggle = document.getElementById('showSentenceFrontToggle');
    if (sentenceFrontToggle) {
        sentenceFrontToggle.checked = localStorage.getItem('lzhcard_show_sentence_front') === 'true';
    }

    // 🌐 同步「啟用全域懸浮翻譯視窗」開關 (floatingTranslatorToggle)
    const floatingToggle = document.getElementById('floatingTranslatorToggle');
    if (floatingToggle) {
        const storedFt = localStorage.getItem('lzhcard_floating_translator_enabled');
        floatingToggle.checked = storedFt === null ? true : storedFt === 'true';
    }

    // 🔒 同步「公開我的學習統計資料」開關 (publicStatsToggle)
    const publicStatsToggle = document.getElementById('publicStatsToggle');
    if (publicStatsToggle) {
        const isPublic = !(window.userData && window.userData.privacy && window.userData.privacy.isStatsPublic === false);
        publicStatsToggle.checked = isPublic;
    }

    // 🔔 同步「通知系統」四項推播開關
    const notifPrefs = getNotificationSettings();
    const notifFriendMsgEl = document.getElementById('notifFriendMsgToggle');
    if (notifFriendMsgEl) notifFriendMsgEl.checked = notifPrefs.friendMsg;
    const notifAnnEl = document.getElementById('notifAnnouncementsToggle');
    if (notifAnnEl) notifAnnEl.checked = notifPrefs.announcements;
    const notifReqEl = document.getElementById('notifFriendRequestsToggle');
    if (notifReqEl) notifReqEl.checked = notifPrefs.friendRequests;
    const notifTeamEl = document.getElementById('notifTeamInvitesToggle');
    if (notifTeamEl) notifTeamEl.checked = notifPrefs.teamInvites;
    if (typeof syncChatNotificationMuteIndicators === 'function') {
        syncChatNotificationMuteIndicators();
    }

    // 🚨 同步「永久註銷帳號」按鈕顯示狀態（僅登入使用者顯示啟用）
    const dangerWrap = document.getElementById('settingsAccountDangerSlot');
    if (dangerWrap) {
        const hasSignedUser = typeof firebase !== 'undefined' && firebase.auth && Boolean(firebase.auth().currentUser);
        const delBtn = document.getElementById('btnOpenDeleteAccountModal');
        if (delBtn) {
            delBtn.classList.toggle('opacity-50', !hasSignedUser);
        }
    }

    // 📅 同步每日臨時等級覆蓋狀態
    syncDailyFreeSyncUI();
}

function handlePrivacyToggleChange(enableHide) {
    if (typeof togglePrivacyHideStatus === 'function') {
        togglePrivacyHideStatus(Boolean(enableHide));
    }
}

function handleAutoPlayAudioChange(enableAuto) {
    const isEnabled = Boolean(enableAuto);
    localStorage.setItem('lzhcard_auto_audio', isEnabled ? 'true' : 'false');

    if (!isEnabled && typeof stopSpeakingWord === 'function') {
        stopSpeakingWord();
    }

    if (typeof saveStorage === 'function') saveStorage();

    ensureHighZIndexOverlays();
    if (typeof showToast === 'function') {
        const msgKey = isEnabled ? 'toastAutoAudioEnabled' : 'toastAutoAudioDisabled';
        const fallback = isEnabled ? '🔊 已開啟：切換單字卡時自動播放語音' : '🔇 已關閉單字卡自動語音';
        const res = typeof t === 'function' ? t(msgKey) : fallback;
        showToast(res && res !== msgKey ? res : fallback, 'info');
    }
}

function handleShowSentenceFrontChange(enableFrontSentence) {
    const isEnabled = Boolean(enableFrontSentence);
    localStorage.setItem('lzhcard_show_sentence_front', isEnabled ? 'true' : 'false');

    if (typeof nextCard === 'function') {
        nextCard(false);
    } else if (typeof renderFrontContextSentence === 'function' && typeof currentCard !== 'undefined') {
        renderFrontContextSentence(currentCard);
    }

    if (typeof saveStorage === 'function') saveStorage();

    ensureHighZIndexOverlays();
    if (typeof showToast === 'function') {
        showToast(
            isEnabled
                ? '📖 已開啟：字卡正面顯示例句（語境推理模式）'
                : '🙈 已關閉字卡正面例句顯示',
            'info'
        );
    }
}

function handleFloatingTranslatorChange(enableFloating) {
    const isEnabled = Boolean(enableFloating);
    localStorage.setItem('lzhcard_floating_translator_enabled', isEnabled ? 'true' : 'false');

    if (typeof FloatingTranslator !== 'undefined' && typeof FloatingTranslator.setEnabled === 'function') {
        FloatingTranslator.setEnabled(isEnabled);
    }

    if (typeof saveStorage === 'function') saveStorage();

    ensureHighZIndexOverlays();
    if (typeof showToast === 'function') {
        showToast(
            isEnabled
                ? '🌐 已啟用全域懸浮翻譯視窗（按 Alt+T 可隨時展開）'
                : '🙈 已隱藏全域懸浮翻譯視窗',
            'info'
        );
    }
}

const NOTIFICATION_SETTING_KEYS = {
    friendMsg: 'lzhcard_notif_friend_msg',
    announcements: 'lzhcard_notif_announcements',
    friendRequests: 'lzhcard_notif_friend_requests',
    teamInvites: 'lzhcard_notif_team_invites'
};

function getNotificationSettings() {
    return {
        friendMsg: localStorage.getItem(NOTIFICATION_SETTING_KEYS.friendMsg) !== 'false',
        announcements: localStorage.getItem(NOTIFICATION_SETTING_KEYS.announcements) !== 'false',
        friendRequests: localStorage.getItem(NOTIFICATION_SETTING_KEYS.friendRequests) !== 'false',
        teamInvites: localStorage.getItem(NOTIFICATION_SETTING_KEYS.teamInvites) !== 'false'
    };
}

function handleNotificationSettingChange(type, enabled, options = {}) {
    const storageKey = NOTIFICATION_SETTING_KEYS[type];
    if (!storageKey) return false;

    const isEnabled = Boolean(enabled);
    localStorage.setItem(storageKey, isEnabled ? 'true' : 'false');

    const toggleIdMap = {
        friendMsg: 'notifFriendMsgToggle',
        announcements: 'notifAnnouncementsToggle',
        friendRequests: 'notifFriendRequestsToggle',
        teamInvites: 'notifTeamInvitesToggle'
    };
    const toggleEl = typeof document !== 'undefined' ? document.getElementById(toggleIdMap[type]) : null;
    if (toggleEl) toggleEl.checked = isEnabled;

    if (typeof syncChatNotificationMuteIndicators === 'function') {
        syncChatNotificationMuteIndicators();
    }
    if (typeof saveStorage === 'function') saveStorage();

    if (!options || !options.silent) {
        ensureHighZIndexOverlays();
        if (typeof showToast === 'function') {
            const labelMap = {
                friendMsg: '好友訊息通知',
                announcements: 'Chat 公告通知',
                friendRequests: '加好友申請通知',
                teamInvites: '組隊邀請通知'
            };
            const label = labelMap[type] || '系統通知';
            showToast(isEnabled ? `🔔 已開啟「${label}」` : `🔕 已關閉「${label}」`, 'info');
        }
    }
    return true;
}

function setSettingsAccordionOpen(catKey, isOpen) {
    if (typeof document === 'undefined' || !catKey) return false;
    const body = document.querySelector(`[data-settings-accordion-body="${catKey}"]`);
    const btn = document.querySelector(`[data-settings-accordion-btn="${catKey}"]`);
    const chevron = document.querySelector(`[data-settings-chevron="${catKey}"]`);
    if (!body) return false;

    const open = Boolean(isOpen);
    body.classList.toggle('hidden', !open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (chevron) chevron.classList.toggle('rotate-180', open);
    return true;
}

function toggleSettingsAccordion(catKey) {
    if (typeof document === 'undefined' || !catKey) return false;
    const body = document.querySelector(`[data-settings-accordion-body="${catKey}"]`);
    if (!body) return false;
    const willOpen = body.classList.contains('hidden');
    return setSettingsAccordionOpen(catKey, willOpen);
}

function resetSettingsAccordions() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-settings-accordion-body]').forEach((body) => {
        body.classList.add('hidden');
    });
    document.querySelectorAll('[data-settings-accordion-btn]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('[data-settings-chevron]').forEach((chevron) => {
        chevron.classList.remove('rotate-180');
    });
}

function expandSettingsAccordionForElement(targetElem) {
    if (!targetElem || typeof targetElem.closest !== 'function') return false;
    const accWrapper = targetElem.closest('[data-settings-accordion]');
    if (!accWrapper) return false;
    const catKey = accWrapper.getAttribute('data-settings-accordion');
    if (!catKey) return false;
    return setSettingsAccordionOpen(catKey, true);
}

if (typeof window !== 'undefined') {
    window.handlePrivacyToggleChange = handlePrivacyToggleChange;
    window.handleAutoPlayAudioChange = handleAutoPlayAudioChange;
    window.handleShowSentenceFrontChange = handleShowSentenceFrontChange;
    window.handleFloatingTranslatorChange = handleFloatingTranslatorChange;
    window.getNotificationSettings = getNotificationSettings;
    window.handleNotificationSettingChange = handleNotificationSettingChange;
    window.setSettingsAccordionOpen = setSettingsAccordionOpen;
    window.toggleSettingsAccordion = toggleSettingsAccordion;
    window.resetSettingsAccordions = resetSettingsAccordions;
    window.expandSettingsAccordionForElement = expandSettingsAccordionForElement;
}

/**
 * 🔄 同步每日臨時等級覆蓋狀態 UI
 */
function syncDailyFreeSyncUI() {
    const statusEl = document.getElementById('dailySyncStatusText');
    if (!statusEl) return;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let uid = 'guest';
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.getCurrentUid === 'function') {
        uid = StorageEngine.getCurrentUid();
    }
    const lastSyncKey = (typeof StorageEngine !== 'undefined' && typeof StorageEngine.getScopedKey === 'function')
        ? StorageEngine.getScopedKey('lzhcard_last_daily_fsrs_sync', uid)
        : `lzhcard_last_daily_fsrs_sync_${uid}`;
    const lastDate = localStorage.getItem(lastSyncKey);
    const isSynced = (lastDate === todayStr);

    if (isSynced) {
        statusEl.innerText = (typeof t === 'function' ? t('statusDailySynced') : '') || '今日已同步 (已對齊 FSRS)';
        statusEl.className = 'text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5';
    } else {
        statusEl.innerText = (typeof t === 'function' ? t('statusDailyPending') : '') || '待同步 (將於今日學習時對齊)';
        statusEl.className = 'text-[11px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5';
    }
}

/**
 * ⚡ 手動觸發以正式 FSRS 等級覆蓋臨時自由練習等級
 */
function handleManualFSRSToFreeSync() {
    if (typeof window.applyDailyFSRSToFreeSync === 'function') {
        window.applyDailyFSRSToFreeSync(true);
        ensureHighZIndexOverlays();
        if (typeof showToast === 'function') {
            const msg = (typeof t === 'function' ? t('toastDailySyncManualDone') : '') || '已成功將正式 FSRS 等級覆蓋至自由練習臨時等級！';
            showToast(msg, 'success');
        }
        syncDailyFreeSyncUI();
        if (typeof updateUI === 'function') updateUI();
        if (typeof refreshFSRSUIBadges === 'function') refreshFSRSUIBadges();
    }
}

if (typeof window !== 'undefined') {
    window.syncDailyFreeSyncUI = syncDailyFreeSyncUI;
    window.handleManualFSRSToFreeSync = handleManualFSRSToFreeSync;
}

/**
 * 🔊📖 初始化學習語音與例句位置預設值（僅在尚未設定過時寫入，絕不覆蓋既有設定）
 */
function initStudyPreferenceDefaults() {
    if (localStorage.getItem('lzhcard_auto_audio') === null) {
        localStorage.setItem('lzhcard_auto_audio', 'false');
    }
    if (localStorage.getItem('lzhcard_show_sentence_front') === null) {
        localStorage.setItem('lzhcard_show_sentence_front', 'false');
    }
    if (localStorage.getItem('lzhcard_floating_translator_enabled') === null) {
        localStorage.setItem('lzhcard_floating_translator_enabled', 'true');
    }
    Object.values(NOTIFICATION_SETTING_KEYS).forEach((key) => {
        if (localStorage.getItem(key) === null) {
            localStorage.setItem(key, 'true');
        }
    });
}

/**
 * 🌐 初始化系統語言與學習偏好預設值
 */
function initLanguageSettings() {
    if (!localStorage.getItem('lzhcard_native_lang')) {
        const navLang = (navigator.language || '').toLowerCase();
        if (navLang.startsWith('zh')) {
            localStorage.setItem('lzhcard_native_lang', 'zh-TW');
        } else if (navLang.startsWith('ja')) {
            localStorage.setItem('lzhcard_native_lang', 'ja');
        } else {
            localStorage.setItem('lzhcard_native_lang', 'en');
        }
    }

    if (!localStorage.getItem('lzhcard_target_lang')) {
        localStorage.setItem('lzhcard_target_lang', 'en');
    }

    initStudyPreferenceDefaults();
    syncSettingsUI();

    if (typeof updateBatchPlaceholders === 'function') {
        updateBatchPlaceholders();
    }

    if (typeof applyLanguageUI === 'function') {
        applyLanguageUI();
    }
}

/**
 * 🗣️ 切換母語設定
 */
function handleNativeLangChange(lang) {
    localStorage.setItem('lzhcard_native_lang', lang);
    syncSettingsUI();

    if (typeof applyLanguageUI === 'function') {
        applyLanguageUI();
    }

    if (typeof showToast === 'function') showToast(t('toastNativeLangUpdated'), 'info');
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * 🎯 切換學習目標語言
 */
function handleTargetLangChange(lang) {
    localStorage.setItem('lzhcard_target_lang', lang);
    syncSettingsUI();

    if (typeof updateBatchPlaceholders === 'function') {
        updateBatchPlaceholders();
    }

    if (typeof showToast === 'function') showToast(t('toastTargetLangUpdated'), 'info');
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * ✍️ 處理自訂語言變更
 */
function handleCustomLangChange(type, value) {
    const cleanValue = value.trim();
    if (type === 'native') {
        localStorage.setItem('lzhcard_custom_native', cleanValue);
        if (cleanValue && typeof translateUiWithAI === 'function') {
            translateUiWithAI(cleanValue);
        }
    } else if (type === 'target') {
        localStorage.setItem('lzhcard_custom_target', cleanValue);
    }
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * 🎴 切換卡片正面顯示模式 (外文 / 母語 / 雙語)
 */
function handleCardDisplayModeChange(mode) {
    localStorage.setItem('lzhcard_display_mode', mode);
    if (typeof updateUI === 'function') updateUI();
    if (typeof nextCard === 'function') nextCard();
    if (typeof showToast === 'function') showToast(t('toastDisplayModeUpdated'), 'success');
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * 🔤 切換音標 / 讀音顯示位置 (正面 / 背面)
 */
function handlePhoneticPosChange(mode) {
    localStorage.setItem('lzhcard_phonetic_pos', mode);
    if (typeof updateUI === 'function') updateUI();
    if (typeof nextCard === 'function') nextCard();
    if (typeof showToast === 'function') {
        const msgKey = mode === 'back' ? 'toastPhoneticBack' : 'toastPhoneticFront';
        showToast(t(msgKey), 'info');
    }
    if (typeof saveStorage === 'function') saveStorage();
}

/**
 * 🎛️ 切換 Gemini API 金鑰模式 UI 顯示 (personal / shared)
 */
function switchApiMode(mode) {
    const box = document.getElementById('personalKeyInputBox');
    if (box) {
        if (mode === 'shared') {
            box.classList.add('hidden');
        } else {
            box.classList.remove('hidden');
        }
    }
}

/**
 * 🔑 儲存 Gemini API Key (支援個人 Key / 免費共用 Key 雙軌存檔)
 */
function handleSaveApiKey() {
    const selectedMode = document.querySelector('input[name="apiMode"]:checked')?.value || 'shared';

    if (selectedMode === 'personal') {
        const keyInput = document.getElementById('geminiApiKeyInput');
        const key = keyInput ? keyInput.value.trim() : '';
        if (!key) {
            if (typeof showToast === 'function') showToast(t('toastEnterApiKey') || '請輸入個人 API Key！', 'warning');
            return;
        }
        localStorage.setItem(API_KEY_STORAGE_NAME, key);
    }

    localStorage.setItem('lzhcard_api_mode', selectedMode);

    if (typeof updateApiKeyStatusUI === 'function') {
        updateApiKeyStatusUI();
    }

    if (typeof saveStorage === 'function') {
        saveStorage();
    }

    if (typeof closeModal === 'function') closeModal('keyModal');
    if (typeof showToast === 'function') showToast(t('toastKeySaved') || '設定已儲存！', 'success');
}

/* ==========================================================================
   🔒 登入門檻與服務條款 (TOS) 控制邏輯
   ========================================================================== */

function toggleAuthButtons() {
    const isChecked = document.getElementById('tosCheckbox')?.checked || false;
    const googleBtn = document.getElementById('welcomeGoogleBtn');
    const guestBtn = document.getElementById('welcomeGuestBtn');

    if (googleBtn) {
        googleBtn.disabled = !isChecked;
        if (isChecked) {
            googleBtn.className = "w-full py-3 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition border border-slate-300 dark:border-slate-600 shadow-sm cursor-pointer";
        } else {
            googleBtn.className = "w-full py-3 bg-slate-200 dark:bg-slate-700 text-slate-400 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-not-allowed opacity-60";
        }
    }

    if (guestBtn) {
        guestBtn.disabled = !isChecked;
        if (isChecked) {
            guestBtn.className = "w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition shadow-sm cursor-pointer";
        } else {
            guestBtn.className = "w-full py-3 bg-slate-200 dark:bg-slate-700 text-slate-400 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-not-allowed opacity-60";
        }
    }
}

function handleWelcomeGoogleLogin() {
    const isChecked = document.getElementById('tosCheckbox')?.checked;
    if (!isChecked) {
        if (typeof showToast === 'function') showToast('請先勾選同意服務與隱私條款！', 'warning');
        return;
    }
    localStorage.setItem('lzhcard_tos_accepted', 'true');
    if (typeof loginWithGoogle === 'function') {
        loginWithGoogle();
    }
}

function handleWelcomeGuestLogin() {
    const isChecked = document.getElementById('tosCheckbox')?.checked;
    if (!isChecked) {
        if (typeof showToast === 'function') showToast('請先勾選同意服務與隱私條款！', 'warning');
        return;
    }
    localStorage.setItem('lzhcard_tos_accepted', 'true');
    localStorage.setItem('lzhcard_guest_mode', 'true');
    
    if (window.userData) {
        window.userData.username = '訪客玩家';
        window.userData.role = 'user';
        if (typeof saveUserData === 'function') saveUserData();
    }

    // 1. 關閉歡迎與條款彈窗
    closeWelcomeModal();
    
    // 2. 訪客無需等待 Firestore 同步，直接檢查並開啟新手設定彈窗
    checkAndOpenOnboardingModal();

    if (typeof showToast === 'function') showToast('已以訪客身份進入系統！', 'success');
}

function closeWelcomeModal() {
    const modal = document.getElementById('welcomeModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function openWelcomeModal() {
    const modal = document.getElementById('welcomeModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function checkAuthAndTosState() {
    const tosAccepted = localStorage.getItem('lzhcard_tos_accepted') === 'true';
    const isGuest = localStorage.getItem('lzhcard_guest_mode') === 'true';

    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().onAuthStateChanged((user) => {
            if (typeof applyLanguageUI === 'function') applyLanguageUI();

            if (user) {
                closeWelcomeModal();
                syncSettingsUI();
                // 新手設定交由 StorageEngine.loadData() 完成雲端同步後再判斷開啟，避免換新裝置時誤彈視窗
            } else if (isGuest && tosAccepted) {
                closeWelcomeModal();
            } else {
                openWelcomeModal();
            }
        });
    } else {
        if (isGuest && tosAccepted) {
            closeWelcomeModal();
        } else {
            openWelcomeModal();
        }
    }
}

bindHighZIndexToastWrapper();

document.addEventListener('DOMContentLoaded', () => {
    ensureHighZIndexOverlays();
    bindHighZIndexToastWrapper();
    initLanguageSettings();

    const preference = localStorage.getItem('theme_preference') || 'system';
    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) themeSelect.value = preference;
    applyTheme(preference);

    syncSettingsUI();
    checkAuthAndTosState();
});

/**
 * 🚀 檢查是否已完成新手設定，若未完成則自動開啟設定彈窗
 */
function checkAndOpenOnboardingModal() {
    const onboardingCompleted = localStorage.getItem('lzhcard_onboarding_completed') === 'true';
    const onboardingV2Done = localStorage.getItem('lzhcard_onboarding_v2_done') === 'true';

    if (!onboardingCompleted) {
        if (typeof startOnboardingFlow === 'function') {
            startOnboardingFlow();
        } else {
            const setupModal = document.getElementById('onboardingSetupModal');
            if (setupModal) {
                setupModal.classList.remove('hidden');
                setupModal.classList.add('flex');
            }
        }
    } else if (!onboardingV2Done && typeof OnboardingTour !== 'undefined' && typeof OnboardingTour.start === 'function') {
        OnboardingTour.start();
    } else if (typeof StartupDeepLinkQueue !== 'undefined' && typeof StartupDeepLinkQueue.processWhenReady === 'function') {
        StartupDeepLinkQueue.processWhenReady();
    }
}
