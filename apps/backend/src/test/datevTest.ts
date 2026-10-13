/**
 * Prueft den DATEV-Lohnexport ohne Datenbank: die Pruefregeln aus
 * @ohrganize/shared (IBAN, SV-Nummer, Steuer-ID, Personalnummern, Strasse),
 * den Windows-1252-Encoder, den Pruefbericht und die Dateien beider Adapter
 * gegen einen festen Kontext, Zeile fuer Zeile. Die erwarteten Zeilen folgen
 * dem DATEV Schnittstellenhandbuch LODAS (Mustervorlagen LSST1.txt und
 * LS_Muster_Betr_PNr.txt) und der Spaltenfolge fuer Lohn und Gehalt.
 *
 * Aufruf: tsx src/test/datevTest.ts (Teil von npm test)
 */
import {
  contractMonthHours,
  cp1252Unencodable,
  hourlyMonthCents,
  DATEV_LOHNART_DEFAULTS,
  isBetrieblichePnr,
  isLodasPnr,
  issuesForFile,
  isValidBeraterNr,
  isValidIban,
  isValidMandantenNr,
  isValidSteuerId,
  isValidSvNummer,
  pnrCompareKey,
  splitStreet,
} from '@ohrganize/shared';
import { encodeCp1252 } from '../modules/compensation/payrollExport/cp1252.js';
import { checkDatevExport } from '../modules/compensation/payrollExport/check.js';
import { renderLodasBewegungsdaten, renderLodasStammdaten } from '../modules/compensation/payrollExport/lodas.js';
import { lugExporter, renderLugBewegungsdaten } from '../modules/compensation/payrollExport/lug.js';
import type { DatevExportContext, DatevPerson } from '../modules/compensation/payrollExport/context.js';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

// ---------------------------------------------------------------------------
// Pruefregeln
// ---------------------------------------------------------------------------
check('IBAN gueltig (DE02 1203 0000 0000 2020 51)', isValidIban('DE02 1203 0000 0000 2020 51'));
check('IBAN mit Zahlendreher ungueltig', !isValidIban('DE02120300000000202015'));
check('IBAN zu kurz ungueltig', !isValidIban('DE0212'));
check('SV-Nummer gueltig (Beispiel 15 070649 C 103)', isValidSvNummer('15 070649 C 103'));
check('SV-Nummer mit falscher Pruefziffer ungueltig', !isValidSvNummer('15070649C104'));
check('SV-Nummer ohne Buchstaben ungueltig', !isValidSvNummer('150706491103'));
check('Steuer-ID gueltig (86095742719)', isValidSteuerId('86095742719'));
check('Steuer-ID mit Schraegstrichen gueltig', isValidSteuerId('86 095 742 719'));
check('Steuer-ID mit falscher Pruefziffer ungueltig', !isValidSteuerId('86095742710'));
check('Steuer-ID ohne doppelte Ziffer ungueltig', !isValidSteuerId('12345678905'));
check('Beraternummer 4 bis 7 Ziffern', isValidBeraterNr('28547') && !isValidBeraterNr('123') && !isValidBeraterNr('12345678'));
check('Mandantennummer 1 bis 5 Ziffern', isValidMandantenNr('1') && isValidMandantenNr('90909') && !isValidMandantenNr('123456'));
check('LODAS pnr: Ziffern, nicht 0', isLodasPnr('42') && !isLodasPnr('0') && !isLodasPnr('P-0042') && !isLodasPnr('123456'));
check('Betriebliche Personalnummer ohne Trenner', isBetrieblichePnr('P-0042') && !isBetrieblichePnr('a;b') && !isBetrieblichePnr(''));
check('Strasse mit Hausnummer getrennt', JSON.stringify(splitStreet('Baustraße 27a')) === JSON.stringify({ name: 'Baustraße', number: '27a' }));
check('Strasse mit Bereich getrennt', JSON.stringify(splitStreet('Am Hang 3-5')) === JSON.stringify({ name: 'Am Hang', number: '3-5' }));
check('Strasse ohne Hausnummer bleibt ganz', JSON.stringify(splitStreet('Postfach')) === JSON.stringify({ name: 'Postfach', number: '' }));
check('Strasse mit Ziffer im Namen (Str. des 17. Juni 5)', JSON.stringify(splitStreet('Straße des 17. Juni 5')) === JSON.stringify({ name: 'Straße des 17. Juni', number: '5' }));
check('Strasse mit Bereich und Leerzeichen (Weg 12 / 3)', JSON.stringify(splitStreet('Weg 12 / 3')) === JSON.stringify({ name: 'Weg', number: '12 / 3' }), splitStreet('Weg 12 / 3'));
check('Strasse mit Bereich und Leerzeichen (Am Hang 3 - 5)', JSON.stringify(splitStreet('Am Hang 3 - 5')) === JSON.stringify({ name: 'Am Hang', number: '3 - 5' }), splitStreet('Am Hang 3 - 5'));
check('Hausnummer mit abgesetztem Buchstaben (Hauptstr. 12 a)', JSON.stringify(splitStreet('Hauptstr. 12 a')) === JSON.stringify({ name: 'Hauptstr.', number: '12 a' }), splitStreet('Hauptstr. 12 a'));
check('Personalnummer als Zahl verglichen (042 = 42)', pnrCompareKey('042', 'pnr') === pnrCompareKey('42', 'pnr') && pnrCompareKey('042', 'betrieblich') !== '42');
check('Vertragsstunden 15,5 h kaufmaennisch gerundet (67,12)', contractMonthHours(15.5) === 67.12, contractMonthHours(15.5));
check('Vertragsstunden ohne Wochenstunden wie im Lauf (40 h = 173,2)', contractMonthHours(null) === 173.2, contractMonthHours(null));
check(
  'Stundenlohn im Lauf = exportierte Stunden x Satz (38,5 h: 166,71 h x 13,50 = 2.250,59)',
  hourlyMonthCents(1350, 38.5) === 225059 && hourlyMonthCents(1350, 15.5) === Math.round(6712 * 1350 / 100),
  hourlyMonthCents(1350, 38.5),
);

