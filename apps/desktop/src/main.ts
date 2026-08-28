import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// Dev-Modus: Renderer kommt vom Vite-Dev-Server, Backend läuft separat (tsx watch).
// Prod-Modus: Backend wird im Main-Prozess eingebettet gestartet (zufälliger Port),
// Renderer wird als gebauter Build über file:// geladen.
const devServerUrl = process.env.ELECTRON_START_URL;
const isDev = Boolean(devServerUrl);

let mainWindow: BrowserWindow | null = null;

// Gemeinsames Backend (Mehrplatz-/Server-Betrieb): Ist eine Basis-URL
// konfiguriert, startet die App KEIN eigenes Backend, sondern arbeitet auf
// demselben Server wie das Mitarbeitenden-Portal — beide Clients sehen damit
// dieselben Daten. Zwei Quellen, Umgebungsvariable schlägt Datei:
//   HRMONIC_API_BASE=https://portal.firma.de        (skriptierter Rollout)
//   %APPDATA%\HRMONIC\config.json → { "apiBaseUrl": "…" }  (IT-Konfiguration)
// Ohne Konfiguration bleibt es beim eingebetteten Backend mit lokaler
// Datenbank — der Einzelplatz-Betrieb ändert sich dadurch nicht.
function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfiguredApiBase(): string | null {
  const fromEnv = process.env.HRMONIC_API_BASE?.trim();
  if (fromEnv) return fromEnv;

  const cfgPath = configFilePath();
  if (!fs.existsSync(cfgPath)) return null;
  let parsed: { apiBaseUrl?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { apiBaseUrl?: unknown };
  } catch {
    throw new Error(`Die Konfigurationsdatei ${cfgPath} enthält kein gültiges JSON.`);
  }
  const value = parsed.apiBaseUrl;
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`"apiBaseUrl" in ${cfgPath} muss eine Zeichenkette sein.`);
  }
  return value.trim();
}

// Trailing Slash entfernen: der Renderer hängt Pfade wie "/api/…" direkt an.
function normalizeApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" ist keine gültige Backend-Adresse (erwartet z. B. https://portal.firma.de).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${raw}" muss mit http:// oder https:// beginnen.`);
  }
  return raw.replace(/\/+$/, '');
}

// Früh und mit klarer Meldung scheitern statt mit leerem Fenster: ein nicht
// erreichbares Backend ist im Server-Betrieb der wahrscheinlichste Fehler.
async function assertReachable(base: string): Promise<void> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Das HRMONIC-Backend unter ${base} ist nicht erreichbar (${reason}).\n\n` +
        `Prüfen Sie, ob der Dienst läuft und ob die Adresse in\n${configFilePath()}\n` +
        `bzw. in der Umgebungsvariable HRMONIC_API_BASE stimmt.`,
    );
  }
}

async function startBackend(): Promise<string> {
  if (isDev) return 'http://127.0.0.1:3001';

  const configured = readConfiguredApiBase();
  if (configured) {
    const base = normalizeApiBase(configured);
    await assertReachable(base);
    return base;
  }

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
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'HRMONIC',
    backgroundColor: '#0f2f5f',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    // Rahmenlos: HRMONIC bringt seine eigene, zur UI passende Titelleiste mit.
    // Auf macOS bleiben die Ampel-Buttons erhalten (hiddenInset), auf Windows/
    // Linux zeichnet der Renderer eigene Fenster-Controls.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    frame: isMac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--hrmonic-api-base=${apiBaseUrl}`],
    },
  });

  // Windows/Linux: gar kein natives Menü — alle Aktionen laufen über die
  // eigene Titelleiste bzw. In-App-Shortcuts. macOS braucht ein App-Menü mit
  // Edit-Rollen, sonst funktionieren Cmd+C/V/X nicht (dort erscheint es in der
  // System-Menüleiste, nicht im Fenster, und stört die eigene UI nicht).
  if (isMac) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
          role: 'editMenu',
          label: 'Bearbeiten',
          submenu: [
            { role: 'undo', label: 'Rückgängig' },
            { role: 'redo', label: 'Wiederholen' },
            { type: 'separator' },
            { role: 'cut', label: 'Ausschneiden' },
            { role: 'copy', label: 'Kopieren' },
            { role: 'paste', label: 'Einfügen' },
            { role: 'selectAll', label: 'Alles auswählen' },
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  // Maximieren-Status an den Renderer melden, damit das Maximieren-Icon passt.
  const emitMax = () =>
    mainWindow?.webContents.send('window:maximized-changed', mainWindow.isMaximized());
  mainWindow.on('maximize', emitMax);
  mainWindow.on('unmaximize', emitMax);
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:fullscreen-changed', false));

  if (isDev) {
    await mainWindow.loadURL(devServerUrl!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

// ---------------------------------------------------------------------------
// IPC: Fenster-Controls und App-Aktionen (früher das native Menü)
// ---------------------------------------------------------------------------
function winOf(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

function registerIpc(): void {
  ipcMain.on('window:minimize', (e) => winOf(e)?.minimize());
  ipcMain.on('window:toggle-maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on('window:close', (e) => winOf(e)?.close());
  ipcMain.handle('window:is-maximized', (e) => winOf(e)?.isMaximized() ?? false);

  ipcMain.on('app:reload', (e) => winOf(e)?.webContents.reload());
  ipcMain.on('app:toggle-devtools', (e) => winOf(e)?.webContents.toggleDevTools());
  ipcMain.on('app:toggle-fullscreen', (e) => {
    const w = winOf(e);
    w?.setFullScreen(!w.isFullScreen());
  });
  ipcMain.on('app:zoom', (e, delta: number) => {
    const wc = winOf(e)?.webContents;
    if (!wc) return;
    if (delta === 0) wc.setZoomLevel(0);
    else wc.setZoomLevel(Math.max(-3, Math.min(4, wc.getZoomLevel() + delta)));
  });
  ipcMain.on('app:open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
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
      registerIpc();
      const apiBaseUrl = await startBackend();
      ipcMain.handle('hrmonic:apiBaseUrl', () => apiBaseUrl);
      await createWindow(apiBaseUrl);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow(apiBaseUrl);
      });
    } catch (err) {
      const { dialog } = await import('electron');
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
