import { Link } from 'react-router-dom';
import type { AbsenceRequest } from '@hrmonic/shared';
import { useMyBalance, useMyProfile, useMyRequests } from '../api/hooks';
import { Card, EmptyState, LoadError, Skeleton, SkeletonRows, StatusChip } from '../components/ui';
import { formatDate, formatDays, formatLongDate, formatRange, greeting, todayIso } from '../lib/format';

function BalanceCard() {
  const year = Number(todayIso().slice(0, 4));
  const { data: balance, isLoading, error } = useMyBalance(year);

  if (error) {
    return (
      <Card title={`Urlaubskonto ${year}`}>
        <LoadError error={error} />
      </Card>
    );
  }
  if (isLoading || !balance) {
    return (
      <Card title={`Urlaubskonto ${year}`}>
        <Skeleton width={130} height={44} />
        <div style={{ marginTop: 18 }}>
          <Skeleton width="80%" height={16} />
        </div>
        <div style={{ marginTop: 14 }}>
          <Skeleton height={6} />
        </div>
      </Card>
    );
  }

  const available = Math.max(balance.entitlement + balance.carryover, 0.0001);
  const takenShare = Math.min(balance.taken / available, 1);
  const plannedShare = Math.min(balance.planned / available, 1 - takenShare);

  return (
    <Card title={`Urlaubskonto ${year}`}>
      <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
        <span className="pt-big">{formatDays(balance.remaining)}</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {balance.remaining === 1 ? 'Tag verfügbar' : 'Tage verfügbar'}
        </span>
      </div>
      <div className="pt-meter" style={{ margin: '18px 0 16px' }} aria-hidden="true">
        <span className="pt-meter__taken" style={{ width: `${takenShare * 100}%` }} />
        <span className="pt-meter__planned" style={{ width: `${plannedShare * 100}%` }} />
      </div>
      <div className="pt-ledger">
        <div className="pt-ledger__item">
          <span className="pt-label">Anspruch</span>
          <span className="pt-ledger__value">{formatDays(balance.entitlement)}</span>
        </div>
        <div className="pt-ledger__item">
          <span className="pt-label">Übertrag</span>
          <span className="pt-ledger__value">{formatDays(balance.carryover)}</span>
        </div>
        <div className="pt-ledger__item">
          <span className="pt-label">Genommen</span>
          <span className="pt-ledger__value">{formatDays(balance.taken)}</span>
        </div>
        <div className="pt-ledger__item">
          <span className="pt-label">Verplant</span>
          <span className="pt-ledger__value">{formatDays(balance.planned)}</span>
        </div>
      </div>
      {balance.carryover_expired && (
        <p className="pt-alert pt-alert--info" style={{ marginTop: 16 }}>
          Ein Teil Ihres Resturlaubs aus dem Vorjahr ist zum Stichtag verfallen. Details kennt Ihre
          Personalabteilung.
        </p>
      )}
      <div className="row" style={{ marginTop: 20 }}>
        <Link to="/antraege/neu" className="pt-btn pt-btn--primary">
          Urlaub beantragen
        </Link>
        <Link to="/antraege" className="pt-btn pt-btn--quiet">
          Alle Anträge
        </Link>
      </div>
    </Card>
  );
}

function RequestRow({ request }: { request: AbsenceRequest }) {
  return (
    <div className="row" style={{ padding: '13px 22px', borderTop: '1px solid var(--gray-100)', alignItems: 'flex-start' }}>
      <span className="pt-dot" style={{ background: request.type_color ?? 'var(--brand-primary)' }} />
      <div style={{ minWidth: 0 }}>
        <p style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{request.type_name}</p>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          {formatRange(request.date_from, request.date_to)} · {formatDays(request.days_counted)}{' '}
          {request.days_counted === 1 ? 'Tag' : 'Tage'}
        </p>
      </div>
      <span style={{ marginLeft: 'auto' }}>
        <StatusChip status={request.status} />
      </span>
    </div>
  );
}

