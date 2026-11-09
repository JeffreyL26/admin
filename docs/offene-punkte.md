# Offene Punkte

Bewusst zurückgestellte Arbeiten mit Kennung, damit sie auffindbar bleiben.
Jeder Eintrag nennt Befund, Wirkung, Vorschlag und warum er warten darf.
Erledigte Punkte wandern ins CHANGELOG und werden hier gestrichen.
Kennungen: `PERF-n` Performance, `FT-n` geplante Funktion (mit Plan und
Aufgaben der Beteiligten).

Messbasis der Zahlen (Performance-Prüfung vom 05.10.2026): synthetischer
Bestand mit 2000 aktiven und 600 ausgeschiedenen Personen, sechs Jahren
Historie (221 000 Abwesenheitsanträge, 120 000 Abrechnungspositionen,
500 000 Audit-Zeilen), Datenbank eingerichtet wie im Betrieb (SQLCipher, WAL,
`synchronous = FULL`, `secure_delete`), gemessen auf einem Büro-Notebook.
Die Werte zeigen Größenordnungen.

## PERF-1: Backend der Desktop-App im Electron-Hauptprozess

**Befund.** `apps/desktop/src/main.ts` lädt `server.cjs` per `require` in den
Hauptprozess und ruft dort `startServer(0)` auf (bewusst so entschieden,
docs/entscheidungen.md, „Desktop-Stack“). Derselbe Prozess bedient Fenster,
Titelleiste, IPC und das `ohrganize://`-Protokoll. better-sqlite3 arbeitet
synchron; jede längere Arbeit des Backends hält deshalb auch das Fenster an
(Ziehen, Minimieren, Titelleistenmenü). Das Fenster entsteht außerdem erst,
wenn das Backend gestartet ist (`main.ts`, `startBackend()` vor dem Fenster),
ohne Ladeanzeige.

**Wirkung.** Betroffen ist nur der Einzelplatzbetrieb (eingebettetes
Backend); mit Serveradresse startet kein Backend in der App. Spürbar bei:
- Rechenseiten aus PERF-2 (bis 1,5 s);
- Umfrageende mit vielen Antworten (Neuaufbau der Antworttabelle, 1,5 bis
  4,4 s bei 50 000 Antworten; im Einzelplatzbetrieb ohne Portal selten);
- erstem Start nach einem Update: Migrationen, VACUUM nach Migrationen,
  einmalige Umstellung auf Verschlüsselung; so lange ist gar kein Fenster zu
  sehen (Sekunden bis Minuten je nach Datenmenge).

**Vorschlag.** Backend per `utilityProcess.fork()` (Electron-Bordmittel) in
einen eigenen Prozess legen; der Port kommt per `parentPort.postMessage`
zurück, ein `StartupError` als Nachricht. better-sqlite3 läuft dort mit
derselben Electron-ABI. Dazu sofort ein schlichtes Ladefenster, das nach dem
Start gegen das Hauptfenster getauscht wird. Berührt Start, Fehlerdialoge,
Beenden (Datenbank sauber schließen) und den Desktop-Build.

**Warum zurückgestellt.** Eingriff in den Start der App, bisher keine
Probleme im Betrieb, noch keine Kundeninstallation. Wieder aufgreifen, sobald
Rückmeldungen über eingefrorene Fenster kommen oder ein Einzelplatzkunde mit
mehreren hundert Personen Umfragen nutzt.

## PERF-2: Rechenintensive Übersichten

**Befund.** Drei Seiten rechnen bei jedem Aufruf über den ganzen Bestand,
synchron im einzigen Backend-Prozess (alle anderen Anfragen warten so lange):

| Seite | Route | Dauer | Ursache |
|---|---|---|---|
| Saldo-Übersicht | `absences/routes.ts`, `computeBalance` (`service.ts`) | 1,2 bis 1,5 s | reines JS: je Person die Übertragskette bis zu fünf Jahre zurück, jeder Antrag Tag für Tag mit Feiertagsprüfung |
| Abrechnungsläufe | `compensation/payrollRoutes.ts`, Liste der Läufe | 0,9 bis 1,0 s | summiert bei jedem Aufruf alle `payroll_items` aller Läufe samt `json_array_length` |
| Gehaltsübersicht | `compensation/salaryRoutes.ts` mit `componentsAt` (`lib.ts`) | 0,4 bis 0,65 s | eine Abfrage je Person (2600 Abfragen) |

