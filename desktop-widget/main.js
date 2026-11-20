const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    globalShortcut,
    ipcMain,
    screen,
    shell,
    nativeImage,
    session
} = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BALL_SIZE = { width: 76, height: 76 };
const PANEL_SIZE = { width: 436, height: 650 };
const FULLSCREEN_DEFAULT_SIZE = { width: 980, height: 700 };
const EDGE_MARGIN = 14;
const PRIMARY_TOGGLE_SHORTCUT = 'Alt+T';
const FALLBACK_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+T';
const WIDGET_HTTP_HOST = 'localhost';
const WIDGET_HTTP_PORT = 18923;
const WIDGET_HTTP_ORIGIN = `http://${WIDGET_HTTP_HOST}:${WIDGET_HTTP_PORT}`;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'video/webm',
    '.txt': 'text/plain; charset=utf-8'
};

let mainWin = null;
let tray = null;
let localStaticServer = null;
let localStaticServerOrigin = '';
let isExpanded = true;
let isFullscreenViewer = false;
let alwaysOnTopEnabled = true;
let isQuitting = false;
let activeToggleShortcut = PRIMARY_TOGGLE_SHORTCUT;
let currentLogicalBounds = { x: 0, y: 0, width: PANEL_SIZE.width, height: PANEL_SIZE.height };
let trayIconCache = null;

function getConfigFilePath() {
    return path.join(app.getPath('userData'), 'lzhcard-widget-config.json');
}

