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
packages/fonts  Schriftdateien der Clients (Creato Display: 14 WOFF2 + @font-face-CSS), kein Code
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
  deren Konten schlagartig Vollzugriff). Rang und Aussteller der Zugangsdaten
  (wer mehr Rechte bekommt, braucht ein Passwort von jemandem, der sie hatte):
  `core/accountRights.ts`, Einzelheiten unter „Rang eines Kontos“ bei Führung.
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
  genehmigt technisch immer „selbst". Die HR-Erfassung kennt zusaetzlich
  `approve: true` (nachtraegliche Erfassung: vergessener Antrag, Person ohne
  Portalzugang) und genehmigt dann sofort; geprueft in `createRequest`, die
  eigene Abwesenheit wird auch dort mit 403 abgewiesen (gemeinsamer Helfer
  `assertNotOwnEmployee`, auch von `assertNotOwnRequest` genutzt). Beide
  Listen liefern `created_by_name`/`created_by_proxy` (`CREATED_BY_PROXY_SQL`:
  anlegendes Konto gehoert nicht der betroffenen Person), damit Portal und
  Desktop zeigen, dass die HR stellvertretend erfasst hat; ein Admin, der im
  Portal fuer sich selbst beantragt, zaehlt nicht als stellvertretend. **Achtung Einzelbetrieb:** Eine
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
  Ein DESKTOP-Konto mit freigeschaltetem Profil zählt in der
  Benutzerverwaltung mit den Rechten seiner Führungsfunktion (Rang, siehe
  „Rang eines Kontos“ unten), sonst verschaffte sich `benutzer: bearbeiten`
  über ein Zweitkonto fremde Teams; Portal-Konten öffnen „Mein Team“ nie und
  sind ausgenommen. Die Einrichtung
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
  `/leaders/:employeeId/team`. **Jede Route unter `/api/leadership/me/*`**
  (außer `/me/status`) wird über `registerLeaderRoutes` (leadership/routes.ts)
  registriert: eingekapseltes Plugin, preHandler `requireLeader`, Handler holen
  die ID mit `leaderIdOf`, das außerhalb des Gates 403 wirft. Nie eine
  `/me`-Route direkt auf `app`, sonst fehlt wegen SELF_GATED jede Prüfung.
  **Selbstschutz der Verwaltung:** Niemand ERWEITERT den eigenen Bereich
  (eigenes Profil freischalten, eigene Automatik einschalten, eigene Ergänzung
  anlegen, eigene Ausnahme entfernen), 403 aus `service.assertNotOwnLeadership`;
  was nur verkleinert (Entziehen, Automatik aus, Notiz, Ausnahme anlegen,
  Ergänzung entfernen), bleibt erlaubt, und die Einrichtung bietet genau das an. Grund: Die Führungsfunktion öffnet Daten anderer Bereiche
  (Gesprächsprotokolle), `fuehrung: bearbeiten` darf nicht der Weg sein, sie
  sich selbst zu geben. Weil `scopeFor` aber auch aus Organisationsdaten und
  Einstellungen gespeist wird, die keine dieser Sperren kennt, gilt für die
  Protokolle zusätzlich ein **Selbstschutz beim Lesen**
  (`mayReadProtocols` und `SCOPE_SHAPING_AREAS` in `core/accountRights.ts`):
  Ein Konto, das die Zuständigkeit selbst formen oder die eigenen
  Rechte danach senken kann (`personal`, `verwaltung`, `fuehrung`,
  `recruiting` oder `benutzer` auf `bearbeiten`), liest sie über „Mein Team“
  nur mit `kommunikation: lesen`, sonst 403; `/me/status` meldet das als
  `protocols_readable`, die Oberfläche fragt dann gar nicht erst. Die Rolle
  „Führungskraft“ (alles `kein`) ist nicht betroffen, das Bewerten auch nicht.
  **Rang eines Kontos** (`core/accountRights.ts`, gilt für die ganze
  Benutzerverwaltung, nicht nur für Führung): `effectiveRights` ist die
  Admin-Rolle plus, bei freigeschaltetem Profil eines Desktop-Kontos,
  `fuehrung: bearbeiten` und (solange es Protokolle lesen darf)
  `kommunikation: lesen`. Wer ein Konto anlegt, zurücksetzt, verknüpft,
  löst, dessen Rolle ändert oder es löscht, braucht mindestens diese Rechte
  (`assertWithinOwnRights`, 403). Außerdem merkt sich jedes Konto die Rechte
  der Person, die sein Passwort zuletzt im Klartext ausgegeben hat
  (`users.credentials_issuer_rights`, Migration `005_credentials_issuer`,
  NULL = Vollzugriff bzw. Betreiber; geschrieben NUR über
  `core/credentials.ts#storeIssuedPassword`, auch von `admin-reset`). Steigen
  die Rechte eines bestehenden Kontos (Rolle zuweisen, Rolle erweitern für
  jedes Mitglied, Profil verknüpfen, Profil freischalten, eine Herabstufung,
  die das Lesen der Protokolle öffnet), muss die handelnde Person jeden
  gestiegenen Bereich haben (403) und die ausgebende ihn gehabt haben
  (`assertMayRaise`, 409 mit der Bitte, das Passwort zuerst neu ausgeben zu
  lassen). Ein eigener Passwortwechsel ändert daran nichts, sonst hülfe er
  jedem Strohmann; die Freischaltung gibt nie ein Passwort heraus. Eine neue
  Stelle, an der Rechte steigen, ruft `assertMayRaise` auf;
  `leadership/smoke.ts` prüft, dass jede Passwort ausgebende Route
  `storeIssuedPassword` und `effectiveRights` nutzt und kein anderer Code
  `password_hash` schreibt. Neue Bereiche, deren Rechte Eingaben von
  `scopeFor` verändern, gehören in `SCOPE_SHAPING_AREAS`. **Gesprächsprotokolle in „Mein Team“:**
  Welche Stufe wen erreicht, steht allein in `MEETING_VISIBILITY_READERS`
  (packages/shared/src/communication.ts); Portal- und Führungsrouten filtern
  über `meetingVisibilitySql` (communication/meetingVisibility.ts), Badges und
  Hinweise der HR leiten sich daraus ab. Heute erreichen `hr_vorgesetzte` und
  `hr_vorgesetzte_mitarbeiter` die zuständige Führungskraft über
  `GET /api/leadership/me/employees/:id/meetings` (Parametername `:id`, siehe
  oben) und `GET /api/leadership/me/meetings/follow-ups` (fällige
  Wiedervorlagen, nur die Felder der Karte); `nur_hr` nie. Beides sind
  bewusst eigene Abfragen neben der EINEN Antwort von `service.myTeam`.
  Nur lesen, ohne Autor und Zeitstempel; `released_to_employee` heißt für die
  Person freigegeben, `visible_to_employee` zusätzlich mit Konto, also
  tatsächlich im Portal lesbar. Zuständig ist wie überall allein `scopeFor`
  (heutiger Bereich, nur aktive Profile, nie die eigene Person; außerhalb
  403): Es gibt keinen Verlauf, eine neue Führungskraft sieht also auch ältere
  freigegebene Protokolle ihrer Leute, und wer nicht mehr zuständig ist, sieht
  nichts mehr. Die HR steuert das je Protokoll über die Stufe; der Editor nennt
  dafür die derzeit erreichten Führungskräfte
  (`GET /api/communication/meetings/recipients?employee_id=`, Bereich
  `kommunikation`, Umkehrung `service.responsibleLeaders`) und warnt, wenn
  keine davon die Protokolle lesen kann (`can_read`: Desktop-Konto und
  Selbstschutz beim Lesen). Die QUELLEN der
  Zuständigkeit liefert diese Route nur Konten mit `fuehrung: lesen`, sonst
  weitete `kommunikation` still auf die Zuweisungen aus. In einer Variante ohne
  Führung bietet der Editor keine reine Führungsstufe neu an und sagt, dass
  niemand außer der HR liest. Die Routen liegen in `leadership/meetingRoutes.ts`
  und hängen an BEIDEN Modulen: Verdrahtung mit `requires: 'communication'` in
  `variant-wiring.mjs`.
