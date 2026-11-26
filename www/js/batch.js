/**
 * LZHCard - 批量匯入、UI 控制、字庫管理與 JSON 備份模組 (Batch UI Controller - 完整進度保留與 i18n 預備版)
 */

window.parsedBatchList = window.parsedBatchList || [];
let isAutoDeduplicating = false;

function safeT(key, params, fallbackStr) {
    let text = fallbackStr || key;
    if (typeof t === 'function') {
        try {
            const translated = t(key, params);
            if (translated && translated !== key) {
                text = translated;
            }
        } catch (e) {}
    }
    if (params && typeof text === 'string') {
        Object.keys(params).forEach(k => {
            text = text.replace(new RegExp(`\\{\\s*${k}\\s*\\}`, 'g'), params[k]);
        });
    }
    return text;
}

/**
 * 🧹 單字字串標準化（去除前後空白、壓縮連續空白並轉小寫，用於精準重複比對）
 */
function normalizeWordKey(rawWord) {
    if (!rawWord || typeof rawWord !== 'string') return '';
    return rawWord.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 🧹 判斷欄位是否為有效內容（排除空白、預設佔位文字與非母語殘留釋義）
 */
function isValidFieldValue(val, fieldType = '') {
    if (!val || typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (!trimmed) return false;
    const placeholders = [
        '無釋義',
        '（無母語釋義）',
        '(No definition)',
        '（意味未入力）',
        '未設定釋義',
        'AI 自動解析中...',
        'AI 解析中...',
        'N/A',
        '/---/',
        'EMPTY',
        '-'
    ];
    if (placeholders.includes(trimmed)) return false;

    if (fieldType && typeof isFieldIncomplete === 'function') {
        return !isFieldIncomplete(trimmed, fieldType);
    }
    return true;
}

/**
 * 🔀 合併兩筆重複單字資料（完整保留較高的 FSRS 學習進度、自由練習等級與最完整的欄位內容）
 */
function mergeDuplicateWordRecord(baseItem, otherItem, preferOtherFields = false) {
    let useOtherProgress = false;
    if (typeof compareCardProgress === 'function') {
        useOtherProgress = compareCardProgress(otherItem, baseItem) > 0;
    } else {
        const baseScore = (Number(baseItem.level) || 1) * 10 + (Number(baseItem.knowStreak) || 0) + (Number(baseItem.stability) || 0);
        const otherScore = (Number(otherItem.level) || 1) * 10 + (Number(otherItem.knowStreak) || 0) + (Number(otherItem.stability) || 0);
        useOtherProgress = otherScore > baseScore;
    }
    const progressSource = useOtherProgress ? otherItem : baseItem;

    const pickField = (field) => {
        const valA = baseItem[field];
        const valB = otherItem[field];
        const validA = isValidFieldValue(valA, field);
        const validB = isValidFieldValue(valB, field);

        if (preferOtherFields) {
            if (validB) return String(valB).trim();
            if (validA) return String(valA).trim();
        } else {
            if (validA) return String(valA).trim();
            if (validB) return String(valB).trim();
        }
        return String(valA || valB || '').trim();
    };

    const merged = {
        ...baseItem,
        word: String(baseItem.word || otherItem.word || '').trim().replace(/\s+/g, ' '),
        pos: pickField('pos'),
        phonetic: pickField('phonetic'),
        meaning: pickField('meaning'),
        sentence: pickField('sentence'),
        translation: pickField('translation'),
        level: Number(progressSource.level) || 1,
        knowStreak: Number(progressSource.knowStreak) || 0,
        state: progressSource.state || 'new',
        stability: typeof progressSource.stability === 'number' ? progressSource.stability : 0,
        difficulty: typeof progressSource.difficulty === 'number' ? progressSource.difficulty : 5.5,
        reps: Number(progressSource.reps) || 0,
        lapses: Number(progressSource.lapses) || 0,
        lastReview: Number(progressSource.lastReview) || 0,
        nextReview: Number(progressSource.nextReview) || 0,
        freeLevel: Math.max(Number(baseItem.freeLevel) || 1, Number(otherItem.freeLevel) || 1),
        freeStreak: (Number(otherItem.freeLevel) || 1) > (Number(baseItem.freeLevel) || 1)
            ? (Number(otherItem.freeStreak) || 0)
            : (Number(baseItem.freeStreak) || 0),
        updatedAt: Math.max(Number(baseItem.updatedAt) || 0, Number(otherItem.updatedAt) || 0, Date.now())
    };

    if (typeof migrateCardFSRS === 'function') {
        migrateCardFSRS(merged);
    }
    return merged;
}

/**
 * 🤖 自動掃描並刪除字庫中的重複單字（保留學習進度與最完整釋義）
 */
function autoDeduplicateWordList(options = {}) {
    const { silent = false } = options;
    if (isAutoDeduplicating || typeof wordList === 'undefined' || !Array.isArray(wordList) || wordList.length <= 1) {
        return 0;
    }

    isAutoDeduplicating = true;
    let removedCount = 0;

    try {
        const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
        const seenMap = new Map();
        const dedupedList = [];

        for (const item of wordList) {
            if (!item || !item.word) continue;

            const cleanWord = String(item.word).trim().replace(/\s+/g, ' ');
            if (!cleanWord) continue;

            const catName = String(item.category || defaultCatName).trim() || defaultCatName;
            const compositeKey = `${catName.toLowerCase()}::${cleanWord.toLowerCase()}`;

            if (seenMap.has(compositeKey)) {
                const existingIdx = seenMap.get(compositeKey);
                dedupedList[existingIdx] = mergeDuplicateWordRecord(dedupedList[existingIdx], {
                    ...item,
                    category: catName,
                    word: cleanWord
                }, false);
                removedCount++;
            } else {
                seenMap.set(compositeKey, dedupedList.length);
                dedupedList.push({
                    ...item,
                    category: catName,
                    word: cleanWord
                });
            }
        }

        if (removedCount > 0) {
            wordList.length = 0;
            wordList.push(...dedupedList);

            if (typeof selectedWordIds !== 'undefined' && selectedWordIds instanceof Set) {
                const validIds = new Set(wordList.map(w => w.id));
                for (const id of Array.from(selectedWordIds)) {
                    if (!validIds.has(id)) selectedWordIds.delete(id);
                }
            }

            if (typeof saveStorage === 'function') saveStorage();
            if (typeof updateCategorySelects === 'function') updateCategorySelects();
            if (typeof updateUI === 'function') updateUI();

            if (!silent && typeof showToast === 'function') {
                showToast(
                    safeT('toastAutoDeduplicated', { count: removedCount }, `🧹 已自動清理並合併 ${removedCount} 筆重複單字`),
                    'info'
                );
            }
        }
    } finally {
        isAutoDeduplicating = false;
    }

    return removedCount;
}

/**
 * 🌐 依據目前設定的目標語言動態切換範例提示、預設字庫按鈕與選擇字庫選單
 */
function updateBatchPlaceholders() {
    const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
    const batchRawInput = document.getElementById('batchRawInput');
    const quickAddInput = document.getElementById('quickAddInput');
    const presetTitleEl = document.getElementById('batchPresetTitleText');
    const presetBtnsEl = document.getElementById('batchPresetButtons');

    let batchPlaceholder = "";
    let quickAddPlaceholder = "";

    if (targetLang === 'ja') {
        batchPlaceholder =
            `【統一格式：目標單字,釋義,詞性,發音】（換行才是下一個字，片語可含空白；中間欄位省略需保留逗號，末端可省略；例句/翻譯可選）\n` +
            `食べる,吃,v.,たべる\n` +
            `1."毎日朝ごはんを食べます。"\n` +
            `2."我每天吃早餐。"\n` +
            `綺麗,,adj.,きれい\n` +
            `猫,貓咪`;

        quickAddPlaceholder = `例如: 食べる, 猫, 勉強する, 綺麗`;

        if (presetTitleEl) {
            presetTitleEl.setAttribute('data-i18n', 'batchPresetTitleJa');
            presetTitleEl.innerText = safeT('batchPresetTitleJa', null, '一鍵載入 JLPT 日檢單字庫 (N5 ～ N1 分級)');
        }
        if (presetBtnsEl) {
            presetBtnsEl.className = 'grid grid-cols-3 sm:grid-cols-5 gap-2 pt-1';
            presetBtnsEl.innerHTML = [5, 4, 3, 2, 1].map(nLv => `
                <button type="button" onclick="handleLoadPreset(${nLv}, event)" class="py-1.5 px-2 bg-white dark:bg-slate-800 hover:bg-brand-100 dark:hover:bg-slate-700 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-slate-600 text-xs font-bold rounded-lg transition shadow-2xs">N${nLv}</button>
            `).join('');
        }
    } else if (targetLang === 'zh-TW' || targetLang === 'zh') {
        batchPlaceholder =
            `【統一格式：目標單字,釋義,詞性,發音】（換行才是下一個字；中間欄位省略需保留逗號，末端可省略；例句/翻譯可選）\n` +
            `韌性,resilience,n.,ㄖㄣˋ ㄒㄧㄥˋ\n` +
            `1."這株植物在寒冬中展現了驚人的韌性。"\n` +
            `2."This plant showed remarkable resilience in winter."\n` +
            `學習,,v.,ㄒㄩㄝˊ ㄒㄧˊ\n` +
            `蘋果,apple`;

        quickAddPlaceholder = `例如: 韌性, 努力, 學習, 蘋果`;

        if (presetTitleEl) {
            presetTitleEl.setAttribute('data-i18n', 'batchPresetTitle');
            presetTitleEl.innerText = safeT('batchPresetTitle', null, '一鍵載入高中 7000 單字庫 (大考中心 / 108 課綱分級)');
        }
        if (presetBtnsEl) {
            presetBtnsEl.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1';
            presetBtnsEl.innerHTML = [1, 2, 3, 4, 5, 6].map(lv => `
                <button type="button" onclick="handleLoadPreset(${lv}, event)" class="py-1.5 px-2 bg-white dark:bg-slate-800 hover:bg-brand-100 dark:hover:bg-slate-700 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-slate-600 text-xs font-bold rounded-lg transition shadow-2xs">Level ${lv}</button>
            `).join('');
        }
    } else {
        batchPlaceholder =
            `【統一格式：目標單字,釋義,詞性,發音】（換行才是下一個字，片語可含空白；中間欄位省略需保留逗號，末端可省略）\n` +
            `happy,開心,adj.,[ˈhæpɪ]\n` +
            `1."I'm so happy."\n` +
            `2."我很開心。"\n` +
            `resilient,,adj.,[rɪˈzɪljənt]\n` +
            `take off,起飛；脫下\n` +
            `candidate,,`;

        quickAddPlaceholder = `例如: resilient, fragile, candidate`;

        if (presetTitleEl) {
            presetTitleEl.setAttribute('data-i18n', 'batchPresetTitle');
            presetTitleEl.innerText = safeT('batchPresetTitle', null, '一鍵載入高中 7000 單字庫 (大考中心 / 108 課綱分級)');
        }
        if (presetBtnsEl) {
            presetBtnsEl.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1';
            presetBtnsEl.innerHTML = [1, 2, 3, 4, 5, 6].map(lv => `
                <button type="button" onclick="handleLoadPreset(${lv}, event)" class="py-1.5 px-2 bg-white dark:bg-slate-800 hover:bg-brand-100 dark:hover:bg-slate-700 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-slate-600 text-xs font-bold rounded-lg transition shadow-2xs">Level ${lv}</button>
            `).join('');
        }
    }

    if (batchRawInput) batchRawInput.placeholder = batchPlaceholder;
    if (quickAddInput) quickAddInput.placeholder = quickAddPlaceholder;

    const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
    const activeCats = window.selectedCategories || ['ALL'];
    const currentCat = (activeCats.length === 1 && activeCats[0] !== 'ALL')
        ? activeCats[0]
        : defaultCatName;

    const existingCats = typeof getAllCategories === 'function' ? getAllCategories() : [defaultCatName];
    const savedLastCat = localStorage.getItem('lzhcard_last_quick_add_cat');
    const initialQuickCat = (savedLastCat && existingCats.includes(savedLastCat)) ? savedLastCat : currentCat;

    if (typeof setCategorySelectorValue === 'function') {
        setCategorySelectorValue('quickAdd', initialQuickCat);
        setCategorySelectorValue('batch', currentCat);
    }
}

function findChineseMeaningFromObject(item) {
    if (!item || typeof item !== 'object') return '';
    const preferredKeys = ['meaning', 'definition', 'zh', 'ch', 'chinese', 'ch_meaning', 'trans', 'translation', 'm', 'd', 'explanation', 'note'];
    for (const key of preferredKeys) {
        if (item[key] && typeof item[key] === 'string' && /[\u4e00-\u9fa5]/.test(item[key])) {
            return item[key];
        }
    }
    for (const key in item) {
        if (typeof item[key] === 'string' && /[\u4e00-\u9fa5]/.test(item[key])) {
            return item[key];
        }
    }
    return '';
}

/**
 * 📄 RFC-4180 CSV 解析器（用於解析開源 JLPT CSV 單字表）
 */
function parseSimpleCsvRows(csvText) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                field += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                field += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(field.trim());
                field = '';
            } else if (ch === '\r' && next === '\n') {
                row.push(field.trim());
                rows.push(row);
                row = [];
                field = '';
                i++;
            } else if (ch === '\n' || ch === '\r') {
                row.push(field.trim());
                rows.push(row);
                row = [];
                field = '';
            } else {
                field += ch;
            }
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field.trim());
        rows.push(row);
    }
    return rows.filter(r => r.some(cell => cell !== ''));
}

