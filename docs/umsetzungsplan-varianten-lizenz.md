# Umsetzungsplan: Varianten, Lizenz v2, Feature-Schalter, Länder, Kanäle, Hosting, conspectus

Stand 15.09.2026, Repo-Stand `4af4064` (Tag `v1.0.0`). Dieses Dokument ist die
Arbeitsanweisung für die Umsetzung durch Claude Code. Es beschreibt, WAS in
welcher Reihenfolge gebaut wird, WO es im Repo liegt und WIE jede Phase
abgenommen wird. Hintergrund und Begründungen: `docs/lizenzierung.md`,
`docs/entscheidungen.md`, das Betriebs- und Lizenzkonzept vom 13.09.2026.

## 0. Verbindliche Entscheidungen des Anbieters

1. **Editionen und Länder sind getrennte Builds.** Eine Variante ist
   Land x Edition (heute `de-enterprise` und `de-basic`, später `at-…`,
   `ch-…`). Je Variante entstehen ein eigener Installer und ein eigenes
   Server-Archiv aus EINEM Codestand. Code, der nicht zur Edition gehört,
   ist im Bundle der Variante nicht enthalten.
2. **Maßgeschneiderte Kundenfunktionen** werden als Feature-Schlüssel im
   Hauptprodukt gebaut (z. B. `kunde.musterfirma.export`) und über die
   signierte Lizenz freigeschaltet. Keine Kunden-Branches.
3. **Lizenzmodelle entstehen nur über signierte Lizenzdateien.** Ein
   3-Tage-Test ist eine Testlizenz mit 3 Tagen Laufzeit, kostenfrei
   unbefristet ist eine Datei ohne Enddatum mit Abrechnungsart
   `kostenfrei`. Die eingebaute 30-Tage-Testphase ohne Datei bleibt als
   Rückfall. Nichts davon ist beim Kunden umstellbar.
4. **Lizenztexte** in Desktop-App, Banner, Dashboard-Widget und
   Backend-Meldungen entstehen aus strukturierten Lizenzfeldern
   ("Ihre Lizenz läuft unbegrenzt und kostenfrei.") plus einer optionalen,
   signierten Überschrift des Anbieters.
5. **Updates** erreichen nur die passende Variante und den passenden Kanal
   (`stable`, `beta`). Eine Variantenverwechslung wird technisch verhindert.
6. **Keine Gedankenstriche** (weder Halbgeviert- noch Geviertstrich) in
   neuen oder geänderten UI-Texten, Dokumenten, Skriptausgaben und
   Kommentaren. Drei etablierte UI-Konventionen bleiben: der Geviertstrich
   als Leerwert in Tabellenzellen, die Klammer aus zwei Geviertstrichen um
   den Platzhaltertext leerer Auswahlfelder
   und der Halbgeviertstrich in Datumsspannen. Jede angefasste Datei wird
   von Stil-Gedankenstrichen befreit; ein Skript prüft das.
7. **Gesamtvorhaben in Phasen**, jede Phase einzeln abnehmbar. Zu keinem
   Zeitpunkt darf eine Bestandsinstallation in den Nur-Lese-Betrieb fallen.

## 1. Zielbild nach der Umsetzung

- **Varianten.** Ein Modul-Alias `@variant` zeigt je App auf eine
  Verdrahtungsdatei `src/variants/<id>.ts`, die nur die Module der Edition
  statisch importiert. Ausgeschlossene Module werden nicht importiert und
  landen deshalb nicht im Bundle. Das Datenbankschema ist in allen Varianten
  identisch; Editionen entfernen Routen und Seiten, keine Tabellen. Ein
  Upgrade von Basic auf Enterprise ist Installer plus Lizenz, ohne
  Migration.
- **Lizenz v2** trägt `edition`, `country`, `features`, `terms` und eine
  optionale `headline`. v1-Dateien bleiben unverändert gültig. Der Server
  lehnt eine Lizenz fremder Variante ab, `/api/health` meldet Variante und
  Kanal, die Desktop-App prüft beim Start Variante gegen Variante.
- **Features** sind Lizenzschalter innerhalb eines Builds: Registry in
  `packages/shared`, Gate im globalen Hook, fail open für unbekannte
  Routen, alles an ohne Lizenzdatei. Edition = Build-Inhalt, Feature =
  Schalter im Build.
- **Länder** sind eine Datendimension: `CountryCode`, Regionen je Land,
  Feiertagsregeln als Daten, Beschäftigungsarten und Steuerkataloge je
  Land, Export-Adapter je Land. Das Land kommt aus dem Variantenmanifest,
  nicht aus einer Kundeneinstellung. AT und CH bekommen Strukturen, keine
  Inhalte.
- **Kanal** ist eine Funktion der Version: `1.2.0-beta.1` ist Kanal `beta`,
  `1.2.0` ist `stable`. Releases werden je Variante gebaut, mit einem
  signierten `release.json` verpackt und unter
  `releases/<kanal>/<variante>/` abgelegt.
- **Hosting** bekommt versionierte Programmverzeichnisse mit Symlink je
  Instanz (damit auf einem Host verschiedene Varianten und Stände laufen und
  ein gescheitertes Update einen Rückweg hat), Leseisolation zwischen den
  Instanzen, Ressourcengrenzen, ein Update-Skript mit Variantenprüfung und
  Migrations-Probelauf sowie instanzbewusste Wiederherstellung.
- **conspectus** ist eine TypeScript-CLI unter `tools/conspectus` mit
  SQLite-Register außerhalb des Repos. Sie stellt Lizenzen aus, kennt
  Kunden, Instanzen, Hosts, Releases und Rollouts und rollt nach Variante
  und Kanal aus.
- Alle Lizenztexte kommen aus einer reinen Funktion `describeLicense()` in
  `packages/shared`, gemeinsam für Renderer, Backend und Portal.

## 2. Entwurfsentscheidungen

### A. Varianten-Build

- **A1. Alias statt Schalter.** `packages/shared/src/variants/index.ts`
  hält Typen und Daten: `CountryCode`, `Edition`, `VariantId`,
  `MODULE_KEYS` (`employees, absences, performance, leadership,
  compensation, communication, recruiting, admin, me`),
  `VariantManifest { id, country, edition, label, modules, marker }`,
  `VARIANT_IDS`, `parseVariantId()`. Je Variante eine Datei
  `packages/shared/src/variants/<id>.ts` mit `export const VARIANT`.
  Jede App hat `src/variants/<id>.ts`, die `VARIANT` re-exportiert und die
  statischen Imports der eingeschlossenen Module bündelt: Backend
  `backendModules: FastifyPluginAsync[]`, Renderer `variantRoutes`,
  Portal `portalRoutes`, Desktop nur `VARIANT`. Auflösung: `tsconfig.json`
  `paths` (`"@variant": ["./src/variants/de-enterprise.ts"]`) als Dev- und
  Typecheck-Vorgabe (tsx und tsc lesen sie), im Build überschrieben per
  esbuild `alias` bzw. Vite `resolve.alias` aus `OHRGANIZE_VARIANT`.
  Warum kein `define` mit totem `if`: esbuild bündelt einen Import auch
  hinter totem Code, weil die Routendateien Top-Level-Aufrufe enthalten.
  Nur der Verzicht auf den Import hält den Code fern.
- **A2. Schema variantenunabhängig.** Alle Migrationen laufen in jeder
  Variante (Kontrakt in `100_employees.ts`, Restore zwischen Editionen,
  Upgrade ohne Migration).
- **A3. Teilrouten des Portals, die an einem optionalen Modul hängen,
  wandern in die Verdrahtungsdatei.** `meSalaryRoutes` wird nicht mehr in
  `apps/backend/src/modules/me/routes.ts:73` registriert, sondern als
  eigenes Plugin in `backendModules` gelistet, nur bei `compensation`.
- **A4. Dev ohne Variable ist `de-enterprise`.** Basic wird gezielt mit
  `OHRGANIZE_VARIANT=de-basic` geprüft.
- **A5. Lizenz fremder Variante wird wie eine Fremdbindung behandelt.**
  v2-Payload mit abweichender `edition` oder `country` ergibt
  `invalid_reason` und `payload = null` (analog Installations-Mismatch in
  `license.ts:231-237`); der Upload antwortet 400 `LICENSE_INVALID` mit
  "Diese Lizenz gilt für die Ausgabe Deutschland Enterprise; installiert
  ist Deutschland Basic." v1-Dateien sind variantenneutral, die Testphase
  ohne Datei ebenfalls.
- **A6. Variante in Health und Startprüfung.** `/api/health` liefert
  `variant: { id, country, edition }` und `channel`. Die Desktop-App bricht
  bei `health.variant.id !== VARIANT.id` mit `StartupError` ab (Vorbild
  `apps/desktop/src/main.ts:473-480`). Das Backend prüft beim Start
  `OHRGANIZE_VARIANT` aus der Umgebung gegen `VARIANT.id` und verweigert
  den Start bei Abweichung (Schutz gegen einen falsch gesetzten Symlink).
