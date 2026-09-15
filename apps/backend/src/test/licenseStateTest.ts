/**
 * Tabellengetriebene Pruefung des reinen Zustandsautomaten
 * (core/licenseState.ts) und der Textregeln (shared/licenseText.ts):
 * jede Zeile der Texttabelle aus docs/umsetzungsplan-varianten-lizenz.md,
 * Abschnitt 2 C, plus Uhrenwarnung und Fremdbindung. Ohne Datenbank, ohne
 * Datei, ohne Uhr; laeuft in Millisekunden.
 *
 * Aufruf: tsx src/test/licenseStateTest.ts (Teil von npm test).
 */
import {
  LICENSE_ACTION_TEXT,
  LICENSE_MAX_DATE,
  addDaysIso,
  describeLicense,
  licenseMessage,
  type LicensePayload,
} from '@ohrganize/shared';
import { deriveLicenseState, type LicenseCore, type LoadedLicenseInput } from '../core/licenseState.js';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const TODAY = '2026-09-17';
const INSTALLATION_ID = 'a'.repeat(32);

function payload(over: Partial<LicensePayload>): LicensePayload {
  return {
    v: 1,
    license_id: 'L-1',
    kid: 'test',
    customer: 'Musterfirma GmbH',
    customer_id: 'muster',
    installation_id: INSTALLATION_ID,
    kind: 'standard',
    issued_at: '2026-09-01',
    valid_from: '2026-09-01',
    valid_until: '2027-12-31',
    grace_days: 14,
    warn_days: 30,
    max_users: null,
    notice: null,
    ...over,
  };
}

function loaded(p: LicensePayload | null, invalidReason: string | null = null): LoadedLicenseInput {
  return { exists: p !== null || invalidReason !== null, payload: p, invalidReason };
}

interface Case {
  name: string;
  today?: string;
  enforced?: boolean;
  licensedAt?: string | null;
  createdAt?: string;
  loaded: LoadedLicenseInput;
  clockWarning?: boolean;
  terms?: { billing: 'kostenfrei' | 'abo' | 'kauf' | 'individuell'; interval?: 'monatlich' | 'jaehrlich' | null; label?: string | null };
  headline?: string;
  expect: Partial<LicenseCore> & { markLicensed?: boolean };
  text: { headline: string; detail?: string; tone: string };
}

