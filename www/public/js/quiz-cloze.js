/**
 * LZHCard - 考試模式四：學測型「文意選填 10 選 10」結構化挑戰 (js/quiz-cloze.js)
 * Phase 4 (模組 C)：
 * 1. 雙題源切換：「大考歷屆高頻題材模擬題庫」 vs 「AI 結合勾選字庫原創 10 選 10」
 * 2. 完整 10 選 10 詞彙庫互動：點選文章空格 + 點選 (A)~(J) 選項自動填入並跳下一空、支援詞性輔助開關、已用標記防重
 * 3. 完整整合共用元件 `ReaderPopover`：文章單字及交卷後選項單字皆可點擊即時翻譯與一鍵加入字庫
 * 4. 結算僅更新對應字庫單字之 `freeLevel` 與 `freeStreak`，絕對不動 FSRS 排程欄位
 */
(function (global) {
    'use strict';

    const PASS_ACCURACY = 70;
    const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    // 📚 內建 3 篇高質感學測風格「文意選填 10 選 10」模擬題庫（零等待離線可考）
    const CURATED_GSAT_CLOZE10 = [
        {
            id: 'gsat_cloze10_microbreaks',
            topic: '認知效率',
            title: 'The Unexpected Power of Micro-Breaks',
            paragraphs: [
                'When facing an approaching deadline or a demanding exam, many students assume that studying nonstop for hours is the fastest path to success. However, behavioral scientists have found that human focus [[BLANK_1]] steadily after roughly forty minutes of intense mental effort. Rather than pushing through exhaustion, taking brief "micro-breaks" lasting just one to five minutes can [[BLANK_2]] restore cognitive energy.',
                'During a micro-break, the key is stepping away from tasks that drain the same mental [[BLANK_3]]. Scrolling through noisy social media feeds often leaves the brain feeling even more [[BLANK_4]], because it keeps processing rapid visual stimuli. In contrast, stretching beside a window, gazing at distant trees, or sipping water allows the prefrontal cortex to rest [[BLANK_5]]. A recent workplace study [[BLANK_6]] that employees who paused briefly every hour made far fewer errors than colleagues who worked continuously. Moreover, these short pauses [[BLANK_7]] motivation by breaking intimidating projects into manageable intervals. Once learners recognize that rest is a [[BLANK_8]] component of productivity rather than a sign of laziness, they stop feeling guilty about pausing. Over the course of a semester, building simple recovery habits into daily routines helps students [[BLANK_9]] sharper memory and achieve [[BLANK_10]] academic performance.'
            ],
            blanks: [
                {
                    num: 1,
                    word: 'declines',
                    pos: 'v.',
                    clueType: '現在式單數動詞',
                    explanation: '主詞為不可數名詞 human focus，後接副詞 steadily（穩定地），語意指專注力「下降（declines）」。'
                },
                {
                    num: 2,
                    word: 'effectively',
                    pos: 'adv.',
                    clueType: '副詞修飾動詞',
                    explanation: '位於助動詞 can 與原形動詞 restore（恢復）之間，需填入副詞「有效地（effectively）」。'
                },
                {
                    num: 3,
                    word: 'resources',
                    pos: 'n.',
                    clueType: '複數名詞受詞',
                    explanation: '前有形容詞 mental，且搭配動詞 drain（消耗），填入名詞「資源（resources）」，指大腦認知資源。'
                },
                {
                    num: 4,
                    word: 'fatigued',
                    pos: 'adj.',
                    clueType: '形容詞作主詞補語',
                    explanation: 'leave + 受詞 + 形容詞（feeling even more _____），滑社群媒體只會讓大腦感到更「疲憊（fatigued）」。'
                },
                {
                    num: 5,
                    word: 'briefly',
                    pos: 'adv.',
                    clueType: '副詞修飾動詞',
                    explanation: '修飾前面動詞 rest（休息），與遠眺或喝水呼應，表示短暫地「歇息一會兒（briefly）」。'
                },
                {
                    num: 6,
                    word: 'revealed',
                    pos: 'v.',
                    clueType: '過去式動詞',
                    explanation: '主詞為 A recent workplace study，後接 that 名詞子句說明研究結果，需填過去式動詞「揭示（revealed）」。'
                },
                {
                    num: 7,
                    word: 'sustain',
                    pos: 'v.',
                    clueType: '原形複數動詞',
                    explanation: '主詞為複數名詞 short pauses，受詞為 motivation（動機），填入「維持、延續（sustain）」。'
                },
                {
                    num: 8,
                    word: 'vital',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞',
                    explanation: '位於冠詞 a 與名詞 component（要素）之間，強調休息是生產力「不可或缺的、關鍵的（vital）」一部份。'
                },
                {
                    num: 9,
                    word: 'maintain',
                    pos: 'v.',
                    clueType: '原形動詞（help + O + V）',
                    explanation: '句型 help students + 原形動詞，搭配受詞 sharper memory，表示「保持（maintain）」更敏銳的記憶力。'
                },
                {
                    num: 10,
                    word: 'consistent',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞',
                    explanation: '修飾後面名詞片語 academic performance，表達長期下來達到「穩定一致的（consistent）」學業表現。'
                }
            ]
        },
        {
            id: 'gsat_cloze10_coralsound',
            topic: '海洋生態',
            title: 'Healing Coral Reefs Through Underwater Sound',
            paragraphs: [
                'Healthy coral reefs are among the loudest habitats in the ocean, buzzing with crackling shrimp and calling fish. To tiny marine creatures drifting in open water, this lively symphony serves as a natural [[BLANK_1]] guiding them safely home. Unfortunately, rising ocean temperatures have caused widespread coral bleaching, turning vibrant underwater cities into [[BLANK_2]] wastelands. Without the familiar chorus of reef life, young fish swim right past damaged sites instead of settling there to [[BLANK_3]] the ecosystem.',
                'To break this vicious cycle, marine biologists recently tested a creative [[BLANK_4]] called acoustic enrichment. They placed waterproof loudspeakers on dead coral patches and [[BLANK_5]] recordings of thriving reefs for forty days. The results were [[BLANK_6]]: twice as many juvenile fish arrived at the sound-enhanced reefs compared with silent control sites. Once these newcomers moved in, they began grazing on suffocating algae, thereby [[BLANK_7]] space for baby corals to attach and grow. While underwater speakers cannot [[BLANK_8]] climate change on their own, researchers believe the method offers a [[BLANK_9]] bridge while global emissions are reduced. By restoring nature’s acoustic clues, scientists are giving fragile reefs a [[BLANK_10]] chance to recover.'
            ],
            blanks: [
                {
                    num: 1,
                    word: 'beacon',
                    pos: 'n.',
                    clueType: '單數可數名詞',
                    explanation: '前有不定冠詞與形容詞 a natural，後接分詞片語 guiding them safely home，故填「燈塔、信標（beacon）」。'
                },
                {
                    num: 2,
                    word: 'silent',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞',
                    explanation: '與第一句 loudest habitats 形成對比，珊瑚白化後變成「寂靜無聲的（silent）」荒地。'
                },
                {
                    num: 3,
                    word: 'rebuild',
                    pos: 'v.',
                    clueType: '不定詞 to + 原形動詞',
                    explanation: '接在不定詞 to 後面，受詞為 the ecosystem，指幼魚不再留下來「重建（rebuild）」生態系。'
                },
                {
                    num: 4,
                    word: 'technique',
                    pos: 'n.',
                    clueType: '單數名詞',
                    explanation: '前有 a creative，後接過去分詞片語 called acoustic enrichment，故填「技術、方法（technique）」。'
                },
                {
                    num: 5,
                    word: 'broadcast',
                    pos: 'v.',
                    clueType: '過去式動詞（與 placed 並列）',
                    explanation: 'and 連接兩個過去式動作：placed waterproof loudspeakers 與「播放、廣播（broadcast）」健康珊瑚礁的錄音。'
                },
                {
                    num: 6,
                    word: 'remarkable',
                    pos: 'adj.',
                    clueType: '形容詞作主詞補語',
                    explanation: 'be 動詞 were 之後接形容詞，後文指出幼魚數量多出兩倍，說明結果「驚人的、顯著的（remarkable）」。'
                },
                {
                    num: 7,
                    word: 'clearing',
                    pos: 'v-ing',
                    clueType: '現在分詞表達結果',
                    explanation: 'thereby + V-ing 表示伴隨結果：魚群吃掉窒息珊瑚的海藻，進而「清出（clearing）」空間讓珊瑚寶寶附著。'
                },
                {
                    num: 8,
                    word: 'halt',
                    pos: 'v.',
                    clueType: '助動詞後接原形動詞',
                    explanation: '助動詞 cannot 後接原形動詞，受詞為 climate change，表示音響無法單獨「阻止、煞停（halt）」氣候變遷。'
                },
                {
                    num: 9,
                    word: 'practical',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞',
                    explanation: '修飾名詞 bridge（過渡橋樑），表示這項方法提供了「務實可行的（practical）」過渡方案。'
                },
                {
                    num: 10,
                    word: 'fighting',
                    pos: 'adj.',
                    clueType: '固定片語 a fighting chance',
                    explanation: '慣用搭配 give ... a fighting chance（給予奮力一搏／復原的機會）。'
                }
            ]
        },
        {
            id: 'gsat_cloze10_languages',
            topic: '人文保存',
            title: 'Digital Lifelines for Endangered Languages',
            paragraphs: [
                'Every two weeks, somewhere on Earth, an elderly speaker passes away and takes an entire indigenous language with them. Linguists estimate that nearly half of the world’s seven thousand languages could [[BLANK_1]] before the end of this century. Because many of these tongues exist solely in [[BLANK_2]] traditions without written dictionaries, losing fluent elders means erasing centuries of ecological wisdom and poetic storytelling.',
                'Fortunately, smartphone apps and community archives are transforming how small populations [[BLANK_3]] their heritage. Instead of waiting for foreign scholars to arrive with heavy equipment, young villagers now record grandparents’ voices directly on [[BLANK_4]] devices. They upload folk tales, medicinal plant names, and everyday greetings into searchable databases that anyone can [[BLANK_5]] freely online. In Canada and Australia, several schools have [[BLANK_6]] interactive games that reward children for pronouncing traditional words accurately. When teenagers hear their ancestral language inside music playlists or podcasts, it feels [[BLANK_7]] and relevant rather than outdated. Although technology alone cannot [[BLANK_8]] fluent speakers overnight, digital tools lower the barriers to learning. Ultimately, keeping a language alive depends on daily [[BLANK_9]] between generations, turning archived recordings back into [[BLANK_10]] conversations at the dinner table.'
            ],
            blanks: [
                {
                    num: 1,
                    word: 'vanish',
                    pos: 'v.',
                    clueType: '助動詞 could 後接原形動詞',
                    explanation: '語意指瀕危語言在本世紀結束前可能「消失（vanish）」。'
                },
                {
                    num: 2,
                    word: 'oral',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞 traditions',
                    explanation: '與後面 without written dictionaries 對比，說明這些語言僅存在於「口述（oral）」傳統中。'
                },
                {
                    num: 3,
                    word: 'preserve',
                    pos: 'v.',
                    clueType: '現在式動詞',
                    explanation: '受詞為 their heritage（他們的文化遺產），表示數位檔案改變了族群「保存（preserve）」文化的方式。'
                },
                {
                    num: 4,
                    word: 'portable',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞 devices',
                    explanation: '與前文 heavy equipment 形成對比，指用「輕便攜帶式的（portable）」手機裝置錄音。'
                },
                {
                    num: 5,
                    word: 'access',
                    pos: 'v.',
                    clueType: '情態動詞 can 後接原形動詞',
                    explanation: '關係代名詞 that 引導修飾 databases，表示任何人都可以在線上免費「存取、使用（access）」。'
                },
                {
                    num: 6,
                    word: 'launched',
                    pos: 'v.',
                    clueType: '過去分詞（完成式 have + p.p.）',
                    explanation: '現在完成式 have + 過去分詞，受詞為 interactive games，意指學校已「推出（launched）」互動遊戲。'
                },
                {
                    num: 7,
                    word: 'vibrant',
                    pos: 'adj.',
                    clueType: '形容詞作感官動詞補語',
                    explanation: 'feel 後接形容詞，且與後面的 outdated（過時）相反，呈現「充滿活力的（vibrant）」。'
                },
                {
                    num: 8,
                    word: 'generate',
                    pos: 'v.',
                    clueType: '助動詞 cannot 後接原形動詞',
                    explanation: '科技無法在一夕之間「產生、培養出（generate）」流利的母語者。'
                },
                {
                    num: 9,
                    word: 'interaction',
                    pos: 'n.',
                    clueType: '名詞受詞',
                    explanation: '接在形容詞 daily 與介系詞 between generations 之間，強調世代之間日常的「互動（interaction）」。'
                },
                {
                    num: 10,
                    word: 'living',
                    pos: 'adj.',
                    clueType: '形容詞修飾名詞 conversations',
                    explanation: '將封存的錄音帶回餐桌上成為「活生生的、鮮活的（living）」日常對話，呼應全文主旨 keeping a language alive。'
                }
            ]
        }
    ];

    const state = {
        source: 'gsat_bank',       // 'gsat_bank' | 'deck_ai'
        curatedIndex: 0,
        isLoading: false,
        showPosHint: false,        // 練習輔助開關：是否於選項池顯示詞性提示
        passage: null,             // 正規化後之 10 選 10 題組
        targetCards: [],           // 若連動字庫，保存對應卡片參考
        activeBlankNum: 1,         // 目前作用中的空格題號 (1~10)
        selections: {},            // { 1: 'A', 2: 'C', ... } (題號 -> 選項代號)
        isSubmitted: false,
        resultSummary: null
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

    function tokenizeEn(text) {
        if (!text) return '';
        if (global.ReaderPopover && typeof global.ReaderPopover.tokenizeEnglishText === 'function') {
            return global.ReaderPopover.tokenizeEnglishText(text);
        }
        return escapeHtml(text);
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
     * 🎯 從「英文隔離池 + 勾選字庫」挑選最多 10 個（優先 6~10 個）單字
     */
    function pickDeckTargetCardsForCloze10() {
        const pool = (typeof global.getQuizLanguageFilteredPool === 'function')
            ? global.getQuizLanguageFilteredPool('en', { requireMeaning: true })
            : [];
        if (pool.length === 0) return [];
        const sorted = pool.slice().sort((a, b) => {
            const diff = (Number(a.freeLevel) || 1) - (Number(b.freeLevel) || 1);
            if (diff !== 0) return diff;
            return Math.random() - 0.5;
        });
        const topSlice = sorted.slice(0, Math.min(sorted.length, 18));
        return shuffleList(topSlice).slice(0, Math.min(10, topSlice.length));
    }

    /**
     * 🔧 正規化並隨機打亂 10 選 10 選項編號 (A)~(J)
     */
    function normalizeCloze10Set(raw, pickedCards = []) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.paragraphs) || raw.paragraphs.length === 0) {
            throw new Error('文意選填文章格式不完整，請重新出題');
        }
        const rawBlanks = Array.isArray(raw.blanks) ? raw.blanks : [];
        if (rawBlanks.length < 10) {
            throw new Error('AI 未產生完整的 10 個空格題目，請重新出題');
        }

        const deckCardMap = new Map();
        pickedCards.forEach(c => {
            if (c && c.word) deckCardMap.set(c.word.trim().toLowerCase(), c);
        });

        const blanksNormalized = rawBlanks.slice(0, 10).map((b, idx) => {
            const num = idx + 1;
            const word = String(b && b.word ? b.word : '').trim();
            if (!word) throw new Error(`第 ${num} 格缺少正確單字`);

            const normWord = word.toLowerCase();
            let matchedCard = deckCardMap.get(normWord) || null;
            if (!matchedCard && deckCardMap.size > 0) {
                for (const [k, card] of deckCardMap.entries()) {
                    if (normWord.startsWith(k) || k.startsWith(normWord)) {
                        if (Math.abs(normWord.length - k.length) <= 3) {
                            matchedCard = card;
                            break;
                        }
                    }
                }
            }

            return {
                num,
                word,
                pos: String((b && b.pos) || '').trim(),
                clueType: String((b && b.clueType) || '').trim(),
                explanation: String((b && b.explanation) || '').trim(),
                deckCard: matchedCard
            };
        });

        // 隨機打亂 10 個選項，分配代號 (A)~(J) 避免順序洩題
        let shuffledItems = shuffleList(blanksNormalized.map(b => ({
            num: b.num,
            word: b.word,
            pos: b.pos,
            deckCard: b.deckCard
        })));
        if (shuffledItems.every((item, i) => item.num === i + 1)) {
            shuffledItems = shuffledItems.slice(1).concat(shuffledItems[0]);
        }

        const wordBank = shuffledItems.map((item, idx) => ({
            key: OPTION_KEYS[idx],
            word: item.word,
            pos: item.pos,
            blankNum: item.num,
            deckCard: item.deckCard
        }));

        const numToKeyMap = new Map(wordBank.map(opt => [opt.blankNum, opt.key]));
        const finalBlanks = blanksNormalized.map(b => ({
            ...b,
            answerKey: numToKeyMap.get(b.num) || 'A'
        }));

        return {
            id: String(raw.id || ('cloze10_' + Date.now())),
            topic: String(raw.topic || '學測文意選填').trim(),
            title: String(raw.title || 'GSAT 10-Choose-10 Cloze').trim(),
            paragraphs: raw.paragraphs.map(p => String(p || '').trim()).filter(Boolean),
            blanks: finalBlanks,
            wordBank,
            targetCards: pickedCards
        };
    }

    /**
     * 📖 載入 10 選 10 題組
     */
    async function loadCloze10Passage(forceAi = false) {
        if (state.isLoading) return;

        state.selections = {};
        state.activeBlankNum = 1;
        state.isSubmitted = false;
        state.resultSummary = null;

        if (state.source === 'gsat_bank' && !forceAi) {
            const idx = state.curatedIndex % CURATED_GSAT_CLOZE10.length;
            state.curatedIndex = (idx + 1) % CURATED_GSAT_CLOZE10.length;
            state.targetCards = [];
            state.passage = normalizeCloze10Set(CURATED_GSAT_CLOZE10[idx], []);
            renderCloze10UI();
            return;
        }

        const isDeckSource = state.source === 'deck_ai';
        const pickedCards = isDeckSource ? pickDeckTargetCardsForCloze10() : [];
        if (isDeckSource && pickedCards.length === 0) {
            state.targetCards = [];
            state.passage = null;
            renderCloze10UI();
            return;
        }

        state.isLoading = true;
        state.targetCards = pickedCards;
        state.passage = null;
        renderCloze10UI();

        const deckBlock = isDeckSource
            ? `Incorporate as many of these user vocabulary words as possible (up to 10; fill any remaining blanks up to 10 using standard Taiwanese GSAT 7000-word vocabulary). Use exact inflection in the passage and avoid duplicate words across the 10 blanks:
${pickedCards.map(c => `- ${c.word} (${c.pos || 'word'}): ${c.meaning}`).join('\n')}`
            : 'Choose 10 distinct high-frequency Taiwanese GSAT (學測 7000 單) words across diverse parts of speech (nouns, verbs, adjectives, adverbs) that offer clear grammatical and semantic clues.';

        const prompt = `You are a senior Taiwanese GSAT (大學學測) English exam writer specializing in「文意選填 10 選 10」(10-blank rational cloze).
Write a cohesive 180–230 word English passage divided into 2 paragraphs with EXACTLY 10 blanks marked sequentially as [[BLANK_1]], [[BLANK_2]], ..., [[BLANK_10]].
${deckBlock}

CRITICAL RULES:
1. Every marker [[BLANK_1]] through [[BLANK_10]] MUST appear ONCE in paragraphs in increasing order (1 to 10).
2. The 10 answer words ("word") MUST be 10 distinct English words matching the exact grammatical form required by each blank (tense, plural, POS).
3. For each blank, provide "pos" (e.g. "n.", "v.", "adj.", "adv."), "clueType" (concise Traditional Chinese grammar clue e.g. "形容詞修飾名詞"), and "explanation" (concise Traditional Chinese explanation of syntax + context).

Return ONLY a single valid JSON object (no markdown fences):
{
  "topic": "2-4 char Traditional Chinese topic e.g. 生態保育",
  "title": "Engaging English Title",
  "paragraphs": ["Paragraph 1 with [[BLANK_1]]...", "Paragraph 2 ending with ...[[BLANK_10]]..."],
  "blanks": [
    { "num": 1, "word": "exactWord1", "pos": "v.", "clueType": "過去式動詞", "explanation": "繁體中文詳解..." }
  ]
}`;

        try {
            if (typeof global.callGeminiApi !== 'function') {
                throw new Error('AI 出題引擎尚未就緒');
            }
            const rawText = await global.callGeminiApi(prompt);
            const parsed = (typeof global.safeParseJSON === 'function') ? global.safeParseJSON(rawText) : JSON.parse(rawText);
            state.passage = normalizeCloze10Set(parsed, pickedCards);
        } catch (err) {
            console.error('[QuizCloze10] AI 出題失敗:', err);
            state.passage = { error: err && err.message ? err.message : '生成文意選填題組失敗，請稍後重試' };
        } finally {
            state.isLoading = false;
            renderCloze10UI();
        }
    }

    function setSource(src) {
        state.source = (src === 'deck_ai') ? 'deck_ai' : 'gsat_bank';
        return loadCloze10Passage(false);
    }

    function togglePosHint() {
        state.showPosHint = !state.showPosHint;
        renderCloze10UI();
    }

    /**
     * 🎯 點擊文章內空格：若已填則清除該格並設為作用中；若未填則聚焦該格
     */
    function handleBlankClick(blankNum) {
        if (state.isSubmitted || !state.passage) return;
        const num = Number(blankNum);
        if (state.selections[num]) {
            delete state.selections[num];
        }
        state.activeBlankNum = num;
        renderCloze10UI();
    }

    /**
     * 🎯 點擊下方 (A)~(J) 選項：填入目前作用中空格，並自動跳至下一個未填空格
     */
    function selectWordBankOption(optKey) {
        if (state.isSubmitted || !state.passage) return;
        const key = String(optKey || '').toUpperCase();
        if (!OPTION_KEYS.includes(key)) return;

        const targetNum = state.activeBlankNum || 1;
        const currentInTarget = state.selections[targetNum];

        // 若點擊的是同一格已填入的選項，則取消填入
        if (currentInTarget === key) {
            delete state.selections[targetNum];
            renderCloze10UI();
            return;
        }

        // 若此選項原先已填在另一格，先從舊格移除（維持 10 選 10 互斥）
        for (const [bNumStr, chosenKey] of Object.entries(state.selections)) {
            if (chosenKey === key) {
                delete state.selections[bNumStr];
            }
        }

        state.selections[targetNum] = key;

        // 自動跳往下一格尚未作答的空格 (先往後找，找不到再從頭找)
        let nextUnfilled = null;
        for (let n = targetNum + 1; n <= 10; n++) {
            if (!state.selections[n]) {
                nextUnfilled = n;
                break;
            }
        }
        if (nextUnfilled === null) {
            for (let n = 1; n <= 10; n++) {
                if (!state.selections[n]) {
                    nextUnfilled = n;
                    break;
                }
            }
        }
        if (nextUnfilled !== null) {
            state.activeBlankNum = nextUnfilled;
        }

        renderCloze10UI();
    }

    function clearAllSelections() {
        if (state.isSubmitted) return;
        state.selections = {};
        state.activeBlankNum = 1;
        renderCloze10UI();
    }

    /**
     * ✅ 提交批改 10 選 10：顯示對錯、解析，並僅更新字庫單字之 freeLevel / freeStreak
     */
    function submitExam() {
        if (!state.passage || state.passage.error || state.isSubmitted) return;
        const blanks = state.passage.blanks || [];
        if (blanks.length === 0) return;

        const missing = blanks.filter(b => !state.selections[b.num]);
        if (missing.length > 0) {
            state.activeBlankNum = missing[0].num;
            renderCloze10UI();
            if (typeof global.showToast === 'function') {
                global.showToast(`尚有 ${missing.length} 格未作答（請先填第 ${missing[0].num} 格）`, 'warning');
            }
            return;
        }

        let correct = 0;
        const gradedWordsSet = new Set();

        blanks.forEach(b => {
            const ok = state.selections[b.num] === b.answerKey;
            if (ok) correct += 1;

            if (b.deckCard && typeof global.applyQuizFreeGrade === 'function') {
                global.applyQuizFreeGrade(b.deckCard, ok);
                gradedWordsSet.add(String(b.deckCard.word || '').trim().toLowerCase());
            }
        });

        const total = blanks.length;
        const accuracy = Math.round((correct / total) * 100);
        const passed = accuracy >= PASS_ACCURACY;

        if (state.targetCards.length > 0 && typeof global.applyQuizFreeGrade === 'function') {
            state.targetCards.forEach(card => {
                if (!card || !card.word) return;
                const key = card.word.trim().toLowerCase();
                if (!gradedWordsSet.has(key)) {
                    global.applyQuizFreeGrade(card, passed);
                    gradedWordsSet.add(key);
                }
            });
        }

        if (global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            try {
                global.GameEngine.awardProgression({
                    xp: passed ? 30 : 10,
                    coins: passed ? 12 : 3
                });
            } catch (e) {}
        }

        state.isSubmitted = true;
        state.resultSummary = { correct, total, accuracy, passed };
        renderCloze10UI();
    }

    function renderParagraphWithBlanks(paragraphText, passage) {
        const blankMap = new Map((passage.blanks || []).map(b => [b.num, b]));
        const optMap = new Map((passage.wordBank || []).map(o => [o.key, o]));

        const regex = /\[\[BLANK_(\d+)\]\]/g;
        let html = '';
        let lastIdx = 0;
        let match;

        while ((match = regex.exec(paragraphText)) !== null) {
            if (match.index > lastIdx) {
                html += tokenizeEn(paragraphText.slice(lastIdx, match.index));
            }

            const num = Number(match[1]);
            const blankInfo = blankMap.get(num);
            const chosenKey = state.selections[num] || '';
            const chosenOpt = chosenKey ? optMap.get(chosenKey) : null;

            if (!state.isSubmitted) {
                const isActive = state.activeBlankNum === num;
                let cls = 'inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-lg border font-sans text-xs sm:text-sm font-bold cursor-pointer transition align-baseline ';
                if (isActive) {
                    cls += 'bg-brand-100 dark:bg-sky-900/70 border-brand-500 text-brand-800 dark:text-sky-200 ring-2 ring-brand-400/50';
                } else if (chosenOpt) {
                    cls += 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-400 text-emerald-700 dark:text-emerald-300';
                } else {
                    cls += 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-brand-400';
                }
                const labelText = chosenOpt ? `(${chosenKey}) ${escapeHtml(chosenOpt.word)}` : '______';
                html += `<button type="button" onclick="QuizClozeModule.handleBlankClick(${num})" class="${cls}" title="${chosenOpt ? '點擊清除或更換此格' : '點擊選取第 ' + num + ' 格'}"><span class="text-[11px] opacity-75">(${num})</span><span>${labelText}</span></button>`;
            } else if (blankInfo) {
                const ok = chosenKey === blankInfo.answerKey;
                const ansHtml = tokenizeEn(blankInfo.word);
                if (ok) {
                    html += `<span class="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-lg border bg-emerald-50 dark:bg-emerald-950/50 border-emerald-400 text-emerald-800 dark:text-emerald-200 font-sans text-xs sm:text-sm font-bold"><span>(${num})</span><span class="font-serif">${ansHtml}</span></span>`;
                } else {
                    html += `<span class="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-lg border bg-rose-50 dark:bg-rose-950/50 border-rose-400 text-rose-800 dark:text-rose-200 font-sans text-xs sm:text-sm font-bold"><span>(${num})</span><span class="line-through opacity-65">${escapeHtml(chosenOpt ? chosenOpt.word : '未填')}</span><span>➔</span><span class="font-serif text-emerald-700 dark:text-emerald-300">${ansHtml}</span></span>`;
                }
            }

            lastIdx = regex.lastIndex;
        }

        if (lastIdx < paragraphText.length) {
            html += tokenizeEn(paragraphText.slice(lastIdx));
        }
        return html;
    }

    function renderCloze10UI() {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('quizClozeContainer');
        if (!container) return;

        const sourceTabsHtml = `
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button type="button" onclick="QuizClozeModule.setSource('gsat_bank')" class="py-2 px-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 ${state.source === 'gsat_bank' ? 'bg-brand-600 text-white border-brand-600 shadow-2xs' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'}">
                    <i class="fa-solid fa-graduation-cap"></i>
                    <span>大考高頻題材 10 選 10 模擬庫</span>
                </button>
                <button type="button" onclick="QuizClozeModule.setSource('deck_ai')" class="py-2 px-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 ${state.source === 'deck_ai' ? 'bg-brand-600 text-white border-brand-600 shadow-2xs' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>AI 結合勾選字庫原創 10 選 10</span>
                </button>
            </div>
        `;

        if (state.isLoading) {
            container.innerHTML = `
                <div class="space-y-4">
                    ${sourceTabsHtml}
                    <div class="py-10 text-center space-y-3">
                        <i class="fa-solid fa-puzzle-piece fa-beat-fade text-2xl text-brand-500"></i>
                        <p class="text-sm font-bold text-slate-800 dark:text-slate-100">正在生成學測級「文意選填 10 選 10」題組...</p>
                        ${state.targetCards.length > 0 ? `<div class="flex justify-center flex-wrap gap-1.5">${state.targetCards.map(c => `<span class="px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-900/50 text-brand-700 dark:text-sky-300 text-xs font-bold">${escapeHtml(c.word)}</span>`).join('')}</div>` : ''}
                    </div>
                </div>
            `;
            return;
        }

        if (!state.passage && state.source === 'deck_ai' && state.targetCards.length === 0) {
            container.innerHTML = `
                <div class="space-y-4">
                    ${sourceTabsHtml}
                    <div class="py-8 text-center space-y-2.5">
                        <div class="w-11 h-11 rounded-2xl bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto text-lg">
                            <i class="fa-solid fa-filter"></i>
                        </div>
                        <p class="text-sm font-bold text-slate-800 dark:text-slate-100">目前勾選字庫中沒有可用的英文單字</p>
                        <p class="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                            請於首頁勾選英文單字庫，或切換上方題源為「大考高頻題材 10 選 10 模擬庫」直接作答！
                        </p>
                    </div>
                </div>
            `;
            return;
        }

        if (state.passage && state.passage.error) {
            container.innerHTML = `
                <div class="space-y-4">
                    ${sourceTabsHtml}
                    <div class="py-8 text-center space-y-3">
                        <p class="text-sm font-bold text-rose-600 dark:text-rose-400">${escapeHtml(state.passage.error)}</p>
                        <button type="button" onclick="QuizClozeModule.loadPassage(true)" class="px-4 py-2 rounded-xl bg-brand-600 text-white text-xs font-bold">重試生成</button>
                    </div>
                </div>
            `;
            return;
        }

        const p = state.passage;
        if (!p) return;

        // 反查每個選項代號目前被填入哪一題號
        const keyToBlankNum = new Map();
        Object.entries(state.selections).forEach(([bNumStr, optKey]) => {
            keyToBlankNum.set(optKey, Number(bNumStr));
        });
        const filledCount = Object.keys(state.selections).length;

        const controlsBarHtml = `
            <div class="flex items-center flex-wrap justify-between gap-2">
                <div class="flex items-center flex-wrap gap-2">
                    <span class="px-2.5 py-1 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold">${escapeHtml(p.topic)}</span>
                    <span class="text-xs font-bold text-slate-500 dark:text-slate-400">作答進度：${filledCount} / 10</span>
                    <button type="button" onclick="QuizClozeModule.togglePosHint()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${state.showPosHint ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-400 text-amber-700 dark:text-amber-300' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'}">
                        <i class="fa-regular fa-lightbulb mr-1"></i>${state.showPosHint ? '已開啟詞性提示' : '詞性輔助提示'}
                    </button>
                </div>
                <div class="flex items-center gap-1.5">
                    ${!state.isSubmitted && filledCount > 0 ? `
                        <button type="button" onclick="QuizClozeModule.clearAll()" class="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-xs font-bold transition">清空</button>
                    ` : ''}
                    ${state.source === 'gsat_bank' ? `
                        <button type="button" onclick="QuizClozeModule.loadPassage(false)" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
                            <i class="fa-solid fa-forward mr-1"></i>下一篇
                        </button>
                        <button type="button" onclick="QuizClozeModule.loadPassage(true)" class="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-xs font-bold transition">
                            <i class="fa-solid fa-sparkles mr-1"></i>AI 新生成
                        </button>
                    ` : `
                        <button type="button" onclick="QuizClozeModule.loadPassage(true)" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
                            <i class="fa-solid fa-arrows-rotate mr-1"></i>AI 換一篇
                        </button>
                    `}
                </div>
            </div>
        `;

        // 10 選 10 選項詞彙池
        const wordBankHtml = `
            <div class="p-3.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/80 dark:border-indigo-800/70 space-y-2.5">
                <div class="flex items-center justify-between flex-wrap gap-2">
                    <p class="text-xs font-extrabold text-indigo-800 dark:text-indigo-200 flex items-center gap-1.5">
                        <i class="fa-solid fa-table-cells"></i>
                        <span>選項詞彙庫 (A)～(J)</span>
                    </p>
                    ${!state.isSubmitted ? `
                        <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-brand-100 dark:bg-sky-900/60 text-brand-700 dark:text-sky-300">
                            目前作用中空格：第 (${state.activeBlankNum}) 格
                        </span>
                    ` : '<span class="text-[11px] font-semibold text-brand-600 dark:text-sky-400">💡 點擊單字可查義與加入字庫</span>'}
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    ${p.wordBank.map(opt => {
                        const usedInNum = keyToBlankNum.get(opt.key);
                        const isUsedInActive = usedInNum === state.activeBlankNum;
                        let cardCls = 'px-2.5 py-2 rounded-xl border text-left transition flex flex-col gap-0.5 ';
                        if (state.isSubmitted) {
                            cardCls += 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100';
                        } else if (isUsedInActive) {
                            cardCls += 'bg-brand-600 border-brand-600 text-white shadow-xs';
                        } else if (usedInNum) {
                            cardCls += 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500';
                        } else {
                            cardCls += 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:border-brand-400 cursor-pointer';
                        }
                        const wordInner = state.isSubmitted ? tokenizeEn(opt.word) : escapeHtml(opt.word);
                        if (state.isSubmitted) {
                            return `
                                <div class="${cardCls}">
                                    <div class="flex items-center justify-between gap-1">
                                        <span class="text-[11px] font-extrabold text-indigo-600 dark:text-indigo-400">(${opt.key})</span>
                                        <span class="text-[10px] font-bold text-slate-400">第 ${opt.blankNum} 格</span>
                                    </div>
                                    <span class="font-serif text-sm font-bold truncate">${wordInner}</span>
                                    ${state.showPosHint && opt.pos ? `<span class="text-[10px] opacity-75">${escapeHtml(opt.pos)}</span>` : ''}
                                </div>
                            `;
                        }
                        return `
                            <button type="button" onclick="QuizClozeModule.selectOption('${opt.key}')" class="${cardCls}">
                                <div class="flex items-center justify-between gap-1">
                                    <span class="text-[11px] font-extrabold ${isUsedInActive ? 'text-white' : 'text-indigo-600 dark:text-indigo-400'}">(${opt.key})</span>
                                    ${usedInNum ? `<span class="text-[10px] font-bold ${isUsedInActive ? 'text-sky-100' : 'text-emerald-600 dark:text-emerald-400'}">→ (${usedInNum})</span>` : ''}
                                </div>
                                <span class="font-serif text-sm font-bold truncate">${wordInner}</span>
                                ${state.showPosHint && opt.pos ? `<span class="text-[10px] opacity-75">${escapeHtml(opt.pos)}</span>` : ''}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        // 文章區
        const targetBarHtml = state.targetCards.length > 0
            ? `<div class="flex items-center flex-wrap gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span class="font-bold">🎯 本篇融入字庫單字：</span>
                    ${state.targetCards.map(c => `<span class="px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-sky-300 font-bold border border-brand-200 dark:border-brand-800">${escapeHtml(c.word)}</span>`).join('')}
               </div>`
            : '';

        const passageHtml = `
            <div class="p-4 sm:p-5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700 space-y-3">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <h3 class="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white">${escapeHtml(p.title)}</h3>
                    <span class="text-[11px] text-brand-600 dark:text-sky-400 font-semibold">💡 點擊文章任意單字可即時查字</span>
                </div>
                ${targetBarHtml}
                <div class="space-y-3 font-serif text-sm sm:text-base leading-loose text-slate-800 dark:text-slate-100">
                    ${p.paragraphs.map(para => `<p>${renderParagraphWithBlanks(para, p)}</p>`).join('')}
                </div>
            </div>
        `;

        // 交卷後逐格詳解區
        const explanationsHtml = state.isSubmitted
            ? `
                <div class="space-y-2.5">
                    <h4 class="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <i class="fa-solid fa-list-check text-brand-500"></i>
                        <span>10 格語法線索與逐題詳解</span>
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        ${p.blanks.map(b => {
                            const userKey = state.selections[b.num] || '';
                            const ok = userKey === b.answerKey;
                            return `
                                <div class="p-3 rounded-xl border ${ok ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20' : 'border-rose-200 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20'} space-y-1">
                                    <div class="flex items-center justify-between gap-2 flex-wrap text-xs font-bold">
                                        <span class="${ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}">
                                            ${ok ? '✓' : '✗'} 第 (${b.num}) 格：(${b.answerKey}) ${tokenizeEn(b.word)}
                                        </span>
                                        <span class="px-2 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] text-slate-600 dark:text-slate-300">
                                            ${escapeHtml(b.pos)} ${b.clueType ? '· ' + escapeHtml(b.clueType) : ''}
                                        </span>
                                    </div>
                                    ${!ok ? `<p class="text-[11px] text-rose-600 dark:text-rose-400">你的作答：(${escapeHtml(userKey || '未填')})</p>` : ''}
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">${escapeHtml(b.explanation)}</p>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `
            : '';

        const footerActionHtml = state.isSubmitted && state.resultSummary
            ? `
                <div class="p-4 rounded-xl border ${state.resultSummary.passed ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100' : 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100'} flex items-center justify-between flex-wrap gap-2">
                    <div class="space-y-0.5">
                        <p class="text-sm font-extrabold">
                            ${state.resultSummary.passed ? '🎉 文意選填達標！' : '📝 測驗完成！'} 答對 ${state.resultSummary.correct} / ${state.resultSummary.total} 格（${state.resultSummary.accuracy}%）
                        </p>
                        <p class="text-xs opacity-85">
                            ${state.targetCards.length > 0 ? '已依作答結果更新本篇字庫單字之「臨時等級」，FSRS 排程維持不變。' : '模擬題庫練習已完成，已發放練習經驗值（FSRS 排程未更動）。'}
                        </p>
                    </div>
                    <button type="button" onclick="QuizClozeModule.loadPassage(${state.source === 'deck_ai'})" class="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold shadow-xs transition">
                        再練一篇
                    </button>
                </div>
            `
            : `
                <button type="button" onclick="QuizClozeModule.submitExam()" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold shadow-sm transition">
                    提交批改 10 選 10 並查看詳解
                </button>
            `;

        container.innerHTML = `
            <div class="space-y-4">
                ${sourceTabsHtml}
                ${controlsBarHtml}
                ${wordBankHtml}
                ${passageHtml}
                ${explanationsHtml}
                ${footerActionHtml}
            </div>
        `;

        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function') {
            global.ReaderPopover.bindReaderContainer(container);
        }
    }

    function activateMode() {
        if (!state.passage && !state.isLoading) {
            return loadCloze10Passage(false);
        }
        renderCloze10UI();
        return Promise.resolve();
    }

    const QuizClozeModule = {
        activateMode,
        loadPassage: loadCloze10Passage,
        setSource,
        togglePosHint,
        handleBlankClick,
        selectOption: selectWordBankOption,
        clearAll: clearAllSelections,
        submitExam,
        renderUI: renderCloze10UI,
        normalizeCloze10Set,
        CURATED_GSAT_CLOZE10,
        _state: state
    };

    if (typeof global !== 'undefined') {
        global.QuizClozeModule = QuizClozeModule;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = QuizClozeModule;
    }
})(typeof window !== 'undefined' ? window : globalThis);