- **Zielgruppen der Kommunikation (Ankuendigungen, Umfragen) loest NUR
  `modules/communication/audience.ts` auf.** `audience_type` ist `alle`,
  `abteilung` (schliesst Unterabteilungen ueber `departments.parent_id`
  ein), `team`, `standort` oder `verteiler`; `audience_id` zeigt auf die
  Einheit. Ein **Verteiler** (`distribution_lists` +
  `distribution_list_members`, Migration `501_distribution_lists`,
  Verwaltung unter Kommunikation → Verteiler, Routen
  `distributionListRoutes.ts`) buendelt Abteilungen (samt Unterabteilungen),
  Teams, Standorte und einzelne Personen; eine Person, die ueber eine Einheit
  desselben Verteilers erreicht wird, ist nicht zusaetzlich einzeln zulaessig
  (400, die Seite bietet sie nicht an), ein Verteiler in Verwendung ist nicht
  loeschbar (409). `audience_id` hat KEINEN Fremdschluessel; `checkAudience`
  weist beim Speichern eine fehlende Einheit ab, spaeter geloeschte Einheiten
  erreichen niemanden mehr. HR-Seite (`countAudience`, `audienceResolver` in
  den Listen) und Portalseite (`audienceOfEmployeeSql`) lesen dieselbe
  Mitgliedslogik; wer nur eine Seite aendert, laesst Empfaengerzahl und
  Sichtbarkeit auseinanderlaufen. **Empfaenger sind die Dashboards:**
  `modules/me/communicationRoutes.ts` (`GET /api/me/announcements`,
  `POST …/:id/ack`, `POST …/:id/attachments/:fileId/sign` (Anhang erst beim
  Klick signieren, in `LICENSE_OPEN_ROUTES`), `GET /api/me/surveys[/:id]`
  (Status `laufend` UND `date_to` nicht ueberschritten), `POST …/:id/responses`;
  haengt am Modul `communication`, deshalb ueber die Variantenverdrahtung
  registriert wie `meSalaryRoutes`) liefert nur, was sich an die Person
  richtet, alles andere ist 404. Portal-Uebersicht (`NoticeCards.tsx`) und
  Desktop-Dashboard (`personalWidgets.tsx`, auch fuer Admin-Konten mit
  verknuepftem Profil) zeigen daraus Karten, die NUR mit Inhalt erscheinen:
  keine feste Kachel, kein „keine Ankuendigungen“. Umfrageteilnahme laeuft
  fuer Portal und HR-Testerfassung durch `surveyService.recordParticipation`
  (eine Pruefung, ein Schreibpfad, Antworten ohne Personenbezug, kein Audit).
  Anonym heisst auch gegenueber der Datenbank: Antworten tragen keinen
  Zeitstempel und eine ZUFAELLIGE ID in [1, 2^48)
  (`surveyService.RESPONSE_ID_LIMIT`; derselbe Bereich in Migration
  `503_survey_response_ids` und im Seed: an einer abweichenden Groesse liessen
  sich Antworten verschiedener Herkunft trennen), Teilnahmen keinen
  Zeitstempel. Beide Zeilen entstehen in derselben Transaktion; mit
  fortlaufender ID waere die n-te Teilnahme die n-te Antwort. Weil SQLite neue
  Zellen einer Seite in Einfuegereihenfolge ablegt, verriete auch deren LAGE
  die Reihenfolge (gemessen): `storeAnonymousResponse` loescht deshalb die
  NACHBARN der neuen Antwort (jede Zeile, die mit ihr auf einer Tabellenseite
  liegen kann; gesammelt nach ID zu beiden Seiten, bis eine Untergrenze der
  belegten Bytes eine Seite uebersteigt) und fuegt sie samt der neuen in
  zufaelliger Reihenfolge wieder ein, mit `secure_delete` fuer die
  geloeschten Zellen. `survey_responses` hat deshalb KEINEN Index (seit 503):
  Jeder Index braeuchte dieselbe Behandlung seiner Seiten. Wer daran dreht,
  prueft mit `src/test/pageOrder.ts` (Abschnitt 12 in encryptionSmoke.ts).
  Beim Verschieben von Zellen zwischen Seiten bleiben vereinzelt Kopien in
  Seitenluecken stehen (secure_delete erfasst sie nicht); das Beenden einer
  Umfrage baut deshalb die Tabelle neu auf (`rebuildResponseTable` ueber
  `db/rebuildTable.ts#rebuildTableInKeyOrder`: in einer Transaktion alle
  Zeilen in eine temporaere Tabelle, die Tabelle mit DROP TABLE entfernen,
  mit ihrer gespeicherten Definition neu anlegen und in Schluesselreihenfolge
  befuellen; `secure_delete` nullt dabei jede ihrer Seiten; gemessen: keine
  Kopie mehr). NICHT mit DELETE FROM: Bei eingeschalteten Fremdschluesseln
  (im Dienst immer, in diesem SQLite-Build sogar die Vorgabe) loescht SQLite
  Zeile fuer Zeile, die Wurzelseite wird nie frei, und ein Rest in ihrer
  Luecke blieb stehen (gemessen). Seiten, die schon vorher frei waren, tragen keine Umfragedaten:
  **Jede Verbindung ueber `openDatabase` hat `secure_delete = ON`**
  (`configureConnection`), also loescht jeder Weg mit Nullen, auch Kaskaden
  (geloeschte Umfrage, geloeschtes Personalprofil) und kuenftige Loeschwege;
  `storeAnonymousResponse` prueft es (`assertSecureDelete`) und weist eine
  Verbindung ohne es ab; Funktionen fuer beliebige Verbindungen
  (`migrateDatabase`, `rebuildTableInKeyOrder`) setzen es selbst
  (`withSecureDelete`). Bewusst
  KEIN VACUUM: Es blockierte die ganze Datei und hielte eine Kopie der
  ganzen Datenbank im Arbeitsspeicher. Vermerkt ist der Neuaufbau im Commit
  des Umfrageendes (Zeile `pending` in `_survey_rebuild_state`, Migration 504: je Vermerk eine Zeile ohne Zeitstempel, damit keine Teilnahme das Schema aendert); scheitert er,
  holt ihn der Start des Moduls nach. Er laeuft nur, wenn seit dem letzten
  Antworten hinzukamen (Zeile `written`, im Commit jeder Antwort
  gesetzt, vom Neuaufbau entfernt), und auch fuer Umfragen, die die HR nicht
  beendet, die aber ueber `date_to` hinaus sind (`rebuildForExpiredSurveys`,
  geprueft beim Start des Moduls und stuendlich, je Umfrage einmal nach
  ihrem Ablauf (Zeile `expired:<id>`); der Status bleibt unveraendert).
  Der Neuaufbau kopiert bewusst die ganze Tabelle (die
  Umfragen teilen sich Seiten); gemessen 204 ms fuer 60 000 Antworten zu
  rund 60 Byte, rund 1,5 s bei rund 500 Byte,
  verschluesselt mit vollem Durchschreiben. Die Mindestteilnehmerpruefung
  der Ergebnisse zaehlt die Antworten per COUNT (nicht die Teilnahmen, die
  mit dem Personalprofil wegfallen) und laedt sie erst danach; ihre Reihenfolge ist die der zufaelligen
  IDs, auch fuer Freitexte (bewusst: die Abgabereihenfolge waere die Luecke,
  die die zufaelligen IDs schliessen). Danach leert `clearWalSoon`
  (db.ts; Bausteine in `db/walIndex.ts`, nur ueber `clearWalSoon` benutzen,
  das die offene Fuellung fuehrt)
  das `-wal`, dessen Frames sonst Vorher und Nachher festhielten: ohne Warten
  auf Leser (ein TRUNCATE mit busy_timeout hielt die ganze Instanz an,
  solange die Sicherung las), zehn Minuten sekuendlich, danach eine Stunde minuetlich
  nachgeholt, und danach die
  Seitenliste der `-shm`, die der Checkpoint stehen liess (gemessen: die
  Seiten der Teilnahme). Ein Abschnitt dieser Liste beginnt neu, sobald sein
  erster Frame geschrieben wird. Wie weit die Frames des Commits reichen,
  misst `clearWalSoon` sofort danach (fasst die -wal-Datei hoechstens 4062
  Frames, nur ein stat; sonst ein PASSIVE-Checkpoint, Feld `log`, bei
  `log = -1` (Checkpoint-Sperre bei einer anderen Verbindung) die Laenge der
  Datei; es wirft nie, die Teilnahme ist da schon gespeichert);
  lagen sie im ersten Abschnitt (bis Frame 4062), genuegt nach dem Leeren
  ein Schreibvorgang auf Seite 1 (`user_version` auf seinen eigenen Wert,
  unter `synchronous = OFF`, weil er nichts traegt und sonst zwei fsyncs je
  Teilnahme kostete; danach stehen in `-shm` und `-wal` nur Seite 1); lagen sie weiter hinten
  (ein Leser hielt das Leeren auf), schreibt `fillWalIndex` so viele neue
  Seiten, dass jeder Abschnitt bis dorthin neu beginnt, und leert erneut.
  Diese Fuellung bleibt offen (`walIndexFillOwed`), bis sie gelungen ist.
  Was offen ist (Leeren oder Fuellung), steht zusaetzlich im Vermerk
  `<dataDir>/.shm-fuellung-offen` (die offene Fuellung als Zahl, 0 = nur
  Leeren; geschrieben, sobald ein Leeren scheitert oder eine Fuellung offen
  wird, entfernt, sobald das Leeren gelungen ist): Endet der Dienst, waehrend
  die Sicherung liest, ist seine Verbindung nicht die letzte und schreibt das
  `-wal` nicht zurueck (nachgestellt). `restartStaleWalIndex` leert beim
  Dienststart, sobald ein Vermerk liegt, und fuellt nur, wenn SQLite die
  `-shm` beim Oeffnen nicht zurueckgesetzt hat (eine andere Verbindung, etwa
  die Sicherung, hielt sie offen); das misst `getDb` direkt beim Oeffnen an
  ihrer Groesse, denn spaeter waechst sie schon durch ein VACUUM dieses
  Prozesses (SQLite verkleinert die `-shm` nie, gemessen). Ohne Vermerk
  loest auch eine grosse `-shm` nichts aus.
  Nach dem Neuaufbau beim Umfrageende leert `clearWalSoon({ measure: false })`
  ohne Messung: Dessen Frames nennen nur frisch geschriebene Seiten, und als
  offene Fuellung waeren sie so gross wie die Tabelle. Die Teilnahme prueft
  die Antworten VOR der Doppelteilnahme, sonst verriete 409 gegen 400 ohne
  Schreiben, wer schon teilgenommen hat.
  Die frueheren Kanaele sind entfernt (Sender ohne Empfaenger, Doppel zu
  Ankuendigungen; Hintergrund docs/entscheidungen.md).
