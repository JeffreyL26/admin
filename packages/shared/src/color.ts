/**
 * Farbmathematik fuer die Farbwahl in den Clients: Hex <-> RGB <-> HSV, rein
 * und ohne DOM. HSV ist die Arbeitsdarstellung eines Farbwaehlers (Farbton,
 * Saettigung, Helligkeit), Hex '#rrggbb' der Vertrag mit DB und API.
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  /** Farbton in Grad, 0 bis 360. */
  h: number;
  /** Saettigung 0 bis 1. */
  s: number;
  /** Helligkeit (Value) 0 bis 1. */
  v: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/;

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** '#rrggbb' in Kleinbuchstaben oder null; toleriert Kurzform, fehlendes '#', Leerraum und Grossschreibung. */
export function normalizeHex(input: string): string | null {
  const m = HEX_PATTERN.exec(input.replace(/\s+/g, '').toLowerCase());
  if (!m) return null;
  const digits = m[1]!;
  return `#${digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits}`;
}

export function hexToRgb(hex6: string): Rgb {
  return {
    r: parseInt(hex6.slice(1, 3), 16),
    g: parseInt(hex6.slice(3, 5), 16),
    b: parseInt(hex6.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** h ist null bei Grau, Schwarz und Weiss: dort gibt es keinen Farbton. */
export function rgbToHsv({ r, g, b }: Rgb): { h: number | null; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  if (d === 0) return { h: null, s, v };
  let h: number;
  if (max === rn) h = 60 * ((gn - bn) / d);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  return { h, s, v };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = clamp01(v) * clamp01(s);
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = clamp01(v) - c;
  const sector = Math.floor(hh);
  const [rr, gg, bb] =
    sector === 0 ? [c, x, 0]
    : sector === 1 ? [x, c, 0]
    : sector === 2 ? [0, c, x]
    : sector === 3 ? [0, x, c]
    : sector === 4 ? [x, 0, c]
    : [c, 0, x];
  const channel = (k: number) => Math.round(clamp01(k + m) * 255);
  return { r: channel(rr), g: channel(gg), b: channel(bb) };
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/**
 * HSV aus einem normalisierten Hex, wobei ein vorheriger Zustand das ergaenzt,
 * was der Hex nicht traegt: den Farbton bei Grau, Schwarz und Weiss, die
 * Saettigung bei Schwarz. Sonst spraenge der Farbtonregler beim Ziehen an den
 * Rand der Flaeche auf Rot.
 */
export function hsvFromHex(hex6: string, prev: Hsv): Hsv {
  const { h, s, v } = rgbToHsv(hexToRgb(hex6));
  return { h: h ?? prev.h, s: v === 0 ? prev.s : s, v };
}
