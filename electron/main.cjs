const { app, BrowserWindow, shell, clipboard, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let serverHandle = null;
let trustedAppOrigin = null;
let mainWindow = null;

const parseClipboardUrl = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;

  const tryParse = (candidate) => {
    const value = String(candidate || '').trim();
    if (!/^https?:\/\//i.test(value)) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.hostname === 'localhost') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) return direct;

  for (const line of text.split(/\r?\n/)) {
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }

  return null;
};

const notifyClipboardUrl = (win, source) => {
  if (!win || win.isDestroyed()) return;
  const url = parseClipboardUrl(clipboard.readText());
  if (!url) return;
  win.webContents.send('vdx:clipboard-url', { url, source });
};

const attachClipboardListeners = (win) => {
  const emit = (source) => notifyClipboardUrl(win, source);
  win.on('focus', () => emit('focus'));
  win.on('show', () => emit('restore'));
  win.webContents.on('did-finish-load', () => emit('launch'));
};

function configureDesktopRuntime() {
  const appRoot = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
  process.env.VDX_APP_ROOT = appRoot;
  process.env.VDX_RESOURCES_PATH = process.resourcesPath;
  if (app.isPackaged) {
    process.chdir(path.dirname(appRoot));
  }
}

async function startBundledServer() {
  if (process.env.VDX_SERVER_URL) return process.env.VDX_SERVER_URL;

  configureDesktopRuntime();
  process.env.NODE_ENV = 'production';
  process.env.VDX_SKIP_AUTOSTART = '1';

  const serverBundle = path.join(__dirname, '..', 'desktop', 'server.mjs');
  const serverModule = await import(pathToFileURL(serverBundle).href);
  serverHandle = await serverModule.startServer();
  return serverHandle.url;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#fafafa',
    title: 'Creative Asset Extractor',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      disableBlinkFeatures: 'IntensiveWakeUpThrottling',
    },
  });
  mainWindow = win;
  attachClipboardListeners(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!trustedAppOrigin) return;
    try {
      const destination = new URL(navigationUrl);
      if (destination.origin !== trustedAppOrigin) {
        event.preventDefault();
        shell.openExternal(navigationUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  try {
    const localUrl = await startBundledServer();
    trustedAppOrigin = new URL(localUrl).origin;
    await win.loadURL(localUrl);
  } catch (error) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 48px; color: #18181b;">
        <h1>Creative Asset Extractor could not start</h1>
        <p>Please close the app and open it again. If the problem continues, download a fresh copy of the DMG.</p>
        <p style="color:#71717a;font-size:14px;">${String(error?.message || error || 'Unknown startup error')}</p>
      </body>
    `)}`);
  }
}

ipcMain.handle('vdx:clipboard-read-text', () => clipboard.readText());
ipcMain.handle('vdx:get-app-version', () => app.getVersion());
ipcMain.handle('vdx:open-external', async (_event, url) => {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return false;
  await shell.openExternal(target);
  return true;
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  mainWindow = null;
  serverHandle?.server?.close?.();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    notifyClipboardUrl(mainWindow, 'restore');
  }
});
