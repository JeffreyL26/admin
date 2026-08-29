import React, { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Info, ListPlus, Pencil, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import {
  formatDate,
  ABSENCE_CATEGORY_LABELS,
  PORTAL_VISIBILITY_LABELS,
  type AbsenceCategory,
  type AbsenceType,
  type AbsenceTypeEligibility,
  type CompanyClosure,
  type PortalVisibility,
  type Role,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, employeeName, useEmployees } from '../../components/EmployeeSelect';
import { useAbsenceTypes, useClosures } from './api';

interface TypeForm {
  name: string;
  category: AbsenceCategory;
  paid: boolean;
  affects_balance: boolean;
  requires_proof: boolean;
  requires_approval: boolean;
  color: string;
  max_days_per_year: number | null;
  active: boolean;
  portal_visibility: PortalVisibility;
}

const EMPTY_FORM: TypeForm = {
  name: '',
  category: 'sonder',
  paid: true,
  affects_balance: false,
  requires_proof: false,
  requires_approval: true,
  color: '#0864C6',
  max_days_per_year: null,
  active: true,
  portal_visibility: 'name',
};

const EMPTY_ELIGIBILITY: AbsenceTypeEligibility = { role_ids: [], employee_rules: [] };

/**
 * Die HR-Liste (GET /api/absences/types) liefert die Zuordnung nur zur Anzeige
 * mit — sie filtert bewusst nicht. Das Backend benennt die Rollen-Allowlist
 * dort `eligible_role_ids`; `AbsenceType.role_ids` aus @hrmonic/shared wird
 * zusätzlich gelesen, falls die beiden Namen später angeglichen werden.
 */
type TypeListRow = AbsenceType & {
  eligible_role_ids?: number[];
  employee_rules?: AbsenceTypeEligibility['employee_rules'];
};

/**
 * Fachrollen für die Berechtigungsauswahl. Der Query-Key ist bewusst der
 * generische `['admin', 'roles']`, damit die Rollenpflege in der Verwaltung und
 * dieser Dialog aus demselben Cache leben.
 */
function useRoles() {
  return useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<{ roles: Role[] }>('/api/admin/roles'),
    select: (d) => d.roles,
  });
}

/** Kurzfassung der Zuordnung für die Artenliste ("Alle", "3 Rollen, 2 Ausnahmen"). */
function eligibilitySummary(t: TypeListRow): string {
  const roleCount = (t.eligible_role_ids ?? t.role_ids ?? []).length;
  const ruleCount = (t.employee_rules ?? []).length;
  if (roleCount === 0 && ruleCount === 0) return 'Alle';
  const parts = [roleCount === 0 ? 'Alle Rollen' : `${roleCount} ${roleCount === 1 ? 'Rolle' : 'Rollen'}`];
  if (ruleCount > 0) parts.push(`${ruleCount} ${ruleCount === 1 ? 'Ausnahme' : 'Ausnahmen'}`);
  return parts.join(', ');
}

