/**
 * Pruefbericht vor dem DATEV-Export. Fehler sperren die Dateien, die sie
 * betreffen (sie waeren nicht importierbar oder landeten beim falschen
 * Mandanten oder bei der falschen Person), Warnungen stehen in den
 * Hinweisdaten der Datei und im Dialog, damit das Lohnbuero und die HR
 * dieselbe Liste sehen. Jede Meldung nennt mit `kinds` die Dateien, die sie
 * betrifft (issuesForFile in packages/shared/src/datev.ts). Arbeitet nur auf
 * dem Kontext, nie auf der Datenbank (Test: src/test/datevTest.ts).
 */
import {
  cp1252Unencodable,
  DATEV_ABZUG_UEBER_LOHNART,
  DATEV_LOHNART_LABELS,
  isBetrieblichePnr,
  isLodasPnr,
  isValidBeraterNr,
  isValidBic,
  isValidIban,
  isValidLohnart,
  isValidMandantenNr,
  isValidNettoabzugNr,
  isValidPlz,
  isValidSteuerId,
  isValidSvNummer,
  LODAS_INLAND,
  LODAS_LENGTH,
  LODAS_PERSONENGRUPPE,
  pnrCompareKey,
  splitStreet,
  summarizeIssues,
  type DatevCheckReport,
  type DatevExportKind,
  type DatevIssue,
  type EmployeeType,
} from '@ohrganize/shared';
import type { DatevExportContext, DatevPerson } from './context.js';
import { fehltageOf, festbezuegeChanged, lohnartUsage, positionKind } from './positions.js';

export const personLabel = (p: DatevPerson): string => `${p.last_name}, ${p.first_name}`;

/** Schluesselfeld der LODAS-Saetze: pnr (Ziffern) oder die betriebliche Personalnummer. */
export function pnrMode(ctx: DatevExportContext): 'pnr' | 'betrieblich' {
  return ctx.settings.program === 'lodas' && ctx.settings.betrieblichePnr ? 'betrieblich' : 'pnr';
}

/** Ob die Anschrift einer Person in die LODAS-Stammdaten geht (sonst bleiben alle Anschriftfelder leer). */
export function addressExportable(p: DatevPerson): boolean {
  if (p.private_country && p.private_country !== LODAS_INLAND) return false;
  return !p.private_zip || isValidPlz(p.private_zip.trim());
}

/**
 * Wie die Anschrift: Eine IBAN, Steuer-ID oder SV-Nummer, die ihre Pruefziffer
 * nicht besteht, geht nicht hinaus. Das leere Feld laesst in LODAS den
 * bisherigen Wert stehen, statt einen richtigen mit einem Tippfehler zu
 * ueberschreiben; der Pruefbericht sagt es.
 */
export const ibanExportable = (p: DatevPerson): boolean => !!p.iban && isValidIban(p.iban);
export const taxIdExportable = (p: DatevPerson): boolean => !!p.tax_id && isValidSteuerId(p.tax_id);
export const svNummerExportable = (p: DatevPerson): boolean =>
  !!p.social_security_number && isValidSvNummer(p.social_security_number);

const BEWEGUNG: DatevExportKind[] = ['bewegungsdaten'];
const STAMM: DatevExportKind[] = ['stammdaten'];