const cases: Case[] = [
  {
    name: 'entwicklung',
    enforced: false,
    loaded: loaded(null),
    expect: { state: 'entwicklung', read_only: false, days_left: null, perpetual: false },
    text: { headline: 'Entwicklungsverzeichnis, keine Lizenzprüfung.', detail: '', tone: 'neutral' },
  },
  {
    name: 'Testphase ohne Datei',
    createdAt: '2026-09-16 10:00:00',
    licensedAt: null,
    loaded: loaded(null),
    expect: { state: 'trial', read_only: false, warning: false, days_left: 28, valid_until: '2026-10-15', trial: true },
    text: { headline: 'Testphase bis 15.10.2026, noch 28 Tage.', detail: 'Ohne Lizenzdatei läuft oHRganize danach im Nur-Lese-Betrieb.', tone: 'info' },
  },
  {
    name: 'Testphase kurz vor Ende warnt',
    createdAt: '2026-08-22 10:00:00',
    licensedAt: null,
    loaded: loaded(null),
    expect: { state: 'trial', warning: true, days_left: 3 },
    text: { headline: 'Testphase bis 20.09.2026, noch 3 Tage.', tone: 'warning' },
  },
  {
    name: 'gültig, Testlizenz 3 Tage',
    loaded: loaded(payload({ kind: 'evaluation', valid_until: '2026-09-20', warn_days: 1, grace_days: 0 })),
    expect: { state: 'valid', warning: false, days_left: 3, grace_until: '2026-09-20', perpetual: false, issued_at: '2026-09-01' },
    text: { headline: 'Testlizenz bis 20.09.2026, noch 3 Tage.', detail: 'Danach Nur-Lese-Betrieb.', tone: 'info' },
  },
  {
    name: 'gültig, Testlizenz letzter Tag',
    loaded: loaded(payload({ kind: 'evaluation', valid_until: TODAY, warn_days: 1, grace_days: 0 })),
    expect: { state: 'valid', warning: true, days_left: 0 },
    text: { headline: 'Testlizenz bis 17.09.2026, heute letzter Tag.', tone: 'warning' },
  },
  {
    name: 'gültig, unbefristet, kostenfrei',
    loaded: loaded(payload({ valid_until: LICENSE_MAX_DATE })),
    terms: { billing: 'kostenfrei' },
    expect: { state: 'valid', warning: false, days_left: null, grace_until: null, perpetual: true, valid_until: LICENSE_MAX_DATE },
    text: { headline: 'Ihre Lizenz läuft unbegrenzt und kostenfrei.', detail: '', tone: 'neutral' },
  },
  {
    name: 'gültig, unbefristet, Kauf',
    loaded: loaded(payload({ valid_until: LICENSE_MAX_DATE })),
    terms: { billing: 'kauf' },
    expect: { state: 'valid', perpetual: true, days_left: null },
    text: { headline: 'Ihre Lizenz läuft unbegrenzt.', detail: 'Kauflizenz.', tone: 'neutral' },
  },
  {
    name: 'gültig, unbefristet, ohne terms (v1)',
    loaded: loaded(payload({ valid_until: LICENSE_MAX_DATE })),
    expect: { state: 'valid', perpetual: true },
    text: { headline: 'Ihre Lizenz läuft unbegrenzt.', detail: '', tone: 'neutral' },
  },
  {
    name: 'gültig, befristet, Abo jährlich',
    loaded: loaded(payload({ valid_until: '2027-12-31' })),
    terms: { billing: 'abo', interval: 'jaehrlich' },
    expect: { state: 'valid', warning: false, days_left: 470, grace_until: '2028-01-14', perpetual: false },
    text: { headline: 'Ihre Lizenz gilt bis 31.12.2027 (noch 470 Tage).', detail: 'Abonnement, jährliche Verlängerung.', tone: 'neutral' },
  },
  {
    name: 'gültig, befristet, Warnung',
    loaded: loaded(payload({ valid_until: '2026-09-29' })),
    expect: { state: 'valid', warning: true, days_left: 12 },
    text: { headline: 'Ihre Lizenz läuft am 29.09.2026 ab (noch 12 Tage).', detail: 'Bitte rechtzeitig verlängern.', tone: 'warning' },
  },
  {
    name: 'gültig mit Anbieter-Überschrift',
    loaded: loaded(payload({ valid_until: LICENSE_MAX_DATE })),
    terms: { billing: 'kostenfrei' },
    headline: 'Partnerlizenz der Musterfirma',
    expect: { state: 'valid', perpetual: true },
    text: { headline: 'Partnerlizenz der Musterfirma', detail: 'Ihre Lizenz läuft unbegrenzt und kostenfrei.', tone: 'neutral' },
  },
  {
    name: 'Kulanz',
    loaded: loaded(payload({ valid_until: '2026-09-12', grace_days: 14 })),
    expect: { state: 'grace', read_only: false, warning: true, days_left: 9, grace_until: '2026-09-26' },
    text: { headline: 'Ihre Lizenz ist am 12.09.2026 abgelaufen.', detail: 'Kulanz bis 26.09.2026, ab 27.09.2026 Nur-Lese-Betrieb (noch 9 Tage).', tone: 'danger' },
  },
  {
    name: 'Kulanz ignoriert Anbieter-Überschrift',
    loaded: loaded(payload({ valid_until: '2026-09-12', grace_days: 14 })),
    headline: 'Partnerlizenz',
    expect: { state: 'grace' },
    text: { headline: 'Ihre Lizenz ist am 12.09.2026 abgelaufen.', tone: 'danger' },
  },
  {
    name: 'Nur-Lese nach Lizenz',
    loaded: loaded(payload({ valid_until: '2026-08-01', grace_days: 14 })),
    expect: { state: 'expired', read_only: true, days_left: 0, grace_until: '2026-08-15' },
    text: {
      headline: 'Ihre Lizenz ist am 01.08.2026 abgelaufen; die Kulanzfrist endete am 15.08.2026.',
      detail: 'Nur-Lese-Betrieb: Daten können eingesehen und exportiert werden, Änderungen sind nicht möglich.',
      tone: 'danger',
    },
  },
  {
    name: 'Nur-Lese nach Testphase',
    createdAt: '2026-07-01 10:00:00',
    licensedAt: null,
    loaded: loaded(null),
    expect: { state: 'expired', read_only: true, trial: true, valid_until: '2026-07-30' },
    text: { headline: 'Die Testphase ist am 30.07.2026 abgelaufen.', tone: 'danger' },
  },
  {
    name: 'Datei unbrauchbar nach Lizenz',
    loaded: loaded(null, 'Die Signatur der Lizenzdatei ist ungültig.'),
    expect: { state: 'expired', read_only: true, invalid_reason: 'Die Signatur der Lizenzdatei ist ungültig.' },
    text: { headline: 'Die Lizenzdatei ist unbrauchbar.', tone: 'danger' },
  },
  {
    name: 'keine Datei nach Lizenz',
    loaded: loaded(null),
    expect: { state: 'expired', read_only: true, valid_until: null, invalid_reason: null },
    text: { headline: 'Es liegt keine gültige Lizenz vor.', tone: 'danger' },
  },
  {
    name: 'Fremdbindung: Datei anderer Installation zaehlt nicht',
    createdAt: '2026-09-16 10:00:00',
    licensedAt: null,
    loaded: loaded(payload({ installation_id: 'f'.repeat(32) })),
    expect: { state: 'trial', payload: null },
    text: { headline: 'Testphase bis 15.10.2026, noch 28 Tage.', tone: 'info' },
  },
  {
    name: 'abgelaufene Fremddatei beendet die Testphase nicht',
    createdAt: '2026-09-16 10:00:00',
    licensedAt: null,
    loaded: loaded(payload({ valid_until: '2026-06-01' })),
    expect: { state: 'trial', payload: null, markLicensed: false },
    text: { headline: 'Testphase bis 15.10.2026, noch 28 Tage.', tone: 'info' },
  },
  {
    name: 'erste gültige Lizenz markiert licensed_at',
    licensedAt: null,
    loaded: loaded(payload({})),
    expect: { state: 'valid', markLicensed: true },
    text: { headline: 'Ihre Lizenz gilt bis 31.12.2027 (noch 470 Tage).', tone: 'neutral' },
  },
  {
    name: 'Uhrenwarnung reist mit, sperrt nicht',
    loaded: loaded(payload({})),
    clockWarning: true,
    expect: { state: 'valid', read_only: false, clock_warning: true },
    text: { headline: 'Ihre Lizenz gilt bis 31.12.2027 (noch 470 Tage).', tone: 'neutral' },
  },
];

