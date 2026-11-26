/**
 * LZHCard - 全域權益判定、雙向事件匯流排與自訂確認對話框 (js/entitlements.js)
 * 權重順位：1. 管理員身分 -> 2. 有效付費會員 / 金幣體驗卡 -> 3. 班級教師 AI 共享 -> 4. 免費方案
 */
(function (global) {
    'use strict';

    const MAX_TIMEOUT_MS = 2147483640;

    let dailyResetTimer = null;
    let expiryDowngradeTimer = null;
    let confirmQueue = Promise.resolve(false);

    function isAdmin(userObj = global.userData) {
        const u = userObj || global.userData;
        return Boolean(u && (u.role === 'admin' || u.isAdmin === true));
    }

    function getEffectiveStatus(userObj = global.userData) {
        const u = userObj || global.userData || {};
        const admin = isAdmin(u);
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
            resolved.tier = 'teacher_class';
            resolved.isSupporter = true;
            resolved.expiresAt = Date.now() + 3650 * 86400000;
            resolved.remainingDays = 3650;
            resolved.priceNtd = 490;
        }

        const sponsor = (me && typeof me.getActiveClassroomSponsor === 'function')
            ? me.getActiveClassroomSponsor()
            : null;
        const classSponsored = Boolean(sponsor && sponsor.chatId);

        const effectiveTier = admin
            ? 'admin'
            : (resolved.isSupporter ? resolved.tier : (classSponsored ? 'teacher_class' : 'free'));

        const unlimited = Boolean(admin);
        const coins = Math.max(0, Math.floor(Number(u.coins) || 0));

        let source = 'free';
        if (admin) source = 'admin';
        else if (resolved.isSupporter) source = resolved.isCoinTrial ? 'coin_trial' : 'membership';
        else if (classSponsored) source = 'classroom_sponsor';

        return {
            source,
            isAdmin: admin,
            classSponsored,
            classSponsor: sponsor,
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

    function canUseFeature(feature = 'def_fill', options = {}) {
        const status = getEffectiveStatus();
        if (status.isAdmin) {
            return {
                allowed: true,
                unlimited: true,
                isAdmin: true,
                tier: status.membershipTier,
                remaining: 999999,
                status
            };
        }
        const me = global.MembershipEngine;
        if (me && typeof me.canConsumeAiQuota === 'function') {
            const q = me.canConsumeAiQuota(feature, options);
            return {
                ...q,
                unlimited: false,
                status
            };
        }
        return {
            allowed: false,
            unlimited: false,
            isAdmin: false,
            tier: status.membershipTier,
            remaining: 0,
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

    function openCustomPromptModal(message, defaultValue = '', options = {}) {
        const doc = global.document;
        if (!doc) return Promise.resolve(null);
        let modal = doc.getElementById('lzhPromptModal');
        if (!modal) {
            modal = doc.createElement('div');
            modal.id = 'lzhPromptModal';
            modal.className = 'hidden fixed inset-0 z-[86] bg-slate-950/70 backdrop-blur-xs items-center justify-center p-4 lzh-safe-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.innerHTML = `
                <div class="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl max-w-md w-full p-5 space-y-3.5 shadow-2xl border border-slate-200 dark:border-slate-700">
                    <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-2.5">
                        <h3 id="lzhPromptTitle" class="text-sm font-black text-slate-900 dark:text-white">請輸入內容</h3>
                        <button type="button" id="lzhPromptCloseBtn" class="min-w-[40px] min-h-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <p id="lzhPromptMessage" class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line break-words"></p>
                    <input type="text" id="lzhPromptInput" class="w-full min-h-[44px] px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold outline-none focus:ring-2 focus:ring-brand-500">
                    <div class="flex justify-end gap-2 pt-1">
                        <button type="button" id="lzhPromptCancelBtn" class="min-h-[44px] px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold cursor-pointer">取消</button>
                        <button type="button" id="lzhPromptOkBtn" class="min-h-[44px] px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-xs cursor-pointer">確定</button>
                    </div>
                </div>
            `;
            doc.body.appendChild(modal);
        }

        const titleEl = doc.getElementById('lzhPromptTitle');
        const msgEl = doc.getElementById('lzhPromptMessage');
        const inputEl = doc.getElementById('lzhPromptInput');
        const okBtn = doc.getElementById('lzhPromptOkBtn');
        const cancelBtn = doc.getElementById('lzhPromptCancelBtn');
        const closeBtn = doc.getElementById('lzhPromptCloseBtn');

        if (titleEl) titleEl.textContent = options.title || '請輸入';
        if (msgEl) msgEl.textContent = String(message || '');
        if (inputEl) {
            inputEl.value = String(defaultValue || '');
            inputEl.placeholder = options.placeholder || '';
        }

        return new Promise((resolve) => {
            let settled = false;
            const cleanup = (val) => {
                if (settled) return;
                settled = true;
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                closeBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onBackdrop);
                doc.removeEventListener('keydown', onKeyDown, true);
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                resolve(val);
            };
            const onOk = () => cleanup(inputEl ? inputEl.value : '');
            const onCancel = () => cleanup(null);
            const onBackdrop = (ev) => { if (ev.target === modal) cleanup(null); };
            const onKeyDown = (ev) => {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    cleanup(null);
                } else if (ev.key === 'Enter') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onOk();
                }
            };
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            closeBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onBackdrop);
            doc.addEventListener('keydown', onKeyDown, true);
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => { try { inputEl?.focus(); inputEl?.select(); } catch (e) {} }, 25);
        });
    }

    function openCustomChoiceModal(message, choices = [], options = {}) {
        const doc = global.document;
        if (!doc) return Promise.resolve(null);
        let modal = doc.getElementById('lzhChoiceModal');
        if (!modal) {
            modal = doc.createElement('div');
            modal.id = 'lzhChoiceModal';
            modal.className = 'hidden fixed inset-0 z-[86] bg-slate-950/70 backdrop-blur-xs items-center justify-center p-4 lzh-safe-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.innerHTML = `
                <div class="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl max-w-md w-full p-5 space-y-3.5 shadow-2xl border border-slate-200 dark:border-slate-700">
                    <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-2.5">
                        <h3 id="lzhChoiceTitle" class="text-sm font-black text-slate-900 dark:text-white">請選擇操作</h3>
                        <button type="button" id="lzhChoiceCloseBtn" class="min-w-[40px] min-h-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <p id="lzhChoiceMessage" class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line break-words"></p>
                    <div id="lzhChoiceList" class="space-y-2 max-h-60 overflow-y-auto"></div>
                    <div class="flex justify-end pt-1">
                        <button type="button" id="lzhChoiceCancelBtn" class="min-h-[44px] px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold cursor-pointer">取消</button>
                    </div>
                </div>
            `;
            doc.body.appendChild(modal);
        }

        const titleEl = doc.getElementById('lzhChoiceTitle');
        const msgEl = doc.getElementById('lzhChoiceMessage');
        const listEl = doc.getElementById('lzhChoiceList');
        const cancelBtn = doc.getElementById('lzhChoiceCancelBtn');
        const closeBtn = doc.getElementById('lzhChoiceCloseBtn');

        if (titleEl) titleEl.textContent = options.title || '請選擇';
        if (msgEl) msgEl.textContent = String(message || '');

        return new Promise((resolve) => {
            let settled = false;
            const cleanup = (val) => {
                if (settled) return;
                settled = true;
                cancelBtn.removeEventListener('click', onCancel);
                closeBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onBackdrop);
                doc.removeEventListener('keydown', onKeyDown, true);
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                resolve(val);
            };
            const onCancel = () => cleanup(null);
            const onBackdrop = (ev) => { if (ev.target === modal) cleanup(null); };
            const onKeyDown = (ev) => {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    cleanup(null);
                }
            };

            if (listEl) {
                listEl.innerHTML = '';
                (Array.isArray(choices) ? choices : []).forEach((item) => {
                    const obj = typeof item === 'object' && item !== null ? item : { value: String(item), label: String(item) };
                    const btn = doc.createElement('button');
                    btn.type = 'button';
                    btn.className = 'w-full min-h-[44px] px-3.5 py-2.5 text-left rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-brand-400 hover:bg-brand-50/60 dark:hover:bg-brand-950/40 text-xs font-bold text-slate-800 dark:text-slate-100 transition cursor-pointer flex items-center justify-between gap-2';
                    const lbl = doc.createElement('span');
                    lbl.textContent = obj.label || obj.value;
                    btn.appendChild(lbl);
                    if (obj.sub) {
                        const sub = doc.createElement('span');
                        sub.className = 'text-[10px] font-semibold text-slate-400 shrink-0';
                        sub.textContent = obj.sub;
                        btn.appendChild(sub);
                    }
                    btn.addEventListener('click', () => cleanup(obj.value));
                    listEl.appendChild(btn);
                });
            }

            cancelBtn.addEventListener('click', onCancel);
            closeBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onBackdrop);
            doc.addEventListener('keydown', onKeyDown, true);
            modal.classList.remove('hidden');
            modal.classList.add('flex');
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

    function lzhPrompt(message, defaultValue = '', options = {}) {
        const nextPromise = confirmQueue.then(
            () => openCustomPromptModal(message, defaultValue, options),
            () => openCustomPromptModal(message, defaultValue, options)
        );
        confirmQueue = nextPromise.catch(() => null);
        return nextPromise;
    }

    function lzhChoice(message, choices = [], options = {}) {
        const nextPromise = confirmQueue.then(
            () => openCustomChoiceModal(message, choices, options),
            () => openCustomChoiceModal(message, choices, options)
        );
        confirmQueue = nextPromise.catch(() => null);
        return nextPromise;
    }

    if (typeof global.addEventListener === 'function' && typeof global.document !== 'undefined') {
        global.document.addEventListener('DOMContentLoaded', () => {
            scheduleSyncTimers();
        });
    }

    global.LZHEntitlements = {
        isAdmin,
        getEffectiveStatus,
        canUseFeature,
        notifyStateChange,
        scheduleSyncTimers,
        confirm: lzhConfirm,
        prompt: lzhPrompt,
        choice: lzhChoice
    };
    global.lzhConfirm = lzhConfirm;
    global.lzhPrompt = lzhPrompt;
    global.lzhChoice = lzhChoice;
})(typeof window !== 'undefined' ? window : globalThis);
