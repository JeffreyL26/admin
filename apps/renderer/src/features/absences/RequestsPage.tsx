import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, Inbox, X } from 'lucide-react';
import { formatDate, ABSENCE_STATUS_LABELS, type AbsenceRequest, type AbsenceRequestStatus } from '@hrmonic/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs, type BadgeTone } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import {
  balanceExceededQuestion,
  useAbsenceRequests,
  useAbsenceTypes,
  useBalances,
  type BalanceExceededDetails,
} from './api';
import { RequestDialog } from './RequestDialog';

const STATUS_TONES: Record<AbsenceRequestStatus, BadgeTone> = {
  beantragt: 'yellow',
  genehmigt: 'green',
  abgelehnt: 'red',
  storniert: 'neutral',
};

/**
 * Vier-Augen-Prinzip: Das Backend weist Genehmigung und Ablehnung des eigenen
 * Antrags mit 403 zurück (Stornieren bleibt erlaubt). Die Oberfläche blendet die
 * betroffenen Schaltflächen deshalb aus, statt sie in einen Fehler laufen zu
 * lassen. Admin-Konten ohne Personalprofil haben employee_id null — für sie kann
 * es keinen eigenen Antrag geben, dort bleibt alles wie bisher.
 */
function useIsOwnRequest() {
  const { user } = useAuth();
  const ownEmployeeId = user?.employee_id ?? null;
  return (r: AbsenceRequest) => ownEmployeeId !== null && r.employee_id === ownEmployeeId;
}

export function RequestsPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'offen' | 'alle' | 'salden'>('offen');
  const dialogOpen = params.get('neu') === '1';
  const openDialog = () => setParams({ neu: '1' });
  const closeDialog = () => setParams({});

  return (
    <>
      <PageHeader
        title="Anträge"
        subtitle="Abwesenheitsanträge erfassen, genehmigen und Salden überwachen."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={openDialog}>
            <CalendarPlus size={16} /> Neuer Antrag
          </button>
        }
      />
      <Tabs
        tabs={[
          { key: 'offen', label: 'Offene Anträge' },
          { key: 'alle', label: 'Alle Anträge' },
          { key: 'salden', label: 'Salden' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'offen' && <OpenRequestsTab />}
        {tab === 'alle' && <AllRequestsTab />}
        {tab === 'salden' && <BalancesTab />}
      </div>
      <RequestDialog open={dialogOpen} onClose={closeDialog} />
    </>
  );
}

function useRequestActions(
  onBalanceExceeded?: (info: BalanceExceededDetails & { id: number }) => void,
) {
  const toast = useToast();
  const qc = useQueryClient();
  const done = (msg: string) => () => {
    qc.invalidateQueries({ queryKey: ['absences'] });
    toast.success(msg);
  };
  const fail = (e: Error) => toast.error(e.message);
  const approve = useMutation({
    mutationFn: ({ id, override = false }: { id: number; override?: boolean }) =>
      api.post(`/api/absences/requests/${id}/approve`, override ? { override_balance: true } : undefined),
    onSuccess: done('Antrag genehmigt'),
    // BALANCE_EXCEEDED ist kein Fehler, sondern eine Rückfrage: erst die
    // ausdrückliche Bestätigung schickt den Request mit override_balance erneut.
    onError: (e: Error, vars) => {
      if (onBalanceExceeded && e instanceof ApiRequestError && e.code === 'BALANCE_EXCEEDED') {
        onBalanceExceeded({ ...(e.details as BalanceExceededDetails), id: vars.id });
        return;
      }
      fail(e);
    },
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api.post(`/api/absences/requests/${id}/reject`, { reason }),
    onSuccess: done('Antrag abgelehnt'),
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api.post(`/api/absences/requests/${id}/cancel`),
    onSuccess: done('Antrag storniert'),
    onError: fail,
  });
  return { approve, reject, cancel };
}

