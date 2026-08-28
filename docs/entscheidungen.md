# Architekturentscheidungen & Sackgassen

Festgehalten wird nicht nur *was* entschieden wurde, sondern *warum* — inklusive
verworfener Ansätze, damit niemand dieselben Wege doppelt geht.

## Desktop-Stack: Electron statt Tauri

**Entscheidung:** Electron + electron-builder (NSIS für Windows).

**Warum:** Tauri wäre schlanker, setzt aber eine Rust-Toolchain auf der
Build-Maschine voraus und hätte für das eingebettete Node-Backend ohnehin einen
Sidecar-Prozess gebraucht. Electron erlaubt es, das Fastify-Backend direkt im
Main-Prozess zu starten (ein Prozess weniger, ein Fehlerpfad weniger) und teilt
sich die Node-Laufzeit mit better-sqlite3.

## Datenbank: better-sqlite3 statt node:sqlite oder ORM

**Entscheidung:** better-sqlite3, SQL von Hand, kein ORM.

**Verworfen — `node:sqlite`:** Wäre dependency-frei gewesen, aber die Verfügbarkeit
hängt von der Node-Version *in Electron* ab (Electron bündelt eine ältere Node-Version
als das System) und FTS5-Unterstützung ist dort nicht garantiert. Zu viel
Laufzeit-Unsicherheit für die zentrale Persistenzschicht.

**Verworfen — Drizzle/Prisma:** Bei fünf parallel entwickelten Fachmodulen wäre die
zentrale Schema-Datei bzw. der Codegen-Schritt ein permanenter Merge-Konflikt- und
Reihenfolge-Engpass. Nummerierte SQL-Migrationen pro Modul (eigene Datei, eigener
Nummernkreis) sind konfliktfrei parallelisierbar; Typsicherheit liefern Zod-Schemas
an der API-Grenze.

## Migrationen als TS-Module, nicht als .sql-Dateien

Das Backend wird für die Desktop-App per esbuild zu einer einzigen `server.cjs`
gebündelt. Ein Migrations-Runner, der ein Verzeichnis nach `*.sql` durchsucht,
findet im Bundle nichts. SQL-Strings in TS-Modulen wandern automatisch mit ins
Bundle. (Erste Idee war ein `extraResources`-Ordner + Pfad-Env — funktioniert,
ist aber ein zweiter Verteilweg, der bei jedem Packaging-Detail brechen kann.)

## Renderer: HashRouter + relative Asset-Pfade

Die Desktop-App lädt den Renderer-Build über `file://`. `createBrowserRouter`
bräuchte einen Server, der beliebige Pfade auf `index.html` mappt — den gibt es
dort nicht. Ebenso zeigen absolute Asset-Pfade (`/assets/…`) unter `file://` auf
die Festplattenwurzel; daher `base: './'` in `vite.config.ts`.

## API-Port-Übergabe an den Renderer

**Verworfen:** `process.env` im Main-Prozess setzen und im Preload lesen — das
funktioniert meistens, hängt aber vom Vererbungszeitpunkt des Renderer-Prozesses
ab. **Gewählt:** `webPreferences.additionalArguments` → deterministisch in
`process.argv` des Preload-Skripts.

## OpenAPI: kuratierte YAML statt Codegen

Anforderung ist, *geplante* Web-Client-Endpunkte (`x-status: planned`) neben den
implementierten zu dokumentieren — aus Code generierte Spezifikationen können
naturgemäß nur beschreiben, was existiert. Daher: `openapi/base.yaml` (Basis +
planned) plus ein `*.paths.yaml`-Fragment je Modul, zusammengeführt per Skript.
Der Merge ist bewusst textbasiert (Fragmente enthalten nur einen `paths:`-Block),
um keine YAML-Bibliothek ins Backend zu ziehen.

## Sackgasse: Electron-Postinstall unter npm-allowScripts + OneDrive

