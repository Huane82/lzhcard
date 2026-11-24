/**
 * LZHCard - 拍照點擊翻譯與多選快速入庫模組 (js/photoOcr.js)
 * 支援：
 * 1. Capacitor 原生 Camera 外掛偵測 + Web <input type="file" capture="environment"> / 相簿選圖降級
 * 2. Tesseract.js CDN 動態按需載入與即時辨識進度條
 * 3. 圖片響應式百分比熱區 (.ocr-word-box) 精準疊加
 * 4. 雙模式工具列：「👆 點擊查翻譯（預設）」與「☑️ 開啟選取入庫模式」
 * 5. 底部可編輯單字 Chip 暫存列、指定目標字庫 / 建立新字庫、繼承跨字庫 FSRS 進度與背景 runBatchAiAutoFill
 */

(function (global) {
    'use strict';

    const TESSERACT_CDN_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    const DEFAULT_OCR_LANG = 'eng';

    let tesseractLoadPromise = null;
    const sessionLookupCache = new Map();

    const state = {
        imageSrc: '',
        naturalWidth: 0,
        naturalHeight: 0,
        ocrLang: DEFAULT_OCR_LANG,
        isRecognizing: false,
        mode: 'lookup', // 'lookup' | 'select'
        tokens: [],     // [{ id, rawText, cleanWord, normKey, bbox: { x0, y0, x1, y1 } }]
        fullRawText: '',
        articleTranslation: '',
        isTranslatingArticle: false,
        articleViewMode: 'trans', // 'trans' | 'both'
        selectedItems: [], // [{ id, word, normKey, sourceTokenId }]
        activeTokenId: null,
        lookupSeq: 0,
        lastRecognizeToken: 0
    };

    function escapeOcrHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function normalizeOcrWordKey(raw) {
        const cleaned = cleanOcrWordToken(raw);
        if (typeof global.normalizeWordKey === 'function') {
            return global.normalizeWordKey(cleaned);
        }
        return cleaned.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]/g, '');
    }

    function cleanOcrWordToken(raw) {
        if (!raw) return '';
        let str = String(raw).trim();
        // 保留英文單字、連字號與內部撇號（例如 don't / well-known），去除前後標點與數字雜訊
        str = str.replace(/^[^a-zA-Z\u3040-\u30ff\u4e00-\u9faf]+|[^a-zA-Z\u3040-\u30ff\u4e00-\u9faf]+$/g, '');
        str = str.replace(/[’‘]/g, "'");
        return str.trim();
    }

    function isValidOcrWord(raw, ocrLang = state.ocrLang) {
        const cleaned = cleanOcrWordToken(raw);
        if (!cleaned) return false;
        // 過濾純數字或純符號
        if (/^[0-9\s.,:;!?'"()\[\]{}\-_/\\|@#$%^&*+=~`<>]+$/.test(cleaned)) return false;

        if (ocrLang === 'eng') {
            // 英文單字至少含 2 個英文字母（避免單一雜訊字母點誤判），允許 I/a 例外略過
            return /[a-zA-Z]{2,}/.test(cleaned) && !/\d/.test(cleaned);
        }
        // 中英切換模式下也接受日/中文或英文詞彙
        return /[a-zA-Z]{2,}|[\u4e00-\u9fff\u3040-\u30ff]{1,}/.test(cleaned);
    }

    function loadTesseractScript() {
        if (global.Tesseract && typeof global.Tesseract.createWorker === 'function') {
            return Promise.resolve(global.Tesseract);
        }
        if (tesseractLoadPromise) return tesseractLoadPromise;

        tesseractLoadPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-lzhcard-tesseract="1"]');
            if (existing) {
                existing.addEventListener('load', () => resolve(global.Tesseract));
                existing.addEventListener('error', () => reject(new Error('Tesseract.js 載入失敗')));
                return;
            }
            const script = document.createElement('script');
            script.src = TESSERACT_CDN_URL;
            script.async = true;
            script.dataset.lzhcardTesseract = '1';
            script.onload = () => {
                if (global.Tesseract) {
                    resolve(global.Tesseract);
                } else {
                    tesseractLoadPromise = null;
                    reject(new Error('Tesseract.js 初始化失敗'));
                }
            };
            script.onerror = () => {
                tesseractLoadPromise = null;
                reject(new Error('無法連線載入 Tesseract.js OCR 引擎'));
            };
            document.head.appendChild(script);
        });

        return tesseractLoadPromise;
    }

    function updateProgressUI(visible, percent = 0, label = '') {
        const box = document.getElementById('photoOcrProgressBox');
        const bar = document.getElementById('photoOcrProgressBar');
        const text = document.getElementById('photoOcrProgressText');
        const pctEl = document.getElementById('photoOcrProgressPct');
        if (!box) return;
        if (!visible) {
            box.classList.add('hidden');
            return;
        }
        const safePct = Math.max(0, Math.min(100, Math.round(percent)));
        box.classList.remove('hidden');
        if (bar) bar.style.width = `${safePct}%`;
        if (pctEl) pctEl.textContent = `${safePct}%`;
        if (text && label) text.textContent = label;
    }

    function populateDeckSelector() {
        const select = document.getElementById('photoOcrTargetDeck');
        const newInput = document.getElementById('photoOcrNewDeckInput');
        if (!select) return;

        const defaultCat = (typeof t === 'function' && t('defaultCategoryName') && t('defaultCategoryName') !== 'defaultCategoryName')
            ? t('defaultCategoryName')
            : '預設字庫';

        let cats = [];
        if (typeof global.getAllCategories === 'function') {
            cats = global.getAllCategories();
        } else if (typeof global.wordList !== 'undefined' && Array.isArray(global.wordList)) {
            const set = new Set();
            global.wordList.forEach(w => {
                if (w && w.category) set.add(String(w.category).trim());
            });
            cats = Array.from(set);
        }

        if (cats.length === 0) cats = [defaultCat];

        const lastSaved = localStorage.getItem('lzhcard_last_ocr_deck') || '';
        const prevVal = select.value;

        select.innerHTML = '';
        cats.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = cat;
            select.appendChild(opt);
        });

        const createOpt = document.createElement('option');
        createOpt.value = '__NEW__';
        createOpt.textContent = '＋ 建立新字庫';
        select.appendChild(createOpt);

        if (prevVal && prevVal !== '__NEW__' && cats.includes(prevVal)) {
            select.value = prevVal;
        } else if (lastSaved && cats.includes(lastSaved)) {
            select.value = lastSaved;
        } else {
            select.value = cats[0];
        }

        if (newInput) {
            newInput.classList.toggle('hidden', select.value !== '__NEW__');
        }
    }

    function handleDeckSelectChange(val) {
        const newInput = document.getElementById('photoOcrNewDeckInput');
        if (!newInput) return;
        const isNew = val === '__NEW__';
        newInput.classList.toggle('hidden', !isNew);
        if (isNew) {
            setTimeout(() => newInput.focus(), 50);
        }
    }

    function updateModeToolbarUI() {
        const lookupBtn = document.getElementById('photoOcrModeLookupBtn');
        const selectBtn = document.getElementById('photoOcrModeSelectBtn');
        const langSelect = document.getElementById('photoOcrLangSelect');
        const modeHint = document.getElementById('photoOcrModeHint');

        if (lookupBtn) {
            const active = state.mode === 'lookup';
            lookupBtn.className = active
                ? 'px-3 py-1.5 rounded-lg text-xs font-extrabold transition bg-brand-600 text-white shadow-xs cursor-pointer flex items-center gap-1.5'
                : 'px-3 py-1.5 rounded-lg text-xs font-bold transition bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 cursor-pointer flex items-center gap-1.5';
        }
        if (selectBtn) {
            const active = state.mode === 'select';
            selectBtn.className = active
                ? 'px-3 py-1.5 rounded-lg text-xs font-extrabold transition bg-emerald-600 text-white shadow-xs cursor-pointer flex items-center gap-1.5'
                : 'px-3 py-1.5 rounded-lg text-xs font-bold transition bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 cursor-pointer flex items-center gap-1.5';
        }
        if (langSelect) {
            langSelect.value = state.ocrLang;
        }
        if (modeHint) {
            modeHint.textContent = state.mode === 'select'
                ? '目前為「選取入庫模式」：點擊圖片上的單字框可複選，再按確認加入與 AI 生成'
                : '目前為「點擊查翻譯模式」：點擊圖片上的任何英文單字立即顯示中文釋義';
        }
    }

    function setMode(mode) {
        state.mode = mode === 'select' ? 'select' : 'lookup';
        updateModeToolbarUI();
        renderHotspotsOverlay();
        if (state.mode === 'select') {
            hideLookupCard();
        }
    }

    function setOcrLang(lang) {
        const normalized = (lang === 'eng+chi_tra') ? 'eng+chi_tra' : 'eng';
        state.ocrLang = normalized;
        updateModeToolbarUI();
        if (state.imageSrc && state.naturalWidth > 0 && !state.isRecognizing) {
            runOcrOnLoadedImage();
        }
    }

    function isTokenSelected(cleanWord) {
        const norm = normalizeOcrWordKey(cleanWord);
        return state.selectedItems.some(item => item.normKey === norm);
    }

    function computeBoxPercentages(bbox, naturalWidth, naturalHeight) {
        if (!bbox || !naturalWidth || !naturalHeight) {
            return { leftPct: 0, topPct: 0, widthPct: 0, heightPct: 0 };
        }
        const x0 = Math.max(0, Number(bbox.x0) || 0);
        const y0 = Math.max(0, Number(bbox.y0) || 0);
        const x1 = Math.min(naturalWidth, Number(bbox.x1) || x0);
        const y1 = Math.min(naturalHeight, Number(bbox.y1) || y0);

        const leftPct = Math.max(0, Math.min(100, (x0 / naturalWidth) * 100));
        const topPct = Math.max(0, Math.min(100, (y0 / naturalHeight) * 100));
        const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((x1 - x0) / naturalWidth) * 100));
        const heightPct = Math.max(0.5, Math.min(100 - topPct, ((y1 - y0) / naturalHeight) * 100));

        return { leftPct, topPct, widthPct, heightPct };
    }

    function renderHotspotsOverlay() {
        const overlay = document.getElementById('photoOcrOverlay');
        if (!overlay) return;

        if (!state.tokens.length || !state.naturalWidth || !state.naturalHeight) {
            overlay.innerHTML = '';
            return;
        }

        const natW = state.naturalWidth;
        const natH = state.naturalHeight;

        overlay.innerHTML = state.tokens.map(tok => {
            const pct = computeBoxPercentages(tok.bbox, natW, natH);
            const selected = isTokenSelected(tok.cleanWord);
            const activeLookup = state.mode === 'lookup' && state.activeTokenId === tok.id;

            let boxClass = 'ocr-word-box absolute rounded transition-all cursor-pointer focus:outline-none ';
            if (state.mode === 'select') {
                boxClass += selected
                    ? 'border-2 border-emerald-500 bg-emerald-500/25 shadow-sm'
                    : 'border border-sky-400/50 bg-sky-400/10 hover:bg-emerald-400/20 hover:border-emerald-400';
            } else {
                boxClass += activeLookup
                    ? 'border-2 border-blue-500 bg-blue-500/25 ring-2 ring-blue-400/50'
                    : 'border border-blue-400/35 bg-blue-400/5 hover:bg-blue-500/20 hover:border-blue-500';
            }

            const checkHtml = (state.mode === 'select' && selected)
                ? '<span class="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-emerald-600 text-white text-[9px] font-black flex items-center justify-center shadow pointer-events-none">✓</span>'
                : '';

            return `<button type="button"
                data-ocr-token-id="${escapeOcrHtml(tok.id)}"
                title="${escapeOcrHtml(tok.cleanWord)}"
                aria-label="${escapeOcrHtml(tok.cleanWord)}"
                class="${boxClass}"
                style="left:${pct.leftPct.toFixed(3)}%;top:${pct.topPct.toFixed(3)}%;width:${pct.widthPct.toFixed(3)}%;height:${pct.heightPct.toFixed(3)}%;">${checkHtml}</button>`;
        }).join('');
    }

    function renderSelectedChipsBar() {
        const chipsContainer = document.getElementById('photoOcrSelectedChips');
        const confirmBtn = document.getElementById('photoOcrConfirmImportBtn');
        const countBadge = document.getElementById('photoOcrSelectedCountBadge');

        const count = state.selectedItems.length;
        if (countBadge) countBadge.textContent = String(count);

        if (confirmBtn) {
            confirmBtn.disabled = count === 0;
            confirmBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles mr-1"></i>確認加入並 AI 生成（${count} 字）`;
            confirmBtn.className = count > 0
                ? 'w-full sm:w-auto px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs shadow-sm transition cursor-pointer shrink-0 flex items-center justify-center'
                : 'w-full sm:w-auto px-4 py-2.5 bg-slate-200 dark:bg-slate-700 text-slate-400 font-bold rounded-xl text-xs cursor-not-allowed shrink-0 flex items-center justify-center';
        }

        if (!chipsContainer) return;

        if (count === 0) {
            chipsContainer.innerHTML = '<span class="text-[11px] text-slate-400 dark:text-slate-500 py-1 whitespace-nowrap">尚未選取任何單字（切換至「選取入庫模式」點擊圖片單字，或從查字彈窗加入）</span>';
            return;
        }

        chipsContainer.innerHTML = state.selectedItems.map(item => `
            <div class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs font-bold shrink-0">
                <button type="button" data-chip-edit="${escapeOcrHtml(item.id)}" class="hover:underline cursor-pointer text-left" title="點擊修改拼字">${escapeOcrHtml(item.word)}</button>
                <button type="button" data-chip-remove="${escapeOcrHtml(item.id)}" class="w-4 h-4 rounded-full hover:bg-emerald-200 dark:hover:bg-emerald-800 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-[11px] font-black cursor-pointer" title="移除此字">×</button>
            </div>
        `).join('');
    }

    function addSelectedWord(word, sourceTokenId = '') {
        const cleaned = cleanOcrWordToken(word);
        const normKey = normalizeOcrWordKey(cleaned);
        if (!cleaned || !normKey) return false;
        if (state.selectedItems.some(item => item.normKey === normKey)) {
            return false;
        }
        state.selectedItems.push({
            id: `chip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            word: cleaned,
            normKey,
            sourceTokenId: sourceTokenId || ''
        });
        renderSelectedChipsBar();
        renderHotspotsOverlay();
        return true;
    }

    function removeSelectedWordByNormOrId(idOrNorm) {
        state.selectedItems = state.selectedItems.filter(item => item.id !== idOrNorm && item.normKey !== idOrNorm);
        renderSelectedChipsBar();
        renderHotspotsOverlay();
    }

    function openChipInlineEdit(chipId, chipContainer) {
        const item = state.selectedItems.find(x => x.id === chipId);
        if (!item || !chipContainer) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.word;
        input.className = 'w-24 px-1.5 py-0.5 text-xs font-bold bg-white dark:bg-slate-900 border border-emerald-400 rounded outline-none text-slate-900 dark:text-white';

        const commit = () => {
            const edited = cleanOcrWordToken(input.value);
            const norm = normalizeOcrWordKey(edited);
            if (!edited || !norm) {
                removeSelectedWordByNormOrId(item.id);
                return;
            }
            const dup = state.selectedItems.find(other => other.id !== item.id && other.normKey === norm);
            if (dup) {
                removeSelectedWordByNormOrId(item.id);
            } else {
                item.word = edited;
                item.normKey = norm;
                renderSelectedChipsBar();
                renderHotspotsOverlay();
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                renderSelectedChipsBar();
            }
        });

        chipContainer.replaceChildren(input);
        input.focus();
        input.select();
    }

    function selectAllRecognizedWords() {
        let added = 0;
        state.tokens.forEach(tok => {
            if (addSelectedWord(tok.cleanWord, tok.id)) added++;
        });
        if (state.mode !== 'select') {
            setMode('select');
        }
        if (typeof global.showToast === 'function') {
            global.showToast(added > 0 ? `已全選 ${added} 個辨識單字` : '所有辨識單字皆已在選取清單中', 'info');
        }
    }

    function clearSelectedWords() {
        state.selectedItems = [];
        renderSelectedChipsBar();
        renderHotspotsOverlay();
    }

    function hideLookupCard() {
        const card = document.getElementById('photoOcrLookupCard');
        if (card) card.classList.add('hidden');
        state.activeTokenId = null;
    }

    async function lookupOcrWord(word) {
        const cleanWord = cleanOcrWordToken(word);
        const norm = normalizeOcrWordKey(cleanWord);
        if (!cleanWord || !norm) return null;

        // 1. 優先檢索 ReaderPopover 管道（本機 wordList ➔ IndexedDB + VOCAB_7000_DATA ➔ sessionCache）
        if (global.ReaderPopover) {
            if (typeof global.ReaderPopover.lookupInWordList === 'function') {
                const localHit = global.ReaderPopover.lookupInWordList(cleanWord);
                if (localHit) return localHit;
            }
            if (typeof global.ReaderPopover.lookupInIdb === 'function') {
                try {
                    const idbHit = await global.ReaderPopover.lookupInIdb(cleanWord);
                    if (idbHit) return idbHit;
                } catch (e) {}
            }
            if (typeof global.ReaderPopover.lookupInSession === 'function') {
                const sessHit = global.ReaderPopover.lookupInSession(cleanWord);
                if (sessHit) return sessHit;
            }
        }

        // 2. 本模組 sessionLookupCache
        if (sessionLookupCache.has(norm)) {
            return sessionLookupCache.get(norm);
        }

        // 3. 若 ReaderPopover 有完整 lookupReaderWord（會走 7000 單 / 輕量 AI + 快取），直接複用
        if (global.ReaderPopover && typeof global.ReaderPopover.lookupReaderWord === 'function') {
            try {
                const res = await global.ReaderPopover.lookupReaderWord(cleanWord);
                if (res && res.meaning) {
                    sessionLookupCache.set(norm, res);
                    return res;
                }
            } catch (e) {}
        }

        // 4. 直接檢查本機 wordList（即使 ReaderPopover 未載入）
        if (typeof global.wordList !== 'undefined' && Array.isArray(global.wordList)) {
            const directHit = global.wordList.find(w => w && normalizeOcrWordKey(w.word) === norm);
            if (directHit && directHit.meaning && !String(directHit.meaning).includes('解析中')) {
                const hit = {
                    word: directHit.word,
                    lemma: directHit.word,
                    pos: directHit.pos || '',
                    phonetic: directHit.phonetic || '',
                    meaning: directHit.meaning,
                    source: '本機字庫'
                };
                sessionLookupCache.set(norm, hit);
                return hit;
            }
        }

        // 5. 輕量 Gemini AI 後援翻譯並快取於 session
        if (typeof global.callGeminiApi === 'function') {
            if (typeof global.ensureAiPrivacyConsent === 'function' && (!global.hasAiPrivacyConsent || !global.hasAiPrivacyConsent())) {
                const consented = await global.ensureAiPrivacyConsent({ feature: 'def_fill' });
                if (!consented) return null;
            }
            const nativeName = (typeof global.getLanguageConfig === 'function')
                ? global.getLanguageConfig().nativeName
                : 'Traditional Chinese (繁體中文)';
            const prompt = `Translate this vocabulary word concisely for a learner.
Word: "${cleanWord}"
Native Language: ${nativeName}
Return ONLY raw JSON object:
{"word":"${cleanWord}","lemma":"base dictionary form","pos":"part of speech","phonetic":"IPA","meaning":"concise definition in ${nativeName}"}`;

            try {
                const raw = await global.callGeminiApi(prompt, { silent: true });
                const parsed = typeof global.safeParseJSON === 'function' ? global.safeParseJSON(raw) : JSON.parse(raw);
                if (parsed && parsed.meaning) {
                    const entry = {
                        word: parsed.word || cleanWord,
                        lemma: parsed.lemma || cleanWord,
                        pos: parsed.pos || '',
                        phonetic: parsed.phonetic || '',
                        meaning: parsed.meaning,
                        source: 'AI 即時查詢'
                    };
                    sessionLookupCache.set(norm, entry);
                    return entry;
                }
            } catch (err) {
                console.warn('[PhotoOcr] AI lookup failed:', err);
            }
        }

        return null;
    }

    async function handleTokenLookupClick(tok) {
        const card = document.getElementById('photoOcrLookupCard');
        const wordEl = document.getElementById('photoOcrLookupWord');
        const metaEl = document.getElementById('photoOcrLookupMeta');
        const meaningEl = document.getElementById('photoOcrLookupMeaning');
        const addBtn = document.getElementById('photoOcrLookupAddBtn');
        const speakBtn = document.getElementById('photoOcrLookupSpeakBtn');

        state.activeTokenId = tok.id;
        renderHotspotsOverlay();

        const seq = ++state.lookupSeq;
        if (card) card.classList.remove('hidden');
        if (wordEl) wordEl.textContent = tok.cleanWord;
        if (metaEl) metaEl.textContent = '查詢釋義中...';
        if (meaningEl) meaningEl.textContent = '⏳ 正在比對本機字庫與離線字典...';

        if (speakBtn) {
            speakBtn.onclick = () => {
                if (global.ReaderPopover && typeof global.ReaderPopover.speakReaderWord === 'function') {
                    global.ReaderPopover.speakReaderWord(tok.cleanWord);
                } else if (typeof global.speakWord === 'function') {
                    global.speakWord(tok.cleanWord);
                }
            };
        }

        if (addBtn) {
            addBtn.onclick = () => {
                const added = addSelectedWord(tok.cleanWord, tok.id);
                if (typeof global.showToast === 'function') {
                    global.showToast(added ? `已將「${tok.cleanWord}」加入下方入庫清單` : `「${tok.cleanWord}」已在下方清單中`, added ? 'success' : 'info');
                }
            };
        }

        const result = await lookupOcrWord(tok.cleanWord);
        if (seq !== state.lookupSeq) return;

        if (!result) {
            if (metaEl) metaEl.textContent = '未命中字典';
            if (meaningEl) meaningEl.textContent = '找不到此字的現成釋義，可直接加入下方清單由 AI 批次補齊！';
            return;
        }

        const displayWord = result.lemma && result.lemma.toLowerCase() !== tok.cleanWord.toLowerCase()
            ? `${tok.cleanWord} → ${result.lemma}`
            : (result.word || tok.cleanWord);
        if (wordEl) wordEl.textContent = displayWord;

        const metaParts = [result.pos, result.phonetic, result.source].filter(Boolean);
        if (metaEl) metaEl.textContent = metaParts.join(' · ') || '詞義解析';
        if (meaningEl) meaningEl.textContent = result.meaning || '尚無釋義';

        if (addBtn) {
            addBtn.onclick = () => {
                const targetWord = (result.lemma || result.word || tok.cleanWord).trim();
                const added = addSelectedWord(targetWord, tok.id);
                if (typeof global.showToast === 'function') {
                    global.showToast(added ? `已將「${targetWord}」加入下方入庫清單` : `「${targetWord}」已在下方清單中`, added ? 'success' : 'info');
                }
            };
        }
    }

    function handleOverlayTokenClick(tokenId) {
        const tok = state.tokens.find(t => t.id === tokenId);
        if (!tok) return;

        if (state.mode === 'select') {
            if (isTokenSelected(tok.cleanWord)) {
                removeSelectedWordByNormOrId(tok.normKey);
            } else {
                addSelectedWord(tok.cleanWord, tok.id);
            }
            return;
        }

        handleTokenLookupClick(tok);
    }

    function extractOcrTokensFromData(data) {
        const rawWords = [];
        if (data && Array.isArray(data.words) && data.words.length > 0) {
            rawWords.push(...data.words);
        } else if (data && Array.isArray(data.lines)) {
            data.lines.forEach(line => {
                if (line && Array.isArray(line.words)) {
                    rawWords.push(...line.words);
                }
            });
        }

        const tokens = [];
        rawWords.forEach((w, idx) => {
            if (!w || !w.bbox) return;
            const rawText = String(w.text || '').trim();
            if (!isValidOcrWord(rawText, state.ocrLang)) return;
            const cleanWord = cleanOcrWordToken(rawText);
            const normKey = normalizeOcrWordKey(cleanWord);
            if (!cleanWord || !normKey) return;

            tokens.push({
                id: `tok_${idx}_${Date.now()}`,
                rawText,
                cleanWord,
                normKey,
                bbox: {
                    x0: Number(w.bbox.x0) || 0,
                    y0: Number(w.bbox.y0) || 0,
                    x1: Number(w.bbox.x1) || 0,
                    y1: Number(w.bbox.y1) || 0
                }
            });
        });
        return tokens;
    }

    function ensurePhotoOcrModalDom() {
        if (typeof document === 'undefined') return null;
        let modal = document.getElementById('photoOcrModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'photoOcrModal';
            modal.className = 'hidden fixed inset-0 z-[70] bg-slate-950/70 backdrop-blur-xs items-center justify-center p-3 sm:p-5 lzh-safe-modal';
            modal.innerHTML = `
                <div class="w-full max-w-3xl max-h-[90vh] bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col overflow-hidden">
                    <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                        <div class="text-sm font-black text-slate-900 dark:text-white">📷 拍照 OCR 點詞與整篇翻譯</div>
                        <button type="button" onclick="if(typeof PhotoOcrImporter!=='undefined') PhotoOcrImporter.close()" class="w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 font-bold flex items-center justify-center cursor-pointer" aria-label="關閉">✕</button>
                    </div>
                    <div class="p-4 overflow-y-auto space-y-3">
                        <input type="file" id="photoOcrCameraInput" accept="image/*" capture="environment" class="hidden">
                        <input type="file" id="photoOcrGalleryInput" accept="image/*" class="hidden">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="flex flex-wrap items-center gap-2">
                                <button type="button" onclick="PhotoOcrImporter.triggerCapture(true)" class="min-h-[44px] px-3.5 py-2 rounded-xl bg-brand-600 text-white text-xs font-extrabold cursor-pointer">拍照</button>
                                <button type="button" onclick="PhotoOcrImporter.triggerCapture(false)" class="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold cursor-pointer">相簿選圖</button>
                                <button type="button" id="photoOcrModeLookupBtn" onclick="PhotoOcrImporter.setMode('lookup')" class="min-h-[44px] px-3 py-2 rounded-lg text-xs font-extrabold bg-brand-600 text-white cursor-pointer">👆 點擊查翻譯</button>
                                <button type="button" id="photoOcrModeSelectBtn" onclick="PhotoOcrImporter.setMode('select')" class="min-h-[44px] px-3 py-2 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 cursor-pointer">☑️ 選取入庫</button>
                            </div>
                            <select id="photoOcrLangSelect" onchange="PhotoOcrImporter.setOcrLang(this.value)" class="min-h-[44px] px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold outline-none">
                                <option value="eng">英文 OCR</option>
                                <option value="eng+chi_tra">中英混排 OCR</option>
                            </select>
                        </div>
                        <div id="photoOcrModeHint" class="text-[11px] text-slate-500 dark:text-slate-400"></div>
                        <div id="photoOcrProgressBox" class="hidden p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-1.5">
                            <div class="flex justify-between text-[11px] font-bold text-slate-600 dark:text-slate-300">
                                <span id="photoOcrProgressText">正在辨識...</span>
                                <span id="photoOcrProgressPct">0%</span>
                            </div>
                            <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                                <div id="photoOcrProgressBar" class="h-full bg-brand-600 transition-all" style="width:0%"></div>
                            </div>
                        </div>
                        <div id="photoOcrStageHost" class="flex justify-center bg-slate-100 dark:bg-slate-950 rounded-2xl p-2 border border-slate-200 dark:border-slate-800 min-h-[160px] items-center">
                            <div id="photoOcrEmptyPlaceholder" class="text-xs text-slate-500 py-8">請拍照或從相簿選擇照片開始辨識</div>
                            <div id="photoOcrImageWrapper" class="hidden relative">
                                <img id="photoOcrImage" alt="OCR Preview">
                                <div id="photoOcrOverlay" class="absolute inset-0"></div>
                            </div>
                        </div>
                        <div id="photoOcrLookupCard" class="hidden p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-brand-200 dark:border-brand-700 space-y-1.5">
                            <div class="flex items-center justify-between">
                                <div>
                                    <span id="photoOcrLookupWord" class="text-sm font-black text-slate-900 dark:text-white"></span>
                                    <span id="photoOcrLookupMeta" class="ml-2 text-[11px] text-slate-500"></span>
                                </div>
                                <div class="flex items-center gap-1.5">
                                    <button type="button" id="photoOcrLookupSpeakBtn" class="px-2 py-1 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs font-bold cursor-pointer">🔊 發音</button>
                                    <button type="button" id="photoOcrLookupAddBtn" class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold cursor-pointer">＋ 入庫</button>
                                </div>
                            </div>
                            <div id="photoOcrLookupMeaning" class="text-xs font-semibold text-slate-700 dark:text-slate-200"></div>
                        </div>
                        <div id="photoOcrArticleTranslateBar"></div>
                        <div class="p-3 rounded-2xl bg-emerald-50/70 dark:bg-slate-800/80 border border-emerald-200 dark:border-emerald-800 space-y-2">
                            <div class="flex items-center justify-between text-xs font-bold">
                                <span>已選取單字 (<span id="photoOcrSelectedCountBadge">0</span>)</span>
                                <div class="flex gap-1.5">
                                    <button type="button" onclick="PhotoOcrImporter.selectAllRecognizedWords()" class="px-2 py-0.5 rounded bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[11px] cursor-pointer">全選</button>
                                    <button type="button" onclick="PhotoOcrImporter.clearSelectedWords()" class="px-2 py-0.5 rounded bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[11px] cursor-pointer">清空</button>
                                </div>
                            </div>
                            <div id="photoOcrSelectedChips" class="flex flex-wrap gap-1.5"></div>
                            <div class="flex flex-wrap items-center gap-2">
                                <select id="photoOcrTargetDeck" onchange="PhotoOcrImporter.handleDeckSelectChange(this.value)" class="flex-1 min-w-[130px] px-2.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold"></select>
                                <input type="text" id="photoOcrNewDeckInput" placeholder="輸入新字庫名稱" class="hidden flex-1 min-w-[120px] px-2.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-emerald-400 text-xs font-bold">
                                <button type="button" id="photoOcrConfirmImportBtn" onclick="PhotoOcrImporter.confirmImportAndAiFill()" class="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-extrabold cursor-pointer">確認加入並 AI 生成</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            bindModalEvents();
        }
        ensureArticleTranslationBarMounted(modal);
        return modal;
    }

    function ensureArticleTranslationBarMounted(scopeEl) {
        const root = scopeEl || (typeof document !== 'undefined' ? document.getElementById('photoOcrModal') : null);
        if (!root) return null;
        let bar = root.querySelector('#photoOcrArticleTranslateBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'photoOcrArticleTranslateBar';
            const anchor = root.querySelector('#photoOcrLookupCard') || root.querySelector('#photoOcrImageWrapper')?.parentElement || root.firstElementChild;
            if (anchor && anchor.parentElement) {
                anchor.parentElement.insertBefore(bar, anchor.nextSibling);
            } else {
                root.appendChild(bar);
            }
        }
        return bar;
    }

    function getEffectiveRawArticleText() {
        if (state.fullRawText && state.fullRawText.trim()) return state.fullRawText.trim();
        if (Array.isArray(state.tokens) && state.tokens.length > 0) {
            return state.tokens.map(t => t.cleanWord).filter(Boolean).join(' ');
        }
        return '';
    }

    function renderArticleTranslationSection() {
        const bar = ensureArticleTranslationBarMounted();
        if (!bar) return;
        const hasSource = Boolean(state.imageSrc || getEffectiveRawArticleText());
        if (!hasSource) {
            bar.innerHTML = '';
            return;
        }

        const rawText = getEffectiveRawArticleText();
        const trans = String(state.articleTranslation || '').trim();
        const busy = Boolean(state.isTranslatingArticle);

        bar.className = 'p-3 rounded-2xl bg-amber-50/70 dark:bg-slate-800/80 border border-amber-200 dark:border-amber-700/70 space-y-2';
        bar.innerHTML = `
            <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="photoOcrTranslateArticleBtn" ${busy ? 'disabled' : ''} class="px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-xs font-extrabold inline-flex items-center gap-1.5 shadow-xs cursor-pointer">
                    <span>✨</span><span>${busy ? '整篇翻譯中...' : '整篇翻譯成中文'}</span>
                </button>
                ${trans ? `
                    <button type="button" id="photoOcrCopyArticleBtn" class="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold cursor-pointer">複製整篇譯文</button>
                    <button type="button" id="photoOcrToggleViewArticleBtn" class="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold cursor-pointer">${state.articleViewMode === 'both' ? '僅看譯文' : '原文對照'}</button>
                ` : ''}
            </div>
            ${trans ? `
                <div id="photoOcrArticleResultCard" class="p-3 rounded-xl bg-white dark:bg-slate-900 border border-amber-200 dark:border-slate-700 max-h-56 overflow-y-auto space-y-2 select-text">
                    ${state.articleViewMode === 'both' && rawText ? `
                        <div class="text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap leading-relaxed pb-2 border-b border-slate-100 dark:border-slate-800">${escapeOcrHtml(rawText)}</div>
                    ` : ''}
                    <div class="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">${escapeOcrHtml(trans)}</div>
                </div>
            ` : '<div class="text-[11px] text-amber-800/80 dark:text-amber-300/80">點擊上方按鈕即可保留段落格式將整篇文章翻譯成流暢繁體中文；仍可點擊圖片單字入庫。</div>'}
        `;

        const transBtn = document.getElementById('photoOcrTranslateArticleBtn');
        if (transBtn) transBtn.onclick = () => translateFullArticleToChinese();
        const copyBtn = document.getElementById('photoOcrCopyArticleBtn');
        if (copyBtn) copyBtn.onclick = () => copyArticleTranslation();
        const toggleBtn = document.getElementById('photoOcrToggleViewArticleBtn');
        if (toggleBtn) {
            toggleBtn.onclick = () => {
                state.articleViewMode = state.articleViewMode === 'both' ? 'trans' : 'both';
                renderArticleTranslationSection();
            };
        }
    }

    async function copyArticleTranslation() {
        const text = String(state.articleTranslation || '').trim();
        if (!text) {
            if (typeof global.showToast === 'function') global.showToast('尚無整篇譯文可複製', 'info');
            return false;
        }
        let copied = false;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                copied = true;
            }
        } catch (e) {}
        if (!copied) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', 'true');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                copied = Boolean(document.execCommand('copy'));
                document.body.removeChild(ta);
            } catch (e) {}
        }
        if (typeof global.showToast === 'function') {
            global.showToast(copied ? '已複製整篇中文譯文' : '複製失敗，請手動選取複製', copied ? 'success' : 'warning');
        }
        return copied;
    }

    async function translateFullArticleToChinese() {
        if (state.isTranslatingArticle) return '';
        const sourceText = getEffectiveRawArticleText();
        if (!sourceText) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先拍照／選圖並等待文字辨識完成', 'warning');
            }
            return '';
        }

        let aiConsentOk = true;
        if (typeof global.ensureAiPrivacyConsent === 'function') {
            aiConsentOk = await global.ensureAiPrivacyConsent({ feature: 'def_fill' });
        }
        if (!aiConsentOk) {
            return '';
        }

        state.isTranslatingArticle = true;
        renderArticleTranslationSection();

        try {
            let translated = '';
            if (typeof global.callGeminiApi === 'function') {
                try {
                    const prompt = `請將以下整篇文章／圖片 OCR 原文完整翻譯成自然流暢的「繁體中文」，嚴格保留原本的段落換行結構，僅直接輸出中文譯文（不要加額外說明或 Markdown 框）：\n\n${sourceText}`;
                    translated = await global.callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
                } catch (e) {
                    console.warn('[PhotoOcr] Gemini full-article translation failed, trying fallback:', e);
                }
            }

            if (!translated) {
                try {
                    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(sourceText.slice(0, 3500))}`;
                    const resp = await fetch(url);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (Array.isArray(data) && Array.isArray(data[0])) {
                            translated = data[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
                        }
                    }
                } catch (e) {}
            }

            translated = String(translated || '').trim();
            if (!translated) {
                if (typeof global.showToast === 'function') {
                    global.showToast('整篇翻譯失敗，請檢查網路連線或 API Key 設定', 'error');
                }
                return '';
            }

            state.articleTranslation = translated;
            if (typeof global.showToast === 'function') {
                global.showToast('整篇文章翻譯成中文完成！', 'success');
            }
            return translated;
        } finally {
            state.isTranslatingArticle = false;
            renderArticleTranslationSection();
        }
    }

    async function runOcrOnLoadedImage() {
        if (!state.imageSrc) return;
        const myRunToken = ++state.lastRecognizeToken;
        state.isRecognizing = true;
        state.tokens = [];
        state.fullRawText = '';
        state.articleTranslation = '';
        renderHotspotsOverlay();
        renderArticleTranslationSection();
        hideLookupCard();

        updateProgressUI(true, 5, '正在準備 OCR 辨識引擎...');

        let worker = null;
        try {
            const Tesseract = await loadTesseractScript();
            if (myRunToken !== state.lastRecognizeToken) return;

            updateProgressUI(true, 18, `正在載入 ${state.ocrLang === 'eng' ? '英文' : '中英'} 辨識模型...`);

            worker = await Tesseract.createWorker(state.ocrLang, 1, {
                logger: (m) => {
                    if (myRunToken !== state.lastRecognizeToken) return;
                    if (m && typeof m.progress === 'number') {
                        const base = m.status === 'recognizing text' ? 35 : 15;
                        const span = m.status === 'recognizing text' ? 63 : 20;
                        const pct = base + Math.round(m.progress * span);
                        const statusLabel = m.status === 'recognizing text'
                            ? '正在辨識圖片中的單字與座標...'
                            : '正在下載／初始化離線 OCR 模型...';
                        updateProgressUI(true, pct, statusLabel);
                    }
                }
            });

            if (myRunToken !== state.lastRecognizeToken) return;

            const result = await worker.recognize(state.imageSrc);
            if (myRunToken !== state.lastRecognizeToken) return;

            const data = result && result.data ? result.data : {};
            state.fullRawText = String(data.text || '').trim();
            state.tokens = extractOcrTokensFromData(data);

            updateProgressUI(true, 100, `辨識完成，共找到 ${state.tokens.length} 個單字熱區`);
            setTimeout(() => {
                if (myRunToken === state.lastRecognizeToken) updateProgressUI(false);
            }, 900);

            renderHotspotsOverlay();
            renderArticleTranslationSection();

            if (state.tokens.length === 0 && typeof global.showToast === 'function') {
                global.showToast('未偵測到清晰的英文單字，請換一張光線充足且字體清晰的照片', 'warning');
            }
        } catch (err) {
            console.error('[PhotoOcr] OCR recognition failed:', err);
            updateProgressUI(false);
            if (typeof global.showToast === 'function') {
                global.showToast(`OCR 辨識失敗：${err.message || '請確認網路連線或圖片格式'}`, 'error');
            }
        } finally {
            state.isRecognizing = false;
            if (worker && typeof worker.terminate === 'function') {
                try { await worker.terminate(); } catch (e) {}
            }
        }
    }

    async function normalizeAndCompressImageSource(fileOrDataUrl, maxDim = 1920, quality = 0.92) {
        let objectUrl = '';
        let srcUrl = '';

        if (fileOrDataUrl instanceof Blob) {
            objectUrl = URL.createObjectURL(fileOrDataUrl);
            srcUrl = objectUrl;
        } else {
            srcUrl = String(fileOrDataUrl || '');
        }

        try {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('圖片載入失敗'));
                img.src = srcUrl;
            });

            // 依賴現代瀏覽器與 WebView 原生 EXIF 方向校正，禁止手動額外疊加旋轉矩陣
            const srcW = img.naturalWidth || img.width || 1;
            const srcH = img.naturalHeight || img.height || 1;
            const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
            const outW = Math.max(1, Math.round(srcW * scale));
            const outH = Math.max(1, Math.round(srcH * scale));

            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, outW, outH);
            return canvas.toDataURL('image/jpeg', quality);
        } finally {
            if (objectUrl) {
                try { URL.revokeObjectURL(objectUrl); } catch (e) {}
            }
        }
    }

    function syncStageBoxDimensions() {
        const stage = document.getElementById('photoOcrImageWrapper');
        const img = document.getElementById('photoOcrImage');
        const overlay = document.getElementById('photoOcrOverlay');
        if (!stage || !img || !overlay) return;
        stage.style.display = 'inline-block';
        stage.style.position = 'relative';
        stage.style.width = 'auto';
        stage.style.height = 'auto';
        stage.style.maxWidth = '100%';
        stage.style.lineHeight = '0';
        img.style.display = 'block';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '62vh';
        img.style.width = 'auto';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
        overlay.style.position = 'absolute';
        overlay.style.inset = '0px';
    }

    function displayLoadedImage(dataUrl) {
        ensurePhotoOcrModalDom();
        const placeholder = document.getElementById('photoOcrEmptyPlaceholder');
        const stage = document.getElementById('photoOcrImageWrapper');
        const img = document.getElementById('photoOcrImage');

        if (!img || !stage) return;

        state.imageSrc = dataUrl;
        state.tokens = [];
        state.fullRawText = '';
        state.articleTranslation = '';
        state.activeTokenId = null;
        hideLookupCard();
        renderHotspotsOverlay();
        renderArticleTranslationSection();

        img.onload = () => {
            state.naturalWidth = img.naturalWidth || img.width || 1;
            state.naturalHeight = img.naturalHeight || img.height || 1;
            if (placeholder) placeholder.classList.add('hidden');
            stage.classList.remove('hidden');
            syncStageBoxDimensions();
            runOcrOnLoadedImage();
        };
        img.onerror = () => {
            if (typeof global.showToast === 'function') {
                global.showToast('圖片載入失敗，請改選其他照片檔案', 'error');
            }
        };
        img.src = dataUrl;
    }

    async function handleFileSelected(file) {
        if (!file) return;
        try {
            const normalizedUrl = await normalizeAndCompressImageSource(file, 1920, 0.92);
            if (normalizedUrl) displayLoadedImage(normalizedUrl);
        } catch (err) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const dataUrl = e.target && e.target.result ? String(e.target.result) : '';
                if (dataUrl) displayLoadedImage(dataUrl);
            };
            reader.onerror = () => {
                if (typeof global.showToast === 'function') {
                    global.showToast('讀取圖片檔案失敗', 'error');
                }
            };
            reader.readAsDataURL(file);
        }
    }

    async function triggerCapture(preferCamera = true) {
        // 1. 優先偵測 Capacitor 原生 Camera 外掛
        const capCamera = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Camera;
        if (capCamera && typeof capCamera.getPhoto === 'function') {
            try {
                const photo = await capCamera.getPhoto({
                    quality: 92,
                    allowEditing: false,
                    resultType: 'dataUrl',
                    source: preferCamera ? 'CAMERA' : 'PHOTOS'
                });
                const src = photo && (photo.dataUrl || (photo.base64String ? `data:image/${photo.format || 'jpeg'};base64,${photo.base64String}` : '') || photo.webPath);
                if (src) {
                    displayLoadedImage(src);
                    return true;
                }
            } catch (err) {
                const msg = String(err && err.message || '');
                if (/cancel/i.test(msg)) return false;
                console.warn('[PhotoOcr] Capacitor Camera fallback to web file input:', err);
            }
        }

        // 2. 純 Web / 未安裝原生外掛自動降級使用 <input type="file">
        const inputId = preferCamera ? 'photoOcrCameraInput' : 'photoOcrGalleryInput';
        const input = document.getElementById(inputId);
        if (input) {
            input.value = '';
            input.click();
            return true;
        }
        return false;
    }

    async function confirmImportAndAiFill() {
        if (state.selectedItems.length === 0) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先選取至少 1 個要加入字庫的單字！', 'warning');
            }
            return false;
        }

        const select = document.getElementById('photoOcrTargetDeck');
        const newInput = document.getElementById('photoOcrNewDeckInput');
        const defaultCat = (typeof t === 'function' && t('defaultCategoryName') && t('defaultCategoryName') !== 'defaultCategoryName')
            ? t('defaultCategoryName')
            : '預設字庫';

        let targetCategory = defaultCat;
        if (select) {
            if (select.value === '__NEW__') {
                const customName = newInput ? newInput.value.trim() : '';
                if (!customName) {
                    if (typeof global.showToast === 'function') {
                        global.showToast('請先輸入新字庫名稱！', 'warning');
                    }
                    if (newInput) newInput.focus();
                    return false;
                }
                targetCategory = customName;
            } else if (select.value) {
                targetCategory = select.value.trim();
            }
        }

        localStorage.setItem('lzhcard_last_ocr_deck', targetCategory);

        if (typeof global.autoDeduplicateWordList === 'function') {
            global.autoDeduplicateWordList({ silent: true });
        }

        const list = (typeof global.wordList !== 'undefined' && Array.isArray(global.wordList))
            ? global.wordList
            : [];

        const isValidFn = typeof global.isValidFieldValue === 'function'
            ? global.isValidFieldValue
            : (v) => Boolean(v && String(v).trim() && !String(v).includes('解析中'));

        const addedCards = [];
        let skippedDuplicateCount = 0;

        for (const item of state.selectedItems) {
            const cleanedObj = (typeof global.sanitizeWordAndPos === 'function')
                ? global.sanitizeWordAndPos(item.word, '', '')
                : { word: item.word, pos: '', meaning: '' };
            const cleanWord = String(cleanedObj.word || item.word).trim().replace(/\s+/g, ' ');
            const normWord = normalizeOcrWordKey(cleanWord);
            if (!cleanWord || !normWord) continue;

            const existsInTarget = list.some(w =>
                (w.category || defaultCat).trim().toLowerCase() === targetCategory.toLowerCase() &&
                normalizeOcrWordKey(w.word) === normWord
            );

            if (existsInTarget) {
                skippedDuplicateCount++;
                continue;
            }

            // 檢查其他字庫是否已有同名單字，完整繼承 FSRS 進度與已有欄位
            const matchingOthers = list.filter(w => normalizeOcrWordKey(w.word) === normWord);
            let bestMatch = matchingOthers[0] || null;
            if (matchingOthers.length > 1 && typeof global.compareCardProgress === 'function') {
                matchingOthers.forEach(c => {
                    if (global.compareCardProgress(c, bestMatch) > 0) bestMatch = c;
                });
            }

            const detCardId = (typeof global.generateDeterministicCardId === 'function')
                ? global.generateDeterministicCardId(targetCategory, cleanWord)
                : ('w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
            const detDeckId = (typeof global.generateDeterministicDeckId === 'function')
                ? global.generateDeterministicDeckId(targetCategory)
                : undefined;

            const newCard = {
                id: detCardId,
                deckId: detDeckId,
                category: targetCategory,
                word: cleanWord,
                pos: bestMatch && isValidFn(bestMatch.pos, 'pos') ? bestMatch.pos : (cleanedObj.pos || ''),
                phonetic: bestMatch && isValidFn(bestMatch.phonetic, 'phonetic') ? bestMatch.phonetic : '',
                meaning: bestMatch && isValidFn(bestMatch.meaning, 'meaning') ? bestMatch.meaning : 'AI 自動解析中...',
                sentence: bestMatch && isValidFn(bestMatch.sentence, 'sentence') ? bestMatch.sentence : '',
                translation: bestMatch && isValidFn(bestMatch.translation, 'translation') ? bestMatch.translation : '',
                level: bestMatch ? (bestMatch.level || 1) : 1,
                knowStreak: bestMatch ? (bestMatch.knowStreak || 0) : 0,
                state: bestMatch ? (bestMatch.state || 'new') : 'new',
                stability: bestMatch && typeof bestMatch.stability === 'number' ? bestMatch.stability : 0,
                difficulty: bestMatch && typeof bestMatch.difficulty === 'number' ? bestMatch.difficulty : 5.5,
                reps: bestMatch ? (bestMatch.reps || 0) : 0,
                lapses: bestMatch ? (bestMatch.lapses || 0) : 0,
                lastReview: bestMatch ? (bestMatch.lastReview || 0) : 0,
                nextReview: bestMatch ? (bestMatch.nextReview || 0) : 0,
                freeLevel: bestMatch ? (bestMatch.freeLevel || 1) : 1,
                freeStreak: bestMatch ? (bestMatch.freeStreak || 0) : 0,
                updatedAt: Date.now()
            };

            if (typeof global.migrateCardFSRS === 'function') {
                global.migrateCardFSRS(newCard);
            }

            list.unshift(newCard);
            addedCards.push(newCard);
        }

        if (addedCards.length === 0) {
            if (typeof global.showToast === 'function') {
                global.showToast(`選取的 ${skippedDuplicateCount} 個單字皆已存在於「${targetCategory}」，已自動略過重複項`, 'info');
            }
            return false;
        }

        if (typeof global.saveStorage === 'function') global.saveStorage();
        if (typeof global.updateCategorySelects === 'function') global.updateCategorySelects();
        if (typeof global.updateUI === 'function') global.updateUI();

        closeModalAndResetSelection();

        if (typeof global.showToast === 'function') {
            const skipNote = skippedDuplicateCount > 0 ? `（略過 ${skippedDuplicateCount} 個重複字）` : '';
            global.showToast(`已加入 ${addedCards.length} 個單字${skipNote}，AI 正在背景生成釋義與例句...`, 'success');
        }

        const cardsNeedingAi = addedCards.filter(c => !isValidFn(c.meaning, 'meaning') || !isValidFn(c.sentence, 'sentence'));
        if (cardsNeedingAi.length > 0 && typeof global.runBatchAiAutoFill === 'function') {
            try {
                await global.runBatchAiAutoFill(cardsNeedingAi, () => {
                    const now = Date.now();
                    cardsNeedingAi.forEach(c => { c.updatedAt = now; });
                    if (typeof global.saveStorage === 'function') global.saveStorage();
                    if (typeof global.updateUI === 'function') global.updateUI();
                });

                const doneTs = Date.now();
                cardsNeedingAi.forEach(c => { c.updatedAt = doneTs; });
                if (typeof global.saveStorage === 'function') global.saveStorage();
                if (typeof global.updateUI === 'function') global.updateUI();

                if (typeof global.showToast === 'function') {
                    global.showToast(`✅ 拍照入庫 ${cardsNeedingAi.length} 個單字 AI 釋義與例句生成完成！`, 'success');
                }
            } catch (err) {
                console.warn('[PhotoOcr] 背景 AI 補齊失敗或中斷:', err);
            }
        }

        return addedCards.length;
    }

    function closeModalAndResetSelection() {
        state.selectedItems = [];
        renderSelectedChipsBar();
        if (typeof global.closeModal === 'function') {
            global.closeModal('photoOcrModal');
        } else {
            const modal = document.getElementById('photoOcrModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }
    }

    function open(options = {}) {
        ensurePhotoOcrModalDom();
        populateDeckSelector();
        updateModeToolbarUI();
        renderSelectedChipsBar();
        renderArticleTranslationSection();

        if (typeof global.openModal === 'function') {
            global.openModal('photoOcrModal');
        } else {
            const modal = document.getElementById('photoOcrModal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        if (options && options.imageDataUrl) {
            displayLoadedImage(options.imageDataUrl);
        }
    }

    function close() {
        if (typeof global.closeModal === 'function') {
            global.closeModal('photoOcrModal');
        } else {
            const modal = document.getElementById('photoOcrModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }
    }

    function bindModalEvents() {
        const overlay = document.getElementById('photoOcrOverlay');
        if (overlay && overlay.dataset.bound !== '1') {
            overlay.dataset.bound = '1';
            overlay.addEventListener('click', (e) => {
                const btn = e.target && typeof e.target.closest === 'function'
                    ? e.target.closest('button[data-ocr-token-id]')
                    : null;
                if (!btn) return;
                handleOverlayTokenClick(btn.dataset.ocrTokenId);
            });
        }

        const chips = document.getElementById('photoOcrSelectedChips');
        if (chips && chips.dataset.bound !== '1') {
            chips.dataset.bound = '1';
            chips.addEventListener('click', (e) => {
                const removeBtn = e.target && typeof e.target.closest === 'function'
                    ? e.target.closest('button[data-chip-remove]')
                    : null;
                if (removeBtn) {
                    removeSelectedWordByNormOrId(removeBtn.dataset.chipRemove);
                    return;
                }
                const editBtn = e.target && typeof e.target.closest === 'function'
                    ? e.target.closest('button[data-chip-edit]')
                    : null;
                if (editBtn) {
                    openChipInlineEdit(editBtn.dataset.chipEdit, editBtn.parentElement);
                }
            });
        }

        const camInput = document.getElementById('photoOcrCameraInput');
        if (camInput && camInput.dataset.bound !== '1') {
            camInput.dataset.bound = '1';
            camInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) handleFileSelected(file);
            });
        }

        const galInput = document.getElementById('photoOcrGalleryInput');
        if (galInput && galInput.dataset.bound !== '1') {
            galInput.dataset.bound = '1';
            galInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) handleFileSelected(file);
            });
        }
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', bindModalEvents);
    }

    global.PhotoOcrImporter = {
        open,
        close,
        setMode,
        setOcrLang,
        triggerCapture,
        handleFileSelected,
        displayLoadedImage,
        handleDeckSelectChange,
        selectAllRecognizedWords,
        clearSelectedWords,
        addSelectedWord,
        removeSelectedWord: removeSelectedWordByNormOrId,
        confirmImportAndAiFill,
        hideLookupCard,
        computeBoxPercentages,
        isValidOcrWord,
        cleanOcrWordToken,
        translateFullArticleToChinese,
        copyArticleTranslation,
        getState: () => state
    };
})(typeof window !== 'undefined' ? window : globalThis);