- **A7. `appId` und `productName` bleiben für alle Varianten gleich.**
  Sonst spaltete sich `%APPDATA%\oHRganize` (config.json, Pin-Speicher,
  Einzelplatzdaten) je Variante auf und NSIS aktualisierte nicht mehr in
  place. Die Variante steht im Installernamen
  (`oHRganize-Setup-<version>-<variante>.exe`), im Über-Dialog und in der
  Startprüfung.

### B. Lizenz v2

- **B1. Schema.** `v: z.union([z.literal(1), z.literal(2)])`, `.strict()`
  bleibt, neue Felder optional, `superRefine`: bei `v = 1` darf kein
  v2-Feld vorkommen, bei `v = 2` sind `edition` und `country` Pflicht.
  Felder: `edition: 'basic' | 'enterprise'`, `country: 'DE' | 'AT' | 'CH'`,
  `features?: string[]` (Muster `^[a-z0-9]+(\.[a-z0-9-]+)+$`, max 50,
  unbekannte Schlüssel werden ignoriert), `terms?: { billing: 'kostenfrei'
  | 'abo' | 'kauf' | 'individuell'; interval?: 'monatlich' | 'jaehrlich' |
  null; label?: string | null }`, `headline?: string` (1 bis 120 Zeichen).
- **B2. Unbefristet bleibt der Sentinel `LICENSE_MAX_DATE`.** Der Zustand
  bekommt `perpetual: boolean`; bei `perpetual` gilt `days_left: null`,
  `grace_until: null`, `warning: false` (heute 355000 Tage und "Kulanz bis
  14.01.3000").
- **B3. Monotonie auf `issued_at` verengen.** Eine später ausgestellte
  Datei wird angenommen, auch wenn sie kürzer läuft; bei gleichem
  `issued_at` bleibt "nicht kürzer". Sonst könnte eine unbefristete
  kostenfreie Lizenz nie durch ein Abo ersetzt werden. Der Schutz gegen
  alte Mail-Anhänge bleibt über `issued_at`. Verhaltensänderung, in
  CHANGELOG und Doku nennen.
- **B4. Werkzeug stellt v1 aus, solange kein v2-Flag gesetzt ist**, und
  warnt bei v2 mit der Mindestserverversion `LICENSE_V2_MIN_SERVER_VERSION`.
  Rollout immer Server vor Datei. conspectus prüft die gemeldete
  Serverversion einer Instanz, bevor es v2 erzeugt.
- **B5. `kind: 'evaluation'` heißt in der Oberfläche "Testlizenz".**
  Vorgaben des Werkzeugs für `evaluation`: `warn_days = min(30,
  floor(Laufzeit / 2))`, `grace_days = 0`. Für `standard` wie bisher 14 und
  30. Beides per Flag überschreibbar.

### C. Texte

`packages/shared/src/licenseText.ts` mit `describeLicense(l):
{ headline, detail, tone: 'neutral' | 'info' | 'warning' | 'danger',
action }`. Dorthin wandern `remainingLabel`, `remainingLabelSentence`,
`expiredLead`, `validUntilLabel`, `seatsLabel`, `PORTAL_READ_ONLY_TEXT`,
`LICENSE_CLOCK_WARNING_TEXT`, `LICENSE_ACTION_TEXT` (heute doppelt in
`apps/renderer/src/features/settings/license.ts:65-111` und
`apps/backend/src/core/license.ts:436-438, 595-599`).

| Fall | headline | detail | tone |
|---|---|---|---|
| entwicklung | Entwicklungsverzeichnis, keine Lizenzprüfung. | | neutral |
| Testphase ohne Datei | Testphase bis 16.10.2026, noch 29 Tage. | Ohne Lizenzdatei läuft oHRganize danach im Nur-Lese-Betrieb. | info, ab `warning` warning |
| gültig, Testlizenz | Testlizenz bis 16.09.2026, noch 3 Tage. | Danach Nur-Lese-Betrieb. | info, ab `warning` warning |
| gültig, unbefristet, kostenfrei | Ihre Lizenz läuft unbegrenzt und kostenfrei. | `terms.label` | neutral |
| gültig, unbefristet, sonst | Ihre Lizenz läuft unbegrenzt. | z. B. Kauflizenz. | neutral |
| gültig, befristet | Ihre Lizenz gilt bis 31.12.2027 (noch 120 Tage). | Abonnement, jährliche Verlängerung. | neutral |
| gültig, befristet, Warnung | Ihre Lizenz läuft am 31.12.2027 ab (noch 12 Tage). | Bitte rechtzeitig verlängern. | warning |
| Kulanz | Ihre Lizenz ist am 31.12.2027 abgelaufen. | Kulanz bis 14.01.2028, ab 15.01.2028 Nur-Lese-Betrieb (noch 9 Tage). | danger |
| Nur-Lese nach Lizenz | Ihre Lizenz ist am X abgelaufen; die Kulanzfrist endete am Y. | Nur-Lese-Betrieb: Daten können eingesehen und exportiert werden, Änderungen sind nicht möglich. | danger |
| Nur-Lese nach Testphase | Die Testphase ist am X abgelaufen. | wie oben | danger |
| Datei unbrauchbar | Die Lizenzdatei ist unbrauchbar. | `invalid_reason` | danger |
| keine Datei nach Lizenz | Es liegt keine gültige Lizenz vor. | wie oben | danger |

`action` ist der Satz "Bitte spielen Sie unter Einstellungen → Lizenz eine
gültige Lizenzdatei ein." (der Pfeil ist kein Gedankenstrich;
`licenseSmoke.ts:232` prüft genau diese Zeichenfolge). Vorrang der
signierten `headline`: nur im Zustand `valid` ersetzt sie die erzeugte
Überschrift, der erzeugte Satz rückt in `detail`. In Kulanz und Nur-Lese
bleibt die erzeugte Überschrift, die Anbieterüberschrift erscheint als
Hinweis wie heute `notice`.

### D. Feature-Gate

- `packages/shared/src/features.ts`: `FeatureDef { key, label,
  description?, routes: readonly string[], navPaths?, widgets?, portal:
  boolean, portalPaths? }`, `FEATURES` (zu Beginn leer),
  `FEATURE_KEY_PATTERN`, `featureForRoute(route, registry)`,
  `hasFeature(features, key)` (null = alles an).
- `apps/backend/src/core/featureGate.ts`: `assertFeatureAllowed(method,
  route, features: ReadonlySet<string> | 'all', registry = FEATURES)` wirft
  `new AppError(403, LICENSE_ERROR_CODES.FEATURE_MISSING, 'Die Funktion
  „<label>“ ist in Ihrer Lizenz nicht enthalten.')`. Unbekannte Route:
  durchlassen (fail open; die Bereichsprüfung dahinter bleibt fail closed).
  Testhaken `overrideFeatureRegistryForTests()` nur, wenn
  `config.licensePublicKeyOverride` gesetzt ist (dieselbe Testgrenze wie
  der Prüfschlüssel, in Produktionsbundles per `--define` tot).
- Einhängung in `apps/backend/src/server.ts` nach `assertLicenseAllows`
  (Zeile 188) und vor dem `selfService`-Zweig (Zeile 190), damit `/api/me/*`
  erfasst ist.
- `effectiveFeatures()` in `license.ts`: `'all'` bei `entwicklung`, bei
  Testphase ohne Datei und bei Payload ohne `features`; sonst die Menge der
  Payload. Auch in `expired` gilt die Payload-Menge.
- Vertrag: `LicenseStatus.features: string[] | null`,
  `LicenseStatusPublic { read_only, features }`.
- Renderer: `AuthContext.hasFeature(key)`; `NavItem.feature?`; Filter in
  `AppShell.tsx:98-107`, `NAV_KEYS` (`AppShell.tsx:33-41`),
  `components/CommandPalette.tsx:85-87`; `widgetAllowed`/`statAllowed`
  bekommen `features`; `App.tsx:68` lässt `LICENSE_FEATURE_MISSING` als
  Toast durch (nur diesen 403-Code). Portal: `PortalShell` NavItem
  `feature?`, Filter über `useAuth().features`; `apiErrorMessage` reicht
  die Servermeldung bei `FEATURE_MISSING` unverändert durch.

### E. Länder-Dimension

- `packages/shared/src/country.ts`: `CountryCode`, `COUNTRY_LABELS`,
  `REGIONS: Record<CountryCode, Record<string, string>>` (DE = heutige
  `BUNDESLAND_LABELS`, AT und CH vorerst leer), `regionCodesFor(country)`,
  `isRegionOf(country, code)`, `localeFor(country)` (`de-DE`, `de-AT`,
  `de-CH`), `currencyFor(country)` (EUR, EUR, CHF), `DEFAULT_LOCALE`.
  `BundeslandCode` und `BUNDESLAND_LABELS` bleiben als Aliasse exportiert.
