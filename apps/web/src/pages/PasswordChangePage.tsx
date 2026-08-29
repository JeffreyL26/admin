import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Field } from '../components/ui';

/**
 * Erzwungener Passwortwechsel im Portal.
 *
 * Wird angezeigt, solange `user.must_change_password === 1` ist — also nach
 * jedem neu angelegten oder zurückgesetzten Portal-Konto (die
 * Personalabteilung vergibt kein Passwort, der Server erzeugt es).
 *
 * Warum ein eigener Schirm und nicht der Abschnitt unter „Profil":
 * Das Backend beantwortet in diesem Zustand jede Route außer `/api/auth/me`
 * und `/api/auth/password` mit 403 (PASSWORD_CHANGE_REQUIRED). Die
 * Portal-Shell und jede Seite darin laden zuerst eigene Daten und blieben
 * deshalb leer — der Passwortabschnitt wäre unerreichbar.
 */
export function PasswordChangePage() {
  const { user, changePassword, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = next.length > 0 && repeat.length > 0 && next !== repeat;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setError(null);
    setBusy(true);
    try {
      await changePassword(current, next);
      // Kein Weiterleiten nötig: must_change_password steht danach auf 0,
      // App.tsx zeigt daraufhin wieder das Portal.
    } catch (err) {
      setError(
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : 'Passwort konnte nicht gesetzt werden',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__content">
        <img className="login__logo" src="/logo.png" alt="HRMONIC" />
        <form className="login-card" onSubmit={submit}>
          <div>
            <h1 className="login-card__title">Passwort vergeben</h1>
            <p className="login-card__subtitle">
              Für {user?.email} ist noch das Erstpasswort Ihrer Personalabteilung hinterlegt. Bitte
              vergeben Sie jetzt ein eigenes — bis dahin ist das Portal gesperrt.
            </p>
          </div>
          <Field label="Aktuelles Passwort" required>
            <input
              className="pt-input"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </Field>
          <Field
            label="Neues Passwort"
            required
            hint="Mindestens 12 Zeichen, ohne Firmennamen oder Ihren E-Mail-Anfang."
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
            error={mismatch ? 'Die Passwörter stimmen nicht überein' : (error ?? undefined)}
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
          <button
            className="pt-btn pt-btn--primary"
            disabled={busy || mismatch}
            style={{ height: 44 }}
          >
            {busy ? 'Wird gesetzt …' : 'Passwort setzen'}
          </button>
          <button type="button" className="pt-btn" onClick={logout}>
            Abmelden
          </button>
        </form>
      </div>
    </div>
  );
}
