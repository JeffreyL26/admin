// Typen und reine Helfer des Moduls Führung & Bewertung.
//
// Führungskräfte (freigeschaltete Personalprofile mit Desktop-Konto) bewerten
// die ihnen zugeordneten Mitarbeitenden je Zeitraum auf einer zentral
// festgelegten Skala. Backend, Renderer und Smoke-Tests teilen sich hier die
// Skalen-Definitionen und die Zeitraum-Arithmetik — zwei Implementierungen
// derselben Quartalsgrenzen würden auseinanderlaufen, und genau daran hängt,
// ob eine Bewertung im richtigen Zeitraum landet.

// ---------------------------------------------------------------------------
// Bewertungszeitraum (Kadenz)
// ---------------------------------------------------------------------------

/** Wie oft bewertet wird — unternehmensweit (Standard: quartalsweise). */
export type RatingPeriodKind = 'monat' | 'quartal' | 'halbjahr' | 'jahr';

export const RATING_PERIOD_KINDS = ['monat', 'quartal', 'halbjahr', 'jahr'] as const;

export const RATING_PERIOD_LABELS: Record<RatingPeriodKind, string> = {
  monat: 'Monatlich',
  quartal: 'Quartalsweise',
  halbjahr: 'Halbjährlich',
  jahr: 'Jährlich',
};

/**
 * Ein konkreter Zeitraum. `key` ist der Speicherschlüssel in der Datenbank:
 *   monat    → "2026-09"      halbjahr → "2026-H2"
 *   quartal  → "2026-Q3"      jahr     → "2026"
 * `from`/`to` sind ISO-Daten (einschließlich), `label` die deutsche Anzeige.
 */
