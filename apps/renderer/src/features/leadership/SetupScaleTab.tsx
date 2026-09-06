import React, { useState } from 'react';
import { Handshake, History } from 'lucide-react';
import {
  RATING_PERIOD_KINDS,
  RATING_PERIOD_LABELS,
  RATING_SCALES,
  RATING_SCALE_KEYS,
  formatDateTime,
  type LeadershipSettings,
  type LeadershipSettingsPatch,
  type RatingPeriodKind,
  type RatingScaleKey,
} from '@ohrganize/shared';
import { Card, Field, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useLeadershipSettings, useMutualPairs, useUpdateLeadershipSettings } from './api';
import { RatingInput } from './RatingInput';
import { SetupNote, errorMessage } from './SetupShared';

/**
 * Reiter „Skala & Zeitraum“: Kadenz, zentrale Skala, Einheitlichkeit der
 * Skala, gegenseitige Verantwortung und die drei Quellen der automatischen
 * Zuordnung. Lokaler Formularzustand wie in SettingsPage — geschrieben wird
 * erst beim Speichern, und zwar nur, was sich geändert hat.
 */

interface FormState {
  period: RatingPeriodKind;
  scale: RatingScaleKey;
  uniform_scale: boolean;
  allow_mutual: boolean;
  auto_direct_reports: boolean;
  auto_department_head: boolean;
  auto_team_lead: boolean;
}

function toForm(s: LeadershipSettings): FormState {
  return {
    period: s.period,
    scale: s.scale,
    uniform_scale: s.uniform_scale === 1,
    allow_mutual: s.allow_mutual === 1,
    auto_direct_reports: s.auto_direct_reports === 1,
    auto_department_head: s.auto_department_head === 1,
    auto_team_lead: s.auto_team_lead === 1,
  };
}

/** Nur geänderte Felder — der Server lehnt einen leeren Patch mit 400 ab. */
function diff(saved: FormState, next: FormState): LeadershipSettingsPatch {
  const patch: LeadershipSettingsPatch = {};
  if (next.period !== saved.period) patch.period = next.period;
  if (next.scale !== saved.scale) patch.scale = next.scale;
  if (next.uniform_scale !== saved.uniform_scale) patch.uniform_scale = next.uniform_scale;
  if (next.allow_mutual !== saved.allow_mutual) patch.allow_mutual = next.allow_mutual;
  if (next.auto_direct_reports !== saved.auto_direct_reports) patch.auto_direct_reports = next.auto_direct_reports;
  if (next.auto_department_head !== saved.auto_department_head) {
    patch.auto_department_head = next.auto_department_head;
  }
  if (next.auto_team_lead !== saved.auto_team_lead) patch.auto_team_lead = next.auto_team_lead;
  return patch;
}

/** Beispielwert für die Vorschau: eine gute, aber nicht die beste Stufe. */
function sampleScore(scale: RatingScaleKey): number {
  const def = RATING_SCALES[scale];
  return def.higherIsBetter ? Math.max(1, Math.ceil(def.max * 0.8)) : Math.min(def.max, 2);
}

