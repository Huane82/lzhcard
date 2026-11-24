/**
 * LZHCard - 聊天、好友、群組、公告、在線狀態、已讀與隱私控制模組 (chat.js)
 */

if (!window.userData) window.userData = {};
if (!window.userData.friends) window.userData.friends = [];

let currentActiveChatId = null;
let currentActiveChatData = null;
let chatSearchQuery = '';

// RTDB 監聽器與定時器引用
let activeChatListener = null;
let activeChatReadListener = null;
let friendRequestsListener = null;
let groupInvitesListener = null;
let chatsListListener = null;
let announcementsListener = null;
let presenceStatusListener = null;
let connectedStateListener = null;
let presenceHeartbeatTimer = null;
let onlineUiRefreshTimer = null;
let currentTrackedPresenceUid = null;

let pendingRequestsList = [];
let pendingGroupInvitesList = [];
let userChatThreads = [];
let cloudAnnouncements = [];
let onlineUsersMap = {}; // 記錄全站線上使用者狀態
let chatReadByMap = {};   // 記錄當前聊天室各成員最後已讀時間
let currentChatMessages = []; // 快取當前聊天室訊息，避免已讀狀態變更時重複向 Firebase 下載

// 🔔 原生狀態列推播防舊訊息轟炸基準線與狀態
let _notifSessionStartedAt = Date.now();
let _annBaselineReady = false;
let _knownAnnouncementIds = new Set();
let _chatsBaselineReady = false;
let _prevChatUpdatedAtMap = new Map();
let _friendReqBaselineReady = false;
let _knownFriendReqIds = new Set();
let _groupInvBaselineReady = false;
let _knownGroupInvIds = new Set();
let _nextNotificationId = 1000;
let _notifActionListenerBound = false;
let _notifChannelCreated = false;

// 📌 長按選單 / 刪除確認 / 僅限好友邀請彈窗暫存狀態
let _contextMenuTarget = null;
let _pendingDeleteChatTarget = null;
let _activeTeamInviteCtx = null;
let _staticLongPressBound = false;
let _contextMenuDismissBound = false;

const PRESENCE_HEARTBEAT_MS = 15000; // 每 15 秒更新一次活躍與 lastSeenAt 時間戳
const PRESENCE_TIMEOUT_MS = 60000;   // 超過 60 秒無心跳視為已離線（加速離線狀態同步）
const ONLINE_UI_REFRESH_MS = 10000;  // 每 10 秒刷新在線 / 上線時間 UI
const CHAT_MSG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 滾動式 30 天訊息保留期限 (2592000000 ms)
const NOTIF_CHANNEL_ID = 'lzhcard_social_high';

let _presenceLifecycleBound = false;

function chatTr(key, fallback, params = {}) {
    if (typeof t === 'function') {
        const res = t(key, params);
        if (res && res !== key) return res;
    }
    let out = fallback || key;
    if (params && typeof params === 'object') {
        Object.keys(params).forEach(k => {
            out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
        });
    }
    return out;
}

// 取得 RTDB 實例
function getRtdb() {
    if (typeof firebase !== 'undefined' && firebase.database) {
        return firebase.database();
    }
    return null;
}

/**
 * 🛡️ HTML 防注入工具 (防止 XSS 攻擊)
 */
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeChatUrl(rawUrl, fallbackUrl = '') {
    if (typeof window !== 'undefined' && typeof window.sanitizeSafeUrl === 'function') {
        return window.sanitizeSafeUrl(rawUrl, fallbackUrl);
    }
    const val = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!val) return fallbackUrl;
    if (/^https?:\/\//i.test(val)) return val;
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(val)) return val;
    return fallbackUrl;
}

/**
 * 🔒 判斷當前是否為訪客身分
 */
function isGuestUser() {
    const isGuestMode = localStorage.getItem('lzhcard_guest_mode') === 'true';
    const currentUser = window.userData ? (window.userData.username || '') : '';
    const isFirebaseUser = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
    return isGuestMode || currentUser === '訪客玩家' || !isFirebaseUser;
}

/**
 * 👑 檢查管理員身分並即時切換 UI 顯示狀態
 */
function isChatUserAdmin() {
    if (typeof LZHEntitlements !== 'undefined' && typeof LZHEntitlements.isAdmin === 'function') {
        return LZHEntitlements.isAdmin(window.userData);
    }
    return Boolean(window.userData && (window.userData.role === 'admin' || window.userData.isAdmin === true));
}

function checkAdminPermissions() {
    const isAdmin = isChatUserAdmin();

    const adminBtn = document.getElementById('tabAdminBtn');
    if (adminBtn) adminBtn.classList.toggle('hidden', !isAdmin);

    const noticeAction = document.getElementById('adminNoticeAction');
    if (noticeAction) noticeAction.classList.toggle('hidden', !isAdmin);

    const adminBadge = document.getElementById('adminBadge');
    if (adminBadge) adminBadge.classList.toggle('hidden', !isAdmin);

    const adminOnlinePanel = document.getElementById('adminOnlineMonitorPanel');
    if (adminOnlinePanel) adminOnlinePanel.classList.toggle('hidden', !isAdmin);
}

if (typeof window !== 'undefined') {
    window.checkAdminPermissions = checkAdminPermissions;
    window.addEventListener('lzh:state-updated', () => {
        checkAdminPermissions();
    });
}

// 🚫 App Store Guideline 1.2：封鎖用戶名單管理與檢舉流程
function getBlockedUidsSet() {
    const list = Array.isArray(window.userData?.blockedUids) ? window.userData.blockedUids : [];
    return new Set(list.map(u => String(u || '').trim()).filter(Boolean));
}

function isUidBlocked(uid) {
    const clean = String(uid || '').trim();
    return Boolean(clean && getBlockedUidsSet().has(clean));
}

async function blockPlayerByUid(targetUid, encodedName = '') {
    const cleanUid = String(targetUid || '').trim();
    const myUid = firebase.auth()?.currentUser?.uid || '';
    if (!cleanUid || cleanUid === myUid) return false;
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast('請先登入帳號才能封鎖用戶', 'warning');
        return false;
    }

    let decodedName = '';
    try { decodedName = decodeURIComponent(encodedName || ''); } catch (e) { decodedName = encodedName || ''; }
    const label = decodedName || `用戶 (${cleanUid.slice(0, 6)}...)`;
    const confirmed = typeof window.lzhConfirm === 'function'
        ? await window.lzhConfirm(`確定要封鎖「${label}」嗎？封鎖後您將不會再看到對方的聊天訊息與在線狀態，之後可隨時於設定頁解除封鎖。`)
        : true;
    if (!confirmed) return false;

    if (!window.userData) window.userData = {};
    const set = getBlockedUidsSet();
    set.add(cleanUid);
    window.userData.blockedUids = Array.from(set).slice(0, 200);

    try {
        localStorage.setItem(`lzhcard_blocked_name_${cleanUid}`, label);
    } catch (e) {}

    if (typeof saveUserData === 'function') {
        await saveUserData();
    }
    if (typeof window.renderBlockedUsersSettingsList === 'function') {
        window.renderBlockedUsersSettingsList();
    }
    renderOnlineStatusUI();
    renderChatThreads(false);
    renderMessagesList(currentChatMessages);
    if (typeof showToast === 'function') {
        showToast(`已封鎖「${label}」`, 'info');
    }
    return true;
}

async function unblockPlayerByUid(targetUid) {
    const cleanUid = String(targetUid || '').trim();
    if (!cleanUid || !window.userData) return false;
    const next = Array.from(getBlockedUidsSet()).filter(u => u !== cleanUid);
    window.userData.blockedUids = next;
    if (typeof saveUserData === 'function') {
        await saveUserData();
    }
    if (typeof window.renderBlockedUsersSettingsList === 'function') {
        window.renderBlockedUsersSettingsList();
    }
    renderOnlineStatusUI();
    renderChatThreads(false);
    renderMessagesList(currentChatMessages);
    if (typeof showToast === 'function') {
        showToast('已解除封鎖該用戶', 'success');
    }
    return true;
}

let _pendingReportCtx = null;

function openUgcReportModal(ctx = {}) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast('請先登入帳號再提交檢舉', 'warning');
        return false;
    }
    let decodedLabel = '';
    try { decodedLabel = decodeURIComponent(ctx.targetLabel || ''); } catch (e) { decodedLabel = ctx.targetLabel || ''; }
    let decodedPreview = '';
    try { decodedPreview = decodeURIComponent(ctx.contentPreview || ''); } catch (e) { decodedPreview = ctx.contentPreview || ''; }

    _pendingReportCtx = {
        targetType: String(ctx.targetType || 'message').trim() || 'message',
        targetUid: String(ctx.targetUid || '').trim(),
        chatId: String(ctx.chatId || currentActiveChatId || '').trim(),
        messageId: String(ctx.messageId || '').trim(),
        targetLabel: decodedLabel || '用戶',
        contentPreview: decodedPreview.slice(0, 300)
    };

    const modal = document.getElementById('ugcReportModal');
    const labelEl = document.getElementById('ugcReportTargetLabel');
    const detailEl = document.getElementById('ugcReportDetailInput');
    if (labelEl) labelEl.textContent = _pendingReportCtx.targetLabel;
    if (detailEl) detailEl.value = '';
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
    return true;
}

