/**
 * LZHCard - 專注考試測驗模組 (Phase 4 完整版：句意挖空拼寫 + 句構翻譯 + 綜合閱讀 + 文意選填 10 選 10)
 * 核心規範：
 * 1. 所有測驗模式僅增減 `freeLevel` 與 `freeStreak`，絕對不動 FSRS 排程欄位
 * 2. 出題池強制通過 `isCardMatchingTargetLang` 與 `selectedCategories` 雙重過濾
 * 3. 拼寫測驗一律提供「句子挖空 + 母語翻譯 + 單字頭尾字母提示」，要求填入目標單字
 */
(function (global) {
    'use strict';

    let currentQuizWord = null;
    let currentQuizMode = 'spelling'; // 'spelling' | 'translation' | 'reading' | 'cloze'
    let currentQuizLang = 'en';       // 'en' | 'ja' | 'zh-TW'
    let quizScoreCorrect = 0;
    let quizScoreTotal = 0;
    let lastQuizWordKey = null;
    let isQuizAnswerLocked = false;
    let quizAutoNextTimer = null;

    const READER_DEMO_SAMPLE =
        'Although sustainable urban farming requires careful planning, community gardens often transform neglected spaces into vibrant ecosystems where neighbors share fresh produce.';

    function escapeQuizHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeTargetLangCode(lang) {
        const raw = String(lang || '').trim().toLowerCase();
        if (raw === 'ja' || raw === 'jp' || raw === 'japanese') return 'ja';
        if (raw === 'zh' || raw === 'zh-tw' || raw === 'zh_tw' || raw === 'chinese') return 'zh-TW';
        return 'en';
    }

    function getUiLangBadgeCode(lang) {
        return normalizeTargetLangCode(lang) === 'zh-TW' ? 'zh' : normalizeTargetLangCode(lang);
    }

    function getQuizDefaultCatName() {
        if (typeof t === 'function') {
            const val = t('defaultCategoryName');
            if (val && val !== 'defaultCategoryName') return val;
        }
        return '預設字庫';
    }

    function getQuizWordList() {
        if (typeof wordList !== 'undefined' && Array.isArray(wordList)) return wordList;
        if (Array.isArray(global.wordList)) return global.wordList;
        return [];
    }

    // 初始化：讀取累計測驗分數與目前目標語言偏好
    (function initQuizStateFromLocal() {
        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem('lzhcard_quiz_score');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.correct === 'number' && typeof parsed.total === 'number') {
                    quizScoreCorrect = parsed.correct;
                    quizScoreTotal = parsed.total;
                }
            }
            const savedTarget = localStorage.getItem('lzhcard_target_lang');
            if (savedTarget && ['en', 'ja', 'zh', 'zh-TW'].includes(savedTarget)) {
                currentQuizLang = normalizeTargetLangCode(savedTarget);
            }
        } catch (e) {}
    })();

    function syncQuizScoreFromStorage(scoreObj) {
        if (!scoreObj || typeof scoreObj.correct !== 'number' || typeof scoreObj.total !== 'number') return;
        quizScoreCorrect = scoreObj.correct;
        quizScoreTotal = scoreObj.total;
        updateQuizScoreUI();
    }

    function updateQuizScoreUI() {
        if (typeof document === 'undefined') return;
        const scoreElem = document.getElementById('quizScore');
        if (scoreElem) {
            scoreElem.innerText = `${quizScoreCorrect}/${quizScoreTotal}`;
        }
    }

    function persistQuizScore() {
        if (typeof localStorage === 'undefined') return;
        const payload = {
            correct: quizScoreCorrect,
            total: quizScoreTotal,
            updatedAt: Date.now()
        };
        try {
            localStorage.setItem('lzhcard_quiz_score', JSON.stringify(payload));
        } catch (e) {}
    }

    /**
     * 🔍 精準判定單字卡所屬語言（修復日文字庫混入英文模式問題）
     */
    function detectCardTargetLang(card) {
        if (!card || typeof card !== 'object') return 'en';

        if (card.lang && typeof card.lang === 'string') {
            const explicit = card.lang.trim().toLowerCase();
            if (explicit === 'ja' || explicit === 'jp' || explicit === 'japanese') return 'ja';
            if (explicit === 'zh' || explicit === 'zh-tw' || explicit === 'zh_tw' || explicit === 'chinese') return 'zh-TW';
            if (explicit === 'en' || explicit === 'english') return 'en';
        }

        const word = String(card.word || '').trim();
        const phonetic = String(card.phonetic || '').trim();
        const sentence = String(card.sentence || '').trim();
        const category = String(card.category || '').trim();

        const kanaRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
        const jaCategoryRegex = /(?:jlpt|\bn[1-5]\b|日[語文檢]|五十音|假名|japanese)/i;
        const cjkRegex = /[\u4E00-\u9FFF]/;
        const latinRegex = /[A-Za-z]/;

        if (kanaRegex.test(word) || kanaRegex.test(phonetic) || kanaRegex.test(sentence) || jaCategoryRegex.test(category)) {
            return 'ja';
        }
        if (cjkRegex.test(word) && !latinRegex.test(word)) {
            return 'zh-TW';
        }
        if (latinRegex.test(word)) {
            return 'en';
        }
        if (cjkRegex.test(sentence) && !latinRegex.test(sentence)) return 'zh-TW';
        return 'en';
    }

    /**
     * 🛡️ 語言隔離過濾函式
     */
    function isCardMatchingTargetLang(card, targetLang) {
        if (!card) return false;
        const resolvedTarget = normalizeTargetLangCode(
            targetLang || (typeof localStorage !== 'undefined' ? localStorage.getItem('lzhcard_target_lang') : 'en') || 'en'
        );
        return detectCardTargetLang(card) === resolvedTarget;
    }

    function isQuizMeaningUsable(meaning) {
        if (!meaning) return false;
        const str = String(meaning).trim();
        if (!str) return false;
        const invalidTokens = [
            '未設定釋義', '解析中', '自動解析中', '無釋義', '無母語釋義', '無母語釋意',
            '尚無釋義', '暫無釋義', 'no definition', 'pending', 'empty', '-'
        ];
        return !invalidTokens.some(tok => str.toLowerCase().includes(tok));
    }

    /**
     * 🎯 取得「當前勾選字庫 + 目標語言」雙重過濾後的有效單字池
     */
    function getQuizLanguageFilteredPool(targetLang = currentQuizLang, options = {}) {
        const list = getQuizWordList();
        const activeCats = (typeof global.selectedCategories !== 'undefined' && Array.isArray(global.selectedCategories))
            ? global.selectedCategories
            : ['ALL'];
        const defaultCatName = getQuizDefaultCatName();
        const requireMeaning = options.requireMeaning !== false;

        const filtered = list.filter(w => {
            if (!w || !w.word || !String(w.word).trim()) return false;
            const cat = (w.category && String(w.category).trim() !== '') ? String(w.category).trim() : defaultCatName;
            const matchCat = activeCats.includes('ALL') || activeCats.includes(cat);
            if (!matchCat) return false;
            if (!isCardMatchingTargetLang(w, targetLang)) return false;
            if (requireMeaning && !isQuizMeaningUsable(w.meaning)) return false;
            return true;
        });

        const uniqueMap = new Map();
        filtered.forEach(w => {
            const key = String(w.word).trim().toLowerCase();
            w.freeLevel = Number(w.freeLevel) || 1;
            w.freeStreak = Number(w.freeStreak) || 0;

            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, w);
            } else {
                const existing = uniqueMap.get(key);
                if (w.freeLevel > existing.freeLevel || (w.freeLevel === existing.freeLevel && w.freeStreak > existing.freeStreak)) {
                    uniqueMap.set(key, w);
                }
            }
        });

        return Array.from(uniqueMap.values());
    }

    /**
     * 🎲 依臨時等級加權抽選下一題（優先抽有例句的單字，完全不碰 FSRS 欄位）
     */
    function pickNextFreeQuizCandidate(candidates) {
        if (!candidates || candidates.length === 0) return null;

        const withSentence = candidates.filter(w => w.sentence && String(w.sentence).trim() !== '');
        const preferred = withSentence.length > 0 ? withSentence : candidates;
        if (preferred.length === 1) return preferred[0];

        const nonRepeat = lastQuizWordKey
            ? preferred.filter(w => String(w.word).trim().toLowerCase() !== lastQuizWordKey)
            : preferred;
        const pool = nonRepeat.length > 0 ? nonRepeat : preferred;

        const LEVEL_WEIGHTS = { 1: 120, 2: 70, 3: 35, 4: 18, 5: 6 };
        const weighted = pool.map(card => {
            const lv = Math.min(5, Math.max(1, Number(card.freeLevel) || 1));
            return { card, weight: LEVEL_WEIGHTS[lv] || 50 };
        });

        const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        let rand = Math.random() * totalWeight;
        for (const item of weighted) {
            if (rand < item.weight) return item.card;
            rand -= item.weight;
        }
        return weighted[0].card;
    }

    /**
     * 🎯 保留供其他模組呼叫的同語言干擾字抽選（雙重過濾保護）
     */
    function pickQuizDistractors(targetCard, targetLang = currentQuizLang, count = 3) {
        if (!targetCard) return [];
        const pool = getQuizLanguageFilteredPool(targetLang, { requireMeaning: true });
        const targetWordKey = String(targetCard.word || '').trim().toLowerCase();
        const usedKeys = new Set([targetWordKey]);
        const shuffled = pool.slice().sort(() => Math.random() - 0.5);
        const result = [];
        for (const card of shuffled) {
            const wKey = String(card.word || '').trim().toLowerCase();
            if (!wKey || usedKeys.has(wKey)) continue;
            usedKeys.add(wKey);
            result.push(card);
            if (result.length >= count) break;
        }
        return result;
    }

    /**
     * ⚡ 考試專用評分：僅更新 `freeLevel` 與 `freeStreak`，絕對不修改任何 FSRS 排程欄位
     */
    function applyQuizFreeGrade(card, isCorrect) {
        if (!card) return;

        if (typeof global.recordFreePracticeReview === 'function') {
            global.recordFreePracticeReview(card, isCorrect ? 3 : 1);
        } else {
            card.freeLevel = Number(card.freeLevel) || 1;
            card.freeStreak = Number(card.freeStreak) || 0;
            if (isCorrect) {
                if (card.freeLevel === 1) {
                    card.freeStreak += 1;
                    if (card.freeStreak >= 2) {
                        card.freeLevel = 2;
                        card.freeStreak = 0;
                    }
                } else {
                    card.freeLevel = Math.min(5, card.freeLevel + 1);
                    card.freeStreak = 0;
                }
            } else {
                card.freeLevel = 1;
                card.freeStreak = 0;
            }
            const now = Date.now();
            card.updatedAt = now;

            const list = getQuizWordList();
            const key = String(card.word || '').trim().toLowerCase();
            list.forEach(w => {
                if (w !== card && w && w.word && w.word.trim().toLowerCase() === key) {
                    w.freeLevel = card.freeLevel;
                    w.freeStreak = card.freeStreak;
                    w.updatedAt = now;
                }
            });
        }

        if (typeof global.saveStorage === 'function') global.saveStorage();
        if (typeof global.updateUI === 'function') global.updateUI();
        if (typeof global.refreshFSRSUIBadges === 'function') global.refreshFSRSUIBadges();

        if (global.GameEngine && typeof global.GameEngine.awardProgression === 'function') {
            try {
                global.GameEngine.awardProgression({
                    xp: isCorrect ? 8 : 2
                });
            } catch (e) {}
        }
    }

    function normalizeQuizMode(mode) {
        if (mode === 'translation') return 'translation';
        if (mode === 'reading') return 'reading';
        if (mode === 'cloze') return 'cloze';
        return 'spelling';
    }

    function setQuizLanguage(lang) {
        currentQuizLang = normalizeTargetLangCode(lang);
        updateLanguageTabUI();
        nextQuizQuestion();
    }

    function updateLanguageTabUI() {
        if (typeof document === 'undefined') return;
        const activeUiCode = getUiLangBadgeCode(currentQuizLang);
        ['en', 'ja', 'zh'].forEach(l => {
            const btn = document.getElementById(`qlang-${l}`);
            if (!btn) return;
            if (l === activeUiCode) {
                btn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition bg-white dark:bg-slate-700 text-brand-600 dark:text-brand-400 shadow-2xs';
            } else {
                btn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200';
            }
        });
    }

    function syncActiveQuizModeContainers() {
        if (typeof document === 'undefined') return;
        const basicBox = document.getElementById('quizContainer');
        const demoBox = document.getElementById('quizReaderDemoCard');
        const langBar = document.getElementById('quizLangDirBar');
        const transBox = document.getElementById('quizTranslationContainer');
        const readBox = document.getElementById('quizReadingContainer');
        const clozeBox = document.getElementById('quizClozeContainer');

        const isSpelling = currentQuizMode === 'spelling';
        const isTrans = currentQuizMode === 'translation';
        const isRead = currentQuizMode === 'reading';
        const isCloze = currentQuizMode === 'cloze';

        if (basicBox) basicBox.classList.toggle('hidden', !isSpelling);
        if (demoBox) demoBox.classList.toggle('hidden', !isSpelling);
        if (langBar) langBar.classList.toggle('hidden', !isSpelling);
        if (transBox) transBox.classList.toggle('hidden', !isTrans);
        if (readBox) readBox.classList.toggle('hidden', !isRead);
        if (clozeBox) clozeBox.classList.toggle('hidden', !isCloze);
    }

    /**
     * 🎯 切換測驗模式 (拼寫測驗 / 句構翻譯 / 綜合閱讀 / 文意選填 10 選 10)
     */
    function setQuizMode(mode) {
        currentQuizMode = normalizeQuizMode(mode);
        updateModeTabUI();

        if (quizAutoNextTimer) {
            clearTimeout(quizAutoNextTimer);
            quizAutoNextTimer = null;
        }
        syncActiveQuizModeContainers();

        if (currentQuizMode === 'translation') {
            if (global.QuizTranslationModule && typeof global.QuizTranslationModule.activateMode === 'function') {
                global.QuizTranslationModule.activateMode();
            }
            return;
        }

        if (currentQuizMode === 'reading') {
            if (global.QuizReadingModule && typeof global.QuizReadingModule.activateMode === 'function') {
                global.QuizReadingModule.activateMode();
            }
            return;
        }

        if (currentQuizMode === 'cloze') {
            if (global.QuizClozeModule && typeof global.QuizClozeModule.activateMode === 'function') {
                global.QuizClozeModule.activateMode();
            }
            return;
        }

        nextQuizQuestion();
    }

    function updateModeTabUI() {
        if (typeof document === 'undefined') return;
        const spellBtn = document.getElementById('qmode-spelling');
        const transBtn = document.getElementById('qmode-translation');
        const readBtn = document.getElementById('qmode-reading');
        const clozeBtn = document.getElementById('qmode-cloze');
        const activeCls = 'py-2 px-2.5 rounded-lg font-bold transition bg-brand-600 text-white shadow-xs flex items-center justify-center gap-1.5';
        const idleCls = 'py-2 px-2.5 rounded-lg font-bold transition bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 flex items-center justify-center gap-1.5';
        if (spellBtn) spellBtn.className = currentQuizMode === 'spelling' ? activeCls : idleCls;
        if (transBtn) transBtn.className = currentQuizMode === 'translation' ? activeCls : idleCls;
        if (readBtn) readBtn.className = currentQuizMode === 'reading' ? activeCls : idleCls;
        if (clozeBtn) clozeBtn.className = currentQuizMode === 'cloze' ? activeCls : idleCls;
    }

    function speakQuizPromptWord(wordStr, langCode = currentQuizLang) {
        const text = String(wordStr || (currentQuizWord && currentQuizWord.word) || '').trim();
        if (!text || typeof window === 'undefined') return;
        const normLang = normalizeTargetLangCode(langCode);
        const speechLang = normLang === 'ja' ? 'ja-JP' : (normLang === 'zh-TW' ? 'zh-TW' : 'en-US');
        try {
            if (window.LZHAudioTts && typeof window.LZHAudioTts.speak === 'function') {
                window.LZHAudioTts.speak(text, speechLang).catch(() => {});
                return;
            }
            const capTTS = window.Capacitor?.Plugins?.TextToSpeech;
            if (typeof global.isNativeApp === 'function' && global.isNativeApp() && capTTS && typeof capTTS.speak === 'function') {
                capTTS.speak({ text, lang: speechLang, rate: 1.0, pitch: 1.0, volume: 1.0, category: 'ambient' }).catch(() => {});
                return;
            }
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                u.lang = speechLang;
                window.speechSynthesis.speak(u);
            }
        } catch (e) {}
    }

    function renderReaderAwareEnglishHtml(text, excludeWords = []) {
        if (!text) return '';
        if (global.ReaderPopover && typeof global.ReaderPopover.tokenizeEnglishText === 'function') {
            return global.ReaderPopover.tokenizeEnglishText(text, { excludeWords });
        }
        return escapeQuizHTML(text);
    }

    /**
     * 🔤 產生「頭尾字母遮罩」提示（支援英文單字、片語及日文/中文詞彙）
     * 例：apple -> a _ _ _ e ； give up -> g _ _ e   u p
     */
    function buildHeadTailMaskHint(word, spaced = true) {
        const clean = String(word || '').trim();
        if (!clean) return '';
        const sep = spaced ? ' ' : '';
        const wordGap = spaced ? '   ' : ' ';

        return clean.split(/\s+/).map(part => {
            const chars = Array.from(part);
            if (chars.length <= 1) return '_';
            if (chars.length === 2) return chars[0] + sep + '_';
            const inner = Array(chars.length - 2).fill('_').join(sep);
            return chars[0] + sep + inner + sep + chars[chars.length - 1];
        }).join(wordGap);
    }

    /**
     * ✂️ 將句子中的目標單字（含常見詞態變化）挖空並帶入頭尾字母提示
     */
    function buildClozeSentenceHtml(sentence, word, langCode) {
        const cleanSentence = String(sentence || '').trim();
        const cleanWord = String(word || '').trim();
        if (!cleanSentence || !cleanWord) return { html: '', replaced: false };

        const compactMask = buildHeadTailMaskHint(cleanWord, false);
        const maskBadgeHtml = `<span class="quiz-blank-mask inline-block px-2 py-0.5 mx-0.5 rounded-md bg-brand-50 dark:bg-sky-950/60 border-b-2 border-brand-500 dark:border-sky-400 text-brand-700 dark:text-sky-300 font-mono font-extrabold tracking-wider">${escapeQuizHTML(compactMask)}</span>`;

        const escaped = cleanWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let regex;
        if (langCode === 'en' && !cleanWord.includes(' ')) {
            // 匹配原字或其常見詞尾變化 (s/es/ed/ing/d/ies/ied) 以防例句洩題
            const stem = cleanWord.length > 4 && cleanWord.endsWith('y')
                ? cleanWord.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:y|ies|ied)'
                : cleanWord.length > 4 && cleanWord.endsWith('e')
                    ? cleanWord.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:e|es|ed|ing|er|est)?'
                    : escaped + '(?:s|es|ed|ing|er|est)?';
            regex = new RegExp(`\\b${stem}\\b`, 'gi');
        } else if (langCode === 'en') {
            regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        } else {
            regex = new RegExp(escaped, 'gi');
        }

        const parts = cleanSentence.split(regex);
        if (parts.length <= 1) {
            return {
                html: langCode === 'en' ? renderReaderAwareEnglishHtml(cleanSentence, [cleanWord]) : escapeQuizHTML(cleanSentence),
                replaced: false
            };
        }

        const html = parts
            .map(part => langCode === 'en' ? renderReaderAwareEnglishHtml(part, [cleanWord]) : escapeQuizHTML(part))
            .join(maskBadgeHtml);
        return { html, replaced: true };
    }

    function updateQuizCardHeaderBadges(card) {
        if (typeof document === 'undefined') return;
        const badgeElem = document.getElementById('quizBadge');
        const tempBadge = document.getElementById('quizTempLvBadge');
        const langBadge = document.getElementById('quizLangIsolateBadge');

        if (badgeElem) {
            badgeElem.innerText = '句子挖空拼寫測驗';
        }
        if (langBadge) {
            const langLabelMap = { en: '🇬🇧 英文隔離池', ja: '🇯🇵 日文隔離池', 'zh-TW': '🇹🇼 中文隔離池' };
            langBadge.innerText = langLabelMap[currentQuizLang] || '🇬🇧 英文隔離池';
        }
        if (tempBadge) {
            if (card) {
                const lv = Number(card.freeLevel) || 1;
                const lvInfo = (typeof global.getFreeLevelInfo === 'function')
                    ? global.getFreeLevelInfo(lv)
                    : { name: `臨時 Lv.${lv}`, color: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800' };
                tempBadge.className = `px-2.5 py-1 rounded-full text-xs font-bold border ${lvInfo.color}`;
                tempBadge.innerText = `⚡ ${lvInfo.name}`;
                tempBadge.classList.remove('hidden');
            } else {
                tempBadge.classList.add('hidden');
            }
        }
    }

    function renderQuizReaderDemo() {
        if (typeof document === 'undefined') return;
        const demoBox = document.getElementById('quizReaderDemoBody');
        if (!demoBox) return;
        demoBox.innerHTML = renderReaderAwareEnglishHtml(READER_DEMO_SAMPLE);
        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function') {
            global.ReaderPopover.bindReaderContainer(demoBox);
        }
    }

    /**
     * 🎲 產生下一題「句子挖空拼寫測驗」
     */
    function nextQuizQuestion() {
        if (quizAutoNextTimer) {
            clearTimeout(quizAutoNextTimer);
            quizAutoNextTimer = null;
        }
        isQuizAnswerLocked = false;

        if (typeof global.closeReaderPopover === 'function') {
            global.closeReaderPopover();
        }

        updateQuizScoreUI();
        updateLanguageTabUI();
        updateModeTabUI();
        syncActiveQuizModeContainers();

        if (currentQuizMode === 'translation') {
            if (global.QuizTranslationModule && typeof global.QuizTranslationModule.activateMode === 'function') {
                global.QuizTranslationModule.activateMode();
            }
            return;
        }
        if (currentQuizMode === 'reading') {
            if (global.QuizReadingModule && typeof global.QuizReadingModule.activateMode === 'function') {
                global.QuizReadingModule.activateMode();
            }
            return;
        }
        if (currentQuizMode === 'cloze') {
            if (global.QuizClozeModule && typeof global.QuizClozeModule.activateMode === 'function') {
                global.QuizClozeModule.activateMode();
            }
            return;
        }

        renderQuizReaderDemo();

        if (typeof document === 'undefined') return;

        const promptBox = document.getElementById('quizPromptBox');
        const promptTitleElem = document.getElementById('quizPromptTitle');
        const spellingForm = document.getElementById('quizSpellingForm');
        const inputElem = document.getElementById('quizInput');
        const submitBtn = document.getElementById('quizSubmitBtn');
        const feedbackElem = document.getElementById('quizFeedback');

        if (feedbackElem) {
            feedbackElem.classList.add('hidden');
            feedbackElem.innerHTML = '';
        }

        const pool = getQuizLanguageFilteredPool(currentQuizLang, { requireMeaning: true });

        if (pool.length === 0) {
            currentQuizWord = null;
            updateQuizCardHeaderBadges(null);
            if (spellingForm) spellingForm.classList.add('hidden');

            const langName = currentQuizLang === 'ja' ? '日文' : (currentQuizLang === 'zh-TW' ? '中文' : '英文');
            if (promptTitleElem) promptTitleElem.innerText = '題庫狀態';
            if (promptBox) {
                promptBox.innerHTML = `
                    <div class="text-center py-6 space-y-2.5">
                        <div class="w-11 h-11 rounded-2xl bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto text-lg">
                            <i class="fa-solid fa-filter"></i>
                        </div>
                        <p class="text-sm font-bold text-slate-800 dark:text-slate-100">
                            目前勾選的字庫中，沒有符合「${escapeQuizHTML(langName)}」且具備釋義的單字
                        </p>
                        <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed max-w-sm mx-auto">
                            跨語言隔離保護已啟用：系統不會混入其他語言的單字。<br>
                            請於首頁勾選對應語言的字庫，或至上方切換測驗語言。
                        </p>
                    </div>
                `;
            }
            return;
        }

        currentQuizWord = pickNextFreeQuizCandidate(pool);
        lastQuizWordKey = String(currentQuizWord.word).trim().toLowerCase();
        updateQuizCardHeaderBadges(currentQuizWord);

        if (spellingForm) spellingForm.classList.remove('hidden');
        if (inputElem) {
            inputElem.disabled = false;
            inputElem.value = '';
            inputElem.placeholder = '請根據句意翻譯與頭尾字母提示，填入正確單字...';
            setTimeout(() => {
                try { inputElem.focus(); } catch (e) {}
            }, 40);
        }
        if (submitBtn) submitBtn.disabled = false;

        const diffBadgeHtml = (currentQuizLang === 'en' && typeof global.getWordDifficultyInfo === 'function')
            ? (() => {
                const info = global.getWordDifficultyInfo(currentQuizWord.word);
                return info && info.tag
                    ? `<span class="text-[11px] px-2 py-0.5 rounded border font-bold ${info.color}">${escapeQuizHTML(info.shortLabel || info.tag)}</span>`
                    : '';
            })()
            : '';

        const posBadgeHtml = currentQuizWord.pos
            ? `<span class="px-2 py-0.5 rounded bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 text-xs font-bold">${escapeQuizHTML(currentQuizWord.pos)}</span>`
            : '';

        const headTailHint = buildHeadTailMaskHint(currentQuizWord.word, true);
        const charLen = String(currentQuizWord.word || '').trim().length;
        const hasSentence = currentQuizWord.sentence && String(currentQuizWord.sentence).trim() !== '';
        const clozeRes = hasSentence
            ? buildClozeSentenceHtml(currentQuizWord.sentence, currentQuizWord.word, currentQuizLang)
            : { html: '', replaced: false };

        const nativeTranslation = currentQuizWord.translation && String(currentQuizWord.translation).trim() !== ''
            ? String(currentQuizWord.translation).trim()
            : '';

        if (promptTitleElem) {
            promptTitleElem.innerText = '拼寫／輸入測驗（依句子挖空、母語翻譯與頭尾字母填入正確單字）：';
        }

        promptBox.innerHTML = `
            <div class="space-y-3.5">
                <!-- 1. 句子挖空區 -->
                ${hasSentence && clozeRes.replaced ? `
                    <div class="p-3.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-1.5">
                        <p class="text-[11px] font-bold text-slate-400">句子挖空題目${currentQuizLang === 'en' ? '（周圍英文單字可點擊即時查字）' : ''}</p>
                        <p class="font-serif text-base sm:text-lg leading-relaxed text-slate-900 dark:text-slate-100">${clozeRes.html}</p>
                    </div>
                ` : `
                    <div class="p-3 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300">
                        <i class="fa-regular fa-note-sticky mr-1"></i>此單字卡尚無對應挖空例句，請依下方母語釋義與頭尾字母提示拼出單字（可用「AI 補齊」為字庫補上例句）。
                    </div>
                `}

                <!-- 2. 母語翻譯與目標詞義 -->
                <div class="space-y-1.5">
                    ${nativeTranslation ? `
                        <div class="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/70">
                            <p class="text-[11px] font-bold text-emerald-700 dark:text-emerald-300 mb-0.5">母語整句翻譯</p>
                            <p class="text-sm sm:text-base font-bold text-emerald-950 dark:text-emerald-100 leading-snug">${escapeQuizHTML(nativeTranslation)}</p>
                        </div>
                    ` : ''}
                    <div class="flex items-center flex-wrap gap-2 pt-0.5">
                        ${posBadgeHtml}
                        ${diffBadgeHtml}
                        <span class="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white">${escapeQuizHTML(currentQuizWord.meaning)}</span>
                    </div>
                </div>

                <!-- 3. 單字頭尾字母與字元數提示 -->
                <div class="flex items-center justify-between gap-2 flex-wrap px-3.5 py-2.5 rounded-xl bg-brand-50/70 dark:bg-sky-950/40 border border-brand-200/80 dark:border-sky-800/70">
                    <div class="flex items-center flex-wrap gap-2">
                        <span class="text-xs font-bold text-brand-700 dark:text-sky-300">🔤 頭尾字母提示：</span>
                        <span class="font-mono text-base sm:text-lg font-extrabold tracking-widest text-brand-800 dark:text-sky-200">${escapeQuizHTML(headTailHint)}</span>
                    </div>
                    <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">共 ${charLen} 字元</span>
                </div>
            </div>
        `;

        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function' && promptBox) {
            global.ReaderPopover.bindReaderContainer(promptBox);
        }
    }

    function renderQuizResultFeedback(isCorrect) {
        if (typeof document === 'undefined' || !currentQuizWord) return;
        const feedbackElem = document.getElementById('quizFeedback');
        if (!feedbackElem) return;

        const lv = Number(currentQuizWord.freeLevel) || 1;
        const streak = Number(currentQuizWord.freeStreak) || 0;
        const lvInfo = (typeof global.getFreeLevelInfo === 'function')
            ? global.getFreeLevelInfo(lv)
            : { name: `臨時 Lv.${lv}` };

        const progressLabel = isCorrect
            ? (lv === 1 ? `臨時 Lv.1（連對 ${streak}/2 升 Lv.2）` : `${lvInfo.name}（已提升，不影響 FSRS）`)
            : `已降回 臨時 Lv.1（FSRS 排程未更動）`;

        const safeWord = escapeQuizHTML(currentQuizWord.word);
        const safeMeaning = escapeQuizHTML(currentQuizWord.meaning || '');
        const safePhonetic = escapeQuizHTML(currentQuizWord.phonetic || '');
        const exampleHtml = (currentQuizWord.sentence && isCardMatchingTargetLang(currentQuizWord, currentQuizLang))
            ? `<div class="mt-2 pt-2 border-t border-current/15 text-xs leading-relaxed">
                    <p class="font-serif text-slate-700 dark:text-slate-200">${currentQuizLang === 'en' ? renderReaderAwareEnglishHtml(currentQuizWord.sentence) : escapeQuizHTML(currentQuizWord.sentence)}</p>
                    ${currentQuizWord.translation ? `<p class="text-slate-500 dark:text-slate-400 mt-0.5">${escapeQuizHTML(currentQuizWord.translation)}</p>` : ''}
               </div>`
            : '';

        if (isCorrect) {
            feedbackElem.className = 'p-4 rounded-xl text-sm font-semibold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800 block';
            feedbackElem.innerHTML = `
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <div class="flex items-center space-x-2">
                        <i class="fa-solid fa-circle-check text-emerald-600 dark:text-emerald-400 text-lg"></i>
                        <span>拼寫正確！<strong>${safeWord}</strong> — ${safeMeaning}</span>
                    </div>
                    <span class="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 font-bold">
                        ⚡ ${escapeQuizHTML(progressLabel)}
                    </span>
                </div>
                ${exampleHtml}
            `;
        } else {
            feedbackElem.className = 'p-4 rounded-xl text-sm font-semibold bg-rose-50 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800 block';
            feedbackElem.innerHTML = `
                <div class="space-y-1">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="flex items-center space-x-2">
                            <i class="fa-solid fa-circle-xmark text-rose-600 dark:text-rose-400 text-lg"></i>
                            <span>答錯了！正確單字：<strong class="underline">${safeWord}</strong></span>
                        </div>
                        <span class="text-[11px] px-2.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/70 text-rose-700 dark:text-rose-300 font-bold">
                            ⚡ ${escapeQuizHTML(progressLabel)}
                        </span>
                    </div>
                    <p class="text-xs text-rose-700 dark:text-rose-300 pl-6">
                        釋義：${safeMeaning} ${safePhonetic ? `(${safePhonetic})` : ''}
                    </p>
                </div>
                ${exampleHtml}
                <div class="mt-3 pt-2.5 border-t border-rose-200/80 dark:border-rose-800/80 flex justify-end">
                    <button type="button" id="quizWrongNextBtn" onclick="nextQuizQuestion()"
                        class="min-h-[44px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold shadow-xs transition inline-flex items-center gap-1.5 cursor-pointer">
                        <span>${escapeQuizHTML((typeof global.t === 'function' && global.t('btnQuizNextManual') !== 'btnQuizNextManual') ? global.t('btnQuizNextManual') : '下一題')}</span>
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                </div>
            `;
        }

        if (global.ReaderPopover && typeof global.ReaderPopover.bindReaderContainer === 'function') {
            global.ReaderPopover.bindReaderContainer(feedbackElem);
        }
        updateQuizCardHeaderBadges(currentQuizWord);
    }

    function scheduleAutoNext() {
        if (quizAutoNextTimer) clearTimeout(quizAutoNextTimer);
        quizAutoNextTimer = setTimeout(() => {
            quizAutoNextTimer = null;
            if (typeof document !== 'undefined') {
                const pop = document.getElementById('readerTranslatePopover');
                if (pop && !pop.classList.contains('hidden')) return;
            }
            nextQuizQuestion();
        }, 2000);
    }

    /**
     * ⌨️ 拼寫／輸入測驗提交處理（一律判定目標單字拼寫）
     */
    function handleQuizSubmit(e) {
        if (e) e.preventDefault();
        if (!currentQuizWord || isQuizAnswerLocked || currentQuizMode !== 'spelling') return;

        const inputElem = typeof document !== 'undefined' ? document.getElementById('quizInput') : null;
        const userRaw = inputElem ? inputElem.value.trim() : '';
        if (!userRaw) {
            if (typeof global.showToast === 'function') global.showToast('請先輸入單字拼寫！', 'warning');
            if (inputElem) inputElem.focus();
            return;
        }

        isQuizAnswerLocked = true;
        if (inputElem) inputElem.disabled = true;

        const submitBtn = typeof document !== 'undefined' ? document.getElementById('quizSubmitBtn') : null;
        if (submitBtn) submitBtn.disabled = true;

        const targetWord = String(currentQuizWord.word || '').trim().toLowerCase();
        const isCorrect = userRaw.toLowerCase() === targetWord;

        quizScoreTotal += 1;
        if (isCorrect) quizScoreCorrect += 1;

        applyQuizFreeGrade(currentQuizWord, isCorrect);
        persistQuizScore();
        updateQuizScoreUI();
        renderQuizResultFeedback(isCorrect);
        if (isCorrect) {
            scheduleAutoNext();
        }
    }

    global.detectCardTargetLang = detectCardTargetLang;
    global.isCardMatchingTargetLang = isCardMatchingTargetLang;
    global.getQuizLanguageFilteredPool = getQuizLanguageFilteredPool;
    global.pickQuizDistractors = pickQuizDistractors;
    global.applyQuizFreeGrade = applyQuizFreeGrade;
    global.buildHeadTailMaskHint = buildHeadTailMaskHint;
    global.buildClozeSentenceHtml = buildClozeSentenceHtml;
    global.syncQuizScoreFromStorage = syncQuizScoreFromStorage;
    global.setQuizLanguage = setQuizLanguage;
    global.setQuizMode = setQuizMode;
    global.nextQuizQuestion = nextQuizQuestion;
    global.handleQuizSubmit = handleQuizSubmit;
    global.speakQuizPromptWord = speakQuizPromptWord;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            detectCardTargetLang,
            isCardMatchingTargetLang,
            getQuizLanguageFilteredPool,
            pickQuizDistractors,
            applyQuizFreeGrade,
            buildHeadTailMaskHint,
            buildClozeSentenceHtml
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