- `common.ts`: `formatMoney(cents, locale = DEFAULT_LOCALE, currency =
  'EUR')`; `formatEuro` wird zur Hülle.
- `apps/backend/src/core/holidays.ts`: Regeltabelle als Daten
  `HOLIDAY_RULES_DE: HolidayRule[]`, `HOLIDAY_RULES: Record<CountryCode,
  HolidayRule[]>`; `holidaysForYear(year, country, region)`,
  `isHoliday(date, country, region)`; Cache-Key `${country}|${year}|${region}`.
  Die dreifache Bundeslandliste (`holidays.ts:16-22`, `common.ts:14-20`,
  `modules/employees/validation.ts:173-177`) fällt auf die eine Quelle in
  shared zurück.
- `modules/absences/service.ts`: `regionForEmployee(employeeId): {
  country, region }` ersetzt `bundeslandForEmployee`; eine SQL-Konstante
  ersetzt die drei COALESCE-Duplikate (`absences/routes.ts:527, 837`,
  `me/calendarRoutes.ts:83`).
- Migration `107_locations_country` (additiv, in `100_employees.ts`):
  `ALTER TABLE locations ADD COLUMN country TEXT NOT NULL DEFAULT 'DE'`,
  `ALTER TABLE employees ADD COLUMN private_country TEXT`. Die Spalte
  `bundesland` bleibt und trägt den Regionscode des Landes.
- Land der Installation ist `VARIANT.country`, keine Einstellung.
  `settings.defaultBundesland` wird in `settingsRoutes.ts:15` gegen
  `regionCodesFor(VARIANT.country)` validiert (schließt den stillen
  `length(2)`-Pfad). API: `GET /api/regions?country=` (Vorgabe
  Variantenland), `GET /api/bundeslaender` bleibt als Alias; `/api/regions`
  in `ALWAYS_ALLOWED` (`permissions.ts:70`).
- `employees.ts`: `EMPLOYEE_TYPES_BY_COUNTRY`, `employeeTypeRulesFor(country)`,
  `TAX_CLASSES_BY_COUNTRY`, `CHURCH_TAX_BY_COUNTRY`; `validation.ts:77-106`
  und `employeeForm.tsx` lesen über die Accessoren.
- Payroll: `modules/compensation/payrollExport/{index.ts,lodas.ts}` mit
  `PayrollExporter { id, country, label, contentType, filename(run),
  render(run, items, settings) }`; die Route `/export.datev` bleibt und
  schlägt `lodas` nach. Minijob-Warnung (`payrollRoutes.ts:297-302`) nutzt
  `formatMoney(MINIJOB_LIMIT_CENTS)` statt des Literals.
- Bescheinigungen: `modules/compensation/certificates/de.ts` (Arten und
  Vorlage), `CERTIFICATE_TEMPLATES: Record<CountryCode, …>`.
- Frontends: `apps/renderer/src/lib/locale.ts` und
  `apps/web/src/lib/locale.ts` exportieren `LOCALE =
  localeFor(VARIANT.country)`; die zwölf Dateien mit `'de-DE'` importieren
  es beim Anfassen. `lang="de"` bleibt (UI-Sprache in allen drei Ländern
  Deutsch).

### F. Release, Version, Kanal

- Kanal = Funktion der Version: `channelOf(version): 'stable' | 'beta'` in
  `packages/shared/src/version.ts`. `parseVersion` behält die Vorabkennung
  (`{ core, pre }`), `compareVersions` ordnet nach Semver
  (`1.1.0-beta.2 < 1.1.0`, `beta.1 < beta.2`). Falle: `isAtLeast('1.1.0-beta.1',
  '1.1.0')` wird dadurch falsch; während einer Beta müssen `MIN_*` ggf. auf
  die Beta-Version zeigen.
- Manifest-Signatur mit `ssh-keygen -Y sign` und einem eigenen
  Ed25519-SSH-Schlüssel `ohrganize-release`, Allowed-Signers-Datei
  `deploy/ohrganize-release.allowed_signers`. Kein neues npm-Paket, auf
  jedem Linux- und Windows-Server vorhanden. Das Lizenzschlüsselpaar wird
  nicht wiederverwendet (getrennte Vertrauensdomänen und Rotation).
- `scripts/release.mjs`: `npm version <v> --workspaces
  --include-workspace-root --no-git-tag-version`, CHANGELOG-Pflicht, Commit
  und Tag `v<version>`, Build je Variante, `release-server.mjs --variant`
  (Archivname `ohrganize-server-<land>-<edition>-<version>.zip`), `dist:win`
  mit `OHRGANIZE_VARIANT`, Build-Matrix-Prüfung, Manifest `release.json
  { product, version, channel, variant, artifacts [{ file, sha256, bytes }],
  min_client_version, min_server_version, built_at, commit }` plus
  `release.json.sig`, Ablage `release/<version>/<kanal>/<variante>/`.
- Download-Struktur statisch: `releases/<kanal>/<variante>/` mit
  `latest.json` (Kopie des jüngsten `release.json`).
- Update-Anleitungen (`deploy/README.md:372-414, 736-749`,
  `deploy/windows/README.md:370-398`, LIESMICH) bekommen den Schritt
  "Variante prüfen" vor dem Entpacken.

### G. Hosting

- Programm: `/opt/ohrganize/releases/<variante>-<version>/` (entpacktes
  Archiv samt `node_modules`), je Instanz Symlink
  `/opt/ohrganize/kunden/<kunde>`. Unit:
  `WorkingDirectory=/opt/ohrganize/kunden/%i/apps/backend`, `ExecStart` auf
  `…/kunden/%i/apps/backend/dist/cli.cjs`. Das Pinnen einer Instanz auf ihr
  altes Release ist der Symlink selbst.
- Portal: `/srv/ohrganize-web/<variante>-<version>/`, je Kunde Symlink
  `/srv/ohrganize-web/kunden/<kunde>.<basisdomain>`; nginx `root
  /srv/ohrganize-web/kunden/$host;`.
- Leseisolation: `TemporaryFileSystem=/var/lib/ohrganize:ro` plus
  `BindPaths=/var/lib/ohrganize/%i` (Backup-Unit analog). Auf dem
  Testserver messen (Wechselwirkung mit `StateDirectory` und
  `PrivateUsers=true`). Benutzer je Instanz bleibt als Ausbaustufe
  dokumentiert.
- Ressourcen: `MemoryHigh=512M`, `MemoryMax=768M`, `TasksMax=256`,
  `CPUWeight=100`, `IOWeight=100` als Startwerte, nach Dauerlauf justieren.
- `deploy/ohrganize-update.sh`: Prüfsumme, Signatur, `release.json` lesen,
  Variante gegen env-Datei UND `/api/health` der laufenden Instanz,
  entpacken nach `releases/`, `npm ci --omit=dev`, better-sqlite3-Probe,
  Migrations-Probelauf gegen eine Datenbankkopie (`migrate-check.cjs`, als
  Dienstbenutzer), dann je Instanz: Sicherung, stop, Symlink umsetzen,
  start, Health mit Versions- und Variantenabgleich; bei Fehler Symlink
  zurück, Start, bei "von neuerer Version migriert" Datenbank aus der eben
  erstellten Sicherung zurück, Markerdatei `.update-fehlgeschlagen`, weiter
  mit der nächsten Instanz.
- Restore: `provision.sh restore <kunde> <ordner>` instanzbewusst;
  `backup.ts#restoreSteps()` erkennt Instanzen am Datenverzeichnis und
  nennt den Befehl statt der Einzelkunden-Zeilen.

### H. Prüfskript für Gedankenstriche

`scripts/check-dashes.mjs` prüft die Dateien aus `git diff --name-only
--diff-filter=ACMR <base>` (oder `--staged`, oder explizite Pfade) auf
Halbgeviertstrich (U+2013) und Geviertstrich (U+2014) mit genau drei
Ausnahmen als Regex (im Skript als Unicode-Escapes der Codepunkte U+2013 und U+2014
geschrieben, damit das Skript selbst die Prüfung besteht): (1) Leerwert:
ein einzelner Geviertstrich in einfachen oder doppelten Anführungszeichen,
in `{'…'}` oder zwischen `>` und `<`; (2) Klammer leerer Auswahlfelder:
Geviertstrich, Leerzeichen, 1 bis 40 Zeichen ohne Geviertstrich,
Leerzeichen, Geviertstrich; (3) Datumsspanne: `TT.MM.` oder `TT.MM.JJJJ`,
Leerzeichen, Halbgeviertstrich, Leerzeichen, gefolgt von einer Ziffer oder
`${`, sowie das Codemuster `}`, Leerzeichen, Halbgeviertstrich,
Leerzeichen, `${`. Kein Kommentar-Opt-out. Root-Skript
`check:dashes`, Aufruf in `release.mjs` und in jeder Phasenabnahme.