**Vorschlag.**
- Saldo: gezählte Tage je Antrag und Jahr einmal berechnen; Anträge, die
  ganz in einem Jahr liegen und keinen Stichtag schneiden, über das
  gespeicherte `days_counted`; nur Grenzfälle Tag für Tag. Optional ein
  Ergebniscache, den jeder Schreibzugriff auf Anträge verwirft.
- Abrechnungsläufe: `item_count`, `total_cents` und `warning_count` beim
  Anlegen des Laufs in `payroll_runs` speichern (Positionen sind
  unveränderliche Momentaufnahmen).
- Gehaltsübersicht: eine Sammelabfrage wie in `assembleMonth` (gemessen 11
  bis 19 ms statt 0,4 bis 0,65 s).

**Warum zurückgestellt.** Entscheidung des Auftraggebers; bei den
Kundengrößen der ersten Installationen deutlich unter den gemessenen Werten.
Wieder aufgreifen ab etwa 1000 Personen oder bei Rückmeldungen über träge
Übersichten.

## PERF-3: Stand der Personalakte nur sekundengenau

**Befund.** Der Personal-PATCH erkennt ein veraltetes Formular am
mitgeschickten `expected_updated_at` (`employeeRoutes.ts`,
`concurrencySchema`). `employees.updated_at` entsteht aus `datetime('now')`
und trägt nur ganze Sekunden. Zwei Änderungen in derselben Sekunde ergeben
denselben Stand. Deshalb kann die 409-Meldung nach einer Übernahme durch den
stündlichen Lauf nur vermuten, ob außerdem jemand anders etwas geändert hat
(`versionMirroredSince`, Text „weitere Änderungen anderer sind möglich“).

**Wirkung.** Zwei Arbeitsplätze, die dieselbe Akte in derselben Sekunde
speichern, überschreiben sich ohne 409 (Lost Update); in der Praxis selten,
weil zwischen Laden und Speichern eines Formulars meist mehr als eine Sekunde
liegt. Die Meldung zur neuen Vertragsversion bleibt eine Vermutung statt
einer Aussage.

**Vorschlag.** Ein Versionszähler je Akte (`employees.row_version`, jede
schreibende Stelle erhöht ihn, am besten per Trigger, damit keine Stelle ihn
vergisst), den Formular und PATCH statt `updated_at` vergleichen. Alternativ
`updated_at` mit Millisekunden (`strftime('%Y-%m-%d %H:%M:%f', 'now')`),
dann aber an jeder Schreibstelle der Akte gleich. Mit dem Zähler kann die
Übernahme ihren Stand vorher und nachher ins Protokoll schreiben, und die
Meldung weiß, ob sie die einzige Änderung war.

**Warum zurückgestellt.** Berührt jede Stelle, die `employees` schreibt
(Personal, Sammeländerung, Verträge, Änderungsanträge, Standort,
Migrationen), beide Clients und die Tests. Der heutige Schutz genügt für den
Betrieb mit wenigen HR-Arbeitsplätzen. Wieder aufgreifen bei Rückmeldungen
über verlorene Änderungen oder wenn mehrere HR-Konten dieselben Akten
parallel pflegen.

## FT-1: Automatische Updates für Server und Desktop-App

**Befund.** Es gibt keine Update-Mechanik. Die Desktop-App bringt keinen
Updater mit (`electron-builder.yml`: `publish: null`), der Kundenserver fragt
nirgends nach neuen Fassungen, und ein Release erreicht Selbsthoster nur als
Dateien (Stick, Mail), die eine Person mit Adminrechten einspielt:
`update-server.ps1` auf dem Server, `Arbeitsplatz-einrichten.cmd` je
Arbeitsplatz. Bei Dronivo heißt jedes Update: Yannick, Stick, alle Rechner.
Der Installer kennt außerdem keinen Server; direkt gestartet entsteht eine
App mit eigener, leerer Datenbank (Vorfall Lena, 27.10.2026).

