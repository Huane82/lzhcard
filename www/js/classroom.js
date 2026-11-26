/**
 * LZHCard - 班級老師模式與群組同步課堂模組 (classroom.js)
 * 支援功能：
 * 1. 建立群組時勾選啟用「班級老師模式」(teacherMode: true, 上限 50 人)
 * 2. 全員禁言 (muteAll) 與指定學生禁言 (mutedUids)
 * 3. 發起班級挑戰：教師自訂題 / 勾選字庫自動出題 / 考試級 AI 出題 (✨ AI 需 Teacher Class 或會員資格)
 *    - 題型：選擇 (2~6 選項)、拼字、混合
 *    - 節奏：老師同步控場跳題 (teacher_sync) / 限時自由作答 (timed_free)
 *    - 即時跳題、立刻結束、依「正確率高優先 -> 總答題速度越快優先」排名
 * 4. 派發每日學習任務（刷字卡數 / 完成測驗題數 / 完成班級挑戰，支援每日循環 recurringDaily）
 * 5. 查看學生學習狀況與每日任務進度（群組全員互看 或 僅限老師查看 progressVisibility）
 * 6. 班級教師 AI 額度共享 (getSponsorGroupId 供 Worker 驗證全班 <= 50 人共享)
 */
(function (global) {
    'use strict';

    const MAX_CLASSROOM_MEMBERS = 50;
    let activeGroupId = '';
    let activeGroupData = null;
    let activeSubTab = 'chat'; // 'chat' | 'challenges' | 'tasks' | 'progress'
    let groupMetaListener = null;
    let groupChallengesListener = null;
    let groupTasksListener = null;
    let groupSnapshotsListener = null;

    let challengesMap = {};
    let tasksMap = {};
    let snapshotsMap = {};

    let selectedChallengeId = '';
    let customDraftQuestions = [];
    let liveRunState = {
        challengeId: '',
        qIdx: 0,
        startedAtMs: 0,
        questionStartMs: 0,
        answers: {},
        perQuestionMs: {},
        submitted: false,
        timerHandle: null,
        remainingSec: 0
    };
    let snapshotSyncTimer = null;

    function getRtdbSafe() {
        try {
            if (typeof getRtdb === 'function') return getRtdb();
            if (typeof firebase !== 'undefined' && firebase.database) return firebase.database();
        } catch (e) {}
        return null;
    }

    function getCurrentUidSafe() {
        try {
            if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
                return firebase.auth().currentUser.uid || '';
            }
        } catch (e) {}
        return '';
    }

    function getCurrentDisplayNameSafe() {
        const nick = global.userData && global.userData.nickname ? String(global.userData.nickname).trim() : '';
        if (nick) return nick;
        try {
            const u = firebase.auth && firebase.auth().currentUser;
            if (u) return u.displayName || (u.email ? u.email.split('@')[0] : '學生');
        } catch (e) {}
        return '玩家';
    }

    function escapeClassHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getTodayDateKey() {
        const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function isTeacherOfGroup(groupData = activeGroupData, uid = getCurrentUidSafe()) {
        if (!groupData || !uid) return false;
        return groupData.teacherMode === true && groupData.ownerUid === uid;
    }

    function isMutedInGroup(groupData = activeGroupData, uid = getCurrentUidSafe()) {
        if (!groupData || groupData.teacherMode !== true) return false;
        if (isTeacherOfGroup(groupData, uid)) return false;
        const settings = groupData.classroomSettings || {};
        if (settings.muteAll === true) return true;
        if (settings.mutedUids && settings.mutedUids[uid] === true) return true;
        return false;
    }

    function getGroupMemberUids(groupData = activeGroupData) {
        if (!groupData || !groupData.members || typeof groupData.members !== 'object') return [];
        return Object.keys(groupData.members).filter(uid => groupData.members[uid] === true);
    }

    function getMemberLabel(uid) {
        if (!uid) return '未知成員';
        if (snapshotsMap[uid] && snapshotsMap[uid].nickname) return snapshotsMap[uid].nickname;
        try {
            if (typeof onlineUsersMap !== 'undefined' && onlineUsersMap[uid] && onlineUsersMap[uid].nickname) {
                return onlineUsersMap[uid].nickname;
            }
        } catch (e) {}
        const friends = Array.isArray(global.userData?.friends) ? global.userData.friends : [];
        const f = friends.find(item => item && item.uid === uid);
        if (f && (f.nickname || f.username)) return f.nickname || f.username;
        if (uid === getCurrentUidSafe()) return getCurrentDisplayNameSafe();
        return `成員 ${uid.slice(0, 6)}`;
    }

    function hasAiSponsorEligibility() {
        if (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.hasPaidMembership === 'function') {
            if (global.MembershipEngine.hasPaidMembership()) return true;
        }
        if (getSponsorGroupId()) return true;
        return false;
    }

    function getSponsorGroupId() {
        const uid = getCurrentUidSafe();
        if (!uid) return '';
        const candidates = [];
        if (activeGroupData && activeGroupData.teacherMode === true && activeGroupData.members?.[uid] === true) {
            candidates.push({ id: activeGroupId, data: activeGroupData });
        }
        try {
            if (typeof userChatThreads !== 'undefined' && Array.isArray(userChatThreads)) {
                userChatThreads.forEach(th => {
                    if (th && th.teacherMode === true && th.members?.[uid] === true) {
                        if (!candidates.some(c => c.id === th.id)) {
                            candidates.push({ id: th.id, data: th });
                        }
                    }
                });
            }
        } catch (e) {}
        if (candidates.length === 0) return '';

        // 優先挑選已知老師擁有 teacher_class 或管理員權限的班級群組
        for (const c of candidates) {
            const ownerUid = c.data.ownerUid || '';
            let onlineOwner = null;
            try {
                if (typeof onlineUsersMap !== 'undefined' && ownerUid) {
                    onlineOwner = onlineUsersMap[ownerUid];
                }
            } catch (e) {}
            if (onlineOwner && (onlineOwner.membershipTier === 'teacher_class' || onlineOwner.isAdmin === true || onlineOwner.role === 'admin')) {
                return c.id;
            }
            if (c.data.sponsorActive === true || c.data.ownerTier === 'teacher_class') {
                return c.id;
            }
        }
        return candidates[0].id;
    }

    // =========================================================================
    // 1. 建立群組自訂視窗 (取代原生 prompt)
    // =========================================================================
    function ensureCreateGroupModalDom() {
        if (typeof document === 'undefined') return null;
        let modal = document.getElementById('createGroupModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'createGroupModal';
        modal.className = 'hidden fixed inset-0 z-[82] bg-slate-950/70 backdrop-blur-xs items-center justify-center p-4 lzh-safe-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-3">
                    <div class="flex items-center gap-2">
                        <div class="w-9 h-9 rounded-xl bg-brand-100 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center">
                            <i class="fa-solid fa-users-rectangle"></i>
                        </div>
                        <div>
                            <h3 class="font-extrabold text-sm text-slate-900 dark:text-white">建立新群組</h3>
                            <p class="text-[11px] text-slate-400">可建立一般交流群組或班級老師專屬教室</p>
                        </div>
                    </div>
                    <button type="button" onclick="ClassroomEngine.closeCreateGroupModal()" class="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer">
                        <i class="fa-solid fa-xmark text-lg"></i>
                    </button>
                </div>

                <div class="space-y-3">
                    <div>
                        <label for="newGroupNameInput" class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">群組／班級名稱</label>
                        <input type="text" id="newGroupNameInput" maxlength="40" placeholder="例如：高三學測衝刺班 / 日檢 N3 共學團" class="w-full min-h-[44px] px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-semibold outline-none focus:ring-2 focus:ring-brand-500">
                    </div>

                    <label class="flex items-start gap-3 p-3.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/35 border border-indigo-200 dark:border-indigo-800 cursor-pointer select-none">
                        <input type="checkbox" id="newGroupTeacherModeChk" class="mt-0.5 w-5 h-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0">
                        <div class="space-y-1">
                            <div class="text-xs font-extrabold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
                                <span>🎓 啟用班級老師模式</span>
                                <span class="px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold">上限 50 人</span>
                            </div>
                            <p class="text-[11px] text-indigo-800/80 dark:text-indigo-300/80 leading-relaxed">
                                開啟後您將成為該群組管理老師，可使用：全員／個別禁言、班級同步／限時出題挑戰、每日任務派發與學生進度追蹤；若老師擁有教師班級方案，全班最多 50 人共用 AI 額度。
                            </p>
                        </div>
                    </label>
                </div>

                <div class="flex justify-end gap-2 pt-1">
                    <button type="button" onclick="ClassroomEngine.closeCreateGroupModal()" class="min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer">取消</button>
                    <button type="button" id="confirmCreateGroupBtn" onclick="ClassroomEngine.submitCreateGroupModal()" class="min-h-[44px] px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-sm transition cursor-pointer">建立群組</button>
                </div>
            </div>
        `;
        modal.addEventListener('click', (ev) => {
            if (ev.target === modal) closeCreateGroupModal();
        });
        document.body.appendChild(modal);
        return modal;
    }

    function openCreateGroupModal() {
        const uid = getCurrentUidSafe();
        if (!uid) {
            if (typeof showToast === 'function') showToast('請先登入帳號才能建立群組！', 'warning');
            return;
        }
        const modal = ensureCreateGroupModalDom();
        if (!modal) return;
        const nameInput = document.getElementById('newGroupNameInput');
        const teacherChk = document.getElementById('newGroupTeacherModeChk');
        if (nameInput) nameInput.value = '';
        if (teacherChk) teacherChk.checked = false;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => { try { nameInput?.focus(); } catch (e) {} }, 60);
    }

    function closeCreateGroupModal() {
        const modal = document.getElementById('createGroupModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    async function submitCreateGroupModal() {
        const uid = getCurrentUidSafe();
        const rtdb = getRtdbSafe();
        if (!uid || !rtdb) return;

        const nameInput = document.getElementById('newGroupNameInput');
        const teacherChk = document.getElementById('newGroupTeacherModeChk');
        const groupName = (nameInput?.value || '').trim();
        const teacherMode = Boolean(teacherChk?.checked);

        if (!groupName) {
            if (typeof showToast === 'function') showToast('請輸入群組名稱！', 'warning');
            nameInput?.focus();
            return;
        }

        const myName = getCurrentDisplayNameSafe();
        const btn = document.getElementById('confirmCreateGroupBtn');
        if (btn) btn.disabled = true;

        try {
            const newChatRef = rtdb.ref('chats').push();
            const now = Date.now();
            const myTier = (typeof global.MembershipEngine !== 'undefined' && typeof global.MembershipEngine.getEffectiveTier === 'function')
                ? global.MembershipEngine.getEffectiveTier()
                : 'free';

            const payload = {
                type: 'group',
                name: groupName,
                ownerUid: uid,
                teacherMode,
                maxMembers: teacherMode ? MAX_CLASSROOM_MEMBERS : 200,
                ownerTier: myTier,
                sponsorActive: teacherMode && myTier === 'teacher_class',
                members: { [uid]: true },
                lastMessage: teacherMode
                    ? `${myName} 建立了班級教室群組「${groupName}」`
                    : `${myName} 建立了群組「${groupName}」`,
                lastSenderUid: uid,
                createdAt: now,
                updatedAt: now
            };

            if (teacherMode) {
                payload.classroomSettings = {
                    muteAll: false,
                    mutedUids: {},
                    progressVisibility: 'all'
                };
            }

            await newChatRef.set(payload);
            closeCreateGroupModal();
            if (typeof showToast === 'function') {
                showToast(teacherMode ? `🎓 已建立班級教室「${groupName}」` : `🎉 已成功建立群組「${groupName}」`, 'success');
            }
            if (typeof openChatWindow === 'function') {
                openChatWindow(newChatRef.key, encodeURIComponent(groupName));
            }
        } catch (err) {
            console.error('建立群組失敗:', err);
            if (typeof showToast === 'function') showToast('建立群組失敗：' + (err.message || '未知錯誤'), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // =========================================================================
    // 2. 聊天室頁籤與即時監聽生命週期管理
    // =========================================================================
    function ensureClassroomContainersInChatWindow() {
        if (typeof document === 'undefined') return {};
        const win = document.getElementById('activeChatWindow');
        const msgBox = document.getElementById('chatMessagesBox');
        const msgForm = win ? win.querySelector('form[onsubmit*="handleSendMessage"]') : null;
        if (!win || !msgBox) return {};

        let subTabBar = document.getElementById('classroomSubTabBar');
        if (!subTabBar) {
            subTabBar = document.createElement('div');
            subTabBar.id = 'classroomSubTabBar';
            subTabBar.className = 'hidden px-2.5 py-2 bg-indigo-50/80 dark:bg-slate-900 border-b border-indigo-100 dark:border-slate-700 grid grid-cols-4 gap-1.5 shrink-0';
            msgBox.insertAdjacentElement('beforebegin', subTabBar);
        }

        let muteBanner = document.getElementById('classroomMuteBanner');
        if (!muteBanner) {
            muteBanner = document.createElement('div');
            muteBanner.id = 'classroomMuteBanner';
            muteBanner.className = 'hidden px-3 py-2 bg-amber-50 dark:bg-amber-950/50 border-b border-amber-200 dark:border-amber-800 text-[11px] font-bold text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2 shrink-0';
            subTabBar.insertAdjacentElement('afterend', muteBanner);
        }

        let workspace = document.getElementById('classroomWorkspacePane');
        if (!workspace) {
            workspace = document.createElement('div');
            workspace.id = 'classroomWorkspacePane';
            workspace.className = 'hidden flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50/70 dark:bg-slate-900/50';
            msgBox.insertAdjacentElement('afterend', workspace);
        }

        return { win, msgBox, msgForm, subTabBar, muteBanner, workspace };
    }

    function detachGroupListeners() {
        const rtdb = getRtdbSafe();
        if (rtdb && activeGroupId) {
            if (groupMetaListener) rtdb.ref(`chats/${activeGroupId}`).off('value', groupMetaListener);
            if (groupChallengesListener) rtdb.ref(`chats/${activeGroupId}/challenges`).off('value', groupChallengesListener);
            if (groupTasksListener) rtdb.ref(`chats/${activeGroupId}/dailyTasks`).off('value', groupTasksListener);
            if (groupSnapshotsListener) rtdb.ref(`chats/${activeGroupId}/studentSnapshots`).off('value', groupSnapshotsListener);
        }
        groupMetaListener = null;
        groupChallengesListener = null;
        groupTasksListener = null;
        groupSnapshotsListener = null;
        activeGroupId = '';
        activeGroupData = null;
        challengesMap = {};
        tasksMap = {};
        snapshotsMap = {};
        selectedChallengeId = '';
        stopLiveRunnerTimer();

        const { subTabBar, muteBanner, workspace, msgBox, msgForm } = ensureClassroomContainersInChatWindow();
        if (subTabBar) subTabBar.classList.add('hidden');
        if (muteBanner) muteBanner.classList.add('hidden');
        if (workspace) {
            workspace.classList.add('hidden');
            workspace.innerHTML = '';
        }
        if (msgBox) msgBox.classList.remove('hidden');
        if (msgForm) msgForm.classList.remove('hidden');
    }

    function openGroupWorkspace(chatId, initialData = null) {
        detachGroupListeners();
        activeGroupId = String(chatId || '').trim();
        activeGroupData = initialData || null;
        activeSubTab = 'chat';
        customDraftQuestions = [];

        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || activeGroupId === 'chat_group_public') {
            renderClassroomShell();
            return;
        }

        groupMetaListener = rtdb.ref(`chats/${activeGroupId}`).on('value', (snap) => {
            const val = snap.val();
            if (!val) return;
            activeGroupData = { id: activeGroupId, ...val };
            if (typeof global !== 'undefined') {
                global.currentActiveChatData = activeGroupData;
            }
            if (val.teacherMode === true) {
                ensureClassroomSubListeners(activeGroupId);
                syncMyStudentSnapshotForGroup(activeGroupId);
            }
            renderClassroomShell();
        });

        renderClassroomShell();
    }

    function ensureClassroomSubListeners(chatId) {
        const rtdb = getRtdbSafe();
        if (!rtdb || !chatId) return;
        if (!groupChallengesListener) {
            groupChallengesListener = rtdb.ref(`chats/${chatId}/challenges`).on('value', (snap) => {
                challengesMap = snap.val() || {};
                renderClassroomShell();
            });
        }
        if (!groupTasksListener) {
            groupTasksListener = rtdb.ref(`chats/${chatId}/dailyTasks`).on('value', (snap) => {
                tasksMap = snap.val() || {};
                renderClassroomShell();
            });
        }
        if (!groupSnapshotsListener) {
            groupSnapshotsListener = rtdb.ref(`chats/${chatId}/studentSnapshots`).on('value', (snap) => {
                snapshotsMap = snap.val() || {};
                renderClassroomShell();
            });
        }
    }

    function switchSubTab(tab) {
        activeSubTab = tab || 'chat';
        renderClassroomShell();
    }

    function renderClassroomShell() {
        const { msgBox, msgForm, subTabBar, muteBanner, workspace } = ensureClassroomContainersInChatWindow();
        if (!subTabBar || !workspace || !msgBox) return;

        const isTeacherClass = Boolean(activeGroupData && activeGroupData.teacherMode === true);
        subTabBar.classList.toggle('hidden', !isTeacherClass);

        if (!isTeacherClass) {
            muteBanner?.classList.add('hidden');
            workspace.classList.add('hidden');
            msgBox.classList.remove('hidden');
            if (msgForm) msgForm.classList.remove('hidden');
            return;
        }

        const activeChallengeCount = Object.values(challengesMap).filter(c => c && c.status === 'active').length;
        const taskCount = Object.keys(tasksMap).length;
        const memberCount = getGroupMemberUids(activeGroupData).length;

        const tabs = [
            { id: 'chat', icon: 'fa-comments', label: '聊天' },
            { id: 'challenges', icon: 'fa-trophy', label: activeChallengeCount > 0 ? `挑戰 (${activeChallengeCount})` : '挑戰' },
            { id: 'tasks', icon: 'fa-list-check', label: taskCount > 0 ? `任務 (${taskCount})` : '任務' },
            { id: 'progress', icon: 'fa-user-graduate', label: `進度 (${memberCount})` }
        ];

        subTabBar.innerHTML = tabs.map(t => {
            const active = activeSubTab === t.id;
            return `
                <button type="button" onclick="ClassroomEngine.switchSubTab('${t.id}')" class="min-h-[38px] px-2 py-1.5 rounded-xl text-[11px] font-extrabold transition flex items-center justify-center gap-1 cursor-pointer ${
                    active
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-indigo-50 dark:hover:bg-slate-700'
                }">
                    <i class="fa-solid ${t.icon} text-[10px]"></i>
                    <span class="truncate">${t.label}</span>
                </button>
            `;
        }).join('');

        // 禁言狀態條與輸入框控管
        const uid = getCurrentUidSafe();
        const isTeacher = isTeacherOfGroup(activeGroupData, uid);
        const muted = isMutedInGroup(activeGroupData, uid);
        const muteAll = Boolean(activeGroupData.classroomSettings?.muteAll);
        const chatInputEl = document.getElementById('chatInput');
        const chatSubmitBtn = msgForm ? msgForm.querySelector('button[type="submit"]') : null;

        if (activeSubTab === 'chat') {
            workspace.classList.add('hidden');
            msgBox.classList.remove('hidden');
            if (msgForm) msgForm.classList.remove('hidden');

            if (muted) {
                muteBanner.classList.remove('hidden');
                muteBanner.innerHTML = `
                    <span><i class="fa-solid fa-microphone-slash mr-1 text-rose-500"></i>${muteAll ? '老師已開啟「全班禁言」，目前僅限觀看訊息與答題' : '您目前被老師禁言中，暫無法傳送聊天訊息'}</span>
                `;
                if (chatInputEl) {
                    chatInputEl.disabled = true;
                    chatInputEl.placeholder = '目前為禁言狀態，無法發言...';
                }
                if (chatSubmitBtn) chatSubmitBtn.disabled = true;
            } else if (isTeacher) {
                muteBanner.classList.remove('hidden');
                muteBanner.innerHTML = `
                    <span class="flex items-center gap-1.5">
                        <span class="px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px]">🎓 教師控場</span>
                        <span>${muteAll ? '全班已禁言' : '討論開放中'} (${memberCount}/${MAX_CLASSROOM_MEMBERS} 人)</span>
                    </span>
                    <button type="button" onclick="ClassroomEngine.toggleMuteAll()" class="px-2.5 py-1 rounded-lg text-[10px] font-extrabold transition cursor-pointer ${
                        muteAll ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                    }">${muteAll ? '解除全班禁言' : '一鍵全班禁言'}</button>
                `;
                if (chatInputEl) {
                    chatInputEl.disabled = false;
                    chatInputEl.placeholder = '輸入班級訊息...';
                }
                if (chatSubmitBtn) chatSubmitBtn.disabled = false;
            } else {
                muteBanner.classList.add('hidden');
                if (chatInputEl) {
                    chatInputEl.disabled = false;
                    chatInputEl.placeholder = '輸入訊息...';
                }
                if (chatSubmitBtn) chatSubmitBtn.disabled = false;
            }
            return;
        }

        // 其他分頁隱藏聊天對話窗，顯示 Classroom 工作區
        muteBanner.classList.add('hidden');
        msgBox.classList.add('hidden');
        if (msgForm) msgForm.classList.add('hidden');
        workspace.classList.remove('hidden');

        if (activeSubTab === 'challenges') {
            renderChallengesTab(workspace, isTeacher);
        } else if (activeSubTab === 'tasks') {
            renderTasksTab(workspace, isTeacher);
        } else if (activeSubTab === 'progress') {
            renderProgressTab(workspace, isTeacher);
        }
    }

    // =========================================================================
    // 3. 教師禁言與權限設定操作
    // =========================================================================
    async function toggleMuteAll() {
        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup()) return;
        const nextVal = !(activeGroupData.classroomSettings?.muteAll === true);
        await rtdb.ref(`chats/${activeGroupId}/classroomSettings/muteAll`).set(nextVal);
        if (typeof showToast === 'function') {
            showToast(nextVal ? '🔇 已開啟全班禁言' : '🔊 已解除全班禁言', 'info');
        }
    }

    async function toggleStudentMute(targetUid) {
        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup() || !targetUid) return;
        const curr = activeGroupData.classroomSettings?.mutedUids?.[targetUid] === true;
        await rtdb.ref(`chats/${activeGroupId}/classroomSettings/mutedUids/${targetUid}`).set(!curr ? true : null);
        if (typeof showToast === 'function') {
            showToast(!curr ? `🔇 已禁言 ${getMemberLabel(targetUid)}` : `🔊 已解除 ${getMemberLabel(targetUid)} 禁言`, 'info');
        }
    }

    async function setProgressVisibility(mode) {
        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup()) return;
        const val = mode === 'teacher_only' ? 'teacher_only' : 'all';
        await rtdb.ref(`chats/${activeGroupId}/classroomSettings/progressVisibility`).set(val);
        if (typeof showToast === 'function') {
            showToast(val === 'teacher_only' ? '🔒 已設定為：進度僅限老師查看' : '👀 已設定為：班級成員可互相查看進度', 'info');
        }
    }

    // =========================================================================
    // 4. 挑戰排名演算法 (正確率優先，其次總作答時間越快優先)
    // =========================================================================
    function computeChallengeLeaderboard(challenge) {
        if (!challenge) return [];
        const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
        const totalQ = Math.max(1, questions.length);
        const responses = challenge.responses && typeof challenge.responses === 'object' ? challenge.responses : {};
        const participants = challenge.participants && typeof challenge.participants === 'object' ? challenge.participants : {};

        const uids = new Set([...Object.keys(responses), ...Object.keys(participants)]);
        const rows = [];

        uids.forEach(uid => {
            const resp = responses[uid];
            if (!resp || !resp.answers) return;
            const part = participants[uid] || {};
            let correctCount = 0;
            let answeredCount = 0;
            let computedMs = 0;

            questions.forEach((q, idx) => {
                const ans = resp.answers[idx];
                if (ans === undefined || ans === null || String(ans).trim() === '') return;
                answeredCount += 1;
                const expected = String(q.answer || '').trim().toLowerCase();
                if (String(ans).trim().toLowerCase() === expected) {
                    correctCount += 1;
                }
                if (resp.perQuestionMs && Number.isFinite(Number(resp.perQuestionMs[idx]))) {
                    computedMs += Number(resp.perQuestionMs[idx]);
                }
            });

            const totalTimeMs = Number.isFinite(Number(resp.totalTimeMs)) && Number(resp.totalTimeMs) > 0
                ? Number(resp.totalTimeMs)
                : computedMs;
            const accuracyPct = Math.round((correctCount / totalQ) * 100);

            rows.push({
                uid,
                nickname: resp.nickname || part.nickname || getMemberLabel(uid),
                correctCount,
                answeredCount,
                totalQ,
                accuracyPct,
                totalTimeMs,
                submittedAt: Number(resp.submittedAt || 0)
            });
        });

        rows.sort((a, b) => {
            if (b.accuracyPct !== a.accuracyPct) return b.accuracyPct - a.accuracyPct;
            if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
            if (a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs - b.totalTimeMs;
            return a.submittedAt - b.submittedAt;
        });

        return rows;
    }

    // =========================================================================
    // 5. 挑戰建立 / AI 出題 / 即時作答控場 UI
    // =========================================================================
    function buildVocabChallengeQuestions(count, format, optionCount) {
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        const activeCats = Array.isArray(global.selectedCategories) ? global.selectedCategories : ['ALL'];
        const defaultCat = (typeof t === 'function' && t('defaultCategoryName') !== 'defaultCategoryName') ? t('defaultCategoryName') : '預設字庫';

        let pool = list.filter(w => {
            if (!w || !w.word || !w.meaning) return false;
            if (activeCats.includes('ALL')) return true;
            return activeCats.includes(w.category || defaultCat);
        });
        if (pool.length === 0) pool = list.filter(w => w && w.word && w.meaning);
        if (pool.length === 0) return [];

        const shuffled = pool.slice().sort(() => Math.random() - 0.5).slice(0, count);
        return shuffled.map((card, idx) => {
            const qType = format === 'mixed' ? (idx % 2 === 0 ? 'choice' : 'spelling') : format;
            const distractorCards = pool
                .filter(c => String(c.word).toLowerCase() !== String(card.word).toLowerCase())
                .sort(() => Math.random() - 0.5)
                .slice(0, Math.max(1, optionCount - 1));

            if (qType === 'choice' && distractorCards.length >= 1) {
                const options = [card.meaning, ...distractorCards.map(d => d.meaning)].sort(() => Math.random() - 0.5);
                return {
                    id: `q_${idx}`,
                    type: 'choice',
                    prompt: `請選出「${card.word}」${card.pos ? `(${card.pos})` : ''} 的正確釋義：`,
                    sentence: card.sentence || '',
                    options,
                    answer: card.meaning
                };
            }
            const headTail = typeof global.buildHeadTailMaskHint === 'function'
                ? global.buildHeadTailMaskHint(card.word, true)
                : '';
            return {
                id: `q_${idx}`,
                type: 'spelling',
                prompt: `請拼出符合「${card.meaning}」${card.pos ? `(${card.pos})` : ''} 的單字：`,
                hint: headTail ? `提示：${headTail}` : '',
                sentence: card.sentence || '',
                answer: String(card.word).trim()
            };
        });
    }

    async function generateAiExamChallengeQuestions(topic, count, format, optionCount) {
        if (!hasAiSponsorEligibility()) {
            if (typeof global.MembershipEngine?.showQuotaUpgradePrompt === 'function') {
                global.MembershipEngine.showQuotaUpgradePrompt('article_gen');
            }
            throw new Error('考試級 AI 出題需要「教師班級方案」或有效個人會員資格');
        }
        if (typeof callGeminiApi !== 'function') {
            throw new Error('AI 服務尚未載入');
        }

        const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
        const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
        const formatRule = format === 'spelling'
            ? 'All questions MUST have type:"spelling" with a sentence containing ___ blank and exact target word as answer.'
            : format === 'choice'
                ? `All questions MUST have type:"choice" with an "options" array of exactly ${optionCount} distinct options and exact winning option string as "answer".`
                : `Mix "choice" (${optionCount} options) and "spelling" questions.`;

        const prompt = `You are a master exam designer for language teachers.
Create ${count} high-quality exam-level questions (target language: ${targetLang}, student native language: ${nativeLang}) on topic: "${topic || '學測/多益/JLPT 高頻綜合考題'}".
${formatRule}
Return STRICT JSON array only (no markdown fences):
[{"type":"choice"|"spelling","prompt":"question stem in target or native language","hint":"optional brief clue","options":["opt1","opt2"],"answer":"exact answer string"}]`;

        const res = await callGeminiApi(prompt, { feature: 'article_gen', classGroupId: activeGroupId });
        const rawText = res?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = rawText.replace(/```json|```/gi, '').trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(match ? match[0] : cleaned);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('AI 回傳題目格式空白');
        }
        return parsed.slice(0, count).map((q, idx) => ({
            id: `ai_${idx}`,
            type: q.type === 'spelling' ? 'spelling' : 'choice',
            prompt: String(q.prompt || '').trim(),
            hint: String(q.hint || '').trim(),
            options: Array.isArray(q.options) ? q.options.slice(0, optionCount).map(String) : [],
            answer: String(q.answer || '').trim()
        })).filter(q => q.prompt && q.answer);
    }

    function addCustomDraftQuestion() {
        const promptEl = document.getElementById('clsCustomQPrompt');
        const ansEl = document.getElementById('clsCustomQAnswer');
        const optsEl = document.getElementById('clsCustomQOptions');
        const prompt = (promptEl?.value || '').trim();
        const answer = (ansEl?.value || '').trim();
        const rawOpts = (optsEl?.value || '').split(/[,\n|]/).map(s => s.trim()).filter(Boolean);

        if (!prompt || !answer) {
            if (typeof showToast === 'function') showToast('請填寫題目內容與正確答案！', 'warning');
            return;
        }
        const isChoice = rawOpts.length >= 2;
        const options = isChoice
            ? (rawOpts.includes(answer) ? rawOpts : [answer, ...rawOpts]).slice(0, 6)
            : [];

        customDraftQuestions.push({
            id: `c_${Date.now()}_${customDraftQuestions.length}`,
            type: isChoice ? 'choice' : 'spelling',
            prompt,
            options,
            answer
        });
        if (promptEl) promptEl.value = '';
        if (ansEl) ansEl.value = '';
        if (optsEl) optsEl.value = '';
        renderClassroomShell();
    }

    async function launchChallengeFromForm() {
        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup()) return;

        const title = (document.getElementById('clsChallengeTitle')?.value || '').trim() || `課堂小考 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
        const sourceType = document.getElementById('clsChallengeSource')?.value || 'vocab';
        const format = document.getElementById('clsChallengeFormat')?.value || 'choice';
        const pacing = document.getElementById('clsChallengePacing')?.value || 'teacher_sync';
        const count = Math.min(30, Math.max(1, parseInt(document.getElementById('clsChallengeCount')?.value || '5', 10)));
        const optionCount = Math.min(6, Math.max(2, parseInt(document.getElementById('clsChallengeOptCount')?.value || '4', 10)));
        const timeLimitSec = Math.min(3600, Math.max(30, parseInt(document.getElementById('clsChallengeTimeSec')?.value || '180', 10)));
        const aiTopic = (document.getElementById('clsChallengeAiTopic')?.value || '').trim();

        let questions = [];
        const btn = document.getElementById('clsLaunchChallengeBtn');
        if (btn) btn.disabled = true;

        try {
            if (sourceType === 'custom') {
                if (customDraftQuestions.length === 0) {
                    if (typeof showToast === 'function') showToast('請先加入至少 1 題自訂題目！', 'warning');
                    return;
                }
                questions = customDraftQuestions.slice(0, count);
            } else if (sourceType === 'exam_ai') {
                if (typeof showToast === 'function') showToast('✨ AI 正在編製考試級挑戰題目...', 'info');
                questions = await generateAiExamChallengeQuestions(aiTopic, count, format, optionCount);
            } else {
                questions = buildVocabChallengeQuestions(count, format, optionCount);
                if (questions.length === 0) {
                    if (typeof showToast === 'function') showToast('目前勾選的字庫沒有可用單字，請先匯入或勾選字庫！', 'warning');
                    return;
                }
            }

            const newRef = rtdb.ref(`chats/${activeGroupId}/challenges`).push();
            const now = Date.now();
            await newRef.set({
                title,
                sourceType,
                format,
                pacing,
                optionCount,
                timeLimitSec: pacing === 'timed_free' ? timeLimitSec : 0,
                status: 'active',
                currentQuestionIndex: 0,
                questions,
                createdByUid: uid,
                createdAt: now,
                startedAt: now
            });

            selectedChallengeId = newRef.key;
            customDraftQuestions = [];
            if (typeof showToast === 'function') showToast(`🚀 挑戰「${title}」已發佈至班級！`, 'success');
            renderClassroomShell();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message || '發起挑戰失敗', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function teacherSetQuestionIndex(challengeId, nextIdx) {
        const rtdb = getRtdbSafe();
        const c = challengesMap[challengeId];
        if (!rtdb || !activeGroupId || !c || !isTeacherOfGroup()) return;
        const maxIdx = Math.max(0, (Array.isArray(c.questions) ? c.questions.length : 1) - 1);
        const clamped = Math.min(maxIdx, Math.max(0, nextIdx));
        await rtdb.ref(`chats/${activeGroupId}/challenges/${challengeId}/currentQuestionIndex`).set(clamped);
    }

    async function teacherEndChallengeNow(challengeId) {
        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup()) return;
        await rtdb.ref(`chats/${activeGroupId}/challenges/${challengeId}`).update({
            status: 'ended',
            endedAt: Date.now()
        });
        if (typeof showToast === 'function') showToast('🏁 已立刻結束挑戰並鎖定最終排行榜！', 'info');
    }

    function stopLiveRunnerTimer() {
        if (liveRunState.timerHandle) {
            clearInterval(liveRunState.timerHandle);
            liveRunState.timerHandle = null;
        }
    }

    function enterStudentChallenge(challengeId) {
        const c = challengesMap[challengeId];
        if (!c) return;
        selectedChallengeId = challengeId;
        const now = Date.now();
        if (liveRunState.challengeId !== challengeId) {
            stopLiveRunnerTimer();
            liveRunState = {
                challengeId,
                qIdx: c.pacing === 'teacher_sync' ? (Number(c.currentQuestionIndex) || 0) : 0,
                startedAtMs: now,
                questionStartMs: now,
                answers: {},
                perQuestionMs: {},
                submitted: false,
                timerHandle: null,
                remainingSec: Number(c.timeLimitSec || 180)
            };

            const rtdb = getRtdbSafe();
            const uid = getCurrentUidSafe();
            if (rtdb && activeGroupId && uid) {
                rtdb.ref(`chats/${activeGroupId}/challenges/${challengeId}/participants/${uid}`).set({
                    nickname: getCurrentDisplayNameSafe(),
                    joinedAt: now
                }).catch(() => {});
            }

            if (c.pacing === 'timed_free' && c.status === 'active') {
                liveRunState.timerHandle = setInterval(() => {
                    liveRunState.remainingSec = Math.max(0, liveRunState.remainingSec - 1);
                    const timerEl = document.getElementById('clsLiveTimerText');
                    if (timerEl) timerEl.textContent = `${liveRunState.remainingSec}s`;
                    if (liveRunState.remainingSec <= 0 && !liveRunState.submitted) {
                        submitStudentChallengeResponses(challengeId);
                    }
                }, 1000);
            }
        }
        renderClassroomShell();
    }

    async function recordChallengeAnswer(challengeId, qIdx, answerVal, advanceIfTimed = false) {
        const c = challengesMap[challengeId];
        if (!c || c.status !== 'active') return;
        const now = Date.now();
        const elapsed = Math.max(100, now - (liveRunState.questionStartMs || liveRunState.startedAtMs || now));
        liveRunState.answers[qIdx] = String(answerVal || '').trim();
        liveRunState.perQuestionMs[qIdx] = (liveRunState.perQuestionMs[qIdx] || 0) + elapsed;
        liveRunState.questionStartMs = now;

        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (rtdb && activeGroupId && uid) {
            const totalTimeMs = Object.values(liveRunState.perQuestionMs).reduce((s, v) => s + Number(v || 0), 0);
            await rtdb.ref(`chats/${activeGroupId}/challenges/${challengeId}/responses/${uid}`).set({
                nickname: getCurrentDisplayNameSafe(),
                answers: liveRunState.answers,
                perQuestionMs: liveRunState.perQuestionMs,
                totalTimeMs,
                submittedAt: now
            }).catch(() => {});
        }

        if (advanceIfTimed && c.pacing === 'timed_free') {
            const maxIdx = Math.max(0, (c.questions?.length || 1) - 1);
            if (qIdx < maxIdx) {
                liveRunState.qIdx = qIdx + 1;
            } else {
                await submitStudentChallengeResponses(challengeId);
                return;
            }
        }
        renderClassroomShell();
    }

    async function submitStudentChallengeResponses(challengeId) {
        stopLiveRunnerTimer();
        const c = challengesMap[challengeId];
        if (!c) return;
        const now = Date.now();
        liveRunState.submitted = true;
        const totalTimeMs = Math.max(
            now - (liveRunState.startedAtMs || now),
            Object.values(liveRunState.perQuestionMs).reduce((s, v) => s + Number(v || 0), 0)
        );
        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (rtdb && activeGroupId && uid) {
            await rtdb.ref(`chats/${activeGroupId}/challenges/${challengeId}/responses/${uid}`).set({
                nickname: getCurrentDisplayNameSafe(),
                answers: liveRunState.answers,
                perQuestionMs: liveRunState.perQuestionMs,
                totalTimeMs,
                submittedAt: now
            }).catch(() => {});
        }
        recordStudyActivity({ type: 'challenge', count: 1 });
        if (typeof showToast === 'function') showToast('✅ 挑戰作答已送出並計入班級排行！', 'success');
        renderClassroomShell();
    }

    function renderChallengesTab(container, isTeacher) {
        const list = Object.entries(challengesMap)
            .map(([id, val]) => ({ id, ...val }))
            .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

        const activeChallenge = selectedChallengeId && challengesMap[selectedChallengeId]
            ? { id: selectedChallengeId, ...challengesMap[selectedChallengeId] }
            : (list.find(c => c.status === 'active') || list[0] || null);

        let html = '';

        // 1. 老師出題建置器
        if (isTeacher) {
            const canUseAi = hasAiSponsorEligibility();
            html += `
                <details class="rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3.5 shadow-2xs" ${list.length === 0 ? 'open' : ''}>
                    <summary class="cursor-pointer font-extrabold text-xs text-indigo-700 dark:text-indigo-300 flex items-center justify-between select-none">
                        <span><i class="fa-solid fa-plus-circle mr-1.5"></i>老師發起新班級挑戰</span>
                        <span class="text-[10px] font-bold text-slate-400">點開設定</span>
                    </summary>
                    <div class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 space-y-2.5 text-xs">
                        <input type="text" id="clsChallengeTitle" placeholder="挑戰標題（例：第3單元隨堂測驗）" class="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-semibold outline-none">
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-1">題目來源</label>
                                <select id="clsChallengeSource" onchange="document.getElementById('clsCustomBuilderBox')?.classList.toggle('hidden', this.value!=='custom'); document.getElementById('clsAiTopicBox')?.classList.toggle('hidden', this.value!=='exam_ai');" class="w-full min-h-[38px] px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                                    <option value="vocab">勾選單字庫自動出題</option>
                                    <option value="custom">老師手動自訂題目</option>
                                    <option value="exam_ai">✨ AI 考試級出題 (消耗長文額度)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-1">控場節奏</label>
                                <select id="clsChallengePacing" onchange="document.getElementById('clsTimeSecWrap')?.classList.toggle('hidden', this.value!=='timed_free');" class="w-full min-h-[38px] px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                                    <option value="teacher_sync">👨‍🏫 老師同步控場跳題</option>
                                    <option value="timed_free">⏱️ 限時自由作答</option>
                                </select>
                            </div>
                        </div>
                        <div class="grid grid-cols-3 gap-2">
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-1">題型</label>
                                <select id="clsChallengeFormat" class="w-full min-h-[38px] px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                                    <option value="choice">單選題</option>
                                    <option value="spelling">拼字題</option>
                                    <option value="mixed">混合題型</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-1">總題數</label>
                                <input type="number" id="clsChallengeCount" value="5" min="1" max="30" class="w-full min-h-[38px] px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-1">選項數</label>
                                <select id="clsChallengeOptCount" class="w-full min-h-[38px] px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                                    <option value="2">2 選項</option>
                                    <option value="3">3 選項</option>
                                    <option value="4" selected>4 選項</option>
                                    <option value="5">5 選項</option>
                                    <option value="6">6 選項</option>
                                </select>
                            </div>
                        </div>
                        <div id="clsTimeSecWrap" class="hidden">
                            <label class="block text-[10px] font-bold text-slate-500 mb-1">限時作答秒數</label>
                            <input type="number" id="clsChallengeTimeSec" value="180" min="30" max="3600" class="w-full min-h-[38px] px-3 py-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                        </div>
                        <div id="clsAiTopicBox" class="hidden space-y-1.5 p-2.5 rounded-xl bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800">
                            <div class="flex items-center justify-between text-[11px] font-extrabold text-purple-800 dark:text-purple-200">
                                <span>✨ AI 考試級出題 (消耗長文額度 article_gen)</span>
                                <span class="px-1.5 py-0.5 rounded ${canUseAi ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'} text-[9px]">${canUseAi ? '會員已授權' : '需教師/個人會員'}</span>
                            </div>
                            <input type="text" id="clsChallengeAiTopic" placeholder="輸入考點或主題（例：假設語氣、日文敬語）" class="w-full min-h-[38px] px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-700 bg-white dark:bg-slate-900 text-xs outline-none">
                        </div>
                        <div id="clsCustomBuilderBox" class="hidden space-y-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                            <div class="text-[11px] font-bold text-slate-700 dark:text-slate-200">自訂題目清單 (目前 ${customDraftQuestions.length} 題)</div>
                            <input type="text" id="clsCustomQPrompt" placeholder="輸入題幹..." class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs">
                            <div class="grid grid-cols-2 gap-1.5">
                                <input type="text" id="clsCustomQAnswer" placeholder="正確答案" class="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs">
                                <input type="text" id="clsCustomQOptions" placeholder="選項(逗號隔開，留空=拼字)" class="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs">
                            </div>
                            <button type="button" onclick="ClassroomEngine.addCustomDraftQuestion()" class="w-full py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer">+ 加入此題至草稿</button>
                        </div>
                        <button type="button" id="clsLaunchChallengeBtn" onclick="ClassroomEngine.launchChallengeFromForm()" class="w-full min-h-[44px] py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold shadow-xs cursor-pointer">
                            🚀 立即發布班級挑戰
                        </button>
                    </div>
                </details>
            `;
        }

        // 2. 挑戰場次選擇列
        if (list.length > 0) {
            html += `<div class="flex items-center gap-1.5 overflow-x-auto pb-1">`;
            list.slice(0, 8).forEach(c => {
                const isSel = activeChallenge && activeChallenge.id === c.id;
                html += `
                    <button type="button" onclick="ClassroomEngine.enterStudentChallenge('${escapeClassHtml(c.id)}')" class="px-3 py-1.5 rounded-xl text-[11px] font-bold shrink-0 border transition cursor-pointer ${
                        isSel
                            ? 'bg-brand-600 text-white border-brand-600'
                            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }">
                        ${c.status === 'active' ? '🟢 ' : '🏁 '}${escapeClassHtml(c.title || '挑戰')}
                    </button>
                `;
            });
            html += `</div>`;
        } else if (!isTeacher) {
            html += `<div class="text-center py-8 text-xs text-slate-400">老師尚未發起班級挑戰，敬請期待！</div>`;
        }

        // 3. 進行中 / 已選取挑戰視圖
        if (activeChallenge) {
            const questions = Array.isArray(activeChallenge.questions) ? activeChallenge.questions : [];
            const isSync = activeChallenge.pacing === 'teacher_sync';
            const qIdx = isSync ? Math.min(Math.max(0, Number(activeChallenge.currentQuestionIndex) || 0), Math.max(0, questions.length - 1)) : Math.min(liveRunState.qIdx || 0, Math.max(0, questions.length - 1));
            const currQ = questions[qIdx] || null;
            const lbRows = computeChallengeLeaderboard(activeChallenge);

            if (isSync) {
                liveRunState.challengeId = activeChallenge.id;
                liveRunState.qIdx = qIdx;
            }

            html += `
                <div class="rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 space-y-3 shadow-xs">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                            <div class="text-sm font-black text-slate-900 dark:text-white">${escapeClassHtml(activeChallenge.title || '班級挑戰')}</div>
                            <div class="text-[11px] text-slate-400">${isSync ? '👨‍🏫 老師同步跳題' : '⏱️ 限時自由作答'} · 第 ${qIdx + 1}/${questions.length} 題</div>
                        </div>
                        <span id="clsLiveTimerText" class="px-2.5 py-1 rounded-lg text-xs font-black tabular-nums ${activeChallenge.status === 'active' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-slate-100 text-slate-500'}">
                            ${activeChallenge.status === 'active' ? (isSync ? '進行中' : `${liveRunState.remainingSec || activeChallenge.timeLimitSec || 180}s`) : '已結束'}
                        </span>
                    </div>
            `;

            if (isTeacher && activeChallenge.status === 'active') {
                html += `
                    <div class="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between gap-1.5 flex-wrap">
                        <div class="flex items-center gap-1.5">
                            <button type="button" onclick="ClassroomEngine.teacherSetQuestionIndex('${escapeClassHtml(activeChallenge.id)}', ${qIdx - 1})" class="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-700 text-[11px] font-bold cursor-pointer">◀ 上一題</button>
                            <button type="button" onclick="ClassroomEngine.teacherSetQuestionIndex('${escapeClassHtml(activeChallenge.id)}', ${qIdx + 1})" class="px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white text-[11px] font-bold cursor-pointer">跳下一題 ▶</button>
                        </div>
                        <button type="button" onclick="ClassroomEngine.teacherEndChallengeNow('${escapeClassHtml(activeChallenge.id)}')" class="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-extrabold cursor-pointer">⏹ 立刻結束挑戰</button>
                    </div>
                `;
            }

            if (activeChallenge.status === 'active' && currQ) {
                const alreadyJoined = liveRunState.challengeId === activeChallenge.id;
                if (!alreadyJoined) {
                    html += `
                        <button type="button" onclick="ClassroomEngine.enterStudentChallenge('${escapeClassHtml(activeChallenge.id)}')" class="w-full min-h-[44px] py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
                            🎯 加入並開始作答
                        </button>
                    `;
                } else if (liveRunState.submitted && !isSync) {
                    html += `<div class="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs font-bold text-center">✅ 您已完成作答，請看下方即時排行榜！</div>`;
                } else {
                    const myAns = liveRunState.answers[qIdx] || '';
                    html += `
                        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                            <div class="text-xs font-extrabold text-slate-900 dark:text-white leading-relaxed">${escapeClassHtml(currQ.prompt)}</div>
                            ${currQ.hint ? `<div class="text-[11px] text-slate-500 font-mono">${escapeClassHtml(currQ.hint)}</div>` : ''}
                            ${currQ.type === 'choice' && Array.isArray(currQ.options) && currQ.options.length > 0 ? `
                                <div class="space-y-1.5">
                                    ${currQ.options.map((opt, optIdx) => {
                                        const chosen = myAns === opt;
                                        return `
                                            <button type="button" onclick="ClassroomEngine.recordChallengeAnswer('${escapeClassHtml(activeChallenge.id)}', ${qIdx}, decodeURIComponent('${encodeURIComponent(opt)}'), true)" class="w-full min-h-[42px] px-3 py-2 rounded-xl text-left text-xs font-bold border transition cursor-pointer ${
                                                chosen
                                                    ? 'bg-brand-600 text-white border-brand-600'
                                                    : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border-slate-200 dark:border-slate-700 hover:border-brand-400'
                                            }">
                                                <span class="font-mono mr-1.5">${String.fromCharCode(65 + optIdx)}.</span>${escapeClassHtml(opt)}
                                            </button>
                                        `;
                                    }).join('')}
                                </div>
                            ` : `
                                <div class="flex gap-1.5">
                                    <input type="text" id="clsLiveSpellInput" value="${escapeClassHtml(myAns)}" placeholder="輸入拼寫答案..." class="flex-1 min-h-[42px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs font-bold outline-none">
                                    <button type="button" onclick="ClassroomEngine.recordChallengeAnswer('${escapeClassHtml(activeChallenge.id)}', ${qIdx}, document.getElementById('clsLiveSpellInput')?.value || '', true)" class="min-h-[42px] px-4 py-1.5 rounded-xl bg-brand-600 text-white text-xs font-extrabold cursor-pointer">送出</button>
                                </div>
                            `}
                        </div>
                    `;
                }
            }

            // 排行榜（正確率高優先 -> 總作答速度越快優先）
            html += `
                <div class="pt-2 border-t border-slate-100 dark:border-slate-700 space-y-2">
                    <div class="flex items-center justify-between text-xs font-extrabold text-slate-700 dark:text-slate-200">
                        <span>🏆 即時班級排名</span>
                        <span class="text-[10px] font-semibold text-slate-400">優先正確率 · 其次答題速度</span>
                    </div>
                    ${lbRows.length === 0 ? `<p class="text-[11px] text-slate-400 py-2">尚無學生提交答案</p>` : `
                        <div class="divide-y divide-slate-100 dark:divide-slate-700 text-xs">
                            ${lbRows.map((row, rIdx) => `
                                <div class="py-2 flex items-center justify-between gap-2 tabular-nums">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <span class="w-5 text-center font-black ${rIdx === 0 ? 'text-amber-500' : rIdx === 1 ? 'text-slate-400' : rIdx === 2 ? 'text-amber-700' : 'text-slate-400'}">#${rIdx + 1}</span>
                                        <span class="font-bold text-slate-800 dark:text-slate-100 truncate">${escapeClassHtml(row.nickname)}</span>
                                    </div>
                                    <div class="flex items-center gap-2.5 shrink-0">
                                        <span class="px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 font-extrabold">${row.accuracyPct}% (${row.correctCount}/${row.totalQ})</span>
                                        <span class="text-[11px] font-bold text-slate-500">${(row.totalTimeMs / 1000).toFixed(1)}s</span>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `}
                </div>
            </div>
            `;
        }

        container.innerHTML = html;
    }

    // =========================================================================
    // 6. 每日任務派發與完成度計算
    // =========================================================================
    function getScopedActivityStorageKey(uid = getCurrentUidSafe()) {
        return `lzhcard_cls_daily_activity_${uid || 'guest'}_${getTodayDateKey()}`;
    }

    function readTodayActivityCounts(uid = getCurrentUidSafe()) {
        try {
            const raw = localStorage.getItem(getScopedActivityStorageKey(uid));
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    return {
                        flashcards: Number(parsed.flashcards || 0),
                        quiz_questions: Number(parsed.quiz_questions || 0),
                        quiz_correct: Number(parsed.quiz_correct || 0),
                        challenge: Number(parsed.challenge || 0)
                    };
                }
            }
        } catch (e) {}
        return { flashcards: 0, quiz_questions: 0, quiz_correct: 0, challenge: 0 };
    }

    function recordStudyActivity({ type = 'flashcards', count = 1, isCorrect = null } = {}) {
        const uid = getCurrentUidSafe();
        const curr = readTodayActivityCounts(uid);
        const inc = Math.max(1, Number(count) || 1);
        if (type === 'flashcards') curr.flashcards += inc;
        else if (type === 'quiz_questions') {
            curr.quiz_questions += inc;
            if (isCorrect === true) curr.quiz_correct += 1;
        } else if (type === 'challenge') curr.challenge += inc;

        try {
            localStorage.setItem(getScopedActivityStorageKey(uid), JSON.stringify(curr));
        } catch (e) {}

        if (uid) {
            if (snapshotSyncTimer) clearTimeout(snapshotSyncTimer);
            snapshotSyncTimer = setTimeout(() => {
                snapshotSyncTimer = null;
                syncStudentSnapshotToJoinedClasses();
            }, 800);
        }
    }

    function buildMySnapshotPayload(tasksForGroup = tasksMap) {
        const uid = getCurrentUidSafe();
        const acts = readTodayActivityCounts(uid);
        const list = (typeof wordList !== 'undefined' && Array.isArray(wordList)) ? wordList : [];
        const masteredWords = list.filter(w => (w.level || 1) >= 4).length;
        const todayAccuracy = acts.quiz_questions > 0
            ? Math.round((acts.quiz_correct / acts.quiz_questions) * 100)
            : 100;

        const completedTasks = {};
        const todayKey = getTodayDateKey();
        Object.entries(tasksForGroup || {}).forEach(([tid, task]) => {
            if (!task) return;
            const tType = task.type || 'flashcards';
            const target = Math.max(1, Number(task.targetCount || 1));
            const val = acts[tType] || 0;
            completedTasks[tid] = {
                progress: val,
                target,
                done: val >= target,
                date: todayKey
            };
        });

        return {
            uid,
            nickname: getCurrentDisplayNameSafe(),
            stats: {
                todayFlashcards: acts.flashcards,
                todayQuizQuestions: acts.quiz_questions,
                todayChallenges: acts.challenge,
                todayAccuracy,
                totalWords: list.length,
                masteredWords,
                completedTasks
            },
            updatedAt: Date.now()
        };
    }

    async function syncMyStudentSnapshotForGroup(chatId) {
        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (!rtdb || !uid || !chatId) return;
        const payload = buildMySnapshotPayload(tasksMap);
        await rtdb.ref(`chats/${chatId}/studentSnapshots/${uid}`).set(payload).catch(() => {});
    }

    async function syncStudentSnapshotToJoinedClasses() {
        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (!rtdb || !uid) return;
        const targets = new Set();
        if (activeGroupId && activeGroupData?.teacherMode === true) targets.add(activeGroupId);
        try {
            if (typeof userChatThreads !== 'undefined' && Array.isArray(userChatThreads)) {
                userChatThreads.forEach(th => {
                    if (th && th.teacherMode === true && th.members?.[uid] === true) {
                        targets.add(th.id);
                    }
                });
            }
        } catch (e) {}

        for (const gid of targets) {
            try {
                const snap = await rtdb.ref(`chats/${gid}/dailyTasks`).once('value');
                const tMap = snap.val() || {};
                const payload = buildMySnapshotPayload(tMap);
                await rtdb.ref(`chats/${gid}/studentSnapshots/${uid}`).set(payload);
            } catch (e) {}
        }
    }

    async function createDailyTaskFromForm() {
        const rtdb = getRtdbSafe();
        const uid = getCurrentUidSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup()) return;

        const title = (document.getElementById('clsTaskTitle')?.value || '').trim();
        const type = document.getElementById('clsTaskType')?.value || 'flashcards';
        const targetCount = Math.max(1, parseInt(document.getElementById('clsTaskCount')?.value || '20', 10));
        const recurringDaily = Boolean(document.getElementById('clsTaskRecurring')?.checked);

        const defaultTitles = {
            flashcards: `每日刷字卡 ${targetCount} 張`,
            quiz_questions: `完成考試測驗 ${targetCount} 題`,
            challenge: `參與班級挑戰 ${targetCount} 次`
        };

        const newRef = rtdb.ref(`chats/${activeGroupId}/dailyTasks`).push();
        await newRef.set({
            id: newRef.key,
            title: title || defaultTitles[type] || '班級學習任務',
            type,
            targetCount,
            recurringDaily,
            assignedAt: Date.now(),
            assignedByUid: uid
        });

        const titleEl = document.getElementById('clsTaskTitle');
        if (titleEl) titleEl.value = '';
        if (typeof showToast === 'function') showToast('📋 已派發班級學習任務！', 'success');
    }

    async function deleteDailyTask(taskId) {
        const rtdb = getRtdbSafe();
        if (!rtdb || !activeGroupId || !isTeacherOfGroup() || !taskId) return;
        await rtdb.ref(`chats/${activeGroupId}/dailyTasks/${taskId}`).remove();
    }

    function renderTasksTab(container, isTeacher) {
        const acts = readTodayActivityCounts();
        const taskList = Object.entries(tasksMap)
            .map(([id, t]) => ({ id, ...t }))
            .sort((a, b) => Number(b.assignedAt || 0) - Number(a.assignedAt || 0));

        let html = '';
        if (isTeacher) {
            html += `
                <div class="rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3.5 space-y-2.5 text-xs shadow-2xs">
                    <div class="font-extrabold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                        <i class="fa-solid fa-clipboard-check"></i>
                        <span>老師派發學習任務</span>
                    </div>
                    <input type="text" id="clsTaskTitle" placeholder="任務名稱（留空自動命名）" class="w-full min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-semibold outline-none">
                    <div class="grid grid-cols-2 gap-2">
                        <select id="clsTaskType" class="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                            <option value="flashcards">刷單字卡張數</option>
                            <option value="quiz_questions">完成測驗題數</option>
                            <option value="challenge">參與班級挑戰次數</option>
                        </select>
                        <input type="number" id="clsTaskCount" value="20" min="1" max="500" class="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-bold">
                    </div>
                    <label class="flex items-center gap-2 text-[11px] font-bold text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input type="checkbox" id="clsTaskRecurring" checked class="w-4 h-4 rounded text-indigo-600">
                        <span>每日循環任務（每天自動重置目標進度）</span>
                    </label>
                    <button type="button" onclick="ClassroomEngine.createDailyTaskFromForm()" class="w-full min-h-[42px] py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold cursor-pointer">
                        派發任務給全班
                    </button>
                </div>
            `;
        }

        if (taskList.length === 0) {
            html += `<div class="text-center py-8 text-xs text-slate-400">目前老師尚未指派每日任務</div>`;
        } else {
            html += `<div class="space-y-2">`;
            taskList.forEach(task => {
                const target = Math.max(1, Number(task.targetCount || 1));
                const current = acts[task.type] || 0;
                const pct = Math.min(100, Math.round((current / target) * 100));
                const done = current >= target;
                html += `
                    <div class="p-3 rounded-2xl bg-white dark:bg-slate-800 border ${done ? 'border-emerald-300 dark:border-emerald-800' : 'border-slate-200 dark:border-slate-700'} space-y-2">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0">
                                <div class="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">${done ? '✅ ' : '📌 '}${escapeClassHtml(task.title)}</div>
                                <div class="text-[10px] text-slate-400">${task.recurringDaily ? '每日循環' : '單次任務'} · 今日 ${current} / ${target}</div>
                            </div>
                            ${isTeacher ? `<button type="button" onclick="ClassroomEngine.deleteDailyTask('${escapeClassHtml(task.id)}')" class="px-2 py-1 rounded-lg text-[10px] font-bold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer">刪除</button>` : ''}
                        </div>
                        <div class="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div class="h-full ${done ? 'bg-emerald-500' : 'bg-indigo-500'} rounded-full transition-all" style="width:${pct}%"></div>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        container.innerHTML = html;
    }

    // =========================================================================
    // 7. 學生學習狀況與進度追蹤 (支援隱私權設定 all vs teacher_only)
    // =========================================================================
    function renderProgressTab(container, isTeacher) {
        const uid = getCurrentUidSafe();
        const visibility = activeGroupData?.classroomSettings?.progressVisibility === 'teacher_only' ? 'teacher_only' : 'all';
        const memberUids = getGroupMemberUids(activeGroupData);
        const taskEntries = Object.entries(tasksMap);

        let html = '';

        if (isTeacher) {
            html += `
                <div class="p-3.5 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2.5 text-xs shadow-2xs">
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-extrabold text-slate-800 dark:text-slate-100">班級成員進度瀏覽權限</span>
                        <span class="text-[10px] font-bold text-slate-400">${memberUids.length}/${MAX_CLASSROOM_MEMBERS} 人</span>
                    </div>
                    <div class="grid grid-cols-2 gap-1.5">
                        <button type="button" onclick="ClassroomEngine.setProgressVisibility('all')" class="min-h-[38px] px-2 py-1.5 rounded-xl text-[11px] font-bold border transition cursor-pointer ${
                            visibility === 'all' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }">👥 群組成員可互看</button>
                        <button type="button" onclick="ClassroomEngine.setProgressVisibility('teacher_only')" class="min-h-[38px] px-2 py-1.5 rounded-xl text-[11px] font-bold border transition cursor-pointer ${
                            visibility === 'teacher_only' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }">🔒 僅限老師查看</button>
                    </div>
                </div>
            `;
        } else if (visibility === 'teacher_only') {
            html += `
                <div class="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] font-bold text-amber-800 dark:text-amber-200">
                    🔒 老師已將本班設定為「僅限老師查看全班進度」，目前僅顯示您自己的學習狀況。
                </div>
            `;
        }

        const visibleUids = (isTeacher || visibility === 'all') ? memberUids : memberUids.filter(id => id === uid);

        html += `<div class="space-y-2">`;
        visibleUids.forEach(mUid => {
            const snap = snapshotsMap[mUid] || {};
            const st = snap.stats || {};
            const isOwner = mUid === activeGroupData?.ownerUid;
            const isIndivMuted = Boolean(activeGroupData?.classroomSettings?.mutedUids?.[mUid]);
            let tasksDone = 0;
            if (taskEntries.length > 0 && st.completedTasks) {
                taskEntries.forEach(([tid]) => {
                    if (st.completedTasks[tid] && st.completedTasks[tid].done) tasksDone += 1;
                });
            }

            html += `
                <div class="p-3 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5 min-w-0">
                            <span class="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">${escapeClassHtml(getMemberLabel(mUid))}</span>
                            ${isOwner ? `<span class="px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 text-[9px] font-extrabold">老師</span>` : ''}
                            ${isIndivMuted ? `<span class="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-300 text-[9px] font-extrabold">已禁言</span>` : ''}
                        </div>
                        ${isTeacher && !isOwner ? `
                            <button type="button" onclick="ClassroomEngine.toggleStudentMute('${escapeClassHtml(mUid)}')" class="px-2.5 py-1 rounded-lg text-[10px] font-bold border transition cursor-pointer ${
                                isIndivMuted
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
                                    : 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800'
                            }">${isIndivMuted ? '解除禁言' : '禁言此生'}</button>
                        ` : ''}
                    </div>
                    <div class="grid grid-cols-4 gap-1.5 text-center text-[10px] tabular-nums">
                        <div class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-900">
                            <div class="text-slate-400">今日字卡</div>
                            <div class="font-black text-slate-800 dark:text-white">${Number(st.todayFlashcards || 0)}</div>
                        </div>
                        <div class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-900">
                            <div class="text-slate-400">今日測驗</div>
                            <div class="font-black text-slate-800 dark:text-white">${Number(st.todayQuizQuestions || 0)}</div>
                        </div>
                        <div class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-900">
                            <div class="text-slate-400">掌握字數</div>
                            <div class="font-black text-emerald-600 dark:text-emerald-400">${Number(st.masteredWords || 0)}/${Number(st.totalWords || 0)}</div>
                        </div>
                        <div class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-900">
                            <div class="text-slate-400">任務達成</div>
                            <div class="font-black text-indigo-600 dark:text-indigo-400">${tasksDone}/${taskEntries.length}</div>
                        </div>
                    </div>
                </div>
            `;
        });
        html += `</div>`;

        container.innerHTML = html;
    }

    const ClassroomEngine = {
        MAX_CLASSROOM_MEMBERS,
        openCreateGroupModal,
        closeCreateGroupModal,
        submitCreateGroupModal,
        openGroupWorkspace,
        detachGroupListeners,
        switchSubTab,
        toggleMuteAll,
        toggleStudentMute,
        setProgressVisibility,
        addCustomDraftQuestion,
        launchChallengeFromForm,
        teacherSetQuestionIndex,
        teacherEndChallengeNow,
        enterStudentChallenge,
        recordChallengeAnswer,
        submitStudentChallengeResponses,
        createDailyTaskFromForm,
        deleteDailyTask,
        recordStudyActivity,
        syncStudentSnapshotToJoinedClasses,
        computeChallengeLeaderboard,
        isTeacherOfGroup,
        isMutedInGroup,
        getSponsorGroupId
    };

    global.ClassroomEngine = ClassroomEngine;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ClassroomEngine;
    }
})(typeof window !== 'undefined' ? window : globalThis);
