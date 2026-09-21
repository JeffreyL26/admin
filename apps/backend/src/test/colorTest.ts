/**
 * Prueft die Farbmathematik aus @ohrganize/shared (color.ts), auf der der
 * Farbwaehler der Desktop-App steht. Kern ist die Kein-Drift-Garantie: Jeder
 * der 16.777.216 Hex-Werte muss die Kette hex -> hsv -> hex unveraendert
 * ueberstehen, sonst aenderte sich eine Farbe schon beim Oeffnen des Waehlers.
 *
 * Aufruf: tsx src/test/colorTest.ts (Teil von npm test)
 */
import { hsvFromHex, hsvToHex, hsvToRgb, normalizeHex, rgbToHsv, hexToRgb } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const prev = { h: 123.4, s: 0.7, v: 0.3 };
let drift = 0;
for (let n = 0; n <= 0xffffff; n++) {
  const r = n >> 16;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const hsv = rgbToHsv({ r, g, b });
  const back = hsvToRgb({ h: hsv.h ?? prev.h, s: hsv.v === 0 ? prev.s : hsv.s, v: hsv.v });
  if (back.r !== r || back.g !== g || back.b !== b) {
    drift++;
    if (drift <= 5) console.log(`FEHLER Drift bei rgb(${r},${g},${b}) -> rgb(${back.r},${back.g},${back.b})`);
  }
}
check('kein Drift ueber alle 2^24 Werte', drift === 0, { drift });

let hexDrift = 0;
for (let n = 0; n <= 0xffffff; n += 97) {
  const hex = `#${n.toString(16).padStart(6, '0')}`;
  if (hsvToHex(hsvFromHex(hex, prev)) !== hex) hexDrift++;
}
check('kein Drift auf dem Hex-Pfad (Stichprobe)', hexDrift === 0, { hexDrift });

const kept = hsvFromHex('#808080', { h: 210, s: 1, v: 1 });
check('Farbton bleibt bei Grau', kept.h === 210 && kept.s === 0 && Math.abs(kept.v - 128 / 255) < 1e-12, kept);
const black = hsvFromHex('#000000', { h: 210, s: 1, v: 1 });
check('Farbton und Saettigung bleiben bei Schwarz', black.h === 210 && black.s === 1 && black.v === 0, black);
const white = hsvFromHex('#ffffff', { h: 47, s: 0.5, v: 0.2 });
check('Farbton bleibt bei Weiss', white.h === 47 && white.s === 0 && white.v === 1, white);
check('Grau hat keinen Farbton', rgbToHsv(hexToRgb('#7f7f7f')).h === null);
check('Rot hat Farbton 0', rgbToHsv(hexToRgb('#ff0000')).h === 0);
check('Cyan hat Farbton 180', rgbToHsv(hexToRgb('#00ffff')).h === 180);

const cases: [string, string | null][] = [
  ['  #ABC ', '#aabbcc'],
  ['0864C6', '#0864c6'],
  ['#0864c6', '#0864c6'],
  ['#abcd', null],
  ['#abcdef00', null],
  ['', null],
  ['#', null],
  ['#12g456', null],
];
for (const [input, expected] of cases) {
  check(`normalizeHex(${JSON.stringify(input)})`, normalizeHex(input) === expected, {
    got: normalizeHex(input),
    expected,
  });
}

check('360 Grad ist Rot', hsvToHex({ h: 360, s: 1, v: 1 }) === '#ff0000');
check('0 Grad ist Rot', hsvToHex({ h: 0, s: 1, v: 1 }) === '#ff0000');
check('negativer Farbton wird umgerechnet', hsvToHex({ h: -120, s: 1, v: 1 }) === '#0000ff');
check('NaN wird geklemmt', hsvToHex({ h: Number.NaN, s: Number.NaN, v: Number.NaN }) === '#000000');

if (failures > 0) {
  console.log(`colorTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('colorTest: alle Pruefungen bestanden');
