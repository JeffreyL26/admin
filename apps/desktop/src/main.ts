import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { DEFAULT_VARIANT_ID, MIN_SERVER_VERSION, isAtLeast, variantById } from '@ohrganize/shared';
import { StartupError } from './startupError';
import {
  PIN_STORE_FILE,
  createCertificateVerifyProc,
  createPinningAgent,
  findPinMismatch,
  pinMismatchMessage,
  readConfiguredPins,
  rememberPin,
  resolvePinPolicy,
  type ConfiguredPins,
  type PinPolicy,
  type ServerPinInfo,
} from './serverPinning';

// Dev-Modus: Renderer kommt vom Vite-Dev-Server, Backend läuft separat (tsx watch).
// Prod-Modus: Backend wird im Main-Prozess eingebettet gestartet (zufälliger Port),
// Renderer wird als gebauter Build über das eigene Schema ohrganize://app geladen.
const devServerUrl = process.env.ELECTRON_START_URL;
const isDev = Boolean(devServerUrl);

// Variante dieser App: scripts/build.mjs kompiliert OHRGANIZE_VARIANT als
// Literal ein (define); im Dev-Betrieb gilt die Vorgabe des Registers. Der
// Marker haelt die Zeichenkette fuer scripts/check-variant.mjs im Bundle.
declare const __OHRGANIZE_VARIANT_MARKER__: string | undefined;
const VARIANT = variantById(process.env.OHRGANIZE_VARIANT?.trim() || DEFAULT_VARIANT_ID);
const VARIANT_MARKER = typeof __OHRGANIZE_VARIANT_MARKER__ === 'string' ? __OHRGANIZE_VARIANT_MARKER__ : `OHRGANIZE_VARIANT:${VARIANT.id}`;

let mainWindow: BrowserWindow | null = null;

// Schlüssel-Pinning (nur Server-Betrieb über https, siehe serverPinning.ts):
// Richtlinie steht nach der Start-Prüfung fest, der beobachtete Schlüssel
// stammt aus genau dieser Verbindung. `pinLearnedNow` löst den einmaligen
// Hinweis nach dem Fensteraufbau aus; `pinPersistError` hält fest, wenn der
// gelernte Schlüssel nicht auf die Platte kam (dann wird der Hinweis zur
// Warnung — der Start geht weiter, geprüft ist die Identität ja).
let pinPolicy: PinPolicy | null = null;
let observedServerPin: string | null = null;
let pinLearnedNow = false;
let pinPersistError: string | null = null;

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
// benennbare Herkunft: `ohrganize://app`. Genau dieser eine Wert gehört im
// Server-Betrieb in OHRGANIZE_CORS_ORIGIN — neben der Portal-Domain.
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
const APP_SCHEME = 'ohrganize';
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
 * Bedient ohrganize://app/* aus dem entpackten Renderer-Verzeichnis.
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
    // Nur der eine Host wird bedient; ohrganize://irgendwas/ ist kein Treffer.
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
//   OHRGANIZE_API_BASE=https://portal.firma.de        (skriptierter Rollout)
//   %APPDATA%\oHRganize\config.json → { "apiBaseUrl": "…" }  (IT-Konfiguration)
// Ohne Konfiguration bleibt es beim eingebetteten Backend mit lokaler
// Datenbank — der Einzelplatz-Betrieb ändert sich dadurch nicht.
//
// Optional dazu der öffentliche Schlüssel des Servers (serverPinning.ts):
//   OHRGANIZE_SERVER_KEY_PINS=sha256/…,sha256/…       (kommagetrennt)
//   config.json → { "serverKeyPins": ["sha256/…"] }
// Ohne Eintrag merkt sich die App den Schlüssel beim ersten Kontakt.
function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function pinStorePath(): string {
  return path.join(app.getPath('userData'), PIN_STORE_FILE);
}