function closeUgcReportModal() {
    _pendingReportCtx = null;
    const modal = document.getElementById('ugcReportModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function submitUgcReport() {
    const authUser = firebase.auth()?.currentUser;
    if (!authUser || authUser.isAnonymous || !_pendingReportCtx) {
        closeUgcReportModal();
        return false;
    }
    if (typeof db === 'undefined' || !db) {
        if (typeof showToast === 'function') showToast('雲端資料庫尚未連線，請稍後再試', 'error');
        return false;
    }

    const reasonEl = document.getElementById('ugcReportReasonSelect');
    const detailEl = document.getElementById('ugcReportDetailInput');
    const submitBtn = document.getElementById('ugcReportSubmitBtn');
    const reason = String(reasonEl?.value || '騷擾與不當言論').trim();
    const detail = String(detailEl?.value || '').trim().slice(0, 300);

    if (submitBtn) submitBtn.disabled = true;
    try {
        await db.collection('reports').add({
            reporterUid: authUser.uid,
            targetUid: _pendingReportCtx.targetUid || '',
            targetType: _pendingReportCtx.targetType,
            chatId: _pendingReportCtx.chatId || '',
            messageId: _pendingReportCtx.messageId || '',
            reason: detail ? `${reason}：${detail}` : reason,
            contentPreview: _pendingReportCtx.contentPreview || '',
            status: 'pending',
            createdAt: Date.now()
        });

        const reportedUid = _pendingReportCtx.targetUid;
        const reportedLabel = _pendingReportCtx.targetLabel;
        closeUgcReportModal();
        if (typeof showToast === 'function') {
            showToast('✅ 已收到您的檢舉，管理員團隊將於 24 小時內審核處理', 'success');
        }
        if (reportedUid && !isUidBlocked(reportedUid) && typeof window.lzhConfirm === 'function') {
            const wantBlock = await window.lzhConfirm(`檢舉已送出！是否同時封鎖「${reportedLabel}」以停止接收對方的訊息？`);
            if (wantBlock) {
                await blockPlayerByUid(reportedUid, encodeURIComponent(reportedLabel));
            }
        }
        return true;
    } catch (e) {
        console.error('提交檢舉失敗:', e);
        if (typeof showToast === 'function') showToast('送出檢舉失敗，請稍後再試', 'error');
        return false;
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function loadAdminModerationReports() {
    const container = document.getElementById('adminReportsContainer');
    if (!container) return;
    if (!isChatUserAdmin() || typeof db === 'undefined' || !db) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = `<div class="p-2.5 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/60 text-[11px] font-bold text-rose-600 dark:text-rose-300">🛡️ 載入待處理檢舉案件中...</div>`;

    try {
        const snap = await db.collection('reports').orderBy('createdAt', 'desc').limit(25).get();
        const items = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
        const pending = items.filter(it => it.status === 'pending');

        if (items.length === 0) {
            container.innerHTML = `<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700 text-[11px] font-bold text-slate-400">🛡️ 目前全站無檢舉紀錄</div>`;
            return;
        }

        container.innerHTML = `
            <div class="p-3 rounded-xl bg-rose-50/60 dark:bg-rose-950/25 border border-rose-200 dark:border-rose-800/70 space-y-2">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-extrabold text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
                        <i class="fa-solid fa-shield-halved"></i>
                        <span>待審核檢舉 (${pending.length} / ${items.length})</span>
                    </span>
                    <button type="button" onclick="loadAdminModerationReports()" class="text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer">重新整理</button>
                </div>
                <div class="max-h-56 overflow-y-auto space-y-2 pr-1">
                    ${items.map(it => {
                        const safeId = escapeHTML(it.id);
                        const statusColor = it.status === 'pending'
                            ? 'bg-rose-600 text-white'
                            : (it.status === 'resolved' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300');
                        const statusLabel = it.status === 'pending' ? '待處理' : (it.status === 'resolved' ? '已處置' : '已忽略');
                        return `
                            <div class="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] space-y-1.5">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="font-extrabold text-slate-800 dark:text-slate-100 truncate">${escapeHTML(it.reason || '違規檢舉')}</span>
                                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${statusColor}">${statusLabel}</span>
                                </div>
                                ${it.contentPreview ? `<p class="text-[10.5px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/70 p-1.5 rounded-lg break-words">「${escapeHTML(it.contentPreview)}」</p>` : ''}
                                <div class="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                                    <span class="font-mono truncate">被檢舉: ${escapeHTML((it.targetUid || '').slice(0, 12) || '—')}</span>
                                    <div class="flex items-center gap-1.5 shrink-0">
                                        ${it.status === 'pending' ? `
                                            <button type="button" onclick="updateAdminReportStatus('${safeId}', 'resolved')" class="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer">標記已處置</button>
                                            <button type="button" onclick="updateAdminReportStatus('${safeId}', 'dismissed')" class="px-2 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold cursor-pointer">忽略</button>
                                        ` : ''}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    } catch (e) {
        console.warn('載入管理員檢舉清單失敗:', e);
        container.innerHTML = `<div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-[11px] text-rose-500">載入檢舉紀錄失敗：${escapeHTML(e.message || '')}</div>`;
    }
}

async function updateAdminReportStatus(reportId, status) {
    if (!isChatUserAdmin() || typeof db === 'undefined' || !db || !reportId) return false;
    try {
        await db.collection('reports').doc(reportId).update({
            status: status === 'resolved' ? 'resolved' : 'dismissed',
            reviewedBy: firebase.auth()?.currentUser?.uid || '',
            reviewedAt: Date.now()
        });
        if (typeof showToast === 'function') showToast('已更新檢舉審核狀態', 'success');
        await loadAdminModerationReports();
        return true;
    } catch (e) {
        if (typeof showToast === 'function') showToast('更新檢舉狀態失敗', 'error');
        return false;
    }
}

/**
 * 🔴🟡 即時更新全站未讀提示（紅點與黃點）
 */
function updateUnreadBadgeUI() {
    const dot = document.getElementById('chatUnreadDot');
    const quickDot = document.getElementById('quickChatUnreadDot');
    if (!dot && !quickDot) return;

    if (isGuestUser() || typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
        if (dot) dot.classList.add('hidden');
        if (quickDot) quickDot.classList.add('hidden');
        return;
    }

    const currentUid = firebase.auth().currentUser.uid;
    const lastReadNotice = parseInt(localStorage.getItem('lzhcard_last_read_announcements') || '0', 10);

    const hasUnreadRequests = pendingRequestsList.length > 0 || pendingGroupInvitesList.length > 0;

    let hasUnreadPrivateMsg = false;
    userChatThreads.forEach(chat => {
        if (!chat || !chat.id) return;
        if (isChatDeleted(chat.id)) return;
        if (isThreadUnread(chat, currentUid)) {
            hasUnreadPrivateMsg = true;
        }
    });

    let hasUnreadAnnounce = false;
    cloudAnnouncements.forEach(ann => {
        const annTime = typeof ann.createdAt === 'number' ? ann.createdAt : (ann.time ? new Date(ann.time).getTime() : 0);
        if (annTime > lastReadNotice) {
            hasUnreadAnnounce = true;
        }
    });

    const hasRedDot = hasUnreadRequests || hasUnreadPrivateMsg;
    const hasYellowDot = hasUnreadAnnounce;

    if (hasRedDot) {
        if (dot) {
            dot.className = "absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-rose-500 rounded-full ring-2 ring-white dark:ring-slate-800";
            dot.classList.remove('hidden');
        }
        if (quickDot) {
            quickDot.className = "w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-white dark:ring-slate-800 shrink-0";
            quickDot.classList.remove('hidden');
        }
    } else if (hasYellowDot) {
        if (dot) {
            dot.className = "absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-500 rounded-full ring-2 ring-white dark:ring-slate-800";
            dot.classList.remove('hidden');
        }
        if (quickDot) {
            quickDot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-800 shrink-0";
            quickDot.classList.remove('hidden');
        }
    } else {
        if (dot) dot.classList.add('hidden');
        if (quickDot) quickDot.classList.add('hidden');
    }

    if (typeof window !== 'undefined' && window.FloatingTranslator && typeof window.FloatingTranslator.refreshBallUnread === 'function') {
        window.FloatingTranslator.refreshBallUnread();
    }
    if (typeof window !== 'undefined' && typeof window.syncConfigToNativeOverlay === 'function') {
        window.syncConfigToNativeOverlay();
    }
}

/**
 * 🟢 寫入目前使用者的線上狀態資料（一律使用 .update 保留 onlineSessionId 與 lastSeenAt）
 */
function writeCurrentUserOnlineStatus() {
    if (isGuestUser()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const currentUser = firebase.auth()?.currentUser;
    const rtdb = getRtdb();
    if (!rtdb || !currentUser) return;

    const currentUid = currentUser.uid;
    currentTrackedPresenceUid = currentUid;
    const userStatusRef = rtdb.ref(`status/${currentUid}`);
    const resolvedNickname = (window.userData && window.userData.nickname)
        || currentUser.displayName
        || (currentUser.email ? currentUser.email.split('@')[0] : '')
        || chatTr('defaultPlayerName', '玩家');
    const resolvedAvatar = (typeof window !== 'undefined' && typeof window.resolveAuthUserPhotoUrl === 'function')
        ? window.resolveAuthUserPhotoUrl(currentUser, window.userData)
        : (currentUser.photoURL || (window.userData && window.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUid)}`);
    const resolvedCosmetics = (window.userData && window.userData.cosmetics) ? window.userData.cosmetics : { frame: 'default', banner: 'default', title: 'newcomer' };

    const membershipPatch = (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.getMyOnlineMembershipPayload === 'function')
        ? MembershipEngine.getMyOnlineMembershipPayload()
        : { membershipTier: 'free', membershipExpiresAt: 0 };

    const patch = {
        state: 'online',
        nickname: resolvedNickname,
        email: currentUser.email || '',
        avatar: resolvedAvatar,
        frame: resolvedCosmetics.frame || 'default',
        cosmetics: resolvedCosmetics,
        hidePrivacy: !!(window.userData && window.userData.privacyHideStatus),
        last_changed: firebase.database.ServerValue.TIMESTAMP,
        lastSeenAt: firebase.database.ServerValue.TIMESTAMP,
        ...membershipPatch
    };

    if (typeof SessionGuard !== 'undefined' && typeof SessionGuard.getSessionId === 'function' && SessionGuard.isSessionClaimedOnline()) {
        patch.onlineSessionId = SessionGuard.getSessionId();
        patch.sessionOnline = true;
        patch.sessionUpdatedAt = firebase.database.ServerValue.TIMESTAMP;
    }

    userStatusRef.update(patch).catch(() => {});
}

/**
 * 🔴 立即將目前帳號標記為離線（支援 preserveRemoteStatus 防止頂號時誤覆寫新裝置）
 */
async function setUserOfflineNow(options = {}) {
    if (options && options.preserveRemoteStatus) {
        if (presenceHeartbeatTimer) {
            clearInterval(presenceHeartbeatTimer);
            presenceHeartbeatTimer = null;
        }
        return;
    }

    if (presenceHeartbeatTimer) {
        clearInterval(presenceHeartbeatTimer);
        presenceHeartbeatTimer = null;
    }

    const rtdb = getRtdb();
    const uid = firebase.auth()?.currentUser?.uid || currentTrackedPresenceUid;
    if (!rtdb || !uid) return;

    try {
        const mySid = (typeof SessionGuard !== 'undefined' && typeof SessionGuard.getSessionId === 'function')
            ? SessionGuard.getSessionId()
            : '';
        const remoteSid = onlineUsersMap?.[uid]?.onlineSessionId || '';
        // 若另一台裝置已接管 Session，絕不將新裝置的線上狀態蓋成 offline
        if (!options.force && mySid && remoteSid && remoteSid !== mySid) {
            return;
        }

        const userStatusRef = rtdb.ref(`status/${uid}`);
        if (options.force) {
            await userStatusRef.onDisconnect().cancel().catch(() => {});
        }
        await userStatusRef.update({
            state: 'offline',
            sessionOnline: false,
            onlineSessionId: '',
            last_changed: firebase.database.ServerValue.TIMESTAMP,
            lastSeenAt: firebase.database.ServerValue.TIMESTAMP
        });
    } catch (e) {
        console.warn("標記離線狀態失敗:", e);
    } finally {
        if (options.force) {
            currentTrackedPresenceUid = null;
        }
    }
}
window.setUserOfflineNow = setUserOfflineNow;

/**
 * 🟢 1. 在線狀態 Presence 綁定、快速心跳維持與離線 lastSeenAt 記錄
 */
function initUserPresenceTracker() {
    if (isGuestUser()) return;
    const currentUid = firebase.auth()?.currentUser?.uid;
    const rtdb = getRtdb();
    if (!rtdb || !currentUid) return;

    // 若同分頁切換帳號，先將上一組 UID 標記離線
    if (currentTrackedPresenceUid && currentTrackedPresenceUid !== currentUid) {
        const prevRef = rtdb.ref(`status/${currentTrackedPresenceUid}`);
        prevRef.onDisconnect().cancel().catch(() => {});
        prevRef.update({
            state: 'offline',
            sessionOnline: false,
            onlineSessionId: '',
            last_changed: firebase.database.ServerValue.TIMESTAMP,
            lastSeenAt: firebase.database.ServerValue.TIMESTAMP
        }).catch(() => {});
    }

    currentTrackedPresenceUid = currentUid;
    const userStatusRef = rtdb.ref(`status/${currentUid}`);
    const connectedRef = rtdb.ref('.info/connected');

    if (connectedStateListener) {
        connectedRef.off('value', connectedStateListener);
    }

    connectedStateListener = connectedRef.on('value', snapshot => {
        if (snapshot.val() === false) return;

        userStatusRef.onDisconnect().update({
            state: 'offline',
            sessionOnline: false,
            onlineSessionId: '',
            last_changed: firebase.database.ServerValue.TIMESTAMP,
            lastSeenAt: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
                writeCurrentUserOnlineStatus();
            }
        }).catch(() => {});
    });

    if (presenceHeartbeatTimer) {
        clearInterval(presenceHeartbeatTimer);
    }
    presenceHeartbeatTimer = setInterval(() => {
        if (
            (typeof document === 'undefined' || document.visibilityState === 'visible') &&
            (typeof navigator === 'undefined' || navigator.onLine !== false) &&
            !isGuestUser() &&
            firebase.auth()?.currentUser
        ) {
            userStatusRef.update({
                state: 'online',
                last_changed: firebase.database.ServerValue.TIMESTAMP,
                lastSeenAt: firebase.database.ServerValue.TIMESTAMP
            }).catch(() => {});
        }
    }, PRESENCE_HEARTBEAT_MS);
}

/**
 * 📡 2. 初始化 Realtime Database 全局即時監聽器
 */
function initChatRealtimeListeners() {
    const rtdb = getRtdb();
    if (!rtdb || !firebase.auth || !firebase.auth().currentUser) return;
    const currentUid = firebase.auth().currentUser.uid;

    // 重設推播防轟炸基準線（僅針對啟動監聽後新產生之事件推播）
    _notifSessionStartedAt = Date.now();
    _annBaselineReady = false;
    _knownAnnouncementIds.clear();
    _chatsBaselineReady = false;
    _prevChatUpdatedAtMap.clear();
    _friendReqBaselineReady = false;
    _knownFriendReqIds.clear();
    _groupInvBaselineReady = false;
    _knownGroupInvIds.clear();

    ensureLocalNotificationReady(true).catch(() => {});
    checkAdminPermissions();
    initUserPresenceTracker();

    if (presenceStatusListener) rtdb.ref('status').off('value', presenceStatusListener);
    presenceStatusListener = rtdb.ref('status').on('value', snapshot => {
        onlineUsersMap = snapshot.val() || {};
        renderOnlineStatusUI();
    });

    if (!onlineUiRefreshTimer) {
        onlineUiRefreshTimer = setInterval(() => {
            renderOnlineStatusUI();
        }, ONLINE_UI_REFRESH_MS);
    }

    if (friendRequestsListener) rtdb.ref('friendRequests').off('value', friendRequestsListener);
    friendRequestsListener = rtdb.ref('friendRequests').on('value', snapshot => {
        const data = snapshot.val() || {};
        const myEmail = (firebase.auth()?.currentUser?.email || '').trim().toLowerCase();
        const allReqs = Object.keys(data).map(key => ({ id: key, ...data[key] }));
        pendingRequestsList = allReqs.filter(req =>
            req && req.status === 'pending' && (
                req.toUid === currentUid ||
                (req.toEmail && myEmail && String(req.toEmail).trim().toLowerCase() === myEmail)
            )
        );

        // 自動同步「對方已同意」的好友申請至申請者（本人）的好友名單
        const acceptedOutgoing = allReqs.filter(req =>
            req && req.status === 'accepted' && req.fromUid === currentUid && req.toUid && req.toUid !== currentUid
        );
        if (acceptedOutgoing.length > 0) {
            if (!window.userData) window.userData = {};
            if (!Array.isArray(window.userData.friends)) window.userData.friends = [];
            let friendAdded = false;
            acceptedOutgoing.forEach(req => {
                if (!window.userData.friends.some(f => f && f.uid === req.toUid)) {
                    const live = onlineUsersMap[req.toUid] || {};
                    window.userData.friends.push({
                        uid: req.toUid,
                        nickname: req.toNickname || live.nickname || (req.toEmail ? req.toEmail.split('@')[0] : chatTr('defaultPlayerName', '好友')),
                        username: req.toNickname || live.nickname || (req.toEmail ? req.toEmail.split('@')[0] : chatTr('defaultPlayerName', '好友')),
                        email: req.toEmail || live.email || '',
                        avatar: req.toAvatar || live.avatar || ''
                    });
                    friendAdded = true;
                }
            });
            if (friendAdded && typeof saveUserData === 'function') {
                saveUserData();
            }
        }

        if (!_friendReqBaselineReady) {
            pendingRequestsList.forEach(r => { if (r.id) _knownFriendReqIds.add(r.id); });
            _friendReqBaselineReady = true;
        } else {
            pendingRequestsList.forEach(req => {
                if (!req || !req.id || _knownFriendReqIds.has(req.id)) return;
                _knownFriendReqIds.add(req.id);
                const createdMs = toChatTimestampMs(req.createdAt) || Date.now();
                if (createdMs >= _notifSessionStartedAt - 5000) {
                    dispatchSystemNotification({
                        type: 'friendRequests',
                        title: '👋 新的加好友申請',
                        body: `${req.fromNickname || '有玩家'} 想加你為好友`,
                        extra: { type: 'friendRequests', reqId: req.id }
                    });
                }
            });
        }

        if (typeof clearOutgoingFriendRequestUids === 'function') {
            clearOutgoingFriendRequestUids();
            allReqs
                .filter(req => req.fromUid === currentUid && req.status === 'pending' && req.toUid)
                .forEach(req => {
                    if (typeof markOutgoingFriendRequestUid === 'function') markOutgoingFriendRequestUid(req.toUid);
                });
        }

        updateUnreadBadgeUI();
        const friendsView = document.getElementById('friendsView');
        if (friendsView && !friendsView.classList.contains('hidden')) {
            renderFriendsList();
        }
    });

    if (groupInvitesListener) rtdb.ref('groupInvites').off('value', groupInvitesListener);
    groupInvitesListener = rtdb.ref('groupInvites').on('value', snapshot => {
        const data = snapshot.val() || {};
        pendingGroupInvitesList = Object.keys(data)
            .map(key => ({ id: key, ...data[key] }))
            .filter(inv => inv.toUid === currentUid && inv.status === 'pending');

        if (!_groupInvBaselineReady) {
            pendingGroupInvitesList.forEach(inv => { if (inv.id) _knownGroupInvIds.add(inv.id); });
            _groupInvBaselineReady = true;
        } else {
            pendingGroupInvitesList.forEach(inv => {
                if (!inv || !inv.id || _knownGroupInvIds.has(inv.id)) return;
                _knownGroupInvIds.add(inv.id);
                const createdMs = toChatTimestampMs(inv.createdAt) || Date.now();
                if (createdMs >= _notifSessionStartedAt - 5000) {
                    const isRaid = inv.inviteType === 'raid';
                    dispatchSystemNotification({
                        type: 'teamInvites',
                        title: isRaid ? '🎮 收到打王組隊邀請' : '👥 收到群組邀請',
                        body: `${inv.inviterNickname || '好友'} 邀請你加入「${inv.groupName || (isRaid ? '四人共鬥打王' : '聊天群組')}」`,
                        extra: { type: 'teamInvites', invId: inv.id }
                    });
                }
            });
        }

        updateUnreadBadgeUI();
        const friendsView = document.getElementById('friendsView');
        if (friendsView && !friendsView.classList.contains('hidden')) {
            renderFriendsList();
        }
    });

    if (chatsListListener) rtdb.ref('chats').off('value', chatsListListener);
    chatsListListener = rtdb.ref('chats').on('value', snapshot => {
        const data = snapshot.val() || {};
        userChatThreads = Object.keys(data)
            .map(key => ({ id: key, ...data[key] }))
            .filter(chat => chat.members && (Array.isArray(chat.members) ? chat.members.includes(currentUid) : chat.members[currentUid]));

        if (!_chatsBaselineReady) {
            userChatThreads.forEach(chat => {
                if (chat && chat.id) {
                    _prevChatUpdatedAtMap.set(chat.id, toChatTimestampMs(chat.updatedAt));
                }
            });
            _chatsBaselineReady = true;
        } else {
            userChatThreads.forEach(chat => {
                if (!chat || !chat.id) return;
                const updatedMs = toChatTimestampMs(chat.updatedAt);
                const prevMs = _prevChatUpdatedAtMap.get(chat.id) || 0;
                _prevChatUpdatedAtMap.set(chat.id, Math.max(prevMs, updatedMs));

                if (updatedMs > prevMs && updatedMs >= _notifSessionStartedAt - 5000 && chat.lastSenderUid !== currentUid) {
                    if (isChatDeleted(chat.id)) {
                        setChatDeleted(chat.id, false);
                    }
                    const drawerHidden = typeof document === 'undefined'
                        ? true
                        : Boolean(document.getElementById('chatDrawer')?.classList.contains('hidden'));
                    const isViewingThisChat = !drawerHidden && currentActiveChatId === chat.id && (typeof document === 'undefined' || document.visibilityState === 'visible');
                    if (chat.id !== 'chat_group_public' && !isViewingThisChat) {
                        const isGroupChat = chat.type === 'group' || String(chat.id).startsWith('chat_group_');
                        const senderUid = chat.lastSenderUid || '';
                        const friendsObj = (window.userData && window.userData.friends && typeof window.userData.friends === 'object') ? window.userData.friends : {};
                        const friendEntry = senderUid ? (friendsObj[senderUid] || Object.values(friendsObj).find(f => f && f.uid === senderUid)) : null;
                        const peerOnlineMeta = (senderUid && window.onlineUsersMap) ? window.onlineUsersMap[senderUid] : null;
                        const resolvedAvatar = (friendEntry && friendEntry.avatar)
                            || (peerOnlineMeta && peerOnlineMeta.avatar)
                            || (senderUid ? `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(senderUid)}` : '');
                        const senderDisplayName = chat.name || (friendEntry && (friendEntry.nickname || friendEntry.name)) || chatTr('newMessageTitle', '新訊息');
                        if (isNotificationTypeEnabled('friendMsg') && !isChatMuted(chat.id)) {
                            pushLineStackNotification({
                                kind: 'message',
                                dedupeKey: `msg_${chat.id}_${updatedMs}`,
                                title: senderDisplayName,
                                tag: isGroupChat ? chatTr('lineNotifGroupTag', '群組訊息') : chatTr('lineNotifFriendTag', '好友訊息'),
                                preview: chat.lastMessage || chatTr('newMessageSentFallback', '傳送了一則新訊息'),
                                avatar: resolvedAvatar,
                                timestamp: formatLineNotifTime(updatedMs || Date.now()),
                                chatId: chat.id,
                                chatName: chat.name || senderDisplayName
                            });
                        }
                        dispatchSystemNotification({
                            type: 'friendMsg',
                            title: chat.name || '新訊息',
                            body: chat.lastMessage || '傳送了一則新訊息',
                            extra: { type: 'friendMsg', chatId: chat.id, chatName: chat.name || '' }
                        });
                    }
                }
            });
        }

        updateUnreadBadgeUI();
        const chatsView = document.getElementById('chatsView');
        if (chatsView && !chatsView.classList.contains('hidden')) {
            renderChatThreads(false);
        }
    });

    if (announcementsListener) rtdb.ref('announcements').off('value', announcementsListener);
    announcementsListener = rtdb.ref('announcements').on('value', snapshot => {
        const data = snapshot.val() || {};
        cloudAnnouncements = Object.keys(data)
            .map(key => ({ id: key, ...data[key] }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        window.appAnnouncements = cloudAnnouncements;

        if (!_annBaselineReady) {
            cloudAnnouncements.forEach(ann => { if (ann.id) _knownAnnouncementIds.add(ann.id); });
            _annBaselineReady = true;
        } else {
            cloudAnnouncements.forEach(ann => {
                if (!ann || !ann.id || _knownAnnouncementIds.has(ann.id)) return;
                _knownAnnouncementIds.add(ann.id);
                const createdMs = toChatTimestampMs(ann.createdAt) || Date.now();
                if (createdMs >= _notifSessionStartedAt - 5000) {
                    if (isNotificationTypeEnabled('announcements')) {
                        pushLineStackNotification({
                            kind: 'announcement',
                            dedupeKey: `ann_${ann.id}`,
                            title: ann.title || chatTr('lineNotifAnnounceDefaultTitle', '最新系統公告'),
                            tag: chatTr('lineNotifAnnounceTag', '系統公告'),
                            preview: ann.content || chatTr('lineNotifAnnouncePreviewFallback', '點擊查看官方最新公告內容'),
                            timestamp: formatLineNotifTime(createdMs),
                            annId: ann.id
                        });
                    }
                    dispatchSystemNotification({
                        type: 'announcements',
                        title: ann.title || '最新系統公告',
                        body: ann.content || '點擊查看官方最新公告內容',
                        extra: { type: 'announcements', annId: ann.id }
                    });
                }
            });
        }

        updateUnreadBadgeUI();
        const noticeView = document.getElementById('noticeView');
        if (noticeView && !noticeView.classList.contains('hidden')) {
            renderAnnouncements();
        }
    });
}

/**
 * 🔌 清理所有 RTDB 即時監聽器與心跳定時器（供註銷帳號、登出與搶登時使用）
 */
function detachChatRealtimeListeners(options = {}) {
    if (presenceHeartbeatTimer) {
        clearInterval(presenceHeartbeatTimer);
        presenceHeartbeatTimer = null;
    }
    if (onlineUiRefreshTimer) {
        clearInterval(onlineUiRefreshTimer);
        onlineUiRefreshTimer = null;
    }

    const rtdb = getRtdb();
    if (rtdb) {
        if (presenceStatusListener) {
            rtdb.ref('status').off('value', presenceStatusListener);
            presenceStatusListener = null;
        }
        if (connectedStateListener) {
            rtdb.ref('.info/connected').off('value', connectedStateListener);
            connectedStateListener = null;
        }
        if (friendRequestsListener) {
            rtdb.ref('friendRequests').off('value', friendRequestsListener);
            friendRequestsListener = null;
        }
        if (groupInvitesListener) {
            rtdb.ref('groupInvites').off('value', groupInvitesListener);
            groupInvitesListener = null;
        }
        if (chatsListListener) {
            rtdb.ref('chats').off('value', chatsListListener);
            chatsListListener = null;
        }
        if (announcementsListener) {
            rtdb.ref('announcements').off('value', announcementsListener);
            announcementsListener = null;
        }
        if (activeChatListener && currentActiveChatId) {
            rtdb.ref(`chats/${currentActiveChatId}/messages`).off('value', activeChatListener);
            activeChatListener = null;
        }
        if (activeChatReadListener && currentActiveChatId) {
            rtdb.ref(`chats/${currentActiveChatId}/readBy`).off('value', activeChatReadListener);
            activeChatReadListener = null;
        }
    }

    currentActiveChatId = null;
    currentActiveChatData = null;
    if (!options || !options.preserveRemoteStatus) {
        currentTrackedPresenceUid = null;
    } else {
        currentTrackedPresenceUid = null;
    }
    pendingRequestsList = [];
    pendingGroupInvitesList = [];
    userChatThreads = [];
    onlineUsersMap = {};
    chatReadByMap = {};
    currentChatMessages = [];

    _annBaselineReady = false;
    _knownAnnouncementIds.clear();
    _chatsBaselineReady = false;
    _prevChatUpdatedAtMap.clear();
    _friendReqBaselineReady = false;
    _knownFriendReqIds.clear();
    _groupInvBaselineReady = false;
    _knownGroupInvIds.clear();

    if (typeof updateUnreadBadgeUI === 'function') updateUnreadBadgeUI();
}
if (typeof window !== 'undefined') {
    window.detachChatRealtimeListeners = detachChatRealtimeListeners;
}

/**
 * 🕒 計算使用者「在線上 / 相對最後上線時間 (lastSeenAt)」狀態文案與樣式（支援隱私模式與管理員）
 */
function formatUserLastSeenStatus(targetUid, statusObj = null, options = {}) {
    const resolvedStatus = statusObj || (targetUid && onlineUsersMap[targetUid]) || {};
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const isSelf = Boolean(targetUid && currentUid && targetUid === currentUid);
    const isViewerAdmin = isChatUserAdmin();
    const myPrivacyHide = !isViewerAdmin && Boolean(window.userData && window.userData.privacyHideStatus);
    const targetHidePrivacy = Boolean(resolvedStatus && resolvedStatus.hidePrivacy);

    if (!isViewerAdmin && !isSelf && (myPrivacyHide || targetHidePrivacy)) {
        return {
            isOnline: false,
            isStealth: false,
            label: chatTr('statusOffline', '離線'),
            dotClass: 'bg-slate-300 dark:bg-slate-600',
            textClass: 'text-slate-400',
            badgeClass: 'bg-black/30 text-slate-100'
        };
    }

    const lastTs = toChatTimestampMs(resolvedStatus.lastSeenAt || resolvedStatus.last_changed || 0);
    const now = Date.now();
    const isFreshOnline = Boolean(
        resolvedStatus &&
        resolvedStatus.state === 'online' &&
        (isSelf || (lastTs > 0 && (now - lastTs) <= PRESENCE_TIMEOUT_MS))
    );

    if (isFreshOnline) {
        const isStealth = Boolean(isViewerAdmin && targetHidePrivacy && !isSelf);
        return {
            isOnline: true,
            isStealth,
            label: isStealth
                ? chatTr('statusOnlineStealth', '在線上 (隱身)')
                : chatTr('statusOnlineNow', '在線上'),
            dotClass: 'bg-emerald-500 animate-pulse',
            textClass: 'text-emerald-600 dark:text-emerald-400 font-bold',
            badgeClass: 'bg-emerald-500/90 text-white'
        };
    }

    if (lastTs > 0) {
        const diff = Math.max(0, now - lastTs);
        let label = chatTr('statusOffline', '離線');
        if (diff < 60000) {
            label = chatTr('lastSeenJustNow', '剛剛上線');
        } else if (diff < 3600000) {
            label = chatTr('lastSeenMinutesAgo', '{n} 分鐘前上線', { n: Math.max(1, Math.floor(diff / 60000)) });
        } else if (diff < 86400000) {
            label = chatTr('lastSeenHoursAgo', '{n} 小時前上線', { n: Math.max(1, Math.floor(diff / 3600000)) });
        } else if (diff < CHAT_MSG_RETENTION_MS) {
            label = chatTr('lastSeenDaysAgo', '{n} 天前上線', { n: Math.max(1, Math.floor(diff / 86400000)) });
        }
        return {
            isOnline: false,
            isStealth: false,
            label,
            dotClass: 'bg-slate-300 dark:bg-slate-600',
            textClass: 'text-slate-400',
            badgeClass: 'bg-black/35 text-slate-100'
        };
    }

    return {
        isOnline: false,
        isStealth: false,
        label: chatTr('statusOffline', '離線'),
        dotClass: 'bg-slate-300 dark:bg-slate-600',
        textClass: 'text-slate-400',
        badgeClass: 'bg-black/30 text-slate-100'
    };
}
if (typeof window !== 'undefined') {
    window.formatUserLastSeenStatus = formatUserLastSeenStatus;
}

/**
 * 👁️ 3. 渲染線上人數、線上名單、個人名片徽章與管理員透視面板 (支援 i18n 與 60 秒超時過濾)
 */
function renderOnlineStatusUI() {
    const onlineCountEl = document.getElementById('onlineUserCountText');
    const onlineListContainer = document.getElementById('onlineUsersListContainer');
    const adminMonitorContainer = document.getElementById('adminOnlineMonitorList');

    const isAdmin = isChatUserAdmin();
    const myPrivacyHide = !isAdmin && !!(window.userData && window.userData.privacyHideStatus);
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const now = Date.now();

    let visibleOnlineUsers = [];
    let allOnlineUsersForAdmin = [];

    Object.keys(onlineUsersMap).forEach(uid => {
        const userStatus = onlineUsersMap[uid];
        if (!userStatus || userStatus.state !== 'online') return;

        // 檢查最後心跳時間：本人永遠視為在線，其他帳號超過 60 秒無心跳則過濾掉（防止幽靈殘留）
        const lastTs = toChatTimestampMs(userStatus.lastSeenAt || userStatus.last_changed || 0);
        const isFresh = (uid === currentUid) || (lastTs > 0 && (now - lastTs) <= PRESENCE_TIMEOUT_MS);
        if (!isFresh) return;

        allOnlineUsersForAdmin.push({ uid, ...userStatus });

        const targetUserIsHidden = !!userStatus.hidePrivacy;

        if (isAdmin) {
            visibleOnlineUsers.push({ uid, ...userStatus });
        } else if (!myPrivacyHide && !targetUserIsHidden && !isUidBlocked(uid)) {
            visibleOnlineUsers.push({ uid, ...userStatus });
        }
    });

    if (onlineCountEl) {
        onlineCountEl.removeAttribute('data-i18n');
        if (myPrivacyHide) {
            const hiddenText = chatTr('onlineUserHidden', '線上人數：已隱藏 (隱私模式開啟中)');
            onlineCountEl.innerHTML = `<span class="w-2 h-2 bg-slate-400 rounded-full inline-block"></span> ${hiddenText}`;
        } else {
            const countText = chatTr('onlineUserCount', '線上人數：{count} 人', { count: visibleOnlineUsers.length });
            onlineCountEl.innerHTML = `<span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse inline-block"></span> ${countText}`;
        }
    }

    if (onlineListContainer) {
        if (myPrivacyHide) {
            onlineListContainer.innerHTML = `<div class="p-2 text-center text-slate-400 text-xs">${chatTr('privacyListNotice', '您已開啟隱私模式（無法查看他人狀態，他人亦無法查看您）')}</div>`;
        } else if (visibleOnlineUsers.length === 0) {
            onlineListContainer.innerHTML = `<div class="p-2 text-center text-slate-400 text-xs">${chatTr('onlineListEmpty', '目前沒有其他在線使用者')}</div>`;
        } else {
            onlineListContainer.innerHTML = visibleOnlineUsers.map(u => {
                const frameMeta = typeof getFrameMeta === 'function' ? getFrameMeta(u.frame || u.cosmetics?.frame || 'default') : { ringClass: 'ring-1 ring-slate-300 dark:ring-slate-600' };
                const fallbackAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(u.uid || u.nickname || 'player')}`;
                const avatarSrc = sanitizeChatUrl(u.avatar || fallbackAvatar, fallbackAvatar);
                const safeUid = escapeHTML(u.uid || '');
                const safeNick = escapeHTML(u.nickname || chatTr('defaultPlayerName', '玩家'));
                const memBadge = (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.renderBadgeHtml === 'function')
                    ? MembershipEngine.renderBadgeHtml(u, { size: '2xs' })
                    : '';
                return `
                    <button type="button" onclick="if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${safeUid}', '${encodeURIComponent(u.nickname || '')}')" class="w-full flex items-center justify-between space-x-2 p-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-xs transition cursor-pointer text-left group">
                        <div class="flex items-center space-x-2 min-w-0">
                            <div class="relative shrink-0">
                                <img src="${escapeHTML(avatarSrc)}" alt="${safeNick}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(fallbackAvatar)}');" class="w-6 h-6 rounded-full object-cover ${frameMeta.ringClass}">
                                <span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full ring-1 ring-white dark:ring-slate-800"></span>
                            </div>
                            <span class="font-bold text-slate-700 dark:text-slate-200 group-hover:text-brand-600 dark:group-hover:text-brand-400 truncate">${safeNick}</span>
                            ${memBadge}
                        </div>
                        <span class="text-[10px] text-slate-400 group-hover:text-brand-500 shrink-0"><i class="fa-regular fa-id-card"></i></span>
                    </button>
                `;
            }).join('');
        }
    }

    if (adminMonitorContainer && isAdmin) {
        adminMonitorContainer.innerHTML = allOnlineUsersForAdmin.map(u => `
            <div class="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700 text-xs my-1">
                <div class="flex items-center space-x-2">
                    <span class="w-2.5 h-2.5 bg-emerald-500 rounded-full"></span>
                    <div>
                        <div class="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                            <span>${escapeHTML(u.nickname)}</span>
                            ${u.hidePrivacy ? `<span class="px-1.5 py-0.2 bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 text-[9px] rounded-full font-semibold">${chatTr('badgeStealth', '開隱身')}</span>` : ''}
                        </div>
                        <p class="text-[10px] text-slate-400 font-mono">UID: ${u.uid}</p>
                    </div>
                </div>
                <span class="text-[10px] text-slate-400">${u.email || chatTr('noEmail', '無 Email')}</span>
            </div>
        `).join('');
    }

    // 即時更新好友列表內的「上線時間 / lastSeenAt」標籤（僅在顯示好友分頁時更新）
    const friendsView = document.getElementById('friendsView');
    const chatDrawer = document.getElementById('chatDrawer');
    if (chatDrawer && !chatDrawer.classList.contains('hidden') && friendsView && !friendsView.classList.contains('hidden')) {
        renderFriendsList();
    }

    // 若個人檔案名片 Modal 正在開啟，同步更新其中的在線狀態徽章
    const profileBadge = document.getElementById('playerProfileOnlineBadge');
    const profileModal = document.getElementById('playerProfileModal');
    if (profileBadge && profileModal && !profileModal.classList.contains('hidden')) {
        const badgeUid = profileBadge.getAttribute('data-uid') || '';
        if (badgeUid) {
            const stInfo = formatUserLastSeenStatus(badgeUid, onlineUsersMap[badgeUid] || null);
            profileBadge.className = `inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${stInfo.badgeClass} backdrop-blur-xs`;
            profileBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${stInfo.isOnline ? 'bg-white animate-pulse' : 'bg-slate-300'}"></span><span>${escapeHTML(stInfo.label)}</span>`;
        }
    }
}

// 🔄 前後台切換、切斷連線與關閉頁面生命週期監聽（加速上下線同步 + SessionGuard 協調）
function initPresenceLifecycleListeners() {
    if (_presenceLifecycleBound) return;
    _presenceLifecycleBound = true;

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (typeof SessionGuard !== 'undefined' && typeof SessionGuard.handleForegroundResume === 'function') {
                    SessionGuard.handleForegroundResume();
                }
                writeCurrentUserOnlineStatus();
                renderOnlineStatusUI();
            } else if (document.visibilityState === 'hidden') {
                if (typeof SessionGuard !== 'undefined' && typeof SessionGuard.handleBackgroundPause === 'function') {
                    SessionGuard.handleBackgroundPause();
                }
                setUserOfflineNow({ reason: 'visibility_hidden' });
            }
        });
    }

    if (typeof window !== 'undefined') {
        const handleExitOffline = (ev) => {
            setUserOfflineNow({ reason: ev ? ev.type : 'unload' });
        };
        window.addEventListener('pagehide', handleExitOffline);
        window.addEventListener('beforeunload', handleExitOffline);

        window.addEventListener('offline', () => {
            if (typeof SessionGuard !== 'undefined' && typeof SessionGuard.handleNetworkOffline === 'function') {
                SessionGuard.handleNetworkOffline();
            }
            renderOnlineStatusUI();
        });

        window.addEventListener('online', () => {
            if (typeof SessionGuard !== 'undefined' && typeof SessionGuard.handleNetworkOnline === 'function') {
                SessionGuard.handleNetworkOnline();
            }
            if (typeof document === 'undefined' || document.visibilityState === 'visible') {
                writeCurrentUserOnlineStatus();
            }
            renderOnlineStatusUI();
        });
    }
}
initPresenceLifecycleListeners();