function readWidgetConfig() {
    try {
        const raw = fs.readFileSync(getConfigFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeWidgetConfig(patch) {
    try {
        const prev = readWidgetConfig();
        const next = { ...prev, ...patch };
        fs.writeFileSync(getConfigFilePath(), JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {}
}

function getCliArgValue(prefix) {
    const found = process.argv.find(arg => typeof arg === 'string' && arg.startsWith(prefix));
    return found ? found.slice(prefix.length).trim() : '';
}

function createWidgetTrayIcon() {
    if (trayIconCache) return trayIconCache;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
        <defs>
            <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#4f46e5"/>
                <stop offset="100%" stop-color="#2563eb"/>
            </linearGradient>
        </defs>
        <rect x="4" y="4" width="56" height="56" rx="18" fill="url(#g)"/>
        <circle cx="32" cy="32" r="16" fill="none" stroke="#ffffff" stroke-width="3.2"/>
        <ellipse cx="32" cy="32" rx="8" ry="16" fill="none" stroke="#ffffff" stroke-width="2.6"/>
        <line x1="16" y1="32" x2="48" y2="32" stroke="#ffffff" stroke-width="2.8"/>
    </svg>`;
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const img = nativeImage.createFromDataURL(dataUrl);
    trayIconCache = process.platform === 'darwin'
        ? img.resize({ width: 18, height: 18 })
        : img.resize({ width: 24, height: 24 });
    return trayIconCache;
}

function probeLocalServer(urlStr, timeoutMs = 450) {
    return new Promise((resolve) => {
        try {
            const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
        } catch (e) {
            resolve(false);
        }
    });
}

function resolveWwwRootDir() {
    const devDir = path.resolve(__dirname, '../www');
    if (fs.existsSync(path.join(devDir, 'index.html'))) {
        return devDir;
    }
    const prodDir = path.resolve(process.resourcesPath || '', 'www');
    if (fs.existsSync(path.join(prodDir, 'index.html'))) {
        return prodDir;
    }
    return '';
}

function ensureLocalHttpStaticServer() {
    if (localStaticServer && localStaticServerOrigin) {
        return Promise.resolve(localStaticServerOrigin);
    }
    const wwwRoot = resolveWwwRootDir();
    if (!wwwRoot) {
        return Promise.resolve('');
    }
    const normalizedRoot = path.resolve(wwwRoot);

    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            try {
                const reqUrl = new URL(req.url || '/', WIDGET_HTTP_ORIGIN);
                let relPath = decodeURIComponent(reqUrl.pathname || '/');
                if (relPath === '/' || relPath === '') {
                    relPath = '/index.html';
                }
                const sanitizedRel = relPath.replace(/^\/+/, '');
                const resolvedPath = path.resolve(normalizedRoot, sanitizedRel);

                if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(normalizedRoot + path.sep)) {
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Forbidden');
                    return;
                }

                let targetFile = resolvedPath;
                if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
                    targetFile = path.join(targetFile, 'index.html');
                }

                if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                    return;
                }

                const ext = path.extname(targetFile).toLowerCase();
                const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache'
                });
                fs.createReadStream(targetFile).pipe(res);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Internal Server Error');
            }
        });

        server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                localStaticServerOrigin = WIDGET_HTTP_ORIGIN;
                resolve(localStaticServerOrigin);
            } else {
                resolve('');
            }
        });

        server.listen(WIDGET_HTTP_PORT, WIDGET_HTTP_HOST, () => {
            localStaticServer = server;
            localStaticServerOrigin = WIDGET_HTTP_ORIGIN;
            resolve(localStaticServerOrigin);
        });
    });
}

async function resolveTargetWidgetUrl() {
    const cliUrl = getCliArgValue('--url=');
    if (cliUrl) return cliUrl;

    if (process.env.LZHCARD_APP_URL && process.env.LZHCARD_APP_URL.trim()) {
        const u = new URL(process.env.LZHCARD_APP_URL.trim());
        u.searchParams.set('widget', 'desktop');
        return u.toString();
    }

    const cfg = readWidgetConfig();
    if (cfg.targetUrl && typeof cfg.targetUrl === 'string' && cfg.targetUrl.trim()) {
        return cfg.targetUrl.trim();
    }

    const localOrigin = await ensureLocalHttpStaticServer();
    if (localOrigin) {
        return `${localOrigin}/index.html?widget=desktop`;
    }

    const devReachable = await probeLocalServer('http://localhost:3000/', 450);
    if (devReachable) {
        return 'http://localhost:3000/?widget=desktop';
    }

    return `${WIDGET_HTTP_ORIGIN}/index.html?widget=desktop`;
}

function getDisplayForBounds(bounds) {
    const center = {
        x: Math.round((Number(bounds.x) || 0) + (Number(bounds.width) || BALL_SIZE.width) / 2),
        y: Math.round((Number(bounds.y) || 0) + (Number(bounds.height) || BALL_SIZE.height) / 2)
    };
    return screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
}

function getFixedLogicalSizeForMode(boundsRef = currentLogicalBounds) {
    if (isFullscreenViewer) {
        const display = getDisplayForBounds(boundsRef);
        const wa = display.workArea;
        return {
            width: Math.min(Math.max(FULLSCREEN_DEFAULT_SIZE.width, Math.round(wa.width * 0.88)), wa.width - 16),
            height: Math.min(Math.max(FULLSCREEN_DEFAULT_SIZE.height, Math.round(wa.height * 0.88)), wa.height - 16)
        };
    }
    if (isExpanded) {
        const display = getDisplayForBounds(boundsRef);
        const wa = display.workArea;
        return {
            width: Math.min(PANEL_SIZE.width, Math.max(320, wa.width - 16)),
            height: Math.min(PANEL_SIZE.height, Math.max(420, wa.height - 16))
        };
    }
    return { width: BALL_SIZE.width, height: BALL_SIZE.height };
}

function clampBoundsToWorkArea(bounds) {
    const targetW = Math.max(64, Math.round(Number(bounds.width) || BALL_SIZE.width));
    const targetH = Math.max(64, Math.round(Number(bounds.height) || BALL_SIZE.height));
    const display = getDisplayForBounds({ x: bounds.x, y: bounds.y, width: targetW, height: targetH });
    const wa = display.workArea;
    const width = Math.min(targetW, wa.width - 16);
    const height = Math.min(targetH, wa.height - 16);
    const x = Math.max(wa.x + 8, Math.min(Math.round(Number(bounds.x) || wa.x + 8), wa.x + wa.width - width - 8));
    const y = Math.max(wa.y + 8, Math.min(Math.round(Number(bounds.y) || wa.y + 8), wa.y + wa.height - height - 8));
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        scaleFactor: Number(display.scaleFactor) || 1,
        workArea: wa
    };
}

function setLockedWindowBounds(x, y, targetW, targetH) {
    if (!mainWin || mainWin.isDestroyed()) return null;
    const clamped = clampBoundsToWorkArea({ x, y, width: targetW, height: targetH });
    currentLogicalBounds = {
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height
    };
    // 先鎖死 Minimum/Maximum Size，再呼叫 setBounds，徹底杜絕跨螢幕 Windows 125%/150%/200% DPI 縮放拖曳膨脹 Bug
    mainWin.setMinimumSize(clamped.width, clamped.height);
    mainWin.setMaximumSize(clamped.width, clamped.height);
    mainWin.setBounds({
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height
    }, false);
    return clamped;
}

function syncBoundsToCurrentMonitorDpi() {
    if (!mainWin || mainWin.isDestroyed()) return;
    const fixed = getFixedLogicalSizeForMode(currentLogicalBounds);
    setLockedWindowBounds(currentLogicalBounds.x, currentLogicalBounds.y, fixed.width, fixed.height);
}

function applyWindowDimensions(targetSize) {
    if (!mainWin || mainWin.isDestroyed()) return;
    const prev = currentLogicalBounds;
    const centerX = prev.x + prev.width / 2;
    const display = screen.getDisplayNearestPoint({ x: Math.round(centerX), y: Math.round(prev.y) }) || screen.getPrimaryDisplay();
    const wa = display.workArea;

    // 展開或全螢幕時依據目前靠近左右側智慧延伸，避免視窗突然跑到另一邊
    const dockRight = centerX >= (wa.x + wa.width / 2);
    const desiredX = dockRight
        ? (prev.x + prev.width - targetSize.width)
        : prev.x;
    const desiredY = prev.y;

    const clamped = setLockedWindowBounds(desiredX, desiredY, targetSize.width, targetSize.height);
    if (clamped) {
        writeWidgetConfig({ x: clamped.x, y: clamped.y });
    }
}

function snapBallToScreenEdge() {
    if (!mainWin || mainWin.isDestroyed() || isExpanded || isFullscreenViewer) return null;
    const prev = currentLogicalBounds;
    const targetW = BALL_SIZE.width;
    const targetH = BALL_SIZE.height;
    const center = {
        x: Math.round(prev.x + targetW / 2),
        y: Math.round(prev.y + targetH / 2)
    };
    const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
    const wa = display.workArea;
    const snapLeft = center.x < (wa.x + wa.width / 2);
    const targetX = snapLeft ? (wa.x + EDGE_MARGIN) : (wa.x + wa.width - targetW - EDGE_MARGIN);
    const clamped = setLockedWindowBounds(targetX, prev.y, targetW, targetH);
    if (clamped) {
        writeWidgetConfig({ x: clamped.x, y: clamped.y });
    }
    return clamped;
}

function formatShortcutLabel(shortcut) {
    if (shortcut === FALLBACK_TOGGLE_SHORTCUT) {
        return process.platform === 'darwin' ? 'Cmd+Shift+T' : 'Ctrl+Shift+T';
    }
    return shortcut || PRIMARY_TOGGLE_SHORTCUT;
}

function setExpandedStateFromMain(expanded) {
    if (!mainWin || mainWin.isDestroyed()) return;
    isExpanded = Boolean(expanded);
    if (!isExpanded) isFullscreenViewer = false;
    const size = getFixedLogicalSizeForMode();
    applyWindowDimensions(size);
    if (!isExpanded) {
        snapBallToScreenEdge();
    }
    mainWin.webContents.send('widget:shortcut-toggle', {
        action: isExpanded ? 'expand' : 'collapse',
        expanded: isExpanded
    });
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;
    const visible = Boolean(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
    const shortcutLabel = formatShortcutLabel(activeToggleShortcut);
    tray.setToolTip(`LZHCard 桌面翻譯小工具 (${shortcutLabel})`);
    const menu = Menu.buildFromTemplate([
        {
            label: `${visible ? '隱藏桌面懸浮視窗' : '顯示桌面懸浮視窗'} (${shortcutLabel})`,
            accelerator: activeToggleShortcut,
            click: () => toggleWidgetVisibilityOrExpand()
        },
        {
            label: isExpanded ? '收合為懸浮球' : '展開懸浮翻譯 / 聊天視窗',
            click: () => {
                if (!mainWin || mainWin.isDestroyed()) return;
                if (mainWin.isMinimized()) mainWin.restore();
                mainWin.show();
                if (alwaysOnTopEnabled) mainWin.setAlwaysOnTop(true, 'screen-saver');
                mainWin.focus();
                setExpandedStateFromMain(!isExpanded);
            }
        },
        { type: 'separator' },
        {
            label: '永遠置頂 (Always on Top)',
            type: 'checkbox',
            checked: alwaysOnTopEnabled,
            click: (item) => setAlwaysOnTopState(item.checked)
        },
        {
            label: '貼齊最近螢幕邊緣',
            click: () => {
                setExpandedStateFromMain(false);
            }
        },
        { type: 'separator' },
        {
            label: '重新載入 LZHCard 小工具',
            click: async () => {
                if (!mainWin || mainWin.isDestroyed()) return;
                const url = await resolveTargetWidgetUrl();
                mainWin.loadURL(url);
            }
        },
        {
            label: '在瀏覽器開啟完整 LZHCard',
            click: async () => {
                const devReachable = await probeLocalServer('http://localhost:3000/', 350);
                if (devReachable) {
                    shell.openExternal('http://localhost:3000/');
                } else {
                    const localOrigin = await ensureLocalHttpStaticServer();
                    shell.openExternal(localOrigin ? `${localOrigin}/index.html` : 'http://localhost:3000/');
                }
            }
        },
        { type: 'separator' },
        {
            label: '結束桌面懸浮小工具',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);
    tray.setContextMenu(menu);
}

function setAlwaysOnTopState(flag) {
    alwaysOnTopEnabled = Boolean(flag);
    writeWidgetConfig({ alwaysOnTop: alwaysOnTopEnabled });
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.setAlwaysOnTop(alwaysOnTopEnabled, alwaysOnTopEnabled ? 'screen-saver' : 'normal');
    }
    updateTrayMenu();
    return alwaysOnTopEnabled;
}

function toggleWidgetVisibilityOrExpand() {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) {
        mainWin.restore();
    }
    mainWin.show();
    if (alwaysOnTopEnabled) {
        mainWin.setAlwaysOnTop(true, 'screen-saver');
    }
    mainWin.focus();
    setExpandedStateFromMain(!isExpanded);
}

function configurePermissions() {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowed = new Set([
            'media',
            'display-capture',
            'notifications',
            'clipboard-read',
            'clipboard-sanitized-write'
        ]);
        callback(allowed.has(permission));
    });
}

function isOAuthPopupUrl(url) {
    const u = String(url || '').trim();
    if (!u || u === 'about:blank' || u.startsWith('about:blank')) return true;
    return (
        u.includes('accounts.google.com') ||
        u.includes('firebaseapp.com/__/auth') ||
        u.includes('web.app/__/auth')
    );
}

function isAllowedWidgetNavigation(rawUrl) {
    const u = String(rawUrl || '').trim();
    if (!u || isOAuthPopupUrl(u)) return true;
    try {
        const parsed = new URL(u);
        const host = parsed.hostname.toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') return true;
        const customAppUrl = process.env.LZHCARD_APP_URL ? new URL(process.env.LZHCARD_APP_URL.trim()) : null;
        if (customAppUrl && parsed.origin === customAppUrl.origin) return true;
        const cfg = readWidgetConfig();
        if (cfg.targetUrl) {
            const cfgUrl = new URL(String(cfg.targetUrl).trim());
            if (parsed.origin === cfgUrl.origin) return true;
        }
    } catch (e) {}
    return false;
}

async function createMainWindow() {
    const cfg = readWidgetConfig();
    if (typeof cfg.alwaysOnTop === 'boolean') {
        alwaysOnTopEnabled = cfg.alwaysOnTop;
    }

    isExpanded = true;
    isFullscreenViewer = false;

    const primaryWa = screen.getPrimaryDisplay().workArea;
    const defaultX = Number.isFinite(cfg.x)
        ? cfg.x
        : (primaryWa.x + primaryWa.width - PANEL_SIZE.width - EDGE_MARGIN);
    const defaultY = Number.isFinite(cfg.y)
        ? cfg.y
        : Math.max(primaryWa.y + 12, Math.round(primaryWa.y + (primaryWa.height - PANEL_SIZE.height) / 2));
    const initialBounds = clampBoundsToWorkArea({
        x: defaultX,
        y: defaultY,
        width: PANEL_SIZE.width,
        height: PANEL_SIZE.height
    });
    currentLogicalBounds = {
        x: initialBounds.x,
        y: initialBounds.y,
        width: initialBounds.width,
        height: initialBounds.height
    };

    mainWin = new BrowserWindow({
        x: initialBounds.x,
        y: initialBounds.y,
        width: initialBounds.width,
        height: initialBounds.height,
        minWidth: initialBounds.width,
        maxWidth: initialBounds.width,
        minHeight: initialBounds.height,
        maxHeight: initialBounds.height,
        transparent: true,
        frame: false,
        alwaysOnTop: alwaysOnTopEnabled,
        hasShadow: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: false,
        backgroundColor: '#00000000',
        icon: createWidgetTrayIcon(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    if (alwaysOnTopEnabled) {
        mainWin.setAlwaysOnTop(true, 'screen-saver');
    }
    if (typeof mainWin.setVisibleOnAllWorkspaces === 'function') {
        mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    mainWin.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWin.hide();
            updateTrayMenu();
        }
    });

    mainWin.on('will-resize', (event) => {
        event.preventDefault();
    });

    mainWin.on('resized', () => {
        syncBoundsToCurrentMonitorDpi();
    });

    screen.on('display-metrics-changed', () => {
        syncBoundsToCurrentMonitorDpi();
    });

    mainWin.webContents.on('did-finish-load', () => {
        if (!mainWin || mainWin.isDestroyed()) return;
        mainWin.webContents.insertCSS(`
            html, body, html[data-widget-mode="desktop"], body[data-widget-mode="desktop"] {
                background: transparent !important;
                background-color: transparent !important;
                padding: 0 !important;
                margin: 0 !important;
                min-height: 100vh !important;
                overflow: hidden !important;
            }
            #main-header,
            #bottom-nav,
            body > main,
            #appLoadingOverlay,
            #welcomeModal,
            #login-screen,
            #auth-modal,
            #auth-overlay,
            #onboardingSetupModal,
            #onboardingTourOverlay {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `).catch(() => {});
    });

    mainWin.webContents.on('will-navigate', (event, navUrl) => {
        if (!isAllowedWidgetNavigation(navUrl)) {
            event.preventDefault();
            if (/^https?:\/\//i.test(String(navUrl || ''))) {
                shell.openExternal(String(navUrl));
            }
        }
    });

    mainWin.webContents.setWindowOpenHandler(({ url }) => {
        if (isOAuthPopupUrl(url)) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 500,
                    height: 680,
                    center: true,
                    frame: true,
                    transparent: false,
                    alwaysOnTop: true,
                    autoHideMenuBar: true,
                    resizable: true
                }
            };
        }
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    const targetUrl = await resolveTargetWidgetUrl();
    await mainWin.loadURL(targetUrl);
    updateTrayMenu();
}

function registerIpcHandlers() {
    ipcMain.handle('widget:set-expanded', (_event, expanded) => {
        isExpanded = Boolean(expanded);
        if (!isExpanded) isFullscreenViewer = false;
        const size = getFixedLogicalSizeForMode();
        applyWindowDimensions(size);
        updateTrayMenu();
        return { expanded: isExpanded, bounds: { ...currentLogicalBounds } };
    });

    ipcMain.handle('widget:set-fullscreen-viewer', (_event, open) => {
        isFullscreenViewer = Boolean(open);
        const size = getFixedLogicalSizeForMode();
        applyWindowDimensions(size);
        return { fullscreen: isFullscreenViewer, bounds: { ...currentLogicalBounds } };
    });

    ipcMain.on('widget:move-by', (_event, delta) => {
        if (!mainWin || mainWin.isDestroyed()) return;
        const dx = Number(delta && delta.dx) || 0;
        const dy = Number(delta && delta.dy) || 0;
        const fixedSize = getFixedLogicalSizeForMode();
        const clamped = setLockedWindowBounds(
            currentLogicalBounds.x + dx,
            currentLogicalBounds.y + dy,
            fixedSize.width,
            fixedSize.height
        );
        if (clamped) {
            writeWidgetConfig({ x: clamped.x, y: clamped.y });
        }
    });

    ipcMain.handle('widget:snap-to-edge', () => {
        return snapBallToScreenEdge();
    });

    ipcMain.handle('widget:set-always-on-top', (_event, flag) => {
        return setAlwaysOnTopState(flag);
    });

    ipcMain.handle('widget:get-always-on-top', () => alwaysOnTopEnabled);

    ipcMain.handle('widget:get-state', () => ({
        expanded: isExpanded,
        fullscreenViewer: isFullscreenViewer,
        alwaysOnTop: alwaysOnTopEnabled
    }));

    ipcMain.on('widget:hide', () => {
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.hide();
            updateTrayMenu();
        }
    });

    ipcMain.on('widget:show', () => {
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.show();
            mainWin.focus();
            updateTrayMenu();
        }
    });

    ipcMain.handle('widget:open-external', (_event, url) => {
        if (/^https?:\/\//i.test(String(url || ''))) {
            return shell.openExternal(String(url));
        }
        return false;
    });
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWin && !mainWin.isDestroyed()) {
            if (!mainWin.isVisible()) mainWin.show();
            mainWin.focus();
        }
    });

    app.whenReady().then(async () => {
        configurePermissions();
        registerIpcHandlers();

        tray = new Tray(createWidgetTrayIcon());
        tray.setToolTip(`LZHCard 桌面翻譯小工具 (${formatShortcutLabel(activeToggleShortcut)})`);
        tray.on('click', () => toggleWidgetVisibilityOrExpand());

        await createMainWindow();

        let registered = false;
        try {
            registered = globalShortcut.register(PRIMARY_TOGGLE_SHORTCUT, () => {
                toggleWidgetVisibilityOrExpand();
            });
        } catch (err) {
            registered = false;
        }

        if (registered) {
            activeToggleShortcut = PRIMARY_TOGGLE_SHORTCUT;
        } else {
            console.warn('Global shortcut Alt+T unavailable, falling back to CommandOrControl+Shift+T');
            try {
                const fallbackOk = globalShortcut.register(FALLBACK_TOGGLE_SHORTCUT, () => {
                    toggleWidgetVisibilityOrExpand();
                });
                if (fallbackOk) {
                    activeToggleShortcut = FALLBACK_TOGGLE_SHORTCUT;
                }
            } catch (fallbackErr) {
                console.warn('Fallback shortcut CommandOrControl+Shift+T registration failed:', fallbackErr);
            }
        }
        updateTrayMenu();
    });

    app.on('before-quit', () => {
        isQuitting = true;
    });

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        if (localStaticServer) {
            try {
                localStaticServer.close();
            } catch (e) {}
            localStaticServer = null;
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}
