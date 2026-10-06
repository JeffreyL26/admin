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

> **Historisch — gilt seit Electron 42 nicht mehr.** Electron bringt keinen
> `postinstall` mehr mit; die Binärdatei wird beim ersten `require('electron')`
> nachgeladen, ausdrücklich per `npx install-electron`. Der Eintrag in
> `allowScripts` ist entfallen. Steckt `node_modules/electron/dist` trotzdem
> unvollständig fest, gilt das Vorgehen unten weiterhin.

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
   `electron` im Root-`node_modules`; electron-builder kann die Range aus
   `apps/desktop/package.json` nicht selbst auflösen und bricht ab. Fester Wert
   in `electron-builder.yml` (muss zur installierten Version passen).
   **Damit steht die Version an zwei Stellen** — wer nur eine anhebt, baut still
   weiter mit der alten. Beim Sprung von 38 auf 42 wäre genau das passiert;
   `scripts/build.mjs` vergleicht beide Angaben seitdem und bricht bei
   Abweichung ab (siehe „Schwachstellen: Electron 42 statt 44" am Ende).
2. **`productName` gehört zusätzlich in die `package.json` der Desktop-App:**
   `app.getPath('userData')` leitet sich aus dem Paketnamen ab — mit dem
   Scoped-Namen `@ohrganize/desktop` landeten Nutzerdaten in
   `%APPDATA%\@ohrganize\desktop` statt `%APPDATA%\oHRganize`. Das `productName`
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
Override) mit eigenem, bewusst dokumentenhaftem UI (flache Karten,
Skeleton-Loader, `pt-`-Präfix) auf identischen Markenfarben.

**Revidiert (Rollout-Feedback):** Ursprünglich hatte das Portal eine eigene
Schriftpaarung (Public Sans + Source Serif 4). Auf Wunsch aus dem Rollout
teilt es jetzt Typografie und Größenskala der Desktop-App (Inter Variable) —
beide Clients sollen als ein Produkt lesbar sein. Die Eigenständigkeit des
Portals liegt seither in Layout und Komponenten (Hairlines statt Schatten,
keine Icons), nicht in der Schrift.

**Warum kein geteilter UI-Code mit dem Renderer:** Der Renderer ist eine
Maus-zentrierte Desktop-Verwaltung ohne Media-Queries (fixe 264-px-Sidebar,
`body { overflow: hidden }`, Electron-Titelleiste); das Portal muss auf dem
Smartphone funktionieren und deutlich weniger können. Geteilt wird, was stabil
ist — Typen/Konstanten aus `@ohrganize/shared` und die Token-**Werte** — statt
Komponenten, deren Layout-Annahmen nicht übertragbar sind. Die Desktop-Regel
„base: './' + HashRouter" gilt hier ausdrücklich nicht (HTTP-Auslieferung,
SPA-Fallback dokumentiert in docs/web-portal.md).

## Führung & Bewertung: Freischaltung je Personalprofil statt Rechtebereich

**Entscheidung:** Die Führungsfunktion („Mein Team“, `/api/leadership/me/*`)
hängt an der Freischaltung des **Personalprofils** (Tabelle
`leadership_leaders`, Schlüssel `employee_id`), nicht an der Admin-Rolle. Der
Rechtebereich `fuehrung` regelt ausschließlich die Verwaltung (Freischalten,
Zuständigkeit, Skala/Kategorien, Report). Zwei Gates, weil es zwei Fragen
sind: „Darf dieses Konto die Funktion einrichten?“ (Rolle) und „Ist diese
Person Führungskraft?“ (Organisation).

**Verworfen — Rechtebereich allein:** Dann bräuchte jede Führungskraft eine
Admin-Rolle mit `fuehrung: lesen` — und sähe damit den Satisfaction-Report
über *alle* Führungskräfte; umgekehrt hätte jede HR-Kraft mit
`fuehrung: bearbeiten` automatisch ein „Team“. Der Bereich kann nicht
gleichzeitig „darf einrichten“ und „ist Führungskraft“ bedeuten.

**Warum `employee_id` als Schlüssel:** Personalverantwortung ist eine
Eigenschaft der Person in der Organisation; das Konto ist nur der Login dazu
(`users.employee_id`). So lässt sich ein Profil freischalten, bevor ein Konto
existiert (die Einrichtung weist auf das fehlende Konto hin), ein Kontowechsel
verliert nichts, und die Zuständigkeitsableitung (`manager_id`,
`departments.head_employee_id`, `teams.lead_employee_id`) rechnet ohnehin in
Personal-IDs. **Verworfen — Flag in `users`:** bindet an den Login statt an
die Person; ein Profil ohne Konto wäre nicht freischaltbar, und die Kaskade
beim Löschen eines Profils griffe nicht. **Verworfen — JSON in
`app_settings`:** keine Fremdschlüssel, keine Kaskade, kein Join für Liste und
Report, und jede Änderung müsste den ganzen Blob neu schreiben.

**Rolle „Führungskraft“ per `INSERT … WHERE NOT EXISTS` / `OR IGNORE`:**
Migration 310 liefert eine Admin-Rolle ohne jeden HR-Bereich aus, damit ein
Konto möglich ist, das nur „Mein Team“ sieht. Sie wird nur angelegt, wenn der
Name frei ist, und Rechte werden nur ergänzt, nie überschrieben — eine
Kundeninstallation kann längst eine gleichnamige Rolle mit eigenen Rechten
haben, und eine Migration darf vergebene Rechte nicht still ändern. Bestehende
Rollen erhalten `fuehrung` auf der Stufe ihres Bereichs `benutzer`: Wer Konten
und Rechte vergibt, darf auch Führungskräfte freischalten; alle anderen bleiben
fail closed und werden von Hand gehoben.

**Protokoll app-seitig, Trigger nur gegen UPDATE:** `service.saveRatings`
schreibt jede tatsächliche Änderung als neue Version nach
`leadership_rating_history`; ein `BEFORE UPDATE`-Trigger macht die Zeilen
unveränderlich. Bewusst **kein** Trigger gegen DELETE: Die einzige Löschung ist
die Kaskade beim Entfernen eines Personalprofils (DSGVO-Löschung — das
Protokoll über eine Person muss mit ihr verschwinden können) sowie der Neuseed
der Dev-DB (`seed --force`); ein DELETE-Trigger hätte beides blockiert. Eine
Löschroute gibt es nicht. **Verworfen — Insert-Trigger in der Datenbank:** sie
kennen weder das handelnde Konto noch die Regel „unveränderte Blöcke erzeugen
keine neue Version“, und das Protokoll wäre bei jedem Speichern des Formulars
mit Leerzeilen gewachsen.

**Skala je Bewertung gespeichert:** Jede Zeile trägt `scale` und den Rohwert
`score`. Wird die Skala zentral umgestellt (5 Sterne → Ampel), bleiben alte
Bewertungen lesbar statt umgedeutet; der Report zählt nur Zeilen auf der
aktuellen Skala und weist die übrigen als `other_scale_count` aus.
**Verworfen — Normierung auf 0…1 beim Speichern:** hätte die Originalanzeige
(„4 von 5“, „Note 2“) verloren und Schulnoten (1 = beste Stufe) unnötig
verwirrend gemacht.

**Zeitraum-Helfer in `packages/shared`:** Quartals- und Halbjahresgrenzen
sowie die Schlüssel (`2026-Q3`, `2026-H2`) berechnen Backend, Renderer und
Seed über dieselben Funktionen (`periodFromKey`, `shiftPeriod`,
`periodForDate`). Zwei Implementierungen derselben Grenzen wären
auseinandergelaufen — und genau daran hängt, ob eine Bewertung im richtigen
Zeitraum landet und ob der Zeitraum-Wechsler im Client dieselben Zeiträume
zeigt, die der Server akzeptiert.

**Löschregeln (Review-Ergebnis):** `leadership_ratings.leader_employee_id`
steht auf `ON DELETE SET NULL`, `employee_id` auf `CASCADE`. Verschwindet die
bewertete Person (DSGVO), verschwinden ihre Bewertungen samt Protokoll;
verschwindet die Führungskraft, bleiben ihre Bewertungen über andere bestehen
und verlieren nur die Zuordnung — sonst gälte das „unlöschbare Protokoll“ nur,
solange die Führungskraft im System ist. Das Protokoll trägt seither auch
`previous_scale`: Nach einem Skalenwechsel wäre „4 → 4“ sonst nicht als
„4 von 5 Sternen → 4 Punkte“ erkennbar. Gegenseitige Verantwortung wird an
jeder Schreibstelle des Moduls in der Transaktion geprüft (`assertMutualAllowed`);
Organisationsänderungen sieht das Modul nicht, deshalb liefert
`GET /api/leadership/settings` die bestehenden Paare zur Warnung.

**Report-Aufschlüsselung: zwei Endpunkte statt einer Antwort.** Das Widget im
Satisfaction-Report klappt auf und zeigt eine Tabelle „Person × Zeitraum“.
Naheliegend wäre eine Antwort mit allem gewesen — Personen, Zeiträume,
Kategorien, Kommentare. Das skaliert nicht: 30 Personen × 6 Zeiträume × 5
Kategorien sind 900 Kommentartexte je aufgeklapptem Widget, von denen man
einen liest. Deshalb liefert `…/breakdown` nur die Gesamtbewertung je Zelle
(Wert, Skala, Anzahl bewerteter Kategorien, Zeitstempel) und
`…/employees/:memberId/ratings` beim Klick die vollständige Aufschlüsselung
genau einer Zelle. Die Tabelle enthält auch Personen, die heute nicht mehr zum
Bereich gehören (`former = 1`): Sonst verschwänden abgegebene Bewertungen aus
der Aufschlüsselung, sobald sich die Organisation ändert — im
Verteilungsbalken darüber zählen sie ohnehin mit.

**„Mein Team“: Bereichskopf, zwei Abschnitte, Verlauf ohne Bedienelemente.**
Die Führungskraft sieht oben ihren Bereich — Abteilungen und Teams mit
Kopfzahl, Gesamtzahl, Zeitraum samt Kadenz und den Fortschritt der laufenden
Runde —, darunter die Personen getrennt nach „Ausstehende Bewertungen“ und
„Bereits bewertet“. Der frühere Filter „Nur unbewertete“ entfällt: Die
Aufteilung zeigt dasselbe, ohne dass man den Filter erst finden muss.
Abteilungen und Teams stammen aus den Personalprofilen des Bereichs, nicht aus
der Leitungsfunktion — wer über eine Zuweisung jemanden aus einer anderen
Abteilung betreut, sieht diese Abteilung hier mit. „Bewertet“ heißt
mindestens eine Kategorie im Zeitraum, nicht zwingend die Gesamtbewertung:
Sonst stünde jemand mit einer Bewertung in „Leistung“ dauerhaft unter
„ausstehend“; die Karte schreibt stattdessen „Ohne Gesamtbewertung“ dazu.
Die Verlaufsleiste (vier Zeiträume, `MyTeamResponse.history_periods`, folgt
dem gewählten Zeitraum) trägt bewusst keine eigenen Knöpfe — die ganze Karte
ist der Einstieg in die Bewertungsmaske, ein Knopf im Knopf wäre weder
klick- noch tastaturbedienbar. Ihre Zellen sind dieselbe `BreakdownCell` wie
in der Report-Aufschlüsselung, damit beide Seiten „bewertet“ gleich
bedeuten.

## Leistung & Führung: eine Vorgesetztenbewertung, getrennte Bewertungsarten

**Entscheidung:** Beurteilungen (`/api/performance/reviews`) kennen als
anlegbare Arten nur noch **Selbstbewertung** und **360°-Feedback**. Die
Vorgesetztenbewertung gibt es genau einmal, im Bereich Führung („Mein Team“):
mit Zuständigkeit aus `service.scopeFor`, Pflichtkommentar und unveränderlichem
Protokoll. `POST …/reviews` mit `kind: 'vorgesetzt'` antwortet 400 mit
Verweis. Beurteilungsbögen
nutzen die **zentralen Skalen** (`RatingScaleKey`) je Kriterium und können
Kriterien an zentrale Bewertungskategorien binden (`category_id`; Name,
Beschreibung, Skala werden beim Speichern übernommen, damit Selbstbild und
Führungsbewertung dieselbe Frage auf derselben Skala beantworten). Weil
Skalen je Kriterium verschieden sein dürfen, ist das Ergebnis eines Bogens
`overall_percent` (Anteil der Bestnote; endgültiges Schema in
`321_reviews_final_schema`, das `overall_score` und die Art `vorgesetzt`
entfernt). Das Aggregat liefert
dazu die Führungsbewertungen, deren Zeitraum den Zyklus berührt
(`supervisor`, ohne Kommentare, die bleiben im Bereich Führung).
Navigation: ein Abschnitt „Leistung & Führung“; die Rechtebereiche `leistung`
und `fuehrung` bleiben getrennt (Einträge tragen `area`, „Mein Team“ hängt
an der Freischaltung). Gespräche (Feedback-Zyklen) bleiben eigenständig und
verweisen per Deep-Link (`?employee=`) auf Beurteilungen und „Mein Team“.

**Verworfen — Tabellen zusammenlegen:** `leadership_ratings` (Upsert je
Zeitraum, Protokoll-Trigger, Zuständigkeitsgate) und `reviews` (Zyklus, Bogen,
mehrere Reviewer:innen) haben verschiedene Lebenszyklen; ein gemeinsames
Schema hätte beiden Sonderfälle aufgezwungen. Verschmolzen sind deshalb die
Begriffe (Kategorien, Skalen, Ergebnisdarstellung), nicht die Speicherung.

**Umstellung vorhandener Daten (nur Entwicklungs- und Testsysteme, es gibt
noch keine Kundeninstallation):** Migration 321 baut `reviews` neu auf,
führt Zeilen der alten Art `vorgesetzt` als 360°-Feedback weiter (Bewertung
durch eine andere Person), rechnet `overall_score` in Prozent um und ersetzt
`scale_max` in Bögen durch die passende Skala (5 → `stars5`,
10 → `points10`, 3 → `ampel`).

