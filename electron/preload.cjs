const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vdxDesktop', {
  isDesktop: true,
  readClipboardText: () => ipcRenderer.invoke('vdx:clipboard-read-text'),
  writeClipboardText: (value) => ipcRenderer.invoke('vdx:clipboard-write-text', value),
  getAppVersion: () => ipcRenderer.invoke('vdx:get-app-version'),
  openExternalUrl: (url) => ipcRenderer.invoke('vdx:open-external', url),
  openFolderPath: (folderPath) => ipcRenderer.invoke('vdx:open-folder', folderPath),
  onClipboardUrl: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // Renderer callback errors should not break preload.
      }
    };
    ipcRenderer.on('vdx:clipboard-url', handler);
    return () => ipcRenderer.removeListener('vdx:clipboard-url', handler);
  },
});