// ---------------------------------------------------------------------------
// Windows-1252
// ---------------------------------------------------------------------------
// Der Halbgeviertstrich steht als Codepunkt, damit die Datei die Pruefung auf Gedankenstriche besteht.
const enc = encodeCp1252(`Müller € ${String.fromCharCode(0x2013)} Ž ẞ`);
check('cp1252: ue, Euro, Halbgeviertstrich, Z-Hatschek, ersatzweise ?', enc.toString('hex') === '4dfc6c6c657220802096208e203f', enc.toString('hex'));
check('cp1252Unencodable nennt nur das Unbekannte', cp1252Unencodable('Müller ẞ €').join('') === 'ẞ');
const nfdName = `Mu${String.fromCharCode(0x308)}ller`; // u plus kombinierendes Trema, wie aus einem PDF eingefuegt
check('cp1252: zusammengesetztes ü (NFD) wird zu 0xFC', encodeCp1252(nfdName).toString('hex') === '4dfc6c6c6572' && cp1252Unencodable(nfdName).length === 0);

// ---------------------------------------------------------------------------
// Fester Kontext: zwei Personen, Oktober 2026
// ---------------------------------------------------------------------------
function person(over: Partial<DatevPerson>): DatevPerson {
  return {
    employee_id: 1,
    pnr: '42',
    has_personnel_number: true,
    first_name: 'Anna',
    last_name: 'Müller',
    birth_date: '1988-03-02',
    private_street: 'Baustraße 27a',
    private_zip: '80331',
    private_city: 'München',
    private_country: null,
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
    tax_id: '86095742719',
    tax_class: 'III',
    church_tax: 'rk',
    child_allowances: 1.5,
    social_security_number: '15 070649 C 103',
    health_insurance: null,
    employee_type: 'vollzeit',
    job_title: 'Entwicklerin',
    hire_date: '2020-01-01',
    exit_date: null,
    weekly_hours: 40,
    contract_type: 'unbefristet',
    changed_in_month: false,
    ended_kinds: [],
    ended_recently: false,
    components: [
      { kind: 'grundgehalt', amount_cents: 520000, monthly_cents: 520000 },
      { kind: 'vwl', amount_cents: 4000, monthly_cents: 4000 },
      { kind: 'abzug_sonstig', amount_cents: 2500, monthly_cents: -2500 },
    ],
    bonuses: [{ id: 7, kind: 'einmalzahlung', title: 'Prämie', payout_cents: 20000 }],
    flags: ['gehaltsaenderung'],
    warnings: [],
    absences: [
      { date: '2026-10-05', type_id: 3, type_name: 'Urlaub', category: 'urlaub', half: false },
      { date: '2026-10-06', type_id: 3, type_name: 'Urlaub', category: 'urlaub', half: true },
    ],
    ...over,
  };
}

