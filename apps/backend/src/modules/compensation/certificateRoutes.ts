import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/db.js';
import { parse, conflict, notFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { storeFile, signDownloadUrl, assertMayReadFile } from '../../core/files.js';
import { getSetting } from '../../core/settings.js';
import { todayIso } from '../../core/dates.js';
import {
  CERTIFICATE_KIND_LABELS,
  SALARY_COMPONENT_LABELS,
  formatDate,
  formatEuro,
  type CertificateKind,
} from '@hrmonic/shared';
import { componentsAt, getEmployee, monthlyCents, type EmployeeRow } from './lib.js';

const certificateSchema = z.object({
  employee_id: z.number().int().positive(),
  kind: z.enum(['lohnsteuerbescheinigung', 'arbeitgeberbescheinigung', 'entgeltbescheinigung_108']),
  period: z.string().trim().min(4, 'Jahr bzw. Zeitraum ist Pflicht').max(50),
  note: z.string().trim().max(500).optional().nullable(),
});

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
): string {
  const company = getSetting('companyName');
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
<title>${escapeHtml(title)} — ${escapeHtml(name)}</title>
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

export async function certificateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compensation/certificates', async (req) => {
    const { employee_id, kind } = req.query as { employee_id?: string; kind?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (employee_id) {
      conditions.push('c.employee_id = ?');
      params.push(Number(employee_id));
    }
    if (kind) {
      conditions.push('c.kind = ?');
      params.push(kind);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const certificates = getDb()
      .prepare(
        `SELECT c.*, e.first_name, e.last_name FROM certificates c
         JOIN employees e ON e.id = c.employee_id
         ${where} ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all(...params);
    return { certificates };
  });

  // Erstellen: generiert die HTML-Bescheinigung und legt sie via storeFile im
  // Backend-Storage ab (file_id) → Status 'erstellt'.
  app.post('/api/compensation/certificates', async (req, reply) => {
    const body = parse(certificateSchema, req.body);
    const employee = getEmployee(body.employee_id);
    const html = renderCertificateHtml(body.kind, body.period, employee);
    const fileName = `${body.kind}_${employee.last_name.toLowerCase()}_${body.period.replace(/[^\w-]/g, '_')}.html`;
    const file = storeFile(Buffer.from(html, 'utf8'), fileName, 'text/html; charset=utf-8', req.user.id);
    const info = getDb()
      .prepare(
        `INSERT INTO certificates (employee_id, kind, period, file_id, status, note)
         VALUES (?, ?, ?, ?, 'erstellt', ?)`,
      )
      .run(body.employee_id, body.kind, body.period, file.id, body.note ?? null);
    const certificate = getDb()
      .prepare('SELECT * FROM certificates WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    audit(req, 'certificate.create', 'certificate', Number(info.lastInsertRowid), {
      employee_id: body.employee_id,
      kind: body.kind,
      period: body.period,
      file_id: file.id,
    });
    reply.status(201);
    return { certificate };
  });

  // Ausgabe: kurzlebige signierte Download-URL der abgelegten Datei.
  //
  // Fachlich ein Lesevorgang; POST steht hier nur, damit der signierte Link
  // nicht selbst in einem Query-String (und damit im Proxy-Log) landet.
  // core/permissions.ts führt die Route deshalb in READ_ONLY_POST_ROUTES —
  // sonst käme eine Rolle mit verguetung: 'lesen' an keine einzige
  // Bescheinigung heran, die sie einsehen darf.
  app.post('/api/compensation/certificates/:id/sign', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const certificate = getDb().prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { file_id: number | null; employee_id: number; kind: string }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (!certificate.file_id) throw conflict('Für diese Bescheinigung liegt keine Datei vor');
    // Zweite Stufe, unabhängig vom Routenpräfix: Die signierte URL ist bis zum
    // Ablauf ein anmeldefreier Vollzugriff auf die Datei. Wer sie ausstellt,
    // muss die Datei auch lesen dürfen — geprüft über den Fachbereich der
    // referenzierenden Tabelle (hier 'verguetung').
    assertMayReadFile(req, certificate.file_id);
    // Der Link darf in keinem Cache landen (Browser, Proxy).
    reply.header('Cache-Control', 'no-store, private');
    audit(req, 'certificate.sign', 'certificate', id, {
      employee_id: certificate.employee_id,
      kind: certificate.kind,
      file_id: certificate.file_id,
    });
    return { url: signDownloadUrl(certificate.file_id) };
  });

  // Statusverwaltung: erstellt → ausgehaendigt.
  app.post('/api/compensation/certificates/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(z.object({ status: z.enum(['ausgehaendigt']) }), req.body);
    const db = getDb();
    const certificate = db.prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { id: number; employee_id: number; kind: string; status: string }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (certificate.status !== 'erstellt') {
      throw conflict(`Statuswechsel von „${certificate.status}" nach „${body.status}" ist nicht möglich`);
    }
    db.prepare('UPDATE certificates SET status = ? WHERE id = ?').run(body.status, id);
    audit(req, 'certificate.handover', 'certificate', id, {
      employee_id: certificate.employee_id,
      kind: certificate.kind,
      old_status: certificate.status,
      new_status: body.status,
    });
    return { certificate: db.prepare('SELECT * FROM certificates WHERE id = ?').get(id) };
  });

  app.delete('/api/compensation/certificates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const certificate = getDb().prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (certificate.status === 'ausgehaendigt') {
      throw conflict('Ausgehändigte Bescheinigungen können nicht gelöscht werden');
    }
    getDb().prepare('DELETE FROM certificates WHERE id = ?').run(id);
    audit(req, 'certificate.delete', 'certificate', id);
    reply.status(204);
  });
}
