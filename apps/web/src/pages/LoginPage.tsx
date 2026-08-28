import React, { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Field } from '../components/ui';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : 'Anmeldung fehlgeschlagen',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-split">
      <aside className="login-brand">
        <div className="portal-brand">
          HR<span>MONIC</span>
          <small>Portal</small>
        </div>
        <p className="login-brand__claim">
          Urlaub beantragen, krankmelden, Stammdaten einsehen: <span>Ihr direkter Draht zur
          Personalabteilung.</span>
        </p>
        <p className="login-brand__foot">
          Anträge, die Sie hier stellen, landen ohne Umweg bei Ihrer Personalabteilung und werden
          dort geprüft und entschieden. Den Stand sehen Sie jederzeit unter „Anträge“.
        </p>
      </aside>
      <div className="login-pane">
        <form className="login-card" onSubmit={submit}>
          <div>
            <h1 className="login-card__title">Anmelden</h1>
            <p className="login-card__subtitle">
              Mit den Zugangsdaten, die Sie von Ihrer Personalabteilung erhalten haben.
            </p>
          </div>
          <Field label="E-Mail-Adresse" required>
            <input
              className="pt-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vorname.nachname@firma.de"
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Field label="Passwort" required error={error ?? undefined}>
            <input
              className="pt-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <button className="pt-btn pt-btn--primary" disabled={busy} style={{ height: 44 }}>
            {busy ? 'Anmelden …' : 'Anmelden'}
          </button>
          <p className="pt-field__hint">
            Passwort vergessen? Ihre Personalabteilung setzt es für Sie zurück.
          </p>
        </form>
      </div>
    </div>
  );
}
