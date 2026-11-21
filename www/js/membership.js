/**
 * LZHCard - 商業化分級方案、Google Play 內購驗證、2:8 金幣儲值、管理員特權與雙軌 BYOK 系統
 * 檔案：www/js/membership.js
 */
(function (global) {
    'use strict';

    const MEMBERSHIP_CYCLE_DAYS = 30;
    const MEMBERSHIP_CYCLE_MS = MEMBERSHIP_CYCLE_DAYS * 24 * 60 * 60 * 1000;
    const ANNUAL_CYCLE_DAYS = 365;
    const ANNUAL_CYCLE_MS = ANNUAL_CYCLE_DAYS * 24 * 60 * 60 * 1000;
    const SHARED_WORKER_BASE = 'https://lzhcard.tomlin980415.workers.dev';
    const ANDROID_PACKAGE_NAME = 'com.lzhcard.app';

    const GROQ_KEY_STORAGE = 'lzhcard_groq_key_v1';
    const GEMINI_KEY_STORAGE = 'flashcard_gemini_key_v1';

    const MANDATORY_BYOK_NOTICE = '填寫自己的 Groq / Google API Key 可直接享有官方提供的免費額度、不受系統次數限制；若使用系統公用 Key，因伺服器需負擔運算成本，設有每日／每月額度限制且需付費會員解鎖，因此強烈推薦大家申請並填寫自己的免費 API Key！';
    const MANDATORY_DISCLOSURE_TEXT = 'LZHCard 核心單字卡、FSRS 記憶排程、內建題庫測驗、本地離線拍照取詞與即時字幕直譯皆永久免費；雲端高耗能 AI 運算依方案提供每日與每月安心額度，亦可隨時填入個人 Groq / Google API Key 免費無上限使用！';

    const AI_QUOTA_MATRIX = {
        free: {
            priority: 1,
            priorityLabelKey: 'memPriorityStd',
            priorityLabelFallback: '標準排隊',
            daily: { def_fill: 10, article_gen: 1, vision_ocr: 0, fast_refine: 0 },
            monthly: { def_fill: 120, article_gen: 10, vision_ocr: 0, fast_refine: 0 }
        },
        supporter_30: {
            priority: 2,
            priorityLabelKey: 'memPriorityFast',
            priorityLabelFallback: '優先通道',
            daily: { def_fill: 40, article_gen: 5, vision_ocr: 5, fast_refine: 60 },
            monthly: { def_fill: 600, article_gen: 80, vision_ocr: 80, fast_refine: 800 }
        },
        supporter_90: {
            priority: 3,
            priorityLabelKey: 'memPriorityHigh',
            priorityLabelFallback: '高速優先',
            daily: { def_fill: 120, article_gen: 12, vision_ocr: 20, fast_refine: 250 },
            monthly: { def_fill: 1800, article_gen: 180, vision_ocr: 300, fast_refine: 3000 }
        },
        supporter_180: {
            priority: 4,
            priorityLabelKey: 'memPriorityVip',
            priorityLabelFallback: 'VIP 極速通道',
            daily: { def_fill: 300, article_gen: 25, vision_ocr: 50, fast_refine: 600 },
            monthly: { def_fill: 4500, article_gen: 400, vision_ocr: 750, fast_refine: 8000 }
        }
    };

    // 🪙 2:8 黃金儲值方案（NT$ 1 = 4 金幣）
    const COIN_TOPUP_PACKAGES = [
        { sku: 'lzhcard_coins_120', priceNtd: 30, coins: 120, icon: '🪙', labelKey: 'topupPack120', labelFallback: '120 金幣入門包' },
        { sku: 'lzhcard_coins_360', priceNtd: 90, coins: 360, icon: '💰', labelKey: 'topupPack360', labelFallback: '360 金幣超值包', popular: true },
        { sku: 'lzhcard_coins_720', priceNtd: 180, coins: 720, icon: '💎', labelKey: 'topupPack720', labelFallback: '720 金幣豪華包' },
        { sku: 'lzhcard_coins_1200', priceNtd: 300, coins: 1200, icon: '👑', labelKey: 'topupPack1200', labelFallback: '1,200 金幣尊榮包' }
    ];

    const PLAY_MEMBERSHIP_SKUS = {
        supporter_30: { monthly: 'lzhcard_mem_starter_30d', annual: 'lzhcard_mem_starter_365d' },
        supporter_90: { monthly: 'lzhcard_mem_plus_30d', annual: 'lzhcard_mem_plus_365d' },
        supporter_180: { monthly: 'lzhcard_mem_pro_30d', annual: 'lzhcard_mem_pro_365d' }
    };

    const COIN_REDEEM_PACKS = [
        {
            id: 'redeem_starter_30d',
            icon: '☕',
            costCoins: 160,
            titleKey: 'coinPackStarter30dTitle',
            titleFallback: '30 天 Starter 入門會員',
            descKey: 'coinPackStarter30dDesc',
            descFallback: '以 160 金幣開通 30 天入門會員（雲端拍照 OCR、字幕精修與專屬外觀）',
            credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
            trialDays: 0,
            fullMembershipDays: 30,
            fullMembershipTier: 'supporter_30'
        },
        {
            id: 'redeem_plus_30d',
            icon: '💎',
            costCoins: 400,
            titleKey: 'coinPackPlus30dTitle',
            titleFallback: '30 天 Plus 進階會員',
            descKey: 'coinPackPlus30dDesc',
            descFallback: '以 400 金幣開通 30 天進階會員（高配額、高速優先與鑽石外觀）',
            credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
            trialDays: 0,
            fullMembershipDays: 30,
            fullMembershipTier: 'supporter_90'
        },
        {
            id: 'redeem_pro_30d',
            icon: '👑',
            costCoins: 800,
            titleKey: 'coinPackPro30dTitle',
            titleFallback: '30 天 Pro 專業會員',
            descKey: 'coinPackPro30dDesc',
            descFallback: '以 800 金幣開通 30 天專業會員（最高配額、VIP 極速與皇冠外觀）',
            credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
            trialDays: 0,
            fullMembershipDays: 30,
            fullMembershipTier: 'supporter_180'
        },
        {
            id: 'pack_ai_text',
            icon: '✨',
            costCoins: 60,
            titleKey: 'coinPackTextTitle',
            titleFallback: 'AI 單字填補 + 文章生成補充包',
            descKey: 'coinPackTextDesc',
            descFallback: '+15 次 AI 填補釋義例句、+3 篇 AI 長文出題（無使用期限）',
            credits: { def_fill: 15, article_gen: 3, vision_ocr: 0, fast_refine: 0 },
            trialDays: 0,
            fullMembershipDays: 0
        },
        {
            id: 'pack_ai_vision',
            icon: '📸',
            costCoins: 120,
            titleKey: 'coinPackVisionTitle',
            titleFallback: 'AI 拍照識別 + 字幕精修補充包',
            descKey: 'coinPackVisionDesc',
            descFallback: '+15 張雲端 AI 拍照翻譯、+150 句字幕語境精修（無使用期限）',
            credits: { def_fill: 0, article_gen: 0, vision_ocr: 15, fast_refine: 150 },
            trialDays: 0,
            fullMembershipDays: 0
        },
        {
            id: 'pack_trial_starter_7d',
            icon: '🎟️',
            costCoins: 80,
            titleKey: 'coinPackTrialTitle',
            titleFallback: '7 天 Starter 入門會員體驗卡',
            descKey: 'coinPackTrialDesc',
            descFallback: '立即體驗 7 天雲端拍照 OCR、語境字幕精修、高配額與暖陽金專屬外觀',
            credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
            trialDays: 7,
            fullMembershipDays: 0
        }
    ];

    const MEMBERSHIP_TIERS = {
        free: {
            id: 'free',
            priceNtd: 0,
            annualPriceNtd: 0,
            icon: '🌱',
            nameKey: 'memTierFreeName',
            name: '免費方案 (Free)',
            shortBadge: '',
            descKey: 'memTierFreeDesc',
            desc: '核心記憶卡、FSRS 排程、內建題庫、離線 OCR 與極速直譯永久免費；含每日輕量雲端 AI 額度。',
            badgeClass: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700',
            cardAccentClass: 'border-slate-200 dark:border-slate-700',
            frameId: 'default',
            bannerId: 'default',
            titleId: 'newcomer',
            perks: [
                'FSRS 記憶排程、單字本、聊天、對戰與商城永久免費',
                'AI 填補釋義例句：10 次/日（每月上限 120 次）',
                'AI 產生測驗文章：1 篇/日（每月上限 10 篇）',
                '拍照翻譯與即時字幕：自動使用免費離線 OCR / Tier-1 直譯',
                '填入個人 Groq / Gemini API Key 立即享有免費無上限'
            ]
        },
        supporter_30: {
            id: 'supporter_30',
            priceNtd: 39,
            annualPriceNtd: 390,
            icon: '☕',
            nameKey: 'memTierStarterName',
            name: '入門方案 (Starter)',
            shortBadge: 'Starter 入門',
            descKey: 'memTierStarterDesc',
            desc: '高 CP 值日常學習首選！解鎖雲端 AI 拍照 OCR 與語境字幕精修＋☕ 暖心贊助外觀。',
            badgeClass: 'bg-gradient-to-r from-amber-100 to-orange-100 text-amber-800 dark:from-amber-950/80 dark:to-orange-950/70 dark:text-amber-200 border-amber-300 dark:border-amber-700',
            cardAccentClass: 'border-amber-300 dark:border-amber-700',
            frameId: 'supporter_warm_amber',
            bannerId: 'supporter_warm_horizon',
            titleId: 'supporter_coffee',
            perks: [
                'AI 填補釋義例句：40 次/日（月上限 600 次）',
                'AI 產生測驗文章：5 篇/日（月上限 80 篇）',
                'AI 雲端拍照識別：5 張/日（月上限 80 張）',
                'AI 字幕語境精修：60 句/日（月上限 800 句）',
                '解鎖 ☕ 暖陽金環頭像框、琥珀晨光橫幅與徽章'
            ]
        },
        supporter_90: {
            id: 'supporter_90',
            priceNtd: 99,
            annualPriceNtd: 990,
            icon: '💎',
            nameKey: 'memTierPlusName',
            name: '進階方案 (Plus)',
            shortBadge: 'Plus 進階',
            isPopular: true,
            descKey: 'memTierPlusDesc',
            desc: '最多學習者選擇！充足拍照熱區辨識與雙語字幕額度＋高速優先通道＋💎 鑽石外觀。',
            badgeClass: 'bg-gradient-to-r from-sky-100 to-indigo-100 text-indigo-800 dark:from-sky-950/80 dark:to-indigo-950/80 dark:text-sky-200 border-sky-300 dark:border-indigo-600',
            cardAccentClass: 'border-sky-400 dark:border-sky-600',
            frameId: 'supporter_sapphire_aura',
            bannerId: 'supporter_aurora_palace',
            titleId: 'supporter_diamond',
            perks: [
                'AI 填補釋義例句：120 次/日（月上限 1,800 次）',
                'AI 產生測驗文章：12 篇/日（月上限 180 篇）',
                'AI 雲端拍照識別：20 張/日（月上限 300 張）',
                'AI 字幕語境精修：250 句/日（月上限 3,000 句）',
                '高速優先排隊＋解鎖 💎 蒼穹鑽石光環與極光殿堂橫幅'
            ]
        },
        supporter_180: {
            id: 'supporter_180',
            priceNtd: 199,
            annualPriceNtd: 1990,
            icon: '👑',
            nameKey: 'memTierProName',
            name: '專業方案 (Pro)',
            shortBadge: 'Pro 專業',
            descKey: 'memTierProDesc',
            desc: '重度考生與影音精聽專武！最高配額、VIP 極速通道與全階皇冠外觀 100% 解除封印。',
            badgeClass: 'bg-gradient-to-r from-amber-200 via-rose-100 to-purple-100 text-purple-900 dark:from-amber-900/70 dark:via-rose-950/70 dark:to-purple-950/80 dark:text-amber-200 border-amber-400 dark:border-amber-500',
            cardAccentClass: 'border-purple-400 dark:border-purple-500',
            frameId: 'supporter_celestial_crown',
            bannerId: 'supporter_imperial_aurora',
            titleId: 'supporter_crown',
            perks: [
                'AI 填補釋義例句：300 次/日（月上限 4,500 次）',
                'AI 產生測驗文章：25 篇/日（月上限 400 篇）',
                'AI 雲端拍照識別：50 張/日（月上限 750 張）',
                'AI 字幕語境精修：600 句/日（月上限 8,000 句）',
                'VIP 極速通道＋解鎖 👑 星曜皇冠與皇家極光宮殿橫幅'
            ]
        }
    };

    const TIER_ORDER = ['free', 'supporter_30', 'supporter_90', 'supporter_180'];
    const VALID_FEATURES = ['def_fill', 'article_gen', 'vision_ocr', 'fast_refine'];

    let billingCycle = 'monthly'; // 'monthly' | 'annual'
    let expiryMonitorTimer = null;
    let isPurchasing = false;

    function memTr(key, fallback, params = null) {
        let text = fallback;
        if (typeof global.t === 'function') {
            const res = global.t(key, params || {});
            if (res && res !== key) text = res;
        }
        if (params && typeof text === 'string') {
            Object.keys(params).forEach((k) => {
                text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
            });
        }
        return text;
    }

    function escapeMemHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function isAdminAccount(userObj = global.userData) {
        if (!userObj || typeof userObj !== 'object') return false;
        return userObj.role === 'admin' || userObj.isAdmin === true;
    }

    function getTaiwanDateKeys(nowMs = Date.now()) {
        const utc8 = new Date(nowMs + 8 * 60 * 60 * 1000);
        const y = utc8.getUTCFullYear();
        const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
        const d = String(utc8.getUTCDate()).padStart(2, '0');
        return {
            dailyDate: `${y}-${m}-${d}`,
            monthlyKey: `${y}-${m}`
        };
    }

    function formatYmdDate(ts) {
        if (!ts || !Number.isFinite(Number(ts))) return '';
        const utc8 = new Date(Number(ts) + 8 * 60 * 60 * 1000);
        const y = utc8.getUTCFullYear();
        const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
        const d = String(utc8.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatExpiryDate(ts) {
        if (!ts || !Number.isFinite(Number(ts))) return '';
        const d = new Date(Number(ts));
        return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function getTierMeta(tierId) {
        return MEMBERSHIP_TIERS[tierId] || MEMBERSHIP_TIERS.free;
    }

    function getTierQuotaConfig(tierId) {
        return AI_QUOTA_MATRIX[tierId] || AI_QUOTA_MATRIX.free;
    }

    function getCleanLocalStorageKey(storageName) {
        try {
            const raw = (localStorage.getItem(storageName) || '').trim();
            if (!raw || raw === 'undefined' || raw === 'null') return '';
            return raw;
        } catch (e) {
            return '';
        }
    }

    /**
     * 優先檢查本地端是否填有個人 Groq 或 Gemini Key（且未切換至雲端共用 API 模式）
     */
    function isPersonalByokActive() {
        try {
            if (localStorage.getItem('lzhcard_api_mode') === 'shared') return false;
        } catch (e) {}
        return Boolean(getCleanLocalStorageKey(GROQ_KEY_STORAGE) || getCleanLocalStorageKey(GEMINI_KEY_STORAGE));
    }

    function getPersonalKeysStatus() {
        const isShared = (() => {
            try { return localStorage.getItem('lzhcard_api_mode') === 'shared'; } catch (e) { return false; }
        })();
        if (isShared) {
            return { hasGroq: false, hasGemini: false, active: false };
        }
        return {
            hasGroq: Boolean(getCleanLocalStorageKey(GROQ_KEY_STORAGE)),
            hasGemini: Boolean(getCleanLocalStorageKey(GEMINI_KEY_STORAGE)),
            active: isPersonalByokActive()
        };
    }

    /**
     * 解析目前會員、金幣體驗卡與管理員特權後的有效等級
     */
    function resolveActiveMembership(input = null, now = Date.now()) {
        if (input && typeof input === 'object' && isAdminAccount(input)) {
            return {
                tier: 'supporter_180',
                priceNtd: MEMBERSHIP_TIERS.supporter_180.priceNtd,
                isActive: true,
                isSupporter: true,
                isAdmin: true,
                expired: false,
                startedAt: 0,
                expiresAt: now + ANNUAL_CYCLE_MS,
                remainingDays: 999,
                isCoinTrial: false,
                meta: MEMBERSHIP_TIERS.supporter_180
            };
        }

        if (!input) {
            return {
                tier: 'free',
                priceNtd: 0,
                isActive: false,
                isSupporter: false,
                isAdmin: false,
                expired: false,
                startedAt: 0,
                expiresAt: 0,
                remainingDays: 0,
                isCoinTrial: false,
                meta: MEMBERSHIP_TIERS.free
            };
        }

        const isOuterUserObj = typeof input === 'object' && input.membership && typeof input.membership === 'object';
        const raw = isOuterUserObj
            ? input.membership
            : (typeof input === 'string' ? { tier: input, expiresAt: 0 } : input);

        const rawTier = String(raw.tier || raw.membershipTier || 'free').trim();
        let resolvedTier = MEMBERSHIP_TIERS[rawTier] ? rawTier : 'free';
        const expiresAt = Number(raw.expiresAt ?? raw.membershipExpiresAt) || 0;
        const startedAt = Number(raw.startedAt) || 0;
        let expired = false;

        if (resolvedTier !== 'free') {
            if (expiresAt > 0 && expiresAt <= now) {
                expired = true;
                resolvedTier = 'free';
            } else if (expiresAt <= 0 && startedAt > 0 && (startedAt + MEMBERSHIP_CYCLE_MS) <= now) {
                expired = true;
                resolvedTier = 'free';
            }
        }

        let isCoinTrial = false;
        let effectiveExpiresAt = expiresAt > 0 ? expiresAt : (startedAt > 0 ? startedAt + MEMBERSHIP_CYCLE_MS : 0);
        const boost = isOuterUserObj && input.coinBoost && typeof input.coinBoost === 'object' ? input.coinBoost : null;
        if (boost && boost.trialTier && MEMBERSHIP_TIERS[boost.trialTier] && Number(boost.trialExpiresAt) > now) {
            const baseIdx = TIER_ORDER.indexOf(resolvedTier);
            const trialIdx = TIER_ORDER.indexOf(boost.trialTier);
            if (trialIdx > baseIdx) {
                resolvedTier = boost.trialTier;
                isCoinTrial = true;
                effectiveExpiresAt = Number(boost.trialExpiresAt);
            }
        }

        if (resolvedTier === 'free') {
            return {
                tier: 'free',
                previousTier: expired ? rawTier : undefined,
                priceNtd: 0,
                isActive: false,
                isSupporter: false,
                isAdmin: false,
                expired,
                startedAt,
                expiresAt: expired ? (expiresAt || (startedAt + MEMBERSHIP_CYCLE_MS)) : 0,
                remainingDays: 0,
                isCoinTrial: false,
                meta: MEMBERSHIP_TIERS.free
            };
        }

        const tierMeta = MEMBERSHIP_TIERS[resolvedTier];
        const remainingMs = effectiveExpiresAt > 0 ? Math.max(0, effectiveExpiresAt - now) : MEMBERSHIP_CYCLE_MS;
        const remainingDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));

        return {
            tier: tierMeta.id,
            priceNtd: tierMeta.priceNtd,
            isActive: true,
            isSupporter: true,
            isAdmin: false,
            expired: false,
            startedAt,
            expiresAt: effectiveExpiresAt,
            remainingDays,
            isCoinTrial,
            meta: tierMeta
        };
    }

    function ensureMembershipDefaults(userDataObj = global.userData) {
        if (!userDataObj || typeof userDataObj !== 'object') return null;
        if (!userDataObj.membership || typeof userDataObj.membership !== 'object') {
            userDataObj.membership = {
                tier: 'free',
                tierPriceNtd: 0,
                startedAt: 0,
                expiresAt: 0,
                billingCycle: 'monthly',
                totalDonatedNtd: 0,
                autoDowngradedAt: 0
            };
        }
        const m = userDataObj.membership;
        if (!MEMBERSHIP_TIERS[m.tier]) m.tier = 'free';
        if (!Number.isFinite(Number(m.tierPriceNtd))) m.tierPriceNtd = MEMBERSHIP_TIERS[m.tier].priceNtd;
        if (!Number.isFinite(Number(m.startedAt))) m.startedAt = 0;
        if (!Number.isFinite(Number(m.expiresAt))) m.expiresAt = 0;
        if (!Number.isFinite(Number(m.totalDonatedNtd))) m.totalDonatedNtd = 0;
        if (!Number.isFinite(Number(m.autoDowngradedAt))) m.autoDowngradedAt = 0;
        if (!Array.isArray(userDataObj.membershipHistory)) {
            userDataObj.membershipHistory = [];
        }
        if (!Array.isArray(userDataObj.purchasedCosmetics)) {
            userDataObj.purchasedCosmetics = [];
        }

        const { dailyDate, monthlyKey } = getTaiwanDateKeys();
        if (!userDataObj.aiUsage || typeof userDataObj.aiUsage !== 'object') {
            userDataObj.aiUsage = {
                dailyDate,
                monthlyKey,
                daily: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 },
                monthly: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 }
            };
        }
        const usage = userDataObj.aiUsage;
        if (usage.dailyDate !== dailyDate) {
            usage.dailyDate = dailyDate;
            usage.daily = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        } else if (!usage.daily || typeof usage.daily !== 'object') {
            usage.daily = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        }
        if (usage.monthlyKey !== monthlyKey) {
            usage.monthlyKey = monthlyKey;
            usage.monthly = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        } else if (!usage.monthly || typeof usage.monthly !== 'object') {
            usage.monthly = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        }

        if (!userDataObj.coinBoost || typeof userDataObj.coinBoost !== 'object') {
            userDataObj.coinBoost = {
                trialTier: 'free',
                trialExpiresAt: 0,
                credits: { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 }
            };
        }
        if (!userDataObj.coinBoost.credits || typeof userDataObj.coinBoost.credits !== 'object') {
            userDataObj.coinBoost.credits = { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        }
        VALID_FEATURES.forEach((f) => {
            usage.daily[f] = Math.max(0, Number(usage.daily[f]) || 0);
            usage.monthly[f] = Math.max(0, Number(usage.monthly[f]) || 0);
            userDataObj.coinBoost.credits[f] = Math.max(0, Number(userDataObj.coinBoost.credits[f]) || 0);
        });
        return m;
    }

    function getQuotaSnapshot() {
        const u = global.userData || (global.userData = {});
        ensureMembershipDefaults(u);
        const now = Date.now();
        const admin = isAdminAccount(u);
        const status = resolveActiveMembership(u, now);
        const cfg = getTierQuotaConfig(status.tier);
        const usage = u.aiUsage;
        const credits = (u.coinBoost && u.coinBoost.credits) || { def_fill: 0, article_gen: 0, vision_ocr: 0, fast_refine: 0 };
        const byok = isPersonalByokActive();

        const remainingDaily = {};
        const remainingMonthly = {};
        VALID_FEATURES.forEach((f) => {
            const extra = Math.max(0, Number(credits[f]) || 0);
            if (byok || admin) {
                remainingDaily[f] = 999999;
                remainingMonthly[f] = 999999;
            } else {
                remainingDaily[f] = Math.max(0, (cfg.daily[f] || 0) - (usage.daily[f] || 0)) + extra;
                remainingMonthly[f] = Math.max(0, (cfg.monthly[f] || 0) - (usage.monthly[f] || 0)) + extra;
            }
        });

        return {
            tier: status.tier,
            isSupporter: status.isSupporter,
            isAdmin: admin,
            byok,
            priority: admin ? 4 : cfg.priority,
            dailyDate: usage.dailyDate,
            monthlyKey: usage.monthlyKey,
            daily: { ...usage.daily },
            monthly: { ...usage.monthly },
            limits: { daily: { ...cfg.daily }, monthly: { ...cfg.monthly } },
            credits: { ...credits },
            trialTier: (u.coinBoost && Number(u.coinBoost.trialExpiresAt) > now) ? u.coinBoost.trialTier : 'free',
            trialExpiresAt: (u.coinBoost && Number(u.coinBoost.trialExpiresAt) > now) ? Number(u.coinBoost.trialExpiresAt) : 0,
            remainingDaily,
            remainingMonthly
        };
    }

    function canConsumeAiQuota(feature = 'def_fill') {
        if (isPersonalByokActive()) {
            return { allowed: true, byok: true, remaining: 999999 };
        }
        if (isAdminAccount(global.userData)) {
            return { allowed: true, byok: false, isAdmin: true, tier: 'supporter_180', remaining: 999999 };
        }
        const snap = getQuotaSnapshot();
        const f = VALID_FEATURES.includes(feature) ? feature : 'def_fill';
        const remD = snap.remainingDaily[f] || 0;
        const remM = snap.remainingMonthly[f] || 0;
        const allowed = remD > 0 && remM > 0;
        return {
            allowed,
            byok: false,
            isAdmin: false,
            tier: snap.tier,
            remaining: Math.min(remD, remM),
            dailyLimit: snap.limits.daily[f] || 0,
            monthlyLimit: snap.limits.monthly[f] || 0
        };
    }

    function consumeLocalQuota(feature = 'def_fill') {
        if (isPersonalByokActive() || isAdminAccount(global.userData)) return;
        const u = global.userData || (global.userData = {});
        ensureMembershipDefaults(u);
        const f = VALID_FEATURES.includes(feature) ? feature : 'def_fill';
        const snap = getQuotaSnapshot();
        const dLim = snap.limits.daily[f] || 0;
        const mLim = snap.limits.monthly[f] || 0;
        if ((u.aiUsage.daily[f] || 0) < dLim && (u.aiUsage.monthly[f] || 0) < mLim) {
            u.aiUsage.daily[f] = (u.aiUsage.daily[f] || 0) + 1;
            u.aiUsage.monthly[f] = (u.aiUsage.monthly[f] || 0) + 1;
        } else if ((u.coinBoost.credits[f] || 0) > 0) {
            u.coinBoost.credits[f] = Math.max(0, (u.coinBoost.credits[f] || 0) - 1);
        }
    }

    function syncQuotaFromServer(serverQuota) {
        if (!serverQuota || typeof serverQuota !== 'object') return;
        const u = global.userData || (global.userData = {});
        ensureMembershipDefaults(u);
        if (serverQuota.isAdmin === true) u.isAdmin = true;
        if (serverQuota.dailyDate) u.aiUsage.dailyDate = serverQuota.dailyDate;
        if (serverQuota.monthlyKey) u.aiUsage.monthlyKey = serverQuota.monthlyKey;
        if (serverQuota.daily && typeof serverQuota.daily === 'object') {
            VALID_FEATURES.forEach((f) => {
                if (serverQuota.daily[f] !== undefined) u.aiUsage.daily[f] = Math.max(0, Number(serverQuota.daily[f]) || 0);
            });
        }
        if (serverQuota.monthly && typeof serverQuota.monthly === 'object') {
            VALID_FEATURES.forEach((f) => {
                if (serverQuota.monthly[f] !== undefined) u.aiUsage.monthly[f] = Math.max(0, Number(serverQuota.monthly[f]) || 0);
            });
        }
        if (serverQuota.credits && typeof serverQuota.credits === 'object') {
            VALID_FEATURES.forEach((f) => {
                if (serverQuota.credits[f] !== undefined) u.coinBoost.credits[f] = Math.max(0, Number(serverQuota.credits[f]) || 0);
            });
        }
        if (serverQuota.trialTier && serverQuota.trialExpiresAt !== undefined) {
            u.coinBoost.trialTier = serverQuota.trialTier;
            u.coinBoost.trialExpiresAt = Number(serverQuota.trialExpiresAt) || 0;
        }
        const body = document.getElementById('membershipModalBody');
        const modal = document.getElementById('membershipModal');
        if (body && modal && !modal.classList.contains('hidden')) {
            renderMembershipModalBody();
        }
        if (global.LZHEntitlements && typeof global.LZHEntitlements.notifyStateChange === 'function') {
            global.LZHEntitlements.notifyStateChange('quota_synced');
        }
    }

    async function refreshQuotaStatusFromServer() {
        try {
            const authUser = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) ? firebase.auth().currentUser : null;
            if (!authUser || authUser.isAnonymous || typeof authUser.getIdToken !== 'function') return null;
            const token = await authUser.getIdToken(false);
            const res = await fetch(`${SHARED_WORKER_BASE}/ai/quota-status`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (data && data.quota) {
                syncQuotaFromServer(data.quota);
                return data.quota;
            }
        } catch (e) {}
        return null;
    }

    function showQuotaUpgradePrompt(feature = 'def_fill') {
        const featureNames = {
            def_fill: memTr('quotaFeatDefFill', 'AI 填補釋義例句'),
            article_gen: memTr('quotaFeatArticle', 'AI 產生文章出題'),
            vision_ocr: memTr('quotaFeatVision', 'AI 雲端拍照識別'),
            fast_refine: memTr('quotaFeatSubtitle', 'AI 即時字幕精修')
        };
        const label = featureNames[feature] || 'AI 功能';
        const msg = memTr('toastQuotaExceededHint', '{feat} 今日／本月配額已達上限（已自動啟用免費離線或極速引擎）。可升級會員、用商店金幣兌換，或填入個人 Groq / Google API Key！', { feat: label });
        if (typeof global.showToast === 'function') {
            global.showToast(msg, 'warning');
        }
    }

    function stripExpiredSupporterCosmetics(userDataObj = global.userData, activePriceNtd = 0) {
        if (!userDataObj || !userDataObj.cosmetics) return false;
        if (isAdminAccount(userDataObj)) return false;
        const catalog = global.PROFILE_COSMETIC_CATALOG || {};
        let changed = false;

        const checkField = (listKey, equipKey, defaultVal) => {
            const equippedId = userDataObj.cosmetics[equipKey];
            const item = Array.isArray(catalog[listKey]) ? catalog[listKey].find(x => x.id === equippedId) : null;
            if (item && item.supporterOnly && (Number(item.minTierNtd) || 0) > activePriceNtd) {
                userDataObj.cosmetics[equipKey] = defaultVal;
                changed = true;
            }
        };

        checkField('frames', 'frame', 'default');
        checkField('banners', 'banner', 'default');
        checkField('titles', 'title', 'newcomer');
        return changed;
    }

    async function checkMembershipExpiration(options = {}) {
        const { silent = false, sync = true } = options || {};
        const u = global.userData;
        if (!u || !u.membership || isAdminAccount(u)) return false;

        const resolved = resolveActiveMembership(u, Date.now());
        if (resolved.expired && u.membership.tier !== 'free') {
            u.membership.tier = 'free';
            u.membership.tierPriceNtd = 0;
            u.membership.autoDowngradedAt = Date.now();
            stripExpiredSupporterCosmetics(u, resolved.priceNtd);

            if (typeof global.applyNavAvatarFrame === 'function') global.applyNavAvatarFrame();
            if (typeof global.renderProfileSection === 'function' && global.currentTab === 'profile') {
                global.renderProfileSection();
            }

            if (sync) {
                if (typeof global.saveUserData === 'function') await global.saveUserData();
                if (typeof global.syncMyPublicProfile === 'function') await global.syncMyPublicProfile(true);
                if (typeof global.writeCurrentUserOnlineStatus === 'function') global.writeCurrentUserOnlineStatus();
            }

            if (!silent && typeof global.showToast === 'function') {
                global.showToast(
                    memTr('toastMembershipExpired', '訂閱期已滿並自動恢復為免費方案，核心記憶功能與離線翻譯仍永久免費！'),
                    'info'
                );
            }
            if (global.LZHEntitlements && typeof global.LZHEntitlements.notifyStateChange === 'function') {
                global.LZHEntitlements.notifyStateChange('membership_expired');
            }
            return true;
        }

        if (stripExpiredSupporterCosmetics(u, resolved.priceNtd)) {
            if (typeof global.applyNavAvatarFrame === 'function') global.applyNavAvatarFrame();
            if (sync && typeof global.saveUserData === 'function') {
                global.saveUserData();
            }
            if (global.LZHEntitlements && typeof global.LZHEntitlements.notifyStateChange === 'function') {
                global.LZHEntitlements.notifyStateChange('cosmetics_stripped');
            }
        }
        return false;
    }

    function getMyMembershipStatus() {
        const u = global.userData || {};
        ensureMembershipDefaults(u);
        return resolveActiveMembership(u, Date.now());
    }

    function getEffectiveTier() {
        const u = global.userData || {};
        if (isAdminAccount(u)) return 'supporter_180';
        return getMyMembershipStatus().tier || 'free';
    }

    function getMyOnlineMembershipPayload() {
        const status = getMyMembershipStatus();
        return {
            membershipTier: status.tier,
            membershipExpiresAt: status.expiresAt || 0
        };
    }

    function renderBadgeHtml(input, options = {}) {
        const { size = 'xs', showFree = false, extraClass = '' } = options || {};
        const status = resolveActiveMembership(input, Date.now());
        if (!status.isSupporter && !showFree) return '';

        const meta = status.meta || MEMBERSHIP_TIERS.free;
        const label = status.isAdmin
            ? memTr('memAdminVipBadge', '管理員 VIP')
            : (status.isSupporter ? (meta.shortBadge || meta.name) : memTr('memFreeShort', '免費方案'));
        const sizeClass = size === 'sm'
            ? 'px-2.5 py-0.5 text-[11px] gap-1'
            : (size === '2xs' ? 'px-1.5 py-0.2 text-[9px] gap-0.5' : 'px-2 py-0.5 text-[10px] gap-1');

        return `<span class="inline-flex items-center rounded-full font-extrabold border shrink-0 shadow-2xs ${meta.badgeClass} ${sizeClass} ${extraClass}" title="${escapeMemHtml(meta.name)}"><span>${meta.icon}</span><span>${escapeMemHtml(label)}</span></span>`;
    }

    function isGuestSession() {
        if (typeof global.isGuestUser === 'function') return global.isGuestUser();
        const isFirebaseUser = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
        return !isFirebaseUser || localStorage.getItem('lzhcard_guest_mode') === 'true';
    }

    function setBillingCycle(cycle) {
        billingCycle = cycle === 'annual' ? 'annual' : 'monthly';
        renderMembershipModalBody();
    }

    function getPaymentPlatform() {
        try {
            if (global.LZHDesktopWidget && global.LZHDesktopWidget.isElectron) {
                return 'web';
            }
            if (typeof document !== 'undefined' && document.documentElement) {
                if (
                    document.documentElement.getAttribute('data-widget-mode') === 'desktop' ||
                    document.documentElement.dataset?.widgetMode === 'desktop'
                ) {
                    return 'web';
                }
            }
            if (typeof window !== 'undefined' && window.location && window.location.search) {
                const params = new URLSearchParams(window.location.search);
                if (params.get('widget') === 'desktop') return 'web';
            }
            const cap = global.Capacitor;
            if (cap) {
                const capPlatform = typeof cap.getPlatform === 'function'
                    ? String(cap.getPlatform() || '').toLowerCase()
                    : '';
                if (capPlatform === 'android') return 'android';
                if (capPlatform === 'ios') return 'ios';
                const isNative = typeof cap.isNativePlatform === 'function'
                    ? Boolean(cap.isNativePlatform())
                    : Boolean(cap.isNative);
                if (isNative) {
                    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
                    return /iphone|ipad|ipod/i.test(ua) ? 'ios' : 'android';
                }
            }
        } catch (e) {}
        return 'web';
    }

    function getPlayBillingPlugin() {
        const plugins = global.Capacitor && global.Capacitor.Plugins;
        return (plugins && plugins.PlayBilling) ? plugins.PlayBilling : null;
    }

    function getIosStoreKitPlugin() {
        const plugins = global.Capacitor && global.Capacitor.Plugins;
        if (plugins) {
            if (plugins.StoreKit) return { type: 'capacitor', plugin: plugins.StoreKit };
            if (plugins.AppleIAP) return { type: 'capacitor', plugin: plugins.AppleIAP };
            if (plugins.AppleBilling) return { type: 'capacitor', plugin: plugins.AppleBilling };
            if (plugins.InAppPurchase) return { type: 'capacitor', plugin: plugins.InAppPurchase };
            if (plugins.InAppPurchase2) return { type: 'capacitor', plugin: plugins.InAppPurchase2 };
        }
        if (global.CdvPurchase && global.CdvPurchase.store) {
            return { type: 'cdvpurchase', store: global.CdvPurchase.store };
        }
        return null;
    }

    function syncClientPostPurchaseState(data) {
        const u = global.userData || (global.userData = {});
        ensureMembershipDefaults(u);
        if (typeof data.coins === 'number') u.coins = data.coins;
        if (typeof data.newCoins === 'number') u.coins = data.newCoins;
        if (data.membership && typeof data.membership === 'object') {
            u.membership = { ...u.membership, ...data.membership };
        }
        if (Array.isArray(data.membershipHistory)) {
            u.membershipHistory = data.membershipHistory;
        }
        if (data.cosmetics && typeof data.cosmetics === 'object') {
            u.cosmetics = { ...u.cosmetics, ...data.cosmetics };
        }
        if (Array.isArray(data.purchasedCosmetics)) {
            u.purchasedCosmetics = data.purchasedCosmetics;
        }
        if (data.coinBoost && typeof data.coinBoost === 'object') {
            u.coinBoost = data.coinBoost;
        }
        if (data.quota) {
            syncQuotaFromServer(data.quota);
        }

        if (typeof global.updateUserCoinsUI === 'function') global.updateUserCoinsUI();
        if (typeof global.applyNavAvatarFrame === 'function') global.applyNavAvatarFrame();
        if (typeof global.syncMyPublicProfile === 'function') global.syncMyPublicProfile(true);
        if (typeof global.writeCurrentUserOnlineStatus === 'function') global.writeCurrentUserOnlineStatus();
        if (typeof global.renderProfileSection === 'function') global.renderProfileSection();
        if (typeof global.syncConfigToNativeOverlay === 'function') global.syncConfigToNativeOverlay();
        if (global.LZHEntitlements && typeof global.LZHEntitlements.notifyStateChange === 'function') {
            global.LZHEntitlements.notifyStateChange('post_purchase_sync');
        }
        renderMembershipModalBody();
    }

    async function verifyAndFulfillPlayPurchase(purchase) {
        if (!purchase || !purchase.purchaseToken || !purchase.productId) {
            throw new Error('Google Play 回傳的購買憑證無效');
        }
        const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
        if (!authUser || authUser.isAnonymous) {
            throw new Error(memTr('toastMemLoginRequired', '請先使用 Google 帳號登入後即可進行付款驗證！'));
        }
        const idToken = await authUser.getIdToken(false);

        const res = await fetch(`${SHARED_WORKER_BASE}/api/verify-purchase/android`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({
                productId: purchase.productId,
                purchaseToken: purchase.purchaseToken,
                orderId: purchase.orderId || '',
                packageName: ANDROID_PACKAGE_NAME
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            throw new Error(data.error || `購買驗證失敗 (HTTP ${res.status})`);
        }

        syncClientPostPurchaseState(data);

        // 僅於後端確定入帳成功後再呼叫核銷，防止未驗證即消失
        const plugin = getPlayBillingPlugin();
        if (plugin) {
            try {
                if (typeof plugin.consumePurchase === 'function') {
                    await plugin.consumePurchase({ purchaseToken: purchase.purchaseToken });
                } else if (typeof plugin.acknowledgePurchase === 'function') {
                    await plugin.acknowledgePurchase({ purchaseToken: purchase.purchaseToken });
                }
            } catch (e) {}
        }

        return data;
    }

    async function recoverPendingPlayPurchases(options = {}) {
        const { silent = true } = options || {};
        if (isGuestSession()) return 0;
        const plugin = getPlayBillingPlugin();
        if (!plugin || typeof plugin.queryPendingPurchases !== 'function') return 0;
        try {
            const res = await plugin.queryPendingPurchases();
            const list = Array.isArray(res && res.purchases) ? res.purchases : [];
            let recovered = 0;
            for (const p of list) {
                if (!p || p.purchaseState !== 1) continue;
                try {
                    const verified = await verifyAndFulfillPlayPurchase(p);
                    if (verified && verified.ok) recovered += 1;
                } catch (err) {
                    if (!silent && typeof global.showToast === 'function') {
                        global.showToast(err.message || '補單驗證失敗', 'warning');
                    }
                }
            }
            if (recovered > 0 && typeof global.showToast === 'function') {
                global.showToast(memTr('toastBillingRecovered', '已自動恢復並入帳 {count} 筆 Google Play 未完成訂單！', { count: recovered }), 'success');
            }
            return recovered;
        } catch (e) {
            return 0;
        }
    }

    async function launchGooglePlayPurchase(skuId) {
        if (isPurchasing) return false;

        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastMemLoginRequired', '請先使用 Google 帳號登入後即可進行付款購買！'), 'warning');
            }
            return false;
        }

        const plugin = getPlayBillingPlugin();
        if (!plugin || typeof plugin.purchaseProduct !== 'function') {
            if (typeof global.showToast === 'function') {
                global.showToast(
                    memTr('toastPlayBillingAndroidOnly', 'Google Play 實名金流僅於 Android App 內開放付款；網頁端請改用金幣兌換或填入個人 Groq / Google API Key！'),
                    'info'
                );
            }
            return false;
        }

        isPurchasing = true;
        renderMembershipModalBody();
        try {
            if (typeof plugin.isAvailable === 'function') {
                const avail = await plugin.isAvailable().catch(() => ({ available: false }));
                if (!avail || !avail.available) {
                    throw new Error(memTr('toastPlayServiceUnavailable', '此裝置暫時無法連線至 Google Play 商店，請確認 Play 商店與網路狀態。'));
                }
            }

            const purchaseRes = await plugin.purchaseProduct({ productId: skuId, productType: 'inapp' });
            if (!purchaseRes) throw new Error('Google Play 購買未完成');
            if (purchaseRes.cancelled) {
                if (typeof global.showToast === 'function') {
                    global.showToast(memTr('toastBillingCancelled', '已取消付款流程'), 'info');
                }
                return false;
            }
            if (purchaseRes.pending) {
                if (typeof global.showToast === 'function') {
                    global.showToast(memTr('toastBillingPending', '交易處理中，完成扣款後系統將自動驗證並發放！'), 'info');
                }
                return false;
            }

            const verified = await verifyAndFulfillPlayPurchase(purchaseRes);
            if (typeof global.showToast === 'function') {
                global.showToast(verified.message || memTr('toastBillingVerifiedSuccess', '🎉 Google Play 購買驗證成功！'), 'success');
            }
            refreshQuotaStatusFromServer();
            return true;
        } catch (err) {
            const msg = String(err?.message || err || '');
            if (!/cancel/i.test(msg)) {
                if (typeof global.showToast === 'function') {
                    global.showToast(msg || memTr('toastBillingFailed', 'Google Play 購買或驗證失敗，請稍後再試'), 'error');
                }
            }
            return false;
        } finally {
            isPurchasing = false;
            renderMembershipModalBody();
        }
    }

    async function verifyAndFulfillIosPurchase(payload) {
        const productId = String((payload && payload.productId) || '').trim();
        const transactionId = String((payload && (payload.transactionId || payload.transactionIdentifier || payload.originalTransactionId)) || '').trim();
        const receipt = String((payload && (payload.receipt || payload.appStoreReceipt || payload.jwsRepresentation)) || '').trim();
        if (!productId || (!transactionId && !receipt)) {
            throw new Error('App Store 回傳的購買憑證無效');
        }
        const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
        if (!authUser || authUser.isAnonymous) {
            throw new Error('請先登入帳號後即可進行 App Store 付款驗證！');
        }
        const idToken = await authUser.getIdToken(false);

        const res = await fetch(`${SHARED_WORKER_BASE}/api/verify-purchase/ios`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({
                productId,
                transactionId,
                originalTransactionId: payload.originalTransactionId || '',
                receipt,
                restore: Boolean(payload.restore)
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            throw new Error(data.error || `App Store 購買驗證失敗 (HTTP ${res.status})`);
        }
        syncClientPostPurchaseState(data);
        return data;
    }

    async function launchAppleIapPurchase(skuId) {
        if (isPurchasing) return false;
        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先使用 Apple 或 Google 帳號登入後即可進行 App Store 內購！', 'warning');
            }
            return false;
        }

        const bridge = getIosStoreKitPlugin();
        if (!bridge) {
            if (typeof global.showToast === 'function') {
                global.showToast('正在初始化 Apple App Store 內購服務，請確認已透過 TestFlight / App Store 安裝正式版本。', 'info');
            }
            return false;
        }

        isPurchasing = true;
        renderMembershipModalBody();
        try {
            let purchaseRes = null;
            if (bridge.type === 'capacitor' && bridge.plugin) {
                if (typeof bridge.plugin.purchaseProduct === 'function') {
                    purchaseRes = await bridge.plugin.purchaseProduct({ productId: skuId });
                } else if (typeof bridge.plugin.purchase === 'function') {
                    purchaseRes = await bridge.plugin.purchase({ productId: skuId });
                }
            } else if (bridge.type === 'cdvpurchase' && bridge.store) {
                const product = bridge.store.get(skuId);
                if (!product) {
                    throw new Error(`找不到 App Store 商品項目 (${skuId})`);
                }
                const offer = product.getOffer ? product.getOffer() : null;
                if (!offer) {
                    throw new Error(`無法取得 App Store 商品報價 (${skuId})`);
                }
                const orderErr = await offer.order();
                if (orderErr && orderErr.isError) {
                    throw new Error(orderErr.message || 'App Store 付款失敗');
                }
                purchaseRes = {
                    productId: skuId,
                    transactionId: offer.transactionId || '',
                    receipt: offer.receipt || ''
                };
            }

            if (!purchaseRes) {
                throw new Error('Apple App Store 內購未完成');
            }
            if (purchaseRes.cancelled) {
                if (typeof global.showToast === 'function') {
                    global.showToast('已取消 App Store 付款流程', 'info');
                }
                return false;
            }

            const verified = await verifyAndFulfillIosPurchase({
                productId: purchaseRes.productId || skuId,
                transactionId: purchaseRes.transactionId || purchaseRes.transactionIdentifier || '',
                originalTransactionId: purchaseRes.originalTransactionId || '',
                receipt: purchaseRes.receipt || purchaseRes.appStoreReceipt || purchaseRes.jwsRepresentation || ''
            });

            if (bridge.type === 'capacitor' && bridge.plugin && typeof bridge.plugin.finishTransaction === 'function') {
                await bridge.plugin.finishTransaction({
                    transactionId: purchaseRes.transactionId || ''
                }).catch(() => {});
            }

            if (typeof global.showToast === 'function') {
                global.showToast(verified.message || '🎉 App Store 購買驗證成功！', 'success');
            }
            refreshQuotaStatusFromServer();
            return true;
        } catch (err) {
            const msg = String(err?.message || err || '');
            if (!/cancel/i.test(msg)) {
                if (typeof global.showToast === 'function') {
                    global.showToast(msg || 'App Store 購買或驗證失敗，請稍後再試', 'error');
                }
            }
            return false;
        } finally {
            isPurchasing = false;
            renderMembershipModalBody();
        }
    }

    async function restoreIosPurchases() {
        if (isPurchasing) return false;
        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入原本購買的 Apple / Google 帳號後再點擊恢復購買！', 'warning');
            }
            return false;
        }

        const bridge = getIosStoreKitPlugin();
        if (!bridge) {
            if (typeof global.showToast === 'function') {
                global.showToast('目前尚未連接 App Store StoreKit 環境，請於 iOS 實機或 TestFlight 環境中執行恢復購買。', 'info');
            }
            return false;
        }

        isPurchasing = true;
        renderMembershipModalBody();
        try {
            let restored = null;
            if (bridge.type === 'capacitor' && bridge.plugin && typeof bridge.plugin.restorePurchases === 'function') {
                restored = await bridge.plugin.restorePurchases();
            } else if (bridge.type === 'cdvpurchase' && bridge.store && typeof bridge.store.restorePurchases === 'function') {
                await bridge.store.restorePurchases();
                const txList = Array.isArray(bridge.store.verifiedPurchases) ? bridge.store.verifiedPurchases : [];
                restored = { transactions: txList, receipt: '' };
            }

            const txList = Array.isArray(restored && restored.transactions)
                ? restored.transactions
                : (Array.isArray(restored && restored.purchases) ? restored.purchases : []);
            const globalReceipt = String((restored && (restored.receipt || restored.appStoreReceipt)) || '').trim();

            if (txList.length === 0 && !globalReceipt) {
                if (typeof global.showToast === 'function') {
                    global.showToast('目前查無可恢復的 App Store 有效購買紀錄', 'info');
                }
                return false;
            }

            let restoredCount = 0;
            if (txList.length > 0) {
                for (const tx of txList) {
                    if (!tx || !tx.productId) continue;
                    try {
                        const verified = await verifyAndFulfillIosPurchase({
                            productId: tx.productId,
                            transactionId: tx.transactionId || tx.originalTransactionId || '',
                            originalTransactionId: tx.originalTransactionId || '',
                            receipt: tx.receipt || tx.jwsRepresentation || globalReceipt,
                            restore: true
                        });
                        if (verified && verified.ok && !verified.alreadyProcessed) {
                            restoredCount += 1;
                        }
                    } catch (err) {}
                }
            } else if (globalReceipt) {
                const authUser = firebase.auth().currentUser;
                const idToken = await authUser.getIdToken(false);
                const res = await fetch(`${SHARED_WORKER_BASE}/api/verify-purchase/ios`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({
                        restore: true,
                        receipt: globalReceipt
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.ok) {
                    syncClientPostPurchaseState(data);
                    restoredCount = data.restoredCount || 1;
                }
            }

            refreshQuotaStatusFromServer();
            if (typeof global.showToast === 'function') {
                global.showToast(
                    restoredCount > 0
                        ? `✅ 已成功恢復 ${restoredCount} 筆 App Store 購買紀錄！`
                        : '✅ 已同步完成您的 App Store 購買紀錄！',
                    'success'
                );
            }
            return true;
        } catch (err) {
            if (typeof global.showToast === 'function') {
                global.showToast(err?.message || '恢復購買失敗，請稍後再試', 'error');
            }
            return false;
        } finally {
            isPurchasing = false;
            renderMembershipModalBody();
        }
    }

    async function launchWebCheckoutPurchase(skuId) {
        if (isPurchasing) return false;
        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號後即可前往網頁版金流結帳！', 'warning');
            }
            return false;
        }

        isPurchasing = true;
        renderMembershipModalBody();
        try {
            const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
            if (!authUser || authUser.isAnonymous) {
                throw new Error('請先登入帳號後再進行購買');
            }
            const idToken = await authUser.getIdToken(false);
            const res = await fetch(`${SHARED_WORKER_BASE}/api/payment/web-checkout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    productId: skuId,
                    platform: 'web',
                    returnUrl: (typeof window !== 'undefined' && window.location) ? window.location.href : ''
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(
                    data.error ||
                    '網頁版線上金流維護中，請使用 Android 或 iOS App 內購儲值，或於設定頁填入個人 API Key（BYOK）'
                );
            }

            if (data.checkoutUrl) {
                if (typeof global.showToast === 'function') {
                    global.showToast('正在前往線上金流結帳頁面...', 'info');
                }
                if (typeof window !== 'undefined' && window.location) {
                    window.location.assign(data.checkoutUrl);
                }
                return true;
            }

            if (typeof global.showToast === 'function') {
                global.showToast(
                    data.message || '網頁版線上金流維護中，請使用 Android 或 iOS App 內購儲值，或於設定頁填入個人 API Key（BYOK）',
                    'info'
                );
            }
            return false;
        } catch (err) {
            if (typeof global.showToast === 'function') {
                global.showToast(
                    err?.message || '網頁版線上金流維護中，請使用 Android 或 iOS App 內購儲值，或於設定頁填入個人 API Key（BYOK）',
                    'info'
                );
            }
            return false;
        } finally {
            isPurchasing = false;
            renderMembershipModalBody();
        }
    }

    async function launchPurchaseByPlatform(skuId) {
        const platform = getPaymentPlatform();
        if (platform === 'android') {
            return await launchGooglePlayPurchase(skuId);
        }
        if (platform === 'ios') {
            return await launchAppleIapPurchase(skuId);
        }
        return await launchWebCheckoutPurchase(skuId);
    }

    async function buyCoinTopupPackage(skuId) {
        const pack = COIN_TOPUP_PACKAGES.find(p => p.sku === skuId);
        if (!pack) return false;
        return await launchPurchaseByPlatform(pack.sku);
    }

    async function subscribeMembershipTier(tierId, options = {}) {
        const targetMeta = MEMBERSHIP_TIERS[tierId];
        if (!targetMeta) return false;

        if (isPurchasing) return false;

        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastMemLoginRequired', '請先使用 Google 帳號登入後即可管理或啟用會員方案！'), 'warning');
            }
            return false;
        }

        const u = global.userData || (global.userData = {});
        ensureMembershipDefaults(u);
        const now = Date.now();
        const admin = isAdminAccount(u);

        if (tierId === 'free') {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastMemFreeNote', '免費方案核心功能永久開放；若目前已訂閱付費方案，將於期滿自動恢復免費身分。'), 'info');
            }
            return true;
        }

        if (admin) {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastAdminAlreadyVip', '👑 管理員帳號已永久享有全功能無限制特權與專屬外觀，無需付款！'), 'success');
            }
            return true;
        }

        // 防止重複購買同級或更低等級有效會員
        const current = resolveActiveMembership(u, now);
        if (current.isSupporter && !current.isCoinTrial && current.expiresAt > now) {
            const curIdx = TIER_ORDER.indexOf(current.tier);
            const targetIdx = TIER_ORDER.indexOf(tierId);
            if (curIdx >= targetIdx) {
                const ymd = formatYmdDate(current.expiresAt);
                if (typeof global.showToast === 'function') {
                    global.showToast(
                        memTr('memActiveExpiryLock', '目前已是有效會員（到期日：{date}）', { date: ymd }),
                        'info'
                    );
                }
                return false;
            }
        }

        const isAnnual = (options.cycle || billingCycle) === 'annual';
        const skuMap = PLAY_MEMBERSHIP_SKUS[tierId];
        if (!skuMap) return false;
        const skuId = isAnnual ? skuMap.annual : skuMap.monthly;
        return await launchPurchaseByPlatform(skuId);
    }

    async function redeemCoinsForPack(packId) {
        const pack = COIN_REDEEM_PACKS.find(p => p.id === packId);
        if (!pack || isPurchasing) return false;

        if (isGuestSession()) {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastMemLoginRequired', '請先使用 Google 帳號登入後即可使用商店金幣兌換！'), 'warning');
            }
            return false;
        }

        const u = global.userData || (global.userData = {});
        const admin = isAdminAccount(u);

        if (pack.fullMembershipDays > 0 && pack.fullMembershipTier && !admin) {
            const current = resolveActiveMembership(u, Date.now());
            if (current.isSupporter && !current.isCoinTrial && current.expiresAt > Date.now()) {
                const curIdx = TIER_ORDER.indexOf(current.tier);
                const targetIdx = TIER_ORDER.indexOf(pack.fullMembershipTier);
                if (curIdx >= targetIdx) {
                    const ymd = formatYmdDate(current.expiresAt);
                    if (typeof global.showToast === 'function') {
                        global.showToast(memTr('memActiveExpiryLock', '目前已是有效會員（到期日：{date}）', { date: ymd }), 'info');
                    }
                    return false;
                }
            }
        }

        const coins = Math.max(0, Math.floor(Number(u.coins) || 0));
        if (!admin && coins < pack.costCoins) {
            if (typeof global.showToast === 'function') {
                global.showToast(memTr('toastCoinsInsufficient', '金幣不足！此方案需要 {need} 金幣（目前 {have} 金幣）', { need: pack.costCoins, have: coins }), 'warning');
            }
            return false;
        }

        const packTitle = memTr(pack.titleKey, pack.titleFallback);
        const confirmText = admin
            ? `管理員特權：確認免費開通「${packTitle}」嗎？`
            : memTr('confirmCoinRedeem', '確認花費 {cost} 商店金幣兌換「{name}」嗎？', { cost: pack.costCoins, name: packTitle });
        const confirmed = typeof global.lzhConfirm === 'function'
            ? await global.lzhConfirm(confirmText)
            : false;
        if (!confirmed) {
            return false;
        }

        isPurchasing = true;
        renderMembershipModalBody();
        try {
            const authUser = firebase.auth().currentUser;
            const idToken = await authUser.getIdToken(false);
            const res = await fetch(`${SHARED_WORKER_BASE}/membership/redeem-coins`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({ packId: pack.id })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || '金幣兌換失敗');
            }

            syncClientPostPurchaseState(data);

            if (typeof global.showToast === 'function') {
                global.showToast(data.message || `🎉 已成功兌換「${packTitle}」！`, 'success');
            }
            return true;
        } catch (err) {
            if (typeof global.showToast === 'function') {
                global.showToast(err.message || '兌換失敗，請稍後再試', 'error');
            }
            return false;
        } finally {
            isPurchasing = false;
            renderMembershipModalBody();
        }
    }

    function renderQuotaBarItem(label, used, limit, extraCredit = 0, unlimitedMode = false, unlimitedTag = '∞ BYOK') {
        if (unlimitedMode) {
            return `
                <div class="p-2.5 rounded-xl bg-white dark:bg-slate-800/80 border border-emerald-200 dark:border-emerald-800/70">
                    <div class="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                        <span>${escapeMemHtml(label)}</span>
                        <span class="text-emerald-600 dark:text-emerald-400">${escapeMemHtml(unlimitedTag)}</span>
                    </div>
                    <div class="mt-1.5 h-1.5 w-full rounded-full bg-emerald-100 dark:bg-emerald-950/60 overflow-hidden">
                        <div class="h-full w-full bg-emerald-500 rounded-full"></div>
                    </div>
                </div>
            `;
        }
        const safeLimit = Math.max(0, Number(limit) || 0);
        const safeUsed = Math.max(0, Number(used) || 0);
        const pct = safeLimit > 0 ? Math.min(100, Math.round((safeUsed / safeLimit) * 100)) : 100;
        const barColor = safeLimit === 0
            ? 'bg-slate-300 dark:bg-slate-600'
            : (pct >= 90 ? 'bg-rose-500' : (pct >= 70 ? 'bg-amber-500' : 'bg-brand-500'));
        const rightText = safeLimit === 0
            ? (extraCredit > 0 ? `補充包 ${extraCredit}` : memTr('memQuotaTier1Only', '免費離線/直譯'))
            : `${safeUsed}/${safeLimit}${extraCredit > 0 ? ` (+${extraCredit})` : ''}`;

        return `
            <div class="p-2.5 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80">
                <div class="flex items-center justify-between gap-2 text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span class="truncate">${escapeMemHtml(label)}</span>
                    <span class="font-mono text-[10px] shrink-0 ${safeLimit === 0 && extraCredit === 0 ? 'text-slate-400 dark:text-slate-500' : 'text-slate-600 dark:text-slate-300'}">${escapeMemHtml(rightText)}</span>
                </div>
                <div class="mt-1.5 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                    <div class="h-full ${barColor} rounded-full transition-all" style="width:${safeLimit === 0 ? 0 : pct}%"></div>
                </div>
            </div>
        `;
    }

    function renderMembershipModalBody() {
        const body = document.getElementById('membershipModalBody');
        if (!body) return;

        const u = global.userData || {};
        ensureMembershipDefaults(u);
        const now = Date.now();
        const admin = isAdminAccount(u);
        const status = resolveActiveMembership(u, now);
        const snap = getQuotaSnapshot();
        const isGuest = isGuestSession();
        const isAnnual = billingCycle === 'annual';
        const userCoins = Math.max(0, Math.floor(Number(u.coins) || 0));
        const history = Array.isArray(u.membershipHistory) ? u.membershipHistory : [];
        const platform = getPaymentPlatform();
        const isIos = platform === 'ios';
        const isAndroid = platform === 'android';
        const hasPlayBilling = Boolean(getPlayBillingPlugin());
        const hasIosStoreKit = Boolean(getIosStoreKitPlugin());
        const keyStatus = getPersonalKeysStatus();

        const currentPaidIdx = (status.isSupporter && !status.isCoinTrial && !admin)
            ? TIER_ORDER.indexOf(status.tier)
            : 0;

        const tierCardsHtml = TIER_ORDER.map((tid, idx) => {
            const tier = MEMBERSHIP_TIERS[tid];
            const isCurrent = status.tier === tier.id;
            const isHigherUnlocked = (status.priceNtd > tier.priceNtd && tier.priceNtd > 0) || admin;
            const displayPrice = isAnnual ? tier.annualPriceNtd : tier.priceNtd;
            const monthlyEquiv = isAnnual && tier.annualPriceNtd > 0 ? Math.round(tier.annualPriceNtd / 12) : tier.priceNtd;

            const isLockedDuplicate = !admin && tier.id !== 'free' && currentPaidIdx >= idx && currentPaidIdx > 0;
            const isUpgradeable = !admin && tier.id !== 'free' && currentPaidIdx > 0 && idx > currentPaidIdx;
            const isDisabled = isPurchasing || (tier.id === 'free' && isCurrent) || isLockedDuplicate || (admin && tier.id !== 'free');

            let btnLabel = '';
            if (tier.priceNtd === 0) {
                btnLabel = isCurrent
                    ? memTr('btnMemCurrentPlan', '✓ 目前方案')
                    : memTr('memFreeAutoRevertHint', '期滿自動恢復免費');
            } else if (isIos) {
                btnLabel = isAnnual
                    ? `App Store 訂閱 NT$ ${displayPrice} / 年`
                    : `App Store 購買 NT$ ${displayPrice} / 30天`;
            } else if (isAndroid) {
                btnLabel = isAnnual
                    ? memTr('btnMemSponsorAnnual', '年繳 NT$ {price} / 年', { price: displayPrice })
                    : memTr('btnMemSponsorPlan', 'Google Play 購買 {price} / 30天', { price: `NT$ ${displayPrice}` });
            } else {
                btnLabel = isAnnual
                    ? `線上購買 NT$ ${displayPrice} / 年`
                    : `線上購買 NT$ ${displayPrice} / 30天`;
            }

            if (admin && tier.id !== 'free') {
                btnLabel = memTr('btnAdminUnlockedVip', '👑 管理員已解鎖全功能');
            } else if (isLockedDuplicate) {
                btnLabel = memTr('memActiveExpiryLock', '目前已是有效會員（到期日：{date}）', { date: formatYmdDate(status.expiresAt) });
            } else if (isUpgradeable) {
                btnLabel = isIos
                    ? (isAnnual ? `透過 App Store 升級年繳 NT$ ${displayPrice}` : `透過 App Store 升級 NT$ ${displayPrice}`)
                    : (isAnnual
                        ? memTr('btnMemUpgradeAnnual', '升級年繳 NT$ {price}', { price: displayPrice })
                        : memTr('btnMemUpgradePlan', '升級為此方案 NT$ {price}', { price: displayPrice }));
            }

            const btnColorClass = isDisabled
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                : (tier.priceNtd === 0
                    ? 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
                    : (tier.id === 'supporter_180'
                        ? 'bg-gradient-to-r from-amber-500 via-rose-500 to-purple-600 hover:opacity-95 text-white shadow-sm'
                        : (tier.id === 'supporter_90'
                            ? 'bg-gradient-to-r from-sky-500 to-indigo-600 hover:opacity-95 text-white shadow-sm'
                            : 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm')));

            return `
                <div class="rounded-2xl border-2 p-4 flex flex-col justify-between gap-3 transition relative ${isCurrent
                    ? `${tier.cardAccentClass} bg-brand-50/40 dark:bg-slate-900 shadow-sm ring-2 ring-brand-500/25`
                    : `${tier.cardAccentClass} bg-white dark:bg-slate-900/70 hover:shadow-md`}">
                    <div class="space-y-2.5">
                        <div class="flex items-start justify-between gap-2">
                            <div>
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="text-lg">${tier.icon}</span>
                                    <h4 class="font-extrabold text-sm text-slate-900 dark:text-white">${escapeMemHtml(memTr(tier.nameKey, tier.name))}</h4>
                                </div>
                                <div class="mt-1 flex items-baseline gap-1.5 flex-wrap">
                                    <span class="text-xl font-black text-slate-900 dark:text-white">${tier.priceNtd === 0 ? 'NT$ 0' : `NT$ ${displayPrice}`}</span>
                                    <span class="text-[11px] font-semibold text-slate-400">
                                        ${tier.priceNtd === 0
                                            ? memTr('memFreeForeverSuffix', '/ 核心功能永久免費')
                                            : (isAnnual
                                                ? memTr('memAnnualSuffix', '/ 年（均月 NT$ {m} · 付10送2）', { m: monthlyEquiv })
                                                : memTr('memMonthlySuffix', '/ 30 天（到期自動恢復免費）'))}
                                    </span>
                                </div>
                            </div>
                            <div class="flex flex-col items-end gap-1 shrink-0">
                                ${isCurrent ? `<span class="px-2 py-0.5 rounded-full bg-brand-600 text-white text-[10px] font-extrabold">${escapeMemHtml(memTr('memBadgeCurrent', '目前方案'))}</span>` : ''}
                                ${!isCurrent && tier.isPopular ? `<span class="px-2 py-0.5 rounded-full bg-sky-600 text-white text-[10px] font-extrabold">${escapeMemHtml(memTr('memBadgePopular', '80/20 熱門推薦'))}</span>` : ''}
                                ${!isCurrent && isHigherUnlocked ? `<span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">${escapeMemHtml(memTr('memBadgeIncluded', '已涵蓋外觀'))}</span>` : ''}
                            </div>
                        </div>

                        <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">${escapeMemHtml(memTr(tier.descKey, tier.desc))}</p>

                        ${tier.priceNtd > 0 ? `
                            <div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700/80 flex items-center justify-between gap-2">
                                <span class="text-[10px] font-bold text-slate-400">${escapeMemHtml(memTr('memBadgePreviewLbl', '專屬徽章預覽'))}</span>
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${tier.badgeClass}">
                                    <span>${tier.icon}</span>
                                    <span>${escapeMemHtml(tier.shortBadge)}</span>
                                </span>
                            </div>
                        ` : ''}

                        <ul class="space-y-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                            ${tier.perks.map(p => `
                                <li class="flex items-start gap-1.5">
                                    <i class="fa-solid fa-check text-emerald-500 mt-0.5 shrink-0 text-[10px]"></i>
                                    <span>${escapeMemHtml(p)}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>

                    <button type="button"
                        onclick="MembershipEngine.subscribeMembershipTier('${tier.id}')"
                        ${isDisabled ? 'disabled' : ''}
                        class="w-full min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold transition flex items-center justify-center gap-1.5 ${btnColorClass}">
                        <span>${isPurchasing ? memTr('btnBillingProcessing', '交易驗證處理中...') : escapeMemHtml(btnLabel)}</span>
                    </button>
                </div>
            `;
        }).join('');

        const topupCardsHtml = COIN_TOPUP_PACKAGES.map((pack) => {
            return `
                <button type="button"
                    onclick="MembershipEngine.buyCoinTopupPackage('${pack.sku}')"
                    ${isPurchasing ? 'disabled' : ''}
                    class="p-3 rounded-xl bg-white dark:bg-slate-800 border-2 ${pack.popular ? 'border-amber-400 dark:border-amber-500 shadow-xs' : 'border-slate-200 dark:border-slate-700'} hover:border-amber-500 text-left transition flex flex-col justify-between gap-2 min-h-[96px] cursor-pointer disabled:opacity-60">
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-lg">${pack.icon}</span>
                        ${pack.popular ? `<span class="px-1.5 py-0.5 rounded-full bg-amber-500 text-white text-[9px] font-black">${escapeMemHtml(memTr('memTopupPopular', '最推薦'))}</span>` : ''}
                    </div>
                    <div>
                        <div class="text-xs font-black text-slate-900 dark:text-white">${pack.coins.toLocaleString()} 🪙</div>
                        <div class="text-[11px] font-extrabold text-amber-600 dark:text-amber-400">NT$ ${pack.priceNtd}</div>
                    </div>
                </button>
            `;
        }).join('');

        const coinPacksHtml = COIN_REDEEM_PACKS.map((pack) => {
            const affordable = admin || userCoins >= pack.costCoins;
            const lockedPack = !admin && pack.fullMembershipDays > 0 && currentPaidIdx >= TIER_ORDER.indexOf(pack.fullMembershipTier) && currentPaidIdx > 0;
            return `
                <div class="p-3 rounded-xl bg-white dark:bg-slate-800/80 border border-amber-200/80 dark:border-amber-800/60 flex flex-col justify-between gap-2.5">
                    <div>
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-extrabold text-slate-900 dark:text-white flex items-center gap-1.5">
                                <span>${pack.icon}</span>
                                <span>${escapeMemHtml(memTr(pack.titleKey, pack.titleFallback))}</span>
                            </span>
                            <span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 text-[10px] font-black shrink-0">🪙 ${admin ? 0 : pack.costCoins}</span>
                        </div>
                        <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">${escapeMemHtml(memTr(pack.descKey, pack.descFallback))}</p>
                    </div>
                    <button type="button"
                        onclick="MembershipEngine.redeemCoinsForPack('${pack.id}')"
                        ${(isPurchasing || lockedPack) ? 'disabled' : ''}
                        class="w-full min-h-[40px] py-1.5 px-3 rounded-lg text-[11px] font-extrabold transition ${lockedPack
                            ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                            : (affordable
                                ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-2xs cursor-pointer'
                                : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 cursor-pointer')}">
                        ${lockedPack
                            ? escapeMemHtml(memTr('memActiveExpiryLock', '目前已是有效會員（到期日：{date}）', { date: formatYmdDate(status.expiresAt) }))
                            : escapeMemHtml(admin ? '👑 管理員免費開通' : memTr('btnRedeemCoinsNow', '立即用 {cost} 金幣兌換', { cost: pack.costCoins }))}
                    </button>
                </div>
            `;
        }).join('');

        const unlimitedTag = admin ? '∞ ADMIN' : '∞ BYOK';
        const unlimitedActive = keyStatus.active || admin;

        body.innerHTML = `
            <div class="space-y-4">
                <!-- 🔑 強烈推薦自備 Groq / Google API Key 說明與雙軌透明公告 -->
                <div class="p-4 rounded-2xl bg-gradient-to-br from-emerald-50 via-amber-50/70 to-orange-50/70 dark:from-emerald-950/40 dark:via-slate-900 dark:to-amber-950/30 border-2 border-emerald-300/80 dark:border-emerald-700/70 shadow-2xs space-y-2">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="flex items-center gap-2 text-xs font-extrabold text-emerald-800 dark:text-emerald-300">
                            <i class="fa-solid fa-key text-amber-500"></i>
                            <span>${escapeMemHtml(memTr('memDisclosureHeading', '免費自備 Groq / Google Key 雙軌通道'))}</span>
                        </div>
                        <button type="button" onclick="if(typeof closeMembershipModal==='function') closeMembershipModal(); if(typeof openModal==='function') openModal('keyModal');" class="min-h-[36px] px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-extrabold cursor-pointer transition">
                            🔑 ${escapeMemHtml(memTr('btnByokShortcut', keyStatus.active ? '已啟用個人 API Key (設定)' : '立即設定個人 Groq / Gemini Key'))}
                        </button>
                    </div>
                    <p class="text-xs font-bold text-slate-700 dark:text-slate-200 leading-relaxed">
                        ${escapeMemHtml(memTr('byokMandatoryNotice', MANDATORY_BYOK_NOTICE))}
                    </p>
                </div>

                <!-- 🪪 目前方案與今日 AI 配額儀表板 -->
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2.5">
                        <div class="flex items-center gap-2.5">
                            <div class="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-xl shadow-2xs">
                                ${admin ? '👑' : status.meta.icon}
                            </div>
                            <div>
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="text-xs font-extrabold text-slate-900 dark:text-white">${escapeMemHtml(memTr('memCurrentStatus', '目前身分：'))}${escapeMemHtml(admin ? memTr('memAdminVipName', '系統管理員 (全功能永久解鎖)') : memTr(status.meta.nameKey, status.meta.name))}</span>
                                    ${status.isSupporter ? renderBadgeHtml(status, { size: 'xs' }) : ''}
                                    ${status.isCoinTrial ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[10px] font-bold">🎟️ 金幣體驗卡</span>` : ''}
                                    ${keyStatus.active ? `<span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">🔑 ${keyStatus.hasGroq ? 'Groq' : ''}${keyStatus.hasGroq && keyStatus.hasGemini ? '+' : ''}${keyStatus.hasGemini ? 'Gemini' : ''} Key 運作中</span>` : ''}
                                </div>
                                <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                    ${admin
                                        ? escapeMemHtml(memTr('memAdminStatusHint', '已自動解鎖所有付費功能、商城字庫、付費外觀與無限雲端 AI 配額'))
                                        : (status.isSupporter
                                            ? escapeMemHtml(memTr('memExpiresAt', '效期至 {date}（剩餘 {days} 天，期滿自動恢復免費身分）', { date: formatYmdDate(status.expiresAt), days: status.remainingDays }))
                                            : escapeMemHtml(memTr('memFreeStatusHint', '目前為免費方案 · 核心記憶／對戰永久免費；填入個人 Key 即享無上限')))}
                                </div>
                            </div>
                        </div>
                        ${isGuest ? `
                            <div class="flex items-center gap-2 flex-wrap">
                                ${isIos ? `
                                    <button type="button" onclick="if(typeof closeMembershipModal==='function') closeMembershipModal(); if(typeof loginWithApple==='function') loginWithApple();" class="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold cursor-pointer flex items-center gap-1.5">
                                        <i class="fa-brands fa-apple"></i>
                                        <span>使用 Apple 登入</span>
                                    </button>
                                ` : ''}
                                <button type="button" onclick="if(typeof closeMembershipModal==='function') closeMembershipModal(); if(typeof loginWithGoogle==='function') loginWithGoogle();" class="min-h-[44px] px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold cursor-pointer">
                                    ${escapeMemHtml(memTr('btnLoginGoogle', '使用 Google 帳號登入'))}
                                </button>
                            </div>
                        ` : `
                            <span class="px-2.5 py-1 rounded-xl bg-amber-100/80 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 text-[11px] font-extrabold border border-amber-200 dark:border-amber-800/70">
                                🪙 ${userCoins.toLocaleString()} 金幣
                            </span>
                        `}
                    </div>

                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        ${renderQuotaBarItem(memTr('quotaFeatDefFill', 'AI 填補釋義'), snap.daily.def_fill, snap.limits.daily.def_fill, snap.credits.def_fill, unlimitedActive, unlimitedTag)}
                        ${renderQuotaBarItem(memTr('quotaFeatArticle', 'AI 產生文章'), snap.daily.article_gen, snap.limits.daily.article_gen, snap.credits.article_gen, unlimitedActive, unlimitedTag)}
                        ${renderQuotaBarItem(memTr('quotaFeatVision', 'AI 拍照識別'), snap.daily.vision_ocr, snap.limits.daily.vision_ocr, snap.credits.vision_ocr, unlimitedActive, unlimitedTag)}
                        ${renderQuotaBarItem(memTr('quotaFeatSubtitle', 'AI 字幕精修'), snap.daily.fast_refine, snap.limits.daily.fast_refine, snap.credits.fast_refine, unlimitedActive, unlimitedTag)}
                    </div>
                </div>

                <!-- 🪙 2:8 金幣儲值商店（依裝置平台切換 Android Play / Apple StoreKit / Web 金流） -->
                <div class="p-3.5 rounded-2xl bg-gradient-to-br from-amber-50/80 to-orange-50/60 dark:from-amber-950/30 dark:to-slate-900 border border-amber-200 dark:border-amber-800/60 space-y-2.5">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                            <div class="text-xs font-extrabold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                                <span>🪙</span>
                                <span>${escapeMemHtml(memTr('topupSectionTitle', '商店金幣儲值（2:8 固定比例：NT$ 1 = 4 金幣）'))}</span>
                            </div>
                            <p class="text-[10px] text-amber-700/80 dark:text-amber-400/80 mt-0.5">
                                ${escapeMemHtml(isIos
                                    ? (hasIosStoreKit
                                        ? '經由 Apple App Store 安全內購並於雲端驗證入帳；可用於購買商城字庫、限定外觀與會員天數'
                                        : '透過 Apple App Store 內購安全付款並由雲端驗證發幣')
                                    : (isAndroid
                                        ? (hasPlayBilling
                                            ? memTr('topupPlayReadyDesc', '經由 Google Play 安全付款並於雲端驗證入帳；可用於購買商城字庫、限定外觀與會員天數')
                                            : memTr('topupPlayAndroidNote', '實名金流儲值請於 Android App 內透過 Google Play 購買（網頁版不可未付款直接發幣）'))
                                        : '支援網頁端線上結帳（維護期間請改用 Android / iOS App 內購或於設定頁填入個人 API Key）'))}
                            </p>
                        </div>
                        ${isIos ? `
                            <button type="button" id="btnMembershipRestoreIos"
                                onclick="MembershipEngine.restoreIosPurchases()"
                                ${isPurchasing ? 'disabled' : ''}
                                class="min-h-[34px] px-3 py-1 rounded-xl bg-slate-900 hover:bg-black dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-[11px] font-extrabold transition flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-60">
                                <i class="fa-solid fa-rotate-left"></i>
                                <span>恢復購買 (Restore Purchases)</span>
                            </button>
                        ` : ''}
                    </div>
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        ${topupCardsHtml}
                    </div>
                </div>

                <!-- 🗓️ 月繳 / 年繳 83折切換器 -->
                <div class="flex items-center justify-between gap-2 flex-wrap px-1">
                    <span class="text-xs font-extrabold text-slate-700 dark:text-slate-200">${escapeMemHtml(
                        isIos
                            ? 'App Store 會員方案與週期'
                            : (isAndroid ? memTr('memSelectPlanTitle', 'Google Play 會員方案與週期') : '線上金流會員方案與週期')
                    )}</span>
                    <div class="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 gap-1">
                        <button type="button" onclick="MembershipEngine.setBillingCycle('monthly')" class="px-3 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${!isAnnual ? 'bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-2xs' : 'text-slate-500 dark:text-slate-400'}">
                            ${escapeMemHtml(memTr('memCycleMonthly', '月繳方案 (30天)'))}
                        </button>
                        <button type="button" onclick="MembershipEngine.setBillingCycle('annual')" class="px-3 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer flex items-center gap-1 ${isAnnual ? 'bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-2xs' : 'text-slate-500 dark:text-slate-400'}">
                            <span>${escapeMemHtml(memTr('memCycleAnnual', '年繳方案 (365天)'))}</span>
                            <span class="px-1.5 py-0.2 rounded-md bg-emerald-100 dark:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 text-[9px]">${escapeMemHtml(memTr('memAnnualSaveBadge', '付10送2 · 省17%'))}</span>
                        </button>
                    </div>
                </div>

                <!-- 💳 四大方案卡片 -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    ${tierCardsHtml}
                </div>

                <!-- 🪙 金幣兌換會員天數與 AI 補充包 -->
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-2.5">
                    <div class="flex items-center justify-between gap-2">
                        <div class="text-xs font-extrabold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                            <span>🎟️</span>
                            <span>${escapeMemHtml(memTr('memCoinRedeemTitle', '使用儲值／分潤「商店金幣」兌換會員與 AI 額度補充包'))}</span>
                        </div>
                        <span class="text-[11px] font-extrabold text-amber-600 dark:text-amber-400 shrink-0">${userCoins.toLocaleString()} 🪙</span>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        ${coinPacksHtml}
                    </div>
                </div>

                ${history.length > 0 ? `
                    <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 space-y-2">
                        <div class="text-xs font-extrabold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                            <i class="fa-solid fa-clock-rotate-left text-brand-500"></i>
                            <span>${escapeMemHtml(memTr('memHistoryTitle', '最近方案與購買驗證紀錄'))}</span>
                        </div>
                        <div class="space-y-1.5 max-h-32 overflow-y-auto pr-1 text-[11px]">
                            ${history.slice(0, 6).map(rec => {
                                const m = getTierMeta(rec.tier);
                                return `
                                    <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                                        <span class="font-bold text-slate-700 dark:text-slate-200">${m.icon} ${escapeMemHtml(memTr(m.nameKey, m.name))} ${rec.priceNtd ? `(NT$ ${Number(rec.priceNtd)})` : (rec.coinsSpent ? `(${rec.coinsSpent} 🪙)` : '')}</span>
                                        <span class="text-slate-400 font-mono">${escapeMemHtml(formatYmdDate(rec.startedAt))} → ${escapeMemHtml(formatYmdDate(rec.expiresAt))}</span>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function openMembershipModal() {
        checkMembershipExpiration({ silent: true, sync: true });
        renderMembershipModalBody();
        refreshQuotaStatusFromServer();
        recoverPendingPlayPurchases({ silent: true });
        if (typeof global.openModal === 'function') {
            global.openModal('membershipModal');
        } else {
            const modal = document.getElementById('membershipModal');
            if (modal) modal.classList.remove('hidden');
        }
    }

    function closeMembershipModal() {
        if (typeof global.closeModal === 'function') {
            global.closeModal('membershipModal');
        } else {
            const modal = document.getElementById('membershipModal');
            if (modal) modal.classList.add('hidden');
        }
    }

    function startExpiryMonitor() {
        if (expiryMonitorTimer) clearInterval(expiryMonitorTimer);
        expiryMonitorTimer = setInterval(() => {
            checkMembershipExpiration({ silent: false, sync: true });
        }, 60000);

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    checkMembershipExpiration({ silent: false, sync: true });
                }
            });
        }
    }

    startExpiryMonitor();

    const MembershipEngine = {
        MEMBERSHIP_CYCLE_DAYS,
        MEMBERSHIP_CYCLE_MS,
        ANNUAL_CYCLE_DAYS,
        ANNUAL_CYCLE_MS,
        MANDATORY_BYOK_NOTICE,
        MANDATORY_DISCLOSURE_TEXT,
        AI_QUOTA_MATRIX,
        COIN_TOPUP_PACKAGES,
        PLAY_MEMBERSHIP_SKUS,
        COIN_REDEEM_PACKS,
        MEMBERSHIP_TIERS,
        isAdminAccount,
        getTierMeta,
        getTierQuotaConfig,
        isPersonalByokActive,
        getPersonalKeysStatus,
        resolveActiveMembership,
        ensureMembershipDefaults,
        checkMembershipExpiration,
        getMyMembershipStatus,
        getEffectiveTier,
        getMyOnlineMembershipPayload,
        getQuotaSnapshot,
        canConsumeAiQuota,
        consumeLocalQuota,
        syncQuotaFromServer,
        refreshQuotaStatusFromServer,
        showQuotaUpgradePrompt,
        setBillingCycle,
        getPaymentPlatform,
        buyCoinTopupPackage,
        redeemCoinsForPack,
        recoverPendingPlayPurchases,
        launchAppleIapPurchase,
        restoreIosPurchases,
        launchWebCheckoutPurchase,
        renderBadgeHtml,
        subscribeMembershipTier,
        openMembershipModal,
        closeMembershipModal,
        renderMembershipModalBody
    };

    global.MembershipEngine = MembershipEngine;
    global.getPaymentPlatform = getPaymentPlatform;
    global.restoreIosPurchases = restoreIosPurchases;
    global.openMembershipModal = openMembershipModal;
    global.closeMembershipModal = closeMembershipModal;
    global.checkMembershipExpiration = checkMembershipExpiration;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MembershipEngine;
    }
})(typeof window !== 'undefined' ? window : globalThis);
