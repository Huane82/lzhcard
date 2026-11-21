/**
 * LZHCard - 全域權益判定、雙向事件匯流排與自訂確認對話框 (js/entitlements.js)
 * 權重順位：1. 管理員身分 -> 2. 有效本機 BYOK 金鑰 -> 3. 有效付費會員 / 金幣體驗卡 -> 4. 免費方案
 */
(function (global) {
    'use strict';

    const GROQ_KEY_STORAGE = 'lzhcard_groq_key_v1';
    const GEMINI_KEY_STORAGE = 'flashcard_gemini_key_v1';
    const MAX_TIMEOUT_MS = 2147483640;

    let dailyResetTimer = null;
    let expiryDowngradeTimer = null;
    let confirmQueue = Promise.resolve(false);

    function isStoredKeyValid(rawKey) {
        if (!rawKey) return false;
        const trimmed = String(rawKey).trim();
        return Boolean(trimmed && trimmed !== 'undefined' && trimmed !== 'null');
    }

    function isAdmin(userObj = global.userData) {
        const u = userObj || global.userData;
        return Boolean(u && (u.role === 'admin' || u.isAdmin === true));
    }

    function hasValidByok() {
        try {
            if (localStorage.getItem('lzhcard_api_mode') === 'shared') return false;
            const groq = localStorage.getItem(GROQ_KEY_STORAGE);
            const gem = localStorage.getItem(GEMINI_KEY_STORAGE);
            return isStoredKeyValid(groq) || isStoredKeyValid(gem);
        } catch (e) {
            return false;
        }
    }

    function getEffectiveStatus(userObj = global.userData) {
        const u = userObj || global.userData || {};
        const admin = isAdmin(u);
        const byok = hasValidByok();
        const me = global.MembershipEngine;

        let resolved = {
            tier: 'free',
            isSupporter: false,
            isCoinTrial: false,
            isAdmin: admin,
            expiresAt: 0,
            remainingDays: 0,
            priceNtd: 0
        };

        if (me && typeof me.resolveActiveMembership === 'function') {
            resolved = me.resolveActiveMembership(u, Date.now());
        } else if (admin) {
            resolved.tier = 'supporter_180';
            resolved.isSupporter = true;
            resolved.expiresAt = Date.now() + 3650 * 86400000;
            resolved.remainingDays = 3650;
            resolved.priceNtd = 180;
        }

        const effectiveTier = admin
            ? 'admin'
            : (resolved.isSupporter ? resolved.tier : 'free');

        const unlimited = Boolean(admin || byok);
        const coins = Math.max(0, Math.floor(Number(u.coins) || 0));

        let source = 'free';
        if (admin) source = 'admin';
        else if (byok) source = 'byok';
        else if (resolved.isSupporter) source = resolved.isCoinTrial ? 'coin_trial' : 'membership';

        return {
            source,
            isAdmin: admin,
            byok,
            unlimited,
            membershipTier: resolved.tier,
            effectiveTier,
            isSupporter: Boolean(admin || resolved.isSupporter),
            isCoinTrial: Boolean(!admin && resolved.isCoinTrial),
            expiresAt: Number(resolved.expiresAt) || 0,
            remainingDays: Number(resolved.remainingDays) || 0,
            coins
        };
    }

    function canUseFeature(feature = 'def_fill') {
        const status = getEffectiveStatus();
        if (status.isAdmin || status.byok) {
            return {
                allowed: true,
                unlimited: true,
                byok: status.byok,
                isAdmin: status.isAdmin,
                tier: status.membershipTier,
                remaining: 999999,
                status
            };
        }
        const me = global.MembershipEngine;
        if (me && typeof me.canConsumeAiQuota === 'function') {
            const q = me.canConsumeAiQuota(feature);
            return {
                ...q,
                unlimited: false,
                status
            };
        }
        return {
            allowed: true,
            unlimited: false,
            byok: false,
            isAdmin: false,
            tier: status.membershipTier,
            remaining: 1,
            status
        };
    }

    function computeNextUtcPlus8MidnightMs() {
        const offsetMs = 8 * 3600 * 1000;
        const nowUtc8 = Date.now() + offsetMs;
        const dayMs = 86400 * 1000;
        const nextMidnightUtc8 = (Math.floor(nowUtc8 / dayMs) + 1) * dayMs;
        return Math.max(1000, (nextMidnightUtc8 - offsetMs) - Date.now() + 500);
    }

    function scheduleSyncTimers() {
        if (dailyResetTimer) {
            clearTimeout(dailyResetTimer);
            dailyResetTimer = null;
        }
        if (expiryDowngradeTimer) {
            clearTimeout(expiryDowngradeTimer);
            expiryDowngradeTimer = null;
        }

        const msToDailyReset = computeNextUtcPlus8MidnightMs();
        dailyResetTimer = setTimeout(() => {
            if (global.MembershipEngine && typeof global.MembershipEngine.ensureMembershipDefaults === 'function' && global.userData) {
                global.MembershipEngine.ensureMembershipDefaults(global.userData);
            }
            if (global.MembershipEngine && typeof global.MembershipEngine.refreshQuotaStatusFromServer === 'function') {
                global.MembershipEngine.refreshQuotaStatusFromServer().catch(() => {});
            }
            notifyStateChange('utc8_daily_reset');
        }, Math.min(MAX_TIMEOUT_MS, msToDailyReset));

        const status = getEffectiveStatus();
        if (!status.isAdmin && status.expiresAt > Date.now()) {
            const delay = (status.expiresAt - Date.now()) + 600;
            if (delay <= MAX_TIMEOUT_MS) {
                expiryDowngradeTimer = setTimeout(() => {
                    if (typeof global.checkMembershipExpiration === 'function') {
                        global.checkMembershipExpiration({ silent: false, sync: true });
                    }
                    notifyStateChange('membership_expired_timer');
                }, Math.max(500, delay));
            }
        }
    }

    function notifyStateChange(reason = 'manual', detail = {}) {
        const status = getEffectiveStatus();
        scheduleSyncTimers();

        if (typeof global.updateApiKeyStatusUI === 'function') {
            try { global.updateApiKeyStatusUI(); } catch (e) {}
        }
        if (typeof global.updateUserCoinsUI === 'function') {
            try { global.updateUserCoinsUI(); } catch (e) {}
        }
        if (typeof global.refreshFSRSUIBadges === 'function') {
            try { global.refreshFSRSUIBadges(); } catch (e) {}
        }
        if (typeof global.syncConfigToNativeOverlay === 'function') {
            try { global.syncConfigToNativeOverlay(); } catch (e) {}
        }

        const memModal = typeof document !== 'undefined' ? document.getElementById('membershipModal') : null;
        if (memModal && !memModal.classList.contains('hidden') && global.MembershipEngine && typeof global.MembershipEngine.renderMembershipModalBody === 'function') {
            try { global.MembershipEngine.renderMembershipModalBody(); } catch (e) {}
        }

        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
            try {
                global.dispatchEvent(new global.CustomEvent('lzh:state-updated', {
                    detail: {
                        reason,
                        status,
                        ...detail,
                        timestamp: Date.now()
                    }
                }));
            } catch (e) {}
        }
        return status;
    }

    function openCustomConfirmModal(message, options = {}) {
        const doc = global.document;
        if (!doc) return Promise.resolve(false);

        const modal = doc.getElementById('lzhConfirmModal');
        const msgEl = doc.getElementById('lzhConfirmMessage');
        const titleEl = doc.getElementById('lzhConfirmTitle');
        const okBtn = doc.getElementById('lzhConfirmOkBtn');
        const cancelBtn = doc.getElementById('lzhConfirmCancelBtn');

        if (!modal || !msgEl || !okBtn || !cancelBtn) {
            return Promise.resolve(false);
        }

        return new Promise((resolve) => {
            const titleText = options.title || (typeof global.t === 'function' ? global.t('confirmDialogTitle') : '') || '系統確認';
            const okText = options.confirmText || (typeof global.t === 'function' ? global.t('btnConfirm') : '') || '確定';
            const cancelText = options.cancelText || (typeof global.t === 'function' ? global.t('btnCancel') : '') || '取消';
            const isDanger = options.danger !== undefined
                ? Boolean(options.danger)
                : /(刪除|清空|強制|警告|下架|歸零|還原|花費)/.test(String(message || ''));

            if (titleEl && titleText !== 'confirmDialogTitle') {
                titleEl.textContent = titleText;
            }
            msgEl.textContent = String(message || '');
            okBtn.textContent = okText === 'btnConfirm' ? '確定' : okText;
            cancelBtn.textContent = cancelText === 'btnCancel' ? '取消' : cancelText;
            okBtn.className = isDanger
                ? 'min-h-[44px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold shadow-xs transition cursor-pointer'
                : 'min-h-[44px] px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-xs transition cursor-pointer';

            let settled = false;
            const cleanup = (result) => {
                if (settled) return;
                settled = true;
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onBackdrop);
                doc.removeEventListener('keydown', onKeyDown, true);
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                resolve(result);
            };

            const onOk = () => cleanup(true);
            const onCancel = () => cleanup(false);
            const onBackdrop = (ev) => {
                if (ev.target === modal) cleanup(false);
            };
            const onKeyDown = (ev) => {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    cleanup(false);
                } else if (ev.key === 'Enter' && doc.activeElement !== cancelBtn) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    cleanup(true);
                }
            };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onBackdrop);
            doc.addEventListener('keydown', onKeyDown, true);

            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                try { okBtn.focus(); } catch (e) {}
            }, 20);
        });
    }

    function lzhConfirm(message, options = {}) {
        const nextPromise = confirmQueue.then(
            () => openCustomConfirmModal(message, options),
            () => openCustomConfirmModal(message, options)
        );
        confirmQueue = nextPromise.catch(() => false);
        return nextPromise;
    }

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('storage', (ev) => {
            if (ev && (ev.key === GROQ_KEY_STORAGE || ev.key === GEMINI_KEY_STORAGE || ev.key === 'lzhcard_api_mode')) {
                notifyStateChange('storage_key_changed');
            }
        });
        if (typeof global.document !== 'undefined') {
            global.document.addEventListener('DOMContentLoaded', () => {
                scheduleSyncTimers();
            });
        }
    }

    global.LZHEntitlements = {
        isAdmin,
        hasValidByok,
        getEffectiveStatus,
        canUseFeature,
        notifyStateChange,
        scheduleSyncTimers,
        confirm: lzhConfirm
    };
    global.lzhConfirm = lzhConfirm;
})(typeof window !== 'undefined' ? window : globalThis);
