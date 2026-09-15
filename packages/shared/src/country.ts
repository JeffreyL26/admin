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
 * Regionen, Feiertage, Kataloge und Formatierung je Land folgen in Phase 5;
 * AT und CH bekommen Strukturen, keine Inhalte.
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