- **Was die HR pflegt, muss einen Empfaenger haben.** Der Abgleich
  „Backend-Route ohne Aufrufer“ (alle `app.<verb>('/api/...')` gegen alle
  `/api/...`-Literale in Renderer, Web und Desktop) gehoert zu jeder
  Abnahme; die Kanaele und die Entwicklungsplaene (Migration
  `330_drop_development_plans`) waren genau solche Sackgassen. Portal-Sicht
  auf Fachdaten der Person: `me/performanceRoutes.ts` (`GET
  /api/me/development`: Ziele, Trainings, Gespraeche mit Massnahmen,
  Skills; Seite `/entwicklung`. Bewusst NICHT: Vorgesetztenbewertungen samt
  Kommentaren und die HR-Notiz zur Trainingsanmeldung, beide bleiben HR und
  Fuehrung vorbehalten),
  `me/communicationRoutes.ts` (`/api/me/meetings` nur Protokolle mit
  `visibility = hr_vorgesetzte_mitarbeiter`, Seite `/gespraeche`; die Stufe
  `hr_vorgesetzte` geht nicht ans Portal, sondern an die Führung, siehe oben;
  `/api/me/directory` mit derselben Feldsichtbarkeit wie das
  HR-Verzeichnis, Seite `/kollegen`; das Portal-Organigramm filtert
  dieselben Felder), Bescheinigungen landen beim Aushaendigen als
  `documents`-Zeile mit `visibility = portal`. `GET /api/lookup/employees`
  (Core, `ANY_AREA_ROUTES` in `core/permissions.ts`: mindestens ein
  Fachbereich lesend, sonst 403) ist die bereichsneutrale Personenliste fuer
  Auswahlfelder aller Module; `EmployeeSelect` liest nur daraus, damit eine
  Rolle ohne `personal` keine leeren Picker sieht. Konto-Einstellungen
  (Passwort, Darstellung, Seitenleiste) liegen auf `/einstellungen/konto`
  ohne Bereichsbindung, weil jede Admin-Rolle ihr Passwort aendern koennen
  muss.
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
- **Varianten-Bundles:** `npm run build` baut die Variante aus `OHRGANIZE_VARIANT`
  (Vorgabe: `default` im Register); Backend ueber `apps/backend/scripts/build.mjs`,
  Desktop ueber `scripts/build.mjs` mit Marker-Abgleich. Nach dem Wechsel der
  Variable alle Workspaces neu bauen, sonst bricht der Desktop-Build ab.
- **Kein natives Menü:** Das Fenster ist rahmenlos (`titleBarStyle: 'hidden'`,
  auf macOS `hiddenInset`), `Menu.setApplicationMenu(null)`. Die eigene
  Titelleiste (`renderer/src/layout/TitleBar.tsx`) bringt App-Menü und
  Fenster-Controls mit; Aktionen laufen über IPC (`window.ohrganize.window` /
  `.app`, definiert im Preload). Tastaturkürzel (Strg+K/1–6/±/0, F11) sind in
  `AppShell.tsx` im Renderer registriert, da es kein Menü mehr für Accelerators
  gibt. Datei-Uploads nutzen die Dropzone `components/FilePicker.tsx`
  (`FilePicker`/`PhotoPicker`) statt nacktem `<input type=file>`. Farbfelder
  nutzen `components/ColorPicker.tsx` statt `<input type=color>` (das
  Chromium-Pop-up ist nicht themebar); die Komponente liefert immer
  `#rrggbb` in Kleinbuchstaben, toleriert im `value` Kurzform, fehlendes `#`
  und Grossschreibung, die Farbmathematik (Hex/RGB/HSV) liegt rein in
  `packages/shared/src/color.ts`, geprueft von
  `apps/backend/src/test/colorTest.ts`.
- **Dateien** liegen ausschließlich im Backend-Storage (`files`-Tabelle + Ordner).
  Downloads laufen über kurzlebige HMAC-signierte URLs (`core/files.ts`) — für
  Desktop- und späteren Web-Client identisch.
