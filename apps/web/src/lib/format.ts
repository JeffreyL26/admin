import { formatDate } from '@ohrganize/shared';

export { formatDate };

/** Heutiges Datum als ISO-String (lokale Zeitzone). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Langform, z. B. "Freitag, 28. August 2026". */
export function formatLongDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Zeitraum kompakt: "07.09. bis 11.09.2026" bzw. Einzeltag "12.06.2026". */
export function formatRange(from: string, to: string): string {
  if (from === to) return formatDate(from);
  const [y] = from.split('-');
  const sameYear = to.startsWith(y);
  const short = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  return sameYear ? `${short(from)} bis ${formatDate(to)}` : `${formatDate(from)} bis ${formatDate(to)}`;
}

/** Tageszahl mit halben Tagen: 0.5 → "0,5". */
export function formatDays(days: number): string {
  return days.toLocaleString('de-DE');
}

export function greeting(name: string): string {
  const h = new Date().getHours();
  const daytime = h < 11 ? 'Guten Morgen' : h < 17 ? 'Guten Tag' : 'Guten Abend';
  return `${daytime}, ${name}`;
}