for (const c of cases) {
  const { core, markLicensed } = deriveLicenseState({
    today: c.today ?? TODAY,
    enforced: c.enforced ?? true,
    installation: {
      installation_id: INSTALLATION_ID,
      created_at: c.createdAt ?? '2026-01-01 10:00:00',
      licensed_at: c.licensedAt === undefined ? '2026-01-02 10:00:00' : c.licensedAt,
    },
    loaded: c.loaded,
    clockWarning: c.clockWarning ?? false,
  });
  const { markLicensed: expectMark, ...expectCore } = c.expect;
  for (const [key, value] of Object.entries(expectCore)) {
    const actual = (core as unknown as Record<string, unknown>)[key];
    check(`${c.name}: ${key}`, JSON.stringify(actual) === JSON.stringify(value), { expected: value, actual });
  }
  if (expectMark !== undefined) check(`${c.name}: markLicensed`, markLicensed === expectMark, markLicensed);

  const d = describeLicense({
    state: core.state,
    warning: core.warning,
    days_left: core.days_left,
    valid_until: core.valid_until,
    grace_until: core.grace_until,
    perpetual: core.perpetual,
    license_id: core.payload?.license_id ?? null,
    kind: core.payload?.kind ?? null,
    invalid_reason: core.invalid_reason,
    terms: c.terms ?? null,
    headline: c.headline ?? null,
  });
  check(`${c.name}: headline`, d.headline === c.text.headline, { expected: c.text.headline, actual: d.headline });
  if (c.text.detail !== undefined) check(`${c.name}: detail`, d.detail === c.text.detail, { expected: c.text.detail, actual: d.detail });
  check(`${c.name}: tone`, d.tone === c.text.tone, { expected: c.text.tone, actual: d.tone });
  check(`${c.name}: action`, d.action === LICENSE_ACTION_TEXT);
  const noDash = !new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`).test(`${d.headline} ${d.detail} ${d.action}`);
  check(`${c.name}: ohne Gedankenstrich`, noDash, d);
}

// Vollmeldung fuer 403 im Nur-Lese-Betrieb
const expiredCore = deriveLicenseState({
  today: TODAY,
  enforced: true,
  installation: { installation_id: INSTALLATION_ID, created_at: '2026-01-01 10:00:00', licensed_at: '2026-01-02 10:00:00' },
  loaded: loaded(payload({ valid_until: '2026-08-01', grace_days: 14 })),
  clockWarning: false,
}).core;
const msg = licenseMessage({
  ...expiredCore,
  license_id: expiredCore.payload?.license_id ?? null,
  kind: expiredCore.payload?.kind ?? null,
});
check('Nur-Lese-Meldung: Ursache, Erklärung, Handlung', /abgelaufen.*Nur-Lese-Betrieb.*Einstellungen → Lizenz/.test(msg), msg);

// addDaysIso ist die gemeinsame Tagesarithmetik
check('addDaysIso über Monatsgrenze', addDaysIso('2026-01-31', 1) === '2026-02-01');
check('addDaysIso rückwärts', addDaysIso('2026-03-01', -1) === '2026-02-28');

if (failures > 0) {
  console.error(`${failures} Zustands-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log(`Alle Zustands-Checks bestanden (${cases.length} Fälle).`);
