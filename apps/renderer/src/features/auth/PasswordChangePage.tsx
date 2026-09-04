import React, { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/ui';
import { ApiRequestError } from '../../api/client';
import logo from '../../assets/logo-full.png';

/**
 * Erzwungener Passwortwechsel.
 *
 * Wird angezeigt, solange `user.must_change_password === 1` ist — nach der
 * Erstinbetriebnahme (Standard-Admin mit generiertem Zufallspasswort) und nach
 * jedem administrativen Zurücksetzen.
 *
 * Warum ein eigener Schirm und nicht der Abschnitt in den Einstellungen:
 * Das Backend beantwortet in diesem Zustand JEDE andere Route mit 403
 * (server.ts, PASSWORD_CHANGE_REQUIRED). Die Einstellungsseite lädt aber
 * zuerst `/api/settings` und bliebe deshalb im Ladezustand stehen — der
 * Passwortabschnitt wäre gar nicht erreichbar und die frische Installation
 * damit eine Sackgasse.
 */
export function PasswordChangePage() {
  const { user, changePassword, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== repeat) {
      setError('Die beiden neuen Passwörter stimmen nicht überein');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      // Kein Weiterleiten nötig: Sobald must_change_password auf 0 steht,
      // zeigt App.tsx wieder die reguläre Oberfläche.
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
      <form className="login__card" onSubmit={submit}>
        <img className="login__logo" src={logo} alt="oHRganize" />
        <h1 className="login__title">Passwort vergeben</h1>
        <p className="login__subtitle">
          Für <strong>{user?.email}</strong> ist noch ein Erstpasswort hinterlegt. Bitte vergeben
          Sie jetzt ein eigenes. Bis dahin ist der Zugang gesperrt.
        </p>
        <Field label="Aktuelles Passwort" hint="Das Erstpasswort aus der Inbetriebnahme" required>
          <input
            className="hm-input"
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
          hint="Mindestens 12 Zeichen, ohne Firmen- oder Produktnamen"
          required
        >
          <input
            className="hm-input"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Neues Passwort wiederholen" required error={error ?? undefined}>
          <input
            className="hm-input"
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <button className="hm-btn hm-btn--primary" disabled={busy} style={{ height: 44 }}>
          {busy ? 'Wird gesetzt …' : 'Passwort setzen'}
        </button>
        <button
          type="button"
          className="hm-btn"
          onClick={logout}
          style={{ marginTop: 8, height: 38 }}
        >
          Abmelden
        </button>
      </form>
    </div>
  );
}
