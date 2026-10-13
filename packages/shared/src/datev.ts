// Regeln des DATEV-Lohnexports, die ohne Datenbank und DOM auskommen:
// Programme, Lohnart-Schluessel, Pruefziffern, Wertelisten und die Einordnung
// einer Position (Festbezug, Bruttobezug, Nettoabzug, Stunden). Backend
// (Adapter und Pruefbericht), Desktop-App (Einstellungen, Exportdialog) und
// Tests lesen alle von hier; Quelle der Feldnamen ist das DATEV
// Schnittstellenhandbuch LODAS (SSH, Fach 3 und 4), Hintergrund in
// docs/datev-lohnexport.md.
import type { BonusKind, SalaryComponentKind } from './compensation.js';
import { centsToDecimal } from './common.js';
import { SALARY_COMPONENT_KINDS, SALARY_COMPONENT_LABELS, BONUS_KIND_LABELS } from './compensation.js';
import type { ChurchTax, EmployeeType, TaxClass } from './employees.js';

/** Lohnprogramm des Lohnbueros. LODAS liest Textdateien mit Satzbeschreibung, Lohn und Gehalt eine Spaltendatei. */
export type DatevProgram = 'lodas' | 'lug';

export const DATEV_PROGRAMS: DatevProgram[] = ['lodas', 'lug'];

export const DATEV_PROGRAM_LABELS: Record<DatevProgram, string> = {
  lodas: 'DATEV LODAS',
  lug: 'DATEV Lohn und Gehalt',
};

/** Was eine Exportdatei enthaelt. Stammdaten gibt es nur fuer LODAS. */
export type DatevExportKind = 'bewegungsdaten' | 'stammdaten';

export const DATEV_EXPORT_KIND_LABELS: Record<DatevExportKind, string> = {
  bewegungsdaten: 'Bewegungsdaten des Monats',
  stammdaten: 'Personalstammdaten und Festbezüge',
};

/** Umfang des Stammdatenexports. */
export type DatevStammdatenScope = 'aenderungen' | 'alle';

export const DATEV_STAMMDATEN_SCOPE_LABELS: Record<DatevStammdatenScope, string> = {
  aenderungen: 'Nur Neueintritte, Austritte und Gehaltsänderungen des Monats',
  alle: 'Alle Personen des Laufs',
};

/**
 * Wie wiederkehrende Bezuege (Gehalt, Zulagen, Sachbezuege, VWL, bAV, Abzuege)
 * zum Lohnbuero gelangen. `stammdaten` ist der Weg, den LODAS vorsieht:
 * Festbezuege sind Stammdaten und werden jeden Monat automatisch gezahlt;
 * die Bewegungsdaten tragen dann nur Einmalzahlungen, Stunden und Fehlzeiten.
 * `bewegungsdaten` bucht sie jeden Monat als Bruttobezug und ist nur richtig,
 * wenn das Lohnbuero KEINE Festbezuege pflegt (sonst doppelt).
 */
export type DatevFestbezuegeMode = 'stammdaten' | 'bewegungsdaten';

export const DATEV_FESTBEZUEGE_MODE_LABELS: Record<DatevFestbezuegeMode, string> = {
  stammdaten: 'Als Festbezüge über die Stammdaten (Vorgabe)',
  bewegungsdaten: 'Jeden Monat als Buchung in den Bewegungsdaten',
};

/** Schluessel einer Lohnart-Zuordnung: Gehaltskomponenten und Bonusarten. */
export type DatevLohnartKey = SalaryComponentKind | `bonus_${BonusKind}`;

export const DATEV_LOHNART_KEYS: DatevLohnartKey[] = [
  ...SALARY_COMPONENT_KINDS,
  'bonus_zielbonus',
  'bonus_provision',
  'bonus_einmalzahlung',
];

