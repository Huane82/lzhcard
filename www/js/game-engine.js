/**
 * LZHCard - 高成癮度單人遊戲化與音效引擎 (js/game-engine.js)
 * 包含：
 * 1. Web Audio API 升調連擊音效與里程碑粉絲號角 (零外部音檔，支援 Capacitor WebView)
 * 2. 刷卡戰鬥 HUD、5 / 10 / 20 連擊里程碑與 Fever Time (2x XP)
 * 3. 深淵魔王懸賞系統 (鎖定 lapses >= 3 頑固單字)
 * 4. 60 秒極限街機衝刺模式 (Arcade Blitz)
 * 5. 每日神秘寶箱 (Daily Chest + 外觀飾品獎勵解鎖)
 */

(function (global) {
    'use strict';

    const DAILY_CHEST_GOAL = 10;
    const ARCADE_DURATION_SEC = 60;
    const STREAK_SHIELD_COST = 80;
    const STREAK_SHIELD_MAX = 3;
    const FALLBACK_ARCADE_WORDS = [
        { word: 'resilient', meaning: '有彈性的；能迅速恢復的', pos: 'adj.', lang: 'en' },
        { word: 'ephemeral', meaning: '短暫的；朝生暮死的', pos: 'adj.', lang: 'en' },
        { word: 'ubiquitous', meaning: '無所不在的；普遍存在的', pos: 'adj.', lang: 'en' },
        { word: 'eloquent', meaning: '雄辯的；有說服力的', pos: 'adj.', lang: 'en' },
        { word: 'pragmatic', meaning: '務實的；講求實效的', pos: 'adj.', lang: 'en' },
        { word: 'ambiguous', meaning: '模稜兩可的；含糊不清的', pos: 'adj.', lang: 'en' },
        { word: 'perseverance', meaning: '毅力；堅持不懈', pos: 'n.', lang: 'en' },
        { word: 'meticulous', meaning: '一絲不苟的；細心的', pos: 'adj.', lang: 'en' }
    ];
    const FALLBACK_JA_ARCADE_WORDS = [
        { word: '約束', meaning: '約定；承諾', pos: '名詞', lang: 'ja' },
        { word: '努力', meaning: '努力；用功', pos: '名詞', lang: 'ja' },
        { word: '経験', meaning: '經驗；經歷', pos: '名詞', lang: 'ja' },
        { word: '準備', meaning: '準備；預備', pos: '名詞', lang: 'ja' },
        { word: '安全', meaning: '安全；平安', pos: '形容動詞', lang: 'ja' },
        { word: '自由', meaning: '自由；隨意', pos: '形容動詞', lang: 'ja' }
    ];

    let audioCtx = null;
    let sessionCombo = 0;
    let sessionMaxCombo = 0;
    let sessionXpGained = 0;
    let lastRatingUndoSnapshot = null;
    let saveUserDebounceTimer = null;

    // 街機 / 深淵魔王模式狀態與防錯亂鎖定器
    let activeArenaMode = null; // 'arcade' | 'boss' | 'chest'
    let arcadeState = null;
    let arcadeTimerHandle = null;
    let lastArcadeReportPayload = null;
    let battleSessionToken = 0;
    let battleQuestionSeq = 0;
    let pendingBattleTimer = null;
    let isBattleAnsweringLock = false;

    // 獨立封閉的深淵魔王狀態（嚴禁共用 window.currentCard）
    const BossBattleState = {
        sessionToken: 0,
        bossMaxHp: 0,
        bossHp: 0,
        playerHearts: 3,
        combo: 0,
        maxCombo: 0,
        slainCount: 0,
        pool: [],
        distractors: [],
        reviewedWords: [],
        currentSnapshot: null,
        isLocked: false,
        waitingWrongAck: false
    };

    function resetBossBattleState() {
        BossBattleState.sessionToken = 0;
        BossBattleState.bossMaxHp = 0;
        BossBattleState.bossHp = 0;
        BossBattleState.playerHearts = 3;
        BossBattleState.combo = 0;
        BossBattleState.maxCombo = 0;
        BossBattleState.slainCount = 0;
        BossBattleState.pool = [];
        BossBattleState.distractors = [];
        BossBattleState.reviewedWords = [];
        BossBattleState.currentSnapshot = null;
        BossBattleState.isLocked = false;
        BossBattleState.waitingWrongAck = false;
    }

    function shuffleFisherYates(items) {
        const arr = Array.isArray(items) ? [...items] : [];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    function getTodayDateStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function diffCalendarDays(fromDateStr, toDateStr) {
        if (!fromDateStr || !toDateStr) return null;
        const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDateStr).trim());
        const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toDateStr).trim());
        if (!m1 || !m2) return null;
        const utc1 = Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
        const utc2 = Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
        return Math.round((utc2 - utc1) / 86400000);
    }

    function escapeGameHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getCurrentUidSafe() {
        if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.getCurrentUid === 'function') {
            return StorageEngine.getCurrentUid() || 'guest';
        }
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            return firebase.auth().currentUser.uid;
        }
        return 'guest';
    }

    function getDailyGameKey() {
        return `lzhcard_daily_game__${getCurrentUidSafe()}`;
    }

    function getDailyProgress() {
        const today = getTodayDateStr();
        const fallback = { date: today, reviews: 0, chestOpened: false, streakCounted: false };
        try {
            const raw = localStorage.getItem(getDailyGameKey());
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.date !== today) return fallback;
            return {
                date: today,
                reviews: Math.max(0, Number(parsed.reviews) || 0),
                chestOpened: Boolean(parsed.chestOpened),
                streakCounted: Boolean(parsed.streakCounted)
            };
        } catch (e) {
            return fallback;
        }
    }

    function saveDailyProgress(state) {
        try {
            localStorage.setItem(getDailyGameKey(), JSON.stringify(state));
        } catch (e) {}
    }

    function getArcadeBestScore() {
        try {
            return Math.max(0, parseInt(localStorage.getItem(`lzhcard_arcade_best__${getCurrentUidSafe()}`) || '0', 10) || 0);
        } catch (e) {
            return 0;
        }
    }

    function setArcadeBestScore(score) {
        try {
            const best = Math.max(getArcadeBestScore(), Math.floor(Number(score) || 0));
            localStorage.setItem(`lzhcard_arcade_best__${getCurrentUidSafe()}`, String(best));
            return best;
        } catch (e) {
            return score;
        }
    }

    function isSfxMuted() {
        try {
            return localStorage.getItem('lzhcard_sfx_muted') === 'true';
        } catch (e) {
            return false;
        }
    }

    function toggleSfxMute() {
        const nextMuted = !isSfxMuted();
        try {
            localStorage.setItem('lzhcard_sfx_muted', nextMuted ? 'true' : 'false');
        } catch (e) {}
        renderFlashcardHud();
        renderHomePortal();
        if (!nextMuted) playComboSfx(1);
        if (typeof global.showToast === 'function') {
            global.showToast(nextMuted ? '🔇 已靜音遊戲音效' : '🔊 已開啟遊戲打擊音效', 'info');
        }
        return nextMuted;
    }

    /* ==========================================================================
       🎵 Web Audio API 程式化升調合成音效引擎
       ========================================================================== */

    function getAudioContext() {
        if (isSfxMuted()) return null;
        if (typeof window === 'undefined') return null;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!audioCtx) {
            try {
                audioCtx = new AudioCtx();
            } catch (e) {
                return null;
            }
        }
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    }

    function playTone(freq, durationSec = 0.12, type = 'triangle', volume = 0.14, delaySec = 0) {
        const ctx = getAudioContext();
        if (!ctx) return false;
        try {
            const startTime = ctx.currentTime + delaySec;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, startTime);

            gain.gain.setValueAtTime(0.0001, startTime);
            gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + durationSec + 0.02);
            return true;
        } catch (e) {
            return false;
        }
    }

    // 五聲音階頻率向上爬升，連擊越高音階越清脆亢奮
    const COMBO_SCALE_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

    function playComboSfx(comboCount = 1) {
        const idx = Math.min(Math.max(0, (Number(comboCount) || 1) - 1), COMBO_SCALE_SEMITONES.length - 1);
        const semitone = COMBO_SCALE_SEMITONES[idx];
        const freq = 440 * Math.pow(2, semitone / 12);
        const extraBoost = Math.min(180, Math.max(0, (Number(comboCount) - 11) * 18));
        playTone(freq + extraBoost, 0.13, 'triangle', 0.16, 0);
        if (comboCount >= 10) {
            playTone((freq + extraBoost) * 1.5, 0.11, 'sine', 0.08, 0.035);
        }
    }

    function playMissSfx() {
        playTone(210, 0.12, 'sawtooth', 0.09, 0);
        playTone(155, 0.18, 'sawtooth', 0.08, 0.08);
        try {
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
                navigator.vibrate(50);
            }
        } catch (e) {}
    }

    function playMilestoneSfx(milestone) {
        if (milestone >= 20) {
            [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => playTone(f, 0.18, 'triangle', 0.15, i * 0.06));
        } else if (milestone >= 10) {
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(f, 0.16, 'triangle', 0.14, i * 0.065));
        } else {
            [440, 554.37, 659.25].forEach((f, i) => playTone(f, 0.14, 'triangle', 0.13, i * 0.065));
        }
    }

    function playChestSfx() {
        [523.25, 659.25, 783.99, 1046.5, 1567.98].forEach((f, i) => playTone(f, 0.22, 'sine', 0.16, i * 0.075));
    }

    /* ==========================================================================
       📈 經驗值、金幣、等級與連續學習天數統一結算
       ========================================================================== */

    function scheduleCloudProfileAndUserSync() {
        if (saveUserDebounceTimer) clearTimeout(saveUserDebounceTimer);
        saveUserDebounceTimer = setTimeout(() => {
            saveUserDebounceTimer = null;
            if (typeof global.saveUserData === 'function') {
                global.saveUserData();
            }
            if (typeof global.syncMyPublicProfile === 'function') {
                global.syncMyPublicProfile(false);
            }
        }, 700);
    }

    function awardProgression({ xp = 0, coins = 0, unlockFrame = '', unlockBanner = '', unlockTitle = '' } = {}) {
        const u = (typeof global.ensureUserProfileDefaults === 'function')
            ? global.ensureUserProfileDefaults()
            : (global.userData || (global.userData = { progression: {}, cosmetics: {}, coins: 0 }));

        if (!u.progression) u.progression = { xp: 0, level: 1, streakDays: 0, streakShields: 0, lastActiveDate: '', rankTier: '青銅 III', rankPoints: 0, duelWins: 0, duelTotal: 0 };
        if (!u.cosmetics) u.cosmetics = { frame: 'default', banner: 'default', title: 'newcomer', unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };

        const prevLevel = Math.max(1, Number(u.progression.level) || 1);
        const addXp = Math.max(0, Math.round(Number(xp) || 0));
        // 商業化經濟規範：所有遊戲學習與測驗不再發放免費金幣（金幣僅透過 2:8 儲值或創作者商店分潤取得）
        const addCoins = 0;

        u.progression.xp = Math.max(0, (Number(u.progression.xp) || 0) + addXp);
        const newLevel = Math.max(1, Math.floor(Math.sqrt(u.progression.xp / 50)) + 1);
        u.progression.level = newLevel;
        if (!Number.isFinite(Number(u.coins))) u.coins = 0;

        if (unlockFrame && Array.isArray(u.cosmetics.unlockedFrames) && !u.cosmetics.unlockedFrames.includes(unlockFrame)) {
            u.cosmetics.unlockedFrames.push(unlockFrame);
        }
        if (unlockBanner && Array.isArray(u.cosmetics.unlockedBanners) && !u.cosmetics.unlockedBanners.includes(unlockBanner)) {
            u.cosmetics.unlockedBanners.push(unlockBanner);
        }
        if (unlockTitle && Array.isArray(u.cosmetics.unlockedTitles) && !u.cosmetics.unlockedTitles.includes(unlockTitle)) {
            u.cosmetics.unlockedTitles.push(unlockTitle);
        }

        let shieldUsed = false;
        let shieldGranted = false;
        const daily = getDailyProgress();
        if (!daily.streakCounted) {
            const todayStr = getTodayDateStr();
            const prevDateStr = typeof u.progression.lastActiveDate === 'string' ? u.progression.lastActiveDate : '';
            let shields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Number(u.progression.streakShields) || 0));
            let streak = Math.max(0, Number(u.progression.streakDays) || 0);

            if (!prevDateStr) {
                streak = Math.max(1, streak + 1);
            } else {
                const diff = diffCalendarDays(prevDateStr, todayStr);
                if (diff === null || diff === 1) {
                    streak += 1;
                } else if (diff === 2) {
                    if (shields > 0) {
                        shields -= 1;
                        streak = Math.max(1, streak + 1);
                        shieldUsed = true;
                    } else {
                        streak = 1;
                    }
                } else if (diff > 2) {
                    streak = 1;
                } else {
                    streak = Math.max(1, streak);
                }
            }

            if (streak > 0 && streak % 7 === 0 && shields < STREAK_SHIELD_MAX) {
                shields += 1;
                shieldGranted = true;
            }

            u.progression.streakDays = streak;
            u.progression.streakShields = shields;
            u.progression.lastActiveDate = todayStr;
            daily.streakCounted = true;
            saveDailyProgress(daily);
        }

        if (typeof global.updateUserCoinsUI === 'function') global.updateUserCoinsUI();
        if (typeof global.applyNavAvatarFrame === 'function') global.applyNavAvatarFrame();
        if (typeof global.renderProfileSection === 'function' && global.currentTab === 'profile') {
            global.renderProfileSection();
        }
        scheduleCloudProfileAndUserSync();

        if (shieldUsed && typeof global.showToast === 'function') {
            global.showToast(`🛡️ 連勝冷凍護盾已發動！成功守護 ${u.progression.streakDays} 天連勝紀錄！`, 'info');
        }
        if (shieldGranted && typeof global.showToast === 'function') {
            global.showToast(`🛡️ 達成 ${u.progression.streakDays} 天連續學習！免費獲得 1 個連勝冷凍護盾！`, 'success');
        }
        if (newLevel > prevLevel && typeof global.showToast === 'function') {
            playMilestoneSfx(20);
            global.showToast(`🎉 升級啦！冒險等級提升至 Lv.${newLevel}！`, 'success');
        }

        return {
            addedXp: addXp,
            addedCoins: addCoins,
            newLevel,
            leveledUp: newLevel > prevLevel,
            shieldUsed,
            shieldGranted,
            streakDays: u.progression.streakDays,
            streakShields: u.progression.streakShields,
            totalXp: u.progression.xp,
            totalCoins: u.coins
        };
    }

    let isBuyingShield = false;
    async function buyStreakShield() {
        if (isBuyingShield) return false;
        const u = (typeof global.ensureUserProfileDefaults === 'function')
            ? global.ensureUserProfileDefaults()
            : (global.userData || (global.userData = { progression: {}, coins: 0 }));
        if (!u.progression) u.progression = {};

        const isGuest = typeof global.isGuestUser === 'function'
            ? global.isGuestUser()
            : (!(typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || localStorage.getItem('lzhcard_guest_mode') === 'true');
        if (isGuest) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號即可購買連勝冷凍護盾！', 'warning');
            }
            return false;
        }

        const currentShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Number(u.progression.streakShields) || 0));
        if (currentShields >= STREAK_SHIELD_MAX) {
            if (typeof global.showToast === 'function') {
                global.showToast(`🛡️ 您的連勝冷凍護盾已達上限（最多 ${STREAK_SHIELD_MAX} 個）！`, 'info');
            }
            return false;
        }

        const isAdmin = u.role === 'admin' || u.isAdmin === true;
        const currentCoins = Math.max(0, Number(u.coins) || 0);
        if (!isAdmin && currentCoins < STREAK_SHIELD_COST) {
            if (typeof global.showToast === 'function') {
                global.showToast(`🪙 金幣不足！需要 ${STREAK_SHIELD_COST} 金幣才能購買連勝冷凍護盾（可前往儲值或商城）。`, 'warning');
            }
            return false;
        }

        isBuyingShield = true;
        try {
            const authUser = firebase.auth().currentUser;
            const idToken = await authUser.getIdToken(false);
            const backendUrl = (typeof global.SHARED_BACKEND_URL === 'string' && global.SHARED_BACKEND_URL)
                ? global.SHARED_BACKEND_URL
                : 'https://lzhcard.tomlin980415.workers.dev';
            const res = await fetch(`${backendUrl}/shop/buy-shield`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({})
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || '購買護盾失敗');
            }

            if (typeof data.newCoins === 'number') {
                u.coins = data.newCoins;
            }
            u.progression.streakShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Number(data.streakShields) || (currentShields + 1)));

            playMilestoneSfx(5);
            if (typeof global.updateUserCoinsUI === 'function') global.updateUserCoinsUI();
            renderHomePortal();
            if (typeof global.renderProfileSection === 'function') global.renderProfileSection();

            if (typeof global.showToast === 'function') {
                global.showToast(data.message || `🛡️ 成功購買連勝冷凍護盾！（目前持有 ${u.progression.streakShields}/${STREAK_SHIELD_MAX} 個）`, 'success');
            }
            return true;
        } catch (err) {
            if (typeof global.showToast === 'function') {
                global.showToast(err.message || '購買連勝護盾失敗，請稍後再試', 'error');
            }
            return false;
        } finally {
            isBuyingShield = false;
        }
    }

    /* ==========================================================================
       ⚔️ 單人刷卡戰鬥打擊感：連擊、Fever Mode (2x XP) 與浮動特效
       ========================================================================== */

    function spawnFloatingCombatBadge(text, colorClass = 'text-emerald-500') {
        const cardEl = document.getElementById('flashcard');
        if (!cardEl || !cardEl.parentElement) return;
        const badge = document.createElement('div');
        badge.className = `pointer-events-none absolute right-4 top-3 z-30 font-black text-sm drop-shadow-sm animate-bounce ${colorClass}`;
        badge.textContent = text;
        cardEl.parentElement.style.position = 'relative';
        cardEl.parentElement.appendChild(badge);
        setTimeout(() => {
            if (badge.parentNode) badge.parentNode.removeChild(badge);
        }, 850);
    }

    function onCardRated(card, rating) {
        const numericRating = Number(rating) || 1;
        const prevCombo = sessionCombo;
        const prevMaxCombo = sessionMaxCombo;
        const prevSessionXp = sessionXpGained;
        const prevDaily = getDailyProgress();

        let gainedXp = 0;
        let bonusCoins = 0;
        let milestoneHit = 0;

        if (numericRating >= 3) {
            sessionCombo += 1;
            if (sessionCombo > sessionMaxCombo) sessionMaxCombo = sessionCombo;

            const isFever = sessionCombo >= 10;
            const baseXp = numericRating === 4 ? 15 : 10;
            gainedXp = baseXp * (isFever ? 2 : 1);
            sessionXpGained += gainedXp;

            if (sessionCombo === 5 || sessionCombo === 10 || sessionCombo === 20 || (sessionCombo > 20 && sessionCombo % 10 === 0)) {
                milestoneHit = sessionCombo;
                playMilestoneSfx(sessionCombo);
            } else {
                playComboSfx(sessionCombo);
            }

            const feverTag = isFever ? ' 🔥2x FEVER!' : '';
            spawnFloatingCombatBadge(`+${gainedXp} XP (${sessionCombo}連擊)${feverTag}`, isFever ? 'text-amber-500' : 'text-emerald-500');

            if (milestoneHit && typeof global.showToast === 'function') {
                if (milestoneHit === 10) {
                    global.showToast('🔥 10 連擊達成！進入 FEVER MODE（雙倍經驗 2x XP）！', 'success');
                } else if (milestoneHit === 20) {
                    global.showToast('⚡ 20 連擊無雙領域達成！', 'success');
                } else if (milestoneHit === 5) {
                    global.showToast('✨ 5 連擊達成！手感升溫中！', 'info');
                } else {
                    global.showToast(`👑 狂暴 ${milestoneHit} 連擊！氣勢如虹！`, 'success');
                }
            }
        } else if (numericRating === 2) {
            gainedXp = 5;
            sessionXpGained += gainedXp;
            playComboSfx(Math.max(1, sessionCombo));
            spawnFloatingCombatBadge(`+${gainedXp} XP`, 'text-sky-500');
        } else {
            sessionCombo = 0;
            playMissSfx();
            spawnFloatingCombatBadge('連擊中斷！', 'text-rose-500');
        }

        // 更新今日進度計數（供每日寶箱計算）
        const nextDaily = { ...prevDaily, reviews: prevDaily.reviews + 1 };
        saveDailyProgress(nextDaily);

        const awardResult = awardProgression({ xp: gainedXp });

        lastRatingUndoSnapshot = {
            prevCombo,
            prevMaxCombo,
            prevSessionXp,
            prevDaily,
            addedXp: awardResult.addedXp
        };

        if (nextDaily.reviews === DAILY_CHEST_GOAL && !nextDaily.chestOpened && typeof global.showToast === 'function') {
            global.showToast('🎁 今日學習目標達成！可回主頁開啟「每日神秘寶箱」！', 'success');
        }

        renderFlashcardHud(card);
        renderHomePortal();
        return { combo: sessionCombo, isFever: sessionCombo >= 10, gainedXp, bonusCoins: 0 };
    }

    function rollbackLastReward() {
        if (!lastRatingUndoSnapshot) return false;
        const snap = lastRatingUndoSnapshot;
        lastRatingUndoSnapshot = null;

        sessionCombo = snap.prevCombo;
        sessionMaxCombo = snap.prevMaxCombo;
        sessionXpGained = snap.prevSessionXp;
        saveDailyProgress(snap.prevDaily);

        const u = global.userData;
        if (u && u.progression) {
            u.progression.xp = Math.max(0, (Number(u.progression.xp) || 0) - (snap.addedXp || 0));
            u.progression.level = Math.max(1, Math.floor(Math.sqrt(u.progression.xp / 50)) + 1);
            scheduleCloudProfileAndUserSync();
        }
        renderFlashcardHud();
        renderHomePortal();
        if (typeof global.renderProfileSection === 'function' && global.currentTab === 'profile') {
            global.renderProfileSection();
        }
        return true;
    }

    function getBattleTargetLang() {
        try {
            const raw = String(localStorage.getItem('lzhcard_target_lang') || 'en').trim().toLowerCase();
            if (raw === 'ja' || raw === 'jp' || raw === 'japanese') return 'ja';
            if (raw === 'zh' || raw === 'zh-tw' || raw === 'zh_tw' || raw === 'chinese') return 'zh-TW';
        } catch (e) {}
        return 'en';
    }

    function isCardValidForBattleLang(card, targetLang = getBattleTargetLang()) {
        if (!card || typeof card !== 'object') return false;
        if (typeof global.isCardMatchingTargetLang === 'function') {
            return global.isCardMatchingTargetLang(card, targetLang);
        }
        if (card.lang && typeof card.lang === 'string') {
            const exp = card.lang.trim().toLowerCase();
            if (targetLang === 'ja') return exp === 'ja' || exp === 'jp' || exp === 'japanese';
            if (targetLang === 'zh-TW') return exp === 'zh' || exp === 'zh-tw' || exp === 'chinese';
            return exp === 'en' || exp === 'english';
        }
        const word = String(card.word || '').trim();
        const phonetic = String(card.phonetic || '').trim();
        const sentence = String(card.sentence || '').trim();
        const category = String(card.category || '').trim();
        const kanaRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
        const jaCatRegex = /(?:jlpt|\bn[1-5]\b|日[語文檢]|五十音|假名|japanese)/i;
        const cjkRegex = /[\u4E00-\u9FFF]/;
        const latinRegex = /[A-Za-z]/;
        let detected = 'en';
        if (kanaRegex.test(word) || kanaRegex.test(phonetic) || kanaRegex.test(sentence) || jaCatRegex.test(category)) detected = 'ja';
        else if (cjkRegex.test(word) && !latinRegex.test(word)) detected = 'zh-TW';
        return detected === targetLang;
    }

    function isValidBattleMeaning(meaning) {
        if (meaning === null || meaning === undefined) return false;
        const str = String(meaning).trim();
        if (!str) return false;
        const lower = str.toLowerCase();
        const invalidSubstrings = [
            '未設定釋義', '解析中', '自動解析中', 'ai 自動解析中',
            '無釋義', '無母語釋義', '無母語釋意', '尚無釋義', '暫無釋義',
            'no definition', 'no meaning'
        ];
        if (invalidSubstrings.some(tok => lower.includes(tok))) return false;
        const invalidExact = ['-', '--', '---', 'pending', 'empty', 'n/a', 'null', 'undefined', 'none'];
        if (invalidExact.includes(lower)) return false;
        return normalizeMeaning(str).length > 0;
    }

    function normalizeMeaning(m) {
        if (m === null || m === undefined) return '';
        return String(m)
            .replace(/^\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|aux|int|det|art|num)\.\s*/i, '')
            .replace(/[\u3000\s]+/g, ' ')
            .replace(/[；;、，,。．.！!？?：:（）()【】\[\]「」『』"'\/\\|~～]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function extractMeaningTokens(m) {
        if (!m) return [];
        return String(m)
            .split(/[；;、，,/|・\n]+/)
            .map(part => normalizeMeaning(part))
            .filter(tok => tok.length > 0);
    }

    function clearPendingBattleTimer() {
        if (pendingBattleTimer) {
            clearTimeout(pendingBattleTimer);
            pendingBattleTimer = null;
        }
    }

    function getAbyssBossWords() {
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        const activeCats = global.selectedCategories || ['ALL'];
        const targetLang = getBattleTargetLang();
        const defaultCat = (typeof global.t === 'function' && global.t('defaultCategoryName') !== 'defaultCategoryName')
            ? global.t('defaultCategoryName')
            : '預設字庫';

        const activeAbyss = list.filter(w => {
            if (!w || !w.word || !String(w.word).trim()) return false;
            if (!isCardValidForBattleLang(w, targetLang)) return false;
            if (!isValidBattleMeaning(w.meaning)) return false;
            const cat = (w.category && w.category.trim()) ? w.category.trim() : defaultCat;
            const matchCat = activeCats.includes('ALL') || activeCats.includes(cat);
            return matchCat && (Number(w.lapses) || 0) >= 3;
        });

        if (activeAbyss.length > 0) return activeAbyss;
        return list.filter(w => (
            w && w.word && String(w.word).trim() &&
            isCardValidForBattleLang(w, targetLang) &&
            isValidBattleMeaning(w.meaning) &&
            (Number(w.lapses) || 0) >= 3
        ));
    }

    function renderFlashcardHud(currentCardObj = null) {
        const hud = document.getElementById('flashcardGameHud');
        const flashcardEl = document.getElementById('flashcard');
        const isFever = sessionCombo >= 10;

        if (flashcardEl) {
            flashcardEl.classList.remove(
                'ring-2', 'ring-4',
                'ring-amber-400/70', 'ring-amber-400/80', 'ring-orange-500/80', 'ring-purple-500/90',
                'shadow-[0_0_20px_rgba(251,191,36,0.35)]',
                'shadow-[0_0_28px_rgba(245,158,11,0.45)]',
                'shadow-[0_0_34px_rgba(168,85,247,0.6)]'
            );
            if (sessionCombo >= 20) {
                flashcardEl.classList.add('ring-4', 'ring-purple-500/90', 'shadow-[0_0_34px_rgba(168,85,247,0.6)]');
            } else if (sessionCombo >= 10) {
                flashcardEl.classList.add('ring-4', 'ring-orange-500/80', 'shadow-[0_0_28px_rgba(245,158,11,0.45)]');
            } else if (sessionCombo >= 5) {
                flashcardEl.classList.add('ring-2', 'ring-amber-400/70', 'shadow-[0_0_20px_rgba(251,191,36,0.35)]');
            }
        }

        if (!hud) return;
        const daily = getDailyProgress();
        const abyssList = getAbyssBossWords();
        const activeCard = currentCardObj || (typeof global.currentCard !== 'undefined' ? global.currentCard : null);
        const isCurrentAbyss = activeCard && (Number(activeCard.lapses) || 0) >= 3;
        const chestPct = Math.min(100, Math.round((daily.reviews / DAILY_CHEST_GOAL) * 100));
        const muted = isSfxMuted();

        hud.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl border transition-all ${isFever
                ? 'bg-gradient-to-r from-amber-500/15 via-rose-500/15 to-purple-500/15 border-amber-400 dark:border-amber-500'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 shadow-2xs'}">
                <div class="flex items-center flex-wrap gap-2">
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-extrabold ${sessionCombo >= 5
                        ? 'bg-amber-500 text-white shadow-2xs'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200'}">
                        <span>🔥</span>
                        <span>${sessionCombo} 連擊</span>
                    </span>
                    ${isFever ? `
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-rose-500 to-amber-500 text-white text-[10px] font-black animate-pulse">
                            ⚡ FEVER 2x XP
                        </span>
                    ` : ''}
                    ${isCurrentAbyss ? `
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700 text-[10px] font-extrabold">
                            👹 深淵懸賞字 (忘記 ${Number(activeCard.lapses)} 次)
                        </span>
                    ` : ''}
                    <span class="text-[11px] font-bold text-brand-600 dark:text-brand-400">+${sessionXpGained} XP</span>
                </div>

                <div class="flex items-center gap-2">
                    ${abyssList.length > 0 ? `
                        <button type="button" onclick="GameEngine.startAbyssBossMode()" class="px-2 py-0.5 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800 text-[10px] font-extrabold cursor-pointer transition">
                            ⚔️ 討伐魔王 (${abyssList.length})
                        </button>
                    ` : ''}
                    <div class="hidden sm:flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400" title="今日寶箱進度">
                        <span>🎁 ${Math.min(daily.reviews, DAILY_CHEST_GOAL)}/${DAILY_CHEST_GOAL}</span>
                        <div class="w-14 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div class="h-full bg-emerald-500 rounded-full transition-all" style="width:${chestPct}%"></div>
                        </div>
                    </div>
                    <button type="button" onclick="GameEngine.toggleSfxMute()" title="${muted ? '開啟打擊音效' : '靜音遊戲音效'}" class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200 flex items-center justify-center text-xs cursor-pointer transition">
                        <i class="fa-solid ${muted ? 'fa-volume-xmark text-rose-500' : 'fa-music text-brand-500'}"></i>
                    </button>
                </div>
            </div>
        `;
    }

    /* ==========================================================================
       🏠 主頁冒險面板 (Render Home Game & Arena Portal)
       ========================================================================== */

    function renderHomePortal() {
        const container = document.getElementById('homeGamePortalContainer');
        if (!container) return;

        const u = (typeof global.ensureUserProfileDefaults === 'function')
            ? global.ensureUserProfileDefaults()
            : (global.userData || {});
        const prog = u.progression || {};
        const level = Math.max(1, Number(prog.level) || 1);
        const xp = Math.max(0, Number(prog.xp) || 0);
        const prevLvXp = Math.pow(level - 1, 2) * 50;
        const nextLvXp = Math.pow(level, 2) * 50;
        const span = Math.max(50, nextLvXp - prevLvXp);
        const curLvXp = Math.max(0, xp - prevLvXp);
        const xpPct = Math.min(100, Math.round((curLvXp / span) * 100));
        const coins = Math.max(0, Number(u.coins) || 0);
        const streakDays = Math.max(0, Number(prog.streakDays) || 0);
        const streakShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Number(prog.streakShields) || 0));
        const rankTier = prog.rankTier || '青銅 III';
        const rankPoints = Math.max(0, Number(prog.rankPoints) || 0);

        const daily = getDailyProgress();
        const chestReady = daily.reviews >= DAILY_CHEST_GOAL && !daily.chestOpened;
        const chestPct = Math.min(100, Math.round((daily.reviews / DAILY_CHEST_GOAL) * 100));
        const abyssWords = getAbyssBossWords();
        const bestArcade = getArcadeBestScore();
        const muted = isSfxMuted();
        const memBadgeHtml = (global.MembershipEngine && typeof global.MembershipEngine.renderBadgeHtml === 'function')
            ? global.MembershipEngine.renderBadgeHtml(u, { size: '2xs' })
            : '';

        container.innerHTML = `
            <div class="max-w-2xl mx-auto space-y-4">
                <!-- 玩家冒險狀態條與每日神秘寶箱 -->
                <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 text-white font-black text-sm flex items-center justify-center shadow-xs shrink-0">
                                Lv.${level}
                            </div>
                            <div class="min-w-0">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-xs font-extrabold text-slate-900 dark:text-white">${escapeGameHTML(rankTier)}</span>
                                    ${memBadgeHtml}
                                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">${rankPoints} RP</span>
                                    <span class="text-[11px] font-bold text-amber-600 dark:text-amber-400">🔥 ${streakDays} 天</span>
                                    <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-300 border border-sky-200 dark:border-sky-800" title="漏學 1 天時自動消耗護盾保護連勝">🛡️ ${streakShields}/${STREAK_SHIELD_MAX}</span>
                                    <span class="text-[11px] font-bold text-amber-500">🪙 ${coins}</span>
                                </div>
                                <div class="flex items-center gap-2 mt-1">
                                    <div class="w-32 sm:w-44 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                        <div class="h-full bg-gradient-to-r from-brand-500 to-purple-500 rounded-full transition-all" style="width:${xpPct}%"></div>
                                    </div>
                                    <span class="text-[10px] font-mono text-slate-500 dark:text-slate-400">${curLvXp}/${span} XP</span>
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center gap-1.5 flex-wrap">
                            ${streakShields < STREAK_SHIELD_MAX ? `
                                <button type="button" onclick="GameEngine.buyStreakShield()" class="px-2.5 py-1.5 rounded-xl bg-sky-50 dark:bg-sky-950/50 hover:bg-sky-100 dark:hover:bg-sky-900/70 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 text-[11px] font-bold transition cursor-pointer" title="花費 ${STREAK_SHIELD_COST} 金幣購買連勝冷凍護盾">
                                    🛡️ +1 護盾 (${STREAK_SHIELD_COST}🪙)
                                </button>
                            ` : ''}
                            <button type="button" onclick="GameEngine.toggleSfxMute()" class="px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200 text-xs font-bold transition cursor-pointer" title="切換音效">
                                <i class="fa-solid ${muted ? 'fa-volume-xmark text-rose-500' : 'fa-volume-high text-brand-500'}"></i>
                            </button>
                            <button type="button" onclick="GameEngine.openDailyChest()" class="px-3 py-1.5 rounded-xl text-xs font-extrabold transition flex items-center gap-1.5 cursor-pointer ${chestReady
                                ? 'bg-gradient-to-r from-amber-500 to-rose-500 text-white shadow-md animate-pulse'
                                : (daily.chestOpened
                                    ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300')}">
                                <span>🎁</span>
                                <span>${chestReady ? '開啟每日寶箱！' : (daily.chestOpened ? '今日寶箱已領取' : `寶箱進度 ${Math.min(daily.reviews, DAILY_CHEST_GOAL)}/${DAILY_CHEST_GOAL}`)}</span>
                            </button>
                        </div>
                    </div>

                    ${!daily.chestOpened && !chestReady ? `
                        <div class="w-full h-1.5 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                            <div class="h-full bg-gradient-to-r from-amber-400 to-emerald-500 rounded-full transition-all duration-300" style="width:${chestPct}%"></div>
                        </div>
                    ` : ''}
                </div>

                <!-- 四大挑戰模式入口 -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <button type="button" onclick="GameEngine.startArcadeMode()" class="p-3.5 bg-white dark:bg-slate-800 hover:bg-amber-50/70 dark:hover:bg-slate-700/70 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-amber-400 text-left transition shadow-2xs space-y-2 cursor-pointer group">
                        <div class="flex items-center justify-between">
                            <span class="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center text-base group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-stopwatch"></i>
                            </span>
                            <span class="text-[10px] font-bold text-amber-600 dark:text-amber-400 font-mono">最佳 ${bestArcade}</span>
                        </div>
                        <div>
                            <div class="text-xs font-extrabold text-slate-900 dark:text-white">60 秒街機衝刺</div>
                            <div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">極限四選一・連擊加秒</div>
                        </div>
                    </button>

                    <button type="button" onclick="GameEngine.startAbyssBossMode()" class="p-3.5 bg-white dark:bg-slate-800 hover:bg-rose-50/70 dark:hover:bg-slate-700/70 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-rose-400 text-left transition shadow-2xs space-y-2 cursor-pointer group">
                        <div class="flex items-center justify-between">
                            <span class="w-9 h-9 rounded-xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center text-base group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-skull"></i>
                            </span>
                            <span class="px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${abyssWords.length > 0 ? 'bg-rose-500 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}">${abyssWords.length} 隻</span>
                        </div>
                        <div>
                            <div class="text-xs font-extrabold text-slate-900 dark:text-white">深淵魔王懸賞</div>
                            <div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">專打錯 3 次以上魔王字</div>
                        </div>
                    </button>

                    <button type="button" id="homeMultiplayerEntry" onclick="if(typeof MultiplayerEngine!=='undefined') MultiplayerEngine.openModal('duel')" class="p-3.5 bg-white dark:bg-slate-800 hover:bg-brand-50/70 dark:hover:bg-slate-700/70 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-brand-400 text-left transition shadow-2xs space-y-2 cursor-pointer group">
                        <div class="flex items-center justify-between">
                            <span class="w-9 h-9 rounded-xl bg-brand-100 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center text-base group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-bolt"></i>
                            </span>
                            <span class="text-[10px] font-bold text-brand-600 dark:text-brand-400">即時連線</span>
                        </div>
                        <div>
                            <div class="text-xs font-extrabold text-slate-900 dark:text-white">1v1 拔河排位</div>
                            <div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">好友邀請碼 / 排位配對</div>
                        </div>
                    </button>

                    <button type="button" onclick="if(typeof MultiplayerEngine!=='undefined') MultiplayerEngine.openModal('coop')" class="p-3.5 bg-white dark:bg-slate-800 hover:bg-purple-50/70 dark:hover:bg-slate-700/70 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-purple-400 text-left transition shadow-2xs space-y-2 cursor-pointer group">
                        <div class="flex items-center justify-between">
                            <span class="w-9 h-9 rounded-xl bg-purple-100 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center text-base group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-dragon"></i>
                            </span>
                            <span class="text-[10px] font-bold text-purple-600 dark:text-purple-400">團隊 / 影子</span>
                        </div>
                        <div>
                            <div class="text-xs font-extrabold text-slate-900 dark:text-white">四人打王 & 幽靈</div>
                            <div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">共鬥討伐 / 10題影子競速</div>
                        </div>
                    </button>
                </div>
            </div>
        `;
    }

    /* ==========================================================================
       🎁 每日神秘寶箱邏輯
       ========================================================================== */

    function openDailyChest() {
        const daily = getDailyProgress();
        if (daily.chestOpened) {
            if (typeof global.showToast === 'function') {
                global.showToast('🎁 您今天已經領取過每日神秘寶箱囉，明天繼續加油！', 'info');
            }
            return false;
        }
        if (daily.reviews < DAILY_CHEST_GOAL) {
            if (typeof global.showToast === 'function') {
                global.showToast(`⏳ 還差 ${DAILY_CHEST_GOAL - daily.reviews} 張單字卡就能開啟今日神秘寶箱！`, 'warning');
            }
            return false;
        }

        daily.chestOpened = true;
        saveDailyProgress(daily);

        const rewardXp = 60 + Math.floor(Math.random() * 61);    // 60~120 XP

        const u = global.userData || {};
        const cos = u.cosmetics || {};
        let unlockedCosmeticLabel = '';
        let unlockArgs = {};

        const unownedFrames = ['cyber_neon', 'amber_scholar'].filter(id => !(cos.unlockedFrames || []).includes(id));
        const unownedBanners = ['sakura_dawn', 'midnight_cosmos'].filter(id => !(cos.unlockedBanners || []).includes(id));

        if (unownedFrames.length > 0 && Math.random() < 0.65) {
            const pick = unownedFrames[Math.floor(Math.random() * unownedFrames.length)];
            unlockArgs.unlockFrame = pick;
            unlockedCosmeticLabel = pick === 'cyber_neon' ? '✨ 限定頭像框「霓虹脈衝」' : '✨ 限定頭像框「琥珀學者」';
        } else if (unownedBanners.length > 0) {
            const pick = unownedBanners[Math.floor(Math.random() * unownedBanners.length)];
            unlockArgs.unlockBanner = pick;
            unlockedCosmeticLabel = pick === 'sakura_dawn' ? '🌸 限定橫幅「櫻吹初曉」' : '🌌 限定橫幅「深空星雲」';
        }

        let droppedShield = false;
        const currentShields = Math.min(STREAK_SHIELD_MAX, Math.max(0, Number(u.progression?.streakShields) || 0));
        if (!unlockedCosmeticLabel && currentShields < STREAK_SHIELD_MAX && Math.random() < 0.45) {
            if (!u.progression) u.progression = {};
            u.progression.streakShields = currentShields + 1;
            droppedShield = true;
        }

        awardProgression({ xp: rewardXp, ...unlockArgs });
        playChestSfx();
        renderHomePortal();
        renderFlashcardHud();

        const modalBody = document.getElementById('gameArenaBody');
        if (modalBody) {
            activeArenaMode = 'chest';
            modalBody.innerHTML = `
                <div class="text-center space-y-4 py-4">
                    <div class="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 text-white flex items-center justify-center text-4xl shadow-xl animate-bounce">
                        🎁
                    </div>
                    <div>
                        <h3 class="text-xl font-black text-slate-900 dark:text-white">每日神秘寶箱開啟！</h3>
                        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">恭喜完成今日 ${DAILY_CHEST_GOAL} 次單字複習挑戰！</p>
                    </div>
                    <div class="max-w-xs mx-auto">
                        <div class="p-3 bg-brand-50 dark:bg-brand-950/40 border border-brand-200 dark:border-brand-800 rounded-xl">
                            <div class="text-[11px] font-bold text-brand-700 dark:text-brand-300">經驗獎勵</div>
                            <div class="text-lg font-black text-brand-600 dark:text-brand-400 mt-0.5">+${rewardXp} XP</div>
                        </div>
                    </div>
                    ${unlockedCosmeticLabel ? `
                        <div class="p-3 bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 rounded-xl text-xs font-extrabold text-purple-700 dark:text-purple-300">
                            🎉 驚喜解鎖稀有外觀：${escapeGameHTML(unlockedCosmeticLabel)}（可至「個人檔案」裝備！）
                        </div>
                    ` : ''}
                    ${droppedShield ? `
                        <div class="p-3 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 rounded-xl text-xs font-extrabold text-sky-700 dark:text-sky-300">
                            🛡️ 額外掉落：連勝冷凍護盾 +1（目前持有 ${u.progression.streakShields}/${STREAK_SHIELD_MAX} 個）
                        </div>
                    ` : ''}
                    <button type="button" onclick="GameEngine.closeArenaModal()" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs rounded-xl shadow-sm cursor-pointer">
                        收下獎勵！
                    </button>
                </div>
            `;
            if (typeof global.openModal === 'function') global.openModal('gameArenaModal');
        }
        return true;
    }

    /* ==========================================================================
       ⚡ 共用題庫出題器（60 秒街機 & 深淵魔王共鬥使用，不動 FSRS）
       ========================================================================== */

    function buildQuestionPool(preferAbyssOnly = false) {
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        const targetLang = getBattleTargetLang();
        const raw = preferAbyssOnly
            ? getAbyssBossWords()
            : list.filter(w => (
                w &&
                w.word &&
                String(w.word).trim() &&
                isCardValidForBattleLang(w, targetLang) &&
                isValidBattleMeaning(w.meaning)
            ));

        const uniqueMap = new Map();
        for (const item of raw) {
            const key = String(item.word).trim().toLowerCase();
            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, item);
            }
        }
        const candidates = Array.from(uniqueMap.values());

        if (!preferAbyssOnly && candidates.length < 4) {
            const fallbackBank = targetLang === 'ja' ? FALLBACK_JA_ARCADE_WORDS : FALLBACK_ARCADE_WORDS;
            const existingSet = new Set(candidates.map(c => String(c.word).trim().toLowerCase()));
            fallbackBank.forEach(fb => {
                if (!existingSet.has(fb.word.toLowerCase())) {
                    candidates.push({ ...fb });
                    existingSet.add(fb.word.toLowerCase());
                }
            });
        }
        return candidates;
    }

    function createMcqQuestion(targetWordObj, distractorPool) {
        const cleanWord = String(targetWordObj?.word || '').trim();
        const cleanMeaning = String(targetWordObj?.meaning || '').trim();
        const targetId = targetWordObj?.id ? String(targetWordObj.id) : `word_${cleanWord.toLowerCase()}`;
        const correctNorm = normalizeMeaning(cleanMeaning);
        const targetLang = getBattleTargetLang();

        const usedNorms = new Set([correctNorm]);
        const usedTokens = new Set(extractMeaningTokens(cleanMeaning));
        const usedWords = new Set([cleanWord.toLowerCase()]);

        const correctItem = {
            cardId: targetId,
            word: cleanWord,
            meaning: cleanMeaning,
            normalizedMeaning: correctNorm
        };

        const distractorItems = [];
        const tryPushDistractor = (item) => {
            if (!item || !item.word || !isValidBattleMeaning(item.meaning)) return false;
            const candWord = String(item.word).trim();
            const candWordKey = candWord.toLowerCase();
            if (usedWords.has(candWordKey)) return false;
            if (!isCardValidForBattleLang(item, targetLang)) return false;

            const candMeaning = String(item.meaning).trim();
            const candNorm = normalizeMeaning(candMeaning);
            if (!candNorm || usedNorms.has(candNorm)) return false;

            const candTokens = extractMeaningTokens(candMeaning);
            if (candTokens.some(tok => usedTokens.has(tok))) return false;

            usedWords.add(candWordKey);
            usedNorms.add(candNorm);
            candTokens.forEach(tok => usedTokens.add(tok));
            distractorItems.push({
                cardId: item.id ? String(item.id) : `word_${candWordKey}`,
                word: candWord,
                meaning: candMeaning,
                normalizedMeaning: candNorm
            });
            return true;
        };

        const safePool = Array.isArray(distractorPool) ? [...distractorPool].sort(() => Math.random() - 0.5) : [];
        for (const item of safePool) {
            tryPushDistractor(item);
            if (distractorItems.length >= 3) break;
        }

        if (distractorItems.length < 3) {
            const fallbackBank = targetLang === 'ja' ? FALLBACK_JA_ARCADE_WORDS : FALLBACK_ARCADE_WORDS;
            for (const fb of [...fallbackBank].sort(() => Math.random() - 0.5)) {
                tryPushDistractor(fb);
                if (distractorItems.length >= 3) break;
            }
        }

        const optionItems = [correctItem, ...distractorItems].sort(() => Math.random() - 0.5);
        const correctIndex = optionItems.findIndex(o => o.cardId === targetId || o.normalizedMeaning === correctNorm);
        const questionUid = `bq_${++battleQuestionSeq}_${Date.now()}`;

        return {
            questionUid,
            targetId,
            word: cleanWord,
            pos: targetWordObj?.pos || '',
            meaning: cleanMeaning,
            correctMeaning: cleanMeaning,
            correctNormalizedMeaning: correctNorm,
            lapses: Number(targetWordObj?.lapses) || 0,
            options: optionItems.map(o => o.meaning),
            optionItems,
            correctIndex
        };
    }

    function getOptionButtonStyle(idx, feedback, hoverVariant = 'brand') {
        const hoverBorder = hoverVariant === 'rose'
            ? 'hover:bg-rose-50 dark:hover:bg-slate-700 hover:border-rose-400'
            : 'hover:bg-brand-50 dark:hover:bg-slate-700 hover:border-brand-400';
        if (!feedback) {
            return {
                btnClass: `w-full p-3.5 rounded-xl bg-white dark:bg-slate-900 ${hoverBorder} border border-slate-200 dark:border-slate-700 text-left text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 transition flex items-center gap-2.5 cursor-pointer`,
                badgeClass: 'w-6 h-6 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 text-xs font-black flex items-center justify-center shrink-0',
                badgeHtml: String(idx + 1),
                disabledAttr: ''
            };
        }
        if (idx === feedback.correctIdx) {
            return {
                btnClass: 'w-full p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border-2 border-emerald-500 text-left text-xs sm:text-sm font-extrabold text-emerald-800 dark:text-emerald-200 ring-2 ring-emerald-500/30 transition flex items-center gap-2.5 pointer-events-none',
                badgeClass: 'w-6 h-6 rounded-lg bg-emerald-500 text-white text-xs font-black flex items-center justify-center shrink-0',
                badgeHtml: '✓',
                disabledAttr: 'disabled'
            };
        }
        if (!feedback.isCorrect && idx === feedback.selectedIdx) {
            return {
                btnClass: 'w-full p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/60 border-2 border-rose-500 text-left text-xs sm:text-sm font-extrabold text-rose-800 dark:text-rose-200 ring-2 ring-rose-500/30 transition flex items-center gap-2.5 pointer-events-none',
                badgeClass: 'w-6 h-6 rounded-lg bg-rose-500 text-white text-xs font-black flex items-center justify-center shrink-0',
                badgeHtml: '✕',
                disabledAttr: 'disabled'
            };
        }
        return {
            btnClass: 'w-full p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-left text-xs sm:text-sm font-bold text-slate-400 dark:text-slate-500 opacity-55 transition flex items-center gap-2.5 pointer-events-none',
            badgeClass: 'w-6 h-6 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-400 text-xs font-black flex items-center justify-center shrink-0',
            badgeHtml: String(idx + 1),
            disabledAttr: 'disabled'
        };
    }

    /* ==========================================================================
       🕹️ 60 秒極限街機衝刺模式 (Arcade Blitz)
       ========================================================================== */

    function startArcadeMode() {
        closeArenaModal();
        const pool = buildQuestionPool(false);
        if (pool.length === 0) {
            if (typeof global.showToast === 'function') {
                global.showToast('⚠️ 目前沒有可用的有效單字題庫，請先新增附有釋義的單字！', 'warning');
            }
            return false;
        }
        const distractors = buildQuestionPool(false);

        battleSessionToken += 1;
        const mySession = battleSessionToken;
        isBattleAnsweringLock = false;
        activeArenaMode = 'arcade';
        arcadeState = {
            sessionToken: mySession,
            timeLeft: ARCADE_DURATION_SEC,
            score: 0,
            correctCount: 0,
            totalCount: 0,
            combo: 0,
            maxCombo: 0,
            pool,
            distractors,
            currentQ: null,
            reviewedWords: [],
            locked: false,
            waitingWrongAck: false,
            lastFeedback: null
        };

        nextArcadeQuestion();
        if (typeof global.openModal === 'function') global.openModal('gameArenaModal');

        arcadeTimerHandle = setInterval(() => {
            if (!arcadeState || activeArenaMode !== 'arcade' || arcadeState.sessionToken !== mySession) return;
            arcadeState.timeLeft = Math.max(0, arcadeState.timeLeft - 1);
            const timerEl = document.getElementById('arcadeTimerValue');
            if (timerEl) {
                timerEl.textContent = `${arcadeState.timeLeft}s`;
                timerEl.className = `font-mono font-black text-base ${arcadeState.timeLeft <= 10 ? 'text-rose-500 animate-pulse' : 'text-amber-500'}`;
            }
            if (arcadeState.timeLeft <= 0 && arcadeState.waitingWrongAck) {
                const nextBtnLabel = document.getElementById('arcadeNextQuestionBtnLabel');
                if (nextBtnLabel) nextBtnLabel.textContent = '時間到・查看結算';
            }
            if (arcadeState.timeLeft <= 0 && !isBattleAnsweringLock && !arcadeState.locked && !arcadeState.waitingWrongAck) {
                finishArcadeMode();
            }
        }, 1000);
        return true;
    }

    function nextArcadeQuestion() {
        if (!arcadeState || activeArenaMode !== 'arcade') return;
        const pool = arcadeState.pool;
        let pick = pool[Math.floor(Math.random() * pool.length)];
        if (pool.length > 1 && arcadeState.currentQ && pick.word === arcadeState.currentQ.word) {
            const altIdx = (pool.indexOf(pick) + 1) % pool.length;
            pick = pool[altIdx];
        }
        arcadeState.currentQ = createMcqQuestion(pick, arcadeState.distractors);
        arcadeState.locked = false;
        arcadeState.waitingWrongAck = false;
        arcadeState.lastFeedback = null;
        isBattleAnsweringLock = false;
        renderArcadeView(null);
    }

    function advanceArcadeNext() {
        if (activeArenaMode !== 'arcade' || !arcadeState || !arcadeState.waitingWrongAck) return false;
        arcadeState.waitingWrongAck = false;
        arcadeState.locked = false;
        isBattleAnsweringLock = false;
        if (arcadeState.timeLeft <= 0) {
            finishArcadeMode();
        } else {
            nextArcadeQuestion();
        }
        return true;
    }

    function renderArcadeView(feedback = null) {
        const body = document.getElementById('gameArenaBody');
        if (!body || !arcadeState || !arcadeState.currentQ) return;
        arcadeState.lastFeedback = feedback;
        const q = arcadeState.currentQ;
        const isFever = arcadeState.combo >= 10;
        const multText = isFever ? '2x FEVER' : (arcadeState.combo >= 5 ? '1.5x' : '1x');
        const safeQid = escapeGameHTML(q.questionUid);
        const showWrongNext = Boolean(feedback && !feedback.isCorrect);

        body.innerHTML = `
            <div class="space-y-4">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-3">
                    <div class="flex items-center gap-2">
                        <span class="px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-xs font-black">⚡ 60秒街機</span>
                        <span class="text-xs font-extrabold ${isFever ? 'text-rose-500 animate-pulse' : 'text-brand-600 dark:text-brand-400'}">${arcadeState.combo} 連擊 (${multText})</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-xs font-extrabold text-slate-700 dark:text-slate-200">分數 <span class="text-brand-600 dark:text-brand-400 font-mono text-sm">${arcadeState.score}</span></span>
                        <span id="arcadeTimerValue" class="font-mono font-black text-base ${arcadeState.timeLeft <= 10 ? 'text-rose-500 animate-pulse' : 'text-amber-500'}">${arcadeState.timeLeft}s</span>
                        <button type="button" onclick="GameEngine.closeArenaModal()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>

                <div class="p-5 rounded-2xl text-center space-y-1.5 border ${isFever
                    ? 'bg-gradient-to-br from-amber-50 to-rose-50 dark:from-amber-950/40 dark:to-rose-950/40 border-amber-400'
                    : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700'}">
                    ${q.pos ? `<span class="inline-block px-2 py-0.5 rounded bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 text-[10px] font-bold">${escapeGameHTML(q.pos)}</span>` : ''}
                    <div class="text-3xl font-black text-slate-900 dark:text-white tracking-tight">${escapeGameHTML(q.word)}</div>
                    ${feedback && feedback.message ? `<div class="text-xs font-extrabold pt-1 ${feedback.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${escapeGameHTML(feedback.message)}</div>` : ''}
                </div>

                <div class="grid grid-cols-1 gap-2">
                    ${q.optionItems.map((optItem, idx) => {
                        const style = getOptionButtonStyle(idx, feedback, 'brand');
                        return `
                            <button type="button" ${style.disabledAttr}
                                onclick="GameEngine.answerArcadeOption(${idx}, '${safeQid}')"
                                class="${style.btnClass}">
                                <span class="${style.badgeClass}">${style.badgeHtml}</span>
                                <span class="flex-1">${escapeGameHTML(optItem.meaning)}</span>
                            </button>
                        `;
                    }).join('')}
                </div>

                ${showWrongNext ? `
                    <div class="pt-1 flex justify-end">
                        <button type="button" id="arcadeNextQuestionBtn" onclick="GameEngine.advanceArcadeNext()"
                            class="min-h-[44px] w-full sm:w-auto px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs sm:text-sm font-extrabold shadow-sm transition inline-flex items-center justify-center gap-2 cursor-pointer">
                            <span id="arcadeNextQuestionBtnLabel">${arcadeState.timeLeft <= 0 ? '時間到・查看結算' : '下一題'}</span>
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function answerArcadeOption(idx, expectedQuestionUid = null) {
        if (isBattleAnsweringLock) return false;
        if (!arcadeState || arcadeState.locked || activeArenaMode !== 'arcade') return false;
        const q = arcadeState.currentQ;
        if (!q || !Array.isArray(q.optionItems)) return false;
        if (expectedQuestionUid && q.questionUid !== expectedQuestionUid) return false;

        const optionIdx = Number(idx);
        if (!Number.isInteger(optionIdx) || optionIdx < 0 || optionIdx >= q.optionItems.length) return false;

        // 立即上鎖，在揭示結果或手動確認前絕不置換題目快照
        isBattleAnsweringLock = true;
        arcadeState.locked = true;
        const sessionSnap = arcadeState.sessionToken;
        const qidSnap = q.questionUid;

        arcadeState.totalCount += 1;
        if (!arcadeState.reviewedWords.includes(q.word)) {
            arcadeState.reviewedWords.push(q.word);
        }

        const selectedOpt = q.optionItems[optionIdx];
        const isCorrect = Boolean(
            selectedOpt && (
                (q.targetId && selectedOpt.cardId === q.targetId) ||
                (normalizeMeaning(selectedOpt.meaning) === normalizeMeaning(q.correctMeaning))
            )
        );

        let msg = '';
        if (isCorrect) {
            arcadeState.waitingWrongAck = false;
            arcadeState.correctCount += 1;
            arcadeState.combo += 1;
            if (arcadeState.combo > arcadeState.maxCombo) arcadeState.maxCombo = arcadeState.combo;

            const mult = arcadeState.combo >= 10 ? 2 : (arcadeState.combo >= 5 ? 1.5 : 1);
            const pts = Math.round(100 * mult);
            arcadeState.score += pts;

            let timeBonus = '';
            if (arcadeState.combo % 5 === 0) {
                arcadeState.timeLeft = Math.min(99, arcadeState.timeLeft + 2);
                timeBonus = ' +2秒！';
                playMilestoneSfx(arcadeState.combo);
            } else {
                playComboSfx(arcadeState.combo);
            }
            msg = `✅ +${pts} 分${timeBonus}`;
        } else {
            arcadeState.waitingWrongAck = true;
            arcadeState.combo = 0;
            playMissSfx();
            msg = `❌ 正解：${q.correctMeaning}`;
        }

        renderArcadeView({
            selectedIdx: optionIdx,
            correctIdx: q.correctIndex,
            isCorrect,
            message: msg
        });

        clearPendingBattleTimer();
        if (isCorrect) {
            pendingBattleTimer = setTimeout(() => {
                pendingBattleTimer = null;
                if (activeArenaMode !== 'arcade' || !arcadeState || arcadeState.sessionToken !== sessionSnap) return;
                if (!arcadeState.currentQ || arcadeState.currentQ.questionUid !== qidSnap) return;

                if (arcadeState.timeLeft <= 0) {
                    isBattleAnsweringLock = false;
                    finishArcadeMode();
                } else {
                    nextArcadeQuestion();
                }
            }, 280);
        }

        return true;
    }

    function finishArcadeMode() {
        clearPendingBattleTimer();
        isBattleAnsweringLock = false;
        if (arcadeTimerHandle) {
            clearInterval(arcadeTimerHandle);
            arcadeTimerHandle = null;
        }
        if (!arcadeState) return;

        const finalScore = arcadeState.score;
        const correct = arcadeState.correctCount;
        const total = arcadeState.totalCount;
        const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
        const maxCombo = arcadeState.maxCombo;
        const bestScore = setArcadeBestScore(finalScore);
        const isNewRecord = finalScore > 0 && finalScore >= bestScore;

        const rewardXp = Math.max(10, Math.round(finalScore / 20));
        awardProgression({ xp: rewardXp });
        playMilestoneSfx(10);
        renderHomePortal();

        lastArcadeReportPayload = {
            modeTitle: '60s ARCADE BLITZ',
            outcomeText: isNewRecord ? 'NEW RECORD!' : 'TIME UP!',
            scoreLabel: `${finalScore} PTS`,
            accuracy: `${acc}% (${correct}/${total})`,
            maxCombo: `${maxCombo} COMBO`,
            words: arcadeState.reviewedWords.slice(0, 3)
        };

        const body = document.getElementById('gameArenaBody');
        if (body) {
            body.innerHTML = `
                <div class="text-center space-y-4 py-2">
                    <div class="text-4xl">${isNewRecord ? '🏆' : '⚡'}</div>
                    <div>
                        <h3 class="text-xl font-black text-slate-900 dark:text-white">${isNewRecord ? '締造新紀錄！' : '街機時間結束！'}</h3>
                        <p class="text-xs text-slate-400 mt-0.5">最佳紀錄：${bestScore} 分</p>
                    </div>
                    <div class="grid grid-cols-3 gap-2.5">
                        <div class="p-3 bg-amber-50 dark:bg-amber-950/40 rounded-xl border border-amber-200 dark:border-amber-800">
                            <div class="text-[10px] font-bold text-amber-600">總分</div>
                            <div class="text-base font-black text-slate-900 dark:text-white">${finalScore}</div>
                        </div>
                        <div class="p-3 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800">
                            <div class="text-[10px] font-bold text-emerald-600">準確率</div>
                            <div class="text-base font-black text-slate-900 dark:text-white">${acc}%</div>
                        </div>
                        <div class="p-3 bg-brand-50 dark:bg-brand-950/40 rounded-xl border border-brand-200 dark:border-brand-800">
                            <div class="text-[10px] font-bold text-brand-600">最高連擊</div>
                            <div class="text-base font-black text-slate-900 dark:text-white">${maxCombo}</div>
                        </div>
                    </div>
                    <div class="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                        獲得獎勵：+${rewardXp} XP
                    </div>
                    <div id="arcadeReportPreviewBox"></div>
                    <div class="grid grid-cols-2 gap-2 pt-1">
                        <button type="button" onclick="GameEngine.renderLastArcadeReport()" class="py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-xl cursor-pointer">
                            <i class="fa-solid fa-image mr-1"></i>生成戰績圖卡
                        </button>
                        <button type="button" onclick="GameEngine.startArcadeMode()" class="py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl cursor-pointer">
                            <i class="fa-solid fa-rotate-right mr-1"></i>再戰一局
                        </button>
                    </div>
                    <button type="button" onclick="GameEngine.closeArenaModal()" class="w-full py-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">
                        返回
                    </button>
                </div>
            `;
        }
        arcadeState = null;
    }

    /* ==========================================================================
       👹 深淵魔王懸賞系統 (Lapses >= 3) — BossBattleState + DOM 事實單一來源重構
       ========================================================================== */

    function buildBossSnapshot(targetWordObj, distractorPool) {
        const cleanWord = String(targetWordObj?.word || '').trim();
        const cleanMeaning = String(targetWordObj?.meaning || '').trim();
        const cardId = targetWordObj?.id ? String(targetWordObj.id) : `word_${cleanWord.toLowerCase()}`;
        const correctNorm = normalizeMeaning(cleanMeaning);
        const targetLang = getBattleTargetLang();

        const usedNorms = new Set([correctNorm]);
        const usedTokens = new Set(extractMeaningTokens(cleanMeaning));
        const usedWords = new Set([cleanWord.toLowerCase()]);

        const distractorOptions = [];
        const tryAddDistractor = (item) => {
            if (!item || !item.word || !isValidBattleMeaning(item.meaning)) return false;
            const candWord = String(item.word).trim();
            const candWordKey = candWord.toLowerCase();
            if (usedWords.has(candWordKey)) return false;
            if (!isCardValidForBattleLang(item, targetLang)) return false;

            const candMeaning = String(item.meaning).trim();
            const candNorm = normalizeMeaning(candMeaning);
            if (!candNorm || usedNorms.has(candNorm)) return false;

            const candTokens = extractMeaningTokens(candMeaning);
            if (candTokens.some(tok => usedTokens.has(tok))) return false;

            usedWords.add(candWordKey);
            usedNorms.add(candNorm);
            candTokens.forEach(tok => usedTokens.add(tok));
            distractorOptions.push({ text: candMeaning, isCorrect: false });
            return true;
        };

        const shuffledPool = shuffleFisherYates(Array.isArray(distractorPool) ? distractorPool : []);
        for (const item of shuffledPool) {
            tryAddDistractor(item);
            if (distractorOptions.length >= 3) break;
        }

        if (distractorOptions.length < 3) {
            const fallbackBank = targetLang === 'ja' ? FALLBACK_JA_ARCADE_WORDS : FALLBACK_ARCADE_WORDS;
            for (const fb of shuffleFisherYates(fallbackBank)) {
                tryAddDistractor(fb);
                if (distractorOptions.length >= 3) break;
            }
        }

        // 先洗牌完成後再凍結快照與渲染 DOM（絕不後置調整索引）
        const rawOptions = [
            { text: cleanMeaning, isCorrect: true },
            ...distractorOptions
        ];
        const shuffledOptions = shuffleFisherYates(rawOptions).map(opt => Object.freeze({
            text: opt.text,
            isCorrect: Boolean(opt.isCorrect)
        }));

        const qid = `bossq_${++battleQuestionSeq}_${Date.now()}`;
        return Object.freeze({
            qid,
            cardId,
            word: cleanWord,
            pos: String(targetWordObj?.pos || '').trim(),
            lapses: Number(targetWordObj?.lapses) || 0,
            correctMeaning: cleanMeaning,
            correctNorm,
            options: Object.freeze(shuffledOptions)
        });
    }

    function ensureBossDelegatedListener(body) {
        if (!body || body.dataset.bossDelegatedBound === '1') return;
        body.dataset.bossDelegatedBound = '1';
        body.addEventListener('click', (event) => {
            if (activeArenaMode !== 'boss') return;
            const btn = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('#bossOptionsContainer button[data-qid]')
                : null;
            if (!btn) return;
            answerBossFromDom(btn);
        });
    }

    function startAbyssBossMode() {
        const abyssWords = getAbyssBossWords();
        if (abyssWords.length === 0) {
            if (typeof global.showToast === 'function') {
                global.showToast('🎉 目前語言沒有遺忘次數 >= 3 次且具完整釋義的深淵單字！你的記憶非常穩固！', 'success');
            }
            return false;
        }

        closeArenaModal();
        const distractors = buildQuestionPool(false);
        const targetCount = Math.min(8, Math.max(3, abyssWords.length));
        const bossMaxHp = targetCount * 100;

        battleSessionToken += 1;
        const mySession = battleSessionToken;
        isBattleAnsweringLock = false;
        activeArenaMode = 'boss';

        resetBossBattleState();
        BossBattleState.sessionToken = mySession;
        BossBattleState.bossMaxHp = bossMaxHp;
        BossBattleState.bossHp = bossMaxHp;
        BossBattleState.playerHearts = 3;
        BossBattleState.combo = 0;
        BossBattleState.maxCombo = 0;
        BossBattleState.slainCount = 0;
        BossBattleState.pool = abyssWords;
        BossBattleState.distractors = distractors;
        BossBattleState.reviewedWords = [];
        BossBattleState.currentSnapshot = null;
        BossBattleState.isLocked = false;

        nextBossQuestion();
        if (typeof global.openModal === 'function') global.openModal('gameArenaModal');
        return true;
    }

    function nextBossQuestion() {
        if (activeArenaMode !== 'boss' || !BossBattleState.pool.length) return;
        const pool = BossBattleState.pool;
        let pick = pool[Math.floor(Math.random() * pool.length)];
        if (pool.length > 1 && BossBattleState.currentSnapshot && pick.word === BossBattleState.currentSnapshot.word) {
            const altIdx = (pool.indexOf(pick) + 1) % pool.length;
            pick = pool[altIdx];
        }
        BossBattleState.currentSnapshot = buildBossSnapshot(pick, BossBattleState.distractors);
        BossBattleState.isLocked = false;
        BossBattleState.waitingWrongAck = false;
        isBattleAnsweringLock = false;
        renderBossView();
    }

    function advanceBossNext() {
        if (activeArenaMode !== 'boss' || !BossBattleState.waitingWrongAck) return false;
        BossBattleState.waitingWrongAck = false;
        BossBattleState.isLocked = false;
        isBattleAnsweringLock = false;
        if (BossBattleState.bossHp <= 0 || BossBattleState.playerHearts <= 0) {
            finishBossMode(BossBattleState.bossHp <= 0);
        } else {
            nextBossQuestion();
        }
        return true;
    }

    function renderBossView() {
        const body = document.getElementById('gameArenaBody');
        const snapshot = BossBattleState.currentSnapshot;
        if (!body || !snapshot) return;

        ensureBossDelegatedListener(body);

        const hpPct = BossBattleState.bossMaxHp > 0
            ? Math.max(0, Math.round((BossBattleState.bossHp / BossBattleState.bossMaxHp) * 100))
            : 0;
        const heartsStr = '❤️'.repeat(Math.max(0, BossBattleState.playerHearts)) + '🖤'.repeat(Math.max(0, 3 - BossBattleState.playerHearts));
        const safeQid = escapeGameHTML(snapshot.qid);

        body.innerHTML = `
            <div class="space-y-4">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-3">
                    <div class="flex items-center gap-2">
                        <span class="px-2.5 py-1 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 text-xs font-black">👹 深淵魔王討伐</span>
                        <span id="bossHeartsDisplay" class="text-xs font-bold">${heartsStr}</span>
                    </div>
                    <button type="button" onclick="GameEngine.closeArenaModal()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <!-- 魔王血條 -->
                <div class="p-3.5 bg-rose-950/90 text-white rounded-2xl border border-rose-700 space-y-2">
                    <div class="flex items-center justify-between text-xs font-extrabold">
                        <span>💀 遺忘深淵領主 (Lapses ${snapshot.lapses})</span>
                        <span id="bossHpValue" class="font-mono text-rose-300">${BossBattleState.bossHp} / ${BossBattleState.bossMaxHp} HP</span>
                    </div>
                    <div class="w-full h-3 bg-rose-900 rounded-full overflow-hidden">
                        <div id="bossHpBar" class="h-full bg-gradient-to-r from-rose-500 to-amber-400 transition-all duration-200" style="width:${hpPct}%"></div>
                    </div>
                </div>

                <!-- 題目展示區與明確正解提示區 -->
                <div class="p-5 bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 text-center space-y-1.5">
                    ${snapshot.pos ? `<span class="inline-block px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300 text-[10px] font-bold">${escapeGameHTML(snapshot.pos)}</span>` : ''}
                    <div id="bossQuestionWord" class="text-3xl font-black text-slate-900 dark:text-white">${escapeGameHTML(snapshot.word)}</div>
                    <div id="bossAnswerHint" class="hidden text-xs font-extrabold pt-1"></div>
                </div>

                <!-- 4 選 1 DOM 屬性單一來源選項容器 -->
                <div id="bossOptionsContainer" class="grid grid-cols-1 gap-2" data-qid="${safeQid}">
                    ${snapshot.options.map((opt, idx) => `
                        <button type="button"
                            data-qid="${safeQid}"
                            data-is-correct="${opt.isCorrect ? 'true' : 'false'}"
                            data-option-text="${escapeGameHTML(opt.text)}"
                            data-boss-idx="${idx}"
                            class="w-full p-3.5 rounded-xl bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-slate-700 hover:border-rose-400 border border-slate-200 dark:border-slate-700 text-left text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 transition flex items-center gap-2.5 cursor-pointer">
                            <span data-boss-badge class="w-6 h-6 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 text-xs font-black flex items-center justify-center shrink-0">${idx + 1}</span>
                            <span class="flex-1">${escapeGameHTML(opt.text)}</span>
                        </button>
                    `).join('')}
                </div>

                <div id="bossNextBtnContainer" class="hidden pt-1 flex justify-end"></div>
            </div>
        `;
    }

    function applyBossButtonHighlight(btn, state) {
        if (!btn) return;
        btn.classList.remove(
            'bg-white', 'dark:bg-slate-900', 'hover:bg-rose-50', 'dark:hover:bg-slate-700',
            'hover:border-rose-400', 'border-slate-200', 'dark:border-slate-700',
            'text-slate-800', 'dark:text-slate-100', 'opacity-60'
        );
        const badge = btn.querySelector('[data-boss-badge]');
        if (state === 'correct') {
            btn.classList.add('bg-emerald-500', 'text-white', 'border-2', 'border-emerald-500', 'ring-2', 'ring-emerald-400/50', 'font-extrabold');
            if (badge) {
                badge.className = 'w-6 h-6 rounded-lg bg-white/20 text-white text-xs font-black flex items-center justify-center shrink-0';
                badge.textContent = '✓';
            }
        } else if (state === 'wrong') {
            btn.classList.add('bg-rose-500', 'text-white', 'border-2', 'border-rose-500', 'ring-2', 'ring-rose-400/50', 'font-extrabold');
            if (badge) {
                badge.className = 'w-6 h-6 rounded-lg bg-white/20 text-white text-xs font-black flex items-center justify-center shrink-0';
                badge.textContent = '✕';
            }
        } else {
            btn.classList.add('bg-white', 'dark:bg-slate-900', 'border-slate-200', 'dark:border-slate-700', 'text-slate-400', 'dark:text-slate-500', 'opacity-60');
        }
    }

    function answerBossFromDom(btn) {
        if (!btn) return false;
        if (BossBattleState.isLocked || isBattleAnsweringLock) return false;
        if (activeArenaMode !== 'boss') return false;

        const snapshot = BossBattleState.currentSnapshot;
        if (!snapshot) return false;
        if (btn.dataset.qid !== snapshot.qid) return false;

        BossBattleState.isLocked = true;
        isBattleAnsweringLock = true;

        const sessionSnap = BossBattleState.sessionToken;
        const qidSnap = snapshot.qid;

        if (!BossBattleState.reviewedWords.includes(snapshot.word)) {
            BossBattleState.reviewedWords.push(snapshot.word);
        }

        // 嚴格以按鈕自身 DOM 屬性判定正誤
        const optionTextAttr = btn.dataset.optionText || '';
        const isCorrect = (btn.dataset.isCorrect === 'true') ||
            (normalizeMeaning(optionTextAttr) === snapshot.correctNorm);

        const container = document.getElementById('bossOptionsContainer');
        const allBtns = container ? Array.from(container.querySelectorAll('button[data-qid]')) : [btn];

        allBtns.forEach(b => {
            b.disabled = true;
            b.classList.add('pointer-events-none');
        });

        const hintEl = document.getElementById('bossAnswerHint');
        const hpValueEl = document.getElementById('bossHpValue');
        const hpBarEl = document.getElementById('bossHpBar');
        const heartsEl = document.getElementById('bossHeartsDisplay');

        if (isCorrect) {
            BossBattleState.combo += 1;
            BossBattleState.slainCount += 1;
            if (BossBattleState.combo > BossBattleState.maxCombo) {
                BossBattleState.maxCombo = BossBattleState.combo;
            }
            const dmg = 100 + (BossBattleState.combo >= 3 ? 50 : 0);
            BossBattleState.bossHp = Math.max(0, BossBattleState.bossHp - dmg);
            playComboSfx(BossBattleState.combo + 2);

            allBtns.forEach(b => {
                if (b === btn) applyBossButtonHighlight(b, 'correct');
                else applyBossButtonHighlight(b, 'dim');
            });

            if (hpValueEl) hpValueEl.textContent = `${BossBattleState.bossHp} / ${BossBattleState.bossMaxHp} HP`;
            if (hpBarEl && BossBattleState.bossMaxHp > 0) {
                const hpPct = Math.max(0, Math.round((BossBattleState.bossHp / BossBattleState.bossMaxHp) * 100));
                hpBarEl.style.width = `${hpPct}%`;
            }
            if (hintEl) {
                hintEl.className = 'text-xs font-extrabold pt-1 text-emerald-600 dark:text-emerald-400';
                hintEl.textContent = `⚔️ 造成 ${dmg} 點斬擊傷害！`;
            }
        } else {
            BossBattleState.combo = 0;
            BossBattleState.playerHearts = Math.max(0, BossBattleState.playerHearts - 1);
            playMissSfx();

            // 遍歷 4 顆 DOM 按鈕找出真正 data-is-correct="true" 的按鈕標綠，點錯按鈕標紅
            allBtns.forEach(b => {
                if (b.dataset.isCorrect === 'true') {
                    applyBossButtonHighlight(b, 'correct');
                } else if (b === btn) {
                    applyBossButtonHighlight(b, 'wrong');
                } else {
                    applyBossButtonHighlight(b, 'dim');
                }
            });

            if (heartsEl) {
                heartsEl.textContent = '❤️'.repeat(Math.max(0, BossBattleState.playerHearts)) + '🖤'.repeat(Math.max(0, 3 - BossBattleState.playerHearts));
            }
            if (hintEl) {
                hintEl.className = 'text-xs font-extrabold pt-1 text-rose-600 dark:text-rose-400';
                hintEl.textContent = `💥 遭反擊 -1 ❤️！正確答案為：${snapshot.correctMeaning}`;
            }
        }

        clearPendingBattleTimer();
        if (isCorrect) {
            BossBattleState.waitingWrongAck = false;
            pendingBattleTimer = setTimeout(() => {
                pendingBattleTimer = null;
                if (activeArenaMode !== 'boss' || BossBattleState.sessionToken !== sessionSnap) return;
                if (!BossBattleState.currentSnapshot || BossBattleState.currentSnapshot.qid !== qidSnap) return;

                if (BossBattleState.bossHp <= 0 || BossBattleState.playerHearts <= 0) {
                    BossBattleState.isLocked = false;
                    isBattleAnsweringLock = false;
                    finishBossMode(BossBattleState.bossHp <= 0);
                } else {
                    nextBossQuestion();
                }
            }, 350);
        } else {
            BossBattleState.waitingWrongAck = true;
            const nextBtnContainer = document.getElementById('bossNextBtnContainer');
            if (nextBtnContainer) {
                nextBtnContainer.classList.remove('hidden');
                nextBtnContainer.innerHTML = `
                    <button type="button" id="bossNextQuestionBtn" onclick="GameEngine.advanceBossNext()"
                        class="min-h-[44px] w-full sm:w-auto px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-extrabold shadow-sm transition inline-flex items-center justify-center gap-2 cursor-pointer">
                        <span>${BossBattleState.playerHearts <= 0 ? '查看討伐結果' : '下一題'}</span>
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                `;
            }
        }

        return true;
    }

    function answerBossOption(idx, expectedQuestionUid = null) {
        if (BossBattleState.isLocked || isBattleAnsweringLock || activeArenaMode !== 'boss') return false;
        const snapshot = BossBattleState.currentSnapshot;
        if (!snapshot) return false;
        if (expectedQuestionUid && snapshot.qid !== expectedQuestionUid) return false;

        const container = document.getElementById('bossOptionsContainer');
        if (!container) return false;
        const targetBtn = container.querySelector(`button[data-boss-idx="${Number(idx)}"]`);
        if (!targetBtn) return false;
        return answerBossFromDom(targetBtn);
    }

    function finishBossMode(victory) {
        clearPendingBattleTimer();
        isBattleAnsweringLock = false;
        if (!BossBattleState.sessionToken && activeArenaMode !== 'boss') return;
        const rewardXp = victory ? 120 : 25;
        awardProgression({ xp: rewardXp, unlockTitle: victory ? 'abyss_slayer' : '' });
        if (victory) playMilestoneSfx(20);
        renderHomePortal();

        const body = document.getElementById('gameArenaBody');
        if (body) {
            body.innerHTML = `
                <div class="text-center space-y-4 py-3">
                    <div class="text-4xl">${victory ? '⚔️👑' : '💀'}</div>
                    <div>
                        <h3 class="text-xl font-black text-slate-900 dark:text-white">${victory ? '成功討伐深淵魔王！' : '討伐失敗，整裝再戰！'}</h3>
                        <p class="text-xs text-slate-400 mt-1">${victory ? '你的弱點單字已被徹底壓制！' : '別氣餒，建議先回卡片模式熟悉這些易忘字！'}</p>
                    </div>
                    <div class="text-xs font-extrabold ${victory ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'}">
                        戰利品：+${rewardXp} XP ${victory ? '｜解鎖稱號「⚔️ 深淵征服者」' : ''}
                    </div>
                    <div class="flex gap-2">
                        <button type="button" onclick="GameEngine.startAbyssBossMode()" class="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl cursor-pointer">再次討伐</button>
                        <button type="button" onclick="GameEngine.closeArenaModal()" class="flex-1 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl cursor-pointer">關閉</button>
                    </div>
                </div>
            `;
        }
        resetBossBattleState();
    }

    /* ==========================================================================
       🎨 HTML5 Canvas 4:5 IG 戰績圖卡生成器
       ========================================================================== */

    function generateBattleReportDataUrl(report = {}) {
        if (typeof document === 'undefined') return '';
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 900; // 4:5 IG 直式比例
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';

        const u = global.userData || {};
        const playerName = u.nickname || u.username || 'LZHCard 冒險者';
        const rankTier = u.progression?.rankTier || '青銅 III';
        const level = u.progression?.level || 1;

        // 背景漸層
        const grad = ctx.createLinearGradient(0, 0, 720, 900);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.55, '#1e1b4b');
        grad.addColorStop(1, '#312e81');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 720, 900);

        // 裝飾光暈
        ctx.fillStyle = 'rgba(99, 102, 241, 0.22)';
        ctx.beginPath();
        ctx.arc(580, 140, 220, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
        ctx.beginPath();
        ctx.arc(130, 780, 190, 0, Math.PI * 2);
        ctx.fill();

        // 標頭 Logo 文字
        ctx.fillStyle = '#a5b4fc';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('LZHCARD ARENA REPORT', 54, 78);

        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(String(report.modeTitle || 'BATTLE SUMMARY'), 54, 126);

        // 主勝負大字
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 58px sans-serif';
        ctx.fillText(String(report.outcomeText || 'VICTORY!'), 54, 212);

        // 玩家資訊卡
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.fillRect(54, 255, 612, 112);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 2;
        ctx.strokeRect(54, 255, 612, 112);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 30px sans-serif';
        ctx.fillText(playerName, 82, 304);
        const resolvedMem = (global.MembershipEngine && typeof global.MembershipEngine.resolveActiveMembership === 'function')
            ? global.MembershipEngine.resolveActiveMembership(u.membership, Date.now())
            : null;
        const memTag = (resolvedMem && resolvedMem.isSupporter && resolvedMem.meta)
            ? ` · ${resolvedMem.meta.icon} ${resolvedMem.meta.shortBadge}`
            : '';
        ctx.fillStyle = (resolvedMem && resolvedMem.isSupporter) ? '#fbbf24' : '#cbd5e1';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(`Lv.${level} · ${rankTier}${memTag}`, 82, 344);

        // 三項數據方塊
        const stats = [
            { label: 'SCORE', val: report.scoreLabel || '0 PTS', color: '#fbbf24' },
            { label: 'ACCURACY', val: report.accuracy || '100%', color: '#34d399' },
            { label: 'COMBO', val: report.maxCombo || '0', color: '#60a5fa' }
        ];
        stats.forEach((st, i) => {
            const y = 408 + i * 112;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
            ctx.fillRect(54, y, 612, 92);
            ctx.fillStyle = '#94a3b8';
            ctx.font = 'bold 20px sans-serif';
            ctx.fillText(st.label, 82, y + 36);
            ctx.fillStyle = st.color;
            ctx.font = '900 32px sans-serif';
            ctx.fillText(String(st.val), 82, y + 74);
        });

        // 精選單字
        const words = Array.isArray(report.words) ? report.words.filter(Boolean).slice(0, 3) : [];
        if (words.length > 0) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = 'bold 20px sans-serif';
            ctx.fillText(`FEATURED WORDS: ${words.join(' · ')}`, 54, 792);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '20px sans-serif';
        ctx.fillText(`Generated on ${getTodayDateStr()} · LZHCard`, 54, 852);

        try {
            return canvas.toDataURL('image/png');
        } catch (e) {
            return '';
        }
    }

    function showBattleReportInContainer(containerOrId, report = {}) {
        const container = typeof containerOrId === 'string'
            ? document.getElementById(containerOrId)
            : containerOrId;
        if (!container) return '';
        const dataUrl = generateBattleReportDataUrl(report);
        if (!dataUrl) {
            if (typeof global.showToast === 'function') global.showToast('目前裝置無法繪製戰績圖卡', 'warning');
            return '';
        }

        container.innerHTML = `
            <div class="mt-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 space-y-2.5 text-center">
                <img src="${dataUrl}" alt="Battle Report" class="w-48 mx-auto rounded-xl shadow-md border border-slate-200 dark:border-slate-700">
                <a href="${dataUrl}" download="lzhcard_report_${getTodayDateStr()}.png" class="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-xl shadow-xs">
                    <i class="fa-solid fa-download"></i>
                    <span>下載 IG 戰績圖卡 (.png)</span>
                </a>
            </div>
        `;
        return dataUrl;
    }

    function closeArenaModal() {
        battleSessionToken += 1;
        clearPendingBattleTimer();
        isBattleAnsweringLock = false;
        if (arcadeTimerHandle) {
            clearInterval(arcadeTimerHandle);
            arcadeTimerHandle = null;
        }
        activeArenaMode = null;
        arcadeState = null;
        resetBossBattleState();
        if (typeof global.closeModal === 'function') global.closeModal('gameArenaModal');
    }

    // 街機與魔王模式鍵盤 1~4 快速鍵支持（魔王模式直接透過 DOM 按鈕判題）
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', (e) => {
            if (isBattleAnsweringLock || BossBattleState.isLocked) return;
            if (activeArenaMode === 'arcade' && arcadeState && !arcadeState.locked && arcadeState.currentQ) {
                const idx = ['1', '2', '3', '4'].indexOf(e.key);
                if (idx !== -1) answerArcadeOption(idx, arcadeState.currentQ.questionUid);
            } else if (activeArenaMode === 'boss' && BossBattleState.currentSnapshot) {
                const idx = ['1', '2', '3', '4'].indexOf(e.key);
                if (idx !== -1) answerBossOption(idx, BossBattleState.currentSnapshot.qid);
            }
        });
    }

    const GameEngine = {
        DAILY_CHEST_GOAL,
        STREAK_SHIELD_COST,
        STREAK_SHIELD_MAX,
        BossBattleState,
        playComboSfx,
        playMissSfx,
        playMilestoneSfx,
        playChestSfx,
        isSfxMuted,
        toggleSfxMute,
        getDailyProgress,
        getArcadeBestScore,
        awardProgression,
        buyStreakShield,
        onCardRated,
        rollbackLastReward,
        getAbyssBossWords,
        renderFlashcardHud,
        renderHomePortal,
        openDailyChest,
        startArcadeMode,
        answerArcadeOption,
        advanceArcadeNext,
        finishArcadeMode,
        startAbyssBossMode,
        buildBossSnapshot,
        answerBossFromDom,
        answerBossOption,
        advanceBossNext,
        finishBossMode,
        createMcqQuestion,
        buildQuestionPool,
        shuffleFisherYates,
        normalizeMeaning,
        isValidBattleMeaning,
        isBattleLocked: () => isBattleAnsweringLock || BossBattleState.isLocked,
        generateBattleReportDataUrl,
        showBattleReportInContainer,
        renderLastArcadeReport: () => showBattleReportInContainer('arcadeReportPreviewBox', lastArcadeReportPayload || {}),
        closeArenaModal,
        getSessionState: () => ({
            combo: sessionCombo,
            maxCombo: sessionMaxCombo,
            xpGained: sessionXpGained,
            isFever: sessionCombo >= 10
        })
    };

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            renderHomePortal();
            if (typeof global.StartupDeepLinkQueue !== 'undefined' && typeof global.StartupDeepLinkQueue.processWhenReady === 'function') {
                if (typeof firebase === 'undefined' || global.__authInitialLoadDone === true) {
                    global.StartupDeepLinkQueue.processWhenReady();
                }
            } else if (typeof global.MultiplayerEngine !== 'undefined' && typeof global.MultiplayerEngine.checkUrlDuelInvite === 'function') {
                global.MultiplayerEngine.checkUrlDuelInvite();
            }
        });
    }

    global.GameEngine = GameEngine;
})(typeof window !== 'undefined' ? window : globalThis);
