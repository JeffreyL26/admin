/** Datumshelfer — alle Datumswerte in DB und API sind ISO-Strings (YYYY-MM-DD). */

/**
 * Heutiges Datum in LOKALER Serverzeit (Serverzeit = Firmenzeit) — delegiert
 * an @ohrganize/shared; das Warum (UTC wäre nachts noch der Vortag) steht dort.
 */
export { todayIsoLocal as todayIso } from '@ohrganize/shared';

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Alle ISO-Daten von from bis to (einschließlich). */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) days.push(d);
  return days;
}

export function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
