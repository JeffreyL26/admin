import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ABSENCE_CATEGORY_LABELS, type AbsenceCategory } from '@ohrganize/shared';
import { ApiRequestError } from '../api/client';
import { useCreateRequest, useLeavePreview, useLeaveTypes, useMyBalance } from '../api/hooks';
import { Card, Field, Skeleton } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatDays, todayIso } from '../lib/format';

export function NewRequestPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: types, isLoading: typesLoading } = useLeaveTypes();
  const create = useCreateRequest();

  const [typeId, setTypeId] = useState<number | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [comment, setComment] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);

  const selectedType = (types ?? []).find((t) => t.id === typeId);
  const singleDay = !!dateFrom && dateFrom === dateTo;
  const year = Number((dateFrom || todayIso()).slice(0, 4));
  const { data: balance } = useMyBalance(year);
  const preview = useLeavePreview(dateFrom, dateTo, halfStart, halfEnd && !singleDay);

  const grouped = useMemo(() => {
    const byCategory = new Map<AbsenceCategory, NonNullable<typeof types>>();
    for (const t of types ?? []) {
      const list = byCategory.get(t.category) ?? [];
      list.push(t);
      byCategory.set(t.category, list);
    }
    return [...byCategory.entries()];
  }, [types]);

  const days = preview.data?.days_counted;
  const remainingAfter =
    balance && days !== undefined && selectedType?.affects_balance === 1
      ? balance.remaining - days
      : null;

  const rangeInvalid = !!dateFrom && !!dateTo && dateTo < dateFrom;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!typeId || !dateFrom || !dateTo || rangeInvalid) return;
    setApiError(null);
    create.mutate(
      {
        type_id: typeId,
        date_from: dateFrom,
        date_to: dateTo,
        half_day_start: halfStart,
        half_day_end: halfEnd && !singleDay,
        comment: comment.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          toast.success(
            res.request.status === 'genehmigt'
              ? 'Abwesenheit erfasst und automatisch genehmigt'
              : 'Antrag eingereicht',
          );
          navigate('/antraege');
        },
        onError: (err) => {
          setApiError(err instanceof ApiRequestError ? err.message : 'Antrag konnte nicht gestellt werden');
        },
      },
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <header className="portal-page-header">
        <h1 className="portal-title">Abwesenheit beantragen</h1>
        <p className="portal-subtitle">
          Ihr Antrag geht direkt an die Personalabteilung. Über die Entscheidung informiert Sie das
          Portal unter „Anträge“.
        </p>
      </header>

      <form onSubmit={submit}>
        <Card>
          {typesLoading ? (
            <div className="stack" style={{ gap: 16 }}>
              <Skeleton height={40} />
              <div className="row">
                <Skeleton height={40} />
                <Skeleton height={40} />
              </div>
              <Skeleton height={88} />
            </div>
          ) : (
            <div className="pt-form-grid">
              <Field label="Art der Abwesenheit" required span2>
                <select
                  className="pt-select"
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')}
                  required
                >
                  <option value="">Bitte wählen …</option>
                  {grouped.map(([category, list]) => (
                    <optgroup key={category} label={ABSENCE_CATEGORY_LABELS[category] ?? category}>
                      {list.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.max_days_per_year !== null ? ` (max. ${t.max_days_per_year} Tage/Jahr)` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Von" required>
                <input
                  className="pt-input"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    if (!dateTo || dateTo < e.target.value) setDateTo(e.target.value);
                  }}
                  required
                />
              </Field>
              <Field
                label="Bis"
                required
                error={rangeInvalid ? 'Das Enddatum liegt vor dem Startdatum' : undefined}
              >
                <input
                  className="pt-input"
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(e) => setDateTo(e.target.value)}
                  aria-invalid={rangeInvalid || undefined}
                  required
                />
              </Field>
              <label className="pt-check">
                <input type="checkbox" checked={halfStart} onChange={(e) => setHalfStart(e.target.checked)} />
                Erster Tag nur halb
              </label>
              <label className="pt-check" style={singleDay ? { opacity: 0.5 } : undefined}>
                <input
                  type="checkbox"
                  checked={halfEnd && !singleDay}
                  disabled={singleDay}
                  onChange={(e) => setHalfEnd(e.target.checked)}
                />
                Letzter Tag nur halb
              </label>
              <Field label="Kommentar an die Personalabteilung" span2>
                <textarea
                  className="pt-textarea"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={2000}
                  placeholder="Optional, z. B. Vertretung ist organisiert."
                />
              </Field>
            </div>
          )}

          {(days !== undefined || preview.isLoading) && !rangeInvalid && (
            <div
              style={{
                marginTop: 18,
                paddingTop: 16,
                borderTop: '1px solid var(--border)',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              {preview.isLoading || days === undefined ? (
                <Skeleton width={260} />
              ) : (
                <>
                  <p>
                    Der Zeitraum umfasst{' '}
                    <strong>
                      {formatDays(days)} {days === 1 ? 'Arbeitstag' : 'Arbeitstage'}
                    </strong>{' '}
                    (ohne Wochenenden, Feiertage und Betriebsruhe).
                  </p>
                  {remainingAfter !== null && (
                    <p style={{ marginTop: 4 }}>
                      Verbleibender Urlaub nach diesem Antrag:{' '}
                      <strong style={remainingAfter < 0 ? { color: 'var(--danger)' } : undefined}>
                        {formatDays(remainingAfter)} Tage
                      </strong>
                    </p>
                  )}
                  {selectedType && selectedType.requires_approval === 0 && (
                    <p style={{ marginTop: 4 }}>
                      Diese Abwesenheitsart ist nicht genehmigungspflichtig und wird sofort bestätigt.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {apiError && (
            <p className="pt-alert pt-alert--danger" style={{ marginTop: 18 }} role="alert">
              {apiError}
            </p>
          )}

          <div className="row" style={{ marginTop: 22 }}>
            <button
              type="submit"
              className="pt-btn pt-btn--primary"
              disabled={create.isPending || !typeId || !dateFrom || !dateTo || rangeInvalid}
            >
              {create.isPending ? 'Wird eingereicht …' : 'Antrag einreichen'}
            </button>
            <Link to="/antraege" className="pt-btn pt-btn--secondary">
              Abbrechen
            </Link>
          </div>
        </Card>
      </form>
    </div>
  );
}
