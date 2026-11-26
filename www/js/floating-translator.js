/**
 * LZHCard - 全域三語懸浮翻譯、AI 拍照熱區取詞 & 即時雙語字幕引擎 (js/floating-translator.js)
 *
 * 完整整合 4 大核心模組（單一實作、無重複視窗與監聽器）：
 * 1. 模組一：EN / JA / ZH 三語智能分詞 (Intl.Segmenter) + App 全域點詞翻譯 & 頁面劃記多選入庫（嚴格防禦考試模式與字卡翻面衝突）
 * 2. 模組二：互動式「拍照翻譯」與多選單字 AI 建卡（Gemini Vision [ymin, xmin, ymax, xmax] 0~1000 百分比熱區、查字模式／選取模式切換）
 * 3. 模組三：跨平台懸浮翻譯視窗（Pointer Events 拖曳貼邊懸浮球、電腦端 Document Picture-in-Picture、快捷鍵 Alt+T/Esc/Ctrl+V）與 window.LZHNativeBridge
 * 4. 模組四：即時雙語字幕引擎（螢幕/影片 Canvas 像素幀差偵測 ROI 辨識 + 雙來源語音字幕：麥克風 SpeechRecognition／媒體分頁音訊 AnalyserNode + MediaRecorder）
 */
(function (global) {
    'use strict';

    const STORAGE_ENABLED_KEY = 'lzhcard_floating_translator_enabled';
    const STORAGE_POS_KEY = 'lzhcard_floating_pos_v1';
    const STORAGE_OPEN_KEY = 'lzhcard_floating_open_v1';
    const STORAGE_NATIVE_LANG_KEY = 'lzhcard_ft_target_native_lang_v1';
    const STORAGE_TAP_ENABLED_KEY = 'lzhcard_ft_screen_tap_v1';
    const STORAGE_SUBTITLE_POS_KEY = 'lzhcard_ft_subtitle_pos_v1';
    const STORAGE_VIDEO_ROI_MODE_KEY = 'lzhcard_ft_video_roi_mode_v1';
    const STORAGE_VIDEO_ROI_CFG_KEY = 'lzhcard_ft_video_roi_cfg_v1';
    const STORAGE_VIDEO_ROI_DUAL_KEY = 'lzhcard_ft_video_roi_dual_v1';
    const STORAGE_VIDEO_SOURCE_LANG_KEY = 'lzhcard_ft_video_source_lang_v1';
    const STORAGE_IOS_SCREEN_CFG_KEY = 'lzhcard_ios_screen_translate_cfg_v1';
    const STORAGE_IOS_BALL_VISIBLE_KEY = 'lzhcard_ios_inapp_ball_visible';
    const IDB_DICT_KEY = 'lzhcard_ft_trilingual_dict_v1';
    const SESSION_DICT_KEY = 'lzhcard_ft_trilingual_session_v1';
    const SHARED_WORKER_BASE = (typeof global.SHARED_BACKEND_URL === 'string' && global.SHARED_BACKEND_URL)
        ? global.SHARED_BACKEND_URL.replace(/\/+$/, '')
        : 'https://lzhcard.tomlin980415.workers.dev';

    let cachedEnvInsets = null;
    function getEffectiveSafeInsets() {
        try {
            if (document.documentElement && document.documentElement.getAttribute('data-widget-mode') === 'desktop') {
                return { top: 0, bottom: 0 };
            }
            if (!cachedEnvInsets) {
                const probe = document.createElement('div');
                probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:var(--lzh-effective-top, env(safe-area-inset-top, 0px));padding-bottom:var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px));';
                const host = document.body || document.documentElement;
                if (host) {
                    host.appendChild(probe);
                    const cs = getComputedStyle(probe);
                    cachedEnvInsets = {
                        top: Math.max(0, Math.round(parseFloat(cs.paddingTop) || 0)),
                        bottom: Math.max(0, Math.round(parseFloat(cs.paddingBottom) || 0))
                    };
                    probe.remove();
                }
            }
            if (cachedEnvInsets) return cachedEnvInsets;
        } catch (e) {}
        return { top: 0, bottom: 0 };
    }
    if (typeof global.addEventListener === 'function') {
        global.addEventListener('resize', () => { cachedEnvInsets = null; });
        global.addEventListener('orientationchange', () => { cachedEnvInsets = null; });
    }

    const DEFAULT_NATIVE_LANG = 'zh-TW';
    const SUPPORTED_NATIVE_LANGS = {
        'zh-TW': { code: 'zh-TW', label: '繁體中文', short: '繁中', speechLang: 'zh-TW', aiName: 'Traditional Chinese (繁體中文)' },
        'en': { code: 'en', label: 'English', short: 'EN', speechLang: 'en-US', aiName: 'English' },
        'ja': { code: 'ja', label: '日本語', short: '日本語', speechLang: 'ja-JP', aiName: 'Japanese (日本語)' }
    };

    const TARGET_LANG_LABELS = {
        'en': { badge: 'EN', name: 'English', speechLang: 'en-US' },
        'ja': { badge: 'JA', name: '日本語', speechLang: 'ja-JP' },
        'zh-TW': { badge: 'ZH', name: '中文', speechLang: 'zh-TW' }
    };

    // DOM 與 PiP 參照
    let rootEl = null;
    let ballEl = null;
    let panelHostEl = null;
    let panelContentEl = null;
    let tapBubbleEl = null;
    let selectionBarEl = null;
    let subtitleOverlayEl = null;
    let photoFullscreenEl = null;
    let photoFullscreenResizeObs = null;
    let pipWindowRef = null;
    let iosScreenModalEl = null;

    // 狀態控制
    let panelViewMode = 'translator'; // 'translator' | 'chat'
    let activeTab = 'camera'; // 'camera' | 'screen' | 'subtitle'
    let isOpen = false;
    let targetNativeLang = DEFAULT_NATIVE_LANG;
    let screenTapEnabled = false;
    let pageSelectMode = false;

    // 停靠與獨立字幕條位置狀態
    let posState = {
        dockSide: 'right',
        topPx: null,
        panelLeftPx: null,
        panelTopPx: null
    };
    let subtitleOverlayPos = {
        leftPx: null,
        topPx: null
    };

    // 三語快取與查詞狀態
    let idbDictCache = null;
    let idbLoaded = false;
    let idbLoadPromise = null;
    const inFlightLookupMap = new Map();
    let activeBubbleToken = 0;
    let activeBubbleWordData = null;

    // 頁面劃記選取狀態
    const pageSelectedWordsMap = new Map(); // normalizedKey -> { word, lang, marks: Set<HTMLElement> }

    // 拍照翻譯與多選熱區狀態
    let cameraStream = null;
    let photoMode = 'lookup'; // 'lookup' | 'select'
    let photoFullscreenOpen = false;
    let isImageModeActive = false;
    let panelFullscreen = false;
    let isVisionBusy = false;
    let photoImageDataUrl = '';
    let photoImageMime = 'image/jpeg';
    let photoImageBase64 = '';
    let photoNaturalWidth = 0;
    let photoNaturalHeight = 0;
    let photoTokens = []; // [{ id, text, lang, reading, pos, translation, box: [ymin,xmin,ymax,xmax] }]
    let photoSummary = '';
    let photoRawArticleText = '';
    let photoArticleTranslation = '';
    let photoArticleViewMode = 'trans'; // 'trans' | 'both'
    let isPhotoArticleTranslating = false;
    let photoActiveTokenId = null;
    const photoSelectedTokenIds = new Set();
    let inlinePhotoZoom = { scale: 1, tx: 0, ty: 0 };
    let fsPhotoZoom = { scale: 1, tx: 0, ty: 0 };
    let ftPhotoPinchGuardUntil = 0;

    // iOS 子母畫面 (PiP) 螢幕翻譯精靈與狀態
    let iosScreenWizardStep = 1;
    let iosScreenCapabilities = null;
    let iosOfflinePackReady = false;
    let iosOfflineDownloading = false;
    let iosPipActive = false;
    let iosPipPluginBound = false;
    let iosFallbackNotice = '';
    let _iosLiveSubtitleState = {
        broadcastActive: false,
        pipActive: false,
        ipcMode: 'local',
        loopbackReady: false,
        loopbackPort: 49152,
        lastConnectedVia: 'none',
        sourceText: '',
        translatedText: 'LZHCard 螢幕翻譯就緒，請點選開始廣播',
        updatedAt: 0
    };
    let iosScreenConfig = {
        setupCompleted: false,
        engine: 'apple_offline',
        cloudKeyMode: 'shared',
        sourceLang: 'en',
        targetLang: 'zh-TW',
        customApiKey: '',
        regionMode: 'auto',
        region: { x: 0.12, y: 0.75, width: 0.76, height: 0.18 },
        portraitRegionMode: 'auto',
        portraitRegion: { x: 0.08, y: 0.70, width: 0.84, height: 0.22 },
        landscapeRegionMode: 'auto',
        landscapeRegion: { x: 0.12, y: 0.74, width: 0.76, height: 0.20 },
        editingOrientation: 'portrait'
    };

    // 螢幕點詞輸入區狀態
    let screenScratchText = '';
    let screenScratchTranslation = '';
    let isScreenTextBusy = false;

    // 模組四：即時字幕引擎狀態 & 模式嚴格互斥
    let activeLiveMode = 'none'; // 'none' | 'voice' | 'screen'
    let subtitleSubMode = 'video'; // 'video' | 'stt' | 'youtube'
    let subtitlePinnedOverlay = true;
    // 4A. 螢幕 / 影片幀差 OCR（獨立直立與橫向偵測區域）
    let videoCaptureStream = null;
    let videoRoiMode = 'bottom25'; // 'bottom25' | 'bottom40' | 'top25' | 'auto' | 'custom'
    let videoRoiCustomRect = { xPct: 0.12, yPct: 0.75, wPct: 0.76, hPct: 0.18 };
    let videoRoiDualCfg = {
        portraitMode: 'bottom25',
        portraitRect: { xPct: 0.08, yPct: 0.70, wPct: 0.84, hPct: 0.22 },
        landscapeMode: 'bottom25',
        landscapeRect: { xPct: 0.12, yPct: 0.74, wPct: 0.76, hPct: 0.20 }
    };
    let videoSourceLang = 'en'; // 'en' | 'ja' | 'ko' | 'zh-TW'
    let videoMonitorTimer = null;
    let videoLastFrameLuma = null;
    let videoLastOcrAt = 0;
    let videoOcrInFlight = false;
    let videoLastOriginalText = '';
    let videoSourceElement = null;
    // 4B. 語音雙來源 STT + 4 層串流穩定器 + MediaRecorder 備援
    let sttSource = 'mic'; // 'mic' | 'tab'
    let sttInputLang = 'auto'; // 'auto' | 'en-US' | 'ja-JP' | 'zh-TW'
    let sttRunning = false;
    let speechRec = null;
    let sttTabStream = null;
    let sttMicStream = null;
    let sttMicRecorder = null;
    let sttMicChunkTimer = null;
    let sttAudioCtx = null;
    let sttAnalyser = null;
    let sttMediaRecorder = null;
    let sttChunkTimer = null;
    let sttStopwordTimer = null;
    let sttInactivityTimer = null;
    let sttProvisionalEntryId = '';
    let sttLastProvisionalText = '';
    let sttLastRefineDispatchAt = 0;
    let sttInterimText = '';
    let sttInterimDraft = '';
    let sttLastInterimTranslateAt = 0;
    const subtitleFeed = []; // [{ id, ts, orig, trans, lang, tier, provisional }]
    // 4C. 多平台 0ms 時間軸預譯引擎
    let ytUrlInput = '';
    let ytVideoId = '';
    let ytTitle = '';
    let ytLanguageCode = '';
    let ytCues = []; // [{ startMs, endMs, text, trans }]
    let ytLoading = false;
    let ytStatusText = '';
    let ytFallbackSuggested = false;
    let ytSuggestedModes = [];
    let ytPlaying = false;
    let ytCurrentMs = 0;
    let ytPlaybackRate = 1.0;
    let ytOffsetMs = 0;
    let ytLastTickAt = 0;
    let ytTickTimer = null;
    let ytActiveCueIdx = -1;

    // 模組五：懸浮好友聊天狀態
    let ftActiveChatId = '';
    let ftActiveChatTitle = '';
    let ftActiveChatPeerUid = '';
    let ftChatMessages = [];
    let ftChatReadByMap = {};
    let ftChatMsgsListener = null;
    let ftChatReadListener = null;
    let ftChatListenerPath = '';
    let ftChatFilterText = '';
    let ftChatSending = false;
    let ftFastRefineExhausted = false;
    let ftTesseractPromise = null;

    let globalListenersBound = false;

    /* ==========================================================================
       0. 工具函式、安全跳脫與三語自動偵測
       ========================================================================== */

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    const FT_SVG = {
        ballGlobe: '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18"/></svg>',
        globe: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/></svg>',
        chat: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        chatLg: '<svg class="w-7 h-7 mx-auto text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        arrows: '<svg class="w-3 h-3 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 16-4-4 4-4M17 8l4 4-4 4M3 12h18"/></svg>',
        camera: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
        cameraLg: '<svg class="w-7 h-7 mx-auto text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
        gallery: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
        shutter: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',
        screen: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3"/><rect x="7" y="8" width="10" height="8" rx="1.5"/></svg>',
        subtitle: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M6 12h4M12 12h6M6 16h8M16 16h2"/></svg>',
        cursor: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l7 16 2.5-6.5L20 11 4 4z"/></svg>',
        checkbox: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4"/></svg>',
        expand: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
        check: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
        close: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        pin: '<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
        returnWin: '<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
        mic: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M8 22h8"/></svg>',
        speaker: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
        play: '<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
        pause: '<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
        stop: '<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        sparkle: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>',
        grip: '<svg class="w-3 h-3 shrink-0 opacity-70" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
        windowSub: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 15h10"/></svg>'
    };

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    function toast(msg, type = 'info') {
        if (typeof global.showToast === 'function') {
            global.showToast(msg, type);
        }
    }

    function getTargetDoc() {
        return (pipWindowRef && !pipWindowRef.closed) ? pipWindowRef.document : document;
    }

    function q(id) {
        return getTargetDoc().getElementById(id) || document.getElementById(id);
    }

    function getNativeLangConfig(code) {
        const key = SUPPORTED_NATIVE_LANGS[code] ? code : targetNativeLang;
        return SUPPORTED_NATIVE_LANGS[key] || SUPPORTED_NATIVE_LANGS[DEFAULT_NATIVE_LANG];
    }

    function normalizeNativeLangCode(raw) {
        const s = String(raw || '').trim().toLowerCase();
        if (s === 'en' || s.startsWith('en-')) return 'en';
        if (s === 'ja' || s.startsWith('ja-')) return 'ja';
        return 'zh-TW';
    }

    function initNativeLangPreference() {
        const stored = localStorage.getItem(STORAGE_NATIVE_LANG_KEY);
        if (stored && SUPPORTED_NATIVE_LANGS[stored]) {
            targetNativeLang = stored;
            return;
        }
        const appNative = localStorage.getItem('lzhcard_native_lang');
        if (appNative) {
            targetNativeLang = normalizeNativeLangCode(appNative);
        } else {
            targetNativeLang = DEFAULT_NATIVE_LANG;
        }
    }

    function setTargetNativeLang(code) {
        const normalized = SUPPORTED_NATIVE_LANGS[code] ? code : normalizeNativeLangCode(code);
        targetNativeLang = normalized;
        try {
            localStorage.setItem(STORAGE_NATIVE_LANG_KEY, normalized);
        } catch (e) {}
        const sel = q('ftTargetNativeSelect');
        if (sel && sel.value !== normalized) sel.value = normalized;
        // 若目前氣泡或拍照熱區有字詞，重新查詢目標母語釋義
        if (activeBubbleWordData && activeBubbleWordData.word) {
            const word = activeBubbleWordData.word;
            const lang = activeBubbleWordData.lang;
            const rect = activeBubbleWordData._rect || null;
            openLookupBubbleForWord(word, lang, rect, activeBubbleWordData.contextSentence || '');
        }
        toast(`翻譯母語已切換為：${getNativeLangConfig(normalized).label}`, 'success');
    }

    /**
     * 偵測文字所屬語言：'ja' | 'zh-TW' | 'en'
     */
    function detectScriptLang(text, hintLang) {
        const str = String(text || '').trim();
        if (!str) return hintLang || 'en';
        // 只要包含平假名、片假名、日文長音/重複記號即判定為日文
        if (/[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F々〆ヵヶ]/.test(str)) {
            return 'ja';
        }
        // 包含中日韓漢字但無假名
        if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(str)) {
            if (hintLang === 'ja') return 'ja';
            return 'zh-TW';
        }
        // 包含英文字母
        if (/[A-Za-z]/.test(str)) {
            return 'en';
        }
        return hintLang || 'en';
    }

    function isWordCharForLang(seg, lang) {
        const s = String(seg || '').trim();
        if (!s) return false;
        if (lang === 'en') return /[A-Za-z]/.test(s);
        if (lang === 'ja') return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF々]/.test(s);
        return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s);
    }

    /**
     * 模組一：三語智能分詞引擎 (Intl.Segmenter + 混合語系區塊切分 + Fallback)
     * 回傳陣列：[{ segment, isWordLike, lang, index, end }]
     */
    function segmentTrilingualText(text, langHint = '') {
        const str = String(text || '');
        if (!str) return [];

        const out = [];
        // 先依字集區塊切出：英文詞、日文假名/漢字混合、空白與標點，確保中英日混排時各以專屬 locale 精準斷詞
        const hasKanaInWhole = /[\u3040-\u309F\u30A0-\u30FF々]/.test(str);
        const runRegex = /([A-Za-z]+(?:[’'\-][A-Za-z]+)*)|([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF々〆ヵヶ]+)|([^\sA-Za-z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]+|\s+)/g;

        let match;
        while ((match = runRegex.exec(str)) !== null) {
            const runText = match[0];
            const runStart = match.index;

            if (match[1]) {
                // 英文區塊
                if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
                    const seg = new Intl.Segmenter('en', { granularity: 'word' });
                    for (const part of seg.segment(runText)) {
                        const s = part.segment;
                        const isWord = Boolean(part.isWordLike && /[A-Za-z]/.test(s));
                        out.push({
                            segment: s,
                            isWordLike: isWord,
                            lang: 'en',
                            index: runStart + part.index,
                            end: runStart + part.index + s.length
                        });
                    }
                } else {
                    out.push({
                        segment: runText,
                        isWordLike: true,
                        lang: 'en',
                        index: runStart,
                        end: runStart + runText.length
                    });
                }
            } else if (match[2]) {
                // CJK / 日文假名漢字區塊
                const runLang = (langHint === 'ja' || hasKanaInWhole || /[\u3040-\u309F\u30A0-\u30FF々]/.test(runText))
                    ? 'ja'
                    : 'zh-TW';
                if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
                    const seg = new Intl.Segmenter(runLang, { granularity: 'word' });
                    for (const part of seg.segment(runText)) {
                        const s = part.segment;
                        const isWord = Boolean(part.isWordLike && isWordCharForLang(s, runLang));
                        out.push({
                            segment: s,
                            isWordLike: isWord,
                            lang: runLang,
                            index: runStart + part.index,
                            end: runStart + part.index + s.length
                        });
                    }
                } else {
                    // Fallback：逐詞切分
                    const fallbackRegex = runLang === 'ja'
                        ? /[\u4E00-\u9FFF々]+[\u3040-\u309F]*|[\u30A0-\u30FFー]+|[\u3040-\u309F]+/g
                        : /[\u4E00-\u9FFF\u3400-\u4DBF]{1,4}/g;
                    let subMatch;
                    let subLast = 0;
                    while ((subMatch = fallbackRegex.exec(runText)) !== null) {
                        if (subMatch.index > subLast) {
                            out.push({
                                segment: runText.slice(subLast, subMatch.index),
                                isWordLike: false,
                                lang: runLang,
                                index: runStart + subLast,
                                end: runStart + subMatch.index
                            });
                        }
                        out.push({
                            segment: subMatch[0],
                            isWordLike: true,
                            lang: runLang,
                            index: runStart + subMatch.index,
                            end: runStart + subMatch.index + subMatch[0].length
                        });
                        subLast = fallbackRegex.lastIndex;
                    }
                    if (subLast < runText.length) {
                        out.push({
                            segment: runText.slice(subLast),
                            isWordLike: false,
                            lang: runLang,
                            index: runStart + subLast,
                            end: runStart + runText.length
                        });
                    }
                }
            } else {
                // 空白或標點符號
                out.push({
                    segment: runText,
                    isWordLike: false,
                    lang: '',
                    index: runStart,
                    end: runStart + runText.length
                });
            }
        }
        return out;
    }

    function renderClickableTokensHtml(text, langHint = '') {
        const segments = segmentTrilingualText(text, langHint);
        if (!segments.length) return escapeHtml(text || '');
        return segments.map(seg => {
            if (!seg.isWordLike) return escapeHtml(seg.segment);
            return `<span class="ft-clickable-word" data-ft-word="${escapeHtml(seg.segment)}" data-ft-lang="${escapeHtml(seg.lang)}" role="button" tabindex="0">${escapeHtml(seg.segment)}</span>`;
        }).join('');
    }

    function normalizeWordKey(word, lang) {
        const cleaned = String(word || '').trim().replace(/^[\s"'“”‘’()\[\]{}.,!?;:、。！？「」『』【】]+|[\s"'“”‘’()\[\]{}.,!?;:、。！？「」『』【】]+$/g, '');
        if (!cleaned) return '';
        if (lang === 'en') return cleaned.toLowerCase();
        return cleaned;
    }

    function isCardLangMatch(card, targetLang) {
        if (!card) return false;
        if (typeof global.isCardMatchingTargetLang === 'function' && (targetLang === 'en' || targetLang === 'ja')) {
            return global.isCardMatchingTargetLang(card, targetLang);
        }
        if (card.lang) return card.lang === targetLang;
        return detectScriptLang(card.word) === targetLang;
    }

    /* ==========================================================================
       1. 三層快取 + 三語字典查詢 (wordList -> LocalIDB -> sessionStorage -> AI -> GTX)
       ========================================================================== */

    async function loadIdbDict() {
        if (idbLoaded) return idbDictCache;
        if (idbLoadPromise) return idbLoadPromise;
        idbLoadPromise = (async () => {
            try {
                if (typeof LocalIDB !== 'undefined' && typeof LocalIDB.get === 'function') {
                    const data = await LocalIDB.get(IDB_DICT_KEY);
                    if (data && typeof data === 'object') {
                        idbDictCache = data;
                        idbLoaded = true;
                        return idbDictCache;
                    }
                }
            } catch (e) {}
            idbDictCache = {};
            idbLoaded = true;
            return idbDictCache;
        })();
        return idbLoadPromise;
    }

    async function saveIdbDictEntry(cacheKey, entry) {
        try {
            const dict = await loadIdbDict();
            dict[cacheKey] = {
                word: entry.word,
                lang: entry.lang,
                nativeLang: entry.nativeLang,
                phonetic: entry.phonetic || '',
                pos: entry.pos || '',
                meaning: entry.meaning || '',
                sentence: entry.sentence || '',
                translation: entry.translation || '',
                updatedAt: Date.now()
            };
            const keys = Object.keys(dict);
            if (keys.length > 2500) {
                keys.sort((a, b) => (dict[a].updatedAt || 0) - (dict[b].updatedAt || 0));
                keys.slice(0, keys.length - 2200).forEach(k => delete dict[k]);
            }
            if (typeof LocalIDB !== 'undefined' && typeof LocalIDB.set === 'function') {
                await LocalIDB.set(IDB_DICT_KEY, dict);
            }
        } catch (e) {}
    }

    function readSessionEntry(cacheKey) {
        try {
            const raw = sessionStorage.getItem(SESSION_DICT_KEY);
            if (!raw) return null;
            const map = JSON.parse(raw);
            return (map && typeof map === 'object' && map[cacheKey]) ? map[cacheKey] : null;
        } catch (e) {
            return null;
        }
    }

    function writeSessionEntry(cacheKey, entry) {
        try {
            const raw = sessionStorage.getItem(SESSION_DICT_KEY);
            const map = raw ? JSON.parse(raw) : {};
            map[cacheKey] = entry;
            const keys = Object.keys(map);
            if (keys.length > 300) {
                delete map[keys[0]];
            }
            sessionStorage.setItem(SESSION_DICT_KEY, JSON.stringify(map));
        } catch (e) {}
    }

    function lookupWordInLocalWordList(word, lang) {
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList))
            ? wordList
            : (Array.isArray(global.wordList) ? global.wordList : []);
        if (!list.length) return null;

        const key = normalizeWordKey(word, lang);
        if (!key) return null;

        const matched = list.find(c => {
            if (!c || !c.word) return false;
            const cLang = c.lang || detectScriptLang(c.word);
            if (lang && cLang !== lang) return false;
            return normalizeWordKey(c.word, cLang) === key;
        });
        if (!matched || !matched.meaning) return null;

        return {
            word: matched.word,
            lang: matched.lang || detectScriptLang(matched.word),
            nativeLang: targetNativeLang,
            phonetic: matched.phonetic || '',
            pos: matched.pos || '',
            meaning: matched.meaning || '',
            sentence: matched.sentence || '',
            translation: matched.translation || '',
            source: 'wordList',
            inDeck: true
        };
    }

    async function fetchGoogleTranslateFallback(text, sourceLang, nativeCode) {
        const tlMap = { 'zh-TW': 'zh-TW', 'en': 'en', 'ja': 'ja' };
        const slMap = { 'en': 'en', 'ja': 'ja', 'zh-TW': 'zh-TW' };
        const tl = tlMap[nativeCode] || 'zh-TW';
        const sl = slMap[sourceLang] || 'auto';
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`GTX HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
        return data[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
    }

    async function lookupTrilingualWord(rawWord, langHint = '', contextSentence = '') {
        const detectedLang = detectScriptLang(rawWord, langHint);
        const cleanWord = String(rawWord || '').trim();
        const keyNorm = normalizeWordKey(cleanWord, detectedLang);
        if (!keyNorm) return null;

        const nativeCfg = getNativeLangConfig(targetNativeLang);
        const cacheKey = `${detectedLang}::${nativeCfg.code}::${keyNorm}`;

        // Layer 1: 本機字庫 (僅當設定的母語為繁中，因為現有字庫多以繁中為釋義；其他母語若相同也可命中，否則向 AI 查該母語釋義)
        if (nativeCfg.code === 'zh-TW') {
            const localHit = lookupWordInLocalWordList(cleanWord, detectedLang);
            if (localHit) return localHit;
        }

        // Layer 2: LocalIDB
        const idbDict = await loadIdbDict();
        if (idbDict && idbDict[cacheKey] && idbDict[cacheKey].meaning) {
            return { ...idbDict[cacheKey], source: 'idb', inDeck: Boolean(lookupWordInLocalWordList(cleanWord, detectedLang)) };
        }

        // Layer 3: sessionStorage
        const sessHit = readSessionEntry(cacheKey);
        if (sessHit && sessHit.meaning) {
            return { ...sessHit, source: 'session', inDeck: Boolean(lookupWordInLocalWordList(cleanWord, detectedLang)) };
        }

        // 併發請求去重
        if (inFlightLookupMap.has(cacheKey)) {
            return inFlightLookupMap.get(cacheKey);
        }

        const reqPromise = (async () => {
            const sourceName = (TARGET_LANG_LABELS[detectedLang] && TARGET_LANG_LABELS[detectedLang].name) || 'English';
            const phoneticRule = detectedLang === 'ja'
                ? 'phonetic 欄位「必須」填寫純平假名讀音（例如：たべる、がっこう），不可填羅馬拼音。'
                : (detectedLang === 'en'
                    ? 'phonetic 欄位填寫 IPA 音標（例如：/əˈbʌndənt/）。'
                    : 'phonetic 欄位填寫漢語拼音或注音（簡短即可）。');
            const ctxLine = contextSentence ? `\n上下文參考：「${contextSentence.slice(0, 180)}」` : '';

            const prompt = `請查詢以下 ${sourceName} 詞彙，並以「${nativeCfg.aiName}」提供簡潔精準的釋義。
詞彙：「${cleanWord}」${ctxLine}

規則：
1. ${phoneticRule}
2. meaning 必須使用「${nativeCfg.aiName}」提供最常用的 1~3 個簡潔詞義（以頓號或分號分隔）。
3. pos 填寫詞性縮寫（如 n., v., adj., 名詞, 動詞 等）。
4. sentence 提供 1 句簡短實用的「${sourceName}」例句，translation 為該例句的「${nativeCfg.aiName}」翻譯。
5. 只輸出單一純 JSON 物件，不要加 Markdown 或多餘解釋：
{"word":"${cleanWord.replace(/"/g, '\\"')}","lang":"${detectedLang}","phonetic":"","pos":"","meaning":"","sentence":"","translation":""}`;

            let result = null;
            const canUseCloudDef = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
                ? global.MembershipEngine.canConsumeAiQuota('def_fill').allowed
                : true;
            if (canUseCloudDef && typeof global.callGeminiApi === 'function') {
                try {
                    const raw = await global.callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
                    const parsed = (typeof global.safeParseJSON === 'function')
                        ? global.safeParseJSON(raw)
                        : JSON.parse(raw);
                    if (parsed && parsed.meaning) {
                        result = {
                            word: String(parsed.word || cleanWord).trim(),
                            lang: detectedLang,
                            nativeLang: nativeCfg.code,
                            phonetic: String(parsed.phonetic || '').trim(),
                            pos: String(parsed.pos || '').trim(),
                            meaning: String(parsed.meaning || '').trim(),
                            sentence: String(parsed.sentence || '').trim(),
                            translation: String(parsed.translation || '').trim(),
                            source: 'ai'
                        };
                    }
                } catch (e) {
                    console.warn('[FloatingTranslator] AI 查詞失敗，啟用免金鑰備援:', e);
                }
            }

            if (!result) {
                try {
                    const gtxText = await fetchGoogleTranslateFallback(cleanWord, detectedLang, nativeCfg.code);
                    if (gtxText) {
                        result = {
                            word: cleanWord,
                            lang: detectedLang,
                            nativeLang: nativeCfg.code,
                            phonetic: '',
                            pos: '',
                            meaning: gtxText,
                            sentence: '',
                            translation: '',
                            source: 'gtx'
                        };
                    }
                } catch (e) {}
            }

            if (result && result.meaning) {
                writeSessionEntry(cacheKey, result);
                await saveIdbDictEntry(cacheKey, result);
                result.inDeck = Boolean(lookupWordInLocalWordList(result.word, detectedLang));
                return result;
            }

            return {
                word: cleanWord,
                lang: detectedLang,
                nativeLang: nativeCfg.code,
                phonetic: '',
                pos: '',
                meaning: '暫時無法取得釋義（請檢查網路或 API 設定）',
                sentence: '',
                translation: '',
                source: 'error',
                inDeck: false
            };
        })();

        inFlightLookupMap.set(cacheKey, reqPromise);
        try {
            return await reqPromise;
        } finally {
            inFlightLookupMap.delete(cacheKey);
        }
    }

    function speakTextByLang(text, langCode) {
        const clean = String(text || '').trim();
        if (!clean) return false;
        const resolvedLang = langCode === 'ja'
            ? 'ja-JP'
            : (langCode === 'zh-TW' || langCode === 'zh' ? 'zh-TW' : 'en-US');

        if (global.LZHAudioTts && typeof global.LZHAudioTts.speak === 'function') {
            global.LZHAudioTts.speak(clean, resolvedLang);
            return true;
        }

        const capTTS = global.Capacitor?.Plugins?.TextToSpeech;
        if (typeof global.isNativeApp === 'function' && global.isNativeApp() && capTTS && typeof capTTS.speak === 'function') {
            capTTS.speak({
                text: clean,
                lang: resolvedLang,
                rate: 1.0,
                pitch: 1.0,
                volume: 1.0,
                category: 'ambient'
            }).catch(() => {});
            return true;
        }

        if ('speechSynthesis' in global) {
            try {
                global.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(clean);
                u.lang = resolvedLang;
                global.speechSynthesis.speak(u);
                return true;
            } catch (e) {}
        }
        return false;
    }

    /* ==========================================================================
       2. 字卡寫入與雲端/本地同步橋接（對齊 js/app.js 與 js/storage.js）
       ========================================================================== */

    function getDeckCategoriesList() {
        if (typeof global.getAllCategories === 'function') {
            const list = global.getAllCategories();
            if (Array.isArray(list) && list.length > 0) return list;
        }
        const set = new Set(['未分類字庫']);
        const wl = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        wl.forEach(c => {
            if (c && c.category) set.add(c.category);
        });
        return Array.from(set);
    }

    function getPreferredTargetDeckName() {
        const sel = q('ftDeckSelect') || q('ftSelBarDeckSelect');
        if (sel && sel.value === '__NEW__') {
            const inp = q('ftNewDeckInput') || q('ftSelBarNewDeckInput');
            const custom = inp ? inp.value.trim() : '';
            if (custom) return custom;
        }
        if (sel && sel.value && sel.value !== '__NEW__') return sel.value;

        const activeCats = (typeof selectedCategories !== 'undefined') ? selectedCategories : global.selectedCategories;
        if (Array.isArray(activeCats)) {
            const picked = activeCats.find(c => c && c !== 'ALL');
            if (picked) return picked;
        } else if (activeCats instanceof Set && activeCats.size > 0) {
            const picked = Array.from(activeCats).find(c => c && c !== 'ALL');
            if (picked) return picked;
        }
        const cats = getDeckCategoriesList();
        return cats[0] || '我的單字本';
    }

    function buildFlashcardObject(data, categoryName) {
        const word = String(data.word || '').trim();
        const resolvedCat = String(categoryName || '').trim() || '我的單字本';
        const lang = data.lang || detectScriptLang(word);
        const now = Date.now();
        const diffInfo = (lang === 'en' && typeof global.getWordDifficultyInfo === 'function')
            ? global.getWordDifficultyInfo(word)
            : { level: 0 };
        const detCardId = (typeof global.generateDeterministicCardId === 'function')
            ? global.generateDeterministicCardId(resolvedCat, word)
            : ((typeof global.generateId === 'function') ? global.generateId() : ('card_' + now + '_' + Math.random().toString(36).slice(2, 8)));
        const detDeckId = (typeof global.generateDeterministicDeckId === 'function')
            ? global.generateDeterministicDeckId(resolvedCat)
            : undefined;

        return {
            id: detCardId,
            deckId: detDeckId,
            category: resolvedCat,
            word,
            lang,
            pos: String(data.pos || '').trim(),
            phonetic: String(data.phonetic || '').trim(),
            meaning: String(data.meaning || '（待補充釋義）').trim(),
            sentence: String(data.sentence || '').trim(),
            translation: String(data.translation || '').trim(),
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
            diffLevel: Number(diffInfo && diffInfo.level) || 0,
            diffLevelManual: false,
            updatedAt: now
        };
    }

    function upsertCardsIntoWordList(cardPayloads, targetDeckName) {
        if (typeof wordList === 'undefined' || !Array.isArray(wordList)) {
            if (!Array.isArray(global.wordList)) global.wordList = [];
        }
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : global.wordList;
        const deck = String(targetDeckName || '').trim() || '我的單字本';
        const deckLower = deck.toLowerCase();

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        cardPayloads.forEach(item => {
            const word = String(item.word || '').trim();
            if (!word) return;
            const lang = item.lang || detectScriptLang(word);
            const key = normalizeWordKey(word, lang);

            const existingInDeck = list.find(c =>
                c && String(c.category || '').trim().toLowerCase() === deckLower &&
                (c.lang || detectScriptLang(c.word)) === lang &&
                normalizeWordKey(c.word, lang) === key
            );

            if (existingInDeck) {
                let changed = false;
                ['pos', 'phonetic', 'meaning', 'sentence', 'translation'].forEach(f => {
                    if (!existingInDeck[f] && item[f]) {
                        existingInDeck[f] = String(item[f]).trim();
                        changed = true;
                    }
                });
                if (!existingInDeck.lang) {
                    existingInDeck.lang = lang;
                    changed = true;
                }
                if (changed) {
                    existingInDeck.updatedAt = Date.now();
                    updatedCount++;
                } else {
                    skippedCount++;
                }
                return;
            }

            const newCard = buildFlashcardObject({ ...item, lang }, deck);
            list.unshift(newCard);
            addedCount++;
        });

        if (addedCount > 0 || updatedCount > 0) {
            const activeCats = global.selectedCategories;
            if (Array.isArray(activeCats)) {
                if (!activeCats.includes('ALL') && !activeCats.includes(deck)) {
                    activeCats.push(deck);
                    if (typeof global.saveSelectedCategoriesToCloud === 'function') {
                        global.saveSelectedCategoriesToCloud(activeCats);
                    }
                }
            } else if (activeCats instanceof Set) {
                activeCats.add(deck);
            }
            if (typeof global.saveStorage === 'function') {
                global.saveStorage(true);
            }
            if (typeof global.updateCategorySelects === 'function') {
                global.updateCategorySelects();
            }
            if (typeof global.updateUI === 'function') {
                global.updateUI();
            }
        }

        return { addedCount, updatedCount, skippedCount, deck };
    }

    async function quickAddSingleWordToDeck(wordData) {
        if (!wordData || !wordData.word) return;
        const deck = getPreferredTargetDeckName();
        let payload = { ...wordData };

        // 若缺少例句或詞性，快速在前景/背景補齊
        if ((!payload.sentence || !payload.meaning || payload.source === 'gtx') && typeof global.callGeminiApi === 'function') {
            try {
                const enriched = await batchEnrichWordsWithAi([{ word: payload.word, lang: payload.lang || detectScriptLang(payload.word) }]);
                if (enriched.length > 0) {
                    payload = { ...payload, ...enriched[0] };
                }
            } catch (e) {}
        }

        const res = upsertCardsIntoWordList([payload], deck);
        if (res.addedCount > 0) {
            toast(`已收錄「${payload.word}」至【${res.deck}】`, 'success');
        } else if (res.updatedCount > 0) {
            toast(`已更新【${res.deck}】中的「${payload.word}」`, 'success');
        } else {
            toast(`「${payload.word}」已存在於【${res.deck}】`, 'info');
        }
        return res;
    }

    /**
     * AI 批次生成完整字卡欄位（支援 EN / JA / ZH 混排清單）
     */
    async function batchEnrichWordsWithAi(items) {
        if (!Array.isArray(items) || items.length === 0) return [];
        const nativeCfg = getNativeLangConfig(targetNativeLang);

        // 去重
        const uniqueMap = new Map();
        items.forEach(it => {
            const w = String(it.word || it.text || '').trim();
            if (!w) return;
            const lang = it.lang || detectScriptLang(w);
            const k = `${lang}::${normalizeWordKey(w, lang)}`;
            if (!uniqueMap.has(k)) {
                uniqueMap.set(k, {
                    word: w,
                    lang,
                    pos: it.pos || '',
                    phonetic: it.phonetic || it.reading || '',
                    meaning: it.meaning || it.translation || '',
                    sentence: it.sentence || '',
                    translation: it.translationSentence || ''
                });
            }
        });
        const uniqueList = Array.from(uniqueMap.values());
        if (uniqueList.length === 0) return [];

        if (typeof global.callGeminiApi !== 'function') {
            return uniqueList;
        }

        const batchChunks = [];
        for (let i = 0; i < uniqueList.length; i += 20) {
            batchChunks.push(uniqueList.slice(i, i + 20));
        }

        const results = [];
        for (const chunk of batchChunks) {
            const listJson = JSON.stringify(chunk.map(c => ({ word: c.word, lang: c.lang })));
            const prompt = `你是一位專業多語單字編輯器。請為以下單字陣列補齊完整學習字卡資料。
母語釋義與例句翻譯語言：「${nativeCfg.aiName}」。
輸入單字列表：${listJson}

嚴格規則：
1. 若 lang 為 "en"，phonetic 填寫 IPA 音標（如 /ɪɡˈzæmpəl/），sentence 寫自然英文例句。
2. 若 lang 為 "ja"，phonetic 必須填寫純平假名讀音（如 たべる、がっこう），不可填羅馬拼音；sentence 寫自然日文例句。
3. 若 lang 為 "zh-TW"，phonetic 填寫拼音或注音，sentence 寫自然中文例句。
4. meaning 為簡潔準確的「${nativeCfg.aiName}」釋義；pos 為詞性縮寫；translation 為例句的「${nativeCfg.aiName}」翻譯。
5. 只輸出純 JSON 陣列（禁止 Markdown 包裝）：
[{"word":"","lang":"en|ja|zh-TW","pos":"","phonetic":"","meaning":"","sentence":"","translation":""}]`;

            try {
                const raw = await global.callGeminiApi(prompt, { silent: false, feature: 'def_fill' });
                const parsed = (typeof global.safeParseJSON === 'function')
                    ? global.safeParseJSON(raw)
                    : JSON.parse(raw);

                if (Array.isArray(parsed) && parsed.length > 0) {
                    const parsedByKey = new Map();
                    parsed.forEach(p => {
                        if (!p || !p.word) return;
                        const pLang = p.lang || detectScriptLang(p.word);
                        parsedByKey.set(`${pLang}::${normalizeWordKey(p.word, pLang)}`, p);
                        parsedByKey.set(normalizeWordKey(p.word, pLang), p);
                    });

                    chunk.forEach(orig => {
                        const k1 = `${orig.lang}::${normalizeWordKey(orig.word, orig.lang)}`;
                        const k2 = normalizeWordKey(orig.word, orig.lang);
                        const hit = parsedByKey.get(k1) || parsedByKey.get(k2);
                        if (hit) {
                            results.push({
                                word: String(hit.word || orig.word).trim(),
                                lang: hit.lang || orig.lang,
                                pos: String(hit.pos || orig.pos || '').trim(),
                                phonetic: String(hit.phonetic || orig.phonetic || '').trim(),
                                meaning: String(hit.meaning || orig.meaning || '').trim(),
                                sentence: String(hit.sentence || orig.sentence || '').trim(),
                                translation: String(hit.translation || orig.translation || '').trim()
                            });
                        } else {
                            results.push(orig);
                        }
                    });
                } else {
                    results.push(...chunk);
                }
            } catch (err) {
                console.warn('[FloatingTranslator] AI 批次建卡部分降級:', err);
                // 逐一使用已有譯義或 GTX 補救
                for (const orig of chunk) {
                    if (!orig.meaning) {
                        try {
                            orig.meaning = await fetchGoogleTranslateFallback(orig.word, orig.lang, nativeCfg.code);
                        } catch (e) {}
                    }
                    results.push(orig);
                }
            }
        }
        return results;
    }

    /* ==========================================================================
       3. 模組一：App 全域點詞翻譯 & 劃記多選入庫 + 嚴防考試模式衝突
       ========================================================================== */

    /**
     * 最高優先權防呆守衛：判斷是否處於考試模式、既有雙語題庫或不可攔截的 UI 區域
     */
    function isExamModeOrProtectedTarget(target) {
        if (!target || typeof target.closest !== 'function') return true;

        // 1. 若測驗區塊正在顯示，絕對不可觸發全域點詞或劃記
        const secQuiz = document.getElementById('sec-quiz');
        if (secQuiz && !secQuiz.classList.contains('hidden') && secQuiz.offsetParent !== null) {
            return true;
        }

        // 2. 明確檢查考試模式、對戰、既有閱讀彈窗與浮窗本身之 DOM 容器與選擇器
        const protectedSelectors = [
            '#sec-quiz',
            '#quizContainer',
            '#quizPromptBox',
            '#quizSpellingForm',
            '#quizFeedback',
            '#quizReaderDemoCard',
            '#quizTranslationContainer',
            '#quizReadingContainer',
            '#quizClozeContainer',
            '#qtChineseSentenceBox',
            '#gameArenaModal',
            '#multiplayerModal',
            '.cn-phrase-token',
            '.reader-token',
            '#readerTranslatePopover',
            '#ftTapBubble',
            '#floatingTranslatorRoot',
            '#ftSelectionFloatingBar',
            '#welcomeModal',
            '#onboardingTourOverlay',
            '#helpManualModal',
            '#cardModal',
            '#batchModal',
            '#backupModal',
            '#cardEditModal',
            '#deckShareModal',
            '#playerProfileModal',
            '#deleteAccountModal',
            '#lzhConfirmModal',
            '.lzh-confirm-modal',
            '#membershipModal'
        ].join(', ');

        if (target.closest(protectedSelectors)) return true;

        // 3. 保護表單與原生按鈕，避免干擾點擊操作
        if (target.closest('button, a, input, select, textarea, label, [role="button"]')) {
            // 例外：即時字幕條或螢幕點詞預覽區的 .ft-clickable-word 可以點詞查詢
            if (!target.classList.contains('ft-clickable-word') && !target.closest('.ft-clickable-word')) {
                return true;
            }
        }

        // 4. 保護主字卡翻面 (#flashcard onclick="flipCard()")：
        // 點擊 #cardWord 或空白處時應維持翻面，僅在點擊 #cardFrontSentence / #cardSentence（且非按鈕）時允許點詞或劃記
        const flashcardEl = target.closest('#flashcard');
        if (flashcardEl) {
            const insideSentence = Boolean(target.closest('#cardFrontSentence, #cardSentence'));
            if (!insideSentence) return true;
        }

        return false;
    }

    /**
     * 使用 caretPositionFromPoint / caretRangeFromPoint 從點擊座標精確取出所屬分詞，並驗證碰撞距離
     */
    function extractWordAtPoint(clientX, clientY) {
        let textNode = null;
        let offset = 0;

        if (typeof document.caretPositionFromPoint === 'function') {
            const pos = document.caretPositionFromPoint(clientX, clientY);
            if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
                textNode = pos.offsetNode;
                offset = pos.offset;
            }
        } else if (typeof document.caretRangeFromPoint === 'function') {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
                textNode = range.startContainer;
                offset = range.startOffset;
            }
        }

        if (!textNode || !textNode.nodeValue || !textNode.nodeValue.trim()) return null;
        const parentEl = textNode.parentElement;
        if (!parentEl || isExamModeOrProtectedTarget(parentEl)) return null;

        const fullText = textNode.nodeValue;
        const segments = segmentTrilingualText(fullText);
        if (!segments.length) return null;

        // 尋找命中或最鄰近游標偏移的 word segment
        let targetSeg = segments.find(s => s.isWordLike && offset >= s.index && offset <= s.end);
        if (!targetSeg) {
            targetSeg = segments.find(s => s.isWordLike && offset >= s.index - 1 && offset <= s.end + 1);
        }
        if (!targetSeg) return null;

        // 驗證實際視覺 BoundingRect 是否真的在點擊座標附近（避免點到遠方空白卻吸附文字）
        const tokenRange = document.createRange();
        tokenRange.setStart(textNode, targetSeg.index);
        tokenRange.setEnd(textNode, targetSeg.end);
        const rects = Array.from(tokenRange.getClientRects());
        if (!rects.length) return null;

        const hit = rects.some(r =>
            clientX >= r.left - 12 &&
            clientX <= r.right + 12 &&
            clientY >= r.top - 10 &&
            clientY <= r.bottom + 10
        );
        if (!hit) return null;

        return {
            textNode,
            segment: targetSeg.segment,
            lang: targetSeg.lang || detectScriptLang(targetSeg.segment),
            start: targetSeg.index,
            end: targetSeg.end,
            range: tokenRange,
            rect: rects[0],
            contextSentence: fullText.trim().slice(0, 200)
        };
    }

    function unwrapSingleMark(markEl) {
        if (!markEl || !markEl.parentNode) return;
        const parent = markEl.parentNode;
        while (markEl.firstChild) {
            parent.insertBefore(markEl.firstChild, markEl);
        }
        parent.removeChild(markEl);
        parent.normalize();
    }

    function toggleMarkOnPageWord(hitInfo) {
        const word = hitInfo.segment;
        const lang = hitInfo.lang;
        const key = `${lang}::${normalizeWordKey(word, lang)}`;
        if (!normalizeWordKey(word, lang)) return;

        // 若目標已被包覆在 <mark class="ft-selected-word-mark"> 內，則取消標記
        const parentMark = hitInfo.textNode.parentElement && hitInfo.textNode.parentElement.closest('.ft-selected-word-mark');
        if (parentMark) {
            const markKey = parentMark.getAttribute('data-ft-sel-key');
            unwrapSingleMark(parentMark);
            if (markKey && pageSelectedWordsMap.has(markKey)) {
                const entry = pageSelectedWordsMap.get(markKey);
                entry.marks.delete(parentMark);
                if (entry.marks.size === 0) pageSelectedWordsMap.delete(markKey);
            }
            renderPageSelectionBar();
            return;
        }

        try {
            const mark = document.createElement('mark');
            mark.className = 'ft-selected-word-mark';
            mark.setAttribute('data-ft-sel-key', key);
            mark.setAttribute('data-ft-word', word);
            mark.setAttribute('data-ft-lang', lang);
            hitInfo.range.surroundContents(mark);

            if (!pageSelectedWordsMap.has(key)) {
                pageSelectedWordsMap.set(key, { word, lang, marks: new Set() });
            }
            pageSelectedWordsMap.get(key).marks.add(mark);
            renderPageSelectionBar();
        } catch (e) {
            // 若 Range 跨節點無法 surroundContents，直接記錄單字
            if (!pageSelectedWordsMap.has(key)) {
                pageSelectedWordsMap.set(key, { word, lang, marks: new Set() });
            } else {
                pageSelectedWordsMap.delete(key);
            }
            renderPageSelectionBar();
        }
    }

    function clearAllPageSelections() {
        document.querySelectorAll('.ft-selected-word-mark').forEach(mark => unwrapSingleMark(mark));
        pageSelectedWordsMap.clear();
        renderPageSelectionBar();
    }

    function ensureTapBubbleMounted() {
        if (tapBubbleEl && document.body.contains(tapBubbleEl)) return tapBubbleEl;
        const existing = document.getElementById('ftTapBubble');
        if (existing) {
            tapBubbleEl = existing;
            return tapBubbleEl;
        }

        const el = document.createElement('div');
        el.id = 'ftTapBubble';
        el.className = 'hidden fixed z-[75] w-72 max-w-[calc(100vw-24px)] rounded-2xl bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 shadow-2xl p-3 space-y-2';
        document.body.appendChild(el);
        tapBubbleEl = el;
        return el;
    }

    function hideTapBubble() {
        if (tapBubbleEl) tapBubbleEl.classList.add('hidden');
        activeBubbleWordData = null;
        document.querySelectorAll('.ft-photo-hotspot-active').forEach(el => el.classList.remove('ft-photo-hotspot-active'));
    }

    function positionBubbleNearRect(bubbleEl, anchorRect, preferAbove = false) {
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;
        const insets = getEffectiveSafeInsets();
        const minTop = Math.max(12, insets.top + 8);
        const bottomSafe = Math.max(12, insets.bottom + 8);
        const bw = Math.min(288, vw - 24);

        let left = vw / 2 - bw / 2;
        let top = Math.max(minTop, vh * 0.25);

        if (anchorRect) {
            const centerX = anchorRect.left + (anchorRect.width || 0) / 2;
            left = clamp(centerX - bw / 2, 12, Math.max(12, vw - bw - 12));
            const estimatedHeight = bubbleEl.offsetHeight || 156;
            if (preferAbove) {
                top = anchorRect.top - estimatedHeight - 10;
                if (top < minTop) top = anchorRect.bottom + 10;
            } else {
                top = anchorRect.bottom + 10;
                if (top + estimatedHeight > vh - bottomSafe) {
                    top = Math.max(minTop, anchorRect.top - estimatedHeight - 10);
                }
            }
            top = clamp(top, minTop, Math.max(minTop, vh - estimatedHeight - bottomSafe));
        }

        bubbleEl.style.width = `${bw}px`;
        bubbleEl.style.left = `${Math.round(left)}px`;
        bubbleEl.style.top = `${Math.round(top)}px`;
    }

    async function openLookupBubbleForWord(rawWord, langHint, anchorRect, contextSentence = '', options = {}) {
        const clean = String(rawWord || '').trim();
        if (!clean) return;
        const bubble = ensureTapBubbleMounted();
        const detectedLang = detectScriptLang(clean, langHint);
        const langMeta = TARGET_LANG_LABELS[detectedLang] || TARGET_LANG_LABELS['en'];
        const token = ++activeBubbleToken;

        const renderBubbleContent = (data, isLoading) => {
            const nativeCfg = getNativeLangConfig(targetNativeLang);
            const phoneticText = data && data.phonetic ? escapeHtml(data.phonetic) : '';
            const posText = data && data.pos ? escapeHtml(data.pos) : '';
            const meaningText = isLoading
                ? '正在查詢翻譯...'
                : escapeHtml((data && data.meaning) || '無可用釋義');

            bubble.innerHTML = `
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-sm font-black text-slate-900 dark:text-white break-all">${escapeHtml(clean)}</span>
                            <span class="px-1.5 py-0.5 rounded bg-brand-100 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 text-[10px] font-extrabold">${escapeHtml(langMeta.badge)}</span>
                            ${posText ? `<span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold">${posText}</span>` : ''}
                        </div>
                        ${phoneticText ? `<div class="text-xs font-semibold text-indigo-600 dark:text-indigo-400 mt-0.5">${phoneticText}</div>` : ''}
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <button type="button" data-ft-bubble-action="speak" class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-brand-100 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 flex items-center justify-center text-xs cursor-pointer" title="發音">
                            <i class="fa-solid fa-volume-high"></i>
                        </button>
                        <button type="button" data-ft-bubble-action="close" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center text-xs cursor-pointer" title="關閉">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div class="text-xs leading-relaxed font-semibold text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/70 rounded-xl px-2.5 py-2 border border-slate-100 dark:border-slate-700">
                    <span class="text-[10px] font-bold text-slate-400 mr-1">[${escapeHtml(nativeCfg.short)}]</span>${meaningText}
                </div>
                <div class="flex items-center justify-between gap-2 pt-0.5">
                    <button type="button" data-ft-bubble-action="add" ${isLoading ? 'disabled' : ''} class="flex-1 py-1.5 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-extrabold flex items-center justify-center gap-1 cursor-pointer shadow-xs">
                        <span>＋快速加入字庫</span>
                    </button>
                    ${options.onSelectPhotoToken ? `
                    <button type="button" data-ft-bubble-action="photo-select" class="py-1.5 px-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-xs font-bold inline-flex items-center gap-1 cursor-pointer">
                        ${FT_SVG.checkbox}<span>選取</span>
                    </button>` : ''}
                </div>
            `;

            const speakBtn = bubble.querySelector('[data-ft-bubble-action="speak"]');
            if (speakBtn) {
                speakBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    speakTextByLang(clean, detectedLang);
                };
            }
            const closeBtn = bubble.querySelector('[data-ft-bubble-action="close"]');
            if (closeBtn) {
                closeBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    hideTapBubble();
                };
            }
            const addBtn = bubble.querySelector('[data-ft-bubble-action="add"]');
            if (addBtn) {
                addBtn.onclick = async (ev) => {
                    ev.stopPropagation();
                    addBtn.disabled = true;
                    addBtn.textContent = '收錄中...';
                    await quickAddSingleWordToDeck(activeBubbleWordData || { word: clean, lang: detectedLang });
                    addBtn.innerHTML = `${FT_SVG.check}<span>已收錄</span>`;
                };
            }
            const photoSelBtn = bubble.querySelector('[data-ft-bubble-action="photo-select"]');
            if (photoSelBtn && typeof options.onSelectPhotoToken === 'function') {
                photoSelBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    options.onSelectPhotoToken();
                };
            }
        };

        bubble.classList.remove('hidden');
        renderBubbleContent(options.preloadedData || null, !options.preloadedData);
        positionBubbleNearRect(bubble, anchorRect, Boolean(options.preferAbove));

        if (options.preloadedData && options.preloadedData.meaning) {
            activeBubbleWordData = { ...options.preloadedData, word: clean, lang: detectedLang, _rect: anchorRect, contextSentence };
            return;
        }

        const result = await lookupTrilingualWord(clean, detectedLang, contextSentence);
        if (token !== activeBubbleToken) return;
        activeBubbleWordData = { ...result, _rect: anchorRect, contextSentence };
        renderBubbleContent(result, false);
        positionBubbleNearRect(bubble, anchorRect, Boolean(options.preferAbove));
    }

    function renderPageSelectionBar() {
        if (!selectionBarEl) {
            selectionBarEl = document.createElement('div');
            selectionBarEl.id = 'ftSelectionFloatingBar';
            selectionBarEl.className = 'hidden fixed z-[55] left-1/2 -translate-x-1/2 w-[min(94vw,520px)] bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl border border-emerald-300 dark:border-emerald-700 shadow-2xl p-3 space-y-2';
            selectionBarEl.style.bottom = 'calc(5rem + var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px)))';
            document.body.appendChild(selectionBarEl);
        }

        const count = pageSelectedWordsMap.size;
        if (!pageSelectMode && count === 0) {
            selectionBarEl.classList.add('hidden');
            return;
        }

        selectionBarEl.classList.remove('hidden');
        const entries = Array.from(pageSelectedWordsMap.entries());
        const cats = getDeckCategoriesList();
        const currentDeck = getPreferredTargetDeckName();

        selectionBarEl.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-extrabold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                    <span class="inline-flex items-center gap-1">${FT_SVG.checkbox}<span>頁面選取模式</span></span>
                    <span class="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-[11px]">${count} 詞</span>
                </span>
                <div class="flex items-center gap-1.5">
                    <button type="button" id="ftSelBarClearBtn" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-[11px] font-bold cursor-pointer">清空</button>
                    <button type="button" id="ftSelBarExitBtn" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-[11px] font-bold cursor-pointer">結束選取</button>
                </div>
            </div>
            <div class="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                ${entries.length === 0
                    ? '<span class="text-[11px] text-slate-400">請直接點擊頁面或例句中的單字進行反白勾選（再點一次可取消）</span>'
                    : entries.map(([key, item]) => `
                        <button type="button" data-ft-remove-sel="${escapeHtml(key)}" class="px-2 py-0.5 rounded-lg bg-amber-100 dark:bg-amber-900/50 text-amber-900 dark:text-amber-200 text-[11px] font-bold border border-amber-300 dark:border-amber-700 flex items-center gap-1 cursor-pointer">
                            <span>${escapeHtml(item.word)}</span>
                            <span class="opacity-60">×</span>
                        </button>
                    `).join('')
                }
            </div>
            <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-700">
                <select id="ftSelBarDeckSelect" class="flex-1 min-w-[140px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none">
                    ${cats.map(c => `<option value="${escapeHtml(c)}" ${c === currentDeck ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                    <option value="__NEW__">＋ 新增字庫...</option>
                </select>
                <input type="text" id="ftSelBarNewDeckInput" placeholder="輸入新字庫名稱" class="hidden flex-1 min-w-[120px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-emerald-400 text-xs font-bold outline-none">
                <button type="button" id="ftSelBarConfirmBtn" ${count === 0 ? 'disabled' : ''} class="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-extrabold cursor-pointer">
                    確認收錄 (${count})
                </button>
            </div>
        `;

        const deckSel = selectionBarEl.querySelector('#ftSelBarDeckSelect');
        const newInp = selectionBarEl.querySelector('#ftSelBarNewDeckInput');
        if (deckSel && newInp) {
            deckSel.onchange = () => {
                newInp.classList.toggle('hidden', deckSel.value !== '__NEW__');
                if (deckSel.value === '__NEW__') newInp.focus();
            };
        }

        selectionBarEl.querySelectorAll('[data-ft-remove-sel]').forEach(btn => {
            btn.onclick = () => {
                const k = btn.getAttribute('data-ft-remove-sel');
                document.querySelectorAll(`.ft-selected-word-mark[data-ft-sel-key="${CSS.escape(k)}"]`).forEach(m => unwrapSingleMark(m));
                pageSelectedWordsMap.delete(k);
                renderPageSelectionBar();
            };
        });

        const clearBtn = selectionBarEl.querySelector('#ftSelBarClearBtn');
        if (clearBtn) clearBtn.onclick = clearAllPageSelections;

        const exitBtn = selectionBarEl.querySelector('#ftSelBarExitBtn');
        if (exitBtn) exitBtn.onclick = () => setPageSelectionMode(false);

        const confirmBtn = selectionBarEl.querySelector('#ftSelBarConfirmBtn');
        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                if (pageSelectedWordsMap.size === 0) return;
                let deck = deckSel ? deckSel.value : getPreferredTargetDeckName();
                if (deck === '__NEW__') {
                    deck = (newInp && newInp.value.trim()) ? newInp.value.trim() : '劃記字庫';
                }
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'AI 解析建卡中...';
                try {
                    const items = Array.from(pageSelectedWordsMap.values()).map(v => ({ word: v.word, lang: v.lang }));
                    const enriched = await batchEnrichWordsWithAi(items);
                    const res = upsertCardsIntoWordList(enriched, deck);
                    clearAllPageSelections();
                    setPageSelectionMode(false);
                    toast(`已加入 ${res.addedCount} 張、更新 ${res.updatedCount} 張字卡至【${res.deck}】`, 'success');
                } finally {
                    confirmBtn.disabled = false;
                }
            };
        }
    }

    function setScreenTapEnabled(flag) {
        screenTapEnabled = Boolean(flag);
        try {
            localStorage.setItem(STORAGE_TAP_ENABLED_KEY, screenTapEnabled ? 'true' : 'false');
        } catch (e) {}
        const chk = q('ftScreenTapToggle');
        if (chk) chk.checked = screenTapEnabled;
    }

    function setPageSelectionMode(flag) {
        pageSelectMode = Boolean(flag);
        if (!pageSelectMode && pageSelectedWordsMap.size === 0) {
            renderPageSelectionBar();
        } else {
            renderPageSelectionBar();
        }
        const btn = q('ftPageSelectModeBtn');
        if (btn) {
            btn.className = pageSelectMode
                ? 'w-full py-2 px-3 rounded-xl bg-amber-500 text-white text-xs font-extrabold cursor-pointer flex items-center justify-center gap-1.5 shadow-xs'
                : 'w-full py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-bold cursor-pointer flex items-center justify-center gap-1.5';
            btn.innerHTML = pageSelectMode
                ? `${FT_SVG.checkbox}<span>頁面選取模式進行中（點頁面單字反白）</span>`
                : `${FT_SVG.checkbox}<span>開啟「頁面點詞選取」模式</span>`;
        }
    }

    function handleGlobalDocumentClick(e) {
        const target = e.target;
        if (!target) return;

        // 點擊氣泡外部則收起氣泡
        if (tapBubbleEl && !tapBubbleEl.classList.contains('hidden') && !target.closest('#ftTapBubble')) {
            if (!target.closest('.ft-photo-hotspot')) {
                hideTapBubble();
            }
        }

        // 點擊即時字幕 / 螢幕點詞預覽區上的 .ft-clickable-word 一定可點詞翻譯
        const clickableToken = target.closest('.ft-clickable-word');
        if (clickableToken) {
            const word = clickableToken.getAttribute('data-ft-word') || clickableToken.textContent || '';
            const lang = clickableToken.getAttribute('data-ft-lang') || detectScriptLang(word);
            if (word.trim()) {
                e.stopPropagation();
                openLookupBubbleForWord(word, lang, clickableToken.getBoundingClientRect(), clickableToken.parentElement ? clickableToken.parentElement.textContent : '');
            }
            return;
        }

        // 沒開啟「螢幕點詞翻譯」也沒開啟「頁面選取模式」，不介入全域頁面文字
        if (!screenTapEnabled && !pageSelectMode) return;

        // 最優先檢查：若處於考試模式或受保護區域，立刻退出
        if (isExamModeOrProtectedTarget(target)) return;

        // 若點擊的是已選取反白的 <mark>，直接切換取消
        const existingMark = target.closest('.ft-selected-word-mark');
        if (existingMark && pageSelectMode) {
            e.preventDefault();
            e.stopPropagation();
            const markKey = existingMark.getAttribute('data-ft-sel-key');
            unwrapSingleMark(existingMark);
            if (markKey && pageSelectedWordsMap.has(markKey)) {
                pageSelectedWordsMap.delete(markKey);
            }
            renderPageSelectionBar();
            return;
        }

        const hit = extractWordAtPoint(e.clientX, e.clientY);
        if (!hit) return;

        // 若位於字卡例句內部，阻止冒泡避免觸發翻面
        if (target.closest('#cardFrontSentence, #cardSentence')) {
            e.stopPropagation();
        }

        if (pageSelectMode) {
            e.preventDefault();
            toggleMarkOnPageWord(hit);
        } else if (screenTapEnabled) {
            openLookupBubbleForWord(hit.segment, hit.lang, hit.rect, hit.contextSentence);
        }
    }

    /* ==========================================================================
       4. 模組二：互動式「拍照翻譯」與多選單字 AI 建卡 (0~1000 熱區定位)
       ========================================================================== */

    function stopCameraStream() {
        if (cameraStream) {
            try {
                cameraStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) {}
                });
            } catch (e) {}
            cameraStream = null;
        }
        const video = q('ftCameraVideo');
        if (video) {
            try { video.pause(); } catch (e) {}
            video.srcObject = null;
        }
        const liveWrap = q('ftLiveCameraWrap');
        if (liveWrap) liveWrap.classList.add('hidden');
    }

    async function startLiveCamera() {
        // 若在 Capacitor 原生 App 優先嘗試原生 Camera 插件
        const capCam = global.Capacitor?.Plugins?.Camera;
        if (typeof global.isNativeApp === 'function' && global.isNativeApp() && capCam && typeof capCam.getPhoto === 'function') {
            try {
                const photo = await capCam.getPhoto({
                    quality: 85,
                    allowEditing: false,
                    resultType: 'dataUrl',
                    source: 'CAMERA'
                });
                if (photo && photo.dataUrl) {
                    await analyzePhotoDataUrl(photo.dataUrl, 'image/jpeg');
                    return true;
                }
            } catch (err) {
                console.warn('[FloatingTranslator] Capacitor Camera cancelled/fallback:', err);
            }
        }

        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            triggerPhotoFileInput(true);
            return false;
        }

        stopCameraStream();
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            const liveWrap = q('ftLiveCameraWrap');
            const video = q('ftCameraVideo');
            if (liveWrap) liveWrap.classList.remove('hidden');
            if (video) {
                video.srcObject = cameraStream;
                try { await video.play(); } catch (e) {}
            }
            return true;
        } catch (err) {
            console.warn('[FloatingTranslator] getUserMedia fallback to file input:', err);
            stopCameraStream();
            toast('無法開啟即時鏡頭，改為拍照／相簿選圖', 'info');
            triggerPhotoFileInput(true);
            return false;
        }
    }

    function syncImageModeLock(active) {
        isImageModeActive = Boolean(active);
        try {
            if (global.AndroidOverlay && typeof global.AndroidOverlay.setImageModeActive === 'function') {
                global.AndroidOverlay.setImageModeActive(isImageModeActive);
            } else if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.SystemOverlay && typeof global.Capacitor.Plugins.SystemOverlay.setImageModeActive === 'function') {
                global.Capacitor.Plugins.SystemOverlay.setImageModeActive({ active: isImageModeActive });
            }
        } catch (e) {}
        if (isOpen && panelHostEl && (!pipWindowRef || pipWindowRef.closed)) {
            applyPanelPosition();
        }
    }

    function triggerPhotoFileInput(useCameraCapture) {
        syncImageModeLock(true);
        const inp = q(useCameraCapture ? 'ftPhotoCameraInput' : 'ftPhotoGalleryInput');
        if (inp) {
            inp.value = '';
            inp.click();
        }
    }

    function compressImageElementToJpeg(source, srcWidth, srcHeight, maxDim = 1920, quality = 0.92) {
        const w = Number(srcWidth) || 0;
        const h = Number(srcHeight) || 0;
        if (!w || !h) throw new Error('無效影像尺寸');

        // 依賴現代瀏覽器與 WebView 原生 EXIF 自動旋轉，禁止手動重複旋轉畫布
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, targetW, targetH);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64 = dataUrl.split(',')[1] || '';
        return { dataUrl, base64, mimeType: 'image/jpeg', width: targetW, height: targetH };
    }

    async function captureLiveCameraFrame() {
        const video = q('ftCameraVideo');
        if (!video || !video.videoWidth || !video.videoHeight) {
            toast('相機畫面尚未就緒', 'warning');
            return;
        }
        const compressed = compressImageElementToJpeg(video, video.videoWidth, video.videoHeight, 1920, 0.92);
        stopCameraStream();
        await analyzeCompressedPhoto(compressed);
    }

    async function analyzePhotoDataUrl(dataUrl) {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('圖片載入失敗'));
            img.src = dataUrl;
        });
        const compressed = compressImageElementToJpeg(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1920, 0.92);
        await analyzeCompressedPhoto(compressed);
    }

    async function handlePhotoFile(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) return;
        const objUrl = URL.createObjectURL(file);
        try {
            await analyzePhotoDataUrl(objUrl);
        } catch (err) {
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    await analyzePhotoDataUrl(String(ev.target.result || ''));
                } catch (e2) {
                    toast('讀取圖片失敗', 'error');
                }
            };
            reader.readAsDataURL(file);
        } finally {
            try { URL.revokeObjectURL(objUrl); } catch (e) {}
        }
    }

    async function analyzeScreenFrameBase64(rawBase64) {
        if (!rawBase64) return;
        const dataUrl = rawBase64.startsWith('data:') ? rawBase64 : `data:image/jpeg;base64,${rawBase64}`;
        await analyzePhotoDataUrl(dataUrl);
    }

    function normalizeBox1000(rawBox) {
        if (!Array.isArray(rawBox) || rawBox.length < 4) return null;
        let ymin = Number(rawBox[0]);
        let xmin = Number(rawBox[1]);
        let ymax = Number(rawBox[2]);
        let xmax = Number(rawBox[3]);
        if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) return null;

        // 若 AI 回傳 0~1 小數，正規化到 0~1000
        if (ymax <= 1 && xmax <= 1 && ymin >= 0 && xmin >= 0) {
            ymin *= 1000;
            xmin *= 1000;
            ymax *= 1000;
            xmax *= 1000;
        }

        ymin = clamp(ymin, 0, 998);
        xmin = clamp(xmin, 0, 998);
        ymax = clamp(ymax, ymin + 8, 1000);
        xmax = clamp(xmax, xmin + 8, 1000);
        return [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
    }

    /**
     * 將正規化 0~1000 [ymin, xmin, ymax, xmax] 換算為百分比 CSS 樣式
     */
    function box1000ToPercentRect(box) {
        const norm = normalizeBox1000(box);
        if (!norm) return null;
        const [ymin, xmin, ymax, xmax] = norm;
        return {
            topPct: +(ymin / 10).toFixed(2),
            leftPct: +(xmin / 10).toFixed(2),
            heightPct: +((ymax - ymin) / 10).toFixed(2),
            widthPct: +((xmax - xmin) / 10).toFixed(2)
        };
    }

    function applyPhotoZoomTransform(stageBoxEl, zoomState, resetBtnEl = null) {
        if (!stageBoxEl || !zoomState) return;
        zoomState.scale = clamp(Number(zoomState.scale) || 1, 0.75, 2.5);
        if (Math.abs(zoomState.scale - 1) < 0.02) {
            zoomState.scale = 1;
            zoomState.tx = 0;
            zoomState.ty = 0;
        } else {
            const maxPan = Math.round(320 * zoomState.scale);
            zoomState.tx = clamp(Number(zoomState.tx) || 0, -maxPan, maxPan);
            zoomState.ty = clamp(Number(zoomState.ty) || 0, -maxPan, maxPan);
        }
        stageBoxEl.style.transform = `translate3d(${Math.round(zoomState.tx)}px, ${Math.round(zoomState.ty)}px, 0) scale(${zoomState.scale.toFixed(3)})`;
        if (resetBtnEl) {
            resetBtnEl.textContent = `${Math.round(zoomState.scale * 100)}%`;
        }
    }

    function bindPhotoZoomGestures(viewportEl, stageBoxEl, zoomState, resetBtnEl = null) {
        if (!viewportEl || !stageBoxEl) return;
        applyPhotoZoomTransform(stageBoxEl, zoomState, resetBtnEl);
        if (viewportEl.dataset.zoomBound === '1') return;
        viewportEl.dataset.zoomBound = '1';

        const pointers = new Map();
        let startPinchDist = 0;
        let startPinchScale = 1;
        let panPointerId = null;
        let panStartX = 0;
        let panStartY = 0;
        let panBaseTx = 0;
        let panBaseTy = 0;
        let movedDist = 0;

        const getPairDist = () => {
            const pts = Array.from(pointers.values());
            if (pts.length < 2) return 0;
            return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        };

        viewportEl.addEventListener('pointerdown', (e) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                startPinchDist = Math.max(10, getPairDist());
                startPinchScale = zoomState.scale;
                panPointerId = null;
                ftPhotoPinchGuardUntil = Date.now() + 260;
            } else if (pointers.size === 1 && zoomState.scale > 1.02) {
                panPointerId = e.pointerId;
                panStartX = e.clientX;
                panStartY = e.clientY;
                panBaseTx = zoomState.tx;
                panBaseTy = zoomState.ty;
                movedDist = 0;
            }
        });

        viewportEl.addEventListener('pointermove', (e) => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size >= 2 && startPinchDist > 0) {
                const dist = getPairDist();
                if (dist > 0) {
                    zoomState.scale = clamp(startPinchScale * (dist / startPinchDist), 0.75, 2.5);
                    applyPhotoZoomTransform(stageBoxEl, zoomState, resetBtnEl);
                    ftPhotoPinchGuardUntil = Date.now() + 260;
                }
            } else if (pointers.size === 1 && panPointerId === e.pointerId && zoomState.scale > 1.02) {
                const dx = e.clientX - panStartX;
                const dy = e.clientY - panStartY;
                movedDist = Math.max(movedDist, Math.hypot(dx, dy));
                if (movedDist > 5) {
                    zoomState.tx = panBaseTx + dx;
                    zoomState.ty = panBaseTy + dy;
                    applyPhotoZoomTransform(stageBoxEl, zoomState, resetBtnEl);
                    ftPhotoPinchGuardUntil = Date.now() + 220;
                }
            }
        });

        const releasePointer = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) startPinchDist = 0;
            if (panPointerId === e.pointerId) panPointerId = null;
        };
        viewportEl.addEventListener('pointerup', releasePointer);
        viewportEl.addEventListener('pointercancel', releasePointer);

        viewportEl.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && Math.abs(e.deltaY) < 4) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            zoomState.scale = clamp(zoomState.scale * factor, 0.75, 2.5);
            applyPhotoZoomTransform(stageBoxEl, zoomState, resetBtnEl);
        }, { passive: false });
    }

    function ensurePhotoFullscreenModal() {
        if (photoFullscreenEl && document.body.contains(photoFullscreenEl)) return photoFullscreenEl;
        const existing = document.getElementById('ftPhotoFullscreenModal');
        if (existing) {
            photoFullscreenEl = existing;
            return photoFullscreenEl;
        }
        const modal = document.createElement('div');
        modal.id = 'ftPhotoFullscreenModal';
        modal.className = 'hidden fixed inset-0 z-[72] bg-slate-950/95 text-white flex flex-col select-none';
        modal.style.paddingTop = 'calc(var(--lzh-effective-top, env(safe-area-inset-top, 0px)) + 12px)';
        modal.style.paddingBottom = 'calc(var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px)) + 12px)';
        modal.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
        modal.style.paddingRight = 'env(safe-area-inset-right, 0px)';
        document.body.appendChild(modal);
        photoFullscreenEl = modal;
        return modal;
    }

    function openPhotoFullscreenViewer() {
        if (!photoImageDataUrl) return;
        photoFullscreenOpen = true;
        fsPhotoZoom = { scale: 1, tx: 0, ty: 0 };
        if (hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.setFullscreenViewer === 'function') {
            global.LZHDesktopWidget.setFullscreenViewer(true);
        }
        renderPhotoFullscreenModal();
    }

    function closePhotoFullscreenViewer() {
        photoFullscreenOpen = false;
        if (hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.setFullscreenViewer === 'function') {
            global.LZHDesktopWidget.setFullscreenViewer(false);
        }
        hideTapBubble();
        if (photoFullscreenResizeObs) {
            try { photoFullscreenResizeObs.disconnect(); } catch (e) {}
            photoFullscreenResizeObs = null;
        }
        if (photoFullscreenEl) {
            photoFullscreenEl.classList.add('hidden');
        }
        renderActiveTabBody();
    }

    function renderPhotoFullscreenModal() {
        const modal = ensurePhotoFullscreenModal();
        if (!photoFullscreenOpen || !photoImageDataUrl) {
            modal.classList.add('hidden');
            return;
        }
        modal.classList.remove('hidden');

        const cats = getDeckCategoriesList();
        const curDeck = getPreferredTargetDeckName();
        const selCount = photoSelectedTokenIds.size;

        modal.innerHTML = `
            <div class="px-3 py-2 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-2 flex-wrap shrink-0">
                <div class="flex items-center gap-1.5 min-w-0">
                    <button type="button" id="ftFsCloseBtn" class="min-h-[44px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-extrabold inline-flex items-center gap-1 cursor-pointer">${FT_SVG.close}<span>收合</span></button>
                    <button type="button" id="ftFsLookupBtn" class="min-h-[44px] px-3 py-1.5 rounded-xl text-xs font-extrabold inline-flex items-center gap-1 cursor-pointer ${photoMode === 'lookup' ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-300'}">${FT_SVG.cursor}<span>點擊查義</span></button>
                    <button type="button" id="ftFsSelectBtn" class="min-h-[44px] px-3 py-1.5 rounded-xl text-xs font-extrabold inline-flex items-center gap-1 cursor-pointer ${photoMode === 'select' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}">${FT_SVG.checkbox}<span>選取 (${selCount})</span></button>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <div class="ft-zoom-controls">
                        <button type="button" id="ftFsZoomOutBtn" class="ft-zoom-btn bg-slate-800 hover:bg-slate-700 text-slate-200" aria-label="縮小">－</button>
                        <button type="button" id="ftFsZoomResetBtn" class="ft-zoom-btn bg-slate-800 hover:bg-slate-700 text-cyan-300 font-mono" aria-label="重設縮放">${Math.round(fsPhotoZoom.scale * 100)}%</button>
                        <button type="button" id="ftFsZoomInBtn" class="ft-zoom-btn bg-slate-800 hover:bg-slate-700 text-slate-200" aria-label="放大">＋</button>
                    </div>
                    ${photoTokens.length > 0 ? `
                        <button type="button" id="ftFsSelectAllBtn" class="min-h-[44px] px-2.5 py-1.5 rounded-lg bg-emerald-900/60 text-emerald-300 text-[11px] font-bold cursor-pointer">全選</button>
                        <button type="button" id="ftFsClearSelBtn" class="min-h-[44px] px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-[11px] font-bold cursor-pointer">清空</button>
                    ` : ''}
                </div>
            </div>

            ${isVisionBusy ? `
                <div class="px-4 py-2 bg-cyan-950/90 border-b border-cyan-500/40 text-center text-xs font-bold text-cyan-200 flex items-center justify-center gap-2 shrink-0">
                    <span class="ft-live-dot" style="background:#22d3ee;box-shadow:0 0 8px rgba(34,211,238,0.9);"></span>
                    <span>偵測框校準與高精準視覺取詞分析中...</span>
                </div>
            ` : ''}

            <div id="ftFsStageViewport" class="ft-fullscreen-stage-viewport flex-1 p-2">
                <div id="ftFsStageBox" class="ft-fullscreen-stage-box rounded-lg overflow-hidden shadow-2xl bg-black">
                    <img id="ftFsStageImg" src="${photoImageDataUrl}" alt="全螢幕辨識照片" style="max-height:74vh;">
                    ${isVisionBusy ? `
                        <div class="ft-scanline-layer ft-scanline-layer--fs" aria-hidden="true">
                            <div class="ft-scanline-beam"></div>
                            <span class="ft-reticle-corner ft-reticle-tl"></span>
                            <span class="ft-reticle-corner ft-reticle-tr"></span>
                            <span class="ft-reticle-corner ft-reticle-bl"></span>
                            <span class="ft-reticle-corner ft-reticle-br"></span>
                        </div>
                    ` : ''}
                    <div id="ftFsOverlay" class="absolute inset-0">
                        ${photoTokens.map(tk => {
                            const rect = box1000ToPercentRect(tk.box);
                            if (!rect) return '';
                            const isSel = photoSelectedTokenIds.has(tk.id);
                            const isAct = photoActiveTokenId === tk.id;
                            const cls = ['ft-photo-hotspot', isSel ? 'ft-photo-hotspot-selected' : '', isAct ? 'ft-photo-hotspot-active' : ''].filter(Boolean).join(' ');
                            return `<button type="button" data-ft-fs-tok="${escapeHtml(tk.id)}" title="${escapeHtml(tk.text)}" class="${cls}" style="top:${rect.topPct}%;left:${rect.leftPct}%;width:${rect.widthPct}%;height:${rect.heightPct}%;"></button>`;
                        }).join('')}
                    </div>
                </div>
            </div>

            ${photoSummary ? `
                <div class="px-3 py-1.5 bg-slate-900/90 border-t border-slate-800 text-[11px] text-slate-200 leading-snug shrink-0 max-h-16 overflow-y-auto">
                    <span class="font-bold text-slate-400 mr-1">[摘要]</span>${escapeHtml(photoSummary)}
                </div>
            ` : ''}

            <div class="px-3 py-2 bg-slate-900/95 border-t border-slate-800 space-y-2 shrink-0">
                <div class="flex flex-wrap items-center gap-1.5">
                    <button type="button" id="ftFsFullTranslateBtn" ${isPhotoArticleTranslating ? 'disabled' : ''} class="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-slate-950 text-xs font-extrabold inline-flex items-center gap-1 cursor-pointer shadow-xs">
                        ${FT_SVG.sparkle}<span>${isPhotoArticleTranslating ? '整篇翻譯中...' : '整篇翻譯成中文'}</span>
                    </button>
                    ${photoArticleTranslation ? `
                        <button type="button" id="ftFsCopyFullTransBtn" class="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 text-[11px] font-bold cursor-pointer">複製整篇譯文</button>
                        <button type="button" id="ftFsToggleOrigBtn" class="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] font-bold cursor-pointer">${photoArticleViewMode === 'both' ? '僅看譯文' : '原文對照'}</button>
                    ` : ''}
                </div>
                ${photoArticleTranslation ? `
                    <div class="p-2.5 rounded-xl bg-slate-950/90 border border-amber-500/40 max-h-36 overflow-y-auto space-y-1.5 select-text">
                        ${photoArticleViewMode === 'both' && getEffectivePhotoRawText() ? `
                            <div class="text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed pb-1.5 border-b border-slate-800">${escapeHtml(getEffectivePhotoRawText())}</div>
                        ` : ''}
                        <div class="text-xs sm:text-sm font-medium text-amber-100 whitespace-pre-wrap leading-relaxed">${escapeHtml(photoArticleTranslation)}</div>
                    </div>
                ` : ''}
            </div>

            ${(photoMode === 'select' || selCount > 0) ? `
                <div class="px-3 py-2 bg-slate-900 border-t border-emerald-800/70 space-y-1.5 shrink-0">
                    <div class="flex flex-wrap gap-1 max-h-14 overflow-y-auto">
                        ${selCount === 0
                            ? '<span class="text-[11px] text-slate-400">點擊照片方框勾選欲收錄的單字</span>'
                            : photoTokens.filter(tk => photoSelectedTokenIds.has(tk.id)).map(tk => `
                                <button type="button" data-ft-fs-chip-rm="${escapeHtml(tk.id)}" class="px-2 py-0.5 rounded-lg bg-slate-800 border border-emerald-600 text-[11px] font-bold text-emerald-300 cursor-pointer">${escapeHtml(tk.text)} ×</button>
                            `).join('')
                        }
                    </div>
                    <div class="flex items-center gap-1.5">
                        <select id="ftFsDeckSelect" class="flex-1 min-w-[110px] px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-bold text-white outline-none">
                            ${cats.map(c => `<option value="${escapeHtml(c)}" ${c === curDeck ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                            <option value="__NEW__">＋ 新增字庫...</option>
                        </select>
                        <input type="text" id="ftFsNewDeckInput" placeholder="新字庫名稱" class="hidden flex-1 min-w-[100px] px-2.5 py-1.5 rounded-xl bg-slate-800 border border-emerald-500 text-xs font-bold text-white outline-none">
                        <button type="button" id="ftFsConfirmImportBtn" ${selCount === 0 ? 'disabled' : ''} class="min-h-[44px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-400 text-white text-xs font-extrabold cursor-pointer">
                            確認收錄 (${selCount})
                        </button>
                    </div>
                </div>
            ` : ''}
        `;

        const vp = modal.querySelector('#ftFsStageViewport');
        const stageBox = modal.querySelector('#ftFsStageBox');
        const zoomResetBtn = modal.querySelector('#ftFsZoomResetBtn');
        const zoomInBtn = modal.querySelector('#ftFsZoomInBtn');
        const zoomOutBtn = modal.querySelector('#ftFsZoomOutBtn');
        if (vp && stageBox) {
            bindPhotoZoomGestures(vp, stageBox, fsPhotoZoom, zoomResetBtn);
            if (zoomInBtn) zoomInBtn.onclick = () => {
                fsPhotoZoom.scale = clamp(fsPhotoZoom.scale + 0.25, 0.75, 2.5);
                applyPhotoZoomTransform(stageBox, fsPhotoZoom, zoomResetBtn);
            };
            if (zoomOutBtn) zoomOutBtn.onclick = () => {
                fsPhotoZoom.scale = clamp(fsPhotoZoom.scale - 0.25, 0.75, 2.5);
                applyPhotoZoomTransform(stageBox, fsPhotoZoom, zoomResetBtn);
            };
            if (zoomResetBtn) zoomResetBtn.onclick = () => {
                fsPhotoZoom = { scale: 1, tx: 0, ty: 0 };
                applyPhotoZoomTransform(stageBox, fsPhotoZoom, zoomResetBtn);
            };
        }

        const closeBtn = modal.querySelector('#ftFsCloseBtn');
        if (closeBtn) closeBtn.onclick = closePhotoFullscreenViewer;
        const lookBtn = modal.querySelector('#ftFsLookupBtn');
        if (lookBtn) lookBtn.onclick = () => setPhotoMode('lookup');
        const selBtn = modal.querySelector('#ftFsSelectBtn');
        if (selBtn) selBtn.onclick = () => setPhotoMode('select');
        const allBtn = modal.querySelector('#ftFsSelectAllBtn');
        if (allBtn) {
            allBtn.onclick = () => {
                photoTokens.forEach(tk => photoSelectedTokenIds.add(tk.id));
                photoMode = 'select';
                renderPhotoFullscreenModal();
            };
        }
        const clrBtn = modal.querySelector('#ftFsClearSelBtn');
        if (clrBtn) {
            clrBtn.onclick = () => {
                photoSelectedTokenIds.clear();
                renderPhotoFullscreenModal();
            };
        }

        const fsFullTransBtn = modal.querySelector('#ftFsFullTranslateBtn');
        if (fsFullTransBtn) fsFullTransBtn.onclick = () => translatePhotoArticleToChinese();
        const fsCopyTransBtn = modal.querySelector('#ftFsCopyFullTransBtn');
        if (fsCopyTransBtn) fsCopyTransBtn.onclick = () => copyPhotoArticleTranslation();
        const fsToggleOrigBtn = modal.querySelector('#ftFsToggleOrigBtn');
        if (fsToggleOrigBtn) {
            fsToggleOrigBtn.onclick = () => {
                photoArticleViewMode = photoArticleViewMode === 'both' ? 'trans' : 'both';
                renderPhotoFullscreenModal();
                renderActiveTabBody();
            };
        }

        modal.querySelectorAll('[data-ft-fs-tok]').forEach(btn => {
            btn.onclick = (ev) => {
                ev.stopPropagation();
                if (Date.now() < ftPhotoPinchGuardUntil) return;
                const tid = btn.getAttribute('data-ft-fs-tok');
                const tk = photoTokens.find(item => item.id === tid);
                handlePhotoHotspotClick(tk, btn);
            };
        });
        modal.querySelectorAll('[data-ft-fs-chip-rm]').forEach(btn => {
            btn.onclick = () => {
                photoSelectedTokenIds.delete(btn.getAttribute('data-ft-fs-chip-rm'));
                renderPhotoFullscreenModal();
            };
        });

        const deckSel = modal.querySelector('#ftFsDeckSelect');
        const newInp = modal.querySelector('#ftFsNewDeckInput');
        if (deckSel && newInp) {
            deckSel.onchange = () => {
                newInp.classList.toggle('hidden', deckSel.value !== '__NEW__');
                if (deckSel.value === '__NEW__') newInp.focus();
            };
        }
        const confirmBtn = modal.querySelector('#ftFsConfirmImportBtn');
        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                let targetDeck = deckSel ? deckSel.value : getPreferredTargetDeckName();
                if (targetDeck === '__NEW__') {
                    targetDeck = (newInp && newInp.value.trim()) ? newInp.value.trim() : '拍照字庫';
                }
                await confirmImportSelectedPhotoTokens(targetDeck, confirmBtn);
            };
        }
    }

    function loadLocalTesseractEngine() {
        if (global.Tesseract && typeof global.Tesseract.createWorker === 'function') {
            return Promise.resolve(global.Tesseract);
        }
        if (ftTesseractPromise) return ftTesseractPromise;
        ftTesseractPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-lzhcard-tesseract="1"]');
            if (existing) {
                existing.addEventListener('load', () => resolve(global.Tesseract));
                existing.addEventListener('error', () => reject(new Error('Tesseract 載入失敗')));
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
            script.async = true;
            script.dataset.lzhcardTesseract = '1';
            script.onload = () => {
                if (global.Tesseract) resolve(global.Tesseract);
                else reject(new Error('Tesseract 初始化失敗'));
            };
            script.onerror = () => {
                ftTesseractPromise = null;
                reject(new Error('無法連線載入本地離線 OCR 引擎'));
            };
            document.head.appendChild(script);
        });
        return ftTesseractPromise;
    }

    function mapSourceLangToTesseract(langCode) {
        const l = String(langCode || '').trim().toLowerCase();
        if (l.startsWith('ja')) return 'jpn';
        if (l.startsWith('ko')) return 'kor';
        if (l.startsWith('zh')) return 'chi_tra';
        return 'eng';
    }

    function filterOcrNoiseText(rawText, lockedLang = 'en') {
        let text = String(rawText || '')
            .replace(/[|=~^_`\\§©®•·]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return '';

        const lang = String(lockedLang || 'en').toLowerCase();
        if (lang === 'en' || (!lang.startsWith('ja') && !lang.startsWith('ko') && !lang.startsWith('zh'))) {
            const kept = text.split(/\s+/).filter((tok) => {
                const core = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
                if (!core) return false;
                if (core.length === 1) {
                    return core === 'a' || core === 'A' || core === 'I';
                }
                return /[A-Za-z0-9]/.test(core);
            });
            text = kept.join(' ').trim();
        }

        const meaningfulCount = (text.match(/[\p{L}\p{N}]/gu) || []).length;
        if (meaningfulCount < 2) return '';
        if (meaningfulCount / Math.max(1, text.length) < 0.45) return '';
        return text;
    }

    function filterOcrResultWordsAndText(ocrResult, lockedLang = 'en', minConfidence = 65) {
        const data = (ocrResult && ocrResult.data) || {};
        const words = Array.isArray(data.words) ? data.words : [];
        if (words.length > 0) {
            const validWords = [];
            for (let i = 0; i < words.length; i++) {
                const w = words[i];
                if (!w) continue;
                const conf = Number(w.confidence);
                if (Number.isFinite(conf) && conf < minConfidence) continue;
                const cleanedTok = filterOcrNoiseText(w.text, lockedLang);
                if (!cleanedTok) continue;
                validWords.push({ ...w, text: cleanedTok });
            }
            const joined = filterOcrNoiseText(validWords.map(w => w.text).join(' '), lockedLang);
            return { text: joined, words: validWords };
        }
        const lines = Array.isArray(data.lines) ? data.lines : [];
        const validLines = lines
            .filter(l => l && (!Number.isFinite(Number(l.confidence)) || Number(l.confidence) >= minConfidence))
            .map(l => String(l.text || '').trim())
            .filter(Boolean);
        const fallbackRaw = validLines.length ? validLines.join(' ') : String(data.text || '');
        return { text: filterOcrNoiseText(fallbackRaw, lockedLang), words: [] };
    }

    async function runLocalTesseractPhotoOcr(dataUrl, width, height, nativeCfg, sourceLangHint = '') {
        const Tesseract = await loadLocalTesseractEngine();
        const lockedLang = sourceLangHint || videoSourceLang || 'en';
        const tessLang = mapSourceLangToTesseract(lockedLang);
        const ocrResult = await Tesseract.recognize(dataUrl, tessLang);
        const words = (ocrResult && ocrResult.data && Array.isArray(ocrResult.data.words)) ? ocrResult.data.words : [];
        const imgW = Math.max(1, Number(width) || 1000);
        const imgH = Math.max(1, Number(height) || 1000);

        const rawTokens = [];
        for (let i = 0; i < words.length && rawTokens.length < 600; i++) {
            const w = words[i];
            const conf = Number(w && w.confidence);
            if (Number.isFinite(conf) && conf < 65) continue;
            const txt = filterOcrNoiseText((w && w.text) || '', lockedLang);
            if (!txt) continue;
            const bb = (w && w.bbox) || null;
            if (!bb) continue;
            const ymin = clamp(Math.round((bb.y0 / imgH) * 1000), 0, 998);
            const xmin = clamp(Math.round((bb.x0 / imgW) * 1000), 0, 998);
            const ymax = clamp(Math.round((bb.y1 / imgH) * 1000), ymin + 8, 1000);
            const xmax = clamp(Math.round((bb.x1 / imgW) * 1000), xmin + 8, 1000);
            rawTokens.push({
                id: `ltok_${rawTokens.length}`,
                text: txt,
                lang: detectScriptLang(txt, lockedLang),
                reading: '',
                pos: '',
                translation: '',
                box: [ymin, xmin, ymax, xmax]
            });
        }

        const filteredFull = filterOcrResultWordsAndText(ocrResult, lockedLang, 65);
        const fullRawText = filteredFull.text || rawTokens.map(t => t.text).join(' ').trim();
        let summary = '';
        if (fullRawText) {
            try {
                summary = await fetchGoogleTranslateFallback(fullRawText.slice(0, 600), detectScriptLang(fullRawText, lockedLang), nativeCfg.code);
            } catch (e) {}
        }
        return { tokens: rawTokens, summary, rawText: fullRawText };
    }

    function getEffectivePhotoRawText() {
        if (photoRawArticleText && photoRawArticleText.trim()) return photoRawArticleText.trim();
        if (Array.isArray(photoTokens) && photoTokens.length > 0) {
            return photoTokens.map(tk => String(tk.text || '').trim()).filter(Boolean).join(' ');
        }
        return '';
    }

    async function copyTextWithClipboardFallback(text) {
        const clean = String(text || '').trim();
        if (!clean) return false;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(clean);
                return true;
            }
        } catch (e) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = clean;
            ta.setAttribute('readonly', 'true');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return Boolean(ok);
        } catch (e) {
            return false;
        }
    }

    async function copyPhotoArticleTranslation() {
        if (!photoArticleTranslation || !photoArticleTranslation.trim()) {
            toast('尚無整篇譯文可複製', 'info');
            return false;
        }
        const ok = await copyTextWithClipboardFallback(photoArticleTranslation);
        toast(ok ? '已複製整篇中文譯文' : '複製失敗，請手動選取文字複製', ok ? 'success' : 'warning');
        return ok;
    }

    async function translatePhotoArticleToChinese() {
        if (isPhotoArticleTranslating) return '';
        const sourceText = getEffectivePhotoRawText();
        if (!sourceText && !photoImageBase64) {
            toast('請先拍照或選擇圖片並等待文字辨識完成', 'warning');
            return '';
        }

        const canUseCloudAi = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
            ? global.MembershipEngine.canConsumeAiQuota('def_fill').allowed
            : true;

        if (canUseCloudAi && typeof global.ensureAiPrivacyConsent === 'function') {
            const consentOk = await global.ensureAiPrivacyConsent({ feature: photoImageBase64 && !sourceText ? 'vision_ocr' : 'def_fill' });
            if (!consentOk) {
                return '';
            }
        }

        isPhotoArticleTranslating = true;
        renderActiveTabBody();
        if (photoFullscreenOpen) renderPhotoFullscreenModal();

        try {
            let translated = '';
            if (canUseCloudAi && typeof global.callGeminiApi === 'function') {
                try {
                    if (sourceText) {
                        const prompt = `請將以下整篇文章／圖片辨識原文完整翻譯成自然流暢的「繁體中文」，嚴格保留原本的段落換行與條列結構，僅直接輸出翻譯結果（不要加解釋或 Markdown 框）：\n\n${sourceText}`;
                        translated = await global.callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
                    } else if (photoImageBase64) {
                        const prompt = `請辨識圖片中的所有文章／段落文字，並完整翻譯成自然流暢的「繁體中文」，保留原本段落與換行結構，僅直接輸出中文譯文。`;
                        translated = await global.callGeminiApi(prompt, {
                            silent: true,
                            feature: 'vision_ocr',
                            inlineData: { mimeType: photoImageMime || 'image/jpeg', data: photoImageBase64 }
                        });
                    }
                } catch (aiErr) {
                    console.warn('[FloatingTranslator] 全篇 AI 翻譯失敗，嘗試免費備援翻譯:', aiErr);
                }
            }

            if (!translated && sourceText) {
                try {
                    translated = await fetchGoogleTranslateFallback(sourceText.slice(0, 3500), detectScriptLang(sourceText), 'zh-TW');
                } catch (gtxErr) {}
            }

            translated = String(translated || '').trim();
            if (!translated) {
                toast('整篇翻譯失敗，請檢查網路連線或會員雲端 AI 額度狀態', 'error');
                return '';
            }

            photoArticleTranslation = translated;
            toast('整篇文章翻譯成中文完成！', 'success');
            return translated;
        } finally {
            isPhotoArticleTranslating = false;
            renderActiveTabBody();
            if (photoFullscreenOpen) renderPhotoFullscreenModal();
        }
    }

    async function analyzeCompressedPhoto({ dataUrl, base64, mimeType, width, height }) {
        syncImageModeLock(true);
        photoImageDataUrl = dataUrl;
        photoImageBase64 = base64;
        photoImageMime = mimeType || 'image/jpeg';
        photoNaturalWidth = Number(width) || 0;
        photoNaturalHeight = Number(height) || 0;
        photoTokens = [];
        photoSummary = '';
        photoRawArticleText = '';
        photoArticleTranslation = '';
        isPhotoArticleTranslating = false;
        photoActiveTokenId = null;
        photoSelectedTokenIds.clear();
        isVisionBusy = true;
        photoFullscreenOpen = true;
        hideTapBubble();
        renderActiveTabBody();
        renderPhotoFullscreenModal();

        const nativeCfg = getNativeLangConfig(targetNativeLang);
        const prompt = `請對這張圖片進行高精準多語 OCR 與詞彙定位解析。
規則：
1. rawText 欄位請完整保留並輸出圖片中的原文全文（依自然閱讀順序與換行連接）。
2. tokens 辨識圖片中的英文單字、日文單字／片語或中文詞彙（最多回傳 80 個重要字詞，優先實詞）。
3. 每個 token 必須附上相對於整張圖片的正規化邊界框 box: [ymin, xmin, ymax, xmax]，座標範圍為 0 到 1000 的整數。
4. lang 為 "en"、"ja" 或 "zh-TW"。
5. reading：英文填 IPA 音標；日文必須填寫「純平假名讀音」；中文可填拼音或留空。
6. translation 必須使用「${nativeCfg.aiName}」翻譯該詞彙；summary 為整張圖主要內容的「${nativeCfg.aiName}」通順翻譯摘要。
7. 只輸出單一純 JSON 物件（不要加 Markdown 語法）：
{"rawText":"","summary":"","detectedLang":"en|ja|zh-TW","tokens":[{"text":"","lang":"en|ja|zh-TW","reading":"","pos":"","translation":"","box":[0,0,100,200]}]}`;

        let canUseCloudVision = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
            ? global.MembershipEngine.canConsumeAiQuota('vision_ocr').allowed
            : true;

        if (canUseCloudVision && typeof global.ensureAiPrivacyConsent === 'function') {
            const consentOk = await global.ensureAiPrivacyConsent({ feature: 'vision_ocr' });
            if (!consentOk) {
                canUseCloudVision = false;
            }
        }

        try {
            let usedLocalFallback = false;

            if (canUseCloudVision && typeof global.callGeminiApi === 'function') {
                try {
                    const raw = await global.callGeminiApi(prompt, {
                        silent: true,
                        feature: 'vision_ocr',
                        inlineData: { mimeType: photoImageMime, data: photoImageBase64 }
                    });
                    const parsed = (typeof global.safeParseJSON === 'function')
                        ? global.safeParseJSON(raw)
                        : JSON.parse(raw);

                    photoSummary = String((parsed && parsed.summary) || '').trim();
                    photoRawArticleText = String((parsed && parsed.rawText) || '').trim();
                    const rawTokens = (parsed && Array.isArray(parsed.tokens)) ? parsed.tokens : [];
                    photoTokens = rawTokens
                        .map((tk, idx) => {
                            const box = normalizeBox1000(tk && tk.box);
                            const text = String((tk && (tk.text || tk.word)) || '').trim();
                            if (!box || !text) return null;
                            const lang = (tk.lang === 'en' || tk.lang === 'ja' || tk.lang === 'zh-TW')
                                ? tk.lang
                                : detectScriptLang(text);
                            return {
                                id: `ptok_${idx}`,
                                text,
                                lang,
                                reading: String(tk.reading || tk.phonetic || '').trim(),
                                pos: String(tk.pos || '').trim(),
                                translation: String(tk.translation || tk.meaning || '').trim(),
                                box
                            };
                        })
                        .filter(Boolean);
                    if (!photoRawArticleText && photoTokens.length > 0) {
                        photoRawArticleText = photoTokens.map(t => t.text).join(' ');
                    }
                } catch (cloudErr) {
                    if (cloudErr && cloudErr.code === 'QUOTA_EXCEEDED') {
                        usedLocalFallback = true;
                    } else {
                        throw cloudErr;
                    }
                }
            } else {
                usedLocalFallback = true;
            }

            if (usedLocalFallback) {
                const localRes = await runLocalTesseractPhotoOcr(photoImageDataUrl, photoNaturalWidth, photoNaturalHeight, nativeCfg);
                photoTokens = localRes.tokens;
                photoSummary = localRes.summary;
                photoRawArticleText = localRes.rawText || localRes.tokens.map(t => t.text).join(' ');
                toast('已使用免費本地離線 OCR 辨識（點詞將以極速翻譯解析；升級入門／進階方案可啟用雲端 AI 高精準多語熱區）', 'info');
            } else if (photoTokens.length === 0 && !photoSummary && !photoRawArticleText) {
                toast('圖片中未偵測到可辨識文字', 'warning');
            } else {
                toast(`辨識完成，共定位 ${photoTokens.length} 個互動字詞熱區`, 'success');
            }
        } catch (err) {
            console.error('[FloatingTranslator] Vision OCR error:', err);
            toast('圖片辨識失敗：' + (err && err.message ? err.message : '請稍後再試'), 'error');
        } finally {
            isVisionBusy = false;
            renderActiveTabBody();
            if (photoFullscreenOpen) renderPhotoFullscreenModal();
        }
    }

    function setPhotoMode(mode) {
        photoMode = mode === 'select' ? 'select' : 'lookup';
        if (photoMode === 'select') {
            hideTapBubble();
        }
        renderActiveTabBody();
        if (photoFullscreenOpen) renderPhotoFullscreenModal();
    }

    function handlePhotoHotspotClick(tokenObj, hotspotEl) {
        if (!tokenObj) return;
        if (photoMode === 'select') {
            if (photoSelectedTokenIds.has(tokenObj.id)) {
                photoSelectedTokenIds.delete(tokenObj.id);
            } else {
                photoSelectedTokenIds.add(tokenObj.id);
            }
            renderActiveTabBody();
            if (photoFullscreenOpen) renderPhotoFullscreenModal();
            return;
        }

        // 查字模式：緊貼該邊界框上方彈出翻譯氣泡
        photoActiveTokenId = tokenObj.id;
        document.querySelectorAll('.ft-photo-hotspot-active').forEach(el => el.classList.remove('ft-photo-hotspot-active'));
        if (hotspotEl) hotspotEl.classList.add('ft-photo-hotspot-active');

        const rect = hotspotEl ? hotspotEl.getBoundingClientRect() : null;
        openLookupBubbleForWord(
            tokenObj.text,
            tokenObj.lang,
            rect,
            photoSummary,
            {
                preferAbove: true,
                preloadedData: tokenObj.translation ? {
                    word: tokenObj.text,
                    lang: tokenObj.lang,
                    nativeLang: targetNativeLang,
                    phonetic: tokenObj.reading || '',
                    pos: tokenObj.pos || '',
                    meaning: tokenObj.translation,
                    sentence: '',
                    translation: ''
                } : null,
                onSelectPhotoToken: () => {
                    photoSelectedTokenIds.add(tokenObj.id);
                    photoMode = 'select';
                    hideTapBubble();
                    renderActiveTabBody();
                    if (photoFullscreenOpen) renderPhotoFullscreenModal();
                }
            }
        );
    }

    async function confirmImportSelectedPhotoTokens(explicitDeckName = '', explicitBtn = null) {
        const selected = photoTokens.filter(tk => photoSelectedTokenIds.has(tk.id));
        if (selected.length === 0) {
            toast('請先點選圖片中的至少 1 個單字', 'warning');
            return;
        }
        const deck = explicitDeckName || getPreferredTargetDeckName();
        const btn = explicitBtn || q('ftPhotoConfirmImportBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'AI 生成字卡中...';
        }
        try {
            const payloadList = selected.map(tk => ({
                word: tk.text,
                lang: tk.lang,
                pos: tk.pos,
                phonetic: tk.reading,
                meaning: tk.translation
            }));
            const enriched = await batchEnrichWordsWithAi(payloadList);
            const res = upsertCardsIntoWordList(enriched, deck);
            photoSelectedTokenIds.clear();
            toast(`已收錄 ${res.addedCount} 張、更新 ${res.updatedCount} 張字卡至【${res.deck}】`, 'success');
            renderActiveTabBody();
            if (photoFullscreenOpen) renderPhotoFullscreenModal();
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ==========================================================================
       5. 模組四：即時雙語字幕引擎（三段式零延遲 + YouTube 0ms 時間軸 + 透明懸浮字幕層）
       ========================================================================== */

    function stopAllSubtitleEngines() {
        stopScreenSubtitleMode();
        stopVoiceRecognitionMode();
        stopYoutubeTimelinePlayback();
    }

    function stopScreenSubtitleMode() {
        stopVideoSubtitleMonitor();
        if (activeLiveMode === 'screen') {
            activeLiveMode = 'none';
        }
    }

    function stopVoiceRecognitionMode() {
        stopSttSubtitleEngine();
        if (activeLiveMode === 'voice') {
            activeLiveMode = 'none';
        }
    }

    function stopVideoSubtitleMonitor() {
        if (videoMonitorTimer) {
            clearInterval(videoMonitorTimer);
            videoMonitorTimer = null;
        }
        if (videoCaptureStream) {
            try {
                videoCaptureStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) {}
                });
            } catch (e) {}
            videoCaptureStream = null;
        }
        if (videoSourceElement && videoSourceElement.dataset && videoSourceElement.dataset.ftTemp === 'true') {
            try { videoSourceElement.pause(); } catch (e) {}
            videoSourceElement.srcObject = null;
            videoSourceElement = null;
        }
        videoLastFrameLuma = null;
        videoOcrInFlight = false;
        if (activeLiveMode === 'screen') {
            activeLiveMode = 'none';
        }
    }

    /**
     * Canvas 像素幀差比較：計算 ROI 區域與前一張取樣幀的差異比例 (0 ~ 1)
     */
    function computeFrameDiffRatio(prevLumaArr, currentLumaArr, pixelDeltaThreshold = 26) {
        if (!prevLumaArr || !currentLumaArr || prevLumaArr.length !== currentLumaArr.length || currentLumaArr.length === 0) {
            return 1;
        }
        let changed = 0;
        for (let i = 0; i < currentLumaArr.length; i++) {
            if (Math.abs(currentLumaArr[i] - prevLumaArr[i]) >= pixelDeltaThreshold) {
                changed++;
            }
        }
        return changed / currentLumaArr.length;
    }

    function loadVideoRoiPreference() {
        try {
            const savedMode = localStorage.getItem(STORAGE_VIDEO_ROI_MODE_KEY);
            if (savedMode && ['bottom25', 'bottom40', 'top25', 'auto', 'custom'].includes(savedMode)) {
                videoRoiMode = savedMode;
            } else if (savedMode === 'full') {
                videoRoiMode = 'bottom25';
            }
            const rawCfg = localStorage.getItem(STORAGE_VIDEO_ROI_CFG_KEY);
            if (rawCfg) {
                const parsed = JSON.parse(rawCfg);
                if (parsed && typeof parsed === 'object') {
                    videoRoiCustomRect = {
                        xPct: clamp(Number(parsed.xPct ?? 0.12), 0, 0.9),
                        yPct: clamp(Number(parsed.yPct ?? 0.75), 0, 0.9),
                        wPct: clamp(Number(parsed.wPct ?? 0.76), 0.1, 1),
                        hPct: clamp(Number(parsed.hPct ?? 0.18), 0.08, 1)
                    };
                }
            }
            const rawDual = localStorage.getItem(STORAGE_VIDEO_ROI_DUAL_KEY);
            if (rawDual) {
                const parsedDual = JSON.parse(rawDual);
                if (parsedDual && typeof parsedDual === 'object') {
                    videoRoiDualCfg = {
                        portraitMode: ['bottom25', 'bottom40', 'top25', 'auto', 'custom'].includes(parsedDual.portraitMode) ? parsedDual.portraitMode : videoRoiMode,
                        portraitRect: normalizeRoiDraftRect(parsedDual.portraitRect || videoRoiCustomRect),
                        landscapeMode: ['bottom25', 'bottom40', 'top25', 'auto', 'custom'].includes(parsedDual.landscapeMode) ? parsedDual.landscapeMode : videoRoiMode,
                        landscapeRect: normalizeRoiDraftRect(parsedDual.landscapeRect || videoRoiCustomRect)
                    };
                }
            } else {
                videoRoiDualCfg = {
                    portraitMode: videoRoiMode,
                    portraitRect: normalizeRoiDraftRect(videoRoiCustomRect),
                    landscapeMode: videoRoiMode,
                    landscapeRect: normalizeRoiDraftRect(videoRoiCustomRect)
                };
            }
            const savedLang = localStorage.getItem(STORAGE_VIDEO_SOURCE_LANG_KEY);
            if (savedLang && ['en', 'ja', 'ko', 'zh-TW'].includes(savedLang)) {
                videoSourceLang = savedLang;
            }
        } catch (e) {}
    }

    function normalizeRoiDraftRect(rect) {
        const src = (rect && typeof rect === 'object') ? rect : {};
        const rawX = src.xPct !== undefined ? Number(src.xPct) : Number(src.x);
        const rawY = src.yPct !== undefined ? Number(src.yPct) : Number(src.y);
        const rawW = src.wPct !== undefined ? Number(src.wPct) : Number(src.width);
        const rawH = src.hPct !== undefined ? Number(src.hPct) : Number(src.height);
        const xPct = clamp(Number.isFinite(rawX) ? rawX : 0.12, 0, 0.90);
        const yPct = clamp(Number.isFinite(rawY) ? rawY : 0.75, 0, 0.90);
        const wPct = clamp(Number.isFinite(rawW) ? rawW : 0.76, 0.10, 1 - xPct);
        const hPct = clamp(Number.isFinite(rawH) ? rawH : 0.18, 0.08, 1 - yPct);
        return {
            xPct: Number(xPct.toFixed(3)),
            yPct: Number(yPct.toFixed(3)),
            wPct: Number(wPct.toFixed(3)),
            hPct: Number(hPct.toFixed(3))
        };
    }

    function persistVideoRoiConfig() {
        const rectJson = JSON.stringify(videoRoiCustomRect);
        const dualJson = JSON.stringify(videoRoiDualCfg);
        try {
            localStorage.setItem(STORAGE_VIDEO_ROI_MODE_KEY, videoRoiMode);
            localStorage.setItem(STORAGE_VIDEO_ROI_CFG_KEY, rectJson);
            localStorage.setItem(STORAGE_VIDEO_ROI_DUAL_KEY, dualJson);
            localStorage.setItem(STORAGE_VIDEO_SOURCE_LANG_KEY, videoSourceLang);
        } catch (e) {}
        try {
            if (global.AndroidOverlay && typeof global.AndroidOverlay.setVideoRoiConfig === 'function') {
                global.AndroidOverlay.setVideoRoiConfig(videoRoiMode, rectJson);
            }
            if (global.AndroidOverlay && typeof global.AndroidOverlay.setVideoSourceLang === 'function') {
                global.AndroidOverlay.setVideoSourceLang(videoSourceLang);
            }
        } catch (e) {}
        if (typeof global.syncConfigToNativeOverlay === 'function') {
            global.syncConfigToNativeOverlay();
        }
    }

    let ftVisualCropModalEl = null;
    let ftCropBgDataUrl = '';

    function ensureVisualRoiCropStyle() {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById('ftVisualRoiCropStyle')) return;
        const styleEl = document.createElement('style');
        styleEl.id = 'ftVisualRoiCropStyle';
        styleEl.textContent = `
            .ft-crop-modal {
                position: fixed;
                inset: 0;
                width: 100vw;
                height: 100vh;
                z-index: 999999;
                background: rgba(2, 6, 23, 0.92);
                backdrop-filter: blur(8px);
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: calc(var(--lzh-effective-top, env(safe-area-inset-top, 0px)) + 12px) calc(env(safe-area-inset-right, 0px) + 12px) calc(var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px)) + 12px) calc(env(safe-area-inset-left, 0px) + 12px);
                color: #f8fafc;
            }
            .ft-crop-modal.hidden { display: none !important; }
            .ft-crop-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                flex-wrap: wrap;
                background: rgba(15, 23, 42, 0.92);
                border: 1px solid rgba(148, 163, 184, 0.28);
                border-radius: 14px;
                padding: 8px 12px;
                flex-shrink: 0;
            }
            .ft-crop-btn {
                border: 1px solid rgba(148, 163, 184, 0.35);
                background: rgba(30, 41, 59, 0.95);
                color: #f1f5f9;
                font-size: 11px;
                font-weight: 800;
                border-radius: 9px;
                padding: 8px 12px;
                min-height: 44px;
                min-width: 44px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
            }
            .ft-crop-btn:hover { background: rgba(51, 65, 85, 0.98); }
            .ft-crop-btn--primary {
                background: #10b981;
                border-color: #059669;
                color: #ffffff;
            }
            .ft-crop-btn--primary:hover { background: #059669; }
            .ft-crop-stage-wrap {
                flex: 1;
                min-height: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }
            .ft-crop-canvas {
                position: relative;
                width: 100%;
                max-width: 960px;
                aspect-ratio: 16 / 9;
                max-height: 100%;
                border-radius: 14px;
                overflow: hidden;
                border: 1px solid rgba(148, 163, 184, 0.4);
                background-color: rgba(15, 23, 42, 0.78);
                background-image:
                    linear-gradient(to right, rgba(255, 255, 255, 0.08) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
                background-size: 24px 24px;
                touch-action: none;
                user-select: none;
            }
            .ft-crop-modal.ft-crop-fs .ft-crop-canvas {
                max-width: calc(100vw - 24px);
                max-height: calc(100vh - 115px);
                width: 100%;
            }
            .ft-crop-bg-img {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: fill;
                pointer-events: none;
                user-select: none;
            }
            .ft-crop-bg-img.hidden { display: none !important; }
            .ft-crop-box {
                position: absolute;
                background: rgba(34, 197, 94, 0.22);
                border: 2px solid #22c55e;
                box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.45);
                cursor: move;
                touch-action: none;
            }
            .ft-crop-box-label {
                position: absolute;
                top: 4px;
                left: 6px;
                background: rgba(15, 23, 42, 0.88);
                color: #86efac;
                font-size: 10px;
                font-weight: 800;
                padding: 2px 6px;
                border-radius: 6px;
                pointer-events: none;
                white-space: nowrap;
            }
            .ft-crop-handle {
                position: absolute;
                width: 14px;
                height: 14px;
                border-radius: 999px;
                background: #ffffff;
                border: 2px solid #16a34a;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
                transform: translate(-50%, -50%);
                touch-action: none;
            }
            .ft-crop-handle[data-dir="nw"] { left: 0%; top: 0%; cursor: nwse-resize; }
            .ft-crop-handle[data-dir="n"]  { left: 50%; top: 0%; cursor: ns-resize; }
            .ft-crop-handle[data-dir="ne"] { left: 100%; top: 0%; cursor: nesw-resize; }
            .ft-crop-handle[data-dir="e"]  { left: 100%; top: 50%; cursor: ew-resize; }
            .ft-crop-handle[data-dir="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
            .ft-crop-handle[data-dir="s"]  { left: 50%; top: 100%; cursor: ns-resize; }
            .ft-crop-handle[data-dir="sw"] { left: 0%; top: 100%; cursor: nesw-resize; }
            .ft-crop-handle[data-dir="w"]  { left: 0%; top: 50%; cursor: ew-resize; }
        `;
        document.head.appendChild(styleEl);
    }

    async function captureSingleFrameDataUrlForCropper() {
        // 若已有正在播放且具備有效寬高的來源 <video>，優先直接取幀
        if (videoSourceElement && videoSourceElement.readyState >= 2 && videoSourceElement.videoWidth > 0 && videoSourceElement.videoHeight > 0) {
            const c = document.createElement('canvas');
            c.width = videoSourceElement.videoWidth;
            c.height = videoSourceElement.videoHeight;
            const ctx = c.getContext('2d');
            ctx.drawImage(videoSourceElement, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.9);
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
            throw new Error('此瀏覽器或裝置不支援即時畫面擷取，請使用「放上截圖」');
        }
        let stream = null;
        const hiddenVid = document.createElement('video');
        hiddenVid.muted = true;
        hiddenVid.playsInline = true;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            hiddenVid.srcObject = stream;
            await new Promise((resolve) => {
                if (hiddenVid.readyState >= 1) return resolve();
                hiddenVid.onloadedmetadata = () => resolve();
                setTimeout(resolve, 1500);
            });
            await hiddenVid.play().catch(() => {});

            const deadline = Date.now() + 2500;
            while ((hiddenVid.readyState < 2 || hiddenVid.videoWidth <= 0 || hiddenVid.videoHeight <= 0) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 45));
            }
            if (hiddenVid.readyState < 2 || hiddenVid.videoWidth <= 0 || hiddenVid.videoHeight <= 0) {
                throw new Error('畫面尚未就緒，請再試一次或改用「放上截圖」');
            }
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            const w = hiddenVid.videoWidth;
            const h = hiddenVid.videoHeight;
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.drawImage(hiddenVid, 0, 0, w, h);
            return c.toDataURL('image/jpeg', 0.9);
        } finally {
            try { hiddenVid.srcObject = null; } catch (e) {}
            if (stream && typeof stream.getTracks === 'function') {
                stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
            }
        }
    }

    function openVisualRoiCropper(options = {}) {
        ensureVisualRoiCropStyle();
        if (ftVisualCropModalEl && ftVisualCropModalEl.parentElement) {
            ftVisualCropModalEl.remove();
            ftVisualCropModalEl = null;
        }

        const title = options.title || '自訂字幕掃描框選器';
        let activeOrientation = options.orientation === 'portrait' ? 'portrait' : 'landscape';
        let draftPortrait = normalizeRoiDraftRect(options.portraitRect || options.initialRect || videoRoiDualCfg.portraitRect);
        let draftLandscape = normalizeRoiDraftRect(options.landscapeRect || options.initialRect || videoRoiDualCfg.landscapeRect);
        let draft = activeOrientation === 'portrait' ? { ...draftPortrait } : { ...draftLandscape };
        let cropFs = false;
        const prevElectronFs = Boolean(panelFullscreen);
        const canScreenGrab = Boolean(
            (videoSourceElement && videoSourceElement.readyState >= 2 && videoSourceElement.videoWidth > 0) ||
            (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')
        );

        const modal = document.createElement('div');
        modal.id = 'ftVisualRoiCropModal';
        modal.className = 'ft-crop-modal';
        modal.innerHTML = `
            <div class="ft-crop-toolbar">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <strong style="font-size:12px;">${escapeHtml(title)}</strong>
                    <button type="button" class="ft-crop-btn" id="ftCropOrientPortraitBtn" style="${activeOrientation === 'portrait' ? 'background:#4f46e5;border-color:#6366f1;color:#fff;' : ''}">📱 直立 9:16</button>
                    <button type="button" class="ft-crop-btn" id="ftCropOrientLandscapeBtn" style="${activeOrientation === 'landscape' ? 'background:#4f46e5;border-color:#6366f1;color:#fff;' : ''}">🖥️ 橫向 16:9</button>
                    <label class="ft-crop-btn">
                        <span>放上截圖</span>
                        <input type="file" id="ftCropFileInput" accept="image/*" style="display:none;">
                    </label>
                    ${canScreenGrab ? '<button type="button" class="ft-crop-btn" id="ftCropGrabScreenBtn">擷取畫面</button>' : ''}
                    <button type="button" class="ft-crop-btn" id="ftCropClearImgBtn">移除底圖</button>
                    <button type="button" class="ft-crop-btn" id="ftCropFullscreenBtn">切換全螢幕</button>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <button type="button" class="ft-crop-btn" id="ftCropResetBtn">重整</button>
                    <button type="button" class="ft-crop-btn" id="ftCropCancelBtn">取消</button>
                    <button type="button" class="ft-crop-btn ft-crop-btn--primary" id="ftCropConfirmBtn">確認</button>
                </div>
            </div>
            <div class="ft-crop-stage-wrap">
                <div class="ft-crop-canvas" id="ftCropCanvas" style="aspect-ratio:${activeOrientation === 'portrait' ? '9 / 16' : '16 / 9'};max-width:${activeOrientation === 'portrait' ? '420px' : '960px'};">
                    <img class="ft-crop-bg-img ${ftCropBgDataUrl ? '' : 'hidden'}" id="ftCropBgImg" alt="" ${ftCropBgDataUrl ? `src="${ftCropBgDataUrl}"` : ''}>
                    <div class="ft-crop-box" id="ftCropBox">
                        <div class="ft-crop-box-label" id="ftCropBoxLabel"></div>
                        <div class="ft-crop-handle" data-dir="nw"></div>
                        <div class="ft-crop-handle" data-dir="n"></div>
                        <div class="ft-crop-handle" data-dir="ne"></div>
                        <div class="ft-crop-handle" data-dir="e"></div>
                        <div class="ft-crop-handle" data-dir="se"></div>
                        <div class="ft-crop-handle" data-dir="s"></div>
                        <div class="ft-crop-handle" data-dir="sw"></div>
                        <div class="ft-crop-handle" data-dir="w"></div>
                    </div>
                </div>
            </div>
            <div style="text-align:center;font-size:11px;color:#cbd5e1;flex-shrink:0;">
                可切換「直立 9:16」與「橫向 16:9」分別設定互不干擾的字幕偵測位置。
            </div>
        `;
        document.body.appendChild(modal);
        ftVisualCropModalEl = modal;

        const canvas = modal.querySelector('#ftCropCanvas');
        const box = modal.querySelector('#ftCropBox');
        const label = modal.querySelector('#ftCropBoxLabel');
        const bgImg = modal.querySelector('#ftCropBgImg');
        const fileInp = modal.querySelector('#ftCropFileInput');
        const grabBtn = modal.querySelector('#ftCropGrabScreenBtn');
        const clearBtn = modal.querySelector('#ftCropClearImgBtn');
        const fsBtn = modal.querySelector('#ftCropFullscreenBtn');
        const resetBtn = modal.querySelector('#ftCropResetBtn');
        const cancelBtn = modal.querySelector('#ftCropCancelBtn');
        const confirmBtn = modal.querySelector('#ftCropConfirmBtn');
        const portraitOrientBtn = modal.querySelector('#ftCropOrientPortraitBtn');
        const landscapeOrientBtn = modal.querySelector('#ftCropOrientLandscapeBtn');

        const syncOrientUi = () => {
            if (canvas) {
                canvas.style.aspectRatio = activeOrientation === 'portrait' ? '9 / 16' : '16 / 9';
                canvas.style.maxWidth = activeOrientation === 'portrait' ? '420px' : '960px';
            }
            if (portraitOrientBtn) {
                portraitOrientBtn.style.background = activeOrientation === 'portrait' ? '#4f46e5' : 'rgba(30, 41, 59, 0.95)';
                portraitOrientBtn.style.borderColor = activeOrientation === 'portrait' ? '#6366f1' : 'rgba(148, 163, 184, 0.35)';
            }
            if (landscapeOrientBtn) {
                landscapeOrientBtn.style.background = activeOrientation === 'landscape' ? '#4f46e5' : 'rgba(30, 41, 59, 0.95)';
                landscapeOrientBtn.style.borderColor = activeOrientation === 'landscape' ? '#6366f1' : 'rgba(148, 163, 184, 0.35)';
            }
        };

        const renderBox = () => {
            const xPct = Math.round(draft.xPct * 100);
            const yPct = Math.round(draft.yPct * 100);
            const wPct = Math.round(draft.wPct * 100);
            const hPct = Math.round(draft.hPct * 100);
            box.style.left = `${draft.xPct * 100}%`;
            box.style.top = `${draft.yPct * 100}%`;
            box.style.width = `${draft.wPct * 100}%`;
            box.style.height = `${draft.hPct * 100}%`;
            if (label) label.textContent = `${activeOrientation === 'portrait' ? '直立' : '橫向'} X:${xPct}% Y:${yPct}% W:${wPct}% H:${hPct}%`;
            if (activeOrientation === 'portrait') {
                draftPortrait = { ...draft };
            } else {
                draftLandscape = { ...draft };
            }
        };

        if (portraitOrientBtn) {
            portraitOrientBtn.onclick = () => {
                draftLandscape = normalizeRoiDraftRect(activeOrientation === 'landscape' ? draft : draftLandscape);
                activeOrientation = 'portrait';
                draft = { ...draftPortrait };
                syncOrientUi();
                renderBox();
            };
        }
        if (landscapeOrientBtn) {
            landscapeOrientBtn.onclick = () => {
                draftPortrait = normalizeRoiDraftRect(activeOrientation === 'portrait' ? draft : draftPortrait);
                activeOrientation = 'landscape';
                draft = { ...draftLandscape };
                syncOrientUi();
                renderBox();
            };
        }

        const cleanupModal = () => {
            if (document.fullscreenElement === modal && typeof document.exitFullscreen === 'function') {
                document.exitFullscreen().catch(() => {});
            }
            if (cropFs && !prevElectronFs && hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.setFullscreenViewer === 'function') {
                global.LZHDesktopWidget.setFullscreenViewer(false).catch(() => {});
            }
            modal.remove();
            if (ftVisualCropModalEl === modal) ftVisualCropModalEl = null;
        };

        if (fileInp) {
            fileInp.onchange = () => {
                const f = fileInp.files && fileInp.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    ftCropBgDataUrl = String(reader.result || '');
                    if (bgImg && ftCropBgDataUrl) {
                        bgImg.src = ftCropBgDataUrl;
                        bgImg.classList.remove('hidden');
                    }
                };
                reader.readAsDataURL(f);
                fileInp.value = '';
            };
        }

        if (grabBtn) {
            grabBtn.onclick = async () => {
                grabBtn.disabled = true;
                const origTxt = grabBtn.textContent;
                grabBtn.textContent = '擷取中...';
                try {
                    const dataUrl = await captureSingleFrameDataUrlForCropper();
                    ftCropBgDataUrl = dataUrl;
                    if (bgImg) {
                        bgImg.src = dataUrl;
                        bgImg.classList.remove('hidden');
                    }
                    toast('已擷取畫面作為定位底圖', 'success');
                } catch (err) {
                    toast((err && err.message) ? err.message : '擷取畫面失敗', 'warning');
                } finally {
                    grabBtn.disabled = false;
                    grabBtn.textContent = origTxt;
                }
            };
        }

        if (clearBtn) {
            clearBtn.onclick = () => {
                ftCropBgDataUrl = '';
                if (bgImg) {
                    bgImg.removeAttribute('src');
                    bgImg.classList.add('hidden');
                }
            };
        }

        if (fsBtn) {
            fsBtn.onclick = () => {
                cropFs = !cropFs;
                modal.classList.toggle('ft-crop-fs', cropFs);
                if (hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.setFullscreenViewer === 'function') {
                    global.LZHDesktopWidget.setFullscreenViewer(cropFs || prevElectronFs).catch(() => {});
                } else if (cropFs && typeof modal.requestFullscreen === 'function') {
                    modal.requestFullscreen().catch(() => {});
                } else if (!cropFs && document.fullscreenElement === modal && typeof document.exitFullscreen === 'function') {
                    document.exitFullscreen().catch(() => {});
                }
            };
        }

        if (resetBtn) {
            resetBtn.onclick = () => {
                draft = activeOrientation === 'portrait'
                    ? { xPct: 0.08, yPct: 0.70, wPct: 0.84, hPct: 0.22 }
                    : { xPct: 0.12, yPct: 0.74, wPct: 0.76, hPct: 0.20 };
                renderBox();
            };
        }

        if (cancelBtn) {
            cancelBtn.onclick = () => {
                cleanupModal();
                if (typeof options.onCancel === 'function') options.onCancel();
            };
        }

        if (confirmBtn) {
            confirmBtn.onclick = () => {
                const confirmedPortrait = normalizeRoiDraftRect(activeOrientation === 'portrait' ? draft : draftPortrait);
                const confirmedLandscape = normalizeRoiDraftRect(activeOrientation === 'landscape' ? draft : draftLandscape);
                const confirmed = activeOrientation === 'portrait' ? confirmedPortrait : confirmedLandscape;
                cleanupModal();
                if (typeof options.onConfirm === 'function') {
                    options.onConfirm(confirmed, {
                        orientation: activeOrientation,
                        portraitRect: confirmedPortrait,
                        landscapeRect: confirmedLandscape
                    });
                }
            };
        }

        let dragOp = null;
        canvas.addEventListener('pointerdown', (e) => {
            const handleEl = e.target.closest('.ft-crop-handle');
            const isBox = handleEl || e.target === box || e.target.closest('#ftCropBox');
            if (!isBox) return;
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            dragOp = {
                dir: handleEl ? handleEl.getAttribute('data-dir') : 'move',
                startX: e.clientX,
                startY: e.clientY,
                cw: rect.width,
                ch: rect.height,
                orig: { ...draft },
                pointerId: e.pointerId
            };
            try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!dragOp) return;
            e.preventDefault();
            const dx = (e.clientX - dragOp.startX) / dragOp.cw;
            const dy = (e.clientY - dragOp.startY) / dragOp.ch;
            const minW = Math.max(0.08, 48 / dragOp.cw);
            const minH = Math.max(0.06, 48 / dragOp.ch);
            let { xPct, yPct, wPct, hPct } = dragOp.orig;
            const dir = dragOp.dir;

            if (dir === 'move') {
                xPct = clamp(xPct + dx, 0, 1 - wPct);
                yPct = clamp(yPct + dy, 0, 1 - hPct);
            } else {
                if (dir.includes('w')) {
                    const shift = Math.max(-xPct, Math.min(wPct - minW, dx));
                    xPct += shift;
                    wPct -= shift;
                }
                if (dir.includes('e')) {
                    wPct = clamp(wPct + dx, minW, 1 - xPct);
                }
                if (dir.includes('n')) {
                    const shift = Math.max(-yPct, Math.min(hPct - minH, dy));
                    yPct += shift;
                    hPct -= shift;
                }
                if (dir.includes('s')) {
                    hPct = clamp(hPct + dy, minH, 1 - yPct);
                }
            }
            draft = normalizeRoiDraftRect({ xPct, yPct, wPct, hPct });
            renderBox();
        });

        const endDrag = () => {
            if (!dragOp) return;
            try { canvas.releasePointerCapture(dragOp.pointerId); } catch (err) {}
            dragOp = null;
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        renderBox();
    }

    function detectAutoSubtitleRoiRect(sourceEl, srcW, srcH) {
        const scanW = 160;
        const scanH = 90;
        const c = document.createElement('canvas');
        c.width = scanW;
        c.height = scanH;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(sourceEl, 0, 0, scanW, scanH);
        const data = ctx.getImageData(0, 0, scanW, scanH).data;

        const rowScore = new Float32Array(scanH);
        for (let y = 0; y < scanH; y++) {
            let energy = 0;
            let prevL = 0;
            const rowOffset = y * scanW * 4;
            for (let x = 0; x < scanW; x++) {
                const p = rowOffset + x * 4;
                const l = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
                if (x > 0) energy += Math.abs(l - prevL);
                prevL = l;
            }
            const yNorm = y / scanH;
            // 字幕通常出現在底部 65%-95% 或頂部 5%-28%
            const regionWeight = (yNorm >= 0.65 && yNorm <= 0.96) ? 1.45 : ((yNorm >= 0.04 && yNorm <= 0.28) ? 1.15 : 0.7);
            rowScore[y] = (energy / scanW) * regionWeight;
        }

        const winH = Math.max(18, Math.round(scanH * 0.24));
        let bestY = Math.round(scanH * 0.72);
        let bestEnergy = -1;
        for (let start = 0; start <= scanH - winH; start += 2) {
            let sum = 0;
            for (let r = start; r < start + winH; r++) sum += rowScore[r];
            if (sum > bestEnergy) {
                bestEnergy = sum;
                bestY = start;
            }
        }
        if (bestEnergy < 8 * winH) {
            const sx = Math.round(srcW * 0.12);
            const sy = Math.round(srcH * 0.75);
            const sw = Math.max(24, Math.round(srcW * 0.76));
            const sh = Math.max(20, Math.round(srcH * 0.18));
            return { sx, sy, sw, sh };
        }
        const sx = Math.round(srcW * 0.08);
        const sw = Math.max(24, Math.round(srcW * 0.84));
        const sy = Math.max(0, Math.round((bestY / scanH) * srcH));
        const sh = Math.max(20, Math.min(srcH - sy, Math.round((winH / scanH) * srcH)));
        return { sx, sy, sw, sh };
    }

    function resolveStrictCropRect(sourceEl, srcW, srcH, roiMode) {
        const isPortraitFrame = Number(srcH) > Number(srcW);
        const effectiveMode = (roiMode === 'custom' || (isPortraitFrame ? videoRoiDualCfg.portraitMode : videoRoiDualCfg.landscapeMode) === 'custom')
            ? 'custom'
            : (roiMode || (isPortraitFrame ? videoRoiDualCfg.portraitMode : videoRoiDualCfg.landscapeMode));
        if (effectiveMode === 'bottom40') {
            return {
                sx: Math.round(srcW * 0.08),
                sy: Math.round(srcH * 0.58),
                sw: Math.max(24, Math.round(srcW * 0.84)),
                sh: Math.max(20, Math.round(srcH * 0.36))
            };
        }
        if (effectiveMode === 'top25') {
            return {
                sx: Math.round(srcW * 0.12),
                sy: Math.round(srcH * 0.04),
                sw: Math.max(24, Math.round(srcW * 0.76)),
                sh: Math.max(20, Math.round(srcH * 0.22))
            };
        }
        if (effectiveMode === 'auto') {
            return detectAutoSubtitleRoiRect(sourceEl, srcW, srcH);
        }
        if (effectiveMode === 'custom') {
            const customSrc = isPortraitFrame
                ? (videoRoiDualCfg.portraitRect || videoRoiCustomRect)
                : (videoRoiDualCfg.landscapeRect || videoRoiCustomRect);
            const xPct = clamp(Number(customSrc.xPct ?? 0.12), 0, 0.90);
            const yPct = clamp(Number(customSrc.yPct ?? 0.75), 0, 0.90);
            const wPct = clamp(Number(customSrc.wPct ?? 0.76), 0.10, 1 - xPct);
            const hPct = clamp(Number(customSrc.hPct ?? 0.18), 0.08, 1 - yPct);
            return {
                sx: Math.round(srcW * xPct),
                sy: Math.round(srcH * yPct),
                sw: Math.max(24, Math.round(srcW * wPct)),
                sh: Math.max(20, Math.round(srcH * hPct))
            };
        }
        // 預設強制裁切底部字幕安全帶 (x: 0.12, y: 0.75, width: 0.76, height: 0.18)，嚴禁將全螢幕直接送入 OCR
        return {
            sx: Math.round(srcW * 0.12),
            sy: Math.round(srcH * 0.75),
            sw: Math.max(24, Math.round(srcW * 0.76)),
            sh: Math.max(20, Math.round(srcH * 0.18))
        };
    }

    function maskSubtitleOverlayOnCanvas(ocrCtx, ocrW, ocrH, cropSx, cropSy, cropSw, cropSh, srcW, srcH) {
        if (hasElectronWidgetBridge() || !subtitleOverlayEl || subtitleOverlayEl.classList.contains('hidden')) {
            return;
        }
        try {
            const subRect = subtitleOverlayEl.getBoundingClientRect();
            if (!subRect || subRect.width <= 0 || subRect.height <= 0) return;
            const vw = Math.max(1, global.innerWidth || document.documentElement.clientWidth || 1);
            const vh = Math.max(1, global.innerHeight || document.documentElement.clientHeight || 1);

            const subX0 = (subRect.left / vw) * srcW;
            const subY0 = (subRect.top / vh) * srcH;
            const subX1 = ((subRect.left + subRect.width) / vw) * srcW;
            const subY1 = ((subRect.top + subRect.height) / vh) * srcH;

            const interX0 = Math.max(cropSx, subX0);
            const interY0 = Math.max(cropSy, subY0);
            const interX1 = Math.min(cropSx + cropSw, subX1);
            const interY1 = Math.min(cropSy + cropSh, subY1);
            if (interX1 <= interX0 || interY1 <= interY0) return;

            const mx = Math.floor(((interX0 - cropSx) / cropSw) * ocrW);
            const my = Math.floor(((interY0 - cropSy) / cropSh) * ocrH);
            const mw = Math.ceil(((interX1 - interX0) / cropSw) * ocrW);
            const mh = Math.ceil(((interY1 - interY0) / cropSh) * ocrH);
            ocrCtx.fillStyle = '#000000';
            ocrCtx.fillRect(Math.max(0, mx), Math.max(0, my), Math.min(ocrW, mw), Math.min(ocrH, mh));
        } catch (e) {}
    }

    function extractRoiCanvasAndLuma(sourceEl, srcW, srcH, roiMode) {
        const { sx, sy, sw, sh } = resolveStrictCropRect(sourceEl, srcW, srcH, roiMode);

        // 用於 OCR 的高清晰裁切畫布
        const maxOcrW = 960;
        const scale = Math.min(1, maxOcrW / sw);
        const ocrW = Math.max(32, Math.round(sw * scale));
        const ocrH = Math.max(24, Math.round(sh * scale));

        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = ocrW;
        ocrCanvas.height = ocrH;
        const ocrCtx = ocrCanvas.getContext('2d');
        ocrCtx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, ocrW, ocrH);

        // 網頁／行動端截圖：若懸浮字幕條與裁切區重疊，先塗黑消除循環辨識雜訊
        maskSubtitleOverlayOnCanvas(ocrCtx, ocrW, ocrH, sx, sy, sw, sh, srcW, srcH);

        // 縮採樣亮度矩陣做幀差偵測（極低耗能）
        const sampleW = 160;
        const sampleH = 48;
        const diffCanvas = document.createElement('canvas');
        diffCanvas.width = sampleW;
        diffCanvas.height = sampleH;
        const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
        diffCtx.drawImage(ocrCanvas, 0, 0, sampleW, sampleH);
        const pixels = diffCtx.getImageData(0, 0, sampleW, sampleH).data;
        const luma = new Uint8Array(sampleW * sampleH);
        for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
            luma[i] = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
        }

        return { ocrCanvas, luma };
    }

    async function processRoiImageForSubtitle(base64Jpeg, ocrCanvasRef = null) {
        if (videoOcrInFlight) return;
        videoOcrInFlight = true;
        try {
            const nativeCfg = getNativeLangConfig(targetNativeLang);
            const lockedLang = videoSourceLang || 'en';
            const tessLang = mapSourceLangToTesseract(lockedLang);
            const canCloudVision = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
                ? global.MembershipEngine.canConsumeAiQuota('vision_ocr').allowed
                : true;

            let orig = '';
            let trans = '';
            let lang = lockedLang;

            if (canCloudVision && typeof global.callGeminiApi === 'function') {
                const prompt = `請擷取這張畫面裁切區域中語系為「${lockedLang}」的最顯著字幕原文，並自然地翻譯為「${nativeCfg.aiName}」。
規則：
1. 自動忽略句首或句尾殘留的 OCR 雜訊或無意義符號（如 \`| ar Ss = 5\`），只針對語意連貫的句子進行翻譯。
2. 若畫面完全沒有有效字幕或只有雜訊／介面圖示，請回傳 {"original":"","translation":"","lang":""}。
3. 遇到口語慣用語或俚語時，請依語境自然意譯，切勿死板逐字直譯（例如 "new whip" 譯為「新車／座駕」）。
只輸出純 JSON 物件：{"original":"","translation":"","lang":"en|ja|ko|zh-TW"}`;

                try {
                    const raw = await global.callGeminiApi(prompt, {
                        silent: true,
                        feature: 'vision_ocr',
                        inlineData: { mimeType: 'image/jpeg', data: base64Jpeg }
                    });
                    const parsed = (typeof global.safeParseJSON === 'function')
                        ? global.safeParseJSON(raw)
                        : JSON.parse(raw);

                    orig = filterOcrNoiseText((parsed && parsed.original) || '', lockedLang);
                    trans = String((parsed && parsed.translation) || '').trim();
                    lang = (parsed && parsed.lang) || lockedLang;
                } catch (cloudErr) {
                    if (cloudErr && cloudErr.code !== 'QUOTA_EXCEEDED') throw cloudErr;
                }
            }

            if (!orig && ocrCanvasRef) {
                const Tesseract = await loadLocalTesseractEngine();
                const res = await Tesseract.recognize(ocrCanvasRef, tessLang);
                const filtered = filterOcrResultWordsAndText(res, lockedLang, 65);
                orig = filtered.text;
                if (orig) {
                    lang = lockedLang;
                    const canCloudDefFallback = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
                        ? global.MembershipEngine.canConsumeAiQuota('def_fill').allowed
                        : false;
                    if (typeof global.callGeminiApi === 'function' && canCloudDefFallback) {
                        try {
                            trans = String(await global.callGeminiApi(
                                `將以下 OCR 辨識出的字幕翻譯為自然道地的「${nativeCfg.aiName}」。自動忽略句首或句尾殘留的亂碼符號（如 | ar Ss = 5），遇到俚語依語境自然意譯（如 new whip -> 新車／座駕），僅輸出最終譯文：\n${orig}`,
                                { silent: true, feature: 'def_fill' }
                            ) || '').trim();
                        } catch (e) {}
                    }
                    if (!trans) {
                        trans = await fetchGoogleTranslateFallback(orig, lang, nativeCfg.code).catch(() => '');
                    }
                }
            }

            if (!orig || orig === videoLastOriginalText) return;
            videoLastOriginalText = orig;
            pushSubtitleEntry(orig, trans, lang, canCloudVision ? 'refined' : 'draft');
        } catch (err) {
            console.warn('[FloatingTranslator] Video subtitle OCR skipped:', err);
        } finally {
            videoOcrInFlight = false;
        }
    }

    async function sampleVideoSourceAndDetectDiff(sourceEl, srcW, srcH) {
        if (!sourceEl || !srcW || !srcH) return;
        const { ocrCanvas, luma } = extractRoiCanvasAndLuma(sourceEl, srcW, srcH, videoRoiMode);
        const diffRatio = computeFrameDiffRatio(videoLastFrameLuma, luma, 24);
        const now = Date.now();

        // 250ms 高頻取樣幀差；僅在差異 >= 4.5% 且雲端 OCR 冷卻滿 1400ms 時才發動辨識
        if (videoLastFrameLuma === null || (diffRatio >= 0.045 && now - videoLastOcrAt >= 1400 && !videoOcrInFlight)) {
            videoLastFrameLuma = luma;
            videoLastOcrAt = now;
            const jpegDataUrl = ocrCanvas.toDataURL('image/jpeg', 0.85);
            const b64 = jpegDataUrl.split(',')[1] || '';
            if (b64) await processRoiImageForSubtitle(b64, ocrCanvas);
        }
    }

    async function startScreenVideoSubtitleMonitor() {
        stopVoiceRecognitionMode();
        stopVideoSubtitleMonitor();
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
            // 若為網頁內嵌 <video>，降級追蹤頁面上正在播放的第一個 <video>
            const pageVideo = Array.from(document.querySelectorAll('video')).find(v => !v.paused && v.videoWidth > 0 && v.id !== 'ftCameraVideo');
            if (!pageVideo) {
                activeLiveMode = 'none';
                toast('此裝置不支援螢幕擷取，可改用頁面 <video> 或 Android 原生截圖橋接', 'warning');
                renderActiveTabBody();
                return;
            }
            videoSourceElement = pageVideo;
        } else {
            try {
                const isDesktopWidget = hasElectronWidgetBridge();
                const displayConstraints = isDesktopWidget
                    ? { video: true, audio: false }
                    : {
                        video: { frameRate: { ideal: 15, max: 20 } },
                        audio: false
                    };
                videoCaptureStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
                const hiddenVid = document.createElement('video');
                hiddenVid.muted = true;
                hiddenVid.playsInline = true;
                hiddenVid.dataset.ftTemp = 'true';
                hiddenVid.srcObject = videoCaptureStream;
                await hiddenVid.play();
                videoSourceElement = hiddenVid;

                const vTrack = videoCaptureStream.getVideoTracks()[0];
                if (vTrack) {
                    vTrack.addEventListener('ended', () => {
                        stopScreenSubtitleMode();
                        renderActiveTabBody();
                    });
                }
            } catch (err) {
                const isDesktopWidget = hasElectronWidgetBridge();
                const errName = (err && err.name) ? String(err.name) : 'UnknownError';
                const errMessage = (err && err.message) ? String(err.message) : String(err || '未知錯誤');
                stopScreenSubtitleMode();
                if (!isDesktopWidget && (errName === 'NotAllowedError' || errName === 'AbortError')) {
                    toast('已取消螢幕畫面擷取', 'info');
                } else {
                    console.error('[FloatingTranslator] getDisplayMedia failed:', {
                        desktopWidget: isDesktopWidget,
                        name: errName,
                        message: errMessage,
                        err
                    });
                    toast(`螢幕畫面擷取失敗 (${errName}: ${errMessage})`, 'error');
                }
                renderActiveTabBody();
                return;
            }
        }

        activeLiveMode = 'screen';
        videoLastFrameLuma = null;
        videoLastOriginalText = '';
        videoMonitorTimer = setInterval(() => {
            if (!videoSourceElement) return;
            const vw = videoSourceElement.videoWidth || 0;
            const vh = videoSourceElement.videoHeight || 0;
            if (vw > 0 && vh > 0) {
                sampleVideoSourceAndDetectDiff(videoSourceElement, vw, vh);
            }
        }, 250);

        renderSubtitleOverlay();
        renderActiveTabBody();
        toast('已啟動 250ms 即時字幕偵測（僅在字幕變動時觸發辨識）', 'success');
    }

    async function callFastRefineSubtitleApi(text, draftTranslation, sourceLang, nativeCfg, contextLines) {
        const payload = {
            text,
            draftTranslation: draftTranslation || '',
            sourceLang: sourceLang || 'auto',
            targetLang: nativeCfg.code,
            targetLangName: nativeCfg.aiName,
            contextLines: Array.isArray(contextLines) ? contextLines : []
        };
        if (typeof global.requestFastRefineWithAuth === 'function') {
            return await global.requestFastRefineWithAuth(payload);
        }
        const headers = { 'Content-Type': 'application/json' };
        try {
            const u = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
            if (u && !u.isAnonymous && typeof u.getIdToken === 'function') {
                headers['Authorization'] = 'Bearer ' + (await u.getIdToken(false));
            }
        } catch (e) {}
        const resp = await fetch(`${SHARED_WORKER_BASE}/ai/fast-refine`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        if (resp.status === 429) {
            const err = new Error('QUOTA_EXCEEDED');
            err.code = 'QUOTA_EXCEEDED';
            throw err;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return String((data && data.translation) || '').trim();
    }

    const SUB_STOPWORDS = new Set([
        'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'for', 'with',
        'is', 'are', 'was', 'were', 'am', 'be', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
        'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'の', 'も', 'や',
        '的', '了', '是', '在', '和', '與', '也', '就', '都'
    ]);

    function clearSttStabilizerTimers() {
        if (sttStopwordTimer) {
            clearTimeout(sttStopwordTimer);
            sttStopwordTimer = null;
        }
        if (sttInactivityTimer) {
            clearTimeout(sttInactivityTimer);
            sttInactivityTimer = null;
        }
    }

    function isLikelyTrailingStopwordOnly(text) {
        const clean = String(text || '').trim().toLowerCase();
        if (!clean) return false;
        const parts = clean.split(/\s+/);
        if (parts.length === 1 && SUB_STOPWORDS.has(parts[0])) return true;
        if (clean.length <= 2 && SUB_STOPWORDS.has(clean)) return true;
        return false;
    }

    function lookupOfflineSubtitleDraft(text, lang) {
        const clean = String(text || '').trim();
        if (!clean) return '';
        const localHit = lookupWordInLocalWordList(clean, lang);
        if (localHit && localHit.meaning) return localHit.meaning;
        const normKey = normalizeWordKey(clean, lang);
        const nativeCfg = getNativeLangConfig(targetNativeLang);
        const cacheKey = `${lang}::${nativeCfg.code}::${normKey}`;
        if (idbDictCache && idbDictCache[cacheKey] && idbDictCache[cacheKey].meaning) {
            return idbDictCache[cacheKey].meaning;
        }
        const sess = readSessionEntry(cacheKey);
        if (sess && sess.meaning) return sess.meaning;
        return '';
    }

    function pushSubtitleEntry(orig, trans, langHint, tier = 'refined', provisional = false) {
        const cleanOrig = String(orig || '').trim();
        if (!cleanOrig) return null;
        const detected = detectScriptLang(cleanOrig, langHint);
        const entry = {
            id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            orig: cleanOrig,
            trans: String(trans || '').trim(),
            lang: detected,
            tier,
            provisional: Boolean(provisional)
        };
        subtitleFeed.unshift(entry);
        if (subtitleFeed.length > 40) subtitleFeed.length = 40;
        renderSubtitleOverlay();
        if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
        return entry;
    }

    // Layer 1: 同句前綴演進直接覆寫進行中的暫定卡，消除逐字刷屏重複卡
    function upsertProvisionalSubtitle(orig, draft, langHint) {
        const cleanOrig = String(orig || '').trim();
        if (!cleanOrig) return null;
        const top = subtitleFeed[0];
        if (top && top.id === sttProvisionalEntryId && top.provisional) {
            top.orig = cleanOrig;
            if (draft) top.trans = String(draft).trim();
            top.tier = 'draft';
            top.ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            renderSubtitleOverlay();
            if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            return top;
        }
        const created = pushSubtitleEntry(cleanOrig, draft || '', langHint, 'draft', true);
        if (created) sttProvisionalEntryId = created.id;
        return created;
    }

    async function translateTranscriptText(text, langHint) {
        const clean = String(text || '').trim();
        if (!clean) return;
        const detected = detectScriptLang(clean, langHint);
        const nativeCfg = getNativeLangConfig(targetNativeLang);

        if (detected === nativeCfg.code) {
            if (subtitleFeed[0] && subtitleFeed[0].id === sttProvisionalEntryId && subtitleFeed[0].provisional) {
                subtitleFeed[0].orig = clean;
                subtitleFeed[0].trans = '';
                subtitleFeed[0].tier = 'native';
                subtitleFeed[0].provisional = false;
                sttProvisionalEntryId = '';
                renderSubtitleOverlay();
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            } else {
                pushSubtitleEntry(clean, '', detected, 'native', false);
            }
            return;
        }

        // Layer 1 + Layer 3: 優先複用進行中的暫定卡與離線單字本查義，無重複插卡
        const contextLines = subtitleFeed.slice(1, 4).map(it => it.orig).reverse();
        let entry = null;
        if (subtitleFeed[0] && subtitleFeed[0].id === sttProvisionalEntryId && subtitleFeed[0].provisional) {
            entry = subtitleFeed[0];
            entry.orig = clean;
            entry.provisional = false;
        } else {
            entry = pushSubtitleEntry(clean, '', detected, 'draft', false);
        }
        sttProvisionalEntryId = '';
        sttLastProvisionalText = '';

        let draft = lookupOfflineSubtitleDraft(clean, detected);
        if (draft && entry) {
            entry.trans = draft;
            entry.tier = 'draft';
            renderSubtitleOverlay();
            if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
        }
        try {
            const gtxDraft = await fetchGoogleTranslateFallback(clean, detected, nativeCfg.code);
            if (gtxDraft && entry) {
                draft = gtxDraft;
                entry.trans = draft;
                entry.tier = 'draft';
                renderSubtitleOverlay();
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            }
        } catch (e) {}

        const quotaAllowsRefine = !ftFastRefineExhausted && (
            (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
                ? global.MembershipEngine.canConsumeAiQuota('fast_refine').allowed
                : true
        );

        if (!quotaAllowsRefine) return;

        // Layer 4: /ai/fast-refine 節流派送並原地升級既定字幕卡
        const now = Date.now();
        if (now - sttLastRefineDispatchAt < 350) {
            await new Promise(r => setTimeout(r, 350));
        }
        sttLastRefineDispatchAt = Date.now();

        try {
            const refined = await callFastRefineSubtitleApi(clean, draft, detected, nativeCfg, contextLines);
            if (refined && entry) {
                entry.trans = refined;
                entry.tier = 'refined';
                renderSubtitleOverlay();
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            }
        } catch (e) {
            if (e && e.code === 'QUOTA_EXCEEDED') {
                ftFastRefineExhausted = true;
                return;
            }
            if (!draft && typeof global.callGeminiApi === 'function' && entry) {
                try {
                    const fallback = String(await global.callGeminiApi(`將以下口語／字幕自然翻譯成「${nativeCfg.aiName}」。自動忽略句首或句尾殘留的 OCR 亂碼符號（如 | ar Ss = 5），遇到俚語依語境自然意譯（如 new whip -> 新車／座駕），僅回傳譯文：\n${clean}`, { silent: true, feature: 'def_fill' }) || '').trim();
                    if (fallback) {
                        entry.trans = fallback;
                        entry.tier = 'refined';
                        renderSubtitleOverlay();
                        if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
                    }
                } catch (e2) {}
            }
        }
    }

    function stopYoutubeTimelinePlayback() {
        ytPlaying = false;
        if (ytTickTimer) {
            clearInterval(ytTickTimer);
            ytTickTimer = null;
        }
    }

    function formatMsToClock(ms) {
        const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function getCurrentYoutubeCue(timeMs) {
        if (!ytCues.length) return { idx: -1, cue: null };
        const effectiveMs = Math.max(0, timeMs + ytOffsetMs);
        for (let i = 0; i < ytCues.length; i++) {
            const c = ytCues[i];
            if (effectiveMs >= c.startMs && effectiveMs <= c.endMs) {
                return { idx: i, cue: c };
            }
        }
        return { idx: -1, cue: null };
    }

    function startYoutubeTimelinePlayback() {
        if (!ytCues.length) {
            toast('請先載入影片字幕時間軸', 'warning');
            return;
        }
        stopYoutubeTimelinePlayback();
        ytPlaying = true;
        ytLastTickAt = Date.now();
        subtitlePinnedOverlay = true;
        ytTickTimer = setInterval(() => {
            if (!ytPlaying) return;
            const now = Date.now();
            const delta = Math.max(0, now - ytLastTickAt) * ytPlaybackRate;
            ytLastTickAt = now;
            ytCurrentMs += delta;
            const maxEnd = ytCues[ytCues.length - 1].endMs + 1000;
            if (ytCurrentMs > maxEnd) {
                stopYoutubeTimelinePlayback();
                renderSubtitleOverlay();
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
                return;
            }
            const { idx, cue } = getCurrentYoutubeCue(ytCurrentMs);
            if (idx !== ytActiveCueIdx) {
                ytActiveCueIdx = idx;
                if (cue && cue.text) {
                    const top = subtitleFeed[0];
                    if (!top || top.orig !== cue.text) {
                        subtitleFeed.unshift({
                            id: 'yt_' + idx + '_' + Date.now(),
                            ts: formatMsToClock(cue.startMs),
                            orig: cue.text,
                            trans: cue.trans || '',
                            lang: detectScriptLang(cue.text, ytLanguageCode),
                            tier: 'youtube'
                        });
                        if (subtitleFeed.length > 40) subtitleFeed.length = 40;
                    }
                }
                renderSubtitleOverlay();
            }
            const clockEl = q('ftYtClockText');
            if (clockEl) clockEl.textContent = formatMsToClock(ytCurrentMs);
            const rangeEl = q('ftYtScrubRange');
            if (rangeEl) rangeEl.value = String(Math.round(ytCurrentMs));
        }, 120);
        renderSubtitleOverlay();
        renderActiveTabBody();
    }

    async function loadYoutubeSubtitleTimeline(urlStr) {
        const cleanUrl = String(urlStr || '').trim();
        if (!cleanUrl) {
            toast('請貼上影片連結（支援 YouTube / Bilibili / Vimeo / Dailymotion / Niconico / Twitch）', 'warning');
            return;
        }
        ytUrlInput = cleanUrl;
        ytLoading = true;
        ytFallbackSuggested = false;
        ytSuggestedModes = [];
        ytStatusText = '正在抓取並解析多平台影片字幕時間軸...';
        stopYoutubeTimelinePlayback();
        renderActiveTabBody();

        const nativeCfg = getNativeLangConfig(targetNativeLang);
        try {
            const resp = await fetch(`${SHARED_WORKER_BASE}/youtube/subtitles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: cleanUrl, lang: nativeCfg.code })
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data || !data.ok || !Array.isArray(data.cues) || !data.cues.length) {
                if (resp.status === 404 || (data && data.fallbackSuggested)) {
                    ytFallbackSuggested = true;
                    ytSuggestedModes = (data && Array.isArray(data.suggestedModes) && data.suggestedModes.length)
                        ? data.suggestedModes
                        : ['video', 'stt'];
                }
                throw new Error((data && data.error) || '此影片暫無可解析之內嵌字幕軌');
            }

            ytVideoId = data.videoId || '';
            ytTitle = data.title || `${data.platform || 'Video'} (${ytVideoId})`;
            ytLanguageCode = data.languageCode || 'en';
            ytCues = data.cues.map(c => ({
                startMs: Number(c.startMs) || 0,
                endMs: Number(c.endMs) || 0,
                text: String(c.text || '').trim(),
                trans: ''
            })).filter(c => c.text);
            ytCurrentMs = 0;
            ytActiveCueIdx = -1;

            ytStatusText = `已載入 ${ytCues.length} 句字幕，正在預譯雙語時間軸...`;
            renderActiveTabBody();

            // 平行批次預譯所有時間軸字幕：付費／教師班級共享且尚有配額才使用 AI 整批翻譯，否則零成本平行走 GTX 直譯
            const batchSize = 18;
            const memSnap = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.getQuotaSnapshot === 'function')
                ? global.MembershipEngine.getQuotaSnapshot()
                : null;
            let allowBatchAi = Boolean(memSnap && (memSnap.isSupporter || memSnap.classSponsored) && (memSnap.isAdmin || memSnap.remainingDaily.def_fill > 0));
            for (let i = 0; i < ytCues.length; i += batchSize) {
                const slice = ytCues.slice(i, i + batchSize);
                const joined = slice.map((c, idx) => `${idx}: ${c.text}`).join('\n');
                let translatedLines = null;
                if (allowBatchAi && typeof global.callGeminiApi === 'function') {
                    try {
                        const prompt = `將以下帶編號的影片字幕逐句翻譯成「${nativeCfg.aiName}」，只輸出對應字串 JSON 陣列（長度固定為 ${slice.length}）：\n${joined}`;
                        const raw = await global.callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
                        const arr = (typeof global.safeParseJSON === 'function') ? global.safeParseJSON(raw) : JSON.parse(raw);
                        if (Array.isArray(arr) && arr.length === slice.length) {
                            translatedLines = arr;
                        }
                    } catch (e) {
                        if (e && e.code === 'QUOTA_EXCEEDED') allowBatchAi = false;
                    }
                }
                if (translatedLines) {
                    slice.forEach((c, idx) => { c.trans = String(translatedLines[idx] || '').trim(); });
                } else {
                    await Promise.all(slice.map(async (c) => {
                        try {
                            c.trans = await fetchGoogleTranslateFallback(c.text, detectScriptLang(c.text, ytLanguageCode), nativeCfg.code);
                        } catch (e) {}
                    }));
                }
                ytStatusText = `預譯進度 ${Math.min(i + batchSize, ytCues.length)} / ${ytCues.length} 句`;
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            }

            ytStatusText = `已完成 ${ytCues.length} 句預譯，點擊「開始 0ms 同步」即零延遲播放`;
            toast(`字幕時間軸預譯完成 (${ytCues.length} 句)`, 'success');
        } catch (err) {
            ytStatusText = (err && err.message ? err.message : '無法解析字幕');
            toast(ytStatusText, ytFallbackSuggested ? 'warning' : 'error');
        } finally {
            ytLoading = false;
            renderActiveTabBody();
        }
    }

    function stopMicFallbackStream() {
        if (sttMicChunkTimer) {
            clearInterval(sttMicChunkTimer);
            sttMicChunkTimer = null;
        }
        if (sttMicRecorder) {
            try {
                if (sttMicRecorder.state !== 'inactive') sttMicRecorder.stop();
            } catch (e) {}
            sttMicRecorder = null;
        }
        if (sttMicStream) {
            try {
                sttMicStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) {}
                });
            } catch (e) {}
            sttMicStream = null;
        }
    }

    function stopSttSubtitleEngine() {
        sttRunning = false;
        if (activeLiveMode === 'voice') {
            activeLiveMode = 'none';
        }
        sttInterimText = '';
        sttInterimDraft = '';
        sttProvisionalEntryId = '';
        sttLastProvisionalText = '';
        clearSttStabilizerTimers();
        if (speechRec) {
            try { speechRec.onend = null; speechRec.onerror = null; speechRec.stop(); } catch (e) {}
            speechRec = null;
        }
        if (sttChunkTimer) {
            clearInterval(sttChunkTimer);
            sttChunkTimer = null;
        }
        if (sttMediaRecorder) {
            try {
                if (sttMediaRecorder.state !== 'inactive') sttMediaRecorder.stop();
            } catch (e) {}
            sttMediaRecorder = null;
        }
        if (sttAudioCtx) {
            try { sttAudioCtx.close(); } catch (e) {}
            sttAudioCtx = null;
            sttAnalyser = null;
        }
        if (sttTabStream) {
            try {
                sttTabStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) {}
                });
            } catch (e) {}
            sttTabStream = null;
        }
        stopMicFallbackStream();
        renderSubtitleOverlay();
    }

    async function uploadMicBlobToWorkerStt(blob, langCode) {
        if (!blob || blob.size < 1000) return;
        const b64 = await new Promise(resolve => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
            fr.onerror = () => resolve('');
            fr.readAsDataURL(blob);
        });
        if (!b64) return;
        const headers = { 'Content-Type': 'application/json' };
        try {
            const u = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
            if (u && !u.isAnonymous && typeof u.getIdToken === 'function') {
                headers['Authorization'] = 'Bearer ' + (await u.getIdToken(false));
            }
        } catch (e) {}
        try {
            const resp = await fetch(`${SHARED_WORKER_BASE}/api/ai/stt`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    audioBase64: b64,
                    mimeType: blob.type || 'audio/webm',
                    language: langCode || 'en-US'
                })
            });
            if (!resp.ok) return;
            const data = await resp.json().catch(() => null);
            const txt = String((data && data.text) || '').trim();
            if (txt && sttRunning) {
                const langHint = String(langCode || '').startsWith('ja') ? 'ja' : (String(langCode || '').startsWith('zh') ? 'zh-TW' : 'en');
                await translateTranscriptText(txt, langHint);
            }
        } catch (e) {}
    }

    async function startMicMediaRecorderFallback(resolvedLang) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
            stopSttSubtitleEngine();
            renderActiveTabBody();
            toast('此環境不支援麥克風語音辨識或錄音串流', 'warning');
            return false;
        }
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            const audioTracks = stream.getAudioTracks();
            if (!audioTracks || audioTracks.length === 0) {
                throw new Error('NO_AUDIO_TRACK');
            }
            sttMicStream = stream;
            sttRunning = true;
            activeLiveMode = 'voice';
            subtitlePinnedOverlay = true;

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

            const recordNextSlice = () => {
                if (!sttRunning || !sttMicStream || !sttMicStream.active) return;
                const chunks = [];
                let rec;
                try {
                    rec = mimeType ? new MediaRecorder(sttMicStream, { mimeType }) : new MediaRecorder(sttMicStream);
                } catch (e) {
                    stopSttSubtitleEngine();
                    renderActiveTabBody();
                    return;
                }
                sttMicRecorder = rec;
                rec.ondataavailable = (ev) => {
                    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
                };
                rec.onstop = () => {
                    if (sttRunning && chunks.length > 0) {
                        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
                        uploadMicBlobToWorkerStt(blob, resolvedLang);
                    }
                    if (sttRunning) recordNextSlice();
                };
                rec.start();
                setTimeout(() => {
                    try {
                        if (rec.state !== 'inactive') rec.stop();
                    } catch (e) {}
                }, 3500);
            };

            recordNextSlice();
            renderSubtitleOverlay();
            renderActiveTabBody();
            toast('已啟用麥克風分段雲端語音字幕備援串流', 'success');
            return true;
        } catch (err) {
            if (stream) {
                try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
            }
            stopSttSubtitleEngine();
            renderActiveTabBody();
            toast('麥克風權限被拒絕或無法存取，已取消語音字幕', 'error');
            return false;
        }
    }

    async function startSttSubtitleEngine() {
        stopScreenSubtitleMode();
        stopSttSubtitleEngine();

        if (sttSource === 'mic') {
            const resolvedLang = sttInputLang === 'auto'
                ? ((typeof global.getLanguageConfig === 'function' && global.getLanguageConfig().targetLang === 'ja') ? 'ja-JP' : 'en-US')
                : sttInputLang;
            const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
            if (!SR) {
                await startMicMediaRecorderFallback(resolvedLang);
                return;
            }
            const rec = new SR();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = resolvedLang;

            const handleInterimStream = (snapshotText, langHint) => {
                const cleanSnap = String(snapshotText || '').trim();
                if (!cleanSnap) return;
                const nativeCfg = getNativeLangConfig(targetNativeLang);

                // Layer 2: 單一虛詞 / 助詞 400ms 暫緩門檻，防止單字閃爍
                if (sttStopwordTimer) { clearTimeout(sttStopwordTimer); sttStopwordTimer = null; }
                const processInterim = () => {
                    sttLastProvisionalText = cleanSnap;
                    const offlineMeaning = lookupOfflineSubtitleDraft(cleanSnap, langHint);
                    if (offlineMeaning) {
                        sttInterimDraft = offlineMeaning;
                        upsertProvisionalSubtitle(cleanSnap, offlineMeaning, langHint);
                    } else if (Date.now() - sttLastInterimTranslateAt > 550) {
                        sttLastInterimTranslateAt = Date.now();
                        fetchGoogleTranslateFallback(cleanSnap, langHint, nativeCfg.code)
                            .then((draft) => {
                                if (sttInterimText === cleanSnap || sttInterimText.startsWith(cleanSnap)) {
                                    sttInterimDraft = draft || '';
                                    upsertProvisionalSubtitle(cleanSnap, sttInterimDraft, langHint);
                                }
                            })
                            .catch(() => {});
                    } else {
                        upsertProvisionalSubtitle(cleanSnap, sttInterimDraft, langHint);
                    }
                };

                if (isLikelyTrailingStopwordOnly(cleanSnap)) {
                    sttStopwordTimer = setTimeout(() => {
                        sttStopwordTimer = null;
                        if (sttRunning && sttInterimText === cleanSnap) processInterim();
                    }, 400);
                } else {
                    processInterim();
                }

                // Layer 4: 句尾標點立刻結算，或靜止超過 650ms 自動觸發定稿與語境精修
                if (sttInactivityTimer) { clearTimeout(sttInactivityTimer); sttInactivityTimer = null; }
                if (/[.!?。！？]$/.test(cleanSnap)) {
                    sttInterimText = '';
                    sttInterimDraft = '';
                    translateTranscriptText(cleanSnap, langHint);
                } else {
                    sttInactivityTimer = setTimeout(() => {
                        sttInactivityTimer = null;
                        if (sttRunning && sttInterimText === cleanSnap) {
                            sttInterimText = '';
                            sttInterimDraft = '';
                            translateTranscriptText(cleanSnap, langHint);
                        }
                    }, 650);
                }
            };

            rec.onstart = () => {
                sttRunning = true;
                activeLiveMode = 'voice';
                subtitlePinnedOverlay = true;
                renderSubtitleOverlay();
                renderActiveTabBody();
            };

            rec.onresult = (event) => {
                let interim = '';
                const langHint = rec.lang.startsWith('ja') ? 'ja' : (rec.lang.startsWith('zh') ? 'zh-TW' : 'en');
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const res = event.results[i];
                    const transcript = (res[0] && res[0].transcript) ? res[0].transcript.trim() : '';
                    if (!transcript) continue;
                    if (res.isFinal) {
                        clearSttStabilizerTimers();
                        sttInterimText = '';
                        sttInterimDraft = '';
                        translateTranscriptText(transcript, langHint);
                    } else {
                        interim += transcript + ' ';
                    }
                }
                sttInterimText = interim.trim();
                if (sttInterimText) {
                    handleInterimStream(sttInterimText, langHint);
                }
                renderSubtitleOverlay();
            };

            rec.onerror = async (ev) => {
                const code = ev && ev.error ? ev.error : '';
                if (code === 'not-allowed' || code === 'service-not-allowed') {
                    toast('麥克風權限被拒絕', 'error');
                    stopSttSubtitleEngine();
                    renderActiveTabBody();
                    return;
                }
                if (code === 'network' || code === 'audio-capture' || code === 'language-not-supported') {
                    if (speechRec === rec) {
                        try { rec.onend = null; rec.stop(); } catch (e) {}
                        speechRec = null;
                    }
                    await startMicMediaRecorderFallback(resolvedLang);
                }
            };

            rec.onend = () => {
                if (sttRunning && speechRec === rec) {
                    try { rec.start(); } catch (e) {
                        stopSttSubtitleEngine();
                        renderActiveTabBody();
                    }
                }
            };

            speechRec = rec;
            try {
                rec.start();
                toast('正在啟動麥克風語音辨識...', 'info');
            } catch (e) {
                speechRec = null;
                await startMicMediaRecorderFallback(resolvedLang);
            }
            return;
        }

        // 媒體／分頁音訊擷取 (getDisplayMedia audio + Web Audio AnalyserNode VAD + stop/restart MediaRecorder)
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
            toast('此裝置不支援分頁音訊擷取，請切換為麥克風收音', 'warning');
            return;
        }

        try {
            sttTabStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            const audioTracks = sttTabStream.getAudioTracks();
            if (!audioTracks || audioTracks.length === 0) {
                stopSttSubtitleEngine();
                toast('未勾選「分享分頁音訊」，請重新選擇並勾選分享音訊', 'warning');
                renderActiveTabBody();
                return;
            }

            const audioOnlyStream = new MediaStream(audioTracks);
            const AudioCtx = global.AudioContext || global.webkitAudioContext;
            if (AudioCtx) {
                sttAudioCtx = new AudioCtx();
                const srcNode = sttAudioCtx.createMediaStreamSource(audioOnlyStream);
                sttAnalyser = sttAudioCtx.createAnalyser();
                sttAnalyser.fftSize = 1024;
                srcNode.connect(sttAnalyser);
            }

            sttRunning = true;
            activeLiveMode = 'voice';
            subtitlePinnedOverlay = true;
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

            let windowPeakRms = 0;
            const rmsSampleTimer = setInterval(() => {
                if (!sttRunning) {
                    clearInterval(rmsSampleTimer);
                    return;
                }
                if (sttAnalyser) {
                    const buf = new Float32Array(sttAnalyser.fftSize);
                    sttAnalyser.getFloatTimeDomainData(buf);
                    let sum = 0;
                    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                    const rms = Math.sqrt(sum / buf.length);
                    if (rms > windowPeakRms) windowPeakRms = rms;
                } else {
                    windowPeakRms = 0.05;
                }
            }, 200);

            const recordNextChunk = () => {
                if (!sttRunning || !audioOnlyStream.active) return;
                windowPeakRms = 0;
                const chunks = [];
                const recorder = mimeType
                    ? new MediaRecorder(audioOnlyStream, { mimeType })
                    : new MediaRecorder(audioOnlyStream);
                sttMediaRecorder = recorder;

                recorder.ondataavailable = (ev) => {
                    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
                };

                recorder.onstop = async () => {
                    const peak = windowPeakRms;
                    if (sttRunning) recordNextChunk();
                    if (!chunks.length || peak < 0.008) return;

                    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                    if (blob.size < 1200) return;

                    const b64 = await new Promise(resolve => {
                        const fr = new FileReader();
                        fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
                        fr.onerror = () => resolve('');
                        fr.readAsDataURL(blob);
                    });
                    if (!b64 || typeof global.callGeminiApi !== 'function') return;

                    try {
                        const nativeCfg = getNativeLangConfig(targetNativeLang);
                        const prompt = `請逐字聽寫這段音訊中的語音內容（可為英文、日文或中文），並翻譯成「${nativeCfg.aiName}」。
若為靜音、純噪音或無明確人聲，回傳 {"original":"","translation":"","lang":""}。
只輸出純 JSON 物件：{"original":"","translation":"","lang":"en|ja|zh-TW"}`;
                        const raw = await global.callGeminiApi(prompt, {
                            silent: true,
                            feature: 'vision_ocr',
                            inlineData: { mimeType: blob.type || 'audio/webm', data: b64 }
                        });
                        const parsed = (typeof global.safeParseJSON === 'function')
                            ? global.safeParseJSON(raw)
                            : JSON.parse(raw);
                        if (parsed && parsed.original && parsed.original.trim()) {
                            pushSubtitleEntry(parsed.original, parsed.translation || '', parsed.lang || '', 'refined');
                        }
                    } catch (e) {}
                };

                recorder.start();
                sttChunkTimer = setTimeout(() => {
                    if (recorder.state === 'recording') {
                        try { recorder.stop(); } catch (e) {}
                    }
                }, 4000);
            };

            audioTracks[0].addEventListener('ended', () => {
                clearInterval(rmsSampleTimer);
                stopSttSubtitleEngine();
                renderActiveTabBody();
            });

            recordNextChunk();
            toast('分頁／媒體音訊雙語字幕已啟動', 'success');
        } catch (err) {
            const isDesktopWidget = hasElectronWidgetBridge();
            const errName = (err && err.name) ? String(err.name) : 'UnknownError';
            const errMessage = (err && err.message) ? String(err.message) : String(err || '未知錯誤');
            stopSttSubtitleEngine();
            if (!isDesktopWidget && (errName === 'NotAllowedError' || errName === 'AbortError')) {
                toast('已取消音訊擷取', 'info');
            } else {
                console.error('[FloatingTranslator] tab audio getDisplayMedia failed:', {
                    desktopWidget: isDesktopWidget,
                    name: errName,
                    message: errMessage,
                    err
                });
                toast(`音訊擷取失敗 (${errName}: ${errMessage})`, 'error');
            }
        }
        renderSubtitleOverlay();
        renderActiveTabBody();
    }

    function loadSubtitleOverlayPos() {
        try {
            const raw = localStorage.getItem(STORAGE_SUBTITLE_POS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && Number.isFinite(parsed.leftPx) && Number.isFinite(parsed.topPx)) {
                subtitleOverlayPos.leftPx = parsed.leftPx;
                subtitleOverlayPos.topPx = parsed.topPx;
            }
        } catch (e) {}
    }

    function applySubtitleOverlayPosition() {
        if (!subtitleOverlayEl) return;
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;
        const insets = getEffectiveSafeInsets();
        const minTop = Math.max(48, insets.top + 8);
        const w = Math.min(640, vw - 24);
        subtitleOverlayEl.style.width = `${w}px`;
        if (Number.isFinite(subtitleOverlayPos.leftPx) && Number.isFinite(subtitleOverlayPos.topPx)) {
            const maxL = Math.max(12, vw - w - 12);
            const maxT = Math.max(minTop, vh - 110 - insets.bottom);
            subtitleOverlayEl.style.left = `${clamp(subtitleOverlayPos.leftPx, 12, maxL)}px`;
            subtitleOverlayEl.style.top = `${clamp(subtitleOverlayPos.topPx, minTop, maxT)}px`;
            subtitleOverlayEl.style.bottom = 'auto';
            subtitleOverlayEl.style.transform = 'none';
        } else {
            subtitleOverlayEl.style.left = `${Math.round((vw - w) / 2)}px`;
            subtitleOverlayEl.style.top = `${Math.max(minTop, vh - 170 - insets.bottom)}px`;
            subtitleOverlayEl.style.bottom = 'auto';
            subtitleOverlayEl.style.transform = 'none';
        }
    }

    function bindSubtitleOverlayDrag(el) {
        const handle = el.querySelector('.ft-subtitle-drag-handle');
        if (!handle || handle.dataset.dragBound === '1') return;
        handle.dataset.dragBound = '1';
        let dragging = false;
        let sx = 0;
        let sy = 0;
        let sl = 0;
        let st = 0;

        handle.addEventListener('pointerdown', (e) => {
            if (e.target && e.target.closest('button, input, select')) return;
            dragging = true;
            sx = e.clientX;
            sy = e.clientY;
            const rect = el.getBoundingClientRect();
            sl = rect.left;
            st = rect.top;
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const vw = global.innerWidth || 375;
            const vh = global.innerHeight || 667;
            const insets = getEffectiveSafeInsets();
            const minTop = Math.max(36, insets.top + 8);
            const bottomPad = Math.max(8, insets.bottom + 8);
            const w = el.offsetWidth || 320;
            const h = el.offsetHeight || 88;
            const nl = clamp(sl + (e.clientX - sx), 8, Math.max(8, vw - w - 8));
            const nt = clamp(st + (e.clientY - sy), minTop, Math.max(minTop, vh - h - bottomPad));
            el.style.left = `${nl}px`;
            el.style.top = `${nt}px`;
            subtitleOverlayPos.leftPx = Math.round(nl);
            subtitleOverlayPos.topPx = Math.round(nt);
        });

        const end = (e) => {
            if (!dragging) return;
            dragging = false;
            try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
            try { localStorage.setItem(STORAGE_SUBTITLE_POS_KEY, JSON.stringify(subtitleOverlayPos)); } catch (err) {}
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    let electronSubWindowOpen = false;

    function renderSubtitleOverlay() {
        const latest = subtitleFeed[0] || null;
        const ytActive = ytPlaying ? getCurrentYoutubeCue(ytCurrentMs).cue : null;
        const hasActivity = Boolean(videoMonitorTimer || sttRunning || ytPlaying || sttInterimText || ytActive || latest);

        const displayOrig = ytActive
            ? ytActive.text
            : (sttInterimText || (latest && latest.orig) || '');
        const displayLang = ytActive
            ? detectScriptLang(ytActive.text, ytLanguageCode)
            : (sttInterimText ? detectScriptLang(sttInterimText) : ((latest && latest.lang) || 'en'));
        const displayTrans = ytActive
            ? ytActive.trans
            : (sttInterimText ? sttInterimDraft : ((latest && latest.trans) || ''));
        const isLiveActive = Boolean(videoMonitorTimer || sttRunning || ytPlaying);
        const tierLabel = ytActive
            ? '0MS SYNC'
            : (sttInterimText
                ? 'LIVE STREAM'
                : (latest && latest.tier === 'draft' ? 'FAST DRAFT' : 'CONTEXT AI'));

        const useElectronSubWindow = hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.openSubtitleWindow === 'function';
        if (useElectronSubWindow) {
            if (subtitleOverlayEl) subtitleOverlayEl.classList.add('hidden');
            if (!subtitlePinnedOverlay || !hasActivity) {
                if (electronSubWindowOpen && typeof global.LZHDesktopWidget.closeSubtitleWindow === 'function') {
                    global.LZHDesktopWidget.closeSubtitleWindow().catch(() => {});
                }
                electronSubWindowOpen = false;
                return;
            }
            if (!electronSubWindowOpen) {
                electronSubWindowOpen = true;
                global.LZHDesktopWidget.openSubtitleWindow().catch(() => {});
            }
            if (typeof global.LZHDesktopWidget.updateSubtitleText === 'function') {
                global.LZHDesktopWidget.updateSubtitleText({
                    orig: displayOrig,
                    trans: displayTrans,
                    tierLabel,
                    isLive: isLiveActive
                });
            }
            return;
        }

        if (!subtitleOverlayEl) {
            loadSubtitleOverlayPos();
            subtitleOverlayEl = document.createElement('div');
            subtitleOverlayEl.id = 'ftLiveSubtitleOverlay';
            subtitleOverlayEl.className = 'hidden fixed z-[60] rounded-2xl p-3 space-y-1.5 ft-subtitle-bar';
            document.body.appendChild(subtitleOverlayEl);
        }

        if (!subtitlePinnedOverlay || !hasActivity) {
            subtitleOverlayEl.classList.add('hidden');
            return;
        }

        subtitleOverlayEl.classList.remove('hidden');
        applySubtitleOverlayPosition();

        const tierBadgeHtml = ytActive
            ? '<span class="ft-tier-badge ft-tier-badge--youtube">0MS SYNC</span>'
            : (sttInterimText
                ? '<span class="ft-tier-badge ft-tier-badge--draft">LIVE STREAM</span>'
                : (latest && latest.tier === 'draft'
                    ? '<span class="ft-tier-badge ft-tier-badge--draft">FAST DRAFT</span>'
                    : '<span class="ft-tier-badge ft-tier-badge--context">CONTEXT AI</span>'));

        const liveBeaconHtml = isLiveActive
            ? `<span class="ft-live-beacon"><span class="ft-live-dot"></span><span>LIVE SYNC</span><span class="ft-eq-bars" aria-hidden="true"><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span></span></span>`
            : '<span class="w-2 h-2 rounded-full bg-slate-400"></span>';

        const origHtml = displayOrig
            ? (sttInterimText && !ytActive
                ? `<span class="opacity-85">${escapeHtml(displayOrig)}...</span>`
                : renderClickableTokensHtml(displayOrig, displayLang))
            : '<span class="text-slate-300/80 text-xs">等待語音或畫面字幕輸入中...</span>';
        const transHtml = displayTrans
            ? `<div class="text-xs sm:text-sm font-semibold text-emerald-300 leading-snug">${escapeHtml(displayTrans)}</div>`
            : '';

        subtitleOverlayEl.innerHTML = `
            <div class="ft-subtitle-drag-handle flex items-center justify-between gap-2 text-[10px] text-slate-300 cursor-move select-none" style="touch-action:none;">
                <span class="font-bold flex items-center gap-1.5 flex-wrap">
                    ${FT_SVG.grip}
                    ${liveBeaconHtml}
                    <span>螢幕覆蓋字幕</span>
                    ${tierBadgeHtml}
                </span>
                <button type="button" id="ftSubtitleOverlayHideBtn" class="px-2 py-0.5 rounded-md bg-white/15 hover:bg-white/25 text-white cursor-pointer">隱藏</button>
            </div>
            <div class="text-sm sm:text-base font-bold text-white leading-relaxed">${origHtml}</div>
            ${transHtml}
        `;

        bindSubtitleOverlayDrag(subtitleOverlayEl);
        const hideBtn = subtitleOverlayEl.querySelector('#ftSubtitleOverlayHideBtn');
        if (hideBtn) {
            hideBtn.onclick = () => {
                subtitlePinnedOverlay = false;
                renderSubtitleOverlay();
                if (panelViewMode === 'translator' && activeTab === 'subtitle') renderActiveTabBody();
            };
        }
    }

    /* ==========================================================================
       6. 模組三：跨平台懸浮面板 UI、Document PiP & LZHNativeBridge
       ========================================================================== */

    function isFeatureEnabled() {
        if (isDesktopWidgetShell()) return true;
        return localStorage.getItem(STORAGE_ENABLED_KEY) === 'true';
    }

    function setFeatureEnabled(enabled) {
        const flag = Boolean(enabled);
        if (!isDesktopWidgetShell()) {
            const strVal = flag ? 'true' : 'false';
            try { localStorage.setItem(STORAGE_ENABLED_KEY, strVal); } catch (e) {}
            try {
                const prefs = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Preferences;
                if (prefs && typeof prefs.set === 'function') {
                    prefs.set({ key: STORAGE_ENABLED_KEY, value: strVal }).catch(() => {});
                }
            } catch (e) {}
        }
        if (!flag) {
            stopCameraStream();
            stopAllSubtitleEngines();
            if (electronSubWindowOpen && hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.closeSubtitleWindow === 'function') {
                global.LZHDesktopWidget.closeSubtitleWindow().catch(() => {});
                electronSubWindowOpen = false;
            }
            closePipWindow();
            collapsePanel();
            hideTapBubble();
            if (rootEl) rootEl.classList.add('hidden');
        } else {
            ensureDomMounted();
            if (rootEl) rootEl.classList.remove('hidden');
            refreshBallUnread();
        }
        if (typeof global.updateFloatingMasterSwitchUI === 'function') {
            global.updateFloatingMasterSwitchUI();
        }
        return flag;
    }

    function loadPositionState() {
        try {
            const raw = localStorage.getItem(STORAGE_POS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                posState.dockSide = parsed.dockSide === 'left' ? 'left' : 'right';
                if (Number.isFinite(parsed.topPx)) posState.topPx = parsed.topPx;
                if (Number.isFinite(parsed.panelLeftPx)) posState.panelLeftPx = parsed.panelLeftPx;
                if (Number.isFinite(parsed.panelTopPx)) posState.panelTopPx = parsed.panelTopPx;
            }
        } catch (e) {}
    }

    function savePositionState() {
        try {
            localStorage.setItem(STORAGE_POS_KEY, JSON.stringify(posState));
        } catch (e) {}
    }

    function hasElectronWidgetBridge() {
        return Boolean(global.LZHDesktopWidget && global.LZHDesktopWidget.isElectron);
    }

    function isDesktopWidgetShell() {
        if (hasElectronWidgetBridge()) return true;
        try {
            return new URLSearchParams(global.location?.search || '').get('widget') === 'desktop';
        } catch (e) {
            return false;
        }
    }

    function getSignedInGoogleUser() {
        try {
            const u = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
            return (u && !u.isAnonymous) ? u : null;
        } catch (e) {
            return null;
        }
    }

    let electronShortcutUnsub = null;
    let desktopShellInitialized = false;
    let authSyncListenerBound = false;

    function injectDesktopHideShellStyle() {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById('ftDesktopHideShellStyle')) return;
        const styleEl = document.createElement('style');
        styleEl.id = 'ftDesktopHideShellStyle';
        styleEl.textContent = `
            html[data-widget-mode="desktop"],
            body[data-widget-mode="desktop"] {
                background: transparent !important;
                background-color: transparent !important;
                padding: 0 !important;
                margin: 0 !important;
                min-height: 100vh !important;
                overflow: hidden !important;
            }
            html[data-widget-mode="desktop"] #main-header,
            html[data-widget-mode="desktop"] #bottom-nav,
            html[data-widget-mode="desktop"] body > main,
            html[data-widget-mode="desktop"] #appLoadingOverlay,
            html[data-widget-mode="desktop"] #welcomeModal,
            html[data-widget-mode="desktop"] #login-screen,
            html[data-widget-mode="desktop"] #auth-modal,
            html[data-widget-mode="desktop"] #auth-overlay,
            html[data-widget-mode="desktop"] #onboardingSetupModal,
            html[data-widget-mode="desktop"] #onboardingTourOverlay {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
            html[data-widget-mode="desktop"] #floatingTranslatorBall {
                width: 60px !important;
                height: 60px !important;
                border-radius: 9999px !important;
                overflow: visible !important;
            }
        `;
        document.head.appendChild(styleEl);
    }

    function initDesktopWidgetShell() {
        if (!isDesktopWidgetShell()) return;
        injectDesktopHideShellStyle();
        if (desktopShellInitialized) return;
        desktopShellInitialized = true;

        document.documentElement.style.background = 'transparent';
        document.documentElement.style.backgroundColor = 'transparent';
        document.documentElement.setAttribute('data-widget-mode', 'desktop');
        if (document.body) {
            document.body.style.background = 'transparent';
            document.body.style.backgroundColor = 'transparent';
            document.body.style.paddingBottom = '0px';
            document.body.style.margin = '0px';
            document.body.style.overflow = 'hidden';
            document.body.setAttribute('data-widget-mode', 'desktop');
        }

        [
            'main-header',
            'bottom-nav',
            'appLoadingOverlay',
            'welcomeModal',
            'login-screen',
            'auth-modal',
            'auth-overlay',
            'onboardingSetupModal',
            'onboardingTourOverlay'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const mainEl = document.querySelector('body > main');
        if (mainEl) mainEl.classList.add('hidden');

        if (hasElectronWidgetBridge() && !electronShortcutUnsub && typeof global.LZHDesktopWidget.onShortcutToggle === 'function') {
            electronShortcutUnsub = global.LZHDesktopWidget.onShortcutToggle((payload) => {
                const action = (payload && payload.action) || 'toggle';
                if (action === 'expand') openPanel(activeTab, '', { fromElectronShortcut: true });
                else if (action === 'collapse') collapsePanel({ fromElectronShortcut: true });
                else togglePanel();
            });
        }
    }

    function applyBallPosition() {
        if (!ballEl) return;
        if (hasElectronWidgetBridge()) {
            ballEl.classList.toggle('hidden', isOpen);
            ballEl.style.width = '60px';
            ballEl.style.height = '60px';
            ballEl.style.borderRadius = '9999px';
            ballEl.style.top = '8px';
            ballEl.style.left = '8px';
            ballEl.style.right = 'auto';
            ballEl.style.bottom = 'auto';
            return;
        }
        if (isIosScreenTranslatePlatform() && !isInAppDockVisible()) {
            ballEl.classList.add('hidden');
            return;
        }
        ballEl.classList.remove('hidden');
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;
        const insets = getEffectiveSafeInsets();
        const ballSize = 52;
        const margin = 12;
        const minTop = Math.max(68, insets.top + 10);
        const maxBottomMargin = Math.max(24, insets.bottom + 16);
        const safeTop = clamp(posState.topPx !== null ? posState.topPx : Math.round(vh * 0.68), minTop, Math.max(minTop, vh - ballSize - maxBottomMargin));
        posState.topPx = safeTop;
        const leftPx = posState.dockSide === 'left' ? margin : Math.max(margin, vw - ballSize - margin);

        ballEl.style.top = `${safeTop}px`;
        ballEl.style.left = `${leftPx}px`;
        ballEl.style.right = 'auto';
        ballEl.style.bottom = 'auto';
    }

    function applyPanelPosition() {
        if (!panelHostEl || pipWindowRef) return;
        if (panelFullscreen) {
            panelHostEl.classList.add('ft-fullscreen');
            panelHostEl.style.left = '0px';
            panelHostEl.style.top = '0px';
            panelHostEl.style.right = '0px';
            panelHostEl.style.bottom = '0px';
            panelHostEl.style.width = '100vw';
            panelHostEl.style.height = '100vh';
            panelHostEl.style.maxHeight = 'none';
            return;
        }
        panelHostEl.classList.remove('ft-fullscreen');
        panelHostEl.style.height = '';
        if (hasElectronWidgetBridge()) {
            panelHostEl.style.left = '6px';
            panelHostEl.style.top = '6px';
            panelHostEl.style.right = '6px';
            panelHostEl.style.bottom = '6px';
            panelHostEl.style.width = 'calc(100vw - 12px)';
            panelHostEl.style.maxHeight = 'calc(100vh - 12px)';
            return;
        }
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;
        const insets = getEffectiveSafeInsets();

        const isTabletImageExpanded = Boolean(isImageModeActive && vw >= 600);
        if (isTabletImageExpanded) {
            const safeAvailH = Math.max(260, vh - insets.top - insets.bottom);
            const tabW = Math.round(vw * 0.82);
            const tabH = Math.round(safeAvailH * 0.82);
            panelHostEl.style.width = `${tabW}px`;
            panelHostEl.style.height = `${tabH}px`;
            panelHostEl.style.maxHeight = `${tabH}px`;
            panelHostEl.style.left = `${Math.max(0, Math.round((vw - tabW) / 2))}px`;
            panelHostEl.style.top = `${Math.max(insets.top + 8, Math.round(insets.top + (safeAvailH - tabH) / 2))}px`;
            panelHostEl.style.right = 'auto';
            panelHostEl.style.bottom = 'auto';
            return;
        }
        panelHostEl.style.maxHeight = `calc(100vh - var(--lzh-effective-top, 0px) - var(--lzh-effective-bottom, 0px) - 24px)`;

        const panelW = vw < 450 ? Math.min(410, Math.max(272, vw - 20)) : 410;
        panelHostEl.style.width = `${panelW}px`;
        panelHostEl.style.right = 'auto';
        panelHostEl.style.bottom = 'auto';

        const measuredW = panelHostEl.offsetWidth || panelW;
        const measuredH = panelHostEl.offsetHeight || Math.min(540, Math.max(240, vh - insets.top - insets.bottom - 32));
        const marginX = vw < 450 ? 10 : 12;
        const minTop = Math.max(12, insets.top + 8);
        const bottomMargin = Math.max(12, insets.bottom + 8);
        const maxLeft = Math.max(marginX, vw - measuredW - marginX);
        const maxTop = Math.max(minTop, vh - measuredH - bottomMargin);

        const defaultLeft = posState.dockSide === 'left' ? marginX : Math.max(marginX, vw - measuredW - marginX);
        const defaultTop = clamp((posState.topPx || Math.round(vh * 0.65)) - Math.round(measuredH * 0.6), Math.max(56, minTop), maxTop);
        const targetLeft = clamp(posState.panelLeftPx !== null ? posState.panelLeftPx : defaultLeft, marginX, maxLeft);
        const targetTop = clamp(posState.panelTopPx !== null ? posState.panelTopPx : defaultTop, minTop, maxTop);

        panelHostEl.style.left = `${targetLeft}px`;
        panelHostEl.style.top = `${targetTop}px`;
    }

    function supportsDocumentPip() {
        if (hasElectronWidgetBridge()) return false;
        return Boolean(global.documentPictureInPicture && typeof global.documentPictureInPicture.requestWindow === 'function');
    }

    function syncThemeAndStylesToPip(pipDoc) {
        if (document.documentElement.classList.contains('dark')) {
            pipDoc.documentElement.classList.add('dark');
        }
        document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
            try {
                const clone = node.cloneNode(true);
                pipDoc.head.appendChild(clone);
            } catch (e) {}
        });
        pipDoc.body.className = 'bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 m-0 p-2 min-h-screen';
    }

    async function openPipWindow() {
        if (!supportsDocumentPip()) {
            toast('目前瀏覽器不支援 Document PiP 獨立小窗，已使用頁內置頂懸浮視窗', 'info');
            return false;
        }
        if (pipWindowRef && !pipWindowRef.closed) {
            try { pipWindowRef.focus(); } catch (e) {}
            return true;
        }
        ensureDomMounted();
        try {
            const pipWin = await global.documentPictureInPicture.requestWindow({
                width: 420,
                height: 620
            });
            pipWindowRef = pipWin;
            syncThemeAndStylesToPip(pipWin.document);
            pipWin.document.addEventListener('focusin', (ev) => {
                const t = ev && ev.target;
                if (!t || typeof t.scrollIntoView !== 'function') return;
                if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && t.tagName !== 'SELECT') return;
                setTimeout(() => {
                    try { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (err) {}
                }, 260);
            });
            pipWin.document.body.appendChild(panelContentEl);
            if (panelHostEl) panelHostEl.classList.add('hidden');
            isOpen = true;
            updatePipButtonState();

            pipWin.addEventListener('pagehide', () => {
                if (panelHostEl && panelContentEl && panelContentEl.parentElement !== panelHostEl) {
                    panelHostEl.appendChild(panelContentEl);
                }
                pipWindowRef = null;
                if (isOpen && panelHostEl) {
                    panelHostEl.classList.remove('hidden');
                    applyPanelPosition();
                }
                updatePipButtonState();
            });
            return true;
        } catch (err) {
            console.warn('[FloatingTranslator] Document PiP open failed:', err);
            toast('無法開啟獨立置頂小窗，已自動使用頁內懸浮視窗', 'warning');
            return false;
        }
    }

    function closePipWindow() {
        if (pipWindowRef && !pipWindowRef.closed) {
            try { pipWindowRef.close(); } catch (e) {}
        }
        pipWindowRef = null;
        if (panelHostEl && panelContentEl && panelContentEl.parentElement !== panelHostEl) {
            panelHostEl.appendChild(panelContentEl);
        }
        updatePipButtonState();
    }

    function updatePipButtonState() {
        const btn = q('ftPipToggleBtn');
        if (!btn) return;
        if (!supportsDocumentPip()) {
            btn.classList.add('hidden');
            return;
        }
        btn.classList.remove('hidden');
        const isPip = Boolean(pipWindowRef && !pipWindowRef.closed);
        btn.title = isPip ? '歸還至主視窗' : '彈出為獨立置頂小窗';
        btn.innerHTML = isPip ? `${FT_SVG.returnWin}<span>歸還視窗</span>` : `${FT_SVG.pin}<span>獨立置頂</span>`;
    }

    function ensureDomMounted() {
        if (rootEl && document.body.contains(rootEl)) return;

        rootEl = document.createElement('div');
        rootEl.id = 'floatingTranslatorRoot';
        rootEl.className = (isFeatureEnabled() || (isIosScreenTranslatePlatform() && isInAppDockVisible())) ? '' : 'hidden';

        // 1. 懸浮球 (z-[55])
        ballEl = document.createElement('button');
        ballEl.id = 'floatingTranslatorBall';
        ballEl.type = 'button';
        ballEl.setAttribute('aria-label', '開啟全域懸浮翻譯視窗');
        ballEl.className = 'fixed z-[55] w-[52px] h-[52px] rounded-full bg-brand-600 hover:bg-brand-700 text-white shadow-xl border-2 border-white/80 dark:border-slate-700 flex items-center justify-center cursor-grab active:cursor-grabbing select-none transition-transform hover:scale-105';
        ballEl.style.touchAction = 'none';
        ballEl.innerHTML = `${FT_SVG.ballGlobe}<span id="ftBallUnreadDot" class="hidden absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-rose-500 ring-2 ring-white dark:ring-slate-900 pointer-events-none"></span>`;

        // 2. 頁內懸浮面板容器 (z-[55])
        panelHostEl = document.createElement('div');
        panelHostEl.id = 'floatingTranslatorPanelHost';
        panelHostEl.className = 'hidden fixed z-[55] max-h-[84vh] flex flex-col';

        panelContentEl = document.createElement('div');
        panelContentEl.id = 'floatingTranslatorPanelContent';
        panelContentEl.className = 'ft-glass-panel ft-motion-enter w-full h-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col overflow-hidden';

        panelContentEl.innerHTML = buildPanelShellHtml();
        panelHostEl.appendChild(panelContentEl);

        rootEl.appendChild(ballEl);
        rootEl.appendChild(panelHostEl);
        document.body.appendChild(rootEl);

        bindBallDragAndClick();
        bindPanelHeaderControls();
        applyBallPosition();
        applyPanelPosition();
        renderActiveTabBody();
        refreshBallUnread();
    }

    function buildPanelShellHtml() {
        return `
            <!-- 頂部可拖曳標題列 + 翻譯/聊天切換器 + 母語切換器 + PiP -->
            <div id="ftPanelDragHandle" class="px-3 py-2.5 bg-slate-50/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 cursor-move select-none shrink-0" style="touch-action:none;">
                <div class="flex items-center gap-2 min-w-0">
                    <button type="button" id="ftViewModeToggleBtn" title="切換翻譯 / 好友聊天" class="relative min-h-[44px] px-2.5 py-1.5 rounded-xl bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-800 text-[11px] font-black text-brand-700 dark:text-brand-300 cursor-pointer flex items-center gap-1 shrink-0">
                        <span id="ftViewModeToggleText" class="inline-flex items-center gap-1">${FT_SVG.globe}<span>翻譯</span>${FT_SVG.arrows}${FT_SVG.chat}<span>聊天</span></span>
                        <span id="ftChatUnreadDot" class="hidden w-2 h-2 rounded-full bg-rose-500"></span>
                    </button>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <select id="ftTargetNativeSelect" title="設定目標翻譯母語" class="min-h-[44px] px-2 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold text-slate-700 dark:text-slate-200 outline-none cursor-pointer">
                        <option value="zh-TW">母語: 繁中</option>
                        <option value="en">Native: EN</option>
                        <option value="ja">母語: 日本語</option>
                    </select>
                    <button type="button" id="ftPipToggleBtn" class="hidden min-h-[44px] px-2.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer">${FT_SVG.pin}<span>置頂</span></button>
                    <button type="button" id="ftPanelFullscreenBtn" class="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 flex items-center justify-center text-xs cursor-pointer" title="切換全螢幕">
                        ${FT_SVG.expand}
                    </button>
                    <button type="button" id="ftPanelCloseBtn" class="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 flex items-center justify-center text-xs cursor-pointer" title="收合 (Esc)">
                        ${FT_SVG.close}
                    </button>
                </div>
            </div>

            <!-- 3 大翻譯功能頁籤切換（聊天模式時自動隱藏） -->
            <div id="ftTranslatorTabStrip" class="px-3 pt-2 pb-1.5 border-b border-slate-100 dark:border-slate-700 grid grid-cols-3 gap-2 shrink-0">
                <button type="button" data-ft-tab="camera" class="min-h-[44px] py-2 px-2 rounded-xl text-[11px] font-extrabold transition inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.camera}<span>拍照翻譯</span></button>
                <button type="button" data-ft-tab="screen" class="min-h-[44px] py-2 px-2 rounded-xl text-[11px] font-extrabold transition inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.screen}<span>螢幕點詞</span></button>
                <button type="button" data-ft-tab="subtitle" class="min-h-[44px] py-2 px-2 rounded-xl text-[11px] font-extrabold transition inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.subtitle}<span>即時字幕/語音</span></button>
            </div>

            <!-- 內容捲動主區 -->
            <div id="ftTabBody" class="p-3 space-y-2.5 overflow-y-auto flex-1 max-h-[65vh]"></div>
        `;
    }

    function bindBallDragAndClick() {
        if (!ballEl) return;
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let lastScreenX = 0;
        let lastScreenY = 0;
        let startTop = 0;
        let startLeft = 0;

        ballEl.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            lastScreenX = e.screenX;
            lastScreenY = e.screenY;
            const rect = ballEl.getBoundingClientRect();
            startTop = rect.top;
            startLeft = rect.left;
            try { ballEl.setPointerCapture(e.pointerId); } catch (err) {}
        });

        ballEl.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const sdx = e.screenX - lastScreenX;
            const sdy = e.screenY - lastScreenY;
            if (Math.hypot(dx, dy) > 5 || Math.hypot(sdx, sdy) > 5) moved = true;
            if (!moved) return;

            if (hasElectronWidgetBridge()) {
                lastScreenX = e.screenX;
                lastScreenY = e.screenY;
                if (sdx !== 0 || sdy !== 0) {
                    global.LZHDesktopWidget.moveBy(sdx, sdy);
                }
                return;
            }

            const vw = global.innerWidth || 375;
            const vh = global.innerHeight || 667;
            const insets = getEffectiveSafeInsets();
            const minTop = Math.max(58, insets.top + 8);
            const maxTop = Math.max(minTop, vh - 68 - insets.bottom);
            const nextLeft = clamp(startLeft + dx, 6, vw - 58);
            const nextTop = clamp(startTop + dy, minTop, maxTop);
            ballEl.style.left = `${nextLeft}px`;
            ballEl.style.top = `${nextTop}px`;
        });

        const finishDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try { ballEl.releasePointerCapture(e.pointerId); } catch (err) {}
            if (moved) {
                if (hasElectronWidgetBridge()) {
                    if (typeof global.LZHDesktopWidget.snapToEdge === 'function') {
                        global.LZHDesktopWidget.snapToEdge();
                    }
                    return;
                }
                const rect = ballEl.getBoundingClientRect();
                const vw = global.innerWidth || 375;
                posState.dockSide = (rect.left + rect.width / 2) < vw / 2 ? 'left' : 'right';
                posState.topPx = Math.round(rect.top);
                savePositionState();
                applyBallPosition();
            } else {
                openPanel(activeTab);
            }
        };

        ballEl.addEventListener('pointerup', finishDrag);
        ballEl.addEventListener('pointercancel', finishDrag);
    }

    function bindPanelHeaderControls() {
        const doc = getTargetDoc();
        const viewToggleBtn = q('ftViewModeToggleBtn');
        if (viewToggleBtn) {
            viewToggleBtn.onclick = () => {
                setPanelViewMode(panelViewMode === 'chat' ? 'translator' : 'chat');
            };
        }

        const nativeSel = q('ftTargetNativeSelect');
        if (nativeSel) {
            nativeSel.value = targetNativeLang;
            nativeSel.onchange = () => setTargetNativeLang(nativeSel.value);
        }

        const pipBtn = q('ftPipToggleBtn');
        if (pipBtn) {
            pipBtn.onclick = () => {
                if (pipWindowRef && !pipWindowRef.closed) {
                    closePipWindow();
                } else {
                    openPipWindow();
                }
            };
        }

        const panelFsBtn = q('ftPanelFullscreenBtn');
        if (panelFsBtn) {
            panelFsBtn.onclick = () => {
                togglePanelFullscreen();
            };
        }

        const closeBtn = q('ftPanelCloseBtn');
        if (closeBtn) {
            closeBtn.onclick = () => {
                if (pipWindowRef && !pipWindowRef.closed) closePipWindow();
                collapsePanel();
            };
        }

        doc.querySelectorAll('[data-ft-tab]').forEach(btn => {
            btn.onclick = () => {
                switchTab(btn.getAttribute('data-ft-tab'));
            };
        });

        // 頁內與 Electron 視窗自由拖曳定位（支援全尺寸與 Android 平板 / 手機觸控）
        const dragHandle = q('ftPanelDragHandle');
        if (dragHandle && panelHostEl) {
            let pDragging = false;
            let sX = 0;
            let sY = 0;
            let lastScreenX = 0;
            let lastScreenY = 0;
            let sL = 0;
            let sT = 0;

            dragHandle.addEventListener('pointerdown', (e) => {
                if (pipWindowRef) return;
                if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
                if (e.target && e.target.closest('button, select, input, textarea, a, label')) return;
                pDragging = true;
                sX = e.clientX;
                sY = e.clientY;
                lastScreenX = e.screenX;
                lastScreenY = e.screenY;
                const rect = panelHostEl.getBoundingClientRect();
                sL = rect.left;
                sT = rect.top;
                if (!hasElectronWidgetBridge()) {
                    panelHostEl.style.right = 'auto';
                    panelHostEl.style.bottom = 'auto';
                }
                try { dragHandle.setPointerCapture(e.pointerId); } catch (err) {}
                e.preventDefault();
            });

            dragHandle.addEventListener('pointermove', (e) => {
                if (!pDragging) return;
                if (hasElectronWidgetBridge()) {
                    const sdx = e.screenX - lastScreenX;
                    const sdy = e.screenY - lastScreenY;
                    lastScreenX = e.screenX;
                    lastScreenY = e.screenY;
                    if (sdx !== 0 || sdy !== 0) {
                        global.LZHDesktopWidget.moveBy(sdx, sdy);
                    }
                    return;
                }
                const vw = global.innerWidth || document.documentElement.clientWidth || 1024;
                const vh = global.innerHeight || document.documentElement.clientHeight || 768;
                const insets = getEffectiveSafeInsets();
                const minTop = Math.max(12, insets.top + 8);
                const bottomPad = Math.max(12, insets.bottom + 8);
                const panelW = panelHostEl.offsetWidth || 320;
                const panelH = panelHostEl.offsetHeight || 360;
                const nextL = clamp(sL + (e.clientX - sX), 8, Math.max(8, vw - panelW - 8));
                const nextT = clamp(sT + (e.clientY - sY), minTop, Math.max(minTop, vh - panelH - bottomPad));
                panelHostEl.style.left = `${nextL}px`;
                panelHostEl.style.top = `${nextT}px`;
                posState.panelLeftPx = Math.round(nextL);
                posState.panelTopPx = Math.round(nextT);
            });

            const endPanelDrag = (e) => {
                if (!pDragging) return;
                pDragging = false;
                try { dragHandle.releasePointerCapture(e.pointerId); } catch (err) {}
                if (!hasElectronWidgetBridge()) savePositionState();
            };
            dragHandle.addEventListener('pointerup', endPanelDrag);
            dragHandle.addEventListener('pointercancel', endPanelDrag);
        }

        updatePipButtonState();
    }

    function computeFloatingUnreadFlags() {
        const uid = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) ? firebase.auth().currentUser.uid : '';
        const threads = Array.isArray(global.userChatThreads) ? global.userChatThreads : [];
        let hasUnreadChat = false;
        if (uid) {
            hasUnreadChat = threads.some(th => {
                if (!th) return false;
                if (typeof global.isThreadUnread === 'function') {
                    return global.isThreadUnread(th, uid);
                }
                const readAt = (th.readBy && th.readBy[uid]) || 0;
                const updAt = th.updatedAt || 0;
                return updAt > readAt && th.lastSenderUid !== uid;
            });
        }
        const hasUnreadReq = Boolean(uid && global.userData && global.userData.friendRequests && Object.keys(global.userData.friendRequests).length > 0);
        const lastReadNotice = Number(localStorage.getItem('lzhcard_last_read_notice_at') || 0);
        const anns = Array.isArray(global.cloudAnnouncements) ? global.cloudAnnouncements : [];
        const hasUnreadAnn = anns.some(ann => {
            const annTime = typeof ann?.createdAt === 'number' ? ann.createdAt : (ann?.time ? new Date(ann.time).getTime() : 0);
            return annTime > lastReadNotice;
        });
        return {
            hasChatRed: hasUnreadChat || hasUnreadReq,
            hasAnnAmber: hasUnreadAnn
        };
    }

    function refreshBallUnread() {
        const flags = computeFloatingUnreadFlags();
        const unreadDot = q('ftChatUnreadDot');
        if (unreadDot) {
            unreadDot.classList.toggle('hidden', !flags.hasChatRed);
        }
        const ballDot = q('ftBallUnreadDot') || document.getElementById('ftBallUnreadDot');
        if (ballDot) {
            if (flags.hasChatRed) {
                ballDot.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-rose-500 ring-2 ring-white dark:ring-slate-900 pointer-events-none';
                ballDot.classList.remove('hidden');
            } else if (flags.hasAnnAmber) {
                ballDot.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900 pointer-events-none';
                ballDot.classList.remove('hidden');
            } else {
                ballDot.classList.add('hidden');
            }
        }
        return flags;
    }

    function updateHeaderViewModeUI() {
        const toggleText = q('ftViewModeToggleText');
        const tabStrip = q('ftTranslatorTabStrip');
        const nativeSel = q('ftTargetNativeSelect');

        if (toggleText) {
            toggleText.innerHTML = panelViewMode === 'chat'
                ? `${FT_SVG.chat}<span>聊天</span>${FT_SVG.arrows}${FT_SVG.globe}<span>翻譯</span>`
                : `${FT_SVG.globe}<span>翻譯</span>${FT_SVG.arrows}${FT_SVG.chat}<span>聊天</span>`;
        }
        if (tabStrip) {
            tabStrip.classList.toggle('hidden', panelViewMode === 'chat');
        }
        if (nativeSel) {
            nativeSel.classList.toggle('hidden', panelViewMode === 'chat');
        }
        refreshBallUnread();
    }

    function setPanelViewMode(mode) {
        panelViewMode = mode === 'chat' ? 'chat' : 'translator';
        if (panelViewMode === 'chat') {
            stopCameraStream();
        } else {
            detachFloatingChatListeners();
        }
        updateHeaderViewModeUI();
        renderActiveTabBody();
        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed) && isOpen) {
            applyPanelPosition();
        }
    }

    function updateTabButtonsStyle() {
        const doc = getTargetDoc();
        doc.querySelectorAll('[data-ft-tab]').forEach(btn => {
            const tab = btn.getAttribute('data-ft-tab');
            if (tab === activeTab) {
                btn.className = 'py-1.5 px-2 rounded-xl text-[11px] font-extrabold transition inline-flex items-center justify-center gap-1 cursor-pointer bg-brand-600 text-white shadow-xs';
            } else {
                btn.className = 'py-1.5 px-2 rounded-xl text-[11px] font-bold transition inline-flex items-center justify-center gap-1 cursor-pointer bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600';
            }
        });
    }

    function togglePanelFullscreen(forceState) {
        panelFullscreen = typeof forceState === 'boolean' ? forceState : !panelFullscreen;
        if (hasElectronWidgetBridge() && typeof global.LZHDesktopWidget.setFullscreenViewer === 'function') {
            global.LZHDesktopWidget.setFullscreenViewer(panelFullscreen);
        }
        try {
            if (global.AndroidOverlay && typeof global.AndroidOverlay.setOverlayFullscreen === 'function') {
                global.AndroidOverlay.setOverlayFullscreen(panelFullscreen);
            } else if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.SystemOverlay && typeof global.Capacitor.Plugins.SystemOverlay.setOverlayFullscreen === 'function') {
                global.Capacitor.Plugins.SystemOverlay.setOverlayFullscreen({ isFullscreen: panelFullscreen });
            }
        } catch (e) {}
        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed)) {
            applyPanelPosition();
        }
        const fsBtn = q('ftPanelFullscreenBtn');
        if (fsBtn) {
            fsBtn.title = panelFullscreen ? '還原視窗尺寸' : '切換全螢幕';
            fsBtn.setAttribute('aria-pressed', panelFullscreen ? 'true' : 'false');
        }
    }

    function switchTab(tab) {
        const valid = ['camera', 'screen', 'subtitle'].includes(tab) ? tab : 'camera';
        if (activeTab === 'camera' && valid !== 'camera') {
            stopCameraStream();
            if (!photoImageDataUrl) {
                syncImageModeLock(false);
            }
        }
        panelViewMode = 'translator';
        activeTab = valid;
        updateHeaderViewModeUI();
        renderActiveTabBody();
        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed) && isOpen) {
            applyPanelPosition();
        }
    }

    async function triggerPanelGoogleLogin(btnEl) {
        if (typeof global.loginWithGoogle !== 'function') {
            toast('Google 登入模組尚未就緒，請稍候再試', 'warning');
            return;
        }
        const origHtml = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<span>正在連接 Google 登入...</span>';
        }
        try {
            await global.loginWithGoogle();
        } finally {
            if (btnEl && document.body.contains(btnEl)) {
                btnEl.disabled = false;
                btnEl.innerHTML = origHtml;
            }
            refreshBallUnread();
            if (isOpen) {
                renderActiveTabBody();
            }
        }
    }

    async function triggerPanelAppleLogin(btnEl) {
        if (typeof global.loginWithApple !== 'function') {
            toast('Apple 登入模組尚未就緒，請稍候再試', 'warning');
            return;
        }
        const origHtml = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<span>正在連接 Apple 登入...</span>';
        }
        try {
            await global.loginWithApple();
        } finally {
            if (btnEl && document.body.contains(btnEl)) {
                btnEl.disabled = false;
                btnEl.innerHTML = origHtml;
            }
            refreshBallUnread();
            if (isOpen) {
                renderActiveTabBody();
            }
        }
    }

    function renderDesktopWidgetLoginCard(body) {
        const showApple = isIosScreenTranslatePlatform() || (typeof global.isAppleSignInAvailable === 'function' && global.isAppleSignInAvailable());
        body.innerHTML = `
            <div class="h-full min-h-[300px] flex flex-col items-center justify-center p-5 text-center space-y-4 ft-motion-enter">
                <div class="w-14 h-14 rounded-2xl bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-800 flex items-center justify-center text-brand-600 dark:text-brand-300 shadow-xs">
                    ${FT_SVG.ballGlobe}
                </div>
                <div class="space-y-1.5 max-w-[280px]">
                    <div class="text-sm font-black text-slate-900 dark:text-white">LZHCard 桌面翻譯小工具</div>
                    <div class="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                        請登入帳號以同步雲端單字本、會員 AI 配額、即時雙語字幕與好友聊天室。
                    </div>
                </div>
                <div class="w-full max-w-[260px] flex flex-col gap-2">
                    ${showApple ? `
                        <button type="button" id="ftWidgetAppleLoginBtn" class="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-black text-white border border-slate-800 text-xs font-extrabold shadow-md transition flex items-center justify-center gap-2 cursor-pointer">
                            <i class="fa-brands fa-apple text-sm"></i>
                            <span>使用 Apple 帳號登入</span>
                        </button>
                    ` : ''}
                    <button type="button" id="ftWidgetGoogleLoginBtn" class="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-md transition flex items-center justify-center gap-2 cursor-pointer">
                        <i class="fa-brands fa-google text-sm"></i>
                        <span>登入 Google 帳號以開始使用</span>
                    </button>
                </div>
                <div class="text-[10px] text-slate-400 dark:text-slate-500">
                    登入完成後將自動切換回翻譯／即時字幕功能介面
                </div>
            </div>
        `;
        const appleBtn = q('ftWidgetAppleLoginBtn');
        if (appleBtn) {
            appleBtn.onclick = () => triggerPanelAppleLogin(appleBtn);
        }
        const loginBtn = q('ftWidgetGoogleLoginBtn');
        if (loginBtn) {
            loginBtn.onclick = () => triggerPanelGoogleLogin(loginBtn);
        }
    }

    function renderActiveTabBody() {
        updateHeaderViewModeUI();
        updateTabButtonsStyle();
        const body = q('ftTabBody');
        if (!body) return;

        if (isDesktopWidgetShell() && !getSignedInGoogleUser()) {
            renderDesktopWidgetLoginCard(body);
            return;
        }

        if (panelViewMode === 'chat') {
            renderFloatingChatBody(body);
            return;
        }

        if (activeTab === 'camera') {
            renderCameraTabHtml(body);
        } else if (activeTab === 'screen') {
            renderScreenTabHtml(body);
        } else {
            renderSubtitleTabHtml(body);
        }
    }

    function detachFloatingChatListeners() {
        try {
            if (typeof firebase !== 'undefined' && firebase.database && ftChatListenerPath) {
                const rtdb = firebase.database();
                if (ftChatMsgsListener) rtdb.ref(`chats/${ftChatListenerPath}/messages`).off('value', ftChatMsgsListener);
                if (ftChatReadListener) rtdb.ref(`chats/${ftChatListenerPath}/readBy`).off('value', ftChatReadListener);
            }
        } catch (e) {}
        ftChatMsgsListener = null;
        ftChatReadListener = null;
        ftChatListenerPath = '';
    }

    function openFloatingChatRoom(chatId, displayTitle, peerUid = '') {
        const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
        const rtdb = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
        if (!authUser || authUser.isAnonymous || !rtdb || !chatId) return;

        detachFloatingChatListeners();
        ftActiveChatId = chatId;
        ftActiveChatTitle = displayTitle || '好友聊天室';
        ftActiveChatPeerUid = peerUid || '';
        ftChatMessages = [];
        ftChatReadByMap = {};
        ftChatListenerPath = chatId;

        rtdb.ref(`chats/${chatId}/readBy/${authUser.uid}`).set(Date.now()).catch(() => {});

        ftChatMsgsListener = rtdb.ref(`chats/${chatId}/messages`).on('value', (snap) => {
            const raw = snap.val() || {};
            const msgs = [];
            Object.keys(raw).forEach(k => {
                if (raw[k] && typeof raw[k] === 'object') {
                    msgs.push({ id: k, ...raw[k] });
                }
            });
            msgs.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
            ftChatMessages = msgs.slice(-80);
            if (isOpen && panelViewMode === 'chat' && ftActiveChatId === chatId) {
                rtdb.ref(`chats/${chatId}/readBy/${authUser.uid}`).set(Date.now()).catch(() => {});
                renderActiveTabBody();
            }
        });

        ftChatReadListener = rtdb.ref(`chats/${chatId}/readBy`).on('value', (snap) => {
            ftChatReadByMap = snap.val() || {};
            if (isOpen && panelViewMode === 'chat' && ftActiveChatId === chatId) {
                renderActiveTabBody();
            }
        });

        renderActiveTabBody();
    }

    async function sendFloatingChatMessage(text) {
        const clean = String(text || '').trim();
        if (!clean || !ftActiveChatId || ftChatSending) return;
        const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
        const rtdb = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
        if (!authUser || authUser.isAnonymous || !rtdb) {
            toast('請先登入帳號即可傳送訊息', 'warning');
            return;
        }

        ftChatSending = true;
        const myName = (global.userData && global.userData.nickname) || authUser.displayName || (authUser.email ? authUser.email.split('@')[0] : '玩家');
        const myAvatar = authUser.photoURL || (global.userData && global.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authUser.uid)}`;
        const myFrame = (global.userData && global.userData.cosmetics && global.userData.cosmetics.frame) || 'default';
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const nowMs = Date.now();

        try {
            const msgRef = rtdb.ref(`chats/${ftActiveChatId}/messages`).push();
            await msgRef.set({
                sender: myName,
                senderUid: authUser.uid,
                senderAvatar: myAvatar,
                senderFrame: myFrame,
                text: clean,
                time: timeStr,
                createdAt: nowMs
            });
            await rtdb.ref(`chats/${ftActiveChatId}`).update({
                lastMessage: `${myName}: ${clean}`,
                lastSenderUid: authUser.uid,
                updatedAt: nowMs
            });
            await rtdb.ref(`chats/${ftActiveChatId}/readBy/${authUser.uid}`).set(nowMs);
        } catch (err) {
            toast('傳送訊息失敗：' + (err && err.message ? err.message : '網路錯誤'), 'error');
        } finally {
            ftChatSending = false;
        }
    }

    function renderFloatingChatBody(body) {
        const authUser = getSignedInGoogleUser();
        if (!authUser) {
            const showApple = isIosScreenTranslatePlatform() || (typeof global.isAppleSignInAvailable === 'function' && global.isAppleSignInAvailable());
            body.innerHTML = `
                <div class="p-6 text-center space-y-3 ft-motion-enter">
                    <div class="w-12 h-12 mx-auto rounded-2xl bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-800 flex items-center justify-center">${FT_SVG.chatLg}</div>
                    <div class="text-xs font-extrabold text-slate-700 dark:text-slate-200">請先登入帳號即可開啟懸浮好友聊天</div>
                    <div class="text-[11px] text-slate-500 dark:text-slate-400">可與學習好友即時對話，並隨時切回三語翻譯功能</div>
                    <div class="flex flex-col items-center gap-2">
                        ${showApple ? `
                            <button type="button" id="ftChatAppleLoginBtn" class="w-full max-w-[240px] min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-black text-white border border-slate-800 text-xs font-extrabold shadow-xs transition inline-flex items-center justify-center gap-2 cursor-pointer">
                                <i class="fa-brands fa-apple text-sm"></i>
                                <span>使用 Apple 帳號登入</span>
                            </button>
                        ` : ''}
                        <button type="button" id="ftChatGoogleLoginBtn" class="w-full max-w-[240px] min-h-[44px] px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-xs transition inline-flex items-center justify-center gap-2 cursor-pointer">
                            <i class="fa-brands fa-google text-xs"></i>
                            <span>登入 Google 帳號以開始使用</span>
                        </button>
                    </div>
                </div>
            `;
            const chatAppleBtn = q('ftChatAppleLoginBtn');
            if (chatAppleBtn) {
                chatAppleBtn.onclick = () => triggerPanelAppleLogin(chatAppleBtn);
            }
            const chatLoginBtn = q('ftChatGoogleLoginBtn');
            if (chatLoginBtn) {
                chatLoginBtn.onclick = () => triggerPanelGoogleLogin(chatLoginBtn);
            }
            return;
        }

        const myUid = authUser.uid;
        if (ftActiveChatId) {
            const peerStatus = (ftActiveChatPeerUid && global.onlineUsersMap) ? global.onlineUsersMap[ftActiveChatPeerUid] : null;
            const peerOnline = Boolean(peerStatus && peerStatus.online && !peerStatus.hidePrivacy);

            body.innerHTML = `
                <div class="flex flex-col h-[52vh] max-h-[420px]">
                    <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-700 shrink-0">
                        <button type="button" id="ftChatBackListBtn" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-xs font-bold cursor-pointer">← 返回</button>
                        <div class="flex items-center gap-1.5 min-w-0 flex-1 justify-center">
                            <span class="w-2 h-2 rounded-full ${peerOnline ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
                            <span class="text-xs font-black truncate">${escapeHtml(ftActiveChatTitle)}</span>
                        </div>
                        <span class="w-10"></span>
                    </div>

                    <div id="ftFloatingChatMsgScroll" class="flex-1 overflow-y-auto py-2 space-y-2 pr-1">
                        ${ftChatMessages.length === 0
                            ? '<div class="py-8 text-center text-[11px] text-slate-500 dark:text-slate-400">尚無訊息，傳送第一句打聲招呼吧！</div>'
                            : ftChatMessages.map(m => {
                                const isMe = m.senderUid === myUid;
                                let readByOther = false;
                                if (isMe) {
                                    Object.keys(ftChatReadByMap).forEach(uid => {
                                        if (uid !== myUid && (ftChatReadByMap[uid] || 0) >= (m.createdAt || 0)) {
                                            readByOther = true;
                                        }
                                    });
                                }
                                return `
                                    <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} gap-0.5">
                                        ${!isMe ? `<span class="text-[10px] font-bold text-slate-400 px-1">${escapeHtml(m.sender || '')}</span>` : ''}
                                        <div class="max-w-[82%] px-3 py-1.5 text-xs leading-relaxed break-words shadow-xs ${isMe ? 'ft-chat-bubble-self' : 'ft-chat-bubble-peer'}">${escapeHtml(m.text || '')}</div>
                                        <div class="flex items-center gap-1 px-1 text-[9px] text-slate-400">
                                            ${isMe && readByOther ? '<span class="text-brand-500 font-bold">已讀</span>' : ''}
                                            <span>${escapeHtml(m.time || '')}</span>
                                        </div>
                                    </div>
                                `;
                            }).join('')
                        }
                    </div>

                    <form id="ftFloatingChatSendForm" class="pt-2 border-t border-slate-100 dark:border-slate-700 flex items-center gap-1.5 shrink-0">
                        <input type="text" id="ftFloatingChatInput" placeholder="輸入訊息..." class="flex-1 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs outline-none">
                        <button type="submit" class="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold cursor-pointer">送出</button>
                    </form>
                </div>
            `;

            const scrollBox = q('ftFloatingChatMsgScroll');
            if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;

            const backBtn = q('ftChatBackListBtn');
            if (backBtn) {
                backBtn.onclick = () => {
                    detachFloatingChatListeners();
                    ftActiveChatId = '';
                    ftActiveChatPeerUid = '';
                    renderActiveTabBody();
                };
            }

            const sendForm = q('ftFloatingChatSendForm');
            const chatInp = q('ftFloatingChatInput');
            if (sendForm && chatInp) {
                sendForm.onsubmit = async (e) => {
                    e.preventDefault();
                    const val = chatInp.value.trim();
                    if (!val) return;
                    chatInp.value = '';
                    await sendFloatingChatMessage(val);
                };
            }
            return;
        }

        // 好友 & 聊天室清單
        const friendsMap = (global.userData && global.userData.friends && typeof global.userData.friends === 'object')
            ? global.userData.friends
            : {};
        const threads = Array.isArray(global.userChatThreads) ? global.userChatThreads : [];
        const threadById = new Map(threads.map(th => [th.id, th]));

        const roomItems = [];
        Object.keys(friendsMap).forEach(k => {
            const f = friendsMap[k] || {};
            const fUid = f.uid || k;
            if (!fUid || fUid === myUid) return;
            const chatId = [myUid, fUid].sort().join('_');
            const th = threadById.get(chatId);
            const status = (global.onlineUsersMap && global.onlineUsersMap[fUid]) || null;
            const online = Boolean(status && status.online && !status.hidePrivacy);
            const unread = Boolean(th && (th.updatedAt || 0) > ((th.readBy && th.readBy[myUid]) || 0) && th.lastSenderUid !== myUid);
            roomItems.push({
                chatId,
                peerUid: fUid,
                name: f.nickname || f.username || f.name || '好友',
                avatar: f.avatar || (status && status.avatar) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(fUid)}`,
                preview: (th && th.lastMessage) || '點擊開啟 1對1 常駐對話',
                online,
                unread,
                updatedAt: (th && th.updatedAt) || 0
            });
        });

        threads.forEach(th => {
            if (!th || !th.id || th.type !== 'group') return;
            const unread = Boolean((th.updatedAt || 0) > ((th.readBy && th.readBy[myUid]) || 0) && th.lastSenderUid !== myUid);
            roomItems.push({
                chatId: th.id,
                peerUid: '',
                name: th.name || '群組聊天室',
                avatar: `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(th.id)}`,
                preview: th.lastMessage || '群組頻道',
                online: false,
                unread,
                updatedAt: th.updatedAt || 0
            });
        });

        const kw = ftChatFilterText.trim().toLowerCase();
        const filtered = roomItems
            .filter(r => !kw || r.name.toLowerCase().includes(kw) || r.preview.toLowerCase().includes(kw))
            .sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.updatedAt - a.updatedAt);

        body.innerHTML = `
            <div class="space-y-2">
                <input type="text" id="ftChatSearchInput" value="${escapeHtml(ftChatFilterText)}" placeholder="搜尋好友或聊天室..." class="w-full px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs outline-none">
                <div class="space-y-1.5 max-h-[46vh] overflow-y-auto pr-0.5">
                    ${filtered.length === 0
                        ? '<div class="py-6 text-center text-[11px] text-slate-500 dark:text-slate-400">尚無符合的好友或聊天頻道</div>'
                        : filtered.map(r => `
                            <button type="button" data-ft-chat-open="${escapeHtml(r.chatId)}" data-ft-chat-title="${escapeHtml(r.name)}" data-ft-chat-peer="${escapeHtml(r.peerUid)}" class="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/90 hover:bg-brand-50 dark:hover:bg-slate-700/70 border border-slate-200 dark:border-slate-700 flex items-center gap-2.5 text-left cursor-pointer transition">
                                <div class="relative shrink-0">
                                    <img src="${escapeHtml(r.avatar)}" alt="${escapeHtml(r.name)}" class="w-9 h-9 rounded-full object-cover bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                                    <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${r.online ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <div class="flex items-center justify-between gap-1">
                                        <span class="text-xs font-extrabold text-slate-900 dark:text-white truncate">${escapeHtml(r.name)}</span>
                                        ${r.unread ? '<span class="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>' : ''}
                                    </div>
                                    <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">${escapeHtml(r.preview)}</div>
                                </div>
                            </button>
                        `).join('')
                    }
                </div>
            </div>
        `;

        const searchInp = q('ftChatSearchInput');
        if (searchInp) {
            searchInp.oninput = () => {
                ftChatFilterText = searchInp.value;
                renderActiveTabBody();
            };
        }

        body.querySelectorAll('[data-ft-chat-open]').forEach(btn => {
            btn.onclick = () => {
                openFloatingChatRoom(
                    btn.getAttribute('data-ft-chat-open'),
                    btn.getAttribute('data-ft-chat-title'),
                    btn.getAttribute('data-ft-chat-peer')
                );
            };
        });
    }

    function renderCameraTabHtml(body) {
        const cats = getDeckCategoriesList();
        const curDeck = getPreferredTargetDeckName();
        const selCount = photoSelectedTokenIds.size;

        body.innerHTML = `
            <input type="file" id="ftPhotoCameraInput" accept="image/*" capture="environment" class="hidden">
            <input type="file" id="ftPhotoGalleryInput" accept="image/*" class="hidden">

            <div class="grid grid-cols-3 gap-1.5">
                <button type="button" id="ftStartLiveCamBtn" class="py-2 px-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.camera}<span>即時鏡頭</span></button>
                <button type="button" id="ftTakePhotoFileBtn" class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-800 dark:text-slate-100 text-[11px] font-bold inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.shutter}<span>拍照</span></button>
                <button type="button" id="ftPickGalleryBtn" class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-800 dark:text-slate-100 text-[11px] font-bold inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.gallery}<span>相簿</span></button>
            </div>

            <div id="ftLiveCameraWrap" class="${cameraStream ? '' : 'hidden'} rounded-xl overflow-hidden bg-black relative">
                <video id="ftCameraVideo" autoplay playsinline muted class="w-full max-h-48 object-cover"></video>
                <div class="p-2 flex items-center justify-between gap-2 bg-slate-900/90">
                    <button type="button" id="ftCaptureShutterBtn" class="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer">${FT_SVG.shutter}<span>擷取並定位辨識</span></button>
                    <button type="button" id="ftStopCamBtn" class="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold cursor-pointer">關閉</button>
                </div>
            </div>

            <div class="flex items-center justify-between gap-1.5">
                <div class="flex items-center gap-1">
                    <button type="button" id="ftPhotoModeLookupBtn" class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold inline-flex items-center gap-1 cursor-pointer ${photoMode === 'lookup' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">${FT_SVG.cursor}<span>點擊查義</span></button>
                    <button type="button" id="ftPhotoModeSelectBtn" class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold inline-flex items-center gap-1 cursor-pointer ${photoMode === 'select' ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">${FT_SVG.checkbox}<span>選取入庫</span></button>
                </div>
                <div class="flex items-center gap-1">
                    ${photoImageDataUrl ? `<button type="button" id="ftPhotoFullscreenBtn" class="px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-extrabold inline-flex items-center gap-1 cursor-pointer">${FT_SVG.expand}<span>全螢幕</span></button>` : ''}
                    ${photoTokens.length > 0 ? `
                    <button type="button" id="ftPhotoSelectAllBtn" class="px-2 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold cursor-pointer">全選</button>
                    <button type="button" id="ftPhotoClearSelBtn" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold cursor-pointer">清空</button>
                    ` : ''}
                </div>
            </div>

            ${isVisionBusy ? `
                <div class="p-3 rounded-xl bg-cyan-50/80 dark:bg-cyan-950/35 border border-cyan-300/60 dark:border-cyan-700/60 text-center space-y-1">
                    <div class="text-xs font-extrabold text-cyan-700 dark:text-cyan-300 inline-flex items-center justify-center gap-1.5">
                        <span class="ft-live-dot" style="background:#06b6d4;box-shadow:0 0 8px rgba(6,182,212,0.8);"></span>
                        <span>視覺取詞引擎 · 偵測框校準中...</span>
                    </div>
                    <div class="text-[11px] text-slate-500 dark:text-slate-400">完成後可直接點擊圖片熱區查義或切換選取入庫</div>
                </div>
            ` : ''}

            ${photoImageDataUrl ? `
                <div class="space-y-1">
                    <div class="flex items-center justify-end gap-1">
                        <button type="button" id="ftInlineZoomOutBtn" class="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-bold cursor-pointer">－</button>
                        <button type="button" id="ftInlineZoomResetBtn" class="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-brand-600 dark:text-brand-300 text-[11px] font-mono font-extrabold cursor-pointer">${Math.round(inlinePhotoZoom.scale * 100)}%</button>
                        <button type="button" id="ftInlineZoomInBtn" class="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-bold cursor-pointer">＋</button>
                    </div>
                    <div id="ftInlineStageViewport" class="ft-zoom-stage-viewport rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 max-h-60">
                        <div id="ftPhotoInlineStage" class="ft-zoom-stage-box rounded-lg overflow-hidden">
                            <img id="ftInlineStageImg" src="${photoImageDataUrl}" alt="辨識照片" class="block max-w-full max-h-56 w-auto h-auto rounded-lg select-none" style="object-fit:contain;">
                            ${isVisionBusy ? `
                                <div class="ft-scanline-layer" aria-hidden="true">
                                    <div class="ft-scanline-beam"></div>
                                    <span class="ft-reticle-corner ft-reticle-tl"></span>
                                    <span class="ft-reticle-corner ft-reticle-tr"></span>
                                    <span class="ft-reticle-corner ft-reticle-bl"></span>
                                    <span class="ft-reticle-corner ft-reticle-br"></span>
                                </div>
                            ` : ''}
                            <div id="ftPhotoOverlay" class="absolute inset-0">
                                ${photoTokens.map(tk => {
                                    const rect = box1000ToPercentRect(tk.box);
                                    if (!rect) return '';
                                    const isSel = photoSelectedTokenIds.has(tk.id);
                                    const isAct = photoActiveTokenId === tk.id;
                                    const cls = ['ft-photo-hotspot', isSel ? 'ft-photo-hotspot-selected' : '', isAct ? 'ft-photo-hotspot-active' : ''].filter(Boolean).join(' ');
                                    return `<button type="button" data-ft-tok-id="${escapeHtml(tk.id)}" title="${escapeHtml(tk.text)}" class="${cls}" style="top:${rect.topPct}%;left:${rect.leftPct}%;width:${rect.widthPct}%;height:${rect.heightPct}%;"></button>`;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                </div>
            ` : `
                <div class="p-5 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 text-center space-y-1.5 text-slate-500 dark:text-slate-400">
                    <div class="w-11 h-11 mx-auto rounded-xl bg-slate-100 dark:bg-slate-900 flex items-center justify-center">${FT_SVG.cameraLg}</div>
                    <div class="text-xs font-bold text-slate-700 dark:text-slate-200">視覺取詞：課本 / 路牌 / 截圖辨識（電腦可按 Ctrl+V 貼圖）</div>
                    <div class="text-[11px]">支援英文、日文（純平假名標音）、中文三語熱區精準點詞</div>
                </div>
            `}

            ${photoSummary ? `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs leading-relaxed">
                    <div class="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 mb-0.5">圖片重點摘要</div>
                    <div class="text-slate-700 dark:text-slate-200 font-semibold">${escapeHtml(photoSummary)}</div>
                </div>
            ` : ''}

            ${photoImageDataUrl ? `
                <div class="p-2.5 rounded-xl bg-amber-50/70 dark:bg-slate-900 border border-amber-200 dark:border-amber-800/70 space-y-2">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button type="button" id="ftPhotoFullTranslateBtn" ${isPhotoArticleTranslating ? 'disabled' : ''} class="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-xs font-extrabold inline-flex items-center gap-1 cursor-pointer shadow-2xs">
                            ${FT_SVG.sparkle}<span>${isPhotoArticleTranslating ? '整篇翻譯中...' : '整篇翻譯成中文'}</span>
                        </button>
                        ${photoArticleTranslation ? `
                            <button type="button" id="ftPhotoCopyFullTransBtn" class="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-bold cursor-pointer">複製整篇譯文</button>
                            <button type="button" id="ftPhotoToggleViewBtn" class="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-bold cursor-pointer">${photoArticleViewMode === 'both' ? '僅看譯文' : '原文對照'}</button>
                        ` : ''}
                    </div>
                    ${photoArticleTranslation ? `
                        <div class="p-2.5 rounded-xl bg-white dark:bg-slate-950 border border-amber-200/80 dark:border-slate-700 max-h-48 overflow-y-auto space-y-1.5 select-text">
                            ${photoArticleViewMode === 'both' && getEffectivePhotoRawText() ? `
                                <div class="text-[11px] text-slate-500 dark:text-slate-400 whitespace-pre-wrap leading-relaxed pb-1.5 border-b border-slate-100 dark:border-slate-800">${escapeHtml(getEffectivePhotoRawText())}</div>
                            ` : ''}
                            <div class="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">${escapeHtml(photoArticleTranslation)}</div>
                        </div>
                    ` : '<div class="text-[11px] text-amber-800/80 dark:text-amber-300/80">可保留原本段落與換行，一鍵翻成完整繁體中文文章；也仍可點擊圖片單字入庫。</div>'}
                </div>
            ` : ''}

            ${(photoMode === 'select' || selCount > 0) ? `
                <div class="p-2.5 rounded-xl bg-emerald-50/70 dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 space-y-2">
                    <div class="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                        ${selCount === 0
                            ? '<span class="text-[11px] text-slate-500 dark:text-slate-400">點擊圖片方框勾選欲收錄的單字</span>'
                            : photoTokens.filter(tk => photoSelectedTokenIds.has(tk.id)).map(tk => `
                                <button type="button" data-ft-chip-remove="${escapeHtml(tk.id)}" class="px-2 py-0.5 rounded-lg bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 cursor-pointer">
                                    ${escapeHtml(tk.text)} ×
                                </button>
                            `).join('')
                        }
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5">
                        <select id="ftDeckSelect" class="flex-1 min-w-[120px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none">
                            ${cats.map(c => `<option value="${escapeHtml(c)}" ${c === curDeck ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                            <option value="__NEW__">＋ 新增字庫...</option>
                        </select>
                        <input type="text" id="ftNewDeckInput" placeholder="輸入新字庫名稱" class="hidden flex-1 min-w-[110px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-emerald-400 text-xs font-bold outline-none">
                        <button type="button" id="ftPhotoConfirmImportBtn" ${selCount === 0 ? 'disabled' : ''} class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-extrabold cursor-pointer">
                            確認收錄 (${selCount})
                        </button>
                    </div>
                </div>
            ` : ''}
        `;

        // 綁定相機頁籤事件
        const camInp = q('ftPhotoCameraInput');
        const galInp = q('ftPhotoGalleryInput');
        if (camInp) camInp.onchange = (e) => e.target.files[0] && handlePhotoFile(e.target.files[0]);
        if (galInp) galInp.onchange = (e) => e.target.files[0] && handlePhotoFile(e.target.files[0]);

        const startCamBtn = q('ftStartLiveCamBtn');
        if (startCamBtn) startCamBtn.onclick = startLiveCamera;
        const takeFileBtn = q('ftTakePhotoFileBtn');
        if (takeFileBtn) takeFileBtn.onclick = () => triggerPhotoFileInput(true);
        const pickGalBtn = q('ftPickGalleryBtn');
        if (pickGalBtn) pickGalBtn.onclick = () => triggerPhotoFileInput(false);
        const shutterBtn = q('ftCaptureShutterBtn');
        if (shutterBtn) shutterBtn.onclick = captureLiveCameraFrame;
        const stopCamBtn = q('ftStopCamBtn');
        if (stopCamBtn) stopCamBtn.onclick = stopCameraStream;

        const modeLookBtn = q('ftPhotoModeLookupBtn');
        if (modeLookBtn) modeLookBtn.onclick = () => setPhotoMode('lookup');
        const modeSelBtn = q('ftPhotoModeSelectBtn');
        if (modeSelBtn) modeSelBtn.onclick = () => setPhotoMode('select');
        const fsBtn = q('ftPhotoFullscreenBtn');
        if (fsBtn) fsBtn.onclick = openPhotoFullscreenViewer;

        const selAllBtn = q('ftPhotoSelectAllBtn');
        if (selAllBtn) {
            selAllBtn.onclick = () => {
                photoTokens.forEach(tk => photoSelectedTokenIds.add(tk.id));
                photoMode = 'select';
                renderActiveTabBody();
            };
        }
        const clearBtn = q('ftPhotoClearSelBtn');
        if (clearBtn) {
            clearBtn.onclick = () => {
                photoSelectedTokenIds.clear();
                renderActiveTabBody();
            };
        }

        const inlineVp = q('ftInlineStageViewport');
        const inlineStage = q('ftPhotoInlineStage');
        const inlineImg = q('ftInlineStageImg');
        if (inlineImg) {
            inlineImg.onload = () => syncImageModeLock(true);
        }
        const inlineZoomReset = q('ftInlineZoomResetBtn');
        const inlineZoomIn = q('ftInlineZoomInBtn');
        const inlineZoomOut = q('ftInlineZoomOutBtn');
        if (inlineVp && inlineStage) {
            bindPhotoZoomGestures(inlineVp, inlineStage, inlinePhotoZoom, inlineZoomReset);
            if (inlineZoomIn) inlineZoomIn.onclick = () => {
                inlinePhotoZoom.scale = clamp(inlinePhotoZoom.scale + 0.25, 0.75, 2.5);
                applyPhotoZoomTransform(inlineStage, inlinePhotoZoom, inlineZoomReset);
            };
            if (inlineZoomOut) inlineZoomOut.onclick = () => {
                inlinePhotoZoom.scale = clamp(inlinePhotoZoom.scale - 0.25, 0.75, 2.5);
                applyPhotoZoomTransform(inlineStage, inlinePhotoZoom, inlineZoomReset);
            };
            if (inlineZoomReset) inlineZoomReset.onclick = () => {
                inlinePhotoZoom = { scale: 1, tx: 0, ty: 0 };
                applyPhotoZoomTransform(inlineStage, inlinePhotoZoom, inlineZoomReset);
            };
        }

        const overlay = q('ftPhotoOverlay');
        if (overlay) {
            overlay.querySelectorAll('[data-ft-tok-id]').forEach(btn => {
                btn.onclick = (ev) => {
                    ev.stopPropagation();
                    if (Date.now() < ftPhotoPinchGuardUntil) return;
                    const tid = btn.getAttribute('data-ft-tok-id');
                    const tk = photoTokens.find(item => item.id === tid);
                    handlePhotoHotspotClick(tk, btn);
                };
            });
        }

        body.querySelectorAll('[data-ft-chip-remove]').forEach(chip => {
            chip.onclick = () => {
                photoSelectedTokenIds.delete(chip.getAttribute('data-ft-chip-remove'));
                renderActiveTabBody();
            };
        });

        const deckSel = q('ftDeckSelect');
        const newInp = q('ftNewDeckInput');
        if (deckSel && newInp) {
            deckSel.onchange = () => {
                newInp.classList.toggle('hidden', deckSel.value !== '__NEW__');
                if (deckSel.value === '__NEW__') newInp.focus();
            };
        }

        const confirmBtn = q('ftPhotoConfirmImportBtn');
        if (confirmBtn) confirmBtn.onclick = () => confirmImportSelectedPhotoTokens();

        const fullTransBtn = q('ftPhotoFullTranslateBtn');
        if (fullTransBtn) fullTransBtn.onclick = () => translatePhotoArticleToChinese();
        const copyFullBtn = q('ftPhotoCopyFullTransBtn');
        if (copyFullBtn) copyFullBtn.onclick = () => copyPhotoArticleTranslation();
        const toggleViewBtn = q('ftPhotoToggleViewBtn');
        if (toggleViewBtn) {
            toggleViewBtn.onclick = () => {
                photoArticleViewMode = photoArticleViewMode === 'both' ? 'trans' : 'both';
                renderActiveTabBody();
                if (photoFullscreenOpen) renderPhotoFullscreenModal();
            };
        }
    }

    function renderScreenTabHtml(body) {
        const segHtml = screenScratchText
            ? renderClickableTokensHtml(screenScratchText)
            : '<span class="text-[11px] text-slate-500 dark:text-slate-400">在下方輸入或貼上英文／日文／中文句子，系統會以 Intl.Segmenter 自動精準斷詞，點擊任一詞即可查義入庫。</span>';

        body.innerHTML = `
            <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <label class="flex items-center justify-between gap-2 cursor-pointer">
                    <div>
                        <div class="text-xs font-extrabold text-slate-900 dark:text-white inline-flex items-center gap-1.5">${FT_SVG.screen}<span>螢幕點譯 · 全域字詞解析</span></div>
                        <div class="text-[11px] text-slate-500 dark:text-slate-400">開啟後直接點擊畫面字詞即跳出三語釋義氣泡（自動避開測驗模式）</div>
                    </div>
                    <input type="checkbox" id="ftScreenTapToggle" ${screenTapEnabled ? 'checked' : ''} class="w-4 h-4 accent-brand-600 cursor-pointer">
                </label>
                <button type="button" id="ftPageSelectModeBtn" class="${pageSelectMode ? 'w-full py-2 px-3 rounded-xl bg-amber-500 text-white text-xs font-extrabold cursor-pointer flex items-center justify-center gap-1.5 shadow-xs' : 'w-full py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-bold cursor-pointer flex items-center justify-center gap-1.5'}">
                    ${FT_SVG.checkbox}<span>${pageSelectMode ? '頁面選取模式進行中（點頁面單字反白）' : '開啟「頁面點詞選取」模式'}</span>
                </button>
            </div>

            <div class="space-y-1.5">
                <div class="text-[11px] font-extrabold text-slate-600 dark:text-slate-300">三語分詞試譯區（EN / JA / ZH 混排皆可點擊）</div>
                <textarea id="ftScreenScratchInput" rows="3" placeholder="貼上任何英文、日文（如：今日はいい天気ですね）或中文文章..." class="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs outline-none">${escapeHtml(screenScratchText)}</textarea>
                <div class="flex items-center gap-2">
                    <button type="button" id="ftScreenTranslateBtn" ${isScreenTextBusy ? 'disabled' : ''} class="flex-1 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer">
                        ${FT_SVG.sparkle}<span>${isScreenTextBusy ? '翻譯分詞中...' : '✨ AI 斷詞與整句翻譯（消耗解析額度）'}</span>
                    </button>
                    <button type="button" id="ftScreenClearBtn" class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-xs font-bold cursor-pointer">清空</button>
                </div>
            </div>

            <div class="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="text-[10px] font-extrabold text-slate-500 dark:text-slate-400">可點擊分詞結果：</div>
                <div class="text-sm leading-relaxed font-medium text-slate-800 dark:text-slate-100">${segHtml}</div>
                ${screenScratchTranslation ? `
                    <div class="pt-2 border-t border-slate-100 dark:border-slate-700 text-xs font-semibold text-emerald-700 dark:text-emerald-300 leading-relaxed">
                        ${escapeHtml(screenScratchTranslation)}
                    </div>
                ` : ''}
            </div>
        `;

        const tapChk = q('ftScreenTapToggle');
        if (tapChk) tapChk.onchange = () => setScreenTapEnabled(tapChk.checked);
        const selBtn = q('ftPageSelectModeBtn');
        if (selBtn) selBtn.onclick = () => setPageSelectionMode(!pageSelectMode);

        const inp = q('ftScreenScratchInput');
        if (inp) {
            inp.oninput = () => { screenScratchText = inp.value; };
        }
        const transBtn = q('ftScreenTranslateBtn');
        if (transBtn) {
            transBtn.onclick = async () => {
                screenScratchText = inp ? inp.value.trim() : screenScratchText.trim();
                if (!screenScratchText) return;
                isScreenTextBusy = true;
                renderActiveTabBody();
                try {
                    const detected = detectScriptLang(screenScratchText);
                    const nativeCfg = getNativeLangConfig(targetNativeLang);
                    let trans = '';
                    const canCloudScratch = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.canConsumeAiQuota === 'function')
                        ? global.MembershipEngine.canConsumeAiQuota('def_fill').allowed
                        : true;
                    if (canCloudScratch && typeof global.callGeminiApi === 'function') {
                        try {
                            trans = String(await global.callGeminiApi(`將以下文字通順翻譯成「${nativeCfg.aiName}」。自動忽略殘留 OCR 亂碼符號，遇到口語俚語依語境自然意譯（例如 new whip -> 新車／座駕），僅輸出譯文：\n${screenScratchText}`, { silent: true, feature: 'def_fill' }) || '').trim();
                        } catch (e) {}
                    }
                    if (!trans) {
                        try { trans = await fetchGoogleTranslateFallback(screenScratchText, detected, nativeCfg.code); } catch (e) {}
                    }
                    screenScratchTranslation = trans;
                } finally {
                    isScreenTextBusy = false;
                    renderActiveTabBody();
                }
            };
        }
        const clrBtn = q('ftScreenClearBtn');
        if (clrBtn) {
            clrBtn.onclick = () => {
                screenScratchText = '';
                screenScratchTranslation = '';
                renderActiveTabBody();
            };
        }
    }

    function renderSubtitleTabHtml(body) {
        const videoActive = Boolean(videoMonitorTimer);
        const totalYtMs = ytCues.length ? ytCues[ytCues.length - 1].endMs : 0;
        const streamLive = Boolean(videoMonitorTimer || sttRunning || ytPlaying);

        body.innerHTML = `
            <div class="flex items-center justify-between gap-2 px-1">
                <span class="text-[10.5px] font-extrabold tracking-wider uppercase text-slate-500 dark:text-slate-400">即時雙語串流引擎</span>
                ${streamLive ? `
                    <span class="ft-live-beacon"><span class="ft-live-dot"></span><span>LIVE SYNC</span><span class="ft-eq-bars" aria-hidden="true"><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span><span class="ft-eq-bar"></span></span></span>
                ` : '<span class="text-[10px] font-bold text-slate-400">STANDBY</span>'}
            </div>

            <div class="grid grid-cols-3 gap-1">
                <button type="button" id="ftSubVideoModeBtn" class="py-1.5 px-1.5 rounded-xl text-[11px] font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer ${subtitleSubMode === 'video' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">${FT_SVG.screen}<span>幀差字幕</span></button>
                <button type="button" id="ftSubSttModeBtn" class="py-1.5 px-1.5 rounded-xl text-[11px] font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer ${subtitleSubMode === 'stt' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">${FT_SVG.mic}<span>語音字幕</span></button>
                <button type="button" id="ftSubYtModeBtn" class="py-1.5 px-1.5 rounded-xl text-[11px] font-extrabold inline-flex items-center justify-center gap-1 cursor-pointer ${subtitleSubMode === 'youtube' ? 'bg-rose-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">${FT_SVG.play}<span>YT 0ms</span></button>
            </div>

            ${subtitleSubMode === 'video' ? `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">來源語言鎖定</span>
                        <select id="ftVideoSourceLangSelect" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold">
                            <option value="en" ${videoSourceLang === 'en' ? 'selected' : ''}>英文 (eng)</option>
                            <option value="ja" ${videoSourceLang === 'ja' ? 'selected' : ''}>日文 (jpn)</option>
                            <option value="ko" ${videoSourceLang === 'ko' ? 'selected' : ''}>韓文 (kor)</option>
                            <option value="zh-TW" ${videoSourceLang === 'zh-TW' ? 'selected' : ''}>繁體中文 (chi_tra)</option>
                        </select>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">偵測區域 (ROI)</span>
                        <select id="ftVideoRoiSelect" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold">
                            <option value="bottom25" ${videoRoiMode === 'bottom25' ? 'selected' : ''}>底部字幕安全帶 (76%×18%)</option>
                            <option value="bottom40" ${videoRoiMode === 'bottom40' ? 'selected' : ''}>底部擴大字幕區 (84%×36%)</option>
                            <option value="top25" ${videoRoiMode === 'top25' ? 'selected' : ''}>頂部字幕區 (76%×22%)</option>
                            <option value="auto" ${videoRoiMode === 'auto' ? 'selected' : ''}>自動定位字幕帶 (Auto)</option>
                            <option value="custom" ${videoRoiMode === 'custom' ? 'selected' : ''}>自訂百分比範圍 (Custom)</option>
                        </select>
                    </div>
                    ${videoRoiMode === 'custom' ? `
                        <div class="flex items-center justify-between gap-2 flex-wrap">
                            <span class="text-[10.5px] font-semibold text-slate-500 dark:text-slate-400">目前框選：X ${Math.round(videoRoiCustomRect.xPct * 100)}% · Y ${Math.round(videoRoiCustomRect.yPct * 100)}% · W ${Math.round(videoRoiCustomRect.wPct * 100)}% · H ${Math.round(videoRoiCustomRect.hPct * 100)}%</span>
                            <button type="button" id="ftOpenVisualRoiCropBtn" class="px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-extrabold cursor-pointer">開啟視覺框選器</button>
                        </div>
                        <div class="grid grid-cols-4 gap-1.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                            <label class="space-y-0.5"><span>X%</span><input type="number" id="ftRoiCustomX" min="0" max="90" value="${Math.round(videoRoiCustomRect.xPct * 100)}" class="w-full px-1.5 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"></label>
                            <label class="space-y-0.5"><span>Y%</span><input type="number" id="ftRoiCustomY" min="0" max="90" value="${Math.round(videoRoiCustomRect.yPct * 100)}" class="w-full px-1.5 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"></label>
                            <label class="space-y-0.5"><span>寬%</span><input type="number" id="ftRoiCustomW" min="10" max="100" value="${Math.round(videoRoiCustomRect.wPct * 100)}" class="w-full px-1.5 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"></label>
                            <label class="space-y-0.5"><span>高%</span><input type="number" id="ftRoiCustomH" min="8" max="100" value="${Math.round(videoRoiCustomRect.hPct * 100)}" class="w-full px-1.5 py-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"></label>
                        </div>
                    ` : ''}
                    <button type="button" id="ftVideoMonitorToggleBtn" class="w-full py-2 rounded-xl text-xs font-extrabold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer ${videoActive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}">
                        ${videoActive ? `${FT_SVG.stop}<span>停止螢幕字幕偵測</span>` : `${FT_SVG.play}<span>開始擷取螢幕／影片字幕</span>`}
                    </button>
                    <div class="text-[10px] text-slate-500 dark:text-slate-400">250ms 幀差精準感測 ROI，僅於字幕變動時觸發雙語辨識。</div>
                </div>
            ` : subtitleSubMode === 'stt' ? `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="grid grid-cols-2 gap-1.5">
                        <button type="button" id="ftSttMicBtn" class="py-1.5 px-2 rounded-lg text-[11px] font-bold inline-flex items-center justify-center gap-1 cursor-pointer ${sttSource === 'mic' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}">${FT_SVG.mic}<span>麥克風逐字辨識</span></button>
                        <button type="button" id="ftSttTabBtn" class="py-1.5 px-2 rounded-lg text-[11px] font-bold inline-flex items-center justify-center gap-1 cursor-pointer ${sttSource === 'tab' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}">${FT_SVG.speaker}<span>媒體/分頁音訊</span></button>
                    </div>
                    ${sttSource === 'mic' ? `
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">收音語種</span>
                            <select id="ftSttLangSelect" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold">
                                <option value="auto" ${sttInputLang === 'auto' ? 'selected' : ''}>自動依學習語系</option>
                                <option value="en-US" ${sttInputLang === 'en-US' ? 'selected' : ''}>英文 (en-US)</option>
                                <option value="ja-JP" ${sttInputLang === 'ja-JP' ? 'selected' : ''}>日文 (ja-JP)</option>
                                <option value="zh-TW" ${sttInputLang === 'zh-TW' ? 'selected' : ''}>中文 (zh-TW)</option>
                            </select>
                        </div>
                    ` : `<div class="text-[10px] text-slate-500 dark:text-slate-400">分享影片分頁並勾選音訊，含靜音 VAD 防幻覺。</div>`}
                    <button type="button" id="ftSttToggleBtn" class="w-full py-2 rounded-xl text-xs font-extrabold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer ${sttRunning ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}">
                        ${sttRunning ? `${FT_SVG.stop}<span>停止即時語音字幕</span>` : `${FT_SVG.mic}<span>啟動即時雙語串流（FAST DRAFT + CONTEXT AI）</span>`}
                    </button>
                </div>
            ` : `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="flex items-center gap-1.5">
                        <input type="text" id="ftYtUrlInput" value="${escapeHtml(ytUrlInput)}" placeholder="貼上 YouTube / Bilibili / Vimeo / Dailymotion / Niconico / Twitch 網址..." class="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs outline-none">
                        <button type="button" id="ftYtLoadBtn" ${ytLoading ? 'disabled' : ''} class="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-extrabold cursor-pointer shrink-0">
                            ${ytLoading ? '解析中...' : '載入預譯'}
                        </button>
                    </div>
                    ${ytStatusText ? `<div class="text-[11px] font-semibold text-slate-600 dark:text-slate-300">${escapeHtml(ytStatusText)}</div>` : ''}
                    ${ytFallbackSuggested ? `
                        <div class="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 flex flex-wrap items-center gap-1.5">
                            <span class="text-[10.5px] font-bold text-amber-800 dark:text-amber-200 w-full">快速降級切換替代字幕模式：</span>
                            ${ytSuggestedModes.includes('video') ? `<button type="button" id="ftYtFallbackVideoBtn" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-extrabold cursor-pointer inline-flex items-center gap-1">${FT_SVG.screen}<span>一鍵切換畫面字幕</span></button>` : ''}
                            ${ytSuggestedModes.includes('stt') ? `<button type="button" id="ftYtFallbackSttBtn" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-extrabold cursor-pointer inline-flex items-center gap-1">${FT_SVG.mic}<span>一鍵切換語音字幕</span></button>` : ''}
                        </div>
                    ` : ''}
                    ${ytCues.length > 0 ? `
                        <div class="space-y-1.5 pt-1 border-t border-slate-200 dark:border-slate-700">
                            <div class="flex items-center justify-between text-[11px] font-bold">
                                <span class="truncate max-w-[70%]">${escapeHtml(ytTitle)}</span>
                                <span id="ftYtClockText" class="font-mono text-rose-600 dark:text-rose-400">${formatMsToClock(ytCurrentMs)}</span>
                            </div>
                            <input type="range" id="ftYtScrubRange" min="0" max="${totalYtMs}" value="${Math.round(ytCurrentMs)}" class="w-full accent-rose-600 cursor-pointer">
                            <div class="flex items-center justify-between gap-1">
                                <button type="button" id="ftYtPlayToggleBtn" class="px-3 py-1 rounded-lg text-xs font-extrabold text-white inline-flex items-center gap-1 cursor-pointer ${ytPlaying ? 'bg-rose-600' : 'bg-emerald-600'}">
                                    ${ytPlaying ? `${FT_SVG.pause}<span>暫停</span>` : `${FT_SVG.play}<span>開始 0ms 同步</span>`}
                                </button>
                                <div class="flex items-center gap-1">
                                    <button type="button" id="ftYtMinusHalfBtn" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-bold cursor-pointer">-0.5s</button>
                                    <button type="button" id="ftYtPlusHalfBtn" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-bold cursor-pointer">+0.5s</button>
                                    <select id="ftYtSpeedSelect" class="px-1.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-bold">
                                        <option value="0.75" ${ytPlaybackRate === 0.75 ? 'selected' : ''}>0.75x</option>
                                        <option value="1" ${ytPlaybackRate === 1 ? 'selected' : ''}>1.0x</option>
                                        <option value="1.25" ${ytPlaybackRate === 1.25 ? 'selected' : ''}>1.25x</option>
                                        <option value="1.5" ${ytPlaybackRate === 1.5 ? 'selected' : ''}>1.5x</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `}

            <div class="flex items-center justify-between gap-2">
                <label class="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" id="ftSubtitlePinToggle" ${subtitlePinnedOverlay ? 'checked' : ''} class="accent-brand-600">
                    <span class="inline-flex items-center gap-1">${FT_SVG.windowSub}<span>螢幕覆蓋式透明字幕（可自由拖曳）</span></span>
                </label>
                <button type="button" id="ftSubtitleClearFeedBtn" class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[10px] font-bold text-slate-500 dark:text-slate-300 cursor-pointer">清除紀錄</button>
            </div>

            <div class="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                ${subtitleFeed.length === 0
                    ? '<div class="p-4 text-center text-[11px] text-slate-500 dark:text-slate-400">尚無字幕紀錄。字幕出現後可直接點擊原文單字查翻譯與入庫</div>'
                    : subtitleFeed.map(item => `
                        <div class="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-1 ft-motion-enter">
                            <div class="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                                <span class="inline-flex items-center gap-1.5">
                                    <span class="font-bold uppercase">${escapeHtml(item.lang || '')}</span>
                                    <span class="ft-tier-badge ${item.tier === 'draft' ? 'ft-tier-badge--draft' : (item.tier === 'youtube' ? 'ft-tier-badge--youtube' : 'ft-tier-badge--context')}">${item.tier === 'draft' ? 'FAST DRAFT' : (item.tier === 'youtube' ? '0MS SYNC' : 'CONTEXT AI')}</span>
                                </span>
                                <span>${escapeHtml(item.ts)}</span>
                            </div>
                            <div class="text-xs sm:text-sm font-bold text-slate-900 dark:text-white leading-relaxed">${renderClickableTokensHtml(item.orig, item.lang)}</div>
                            ${item.trans ? `<div class="text-xs font-semibold text-emerald-700 dark:text-emerald-300">${escapeHtml(item.trans)}</div>` : ''}
                        </div>
                    `).join('')
                }
            </div>
        `;

        const vModeBtn = q('ftSubVideoModeBtn');
        const sModeBtn = q('ftSubSttModeBtn');
        const yModeBtn = q('ftSubYtModeBtn');
        if (vModeBtn) vModeBtn.onclick = () => { subtitleSubMode = 'video'; renderActiveTabBody(); };
        if (sModeBtn) sModeBtn.onclick = () => { subtitleSubMode = 'stt'; renderActiveTabBody(); };
        if (yModeBtn) yModeBtn.onclick = () => { subtitleSubMode = 'youtube'; renderActiveTabBody(); };

        const openSubVisualCrop = () => {
            openVisualRoiCropper({
                title: '字幕擷取範圍視覺框選器',
                orientation: (global.innerHeight || 0) > (global.innerWidth || 0) ? 'portrait' : 'landscape',
                portraitRect: videoRoiDualCfg.portraitRect,
                landscapeRect: videoRoiDualCfg.landscapeRect,
                onConfirm: (nextRect, details) => {
                    videoRoiMode = 'custom';
                    videoRoiCustomRect = nextRect;
                    if (details && details.portraitRect) {
                        videoRoiDualCfg.portraitMode = 'custom';
                        videoRoiDualCfg.portraitRect = details.portraitRect;
                    }
                    if (details && details.landscapeRect) {
                        videoRoiDualCfg.landscapeMode = 'custom';
                        videoRoiDualCfg.landscapeRect = details.landscapeRect;
                    }
                    videoLastFrameLuma = null;
                    persistVideoRoiConfig();
                    renderActiveTabBody();
                }
            });
        };

        const srcLangSel = q('ftVideoSourceLangSelect');
        if (srcLangSel) {
            srcLangSel.onchange = () => {
                videoSourceLang = ['en', 'ja', 'ko', 'zh-TW'].includes(srcLangSel.value) ? srcLangSel.value : 'en';
                videoLastOriginalText = '';
                persistVideoRoiConfig();
            };
        }
        const roiSel = q('ftVideoRoiSelect');
        if (roiSel) {
            roiSel.onchange = () => {
                videoRoiMode = roiSel.value === 'full' ? 'bottom25' : roiSel.value;
                videoRoiDualCfg.portraitMode = videoRoiMode;
                videoRoiDualCfg.landscapeMode = videoRoiMode;
                videoLastFrameLuma = null;
                persistVideoRoiConfig();
                renderActiveTabBody();
                if (videoRoiMode === 'custom') {
                    openSubVisualCrop();
                }
            };
        }
        const openVisualRoiBtn = q('ftOpenVisualRoiCropBtn');
        if (openVisualRoiBtn) {
            openVisualRoiBtn.onclick = openSubVisualCrop;
        }
        ['ftRoiCustomX', 'ftRoiCustomY', 'ftRoiCustomW', 'ftRoiCustomH'].forEach((id) => {
            const inp = q(id);
            if (!inp) return;
            inp.onchange = () => {
                const xPct = clamp((Number(q('ftRoiCustomX')?.value) || 0) / 100, 0, 0.9);
                const yPct = clamp((Number(q('ftRoiCustomY')?.value) || 0) / 100, 0, 0.9);
                const wPct = clamp((Number(q('ftRoiCustomW')?.value) || 76) / 100, 0.1, 1 - xPct);
                const hPct = clamp((Number(q('ftRoiCustomH')?.value) || 18) / 100, 0.08, 1 - yPct);
                videoRoiCustomRect = { xPct, yPct, wPct, hPct };
                const isPort = (global.innerHeight || 0) > (global.innerWidth || 0);
                if (isPort) videoRoiDualCfg.portraitRect = { ...videoRoiCustomRect };
                else videoRoiDualCfg.landscapeRect = { ...videoRoiCustomRect };
                videoLastFrameLuma = null;
                persistVideoRoiConfig();
            };
        });
        const vTogBtn = q('ftVideoMonitorToggleBtn');
        if (vTogBtn) {
            vTogBtn.onclick = () => {
                if (videoMonitorTimer) {
                    stopVideoSubtitleMonitor();
                    renderSubtitleOverlay();
                    renderActiveTabBody();
                } else {
                    startScreenVideoSubtitleMonitor();
                }
            };
        }

        const micBtn = q('ftSttMicBtn');
        const tabBtn = q('ftSttTabBtn');
        if (micBtn) micBtn.onclick = () => { sttSource = 'mic'; if (sttRunning) stopSttSubtitleEngine(); renderActiveTabBody(); };
        if (tabBtn) tabBtn.onclick = () => { sttSource = 'tab'; if (sttRunning) stopSttSubtitleEngine(); renderActiveTabBody(); };

        const langSel = q('ftSttLangSelect');
        if (langSel) langSel.onchange = () => { sttInputLang = langSel.value; };
        const sttBtn = q('ftSttToggleBtn');
        if (sttBtn) {
            sttBtn.onclick = () => {
                if (sttRunning) {
                    stopSttSubtitleEngine();
                    renderActiveTabBody();
                } else {
                    startSttSubtitleEngine();
                }
            };
        }

        const ytInp = q('ftYtUrlInput');
        if (ytInp) ytInp.oninput = () => { ytUrlInput = ytInp.value; };
        const ytLoad = q('ftYtLoadBtn');
        if (ytLoad) ytLoad.onclick = () => loadYoutubeSubtitleTimeline(ytInp ? ytInp.value : ytUrlInput);
        const fbVideoBtn = q('ftYtFallbackVideoBtn');
        if (fbVideoBtn) fbVideoBtn.onclick = () => { subtitleSubMode = 'video'; renderActiveTabBody(); };
        const fbSttBtn = q('ftYtFallbackSttBtn');
        if (fbSttBtn) fbSttBtn.onclick = () => { subtitleSubMode = 'stt'; renderActiveTabBody(); };
        const ytPlayBtn = q('ftYtPlayToggleBtn');
        if (ytPlayBtn) {
            ytPlayBtn.onclick = () => {
                if (ytPlaying) {
                    stopYoutubeTimelinePlayback();
                    renderActiveTabBody();
                } else {
                    startYoutubeTimelinePlayback();
                }
            };
        }
        const ytScrub = q('ftYtScrubRange');
        if (ytScrub) {
            ytScrub.oninput = () => {
                ytCurrentMs = Number(ytScrub.value) || 0;
                ytActiveCueIdx = -1;
                const clk = q('ftYtClockText');
                if (clk) clk.textContent = formatMsToClock(ytCurrentMs);
                renderSubtitleOverlay();
            };
        }
        const ytMinus = q('ftYtMinusHalfBtn');
        if (ytMinus) ytMinus.onclick = () => { ytCurrentMs = Math.max(0, ytCurrentMs - 500); ytActiveCueIdx = -1; renderSubtitleOverlay(); };
        const ytPlus = q('ftYtPlusHalfBtn');
        if (ytPlus) ytPlus.onclick = () => { ytCurrentMs = ytCurrentMs + 500; ytActiveCueIdx = -1; renderSubtitleOverlay(); };
        const ytSpd = q('ftYtSpeedSelect');
        if (ytSpd) ytSpd.onchange = () => { ytPlaybackRate = Number(ytSpd.value) || 1.0; };

        const pinChk = q('ftSubtitlePinToggle');
        if (pinChk) pinChk.onchange = () => { subtitlePinnedOverlay = pinChk.checked; renderSubtitleOverlay(); };
        const clrFeedBtn = q('ftSubtitleClearFeedBtn');
        if (clrFeedBtn) {
            clrFeedBtn.onclick = () => {
                subtitleFeed.length = 0;
                videoLastOriginalText = '';
                renderSubtitleOverlay();
                renderActiveTabBody();
            };
        }
    }

    function openPanel(tabName, viewMode = '', options = {}) {
        if (!isFeatureEnabled()) setFeatureEnabled(true);
        ensureDomMounted();
        if (viewMode === 'chat' || viewMode === 'translator') {
            panelViewMode = viewMode;
        }
        if (tabName) {
            activeTab = tabName;
            panelViewMode = 'translator';
        }
        isOpen = true;
        try { localStorage.setItem(STORAGE_OPEN_KEY, 'true'); } catch (e) {}

        if (hasElectronWidgetBridge()) {
            if (!options?.fromElectronShortcut && typeof global.LZHDesktopWidget.setExpanded === 'function') {
                global.LZHDesktopWidget.setExpanded(true);
            }
            applyBallPosition();
        }

        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed)) {
            panelHostEl.classList.remove('hidden');
            applyPanelPosition();
        }
        renderActiveTabBody();
        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed)) {
            applyPanelPosition();
        }
        updatePipButtonState();
    }

    function collapsePanel(options = {}) {
        isOpen = false;
        photoFullscreenOpen = false;
        if (panelFullscreen) {
            panelFullscreen = false;
            try {
                if (global.AndroidOverlay && typeof global.AndroidOverlay.setOverlayFullscreen === 'function') {
                    global.AndroidOverlay.setOverlayFullscreen(false);
                }
            } catch (e) {}
        }
        if (panelHostEl) panelHostEl.classList.remove('ft-fullscreen');
        stopCameraStream();
        detachFloatingChatListeners();
        try { localStorage.setItem(STORAGE_OPEN_KEY, 'false'); } catch (e) {}
        if (panelHostEl) panelHostEl.classList.add('hidden');
        if (hasElectronWidgetBridge()) {
            if (!options?.fromElectronShortcut && typeof global.LZHDesktopWidget.setExpanded === 'function') {
                global.LZHDesktopWidget.setExpanded(false);
            }
            applyBallPosition();
        } else {
            applyBallPosition();
        }
    }

    function togglePanel() {
        if (isOpen && (!pipWindowRef || !pipWindowRef.closed)) {
            if (pipWindowRef && !pipWindowRef.closed) closePipWindow();
            collapsePanel();
        } else {
            openPanel(activeTab);
        }
    }

    function handleFlashcardSentenceCapture(e) {
        if (!screenTapEnabled && !pageSelectMode) return;
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        if (!target.closest('#cardFrontSentence, #cardSentence')) return;
        if (isExamModeOrProtectedTarget(target)) return;

        if (pageSelectMode && target.closest('.ft-selected-word-mark')) {
            e.preventDefault();
            e.stopPropagation();
            const existingMark = target.closest('.ft-selected-word-mark');
            const markKey = existingMark.getAttribute('data-ft-sel-key');
            unwrapSingleMark(existingMark);
            if (markKey && pageSelectedWordsMap.has(markKey)) {
                pageSelectedWordsMap.delete(markKey);
            }
            renderPageSelectionBar();
            return;
        }

        const hit = extractWordAtPoint(e.clientX, e.clientY);
        if (!hit) return;

        e.stopPropagation();
        if (pageSelectMode) {
            e.preventDefault();
            toggleMarkOnPageWord(hit);
        } else if (screenTapEnabled) {
            openLookupBubbleForWord(hit.segment, hit.lang, hit.rect, hit.contextSentence);
        }
    }

    function bindGlobalSystemListeners() {
        if (globalListenersBound) return;
        globalListenersBound = true;

        document.addEventListener('click', handleFlashcardSentenceCapture, true);
        document.addEventListener('click', handleGlobalDocumentClick);

        document.addEventListener('keydown', (e) => {
            if (e.altKey && (e.key === 't' || e.key === 'T')) {
                e.preventDefault();
                if (!isFeatureEnabled()) setFeatureEnabled(true);
                togglePanel();
                return;
            }
            if (e.key === 'Escape') {
                if (tapBubbleEl && !tapBubbleEl.classList.contains('hidden')) {
                    hideTapBubble();
                    return;
                }
                if (photoFullscreenOpen) {
                    closePhotoFullscreenViewer();
                    return;
                }
                if (isOpen && (!pipWindowRef || pipWindowRef.closed)) {
                    collapsePanel();
                }
            }
        });

        document.addEventListener('paste', (e) => {
            if (!isOpen || activeTab !== 'camera') return;
            const activeTag = document.activeElement ? document.activeElement.tagName : '';
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        e.preventDefault();
                        handlePhotoFile(file);
                        break;
                    }
                }
            }
        });

        global.addEventListener('resize', () => {
            applyBallPosition();
            applyPanelPosition();
        });

        global.addEventListener('blur', () => {
            if ((isImageModeActive || photoFullscreenOpen || panelFullscreen) && isOpen) {
                applyPanelPosition();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && (isImageModeActive || photoFullscreenOpen || panelFullscreen) && isOpen) {
                applyPanelPosition();
            }
        });

        global.addEventListener('beforeunload', () => {
            stopCameraStream();
            stopAllSubtitleEngines();
        });

        document.addEventListener('focusin', (e) => {
            const target = e && e.target;
            if (!target || typeof target.scrollIntoView !== 'function') return;
            const tag = target.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !target.isContentEditable) return;
            setTimeout(() => {
                try {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                } catch (err) {}
            }, 260);
        });

        global.addEventListener('lzh:state-updated', () => {
            ftFastRefineExhausted = false;
            videoLastOcrAt = 0;
            if (isIosScreenTranslatePlatform()) {
                syncIosConfigToNativePlugin().catch(() => {});
            }
            if (isOpen) {
                renderActiveTabBody();
            }
        });
    }

    /* ==========================================================================
       6B. iOS 獨家「子母畫面（PiP）螢幕翻譯」引導精靈與原生控制橋接
       ========================================================================== */

    function isIosScreenTranslatePlatform() {
        try {
            const cap = global.Capacitor;
            if (cap) {
                const isNative = typeof cap.isNativePlatform === 'function'
                    ? Boolean(cap.isNativePlatform())
                    : Boolean(cap.isNative);
                if (!isNative) return false;
                const p = typeof cap.getPlatform === 'function'
                    ? String(cap.getPlatform() || '').toLowerCase()
                    : '';
                return p === 'ios';
            }
        } catch (e) {}
        return false;
    }

    function getIosNativeScreenPlugin() {
        const cap = global.Capacitor;
        if (!cap) return null;
        if (cap.Plugins && cap.Plugins.IosScreenTranslate) {
            return cap.Plugins.IosScreenTranslate;
        }
        if (typeof cap.registerPlugin === 'function') {
            try {
                const reg = cap.registerPlugin('IosScreenTranslate');
                if (reg) {
                    cap.Plugins = cap.Plugins || {};
                    cap.Plugins.IosScreenTranslate = reg;
                    return reg;
                }
            } catch (e) {}
        }
        return null;
    }

    function updateIosLivePreviewDom() {
        const badgeEl = document.getElementById('ftIosLiveStatusBadge');
        const dotEl = document.getElementById('ftIosLiveStatusDot');
        const srcEl = document.getElementById('ftIosLiveSourceLine');
        const transEl = document.getElementById('ftIosLiveTranslatedLine');
        const bcBadgeEl = document.getElementById('ftIosBroadcastStateText');

        if (badgeEl) {
            if (_iosLiveSubtitleState.broadcastActive) {
                badgeEl.textContent = '廣播翻譯中';
                badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/25 text-emerald-300 border border-emerald-400/50';
            } else if (iosPipActive || _iosLiveSubtitleState.pipActive) {
                badgeEl.textContent = 'PiP 已浮動';
                badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-sky-500/25 text-sky-300 border border-sky-400/50';
            } else {
                badgeEl.textContent = '就緒可抽出';
                badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-indigo-500/25 text-indigo-200 border border-indigo-400/40';
            }
        }
        if (dotEl) {
            dotEl.className = _iosLiveSubtitleState.broadcastActive
                ? 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0'
                : ((iosPipActive || _iosLiveSubtitleState.pipActive)
                    ? 'w-2 h-2 rounded-full bg-sky-400 shrink-0'
                    : 'w-2 h-2 rounded-full bg-slate-500 shrink-0');
        }
        if (bcBadgeEl) {
            bcBadgeEl.textContent = _iosLiveSubtitleState.broadcastActive
                ? 'ReplayKit 螢幕廣播已連線 · 持續辨識原文並翻為繁體中文'
                : '點選下方按鈕啟動即時字幕與系統廣播（切換 App 仍持續顯示）';
        }
        if (srcEl) {
            if (_iosLiveSubtitleState.sourceText) {
                srcEl.textContent = _iosLiveSubtitleState.sourceText;
                srcEl.classList.remove('hidden');
            } else {
                srcEl.textContent = '';
                srcEl.classList.add('hidden');
            }
        }
        const ipcChipEl = document.getElementById('ftIosIpcModeChip');
        if (ipcChipEl) {
            const isAppGroup = _iosLiveSubtitleState.ipcMode === 'app_group';
            const portLabel = _iosLiveSubtitleState.loopbackPort ? `:${_iosLiveSubtitleState.loopbackPort}` : '';
            ipcChipEl.textContent = isAppGroup
                ? 'App Group 共享通道（正式模式）'
                : `本機直連模式（側載免 App Group${portLabel}）`;
            ipcChipEl.className = isAppGroup
                ? 'font-extrabold text-emerald-600 dark:text-emerald-400'
                : 'font-extrabold text-sky-600 dark:text-sky-400';
        }
        if (transEl) {
            transEl.textContent = _iosLiveSubtitleState.translatedText || 'LZHCard 螢幕翻譯就緒，請點選開始廣播';
        }
    }

    async function stopIosPip() {
        const plugin = getIosNativeScreenPlugin();
        if (plugin && typeof plugin.stopPipSubtitle === 'function') {
            try { await plugin.stopPipSubtitle(); } catch (e) {}
        }
        iosPipActive = false;
        _iosLiveSubtitleState.pipActive = false;
        _iosLiveSubtitleState.broadcastActive = false;
        _iosLiveSubtitleState.sourceText = '';
        _iosLiveSubtitleState.translatedText = 'LZHCard 螢幕翻譯就緒，請點選開始廣播';
        updateIosLivePreviewDom();
        renderIosScreenTranslateModalIfVisible();
        if (typeof global.updateFloatingMasterSwitchUI === 'function') {
            global.updateFloatingMasterSwitchUI();
        }
        toast('已關閉子母畫面字幕識別', 'info');
        return true;
    }

    function normalizeIosRegionBox(raw, fallback) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        const fb = fallback || { x: 0.12, y: 0.75, width: 0.76, height: 0.18 };
        const x = clamp(Number(src.x ?? src.xPct ?? fb.x), 0, 0.85);
        const y = clamp(Number(src.y ?? src.yPct ?? fb.y), 0, 0.88);
        const width = clamp(Number(src.width ?? src.wPct ?? fb.width), 0.12, 1 - x);
        const height = clamp(Number(src.height ?? src.hPct ?? fb.height), 0.10, 1 - y);
        return { x, y, width, height };
    }

    function loadIosScreenConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_IOS_SCREEN_CFG_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    const legacyRegion = normalizeIosRegionBox(parsed.region, { x: 0.12, y: 0.75, width: 0.76, height: 0.18 });
                    const legacyMode = parsed.regionMode === 'custom' ? 'custom' : 'auto';
                    iosScreenConfig = {
                        ...iosScreenConfig,
                        ...parsed,
                        regionMode: legacyMode,
                        region: legacyRegion,
                        portraitRegionMode: parsed.portraitRegionMode ? (parsed.portraitRegionMode === 'custom' ? 'custom' : 'auto') : legacyMode,
                        portraitRegion: normalizeIosRegionBox(parsed.portraitRegion || legacyRegion, { x: 0.08, y: 0.70, width: 0.84, height: 0.22 }),
                        landscapeRegionMode: parsed.landscapeRegionMode ? (parsed.landscapeRegionMode === 'custom' ? 'custom' : 'auto') : legacyMode,
                        landscapeRegion: normalizeIosRegionBox(parsed.landscapeRegion || legacyRegion, { x: 0.12, y: 0.74, width: 0.76, height: 0.20 }),
                        editingOrientation: parsed.editingOrientation === 'landscape' ? 'landscape' : 'portrait'
                    };
                }
            }
        } catch (e) {}

        iosScreenConfig.cloudKeyMode = 'shared';
        iosScreenConfig.customApiKey = '';
        return iosScreenConfig;
    }

    function persistIosScreenConfig() {
        try {
            iosScreenConfig.portraitRegion = normalizeIosRegionBox(iosScreenConfig.portraitRegion, { x: 0.08, y: 0.70, width: 0.84, height: 0.22 });
            iosScreenConfig.landscapeRegion = normalizeIosRegionBox(iosScreenConfig.landscapeRegion, { x: 0.12, y: 0.74, width: 0.76, height: 0.20 });
            const curIsLandscape = iosScreenConfig.editingOrientation === 'landscape';
            iosScreenConfig.regionMode = curIsLandscape ? iosScreenConfig.landscapeRegionMode : iosScreenConfig.portraitRegionMode;
            iosScreenConfig.region = curIsLandscape ? { ...iosScreenConfig.landscapeRegion } : { ...iosScreenConfig.portraitRegion };
            localStorage.setItem(STORAGE_IOS_SCREEN_CFG_KEY, JSON.stringify(iosScreenConfig));
        } catch (e) {}
    }

    async function launchIosScreenTranslateQuick(options = {}) {
        loadIosScreenConfig();
        bindIosPipPluginListeners();
        iosScreenConfig.setupCompleted = true;
        persistIosScreenConfig();
        await syncIosConfigToNativePlugin();
        const plugin = getIosNativeScreenPlugin();
        if (!plugin) {
            toast('請於 iOS 實機 App 內啟動子母畫面螢幕翻譯', 'info');
            return false;
        }
        const initText = 'LZHCard 預覽浮窗（可拖曳移動），點選開始廣播後切換畫面';
        if (options.previewOnly && typeof plugin.startPipSubtitle === 'function') {
            await plugin.startPipSubtitle({ initialText: initText });
        } else if (typeof plugin.startScreenTranslate === 'function') {
            await plugin.startScreenTranslate({ initialText: initText });
        } else if (typeof plugin.startPipSubtitle === 'function') {
            await plugin.startPipSubtitle({ initialText: initText });
            if (typeof plugin.showBroadcastPicker === 'function') {
                await plugin.showBroadcastPicker();
            }
        }
        iosPipActive = true;
        _iosLiveSubtitleState.pipActive = true;
        updateIosLivePreviewDom();
        if (typeof global.updateFloatingMasterSwitchUI === 'function') {
            global.updateFloatingMasterSwitchUI();
        }
        return true;
    }

    function bindIosPipPluginListeners() {
        if (iosPipPluginBound) return;
        const plugin = getIosNativeScreenPlugin();
        if (!plugin || typeof plugin.addListener !== 'function') return;
        iosPipPluginBound = true;
        try {
            plugin.addListener('pipStateChanged', (ev) => {
                const active = Boolean(ev && ev.active);
                iosPipActive = active;
                _iosLiveSubtitleState.pipActive = active;
                if (!active && !_iosLiveSubtitleState.broadcastActive) {
                    _iosLiveSubtitleState.translatedText = 'LZHCard 螢幕翻譯就緒，請點選開始廣播';
                }
                updateIosLivePreviewDom();
                renderIosScreenTranslateModalIfVisible();
                if (typeof global.updateFloatingMasterSwitchUI === 'function') {
                    global.updateFloatingMasterSwitchUI();
                }
            });
            plugin.addListener('broadcastStateChanged', (ev) => {
                const active = Boolean(ev && ev.active);
                _iosLiveSubtitleState.broadcastActive = active;
                if (ev && ev.ipcMode) {
                    _iosLiveSubtitleState.ipcMode = String(ev.ipcMode);
                }
                if (ev && ev.message) {
                    _iosLiveSubtitleState.translatedText = String(ev.message);
                } else if (!active) {
                    _iosLiveSubtitleState.sourceText = '';
                    _iosLiveSubtitleState.translatedText = '螢幕翻譯廣播已結束';
                }
                updateIosLivePreviewDom();
                renderIosScreenTranslateModalIfVisible();
            });
            plugin.addListener('ipcStatusChanged', (ev) => {
                if (!ev || typeof ev !== 'object') return;
                if (ev.ipcMode) _iosLiveSubtitleState.ipcMode = String(ev.ipcMode);
                if (typeof ev.loopbackReady === 'boolean') _iosLiveSubtitleState.loopbackReady = ev.loopbackReady;
                if (ev.loopbackPort) _iosLiveSubtitleState.loopbackPort = Number(ev.loopbackPort) || 49152;
                if (ev.lastConnectedVia) _iosLiveSubtitleState.lastConnectedVia = String(ev.lastConnectedVia);
                if (typeof ev.broadcastActive === 'boolean') _iosLiveSubtitleState.broadcastActive = ev.broadcastActive;
                iosScreenCapabilities = {
                    ...(iosScreenCapabilities || {}),
                    ...ev
                };
                updateIosLivePreviewDom();
                renderIosScreenTranslateModalIfVisible();
            });
            plugin.addListener('ocrCaptured', (ev) => {
                const txt = String((ev && ev.text) || '').trim();
                if (!txt) return;
                _iosLiveSubtitleState.sourceText = txt;
                _iosLiveSubtitleState.updatedAt = Date.now();
                updateIosLivePreviewDom();
            });
            plugin.addListener('subtitleTranslated', (ev) => {
                const src = String((ev && ev.sourceText) || '').trim();
                const trans = String((ev && ev.translatedText) || '').trim();
                if (src) _iosLiveSubtitleState.sourceText = src;
                if (trans) {
                    _iosLiveSubtitleState.translatedText = trans;
                    _iosLiveSubtitleState.updatedAt = Date.now();
                }
                updateIosLivePreviewDom();
            });
            plugin.addListener('pauseStateChanged', (ev) => {
                const paused = Boolean(ev && ev.paused);
                _iosLiveSubtitleState.translatedText = paused ? '⏸ 字幕翻譯已暫停（點擊動態島可繼續）' : (_iosLiveSubtitleState.translatedText || '螢幕翻譯恢復偵測中...');
                updateIosLivePreviewDom();
                renderIosScreenTranslateModalIfVisible();
            });
            plugin.addListener('shortcutCommand', async (ev) => {
                const action = String((ev && ev.action) || '').trim();
                if (!action) return;
                if (action === 'start_subtitle_recognition') {
                    await launchIosScreenTranslateQuick();
                } else if (action === 'stop_subtitle_recognition') {
                    await stopIosPip();
                } else if (action === 'toggle_inapp_floating') {
                    if (typeof global.handleHomeFloatingTranslateBtn === 'function') {
                        await global.handleHomeFloatingTranslateBtn();
                    } else {
                        togglePanel();
                    }
                } else if (action === 'start_review_session') {
                    if (typeof global.startFocusMode === 'function') {
                        global.startFocusMode('flashcard');
                    }
                } else if (action === 'open_quick_translate') {
                    openPanel('camera');
                } else if (action === 'save_current_subtitle') {
                    const src = String((ev && ev.sourceText) || _iosLiveSubtitleState.sourceText || '').trim();
                    const tr = String((ev && ev.translatedText) || _iosLiveSubtitleState.translatedText || '').trim();
                    if (src || tr) {
                        const wordVal = src || tr;
                        const meaningVal = src && tr ? tr : '螢幕即時字幕收藏';
                        upsertCardsIntoWordList([{
                            word: wordVal,
                            meaning: meaningVal,
                            sentence: src,
                            translation: tr
                        }], '字幕即時收藏');
                        toast(`📌 已收藏字幕單字：${wordVal.slice(0, 28)}`, 'success');
                        if (typeof global.syncIosEcosystemSnapshot === 'function') {
                            global.syncIosEcosystemSnapshot();
                        }
                    }
                }
            });
            plugin.addListener('pipError', (ev) => {
                toast('PiP 子母畫面準備中：' + ((ev && ev.message) || '請確認已允許畫中畫或點選開始廣播'), 'warning');
            });
        } catch (e) {}
    }

    async function getFirebaseIdTokenSafe() {
        try {
            if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
                return await firebase.auth().currentUser.getIdToken();
            }
        } catch (e) {}
        return '';
    }

    async function syncIosConfigToNativePlugin() {
        persistIosScreenConfig();
        const plugin = getIosNativeScreenPlugin();
        if (!plugin || typeof plugin.saveConfig !== 'function') return false;
        const authToken = await getFirebaseIdTokenSafe();
        const resolvedProvider = 'worker';
        const resolvedModel = 'gemini-2.0-flash';
        const effectivePortraitRect = iosScreenConfig.portraitRegionMode === 'custom'
            ? iosScreenConfig.portraitRegion
            : { x: 0.08, y: 0.70, width: 0.84, height: 0.22 };
        const effectiveLandscapeRect = iosScreenConfig.landscapeRegionMode === 'custom'
            ? iosScreenConfig.landscapeRegion
            : { x: 0.12, y: 0.74, width: 0.76, height: 0.20 };
        const effectiveRect = iosScreenConfig.editingOrientation === 'landscape'
            ? effectiveLandscapeRect
            : effectivePortraitRect;
        await plugin.saveConfig({
            engine: iosScreenConfig.engine,
            sourceLang: iosScreenConfig.sourceLang || 'en',
            targetLang: 'zh-Hant',
            provider: resolvedProvider,
            model: resolvedModel,
            workerBaseUrl: SHARED_WORKER_BASE,
            authToken,
            regionMode: iosScreenConfig.regionMode || 'auto',
            region: effectiveRect,
            cropRect: effectiveRect,
            portraitRegionMode: iosScreenConfig.portraitRegionMode || 'auto',
            portraitRegion: effectivePortraitRect,
            landscapeRegionMode: iosScreenConfig.landscapeRegionMode || 'auto',
            landscapeRegion: effectiveLandscapeRect
        });
        return true;
    }

    function ensureIosScreenModal() {
        if (iosScreenModalEl && document.body.contains(iosScreenModalEl)) return iosScreenModalEl;
        iosScreenModalEl = document.createElement('div');
        iosScreenModalEl.id = 'ftIosScreenTranslateModal';
        iosScreenModalEl.className = 'hidden fixed inset-0 z-[85] bg-slate-950/70 backdrop-blur-xs flex items-end sm:items-center justify-center lzh-safe-modal';
        iosScreenModalEl.style.padding = 'calc(var(--lzh-effective-top, env(safe-area-inset-top, 0px)) + 12px) calc(env(safe-area-inset-right, 0px) + 12px) calc(var(--lzh-effective-bottom, env(safe-area-inset-bottom, 0px)) + 12px) calc(env(safe-area-inset-left, 0px) + 12px)';
        iosScreenModalEl.onclick = (e) => {
            if (e.target === iosScreenModalEl) closeIosScreenTranslateModal();
        };
        document.body.appendChild(iosScreenModalEl);
        return iosScreenModalEl;
    }

    function closeIosScreenTranslateModal() {
        if (iosScreenModalEl) {
            iosScreenModalEl.classList.add('hidden');
        }
    }

    function renderIosScreenTranslateModalIfVisible() {
        if (iosScreenModalEl && !iosScreenModalEl.classList.contains('hidden')) {
            renderIosScreenTranslateModal();
        }
    }

    function renderIosScreenTranslateModal() {
        const modal = ensureIosScreenModal();
        modal.classList.remove('hidden');

        iosScreenConfig.cloudKeyMode = 'shared';
        iosScreenConfig.customApiKey = '';

        const isAppleOffline = iosScreenConfig.engine !== 'cloud_api';
        const supportsOffline = iosScreenCapabilities ? Boolean(iosScreenCapabilities.supportsOfflineTranslation) : true;
        const stepLabels = ['1. 翻譯引擎與語言', '2. 掃描區域框選', '3. 字幕識別與 PiP'];
        const editOrient = iosScreenConfig.editingOrientation === 'landscape' ? 'landscape' : 'portrait';
        const activeRegMode = editOrient === 'landscape' ? iosScreenConfig.landscapeRegionMode : iosScreenConfig.portraitRegionMode;
        const reg = editOrient === 'landscape' ? iosScreenConfig.landscapeRegion : iosScreenConfig.portraitRegion;
        const rxPct = Math.round(reg.x * 100);
        const ryPct = Math.round(reg.y * 100);
        const rwPct = Math.round(reg.width * 100);
        const rhPct = Math.round(reg.height * 100);
        const pSummary = iosScreenConfig.portraitRegionMode === 'custom'
            ? `直立自訂(${Math.round(iosScreenConfig.portraitRegion.x * 100)}%,${Math.round(iosScreenConfig.portraitRegion.y * 100)}%)`
            : '直立自動';
        const lSummary = iosScreenConfig.landscapeRegionMode === 'custom'
            ? `橫向自訂(${Math.round(iosScreenConfig.landscapeRegion.x * 100)}%,${Math.round(iosScreenConfig.landscapeRegion.y * 100)}%)`
            : '橫向自動';
        const langNameMap = { en: '英文 (English)', ja: '日文 (日本語)', ko: '韓文 (한국어)' };

        let quotaSummaryHtml = '目前使用 LZHCard 雲端 AI 翻譯通道（僅限付費會員或班級教師共享方案使用）。';
        try {
            if (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.getSummary === 'function') {
                const sm = global.MembershipEngine.getSummary();
                if (sm && sm.tierLabel) {
                    quotaSummaryHtml = `目前方案：${escapeHtml(sm.tierLabel)}（使用 LZHCard 雲端 AI 翻譯通道）`;
                }
            }
        } catch (e) {}

        const statusBadgeText = _iosLiveSubtitleState.broadcastActive
            ? '廣播翻譯中'
            : ((iosPipActive || _iosLiveSubtitleState.pipActive) ? 'PiP 已浮動' : '就緒可抽出');
        const statusBadgeCls = _iosLiveSubtitleState.broadcastActive
            ? 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/25 text-emerald-300 border border-emerald-400/50'
            : ((iosPipActive || _iosLiveSubtitleState.pipActive)
                ? 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-sky-500/25 text-sky-300 border border-sky-400/50'
                : 'px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-indigo-500/25 text-indigo-200 border border-indigo-400/40');
        const statusDotCls = _iosLiveSubtitleState.broadcastActive
            ? 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0'
            : ((iosPipActive || _iosLiveSubtitleState.pipActive)
                ? 'w-2 h-2 rounded-full bg-sky-400 shrink-0'
                : 'w-2 h-2 rounded-full bg-slate-500 shrink-0');

        modal.innerHTML = `
            <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                <div class="px-4 py-3.5 bg-gradient-to-r from-indigo-600 to-brand-600 text-white flex items-center justify-between gap-2 shrink-0">
                    <div>
                        <div class="text-sm font-black">iOS 即時字幕識別（PiP 螢幕翻譯）</div>
                        <div class="text-[11px] text-indigo-100">純淨無遮擋浮動中文字幕條 · 支援動態島與捷徑快速開關</div>
                    </div>
                    <button type="button" id="ftIosModalCloseBtn" class="w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center cursor-pointer" aria-label="關閉">${FT_SVG.close}</button>
                </div>

                <div class="px-4 pt-3 pb-2 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2 shrink-0">
                    ${stepLabels.map((lbl, idx) => {
                        const sNum = idx + 1;
                        const active = iosScreenWizardStep === sNum;
                        const done = iosScreenWizardStep > sNum;
                        return `<button type="button" data-ios-jump-step="${sNum}" class="flex-1 min-h-[44px] py-2 px-2 rounded-xl text-[10.5px] font-extrabold transition cursor-pointer ${active ? 'bg-brand-600 text-white shadow-xs' : (done ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700')}">${lbl}</button>`;
                    }).join('')}
                </div>

                <div class="p-4 overflow-y-auto space-y-3.5 text-slate-800 dark:text-slate-100">
                    ${iosFallbackNotice ? `
                        <div class="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-700 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                            ${escapeHtml(iosFallbackNotice)}
                        </div>
                    ` : ''}

                    ${iosScreenWizardStep === 1 ? `
                        <div class="space-y-3">
                            <div class="text-xs font-extrabold text-slate-600 dark:text-slate-300">選擇螢幕翻譯核心引擎</div>

                            <label class="block p-3 rounded-2xl border-2 cursor-pointer transition ${isAppleOffline ? 'border-brand-600 bg-brand-50/50 dark:bg-brand-950/25' : 'border-slate-200 dark:border-slate-700'}">
                                <div class="flex items-start gap-2.5">
                                    <input type="radio" name="ftIosEngineRadio" value="apple_offline" ${isAppleOffline ? 'checked' : ''} ${!supportsOffline ? 'disabled' : ''} class="mt-1 accent-brand-600">
                                    <div class="min-w-0 flex-1 space-y-1">
                                        <div class="flex items-center gap-1.5 flex-wrap">
                                            <span class="text-xs font-black">Apple 離線翻譯</span>
                                            <span class="px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-extrabold">推薦 · 免額度</span>
                                        </div>
                                        <p class="text-[11px] text-slate-500 dark:text-slate-400">使用系統內建離線翻譯（iOS 18+），於本機極速翻譯且不耗行動網路與 AI 額度。</p>
                                    </div>
                                </div>
                            </label>

                            <label class="block p-3 rounded-2xl border-2 cursor-pointer transition ${!isAppleOffline ? 'border-brand-600 bg-brand-50/50 dark:bg-brand-950/25' : 'border-slate-200 dark:border-slate-700'}">
                                <div class="flex items-start gap-2.5">
                                    <input type="radio" name="ftIosEngineRadio" value="cloud_api" ${!isAppleOffline ? 'checked' : ''} class="mt-1 accent-brand-600">
                                    <div class="min-w-0 flex-1 space-y-1">
                                        <div class="flex items-center gap-1.5 flex-wrap">
                                            <span class="text-xs font-black">雲端 AI 翻譯</span>
                                            <span class="px-1.5 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-extrabold">全 iOS 版本適用</span>
                                        </div>
                                        <p class="text-[11px] text-slate-500 dark:text-slate-400">${quotaSummaryHtml}</p>
                                    </div>
                                </div>
                            </label>

                            <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 space-y-2.5">
                                <div class="grid grid-cols-2 gap-2">
                                    <div>
                                        <label class="block text-[10.5px] font-bold text-slate-500 dark:text-slate-400 mb-1">來源原文語言</label>
                                        <select id="ftIosSourceLangSelect" class="w-full px-2.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none">
                                            <option value="en" ${iosScreenConfig.sourceLang === 'en' ? 'selected' : ''}>🇺🇸 英文 (EN)</option>
                                            <option value="ja" ${iosScreenConfig.sourceLang === 'ja' ? 'selected' : ''}>🇯🇵 日文 (JA)</option>
                                            <option value="ko" ${iosScreenConfig.sourceLang === 'ko' ? 'selected' : ''}>🇰🇷 韓文 (KO)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label class="block text-[10.5px] font-bold text-slate-500 dark:text-slate-400 mb-1">字幕目標語言</label>
                                        <div class="w-full px-2.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 text-xs font-extrabold text-emerald-700 dark:text-emerald-300">🇹🇼 繁體中文</div>
                                    </div>
                                </div>

                                ${isAppleOffline ? `
                                    <button type="button" id="ftIosDownloadPackBtn" ${iosOfflineDownloading ? 'disabled' : ''} class="w-full min-h-[44px] py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-extrabold cursor-pointer transition">
                                        ${iosOfflineDownloading ? '正在檢查／喚起 Apple 離線語言包...' : (iosOfflinePackReady ? '✅ 已檢查 Apple 離線語言包（點擊可重新檢查）' : '檢查／下載 Apple 離線語言包')}
                                    </button>
                                ` : `
                                    <div class="text-[11px] text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/60 rounded-xl px-3 py-2 leading-relaxed">
                                        使用 LZHCard 雲端 AI 翻譯通道，依您的月繳會員或班級共享配額自動運行。
                                    </div>
                                `}
                            </div>
                        </div>
                    ` : iosScreenWizardStep === 2 ? `
                        <div class="space-y-3">
                            <div class="text-xs font-extrabold text-slate-600 dark:text-slate-300">分別設定直立與橫向螢幕偵測區域</div>
                            <div class="grid grid-cols-2 gap-2">
                                <button type="button" id="ftIosOrientPortraitBtn" class="min-h-[40px] py-1.5 px-3 rounded-xl text-xs font-extrabold border-2 cursor-pointer ${editOrient === 'portrait' ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">📱 直立模式 (9:16)</button>
                                <button type="button" id="ftIosOrientLandscapeBtn" class="min-h-[40px] py-1.5 px-3 rounded-xl text-xs font-extrabold border-2 cursor-pointer ${editOrient === 'landscape' ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">🖥️ 橫向模式 (16:9)</button>
                            </div>
                            <div class="grid grid-cols-2 gap-2">
                                <button type="button" id="ftIosRegionAutoBtn" class="min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold border-2 cursor-pointer ${activeRegMode !== 'custom' ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">自動識別（推薦）</button>
                                <button type="button" id="ftIosRegionCustomBtn" class="min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold border-2 cursor-pointer ${activeRegMode === 'custom' ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">自訂${editOrient === 'portrait' ? '直立' : '橫向'}區域</button>
                            </div>

                            <div class="flex justify-center">
                                <div id="ftIosPhonePreviewBox" class="relative ${editOrient === 'landscape' ? 'w-64' : 'w-40'} rounded-2xl border-2 border-slate-300 dark:border-slate-600 bg-slate-900 overflow-hidden select-none shadow-inner" style="aspect-ratio: ${editOrient === 'landscape' ? '16 / 9' : '9 / 19.5'};">
                                    <div class="absolute inset-x-4 top-2 h-1.5 rounded-full bg-slate-700/80"></div>
                                    <div class="absolute inset-0 flex flex-col items-center justify-center px-3 text-center pointer-events-none">
                                        <div class="text-[10px] font-bold text-slate-400">${activeRegMode === 'custom' ? `拖曳綠框定位${editOrient === 'portrait' ? '直立' : '橫向'}字幕區` : '自動掃描畫面主要字幕帶'}</div>
                                    </div>
                                    <div id="ftIosRegionRectEl" class="absolute border-2 ${activeRegMode === 'custom' ? 'border-emerald-400 bg-emerald-400/20 cursor-move' : 'border-indigo-400/70 bg-indigo-400/15 border-dashed pointer-events-none'}" style="left:${activeRegMode === 'custom' ? rxPct : 5}%;top:${activeRegMode === 'custom' ? ryPct : 55}%;width:${activeRegMode === 'custom' ? rwPct : 90}%;height:${activeRegMode === 'custom' ? rhPct : 36}%;touch-action:none;">
                                        <span class="px-1 py-0.5 bg-slate-950/80 text-[9px] font-bold text-white rounded-br">${activeRegMode === 'custom' ? `${rwPct}%×${rhPct}%` : 'AUTO'}</span>
                                        ${activeRegMode === 'custom' ? '<span id="ftIosRegionResizeHandle" class="absolute -bottom-1.5 -right-1.5 w-4 h-4 rounded-full bg-emerald-400 border-2 border-white shadow cursor-nwse-resize"></span>' : ''}
                                    </div>
                                </div>
                            </div>

                            ${activeRegMode === 'custom' ? `
                                <button type="button" id="ftIosOpenVisualCropBtn" class="w-full min-h-[44px] py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer transition">開啟大畫面視覺框選器（可切換直/橫向）</button>
                                <div class="grid grid-cols-2 gap-2 p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-[11px]">
                                    <label class="space-y-1 font-bold">左起 X: <span id="ftIosRegXLbl">${rxPct}%</span><input id="ftIosRegXSlider" type="range" min="0" max="80" value="${rxPct}" class="w-full accent-emerald-600"></label>
                                    <label class="space-y-1 font-bold">上起 Y: <span id="ftIosRegYLbl">${ryPct}%</span><input id="ftIosRegYSlider" type="range" min="0" max="85" value="${ryPct}" class="w-full accent-emerald-600"></label>
                                    <label class="space-y-1 font-bold">寬度 W: <span id="ftIosRegWLbl">${rwPct}%</span><input id="ftIosRegWSlider" type="range" min="15" max="100" value="${rwPct}" class="w-full accent-emerald-600"></label>
                                    <label class="space-y-1 font-bold">高度 H: <span id="ftIosRegHLbl">${rhPct}%</span><input id="ftIosRegHSlider" type="range" min="10" max="90" value="${rhPct}" class="w-full accent-emerald-600"></label>
                                </div>
                            ` : ''}
                        </div>
                    ` : `
                        <div class="space-y-3">
                            <div id="iosLiveSubtitlePreviewCard" class="p-3.5 rounded-2xl bg-slate-950 text-white border-2 border-dashed border-emerald-400/75 shadow-inner space-y-2.5">
                                <div class="text-[10.5px] font-bold text-slate-300 flex items-center justify-between gap-2">
                                    <span class="inline-flex items-center gap-1.5">
                                        <span id="ftIosLiveStatusDot" class="${statusDotCls}"></span>
                                        <span>即時雙語字幕識別預覽框（同步投屏 PiP）</span>
                                    </span>
                                    <span id="ftIosLiveStatusBadge" class="${statusBadgeCls}">${statusBadgeText}</span>
                                </div>
                                <div class="py-3 px-3.5 rounded-xl bg-slate-900/95 border border-white/10 space-y-1.5 min-h-[84px] flex flex-col justify-center">
                                    <div id="ftIosLiveSourceLine" class="text-[11px] font-semibold text-slate-400 leading-snug text-center ${_iosLiveSubtitleState.sourceText ? '' : 'hidden'}">${escapeHtml(_iosLiveSubtitleState.sourceText)}</div>
                                    <div id="ftIosLiveTranslatedLine" class="text-sm sm:text-base font-black text-white leading-snug text-center">${escapeHtml(_iosLiveSubtitleState.translatedText || 'LZHCard 螢幕翻譯就緒，請點選開始廣播')}</div>
                                </div>
                                <div id="ftIosBroadcastStateText" class="text-[10.5px] font-medium text-emerald-300/90 text-center">
                                    ${_iosLiveSubtitleState.broadcastActive
                                        ? 'ReplayKit 螢幕廣播已連線 · 持續辨識原文並翻為繁體中文'
                                        : '點選下方按鈕啟動即時字幕與系統廣播（切換 App 仍持續顯示）'}
                                </div>
                            </div>

                            <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-xs space-y-1">
                                <div class="flex justify-between gap-2"><span class="text-slate-500 dark:text-slate-400">翻譯引擎</span><span class="font-extrabold">${isAppleOffline ? 'Apple 離線翻譯（本機）' : 'LZHCard 雲端 AI 引擎'}</span></div>
                                <div class="flex justify-between gap-2"><span class="text-slate-500 dark:text-slate-400">翻譯方向</span><span class="font-extrabold">${escapeHtml(langNameMap[iosScreenConfig.sourceLang] || '英文')} → 繁體中文</span></div>
                                <div class="flex justify-between gap-2"><span class="text-slate-500 dark:text-slate-400">擷取區域</span><span class="font-extrabold text-right">${escapeHtml(pSummary)} / ${escapeHtml(lSummary)}</span></div>
                                <div class="flex justify-between gap-2"><span class="text-slate-500 dark:text-slate-400">通訊模式</span><span id="ftIosIpcModeChip" class="font-extrabold ${_iosLiveSubtitleState.ipcMode === 'app_group' ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'}">${_iosLiveSubtitleState.ipcMode === 'app_group' ? 'App Group 共享通道（正式模式）' : `本機直連模式（側載免 App Group${_iosLiveSubtitleState.loopbackPort ? `:${_iosLiveSubtitleState.loopbackPort}` : ''}）`}</span></div>
                            </div>

                            <button type="button" id="ftIosLaunchPipBroadcastBtn" class="w-full min-h-[48px] py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-black shadow-md cursor-pointer transition">
                                啟動即時字幕識別（抽出 PiP + 系統螢幕廣播）
                            </button>
                            ${!_iosLiveSubtitleState.broadcastActive ? `
                                <button type="button" id="ftIosOpenBroadcastPickerBtn" class="w-full min-h-[44px] py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold cursor-pointer transition">
                                    重新開啟系統螢幕廣播選擇器
                                </button>
                            ` : ''}
                            ${(iosScreenCapabilities && iosScreenCapabilities.hasBroadcastExtension === false) ? `
                                <div class="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-700 text-[11px] font-semibold text-amber-800 dark:text-amber-200 leading-relaxed">
                                    ⚠️ 目前 App 套件內未偵測到 BroadcastUpload 螢幕廣播擴充：若使用側載（Sideloadly／AltStore）安裝，免費 Apple ID 上限 3 個 App ID 或移除 PlugIns 時會拿掉螢幕廣播擴充，導致 PiP 僅顯示預覽文字而無法擷取其他畫面字幕。
                                </div>
                            ` : ''}
                            ${(iosPipActive || _iosLiveSubtitleState.broadcastActive) ? `
                                <button type="button" id="ftIosStopPipBtn" class="w-full min-h-[44px] py-2 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">關閉子母畫面字幕識別</button>
                            ` : ''}
                        </div>
                    `}
                </div>

                <div class="px-4 py-3 bg-slate-50 dark:bg-slate-800/80 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 shrink-0">
                    ${iosScreenWizardStep > 1
                        ? `<button type="button" id="ftIosPrevStepBtn" class="min-h-[44px] px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-xs font-bold cursor-pointer">${iosScreenWizardStep === 3 ? '重新調整設定' : '上一步'}</button>`
                        : '<span class="text-[11px] text-slate-400">首次設定後下次一鍵直達啟動</span>'}
                    ${iosScreenWizardStep < 3
                        ? `<button type="button" id="ftIosNextStepBtn" class="ml-auto min-h-[44px] px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold cursor-pointer">${iosScreenWizardStep === 2 ? '完成設定，前往啟動' : '下一步：選擇區域'}</button>`
                        : `<button type="button" id="ftIosSaveDoneBtn" class="ml-auto min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold cursor-pointer">關閉視窗</button>`}
                </div>
            </div>
        `;

        const closeBtn = modal.querySelector('#ftIosModalCloseBtn');
        if (closeBtn) closeBtn.onclick = closeIosScreenTranslateModal;

        modal.querySelectorAll('[data-ios-jump-step]').forEach(btn => {
            btn.onclick = () => {
                iosScreenWizardStep = Number(btn.getAttribute('data-ios-jump-step')) || 1;
                renderIosScreenTranslateModal();
            };
        });

        modal.querySelectorAll('input[name="ftIosEngineRadio"]').forEach(rad => {
            rad.onchange = () => {
                iosScreenConfig.engine = rad.value === 'cloud_api' ? 'cloud_api' : 'apple_offline';
                persistIosScreenConfig();
                renderIosScreenTranslateModal();
            };
        });

        const srcSel = modal.querySelector('#ftIosSourceLangSelect');
        if (srcSel) {
            srcSel.onchange = () => {
                iosScreenConfig.sourceLang = srcSel.value || 'en';
                iosOfflinePackReady = false;
                persistIosScreenConfig();
            };
        }

        const dlBtn = modal.querySelector('#ftIosDownloadPackBtn');
        if (dlBtn) {
            dlBtn.onclick = async () => {
                const plugin = getIosNativeScreenPlugin();
                if (!plugin || typeof plugin.prepareOfflineLanguages !== 'function') {
                    toast('請於 iOS 實機 App 內下載 Apple 離線語言包（網頁預覽自動模擬就緒）', 'info');
                    iosOfflinePackReady = true;
                    renderIosScreenTranslateModal();
                    return;
                }
                iosOfflineDownloading = true;
                renderIosScreenTranslateModal();
                try {
                    const res = await plugin.prepareOfflineLanguages({
                        sourceLang: iosScreenConfig.sourceLang || 'en',
                        targetLang: 'zh-Hant'
                    });
                    if (res && res.fallbackSuggested) {
                        iosScreenConfig.engine = 'cloud_api';
                        iosFallbackNotice = '偵測到您的 iOS 版本低於 18.0，不支援 Apple 系統離線翻譯 Session，已自動切換為雲端 AI 翻譯模式。';
                        persistIosScreenConfig();
                        toast('已自動切換為雲端 AI 翻譯模式', 'info');
                    } else {
                        iosOfflinePackReady = true;
                        toast((res && res.message) || 'Apple 離線語言包已準備完成', 'success');
                    }
                } catch (err) {
                    toast('檢查離線語言包失敗：' + ((err && err.message) || '請稍後再試'), 'error');
                } finally {
                    iosOfflineDownloading = false;
                    renderIosScreenTranslateModal();
                }
            };
        }

        const getActiveIosRegionRef = () => (iosScreenConfig.editingOrientation === 'landscape'
            ? iosScreenConfig.landscapeRegion
            : iosScreenConfig.portraitRegion);

        const openIosVisualCrop = () => {
            openVisualRoiCropper({
                title: 'iOS 螢幕翻譯偵測框選器',
                orientation: iosScreenConfig.editingOrientation === 'landscape' ? 'landscape' : 'portrait',
                portraitRect: {
                    xPct: iosScreenConfig.portraitRegion.x,
                    yPct: iosScreenConfig.portraitRegion.y,
                    wPct: iosScreenConfig.portraitRegion.width,
                    hPct: iosScreenConfig.portraitRegion.height
                },
                landscapeRect: {
                    xPct: iosScreenConfig.landscapeRegion.x,
                    yPct: iosScreenConfig.landscapeRegion.y,
                    wPct: iosScreenConfig.landscapeRegion.width,
                    hPct: iosScreenConfig.landscapeRegion.height
                },
                onConfirm: (_nextRect, details) => {
                    if (details && details.portraitRect) {
                        iosScreenConfig.portraitRegionMode = 'custom';
                        iosScreenConfig.portraitRegion = {
                            x: details.portraitRect.xPct,
                            y: details.portraitRect.yPct,
                            width: details.portraitRect.wPct,
                            height: details.portraitRect.hPct
                        };
                    }
                    if (details && details.landscapeRect) {
                        iosScreenConfig.landscapeRegionMode = 'custom';
                        iosScreenConfig.landscapeRegion = {
                            x: details.landscapeRect.xPct,
                            y: details.landscapeRect.yPct,
                            width: details.landscapeRect.wPct,
                            height: details.landscapeRect.hPct
                        };
                    }
                    if (details && details.orientation) {
                        iosScreenConfig.editingOrientation = details.orientation === 'landscape' ? 'landscape' : 'portrait';
                    }
                    persistIosScreenConfig();
                    syncIosConfigToNativePlugin().catch(() => {});
                    renderIosScreenTranslateModal();
                }
            });
        };

        const orientPortraitBtn = modal.querySelector('#ftIosOrientPortraitBtn');
        const orientLandscapeBtn = modal.querySelector('#ftIosOrientLandscapeBtn');
        if (orientPortraitBtn) {
            orientPortraitBtn.onclick = () => {
                iosScreenConfig.editingOrientation = 'portrait';
                persistIosScreenConfig();
                renderIosScreenTranslateModal();
            };
        }
        if (orientLandscapeBtn) {
            orientLandscapeBtn.onclick = () => {
                iosScreenConfig.editingOrientation = 'landscape';
                persistIosScreenConfig();
                renderIosScreenTranslateModal();
            };
        }

        const autoRegBtn = modal.querySelector('#ftIosRegionAutoBtn');
        const customRegBtn = modal.querySelector('#ftIosRegionCustomBtn');
        const iosVisualCropBtn = modal.querySelector('#ftIosOpenVisualCropBtn');
        if (autoRegBtn) {
            autoRegBtn.onclick = () => {
                if (iosScreenConfig.editingOrientation === 'landscape') {
                    iosScreenConfig.landscapeRegionMode = 'auto';
                } else {
                    iosScreenConfig.portraitRegionMode = 'auto';
                }
                persistIosScreenConfig();
                syncIosConfigToNativePlugin().catch(() => {});
                renderIosScreenTranslateModal();
            };
        }
        if (customRegBtn) {
            customRegBtn.onclick = () => {
                if (iosScreenConfig.editingOrientation === 'landscape') {
                    iosScreenConfig.landscapeRegionMode = 'custom';
                } else {
                    iosScreenConfig.portraitRegionMode = 'custom';
                }
                persistIosScreenConfig();
                renderIosScreenTranslateModal();
                openIosVisualCrop();
            };
        }
        if (iosVisualCropBtn) {
            iosVisualCropBtn.onclick = openIosVisualCrop;
        }

        const syncSliderLabels = () => {
            const r = getActiveIosRegionRef();
            const isCustomNow = (iosScreenConfig.editingOrientation === 'landscape'
                ? iosScreenConfig.landscapeRegionMode
                : iosScreenConfig.portraitRegionMode) === 'custom';
            const rectEl = modal.querySelector('#ftIosRegionRectEl');
            if (rectEl && isCustomNow) {
                rectEl.style.left = `${Math.round(r.x * 100)}%`;
                rectEl.style.top = `${Math.round(r.y * 100)}%`;
                rectEl.style.width = `${Math.round(r.width * 100)}%`;
                rectEl.style.height = `${Math.round(r.height * 100)}%`;
            }
            const xl = modal.querySelector('#ftIosRegXLbl'); if (xl) xl.textContent = `${Math.round(r.x * 100)}%`;
            const yl = modal.querySelector('#ftIosRegYLbl'); if (yl) yl.textContent = `${Math.round(r.y * 100)}%`;
            const wl = modal.querySelector('#ftIosRegWLbl'); if (wl) wl.textContent = `${Math.round(r.width * 100)}%`;
            const hl = modal.querySelector('#ftIosRegHLbl'); if (hl) hl.textContent = `${Math.round(r.height * 100)}%`;
        };

        ['ftIosRegXSlider', 'ftIosRegYSlider', 'ftIosRegWSlider', 'ftIosRegHSlider'].forEach(sid => {
            const sEl = modal.querySelector('#' + sid);
            if (!sEl) return;
            sEl.oninput = () => {
                const r = getActiveIosRegionRef();
                const vx = Number(modal.querySelector('#ftIosRegXSlider')?.value || 12) / 100;
                const vy = Number(modal.querySelector('#ftIosRegYSlider')?.value || 75) / 100;
                const vw = Number(modal.querySelector('#ftIosRegWSlider')?.value || 76) / 100;
                const vh = Number(modal.querySelector('#ftIosRegHSlider')?.value || 18) / 100;
                r.x = clamp(vx, 0, 0.85);
                r.y = clamp(vy, 0, 0.88);
                r.width = clamp(vw, 0.12, 1 - r.x);
                r.height = clamp(vh, 0.10, 1 - r.y);
                syncSliderLabels();
                persistIosScreenConfig();
            };
        });

        const previewBox = modal.querySelector('#ftIosPhonePreviewBox');
        const rectEl = modal.querySelector('#ftIosRegionRectEl');
        const resizeHandle = modal.querySelector('#ftIosRegionResizeHandle');
        const isActiveOrientCustom = (iosScreenConfig.editingOrientation === 'landscape'
            ? iosScreenConfig.landscapeRegionMode
            : iosScreenConfig.portraitRegionMode) === 'custom';
        if (previewBox && rectEl && isActiveOrientCustom) {
            let dragMode = '';
            let startClientX = 0, startClientY = 0;
            let startReg = { ...getActiveIosRegionRef() };

            rectEl.onpointerdown = (e) => {
                e.preventDefault();
                dragMode = (e.target === resizeHandle) ? 'resize' : 'move';
                startClientX = e.clientX;
                startClientY = e.clientY;
                startReg = { ...getActiveIosRegionRef() };
                try { rectEl.setPointerCapture(e.pointerId); } catch (err) {}
            };
            rectEl.onpointermove = (e) => {
                if (!dragMode) return;
                const boxRect = previewBox.getBoundingClientRect();
                if (!boxRect.width || !boxRect.height) return;
                const dx = (e.clientX - startClientX) / boxRect.width;
                const dy = (e.clientY - startClientY) / boxRect.height;
                const r = getActiveIosRegionRef();
                if (dragMode === 'move') {
                    r.x = clamp(startReg.x + dx, 0, Math.max(0, 1 - startReg.width));
                    r.y = clamp(startReg.y + dy, 0, Math.max(0, 1 - startReg.height));
                } else {
                    r.width = clamp(startReg.width + dx, 0.15, 1 - r.x);
                    r.height = clamp(startReg.height + dy, 0.10, 1 - r.y);
                }
                syncSliderLabels();
            };
            const finishDrag = () => {
                if (!dragMode) return;
                dragMode = '';
                persistIosScreenConfig();
                syncIosConfigToNativePlugin().catch(() => {});
                renderIosScreenTranslateModal();
            };
            rectEl.onpointerup = finishDrag;
            rectEl.onpointercancel = finishDrag;
        }

        const prevBtn = modal.querySelector('#ftIosPrevStepBtn');
        if (prevBtn) {
            prevBtn.onclick = () => {
                iosScreenWizardStep = iosScreenWizardStep === 3 ? 1 : Math.max(1, iosScreenWizardStep - 1);
                renderIosScreenTranslateModal();
            };
        }
        const nextBtn = modal.querySelector('#ftIosNextStepBtn');
        if (nextBtn) {
            nextBtn.onclick = async () => {
                if (iosScreenWizardStep === 2) {
                    iosScreenConfig.setupCompleted = true;
                    await syncIosConfigToNativePlugin();
                } else {
                    persistIosScreenConfig();
                }
                iosScreenWizardStep = Math.min(3, iosScreenWizardStep + 1);
                renderIosScreenTranslateModal();
            };
        }
        const doneBtn = modal.querySelector('#ftIosSaveDoneBtn');
        if (doneBtn) doneBtn.onclick = closeIosScreenTranslateModal;

        const launchBtn = modal.querySelector('#ftIosLaunchPipBroadcastBtn');
        if (launchBtn) {
            launchBtn.onclick = async () => {
                if (iosScreenConfig.engine === 'cloud_api' && typeof global.ensureAiPrivacyConsent === 'function') {
                    const consentOk = await global.ensureAiPrivacyConsent({ feature: 'screen_translate' });
                    if (!consentOk) {
                        return;
                    }
                }
                try {
                    closeIosScreenTranslateModal();
                    await launchIosScreenTranslateQuick();
                    toast('已啟動即時字幕識別與系統廣播選擇器，請點選「開始廣播」', 'success');
                } catch (err) {
                    toast('啟動 iOS 字幕識別失敗：' + ((err && err.message) || '請稍後再試'), 'error');
                }
            };
        }

        const pickerBtn = modal.querySelector('#ftIosOpenBroadcastPickerBtn');
        if (pickerBtn) {
            pickerBtn.onclick = async () => {
                const plugin = getIosNativeScreenPlugin();
                if (!plugin || typeof plugin.showBroadcastPicker !== 'function') {
                    toast('請於 iOS 實機 App 內開啟系統螢幕廣播選擇器', 'info');
                    return;
                }
                try {
                    await syncIosConfigToNativePlugin();
                    await plugin.showBroadcastPicker();
                    toast('已開啟系統廣播選擇器，請點選「開始廣播」', 'info');
                } catch (err) {
                    toast('開啟系統廣播選擇器失敗：' + ((err && err.message) || '請稍後再試'), 'error');
                }
            };
        }

        const stopPipBtn = modal.querySelector('#ftIosStopPipBtn');
        if (stopPipBtn) {
            stopPipBtn.onclick = stopIosPip;
        }
    }

    async function openIosScreenTranslate(options = {}) {
        loadIosScreenConfig();
        bindIosPipPluginListeners();
        iosFallbackNotice = '';

        const plugin = getIosNativeScreenPlugin();
        if (plugin && typeof plugin.getCapabilities === 'function') {
            try {
                iosScreenCapabilities = await plugin.getCapabilities();
                if (iosScreenCapabilities) {
                    if (iosScreenCapabilities.supportsOfflineTranslation === false) {
                        iosScreenConfig.engine = 'cloud_api';
                        iosFallbackNotice = '您的裝置系統低於 iOS 18.0，已自動切換為雲端 AI 翻譯模式。';
                        persistIosScreenConfig();
                    }
                    if (iosScreenCapabilities.ipcMode) {
                        _iosLiveSubtitleState.ipcMode = String(iosScreenCapabilities.ipcMode);
                    }
                    if (typeof iosScreenCapabilities.loopbackReady === 'boolean') {
                        _iosLiveSubtitleState.loopbackReady = iosScreenCapabilities.loopbackReady;
                    }
                    if (iosScreenCapabilities.loopbackPort) {
                        _iosLiveSubtitleState.loopbackPort = Number(iosScreenCapabilities.loopbackPort) || 49152;
                    }
                    if (iosScreenCapabilities.lastConnectedVia) {
                        _iosLiveSubtitleState.lastConnectedVia = String(iosScreenCapabilities.lastConnectedVia);
                    }
                    if (typeof iosScreenCapabilities.broadcastActive === 'boolean') {
                        _iosLiveSubtitleState.broadcastActive = iosScreenCapabilities.broadcastActive;
                    }
                    if (typeof iosScreenCapabilities.pipActive === 'boolean') {
                        iosPipActive = iosScreenCapabilities.pipActive;
                        _iosLiveSubtitleState.pipActive = iosScreenCapabilities.pipActive;
                    }
                    if (iosScreenCapabilities.latestSourceText) {
                        _iosLiveSubtitleState.sourceText = String(iosScreenCapabilities.latestSourceText);
                    }
                    if (iosScreenCapabilities.latestSubtitle) {
                        _iosLiveSubtitleState.translatedText = String(iosScreenCapabilities.latestSubtitle);
                    }
                }
            } catch (e) {}
        }

        const forceWizard = Boolean(options && options.forceWizard);
        iosScreenWizardStep = (forceWizard || !iosScreenConfig.setupCompleted) ? 1 : 3;
        renderIosScreenTranslateModal();
        if (isIosScreenTranslatePlatform()) {
            syncIosConfigToNativePlugin().catch(() => {});
        }
        return true;
    }

    /* ==========================================================================
       7. Android / 原生截圖與音訊橋接：window.LZHNativeBridge
       ========================================================================== */

    global.LZHNativeBridge = {
        /**
         * 接收 Android 原生端傳來之螢幕截圖 base64（支援即時字幕 ROI 幀差或拍照互動熱區）
         */
        async onScreenFrame(base64) {
            if (!base64) return;
            const dataUrl = String(base64).startsWith('data:') ? String(base64) : `data:image/jpeg;base64,${base64}`;
            if (activeTab === 'subtitle' && subtitleSubMode === 'video') {
                const img = new Image();
                img.onload = () => {
                    sampleVideoSourceAndDetectDiff(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
                };
                img.src = dataUrl;
                return;
            }
            openPanel('camera');
            await analyzePhotoDataUrl(dataUrl);
        },

        /**
         * 接收 Android 原生語音辨識串流文字並進行雙語字幕翻譯
         */
        async onNativeTranscript(text, lang, isFinal = true, draft = '') {
            if (!text) return;
            if (!isFinal) {
                sttInterimText = String(text).trim();
                if (draft) sttInterimDraft = String(draft).trim();
                renderSubtitleOverlay();
                return;
            }
            sttInterimText = '';
            sttInterimDraft = '';
            await translateTranscriptText(String(text), lang || '');
        }
    };

    /* ==========================================================================
       8. 初始化與對外公開 API（含 PhotoOcrImporter 相容別名）
       ========================================================================== */

    function bindAuthSyncListener() {
        if (authSyncListenerBound) return;
        authSyncListenerBound = true;
        try {
            if (typeof firebase !== 'undefined' && firebase.auth) {
                firebase.auth().onAuthStateChanged(() => {
                    refreshBallUnread();
                    if (isOpen) {
                        renderActiveTabBody();
                    }
                    applyBallPosition();
                });
            }
        } catch (e) {}
    }

    function isInAppDockVisible() {
        if (isIosScreenTranslatePlatform()) {
            try {
                const raw = localStorage.getItem(STORAGE_IOS_BALL_VISIBLE_KEY);
                if (raw === 'true') return true;
                if (raw === 'false') return false;
            } catch (e) {}
            return localStorage.getItem(STORAGE_ENABLED_KEY) === 'true';
        }
        return isFeatureEnabled();
    }

    function setInAppDockVisible(flag) {
        const show = Boolean(flag);
        if (isIosScreenTranslatePlatform()) {
            try { localStorage.setItem(STORAGE_IOS_BALL_VISIBLE_KEY, show ? 'true' : 'false'); } catch (e) {}
            ensureDomMounted();
            if (show) {
                if (rootEl) rootEl.classList.remove('hidden');
                if (ballEl) {
                    ballEl.classList.remove('hidden');
                    applyBallPosition();
                }
                refreshBallUnread();
            } else {
                if (ballEl) ballEl.classList.add('hidden');
                if (rootEl && !isOpen) {
                    // keep panel hidden while only toggling ball visibility
                }
            }
            if (typeof global.updateFloatingMasterSwitchUI === 'function') {
                global.updateFloatingMasterSwitchUI();
            }
            return show;
        }
        setFeatureEnabled(show);
        if (typeof global.updateFloatingMasterSwitchUI === 'function') {
            global.updateFloatingMasterSwitchUI();
        }
        return show;
    }

    function isWindowOpen() {
        return Boolean((isOpen && panelHostEl && !panelHostEl.classList.contains('hidden')) || (pipWindowRef && !pipWindowRef.closed));
    }

    function init() {
        initNativeLangPreference();
        loadVideoRoiPreference();
        loadPositionState();
        bindGlobalSystemListeners();
        ensureDomMounted();
        initDesktopWidgetShell();
        bindAuthSyncListener();
        if (isIosScreenTranslatePlatform()) {
            loadIosScreenConfig();
            bindIosPipPluginListeners();
            if (isInAppDockVisible() && rootEl) {
                rootEl.classList.remove('hidden');
            }
            applyBallPosition();
        }
        setScreenTapEnabled(localStorage.getItem(STORAGE_TAP_ENABLED_KEY) === 'true');
        if (hasElectronWidgetBridge() || isDesktopWidgetShell()) {
            // 電腦版懸浮小工具啟動時預設即以展開視窗呈現，未登入也可顯示登入按鈕或切換為懸浮球
            openPanel(activeTab, '', { fromElectronShortcut: true });
        } else if (localStorage.getItem(STORAGE_OPEN_KEY) === 'true' && isFeatureEnabled()) {
            openPanel(activeTab);
        }
        refreshBallUnread();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.FloatingTranslator = {
        init,
        open: openPanel,
        openChatPanel: () => {
            setFeatureEnabled(true);
            openPanel('', 'chat');
        },
        openCameraTranslator: () => {
            setFeatureEnabled(true);
            openPanel('camera');
        },
        openIosScreenTranslate,
        closeIosScreenTranslateModal,
        stopIosPip,
        launchIosScreenTranslateQuick,
        openVisualRoiCropper,
        isIosScreenTranslatePlatform,
        isIosPipActive: () => iosPipActive,
        isInAppDockVisible,
        setInAppDockVisible,
        isWindowOpen,
        translatePhotoArticleToChinese,
        copyPhotoArticleTranslation,
        close: collapsePanel,
        collapse: collapsePanel,
        toggle: togglePanel,
        setEnabled: setFeatureEnabled,
        isEnabled: isFeatureEnabled,
        isOpen: () => isOpen,
        isElectronWidget: hasElectronWidgetBridge,
        refreshBallUnread,
        setPanelViewMode,
        setTargetNativeLang,
        getTargetNativeLang: () => targetNativeLang,
        setScreenTapEnabled,
        setPageSelectionMode,
        switchTab,
        setSubtitleSubMode: (mode) => {
            if (['video', 'stt', 'youtube'].includes(mode)) {
                subtitleSubMode = mode;
                openPanel('subtitle');
            }
        },
        openPipWindow,
        closePipWindow,
        openPhotoFullscreenViewer,
        closePhotoFullscreenViewer,
        // 匯出純函式供自動化測試驗證
        detectScriptLang,
        segmentTrilingualText,
        extractWordAtPoint,
        isExamModeOrProtectedTarget,
        box1000ToPercentRect,
        computeFrameDiffRatio,
        resolveStrictCropRect,
        setDualVideoRoiConfig: (cfg) => {
            if (!cfg || typeof cfg !== 'object') return;
            videoRoiDualCfg = {
                portraitMode: cfg.portraitMode || videoRoiDualCfg.portraitMode,
                portraitRect: normalizeRoiDraftRect(cfg.portraitRect || videoRoiDualCfg.portraitRect),
                landscapeMode: cfg.landscapeMode || videoRoiDualCfg.landscapeMode,
                landscapeRect: normalizeRoiDraftRect(cfg.landscapeRect || videoRoiDualCfg.landscapeRect)
            };
        },
        upsertCardsIntoWordList,
        lookupTrilingualWord,
        analyzeScreenFrameBase64
    };

    // 向後相容別名：確保任何外部呼喚統一導入同一套相機懸浮翻譯
    global.PhotoOcrImporter = {
        open: () => {
            setFeatureEnabled(true);
            openPanel('camera');
        },
        close: collapsePanel,
        triggerCapture: (useCam) => {
            setFeatureEnabled(true);
            openPanel('camera');
            triggerPhotoFileInput(Boolean(useCam));
        },
        translateFullArticleToChinese: translatePhotoArticleToChinese,
        copyArticleTranslation: copyPhotoArticleTranslation
    };
})(typeof window !== 'undefined' ? window : globalThis);
