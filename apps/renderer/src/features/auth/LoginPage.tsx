import React, { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/ui';
import { ApiRequestError } from '../../api/client';
import logo from '../../assets/logo.png';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('admin@hrmonic.de');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <img className="login__logo" src={logo} alt="HRMONIC" />
        <h1 className="login__title">Willkommen zurück</h1>
        <p className="login__subtitle">Melden Sie sich mit Ihrem HR-Administrationskonto an.</p>
        <Field label="E-Mail-Adresse" required>
          <input
            className="hm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <Field label="Passwort" required error={error ?? undefined}>
          <input
            className="hm-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <button className="hm-btn hm-btn--primary" disabled={busy} style={{ height: 40 }}>
          {busy ? 'Anmelden …' : 'Anmelden'}
        </button>
      </form>
    </div>
  );
}