const ben = (over: Partial<DatevPerson> = {}) =>
  person({
    employee_id: 2,
    pnr: '2',
    has_personnel_number: false,
    first_name: 'Ben',
    last_name: 'Klein',
    iban: null,
    tax_id: null,
    social_security_number: null,
    employee_type: 'minijob',
    job_title: null,
    weekly_hours: 5,
    components: [{ kind: 'stundenlohn', amount_cents: 1350, monthly_cents: 29228 }],
    bonuses: [],
    flags: ['neueintritt'],
    warnings: ['Fehlende IBAN'],
    absences: [],
    contract_type: null,
    church_tax: null,
    tax_class: null,
    child_allowances: 0,
    ...over,
  });

function context(
  over: Partial<DatevExportContext['settings']> = {},
  persons?: DatevPerson[],
  others: DatevExportContext['other_personnel_numbers'] = [],
): DatevExportContext {
  return {
    run: { id: 9, month: '2026-10', status: 'geprueft' },
    settings: {
      program: 'lodas',
      beraterNr: '28547',
      mandantenNr: '90909',
      betrieblichePnr: false,
      festbezuege: 'stammdaten',
      vertragsstunden: false,
      lohnarten: { ...DATEV_LOHNART_DEFAULTS, abzug_sonstig: '12' },
      ausfallschluessel: { '3': 'U' },
      companyName: 'Musterfirma GmbH',
      ...over,
    },
    persons: persons ?? [person({}), ben()],
    unmapped_absence_types: [],
    other_personnel_numbers: others,
    generated_at: '12.10.2026, 14:03',
  };
}

const errorsOf = (r: ReturnType<typeof checkDatevExport>) => r.issues.filter((i) => i.level === 'fehler');

const ctx = context();
const report = checkDatevExport(ctx);
check('Pruefbericht ohne Fehler', report.error_count === 0, errorsOf(report));
check(
  'Pruefbericht nennt fehlende Personalnummer, IBAN, Steuer-ID, SV-Nummer bei Ben',
  ['Profil-ID', 'IBAN fehlt', 'Steuer-ID fehlt', 'SV-Nummer fehlt'].every((m) =>
    report.issues.some((i) => i.employee_id === 2 && i.level === 'warnung' && i.message.includes(m)),
  ),
  report.issues,
);
check('Pruefbericht: halber Tag bei Anna', report.issues.some((i) => i.employee_id === 1 && /Halbe Fehltage/.test(i.message)));
check(
  'Pruefbericht: Lohnarten nur, soweit eine Datei sie traegt (Stundenlohn ohne Vertragsstunden nicht)',
  report.lohnarten_in_use.map((l) => l.key).sort().join() === 'abzug_sonstig,bonus_einmalzahlung,grundgehalt,vwl',
  report.lohnarten_in_use,
);
check(
  'Pruefbericht: Lohnarten mit ihren Dateien (Festbezug in Stammdaten, Bonus in Bewegungsdaten)',
  report.lohnarten_in_use.find((l) => l.key === 'grundgehalt')?.kinds.join() === 'stammdaten' &&
    report.lohnarten_in_use.find((l) => l.key === 'bonus_einmalzahlung')?.kinds.join() === 'bewegungsdaten',
);
check(
  'Pruefbericht: Stundenlohn ohne Stunden warnt auch in der Vorgabe (LODAS, Festbezuege ueber Stammdaten)',
  report.issues.some((i) => /Ist-Stunden/.test(i.message) && i.kinds?.join() === 'bewegungsdaten'),
);

