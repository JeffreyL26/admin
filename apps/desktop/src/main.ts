import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { buildMenu } from './menu';

// Dev-Modus: Renderer kommt vom Vite-Dev-Server, Backend läuft separat (tsx watch).
// Prod-Modus: Backend wird im Main-Prozess eingebettet gestartet (zufälliger Port),
// Renderer wird als gebauter Build über file:// geladen.
const devServerUrl = process.env.ELECTRON_START_URL;
const isDev = Boolean(devServerUrl);

let mainWindow: BrowserWindow | null = null;

async function startBackend(): Promise<string> {
  if (isDev) return 'http://127.0.0.1:3001';
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.HRMONIC_DATA_DIR = dataDir;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startServer } = require(path.join(__dirname, 'server.cjs')) as {
    startServer: (port?: number) => Promise<{ port: number }>;
  };
  const { port } = await startServer(0);
  return `http://127.0.0.1:${port}`;
}

async function createWindow(apiBaseUrl: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'HRMONIC',
    backgroundColor: '#f5f7fb',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--hrmonic-api-base=${apiBaseUrl}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  buildMenu({
    isDev,
    navigate: (route) => mainWindow?.webContents.send('menu:navigate', route),
    about: () => {
      dialog.showMessageBox({
        type: 'info',
        title: 'Über HRMONIC',
        message: 'HRMONIC',
        detail: `HR-Verwaltung für den deutschsprachigen Markt\nVersion ${app.getVersion()}\n\n© ${new Date().getFullYear()} HRMONIC`,
      });
    },
  });

  if (isDev) {
    await mainWindow.loadURL(devServerUrl!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

// Nur eine Instanz der App zulassen (zweiter Start fokussiert das Fenster).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const apiBaseUrl = await startBackend();
      ipcMain.handle('hrmonic:apiBaseUrl', () => apiBaseUrl);
      await createWindow(apiBaseUrl);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow(apiBaseUrl);
      });
    } catch (err) {
      dialog.showErrorBox(
        'HRMONIC konnte nicht gestartet werden',
        err instanceof Error ? err.stack ?? err.message : String(err),
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
