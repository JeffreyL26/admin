# HRMONIC — Systemwissen

HR-Verwaltungssoftware für den deutschsprachigen Markt. Desktop-App (Electron) für
HR-Administrator:innen auf einem client-agnostischen Backend; ein Mitarbeitenden-
Web-Client kommt später auf dasselbe Backend.

## Architektur

```
apps/backend    Fastify 5 + better-sqlite3, REST-API, eingebettet ODER standalone
apps/renderer   React 18 + Vite, lädt im Prod-Betrieb über file:// (daher HashRouter)
apps/desktop    Electron: Main-Prozess startet das Backend-Bundle in-process
packages/shared Gemeinsame TS-Typen/Konstanten (kein Laufzeit-Code mit Abhängigkeiten)
```

- **Backend ist die einzige Sicherheitsgrenze.** Jede Route läuft durch den
  globalen JWT-Hook in `server.ts`; öffentlich ist nur, was explizit
  `config: { public: true }` setzt (Login, signierte Downloads, Health).
- **Desktop-Embedding:** `desktop/src/main.ts` ruft `startServer(0)` aus dem
  esbuild-Bundle `server.cjs` auf (zufälliger Port) und reicht die Basis-URL via
  `additionalArguments` an das Preload-Skript → `window.hrmonic.apiBaseUrl`.
  Im Dev-Betrieb läuft das Backend separat auf 3001 (`npm run dev`).
- **Kein natives Menü:** Das Fenster ist rahmenlos (`titleBarStyle: 'hidden'`,
  auf macOS `hiddenInset`), `Menu.setApplicationMenu(null)`. Die eigene
  Titelleiste (`renderer/src/layout/TitleBar.tsx`) bringt App-Menü und
  Fenster-Controls mit; Aktionen laufen über IPC (`window.hrmonic.window` /
  `.app`, definiert im Preload). Tastaturkürzel (Strg+K/1–6/±/0, F11) sind in
  `AppShell.tsx` im Renderer registriert, da es kein Menü mehr für Accelerators
  gibt. Datei-Uploads nutzen die Dropzone `components/FilePicker.tsx`
  (`FilePicker`/`PhotoPicker`) statt nacktem `<input type=file>`.
- **Dateien** liegen ausschließlich im Backend-Storage (`files`-Tabelle + Ordner).
  Downloads laufen über kurzlebige HMAC-signierte URLs (`core/files.ts`) — für
  Desktop- und späteren Web-Client identisch.

## Konventionen

- **Sprache:** UI-Texte Deutsch, Code-Bezeichner Englisch. API-Fehlermeldungen
  Deutsch (sie werden dem Nutzer direkt angezeigt).
- **Datumswerte:** überall ISO-Strings `YYYY-MM-DD` (DB, API); Anzeige über
  `formatDate` aus `@hrmonic/shared` (TT.MM.JJJJ).
- **Geld:** Integer-Cent in DB und API; Anzeige über `formatEuro`.
- **Fehler:** einheitliches Schema `{ error: { code, message, details? } }`
  (`core/errors.ts`). Eingaben mit `parse(zodSchema, req.body)` validieren.
- **Audit:** Änderungen mit Begründungspflicht (z. B. Gehalt) schreiben über
  `core/audit.ts` ins zentrale `audit_log`.
- **Dashboard ist personalisierbar:** Widgets/KPI-Kacheln sind pro Gerät wählbar
  und anordenbar; Registry + localStorage-Persistenz (`hrmonic.dashboard`) in
  `renderer/src/features/dashboard/dashboardConfig.ts`. Neue Module registrieren
  ihre Dashboard-Widgets dort (Default-Sichtbarkeit bewusst kuratiert klein).
- **Themes:** Vier Farbschemata (Hell/Dunkel/Rosé/Silber) leben ausschließlich
  als CSS-Variablen-Blöcke in `design/tokens.css` (`:root[data-theme='…']`),
  Umschaltung über `design/theme.ts` (localStorage `hrmonic.theme`). Neue
  UI-Farben deshalb NIE hartkodieren, sondern immer über bestehende Variablen —
  im Dunkel-Theme ist die Grau-Rampe invertiert (gray-25 = dunkelste Fläche).
  SVG-Exporte (Organigramm) lösen Variablen zur Renderzeit über
  `getComputedStyle` in konkrete Werte auf.

## Modul-Erweiterungspunkte (parallel konfliktfrei)

Jedes Fachmodul fasst **nur eigene Dateien** an; die Verdrahtung existiert bereits:

| Was | Wo | Hinweis |
|---|---|---|
| SQL-Migrationen | `backend/src/db/migrations/<NNN>_<modul>.ts` | Nummernkreise: 0xx Core, 1xx Personal, 2xx Abwesenheit, 3xx Leistung, 4xx Vergütung, 5xx Kommunikation, 6xx Recruiting, 7xx Verwaltung. Array in der Moduldatei füllen — `index.ts` nicht anfassen. |
| API-Routen | `backend/src/modules/<modul>/` | `routes.ts` exportiert das Fastify-Plugin (bereits registriert). |
| OpenAPI | `backend/openapi/<modul>.paths.yaml` | Nur ein top-level `paths:`-Block; Merge via `npm run openapi -w apps/backend`. |
| Shared-Typen | `packages/shared/src/<modul>.ts` | Bereits aus `index.ts` re-exportiert. |
| Seiten | `renderer/src/features/<modul>/` | `routes.tsx` exportiert `RouteObject[]` — Pfad-Kontrakt steht in `layout/nav.ts`, exakt diese Pfade implementieren. |

Verbindliche Schnittstellen zwischen den Modulen (Kerntabellen-Schema,
API-Stilregeln, Renderer-Bausteine): **`docs/modul-kontrakte.md`**. Kurzfassung:
API-Felder sind snake_case wie in der DB, Antworten benannte Objekte
(`{ employees: [...] }`), keine neuen npm-Abhängigkeiten ohne Abstimmung.

## Fallstricke (bereits erlebt oder bewusst umschifft)

- **`vite.config.ts` braucht `base: './'`** — ohne das zeigen Asset-Pfade im
  file://-Betrieb der Desktop-App ins Leere. Aus demselben Grund `createHashRouter`,
  nicht `createBrowserRouter`.
- **Migrationen sind TS-Module mit SQL-Strings, keine .sql-Dateien** — das Backend
  wird für die Desktop-App zu einer einzigen `server.cjs` gebündelt; Datei-Globs
  über ein Migrationsverzeichnis würden dort nicht existieren.
- **better-sqlite3 ist die einzige native Abhängigkeit.** Sie steht bewusst auch in
  den Dependencies von `apps/desktop`, damit electron-builder sie für die
  Electron-ABI neu baut/prebuildet. Im esbuild-Bundle als `--external` markiert.
- **CORS `origin: true` ist Absicht:** Prod-Renderer lädt über file:// (Origin
  `null`). Das Backend bindet dafür ausschließlich an 127.0.0.1.
- **OneDrive-Arbeitsverzeichnis:** `node_modules`/Builds können durch die
  Synchronisierung gebremst oder gesperrt werden. Bei ERR_EPERM/EBUSY zuerst an
  OneDrive denken.
- **SQLite-Präzedenz:** `||` bindet stärker als `+`. Arithmetik in
  Konkatenationen immer klammern, sonst kommen Zahlen statt Strings zurück
  (Details in docs/entscheidungen.md).
- **better-sqlite3-Typings:** bei mehreren Bind-Parametern Array-Binding
  verwenden (`.all([a, b])`), die variadische Form scheitert am Typecheck.
- **Nach `npm run dist:win`: `npm rebuild better-sqlite3` ausführen** —
  electron-builder baut das Modul in-place auf die Electron-ABI um, danach
  scheitern tsx/Smoke-Tests mit ABI-Fehlern, bis die Node-Variante
  wiederhergestellt ist. Die Gegenrichtung ist abgesichert: `dist:*` löscht
  vorher `better-sqlite3/build` (reset-native.mjs), weil electron-builder den
  Umbau sonst wegen eines übrig gebliebenen `.forge-meta`-Markers überspringt
  und die falsche ABI einpackt (Details in docs/entscheidungen.md).
- **Embedding-Bundle `server.cjs` kommt aus `src/server.ts`** (nur Exporte);
  `src/index.ts` ist der CLI-Einstieg mit Selbststart und wird separat zu
  `cli.cjs` gebündelt. Nicht verwechseln — Details in docs/entscheidungen.md.
- **Zwei getrennte Datenbanken:** Die Dev-DB liegt in `apps/backend/data`
  (`npm run seed`), die **installierte App** in `%APPDATA%\HRMONIC\data` (aus
  Electrons userData, abgeleitet vom `productName` "HRMONIC"). `npm run seed`
  füllt NUR die Dev-DB; für die installierte App `npm run seed:desktop -- --force`
  (App vorher schließen — SQLite-Dateisperre). Ein frisch installiertes Programm
  startet absichtlich leer (nur Admin-Login).

## Häufige Kommandos

```bash
npm run dev            # Backend (3001) + Renderer (5173) parallel
npm run dev:desktop    # Electron-Fenster gegen den Dev-Stack
npm run typecheck      # alle Workspaces
npm run seed           # Demo-Daten
npm run dist:win       # kompletter Windows-Installer (NSIS) → apps/desktop/release
```

Login im Dev/Frischinstallation: `admin@hrmonic.de` / `hrmonic2026`.