export const DATEV_LOHNART_LABELS: Record<DatevLohnartKey, string> = {
  ...SALARY_COMPONENT_LABELS,
  bonus_zielbonus: `Bonus: ${BONUS_KIND_LABELS.zielbonus}`,
  bonus_provision: `Bonus: ${BONUS_KIND_LABELS.provision}`,
  bonus_einmalzahlung: `Bonus: ${BONUS_KIND_LABELS.einmalzahlung}`,
};

/**
 * Vorschlaege fuer die Lohnartennummern. LODAS liefert keinen festen Katalog;
 * das Lohnbuero legt die eigenen Nummern fest, die Einstellungen muessen
 * dazu passen. Die Einstellungsseite belegt ihre Felder damit vor; GELTEN
 * tut eine Nummer erst, wenn sie gespeichert ist. Ein Schluessel ohne
 * gespeicherte Nummer sperrt den Export (kein stiller Rueckfall auf einen
 * Vorschlag oder eine Sammelnummer, auch nicht fuer eine Position, die eine
 * spaetere Fassung neu einfuehrt). Der sonstige Abzug hat keinen Vorschlag:
 * In den LODAS-Stammdaten ist er eine Nettobe-/abzugsnummer des Mandanten
 * (1 bis 2 Stellen), die nur das Lohnbuero kennt.
 */
export const DATEV_LOHNART_DEFAULTS: Record<DatevLohnartKey, string> = {
  grundgehalt: '200',
  stundenlohn: '300',
  zulage_schicht: '210',
  zulage_erschwernis: '211',
  zulage_funktion: '212',
  sachbezug_dienstwagen: '860',
  sachbezug_jobticket: '861',
  sachbezug_essenszuschuss: '862',
  vwl: '510',
  bav_entgeltumwandlung: '590',
  abzug_sonstig: '',
  bonus_zielbonus: '400',
  bonus_provision: '410',
  bonus_einmalzahlung: '420',
};

/**
 * Wie LODAS eine Position fuehrt:
 * - festbezug: Stammdaten u_lod_psd_festbezuege (monatlich wiederkehrend)
 * - stundenlohn: Stundensatz in den Stammdaten (u_lod_psd_lohn_festbezuege,
 *   std_lohn_1), Stunden als Buchung mit Bearbeitungsschluessel 1
 * - nettoabzug: Stammdaten u_lod_psd_nettobeabzug, als Buchung
 *   Bearbeitungsschluessel 3
 * - einmalbezug: nur Bewegungsdaten, Bearbeitungsschluessel 2 (Bruttobezug)
 */
export type LodasPositionKind = 'festbezug' | 'stundenlohn' | 'nettoabzug' | 'einmalbezug';

export const LODAS_POSITION_KIND: Record<DatevLohnartKey, LodasPositionKind> = {
  grundgehalt: 'festbezug',
  stundenlohn: 'stundenlohn',
  zulage_schicht: 'festbezug',
  zulage_erschwernis: 'festbezug',
  zulage_funktion: 'festbezug',
  sachbezug_dienstwagen: 'festbezug',
  sachbezug_jobticket: 'festbezug',
  sachbezug_essenszuschuss: 'festbezug',
  vwl: 'festbezug',
  bav_entgeltumwandlung: 'festbezug',
  abzug_sonstig: 'nettoabzug',
  bonus_zielbonus: 'einmalbezug',
  bonus_provision: 'einmalbezug',
  bonus_einmalzahlung: 'einmalbezug',
};

/**
 * Positionen, die das Brutto MINDERN (SALARY_DEDUCTION_KINDS), aber ohne
 * Vorzeichen uebergeben werden: Bezug oder Abzug entscheidet in LODAS und
 * Lohn und Gehalt die Lohnart. Die bAV-Entgeltumwandlung geht als Festbezug
 * bzw. Bruttobezug (BS 2) hinaus; ihre Lohnart muss im Lohnprogramm deshalb
 * als Abzug vom Brutto angelegt sein, sonst zahlt das Lohnbuero sie aus.
 * Der Pruefbericht erinnert daran, sobald sie vorkommt.
 */
export const DATEV_ABZUG_UEBER_LOHNART: DatevLohnartKey[] = ['bav_entgeltumwandlung'];