export function SetupScaleTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data, isLoading } = useLeadershipSettings();
  // Bestehende Paare — auch solche aus Organisationsänderungen, die das
  // Modul beim Entstehen nicht sehen konnte.
  const mutualPairs = useMutualPairs().data ?? [];
  const save = useUpdateLeadershipSettings();
  const [form, setForm] = useState<FormState | null>(null);

  if (isLoading || !data) return <Spinner center />;

  const saved = toForm(data);
  const state = form ?? saved;
  const patch = diff(saved, state);
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<FormState>) => setForm({ ...state, ...p });
  const readOnly = !canEdit;

  const submit = () =>
    save.mutate(patch, {
      onSuccess: () => {
        toast.success('Einstellungen gespeichert');
        setForm(null);
      },
      onError: (e) => toast.error(errorMessage(e, 'Speichern fehlgeschlagen')),
    });

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <Card title="Bewertungszeitraum">
        <div className="hm-form-grid">
          <Field
            label="Kadenz"
            hint="Standard: quartalsweise. Jede Bewertung gehört zu genau einem Zeitraum dieser Kadenz."
          >
            <select
              className="hm-select"
              value={state.period}
              disabled={readOnly}
              onChange={(e) => set({ period: e.target.value as RatingPeriodKind })}
            >
              {RATING_PERIOD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RATING_PERIOD_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <div className="span-2">
            <SetupNote icon={<History size={15} />}>
              Ein Wechsel der Kadenz betrifft nur <strong>künftige</strong> Bewertungen. Bestehende Bewertungen
              bleiben in ihrem ursprünglichen Zeitraum gespeichert und lesbar (Protokoll und Einsicht); in der
              Bewertungsmaske und im Report werden danach die Zeiträume der neuen Kadenz angeboten.
            </SetupNote>
          </div>
        </div>
      </Card>

      <Card title="Skala">
        <div className="stack" style={{ gap: 14 }}>
          <div className="lead-scale-list" role="radiogroup" aria-label="Bewertungsskala">
            {RATING_SCALE_KEYS.map((k) => {
              const def = RATING_SCALES[k];
              const on = state.scale === k;
              return (
                <label key={k} className={`lead-scale-option${on ? ' lead-scale-option--on' : ''}`}>
                  <input
                    type="radio"
                    name="leadership-scale"
                    value={k}
                    checked={on}
                    disabled={readOnly}
                    onChange={() => set({ scale: k })}
                  />
                  <span className="lead-scale-option__body">
                    <span className="lead-scale-option__label">
                      {def.label}
                      {k === 'stars5' && (
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · Standard</span>
                      )}
                    </span>
                    <span className="lead-scale-option__desc">{def.description}</span>
                    <span className="lead-scale-option__preview" aria-hidden="true">
                      <RatingInput scale={k} value={sampleScore(k)} onChange={() => {}} disabled size={18} />
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={state.uniform_scale}
              disabled={readOnly}
              onChange={(e) => set({ uniform_scale: e.target.checked })}
            />
            <span>Alle Kategorien nutzen dieselbe Skala (empfohlen, Vergleichbarkeit)</span>
          </label>
          <p className="lead-setup-hint">
            {state.uniform_scale
              ? 'Die gewählte Skala gilt für jede Kategorie. Eigene Skalen einzelner Kategorien werden ignoriert, bleiben aber gespeichert.'
              : 'Jede Kategorie darf im Reiter „Kategorien“ eine eigene Skala tragen; ohne eigene Wahl gilt die Skala oben. Der Report vergleicht nur Gesamtbewertungen auf derselben Skala.'}
          </p>

          <SetupNote tone="warning" icon={<History size={15} />}>
            Ein Skalenwechsel deutet alte Bewertungen <strong>nicht um</strong>: Jede Bewertung speichert die
            Skala, auf der sie abgegeben wurde, und bleibt so lesbar. Der Satisfaction-Report zählt nur
            Bewertungen auf der aktuellen Skala und weist andere gesondert aus.
          </SetupNote>
        </div>
      </Card>

      <Card title="Gegenseitige Verantwortung">
        {mutualPairs.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <SetupNote tone={state.allow_mutual ? 'info' : 'warning'} icon={<Handshake size={15} />}>
              {state.allow_mutual ? 'Bestehende gegenseitige Verantwortung: ' : 'Nicht zugelassen, aber vorhanden — entstanden durch Änderungen an Vorgesetzten, Abteilungs- oder Teamleitungen: '}
              <strong>{mutualPairs.map((p) => p.label).join(', ')}</strong>
              {state.allow_mutual
                ? '.'
                : '. Nehmen Sie eine Seite über eine Ausnahme (Einrichtung → Zuständigkeit) heraus oder lassen Sie gegenseitige Verantwortung zu.'}
            </SetupNote>
          </div>
        )}
        <label className="hm-checkbox">
          <input
            type="checkbox"
            checked={state.allow_mutual}
            disabled={readOnly}
            onChange={(e) => set({ allow_mutual: e.target.checked })}
          />
          <span>Gegenseitige Verantwortung zulassen</span>
        </label>
        <p className="lead-setup-hint">
          <Handshake size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />
          Gegenseitig heißt: A ist für B zuständig und B zugleich für A — etwa wenn eine Abteilungsleitung
          von einer Person aus der eigenen Abteilung als Vorgesetzte:r geführt wird. Erlaubt, wird die
          Konstellation in „Mein Team“ und in der Einrichtung mit dem Badge „gegenseitig“ gekennzeichnet.
          Nicht erlaubt, lehnt der Server Freischaltungen und Zuweisungen ab, die sie erzeugen würden —
          bereits bestehende Paare bleiben sichtbar, bis Sie sie auflösen.
        </p>
      </Card>

      <Card title="Automatische Zuordnung">
        <p className="lead-setup-hint" style={{ marginTop: 0, marginBottom: 12 }}>
          Aus welchen Beziehungen der Organisation die Zuständigkeit abgeleitet wird — für alle
          Führungskräfte, bei denen die automatische Ableitung eingeschaltet ist. Manuelle Zuweisungen und
          Ausnahmen gelten unabhängig davon.
        </p>
        <div className="stack" style={{ gap: 10 }}>
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={state.auto_direct_reports}
              disabled={readOnly}
              onChange={(e) => set({ auto_direct_reports: e.target.checked })}
            />
            <span>Direkt unterstellte Personen (Vorgesetzte:r)</span>
          </label>
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={state.auto_department_head}
              disabled={readOnly}
              onChange={(e) => set({ auto_department_head: e.target.checked })}
            />
            <span>Abteilungsleitung — alle Mitarbeitenden der Abteilung inkl. Unterabteilungen</span>
          </label>
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={state.auto_team_lead}
              disabled={readOnly}
              onChange={(e) => set({ auto_team_lead: e.target.checked })}
            />
            <span>Teamleitung — alle Teammitglieder</span>
          </label>
        </div>
        {!state.auto_direct_reports && !state.auto_department_head && !state.auto_team_lead && (
          <div style={{ marginTop: 12 }}>
            <SetupNote tone="warning">
              Alle Quellen sind ausgeschaltet — Zuständigkeiten ergeben sich dann ausschließlich aus manuellen
              Zuweisungen.
            </SetupNote>
          </div>
        )}
      </Card>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Zuletzt geändert: {formatDateTime(data.updated_at)}
        </span>
        {canEdit && (
          <div className="row">
            <button
              type="button"
              className="hm-btn hm-btn--secondary"
              disabled={!dirty || save.isPending}
              onClick={() => setForm(null)}
            >
              Verwerfen
            </button>
            <button
              type="button"
              className="hm-btn hm-btn--primary"
              disabled={!dirty || save.isPending}
              onClick={submit}
            >
              Speichern
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