- **Verschlüsselung im Ruhezustand: Datenbank, Dateiablage und damit jede
  Sicherung.** Die Datenbank liegt im SQLCipher-4-Format vor (Rohschlüssel,
  `cipher = 'sqlcipher'`, `legacy = 4`), die Blobs in `storage/` mit
  AES-256-GCM in Abschnitten (`core/fileCrypto.ts`, Fassung 2: Kennung
  `OHRGENC\x02`, Salz, Nonce-Präfix, dann je 64 KiB ein Abschnitt mit eigenem
  Prüfwert; Schlüssel je Datei per HKDF, Abschnittsnummer und
  Schlusskennzeichen in der Nonce). Fassung 1 (ein Prüfwert am Ende) bleibt
  lesbar, geschrieben wird nur Fassung 2. Der Schlüssel steht in
  `<dataDir>/data.key`: 64 Hex-Zeichen oder der Verweis
  `extern:<absoluter Pfad>` auf eine Datei außerhalb des Datenverzeichnisses.
  **`db/encryption.ts` ist die einzige Stelle, die eine Datenbankdatei
  öffnet** (`openDatabase`: liegengebliebenes Journal zuerst zurückspielen,
  dann Zustand an den ersten 16 Byte, Klartext ohne, verschlüsselt mit
  Schlüssel, neu verschlüsselt); `db.ts`, die Sicherung und
  die Betreiberwerkzeuge (`toolkit.ts#openInstanceDb`) gehen alle dort durch.
  Nie `new Database(pfad)` direkt, sonst scheitert es am verschlüsselten
  Bestand mit „file is not a database“. **POSIX-Falle:** Den Dateikopf (oder
  sonst die Datenbankdatei per `fs.openSync`/`closeSync`) nie lesen, während
  im selben Prozess eine Verbindung darauf offen ist; das `close()` hebt alle
  fcntl-Sperren des Prozesses auf die Datei auf, auch die von SQLite
  (gemessen). Regeln:
  **Für einen verschlüsselten Bestand entsteht nie ein neuer Schlüssel**
  (fehlt `data.key`, bricht der Start mit Klartextmeldung ab; ein Schlüssel
  wird nur für eine neue Datenbank und bei der Umstellung erzeugt,
  durchgeschrieben und per Hardlink eingehängt, damit nie eine halbe
  `data.key` entsteht; nur auf Dateisystemen ohne Hardlinks kopiert der
  Rückfall nicht atomar). **Einen Klartextbestand stellt nur der Dienststart
  um** (`encryptDatabaseAtRest` in `buildServer` → `convertDatabaseAtRest`
  → `encryptDatabaseFile`, alles in `db/encryption.ts` bis auf den ersten):
  Zustand erst NACH dem Zurückspielen eines Journals bestimmen
  (`settledDatabaseState`; nach einem Abbruch im Commit ist Seite 1 schon
  verschlüsselt, der Bestand aber Klartext), dann Journalmodus DELETE und die
  Datei exklusiv sperren (`locking_mode = EXCLUSIVE`, sonst stellte die
  Sicherung über getDb() zwischendurch auf WAL zurück und das Umschlüsseln
  landete im -wal; auf andere Verbindungen gewartet wird für beide Schritte
  zusammen höchstens 10 s), dann `quick_check` des KLARTEXTS (ein alter
  Schaden, mit dem die bisherige Fassung lief, hielte sonst nach dem
  Umschlüsseln den Dienst an; so bleibt der Bestand unverschlüsselt und der
  Dienst läuft wie bisher), dann `PRAGMA rekey` **an Ort und Stelle** in einer
  Transaktion mit Rollback-Journal, dann `quick_check`. NIE Kopie plus
  Umbenennen: Ein Prozess, der die alte Datei offen hatte, fand danach das
  WAL der neuen über den Pfad und beschädigte sie (gemessen unter Linux). An
  Ort und Stelle bleibt es dieselbe Datei; eine vorher geöffnete Verbindung
  scheitert mit SQLITE_NOTADB. Ein Abbruch hinterlässt den Klartextbestand
  oder ein Journal mit Klartextseiten, das `rollBackHotJournal` OHNE
  Schlüssel zurückspielt (mit Schlüssel spielt SQLite3MC es nicht zurück;
  gemessen). Das Journal eines schon verschlüsselten Bestands dagegen muss
  MIT Schlüssel zurück: Ohne ihn stimmen die Prüfsummen nicht (SQLite bildet
  sie über den Klartext), SQLite löscht das Journal und lässt die halbe
  Transaktion stehen (gemessen). `journalContent` entscheidet an den
  Prüfsummen über die rohen Bytes und an Seite 1 und liest die Segmente des
  Journals wie SQLite (Satzzahl 0 heisst leeres Segment, nicht Ende).
  Lesen bis zur vollen Länge über `core/fileRead.ts#readFullSync`. **Vermerk
  `umstellung-pruefung-gescheitert.txt`** (`CONVERSION_FAILED_FILE`): VOR dem
  Umschlüsseln angelegt und durchgeschrieben (lässt er sich nicht anlegen,
  wird nicht umgestellt), erst nach bestandener Prüfung entfernt; so
  hinterlässt jeder Abbruch dazwischen einen (ein erst nach dem Scheitern
  geschriebener fehlte genau bei voller Platte). Der Vermerk einer laufenden
  Umstellung wird nur unter ihrer exklusiven Sperre angelegt und entfernt
  (`encryptDatabaseFile`), sonst entfernte ein gleichzeitig startender
  zweiter Prozess ihn; ausserhalb entfernt ihn nur eine eigene bestandene
  Prüfung der verschlüsselten Datei oder das Fehlen jeder Datenbank (beides
  scheitert an einer laufenden Umstellung mit SQLITE_BUSY bzw. trifft sie
  nicht). Die Prüfung nach dem Umschlüsseln leert vorher den Seitencache
  (`shrink_memory`): Unter `locking_mode = EXCLUSIVE` behält die
  Verbindung ihn, und eine Datenbank unter etwa 16 MB prüfte sonst nur den
  Cache statt der Platte (nachgestellt). Über einen Fehler
  entscheidet der ZUSTAND der Datei danach, nicht die Art des Fehlers:
  Klartext heißt, der Dienst läuft unverändert weiter, und `status.cjs`/
  `provision.sh check` melden „NICHT verschluesselt“; verschlüsselt heißt
  `ConversionVerificationError`, der Dienst startet nicht. Ausnahme vom
  „unverändert weiterlaufen“: Ein SQLite-Modul, das gar nicht verschlüsseln
  kann, ist ein Startabbruch (`CipherUnavailableError`, geprüft VOR Schlüssel
  und Vermerk; die Lade-Proben der Deploy-Skripte prüfen `PRAGMA cipher`, nicht
  nur das Laden). Findet ein Start
  den Vermerk: bei verschlüsselter Datei läuft die Prüfung erneut (besteht
  sie, fällt er weg; sonst startet der Dienst nicht, auch kein Neustart durch
  systemd oder NSSM; fehlt der Schlüssel oder hält ein anderer Prozess die
  Datei, sagt die Meldung genau das statt „Sicherung zurückspielen“), bei
  Klartext (Umstellung nie committed, oder die Sicherung von vorher ist
  zurückgespielt, auch von Hand unter Windows) wird umgestellt, und die
  Umstellung entfernt ihn mit ihrem Erfolg. `status.cjs` meldet ihn
  (`encryption.conversion_marker`), `provision.sh check` neben einer
  verschlüsselten Datenbank als Befund. Die Rücknahme in
  `ohrganize-update.sh` entfernt ihn zusätzlich selbst. Sicherung
  und Werkzeuge stellen nie um. **Kopien entstehen mit `copyDatabaseTo`
  (`VACUUM INTO`), nicht mit `db.backup()`**: Die Online-Backup-Schnittstelle
  lehnt eine verschlüsselte Quelle ab. Weil `VACUUM INTO` die Kopie aus den
  Zeilen neu aufbaut, sieht ihre Prüfung keine Schäden der Quelle; die
  Sicherung prüft deshalb vorher die laufende Datenbank (`quick_check`).
  **SQLite-Hilfsdateien sind unverschlüsselt** (SQLite3MC verschlüsselt nur
  Datenbankdatei und -wal; ein VACUUM legte eine Klartextkopie des Inhalts
  ab, gemessen). Deshalb `configureConnection`: Eine Verbindung auf eine
  VERSCHLÜSSELTE Datenbank hält alles Temporäre im Arbeitsspeicher
  (`temp_store = MEMORY`); eine auf einen KLARTEXTBESTAND (nur noch die
  Umstellung und eine gescheiterte Umstellung) legt es in
  `<dataDir>/.sqlite-tmp` (`PRAGMA temp_store_directory`, prozessweit;
  Rückfall `temp_store = MEMORY`), weil das Umschlüsseln im Arbeitsspeicher
  die 1,3-fache Datenbankgrösse kostete und im System-Temp eine Klartextkopie
  lag. Das gilt nur für Verbindungen über `openDatabase` (die einzige
  erlaubte Art, siehe oben): Eine Verbindung, die an `configureConnection`
  vorbei entsteht, schreibt ihre Hilfsdateien unverschlüsselt in eine Datei
  (System-Temp, oder `.sqlite-tmp`, falls im Prozess schon gesetzt).
  **Verschlüsselt geschrieben wird erst, wenn die Datenbank verschlüsselt
  ist** (`isDatabaseEncrypted`, `writeStorageKey` in `core/files.ts`):
  Bleibt sie im Klartext, bleiben es auch neue Dateien, und eine ältere
  Fassung kann beides lesen. `encryptStoredFiles` stellt den Altbestand nach
  `listen` im Hintergrund um, mit Zwischendateien in
  `storage/.umstellung` (gleiches Dateisystem; ein eigenes Verzeichnis, weil
  jeder Dateiname in `storage/` einem Upload gehören kann; die Sicherung lässt
  es aus). Der Lauf schreibt auch Dateien der Fassung 1 auf Fassung 2 um.
  Für jede geprüfte Datei steht ein Fingerabdruck (Datei-ID, Grösse, mtime in
  Nanosekunden) in der Tabelle `_storage_checked` (in der Datenbank, damit er
  mit ihr zurückgespielt wird; geschrieben wird nur, was sich geändert hat);
  stimmt er, kostet die Datei beim nächsten Start
  nur ein stat. KEINE Zeitmarke auf ctime: Windows erhält beim Kopieren
  (Copy-Item, robocopy, CopyFile) die ctime der Quelle (gemessen), ein
  Umbenennen des Verzeichnisses tut es überall, und zurückgelegte
  Klartextdateien blieben liegen. Gescheiterte Dateien bekommen keinen
  Eintrag und kommen beim nächsten Start wieder dran, ebenso leere Dateien,
  die jünger als `UPLOAD_IN_FLIGHT_MS` sind (ein Upload, der gerade
  entsteht). Die Umstellung einer
  Datei läuft asynchron je Abschnitt (synchron blockierte eine grosse Datei
  den Dienst, in der Desktop-App samt Fenster); unmittelbar vor dem
  Umbenennen vergleicht sie die Datei synchron mit dem Stand beim Öffnen,
  sonst legte sie eine währenddessen gelöschte Datei wieder an
  (nachgestellt). `openBlob` gibt jeden Abschnitt erst nach seiner Prüfung ab und
  prüft den ersten, bevor die Download-Route Kopfzeilen setzt; scheitert ein
  späterer, bricht der Strom ab (Fassung 1: zwei Durchgänge, erst prüfen,
  dann senden). Die EINZIGE Einordnung einer Datei (`blobKind`: Klartext,
  Fassung 1 oder 2, beschädigt = Kennung, aber zu kurz) nutzen Download,
  Umstellung, `status.cjs` und Sicherung gemeinsam. Dateien ohne
  Kennung gelten als Klartext-Altbestand und gehen unverändert hinaus;
  `files.size_bytes` und `sha256` beschreiben immer den Klartext.
  `storageEncryptionState` (fileCrypto.ts) liefert `status.cjs` und dem
  MANIFEST den tatsächlichen Stand von `storage/` (gelöschte Dateien
  übersprungen, nicht zu öffnende gezählt statt abzubrechen, gerade
  entstehende Uploads nicht als beschädigt; die Sicherung kopiert deshalb mit
  `preserveTimestamps`, sonst trüge unter Linux jede Kopie die Uhrzeit des
  Kopierens und galt als gerade entstehend). Die Rücknahme in
  `ohrganize-update.sh` spielt Datenbank (erst daneben kopieren, dann
  tauschen) UND `storage/` aus der Sicherung zurück (jeder Schritt einzeln
  geprüft: `set -e` greift in Funktionen nicht, die links von `||`
  aufgerufen werden), und die Update-Skripte warten auf den ersten Start bis
  zu 15 Minuten gemessener Zeit (nicht Durchläufe), solange der Dienst läuft
  (`warte_auf_start`, `Wait-ForStart`; eine leere Antwort von systemctl zählt
  nicht als Neustart). `update-server.ps1` spielt die Sicherung nicht selbst
  zurück (den Zielordner kennt nur die geplante Aufgabe), seine Meldung nennt
  Migration UND Umstellung als Grund. Die Sicherung nimmt `data.key` mit
  und nennt im MANIFEST nur Dateien, die sie enthält; bei einem Verweis
  enthält sie nur den Verweis und kein `secret.key`. **Grenzen:** Liegt der
  Schlüssel neben den Daten (Vorgabe), schützt das einzelne Dateien, nicht
  den vollständig kopierten Ordner. Ein Umzug des Schlüssels nach außen
  wechselt ihn nicht; ältere Sicherungen mit Schlüssel öffnen weiterhin alle
  späteren. Einen Schlüsselwechsel gibt es nicht. Jede API-Antwort trägt
  `Cache-Control: no-store` (Hook in `server.ts`). Migrationen, die Daten
  entfernen, setzen `vacuumAfter: true`: `migrateDatabase` vermerkt das
  VACUUM im Commit (`_vacuum_pending`), führt es danach aus und entfernt den
  Vermerk erst nach einem vollständigen Checkpoint (im WAL-Modus landet das
  VACUUM sonst nur im -wal), warnt bei einem Fehlschlag statt den Start
  abzubrechen und holt es bei jedem späteren Start nach; ist nur der
  Checkpoint blockiert (ein Leser), steht danach nur er aus
  (`_vacuum_checkpoint_pending`), nicht ein zweites VACUUM. Bei verschlüsselter
  Datenbank entsteht die Kopie des VACUUM im Arbeitsspeicher (siehe
  Hilfsdateien oben; gemessen das 1,5-Fache der Nutzdaten); über 300 MB
  Nutzdaten wird es endgültig übersprungen (eine Warnung, Vermerk weg; an
  ihm hängt keine Zusicherung, siehe unten), statt die
  Hosting-Unit über MemoryHigh=512M zu treiben. Damit das VACUUM für die
  eigenen Daten einer Migration nicht nötig ist, läuft jede Migration unter
  `secure_delete`, und eine, die schutzwürdige Inhalte aus einer Tabelle
  entfernt, baut die Tabelle danach mit `rebuildTableInKeyOrder` neu auf,
  über den TypeScript-Schritt `run` der Migration (gleiche Transaktion,
  Vorbild `502_survey_anonymity`): Beim Umschreiben an Ort und Stelle (DROP
  COLUMN, UPDATE) bleiben Kopien in Seitenlücken, die `secure_delete` nicht
  erfasst, und ein DELETE FROM gibt die Wurzelseite nie frei (gemessen).
  Verwaiste Zeilen vorher löschen: Das Wiedereinfügen prüft die
  Fremdschlüssel, sonst bricht der Lauf ab. Der Probelauf (`migrate-check`) ruft `migrateDatabase` mit
  `{ vacuum: false }`, weil seine Kopie gleich gelöscht wird. Test:
  `src/test/encryptionSmoke.ts`; Hintergrund: docs/entscheidungen.md.
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
- **Edition gegen Feature.** Die Edition ist der Build-Inhalt (Varianten,
  `packages/shared/src/variants`); ein **Feature** ist ein Lizenzschalter
  innerhalb des Builds: Registry `FEATURES` in
  `packages/shared/src/features.ts` (`key`, `label`, `routes`, `navPaths`,
  `widgets`, `portalPaths`), Gate `core/featureGate.ts` im globalen Hook
  direkt hinter `assertLicenseAllows` und VOR dem Self-Service-Zweig. Fail
  open fuer Routen ohne Feature (die Bereichspruefung bleibt fail closed);
  alles an ohne einschraenkende Lizenz (`effectiveFeatures()` in
  `core/license.ts`: 'all' bei entwicklung, Testphase, v1, v2 ohne
  `features`). Fehlt das Feature: `403 LICENSE_FEATURE_MISSING`, den die
  Desktop-App als einzigen 403 als Toast zeigt. Kundenspezifische
  Funktionen werden als Feature im Hauptprodukt gebaut, nie als Branch.
  Beide Clients filtern Navigation und Widgets ueber `useAuth().features`
  bzw. `hasFeature(key)`. Test: `src/test/featureSmoke.ts` (Registry-Regeln:
  Praefixe beginnen mit `/api/`, treffen keine offene Lizenzroute und nie
  `/api/me` als Ganzes).

