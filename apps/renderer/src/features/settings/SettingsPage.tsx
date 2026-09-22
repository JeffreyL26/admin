import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { ApiRequestError, api } from '../../api/client';
import { REGIONS, REGION_TERM } from '../../lib/locale';
import { Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';

/**
 * Firmeneinstellungen (Bereich `einstellungen`). Alles Persoenliche des
 * Kontos (Passwort, Darstellung, Seitenleiste) liegt in AccountPage.tsx unter
 * /einstellungen/konto, weil es JEDEM Admin-Konto offensteht.
 */

/** Antwort von GET /api/regions: Regionen des Landes der Variante. */
interface RegionsResponse {
  country: string;
  country_label: string;
  regions: Record<string, string>;
}

interface Settings {
  companyName: string;
  /** Regionscode (in DE ein Bundesland); Auswahl kommt aus /api/regions. */
  defaultBundesland: string;
  carryoverDeadline: string;
  surveyMinParticipants: number;
  /** Portal-Kalender: Krankheiten anderer (maskiert als „Abwesend“) anzeigen. */
  portalShowOthersSickness: boolean;
  datevBeraterNr: string;
  datevMandantenNr: string;
}

export function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Settings }>('/api/settings'),
    // Ein 403 (Rolle ohne Bereich `einstellungen`) ist endgueltig; ein
    // Wiederholen liesse den Spinner nur laenger drehen.
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  });
  // Regionen kommen vom Server (Land der Variante), damit die Auswahl nicht
  // an einer zweiten Liste im Client haengt. Bis die Antwort da ist, dient
  // der Katalog aus lib/locale als Rueckfall; er stammt aus derselben Quelle.
  const { data: regionData } = useQuery({
    queryKey: ['regions'],
    queryFn: () => api.get<RegionsResponse>('/api/regions'),
    staleTime: Infinity,
  });
  const regions = regionData?.regions ?? REGIONS;
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

  if (error instanceof ApiRequestError && error.status === 403) {
    return (
      <>
        <PageHeader title="Einstellungen" subtitle="Unternehmensweite Konfiguration von oHRganize." />
        <Card>
          <EmptyState
            icon={<Lock size={40} />}
            title="Für die Firmeneinstellungen fehlt Ihnen die Berechtigung"
            hint="Ihre Admin-Rolle umfasst den Bereich Einstellungen nicht. Passwort, Darstellung und Seitenleiste ändern Sie unter Konto."
            action={
              <Link to="/einstellungen/konto" className="hm-btn hm-btn--primary">
                Zum Konto
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  if (isLoading || !settings) return <Spinner center />;

  const set = (patch: Partial<Settings>) => setForm({ ...settings, ...patch });

  return (
    <>
      <PageHeader title="Einstellungen" subtitle="Unternehmensweite Konfiguration von oHRganize." />
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
            <Field
              label={`Standard-${REGION_TERM}`}
              hint="Für Feiertage, wenn kein Standort zugeordnet ist"
            >
              <Select
                className="hm-select"
                value={settings.defaultBundesland}
                onChange={(e) => set({ defaultBundesland: e.target.value })}
              >
                {Object.entries(regions).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
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
            <div className="hm-field span-2">
              <span className="hm-field__label">Mitarbeitenden-Portal</span>
              <label className="hm-checkbox">
                <input
                  type="checkbox"
                  checked={settings.portalShowOthersSickness}
                  onChange={(e) => set({ portalShowOthersSickness: e.target.checked })}
                />
                Krankheiten anderer Mitarbeitender im Abwesenheitskalender des Portals anzeigen
              </label>
              <span className="hm-field__hint">
                Krankheiten erscheinen dort nie mit Namen der Art, sondern nur als „Abwesend“. Ausgeschaltet
                bleiben Krankheitszeiträume anderer im Portal ganz verborgen; die eigene Krankmeldung sieht
                jede Person weiterhin.
              </span>
            </div>
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
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          Passwort, Darstellung und Seitenleiste dieses Kontos finden Sie unter{' '}
          <Link to="/einstellungen/konto">Konto</Link>.
        </p>
      </div>
    </>
  );
}
