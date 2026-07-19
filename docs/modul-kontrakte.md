# Modul-Kontrakte (für die parallele Modulentwicklung)

Diese Kontrakte sind stabil. Module verlassen sich aufeinander **nur** über die
hier beschriebenen Schnittstellen — alles andere ist modulintern.

## 1. Kerntabellen (Migration `100_employees_core`, bereits vorhanden)

- `employees` — Stammdaten inkl. `employee_type`, `status` ('aktiv'|'ausgeschieden'),
  `department_id`, `team_id`, `location_id`, `manager_id`, `hire_date`, `exit_date`,
  `weekly_hours`, `annual_leave_days`, `photo_file_id`. Vollständige Spaltenliste in
  `backend/src/db/migrations/100_employees.ts`.
- `departments` (mit `parent_id`-Hierarchie), `teams`, `locations` (mit `bundesland`).
- Andere Module dürfen per SQL **lesend joinen** und Fremdschlüssel auf diese
  Tabellen anlegen. Schreibzugriffe nur durch das Personal-Modul — mit **einer
  dokumentierten Ausnahme**: die Einstellung im Recruiting-Modul (siehe §2).

## 2. API-Kontrakte zwischen Modulen

- `GET /api/employees?fields=lite&status=aktiv&search=…` (Personal-Modul) →
  `{ employees: [{ id, first_name, last_name, employee_type, status, job_title,
  department_id, team_id, location_id }] }`. Wird vom gemeinsamen
  `EmployeeSelect`/`useEmployees` (Renderer) benutzt.
- Feiertage: `GET /api/holidays/:year/:land` (Core, fertig). Backend-intern:
  `core/holidays.ts`. Bundesland eines Mitarbeitenden: `locations.bundesland`,
  Fallback `getSetting('defaultBundesland')`.
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

## 3. API-Stilregeln

- Feldnamen in Request/Response: **snake_case wie in der DB** (kein Mapping).
- Antworten sind Objekte mit benanntem Schlüssel: `{ employees: [...] }`,
  `{ request: {...} }` — nie nackte Arrays.
- Listen-Endpunkte akzeptieren Filter als Query-Parameter.
- Mutationen auditieren, wo fachlich relevant (`core/audit.ts`).
- Fehler ausschließlich über `AppError`-Helfer (`core/errors.ts`), Meldungen deutsch.

## 4. Renderer-Regeln

- Pfad-Kontrakt: exakt die Pfade aus `layout/nav.ts` implementieren
  (`features/<modul>/routes.tsx` ersetzt die Platzhalter komplett).
- Gemeinsame Bausteine nutzen, nicht duplizieren: `components/ui.tsx`
  (Card, Field, Tabs, Badge, StatCard, PageHeader, EmptyState, Spinner, Avatar),
  `components/Modal.tsx`, `components/Toast.tsx`, `components/EmployeeSelect.tsx`,
  CSS-Klassen `hm-*` aus `design/components.css`.
- Datenzugriff über `api` aus `api/client.ts` + TanStack Query.
- **Keine neuen npm-Abhängigkeiten.** Verfügbar: react, react-router-dom,
  @tanstack/react-query, lucide-react, recharts, @hrmonic/shared.

## 5. Was Module NICHT anfassen

`router.tsx`, `layout/nav.ts`, `modules/index.ts`, `migrations/index.ts`,
`server.ts`, alle `package.json`, Core-Dateien (`core/*`, `db/db.ts`,
`db/migrate.ts`) sowie fremde Modulordner. Erweiterung ausschließlich über die
in CLAUDE.md dokumentierten Erweiterungspunkte.

## 6. Modul-Selbsttest

Jedes Backend-Modul legt `src/modules/<modul>/smoke.ts` an (Muster:
`src/test/smoke.ts` — Wegwerf-DB via `HRMONIC_DATA_DIR`, `fastify.inject`,
Exit-Code ≠ 0 bei Fehlern) und hält ihn grün: `npx tsx src/modules/<modul>/smoke.ts`.