## Varianten (Land x Edition als eigener Build)

- **Register ist die einzige Quelle:** `packages/shared/src/variants/registry.json`
  (`default`, je Variante `id`, `country`, `edition`, `label`, `modules`).
  Editionen sind KEINE feste Liste im Code, nur ein Muster (`EDITION_PATTERN`);
  welche es gibt und wie sie heissen, legt der Anbieter dort fest. Heute gibt
  es genau `de-vollversion` (alle neun Module). Pflichtmodule `employees` und
  `admin`, Abhaengigkeit `me` braucht `absences` (`variants/index.ts` prueft
  beim Import und wirft bei Fehlern).
- **Verdrahtung wird erzeugt, nicht geschrieben:** `npm run variants:gen`
  (`scripts/variant-wiring.mjs`) schreibt je App `src/variants/<id>.ts`
  (Backend `backendModules`, Renderer `variantRoutes`, Portal
  `portalRoutes` als .tsx) plus `<id>.manifest.ts` (nur `VARIANT`,
  `VARIANT_ID`, `VARIANT_MARKER`) und `default.*` (Re-Export der Vorgabe).
  Die Dateien sind versioniert; `npm run variants:check` (Teil jeder
  Abnahme) meldet Abweichungen vom Register. **Neue Module** tragen sich in
  `MODULE_KEYS` (shared), in die Tabellen `BACKEND`/`RENDERER`/`WEB` des
  Generators UND in `ROUTE_AREAS` ein; `modules/index.ts` und
  `router.tsx` bleiben unangetastet.