## Stammdaten aus dem Portal: Antrag statt Schreibrecht

**Entscheidung:** Mitarbeitende ändern ihre Stammdaten nicht selbst. Das Portal
legt einen Änderungsantrag an (`employee_change_requests` + eine Zeile je Feld
in `employee_change_request_fields`), die Personalabteilung entscheidet, und
erst die Genehmigung schreibt in `employees`. Die beantragbaren Felder stehen
ausschließlich in `EMPLOYEE_SELF_EDITABLE_FIELDS`
(`packages/shared/src/employees.ts`).

**Verworfen — `PATCH /api/me/profile` mit direktem Schreibrecht:** Der
naheliegende Weg, und in `openapi/base.yaml` war er sogar vorgemerkt. Er
scheitert an dem, wofür die Personalakte da ist: Aus Adresse und Bankverbindung
entstehen Entgeltabrechnung, Meldungen an Sozialversicherung und Finanzamt und
Bescheinigungen. Eine stille Änderung durch die betroffene Person selbst hätte
weder eine zweite Person noch einen Zeitpunkt, auf den man sich später berufen
kann. Der Antragsweg kostet einen Klick mehr und liefert beides.

**Verworfen — ein Antrag = ein Feld:** Eine Zeile je Feldänderung wäre
einfacher zu modellieren, macht aber aus einem Umzug drei Vorgänge mit
derselben Begründung, die einzeln entschieden werden können. Ein Antrag ist
deshalb eine Einreichung (eine Begründung, eine Entscheidung) mit mehreren
Feldern in einer Kindtabelle; genehmigt wird alles zusammen in einer
Transaktion.

**Höchstens ein offener Antrag je Person (409).** Zwei offene Anträge könnten
dasselbe Feld auf verschiedene Werte setzen — welcher gewinnt, hinge dann an
der Reihenfolge der Genehmigungen. Nebeneffekt und zweiter Grund: Das Backend
hat kein Rate-Limiting; ohne diese Regel könnte ein Portal-Konto die
HR-Warteschlange und die Dashboard-Kachel beliebig fluten.

**`old_value` ist Beleg, nicht Bedingung.** Beim Anlegen wird der Stand
festgehalten, damit die Personalabteilung eine Gegenüberstellung sieht. Beim
Genehmigen wird er NICHT gegen den aktuellen Stand geprüft: Die Entscheidung
gilt dem gewünschten Zustand, nicht der Differenz. Hat sich zwischenzeitlich
etwas geändert, steht der tatsächlich überschriebene Wert im `audit_log`
(`applied`), gelesen unmittelbar vor dem UPDATE.

**Bankverbindung: beantragbar, aber vertraulich.** `GET /api/me/profile`
enthält IBAN und BIC bewusst nicht (docs/web-portal.md nennt das eine gesetzte
Grenze). Ein Antrag darf diese Grenze nicht durch die Hintertür öffnen: Felder
mit `confidential` werden dem Portal nur gekürzt zurückgegeben
(`maskConfidential`, letzte vier Zeichen), eine Vorbelegung des Formulars gibt
es dort nicht. Die Personalabteilung sieht den Klartext. Auch das Protokoll des
Antrags hält nur die Feldnamen fest — die neue IBAN stünde sonst ein zweites
Mal im `audit_log`, das auch die Systemverwaltung liest.

**Vier-Augen mit zwei Armen.** Abgewiesen wird die Genehmigung, wenn das
entscheidende Konto den Antrag gestellt hat ODER wenn das betroffene
Personalprofil das eigene ist. Der zweite Arm ist nötig, weil ein HR-Konto mit
verknüpftem Profil beide Rollen hat (docs/web-portal.md) — sonst ließe sich der
Antrag von einer dritten Person stellen und selbst genehmigen.

**Keine Benachrichtigung, und das steht so im Text.** oHRganize verschickt
keine E-Mails. HR sieht offene Anträge auf der Dashboard-Kachel und unter
Personal → Änderungsanträge, die betroffene Person die Entscheidung beim
nächsten Portal-Besuch. `MIN_CLIENT_VERSION` wird bewusst nicht angehoben: Die
Änderung ist additiv, und die Regel in `packages/shared` erlaubt eine Anhebung
nur, wenn ältere Apps tatsächlich brechen. Eine nicht aktualisierte
Desktop-App zeigt die Warteschlange also nicht — das gehört in den
Update-Hinweis, nicht in eine Sperre, die Arbeitsplätze aussperrt.

## systemd-Härtung: gemessen statt geschätzt

**Entscheidung:** Alle vier Units (`ohrganize-backend[@].service`,
`ohrganize-backup[@].service`) bekommen leere Capability-Mengen, einen
Systemaufruf-Filter, ein unsichtbares `/proc`, einen eigenen
Benutzer-Namensraum und eine Netz-Allowlist. `systemd-analyze security` fällt
damit von 5.1 auf **0.9** (Backend) und von 6.6 auf **0.2** (Sicherung).

**Die Schreibweise des Filters ist die eigentliche Falle.** `SystemCallFilter=`
nimmt EIN `~` am Zeilenanfang für die ganze Liste. Schreibt man
`~@privileged ~@resources`, wertet systemd nur die erste Gruppe als Sperre und
verwirft die übrigen still als unbekannte Syscall-**Namen** — der Filter ist
dann viel schwächer, als er aussieht, und die Punktzahl verrät es nicht.
Aufgefallen ist es nur, weil `systemd-analyze verify` es meldet; dieser Aufruf
gehört nach jeder Änderung an einer Unit dazu.

**`PrivateNetwork=true` nur für die Sicherung.** Das Backend muss lauschen, die
Sicherung nicht: Sie schreibt die Datenbank mit `VACUUM INTO` und kopiert
Dateien. Ein leerer Netz-Namensraum nimmt einem eingeschleusten Befehl damit
jede Möglichkeit, die kopierte Personalakte fortzuschicken — das ist der größte
Einzelposten in der Bewertung (0.5) und beim Backend unerreichbar.

**Was bewusst offen bleibt:** `MemoryDenyWriteExecute` (V8 kompiliert zur
Laufzeit; mit `true` startet Node nicht), `RestrictAddressFamilies=AF_INET`
und `PrivateNetwork` beim Backend (es ist ein Netzdienst) sowie
`RootDirectory` (ein eigenes Wurzelverzeichnis wäre ein zweiter
Auslieferungsweg). Die verbleibenden 0.9 sind damit im Wesentlichen der Preis
dafür, überhaupt erreichbar zu sein.

**`IPAddressAllow=localhost` hat einen Haken, der dokumentiert gehört:** Wer
Proxy und Backend auf verschiedene Maschinen legt (`OHRGANIZE_HOST`), muss die
Adresse des Proxys ergänzen, sonst weist der Dienst dessen Verbindungen ab. Der
Hinweis steht in beiden Backend-Units direkt über den Zeilen.

## Windows-Serverinstallation: vier Fehler, die erst der Probelauf zeigte

**Ausgangslage:** `deploy/windows/README.md` führte drei Punkte als „noch NICHT
verifiziert" — Dienstregistrierung über NSSM, geplante Aufgabe, Caddy. Der
Probelauf auf einer Windows-11-Maschine (Server und Arbeitsplatz dieselbe
Maschine, Hostname `localhost`) hat sie durchgespielt. Ergebnis: Der
dokumentierte Weg führte an **vier** Stellen nicht zum Ziel. Keine davon war
sichtbar, ohne ihn zu gehen.

**1. `npm ci` liefert ein unbrauchbares better-sqlite3.** npm sperrt seit
Version 12 die Installationsskripte von Abhängigkeiten. Die `allowScripts`-Liste
in der `package.json` nennt die sechs betroffenen Pakete namentlich, greift aber
nicht: npm kann die Einträge nur auf eine Version festnageln, wenn der
`package-lock.json` eine `resolved`-URL mitbringt — und der ausgelieferte
Lockfile hat für 533 von 538 Einträgen keine. `npm ci` meldet trotzdem Erfolg,
der Build läuft durch, und erst der Dienststart bricht mit „Could not locate the
bindings file" ab. Beide Deploy-Anleitungen holen `prebuild-install` deshalb
ausdrücklich nach und prüfen das Ergebnis sofort mit einem `new Database`.

**Der Lockfile war die eigentliche Ursache — inzwischen behoben.** Er trug für
**alle** 538 Einträge keine `integrity`, `npm ci` prüfte auf einem
Kundenserver also keine einzige Paket-Prüfsumme. Neu erzeugt gegen die echte
Registry sind es 644 Einträge; ohne `resolved`/`integrity` bleiben nur der
Wurzeleintrag, die fünf Workspace-Verzeichnisse und ihre Verweise unter
`node_modules` — alles lokal, dort gibt es nichts zu prüfen. Die 100
hinzugekommenen Einträge sind die plattformspezifischen `optionalDependencies`
von esbuild und rollup, die eine Rekonstruktion aus dem lokalen Baum gar nicht
kennen kann. Versionsdrift: 35 Bewegungen, sämtlich Patch- und Minor-Stufen,
kein Major-Sprung.

**Damit erledigte sich auch die Skriptsperre von selbst:** Von den sechs
gelisteten Paketen war anschließend nur noch `esbuild@0.28.2` gesperrt — weil
`allowScripts` auf `0.28.1` festgenagelt war und `tsx` durch den Versionsdrift
inzwischen `0.28.2` zieht. Genau so soll eine Festnagelung wirken: Eine
Versionsanhebung macht den Eintrag ungültig und verlangt eine bewusste
Freigabe. Der Eintrag wurde daraufhin nachgezogen; `npm install-scripts ls`
meldet seitdem nichts mehr. Der naheliegende Kurzschluss — das Feld sei ein
Fremdkörper und gehöre gelöscht — wäre der falsche Weg gewesen: Danach liefen
die Installationsskripte **sämtlicher** Abhängigkeiten ungeprüft.
`prebuild-install` von Hand ist
seitdem kein Pflichtschritt mehr, sondern Rückfallebene; beide Deploy-Anleitungen
führen stattdessen eine Kontrollzeile. Wichtig dabei: Ein blosses `require()`
belegt nichts — die native Bindung wird erst beim `new Database` geladen.
Genau dieser zu schwache Prüfausdruck hat den Fehler im Probelauf einmal als
behoben ausgewiesen, obwohl er es nicht war.

**2. Der Dienst startete nie — wegen eines Leerzeichens.** NSSM legt
`AppParameters` wörtlich in der Registry ab und hängt den Wert beim Start an die
Programmzeile. Windows PowerShell entfernt beim Aufruf nativer Programme
Anführungszeichen aus einem Argument; der abgelegte Wert war deshalb
`C:\Program Files\...\cli.cjs` **ohne** Anführungszeichen, und node suchte ein
Modul namens `C:\Program`. Der Prozess endete sofort, NSSM stellte den Dienst
nach mehreren Versuchen auf *Angehalten* — ohne dass irgendwo „Pfad" oder
„Leerzeichen" stand. Da der vorgesehene Ablageort `C:\Program Files\oHRganize`
ist, konnte die dokumentierte Installation **nie** funktionieren.
`install-service.ps1` liest den Wert jetzt zurück und setzt ihn nötigenfalls
direkt; stimmt er danach immer noch nicht, bricht es ab, statt einen halb
gestarteten Dienst zu hinterlassen.

**3. `icacls` nimmt eine Dienst-SID nicht an, die es noch nicht gibt.** Die
Härtung läuft absichtlich VOR der Dienstregistrierung, damit das
Log-Verzeichnis steht, bevor der erste Start das Initialpasswort hineinschreibt.
Zu diesem Zeitpunkt existiert das virtuelle Konto aber noch nicht, und `icacls`
löst den Kontonamen auf, bevor es die ACE schreibt — auch in der Schreibweise
`*S-1-5-80-…`. Der Aufruf scheitert mit `ERROR_NONE_MAPPED` (1332), die Warnung
ging in der übrigen Ausgabe unter, und das Datenverzeichnis blieb ohne Recht für
das Dienstkonto. `harden-data-dir.ps1` fängt das jetzt mit `Set-Acl` ab, das die
ACE direkt aus dem SID-Objekt schreibt und keine Auflösung braucht;
`install-service.ps1` härtet nach der Registrierung ein zweites Mal — dann ist
der Name auflösbar — und prüft vor dem Start, ob die SID wirklich in der ACL
steht.

**Warum das schwer zu sehen war:** Auf einer Maschine, auf der der Dienst schon
einmal installiert war, bleibt seine SID der LSA bis zum Neustart bekannt — der
Fehler verschwindet dann. Ein Zwischenversuch hat ihn genau deshalb scheinbar
widerlegt. Belegen ließ er sich erst mit dem Namen eines Dienstes, den es auf
der Maschine nie gab.

**4. Die Sicherungsaufgabe lief im Akkubetrieb gar nicht.** Die Aufgabenplanung
setzt `DisallowStartIfOnBatteries` und `StopIfGoingOnBatteries` von sich aus auf
„ein". Die Aufgabe blieb still auf *In Warteschlange* stehen — kein Fehler, kein
Ereignis, `LastTaskResult` unverändert `0`, während derselbe Befehl von Hand
fehlerfrei durchlief. Der zweite Schalter ist der unangenehmere: Er bräche eine
**laufende** Sicherung ab, sobald der Strom ausfällt — ausgerechnet dann.
`install-backup-task.ps1` setzt beide jetzt ausdrücklich zurück; die
systemd-Fassung kennt keine solche Bedingung, und die beiden Plattformen sollen
sich gleich verhalten.