interface DesktopConfig {
  apiBaseUrl: string | null;
  /** null = nichts konfiguriert (Trust on first use); sonst Pins samt wirksamer Quelle. */
  serverKeyPins: ConfiguredPins | null;
}

type RawDesktopConfig = { apiBaseUrl?: unknown; serverKeyPins?: unknown };

/**
 * config.json einlesen. Alle Fehler sind StartupError: Eine unlesbare oder
 * fehlerhafte Datei ist ein Konfigurationszustand, den der Satz mit Dateipfad
 * erklären muss — kein Absturz, vor dem ein Stacktrace stünde.
 */
function parseConfigFile(cfgPath: string): RawDesktopConfig {
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} konnte nicht gelesen werden (${code}).`);
  }
  let raw: unknown;
  try {
    // Windows-Editoren und Windows PowerShell 5.1 (`Set-Content -Encoding utf8`)
    // stellen eine UTF-8-BOM voran; JSON.parse lehnt sie als ungültiges
    // Zeichen ab. Sie ist kein Inhalt, also weg damit.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} enthält kein gültiges JSON.`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} muss ein JSON-Objekt enthalten.`);
  }
  return raw as RawDesktopConfig;
}

/**
 * config.json wird genau EINMAL gelesen — auch wenn OHRGANIZE_API_BASE die
 * Adresse vorgibt, können die Pins in der Datei stehen.
 *
 * Eine defekte Datei ist nur dann tödlich, wenn sie gebraucht wird: Ohne
 * Umgebungsvariable ist sie die einzige Quelle der Adresse, und sie still zu
 * übergehen hieße, den Arbeitsplatz unbemerkt mit eingebettetem Backend und
 * leerer lokaler Datenbank zu starten. Gibt OHRGANIZE_API_BASE die Adresse
 * vor, wäre die Datei nur noch für Pins zuständig — dann Warnung statt
 * Abbruch (so lief die Konstellation auch vor dieser Fassung: die Datei wurde
 * gar nicht gelesen); Pins aus OHRGANIZE_SERVER_KEY_PINS gelten weiterhin,
 * sonst greift Trust on first use.
 */
function readDesktopConfig(): DesktopConfig {
  const cfgPath = configFilePath();
  const fromEnv = process.env.OHRGANIZE_API_BASE?.trim() || null;
  let parsed: RawDesktopConfig = {};
  if (fs.existsSync(cfgPath)) {
    try {
      parsed = parseConfigFile(cfgPath);
    } catch (err) {
      if (!fromEnv || !(err instanceof StartupError)) throw err;
      console.warn(
        `[oHRganize] ${err.message} Die Datei wird übersprungen, weil OHRGANIZE_API_BASE die Adresse vorgibt — ` +
          `dort hinterlegte serverKeyPins bleiben unberücksichtigt.`,
      );
    }
  }

  let apiBaseUrl: string | null;
  if (fromEnv) {
    apiBaseUrl = fromEnv;
  } else {
    const value = parsed.apiBaseUrl;
    if (value == null || value === '') {
      apiBaseUrl = null;
    } else if (typeof value !== 'string') {
      throw new StartupError(`"apiBaseUrl" in ${cfgPath} muss eine Zeichenkette sein.`);
    } else {
      apiBaseUrl = value.trim();
    }
  }

  return { apiBaseUrl, serverKeyPins: readConfiguredPins(parsed.serverKeyPins, cfgPath) };
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
    throw new StartupError(`"${raw}" ist keine gültige Backend-Adresse (erwartet z. B. https://portal.firma.de).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StartupError(`"${raw}" muss mit http:// oder https:// beginnen.`);
  }
  // Klartext gegen einen fremden Host wird abgelehnt, nicht nur bemängelt:
  // Über diese Verbindung laufen Anmeldedaten, das Sitzungstoken und sämtliche
  // Personaldaten. Ein einmal falsch ausgerollter http://-Eintrag würde das
  // dauerhaft und unbemerkt offen durch das Firmennetz schicken — mitlesbar für
  // jeden im selben Netzsegment. StartupError statt Error (wie bei den beiden
  // Prüfungen davor): Eine falsch eingetragene Adresse ist ein
  // Konfigurationszustand, den der Satz erklären muss, kein Absturz — ein
  // Stacktrace davor würde die Meldung nur verdecken.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new StartupError(
      `Die Backend-Adresse "${raw}" verwendet unverschlüsseltes http://.\n\n` +
        `Über diese Verbindung laufen Anmeldedaten, Zugangstoken und Personaldaten. ` +
        `Im Netzbetrieb ist deshalb https:// vorgeschrieben; http:// bleibt allein ` +
        `lokalen Testadressen (localhost, 127.0.0.1, ::1) vorbehalten.\n\n` +
        `Bitte tragen Sie die Adresse mit https:// ein (z. B. https://portal.firma.de) — in\n` +
        `${configFilePath()}\nbzw. in der Umgebungsvariable OHRGANIZE_API_BASE.`,
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
    'Der Server ist erreichbar, weist die Verbindung auf diesem Port aber ab. Läuft der oHRganize-Dienst, und stimmt der Port in der Adresse?',
  ETIMEDOUT:
    'Der Server antwortet nicht innerhalb der Wartezeit. Meist blockiert eine Firewall oder ein Proxy den Port, oder die Adresse gehört zu einem nicht erreichbaren Netz.',
};

