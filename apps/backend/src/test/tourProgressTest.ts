/**
 * Prueft die Fortschrittsregel der Seiten-Einfuehrungen (packages/shared/src/tours.ts,
 * `tourStepHit`): Welchen Schritt hakt ein Ereignis ab, und wann holt `catchUp` davor liegende nach?
 *
 * Aufruf: tsx src/test/tourProgressTest.ts (Teil von npm test)
 */
import { tourStepHit, type TourStepProgress } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const step = (event: string, page?: string, catchUp = false): TourStepProgress => ({ event, page, catchUp });

const pageKeys = ['a', 'b'];
const steps = [
  step('a1'), // 0: erste Seite ohne `page`
  step('a2', 'a', true), // 1: erste Seite, ausdruecklich benannt
  step('b1', 'b'), // 2
  step('b2', 'b', true), // 3
  step('b3', 'b', true), // 4
];
const stepHit = (index: number, total: number, name: string) => tourStepHit(steps, pageKeys, index, total, name);

check('Schritt, der dran ist, zaehlt', stepHit(0, 5, 'a1') === 0);
check('Fremdes Ereignis zaehlt nicht', stepHit(0, 5, 'zzz') === -1);
check('Spaeterer Schritt ohne catchUp zaehlt nicht', stepHit(0, 5, 'b1') === -1);
check('catchUp auf derselben Seite (ohne page gegen benannte erste Seite)', stepHit(0, 5, 'a2') === 1);
check('catchUp ueber eine andere Seite hinweg wird abgelehnt', stepHit(0, 5, 'b2') === -1);
check('catchUp von der Seite des Schritts aus zaehlt', stepHit(2, 5, 'b3') === 4);
check('catchUp hinter der sichtbaren Schrittzahl zaehlt nicht', stepHit(2, 4, 'b3') === -1);

if (failures > 0) {
  console.error(`${failures} Pruefung(en) fehlgeschlagen`);
  process.exit(1);
}
console.log('Fortschrittsregel der Einfuehrungen in Ordnung');