// Fehler sperren: Beraternummer leer, Lohnart fehlt, Personalnummer nicht numerisch
const blocked = checkDatevExport(
  context({ beraterNr: '', lohnarten: { ...DATEV_LOHNART_DEFAULTS, grundgehalt: '', abzug_sonstig: '12' } }, [person({ pnr: 'P-0042' })]),
);
check('Fehler: Beraternummer, Lohnart, Personalnummer', blocked.error_count === 3, errorsOf(blocked));
check(
  'Fehlende Grundgehalt-Lohnart sperrt nur die Stammdaten, nicht die Bewegungsdaten',
  issuesForFile(blocked.issues, 'stammdaten', null).some((i) => i.level === 'fehler' && /Grundgehalt/.test(i.message)) &&
    !issuesForFile(blocked.issues, 'bewegungsdaten', null).some((i) => /Grundgehalt/.test(i.message)),
);
const lugDefault = checkDatevExport(
  context({ program: 'lug', lohnarten: { ...DATEV_LOHNART_DEFAULTS } }, [person({}), ben({ pnr: '7', has_personnel_number: true })]),
);
check(
  'LuG mit Festbezuegen ueber Stammdaten: leere Nummer fuer den sonstigen Abzug sperrt nicht (steht in keiner Datei)',
  lugDefault.error_count === 0,
  errorsOf(lugDefault),
);
check(
  'LuG mit Festbezuegen ueber Stammdaten: Warnung zu Neueintritten und Gehaltsaenderungen',
  lugDefault.issues.some((i) => /keine Festbezüge aus oHRganize/.test(i.message)),
);
const betrieblich = checkDatevExport(context({ betrieblichePnr: true }, [person({ pnr: 'P-0042' })]));
check('Betriebliche Personalnummer macht P-0042 zulaessig', betrieblich.error_count === 0 && betrieblich.pnr_mode === 'betrieblich');
const doppelt = checkDatevExport(context({}, [person({}), person({ employee_id: 3, pnr: '042', first_name: 'Carl' })]));
check(
  'Doppelte Personalnummer (042 und 42 sind fuer LODAS dieselbe) ist ein Fehler bei beiden',
  errorsOf(doppelt).filter((i) => /doppelt/.test(i.message)).length === 2,
  errorsOf(doppelt),
);
const kollision = checkDatevExport(
  context({}, [person({}), ben({ pnr: '17' })], [{ employee_id: 99, personnel_number: '17' }]),
);
check(
  'Profil-ID als Ersatznummer kollidiert mit der Personalnummer eines anderen Profils: Fehler',
  errorsOf(kollision).some((i) => i.employee_id === 2 && /Profil-ID 99/.test(i.message)),
  errorsOf(kollision),
);
const unbekannt = checkDatevExport(context({}, [person({ components: [{ kind: 'alt_zulage', amount_cents: 100, monthly_cents: 100 }] })]));
check('Unbekannte Gehaltskomponente ist ein Fehler statt still zu fehlen', errorsOf(unbekannt).some((i) => /alt_zulage/.test(i.message)));
const ohneStunden = checkDatevExport(context({ vertragsstunden: true }, [ben({ weekly_hours: null })]));
check(
  'Stundenlohn ohne Wochenstunden: Warnung, gerechnet mit 40',
  ohneStunden.issues.some((i) => i.employee_id === 2 && /mit 40 Stunden/.test(i.message)),
);
const anschriften = checkDatevExport(
  context({}, [
    person({ private_country: 'AT' }),
    person({ employee_id: 5, pnr: '5', private_zip: 'D-80331' }),
    person({ employee_id: 6, pnr: '6', job_title: 'Senior Human Resources Business Partner', private_city: 'Sankt Johann im Walde bei Regensburg' }),
  ]),
);
check('Anschrift im Ausland: Warnung sagt, dass sie nicht uebergeben wird', anschriften.issues.some((i) => i.employee_id === 1 && /wird nicht übergeben/.test(i.message)));
check('Ungueltige Postleitzahl: Anschrift wird nicht uebergeben', anschriften.issues.some((i) => i.employee_id === 5 && /Anschrift wird nicht übergeben/.test(i.message)));
check(
  'Kuerzungen von Ort und Berufsbezeichnung werden gemeldet',
  anschriften.issues.some((i) => i.employee_id === 6 && /Ort wird/.test(i.message)) &&
    anschriften.issues.some((i) => i.employee_id === 6 && /Berufsbezeichnung wird/.test(i.message)),
);
const unbestaetigt = checkDatevExport(context({ lohnarten: {} }));
check(
  'Lohnarten nur gespeichert gueltig: ohne gespeicherte Nummern sperren Grundgehalt, VWL, Abzug (Stammdaten) und Bonus (Bewegungsdaten)',
  ['Grundgehalt', 'Vermögenswirksame', 'Sonstiger Abzug', 'Einmalzahlung'].every((name) =>
    errorsOf(unbestaetigt).some((i) => i.message.includes(name)),
  ),
  errorsOf(unbestaetigt),
);
const bav = checkDatevExport(
  context({}, [person({ components: [{ kind: 'bav_entgeltumwandlung', amount_cents: 20000, monthly_cents: -20000 }] })]),
);
check(
  'bAV-Entgeltumwandlung: Hinweis, dass die Lohnart ein Abzug vom Brutto sein muss',
  bav.issues.some((i) => i.level === 'warnung' && /Abzug vom Brutto/.test(i.message) && i.kinds?.join() === 'stammdaten'),
  bav.issues,
);
const snapshot = context({ vertragsstunden: true }, [
  ben({ pnr: '7', has_personnel_number: true, weekly_hours: 5, components: [{ kind: 'stundenlohn', amount_cents: 1350, monthly_cents: 40500, hours: 30 }] }),
]);
check(
  'Vertragsstunden aus dem Lauf (Snapshot 30 h) statt aus den heutigen Wochenstunden',
  renderLodasBewegungsdaten(snapshot, checkDatevExport(snapshot)).includes('1;01.10.2026;7;1;30,00;300;'),
);
const kasse = checkDatevExport(context({}, [person({ health_insurance: 'AOK Bayern' }), ben({ health_insurance: 'TK' })]));
check(
  'Krankenkasse: EIN allgemeiner Hinweis statt einer Warnung je Person',
  kasse.issues.filter((i) => /Krankenkasse/.test(i.message)).length === 1 &&
    kasse.issues.some((i) => /Krankenkasse/.test(i.message) && i.employee_id === undefined),
);