/**
 * Zerlegt einen fehlgeschlagenen Verbindungsaufbau in lesbare Ursache + Hinweis.
 *
 * http/https.request liefern den Fehler samt `.code` direkt; werden mehrere
 * IP-Adressen probiert (A- und AAAA-Record), ist es ein AggregateError,
 * dessen erster Eintrag den aussagekräftigen Code trägt. Deshalb die Kette
 * (cause/errors) entlanglaufen statt nur eine Ebene tief zu schauen; die
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

/**
 * GET mit JSON-Antwort über node:http/https statt über das globale fetch.
 *
 * WARUM: Das globale fetch im Main-Prozess ist Nodes undici, nicht Chromium —
 * es kennt weder session.setCertificateVerifyProc noch eine Möglichkeit, den
 * Serverschlüssel zu prüfen, ohne undici selbst zu bündeln. https.request
 * nimmt dagegen einen Agent mit checkServerIdentity an; für http (nur
 * Loopback) läuft dieselbe Funktion ohne Agent. Weiterleitungen werden bewusst
 * nicht verfolgt: Eine Umleitung auf einen anderen Host liefe am Pin vorbei.
 */
function fetchJson(target: URL, agent: http.Agent | undefined, timeoutMs: number): Promise<unknown> {
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      { method: 'GET', agent, timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Die Antwort ist kein JSON.'));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`keine Antwort innerhalb von ${timeoutMs / 1000} s`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Früh und mit klarer Meldung scheitern statt mit leerem Fenster: ein nicht
// erreichbares Backend ist im Server-Betrieb der wahrscheinlichste Fehler.
// Im https-Betrieb prüft dieselbe Verbindung den Serverschlüssel (policy) —
// ein fremder Schlüssel ist ein eigener, immer tödlicher Startabbruch.
async function assertReachable(base: string, policy: PinPolicy | null): Promise<void> {
  let health: { version?: unknown; variant?: { id?: unknown; label?: unknown } };
  try {
    const agent = policy
      ? createPinningAgent(policy, (pin) => {
          observedServerPin = pin;
        })
      : undefined;
    health = (await fetchJson(new URL(`${base}/api/health`), agent, 10_000)) as {
      version?: unknown;
      variant?: { id?: unknown; label?: unknown };
    };
  } catch (err) {
    const mismatch = findPinMismatch(err);
    if (mismatch) throw new StartupError(pinMismatchMessage(mismatch.policy, mismatch.observed));

    const { reason, hint } = describeConnectionFailure(err);
    throw new StartupError(
      `Das oHRganize-Backend unter ${base} ist nicht erreichbar (${reason}).\n\n` +
        (hint ? `${hint}\n\n` : '') +
        `Prüfen Sie, ob der Dienst läuft und ob die Adresse in\n${configFilePath()}\n` +
        `bzw. in der Umgebungsvariable OHRGANIZE_API_BASE stimmt.`,
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

  // Variantenabgleich: Server und App muessen dieselbe Ausgabe (Land x
  // Edition) sein, sonst fehlen der App Seiten, die der Server kennt, oder
  // umgekehrt. Ein Server ohne Variantenangabe ist aelter als diese App.
  const serverVariant = typeof health.variant?.id === 'string' ? health.variant.id : null;
  if (serverVariant === null) {
    throw new StartupError(
      `Das Backend unter ${base} meldet keine Variante und ist damit älter als diese App (${VARIANT.label}).\n\n` +
        `Bitte spielen Sie zuerst das Server-Update ein.`,
    );
  }
  if (serverVariant !== VARIANT.id) {
    const serverLabel = typeof health.variant?.label === 'string' ? health.variant.label : serverVariant;
    throw new StartupError(
      `Der Server unter ${base} ist die Ausgabe ${serverLabel} (${serverVariant}), diese App ist ` +
        `${VARIANT.label} (${VARIANT.id}).\n\n` +
        `Bitte installieren Sie den Installer der passenden Ausgabe (der Name endet auf -${serverVariant}).`,
    );
  }
}

async function startBackend(): Promise<string> {
  if (isDev) return 'http://127.0.0.1:3001';

  const config = readDesktopConfig();
  if (config.apiBaseUrl) {
    const base = normalizeApiBase(config.apiBaseUrl);
    // Pinning nur über https: Lokale http-Testadressen tragen kein TLS.
    if (new URL(base).protocol === 'https:') {
      pinPolicy = resolvePinPolicy(base, config.serverKeyPins, pinStorePath(), configFilePath());
      // Der Pinning-Agent setzt rejectUnauthorized ausdrücklich (serverPinning.ts)
      // und übergeht damit diese Variable. Trotzdem sichtbar machen: Die IT
      // soll wissen, warum ihre maschinenweite Vorgabe hier nicht greift.
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        console.warn(
          '[oHRganize] NODE_TLS_REJECT_UNAUTHORIZED=0 ist gesetzt und wird für die Verbindung zum ' +
            'oHRganize-Server ignoriert — Zertifikatskette und Serverschlüssel werden immer geprüft.',
        );
      }
    } else if (config.serverKeyPins) {
      console.warn(`[oHRganize] serverKeyPins werden für ${base} ignoriert — Schlüssel-Pinning gilt nur für https://.`);
    }

    await assertReachable(base, pinPolicy);

    // Trust on first use: erster Kontakt ohne Konfiguration — Schlüssel merken.
    if (pinPolicy && pinPolicy.source === null) {
      if (!observedServerPin) {
        // Kann nach erfolgreicher Prüfung nicht vorkommen (jede Verbindung
        // läuft durch checkServerIdentity) — trotzdem fail closed: Ohne
        // bekannten Schlüssel würde Chromium den API-Host anschließend ablehnen.
        throw new StartupError(
          `Der Schlüssel des Servers ${pinPolicy.origin} konnte nicht ermittelt werden. ` +
            `Bitte den Start wiederholen und bei erneutem Auftreten die IT verständigen.`,
        );
      }
      try {
        rememberPin(pinPolicy.storePath, pinPolicy.origin, observedServerPin);
        pinLearnedNow = true;
      } catch (err) {
        // Eine beschädigte Schlüsseldatei bleibt tödlich (siehe readPinStore);
        // hier geht es allein um das Schreiben.
        if (err instanceof StartupError) throw err;
        // Die Identität ist für diese Sitzung geprüft — nur das Gedächtnis
        // fehlt (Schreibschutz, gesperrte Datei, Virenscanner, Synchronisierung).
        // Kein Abbruch mit Stacktrace: Weiter mit dem gelernten Schlüssel im
        // Speicher (Chromium bekommt ihn über pinPolicy), aber sichtbar —
        // beim nächsten Start lernt die App erneut, der Schutz ab dem zweiten
        // Start greift bis dahin nicht.
        pinPersistError =
          (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
        console.warn(
          `[oHRganize] Serverschlüssel konnte nicht gespeichert werden (${pinPersistError}): ${pinPolicy.storePath}`,
        );
      }
      pinPolicy = { ...pinPolicy, pins: [observedServerPin], source: 'learned' };
    }
    return base;
  } else if (config.serverKeyPins) {
    console.warn('[oHRganize] serverKeyPins ohne apiBaseUrl werden ignoriert — das eingebettete Backend wird nie gepinnt.');
  }

  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[oHRganize] Variante ${VARIANT.id} (${VARIANT.label}) [${VARIANT_MARKER}]`);
  process.env.OHRGANIZE_DATA_DIR = dataDir;

  // Serverkonfiguration NICHT erben — hart überschreiben, bevor das Bundle
  // geladen wird (config.ts liest die Variablen beim Import).
  //
  // OHRGANIZE_HOST: Wer die Server-Doku auf einem Arbeitsplatz nachvollzieht oder
  // die Variable per Rollout-Skript systemweit setzt (z. B. 0.0.0.0), würde sonst
  // das eingebettete Backend an alle Netzwerkschnittstellen binden — die lokale
  // Personaldatenbank stünde offen im Firmennetz. Das eingebettete Backend hat
  // genau einen Nutzer: den Renderer im selben Prozessbaum.
  process.env.OHRGANIZE_HOST = '127.0.0.1';
  // OHRGANIZE_CORS_ORIGIN: Eine geerbte Server-Liste enthält die Portal-Domain,
  // aber nicht ohrganize://app — das eingebettete Backend würde seinen eigenen
  // Renderer aussperren (leeres Fenster, keine erkennbare Ursache). Auf
  // 127.0.0.1 ist die offene Voreinstellung unbedenklich (siehe config.ts).
  delete process.env.OHRGANIZE_CORS_ORIGIN;
  // OHRGANIZE_LICENSE_PUBLIC_KEY: Test-Override der Lizenzprüfung. Das
  // Produktionsbundle ignoriert die Variable bereits (esbuild --define in
  // apps/backend/package.json); hier zusätzlich löschen, damit auch ein
  // Dev-Bundle einen per Benutzerumgebung eingeschleusten Prüfschlüssel nie
  // sieht — ein Nutzer ohne Adminrechte kann Benutzervariablen setzen.
  delete process.env.OHRGANIZE_LICENSE_PUBLIC_KEY;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startServer } = require(path.join(__dirname, 'server.cjs')) as {
    startServer: (port?: number) => Promise<{ port: number }>;
  };
  try {
    const { port } = await startServer(0);
    return `http://127.0.0.1:${port}`;
  } catch (err) {
    // Mit der Verschlüsselung im Ruhezustand sind Startabbrüche Zustände, die ein
    // Satz erklärt (Schlüssel fehlt oder passt nicht, Prüfung nach der Umstellung
    // gescheitert, SQLite-Modul kann nicht verschlüsseln). Der Dialog soll nur
    // diesen Satz zeigen, nicht einen Stacktrace aus dem Bundle; der Stack geht
    // ins Log. Programmierfehler behalten ihren Stack.
    console.error('[oHRganize] Das Backend ist nicht gestartet:', err);
    const programmingError =
      err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError;
    if (err instanceof Error && !programmingError) throw new StartupError(err.message);
    throw err;
  }
}

async function createWindow(apiBaseUrl: string): Promise<void> {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'oHRganize',
    backgroundColor: '#0f2f5f',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    // Rahmenlos: oHRganize bringt seine eigene, zur UI passende Titelleiste mit.
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
        `--ohrganize-api-base=${apiBaseUrl}`,
        // app.getVersion() liest die Version aus der gepackten package.json.
        // Das Preload kann das nicht selbst: Dort ist npm_package_version nur
        // im Dev-Betrieb gesetzt und in der installierten App leer.
        `--ohrganize-app-version=${app.getVersion()}`,
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

  // Serverschlüssel für eine spätere Einstellungsseite: nur Auskunft, keine
  // Änderung — die Pins verwaltet die IT über config.json bzw. die Datei der
  // gemerkten Schlüssel, nicht der Renderer.
  ipcMain.handle('app:server-pin', (): ServerPinInfo => ({
    origin: pinPolicy?.origin ?? null,
    pin: observedServerPin,
    source: pinPolicy?.source ?? null,
    configuredPins: pinPolicy?.source === 'configured' ? [...pinPolicy.pins] : [],
    storePath: pinPolicy?.storePath ?? null,
  }));
}

/**
 * Einmaliger, nicht blockierender Hinweis nach dem ersten Kontakt: Die App
 * hat sich den Serverschlüssel gemerkt — oder konnte ihn nicht ablegen, dann
 * wird daraus eine Warnung. Am Fenster verankert, damit er nicht hinter dem
 * Hauptfenster verschwindet; nicht awaited, damit der Start nicht am Klick
 * hängt.
 */
function showPinLearnedNotice(): void {
  if (!pinPolicy || !observedServerPin) return;
  let options: Electron.MessageBoxOptions;
  if (pinPersistError) {
    options = {
      type: 'warning',
      title: 'Serverschlüssel nicht gespeichert',
      message:
        `Der Serverschlüssel ${observedServerPin} wurde geprüft, konnte aber nicht gespeichert werden ` +
        `(${pinPersistError}). Die App merkt ihn sich nur für diese Sitzung; beim nächsten Start wird er erneut gelernt.`,
      detail:
        `Server: ${pinPolicy.origin}\nDatei: ${pinPolicy.storePath}\n\n` +
        `Bitte prüfen, ob die Datei bzw. der Ordner beschreibbar ist (Schreibschutz, Virenscanner, ` +
        `Synchronisierung), und bei Wiederholung die IT verständigen.`,
      buttons: ['OK'],
    };
    pinPersistError = null;
  } else if (pinLearnedNow) {
    pinLearnedNow = false;
    options = {
      type: 'info',
      title: 'Serverschlüssel gemerkt',
      message: `Serverschlüssel gemerkt: ${observedServerPin}. Bei einem späteren Wechsel warnt die App.`,
      detail: `Server: ${pinPolicy.origin}\nAblage: ${pinPolicy.storePath}`,
      buttons: ['OK'],
    };
  } else {
    return;
  }
  void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
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
      // Zertifikatsprüfung mit Schlüssel-Pinning VOR der ersten TLS-Anfrage
      // aus Chromium installieren (das Ergebnis wird je Zertifikat gecacht).
      // Die Richtlinie liest der Proc über den Getter: Sie steht erst nach
      // startBackend fest, die erste Renderer-Anfrage kommt aber erst nach
      // createWindow. Ohne Richtlinie (Einzelplatz, Dev, http) gilt
      // Chromiums Standardprüfung unverändert.
      session.defaultSession.setCertificateVerifyProc(createCertificateVerifyProc(() => pinPolicy));
      const apiBaseUrl = await startBackend();
      ipcMain.handle('ohrganize:apiBaseUrl', () => apiBaseUrl);
      await createWindow(apiBaseUrl);
      showPinLearnedNotice();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow(apiBaseUrl);
      });
    } catch (err) {
      dialog.showErrorBox(
        'oHRganize konnte nicht gestartet werden',
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