- **Alias statt Schalter:** `@variant` und `@variant-manifest` zeigen per
  tsconfig `paths` (Typecheck, tsx, Dev-Betrieb) auf `default.*`; die Builds
  (`apps/backend/scripts/build.mjs`, Vite ueber `scripts/variant-alias.mjs`,
  Desktop per esbuild `define`) zeigen sie per `OHRGANIZE_VARIANT` auf die
  Datei der Variante. Nur importierte Module landen im Bundle (esbuild
  buendelt einen Import auch hinter totem Code, deshalb kein `if`).
  Dateien, die NUR das Manifest brauchen (nav.ts, dashboardConfig.ts,
  config.ts, backup.ts, main.tsx), importieren `@variant-manifest`, sonst
  entstuenden Importzyklen ueber die Routen. Ein Root-`tsconfig.json` mit
  denselben `paths` existiert nur, damit `npx tsx apps/backend/...` aus dem
  Repo-Root laeuft. Eine andere Variante im Dev-Betrieb heisst: `default` im
  Register umstellen, `variants:gen`, zurueckstellen vor dem Commit.
- **Schema variantenunabhaengig:** Alle Migrationen laufen in jeder
  Variante; Editionen entfernen Routen und Seiten, nie Tabellen. Ein
  Editionswechsel ist Installer plus Lizenz, ohne Migration.
- **Verwechslung wird technisch verhindert:** `/api/health` liefert
  `variant { id, country, edition, label }`; die Desktop-App bricht bei
  fremder Variante mit `StartupError` ab (main.ts `assertReachable`); das
  Backend verweigert den Start, wenn `OHRGANIZE_VARIANT` in der Umgebung
  nicht zur einkompilierten Variante passt (config.ts); eine v2-Lizenz
  fremder Ausgabe ist unbrauchbar wie eine Fremdbindung
  (`licenseState.ts` `variantMismatchReason`, Upload 400); der
  Desktop-Build prueft die Marker von server.cjs und Renderer-Assets vor dem
  Kopieren; `npm run check:variant -- --variant <id>` prueft alle Bundles
  (Marker vorhanden, keine fremden Marker, Signaturen ausgeschlossener
  Module fehlen). Der Installer heisst
  `oHRganize-Setup-<version>-<variante>.exe` (`apps/desktop/scripts/dist.mjs`
  setzt `OHRGANIZE_VARIANT` fuer electron-builder); `appId` und
  `productName` bleiben gleich, sonst spaltete sich `%APPDATA%\oHRganize`.
- **Sichtbarkeit in den Clients:** `NAV_SECTIONS` ist die Sicht der
  Variante auf `ALL_NAV_SECTIONS` (`navSectionsForVariant`, Modul aus
  `AREA_MODULES` oder explizit `module`); Dashboard-Widgets und Kacheln
  filtern ueber `moduleEnabled(VARIANT, ...)`; das Portal ueber `module` an
  den NavItems. Test: `src/test/variantSmoke.ts`.

## Laender als Datendimension

- **Das Land kommt aus der Variante, nie aus einer Einstellung.**
  `VARIANT.country` (ISO-2, heute nur `DE`) entscheidet ueber Regionen,
  Feiertagsrecht, Kataloge, Formatierung und Exportadapter.
  `packages/shared/src/country.ts` ist die EINZIGE Quelle: `COUNTRY_CODES`,
  `COUNTRY_LABELS`, `REGIONS` (DE = die 16 Bundeslaender, AT und CH bewusst
  leer), `REGION_TERMS` (Bundesland bzw. Kanton), `regionCodesFor`,
  `regionsFor`, `isRegionOf`, `regionLabel`, `LOCALES`, `CURRENCIES`,
  `localeFor`, `currencyFor`. `BundeslandCode` und `BUNDESLAND_LABELS` in
  `common.ts` sind nur noch Aliasse auf `REGIONS.DE`.
  **Ein leerer Regionskatalog heisst "gibt es hier nicht":** `isRegionOf`
  laesst dann nur den Leerwert zu, und die Formulare blenden das Feld aus.
- **Region gegen Bundesland.** Datenbankspalte (`locations.bundesland`) und
  die bestehenden Antwortfelder heissen weiterhin `bundesland`; neue Felder
  heissen `region` und `country`. Die Kalender-APIs
  (`/api/absences/calendar`, `/api/me/calendar`) und die beiden
  Vorschauen (`/api/absences/preview`, `/api/me/leave-preview`) liefern
  beides, damit die Clients getrennt umgestellt werden koennen. Der
  `holidays`-Schluessel bleibt der Regionscode.
- **Land und Region einer Person** liefert ausschliesslich
  `regionForEmployee(employeeId)` (`modules/absences/service.ts`): Standort
  (`locations.country`/`locations.bundesland`), sonst `companyRegionDefaults()`
  (Land der Variante plus `defaultBundesland`). Sammelabfragen nutzen
  `REGION_SELECT_SQL` + `REGION_JOIN_SQL` + `regionSelectParams()` statt
  eigener COALESCE-Ausdruecke; die drei Duplikate von frueher sind damit weg.
