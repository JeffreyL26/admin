/**
 * Staatsangehoerigkeit und Aufenthaltstitel einer Person (Stammdaten).
 *
 * Laender als ISO-3166-1-alpha-2. Die Namen kommen aus Intl.DisplayNames
 * (deutsch), damit hier keine zweite Laenderliste gepflegt wird; die Codes
 * selbst stehen fest, weil Backend und Formular gegen dieselbe Liste pruefen.
 */

/** Alle offiziell vergebenen ISO-3166-1-alpha-2-Codes (Stand 2026). */
export const NATIONALITY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;
export type NationalityCode = (typeof NATIONALITY_CODES)[number];

/**
 * Staatsangehoerigkeiten mit Freizuegigkeit fuer die Beschaeftigung in
 * Deutschland: EU, dazu Island, Liechtenstein, Norwegen (EWR) und die Schweiz.
 * Fuer sie braucht es keinen Aufenthaltstitel; das Formular blendet das Feld aus.
 */
export const FREE_MOVEMENT_COUNTRIES: readonly NationalityCode[] = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT',
  'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO', 'CH',
];

let regionNames: Intl.DisplayNames | null | undefined;

/** Deutscher Laendername zum Code; ohne Intl-Daten der Code selbst. */
export function nationalityLabel(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['de'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames?.of(code) ?? code;
}

/** Weitere Staatsangehoerigkeiten, gespeichert wie die Arbeitstage ("TR,US"), als Liste. */
export function parseNationalities(value: string | null | undefined): string[] {
  return value ? value.split(',').map((code) => code.trim()).filter(Boolean) : [];
}

/** Alle Staatsangehoerigkeiten einer Person ohne Doppel, die erste vorn. */
export function nationalitiesOf(nationality: string | null | undefined, further: string | null | undefined): string[] {
  return [...new Set([nationality ?? '', ...parseNationalities(further)].filter(Boolean))];
}

/** Hoechstzahl weiterer Staatsangehoerigkeiten (Pruefung im Backend, Grenze im Formular). */
export const MAX_FURTHER_NATIONALITIES = 10;

/**
 * Gespeicherte Form: die erste in `nationality`, weitere als "TR,US" ohne
 * Doppel, ohne die erste und nach Laendercode sortiert (gleiche Menge, gleicher
 * Wert: sonst zaehlte eine andere Reihenfolge als Aenderung), leer = null.
 * Fehlt die erste, rueckt die erste der weiteren in der uebergebenen
 * Reihenfolge nach. Backend (POST, PATCH) und Formular rechnen gleich.
 */
export function settleNationalities(
  nationality: string | null | undefined,
  further: string | null | undefined,
): { nationality: string | null; further_nationalities: string | null } {
  const all = nationalitiesOf(nationality, further);
  return { nationality: all[0] ?? null, further_nationalities: all.length > 1 ? all.slice(1).sort().join(',') : null };
}

/** Anzeige aller Staatsangehoerigkeiten, z. B. "Türkei, Deutschland"; ohne Angabe null. */
export function nationalitiesLabel(nationality: string | null | undefined, further: string | null | undefined): string | null {
  const all = nationalitiesOf(nationality, further);
  return all.length ? all.map(nationalityLabel).join(', ') : null;
}

/**
 * Bringt eine der Staatsangehoerigkeiten Freizuegigkeit (EU, EWR, Schweiz)?
 * Dann gibt es keinen Aufenthaltstitel. Ohne Angabe: nein (unbekannt ist
 * nicht dasselbe wie frei). Die EINE Regel fuer das Leeren eines
 * gespeicherten Titels, im Formular (formToPayload) wie im Server
 * (settleNationalityFields).
 */
export function hasFreeMovement(nationality: string | null | undefined, further?: string | null): boolean {
  return nationalitiesOf(nationality, further).some((code) => (FREE_MOVEMENT_COUNTRIES as readonly string[]).includes(code));
}

/**
 * Braucht die Person einen Aufenthaltstitel? Nur, wenn keine ihrer
 * Staatsangehoerigkeiten Freizuegigkeit bringt; eine aus EU, EWR oder Schweiz
 * neben einer anderen genuegt. Ohne Angabe: nein.
 */
export function needsResidencePermit(nationality: string | null | undefined, further?: string | null): boolean {
  return nationalitiesOf(nationality, further).length > 0 && !hasFreeMovement(nationality, further);
}

/**
 * Gespeicherte Felder des Aufenthaltstitels: Bringt eine der
 * Staatsangehoerigkeiten Freizuegigkeit, sind beide leer, sonst bleiben sie,
 * wie sie sind (auch ohne erfasste Staatsangehoerigkeit). Das Formular
 * (formToPayload) rechnet damit; der Server leert nach derselben Regel
 * (hasFreeMovement in settleNationalityFields), setzt aber nur Felder, die
 * sich aendern.
 */
export function residencePermitFields<P, U>(
  nationality: string | null | undefined,
  further: string | null | undefined,
  permit: P,
  until: U,
): { residence_permit: P | null; residence_permit_until: U | null } {
  return hasFreeMovement(nationality, further)
    ? { residence_permit: null, residence_permit_until: null }
    : { residence_permit: permit, residence_permit_until: until };
}

/**
 * Zeigt das Formular die Felder des Aufenthaltstitels? Wenn er noetig ist
 * (nur Staatsangehoerigkeiten ausserhalb von EU, EWR und Schweiz) oder, ohne
 * erfasste Staatsangehoerigkeit, wenn schon einer eingetragen ist. Sonst
 * stuende ein gespeicherter Titel unsichtbar im Formular, waehrend das
 * Dashboard vor seinem Ablauf warnt.
 */
export function residencePermitShown(
  nationality: string | null | undefined,
  further: string | null | undefined,
  permit: string | null | undefined,
  until: string | null | undefined,
): boolean {
  if (needsResidencePermit(nationality, further)) return true;
  return !hasFreeMovement(nationality, further) && Boolean(permit || until);
}

/**
 * Art des Aufenthaltstitels (AufenthG), nur fuer Staatsangehoerige ausserhalb
 * von EU, EWR und Schweiz. Die Auswahl deckt die haeufigen Faelle der
 * Beschaeftigung ab; alles andere ist `sonstiges` mit Notiz in der Akte.
 */
export const RESIDENCE_PERMIT_TYPES = [
  'aufenthaltserlaubnis_beschaeftigung',
  'blaue_karte_eu',
  'chancenkarte',
  'aufenthaltserlaubnis_ausbildung',
  'aufenthaltserlaubnis_studium',
  'ict_karte',
  'aufenthaltserlaubnis_familie',
  'aufenthaltserlaubnis_humanitaer',
  'niederlassungserlaubnis',
  'daueraufenthalt_eu',
  'aufenthaltsgestattung',
  'duldung',
  'visum',
  'sonstiges',
] as const;
export type ResidencePermitType = (typeof RESIDENCE_PERMIT_TYPES)[number];

export const RESIDENCE_PERMIT_LABELS: Record<ResidencePermitType, string> = {
  aufenthaltserlaubnis_beschaeftigung: 'Aufenthaltserlaubnis zur Beschäftigung (§§ 18a, 18b, 19c AufenthG)',
  blaue_karte_eu: 'Blaue Karte EU (§ 18g AufenthG)',
  chancenkarte: 'Chancenkarte (§ 20a AufenthG)',
  aufenthaltserlaubnis_ausbildung: 'Aufenthaltserlaubnis zur Berufsausbildung (§ 16a AufenthG)',
  aufenthaltserlaubnis_studium: 'Aufenthaltserlaubnis zum Studium (§ 16b AufenthG)',
  ict_karte: 'ICT-Karte (§ 19 AufenthG)',
  aufenthaltserlaubnis_familie: 'Aufenthaltserlaubnis aus familiären Gründen (§§ 27 ff. AufenthG)',
  aufenthaltserlaubnis_humanitaer: 'Aufenthaltserlaubnis aus humanitären Gründen (§§ 22 ff. AufenthG)',
  niederlassungserlaubnis: 'Niederlassungserlaubnis (§§ 9, 18c AufenthG)',
  daueraufenthalt_eu: 'Erlaubnis zum Daueraufenthalt EU (§ 9a AufenthG)',
  aufenthaltsgestattung: 'Aufenthaltsgestattung (§ 55 AsylG)',
  duldung: 'Duldung (§ 60a AufenthG)',
  visum: 'Visum (§ 6 AufenthG)',
  sonstiges: 'Sonstiger Titel',
};

/** Tage vor Ablauf eines Aufenthaltstitels, ab denen Personalakte und Dashboard warnen. */
export const RESIDENCE_PERMIT_WARN_DAYS = 90;