**Ziel.** Wie bei verbreiteter Software: Der Server meldet in den
Einstellungen „Version X verfügbar“, die Administration spielt sie per Klick
oder im Nachtfenster ein; die App zeigt „Version X bereit, jetzt neu
starten“. Kein Stick, kein Admin für den Alltag. Erste Auslieferung als
`2.0.0-dronivo`; die Runde mit dieser Version ist die letzte mit Stick.

**Ansatz (Branchenstandard, keine Eigenerfindung).**
- App: `electron-updater` (wie Slack, Signal, Notion), Feed ist der eigene
  Kundenserver, nicht der Anbieter.
- Zugang zum Feed beim Anbieter: die signierte Lizenzdatei als Nachweis (wie
  Proxmox, Ubuntu Pro, Nextcloud Enterprise). Nichts ist öffentlich
  abrufbar; der Feed liefert nur die Variante der Lizenz, solange sie gilt.
- Server: Hinweis plus Klick durch die Administration (wie Nextcloud,
  GitLab, Bitwarden), eingespielt von einer Aufgabe mit Systemrechten, weil
  ein Windows-Dienst seine eigenen Programmdateien nicht ersetzen kann
  (Vorbild Aufgabe `oHRganize-Sicherung`).
- Installer mit Authenticode-Signatur wie jeder kommerzielle Windows-Installer.

**Plan** (auf main, dann `git merge main` nach dronivo).

A. Anbieter
1. Cloudflare: privater R2-Bucket `ohrganize-releases` (keine öffentliche
   Domain), Worker `updates.ohrganize.com` mit R2-Anbindung und KV für das
   Abrufprotokoll.
2. Worker (`tools/update-feed/`): nimmt die Lizenzdatei als Bearer, prüft
   Signatur (Schlüssel aus `core/licenseKeys.ts`), Gültigkeit und Edition,
   liefert nur `<kanal>/<variante>/` dieser Lizenz, protokolliert
   Installations-ID, Version, Datei, Zeit; sonst 401.
3. `scripts/release.mjs --publish`: lädt je Variante `latest.json` samt
   `.sig`, `latest.yml` (electron-updater), Installer und Server-Zip samt
   `.sha256` hoch.
4. conspectus liest das Abrufprotokoll (welche Instanz hat welche Version).

B. Server beim Kunden
5. Core-Plugin `core/updateRoutes.ts`, Bereich `einstellungen` in
   `ROUTE_AREAS`: `GET /api/update` (Stand), `POST /api/update/install`
   (`bearbeiten`, `auditStandalone`), `PUT /api/update/settings` (Modus
   `manuell`, `nachts HH:MM`, `aus`), `GET /api/update/app/*` (angemeldet,
   reicht `latest.yml` und Installer vom Anbieter durch, Zwischenspeicher im
   Datenverzeichnis).
6. Stündlicher Abruf von `latest.json` mit der Lizenz: gleiche Variante,
   gleiche Linie (`customerTagOf`), nur neuer als installiert (Schutz gegen
   Downgrade), Stand in `update/stand.json` (Temp-Datei plus Umbenennen).
   Modus `aus` fragt nicht.
7. Lizenzpflicht im gebündelten Betrieb immer an (`OHRGANIZE_BUNDLED`); heute
   prüft ein Bundle ohne `OHRGANIZE_DATA_DIR` gar keine Lizenz
   (`config.ts`, `licenseEnforced`). Unabhängig von FT-1 eine Lücke.
8. Aufgabe `oHRganize-Update` (Systemrechte, Vorbild
   `install-backup-task.ps1`): reagiert auf `anfrage.json` (vor dem Start
   entfernt) oder das Nachtfenster (nicht 02:30, dann läuft die Sicherung),
   ruft `update-server.ps1 -Archive ... -Strict` (Signatur verpflichtend statt
   Warnung), schreibt das Ergebnis in `stand.json`. `Server-aktualisieren.cmd`
   richtet sie ein.
9. Versionswechsel beim Start als `auditSystem('server.updated')`.
10. Einstellungsseite „Updates“: Stand, Änderungen aus dem CHANGELOG, Knopf,
    Modus, Fehlergrund.

C. Desktop-App
11. `electron-updater` (neue Abhängigkeit, freizugeben), Provider `generic`
    auf `<server>/api/update/app/`, Token im Header; sha512 aus
    `latest.yml`, Herstellersignatur sobald signiert.