export function OverviewPage() {
  const { data: profile, isLoading: profileLoading } = useMyProfile();
  const { data: requests, isLoading: requestsLoading, error: requestsError } = useMyRequests();

  const today = todayIso();
  const open = (requests ?? []).filter((r) => r.status === 'beantragt');
  const upcoming = (requests ?? [])
    .filter((r) => r.status === 'genehmigt' && r.date_to >= today)
    .sort((a, b) => a.date_from.localeCompare(b.date_from));
  const next = upcoming[0];
  const decided = (requests ?? [])
    .filter((r) => (r.status === 'genehmigt' || r.status === 'abgelehnt') && r.decided_at)
    .sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))
    .slice(0, 3);

  return (
    <div>
      <header className="portal-page-header">
        {profileLoading || !profile ? (
          <Skeleton width={280} height={30} />
        ) : (
          <h1 className="portal-title">{greeting(profile.first_name)}</h1>
        )}
        <p className="portal-subtitle">{formatLongDate(today)}</p>
      </header>

      <div className="grid-overview">
        <div className="stack">
          <BalanceCard />
          <Card title="Offene Anträge" flush>
            {requestsError ? (
              <div className="pt-card__body">
                <LoadError error={requestsError} />
              </div>
            ) : requestsLoading ? (
              <div className="pt-card__body">
                <SkeletonRows rows={2} />
              </div>
            ) : open.length === 0 ? (
              <EmptyState
                title="Keine offenen Anträge"
                hint="Neue Anträge erscheinen hier, bis Ihre Personalabteilung entschieden hat."
              />
            ) : (
              <div style={{ marginTop: -1 }}>
                {open.map((r) => (
                  <RequestRow key={r.id} request={r} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Nächste Abwesenheit">
            {requestsError ? (
              <LoadError error={requestsError} />
            ) : requestsLoading ? (
              <>
                <Skeleton width={160} height={22} />
                <div style={{ marginTop: 10 }}>
                  <Skeleton width={200} />
                </div>
              </>
            ) : next ? (
              <>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <span className="pt-dot" style={{ background: next.type_color ?? 'var(--brand-primary)' }} />
                  <div>
                    <p style={{ fontWeight: 650 }}>{next.type_name}</p>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: 2 }}>
                      {formatRange(next.date_from, next.date_to)}
                    </p>
                    <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 2 }}>
                      {formatDays(next.days_counted)} {next.days_counted === 1 ? 'Arbeitstag' : 'Arbeitstage'}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                Keine genehmigten Abwesenheiten in Sicht. Zeit für etwas Planung?
              </p>
            )}
          </Card>

          <Card title="Zuletzt entschieden" flush>
            {requestsError ? (
              <div className="pt-card__body">
                <LoadError error={requestsError} />
              </div>
            ) : requestsLoading ? (
              <div className="pt-card__body">
                <SkeletonRows rows={3} />
              </div>
            ) : decided.length === 0 ? (
              <EmptyState title="Noch keine Entscheidungen" />
            ) : (
              <div style={{ marginTop: -1 }}>
                {decided.map((r) => (
                  <div key={r.id} style={{ padding: '13px 22px', borderTop: '1px solid var(--gray-100)' }}>
                    <div className="row">
                      <p style={{ fontWeight: 600, fontSize: 'var(--text-sm)', minWidth: 0 }}>
                        {r.type_name} · {formatRange(r.date_from, r.date_to)}
                      </p>
                      <span style={{ marginLeft: 'auto' }}>
                        <StatusChip status={r.status} />
                      </span>
                    </div>
                    <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                      {r.decided_by_name ? `${r.decided_by_name}, ` : ''}
                      {r.decided_at ? formatDate(r.decided_at.slice(0, 10)) : ''}
                      {r.status === 'abgelehnt' && r.rejection_reason ? ` · ${r.rejection_reason}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
