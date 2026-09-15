# oHRganize — Systemwissen

HR-Verwaltungssoftware für den deutschsprachigen Markt. Desktop-App (Electron) für
HR-Administrator:innen und Mitarbeitenden-Web-Portal (Self-Service) auf demselben
client-agnostischen Backend.

## Architektur

```
apps/backend    Fastify 5 + better-sqlite3, REST-API, eingebettet ODER standalone
apps/renderer   React 18 + Vite, lädt im Prod-Betrieb über file:// (daher HashRouter)
apps/desktop    Electron: Main-Prozess startet das Backend-Bundle in-process
apps/web        Mitarbeitenden-Portal: React 18 + Vite, BrowserRouter, Port 5174
                (Details + Deploy hinter eigener Domain: docs/web-portal.md)
packages/shared Gemeinsame TS-Typen/Konstanten (kein Laufzeit-Code mit Abhängigkeiten)
```

- **Backend ist die einzige Sicherheitsgrenze.** Jede Route läuft durch den
  globalen JWT-Hook in `server.ts`; öffentlich ist nur, was explizit
  `config: { public: true }` setzt (Login, signierte Downloads, Health).
  Rollenmodell im selben Hook: `users.role` `mitarbeiter` (Portal-Konten,
  via `users.employee_id` mit dem Personalprofil verknüpft) erreicht nur
  `/api/auth/*` und `/api/me/*`, alles andere verlangt `admin` (403 sonst).
  Self-Service-Routen liefern strikt eigene Daten (`modules/me/`).
- **Abgestufte Admin-Rechte (zweite Stufe im selben Hook).** `users.role`
  entscheidet, WELCHER Client offensteht; die **Admin-Rolle**
  (`users.admin_role_id` → `admin_roles` + `admin_role_permissions`,
  Migrationseintrag `002_admin_roles` — **keine eigene Datei**, sondern ein
  benannter Eintrag im Array in `db/migrations/000_core.ts`) entscheidet, WAS
  ein Admin darin darf: je Bereich
  (personal, abwesenheit, leistung, verguetung, recruiting, kommunikation,
  verwaltung, einstellungen, benutzer) `kein` / `lesen` / `bearbeiten`.
  Durchgesetzt in `core/permissions.ts`, aufgerufen aus dem globalen Hook —
  GET/HEAD verlangt `lesen`, alles andere `bearbeiten`.
  **Wichtig:** Die Zuordnung Route → Bereich steht dort in `ROUTE_AREAS`. Eine
  Route ohne Eintrag ist gesperrt (fail closed) — neue Module tragen ihren
  Präfix dort ein, sonst antworten sie mit 403.
  `admin_role_id = NULL` heißt **Vollzugriff**, nicht „keine Rechte“: So bleiben
  bestehende Installationen nach dem Update benutzbar und neue Konten sperren
  sich nicht selbst aus. Selbstschutz in `modules/admin/userRoutes.ts`: niemand
  ändert die eigene Zuweisung, hebt in der eigenen Rolle Rechte an oder entzieht
  sich die Benutzerverwaltung; das letzte Konto mit `benutzer: bearbeiten` bleibt
  erhalten, und eine Rolle mit Mitgliedern ist nicht löschbar (sonst hätten
  deren Konten schlagartig Vollzugriff).
- **Zwei getrennte Rollenbegriffe — nicht verwechseln.** `users.role` ist der
  **Systemzugang** und bleibt zweiwertig (`admin`/`mitarbeiter`); wer daran dreht,
  sperrt Konten aus. Die **Admin-Rolle** oben regelt Rechte innerhalb der
  Administration. Davon wiederum unabhängig sind **Fachrollen** (Tabellen `roles` +
  `employee_roles`, Migration `102_employee_roles`): frei anleg- und zuweisbar,
  verwaltet unter `/verwaltung/rollen`. Sie steuern ausschließlich, wer welche
  Abwesenheitsart beantragen darf. Beim ersten Start erzeugt die Migration je
  Beschäftigungsart (`employees.employee_type`) eine gleichnamige Fachrolle und
  weist sie zu; danach driften beide bewusst auseinander — `employee_type` mit
  seinen Pflichtfeld-Regeln bleibt unangetastet.
