import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import {
  formatDate,
  formatEuro,
  FREELANCER_INVOICE_STATUS_LABELS,
  FREELANCER_RATE_UNIT_LABELS,
  type FreelancerInvoiceStatus,
  type FreelancerRateUnit,
} from '@hrmonic/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, StatCard, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useEmployees } from '../../components/EmployeeSelect';
import { parseEuroInput, centsToInput, STATUS_TONES } from './lib';

interface RateRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  description: string;
  rate_cents: number;
  unit: string;
  valid_from: string;
}

interface InvoiceRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  invoice_number: string;
  invoice_date: string;
  period: string | null;
  amount_cents: number;
  hours: number | null;
  status: string;
  paid_date: string | null;
  note: string | null;
}

/** Auswahl beschränkt auf Freiberufler:innen (employee_type=freiberufler). */
function FreelancerSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { data: employees } = useEmployees();
  const freelancers = (employees ?? []).filter((e) => e.employee_type === 'freiberufler');
  return (
    <select
      className="hm-select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">— auswählen —</option>
      {freelancers.map((e) => (
        <option key={e.id} value={e.id}>
          {e.last_name}, {e.first_name}
        </option>
      ))}
    </select>
  );
}

function RateDialog({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: RateRow | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [rate, setRate] = useState('');
  const [unit, setUnit] = useState<string>('stunde');
  const [validFrom, setValidFrom] = useState('');

  React.useEffect(() => {
    if (open) {
      setEmployeeId(editing?.employee_id ?? null);
      setDescription(editing?.description ?? '');
      setRate(editing ? centsToInput(editing.rate_cents) : '');
      setUnit(editing?.unit ?? 'stunde');
      setValidFrom(editing?.valid_from ?? '');
    }
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        description,
        rate_cents: parseEuroInput(rate),
        unit,
        valid_from: validFrom,
      };
      return editing
        ? api.put(`/api/compensation/freelancer-rates/${editing.id}`, payload)
        : api.post('/api/compensation/freelancer-rates', { ...payload, employee_id: employeeId });
    },
    onSuccess: () => {
      toast.success(editing ? 'Honorarsatz aktualisiert' : 'Honorarsatz angelegt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Speichern fehlgeschlagen'),
  });

  const valid = (editing || employeeId) && description.trim() && parseEuroInput(rate) && validFrom;

  return (
    <Modal
      title={editing ? 'Honorarsatz bearbeiten' : 'Honorarsatz anlegen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        {!editing && (
          <Field label="Freiberufler:in" required span2>
            <FreelancerSelect value={employeeId} onChange={setEmployeeId} />
          </Field>
        )}
        <Field label="Beschreibung" required span2>
          <input
            className="hm-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="z. B. Frontend-Entwicklung"
          />
        </Field>
        <Field label="Satz (€)" required>
          <input className="hm-input" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Einheit" required>
          <select className="hm-select" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {(Object.keys(FREELANCER_RATE_UNIT_LABELS) as FreelancerRateUnit[]).map((u) => (
              <option key={u} value={u}>
                {FREELANCER_RATE_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Gültig ab" required>
          <input
            type="date"
            className="hm-input"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function RatesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RateRow | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'freelancer-rates'],
    queryFn: () => api.get<{ rates: RateRow[] }>('/api/compensation/freelancer-rates'),
    select: (d) => d.rates,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/compensation/freelancer-rates/${id}`),
    onSuccess: () => {
      toast.success('Honorarsatz gelöscht');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Löschen fehlgeschlagen'),
  });

  return (
    <>
      <Card
        title="Honorarsätze"
        flush
        actions={
          <button
            className="hm-btn hm-btn--primary hm-btn--sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus size={14} /> Honorarsatz
          </button>
        }
      >
        {isLoading ? (
          <Spinner center />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="Keine Honorarsätze hinterlegt"
            hint="Honorarsätze sind nur für Mitarbeitende mit Beschäftigungsart Freiberufler möglich."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Freiberufler:in</th>
                  <th>Beschreibung</th>
                  <th className="num">Satz</th>
                  <th>Einheit</th>
                  <th>Gültig ab</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.last_name}, {r.first_name}
                    </td>
                    <td>{r.description}</td>
                    <td className="num">{formatEuro(r.rate_cents)}</td>
                    <td>{FREELANCER_RATE_UNIT_LABELS[r.unit as FreelancerRateUnit] ?? r.unit}</td>
                    <td>{formatDate(r.valid_from)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                          aria-label="Bearbeiten"
                          onClick={() => {
                            setEditing(r);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                          aria-label="Löschen"
                          onClick={() => setDeleteId(r.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <RateDialog open={dialogOpen} onClose={() => setDialogOpen(false)} editing={editing} />
      <ConfirmDialog
        open={deleteId !== null}
        title="Honorarsatz löschen"
        message="Soll dieser Honorarsatz wirklich gelöscht werden?"
        onConfirm={() => deleteId !== null && remove.mutate(deleteId)}
        onClose={() => setDeleteId(null)}
      />
    </>
  );
}

function InvoiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/compensation/freelancer-invoices', {
        employee_id: employeeId,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        period: period.trim() || null,
        amount_cents: parseEuroInput(amount),
        hours: hours.trim() ? Number(hours.replace(',', '.')) : null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Rechnung wurde erfasst');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setInvoiceNumber('');
      setAmount('');
      setHours('');
      setPeriod('');
      setNote('');
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Erfassen fehlgeschlagen'),
  });

  const valid = employeeId && invoiceNumber.trim() && invoiceDate && parseEuroInput(amount);

  return (
    <Modal
      title="Rechnung erfassen"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
          >
            Erfassen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Freiberufler:in" required span2>
          <FreelancerSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Rechnungsnummer" required hint="Je Freiberufler:in eindeutig">
          <input
            className="hm-input"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder="z. B. RE-2026-014"
          />
        </Field>
        <Field label="Rechnungsdatum" required>
          <input
            type="date"
            className="hm-input"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </Field>
        <Field label="Leistungszeitraum">
          <input
            className="hm-input"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="z. B. 2026-07"
          />
        </Field>
        <Field label="Betrag (€)" required>
          <input className="hm-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Stunden" hint="Leer lassen bei Pauschale">
          <input className="hm-input" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="Notiz">
          <input className="hm-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function InvoicesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);
  const [paidDate, setPaidDate] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'freelancer-invoices'],
    queryFn: () =>
      api.get<{ invoices: InvoiceRow[]; open_count: number; open_cents: number }>(
        '/api/compensation/freelancer-invoices',
      ),
  });

  const setStatus = useMutation({
    mutationFn: (p: { id: number; status: string; paid_date?: string }) =>
      api.post(`/api/compensation/freelancer-invoices/${p.id}/status`, {
        status: p.status,
        paid_date: p.paid_date ?? null,
      }),
    onSuccess: () => {
      toast.success('Status wurde aktualisiert');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setPayFor(null);
      setPaidDate('');
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Statuswechsel fehlgeschlagen'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/compensation/freelancer-invoices/${id}`),
    onSuccess: () => {
      toast.success('Rechnung gelöscht');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Löschen fehlgeschlagen'),
  });

  const invoices = data?.invoices ?? [];

  return (
    <>
      <div className="grid-stats">
        <StatCard
          label="Offene Posten"
          value={formatEuro(data?.open_cents ?? 0)}
          sub={`${data?.open_count ?? 0} Rechnung${(data?.open_count ?? 0) === 1 ? '' : 'en'} nicht bezahlt`}
          icon={<Receipt size={15} />}
        />
      </div>
      <Card
        title="Rechnungen"
        flush
        actions={
          <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Rechnung erfassen
          </button>
        }
      >
        {isLoading ? (
          <Spinner center />
        ) : invoices.length === 0 ? (
          <EmptyState
            icon={<Receipt size={40} />}
            title="Keine Rechnungen erfasst"
            hint="Erfassen Sie Eingangsrechnungen Ihrer Freiberufler:innen."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Freiberufler:in</th>
                  <th>Datum</th>
                  <th>Zeitraum</th>
                  <th className="num">Betrag</th>
                  <th className="num">Stunden</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}>{i.invoice_number}</td>
                    <td>
                      {i.last_name}, {i.first_name}
                    </td>
                    <td>{formatDate(i.invoice_date)}</td>
                    <td>{i.period ?? '—'}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {formatEuro(i.amount_cents)}
                    </td>
                    <td className="num">{i.hours ?? '—'}</td>
                    <td>
                      <Badge tone={STATUS_TONES[i.status] ?? 'neutral'}>
                        {FREELANCER_INVOICE_STATUS_LABELS[i.status as FreelancerInvoiceStatus] ?? i.status}
                      </Badge>
                      {i.paid_date && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          am {formatDate(i.paid_date)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {i.status === 'offen' && (
                          <>
                            <button
                              className="hm-btn hm-btn--secondary hm-btn--sm"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: i.id, status: 'geprueft' })}
                            >
                              Prüfen
                            </button>
                            <button
                              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                              aria-label="Löschen"
                              onClick={() => setDeleteId(i.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                        {i.status === 'geprueft' && (
                          <button
                            className="hm-btn hm-btn--primary hm-btn--sm"
                            onClick={() => {
                              setPayFor(i);
                              setPaidDate(new Date().toISOString().slice(0, 10));
                            }}
                          >
                            Als bezahlt markieren
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <InvoiceDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <Modal
        title="Rechnung als bezahlt markieren"
        open={!!payFor}
        onClose={() => setPayFor(null)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setPayFor(null)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={!paidDate || setStatus.isPending}
              onClick={() =>
                payFor && setStatus.mutate({ id: payFor.id, status: 'bezahlt', paid_date: paidDate })
              }
            >
              Bezahlt
            </button>
          </>
        }
      >
        {payFor && (
          <div className="stack" style={{ gap: 12 }}>
            <p style={{ color: 'var(--text-secondary)' }}>
              {payFor.invoice_number} · {formatEuro(payFor.amount_cents)} — {payFor.last_name},{' '}
              {payFor.first_name}
            </p>
            <Field label="Zahldatum" required>
              <input
                type="date"
                className="hm-input"
                value={paidDate}
                onChange={(e) => setPaidDate(e.target.value)}
              />
            </Field>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={deleteId !== null}
        title="Rechnung löschen"
        message="Soll diese offene Rechnung wirklich gelöscht werden?"
        onConfirm={() => deleteId !== null && remove.mutate(deleteId)}
        onClose={() => setDeleteId(null)}
      />
    </>
  );
}

export function FreelancersPage() {
  const [tab, setTab] = useState('rechnungen');
  return (
    <>
      <PageHeader
        title="Freiberufler & Honorare"
        subtitle="Honorarsätze und Eingangsrechnungen — getrennt von der Angestelltenvergütung"
      />
      <div className="stack">
        <Tabs
          tabs={[
            { key: 'rechnungen', label: 'Rechnungen' },
            { key: 'saetze', label: 'Honorarsätze' },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'rechnungen' ? <InvoicesTab /> : <RatesTab />}
      </div>
    </>
  );
}
