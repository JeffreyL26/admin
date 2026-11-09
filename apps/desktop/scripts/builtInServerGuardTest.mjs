// Prueft die Sperre gegen einen eingebauten Server ausserhalb einer
// Kundenausgabe (builtInServerGuard.mjs), ohne git und ohne Build.
// Aufruf: node scripts/builtInServerGuardTest.mjs (Teil von npm test -w apps/desktop).
import { builtInServerIsNull, builtInServerProblem } from './builtInServerGuard.mjs';

let failures = 0;
function check(label, ok, extra) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const NULL_LINE = 'export const BUILT_IN_SERVER: BuiltInServer | null = null;';
const SET_LINE = "export const BUILT_IN_SERVER: BuiltInServer | null = { url: CUSTOMER_SERVER, pins: CUSTOMER_SERVER_KEY_PINS };";
const base = { variantId: 'de-vollversion', edition: 'vollversion', branchName: 'main', onMainHistory: true };

// --- Erkennen der null-Zeile ---------------------------------------------------
check('null erkannt', builtInServerIsNull(NULL_LINE));
check('null mit Kommentar dahinter', builtInServerIsNull(`${NULL_LINE} // Einzelplatz`));
check('null ohne Typangabe und mit Leerraum', builtInServerIsNull('export const BUILT_IN_SERVER =  null ;'));
check('null ueber zwei Zeilen', builtInServerIsNull('export const BUILT_IN_SERVER: BuiltInServer | null =\n  null;'));
check('gesetzter Server ist nicht null', !builtInServerIsNull(SET_LINE));

// --- Regel -------------------------------------------------------------------------
check('main mit null: in Ordnung', builtInServerProblem({ ...base, source: NULL_LINE }) === null);
check(
  'Vollversion mit Server: Abbruch',
  (builtInServerProblem({ ...base, source: SET_LINE, branchName: 'feature', onMainHistory: false }) ?? '').includes('Vollversion'),
);
check(
  'Branch main mit Server (Register einer Kundenausgabe): Abbruch',
  (builtInServerProblem({ ...base, source: SET_LINE, variantId: 'de-kunde', edition: 'kunde' }) ?? '').includes('Branch main'),
);
check(
  'Tag aus der Geschichte von main (losgeloester HEAD): Abbruch',
  (
    builtInServerProblem({ ...base, source: SET_LINE, variantId: 'de-kunde', edition: 'kunde', branchName: 'HEAD' }) ?? ''
  ).includes('Geschichte von main'),
);
check(
  'Kundenausgabe auf ihrem Branch: in Ordnung',
  builtInServerProblem({ source: SET_LINE, variantId: 'de-dronivo', edition: 'dronivo', branchName: 'dronivo', onMainHistory: false }) === null,
);
check(
  'Kundenausgabe von einem Tag ihres Branches: in Ordnung',
  builtInServerProblem({ source: SET_LINE, variantId: 'de-dronivo', edition: 'dronivo', branchName: 'HEAD', onMainHistory: false }) === null,
);

if (failures > 0) {
  console.log(`builtInServerGuardTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('builtInServerGuardTest: ok');