**Was der Probelauf bestätigt hat:** Die zentrale Warnung der Doku stimmt
gemessen — ein frisch angelegter Ordner unter `C:\ProgramData` trägt
`VORDEFINIERT\Benutzer:(OI)(CI)(RX)`, jedes lokale Konto könnte die
Personalakte öffnen. Ebenso bestätigt: Caddy mit `tls internal` (Portal,
SPA-Fallback, Weiterleitung 308, alle vier Sicherheitskopfzeilen, keine
Server-Kennung, Signaturen nicht im Zugriffsprotokoll), der WAL-Checkpoint beim
geordneten Stopp (danach kein `-wal`/`-shm`) und die Restore-Probe. Widerlegt
wurde dagegen die Sorge um `git safe.directory`: Ein `git clone` nach
`C:\Program Files`, aus einer Administrator-Sitzung angelegt, gehört der Gruppe
Administratoren, und Git meldet dort keine „dubious ownership".

## Schwachstellen: Electron 42 statt 44, und die Version steht an zwei Stellen

**Ausgangslage:** `npm audit` meldete fünf Advisories — Electron (hoch),
`extract-zip` (hoch), `esbuild` (mittel) und zweimal `react-router` (mittel).
Für alle drei betroffenen Pakete war der von npm vorgeschlagene Weg ein
Major-Sprung, `npm audit fix --force` hätte Electron auf 44 gehoben. Genau das
wäre falsch gewesen.

**Warum Electron 42.11.2 und nicht 44.** `better-sqlite3` 12.11.1 veröffentlicht
Fertigpakete bis **Electron-ABI 146** — das ist Electron 42. Für 43 (ABI 148)
und 44 (ABI 149) gibt es keines; electron-builder müsste die native Bibliothek
aus dem Quelltext übersetzen und bräuchte dafür die Visual Studio Build Tools
auf jeder Maschine, die einen Installer baut. 42.11.2 liegt oberhalb der
Advisory-Grenze (`<= 40.10.2`, danach die Vorabversionen von 41 bis 43), steht
in Electrons Wartungsfenster der letzten drei Hauptversionen — und bringt
denselben Nebeneffekt wie 44: Es hängt nicht mehr an `extract-zip`, sondern an
`@electron-internal/extract-zip`. Ein Sprung, zwei erledigte Advisories, kein
Kompilierzwang. Die ABI-Grenze ist der eigentliche Taktgeber: **Vor dem
nächsten Electron-Sprung erst prüfen, bis wohin better-sqlite3 Fertigpakete
liefert.**

**Die Version steht an ZWEI Stellen, und das wäre beinahe schiefgegangen.**
Neben der Range in `apps/desktop/package.json` gibt es die feste Zahl
`electronVersion:` in `apps/desktop/electron-builder.yml` — nötig, weil
electron-builder die Range wegen des Workspace-Hoistings nicht selbst auflösen
kann. Nach dem Anheben von package.json baute `dist:win` klaglos weiter mit
`electron=38.8.6`; aufgefallen ist es nur, weil das Bauprotokoll mitgelesen
wurde. Der Auslieferungsstand hätte die Lücke behalten, während `npm audit`
Entwarnung gibt — die unangenehmste Sorte Fehler. `scripts/build.mjs`
vergleicht die beiden Angaben seitdem und bricht bei Abweichung ab; die Sperre
ist in beide Richtungen nachgestellt worden.

**Electron bringt seit dieser Fassung keinen `postinstall` mehr mit.** Die
Binärdatei wird beim ersten `require('electron')` nachgeladen (`index.js`), und
es gibt `npx install-electron` für den ausdrücklichen Aufruf. Drei Folgen: Der
Eintrag `electron@…` in `allowScripts` ist gegenstandslos geworden und
entfernt; ein `npm ci` auf dem Kundenserver lädt keine 250 MB Desktop-Laufzeit
mehr herunter, die dort nie jemand startet; und eine Baumaschine ohne
Internetzugang braucht den Aufruf vorab, weil `dist:win` sonst an dieser Stelle
zum ersten Mal ins Netz greift.

**React Router 6 → 7 war alternativlos.** Beide Advisories (Open Redirect über
Rückstriche in `<Link>`/`useNavigate`, Konstruktor-Injektion in
`deserializeErrors()`) betreffen `6.0.0 – 7.17.0`; einen Patch auf der
6er-Reihe gibt es nicht. Der Sprung ist hier billig: Beide Oberflächen benutzen
ausschließlich die Data-Router-API (`createHashRouter` bzw.
`createBrowserRouter` + `RouterProvider`) und nur Namen, die v7 unverändert
führt. Es gibt keine Loader, Actions, Fetcher oder `defer` — von den
v7-Umschaltungen greift damit allein `v7_startTransition`. Die beiden
Splat-Routen sind reine Weiterleitungen ohne Kinder, `v7_relativeSplatPath`
läuft also ins Leere.

**Nachgemessen statt angenommen:** Beide Oberflächen liefen in einem Prüfstand
(Token gesetzt, `fetch` gemockt, keine Anmeldung) — Hülle rendert, `<Link>`
navigiert, Auffangroute leitet um, Browser-Zurück greift, keine
Konsolenfehler. `useBlocker` wurde eigens nachgestellt, weil es die einzige
verhaltensnahe Router-API im Code ist: Query-Wechsel läuft durch, Pfadwechsel
wird abgefangen, `reset()` hält, `proceed()` lässt durch. Dazu der komplette
Desktop-Weg: Installer mit Electron 42 gebaut (`buildFromSource=false`, das
Fertigpaket für ABI 146 wurde gefunden), still installiert, gestartet — Fenster
offen, eingebettetes Backend antwortet auf `/api/health`, `/api/employees` ohne
Anmeldung 401. Damit ist belegt, dass `better-sqlite3` unter der neuen
Electron-ABI lädt.

## Lizenz als signierte Offline-Datei; kein Rückkanal; Nur-Lese statt Sperre; Wasserzeichen nur Stolperdraht; Subdomain bleibt mit Pinning/CAA/CT statt Verzicht

**Entscheidung:** Die Nutzungsberechtigung ist eine Ed25519-signierte
Textdatei im Datenverzeichnis (`lizenz.ohrganize`, Prüfung in
`core/license.ts`, Schlüssel in `core/licenseKeys.ts`, Werkzeug
`npm run lizenz`). Kein Lizenzserver, keine Telemetrie, keine
Fernabschaltung. Nach Ablauf: 14 Tage Kulanz mit voller Funktion, dann
Nur-Lese-Betrieb mit Einsicht und Export. Der Uhren-Stolperdraht
(`installation.last_seen_date`) warnt nur. Ausgeliefert wird das Backend als
minifiziertes Bundle im Release-Archiv, nicht als Quelltext. Beschreibung
für Betreiber: `lizenzierung.md`.

**Warum kein Rückkanal:** Das Backend läuft auf Kundenhardware, oft ohne
Internetzugang, und die Personalakte darf an keiner Stelle vom Anbieter
abhängen — dieselbe Überlegung wie bei den berechneten Feiertagen (oben).
Ein Online-Check wäre zudem ein Datenabfluss (wer arbeitet wann mit wie
vielen Profilen), der eine Auftragsverarbeitung nach sich zöge. Der einzige
Rückweg ist der Lizenzbericht, den der Kunde selbst herunterlädt und
mitschickt. Ed25519 über `node:crypto`, weil keine neue Abhängigkeit nötig
ist (vgl. OpenAPI-Eintrag oben).

**Warum Nur-Lese statt Sperre:** Auf Kundenhardware ist jede Durchsetzung
ein Zaun — wer Administrator ist, kann die Uhr stellen, die Datenbank ändern
oder das Bundle patchen. Eine harte Sperre hielte den Entschlossenen nicht
auf, träfe aber den ehrlichen Kunden, dessen Zahlung sich verzögert, und
schnitte ihn von Daten ab, die Aufbewahrungsfristen unterliegen. Nur-Lese
ist gleichzeitig das, was ein Vertrag tragen kann (offengelegte
Ablaufsperre, keine Sperre bei geringem Verzug; Stichworte in
`lizenzierung.md`, Abschnitt 5). Regel für alle Folgeänderungen: Die
Lizenzlogik löscht nie Daten.

**Warum das Wasserzeichen nur warnt:** Windows stellt Uhren von selbst um
(Secure Time Seeding korrigiert aus TLS-Handshakes heraus, teils um Stunden
oder Tage), VM-Snapshots springen zurück, NTP korrigiert nach. Ein Riegel
„Uhr steht vor gesehenem Datum ⇒ gesperrt“ hätte zuerst ehrliche Kunden
ausgesperrt, während ein Umgeher den Wert in der Datenbank zurücksetzt. Also
protokollieren, anzeigen, nicht sperren — mit einem Tag Toleranz, damit ein
einmal in die Zukunft gesprungener Wert nicht tagelang warnt.

**Warum minifiziert, aber nicht obfuskiert:** Das Archiv soll den Quelltext
nicht mitliefern (Source-Maps bleiben draußen, `--legal-comments=none`),
weil es sonst gleichgültig wäre, ob man das Repository weitergibt. Mehr als
Minifizierung ist kein Schutz, sondern Aufwand ohne Gegenwert: Die Prüfung
sitzt in einer JavaScript-Datei auf der Maschine des Kunden.

**Verworfen — Verzicht auf `<kunde>.ohrganize.com` bei Kundenservern:** Der
Einwand war ernst: Der Zoneninhaber kann DNS umbiegen und sich ein
Zertifikat holen, also könnte er Verkehr abfangen. Die Antwort ist nicht
Verzicht, sondern Sichtbarkeit und Pinning (`kunden-subdomain.md`): DNS-only
statt Proxy, HTTP-01 mit dem ACME-Konto des Kunden, CAA mit `accounturi` auf
dieses Konto, CT-Überwachung durch den Kunden, und für die Desktop-App —
den Verkehr der HR-Administration — feste Schlüssel (`serverKeyPins` in
`config.json`; serverseitig Caddy ≥ 2.8.0 mit `reuse_private_keys` bzw.
certbot mit `--reuse-key` bei nginx — ohne eines von beiden bräche der Pin
bei der ersten Erneuerung). Der Browserpfad des Portals
bleibt vom Zoneninhaber sichtbar umleitbar; das ist dieselbe
Vertrauensklasse wie die Auslieferung der Software. Wer sie nicht will,
fordert ausdrücklich eine Sonderanfertigung mit eigener Domain an; die
Portal-Adresse bleibt sonst immer `<kunde>.ohrganize.com`. Dass Let's-Encrypt-Laufzeiten bis 2028 auf 45 Tage
fallen, ändert daran nichts: Der Proxy erneuert selbst, der Schlüssel bleibt.

**In Kauf genommen — Schlüsselwechsel als geplanter Ausfall:** Bei einem
ACME-Aussteller (und bei Caddys interner CA) existiert der neue Schlüssel
erst nach der Neuausstellung; sein Pin lässt sich also nicht vorab
verteilen, und jede Desktop-App verweigert den Start, bis er eingetragen
ist. Die frühere Anleitung „erst Pin verteilen, dann Schlüssel tauschen“
war für ACME nicht ausführbar (Caddy erzeugt nach dem Löschen des
Speichers einen eigenen, vorher unbekannten Schlüssel). Statt Caddys
Speicheraufbau als Schnittstelle zu behandeln und einen selbst erzeugten
Schlüssel hineinzulegen, sagt die Doku es ehrlich: ankündigen, Freitagabend,
neuen Pin ablesen und ausrollen. Ohne Ausfall geht es nur mit einem selbst
erzeugten Schlüssel (Firmen-CA, statische Dateien).

## Gedankenstriche: Pruefung auf neue Zeilen statt Aufraeumen des Bestands

**Entscheidung:** `scripts/check-dashes.mjs` prueft im Modus `--base <ref>`
nur die seit `<ref>` hinzugekommenen Zeilen (plus unversionierte Dateien)
auf Halbgeviert- und Geviertstrich. Ganze Dateien nur auf ausdruecklichen
Pfadaufruf. Drei UI-Konventionen bleiben erlaubt: Geviertstrich als Leerwert
in Zellen, die Klammer aus zwei Geviertstrichen um Platzhalter leerer
Auswahlfelder, Halbgeviertstrich in Datumsspannen. Kein Opt-out per
Kommentar.

**Warum:** Der Anbieter will keine Gedankenstriche in Software und Doku,
raeumt den Bestand aber selbst auf. Ein Vollscan wuerde bei jeder
angefassten Datei Hunderte Altlasten melden und die Phasenabnahme
unbrauchbar machen; ein Diff-Scan haelt die Regel "es kommen keine dazu"
maschinell durch. Die drei Ausnahmen sind app-weit etablierte Konventionen
(je 15 bis 30 Stellen), deren Umbau die Konsistenz kosten wuerde.

**Verworfen, Kommentar-Opt-out:** Ein `// dashes-ok` haette den Weg des
geringsten Widerstands geoeffnet; wer eine Fundstelle wirklich braucht,
erweitert die Ausnahmeliste im Skript und begruendet es dort.

## Feiertags-Fixture vor dem Umbau der Regeln

**Entscheidung:** `apps/backend/src/test/fixtures/holidays-de.json` haelt
das heutige Ergebnis von `holidaysForYear` fuer 8 Jahre mal 16 Regionen
fest; `holidaysTest.ts` vergleicht bei jedem `npm test`.

**Warum:** Phase 5 traegt die Regeltabelle in Datenform um (Laender als
Dimension). Die Jahresweichen (2017 Reformationstag bundesweit, 2018
Nordlaender, 2019 Frauentag BE und Weltkindertag TH, 2023 Frauentag MV)
sind genau die Stellen, an denen ein Umbau still falsch werden kann. Die
Fixture wurde VOR dem Umbau aus dem alten Code erzeugt und ist damit ein
unabhaengiger Anker, kein Abschreiben der neuen Implementierung.

## Lizenztexte aus einer Funktion, Zustandsautomat ohne Seiteneffekte

**Entscheidung:** `describeLicense` in `packages/shared/src/licenseText.ts`
erzeugt Ueberschrift, Detail, Tonlage und Handlungssatz fuer jeden
Lizenzzustand; Banner, Lizenzseite, Dashboard-Widget, die 403-Meldung des
Backends und das Startlog lesen nur noch daraus. Der Zustand selbst
entsteht in `apps/backend/src/core/licenseState.ts` als reine Funktion
(`deriveLicenseState`); `core/license.ts` behaelt Cache, Datei und die
beiden Schreibvorgaenge. Unbefristet ist ein eigener Fall (`perpetual`):
kein Countdown, keine Kulanz, keine Warnung.

