// 你的 Firebase 設定資訊 (已補上東南亞區域 RTDB 網址)
const firebaseConfig = {
  apiKey: "AIzaSyCbAux_DnwsgYJn3tGwLPImcaIAzGkdiHE",
  authDomain: "flashcards-5f514.firebaseapp.com",
  databaseURL: "https://flashcards-5f514-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "flashcards-5f514",
  storageBucket: "flashcards-5f514.firebasestorage.app",
  messagingSenderId: "471941628425",
  appId: "1:471941628425:web:0737bcaa210f2c4d9aaed8",
  measurementId: "G-8KNV18H30V"
};

// 初始化 Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();
let rtdb = null;
try {
  if (typeof firebase !== 'undefined' && typeof firebase.database === 'function') {
    rtdb = firebase.database();
  }
} catch (e) {
  console.warn("Realtime Database 初始化失敗：", e);
}

if (typeof window !== 'undefined') {
  window.auth = auth;
  window.db = db;
  window.rtdb = rtdb;
}

try {
  db.settings({
    experimentalForceLongPolling: true,
    useFetchStreams: false
  });
} catch (e) {
  console.warn("Firestore settings 已初始化過：", e);
}

/**
 * 📱 偵測是否執行於 Capacitor 原生行動應用環境 (Android / iOS WebView)
 */
function isNativeApp() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
      return Boolean(window.Capacitor.isNativePlatform());
    }
    if (window.Capacitor && window.Capacitor.isNative) {
      return true;
    }
    const protocol = window.location ? window.location.protocol : '';
    return protocol === 'capacitor:' || protocol === 'ionic:';
  } catch (e) {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.isNativeApp = isNativeApp;
}

// 1. Google 一鍵登入 (網頁版 Popup / Capacitor 原生外掛橋接，防 WebView disallowed_useragent 封鎖)
async function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    let result = null;

    if (isNativeApp()) {
      const capPlugins = window.Capacitor?.Plugins || {};
      if (capPlugins.FirebaseAuthentication && typeof capPlugins.FirebaseAuthentication.signInWithGoogle === 'function') {
        const nativeRes = await capPlugins.FirebaseAuthentication.signInWithGoogle();
        const idToken = nativeRes?.credential?.idToken || nativeRes?.idToken;
        if (!idToken) throw new Error('無法取得原生 Google ID Token');
        const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
        result = await auth.signInWithCredential(credential);
      } else if (capPlugins.GoogleAuth && typeof capPlugins.GoogleAuth.signIn === 'function') {
        const googleUser = await capPlugins.GoogleAuth.signIn();
        const idToken = googleUser?.authentication?.idToken || googleUser?.idToken;
        if (!idToken) throw new Error('無法取得 GoogleAuth ID Token');
        const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
        result = await auth.signInWithCredential(credential);
      } else {
        throw new Error('偵測到原生 App 環境，請確認已安裝 Capacitor Google / Firebase 原生登入外掛');
      }
    } else {
      result = await auth.signInWithPopup(provider);
    }

    localStorage.removeItem('lzhcard_guest_mode');
    console.log("Google 登入成功:", result.user);

    if (typeof loadStorage === 'function') {
      await loadStorage();
    }
    if (typeof showToast === 'function') {
      showToast(`歡迎回來，${result.user.displayName || '使用者'}！`, "success");
    }
    return result.user;
  } catch (error) {
    if (error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
      console.warn("登入視窗已關閉或重新觸發");
      return;
    }
    console.error("Google 登入失敗:", error);
    if (typeof showToast === 'function') showToast("登入失敗：" + error.message, "error");
  }
}

