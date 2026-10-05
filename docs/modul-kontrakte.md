# Modul-Kontrakte (für die parallele Modulentwicklung)

Diese Kontrakte sind stabil. Module verlassen sich aufeinander **nur** über die
hier beschriebenen Schnittstellen — alles andere ist modulintern.

## 1. Kerntabellen (Migration `100_employees_core`, bereits vorhanden)

- `employees` — Stammdaten inkl. `employee_type`, `status` ('aktiv'|'ausgeschieden'),
  `department_id`, `team_id`, `location_id`, `manager_id`, `hire_date`, `exit_date`,
  `weekly_hours`, `annual_leave_days`, `photo_file_id` und
  `photo_thumb_file_id` (Vorschaubild, Migration 111; Listen signieren Fotos
  über `signPhotoUrl` in `core/files.ts`). Vollständige Spaltenliste in
  `backend/src/db/migrations/100_employees.ts`.
- `departments` (mit `parent_id`-Hierarchie), `teams`, `locations` (mit `country`
  und `bundesland`). `employees.private_country` haelt das Land der
  Privatanschrift (Migration `107_locations_country`, additiv).
- Andere Module dürfen per SQL **lesend joinen** und Fremdschlüssel auf diese
  Tabellen anlegen. Schreibzugriffe nur durch das Personal-Modul — mit **einer
  dokumentierten Ausnahme**: die Einstellung im Recruiting-Modul (siehe §2).

## 2. API-Kontrakte zwischen Modulen

- `GET /api/employees?fields=lite&status=aktiv&search=…` (Personal-Modul) →
  `{ employees: [{ id, first_name, last_name, employee_type, status, job_title,
  department_id, team_id, location_id }] }`. Wird vom gemeinsamen
  `EmployeeSelect`/`useEmployees` (Renderer) benutzt.
- Feiertage: `GET /api/holidays/:year/:land` (Core, fertig; optional
  `?country=`). Backend-intern: `core/holidays.ts` mit
  `holidaysForYear(year, country, region)` und `isHoliday(date, country, region)`.
  Land und Region einer Person kommen aus `regionForEmployee(employeeId)`
  (`modules/absences/service.ts`): `locations.country` und
  `locations.bundesland`, ohne Standort das Land der Variante und
  `getSetting('defaultBundesland')`. Fuer Sammelabfragen gibt es dort
  `REGION_SELECT_SQL`, `REGION_JOIN_SQL` und `regionSelectParams()`; der
  Spaltenalias heisst weiterhin `bundesland`, weil die Kalender-APIs ihn so
  ausliefern.
- Regionsbegriff: `bundesland` ist der DEUTSCHE Name der Region. Neue Felder
  und Antworten heissen `region` (Code) und `country` (ISO-2); die
  Auswahllisten kommen aus `GET /api/regions` bzw. aus `REGIONS` in
  `packages/shared/src/country.ts`. Das LAND einer Installation ist
  `VARIANT.country` und keine Einstellung.
- Bonus-Kopplung: Vergütung liest Zielerreichung über die Tabelle `goals`
  (Leistungs-Modul) — Spalten-Kontrakt: `goals(id, employee_id, title, progress
  INTEGER 0–100, status TEXT)`. Nur lesend, LEFT JOIN, muss auch mit leerer
  Tabelle funktionieren.
- Skill-Suche im Verzeichnis: Kommunikation liest die Tabellen des
  Leistungs-Moduls — Spalten-Kontrakt: `skills(id, name)` und
  `employee_skills(employee_id, skill_id, level INTEGER 1–5)`. Das
  Leistungs-Modul MUSS exakt diese Namen/Spalten verwenden; Lesende müssen mit
  leeren Tabellen funktionieren (LEFT JOIN).
- Dokument-Uploads überall: `POST /api/files` (Core) → `files.id` in
  Modultabellen referenzieren; Download via `POST /api/files/:id/sign`.
- **Recruiting → Personal (Einstellung, Lebenszyklus-Brücke):**
  `POST /api/recruiting/applications/:id/hire` ist der **einzige** zugelassene
  Schreibzugriff eines Fachmoduls auf `employees` außerhalb des Personals. Es
  wird bewusst nur ein Stammdaten-Grundgerüst angelegt (Name, Kontakt, Orga aus
  der Stelle, Eintrittsdatum, Beschäftigungsart); Steuer/SV/Bank ergänzt die HR
  danach im Personal-Modul. Die Bewerbung verweist über
  `applications.converted_employee_id` auf den erzeugten Datensatz.
