/**
 * HTML-Uebersicht als statische Datei.
 *
 * Bewusst eine Datei ohne Server, ohne Skript und ohne externe Schrift: Sie
 * soll sich per Doppelklick oeffnen lassen, auch in fuenf Jahren und auch auf
 * einem Rechner ohne Netz. Dieselbe Sicht wie `uebersicht`, nur ausdruckbar.
 */
import { todayIsoLocal } from '@ohrganize/shared';
import { openRegister } from './db.js';
import { instanceLicenses } from './licenses.js';
import { sammleBefunde } from './commands/check.js';
import type { InstanzRow } from './commands/instanz.js';

function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildHtml(): string {
  const { db } = openRegister();
  const heute = todayIsoLocal();
  const instanzen = db
    .prepare(
      `SELECT i.*, k.name AS kunde_name, h.adresse AS host_adresse
       FROM instanzen i
       JOIN kunden k ON k.id = i.kunde_id
       LEFT JOIN hosts h ON h.id = i.host_id
       ORDER BY k.name, i.id`,
    )
    .all() as (InstanzRow & { kunde_name: string; host_adresse: string | null })[];
  const licenses = instanceLicenses();
  const befunde = sammleBefunde(30, licenses);

  const zeilen = instanzen
    .map((i) => {
      const l = licenses.get(i.id)?.running;
      const bis = l ? (l.unbefristet ? 'unbefristet' : l.gueltig_bis) : 'keine Lizenz';
      const kritisch = !l || (l.unbefristet === 0 && l.gueltig_bis < heute);
      return `<tr${kritisch ? ' class="warn"' : ''}>
        <td>${escape(i.kunde_name)}</td>
        <td><code>${escape(i.id)}</code></td>
        <td>${escape(i.host_id ?? '-')}</td>
        <td>${escape(i.variante)}</td>
        <td>${escape(i.version ?? '-')}${i.kanal ? ` <span class="tag">${escape(i.kanal)}</span>` : ''}</td>
        <td>${escape(i.lizenz_zustand ?? '-')}</td>
        <td>${escape(bis)}</td>
        <td class="num">${escape(i.aktive_profile ?? '-')}</td>
        <td>${escape((i.zuletzt_gesehen ?? '').slice(0, 10) || '-')}</td>
      </tr>`;
    })
    .join('\n');

  const befundZeilen = befunde
    .map(
      (b) =>
        `<tr class="${b.schwere}"><td>${escape(b.schwere)}</td><td><code>${escape(b.was)}</code></td><td>${escape(b.text)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oHRganize Anbieteruebersicht ${escape(heute)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1a2233; margin: 32px auto; max-width: 1100px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #5a6478; font-size: 13px; margin-bottom: 28px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid #d8dee9; vertical-align: top; }
  th { background: #f2f5f9; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-family: Consolas, monospace; font-size: 13px; }
  .tag { background: #e7edf6; border-radius: 3px; padding: 0 5px; font-size: 12px; }
  tr.warn td, tr.hoch td { background: #fdecec; }
  tr.mittel td { background: #fff6e5; }
  .leer { color: #5a6478; font-style: italic; }
</style>
</head>
<body>
<h1>oHRganize Anbieteruebersicht</h1>
<p class="meta">Stand ${escape(heute)} &middot; ${instanzen.length} Instanz(en) &middot; ${befunde.length} Befund(e)</p>

<h2>Instanzen</h2>
${
  instanzen.length === 0
    ? '<p class="leer">Noch keine Instanz im Register.</p>'
    : `<table>
<thead><tr><th>Kunde</th><th>Instanz</th><th>Host</th><th>Ausgabe</th><th>Version</th><th>Lizenz</th><th>gueltig bis</th><th class="num">Profile</th><th>gesehen</th></tr></thead>
<tbody>
${zeilen}
</tbody></table>`
}

<h2>Offene Punkte</h2>
${
  befunde.length === 0
    ? '<p class="leer">Kein Befund.</p>'
    : `<table>
<thead><tr><th>Schwere</th><th>Betrifft</th><th>Befund</th></tr></thead>
<tbody>
${befundZeilen}
</tbody></table>`
}

<p class="meta">Erzeugt von conspectus. Die Zahlen stammen aus dem Register;
Version, Lizenzzustand und Profilzahl sind so aktuell wie der letzte Bericht
(<code>conspectus status --host &lt;host&gt;</code>).</p>
</body>
</html>
`;
}