**Warum:** Der Anbieter will Lizenzmodelle frei gestalten (Testlizenz mit
beliebiger Laufzeit, kostenfrei unbefristet, Abo) und die Texte dazu
passend ("Ihre Lizenz läuft unbegrenzt und kostenfrei."). Bis hierher
standen die Saetze dreimal im Code (Renderer, Backend, Banner) und wichen
bereits voneinander ab; ein viertes Modell haette vier Stellen gebraucht.
Eine reine Funktion laesst sich tabellengetrieben in Millisekunden pruefen
(`licenseStateTest.ts`), waehrend der Smoke-Test mit Datenbank und Datei
Sekunden braucht und nur Stichproben nimmt. Der Zustandsautomat ohne
Seiteneffekte ist zudem die Voraussetzung fuer Betreiberwerkzeuge, die
eine Datenbank beschreiben, ohne sie zu veraendern (Phase 7).

**Verworfen, Texte im Backend erzeugen und ausliefern:** Das Backend liefert
Zahlen und Daten, die Oberflaeche formt Saetze daraus; ein Text im
API-Vertrag wuerde jede Wortaenderung zu einem Backend-Release machen und
Portal-Konten Texte zeigen, die nicht fuer sie bestimmt sind.

## Lizenz v2: Ausgabe und Bedingungen in der Datei, Editionen ohne feste Liste

**Entscheidung:** Die Lizenzdatei bekommt mit `v: 2` die Felder `edition`
und `country` (Pflicht), `features`, `terms` und `headline`. Das Schema
bleibt `.strict()`; v1-Dateien bleiben unveraendert gueltig, ein v1-Server
lehnt v2 ab. Editionen sind kein Enum, sondern ein Muster; welche es gibt,
steht im Variantenregister des Anbieters. Der Ausstell-Baustein
`core/licenseIssue.ts` ist gemeinsam fuer Werkzeug und conspectus. Die
Monotonie beim Einspielen haengt nur noch am Ausstelltag.

**Warum:** Lizenzmodelle sollen frei anlegbar UND funktionsfaehig sein
(3-Tage-Test, kostenfrei unbefristet, Abo, Kundenfunktion), ohne dass der
Kunde etwas umstellen kann. Das geht nur, wenn die Datei alles traegt, was
Anzeige und Durchsetzung brauchen. Editionen und Tarife sind beim Anbieter
noch nicht final; ein Enum im Schema haette jede Umbenennung zu einem
Server-Update gemacht. Die alte Monotonie (nie kuerzer) haette eine
kostenfreie Dauerlizenz nie durch ein Abo abloesen lassen; der Schutz gegen
alte Anhaenge bleibt ueber `issued_at`.

**Verworfen, Mindestserverversion als Konstante:** Die Version bleibt bis
zum Abschluss aller Phasen 1.0.0; eine Versionsschwelle haette nichts
unterschieden. Stattdessen melden Health und Lizenzbericht
`license_format`, und der Anbieter prueft die Faehigkeit statt der Zahl.

## Feature-Schluessel als zweite Achse neben der Edition

**Entscheidung:** Kundenspezifische und optionale Funktionen sind
Lizenzschalter innerhalb eines Builds (`FEATURES` in
`packages/shared/src/features.ts`, Gate `core/featureGate.ts` im globalen
Hook). Die Edition bleibt der Build-Inhalt. Ohne einschraenkende Lizenz ist
alles an; Routen ohne Feature-Eintrag bleiben offen (fail open), die
Bereichspruefung dahinter fail closed. Der Fehlercode
`LICENSE_FEATURE_MISSING` ist der einzige 403, den die Desktop-App als
Hinweis zeigt.

**Warum:** Der Anbieter will massgeschneiderte Loesungen ohne
Kunden-Branches. Ein Feature ist eine Zeile in der Registry plus Code im
Hauptprodukt, und die Freischaltung ist ein Feld in der signierten Datei;
so bleibt ein Codestand fuer alle Kunden. Fail open ist hier richtig, weil
ein vergessener Eintrag sonst eine bezahlte Funktion sperrte, waehrend die
Rechtepruefung der Administration (fail closed) davon unberuehrt bleibt.
"Alles an ohne Lizenz" haelt Bestandsinstallationen und die Testphase
unveraendert.

**Verworfen, Feature-Pruefung in den Routen:** Ein Gate je Modul waere in
vier Erfassungswegen zu vergessen; der globale Hook ist die einzige
Sicherheitsgrenze und kennt die Route ohnehin.

## Varianten als getrennte Builds ueber erzeugte Verdrahtung und Alias

**Entscheidung:** Eine Variante ist Land x Edition und wird als eigener
Build ausgeliefert. Quelle ist ein Register (JSON) mit frei definierbaren
Editionen; ein Generator schreibt je App eine Verdrahtungsdatei, die nur
die Module der Variante statisch importiert, und der Build zeigt den Alias
`@variant` darauf. Das Datenbankschema bleibt in allen Varianten gleich.

**Warum:** Der Anbieter will Ausgaben je Land und je Funktionsumfang
verkaufen, hat die Tarife aber noch nicht festgelegt. Ein Enum im Code
haette jede Tarifentscheidung zu einem Codeumbau gemacht; das Register
macht sie zu einem JSON-Eintrag plus `variants:gen`. Getrennte Builds
statt eines Builds mit Schaltern, weil nicht verkaufter Code dann nicht
beim Kunden liegt; die Verifikation (`check-variant`) misst genau das am
Bundle. Die Probe mit einer temporaeren Variante ohne Leistung, Fuehrung,
Verguetung, Kommunikation und Recruiting halbierte den Renderer-Bundle
(1.319 kB auf 1.010 kB) und liess die Routen dieser Module aus dem Backend
verschwinden.

**Verworfen, `define` mit totem `if`:** esbuild und Vite buendeln einen
statischen Import auch hinter totem Code, weil Routendateien Aufrufe auf
oberster Ebene enthalten. Nur der Verzicht auf den Import haelt den Code
fern; deshalb erzeugte Dateien mit genau den Importen der Variante.

**Verworfen, Verdrahtung von Hand je Variante:** Drei Apps mal n
Varianten von Hand zu pflegen waere die erste Fehlerquelle bei jeder
neuen Edition. Der Generator ist 150 Zeilen, und `variants:check`
verhindert, dass Repo und Register auseinanderlaufen.

**Verworfen, Manifest per Alias und Routen im selben Modul:** nav.ts und
dashboardConfig.ts brauchen nur das Manifest; importierten sie die
Verdrahtung mit allen Routen, entstuenden Importzyklen ueber die Seiten.
Daher zwei Aliasse.

**In Kauf genommen:** Je Release entstehen so viele Installer und Archive
wie Varianten; `appId` und `productName` bleiben gleich, die Variante
steht im Dateinamen und in der Startpruefung.

## Laender als Datendimension, Adapter statt fester Formate

**Entscheidung:** Land und Region sind Daten, keine Annahme im Code. Die
einzige Quelle ist `packages/shared/src/country.ts` (Regionen, Sprachkennung,
Waehrung, Regionsbegriff); das Land einer Installation ist `VARIANT.country`
und keine Kundeneinstellung. Die Feiertagsregeln stehen als Regeltabelle je
Land (`HOLIDAY_RULES`), Beschaeftigungsarten, Steuerklassen und
Kirchensteuermerkmale als Kataloge je Land, Lohnexport und Bescheinigungen
als Adapter-Registry. Migration `107_locations_country` ist additiv;
`locations.bundesland` bleibt und traegt den Regionscode des jeweiligen
Landes. AT und CH bekommen Strukturen, keine Inhalte.

**Warum:** Der Anbieter will Ausgaben je Land verkaufen, ohne den Code je
Land zu verzweigen. Bis hierher steckte Deutschland an drei Stellen als
Bundeslandliste (`holidays.ts`, `common.ts`, `employees/validation.ts`), als
`'de-DE'` in zwoelf Dateien, als DATEV-Lohnarten mitten in einer Route und
als Paragraph 108 GewO in einer HTML-Vorlage. Jede dieser Stellen waere bei
einem zweiten Land einzeln gefunden und einzeln vergessen worden. Als Daten
ist ein Land ein Eintrag, kein Suchlauf. Ein LEERER Katalog ist dabei die
ehrliche Aussage "gibt es hier nicht": Steuerklassen sind deutsch, also
blendet das Formular das Feld in einer anderen Ausgabe aus und die
Validierung weist einen Wert ab, statt ihn stillschweigend zu speichern.

**Warum die Region in der Antwort doppelt heisst:** Datenbankspalte und
API-Feld heissen seit der ersten Fassung `bundesland`, und beide Clients
lesen es so. Ein Umbenennen haette Backend und zwei Oberflaechen in einem
Schritt umgestellt; stattdessen liefern die Kalender- und Vorschau-Routen
`bundesland`, `region` und `country` nebeneinander, und die Clients ziehen
getrennt nach.

**Warum die Feiertagsregeln Jahresfenster tragen:** Vier Aenderungen der
letzten Jahre (Reformationstag 2017 und 2018, Frauentag 2019 und 2023)
standen als verschachtelte Bedingungen im Code. In Datenform ist jede
Fassung eine eigene Zeile mit `from`/`to`; die Fenster ueberschneiden sich
nicht, also gilt je Jahr genau eine. Die Fixture aus Phase 0 (8 Jahre mal 16
Regionen, vor dem Umbau erzeugt) hat den Umbau Zeile fuer Zeile abgesichert.

**Verworfen, das Land als Einstellung:** Eine Umschaltung zur Laufzeit
haette Personalakten mit Steuermerkmalen des alten Landes und Exporte im
alten Format hinterlassen, ohne dass irgendetwas sie korrigiert. Das Land
gehoert zum Build, wie die Edition: Ein Wechsel ist Installer plus Lizenz.

**Verworfen, AT und CH mit Inhalten fuellen:** Feiertage, Kataloge und
Abrechnungsformate anderer Laender sind Fachwissen, das der Anbieter
beisteuert, wenn er das Land verkauft. Erfundene Inhalte waeren schlimmer
als keine: Sie sehen fertig aus.

## Kanal als Funktion der Version, Release-Manifest mit SSH-Signatur

**Entscheidung:** Der Auslieferungskanal ist kein eigenes Feld, sondern folgt
aus der Versionsnummer: `1.2.0` ist `stable`, jede Version mit Vorabkennung
ist `beta`. `scripts/release.mjs` baut eine Version fuer alle gewuenschten
Varianten, legt sie unter `release/<version>/<kanal>/<variante>/` ab und
schreibt je Variante ein `release.json` mit Pruefsummen aller Artefakte,
signiert mit `ssh-keygen -Y sign` im Namensraum `ohrganize-release`. Das
Server-Archiv traegt die Variante im Namen und enthaelt `VARIANTE.txt`.

**Warum:** Ein Kanal als zusaetzliche Angabe ist eine Angabe, die jemand
vergessen oder falsch setzen kann, und zwar genau dann, wenn es weh tut: eine
Beta im stabilen Verzeichnis. Aus der Nummer abgeleitet kann das nicht
passieren. Die Variante im Archivnamen und in `VARIANTE.txt` schliesst den
zweiten Weg, auf dem ein Update stillschweigend falsch laufen kann: Wer eine
Datei in der Hand hat, sieht, wohin sie gehoert, und die Update-Anleitungen
beginnen mit genau diesem Abgleich gegen `/api/health` und die env-Datei.

**Warum ssh-keygen und nicht das Lizenzschluesselpaar:** Zwei getrennte
Vertrauensdomaenen. Ein verlorener Release-Schluessel darf keine Lizenzen
faelschen koennen und umgekehrt; auch die Rotation laeuft getrennt.
`ssh-keygen -Y sign` braucht kein neues npm-Paket, liegt auf jedem Linux-Server
und seit Windows 10 beim OpenSSH-Client bei, und die Gegenprobe ist ein
Einzeiler mit einer Allowed-Signers-Datei, die im Archiv mitreist.

**In Kauf genommen:** Die Ordnung der Versionen aendert sich. Seit
`compareVersions` Vorabkennungen kennt, ist `1.1.0-beta.1` aelter als `1.1.0`
und `isAtLeast('1.1.0-beta.1', '1.1.0')` falsch. Das ist semver-richtig, hat
aber eine Falle: Soll eine Beta derselben Nummer im Umlauf sein, muss
`MIN_CLIENT_VERSION` auf die Beta zeigen, sonst sperrt der Server genau die
Arbeitsplaetze aus, die testen sollen. Der Hinweis steht an der Konstante.

**Verworfen, Signatur ueber ein npm-Signaturpaket:** Eine neue Abhaengigkeit
fuer etwas, das auf beiden Zielplattformen bereits installiert ist, waere eine
zusaetzliche Lieferkette fuer genau den Schritt, der die Lieferkette absichern
soll.

## Hosting: Programm je Instanz als Symlink, Werkzeuge ohne config.ts, nie als root

**Entscheidung:** Im Mehrkunden-Hosting hat jede Instanz ihr eigenes
Programmverzeichnis: `/opt/ohrganize/kunden/<kunde>` ist ein Symlink auf
`/opt/ohrganize/releases/<variante>-<version>`, das Portal ebenso. Updates
laufen ueber `deploy/ohrganize-update.sh` (und `update-server.ps1` unter
Windows), der vor jedem Eingriff Pruefsumme, Signatur, Ausgabe und einen
Migrations-Probelauf auf einer Kopie prueft. Die Betreiberwerkzeuge
`status`, `admin-reset` und `migrate-check` importieren `config.ts` nicht und
verweigern den Lauf als root. Zwischen den Instanzen gilt Leseisolation ueber
`TemporaryFileSystem` plus `BindPaths`.