- **Führung → Personal (nur lesend):** Das Modul `leadership` liest
  `employees`, `departments`, `teams`, `roles` und `employee_roles` per SQL
  (Joins, keine Schreibzugriffe). Spalten-Kontrakt für die automatische
  Zuständigkeit: `employees.manager_id` (direkt unterstellt),
  `departments.head_employee_id` + `departments.parent_id` (Abteilungsleitung
  inklusive Unterabteilungen, rekursiv), `teams.lead_employee_id`
  (Teamleitung) sowie `employees.status = 'aktiv'`. Manuelle Zuweisungen
  (`leadership_assignments`) referenzieren diese Tabellen per Fremdschlüssel
  mit `ON DELETE CASCADE` — ein gelöschtes Ziel nimmt die Zuweisung mit, das
  Personal-Modul muss nichts davon wissen.

## 3. API-Stilregeln

- Feldnamen in Request/Response: **snake_case wie in der DB** (kein Mapping).
- Antworten sind Objekte mit benanntem Schlüssel: `{ employees: [...] }`,
  `{ request: {...} }` — nie nackte Arrays.
- Listen-Endpunkte akzeptieren Filter als Query-Parameter.
- Listen, die mit der Historie wachsen, blättern serverseitig über
  `core/paging.ts`: `limit` (höchstens 500, größere Werte werden gedeckelt),
  `offset` und optional `focus_id` (liefert die Seite, auf der dieser
  Datensatz steht). Mit `limit` trägt die Antwort zusätzlich `total` und den
  tatsächlichen `offset`; ohne `limit` bleibt die Route ungeblättert und
  liefert alle Treffer ihres Filters (darauf verlassen sich Personalakte,
  Genehmigungsliste und Tests). Ausgeblendet wird nichts, jede Zeile bleibt
  über die Seiten erreichbar.
- Mutationen auditieren, wo fachlich relevant (`core/audit.ts`).
- Fehler ausschließlich über `AppError`-Helfer (`core/errors.ts`), Meldungen deutsch.

## 4. Renderer-Regeln

- Pfad-Kontrakt: exakt die Pfade aus `layout/nav.ts` implementieren
  (`features/<modul>/routes.tsx` ersetzt die Platzhalter komplett).
- Gemeinsame Bausteine nutzen, nicht duplizieren: `components/ui.tsx`
  (Card, Field, Tabs, Badge, StatCard, PageHeader, EmptyState, Spinner, Avatar),
  `components/Modal.tsx`, `components/Toast.tsx`, `components/Popover.tsx`,
  `components/Tooltip.tsx`, `components/EmployeeSelect.tsx`,
  `components/Select.tsx`, `components/MultiSelect.tsx`,
  `components/FilePicker.tsx`, `components/ColorPicker.tsx`,
  `components/Pagination.tsx` (Seitenumschalter samt `usePageState`),
  CSS-Klassen `hm-*` aus `design/components.css`.
- Tooltips ausschließlich über `components/Tooltip.tsx`, nie per `title`-Attribut
  (Details und Begründung: CLAUDE.md → Konventionen → Tooltips). Inhalt als
  `.hm-tooltip__title` + `.hm-tooltip__line`, Werte mit „·“ getrennt.
- Datenzugriff über `api` aus `api/client.ts` + TanStack Query.
- **Keine neuen npm-Abhängigkeiten.** Verfügbar: react, react-router-dom,
  @tanstack/react-query, lucide-react, recharts, @ohrganize/shared.

## 5. Was Module NICHT anfassen

`router.tsx`, `layout/nav.ts`, `modules/index.ts`, `migrations/index.ts`,
`server.ts`, alle `package.json`, Core-Dateien (`core/*`, `db/db.ts`,
`db/migrate.ts`), `ADMIN_AREAS` in `shared/admin.ts` (ein neuer Rechtebereich
ist keine Modulsache: Er braucht zusätzlich einen Eintrag in `ROUTE_AREAS`
(`core/permissions.ts`) und eine Migration, die `admin_role_permissions` für
bestehende Rollen nachzieht — sonst fail closed für alle; Muster:
`310_leadership`) sowie fremde Modulordner. Erweiterung ausschließlich über
die in CLAUDE.md dokumentierten Erweiterungspunkte.

## 6. Modul-Selbsttest

Jedes Backend-Modul legt `src/modules/<modul>/smoke.ts` an (Muster:
`src/test/smoke.ts` — Wegwerf-DB via `OHRGANIZE_DATA_DIR`, `fastify.inject`,
Exit-Code ≠ 0 bei Fehlern) und hält ihn grün: `npx tsx src/modules/<modul>/smoke.ts`.