- **Antragsberechtigung** je Abwesenheitsart: Rollen-Allowlist
  (`absence_type_roles`, **leer ⇒ alle dürfen**) plus Personen-Ausnahmen
  (`absence_type_employee_rules`, `allow`/`deny`), die die Rollenregel schlagen.
  Durchgesetzt wird sie in `absences/service.ts#assertTypeAllowed`, aufgerufen in
  **`createRequest`** — dem einzigen Punkt, durch den alle vier Erfassungswege
  laufen. Eine Prüfung in den Routen würde die HR-Erfassung auslassen.
  Kategorie `krankheit` ist ausgenommen: Krankmeldungen finden ihre Art über den
  festen Namen, eine Sperre dort legte die gesamte Erfassung lahm.
  Lesefilter (`GET /api/me/leave-types`) nutzt `allowedTypeIdsFor` — Lese- und
  Schreibseite müssen sich decken, sonst bietet das Portal Arten an, die der POST
  ablehnt.
- **Vier-Augen-Prinzip:** `approve` und `reject` in `absences/routes.ts` weisen
  den eigenen Antrag mit 403 ab (Vergleich `req.user.employee_id` gegen
  `absence_requests.employee_id`). `cancel` bleibt erlaubt (Rückzug, kein
  Entscheid), ebenso die Auto-Genehmigung bei `requires_approval = 0` — die
  genehmigt technisch immer „selbst". **Achtung Einzelbetrieb:** Eine
  Frischinstallation hat nur `admin@ohrganize.de`; dessen eigener Antrag ist dann
  von niemandem entscheidbar. Ein zweites Admin-Konto ist Voraussetzung.
- **Stammdaten ändern Mitarbeitende nie selbst** (Migration
  `106_employee_change_requests`). Das Portal stellt einen **Änderungsantrag**
  (`POST /api/me/change-requests`), die Personalabteilung entscheidet
  (`POST /api/employees/change-requests/:id/decide`) — erst dann schreibt der
  Server in `employees`. Die Personalakte ist Grundlage für Abrechnung und
  Meldungen; eine zweite Person und eine Spur sind Teil des Vorgangs.
  **Die Feld-Allowlist `EMPLOYEE_SELF_EDITABLE_FIELDS`
  (`packages/shared/src/employees.ts`) ist die einzige Quelle:** Aus ihr
  entstehen die Prüfung im Backend, die SET-Klausel des UPDATE, das Formular
  im Portal und die Gegenüberstellung in der Personalabteilung. Die Feldnamen
  landen im SQL — eine zweite Liste wäre eine Einladung zum Auseinanderlaufen,
  und ein Feld, das dort nicht steht, ist weder beantragbar noch schreibbar.
  Beantragbar sind Privatanschrift, private Erreichbarkeit, Krankenkasse und
  Bankverbindung; bewusst NICHT Name, Geburtsdatum, dienstliche Kontaktdaten,
  Steuermerkmale und alles zur Beschäftigung. Die **Bankverbindung ist
  vertraulich** (`confidential`): Das Portal bekommt Werte nur gekürzt
  (`maskConfidential`) und sieht den aktuellen Stand gar nicht — sie steht
  weiterhin nicht in `GET /api/me/profile`. Es gibt **höchstens einen offenen
  Antrag je Person** (409) — zugleich die einzige Bremse gegen das Fluten der
  HR-Warteschlange, denn das Backend hat kein Rate-Limiting. Vier-Augen wie
  bei Abwesenheiten und Gehalt: Wer den Antrag gestellt hat ODER wessen
  eigenes Profil betroffen ist, genehmigt ihn nicht (400); Ablehnen bleibt
  erlaubt und verlangt eine Begründung, die im Portal erscheint. Die
  gemeinsame Logik beider Seiten steht in
  `modules/employees/changeRequestService.ts` (Vorbild:
  `absences/service.ts`). Benachrichtigt wird niemand: HR sieht offene
  Anträge auf der Dashboard-Kachel und unter Personal → Änderungsanträge.