**Warum der Symlink:** Ein gemeinsames `/opt/ohrganize` traegt genau eine
Ausgabe. Sobald zwei Kunden verschiedene Editionen oder Laender haben, geht
das nicht mehr, und das Portal-Build traegt die Ausgabe ebenfalls. Der Symlink
loest gleich drei Dinge auf einmal: mehrere Ausgaben auf einem Host, einen
Rueckweg aus einem misslungenen Update (Symlink zurueck, fertig, ohne das
alte Archiv erneut zu entpacken) und das absichtliche Festhalten einer
Instanz auf einem alten Stand.

**Warum kein config.ts in den Werkzeugen:** Schon der Import legt
Verzeichnisse an und erzeugt ein `secret.key`, und zwar mit den Rechten des
aufrufenden Kontos. Ein Betreiber, der als root schnell den Zustand einer
Kundeninstanz nachsieht, haette damit root-eigene Dateien im Datenverzeichnis
des Dienstbenutzers hinterlassen und die Instanz beim naechsten Start
lahmgelegt. Genau deshalb steht `migrateDatabase` jetzt in einer eigenen
Datei ohne `db.js`: Beim ersten Testlauf des Probelaufs hing `config.ts`
ueber diesen Umweg noch mit drin und legte prompt Verzeichnisse an.

**Warum nie als root:** Jeder Zugriff auf eine SQLite-Datenbank im WAL-Modus
legt `-wal` und `-shm` daneben an, auch ein rein lesender. Als root gehoeren
die beiden dann root, und die naechste Schreibsperre des Dienstes scheitert
an den Rechten. Die Werkzeuge weisen den Lauf deshalb selbst zurueck, und
`provision.sh` ruft sie ueber `runuser -u` auf. Auf Windows greift die Regel
nicht (kein `process.getuid`, die Rechte haengen an NTFS-ACLs); die Pruefung
ueberspringt sich dort selbst, statt mit einer Fehlermeldung zu scheitern.

**Warum der Migrations-Probelauf:** Bisher war die Antwort auf "laeuft das
Schema dieses Kunden durch die neuen Migrationen" der Neustart des Dienstes,
und wenn nicht, stand der Kunde. `db.backup()` schreibt einen konsistenten
Stand in ein temporaeres Verzeichnis, dort wird migriert, und die
Kundendatenbank bleibt unberuehrt. Scheitert der Probelauf irgendwo, wird gar
keine Instanz umgestellt.

**Warum TemporaryFileSystem und nicht ein Benutzer je Kunde:**
`ReadWritePaths` verhindert seit jeher das Schreiben in fremde
Verzeichnisse, nicht das Lesen. Alle Instanzen laufen unter demselben Konto,
also konnte jede die Personalakte jeder anderen mitlesen. Ein leeres tmpfs
ueber `/var/lib/ohrganize` plus ein Bind-Mount des eigenen Verzeichnisses
schliesst das ohne neue Konten, ohne Migration und ohne Aenderung an den
Datenverzeichnissen. Echte Benutzertrennung bleibt die naechste Ausbaustufe;
sie ist mit `DynamicUser` nicht zu haben (die Datenverzeichnisse brauchen
einen stabilen Eigentuemer) und lohnt ab einer Handvoll Kunden je Host.

**In Kauf genommen:** Die Haertung ist auf der Entwicklungsmaschine gebaut
und in ihren Einzelteilen geprueft, aber noch nicht auf einem Debian-Server
durchgespielt. Die Wechselwirkung von `TemporaryFileSystem` mit
`StateDirectory` und `PrivateUsers=true` ist die Stelle, an der es klemmen
kann; `deploy/README.md` 9.7 fuehrt die Pruefliste dafuer, und die
Ressourcengrenzen sind bis zur Messung ausdruecklich Startwerte.

## conspectus: ein Register beim Anbieter, aber keine zweite Umstelllogik

**Entscheidung:** Das Werkzeug des Anbieters (`tools/conspectus`) fuehrt ein
SQLite-Register ueber Kunden, Hosts, Instanzen, ausgestellte Lizenzen,
Releases, Rollouts und Vorgaenge. Es stellt Lizenzen ueber denselben
Baustein aus wie das schlanke Werkzeug (`core/licenseIssue.ts`) und rollt
aus, indem es Archiv und Manifest auf den Host kopiert und dort
`ohrganize-update.sh` aufruft. Das Register liegt ausserhalb des
Repositories, und der Pfad ist Pflicht.

**Warum ueberhaupt ein Register:** Drei Angaben entscheiden ueber eine
brauchbare Lizenz, und alle drei stehen woanders: die Installations-ID (in
der Datenbank des Kunden), die Ausgabe (im Build) und die Faehigkeit, v2 zu
lesen (im laufenden Server). Wer sie abtippt, tippt sie irgendwann falsch,
und der Fehler faellt erst beim Kunden auf: Eine an die falsche Installation
gebundene Datei ist dort sofort unbrauchbar. Mit Register werden sie
nachgeschlagen.

**Warum keine Umstelllogik in conspectus:** Der Rollout muesste dieselben
Faelle behandeln wie `ohrganize-update.sh` (Ausgabe pruefen, Probelauf,
Sicherung, Ruecknahme) und waere die naechste Stelle, die auseinanderlaeuft.
Deshalb bleibt sie auf dem Host, und conspectus ist Transport plus Protokoll.
Dasselbe Argument wie bei der Lizenzpruefung, die Werkzeug und Server sich
teilen.

**Warum der Pfad Pflicht ist und geprueft wird:** Im Register stehen
Kundennamen, Hostadressen und Lizenznummern. Eine Vorgabe im
Heimatverzeichnis waere bequem und genau deshalb falsch: Niemand wuesste mehr,
wo die Datei liegt und ob sie gesichert wird. Ein Pfad im Repository waere
eine Unachtsamkeit von einem Commit entfernt, einer in OneDrive eine von der
halb synchronisierten WAL-Datei. Beides weist das Werkzeug ab, statt darauf
zu vertrauen.

**Warum v2 an der Faehigkeit haengt, nicht an der Version:** Es gibt keine
Mindestserverversion (die Version bleibt bis zum Abschluss aller Phasen
1.0.0). Health und Lizenzbericht melden stattdessen `license_format`;
conspectus verweigert eine v2-Datei, solange fuer die Instanz nicht belegt
ist, dass sie sie liest. Eine v2-Datei auf einem v1-Server bedeutete
Nur-Lese-Betrieb beim Kunden, und zwar ohne dass jemand es merkt, bis er
schreiben will.

**Verworfen, Zahlungen als eigene Tabelle:** Ein Vorgang ist alles, was zu
einem Kunden datiert festgehalten wird (Angebot, Lizenz, Rechnung, Zahlung,
Stoerung, Kuendigung). Eine eigene Zahlungstabelle haette die Haelfte der
Spalten doppelt und die Chronik eines Kunden auf zwei Abfragen verteilt.

**Verworfen, ssh ueber Shell-Strings:** In den Argumenten stehen
Kundenschluessel und Pfade aus dem Register. Ein Semikolon darin waere in
einem Shell-String ein zweiter Befehl auf einem fremden Server. Alle Aufrufe
laufen deshalb ueber Argument-Arrays mit `BatchMode=yes`.

## Creato Display statt Inter: Gewichtsbereiche in @font-face statt Umbau der Oberflaeche

**Entscheidung:** Desktop-App und Portal verwenden Creato Display, die
Hausschrift der Website, als einzige Familie. Die 14 Schnitte liegen als
WOFF2 im Workspace-Paket `packages/fonts` (SIL OFL, Lizenztext daneben);
beide Clients importieren `@ohrganize/fonts/creato-display.css` an der
Stelle, an der vorher `@fontsource-variable/inter` stand. Kein Gewichtswert,
keine Groesse und kein Abstand im Code wurde angefasst. Welche Zwischenstufe
welchen Schnitt traegt, legen `font-weight`-Bereiche in den
`@font-face`-Regeln fest: bis 479 Regular, 480 bis 599 Medium, 600 bis 749
Bold, darueber ExtraBold und Black.

**Warum Bereiche statt Normalisierung:** Die Oberflaeche nutzt rund 250
Stellen mit Zwischengewichten der Variable-Font (550, 560, 580 fuer Buttons
und Feldbeschriftungen, 600 fuer Badges und Namen, 620 bis 650 fuer
Tabellenkoepfe und Ueberschriften). Ohne Bereiche faellt nach der
CSS-Gewichtsauswahl alles ab 550 auf Bold; Buttons waeren so fett wie
Ueberschriften, die Stufen der Oberflaeche weg. Die Werte auf 500/700
umzuschreiben haette dieselbe Frage an jeder Stelle einzeln beantwortet und
kuenftigen Code nicht gebunden. Die Grenze bei 600 folgt der Messung der
Stammstaerke (fontTools, Buchstabe l): Creato Bold liegt bei 129 Promille
des Gevierts, Inter 600 bei 127, Inter 700 bei 146. Creato Bold ist also
Inter SemiBold, und 600 gehoert zu Bold; 550 bis 580 (117 bis 123) liegen
naeher an Creato Medium (106). Die Grenze Regular/Medium liegt bei 480 statt
in der Mitte, weil das einzige 460 (`.lead-fact__note`) als bewusst
leichtere Note in einem 580-Element steht; bei 450 fielen beide auf Medium
und der Unterschied waere nur noch Farbe.

**Zweitschrift Plus Jakarta Sans fuer das, was Creato nicht kann:** Die
Familie hat keine Tabellenziffern (`tnum` fehlt, die 1 ist 345 Einheiten
breit, die 0 621), und ihr Zeichenvorrat (245 Glyphen) deckt Deutsch
vollstaendig ab, aber einige osteuropaeische Buchstaben nicht (c mit Akut, s
mit Akut, z mit Punkt, g mit Breve, s mit Cedille, c mit Hatschek). Inter
hatte beides. Die Website paart Creato Display deshalb mit Plus Jakarta Sans
Variable (`@fontsource-variable/plus-jakarta-sans`), und die Clients tun
dasselbe an genau zwei Stellen: als erste Rueckfallschrift in `--font-sans`
(je Zeichen, die Buchstaben kommen aus Jakarta statt aus Segoe UI) und als
Familie `--font-numeric` an jeder Stelle mit `font-variant-numeric:
tabular-nums` (13 Selektoren plus die Personalnummer der Mitarbeiterliste).
Das sind exakt die Stellen, an denen die Zahlen mit Inter buendig standen;
alle anderen Zahlen waren auch mit Inter proportional. Pfeile (U+2192, 71
Stellen) fehlen in den Fontsource-Subsets von Inter und Jakarta gleichermassen
und kamen schon immer aus der Systemschrift. Bewusst NICHT umgestellt: die
Bescheinigungsvorlage im Backend (eigenstaendige HTML-Datei ohne Zugriff auf
die Schriftdateien), die Wartungsseite unter `deploy/` und der
conspectus-Bericht.

**Verworfen, Schrift veraendern:** Ein abgeleiteter Schnitt mit
gleichbreiten Ziffern waere technisch moeglich, ist aber eine Modified
Version im Sinne der OFL und duerfte den reservierten Namen nicht tragen.
Die Website faehrt mit denselben Dateien; ein zweiter Name fuer dieselbe
Schrift waere Verwirrung ohne Nutzen.

## Kanaele entfernt, Ankuendigungen und Umfragen erreichen die Dashboards, Verteiler statt vierter Zielgruppenart je Modul

**Entscheidung:** Die Kommunikationskanaele (Tabellen `channels`,
`channel_messages`, Routen `/api/communication/channels*`, Seite
„Kanaele“) sind gestrichen; Migration `501_distribution_lists` loescht die
Tabellen. Ankuendigungen und Umfragen bekommen stattdessen ihren
Empfaenger: `modules/me/communicationRoutes.ts` liefert der angemeldeten
Person genau die Eintraege, deren Zielgruppe sie einschliesst, und
Portal-Uebersicht wie Desktop-Dashboard zeigen daraus Karten, die nur mit
Inhalt erscheinen. Die Zielgruppe `abteilung` schliesst Unterabteilungen
ein, und eine neue Art `verteiler` zeigt auf einen von der HR gepflegten
Verteiler aus Abteilungen, Teams, Standorten und einzelnen Personen.

**Warum die Kanaele weg sind:** Sie waren ein Sender ohne Empfaenger. Die
HR konnte Kanaele anlegen und Nachrichten schreiben, aber kein Portal-Konto
konnte sie lesen; es gab weder Route noch Seite. Selbst mit Empfaenger
haetten sie dasselbe getan wie eine Ankuendigung (Einweg von HR an eine
Zielgruppe), nur ohne Lesebestaetigung und in Chat-Optik ohne
Chat-Funktion. Zwei Wege fuer dieselbe Mitteilung sind ein Support-Risiko:
Die HR glaubt, kommuniziert zu haben, und niemand hat es gelesen.

**Warum ein Verteiler und keine vierte Zielgruppenart:** Ankuendigungen und
Umfragen hatten genau eine Einheit als Zielgruppe (eine Abteilung ODER ein
Team ODER ein Standort). Mischungen wie „Standort Koeln plus der gesamte
Vertrieb plus drei Einzelpersonen“ waren nicht abbildbar. Ein Verteiler ist
eine benannte, wiederverwendbare Mischung, die die HR einmal pflegt; die
Ankuendigung zeigt nur darauf. Eine Person, die ueber eine Einheit des
Verteilers erreicht wird, darf nicht zusaetzlich einzeln enthalten sein:
Sonst behauptete die Mitgliederliste eine andere Zahl als die Empfaengerzahl,
und beim spaeteren Entfernen der Einheit bliebe die Person unbemerkt drin.

**Warum eine einzige Aufloesung:** `audience.ts` entscheidet fuer beide
Seiten, wer zu einer Zielgruppe gehoert: `countAudience` fuer die
Empfaengerzahl der HR, `audienceOfEmployeeSql` fuer die Sicht der Person.
Zwei getrennte Implementierungen haetten frueher oder spaeter Empfaenger
gezaehlt, die nichts sehen, oder umgekehrt. Aus demselben Grund laufen die
HR-Testerfassung einer Umfrage und die Portal-Teilnahme durch
`surveyService.recordParticipation`.