// 2. Email 登入與註冊
async function loginWithEmail(email, password) {
  try {
    const result = await auth.signInWithEmailAndPassword(email, password);
    localStorage.removeItem('lzhcard_guest_mode');
    if (typeof loadStorage === 'function') await loadStorage();
    return result.user;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      try {
        const newResult = await auth.createUserWithEmailAndPassword(email, password);
        localStorage.removeItem('lzhcard_guest_mode');
        if (typeof showToast === 'function') showToast("已自動為您註冊新帳號並登入！", "success");
        if (typeof loadStorage === 'function') await loadStorage();
        return newResult.user;
      } catch (regError) {
        if (typeof showToast === 'function') showToast("註冊失敗：" + regError.message, "error");
      }
    } else {
      if (typeof showToast === 'function') showToast("登入失敗：" + error.message, "error");
    }
  }
}

// 3. 登出（登出前先確保所有作答紀錄已同步至 Firestore，並立即標記為離線）
async function logoutUser() {
  try {
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.flushCloudSave === 'function') {
      await StorageEngine.flushCloudSave();
    }
    if (typeof setUserOfflineNow === 'function') {
      await setUserOfflineNow();
    }
    if (typeof detachChatRealtimeListeners === 'function') {
      detachChatRealtimeListeners();
    }
    await auth.signOut();
    console.log("已成功登出");
    if (typeof loadStorage === 'function') {
      await loadStorage();
    }
    if (typeof showToast === 'function') showToast("已成功登出帳號！", "info");
  } catch (error) {
    console.error("登出失敗:", error);
  }
}