12. Banner in der AppShell (Muster `LicenseBanner.tsx`): „Version X bereit ·
    Jetzt neu starten · Später“; Menüpunkt „Nach Updates suchen“.
13. 426 `CLIENT_TOO_OLD`: Anmeldung und `/api/update/app/*` von der
    Versionsprüfung ausgenommen; die alte App bekommt den Update-Dialog
    statt eines Fehlertoasts.
14. Branch dronivo: Server und Pin fest in `packages/shared/src/dronivo.ts`
    als Vorgabe von `readDesktopConfig` (Umgebung und `config.json` gehen
    vor). Damit verbindet auch der direkt gestartete Installer.
15. `electron-builder.yml`: Code-Signatur, `publish: generic` nur zur
    Erzeugung von `latest.yml`.

D. Abschluss
16. Tests: Smoke für Routen und Lizenzpflicht, Worker mit Testlizenz, ein
    echter Lauf auf einem Rechner mit Adminrechten (Dienst, Aufgabe, App).
17. Doku „Updates“ in `deploy/windows/README.md` und
    `docs/betrieb-anbieter.md`, mit den übertragenen Feldern (Installations-ID,
    Variante, Version, Zeit, IP; keine Personal- oder Nutzungsdaten) und dem
    Modus `aus`.
18. Merge nach dronivo, Release `2.0.0-dronivo` mit `--publish`, Stick mit
    `Server-aktualisieren.cmd` und `Arbeitsplatz-einrichten.cmd` der Fassung
    2.0.0.

Reihenfolge B, C, A, D; B ist ohne Feed gegen eine lokale `latest.json`
testbar. Aufwand: vier Sitzungen plus ein Testtag.

**Aufgaben Anbieter (Jeffrey).**
- Freigabe von `electron-updater` als Abhängigkeit (vor Sitzung 1).
- Code-Signatur-Zertifikat (OV) bestellen; die Identitätsprüfung dauert
  einige Tage. Ohne Zertifikat läuft alles, nur ohne Herstellerprüfung.
- Cloudflare vor Sitzung 3: R2 freischalten, Bucket, Worker mit Domain
  `updates.ohrganize.com`, KV-Namespace, API-Token (nur dieser Bucket) auf
  dem Release-Rechner; 2FA für das Konto einschalten.
- Testlauf auf einem eigenen Rechner mit Adminrechten (Sitzung 4).
- Release `npm run release -- --version 2.0.0-dronivo --issues "#1 #9" --publish` auf dem
  Release-Rechner, Stick befüllen.
- Nach der Runde bei Dronivo: Eintrag im Abrufprotokoll prüfen.

**Aufgaben Dronivo (Yannick).**
- Vorab entscheiden: Darf oHRganize auf den HR-Rechnern als
  Benutzerinstallation laufen? Ja: App-Updates ohne ihn. Nein: Er bestätigt
  jedes App-Update einmal per Admin-Passwort; der Server aktualisiert in
  beiden Fällen ohne ihn.
- Runde 2.0.0 (etwa eine Stunde, letzte mit Stick): VM mit
  `Server-aktualisieren.cmd` (richtet `oHRganize-Update` ein, prüft den
  Zugang zu `updates.ohrganize.com`), danach die drei Arbeitsplätze mit
  `Arbeitsplatz-einrichten.cmd`. Bianka prüft unter Einstellungen → Updates
  „aktuell“.
- Danach nur im Fehlerfall; die Einstellungsseite nennt den Grund.

**Bewusst nicht.** Schlüssel je Installation mit Freigabe (Modell Red Hat,
für sehr viele Server gebaut), eigene Update-Aufgabe am Arbeitsplatz,
öffentlicher Download-Ordner beim Kunden oder beim Anbieter. Im Hosting beim
Anbieter (noch kein Fall) bleibt der Server-Teil bei conspectus und
`ohrganize-update.sh`; Einstellungsseite und App sind dieselben.

**Warum noch nicht umgesetzt.** Geplant, nicht zurückgestellt: wartet auf
die Freigabe der Abhängigkeit, Cloudflare und das Zertifikat. Für Dronivo
läuft bis dahin 1.1.2 über den Stick (05.11.2026).