- **Führung & Bewertung — zwei Gates (Migration `310_leadership_ratings` im
  3xx-Kreis).** Die **Verwaltung** (Freischaltung, Zuständigkeit, Skala und
  Kategorien, Satisfaction-Report; alles unter `/api/leadership/*` außer `/me`)
  hängt am Rechtebereich `fuehrung` wie jeder andere Bereich. Die
  **Führungsfunktion** (`/api/leadership/me/*`, „Mein Team“) hängt dagegen an
  der PERSON: Der globale Hook überspringt dort die Bereichsprüfung
  (`SELF_GATED` in `core/permissions.ts`); stattdessen verlangt der
  Plugin-preHandler `requireLeader` in `modules/leadership/routes.ts`, dass
  `users.employee_id` in `leadership_leaders` steht und das Profil aktiv ist —
  unabhängig von der Admin-Rolle. Die ausgelieferte Rolle „Führungskraft“ hat
  deshalb **alle Bereiche auf `kein`** und sieht trotzdem ihr Team; ein
  Profil ohne Konto darf bereits freigeschaltet sein. „Mein Team“
  (`service.myTeam`) liefert dafür alles in EINER Antwort — die Seite darf
  `/api/employees` nicht anfassen: Bereichskopf (`scope`: Abteilungen und Teams
  mit Kopfzahl aus den Personalprofilen), Spalten der Verlaufsleiste
  (`history_periods`, folgen dem gewählten Zeitraum) und je Person Stammdaten,
  Eintrittsdatum und `history`. Die Seite teilt danach in „Ausstehend“ und
  „Bereits bewertet“; **bewertet heißt mindestens eine Kategorie** im Zeitraum,
  nicht zwingend die Gesamtbewertung. Wer zuständig ist,
  bestimmt **ausschließlich** `service.scopeFor` (Routen, Report, Status
  fragen alle dort nach): automatisch aus `manager_id`, Abteilungsleitung
  inkl. Unterabteilungen und Teamleitung — je Quelle abschaltbar —, dazu
  manuelle `include`/`exclude`-Zuweisungen (Person, Abteilung, Team,
  Fachrolle; optional befristet). Nie sich selbst, nie Ausgeschiedene, und
  eine Ausnahme schlägt jede Quelle. Gegenseitige Verantwortung (A bewertet
  B und B bewertet A) wird erkannt und nur mit `allow_mutual` zugelassen —
  geprüft an JEDER Stelle, die Zuständigkeit verändert (Freischalten,
  Zuweisen, Ausnahme entfernen, Automatik umschalten, Einstellungen), jeweils
  in der Transaktion (409 + Rollback, `service.assertMutualAllowed`).
  Verknüpfen oder Lösen eines freigeschalteten Profils in der
  Benutzerverwaltung verlangt `fuehrung: bearbeiten`
  (`userRoutes.ts#assertMayLinkProfile`), sonst verschaffte sich
  `benutzer: bearbeiten` über ein Zweitkonto fremde Teams. Die Einrichtung
  holt ihre Auswahllisten über `GET /api/leadership/lookup` (Bereich
  `fuehrung`), nicht über `/api/employees` (`personal`). Organisationsänderungen
  (Vorgesetzte, Abteilungs-/Teamleitung) laufen NICHT durch dieses Modul und
  können bei `allow_mutual = 0` still Paare erzeugen — `GET
  /api/leadership/settings` liefert deshalb `mutual_pairs`, die Einrichtung
  warnt. Löschregeln: bewertete Person gelöscht ⇒ Bewertungen samt Protokoll
  weg (CASCADE); Führungskraft gelöscht ⇒ Bewertungen bleiben ohne Zuordnung
  (`leader_employee_id` SET NULL, Anzeige „(gelöschte Führungskraft)“). Bewertungen tragen Skala und
  Rohwert **je Zeile** (ein späterer Skalenwechsel deutet Altes nicht um);
  Speichern ist ein Upsert je (Führungskraft, Person, Kategorie, Zeitraum) mit
  unveränderlichem Protokoll `leadership_rating_history`: Trigger gegen UPDATE,
  keine Löschroute — die einzige Löschung ist die Kaskade beim Entfernen eines
  Personalprofils. Keine der Tabellen referenziert `files`; beim
  Dateiaufräumen ist hier nichts nachzuziehen. Im **Satisfaction-Report**
  klappt ein Klick auf ein Widget die Aufschlüsselung auf:
  `GET …/leaders/:employeeId/breakdown` liefert die verantworteten Personen
  (heutiger Bereich PLUS früher Bewertete als `former`) mit ihrer
  Gesamtbewertung je Zeitraum — bewusst OHNE Kommentare; die holt erst
  `GET …/leaders/:employeeId/employees/:memberId/ratings` für genau eine
  Zelle (Detail-Pop-up). Der zweite Pfadparameter heißt `memberId`, weil
  find-my-way an derselben Baumposition denselben Parameternamen verlangt wie
  `/leaders/:employeeId/team`.
