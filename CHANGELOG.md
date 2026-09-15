# Aenderungsprotokoll

Alle nennenswerten Aenderungen an oHRganize stehen hier, neueste zuerst.
Das Format folgt "Keep a Changelog"; die Versionsnummer folgt Semver
(`1.2.0` ist Kanal `stable`, `1.2.0-beta.1` ist Kanal `beta`). Jede
Version, die mit `scripts/release.mjs` gebaut wird, braucht hier einen
eigenen Abschnitt.

## Unveroeffentlicht

### Hinzugefuegt (Varianten)
- Varianten als getrennte Builds (Land x Edition): Register
  `packages/shared/src/variants/registry.json` (Editionen frei
  definierbar, keine feste Liste), erzeugte Verdrahtungsdateien je App
  (`npm run variants:gen` / `variants:check`), Aliasse `@variant` und
  `@variant-manifest`, Builds je Variante ueber `OHRGANIZE_VARIANT`,
  Bundle-Pruefung `npm run check:variant`. Health meldet die Variante, die
  Desktop-App prueft sie beim Start, das Backend beim Start gegen
  `OHRGANIZE_VARIANT`, v2-Lizenzen fremder Ausgabe werden abgelehnt.
  Installername `oHRganize-Setup-<version>-<variante>.exe`; Sicherungen
  nennen die Variante im MANIFEST. Heute gibt es genau `de-vollversion`.

### Hinzugefuegt (Release und Kanal)
- Der Kanal ist eine Funktion der Version: `channelOf` in
  `packages/shared/src/version.ts` (`1.2.0` = stable, `1.2.0-beta.1` = beta),
  `CHANNELS` und `CHANNEL_LABELS`. `/api/health` meldet `channel`, die
  Titelleiste zeigt eine Beta als Abzeichen.
- `npm run release -- --version <v> [--variants a,b] [--no-desktop]
  [--sign-key <pfad>]`: setzt die Version ueber alle Workspaces, committet und
  taggt, baut je Variante Bundles, Server-Archiv und Installer, prueft die
  Bundles mit `check-variant` und schreibt je Variante ein `release.json` mit
  Pruefsummen aller Artefakte, signiert mit `ssh-keygen -Y sign`
  (Namensraum `ohrganize-release`, Vertrauensanker
  `deploy/ohrganize-release.allowed_signers`). Ablage:
  `release/<version>/<kanal>/<variante>/`. Zum Schluss `npm rebuild
  better-sqlite3`, weil electron-builder die ABI umbaut.
- `npm run release:server` kennt `--variant` und `--out`; der Archivname
  traegt Land und Edition (`ohrganize-server-de-vollversion-1.2.0.zip`), das
  Archiv enthaelt `VARIANTE.txt` und ein unsigniertes `release.json`, und die
  LIESMICH beginnt mit dem Schritt "Variante pruefen".

### Hinzugefuegt (Laender)
- Land und Region sind eine Datendimension: `packages/shared/src/country.ts`
  haelt Regionen, Sprachkennung, Waehrung und Regionsbegriff je Land; das
  Land einer Installation kommt aus der Variante, nicht aus einer
  Einstellung. Feiertage stehen als Regeltabelle je Land
  (`HOLIDAY_RULES`), Beschaeftigungsarten, Steuerklassen und
  Kirchensteuermerkmale als Kataloge je Land. Neue Route
  `GET /api/regions[?country=]` (`/api/bundeslaender` bleibt als Alias).
  Lohnexport und Bescheinigungen laufen ueber Adapter-Registrys
  (`payrollExport/`, `certificates/`), die Route `/export.datev` bleibt.
  Migration `107_locations_country` (additiv: `locations.country`,
  `employees.private_country`). AT und CH bekommen Strukturen, keine
  Inhalte.
- Kalender- und Vorschau-Routen liefern neben `bundesland` zusaetzlich
  `region` und `country`; `bundesland` bleibt aus Kompatibilitaet.
