/**
 * LZHCard - 考試進階題庫引擎 (quiz-exam-bank.js)
 * 1. 英文拼寫詞性與時態變化題庫（優先比對玩家字庫與 7000 單，支援 ✨ AI 補生成）
 * 2. 日文科學實證高效率題庫（文脈漢字読み・書き / 助詞穴埋め / 動詞・形容詞活用）
 * 3. 母語 == 目標語言進階母語國語文測驗：
 *    - 繁中＋繁中：學測/會考文言文經典實詞古今異義 ＋ 教育部最新修正《國語一字多音審訂表》標準讀音與字形辨析（嚴格查證、零臆測）
 *    - 英文＋英文：GRE/TOEFL 學術語域與精準搭配
 *    - 日文＋日文：敬語轉換（尊敬語/謙譲語）與四字熟語・古語
 */
(function (global) {
    'use strict';

    // =========================================================================
    // 1. 英文詞性/時態變化資料庫 (Word Family & Inflections)
    // =========================================================================
    const INFLECTION_BANK = [
        { base: 'decide', target: 'decision', targetPos: 'n.', hint: '名詞形式（決定）', sentence: 'We need to make a final _____ by Friday.', translation: '我們必須在週五前做出最終決定。' },
        { base: 'analyze', target: 'analysis', targetPos: 'n.', hint: '名詞形式（分析）', sentence: 'The report provides a detailed _____ of market trends.', translation: '這份報告提供了市場趨勢的詳細分析。' },
        { base: 'succeed', target: 'successful', targetPos: 'adj.', hint: '形容詞形式（成功的）', sentence: 'She became a very _____ software engineer.', translation: '她成為了一位非常成功的軟體工程師。' },
        { base: 'succeed', target: 'success', targetPos: 'n.', hint: '名詞形式（成功）', sentence: 'Hard work is the key to long-term _____.', translation: '努力是通往長期成功的關鍵。' },
        { base: 'vary', target: 'various', targetPos: 'adj.', hint: '形容詞形式（各種各樣的）', sentence: 'The store sells _____ types of herbal tea.', translation: '這家店販售各式各樣的花草茶。' },
        { base: 'vary', target: 'variety', targetPos: 'n.', hint: '名詞形式（多樣性）', sentence: 'A balanced diet includes a wide _____ of vegetables.', translation: '均衡飲食包含多樣化的蔬菜。' },
        { base: 'compare', target: 'comparison', targetPos: 'n.', hint: '名詞形式（比較）', sentence: 'By _____ with last year, sales have doubled.', translation: '與去年相比，銷售額翻倍了。' },
        { base: 'strong', target: 'strengthen', targetPos: 'v.', hint: '動詞形式（強化、鞏固）', sentence: 'Regular exercise helps _____ your heart and lungs.', translation: '規律運動有助於強化心肺功能。' },
        { base: 'wide', target: 'widen', targetPos: 'v.', hint: '動詞形式（加寬、拓寬）', sentence: 'The city plans to _____ the main road next month.', translation: '市政府計畫下個月拓寬這條主幹道。' },
        { base: 'deep', target: 'depth', targetPos: 'n.', hint: '名詞形式（深度）', sentence: 'The divers measured the _____ of the lake.', translation: '潛水員測量了湖泊的深度。' },
        { base: 'explain', target: 'explanation', targetPos: 'n.', hint: '名詞形式（解釋）', sentence: 'He gave a clear _____ for arriving late.', translation: '他為遲到給出了一個清楚的解釋。' },
        { base: 'describe', target: 'description', targetPos: 'n.', hint: '名詞形式（描述）', sentence: 'The witness gave an accurate _____ of the suspect.', translation: '目擊者對嫌疑人做出了準確的描述。' },
        { base: 'pronounce', target: 'pronunciation', targetPos: 'n.', hint: '名詞形式（發音，留意少一個 o）', sentence: 'Practicing aloud improves your English _____.', translation: '大聲朗讀能改善你的英語發音。' },
        { base: 'behave', target: 'behavior', targetPos: 'n.', hint: '名詞形式（行為）', sentence: 'Good _____ in class helps everyone learn better.', translation: '課堂上的良好行為有助於大家更好地學習。' },
        { base: 'believe', target: 'belief', targetPos: 'n.', hint: '名詞形式（信念）', sentence: 'She held a strong _____ in justice.', translation: '她對正義懷有堅定的信念。' },
        { base: 'choose', target: 'chosen', targetPos: 'p.p.', hint: '過去分詞（被選中的）', sentence: 'Three finalists were _____ for the scholarship.', translation: '有三名決賽入圍者獲選獲得獎學金。' },
        { base: 'write', target: 'written', targetPos: 'p.p.', hint: '過去分詞（寫好的）', sentence: 'All instructions must be _____ in clear English.', translation: '所有說明都必須以清楚的英文書寫。' },
        { base: 'grow', target: 'growth', targetPos: 'n.', hint: '名詞形式（成長、增長）', sentence: 'Sunlight is essential for healthy plant _____.', translation: '陽光對植物的健康成長至關重要。' },
        { base: 'create', target: 'creative', targetPos: 'adj.', hint: '形容詞形式（有創意的）', sentence: 'She came up with a _____ solution to the puzzle.', translation: '她想出了一個解決這道難題的創意方案。' },
        { base: 'benefit', target: 'beneficial', targetPos: 'adj.', hint: '形容詞形式（有益的）', sentence: 'Drinking enough water is _____ to your health.', translation: '喝足夠的水對健康有益。' },
        { base: 'depend', target: 'independent', targetPos: 'adj.', hint: '否定形容詞（獨立的）', sentence: 'Living abroad helped him become more _____.', translation: '海外生活讓他變得更加獨立。' },
        { base: 'respond', target: 'response', targetPos: 'n.', hint: '名詞形式（回應）', sentence: 'We received a quick _____ from customer support.', translation: '我們很快收到了客服團隊的回應。' },
        { base: 'attract', target: 'attractive', targetPos: 'adj.', hint: '形容詞形式（有吸引力的）', sentence: 'The museum offered an _____ discount for students.', translation: '博物館為學生提供了有吸引力的折扣。' },
        { base: 'appear', target: 'appearance', targetPos: 'n.', hint: '名詞形式（外貌、出現）', sentence: 'Never judge a person solely by their _____.', translation: '切勿僅憑外貌評斷一個人。' }
    ];

    // =========================================================================
    // 2. 日文科學實證題庫（Context Kanji / Particle Cloze / Conjugation）
    // =========================================================================
    const JAPANESE_SCIENCE_DRILLS = [
        // 文脈漢字読み (Kanji Reading in Context)
        {
            id: 'ja_read_1',
            subType: 'kanji_reading',
            subLabel: '文脈漢字読み（脈絡讀音）',
            stem: '駅の改札口の前で友達と【待ち合わせ】をした。',
            targetSpan: '待ち合わせ',
            prompt: '劃線漢字詞彙的正確平假名讀音為何？',
            options: ['まちあわせ', 'まちあいせ', 'たいあわせ', 'まちかわせ'],
            answerIndex: 0,
            explanation: '「待ち合わせ（まちあわせ）」意為「約好會合」。在真實句境中辨識動詞複合名詞讀音，能比單背漢字大幅提高提取率。'
        },
        {
            id: 'ja_read_2',
            subType: 'kanji_reading',
            subLabel: '文脈漢字読み（脈絡讀音）',
            stem: '来週の会議の【予定】をメールで確認してください。',
            targetSpan: '予定',
            prompt: '劃線詞彙的正確讀音為何？',
            options: ['よてい', 'よじょう', 'じてい', 'ゆてい'],
            answerIndex: 0,
            explanation: '「予定（よてい）」為音讀詞彙，「予（よ）＋定（てい）」意為預定、計畫。'
        },
        {
            id: 'ja_read_3',
            subType: 'kanji_reading',
            subLabel: '文脈漢字読み（脈絡讀音）',
            stem: '健康のために、毎日【規則正しい】生活を送っている。',
            targetSpan: '規則正しい',
            prompt: '劃線詞彙的正確讀音為何？',
            options: ['きそくただしい', 'きそくせいしい', 'きさいだだしい', 'きぞくただしい'],
            answerIndex: 0,
            explanation: '「規則正しい（きそくただしい）」指生活作息規律正常。注意「則」讀作「そく」而非濁音「ぞく」。'
        },
        // 助詞穴埋め (Particle Discrimination)
        {
            id: 'ja_part_1',
            subType: 'particle',
            subLabel: '助詞精準辨析',
            stem: '台風の影響（　）、今日の電車はすべて運休になった。',
            prompt: '括弧內應填入哪一個助詞（表示原因）？',
            options: ['で', 'を', 'へ', 'しか'],
            answerIndex: 0,
            explanation: '名詞後接「で」可表示原因、理由（「因颱風影響，今日電車全面停駛」）。'
        },
        {
            id: 'ja_part_2',
            subType: 'particle',
            subLabel: '助詞精準辨析',
            stem: '図書館は静か（　）勉強できるので、毎日通っています。',
            prompt: '括弧內應填入哪一個表示「動作場所」的助詞？',
            options: ['で', 'に', 'へ', 'が'],
            answerIndex: 0,
            explanation: '在某場所「進行動作（勉強できる）」須使用動作場所助詞「で」；存在場所才用「に」。'
        },
        {
            id: 'ja_part_3',
            subType: 'particle',
            subLabel: '助詞精準辨析',
            stem: 'このレストランは料理がおいしい（　）、値段も安いです。',
            prompt: '括弧內應填入哪一個表示「並列／累加優點」的接續助詞？',
            options: ['し', 'から', 'のに', 'ほど'],
            answerIndex: 0,
            explanation: '「〜し、〜」用來並列多個原因或優點（「這間餐廳菜色既好吃，價格又便宜」）。'
        },
        // 活用形変換 (Active Retrieval Conjugation)
        {
            id: 'ja_conj_1',
            subType: 'conjugation',
            subLabel: '動詞活用変換（主動回想）',
            stem: '動詞「書く（かく）」的【て形】並填入：ペンで名前を（　）ください。',
            prompt: '請選出正確的活用形式：',
            options: ['かいて（書いて）', 'かって（買て）', 'かんで（書んで）', 'かして（書して）'],
            answerIndex: 0,
            explanation: '五段動詞語尾為「く」時發生イ音便，接「て」變為「いて」，即「書いて（かいて）」。'
        },
        {
            id: 'ja_conj_2',
            subType: 'conjugation',
            subLabel: '動詞活用変換（主動回想）',
            stem: '動詞「食べる（たべる）」的【受身形／可能形（一段動詞）】在敬語表達「可吃」為：',
            prompt: '請選出正確的活用形式：',
            options: ['食べられる', '食べれる（口語省略）', '食べらせる', '食べろう'],
            answerIndex: 0,
            explanation: '上一段／下一段動詞的標準可能形／受身形規則為去「る」＋「られる」，即「食べられる」。考試正式題應避開ら抜き言葉「食べれる」。'
        },
        {
            id: 'ja_conj_3',
            subType: 'conjugation',
            subLabel: '動詞活用変換（主動回想）',
            stem: 'い形容詞「忙しい（いそがしい）」的【過去否定形】：「上週不怎麼忙」',
            prompt: '先週はあまり（　）。請選出正確變化：',
            options: ['忙しくなかったです', '忙しいじゃなかったです', '忙しかったないです', '忙しくありませんでしたか'],
            answerIndex: 0,
            explanation: 'い形容詞的過去否定規則：去い → くなかった，故為「忙しくなかったです」（亦可用「忙しくありませんでした」，非「じゃなかった」）。'
        }
    ];

    // =========================================================================
    // 3. 母語 == 目標語言：經嚴格查證之進階題庫（零臆測，教育部審訂/經典出處）
    // =========================================================================
    const NATIVE_SAME_EXAM_BANK = {
        'zh-TW': [
            {
                id: 'zh_moe_1',
                category: '教育部字音審訂',
                source: '教育部《國語一字多音審訂表》',
                stem: '下列「 」中的字，依照教育部最新標準審訂讀音，何者讀音正確？',
                options: [
                    '「蛤」蜊湯：ㄍㄜˊ',
                    '牛「仔」褲：ㄗㄞˇ',
                    '「烘」焙：ㄏㄨㄥˇ',
                    '「角」色：ㄐㄧㄠˇ'
                ],
                answerIndex: 0,
                explanation: '依教育部《國語一字多音審訂表》最新標準：「蛤蜊」讀為「ㄍㄜˊ ㄌㄧˊ」；「牛仔褲」的「仔」讀為「ㄗˇ」；「烘焙」讀為「ㄏㄨㄥ ㄅㄟˋ」；「角色」讀為「ㄐㄩㄝˊ ㄙㄜˋ」。'
            },
            {
                id: 'zh_moe_2',
                category: '教育部字音審訂',
                source: '教育部《國語一字多音審訂表》',
                stem: '下列詞語中，依照教育部標準國語審訂音，何者讀音與其餘三者「不同」？',
                options: [
                    '「緋」聞（ㄈㄟ）',
                    '「斐」然成章（ㄈㄟˇ）',
                    '「誹」謗（ㄈㄟˇ）',
                    '「菲」薄（ㄈㄟˇ）'
                ],
                answerIndex: 0,
                explanation: '「緋聞」之「緋」教育部審訂音為陰平「ㄈㄟ」（一聲）；而「斐然成章」、「誹謗」、「菲薄」皆讀作上聲「ㄈㄟˇ」（三聲）。'
            },
            {
                id: 'zh_moe_3',
                category: '教育部字音字形',
                source: '教育部《重編國語辭典修訂本》／《一字多音審訂表》',
                stem: '下列「 」內的字音，依照教育部審訂標準，何組完全正確？',
                options: [
                    '「滑」稽（ㄏㄨㄚˊ）／ 說話「拗」口（ㄠˋ）',
                    '「蝸」牛（ㄨㄛ）／ 「呆」板（ㄞˊ）',
                    '「法」國（ㄈㄚˋ）／ 「血」淋淋（ㄒㄩㄝˋ）',
                    '「載」歌載舞（ㄗㄞˇ）／ 「哺」育（ㄆㄨˇ）'
                ],
                answerIndex: 0,
                explanation: '教育部標準讀音：「滑稽」讀ㄏㄨㄚˊ ㄐㄧ（審訂後不再讀ㄍㄨˇ）；「拗口」讀ㄠˋ ㄎㄡˇ；「蝸牛」讀ㄍㄨㄚ；「呆板」讀ㄉㄞ；「法國」讀ㄈㄚˇ（語音，非四聲）；「血淋淋」讀ㄒㄧㄝˇ；「載歌載舞」讀ㄗㄞˋ；「哺育」讀ㄅㄨˇ。'
            },
            {
                id: 'zh_classical_1',
                category: '文言文古今異義',
                source: '《桃園市／全國歷屆會考學測經典文言》柳宗元〈始得西山宴遊記〉／陶淵明〈桃花源記〉',
                stem: '文言文常出現「古今異義」現象。下列各句「 」中的詞語，何者意義與現代漢語常用義差異最大？',
                options: [
                    '阡陌「交通」，雞犬相聞（〈桃花源記〉）',
                    '居廟堂之高，則憂其「民」（〈岳陽樓記〉）',
                    '故人具雞黍，「邀」我至田家（〈過故人莊〉）',
                    '「歲」寒，然後知松柏之後凋也（《論語》）'
                ],
                answerIndex: 0,
                explanation: '〈桃花源記〉「阡陌交通」的「交通」在古漢語中指「田間小路縱橫交錯相通」，並非現代的「運輸往來／車輛行駛」。'
            },
            {
                id: 'zh_classical_2',
                category: '文言文實詞辨析',
                source: '大學學測必考文言文：韓愈〈師說〉',
                stem: '韓愈〈師說〉：「古之學者必有師。師者，所以傳道受業解惑也。」句中「學者」與「所以」的古義分別為何？',
                options: [
                    '求學的人 ／ 用來⋯⋯的方法',
                    '學術專家 ／ 因此、結果',
                    '老師的學生 ／ 所以然的道理',
                    '讀書寫字的人 ／ 憑藉的身分'
                ],
                answerIndex: 0,
                explanation: '〈師說〉「學者」泛指「求學的人」（非現代「具有高深學問的專家」）；「所以」在先秦兩漢唐宋古文中多表示「用來⋯⋯的（憑藉／原因／方法）」，非現代因果連詞「因此」。'
            },
            {
                id: 'zh_classical_3',
                category: '文言文一詞多義',
                source: '大學學測經典課綱選文：《左傳·燭之武退秦師》',
                stem: '《左傳·燭之武退秦師》：「『微』夫人之力不及此。」句中「微」字的字義為何？',
                options: [
                    '沒有、如果不是',
                    '微小、細微',
                    '暗中、偷偷地',
                    '衰敗、沒落'
                ],
                answerIndex: 0,
                explanation: '在先秦文言文中，「微」作否定假設連詞／動詞用，意為「如果沒有⋯⋯」，如「微管仲，吾其被髮左衽矣」（《論語》）。此處指「如果沒有那個人的力量，我無法到達今天這個地位」。'
            },
            {
                id: 'zh_classical_4',
                category: '文言文古今異義',
                source: '司馬遷《史記·項羽本紀》〈鴻門宴〉',
                stem: '〈鴻門宴〉：「沛公居山東時，貪於財貨，好美姬。」其中的「山東」指的是？',
                options: [
                    '崤山（函谷關）以東的廣大地區',
                    '今日的山東省境內',
                    '太行山東側的齊國',
                    '泰山東麓一帶'
                ],
                answerIndex: 0,
                explanation: '戰國至秦漢時期，「山東」指崤山（或華山）以東的六國故地，範圍涵蓋今河南、山東、河北等地，與現代行政區「山東省」意義不同。'
            },
            {
                id: 'zh_classical_5',
                category: '文言文實詞辨析',
                source: '諸葛亮〈出師表〉',
                stem: '〈出師表〉：「先帝不以臣『卑鄙』，猥自枉屈，三顧臣於草廬之中。」句中「卑鄙」在古文中的確切含義是？',
                options: [
                    '出身卑微、見識淺陋（自謙之詞，不含道德貶義）',
                    '人格低下、行為狡詐',
                    '貧窮且固執不通情理',
                    '膽小怕事、不敢任事'
                ],
                answerIndex: 0,
                explanation: '古文中「卑」指身分低微，「鄙」指見識淺陋、居處偏遠，合起來「卑鄙」為諸葛亮自謙出身寒微、見識鄙陋，與現代「品行惡劣」完全不同。'
            }
        ],
        en: [
            {
                id: 'en_native_1',
                category: 'Academic Precision',
                source: 'Academic English Usage & Collocation',
                stem: 'Which sentence uses the word "disinterested" in its strict formal academic sense?',
                options: [
                    'The arbitration panel requires a disinterested judge with no financial stake in either company.',
                    'Most students seemed disinterested in the extra homework assignment.',
                    'He walked away disinterestedly because he wanted to go home early.',
                    'They felt disinterested about watching the same movie twice.'
                ],
                answerIndex: 0,
                explanation: 'In formal academic and legal English, "disinterested" means impartial or unbiased (having no personal stake), whereas "uninterested" means bored or lacking curiosity.'
            },
            {
                id: 'en_native_2',
                category: 'Rhetorical Precision',
                source: 'GRE / SAT Verbal Reasoning',
                stem: 'The historian offered an _____ account of the treaty, avoiding partisan blame while documenting every concession.',
                options: ['evenhanded', 'tendentious', 'incendiary', 'obsequious'],
                answerIndex: 0,
                explanation: '"Evenhanded" means fair, impartial, and balanced—fitting a writer who avoids partisan blame while recording all facts.'
            }
        ],
        ja: [
            {
                id: 'ja_native_1',
                category: '敬語（尊敬語・謙譲語）',
                source: '日本語敬語指針（文化審議会答申）',
                stem: '取引先の部長に対して「資料をご覧になりましたか」と同じ意味を最も自然で誤りのない尊敬語・謙譲語の使い分けで伝える文はどれですか。',
                options: [
                    '資料はすでにご覧になりましたか。',
                    '資料はすでに拝見されましたか。',
                    '資料はすでに拝見なさいましたか。',
                    '資料はすでに見ていただきましたか。'
                ],
                answerIndex: 0,
                explanation: '「拝見する」は自分が目上の人のものを見る謙譲語であるため、相手の動作に「拝見される」を使うのは誤用（二重・対象誤り）です。相手の「見る」は尊敬語「ご覧になる」を用います。'
            },
            {
                id: 'ja_native_2',
                category: '四字熟語',
                source: '日本漢字能力検定準1級〜2級出題語',
                stem: '「他人の言動や世間の流行に影響されず、自分なりの確固たる見解や態度を貫くこと」を表す四字熟語はどれですか。',
                options: ['唯我独尊', '付和雷同', '一期一会', '温故知新'],
                answerIndex: 0,
                explanation: '「付和雷同」は定見なく人の意見に同調することであり反対の意味。「一期一会」は一生に一度の出会い、「温故知新」は古い知識から新しい知見を得ることです。'
            }
        ]
    };

    /**
     * 🔍 為指定字庫單字尋找詞性/時態變化題（先查個人字庫同根詞 -> INFLECTION_BANK -> AI 生成）
     */
    function findLocalInflectionForCard(card, wordList = []) {
        if (!card || !card.word) return null;
        const base = String(card.word).trim().toLowerCase();

        // 1. Check curated INFLECTION_BANK matching base
        const hits = INFLECTION_BANK.filter(entry => entry.base === base);
        if (hits.length > 0) {
            const pick = hits[Math.floor(Math.random() * hits.length)];
            return { ...pick, baseCard: card, source: 'curated' };
        }

        // 2. Check player's own wordList (or 7000 word bank) for a derived sibling
        const stem = base.length >= 5 ? base.slice(0, base.length - 1) : base;
        if (stem.length >= 4 && Array.isArray(wordList)) {
            const sibling = wordList.find(w => {
                if (!w || !w.word) return false;
                const cand = String(w.word).trim().toLowerCase();
                if (cand === base || cand.includes(' ')) return false;
                return cand.startsWith(stem) && Math.abs(cand.length - base.length) >= 2 && Math.abs(cand.length - base.length) <= 6;
            });
            if (sibling) {
                return {
                    base: card.word,
                    target: sibling.word.trim(),
                    targetPos: sibling.pos || '詞性變化',
                    hint: `${sibling.pos || '衍生詞'}（來自字庫：${sibling.meaning || sibling.word}）`,
                    sentence: sibling.sentence || '',
                    translation: sibling.translation || sibling.meaning || '',
                    baseCard: card,
                    source: 'deck'
                };
            }
        }
        // 3. Check 7000-word level map for derived word-family sibling
        if (stem.length >= 4 && global.HIGH_SCHOOL_7000_LEVEL_MAP && typeof global.HIGH_SCHOOL_7000_LEVEL_MAP === 'object') {
            const keys = Object.keys(global.HIGH_SCHOOL_7000_LEVEL_MAP);
            const bankCand = keys.find(k => {
                const cand = String(k || '').trim().toLowerCase();
                if (!cand || cand === base || cand.includes(' ')) return false;
                return cand.startsWith(stem) && Math.abs(cand.length - base.length) >= 2 && Math.abs(cand.length - base.length) <= 6;
            });
            if (bankCand) {
                const lv = global.HIGH_SCHOOL_7000_LEVEL_MAP[bankCand];
                return {
                    base: card.word,
                    target: bankCand,
                    targetPos: '詞性變化',
                    hint: `衍生詞形（來自 7000 單第 ${lv} 級字庫；原字：${card.word} / ${card.meaning || ''}）`,
                    sentence: '',
                    translation: card.meaning || '',
                    baseCard: card,
                    source: '7000bank'
                };
            }
        }
        return null;
    }

    async function generateAiInflectionQuestion(card) {
        if (!card || !card.word || typeof global.callGeminiApi !== 'function') return null;
        const prompt = `請針對英文單字 "${card.word}"（原釋義：${card.meaning || ''}）出一題「詞性或時態變化拼寫測驗」。
請嚴格只回傳一段 JSON：
{
  "base": "${card.word}",
  "target": "變化後的目標英文單字（例如名詞、形容詞、副詞或過去分詞，且與原字不同）",
  "targetPos": "目標詞性（如 n. / adj. / adv. / p.p.）",
  "hint": "繁體中文詞性變化提示（如：名詞形式）",
  "sentence": "包含 _____ 挖空的自然英文例句",
  "translation": "該句的繁體中文翻譯"
}`;
        const raw = await global.callGeminiApi(prompt, { feature: 'def_fill' });
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) throw new Error('AI 未回傳有效詞性變化 JSON');
        const parsed = JSON.parse(m[0]);
        if (!parsed || !parsed.target) throw new Error('詞性變化欄位不完整');
        return {
            base: card.word,
            target: String(parsed.target).trim(),
            targetPos: String(parsed.targetPos || '').trim(),
            hint: String(parsed.hint || '詞性變化').trim(),
            sentence: String(parsed.sentence || '').trim(),
            translation: String(parsed.translation || '').trim(),
            baseCard: card,
            source: 'ai'
        };
    }

    function getJapaneseScientificDrills(subType = 'all') {
        if (subType && subType !== 'all') {
            return JAPANESE_SCIENCE_DRILLS.filter(q => q.subType === subType);
        }
        return JAPANESE_SCIENCE_DRILLS;
    }

    function getNativeAdvancedQuestions(langCode = 'zh-TW') {
        const key = (langCode === 'zh' || langCode === 'zh-TW') ? 'zh-TW' : (langCode === 'ja' ? 'ja' : 'en');
        return NATIVE_SAME_EXAM_BANK[key] || [];
    }

    function isSameNativeAndTargetLang() {
        try {
            const nat = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
            const tgt = localStorage.getItem('lzhcard_target_lang') || 'en';
            const norm = c => (c === 'zh' || c === 'zh-TW') ? 'zh-TW' : c;
            return norm(nat) === norm(tgt) && norm(nat) !== 'custom';
        } catch (e) {
            return false;
        }
    }

    async function explainVerifiedQuestionWithAi(questionObj) {
        if (!questionObj || typeof global.callGeminiApi !== 'function') return '';
        const ans = (questionObj.options || [])[questionObj.answerIndex] || '';
        const prompt = `這是一道已經過權威字典／歷屆考題查證的標準國語文試題，請絕對遵守已定答案，僅協助補充學習記憶口訣與相關對比舉例，不可推翻標準答案。
出處：${questionObj.source || ''}
題目：${questionObj.stem}
標準答案：${ans}
既有詳解：${questionObj.explanation}

請以繁體中文給出 100～180 字的重點深化解說：`;
        return String(await global.callGeminiApi(prompt, { feature: 'def_fill' }) || '').trim();
    }

    const QuizExamBank = {
        INFLECTION_BANK,
        JAPANESE_SCIENCE_DRILLS,
        NATIVE_SAME_EXAM_BANK,
        findLocalInflectionForCard,
        generateAiInflectionQuestion,
        getJapaneseScientificDrills,
        getNativeAdvancedQuestions,
        isSameNativeAndTargetLang,
        explainVerifiedQuestionWithAi
    };

    global.QuizExamBank = QuizExamBank;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = QuizExamBank;
    }
})(typeof window !== 'undefined' ? window : globalThis);