// ---------------------------------------------------------------------------
// LODAS Bewegungsdaten (Festbezuege ueber die Stammdaten)
// ---------------------------------------------------------------------------
const bwd = renderLodasBewegungsdaten(ctx, report).split('\r\n');
const expectBwd = [
  '[Allgemein]',
  'Ziel=LODAS',
  'Version_SST=1.0',
  'BeraterNr=28547',
  'MandantenNr=90909',
  'Feldtrennzeichen=;',
  'Zahlenkomma=,',
  'Datumsformat=TT.MM.JJJJ',
  'Stringbegrenzer="',
  'Kommentarzeichen=*',
  '',
  '[Satzbeschreibung]',
  '1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;pnr#bwd;bs_nr#bwd;bs_wert_butab#bwd;la_eigene#bwd;',
  '2;u_lod_bwd_buchung_kalendarium;abrechnung_zeitraum#bwd;pnr#bwd;kalendertag#bwd;as_kal#bwd;',
  '',
  '[Bewegungsdaten]',
  '1;01.10.2026;42;2;200,00;420;',
  '2;01.10.2026;42;05;"U";',
  '2;01.10.2026;42;06;"U";',
  '',
  '[Hinweisdaten]',
  '"oHRganize, Musterfirma GmbH: Lohnexport 10/2026, erzeugt 12.10.2026, 14:03"',
];
for (let i = 0; i < expectBwd.length; i++) {
  check(`LODAS Bewegungsdaten Zeile ${i + 1}`, bwd[i] === expectBwd[i], { ist: bwd[i], soll: expectBwd[i] });
}
check('LODAS Bewegungsdaten: Hinweis zum halben Tag', bwd.some((l) => l === '"Müller, Anna (42): 06.10.2026 Urlaub nur ein halber Tag"'), bwd);
check('LODAS Bewegungsdaten: Personenhinweis in den Hinweisdaten', bwd.some((l) => l === '"Klein, Ben (2): Keine Personalnummer gepflegt, die Profil-ID wird übergeben"'), bwd);
check('LODAS Bewegungsdaten: Stammdatenwarnungen (IBAN) gehoeren nicht in diese Datei', !bwd.some((l) => /IBAN fehlt/.test(l)));
check('LODAS Bewegungsdaten: keine Festbezuege als Buchung', !bwd.some((l) => l.includes(';5200,00;')));
check('LODAS Bewegungsdaten endet mit CR/LF', renderLodasBewegungsdaten(ctx, report).endsWith('\r\n'));
check('LODAS Bewegungsdaten: kein Datum=-Schluessel mehr', !bwd.some((l) => l.startsWith('Datum=')));