Symptom: `npm install` blockiert zunächst alle Install-Skripte (npm-12-Feature
`allowScripts` — Freigabe nötig via `npm install-scripts approve <pkg>`). Nach der
Freigabe lud `electron/install.js` das Zip zwar in den Cache
(`%LOCALAPPDATA%\electron\Cache`), die Extraktion nach `node_modules/electron/dist`
brach aber **still mit Exit-Code 0** ab (nur ein leerer `locales`-Ordner entstand;
`path.txt` fehlte) — mutmaßlich OneDrive-/Datei-Lock auf dem Arbeitsverzeichnis.
Wiederholtes Ausführen von `install.js` half nicht (Skript hält den Zustand für
vollständig). **Lösung:** Zip aus dem Cache manuell mit `Expand-Archive` nach
`node_modules/electron/dist` entpacken und `path.txt` mit Inhalt `electron.exe`
anlegen. Bei „Electron failed to install correctly" zuerst prüfen, ob `dist/`
vollständig ist, statt neu zu installieren.

## Sackgasse: Backend-Bundle aus dem CLI-Einstieg gebaut

Das erste `server.cjs` wurde aus `src/index.ts` gebündelt — dem CLI-Einstieg,
der beim Laden sofort `startServer()` auf Port 3001 aufruft und **nichts
exportiert**. Symptom in der gepackten App: Fehlerdialog „startServer is not a
function", während im Hintergrund trotzdem ein Server lief (der Auto-Start des
CLI-Moduls hatte die Datenbank bereits angelegt — das machte die Diagnose
zunächst verwirrend: DB existierte, App zeigte Fehler). Lösung: zwei Bundles —
`dist/server.cjs` aus `src/server.ts` (nur Exporte, niemals Selbststart, wird
von Electron eingebettet) und `dist/cli.cjs` aus `src/index.ts` (Standalone).
Merksatz: Embedding-Bundles immer aus einem Modul ohne Seiteneffekte bauen.

## Zwei electron-builder-Stolpersteine im npm-Workspace

1. **`electronVersion` muss gepinnt werden:** Durch das Workspace-Hoisting liegt
   `electron` im Root-`node_modules`; electron-builder kann die `^38.0.0`-Range
   aus `apps/desktop/package.json` nicht selbst auflösen und bricht ab. Fester
   Wert in `electron-builder.yml` (muss zur installierten Version passen).
2. **`productName` gehört zusätzlich in die `package.json` der Desktop-App:**
   `app.getPath('userData')` leitet sich aus dem Paketnamen ab — mit dem
   Scoped-Namen `@hrmonic/desktop` landeten Nutzerdaten in
   `%APPDATA%\@hrmonic\desktop` statt `%APPDATA%\HRMONIC`. Das `productName`
   in `electron-builder.yml` allein beeinflusst nur Installer/Verknüpfungen,
   nicht die Laufzeit.

Außerdem: electron-builder baut `better-sqlite3` in-place auf die Electron-ABI
um (`@electron/rebuild`). Danach schlagen Node-seitige Läufe (tsx, Smoke-Tests)
mit ABI-Fehlern fehl, bis `npm rebuild better-sqlite3` die Node-Variante
wiederherstellt. Nach jedem `dist:win` einplanen.

**Sackgasse — der zweite Installer-Build packte die falsche ABI:** electron-builder
hinterlässt nach dem Umbau einen Marker (`better-sqlite3/build/Release/.forge-meta`)
und überspringt den Umbau beim nächsten Mal, wenn er existiert. Ein
zwischenzeitliches `npm rebuild better-sqlite3` tauscht jedoch nur die
`.node`-Datei zurück auf die Node-ABI und **lässt den Marker stehen** — der
nächste Installer enthielt dadurch die Node-Variante und die installierte App
startete mit `NODE_MODULE_VERSION`-Fehlerdialog, obwohl das Build-Log
„finished moduleName=better-sqlite3" meldete. Lösung:
`desktop/scripts/reset-native.mjs` löscht den Build-Ordner vor jedem `dist:*`
(in den npm-Skripten verdrahtet), sodass immer frisch für Electron gebaut wird.

## Sackgasse: SQLite-Operator-Präzedenz bei String-Konkatenation

