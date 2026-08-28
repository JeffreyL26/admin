import React, { useState } from 'react';
import type { SickNote } from '@hrmonic/shared';
import { ApiRequestError } from '../api/client';
import { useCreateSickNote, useMySickNotes } from '../api/hooks';
import { Card, EmptyState, Field, LoadError, SkeletonRows } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatDate, formatRange, todayIso } from '../lib/format';

function certificateState(note: SickNote): { label: string; tone: string } {
  if (note.received_date) return { label: `AU eingegangen am ${formatDate(note.received_date)}`, tone: 'success' };
  if (note.certificate_due_date < todayIso())
    return { label: `AU überfällig (Frist ${formatDate(note.certificate_due_date)})`, tone: 'danger' };
  return { label: `AU einreichen bis ${formatDate(note.certificate_due_date)}`, tone: 'warning' };
}

export function SickNotePage() {
  const toast = useToast();
  const { data: sickNotes, isLoading, error: listError } = useMySickNotes();
  const create = useCreateSickNote();

  const today = todayIso();
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [childSick, setChildSick] = useState(false);
  const [comment, setComment] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<SickNote | null>(null);

  const rangeInvalid = !!dateFrom && !!dateTo && dateTo < dateFrom;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dateFrom || !dateTo || rangeInvalid) return;
    setApiError(null);
    create.mutate(
      { date_from: dateFrom, date_to: dateTo, child_sick: childSick, comment: comment.trim() || undefined },
      {
        onSuccess: (res) => {
          setConfirmation(res.sick_note);
          setComment('');
          toast.success('Krankmeldung übermittelt');
        },
        onError: (err) => {
          setApiError(
            err instanceof ApiRequestError ? err.message : 'Krankmeldung konnte nicht übermittelt werden',
          );
        },
      },
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <header className="portal-page-header">
        <h1 className="portal-title">Krankmeldung</h1>
        <p className="portal-subtitle">
          Melden Sie sich hier krank, sobald Sie ausfallen. Die Personalabteilung wird sofort
          informiert; die ärztliche Bescheinigung reichen Sie nach.
        </p>
      </header>

      <div className="stack">
        {confirmation ? (
          <Card title="Gute Besserung">
            <p>
              Ihre Krankmeldung für den Zeitraum{' '}
              <strong>{formatRange(confirmation.date_from ?? dateFrom, confirmation.date_to ?? dateTo)}</strong>{' '}
              ist erfasst.
            </p>
            <p className="pt-alert pt-alert--info" style={{ marginTop: 14 }}>
              Bitte reichen Sie die ärztliche Bescheinigung bis zum{' '}
              <strong>{formatDate(confirmation.certificate_due_date)}</strong> bei Ihrer
              Personalabteilung ein.
            </p>
            <div className="row" style={{ marginTop: 18 }}>
              <button type="button" className="pt-btn pt-btn--secondary" onClick={() => setConfirmation(null)}>
                Weitere Krankmeldung erfassen
              </button>
            </div>
          </Card>
        ) : (
          <form onSubmit={submit}>
            <Card>
              <div className="pt-form-grid">
                <Field label="Krank von" required>
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
                  label="Voraussichtlich bis"
                  required
                  error={rangeInvalid ? 'Das Enddatum liegt vor dem Startdatum' : undefined}
                  hint="Lässt sich später über die Personalabteilung verlängern."
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
                <label className="pt-check span-2">
                  <input type="checkbox" checked={childSick} onChange={(e) => setChildSick(e.target.checked)} />
                  Mein Kind ist krank (Kinderkrankentage)
                </label>
                <Field label="Hinweis an die Personalabteilung" span2>
                  <textarea
                    className="pt-textarea"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    maxLength={2000}
                    placeholder="Optional, z. B. Übergabe liegt im Teamkanal."
                  />
                </Field>
              </div>

              {apiError && (
                <p className="pt-alert pt-alert--danger" style={{ marginTop: 18 }} role="alert">
                  {apiError}
                </p>
              )}

              <div className="row" style={{ marginTop: 22 }}>
                <button
                  type="submit"
                  className="pt-btn pt-btn--primary"
                  disabled={create.isPending || !dateFrom || !dateTo || rangeInvalid}
                >
                  {create.isPending ? 'Wird übermittelt …' : 'Krank melden'}
                </button>
              </div>
            </Card>
          </form>
        )}

        <Card title="Ihre Krankmeldungen" flush>
          {listError ? (
            <div className="pt-card__body">
              <LoadError error={listError} />
            </div>
          ) : isLoading ? (
            <div className="pt-card__body">
              <SkeletonRows rows={2} />
            </div>
          ) : !sickNotes || sickNotes.length === 0 ? (
            <EmptyState title="Keine Krankmeldungen erfasst" />
          ) : (
            <div>
              {sickNotes.map((note) => {
                const cert = certificateState(note);
                return (
                  <div key={note.id} style={{ padding: '13px 22px', borderTop: '1px solid var(--gray-100)' }}>
                    <div className="row row--between">
                      <p style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                        {formatRange(note.date_from ?? '', note.date_to ?? '')}
                        {note.child_sick === 1 && (
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · Kind krank</span>
                        )}
                      </p>
                      <span className={`pt-chip pt-chip--${cert.tone}`}>
                        <span className="pt-chip__dot" />
                        {cert.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