- **Leistung & Führung sind verzahnt, nicht verschmolzen.** Beurteilungen
  (`modules/performance`) kennen nur Selbstbewertung und 360°-Feedback;
  `kind: 'vorgesetzt'` wird mit 400 und Verweis abgewiesen, weil die
  Vorgesetztenbewertung ausschließlich unter „Mein Team“ entsteht
  (`leadership_ratings`). Bögen tragen je Kriterium eine zentrale Skala
  (`scale`) und binden Kriterien optional an zentrale Kategorien
  (`category_id`, Snapshot beim Speichern). Ergebnis eines Bogens ist
  `overall_percent` (Anteil der Bestnote, skalenübergreifend); das Aggregat
  liefert die Führungsbewertungen des Zyklus-Zeitraums als `supervisor`.
  Endgültiges Schema: Migration `321_reviews_final_schema`. Ein
  Navigationsabschnitt „Leistung & Führung“, Rechtebereiche bleiben getrennt.
  Deep-Links: `/leistung/beurteilungen?tab=conduct&employee=<id>`,
  `/leistung/feedback?employee=<id>`. Hintergrund: docs/entscheidungen.md.
- **Desktop-Embedding:** `desktop/src/main.ts` ruft `startServer(0)` aus dem
  esbuild-Bundle `server.cjs` auf (zufälliger Port) und reicht die Basis-URL via
  `additionalArguments` an das Preload-Skript → `window.ohrganize.apiBaseUrl`.
  Im Dev-Betrieb läuft das Backend separat auf 3001 (`npm run dev`).
- **Kein natives Menü:** Das Fenster ist rahmenlos (`titleBarStyle: 'hidden'`,
  auf macOS `hiddenInset`), `Menu.setApplicationMenu(null)`. Die eigene
  Titelleiste (`renderer/src/layout/TitleBar.tsx`) bringt App-Menü und
  Fenster-Controls mit; Aktionen laufen über IPC (`window.ohrganize.window` /
  `.app`, definiert im Preload). Tastaturkürzel (Strg+K/1–6/±/0, F11) sind in
  `AppShell.tsx` im Renderer registriert, da es kein Menü mehr für Accelerators
  gibt. Datei-Uploads nutzen die Dropzone `components/FilePicker.tsx`
  (`FilePicker`/`PhotoPicker`) statt nacktem `<input type=file>`.
- **Dateien** liegen ausschließlich im Backend-Storage (`files`-Tabelle + Ordner).
  Downloads laufen über kurzlebige HMAC-signierte URLs (`core/files.ts`) — für
  Desktop- und späteren Web-Client identisch.