export function checkDatevExport(ctx: DatevExportContext): DatevCheckReport {
  const { settings } = ctx;
  const issues: DatevIssue[] = [];
  const general = (level: DatevIssue['level'], message: string, kinds?: DatevExportKind[], employeeIds?: Set<number>) =>
    issues.push({
      level,
      message,
      ...(kinds ? { kinds } : {}),
      ...(employeeIds ? { employee_ids: [...employeeIds] } : {}),
    });
  const personal = (level: DatevIssue['level'], p: DatevPerson, message: string, kinds?: DatevExportKind[]) =>
    issues.push({
      level,
      employee_id: p.employee_id,
      person: personLabel(p),
      personnel_number: p.pnr,
      message,
      ...(kinds ? { kinds } : {}),
    });

  if (!isValidBeraterNr(settings.beraterNr)) {
    general('fehler', 'Beraternummer fehlt oder ist ungültig (4 bis 7 Ziffern, Einstellungen > DATEV-Lohnexport)');
  }
  if (!isValidMandantenNr(settings.mandantenNr)) {
    general('fehler', 'Mandantennummer fehlt oder ist ungültig (1 bis 5 Ziffern, Einstellungen > DATEV-Lohnexport)');
  }

  // Lohnarten: geprueft wird, was eine Datei tatsaechlich traegt, und der
  // Fehler sperrt nur diese Datei, und nur, wenn eine Person mit dieser
  // Lohnart darin steht (Stammdaten „nur Aenderungen“). Eine Nummer, die
  // keine Datei enthaelt, ist kein Fehler.
  const usage = lohnartUsage(ctx);
  for (const [key, use] of usage) {
    // Nur die GESPEICHERTE Nummer zaehlt; ein Vorschlag, den niemand
    // gespeichert hat, ist keine Zuordnung (datevSettingsFrom).
    const number = (settings.lohnarten[key] ?? '').trim();
    const ok = use.number === 'nba' ? isValidNettoabzugNr(number) : isValidLohnart(number);
    if (!ok) {
      general(
        'fehler',
        use.number === 'nba'
          ? `Nettoabzugsnummer für „${DATEV_LOHNART_LABELS[key]}“ fehlt oder ist ungültig (1 bis 2 Ziffern; Einstellungen > DATEV-Lohnexport speichern)`
          : `Lohnartennummer für „${DATEV_LOHNART_LABELS[key]}“ fehlt oder ist ungültig (1 bis 4 Ziffern; Einstellungen > DATEV-Lohnexport speichern)`,
        [...use.kinds],
        use.employees,
      );
    }
  }
  for (const key of DATEV_ABZUG_UEBER_LOHNART) {
    const use = usage.get(key);
    if (!use) continue;
    general(
      'warnung',
      `${DATEV_LOHNART_LABELS[key]} geht ohne Vorzeichen; die Lohnart ${(settings.lohnarten[key] ?? '').trim() || '?'} muss im Lohnprogramm als Abzug vom Brutto angelegt sein`,
      [...use.kinds],
      use.employees,
    );
  }
  const hourlyPersons = ctx.persons.filter((p) => p.components.some((c) => c.kind === 'stundenlohn'));
  if (hourlyPersons.length > 0 && !settings.vertragsstunden) {
    general(
      'warnung',
      'Stundenlohn: Ohne „Vertragsstunden übergeben“ enthalten die Bewegungsdaten keine Stunden; das Lohnbüro trägt die Ist-Stunden selbst ein',
      BEWEGUNG,
    );
  }
  if (settings.program === 'lug' && settings.festbezuege === 'stammdaten') {
    const changed = ctx.persons.filter((p) => festbezuegeChanged(ctx, p));
    if (changed.length > 0) {
      general(
        'warnung',
        `Lohn und Gehalt bekommt keine Festbezüge aus oHRganize: Neueintritte, Gehaltsänderungen und neue oder beendete Gehaltsbestandteile dieses Monats (${changed.length === 1 ? '1 Person' : `${changed.length} Personen`}) bitte im Lohnprogramm erfassen`,
        BEWEGUNG,
      );
    }
  }
  for (const t of ctx.unmapped_absence_types) {
    general('warnung', `Abwesenheitsart „${t.name}“ hat keinen Ausfallschlüssel und wird nicht übergeben`, BEWEGUNG);
  }
  if (settings.program === 'lodas' && ctx.persons.some((p) => p.health_insurance)) {
    general('warnung', 'Krankenkassen werden nicht übergeben (die Personalakte führt keine Betriebsnummer); bitte in LODAS pflegen', STAMM);
  }

  // Personalnummern: wie das Lohnprogramm sie liest ('042' ist 42), im Lauf
  // und gegen alle anderen Profile. Doppelte bekommen beide Personen gemeldet.
  const mode = pnrMode(ctx);
  const keyOf = (pnr: string) => pnrCompareKey(pnr, mode);
  const groups = new Map<string, DatevPerson[]>();
  for (const p of ctx.persons) groups.set(keyOf(p.pnr), [...(groups.get(keyOf(p.pnr)) ?? []), p]);
  const outside = new Map(ctx.other_personnel_numbers.map((o) => [keyOf(o.personnel_number), o.employee_id]));

  for (const p of ctx.persons) {
    if (mode === 'betrieblich' ? !isBetrieblichePnr(p.pnr) : !isLodasPnr(p.pnr)) {
      personal(
        'fehler',
        p,
        mode === 'betrieblich'
          ? 'Personalnummer muss 1 bis 20 Zeichen haben, ohne Semikolon und Anführungszeichen'
          : settings.program === 'lodas'
            ? 'Personalnummer muss aus 1 bis 5 Ziffern bestehen (oder betriebliche Personalnummer in den Einstellungen einschalten)'
            : 'Personalnummer muss aus 1 bis 5 Ziffern bestehen (Mitarbeiternummer in Lohn und Gehalt)',
      );
    }
    const same = (groups.get(keyOf(p.pnr)) ?? []).filter((o) => o !== p);
    if (same.length > 0) {
      personal('fehler', p, `Personalnummer ${p.pnr} ist im Lauf doppelt (auch ${same.map(personLabel).join(', ')})`);
    }
    const other = outside.get(keyOf(p.pnr));
    if (other !== undefined) {
      personal(
        'fehler',
        p,
        p.has_personnel_number
          ? `Personalnummer ${p.pnr} ist auch bei einem anderen Profil vergeben (Profil-ID ${other})`
          : `Ohne eigene Personalnummer ginge die Profil-ID ${p.pnr} hinaus, die ein anderes Profil (Profil-ID ${other}) als Personalnummer trägt`,
      );
    }
    if (!p.has_personnel_number) personal('warnung', p, 'Keine Personalnummer gepflegt, die Profil-ID wird übergeben');

    for (const c of p.components) {
      if (!positionKind(c.kind)) personal('fehler', p, `Gehaltskomponente „${c.kind}“ kennt der DATEV-Export nicht`);
    }
    for (const w of p.warnings) {
      // Warnungen des Laufs nur ergaenzen, wo die Pruefung unten nichts Genaueres sagt.
      if (/Minijob/.test(w)) personal('warnung', p, w, BEWEGUNG);
    }
    if (settings.vertragsstunden && p.weekly_hours === null && p.components.some((c) => c.kind === 'stundenlohn')) {
      personal('warnung', p, 'Wochenstunden fehlen; die Vertragsstunden sind wie im Lauf mit 40 Stunden je Woche gerechnet', BEWEGUNG);
    }
    for (const b of p.bonuses) {
      if (b.payout_cents <= 0) personal('warnung', p, `Bonus „${b.title}“ mit 0,00 wird nicht übergeben`, BEWEGUNG);
    }
    // Nur Fehltage, die mitgehen (mit Ausfallschluessel), wie die Hinweise des Adapters.
    if (settings.program === 'lodas' && fehltageOf(ctx, p).some((a) => a.half)) {
      personal('warnung', p, 'Halbe Fehltage stehen im LODAS-Kalendarium als ganzer Tag (Hinweis in den Hinweisdaten)', BEWEGUNG);
    }
    const odd = cp1252Unencodable([p.first_name, p.last_name, p.private_street, p.private_city, p.job_title].filter(Boolean).join(' '));
    if (odd.length) {
      // Mit Codepunkt, weil das Zeichen in der Datei selbst schon ein ? ist.
      const named = odd.map((ch) => `${ch} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`);
      personal('warnung', p, `Zeichen ohne Entsprechung in Windows-1252 werden durch ? ersetzt: ${named.join(', ')}`);
    }

    // Stammdaten: nur LODAS bekommt sie.
    if (settings.program !== 'lodas') continue;
    // Ein Neueintritt hat in LODAS noch keinen bisherigen Wert, der stehen bliebe.
    const notSent = p.flags.includes('neueintritt')
      ? 'wird nicht übergeben; bitte im Lohnprogramm erfassen'
      : 'wird nicht übergeben; LODAS behält den bisherigen Wert';
    if (p.iban && !ibanExportable(p)) personal('warnung', p, `IBAN ist ungültig (Prüfsumme) und ${notSent}`, STAMM);
    if (!p.iban) personal('warnung', p, 'IBAN fehlt', STAMM);
    if (p.bic && !isValidBic(p.bic.trim())) personal('warnung', p, 'BIC hat nicht die Form von 8 oder 11 Zeichen', STAMM);
    if (p.tax_id && !taxIdExportable(p)) {
      personal('warnung', p, `Steuer-ID ist ungültig (11 Ziffern mit Prüfziffer) und ${notSent}`, STAMM);
    }
    if (!p.tax_id) personal('warnung', p, 'Steuer-ID fehlt', STAMM);
    if (p.social_security_number && !svNummerExportable(p)) {
      personal('warnung', p, `SV-Nummer ist ungültig (12 Zeichen mit Prüfziffer) und ${notSent}`, STAMM);
    }
    if (!p.social_security_number) personal('warnung', p, 'SV-Nummer fehlt', STAMM);
    if (!p.birth_date) personal('warnung', p, 'Geburtsdatum fehlt', STAMM);
    if (!p.hire_date) personal('warnung', p, 'Eintrittsdatum fehlt', STAMM);
    if (!p.tax_class) personal('warnung', p, 'Steuerklasse fehlt', STAMM);
    if (p.private_country && p.private_country !== LODAS_INLAND) {
      personal('warnung', p, `Anschrift im Ausland (${p.private_country}) wird nicht übergeben; LODAS behält die bisherige Anschrift`, STAMM);
    } else if (p.private_zip && !isValidPlz(p.private_zip.trim())) {
      personal('warnung', p, 'Anschrift wird nicht übergeben: Postleitzahl hat nicht 5 Ziffern; LODAS behält die bisherige Anschrift', STAMM);
    } else if (!p.private_street || !p.private_zip || !p.private_city) {
      personal('warnung', p, 'Privatanschrift unvollständig', STAMM);
    }
    if (addressExportable(p) && p.private_street) {
      const street = splitStreet(p.private_street);
      if (!street.number) personal('warnung', p, 'Hausnummer nicht erkannt; LODAS behält die bisherige Hausnummer', STAMM);
      if (street.name.length > LODAS_LENGTH.strassenname) personal('warnung', p, `Straße wird auf ${LODAS_LENGTH.strassenname} Zeichen gekürzt`, STAMM);
      if (street.number.length > LODAS_LENGTH.strasse_nr) personal('warnung', p, `Hausnummer wird auf ${LODAS_LENGTH.strasse_nr} Zeichen gekürzt`, STAMM);
    }
    if (addressExportable(p) && p.private_city && p.private_city.trim().length > LODAS_LENGTH.ort) {
      personal('warnung', p, `Ort wird auf ${LODAS_LENGTH.ort} Zeichen gekürzt`, STAMM);
    }
    if (p.job_title && p.job_title.trim().length > LODAS_LENGTH.berufsbezeichnung) {
      personal('warnung', p, `Berufsbezeichnung wird auf ${LODAS_LENGTH.berufsbezeichnung} Zeichen gekürzt`, STAMM);
    }
    if (p.last_name.length > LODAS_LENGTH.familienname) personal('warnung', p, `Nachname wird auf ${LODAS_LENGTH.familienname} Zeichen gekürzt`, STAMM);
    if (p.first_name.length > LODAS_LENGTH.vorname) personal('warnung', p, `Vorname wird auf ${LODAS_LENGTH.vorname} Zeichen gekürzt`, STAMM);
    if (p.flags.includes('neueintritt') && LODAS_PERSONENGRUPPE[p.employee_type as EmployeeType] === undefined) {
      personal('warnung', p, `Beschäftigungsart „${p.employee_type}“ ohne Personengruppe, bitte in LODAS ergänzen`, STAMM);
    }
  }

  const { error_count, warning_count } = summarizeIssues(issues);
  return {
    program: settings.program,
    pnr_mode: mode,
    festbezuege: settings.festbezuege,
    issues,
    error_count,
    warning_count,
    lohnarten_in_use: [...usage].map(([key, use]) => ({
      key,
      label: DATEV_LOHNART_LABELS[key],
      number: (settings.lohnarten[key] ?? '').trim(),
      kinds: [...use.kinds],
      employee_ids: [...use.employees],
    })),
  };
}