// Festbezuege als monatliche Buchung, Vertragsstunden, betriebliche Personalnummer
const ctxB = context({ festbezuege: 'bewegungsdaten', vertragsstunden: true, betrieblichePnr: true }, [
  person({ pnr: 'P-0042' }),
  person({ employee_id: 2, pnr: 'P-0007', first_name: 'Ben', last_name: 'Klein', components: [{ kind: 'stundenlohn', amount_cents: 1350, monthly_cents: 29228 }], bonuses: [], absences: [], weekly_hours: 5, flags: [] }),
]);
const bwdB = renderLodasBewegungsdaten(ctxB, checkDatevExport(ctxB)).split('\r\n');
check('Betriebliche PNr: Schalter im Kopf', bwdB.includes('BetrieblichePNrVerwenden=Ja'));
check('Betriebliche PNr: Schluesselfeld pnr_betriebliche#psd auch in Bewegungsdaten', bwdB.includes('1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;pnr_betriebliche#psd;bs_nr#bwd;bs_wert_butab#bwd;la_eigene#bwd;'));
check('Festbezug als Bruttobezug BS 2', bwdB.includes('1;01.10.2026;"P-0042";2;5200,00;200;'), bwdB);
check('VWL als Bruttobezug BS 2', bwdB.includes('1;01.10.2026;"P-0042";2;40,00;510;'));
check('Sonstiger Abzug als Nettoabzug BS 3 ohne Vorzeichen', bwdB.includes('1;01.10.2026;"P-0042";3;25,00;12;'));
check('Vertragsstunden BS 1 (5 h x 4,33 = 21,65)', bwdB.includes('1;01.10.2026;"P-0007";1;21,65;300;'), bwdB);
check('Vertragsstunden werden in den Hinweisdaten genannt', bwdB.some((l) => /Vertragsstunden/.test(l)));
const ctxNull = context({ vertragsstunden: true }, [ben({ weekly_hours: null, pnr: '7', has_personnel_number: true })]);
const bwdNull = renderLodasBewegungsdaten(ctxNull, checkDatevExport(ctxNull)).split('\r\n');
check('Ohne Wochenstunden: Vertragsstunden wie im Lauf mit 40 h (173,20)', bwdNull.includes('1;01.10.2026;7;1;173,20;300;'), bwdNull);