- **Feiertage sind Daten, kein Code:** `HOLIDAY_RULES` in
  `core/holidays.ts` haelt je Land eine Regelliste (`date` | `easter` |
  `compute`, `regions`, Jahresfenster `from`/`to`).
  `holidaysForYear(year, country, region)` und
  `isHoliday(date, country, region)`; der Cache-Schluessel traegt das Land.
  Regressionsanker ist `src/test/fixtures/holidays-de.json` (8 Jahre mal 16
  Regionen, VOR dem Umbau erzeugt), geprueft von `src/test/holidaysTest.ts`.
  Eine leere Regelliste (AT, CH) ergibt ein Jahr ohne Feiertage.
- **Kataloge je Land** in `packages/shared/src/employees.ts`:
  `EMPLOYEE_TYPES_BY_COUNTRY`, `TAX_CLASSES_BY_COUNTRY`,
  `CHURCH_TAX_BY_COUNTRY` mit den Accessoren `employeeTypesFor`,
  `taxClassesFor`, `churchTaxOptionsFor` und `employeeTypeRulesFor`.
  Letztere streicht Pflichtfelder, fuer die das Land keinen Katalog hat
  (ohne Steuerklassen waere `tax_class` unerfuellbar). Backend
  (`modules/employees/validation.ts`) und Formular
  (`renderer/.../employeeForm.tsx`) lesen NUR ueber die Accessoren.
- **Adapter statt fester Formate:** Lohnexport
  (`modules/compensation/payrollExport/`, Registry `PAYROLL_EXPORTERS`,
  heute `lodas` fuer DE) und Bescheinigungen
  (`modules/compensation/certificates/`, `CERTIFICATE_TEMPLATES` je Land,
  heute `de.ts`). Die Route `/export.datev` bleibt und schlaegt `lodas`
  nach; ein Land ohne Vorlage antwortet mit 501 statt mit deutschen
  Paragraphen.
- **Auswahllisten ueber die API:** `GET /api/regions[?country=]` liefert
  `{ country, country_label, regions }`; `GET /api/bundeslaender` bleibt als
  Alias. Beide stehen in `ALWAYS_ALLOWED` (`core/permissions.ts`), sonst
  saehe jede Rolle ohne `einstellungen` ein leeres Auswahlfeld.
  `defaultBundesland` wird gegen `isRegionOf(VARIANT.country, ...)` geprueft.
- **Formatierung:** `formatMoney(cents, locale, currency)` in `common.ts`,
  `formatEuro` ist die Huelle dafuer. Die Clients halten
  `apps/renderer/src/lib/locale.ts` und `apps/web/src/lib/locale.ts` mit
  `COUNTRY`, `LOCALE`, `CURRENCY`, `REGIONS`, `REGION_TERM`,
  `REGION_CODES`, `DEFAULT_REGION`. Neue oder angefasste Dateien nehmen
  `LOCALE` statt der Zeichenkette `'de-DE'`; die restlichen Fundstellen
  werden beim naechsten Anfassen umgestellt. `lang="de"` bleibt (UI-Sprache
  in allen drei Laendern Deutsch).
- **Schema bleibt variantenunabhaengig:** Migration `107_locations_country`
  ist additiv (`locations.country` mit Vorgabe `DE`,
  `employees.private_country`) und laeuft in jeder Variante.
  `private_country` ist bewusst NICHT in `EMPLOYEE_SELF_EDITABLE_FIELDS`:
  Ein Landeswechsel gehoert zur Meldung und damit in die Personalabteilung.

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
- **Schrift:** Creato Display (Hausschrift der Website) aus dem Workspace-Paket
  `packages/fonts`; beide Clients importieren `@ohrganize/fonts/creato-display.css`
  in `main.tsx`, die Familie steht in `--font-sans` beider tokens.css. Drei
  Stellen können die Variable nicht lesen und nennen die Familie deshalb
  selbst (bei einem Wechsel mitziehen): der SVG-Export in
  `features/employees/OrgChart.tsx`, das Inline-SVG in `OrgPage.tsx` und
  `ABSENCE_BAR_LABEL_FONT` in `packages/shared/src/absences.ts` (Canvas-Textmaß
  für die Kalenderbalken, muss `.hm-cal__bar-label`/`.pt-cal__bar-label`
  spiegeln). Zweitschrift ist Plus Jakarta Sans Variable
  (`@fontsource-variable/plus-jakarta-sans`, wie auf der Website): erste
  Rückfallschrift in `--font-sans` für Zeichen, die Creato nicht hat, und
  über `--font-numeric` die Familie an JEDER Stelle mit
  `font-variant-numeric: tabular-nums` (Creato hat keine Tabellenziffern,
  Jakarta schon). Wer `tabular-nums` setzt, setzt auch
  `font-family: var(--font-numeric)`. Die Familie ist statisch (7 Schnitte, kein SemiBold); die
  Oberfläche nutzt weiterhin Zwischengewichte (550, 600, 650 usw.), und die
  `font-weight`-BEREICHE in der Stildatei entscheiden, welcher Schnitt sie
  trägt (bis 479 Regular, 480 bis 599 Medium, 600 bis 749 Bold). Gewichte im
  Code deshalb NICHT auf 500/700 „normalisieren“: Die Stufen der Oberfläche
  hängen an den Bereichen. Hintergrund: docs/entscheidungen.md.
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
| SQL-Migrationen | `backend/src/db/migrations/<NNN>_<modul>.ts` | Nummernkreise: 0xx Core, 1xx Personal, 2xx Abwesenheit, 3xx Leistung (inkl. 310 Führung), 4xx Vergütung, 5xx Kommunikation, 6xx Recruiting, 7xx Verwaltung. Array in der Moduldatei füllen, `index.ts` nicht anfassen. Wer schutzwürdige Daten entfernt: optionaler TypeScript-Schritt `run` (gleiche Transaktion) mit `rebuildTableInKeyOrder` statt DROP COLUMN/DELETE allein, Regel unter „Verschlüsselung im Ruhezustand“. |
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
- **`better-sqlite3` ist ein npm-Alias auf `better-sqlite3-multiple-ciphers`**
  (dieselbe Versionsnummer, dieselbe Schnittstelle, dazu die Verschlüsselung;
  Spec `npm:better-sqlite3-multiple-ciphers@<version>` in den drei
  Workspaces, Lockfile-Eintrag `node_modules/better-sqlite3` mit `name`).
  Importe, `--external`, `npm rebuild better-sqlite3`, `reset-native.mjs` und
  die Ladeproben der Deploy-Skripte nennen deshalb weiter `better-sqlite3`.
  Vier Folgen: Der Eintrag in `allowScripts` trägt den ECHTEN Paketnamen;
  Fertigpakete für eine Electron-ABI stehen im GitHub-Release des Forks, nicht
  des Originals; **`npm install` tauscht ein vorhandenes Modul nicht aus**,
  weil npm bei einem Alias nur die Versionsnummer vergleicht (das Original
  gleicher Version gilt als passend, und dann kann die Datenbank nicht
  verschlüsselt werden; `applyKey` in `db/encryption.ts` bricht mit Erklärung
  ab) und **`npm dedupe` hebt nebenbei fremde Pakete an**. Eine
  Versionsanhebung deshalb so: Spec in den drei `package.json`, Eintrag in
  `allowScripts`, im Lockfile `version`, `resolved` und `integrity` des einen
  Eintrags von Hand, dann `npm ci`. `scripts/release-server.mjs` schreibt den
  Alias in das gekürzte Manifest des Server-Archivs.
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
- **Kanal ist eine Funktion der Version, kein eigenes Feld.** `channelOf`
  (`packages/shared/src/version.ts`): `1.2.0` ist `stable`, jede Version mit
  Vorabkennung ist `beta`; `/api/health` meldet `channel`, die Titelleiste
  zeigt eine Beta als Abzeichen. **Falle:** `compareVersions` ordnet seither
  semver-richtig, also ist `1.1.0-beta.1` AELTER als `1.1.0` und
  `isAtLeast('1.1.0-beta.1', '1.1.0')` falsch. Soll eine Beta derselben
  Nummer im Umlauf sein, muss `MIN_CLIENT_VERSION` auf die Beta zeigen.
