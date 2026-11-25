/**
 * LZHCard - PWA & iOS「加入主畫面」引導模組 (js/pwa-install.js)
 * 1. 註冊輕量 Service Worker (sw.js)，並自動略過原生 Capacitor / 桌面小工具環境
 * 2. 支援 Android/Chrome 原生 beforeinstallprompt 安裝提示
 * 3. 支援 iOS Safari / iOS Chrome「加入主畫面」步驟圖解與設定頁快捷入口
 */
(function (global) {
    'use strict';

    const DISMISS_KEY = 'lzhcard_pwa_banner_dismissed_until';
    const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

    let deferredPrompt = null;
    let bannerTimer = null;

    function isNativeEnvironment() {
        try {
            if (typeof global.isNativeApp === 'function' && global.isNativeApp()) return true;
            const cap = global.Capacitor;
            if (cap && (typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : cap.isNative)) return true;
            if (typeof global.isDesktopWidgetClient === 'function' && global.isDesktopWidgetClient()) return true;
            const proto = global.location && global.location.protocol ? String(global.location.protocol).toLowerCase() : '';
            if (proto === 'capacitor:' || proto === 'ionic:' || proto === 'file:') return true;
        } catch (e) {}
        return false;
    }

    function isStandaloneInstalled() {
        try {
            if (global.navigator && global.navigator.standalone === true) return true;
            if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
        } catch (e) {}
        return false;
    }

    function isIosDevice() {
        try {
            const ua = String(global.navigator && global.navigator.userAgent ? global.navigator.userAgent : '');
            if (/iPad|iPhone|iPod/i.test(ua)) return true;
            if (global.navigator && global.navigator.platform === 'MacIntel' && global.navigator.maxTouchPoints > 1) return true;
        } catch (e) {}
        return false;
    }

    function isIosSafariBrowser() {
        if (!isIosDevice()) return false;
        const ua = String(global.navigator && global.navigator.userAgent ? global.navigator.userAgent : '');
        const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Line\/|MicroMessenger|Instagram|FBAN|FBAV/i.test(ua);
        return isSafari;
    }

    function canOfferPwaInstall() {
        if (isNativeEnvironment() || isStandaloneInstalled()) return false;
        return Boolean(deferredPrompt || isIosDevice());
    }

    function registerServiceWorker() {
        if (isNativeEnvironment()) return;
        if (!('serviceWorker' in navigator)) return;
        const proto = global.location && global.location.protocol ? String(global.location.protocol) : '';
        if (proto !== 'https:' && global.location.hostname !== 'localhost' && global.location.hostname !== '127.0.0.1') {
            return;
        }
        global.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch(() => {});
        });
    }

    function dismissBannerForNow() {
        try {
            localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DURATION_MS));
        } catch (e) {}
        const banner = document.getElementById('lzhPwaInstallBanner');
        if (banner) banner.remove();
    }

    function isBannerDismissed() {
        try {
            const until = Number(localStorage.getItem(DISMISS_KEY) || '0');
            return until > Date.now();
        } catch (e) {
            return false;
        }
    }

    function closeIosInstallGuideModal() {
        const modal = document.getElementById('iosA2hsGuideModal');
        if (modal) modal.remove();
    }

    function openIosInstallGuideModal() {
        closeIosInstallGuideModal();
        const inSafari = isIosSafariBrowser();
        const modal = document.createElement('div');
        modal.id = 'iosA2hsGuideModal';
        modal.className = 'fixed inset-0 z-[9980] bg-slate-950/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 lzh-safe-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-3xl max-w-md w-full p-5 shadow-2xl border border-slate-200 dark:border-slate-700 space-y-4">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <img src="images/apple-touch-icon.png" alt="LZHCard" class="w-12 h-12 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 shrink-0">
                        <div>
                            <h3 class="text-base font-black text-slate-900 dark:text-white">將 LZHCard 加入 iPhone / iPad 主畫面</h3>
                            <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">安裝後可從桌面一鍵全螢幕啟動，體驗接近原生 App</p>
                        </div>
                    </div>
                    <button type="button" onclick="LzhPwaInstall.closeGuide()" class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center cursor-pointer shrink-0">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>

                ${!inSafari ? `
                    <div class="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs font-bold text-amber-800 dark:text-amber-200 leading-relaxed">
                        💡 偵測到您目前可能不在 Safari 瀏覽器中。請先複製本頁網址並在 <strong>Safari</strong> 開啟，再依下方步驟加入主畫面（Chrome iOS 16.4+ 亦可透過分享按鈕新增）。
                    </div>
                ` : ''}

                <div class="space-y-2.5 text-xs">
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 flex items-center gap-3">
                        <span class="w-7 h-7 rounded-full bg-brand-600 text-white font-black flex items-center justify-center shrink-0">1</span>
                        <div class="flex-1 leading-relaxed">
                            點擊瀏覽器工具列的 <strong class="text-brand-600 dark:text-brand-400">「分享」</strong> 按鈕
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 rounded bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800"><i class="fa-solid fa-arrow-up-from-square"></i></span>
                        </div>
                    </div>

                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 flex items-center gap-3">
                        <span class="w-7 h-7 rounded-full bg-brand-600 text-white font-black flex items-center justify-center shrink-0">2</span>
                        <div class="flex-1 leading-relaxed">
                            在選單中往下滑動，點擊 <strong class="text-brand-600 dark:text-brand-400">「加入主畫面」</strong>
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 rounded bg-slate-200 dark:bg-slate-700 font-bold"><i class="fa-regular fa-square-plus mr-1"></i>加入主畫面</span>
                        </div>
                    </div>

                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 flex items-center gap-3">
                        <span class="w-7 h-7 rounded-full bg-emerald-600 text-white font-black flex items-center justify-center shrink-0">3</span>
                        <div class="flex-1 leading-relaxed">
                            點擊右上角 <strong class="text-emerald-600 dark:text-emerald-400">「新增」</strong>，LZHCard 圖示就會出現在您的主畫面！
                        </div>
                    </div>
                </div>

                <div class="flex items-center gap-2 pt-1">
                    <button type="button" onclick="LzhPwaInstall.dismiss(); LzhPwaInstall.closeGuide();" class="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 text-xs font-bold cursor-pointer">
                        7 天內不再提醒
                    </button>
                    <button type="button" onclick="LzhPwaInstall.closeGuide()" class="flex-1 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-extrabold shadow-xs cursor-pointer">
                        我知道了
                    </button>
                </div>
            </div>
        `;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeIosInstallGuideModal();
        });
        document.body.appendChild(modal);
    }

    async function triggerInstall() {
        if (isNativeEnvironment() || isStandaloneInstalled()) {
            if (typeof global.showToast === 'function') {
                global.showToast('目前已在 App 模式執行中！', 'info');
            }
            return false;
        }
        if (deferredPrompt) {
            try {
                await deferredPrompt.prompt();
                const choice = await deferredPrompt.userChoice;
                deferredPrompt = null;
                syncInstallButtonsVisibility();
                if (choice && choice.outcome === 'accepted') {
                    const banner = document.getElementById('lzhPwaInstallBanner');
                    if (banner) banner.remove();
                    return true;
                }
            } catch (e) {}
            return false;
        }
        if (isIosDevice()) {
            openIosInstallGuideModal();
            return true;
        }
        if (typeof global.showToast === 'function') {
            global.showToast('請點擊瀏覽器右上角選單的「安裝應用程式」或「加入主畫面」', 'info');
        }
        return false;
    }

    function syncInstallButtonsVisibility() {
        const slot = document.getElementById('settingsPwaInstallSlot');
        if (!slot) return;
        const showSlot = !isNativeEnvironment() && !isStandaloneInstalled() && (isIosDevice() || Boolean(deferredPrompt));
        slot.classList.toggle('hidden', !showSlot);
    }

    function maybeShowFloatingBanner() {
        if (isNativeEnvironment() || isStandaloneInstalled() || isBannerDismissed()) return;
        if (!canOfferPwaInstall()) return;
        if (document.getElementById('lzhPwaInstallBanner')) return;

        // Avoid overlapping startup loader, TOS modal, or onboarding modals
        const loader = document.getElementById('appLoadingOverlay');
        if (loader && !loader.classList.contains('hidden') && loader.style.display !== 'none' && loader.style.opacity !== '0') return;
        const welcome = document.getElementById('welcomeModal');
        if (welcome && !welcome.classList.contains('hidden')) return;
        const onboarding = document.getElementById('onboardingSetupModal');
        if (onboarding && !onboarding.classList.contains('hidden')) return;

        const banner = document.createElement('div');
        banner.id = 'lzhPwaInstallBanner';
        banner.className = 'fixed bottom-20 left-3 right-3 sm:left-auto sm:right-5 sm:max-w-sm z-[52] bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-brand-200 dark:border-brand-700 rounded-2xl p-3 shadow-xl flex items-center gap-3';
        banner.innerHTML = `
            <img src="images/apple-touch-icon.png" alt="LZHCard" class="w-10 h-10 rounded-xl shrink-0 border border-slate-200 dark:border-slate-700">
            <div class="min-w-0 flex-1">
                <div class="text-xs font-extrabold text-slate-900 dark:text-white truncate">將 LZHCard 加入主畫面</div>
                <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate">${isIosDevice() ? '從桌面一鍵全螢幕開啟，免去瀏覽器網址列' : '安裝至裝置主畫面，快速啟動單字學習'}</div>
            </div>
            <button type="button" onclick="LzhPwaInstall.triggerInstall()" class="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-extrabold shrink-0 cursor-pointer">
                ${isIosDevice() ? '查看步驟' : '安裝'}
            </button>
            <button type="button" onclick="LzhPwaInstall.dismiss()" aria-label="關閉提示" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center shrink-0 cursor-pointer">
                <i class="fa-solid fa-xmark text-xs"></i>
            </button>
        `;
        document.body.appendChild(banner);
    }

    function scheduleBannerCheck(delayMs = 3500) {
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {
            bannerTimer = null;
            syncInstallButtonsVisibility();
            maybeShowFloatingBanner();
        }, delayMs);
    }

    function init() {
        registerServiceWorker();
        if (typeof document !== 'undefined') {
            document.addEventListener('DOMContentLoaded', () => {
                syncInstallButtonsVisibility();
                scheduleBannerCheck(4500);
            });
        }
        global.addEventListener('beforeinstallprompt', (e) => {
            if (isNativeEnvironment()) return;
            e.preventDefault();
            deferredPrompt = e;
            syncInstallButtonsVisibility();
            scheduleBannerCheck(1500);
        });
        global.addEventListener('appinstalled', () => {
            deferredPrompt = null;
            const banner = document.getElementById('lzhPwaInstallBanner');
            if (banner) banner.remove();
            syncInstallButtonsVisibility();
        });
    }

    init();

    global.LzhPwaInstall = {
        isIosDevice,
        isIosSafariBrowser,
        isStandaloneInstalled,
        isNativeEnvironment,
        canOfferPwaInstall,
        triggerInstall,
        openGuide: openIosInstallGuideModal,
        closeGuide: closeIosInstallGuideModal,
        dismiss: dismissBannerForNow,
        syncUI: syncInstallButtonsVisibility
    };
})(typeof window !== 'undefined' ? window : globalThis);