/**
 * 🇯🇵 載入 JLPT 日檢單字庫 (N5 ～ N1)
 * 註：開源 JLPT 字庫僅含英文釋義，當使用者母語非英文時，自動留空釋義並標示為「待補齊」，方便一鍵用 AI 生成母語釋義。
 */
async function handleLoadJlptPreset(nLevel, ev) {
    const levelTag = `N${nLevel}`;
    const confirmMsg = safeT('confirmLoadJlptPreset', { level: levelTag }, `確定要載入【JLPT ${levelTag}】日檢單字庫嗎？`);
    const confirmed = await (typeof window.lzhConfirm === 'function' ? window.lzhConfirm(confirmMsg) : Promise.resolve(false));
    if (!confirmed) return;

    const JLPT_SOURCES = [
        { type: 'json', url: `https://jlpt-vocab-api.vercel.app/api/words/all?level=${nLevel}` },
        { type: 'csv', url: `https://cdn.jsdelivr.net/gh/jamsinclair/open-anki-jlpt-decks@main/src/n${nLevel}.csv` },
        { type: 'csv', url: `https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n${nLevel}.csv` },
        { type: 'csv', url: `https://cdn.jsdelivr.net/gh/jamsinclair/open-anki-jlpt-decks@master/src/n${nLevel}.csv` }
    ];

    const btn = ev ? (ev.currentTarget || ev.target) : null;
    const origText = btn ? btn.innerText : '';
    if (btn) {
        btn.disabled = true;
        btn.innerText = safeT('btnDownloading', null, '下載中...');
    }

    let rawItems = null;

    try {
        for (const src of JLPT_SOURCES) {
            try {
                const res = await fetch(src.url);
                if (!res.ok) continue;

                if (src.type === 'json') {
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (Array.isArray(data?.words) ? data.words : null);
                    if (Array.isArray(list) && list.length > 0) {
                        rawItems = list;
                        break;
                    }
                } else {
                    const text = await res.text();
                    const rows = parseSimpleCsvRows(text);
                    if (rows.length > 1) {
                        const headers = rows[0].map(h => h.toLowerCase());
                        const idxExpr = headers.indexOf('expression');
                        const idxRead = headers.indexOf('reading');
                        const idxMean = headers.indexOf('meaning');

                        rawItems = rows.slice(1).map(cols => ({
                            word: cols[idxExpr >= 0 ? idxExpr : 0] || '',
                            phonetic: cols[idxRead >= 0 ? idxRead : 1] || '',
                            meaning: cols[idxMean >= 0 ? idxMean : 2] || ''
                        })).filter(it => it.word || it.phonetic);

                        if (rawItems.length > 0) break;
                    }
                }
            } catch (e) {
                console.warn(`[JLPT CDN] 連線至 ${src.url} 失敗，嘗試備援...`);
            }
        }

        if (!rawItems || rawItems.length === 0) {
            if (typeof showToast === 'function') showToast(safeT('toastCdnFailed', null, '無法連接至字庫伺服器'), 'error');
            return;
        }

        const catName = safeT('jlptDeckName', { level: levelTag }, `JLPT ${levelTag} 單字庫`);
        if (typeof setCategorySelectorValue === 'function') {
            setCategorySelectorValue('batch', catName);
        } else {
            const targetCategoryInput = document.getElementById('batchTargetCategory');
            if (targetCategoryInput) targetCategoryInput.value = catName;
        }

        const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
        const seenSet = new Set();
        window.parsedBatchList = [];

        rawItems.forEach(item => {
            const rawW = String(item.word || item.expression || item.kanji || item.term || item.furigana || item.reading || '').trim().replace(/\s+/g, ' ');
            const rawPhonetic = String(item.furigana || item.reading || item.kana || item.phonetic || '').trim();
            const rawPos = String(item.pos || item.partOfSpeech || item.type || '').trim();

            let rawM = '';
            if (nativeLang === 'en') {
                rawM = String(item.meaning || item.definition || item.translation || item.en || '').trim();
            } else if (nativeLang === 'zh-TW' || nativeLang === 'zh') {
                rawM = findChineseMeaningFromObject(item);
            }

            if (!rawW) return;
            const dedupKey = `${normalizeWordKey(rawW)}::${normalizeWordKey(rawPhonetic)}`;
            if (seenSet.has(dedupKey)) return;
            seenSet.add(dedupKey);

            window.parsedBatchList.push({
                word: rawW,
                pos: rawPos,
                phonetic: rawPhonetic,
                meaning: rawM,
                sentence: String(item.sentence || item.example || '').trim(),
                translation: String(item.translation || item.exampleZh || '').trim()
            });
        });

        if (window.parsedBatchList.length === 0) {
            if (typeof showToast === 'function') showToast(safeT('toastJlptLevelNotFound', { level: levelTag }, `找不到 JLPT ${levelTag} 的單字資料。`), 'warning');
            return;
        }

        renderBatchPreview();
        if (typeof showToast === 'function') {
            showToast(safeT('toastPresetSuccess', { name: catName, count: window.parsedBatchList.length }, `成功載入「${catName}」共 ${window.parsedBatchList.length} 個單字`), 'success');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
    }
}

async function handleLoadPreset(levelNum, ev) {
    const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
    if (targetLang === 'ja') {
        return handleLoadJlptPreset(levelNum, ev);
    }

    const confirmMsg = safeT('confirmLoadPreset', { level: levelNum }, `確定要載入高中 7000 單 L${levelNum} 嗎？`);
    const confirmed = await (typeof window.lzhConfirm === 'function' ? window.lzhConfirm(confirmMsg) : Promise.resolve(false));
    if (!confirmed) return;

    const CDN_SOURCES = [
        "https://cdn.jsdelivr.net/gh/EngTW/English-for-Programmers@main/lists/Taiwan-high-school-6K-108-edition/Data/Taiwan-high-school-english-reference-vocabulary-list-108-edition.json",
        "https://raw.githubusercontent.com/EngTW/English-for-Programmers/main/lists/Taiwan-high-school-6K-108-edition/Data/Taiwan-high-school-english-reference-vocabulary-list-108-edition.json",
        "https://cdn.jsdelivr.net/gh/zenkarsha/words7000@main/words.json",
        "https://raw.githubusercontent.com/zenkarsha/words7000/main/words.json"
    ];

    const btn = ev ? (ev.currentTarget || ev.target) : (typeof event !== 'undefined' && event ? (event.currentTarget || event.target) : null);
    const origText = btn ? btn.innerText : "";
    if (btn) {
        btn.disabled = true;
        btn.innerText = safeT('btnDownloading', null, '下載中...');
    }

    let allWords = null;

    try {
        for (const url of CDN_SOURCES) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0) {
                        allWords = data;
                        break;
                    }
                }
            } catch (e) {
                console.warn(`[CDN] 連線至 ${url} 失敗，嘗試備援...`);
            }
        }

        if (!allWords && typeof window !== 'undefined' && window.VOCAB_7000_DATA) {
            allWords = Object.entries(window.VOCAB_7000_DATA).map(([w, lv]) => ({
                Word: w,
                Level: lv
            }));
        }

        if (!allWords) {
            if (typeof showToast === 'function') showToast(safeT('toastCdnFailed', null, '無法連接至字庫伺服器'), 'error');
            return;
        }

        const targetWords = allWords.filter((item, idx) => {
            const itemLv = Number(item.Level ?? item.level ?? item.lv ?? item.L ?? 0);
            if (itemLv > 0) return itemLv === levelNum;
            return Math.floor(idx / 1000) + 1 === levelNum;
        });

        if (!targetWords || targetWords.length === 0) {
            if (typeof showToast === 'function') showToast(safeT('toastLevelNotFound', { level: levelNum }, `未找到 Level ${levelNum} 的單字`), 'warning');
            return;
        }

        const catName = `高中 7000 單 L${levelNum}`;
        if (typeof setCategorySelectorValue === 'function') {
            setCategorySelectorValue('batch', catName);
        } else {
            const targetCategoryInput = document.getElementById('batchTargetCategory');
            if (targetCategoryInput) targetCategoryInput.value = catName;
        }

        const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
        const seenSet = new Set();
        window.parsedBatchList = [];

        targetWords.forEach(item => {
            const rawW = item.Word || item.word || item.term || item.english || item.w || '';
            const rawP = Array.isArray(item.PartsOfSpeech)
                ? item.PartsOfSpeech.join(', ')
                : (item.pos || item.partOfSpeech || item.type || item.p || '');
            
            let rawM = '';
            if (nativeLang === 'zh-TW' || nativeLang === 'zh') {
                rawM = findChineseMeaningFromObject(item);
                if (!rawM) {
                    rawM = item.meaning || item.definition || item.zh || item.ch || item.chinese || item.trans || item.m || '';
                }
            }

            const cleanObj = (typeof sanitizeWordAndPos === 'function') 
                ? sanitizeWordAndPos(rawW, rawP, rawM)
                : { word: rawW, pos: rawP, meaning: rawM };

            const normKey = normalizeWordKey(cleanObj.word);
            if (!normKey || seenSet.has(normKey)) return;
            seenSet.add(normKey);

            window.parsedBatchList.push({
                word: cleanObj.word.trim().replace(/\s+/g, ' '),
                pos: cleanObj.pos,
                phonetic: item.phonetic || item.pronunciation || '',
                meaning: cleanObj.meaning,
                sentence: item.sentence || item.example || '',
                translation: item.translation || item.exampleZh || ''
            });
        });

        renderBatchPreview();
        if (typeof showToast === 'function') showToast(safeT('toastPresetSuccess', { name: catName, count: window.parsedBatchList.length }, `成功載入「${catName}」共 ${window.parsedBatchList.length} 個單字`), 'success');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
    }
}