export interface RatingPeriod {
  key: string;
  kind: RatingPeriodKind;
  label: string;
  from: string;
  to: string;
}

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Letzter Tag eines Monats (1–12) als Zahl. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Zeitraum-Schlüssel für ein ISO-Datum in der gewünschten Kadenz. */
export function periodKeyForDate(iso: string, kind: RatingPeriodKind): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Ungültiges Datum: ${iso}`);
  }
  switch (kind) {
    case 'monat':
      return `${year}-${pad2(month)}`;
    case 'quartal':
      return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
    case 'halbjahr':
      return `${year}-H${month <= 6 ? 1 : 2}`;
    case 'jahr':
      return String(year);
  }
}

/** Erkennt die Kadenz eines Schlüssels; null bei unlesbarer Form. */
export function periodKindOfKey(key: string): RatingPeriodKind | null {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return 'monat';
  if (/^\d{4}-Q[1-4]$/.test(key)) return 'quartal';
  if (/^\d{4}-H[12]$/.test(key)) return 'halbjahr';
  if (/^\d{4}$/.test(key)) return 'jahr';
  return null;
}

export function isValidPeriodKey(key: string, kind?: RatingPeriodKind): boolean {
  const detected = periodKindOfKey(key);
  if (detected === null) return false;
  return kind === undefined || detected === kind;
}

/** Zerlegt einen Schlüssel in Kadenz, Grenzen und Anzeige. Wirft bei unlesbarer Form. */
export function periodFromKey(key: string): RatingPeriod {
  const kind = periodKindOfKey(key);
  if (kind === null) throw new Error(`Ungültiger Zeitraum: ${key}`);
  const year = Number(key.slice(0, 4));
  switch (kind) {
    case 'monat': {
      const month = Number(key.slice(5, 7));
      return {
        key, kind,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        from: `${year}-${pad2(month)}-01`,
        to: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      };
    }
    case 'quartal': {
      const q = Number(key.slice(6, 7));
      const first = (q - 1) * 3 + 1;
      const last = first + 2;
      return {
        key, kind,
        label: `Q${q} ${year}`,
        from: `${year}-${pad2(first)}-01`,
        to: `${year}-${pad2(last)}-${pad2(daysInMonth(year, last))}`,
      };
    }
    case 'halbjahr': {
      const h = Number(key.slice(6, 7));
      return {
        key, kind,
        label: `${h}. Halbjahr ${year}`,
        from: h === 1 ? `${year}-01-01` : `${year}-07-01`,
        to: h === 1 ? `${year}-06-30` : `${year}-12-31`,
      };
    }
    case 'jahr':
      return { key, kind, label: String(year), from: `${year}-01-01`, to: `${year}-12-31` };
  }
}

/** Nachbar-Zeitraum: delta = -1 ist der vorherige, +1 der nächste. */
export function shiftPeriod(key: string, delta: number): string {
  const p = periodFromKey(key);
  const year = Number(key.slice(0, 4));
  switch (p.kind) {
    case 'monat': {
      const index = year * 12 + (Number(key.slice(5, 7)) - 1) + delta;
      return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
    }
    case 'quartal': {
      const index = year * 4 + (Number(key.slice(6, 7)) - 1) + delta;
      return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
    }
    case 'halbjahr': {
      const index = year * 2 + (Number(key.slice(6, 7)) - 1) + delta;
      return `${Math.floor(index / 2)}-H${(index % 2) + 1}`;
    }
    case 'jahr':
      return String(year + delta);
  }
}

/** Der Zeitraum, in dem ein Datum liegt — als vollständiges Objekt. */
export function periodForDate(iso: string, kind: RatingPeriodKind): RatingPeriod {
  return periodFromKey(periodKeyForDate(iso, kind));
}

/** Die letzten `count` Zeiträume bis einschließlich `key`, neuester zuerst. */
export function recentPeriods(key: string, count: number): RatingPeriod[] {
  const list: RatingPeriod[] = [];
  let cursor = key;
  for (let i = 0; i < count; i++) {
    list.push(periodFromKey(cursor));
    cursor = shiftPeriod(cursor, -1);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Skalen
// ---------------------------------------------------------------------------

/**
 * Wählbare Skalen. Zentral festgelegt (Einstellung `scale`), damit jede
 * Führungskraft dieselbe Leistung auf derselben Skala bewertet. Gespeichert
 * wird je Bewertung der Skalenschlüssel UND der Rohwert `score` (1…max) —
 * so bleiben alte Bewertungen lesbar, wenn die Skala später umgestellt wird.
 */
export type RatingScaleKey = 'stars5' | 'ampel' | 'points10' | 'schulnote';

export const RATING_SCALE_KEYS = ['stars5', 'ampel', 'points10', 'schulnote'] as const;

export interface RatingScaleDef {
  key: RatingScaleKey;
  label: string;
  description: string;
  /** Höchster Rohwert; der niedrigste ist immer 1. */
  max: number;
  kind: 'stars' | 'ampel' | 'points' | 'grade';
  /** false bei Schulnoten: dort ist 1 die beste Stufe. */
  higherIsBetter: boolean;
  /** Beschriftung je Stufe (Index = score − 1), falls die Stufen Namen haben. */
  levelLabels?: string[];
}

export const RATING_SCALES: Record<RatingScaleKey, RatingScaleDef> = {
  stars5: {
    key: 'stars5',
    label: '5 Sterne',
    description: '1 bis 5 Sterne — 5 ist die beste Bewertung.',
    max: 5,
    kind: 'stars',
    higherIsBetter: true,
  },
  ampel: {
    key: 'ampel',
    label: 'Ampel (Rot / Gelb / Grün)',
    description: 'Drei Stufen: Rot (kritisch), Gelb (mit Einschränkungen), Grün (gut).',
    max: 3,
    kind: 'ampel',
    higherIsBetter: true,
    levelLabels: ['Rot', 'Gelb', 'Grün'],
  },
  points10: {
    key: 'points10',
    label: '1 bis 10 Punkte',
    description: '10 Punkte sind die beste Bewertung.',
    max: 10,
    kind: 'points',
    higherIsBetter: true,
  },
  schulnote: {
    key: 'schulnote',
    label: 'Schulnoten 1 bis 6',
    description: 'Note 1 (sehr gut) bis 6 (ungenügend).',
    max: 6,
    kind: 'grade',
    higherIsBetter: false,
    levelLabels: ['sehr gut', 'gut', 'befriedigend', 'ausreichend', 'mangelhaft', 'ungenügend'],
  },
};

/** Alle Stufen einer Skala, beste zuerst (für Report-Balken und Legenden). */
export function scaleLevelsBestFirst(scale: RatingScaleKey): number[] {
  const def = RATING_SCALES[scale];
  const levels = Array.from({ length: def.max }, (_, i) => i + 1);
  return def.higherIsBetter ? levels.reverse() : levels;
}

/** Kurzbeschriftung einer Stufe: „Grün“, „4 von 5“, „7 Punkte“, „Note 2“. */
export function scaleLevelLabel(scale: RatingScaleKey, score: number): string {
  const def = RATING_SCALES[scale];
  switch (def.kind) {
    case 'ampel':
      return def.levelLabels?.[score - 1] ?? String(score);
    case 'stars':
      return `${score} von ${def.max}`;
    case 'points':
      return score === 1 ? '1 Punkt' : `${score} Punkte`;
    case 'grade':
      return `Note ${score}`;
  }
}

/** 0…1, wobei 1 immer die beste Stufe ist — unabhängig von der Skalenrichtung. */
export function normalizedScore(scale: RatingScaleKey, score: number): number {
  const def = RATING_SCALES[scale];
  if (def.max <= 1) return 1;
  const clamped = Math.min(def.max, Math.max(1, score));
  const asc = (clamped - 1) / (def.max - 1);
  return def.higherIsBetter ? asc : 1 - asc;
}

/** Farbstufe einer Bewertung für Badges und Balken (Drittel-Schwellen). */
export type ScoreTone = 'green' | 'yellow' | 'red';

export function scoreTone(scale: RatingScaleKey, score: number): ScoreTone {
  const n = normalizedScore(scale, score);
  if (n >= 2 / 3) return 'green';
  if (n >= 1 / 3) return 'yellow';
  return 'red';
}

// ---------------------------------------------------------------------------
// Einstellungen und Kategorien
// ---------------------------------------------------------------------------

/**
 * Unternehmensweite Konfiguration (Tabelle `leadership_settings`, genau eine
 * Zeile). Integer-Felder sind SQLite-Booleans (0/1).
 */
export interface LeadershipSettings {
  period: RatingPeriodKind;
  /** 1 = alle Kategorien nutzen `scale`; 0 = Kategorien dürfen eigene Skala tragen. */
  uniform_scale: number;
  scale: RatingScaleKey;
  /** 1 = gegenseitige Verantwortung (A bewertet B und B bewertet A) ist zulässig. */
  allow_mutual: number;
  /** Automatische Zuordnung aus der Organisation — je Quelle abschaltbar. */
  auto_direct_reports: number;
  auto_department_head: number;
  auto_team_lead: number;
  updated_at: string;
}

export interface LeadershipSettingsPatch {
  period?: RatingPeriodKind;
  uniform_scale?: boolean;
  scale?: RatingScaleKey;
  allow_mutual?: boolean;
  auto_direct_reports?: boolean;
  auto_department_head?: boolean;
  auto_team_lead?: boolean;
}

/** Bewertungskategorie (zentral, für alle Führungskräfte gleich). */
export interface RatingCategory {
  id: number;
  name: string;
  description: string | null;
  sort_order: number;
  active: number;
  /** Genau eine Kategorie ist die Gesamtbewertung — Grundlage des Reports. */
  is_overall: number;
  /** Eigene Skala; nur wirksam, wenn `uniform_scale` = 0. */
  scale: RatingScaleKey | null;
  created_at: string;
  /** Angereichert: die tatsächlich zu verwendende Skala (Einstellung + Override). */
  effective_scale: RatingScaleKey;
  /** Angereichert: Anzahl vorhandener Bewertungen (steuert Löschbarkeit). */
  rating_count?: number;
}

export interface RatingCategoryInput {
  name: string;
  description?: string | null;
  scale?: RatingScaleKey | null;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Führungskräfte und Zuständigkeit
// ---------------------------------------------------------------------------

/** Woher eine Zuständigkeit stammt (eine Person kann mehrere Quellen haben). */
export type ScopeSource = 'direkt' | 'abteilung' | 'team' | 'zugewiesen';

export const SCOPE_SOURCE_LABELS: Record<ScopeSource, string> = {
  direkt: 'Direkt unterstellt',
  abteilung: 'Abteilungsleitung',
  team: 'Teamleitung',
  zugewiesen: 'Zugewiesen',
};

/** Freigeschaltete Führungskraft (Tabelle `leadership_leaders`). */
export interface Leader {
  employee_id: number;
  first_name: string;
  last_name: string;
  personnel_number: string | null;
  job_title: string | null;
  department_name: string | null;
  status: string;
  photo_file_id: number | null;
  /** 1 = Zuständigkeit automatisch aus der Organisation ableiten. */
  auto_scope: number;
  note: string | null;
  created_at: string;
  granted_by_name: string | null;
  /** Desktop-Konto der Person — null, wenn noch keins verknüpft ist. */
  user_id: number | null;
  user_email: string | null;
  /** Aktuell zuständig für so viele aktive Mitarbeitende. */
  team_size: number;
  /** Zahl manueller Zuweisungen (inkl. Ausschlüsse). */
  assignment_count: number;
}

export type AssignmentKind = 'include' | 'exclude';
export type AssignmentTargetType = 'employee' | 'department' | 'team' | 'role';

export const ASSIGNMENT_KIND_LABELS: Record<AssignmentKind, string> = {
  include: 'Zusätzlich zuständig',
  exclude: 'Ausgenommen',
};

export const ASSIGNMENT_TARGET_LABELS: Record<AssignmentTargetType, string> = {
  employee: 'Person',
  department: 'Abteilung',
  team: 'Team',
  role: 'Fachrolle',
};

/**
 * Manuelle Zuweisung für komplexe oder fluide Strukturen: eine Person,
 * Abteilung, ein Team oder alle Mitglieder einer Fachrolle — optional
 * zeitlich begrenzt (Projekt, Vertretung). `exclude` nimmt Personen aus der
 * automatischen Ableitung heraus.
 */
export interface LeadershipAssignment {
  id: number;
  leader_employee_id: number;
  kind: AssignmentKind;
  target_type: AssignmentTargetType;
  target_id: number;
  target_name: string;
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  created_at: string;
  created_by_name: string | null;
}

export interface LeadershipAssignmentInput {
  kind: AssignmentKind;
  target_type: AssignmentTargetType;
  target_id: number;
  valid_from?: string | null;
  valid_to?: string | null;
  note?: string | null;
}

/** Mitglied im Zuständigkeitsbereich einer Führungskraft — mit Stammdaten fürs Widget. */
export interface TeamMember {
  id: number;
  first_name: string;
  last_name: string;
  personnel_number: string | null;
  job_title: string | null;
  employee_type: string;
  status: string;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
  hire_date: string | null;
  email: string | null;
  phone: string | null;
  photo_file_id: number | null;
  /** Kurzlebig signierte URL (core/files.ts) — sofort konsumieren, nicht cachen. */
  photo_url: string | null;
  sources: ScopeSource[];
  /** 1 = die Person ist ihrerseits für diese Führungskraft zuständig. */
  mutual: number;
  /** Gesamtbewertung im angefragten Zeitraum, falls vorhanden. */
  overall: { score: number; scale: RatingScaleKey } | null;
  /** Anzahl bewerteter Kategorien im angefragten Zeitraum. */
  rated_categories: number;
  /** Letzte Speicherung (Zeitstempel) im angefragten Zeitraum. */
  last_rated_at: string | null;
}

// ---------------------------------------------------------------------------
// Bewertungen und Protokoll
// ---------------------------------------------------------------------------

export interface Rating {
  id: number;
  leader_employee_id: number;
  employee_id: number;
  category_id: number;
  category_name: string;
  period_kind: RatingPeriodKind;
  period_key: string;
  scale: RatingScaleKey;
  score: number;
  comment: string;
  version: number;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  /** Nur in Admin-Antworten (GET /api/leadership/employees/:id/ratings). */
  leader_name?: string | null;
}

/** Eingabe eines Bewertungsblocks (Kategorie + Wert + Pflichtkommentar). */
export interface RatingInput {
  category_id: number;
  score: number;
  comment: string;
}

export interface RatingsSaveRequest {
  period_key: string;
  ratings: RatingInput[];
}

/**
 * Unveränderliche Protokollzeile (Tabelle `leadership_rating_history`).
 * Jede Speicherung — auch eine Korrektur — erzeugt eine neue Version.
 */
export interface RatingHistoryEntry {
  id: number;
  rating_id: number;
  employee_id: number;
  leader_employee_id: number;
  category_id: number;
  category_name: string;
  period_key: string;
  version: number;
  change_kind: 'erstellt' | 'geaendert';
  scale: RatingScaleKey;
  score: number;
  comment: string;
  previous_score: number | null;
  previous_comment: string | null;
  changed_at: string;
  changed_by_name: string | null;
}

// ---------------------------------------------------------------------------
// API-Antworten
// ---------------------------------------------------------------------------

/** GET /api/leadership/me/status — für jedes Admin-Konto beantwortbar. */
export interface LeaderStatus {
  is_leader: boolean;
  employee_id: number | null;
  period: RatingPeriod | null;
  team_size: number;
  /** Personen mit Gesamtbewertung im aktuellen Zeitraum. */
  rated_count: number;
}

/** GET /api/leadership/me/team?period=… */
export interface MyTeamResponse {
  period: RatingPeriod;
  /** Aktueller Zeitraum laut Einstellung (zum Zurückspringen). */
  current_period: RatingPeriod;
  settings: Pick<LeadershipSettings, 'period' | 'uniform_scale' | 'scale'>;
  /** Nur aktive Kategorien, in Sortierreihenfolge, Gesamtbewertung zuerst. */
  categories: RatingCategory[];
  team: TeamMember[];
}

/** GET /api/leadership/me/employees/:id?period=… */
export interface TeamMemberDetailResponse {
  employee: TeamMember;
  period: RatingPeriod;
  current_period: RatingPeriod;
  /** Wählbare Zeiträume: aktueller, die letzten zwölf sowie alle mit Bewertungen. */
  periods: RatingPeriod[];
  settings: Pick<LeadershipSettings, 'period' | 'uniform_scale' | 'scale'>;
  categories: RatingCategory[];
  /** Bewertungen dieser Führungskraft für die Person im angefragten Zeitraum. */
  ratings: Rating[];
  /** Alle Bewertungen dieser Führungskraft für die Person (alle Zeiträume). */
  all_ratings: Rating[];
  /** Vollständiges Protokoll, neueste Änderung zuerst. */
  history: RatingHistoryEntry[];
}

/** GET /api/leadership/leaders/:employeeId/team — Vorschau der Zuständigkeit. */
export interface LeaderTeamResponse {
  leader: Leader;
  team: TeamMember[];
  assignments: LeadershipAssignment[];
  /** Personen, die ihrerseits für diese Führungskraft zuständig sind. */
  mutual: { employee_id: number; first_name: string; last_name: string }[];
}

export interface AssignmentCreateResponse {
  assignment: LeadershipAssignment;
  /** Hinweise, z. B. entstandene gegenseitige Verantwortung. */
  warnings: string[];
}

/** POST /api/leadership/leaders */
export interface LeaderCreateResponse {
  leader: Leader;
  warnings: string[];
}

/** GET /api/leadership/employees/:id/ratings — Admin-Sicht auf eine Person. */
export interface EmployeeRatingsResponse {
  ratings: Rating[];
  history: RatingHistoryEntry[];
}

/** Verteilung der Gesamtbewertung einer Führungskraft im Zeitraum. */
export interface ReportDistributionEntry {
  score: number;
  label: string;
  tone: ScoreTone;
  count: number;
  /** Anteil an den bewerteten Personen, gerundet auf ganze Prozent. */
  percent: number;
}

export interface ReportLeaderRow {
  employee_id: number;
  first_name: string;
  last_name: string;
  job_title: string | null;
  department_name: string | null;
  photo_file_id: number | null;
  photo_url: string | null;
  /** Aktive Mitarbeitende im Zuständigkeitsbereich. */
  team_size: number;
  /** Davon mit Gesamtbewertung im Zeitraum (auf der Report-Skala). */
  rated_count: number;
  distribution: ReportDistributionEntry[];
  /** Mittelwert der normierten Werte (0…1), null ohne Bewertungen. */
  average_normalized: number | null;
  /** Bewertungen auf einer anderen als der aktuellen Skala (nach Umstellung). */
  other_scale_count: number;
}

/** GET /api/leadership/report?period=… */
export interface LeadershipReport {
  period: RatingPeriod;
  current_period: RatingPeriod;
  category: RatingCategory;
  scale: RatingScaleKey;
  leaders: ReportLeaderRow[];
}
