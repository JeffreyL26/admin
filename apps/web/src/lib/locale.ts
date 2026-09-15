/**
 * Sprachkennung, Waehrung und Regionen der Installation.
 *
 * Das Land kommt aus der Variante (Build), nicht aus einer Kundeneinstellung:
 * Kataloge, Feiertagsrecht und Exporte haengen am Build. Neue oder angefasste
 * Dateien formatieren ueber LOCALE statt ueber die Zeichenkette 'de-DE',
 * damit eine AT- oder CH-Ausgabe nicht an zwoelf Stellen nachgezogen werden
 * muss.
 */
import { CURRENCIES, LOCALES, REGION_TERMS, regionsFor } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';

export const COUNTRY = VARIANT.country;
export const LOCALE = LOCALES[COUNTRY];
export const CURRENCY = CURRENCIES[COUNTRY];

/** Regionen des Landes (Auswahlfelder). Leer, solange ein Land keinen Katalog hat. */
export const REGIONS = regionsFor(COUNTRY);

/** Wie die Region hier heisst: "Bundesland" bzw. "Kanton". */
export const REGION_TERM = REGION_TERMS[COUNTRY];

export const REGION_CODES = Object.keys(REGIONS);

/**
 * Vorauswahl in Formularen: die erste Region des Katalogs. Leer, wenn das
 * Land keinen Katalog hat; das Backend nimmt dann ebenfalls nur den Leerwert
 * an (country.ts isRegionOf).
 */
export const DEFAULT_REGION = REGION_CODES[0] ?? '';
