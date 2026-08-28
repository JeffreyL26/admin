import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AbsenceRequest } from '@hrmonic/shared';
import { ApiRequestError } from '../api/client';
import { useCancelRequest, useMyRequests } from '../api/hooks';
import { Card, EmptyState, Skeleton, StatusChip } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatDate, formatDays, formatRange, todayIso } from '../lib/format';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Alle Status' },
  { value: 'beantragt', label: 'Beantragt' },
  { value: 'genehmigt', label: 'Genehmigt' },
  { value: 'abgelehnt', label: 'Abgelehnt' },
  { value: 'storniert', label: 'Storniert' },
];

/** Zurückziehen mit Zwischenschritt statt Browser-Dialog. */
function CancelButton({ request }: { request: AbsenceRequest }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useCancelRequest();
  const toast = useToast();

  if (request.status !== 'beantragt') return null;

  if (!confirming) {
    return (
      <button type="button" className="pt-btn pt-btn--danger-quiet pt-btn--sm" onClick={() => setConfirming(true)}>
        Zurückziehen
      </button>
    );
  }
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <button
        type="button"
        className="pt-btn pt-btn--danger-quiet pt-btn--sm"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(request.id, {
            onSuccess: () => toast.success('Antrag zurückgezogen'),
            onError: (err) =>
              toast.error(err instanceof ApiRequestError ? err.message : 'Aktion fehlgeschlagen'),
            onSettled: () => setConfirming(false),
          })
        }
      >
        Wirklich zurückziehen?
      </button>
      <button type="button" className="pt-btn pt-btn--quiet pt-btn--sm" onClick={() => setConfirming(false)}>
        Behalten
      </button>
    </span>
  );
}

export function RequestsPage() {
  const currentYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState<number>(currentYear);
  const [status, setStatus] = useState('');
  const { data: requests, isLoading } = useMyRequests(year);

  const filtered = (requests ?? []).filter((r) => !status || r.status === status);

  return (
    <div>
      <header className="portal-page-header row row--between">
        <div>
          <h1 className="portal-title">Ihre Anträge</h1>
          <p className="portal-subtitle">
            Alle Abwesenheitsanträge mit aktuellem Bearbeitungsstand.
          </p>
        </div>
        <Link to="/antraege/neu" className="pt-btn pt-btn--primary">
          Neuer Antrag
        </Link>
      </header>

      <div className="row" style={{ marginBottom: 16 }}>
        <select
          className="pt-select"
          style={{ width: 'auto' }}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          aria-label="Jahr"
        >
          {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          className="pt-select"
          style={{ width: 'auto' }}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <Card flush>
        {isLoading ? (
          <div className="pt-card__body stack" style={{ gap: 14 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="row">
                <Skeleton width={140} />
                <Skeleton width={110} />
                <Skeleton width={50} style={{ marginLeft: 'auto' }} />
                <Skeleton width={80} />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Keine Anträge in diesem Zeitraum"
            hint="Stellen Sie einen neuen Antrag, er erscheint sofort in dieser Liste."
          />
        ) : (
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Zeitraum</th>
                  <th>Art</th>
                  <th className="num">Tage</th>
                  <th>Status</th>
                  <th>Entscheidung</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {formatRange(r.date_from, r.date_to)}
                      {(r.half_day_start === 1 || r.half_day_end === 1) && (
                        <span style={{ display: 'block', color: 'var(--text-muted)', fontWeight: 400, fontSize: 'var(--text-xs)' }}>
                          {r.half_day_start === 1 ? 'erster Tag halb' : ''}
                          {r.half_day_start === 1 && r.half_day_end === 1 ? ', ' : ''}
                          {r.half_day_end === 1 ? 'letzter Tag halb' : ''}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="pt-dot" style={{ background: r.type_color ?? 'var(--brand-primary)', marginTop: 0 }} />
                        {r.type_name}
                      </span>
                      {r.comment && (
                        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
                          {r.comment}
                        </span>
                      )}
                    </td>
                    <td className="num">{formatDays(r.days_counted)}</td>
                    <td>
                      <StatusChip status={r.status} />
                      {r.status === 'abgelehnt' && r.rejection_reason && (
                        <span style={{ display: 'block', color: 'var(--danger)', fontSize: 'var(--text-xs)', marginTop: 4, maxWidth: 220 }}>
                          {r.rejection_reason}
                        </span>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {r.decided_at ? (
                        <>
                          {r.decided_by_name ?? 'System'}
                          <span style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                            {formatDate(r.decided_at.slice(0, 10))}
                          </span>
                        </>
                      ) : (
                        'ausstehend'
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <CancelButton request={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