/**
 * Bearbeitungsschluessel der LODAS-Bewegungsdaten (SSH Anhang A.1), nur die
 * hier benutzten: 1 Stunden (3 Vor-, 2 Nachkommastellen), 2 Bruttobezug
 * (6/2), 3 Nettobezuege und Nettoabzuege (7/2).
 */
export const LODAS_BS = { stunden: 1, bruttobezug: 2, nettoabzug: 3 } as const;

/**
 * Feste Kennung des Festbezugs je Komponentenart (u_lod_psd_festbezuege,
 * festbez_id, 2 Stellen). Stabil, damit ein spaeterer Export denselben
 * Festbezug aktualisiert statt einen zweiten anzulegen.
 */
export const LODAS_FESTBEZUG_ID: Partial<Record<DatevLohnartKey, number>> = {
  grundgehalt: 1,
  zulage_schicht: 2,
  zulage_erschwernis: 3,
  zulage_funktion: 4,
  sachbezug_dienstwagen: 5,
  sachbezug_jobticket: 6,
  sachbezug_essenszuschuss: 7,
  vwl: 8,
  bav_entgeltumwandlung: 9,
};

/** Steuerklasse als Ziffer (st_klasse, 1 bis 6). */
export const LODAS_STEUERKLASSE: Record<TaxClass, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };

/** Konfessionsschluessel (SSH Anhang A.3, Liste 4624): 0 keine, 1 ev, 11 rk. */
export const LODAS_KONFESSION: Record<ChurchTax, number> = { keine: 0, ev: 1, rk: 11 };

/**
 * Personengruppenschluessel der Sozialversicherung (DEUEV), abgeleitet aus der
 * Beschaeftigungsart. Eine Ableitung, keine Erfassung: 101 gilt auch fuer
 * Altersrentner (119/120) oder Beschaeftigte in Altersteilzeit (103), die das
 * Profil nicht kennt. Deshalb geht der Schluessel NUR beim Neueintritt mit;
 * bei bestehenden Personen bleibt das Feld leer, und LODAS behaelt, was das
 * Lohnbuero dort korrigiert hat.
 */
export const LODAS_PERSONENGRUPPE: Partial<Record<EmployeeType, number>> = {
  vollzeit: 101,
  teilzeit: 101,
  auszubildender: 102,
  praktikant: 105,
  werkstudent: 106,
  minijob: 109,
};

/** Arbeitsverhaeltnis (SSH Anhang A.3, Liste 4574) je Vertragsart; andere Vertragsarten bleiben leer. */
export const LODAS_ARBEITSVERHAELTNIS: Record<string, number> = { unbefristet: 0, befristet: 1 };

/**
 * Laendercodes der Privatanschrift im Nationalitaetskennzeichen von LODAS.
 * Eine Anschrift im Ausland geht NICHT mit (der Export fuehrt die Felder fuer
 * Auslandsanschriften nicht); der Pruefbericht sagt das.
 */
export const LODAS_INLAND = 'DE';

/** Feldlaengen von LODAS (SSH Fach 4), ab denen der Export kuerzt. */
export const LODAS_LENGTH = {
  familienname: 30,
  vorname: 30,
  strassenname: 33,
  strasse_nr: 9,
  ort: 34,
  berufsbezeichnung: 30,
  sozialversicherung_nr: 13,
  iban: 42,
  bic: 11,
  identifikationsnummer: 11,
  pnr_betriebliche: 20,
  ausfallschluessel: 4,
} as const;

/** Platzhalter fuer das Schluesselfeld in den Satzbeschreibungen. */
export const LODAS_KEY = '<schluessel>';

/**
 * Satzbeschreibungen der LODAS-Dateien (SSH Fach 3 und 4): Tabelle und
 * Felder in der Reihenfolge, in der die Adapter die Werte schreiben. Das
 * Schluesselfeld steht als LODAS_KEY und wird zu `pnr#bwd`, `pnr#psd` oder
 * `pnr_betriebliche#psd` (auch in den Bewegungsdaten, laut Mustervorlage
 * LS_Muster_Betr_PNr.txt).
 */