`CAST(x AS INTEGER) + 1 || '-' || rest` lieferte im Dashboard statt eines
Datums-Strings eine Zahl: In SQLite bindet `||` **stärker** als `+`, der
Ausdruck wurde als `CAST(x) + (1 || '-' || rest)` geparst und die rechte Seite
numerisch koerziert. Symptom im Client: `iso.split is not a function` tief in
`formatDate`. Lösung: `(CAST(x AS INTEGER) + 1) || '-' || rest` — und
`formatDate` ist seitdem defensiv gegen Nicht-Strings.

## Sackgasse: UTF-8-BOM-Literale unter Git-Bash/Windows patchen

Der CSV-Export braucht ein UTF-8-BOM für deutsches Excel. Zwei Versuche, das
BOM per `perl`-Einzeiler in den Quelltext zu patchen, zerschossen das Literal
(Encoding-Doppelkonvertierung unter Git-Bash/Windows). Lösung: das BOM-Zeichen
direkt als `﻿`-Escape im TypeScript-String belassen und Dateien mit
Sonderzeichen nur über die Write/Edit-Werkzeuge anfassen, nie über
Shell-Substitution.

## Feiertage: berechnet statt API/Datenpflege

Gaußsche Osterformel + Regeltabelle je Bundesland in `core/holidays.ts`. Eine
externe Feiertags-API wäre ein Online-Zwang für eine Desktop-App, die auch offline
funktionieren muss. Dokumentierte Vereinfachungen: Mariä Himmelfahrt nur SL (in BY
gemeindeabhängig), Fronleichnam ohne kommunale Sonderfälle SN/TH, kein Augsburger
Friedensfest.

## Mitarbeitenden-Accounts: users-Tabelle erweitert statt eigener Tabelle

**Entscheidung:** Portal-Logins sind normale `users`-Zeilen mit Rolle
`mitarbeiter` und neuer Spalte `employee_id` (Migration `001_users_employee_link`,
Partial-Unique, `ON DELETE SET NULL`) — keine separate `employee_accounts`-Tabelle.

**Warum:** Login, bcrypt-Hashing, JWT-Ausstellung, `audit_log.user_id` und
`decided_by_user_id`/`created_by_user_id` referenzieren alle `users`. Eine zweite
Kontentabelle hätte jeden dieser Pfade verdoppelt. Autorisierung bleibt zentral:
Der globale Hook in `server.ts` lässt Nicht-Admins nur auf `/api/auth/*` und
`/api/me/*`; die Self-Service-Routen erzwingen zusätzlich das eigene Profil.
Verworfen: Rollen-Checks pro Route (fehleranfällig, 100+ Routen) und ein eigener
Employee-JWT-Typ (zwei Token-Pfade für denselben Verify-Hook).

Stolperstein Reihenfolge: `001_…` läuft (Namenssortierung) vor `100_employees`,
die referenzierte Tabelle existiert bei frischen DBs also noch nicht. SQLite
löst FK-Ziele erst bei Nicht-NULL-Schreibzugriffen auf, und bis nach Migration
100 schreibt niemand ein `employee_id` — bewusst so belassen, im Migrationstext
kommentiert.

## Web-Portal: eigener Workspace mit eigener Formensprache

**Entscheidung:** `apps/web` ist ein eigenständiges Vite-Projekt (BrowserRouter,
Port 5174, Prod-API same-origin hinter Reverse-Proxy, `VITE_API_BASE` als
Override) mit eigenem, bewusst dokumentenhaftem UI (Public Sans + Source Serif 4,
flache Karten, Skeleton-Loader, `pt-`-Präfix) auf identischen Markenfarben.

**Warum kein geteilter UI-Code mit dem Renderer:** Der Renderer ist eine
Maus-zentrierte Desktop-Verwaltung ohne Media-Queries (fixe 264-px-Sidebar,
`body { overflow: hidden }`, Electron-Titelleiste); das Portal muss auf dem
Smartphone funktionieren und deutlich weniger können. Geteilt wird, was stabil
ist — Typen/Konstanten aus `@hrmonic/shared` und die Token-**Werte** — statt
Komponenten, deren Layout-Annahmen nicht übertragbar sind. Die Desktop-Regel
„base: './' + HashRouter" gilt hier ausdrücklich nicht (HTTP-Auslieferung,
SPA-Fallback dokumentiert in docs/web-portal.md).