## 3. Phasen

| Phase | Inhalt | Aufwand |
|---|---|---|
| 0 | Werkzeuge: check-dashes, Feiertags-Fixture, CHANGELOG | 1 PT |
| 1 | Lizenztexte in shared, reiner Zustandsautomat, unbefristet korrekt | 4 PT |
| 2 | Lizenz v2: Felder, Werkzeug, Ausstell-Baustein, Monotonie, Audit bei Dateiwechsel | 4 PT |
| 3 | Feature-Gate: Registry, Hook, Clients | 3 PT |
| 4 | Varianten-Build: Manifeste, Alias, Health, Desktop-Prüfung, Installername, Matrix-Prüfung | 6 PT |
| 5 | Länder-Dimension: shared, Feiertage, Regionen, Migration 107, Adapter | 6 PT |
| 6 | Release, Version, Kanal, Manifest-Signatur, Doku | 5 PT |
| 7 | Hosting-Härtung, provision.sh-Ausbau, Betreiberwerkzeuge, update.sh | 8 PT |
| 8 | conspectus-CLI und docs/betrieb-anbieter.md | 8 PT |
| | Summe | 45 PT plus 10 Prozent Reserve |

Reihenfolge verbindlich für 0 bis 4 (jede baut auf der vorigen auf); 5 und 6
sind nach 4 unabhängig voneinander; 7 braucht 6 (Archivformat,
`release.json`); 8 braucht 2 und 7.

### Phase 0: Werkzeuge (1 PT)

Ziel: Prüfbarkeit vor der ersten Änderung.

- `scripts/check-dashes.mjs` (neu, siehe H). Textendungen `.ts .tsx .mjs
  .md .sh .ps1 .yml .yaml .txt .html .conf .service .timer .example .json`.
- Root `package.json`: `"check:dashes"`, `"test:holidays"` (Phase 5 nutzt
  es).
- `apps/backend/src/test/fixtures/holidays-de.json` (neu): einmalig mit dem
  heutigen `holidaysForYear` erzeugt (Einmalskript
  `apps/backend/src/test/writeHolidayFixture.ts`, im Repo belassen): alle
  16 Länder für 2016, 2017, 2018, 2019, 2022, 2023, 2026, 2030 (deckt alle
  Jahresweichen der Regeltabelle `holidays.ts:98-125` ab).
- `CHANGELOG.md` (neu, Abschnitte "Unveröffentlicht" und "1.0.0").

Abnahme: `node scripts/check-dashes.mjs apps/backend/src/core/license.ts`
meldet die bekannten Treffer; `node scripts/check-dashes.mjs
packages/shared/src/common.ts` meldet nichts für den Leerwert in Zeile 40;
Fixture enthält 16 x 8 Einträge.

### Phase 1: Lizenztexte und reiner Zustandsautomat (4 PT)

Ziel: alle Lizenztexte aus einer Funktion; unbefristet ohne Kulanzdatum
3000; Testlizenz statt Auswertung; Duplikate weg.

- `packages/shared/src/license.ts`: `LicenseStatus` um `perpetual`,
  `issued_at`; `LICENSE_KIND_LABELS` hierher (`evaluation: 'Testlizenz'`),
  `LICENSE_STATE_LABELS` hierher; Gedankenstriche in Kommentaren entfernen.
- `packages/shared/src/licenseText.ts` (neu, siehe C); Export in `index.ts`.
- `packages/shared/src/common.ts`: `addDaysIso` hierher (aus
  `apps/backend/src/core/dates.ts:9-13` und
  `apps/renderer/src/features/settings/license.ts:109-111`), beide
  re-exportieren.
- `apps/backend/src/core/licenseState.ts` (neu):
  `deriveLicenseState(input: { today, enforced, installation, loaded,
  clockWarning }): { core: LicenseCore; markLicensed: boolean }` als reine
  Funktion aus `computeCore` (`license.ts:207-329`); die UPDATEs auf
  `licensed_at` (Zeile 256) und `last_seen_date` (Zeile 348) bleiben im
  Aufrufer. `LicenseCore` bekommt `perpetual`, `issued_at`.
- `apps/backend/src/core/license.ts`: `computeCore` ruft
  `advanceLastSeen` und dann `deriveLicenseState`; `readOnlyMessage` und
  `logLicenseAtStartup` nutzen `describeLicense`; `remaining()` und
  `PORTAL_READ_ONLY_MESSAGE` entfallen; Gedankenstriche raus.
- `apps/renderer/src/features/settings/license.ts`: nur noch
  `LICENSE_PATH`, `LICENSE_QUERY_KEY`, `licenseStateTone`, Re-Exporte.
- `apps/renderer/src/features/settings/LicensePage.tsx`: `statusLine`
  (Zeilen 40-59) durch `describeLicense` ersetzen; Fact "Kulanz bis" zeigt
  bei `perpetual` "entfällt"; Gedankenstriche raus, Leerwerte bleiben.
- `apps/renderer/src/layout/LicenseBanner.tsx`: `describe` (35-75) durch
  `describeLicense` ersetzen; `neutral` = kein Banner.
- `apps/renderer/src/features/dashboard/widgets.tsx:270-308`: Widget nutzt
  `describeLicense().headline`, `runtime`-Zweig über `perpetual`.
- `apps/web/src/lib/license.ts`: Text aus shared.
- `apps/backend/src/test/licenseStateTest.ts` (neu): tabellengetriebene
  Prüfung aller Zeilen aus C plus Uhr plus Fremdbindung; in
  `apps/backend/package.json` an `npm test` anhängen.
- `apps/backend/src/test/licenseSmoke.ts`: Zeile 132 zusätzlich
  `perpetual === true && days_left === null && grace_until === null &&
  warning === false`; Startlog-Text enthält keinen Gedankenstrich.

Reihenfolge: shared, Backend (reine Funktion, Tests grün), Renderer,
Portal, Gedankenstrich-Lauf.

Risiken: Lizenzseite und Banner haben keine Tests: Typecheck plus manueller
Durchlauf im Dev-Stack mit einer per `npm run lizenz -- sign --until
unbefristet` erzeugten Datei (Test-Schlüssel über
`OHRGANIZE_LICENSE_PUBLIC_KEY` wie in `licenseSmoke.ts:20-25`).
`days_left: null` im Zustand `valid` war bisher nur bei `entwicklung`
möglich; alle Leser gehen über `remainingLabel` (null-sicher).

Abnahme: `npm run typecheck`; `npm test -w apps/backend`; `npm run
check:dashes -- --base v1.0.0` ohne Treffer; Sichtprüfung: Lizenzseite mit
unbefristeter Datei zeigt "Ihre Lizenz läuft unbegrenzt." und kein
Kulanzdatum.

### Phase 2: Lizenz v2 (4 PT)

Ziel: neue Felder, kompatibles Schema, Werkzeug und Ausstell-Baustein,
angepasste Monotonie, Audit bei Dateiwechsel.

- `packages/shared/src/license.ts`: `LicensePayload` mit `v: 1 | 2` und
  optionalen `edition`, `country`, `features`, `terms`, `headline`;
  `LicenseTerms`, `LICENSE_BILLING_LABELS` (`kostenfrei`, `Abonnement`,
  `Kauflizenz`, `individuelle Vereinbarung`), `LICENSE_INTERVAL_LABELS`;
  `LicenseStatus` um `edition`, `country`, `features`, `terms`, `headline`;
  `LicenseStatusPublic` um `features`; `LICENSE_ERROR_CODES.FEATURE_MISSING
  = 'LICENSE_FEATURE_MISSING'`; `LICENSE_V2_MIN_SERVER_VERSION`.
  `Edition` und `CountryCode` kommen aus `packages/shared/src/country.ts`
  (neu, in dieser Phase nur Typen und `COUNTRY_LABELS`).
- `apps/backend/src/core/licenseCodec.ts:52-80`: Schema nach B1.
- `apps/backend/src/core/licenseIssue.ts` (neu): `LicenseIssueInput`,
  `issueLicense(input, privateKey): { text, payload, version }` mit den
  Validierungen aus `license-tool.ts:139-170`, Payload-Bau `:189-204`,
  Vorgabenlogik B5, Gegenprobe `verifyLicenseText`. Keine Konsole, keine
  Dateizugriffe. `registerCsvLine(payload, filePath)` und
  `REGISTER_CSV_HEADER` (Header um `v;edition;country;features;billing;
  interval;headline`).
- `apps/backend/src/scripts/license-tool.ts`: `sign` bekommt `--edition`,
  `--country`, `--feature` (mehrfach), `--billing`, `--interval`,
  `--label`, `--headline`, `--laufzeit 3t|14t|1j` (Alias für `--until`);
  ruft `issueLicense`; warnt bei v2; `inspect` zeigt v2-Felder;
  Gedankenstriche raus.