export const LODAS_SATZ = {
  buchung_standard: ['u_lod_bwd_buchung_standard', 'abrechnung_zeitraum#bwd', LODAS_KEY, 'bs_nr#bwd', 'bs_wert_butab#bwd', 'la_eigene#bwd'],
  buchung_kalendarium: ['u_lod_bwd_buchung_kalendarium', 'abrechnung_zeitraum#bwd', LODAS_KEY, 'kalendertag#bwd', 'as_kal#bwd'],
  mitarbeiter: ['u_lod_psd_mitarbeiter', LODAS_KEY, 'duevo_familienname#psd', 'duevo_vorname#psd', 'adresse_strassenname#psd', 'adresse_strasse_nr#psd', 'adresse_plz#psd', 'adresse_ort#psd', 'geburtsdatum_ttmmjj#psd', 'sozialversicherung_nr#psd'],
  bank: ['u_lod_psd_ma_bank', LODAS_KEY, 'ma_iban#psd', 'ma_bic#psd'],
  steuer: ['u_lod_psd_steuer', LODAS_KEY, 'identifikationsnummer#psd', 'st_klasse#psd', 'kfb_anzahl#psd', 'konf_an#psd'],
  taetigkeit: ['u_lod_psd_taetigkeit', LODAS_KEY, 'persgrs#psd', 'berufsbezeichnung#psd'],
  beschaeftigung: ['u_lod_psd_beschaeftigung', LODAS_KEY, 'eintrittdatum#psd', 'austrittdatum#psd', 'arbeitsverhaeltnis#psd'],
  festbezuege: ['u_lod_psd_festbezuege', LODAS_KEY, 'festbez_id#psd', 'lohnart_nr#psd', 'betrag#psd'],
  stundenlohn: ['u_lod_psd_lohn_festbezuege', LODAS_KEY, 'std_lohn_1#psd'],
  nettoabzug: ['u_lod_psd_nettobeabzug', LODAS_KEY, 'nettobeabzug_id#psd', 'nba_nr#psd', 'betrag#psd'],
} as const;

/** Eine Zeile der [Satzbeschreibung]: Satzart, Tabelle, Felder, abschliessender Trenner. */
export function lodasSatzbeschreibung(satzart: number, satz: readonly string[], keyField: string): string {
  return [satzart, ...satz.map((f) => (f === LODAS_KEY ? keyField : f))].join(';') + ';';
}

// ---------------------------------------------------------------------------
// Pruefregeln
// ---------------------------------------------------------------------------

/** Beraternummer: 4 bis 7 Ziffern. */
export const isValidBeraterNr = (v: string): boolean => /^\d{4,7}$/.test(v);

/** Mandantennummer: 1 bis 5 Ziffern. */
export const isValidMandantenNr = (v: string): boolean => /^\d{1,5}$/.test(v);

/** Eigene Lohnartennummer: 1 bis 4 Ziffern (LODAS la_eigene; neuere Fassungen erlauben 4 Stellen). */
export const isValidLohnart = (v: string): boolean => /^\d{1,4}$/.test(v);

/** Nettobe-/abzugsnummer in den LODAS-Stammdaten (nba_nr): 1 bis 2 Ziffern. */
export const isValidNettoabzugNr = (v: string): boolean => /^\d{1,2}$/.test(v);

/**
 * Was die Nummer eines Lohnart-Schluessels ist: in den LODAS-Stammdaten
 * traegt der sonstige Abzug die Nettobe-/abzugsnummer des Mandanten (nba_nr,
 * 1 bis 2 Stellen), sonst ist jede Nummer eine eigene Lohnart (la_eigene,
 * 1 bis 4 Stellen). EINE Regel fuer Einstellungsseite, Positionsplan und
 * Pruefbericht.
 */
