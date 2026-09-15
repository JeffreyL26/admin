/**
 * Bescheinigungen fuer Deutschland: welche Arten es gibt und wie sie
 * aussehen. Bescheinigungen sind Landesrecht (Paragraph 108 GewO, die
 * elektronische Lohnsteuerbescheinigung ueber ELStAM), deshalb liegt die
 * Vorlage je Land in einer eigenen Datei und die Route waehlt sie ueber die
 * Registry daneben (index.ts). AT und CH bekommen ihre Vorlagen, wenn der
 * Anbieter das Land verkauft.
 */
import {
  CERTIFICATE_KIND_LABELS,
  SALARY_COMPONENT_LABELS,
  formatDate,
  formatEuro,
  type CertificateKind,
} from '@ohrganize/shared';
import { todayIso } from '../../../core/dates.js';
import type { CompanySettings } from '../../../core/settings.js';
import { componentsAt, monthlyCents, type EmployeeRow } from '../lib.js';
import type { CertificateTemplate } from './index.js';

/** Bescheinigungsarten, die das deutsche Recht kennt. */
export const CERTIFICATE_KINDS_DE = [
  'lohnsteuerbescheinigung',
  'arbeitgeberbescheinigung',
  'entgeltbescheinigung_108',
] as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generiert eine saubere, druckfähige HTML-Bescheinigung mit Firmendaten aus
 * den Einstellungen und den Stammdaten der Mitarbeiter:in. Bei der
 * Entgeltbescheinigung werden die aktuell gültigen Gehaltskomponenten
 * tabellarisch ausgewiesen.
 */
function renderCertificateHtml(
  kind: CertificateKind,
  period: string,
  employee: EmployeeRow,
  settings: CompanySettings,
): string {
  const company = settings.companyName;
  const title = CERTIFICATE_KIND_LABELS[kind];
  const name = `${employee.first_name} ${employee.last_name}`;
  const today = todayIso();

  let bodyHtml = '';
  if (kind === 'entgeltbescheinigung_108') {
    const components = componentsAt(employee.id, today);
    const rows = components
      .map((c) => {
        const monthly = monthlyCents(c.kind, c.amount_cents, employee.weekly_hours);
        const label =
          SALARY_COMPONENT_LABELS[c.kind as keyof typeof SALARY_COMPONENT_LABELS] ?? c.kind;
        return `<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(
          c.kind === 'stundenlohn'
            ? `${formatEuro(c.amount_cents)} / Std.`
            : formatEuro(c.amount_cents),
        )}</td><td class="num">${escapeHtml(formatEuro(monthly))}</td></tr>`;
      })
      .join('\n');
    const total = components.reduce(
      (s, c) => s + monthlyCents(c.kind, c.amount_cents, employee.weekly_hours),
      0,
    );
    bodyHtml = `
      <p>Hiermit bescheinigen wir gemäß § 108 GewO die Zusammensetzung des
      Arbeitsentgelts für den Zeitraum <strong>${escapeHtml(period)}</strong>:</p>
      <table>
        <thead><tr><th>Vergütungskomponente</th><th class="num">Betrag</th><th class="num">Monatswert</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">Keine aktiven Gehaltskomponenten hinterlegt.</td></tr>'}</tbody>
        <tfoot><tr><th>Monatsbrutto gesamt</th><th></th><th class="num">${escapeHtml(formatEuro(total))}</th></tr></tfoot>
      </table>`;
  } else if (kind === 'arbeitgeberbescheinigung') {
    bodyHtml = `
      <p>Hiermit bestätigen wir, dass
      <strong>${escapeHtml(name)}</strong>${employee.job_title ? `, tätig als ${escapeHtml(employee.job_title)},` : ''}
      seit dem <strong>${escapeHtml(formatDate(employee.hire_date))}</strong> in einem
      ${employee.exit_date ? `bis zum ${escapeHtml(formatDate(employee.exit_date))} befristeten` : 'ungekündigten'}
      Beschäftigungsverhältnis bei ${escapeHtml(company)} steht.</p>
      <p>Diese Bescheinigung wird für den Zeitraum ${escapeHtml(period)} auf Wunsch der
      Mitarbeiter:in ausgestellt.</p>`;
  } else {
    bodyHtml = `
      <p>Ausdruck der elektronischen Lohnsteuerbescheinigung für
      <strong>${escapeHtml(name)}</strong> für den Zeitraum
      <strong>${escapeHtml(period)}</strong>.</p>
      <p>Steuer-ID: <strong>${escapeHtml(employee.tax_id ?? '— nicht hinterlegt —')}</strong></p>
      <p class="hint">Hinweis: Die verbindliche Übermittlung an die Finanzverwaltung erfolgt
      elektronisch (ELStAM/ELSTER); dieses Dokument dient als Ausdruck für die
      Unterlagen der Mitarbeiter:in.</p>`;
  }

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · ${escapeHtml(name)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1a2233; margin: 48px auto; max-width: 720px; line-height: 1.55; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0864c6; padding-bottom: 12px; margin-bottom: 32px; }
  .company { font-size: 20px; font-weight: 700; color: #0864c6; }
  h1 { font-size: 22px; margin: 24px 0 4px; }
  .meta { color: #5a6478; font-size: 14px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 15px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #d8dee9; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot th { border-top: 2px solid #1a2233; }
  .hint { color: #5a6478; font-size: 13px; }
  .signature { margin-top: 64px; }
  .signature .line { border-top: 1px solid #1a2233; width: 260px; padding-top: 4px; font-size: 13px; color: #5a6478; }
</style>
</head>
<body>
<header>
  <span class="company">${escapeHtml(company)}</span>
  <span>${escapeHtml(formatDate(today))}</span>
</header>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(name)} · Personalnummer ${employee.id} · Zeitraum ${escapeHtml(period)}</p>
${bodyHtml}
<div class="signature">
  <div class="line">Ort, Datum, Unterschrift Personalabteilung</div>
</div>
</body>
</html>`;
}

export const deCertificates: CertificateTemplate = {
  country: 'DE',
  kinds: CERTIFICATE_KINDS_DE,
  render: renderCertificateHtml,
};
