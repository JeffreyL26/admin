import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MIN_SERVER_VERSION, isAtLeast } from '@hrmonic/shared';

// Dev-Modus: Renderer kommt vom Vite-Dev-Server, Backend läuft separat (tsx watch).
// Prod-Modus: Backend wird im Main-Prozess eingebettet gestartet (zufälliger Port),
// Renderer wird als gebauter Build über das eigene Schema hrmonic://app geladen.
const devServerUrl = process.env.ELECTRON_START_URL;
const isDev = Boolean(devServerUrl);

let mainWindow: BrowserWindow | null = null;

/**
 * Startabbruch mit einer für Nutzer gedachten Meldung. Der Fehlerdialog zeigt
 * für diese Klasse nur den Text: Ein nicht erreichbarer oder zu alter Server
 * ist kein Absturz, sondern ein Zustand, den der Satz erklären muss — ein
 * Stacktrace davor macht ihn für die Person am Arbeitsplatz unlesbar.
 */
class StartupError extends Error {}

// ---------------------------------------------------------------------------
// Eigenes App-Schema statt file://
// ---------------------------------------------------------------------------
// WARUM (bitte nicht auf loadFile zurückdrehen): Eine über file:// geladene
// Seite hat eine *opake* Herkunft und sendet deshalb `Origin: null`. Damit das
// Backend sie akzeptiert, müsste in der CORS-Liste der Wert "null" stehen — und
// "null" ist der Sammelwert JEDER opaken Herkunft (sandboxed iframe, data:,
// beliebige fremde Seite). Eine Whitelist mit "null" ist so durchlässig wie gar
// keine. Das Backend filtert "null" deshalb aktiv heraus.
//
// Mit einem als `standard` registrierten Schema bekommt der Renderer eine echte,
// benennbare Herkunft: `hrmonic://app`. Genau dieser eine Wert gehört im
// Server-Betrieb in HRMONIC_CORS_ORIGIN — neben der Portal-Domain.
//
// Die Privilegien im Einzelnen:
//   standard        — echte Herkunft (Host + Pfad), Voraussetzung für den
//                     Origin-Header, für localStorage und für relative Pfade
//                     (Vite baut mit base: './').
//   secure          — als vertrauenswürdig behandeln, wie bisher file://;
//                     sonst blockiert Chromium z. B. Web-Crypto und meldet die
//                     Seite als unsicheren Kontext.
//   supportFetchAPI — fetch()/ES-Module dürfen aus diesem Schema laden
//                     (der Vite-Build lädt sein Bundle als <script type=module>).
const APP_SCHEME = 'hrmonic';
const APP_HOST = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

