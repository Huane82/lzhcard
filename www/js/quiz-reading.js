/**
 * LZHCard - 考試模式三：學測型綜合閱讀與篇章結構測驗 (js/quiz-reading.js)
 * Phase 3 (模組 B)：
 * 1. 雙題源切換：「AI 結合勾選字庫原創學測風短文」 vs 「大考歷屆高頻題材模擬題庫」
 * 2. 複合題型切換：「全真混合」、「綜合測驗 (四選一克漏字)」、「篇章結構 (句子還原)」
 * 3. 完整整合共用元件 `ReaderPopover`：文章與選項中英文單字皆可點擊即時翻譯與一鍵加字庫
 * 4. 結算僅更新對應字庫單字之 `freeLevel` 與 `freeStreak`，絕對不動 FSRS 排程欄位
 */
(function (global) {
    'use strict';

    const PASS_ACCURACY = 70;

    // 📚 內建大考歷屆高頻題材模擬題庫（150~230字標準學測難度，零等待離線可考）
    const CURATED_GSAT_PASSAGES = [
        {
            id: 'gsat_env_microforest',
            topic: '環境永續',
            title: 'Urban Microforests: Cooling Concrete Cities',
            paragraphs: [
                'As global temperatures continue to climb, densely populated cities suffer intensely from the urban heat island effect, where asphalt roads and concrete buildings trap solar radiation long after sunset. In response to this pressing challenge, urban planners across Asia and Europe are turning to an innovative yet surprisingly compact solution: the Miyawaki microforest. [[CLOZE_1]] traditional city parks that rely on manicured lawns and widely spaced ornamental trees, a microforest packs dozens of native plant species into an area no larger than a tennis court. [[DISC_1]]',
                'Because native saplings compete closely for sunlight and underground nutrients, they grow up to ten times faster than trees planted in conventional landscapes. [[CLOZE_2]] just two or three decades, a patch of barren industrial land can transform into a self-sustaining, multi-layered woodland. Measurements taken during peak summer afternoons reveal that soil and air temperatures inside these miniature jungles remain [[CLOZE_3]] lower than those on nearby streets. [[DISC_2]] Beyond regulating local climates, microforests also absorb heavy stormwater runoff and shelter migratory birds and pollinators. While a single pocket forest cannot reverse planetary warming on its own, linking hundreds of these green islands across neighborhoods demonstrates how ecological restoration can [[CLOZE_4]] even within the tightest urban footprints. [[DISC_3]]'
            ],
            clozeQuestions: [
                {
                    id: 'CLOZE_1',
                    num: 1,
                    options: ['Unlike', 'Despite', 'Besides', 'Through'],
                    answerIndex: 0,
                    explanation: '前句提到傳統公園使用修剪草坪與寬距觀賞樹，後句說明微森林將數十種原生植物密集種在網球場大的空間，兩者形成強烈對比，故選 Unlike（不像…）。'
                },
                {
                    id: 'CLOZE_2',
                    num: 2,
                    options: ['Within', 'Beyond', 'Among', 'Except'],
                    answerIndex: 0,
                    explanation: '搭配時間詞 two or three decades 表示「在二、三十年之內」荒地就能蛻變成自給自足的林地，故選介系詞 Within。'
                },
                {
                    id: 'CLOZE_3',
                    num: 3,
                    options: ['significantly', 'accidentally', 'temporarily', 'suspiciously'],
                    answerIndex: 0,
                    explanation: '句意為「夏季午後測量顯示，迷你森林內的氣溫比鄰近街道明顯更低」，significantly（顯著地、大幅地）最符合語意。'
                },
                {
                    id: 'CLOZE_4',
                    num: 4,
                    options: ['thrive', 'hesitate', 'collapse', 'postpone'],
                    answerIndex: 0,
                    explanation: '即使在最狹窄的城市空間裡，生態復育依然能「蓬勃發展（thrive）」，符合全文正向語氣。'
                }
            ],
            discoursePool: [
                { key: 'A', text: 'Within three years, the dense canopy typically requires little watering or human maintenance.' },
                { key: 'B', text: 'This cooling shade offers immediate relief to elderly residents and commuters walking nearby.' },
                { key: 'C', text: 'Cities that embrace this bottom-up greening model often witness stronger community pride as well.' },
                { key: 'D', text: 'By contrast, many suburban shopping malls have expanded their indoor parking garages since 2010.' }
            ],
            discourseQuestions: [
                {
                    id: 'DISC_1',
                    label: '篇章空格 [1]',
                    answerKey: 'A',
                    explanation: '前一句剛介紹微森林密集種植數十種原生植物，[A] 句承接說明密集樹冠在三年內便幾乎不需澆水與人工維護，並順暢銜接下一段「因為樹苗彼此競爭陽光…」的生長機制。'
                },
                {
                    id: 'DISC_2',
                    label: '篇章空格 [2]',
                    answerKey: 'B',
                    explanation: '前句測量出樹林內氣溫顯著低於鄰近街道，[B] 句以 This cooling shade（這片涼爽樹蔭）回指降溫效果，說明對長者與通勤族的直接幫助。'
                },
                {
                    id: 'DISC_3',
                    label: '篇章空格 [3]',
                    answerKey: 'C',
                    explanation: '位於全文結尾，前句強調串聯數百座綠色島嶼的生態成效，[C] 句進一步總結這種由下而上的綠化模式也提升了社區凝聚力與榮譽感。([D] 為離題干擾句)'
                }
            ],
            comprehensionQuestions: [
                {
                    id: 'COMP_1',
                    question: 'What is the main reason saplings in a Miyawaki microforest grow much faster than those in regular city parks?',
                    options: [
                        'They are genetically modified to resist urban pollution.',
                        'Close competition for light and nutrients accelerates their upward growth.',
                        'Park staff apply synthetic fertilizers to the soil every week.',
                        'They are planted strictly on rooftops rather than ground level.'
                    ],
                    answerIndex: 1,
                    explanation: '第二段第一句明確指出：Because native saplings compete closely for sunlight and underground nutrients, they grow up to ten times faster...'
                }
            ]
        },
        {
            id: 'gsat_psych_handwriting',
            topic: '認知心理',
            title: 'Why Writing by Hand Still Sharpens Memory',
            paragraphs: [
                'In university lecture halls today, the steady tapping of laptop keyboards has largely replaced the scratch of pens on paper. Typing undeniably allows students to record spoken words far more rapidly, yet cognitive psychologists have repeatedly questioned whether speed translates into deeper comprehension. [[DISC_1]] In a series of brain-imaging experiments, researchers compared participants who took notes digitally with those who wrote summaries in traditional notebooks. When students typed on a keyboard, they tended to [[CLOZE_1]] sentences verbatim without filtering key concepts.',
                'Handwriting, by contrast, is physically slower, forcing the brain to listen actively, evaluate ideas, and [[CLOZE_2]] information into concise phrases before putting ink to page. [[DISC_2]] Electroencephalogram scans confirmed that forming distinct letter strokes activates broader neural networks across regions linked to motor control and long-term memory consolidation. [[CLOZE_3]] keyboarding relies on repetitive, uniform finger taps, handwriting demands continuous visual-spatial coordination. Therefore, educators suggest that students [[CLOZE_4]] a hybrid strategy: use digital devices for organizing references, but keep a pen handy when mastering complex theories. [[DISC_3]]'
            ],
            clozeQuestions: [
                {
                    id: 'CLOZE_1',
                    num: 1,
                    options: ['transcribe', 'criticize', 'decorate', 'abandon'],
                    answerIndex: 0,
                    explanation: '搭配後面 verbatim（逐字地）與 without filtering key concepts（未篩選重點），transcribe（抄錄、轉錄）最符合打字筆記的行為描述。'
                },
                {
                    id: 'CLOZE_2',
                    num: 2,
                    options: ['condense', 'scatter', 'imitate', 'neglect'],
                    answerIndex: 0,
                    explanation: '手寫速度較慢，迫使大腦評估觀點並將資訊「濃縮（condense）」成簡潔短語再落筆。'
                },
                {
                    id: 'CLOZE_3',
                    num: 3,
                    options: ['Whereas', 'Unless', 'Provided', 'Because'],
                    answerIndex: 0,
                    explanation: '前後兩個子句對比「打字依賴單一重複按鍵」與「手寫需要持續視覺空間協調」，故選表對比的連接詞 Whereas（然而、反觀）。'
                },
                {
                    id: 'CLOZE_4',
                    num: 4,
                    options: ['adopt', 'cancel', 'forbid', 'ignore'],
                    answerIndex: 0,
                    explanation: 'suggest that + S + (should) + 原形動詞，建議學生「採納（adopt）」混合學習策略。'
                }
            ],
            discoursePool: [
                { key: 'A', text: 'Surprisingly, those who produced shorter handwritten notes outperformed fast typists on conceptual tests.' },
                { key: 'B', text: 'This deliberate mental processing acts like a filter that strengthens understanding from the very first moment.' },
                { key: 'C', text: 'Ultimately, the goal of note-taking is not merely storing data externally, but reshaping how we think.' },
                { key: 'D', text: 'Fountain pens were originally invented in the nineteenth century to prevent ink spills during travel.' }
            ],
            discourseQuestions: [
                {
                    id: 'DISC_1',
                    label: '篇章空格 [1]',
                    answerKey: 'A',
                    explanation: '前句提出疑問「打字快是否代表理解更深？」；[A] 句以 Surprisingly 回答「手寫筆記較簡短的人在概念測驗表現反而勝過快打字者」，自然引出後文的腦造影實驗。'
                },
                {
                    id: 'DISC_2',
                    label: '篇章空格 [2]',
                    answerKey: 'B',
                    explanation: '前句描述手寫迫使大腦主動傾聽、評估與濃縮資訊，[B] 句用 This deliberate mental processing（這種刻意的心智加工）完美指代該過程。'
                },
                {
                    id: 'DISC_3',
                    label: '篇章空格 [3]',
                    answerKey: 'C',
                    explanation: '結尾建議採取混合策略後，[C] 句以 Ultimately 做出全文核心收尾：做筆記的目標不只是外部儲存資料，而是重塑思考方式。([D] 為無關歷史細節)'
                }
            ],
            comprehensionQuestions: [
                {
                    id: 'COMP_1',
                    question: 'According to the passage, what advantage does a hybrid note-taking strategy offer?',
                    options: [
                        'It eliminates the need to review lecture materials before exams.',
                        'It pairs digital organization efficiency with deeper cognitive encoding from handwriting.',
                        'It helps typists reach higher word-per-minute speeds during seminars.',
                        'It completely bans laptops from university lecture halls.'
                    ],
                    answerIndex: 1,
                    explanation: '文章末段指出數位裝置適合整理參考資料，而手寫能深化複雜理論的記憶與理解，結合兩者優勢。'
                }
            ]
        },
        {
            id: 'gsat_sci_bioluminescence',
            topic: '自然科普',
            title: 'Living Lanterns of the Midnight Zone',
            paragraphs: [
                'More than two hundred meters beneath the ocean surface lies the twilight zone, a vast realm where sunlight fades into near-total darkness. In this cold, high-pressure environment, roughly three-quarters of marine organisms possess an extraordinary ability known as bioluminescence—the production of visible light through internal chemical reactions. [[DISC_1]] Unlike ordinary household bulbs that waste considerable energy as heat, biological light is nearly one hundred percent efficient, earning it the nickname "cold light."',
                'Deep-sea creatures [[CLOZE_1]] this glowing talent for remarkably diverse purposes. Some species of squid eject clouds of luminous fluid to [[CLOZE_2]] pursuing predators, escaping safely while the attacker remains momentarily blinded. Meanwhile, the female anglerfish dangles a glowing lure just in front of her jaws, patiently waiting for curious prey to approach within [[CLOZE_3]] distance. [[DISC_2]] Scientists have even discovered that certain jellyfish flash rhythmic blue patterns along their bells as warning signals to deter hungry neighbors. Today, medical researchers study marine glowing proteins to track cancer cells inside living tissues, proving that nature’s darkest depths still hold [[CLOZE_4]] insights for human health. [[DISC_3]]'
            ],
            clozeQuestions: [
                {
                    id: 'CLOZE_1',
                    num: 1,
                    options: ['deploy', 'forgive', 'impose', 'overlook'],
                    answerIndex: 0,
                    explanation: '深海生物「運用、部署（deploy）」這種發光天賦於多元用途（誘敵、逃生、警示），符合語意。'
                },
                {
                    id: 'CLOZE_2',
                    num: 2,
                    options: ['startle', 'invite', 'reward', 'persuade'],
                    answerIndex: 0,
                    explanation: '烏賊噴出冷光液體是為了「驚嚇、使…突受驚擾（startle）」追捕者並趁機逃脫。'
                },
                {
                    id: 'CLOZE_3',
                    num: 3,
                    options: ['striking', 'distant', 'generous', 'peaceful'],
                    answerIndex: 0,
                    explanation: '固定搭配 within striking distance（在攻擊／觸及範圍之內）。'
                },
                {
                    id: 'CLOZE_4',
                    num: 4,
                    options: ['invaluable', 'irrelevant', 'fragile', 'outdated'],
                    answerIndex: 0,
                    explanation: '醫學研究利用海洋發光蛋白追蹤癌細胞，證明深海仍蘊含「極為寶貴的（invaluable）」洞見。'
                }
            ],
            discoursePool: [
                { key: 'A', text: 'When a molecule called luciferin reacts with oxygen in the presence of an enzyme, a gentle glow emerges.' },
                { key: 'B', text: 'Other bottom-dwelling fish use faint belly lights to match overhead starlight and erase their own shadows.' },
                { key: 'C', text: 'Protecting fragile deep-sea ecosystems therefore safeguards not only ocean biodiversity but future medical breakthroughs.' },
                { key: 'D', text: 'Commercial fishing fleets typically operate closer to coastal ports during stormy winter months.' }
            ],
            discourseQuestions: [
                {
                    id: 'DISC_1',
                    label: '篇章空格 [1]',
                    answerKey: 'A',
                    explanation: '前句定義 bioluminescence 為體內化學反應產生可見光，[A] 句緊接著解釋冷光反應的化學機制（螢光素與氧氣在酵素催化下發光）。'
                },
                {
                    id: 'DISC_2',
                    label: '篇章空格 [2]',
                    answerKey: 'B',
                    explanation: '該段依序列舉深海生物發光的各種生存策略（烏賊噴光逃生、鮟鱇魚誘餌），[B] 句以 Other bottom-dwelling fish 補充「消影偽裝（counter-illumination）」策略，結構連貫。'
                },
                {
                    id: 'DISC_3',
                    label: '篇章空格 [3]',
                    answerKey: 'C',
                    explanation: '前句點出海洋發光蛋白對人類醫學的貢獻，[C] 句以 therefore 做出保護深海生態系對未來醫學同樣關鍵的結論。'
                }
            ],
            comprehensionQuestions: [
                {
                    id: 'COMP_1',
                    question: 'Why is bioluminescence often referred to as "cold light"?',
                    options: [
                        'It only works in freezing polar oceans.',
                        'The chemical reaction emits light while releasing almost no wasted heat.',
                        'It lowers the body temperature of predators that approach it.',
                        'It fades away whenever water temperatures rise above zero.'
                    ],
                    answerIndex: 1,
                    explanation: '第一段末句說明生物發光不像一般燈泡會浪費大量熱能，效率接近百分之百，因此被稱為冷光。'
                }
            ]
        },
        {
            id: 'gsat_culture_slowtravel',
            topic: '文化社會',
            title: 'Slow Travel: Rediscovering Meaning Beyond Checklists',
            paragraphs: [
                'For decades, international tourism often resembled a frantic race against the clock. Travelers rushed from one famous monument to the next, snapping quick photographs simply to prove they had been there. In recent years, however, a refreshing counter-movement known as "slow travel" has gained momentum among curious explorers. [[DISC_1]] Rather than squeezing five cities into a single week, slow travelers choose to [[CLOZE_1]] in one neighborhood long enough to learn the rhythm of daily life.',
                'Staying in a single community brings benefits that extend far beyond personal relaxation. When visitors shop at family-run bakeries, take local buses, and chat with artisan shopkeepers, tourist spending circulates [[CLOZE_2]] within the local economy instead of flowing exclusively to multinational hotel chains. [[DISC_2]] Moreover, lingering in one place reduces frequent flights and long-distance highway transfers, cutting a trip’s carbon footprint [[CLOZE_3]]. Of course, slow travel requires letting go of the fear of missing out on every famous attraction. Yet those who embrace it rarely regret trading packed itineraries for authentic memories that [[CLOZE_4]] long after their suitcases are unpacked. [[DISC_3]]'
            ],
            clozeQuestions: [
                {
                    id: 'CLOZE_1',
                    num: 1,
                    options: ['settle', 'hesitate', 'depart', 'interfere'],
                    answerIndex: 0,
                    explanation: '相較於一週趕五個城市，慢旅行者選擇在單一社區「住下來、停留（settle）」以體會日常生活節奏。'
                },
                {
                    id: 'CLOZE_2',
                    num: 2,
                    options: ['directly', 'secretly', 'carelessly', 'rarely'],
                    answerIndex: 0,
                    explanation: '在家庭烘焙坊消費、搭公車，使觀光收入能「直接（directly）」在當地經濟循環，而非全流向跨國連鎖飯店。'
                },
                {
                    id: 'CLOZE_3',
                    num: 3,
                    options: ['substantially', 'accidentally', 'narrowly', 'loosely'],
                    answerIndex: 0,
                    explanation: '減少頻繁搭機與長途拉車，能「大幅（substantially）」降低旅程碳足跡。'
                },
                {
                    id: 'CLOZE_4',
                    num: 4,
                    options: ['endure', 'vanish', 'borrow', 'complain'],
                    answerIndex: 0,
                    explanation: 'authentic memories that endure long after...（在行李拆封許久後依然長存的真實回憶），endure（持續、長存）最貼切。'
                }
            ],
            discoursePool: [
                { key: 'A', text: 'Its core philosophy prioritizes depth of connection over the sheer quantity of landmarks visited.' },
                { key: 'B', text: 'Such everyday encounters also foster genuine cultural respect between hosts and guests.' },
                { key: 'C', text: 'In the end, travel becomes less about collecting photos and more about experiencing how another corner of the world lives.' },
                { key: 'D', text: 'Airline baggage allowances have become increasingly strict on budget regional carriers.' }
            ],
            discourseQuestions: [
                {
                    id: 'DISC_1',
                    label: '篇章空格 [1]',
                    answerKey: 'A',
                    explanation: '前句剛介紹 slow travel 這股新潮流，[A] 句隨即闡明其核心理念（重視連結深度而非景點數量），並與下一句形成遞進。'
                },
                {
                    id: 'DISC_2',
                    label: '篇章空格 [2]',
                    answerKey: 'B',
                    explanation: '前句提到光顧當地小店與店主交談對地方經濟的幫助，[B] 句以 Such everyday encounters（這些日常互動）承接，補充其文化尊重層面的意義。'
                },
                {
                    id: 'DISC_3',
                    label: '篇章空格 [3]',
                    answerKey: 'C',
                    explanation: '最後一句做出全篇總結：旅行不再只是收集照片，而是體驗世界另一個角落如何生活。'
                }
            ],
            comprehensionQuestions: [
                {
                    id: 'COMP_1',
                    question: 'How does slow travel benefit local communities economically according to paragraph 2?',
                    options: [
                        'It encourages tourists to stay exclusively at multinational hotel resorts.',
                        'It keeps traveler spending inside small neighborhood businesses.',
                        'It increases ticket prices at famous national monuments.',
                        'It relies mainly on online souvenir deliveries.'
                    ],
                    answerIndex: 1,
                    explanation: '第二段指出旅客在當地麵包店與職人小店消費，讓金流直接留在社區經濟體系內。'
                }
            ]
        }
    ];

    const state = {
        source: 'gsat_bank',   // 'deck_ai' (AI 結合字庫) | 'gsat_bank' (大考模擬題庫)
        subFormat: 'mixed',    // 'mixed' (全真混合) | 'cloze' (綜合測驗克漏字) | 'discourse' (篇章結構)
        selectedTopic: '隨機題材',
        curatedIndex: 0,
        isLoading: false,
        passage: null,
        targetCards: [],       // 若由字庫出題，記錄對應字卡
        answers: {},           // { CLOZE_1: 0, DISC_1: 'A', COMP_1: 1 }
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

    function pickDeckTargetCardsForReading() {
        const pool = (typeof global.getQuizLanguageFilteredPool === 'function')
            ? global.getQuizLanguageFilteredPool('en', { requireMeaning: true })
            : [];
        if (pool.length === 0) return [];
        const sorted = pool.slice().sort((a, b) => {
            const diff = (Number(a.freeLevel) || 1) - (Number(b.freeLevel) || 1);
            if (diff !== 0) return diff;
            return Math.random() - 0.5;
        });
        const count = Math.min(pool.length, Math.min(6, Math.max(4, pool.length)));
        const slice = sorted.slice(0, Math.min(sorted.length, 14));
        return shuffleList(slice).slice(0, count);
    }

    function normalizeReadingSet(raw, targetCards = []) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.paragraphs) || raw.paragraphs.length === 0) {
            throw new Error('文章結構不完整，請重新出題');
        }

        const clozeQuestions = (Array.isArray(raw.clozeQuestions) ? raw.clozeQuestions : []).map((q, idx) => {
            const id = String(q && q.id ? q.id : `CLOZE_${idx + 1}`).trim();
            const num = Number(q && q.num) || (idx + 1);
            const options = Array.isArray(q && q.options) ? q.options.map(o => String(o).trim()).filter(Boolean) : [];
            const answerIndex = Math.min(Math.max(0, Number(q && q.answerIndex) || 0), Math.max(0, options.length - 1));
            return {
                id,
                num,
                targetWord: q && q.targetWord ? String(q.targetWord).trim() : '',
                options,
                answerIndex,
                explanation: String((q && q.explanation) || '').trim()
            };
        }).filter(q => q.options.length >= 2);

        const discoursePool = (Array.isArray(raw.discoursePool) ? raw.discoursePool : []).map((d, idx) => ({
            key: String((d && d.key) || String.fromCharCode(65 + idx)).trim().toUpperCase(),
            text: String((d && d.text) || '').trim()
        })).filter(d => d.text !== '');

        const discourseQuestions = (Array.isArray(raw.discourseQuestions) ? raw.discourseQuestions : []).map((q, idx) => ({
            id: String((q && q.id) || `DISC_${idx + 1}`).trim(),
            label: String((q && q.label) || `篇章空格 [${idx + 1}]`).trim(),
            answerKey: String((q && q.answerKey) || 'A').trim().toUpperCase(),
            explanation: String((q && q.explanation) || '').trim()
        }));

        const comprehensionQuestions = (Array.isArray(raw.comprehensionQuestions) ? raw.comprehensionQuestions : []).map((q, idx) => {
            const options = Array.isArray(q && q.options) ? q.options.map(o => String(o).trim()).filter(Boolean) : [];
            const answerIndex = Math.min(Math.max(0, Number(q && q.answerIndex) || 0), Math.max(0, options.length - 1));
            return {
                id: String((q && q.id) || `COMP_${idx + 1}`).trim(),
                question: String((q && q.question) || '').trim(),
                options,
                answerIndex,
                explanation: String((q && q.explanation) || '').trim()
            };
        }).filter(q => q.question && q.options.length >= 2);

        return {
            id: String(raw.id || ('ai_read_' + Date.now())),
            topic: String(raw.topic || '學測綜合閱讀').trim(),
            title: String(raw.title || 'GSAT Reading & Discourse Practice').trim(),
            paragraphs: raw.paragraphs.map(p => String(p || '').trim()).filter(Boolean),
            clozeQuestions,
            discoursePool,
            discourseQuestions,
            comprehensionQuestions,
            targetCards
        };
    }

    /**
     * 📖 載入題組：依題源切換「內建/AI 模擬題庫」或「AI 結合字庫原創短文」
     */
    async function loadReadingPassage(forceAiGsat = false) {
        if (state.isLoading) return;

        state.answers = {};
        state.isSubmitted = false;
        state.resultSummary = null;

        if (state.source === 'gsat_bank' && !forceAiGsat) {
            const nextIdx = (state.curatedIndex) % CURATED_GSAT_PASSAGES.length;
            state.curatedIndex = (nextIdx + 1) % CURATED_GSAT_PASSAGES.length;
            state.targetCards = [];
            state.passage = normalizeReadingSet(CURATED_GSAT_PASSAGES[nextIdx], []);
            renderReadingUI();
            return;
        }

        const isDeckSource = state.source === 'deck_ai';
        const pickedCards = isDeckSource ? pickDeckTargetCardsForReading() : [];
        if (isDeckSource && pickedCards.length === 0) {
            state.targetCards = [];
            state.passage = null;
            renderReadingUI();
            return;
        }

        state.isLoading = true;
        state.targetCards = pickedCards;
        state.passage = null;
        renderReadingUI();

        const topicHint = state.selectedTopic === '隨機題材'
            ? 'popular science, environmental sustainability, cognitive psychology, or cultural heritage'
            : state.selectedTopic;

        const deckPromptBlock = isDeckSource
            ? `Naturally weave these user vocabulary words into the passage (make at least 2 or 3 of them the exact answers for clozeQuestions and record each matched word in "targetWord"):
${pickedCards.map(c => `- ${c.word} (${c.pos || 'word'}): ${c.meaning}`).join('\n')}`
            : `Topic focus: ${topicHint}. Match official Taiwan GSAT (學測英文) reading & discourse difficulty.`;

        const prompt = `You are a senior Taiwanese GSAT (大學學測) English exam writer.
Write a cohesive 170–220 word academic/general-interest English passage divided into 2 paragraphs.
${deckPromptBlock}

Placeholders inside the paragraphs MUST use these exact markers:
- Cloze blanks (4 blanks): [[CLOZE_1]], [[CLOZE_2]], [[CLOZE_3]], [[CLOZE_4]]
- Discourse sentence-insertion blanks (3 blanks): [[DISC_1]], [[DISC_2]], [[DISC_3]]
(Make sure every marker appears ONCE in paragraphs, and removing [[DISC_n]] leaves coherent surrounding sentences where the missing sentence logically fits.)

Return ONLY a single valid JSON object (no markdown fences):
{
  "topic": "2-4 char Traditional Chinese topic label e.g. 科普探索",
  "title": "Engaging English Title",
  "paragraphs": ["Paragraph 1 with markers...", "Paragraph 2 with markers..."],
  "clozeQuestions": [
    {
      "id": "CLOZE_1",
      "num": 1,
      "targetWord": "optional matching word from user deck or empty string",
      "options": ["optA", "optB", "optC", "optD"],
      "answerIndex": 0,
      "explanation": "Concise Traditional Chinese explanation of grammar/collocation/context"
    }
  ],
  "discoursePool": [
    { "key": "A", "text": "Complete English sentence A" },
    { "key": "B", "text": "Complete English sentence B" },
    { "key": "C", "text": "Complete English sentence C" },
    { "key": "D", "text": "Complete English distractor sentence D" }
  ],
  "discourseQuestions": [
    { "id": "DISC_1", "label": "篇章空格 [1]", "answerKey": "A", "explanation": "Traditional Chinese explanation of logical link & pronouns/transitions" },
    { "id": 'DISC_2', "label": "篇章空格 [2]", "answerKey": "B", "explanation": "..." },
    { "id": "DISC_3", "label": "篇章空格 [3]", "answerKey": "C", "explanation": "..." }
  ],
  "comprehensionQuestions": [
    {
      "id": "COMP_1",
      "question": "English reading comprehension question",
      "options": ["A", "B", "C", "D"],
      "answerIndex": 0,
      "explanation": "Traditional Chinese explanation citing clue in passage"
    }
  ]
}`;

        try {
            if (typeof global.callGeminiApi !== 'function') {
                throw new Error('AI 出題引擎尚未就緒');
            }
            const rawText = await global.callGeminiApi(prompt, { feature: 'article_gen' });
            const parsed = (typeof global.safeParseJSON === 'function') ? global.safeParseJSON(rawText) : JSON.parse(rawText);
            state.passage = normalizeReadingSet(parsed, pickedCards);
        } catch (err) {
            console.error('[QuizReading] AI 出題失敗:', err);
            state.passage = { error: err && err.message ? err.message : '生成綜合閱讀題組失敗，請稍後重試' };
        } finally {
            state.isLoading = false;
            renderReadingUI();
        }
    }

    function setSource(src) {
        state.source = (src === 'deck_ai') ? 'deck_ai' : 'gsat_bank';
        return loadReadingPassage(false);
    }

    function setSubFormat(fmt) {
        state.subFormat = ['mixed', 'cloze', 'discourse'].includes(fmt) ? fmt : 'mixed';
        state.answers = {};
        state.isSubmitted = false;
        state.resultSummary = null;
        renderReadingUI();
    }

    function setTopic(topic) {
        state.selectedTopic = topic || '隨機題材';
    }

    function selectAnswer(questionId, value) {
        if (state.isSubmitted) return;
        state.answers[questionId] = value;
        renderReadingUI();
    }

    function getActiveQuestionItems(passage) {
        if (!passage) return { cloze: [], discourse: [], comp: [] };
        const cloze = (state.subFormat === 'mixed' || state.subFormat === 'cloze') ? (passage.clozeQuestions || []) : [];
        const discourse = (state.subFormat === 'mixed' || state.subFormat === 'discourse') ? (passage.discourseQuestions || []) : [];
        const comp = (state.subFormat === 'mixed') ? (passage.comprehensionQuestions || []) : [];
        return { cloze, discourse, comp };
    }

    /**
     * ✅ 提交批改：計算正確率、顯示詳解並僅更新字庫單字之 freeLevel / freeStreak
     */
    function submitReadingExam() {
        if (!state.passage || state.passage.error || state.isSubmitted) return;
        const { cloze, discourse, comp } = getActiveQuestionItems(state.passage);
        const total = cloze.length + discourse.length + comp.length;
        if (total === 0) return;

        // 確認是否全數作答
        const missing = [];
        cloze.forEach(q => { if (typeof state.answers[q.id] !== 'number') missing.push(`克漏字 (${q.num})`); });
        discourse.forEach(q => { if (!state.answers[q.id]) missing.push(q.label); });
        comp.forEach((q, idx) => { if (typeof state.answers[q.id] !== 'number') missing.push(`閱讀題 ${idx + 1}`); });

        if (missing.length > 0) {
            if (typeof global.showToast === 'function') {
                global.showToast(`尚有 ${missing.length} 題未作答（${missing[0]}）`, 'warning');
            }
            return;
        }

        let correct = 0;
        const gradedWordsSet = new Set();

        cloze.forEach(q => {
            const ok = state.answers[q.id] === q.answerIndex;
            if (ok) correct += 1;

            // 若該克漏字直接對應勾選字庫單字，依單題對錯立即更新其臨時等級
            if (q.targetWord && state.targetCards.length > 0) {
                const matchedCard = state.targetCards.find(c =>
                    c && c.word && c.word.trim().toLowerCase() === q.targetWord.trim().toLowerCase()
                );
                if (matchedCard && typeof global.applyQuizFreeGrade === 'function') {
                    global.applyQuizFreeGrade(matchedCard, ok);
                    gradedWordsSet.add(matchedCard.word.trim().toLowerCase());
                }
            }
        });

        discourse.forEach(q => {
            if (state.answers[q.id] === q.answerKey) correct += 1;
        });

        comp.forEach(q => {
            if (state.answers[q.id] === q.answerIndex) correct += 1;
        });

        const accuracy = Math.round((correct / total) * 100);
        const passed = accuracy >= PASS_ACCURACY;

        // 其餘本篇融入的字庫目標單字：依整體達標 (>=70%) 更新臨時等級，絕對不碰 FSRS
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
                    xp: passed ? 25 : 8
                });
            } catch (e) {}
        }

        if (global.ClassroomEngine && typeof global.ClassroomEngine.recordStudyActivity === 'function') {
            try {
                global.ClassroomEngine.recordStudyActivity({ type: 'quiz_questions', count: total, isCorrect: passed });
            } catch (e) {}
        }

        state.isSubmitted = true;
        state.resultSummary = { correct, total, accuracy, passed };
        renderReadingUI();
    }

    /**
     * 📝 將文章內 [[CLOZE_n]] / [[DISC_n]] 渲染為即時選項標記或作答後高亮文字（其餘英文單字保留 .reader-token 點擊查字）
     */
    function renderParagraphWithMarkers(paragraphText, passage) {
        const showCloze = state.subFormat === 'mixed' || state.subFormat === 'cloze';
        const showDisc = state.subFormat === 'mixed' || state.subFormat === 'discourse';

        const clozeMap = new Map((passage.clozeQuestions || []).map(q => [q.id, q]));
        const discMap = new Map((passage.discourseQuestions || []).map(q => [q.id, q]));
        const poolMap = new Map((passage.discoursePool || []).map(d => [d.key, d.text]));

        const markerRegex = /\[\[(CLOZE_\d+|DISC_\d+)\]\]/g;
        let html = '';
        let lastIdx = 0;
        let match;

        while ((match = markerRegex.exec(paragraphText)) !== null) {
            if (match.index > lastIdx) {
                html += tokenizeEn(paragraphText.slice(lastIdx, match.index));
            }

            const markerId = match[1];
            if (markerId.startsWith('CLOZE_') && clozeMap.has(markerId)) {
                const q = clozeMap.get(markerId);
                if (!showCloze) {
                    // 若只練篇章結構，克漏字空格直接補回正解並可點擊查字
                    html += tokenizeEn(q.options[q.answerIndex] || '');
                } else if (!state.isSubmitted) {
                    const selIdx = state.answers[q.id];
                    const chosenWord = typeof selIdx === 'number' ? q.options[selIdx] : '';
                    html += `<span class="inline-flex items-center px-2 py-0.5 mx-0.5 rounded-md border text-xs sm:text-sm font-sans font-bold ${chosenWord ? 'bg-brand-50 dark:bg-brand-950/60 border-brand-400 text-brand-700 dark:text-sky-300' : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'}">(${q.num}) ${chosenWord ? escapeHtml(chosenWord) : '____'}</span>`;
                } else {
                    const selIdx = state.answers[q.id];
                    const ok = selIdx === q.answerIndex;
                    const ansWord = q.options[q.answerIndex] || '';
                    html += `<span class="inline-flex items-center px-2 py-0.5 mx-0.5 rounded-md border text-xs sm:text-sm font-sans font-bold ${ok ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-400 text-emerald-700 dark:text-emerald-300' : 'bg-rose-50 dark:bg-rose-950/50 border-rose-400 text-rose-700 dark:text-rose-300'}">(${q.num}) ${tokenizeEn(ansWord)}</span>`;
                }
            } else if (markerId.startsWith('DISC_') && discMap.has(markerId)) {
                const q = discMap.get(markerId);
                if (!showDisc) {
                    // 若只練克漏字，將完整篇章句補回以保持閱讀流暢（同樣可點擊查字！）
                    const ansSentence = poolMap.get(q.answerKey) || '';
                    html += ansSentence ? (' ' + tokenizeEn(ansSentence)) : '';
                } else if (!state.isSubmitted) {
                    const selKey = state.answers[q.id];
                    const chosenSentence = selKey ? (poolMap.get(selKey) || '') : '';
                    html += `<span class="inline-block my-1 px-2.5 py-1 rounded-lg border text-xs sm:text-sm font-sans font-bold ${selKey ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-400 text-indigo-700 dark:text-indigo-200' : 'bg-slate-100 dark:bg-slate-800 border-dashed border-indigo-400 text-indigo-600 dark:text-indigo-300'}">[${escapeHtml(q.label.replace('篇章空格 ', ''))}${selKey ? `：已選 ${escapeHtml(selKey)}` : '：待還原句子'}]${chosenSentence ? ` <span class="font-normal font-serif">${escapeHtml(chosenSentence)}</span>` : ''}</span>`;
                } else {
                    const selKey = state.answers[q.id];
                    const ok = selKey === q.answerKey;
                    const ansSentence = poolMap.get(q.answerKey) || '';
                    html += `<span class="inline-block my-1 px-2.5 py-1 rounded-lg border text-xs sm:text-sm ${ok ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-400 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/40 border-rose-400 text-rose-800 dark:text-rose-200'}"><strong class="font-sans mr-1">[正解 ${escapeHtml(q.answerKey)}]</strong><span class="font-serif">${tokenizeEn(ansSentence)}</span></span>`;
                }
            }

            lastIdx = markerRegex.lastIndex;
        }

        if (lastIdx < paragraphText.length) {
            html += tokenizeEn(paragraphText.slice(lastIdx));
        }
        return html;
    }

    function renderReadingUI() {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('quizReadingContainer');
        if (!container) return;

        const sourceTabsHtml = `
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button type="button" onclick="QuizReadingModule.setSource('gsat_bank')" class="py-2 px-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 ${state.source === 'gsat_bank' ? 'bg-brand-600 text-white border-brand-600 shadow-2xs' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'}">
                    <i class="fa-solid fa-graduation-cap"></i>
                    <span>大考歷屆高頻題材模擬題庫</span>
                </button>
                <button type="button" onclick="QuizReadingModule.setSource('deck_ai')" class="py-2 px-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 ${state.source === 'deck_ai' ? 'bg-brand-600 text-white border-brand-600 shadow-2xs' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>AI 結合勾選字庫原創短文</span>
                </button>
            </div>
        `;

        const formatTabsHtml = `
            <div class="flex items-center flex-wrap justify-between gap-2">
                <div class="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900 p-1 rounded-xl">
                    ${[
                        { id: 'mixed', label: '全真混合組' },
                        { id: 'cloze', label: '綜合測驗 (克漏字)' },
                        { id: 'discourse', label: '篇章結構 (句子還原)' }
                    ].map(tab => `
                        <button type="button" onclick="QuizReadingModule.setSubFormat('${tab.id}')" class="px-2.5 py-1 rounded-lg text-xs font-bold transition ${state.subFormat === tab.id ? 'bg-white dark:bg-slate-700 text-brand-600 dark:text-sky-400 shadow-2xs' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800'}">
                            ${tab.label}
                        </button>
                    `).join('')}
                </div>
                <div class="flex items-center gap-1.5">
                    ${state.source === 'gsat_bank' ? `
                        <button type="button" onclick="QuizReadingModule.loadReadingPassage(false)" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
                            <i class="fa-solid fa-forward mr-1"></i>下一篇模擬題
                        </button>
                        <button type="button" onclick="QuizReadingModule.loadReadingPassage(true)" class="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-xs font-bold transition hover:bg-indigo-100">
                            <i class="fa-solid fa-sparkles mr-1"></i>AI 新生成
                        </button>
                    ` : `
                        <button type="button" onclick="QuizReadingModule.loadReadingPassage(true)" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
                            <i class="fa-solid fa-arrows-rotate mr-1"></i>AI 換一篇
                        </button>
                    `}
                </div>
            </div>
        `;

        if (state.isLoading) {
            container.innerHTML = `
                <div class="space-y-4">
                    ${sourceTabsHtml}
                    <div class="py-10 text-center space-y-3">
                        <i class="fa-solid fa-book-open-reader fa-beat-fade text-2xl text-brand-500"></i>
                        <p class="text-sm font-bold text-slate-800 dark:text-slate-100">正在生成學測級綜合閱讀與篇章結構題組...</p>
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
                            請於首頁勾選英文單字庫，或切換上方題源為「大考歷屆高頻題材模擬題庫」直接作答！
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
                        <button type="button" onclick="QuizReadingModule.loadReadingPassage(true)" class="px-4 py-2 rounded-xl bg-brand-600 text-white text-xs font-bold">重試生成</button>
                    </div>
                </div>
            `;
            return;
        }

        const p = state.passage;
        if (!p) return;

        const { cloze, discourse, comp } = getActiveQuestionItems(p);
        const targetBarHtml = state.targetCards.length > 0
            ? `<div class="flex items-center flex-wrap gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span class="font-bold">🎯 本篇融入字庫單字：</span>
                    ${state.targetCards.map(c => `<span class="px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-sky-300 font-bold border border-brand-200 dark:border-brand-800">${escapeHtml(c.word)}</span>`).join('')}
               </div>`
            : '';

        const passageHtml = `
            <div class="p-4 sm:p-5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700 space-y-3">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <div class="flex items-center gap-2">
                        <span class="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold">${escapeHtml(p.topic)}</span>
                        <h3 class="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white">${escapeHtml(p.title)}</h3>
                    </div>
                    <span class="text-[11px] text-brand-600 dark:text-sky-400 font-semibold">💡 點擊文章任意單字可即時查字</span>
                </div>
                ${targetBarHtml}
                <div class="space-y-3 font-serif text-sm sm:text-base leading-loose text-slate-800 dark:text-slate-100">
                    ${p.paragraphs.map(para => `<p>${renderParagraphWithMarkers(para, p)}</p>`).join('')}
                </div>
            </div>
        `;

        // 1. 綜合測驗（四選一克漏字）答題區
        const clozeSectionHtml = cloze.length > 0
            ? `
                <div class="space-y-3">
                    <h4 class="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <i class="fa-solid fa-pen-to-square text-brand-500"></i>
                        <span>綜合測驗（請依上下文選出最適合填入文章 (1)～(${cloze.length}) 的選項）</span>
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                        ${cloze.map(q => {
                            const sel = state.answers[q.id];
                            const labels = ['A', 'B', 'C', 'D'];
                            return `
                                <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/70 space-y-2.5">
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs font-extrabold text-brand-600 dark:text-sky-400">第 (${q.num}) 格</span>
                                        ${state.isSubmitted ? (sel === q.answerIndex ? '<span class="text-xs font-bold text-emerald-600 dark:text-emerald-400">✓ 答對</span>' : `<span class="text-xs font-bold text-rose-600 dark:text-rose-400">✗ 正解：(${labels[q.answerIndex]})</span>`) : ''}
                                    </div>
                                    <div class="grid grid-cols-2 gap-1.5">
                                        ${q.options.map((opt, idx) => {
                                            const isChosen = sel === idx;
                                            let cls = 'px-2.5 py-2 rounded-lg text-xs font-bold border text-left transition flex items-center gap-1.5 ';
                                            if (state.isSubmitted) {
                                                if (idx === q.answerIndex) cls += 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-500 text-emerald-800 dark:text-emerald-200';
                                                else if (isChosen) cls += 'bg-rose-50 dark:bg-rose-950/60 border-rose-500 text-rose-800 dark:text-rose-200';
                                                else cls += 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-700 opacity-60 text-slate-500';
                                            } else if (isChosen) {
                                                cls += 'bg-brand-600 border-brand-600 text-white shadow-2xs';
                                            } else {
                                                cls += 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-brand-400';
                                            }
                                            return `<button type="button" ${state.isSubmitted ? 'disabled' : ''} onclick="QuizReadingModule.selectAnswer('${escapeHtml(q.id)}', ${idx})" class="${cls}"><span class="opacity-75">(${labels[idx]})</span><span class="truncate">${escapeHtml(opt)}</span></button>`;
                                        }).join('')}
                                    </div>
                                    ${state.isSubmitted && q.explanation ? `<p class="text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-2 rounded-lg leading-relaxed">${escapeHtml(q.explanation)}</p>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `
            : '';

        // 2. 篇章結構（句子還原）答題區
        const discourseSectionHtml = discourse.length > 0
            ? `
                <div class="space-y-3">
                    <h4 class="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <i class="fa-solid fa-layer-group text-indigo-500"></i>
                        <span>篇章結構（由下列候選句中選出最適合填入文章的句子，含干擾選項；句子單字可點擊查字）</span>
                    </h4>
                    <div class="p-3.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/80 dark:border-indigo-800/70 space-y-2">
                        ${(p.discoursePool || []).map(item => `
                            <div class="flex items-start gap-2 text-xs sm:text-sm text-slate-800 dark:text-slate-100 leading-relaxed">
                                <span class="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-bold text-[11px] shrink-0 mt-0.5">${escapeHtml(item.key)}</span>
                                <span class="font-serif">${tokenizeEn(item.text)}</span>
                            </div>
                        `).join('')}
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        ${discourse.map(q => {
                            const selKey = state.answers[q.id] || '';
                            return `
                                <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/70 space-y-2">
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs font-extrabold text-indigo-600 dark:text-indigo-300">${escapeHtml(q.label)}</span>
                                        ${state.isSubmitted ? (selKey === q.answerKey ? '<span class="text-xs font-bold text-emerald-600 dark:text-emerald-400">✓ 正確</span>' : `<span class="text-xs font-bold text-rose-600 dark:text-rose-400">✗ 正解：${escapeHtml(q.answerKey)}</span>`) : ''}
                                    </div>
                                    <div class="flex flex-wrap gap-1.5">
                                        ${(p.discoursePool || []).map(opt => {
                                            const isChosen = selKey === opt.key;
                                            let cls = 'flex-1 min-w-[36px] py-1.5 rounded-lg text-xs font-bold border transition ';
                                            if (state.isSubmitted) {
                                                if (opt.key === q.answerKey) cls += 'bg-emerald-600 border-emerald-600 text-white';
                                                else if (isChosen) cls += 'bg-rose-600 border-rose-600 text-white';
                                                else cls += 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-400 opacity-60';
                                            } else if (isChosen) {
                                                cls += 'bg-indigo-600 border-indigo-600 text-white shadow-2xs';
                                            } else {
                                                cls += 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-indigo-400';
                                            }
                                            return `<button type="button" ${state.isSubmitted ? 'disabled' : ''} onclick="QuizReadingModule.selectAnswer('${escapeHtml(q.id)}', '${escapeHtml(opt.key)}')" class="${cls}">${escapeHtml(opt.key)}</button>`;
                                        }).join('')}
                                    </div>
                                    ${state.isSubmitted && q.explanation ? `<p class="text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-2 rounded-lg leading-relaxed">${escapeHtml(q.explanation)}</p>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `
            : '';

        // 3. 閱讀理解題區
        const compSectionHtml = comp.length > 0
            ? `
                <div class="space-y-3">
                    <h4 class="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <i class="fa-solid fa-magnifying-glass text-emerald-500"></i>
                        <span>閱讀理解推論題</span>
                    </h4>
                    ${comp.map((q, qIdx) => {
                        const sel = state.answers[q.id];
                        const labels = ['A', 'B', 'C', 'D'];
                        return `
                            <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/70 space-y-2.5">
                                <p class="text-sm font-bold text-slate-900 dark:text-white leading-snug">${qIdx + 1}. ${tokenizeEn(q.question)}</p>
                                <div class="grid grid-cols-1 gap-1.5">
                                    ${q.options.map((opt, idx) => {
                                        const isChosen = sel === idx;
                                        let cls = 'px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold border text-left transition flex items-start gap-2 ';
                                        if (state.isSubmitted) {
                                            if (idx === q.answerIndex) cls += 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-500 text-emerald-800 dark:text-emerald-200';
                                            else if (isChosen) cls += 'bg-rose-50 dark:bg-rose-950/60 border-rose-500 text-rose-800 dark:text-rose-200';
                                            else cls += 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-700 opacity-60 text-slate-500';
                                        } else if (isChosen) {
                                            cls += 'bg-brand-600 border-brand-600 text-white shadow-2xs';
                                        } else {
                                            cls += 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-brand-400';
                                        }
                                        return `<button type="button" ${state.isSubmitted ? 'disabled' : ''} onclick="QuizReadingModule.selectAnswer('${escapeHtml(q.id)}', ${idx})" class="${cls}"><span class="font-bold shrink-0">(${labels[idx]})</span><span>${escapeHtml(opt)}</span></button>`;
                                    }).join('')}
                                </div>
                                ${state.isSubmitted && q.explanation ? `<p class="text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-2 rounded-lg leading-relaxed">${escapeHtml(q.explanation)}</p>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `
            : '';

        const resultBannerHtml = state.isSubmitted && state.resultSummary
            ? `
                <div class="p-4 rounded-xl border ${state.resultSummary.passed ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100' : 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100'} flex items-center justify-between flex-wrap gap-2">
                    <div class="space-y-0.5">
                        <p class="text-sm font-extrabold">
                            ${state.resultSummary.passed ? '🎉 閱讀測驗達標！' : '📝 測驗完成！'} 答對 ${state.resultSummary.correct} / ${state.resultSummary.total} 題（${state.resultSummary.accuracy}%）
                        </p>
                        <p class="text-xs opacity-85">
                            ${state.targetCards.length > 0 ? '已依作答結果更新本篇字庫單字之「臨時等級」，FSRS 排程維持不變。' : '模擬題庫練習已完成，已發放練習經驗值（FSRS 排程未更動）。'}
                        </p>
                    </div>
                    <button type="button" onclick="QuizReadingModule.loadReadingPassage(${state.source === 'deck_ai'})" class="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold shadow-xs transition">
                        再練一篇
                    </button>
                </div>
            `
            : `
                <button type="button" onclick="QuizReadingModule.submitExam()" class="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold shadow-sm transition">
                    提交批改並查看詳解
                </button>
            `;

        container.innerHTML = `
            <div class="space-y-5">
                ${sourceTabsHtml}
                ${formatTabsHtml}
                ${passageHtml}
                ${clozeSectionHtml}
                ${discourseSectionHtml}
                ${compSectionHtml}
                ${resultBannerHtml}
            </div>
        `;

        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function') {
            global.ReaderPopover.bindReaderContainer(container);
        }
    }

    function activateMode() {
        if (!state.passage && !state.isLoading) {
            return loadReadingPassage(false);
        } else {
            renderReadingUI();
            return Promise.resolve();
        }
    }

    const QuizReadingModule = {
        activateMode,
        loadReadingPassage,
        setSource,
        setSubFormat,
        setTopic,
        selectAnswer,
        submitExam: submitReadingExam,
        renderUI: renderReadingUI,
        normalizeReadingSet,
        CURATED_GSAT_PASSAGES,
        _state: state
    };

    if (typeof global !== 'undefined') {
        global.QuizReadingModule = QuizReadingModule;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = QuizReadingModule;
    }
})(typeof window !== 'undefined' ? window : globalThis);