export function TypesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: types, isLoading } = useAbsenceTypes();
  const [editing, setEditing] = useState<{ id: number | null; form: TypeForm } | null>(null);
  const [deleting, setDeleting] = useState<AbsenceType | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['absences'] });

  const save = useMutation({
    mutationFn: async ({
      id,
      form,
      eligibility,
    }: {
      id: number | null;
      form: TypeForm;
      eligibility: AbsenceTypeEligibility;
    }) => {
      let typeId = id;
      if (typeId === null) {
        // Neue Art: erst anlegen — die Berechtigung hängt an ihrer id.
        const created = await api.post<{ type: AbsenceType }>('/api/absences/types', form);
        typeId = created.type.id;
      } else {
        await api.put(`/api/absences/types/${typeId}`, form);
      }
      await api.put(`/api/absences/types/${typeId}/eligibility`, eligibility);
    },
    onSuccess: () => {
      invalidate();
      toast.success('Abwesenheitsart gespeichert');
      setEditing(null);
    },
    onError: (e: Error) => {
      // Die Art kann bereits geschrieben und nur die Berechtigung gescheitert
      // sein — die Liste deshalb auch im Fehlerfall neu laden.
      invalidate();
      toast.error(e.message);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/absences/types/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Abwesenheitsart gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Abwesenheitsarten"
        subtitle="Arten, Regeln und Betriebsruhetage konfigurieren."
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => setEditing({ id: null, form: { ...EMPTY_FORM } })}
          >
            <ListPlus size={16} /> Neue Art
          </button>
        }
      />
      <div className="stack">
        <Card flush>
          {isLoading ? (
            <Spinner center />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kategorie</th>
                    <th>Eigenschaften</th>
                    <th className="num">Max. Tage/Jahr</th>
                    <th>Wer darf beantragen</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {((types ?? []) as TypeListRow[]).map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <span
                            style={{ width: 13, height: 13, borderRadius: 4, background: t.color, display: 'inline-block', flexShrink: 0 }}
                          />
                          <strong>{t.name}</strong>
                        </span>
                      </td>
                      <td>{ABSENCE_CATEGORY_LABELS[t.category]}</td>
                      <td>
                        <span className="row row--wrap" style={{ gap: 5 }}>
                          <Badge tone={t.paid === 1 ? 'green' : 'neutral'}>{t.paid === 1 ? 'bezahlt' : 'unbezahlt'}</Badge>
                          {t.affects_balance === 1 && <Badge tone="blue">saldowirksam</Badge>}
                          {t.requires_proof === 1 && <Badge tone="yellow">Nachweis</Badge>}
                          {t.requires_approval === 1 && <Badge tone="navy">Genehmigung</Badge>}
                          {t.portal_visibility === 'neutral' && <Badge tone="neutral">Portal: „Abwesend“</Badge>}
                          {/*
                            Krankheits-Art im Klartext: in der Liste sichtbar machen,
                            damit die Einstellung bei einer Datenschutz-Prüfung auffällt,
                            ohne jede Art einzeln öffnen zu müssen (Art. 9 DSGVO).
                          */}
                          {t.category === 'krankheit' && (t.portal_visibility ?? 'name') === 'name' && (
                            <span title="Der Firmenkalender im Portal zeigt allen Kolleg:innen den Klartext-Grund. Gesundheitsdaten sind nach Art. 9 DSGVO besonders geschützt — bitte prüfen.">
                              <Badge tone="red">Portal: Klartext</Badge>
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="num">{t.max_days_per_year ?? '—'}</td>
                      <td>
                        {t.category === 'krankheit' ? (
                          // Krankmeldungen werden nie geprüft — das muss hier stehen,
                          // sonst wirken hinterlegte Regeln so, als griffen sie.
                          <span
                            style={{ color: 'var(--text-muted)' }}
                            title="Krankmeldungen sind von der Berechtigungsprüfung ausgenommen: Diese Art darf immer beantragt werden."
                          >
                            Immer alle
                          </span>
                        ) : (
                          eligibilitySummary(t)
                        )}
                      </td>
                      <td>{t.active === 1 ? <Badge tone="green">aktiv</Badge> : <Badge tone="neutral">deaktiviert</Badge>}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button
                            className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                            aria-label="Bearbeiten"
                            onClick={() =>
                              setEditing({
                                id: t.id,
                                form: {
                                  name: t.name,
                                  category: t.category,
                                  paid: t.paid === 1,
                                  affects_balance: t.affects_balance === 1,
                                  requires_proof: t.requires_proof === 1,
                                  requires_approval: t.requires_approval === 1,
                                  color: t.color,
                                  max_days_per_year: t.max_days_per_year,
                                  active: t.active === 1,
                                  portal_visibility: t.portal_visibility ?? 'name',
                                },
                              })
                            }
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                            aria-label="Löschen"
                            onClick={() => setDeleting(t)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <ClosuresCard />
      </div>

      <TypeDialog
        state={editing}
        onClose={() => setEditing(null)}
        onSave={(id, form, eligibility) => save.mutate({ id, form, eligibility })}
        saving={save.isPending}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Abwesenheitsart löschen"
        message={
          deleting
            ? `Die Art "${deleting.name}" wird gelöscht. Wird sie bereits verwendet, schlägt das Löschen fehl — deaktivieren Sie sie dann stattdessen über "Bearbeiten".`
            : ''
        }
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

/** Erklärkasten im Dialog. Farben ausschließlich über Tokens (vier Themes). */
function Note({
  tone = 'info',
  icon,
  children,
}: {
  tone?: 'info' | 'warning';
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const accent = tone === 'warning' ? 'var(--warning)' : 'var(--info)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        padding: '9px 12px',
        borderRadius: 'var(--radius-sm)',
        borderLeft: `3px solid ${accent}`,
        background: tone === 'warning' ? 'var(--warning-bg)' : 'var(--info-bg)',
        color: 'var(--text-secondary)',
        fontSize: 'var(--text-sm)',
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: accent, flexShrink: 0, marginTop: 1 }} aria-hidden="true">
        {icon ?? <Info size={15} />}
      </span>
      <span>{children}</span>
    </div>
  );
}

function TypeDialog({
  state,
  onClose,
  onSave,
  saving,
}: {
  state: { id: number | null; form: TypeForm } | null;
  onClose: () => void;
  onSave: (id: number | null, form: TypeForm, eligibility: AbsenceTypeEligibility) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<TypeForm>(EMPTY_FORM);
  const [key, setKey] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<AbsenceTypeEligibility>(EMPTY_ELIGIBILITY);
  // Für welche Art die gespeicherte Berechtigung bereits übernommen wurde.
  const [eligibilityLoadedFor, setEligibilityLoadedFor] = useState<number | null>(null);
  const [pickEmployee, setPickEmployee] = useState<number | null>(null);
  const [pickEffect, setPickEffect] = useState<'allow' | 'deny'>('deny');

  const roleGroupId = useId();
  const ruleGroupId = useId();
  const sicknessWarningId = useId();
  const { data: roles, isLoading: rolesLoading } = useRoles();
  // Inaktive einschließen, damit auch Ausnahmen zu ausgeschiedenen Personen
  // mit Namen statt nur mit id angezeigt werden.
  const { data: employees } = useEmployees(true);

  const eligibilityQuery = useQuery({
    queryKey: ['absences', 'types', state?.id ?? 0, 'eligibility'],
    queryFn: () => api.get<AbsenceTypeEligibility>(`/api/absences/types/${state?.id}/eligibility`),
    enabled: state !== null && state.id !== null,
  });

  // Formular beim Öffnen mit den Werten des Dialog-Ziels initialisieren.
  const stateKey = state === null ? null : `${state.id ?? 'neu'}`;
  if (stateKey !== key) {
    setKey(stateKey);
    setEligibility(EMPTY_ELIGIBILITY);
    setEligibilityLoadedFor(null);
    setPickEmployee(null);
    setPickEffect('deny');
    if (state) setForm(state.form);
  }
  // Gespeicherte Berechtigung genau einmal je Dialogöffnung übernehmen, sonst
  // würde ein Refetch die noch nicht gespeicherten Änderungen überschreiben.
  if (state?.id != null && eligibilityQuery.data && eligibilityLoadedFor !== state.id) {
    setEligibilityLoadedFor(state.id);
    setEligibility({
      role_ids: [...eligibilityQuery.data.role_ids],
      employee_rules: eligibilityQuery.data.employee_rules.map((r) => ({ ...r })),
    });
  }

  if (!state) return null;

  const set = (patch: Partial<TypeForm>) => setForm((f) => ({ ...f, ...patch }));

  const isSickness = form.category === 'krankheit';
  // Krankheits-Art im Portal-Kalender im Klartext = Gesundheitsdatum für alle
  // Kolleg:innen sichtbar (Art. 9 DSGVO). Nicht gesperrt, aber deutlich benannt.
  const sicknessInClear = isSickness && form.portal_visibility === 'name';

  /**
   * Kategoriewechsel. Wird auf „Krankheit“ umgestellt, zieht die Vorgabe für die
   * Portal-Sichtbarkeit auf „neutral“ nach — dieselbe Vorgabe, die das Backend
   * ohne das Feld setzt (`defaultPortalVisibility` in modules/absences/routes.ts).
   * Sonst zeigte das Formular weiter den Klartext an, während der Server etwas
   * anderes speichert. Die Auswahl bleibt änderbar: Wer den Klartext bewusst
   * will, stellt sie zurück und sieht dann die Warnung.
   */
  const changeCategory = (category: AbsenceCategory) =>
    set(
      category === 'krankheit' && form.portal_visibility === 'name'
        ? { category, portal_visibility: 'neutral' }
        : { category },
    );
  // Bei bestehenden Arten erst speichern, wenn die gespeicherte Berechtigung
  // wirklich da ist — sonst würde ein leeres Formular sie überschreiben.
  const eligibilityReady = state.id === null || eligibilityLoadedFor === state.id;

  const toggleRole = (roleId: number, checked: boolean) =>
    setEligibility((e) => ({
      ...e,
      role_ids: checked ? [...e.role_ids, roleId] : e.role_ids.filter((id) => id !== roleId),
    }));

  const addRule = () => {
    if (pickEmployee === null) return;
    setEligibility((e) => ({
      ...e,
      // Je Person nur eine Regel — eine erneute Auswahl ersetzt die Wirkung.
      employee_rules: [
        ...e.employee_rules.filter((r) => r.employee_id !== pickEmployee),
        { employee_id: pickEmployee, effect: pickEffect },
      ],
    }));
    setPickEmployee(null);
  };

  const removeRule = (employeeId: number) =>
    setEligibility((e) => ({
      ...e,
      employee_rules: e.employee_rules.filter((r) => r.employee_id !== employeeId),
    }));

  const nameOf = (employeeId: number) => {
    const match = (employees ?? []).find((e) => e.id === employeeId);
    return match ? employeeName(match) : `Person #${employeeId}`;
  };

  // Deaktivierte Rollen nur zeigen, wenn sie noch zugeordnet sind.
  const visibleRoles = (roles ?? []).filter((r) => r.active === 1 || eligibility.role_ids.includes(r.id));

  return (
    <Modal
      title={state.id === null ? 'Neue Abwesenheitsart' : 'Abwesenheitsart bearbeiten'}
      open
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={saving || form.name.trim().length === 0 || !eligibilityReady}
            onClick={() => onSave(state.id, { ...form, name: form.name.trim() }, eligibility)}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2>
          <input className="hm-input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Kategorie" required>
          <select
            className="hm-select"
            value={form.category}
            onChange={(e) => changeCategory(e.target.value as AbsenceCategory)}
          >
            {Object.entries(ABSENCE_CATEGORY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Farbe">
          <input
            className="hm-input"
            type="color"
            value={form.color}
            onChange={(e) => set({ color: e.target.value })}
            style={{ padding: 3, height: 36 }}
          />
        </Field>
        <Field label="Max. Tage pro Jahr" hint="Leer lassen für unbegrenzt">
          <input
            className="hm-input"
            type="number"
            min={0.5}
            step={0.5}
            value={form.max_days_per_year ?? ''}
            onChange={(e) => set({ max_days_per_year: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </Field>
        <div className="hm-field">
          <span className="hm-field__label">Eigenschaften</span>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.paid} onChange={(e) => set({ paid: e.target.checked })} />
            bezahlt
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.affects_balance} onChange={(e) => set({ affects_balance: e.target.checked })} />
            saldowirksam (zählt gegen Urlaubsanspruch)
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.requires_proof} onChange={(e) => set({ requires_proof: e.target.checked })} />
            Nachweis erforderlich
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.requires_approval} onChange={(e) => set({ requires_approval: e.target.checked })} />
            genehmigungspflichtig
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
            aktiv
          </label>
        </div>

        <Field
          label="Sichtbarkeit im Mitarbeitenden-Portal"
          span2
          hint="Gilt für den Firmenkalender im Portal — für die eigene Abwesenheit sieht die Person die Art immer im Klartext."
        >
          <select
            className="hm-select"
            value={form.portal_visibility}
            onChange={(e) => set({ portal_visibility: e.target.value as PortalVisibility })}
            aria-describedby={sicknessInClear ? sicknessWarningId : undefined}
            // Die riskante Kombination (Krankheit + Klartext) auch am Feld selbst
            // markieren, nicht nur im Hinweiskasten darunter.
            style={sicknessInClear ? { borderColor: 'var(--warning)' } : undefined}
          >
            {(Object.entries(PORTAL_VISIBILITY_LABELS) as [PortalVisibility, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="span-2">
          <Note>
            <strong>{PORTAL_VISIBILITY_LABELS.name}:</strong> Kolleg:innen sehen im Firmenkalender den Namen der Art
            (z. B. „Home Office“). <strong>{PORTAL_VISIBILITY_LABELS.neutral}:</strong> Sie sehen nur, <em>dass</em> jemand
            abwesend ist — der Grund bleibt verborgen.
          </Note>
        </div>
        {isSickness && (
          <div className="span-2" id={sicknessWarningId}>
            {sicknessInClear ? (
              // Sachlich, nicht bevormundend: Die Auswahl bleibt möglich, aber
              // niemand soll Gesundheitsdaten versehentlich veröffentlichen.
              <Note tone="warning" icon={<ShieldAlert size={15} />}>
                <strong>Achtung — Gesundheitsdaten im Firmenkalender.</strong> Mit „{PORTAL_VISIBILITY_LABELS.name}“
                sieht <em>jede Person im Portal</em>, dass eine Kollegin oder ein Kollege krank ist. Krankheitsdaten
                gehören nach Art. 9 DSGVO zu den besonderen Kategorien personenbezogener Daten; ihre Offenlegung
                gegenüber der Belegschaft braucht eine tragfähige Grundlage. Treffen Sie diese Entscheidung bewusst und
                stimmen Sie sie mit Datenschutz und Mitbestimmung ab.{' '}
                <button
                  className="hm-btn hm-btn--sm hm-btn--secondary"
                  style={{ marginTop: 6 }}
                  onClick={() => set({ portal_visibility: 'neutral' })}
                >
                  Auf „{PORTAL_VISIBILITY_LABELS.neutral}“ stellen
                </button>
              </Note>
            ) : (
              <Note icon={<ShieldAlert size={15} />}>
                Empfohlene Einstellung für Krankheits-Arten: Der Firmenkalender zeigt nur, dass jemand abwesend ist.
                Der Grund bleibt — wie bei Gesundheitsdaten nach Art. 9 DSGVO geboten — für Kolleg:innen verborgen.
              </Note>
            )}
          </div>
        )}

        <fieldset
          className="span-2"
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            margin: 0,
            padding: '12px 14px 14px',
            display: 'grid',
            gap: 12,
            // Fieldsets haben min-width:min-content — ohne das sprengt die
            // Rollenliste im Grid die Dialogbreite.
            minWidth: 0,
          }}
        >
          <legend
            style={{
              padding: '0 6px',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Wer darf diese Art beantragen?
          </legend>

          {isSickness && (
            <Note tone="warning" icon={<ShieldAlert size={15} />}>
              Kategorie „Krankheit“: Eine Krankmeldung darf nie blockiert werden. Die folgenden Regeln werden für diese
              Art deshalb <strong>nicht ausgewertet</strong> — sie greifen erst, wenn Sie die Kategorie wechseln.
            </Note>
          )}

          <Note>
            <strong>Keine Rolle ausgewählt heißt: alle dürfen.</strong> Erst wenn mindestens eine Rolle angehakt ist,
            beschränkt sich die Art auf Personen mit einer dieser Rollen.
          </Note>

          <div role="group" aria-labelledby={roleGroupId} style={{ display: 'grid', gap: 8 }}>
            <div className="row row--between" style={{ alignItems: 'baseline', gap: 10 }}>
              <span id={roleGroupId} className="hm-field__label" style={{ margin: 0 }}>
                Rollen
              </span>
              {eligibility.role_ids.length > 0 && (
                <button
                  className="hm-btn hm-btn--sm hm-btn--ghost"
                  onClick={() => setEligibility((e) => ({ ...e, role_ids: [] }))}
                >
                  Auswahl aufheben (alle dürfen)
                </button>
              )}
            </div>
            {rolesLoading ? (
              <Spinner />
            ) : visibleRoles.length === 0 ? (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                Es sind noch keine Rollen angelegt — anzulegen unter Verwaltung → Rollen. Ohne Rollen darf jede und jeder
                diese Art beantragen.
              </span>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                  gap: '6px 16px',
                  maxHeight: 176,
                  overflowY: 'auto',
                }}
              >
                {visibleRoles.map((r) => (
                  <label className="hm-checkbox" key={r.id} title={r.description ?? undefined}>
                    <input
                      type="checkbox"
                      checked={eligibility.role_ids.includes(r.id)}
                      onChange={(e) => toggleRole(r.id, e.target.checked)}
                    />
                    {r.name}
                    {r.active !== 1 && <span style={{ color: 'var(--text-muted)' }}>(deaktiviert)</span>}
                  </label>
                ))}
              </div>
            )}
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              {eligibility.role_ids.length === 0
                ? 'Aktuell: alle Mitarbeitenden dürfen diese Art beantragen.'
                : `Aktuell: nur Mitarbeitende mit einer der ${eligibility.role_ids.length} gewählten Rollen dürfen beantragen.`}
            </span>
          </div>

          <div
            role="group"
            aria-labelledby={ruleGroupId}
            style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}
          >
            <span id={ruleGroupId} className="hm-field__label" style={{ margin: 0 }}>
              Personen-Ausnahmen
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Eine Personenregel schlägt die Rollenregel: „darf“ erlaubt trotz fehlender Rolle, „darf nicht“ sperrt trotz
              passender Rolle.
            </span>
            <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Person">
                <EmployeeSelect value={pickEmployee} onChange={setPickEmployee} emptyLabel="— Person wählen —" />
              </Field>
              <Field label="Regel">
                <select
                  className="hm-select"
                  value={pickEffect}
                  onChange={(e) => setPickEffect(e.target.value as 'allow' | 'deny')}
                >
                  <option value="allow">darf</option>
                  <option value="deny">darf nicht</option>
                </select>
              </Field>
              <button className="hm-btn hm-btn--secondary" disabled={pickEmployee === null} onClick={addRule}>
                <Plus size={15} /> Ausnahme hinzufügen
              </button>
            </div>
            {eligibility.employee_rules.length === 0 ? (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                Keine Ausnahmen — es gilt allein die Rollenregel.
              </span>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {eligibility.employee_rules.map((r) => (
                  <li
                    key={r.employee_id}
                    className="row row--between"
                    style={{
                      gap: 10,
                      padding: '6px 8px 6px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-tint-2)',
                    }}
                  >
                    <span className="row" style={{ gap: 8 }}>
                      <Badge tone={r.effect === 'allow' ? 'green' : 'red'}>
                        {r.effect === 'allow' ? 'darf' : 'darf nicht'}
                      </Badge>
                      <span>{nameOf(r.employee_id)}</span>
                    </span>
                    <button
                      className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                      aria-label={`Ausnahme für ${nameOf(r.employee_id)} entfernen`}
                      onClick={() => removeRule(r.employee_id)}
                    >
                      <X size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {state.id !== null && !eligibilityReady && (
            <Note tone="warning" icon={<ShieldAlert size={15} />}>
              {eligibilityQuery.isError ? (
                <>
                  Die gespeicherte Berechtigung konnte nicht geladen werden. Speichern ist gesperrt, damit bestehende
                  Regeln nicht versehentlich überschrieben werden.{' '}
                  <button className="hm-btn hm-btn--sm hm-btn--ghost" onClick={() => eligibilityQuery.refetch()}>
                    Erneut laden
                  </button>
                </>
              ) : (
                'Gespeicherte Berechtigung wird geladen …'
              )}
            </Note>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

function ClosuresCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: closures, isLoading } = useClosures();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [deleting, setDeleting] = useState<CompanyClosure | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/api/absences/closures', { name: name.trim(), date_from: from, date_to: to }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('Betriebsruhe angelegt');
      setName('');
      setFrom('');
      setTo('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/absences/closures/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('Betriebsruhe gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card title="Betriebsruhetage" flush>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Bezeichnung">
            <input
              className="hm-input"
              style={{ width: 220 }}
              value={name}
              placeholder="z. B. Zwischen den Jahren"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Von">
            <input className="hm-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Bis">
            <input className="hm-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button
            className="hm-btn hm-btn--secondary"
            disabled={!name.trim() || !from || !to || to < from || create.isPending}
            onClick={() => create.mutate()}
          >
            Anlegen
          </button>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 8 }}>
          Betriebsruhetage werden bei der Berechnung der Abwesenheitstage nicht mitgezählt.
        </div>
      </div>
      {isLoading ? (
        <Spinner center />
      ) : !closures || closures.length === 0 ? (
        <EmptyState icon={<CalendarOff size={40} />} title="Keine Betriebsruhetage hinterlegt" />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th>Zeitraum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {closures.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    {formatDate(c.date_from)} – {formatDate(c.date_to)}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                        aria-label="Löschen"
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Betriebsruhe löschen"
        message={deleting ? `"${deleting.name}" (${formatDate(deleting.date_from)} – ${formatDate(deleting.date_to)}) löschen? Bereits berechnete Anträge bleiben unverändert.` : ''}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