export function lohnartNumberKind(
  key: DatevLohnartKey,
  program: DatevProgram,
  festbezuege: DatevFestbezuegeMode,
): 'nba' | 'lohnart' {
  return program === 'lodas' && festbezuege === 'stammdaten' && LODAS_POSITION_KIND[key] === 'nettoabzug' ? 'nba' : 'lohnart';
}

/** Fehlertext zu einer Nummer, oder undefined, wenn sie passt. Leer ist hier kein Fehler (das sagt der Pruefbericht). */
export function lohnartNumberProblem(value: string, kind: 'nba' | 'lohnart'): string | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (kind === 'nba') return isValidNettoabzugNr(v) ? undefined : '1 bis 2 Ziffern';
  return isValidLohnart(v) ? undefined : '1 bis 4 Ziffern';
}

/** Ausfallschluessel: 1 bis 4 Buchstaben oder Ziffern (z. B. U, K, K6, UT). */
export const isValidAusfallschluessel = (v: string): boolean => /^[A-Za-z0-9]{1,4}$/.test(v);

/** LODAS-Mitarbeiternummer (pnr): 1 bis 5 Ziffern, nicht 0. */
export const isLodasPnr = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) > 0;

/**
 * Betriebliche Personalnummer (pnr_betriebliche): 1 bis 20 Zeichen. Der
 * Feldtrenner und die Stringbegrenzer duerfen nicht vorkommen, sonst
 * zerlegt LODAS den Satz an der falschen Stelle.
 */
export const isBetrieblichePnr = (v: string): boolean =>
  v.length >= 1 && v.length <= 20 && !/[;"'\r\n]/.test(v);

/**
 * Vergleichsschluessel einer Personalnummer, so wie das Lohnprogramm sie
 * liest: Die Mitarbeiternummer ist ein Zahlenfeld, '042' und '42' sind dort
 * dieselbe Person. Die betriebliche Personalnummer ist Text und bleibt, wie
 * sie ist.
 */
export function pnrCompareKey(pnr: string, mode: 'pnr' | 'betrieblich'): string {
  return mode === 'pnr' && /^\d+$/.test(pnr) ? String(Number(pnr)) : pnr;
}

/** Deutsche Postleitzahl: genau 5 Ziffern. */
export const isValidPlz = (v: string): boolean => /^\d{5}$/.test(v);

/** IBAN ohne Leerzeichen und in Grossbuchstaben. */
export function normalizeIban(v: string): string {
  return v.replace(/\s+/g, '').toUpperCase();
}

/** IBAN-Pruefung nach ISO 13616 (Laenderkennung, Laenge 15 bis 34, Modulo 97). */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** BIC: 8 oder 11 Zeichen (Bank, Land, Ort, optional Filiale). */
export const isValidBic = (v: string): boolean => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.toUpperCase());

/** Versicherungsnummer ohne Leerzeichen, Buchstabe gross. */
export function normalizeSvNummer(v: string): string {
  return v.replace(/\s+/g, '').toUpperCase();
}

/**
 * Versicherungsnummer der Rentenversicherung: 2 Ziffern Bereich, 6 Ziffern
 * Geburtsdatum, 1 Buchstabe, 2 Ziffern Seriennummer, 1 Pruefziffer. Fuer die
 * Pruefziffer steht der Buchstabe als zweistellige Position im Alphabet;
 * die zwoelf Ziffern werden mit 2,1,2,5,7,1,2,1,2,1,2,1 gewichtet, die
 * Quersummen der Produkte addiert, der Rest zu 10 ist die Pruefziffer.
 */
export function isValidSvNummer(raw: string): boolean {
  const sv = normalizeSvNummer(raw);
  const m = /^(\d{8})([A-Z])(\d{2})(\d)$/.exec(sv);
  if (!m) return false;
  const letterPos = String(m[2]!.charCodeAt(0) - 64).padStart(2, '0');
  const digits = `${m[1]}${letterPos}${m[3]}`;
  const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const product = Number(digits[i]) * weights[i]!;
    sum += Math.floor(product / 10) + (product % 10);
  }
  return sum % 10 === Number(m[4]);
}

