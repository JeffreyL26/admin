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

/** Braucht diese Staatsangehoerigkeit einen Aufenthaltstitel? Ohne Angabe: nein. */
export function needsResidencePermit(nationality: string | null | undefined): boolean {
  return !!nationality && !(FREE_MOVEMENT_COUNTRIES as readonly string[]).includes(nationality);
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