function RequestRows({
  requests,
  actions,
}: {
  requests: AbsenceRequest[];
  actions: (r: AbsenceRequest) => React.ReactNode;
}) {
  return (
    <div className="hm-table-wrap">
      <table className="hm-table">
        <thead>
          <tr>
            <th>Mitarbeiter:in</th>
            <th>Art</th>
            <th>Zeitraum</th>
            <th className="num">Tage</th>
            <th>Status</th>
            <th>Kommentar</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>
                {r.last_name}, {r.first_name}
              </td>
              <td>
                <span className="row" style={{ gap: 7 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: r.type_color,
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  {r.type_name}
                </span>
              </td>
              <td>
                {formatDate(r.date_from)} – {formatDate(r.date_to)}
                {r.half_day_start === 1 && ' (½ Start)'}
                {r.half_day_end === 1 && ' (½ Ende)'}
              </td>
              <td className="num">{r.days_counted.toLocaleString('de-DE')}</td>
              <td>
                <Badge tone={STATUS_TONES[r.status]}>{ABSENCE_STATUS_LABELS[r.status]}</Badge>
                {r.status === 'abgelehnt' && r.rejection_reason && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3 }}>
                    {r.rejection_reason}
                  </div>
                )}
              </td>
              <td style={{ maxWidth: 220, color: 'var(--text-secondary)' }}>{r.comment ?? '—'}</td>
              <td>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  {actions(r)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RejectDialog({
  request,
  onClose,
  onReject,
}: {
  request: AbsenceRequest | null;
  onClose: () => void;
  onReject: (id: number, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  // Der Dialog bleibt gemountet (Modal rendert bei open=false nur null) — eine
  // beim Abbrechen getippte Begründung darf beim nächsten Antrag nicht wieder
  // vorbefüllt sein, sonst landet sie am falschen Antrag.
  const [lastRequestId, setLastRequestId] = useState<number | null>(null);
  const requestId = request?.id ?? null;
  if (requestId !== lastRequestId) {
    setLastRequestId(requestId);
    setReason('');
  }
  return (
    <Modal
      title="Antrag ablehnen"
      open={request !== null}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--danger"
            disabled={reason.trim().length < 3}
            onClick={() => {
              if (request) onReject(request.id, reason.trim());
              setReason('');
              onClose();
            }}
          >
            Ablehnen
          </button>
        </>
      }
    >
      {request && (
        <>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
            {request.type_name} von {request.first_name} {request.last_name} ({formatDate(request.date_from)} –{' '}
            {formatDate(request.date_to)}) ablehnen?
          </p>
          <Field label="Begründung" required hint="Wird der Mitarbeiter:in mitgeteilt und im Antrag gespeichert.">
            <textarea
              className="hm-textarea"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              autoFocus
            />
          </Field>
        </>
      )}
    </Modal>
  );
}

function OpenRequestsTab() {
  const { data: requests, isLoading } = useAbsenceRequests({ status: 'beantragt' });
  const [balanceWarning, setBalanceWarning] = useState<(BalanceExceededDetails & { id: number }) | null>(null);
  const { approve, reject, cancel } = useRequestActions(setBalanceWarning);
  const isOwnRequest = useIsOwnRequest();
  const [rejecting, setRejecting] = useState<AbsenceRequest | null>(null);
  const [cancelling, setCancelling] = useState<AbsenceRequest | null>(null);

  const list = requests ?? [];
  // Eigene Anträge bleiben sichtbar, sind für die angemeldete Person aber nichts
  // zu Erledigendes — die Kopfzeile nennt deshalb beide Zahlen, damit niemand
  // vergeblich auf eine Schaltfläche wartet.
  const ownCount = list.filter(isOwnRequest).length;

  if (isLoading) return <Spinner center />;
  return (
    <Card flush>
      {list.length === 0 ? (
        <EmptyState
          icon={<Inbox size={40} />}
          title="Keine offenen Anträge"
          hint="Neue Anträge erscheinen hier zur Genehmigung."
        />
      ) : (
        <>
          {ownCount > 0 && (
            <p
              style={{
                margin: 0,
                padding: '10px 16px',
                borderBottom: '1px solid var(--border)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-secondary)',
              }}
            >
              {list.length === 1 ? '1 offener Antrag' : `${list.length} offene Anträge`}, davon{' '}
              {ownCount === 1 ? '1 eigener' : `${ownCount} eigene`}: Über eigene Anträge entscheidet eine andere Person
              der HR-Administration.
            </p>
          )}
          <RequestRows
            requests={list}
            actions={(r) =>
              isOwnRequest(r) ? (
                <>
                  <span
                    style={{
                      maxWidth: 260,
                      textAlign: 'right',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Eigener Antrag — Entscheidung durch eine andere Person der HR-Administration
                  </span>
                  <button
                    className="hm-btn hm-btn--sm hm-btn--ghost"
                    style={{ flexShrink: 0 }}
                    onClick={() => setCancelling(r)}
                    aria-label={`Eigenen Antrag vom ${formatDate(r.date_from)} stornieren`}
                  >
                    Stornieren
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="hm-btn hm-btn--sm hm-btn--primary"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate({ id: r.id })}
                  >
                    <Check size={14} /> Genehmigen
                  </button>
                  <button className="hm-btn hm-btn--sm hm-btn--secondary" onClick={() => setRejecting(r)}>
                    <X size={14} /> Ablehnen
                  </button>
                </>
              )
            }
          />
        </>
      )}
      <RejectDialog
        request={rejecting}
        onClose={() => setRejecting(null)}
        onReject={(id, reason) => reject.mutate({ id, reason })}
      />
      <ConfirmDialog
        open={cancelling !== null}
        title="Eigenen Antrag stornieren"
        message={
          cancelling
            ? `${cancelling.type_name} (${formatDate(cancelling.date_from)} – ${formatDate(cancelling.date_to)}) wirklich stornieren?`
            : ''
        }
        confirmLabel="Stornieren"
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)}
        onClose={() => setCancelling(null)}
      />
      <ConfirmDialog
        open={balanceWarning !== null}
        title="Urlaubssaldo wird überzogen"
        message={balanceWarning ? balanceExceededQuestion(balanceWarning, 'genehmigen') : ''}
        confirmLabel="Trotzdem genehmigen"
        danger={false}
        onConfirm={() => balanceWarning && approve.mutate({ id: balanceWarning.id, override: true })}
        onClose={() => setBalanceWarning(null)}
      />
    </Card>
  );
}

function AllRequestsTab() {
  const { data: types } = useAbsenceTypes();
  const [status, setStatus] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: requests, isLoading } = useAbsenceRequests({
    status: status || undefined,
    type_id: typeId,
    employee_id: employeeId,
    from: from || undefined,
    to: to || undefined,
  });
  const { cancel } = useRequestActions();
  const [cancelling, setCancelling] = useState<AbsenceRequest | null>(null);

  return (
    <div className="stack">
      <Card>
        <div className="hm-form-grid">
          <Field label="Status">
            <select className="hm-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Alle</option>
              {Object.entries(ABSENCE_STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Art">
            <select
              className="hm-select"
              value={typeId ?? ''}
              onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Alle</option>
              {(types ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mitarbeiter:in">
            <EmployeeSelect value={employeeId} onChange={setEmployeeId} emptyLabel="Alle" />
          </Field>
          <Field label="Zeitraum von">
            <input className="hm-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Zeitraum bis">
            <input className="hm-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : !requests || requests.length === 0 ? (
          <EmptyState title="Keine Anträge gefunden" hint="Passen Sie die Filter an oder erfassen Sie einen neuen Antrag." />
        ) : (
          <RequestRows
            requests={requests}
            actions={(r) =>
              r.status === 'beantragt' || r.status === 'genehmigt' ? (
                <button className="hm-btn hm-btn--sm hm-btn--ghost" onClick={() => setCancelling(r)}>
                  Stornieren
                </button>
              ) : null
            }
          />
        )}
      </Card>
      <ConfirmDialog
        open={cancelling !== null}
        title="Antrag stornieren"
        message={
          cancelling
            ? `${cancelling.type_name} von ${cancelling.first_name} ${cancelling.last_name} (${formatDate(cancelling.date_from)} – ${formatDate(cancelling.date_to)}) wirklich stornieren?`
            : ''
        }
        confirmLabel="Stornieren"
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)}
        onClose={() => setCancelling(null)}
      />
    </div>
  );
}

function BalancesTab() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const { data, isLoading } = useBalances(year);

  return (
    <Card
      title={`Urlaubssalden ${year}`}
      actions={
        <select className="hm-select" style={{ width: 110 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      }
      flush
    >
      {isLoading ? (
        <Spinner center />
      ) : !data || data.balances.length === 0 ? (
        <EmptyState title="Keine aktiven Mitarbeitenden" />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Mitarbeiter:in</th>
                <th className="num">Anspruch</th>
                <th className="num">Übertrag</th>
                <th className="num">Genommen</th>
                <th className="num">Verplant</th>
                <th className="num">Rest</th>
                <th>Hinweis</th>
              </tr>
            </thead>
            <tbody>
              {data.balances.map((b) => (
                <tr key={b.employee_id}>
                  <td>
                    {b.last_name}, {b.first_name}
                  </td>
                  <td className="num">{b.entitlement.toLocaleString('de-DE')}</td>
                  <td className="num">{b.carryover.toLocaleString('de-DE')}</td>
                  <td className="num">{b.taken.toLocaleString('de-DE')}</td>
                  <td className="num">{b.planned.toLocaleString('de-DE')}</td>
                  <td className="num" style={{ fontWeight: 650 }}>
                    {b.remaining.toLocaleString('de-DE')}
                  </td>
                  <td>
                    {b.carryover_expired ? (
                      <Badge tone="yellow">Resturlaub teilw. verfallen ({formatDate(data.carryover_deadline)})</Badge>
                    ) : b.remaining < 0 ? (
                      <Badge tone="red">Saldo überzogen</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
