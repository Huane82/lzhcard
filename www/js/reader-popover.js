/**
 * 📖 共用文章點擊單字即時翻譯元件 (js/reader-popover.js)
 * Phase 1 基礎元件：支援文章斷詞、三層快取查詢（wordList -> LocalIDB -> sessionStorage -> AI）與一鍵加入字庫
 */
(function (global) {
    'use strict';

    const IDB_DICT_KEY = 'lzhcard_reader_dict_v1';
    const SESSION_DICT_KEY = 'lzhcard_reader_session_v1';

    const state = {
        idbCache: null,
        idbLoaded: false,
        idbLoadPromise: null,
        inFlightLookups: new Map(),
        activeAnchorEl: null,
        activeLookupToken: 0,
        activeWordData: null,
        delegatedBound: false
    };

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeLookupKey(rawWord) {
        if (!rawWord) return '';
        return String(rawWord)
            .trim()
            .replace(/^[“"‘'(`\[{]+|[”"’')`\]}.,!?;:]+$/g, '')
            .replace(/’/g, "'")
            .toLowerCase();
    }

    /**
     * 🔍 取得候選原型（詞幹還原，結合 VOCAB_7000_DATA 與常見屈折變化）
     */
    function getCandidateLemmas(rawWord) {
        const clean = normalizeLookupKey(rawWord);
        if (!clean) return [];

        const candidates = [clean];
        const add = (w) => {
            if (w && w.length >= 2 && !candidates.includes(w)) candidates.push(w);
        };

        // 處理所有格 / 縮寫
        if (clean.endsWith("'s") || clean.endsWith("’s")) {
            add(clean.slice(0, -2));
        } else if (clean.endsWith("n't")) {
            const base = clean.slice(0, -3);
            if (base === 'ca') add('can');
            else if (base === 'wo') add('will');
            else if (base === 'sha') add('shall');
            else add(base);
        } else if (clean.includes("'")) {
            add(clean.split("'")[0]);
        }

        // 常見不規則詞快速表
        const irregularMap = {
            went: 'go', gone: 'go', goes: 'go', going: 'go',
            saw: 'see', seen: 'see',
            did: 'do', done: 'do', does: 'do',
            was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
            had: 'have', has: 'have', having: 'have',
            made: 'make', making: 'make',
            took: 'take', taken: 'take', taking: 'take',
            gave: 'give', given: 'give', giving: 'give',
            got: 'get', gotten: 'get', getting: 'get',
            came: 'come', coming: 'come',
            knew: 'know', known: 'know',
            thought: 'think',
            brought: 'bring',
            bought: 'buy',
            caught: 'catch',
            taught: 'teach',
            fought: 'fight',
            sought: 'seek',
            found: 'find',
            told: 'tell',
            sold: 'sell',
            felt: 'feel',
            kept: 'keep',
            left: 'leave',
            lost: 'lose',
            met: 'meet',
            paid: 'pay',
            said: 'say',
            sent: 'send',
            spent: 'spend',
            built: 'build',
            wrote: 'write', written: 'write', writing: 'write',
            spoke: 'speak', spoken: 'speak',
            broke: 'break', broken: 'break',
            chose: 'choose', chosen: 'choose',
            drove: 'drive', driven: 'drive',
            ate: 'eat', eaten: 'eat',
            fell: 'fall', fallen: 'fall',
            flew: 'fly', flown: 'fly',
            forgot: 'forget', forgotten: 'forget',
            grew: 'grow', grown: 'grow',
            held: 'hold',
            ran: 'run', running: 'run',
            sat: 'sit', sitting: 'sit',
            stood: 'stand',
            understood: 'understand',
            wore: 'wear', worn: 'wear',
            won: 'win', winning: 'win',
            children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse',
            better: 'good', best: 'good', worse: 'bad', worst: 'bad'
        };
        if (irregularMap[clean]) add(irregularMap[clean]);

        // 規則字尾還原
        if (clean.endsWith('ies') && clean.length > 4) add(clean.slice(0, -3) + 'y');
        if (clean.endsWith('es') && clean.length > 4) {
            add(clean.slice(0, -2));
            add(clean.slice(0, -1));
        }
        if (clean.endsWith('s') && clean.length > 3 && !clean.endsWith('ss')) add(clean.slice(0, -1));

        if (clean.endsWith('ied') && clean.length > 4) add(clean.slice(0, -3) + 'y');
        if (clean.endsWith('ed') && clean.length > 4) {
            const stem = clean.slice(0, -2);
            add(stem);
            add(stem + 'e');
            if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
                add(stem.slice(0, -1));
            }
        }

        if (clean.endsWith('ing') && clean.length > 5) {
            const stem = clean.slice(0, -3);
            add(stem);
            add(stem + 'e');
            if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
                add(stem.slice(0, -1));
            }
        }

        if (clean.endsWith('ier') && clean.length > 4) add(clean.slice(0, -3) + 'y');
        if (clean.endsWith('er') && clean.length > 4) {
            const stem = clean.slice(0, -2);
            add(stem);
            add(stem + 'e');
        }
        if (clean.endsWith('iest') && clean.length > 5) add(clean.slice(0, -4) + 'y');
        if (clean.endsWith('est') && clean.length > 5) {
            const stem = clean.slice(0, -3);
            add(stem);
            add(stem + 'e');
        }
        if (clean.endsWith('ly') && clean.length > 4) {
            add(clean.slice(0, -2));
            if (clean.endsWith('ily')) add(clean.slice(0, -3) + 'y');
        }

        return candidates;
    }

    /**
     * ✂️ Tokenizer：將英文文章包成可點擊的 <span class="reader-token">，完整保留標點與換行排版
     */
    function tokenizeEnglishText(text, options = {}) {
        if (!text) return '';
        const str = String(text);
        const excludeSet = new Set(
            Array.isArray(options.excludeWords)
                ? options.excludeWords.map(w => String(w || '').trim().toLowerCase()).filter(Boolean)
                : []
        );

        // 匹配英文單字（支援內部撇號或連字號，如 don't, well-known），保留所有空白、CJK 與標點
        const tokenRegex = /([A-Za-z]+(?:[’'\-][A-Za-z]+)*)/g;
        let result = '';
        let lastIndex = 0;
        let match;

        while ((match = tokenRegex.exec(str)) !== null) {
            if (match.index > lastIndex) {
                result += escapeHtml(str.slice(lastIndex, match.index));
            }
            const rawToken = match[0];
            const norm = normalizeLookupKey(rawToken);
            if (!norm || excludeSet.has(norm)) {
                result += escapeHtml(rawToken);
            } else {
                const safeWord = escapeHtml(rawToken);
                const safeAttr = escapeHtml(norm);
                result += `<span class="reader-token" data-word="${safeAttr}" data-surface="${safeWord}" role="button" tabindex="0">${safeWord}</span>`;
            }
            lastIndex = tokenRegex.lastIndex;
        }

        if (lastIndex < str.length) {
            result += escapeHtml(str.slice(lastIndex));
        }

        return result;
    }

    function resolveDiffInfoForWord(wordOrLemma) {
        if (typeof global.getWordDifficultyInfo !== 'function') {
            return { level: 0, tag: '冷門', shortLabel: '冷門單字', color: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' };
        }
        const candidates = getCandidateLemmas(wordOrLemma);
        for (const c of candidates) {
            const info = global.getWordDifficultyInfo(c);
            if (info && info.level > 0) return info;
        }
        return global.getWordDifficultyInfo(wordOrLemma);
    }

    function isMeaningUsable(meaning) {
        if (!meaning) return false;
        const m = String(meaning).trim();
        if (!m) return false;
        const badList = ['未設定釋義', '解析中', '自動解析中', '無釋義', '無母語釋義', 'no definition', 'pending'];
        return !badList.some(b => m.toLowerCase().includes(b));
    }

    /**
     * 1️⃣ Layer 1: 本機字庫 wordList 查詢
     */
    function lookupInWordList(rawWord) {
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList))
            ? wordList
            : (Array.isArray(global.wordList) ? global.wordList : []);
        if (list.length === 0) return null;

        const candidates = getCandidateLemmas(rawWord);
        if (candidates.length === 0) return null;

        for (const candidate of candidates) {
            const matched = list.find(card => {
                if (!card || !card.word) return false;
                if (typeof global.isCardMatchingTargetLang === 'function' && !global.isCardMatchingTargetLang(card, 'en')) {
                    return false;
                }
                return card.word.trim().toLowerCase() === candidate;
            });
            if (matched && isMeaningUsable(matched.meaning)) {
                const diffInfo = resolveDiffInfoForWord(matched.word);
                return {
                    word: normalizeLookupKey(rawWord),
                    lemma: matched.word.trim(),
                    phonetic: (matched.phonetic || '').trim(),
                    pos: (matched.pos || '').trim(),
                    meaning: (matched.meaning || '').trim(),
                    diffLevel: typeof matched.diffLevel === 'number' ? matched.diffLevel : diffInfo.level,
                    diffInfo,
                    inDeck: true,
                    deckName: matched.category || '預設字庫',
                    source: 'wordList'
                };
            }
        }
        return null;
    }

    /**
     * 2️⃣ Layer 2: IndexedDB 離線字典快取
     */
    async function ensureIdbCacheLoaded() {
        if (state.idbLoaded && state.idbCache) return state.idbCache;
        if (state.idbLoadPromise) return state.idbLoadPromise;

        state.idbLoadPromise = (async () => {
            let loaded = {};
            try {
                if (typeof LocalIDB !== 'undefined' && LocalIDB && typeof LocalIDB.get === 'function') {
                    const data = await LocalIDB.get(IDB_DICT_KEY);
                    if (data && typeof data === 'object') {
                        loaded = data;
                    }
                }
            } catch (e) {}
            state.idbCache = loaded;
            state.idbLoaded = true;
            state.idbLoadPromise = null;
            return state.idbCache;
        })();

        return state.idbLoadPromise;
    }

    async function writeIdbEntry(key, entry) {
        if (!key || !entry) return;
        const cache = await ensureIdbCacheLoaded();
        cache[key] = entry;
        try {
            if (typeof LocalIDB !== 'undefined' && LocalIDB && typeof LocalIDB.set === 'function') {
                await LocalIDB.set(IDB_DICT_KEY, cache);
            }
        } catch (e) {}
    }

    async function lookupInIdb(rawWord) {
        const cache = await ensureIdbCacheLoaded();
        const candidates = getCandidateLemmas(rawWord);
        for (const candidate of candidates) {
            const hit = cache[candidate];
            if (hit && isMeaningUsable(hit.meaning)) {
                const diffInfo = resolveDiffInfoForWord(hit.lemma || candidate);
                return {
                    ...hit,
                    word: normalizeLookupKey(rawWord),
                    lemma: hit.lemma || candidate,
                    diffLevel: diffInfo.level,
                    diffInfo,
                    inDeck: isWordInDeck(hit.lemma || candidate),
                    source: 'idb'
                };
            }
        }
        return null;
    }

    /**
     * 3️⃣ Layer 3: sessionStorage 單次工作階段快取
     */
    function readSessionDict() {
        try {
            if (typeof sessionStorage === 'undefined') return {};
            const raw = sessionStorage.getItem(SESSION_DICT_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writeSessionEntry(key, entry) {
        try {
            if (typeof sessionStorage === 'undefined' || !key || !entry) return;
            const dict = readSessionDict();
            dict[key] = entry;
            sessionStorage.setItem(SESSION_DICT_KEY, JSON.stringify(dict));
        } catch (e) {}
    }

    function lookupInSession(rawWord) {
        const dict = readSessionDict();
        const candidates = getCandidateLemmas(rawWord);
        for (const candidate of candidates) {
            const hit = dict[candidate];
            if (hit && isMeaningUsable(hit.meaning)) {
                const diffInfo = resolveDiffInfoForWord(hit.lemma || candidate);
                return {
                    ...hit,
                    word: normalizeLookupKey(rawWord),
                    lemma: hit.lemma || candidate,
                    diffLevel: diffInfo.level,
                    diffInfo,
                    inDeck: isWordInDeck(hit.lemma || candidate),
                    source: 'session'
                };
            }
        }
        return null;
    }

    function isWordInDeck(wordStr) {
        const target = normalizeLookupKey(wordStr);
        if (!target) return false;
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList))
            ? wordList
            : (Array.isArray(global.wordList) ? global.wordList : []);
        const candidates = getCandidateLemmas(target);
        return list.some(w => {
            if (!w || !w.word) return false;
            if (typeof global.isCardMatchingTargetLang === 'function' && !global.isCardMatchingTargetLang(w, 'en')) {
                return false;
            }
            return candidates.includes(w.word.trim().toLowerCase());
        });
    }

    function getReaderNativeLangCode() {
        try {
            if (typeof localStorage !== 'undefined') {
                const nl = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
                if (nl === 'ja') return 'ja';
                if (nl === 'en') return 'en';
                if (nl === 'zh' || nl === 'zh-TW') return 'zh-TW';
            }
        } catch (e) {}
        return 'zh-TW';
    }

    function mapPosToAbbrev(posRaw) {
        const p = String(posRaw || '').trim().toLowerCase();
        if (!p) return '';
        const map = {
            noun: 'n.',
            verb: 'v.',
            adjective: 'adj.',
            adverb: 'adv.',
            preposition: 'prep.',
            conjunction: 'conj.',
            pronoun: 'pron.',
            interjection: 'int.',
            determiner: 'det.',
            article: 'art.',
            auxiliary: 'aux.',
            exclamation: 'int.'
        };
        return map[p] || (p.length <= 6 ? p : p.slice(0, 4) + '.');
    }

    /**
     * 🌐 公開免費字典＋翻譯備援（完全無需 API Key，確保字庫外任意單字皆可翻譯）
     */
    async function fetchWordMeaningViaPublicDict(clean) {
        if (typeof fetch !== 'function') {
            throw new Error('環境不支援網路查字');
        }

        const nativeCode = getReaderNativeLangCode();
        const gtxTarget = nativeCode === 'ja' ? 'ja' : 'zh-TW';
        const candidates = getCandidateLemmas(clean);
        const dictQueryWord = candidates.find(c => /^[a-z]+(?:-[a-z]+)*$/.test(c)) || clean;

        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(gtxTarget)}&dt=t&dt=bd&q=${encodeURIComponent(clean)}`;
        const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(dictQueryWord)}`;

        const [gtxSettled, dictSettled] = await Promise.allSettled([
            fetch(gtxUrl).then(r => (r.ok ? r.json() : Promise.reject(new Error('GTX ' + r.status)))),
            fetch(dictUrl).then(r => (r.ok ? r.json() : Promise.reject(new Error('DICT ' + r.status))))
        ]);

        let meaning = '';
        let pos = '';
        let phonetic = '';
        let lemma = clean;

        if (dictSettled.status === 'fulfilled' && Array.isArray(dictSettled.value) && dictSettled.value[0]) {
            const firstEntry = dictSettled.value[0];
            if (firstEntry.word) lemma = normalizeLookupKey(firstEntry.word) || clean;
            if (firstEntry.phonetic) {
                phonetic = String(firstEntry.phonetic).trim();
            } else if (Array.isArray(firstEntry.phonetics)) {
                const ph = firstEntry.phonetics.find(x => x && x.text);
                if (ph && ph.text) phonetic = String(ph.text).trim();
            }
            if (Array.isArray(firstEntry.meanings) && firstEntry.meanings[0] && firstEntry.meanings[0].partOfSpeech) {
                pos = mapPosToAbbrev(firstEntry.meanings[0].partOfSpeech);
            }
        }

        if (gtxSettled.status === 'fulfilled' && Array.isArray(gtxSettled.value)) {
            const gtxData = gtxSettled.value;
            // dt=bd（詞典釋義陣列）優先，能取得精確詞性與多義項
            if (Array.isArray(gtxData[1]) && gtxData[1].length > 0) {
                const firstDictGroup = gtxData[1][0];
                if (!pos && firstDictGroup && firstDictGroup[0]) {
                    pos = mapPosToAbbrev(firstDictGroup[0]);
                }
                const terms = Array.isArray(firstDictGroup && firstDictGroup[1]) ? firstDictGroup[1] : [];
                if (terms.length > 0) {
                    meaning = terms.slice(0, 3).join('、');
                }
            }
            // dt=t（整詞翻譯）
            if (!meaning && Array.isArray(gtxData[0])) {
                const translatedParts = gtxData[0]
                    .map(seg => (Array.isArray(seg) && seg[0] ? String(seg[0]).trim() : ''))
                    .filter(Boolean);
                if (translatedParts.length > 0) {
                    meaning = translatedParts.join('');
                }
            }
        }

        // 若 Google Translate 端點不可用，備援 MyMemory 公開翻譯 API
        if (!meaning || meaning.toLowerCase() === clean) {
            try {
                const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|${encodeURIComponent(gtxTarget)}`;
                const mmRes = await fetch(mmUrl);
                if (mmRes.ok) {
                    const mmJson = await mmRes.json();
                    const mmText = mmJson && mmJson.responseData && mmJson.responseData.translatedText
                        ? String(mmJson.responseData.translatedText).trim()
                        : '';
                    if (mmText && mmText.toLowerCase() !== clean) {
                        meaning = mmText;
                    }
                }
            } catch (mmErr) {}
        }

        // 若目標母語為英文且有 dictionaryapi 英文定義
        if (!meaning && nativeCode === 'en' && dictSettled.status === 'fulfilled' && Array.isArray(dictSettled.value) && dictSettled.value[0]) {
            const m0 = dictSettled.value[0].meanings && dictSettled.value[0].meanings[0];
            const d0 = m0 && m0.definitions && m0.definitions[0] && m0.definitions[0].definition;
            if (d0) meaning = String(d0).trim();
        }

        if (!meaning) {
            throw new Error('查無此字庫外單字釋義，請確認網路連線');
        }

        return {
            lemma: lemma || clean,
            pos,
            phonetic,
            meaning,
            source: 'dict'
        };
    }

    /**
     * 4️⃣ Layer 4: 字庫外單字解析（靜默 AI 查詢優先 + 免金鑰公開字典翻譯備援）
     */
    async function fetchWordMeaningViaAI(rawWord) {
        const clean = normalizeLookupKey(rawWord);
        if (!clean) throw new Error('Invalid word');

        if (state.inFlightLookups.has(clean)) {
            return state.inFlightLookups.get(clean);
        }

        const task = (async () => {
            const nativeCode = getReaderNativeLangCode();
            const nativeLabel = nativeCode === 'ja'
                ? 'Japanese (日本語)'
                : (nativeCode === 'en' ? 'concise English' : 'Traditional Chinese (繁體中文)');

            let resolved = null;

            if (typeof callGeminiApi === 'function') {
                const prompt = `You are a concise bilingual dictionary.
Analyze the English word: "${clean}"
Target explanation language: ${nativeLabel}
Return ONLY a single JSON object (no markdown, no explanation):
{
  "lemma": "base dictionary form in lowercase (e.g. running -> run; children -> child)",
  "pos": "concise abbreviation e.g. n. / v. / adj. / adv.",
  "phonetic": "IPA phonetic notation like /rʌn/",
  "meaning": "concise meaning in ${nativeLabel} (max 25 chars)"
}`;
                try {
                    const rawText = await callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
                    const parsed = (typeof safeParseJSON === 'function') ? safeParseJSON(rawText) : JSON.parse(rawText);
                    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
                    if (obj && isMeaningUsable(obj.meaning)) {
                        resolved = {
                            lemma: normalizeLookupKey(obj.lemma || clean) || clean,
                            pos: String(obj.pos || '').trim(),
                            phonetic: String(obj.phonetic || '').trim(),
                            meaning: String(obj.meaning || '').trim(),
                            source: 'ai'
                        };
                    }
                } catch (aiErr) {
                    // AI 失敗（無 Key、限流或 Proxy 異常）時靜默降級至公開字典翻譯，確保字庫外單字仍可翻譯
                    console.warn('[ReaderPopover] AI 查字降級至公開字典備援:', aiErr && aiErr.message ? aiErr.message : aiErr);
                }
            }

            if (!resolved) {
                resolved = await fetchWordMeaningViaPublicDict(clean);
            }

            const lemma = normalizeLookupKey(resolved.lemma || clean) || clean;
            const entry = {
                lemma,
                pos: resolved.pos || '',
                phonetic: resolved.phonetic || '',
                meaning: resolved.meaning,
                cachedAt: Date.now()
            };

            // 寫入雙層快取避免重複呼叫
            writeSessionEntry(clean, entry);
            if (lemma !== clean) writeSessionEntry(lemma, entry);
            await writeIdbEntry(clean, entry);
            if (lemma !== clean) await writeIdbEntry(lemma, entry);

            const diffInfo = resolveDiffInfoForWord(lemma);
            return {
                word: clean,
                lemma,
                phonetic: entry.phonetic,
                pos: entry.pos,
                meaning: entry.meaning,
                diffLevel: diffInfo.level,
                diffInfo,
                inDeck: isWordInDeck(lemma),
                source: resolved.source || 'ai'
            };
        })();

        state.inFlightLookups.set(clean, task);
        try {
            return await task;
        } finally {
            state.inFlightLookups.delete(clean);
        }
    }

    /**
     * 🌐 三層本機快取優先查詢主流程
     */
    async function lookupReaderWord(rawWord) {
        const clean = normalizeLookupKey(rawWord);
        if (!clean) return null;

        // 1. wordList
        const hitList = lookupInWordList(clean);
        if (hitList) return hitList;

        // 2. IndexedDB
        const hitIdb = await lookupInIdb(clean);
        if (hitIdb) {
            writeSessionEntry(clean, hitIdb);
            return hitIdb;
        }

        // 3. sessionStorage
        const hitSession = lookupInSession(clean);
        if (hitSession) return hitSession;

        // 4. AI On-demand fallback
        return await fetchWordMeaningViaAI(clean);
    }

    function getTargetAddCategoryName() {
        const defaultCat = (typeof t === 'function') ? t('defaultCategoryName') : '預設字庫';
        const safeDefault = (defaultCat && defaultCat !== 'defaultCategoryName') ? defaultCat : '預設字庫';
        const activeCats = Array.isArray(global.selectedCategories) ? global.selectedCategories : ['ALL'];
        const nonAll = activeCats.filter(c => c && c !== 'ALL');
        if (nonAll.length === 1) return nonAll[0];
        return safeDefault;
    }

    /**
     * ➕ 一鍵將查詢到的單字加入目前字庫
     */
    function addReaderWordToDeck(data) {
        if (!data || (!data.lemma && !data.word)) return { added: false, duplicate: false };
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList))
            ? wordList
            : (Array.isArray(global.wordList) ? global.wordList : null);
        if (!list) return { added: false, duplicate: false };

        const targetWord = String(data.lemma || data.word).trim();
        const normWord = targetWord.toLowerCase();
        const category = getTargetAddCategoryName();

        // 檢查同字庫是否已存在
        const existingInDeck = list.find(w =>
            w && w.word &&
            w.word.trim().toLowerCase() === normWord &&
            (w.category || '預設字庫').trim() === category.trim()
        );
        if (existingInDeck) {
            return { added: false, duplicate: true, card: existingInDeck, category };
        }

        const diffInfo = resolveDiffInfoForWord(targetWord);
        const now = Date.now();
        const detCardId = (typeof global.generateDeterministicCardId === 'function')
            ? global.generateDeterministicCardId(category, targetWord)
            : ('w_' + now + '_' + Math.random().toString(36).slice(2, 6));
        const detDeckId = (typeof global.generateDeterministicDeckId === 'function')
            ? global.generateDeterministicDeckId(category)
            : undefined;
        const newCard = {
            id: detCardId,
            deckId: detDeckId,
            category,
            lang: 'en',
            word: targetWord,
            pos: String(data.pos || '').trim(),
            phonetic: String(data.phonetic || '').trim(),
            meaning: String(data.meaning || '未設定釋義').trim(),
            sentence: '',
            translation: '',
            level: 1,
            knowStreak: 0,
            freeLevel: 1,
            freeStreak: 0,
            diffLevelManual: false,
            diffLevel: diffInfo ? diffInfo.level : 0,
            updatedAt: now
        };

        if (typeof global.migrateCardFSRS === 'function') {
            global.migrateCardFSRS(newCard);
        }

        list.unshift(newCard);
        if (typeof global.saveStorage === 'function') global.saveStorage();
        if (typeof global.updateCategorySelects === 'function') global.updateCategorySelects();
        if (typeof global.updateUI === 'function') global.updateUI();

        return { added: true, duplicate: false, card: newCard, category };
    }

    function speakReaderWord(wordText) {
        const text = String(wordText || '').trim();
        if (!text || typeof window === 'undefined') return;
        const lang = 'en-US';
        try {
            if (window.LZHAudioTts && typeof window.LZHAudioTts.speak === 'function') {
                window.LZHAudioTts.speak(text, lang).catch(() => {});
                return;
            }
            const capTTS = window.Capacitor?.Plugins?.TextToSpeech;
            if (typeof global.isNativeApp === 'function' && global.isNativeApp() && capTTS && typeof capTTS.speak === 'function') {
                capTTS.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: 'ambient' }).catch(() => {});
                return;
            }
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                u.lang = lang;
                window.speechSynthesis.speak(u);
            }
        } catch (e) {}
    }

    function ensurePopoverElement() {
        if (typeof document === 'undefined') return null;
        let pop = document.getElementById('readerTranslatePopover');
        if (pop) return pop;

        pop = document.createElement('div');
        pop.id = 'readerTranslatePopover';
        pop.className = 'hidden fixed z-[75] w-72 max-w-[calc(100vw-24px)] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl p-3.5 text-left transition-opacity duration-150';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', '即時單字查詢');
        document.body.appendChild(pop);
        return pop;
    }

    function positionPopover(pop, anchorEl) {
        if (!pop || !anchorEl || typeof window === 'undefined') return;
        const rect = anchorEl.getBoundingClientRect();
        const vw = window.innerWidth || 375;
        const vh = window.innerHeight || 667;
        const popW = pop.offsetWidth || 288;
        const popH = pop.offsetHeight || 160;
        const margin = 12;

        // 水平置中於點擊單字，並安全夾在螢幕邊界內
        let left = rect.left + rect.width / 2 - popW / 2;
        left = Math.max(margin, Math.min(vw - popW - margin, left));

        // 優先顯示在單字上方，空間不足（或靠近手機頂部瀏海區）則改顯示於下方
        let top = rect.top - popH - 10;
        if (top < 56) {
            top = Math.min(vh - popH - margin, rect.bottom + 10);
        }

        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(top)}px`;
    }

    function closeReaderPopover() {
        if (typeof document === 'undefined') return;
        const pop = document.getElementById('readerTranslatePopover');
        if (pop) pop.classList.add('hidden');
        if (state.activeAnchorEl) {
            state.activeAnchorEl.classList.remove('reader-token-active');
            state.activeAnchorEl = null;
        }
        state.activeWordData = null;
    }

    function renderPopoverLoading(pop, word) {
        pop.innerHTML = `
            <div class="flex items-center justify-between gap-2 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="font-extrabold text-base text-slate-900 dark:text-white truncate">${escapeHtml(word)}</span>
                </div>
                <button type="button" data-reader-close="1" class="w-6 h-6 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center text-xs">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="flex items-center gap-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                <i class="fa-solid fa-spinner fa-spin text-brand-500"></i>
                <span>正在檢索釋義...</span>
            </div>
        `;
    }

    function renderPopoverContent(pop, data) {
        state.activeWordData = data;
        const displayWord = data.lemma || data.word;
        const showLemmaNote = data.word && data.lemma && data.word.toLowerCase() !== data.lemma.toLowerCase();
        const diffInfo = data.diffInfo || resolveDiffInfoForWord(displayWord);
        const sourceLabelMap = {
            wordList: '本機字庫',
            idb: '離線字典快取',
            session: '工作階段快取',
            ai: 'AI 即時解析',
            dict: '即時字典翻譯'
        };
        const sourceLabel = sourceLabelMap[data.source] || '字典快取';

        const addBtnHtml = data.inDeck
            ? `<button type="button" disabled class="w-full py-1.5 px-3 rounded-lg text-xs font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center gap-1.5 cursor-default">
                    <i class="fa-solid fa-check"></i><span>已在字庫</span>
               </button>`
            : `<button type="button" id="readerPopoverAddBtn" class="w-full py-1.5 px-3 rounded-lg text-xs font-bold bg-brand-600 hover:bg-brand-700 text-white shadow-2xs transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-plus"></i><span>＋ 加入字庫</span>
               </button>`;

        pop.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <div class="flex items-center flex-wrap gap-1.5">
                        <span class="font-extrabold text-base text-slate-900 dark:text-white leading-tight">${escapeHtml(displayWord)}</span>
                        ${diffInfo && diffInfo.tag ? `<span class="text-[10px] px-1.5 py-0.5 rounded border font-bold ${diffInfo.color}">${escapeHtml(diffInfo.tag)}</span>` : ''}
                    </div>
                    ${showLemmaNote ? `<p class="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">原文形式：${escapeHtml(data.word)}</p>` : ''}
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" id="readerPopoverSpeakBtn" title="發音" class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 flex items-center justify-center text-xs transition">
                        <i class="fa-solid fa-volume-high"></i>
                    </button>
                    <button type="button" data-reader-close="1" title="關閉" class="w-7 h-7 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-center text-xs transition">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="mt-2 space-y-1">
                <div class="flex items-center flex-wrap gap-1.5 text-xs">
                    ${data.pos ? `<span class="px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 font-bold">${escapeHtml(data.pos)}</span>` : ''}
                    ${data.phonetic ? `<span class="font-mono text-slate-500 dark:text-slate-400">${escapeHtml(data.phonetic)}</span>` : ''}
                </div>
                <p class="text-sm font-bold text-slate-800 dark:text-slate-100 leading-snug pt-0.5">${escapeHtml(data.meaning)}</p>
            </div>
            <div class="mt-3 pt-2 border-t border-slate-100 dark:border-slate-700 space-y-2">
                ${addBtnHtml}
                <div class="flex items-center justify-between text-[10px] text-slate-400 dark:text-slate-500">
                    <span>來源：${escapeHtml(sourceLabel)}</span>
                    <span>加入目標：${escapeHtml(getTargetAddCategoryName())}</span>
                </div>
            </div>
        `;

        const speakBtn = pop.querySelector('#readerPopoverSpeakBtn');
        if (speakBtn) {
            speakBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                speakReaderWord(displayWord);
            });
        }

        const addBtn = pop.querySelector('#readerPopoverAddBtn');
        if (addBtn) {
            addBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const res = addReaderWordToDeck(data);
                if (res.added || res.duplicate) {
                    data.inDeck = true;
                    renderPopoverContent(pop, data);
                    if (typeof global.showToast === 'function') {
                        global.showToast(
                            res.added
                                ? `已將「${displayWord}」加入「${res.category}」`
                                : `「${displayWord}」已存在於「${res.category}」`,
                            res.added ? 'success' : 'info'
                        );
                    }
                }
            });
        }
    }

    function renderPopoverError(pop, word, errMsg) {
        pop.innerHTML = `
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <span class="font-extrabold text-base text-slate-900 dark:text-white">${escapeHtml(word)}</span>
                <button type="button" data-reader-close="1" class="w-6 h-6 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center text-xs">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <p class="text-xs text-rose-600 dark:text-rose-400 leading-relaxed">${escapeHtml(errMsg || '查詢失敗，請確認網路或 API 設定')}</p>
        `;
    }

    async function handleTokenActivate(tokenEl) {
        if (!tokenEl) return;
        const word = tokenEl.getAttribute('data-word') || tokenEl.textContent || '';
        const clean = normalizeLookupKey(word);
        if (!clean) return;

        const pop = ensurePopoverElement();
        if (!pop) return;

        if (state.activeAnchorEl && state.activeAnchorEl !== tokenEl) {
            state.activeAnchorEl.classList.remove('reader-token-active');
        }
        state.activeAnchorEl = tokenEl;
        tokenEl.classList.add('reader-token-active');

        const tokenId = ++state.activeLookupToken;
        pop.classList.remove('hidden');

        // 先檢查同步記憶體/字庫層，若命中可直接顯示免閃爍 loading
        const syncHit = lookupInWordList(clean) || lookupInSession(clean);
        if (syncHit) {
            renderPopoverContent(pop, syncHit);
            positionPopover(pop, tokenEl);
            return;
        }

        renderPopoverLoading(pop, clean);
        positionPopover(pop, tokenEl);

        try {
            const data = await lookupReaderWord(clean);
            if (tokenId !== state.activeLookupToken || pop.classList.contains('hidden')) return;
            if (data) {
                renderPopoverContent(pop, data);
                positionPopover(pop, tokenEl);
            } else {
                renderPopoverError(pop, clean, '查無單字釋義');
                positionPopover(pop, tokenEl);
            }
        } catch (err) {
            if (tokenId !== state.activeLookupToken || pop.classList.contains('hidden')) return;
            renderPopoverError(pop, clean, err && err.message ? err.message : '無法查詢此單字');
            positionPopover(pop, tokenEl);
        }
    }

    function initGlobalReaderDelegation() {
        if (typeof document === 'undefined' || state.delegatedBound) return;
        state.delegatedBound = true;

        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target) return;

            const closeBtn = target.closest ? target.closest('[data-reader-close]') : null;
            if (closeBtn) {
                e.stopPropagation();
                closeReaderPopover();
                return;
            }

            const tokenEl = target.closest ? target.closest('.reader-token') : null;
            if (tokenEl) {
                e.stopPropagation();
                handleTokenActivate(tokenEl);
                return;
            }

            const pop = document.getElementById('readerTranslatePopover');
            if (pop && !pop.classList.contains('hidden') && !pop.contains(target)) {
                closeReaderPopover();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeReaderPopover();
                return;
            }
            if ((e.key === 'Enter' || e.key === ' ') && document.activeElement && document.activeElement.classList.contains('reader-token')) {
                e.preventDefault();
                handleTokenActivate(document.activeElement);
            }
        });

        if (typeof window !== 'undefined') {
            window.addEventListener('resize', () => {
                const pop = document.getElementById('readerTranslatePopover');
                if (pop && !pop.classList.contains('hidden') && state.activeAnchorEl && document.body.contains(state.activeAnchorEl)) {
                    positionPopover(pop, state.activeAnchorEl);
                }
            });
        }
    }

    function bindReaderContainer(containerEl) {
        initGlobalReaderDelegation();
        if (!containerEl) return;
        containerEl.dataset.readerBound = '1';
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initGlobalReaderDelegation);
        } else {
            initGlobalReaderDelegation();
        }
    }

    const ReaderPopover = {
        tokenizeEnglishText,
        normalizeLookupKey,
        getCandidateLemmas,
        lookupReaderWord,
        lookupInWordList,
        lookupInIdb,
        lookupInSession,
        addReaderWordToDeck,
        bindReaderContainer,
        closeReaderPopover,
        speakReaderWord
    };

    if (typeof global !== 'undefined') {
        global.ReaderPopover = ReaderPopover;
        global.tokenizeEnglishText = tokenizeEnglishText;
        global.lookupReaderWord = lookupReaderWord;
        global.closeReaderPopover = closeReaderPopover;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ReaderPopover;
    }
})(typeof window !== 'undefined' ? window : globalThis);