/**
 * ⚙️ 4. 隱私控制：開關顯示線上狀態與已讀
 */
async function togglePrivacyHideStatus(enableHide) {
    if (!window.userData) window.userData = {};
    window.userData.privacyHideStatus = enableHide;

    if (typeof saveUserData === 'function') saveUserData();

    const currentUid = firebase.auth()?.currentUser?.uid;
    const rtdb = getRtdb();
    if (rtdb && currentUid) {
        try {
            await rtdb.ref(`status/${currentUid}/hidePrivacy`).set(enableHide);
            renderOnlineStatusUI();
            if (typeof showToast === 'function') {
                showToast(enableHide ? (typeof t === 'function' ? t('toastPrivacyOn') : '🔒 已開啟隱私模式：已隱藏您的線上狀態與已讀標記') : (typeof t === 'function' ? t('toastPrivacyOff') : '🌐 已關閉隱私模式：恢復公開線上狀態與已讀'), 'info');
            }
        } catch (e) {
            console.error("更新隱私設定失敗:", e);
        }
    }
}

function openChatDrawer(options = {}) {
    const isTourPreview = Boolean(options && options.tourPreview);
    if (!isTourPreview && isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredChat') : '請先登入帳號才能使用聊天功能！', 'warning');
        return;
    }

    const drawer = document.getElementById('chatDrawer');
    if (drawer) {
        drawer.classList.remove('hidden');
        initStaticLongPressBindings();
        syncChatNotificationMuteIndicators();
        if (typeof updateUserCoinsUI === 'function') updateUserCoinsUI();
        checkAdminPermissions();
        if (!isGuestUser()) {
            writeCurrentUserOnlineStatus();
        }
        renderOnlineStatusUI();
        switchChatTab((options && options.initialTab) ? options.initialTab : 'chats');
    }
}

function closeChatDrawer() {
    closeChatThreadContextMenu();
    const rtdb = getRtdb();
    if (activeChatListener && currentActiveChatId && rtdb) {
        rtdb.ref(`chats/${currentActiveChatId}/messages`).off('value', activeChatListener);
        if (activeChatReadListener) rtdb.ref(`chats/${currentActiveChatId}/readBy`).off('value', activeChatReadListener);
        activeChatListener = null;
        activeChatReadListener = null;
    }
    currentChatMessages = [];
    const drawer = document.getElementById('chatDrawer');
    if (drawer) drawer.classList.add('hidden');
}

let _currentLeaderboardMetric = 'rank'; // 'rank' | 'level'
let _leaderboardCache = { fetchedAt: 0, list: [] };

function setLeaderboardMetric(metric) {
    _currentLeaderboardMetric = metric === 'level' ? 'level' : 'rank';
    const rankBtn = document.getElementById('lbMetricRankBtn');
    const levelBtn = document.getElementById('lbMetricLevelBtn');
    const activeCls = 'px-3 py-1 rounded-lg text-[11px] font-extrabold bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-2xs cursor-pointer transition';
    const idleCls = 'px-3 py-1 rounded-lg text-[11px] font-extrabold text-slate-500 dark:text-slate-400 cursor-pointer transition';
    if (rankBtn) rankBtn.className = _currentLeaderboardMetric === 'rank' ? activeCls : idleCls;
    if (levelBtn) levelBtn.className = _currentLeaderboardMetric === 'level' ? activeCls : idleCls;
    loadAndRenderGlobalLeaderboard(_currentLeaderboardMetric, { force: false });
}

async function updateLeaderboardSeasonBannerUI() {
    const badgeEl = document.getElementById('leaderboardSeasonBadge');
    const schedEl = document.getElementById('leaderboardSeasonScheduleText');
    if (!badgeEl && !schedEl) return;

    let season = null;
    const workerBase = (typeof window !== 'undefined' && typeof window.SHARED_BACKEND_URL === 'string' && window.SHARED_BACKEND_URL)
        ? window.SHARED_BACKEND_URL.replace(/\/+$/, '')
        : 'https://lzhcard.tomlin980415.workers.dev';

    try {
        const res = await fetch(`${workerBase}/season/status`);
        const data = await res.json();
        if (data && data.ok && data.season) {
            season = data.season;
        }
    } catch (e) {}

    if (!season && typeof db !== 'undefined' && db) {
        try {
            const doc = await db.collection('systemConfig').doc('season').get();
            if (doc.exists) season = doc.data() || null;
        } catch (e) {}
    }

    const sNum = Math.max(1, Number(season?.seasonNumber) || 1);
    const lastResetAt = Number(season?.lastResetAt) || 0;
    const nextAt = Number(season?.nextScheduledResetAt) || 0;
    const autoEnabled = Boolean(season?.autoResetEnabled);

    if (badgeEl) {
        badgeEl.textContent = `🏆 第 ${sNum} 賽季`;
    }
    if (schedEl) {
        const now = Date.now();
        const fmtDate = (ms) => {
            const d = new Date(ms);
            return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
        };
        if (autoEnabled && nextAt > now) {
            const remDays = Math.max(1, Math.ceil((nextAt - now) / 86400000));
            schedEl.textContent = `預計 ${fmtDate(nextAt)} 重置（剩 ${remDays} 天）`;
        } else if (lastResetAt > 0) {
            schedEl.textContent = `上次重置：${fmtDate(lastResetAt)}`;
        } else {
            schedEl.textContent = '常規進行中（暫無排定重置）';
        }
    }
}

async function loadAndRenderGlobalLeaderboard(metric = null, options = {}) {
    const activeMetric = metric || _currentLeaderboardMetric || 'rank';
    const container = document.getElementById('leaderboardListContainer');
    if (!container) return;

    updateLeaderboardSeasonBannerUI().catch(() => {});

    if (typeof db === 'undefined' || !db) {
        container.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">雲端資料庫尚未連線，請稍後再試</div>`;
        return;
    }

    const now = Date.now();
    const useCache = !options?.force && _leaderboardCache.list.length > 0 && (now - _leaderboardCache.fetchedAt) < 45000;

    if (!useCache) {
        container.innerHTML = `<div class="py-10 text-center text-xs text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>正在載入全站排行榜...</div>`;
        try {
            const snap = await db.collection('publicProfiles').limit(80).get();
            _leaderboardCache = {
                fetchedAt: Date.now(),
                list: snap.docs.map(doc => ({ uid: doc.id, ...(doc.data() || {}) }))
            };
        } catch (e) {
            console.warn('載入全站排行榜失敗:', e);
            container.innerHTML = `<div class="py-10 text-center text-xs text-rose-500">載入排行榜失敗，請點擊右上角重新整理</div>`;
            return;
        }
    }

    const blockedSet = getBlockedUidsSet();
    const myUid = firebase.auth()?.currentUser?.uid || '';
    const rows = _leaderboardCache.list
        .filter(item => item && item.uid && !blockedSet.has(item.uid) && item.isBanned !== true)
        .map(item => {
            const st = item.stats || {};
            const rankPoints = Math.max(0, Number(st.rankPoints) || 0);
            const level = Math.max(1, Number(st.level) || 1);
            const xp = Math.max(0, Number(st.xp) || 0);
            const rankTier = String(st.rankTier || '青銅 III');
            return {
                uid: item.uid,
                nickname: item.nickname || '玩家',
                avatar: item.avatar || '',
                frame: item.cosmetics?.frame || 'default',
                membership: item.membership || null,
                isAnonymous: Boolean(item.hideOnLeaderboard),
                rankPoints,
                level,
                xp,
                rankTier
            };
        });

    rows.sort((a, b) => {
        if (activeMetric === 'level') {
            if (b.level !== a.level) return b.level - a.level;
            if (b.xp !== a.xp) return b.xp - a.xp;
            return b.rankPoints - a.rankPoints;
        }
        if (b.rankPoints !== a.rankPoints) return b.rankPoints - a.rankPoints;
        if (b.level !== a.level) return b.level - a.level;
        return b.xp - a.xp;
    });

    const topRows = rows.slice(0, 50);
    if (topRows.length === 0) {
        container.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">目前尚無全站玩家紀錄</div>`;
        return;
    }

    container.innerHTML = topRows.map((p, index) => {
        const rankNum = index + 1;
        const rankColor = rankNum === 1
            ? 'text-amber-500'
            : (rankNum === 2 ? 'text-slate-400 dark:text-slate-300' : (rankNum === 3 ? 'text-amber-700 dark:text-amber-500' : 'text-slate-400'));
        const isMe = Boolean(myUid && p.uid === myUid);
        const maskForViewer = Boolean(p.isAnonymous && !isMe);
        const fallbackAvatar = maskForViewer
            ? 'https://api.dicebear.com/7.x/shapes/svg?seed=anonymous'
            : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(p.uid)}`;
        const avatarSrc = maskForViewer ? fallbackAvatar : sanitizeChatUrl(p.avatar || fallbackAvatar, fallbackAvatar);
        const frameMeta = maskForViewer
            ? { ringClass: 'ring-1 ring-slate-200 dark:ring-slate-700' }
            : (typeof getFrameMeta === 'function' ? getFrameMeta(p.frame) : { ringClass: 'ring-1 ring-slate-200 dark:ring-slate-700' });
        const memBadge = (!maskForViewer && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.renderBadgeHtml === 'function')
            ? MembershipEngine.renderBadgeHtml(p.membership, { size: '2xs' })
            : '';
        const displayLabel = maskForViewer
            ? '匿名玩家'
            : `${p.nickname}${isMe ? '（我）' : ''}`;
        const selfAnonBadge = (isMe && p.isAnonymous)
            ? `<span class="px-1.5 py-0.5 rounded-full text-[9px] font-extrabold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 shrink-0">已匿名</span>`
            : '';
        const primaryMetric = activeMetric === 'level'
            ? `Lv.${p.level}`
            : `${p.rankPoints.toLocaleString()} 分`;
        const secondaryMetric = activeMetric === 'level'
            ? `${p.xp.toLocaleString()} XP · ${p.rankTier}`
            : `${p.rankTier} · Lv.${p.level}`;
        const rowOnClick = maskForViewer
            ? `if(typeof showToast==='function') showToast('此玩家已在排行榜開啟匿名顯示', 'info');`
            : `if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${escapeHTML(p.uid)}', '${encodeURIComponent(p.nickname)}');`;

        return `
            <button type="button" onclick="${rowOnClick}"
                class="leaderboard-row w-full min-h-[52px] py-2.5 px-1.5 flex items-center justify-between gap-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700/40 transition cursor-pointer ${isMe ? 'bg-brand-50/40 dark:bg-brand-950/20' : ''}">
                <div class="flex items-center gap-2.5 min-w-0">
                    <span class="w-6 text-center text-xs font-black ${rankColor} shrink-0">${rankNum}</span>
                    <img src="${escapeHTML(avatarSrc)}" alt="${escapeHTML(displayLabel)}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(fallbackAvatar)}');" class="w-8 h-8 rounded-full object-cover shrink-0 ${frameMeta.ringClass}">
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5">
                            <span class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${escapeHTML(displayLabel)}</span>
                            ${selfAnonBadge}
                            ${memBadge}
                        </div>
                        <div class="text-[10.5px] text-slate-400 truncate">${escapeHTML(secondaryMetric)}</div>
                    </div>
                </div>
                <span class="text-xs font-extrabold ${rankNum <= 3 ? 'text-brand-600 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300'} shrink-0">${escapeHTML(primaryMetric)}</span>
            </button>
        `;
    }).join('');
}