// 4. 🏷️ 儲存固定個人暱稱至 Firestore (相容個人檔案頁面 #profileNicknameInput 與舊輸入框)
async function handleSaveNickname() {
  if (typeof saveProfileBasicInfo === 'function' && document.getElementById('profileBioInput')) {
    return saveProfileBasicInfo();
  }

  const input = document.getElementById('profileNicknameInput') || document.getElementById('settingsNicknameInput');
  const newNickname = (input?.value || '').trim();

  if (!newNickname) {
    if (typeof showToast === 'function') showToast('暱稱不能為空！', 'warning');
    return;
  }

  if (!auth.currentUser) {
    if (typeof showToast === 'function') showToast('訪客模式無法設定固定暱稱，請先登入帳號！', 'warning');
    return;
  }

  try {
    await db.collection('users').doc(auth.currentUser.uid).set({
      nickname: newNickname,
      email: auth.currentUser.email,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (!window.userData) window.userData = {};
    window.userData.nickname = newNickname;
    window.userData.username = newNickname;

    const emailEl = document.getElementById('settings-email');
    if (emailEl) emailEl.innerText = newNickname;

    if (typeof syncMyPublicProfile === 'function') {
      await syncMyPublicProfile(true);
    } else if (typeof writeCurrentUserOnlineStatus === 'function') {
      writeCurrentUserOnlineStatus();
    }
    if (typeof renderProfileSection === 'function') renderProfileSection();

    if (typeof showToast === 'function') showToast(`固定暱稱已成功更新為「${newNickname}」！`, 'success');
  } catch (err) {
    console.error("更新暱稱失敗:", err);
    if (typeof showToast === 'function') showToast("更新暱稱失敗：" + err.message, "error");
  }
}

// 🌐 5. 儲存多選字庫組合至雲端與 LocalStorage
async function saveSelectedCategoriesToCloud(categories) {
  if (!Array.isArray(categories)) return;
  
  localStorage.setItem('lzhcard_selected_categories', JSON.stringify(categories));
  window.selectedCategories = categories;

  if (auth.currentUser) {
    try {
      await db.collection('users').doc(auth.currentUser.uid).set({
        selectedCategories: categories,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("同步多選字庫至雲端失敗：", e);
    }
  }
}

// 🌐 6. 儲存好友列表至雲端 Firestore
async function saveFriendsToCloud(friends) {
  if (!Array.isArray(friends) || !auth.currentUser) return;
  try {
    await db.collection('users').doc(auth.currentUser.uid).set({
      friends: friends,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn("同步好友列表至雲端失敗：", e);
  }
}

// 💾 6.5 儲存使用者檔案、外觀設定、好友名單與隱私偏好至雲端 Firestore
async function saveUserData() {
  if (!window.userData) window.userData = {};
  if (!auth.currentUser) return false;

  try {
    const payload = {
      nickname: window.userData.nickname || '',
      bio: typeof window.userData.bio === 'string' ? window.userData.bio : '',
      friends: Array.isArray(window.userData.friends) ? window.userData.friends : [],
      privacyHideStatus: Boolean(window.userData.privacyHideStatus),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (typeof window.userData.coins === 'number' && Number.isFinite(window.userData.coins)) {
      payload.coins = Math.max(0, Math.floor(window.userData.coins));
    }
    if (window.userData.cosmetics && typeof window.userData.cosmetics === 'object') {
      payload.cosmetics = window.userData.cosmetics;
    }
    if (window.userData.privacy && typeof window.userData.privacy === 'object') {
      payload.privacy = window.userData.privacy;
    }
    if (window.userData.progression && typeof window.userData.progression === 'object') {
      payload.progression = window.userData.progression;
    }
    if (window.userData.chatPrefs && typeof window.userData.chatPrefs === 'object') {
      payload.chatPrefs = window.userData.chatPrefs;
    }

    await db.collection('users').doc(auth.currentUser.uid).set(payload, { merge: true });
    return true;
  } catch (e) {
    console.warn("同步使用者資料至雲端失敗：", e);
    return false;
  }
}
if (typeof window !== 'undefined') {
  window.saveUserData = saveUserData;
}

// 7. 監聽帳號狀態切換，同步雲端資料與字庫記憶
auth.onAuthStateChanged(async (user) => {
  if (typeof setAppLoaderProgress === 'function') {
    setAppLoaderProgress(35, '驗證帳號狀態中...');
  }

  const emailEl = document.getElementById('settings-email');
  const subtextEl = document.getElementById('settings-subtext');
  const avatarEl = document.getElementById('settings-avatar');
  const navAvatarEl = document.getElementById('nav-avatar');
  const loggedOutEl = document.getElementById('settings-logged-out');
  const loggedInEl = document.getElementById('settings-logged-in');

  if (user) {
    // 登入後立即清除訪客模式標記，解除商城與聊天室限制
    localStorage.removeItem('lzhcard_guest_mode');

    let userNickname = user.displayName || (user.email ? user.email.split('@')[0] : '使用者');
    let userRole = 'user';
    let userCoins = 500;
    let userFriends = [];

    // 先寫入基本登入身分，避免 Firestore 讀取期間被誤判為訪客
    if (!window.userData) window.userData = {};
    window.userData.uid = user.uid;
    window.userData.email = user.email || '';
    window.userData.photoURL = user.photoURL || '';
    window.userData.nickname = userNickname;
    window.userData.username = userNickname;

    let userBio = '';
    let userCosmetics = null;
    let userPrivacy = null;
    let userProgression = null;
    let userChatPrefs = null;
    let userPrivacyHideStatus = false;

    try {
      const userRef = db.collection('users').doc(user.uid);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const data = userDoc.data();
        if (data.nickname) userNickname = data.nickname;
        if (data.role) userRole = data.role;
        if (typeof data.coins === 'number') userCoins = data.coins;
        if (Array.isArray(data.friends)) userFriends = data.friends;
        if (typeof data.bio === 'string') userBio = data.bio;
        if (data.cosmetics && typeof data.cosmetics === 'object') userCosmetics = data.cosmetics;
        if (data.privacy && typeof data.privacy === 'object') userPrivacy = data.privacy;
        if (data.progression && typeof data.progression === 'object') userProgression = data.progression;
        if (data.chatPrefs && typeof data.chatPrefs === 'object') userChatPrefs = data.chatPrefs;
        if (typeof data.privacyHideStatus === 'boolean') userPrivacyHideStatus = data.privacyHideStatus;

        if (Array.isArray(data.selectedCategories) && data.selectedCategories.length > 0) {
          window.selectedCategories = data.selectedCategories;
          localStorage.setItem('lzhcard_selected_categories', JSON.stringify(data.selectedCategories));
        }
      }

      await userRef.set({
        email: user.email || '',
        photoURL: user.photoURL || '',
        nickname: userNickname,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

    } catch (e) {
      console.warn("無法同步或讀取雲端使用者資料：", e);
    }

    window.userData.nickname = userNickname;
    window.userData.username = userNickname;
    window.userData.role = userRole;
    window.userData.coins = userCoins;
    window.userData.friends = userFriends;
    window.userData.bio = userBio;
    window.userData.privacyHideStatus = userPrivacyHideStatus;
    if (userCosmetics) window.userData.cosmetics = userCosmetics;
    if (userPrivacy) window.userData.privacy = userPrivacy;
    if (userProgression) window.userData.progression = userProgression;
    if (userChatPrefs) window.userData.chatPrefs = userChatPrefs;
    if (typeof ensureUserProfileDefaults === 'function') ensureUserProfileDefaults();
    if (typeof syncChatPrefsFromUserData === 'function') syncChatPrefsFromUserData();

    const nicknameInput = document.getElementById('profileNicknameInput') || document.getElementById('settingsNicknameInput');
    if (nicknameInput) nicknameInput.value = userNickname;

    if (emailEl) {
      emailEl.removeAttribute('data-i18n');
      emailEl.innerText = userNickname;
    }
    if (subtextEl) {
      subtextEl.removeAttribute('data-i18n');
      subtextEl.innerText = user.email ? `已連結：${user.email}` : "已連結 Google 帳號";
    }

    const defaultAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.uid)}`;
    const userPhoto = user.photoURL || defaultAvatar;

    if (avatarEl) avatarEl.src = userPhoto;
    if (navAvatarEl) navAvatarEl.src = userPhoto;
    if (typeof applyNavAvatarFrame === 'function') applyNavAvatarFrame();
    if (loggedOutEl) loggedOutEl.style.display = 'none';
    if (loggedInEl) loggedInEl.style.display = 'block';

    if (typeof initChatRealtimeListeners === 'function') {
      initChatRealtimeListeners();
    }
  } else {
    if (!window.userData) window.userData = {};
    window.userData.uid = '';
    window.userData.email = '';
    window.userData.photoURL = '';
    window.userData.nickname = '';
    window.userData.username = '訪客玩家';
    window.userData.role = 'user';
    window.userData.coins = 0;
    window.userData.friends = [];
    window.userData.bio = '';
    window.userData.cosmetics = { frame: 'default', banner: 'default', title: 'newcomer', unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] };
    window.userData.privacy = { isStatsPublic: true };
    window.userData.progression = { xp: 0, level: 1, streakDays: 0, streakShields: 0, lastActiveDate: '', rankTier: '青銅 III', rankPoints: 0, duelWins: 0, duelTotal: 0 };
    window.userData.chatPrefs = { mutedChats: [], pinnedChats: [], manualUnreadChats: [], deletedChats: [] };
    if (typeof ensureUserProfileDefaults === 'function') ensureUserProfileDefaults();

    if (emailEl) {
      emailEl.setAttribute('data-i18n', 'guestMode');
      emailEl.innerText = (typeof t === 'function') ? t('guestMode') : "訪客模式";
    }
    if (subtextEl) {
      subtextEl.setAttribute('data-i18n', 'notLinkedGoogle');
      subtextEl.innerText = (typeof t === 'function') ? t('notLinkedGoogle') : "目前未連結 Google 帳號";
    }

    const guestAvatar = "https://api.dicebear.com/7.x/bottts/svg?seed=user";
    if (avatarEl) avatarEl.src = guestAvatar;
    if (navAvatarEl) navAvatarEl.src = guestAvatar;
    if (typeof applyNavAvatarFrame === 'function') applyNavAvatarFrame();
    if (loggedOutEl) loggedOutEl.style.display = 'block';
    if (loggedInEl) loggedInEl.style.display = 'none';
  }

  try {
    if (typeof setAppLoaderProgress === 'function') setAppLoaderProgress(60, '同步雲端字庫與設定...');
    if (typeof loadStorage === 'function') await loadStorage();

    if (typeof setAppLoaderProgress === 'function') setAppLoaderProgress(85, '載入畫面與權限中...');
    if (typeof updateUI === 'function') updateUI();
    if (typeof renderStore === 'function') renderStore();
    if (typeof updateUserCoinsUI === 'function') updateUserCoinsUI();
    if (typeof checkAdminPermissions === 'function') checkAdminPermissions();
    if (typeof updateUnreadBadgeUI === 'function') updateUnreadBadgeUI();
    if (typeof syncMyPublicProfile === 'function') syncMyPublicProfile(true);
    if (typeof renderProfileSection === 'function') renderProfileSection();
    if (typeof GameEngine !== 'undefined' && typeof GameEngine.renderHomePortal === 'function') {
      GameEngine.renderHomePortal();
    }
  } finally {
    window.__authInitialLoadDone = true;
    window.__appReadyToHideLoader = true;
    if (typeof hideAppLoader === 'function') hideAppLoader();
  }

  const isTosAccepted = localStorage.getItem('lzhcard_tos_accepted') === 'true';
  const isCompleted = localStorage.getItem('lzhcard_onboarding_completed') === 'true';
  const isV2Done = localStorage.getItem('lzhcard_onboarding_v2_done') === 'true';

  if (isTosAccepted && !isCompleted && typeof startOnboardingFlow === 'function') {
    setTimeout(() => {
      startOnboardingFlow();
    }, 200);
  } else if (isTosAccepted && !isV2Done && typeof OnboardingTour !== 'undefined' && typeof OnboardingTour.start === 'function') {
    setTimeout(() => {
      OnboardingTour.start();
    }, 200);
  } else if (typeof StartupDeepLinkQueue !== 'undefined' && typeof StartupDeepLinkQueue.processWhenReady === 'function') {
    StartupDeepLinkQueue.processWhenReady();
  } else if (typeof MultiplayerEngine !== 'undefined' && typeof MultiplayerEngine.checkUrlDuelInvite === 'function') {
    MultiplayerEngine.checkUrlDuelInvite();
  }
});

// ==========================================
// 🔒 條款同意與新手引導流程控制 (welcomeModal)
// ==========================================

function toggleAuthButtons() {
  const checkbox = document.getElementById('tosCheckbox');
  const googleBtn = document.getElementById('welcomeGoogleBtn');
  const guestBtn = document.getElementById('welcomeGuestBtn');

  const isChecked = checkbox ? checkbox.checked : false;

  if (googleBtn) {
    googleBtn.disabled = !isChecked;
    if (isChecked) {
      googleBtn.className = "w-full py-3 bg-white dark:bg-slate-900 hover:bg-slate-100 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer shadow-xs";
    } else {
      googleBtn.className = "w-full py-3 bg-slate-200 dark:bg-slate-700 text-slate-400 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-not-allowed";
    }
  }

  if (guestBtn) {
    guestBtn.disabled = !isChecked;
    if (isChecked) {
      guestBtn.className = "w-full py-3 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer shadow-xs";
    } else {
      guestBtn.className = "w-full py-3 bg-slate-200 dark:bg-slate-700 text-slate-400 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-not-allowed";
    }
  }
}

async function handleWelcomeGoogleLogin() {
  localStorage.setItem('lzhcard_tos_accepted', 'true');
  localStorage.removeItem('lzhcard_guest_mode');

  const user = await loginWithGoogle();
  if (user) {
    if (typeof startOnboardingFlow === 'function') {
      startOnboardingFlow();
    } else {
      if (typeof closeModal === 'function') closeModal('welcomeModal');
    }
  }
}

function handleWelcomeGuestLogin() {
  localStorage.setItem('lzhcard_tos_accepted', 'true');
  
  if (typeof closeModal === 'function') {
    closeModal('welcomeModal');
  }

  setTimeout(() => {
    if (typeof startOnboardingFlow === 'function') {
      startOnboardingFlow();
    }
  }, 150);
}

function checkWelcomeModalState() {
  const isAccepted = localStorage.getItem('lzhcard_tos_accepted') === 'true';
  const welcomeModal = document.getElementById('welcomeModal');
  
  if (!isAccepted && welcomeModal) {
    welcomeModal.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', checkWelcomeModalState);

// ==========================================
// 🗑️ 永久註銷帳號與高安全性防呆機制
// ==========================================

function isDeleteAccountKeywordValid(rawText) {
  const val = String(rawText || '').trim();
  if (!val) return false;
  return val === '註銷帳號' || val.toUpperCase() === 'DELETE' || val === 'アカウント削除';
}

function validateDeleteAccountInput() {
  const input = document.getElementById('deleteAccountConfirmInput');
  const btn = document.getElementById('confirmDeleteAccountBtn');
  if (!input || !btn) return false;

  const isValid = isDeleteAccountKeywordValid(input.value);
  btn.disabled = !isValid;
  if (isValid) {
    btn.className = "flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold rounded-xl shadow-sm transition cursor-pointer flex items-center justify-center gap-1.5";
  } else {
    btn.className = "flex-1 py-2.5 bg-slate-200 dark:bg-slate-700 text-slate-400 text-xs font-extrabold rounded-xl transition cursor-not-allowed flex items-center justify-center gap-1.5";
  }
  return isValid;
}

function openDeleteAccountModal() {
  const user = auth && auth.currentUser ? auth.currentUser : null;
  if (!user) {
    if (typeof showToast === 'function') {
      const msg = (typeof t === 'function' && t('toastGuestCannotDeleteAccount') !== 'toastGuestCannotDeleteAccount')
        ? t('toastGuestCannotDeleteAccount')
        : '訪客模式未連結雲端帳號，無需進行註銷！';
      showToast(msg, 'warning');
    }
    return false;
  }

  const modal = document.getElementById('deleteAccountModal');
  const input = document.getElementById('deleteAccountConfirmInput');
  const emailHint = document.getElementById('deleteAccountUserEmail');
  if (input) input.value = '';
  if (emailHint) emailHint.textContent = user.email || user.uid;

  validateDeleteAccountInput();

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
  return true;
}

function closeDeleteAccountModal() {
  const modal = document.getElementById('deleteAccountModal');
  const input = document.getElementById('deleteAccountConfirmInput');
  if (input) input.value = '';
  validateDeleteAccountInput();
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function reauthenticateCurrentUser(user) {
  if (!user) throw new Error('找不到目前登入使用者');
  const providerIds = Array.isArray(user.providerData) ? user.providerData.map(p => p.providerId) : [];

  if (providerIds.includes('google.com')) {
    if (isNativeApp()) {
      const capPlugins = window.Capacitor?.Plugins || {};
      if (capPlugins.FirebaseAuthentication && typeof capPlugins.FirebaseAuthentication.signInWithGoogle === 'function') {
        const nativeRes = await capPlugins.FirebaseAuthentication.signInWithGoogle();
        const idToken = nativeRes?.credential?.idToken || nativeRes?.idToken;
        if (!idToken) throw new Error('無法取得原生 Google 驗證憑證');
        const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
        return await user.reauthenticateWithCredential(credential);
      }
      if (capPlugins.GoogleAuth && typeof capPlugins.GoogleAuth.signIn === 'function') {
        const googleUser = await capPlugins.GoogleAuth.signIn();
        const idToken = googleUser?.authentication?.idToken || googleUser?.idToken;
        if (!idToken) throw new Error('無法取得 GoogleAuth 驗證憑證');
        const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
        return await user.reauthenticateWithCredential(credential);
      }
      throw new Error('原生環境需透過 Google 外掛重新驗證登入');
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return await user.reauthenticateWithPopup(provider);
  }

  const err = new Error('為確保帳號安全，請先登出並重新登入後再執行永久註銷帳號。');
  err.code = 'auth/requires-recent-login';
  throw err;
}

async function deleteFirestoreUserAndSubcollections(uid) {
  if (!uid || typeof db === 'undefined' || !db) return;
  const userRef = db.collection('users').doc(uid);
  const chunksRef = userRef.collection('deckChunks');

  // 1. 先刪除所有 deckChunks 分片文件（每批最多 450 筆）
  try {
    const chunksSnap = await chunksRef.get();
    if (chunksSnap && !chunksSnap.empty) {
      const docs = chunksSnap.docs || [];
      for (let i = 0; i < docs.length; i += 450) {
        const batch = db.batch();
        docs.slice(i, i + 450).forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
      }
    }
  } catch (chunkErr) {
    console.warn('刪除使用者字庫分片失敗：', chunkErr);
  }

  // 2. 刪除公開檔案與使用者主文件
  await db.collection('publicProfiles').doc(uid).delete().catch(err => {
    console.warn('刪除 publicProfiles 文件失敗：', err);
  });
  await userRef.delete();
}

async function deleteRtdbUserRecords(uid) {
  if (!uid || typeof firebase === 'undefined' || !firebase.database) return;
  const rtdb = firebase.database();

  try {
    await rtdb.ref(`status/${uid}`).onDisconnect().cancel().catch(() => {});
  } catch (e) {}

  await rtdb.ref(`status/${uid}`).remove().catch(() => {});
  await rtdb.ref(`users/${uid}`).remove().catch(() => {});

  // 清理相關的好友申請紀錄
  try {
    const reqSnap = await rtdb.ref('friendRequests').once('value');
    const reqData = reqSnap.val() || {};
    const deletions = [];
    Object.keys(reqData).forEach(reqId => {
      const req = reqData[reqId];
      if (req && (req.fromUid === uid || req.toUid === uid)) {
        deletions.push(rtdb.ref(`friendRequests/${reqId}`).remove().catch(() => {}));
      }
    });
    if (deletions.length > 0) await Promise.all(deletions);
  } catch (e) {}
}

/**
 * 🧨 執行永久註銷帳號（嚴格順序：前置近期登入驗證 -> 1.刪除雲端資料庫 -> 2.清空本地儲存 -> 3.刪除 Auth 帳號）
 */
async function handlePermanentAccountDeletion() {
  const user = auth && auth.currentUser ? auth.currentUser : null;
  if (!user) {
    if (typeof showToast === 'function') showToast('目前尚未登入任何帳號！', 'warning');
    closeDeleteAccountModal();
    return false;
  }

  const input = document.getElementById('deleteAccountConfirmInput');
  if (input && !isDeleteAccountKeywordValid(input.value)) {
    if (typeof showToast === 'function') {
      showToast('請先正確輸入確認文字「註銷帳號」！', 'warning');
    }
    return false;
  }

  const btn = document.getElementById('confirmDeleteAccountBtn');
  const origBtnHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>正在永久註銷...</span>`;
  }

  const uid = user.uid;

  try {
    // 預檢：若上次登入時間超過 4.5 分鐘且為 Google 登入，先行完成重新驗證再動手刪資料，避免刪除到一半因 requires-recent-login 中斷
    const lastSignInMs = user.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : 0;
    const providerIds = Array.isArray(user.providerData) ? user.providerData.map(p => p.providerId) : [];
    if (lastSignInMs > 0 && (Date.now() - lastSignInMs) > 270000 && providerIds.includes('google.com')) {
      if (typeof showToast === 'function') {
        showToast('為確保帳號安全，請先完成 Google 重新驗證...', 'info');
      }
      await reauthenticateCurrentUser(user);
    }

    // 步驟 0：中止所有延遲寫回排程，防止刪除後又寫回殘留資料
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.cancelPendingSync === 'function') {
      StorageEngine.cancelPendingSync();
    }

    // 步驟 1：先於仍保有登入權限時刪除雲端資料庫 (Firestore + RTDB)
    await deleteFirestoreUserAndSubcollections(uid);
    await deleteRtdbUserRecords(uid);
    if (typeof detachChatRealtimeListeners === 'function') {
      detachChatRealtimeListeners();
    }

    // 步驟 2：清空所有與該 uid 關聯的 LocalIDB 與 localStorage 資料
    if (typeof StorageEngine !== 'undefined' && typeof StorageEngine.clearUserLocalData === 'function') {
      await StorageEngine.clearUserLocalData(uid);
    }

    if (typeof window !== 'undefined') {
      window.userData = {
        uid: '',
        email: '',
        photoURL: '',
        nickname: '',
        username: '訪客玩家',
        role: 'user',
        coins: 0,
        friends: [],
        bio: '',
        cosmetics: { frame: 'default', banner: 'default', title: 'newcomer', unlockedFrames: [], unlockedBanners: [], unlockedTitles: [] },
        privacy: { isStatsPublic: true },
        progression: { xp: 0, level: 1, streakDays: 0, rankTier: '青銅 III', rankPoints: 0, duelWins: 0, duelTotal: 0 }
      };
      if (typeof resetStudySessionState === 'function') resetStudySessionState();
    }

    // 步驟 3：最後呼叫 Firebase Auth 刪除使用者帳號
    try {
      await user.delete();
    } catch (authErr) {
      if (authErr && authErr.code === 'auth/requires-recent-login') {
        if (typeof showToast === 'function') {
          showToast('偵測到需要重新驗證登入身分以完成帳號刪除...', 'warning');
        }
        await reauthenticateCurrentUser(user);
        await user.delete();
      } else {
        throw authErr;
      }
    }

    closeDeleteAccountModal();
    if (typeof closeSettingsDrawer === 'function') closeSettingsDrawer();
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof updateUI === 'function') updateUI();
    if (typeof renderProfileSection === 'function') renderProfileSection();
    if (typeof openWelcomeModal === 'function') openWelcomeModal();

    if (typeof showToast === 'function') {
      const doneMsg = (typeof t === 'function' && t('toastAccountDeletedSuccess') !== 'toastAccountDeletedSuccess')
        ? t('toastAccountDeletedSuccess')
        : '✅ 您的帳號與所有雲端及本機資料已永久註銷。';
      showToast(doneMsg, 'success');
    }
    return true;
  } catch (err) {
    console.error('永久註銷帳號失敗：', err);
    if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) {
      if (typeof showToast === 'function') showToast('已取消身分驗證，帳號註銷流程已中止。', 'info');
    } else if (err && err.code === 'auth/requires-recent-login') {
      if (typeof showToast === 'function') showToast('基於安全考量，請登出後重新登入一次再執行永久註銷帳號。', 'warning');
    } else {
      if (typeof showToast === 'function') showToast('註銷帳號失敗：' + (err?.message || '未知錯誤'), 'error');
    }
    return false;
  } finally {
    if (btn) {
      btn.innerHTML = origBtnHtml;
      validateDeleteAccountInput();
    }
  }
}

if (typeof window !== 'undefined') {
  window.isDeleteAccountKeywordValid = isDeleteAccountKeywordValid;
  window.validateDeleteAccountInput = validateDeleteAccountInput;
  window.openDeleteAccountModal = openDeleteAccountModal;
  window.closeDeleteAccountModal = closeDeleteAccountModal;
  window.handlePermanentAccountDeletion = handlePermanentAccountDeletion;
}
