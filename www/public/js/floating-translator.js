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
    const IDB_DICT_KEY = 'lzhcard_ft_trilingual_dict_v1';
    const SESSION_DICT_KEY = 'lzhcard_ft_trilingual_session_v1';

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
    let pipWindowRef = null;

    // 狀態控制
    let activeTab = 'camera'; // 'camera' | 'screen' | 'subtitle'
    let isOpen = false;
    let targetNativeLang = DEFAULT_NATIVE_LANG;
    let screenTapEnabled = false;
    let pageSelectMode = false;

    // 停靠位置狀態
    let posState = {
        dockSide: 'right',
        topPx: null,
        panelLeftPx: null,
        panelTopPx: null
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
    let isVisionBusy = false;
    let photoImageDataUrl = '';
    let photoImageMime = 'image/jpeg';
    let photoImageBase64 = '';
    let photoTokens = []; // [{ id, text, lang, reading, pos, translation, box: [ymin,xmin,ymax,xmax] }]
    let photoSummary = '';
    let photoActiveTokenId = null;
    const photoSelectedTokenIds = new Set();

    // 螢幕點詞輸入區狀態
    let screenScratchText = '';
    let screenScratchTranslation = '';
    let isScreenTextBusy = false;

    // 模組四：即時字幕引擎狀態
    let subtitleSubMode = 'video'; // 'video' | 'stt'
    let subtitlePinnedOverlay = true;
    // 4A. 螢幕 / 影片幀差 OCR
    let videoCaptureStream = null;
    let videoRoiMode = 'bottom25'; // 'bottom25' | 'bottom40' | 'full'
    let videoMonitorTimer = null;
    let videoLastFrameLuma = null;
    let videoLastOcrAt = 0;
    let videoOcrInFlight = false;
    let videoLastOriginalText = '';
    let videoSourceElement = null; // HTML5 <video> fallback or hidden capture video
    // 4B. 語音雙來源 STT
    let sttSource = 'mic'; // 'mic' | 'tab'
    let sttInputLang = 'auto'; // 'auto' | 'en-US' | 'ja-JP' | 'zh-TW'
    let sttRunning = false;
    let speechRec = null;
    let sttTabStream = null;
    let sttAudioCtx = null;
    let sttAnalyser = null;
    let sttMediaRecorder = null;
    let sttChunkTimer = null;
    let sttInterimText = '';
    const subtitleFeed = []; // [{ id, ts, orig, trans, lang }]

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
     * 🌐 模組一：三語智能分詞引擎 (Intl.Segmenter + 混合語系區塊切分 + Fallback)
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
            if (typeof global.callGeminiApi === 'function') {
                try {
                    const raw = await global.callGeminiApi(prompt, { silent: true });
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

        if (typeof selectedCategories !== 'undefined' && selectedCategories instanceof Set && selectedCategories.size > 0) {
            return Array.from(selectedCategories)[0];
        }
        const cats = getDeckCategoriesList();
        return cats[0] || '我的單字本';
    }

    function buildFlashcardObject(data, categoryName) {
        const word = String(data.word || '').trim();
        const lang = data.lang || detectScriptLang(word);
        const now = Date.now();
        const diffInfo = (lang === 'en' && typeof global.getWordDifficultyInfo === 'function')
            ? global.getWordDifficultyInfo(word)
            : { level: 0 };

        return {
            id: (typeof global.generateId === 'function') ? global.generateId() : ('card_' + now + '_' + Math.random().toString(36).slice(2, 8)),
            category: categoryName || '我的單字本',
            word,
            lang,
            pos: String(data.pos || '').trim(),
            phonetic: String(data.phonetic || '').trim(),
            meaning: String(data.meaning || '（待補充釋義）').trim(),
            sentence: String(data.sentence || '').trim(),
            translation: String(data.translation || '').trim(),
            level: 0,
            knowStreak: 0,
            state: 0,
            stability: 0,
            difficulty: 0,
            reps: 0,
            lapses: 0,
            lastReview: 0,
            nextReview: 0,
            freeLevel: 0,
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

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        cardPayloads.forEach(item => {
            const word = String(item.word || '').trim();
            if (!word) return;
            const lang = item.lang || detectScriptLang(word);
            const key = normalizeWordKey(word, lang);

            const existingInDeck = list.find(c =>
                c && c.category === deck &&
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
            if (typeof selectedCategories !== 'undefined' && selectedCategories instanceof Set) {
                selectedCategories.add(deck);
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
                const raw = await global.callGeminiApi(prompt, { silent: false });
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
     * 🛡️ 最高優先權防呆守衛：判斷是否處於考試模式、既有雙語題庫或不可攔截的 UI 區域
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
            '#keyModal',
            '#cardModal',
            '#batchModal',
            '#backupModal',
            '#cardEditModal',
            '#deckShareModal',
            '#playerProfileModal',
            '#deleteAccountModal'
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
        const bw = Math.min(288, vw - 24);

        let left = vw / 2 - bw / 2;
        let top = vh * 0.25;

        if (anchorRect) {
            const centerX = anchorRect.left + (anchorRect.width || 0) / 2;
            left = clamp(centerX - bw / 2, 12, Math.max(12, vw - bw - 12));
            const estimatedHeight = bubbleEl.offsetHeight || 156;
            if (preferAbove) {
                top = anchorRect.top - estimatedHeight - 10;
                if (top < 56) top = anchorRect.bottom + 10;
            } else {
                top = anchorRect.bottom + 10;
                if (top + estimatedHeight > vh - 16) {
                    top = Math.max(56, anchorRect.top - estimatedHeight - 10);
                }
            }
            top = clamp(top, 56, Math.max(56, vh - estimatedHeight - 12));
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
                    <button type="button" data-ft-bubble-action="photo-select" class="py-1.5 px-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-xs font-bold cursor-pointer">
                        ☑️ 選取
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
                    addBtn.textContent = '✓ 已收錄';
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
            selectionBarEl.className = 'hidden fixed z-[55] bottom-20 left-1/2 -translate-x-1/2 w-[min(94vw,520px)] bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl border border-emerald-300 dark:border-emerald-700 shadow-2xl p-3 space-y-2';
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
                    <span>☑️ 頁面選取模式</span>
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
                    ${cats.map(c => `<option value="${escapeHtml(c)}" ${c === currentDeck ? 'selected' : ''}>📁 ${escapeHtml(c)}</option>`).join('')}
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
                ? '<span>☑️ 頁面選取模式進行中（點頁面單字反白）</span>'
                : '<span>☑️ 開啟「頁面點詞選取」模式</span>';
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

        // 🛡️ 最優先檢查：若處於考試模式或受保護區域，立刻退出
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

    function triggerPhotoFileInput(useCameraCapture) {
        const inp = q(useCameraCapture ? 'ftPhotoCameraInput' : 'ftPhotoGalleryInput');
        if (inp) {
            inp.value = '';
            inp.click();
        }
    }

    function compressImageElementToJpeg(source, srcWidth, srcHeight, maxDim = 1400, quality = 0.85) {
        const w = Number(srcWidth) || 0;
        const h = Number(srcHeight) || 0;
        if (!w || !h) throw new Error('無效影像尺寸');

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
        const compressed = compressImageElementToJpeg(video, video.videoWidth, video.videoHeight, 1400, 0.86);
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
        const compressed = compressImageElementToJpeg(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1400, 0.86);
        await analyzeCompressedPhoto(compressed);
    }

    async function handlePhotoFile(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                await analyzePhotoDataUrl(String(ev.target.result || ''));
            } catch (err) {
                toast('讀取圖片失敗', 'error');
            }
        };
        reader.readAsDataURL(file);
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

    async function analyzeCompressedPhoto({ dataUrl, base64, mimeType }) {
        photoImageDataUrl = dataUrl;
        photoImageBase64 = base64;
        photoImageMime = mimeType || 'image/jpeg';
        photoTokens = [];
        photoSummary = '';
        photoActiveTokenId = null;
        photoSelectedTokenIds.clear();
        isVisionBusy = true;
        hideTapBubble();
        renderActiveTabBody();

        const nativeCfg = getNativeLangConfig(targetNativeLang);
        const prompt = `請對這張圖片進行高精準多語 OCR 與詞彙定位解析。
規則：
1. 辨識圖片中的英文單字、日文單字／片語或中文詞彙（最多回傳 80 個重要字詞，優先實詞）。
2. 每個 token 必須附上相對於整張圖片的正規化邊界框 box: [ymin, xmin, ymax, xmax]，座標範圍為 0 到 1000 的整數。
3. lang 為 "en"、"ja" 或 "zh-TW"。
4. reading：英文填 IPA 音標；日文必須填寫「純平假名讀音」；中文可填拼音或留空。
5. translation 必須使用「${nativeCfg.aiName}」翻譯該詞彙；summary 為整張圖主要內容的「${nativeCfg.aiName}」通順翻譯摘要。
6. 只輸出單一純 JSON 物件（不要加 Markdown 語法）：
{"summary":"","detectedLang":"en|ja|zh-TW","tokens":[{"text":"","lang":"en|ja|zh-TW","reading":"","pos":"","translation":"","box":[0,0,100,200]}]}`;

        try {
            if (typeof global.callGeminiApi !== 'function') {
                throw new Error('找不到 AI 呼叫介面');
            }
            const raw = await global.callGeminiApi(prompt, {
                silent: false,
                inlineData: { mimeType: photoImageMime, data: photoImageBase64 }
            });
            const parsed = (typeof global.safeParseJSON === 'function')
                ? global.safeParseJSON(raw)
                : JSON.parse(raw);

            photoSummary = String((parsed && parsed.summary) || '').trim();
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

            if (photoTokens.length === 0 && !photoSummary) {
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
        }
    }

    function setPhotoMode(mode) {
        photoMode = mode === 'select' ? 'select' : 'lookup';
        if (photoMode === 'select') {
            hideTapBubble();
        }
        renderActiveTabBody();
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
                }
            }
        );
    }

    async function confirmImportSelectedPhotoTokens() {
        const selected = photoTokens.filter(tk => photoSelectedTokenIds.has(tk.id));
        if (selected.length === 0) {
            toast('請先點選圖片中的至少 1 個單字', 'warning');
            return;
        }
        const deck = getPreferredTargetDeckName();
        const btn = q('ftPhotoConfirmImportBtn');
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
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ==========================================================================
       5. 模組四：即時雙語字幕引擎（螢幕/影片幀差 OCR + 雙來源語音 STT）
       ========================================================================== */

    function stopAllSubtitleEngines() {
        stopVideoSubtitleMonitor();
        stopSttSubtitleEngine();
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

    function extractRoiCanvasAndLuma(sourceEl, srcW, srcH, roiMode) {
        let sy = 0;
        let sh = srcH;
        if (roiMode === 'bottom25') {
            sy = Math.round(srcH * 0.72);
            sh = Math.max(20, srcH - sy);
        } else if (roiMode === 'bottom40') {
            sy = Math.round(srcH * 0.58);
            sh = Math.max(20, srcH - sy);
        }

        // 用於 OCR 的高清晰裁切畫布
        const maxOcrW = 960;
        const scale = Math.min(1, maxOcrW / srcW);
        const ocrW = Math.max(32, Math.round(srcW * scale));
        const ocrH = Math.max(24, Math.round(sh * scale));

        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = ocrW;
        ocrCanvas.height = ocrH;
        const ocrCtx = ocrCanvas.getContext('2d');
        ocrCtx.drawImage(sourceEl, 0, sy, srcW, sh, 0, 0, ocrW, ocrH);

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

    async function processRoiImageForSubtitle(base64Jpeg) {
        if (videoOcrInFlight) return;
        videoOcrInFlight = true;
        try {
            if (typeof global.callGeminiApi !== 'function') return;
            const nativeCfg = getNativeLangConfig(targetNativeLang);
            const prompt = `請擷取這張畫面裁切區域中最顯著的一行或兩行字幕原文，並翻譯為「${nativeCfg.aiName}」。
若畫面中完全沒有文字或字幕，請回傳 {"original":"","translation":"","lang":""}。
只輸出純 JSON 物件：{"original":"","translation":"","lang":"en|ja|zh-TW"}`;

            const raw = await global.callGeminiApi(prompt, {
                silent: true,
                inlineData: { mimeType: 'image/jpeg', data: base64Jpeg }
            });
            const parsed = (typeof global.safeParseJSON === 'function')
                ? global.safeParseJSON(raw)
                : JSON.parse(raw);

            const orig = String((parsed && parsed.original) || '').trim();
            const trans = String((parsed && parsed.translation) || '').trim();
            const lang = (parsed && parsed.lang) || detectScriptLang(orig);

            if (!orig || orig === videoLastOriginalText) return;
            videoLastOriginalText = orig;
            pushSubtitleEntry(orig, trans, lang);
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

        // 僅在幀差大於門檻 (4.5%) 且冷卻滿 1400ms 時才呼叫 AI，節省配額
        if (videoLastFrameLuma === null || (diffRatio >= 0.045 && now - videoLastOcrAt >= 1400 && !videoOcrInFlight)) {
            videoLastFrameLuma = luma;
            videoLastOcrAt = now;
            const jpegDataUrl = ocrCanvas.toDataURL('image/jpeg', 0.8);
            const b64 = jpegDataUrl.split(',')[1] || '';
            if (b64) await processRoiImageForSubtitle(b64);
        }
    }

    async function startScreenVideoSubtitleMonitor() {
        stopVideoSubtitleMonitor();
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
            // 若為網頁內嵌 <video>，降級追蹤頁面上正在播放的第一個 <video>
            const pageVideo = Array.from(document.querySelectorAll('video')).find(v => !v.paused && v.videoWidth > 0 && v.id !== 'ftCameraVideo');
            if (!pageVideo) {
                toast('此裝置不支援螢幕擷取，可改用頁面 <video> 或 Android 原生截圖橋接', 'warning');
                return;
            }
            videoSourceElement = pageVideo;
        } else {
            try {
                videoCaptureStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { frameRate: { ideal: 10, max: 15 } },
                    audio: false
                });
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
                        stopVideoSubtitleMonitor();
                        renderActiveTabBody();
                    });
                }
            } catch (err) {
                stopVideoSubtitleMonitor();
                toast('已取消螢幕畫面擷取', 'info');
                renderActiveTabBody();
                return;
            }
        }

        videoLastFrameLuma = null;
        videoLastOriginalText = '';
        videoMonitorTimer = setInterval(() => {
            if (!videoSourceElement) return;
            const vw = videoSourceElement.videoWidth || 0;
            const vh = videoSourceElement.videoHeight || 0;
            if (vw > 0 && vh > 0) {
                sampleVideoSourceAndDetectDiff(videoSourceElement, vw, vh);
            }
        }, 900);

        renderSubtitleOverlay();
        renderActiveTabBody();
        toast('已啟動即時字幕偵測（僅在字幕變動時自動辨識）', 'success');
    }

    function pushSubtitleEntry(orig, trans, langHint) {
        const cleanOrig = String(orig || '').trim();
        if (!cleanOrig) return;
        const detected = detectScriptLang(cleanOrig, langHint);
        subtitleFeed.unshift({
            id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            orig: cleanOrig,
            trans: String(trans || '').trim(),
            lang: detected
        });
        if (subtitleFeed.length > 40) subtitleFeed.length = 40;
        renderSubtitleOverlay();
        if (activeTab === 'subtitle') renderActiveTabBody();
    }

    async function translateTranscriptText(text, langHint) {
        const clean = String(text || '').trim();
        if (!clean) return;
        const detected = detectScriptLang(clean, langHint);
        const nativeCfg = getNativeLangConfig(targetNativeLang);

        // 若原文語系與目標母語相同則直接呈現
        if (detected === nativeCfg.code) {
            pushSubtitleEntry(clean, '', detected);
            return;
        }

        let trans = '';
        if (typeof global.callGeminiApi === 'function') {
            try {
                const prompt = `將以下口語／字幕句子自然翻譯成「${nativeCfg.aiName}」，只回傳翻譯結果文字，不要任何解釋或引號：\n${clean}`;
                trans = String(await global.callGeminiApi(prompt, { silent: true }) || '').trim();
            } catch (e) {}
        }
        if (!trans) {
            try {
                trans = await fetchGoogleTranslateFallback(clean, detected, nativeCfg.code);
            } catch (e) {}
        }
        pushSubtitleEntry(clean, trans, detected);
    }

    function stopSttSubtitleEngine() {
        sttRunning = false;
        sttInterimText = '';
        if (speechRec) {
            try { speechRec.onend = null; speechRec.stop(); } catch (e) {}
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
        renderSubtitleOverlay();
    }

    async function startSttSubtitleEngine() {
        stopSttSubtitleEngine();

        if (sttSource === 'mic') {
            const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
            if (!SR) {
                toast('此瀏覽器不支援 Web SpeechRecognition，請改用媒體分頁音訊或 Chrome', 'warning');
                return;
            }
            sttRunning = true;
            const rec = new SR();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = sttInputLang === 'auto'
                ? ((typeof global.getLanguageConfig === 'function' && global.getLanguageConfig().targetLang === 'ja') ? 'ja-JP' : 'en-US')
                : sttInputLang;

            rec.onresult = (event) => {
                let interim = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const res = event.results[i];
                    const transcript = (res[0] && res[0].transcript) ? res[0].transcript.trim() : '';
                    if (!transcript) continue;
                    if (res.isFinal) {
                        sttInterimText = '';
                        const langHint = rec.lang.startsWith('ja') ? 'ja' : (rec.lang.startsWith('zh') ? 'zh-TW' : 'en');
                        translateTranscriptText(transcript, langHint);
                    } else {
                        interim += transcript + ' ';
                    }
                }
                sttInterimText = interim.trim();
                renderSubtitleOverlay();
            };

            rec.onerror = (ev) => {
                if (ev && ev.error === 'not-allowed') {
                    toast('麥克風權限被拒絕', 'error');
                    stopSttSubtitleEngine();
                    renderActiveTabBody();
                }
            };

            rec.onend = () => {
                if (sttRunning && speechRec === rec) {
                    try { rec.start(); } catch (e) {}
                }
            };

            speechRec = rec;
            try {
                rec.start();
                toast('麥克風即時雙語字幕已啟動', 'success');
            } catch (e) {
                stopSttSubtitleEngine();
                toast('無法啟動麥克風辨識', 'error');
            }
            renderSubtitleOverlay();
            renderActiveTabBody();
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

            // 停止不需要的視訊軌道，僅保留音軌（或在部分瀏覽器保留靜音引用）
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
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

            let windowPeakRms = 0;
            let rmsSampleTimer = setInterval(() => {
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
                    if (!chunks.length || peak < 0.008) return; // 靜音門檻跳過，防止幻覺與浪費

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
                            inlineData: { mimeType: blob.type || 'audio/webm', data: b64 }
                        });
                        const parsed = (typeof global.safeParseJSON === 'function')
                            ? global.safeParseJSON(raw)
                            : JSON.parse(raw);
                        if (parsed && parsed.original && parsed.original.trim()) {
                            pushSubtitleEntry(parsed.original, parsed.translation || '', parsed.lang || '');
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
            stopSttSubtitleEngine();
            toast('已取消音訊擷取', 'info');
        }
        renderSubtitleOverlay();
        renderActiveTabBody();
    }

    function renderSubtitleOverlay() {
        if (!subtitleOverlayEl) {
            subtitleOverlayEl = document.createElement('div');
            subtitleOverlayEl.id = 'ftLiveSubtitleOverlay';
            subtitleOverlayEl.className = 'hidden fixed z-[55] bottom-20 left-1/2 -translate-x-1/2 w-[min(94vw,640px)] rounded-2xl p-3 space-y-1.5 ft-subtitle-bar';
            document.body.appendChild(subtitleOverlayEl);
        }

        const latest = subtitleFeed[0] || null;
        const hasActivity = Boolean(videoMonitorTimer || sttRunning || sttInterimText || latest);
        if (!subtitlePinnedOverlay || !hasActivity) {
            subtitleOverlayEl.classList.add('hidden');
            return;
        }

        subtitleOverlayEl.classList.remove('hidden');
        const origHtml = latest
            ? renderClickableTokensHtml(latest.orig, latest.lang)
            : (sttInterimText ? `<span class="opacity-75">${escapeHtml(sttInterimText)}...</span>` : '<span class="text-slate-400">等待字幕／語音輸入中...</span>');
        const transHtml = (latest && latest.trans)
            ? `<div class="text-xs sm:text-sm font-semibold text-emerald-300 leading-snug">${escapeHtml(latest.trans)}</div>`
            : '';

        subtitleOverlayEl.innerHTML = `
            <div class="flex items-center justify-between gap-2 text-[10px] text-slate-300">
                <span class="font-bold flex items-center gap-1.5">
                    <span class="w-2 h-2 rounded-full ${(videoMonitorTimer || sttRunning) ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'}"></span>
                    <span>即時雙語字幕（點擊原文單字可查義入庫）</span>
                </span>
                <button type="button" id="ftSubtitleOverlayHideBtn" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white cursor-pointer">隱藏</button>
            </div>
            <div class="text-sm sm:text-base font-bold text-white leading-relaxed">${origHtml}</div>
            ${transHtml}
        `;

        const hideBtn = subtitleOverlayEl.querySelector('#ftSubtitleOverlayHideBtn');
        if (hideBtn) {
            hideBtn.onclick = () => {
                subtitlePinnedOverlay = false;
                renderSubtitleOverlay();
                if (activeTab === 'subtitle') renderActiveTabBody();
            };
        }
    }

    /* ==========================================================================
       6. 模組三：跨平台懸浮面板 UI、Document PiP & LZHNativeBridge
       ========================================================================== */

    function isFeatureEnabled() {
        const val = localStorage.getItem(STORAGE_ENABLED_KEY);
        return val === null ? true : val === 'true';
    }

    function setFeatureEnabled(enabled) {
        const flag = Boolean(enabled);
        localStorage.setItem(STORAGE_ENABLED_KEY, flag ? 'true' : 'false');
        if (!flag) {
            stopCameraStream();
            stopAllSubtitleEngines();
            closePipWindow();
            collapsePanel();
            hideTapBubble();
            if (rootEl) rootEl.classList.add('hidden');
        } else {
            ensureDomMounted();
            if (rootEl) rootEl.classList.remove('hidden');
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

    function applyBallPosition() {
        if (!ballEl) return;
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;
        const ballSize = 52;
        const margin = 12;
        const safeTop = clamp(posState.topPx !== null ? posState.topPx : Math.round(vh * 0.68), 68, Math.max(80, vh - ballSize - 24));
        posState.topPx = safeTop;
        const leftPx = posState.dockSide === 'left' ? margin : Math.max(margin, vw - ballSize - margin);

        ballEl.style.top = `${safeTop}px`;
        ballEl.style.left = `${leftPx}px`;
        ballEl.style.right = 'auto';
        ballEl.style.bottom = 'auto';
    }

    function applyPanelPosition() {
        if (!panelHostEl || pipWindowRef) return;
        const vw = global.innerWidth || document.documentElement.clientWidth || 375;
        const vh = global.innerHeight || document.documentElement.clientHeight || 667;

        const panelW = vw < 450 ? Math.min(410, Math.max(272, vw - 20)) : 410;
        panelHostEl.style.width = `${panelW}px`;
        panelHostEl.style.right = 'auto';
        panelHostEl.style.bottom = 'auto';

        const measuredW = panelHostEl.offsetWidth || panelW;
        const measuredH = panelHostEl.offsetHeight || Math.min(540, vh - 32);
        const marginX = vw < 450 ? 10 : 12;
        const minTop = 12;
        const maxLeft = Math.max(marginX, vw - measuredW - marginX);
        const maxTop = Math.max(minTop, vh - measuredH - 12);

        const defaultLeft = posState.dockSide === 'left' ? marginX : Math.max(marginX, vw - measuredW - marginX);
        const defaultTop = clamp((posState.topPx || Math.round(vh * 0.65)) - Math.round(measuredH * 0.6), 56, maxTop);
        const targetLeft = clamp(posState.panelLeftPx !== null ? posState.panelLeftPx : defaultLeft, marginX, maxLeft);
        const targetTop = clamp(posState.panelTopPx !== null ? posState.panelTopPx : defaultTop, minTop, maxTop);

        panelHostEl.style.left = `${targetLeft}px`;
        panelHostEl.style.top = `${targetTop}px`;
    }

    function supportsDocumentPip() {
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
        btn.title = (pipWindowRef && !pipWindowRef.closed) ? '歸還至主視窗' : '📌 彈出為獨立置頂小窗';
        btn.textContent = (pipWindowRef && !pipWindowRef.closed) ? '↩️ 歸還視窗' : '📌 獨立置頂';
    }

    function ensureDomMounted() {
        if (rootEl && document.body.contains(rootEl)) return;

        rootEl = document.createElement('div');
        rootEl.id = 'floatingTranslatorRoot';
        rootEl.className = isFeatureEnabled() ? '' : 'hidden';

        // 1. 懸浮球 (z-[55])
        ballEl = document.createElement('button');
        ballEl.id = 'floatingTranslatorBall';
        ballEl.type = 'button';
        ballEl.setAttribute('aria-label', '開啟全域懸浮翻譯視窗');
        ballEl.className = 'fixed z-[55] w-[52px] h-[52px] rounded-full bg-brand-600 hover:bg-brand-700 text-white shadow-xl border-2 border-white/80 dark:border-slate-700 flex items-center justify-center text-xl cursor-grab active:cursor-grabbing select-none transition-transform hover:scale-105';
        ballEl.style.touchAction = 'none';
        ballEl.innerHTML = '<span>🌐</span>';

        // 2. 頁內懸浮面板容器 (z-[55])
        panelHostEl = document.createElement('div');
        panelHostEl.id = 'floatingTranslatorPanelHost';
        panelHostEl.className = 'hidden fixed z-[55] max-h-[84vh] flex flex-col';

        panelContentEl = document.createElement('div');
        panelContentEl.id = 'floatingTranslatorPanelContent';
        panelContentEl.className = 'w-full h-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col overflow-hidden';

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
    }

    function buildPanelShellHtml() {
        return `
            <!-- 頂部可拖曳標題列 + 母語切換器 + PiP -->
            <div id="ftPanelDragHandle" class="px-3.5 py-2.5 bg-slate-50 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 cursor-move select-none shrink-0" style="touch-action:none;">
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-base">🌐</span>
                    <span class="text-xs font-black text-slate-900 dark:text-white truncate">三語懸浮翻譯</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <select id="ftTargetNativeSelect" title="設定目標翻譯母語" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold text-slate-700 dark:text-slate-200 outline-none cursor-pointer">
                        <option value="zh-TW">母語: 繁體中文</option>
                        <option value="en">Native: English</option>
                        <option value="ja">母語: 日本語</option>
                    </select>
                    <button type="button" id="ftPipToggleBtn" class="hidden px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-bold cursor-pointer">📌 獨立置頂</button>
                    <button type="button" id="ftPanelCloseBtn" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 flex items-center justify-center text-xs cursor-pointer" title="收合 (Esc)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>

            <!-- 3 大功能頁籤切換 -->
            <div class="px-3 pt-2 pb-1.5 border-b border-slate-100 dark:border-slate-700 grid grid-cols-3 gap-1.5 shrink-0">
                <button type="button" data-ft-tab="camera" class="py-1.5 px-2 rounded-xl text-[11px] font-extrabold transition cursor-pointer">📷 拍照翻譯</button>
                <button type="button" data-ft-tab="screen" class="py-1.5 px-2 rounded-xl text-[11px] font-extrabold transition cursor-pointer">📖 螢幕點詞</button>
                <button type="button" data-ft-tab="subtitle" class="py-1.5 px-2 rounded-xl text-[11px] font-extrabold transition cursor-pointer">🎬 即時字幕/語音</button>
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
        let startTop = 0;
        let startLeft = 0;

        ballEl.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = ballEl.getBoundingClientRect();
            startTop = rect.top;
            startLeft = rect.left;
            try { ballEl.setPointerCapture(e.pointerId); } catch (err) {}
        });

        ballEl.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.hypot(dx, dy) > 5) moved = true;
            if (!moved) return;

            const vw = global.innerWidth || 375;
            const vh = global.innerHeight || 667;
            const nextLeft = clamp(startLeft + dx, 6, vw - 58);
            const nextTop = clamp(startTop + dy, 58, vh - 68);
            ballEl.style.left = `${nextLeft}px`;
            ballEl.style.top = `${nextTop}px`;
        });

        const finishDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try { ballEl.releasePointerCapture(e.pointerId); } catch (err) {}
            if (moved) {
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

        // 頁內視窗自由拖曳定位（支援全尺寸與 Android 平板 / 手機觸控）
        const dragHandle = q('ftPanelDragHandle');
        if (dragHandle && panelHostEl) {
            let pDragging = false;
            let sX = 0;
            let sY = 0;
            let sL = 0;
            let sT = 0;

            dragHandle.addEventListener('pointerdown', (e) => {
                if (pipWindowRef) return;
                if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
                if (e.target && e.target.closest('button, select, input, textarea, a, label')) return;
                pDragging = true;
                sX = e.clientX;
                sY = e.clientY;
                const rect = panelHostEl.getBoundingClientRect();
                sL = rect.left;
                sT = rect.top;
                panelHostEl.style.right = 'auto';
                panelHostEl.style.bottom = 'auto';
                try { dragHandle.setPointerCapture(e.pointerId); } catch (err) {}
                e.preventDefault();
            });

            dragHandle.addEventListener('pointermove', (e) => {
                if (!pDragging) return;
                const vw = global.innerWidth || document.documentElement.clientWidth || 1024;
                const vh = global.innerHeight || document.documentElement.clientHeight || 768;
                const panelW = panelHostEl.offsetWidth || 320;
                const panelH = panelHostEl.offsetHeight || 360;
                const nextL = clamp(sL + (e.clientX - sX), 8, Math.max(8, vw - panelW - 8));
                const nextT = clamp(sT + (e.clientY - sY), 12, Math.max(12, vh - panelH - 12));
                panelHostEl.style.left = `${nextL}px`;
                panelHostEl.style.top = `${nextT}px`;
                posState.panelLeftPx = Math.round(nextL);
                posState.panelTopPx = Math.round(nextT);
            });

            const endPanelDrag = (e) => {
                if (!pDragging) return;
                pDragging = false;
                try { dragHandle.releasePointerCapture(e.pointerId); } catch (err) {}
                savePositionState();
            };
            dragHandle.addEventListener('pointerup', endPanelDrag);
            dragHandle.addEventListener('pointercancel', endPanelDrag);
        }

        updatePipButtonState();
    }

    function updateTabButtonsStyle() {
        const doc = getTargetDoc();
        doc.querySelectorAll('[data-ft-tab]').forEach(btn => {
            const tab = btn.getAttribute('data-ft-tab');
            if (tab === activeTab) {
                btn.className = 'py-1.5 px-2 rounded-xl text-[11px] font-extrabold transition cursor-pointer bg-brand-600 text-white shadow-xs';
            } else {
                btn.className = 'py-1.5 px-2 rounded-xl text-[11px] font-bold transition cursor-pointer bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600';
            }
        });
    }

    function switchTab(tab) {
        const valid = ['camera', 'screen', 'subtitle'].includes(tab) ? tab : 'camera';
        if (activeTab === 'camera' && valid !== 'camera') {
            stopCameraStream();
        }
        activeTab = valid;
        renderActiveTabBody();
        if (panelHostEl && (!pipWindowRef || pipWindowRef.closed) && isOpen) {
            applyPanelPosition();
        }
    }

    function renderActiveTabBody() {
        updateTabButtonsStyle();
        const body = q('ftTabBody');
        if (!body) return;

        if (activeTab === 'camera') {
            renderCameraTabHtml(body);
        } else if (activeTab === 'screen') {
            renderScreenTabHtml(body);
        } else {
            renderSubtitleTabHtml(body);
        }
    }

    function renderCameraTabHtml(body) {
        const cats = getDeckCategoriesList();
        const curDeck = getPreferredTargetDeckName();
        const selCount = photoSelectedTokenIds.size;

        body.innerHTML = `
            <input type="file" id="ftPhotoCameraInput" accept="image/*" capture="environment" class="hidden">
            <input type="file" id="ftPhotoGalleryInput" accept="image/*" class="hidden">

            <div class="grid grid-cols-3 gap-1.5">
                <button type="button" id="ftStartLiveCamBtn" class="py-2 px-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-extrabold cursor-pointer">📷 即時鏡頭</button>
                <button type="button" id="ftTakePhotoFileBtn" class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-800 dark:text-slate-100 text-[11px] font-bold cursor-pointer">📸 拍照</button>
                <button type="button" id="ftPickGalleryBtn" class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-800 dark:text-slate-100 text-[11px] font-bold cursor-pointer">🖼️ 相簿</button>
            </div>

            <div id="ftLiveCameraWrap" class="${cameraStream ? '' : 'hidden'} rounded-xl overflow-hidden bg-black relative">
                <video id="ftCameraVideo" autoplay playsinline muted class="w-full max-h-48 object-cover"></video>
                <div class="p-2 flex items-center justify-between gap-2 bg-slate-900/90">
                    <button type="button" id="ftCaptureShutterBtn" class="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-extrabold cursor-pointer">📸 擷取並定位辨識</button>
                    <button type="button" id="ftStopCamBtn" class="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold cursor-pointer">關閉</button>
                </div>
            </div>

            <div class="flex items-center justify-between gap-1.5">
                <div class="flex items-center gap-1">
                    <button type="button" id="ftPhotoModeLookupBtn" class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold cursor-pointer ${photoMode === 'lookup' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">👆 點擊查義</button>
                    <button type="button" id="ftPhotoModeSelectBtn" class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold cursor-pointer ${photoMode === 'select' ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">☑️ 選取入庫</button>
                </div>
                ${photoTokens.length > 0 ? `
                <div class="flex items-center gap-1">
                    <button type="button" id="ftPhotoSelectAllBtn" class="px-2 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold cursor-pointer">全選</button>
                    <button type="button" id="ftPhotoClearSelBtn" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold cursor-pointer">清空</button>
                </div>` : ''}
            </div>

            ${isVisionBusy ? `
                <div class="p-4 rounded-xl bg-brand-50 dark:bg-brand-950/40 border border-brand-200 dark:border-brand-800 text-center space-y-1.5">
                    <div class="text-xs font-extrabold text-brand-700 dark:text-brand-300 animate-pulse">正在進行 AI 視覺多語辨識與熱區座標定位...</div>
                    <div class="text-[11px] text-slate-400">完成後可直接點擊圖片單字查翻譯或切換選取入庫</div>
                </div>
            ` : ''}

            ${photoImageDataUrl ? `
                <div class="rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 overflow-auto max-h-60 flex justify-center">
                    <div class="relative inline-block max-w-full">
                        <img src="${photoImageDataUrl}" alt="辨識照片" class="block max-w-full h-auto rounded-lg select-none">
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
            ` : `
                <div class="p-5 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 text-center space-y-1 text-slate-400">
                    <div class="text-2xl">📷</div>
                    <div class="text-xs font-bold text-slate-600 dark:text-slate-300">支援課本／路牌／截圖拍照辨識（電腦可按 Ctrl+V 貼圖）</div>
                    <div class="text-[11px]">支援英文、日文（純平假名標音）、中文三語熱區精準點詞</div>
                </div>
            `}

            ${photoSummary ? `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs leading-relaxed">
                    <div class="text-[10px] font-extrabold text-slate-400 mb-0.5">全文語意翻譯</div>
                    <div class="text-slate-700 dark:text-slate-200 font-semibold">${escapeHtml(photoSummary)}</div>
                </div>
            ` : ''}

            ${(photoMode === 'select' || selCount > 0) ? `
                <div class="p-2.5 rounded-xl bg-emerald-50/70 dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 space-y-2">
                    <div class="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                        ${selCount === 0
                            ? '<span class="text-[11px] text-slate-400">點擊圖片方框勾選欲收錄的單字</span>'
                            : photoTokens.filter(tk => photoSelectedTokenIds.has(tk.id)).map(tk => `
                                <button type="button" data-ft-chip-remove="${escapeHtml(tk.id)}" class="px-2 py-0.5 rounded-lg bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 cursor-pointer">
                                    ${escapeHtml(tk.text)} ×
                                </button>
                            `).join('')
                        }
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5">
                        <select id="ftDeckSelect" class="flex-1 min-w-[120px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none">
                            ${cats.map(c => `<option value="${escapeHtml(c)}" ${c === curDeck ? 'selected' : ''}>📁 ${escapeHtml(c)}</option>`).join('')}
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

        const overlay = q('ftPhotoOverlay');
        if (overlay) {
            overlay.querySelectorAll('[data-ft-tok-id]').forEach(btn => {
                btn.onclick = (ev) => {
                    ev.stopPropagation();
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
        if (confirmBtn) confirmBtn.onclick = confirmImportSelectedPhotoTokens;
    }

    function renderScreenTabHtml(body) {
        const segHtml = screenScratchText
            ? renderClickableTokensHtml(screenScratchText)
            : '<span class="text-[11px] text-slate-400">在下方輸入或貼上英文／日文／中文句子，系統會以 Intl.Segmenter 自動精準斷詞，點擊任一詞即可查義入庫。</span>';

        body.innerHTML = `
            <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <label class="flex items-center justify-between gap-2 cursor-pointer">
                    <div>
                        <div class="text-xs font-extrabold text-slate-900 dark:text-white">📖 App 全域點詞翻譯</div>
                        <div class="text-[11px] text-slate-400">開啟後直接點擊畫面字詞即跳出三語釋義氣泡（自動避開測驗模式）</div>
                    </div>
                    <input type="checkbox" id="ftScreenTapToggle" ${screenTapEnabled ? 'checked' : ''} class="w-4 h-4 accent-brand-600 cursor-pointer">
                </label>
                <button type="button" id="ftPageSelectModeBtn" class="${pageSelectMode ? 'w-full py-2 px-3 rounded-xl bg-amber-500 text-white text-xs font-extrabold cursor-pointer flex items-center justify-center gap-1.5 shadow-xs' : 'w-full py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-100 text-xs font-bold cursor-pointer flex items-center justify-center gap-1.5'}">
                    <span>${pageSelectMode ? '☑️ 頁面選取模式進行中（點頁面單字反白）' : '☑️ 開啟「頁面點詞選取」模式'}</span>
                </button>
            </div>

            <div class="space-y-1.5">
                <div class="text-[11px] font-extrabold text-slate-600 dark:text-slate-300">三語分詞試譯區（EN / JA / ZH 混排皆可點擊）</div>
                <textarea id="ftScreenScratchInput" rows="3" placeholder="貼上任何英文、日文（如：今日はいい天気ですね）或中文文章..." class="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs outline-none">${escapeHtml(screenScratchText)}</textarea>
                <div class="flex items-center gap-2">
                    <button type="button" id="ftScreenTranslateBtn" ${isScreenTextBusy ? 'disabled' : ''} class="flex-1 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-extrabold cursor-pointer">
                        ${isScreenTextBusy ? '翻譯分詞中...' : '✨ 斷詞與整句翻譯'}
                    </button>
                    <button type="button" id="ftScreenClearBtn" class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-xs font-bold cursor-pointer">清空</button>
                </div>
            </div>

            <div class="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="text-[10px] font-extrabold text-slate-400">可點擊分詞結果：</div>
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
                    if (typeof global.callGeminiApi === 'function') {
                        try {
                            trans = String(await global.callGeminiApi(`將以下文字通順翻譯成「${nativeCfg.aiName}」，僅輸出譯文：\n${screenScratchText}`, { silent: true }) || '').trim();
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

        body.innerHTML = `
            <div class="grid grid-cols-2 gap-1.5">
                <button type="button" id="ftSubVideoModeBtn" class="py-1.5 px-2 rounded-xl text-[11px] font-extrabold cursor-pointer ${subtitleSubMode === 'video' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">📺 螢幕／影片幀差字幕</button>
                <button type="button" id="ftSubSttModeBtn" class="py-1.5 px-2 rounded-xl text-[11px] font-extrabold cursor-pointer ${subtitleSubMode === 'stt' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}">🎙️ 即時雙語語音字幕</button>
            </div>

            ${subtitleSubMode === 'video' ? `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">偵測區域 (ROI)</span>
                        <select id="ftVideoRoiSelect" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-bold">
                            <option value="bottom25" ${videoRoiMode === 'bottom25' ? 'selected' : ''}>底部 25% 字幕區（最省流）</option>
                            <option value="bottom40" ${videoRoiMode === 'bottom40' ? 'selected' : ''}>底部 40% 字幕區</option>
                            <option value="full" ${videoRoiMode === 'full' ? 'selected' : ''}>全畫面掃描</option>
                        </select>
                    </div>
                    <div class="flex items-center gap-2">
                        <button type="button" id="ftVideoMonitorToggleBtn" class="flex-1 py-2 rounded-xl text-xs font-extrabold text-white cursor-pointer ${videoActive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}">
                            ${videoActive ? '⏹ 停止螢幕字幕偵測' : '▶ 開始擷取螢幕／影片字幕'}
                        </button>
                    </div>
                    <div class="text-[10px] text-slate-400">使用 Canvas 像素幀差偵測，僅在字幕區域變化時才呼叫 AI 辨識與翻譯。</div>
                </div>
            ` : `
                <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="grid grid-cols-2 gap-1.5">
                        <button type="button" id="ftSttMicBtn" class="py-1.5 px-2 rounded-lg text-[11px] font-bold cursor-pointer ${sttSource === 'mic' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}">🎤 麥克風環境收音</button>
                        <button type="button" id="ftSttTabBtn" class="py-1.5 px-2 rounded-lg text-[11px] font-bold cursor-pointer ${sttSource === 'tab' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}">������ 媒體/分頁音訊</button>
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
                    ` : `<div class="text-[10px] text-slate-400">分享影片分頁並勾選音訊，含靜音能量偵測防幻覺。</div>`}
                    <button type="button" id="ftSttToggleBtn" class="w-full py-2 rounded-xl text-xs font-extrabold text-white cursor-pointer ${sttRunning ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}">
                        ${sttRunning ? '⏹ 停止即時語音字幕' : '🎙️ 啟動即時雙語字幕'}
                    </button>
                </div>
            `}

            <div class="flex items-center justify-between gap-2">
                <label class="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" id="ftSubtitlePinToggle" ${subtitlePinnedOverlay ? 'checked' : ''} class="accent-brand-600">
                    <span>頁底懸浮雙語字幕條</span>
                </label>
                <button type="button" id="ftSubtitleClearFeedBtn" class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[10px] font-bold text-slate-500 dark:text-slate-300 cursor-pointer">清除紀錄</button>
            </div>

            <div class="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                ${subtitleFeed.length === 0
                    ? '<div class="p-4 text-center text-[11px] text-slate-400">尚無字幕紀錄。字幕出現後可直接點擊原文單字查翻譯與入庫！</div>'
                    : subtitleFeed.map(item => `
                        <div class="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-1">
                            <div class="flex items-center justify-between text-[10px] text-slate-400">
                                <span class="font-bold uppercase">${escapeHtml(item.lang || '')}</span>
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
        if (vModeBtn) vModeBtn.onclick = () => { subtitleSubMode = 'video'; renderActiveTabBody(); };
        if (sModeBtn) sModeBtn.onclick = () => { subtitleSubMode = 'stt'; renderActiveTabBody(); };

        const roiSel = q('ftVideoRoiSelect');
        if (roiSel) roiSel.onchange = () => { videoRoiMode = roiSel.value; videoLastFrameLuma = null; };
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

    function openPanel(tabName) {
        if (!isFeatureEnabled()) setFeatureEnabled(true);
        ensureDomMounted();
        if (tabName) activeTab = tabName;
        isOpen = true;
        try { localStorage.setItem(STORAGE_OPEN_KEY, 'true'); } catch (e) {}

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

    function collapsePanel() {
        isOpen = false;
        stopCameraStream();
        try { localStorage.setItem(STORAGE_OPEN_KEY, 'false'); } catch (e) {}
        if (panelHostEl) panelHostEl.classList.add('hidden');
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

        global.addEventListener('beforeunload', () => {
            stopCameraStream();
            stopAllSubtitleEngines();
        });
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
        async onNativeTranscript(text, lang) {
            if (!text) return;
            await translateTranscriptText(String(text), lang || '');
        }
    };

    /* ==========================================================================
       8. 初始化與對外公開 API（含 PhotoOcrImporter 相容別名）
       ========================================================================== */

    function init() {
        initNativeLangPreference();
        loadPositionState();
        setScreenTapEnabled(localStorage.getItem(STORAGE_TAP_ENABLED_KEY) === 'true');
        bindGlobalSystemListeners();
        ensureDomMounted();
        if (localStorage.getItem(STORAGE_OPEN_KEY) === 'true' && isFeatureEnabled()) {
            openPanel(activeTab);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.FloatingTranslator = {
        init,
        open: openPanel,
        openCameraTranslator: () => {
            setFeatureEnabled(true);
            openPanel('camera');
        },
        close: collapsePanel,
        collapse: collapsePanel,
        toggle: togglePanel,
        setEnabled: setFeatureEnabled,
        isEnabled: isFeatureEnabled,
        setTargetNativeLang,
        getTargetNativeLang: () => targetNativeLang,
        setScreenTapEnabled,
        setPageSelectionMode,
        switchTab,
        openPipWindow,
        closePipWindow,
        // 匯出純函式供自動化測試驗證
        detectScriptLang,
        segmentTrilingualText,
        extractWordAtPoint,
        isExamModeOrProtectedTarget,
        box1000ToPercentRect,
        computeFrameDiffRatio,
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
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
