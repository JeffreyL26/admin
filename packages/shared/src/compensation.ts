// Typen des Moduls Vergütung.

/** Arten von Gehaltskomponenten. `stundenlohn`: amount_cents = Cent je Stunde. */
export type SalaryComponentKind =
  | 'grundgehalt'
  | 'stundenlohn'
  | 'zulage_schicht'
  | 'zulage_erschwernis'
  | 'zulage_funktion'
  | 'sachbezug_dienstwagen'
  | 'sachbezug_jobticket'
  | 'sachbezug_essenszuschuss'
  | 'vwl'
  | 'bav_entgeltumwandlung'
  | 'abzug_sonstig';

export const SALARY_COMPONENT_KINDS: SalaryComponentKind[] = [
  'grundgehalt',
  'stundenlohn',
  'zulage_schicht',
  'zulage_erschwernis',
  'zulage_funktion',
  'sachbezug_dienstwagen',
  'sachbezug_jobticket',
  'sachbezug_essenszuschuss',
  'vwl',
  'bav_entgeltumwandlung',
  'abzug_sonstig',
];

export const SALARY_COMPONENT_LABELS: Record<SalaryComponentKind, string> = {
  grundgehalt: 'Grundgehalt',
  stundenlohn: 'Stundenlohn',
  zulage_schicht: 'Schichtzulage',
  zulage_erschwernis: 'Erschwerniszulage',
  zulage_funktion: 'Funktionszulage',
  sachbezug_dienstwagen: 'Sachbezug Dienstwagen',
  sachbezug_jobticket: 'Sachbezug Jobticket',
  sachbezug_essenszuschuss: 'Sachbezug Essenszuschuss',
  vwl: 'Vermögenswirksame Leistungen',
  bav_entgeltumwandlung: 'bAV-Entgeltumwandlung',
  abzug_sonstig: 'Sonstiger Abzug',
};

/** Komponenten, die das Monatsbrutto mindern (Entgeltumwandlung, Abzüge). */
export const SALARY_DEDUCTION_KINDS: SalaryComponentKind[] = [
  'bav_entgeltumwandlung',
  'abzug_sonstig',
];

export type SalaryChangeStatus = 'beantragt' | 'genehmigt' | 'abgelehnt';

export const SALARY_CHANGE_STATUS_LABELS: Record<SalaryChangeStatus, string> = {
  beantragt: 'Beantragt',
  genehmigt: 'Genehmigt',
  abgelehnt: 'Abgelehnt',
};

export type BonusKind = 'zielbonus' | 'provision' | 'einmalzahlung';

export const BONUS_KIND_LABELS: Record<BonusKind, string> = {
  zielbonus: 'Zielbonus',
  provision: 'Provision',
  einmalzahlung: 'Einmalzahlung',
};

export type BonusStatus = 'geplant' | 'freigegeben' | 'ausgezahlt';

export const BONUS_STATUS_LABELS: Record<BonusStatus, string> = {
  geplant: 'Geplant',
  freigegeben: 'Freigegeben',
  ausgezahlt: 'Ausgezahlt',
};

export type PayrollRunStatus = 'offen' | 'geprueft' | 'exportiert';

export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  offen: 'Offen',
  geprueft: 'Geprüft',
  exportiert: 'Exportiert',
};

/** Bewegungs-Flags an einem Abrechnungs-Item. */
export type PayrollFlag =
  | 'neueintritt'
  | 'austritt'
  | 'gehaltsaenderung'
  | 'unbezahlte_abwesenheit'
  | 'lohnfortzahlung_ende';

export const PAYROLL_FLAG_LABELS: Record<PayrollFlag, string> = {
  neueintritt: 'Neueintritt',
  austritt: 'Austritt',
  gehaltsaenderung: 'Gehaltsänderung',
  unbezahlte_abwesenheit: 'Unbezahlte Abwesenheit',
  lohnfortzahlung_ende: 'Ende Lohnfortzahlung (> 42 Tage)',
};

export type FreelancerRateUnit = 'stunde' | 'tag' | 'pauschale';

export const FREELANCER_RATE_UNIT_LABELS: Record<FreelancerRateUnit, string> = {
  stunde: 'je Stunde',
  tag: 'je Tag',
  pauschale: 'Pauschale',
};

export type FreelancerInvoiceStatus = 'offen' | 'geprueft' | 'bezahlt';

export const FREELANCER_INVOICE_STATUS_LABELS: Record<FreelancerInvoiceStatus, string> = {
  offen: 'Offen',
  geprueft: 'Geprüft',
  bezahlt: 'Bezahlt',
};

export type CertificateKind =
  | 'lohnsteuerbescheinigung'
  | 'arbeitgeberbescheinigung'
  | 'entgeltbescheinigung_108';

export const CERTIFICATE_KIND_LABELS: Record<CertificateKind, string> = {
  lohnsteuerbescheinigung: 'Lohnsteuerbescheinigung',
  arbeitgeberbescheinigung: 'Arbeitgeberbescheinigung',
  entgeltbescheinigung_108: 'Entgeltbescheinigung (§ 108 GewO)',
};

export type CertificateStatus = 'angefordert' | 'erstellt' | 'ausgehaendigt';

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  angefordert: 'Angefordert',
  erstellt: 'Erstellt',
  ausgehaendigt: 'Ausgehändigt',
};

/**
 * Minijob-Verdienstgrenze (monatlich, Integer-Cent).
 * Stand 2026: 556 € — dynamische Geringfügigkeitsgrenze, gekoppelt an den
 * Mindestlohn (Wert seit 01.01.2025 unverändert 556 €).
 */
export const MINIJOB_LIMIT_CENTS = 55600;

/**
 * Vereinfachte Monatswert-Umrechnung für Stundenlohn:
 * Cent/Stunde × Wochenstunden × 4,33 (Durchschnittswochen je Monat).
 */
export const HOURLY_MONTH_FACTOR = 4.33;
