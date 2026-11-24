const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LZHDesktopWidget', {
    isElectron: true,
    platform: process.platform,
    setExpanded: (expanded) => ipcRenderer.invoke('widget:set-expanded', Boolean(expanded)),
    setFullscreenViewer: (open) => ipcRenderer.invoke('widget:set-fullscreen-viewer', Boolean(open)),
    moveBy: (dx, dy) => ipcRenderer.send('widget:move-by', {
        dx: Number(dx) || 0,
        dy: Number(dy) || 0
    }),
    snapToEdge: () => ipcRenderer.invoke('widget:snap-to-edge'),
    setAlwaysOnTop: (flag) => ipcRenderer.invoke('widget:set-always-on-top', Boolean(flag)),
    getAlwaysOnTop: () => ipcRenderer.invoke('widget:get-always-on-top'),
    getState: () => ipcRenderer.invoke('widget:get-state'),
    hideWidget: () => ipcRenderer.send('widget:hide'),
    showWidget: () => ipcRenderer.send('widget:show'),
    openExternalUrl: (url) => ipcRenderer.invoke('widget:open-external', String(url || '')),
    openSubtitleWindow: () => ipcRenderer.invoke('widget:open-subtitle'),
    closeSubtitleWindow: () => ipcRenderer.invoke('widget:close-subtitle'),
    updateSubtitleText: (payload) => ipcRenderer.send('widget:update-subtitle', payload || {}),
    onSubtitleUpdate: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload || {});
        ipcRenderer.on('subtitle:update', listener);
        return () => ipcRenderer.removeListener('subtitle:update', listener);
    },
    onShortcutToggle: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload || {});
        ipcRenderer.on('widget:shortcut-toggle', listener);
        return () => ipcRenderer.removeListener('widget:shortcut-toggle', listener);
    }
});