- **Lizenz: signierte Offline-Datei, Nur-Lese statt Sperre.** Die
  Nutzungsberechtigung ist `<dataDir>/lizenz.ohrganize` (eine Zeile
  `OHRG1.<payload>.<Ed25519-Signatur>`; Format und Prüfung `core/licenseCodec.ts`,
  Vertrauensanker `core/licenseKeys.ts`, reiner Zustandsautomat
  `core/licenseState.ts`, Cache, Datei und Durchsetzung `core/license.ts`,
  Routen `core/licenseRoutes.ts`; gemeinsamer Vertrag mit den Clients in
  `packages/shared/src/license.ts`, ALLE Lizenztexte aus `describeLicense` in
  `packages/shared/src/licenseText.ts`: Banner, Lizenzseite, Widget, 403-Meldung
  und Startlog stellen keine eigene Diagnose). Kein Rückkanal, keine
  Fernabschaltung. Zustände `entwicklung` · `trial` (30 Tage ab
  `installation.created_at`) · `valid` (`warning` ab `warn_days`, Vorgabe 30) ·
  `grace` (14 Tage, volle Funktion) · `expired` (**Nur-Lese**: GET/HEAD, Exporte
  und signierte Downloads offen, alles andere `403 LICENSE_EXPIRED`). Das Gate
  `assertLicenseAllows` sitzt im globalen Hook in `server.ts` **nach** dem
  `must_change_password`-Gate und **vor** der Rollenprüfung; offen bleiben die
  Routen in `LICENSE_OPEN_ROUTES` (`/api/auth/me`, `/api/auth/password`,
  `/api/license`, die drei `…/sign`- bzw. `…/download`-POSTs sowie der
  Konto-Widerruf `DELETE`/`PATCH /api/admin/users/:id` und
  `POST …/reset-password` — der Lesezugriff steht im Nur-Lese-Betrieb allen
  bestehenden Konten offen, also muss ein ausgeschiedenes oder
  kompromittiertes Konto entziehbar bleiben; Anlegen bleibt gesperrt).
  Die 403-Meldung ist kontoabhängig: Admins der Sachstand, Portal-Konten
  nur der neutrale Hinweis. `/api/license` hängt in `ROUTE_AREAS` am Bereich
  `einstellungen`; der Header `x-ohrganize-license` steht **nur auf
  angemeldeten Antworten** (Admins der Zustand, Portal nur `valid`/`expired`,
  öffentliche Routen ohne Header — `licenseHeaderValueFor`),
  Login/`/api/auth/me` liefern `license` (Admins alles, Portal nur
  `{ read_only, features }`), `/api/health` nur `license.read_only` und
  `license_format` (hoechste lesbare Payload-Fassung, heute 2). Einspielen
  ist monoton ueber den Ausstelltag (kein frueheres `issued_at`; eine
  spaeter ausgestellte Datei darf kuerzer laufen, gleichtaegig nicht),
  `valid_until` ≤ `LICENSE_MAX_DATE` (2999-12-31 =
  „unbefristet“), und eine bereits über die Kulanz hinaus abgelaufene Datei
  im Datenverzeichnis beendet die Testphase nicht. Platzgrenze `max_users` ⇒
  `assertSeatsAvailable` an genau den Stellen, an denen Profile aktiv werden
  (`employeeRoutes.ts`: POST, PATCH-Reaktivierung, Sammeländerung;
  `recruiting/routes.ts`: hire) → `409 LICENSE_SEATS_EXCEEDED`. Tabelle
  `installation` kommt aus dem Eintrag `004_license` in `000_core.ts`
  (`installation_id`, Testphasen-Anker, `licensed_at` gegen eine zweite
  Testphase, `last_seen_date` als Uhren-Stolperdraht — warnt, sperrt nie).
  **`licenseEnforced = Boolean(OHRGANIZE_DATA_DIR)`**: ohne die Variable (Dev-DB)
  keine Prüfung, mit ihr (Server, installierte App, Smoke-Tests) immer. Der
  private Schlüssel liegt nie im Repo/OneDrive/Mail; `npm run lizenz`
  (`scripts/license-tool.ts`) erzeugt, signiert, prüft. Tests:
  `src/test/licenseSmoke.ts` (eigenes Schlüsselpaar über
  `OHRGANIZE_LICENSE_PUBLIC_KEY`, nur dort — die Produktionsbundles
  kompilieren die Variable per `esbuild --define` heraus, `release-server.mjs`
  weist ein Bundle ab, das sie noch liest, und die Desktop-App löscht sie vor
  dem Laden des eingebetteten Backends). **Die Lizenzlogik löscht nie
  Daten** — Nur-Lese heißt lesbar und exportierbar, die Personalakte hat
  Aufbewahrungsfristen. Betreiberdoku: docs/lizenzierung.md.
  **Lizenz v2** (`v: 2`, Schema `licenseCodec.ts`) traegt `edition`,
  `country` (Pflicht), `features`, `terms`, `headline`; v1-Dateien bleiben
  gueltig, ein v1-Server lehnt v2 ab (Rollout Server vor Datei). Editionen
  sind KEINE feste Liste (nur ein Muster), der Anbieter legt sie im
  Variantenregister fest. Ausstellen ueber `core/licenseIssue.ts`
  (`issueLicense`, gemeinsam fuer `npm run lizenz` und conspectus); die
  Vorgaben je Art (`evaluation`: Kulanz 0, Warnung ab halber Laufzeit) und
  Laufzeiten (`3t`, `2w`, `6m`, `1j`) stehen dort. Ein Dateiwechsel im
  Datenverzeichnis ohne Upload schreibt `license.file_changed` mit
  `user_id NULL` ins Audit-Log (`loadLicenseFile`).

## Konventionen

- **Sprache:** UI-Texte Deutsch, Code-Bezeichner Englisch. API-Fehlermeldungen
  Deutsch (sie werden dem Nutzer direkt angezeigt).
- **Datumswerte:** überall ISO-Strings `YYYY-MM-DD` (DB, API); Anzeige über
  `formatDate` aus `@ohrganize/shared` (TT.MM.JJJJ).
- **Geld:** Integer-Cent in DB und API; Anzeige über `formatEuro`.
- **Fehler:** einheitliches Schema `{ error: { code, message, details? } }`
  (`core/errors.ts`). Eingaben mit `parse(zodSchema, req.body)` validieren.
- **Audit:** Änderungen mit Begründungspflicht (z. B. Gehalt) schreiben über
  `core/audit.ts` ins zentrale `audit_log`.