- **Ein Release baut `npm run release`** (`scripts/release.mjs`): Version
  ueber alle Workspaces, Commit und Tag, je Variante Build plus
  `check-variant` plus Server-Archiv plus Installer, dann je Variante ein
  `release.json` (Version, Kanal, Variante, Artefakte mit sha256,
  `min_*`, Commit) signiert ueber `ssh-keygen -Y sign -n ohrganize-release`;
  Vertrauensanker `deploy/ohrganize-release.allowed_signers` (Schluessel
  getrennt vom Lizenzschluessel, alte Zeilen bleiben bis zum Ende der
  Rotation). Ablage `release/<version>/<kanal>/<variante>/`; zum Schluss
  `npm rebuild better-sqlite3`, weil `dist:win` die ABI umbaut.
- **Serverauslieferung ist das Release-Archiv, nicht das Repo.**
  `npm run release:server` (`scripts/release-server.mjs`) baut Backend und
  Portal EINER Variante (`--variant`, sonst `OHRGANIZE_VARIANT`, sonst die
  Vorgabe des Registers) und packt
  `release/ohrganize-server-<variante>-<version>.zip` (Ablage ueber `--out`
  umlenkbar): nur `cli.cjs`, `backup.cjs` und die Betreiberwerkzeuge, sobald
  der Build sie erzeugt (minifiziert, **ohne** `.map`, die den Quelltext
  wieder lesbar machten), dazu `VARIANTE.txt` und ein unsigniertes `release.json`,
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
- **Betreiberwerkzeuge (`apps/backend/src/scripts/`).** `status.ts`
  (Zustand einer Instanz: Installations-ID, Lizenz, Plaetze, Zaehlungen,
  ausstehende Migrationen; `--json` fuer Skripte), `admin-reset.ts`
  (Passwort neu setzen, Sitzungen entwerten, Audit-Zeile mit `user_id NULL`)
  und `migrate-check.ts` (Migrations-Probelauf auf einer Kopie per `VACUUM INTO`).
  Drei Regeln gelten fuer jedes weitere Werkzeug, sie stehen ausfuehrlich in
  `scripts/toolkit.ts`:
  **kein Import von `config.ts`** (der Import legt Verzeichnisse an und
  erzeugt `secret.key` mit den Rechten des Aufrufers; das Datenverzeichnis
  kommt aus `--data-dir`), **kein Lauf als root** (`refuseRoot`; ein Zugriff
  als root legt `-wal`/`-shm` mit falschem Eigentuemer an, danach startet der
  Dienst nicht mehr; auf Windows greift die Regel mangels `process.getuid`
  nicht) und **`variantBanner()` in der Ausgabe** (sonst laesst esbuild den
  Variantenmarker weg und das Bundle ist keiner Ausgabe mehr zuzuordnen).
  Deshalb liegt `migrateDatabase` in `db/migrateDatabase.ts` ohne `db.js`.
  `apps/backend/scripts/build.mjs` baut die drei Einstiege automatisch,
  sobald sie existieren; `release-server.mjs` nimmt sie ins Archiv.
- **conspectus ist das Register des ANBIETERS** (`tools/conspectus`, eigener
  Workspace, `npm run conspectus -- --help`). Es kennt Kunden, Hosts,
  Instanzen, ausgestellte Lizenzen, Releases und Rollouts und stellt Lizenzen
  ueber denselben Baustein aus wie `npm run lizenz`
  (`core/licenseIssue.ts`). Drei Regeln, die es von einem Notizzettel
  unterscheiden: Das Register liegt AUSSERHALB des Repositories
  (`OHRGANIZE_CONSPECTUS_DIR` ist Pflicht, Pfade im Repo und in
  synchronisierten Ordnern werden abgewiesen); Ausgabe und Installations-ID
  einer Lizenz werden aus der Instanz NACHGESCHLAGEN statt eingetippt; und
  eine v2-Datei entsteht nur, wenn die Instanz v2 LESEN kann (`license_format`
  aus dem Bericht, nicht die Versionsnummer, denn eine Mindestserverversion
  gibt es nicht). Die Umstelllogik eines Rollouts steht NICHT hier, sondern in
  `deploy/ohrganize-update.sh` auf dem Host; conspectus schickt hin, ruft auf
  und schreibt mit. Betreiberdoku: `docs/betrieb-anbieter.md`,
  Test: `tools/conspectus/src/test/smoke.ts` (Wegwerf-Register in `os.tmpdir()`,
  eigenes Schluesselpaar, laeuft bei `npm test` mit).
- **Hosting: Programm je Instanz als Symlink.**
  `/opt/ohrganize/releases/<variante>-<version>` ist das entpackte Archiv,
  `/opt/ohrganize/kunden/<kunde>` und
  `/srv/ohrganize-web/kunden/<domain>` sind Symlinks darauf. Das Pinnen einer
  Instanz IST dieser Symlink, und der Rueckweg aus einem misslungenen Update
  auch. `deploy/ohrganize-update.sh` (Pruefsumme, Signatur, Ausgabe gegen
  env-Datei UND `/api/health`, `npm ci`, better-sqlite3-Probe,
  Migrations-Probelauf auf Kopien, dann je Instanz Sicherung, stop, Symlink,
  start, Health, bei Fehler Ruecknahme samt Markerdatei
  `.update-fehlgeschlagen`) und das Windows-Gegenstueck
  `deploy/windows/update-server.ps1`. Gemeinsame Pfade und Hilfsfunktionen:
  `deploy/ohrganize-lib.sh` (nur EINMAL, sonst driften Provisionierung und
  Update auseinander). `ohrganize-provision.sh` kann ausserdem `status`,
  `id`, `lizenz`, `passwort`, `pin`, `pausieren`, `fortsetzen`, `restore`
  und `check`; alle Node-Aufrufe ueber `runuser -u $DIENST_BENUTZER`.
  Leseisolation zwischen den Instanzen ueber
  `TemporaryFileSystem=/var/lib/ohrganize:ro` plus `BindPaths=.../%i` in
  beiden Units (`ReadWritePaths` allein verhindert nur das Schreiben),
  dazu Ressourcengrenzen. `OHRGANIZE_QUIET_INITIAL_PASSWORD=1` haelt das
  Initialpasswort aus dem Journal; abgeholt wird es mit
  `provision.sh passwort <kunde>`.

## Häufige Kommandos

```bash
npm run dev            # Backend (3001) + Renderer (5173) + Web-Portal (5174) parallel
npm run dev:desktop    # Electron-Fenster gegen den Dev-Stack
npm run typecheck      # alle Workspaces
npm run seed           # Demo-Daten
npm run build:web      # statisches Portal-Build → apps/web/dist
npm run dist:win       # kompletter Windows-Installer (NSIS) → apps/desktop/release
npm run release -- --version 1.1.0 --variants de-vollversion   # vollstaendiges Release je Variante, signiertes Manifest
npm run release:server # Server-Release-Archiv einer Variante (--variant, --out) → release/
npm run lizenz -- …    # Lizenzwerkzeug des Anbieters: keygen | keys | sign | inspect (docs/lizenzierung.md)
npm run conspectus -- …  # Register des Anbieters: kunde | host | instanz | lizenz | release | rollout | check (docs/betrieb-anbieter.md)
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