// Muss VOR app.whenReady() laufen — danach ignoriert Chromium die Registrierung.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// Explizite MIME-Typen: Chromium lehnt ES-Module mit falschem Content-Type
// strikt ab (dann bleibt das Fenster weiß). Nur die Typen, die der
// Renderer-Build tatsächlich erzeugt.
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function notFound(): Response {
  return new Response('Nicht gefunden', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Bedient hrmonic://app/* aus dem entpackten Renderer-Verzeichnis.
 *
 * Pfad-Sicherheit: Das Schema ist zwar nur für den eigenen Renderer erreichbar,
 * die Auflösung bleibt trotzdem strikt eingesperrt — sonst wäre jede künftige
 * Stelle, die eine URL aus fremden Daten zusammensetzt (Anhangsname, Vorlage),
 * ein Leseprimitiv auf das gesamte Dateisystem des Arbeitsplatzes:
 *   1. Prozentkodierung erst dekodieren, DANN auflösen — sonst schmuggelt
 *      "%2e%2e%2f" ein ".." am URL-Parser vorbei.
 *   2. Nach dem Auflösen prüfen, dass das Ziel unterhalb des Wurzelverzeichnisses
 *      liegt (verhindert "..").
 *   3. realpath und erneut prüfen (verhindert Ausbruch über einen Symlink oder
 *      NTFS-Junction im Installationsverzeichnis).
 * Muss NACH app.whenReady() aufgerufen werden.
 */
function registerAppProtocol(): void {
  const rendererDir = path.join(__dirname, 'renderer');
  // Wurzel selbst auflösen: Das Installationsverzeichnis kann hinter einer
  // Junction liegen (OneDrive, umgeleitete Programmordner) — sonst schlüge der
  // realpath-Vergleich in Schritt 3 für jede reguläre Datei fehl.
  let root: string;
  try {
    root = fs.realpathSync(rendererDir);
  } catch {
    root = path.resolve(rendererDir);
  }

  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    // Nur der eine Host wird bedient; hrmonic://irgendwas/ ist kein Treffer.
    if (url.host !== APP_HOST) return notFound();

    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      return notFound(); // defektes Prozent-Escape
    }
    if (relative === '' || relative === '/') relative = '/index.html';
    // NUL-Bytes schneiden Pfade in nativen APIs ab und lösen sonst einen
    // ERR_INVALID_ARG_VALUE mit Stacktrace aus.
    if (relative.includes('\0')) return notFound();

    const target = path.resolve(root, `.${relative}`);
    if (target !== root && !target.startsWith(root + path.sep)) return notFound();

    let real: string;
    try {
      real = fs.realpathSync(target);
      if (!fs.statSync(real).isFile()) return notFound();
    } catch {
      return notFound();
    }
    if (real !== root && !real.startsWith(root + path.sep)) return notFound();

    const response = await net.fetch(pathToFileURL(real).toString());
    const mime = MIME_TYPES[path.extname(real).toLowerCase()];
    if (!mime) return response;
    const headers = new Headers(response.headers);
    headers.set('content-type', mime);
    return new Response(response.body, { status: response.status, headers });
  });
}

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

/**
 * Adressen, die den eigenen Rechner meinen. Nur für sie bleibt Klartext-HTTP
 * erlaubt: Dort verlässt der Verkehr die Maschine nicht, und genau so ist der
 * lokale Testbetrieb dokumentiert (docs/web-portal.md). `new URL()` liefert
 * IPv6-Hostnamen in eckigen Klammern zurück, deshalb stehen beide Schreibweisen
 * in der Liste.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // Nicht nur 127.0.0.1: Das gesamte Netz 127.0.0.0/8 zeigt auf den eigenen
  // Rechner, und manche Testaufbauten nutzen z. B. 127.0.0.2.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
  // Klartext gegen einen fremden Host wird abgelehnt, nicht nur bemängelt:
  // Über diese Verbindung laufen Anmeldedaten, das Sitzungstoken und sämtliche
  // Personaldaten. Ein einmal falsch ausgerollter http://-Eintrag würde das
  // dauerhaft und unbemerkt offen durch das Firmennetz schicken — mitlesbar für
  // jeden im selben Netzsegment. StartupError statt Error: Ein falsch
  // eingetragenes Schema ist ein Konfigurationszustand, den der Satz erklären
  // muss, kein Absturz — ein Stacktrace davor würde die Meldung nur verdecken.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new StartupError(
      `Die Backend-Adresse "${raw}" verwendet unverschlüsseltes http://.\n\n` +
        `Über diese Verbindung laufen Anmeldedaten, Zugangstoken und Personaldaten. ` +
        `Im Netzbetrieb ist deshalb https:// vorgeschrieben; http:// bleibt allein ` +
        `lokalen Testadressen (localhost, 127.0.0.1, ::1) vorbehalten.\n\n` +
        `Bitte tragen Sie die Adresse mit https:// ein (z. B. https://portal.firma.de) — in\n` +
        `${configFilePath()}\nbzw. in der Umgebungsvariable HRMONIC_API_BASE.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Klartext-Hinweise zu den Fehlercodes, die beim Verbindungsaufbau anfallen.
 *
 * WARUM als Tabelle: Am Telefon mit der IT ist "fetch failed" wertlos — ein
 * unbekannter DNS-Name, ein nicht vertrauenswürdiges Zertifikat, eine
 * blockierende Firewall und ein gestoppter Dienst sehen ohne diesen Hinweis
 * identisch aus. Die Tabelle bleibt bewusst erweiterbar: Ein neuer Code
 * bedeutet eine Zeile mehr, keine weitere Verzweigung im Meldungstext.
 */