- **Mitarbeiterliste:** Spaltenauswahl und Format der Betriebszugehörigkeit
  liegen pro Gerät im localStorage (`ohrganize.employeeList`) — wie die
  Dashboard-Konfiguration eine Arbeitsplatz-, keine Firmeneinstellung. Die
  Spaltendefinition steht in `EMPLOYEE_LIST_COLUMNS` (`shared/employees.ts`);
  `fixed: true` (Name, Personalnummer) bleibt immer sichtbar. Alle Auswahlfilter
  sind **Listen** und werden kommagetrennt übergeben (`employee_type=vollzeit,werkstudent`);
  mehrere Werte eines Filters verodern, verschiedene Filter verunden.
  Sortierfelder sind eine Whitelist in `employeeRoutes.ts` (`SORT_COLUMNS`) —
  der Wert geht direkt ins SQL. `personnel_number` ist bewusst **nicht** Teil
  von `fields=lite`: Diese schlanke Form ist Kontrakt für andere Module.
- **Seitenleiste ist je Gerät sortierbar** (Einstellungen → Seitenleiste):
  Reihenfolge der Abschnitte im localStorage (`ohrganize.sidebar`,
  `layout/sidebarConfig.ts`), Dashboard immer ganz oben, System/Einstellungen
  immer ganz unten. Abschnitte tragen dafür einen stabilen `key` in
  `layout/nav.ts`; ein neuer Abschnitt braucht einen und hängt sich bei
  bestehenden Konfigurationen hinten an.
- **Dashboard ist personalisierbar:** Widgets/KPI-Kacheln sind pro Gerät wählbar
  und anordenbar; Registry + localStorage-Persistenz (`ohrganize.dashboard`) in
  `renderer/src/features/dashboard/dashboardConfig.ts`. Neue Module registrieren
  ihre Dashboard-Widgets dort (Default-Sichtbarkeit bewusst kuratiert klein).
- **Themes:** Vier Farbschemata (Hell/Dunkel/Rosé/Silber) leben ausschließlich
  als CSS-Variablen-Blöcke in `design/tokens.css` (`:root[data-theme='…']`),
  Umschaltung über `design/theme.ts` (localStorage `ohrganize.theme`). Neue
  UI-Farben deshalb NIE hartkodieren, sondern immer über bestehende Variablen —
  im Dunkel-Theme ist die Grau-Rampe invertiert (gray-25 = dunkelste Fläche).
  SVG-Exporte (Organigramm) lösen Variablen zur Renderzeit über
  `getComputedStyle` in konkrete Werte auf. Das Web-Portal führt dieselben
  vier Themes: `apps/web/src/design/tokens.css` + `theme.ts` spiegeln die
  Renderer-Werte 1:1 (Wahl im Portal unter Profil → Darstellung) —
  Token-Änderungen immer in BEIDEN tokens.css nachziehen.
- **Tooltips:** nie das native `title`-Attribut (OS-Optik, nicht themebar,
  träge, unstrukturiert), sondern `components/Tooltip.tsx`. Es rendert per
  Portal an `<body>` mit `position: fixed` und wird deshalb — wie `Popover` —
  von keinem `overflow: hidden` abgeschnitten. Farben ausschließlich über
  `--tooltip-bg`/`--tooltip-text` (je Theme, in beiden tokens.css). Inhalt
  strukturiert statt Fließtext: `.hm-tooltip__title` (Was) + `.hm-tooltip__line`
  (Details), Werte mit „·“ getrennt, keine Sätze. Nur dort einsetzen, wo er
  etwas sagt, was die Fläche nicht schon zeigt (kein Datums-Tooltip auf jeder
  Kalenderzelle). `title` bleibt allein für Nicht-React-Ausgaben (SVG-Export).
  Bestehende `title`-Attribute werden beim nächsten Anfassen der Datei migriert.
- **Organigramm:** zwei Darstellungen unter Personal → Organisation. Das
  **Personen-Organigramm** (`features/employees/OrgChart.tsx`; Baum, Layout
  und Suche ohne DOM in `packages/shared/src/orgChart.ts`, weil das Portal
  dieselbe Ansicht zeichnet: `apps/web/src/pages/OrgPage.tsx` über
  `GET /api/me/org-chart`, projiziert auf Name, Titel, Zuordnung und Foto)
  hängt jede aktive Person unter ihren Vorgesetzten;
  `GET /api/org/chart` (`buildOrgChart` in `orgRoutes.ts`) liefert dafür
  `parent_id` fertig aufgelöst: `manager_id`, sonst Teamleitung, sonst die
  nächste Abteilungsleitung aufwärts (`parent_source`), Ringe aufgetrennt,
  Fotos signiert. Die Abteilungsfarben sind die Tokens `--org-1…6` (in
  BEIDEN tokens.css). Der **Abteilungsbaum** (`GET /api/org/tree`) bleibt
  in der Desktop-App als zweite Ansicht und speist den Struktur-Tab. Karten
  sind HTML auf einer
  per Transform bewegten Fläche mit `overflow: clip` (nicht `hidden`: der
  Browser scrollt einen hidden-Container beim Fokussieren still mit); der
  SVG-Export zeichnet die Karten getrennt nach. Deep-Link aus der
  Personalakte: `/personal/organisation?tab=organigramm&person=<id>`.

