/**
 * Prueft die gemeinsamen Rechte-Regeln in packages/shared, die Backend (Rangpruefung,
 * core/accountRights.ts) und Desktop-App (Rollenverwaltung, Abgleich des eigenen Kontos)
 * beide benutzen: levelsBeyond, permissionRank, variantAreas, areasOutsideVariant,
 * sameRecordExcept.
 *
 * Aufruf: tsx src/test/rightsRulesTest.ts (Teil von npm test)
 */
import {
  ADMIN_AREAS,
  FULL_ACCESS,
  MODULE_KEYS,
  areasOutsideVariant,
  levelsBeyond,
  permissionRank,
  sameRecordExcept,
  variantAreas,
  type AdminPermissions,
} from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const none = Object.fromEntries(ADMIN_AREAS.map((a) => [a, 'kein'])) as AdminPermissions;
const with_ = (p: Partial<AdminPermissions>): AdminPermissions => ({ ...none, ...p });

// ------------------------------------------------------------ permissionRank --
check('Rang: kein < lesen < bearbeiten', permissionRank('kein') < permissionRank('lesen') && permissionRank('lesen') < permissionRank('bearbeiten'));
check('Rang: fehlende Stufe zaehlt wie kein', permissionRank(undefined) === permissionRank('kein'));

// -------------------------------------------------------------- levelsBeyond --
check('Gleiche Rechte: nichts darueber', levelsBeyond(FULL_ACCESS, FULL_ACCESS).length === 0);
check('Vollzugriff deckt alles', levelsBeyond(with_({ verguetung: 'bearbeiten' }), FULL_ACCESS).length === 0);
const r1 = levelsBeyond(with_({ verguetung: 'bearbeiten', personal: 'lesen' }), with_({ verguetung: 'lesen', personal: 'lesen' }));
check('bearbeiten gegen lesen ist darueber, lesen gegen lesen nicht', r1.join() === 'verguetung', r1);
const r2 = levelsBeyond({ kommunikation: 'lesen' }, {});
check('Fehlende Stufe auf beiden Seiten zaehlt wie kein', r2.join() === 'kommunikation', r2);
check('Weniger ist nie darueber', levelsBeyond(none, FULL_ACCESS).length === 0);

// ------------------------------------------------ variantAreas / outside --
const full = { modules: [...MODULE_KEYS] };
const noComm = { modules: MODULE_KEYS.filter((m) => m !== 'communication') };
check('Vollversion: alle Bereiche', variantAreas(full).length === ADMIN_AREAS.length);
check('Ohne Kommunikation: Bereich fehlt, Einstellungen bleiben', !variantAreas(noComm).includes('kommunikation') && variantAreas(noComm).includes('einstellungen'));
const out = areasOutsideVariant(noComm, with_({ kommunikation: 'bearbeiten', personal: 'bearbeiten' }));
check('Recht auf fehlendes Modul liegt ausserhalb', out.join() === 'kommunikation', out);
check('kein auf fehlendem Modul liegt nicht ausserhalb', areasOutsideVariant(noComm, none).length === 0);
check('Vollversion: nichts ausserhalb', areasOutsideVariant(full, FULL_ACCESS).length === 0);

// ---------------------------------------------------------- sameRecordExcept --
const claims = new Set(['iat', 'session', 'auth_time', 'exp']);
const login = { id: 1, email: 'a@b.de', name: 'A', role: 'admin', employee_id: null, admin_role_id: 3, must_change_password: 0 };
const me = { must_change_password: 0, admin_role_id: 3, employee_id: null, role: 'admin', name: 'A', email: 'a@b.de', id: 1, iat: 1, session: 'desktop', auth_time: 0 };
check('Gleiches Konto trotz Token-Angaben und anderer Reihenfolge', sameRecordExcept(login, me, claims));
check('Geaenderte Rolle zaehlt', !sameRecordExcept(login, { ...me, admin_role_id: 4 }, claims));
check('Neues Kontofeld zaehlt von selbst', !sameRecordExcept(login, { ...me, display_name: 'X' }, claims));

if (failures > 0) {
  console.error(`${failures} Pruefung(en) fehlgeschlagen`);
  process.exit(1);
}
console.log('Rechte-Regeln in Ordnung');
