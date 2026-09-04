import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calculator, CheckCircle2, Download, FileSpreadsheet, Plus } from 'lucide-react';
import {
  formatEuro,
  PAYROLL_FLAG_LABELS,
  PAYROLL_RUN_STATUS_LABELS,
  SALARY_COMPONENT_LABELS,
  type PayrollFlag,
  type PayrollRunStatus,
  type SalaryComponentKind,
} from '@ohrganize/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, StatCard } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { currentMonth, downloadAuthenticated, FLAG_TONES, formatMonth, STATUS_TONES } from './lib';

interface RunRow {
  id: number;
  month: string;
  status: string;
  notes: string | null;
  created_at: string;
  item_count: number;
  total_cents: number;
  warning_count: number;
}

interface ItemRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  employee_type: string;
  gross_cents: number;
  bonus_cents: number;
  total_cents: number;
  unpaid_absence_days: number;
  components: { kind: string; amount_cents: number; monthly_cents: number }[];
  bonuses: { id: number; kind: string; title: string; payout_cents: number }[];
  flags: PayrollFlag[];
  warnings: string[];
}

function statusBadge(status: string) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'}>
      {PAYROLL_RUN_STATUS_LABELS[status as PayrollRunStatus] ?? status}
    </Badge>
  );
}

function RunDetail({ runId, onBack }: { runId: number; onBack: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'payroll-run', runId],
    queryFn: () => api.get<{ run: RunRow; items: ItemRow[] }>(`/api/compensation/payroll-runs/${runId}`),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/api/compensation/payroll-runs/${runId}/status`, { status }),
    onSuccess: () => {
      toast.success('Status wurde aktualisiert');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Statuswechsel fehlgeschlagen'),
  });

  const doExport = async (format: 'datev' | 'csv') => {
    if (!data) return;
    try {
      await downloadAuthenticated(
        `/api/compensation/payroll-runs/${runId}/export.${format}`,
        format === 'datev'
          ? `lodas_bewegungsdaten_${data.run.month}.txt`
          : `abrechnung_${data.run.month}.csv`,
      );
      toast.success(format === 'datev' ? 'DATEV-Export erstellt' : 'CSV-Export erstellt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
    }
  };

  if (isLoading || !data) return <Spinner center />;
  const { run, items } = data;
  const warningCount = items.reduce((s, i) => s + i.warnings.length, 0);

  return (
    <>
      <PageHeader
        title={`Abrechnungslauf ${formatMonth(run.month)}`}
        subtitle={`${items.length} Mitarbeitende · ${warningCount} Warnung${warningCount === 1 ? '' : 'en'}`}
        actions={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={16} /> Zurück
            </button>
            {run.status === 'offen' && (
              <button
                className="hm-btn hm-btn--primary"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate('geprueft')}
              >
                <CheckCircle2 size={16} /> Als geprüft markieren
              </button>
            )}
            <button
              className="hm-btn hm-btn--secondary"
              disabled={run.status === 'offen'}
              title={run.status === 'offen' ? 'Der Lauf muss zuerst geprüft werden' : undefined}
              onClick={() => doExport('datev')}
            >
              <Download size={16} /> DATEV-Export
            </button>
            <button
              className="hm-btn hm-btn--secondary"
              disabled={run.status === 'offen'}
              title={run.status === 'offen' ? 'Der Lauf muss zuerst geprüft werden' : undefined}
              onClick={() => doExport('csv')}
            >
              <FileSpreadsheet size={16} /> CSV-Export
            </button>
          </>
        }
      />
      <div className="grid-stats">
        <StatCard label="Status" value={statusBadge(run.status)} />
        <StatCard label="Gesamtsumme" value={formatEuro(items.reduce((s, i) => s + i.total_cents, 0))} />
        <StatCard label="Mitarbeitende" value={items.length} />
        <StatCard label="Warnungen" value={warningCount} sub={warningCount > 0 ? 'Bitte vor Export prüfen' : 'Keine'} />
      </div>
      <Card title="Bewegungsdaten je Mitarbeiter:in" flush>
        {items.length === 0 ? (
          <EmptyState title="Keine Mitarbeitenden im Lauf" />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th className="num">Brutto</th>
                  <th className="num">Boni</th>
                  <th className="num">Gesamt</th>
                  <th className="num">Unbez. Tage</th>
                  <th>Bewegungen</th>
                  <th>Warnungen</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}>
                      {i.last_name}, {i.first_name}
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 400 }}>
                        {i.components
                          .map(
                            (c) =>
                              `${SALARY_COMPONENT_LABELS[c.kind as SalaryComponentKind] ?? c.kind}: ${formatEuro(c.monthly_cents)}`,
                          )
                          .join(' · ') || 'Keine Komponenten'}
                      </div>
                    </td>
                    <td className="num">{formatEuro(i.gross_cents)}</td>
                    <td className="num">
                      {i.bonus_cents > 0 ? formatEuro(i.bonus_cents) : '—'}
                      {i.bonuses.length > 0 && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          {i.bonuses.map((b) => b.title).join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {formatEuro(i.total_cents)}
                    </td>
                    <td className="num">{i.unpaid_absence_days || '—'}</td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 4 }}>
                        {i.flags.length === 0
                          ? '—'
                          : i.flags.map((f) => (
                              <Badge key={f} tone={FLAG_TONES[f] ?? 'neutral'}>
                                {PAYROLL_FLAG_LABELS[f] ?? f}
                              </Badge>
                            ))}
                      </div>
                    </td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 4 }}>
                        {i.warnings.length === 0 ? (
                          <Badge tone="green">OK</Badge>
                        ) : (
                          i.warnings.map((w) => (
                            <Badge key={w} tone="red">
                              {w}
                            </Badge>
                          ))
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
    </>
  );
}

export function PayrollPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [month, setMonth] = useState(currentMonth());
  const [notes, setNotes] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'payroll-runs'],
    queryFn: () => api.get<{ runs: RunRow[] }>('/api/compensation/payroll-runs'),
    select: (d) => d.runs,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ run: RunRow }>('/api/compensation/payroll-runs', {
        month,
        notes: notes.trim() || null,
      }),
    onSuccess: (d) => {
      toast.success(`Abrechnungslauf ${formatMonth(d.run.month)} wurde erstellt`);
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setCreateOpen(false);
      setNotes('');
      setSelected(d.run.id);
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Lauf konnte nicht erstellt werden'),
  });

  if (selected !== null) return <RunDetail runId={selected} onBack={() => setSelected(null)} />;

  return (
    <>
      <PageHeader
        title="Abrechnung"
        subtitle="Monatliche Abrechnungsläufe mit Bewegungsdaten, Prüfungen und DATEV-/CSV-Export"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Lauf erstellen
          </button>
        }
      />
      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            icon={<Calculator size={40} />}
            title="Noch keine Abrechnungsläufe"
            hint="Erstellen Sie den ersten Lauf für den aktuellen Monat."
            action={
              <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} /> Lauf erstellen
              </button>
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Monat</th>
                  <th>Status</th>
                  <th className="num">Mitarbeitende</th>
                  <th className="num">Gesamtsumme</th>
                  <th className="num">Warnungen</th>
                  <th>Notizen</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setSelected(r.id)}>
                    <td style={{ fontWeight: 600 }}>{formatMonth(r.month)}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td className="num">{r.item_count}</td>
                    <td className="num">{formatEuro(r.total_cents)}</td>
                    <td className="num">
                      {r.warning_count > 0 ? <Badge tone="red">{r.warning_count}</Badge> : '0'}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal
        title="Abrechnungslauf erstellen"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setCreateOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={!/^\d{4}-\d{2}$/.test(month) || create.isPending}
              onClick={() => create.mutate()}
            >
              Erstellen
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Monat" required hint="Je Monat ist nur ein Lauf möglich">
            <input
              type="month"
              className="hm-input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </Field>
          <Field label="Notizen">
            <input className="hm-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 12 }}>
          Der Lauf stellt die aktiven Gehaltskomponenten (voller Monatswert), freigegebene Boni des
          Monats sowie Bewegungs-Flags und Prüfwarnungen je Mitarbeiter:in zusammen.
        </p>
      </Modal>
    </>
  );
}