// ---------------------------------------------------------------------------
// LODAS Stammdaten
// ---------------------------------------------------------------------------
const psd = renderLodasStammdaten(ctx, report, 'alle').split('\r\n');
check('Stammdaten: StammdatenGueltigAb im Kopf', psd.includes('StammdatenGueltigAb=01.10.2026'));
check('Stammdaten: Satzbeschreibung Mitarbeiter', psd.includes('1;u_lod_psd_mitarbeiter;pnr#psd;duevo_familienname#psd;duevo_vorname#psd;adresse_strassenname#psd;adresse_strasse_nr#psd;adresse_plz#psd;adresse_ort#psd;geburtsdatum_ttmmjj#psd;sozialversicherung_nr#psd;'));
check('Stammdaten: Mitarbeitersatz Anna', psd.includes('1;42;"Müller";"Anna";"Baustraße";"27a";80331;"München";02.03.1988;"15070649C103";'), psd);
check('Stammdaten: Bank', psd.includes('2;42;"DE02120300000000202051";"BYLADEM1001";'));
check('Stammdaten: Steuer (ID, Klasse 3, 1,5 Kinder, rk = 11)', psd.includes('3;42;"86095742719";3;1,5;11;'), psd);
check('Stammdaten: bestehende Person ohne Personengruppe (LODAS behaelt die eigene)', psd.includes('4;42;;"Entwicklerin";'), psd);
check('Stammdaten: Beschaeftigung (Eintritt, kein Austritt, unbefristet = 0)', psd.includes('5;42;01.01.2020;;0;'));
check('Stammdaten: Festbezug Grundgehalt (id 1, Lohnart 200)', psd.includes('6;42;1;200;5200,00;'));
check('Stammdaten: Festbezug VWL (id 8, Lohnart 510)', psd.includes('6;42;8;510;40,00;'));
check('Stammdaten: Nettoabzug (nba_nr 12)', psd.includes('8;42;1;12;25,00;'));
check('Stammdaten: Stundensatz Ben 13,50', psd.includes('7;2;13,50;'), psd);
check('Stammdaten: Neueintritt Minijob mit Personengruppe 109 ohne Beruf', psd.includes('4;2;109;;'));
check('Stammdaten: Bank fehlt bei Ben', !psd.some((l) => l.startsWith('2;2;')));
check('Stammdaten: Steuer bei Ben ohne Merkmale fehlt', !psd.some((l) => l.startsWith('3;2;')));
check('Stammdaten: Hinweis zur Personengruppe', psd.some((l) => /Personengruppe \(persgrs\)/.test(l)));
check('Stammdaten: Stammdatenwarnung (IBAN) in den Hinweisdaten', psd.some((l) => l === '"Klein, Ben (2): IBAN fehlt"'), psd);
const psdChanges = renderLodasStammdaten(ctx, report, 'aenderungen');
check('Stammdaten „Aenderungen“: beide Personen (Gehaltsaenderung, Neueintritt)', psdChanges.includes('1;42;') && psdChanges.includes('1;2;'));
const ctxOne = context({}, [person({ flags: [] }), ben()]);
const psdOne = renderLodasStammdaten(ctxOne, checkDatevExport(ctxOne), 'aenderungen');
check('Stammdaten „Aenderungen“: Person ohne Aenderung fehlt', !psdOne.includes('1;42;') && psdOne.includes('1;2;'));
check('Stammdaten „Aenderungen“: Hinweisdaten nur zu Personen in der Datei', !psdOne.includes('Müller, Anna'), psdOne);
const ctxIban = context({}, [person({ flags: [], changed_in_month: true })]);
check(
  'Stammdaten „Aenderungen“: geaenderte Personalakte (neue IBAN) ist dabei',
  renderLodasStammdaten(ctxIban, checkDatevExport(ctxIban), 'aenderungen').includes('2;42;"DE02'),
);
const ctxEnded = context({}, [person({ flags: [], ended_kinds: ['zulage_schicht'], ended_recently: true })]);
const psdEnded = renderLodasStammdaten(ctxEnded, checkDatevExport(ctxEnded), 'aenderungen');
check('Stammdaten: entfallener Festbezug geht mit 0,00 unter seiner Kennung', psdEnded.includes('6;42;2;210;0,00;'), psdEnded);
const ctxAddr = context({}, [person({ private_country: 'AT' }), person({ employee_id: 5, pnr: '5', private_zip: 'D-80331' })]);
const psdAddr = renderLodasStammdaten(ctxAddr, checkDatevExport(ctxAddr), 'alle');
check(
  'Stammdaten: Auslandsanschrift und ungueltige PLZ lassen alle Anschriftfelder leer',
  psdAddr.includes('1;42;"Müller";"Anna";;;;;02.03.1988;') && psdAddr.includes('1;5;"Müller";"Anna";;;;;02.03.1988;'),
  psdAddr,
);
const ctxExit = context({}, [person({ hire_date: null, exit_date: '2026-10-20', flags: ['austritt'], contract_type: null })]);
check(
  'Stammdaten: Austritt geht auch ohne Eintrittsdatum mit',
  renderLodasStammdaten(ctxExit, checkDatevExport(ctxExit), 'aenderungen').includes('5;42;;20.10.2026;;'),
);
const ctxNewKind = context({}, [
  person({
    flags: [],
    components: [
      { kind: 'grundgehalt', amount_cents: 520000, monthly_cents: 520000, valid_from: '2020-01-01' },
      { kind: 'zulage_schicht', amount_cents: 15000, monthly_cents: 15000, valid_from: '2026-10-01' },
    ],
  }),
]);
check(
  'Stammdaten „Aenderungen“: erstmals angelegte Zulage (ohne Flag, Personalakte unveraendert) ist dabei',
  renderLodasStammdaten(ctxNewKind, checkDatevExport(ctxNewKind), 'aenderungen').includes('6;42;2;210;150,00;'),
);
// Eine Lohnart, die nur eine Person ausserhalb der Datei braucht, sperrt sie nicht.
const ctxOutside = context({ lohnarten: { ...DATEV_LOHNART_DEFAULTS, abzug_sonstig: '' } }, [person({ flags: [] }), ben()]);
const outsideReport = checkDatevExport(ctxOutside);
check(
  'Fehlende Nettoabzugsnummer nur bei Anna: sperrt die Stammdaten mit Anna, nicht die „Aenderungen“ ohne sie',
  issuesForFile(outsideReport.issues, 'stammdaten', null).some((i) => i.level === 'fehler' && /Sonstiger Abzug/.test(i.message)) &&
    !issuesForFile(outsideReport.issues, 'stammdaten', new Set([2])).some((i) => i.level === 'fehler'),
  outsideReport.issues,
);
const ctxBadIds = context({}, [
  person({ iban: 'DE02120300000000202015', tax_id: '86095742710', social_security_number: '15070649C104' }),
]);
const psdBadIds = renderLodasStammdaten(ctxBadIds, checkDatevExport(ctxBadIds), 'alle');
check(
  'Ungueltige IBAN, Steuer-ID und SV-Nummer gehen nicht hinaus (LODAS behaelt die bisherigen)',
  !psdBadIds.includes('2;42;') && psdBadIds.includes('3;42;;3;1,5;11;') && psdBadIds.includes(';02.03.1988;;\r\n'),
  psdBadIds,
);
const badIdsReport = checkDatevExport(
  context({}, [
    person({ iban: 'DE02120300000000202015' }),
    ben({ pnr: '7', has_personnel_number: true, iban: 'DE02120300000000202015' }),
  ]),
);
check(
  'Ungueltige IBAN: Bestand behaelt den bisherigen Wert, Neueintritt muss im Lohnprogramm erfasst werden',
  badIdsReport.issues.some((i) => i.employee_id === 1 && /IBAN ist ungültig.*bisherigen Wert/.test(i.message)) &&
    badIdsReport.issues.some((i) => i.employee_id === 2 && /IBAN ist ungültig.*im Lohnprogramm erfassen/.test(i.message)),
  badIdsReport.issues,
);
const ctxSemicolon = context({}, [person({ job_title: 'Entwicklung; Teamleitung' })]);
check(
  'Textfelder ohne Feldtrenner (Semikolon wird Komma)',
  renderLodasStammdaten(ctxSemicolon, checkDatevExport(ctxSemicolon), 'alle').includes('4;42;;"Entwicklung, Teamleitung";'),
);
const ctxHalfUnmapped = context({ ausfallschluessel: {} });
check(
  'Halbe Fehltage ohne Ausfallschluessel: kein Hinweis zum Kalendarium (sie gehen nicht mit)',
  !checkDatevExport(ctxHalfUnmapped).issues.some((i) => /Halbe Fehltage/.test(i.message)),
);
const psdNoFest = renderLodasStammdaten(ctxB, checkDatevExport(ctxB), 'alle').split('\r\n');
check(
  'Festbezuege als Buchung: Stammdaten ohne Satzarten 6 und 8, Stundensatz (7) trotzdem',
  !psdNoFest.some((l) => /^[68];/.test(l)) && psdNoFest.includes('7;"P-0007";13,50;'),
  psdNoFest,
);

