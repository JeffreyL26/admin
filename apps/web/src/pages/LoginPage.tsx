import React, { useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Field } from '../components/ui';

/** Breite eines nahtlosen Animationszyklus (siehe login-drift in portal.css). */
const CYCLE = 1600;

function wavePath(cy: number, amplitude: number, wavelength: number, phase: number): string {
  const parts: string[] = [];
  for (let x = 0; x <= CYCLE * 2; x += 8) {
    const y = cy + amplitude * Math.sin((2 * Math.PI * x) / wavelength + phase);
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

/**
 * Ruhige Ebene hinter dem Login-Text: die Teilschwingungen einer Grundwelle
 * (Wellenlängen 1/2, 1/4, 1/6, 1/8 des Zyklus — eine harmonische Reihe, die
 * Marke heißt nicht zufällig HRMONIC). Jede Stimme driftet in eigenem Tempo;
 * weil alle Wellenlängen den Zyklus teilen, läuft die Animation nahtlos.
 */
function HarmonyBackdrop() {
  // Vier Stimmen auf eigenen Achsen, über die Seitenhöhe verteilt — die tiefe
  // Grundwelle liegt hinter Wortmarke und Claim, die Obertöne darunter.
  const waves = useMemo(
    () => [
      { d: wavePath(160, 52, CYCLE / 2, 0.6), color: 'var(--brand-navy)', opacity: 0.14, width: 1.6, drift: '96s' },
      { d: wavePath(280, 30, CYCLE / 4, 2.1), color: 'var(--brand-primary)', opacity: 0.3, width: 1.5, drift: '72s' },
      { d: wavePath(370, 19, CYCLE / 6, 4.2), color: 'var(--blue-300)', opacity: 0.5, width: 1.4, drift: '56s' },
      { d: wavePath(450, 12, CYCLE / 8, 1.2), color: 'var(--blue-200)', opacity: 0.6, width: 1.3, drift: '44s' },
    ],
    [],
  );
  return (
    <div className="login__backdrop" aria-hidden="true">
      <svg viewBox="0 0 1600 620" preserveAspectRatio="xMidYMid slice">
        {waves.map((w, i) => (
          <g key={i} className="login__wave" style={{ ['--drift' as string]: w.drift }}>
            <path d={w.d} fill="none" stroke={w.color} strokeOpacity={w.opacity} strokeWidth={w.width} />
          </g>
        ))}
      </svg>
    </div>
  );
}

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
    <div className="login">
      <HarmonyBackdrop />
      <div className="login__content">
        <img className="login__logo" src="/logo.png" alt="HRMONIC" />
        <p className="login__claim">
          Urlaub beantragen, krankmelden, Stammdaten einsehen: <span>Ihr direkter Draht zur
          Personalabteilung.</span>
        </p>
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
        <p className="login__foot">
          Anträge, die Sie hier stellen, landen ohne Umweg bei Ihrer Personalabteilung und werden
          dort geprüft und entschieden. Den Stand sehen Sie jederzeit unter „Anträge“.
        </p>
      </div>
    </div>
  );
}
