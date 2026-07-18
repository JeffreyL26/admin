import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BUNDESLAND_LABELS } from '@hrmonic/shared';
import { api } from '../../api/client';
import { Card, Field, PageHeader, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

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
            <Field label="Neues Passwort" required hint="Mindestens 8 Zeichen">
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
              disabled={pw.busy || pw.next.length < 8 || !pw.current}
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

function usePasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.put('/api/auth/password', { currentPassword: current, newPassword: next });
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