- `apps/backend/package.json`: `exports` für `./core/licenseIssue`,
  `./core/licenseCodec`, `./core/licenseKeys` (für conspectus, Phase 8).
- `apps/backend/src/core/license.ts`: Monotonie nach B3; `licenseStatus()`
  liefert die neuen Felder; `licenseStatusPublic()` liefert `features`;
  Audit beim Einspielen um die Felder erweitern. Dateiwechsel-Audit:
  `loadLicenseFile` vergleicht `license_id` alt gegen neu (auch "Datei
  entfernt") und schreibt bei Änderung außerhalb von `installLicense`
  direkt `INSERT INTO audit_log (user_id, action, entity, details) VALUES
  (NULL, 'license.file_changed', 'license', ?)` (Tabelle
  `000_core.ts:40-48`, `audit()` verlangt ein Request-Objekt) sowie eine
  Warnzeile über `setLicenseLogger(app.log)` (in `server.ts` direkt nach
  der Fastify-Erzeugung).
- `apps/renderer/src/features/settings/LicensePage.tsx`: Facts "Ausgabe"
  (`COUNTRY_LABELS[country]`, Edition), "Vertrag" (`terms`), "Funktionen"
  (Badges; "alle" bei null), signierte `headline` nach C.
- `apps/backend/src/test/licenseSmoke.ts`: v2-Datei (Variante der
  Dev-Vorgabe, `terms` kostenfrei, `headline`) wird angenommen und in
  `GET /api/license` sichtbar; v1 mit v2-Feld abgelehnt (400, Meldung nennt
  `v`); v2 ohne `edition` abgelehnt; später ausgestellte kürzere Lizenz
  angenommen, gleichtägig kürzere weiter abgelehnt; Portal-Login liefert
  `Object.keys(license)` gleich `read_only,features` (Zeile 273 anpassen);
  Dateiwechsel erzeugt eine `audit_log`-Zeile mit `user_id NULL`.
- `docs/lizenzierung.md`: Abschnitt 3.2 um v2-Flags und Fälle (3-Tage-Test,
  kostenfrei unbefristet, Abo) erweitern; Hinweis Server vor Datei.

Risiken: `.strict()` plus `superRefine` ändert die Reihenfolge der
zod-Issues (`parseLicensePayload` nimmt `issues[0]`); Smoke prüft
Meldungen per Regex. Die Monotonie-Änderung in CHANGELOG nennen.

Abnahme: `npm test -w apps/backend`; `npm run lizenz -- sign … --billing
kostenfrei --until unbefristet --edition enterprise --country DE` erzeugt
v2, `inspect` zeigt die Felder; `sign` ohne v2-Flags erzeugt v1;
`check:dashes`.

### Phase 3: Feature-Gate (3 PT)

Ziel: Kundenfunktionen als Lizenzschalter, durchgesetzt im Backend,
gespiegelt in beiden Clients.

- `packages/shared/src/features.ts` (neu, siehe D).
- `apps/backend/src/core/featureGate.ts` (neu).
- `apps/backend/src/core/license.ts`: `effectiveFeatures()`.
- `apps/backend/src/server.ts`: Aufruf zwischen Zeile 188 und 190.
- `apps/renderer/src/auth/AuthContext.tsx`: `hasFeature(key)`.
- `apps/renderer/src/layout/nav.ts`, `AppShell.tsx`, `CommandPalette.tsx`,
  `dashboardConfig.ts`, `DashboardPage.tsx`, `App.tsx:68` wie unter D.
- `apps/web/src/auth/AuthContext.tsx`, `apps/web/src/layout/PortalShell.tsx`,
  `apps/web/src/lib/license.ts` wie unter D.
- `apps/backend/src/test/featureSmoke.ts` (neu): reine Funktion
  (Präfixtreffer, fail open, `'all'`); mit
  `overrideFeatureRegistryForTests([{ key: 'test.export', routes:
  ['/api/employees/export.csv'] }])`: v1-Lizenz erlaubt den Export,
  v2 ohne Feature liefert 403 `LICENSE_FEATURE_MISSING` ohne
  Gedankenstrich, v2 mit Feature 200, Testphase ohne Datei 200;
  Registry-Präfixe beginnen mit `/api/` und liegen nicht in
  `LICENSE_OPEN_ROUTES`. In `npm test` aufnehmen.
- `docs/lizenzierung.md`: Abschnitt "Funktionen (Feature-Schlüssel)";
  `CLAUDE.md`: Absatz Edition gegen Feature und Registry.

Risiken: ein zu breites Präfix (`/api/me`) sperrt das Portal; Präfixe nur
so konkret wie in `ROUTE_AREAS`.

Abnahme: `npm test -w apps/backend`, `npm run typecheck`, `check:dashes`.

### Phase 4: Varianten-Build (6 PT)

Ziel: zwei Varianten aus einem Stand, vier Bundles konsistent, Server und
App verwechseln nichts.

- `packages/shared/src/variants/index.ts`, `de-enterprise.ts`, `de-basic.ts`
  (neu, A1); `packages/shared/package.json` `exports` um `"./variants/*"`;
  `index.ts` exportiert `variants/index.ts` (nicht die Manifeste).
- `apps/backend/src/variants/de-enterprise.ts`, `de-basic.ts` (neu):
  `backendModules` (statische Imports, `meSalaryRoutes` nur bei
  compensation); `modules/index.ts` registriert `backendModules`;
  `modules/me/routes.ts:73` entfernt die Registrierung von
  `meSalaryRoutes`.
- `tsconfig.json` in backend, renderer, web, desktop: `paths`
  `"@variant"` auf die Enterprise-Verdrahtung (Desktop auf
  `../../packages/shared/src/variants/de-enterprise.ts`). Heute gibt es in
  keiner dieser Dateien `paths`; `baseUrl` bzw. `paths` ergänzen und mit
  `tsx` prüfen (`npm run dev`).
- `apps/backend/scripts/build.mjs` (neu): ersetzt den esbuild-String in
  `apps/backend/package.json:17`; liest `OHRGANIZE_VARIANT` (Vorgabe
  `de-enterprise`, prüft Existenz von `src/variants/<id>.ts`), esbuild mit
  `alias`, dieselben Optionen wie heute (`--define` des Test-Overrides,
  minify, keep-names, sourcemap external), Einstiege `server.ts`,
  `index.ts`, `scripts/backup.ts` (Phase 7 ergänzt `status.ts`,
  `admin-reset.ts`, `migrate-check.ts`). `"build": "node scripts/build.mjs"`.
- `apps/renderer/vite.config.ts`, `apps/web/vite.config.ts`:
  `resolve.alias['@variant']` aus `OHRGANIZE_VARIANT`.
- `apps/desktop/scripts/build.mjs:51-60`: `alias`; vor dem Kopieren
  (`:62-82`) Marker-Abgleich: `server.cjs` und `renderer/dist/assets/*.js`
  müssen den Marker der gewünschten Variante tragen, sonst Abbruch.
- `apps/desktop/electron-builder.yml`: `artifactName:
  oHRganize-Setup-${version}-${env.OHRGANIZE_VARIANT}.${ext}`; `dist:win`
  bekommt einen Vorlauf `node scripts/assert-variant-env.mjs`, damit die
  Variable im electron-builder-Prozess nie leer ist.
- `apps/desktop/src/main.ts`: `import { VARIANT } from '@variant'`; in
  `assertReachable` nach der Versionsprüfung der Variantenabgleich (A6).
- `apps/renderer/src/router.tsx`: `...variantRoutes` statt der neun
  Einzelimporte; `apps/renderer/src/variants/de-enterprise.ts`,
  `de-basic.ts` (neu).
- `apps/renderer/src/layout/nav.ts`: `NavSection.module?` und
  `NavItem.module?` (personal=employees, recruiting, abwesenheit=absences,
  leistung=performance mit `/fuehrung/*`-Einträgen=leadership,
  verguetung=compensation, kommunikation=communication, verwaltung=admin,
  system ohne Modul); `NAV_SECTIONS` wird zur gefilterten Sicht auf
  `ALL_NAV_SECTIONS` anhand `VARIANT.modules`. `AppShell.tsx` `NAV_KEYS` und
  `sidebarConfig.ts` arbeiten auf der gefilterten Liste; unbekannte
  Abschnitts-Keys im localStorage werden still ignoriert.
- `apps/renderer/src/features/dashboard/dashboardConfig.ts`: `module?` an
  Widgets und Kacheln, Filter in `widgetAllowed`/`statAllowed`,
  `DEFAULT_CONFIG` beim Laden gegen die Variante filtern.
- `apps/renderer/src/layout/TitleBar.tsx`: Badge mit `VARIANT.label`.
- `apps/web/src/variants/de-enterprise.ts`, `de-basic.ts` (neu):
  `portalRoutes` (SalaryPage nur bei compensation); `apps/web/src/App.tsx`
  nimmt Routen aus `@variant`; `PortalShell.tsx` NavItem `module?`, Filter.
- `apps/backend/src/server.ts:204-213`: `variant` in Health; Startprüfung
  `OHRGANIZE_VARIANT` in `config.ts` (Fehler wie bei CORS, `:151-164`).
- `apps/backend/src/core/licenseState.ts` und `license.ts`:
  Variantenabgleich (A5); `installLicense` 400-Meldung.
- `apps/backend/src/scripts/backup.ts`: MANIFEST-Zeile `Variante: <id>`.
- `scripts/check-variant.mjs` (neu): `--variant <id>`; prüft je Bundle
  (`apps/backend/dist/{server,cli,backup}.cjs`,
  `apps/renderer/dist/assets/*.js`, `apps/web/dist/assets/*.js`,
  `apps/desktop/dist/main.cjs`) Marker vorhanden, keine fremden Marker, und
  für `de-basic` die Abwesenheit der Routen-Strings ausgeschlossener
  Module (z. B. `/api/recruiting`, `/recruiting/pipeline`).
- `packages/shared/src/version.ts`: `MIN_SERVER_VERSION` und
  `MIN_CLIENT_VERSION` erst im Release-Commit auf die Version dieses
  Releases anheben, nicht im Feature-Commit.
- `apps/backend/src/test/variantSmoke.ts` (neu): Health trägt `variant`;
  v2-Lizenz mit `edition: 'basic'` wird abgelehnt (400, Meldung nennt beide
  Ausgaben) und im Datenverzeichnis als `invalid_reason` gemeldet, ohne die
  laufende Testphase zu beenden; `OHRGANIZE_VARIANT=at-enterprise` lässt
  `buildServer` scheitern. Desktop: manueller Start gegen einen
  Fake-Health-Server mit falscher Variante ergibt die Variantenmeldung.
- Doku: `CLAUDE.md` (Abschnitt "Varianten": Alias, Verdrahtungsdateien,
  Schema-Regel, Dev-Vorgabe, neue Module müssen in beide
  Verdrahtungsdateien), `docs/entscheidungen.md` (Eintrag "Varianten als
  getrennte Builds über Alias").

Risiken: tsx muss `paths` auflösen (mit `npm run dev` prüfen). Fastify
beantwortet Routen ausgeschlossener Module mit 404 oder, wenn der Hook
zuerst greift, mit 403 aus `permissions.ts:157-160`; beides ist
geschlossen. `ROUTE_AREAS` bleibt vollständig.

Abnahme: `OHRGANIZE_VARIANT=de-basic npm run build && node
scripts/check-variant.mjs --variant de-basic` und dasselbe für
`de-enterprise`; `npm run typecheck`; `npm test -w apps/backend` inkl.
`variantSmoke`; alle neun Modul-Smokes grün mit Vorgabe-Variante;
`OHRGANIZE_VARIANT=de-basic npx tsx
apps/backend/src/modules/recruiting/smoke.ts` schlägt erwartungsgemäß fehl
und wird in der Doku als "nur enterprise" markiert; `check:dashes`.

### Phase 5: Länder-Dimension (6 PT)

Ziel: Land und Region als Daten, ohne zweites Land freizuschalten;
Duplikate weg; Adapter-Registry.

- `packages/shared/src/country.ts` füllen, `common.ts` (`formatMoney`,
  Aliasse), `employees.ts` (Kataloge je Land, Accessoren).
- `apps/backend/src/core/holidays.ts` (Regeln als Daten, Signaturen,
  Cache-Key), `settingsRoutes.ts` (Validierung, `/api/regions`, Alias),
  `settings.ts` (kein `country`-Schlüssel; Kommentar zu
  `defaultBundesland`), `permissions.ts:70`.
- `modules/absences/service.ts` (`regionForEmployee`,
  `companyRegionDefaults`, SQL-Konstante, `CountOptions`),
  `absences/routes.ts:524-533, 833-850, 883-889`,
  `modules/me/calendarRoutes.ts:77-89, 121-127`, `modules/me/routes.ts:210-218`
  (Antwortfeld `bundesland` bleibt aus Kompatibilität, zusätzlich `region`
  und `country`), `modules/employees/validation.ts:77-106, 168-177`
  (Region gegen `regionCodesFor(VARIANT.country)`, `country` im
  Location-Schema mit Vorgabe Variantenland), Seed.
- `apps/backend/src/db/migrations/100_employees.ts`: Eintrag
  `107_locations_country`.
- `modules/compensation/payrollExport/index.ts`, `lodas.ts` (neu),
  `payrollRoutes.ts:297-302, 355-375, 501-546`;
  `modules/compensation/certificates/de.ts` (neu),
  `certificateRoutes.ts:18-23, 39-129`.
- `apps/renderer/src/lib/locale.ts`, `apps/web/src/lib/locale.ts` (neu);
  `employeeForm.tsx` (Accessoren, Felder ohne Katalog ausblenden),
  `SettingsPage.tsx:73-74` (Regionsliste über `/api/regions`), die zwölf
  `'de-DE'`-Dateien beim Anfassen auf `LOCALE`.
- `apps/backend/src/test/holidaysTest.ts` (neu): vergleicht
  `holidaysForYear(year, 'DE', land)` gegen die Fixture aus Phase 0 für
  alle 128 Kombinationen; Cache-Key-Test mit zwei Ländern hintereinander.
  In `npm test` aufnehmen. `absences/smoke.ts` und `me/smoke.ts` bleiben
  unverändert grün (Regression der COALESCE-Zusammenlegung).
- `apps/backend/openapi/employees.paths.yaml`, `base.yaml`: `/api/regions`,
  `country`-Felder.
- Doku: `docs/modul-kontrakte.md` (locations.country, private_country,
  Regionsbegriff), `CLAUDE.md` (Land aus Variante, Regionen, Adapter).

Reihenfolge: Fixture-Test zuerst gegen den alten Code laufen lassen (muss
grün sein), dann shared, dann holidays-Refactor (Test weiter grün), dann
Regionen und SQL, Migration, Adapter, Frontends.

Risiken: Jahresweichen (2017, 2018, 2019, 2023) exakt in Datenform
übertragen; die Fixture fängt jeden Fehler. Die COALESCE-Zusammenlegung
ändert Spaltenaliasse: Antwortfeld `bundesland` in den Kalender-APIs
beibehalten und `region` zusätzlich liefern, Umstellung der Clients
getrennt.

Abnahme: `npm test -w apps/backend` (inkl. holidaysTest), Modul-Smokes
absences, me, employees, compensation; `npm run typecheck`; Migration 107
gegen die Dev-DB (`SELECT country FROM locations` liefert `DE`);
`check:dashes`.

### Phase 6: Release, Version, Kanal (5 PT)

Ziel: ein Befehl baut alle Varianten eines Releases, signiert das Manifest
und legt alles kanal- und variantensauber ab.

- `packages/shared/src/version.ts:42-77`: `parseVersion` mit Vorabkennung,
  `compareVersions`, `channelOf`; `apps/backend/src/test/smoke.ts` um
  Vergleichsfälle erweitern (`1.1.0-beta.1 < 1.1.0`, `beta.2 > beta.1`,
  `isAtLeast` fail closed).
- `apps/backend/src/server.ts`: `channel: channelOf(APP_VERSION)` in Health;
  `TitleBar.tsx`: Kanal-Badge.
- `scripts/release-server.mjs`: `--variant <id>` (Vorgabe env), Archivname
  mit Land und Edition, `--out`, `release.json` (unsigniert) und
  `VARIANTE.txt` im Archiv, LIESMICH mit Variante und Prüfschritt,
  Sourcemap-Namen mit Variante, Aufnahme von `status.cjs`,
  `admin-reset.cjs`, `migrate-check.cjs` (ab Phase 7), `--define`-Prüfung
  über alle cjs.
- `scripts/release.mjs` (neu, siehe F): Argumente `--version`,
  `--variants`, `--no-desktop`, `--sign-key`; Reihenfolge: sauberer Baum,
  CHANGELOG-Eintrag vorhanden, `npm version`, Commit "release: Version X",
  Tag, je Variante Build plus Archiv plus Installer plus `check-variant`,
  Manifest, `ssh-keygen -Y sign -f <key> -n ohrganize-release
  release.json`, Zusammenfassung; am Ende `npm rebuild better-sqlite3`
  (dist:win baut die ABI um, siehe CLAUDE.md).
- `deploy/ohrganize-release.allowed_signers` (neu), `deploy/README.md`
  (Abschnitte 6 und 9.6: Variantenprüfung, Signaturprüfung mit
  `ssh-keygen -Y verify`), `deploy/windows/README.md:370-398`,
  `CHANGELOG.md`.
- Root `package.json`: `"release": "node scripts/release.mjs"`;
  `"release:server"` behält die Einzelvariante.

Risiken: `npm version --workspaces` erwartet identische Versionen in allen
sechs `package.json` (heute erfüllt); `package-lock.json` wandert mit in
den Commit. `electron-builder` braucht `OHRGANIZE_VARIANT` im selben
Prozess: `release.mjs` setzt sie vor `spawnSync`.

Abnahme: `node scripts/release.mjs --version 1.1.0-beta.1 --variants
de-enterprise,de-basic --no-desktop` erzeugt zwei Archive, zwei
`release.json`, Signaturen prüfbar mit `ssh-keygen -Y verify`;
`check-variant` je Variante grün; `npm test -w apps/backend`; Health der
gestarteten Beta meldet `channel: 'beta'`.

### Phase 7: Hosting-Härtung und Betreiberwerkzeuge (8 PT)

Ziel: die Blocker vor dem ersten Hosting-Kunden schließen, provision.sh
ausbauen, Werkzeuge nie als root.

Backend:
- `apps/backend/src/config.ts`: `quietInitialPassword`
  (`OHRGANIZE_QUIET_INITIAL_PASSWORD=1`); `core/auth.ts:153-167`: bei quiet
  nur Dateihinweis im Journal.
- `apps/backend/src/db/migrate.ts`: `migrateDatabase(db): string[]`
  extrahieren; `migrate()` ruft sie mit `getDb()`.
- `apps/backend/src/scripts/status.ts` (neu): `--data-dir <pfad> [--json]`,
  KEIN Import von `config.ts` (der Import legt Verzeichnisse an und erzeugt
  `secret.key`, `config.ts:17-20, 89-94`); öffnet `ohrganize.db` `readonly,
  fileMustExist` (wie `backup.ts:173`), liest `installation`,
  `_migrations`, Zählungen, Lizenzdatei über `verifyLicenseText`, Zustand
  über `deriveLicenseState` (`enforced: true`, `clockWarning` aus
  `last_seen_date` ohne Schreiben), `VARIANT.id`, `APP_VERSION`; verweigert
  den Lauf als root.
- `apps/backend/src/scripts/admin-reset.ts` (neu): `--data-dir --email`,
  schreibt `password_hash`, `must_change_password = 1`,
  `sessions_valid_from`, Audit-Zeile mit `user_id NULL`, gibt das Passwort
  einmal aus; verweigert root; kein config-Import.
- `apps/backend/src/scripts/migrate-check.ts` (neu): `--db <pfad>`; Kopie
  per `db.backup()` in ein temporäres Verzeichnis, `migrateDatabase` auf
  der Kopie, Ausgabe der anstehenden Migrationen, Aufräumen, Exit 0/1.
- `apps/backend/scripts/build.mjs`: die drei Einstiege; `release-server.mjs`
  nimmt sie ins Archiv.
- `apps/backend/src/scripts/backup.ts:105-135`: `restoreSteps()`
  instanzbewusst; MANIFEST-Hinweis "Lizenzdatei nach dem Restore erneut
  ablegen (`provision.sh lizenz`)", weil der Dateiwächter keine Monotonie
  prüft und ein alter Stand eine ältere Datei still zurückbringt.

Deploy:
- `deploy/ohrganize-backend@.service`: Pfade über Symlink (G),
  `TemporaryFileSystem` und `BindPaths`, Ressourcengrenzen;
  `deploy/ohrganize-backup@.service`: gleiche Pfade, `TemporaryFileSystem=
  /var/lib/ohrganize:ro /var/backups/ohrganize:ro`, `BindPaths=
  /var/lib/ohrganize/%i /var/backups/ohrganize/%i`. Kommentar "gemessen auf
  Debian 13 am <Datum>" erst nach dem Testlauf.
- `deploy/ohrganize-kunde.env.example`: `OHRGANIZE_VARIANT=__VARIANTE__`,
  `OHRGANIZE_QUIET_INITIAL_PASSWORD=1`; `deploy/ohrganize.env.example`:
  beide Variablen dokumentiert.
- `deploy/nginx-wildcard.conf:187`: `root /srv/ohrganize-web/kunden/$host;`,
  `error_page 502 503 /wartung.html` mit statischer Seite
  `deploy/wartung.html` (für `pausieren`).
- `deploy/ohrganize-provision.sh`: Einstellungen `RELEASE_VERZ`,
  `KUNDEN_VERZ`, `WEB_VERZ`; `anlegen <kunde> [--variante <id>]
  [--release <version>]` (Symlinks, env mit Variante); `liste` mit Fix
  `find -mindepth 1 -maxdepth 1 -type d -name 'ohrganize-[0-9]*'`
  (Zeile 272); neue Unterbefehle `status [--json]`, `lizenz <kunde>
  <datei>` (0600 als Dienstbenutzer, danach Zustand aus `status.cjs`),
  `id <kunde>`, `pin` (SPKI-Pin aus `fullchain.pem`, Befehl aus
  `deploy/nginx.conf`), `passwort <kunde> [--loeschen]` (Datei zeigen,
  sonst `admin-reset.cjs`), `pausieren`, `fortsetzen`, `restore <kunde>
  <ordner>`, `check` (Symlink-Ziele, env-Variante gleich Release-Variante
  gleich Health-Variante, Ports gegen Map, Sicherung jünger als 2 Tage,
  Platz, `systemd-analyze verify`). Alle Node-Werkzeuge über `runuser -u
  "$DIENST_BENUTZER" --`. Gedankenstriche raus.
- `deploy/ohrganize-update.sh` (neu, siehe G) und gemeinsame Bibliothek
  `deploy/ohrganize-lib.sh`, damit Pfade nur einmal stehen.
- `deploy/README.md`: Abschnitt 9 auf das neue Layout (Ersteinrichtung
  `releases/`, `kunden/`, Web-Symlinks, Update über `ohrganize-update.sh`,
  Restore je Instanz, Leseisolation, Grenzen, Messwerte); Abschnitte 5 und 6
  Einzelkunde unverändert plus Variantenprüfung.
- `docs/inbetriebnahme.md`: Restore-Probe verweist auf `provision.sh
  restore`.

Risiken: `TemporaryFileSystem` verdeckt `StateDirectory`; Reihenfolge der
Mounts auf dem Testserver prüfen (`systemd-analyze security`, Start,
Sicherung, Restore, Journal). `migrate-check` auf großen Datenbanken dauert;
Ausgabe mit Fortschritt.

Abnahme (Testserver, Protokoll in `deploy/README.md` 9.7 fortschreiben):
zwei Instanzen anlegen (je Variante eine), `status --json` liefert beide mit
Variante, Release und Lizenzzustand; `lizenz` ohne Neustart wirksam; `id`,
`pin`, `passwort` als root ohne root-eigene `-wal`-Dateien im
Datenverzeichnis; Isolation: aus der Unit heraus zeigt ein Verzeichnislauf
nur die eigene Instanz; Update auf ein Beta-Release mit absichtlich
falscher Variante wird verweigert, mit richtiger Variante läuft es durch;
Rückweg mit einer absichtlich brechenden Migration (Testbuild) führt auf
das alte Release mit intakter Datenbank; Restore je Instanz; `check` ohne
Befund. Lokal: `npm test -w apps/backend`, `npm run typecheck`,
`check:dashes`, `release-server.mjs` enthält die drei neuen cjs.

### Phase 8: conspectus und Anbieterdoku (8 PT)

Ziel: Register und Werkzeug des Anbieters, das Lizenzen ausstellt,
Instanzen kennt, Releases erfasst und Rollouts führt.

- Root `package.json`: `workspaces` um `tools/*`, Skript
  `"conspectus": "npm run conspectus -w tools/conspectus --"`.
- `tools/conspectus/package.json` (`@ohrganize/conspectus`, deps
  `better-sqlite3`, `zod`, `@ohrganize/shared`, `@ohrganize/backend`; dev
  `tsx`, `typescript`), `tsconfig.json`, `src/index.ts` (Befehlsverteiler,
  `parseArgs` wie license-tool), `src/db.ts` (Pfadregel:
  `OHRGANIZE_CONSPECTUS_DIR` Pflicht, verweigert Pfade unter dem Repo-Root
  und Pfade mit `onedrive` in `realpathSync`), `src/schema.ts` (Tabellen
  `kunden, hosts, instanzen, lizenzen, releases, rollouts, vorgaenge`;
  Zahlungen als `vorgaenge.art = 'zahlung'`), `src/commands/{kunde, host,
  instanz, lizenz, bericht, status, check, release, rollout, uebersicht,
  html, csvImport, zahlung}.ts`, `src/ssh.ts` (`spawnSync('ssh', [...])`
  und `scp` mit Argument-Arrays, `BatchMode=yes`, nie ein Shell-String),
  `src/report.ts` (HTML-Übersicht als statische Datei).
- `lizenz ausstellen`: Flags wie das Werkzeug plus `--kunde`, `--instanz`;
  liest `installation_id`, Variante, Version aus dem Register; verweigert
  v2 unter `LICENSE_V2_MIN_SERVER_VERSION` und Variantenwidersprüche; ruft
  `issueLicense`; schreibt die Datei unter `$DIR/lizenzen/<kunde>/`;
  Registerzeile; optional `--einspielen` (scp plus `provision.sh lizenz`).
  `lizenz verlaengern`, `lizenz faellig [--tage 45]`, `bericht importieren
  <json>`, `status --host`, `release erfassen` (liest `release.json`, prüft
  Signatur), `rollout --release <v> --variante --kanal [--host|--kunde]
  [--probelauf]` (scp Archiv, ssh `ohrganize-update.sh`, `rollouts`-Zeilen
  mit Protokoll), `check` (Instanzen ohne gültige Lizenz, Lizenz läuft in
  unter 30 Tagen aus, Instanzversion älter als jüngstes Release ihres
  Kanals, Rollouts offen), `uebersicht`, `html --out`, `csv-import kunden
  <csv>`, `zahlung importieren <csv>`.
- `apps/backend/src/scripts/license-tool.ts` bleibt als schlanke
  Alternative ohne Register; Hinweis auf conspectus im Kopf.
- `docs/betrieb-anbieter.md` (neu): Schlüssel und Geheimnisse
  (Lizenzschlüssel, Release-Schlüssel, Passphrasen, Ablageorte, Rotation),
  Lizenzfälle (3-Tage-Test, kostenfrei unbefristet, Abo, Kauf,
  Kundenfeature, Verlängerung, Variantenwechsel), Release bauen und
  veröffentlichen, Rollout im Hosting, Einzelkunde (Archiv und Installer
  verschicken, Variantenhinweis), Störungen (Lizenzdatei unbrauchbar, Uhr,
  Nur-Lese, falsche Variante), Restore, Kündigung und Datenherausgabe.
- `tools/conspectus/src/test/smoke.ts`: Wegwerf-Register in `os.tmpdir()`,
  Kunde und Instanz anlegen, Lizenz ausstellen (Test-Schlüsselpaar), Datei
  mit `verifyLicenseText` prüfen, `faellig`, `check`, HTML erzeugen,
  Pfadregel (Repo-Pfad wird verweigert). Root-`npm test` läuft über
  `--workspaces --if-present` automatisch mit.

Abnahme: `npm run conspectus -- --help`; Smoke grün; Durchstich auf dem
Testserver: `kunde anlegen`, `instanz anlegen --host test`, `status --host
test`, `lizenz ausstellen … --einspielen`, `release erfassen`, `rollout
--probelauf`, `uebersicht`, `html`; `check:dashes`.

## 4. Arbeitsregeln für die Ausführung

- Je Phase ein eigener Branch `feat/phase-<n>-<kurzname>`, ein oder wenige
  Commits, Commit-Text auf Deutsch ohne Gedankenstriche. Nach jeder Phase:
  `npm run typecheck`, `npm test`, `npm run check:dashes -- --base main`.
- Bestandsinstallationen dürfen nie brechen: v1-Dateien bleiben in jeder
  Phase gültig, `licenseKeys.ts` bleibt unangetastet, Feature-Vorgabe ist
  "alles an", die Variantenprüfung greift nur bei v2-Dateien, Migration 107
  ist additiv, `MIN_*`-Versionen werden erst mit dem ersten
  Varianten-Release angehoben.
- Jede neue Migration nur additiv im vorgesehenen Nummernkreis; das
  Datenbankschema bleibt variantenunabhängig.
- Neue Module tragen sich in `ROUTE_AREAS`, in beide Verdrahtungsdateien
  je App und ggf. in `FEATURES` ein.
- `CLAUDE.md` wird in Phase 3, 4 und 5 um die dort genannten Absätze
  ergänzt; `docs/entscheidungen.md` bekommt je Phase einen Eintrag mit
  Begründung.
- Keine neuen npm-Abhängigkeiten ohne Abstimmung (docs/modul-kontrakte.md).
- Texte: Deutsch, ohne Gedankenstriche, kurze Sätze; Ausnahmen nur die
  drei UI-Konventionen aus Abschnitt 0.

## 5. Offene Punkte für den Anbieter

1. **Inhalt der Edition basic.** Vorschlag: `employees, absences, admin,
   me` (das Portal braucht Abwesenheiten); enterprise = alle neun Module.
2. **Kanalnamen.** Vorschlag: nur `stable` und `beta`, Beta ausschließlich
   als `-beta.N`-Version.
3. **appId und productName je Variante.** Empfehlung: gleich lassen (A7).
4. **Vorgaben für Testlizenzen** (B5) bestätigen: `grace_days = 0`,
   `warn_days = min(30, Laufzeit / 2)`, Kurzformen `3t`, `14t`, `1j`.
5. **Signaturschlüssel für Releases.** Eigener SSH-Ed25519-Schlüssel
   (Empfehlung), Ablageort und Passphrasenregel.
6. **Download-Hosting** für `releases/<kanal>/<variante>/`.
7. **Ressourcengrenzen und Isolationsstufe** nach Messung.
8. **Monotonie-Lockerung** (B3) bestätigen.
9. **Ab wann standardmäßig v2 ausgestellt wird** (wenn alle Bestandsserver
   aktualisiert sind).
10. **Erste AT- und CH-Inhalte** sind bewusst nicht Teil dieses Plans; Phase
    5 legt nur die Strukturen.
11. **Windows-Server im Hosting:** Phase 7 zielt auf Linux; für
    Windows-Einzelkunden bleibt der manuelle Update-Weg mit
    Variantenprüfung.

## 6. Uebergabe: Stand und verbindliche Vorgaben fuer die Fortsetzung

Stand 15.09.2026, Phasen 0 bis 4 auf `main` gemerged (letzter Merge
`b318f07`), Version bleibt 1.0.0. Wer hier weitermacht (lokal oder in einer
Cloud-Sitzung), liest zuerst `CLAUDE.md` (Abschnitte Lizenz, Edition gegen
Feature, Varianten) und `docs/entscheidungen.md` (die letzten sechs
Eintraege) und arbeitet dann Phase 5 bis 8 dieses Plans ab.

Vorgaben des Anbieters aus der Umsetzung, die den Plan ergaenzen oder
uebersteuern:

1. Keine Editionen oder Tarife hardcoden. Das Register
   `packages/shared/src/variants/registry.json` enthaelt genau
   `de-vollversion`; Basic, Enterprise oder andere Tiers sind NICHT
   festgelegt. Es muss nur moeglich sein, sie anzulegen (Eintrag im
   Register, `npm run variants:gen`).
2. Testlizenzen haben eine frei waehlbare Laufzeit (`--until 3t`, `6w`,
   `1j`, Datum, `unbefristet`); 3 oder 30 Tage waren Beispiele.
3. Gedankenstriche im Bestand bleiben (der Anbieter entfernt sie selbst);
   neue duerfen nicht dazukommen: `npm run check:dashes -- --base main`
   prueft nur hinzugekommene Zeilen.
4. Je Phase ein Branch `feat/phase-<n>-<kurzname>`, Abnahme mit
   `npm run typecheck`, `npm test -w apps/backend`, allen neun Modul-Smokes
   (`npx tsx apps/backend/src/modules/<modul>/smoke.ts`),
   `npm run variants:check`, `npm run check:dashes -- --base main`; danach
   Merge nach `main` mit `--no-ff`.
5. Neuer Build und Installer erst nach Abschluss aller Phasen, Version
   bleibt gleich; `MIN_*`-Versionen nicht anheben.
6. Alles direkt Windows-faehig: Skripte in Node oder PowerShell 5.1,
   Betreiberwerkzeuge (Phase 7) ohne `process.getuid` auf Windows, ein
   Windows-Gegenstueck zum Update-Skript (`deploy/windows/update-server.ps1`
   mit Varianten- und Signaturpruefung); Linux-Hosting bleibt Phase 7 wie
   geplant.
7. Mindestserverversion fuer Lizenz v2 gibt es nicht; stattdessen melden
   `/api/health` und der Lizenzbericht `license_format` (2). conspectus
   prueft diese Faehigkeit, nicht die Versionsnummer.

Abweichungen der Umsetzung vom Plan, die fuer die Folgephasen zaehlen:
Verdrahtungsdateien werden erzeugt (`scripts/variant-wiring.mjs`), nicht
von Hand geschrieben; es gibt zwei Aliasse (`@variant`,
`@variant-manifest`); `apps/backend/scripts/build.mjs` baut automatisch
auch `src/scripts/status.ts`, `admin-reset.ts` und `migrate-check.ts`,
sobald sie existieren; `apps/desktop/scripts/dist.mjs` setzt
`OHRGANIZE_VARIANT` fuer electron-builder; Health traegt `variant` und
`license_format`.