const CONNECTION_HINTS: Record<string, string> = {
  // TLS: Zertifikatskette nicht prüfbar — auf Kundensystemen fast immer eine
  // interne CA, deren Wurzelzertifikat auf dem Arbeitsplatz fehlt.
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'Das Serverzertifikat konnte nicht überprüft werden. Ist das Wurzelzertifikat Ihrer internen Zertifizierungsstelle auf diesem Arbeitsplatz im Windows-Zertifikatsspeicher hinterlegt?',
  SELF_SIGNED_CERT_IN_CHAIN:
    'Die Zertifikatskette enthält ein selbst signiertes Zertifikat. Ist das Wurzelzertifikat Ihrer internen Zertifizierungsstelle auf diesem Arbeitsplatz im Windows-Zertifikatsspeicher hinterlegt?',
  DEPTH_ZERO_SELF_SIGNED_CERT:
    'Der Server verwendet ein selbst signiertes Zertifikat. Hinterlegen Sie dessen Wurzelzertifikat im Windows-Zertifikatsspeicher oder stellen Sie ein Zertifikat Ihrer internen Zertifizierungsstelle aus.',
  CERT_HAS_EXPIRED:
    'Das Serverzertifikat ist abgelaufen und muss auf dem Server erneuert werden.',
  ERR_TLS_CERT_ALTNAME_INVALID:
    'Das Serverzertifikat ist auf einen anderen Rechnernamen ausgestellt. Tragen Sie genau den Namen ein, für den das Zertifikat gilt.',
  // Namensauflösung
  ENOTFOUND:
    'Der Rechnername in der Adresse lässt sich nicht auflösen (DNS). Prüfen Sie die Schreibweise und ob der Arbeitsplatz im Firmennetz bzw. im VPN ist.',
  EAI_AGAIN:
    'Die Namensauflösung (DNS) antwortet nicht. Prüfen Sie die Netzwerkverbindung des Arbeitsplatzes und die Erreichbarkeit des DNS-Servers.',
  // Transport
  ECONNREFUSED:
    'Der Server ist erreichbar, weist die Verbindung auf diesem Port aber ab. Läuft der HRMONIC-Dienst, und stimmt der Port in der Adresse?',
  ETIMEDOUT:
    'Der Server antwortet nicht innerhalb der Wartezeit. Meist blockiert eine Firewall oder ein Proxy den Port, oder die Adresse gehört zu einem nicht erreichbaren Netz.',
};

/**
 * Zerlegt einen fehlgeschlagenen fetch-Aufruf in lesbare Ursache + Hinweis.
 *
 * Node reicht bei fetch nur eine Hülle mit der Meldung "fetch failed" heraus;
 * der echte Fehler samt `.code` steckt in `err.cause`. Werden mehrere IP-
 * Adressen probiert (A- und AAAA-Record), ist die Ursache zusätzlich ein
 * AggregateError, dessen erster Eintrag den aussagekräftigen Code trägt.
 * Deshalb die Kette entlanglaufen statt nur eine Ebene tief zu schauen; die
 * Tiefe ist begrenzt, damit eine zyklische Verkettung die Meldung nicht
 * aufbläht.
 */
function describeConnectionFailure(err: unknown): { reason: string; hint: string | null } {
  if (!(err instanceof Error)) return { reason: String(err), hint: null };

  const messages: string[] = [];
  let code: string | null = null;
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const step = current as Error & { code?: unknown; cause?: unknown; errors?: unknown };
    if (code === null && typeof step.code === 'string') code = step.code;
    const text = typeof step.code === 'string' ? `${step.code}: ${step.message}` : step.message;
    // Doppelte Texte weglassen: AggregateError wiederholt oft die Hüllmeldung.
    if (text && !messages.includes(text)) messages.push(text);
    current = step.cause ?? (Array.isArray(step.errors) ? step.errors[0] : undefined);
  }

  return {
    reason: messages.join(' — ') || err.message,
    hint: code ? (CONNECTION_HINTS[code] ?? null) : null,
  };
}