/**
 * 🌐 批量貼上文字解析器 (支援 日語假名/中文注音、自動去除行首序號與多種分隔符，並自動過濾重複字)
 */
/**
 * 🧩 嚴格切分「目標單字,釋義,詞性,發音」逗號欄位（支援雙引號包夾內含逗號的欄位，並保留中間空白逗號欄位）
 */
function splitStrictBatchColumns(line) {
    const cols = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' || ch === '“' || ch === '”') {
            if (inQuotes && line[i + 1] === ch) {
                current += ch;
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            cols.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    cols.push(current.trim());
    return cols;
}

/**
 * 📥 嚴格統一批量匯入解析器 (無舊版空白/冒號/Tab 回退；非統一格式請交給左上角 ☰ AI 解析)
 * 規則：
 * 1. 每行一筆：目標單字,釋義,詞性,發音（空白不會切分片語；中間欄位留空需保留逗號 e.g. happy,,adj.,[ˈhæpɪ]；末端可不打逗號）
 * 2. 例句與翻譯：1."例句"（或 1.”例句”）、2."翻譯"（或 2.”翻譯”）；若省略直接不輸入
 * 3. 支援因行寬過長而在引號 "..." / ”...” 內產生換行的自動續接合併
 */
function parseBatchText(text) {
    if (!text || typeof text !== 'string') return [];

    const rawLines = text.split(/\r?\n/);
    const results = [];
    const seenIndexMap = new Map();
    let lastEntry = null;
    let openQuoteField = null; // 'sentence' | 'translation' | null

    const closingQuoteRegex = /["“”」』]\s*$/;
    const openLine1Regex = /^[1１]\s*[\.．。]\s*["“”「『](.*)$/;
    const openLine2Regex = /^[2２]\s*[\.．。]\s*["“”「『](.*)$/;

    for (let i = 0; i < rawLines.length; i++) {
        const line = String(rawLines[i] || '').trim();
        if (!line) continue;

        // 1) 若上一行的 1."..." 或 2."..." 因太長換行而尚未閉合，優先視作續接句
        if (openQuoteField && lastEntry) {
            if (openLine2Regex.test(line) && openQuoteField === 'sentence') {
                // 使用者忘記閉合 1." 便直接換行輸入 2."，自動切換
                openQuoteField = null;
            } else {
                const endsQuote = closingQuoteRegex.test(line);
                const chunk = endsQuote ? line.replace(closingQuoteRegex, '').trim() : line;
                if (chunk) {
                    const prev = lastEntry[openQuoteField] || '';
                    const needSpace = prev && /[A-Za-z0-9.,!?;:]$/.test(prev) && /^[A-Za-z0-9]/.test(chunk);
                    lastEntry[openQuoteField] = prev ? (prev + (needSpace ? ' ' : '') + chunk) : chunk;
                }
                if (endsQuote) {
                    openQuoteField = null;
                }
                continue;
            }
        }

        // 2) 檢查是否為 1."..." 例句行
        const m1 = line.match(openLine1Regex);
        if (m1) {
            if (!lastEntry) continue;
            const body = m1[1] || '';
            const endsQuote = closingQuoteRegex.test(body);
            lastEntry.sentence = (endsQuote ? body.replace(closingQuoteRegex, '') : body).trim();
            openQuoteField = endsQuote ? null : 'sentence';
            continue;
        }

        // 3) 檢查是否為 2."..." 翻譯行
        const m2 = line.match(openLine2Regex);
        if (m2) {
            if (!lastEntry) continue;
            const body = m2[1] || '';
            const endsQuote = closingQuoteRegex.test(body);
            lastEntry.translation = (endsQuote ? body.replace(closingQuoteRegex, '') : body).trim();
            openQuoteField = endsQuote ? null : 'translation';
            continue;
        }

        // 4) 嚴格逗號分隔：目標單字,釋義,詞性,發音（空白保留以支援片語）
        const cols = splitStrictBatchColumns(line);
        const word = String(cols[0] || '').trim().replace(/\s+/g, ' ');
        const meaning = String(cols[1] || '').trim();
        const pos = String(cols[2] || '').trim();
        const phonetic = String(cols[3] || '').trim();

        const normKey = normalizeWordKey(word);
        if (!normKey) continue;

        if (seenIndexMap.has(normKey)) {
            const existing = results[seenIndexMap.get(normKey)];
            if (meaning && !existing.meaning) existing.meaning = meaning;
            if (pos && !existing.pos) existing.pos = pos;
            if (phonetic && !existing.phonetic) existing.phonetic = phonetic;
            lastEntry = existing;
            openQuoteField = null;
        } else {
            const entry = {
                word,
                pos,
                phonetic,
                meaning,
                sentence: '',
                translation: ''
            };
            seenIndexMap.set(normKey, results.length);
            results.push(entry);
            lastEntry = entry;
            openQuoteField = null;
        }
    }

    return results;
}

function handleParseBatchText() {
    const raw = document.getElementById('batchRawInput')?.value.trim();
    if (!raw) {
        if (typeof showToast === 'function') showToast(safeT('toastPasteFirst', null, '請先貼上單字內容'), 'warning');
        return;
    }

    window.parsedBatchList = parseBatchText(raw);
    if (window.parsedBatchList.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastParseError', null, '解析文字失敗，請確認格式'), 'error');
        return;
    }

    renderBatchPreview();
    if (typeof showToast === 'function') showToast(safeT('toastParseSuccess', { count: window.parsedBatchList.length }, `成功解析 ${window.parsedBatchList.length} 個單字`), 'success');
}

function renderBatchPreview() {
    const previewBox = document.getElementById('batchPreviewBox');
    const previewBody = document.getElementById('batchPreviewBody');
    const parsedCountElem = document.getElementById('batchParsedCount');
    if (parsedCountElem) parsedCountElem.innerText = window.parsedBatchList.length;

    if (window.parsedBatchList.length === 0) {
        if (previewBox) previewBox.classList.add('hidden');
        const confirmBtn = document.getElementById('confirmBatchImportBtn');
        if (confirmBtn) confirmBtn.disabled = true;
        return;
    }

    const textComplete = safeT('statusComplete', null, '完整');
    const textPending = safeT('statusPending', null, '待補充');
    const textRemove = safeT('btnRemove', null, '移除');
    const textTitleRemove = safeT('titleRemove', null, '移除此項');
    const esc = (str) => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    if (previewBody) {
        previewBody.innerHTML = window.parsedBatchList.map((item, idx) => {
            const meaningValid = typeof isFieldIncomplete === 'function'
                ? !isFieldIncomplete(item.meaning, 'meaning')
                : Boolean(item.meaning);
            const posValid = typeof isFieldIncomplete === 'function'
                ? !isFieldIncomplete(item.pos, 'pos')
                : Boolean(item.pos);
            const isComplete = item.word && meaningValid && posValid;
            const statusBadge = isComplete ? 
                `<span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">${textComplete}</span>` :
                `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">${textPending}</span>`;
            const phoneticSub = item.phonetic
                ? `<div class="text-[11px] font-normal text-slate-400">${esc(item.phonetic)}</div>`
                : '';

            return `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-700">
                    <td class="p-2 border-b dark:border-slate-700 font-bold">${esc(item.word)}${phoneticSub}</td>
                    <td class="p-2 border-b dark:border-slate-700">${esc(item.pos) || '-'}</td>
                    <td class="p-2 border-b dark:border-slate-700">${esc(item.meaning) || '-'}</td>
                    <td class="p-2 border-b dark:border-slate-700">${statusBadge}</td>
                    <td class="p-2 border-b dark:border-slate-700 text-right">
                        <button type="button" onclick="removeBatchItem(${idx})" class="text-rose-600 hover:text-rose-800 font-bold px-2 py-0.5 rounded hover:bg-rose-50 transition" title="${textTitleRemove}">
                            <i class="fa-solid fa-trash"></i> ${textRemove}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (previewBox) previewBox.classList.remove('hidden');
    const confirmBtn = document.getElementById('confirmBatchImportBtn');
    if (confirmBtn) confirmBtn.disabled = false;
}

function removeBatchItem(index) {
    window.parsedBatchList.splice(index, 1);
    renderBatchPreview();
}

async function handleRunBatchAiAutoFill() {
    if (!window.parsedBatchList || window.parsedBatchList.length === 0) return;

    const incompleteItems = window.parsedBatchList.filter(item => {
        return (typeof isFieldIncomplete === 'function') ? (
            isFieldIncomplete(item.meaning, 'meaning') ||
            isFieldIncomplete(item.pos, 'pos') ||
            isFieldIncomplete(item.sentence, 'sentence') ||
            isFieldIncomplete(item.translation, 'translation') ||
            isFieldIncomplete(item.phonetic, 'phonetic')
        ) : (!item.meaning || !item.pos || !item.sentence);
    });

    let forceOverwrite = false;
    if (incompleteItems.length === 0) {
        const confirmOverwrite = await (typeof window.lzhConfirm === 'function'
            ? window.lzhConfirm(`預覽列表中的 ${window.parsedBatchList.length} 筆單字皆已有資料，是否要依目前設定的目標語言與母語「強制覆蓋」重新解析？`)
            : Promise.resolve(false));
        if (!confirmOverwrite) return;
        forceOverwrite = true;
    }

    const btn = document.getElementById('batchAiFillBtn');
    const progressContainer = document.getElementById('batchProgressContainer');
    const progressBar = document.getElementById('batchProgressBar');
    const progressText = document.getElementById('batchProgressText');
    const progressPercent = document.getElementById('batchProgressPercent');

    if (btn) btn.disabled = true;
    if (progressContainer) progressContainer.classList.remove('hidden');

    try {
        if (typeof runBatchAiAutoFill === 'function') {
            await runBatchAiAutoFill(window.parsedBatchList, (current, total) => {
                const pct = Math.round((current / total) * 100);
                if (progressText) progressText.innerText = safeT('progressBatchAi', { current, total }, `AI 補齊中... (${current}/${total})`);
                if (progressBar) progressBar.style.width = `${pct}%`;
                if (progressPercent) progressPercent.innerText = `${pct}%`;
                renderBatchPreview();
            }, forceOverwrite);
        }

        renderBatchPreview();

        if (progressBar) progressBar.style.width = `100%`;
        if (progressPercent) progressPercent.innerText = `100%`;
        if (progressText) progressText.innerText = safeT('progressAiComplete', null, 'AI 自動補齊完成！');
        if (typeof showToast === 'function') showToast(safeT('toastAiBatchSuccess', null, 'AI 批次補充成功！'), 'success');
    } catch (err) {
        console.error('[Batch Modal AI Fill Error]:', err);
        if (typeof showToast === 'function') showToast(`AI 補齊失敗：${err.message}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function resetBatchModal() {
    window.parsedBatchList = [];
    
    const rawInput = document.getElementById('batchRawInput');
    if (rawInput) rawInput.value = '';

    const previewBox = document.getElementById('batchPreviewBox');
    if (previewBox) previewBox.classList.add('hidden');

    const previewBody = document.getElementById('batchPreviewBody');
    if (previewBody) previewBody.innerHTML = '';

    const confirmBtn = document.getElementById('confirmBatchImportBtn');
    if (confirmBtn) confirmBtn.disabled = true;

    const progressContainer = document.getElementById('batchProgressContainer');
    if (progressContainer) progressContainer.classList.add('hidden');

    const progressBar = document.getElementById('batchProgressBar');
    if (progressBar) progressBar.style.width = '0%';

    if (typeof resetBatchAiParserState === 'function') {
        resetBatchAiParserState();
    }
}

function handleConfirmBatchImport() {
    if (!window.parsedBatchList || window.parsedBatchList.length === 0) return;

    const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
    const catRes = (typeof getCategorySelectorValue === 'function')
        ? getCategorySelectorValue('batch')
        : { isNew: false, value: document.getElementById('batchTargetCategory')?.value.trim() || '' };

    if (catRes.isNew && !catRes.value) {
        const enterNewMsg = safeT('toastEnterNewDeckName', null, '請輸入新字庫名稱！');
        if (typeof showToast === 'function') showToast(enterNewMsg, 'warning');
        document.getElementById('batchTargetCategory')?.focus();
        return;
    }
    const targetCategory = catRes.value || defaultCatName;
    const targetCatLower = targetCategory.toLowerCase();

    // 建立 Map 索引以加速大量單字（如 JLPT / 7000 單）匯入時的重複與進度繼承比對
    const bestProgressMap = new Map();
    const targetCatMap = new Map();

    (wordList || []).forEach(w => {
        if (!w || !w.word) return;
        const k = normalizeWordKey(w.word);
        if (!k) return;

        const prevBest = bestProgressMap.get(k);
        if (!prevBest || (typeof compareCardProgress === 'function' && compareCardProgress(w, prevBest) > 0)) {
            bestProgressMap.set(k, w);
        }

        const wCatLower = (w.category || defaultCatName).trim().toLowerCase();
        if (wCatLower === targetCatLower && !targetCatMap.has(k)) {
            targetCatMap.set(k, w);
        }
    });

    let addedCount = 0;
    let replacedCount = 0;
    const now = Date.now();
    const removedOldSet = new Set();
    const newCardsToPrepend = [];

    window.parsedBatchList.forEach(item => {
        if (item && item.word) {
            const itemWord = String(item.word).trim().replace(/\s+/g, ' ');
            const normWord = normalizeWordKey(itemWord);
            if (!normWord) return;

            const inherited = bestProgressMap.get(normWord) || null;

            const detCardId = (typeof generateDeterministicCardId === 'function')
                ? generateDeterministicCardId(targetCategory, itemWord)
                : ('w_' + now + '_' + Math.random().toString(36).substr(2, 6));
            const detDeckId = (typeof generateDeterministicDeckId === 'function')
                ? generateDeterministicDeckId(targetCategory)
                : undefined;

            const newCardData = {
                id: detCardId,
                deckId: detDeckId,
                category: targetCategory,
                word: itemWord,
                pos: String(item.pos || (inherited && isValidFieldValue(inherited.pos, 'pos') ? inherited.pos : '')).trim(),
                phonetic: String(item.phonetic || (inherited && isValidFieldValue(inherited.phonetic, 'phonetic') ? inherited.phonetic : '')).trim(),
                meaning: String(item.meaning || (inherited && isValidFieldValue(inherited.meaning, 'meaning') ? inherited.meaning : safeT('noMeaning', null, '無釋義'))).trim(),
                sentence: String(item.sentence || (inherited && isValidFieldValue(inherited.sentence, 'sentence') ? inherited.sentence : '')).trim(),
                translation: String(item.translation || (inherited && isValidFieldValue(inherited.translation, 'translation') ? inherited.translation : '')).trim(),
                level: inherited ? (inherited.level || 1) : 1,
                knowStreak: inherited ? (inherited.knowStreak || 0) : 0,
                state: inherited ? (inherited.state || 'new') : 'new',
                stability: inherited && typeof inherited.stability === 'number' ? inherited.stability : 0,
                difficulty: inherited && typeof inherited.difficulty === 'number' ? inherited.difficulty : 5.5,
                reps: inherited ? (inherited.reps || 0) : 0,
                lapses: inherited ? (inherited.lapses || 0) : 0,
                lastReview: inherited ? (inherited.lastReview || 0) : 0,
                nextReview: inherited ? (inherited.nextReview || 0) : 0,
                freeLevel: inherited ? (inherited.freeLevel || 1) : 1,
                freeStreak: inherited ? (inherited.freeStreak || 0) : 0,
                updatedAt: now
            };

            const existingItem = targetCatMap.get(normWord);
            if (existingItem) {
                removedOldSet.add(existingItem);
                const merged = mergeDuplicateWordRecord(existingItem, newCardData, true);
                targetCatMap.set(normWord, merged);
                bestProgressMap.set(normWord, merged);
                newCardsToPrepend.unshift(merged);
                replacedCount++;
            } else {
                targetCatMap.set(normWord, newCardData);
                bestProgressMap.set(normWord, newCardData);
                newCardsToPrepend.unshift(newCardData);
            }
            addedCount++;
        }
    });

    if (removedOldSet.size > 0) {
        for (let i = wordList.length - 1; i >= 0; i--) {
            if (removedOldSet.has(wordList[i])) {
                wordList.splice(i, 1);
            }
        }
    }
    if (newCardsToPrepend.length > 0) {
        wordList.unshift(...newCardsToPrepend);
    }

    autoDeduplicateWordList({ silent: true });

    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();
    if (!currentCard && typeof nextCard === 'function') nextCard();

    if (typeof closeModal === 'function') closeModal('batchModal');

    const netUniqueAdded = addedCount - replacedCount;
    const msg = replacedCount > 0 
        ? safeT('toastImportSuccessDeDup', { count: addedCount, dedup: replacedCount, actual: netUniqueAdded }, `成功匯入 ${addedCount} 個單字（自動合併 ${replacedCount} 筆重複單字）`)
        : safeT('toastImportSuccess', { count: addedCount }, `成功匯入 ${addedCount} 個單字`);

    if (typeof showToast === 'function') showToast(msg, 'success');
    if (typeof saveStorage === 'function') saveStorage();
}

async function handleQuickAddWords() {
    const inputElem = document.getElementById('quickAddInput');
    const catInputElem = document.getElementById('quickAddCategoryInput');
    const rawText = inputElem ? inputElem.value.trim() : '';

    if (!rawText) {
        if (typeof showToast === 'function') showToast(safeT('toastEnterQuickWords', null, '請輸入要快速新增的單字'), 'warning');
        return;
    }

    const wordsToProcess = rawText
        .split(/[,;\n\r\t，；]+/)
        .map(w => w.trim())
        .filter(w => w.length > 0);

    if (wordsToProcess.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastNoValidQuickWords', null, '未檢測到有效的單字'), 'warning');
        return;
    }

    const defaultCategoryName = safeT('defaultCategoryName', null, '預設字庫');
    const defaultMeaningText = safeT('progressAiParsing', null, 'AI 自動解析中...');

    const catRes = (typeof getCategorySelectorValue === 'function')
        ? getCategorySelectorValue('quickAdd')
        : { isNew: false, value: catInputElem ? catInputElem.value.trim() : '' };

    if (catRes.isNew && !catRes.value) {
        const enterNewMsg = safeT('toastEnterNewDeckName', null, '請輸入新字庫名稱！');
        if (typeof showToast === 'function') showToast(enterNewMsg, 'warning');
        document.getElementById('quickAddCategoryInput')?.focus();
        return;
    }
    const targetCategory = catRes.value || defaultCategoryName;

    const btn = document.getElementById('quickAddConfirmBtn');
    const origText = btn ? btn.innerText : '';
    if (btn) {
        btn.disabled = true;
        btn.innerText = safeT('btnProcessing', null, '處理中...');
    }

    localStorage.setItem('lzhcard_last_quick_add_cat', targetCategory);

    autoDeduplicateWordList({ silent: true });

    let addedList = [];
    let skippedDuplicateCount = 0;

    for (const rawInputWord of wordsToProcess) {
        const cleanObj = (typeof sanitizeWordAndPos === 'function')
            ? sanitizeWordAndPos(rawInputWord, '', '')
            : { word: rawInputWord, pos: '', meaning: '' };

        const cleanWord = String(cleanObj.word || rawInputWord).trim().replace(/\s+/g, ' ');
        const normWord = normalizeWordKey(cleanWord);
        if (!normWord) continue;

        const existsInTargetCat = wordList.some(w => 
            (w.category || defaultCategoryName).trim().toLowerCase() === targetCategory.toLowerCase() && 
            normalizeWordKey(w.word) === normWord
        );

        if (existsInTargetCat) {
            skippedDuplicateCount++;
            continue;
        }

        // 若其他字庫已有同名單字，完整繼承其 FSRS 學習進度、自由練習等級與已解析資料
        const matchingOthers = wordList.filter(w => normalizeWordKey(w.word) === normWord);
        let existingInOtherCat = matchingOthers[0] || null;
        if (matchingOthers.length > 1 && typeof compareCardProgress === 'function') {
            matchingOthers.forEach(c => {
                if (compareCardProgress(c, existingInOtherCat) > 0) existingInOtherCat = c;
            });
        }

        const detCardId = (typeof generateDeterministicCardId === 'function')
            ? generateDeterministicCardId(targetCategory, cleanWord)
            : ('w_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
        const detDeckId = (typeof generateDeterministicDeckId === 'function')
            ? generateDeterministicDeckId(targetCategory)
            : undefined;

        const newCard = {
            id: detCardId,
            deckId: detDeckId,
            category: targetCategory,
            word: cleanWord,
            pos: existingInOtherCat && isValidFieldValue(existingInOtherCat.pos, 'pos') ? existingInOtherCat.pos : (cleanObj.pos || ''),
            phonetic: existingInOtherCat && isValidFieldValue(existingInOtherCat.phonetic, 'phonetic') ? existingInOtherCat.phonetic : '',
            meaning: existingInOtherCat && isValidFieldValue(existingInOtherCat.meaning, 'meaning') ? existingInOtherCat.meaning : defaultMeaningText,
            sentence: existingInOtherCat && isValidFieldValue(existingInOtherCat.sentence, 'sentence') ? existingInOtherCat.sentence : '',
            translation: existingInOtherCat && isValidFieldValue(existingInOtherCat.translation, 'translation') ? existingInOtherCat.translation : '',
            level: existingInOtherCat ? (existingInOtherCat.level || 1) : 1,
            knowStreak: existingInOtherCat ? (existingInOtherCat.knowStreak || 0) : 0,
            state: existingInOtherCat ? (existingInOtherCat.state || 'new') : 'new',
            stability: existingInOtherCat && typeof existingInOtherCat.stability === 'number' ? existingInOtherCat.stability : 0,
            difficulty: existingInOtherCat && typeof existingInOtherCat.difficulty === 'number' ? existingInOtherCat.difficulty : 5.5,
            reps: existingInOtherCat ? (existingInOtherCat.reps || 0) : 0,
            lapses: existingInOtherCat ? (existingInOtherCat.lapses || 0) : 0,
            lastReview: existingInOtherCat ? (existingInOtherCat.lastReview || 0) : 0,
            nextReview: existingInOtherCat ? (existingInOtherCat.nextReview || 0) : 0,
            freeLevel: existingInOtherCat ? (existingInOtherCat.freeLevel || 1) : 1,
            freeStreak: existingInOtherCat ? (existingInOtherCat.freeStreak || 0) : 0,
            updatedAt: Date.now()
        };
        if (typeof migrateCardFSRS === 'function') {
            migrateCardFSRS(newCard);
        }
        wordList.unshift(newCard);
        addedList.push(newCard);
    }

    if (typeof closeModal === 'function') closeModal('quickAddModal');
    if (inputElem) inputElem.value = '';
    if (btn) {
        btn.disabled = false;
        btn.innerText = origText;
    }

    if (addedList.length === 0) {
        if (typeof showToast === 'function') {
            showToast(
                safeT('toastQuickWordsExist', { count: skippedDuplicateCount }, `輸入的 ${skippedDuplicateCount} 個單字皆已存在，已自動略過重複項`),
                'info'
            );
        }
        return;
    }

    if (typeof saveStorage === 'function') saveStorage();
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();

    if (typeof showToast === 'function') {
        const msg = skippedDuplicateCount > 0
            ? safeT('toastQuickAddSuccessDedup', { count: addedList.length, skipped: skippedDuplicateCount }, `已新增 ${addedList.length} 個單字（已自動略過 ${skippedDuplicateCount} 個重複字），AI 正在背景解析中`)
            : safeT('toastQuickAddSuccess', { count: addedList.length }, `已新增 ${addedList.length} 個單字，AI 正在背景解析中`);
        showToast(msg, 'success');
    }

    const cardsNeedingAi = addedList.filter(c => !isValidFieldValue(c.meaning, 'meaning') || !isValidFieldValue(c.sentence, 'sentence'));

    if (cardsNeedingAi.length > 0 && typeof runBatchAiAutoFill === 'function') {
        try {
            await runBatchAiAutoFill(cardsNeedingAi, (current, total) => {
                const now = Date.now();
                cardsNeedingAi.forEach(c => { c.updatedAt = now; });
                if (typeof saveStorage === 'function') saveStorage();
                if (typeof updateUI === 'function') updateUI();
            });

            const doneTs = Date.now();
            cardsNeedingAi.forEach(c => { c.updatedAt = doneTs; });
            if (typeof saveStorage === 'function') saveStorage();
            if (typeof updateUI === 'function') updateUI();

            if (currentCard) {
                const updated = wordList.find(w => w.id === currentCard.id);
                if (updated) {
                    currentCard = updated;
                }
            }
            if (typeof showToast === 'function') showToast(safeT('toastAiCompletionDone', null, 'AI 背景解析完成！'), 'success');
        } catch (err) {
            console.warn("AI 自動補充跳過或失敗:", err);
        }
    }
}

function openSplitDeckModal() {
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    handleSplitConditionChange();
    updateSplitDeckPreview();
    if (typeof openModal === 'function') openModal('splitModal');
}

function handleSplitConditionChange() {
    const condSelect = document.getElementById('splitConditionSelect');
    const chunkWrapper = document.getElementById('splitChunkSizeWrapper');
    const customNameWrapper = document.getElementById('splitCustomNameWrapper');
    const cond = condSelect ? condSelect.value : 'by_diff_level';

    if (chunkWrapper) {
        chunkWrapper.classList.toggle('hidden', cond !== 'by_count');
    }
    if (customNameWrapper) {
        customNameWrapper.classList.toggle('hidden', cond !== 'by_selected_custom');
    }
}

function computeSplitDeckPlan() {
    const select = document.getElementById('splitTargetCategorySelect');
    const condSelect = document.getElementById('splitConditionSelect');
    const chunkSizeInput = document.getElementById('splitChunkSizeInput');
    const customNameInput = document.getElementById('splitCustomNameInput');

    const targetCat = select ? select.value : '__ALL__';
    const condition = condSelect ? condSelect.value : 'by_diff_level';
    const chunkSize = Math.max(5, parseInt(chunkSizeInput ? chunkSizeInput.value : '100', 10) || 100);
    const customName = customNameInput ? customNameInput.value.trim() : '';

    const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
    const noMeaningText = safeT('noMeaning', null, '未設定釋義');

    let sourceWords = [];
    if (condition === 'by_selected_custom') {
        if (typeof selectedWordIds !== 'undefined' && selectedWordIds.size > 0) {
            sourceWords = wordList.filter(w => selectedWordIds.has(w.id));
        }
    } else if (targetCat === '__ALL__') {
        sourceWords = [...wordList];
    } else {
        sourceWords = wordList.filter(w => {
            const cat = (w.category && w.category.trim() !== '') ? w.category.trim() : defaultCatName;
            return cat === targetCat;
        });
    }

    const prefix = (targetCat && targetCat !== '__ALL__') ? `${targetCat} - ` : '';
    const groups = [];

    if (sourceWords.length === 0) {
        return { condition, targetCat, chunkSize, customName, sourceWords, groups };
    }

    const isMissingField = (item, field) => {
        if (field === 'meaning') {
            return !item.meaning || !String(item.meaning).trim() || String(item.meaning).trim() === noMeaningText;
        }
        return !item[field] || !String(item[field]).trim();
    };

    if (condition === 'by_diff_level') {
        const buckets = new Map();
        const order = [1, 2, 3, 4, 5, 6, 0];
        order.forEach(lv => buckets.set(lv, []));

        sourceWords.forEach(w => {
            let diffLv = 0;
            if (typeof getCardDiffInfo === 'function') {
                diffLv = getCardDiffInfo(w).level;
            } else if (typeof getWordDifficultyInfo === 'function') {
                const explicit = w.diffLevelManual === true ? w.diffLevel : null;
                diffLv = getWordDifficultyInfo(w.word, explicit).level;
            } else if (typeof w.diffLevel === 'number') {
                diffLv = w.diffLevel;
            }
            if (!buckets.has(diffLv)) diffLv = 0;
            buckets.get(diffLv).push(w);
        });

        const diffNames = {
            1: '7000單 1級 (基礎)',
            2: '7000單 2級 (初級)',
            3: '7000單 3級 (中級)',
            4: '7000單 4級 (中高/學測)',
            5: '7000單 5級 (高級/分科)',
            6: '7000單 6級 (頂級/指考)',
            0: '冷門單字'
        };

        order.forEach(lv => {
            const items = buckets.get(lv);
            if (items && items.length > 0) {
                groups.push({
                    targetDeckName: `${prefix}${diffNames[lv]}`,
                    words: items
                });
            }
        });
    } else if (condition === 'by_fsrs_level') {
        const buckets = new Map([1, 2, 3, 4, 5].map(lv => [lv, []]));
        sourceWords.forEach(w => {
            const lv = Math.min(5, Math.max(1, parseInt(w.level, 10) || 1));
            buckets.get(lv).push(w);
        });
        [1, 2, 3, 4, 5].forEach(lv => {
            const items = buckets.get(lv);
            if (items && items.length > 0) {
                groups.push({
                    targetDeckName: `${prefix}FSRS Lv.${lv}`,
                    words: items
                });
            }
        });
    } else if (condition === 'by_free_level') {
        const buckets = new Map([1, 2, 3, 4, 5].map(lv => [lv, []]));
        sourceWords.forEach(w => {
            const lv = Math.min(5, Math.max(1, parseInt(w.freeLevel, 10) || 1));
            buckets.get(lv).push(w);
        });
        [1, 2, 3, 4, 5].forEach(lv => {
            const items = buckets.get(lv);
            if (items && items.length > 0) {
                groups.push({
                    targetDeckName: `${prefix}臨時 Lv.${lv}`,
                    words: items
                });
            }
        });
    } else if (condition === 'by_missing_fields') {
        const buckets = {
            missing_meaning: [],
            missing_sentence: [],
            missing_phonetic: [],
            missing_pos: [],
            complete: []
        };
        sourceWords.forEach(w => {
            if (isMissingField(w, 'meaning')) {
                buckets.missing_meaning.push(w);
            } else if (isMissingField(w, 'sentence')) {
                buckets.missing_sentence.push(w);
            } else if (isMissingField(w, 'phonetic')) {
                buckets.missing_phonetic.push(w);
            } else if (isMissingField(w, 'pos')) {
                buckets.missing_pos.push(w);
            } else {
                buckets.complete.push(w);
            }
        });

        const labelMap = [
            ['missing_meaning', '缺釋義'],
            ['missing_sentence', '缺例句'],
            ['missing_phonetic', '缺音標'],
            ['missing_pos', '缺詞性'],
            ['complete', '欄位完整']
        ];
        labelMap.forEach(([key, label]) => {
            if (buckets[key].length > 0) {
                groups.push({
                    targetDeckName: `${prefix}${label}`,
                    words: buckets[key]
                });
            }
        });
    } else if (condition === 'by_count') {
        const baseName = (targetCat && targetCat !== '__ALL__') ? targetCat : '字庫分段';
        let partNum = 1;
        for (let i = 0; i < sourceWords.length; i += chunkSize) {
            groups.push({
                targetDeckName: `${baseName} - ${partNum}`,
                words: sourceWords.slice(i, i + chunkSize)
            });
            partNum++;
        }
    } else if (condition === 'by_selected_custom') {
        groups.push({
            targetDeckName: customName || '精選拆分字庫',
            words: sourceWords
        });
    }

    return { condition, targetCat, chunkSize, customName, sourceWords, groups };
}

function updateSplitDeckPreview() {
    const summaryEl = document.getElementById('splitPreviewSummary');
    const listEl = document.getElementById('splitPreviewList');
    if (!summaryEl || !listEl) return;

    const plan = computeSplitDeckPlan();
    const escapeHtml = (str) => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    if (plan.sourceWords.length === 0) {
        summaryEl.innerText = '0 個子字庫';
        listEl.innerHTML = plan.condition === 'by_selected_custom'
            ? '<div class="text-center py-2 text-amber-600 dark:text-amber-400">請先在字庫表格勾選要拆出的單字</div>'
            : '<div class="text-center py-2 text-slate-400">來源字庫目前沒有單字</div>';
        return;
    }

    summaryEl.innerText = `${plan.groups.length} 個子字庫 · 共 ${plan.sourceWords.length} 字`;
    listEl.innerHTML = plan.groups.map(g => `
        <div class="flex items-center justify-between py-1.5 gap-2">
            <span class="font-semibold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(g.targetDeckName)}</span>
            <span class="px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 font-bold text-[11px] shrink-0">${g.words.length} 字</span>
        </div>
    `).join('');
}

function handleConfirmSplitDeck() {
    const plan = computeSplitDeckPlan();

    if (plan.condition === 'by_selected_custom') {
        if (plan.sourceWords.length === 0) {
            if (typeof showToast === 'function') showToast('請先勾選要拆出的單字！', 'warning');
            return;
        }
        if (!plan.customName) {
            if (typeof showToast === 'function') showToast('請輸入拆出的新字庫名稱！', 'warning');
            document.getElementById('splitCustomNameInput')?.focus();
            return;
        }
    } else if (plan.sourceWords.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastSelectSplitDeck', null, '來源字庫沒有單字可拆分'), 'warning');
        return;
    } else if (plan.condition === 'by_count' && plan.sourceWords.length <= plan.chunkSize) {
        if (typeof showToast === 'function') showToast(safeT('toastSplitThreshold', { size: plan.chunkSize }, `單字量未超過 ${plan.chunkSize}，無需按數量拆分`), 'info');
        return;
    }

    const now = Date.now();
    const newDeckNames = [];
    plan.groups.forEach(g => {
        newDeckNames.push(g.targetDeckName);
        const detDeckId = (typeof generateDeterministicDeckId === 'function') ? generateDeterministicDeckId(g.targetDeckName) : undefined;
        g.words.forEach(w => {
            w.category = g.targetDeckName;
            if (detDeckId) w.deckId = detDeckId;
            if (typeof generateDeterministicCardId === 'function' && w.word) {
                w.id = generateDeterministicCardId(g.targetDeckName, w.word);
            }
            w.updatedAt = now;
        });
    });

    if (Array.isArray(window.selectedCategories) && !window.selectedCategories.includes('ALL')) {
        const updatedSel = new Set(window.selectedCategories);
        newDeckNames.forEach(n => updatedSel.add(n));
        window.selectedCategories = Array.from(updatedSel);
        if (typeof saveSelectedCategoriesToCloud === 'function') {
            saveSelectedCategoriesToCloud(window.selectedCategories);
        }
    }

    autoDeduplicateWordList({ silent: true });

    if (typeof saveStorage === 'function') saveStorage(true);
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();
    if (typeof closeModal === 'function') closeModal('splitModal');
    if (typeof showToast === 'function') {
        showToast(safeT('toastSplitSuccess', { count: plan.groups.length }, `成功拆分為 ${plan.groups.length} 個子字庫！`), 'success');
    }
}

if (typeof window !== 'undefined') {
    window.openSplitDeckModal = openSplitDeckModal;
    window.handleSplitConditionChange = handleSplitConditionChange;
    window.updateSplitDeckPreview = updateSplitDeckPreview;
    window.handleConfirmSplitDeck = handleConfirmSplitDeck;
}

async function handleRenameCategory() {
    const activeCats = window.selectedCategories || [];
    let targetCat = activeCats[0] || 'ALL';
    const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');

    if (targetCat === 'ALL' || activeCats.length > 1 || activeCats.length === 0) {
        const cats = typeof getAllCategories === 'function' ? getAllCategories() : [];
        if (cats.length === 0) return;

        let chosen = null;
        if (typeof window.lzhChoice === 'function') {
            chosen = await window.lzhChoice(
                safeT('promptSelectRenameDeck', { list: cats.join('、 ') }, '請選擇要重命名的字庫：'),
                cats.map(c => ({ value: c, label: c })),
                { title: '重命名字庫' }
            );
        } else if (typeof window.lzhPrompt === 'function') {
            chosen = await window.lzhPrompt(
                safeT('promptSelectRenameDeck', { list: cats.join('、 ') }, `請輸入要重命名的字庫名稱：\n(${cats.join('、 ')})`),
                cats[0]
            );
        }
        if (!chosen || !String(chosen).trim()) return;
        targetCat = String(chosen).trim();

        if (!cats.includes(targetCat)) {
            if (typeof showToast === 'function') showToast(safeT('toastCategoryNotFound', { name: targetCat }, `未找到字庫「${targetCat}」`), 'warning');
            return;
        }
    }

    const newName = (typeof window.lzhPrompt === 'function')
        ? await window.lzhPrompt(safeT('promptNewDeckName', { name: targetCat }, `請輸入「${targetCat}」的新名稱：`), targetCat, { title: '輸入新字庫名稱' })
        : null;
    if (!newName || !newName.trim() || newName.trim() === targetCat) return;

    const cleanNewName = newName.trim();
    const now = Date.now();
    let updatedCount = 0;

    const renamedDeckId = (typeof generateDeterministicDeckId === 'function') ? generateDeterministicDeckId(cleanNewName) : undefined;
    wordList.forEach(item => {
        const currentCat = item.category || defaultCatName;
        if (currentCat === targetCat) {
            item.category = cleanNewName;
            if (renamedDeckId) item.deckId = renamedDeckId;
            if (typeof generateDeterministicCardId === 'function' && item.word) {
                item.id = generateDeterministicCardId(cleanNewName, item.word);
            }
            item.updatedAt = now;
            updatedCount++;
        }
    });

    window.selectedCategories = window.selectedCategories.map(c => c === targetCat ? cleanNewName : c);
    if (typeof saveSelectedCategoriesToCloud === 'function') {
        saveSelectedCategoriesToCloud(window.selectedCategories);
    }

    autoDeduplicateWordList({ silent: true });

    if (typeof saveStorage === 'function') saveStorage(true);
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();
    if (typeof showToast === 'function') showToast(safeT('toastRenameSuccess', { oldName: targetCat, newName: cleanNewName, count: updatedCount }, `已將「${targetCat}」重命名為「${cleanNewName}」`), 'success');
}

/**
 * 📦 批量變更 / 移動字庫（移動後若與目標字庫有重複字會自動合併刪除）
 */
async function handleBatchChangeCategory() {
    if (typeof selectedWordIds === 'undefined' || selectedWordIds.size === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastSelectMoveWords', null, '請先勾選要移動的單字！'), 'warning');
        return;
    }

    const activeCats = window.selectedCategories || ['ALL'];
    const currentCatName = (activeCats.length === 1 && activeCats[0] !== 'ALL')
        ? activeCats[0]
        : safeT('defaultCategoryName', null, '預設字庫');

    const promptText = safeT('promptMoveTarget', { count: selectedWordIds.size }, `將已選取的 ${selectedWordIds.size} 筆單字移至新的字庫名稱：`);

    const newCategory = (typeof window.lzhPrompt === 'function')
        ? await window.lzhPrompt(promptText, currentCatName, { title: '移動字庫' })
        : null;
    if (!newCategory || !newCategory.trim()) return;

    const catName = newCategory.trim();
    const now = Date.now();
    let count = 0;

    const movedDeckId = (typeof generateDeterministicDeckId === 'function') ? generateDeterministicDeckId(catName) : undefined;
    wordList.forEach(item => {
        if (selectedWordIds.has(item.id)) {
            item.category = catName;
            if (movedDeckId) item.deckId = movedDeckId;
            if (typeof generateDeterministicCardId === 'function' && item.word) {
                item.id = generateDeterministicCardId(catName, item.word);
            }
            item.updatedAt = now;
            count++;
        }
    });

    if (typeof selectedWordIds !== 'undefined') selectedWordIds.clear();

    const dedupedCount = autoDeduplicateWordList({ silent: true });

    if (typeof saveStorage === 'function') saveStorage(true);
    if (typeof updateCategorySelects === 'function') updateCategorySelects();
    if (typeof updateUI === 'function') updateUI();

    if (typeof showToast === 'function') {
        const msg = dedupedCount > 0
            ? safeT('toastMoveSuccessDedup', { count, name: catName, dedup: dedupedCount }, `已成功將 ${count} 個單字移至「${catName}」（並自動合併 ${dedupedCount} 筆重複單字）`)
            : safeT('toastMoveSuccess', { count, name: catName }, `已成功將 ${count} 個單字移至「${catName}」`);
        showToast(msg, 'success');
    }
}

async function handleBatchDeleteWords() {
    if (typeof selectedWordIds === 'undefined' || selectedWordIds.size === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastSelectDeleteWords', null, '請先勾選要刪除的單字！'), 'warning');
        return;
    }

    const confirmMsg = safeT('confirmDeleteBatch', { count: selectedWordIds.size }, `確定要刪除已選取的 ${selectedWordIds.size} 筆單字嗎？`);
    const confirmed = await (typeof window.lzhConfirm === 'function' ? window.lzhConfirm(confirmMsg) : Promise.resolve(false));
    if (confirmed) {
        const deletedIdsSnapshot = new Set(selectedWordIds);
        const nextList = wordList.filter(item => !deletedIdsSnapshot.has(item.id));
        if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.setWordListInPlace === 'function') {
            StorageEngine.setWordListInPlace(nextList);
        } else {
            wordList.length = 0;
            wordList.push(...nextList);
            if (typeof window !== 'undefined') window.wordList = wordList;
        }
        selectedWordIds.clear();
        if (typeof ratingUndoStack !== 'undefined' && Array.isArray(ratingUndoStack)) {
            ratingUndoStack = ratingUndoStack.filter(snap => snap && !deletedIdsSnapshot.has(snap.cardId));
            if (typeof updateUndoButtonUI === 'function') updateUndoButtonUI();
        }
        if (typeof saveStorage === 'function') await saveStorage(true);
        if (typeof updateCategorySelects === 'function') updateCategorySelects();
        if (typeof updateUI === 'function') updateUI();
        if (typeof nextCard === 'function') nextCard();
        if (typeof showToast === 'function') showToast(safeT('toastDeleteBatchSuccess', null, '批量刪除完成！'), 'info');
    }
}

/**
 * 🤖 點擊畫面「✨ AI 補齊」觸發的 UI 互動與進度條控制
 */
async function handleBatchAiFillLibraryWords() {
    try {
        const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
        const activeCats = window.selectedCategories || ['ALL'];

        let targetWords = [];
        if (typeof selectedWordIds !== 'undefined' && selectedWordIds.size > 0) {
            targetWords = (wordList || []).filter(item => selectedWordIds.has(item.id));
        } else {
            targetWords = (wordList || []).filter(item => {
                if (activeCats.includes("ALL")) return true;
                return activeCats.includes(item.category || defaultCatName);
            });
        }

        if (targetWords.length === 0) {
            if (typeof showToast === 'function') showToast(safeT('toastNoWordsToFill', null, '當前選取範圍內沒有單字可供補齊！'), 'warning');
            return;
        }

        const incompleteWords = targetWords.filter(item => {
            return (typeof isFieldIncomplete === 'function') ? (
                isFieldIncomplete(item.meaning, 'meaning') || 
                isFieldIncomplete(item.pos, 'pos') || 
                isFieldIncomplete(item.sentence, 'sentence') || 
                isFieldIncomplete(item.translation, 'translation') ||
                isFieldIncomplete(item.phonetic, 'phonetic')
            ) : (!item.meaning || !item.pos || !item.sentence);
        });

        const hasAnyExistingData = targetWords.some(item =>
            Boolean((item.meaning && item.meaning.trim()) || (item.pos && item.pos.trim()) || (item.phonetic && item.phonetic.trim()) || (item.sentence && item.sentence.trim()))
        );

        let forceOverwrite = false;
        let targetBatch = [];

        if (incompleteWords.length === 0) {
            const confirmOverwriteMsg = safeT(
                'confirmBatchAiOverwriteAll',
                { total: targetWords.length },
                `所選取的 ${targetWords.length} 筆單字資料皆已完整！\n\n` +
                `是否要開啟「語言修正模式」（依據當前學習語系與母語重新解析並【強制覆蓋】舊資料）？\n\n` +
                `【確定】➜ 強制覆蓋\n` +
                `【取消】➜ 放棄退出`
            );
            const overwriteOk = await (typeof window.lzhConfirm === 'function' ? window.lzhConfirm(confirmOverwriteMsg) : Promise.resolve(false));
            if (!overwriteOk) return;
            forceOverwrite = true;
            targetBatch = targetWords;
        } else if (hasAnyExistingData) {
            const promptChoiceMsg = safeT(
                'promptBatchAiModeChoice',
                { total: targetWords.length, incomplete: incompleteWords.length },
                `選取的 ${targetWords.length} 筆單字中，有 ${incompleteWords.length} 筆缺漏或非母語欄位，請選擇處理方式：`
            );
            const choice = (typeof window.lzhChoice === 'function')
                ? await window.lzhChoice(promptChoiceMsg, [
                    { value: '1', label: `1 · 僅補齊缺漏／非母語欄位 (${incompleteWords.length} 筆)` },
                    { value: '2', label: `2 · 強制覆蓋重新解析全選 ${targetWords.length} 筆` }
                ], { title: '✨ AI 批次補齊模式' })
                : '1';

            if (!choice) return;

            const trimmedChoice = String(choice).trim();
            if (trimmedChoice === '2') {
                forceOverwrite = true;
                targetBatch = targetWords;
            } else if (trimmedChoice === '1') {
                forceOverwrite = false;
                targetBatch = incompleteWords;
            } else {
                return;
            }
        } else {
            targetBatch = incompleteWords;
            const confirmMsg = safeT('confirmBatchAiFill', { count: targetBatch.length }, `確定要使用 AI 自動補齊缺漏的 ${targetBatch.length} 筆單字嗎？`);
            const fillOk = await (typeof window.lzhConfirm === 'function' ? window.lzhConfirm(confirmMsg) : Promise.resolve(false));
            if (!fillOk) return;
        }

        if (targetBatch.length === 0) {
            if (typeof showToast === 'function') showToast(safeT('toastAllWordsComplete', null, '單字資料皆已完整！'), 'info');
            return;
        }

        const MAX_LIMIT = typeof MAX_AI_BATCH_LIMIT !== 'undefined' ? MAX_AI_BATCH_LIMIT : 200;

        if (targetBatch.length > MAX_LIMIT) {
            if (typeof showToast === 'function') showToast(safeT('toastBatchLimitExceeded', { count: targetBatch.length, limit: MAX_LIMIT }, `一次最多僅支援批次補齊 ${MAX_LIMIT} 筆單字！`), 'error');
            return;
        }

        const progressContainer = document.getElementById('libAiProgressContainer') 
                                || document.getElementById('aiProgressContainer');
        const progressBar = document.getElementById('libAiProgressBar') 
                         || document.getElementById('aiProgressBar');
        const progressText = document.getElementById('libAiProgressText') 
                         || document.getElementById('aiProgressText');
        const progressPercent = document.getElementById('libAiProgressPercent') 
                           || document.getElementById('aiProgressPercent');

        if (progressContainer) progressContainer.classList.remove('hidden');

        let actualUpdated = targetBatch.length;
        if (typeof runBatchAiAutoFill === 'function') {
            const countRes = await runBatchAiAutoFill(targetBatch, (current, total) => {
                const pct = Math.round((current / total) * 100);
                if (progressText) progressText.innerText = safeT('progressBatchAi', { current, total }, `AI 自動補充中... (${current}/${total})`);
                if (progressBar) progressBar.style.width = `${pct}%`;
                if (progressPercent) progressPercent.innerText = `${pct}%`;
                if (typeof renderWordList === 'function') renderWordList(false);
            }, forceOverwrite);
            if (typeof countRes === 'number') actualUpdated = countRes;

            const now = Date.now();
            targetBatch.forEach(item => { item.updatedAt = now; });
        }

        if (typeof saveStorage === 'function') saveStorage();
        if (typeof updateUI === 'function') updateUI();

        if (progressText) progressText.innerText = safeT('progressAiComplete', null, 'AI 自動補充完成！');
        if (progressBar) progressBar.style.width = "100%";
        if (progressPercent) progressPercent.innerText = "100%";

        setTimeout(() => {
            if (progressContainer) progressContainer.classList.add('hidden');
        }, 2500);

        if (typeof showToast === 'function') showToast(safeT('toastBatchFillSuccess', { count: actualUpdated }, `成功補齊 ${actualUpdated} / ${targetBatch.length} 筆單字！`), 'success');
    } catch (err) {
        console.error("[AI Batch Fill Exception]:", err);
        if (typeof showToast === 'function') {
            showToast(safeT('toastBatchAiError', { error: err.message }, `AI 補齊過程發生錯誤: ${err.message}`), "error");
        }
    }
}

/**
 * 💾 匯出完整 JSON 備份（完整保留所有單字內容、FSRS 記憶曲線與自由練習進度）
 */
/**
 * 💾 匯出 JSON 備份（支援依下拉選單篩選指定字庫，並相容 iOS 大型字庫下載）
 */
function exportJSON() {
    if (!Array.isArray(wordList) || wordList.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastNoExportWords', null, '尚無單字資料可匯出！'), 'warning');
        return;
    }

    autoDeduplicateWordList({ silent: true });

    const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
    const exportSelect = document.getElementById('exportCategorySelect');
    const selectedExportCat = exportSelect ? exportSelect.value : 'ALL';

    const wordsToExport = selectedExportCat === 'ALL'
        ? [...wordList]
        : wordList.filter(w => {
            const cat = (w && w.category && w.category.trim() !== '') ? w.category.trim() : defaultCatName;
            return cat === selectedExportCat;
        });

    if (wordsToExport.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastNoExportWords', null, '所選字庫內尚無單字可匯出！'), 'warning');
        return;
    }

    const dataStr = JSON.stringify(wordsToExport, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);
    const safeCatLabel = (selectedExportCat === 'ALL' ? '全部字庫' : selectedExportCat)
        .replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `LZHCard_Backup_${safeCatLabel}_${dateStr}.json`;

    // 統一使用 Blob 下載（避免 iOS Chrome / Safari 因 data: URL 過長導致截斷或抓到舊快取）
    const blob = new Blob([dataStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 延長至 10 秒再釋放 Blob，確保 iOS 下載管理器有足夠時間寫入檔案
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    if (typeof showToast === 'function') {
        showToast(safeT('toastDownloadSuccess', { count: wordsToExport.length }, `成功匯出 ${wordsToExport.length} 筆單字備份`), 'success');
    }
}


/**
 * 📥 匯入 JSON 備份（完整還原所有 FSRS 排程、記憶穩定度、遺忘次數與自由練習等級）
 */
function handleImportJSON() {
    const fileInput = document.getElementById('jsonFileInput');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        if (typeof showToast === 'function') showToast(safeT('toastSelectJsonFirst', null, '請先選擇要匯入的 JSON 檔案！'), "warning");
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async function (e) {
        try {
            const importedData = JSON.parse(e.target.result);
            if (!Array.isArray(importedData)) {
                if (typeof showToast === 'function') showToast(safeT('toastJsonFormatError', null, 'JSON 檔案格式不正確！'), "error");
                return;
            }

            const defaultCatName = safeT('defaultCategoryName', null, '預設字庫');
            let addedCount = 0;
            let replacedCount = 0;

            importedData.forEach(item => {
                if (item && item.word) {
                    const itemCat = String(item.category || defaultCatName).trim() || defaultCatName;
                    const itemWord = String(item.word).trim().replace(/\s+/g, ' ');
                    const normWord = normalizeWordKey(itemWord);
                    if (!normWord) return;

                    const importedCard = {
                        id: (typeof generateDeterministicCardId === 'function')
                            ? generateDeterministicCardId(itemCat, itemWord)
                            : (item.id || ('w_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))),
                        deckId: (typeof generateDeterministicDeckId === 'function')
                            ? generateDeterministicDeckId(itemCat)
                            : item.deckId,
                        category: itemCat,
                        word: itemWord,
                        pos: String(item.pos || '').trim(),
                        phonetic: String(item.phonetic || '').trim(),
                        meaning: String(item.meaning || safeT('noMeaning', null, '無釋義')).trim(),
                        sentence: String(item.sentence || '').trim(),
                        translation: String(item.translation || '').trim(),
                        level: Number(item.level) || 1,
                        knowStreak: Number(item.knowStreak) || 0,
                        state: item.state || undefined,
                        stability: typeof item.stability === 'number' ? item.stability : undefined,
                        difficulty: typeof item.difficulty === 'number' ? item.difficulty : undefined,
                        reps: typeof item.reps === 'number' ? item.reps : undefined,
                        lapses: typeof item.lapses === 'number' ? item.lapses : undefined,
                        lastReview: typeof item.lastReview === 'number' ? item.lastReview : undefined,
                        nextReview: typeof item.nextReview === 'number' ? item.nextReview : undefined,
                        freeLevel: Number(item.freeLevel) || 1,
                        freeStreak: Number(item.freeStreak) || 0,
                        updatedAt: Date.now()
                    };

                    if (typeof migrateCardFSRS === 'function') {
                        migrateCardFSRS(importedCard);
                    }

                    const existingIndex = wordList.findIndex(w => 
                        (w.category || defaultCatName).trim().toLowerCase() === itemCat.toLowerCase() &&
                        normalizeWordKey(w.word) === normWord
                    );

                    if (existingIndex !== -1) {
                        const existingItem = wordList[existingIndex];
                        wordList.splice(existingIndex, 1);
                        wordList.unshift(mergeDuplicateWordRecord(existingItem, importedCard, true));
                        replacedCount++;
                    } else {
                        wordList.unshift(importedCard);
                    }
                    addedCount++;
                }
            });

            autoDeduplicateWordList({ silent: true });

            if (typeof saveStorage === 'function') await saveStorage();
            if (typeof updateCategorySelects === 'function') updateCategorySelects();
            if (typeof updateUI === 'function') updateUI();
            if (!currentCard && typeof nextCard === 'function') nextCard();

            if (typeof closeModal === 'function') closeModal('backupModal');
            fileInput.value = '';

            const netUniqueAdded = addedCount - replacedCount;
            const msg = replacedCount > 0 
                ? safeT('toastImportSuccessDeDup', { count: addedCount, dedup: replacedCount, actual: netUniqueAdded }, `成功匯入 ${addedCount} 個單字（自動合併 ${replacedCount} 筆重複單字）`)
                : safeT('toastImportSuccess', { count: addedCount }, `成功匯入 ${addedCount} 個單字`);

            if (typeof showToast === 'function') showToast(msg, "success");

        } catch (err) {
            console.error("JSON 解析失敗:", err);
            if (typeof showToast === 'function') showToast(safeT('toastJsonParseError', null, 'JSON 檔案解析失敗'), "error");
        }
    };

    reader.readAsText(file);
}

// 🔗 全向點擊導向別名綁定
const handleBatchMoveCategory = handleBatchChangeCategory;
const handleBatchDelete = handleBatchDeleteWords;
const handleBatchAiFill = handleBatchAiFillLibraryWords;
const handleExportJSON = exportJSON;
const handleSplitCategory = handleConfirmSplitDeck;
const handleRemoveDuplicateWords = () => autoDeduplicateWordList({ silent: false });

// =========================================================================
// ✨ 批量匯入左上角 ☰ AI 自由格式文字與多圖辨識解析器
// =========================================================================
let batchAiParserImages = [];

function resetBatchAiParserState() {
    batchAiParserImages = [];
    const drawer = document.getElementById('batchAiParserDrawer');
    if (drawer) drawer.classList.add('hidden');
    const rawTextEl = document.getElementById('batchAiRawTextInput');
    if (rawTextEl) rawTextEl.value = '';
    const promptEl = document.getElementById('batchAiPromptInput');
    if (promptEl) promptEl.value = '';
    const fileEl = document.getElementById('batchAiImageInput');
    if (fileEl) fileEl.value = '';
    renderBatchAiImageList();
}

function toggleBatchAiParserDrawer(forceState) {
    const drawer = document.getElementById('batchAiParserDrawer');
    if (!drawer) return;
    const willOpen = typeof forceState === 'boolean' ? forceState : drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', !willOpen);

    if (willOpen) {
        const mainInput = document.getElementById('batchRawInput');
        const aiTextInput = document.getElementById('batchAiRawTextInput');
        if (aiTextInput && !aiTextInput.value.trim() && mainInput && mainInput.value.trim()) {
            aiTextInput.value = mainInput.value.trim();
        }
    }
}

function renderBatchAiImageList() {
    const listEl = document.getElementById('batchAiImageList');
    if (!listEl) return;
    if (!batchAiParserImages.length) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        return;
    }
    listEl.classList.remove('hidden');
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    listEl.innerHTML = batchAiParserImages.map((img, idx) => `
        <div class="relative w-16 h-16 rounded-xl overflow-hidden border border-brand-200 dark:border-slate-600 bg-white dark:bg-slate-800 shrink-0 shadow-xs">
            <img src="${esc(img.dataUrl)}" alt="${esc(img.name)}" class="w-full h-full object-cover" />
            <button type="button" onclick="removeBatchAiParserImage(${idx})" aria-label="移除圖片"
                class="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center shadow">
                ✕
            </button>
        </div>
    `).join('');
}

function removeBatchAiParserImage(idx) {
    batchAiParserImages.splice(idx, 1);
    renderBatchAiImageList();
}

function compressImageFileToPayload(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('讀取圖片失敗'));
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const img = new Image();
            img.onload = () => {
                try {
                    const maxDim = 1400;
                    let w = img.width || 1024;
                    let h = img.height || 1024;
                    if (w > maxDim || h > maxDim) {
                        if (w >= h) {
                            h = Math.round((h * maxDim) / w);
                            w = maxDim;
                        } else {
                            w = Math.round((w * maxDim) / h);
                            h = maxDim;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    const outDataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    const base64 = outDataUrl.split(',')[1] || '';
                    resolve({
                        name: file.name || 'image.jpg',
                        mimeType: 'image/jpeg',
                        dataUrl: outDataUrl,
                        base64
                    });
                } catch (err) {
                    const base64 = dataUrl.split(',')[1] || '';
                    resolve({
                        name: file.name || 'image',
                        mimeType: file.type || 'image/jpeg',
                        dataUrl,
                        base64
                    });
                }
            };
            img.onerror = () => {
                const base64 = dataUrl.split(',')[1] || '';
                resolve({
                    name: file.name || 'image',
                    mimeType: file.type || 'image/jpeg',
                    dataUrl,
                    base64
                });
            };
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    });
}

async function handleBatchAiParserFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && /^image\//i.test(f.type || 'image/'));
    if (!files.length) return;
    const remainingSlots = Math.max(0, 4 - batchAiParserImages.length);
    if (remainingSlots <= 0) {
        if (typeof showToast === 'function') showToast('最多可同時上傳 4 張圖片', 'warning');
        return;
    }
    for (const file of files.slice(0, remainingSlots)) {
        try {
            const payload = await compressImageFileToPayload(file);
            if (payload && payload.base64) {
                batchAiParserImages.push(payload);
            }
        } catch (e) {}
    }
    renderBatchAiImageList();
}

async function runBatchAiFreeParser() {
    const rawTextEl = document.getElementById('batchAiRawTextInput');
    const mainRawEl = document.getElementById('batchRawInput');
    const promptEl = document.getElementById('batchAiPromptInput');
    const runBtn = document.getElementById('batchAiRunParserBtn');

    const rawText = String((rawTextEl && rawTextEl.value) || (mainRawEl && mainRawEl.value) || '').trim();
    const customPrompt = String((promptEl && promptEl.value) || '').trim();
    const hasImages = batchAiParserImages.length > 0;

    if (!rawText && !hasImages) {
        if (typeof showToast === 'function') showToast('請先輸入任意文字或上傳圖片', 'warning');
        return;
    }

    if (typeof callGeminiApi !== 'function') {
        if (typeof showToast === 'function') showToast('雲端 AI 服務尚未載入', 'error');
        return;
    }

    const feature = hasImages ? 'vision_ocr' : 'def_fill';
    if (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.canConsumeAiQuota === 'function') {
        const q = MembershipEngine.canConsumeAiQuota(feature);
        if (!q.allowed) {
            if (typeof MembershipEngine.showQuotaUpgradePrompt === 'function') {
                MembershipEngine.showQuotaUpgradePrompt(feature);
            } else if (typeof showToast === 'function') {
                showToast('雲端 AI 額度不足或需升級方案！', 'warning');
            }
            return;
        }
    }

    const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
    const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
    const effectiveTargetLang = targetLang === 'custom' ? 'en' : targetLang;

    const systemInstruction = `你是專業語言單字卡整理助理。
目標學習語言代碼：${effectiveTargetLang}（若為 custom 則以英文為主）
使用者母語代碼：${nativeLang}
${customPrompt ? `使用者額外提示詞要求：${customPrompt}\n` : ''}
請從使用者提供的文字或圖片中擷取所有重點單字或片語（例如使用者可能要求僅摘錄選項中的單字，請務必遵照提示詞要求），並嚴格只回傳純 JSON 陣列（不要加上 \`\`\`json 標記或任何解說文字），每個元素格式如下：
[
  {
    "word": "目標單字或片語",
    "meaning": "母語釋義（若原文已有則保留或翻譯，沒有可協助簡潔補上）",
    "pos": "詞性縮寫（如 n. / v. / adj. / adv. / phr.）",
    "phonetic": "音標或讀音（如 [ˈhæpɪ] 或平假名，若無可簡潔補上或留空字串）",
    "sentence": "目標語言自然例句（若無可補一句或留空字串）",
    "translation": "該例句的母語翻譯（若無可補或留空字串）"
  }
]`;

    const fullPrompt = rawText
        ? `${systemInstruction}\n\n【待解析內容】：\n${rawText}`
        : `${systemInstruction}\n\n請解析所附圖片內容。`;

    const origHtml = runBtn ? runBtn.innerHTML : '';
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i> ✨ AI 解析中...`;
    }

    try {
        const inlineDataList = batchAiParserImages.map(img => ({
            mimeType: img.mimeType || 'image/jpeg',
            data: img.base64
        }));

        const aiRaw = await callGeminiApi(fullPrompt, {
            feature,
            inlineDataList
        });

        let parsed = null;
        if (typeof safeParseJSON === 'function') {
            parsed = safeParseJSON(aiRaw);
        } else {
            const m = String(aiRaw || '').match(/\[[\s\S]*\]/);
            if (m) parsed = JSON.parse(m[0]);
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('AI 未能辨識出有效的單字項目');
        }

        const deduped = [];
        const seen = new Set();
        parsed.forEach(item => {
            if (!item || !item.word) return;
            const cleanWord = String(item.word).trim().replace(/\s+/g, ' ');
            const key = normalizeWordKey(cleanWord);
            if (!key || seen.has(key)) return;
            seen.add(key);
            deduped.push({
                word: cleanWord,
                pos: String(item.pos || '').trim(),
                phonetic: String(item.phonetic || '').trim(),
                meaning: String(item.meaning || '').trim(),
                sentence: String(item.sentence || '').trim(),
                translation: String(item.translation || '').trim()
            });
        });

        if (deduped.length === 0) {
            throw new Error('辨識結果為空');
        }

        window.parsedBatchList = deduped;
        renderBatchPreview();
        toggleBatchAiParserDrawer(false);
        if (typeof showToast === 'function') {
            showToast(`✨ AI 成功擷取 ${deduped.length} 筆單字進入預覽清單！`, 'success');
        }
    } catch (err) {
        console.error('[Batch AI Free Parser Error]:', err);
        if (typeof showToast === 'function') {
            showToast(`✨ AI 解析失敗：${err.message}`, 'error');
        }
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = origHtml;
        }
    }
}

if (typeof window !== 'undefined') {
    window.parseBatchText = parseBatchText;
    window.resetBatchAiParserState = resetBatchAiParserState;
    window.toggleBatchAiParserDrawer = toggleBatchAiParserDrawer;
    window.removeBatchAiParserImage = removeBatchAiParserImage;
    window.handleBatchAiParserFiles = handleBatchAiParserFiles;
    window.runBatchAiFreeParser = runBatchAiFreeParser;
}