function switchChatTab(tab) {
    closeChatThreadContextMenu();
    syncChatNotificationMuteIndicators();
    const rtdb = getRtdb();
    if (activeChatListener && currentActiveChatId && rtdb) {
        rtdb.ref(`chats/${currentActiveChatId}/messages`).off('value', activeChatListener);
        if (activeChatReadListener) rtdb.ref(`chats/${currentActiveChatId}/readBy`).off('value', activeChatReadListener);
        activeChatListener = null;
        activeChatReadListener = null;
    }

    const noticeView = document.getElementById('noticeView');
    const leaderboardView = document.getElementById('leaderboardView');
    const chatsView = document.getElementById('chatsView');
    const friendsView = document.getElementById('friendsView');
    const activeChatWindow = document.getElementById('activeChatWindow');
    const adminReportsContainer = document.getElementById('adminReportsContainer');

    const tabNoticeBtn = document.getElementById('tabNoticeBtn');
    const tabLeaderboardBtn = document.getElementById('tabLeaderboardBtn');
    const tabChatsBtn = document.getElementById('tabChatsBtn');
    const tabFriendsBtn = document.getElementById('tabFriendsBtn');
    const tabAdminBtn = document.getElementById('tabAdminBtn');

    [noticeView, leaderboardView, chatsView, friendsView, activeChatWindow].forEach(el => el && el.classList.add('hidden'));
    if (adminReportsContainer) adminReportsContainer.classList.add('hidden');

    const defaultBtnClass = "flex-1 py-3 text-center text-slate-400 border-b-2 border-transparent font-bold text-xs transition";
    if (tabNoticeBtn) tabNoticeBtn.className = defaultBtnClass;
    if (tabLeaderboardBtn) tabLeaderboardBtn.className = defaultBtnClass;
    if (tabChatsBtn) tabChatsBtn.className = defaultBtnClass;
    if (tabFriendsBtn) tabFriendsBtn.className = defaultBtnClass;
    if (tabAdminBtn) tabAdminBtn.className = "hidden flex-1 py-3 text-center text-rose-500 border-b-2 border-transparent font-bold text-xs transition";

    checkAdminPermissions();
    const isAdmin = isChatUserAdmin();

    if (tab === 'notice') {
        if (noticeView) noticeView.classList.remove('hidden');
        if (tabNoticeBtn) tabNoticeBtn.className = "flex-1 py-3 text-center border-b-2 border-brand-600 text-brand-600 font-bold text-xs";
        localStorage.setItem('lzhcard_last_read_announcements', Date.now().toString());
        updateUnreadBadgeUI();
        renderAnnouncements();
    } else if (tab === 'leaderboard') {
        if (leaderboardView) leaderboardView.classList.remove('hidden');
        if (tabLeaderboardBtn) tabLeaderboardBtn.className = "flex-1 py-3 text-center border-b-2 border-brand-600 text-brand-600 font-bold text-xs";
        loadAndRenderGlobalLeaderboard(_currentLeaderboardMetric, { force: false });
    } else if (tab === 'chats') {
        if (chatsView) chatsView.classList.remove('hidden');
        if (tabChatsBtn) tabChatsBtn.className = "flex-1 py-3 text-center border-b-2 border-brand-600 text-brand-600 font-bold text-xs";
        renderChatThreads(false);
    } else if (tab === 'friends') {
        if (friendsView) friendsView.classList.remove('hidden');
        if (tabFriendsBtn) tabFriendsBtn.className = "flex-1 py-3 text-center border-b-2 border-brand-600 text-brand-600 font-bold text-xs";
        renderFriendsList();
    } else if (tab === 'admin') {
        if (isAdmin) {
            if (chatsView) chatsView.classList.remove('hidden');
            if (tabAdminBtn) tabAdminBtn.className = "flex-1 py-3 text-center border-b-2 border-rose-600 text-rose-600 font-bold text-xs";
            renderChatThreads(true);
            loadAdminModerationReports();
        } else {
            switchChatTab('chats');
        }
    }
}

let chatSearchDebounceTimer = null;
function debouncedHandleChatSearch(delayMs = 180) {
    if (chatSearchDebounceTimer) clearTimeout(chatSearchDebounceTimer);
    chatSearchDebounceTimer = setTimeout(() => {
        chatSearchDebounceTimer = null;
        handleChatSearch();
    }, Math.max(0, Number(delayMs) || 180));
}

function handleChatSearch() {
    const searchInput = document.getElementById('chatSearchInput');
    chatSearchQuery = (searchInput?.value || '').trim().toLowerCase();

    const friendsView = document.getElementById('friendsView');
    if (friendsView && !friendsView.classList.contains('hidden')) {
        renderFriendsList();
    } else {
        const isAdmin = isChatUserAdmin();
        const tabAdminBtn = document.getElementById('tabAdminBtn');
        const isInspectorMode = isAdmin && tabAdminBtn && tabAdminBtn.className.includes('border-rose-600');
        renderChatThreads(isInspectorMode);
    }
}