## Modul-Erweiterungspunkte (parallel konfliktfrei)

Jedes Fachmodul fasst **nur eigene Dateien** an; die Verdrahtung existiert bereits:

| Was | Wo | Hinweis |
|---|---|---|
| SQL-Migrationen | `backend/src/db/migrations/<NNN>_<modul>.ts` | Nummernkreise: 0xx Core, 1xx Personal, 2xx Abwesenheit, 3xx Leistung (inkl. 310 Führung), 4xx Vergütung, 5xx Kommunikation, 6xx Recruiting, 7xx Verwaltung. Array in der Moduldatei füllen — `index.ts` nicht anfassen. |
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
- **`allowScripts` in der Root-`package.json` ist ein echtes npm-Feld (ab 12)
  und hängt am Lockfile.** npm sperrt seit dieser Fassung die
  Installationsskripte von Abhängigkeiten; freigegeben ist, was dort als
  `paket@version` steht. Festnageln kann npm einen Eintrag aber nur, wenn der
  `package-lock.json` eine `resolved`-URL dazu mitbringt. Genau das fehlte
  lange (Lockfile ohne Registry-Zugriff erzeugt), und damit passte **kein**
  Eintrag: better-sqlite3 bekam seine native Bibliothek nicht, `npm ci` meldete
  trotzdem Erfolg, der Build lief durch, und erst der erste `new Database`
  brach mit „Could not locate the bindings file" ab. Zwei Folgerungen für
  jeden, der hier etwas ändert: **Ein Paket mit Installationsskript neu
  aufnehmen heißt, es in `allowScripts` einzutragen** (sonst läuft es nicht),
  und **eine Versionsanhebung macht den Eintrag ungültig** — das ist Absicht,
  will aber nachgezogen werden. Prüfen lässt sich der Zustand mit
  `npm install-scripts ls`. Als Kontrolle nach `npm ci` taugt nur
  `node -e "new (require('better-sqlite3'))(':memory:')"` — ein blosses
  `require()` lädt die Bindung noch nicht. Hintergrund:
  docs/entscheidungen.md.
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
- **Die Electron-Version steht an ZWEI Stellen.** Neben der Range in
  `apps/desktop/package.json` gibt es die feste Zahl `electronVersion:` in
  `apps/desktop/electron-builder.yml` (electron-builder kann die Range wegen
  des Workspace-Hoistings nicht auflösen). Wer nur eine anhebt, baut still
  weiter mit der alten Fassung — beim Sicherheitsupdate hieße das: `npm audit`
  gibt Entwarnung, der Installer trägt die Lücke aus. `scripts/build.mjs`
  bricht deshalb bei Abweichung ab. **Und vor jedem Electron-Sprung zuerst
  prüfen, bis zu welcher Electron-ABI `better-sqlite3` Fertigpakete
  veröffentlicht** (GitHub-Release der jeweiligen Fassung) — darüber hinaus
  müsste jede Baumaschine die native Bibliothek übersetzen.
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
  (`npm run seed`), die **installierte App** in `%APPDATA%\oHRganize\data` (aus
  Electrons userData, abgeleitet vom `productName` "oHRganize"). `npm run seed`
  füllt NUR die Dev-DB; für die installierte App `npm run seed:desktop -- --force`
  (App vorher schließen — SQLite-Dateisperre). Ein frisch installiertes Programm
  startet absichtlich leer (nur Admin-Login).
- **`licenseKeys.ts`: neuer Schlüssel = neuer Eintrag, alter bleibt bis alle
  Kunden neu signiert sind; sonst fällt deren Server nach dem Update in den
  Nur-Lese-Betrieb.** Lizenzen nennen ihren Schlüssel über `kid`; ein Server
  ohne passenden Eintrag hält die Datei für unbrauchbar. Ablauf in
  docs/lizenzierung.md, Abschnitt 3.1.
