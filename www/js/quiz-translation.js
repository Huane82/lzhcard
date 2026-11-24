/**
 * LZHCard - 考試模式二：句構重組與連接詞／冠詞漸進提示翻譯測驗 (js/quiz-translation.js)
 * 1. 無英文句子預先劇透：載入即顯示中文原句與英文輸入框，隨時可直接輸入送出批改。
 * 2. 點擊或反白拖曳選取中文句子任意長度詞彙／成語／片語，即時顯示對應英文單字或搭配片語（如「轉變成」➔ turn A into B）。
 * 3. 提示 1（按鈕展開）：中文語序重組（依英文文法語序排列中文詞塊，非強制）。
 * 4. 提示 2（兩階段漸進按鈕，全程不顯示完整英文句子）：
 *    - 第一階段（按一次）：顯示正確語序的中文句子，讓玩家點擊選擇需補連接詞／冠詞的正確位置。
 *    - 第二階段（再按一次）：彈出連接詞／冠詞選擇題供玩家作答。
 * 5. AI 批改與結算僅更新對應字庫單字之 `freeLevel` 與 `freeStreak`，絕對不動 FSRS 排程欄位。
 */
(function (global) {
    'use strict';

    const PASS_SCORE = 70;

    // 📚 內建示範題庫（無字庫或離線備援時使用，涵蓋「轉變成 -> turn A into B」等大考高頻句構）
    const CURATED_QUESTIONS = [
        {
            id: 'curated_turn_into',
            targetWords: ['weakness', 'strength'],
            chineseOriginal: '透過持續努力，他成功將自己的弱點轉變成最大的優勢。',
            chineseChunks: ['他成功將自己的弱點', '持續努力', '轉變成最大的優勢'],
            correctOrder: [1, 0, 2],
            connectors: [
                {
                    id: 'conn_1',
                    slotIndex: 0,
                    type: '介系詞',
                    hintLabel: '開頭表「透過、藉由」的介系詞',
                    answer: 'Through',
                    options: ['Through', 'Although', 'Unless', 'Despite of'],
                    explanation: '後面為名詞片語「持續努力」(consistent effort)，需用介系詞 Through（透過）。'
                },
                {
                    id: 'conn_2',
                    slotIndex: 3,
                    type: '冠詞',
                    hintLabel: '最高級「最大的優勢」前的定冠詞',
                    answer: 'the',
                    options: ['the', 'a', 'an', 'which'],
                    explanation: '形容詞最高級 greatest strength 前通常需搭配定冠詞 the。'
                }
            ],
            phraseHints: [
                { zh: '透過', en: 'through / by means of', pos: 'prep.', note: '後接名詞或 V-ing，表示方式或手段' },
                { zh: '持續努力', en: 'consistent effort', pos: 'n. phr.', note: 'effort 表「努力」時常作不可數名詞' },
                { zh: '成功', en: 'succeed in / manage to', pos: 'v. phr.', note: 'succeed in + V-ing 或 manage to + 原形動詞' },
                { zh: '自己的弱點', en: 'his weakness', pos: 'n. phr.', note: 'weakness 指「弱點、缺點」' },
                { zh: '轉變成', en: 'turn A into B', pos: 'v. phr.', note: '核心片語：把 A 轉變成 B（亦可用 transform A into B）' },
                { zh: '最大的優勢', en: 'greatest strength', pos: 'n. phr.', note: 'strength 指「強項、優勢」' }
            ],
            sampleAnswer: 'Through consistent effort, he succeeded in turning his weakness into the greatest strength.',
            grammarFocus: 'Through + N（表手段）與 turn A into B（把 A 轉變成 B）搭配'
        },
        {
            id: 'curated_postpone',
            targetWords: ['postpone'],
            chineseOriginal: '由於天氣惡劣，我們的戶外活動不得不延後。',
            chineseChunks: ['我們的戶外活動', '不得不延後', '天氣惡劣'],
            correctOrder: [2, 0, 1],
            connectors: [
                {
                    id: 'conn_1',
                    slotIndex: 0,
                    type: '介系詞片語',
                    hintLabel: '開頭表原因的介系詞片語',
                    answer: 'Due to',
                    options: ['Due to', 'Although', 'Unless', 'Despite of'],
                    explanation: '後面為名詞片語「天氣惡劣」(bad weather)，需使用介系詞片語 Due to（因為、由於）。'
                }
            ],
            phraseHints: [
                { zh: '由於', en: 'due to / because of', pos: 'prep. phr.', note: '後接名詞或名詞片語，不可直接接完整子句' },
                { zh: '天氣惡劣', en: 'bad weather / severe weather', pos: 'n. phr.', note: 'weather 為不可數名詞，前面不加 a' },
                { zh: '戶外活動', en: 'outdoor activity', pos: 'n. phr.', note: 'outdoor 為形容詞修飾名詞 activity' },
                { zh: '不得不', en: 'have to / be forced to', pos: 'modal / v. phr.', note: '過去式用 had to' },
                { zh: '延後', en: 'postpone / put off', pos: 'v.', note: '活動為「被延後」，需用被動語態 be postponed' }
            ],
            sampleAnswer: 'Due to bad weather, our outdoor activity had to be postponed.',
            grammarFocus: 'Due to + N（表原因）與 had to be + p.p.（過去被動語態）'
        },
        {
            id: 'curated_although_traffic',
            targetWords: ['arrive'],
            chineseOriginal: '儘管交通擁擠，他還是準時抵達了機場。',
            chineseChunks: ['他還是準時抵達了', '交通擁擠', '機場'],
            correctOrder: [1, 0, 2],
            connectors: [
                {
                    id: 'conn_1',
                    slotIndex: 0,
                    type: '從屬連接詞',
                    hintLabel: '開頭引導讓步子句的連接詞',
                    answer: 'Although',
                    options: ['Although', 'Despite', 'Because', 'Therefore'],
                    explanation: '後方接完整子句（主詞＋動詞），需使用從屬連接詞 Although（儘管），不可用介系詞 Despite。'
                },
                {
                    id: 'conn_2',
                    slotIndex: 2,
                    type: '冠詞',
                    hintLabel: '特定地點「機場」前的定冠詞',
                    answer: 'the',
                    options: ['the', 'a', 'an', 'in'],
                    explanation: '雙方皆知的特定場所（機場）前需加上定冠詞 the（arrive at the airport）。'
                }
            ],
            phraseHints: [
                { zh: '儘管', en: 'although / even though', pos: 'conj.', note: '引導讓步子句，英文不可再加 but' },
                { zh: '交通擁擠', en: 'the traffic was heavy', pos: 'clause', note: '英文常用 heavy traffic 形容交通擁擠' },
                { zh: '準時', en: 'on time', pos: 'adv. phr.', note: 'on time（準時）；in time（及時）' },
                { zh: '抵達', en: 'arrive at / reach', pos: 'v.', note: 'arrive at + 小地點（如機場）；reach 為及物動詞直接加受詞' },
                { zh: '機場', en: 'airport', pos: 'n.', note: '母音開頭可數名詞，常搭配 the airport' }
            ],
            sampleAnswer: 'Although the traffic was heavy, he still arrived at the airport on time.',
            grammarFocus: 'Although 引導讓步子句（英文不可再加 but）與定冠詞 the 的使用'
        },
        {
            id: 'curated_unless_umbrella',
            targetWords: ['remind'],
            chineseOriginal: '除非你帶把雨傘，否則你可能會在暴風雨中淋濕。',
            chineseChunks: ['你可能會淋濕', '你帶', '雨傘', '在暴風雨中'],
            correctOrder: [1, 2, 0, 3],
            connectors: [
                {
                    id: 'conn_1',
                    slotIndex: 0,
                    type: '條件連接詞',
                    hintLabel: '開頭表「除非」的連接詞',
                    answer: 'Unless',
                    options: ['Unless', 'Until', 'Whereas', 'Since'],
                    explanation: 'Unless 等於 If ... not，引導否定條件子句（現在式代替未來式）。'
                },
                {
                    id: 'conn_2',
                    slotIndex: 1,
                    type: '不定冠詞',
                    hintLabel: '單數母音開頭名詞「雨傘」前的冠詞',
                    answer: 'an',
                    options: ['an', 'a', 'the', 'some'],
                    explanation: 'umbrella 為母音 /ʌ/ 開頭的單數可數名詞，需搭配不定冠詞 an。'
                }
            ],
            phraseHints: [
                { zh: '除非', en: 'unless', pos: 'conj.', note: '相當於 if ... not，條件子句用現在簡單式表未來' },
                { zh: '帶', en: 'bring / take', pos: 'v.', note: 'bring an umbrella（帶一把雨傘）' },
                { zh: '雨傘', en: 'umbrella', pos: 'n.', note: '母音開頭單數可數名詞，需加不定冠詞 an' },
                { zh: '淋濕', en: 'get wet', pos: 'v. phr.', note: 'get + 形容詞 wet 表示「變得潮濕／淋濕」' },
                { zh: '在暴風雨中', en: 'in the storm', pos: 'prep. phr.', note: 'storm 指「暴風雨」' }
            ],
            sampleAnswer: 'Unless you bring an umbrella, you might get wet in the storm.',
            grammarFocus: 'Unless 條件子句（現在式代未來式）與母音開頭不定冠詞 an'
        }
    ];

    const state = {
        question: null,
        targetCards: [],
        isLoading: false,
        curatedIndex: 0,

        // 主作答狀態（一載入即開放直接輸入）
        userTranslation: '',
        isSubmitted: false,
        gradingResult: null,

        // 提示 1：中文語序重組（按鈕展開，非強制）
        hint1Open: false,
        selectedChunkOrder: [],
        hint1Completed: false,
        hint1ErrorMsg: '',

        // 提示 2：兩階段漸進提示（全程不顯示完整英文句子）
        // 0 = 關閉
        // 1 = 第一階段：顯示正確語序的中文句子，讓玩家點擊選擇需補連接詞／冠詞的正確位置
        // 2 = 第二階段：彈出連接詞／冠詞選擇題供玩家作答
        hint2Stage: 0,
        foundSlotIndices: [],
        wrongSlotIndex: null,
        slotFeedbackMsg: '',
        connectorAnswers: {},

        // 點擊或反白拖曳中文句子詞彙／片語查英文翻譯
        activePhraseHint: null,
        aiPhraseCache: {},
        lastDragLookupAt: 0,
        selectionBound: false
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

    function shuffleList(arr) {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    /**
     * 🎯 僅從「英文隔離池 + 目前勾選字庫」抽選 1～2 個單字作為本題核心目標單字
     */
    function pickTargetCardsForTranslation() {
        const pool = (typeof global.getQuizLanguageFilteredPool === 'function')
            ? global.getQuizLanguageFilteredPool('en', { requireMeaning: true })
            : [];
        if (pool.length === 0) return [];

        const sorted = pool.slice().sort((a, b) => {
            const diff = (Number(a.freeLevel) || 1) - (Number(b.freeLevel) || 1);
            if (diff !== 0) return diff;
            return Math.random() - 0.5;
        });

        const topSlice = sorted.slice(0, Math.min(sorted.length, 8));
        const shuffled = shuffleList(topSlice);
        const pickCount = shuffled.length >= 2 && Math.random() < 0.55 ? 2 : 1;
        return shuffled.slice(0, pickCount);
    }

    /**
     * 🔧 正規化 AI 回傳或內建題目資料，確保 slotIndex、選項與詞彙提示結構完整
     */
    function normalizeQuestionData(raw, targetCards = []) {
        if (!raw || typeof raw !== 'object') {
            throw new Error('AI 回傳題目格式無效');
        }

        const chineseOriginal = String(raw.chineseOriginal || '').trim();
        let chineseChunks = Array.isArray(raw.chineseChunks)
            ? raw.chineseChunks.map(c => String(c || '').trim()).filter(Boolean)
            : [];

        if (!chineseOriginal) {
            throw new Error('題目缺少中文原句');
        }
        if (chineseChunks.length < 2) {
            const fallbackSplit = chineseOriginal.split(/[，。、；！？,\.!\?]+/).map(s => s.trim()).filter(Boolean);
            if (fallbackSplit.length >= 2) {
                chineseChunks = fallbackSplit;
            } else {
                throw new Error('中文語序詞塊不足');
            }
        }

        const n = chineseChunks.length;
        let correctOrder = Array.isArray(raw.correctOrder)
            ? raw.correctOrder.map(x => Number(x))
            : [];

        const isValidPerm = correctOrder.length === n &&
            correctOrder.every(idx => Number.isInteger(idx) && idx >= 0 && idx < n) &&
            new Set(correctOrder).size === n;

        if (!isValidPerm) {
            correctOrder = Array.from({ length: n }, (_, i) => i);
        }

        const rawConnectors = Array.isArray(raw.connectors) ? raw.connectors : [];
        const connectors = rawConnectors.slice(0, 3).map((c, idx) => {
            const answer = String((c && c.answer) || '').trim();
            if (!answer) return null;
            let opts = Array.isArray(c && c.options)
                ? c.options.map(o => String(o || '').trim()).filter(Boolean)
                : [];
            if (!opts.includes(answer)) {
                opts.unshift(answer);
            }
            opts = Array.from(new Set(opts));
            const fallbackDistractors = ['Although', 'Despite', 'Because', 'Due to', 'Unless', 'Whereas', 'the', 'a', 'an'];
            for (const d of fallbackDistractors) {
                if (opts.length >= 4) break;
                if (!opts.includes(d)) opts.push(d);
            }
            opts = shuffleList(opts.slice(0, 4));

            let slotIndex = Number(c && c.slotIndex);
            if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > n) {
                slotIndex = Math.min(idx, n);
            }

            return {
                id: String((c && c.id) || `conn_${idx + 1}`),
                slotIndex,
                type: String((c && c.type) || '連接詞／冠詞').trim(),
                hintLabel: String((c && c.hintLabel) || `第 ${idx + 1} 處連接詞或冠詞`).trim(),
                answer,
                options: opts,
                explanation: String((c && c.explanation) || '').trim()
            };
        }).filter(Boolean);

        if (connectors.length === 0) {
            connectors.push({
                id: 'conn_1',
                slotIndex: 0,
                type: '連接詞／冠詞',
                hintLabel: '句首連接詞或冠詞',
                answer: 'Although',
                options: shuffleList(['Although', 'Despite', 'Because', 'Unless']),
                explanation: '依前後語意邏輯選擇適當的連接詞。'
            });
        }

        const rawPhrases = Array.isArray(raw.phraseHints) ? raw.phraseHints : [];
        const phraseHints = [];
        const seenZh = new Set();
        rawPhrases.forEach(p => {
            if (!p || typeof p !== 'object') return;
            const zh = String(p.zh || '').trim();
            const en = String(p.en || '').trim();
            if (!zh || !en || seenZh.has(zh)) return;
            seenZh.add(zh);
            phraseHints.push({
                zh,
                en,
                pos: String(p.pos || '').trim(),
                note: String(p.note || '').trim()
            });
        });

        targetCards.forEach(card => {
            if (!card || !card.word || !card.meaning) return;
            const cleanMeaning = String(card.meaning).replace(/\([^)]*\)/g, '').split(/[；;,，、/]/)[0].trim();
            if (cleanMeaning && chineseOriginal.includes(cleanMeaning) && !seenZh.has(cleanMeaning)) {
                seenZh.add(cleanMeaning);
                phraseHints.push({
                    zh: cleanMeaning,
                    en: card.word.trim(),
                    pos: String(card.pos || '').trim(),
                    note: `本題字庫目標單字：${card.meaning}`
                });
            }
        });

        const sampleAnswer = String(raw.sampleAnswer || '').trim();
        if (!sampleAnswer) {
            throw new Error('題目缺少英文參考解答');
        }

        return {
            id: String(raw.id || ('ai_trans_' + Date.now())),
            targetWords: targetCards.map(c => c.word),
            chineseOriginal,
            chineseChunks,
            correctOrder,
            connectors,
            phraseHints,
            sampleAnswer,
            grammarFocus: String(raw.grammarFocus || '注意英文語序調整、連接詞邏輯與冠詞搭配').trim()
        };
    }

    /**
     * 📖 載入下一題（優先結合目前勾選字庫，無字庫時自動切換內建示範題庫）
     */
    async function loadNextQuestion() {
        if (state.isLoading) return;

        state.userTranslation = '';
        state.isSubmitted = false;
        state.gradingResult = null;
        state.hint1Open = false;
        state.selectedChunkOrder = [];
        state.hint1Completed = false;
        state.hint1ErrorMsg = '';
        state.hint2Stage = 0;
        state.foundSlotIndices = [];
        state.wrongSlotIndex = null;
        state.slotFeedbackMsg = '';
        state.connectorAnswers = {};
        state.activePhraseHint = null;

        const pickedCards = pickTargetCardsForTranslation();
        state.targetCards = pickedCards;

        if (pickedCards.length === 0) {
            const idx = state.curatedIndex % CURATED_QUESTIONS.length;
            state.curatedIndex = (idx + 1) % CURATED_QUESTIONS.length;
            state.question = normalizeQuestionData(CURATED_QUESTIONS[idx], []);
            renderUI();
            return;
        }

        state.isLoading = true;
        state.question = null;
        renderUI();

        const wordsPromptList = pickedCards
            .map(c => `- "${c.word}" (${c.pos || 'word'}): ${c.meaning}`)
            .join('\n');

        const prompt = `You are a Taiwanese high school English exam designer (學測中譯英與句構專家).
Create ONE Traditional Chinese -> English translation exercise incorporating these target vocabulary word(s):
${wordsPromptList}

CRITICAL DESIGN RULES:
1. "chineseOriginal": A natural, idiomatic Traditional Chinese sentence (12–22 characters) whose meaning requires using the target word(s) and at least 1–2 English connectors/prepositions/articles (e.g. Although, Due to, Unless, so that, the, an) or verb collocations (e.g. turn A into B).
2. "chineseChunks": Split the core semantic clauses/phrases of "chineseOriginal" into 3–4 short Traditional Chinese chunks. EXCLUDE the standalone connector/article words that will be tested in "connectors" so the learner has to insert them.
3. "correctOrder": A permutation of [0, ..., chineseChunks.length - 1] arranging "chineseChunks" into natural English syntax order. Let orderedChunks = correctOrder.map(i => chineseChunks[i]).
4. "connectors": 1–2 items representing the English connector(s), preposition(s), or article(s) needed in the English translation.
   - "slotIndex": Integer from 0 to orderedChunks.length specifying the EXACT gap in "orderedChunks" where that connector/article belongs (0 = before orderedChunks[0], 1 = between orderedChunks[0] and orderedChunks[1], ..., orderedChunks.length = after the last chunk).
   - "type": Traditional Chinese label e.g. "從屬連接詞", "介系詞片語", "冠詞".
   - "hintLabel": Short Traditional Chinese clue WITHOUT revealing the English word.
   - "answer": Exact English word/phrase (e.g. "Due to", "Although", "the").
   - "options": 4 distinct English choices including "answer".
   - "explanation": Concise Traditional Chinese grammar explanation.
5. "phraseHints": 4–7 objects mapping EVERY key Chinese word/phrase in "chineseOriginal" to its English translation or collocation pattern (e.g. { "zh": "轉變成", "en": "turn A into B", "pos": "v. phr.", "note": "把 A 轉變成 B" }). Ensure "zh" is an EXACT substring of "chineseOriginal".
6. "sampleAnswer": Natural, grammatically accurate English translation.
7. "grammarFocus": Concise Traditional Chinese summary of key syntax and grammar points.

Return ONLY a valid raw JSON object (no markdown fences):
{
  "chineseOriginal": "...",
  "chineseChunks": ["...", "...", "..."],
  "correctOrder": [1, 0, 2],
  "connectors": [
    {
      "id": "conn_1",
      "slotIndex": 0,
      "type": "從屬連接詞",
      "hintLabel": "引導讓步子句的連接詞",
      "answer": "Although",
      "options": ["Although", "Despite", "Because", "Therefore"],
      "explanation": "..."
    }
  ],
  "phraseHints": [
    { "zh": "...", "en": "...", "pos": "v. phr.", "note": "..." }
  ],
  "sampleAnswer": "...",
  "grammarFocus": "..."
}`;

        try {
            if (typeof global.callGeminiApi !== 'function') {
                throw new Error('AI 引擎尚未就緒');
            }
            const rawText = await global.callGeminiApi(prompt, { feature: 'article_gen' });
            const parsed = (typeof global.safeParseJSON === 'function')
                ? global.safeParseJSON(rawText)
                : JSON.parse(rawText);
            state.question = normalizeQuestionData(parsed, pickedCards);
        } catch (err) {
            console.warn('[QuizTranslation] AI 出題失敗，自動切換內建示範題:', err);
            const idx = state.curatedIndex % CURATED_QUESTIONS.length;
            state.curatedIndex = (idx + 1) % CURATED_QUESTIONS.length;
            state.targetCards = [];
            state.question = normalizeQuestionData(CURATED_QUESTIONS[idx], []);
            if (typeof global.showToast === 'function') {
                global.showToast('AI 連線繁忙，已為你切換精選練習題！', 'info');
            }
        } finally {
            state.isLoading = false;
            renderUI();
        }
    }

    // =========================================================================
    // 🔍 點擊或滑鼠／手指反白選取中文句子詞彙／成語／片語 ➔ 查詢英文單字或片語搭配
    // =========================================================================
    function handleTokenClick(rawZh) {
        // 若剛剛完成反白拖曳查詢，忽略同一輪的單點擊避免重複觸發
        if (Date.now() - state.lastDragLookupAt < 250) return;

        // 若使用者正在進行多字反白選取，交由反白選取事件處理
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
            const sel = window.getSelection();
            const selStr = sel ? sel.toString().trim() : '';
            if (selStr.length > 1) return;
        }

        lookupChinesePhrase(rawZh);
    }

    function checkAndLookupDragSelection() {
        if (typeof document === 'undefined' || typeof window === 'undefined') return;
        if (!state.question || typeof window.getSelection !== 'function') return;

        const box = document.getElementById('qtChineseSentenceBox');
        if (!box) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        const ancestorEl = commonAncestor.nodeType === 1 ? commonAncestor : commonAncestor.parentNode;
        if (!ancestorEl || !box.contains(ancestorEl)) return;

        // 清理反白字串中的首尾空白與中英文標點符號
        const rawSelected = sel.toString()
            .replace(/\s+/g, '')
            .replace(/^[，。！？、；：「」『』（）\(\),\.\!\?]+|[，。！？、；：「」『』（）\(\),\.\!\?]+$/g, '')
            .trim();

        if (!rawSelected || rawSelected.length > 24) return;

        // 確認選取片段確實屬於目前中文原句
        if (!state.question.chineseOriginal.includes(rawSelected)) return;

        // 避免重複查詢同一詞彙
        if (state.activePhraseHint && state.activePhraseHint.zh === rawSelected) return;

        state.lastDragLookupAt = Date.now();
        lookupChinesePhrase(rawSelected);
    }

    function ensureGlobalSelectionListener() {
        if (state.selectionBound || typeof document === 'undefined') return;
        state.selectionBound = true;

        const onRelease = () => {
            setTimeout(checkAndLookupDragSelection, 20);
        };

        document.addEventListener('mouseup', onRelease);
        document.addEventListener('touchend', onRelease);
    }

    async function lookupChinesePhrase(rawZh) {
        if (!state.question) return;
        const zh = String(rawZh || '').trim();
        if (!zh) return;

        // 1. 優先查詢本題預建的 phraseHints（精準片語搭配如 turn A into B）
        const matched = (state.question.phraseHints || []).find(p => p.zh === zh);
        if (matched) {
            state.activePhraseHint = { ...matched };
            renderUI();
            return;
        }

        // 2. 查詢動態快取（含題目 ID 避免跨題語境混淆）
        const cacheKey = `${state.question.id}::${zh}`;
        if (state.aiPhraseCache[cacheKey]) {
            state.activePhraseHint = { ...state.aiPhraseCache[cacheKey] };
            renderUI();
            return;
        }

        // 3. 即時背景向 AI 查詢所選取中文詞彙／成語／片語在該句語境下的英文單字或句型搭配
        state.activePhraseHint = {
            zh,
            en: '查詢中...',
            pos: '',
            note: '正在分析所選詞語在句子中的英文單字或片語搭配...',
            isAiLoading: true
        };
        renderUI();

        try {
            if (typeof global.callGeminiApi !== 'function') {
                throw new Error('AI 查詢未就緒');
            }
            const prompt = `In the Traditional Chinese sentence: "${state.question.chineseOriginal}"
Translate the selected Chinese word/idiom/phrase "${zh}" into its best English word or collocation pattern (e.g. if it means 轉變/轉變成, return "turn A into B"; if 不遺餘力, return "spare no effort to V"; if 導致, return "lead to / result in").
Return ONLY a valid raw JSON object:
{
  "zh": "${zh}",
  "en": "English word or phrase pattern",
  "pos": "POS e.g. v. phr. / n. / adj. / idiom",
  "note": "Brief Traditional Chinese usage tip (under 28 chars)"
}`;
            const rawText = await global.callGeminiApi(prompt, { silent: true, feature: 'def_fill' });
            const parsed = (typeof global.safeParseJSON === 'function')
                ? global.safeParseJSON(rawText)
                : JSON.parse(rawText);

            const entry = {
                zh,
                en: String((parsed && parsed.en) || '').trim() || '（查無對應翻譯）',
                pos: String((parsed && parsed.pos) || '').trim(),
                note: String((parsed && parsed.note) || '').trim()
            };
            state.aiPhraseCache[cacheKey] = entry;
            if (state.activePhraseHint && state.activePhraseHint.zh === zh) {
                state.activePhraseHint = { ...entry };
                renderUI();
            }
        } catch (err) {
            if (state.activePhraseHint && state.activePhraseHint.zh === zh) {
                state.activePhraseHint = {
                    zh,
                    en: '暫無法取得即時片語提示',
                    pos: '',
                    note: '目前為離線或連線繁忙狀態，可參考其他底線標記詞語或點擊提示按鈕輔助'
                };
                renderUI();
            }
        }
    }

    function closePhraseHint() {
        state.activePhraseHint = null;
        renderUI();
    }

    function speakPhrase(text) {
        if (!text) return;
        const clean = String(text).split('/')[0].replace(/\b[A-B]\b/g, '').replace(/\s+/g, ' ').trim();
        if (!clean) return;
        if (typeof window !== 'undefined' && window.LZHAudioTts && typeof window.LZHAudioTts.speak === 'function') {
            window.LZHAudioTts.speak(clean, 'en-US').catch(() => {});
        } else if (typeof global.speakText === 'function') {
            global.speakText(clean, 'en-US');
        } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(clean);
                u.lang = 'en-US';
                window.speechSynthesis.speak(u);
            } catch (e) {}
        }
    }

    function insertPhraseToInput(enPhrase) {
        if (state.isSubmitted || !enPhrase) return;
        let primary = String(enPhrase).split('/')[0].trim();
        if (!primary || primary.includes('查詢中') || primary.includes('暫無法')) return;

        const current = state.userTranslation || '';
        const needsSpace = current.length > 0 && !/\s$/.test(current);
        state.userTranslation = current + (needsSpace ? ' ' : '') + primary + ' ';
        renderUI();

        if (typeof document !== 'undefined') {
            const inputEl = document.getElementById('qtTranslationInput');
            if (inputEl) {
                inputEl.focus();
                inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
            }
        }
    }

    // =========================================================================
    // 🧩 提示 1（按鈕展開）：中文語序重組（非強制）
    // =========================================================================
    function toggleHint1() {
        if (!state.question) return;
        state.hint1Open = !state.hint1Open;
        renderUI();
    }

    function selectChunk(chunkIdx) {
        if (!state.question || state.hint1Completed) return;
        const idx = Number(chunkIdx);
        if (state.selectedChunkOrder.includes(idx)) return;

        state.selectedChunkOrder.push(idx);
        state.hint1ErrorMsg = '';

        if (state.selectedChunkOrder.length === state.question.chineseChunks.length) {
            checkStep1Order();
        } else {
            renderUI();
        }
    }

    function undoLastChunk() {
        if (state.hint1Completed || state.selectedChunkOrder.length === 0) return;
        state.selectedChunkOrder.pop();
        state.hint1ErrorMsg = '';
        renderUI();
    }

    function resetStep1() {
        if (state.hint1Completed) return;
        state.selectedChunkOrder = [];
        state.hint1ErrorMsg = '';
        renderUI();
    }

    function checkStep1Order() {
        if (!state.question) return;
        const target = state.question.correctOrder;
        const chosen = state.selectedChunkOrder;

        if (chosen.length !== target.length) {
            state.hint1ErrorMsg = '請先點選完所有中文詞塊！';
            renderUI();
            return;
        }

        const isCorrect = target.every((val, i) => chosen[i] === val);
        if (isCorrect) {
            state.hint1Completed = true;
            state.hint1ErrorMsg = '';
            if (typeof global.showToast === 'function') {
                global.showToast('語序重組正確！現在可以直接翻譯，或開啟「提示 2」練習連接詞位置', 'success');
            }
        } else {
            state.hint1ErrorMsg = '語序還差一點點！提示：英文通常先寫主詞＋動作，時間／地點／條件依邏輯排列。';
            state.selectedChunkOrder = [];
        }
        renderUI();
    }

    // =========================================================================
    // 💡 提示 2（兩階段漸進按鈕）：
    //    - 按一次（stage 1）：顯示正確語序的中文句子，讓玩家點選需補連接詞／冠詞的位置
    //    - 再按一次（stage 2）：彈出連接詞／冠詞選擇題（全程不顯示完整英文句子）
    // =========================================================================
    function advanceHint2() {
        if (!state.question) return;
        if (state.hint2Stage === 0) {
            state.hint2Stage = 1;
            state.wrongSlotIndex = null;
            state.slotFeedbackMsg = '';
        } else if (state.hint2Stage === 1) {
            state.hint2Stage = 2;
            state.wrongSlotIndex = null;
            state.slotFeedbackMsg = '';
            const allTargetSlots = (state.question.connectors || []).map(c => c.slotIndex);
            state.foundSlotIndices = Array.from(new Set([...state.foundSlotIndices, ...allTargetSlots]));
        }
        renderUI();
    }

    function collapseHint2() {
        state.hint2Stage = 0;
        renderUI();
    }

    function clickChineseSlot(slotIdx) {
        if (!state.question || state.hint2Stage !== 1) return;
        const s = Number(slotIdx);
        const matchedConns = (state.question.connectors || []).filter(c => c.slotIndex === s);

        if (matchedConns.length > 0) {
            if (!state.foundSlotIndices.includes(s)) {
                state.foundSlotIndices.push(s);
            }
            state.wrongSlotIndex = null;
            const typeDesc = matchedConns.map(c => c.type).join('、');
            const totalRequired = new Set((state.question.connectors || []).map(c => c.slotIndex)).size;
            if (state.foundSlotIndices.length >= totalRequired) {
                state.slotFeedbackMsg = `🎉 太棒了！你已找出全部 ${totalRequired} 處需要補「${typeDesc}」的位置！可直接翻譯，或再按一次提示顯示選項。`;
            } else {
                state.slotFeedbackMsg = `✓ 找對了！此處需要補上「${typeDesc}」，請繼續尋找其他位置！`;
            }
        } else {
            state.wrongSlotIndex = s;
            state.slotFeedbackMsg = '此處不需要額外補連接詞或冠詞，請點擊其他「＋」位置試試！';
        }
        renderUI();
    }

    function selectConnector(connId, optionValue) {
        if (!state.question || state.hint2Stage < 2) return;
        state.connectorAnswers[connId] = optionValue;
        renderUI();
    }

    // =========================================================================
    // ✍️ 英文翻譯輸入與 AI 批改
    // =========================================================================
    function onInputTranslation(val) {
        state.userTranslation = val;
    }

    async function submitTranslation() {
        if (!state.question || state.isSubmitted) return;
        const userAns = String(state.userTranslation || '').trim();
        if (!userAns) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先輸入你的英文翻譯句子！', 'warning');
            }
            return;
        }

        state.isLoading = true;
        renderUI();

        const q = state.question;
        const targetWordsDesc = (q.targetWords && q.targetWords.length > 0)
            ? `Target vocabulary words to check: ${q.targetWords.join(', ')}`
            : 'No mandatory deck word; focus on grammar, connectors, collocations, and meaning accuracy.';

        const prompt = `You are a strict yet encouraging Taiwanese high school English teacher grading a student's Chinese-to-English translation.
Chinese Original: "${q.chineseOriginal}"
Reference Sample Answer: "${q.sampleAnswer}"
${targetWordsDesc}
Student's English Translation: "${userAns}"

Evaluate the student's translation for:
1. Semantic faithfulness to the Chinese sentence.
2. Proper use of connectors, prepositions, articles, collocations, and verb tense/voice.
3. Accurate usage of target vocabulary (if applicable).

Return ONLY a valid raw JSON object (no markdown fences):
{
  "score": 85,
  "passed": true,
  "correctedSentence": "Polished natural version of the student's sentence",
  "feedback": "Concise, encouraging Traditional Chinese feedback highlighting what was done well and any grammar/wording fixes",
  "grammarNotes": [
    "Key grammar or vocabulary point 1 in Traditional Chinese",
    "Key grammar or vocabulary point 2 in Traditional Chinese"
  ]
}`;

        let result = null;
        try {
            if (typeof global.callGeminiApi === 'function') {
                const rawText = await global.callGeminiApi(prompt, { feature: 'article_gen' });
                const parsed = (typeof global.safeParseJSON === 'function')
                    ? global.safeParseJSON(rawText)
                    : JSON.parse(rawText);
                if (parsed && typeof parsed === 'object') {
                    const score = Math.min(100, Math.max(0, Number(parsed.score) || 0));
                    result = {
                        score,
                        passed: typeof parsed.passed === 'boolean' ? parsed.passed : score >= PASS_SCORE,
                        correctedSentence: String(parsed.correctedSentence || q.sampleAnswer).trim(),
                        feedback: String(parsed.feedback || '').trim(),
                        grammarNotes: Array.isArray(parsed.grammarNotes)
                            ? parsed.grammarNotes.map(n => String(n).trim()).filter(Boolean)
                            : []
                    };
                }
            }
        } catch (err) {
            console.warn('[QuizTranslation] AI 批改失敗，啟用本地比對備援:', err);
        }

        if (!result) {
            const normUser = userAns.toLowerCase().replace(/[^a-z0-9\s]/g, '');
            const normSample = q.sampleAnswer.toLowerCase().replace(/[^a-z0-9\s]/g, '');
            const sampleTokens = normSample.split(/\s+/).filter(w => w.length > 2);
            const matchedCount = sampleTokens.filter(w => normUser.includes(w)).length;
            const ratio = sampleTokens.length > 0 ? (matchedCount / sampleTokens.length) : 0;
            const score = Math.min(100, Math.round(ratio * 100));
            result = {
                score,
                passed: score >= PASS_SCORE,
                correctedSentence: q.sampleAnswer,
                feedback: score >= PASS_SCORE
                    ? '核心語意與關鍵詞彙皆已掌握！可對照下方參考解答微調自然度。'
                    : '部分關鍵詞彙或連接詞尚有遺漏，請參考下方文法重點與參考句型。',
                grammarNotes: [q.grammarFocus]
            };
        }

        state.gradingResult = result;
        state.isSubmitted = true;
        state.isLoading = false;

        if (state.targetCards.length > 0 && typeof global.applyQuizFreeGrade === 'function') {
            state.targetCards.forEach(card => {
                global.applyQuizFreeGrade(card, result.passed);
            });
        }

        if (result.passed && global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            try {
                global.GameEngine.awardProgression({ xp: 20 });
            } catch (e) {}
        }

        renderUI();
    }

    // =========================================================================
    // 🎨 UI 渲染（中文點擊／反白拖曳查詞 + 英文直接輸入 + 提示 1/2 漸進按鈕）
    // =========================================================================
    function tokenizeEnglishIfAvailable(text) {
        if (!text) return '';
        if (global.ReaderPopover && typeof global.ReaderPopover.tokenizeEnglishText === 'function') {
            return global.ReaderPopover.tokenizeEnglishText(text);
        }
        return escapeHtml(text);
    }

    /**
     * 將中文原句拆解為同時支援「單點擊」與「滑鼠／手指反白任意長度」的互動元素
     */
    function renderInteractiveChineseSentence(chineseOriginal, phraseHints) {
        if (!chineseOriginal) return '';
        const hints = Array.isArray(phraseHints) ? phraseHints.slice() : [];
        hints.sort((a, b) => (b.zh ? b.zh.length : 0) - (a.zh ? a.zh.length : 0));

        const activeZh = state.activePhraseHint ? state.activePhraseHint.zh : '';
        let html = '';
        let pos = 0;
        const len = chineseOriginal.length;

        const makeTokenSpan = (segment, hasPrebuilt) => {
            const isSelected = activeZh === segment;
            const baseCls = 'cn-phrase-token inline px-0.5 rounded-md transition cursor-pointer font-bold select-text ';
            const stateCls = isSelected
                ? 'bg-brand-600 text-white shadow-2xs'
                : hasPrebuilt
                    ? 'border-b-2 border-dotted border-brand-500/80 dark:border-sky-400/80 hover:bg-brand-100/80 dark:hover:bg-sky-900/50 text-slate-900 dark:text-white'
                    : 'hover:bg-slate-200/80 dark:hover:bg-slate-700/80 text-slate-800 dark:text-slate-100';
            return `<span role="button" tabindex="0" onclick="QuizTranslationModule.handleTokenClick('${escapeHtml(segment)}')" class="${baseCls}${stateCls}" title="點擊或拖曳反白查看英文單字／片語">${escapeHtml(segment)}</span>`;
        };

        while (pos < len) {
            let matchedHint = null;
            for (const h of hints) {
                if (h.zh && chineseOriginal.startsWith(h.zh, pos)) {
                    matchedHint = h;
                    break;
                }
            }

            if (matchedHint) {
                html += makeTokenSpan(matchedHint.zh, true);
                pos += matchedHint.zh.length;
                continue;
            }

            const ch = chineseOriginal[pos];
            if (/[，。！？、；：「」『』（）\(\)\s,\.!\?]/.test(ch)) {
                html += escapeHtml(ch);
                pos += 1;
                continue;
            }

            let end = pos + 1;
            while (end < len && (end - pos) < 3) {
                const nextCh = chineseOriginal[end];
                if (/[，。！？、；：「」『』（）\(\)\s,\.!\?]/.test(nextCh)) break;
                if (hints.some(h => h.zh && chineseOriginal.startsWith(h.zh, end))) break;
                end += 1;
            }
            const seg = chineseOriginal.slice(pos, end);
            html += makeTokenSpan(seg, false);
            pos = end;
        }

        return html;
    }

    function renderUI() {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('quizTranslationContainer');
        if (!container) return;

        ensureGlobalSelectionListener();

        if (state.isLoading) {
            container.innerHTML = `
                <div class="py-10 text-center space-y-3">
                    <i class="fa-solid fa-wand-magic-sparkles fa-beat-fade text-2xl text-brand-500"></i>
                    <p class="text-sm font-bold text-slate-700 dark:text-slate-200">
                        ${state.question ? 'AI 正在批改你的英文翻譯並生成文法解析...' : 'AI 正在結合字庫生成句構翻譯題...'}
                    </p>
                    ${state.targetCards.length > 0 ? `<div class="flex justify-center flex-wrap gap-1.5">${state.targetCards.map(c => `<span class="px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-900/50 text-brand-700 dark:text-sky-300 text-xs font-bold">${escapeHtml(c.word)}</span>`).join('')}</div>` : ''}
                </div>
            `;
            return;
        }

        const q = state.question;
        if (!q) {
            container.innerHTML = `
                <div class="py-8 text-center space-y-3">
                    <p class="text-sm text-slate-500 dark:text-slate-400">尚未載入題目</p>
                    <button type="button" onclick="QuizTranslationModule.loadNextQuestion()" class="px-4 py-2 rounded-xl bg-brand-600 text-white text-xs font-bold">開始句構翻譯</button>
                </div>
            `;
            return;
        }

        const targetBadgeHtml = q.targetWords && q.targetWords.length > 0
            ? `<div class="flex items-center flex-wrap gap-1.5">
                    <span class="text-[11px] font-bold text-slate-400">本題融入字庫單字：</span>
                    ${q.targetWords.map(w => `<span class="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-xs font-bold">${escapeHtml(w)}</span>`).join('')}
               </div>`
            : `<span class="text-[11px] font-semibold text-slate-400">精選學測句構訓練題（於首頁勾選英文單字庫可自動融入單字出題）</span>`;

        const phraseCardHtml = state.activePhraseHint
            ? `
                <div class="p-3 rounded-xl bg-white dark:bg-slate-800 border border-brand-300 dark:border-sky-700 shadow-xs flex items-start justify-between gap-3">
                    <div class="space-y-1 min-w-0">
                        <div class="flex items-center flex-wrap gap-2">
                            <span class="px-2 py-0.5 rounded bg-brand-100 dark:bg-sky-900/60 text-brand-800 dark:text-sky-200 text-xs font-extrabold">${escapeHtml(state.activePhraseHint.zh)}</span>
                            <i class="fa-solid fa-arrow-right text-[10px] text-slate-400"></i>
                            <span class="font-serif text-sm sm:text-base font-extrabold text-brand-700 dark:text-sky-300">${escapeHtml(state.activePhraseHint.en)}</span>
                            ${state.activePhraseHint.pos ? `<span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[10px] font-bold text-slate-600 dark:text-slate-300">${escapeHtml(state.activePhraseHint.pos)}</span>` : ''}
                        </div>
                        ${state.activePhraseHint.note ? `<p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">${escapeHtml(state.activePhraseHint.note)}</p>` : ''}
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        ${!state.activePhraseHint.isAiLoading ? `
                            <button type="button" onclick="QuizTranslationModule.speakPhrase('${escapeHtml(state.activePhraseHint.en)}')" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-600 dark:text-slate-200 text-xs transition" title="朗讀英文片語">
                                <i class="fa-solid fa-volume-high"></i>
                            </button>
                            ${!state.isSubmitted ? `
                                <button type="button" onclick="QuizTranslationModule.insertPhraseToInput('${escapeHtml(state.activePhraseHint.en)}')" class="px-2 py-1.5 rounded-lg bg-brand-50 dark:bg-sky-900/50 hover:bg-brand-100 text-brand-700 dark:text-sky-300 border border-brand-200 dark:border-sky-800 text-[11px] font-bold transition" title="將此片語插入下方輸入框">
                                    ＋ 插入
                                </button>
                            ` : ''}
                        ` : '<i class="fa-solid fa-spinner fa-spin text-brand-500 text-xs mr-1"></i>'}
                        <button type="button" onclick="QuizTranslationModule.closePhraseHint()" class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs" title="關閉提示">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
            `
            : '';

        const sourceCardHtml = `
            <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700 space-y-2.5">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <span class="text-xs font-extrabold uppercase tracking-wider text-brand-600 dark:text-sky-400">中文原句（可直接翻譯，或點擊／反白任意詞句查片語）</span>
                    <button type="button" onclick="QuizTranslationModule.loadNextQuestion()" class="text-xs font-bold text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-sky-400 transition">
                        <i class="fa-solid fa-arrows-rotate mr-1"></i>換一題
                    </button>
                </div>
                <p id="qtChineseSentenceBox" class="text-base sm:text-lg leading-relaxed text-slate-900 dark:text-white select-text">
                    ${renderInteractiveChineseSentence(q.chineseOriginal, q.phraseHints)}
                </p>
                <div class="flex items-center justify-between flex-wrap gap-2">
                    <span class="text-[11px] text-brand-600 dark:text-sky-400 font-semibold">💡 點擊單字詞，或用滑鼠／手指反白任意長度的中文片語（如「轉變成」➔ turn A into B）</span>
                </div>
                ${phraseCardHtml}
                ${targetBadgeHtml}
            </div>
        `;

        const hint2BtnLabel = state.hint2Stage === 0
            ? '提示 2：連接詞／冠詞位置'
            : state.hint2Stage === 1
                ? '再按一次提示：彈出連接詞／冠詞選項'
                : '提示 2：已顯示連接詞／冠詞選項';

        const hintButtonsBarHtml = !state.isSubmitted
            ? `
                <div class="flex items-center flex-wrap gap-2">
                    <button type="button" onclick="QuizTranslationModule.toggleHint1()" class="px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${state.hint1Open ? 'bg-brand-600 text-white border-brand-600 shadow-2xs' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-brand-400'}">
                        <i class="fa-solid fa-puzzle-piece"></i>
                        <span>提示 1：中文語序重組${state.hint1Completed ? ' ✓' : ''}</span>
                        <i class="fa-solid ${state.hint1Open ? 'fa-chevron-up' : 'fa-chevron-down'} text-[10px] opacity-75"></i>
                    </button>
                    <button type="button" onclick="QuizTranslationModule.advanceHint2()" class="px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${state.hint2Stage > 0 ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-indigo-400'}">
                        <i class="fa-regular fa-lightbulb"></i>
                        <span>${hint2BtnLabel}</span>
                    </button>
                </div>
            `
            : '';

        let hint1PanelHtml = '';
        if (!state.isSubmitted && state.hint1Open) {
            const orderedItems = state.selectedChunkOrder.map(idx => ({ idx, text: q.chineseChunks[idx] }));
            hint1PanelHtml = `
                <div class="p-4 rounded-xl bg-brand-50/50 dark:bg-sky-950/20 border border-brand-200/80 dark:border-sky-800/70 space-y-3">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-xs font-extrabold text-brand-800 dark:text-sky-200">
                            🧩 提示 1（選用輔助）：依「英文文法語序」點擊排列中文詞塊
                        </p>
                        <div class="flex items-center gap-2">
                            ${!state.hint1Completed && state.selectedChunkOrder.length > 0 ? `
                                <button type="button" onclick="QuizTranslationModule.undoLastChunk()" class="text-xs font-bold text-slate-500 hover:text-slate-800 dark:text-slate-400">復原</button>
                                <button type="button" onclick="QuizTranslationModule.resetStep1()" class="text-xs font-bold text-rose-500 hover:text-rose-700">重排</button>
                            ` : ''}
                            <button type="button" onclick="QuizTranslationModule.toggleHint1()" class="text-xs font-bold text-slate-400 hover:text-slate-600">收合</button>
                        </div>
                    </div>
                    <div class="min-h-[46px] p-2.5 rounded-xl border-2 border-dashed ${state.hint1Completed ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/30' : 'border-brand-300 dark:border-sky-700 bg-white dark:bg-slate-800/80'} flex items-center flex-wrap gap-2">
                        ${orderedItems.length === 0
                            ? '<span class="text-xs text-slate-400">請依序點擊下方詞塊排出英文語序...</span>'
                            : orderedItems.map((item, pos) => `<span class="px-3 py-1 rounded-lg ${state.hint1Completed ? 'bg-emerald-600' : 'bg-brand-600'} text-white text-xs font-bold shadow-2xs">${pos + 1}. ${escapeHtml(item.text)}</span>`).join('')
                        }
                    </div>
                    ${state.hint1ErrorMsg ? `<p class="text-xs font-bold text-rose-600 dark:text-rose-400">${escapeHtml(state.hint1ErrorMsg)}</p>` : ''}
                    ${state.hint1Completed ? `<p class="text-xs font-bold text-emerald-700 dark:text-emerald-300">✓ 英文語序排列完成！</p>` : ''}
                    <div class="flex flex-wrap gap-2">
                        ${q.chineseChunks.map((chunkText, idx) => {
                            const used = state.selectedChunkOrder.includes(idx);
                            return `<button type="button" ${used || state.hint1Completed ? 'disabled' : ''} onclick="QuizTranslationModule.selectChunk(${idx})" class="px-3 py-1.5 rounded-xl text-xs font-bold border transition ${used || state.hint1Completed ? 'opacity-40 cursor-not-allowed bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:border-brand-500 hover:text-brand-600 shadow-2xs'}">${escapeHtml(chunkText)}</button>`;
                        }).join('')}
                    </div>
                </div>
            `;
        }

        let hint2PanelHtml = '';
        if (!state.isSubmitted && state.hint2Stage > 0) {
            const orderedChunks = q.correctOrder.map(idx => q.chineseChunks[idx]);
            const requiredSlotsSet = new Set(q.connectors.map(c => c.slotIndex));
            const totalRequiredSlots = requiredSlotsSet.size;

            const slotToConns = new Map();
            q.connectors.forEach((conn, idx) => {
                const list = slotToConns.get(conn.slotIndex) || [];
                list.push({ ...conn, displayNum: idx + 1 });
                slotToConns.set(conn.slotIndex, list);
            });

            let slotsSentenceHtml = '';
            for (let s = 0; s <= orderedChunks.length; s++) {
                const connsHere = slotToConns.get(s) || [];
                const isFound = state.foundSlotIndices.includes(s) && connsHere.length > 0;
                const isWrong = state.wrongSlotIndex === s;

                if (state.hint2Stage === 1) {
                    if (isFound) {
                        const labels = connsHere.map(c => `✓ 需補${c.type}`).join(' / ');
                        slotsSentenceHtml += `<span class="inline-flex items-center px-2 py-1 mx-0.5 rounded-lg bg-emerald-100 dark:bg-emerald-950/70 border border-emerald-400 text-emerald-800 dark:text-emerald-200 text-xs font-extrabold">${escapeHtml(labels)}</span>`;
                    } else {
                        const wrongCls = isWrong
                            ? 'bg-rose-100 dark:bg-rose-950/60 border-rose-400 text-rose-700 dark:text-rose-300'
                            : 'bg-white dark:bg-slate-800 border-dashed border-indigo-400 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50';
                        slotsSentenceHtml += `<button type="button" onclick="QuizTranslationModule.clickChineseSlot(${s})" class="inline-flex items-center justify-center min-w-[28px] px-2 py-1 mx-0.5 rounded-lg border text-xs font-extrabold transition cursor-pointer ${wrongCls}" title="點擊判斷此位置是否需要加連接詞或冠詞">${isWrong ? '✕' : '＋'}</button>`;
                    }
                } else if (state.hint2Stage >= 2 && connsHere.length > 0) {
                    connsHere.forEach(c => {
                        const chosenOpt = state.connectorAnswers[c.id] || '';
                        slotsSentenceHtml += `<span class="inline-flex items-center px-2 py-1 mx-0.5 rounded-lg ${chosenOpt ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-200 border-amber-400'} border text-xs font-extrabold">#${c.displayNum} ${chosenOpt ? escapeHtml(chosenOpt) : `[${escapeHtml(c.type)}]`}</span>`;
                    });
                }

                if (s < orderedChunks.length) {
                    slotsSentenceHtml += `<span class="inline-block px-2.5 py-1 mx-0.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">${escapeHtml(orderedChunks[s])}</span>`;
                }
            }

            const mcqCardsHtml = state.hint2Stage >= 2
                ? `
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                        ${q.connectors.map((conn, idx) => {
                            const chosen = state.connectorAnswers[conn.id] || '';
                            const labels = ['A', 'B', 'C', 'D'];
                            return `
                                <div class="p-3 rounded-xl bg-white dark:bg-slate-800/90 border border-indigo-200 dark:border-indigo-800 space-y-2">
                                    <div class="flex items-center justify-between gap-2">
                                        <span class="text-xs font-extrabold text-indigo-700 dark:text-indigo-300">#${idx + 1} ${escapeHtml(conn.type)}</span>
                                        <span class="text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(conn.hintLabel)}</span>
                                    </div>
                                    <div class="grid grid-cols-2 gap-1.5">
                                        ${conn.options.map((opt, optIdx) => {
                                            const active = chosen === opt;
                                            return `<button type="button" onclick="QuizTranslationModule.selectConnector('${escapeHtml(conn.id)}', '${escapeHtml(opt)}')" class="px-2.5 py-1.5 rounded-lg text-xs font-bold border text-left transition flex items-center gap-1.5 ${active ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-indigo-400'}"><span class="opacity-70">(${labels[optIdx]})</span><span class="font-serif truncate">${escapeHtml(opt)}</span></button>`;
                                        }).join('')}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `
                : '';

            hint2PanelHtml = `
                <div class="p-4 rounded-xl bg-indigo-50/60 dark:bg-indigo-950/25 border border-indigo-200/80 dark:border-indigo-800/70 space-y-3">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <p class="text-xs font-extrabold text-indigo-800 dark:text-indigo-200">
                            ${state.hint2Stage === 1
                                ? `💡 提示 2（第 1 階段）：請在下方「正確語序中文句子」中，點擊需要加連接詞或冠詞的位置（已找出 ${state.foundSlotIndices.length} / ${totalRequiredSlots} 處）`
                                : '💡 提示 2（第 2 階段）：請選擇各標記位置對應的正確連接詞或冠詞'}
                        </p>
                        <button type="button" onclick="QuizTranslationModule.collapseHint2()" class="text-xs font-bold text-slate-400 hover:text-slate-600">收合</button>
                    </div>
                    <div class="p-3 rounded-xl bg-indigo-100/50 dark:bg-slate-900/80 border border-indigo-200/70 dark:border-slate-700 flex items-center flex-wrap gap-y-2">
                        ${slotsSentenceHtml}
                    </div>
                    ${state.slotFeedbackMsg ? `<p class="text-xs font-bold ${state.wrongSlotIndex !== null ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'}">${escapeHtml(state.slotFeedbackMsg)}</p>` : ''}
                    ${state.hint2Stage === 1 ? `
                        <div class="flex justify-end">
                            <button type="button" onclick="QuizTranslationModule.advanceHint2()" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-2xs transition">
                                💡 再按一次提示：彈出連接詞／冠詞選項
                            </button>
                        </div>
                    ` : ''}
                    ${mcqCardsHtml}
                </div>
            `;
        }

        const translationBoxHtml = !state.isSubmitted
            ? `
                <div class="space-y-2.5">
                    <label for="qtTranslationInput" class="block text-xs font-extrabold text-slate-600 dark:text-slate-300">
                        請直接輸入完整英文句子（可隨時送出批改，或先點擊上方提示按鈕輔助）：
                    </label>
                    <textarea id="qtTranslationInput" rows="3" oninput="QuizTranslationModule.onInputTranslation(this.value)" placeholder="在此輸入你的完整英文翻譯句子..." class="w-full p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm sm:text-base font-serif focus:outline-none focus:ring-2 focus:ring-brand-500">${escapeHtml(state.userTranslation)}</textarea>
                    <button type="button" onclick="QuizTranslationModule.submitTranslation()" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold shadow-sm transition">
                        提交 AI 句構與語意批改
                    </button>
                </div>
            `
            : '';

        const resultHtml = state.isSubmitted && state.gradingResult
            ? `
                <div class="p-4 rounded-xl border ${state.gradingResult.passed ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800' : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800'} space-y-3">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="flex items-center gap-2">
                            <span class="px-2.5 py-1 rounded-full text-xs font-extrabold ${state.gradingResult.passed ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}">
                                ${state.gradingResult.passed ? '🎉 通過' : '💪 再接再厲'} · ${state.gradingResult.score} 分
                            </span>
                            <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                ${q.targetWords.length > 0 ? '已更新字庫單字臨時等級（FSRS 排程未更動）' : '自由句構練習完成'}
                            </span>
                        </div>
                        <span class="text-[11px] font-semibold text-brand-600 dark:text-sky-400">💡 點擊英文單字可即時查字</span>
                    </div>
                    <div class="space-y-1 text-xs sm:text-sm">
                        <p class="text-slate-600 dark:text-slate-300"><strong class="text-slate-800 dark:text-slate-100">你的翻譯：</strong><span class="font-serif">${escapeHtml(state.userTranslation)}</span></p>
                        <p class="text-slate-700 dark:text-slate-200"><strong class="text-emerald-700 dark:text-emerald-300">建議修正：</strong><span class="font-serif">${tokenizeEnglishIfAvailable(state.gradingResult.correctedSentence)}</span></p>
                        <p class="text-slate-700 dark:text-slate-200"><strong class="text-brand-700 dark:text-sky-300">參考解答：</strong><span class="font-serif">${tokenizeEnglishIfAvailable(q.sampleAnswer)}</span></p>
                    </div>
                    ${state.gradingResult.feedback ? `<p class="text-xs text-slate-700 dark:text-slate-200 leading-relaxed bg-white/80 dark:bg-slate-800/80 p-3 rounded-lg border border-slate-200/60 dark:border-slate-700">${escapeHtml(state.gradingResult.feedback)}</p>` : ''}
                    ${q.connectors && q.connectors.length > 0 ? `
                        <div class="p-3 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700 space-y-1.5">
                            <p class="text-xs font-extrabold text-indigo-700 dark:text-indigo-300">關鍵連接詞／冠詞解析：</p>
                            <ul class="space-y-1 text-xs text-slate-600 dark:text-slate-300">
                                ${q.connectors.map(c => `<li>• <strong>${escapeHtml(c.answer)}</strong>（${escapeHtml(c.type)}）：${escapeHtml(c.explanation)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    ${state.gradingResult.grammarNotes && state.gradingResult.grammarNotes.length > 0 ? `
                        <ul class="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                            ${state.gradingResult.grammarNotes.map(note => `<li>${tokenizeEnglishIfAvailable(note)}</li>`).join('')}
                        </ul>
                    ` : ''}
                    <button type="button" onclick="QuizTranslationModule.loadNextQuestion()" class="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs sm:text-sm font-bold shadow-xs transition">
                        下一題句構挑戰 <i class="fa-solid fa-arrow-right ml-1"></i>
                    </button>
                </div>
            `
            : '';

        container.innerHTML = `
            <div class="space-y-4">
                ${sourceCardHtml}
                ${hintButtonsBarHtml}
                ${hint1PanelHtml}
                ${hint2PanelHtml}
                ${translationBoxHtml}
                ${resultHtml}
            </div>
        `;

        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function') {
            global.ReaderPopover.bindReaderContainer(container);
        }
    }

    function activateMode() {
        if (!state.question && !state.isLoading) {
            return loadNextQuestion();
        }
        renderUI();
        return Promise.resolve();
    }

    const QuizTranslationModule = {
        activateMode,
        loadNextQuestion,
        handleTokenClick,
        lookupChinesePhrase,
        closePhraseHint,
        speakPhrase,
        insertPhraseToInput,
        toggleHint1,
        selectChunk,
        undoLastChunk,
        resetStep1,
        checkStep1Order,
        advanceHint2,
        collapseHint2,
        clickChineseSlot,
        selectConnector,
        onInputTranslation,
        submitTranslation,
        renderUI,
        normalizeQuestionData,
        CURATED_QUESTIONS,
        _state: state
    };

    if (typeof global !== 'undefined') {
        global.QuizTranslationModule = QuizTranslationModule;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = QuizTranslationModule;
    }
})(typeof window !== 'undefined' ? window : globalThis);