// ---------------------------------------------------------------------------
// Lohn und Gehalt
// ---------------------------------------------------------------------------
const ctxLug = context({ program: 'lug', festbezuege: 'bewegungsdaten', vertragsstunden: true });
const lug = renderLugBewegungsdaten(ctxLug).split('\r\n');
check('LuG: elf Felder je Zeile', lug.filter(Boolean).every((l) => l.split(';').length === 11), lug);
check('LuG: Grundgehalt als Wert', lug.includes('42;;;200;;;5200,00;;;;'), lug);
check('LuG: Bonus als Wert', lug.includes('42;;;420;;;200,00;;;;'));
check('LuG: Abzug als Wert ohne Vorzeichen', lug.includes('42;;;12;;;25,00;;;;'));
check('LuG: Fehltag mit Ausfallschluessel und Tagesanzahl', lug.includes('42;05.10.2026;U;;;1;;;;;') && lug.includes('42;06.10.2026;U;;;0,5;;;;;'), lug);
check('LuG: Vertragsstunden in Spalte 5, Stundensatz als abweichender Faktor', lug.includes('2;;;300;21,65;;;13,50;;;'), lug);
check('LuG: kein Kopf, keine Abschnitte', !lug.some((l) => l.startsWith('[')));
const lugReport = checkDatevExport(ctxLug);
check('LuG: nur Bewegungsdaten als Datei', lugExporter.kinds.join() === 'bewegungsdaten' && lugReport.error_count === 0);
const lugNoHours = checkDatevExport(context({ program: 'lug' }));
check('LuG ohne Vertragsstunden: Warnung zu Stundenlohn', lugNoHours.issues.some((i) => /Ist-Stunden/.test(i.message)));

if (failures > 0) {
  console.error(`${failures} DATEV-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle DATEV-Checks bestanden.');
