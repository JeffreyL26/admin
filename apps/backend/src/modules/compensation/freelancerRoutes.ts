import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/db.js';
import { parse, badRequest, conflict, notFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { isValidIsoDate } from '../../core/dates.js';
import { getEmployee } from './lib.js';

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum muss das Format JJJJ-MM-TT haben' });

const rateSchema = z.object({
  employee_id: z.number().int().positive(),
  description: z.string().trim().min(1, 'Eine Beschreibung ist Pflicht'),
  rate_cents: z.number().int().positive('Der Satz muss größer als 0 sein'),
  unit: z.enum(['stunde', 'tag', 'pauschale']),
  valid_from: isoDate,
});

const invoiceSchema = z.object({
  employee_id: z.number().int().positive(),
  invoice_number: z.string().trim().min(1, 'Eine Rechnungsnummer ist Pflicht'),
  invoice_date: isoDate,
  period: z.string().trim().max(100).optional().nullable(),
  amount_cents: z.number().int().positive('Der Betrag muss größer als 0 sein'),
  hours: z.number().positive().optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

/** Stellt sicher, dass die Person Freiberufler:in ist (serverseitige Prüfung). */
function assertFreelancer(employeeId: number): void {
  const employee = getEmployee(employeeId);
  if (employee.employee_type !== 'freiberufler') {
    throw badRequest('Diese Person ist keine Freiberufler:in — Honorare sind nur für employee_type=freiberufler möglich');
  }
}

export async function freelancerRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Honorarsätze ----------------

  app.get('/api/compensation/freelancer-rates', async (req) => {
    const { employee_id } = req.query as { employee_id?: string };
    const where = employee_id ? 'WHERE r.employee_id = ?' : '';
    const params = employee_id ? [Number(employee_id)] : [];
    const rates = getDb()
      .prepare(
        `SELECT r.*, e.first_name, e.last_name FROM freelancer_rates r
         JOIN employees e ON e.id = r.employee_id
         ${where} ORDER BY e.last_name, e.first_name, r.valid_from DESC`,
      )
      .all(...params);
    return { rates };
  });

  app.post('/api/compensation/freelancer-rates', async (req, reply) => {
    const body = parse(rateSchema, req.body);
    assertFreelancer(body.employee_id);
    const info = getDb()
      .prepare(
        `INSERT INTO freelancer_rates (employee_id, description, rate_cents, unit, valid_from)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.employee_id, body.description, body.rate_cents, body.unit, body.valid_from);
    const rate = getDb()
      .prepare('SELECT * FROM freelancer_rates WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    audit(req, 'freelancer_rate.create', 'freelancer_rate', Number(info.lastInsertRowid), body);
    reply.status(201);
    return { rate };
  });

  app.put('/api/compensation/freelancer-rates/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM freelancer_rates WHERE id = ?').get(id) as
      | { employee_id: number }
      | undefined;
    if (!existing) throw notFound('Honorarsatz nicht gefunden');
    const body = parse(rateSchema.omit({ employee_id: true }), req.body);
    getDb()
      .prepare(
        `UPDATE freelancer_rates SET description = ?, rate_cents = ?, unit = ?, valid_from = ? WHERE id = ?`,
      )
      .run(body.description, body.rate_cents, body.unit, body.valid_from, id);
    audit(req, 'freelancer_rate.update', 'freelancer_rate', id, body);
    return { rate: getDb().prepare('SELECT * FROM freelancer_rates WHERE id = ?').get(id) };
  });

  app.delete('/api/compensation/freelancer-rates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM freelancer_rates WHERE id = ?').get(id);
    if (!existing) throw notFound('Honorarsatz nicht gefunden');
    getDb().prepare('DELETE FROM freelancer_rates WHERE id = ?').run(id);
    audit(req, 'freelancer_rate.delete', 'freelancer_rate', id);
    reply.status(204);
  });

  // ---------------- Rechnungen ----------------

  app.get('/api/compensation/freelancer-invoices', async (req) => {
    const { status, employee_id } = req.query as { status?: string; employee_id?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) {
      conditions.push('i.status = ?');
      params.push(status);
    }
    if (employee_id) {
      conditions.push('i.employee_id = ?');
      params.push(Number(employee_id));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const invoices = getDb()
      .prepare(
        `SELECT i.*, e.first_name, e.last_name FROM freelancer_invoices i
         JOIN employees e ON e.id = i.employee_id
         ${where} ORDER BY i.invoice_date DESC, i.id DESC`,
      )
      .all(...params);
    // Offene-Posten-Summe (alles außer 'bezahlt').
    const open = getDb()
      .prepare(
        `SELECT COUNT(*) AS open_count, COALESCE(SUM(amount_cents), 0) AS open_cents
         FROM freelancer_invoices WHERE status != 'bezahlt'`,
      )
      .get() as { open_count: number; open_cents: number };
    return { invoices, open_count: open.open_count, open_cents: open.open_cents };
  });

  app.post('/api/compensation/freelancer-invoices', async (req, reply) => {
    const body = parse(invoiceSchema, req.body);
    assertFreelancer(body.employee_id);
    const duplicate = getDb()
      .prepare('SELECT 1 FROM freelancer_invoices WHERE employee_id = ? AND invoice_number = ?')
      .get(body.employee_id, body.invoice_number);
    if (duplicate) {
      throw conflict('Diese Rechnungsnummer existiert für diese Freiberufler:in bereits');
    }
    const info = getDb()
      .prepare(
        `INSERT INTO freelancer_invoices
           (employee_id, invoice_number, invoice_date, period, amount_cents, hours, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.employee_id,
        body.invoice_number,
        body.invoice_date,
        body.period ?? null,
        body.amount_cents,
        body.hours ?? null,
        body.note ?? null,
      );
    const invoice = getDb()
      .prepare('SELECT * FROM freelancer_invoices WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    audit(req, 'freelancer_invoice.create', 'freelancer_invoice', Number(info.lastInsertRowid), {
      employee_id: body.employee_id,
      invoice_number: body.invoice_number,
      amount_cents: body.amount_cents,
    });
    reply.status(201);
    return { invoice };
  });

  // Status-Workflow offen → geprueft → bezahlt (bezahlt braucht paid_date).
  app.post('/api/compensation/freelancer-invoices/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(
      z.object({
        status: z.enum(['geprueft', 'bezahlt']),
        paid_date: isoDate.optional().nullable(),
      }),
      req.body,
    );
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM freelancer_invoices WHERE id = ?').get(id) as
      | { id: number; employee_id: number; invoice_number: string; status: string; amount_cents: number }
      | undefined;
    if (!invoice) throw notFound('Rechnung nicht gefunden');
    const allowed: Record<string, string[]> = {
      offen: ['geprueft'],
      geprueft: ['bezahlt'],
      bezahlt: [],
    };
    if (!allowed[invoice.status]?.includes(body.status)) {
      throw conflict(`Statuswechsel von „${invoice.status}" nach „${body.status}" ist nicht möglich`);
    }
    if (body.status === 'bezahlt' && !body.paid_date) {
      throw badRequest('Für den Status „bezahlt" ist ein Zahldatum erforderlich');
    }
    db.prepare('UPDATE freelancer_invoices SET status = ?, paid_date = ? WHERE id = ?').run(
      body.status,
      body.status === 'bezahlt' ? body.paid_date : null,
      id,
    );
    audit(req, 'freelancer_invoice.status', 'freelancer_invoice', id, {
      employee_id: invoice.employee_id,
      invoice_number: invoice.invoice_number,
      old_status: invoice.status,
      new_status: body.status,
      amount_cents: invoice.amount_cents,
      paid_date: body.paid_date ?? null,
    });
    return { invoice: db.prepare('SELECT * FROM freelancer_invoices WHERE id = ?').get(id) };
  });

  app.delete('/api/compensation/freelancer-invoices/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const invoice = getDb().prepare('SELECT * FROM freelancer_invoices WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!invoice) throw notFound('Rechnung nicht gefunden');
    if (invoice.status !== 'offen') {
      throw conflict('Nur offene Rechnungen können gelöscht werden');
    }
    getDb().prepare('DELETE FROM freelancer_invoices WHERE id = ?').run(id);
    audit(req, 'freelancer_invoice.delete', 'freelancer_invoice', id);
    reply.status(204);
  });
}