function formatFriendThreadTime(ts) {
    const ms = toChatTimestampMs(ts);
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const isSameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (isSameDay) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function openFriendDirectChat(encodedTargetUsername, targetUid = '') {
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const cleanUid = String(targetUid || '').trim();
    let decodedName = '';
    try { decodedName = decodeURIComponent(encodedTargetUsername || ''); } catch (e) { decodedName = encodedTargetUsername || ''; }
    if (currentUid && cleanUid) {
        const chatId = [currentUid, cleanUid].sort().join('_');
        if (isChatDeleted(chatId)) {
            setChatDeleted(chatId, false, { silentSync: true });
        }
    }
    return startPrivateChat(encodedTargetUsername || encodeURIComponent(decodedName), cleanUid);
}
if (typeof window !== 'undefined') {
    window.openFriendDirectChat = openFriendDirectChat;
}

async function renderFriendsList() {
    const container = document.getElementById('friendsListContainer');
    if (!container) return;

    const friends = (window.userData && window.userData.friends) ? window.userData.friends : [];
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const query = chatSearchQuery;

    let html = '';

    if (pendingRequestsList.length > 0) {
        html += `
            <div class="mb-3 p-3 bg-amber-50/80 dark:bg-amber-950/40 rounded-xl border border-amber-200 dark:border-amber-800">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                        <i class="fa-solid fa-user-clock text-amber-600"></i>
                        <span>${chatTr('pendingRequests', '好友申請')} (${pendingRequestsList.length})</span>
                    </span>
                </div>
                <div class="space-y-2">
        `;
        html += pendingRequestsList.map(req => {
            const reqFallbackAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(req.fromNickname || req.fromUid || 'user')}`;
            const safeReqAvatar = escapeHTML(sanitizeChatUrl(req.fromAvatar || reqFallbackAvatar, reqFallbackAvatar));
            const safeReqId = escapeHTML(req.id || '');
            const safeFromUid = escapeHTML(req.fromUid || '');
            const safeFromEmail = escapeHTML(req.fromEmail || '');
            return `
            <div class="p-2.5 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                <button type="button" onclick="if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${safeFromUid}', '${encodeURIComponent(req.fromNickname || '')}')" class="flex items-center space-x-2.5 text-left min-w-0 group cursor-pointer">
                    <img src="${safeReqAvatar}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(reqFallbackAvatar)}');" class="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 object-cover shrink-0">
                    <div class="min-w-0">
                        <h4 class="font-bold text-xs text-slate-800 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition truncate">${escapeHTML(req.fromNickname)}</h4>
                        <p class="text-[10px] text-slate-400 font-mono truncate">${safeFromEmail}</p>
                    </div>
                </button>
                <div class="flex items-center space-x-1.5 shrink-0">
                    <button type="button" onclick="handleAcceptFriendRequest('${safeReqId}', '${safeFromUid}', '${encodeURIComponent(req.fromNickname || '')}', '${safeFromEmail}', '${encodeURIComponent(sanitizeChatUrl(req.fromAvatar || '', ''))}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-lg transition shadow-2xs cursor-pointer">
                        ${chatTr('btnAccept', '接受')}
                    </button>
                    <button type="button" onclick="handleRejectFriendRequest('${safeReqId}')" class="px-2.5 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-rose-500 hover:text-white text-slate-600 dark:text-slate-300 text-[11px] font-bold rounded-lg transition cursor-pointer">
                        ${chatTr('btnReject', '拒絕')}
                    </button>
                </div>
            </div>
        `;
        }).join('');
        html += `</div></div>`;
    }

    if (pendingGroupInvitesList.length > 0) {
        html += `
            <div class="mb-3 p-3 bg-purple-50/80 dark:bg-purple-950/40 rounded-xl border border-purple-200 dark:border-purple-800">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-bold text-purple-800 dark:text-purple-300 flex items-center gap-1.5">
                        <i class="fa-solid fa-users-rectangle text-purple-600"></i>
                        <span>${chatTr('pendingGroupInvites', '群組邀請')} (${pendingGroupInvitesList.length})</span>
                    </span>
                </div>
                <div class="space-y-2">
        `;
        html += pendingGroupInvitesList.map(inv => {
            const safeInvId = escapeHTML(inv.id || '');
            const inviteType = inv.inviteType === 'raid' ? 'raid' : 'group';
            const targetId = inviteType === 'raid' ? (inv.raidCode || inv.groupId || '') : (inv.groupId || '');
            const safeTargetId = escapeHTML(targetId);
            const titleLabel = inv.groupName || (inviteType === 'raid' ? '四人共鬥打王' : '聊天群組');
            const badgeIcon = inviteType === 'raid' ? 'fa-dragon text-rose-500' : 'fa-users text-purple-500';
            const subTag = inviteType === 'raid' ? `打王房號 ${escapeHTML(targetId)}` : '聊天群組邀請';
            return `
            <div class="p-2.5 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                <div class="min-w-0">
                    <h4 class="font-bold text-xs text-slate-800 dark:text-slate-100 flex items-center gap-1 truncate">
                        <i class="fa-solid ${badgeIcon} text-[10px] shrink-0"></i>
                        <span class="truncate">${escapeHTML(titleLabel)}</span>
                    </h4>
                    <p class="text-[10px] text-slate-400 mt-0.5 truncate">${subTag} · ${chatTr('inviter', '邀請者：')}<span class="font-semibold text-slate-600 dark:text-slate-300">${escapeHTML(inv.inviterNickname)}</span></p>
                </div>
                <div class="flex items-center space-x-1.5 shrink-0">
                    <button type="button" onclick="handleAcceptGroupInvite('${safeInvId}', '${safeTargetId}', '${encodeURIComponent(titleLabel)}', '${inviteType}')" class="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-bold rounded-lg transition shadow-2xs cursor-pointer">
                        ${chatTr('btnJoin', '加入')}
                    </button>
                    <button type="button" onclick="handleRejectGroupInvite('${safeInvId}')" class="px-2.5 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-rose-500 hover:text-white text-slate-600 dark:text-slate-300 text-[11px] font-bold rounded-lg transition cursor-pointer">
                        ${chatTr('btnReject', '拒絕')}
                    </button>
                </div>
            </div>
        `;
        }).join('');
        html += `</div></div>`;
    }

    if (query.includes('@') && !friends.some(f => f.email && f.email.toLowerCase() === query)) {
        html += `
            <div onclick="sendFriendRequestByEmail('${escapeHTML(query)}', this)" class="p-3 bg-brand-50 dark:bg-brand-950/40 rounded-xl border border-brand-200 dark:border-brand-800 hover:bg-brand-100 transition cursor-pointer flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2 text-brand-700 dark:text-brand-300">
                    <i class="fa-solid fa-paper-plane text-sm"></i>
                    <span class="text-xs font-bold">${chatTr('sendFriendReqTo', '發送好友申請給：')}${escapeHTML(query)}</span>
                </div>
                <span class="text-xs font-bold bg-brand-600 text-white px-2 py-0.5 rounded-lg">${chatTr('btnSendReq', '發送申請')}</span>
            </div>
        `;
    } else if (query && !query.includes('@') && typeof db !== 'undefined' && db && !isGuestUser()) {
        const searchSnapshot = query;
        const normKey = typeof window.normalizeNicknameKey === 'function'
            ? window.normalizeNicknameKey(searchSnapshot)
            : searchSnapshot.trim().toLowerCase();
        if (normKey) {
            try {
                const blockedSet = getBlockedUidsSet();
                const friendUidSet = new Set(friends.map(f => f && f.uid).filter(Boolean));
                const matchedPlayersMap = new Map();

                const [idxSnap, pubSnap] = await Promise.all([
                    db.collection('nicknameIndex').doc(normKey).get().catch(() => null),
                    db.collection('publicProfiles')
                        .where('nicknameLower', '>=', normKey)
                        .where('nicknameLower', '<=', normKey + '\uf8ff')
                        .limit(8)
                        .get()
                        .catch(() => null)
                ]);

                if (chatSearchQuery !== searchSnapshot) return;

                if (pubSnap && !pubSnap.empty) {
                    pubSnap.docs.forEach(doc => {
                        const d = doc.data() || {};
                        if (!doc.id || doc.id === currentUid || d.isBanned === true || blockedSet.has(doc.id) || friendUidSet.has(doc.id)) return;
                        matchedPlayersMap.set(doc.id, {
                            uid: doc.id,
                            nickname: d.nickname || '玩家',
                            avatar: d.avatar || '',
                            stats: d.stats || {}
                        });
                    });
                }

                if (idxSnap && idxSnap.exists) {
                    const idxData = idxSnap.data() || {};
                    const idxUid = String(idxData.uid || '').trim();
                    if (idxUid && idxUid !== currentUid && !blockedSet.has(idxUid) && !friendUidSet.has(idxUid) && !matchedPlayersMap.has(idxUid)) {
                        const pDoc = await db.collection('publicProfiles').doc(idxUid).get().catch(() => null);
                        const pd = (pDoc && pDoc.exists) ? (pDoc.data() || {}) : {};
                        if (pd.isBanned !== true) {
                            matchedPlayersMap.set(idxUid, {
                                uid: idxUid,
                                nickname: pd.nickname || idxData.nickname || searchSnapshot,
                                avatar: pd.avatar || '',
                                stats: pd.stats || {}
                            });
                        }
                    }
                }

                const matchedList = Array.from(matchedPlayersMap.values());
                if (matchedList.length > 0) {
                    html += `
                        <div class="mb-3 p-3 bg-indigo-50/80 dark:bg-indigo-950/40 rounded-xl border border-indigo-200 dark:border-indigo-800 space-y-2">
                            <div class="text-[11px] font-extrabold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <span>全站玩家暱稱搜尋結果 (${matchedList.length})</span>
                            </div>
                            <div class="space-y-1.5">
                                ${matchedList.map(mp => {
                                    const fbAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(mp.uid)}`;
                                    const safeAv = escapeHTML(sanitizeChatUrl(mp.avatar || fbAvatar, fbAvatar));
                                    const lv = Math.max(1, Number(mp.stats?.level) || 1);
                                    const rt = String(mp.stats?.rankTier || '青銅 III');
                                    return `
                                        <div class="p-2 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                                            <button type="button" onclick="if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${escapeHTML(mp.uid)}', '${encodeURIComponent(mp.nickname)}')" class="flex items-center gap-2 min-w-0 text-left cursor-pointer">
                                                <img src="${safeAv}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(fbAvatar)}');" class="w-8 h-8 rounded-full object-cover shrink-0">
                                                <div class="min-w-0">
                                                    <div class="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">${escapeHTML(mp.nickname)}</div>
                                                    <div class="text-[10px] text-slate-400 truncate">Lv.${lv} · ${escapeHTML(rt)}</div>
                                                </div>
                                            </button>
                                            <button type="button" onclick="sendFriendRequestByUid('${escapeHTML(mp.uid)}', '${escapeHTML(mp.nickname)}', '${escapeHTML(mp.avatar || '')}')" class="px-2.5 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-bold rounded-lg shrink-0 cursor-pointer">
                                                加好友
                                            </button>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `;
                }
            } catch (e) {}
        }
    }

    const filteredFriends = friends.filter(f =>
        (f.nickname || f.username || '').toLowerCase().includes(query) ||
        (f.email && f.email.toLowerCase().includes(query))
    );

    if (filteredFriends.length === 0 && !html) {
        container.innerHTML = `<div class="text-center text-slate-400 py-8 text-xs">${chatTr('noFriendsFound', `查無符合「${escapeHTML(query)}」的好友`, { query: escapeHTML(query) })}</div>`;
        return;
    }

    if (filteredFriends.length > 0) {
        html += `<div class="text-[11px] font-bold text-slate-500 mb-1.5 flex items-center justify-between">
            <span>${chatTr('lblMyFriends', '我的好友列表')} (${filteredFriends.length})</span>
            <span class="text-[10px] font-semibold text-brand-600 dark:text-brand-400">${chatTr('friendRoomPersistentHint', '1v1 常駐聊天室')}</span>
        </div>`;
        html += filteredFriends.map(f => {
            const displayName = f.nickname || f.username || chatTr('defaultPlayerName', '好友');
            const liveStatus = (f.uid && onlineUsersMap[f.uid]) ? onlineUsersMap[f.uid] : null;
            const statusInfo = formatUserLastSeenStatus(f.uid, liveStatus);
            const frameId = liveStatus?.frame || liveStatus?.cosmetics?.frame || 'default';
            const frameMeta = typeof getFrameMeta === 'function' ? getFrameMeta(frameId) : { ringClass: 'border border-slate-200 dark:border-slate-700' };
            const friendFallbackAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(f.uid || displayName)}`;
            const avatarSrc = sanitizeChatUrl(f.avatar || liveStatus?.avatar || friendFallbackAvatar, friendFallbackAvatar);

            // 📌 常駐 1-to-1 私人聊天室資料（無論目前無訊息、30天自動清空或曾經移除清單，均永遠保留入口）
            const pairChatId = (currentUid && f.uid)
                ? [currentUid, f.uid].sort().join('_')
                : ('chat_private_' + encodeURIComponent(displayName));
            const existingThread = userChatThreads.find(th => th && th.id === pairChatId) || null;
            const hasUnread = existingThread ? isThreadUnread(existingThread, currentUid, { ignoreDeleted: true }) : false;
            const previewMsg = (existingThread && existingThread.lastMessage)
                ? existingThread.lastMessage
                : chatTr('friendPersistentChatPlaceholder', '常駐 1對1 聊天室・點擊立即傳送訊息');
            const timeLabel = existingThread && existingThread.updatedAt
                ? formatFriendThreadTime(existingThread.updatedAt)
                : '';

            const safeFriendUid = escapeHTML(f.uid || '');
            const encodedName = encodeURIComponent(displayName);
            const friendMemBadge = (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.renderBadgeHtml === 'function')
                ? MembershipEngine.renderBadgeHtml(liveStatus, { size: '2xs' })
                : '';

            return `
                <div class="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 hover:border-brand-300 dark:hover:border-brand-700 transition mb-2.5 space-y-2 shadow-2xs">
                    <div class="flex justify-between items-center gap-2">
                        <button type="button" onclick="if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${safeFriendUid}', '${encodedName}')" class="flex items-center space-x-3 text-left min-w-0 group cursor-pointer">
                            <div class="relative shrink-0">
                                <img src="${escapeHTML(avatarSrc)}" alt="${escapeHTML(displayName)}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(friendFallbackAvatar)}');" class="w-9 h-9 rounded-full object-cover ${frameMeta.ringClass}">
                                <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 ${statusInfo.dotClass} rounded-full ring-2 ring-white dark:ring-slate-900"></span>
                            </div>
                            <div class="min-w-0">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <h4 class="font-bold text-xs text-slate-800 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition truncate">${escapeHTML(displayName)}</h4>
                                    ${friendMemBadge}
                                    <span class="text-[10px] ${statusInfo.textClass} shrink-0">· ${escapeHTML(statusInfo.label)}</span>
                                </div>
                                ${f.email ? `<p class="text-[10px] text-slate-400 font-mono truncate">${escapeHTML(f.email)}</p>` : ''}
                            </div>
                        </button>
                        <button type="button" onclick="openFriendDirectChat('${encodedName}', '${safeFriendUid}')" class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-lg transition shadow-xs flex items-center space-x-1 shrink-0 cursor-pointer relative">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span>${chatTr('btnEnterFriendChat', '進入聊天室')}</span>
                            ${hasUnread ? `<span class="w-2 h-2 bg-rose-400 rounded-full ring-2 ring-white dark:ring-slate-900 ml-0.5"></span>` : ''}
                        </button>
                    </div>
                    <button type="button" onclick="openFriendDirectChat('${encodedName}', '${safeFriendUid}')" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/80 hover:bg-brand-50/70 dark:hover:bg-brand-950/30 border border-slate-100 dark:border-slate-700/80 flex items-center justify-between gap-2 text-left transition cursor-pointer">
                        <div class="flex items-center gap-1.5 min-w-0">
                            <i class="fa-regular fa-comments text-[11px] text-brand-500 shrink-0"></i>
                            <span class="text-[11px] text-slate-500 dark:text-slate-300 truncate">${escapeHTML(previewMsg)}</span>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            ${timeLabel ? `<span class="text-[9px] text-slate-400 font-mono">${escapeHTML(timeLabel)}</span>` : ''}
                            ${hasUnread ? `<span class="px-1.5 py-0.2 bg-rose-500 text-white text-[9px] font-extrabold rounded-full">${chatTr('badgeUnread', '未讀')}</span>` : ''}
                        </div>
                    </button>
                </div>
            `;
        }).join('');
    }

    container.innerHTML = html;
}

async function sendFriendRequestByEmail(emailInput = null, btnElem = null) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredFriend') : '請先登入帳號才能發送好友申請！', 'warning');
        return;
    }

    const rtdb = getRtdb();
    if (!rtdb) return;

    try {
        const targetEmail = (emailInput || prompt(typeof t === 'function' ? t('promptEnterFriendEmail') : '請輸入對方的電子郵件 (Email)：') || '').trim().toLowerCase();
        if (!targetEmail || !targetEmail.includes('@')) {
            if (targetEmail && typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastInvalidEmail') : '請輸入有效的電子郵件格式！', 'warning');
            return;
        }

        const currentUid = firebase.auth().currentUser.uid;
        const myName = (window.userData && window.userData.nickname) ? window.userData.nickname : (firebase.auth().currentUser?.displayName || (typeof t === 'function' ? t('defaultPlayerName') : '使用者'));
        const myEmail = firebase.auth().currentUser.email;

        const newReqRef = rtdb.ref('friendRequests').push();
        await newReqRef.set({
            fromUid: currentUid,
            fromNickname: myName,
            fromEmail: myEmail,
            fromAvatar: (typeof window !== 'undefined' && typeof window.resolveAuthUserPhotoUrl === 'function')
                ? window.resolveAuthUserPhotoUrl(firebase.auth().currentUser, window.userData)
                : (firebase.auth().currentUser?.photoURL || (window.userData && window.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUid)}`),
            toEmail: targetEmail,
            toUid: '',
            status: 'pending',
            createdAt: Date.now()
        });

        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastFriendReqSent') : '🎉 已成功發送好友申請！', 'success');
    } catch (e) {
        console.error("發送好友申請失敗:", e);
    }
}

async function sendFriendRequestByNicknameOrEmail(rawInput = null, btnElem = null) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredFriend') : '請先登入帳號才能發送好友申請！', 'warning');
        return false;
    }

    const entered = (rawInput || prompt('請輸入對方的「暱稱」或「電子郵件 (Email)」：') || '').trim();
    if (!entered) return false;

    if (entered.includes('@')) {
        return sendFriendRequestByEmail(entered, btnElem);
    }

    if (typeof db === 'undefined' || !db) {
        if (typeof showToast === 'function') showToast('雲端資料庫尚未就緒，請稍後再試', 'warning');
        return false;
    }

    const normKey = typeof window.normalizeNicknameKey === 'function'
        ? window.normalizeNicknameKey(entered)
        : entered.toLowerCase();
    const currentUid = firebase.auth()?.currentUser?.uid || '';

    try {
        let matchedUid = '';
        let matchedName = entered;
        let matchedAvatar = '';

        const idxDoc = await db.collection('nicknameIndex').doc(normKey).get();
        if (idxDoc.exists) {
            const idxData = idxDoc.data() || {};
            matchedUid = String(idxData.uid || '').trim();
            if (idxData.nickname) matchedName = String(idxData.nickname);
        }

        if (!matchedUid) {
            const pubQuery = await db.collection('publicProfiles').where('nicknameLower', '==', normKey).limit(1).get();
            if (!pubQuery.empty) {
                const d = pubQuery.docs[0];
                const data = d.data() || {};
                matchedUid = d.id;
                matchedName = data.nickname || matchedName;
                matchedAvatar = data.avatar || '';
            } else {
                const exactQuery = await db.collection('publicProfiles').where('nickname', '==', entered).limit(1).get();
                if (!exactQuery.empty) {
                    const d = exactQuery.docs[0];
                    const data = d.data() || {};
                    matchedUid = d.id;
                    matchedName = data.nickname || matchedName;
                    matchedAvatar = data.avatar || '';
                }
            }
        } else {
            const pDoc = await db.collection('publicProfiles').doc(matchedUid).get().catch(() => null);
            if (pDoc && pDoc.exists) {
                const pd = pDoc.data() || {};
                if (pd.isBanned === true) {
                    if (typeof showToast === 'function') showToast('無法對該玩家發送好友邀請', 'warning');
                    return false;
                }
                matchedName = pd.nickname || matchedName;
                matchedAvatar = pd.avatar || '';
            }
        }

        if (!matchedUid) {
            if (typeof showToast === 'function') showToast(`找不到暱稱為「${entered}」的玩家，請確認名稱或改用 Email 搜尋`, 'warning');
            return false;
        }
        if (matchedUid === currentUid) {
            if (typeof showToast === 'function') showToast('無法加自己為好友喔！', 'info');
            return false;
        }

        return await sendFriendRequestByUid(matchedUid, matchedName, matchedAvatar);
    } catch (e) {
        console.error('透過暱稱搜尋好友失敗:', e);
        if (typeof showToast === 'function') showToast('搜尋玩家失敗：' + e.message, 'error');
        return false;
    }
}
if (typeof window !== 'undefined') {
    window.sendFriendRequestByNicknameOrEmail = sendFriendRequestByNicknameOrEmail;
}

async function sendFriendRequestByUid(targetUid, targetName = '', targetAvatar = '') {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredFriend') : '請先登入帳號才能發送好友申請！', 'warning');
        return false;
    }

    const cleanTargetUid = (targetUid || '').trim();
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    if (!cleanTargetUid || !currentUid || cleanTargetUid === currentUid) return false;

    const friends = (window.userData && Array.isArray(window.userData.friends)) ? window.userData.friends : [];
    if (friends.some(f => f.uid === cleanTargetUid)) {
        if (typeof showToast === 'function') showToast('對方已經在您的好友名單中！', 'info');
        return false;
    }

    const rtdb = getRtdb();
    if (!rtdb) return false;

    try {
        // 防重複點擊與防重複發送檢查
        const snap = await rtdb.ref('friendRequests').once('value');
        const reqMap = snap.val() || {};
        const alreadyPending = Object.values(reqMap).some(r =>
            r && r.status === 'pending' && (
                (r.fromUid === currentUid && r.toUid === cleanTargetUid) ||
                (r.fromUid === cleanTargetUid && r.toUid === currentUid)
            )
        );

        if (alreadyPending) {
            if (typeof markOutgoingFriendRequestUid === 'function') markOutgoingFriendRequestUid(cleanTargetUid);
            if (typeof showToast === 'function') showToast('已有待處理的好友邀請，請勿重複發送！', 'info');
            return false;
        }

        const myName = (window.userData && window.userData.nickname) ? window.userData.nickname : (firebase.auth().currentUser?.displayName || (typeof t === 'function' ? t('defaultPlayerName') : '使用者'));
        const myEmail = firebase.auth().currentUser.email || '';
        const myAvatar = (typeof window !== 'undefined' && typeof window.resolveAuthUserPhotoUrl === 'function')
            ? window.resolveAuthUserPhotoUrl(firebase.auth().currentUser, window.userData)
            : (firebase.auth().currentUser?.photoURL || (window.userData && window.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUid)}`);

        const newReqRef = rtdb.ref('friendRequests').push();
        await newReqRef.set({
            fromUid: currentUid,
            fromNickname: myName,
            fromEmail: myEmail,
            fromAvatar: myAvatar,
            toUid: cleanTargetUid,
            toNickname: targetName || '',
            toAvatar: targetAvatar || '',
            toEmail: '',
            status: 'pending',
            createdAt: Date.now()
        });

        if (typeof markOutgoingFriendRequestUid === 'function') markOutgoingFriendRequestUid(cleanTargetUid);
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastFriendReqSent') : '🎉 已成功發送好友申請！', 'success');
        return true;
    } catch (e) {
        console.error("發送 UID 好友申請失敗:", e);
        if (typeof showToast === 'function') showToast('發送好友申請失敗：' + e.message, 'error');
        return false;
    }
}
if (typeof window !== 'undefined') {
    window.sendFriendRequestByUid = sendFriendRequestByUid;
}

async function handleAcceptFriendRequest(reqId, fromUid, encodedNickname, fromEmail, encodedAvatar) {
    const fromNickname = decodeURIComponent(encodedNickname);
    const fromAvatar = decodeURIComponent(encodedAvatar);
    const currentUser = firebase.auth()?.currentUser;
    const currentUid = currentUser ? currentUser.uid : '';
    const rtdb = getRtdb();
    if (!rtdb || !currentUid) return;

    const myNickname = (window.userData && window.userData.nickname)
        || currentUser?.displayName
        || (currentUser?.email ? currentUser.email.split('@')[0] : '')
        || chatTr('defaultPlayerName', '玩家');
    const myAvatar = (typeof window !== 'undefined' && typeof window.resolveAuthUserPhotoUrl === 'function')
        ? window.resolveAuthUserPhotoUrl(currentUser, window.userData)
        : (currentUser?.photoURL || (window.userData && window.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUid)}`);

    try {
        await rtdb.ref(`friendRequests/${reqId}`).update({
            status: 'accepted',
            toUid: currentUid,
            toNickname: myNickname,
            toAvatar: myAvatar,
            acceptedAt: Date.now()
        });

        if (!window.userData) window.userData = {};
        if (!window.userData.friends) window.userData.friends = [];

        if (!window.userData.friends.some(f => f.uid === fromUid)) {
            window.userData.friends.push({
                username: fromNickname,
                nickname: fromNickname,
                email: fromEmail,
                avatar: fromAvatar,
                uid: fromUid
            });
            if (typeof saveUserData === 'function') saveUserData();
        }

        const chatId = [currentUid, fromUid].sort().join('_');
        const membersMap = {};
        membersMap[currentUid] = true;
        membersMap[fromUid] = true;

        await rtdb.ref(`chats/${chatId}`).update({
            type: 'private',
            name: fromNickname,
            members: membersMap,
            updatedAt: Date.now()
        });
        if (isChatDeleted(chatId)) {
            setChatDeleted(chatId, false, { silentSync: true });
        }

        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastFriendAccepted', { name: fromNickname }) : `🤝 已同意「${fromNickname}」的好友申請！`, 'success');
        renderFriendsList();
    } catch (e) {
        console.error("同意好友申請失敗:", e);
    }
}

async function handleRejectFriendRequest(reqId) {
    const rtdb = getRtdb();
    if (!rtdb) return;
    try {
        await rtdb.ref(`friendRequests/${reqId}`).update({ status: 'rejected' });
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastFriendRejected') : '已拒絕該好友申請', 'info');
        renderFriendsList();
    } catch (e) {
        console.error("拒絕好友申請失敗:", e);
    }
}

async function createGroupPrompt() {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredGroup') : '請先登入帳號才能建立群組！', 'warning');
        return;
    }

    const groupName = (prompt(typeof t === 'function' ? t('promptNewGroupName') : '請輸入新群組名稱：') || '').trim();
    if (!groupName) return;

    const currentUid = firebase.auth().currentUser.uid;
    const myName = (window.userData && window.userData.nickname) ? window.userData.nickname : (typeof t === 'function' ? t('defaultPlayerName') : '玩家');
    const rtdb = getRtdb();
    if (!rtdb) return;

    try {
        const newChatRef = rtdb.ref('chats').push();
        const membersMap = {};
        membersMap[currentUid] = true;

        await newChatRef.set({
            type: 'group',
            name: groupName,
            ownerUid: currentUid,
            members: membersMap,
            lastMessage: typeof t === 'function' ? t('msgGroupCreated', { name: myName, group: groupName }) : `${myName} 建立了群組「${groupName}」`,
            lastSenderUid: currentUid,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });

        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastGroupCreated', { name: groupName }) : `🎉 已成功建立群組「${groupName}」！`, 'success');
        openChatWindow(newChatRef.key, groupName);
    } catch (e) {
        console.error("建立群組失敗:", e);
    }
}

async function startPrivateChat(encodedTargetUsername, targetUid = '') {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredChat') : '請先登入帳號才能使用私聊！', 'warning');
        return;
    }

    const targetUser = decodeURIComponent(encodedTargetUsername);
    const currentUid = firebase.auth()?.currentUser ? firebase.auth().currentUser.uid : '';
    const rtdb = getRtdb();
    if (!rtdb) return;

    if (!targetUid && window.userData && window.userData.friends) {
        const found = window.userData.friends.find(f => (f.nickname || f.username) === targetUser);
        if (found && found.uid) targetUid = found.uid;
    }

    const chatId = (currentUid && targetUid)
        ? [currentUid, targetUid].sort().join('_')
        : 'chat_private_' + encodeURIComponent(targetUser);

    if (isChatDeleted(chatId)) {
        setChatDeleted(chatId, false, { silentSync: true });
    }

    const membersMap = {};
    if (currentUid) membersMap[currentUid] = true;
    if (targetUid) membersMap[targetUid] = true;

    try {
        const existingThread = userChatThreads.find(c => c && c.id === chatId);
        const updatePayload = {
            type: 'private',
            name: targetUser,
            members: membersMap
        };
        if (!existingThread || !existingThread.updatedAt) {
            updatePayload.updatedAt = Date.now();
        }
        await rtdb.ref(`chats/${chatId}`).update(updatePayload);
    } catch (e) {
        console.warn("初始化 RTDB 對話失敗:", e);
    }

    openChatWindow(chatId, targetUser);
}

async function renderChatThreads(isAdminInspector = false) {
    const container = document.getElementById('chatThreadsList');
    if (!container) return;

    const currentUid = firebase.auth()?.currentUser ? firebase.auth().currentUser.uid : '';
    const isAdmin = isChatUserAdmin();
    const query = chatSearchQuery;

    let threads = [...userChatThreads];

    if (!threads.some(t => t.id === 'chat_group_public')) {
        threads.unshift({
            id: 'chat_group_public',
            type: 'group',
            name: typeof t === 'function' ? t('publicChatRoom') : '全站公開討論區'
        });
    }

    threads = threads.filter(c => {
        if (!c || !c.id || isChatDeleted(c.id)) return false;
        if (!isAdminInspector && c.type !== 'group' && c.members && typeof c.members === 'object') {
            const memberUids = Array.isArray(c.members) ? c.members : Object.keys(c.members).filter(k => c.members[k]);
            const peerUids = memberUids.filter(uid => uid && uid !== currentUid);
            if (peerUids.length > 0 && peerUids.every(uid => isUidBlocked(uid))) {
                return false;
            }
        }
        return true;
    });

    if (query) {
        threads = threads.filter(c => (c.name || '').toLowerCase().includes(query));
    }

    // 釘選對話優先置頂，其次依最新訊息時間排序（公開頻道維持靠前）
    threads.sort((a, b) => {
        const aPinned = isChatPinned(a.id) ? 1 : 0;
        const bPinned = isChatPinned(b.id) ? 1 : 0;
        if (bPinned !== aPinned) return bPinned - aPinned;
        if (a.id === 'chat_group_public' && b.id !== 'chat_group_public') return -1;
        if (b.id === 'chat_group_public' && a.id !== 'chat_group_public') return 1;
        return toChatTimestampMs(b.updatedAt) - toChatTimestampMs(a.updatedAt);
    });

    let html = `
        <div class="mb-3">
            <button type="button" onclick="createGroupPrompt()" class="w-full py-2 bg-gradient-to-r from-brand-600 to-purple-600 hover:from-brand-700 hover:to-purple-700 text-white font-bold text-xs rounded-xl transition shadow-xs flex items-center justify-center space-x-1.5 cursor-pointer">
                <i class="fa-solid fa-users-rectangle text-sm"></i>
                <span>${typeof t === 'function' ? t('btnCreateGroup') : '建立新群組'}</span>
            </button>
        </div>
    `;

    if (threads.length === 0) {
        html += `<div class="text-center text-slate-400 py-8 text-xs">${typeof t === 'function' ? t('noChatChannels') : '目前沒有可顯示的對話頻道'}</div>`;
        container.innerHTML = html;
        return;
    }

    html += threads.map(c => {
        const isGroup = c.type === 'group';
        const icon = isGroup ? 'fa-users text-purple-500' : 'fa-user-lock text-emerald-500';
        const displayName = c.name || (typeof t === 'function' ? t('defaultChatTitle') : '對話');
        const hasUnread = isThreadUnread(c, currentUid);
        const pinned = isChatPinned(c.id);
        const muted = isChatMuted(c.id);

        const safeChatId = escapeHTML(c.id || '');
        const encodedName = encodeURIComponent(displayName);
        return `
            <div data-chat-thread-id="${safeChatId}" data-chat-thread-name="${escapeHTML(encodedName)}" style="touch-action: pan-y; -webkit-user-select: none; user-select: none;" class="p-3 bg-white dark:bg-slate-900 rounded-xl border ${pinned ? 'border-brand-300 dark:border-brand-700 bg-brand-50/30 dark:bg-brand-950/15' : 'border-slate-100 dark:border-slate-700'} hover:border-brand-300 transition cursor-pointer flex justify-between items-center relative mb-2 select-none">
                <div class="flex items-center space-x-3 min-w-0 flex-1">
                    <div class="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm relative shrink-0">
                        <i class="fa-solid ${icon}"></i>
                        ${hasUnread ? `<span class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-rose-500 rounded-full ring-2 ring-white dark:ring-slate-800"></span>` : ''}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center space-x-1.5">
                            ${pinned ? `<i class="fa-solid fa-thumbtack text-[10px] text-brand-500 shrink-0" title="已釘選"></i>` : ''}
                            <h4 class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">${escapeHTML(displayName)}</h4>
                            <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold shrink-0 ${isGroup ? 'bg-purple-50 text-purple-600 dark:bg-purple-950/40' : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40'}">${isGroup ? (typeof t === 'function' ? t('badgeGroup') : '群組') : (typeof t === 'function' ? t('badgePrivate') : '私訊')}</span>
                            ${muted ? `<i class="fa-solid fa-bell-slash text-[10px] text-slate-400 shrink-0" title="已關閉通知"></i>` : ''}
                        </div>
                        <p class="text-[11px] text-slate-400 line-clamp-1 mt-0.5">${escapeHTML(c.lastMessage || (typeof t === 'function' ? t('clickToChat') : '點擊開始對話...'))}</p>
                    </div>
                </div>

                ${isAdmin ? `
                    <button type="button" onclick="event.stopPropagation(); deleteChatThread('${safeChatId}')" title="${typeof t === 'function' ? t('btnBatchDelete') : '刪除'}" class="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition ml-2 shrink-0 cursor-pointer">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');

    container.innerHTML = html;

    // 綁定長按 (500ms) 開啟功能表與單擊進入對話
    container.querySelectorAll('[data-chat-thread-id]').forEach(row => {
        const cid = row.getAttribute('data-chat-thread-id') || '';
        const encName = row.getAttribute('data-chat-thread-name') || '';
        let decodedName = '';
        try { decodedName = decodeURIComponent(encName); } catch (e) { decodedName = encName; }
        bindLongPress(row, {
            delay: 500,
            moveThreshold: 10,
            onLongPress: (ev) => {
                const pt = getEventClientCoords(ev, row);
                openChatThreadContextMenu(cid, decodedName, pt.x, pt.y);
            },
            onClick: () => {
                openChatWindow(cid, encName);
            }
        });
    });
}

/**
 * 🧹 滾動式 30 天訊息自動清理：僅刪除過期子節點 (chats/${chatId}/messages/${msgKey})，絕對保留聊天室本身與好友關係
 */
function pruneExpiredChatMessages(chatId, messagesData, options = {}) {
    const deleteRemote = options.deleteRemote !== false;
    const now = Date.now();
    const activeMessages = [];
    const prunePatch = {};
    let expiredCount = 0;

    if (messagesData && typeof messagesData === 'object') {
        Object.keys(messagesData).forEach(key => {
            const msg = messagesData[key];
            if (!msg || typeof msg !== 'object') return;
            const createdMs = toChatTimestampMs(msg.createdAt || 0);
            if (createdMs > 0 && (now - createdMs) > CHAT_MSG_RETENTION_MS) {
                prunePatch[key] = null;
                expiredCount++;
            } else {
                activeMessages.push({ id: key, ...msg });
            }
        });
    }

    activeMessages.sort((a, b) => toChatTimestampMs(a.createdAt || 0) - toChatTimestampMs(b.createdAt || 0));

    if (deleteRemote && expiredCount > 0 && chatId) {
        const rtdb = getRtdb();
        if (rtdb) {
            rtdb.ref(`chats/${chatId}/messages`).update(prunePatch).catch(err => {
                console.warn(`清理聊天室 ${chatId} 逾 30 天訊息失敗:`, err);
            });
        }
    }

    return { activeMessages, expiredCount };
}

async function sweepExpiredMessagesInRoom(chatId) {
    const rtdb = getRtdb();
    if (!rtdb || !chatId) return 0;
    try {
        const snap = await rtdb.ref(`chats/${chatId}/messages`).once('value');
        const data = snap.val() || {};
        const { expiredCount } = pruneExpiredChatMessages(chatId, data, { deleteRemote: true });
        return expiredCount;
    } catch (e) {
        return 0;
    }
}

/**
 * 💬 5. 開啟聊天視窗並記錄自己的最後已讀時間點
 */
async function openChatWindow(chatId, encodedName = '') {
    closeChatThreadContextMenu();
    const rtdb = getRtdb();
    if (activeChatListener && currentActiveChatId && rtdb) {
        rtdb.ref(`chats/${currentActiveChatId}/messages`).off('value', activeChatListener);
    }
    if (activeChatReadListener && currentActiveChatId && rtdb) {
        rtdb.ref(`chats/${currentActiveChatId}/readBy`).off('value', activeChatReadListener);
    }

    currentActiveChatId = chatId;
    currentActiveChatData = userChatThreads.find(c => c.id === chatId) || null;
    currentChatMessages = [];
    const currentUid = firebase.auth()?.currentUser?.uid;

    localStorage.setItem(`lzhcard_last_read_chat_${chatId}`, Date.now().toString());
    setChatManuallyUnread(chatId, false, { silentSync: true });
    updateUnreadBadgeUI();

    const displayName = encodedName ? decodeURIComponent(encodedName) : (currentActiveChatData?.name || (typeof t === 'function' ? t('defaultChatTitle') : '對話'));

    document.getElementById('chatsView')?.classList.add('hidden');
    document.getElementById('friendsView')?.classList.add('hidden');
    
    const activeWindow = document.getElementById('activeChatWindow');
    if (activeWindow) activeWindow.classList.remove('hidden');

    const titleEl = document.getElementById('activeChatTitle');
    if (titleEl) titleEl.textContent = displayName;

    const actionsEl = document.getElementById('activeChatHeaderActions');
    if (actionsEl) {
        const isUserGroup = Boolean(
            chatId &&
            chatId !== 'chat_group_public' &&
            ((currentActiveChatData && currentActiveChatData.type === 'group') || String(chatId).startsWith('chat_group_'))
        );
        if (isUserGroup) {
            actionsEl.innerHTML = `
                <button type="button" onclick="openFriendOnlyInviteModal({ mode: 'group', groupId: '${escapeHTML(chatId)}', groupName: decodeURIComponent('${encodeURIComponent(displayName)}') })" class="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-bold rounded-lg transition shadow-2xs flex items-center gap-1 cursor-pointer">
                    <i class="fa-solid fa-user-plus text-[10px]"></i>
                    <span>邀請好友</span>
                </button>
            `;
        } else {
            actionsEl.innerHTML = '';
        }
    }

    if (!rtdb || !chatId) return;

    if (currentUid) {
        rtdb.ref(`chats/${chatId}/readBy/${currentUid}`).set(Date.now());
    }

    activeChatListener = rtdb.ref(`chats/${chatId}/messages`).on('value', snapshot => {
        const data = snapshot.val() || {};
        const { activeMessages } = pruneExpiredChatMessages(chatId, data, { deleteRemote: true });
        currentChatMessages = activeMessages;
        renderMessagesList(currentChatMessages);
    });

    activeChatReadListener = rtdb.ref(`chats/${chatId}/readBy`).on('value', snapshot => {
        chatReadByMap = snapshot.val() || {};
        renderMessagesList(currentChatMessages);
    });
}

function backToChatThreads() {
    const rtdb = getRtdb();
    if (activeChatListener && currentActiveChatId && rtdb) {
        rtdb.ref(`chats/${currentActiveChatId}/messages`).off('value', activeChatListener);
        if (activeChatReadListener) rtdb.ref(`chats/${currentActiveChatId}/readBy`).off('value', activeChatReadListener);
        activeChatListener = null;
        activeChatReadListener = null;
    }
    currentChatMessages = [];
    document.getElementById('activeChatWindow')?.classList.add('hidden');
    document.getElementById('chatsView')?.classList.remove('hidden');
    
    const isAdmin = isChatUserAdmin();
    const tabAdminBtn = document.getElementById('tabAdminBtn');
    const isInspectorMode = isAdmin && tabAdminBtn && tabAdminBtn.className.includes('border-rose-600');
    renderChatThreads(isInspectorMode);
}

function getChatDayKey(tsMs) {
    const ms = toChatTimestampMs(tsMs);
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatChatDateDivider(tsMs) {
    const ms = toChatTimestampMs(tsMs);
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((todayStart - targetStart) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()] || ''}`;
}

/**
 * 📖 6. 渲染訊息與計算已讀狀態（含每日首位發送者上方日期分隔線 & 封鎖過濾 & UGC 檢舉）
 */
function renderMessagesList(messages = []) {
    const container = document.getElementById('chatMessagesBox');
    if (!container) return;

    const currentUid = firebase.auth()?.currentUser ? firebase.auth().currentUser.uid : '';
    const isAdmin = isChatUserAdmin();
    const myPrivacyHide = !isAdmin && !!(window.userData && window.userData.privacyHideStatus);
    const blockedSet = getBlockedUidsSet();

    const visibleMessages = messages.filter(msg => {
        if (!msg) return false;
        if (msg.senderUid && msg.senderUid !== currentUid && blockedSet.has(msg.senderUid)) {
            return false;
        }
        return true;
    });

    if (visibleMessages.length === 0) {
        container.innerHTML = `<div class="text-center text-slate-400 py-6 text-xs">${typeof t === 'function' ? t('noChatMessages') : '尚無聊天訊息，輸入第一條訊息開始交流吧！'}</div>`;
        return;
    }

    let lastDayKey = '';

    container.innerHTML = visibleMessages.map(msg => {
        const msgTs = toChatTimestampMs(msg.createdAt || 0);
        const dayKey = getChatDayKey(msgTs);
        let dateDividerHtml = '';
        if (dayKey && dayKey !== lastDayKey) {
            lastDayKey = dayKey;
            const dateLabel = formatChatDateDivider(msgTs);
            if (dateLabel) {
                dateDividerHtml = `<div class="chat-date-separator"><span>${escapeHTML(dateLabel)}</span></div>`;
            }
        }

        const isSystem = msg.sender === '系統提示' || msg.sender === (typeof t === 'function' ? t('systemNotice') : '系統提示');
        if (isSystem) {
            return `${dateDividerHtml}
                <div class="flex justify-center my-2">
                    <span class="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-700">${escapeHTML(msg.text)}</span>
                </div>
            `;
        }

        const isMe = msg.senderUid ? (msg.senderUid === currentUid) : (msg.sender === (window.userData?.username || ''));

        let isReadByOther = false;
        if (isMe) {
            Object.keys(chatReadByMap).forEach(memberUid => {
                if (memberUid !== currentUid) {
                    const readTime = chatReadByMap[memberUid] || 0;
                    const msgTime = msg.createdAt || 0;
                    const targetStatus = onlineUsersMap[memberUid] || {};
                    const targetPrivacyHide = !!targetStatus.hidePrivacy;

                    if (readTime >= msgTime) {
                        if (isAdmin) {
                            isReadByOther = true;
                        } else if (!myPrivacyHide && !targetPrivacyHide) {
                            isReadByOther = true;
                        }
                    }
                }
            });
        }

        const senderStatus = msg.senderUid ? (onlineUsersMap[msg.senderUid] || {}) : {};
        const senderFallbackAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(msg.senderUid || msg.sender || 'user')}`;
        const senderAvatar = sanitizeChatUrl(senderStatus.avatar || msg.senderAvatar || senderFallbackAvatar, senderFallbackAvatar);
        const senderFrameId = senderStatus.frame || senderStatus.cosmetics?.frame || msg.senderFrame || 'default';
        const senderFrameMeta = typeof getFrameMeta === 'function' ? getFrameMeta(senderFrameId) : { ringClass: 'border border-slate-200 dark:border-slate-700' };
        const canOpenProfile = Boolean(msg.senderUid);
        const senderSafeUid = escapeHTML(msg.senderUid || '');
        const senderNameStr = msg.sender || (typeof t === 'function' ? t('anonymousUser') : '匿名');
        const safeActiveChatId = escapeHTML(currentActiveChatId || '');
        const safeMsgId = escapeHTML(msg.id || '');
        const senderMemInput = senderStatus.membershipTier
            ? senderStatus
            : { tier: msg.senderMembershipTier || 'free', expiresAt: msg.senderMembershipExpiresAt || 0 };
        const senderMemBadge = (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.renderBadgeHtml === 'function')
            ? MembershipEngine.renderBadgeHtml(senderMemInput, { size: '2xs' })
            : '';

        return `${dateDividerHtml}
            <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1 my-1.5">
                <div class="flex items-center space-x-1.5">
                    ${canOpenProfile ? `
                        <button type="button" onclick="if(typeof openPlayerProfileModal==='function') openPlayerProfileModal('${senderSafeUid}', '${encodeURIComponent(senderNameStr)}')" class="flex items-center space-x-1.5 group cursor-pointer ${isMe ? 'flex-row-reverse space-x-reverse' : ''}">
                            <img src="${escapeHTML(senderAvatar)}" alt="${escapeHTML(senderNameStr)}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(senderFallbackAvatar)}');" class="w-5 h-5 rounded-full object-cover ${senderFrameMeta.ringClass}">
                            <span class="text-[10px] font-semibold text-slate-500 dark:text-slate-400 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition">${escapeHTML(senderNameStr)}</span>
                            ${senderMemBadge}
                        </button>
                    ` : `
                        <span class="text-[10px] text-slate-400 px-1">${escapeHTML(senderNameStr)}</span>
                    `}
                    ${!isMe && msg.senderUid ? `
                        <button type="button" onclick="openUgcReportModal({ targetType: 'message', targetUid: '${senderSafeUid}', chatId: '${safeActiveChatId}', messageId: '${safeMsgId}', targetLabel: '${encodeURIComponent(senderNameStr)}', contentPreview: '${encodeURIComponent(msg.text || '')}' })" title="檢舉此訊息" class="text-slate-400 hover:text-rose-500 text-[10px] px-1 py-0.5 transition cursor-pointer">
                            <i class="fa-solid fa-flag"></i>
                        </button>
                        <button type="button" onclick="blockPlayerByUid('${senderSafeUid}', '${encodeURIComponent(senderNameStr)}')" title="封鎖此用戶" class="text-slate-400 hover:text-rose-600 text-[10px] px-1 py-0.5 transition cursor-pointer">
                            <i class="fa-solid fa-ban"></i>
                        </button>
                    ` : ''}
                    ${isAdmin && msg.id ? `
                        <button type="button" onclick="deleteChatMessage('${safeActiveChatId}', '${safeMsgId}')" title="${typeof t === 'function' ? t('btnBatchDelete') : '刪除'}" class="text-rose-500 hover:text-rose-700 text-[10px] p-0.5 transition cursor-pointer">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    ` : ''}
                </div>
                <div class="max-w-[80%] px-3 py-2 rounded-2xl text-xs ${isMe ? 'bg-brand-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-100 dark:border-slate-700 rounded-tl-none'} shadow-2xs">
                    ${escapeHTML(msg.text)}
                </div>
                <div class="flex items-center space-x-1 px-1">
                    ${isMe && isReadByOther ? `<span class="text-[9px] text-brand-500 dark:text-brand-400 font-bold">${typeof t === 'function' ? t('badgeRead') : '已讀'}</span>` : ''}
                    <span class="text-[9px] text-slate-400">${escapeHTML(msg.time || '')}</span>
                </div>
            </div>
        `;
    }).join('');

    container.scrollTop = container.scrollHeight;
}

/**
 * 📤 發送訊息至 RTDB
 */
async function handleSendMessage(e) {
    if (e) e.preventDefault();

    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastLoginRequiredMessage') : '請先登入帳號才能發送訊息！', 'warning');
        return;
    }

    const input = document.getElementById('chatInput');
    const text = (input?.value || '').trim();
    if (!text || !currentActiveChatId) return;

    const rtdb = getRtdb();
    if (!rtdb) return;

    const currentUser = (window.userData && window.userData.nickname) 
        ? window.userData.nickname 
        : (firebase.auth().currentUser?.displayName || firebase.auth().currentUser?.email?.split('@')[0] || (typeof t === 'function' ? t('defaultPlayerName') : '使用者'));
    
    const currentUid = firebase.auth().currentUser.uid;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (input) input.value = '';

    const newMsgRef = rtdb.ref(`chats/${currentActiveChatId}/messages`).push();
    const myAvatar = (typeof window !== 'undefined' && typeof window.resolveAuthUserPhotoUrl === 'function')
        ? window.resolveAuthUserPhotoUrl(firebase.auth().currentUser, window.userData)
        : (firebase.auth().currentUser?.photoURL || (window.userData && window.userData.photoURL) || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUid)}`);
    const myFrame = (window.userData && window.userData.cosmetics && window.userData.cosmetics.frame) ? window.userData.cosmetics.frame : 'default';
    const myMemPayload = (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.getMyOnlineMembershipPayload === 'function')
        ? MembershipEngine.getMyOnlineMembershipPayload()
        : { membershipTier: 'free', membershipExpiresAt: 0 };

    try {
        await newMsgRef.set({
            sender: currentUser,
            senderUid: currentUid,
            senderAvatar: myAvatar,
            senderFrame: myFrame,
            senderMembershipTier: myMemPayload.membershipTier,
            senderMembershipExpiresAt: myMemPayload.membershipExpiresAt,
            text: text,
            time: timeStr,
            createdAt: Date.now()
        });

        await rtdb.ref(`chats/${currentActiveChatId}`).update({
            lastMessage: `${currentUser}: ${text}`,
            lastSenderUid: currentUid,
            updatedAt: Date.now()
        });

        await rtdb.ref(`chats/${currentActiveChatId}/readBy/${currentUid}`).set(Date.now());
        // 背景掃描並清理該聊天室超過 30 天的舊訊息（不刪除房間節點）
        sweepExpiredMessagesInRoom(currentActiveChatId);

    } catch (err) {
        console.error("RTDB 發送訊息失敗:", err);
        if (typeof showToast === 'function') showToast((typeof t === 'function' ? t('toastSendFailed') : '發送失敗：') + err.message, 'error');
    }
}

function formatAnnouncementDetailParagraphs(rawContent) {
    const normalized = String(rawContent || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';
    const blocks = normalized.split(/\n{2,}/);
    return blocks
        .map(block => `<p class="whitespace-pre-line break-words leading-relaxed">${escapeHTML(block)}</p>`)
        .join('');
}

function openAnnouncementDetailModal(annId) {
    const annList = Array.isArray(window.appAnnouncements) ? window.appAnnouncements : cloudAnnouncements;
    const ann = annList.find(a => a && a.id === annId);
    if (!ann) return false;

    const titleEl = document.getElementById('annDetailTitle');
    const authorEl = document.getElementById('annDetailAuthor');
    const timeEl = document.getElementById('annDetailTime');
    const bodyEl = document.getElementById('annDetailBody');

    const defaultAuthor = typeof t === 'function' ? t('defaultAdminAuthor') : '官方管理員';
    const publisherPrefix = typeof t === 'function' ? t('publisher') : '發布者：';
    if (titleEl) titleEl.textContent = ann.title || '';
    if (authorEl) authorEl.textContent = `${publisherPrefix}${ann.author || defaultAuthor}`;
    if (timeEl) timeEl.textContent = ann.time || '';
    if (bodyEl) bodyEl.innerHTML = formatAnnouncementDetailParagraphs(ann.content || '');

    if (typeof openModal === 'function') {
        openModal('announcementDetailModal');
    } else {
        const modal = document.getElementById('announcementDetailModal');
        if (modal) modal.classList.remove('hidden');
    }
    return true;
}

async function renderAnnouncements() {
    const container = document.getElementById('noticeList');
    if (!container) return;

    const isAdmin = isChatUserAdmin();
    let annList = window.appAnnouncements || [];

    if (annList.length === 0) {
        container.innerHTML = `<div class="text-center text-slate-400 py-8 text-xs">${typeof t === 'function' ? t('noAnnouncementsYet') : '目前尚無系統公告'}</div>`;
        return;
    }

    container.innerHTML = annList.map(ann => {
        const safeAnnId = escapeHTML(ann.id || '');
        const cleanContent = String(ann.content || '').replace(/\r\n/g, '\n').trim();
        return `
        <div role="button" tabindex="0" onclick="openAnnouncementDetailModal('${safeAnnId}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openAnnouncementDetailModal('${safeAnnId}');}"
            class="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-100 dark:border-slate-700 hover:border-brand-300 dark:hover:border-brand-600 shadow-2xs space-y-2 relative cursor-pointer transition group">
            <div class="flex justify-between items-start gap-2">
                <span class="font-extrabold text-[13px] text-brand-600 dark:text-brand-400 group-hover:underline leading-snug">${escapeHTML(ann.title)}</span>
                <div class="flex items-center space-x-1.5 shrink-0">
                    <span class="text-[10px] text-slate-400 font-mono">${escapeHTML(ann.time || '')}</span>
                    ${isAdmin ? `
                        <button type="button" onclick="event.stopPropagation(); deleteAnnouncement('${safeAnnId}')" title="${typeof t === 'function' ? t('btnBatchDelete') : '刪除'}" class="text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 p-1 rounded transition cursor-pointer">
                            <i class="fa-solid fa-trash-can text-xs"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
            <div class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line break-words line-clamp-5">${escapeHTML(cleanContent)}</div>
            <div class="flex items-center justify-between gap-2 text-[10px] text-slate-400 font-semibold pt-1.5 border-t border-slate-50 dark:border-slate-800">
                <span>${typeof t === 'function' ? t('publisher') : '發布者：'}${escapeHTML(ann.author || (typeof t === 'function' ? t('defaultAdminAuthor') : '管理員'))}</span>
                <span class="text-brand-600 dark:text-brand-400 font-bold group-hover:translate-x-0.5 transition-transform">${escapeHTML(chatTr('annReadFullHint', '點擊查看全文 ↗'))}</span>
            </div>
        </div>
    `;
    }).join('');
}

async function deleteAnnouncement(annId) {
    if (!isChatUserAdmin()) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastAdminDeleteNoticeOnly') : '只有管理員可以刪除公告！', 'error');
        return;
    }

    const rtdb = getRtdb();
    const noticeMsg = typeof t === 'function' ? t('confirmDeleteNotice') : '👑 管理員警告：確定要刪除該公告嗎？';
    const confirmed = rtdb && (typeof window.lzhConfirm === 'function' ? await window.lzhConfirm(noticeMsg) : false);
    if (confirmed && rtdb) {
        try {
            await rtdb.ref(`announcements/${annId}`).remove();
            if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastNoticeDeleted') : '已成功刪除該公告！', 'info');
        } catch (e) {
            console.error("刪除公告失敗：", e);
            if (typeof showToast === 'function') showToast((typeof t === 'function' ? t('toastNoticeDeleteFailed') : '刪除失敗：') + e.message, 'error');
        }
    }
}

async function submitAnnouncement() {
    if (!isChatUserAdmin()) {
        const currentRole = window.userData?.role || '訪客';
        if (typeof showToast === 'function') {
            showToast(typeof t === 'function' ? t('toastAdminPubNoticeOnly', { role: currentRole }) : `只有管理員可以發布公告！(目前前端身分：${currentRole})`, 'error');
        }
        return;
    }

    const titleInput = document.getElementById('annTitle');
    const contentInput = document.getElementById('annContent');

    const title = (titleInput?.value || '').trim();
    const content = (contentInput?.value || '').replace(/\r\n/g, '\n').trim();

    if (!title || !content) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastFillNoticeFields') : '請填寫完整公告標題與內容！', 'warning');
        return;
    }

    const rtdb = getRtdb();
    if (!rtdb) {
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastRtdbUninit') : 'Realtime Database SDK 未成功初始化！', 'error');
        return;
    }

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const newRef = rtdb.ref('announcements').push();
    try {
        await newRef.set({
            title: title,
            content: content,
            author: window.userData.nickname || firebase.auth()?.currentUser?.displayName || (typeof t === 'function' ? t('defaultAdminAuthor') : '官方管理員'),
            time: dateStr,
            createdAt: Date.now()
        });

        if (titleInput) titleInput.value = '';
        if (contentInput) contentInput.value = '';

        if (typeof closeModal === 'function') closeModal('announceModal');
        if (typeof showToast === 'function') showToast(typeof t === 'function' ? t('toastNoticePublished') : '🎉 官方公告已成功發布！', 'success');
    } catch (e) {
        console.error("發布公告失敗：", e);
        if (typeof showToast === 'function') {
            showToast(typeof t === 'function' ? t('toastNoticePubFailed', { code: e.code || 'PERMISSION_DENIED', msg: e.message }) : `發布公告失敗 (${e.code || 'PERMISSION_DENIED'}): ${e.message}`, 'error');
        }
    }
}

/**
 * 📦 建構結構化聊天紀錄匯出資料
 */
function buildChatExportData(threadsWithMessages = [], exporterInfo = {}) {
    const cleanThreads = (Array.isArray(threadsWithMessages) ? threadsWithMessages : []).map(thread => {
        const msgs = Array.isArray(thread.messages) ? [...thread.messages] : [];
        msgs.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
        return {
            chatId: thread.chatId || thread.id || '',
            name: thread.name || '未命名對話',
            type: thread.type === 'group' ? 'group' : 'private',
            messageCount: msgs.length,
            messages: msgs.map(m => ({
                sender: m.sender || '未知使用者',
                senderUid: m.senderUid || '',
                text: m.text || '',
                time: m.time || '',
                createdAt: Number(m.createdAt) || 0,
                isoTime: m.createdAt ? new Date(Number(m.createdAt)).toISOString() : ''
            }))
        };
    });

    const totalMessages = cleanThreads.reduce((sum, item) => sum + item.messageCount, 0);

    return {
        app: 'LZHCard',
        exportedAt: new Date().toISOString(),
        exportedBy: {
            uid: exporterInfo.uid || '',
            nickname: exporterInfo.nickname || '使用者'
        },
        totalThreads: cleanThreads.length,
        totalMessages,
        threads: cleanThreads
    };
}

/**
 * 📄 將匯出結構化資料格式化為易讀的 .txt 純文字檔內容
 */
function formatChatExportText(exportData) {
    if (!exportData || !Array.isArray(exportData.threads)) return '';
    const lines = [
        '==================================================',
        'LZHCard 聊天紀錄匯出檔案',
        `匯出帳號：${exportData.exportedBy?.nickname || '使用者'} (${exportData.exportedBy?.uid || ''})`,
        `匯出時間：${exportData.exportedAt || new Date().toISOString()}`,
        `頻道總數：${exportData.totalThreads || 0}｜訊息總數：${exportData.totalMessages || 0}`,
        '==================================================',
        ''
    ];

    exportData.threads.forEach(thread => {
        const typeLabel = thread.type === 'group' ? '群組 / 頻道' : '私人對話';
        lines.push(`--- [${typeLabel}] ${thread.name} (ID: ${thread.chatId}) ---`);
        if (!Array.isArray(thread.messages) || thread.messages.length === 0) {
            lines.push('  (尚無訊息紀錄)');
        } else {
            thread.messages.forEach(m => {
                let tsLabel = m.time || '';
                if (m.createdAt) {
                    const d = new Date(m.createdAt);
                    if (!Number.isNaN(d.getTime())) {
                        tsLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                    }
                }
                lines.push(`[${tsLabel}] ${m.sender}: ${m.text}`);
            });
        }
        lines.push('');
    });

    return lines.join('\n');
}

function downloadChatExportFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
    }, 300);
}

/**
 * 💾 匯出聊天紀錄 (.txt / .json)
 */
async function exportChatHistory(format = 'txt') {
    const normalizedFormat = format === 'json' ? 'json' : 'txt';
    if (isGuestUser()) {
        if (typeof showToast === 'function') {
            showToast(typeof t === 'function' ? t('toastLoginRequiredExportChat') : '請先登入帳號後再匯出聊天紀錄！', 'warning');
        }
        return false;
    }

    const currentUser = firebase.auth()?.currentUser;
    const rtdb = getRtdb();
    if (!currentUser || !rtdb) {
        if (typeof showToast === 'function') {
            showToast(typeof t === 'function' ? t('toastRtdbUninit') : '目前無法連線至聊天資料庫，請稍後再試！', 'error');
        }
        return false;
    }

    try {
        const candidateMap = new Map();
        const publicName = (typeof t === 'function' && t('publicChatRoom') !== 'publicChatRoom')
            ? t('publicChatRoom')
            : '全站公開討論區';
        candidateMap.set('chat_group_public', {
            chatId: 'chat_group_public',
            name: publicName,
            type: 'group'
        });

        (userChatThreads || []).forEach(c => {
            if (!c || !c.id) return;
            candidateMap.set(c.id, {
                chatId: c.id,
                name: c.name || (c.id === 'chat_group_public' ? publicName : '對話'),
                type: c.type === 'group' ? 'group' : 'private'
            });
        });

        if (currentActiveChatId && !candidateMap.has(currentActiveChatId)) {
            candidateMap.set(currentActiveChatId, {
                chatId: currentActiveChatId,
                name: document.getElementById('activeChatTitle')?.textContent || currentActiveChatId,
                type: currentActiveChatId.startsWith('chat_group_') ? 'group' : 'private'
            });
        }

        const candidateList = Array.from(candidateMap.values());
        const results = await Promise.allSettled(
            candidateList.map(async meta => {
                const snap = await rtdb.ref(`chats/${meta.chatId}/messages`).once('value');
                const val = snap.val() || {};
                const { activeMessages } = pruneExpiredChatMessages(meta.chatId, val, { deleteRemote: true });
                return { ...meta, messages: activeMessages };
            })
        );

        const threadsWithMessages = results
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);

        const exporterNickname = (window.userData && window.userData.nickname)
            || currentUser.displayName
            || (currentUser.email ? currentUser.email.split('@')[0] : '使用者');

        const exportData = buildChatExportData(threadsWithMessages, {
            uid: currentUser.uid,
            nickname: exporterNickname
        });

        if (exportData.totalMessages === 0) {
            if (typeof showToast === 'function') {
                showToast(typeof t === 'function' ? t('toastExportChatEmpty') : '目前尚無可匯出的聊天訊息紀錄！', 'info');
            }
            return false;
        }

        const now = new Date();
        const dateTag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

        if (normalizedFormat === 'json') {
            const jsonStr = JSON.stringify(exportData, null, 2);
            downloadChatExportFile(jsonStr, `lzhcard_chat_${dateTag}.json`, 'application/json;charset=utf-8');
        } else {
            const txtStr = formatChatExportText(exportData);
            downloadChatExportFile(txtStr, `lzhcard_chat_${dateTag}.txt`, 'text/plain;charset=utf-8');
        }

        if (typeof showToast === 'function') {
            const successMsg = (typeof t === 'function' && t('toastExportChatSuccess', { count: exportData.totalMessages }) !== 'toastExportChatSuccess')
                ? t('toastExportChatSuccess', { count: exportData.totalMessages })
                : `💬 已成功匯出 ${exportData.totalMessages} 則聊天紀錄！`;
            showToast(successMsg, 'success');
        }
        return true;
    } catch (err) {
        console.error('匯出聊天紀錄失敗：', err);
        if (typeof showToast === 'function') {
            showToast('匯出聊天紀錄失敗：' + (err.message || '未知錯誤'), 'error');
        }
        return false;
    }
}

function toChatTimestampMs(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val) {
        const parsed = Date.parse(val);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function getChatPrefUid() {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.uid;
    }
    return window.userData?.uid || 'guest';
}

function getChatPrefStorageKey(type, uid = getChatPrefUid()) {
    const map = {
        muted: 'lzhcard_chat_muted',
        pinned: 'lzhcard_chat_pinned',
        unread: 'lzhcard_chat_unread',
        deleted: 'lzhcard_chat_deleted'
    };
    return `${map[type] || 'lzhcard_chat_pref'}_${uid || 'guest'}`;
}

function readChatPrefSet(type, uid = getChatPrefUid()) {
    try {
        const raw = localStorage.getItem(getChatPrefStorageKey(type, uid));
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch (e) {
        return new Set();
    }
}

function writeChatPrefSet(type, setObj, uid = getChatPrefUid(), options = {}) {
    const arr = Array.from(setObj instanceof Set ? setObj : []);
    try {
        localStorage.setItem(getChatPrefStorageKey(type, uid), JSON.stringify(arr));
    } catch (e) {}

    if (!window.userData) window.userData = {};
    window.userData.chatPrefs = {
        mutedChats: Array.from(readChatPrefSet('muted', uid)),
        pinnedChats: Array.from(readChatPrefSet('pinned', uid)),
        manualUnreadChats: Array.from(readChatPrefSet('unread', uid)),
        deletedChats: Array.from(readChatPrefSet('deleted', uid))
    };

    if (!options || !options.silentSync) {
        if (typeof saveUserData === 'function' && uid && uid !== 'guest') {
            saveUserData();
        }
    }
}

function syncChatPrefsFromUserData() {
    const uid = getChatPrefUid();
    const remote = window.userData?.chatPrefs;
    if (!remote || typeof remote !== 'object' || !uid || uid === 'guest') return;

    const pairs = [
        ['muted', 'mutedChats'],
        ['pinned', 'pinnedChats'],
        ['unread', 'manualUnreadChats'],
        ['deleted', 'deletedChats']
    ];
    pairs.forEach(([type, field]) => {
        if (Array.isArray(remote[field])) {
            const merged = new Set([...readChatPrefSet(type, uid), ...remote[field]]);
            writeChatPrefSet(type, merged, uid, { silentSync: true });
        }
    });
    updateUnreadBadgeUI();
}

function isChatMuted(chatId) {
    return Boolean(chatId && readChatPrefSet('muted').has(chatId));
}

function toggleChatMute(chatId) {
    if (!chatId) return false;
    const set = readChatPrefSet('muted');
    const willMute = !set.has(chatId);
    if (willMute) set.add(chatId);
    else set.delete(chatId);
    writeChatPrefSet('muted', set);
    return willMute;
}

function isChatPinned(chatId) {
    return Boolean(chatId && readChatPrefSet('pinned').has(chatId));
}

function toggleChatPin(chatId) {
    if (!chatId) return false;
    const set = readChatPrefSet('pinned');
    const willPin = !set.has(chatId);
    if (willPin) set.add(chatId);
    else set.delete(chatId);
    writeChatPrefSet('pinned', set);
    return willPin;
}

function isChatManuallyUnread(chatId) {
    return Boolean(chatId && readChatPrefSet('unread').has(chatId));
}

function setChatManuallyUnread(chatId, isUnread, options = {}) {
    if (!chatId) return false;
    const set = readChatPrefSet('unread');
    if (isUnread) set.add(chatId);
    else set.delete(chatId);
    writeChatPrefSet('unread', set, getChatPrefUid(), options);
    return Boolean(isUnread);
}

function isChatDeleted(chatId) {
    return Boolean(chatId && readChatPrefSet('deleted').has(chatId));
}

function setChatDeleted(chatId, deleted, options = {}) {
    if (!chatId) return false;
    const set = readChatPrefSet('deleted');
    if (deleted) set.add(chatId);
    else set.delete(chatId);
    writeChatPrefSet('deleted', set, getChatPrefUid(), options);
    return Boolean(deleted);
}

function isThreadUnread(chat, currentUid, options = {}) {
    if (!chat || !chat.id) return false;
    if (!options.ignoreDeleted && isChatDeleted(chat.id)) return false;
    if (isChatManuallyUnread(chat.id)) return true;
    if (chat.id === 'chat_group_public' || !chat.updatedAt) return false;
    const chatTime = toChatTimestampMs(chat.updatedAt);
    const lastReadChat = parseInt(localStorage.getItem(`lzhcard_last_read_chat_${chat.id}`) || '0', 10);
    return chatTime > lastReadChat && chat.lastSenderUid !== currentUid;
}

function getLocalNotificationsPlugin() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor?.Plugins?.LocalNotifications || null;
}

function isNotificationTypeEnabled(type) {
    if (typeof getNotificationSettings === 'function') {
        const s = getNotificationSettings();
        return s[type] !== false;
    }
    const keyMap = {
        friendMsg: 'lzhcard_notif_friend_msg',
        announcements: 'lzhcard_notif_announcements',
        friendRequests: 'lzhcard_notif_friend_requests',
        teamInvites: 'lzhcard_notif_team_invites'
    };
    const key = keyMap[type];
    return !key || localStorage.getItem(key) !== 'false';
}

async function ensureLocalNotificationReady(requestIfPrompt = true) {
    const plugin = getLocalNotificationsPlugin();
    if (!plugin) return false;

    try {
        if (!_notifActionListenerBound && typeof plugin.addListener === 'function') {
            _notifActionListenerBound = true;
            plugin.addListener('localNotificationActionPerformed', (event) => {
                const extra = event?.notification?.extra || {};
                if (typeof openChatDrawer === 'function' && !isGuestUser()) {
                    openChatDrawer();
                    if (extra.type === 'announcements') switchChatTab('notice');
                    else if (extra.type === 'friendRequests' || extra.type === 'teamInvites') switchChatTab('friends');
                    else if (extra.type === 'friendMsg' && extra.chatId) {
                        openChatWindow(extra.chatId, encodeURIComponent(extra.chatName || ''));
                    }
                }
            });
        }

        if (!_notifChannelCreated && typeof plugin.createChannel === 'function') {
            try {
                await plugin.createChannel({
                    id: NOTIF_CHANNEL_ID,
                    name: 'LZHCard 社交與組隊通知',
                    description: '接收 Chat 公告、好友訊息、加好友申請與組隊邀請推播',
                    importance: 4,
                    visibility: 1,
                    sound: 'default',
                    vibration: true
                });
                _notifChannelCreated = true;
            } catch (chanErr) {
                // 非 Android 平台或模擬器略過
            }
        }

        if (typeof plugin.checkPermissions === 'function') {
            let perm = await plugin.checkPermissions();
            if (perm?.display !== 'granted' && requestIfPrompt && perm?.display !== 'denied' && typeof plugin.requestPermissions === 'function') {
                perm = await plugin.requestPermissions();
            }
            return perm?.display === 'granted';
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function dispatchSystemNotification({ type, title, body, extra = {} }) {
    if (!isNotificationTypeEnabled(type)) return false;
    if (type === 'friendMsg' && extra?.chatId && isChatMuted(extra.chatId)) {
        return false;
    }

    const plugin = getLocalNotificationsPlugin();
    if (!plugin || typeof plugin.schedule !== 'function') return false;

    const granted = await ensureLocalNotificationReady(false);
    if (!granted) return false;

    _nextNotificationId = (_nextNotificationId % 2147483000) + 1;
    try {
        await plugin.schedule({
            notifications: [{
                id: _nextNotificationId,
                title: String(title || 'LZHCard'),
                body: String(body || ''),
                channelId: NOTIF_CHANNEL_ID,
                smallIcon: 'ic_stat_icon_config_sample',
                schedule: { at: new Date(Date.now() + 100) },
                extra: extra || {}
            }]
        });
        return true;
    } catch (e) {
        console.warn('系統通知排程失敗：', e);
        return false;
    }
}

function getEventClientCoords(ev, fallbackEl) {
    if (ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number' && (ev.clientX !== 0 || ev.clientY !== 0)) {
        return { x: ev.clientX, y: ev.clientY };
    }
    if (fallbackEl && typeof fallbackEl.getBoundingClientRect === 'function') {
        const r = fallbackEl.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { x: 120, y: 180 };
}

function bindLongPress(el, { onLongPress, onClick, delay = 500, moveThreshold = 10 } = {}) {
    if (!el || el.__lzhLongPressBound) return;
    el.__lzhLongPressBound = true;

    let timerId = null;
    let startX = 0;
    let startY = 0;
    let pointerActive = false;
    let longPressTriggered = false;
    let lastLongPressAt = 0;

    const clearTimer = () => {
        if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
        }
    };

    el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        clearTimer();
        pointerActive = true;
        longPressTriggered = false;
        startX = e.clientX;
        startY = e.clientY;
        const snapshotEvent = { clientX: e.clientX, clientY: e.clientY, target: e.target };
        timerId = setTimeout(() => {
            timerId = null;
            if (!pointerActive) return;
            longPressTriggered = true;
            lastLongPressAt = Date.now();
            pointerActive = false;
            if (typeof onLongPress === 'function') {
                onLongPress(snapshotEvent);
            }
        }, delay);
    });

    el.addEventListener('pointermove', (e) => {
        if (!pointerActive || timerId === null) return;
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist > moveThreshold) {
            clearTimer();
            pointerActive = false;
        }
    });

    const cancelPointer = () => {
        clearTimer();
        pointerActive = false;
    };

    el.addEventListener('pointerup', cancelPointer);
    el.addEventListener('pointercancel', cancelPointer);

    el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!longPressTriggered && !pointerActive) {
            longPressTriggered = true;
            lastLongPressAt = Date.now();
            if (typeof onLongPress === 'function') {
                onLongPress(e);
            }
        }
    });

    el.addEventListener('click', (e) => {
        if (longPressTriggered || (Date.now() - lastLongPressAt) < 400) {
            e.preventDefault();
            e.stopPropagation();
            longPressTriggered = false;
            return;
        }
        if (typeof onClick === 'function') {
            onClick(e);
        }
    });
}

function syncChatNotificationMuteIndicators() {
    if (typeof document === 'undefined') return;
    const annEnabled = isNotificationTypeEnabled('announcements');
    const reqEnabled = isNotificationTypeEnabled('friendRequests');

    const noticeTabIcon = document.getElementById('noticeTabMuteIcon');
    if (noticeTabIcon) noticeTabIcon.classList.toggle('hidden', annEnabled);

    const friendsTabIcon = document.getElementById('friendsTabMuteIcon');
    if (friendsTabIcon) friendsTabIcon.classList.toggle('hidden', reqEnabled);

    const noticeBadge = document.getElementById('noticeMuteStatusBadge');
    if (noticeBadge) {
        noticeBadge.textContent = annEnabled ? '🔔 通知開啟（長按切換）' : '🔕 通知已靜音（長按開啟）';
        noticeBadge.className = annEnabled
            ? 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400'
            : 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300';
    }

    const reqBadge = document.getElementById('friendReqMuteStatusBadge');
    if (reqBadge) {
        reqBadge.textContent = reqEnabled ? '🔔 申請通知開' : '🔕 申請已靜音';
        reqBadge.className = reqEnabled
            ? 'text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 shrink-0'
            : 'text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300 shrink-0';
    }
}

function initStaticLongPressBindings() {
    if (typeof document === 'undefined') return;

    if (!_contextMenuDismissBound) {
        _contextMenuDismissBound = true;
        document.addEventListener('pointerdown', (e) => {
            const menu = document.getElementById('chatThreadContextMenu');
            if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) {
                closeChatThreadContextMenu();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeChatThreadContextMenu();
                closeChatDeleteConfirmModal();
                closeFriendOnlyInviteModal();
            }
        });
    }

    if (_staticLongPressBound) return;
    _staticLongPressBound = true;

    const toggleAnnounceNotif = () => {
        const nextVal = !isNotificationTypeEnabled('announcements');
        if (typeof handleNotificationSettingChange === 'function') {
            handleNotificationSettingChange('announcements', nextVal);
        } else {
            localStorage.setItem('lzhcard_notif_announcements', nextVal ? 'true' : 'false');
            syncChatNotificationMuteIndicators();
        }
    };

    const toggleFriendReqNotif = () => {
        const nextVal = !isNotificationTypeEnabled('friendRequests');
        if (typeof handleNotificationSettingChange === 'function') {
            handleNotificationSettingChange('friendRequests', nextVal);
        } else {
            localStorage.setItem('lzhcard_notif_friend_requests', nextVal ? 'true' : 'false');
            syncChatNotificationMuteIndicators();
        }
    };

    const tabNotice = document.getElementById('tabNoticeBtn');
    const noticeBar = document.getElementById('noticeHeaderLongPressBar');
    if (tabNotice) bindLongPress(tabNotice, { delay: 500, moveThreshold: 10, onLongPress: toggleAnnounceNotif });
    if (noticeBar) bindLongPress(noticeBar, { delay: 500, moveThreshold: 10, onLongPress: toggleAnnounceNotif });

    const tabFriends = document.getElementById('tabFriendsBtn');
    const friendsBar = document.getElementById('friendsHeaderLongPressBar');
    if (tabFriends) bindLongPress(tabFriends, { delay: 500, moveThreshold: 10, onLongPress: toggleFriendReqNotif });
    if (friendsBar) bindLongPress(friendsBar, { delay: 500, moveThreshold: 10, onLongPress: toggleFriendReqNotif });
}

function openChatThreadContextMenu(chatId, displayName, clientX, clientY) {
    if (typeof document === 'undefined' || !chatId) return;
    const menu = document.getElementById('chatThreadContextMenu');
    if (!menu) return;

    _contextMenuTarget = { chatId, displayName: displayName || '對話' };
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const threadObj = userChatThreads.find(t => t.id === chatId) || { id: chatId };

    const muted = isChatMuted(chatId);
    const pinned = isChatPinned(chatId);
    const unread = isThreadUnread(threadObj, currentUid);

    const muteLabel = document.getElementById('ctxMenuMuteLabel');
    const pinLabel = document.getElementById('ctxMenuPinLabel');
    const readLabel = document.getElementById('ctxMenuReadLabel');
    if (muteLabel) muteLabel.textContent = muted ? '開啟通知' : '關閉通知';
    if (pinLabel) pinLabel.textContent = pinned ? '取消釘選' : '釘選';
    if (readLabel) readLabel.textContent = unread ? '標示已讀' : '標示為未讀';

    menu.classList.remove('hidden');

    const vw = window.innerWidth || 375;
    const vh = window.innerHeight || 667;
    const menuW = menu.offsetWidth || 192;
    const menuH = menu.offsetHeight || 176;
    const left = Math.max(8, Math.min(Number(clientX) || 120, vw - menuW - 8));
    const top = Math.max(8, Math.min(Number(clientY) || 160, vh - menuH - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function closeChatThreadContextMenu() {
    if (typeof document === 'undefined') return;
    const menu = document.getElementById('chatThreadContextMenu');
    if (menu) menu.classList.add('hidden');
}

function openChatDeleteConfirmModal(chatId, displayName = '對話', options = {}) {
    if (typeof document === 'undefined' || !chatId) return;
    _pendingDeleteChatTarget = { chatId, displayName, hardDelete: Boolean(options?.hardDelete) };
    const modal = document.getElementById('chatDeleteConfirmModal');
    const titleEl = document.getElementById('chatDeleteConfirmTitle');
    if (titleEl) titleEl.textContent = displayName || chatId;
    if (modal) modal.classList.remove('hidden');
}

function closeChatDeleteConfirmModal() {
    _pendingDeleteChatTarget = null;
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('chatDeleteConfirmModal');
    if (modal) modal.classList.add('hidden');
}

async function confirmDeleteChatThreadAction() {
    const target = _pendingDeleteChatTarget;
    closeChatDeleteConfirmModal();
    if (!target || !target.chatId) return false;

    const { chatId, hardDelete } = target;
    const isAdmin = isChatUserAdmin();
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const rtdb = getRtdb();

    if (chatId === 'chat_group_public' && !(hardDelete && isAdmin)) {
        localStorage.setItem(`lzhcard_last_read_chat_${chatId}`, Date.now().toString());
        setChatManuallyUnread(chatId, false);
        updateUnreadBadgeUI();
        renderChatThreads(false);
        if (typeof showToast === 'function') {
            showToast('全站公開討論區無法刪除，已清除未讀狀態', 'info');
        }
        return false;
    }

    if (hardDelete && isAdmin && rtdb) {
        try {
            await rtdb.ref(`chats/${chatId}`).remove();
            if (currentActiveChatId === chatId) backToChatThreads();
            if (typeof showToast === 'function') showToast('🗑️ 已永久刪除該聊天頻道！', 'info');
        } catch (e) {
            console.error('刪除聊天頻道失敗：', e);
            if (typeof showToast === 'function') showToast('刪除失敗：' + e.message, 'error');
            return false;
        }
    } else {
        setChatDeleted(chatId, true);
        setChatManuallyUnread(chatId, false, { silentSync: true });
        if (isChatPinned(chatId)) toggleChatPin(chatId);
        if (currentActiveChatId === chatId) backToChatThreads();
        if (typeof showToast === 'function') showToast('🗑️ 已從聊天清單中移除此對話', 'info');
    }

    updateUnreadBadgeUI();
    renderChatThreads(false);
    return true;
}

async function executeChatContextAction(action) {
    const target = _contextMenuTarget;
    closeChatThreadContextMenu();
    if (!target || !target.chatId) return false;

    const { chatId, displayName } = target;
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    const rtdb = getRtdb();

    if (action === 'toggleMute') {
        const muted = toggleChatMute(chatId);
        renderChatThreads(false);
        if (typeof showToast === 'function') {
            showToast(muted ? `🔕 已關閉「${displayName}」的訊息通知` : `🔔 已開啟「${displayName}」的訊息通知`, 'info');
        }
        return true;
    }

    if (action === 'togglePin') {
        const pinned = toggleChatPin(chatId);
        renderChatThreads(false);
        if (typeof showToast === 'function') {
            showToast(pinned ? `📌 已釘選「${displayName}」` : `已取消釘選「${displayName}」`, 'info');
        }
        return true;
    }

    if (action === 'toggleRead') {
        const threadObj = userChatThreads.find(t => t.id === chatId) || { id: chatId };
        const currentlyUnread = isThreadUnread(threadObj, currentUid);
        if (currentlyUnread) {
            localStorage.setItem(`lzhcard_last_read_chat_${chatId}`, Date.now().toString());
            setChatManuallyUnread(chatId, false);
            if (rtdb && currentUid) {
                rtdb.ref(`chats/${chatId}/readBy/${currentUid}`).set(Date.now()).catch(() => {});
            }
            if (typeof showToast === 'function') showToast(`✅ 已將「${displayName}」標示為已讀`, 'info');
        } else {
            setChatManuallyUnread(chatId, true);
            if (typeof showToast === 'function') showToast(`🔴 已將「${displayName}」標示為未讀`, 'info');
        }
        updateUnreadBadgeUI();
        renderChatThreads(false);
        return true;
    }

    if (action === 'delete') {
        openChatDeleteConfirmModal(chatId, displayName, { hardDelete: false });
        return true;
    }

    return false;
}

function deleteChatThread(chatId) {
    if (!chatId) return;
    const found = userChatThreads.find(c => c.id === chatId);
    const displayName = found?.name || chatId;
    const isAdmin = isChatUserAdmin();
    openChatDeleteConfirmModal(chatId, displayName, { hardDelete: isAdmin });
}

async function deleteChatMessage(chatId, msgId) {
    if (!isChatUserAdmin()) {
        if (typeof showToast === 'function') showToast('只有管理員可以刪除聊天訊息！', 'error');
        return false;
    }
    const rtdb = getRtdb();
    if (!rtdb || !chatId || !msgId) return false;
    try {
        await rtdb.ref(`chats/${chatId}/messages/${msgId}`).remove();
        if (typeof showToast === 'function') showToast('已刪除該則訊息', 'info');
        return true;
    } catch (e) {
        console.error('刪除訊息失敗：', e);
        if (typeof showToast === 'function') showToast('刪除訊息失敗：' + e.message, 'error');
        return false;
    }
}

function openFriendOnlyInviteModal(options = {}) {
    if (isGuestUser()) {
        if (typeof showToast === 'function') showToast('請先登入帳號後再邀請好友！', 'warning');
        return false;
    }

    const mode = options.mode === 'raid' ? 'raid' : 'group';
    _activeTeamInviteCtx = {
        mode,
        groupId: options.groupId || '',
        raidCode: options.raidCode || '',
        groupName: options.groupName || (mode === 'raid' ? '四人共鬥打王' : '聊天群組')
    };

    const modal = document.getElementById('teamInviteFriendsModal');
    const titleEl = document.getElementById('teamInviteModalTitle');
    const subEl = document.getElementById('teamInviteModalSub');
    const listEl = document.getElementById('teamInviteFriendsList');
    if (!modal || !listEl) return false;

    if (titleEl) {
        titleEl.textContent = mode === 'raid'
            ? `🎮 邀請好友加入打王（房號 ${_activeTeamInviteCtx.raidCode}）`
            : `👥 邀請好友加入「${_activeTeamInviteCtx.groupName}」`;
    }
    if (subEl) {
        subEl.textContent = '基於組隊安全限制，僅可選擇並邀請您已加入的好友';
    }

    const friends = Array.isArray(window.userData?.friends) ? window.userData.friends : [];
    if (friends.length === 0) {
        listEl.innerHTML = `
            <div class="text-center py-8 space-y-3">
                <p class="text-xs text-slate-500 dark:text-slate-400">您目前還沒有任何好友，請先到「好友」分頁加好友後再邀請組隊。</p>
                <button type="button" onclick="closeFriendOnlyInviteModal(); if(typeof openChatDrawer==='function'){ openChatDrawer(); switchChatTab('friends'); }" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-xl cursor-pointer">
                    前往好友分頁
                </button>
            </div>
        `;
    } else {
        listEl.innerHTML = friends.map(f => {
            const name = f.nickname || f.username || '好友';
            const fallbackAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(f.uid || name)}`;
            const avatarSrc = sanitizeChatUrl(f.avatar || fallbackAvatar, fallbackAvatar);
            const safeUid = escapeHTML(f.uid || '');
            return `
                <div class="p-2.5 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <img src="${escapeHTML(avatarSrc)}" alt="${escapeHTML(name)}" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this,'${escapeHTML(fallbackAvatar)}');" class="w-8 h-8 rounded-full object-cover shrink-0 border border-slate-200 dark:border-slate-700">
                        <div class="min-w-0">
                            <div class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${escapeHTML(name)}</div>
                            <div class="text-[10px] text-slate-400 font-mono truncate">${escapeHTML(f.email || '')}</div>
                        </div>
                    </div>
                    <button type="button" onclick="sendFriendOnlyInvite('${safeUid}', this)" class="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg transition shrink-0 cursor-pointer">
                        發送邀請
                    </button>
                </div>
            `;
        }).join('');
    }

    modal.classList.remove('hidden');
    return true;
}

function closeFriendOnlyInviteModal() {
    _activeTeamInviteCtx = null;
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('teamInviteFriendsModal');
    if (modal) modal.classList.add('hidden');
}

async function sendFriendOnlyInvite(targetUid, btnElem = null) {
    if (isGuestUser()) return false;
    const cleanUid = String(targetUid || '').trim();
    const friends = Array.isArray(window.userData?.friends) ? window.userData.friends : [];
    const matchedFriend = friends.find(f => f && f.uid === cleanUid);

    if (!cleanUid || !matchedFriend) {
        if (typeof showToast === 'function') {
            showToast('組隊邀請僅限已加入的好友名單！', 'warning');
        }
        return false;
    }

    const ctx = _activeTeamInviteCtx;
    const rtdb = getRtdb();
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    if (!ctx || !rtdb || !currentUid) return false;

    const myName = (window.userData && window.userData.nickname)
        || firebase.auth()?.currentUser?.displayName
        || '好友';

    try {
        await rtdb.ref('groupInvites').push().set({
            inviteType: ctx.mode,
            groupId: ctx.mode === 'group' ? ctx.groupId : '',
            raidCode: ctx.mode === 'raid' ? ctx.raidCode : '',
            groupName: ctx.groupName || (ctx.mode === 'raid' ? '四人共鬥打王' : '聊天群組'),
            fromUid: currentUid,
            inviterNickname: myName,
            toUid: cleanUid,
            status: 'pending',
            createdAt: Date.now()
        });

        if (btnElem) {
            btnElem.disabled = true;
            btnElem.textContent = '已邀請';
            btnElem.className = 'px-3 py-1.5 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-xs font-bold rounded-lg shrink-0 cursor-default';
        }
        if (typeof showToast === 'function') {
            showToast(`✅ 已發送組隊邀請給「${matchedFriend.nickname || matchedFriend.username || '好友'}」！`, 'success');
        }
        return true;
    } catch (e) {
        console.error('發送組隊邀請失敗：', e);
        if (typeof showToast === 'function') showToast('發送邀請失敗：' + e.message, 'error');
        return false;
    }
}

async function handleAcceptGroupInvite(invId, targetId, encodedName = '', inviteType = 'group') {
    const rtdb = getRtdb();
    const currentUid = firebase.auth()?.currentUser?.uid || '';
    if (!rtdb || !currentUid || !invId) return false;

    let decodedName = '';
    try { decodedName = decodeURIComponent(encodedName || ''); } catch (e) { decodedName = encodedName || ''; }

    try {
        await rtdb.ref(`groupInvites/${invId}`).update({ status: 'accepted' });

        if (inviteType === 'raid') {
            if (typeof showToast === 'function') {
                showToast(`🎮 正在加入打王隊伍（房號 ${targetId}）...`, 'success');
            }
            closeChatDrawer();
            if (typeof MultiplayerEngine !== 'undefined' && typeof MultiplayerEngine.joinRaidRoom === 'function') {
                await MultiplayerEngine.joinRaidRoom(targetId);
            }
            return true;
        }

        if (targetId) {
            await rtdb.ref(`chats/${targetId}/members/${currentUid}`).set(true);
            if (typeof showToast === 'function') {
                showToast(`🎉 已加入群組「${decodedName || targetId}」！`, 'success');
            }
            await openChatWindow(targetId, encodeURIComponent(decodedName || '群組對話'));
        }
        return true;
    } catch (e) {
        console.error('接受組隊邀請失敗：', e);
        if (typeof showToast === 'function') showToast('加入失敗：' + e.message, 'error');
        return false;
    }
}

async function handleRejectGroupInvite(invId) {
    const rtdb = getRtdb();
    if (!rtdb || !invId) return false;
    try {
        await rtdb.ref(`groupInvites/${invId}`).update({ status: 'rejected' });
        if (typeof showToast === 'function') showToast('已拒絕該邀請', 'info');
        renderFriendsList();
        return true;
    } catch (e) {
        console.error('拒絕組隊邀請失敗：', e);
        return false;
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        initStaticLongPressBindings();
        syncChatNotificationMuteIndicators();
    });
}

if (typeof window !== 'undefined') {
    window.buildChatExportData = buildChatExportData;
    window.formatChatExportText = formatChatExportText;
    window.exportChatHistory = exportChatHistory;
    window.debouncedHandleChatSearch = debouncedHandleChatSearch;
    window.syncChatPrefsFromUserData = syncChatPrefsFromUserData;
    window.syncChatNotificationMuteIndicators = syncChatNotificationMuteIndicators;
    window.ensureLocalNotificationReady = ensureLocalNotificationReady;
    window.dispatchSystemNotification = dispatchSystemNotification;
    window.isChatMuted = isChatMuted;
    window.toggleChatMute = toggleChatMute;
    window.isChatPinned = isChatPinned;
    window.toggleChatPin = toggleChatPin;
    window.isChatManuallyUnread = isChatManuallyUnread;
    window.setChatManuallyUnread = setChatManuallyUnread;
    window.isThreadUnread = isThreadUnread;
    window.bindLongPress = bindLongPress;
    window.openChatThreadContextMenu = openChatThreadContextMenu;
    window.closeChatThreadContextMenu = closeChatThreadContextMenu;
    window.executeChatContextAction = executeChatContextAction;
    window.openChatDeleteConfirmModal = openChatDeleteConfirmModal;
    window.closeChatDeleteConfirmModal = closeChatDeleteConfirmModal;
    window.confirmDeleteChatThreadAction = confirmDeleteChatThreadAction;
    window.deleteChatThread = deleteChatThread;
    window.deleteChatMessage = deleteChatMessage;
    window.openFriendOnlyInviteModal = openFriendOnlyInviteModal;
    window.closeFriendOnlyInviteModal = closeFriendOnlyInviteModal;
    window.sendFriendOnlyInvite = sendFriendOnlyInvite;
    window.handleAcceptGroupInvite = handleAcceptGroupInvite;
    window.handleRejectGroupInvite = handleRejectGroupInvite;
    window.pruneExpiredChatMessages = pruneExpiredChatMessages;
    window.openAnnouncementDetailModal = openAnnouncementDetailModal;
    window.pushLineStackNotification = pushLineStackNotification;
    window.clearLineStackNotifications = clearLineStackNotifications;
    window.getBlockedUidsSet = getBlockedUidsSet;
    window.isUidBlocked = isUidBlocked;
    window.blockPlayerByUid = blockPlayerByUid;
    window.unblockPlayerByUid = unblockPlayerByUid;
    window.openUgcReportModal = openUgcReportModal;
    window.closeUgcReportModal = closeUgcReportModal;
    window.submitUgcReport = submitUgcReport;
    window.loadAdminModerationReports = loadAdminModerationReports;
    window.updateAdminReportStatus = updateAdminReportStatus;
    window.setLeaderboardMetric = setLeaderboardMetric;
    window.loadAndRenderGlobalLeaderboard = loadAndRenderGlobalLeaderboard;
    window.formatChatDateDivider = formatChatDateDivider;
}

/* ==========================================================================
   LINE 風格堆疊式即時通知橫幅佇列 (零 Emoji、支援點擊跳轉與手勢滑除)
   ========================================================================== */

const MAX_VISIBLE_LINE_NOTIFS = 4;
const _recentLineNotifKeys = new Map();

function formatLineNotifTime(tsMs) {
    const d = new Date(Number(tsMs) || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ensureLineNotifStackHost() {
    if (typeof document === 'undefined') return null;
    let host = document.getElementById('lzhLineNotifStack');
    if (!host && document.body) {
        host = document.createElement('div');
        host.id = 'lzhLineNotifStack';
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }
    return host;
}

function dismissLineStackNotification(card) {
    if (!card || card.dataset.dismissing === '1') return;
    card.dataset.dismissing = '1';
    if (card._dismissTimer) {
        clearTimeout(card._dismissTimer);
        card._dismissTimer = null;
    }
    card.classList.add('is-leaving');
    setTimeout(() => {
        if (card.parentNode) card.parentNode.removeChild(card);
    }, 240);
}

function clearLineStackNotifications() {
    const host = document.getElementById('lzhLineNotifStack');
    if (!host) return;
    Array.from(host.children).forEach(card => dismissLineStackNotification(card));
}

function handleLineNotifClick(payload) {
    if (!payload) return;
    if (payload.kind === 'announcement') {
        if (payload.annId && typeof openAnnouncementDetailModal === 'function') {
            const opened = openAnnouncementDetailModal(payload.annId);
            if (opened) return;
        }
        if (typeof openChatDrawer === 'function' && !isGuestUser()) {
            openChatDrawer();
            if (typeof switchChatTab === 'function') switchChatTab('notice');
        }
        return;
    }

    if (payload.kind === 'message' && payload.chatId) {
        if (typeof openChatDrawer === 'function' && !isGuestUser()) {
            openChatDrawer();
            if (typeof switchChatTab === 'function') switchChatTab('chats');
            if (typeof openChatWindow === 'function') {
                openChatWindow(payload.chatId, encodeURIComponent(payload.chatName || payload.title || ''));
            }
        }
    }
}

function pushLineStackNotification(payload = {}) {
    if (typeof document === 'undefined') return null;
    const host = ensureLineNotifStackHost();
    if (!host) return null;

    const dedupeKey = String(payload.dedupeKey || '');
    const now = Date.now();
    if (dedupeKey) {
        const lastAt = _recentLineNotifKeys.get(dedupeKey) || 0;
        if (now - lastAt < 3500) return null;
        _recentLineNotifKeys.set(dedupeKey, now);
        if (_recentLineNotifKeys.size > 60) {
            const oldestKey = _recentLineNotifKeys.keys().next().value;
            if (oldestKey) _recentLineNotifKeys.delete(oldestKey);
        }
    }

    const isAnn = payload.kind === 'announcement';
    const card = document.createElement('div');
    card.className = 'lzh-line-notif-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const titleText = escapeHTML(String(payload.title || (isAnn ? '系統公告' : '新訊息')));
    const tagText = escapeHTML(String(payload.tag || (isAnn ? '系統公告' : '好友訊息')));
    const previewText = escapeHTML(String(payload.preview || '').replace(/\s+/g, ' ').trim());
    const timeText = escapeHTML(String(payload.timestamp || formatLineNotifTime(now)));

    const avatarHtml = (!isAnn && payload.avatar)
        ? `<img src="${escapeHTML(payload.avatar)}" alt="" referrerpolicy="no-referrer" onerror="if(typeof handleLzhAvatarError==='function')handleLzhAvatarError(this);" class="w-10 h-10 rounded-full object-cover bg-slate-200 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 shrink-0">`
        : (isAnn
            ? `<div class="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-950/70 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 flex items-center justify-center shrink-0">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
               </div>`
            : `<div class="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-950/70 text-brand-600 dark:text-brand-400 border border-brand-200 dark:border-brand-800 flex items-center justify-center shrink-0">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
               </div>`);

    const tagClass = isAnn
        ? 'px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 text-[9.5px] font-black tracking-wide uppercase shrink-0'
        : 'px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 text-[9.5px] font-black tracking-wide uppercase shrink-0';

    card.innerHTML = `
        ${avatarHtml}
        <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-1.5">
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-xs font-extrabold text-slate-900 dark:text-white truncate">${titleText}</span>
                    <span class="${tagClass}">${tagText}</span>
                </div>
                <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500 shrink-0">${timeText}</span>
            </div>
            <div class="text-[11.5px] text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5 leading-snug break-words">${previewText}</div>
        </div>
        <button type="button" data-line-notif-close="1" aria-label="關閉通知" class="w-6 h-6 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center shrink-0 transition">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
    `;

    const closeBtn = card.querySelector('[data-line-notif-close="1"]');
    if (closeBtn) {
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissLineStackNotification(card);
        });
    }

    let startX = 0;
    let startY = 0;
    let dx = 0;
    let dy = 0;
    let swiping = false;
    let movedDuringPointer = false;

    const scheduleAutoDismiss = (delayMs = 5500) => {
        if (card._dismissTimer) clearTimeout(card._dismissTimer);
        card._dismissTimer = setTimeout(() => dismissLineStackNotification(card), delayMs);
    };

    card.addEventListener('pointerenter', () => {
        if (card._dismissTimer) {
            clearTimeout(card._dismissTimer);
            card._dismissTimer = null;
        }
    });
    card.addEventListener('pointerleave', () => {
        if (!swiping && card.dataset.dismissing !== '1') {
            scheduleAutoDismiss(3000);
        }
    });

    card.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest('[data-line-notif-close]')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        swiping = true;
        movedDuringPointer = false;
        startX = e.clientX;
        startY = e.clientY;
        dx = 0;
        dy = 0;
        if (card._dismissTimer) {
            clearTimeout(card._dismissTimer);
            card._dismissTimer = null;
        }
        card.style.transition = 'none';
        try { card.setPointerCapture(e.pointerId); } catch (err) {}
    });

    card.addEventListener('pointermove', (e) => {
        if (!swiping) return;
        dx = e.clientX - startX;
        dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > 6) movedDuringPointer = true;
        const clampedX = Math.max(-24, dx);
        const clampedY = Math.min(18, dy);
        const opacity = Math.max(0.25, 1 - (Math.max(0, clampedX) / 140) - (Math.max(0, -clampedY) / 90));
        card.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
        card.style.opacity = String(opacity);
    });

    const endSwipe = (e) => {
        if (!swiping) return;
        swiping = false;
        try { card.releasePointerCapture(e.pointerId); } catch (err) {}
        card.style.transition = '';
        if (dy < -28 || dx > 64) {
            card.style.transform = dy < -28 ? 'translate3d(0, -40px, 0)' : 'translate3d(120px, 0, 0)';
            card.style.opacity = '0';
            dismissLineStackNotification(card);
            return;
        }
        card.style.transform = '';
        card.style.opacity = '';
        scheduleAutoDismiss(4500);
    };

    card.addEventListener('pointerup', endSwipe);
    card.addEventListener('pointercancel', endSwipe);

    card.addEventListener('click', (e) => {
        if (e.target && e.target.closest('[data-line-notif-close]')) return;
        if (movedDuringPointer) {
            movedDuringPointer = false;
            return;
        }
        dismissLineStackNotification(card);
        handleLineNotifClick(payload);
    });

    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dismissLineStackNotification(card);
            handleLineNotifClick(payload);
        }
    });

    host.prepend(card);
    while (host.children.length > MAX_VISIBLE_LINE_NOTIFS) {
        const oldest = host.lastElementChild;
        if (oldest) dismissLineStackNotification(oldest);
        else break;
    }

    scheduleAutoDismiss(5500);
    return card;
}
