import React, { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/ui';
import { backendLabel } from '@ohrganize/shared';
import { API_BASE, ApiRequestError } from '../../api/client';
import logo from '../../assets/logo-full.png';
import { readJson, writeJson } from '../../lib/localStore';

/**
 * Zuletzt erfolgreich angemeldete Adresse, je Geraet. Nur die Adresse, nie
 * das Passwort; ohne Eintrag (Frischinstallation) das Startkonto.
 */
const LAST_LOGIN_KEY = 'ohrganize.lastLogin';
const FIRST_LOGIN = 'admin@ohrganize.de';

export function LoginPage() {
  const { login, notice } = useAuth();
  const [remembered] = useState(() => {
    const stored = readJson<string>(LAST_LOGIN_KEY);
    return typeof stored === 'string' && stored ? stored : null;
  });
  const [email, setEmail] = useState(remembered ?? FIRST_LOGIN);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      writeJson(LAST_LOGIN_KEY, email.trim());
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
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__logo-plate">
          <img className="login__logo" src={logo} alt="oHRganize" />
        </div>
        <h1 className="login__title">Willkommen zurück!</h1>
        <p className="login__subtitle">Melden Sie sich mit Ihrem HR-Administrationskonto an.</p>
        {/* Ende der Sitzung nach ihrer Höchstdauer (auth/AuthContext.tsx); bei
            einem Anmeldefehler zählt nur noch der. */}
        {notice && !error && (
          <div className="hm-notice" role="status" style={{ marginBottom: 14 }}>
            {notice}
          </div>
        )}
        <Field label="E-Mail-Adresse" required>
          <input
            className="hm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus={!remembered}
            required
          />
        </Field>
        <Field label="Passwort" required error={error ?? undefined}>
          <input
            className="hm-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus={Boolean(remembered)}
            required
          />
        </Field>
        <button className="hm-btn hm-btn--primary" disabled={busy} style={{ height: 44 }}>
          {busy ? 'Anmelden …' : 'Anmelden'}
        </button>
        {/* Mit welchem Backend die App spricht: Arbeitet sie mit Daten auf
            diesem Rechner, gelten die Konten des Servers hier nicht, und eine
            Anmeldung scheitert mit "E-Mail oder Passwort ist falsch". */}
        <p className="login__server">{backendLabel(API_BASE)}</p>
      </form>
    </div>
  );
}