- **Serverauslieferung ist das Release-Archiv, nicht das Repo.**
  `npm run release:server` (`scripts/release-server.mjs`) baut Backend und
  Portal und packt `release/ohrganize-server-<version>.zip`: nur `cli.cjs` und
  `backup.cjs` (minifiziert, **ohne** `.map` — die enthalten den Quelltext),
  `apps/web/dist`, `deploy/`, Betriebsdokumente und ein auf `better-sqlite3`
  gekürztes `package.json`/`package-lock.json` (aus dem Root-Lockfile
  abgeleitet, samt `allowScripts`-Eintrag). Die Pfade spiegeln das Repo, weil
  Units und `install-service.ps1` `apps/backend/dist/cli.cjs` kennen. Das
  Backend-Build läuft mit `--minify --legal-comments=none --sourcemap=external`;
  Textdateien unter `deploy/` werden im Archiv auf LF normalisiert (`.ps1` auf
  CRLF), weil die Windows-Arbeitskopie CRLF trägt und ein CR in einer Unit
  `ExecStart` bricht.
  **Windows-Einrichtung in einem Lauf:** `deploy/windows/setup-server.ps1`
  (Archiv → npm ci → Portal → env → Dienst → Caddy → Firewall → Sicherung →
  Abnahme, idempotent, ruft die drei Einzelskripte auf). Zwei 5.1-Fallen darin
  bewusst umschifft: `2>$null` an nativen Programmen wirft unter
  `$ErrorActionPreference = Stop` (deshalb `Invoke-Quiet`), und ein
  Funktionsparameter darf nicht `$Args` heißen (automatische Variable —
  Argumente kommen leer an).
  Gegenstück für den Arbeitsplatz: `deploy/windows/setup-workstation.ps1`
  (App still installieren, `config.json` ohne BOM mit Adresse und Pin,
  Erreichbarkeit, Start; `npm run dist:win` legt es neben den Installer).
  `npm run lizenz -- protect` verschlüsselt einen bestehenden Schlüssel
  nachträglich, ohne kid-Wechsel.

## Häufige Kommandos

```bash
npm run dev            # Backend (3001) + Renderer (5173) + Web-Portal (5174) parallel
npm run dev:desktop    # Electron-Fenster gegen den Dev-Stack
npm run typecheck      # alle Workspaces
npm run seed           # Demo-Daten
npm run build:web      # statisches Portal-Build → apps/web/dist
npm run dist:win       # kompletter Windows-Installer (NSIS) → apps/desktop/release
npm run release:server # Server-Release-Archiv (Bundles + Portal + deploy/) → release/
npm run lizenz -- …    # Lizenzwerkzeug des Anbieters: keygen | keys | sign | inspect (docs/lizenzierung.md)
```

Login bei Frischinstallation: `admin@ohrganize.de` mit einem **zufällig
erzeugten** Passwort — einmalig auf stdout und in
`<dataDir>/initial-admin-password.txt` (0600). Der erste Login erreicht nur
`/api/auth/me` und `/api/auth/password` (`users.must_change_password`, 403
`PASSWORD_CHANGE_REQUIRED`) und erzwingt damit den Wechsel. Für Tests und
skriptierte Abläufe gibt `OHRGANIZE_INITIAL_ADMIN_PASSWORD` das Passwort vor
(nur beim allerersten Start ausgewertet, dann ohne Wechselzwang) —
**nicht auf Produktivsystemen**.

`npm run seed` ist **ausschließlich Dev** und legt Konten mit fest
dokumentierten Passwörtern an: drei weitere Admin-Konten (sabine.berger@,
jurgen.wilms@, melanie.sonntag@ohrganize.de / `ohrganize2026`) und vier
Portal-Konten (deniz.aydin@, marta.kowalczyk@, leonie.vogt@,
samuel.okafor@ohrganize.de / `portal2026`). Auf einem Kundensystem darf das
niemals laufen; Konten entstehen dort über *Verwaltung → Benutzer & Rechte*
(`POST /api/admin/users`, Passwort erzeugt der Server). Ablauf:
`docs/inbetriebnahme.md`, Serverbetrieb: `deploy/README.md`.

Das ist seit dem Deploy-Audit **technisch gesperrt**, nicht mehr nur
dokumentiert: `seed.ts` bricht ab, sobald `OHRGANIZE_DATA_DIR` gesetzt ist und
nicht auf das Dev-Verzeichnis `apps/backend/data` zeigt. Grund: Auf einem
frischen Kundenserver ist die Datenbank leer, die alte Sperre („es existieren
schon Mitarbeitende") griff dort gerade nicht. Einziger Ausweg ist
`OHRGANIZE_ALLOW_SEED=1` — das setzt `seed-desktop.ts` selbst, weil es
absichtlich auf das userData-Verzeichnis der installierten App zeigt.