**Warum keine feste Kachel:** Ein Dashboard-Widget „keine Ankuendigungen“
ist Rauschen. Die Karten stehen ausserhalb der konfigurierbaren Widgets,
lassen sich nicht abwaehlen und erscheinen nur, solange es etwas gibt; eine
Umfrage verschwindet nach der Teilnahme, eine Ankuendigung mit Ablaufdatum
an diesem Tag. Ein Admin-Konto ohne verknuepftes Personalprofil bekommt 403
und damit schlicht keine Karte.

**Bewusst offen gelassen:** `audience_id` hat weiterhin keinen
Fremdschluessel (die Zieltabelle wechselt je Art). Beim Speichern weist
`checkAudience` eine fehlende Einheit ab; wird die Einheit spaeter
geloescht, erreicht die Ankuendigung niemanden mehr und die HR sieht
die Zielgruppe ohne Namen mit 0 Empfaengern. Ein Loeschschutz auf Abteilungen, Teams
und Standorten waere die naechste Stufe, gehoert aber ins Personalmodul.

## Verschluesselung im Ruhezustand: SQLCipher ueber einen npm-Alias, Schluesseldatei statt Umgebungsvariable

**Entscheidung:** Datenbank, Dateiablage und damit jede Sicherung liegen
verschluesselt auf der Platte. Die Datenbank im SQLCipher-4-Format ueber
`better-sqlite3-multiple-ciphers`, das als npm-Alias unter dem Namen
`better-sqlite3` installiert ist; die Blobs in `storage/` mit AES-256-GCM
(`core/fileCrypto.ts`). Der Schluessel steht in `<dataDir>/data.key`, wahlweise
als Verweis `extern:<absoluter Pfad>` auf eine Datei ausserhalb des
Datenverzeichnisses. `db/encryption.ts` ist die einzige Stelle, die eine
Datenbankdatei oeffnet.

**Ausgangslage (Pruefung vom 03./04.10.2026):** Die Uebertragung war bereits
dicht (https-Pflicht ausserhalb des eigenen Rechners, Schluessel-Pinning,
kurzlebige signierte Links, Query-Strings aus allen Logs entfernt). Im
Ruhezustand lag dagegen alles im Klartext: `ohrganize.db` mit Gehaeltern,
Bankverbindungen, Steuer- und Sozialversicherungsmerkmalen, Krankmeldungen
und Protokollen, jede Datei in `storage/` und jede Sicherung. Wer eine dieser
Dateien in die Hand bekam, konnte sie mit jedem SQLite-Werkzeug lesen.

**Warum die ganze Datenbank und nicht einzelne Spalten:** Spaltenweise
Verschluesselung haette jede Abfrage getroffen, die nach einem solchen Feld
sucht, sortiert oder summiert (Mitarbeiterliste, Gehaltsauswertungen,
Exporte), und sie schuetzte nur die Felder, an die jemand gedacht hat. Die
Seitenverschluesselung liegt unter SQL: Keine Abfrage, keine Route und keine
Oberflaeche aendert sich, und es bleibt kein vergessenes Feld im Klartext.

**Warum ein Alias und kein neuer Modulname:** Der Fork hat dieselbe
Versionsnummer und Schnittstelle wie das Original und veroeffentlicht
Fertigpakete fuer dieselben Node- und Electron-Fassungen. Als Alias bleiben
Importe, `--external`, `npm rebuild better-sqlite3`, `reset-native.mjs` und
die Ladeproben der drei Deploy-Skripte unveraendert, also genau die Stellen,
die sich hier nicht automatisch testen lassen. Der Preis steht in CLAUDE.md
unter den Fallstricken: npm vergleicht bei einem Alias nur die
Versionsnummer, ein vorhandenes Original gleicher Version gilt deshalb als
passend. Dagegen steht die Pruefung in `applyKey` (bricht mit Erklaerung ab,
wenn das Modul nicht verschluesseln kann).

**Warum SQLCipher 4 mit Rohschluessel:** Es ist das verbreitetste Format;
ein Bestand laesst sich im Notfall mit jedem SQLCipher-Werkzeug oeffnen,
wenn es oHRganize einmal nicht mehr gaebe (die Personalakte hat
Aufbewahrungsfristen). Der Rohschluessel (64 Hex-Zeichen statt Passphrase)
spart die Schluesselableitung bei jedem Oeffnen; ein Zufallsschluessel
braucht sie nicht. Mit Fremdwerkzeugen geoeffnet wurde ein Bestand hier noch
nicht, die Aussage stuetzt sich auf die Dokumentation der Bibliothek.

**Warum eine Schluesseldatei und keine Umgebungsvariable:** Den Schluessel
braucht jeder Prozess, der das Datenverzeichnis kennt: Dienst, Sicherung und
die Betreiberwerkzeuge. Die bekommen nicht dieselbe Umgebung (die Werkzeuge
laufen ueber `runuser` ohne env-Datei, die Windows-Sicherungsaufgabe setzt
nur `OHRGANIZE_DATA_DIR`), und unter Windows kopiert NSSM die Umgebung in
einen Registry-Zweig, den jedes lokale Konto lesen darf. Eine Datei im
Datenverzeichnis finden alle; soll der Schluessel woanders liegen, steht dort
der Verweis. Ein Umzug des Schluessels nach aussen wechselt ihn nicht: Jede
fruehere Sicherung enthaelt ihn samt `secret.key` weiterhin und oeffnet damit
auch die spaeteren. Ein Schluesselwechsel (Datenbank und alle Dateien neu
verschluesseln, absturzsicher bei gemischtem Bestand) ist bewusst nicht
gebaut; `deploy/README.md` sagt das beim Umzug ausdruecklich.

**Was der Schluessel neben den Daten leistet und was nicht:** Er schuetzt
einzelne Dateien (eine kopierte Datenbank, ein Blob, Reste auf einer
ausgemusterten Platte, eine an den Support geschickte Datei), nicht den
vollstaendig kopierten Ordner und nicht eine Sicherung, die ihn enthaelt.
Das ist die Vorgabe, weil jede Trennung einen neuen Verlustfall schafft:
Schluessel weg heisst Daten weg, und eine Sicherung, die sich nach einem
Plattendefekt nicht mehr oeffnen laesst, ist schlimmer als eine lesbare. Wer
die ausgelagerten Sicherungen schuetzen will, nimmt den Verweis und sichert
die Schluesseldatei getrennt; dann laesst die Sicherung auch `secret.key`
weg, mit der sich sonst Sitzungen fuer den laufenden Server faelschen
liessen. Verworfen fuer die Desktop-App: der Schluesselspeicher des
Betriebssystems (DPAPI). Er bindet den Bestand an das Windows-Konto; ein
kopiertes Profil auf einem neuen Rechner oder ein zurueckgesetztes
Kontopasswort machte die Personalakte unlesbar.

**Warum an Ort und Stelle umgeschluesselt wird und nicht auf einer Kopie:**
Die ersten beiden Fassungen verschluesselten eine Kopie und setzten sie per
Umbenennen an die Stelle des Originals, zuletzt mit Aenderungszaehler und
EXCLUSIVE-Sperre gegen fremde Commits. Das zweite Review hat gezeigt, dass das
unter POSIX grundsaetzlich nicht haelt: Ein Prozess, der die alte Datei vorher
geoeffnet hatte (admin-reset beim bcrypt, eine Sicherung), fand nach dem
Umbenennen das WAL der NEUEN Datei ueber den Pfad, schrieb unverschluesselte
Seiten hinein und beschaedigte sie (unter Linux nachgestellt, `integrity_check`
meldete fehlende Seiten). Dazu hob das Lesen des Aenderungszaehlers ueber einen
zweiten Deskriptor die SQLite-Sperre des Prozesses auf (fcntl-Semantik,
nachgemessen). Jetzt schluesselt `PRAGMA rekey` die Datei selbst in einer
Transaktion mit Rollback-Journal um: dieselbe Datei, SQLite sperrt selbst,
eine vorher geoeffnete Verbindung scheitert danach mit SQLITE_NOTADB statt zu
schreiben (unter Windows und Linux nachgestellt, die Datenbank des Dienstes
blieb intakt). Die Umstellung liest den Dateikopf nicht mehr bei offener
Verbindung.

**Warum das absturzsicher ist, und wann das Journal ohne Schluessel
zurueckgespielt wird:** Gemessen mit `kill -9` an ueber 60 Stellen einer
Umschluesselung von 189 MB unter Linux und Windows. Bricht es im Neuaufbau ab,
ist die Datei unveraendert; bricht es im Zurueckschreiben oder im Commit ab,
liegt ein Journal mit den urspruenglichen Seiten daneben, im Commit ist die
erste Seite aber schon verschluesselt (12 Faelle). Mit Schluessel geoeffnet
spielt SQLite3MC dieses Journal nicht zurueck und meldet nur SQLITE_NOTADB;
ohne Schluessel spielt SQLite es roh zurueck, und der Klartextbestand war in
jedem Fall vollstaendig wieder da (400 000 Zeilen, `integrity_check` ok).
Die zweite Fassung tat das fuer JEDES Journal und hielt rohes Zurueckspielen
fuer schluesselunabhaengig. Das dritte Review hat das widerlegt: Das Journal
eines bereits verschluesselten Bestands traegt verschluesselte Seiten, SQLite
bildet die Pruefsummen aber ueber den Klartext. Ohne Schluessel stimmt keine,
SQLite haelt das Journal fuer leer, loescht es und laesst die halbe
Transaktion in der Datei (nachgestellt: `integrity_check` ok, Inhalt falsch;
mit Schluessel kam der Stand vollstaendig zurueck). Deshalb ordnet
`rollBackHotJournal` das Journal zuerst ein: Stimmen die Pruefsummen ueber die
rohen Bytes und beginnt eine enthaltene Seite 1 mit "SQLite format 3", ist es
Klartext und wird ohne Schluessel zurueckgespielt, sonst mit. Gegengeprueft
unter Windows mit 60 Abbruechen einer Umstellung von 112 MB, davon 24 mit
liegengebliebenem Journal, alle ohne Verlust. Das geschieht vor jeder
Zustandsbestimmung in `openDatabase`, auch fuer lesende Werkzeuge.
Vor UND nach dem Umschluesseln prueft `quick_check`. Vorher, weil ein alter
Schaden, mit dem die bisherige Fassung lief (nachgestellt: falsch gezaehlte
Freiliste), sonst nach dem Umschluesseln als gescheiterte Umstellung gegolten
und den Dienst angehalten haette; so bleibt der Bestand unverschluesselt und
der Dienst laeuft wie bisher. Scheitert die Pruefung danach (nie beobachtet),
startet der Dienst nicht, denn einen Klartextstand zum Weiterlaufen gibt es
dann nicht mehr. Scheitert die Umstellung selbst, laeuft der Dienst
unveraendert weiter (Verfuegbarkeit geht vor, der naechste Start versucht es
erneut). Ausnahme: Ein SQLite-Modul, das gar nicht verschluesseln kann
(`CipherUnavailableError`, vor Schluessel und Vermerk geprueft), ist ein
Startabbruch; Weiterlaufen hiesse, Datenbank und neue Dateien dauerhaft im
Klartext zu halten, ohne dass es jemand sieht. Welcher der beiden Faelle vorliegt, entscheidet der Zustand der
Datei danach, nicht die Art des Fehlers: Ob ein Fehler des Umschluesselns
vor oder nach dessen Commit lag, sieht man ihm nicht an. Auf andere
Verbindungen wartet die Umstellung hoechstens 10 s, fuer Journalmodus und
Sperre zusammen (zwei getrennte Fristen und ein busy_timeout darueber
summierten sich auf rund 25 s).

**Warum Hilfsdateien nur fuer einen Klartextbestand auf der Platte liegen:**
SQLite3MC verschluesselt Datenbankdatei und `-wal`, nicht aber die
Hilfsdateien. Ein VACUUM einer verschluesselten Datenbank schrieb deren Inhalt
im Klartext in die Hilfsdatei (gemessen: 41 MB aus einer 82-MB-Datenbank,
Inhalt lesbar). Eine Verbindung auf eine verschluesselte Datenbank haelt
deshalb alles Temporaere im Arbeitsspeicher (`temp_store = MEMORY`; ein
VACUUM kostete dort das 1,5-Fache der Nutzdaten, gemessen 62 MB Spitze
fuer 41 MB). Fuer einen Klartextbestand bleibt `<dataDir>/.sqlite-tmp`: Das
Umschluesseln kostete im Arbeitsspeicher die 1,3-fache Datenbankgroesse
(gemessen) und haette eine grosse Datenbank unter `MemoryMax=768M` in den
OOM-Killer geschickt, das System-Temp hielt eine Klartextkopie, und auf der
Platte steht dort nichts, was nicht ohnehin im Klartext dasteht. Das VACUUM
nach Migrationen braeuchte bei mehr als 300 MB Nutzdaten mehr, als die
Hosting-Unit ohne Drosselung hergibt ((512 MB MemoryHigh - 60 MB Grundbedarf)
/ 1,5); es wird dann uebersprungen (Warnung bei jedem Start). Die erste
Fassung setzte die Grenze bei 384 MB, gerechnet mit dem Einfachen der
Nutzdaten statt dem gemessenen 1,5-Fachen.