- `formatMoney(cents, locale, currency)` in `@ohrganize/shared`;
  `formatEuro` ist die Huelle dafuer. Beide Clients haben ein
  `lib/locale.ts` mit `LOCALE`, `CURRENCY`, `REGIONS` und `REGION_TERM`.

### Hinzugefuegt (Feature-Schluessel)
- Feature-Gate: Funktionen innerhalb eines Builds koennen ueber die Lizenz
  (`features`) freigeschaltet werden. Registry `packages/shared/src/features.ts`
  (zu Beginn leer), Durchsetzung im globalen Hook
  (`403 LICENSE_FEATURE_MISSING`), Navigation und Widgets beider Clients
  folgen der Lizenz. Ohne einschraenkende Lizenz ist alles an.

### Geaendert
- Die Versionsordnung kennt Vorabkennungen: `1.1.0-beta.1` ist AELTER als
  `1.1.0`, `beta.2` neuer als `beta.1`. Damit wird `isAtLeast('1.1.0-beta.1',
  '1.1.0')` falsch; solange eine Beta derselben Nummer im Umlauf sein soll,
  muss `MIN_CLIENT_VERSION` auf die Beta zeigen.
- Update-Anleitungen (Linux und Windows) beginnen mit dem Schritt
  "Variante pruefen" und beschreiben die Signaturpruefung des Release-Manifests.
- Lizenz v2: Dateien koennen Ausgabe (`edition`, `country`), Funktionen
  (`features`), Vertragsbedingungen (`terms`) und eine signierte
  Ueberschrift (`headline`) tragen. v1-Dateien bleiben gueltig. Werkzeug:
  neue Flags `--edition`, `--country`, `--feature`, `--billing`,
  `--interval`, `--label`, `--headline`, `--v2` und Laufzeiten
  `--until 3t|2w|6m|1j`.
- Monotonie beim Einspielen haengt nur noch am Ausstelltag: Eine spaeter
  ausgestellte Datei wird angenommen, auch wenn sie kuerzer laeuft (bisher
  wurde jede kuerzere Datei abgelehnt). Gleichtaegig bleibt "nicht kuerzer".
- `/api/health` und der Lizenzbericht melden `license_format` (2).
- Ein Tausch der Lizenzdatei im Datenverzeichnis ohne Upload erzeugt eine
  Audit-Zeile `license.file_changed` (user_id NULL) und eine Journalzeile.
- Lizenztexte kommen fuer Desktop-App, Portal und Backend aus einer
  Funktion (`describeLicense` in `packages/shared`). Unbefristete Lizenzen
  melden `perpetual = true`, keinen Countdown und kein Kulanzdatum mehr
  (bisher "Kulanz bis 14.01.3000"). `kind = evaluation` heisst in der
  Oberflaeche "Testlizenz". Neues Feld `issued_at` im Lizenzzustand.
- Der Zustandsautomat der Lizenz ist eine reine Funktion
  (`core/licenseState.ts`), tabellengetrieben geprueft.

### Hinzugefuegt
- `scripts/check-dashes.mjs` und `npm run check:dashes`: prueft neue Zeilen
  auf Gedankenstriche (drei UI-Konventionen bleiben erlaubt).
- Feiertags-Fixture `apps/backend/src/test/fixtures/holidays-de.json` mit
  Regressionstest `npm run test:holidays` (128 Kombinationen aus 8 Jahren
  und 16 Regionen).
- Umsetzungsplan `docs/umsetzungsplan-varianten-lizenz.md` fuer Varianten,
  Lizenz v2, Feature-Schluessel, Laender, Kanaele, Hosting und conspectus.

## 1.0.0 (2026-09-13)

Erste Auslieferung: Desktop-App (Electron) fuer die Personalabteilung und
Mitarbeitenden-Portal (Web) auf demselben Backend (Fastify, SQLite).
Signierte Offline-Lizenz mit Testphase, Warnfrist, Kulanz und
Nur-Lese-Betrieb; Serverauslieferung als Release-Archiv mit systemd-Units
(Linux) und PowerShell-Einrichtung (Windows).
