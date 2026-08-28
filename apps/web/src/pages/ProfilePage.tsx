import React, { useState } from 'react';
import { ApiRequestError } from '../api/client';
import { useChangePassword, useMyProfile } from '../api/hooks';
import { Card, Field, LoadError, Skeleton } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatDate, formatDays } from '../lib/format';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      className="row row--between"
      style={{ padding: '11px 0', borderBottom: '1px solid var(--gray-100)', gap: 24 }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', flex: 'none' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, textAlign: 'right', minWidth: 0 }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function PasswordCard() {
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = next.length > 0 && repeat.length > 0 && next !== repeat;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch || next.length < 8) return;
    setError(null);
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          toast.success('Passwort geändert');
          setCurrent('');
          setNext('');
          setRepeat('');
        },
        onError: (err) => {
          setError(err instanceof ApiRequestError ? err.message : 'Passwortänderung fehlgeschlagen');
        },
      },
    );
  }

  return (
    <Card title="Passwort ändern">
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <Field label="Aktuelles Passwort" required error={error ?? undefined}>
          <input
            className="pt-input"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field
          label="Neues Passwort"
          required
          hint={next.length > 0 && next.length < 8 ? undefined : 'Mindestens 8 Zeichen.'}
          error={next.length > 0 && next.length < 8 ? 'Mindestens 8 Zeichen erforderlich' : undefined}
        >
          <input
            className="pt-input"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field
          label="Neues Passwort wiederholen"
          required
          error={mismatch ? 'Die Passwörter stimmen nicht überein' : undefined}
        >
          <input
            className="pt-input"
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            aria-invalid={mismatch || undefined}
            autoComplete="new-password"
            required
          />
        </Field>
        <div>
          <button
            type="submit"
            className="pt-btn pt-btn--secondary"
            disabled={change.isPending || mismatch || next.length < 8 || current.length === 0}
          >
            {change.isPending ? 'Wird gespeichert …' : 'Passwort speichern'}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function ProfilePage() {
  const { data: profile, isLoading, error } = useMyProfile();

  return (
    <div>
      <header className="portal-page-header">
        <h1 className="portal-title">Ihr Profil</h1>
        <p className="portal-subtitle">
          Diese Daten führt Ihre Personalabteilung. Stimmt etwas nicht, melden Sie es dort.
        </p>
      </header>

      {error && (
        <div style={{ marginBottom: 20 }}>
          <LoadError error={error} />
        </div>
      )}

      <div className="grid-overview">
        <div className="stack">
          <Card title="Tätigkeit">
            {error ? null : isLoading || !profile ? (
              <div className="stack" style={{ gap: 12 }}>
                <Skeleton />
                <Skeleton width="80%" />
                <Skeleton width="70%" />
              </div>
            ) : (
              <div style={{ marginTop: -6 }}>
                <Row label="Position" value={profile.job_title} />
                <Row label="Abteilung" value={profile.department_name} />
                <Row label="Team" value={profile.team_name} />
                <Row label="Standort" value={profile.location_name} />
                <Row label="Führungskraft" value={profile.manager_name} />
                <Row label="Im Unternehmen seit" value={profile.hire_date ? formatDate(profile.hire_date) : null} />
                <Row
                  label="Wochenstunden"
                  value={profile.weekly_hours !== null ? formatDays(profile.weekly_hours) : null}
                />
                <Row
                  label="Urlaubsanspruch"
                  value={
                    profile.annual_leave_days !== null
                      ? `${formatDays(profile.annual_leave_days)} Tage/Jahr`
                      : null
                  }
                />
              </div>
            )}
          </Card>
          <Card title="Kontakt">
            {error ? null : isLoading || !profile ? (
              <div className="stack" style={{ gap: 12 }}>
                <Skeleton />
                <Skeleton width="75%" />
              </div>
            ) : (
              <div style={{ marginTop: -6 }}>
                <Row label="E-Mail (dienstlich)" value={profile.email} />
                <Row label="Telefon (dienstlich)" value={profile.phone} />
                <Row label="E-Mail (privat)" value={profile.private_email} />
                <Row label="Telefon (privat)" value={profile.private_phone} />
                <Row
                  label="Anschrift"
                  value={
                    profile.private_street
                      ? `${profile.private_street}, ${profile.private_zip ?? ''} ${profile.private_city ?? ''}`.trim()
                      : null
                  }
                />
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Person">
            {error ? null : isLoading || !profile ? (
              <div className="stack" style={{ gap: 12 }}>
                <Skeleton />
                <Skeleton width="60%" />
              </div>
            ) : (
              <div style={{ marginTop: -6 }}>
                <Row label="Name" value={`${profile.first_name} ${profile.last_name}`} />
                <Row label="Geburtsdatum" value={profile.birth_date ? formatDate(profile.birth_date) : null} />
                <Row label="Krankenkasse" value={profile.health_insurance} />
              </div>
            )}
          </Card>
          <PasswordCard />
        </div>
      </div>
    </div>
  );
}