**Warum Migrationen unter secure_delete laufen und 502 eine Tabelle neu
aufbaut:** Faellt das VACUUM aus (zu gross, gescheitert), muessen die Daten,
die eine Migration entfernt, trotzdem aus der Datei sein. `secure_delete`
nullt, was DROP TABLE und DELETE freigeben (Gegenprobe: ohne es standen die
alten Antwort-Zeitstempel nach 502/503 noch in der Datei). Es erfasst aber
nicht die Kopien, die beim Umschreiben von Zeilen in Seitenluecken bleiben:
Nach `DROP COLUMN participated_at` standen die Teilnahme-Zeitstempel trotz
`secure_delete` noch darin (nachgestellt). Auch Leeren mit DELETE FROM und
Wiederbefuellen genuegte nicht: Bei eingeschalteten Fremdschluesseln (im
Dienst, und in diesem SQLite-Build die Vorgabe) loescht SQLite Zeile fuer
Zeile statt die Tabelle zu leeren, die Wurzelseite wird nie frei, und ein
Rest in ihrer Luecke blieb stehen (nachgestellt; dasselbe galt fuer den
Neuaufbau beim Umfrageende, der deshalb jetzt `rebuildTableInKeyOrder`
nutzt). 502 baut die Teilnahmen deshalb mit demselben Helfer neu auf, ueber
den TypeScript-Schritt `run` der Migration (gleiche Transaktion); eine
Zwischenfassung schrieb diesen Neuaufbau samt Tabellendefinition und
AUTOINCREMENT-Zaehler in SQL nach, eine zweite Umsetzung, die vom Helfer und
von 500 abweichen konnte. Damit kommt 502/503 ohne VACUUM aus
(encryptionSmoke.ts, Abschnitt 7). Verwaiste Zeilen (Umfrage oder Person
fehlt, nur ausserhalb der Anwendung ohne Fremdschluessel moeglich) loescht
502 vorher: Das Wiedereinfuegen prueft die Fremdschluessel, und
`defer_foreign_keys` half nicht (das Loeschen einer verwaisten Zeile zaehlt
nicht gegen, gemessen); die Kaskade haette sie ohnehin geloescht. Der Helfer
verweigert Tabellen, auf die Fremdschluessel zeigen, und Tabellen ohne
INTEGER PRIMARY KEY als rowid (deren rowids gingen verloren). Fuer die
uebrigen loescht DROP TABLE auch bei eingeschalteten Fremdschluesseln nicht
vorher Zeile fuer Zeile (sqlite3FkDropTable, nachgelesen). Die Regel fuer
kuenftige Migrationen steht in CLAUDE.md.

**Warum secure_delete fuer jede Verbindung gilt:** Zuerst setzten es die
Stellen, die Umfragedaten loeschen, einzeln. Das Loeschen eines
Personalprofils (Kaskade in die Teilnahmen) und einer Umfrage umging es
schon, und jeder neue Loeschweg haette die Regel still gebrochen.
`configureConnection` setzt es deshalb fuer jede Verbindung ueber
`openDatabase`; das nullt nebenbei auch sonst Geloeschtes (Personalakten,
Loeschung nach DSGVO Art. 17), fuer ein paar zusaetzlich geschriebene
Seiten je Loeschung. Die Teilnahme setzt es deshalb nicht mehr bei jedem
Aufruf, sondern prueft es nur (`assertSecureDelete`): Eine an
`openDatabase` vorbei geoeffnete Verbindung faellt laut auf.

**Warum die Dateiablage erst nach dem Start und nur bei verschluesselter
Datenbank umgestellt wird:** Scheitert der Start einer neuen Fassung, nimmt
`ohrganize-update.sh` sie zurueck; die alte Fassung kann umgestellte Blobs
nicht lesen. Die erste Fassung verliess sich darauf, dass bis zum Start keine
entstehen, aber die Ruecknahme kann auch nach `listen` greifen (Health- oder
Ausgabenpruefung). Deshalb zwei Regeln: Verschluesselt geschrieben und
umgestellt wird nur, wenn die Datenbank selbst verschluesselt ist (dann
startet die alte Fassung ohnehin nicht, ohne dass die Ruecknahme die
Sicherung zurueckspielt), und diese Ruecknahme spielt Datenbank UND
`storage/` aus derselben Sicherung zurueck. Die Zwischendateien liegen in `storage/.umstellung`: Die
erste Fassung kennzeichnete sie in `storage/` per Endung, und dieselbe Endung
durfte ein Upload tragen, der beim naechsten Start geloescht worden waere; die
zweite legte sie neben `storage/`, und auf einem eigenen Mount fuer `storage/`
scheiterte dann jedes Umbenennen (EXDEV). Ein Unterverzeichnis hat beides
nicht, die Sicherung laesst es aus. Welche Dateien schon geprueft sind,
steht als Fingerabdruck je Datei (Datei-ID, Groesse, mtime in Nanosekunden)
in der Tabelle `_storage_checked`; stimmt er, kostet die Datei nur ein stat
statt Oeffnen und Lesen. Drei fruehere Fassungen dieses Vermerks hielten nicht:
ein Vermerk "fertig" schaltete die Umstellung ganz ab (eine einzeln
zurueckgelegte Klartextdatei blieb fuer immer unverschluesselt); eine
ctime-Zeitmarke aus `Date.now()` scheiterte an Netzlaufwerken mit
nachgehender Uhr; eine ctime-Zeitmarke vom Dateisystem scheiterte an Windows,
das beim Kopieren (Copy-Item, CopyFile, robocopy) die ctime der Quelle
erhaelt (gemessen: Kopie um 11:55:29 mit ctime 11:55:26), und an jedem
Umbenennen eines Verzeichnisses. Ein ersetztes, kopiertes oder
ueberschriebenes Exemplar aendert dagegen Datei-ID, Groesse oder mtime.
Gescheiterte Dateien bekommen keinen Eintrag und kommen beim naechsten Start
wieder dran, ohne die uebrigen aufzuhalten. Die Tabelle steht in der
Datenbank, damit sie mit ihr zurueckgespielt wird; ein Start schreibt dort nur
abweichende Eintraege (die erste Fassung schrieb die ganze Tabelle bei jedem
Start neu). Die Umstellung einer Datei
laeuft asynchron je Abschnitt; synchron blockierte eine Datei von 50 MiB den
Dienst 420 ms, in der Desktop-App samt Fenster. Weil der Dienst dabei
weiterlaeuft, kann die Datei inzwischen geloescht sein; das Umbenennen legte
sie dann wieder an, verschluesselt, ohne Datensatz und in jeder Sicherung
(nachgestellt unter Windows mit einer Datei von 30 MiB). Unmittelbar davor
vergleicht die Umstellung die Datei deshalb synchron mit dem Stand beim
Oeffnen. Leere Dateien, die juenger als zwei Minuten sind, laesst sie aus:
So sieht ein Upload aus, der gerade beginnt. Dateien der ersten Fassung des
Formats schreibt der Lauf auf Fassung 2 um, nach Kontrolle ihres Pruefwerts.

**Warum die Umstellung die Datei exklusiv sperrt und warum eine gescheiterte
Pruefung einen Vermerk hinterlaesst:** Zwischen dem Wechsel nach DELETE und
dem Umschluesseln konnte die Sicherung ueber `getDb()` die Datei zurueck in den
WAL-Modus stellen; das Umschluesseln landete dann im `-wal`, der Dateikopf
blieb im Klartext, und jedes Oeffnen scheiterte (nachgestellt).
`locking_mode = EXCLUSIVE` haelt die Datei bis zum Ende der Umstellung fest
(nachgestellt: die zweite Verbindung bekommt SQLITE_BUSY). Scheitert die
Pruefung nach dem Umschluesseln, ist die Datei verschluesselt; der Neustart
durch systemd oder NSSM saehe nur "schon verschluesselt" und liefe auf ihr
weiter. Der Vermerk `umstellung-pruefung-gescheitert.txt` entsteht deshalb
VOR dem Umschluesseln (durchgeschrieben samt Verzeichniseintrag) und faellt
erst nach bestandener Pruefung weg. Die erste Fassung schrieb ihn erst nach
dem Scheitern: Scheiterte auch das (volle Platte, oft dieselbe Ursache),
verdeckte dieser Fehler den ersten, und der Dienst lief auf der ungeprueften
Datei weiter, jeder Neustart ebenso; ein Absturz zwischen Commit und Pruefung
hinterliess gar keinen. Findet ein Start den Vermerk bei verschluesselter
Datei, prueft er erneut und startet nur, wenn die Pruefung besteht (fehlt der
Schluessel, nennt die Meldung genau das statt "Pruefung nicht bestanden");
bei Klartext (Umstellung nie committed, oder die Sicherung von vorher ist
zurueckgespielt) wird umgestellt, und die Umstellung entfernt den Vermerk mit
ihrem Erfolg. So erledigt er sich auch nach einem Restore von Hand (Windows),
und ein voruebergehender Fehler der Pruefung sperrt nicht dauerhaft, was
gerade in der Desktop-App ohne Sicherung von vor dem Update zaehlt. Angelegt
und entfernt wird er nur unter der exklusiven Sperre der Umstellung: Eine
Zwischenfassung entfernte einen Vermerk neben einem Klartextbestand gleich
beim Start, und ein zweiter, gleichzeitig startender Prozess haette so den
Vermerk einer laufenden Umstellung geloescht (nachgestellt: Ohne die Sperre
bleibt er jetzt unangetastet). `status.cjs` meldet ihn
(`encryption.conversion_marker`), `provision.sh check` neben einer
verschluesselten Datenbank als Befund. Den Zustand bestimmt der Start erst
nach dem Zurueckspielen eines Journals (`settledDatabaseState`), sonst fiel
die Umstellung nach einem Abbruch im Commit fuer einen Start still aus.

**Warum die Sicherung die laufende Datenbank prueft:** `VACUUM INTO` baut die
Kopie aus den Zeilen neu auf; ihre Pruefung sieht deshalb keine Schaeden der
Quelle mehr (nachgestellt: falsche Freiliste und verlorene Seiten, Kopie
"ok"). Mit der frueheren Seitenkopie fiel das auf. Ein `quick_check` auf der
Quelle davor stellt das wieder her. Die Dateiablage kopiert die Sicherung mit
erhaltenen Zeitstempeln: `storageEncryptionState` haelt eine leere oder
abgeschnittene Datei, die juenger als zwei Minuten ist, fuer einen Upload in
Arbeit, und unter Linux traegt eine Kopie ohne `preserveTimestamps` die
Uhrzeit des Kopierens; das MANIFEST nannte dann nie eine beschaedigte Datei.

**Warum die Blobs in Abschnitten verschluesselt sind:** Die erste Fassung
des Dateiformats hatte einen einzigen GCM-Pruefwert am Ende. GCM prueft erst
dort; damit keine beschaedigte Datei als vollstaendige Antwort hinausgeht,
musste jeder Download die Datei zweimal lesen und entschluesseln, und das
erste Byte kam erst nach dem ganzen ersten Durchgang. Fassung 2 teilt in
Abschnitte zu 64 KiB mit eigenem Pruefwert, Schluessel je Datei per HKDF aus
einem Salz, Nonce aus Praefix, Abschnittsnummer und Schlusskennzeichen, der
Kopf in jedem Abschnitt mit authentifiziert (Aufbau wie Tinks
AES-GCM-HKDF-Streaming). Jeder Abschnitt ist geprueft, bevor er hinausgeht;
der erste vor den Kopfzeilen, sodass ein falscher Schluessel oder ein
beschaedigter Anfang eine Fehlerantwort ergibt. Scheitert ein spaeterer
Abschnitt, bricht die Uebertragung ab, und der Browser meldet den Download als
gescheitert. Fassung 1 bleibt lesbar (Kennung mit Versionsbyte), geschrieben
wird nur Fassung 2.

**Warum `VACUUM INTO` statt `db.backup()`:** Die Online-Backup-Schnittstelle
oeffnet ihr Ziel ohne Schluessel und lehnt eine verschluesselte Quelle ab
(„backup is not supported with incompatible source and target databases“).
`VACUUM INTO` liest in einer Lesetransaktion denselben konsistenten Stand,
schreibt die Kopie mit dem Schluessel der Quelle und hinterlaesst keine
`-wal`-Datei. Nebenwirkung: Die Kopie des Migrations-Probelaufs im
temporaeren Verzeichnis ist jetzt ebenfalls verschluesselt.

**Geprueft:** `src/test/encryptionSmoke.ts` (Umstellung eines
Klartextbestands, Upload und Download, Sicherung, Werkzeuge, fehlender und
falscher Schluessel, Verweis, liegengebliebenes Journal beider Arten,
Abschnittsgrenzen aller drei Schreibwege samt Fassung 1, Lage der
Umfrageantworten, Checkpoint neben einem Leser); die gebauten Bundles und das Server-Archiv
unter Windows (Node 24, Fertigpaket) und Debian 13 (Node 20, aus dem
Quelltext uebersetzt); die gepackte Desktop-App in der Electron-Laufzeit
gegen eine Kopie eines echten Klartextbestands (361 Dateien, alle
Bestandszahlen unveraendert).

**Bewusst offen gelassen:**
- Ein Zurueck auf eine Fassung vor der Verschluesselung geht nur ueber den
  vollstaendigen Restore einer Sicherung von davor.
- Reste des frueheren Klartexts in freigegebenen Plattenbereichen lassen
  sich nachtraeglich nicht beseitigen; dagegen hilft nur ein verschluesseltes
  Dateisystem. Innerhalb der Datenbankdatei raeumen bei 502/503
  `secure_delete` und der Neuaufbau der Tabellen auf (ohne VACUUM keine alten
  Zeitstempel mehr, encryptionSmoke Abschnitt 7); das VACUUM, das Migrationen
  mit `vacuumAfter` ausloesen, erfasst nur noch aeltere Reste aus der Zeit vor
  `secure_delete`. Ueber 300 MB Nutzdaten (verschluesselt) entfaellt es
  endgueltig mit einer Warnung; scheitert nur der Checkpoint danach, holt der
  naechste Start nur ihn nach (`_vacuum_checkpoint_pending`).
  Das VACUUM ist im Commit der Migration vermerkt (`_vacuum_pending`):
  Scheitert es (Platz, Speicher), warnt der Start nur, und jeder spaetere
  holt es nach; die erste Fassung brach den Start ab und versuchte es nie
  wieder.
