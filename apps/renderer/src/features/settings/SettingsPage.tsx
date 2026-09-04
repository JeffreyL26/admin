import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { BUNDESLAND_LABELS } from '@hrmonic/shared';
import { api } from '../../api/client';
import { Card, Field, PageHeader, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import { applyTheme, getTheme, THEMES, type ThemeName } from '../../design/theme';

/** Passwortregel des Backends (MIN_PASSWORD_CHARS in core/auth.ts). Als
 *  Konstante statt als Zahl im Hinweistext UND in der Absende-Bedingung: Beide
 *  standen auseinander (Hinweis 12, Sperre 8), sodass 8–11 Zeichen absendbar
 *  waren und erst der Server sie ablehnte. Gleiches Muster wie im Portal
 *  (apps/web/src/pages/ProfilePage.tsx). */
const MIN_PASSWORD_CHARS = 12;

interface Settings {
  companyName: string;
  defaultBundesland: string;
  carryoverDeadline: string;
  surveyMinParticipants: number;
  datevBeraterNr: string;
  datevMandantenNr: string;
}

export function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Settings }>('/api/settings'),
  });
  const [form, setForm] = useState<Settings | null>(null);
  const settings = form ?? data?.settings ?? null;

  const save = useMutation({
    mutationFn: (s: Settings) => api.put('/api/settings', s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Einstellungen gespeichert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pw = usePasswordForm();

  if (isLoading || !settings) return <Spinner center />;

  const set = (patch: Partial<Settings>) => setForm({ ...settings, ...patch });

  return (
    <>
      <PageHeader title="Einstellungen" subtitle="Unternehmensweite Konfiguration von HRMONIC." />
      <div className="stack" style={{ maxWidth: 760 }}>
        <ThemeCard />
        <Card title="Unternehmen">
          <div className="hm-form-grid">
            <Field label="Firmenname" span2>
              <input
                className="hm-input"
                value={settings.companyName}
                onChange={(e) => set({ companyName: e.target.value })}
              />
            </Field>
            <Field label="Standard-Bundesland" hint="Für Feiertage, wenn kein Standort zugeordnet ist">
              <select
                className="hm-select"
                value={settings.defaultBundesland}
                onChange={(e) => set({ defaultBundesland: e.target.value })}
              >
                {Object.entries(BUNDESLAND_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Verfall Resturlaub (MM-TT)" hint="Standard: 31. März des Folgejahres">
              <input
                className="hm-input"
                value={settings.carryoverDeadline}
                onChange={(e) => set({ carryoverDeadline: e.target.value })}
                placeholder="03-31"
              />
            </Field>
            <Field
              label="Mindestteilnehmer Umfragen"
              hint="Anonymitätsschwelle für Ergebnisanzeige"
            >
              <input
                className="hm-input"
                type="number"
                min={2}
                value={settings.surveyMinParticipants}
                onChange={(e) => set({ surveyMinParticipants: Number(e.target.value) })}
              />
            </Field>
            <Field label="DATEV-Beraternummer">
              <input
                className="hm-input"
                value={settings.datevBeraterNr}
                onChange={(e) => set({ datevBeraterNr: e.target.value })}
              />
            </Field>
            <Field label="DATEV-Mandantennummer">
              <input
                className="hm-input"
                value={settings.datevMandantenNr}
                onChange={(e) => set({ datevMandantenNr: e.target.value })}
              />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              className="hm-btn hm-btn--primary"
              disabled={save.isPending || !form}
              onClick={() => settings && save.mutate(settings)}
            >
              Speichern
            </button>
          </div>
        </Card>

        <Card title="Passwort ändern">
          <div className="hm-form-grid">
            <Field label="Aktuelles Passwort" required>
              <input
                className="hm-input"
                type="password"
                value={pw.current}
                onChange={(e) => pw.setCurrent(e.target.value)}
              />
            </Field>
            <Field label="Neues Passwort" required hint={`Mindestens ${MIN_PASSWORD_CHARS} Zeichen`}>
              <input
                className="hm-input"
                type="password"
                value={pw.next}
                onChange={(e) => pw.setNext(e.target.value)}
              />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              className="hm-btn hm-btn--secondary"
              disabled={pw.busy || pw.next.length < MIN_PASSWORD_CHARS || !pw.current}
              onClick={pw.submit}
            >
              Passwort ändern
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}

function ThemeCard() {
  const [active, setActive] = useState<ThemeName>(getTheme());
  return (
    <Card title="Darstellung">
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        Das Farbschema gilt sofort und wird auf diesem Gerät gespeichert.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        {THEMES.map((t) => {
          const selected = active === t.name;
          return (
            <button
              key={t.name}
              onClick={() => {
                applyTheme(t.name);
                setActive(t.name);
              }}
              style={{
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                padding: 12,
                borderRadius: 12,
                background: 'var(--bg-surface)',
                border: selected
                  ? '2px solid var(--brand-primary)'
                  : '1px solid var(--border-strong)',
                boxShadow: selected ? 'var(--shadow-primary-sm)' : 'var(--shadow-sm)',
                transition: 'border-color .15s ease, box-shadow .15s ease',
              }}
            >
              <span className="row" style={{ gap: 5, marginBottom: 8 }}>
                {t.swatch.map((color, i) => (
                  <span
                    key={i}
                    style={{
                      width: i === 0 ? 34 : 18,
                      height: 18,
                      borderRadius: 6,
                      background: color,
                      border: '1px solid rgb(0 0 0 / 0.08)',
                    }}
                  />
                ))}
                <span style={{ flex: 1 }} />
                {selected && <Check size={16} color="var(--brand-primary)" />}
              </span>
              <div style={{ fontWeight: 620 }}>{t.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {t.description}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function usePasswordForm() {
  const toast = useToast();
  // Bewusst über den Auth-Kontext statt direkt über api.put: Der Wechsel
  // entwertet serverseitig alle älteren Tokens (users.sessions_valid_from).
  // Wer das mitgelieferte frische Token nicht übernimmt, wird beim nächsten
  // Request mit 401 abgemeldet.
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await changePassword(current, next);
      toast.success('Passwort geändert');
      setCurrent('');
      setNext('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fehler beim Ändern');
    } finally {
      setBusy(false);
    }
  }

  return { current, setCurrent, next, setNext, busy, submit };
}