// Früh und mit klarer Meldung scheitern statt mit leerem Fenster: ein nicht
// erreichbares Backend ist im Server-Betrieb der wahrscheinlichste Fehler.
async function assertReachable(base: string): Promise<void> {
  let health: { version?: unknown };
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = (await res.json()) as { version?: unknown };
  } catch (err) {
    const { reason, hint } = describeConnectionFailure(err);
    throw new StartupError(
      `Das HRMONIC-Backend unter ${base} ist nicht erreichbar (${reason}).\n\n` +
        (hint ? `${hint}\n\n` : '') +
        `Prüfen Sie, ob der Dienst läuft und ob die Adresse in\n${configFilePath()}\n` +
        `bzw. in der Umgebungsvariable HRMONIC_API_BASE stimmt.`,
    );
  }

  // Gegenrichtung zum Client-Check im Backend: Hat sich diese App per Update
  // selbst überholt, während das Server-Update noch aussteht, bricht der Start
  // hier ab — sonst liefe sie gegen eine API, die ihre Felder noch nicht kennt.
  // Der Abgleich läuft nur im Serverbetrieb; beim eingebetteten Backend
  // stammen beide Seiten aus demselben Installer und können nicht driften.
  const serverVersion = typeof health.version === 'string' ? health.version : null;
  if (!serverVersion) {
    throw new StartupError(
      `Das Backend unter ${base} meldet keine Version und ist damit älter als diese App.\n\n` +
        `Bitte spielen Sie zuerst das Server-Update ein. Die Reihenfolge ist immer:\n` +
        `erst der Server, dann die Arbeitsplätze.`,
    );
  }
  if (!isAtLeast(serverVersion, MIN_SERVER_VERSION)) {
    throw new StartupError(
      `Das Backend unter ${base} läuft auf Version ${serverVersion}, diese App verlangt ` +
        `mindestens ${MIN_SERVER_VERSION} (App-Version: ${app.getVersion()}).\n\n` +
        `Bitte spielen Sie zuerst das Server-Update ein. Die Reihenfolge ist immer:\n` +
        `erst der Server, dann die Arbeitsplätze.`,
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

  // Serverkonfiguration NICHT erben — hart überschreiben, bevor das Bundle
  // geladen wird (config.ts liest die Variablen beim Import).
  //
  // HRMONIC_HOST: Wer die Server-Doku auf einem Arbeitsplatz nachvollzieht oder
  // die Variable per Rollout-Skript systemweit setzt (z. B. 0.0.0.0), würde sonst
  // das eingebettete Backend an alle Netzwerkschnittstellen binden — die lokale
  // Personaldatenbank stünde offen im Firmennetz. Das eingebettete Backend hat
  // genau einen Nutzer: den Renderer im selben Prozessbaum.
  process.env.HRMONIC_HOST = '127.0.0.1';
  // HRMONIC_CORS_ORIGIN: Eine geerbte Server-Liste enthält die Portal-Domain,
  // aber nicht hrmonic://app — das eingebettete Backend würde seinen eigenen
  // Renderer aussperren (leeres Fenster, keine erkennbare Ursache). Auf
  // 127.0.0.1 ist die offene Voreinstellung unbedenklich (siehe config.ts).
  delete process.env.HRMONIC_CORS_ORIGIN;

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
      additionalArguments: [
        `--hrmonic-api-base=${apiBaseUrl}`,
        // app.getVersion() liest die Version aus der gepackten package.json.
        // Das Preload kann das nicht selbst: Dort ist npm_package_version nur
        // im Dev-Betrieb gesetzt und in der installierten App leer.
        `--hrmonic-app-version=${app.getVersion()}`,
      ],
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
    // Kein loadFile: siehe Begründung am Schema oben. HashRouter bleibt richtig —
    // ein Deep-Link im Pfad hätte auch hier keinen Server, der ihn beantwortet.
    await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
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
      // Im Dev-Betrieb liefert der Vite-Server den Renderer aus; das
      // Verzeichnis dist/renderer existiert dort gar nicht.
      if (!isDev) registerAppProtocol();
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
        err instanceof StartupError
          ? err.message
          : err instanceof Error
            ? err.stack ?? err.message
            : String(err),
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