- Umfragen: Teilnahme und Antwort entstehen in einem Commit, und die Frames
  im `-wal` hielten die Reihenfolge fest (gemessen). Nach jeder Teilnahme
  leert ein Checkpoint das `-wal`, ohne zu warten (`clearWalSoon`; die
  zweite Fassung wartete synchron bis zu 5 s je Phase auf jeden Leser, etwa
  die Sicherung, und hielt so die ganze Instanz an). Die zufaellige
  Antwort-ID allein genuegte nicht: SQLite legt neue Zellen einer Seite in
  Einfuegereihenfolge ab, nach ihrer Lage sortiert ergaben die Antworten genau
  die Reihenfolge der Teilnahmen (gemessen, 1 bis 12). Jede Teilnahme schreibt
  deshalb die Nachbarn der neuen Antwort in zufaelliger Reihenfolge neu, mit
  `secure_delete` fuer die geloeschten Zellen (`storeAnonymousResponse`):
  alle Zeilen, die mit ihr auf einer Tabellenseite liegen koennen, gesammelt
  nach ID zu beiden Seiten, bis eine Untergrenze der belegten Bytes eine Seite
  uebersteigt. Bei grossen Antworten (ab einem Achtel Seite, 512 Byte) genuegt
  das nicht: Dann haengt fast jede Teilnahme eine Seite am Dateiende an, und
  die geht an eine Zeile der Nachbarschaft, also an eine mit aehnlicher ID
  (gemessen bei 400 bis 800 Antworten zu 0,7 bis 2,5 KB: 60 bis 76 Prozent
  Treffer gegen 5 bis 10 bei Zufall). Darum nimmt eine grosse Antwort eine
  Stichprobe von 256 zufaelligen Antworten aus der ganzen Tabelle in das
  gemischte Neuschreiben auf (`REWRITE_SAMPLE_ROWS`, eine Indexsuche je Zeile
  ab einer zufaelligen ID; eine Tabelle bis 256 Zeilen wird ganz neu
  geschrieben). Die angehaengte Seite gehoert dann einer beliebigen Zeile der
  Stichprobe: Anonymitaetsmenge rund 256, Trefferquote wie bei Zufall
  (nachgemessen bei 800 und 1200 Antworten). Die erste Fassung dieser Aenderung
  schrieb die GANZE Tabelle neu: gleiche Wirkung, aber 41 ms bei 1 MiB, 135 ms
  bei 2,4 MiB und 210 ms bei 3,6 MiB je Teilnahme (verschluesselt), im
  Hauptprozess der Desktop-App; die Stichprobe kostet 35 bis 100 ms auch bei
  3000 bis 6000 Antworten. Ein Neuaufbau der Tabelle in
  Schluesselreihenfolge nach jeder Teilnahme genuegte nicht (18 Prozent in den
  letzten 60 Teilnahmen, weiter ueber Zufall). Die erste Fassung schrieb bei
  JEDER Teilnahme die ganze Umfrage neu, ohne Grenze, was mit der Umfrage
  quadratisch wuchs; die zweite schrieb wegen des Index auf
  `survey_id` je Teilnahme rund 1000 volle Zeilen neu (gemessen bis 390 ms
  bei 2 KB je Antwort). Migration 503 entfernt den Index deshalb (die
  Auswertung liest die Tabelle ganz, bei dieser Groesse Millisekunden), legt
  alle IDs in denselben 48-Bit-Bereich wie neue Antworten (502 vergab bis
  2^53, an der Groesse liessen sich Antworten von vor und nach dem Update
  trennen) und kopiert die Zeilen in Schluesselreihenfolge (502 kopierte sie
  in der alten Reihenfolge der Teilnahmen). Gemessen an 1500 Antworten: Bei
  einfachem Einfuegen lag die zuletzt eingefuegte Zelle auf 12 von 24 Seiten
  bei der juengsten Teilnahme, nach dem Neuschreiben auf keiner. Beim
  Verschieben von Zellen zwischen Seiten bleiben vereinzelt Kopien aelterer
  Antworten in Seitenluecken stehen (gemessen 8 von 1200 bei gemischten
  Laengen; secure_delete erfasst diese Luecken nicht, `sqlite_dbpage` zum
  gezielten Ueberschreiben fehlt im Build); das Beenden einer Umfrage baut
  deshalb die Tabelle neu auf (`rebuildResponseTable`): in einer Transaktion
  alle Zeilen in eine temporaere Tabelle, die Tabelle mit DROP TABLE
  entfernen und neu anlegen, in Schluesselreihenfolge zurueckschreiben, mit
  `secure_delete`, das jede freiwerdende Seite nullt (nachgestellt mit
  Kopien, die roh in die Luecken von Blatt- und Wurzelseiten geschrieben
  waren: danach keine mehr, jede Antwort genau einmal; eine Zwischenfassung
  leerte mit DELETE FROM und liess bei eingeschalteten Fremdschluesseln den
  Rest in der Wurzelseite stehen). Seiten, die schon vorher frei waren,
  erreicht das nicht; sie tragen keine Umfragedaten, weil jede Verbindung
  `secure_delete` gesetzt hat (siehe oben, "Warum secure_delete fuer jede
  Verbindung gilt"). Eine Zwischenfassung ueberschrieb bei jedem Umfrageende
  zusaetzlich alle freien Seiten; das kostete jedes Mal die ganze Freiliste
  und eine Seite Wachstum, fuer Reste, die es nach der Regel oben nicht mehr
  gibt. Die erste Fassung baute die ganze Datei per
  VACUUM neu auf; dessen Kopie schrieb SQLite unverschluesselt in eine
  Hilfsdatei (siehe oben), und es blockierte fuer die ganze Datei. Der
  Neuaufbau ist im Commit des Umfrageendes vermerkt und wird nach einem
  Fehlschlag beim naechsten Start nachgeholt. Er kopiert die ganze Tabelle,
  ueber alle Umfragen, und waechst damit mit dem Bestand; gemessen 204 ms
  fuer 60 000 Antworten (verschluesselt, WAL, volles Durchschreiben), also
  etwa fuenf Jahre monatlicher Umfragen bei 1000 Beschaeftigten. Erwogen und
  verworfen: die Antworten einer Umfrage ueber die ID auf eigene Seiten zu
  legen und nur deren Bereich neu aufzubauen; an den Grenzseiten zur
  Nachbarumfrage blieben dann Reste stehen, und die Garantie hinge an deren
  Lage. Danach leert `clearWalSoon` ohne Messung (`measure: false`): Die
  Frames des Neuaufbaus nennen nur frisch geschriebene Seiten, als offene
  Fuellung (siehe unten) waeren sie so gross wie die Tabelle. Kopien, die Teilnahmen danach
  in Seiten schon beendeter Umfragen hinterlassen, verraten nur die
  Reihenfolge der Antworten laufender Umfragen; das naechste Umfrageende
  raeumt sie. Ein TRUNCATE-Checkpoint setzt in der `-shm` nur den Kopf
  zurueck, die Seitennummern der letzten Teilnahme blieben stehen (gemessen).
  SQLite beginnt einen Abschnitt dieser Liste neu (und nullt ihn), sobald
  sein erster Frame geschrieben wird. `clearWalSoon` schreibt deshalb danach
  Seite 1 (`user_version` auf seinen eigenen Wert), uebrig bleibt die Nummer
  1; ein zweiter Checkpoint dafuer, wie in einer Zwischenfassung, kostete je
  Teilnahme ein weiteres Durchschreiben und leerte nur den Frame von Seite 1.
  Landeten die Frames einer Teilnahme hinter dem ersten Abschnitt (4062
  Frames), etwa weil eine Sicherung das Leeren lange aufhielt, stehen in den
  weiteren Abschnitten noch ihre Seitennummern; dann schreibt `fillWalIndex`
  genug neue Seiten, dass jeder Abschnitt bis dorthin neu beginnt, und leert
  erneut (nachgestellt mit rund 5000 Frames: danach nennt kein Abschnitt
  mehr eine Seite des Bestands; ohne Fuellung 1100). Wie weit sie reichten,
  misst `clearWalSoon` direkt nach dem Commit: Fasst die -wal-Datei
  hoechstens 4062 Frames (ein stat), kann keiner dahinter liegen; nur sonst
  ein PASSIVE-Checkpoint (Feld `log`, die Frames der laufenden Generation),
  denn ein Checkpoint je Teilnahme kostete ein Durchschreiben. Die Messung
  wirft nie: Die Teilnahme ist da schon gespeichert, und ein Fehler machte
  daraus eine Fehlerantwort, deren Wiederholung "bereits teilgenommen"
  bekaeme. Eine Zwischenfassung
  nahm die Laenge der -wal-Datei: Nach einer grossen Transaktion fuellte
  eine Teilnahme dann so viel, wie die Datei je fasste, und die Datenbank
  wuchs um diesen Betrag; ausserdem mass ein zweiter Versuch die schon
  geleerte Datei und holte eine gescheiterte Fuellung nie nach. Die offene
  Fuellung (`walIndexFillOwed`) bleibt deshalb stehen, bis sie gelungen
  ist, und faellt danach weg, auch wenn der folgende Checkpoint an einem
  Leser scheitert. Endet der Dienst mit offener Fuellung, waehrend eine
  andere Verbindung (eine Sicherung) die `-shm` offen haelt, setzt SQLite sie
  beim Neustart nicht zurueck. Deshalb steht die offene Fuellung auch im
  Vermerk `<dataDir>/.shm-fuellung-offen`, und `restartStaleWalIndex` holt
  sie beim Dienststart nach, wenn die `-shm` beim Oeffnen nicht
  zurueckgesetzt wurde (gemessen in `getDb` direkt beim Oeffnen). Eine
  Zwischenfassung entschied allein an der Groesse der `-shm`, und das erst
  nach den Migrationen: SQLite verkleinert die `-shm` nie, auch nicht nach
  einem TRUNCATE-Checkpoint (gemessen: 64 KiB blieben bei einer einzigen
  Verbindung), also hielt sie das eigene Wachstum durch das VACUUM einer
  Migration fuer eine liegengebliebene `-shm` (bei 300 MB rund 73 000 leere
  Seiten vor dem Start, die Datei 300 MB groesser), und neben einer
  laufenden Sicherung fuellte jeder Neustart erneut. Nachgestellt: offene
  Fuellung plus stehende `-shm` wird nachgeholt (danach keine Seite des
  Bestands mehr in Abschnitt 1), grosse `-shm` ohne Vermerk loest nichts
  aus, Vermerk neben zurueckgesetzter `-shm` faellt ohne Fuellung weg. Die
  Sicherung, die ebenfalls `getDb` nutzt, holt nichts nach. Die Teilnahme prueft die Antworten vor der
  Doppelteilnahme: Sonst verriet die HR-Testerfassung mit ungueltigen
  Antworten ueber 409 gegen 400, wer schon teilgenommen hat, ohne etwas zu
  schreiben. Was bleibt: Wer zwei Staende der Datei vergleicht, etwa zwei
  Sicherungen, sieht die dazwischen hinzugekommenen Antworten und
  Teilnahmen; das gilt fuer jede Speicherung. Ebenso sieht eine HR-Rolle, die
  die Ergebnisse einer laufenden Umfrage nach jeder Teilnahme abruft, was
  hinzukam; die Ergebnisse nur in Stufen freizugeben, aenderte die Bedienung
  und ist deshalb nicht umgesetzt (eine Entscheidung fuer spaeter). Was ein
  Dateisystem an freigegebenen Bloecken behaelt, liegt ausserhalb der
  Reichweite der Anwendung.
- Das Audit-Log haelt bei Stammdatenaenderungen die neuen Werte im Wortlaut
  fest, auch Bankverbindung und Steuermerkmale, und ueberdauert das Loeschen
  des Profils (kein Fremdschluessel). Im Ruhezustand ist es jetzt so
  geschuetzt wie die Tabelle selbst; ob dort nur noch Feldnamen stehen
  sollen, ist eine Frage der Nachvollziehbarkeit und keine der
  Verschluesselung.
- Das Sitzungstoken liegt im localStorage beider Clients (eine Stunde
  gueltig). Ein fluechtiger Speicher verlangte nach jedem Neustart eine neue
  Anmeldung.
- Im Hosting liegen die env-Dateien aller Instanzen fuer jeden
  Instanzprozess lesbar; die Sicherungen fremder Kunden sind seit dieser
  Fassung unsichtbar (`InaccessiblePaths` in `ohrganize-backend@.service`).
- Das Register des Anbieters (`conspectus.db`) ist nicht verschluesselt; es
  haelt Kundennamen und Lizenzdaten, keine Personalakten.
- Desktop-App: kein `setWindowOpenHandler` und kein `will-navigate` (der
  LinkedIn-Link im Recruiting oeffnet ein Fenster in der App; ob es die
  Preload-Schnittstelle erbt, ist nicht geprueft), keine Content-Security-Policy fuer
  `ohrganize://app`, der IPC-Kanal fuer die Entwicklerwerkzeuge besteht auch
  in der ausgelieferten App. Ein Umlenken des Links in den Systembrowser waere
  eine sichtbare Aenderung, eine CSP laesst sich nicht ungetestet einfuehren.
- Windows-Server: NSSM kopiert die Werte der env-Datei in einen
  Registry-Zweig, den lokale Benutzerkonten in der Vorgabe lesen duerfen
  (gemessen auf Windows 11; deshalb liegt der Schluessel in einer Datei und
  nicht in der Umgebung); der Schluessel der
  eigenen Zertifizierungsstelle unter `C:/ProgramData/oHRganize/tls` ist von
  `harden-data-dir.ps1` nicht erfasst; Caddy laeuft als LocalSystem;
  `update-server.ps1` prueft das Ergebnis der Sicherung nicht, bevor es den
  Dienst anhaelt.
- Ablauf ueber die Betreiberskripte mit einem Archiv dieser Fassung nicht
  durchgespielt (Stand und Liste: `deploy/README.md`, Abschnitt 9.7, und
  `deploy/windows/README.md`, „Was der Probelauf gezeigt hat“).