/**
 * Steuerliche Identifikationsnummer: 11 Ziffern, erste nicht 0, unter den
 * ersten zehn kommt genau eine Ziffer mehrfach vor (zwei- oder dreimal), die
 * elfte ist die Pruefziffer nach ISO 7064 (MOD 11,10).
 */
export function isValidSteuerId(raw: string): boolean {
  const id = raw.replace(/[\s/]/g, '');
  if (!/^[1-9]\d{10}$/.test(id)) return false;
  const counts = new Map<string, number>();
  for (const d of id.slice(0, 10)) counts.set(d, (counts.get(d) ?? 0) + 1);
  const repeated = [...counts.values()].filter((n) => n > 1);
  if (repeated.length !== 1 || repeated[0]! > 3) return false;
  let product = 10;
  for (const d of id.slice(0, 10)) {
    let sum = (Number(d) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(id[10]);
}

/**
 * Strasse und Hausnummer trennen (LODAS fuehrt sie getrennt, 33 und 9
 * Zeichen): Die Hausnummer ist der Schluss aus Ziffern mit optionalem
 * Buchstaben, auch mit Leerzeichen davor und als Bereich ("Baustrasse 27a",
 * "Hauptstr. 12 a", "Am Hang 3-5", "Weg 12 / 3"). Der Name davor ist so
 * KURZ wie moeglich, damit ein Bereich mit Leerzeichen ganz zur Hausnummer
 * gehoert; "Strasse des 17. Juni 5" gibt trotzdem nur die 5 ab, weil
 * "17. Juni 5" keine Hausnummer ist. Ohne Ziffern am Ende bleibt alles
 * Strassenname.
 */
export function splitStreet(street: string): { name: string; number: string } {
  const trimmed = street.trim().replace(/\s+/g, ' ');
  const m = /^(.*?\S)[\s,]+(\d+ ?[a-zA-Z]?(?: ?[-/] ?\d+ ?[a-zA-Z]?)*)$/.exec(trimmed);
  if (!m) return { name: trimmed, number: '' };
  return { name: m[1]!.trim(), number: m[2]!.trim() };
}

/** Betrag in Cent als DATEV-Dezimalzahl mit Komma, ohne Tausenderpunkt, Vorzeichen entfernt (die Lohnart entscheidet). */
export function datevBetrag(cents: number): string {
  return centsToDecimal(Math.abs(cents));
}

/** Stunden mit zwei Nachkommastellen und Komma. */
export function datevStunden(hours: number): string {
  return Math.abs(hours).toFixed(2).replace('.', ',');
}

/** ISO-Datum JJJJ-MM-TT als TT.MM.JJJJ (Datumsformat der Exportdateien). */
export function datevDatum(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Monat JJJJ-MM als Abrechnungszeitraum 01.MM.JJJJ (6-stelliges Datumsfeld, Tag immer 01). */
export function datevZeitraum(month: string): string {
  const [y, m] = month.split('-');
  return `01.${m}.${y}`;
}

/**
 * Zeichen, die Windows-1252 (der Zeichensatz von LODAS und Lohn und Gehalt)
 * nicht kennt. Der Export ersetzt sie durch '?' und nennt sie im
 * Pruefbericht, damit niemand einen Namen mit Fragezeichen beim Lohnbuero
 * entdeckt.
 */
export const CP1252_EXTRA = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Byte eines Zeichens in Windows-1252, oder undefined, wenn es dort nicht existiert. */
export function cp1252Byte(codePoint: number): number | undefined {
  if (codePoint < 0x80) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return CP1252_EXTRA.get(codePoint);
}

/**
 * Alle Zeichen eines Texts, die Windows-1252 nicht darstellt (jedes einmal).
 * Wie der Encoder in NFC-Form: Ein aus u und Trema zusammengesetztes ü (aus
 * einem PDF oder von macOS eingefuegt) ist dort das eine Zeichen 0xFC.
 */
export function cp1252Unencodable(text: string): string[] {
  const found = new Set<string>();
  for (const ch of text.normalize('NFC')) {
    if (cp1252Byte(ch.codePointAt(0)!) === undefined) found.add(ch);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Pruefbericht
// ---------------------------------------------------------------------------

export type DatevIssueLevel = 'fehler' | 'warnung';

export interface DatevIssue {
  level: DatevIssueLevel;
  /** Fehlt, wenn die Meldung die Einstellungen betrifft, nicht eine Person. */
  employee_id?: number;
  person?: string;
  personnel_number?: string;
  message: string;
  /**
   * Dateien, die die Meldung betrifft; fehlt sie, betrifft sie jede Datei.
   * Ein Fehler sperrt nur die Dateien, die er betrifft (eine fehlende
   * Nettoabzugsnummer sperrt die Stammdaten, nicht die Bewegungsdaten).
   */
  kinds?: DatevExportKind[];
  /**
   * Personen, an denen eine Einstellungsmeldung haengt (eine Lohnart, die nur
   * sie tragen): Sie betrifft nur Dateien mit mindestens einer davon, sonst
   * sperrte eine Nummer, die nur Personen ausserhalb der Datei brauchen, die
   * Stammdaten „nur Aenderungen“.
   */
  employee_ids?: number[];
}

export interface DatevCheckReport {
  program: DatevProgram;
  /** Schluesselfeld der LODAS-Saetze. */
  pnr_mode: 'pnr' | 'betrieblich';
  festbezuege: DatevFestbezuegeMode;
  issues: DatevIssue[];
  error_count: number;
  warning_count: number;
  /** Lohnartennummern, die der Lauf benutzt: Nummer je Schluessel, die Dateien, in denen sie steht, und die Personen, die sie tragen. */
  lohnarten_in_use: {
    key: DatevLohnartKey;
    label: string;
    number: string;
    kinds: DatevExportKind[];
    employee_ids: number[];
  }[];
}

/** Fehler sperren den Export; Warnungen stehen in den Hinweisdaten der Datei. */
export function summarizeIssues(issues: DatevIssue[]): { error_count: number; warning_count: number } {
  return {
    error_count: issues.filter((i) => i.level === 'fehler').length,
    warning_count: issues.filter((i) => i.level === 'warnung').length,
  };
}

/**
 * Meldungen, die EINE Datei betreffen: passende Dateiart, und bei
 * Personenmeldungen (`employee_id`, `employee_ids`) nur solche zu Personen,
 * die in der Datei stehen (`employeeIds`; null = alle Personen des Laufs).
 * Route (Sperre, Hinweisdaten) und Dialog (Anzeige, Knopf) filtern damit
 * gleich.
 */
export function issuesForFile(
  issues: readonly DatevIssue[],
  kind: DatevExportKind,
  employeeIds: ReadonlySet<number> | null,
): DatevIssue[] {
  return issues.filter(
    (i) =>
      (!i.kinds || i.kinds.includes(kind)) &&
      (i.employee_id === undefined || employeeIds === null || employeeIds.has(i.employee_id)) &&
      (!i.employee_ids || employeeIds === null || i.employee_ids.some((id) => employeeIds.has(id))),
  );
}


/**
 * Spalten der Bewegungsdatei fuer Lohn und Gehalt in genau dieser Reihenfolge.
 * Sie wird im ASCII-Import-Assistenten einmalig als Satzbeschreibung
 * hinterlegt (Trennzeichen Strichpunkt, Zahlenkomma Komma, Datum TT.MM.JJJJ).
 */
export const LUG_COLUMNS = [
  'Personalnummer',
  'Kalendertag',
  'Ausfallschluessel',
  'Lohnartennummer',
  'Stundenanzahl',
  'Tagesanzahl',
  'Wert',
  'Abweichender Faktor',
  'Abweichende Lohnveraenderung',
  'Kostenstellennummer',
  'Kostentraeger',
] as const;
