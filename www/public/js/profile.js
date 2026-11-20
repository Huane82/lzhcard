/**
 * LZHCard - 獨立「個人檔案與查看玩家面板」模組 (js/profile.js)
 * 包含：
 * 1. 個人檔案英雄卡片（頭像框、背景橫幅、稱號、等級進度條、個人宣言）
 * 2. 外觀自訂儲物櫃（即時預覽與雲端同步）
 * 3. 個人公開學習統計卡（已掌握單字、連續天數、段位、對戰勝率、商店聲望）
 * 4. 跨模組玩家公開檢視彈窗 openPlayerProfileModal（聊天室 / 商城作者互通，含加好友與發送私訊）
 */

(function (global) {
    'use strict';

    const PROFILE_DEFAULT_AVATAR = 'https://api.dicebear.com/7.x/bottts/svg?seed=user';
    const LOCAL_PROFILE_CACHE_PREFIX = 'lzhcard_profile_cache_';

    let currentCustomizerTab = 'frames';
    let profileSyncDebounceTimer = null;
    let activeViewedProfileUid = '';
    const pendingOutgoingFriendUids = new Set();

    function profileTr(key, fallback, params = null) {
        let text = fallback;
        if (typeof global.t === 'function') {
            const res = global.t(key);
            if (res && res !== key) text = res;
        }
        if (params && typeof text === 'string') {
            Object.keys(params).forEach(k => {
                text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
            });
        }
        return text;
    }

    function escapeProfileHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * 🛡️ 安全網址過濾器：阻擋 javascript: / data:text/html 等危險協議
     */
    function sanitizeSafeUrl(rawUrl, fallbackUrl = PROFILE_DEFAULT_AVATAR) {
        const val = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        if (!val) return fallbackUrl;
        if (/^https?:\/\//i.test(val)) return val;
        if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(val)) return val;
        return fallbackUrl;
    }

    /**
     * 🎨 外觀裝飾品目錄（支援預設解鎖 + 進階成就 / 寶箱解鎖）
     */
    const PROFILE_COSMETIC_CATALOG = {
        frames: [
            {
                id: 'default',
                nameKey: 'cosFrameDefault',
                name: '極簡銀環',
                desc: '清爽純淨的預設邊框',
                ringClass: 'ring-2 ring-slate-300 dark:ring-slate-600',
                previewDot: 'bg-slate-400',
                defaultUnlocked: true
            },
            {
                id: 'emerald_sprout',
                nameKey: 'cosFrameEmerald',
                name: '翠綠新芽',
                desc: '象徵每日穩定成長的學習能量',
                ringClass: 'ring-[3px] ring-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.55)]',
                previewDot: 'bg-emerald-500',
                defaultUnlocked: true
            },
            {
                id: 'brand_indigo',
                nameKey: 'cosFrameIndigo',
                name: '星辰靛藍',
                desc: '閃耀專注光芒的質感藍環',
                ringClass: 'ring-[3px] ring-brand-500 shadow-[0_0_14px_rgba(99,102,241,0.6)]',
                previewDot: 'bg-brand-500',
                defaultUnlocked: true
            },
            {
                id: 'amber_scholar',
                nameKey: 'cosFrameAmber',
                name: '琥珀學者',
                desc: '掌握 30 個單字或達 Lv.3 自動解鎖',
                ringClass: 'ring-[3px] ring-amber-400 shadow-[0_0_16px_rgba(245,158,11,0.65)]',
                previewDot: 'bg-amber-400',
                defaultUnlocked: false,
                unlockHint: '掌握 30 字或達 Lv.3 解鎖'
            },
            {
                id: 'cyber_neon',
                nameKey: 'cosFrameNeon',
                name: '霓虹脈衝',
                desc: '連續學習 7 天或寶箱開啟解鎖',
                ringClass: 'ring-[3px] ring-fuchsia-500 shadow-[0_0_16px_rgba(217,70,239,0.65)]',
                previewDot: 'bg-fuchsia-500',
                defaultUnlocked: false,
                unlockHint: '連勝 7 天或每日寶箱解鎖'
            },
            {
                id: 'royal_flame',
                nameKey: 'cosFrameFlame',
                name: '緋紅戰神',
                desc: '排位對戰或高階成就解鎖',
                ringClass: 'ring-[3px] ring-rose-500 shadow-[0_0_18px_rgba(244,63,94,0.75)]',
                previewDot: 'bg-rose-500',
                defaultUnlocked: false,
                unlockHint: '對戰勝場或黃金段位解鎖'
            }
        ],
        banners: [
            {
                id: 'default',
                nameKey: 'cosBannerDefault',
                name: '靛紫星圖',
                desc: '經典品牌藍紫漸層背景',
                bannerClass: 'bg-gradient-to-r from-brand-600 via-indigo-600 to-purple-600',
                defaultUnlocked: true
            },
            {
                id: 'aurora_mint',
                nameKey: 'cosBannerAurora',
                name: '極光森林',
                desc: '沉穩清新的翡翠青綠漸層',
                bannerClass: 'bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-600',
                defaultUnlocked: true
            },
            {
                id: 'sunset_amber',
                nameKey: 'cosBannerSunset',
                name: '晨曦落日',
                desc: '充滿熱血動力的金橘暮色',
                bannerClass: 'bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500',
                defaultUnlocked: true
            },
            {
                id: 'midnight_cosmos',
                nameKey: 'cosBannerCosmos',
                name: '深空星雲',
                desc: '掌握 50 個單字或達 Lv.5 解鎖',
                bannerClass: 'bg-gradient-to-r from-slate-900 via-purple-900 to-indigo-900',
                defaultUnlocked: false,
                unlockHint: '掌握 50 字或達 Lv.5 解鎖'
            },
            {
                id: 'sakura_dawn',
                nameKey: 'cosBannerSakura',
                name: '櫻吹初曉',
                desc: '透過學習寶箱或賽季獎勵解鎖',
                bannerClass: 'bg-gradient-to-r from-pink-500 via-rose-400 to-amber-300',
                defaultUnlocked: false,
                unlockHint: '每日寶箱或賽季獎勵解鎖'
            }
        ],
        titles: [
            {
                id: 'newcomer',
                nameKey: 'cosTitleNewcomer',
                name: '初探詞海',
                badgeClass: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700',
                icon: '🌱',
                defaultUnlocked: true
            },
            {
                id: 'daily_grinder',
                nameKey: 'cosTitleGrinder',
                name: '晨昏刷卡人',
                badgeClass: 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 border-brand-200 dark:border-brand-800',
                icon: '📘',
                defaultUnlocked: true
            },
            {
                id: 'vocab_collector',
                nameKey: 'cosTitleCollector',
                name: '單字收藏家',
                badgeClass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
                icon: '💎',
                defaultUnlocked: true
            },
            {
                id: 'streak_keeper',
                nameKey: 'cosTitleStreak',
                name: '不滅連勝者',
                badgeClass: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800',
                icon: '🔥',
                defaultUnlocked: false,
                unlockHint: '連勝 7 天自動解鎖'
            },
            {
                id: 'gsat_challenger',
                nameKey: 'cosTitleGsat',
                name: '七千征戰者',
                badgeClass: 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200 dark:border-purple-800',
                icon: '👑',
                defaultUnlocked: false,
                unlockHint: '掌握 100 字自動解鎖'
            },
            {
                id: 'abyss_slayer',
                nameKey: 'cosTitleAbyss',
                name: '深淵征服者',
                badgeClass: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800',
                icon: '⚔️',
                defaultUnlocked: false,
                unlockHint: '對戰或深淵試煉解鎖'
            }
        ]
    };

    function getFrameMeta(frameId) {
        return PROFILE_COSMETIC_CATALOG.frames.find(f => f.id === frameId) || PROFILE_COSMETIC_CATALOG.frames[0];
    }

    function getBannerMeta(bannerId) {
        return PROFILE_COSMETIC_CATALOG.banners.find(b => b.id === bannerId) || PROFILE_COSMETIC_CATALOG.banners[0];
    }

    function getTitleMeta(titleId) {
        return PROFILE_COSMETIC_CATALOG.titles.find(item => item.id === titleId) || PROFILE_COSMETIC_CATALOG.titles[0];
    }

    function getCurrentAuthUser() {
        if (typeof firebase !== 'undefined' && firebase.auth) {
            return firebase.auth().currentUser || null;
        }
        return null;
    }

    function isProfileGuest() {
        if (typeof isGuestUser === 'function') return isGuestUser();
        return !getCurrentAuthUser() || localStorage.getItem('lzhcard_guest_mode') === 'true';
    }

    /**
     * 🛡️ 初始化並確保 window.userData 擁有乾淨預設值
     */
    function ensureUserProfileDefaults() {
        if (!global.userData) global.userData = {};
        const u = global.userData;

        if (typeof u.bio !== 'string') u.bio = '';

        if (!u.cosmetics || typeof u.cosmetics !== 'object') {
            u.cosmetics = {};
        }
        if (!u.cosmetics.frame) u.cosmetics.frame = 'default';
        if (!u.cosmetics.banner) u.cosmetics.banner = 'default';
        if (!u.cosmetics.title) u.cosmetics.title = 'newcomer';
        if (!Array.isArray(u.cosmetics.unlockedFrames)) u.cosmetics.unlockedFrames = [];
        if (!Array.isArray(u.cosmetics.unlockedBanners)) u.cosmetics.unlockedBanners = [];
        if (!Array.isArray(u.cosmetics.unlockedTitles)) u.cosmetics.unlockedTitles = [];

        if (!u.privacy || typeof u.privacy !== 'object') {
            u.privacy = {};
        }
        if (typeof u.privacy.isStatsPublic !== 'boolean') {
            u.privacy.isStatsPublic = true;
        }

        if (!u.progression || typeof u.progression !== 'object') {
            u.progression = {};
        }
        if (!Number.isFinite(Number(u.progression.xp))) u.progression.xp = 0;
        if (!Number.isFinite(Number(u.progression.level)) || Number(u.progression.level) < 1) {
            u.progression.level = Math.max(1, Math.floor(Math.sqrt((Number(u.progression.xp) || 0) / 50)) + 1);
        }
        if (!Number.isFinite(Number(u.progression.streakDays))) u.progression.streakDays = 0;
        const rawShields = Number(u.progression.streakShields);
        u.progression.streakShields = Number.isFinite(rawShields) ? Math.min(3, Math.max(0, Math.floor(rawShields))) : 0;
        if (typeof u.progression.lastActiveDate !== 'string') u.progression.lastActiveDate = '';
        if (typeof u.progression.rankTier !== 'string' || !u.progression.rankTier) {
            u.progression.rankTier = '青銅 III';
        }
        if (!Number.isFinite(Number(u.progression.rankPoints))) u.progression.rankPoints = 0;
        if (!Number.isFinite(Number(u.progression.duelWins))) u.progression.duelWins = 0;
        if (!Number.isFinite(Number(u.progression.duelTotal))) u.progression.duelTotal = 0;

        return u;
    }

    /**
     * 📊 計算本人即時學習統計（從 local wordList 與 progression 結合）
     */
    function computeMyLearningStats() {
        const u = ensureUserProfileDefaults();
        const words = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        const totalWords = words.length;
        const masteredCount = words.filter(w => w && (Number(w.level) || 1) >= 4).length;

        const authUser = getCurrentAuthUser();
        const uid = authUser ? authUser.uid : (u.uid || '');
        const nickname = u.nickname || u.username || '';

        const decks = Array.isArray(global.storeDecks) ? global.storeDecks : [];
        const myStoreDecks = decks.filter(d =>
            (uid && d.authorId === uid) ||
            (!uid && nickname && d.author === nickname)
        );
        const totalStoreDownloads = myStoreDecks.reduce((sum, d) => sum + (Number(d.downloads ?? d.downloadCount) || 0), 0);
        const totalStoreViews = myStoreDecks.reduce((sum, d) => sum + (Number(d.views) || 0), 0);
        const authorReputation = totalStoreDownloads * 5 + totalStoreViews;

        const prog = u.progression;
        const level = Math.max(1, Number(prog.level) || 1);
        const xp = Math.max(0, Number(prog.xp) || 0);
        const prevLevelXp = Math.pow(level - 1, 2) * 50;
        const nextLevelXp = Math.pow(level, 2) * 50;
        const span = Math.max(50, nextLevelXp - prevLevelXp);
        const currentLevelXp = Math.max(0, xp - prevLevelXp);
        const xpPct = Math.min(100, Math.round((currentLevelXp / span) * 100));

        const duelWins = Math.max(0, Number(prog.duelWins) || 0);
        const duelTotal = Math.max(0, Number(prog.duelTotal) || 0);
        const duelWinRate = duelTotal > 0 ? Math.round((duelWins / duelTotal) * 100) : 0;

        return {
            totalWords,
            masteredCount,
            streakDays: Math.max(0, Number(prog.streakDays) || 0),
            streakShields: Math.min(3, Math.max(0, Number(prog.streakShields) || 0)),
            lastActiveDate: typeof prog.lastActiveDate === 'string' ? prog.lastActiveDate : '',
            rankTier: prog.rankTier || '青銅 III',
            rankPoints: Math.max(0, Number(prog.rankPoints) || 0),
            duelWins,
            duelTotal,
            duelWinRate,
            level,
            xp,
            currentLevelXp,
            span,
            xpPct,
            publishedDecksCount: myStoreDecks.length,
            totalStoreDownloads,
            totalStoreViews,
            authorReputation
        };
    }

    /**
     * 🔓 判斷指定飾品是否已解鎖（含預設與自動里程碑解鎖）
     */
    function isCosmeticUnlocked(type, itemId, userData = global.userData, stats = null) {
        const catalogList = PROFILE_COSMETIC_CATALOG[type] || [];
        const meta = catalogList.find(item => item.id === itemId);
        if (!meta) return false;
        if (meta.defaultUnlocked) return true;

        const cos = userData?.cosmetics || {};
        const computedStats = stats || computeMyLearningStats();

        if (type === 'frames') {
            if (Array.isArray(cos.unlockedFrames) && cos.unlockedFrames.includes(itemId)) return true;
            if (itemId === 'amber_scholar' && (computedStats.masteredCount >= 30 || computedStats.level >= 3)) return true;
            if (itemId === 'cyber_neon' && computedStats.streakDays >= 7) return true;
            if (itemId === 'royal_flame' && (computedStats.duelWins >= 3 || computedStats.rankPoints >= 450)) return true;
        } else if (type === 'banners') {
            if (Array.isArray(cos.unlockedBanners) && cos.unlockedBanners.includes(itemId)) return true;
            if (itemId === 'midnight_cosmos' && (computedStats.masteredCount >= 50 || computedStats.level >= 5)) return true;
            if (itemId === 'sakura_dawn' && (computedStats.rankPoints >= 300 || computedStats.streakDays >= 14)) return true;
        } else if (type === 'titles') {
            if (Array.isArray(cos.unlockedTitles) && cos.unlockedTitles.includes(itemId)) return true;
            if (itemId === 'streak_keeper' && computedStats.streakDays >= 7) return true;
            if (itemId === 'gsat_challenger' && computedStats.masteredCount >= 100) return true;
            if (itemId === 'abyss_slayer' && computedStats.duelWins >= 5) return true;
        }

        return false;
    }

    function getMyDisplayIdentity() {
        const u = ensureUserProfileDefaults();
        const authUser = getCurrentAuthUser();
        const defaultAvatar = authUser
            ? `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authUser.uid)}`
            : PROFILE_DEFAULT_AVATAR;

        const nickname = u.nickname
            || (authUser ? (authUser.displayName || (authUser.email ? authUser.email.split('@')[0] : '')) : '')
            || (isProfileGuest() ? profileTr('guestMode', '訪客玩家') : profileTr('defaultPlayerName', '玩家'));

        const avatar = sanitizeSafeUrl((authUser && authUser.photoURL) || u.photoURL || defaultAvatar, defaultAvatar);
        return {
            uid: authUser ? authUser.uid : (u.uid || ''),
            nickname,
            avatar,
            bio: u.bio || '',
            cosmetics: {
                frame: u.cosmetics.frame || 'default',
                banner: u.cosmetics.banner || 'default',
                title: u.cosmetics.title || 'newcomer'
            },
            isStatsPublic: u.privacy?.isStatsPublic !== false
        };
    }

    /**
     * 💍 套用頭像外框至底部導覽列與抽屜頭像
     */
    function applyNavAvatarFrame() {
        const u = ensureUserProfileDefaults();
        const frameMeta = getFrameMeta(u.cosmetics.frame || 'default');
        const navAvatar = document.getElementById('nav-avatar');
        const drawerAvatar = document.getElementById('settings-avatar');

        if (navAvatar) {
            navAvatar.className = `w-5 h-5 rounded-full object-cover transition-all ${frameMeta.ringClass}`;
        }
        if (drawerAvatar) {
            drawerAvatar.className = `w-12 h-12 rounded-full object-cover transition-all ${frameMeta.ringClass}`;
        }
    }

    /**
     * ☁️ 建立同步至 publicProfiles/{uid} 的公開檔案資料
     */
    function buildMyPublicProfilePayload() {
        const identity = getMyDisplayIdentity();
        const stats = computeMyLearningStats();
        const u = ensureUserProfileDefaults();

        const publicStats = identity.isStatsPublic
            ? {
                hidden: false,
                masteredCount: stats.masteredCount,
                totalWords: stats.totalWords,
                streakDays: stats.streakDays,
                streakShields: stats.streakShields,
                rankTier: stats.rankTier,
                rankPoints: stats.rankPoints,
                duelWins: stats.duelWins,
                duelTotal: stats.duelTotal,
                duelWinRate: stats.duelWinRate,
                level: stats.level,
                xp: stats.xp,
                authorReputation: stats.authorReputation,
                publishedDecksCount: stats.publishedDecksCount
            }
            : {
                hidden: true
            };

        return {
            uid: identity.uid,
            nickname: identity.nickname,
            avatar: identity.avatar,
            bio: identity.bio,
            role: u.role || 'user',
            cosmetics: {
                frame: identity.cosmetics.frame,
                banner: identity.cosmetics.banner,
                title: identity.cosmetics.title
            },
            isStatsPublic: identity.isStatsPublic,
            stats: publicStats,
            updatedAtMs: Date.now()
        };
    }

    /**
     * ☁️ 同步個人公開檔案至 Firestore publicProfiles/{uid} 與本機快取
     */
    async function syncMyPublicProfile(immediate = false) {
        const authUser = getCurrentAuthUser();
        applyNavAvatarFrame();

        if (!authUser || isProfileGuest()) return false;

        const doSync = async () => {
            try {
                const payload = buildMyPublicProfilePayload();
                if (!payload.uid) return false;

                try {
                    localStorage.setItem(`${LOCAL_PROFILE_CACHE_PREFIX}${payload.uid}`, JSON.stringify(payload));
                } catch (err) {}

                if (typeof db !== 'undefined' && db) {
                    const firestorePayload = {
                        ...payload,
                        updatedAt: (typeof firebase !== 'undefined' && firebase.firestore?.FieldValue?.serverTimestamp)
                            ? firebase.firestore.FieldValue.serverTimestamp()
                            : Date.now()
                    };
                    await db.collection('publicProfiles').doc(authUser.uid).set(firestorePayload);
                }

                if (typeof writeCurrentUserOnlineStatus === 'function') {
                    writeCurrentUserOnlineStatus();
                }
                return true;
            } catch (e) {
                console.warn('同步公開檔案失敗：', e);
                return false;
            }
        };

        if (immediate) {
            if (profileSyncDebounceTimer) {
                clearTimeout(profileSyncDebounceTimer);
                profileSyncDebounceTimer = null;
            }
            return doSync();
        }

        if (profileSyncDebounceTimer) clearTimeout(profileSyncDebounceTimer);
        profileSyncDebounceTimer = setTimeout(() => {
            profileSyncDebounceTimer = null;
            doSync();
        }, 600);
        return true;
    }

    /**
     * 渲染個人檔案主頁面 (#sec-profile)
     */
    function renderProfileSection() {
        const root = document.getElementById('profileRootContainer');
        if (!root) return;

        const u = ensureUserProfileDefaults();
        const identity = getMyDisplayIdentity();
        const stats = computeMyLearningStats();
        const isGuest = isProfileGuest();

        const frameMeta = getFrameMeta(identity.cosmetics.frame);
        const bannerMeta = getBannerMeta(identity.cosmetics.banner);
        const titleMeta = getTitleMeta(identity.cosmetics.title);

        const safeName = escapeProfileHTML(identity.nickname);
        const safeBio = escapeProfileHTML(identity.bio || profileTr('profileBioEmpty', '尚未設定學測目標或個人簡介，寫下一句激勵自己的話吧！'));
        const safeAvatar = escapeProfileHTML(identity.avatar);

        // 篩選當前客製化分頁項目
        let cosmeticItemsHtml = '';
        if (currentCustomizerTab === 'frames') {
            cosmeticItemsHtml = PROFILE_COSMETIC_CATALOG.frames.map(item => {
                const unlocked = isCosmeticUnlocked('frames', item.id, u, stats);
                const selected = identity.cosmetics.frame === item.id;
                return `
                    <button type="button" onclick="selectProfileCosmetic('frames', '${item.id}')"
                        class="p-3 rounded-xl border text-left transition flex items-center gap-3 ${selected
                            ? 'bg-brand-50 dark:bg-brand-950/50 border-brand-500 ring-2 ring-brand-500/30'
                            : 'bg-slate-50 dark:bg-slate-900/70 border-slate-200 dark:border-slate-700 hover:border-brand-300'} ${unlocked ? 'cursor-pointer' : 'opacity-70'}">
                        <div class="w-10 h-10 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center shrink-0 ${item.ringClass}">
                            <span class="w-3.5 h-3.5 rounded-full ${item.previewDot}"></span>
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center justify-between gap-1">
                                <span class="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">${escapeProfileHTML(item.name)}</span>
                                ${selected
                                    ? `<span class="text-[10px] font-bold text-brand-600 dark:text-brand-400 shrink-0">✓ ${escapeProfileHTML(profileTr('badgeEquipped', '裝備中'))}</span>`
                                    : (!unlocked ? `<span class="text-[10px] text-amber-600 dark:text-amber-400 shrink-0"><i class="fa-solid fa-lock"></i></span>` : '')}
                            </div>
                            <p class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">${escapeProfileHTML(unlocked ? item.desc : (item.unlockHint || item.desc))}</p>
                        </div>
                    </button>
                `;
            }).join('');
        } else if (currentCustomizerTab === 'banners') {
            cosmeticItemsHtml = PROFILE_COSMETIC_CATALOG.banners.map(item => {
                const unlocked = isCosmeticUnlocked('banners', item.id, u, stats);
                const selected = identity.cosmetics.banner === item.id;
                return `
                    <button type="button" onclick="selectProfileCosmetic('banners', '${item.id}')"
                        class="p-2.5 rounded-xl border text-left transition space-y-2 ${selected
                            ? 'bg-brand-50 dark:bg-brand-950/50 border-brand-500 ring-2 ring-brand-500/30'
                            : 'bg-slate-50 dark:bg-slate-900/70 border-slate-200 dark:border-slate-700 hover:border-brand-300'} ${unlocked ? 'cursor-pointer' : 'opacity-70'}">
                        <div class="h-10 w-full rounded-lg ${item.bannerClass} relative overflow-hidden">
                            ${!unlocked ? '<div class="absolute inset-0 bg-slate-900/45 flex items-center justify-center text-white text-xs"><i class="fa-solid fa-lock"></i></div>' : ''}
                        </div>
                        <div class="flex items-center justify-between gap-1">
                            <span class="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">${escapeProfileHTML(item.name)}</span>
                            ${selected ? `<span class="text-[10px] font-bold text-brand-600 dark:text-brand-400">✓</span>` : ''}
                        </div>
                        <p class="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">${escapeProfileHTML(unlocked ? item.desc : (item.unlockHint || item.desc))}</p>
                    </button>
                `;
            }).join('');
        } else {
            cosmeticItemsHtml = PROFILE_COSMETIC_CATALOG.titles.map(item => {
                const unlocked = isCosmeticUnlocked('titles', item.id, u, stats);
                const selected = identity.cosmetics.title === item.id;
                return `
                    <button type="button" onclick="selectProfileCosmetic('titles', '${item.id}')"
                        class="p-3 rounded-xl border text-left transition flex items-center justify-between gap-2 ${selected
                            ? 'bg-brand-50 dark:bg-brand-950/50 border-brand-500 ring-2 ring-brand-500/30'
                            : 'bg-slate-50 dark:bg-slate-900/70 border-slate-200 dark:border-slate-700 hover:border-brand-300'} ${unlocked ? 'cursor-pointer' : 'opacity-70'}">
                        <div class="min-w-0">
                            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${item.badgeClass}">
                                <span>${item.icon}</span>
                                <span>${escapeProfileHTML(item.name)}</span>
                            </span>
                            <p class="text-[10px] text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-1">${escapeProfileHTML(unlocked ? profileTr('cosTitleUnlockedDesc', '點擊立即配戴展示於名片') : (item.unlockHint || ''))}</p>
                        </div>
                        ${selected
                            ? `<span class="text-[10px] font-bold text-brand-600 dark:text-brand-400 shrink-0">✓</span>`
                            : (!unlocked ? `<span class="text-xs text-amber-500 shrink-0"><i class="fa-solid fa-lock"></i></span>` : '')}
                    </button>
                `;
            }).join('');
        }

        const authEmail = getCurrentAuthUser()?.email || '';

        root.innerHTML = `
            <!-- 頂部工具列：快速打開左側設定抽屜 / 預覽公開名片 -->
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 class="text-xl font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                        <span>${escapeProfileHTML(profileTr('profilePageTitle', '個人檔案與成就'))}</span>
                    </h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400">${escapeProfileHTML(profileTr('profilePageDesc', '自訂個人名片外觀、學測宣言，並查看學習統計與社群聲望'))}</p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    ${identity.uid && !isGuest ? `
                        <button type="button" onclick="shareUserProfile()"
                            class="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:hover:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer">
                            <i class="fa-solid fa-share-nodes"></i>
                            <span>${escapeProfileHTML(profileTr('btnShareProfile', '分享個人檔案'))}</span>
                        </button>
                    ` : ''}
                    ${identity.uid ? `
                        <button type="button" onclick="openPlayerProfileModal('${escapeProfileHTML(identity.uid)}', '${encodeURIComponent(identity.nickname)}')"
                            class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer">
                            <i class="fa-regular fa-id-card text-brand-500"></i>
                            <span>${escapeProfileHTML(profileTr('btnPreviewPublicCard', '預覽我的公開名片'))}</span>
                        </button>
                    ` : ''}
                    <button type="button" onclick="openSettingsDrawer()"
                        class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold shadow-xs transition flex items-center gap-1.5 cursor-pointer">
                        <i class="fa-solid fa-sliders"></i>
                        <span>${escapeProfileHTML(profileTr('btnOpenSettingsDrawer', '系統設定'))}</span>
                    </button>
                </div>
            </div>

            <!-- 英雄名片卡片（橫幅 + 頭像外框 + 稱號 + 等級 XP + 宣言） -->
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div class="h-28 sm:h-32 ${bannerMeta.bannerClass} relative p-4 flex items-start justify-between">
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/25 backdrop-blur-xs text-white text-[11px] font-bold">
                        <i class="fa-solid fa-shield-halved text-amber-300"></i>
                        <span>Lv.${stats.level} · ${escapeProfileHTML(stats.rankTier)}</span>
                    </div>
                    ${u.role === 'admin' ? `
                        <span class="px-2.5 py-1 rounded-full bg-rose-600/90 text-white text-[10px] font-black shadow-xs">👑 管理員</span>
                    ` : ''}
                </div>

                <div class="px-5 pb-5">
                    <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3 -mt-10 relative z-10">
                        <div class="flex items-end gap-3.5">
                            <img id="profileHeroAvatar" src="${safeAvatar}" alt="Avatar"
                                class="w-20 h-20 rounded-full bg-white dark:bg-slate-900 object-cover ${frameMeta.ringClass}">
                            <div class="pb-1 min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 id="profileDisplayName" class="text-lg font-extrabold text-slate-900 dark:text-white truncate">${safeName}</h3>
                                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${titleMeta.badgeClass}">
                                        <span>${titleMeta.icon}</span>
                                        <span>${escapeProfileHTML(titleMeta.name)}</span>
                                    </span>
                                </div>
                                <p class="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                                    ${isGuest ? escapeProfileHTML(profileTr('guestMode', '訪客模式（登入後解鎖公開名片與同步）')) : escapeProfileHTML(authEmail || `UID: ${identity.uid}`)}
                                </p>
                            </div>
                        </div>

                        ${isGuest ? `
                            <button type="button" onclick="loginWithGoogle()" class="px-3.5 py-2 bg-white dark:bg-slate-900 hover:bg-slate-50 border border-slate-300 dark:border-slate-600 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-2 shadow-2xs self-start sm:self-end cursor-pointer">
                                <i class="fa-brands fa-google text-red-500"></i>
                                <span>${escapeProfileHTML(profileTr('btnLoginGoogle', '使用 Google 帳號登入'))}</span>
                            </button>
                        ` : ''}
                    </div>

                    <!-- XP 進度條 -->
                    <div class="mt-4 space-y-1">
                        <div class="flex items-center justify-between text-[11px] font-bold">
                            <span class="text-slate-600 dark:text-slate-300">✨ 冒險者經驗值 (Lv.${stats.level})</span>
                            <span class="text-brand-600 dark:text-brand-400 font-mono">${stats.currentLevelXp} / ${stats.span} XP</span>
                        </div>
                        <div class="w-full h-2 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                            <div class="h-full bg-gradient-to-r from-brand-500 to-purple-500 rounded-full transition-all duration-300" style="width: ${stats.xpPct}%"></div>
                        </div>
                    </div>

                    <!-- 個人簡介顯示 -->
                    <div class="mt-4 p-3.5 bg-slate-50 dark:bg-slate-900/70 rounded-xl border border-slate-100 dark:border-slate-700">
                        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">${escapeProfileHTML(profileTr('lblProfileBioDisplay', '🎯 個人簡介 / 學測目標宣言'))}</div>
                        <p class="text-xs text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">${safeBio}</p>
                    </div>
                </div>
            </div>

            <!-- 個人公開學習統計卡 -->
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-2xs space-y-3">
                <div class="flex items-center justify-between gap-2">
                    <h3 class="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                        <i class="fa-solid fa-trophy text-amber-500"></i>
                        <span>${escapeProfileHTML(profileTr('profileStatsTitle', '學習戰績與榮譽面板'))}</span>
                    </h3>
                    <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${identity.isStatsPublic
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}">
                        ${identity.isStatsPublic ? '🌐 公開展示中' : '🔒 已設為僅自己可見'}
                    </span>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div class="p-3 bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50 rounded-xl">
                        <div class="text-[11px] text-emerald-700 dark:text-emerald-400 font-bold">${escapeProfileHTML(profileTr('statMasteredWords', '已掌握單字 (Lv.4+)'))}</div>
                        <div class="text-xl font-black text-slate-900 dark:text-white mt-1">${stats.masteredCount} <span class="text-xs font-semibold text-slate-400">/ ${stats.totalWords}</span></div>
                    </div>
                    <div class="p-3 bg-amber-50/70 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/50 rounded-xl flex flex-col justify-between gap-1.5">
                        <div>
                            <div class="text-[11px] text-amber-700 dark:text-amber-400 font-bold flex items-center justify-between gap-1">
                                <span>${escapeProfileHTML(profileTr('statStreakDays', '連續學習天數'))}</span>
                                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300 font-extrabold" title="漏學 1 天時自動消耗護盾保護連勝紀錄">🛡️ ${stats.streakShields}/3</span>
                            </div>
                            <div class="text-xl font-black text-slate-900 dark:text-white mt-1">🔥 ${stats.streakDays} <span class="text-xs font-semibold text-slate-400">天</span></div>
                        </div>
                        ${stats.streakShields < 3 ? `
                            <button type="button" onclick="if(typeof GameEngine!=='undefined' && GameEngine.buyStreakShield) GameEngine.buyStreakShield();" class="w-full py-1 px-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[10px] font-bold transition cursor-pointer">
                                🛡️ 購買護盾 (80 幣)
                            </button>
                        ` : `<div class="text-[10px] font-bold text-sky-600 dark:text-sky-400">🛡️ 護盾已滿格保護中</div>`}
                    </div>
                    <div class="p-3 bg-brand-50/70 dark:bg-brand-950/30 border border-brand-100 dark:border-brand-900/50 rounded-xl">
                        <div class="text-[11px] text-brand-700 dark:text-brand-400 font-bold">${escapeProfileHTML(profileTr('statDuelWinRate', '對戰勝率'))}</div>
                        <div class="text-xl font-black text-slate-900 dark:text-white mt-1">${stats.duelWinRate}% <span class="text-xs font-semibold text-slate-400">(${stats.duelWins}/${stats.duelTotal})</span></div>
                    </div>
                    <div class="p-3 bg-purple-50/70 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/50 rounded-xl">
                        <div class="text-[11px] text-purple-700 dark:text-purple-400 font-bold">${escapeProfileHTML(profileTr('statAuthorRep', '商店作品 / 聲望'))}</div>
                        <div class="text-xl font-black text-slate-900 dark:text-white mt-1">${stats.publishedDecksCount} <span class="text-xs font-semibold text-slate-400">作 · ★${stats.authorReputation}</span></div>
                    </div>
                </div>
            </div>

            <!-- 編輯暱稱與目標宣言 -->
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-2xs space-y-4">
                <div class="border-b border-slate-100 dark:border-slate-700 pb-2.5">
                    <h3 class="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                        <i class="fa-solid fa-pen-nib text-brand-500"></i>
                        <span>${escapeProfileHTML(profileTr('profileEditTitle', '編輯個人名片資料'))}</span>
                    </h3>
                </div>

                <div class="space-y-3">
                    <div>
                        <label for="profileNicknameInput" class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1" data-i18n="lblNickname">${escapeProfileHTML(profileTr('lblNickname', '個人固定暱稱 (用於發布字庫與社群)'))}</label>
                        <input type="text" id="profileNicknameInput" maxlength="24" value="${escapeProfileHTML(u.nickname || identity.nickname)}"
                            data-i18n-placeholder="phNicknameInput" placeholder="設定您的固定暱稱..."
                            class="w-full px-3.5 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-100 font-semibold outline-none focus:ring-2 focus:ring-brand-500">
                    </div>

                    <div>
                        <div class="flex items-center justify-between mb-1">
                            <label for="profileBioInput" class="block text-xs font-bold text-slate-700 dark:text-slate-200">${escapeProfileHTML(profileTr('lblProfileBio', '個人簡介 / 學測目標宣言'))}</label>
                            <span id="profileBioCounter" class="text-[10px] text-slate-400 font-mono">${(u.bio || '').length}/140</span>
                        </div>
                        <textarea id="profileBioInput" rows="2" maxlength="140"
                            oninput="var c=document.getElementById('profileBioCounter');if(c)c.textContent=this.value.length+'/140';"
                            placeholder="${escapeProfileHTML(profileTr('phProfileBio', '例如：115 學測英文 15 級分！每天穩刷 50 個 7000 單 🔥'))}"
                            class="w-full px-3.5 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:ring-brand-500">${escapeProfileHTML(u.bio || '')}</textarea>
                    </div>

                    <div class="flex justify-end">
                        <button type="button" onclick="saveProfileBasicInfo()"
                            class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs transition shadow-xs flex items-center gap-1.5 cursor-pointer">
                            <i class="fa-solid fa-floppy-disk"></i>
                            <span>${escapeProfileHTML(profileTr('btnSaveProfileInfo', '儲存個人檔案'))}</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- 個人檔案外觀客製化 (頭像外框 / 橫幅 / 稱號) -->
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-2xs space-y-4">
                <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700 pb-3">
                    <div>
                        <h3 class="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                            <i class="fa-solid fa-wand-magic-sparkles text-purple-500"></i>
                            <span>${escapeProfileHTML(profileTr('profileCosmeticsTitle', '名片外觀自訂櫃'))}</span>
                        </h3>
                        <p class="text-[11px] text-slate-400">${escapeProfileHTML(profileTr('profileCosmeticsDesc', '即時套用並同步顯示於聊天室與商店作者名片'))}</p>
                    </div>
                    <div class="inline-flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold">
                        <button type="button" onclick="switchProfileCustomizerTab('frames')" class="px-2.5 py-1 rounded-lg transition cursor-pointer ${currentCustomizerTab === 'frames' ? 'bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-2xs' : 'text-slate-500'}">頭像外框</button>
                        <button type="button" onclick="switchProfileCustomizerTab('banners')" class="px-2.5 py-1 rounded-lg transition cursor-pointer ${currentCustomizerTab === 'banners' ? 'bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-2xs' : 'text-slate-500'}">個人橫幅</button>
                        <button type="button" onclick="switchProfileCustomizerTab('titles')" class="px-2.5 py-1 rounded-lg transition cursor-pointer ${currentCustomizerTab === 'titles' ? 'bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-2xs' : 'text-slate-500'}">稱號徽章</button>
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    ${cosmeticItemsHtml}
                </div>
            </div>
        `;
    }

    function switchProfileCustomizerTab(tab) {
        if (!['frames', 'banners', 'titles'].includes(tab)) return;
        currentCustomizerTab = tab;
        renderProfileSection();
    }

    async function selectProfileCosmetic(type, itemId) {
        const u = ensureUserProfileDefaults();
        const stats = computeMyLearningStats();
        if (!isCosmeticUnlocked(type, itemId, u, stats)) {
            const catalog = PROFILE_COSMETIC_CATALOG[type] || [];
            const item = catalog.find(x => x.id === itemId);
            if (typeof global.showToast === 'function') {
                global.showToast(`🔒 尚未解鎖「${item?.name || itemId}」：${item?.unlockHint || '完成學習成就後解鎖'}`, 'warning');
            }
            return;
        }

        if (type === 'frames') u.cosmetics.frame = itemId;
        else if (type === 'banners') u.cosmetics.banner = itemId;
        else if (type === 'titles') u.cosmetics.title = itemId;

        renderProfileSection();
        applyNavAvatarFrame();

        if (typeof global.saveUserData === 'function') {
            await global.saveUserData();
        }
        await syncMyPublicProfile(true);

        if (typeof global.showToast === 'function') {
            global.showToast(profileTr('toastCosmeticApplied', '✨ 已套用新外觀並同步至公開名片！'), 'success');
        }
    }

    async function saveProfileBasicInfo() {
        const nickInput = document.getElementById('profileNicknameInput');
        const bioInput = document.getElementById('profileBioInput');

        const newNickname = (nickInput?.value || '').trim();
        const newBio = (bioInput?.value || '').trim().slice(0, 140);

        if (!newNickname) {
            if (typeof global.showToast === 'function') global.showToast(profileTr('toastNicknameEmpty', '暱稱不能為空！'), 'warning');
            return false;
        }

        const authUser = getCurrentAuthUser();
        if (!authUser || isProfileGuest()) {
            if (typeof global.showToast === 'function') {
                global.showToast(profileTr('toastLoginRequiredProfile', '訪客模式無法綁定雲端個人檔案，請先登入帳號！'), 'warning');
            }
            return false;
        }

        const u = ensureUserProfileDefaults();
        u.nickname = newNickname;
        u.username = newNickname;
        u.bio = newBio;

        const emailEl = document.getElementById('settings-email');
        if (emailEl) emailEl.innerText = newNickname;

        const legacyNickInput = document.getElementById('settingsNicknameInput');
        if (legacyNickInput) legacyNickInput.value = newNickname;

        try {
            if (typeof db !== 'undefined' && db) {
                await db.collection('users').doc(authUser.uid).set({
                    nickname: newNickname,
                    bio: newBio,
                    email: authUser.email || '',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }

            await syncMyPublicProfile(true);
            renderProfileSection();

            if (typeof global.showToast === 'function') {
                global.showToast(profileTr('toastProfileSaved', '🎉 個人檔案與宣言已成功儲存！'), 'success');
            }
            return true;
        } catch (err) {
            console.error('儲存個人檔案失敗：', err);
            if (typeof global.showToast === 'function') {
                global.showToast('儲存個人檔案失敗：' + err.message, 'error');
            }
            return false;
        }
    }

    async function copyTextSafe(text) {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (e) {}
        }
        if (typeof document !== 'undefined') {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (ok) return true;
            } catch (e) {}
        }
        return false;
    }

    async function shareUserProfile() {
        const authUser = getCurrentAuthUser();
        if (!authUser || !authUser.uid || isProfileGuest()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號即可分享您的專屬個人檔案連結！', 'warning');
            }
            return false;
        }

        const uid = authUser.uid;
        const shareUrl = `${window.location.origin}${window.location.pathname}?profile=${encodeURIComponent(uid)}`;
        const u = ensureUserProfileDefaults();
        const displayName = u.nickname || authUser.displayName || 'LZHCard 學習者';

        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
            try {
                await navigator.share({
                    title: `${displayName} 的 LZHCard 學習名片`,
                    text: `來看看 ${displayName} 在 LZHCard 的單字學習進度與成就！`,
                    url: shareUrl
                });
                return true;
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    return false;
                }
            }
        }

        const copied = await copyTextSafe(shareUrl);
        if (typeof global.showToast === 'function') {
            global.showToast(
                copied ? '已複製個人檔案連結！' : `個人檔案連結：${shareUrl}`,
                copied ? 'success' : 'info'
            );
        }
        return copied;
    }

    async function openProfileByUid(targetUid) {
        const cleanUid = String(targetUid || '').trim();
        if (!cleanUid) {
            if (typeof global.showToast === 'function') {
                global.showToast('找不到該玩家檔案（可能已註銷）', 'warning');
            }
            return false;
        }

        const authUser = getCurrentAuthUser();
        const myUid = authUser && authUser.uid ? authUser.uid : '';

        // 邊界 1：點開自己的連結 -> 自動導向自己的可編輯個人檔案頁面，絕不出現加好友/私訊按鈕
        if (myUid && cleanUid === myUid) {
            if (typeof global.closeModal === 'function') global.closeModal('playerProfileModal');
            if (typeof global.switchTab === 'function') global.switchTab('profile');
            renderProfileSection();
            if (typeof global.showToast === 'function') {
                global.showToast('已開啟您的個人檔案！', 'info');
            }
            return true;
        }

        // 邊界 2 & 3：未登入訪客安全檢視公開資料 / 查無此人防呆處理
        return await openPlayerProfileModal(cleanUid, '', { strictLookup: true });
    }

    /**
     * 檢視其他玩家（或自己）的公開名片面板 Modal
     * 可從「聊天室頭像/發言者」、「商城作者名稱」或深層連結開啟
     */
    async function openPlayerProfileModal(targetUid, fallbackName = '', options = {}) {
        const cleanUid = (targetUid || '').trim();
        const strictLookup = Boolean(options && options.strictLookup);
        const decodedFallbackName = fallbackName ? (() => {
            try { return decodeURIComponent(fallbackName); } catch (e) { return fallbackName; }
        })() : '';

        if (!cleanUid && !decodedFallbackName) return false;

        activeViewedProfileUid = cleanUid;

        const modal = document.getElementById('playerProfileModal');
        const contentBox = document.getElementById('playerProfileBody');
        if (!modal || !contentBox) return false;

        // 打開 Modal 並顯示載入骨架
        contentBox.innerHTML = `
            <div class="py-12 text-center space-y-2">
                <div class="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
                <p class="text-xs text-slate-400 font-bold">${escapeProfileHTML(profileTr('loadingText', '載入中...'))}</p>
            </div>
        `;
        if (typeof global.openModal === 'function') global.openModal('playerProfileModal');

        const authUser = getCurrentAuthUser();
        const myUid = authUser ? authUser.uid : '';
        const isSelf = Boolean(cleanUid && myUid && cleanUid === myUid);

        let profileData = null;

        if (isSelf) {
            profileData = buildMyPublicProfilePayload();
        } else {
            // 1. 優先讀取 Firestore publicProfiles/{uid}
            if (cleanUid && typeof db !== 'undefined' && db) {
                try {
                    const pubSnap = await db.collection('publicProfiles').doc(cleanUid).get();
                    if (pubSnap.exists) {
                        profileData = pubSnap.data();
                    } else {
                        // 2. 若對方尚未開啟新版產生 publicProfiles，退回讀取 users/{uid} 公開安全欄位（需已登入）
                        if (authUser) {
                            const userSnap = await db.collection('users').doc(cleanUid).get();
                            if (userSnap.exists) {
                                const d = userSnap.data() || {};
                                profileData = {
                                    uid: cleanUid,
                                    nickname: d.nickname || decodedFallbackName || '玩家',
                                    avatar: d.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUid)}`,
                                    bio: d.bio || '',
                                    role: d.role || 'user',
                                    cosmetics: d.cosmetics || { frame: 'default', banner: 'default', title: 'newcomer' },
                                    isStatsPublic: d.privacy?.isStatsPublic !== false,
                                    stats: d.progression ? {
                                        hidden: d.privacy?.isStatsPublic === false,
                                        level: d.progression.level || 1,
                                        xp: d.progression.xp || 0,
                                        streakDays: d.progression.streakDays || 0,
                                        rankTier: d.progression.rankTier || '青銅 III',
                                        duelWins: d.progression.duelWins || 0,
                                        duelTotal: d.progression.duelTotal || 0,
                                        duelWinRate: d.progression.duelTotal > 0 ? Math.round((d.progression.duelWins / d.progression.duelTotal) * 100) : 0,
                                        masteredCount: null
                                    } : { hidden: false }
                                };
                            }
                        }
                    }
                } catch (e) {
                    console.warn('讀取玩家公開檔案失敗（將使用備援資料）：', e);
                }
            }
        }

        // 3. 整合 RTDB onlineUsersMap 與商城作者資料作為備援
        const rtdbStatus = (typeof onlineUsersMap !== 'undefined' && cleanUid && onlineUsersMap[cleanUid]) ? onlineUsersMap[cleanUid] : null;
        const storeAuthorDecks = Array.isArray(global.storeDecks)
            ? global.storeDecks.filter(d => (cleanUid && d.authorId === cleanUid) || (decodedFallbackName && (d.author || '').toLowerCase() === decodedFallbackName.toLowerCase()))
            : [];

        // 邊界 3：若透過 ?profile=uid 深層連結查詢不到任何玩家資料，主動提示並回主畫面
        if (strictLookup && !isSelf && !profileData && !rtdbStatus && storeAuthorDecks.length === 0) {
            if (typeof global.closeModal === 'function') global.closeModal('playerProfileModal');
            contentBox.innerHTML = '';
            if (typeof global.showToast === 'function') {
                global.showToast('找不到該玩家檔案（可能已註銷）', 'warning');
            }
            return false;
        }

        const resolvedName = (profileData && profileData.nickname)
            || (rtdbStatus && rtdbStatus.nickname)
            || decodedFallbackName
            || (storeAuthorDecks[0]?.author)
            || profileTr('defaultPlayerName', '玩家');

        const fallbackModalAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUid || resolvedName)}`;
        const resolvedAvatar = sanitizeSafeUrl(
            (profileData && profileData.avatar)
            || (rtdbStatus && rtdbStatus.avatar)
            || (storeAuthorDecks[0]?.authorAvatar)
            || fallbackModalAvatar,
            fallbackModalAvatar
        );

        const cos = (profileData && profileData.cosmetics) || (rtdbStatus && rtdbStatus.cosmetics) || {};
        const frameMeta = getFrameMeta(cos.frame || (rtdbStatus && rtdbStatus.frame) || 'default');
        const bannerMeta = getBannerMeta(cos.banner || 'default');
        const titleMeta = getTitleMeta(cos.title || 'newcomer');

        const bioText = (profileData && profileData.bio) || profileTr('playerNoBio', '這位學習者很低調，尚未填寫個人目標宣言。');
        const isStatsHidden = Boolean(profileData && (profileData.isStatsPublic === false || profileData.stats?.hidden === true));
        const st = (profileData && profileData.stats) || {};

        const isViewerAdmin = Boolean(global.userData && global.userData.role === 'admin');
        const lastChanged = rtdbStatus && typeof rtdbStatus.last_changed === 'number' ? rtdbStatus.last_changed : 0;
        const isFresh = Boolean(rtdbStatus && rtdbStatus.state === 'online' && (isSelf || (lastChanged > 0 && (Date.now() - lastChanged) <= 150000)));
        const myPrivacyHide = !isViewerAdmin && Boolean(global.userData && global.userData.privacyHideStatus);
        const isOnline = Boolean(isFresh && (isViewerAdmin || (!myPrivacyHide && !rtdbStatus.hidePrivacy)));
        const isStealthOnline = Boolean(isViewerAdmin && isOnline && rtdbStatus && rtdbStatus.hidePrivacy);
        const totalDownloads = storeAuthorDecks.reduce((acc, d) => acc + (Number(d.downloads ?? d.downloadCount) || 0), 0);

        // 判斷好友狀態與防重複申請狀態
        const myFriends = Array.isArray(global.userData?.friends) ? global.userData.friends : [];
        const isAlreadyFriend = Boolean(cleanUid && myFriends.some(f => f.uid === cleanUid));
        const isPendingRequest = Boolean(cleanUid && pendingOutgoingFriendUids.has(cleanUid));

        let friendBtnHtml = '';
        if (!isSelf && cleanUid) {
            if (isAlreadyFriend) {
                friendBtnHtml = `
                    <button type="button" disabled class="flex-1 py-2.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-default">
                        <i class="fa-solid fa-user-check"></i>
                        <span>${escapeProfileHTML(profileTr('btnAlreadyFriend', '已是好友'))}</span>
                    </button>
                `;
            } else if (isPendingRequest) {
                friendBtnHtml = `
                    <button type="button" disabled class="flex-1 py-2.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-not-allowed">
                        <i class="fa-solid fa-hourglass-half"></i>
                        <span>${escapeProfileHTML(profileTr('btnFriendReqPending', '已發送邀請'))}</span>
                    </button>
                `;
            } else {
                friendBtnHtml = `
                    <button type="button" id="playerModalAddFriendBtn"
                        onclick="handleAddFriendFromProfileModal('${escapeProfileHTML(cleanUid)}', '${encodeURIComponent(resolvedName)}', '${encodeURIComponent(resolvedAvatar)}')"
                        class="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
                        <i class="fa-solid fa-user-plus"></i>
                        <span>${escapeProfileHTML(profileTr('btnAddFriend', '加好友'))}</span>
                    </button>
                `;
            }
        }

        const dmBtnHtml = (!isSelf && (cleanUid || resolvedName)) ? `
            <button type="button" onclick="handleDirectMessageFromProfileModal('${escapeProfileHTML(cleanUid)}', '${encodeURIComponent(resolvedName)}')"
                class="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
                <i class="fa-solid fa-paper-plane"></i>
                <span>${escapeProfileHTML(profileTr('btnSendPrivateMsg', '發送私訊'))}</span>
            </button>
        ` : '';

        const statsBlockHtml = isStatsHidden
            ? `
                <div class="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 text-center space-y-1">
                    <i class="fa-solid fa-lock text-slate-400 text-base"></i>
                    <p class="text-xs font-bold text-slate-500 dark:text-slate-400">${escapeProfileHTML(profileTr('playerStatsHiddenNotice', '該玩家已將學習統計設為不公開'))}</p>
                </div>
            `
            : `
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div class="p-2.5 bg-slate-50 dark:bg-slate-900/80 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                        <div class="text-[10px] font-bold text-slate-400">${escapeProfileHTML(profileTr('statLevelShort', '等級 / 段位'))}</div>
                        <div class="text-xs font-extrabold text-brand-600 dark:text-brand-400 mt-1">Lv.${Number(st.level) || 1} · ${escapeProfileHTML(st.rankTier || '青銅 III')}</div>
                    </div>
                    <div class="p-2.5 bg-slate-50 dark:bg-slate-900/80 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                        <div class="text-[10px] font-bold text-slate-400">${escapeProfileHTML(profileTr('statMasteredShort', '已掌握單字'))}</div>
                        <div class="text-xs font-extrabold text-emerald-600 dark:text-emerald-400 mt-1">${st.masteredCount !== undefined && st.masteredCount !== null ? `${Number(st.masteredCount)} 字` : '—'}</div>
                    </div>
                    <div class="p-2.5 bg-slate-50 dark:bg-slate-900/80 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                        <div class="text-[10px] font-bold text-slate-400">${escapeProfileHTML(profileTr('statStreakShort', '連續天數'))}</div>
                        <div class="text-xs font-extrabold text-amber-600 dark:text-amber-400 mt-1">🔥 ${Number(st.streakDays) || 0} 天</div>
                    </div>
                    <div class="p-2.5 bg-slate-50 dark:bg-slate-900/80 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                        <div class="text-[10px] font-bold text-slate-400">${escapeProfileHTML(profileTr('statWinRateShort', '對戰勝率'))}</div>
                        <div class="text-xs font-extrabold text-purple-600 dark:text-purple-400 mt-1">${Number(st.duelWinRate) || 0}% (${Number(st.duelWins) || 0}/${Number(st.duelTotal) || 0})</div>
                    </div>
                </div>
            `;

        const authorDecksHtml = storeAuthorDecks.length > 0 ? `
            <div class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-extrabold text-slate-800 dark:text-slate-100">📚 商城公開字庫作品 (${storeAuthorDecks.length})</span>
                    <span class="text-[10px] font-bold text-slate-400">累計下載 ${totalDownloads} 次</span>
                </div>
                <div class="max-h-44 overflow-y-auto space-y-2 pr-1">
                    ${storeAuthorDecks.map(deck => {
                        const safeDeckId = escapeProfileHTML(deck.id);
                        return `
                            <div class="p-2.5 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                                <div class="min-w-0">
                                    <div class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${escapeProfileHTML(deck.title)}</div>
                                    <div class="text-[10px] text-slate-400">${(deck.words || []).length} 字 · ⬇️ ${Number(deck.downloads ?? deck.downloadCount) || 0} · 👁️ ${Number(deck.views) || 0}</div>
                                </div>
                                <div class="flex items-center gap-1 shrink-0">
                                    <button type="button" onclick="closeModal('playerProfileModal'); if(typeof openStoreDeckPreview==='function') openStoreDeckPreview('${safeDeckId}');"
                                        class="px-2 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-700 dark:text-slate-200 rounded-lg text-[10px] font-bold transition cursor-pointer">預覽</button>
                                    <button type="button" onclick="closeModal('playerProfileModal'); ${deck.price > 0 ? `if(typeof purchaseStoreDeck==='function') purchaseStoreDeck('${safeDeckId}')` : `if(typeof importStoreDeck==='function') importStoreDeck('${safeDeckId}')`}"
                                        class="px-2.5 py-1 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-[10px] font-bold transition cursor-pointer">${deck.price > 0 ? `${deck.price} 幣` : '取得'}</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        ` : '';

        contentBox.innerHTML = `
            <div class="rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700">
                <div class="h-24 ${bannerMeta.bannerClass} p-3 flex items-start justify-between relative">
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${isOnline ? 'bg-emerald-500/90 text-white' : 'bg-black/30 text-slate-100'} backdrop-blur-xs">
                        <span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-white animate-pulse' : 'bg-slate-300'}"></span>
                        <span>${isOnline ? (isStealthOnline ? '線上學習中 (隱身)' : '線上學習中') : '離線'}</span>
                    </span>
                    <button type="button" onclick="closeModal('playerProfileModal')" class="w-7 h-7 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center transition cursor-pointer">
                        <i class="fa-solid fa-xmark text-sm"></i>
                    </button>
                </div>

                <div class="p-4 sm:p-5 bg-white dark:bg-slate-800 space-y-4">
                    <div class="flex items-end gap-3.5 -mt-12 relative z-10">
                        <img src="${escapeProfileHTML(resolvedAvatar)}" alt="${escapeProfileHTML(resolvedName)}"
                            class="w-18 h-18 w-[72px] h-[72px] rounded-full bg-white dark:bg-slate-900 object-cover ${frameMeta.ringClass}">
                        <div class="min-w-0 pb-0.5">
                            <div class="flex flex-wrap items-center gap-1.5">
                                <h3 class="font-extrabold text-base text-slate-900 dark:text-white truncate">${escapeProfileHTML(resolvedName)}</h3>
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${titleMeta.badgeClass}">
                                    <span>${titleMeta.icon}</span>
                                    <span>${escapeProfileHTML(titleMeta.name)}</span>
                                </span>
                            </div>
                            ${cleanUid ? `<p class="text-[10px] font-mono text-slate-400 truncate mt-0.5">ID: ${escapeProfileHTML(cleanUid.slice(0, 12))}...</p>` : ''}
                        </div>
                    </div>

                    <div class="p-3 bg-slate-50 dark:bg-slate-900/70 rounded-xl border border-slate-100 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                        ${escapeProfileHTML(bioText)}
                    </div>

                    ${statsBlockHtml}

                    <div class="flex items-center gap-2 pt-1">
                        ${isSelf ? `
                            <button type="button" onclick="closeModal('playerProfileModal'); if(typeof closeChatDrawer==='function') closeChatDrawer(); if(typeof switchTab==='function') switchTab('profile');"
                                class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>
                                <span>${escapeProfileHTML(profileTr('btnEditMyProfile', '前往編輯我的檔案與外觀'))}</span>
                            </button>
                        ` : `${friendBtnHtml}${dmBtnHtml}`}
                    </div>

                    ${authorDecksHtml}
                </div>
            </div>
        `;
        return true;
    }

    async function handleAddFriendFromProfileModal(targetUid, encodedName, encodedAvatar) {
        const authUser = getCurrentAuthUser();
        if (!authUser || isProfileGuest()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號後再進行互動', 'warning');
            }
            if (typeof global.closeModal === 'function') global.closeModal('playerProfileModal');
            if (typeof global.openWelcomeModal === 'function') global.openWelcomeModal();
            else if (typeof global.openSettingsDrawer === 'function') global.openSettingsDrawer();
            return false;
        }

        const targetName = decodeURIComponent(encodedName || '');
        const targetAvatar = decodeURIComponent(encodedAvatar || '');
        const btn = document.getElementById('playerModalAddFriendBtn');
        if (btn) {
            btn.disabled = true;
            btn.className = 'flex-1 py-2.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-not-allowed';
            btn.innerHTML = `<i class="fa-solid fa-hourglass-half"></i><span>${escapeProfileHTML(profileTr('btnFriendReqPending', '已發送邀請'))}</span>`;
        }

        pendingOutgoingFriendUids.add(targetUid);

        if (typeof global.sendFriendRequestByUid === 'function') {
            const ok = await global.sendFriendRequestByUid(targetUid, targetName, targetAvatar);
            if (!ok) {
                pendingOutgoingFriendUids.delete(targetUid);
            }
        }
        return true;
    }

    function handleDirectMessageFromProfileModal(targetUid, encodedName) {
        const authUser = getCurrentAuthUser();
        if (!authUser || isProfileGuest()) {
            if (typeof global.showToast === 'function') {
                global.showToast('請先登入帳號後再進行互動', 'warning');
            }
            if (typeof global.closeModal === 'function') global.closeModal('playerProfileModal');
            if (typeof global.openWelcomeModal === 'function') global.openWelcomeModal();
            else if (typeof global.openSettingsDrawer === 'function') global.openSettingsDrawer();
            return false;
        }

        if (typeof global.closeModal === 'function') {
            global.closeModal('playerProfileModal');
            global.closeModal('authorModal');
        }
        if (typeof global.openChatDrawer === 'function') {
            global.openChatDrawer();
        }
        if (typeof global.startPrivateChat === 'function') {
            global.startPrivateChat(encodedName, targetUid);
        }
        return true;
    }

    async function handlePublicStatsToggleChange(isPublic) {
        const u = ensureUserProfileDefaults();
        u.privacy.isStatsPublic = Boolean(isPublic);

        const toggleEl = document.getElementById('publicStatsToggle');
        if (toggleEl) toggleEl.checked = u.privacy.isStatsPublic;

        renderProfileSection();

        if (typeof global.saveUserData === 'function') {
            await global.saveUserData();
        }
        await syncMyPublicProfile(true);

        if (typeof global.showToast === 'function') {
            const msg = u.privacy.isStatsPublic
                ? profileTr('toastPublicStatsEnabled', '🌐 已開啟：其他玩家將可查看您的學習統計')
                : profileTr('toastPublicStatsHidden', '🔒 已設為隱私：其他玩家將無法查看您的學習統計');
            global.showToast(msg, 'info');
        }
        return true;
    }

    // 對外暴露全局介面
    global.PROFILE_COSMETIC_CATALOG = PROFILE_COSMETIC_CATALOG;
    global.sanitizeSafeUrl = sanitizeSafeUrl;
    global.getFrameMeta = getFrameMeta;
    global.getBannerMeta = getBannerMeta;
    global.getTitleMeta = getTitleMeta;
    global.ensureUserProfileDefaults = ensureUserProfileDefaults;
    global.computeMyLearningStats = computeMyLearningStats;
    global.isCosmeticUnlocked = isCosmeticUnlocked;
    global.applyNavAvatarFrame = applyNavAvatarFrame;
    global.buildMyPublicProfilePayload = buildMyPublicProfilePayload;
    global.syncMyPublicProfile = syncMyPublicProfile;
    global.renderProfileSection = renderProfileSection;
    global.switchProfileCustomizerTab = switchProfileCustomizerTab;
    global.selectProfileCosmetic = selectProfileCosmetic;
    global.saveProfileBasicInfo = saveProfileBasicInfo;
    global.shareUserProfile = shareUserProfile;
    global.openProfileByUid = openProfileByUid;
    global.openPlayerProfileModal = openPlayerProfileModal;
    global.handleAddFriendFromProfileModal = handleAddFriendFromProfileModal;
    global.handleDirectMessageFromProfileModal = handleDirectMessageFromProfileModal;
    global.handlePublicStatsToggleChange = handlePublicStatsToggleChange;
    global.markOutgoingFriendRequestUid = function (uid) {
        if (uid) pendingOutgoingFriendUids.add(uid);
    };
    global.clearOutgoingFriendRequestUids = function () {
        pendingOutgoingFriendUids.clear();
    };
})(typeof window !== 'undefined' ? window : globalThis);
