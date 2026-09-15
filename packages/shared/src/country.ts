/**
 * Laender und Editionen als Datendimension.
 *
 * Das Land einer Installation kommt aus der Variante (Build), nicht aus
 * einer Kundeneinstellung; die Lizenz (ab v2) nennt Land und Edition, und
 * der Server prueft beides gegen seine Variante. Editionen sind bewusst
 * KEINE feste Liste: Welche Ausgaben es gibt (und wie sie heissen), legt
 * der Anbieter im Variantenregister fest (packages/shared/src/variants).
 * Hier steht nur das Muster, dem ein Editionsschluessel folgen muss.
 *
 * Regionen (Bundeslaender, Kantone), Sprachkennung und Waehrung stehen
 * ebenfalls hier und sind die EINZIGE Quelle dafuer. AT und CH haben heute
 * bewusst keinen Regionskatalog: Die Struktur steht, die Inhalte legt der
 * Anbieter fest, wenn ein Land verkauft wird.
 */

export const COUNTRY_CODES = ['DE', 'AT', 'CH'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export const COUNTRY_LABELS: Record<CountryCode, string> = {
  DE: 'Deutschland',
  AT: 'Österreich',
  CH: 'Schweiz',
};

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && (COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * Editionsschluessel: Kleinbuchstaben, Ziffern, Bindestrich, 1 bis 32
 * Zeichen, beginnt mit einem Buchstaben. Beispiele: `vollversion`, `basis`,
 * `enterprise`. Der Anzeigename steht im Variantenregister.
 */
export type Edition = string;
export const EDITION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && EDITION_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Regionen
// ---------------------------------------------------------------------------

/**
 * Regionscodes Deutschlands (Bundeslaender). Sie stehen in
 * `locations.bundesland` und steuern die Feiertagsberechnung.
 */
export const DE_REGION_CODES = [
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
  'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
] as const;
export type DeRegionCode = (typeof DE_REGION_CODES)[number];

/**
 * Regionscode als Datentyp: In der Datenbank ist das eine Zeichenkette, weil
 * das Schema variantenunabhaengig ist und dieselbe Spalte in jedem Land den
 * jeweiligen Katalog traegt. Geprueft wird gegen `REGIONS[country]`.
 */
export type RegionCode = string;

/**
 * Regionen je Land. DE ist gefuellt; AT und CH sind leer, bis der Anbieter
 * die Kataloge festlegt. Ein Land ohne Katalog akzeptiert als Regionswert
 * nur den Leerwert (siehe isRegionOf) und rechnet ohne regionale Feiertage.
 */
export const REGIONS = {
  DE: {
    BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg',
    HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern',
    NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz',
    SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein',
    TH: 'Thüringen',
  } as Record<DeRegionCode, string>,
  AT: {} as Record<RegionCode, string>,
  CH: {} as Record<RegionCode, string>,
} satisfies Record<CountryCode, Record<RegionCode, string>>;

/** Wie die Region im jeweiligen Land heisst (Formularbeschriftung). */
export const REGION_TERMS: Record<CountryCode, string> = {
  DE: 'Bundesland',
  AT: 'Bundesland',
  CH: 'Kanton',
};

/** Alle Regionscodes des Landes, in Katalogreihenfolge. */
export function regionCodesFor(country: CountryCode): RegionCode[] {
  return Object.keys(REGIONS[country]);
}

/** Regionen des Landes als Code-zu-Name-Abbildung (Auswahlfelder, API). */
export function regionsFor(country: CountryCode): Record<RegionCode, string> {
  return REGIONS[country] as Record<RegionCode, string>;
}

/**
 * Gehoert der Code zum Land? Ein Land ohne Regionskatalog akzeptiert nur den
 * Leerwert: Sonst liesse sich ein deutscher Code in einer AT-Installation
 * speichern und die Feiertagsrechnung liefe still auf fremdem Recht.
 */
export function isRegionOf(country: CountryCode, code: unknown): code is RegionCode {
  if (typeof code !== 'string') return false;
  const catalog = regionsFor(country);
  if (Object.keys(catalog).length === 0) return code === '';
  return Object.prototype.hasOwnProperty.call(catalog, code);
}

/** Anzeigename der Region; unbekannte Codes bleiben unveraendert sichtbar. */
export function regionLabel(country: CountryCode, code: RegionCode): string {
  return regionsFor(country)[code] ?? code;
}

// ---------------------------------------------------------------------------
// Sprachkennung und Waehrung
// ---------------------------------------------------------------------------

export const LOCALES: Record<CountryCode, string> = {
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
};

/** Waehrung je Land (ISO 4217). Die UI-Sprache bleibt in allen drei Laendern Deutsch. */
export const CURRENCIES: Record<CountryCode, string> = {
  DE: 'EUR',
  AT: 'EUR',
  CH: 'CHF',
};

export const DEFAULT_COUNTRY: CountryCode = 'DE';
export const DEFAULT_LOCALE = LOCALES[DEFAULT_COUNTRY];
export const DEFAULT_CURRENCY = CURRENCIES[DEFAULT_COUNTRY];

export function localeFor(country: CountryCode): string {
  return LOCALES[country];
}

export function currencyFor(country: CountryCode): string {
  return CURRENCIES[country];
}
