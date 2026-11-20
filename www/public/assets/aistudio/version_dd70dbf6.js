/**
 * LZHCard - 版本檢查與本地快取徹底清洗腳本 (js/version.js)
 */
(async function () {
    // 👇 每次需要徹底清空使用者本地舊資料時，修改這個版號（需與 index.html 的 ?v= 一致）
    const CURRENT_VERSION = '9.26.11.15.17.14';
    const VERSION_KEY = 'lzhcard_app_version';
    const savedVersion = localStorage.getItem(VERSION_KEY);

    if (savedVersion !== CURRENT_VERSION) {
        // 1. 同步清空 localStorage 與 sessionStorage
        localStorage.clear();
        sessionStorage.clear();

        // 2. 清空所有 IndexedDB 資料庫（含單字庫與舊登入狀態）
        if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
            try {
                const dbs = await indexedDB.databases();
                await Promise.all(
                    dbs.map(db => new Promise(resolve => {
                        if (!db.name) return resolve();
                        const req = indexedDB.deleteDatabase(db.name);
                        req.onsuccess = resolve;
                        req.onerror = resolve;
                        req.onblocked = resolve;
                    }))
                );
            } catch (e) {
                console.warn('IndexedDB 清除失敗:', e);
            }
        }

        // 3. 清空瀏覽器 Cache Storage
        if ('caches' in window) {
            try {
                const cacheNames = await caches.keys();
                await Promise.all(cacheNames.map(name => caches.delete(name)));
            } catch (e) {
                console.warn('Cache Storage 清除失敗:', e);
            }
        }

        // 4. 寫入新版號並強制重新載入頁面
        localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
        window.location.reload();
    }
})();
