import React, { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Contact, MapPin, Plus, Trash2, User, Users, UsersRound, X } from 'lucide-react';
import {
  DISTRIBUTION_MEMBER_TYPE_LABELS,
  DISTRIBUTION_MEMBER_TYPES,
  type DistributionMemberType,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/Modal';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { employeeName, useEmployees, type EmployeeLite } from '../../components/EmployeeSelect';
import { useDistributionList, useDistributionLists, useInvalidate, useOrg, type OrgData } from './api';

/**
 * Verteiler: HR-gepflegte Zielgruppen aus Abteilungen (samt
 * Unterabteilungen), Teams, Standorten und einzelnen Personen. Ankuendigungen
 * und Umfragen waehlen sie als Zielgruppe „Verteiler“.
 *
 * Eine Person, die ueber eine gewaehlte Einheit schon erreicht wird, steht
 * in der Personenauswahl nicht mehr zur Verfuegung; kommt die Einheit nach
 * der Person dazu, faellt die Person still aus der Liste (Hinweis per Toast).
 * Das Backend weist ein solches Doppel ohnehin mit 400 ab.
 */

interface Member {
  member_type: DistributionMemberType;
  member_id: number;
  /** Anzeigename aus der Detailantwort bzw. der Auswahl; null, wenn unbekannt. */
  name: string | null;
}

const MEMBER_ICON: Record<DistributionMemberType, React.ReactNode> = {
  abteilung: <Building2 size={13} />,
  team: <UsersRound size={13} />,
  standort: <MapPin size={13} />,
  mitarbeiter: <User size={13} />,
};

/** Abteilung samt aller Unterabteilungen (departments.parent_id). */
function subtreeOf(rootIds: number[], departments: OrgData['departments']): Set<number> {
  const result = new Set<number>(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of departments) {
      if (d.parent_id !== null && result.has(d.parent_id) && !result.has(d.id)) {
        result.add(d.id);
        grew = true;
      }
    }
  }
  return result;
}

/** Wird die Person ueber Abteilung, Team oder Standort der Mitglieder erreicht? */
function coveredBy(members: Member[], org: OrgData | undefined) {
  const departments = subtreeOf(
    members.filter((m) => m.member_type === 'abteilung').map((m) => m.member_id),
    org?.departments ?? [],
  );
  const teams = new Set(members.filter((m) => m.member_type === 'team').map((m) => m.member_id));
  const locations = new Set(members.filter((m) => m.member_type === 'standort').map((m) => m.member_id));
  return (e: EmployeeLite) =>
    (e.department_id !== null && departments.has(e.department_id)) ||
    (e.team_id !== null && teams.has(e.team_id)) ||
    (e.location_id !== null && locations.has(e.location_id));
}

/**
 * Name aus der Antwort zuerst (deckt auch ausgeschiedene Personen, die die
 * aktive Liste nicht kennt), sonst aus den Auswahllisten.
 */
function memberLabel(m: Member, org: OrgData | undefined, employees: EmployeeLite[] | undefined): string {
  if (m.name) return m.name;
  if (m.member_type === 'mitarbeiter') {
    const e = employees?.find((x) => x.id === m.member_id);
    return e ? employeeName(e) : `Person #${m.member_id}`;
  }
  const pool =
    m.member_type === 'abteilung' ? org?.departments : m.member_type === 'team' ? org?.teams : org?.locations;
  return pool?.find((x) => x.id === m.member_id)?.name ?? `${DISTRIBUTION_MEMBER_TYPE_LABELS[m.member_type]} #${m.member_id}`;
}

interface FormState {
  name: string;
  description: string;
  members: Member[];
}

const EMPTY_FORM: FormState = { name: '', description: '', members: [] };

function ListEditor({
  listId,
  onSaved,
  onCancelNew,
}: {
  /** null = neuer Verteiler */
  listId: number | null;
  onSaved: (id: number) => void;
  onCancelNew: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: org } = useOrg();
  const { data: employees } = useEmployees();
  const { data: detail, isLoading } = useDistributionList(listId);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loadedFor, setLoadedFor] = useState<number | null | 'new'>('new');
  const [pickType, setPickType] = useState<DistributionMemberType>('abteilung');
  const [pickId, setPickId] = useState<number | null>(null);

  // Formular beim Wechsel des Verteilers neu befuellen (Render-Phase, kein Effekt).
  const key = listId ?? 'new';
  if (key !== loadedFor) {
    if (listId === null) {
      setForm(EMPTY_FORM);
      setLoadedFor('new');
    } else if (detail && detail.id === listId) {
      setForm({
        name: detail.name,
        description: detail.description ?? '',
        members: detail.members.map((m) => ({ member_type: m.member_type, member_id: m.member_id, name: m.name })),
      });
      setLoadedFor(listId);
    }
  }

  const isCovered = useMemo(() => coveredBy(form.members, org), [form.members, org]);

  const chosen = new Set(form.members.map((m) => `${m.member_type}:${m.member_id}`));
  const options: { id: number; label: string; name: string }[] =
    pickType === 'mitarbeiter'
      ? (employees ?? [])
          .filter((e) => !chosen.has(`mitarbeiter:${e.id}`) && !isCovered(e))
          .map((e) => ({ id: e.id, label: `${e.last_name}, ${e.first_name}`, name: employeeName(e) }))
      : (
          (pickType === 'abteilung' ? org?.departments : pickType === 'team' ? org?.teams : org?.locations) ?? []
        )
          .filter((x) => !chosen.has(`${pickType}:${x.id}`))
          .map((x) => ({ id: x.id, label: x.name, name: x.name }));

  const addMember = () => {
    if (pickId === null) return;
    const picked = options.find((o) => o.id === pickId);
    const next: Member[] = [...form.members, { member_type: pickType, member_id: pickId, name: picked?.name ?? null }];
    // Personen, die die neue Einheit jetzt mit abdeckt, fallen heraus.
    const covered = coveredBy(next, org);
    const dropped = next.filter(
      (m) => m.member_type === 'mitarbeiter' && employees?.some((e) => e.id === m.member_id && covered(e)),
    );
    const cleaned = dropped.length === 0 ? next : next.filter((m) => !dropped.includes(m));
    if (dropped.length > 0) {
      toast.success(
        `${dropped.length === 1 ? 'Eine Person wird' : `${dropped.length} Personen werden`} jetzt über die Einheit erreicht und ${dropped.length === 1 ? 'wurde' : 'wurden'} aus der Einzelauswahl entfernt.`,
      );
    }
    setForm((f) => ({ ...f, members: cleaned }));
    setPickId(null);
  };

  const removeMember = (m: Member) =>
    setForm((f) => ({
      ...f,
      members: f.members.filter((x) => !(x.member_type === m.member_type && x.member_id === m.member_id)),
    }));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        members: form.members.map((m) => ({ member_type: m.member_type, member_id: m.member_id })),
      };
      return listId === null
        ? api.post<{ distribution_list: { id: number } }>('/api/communication/distribution-lists', payload)
        : api.put<{ distribution_list: { id: number } }>(`/api/communication/distribution-lists/${listId}`, payload);
    },
    onSuccess: (res) => {
      toast.success(listId === null ? 'Verteiler angelegt' : 'Verteiler gespeichert');
      invalidate('distribution-lists');
      invalidate('org');
      onSaved(res.distribution_list.id);
    },
    onError: (e) => toast.error(e.message),
  });

  if (listId !== null && (isLoading || !detail)) return <Spinner center />;

  const grouped = DISTRIBUTION_MEMBER_TYPES.map((t) => ({
    type: t,
    items: form.members.filter((m) => m.member_type === t),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="hm-form-grid">
        <Field label="Name" required>
          <input
            className="hm-input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="z. B. Führungskreis, Standort Köln + Vertrieb"
          />
        </Field>
        <Field label="Beschreibung">
          <input
            className="hm-input"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
      </div>

      <div>
        <div className="hm-field__label" style={{ marginBottom: 8 }}>
          Mitglied hinzufügen
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Select
            className="hm-select"
            style={{ width: 150 }}
            value={pickType}
            onChange={(e) => {
              setPickType(e.target.value as DistributionMemberType);
              setPickId(null);
            }}
          >
            {DISTRIBUTION_MEMBER_TYPES.map((t) => (
              <option key={t} value={t}>
                {DISTRIBUTION_MEMBER_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select
            className="hm-select"
            style={{ minWidth: 260, flex: 1 }}
            value={pickId ?? ''}
            onChange={(e) => setPickId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">
              {options.length === 0
                ? pickType === 'mitarbeiter'
                  ? 'Alle Personen sind bereits enthalten oder erreicht'
                  : 'Keine weitere Einheit verfügbar'
                : 'Bitte auswählen'}
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          <button className="hm-btn hm-btn--secondary" disabled={pickId === null} onClick={addMember}>
            <Plus size={14} /> Hinzufügen
          </button>
        </div>
        {pickType === 'mitarbeiter' && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            Personen, die über eine enthaltene Abteilung, ein Team oder einen Standort bereits erreicht
            werden, stehen hier nicht zur Auswahl.
          </p>
        )}
      </div>

      <div>
        <div className="hm-field__label" style={{ marginBottom: 8 }}>
          Mitglieder ({form.members.length})
        </div>
        {form.members.length === 0 ? (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Noch keine Mitglieder. Ein leerer Verteiler erreicht niemanden.
          </p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {grouped.map((g) => (
              <div key={g.type}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 4 }}>
                  {DISTRIBUTION_MEMBER_TYPE_LABELS[g.type]}
                  {g.type === 'abteilung' ? ' (samt Unterabteilungen)' : ''}
                </div>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  {g.items.map((m) => (
                    <span key={`${m.member_type}:${m.member_id}`} className="hm-chip hm-chip--static">
                      {MEMBER_ICON[m.member_type]}
                      {memberLabel(m, org, employees)}
                      <button
                        type="button"
                        className="hm-chip__remove"
                        aria-label="Entfernen"
                        onClick={() => removeMember(m)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {listId === null && (
          <button className="hm-btn hm-btn--secondary" onClick={onCancelNew}>
            Abbrechen
          </button>
        )}
        <button
          className="hm-btn hm-btn--primary"
          disabled={save.isPending || form.name.trim() === ''}
          onClick={() => save.mutate()}
        >
          {listId === null ? 'Anlegen' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

export function DistributionListsPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const { data: lists, isLoading } = useDistributionLists();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; usage_count: number } | null>(null);

  const selected = creating ? null : (lists?.find((l) => l.id === selectedId) ?? lists?.[0] ?? null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/communication/distribution-lists/${id}`),
    onSuccess: (_, id) => {
      toast.success('Verteiler gelöscht');
      // Detailabfrage des geloeschten Verteilers verwerfen, sonst holt die
      // Invalidierung sie noch einmal und bekommt ein 404.
      qc.removeQueries({ queryKey: ['communication', 'distribution-lists', id] });
      invalidate('distribution-lists');
      invalidate('org');
      setSelectedId(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Verteiler"
        subtitle="Zielgruppen für Ankündigungen und Umfragen"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Neuer Verteiler
          </button>
        }
      />

      {isLoading ? (
        <Spinner center />
      ) : (lists?.length ?? 0) === 0 && !creating ? (
        <div className="hm-card">
          <EmptyState
            icon={<Contact size={40} />}
            title="Noch keine Verteiler"
            hint="Ein Verteiler bündelt Abteilungen, Teams, Standorte und einzelne Personen zu einer Zielgruppe."
            action={
              <button className="hm-btn hm-btn--primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Verteiler anlegen
              </button>
            }
          />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 340px) 1fr',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div className="hm-card">
            <div className="hm-card__body hm-card__body--flush">
              {(lists ?? []).map((l) => {
                const active = !creating && selected?.id === l.id;
                return (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setCreating(false);
                      setSelectedId(l.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setCreating(false);
                        setSelectedId(l.id);
                      }
                    }}
                    style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--gray-100)',
                      cursor: 'pointer',
                      background: active ? 'var(--blue-50)' : undefined,
                    }}
                  >
                    <div className="row row--between">
                      <span style={{ fontWeight: 650 }}>{l.name}</span>
                      <div className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                        <Tooltip
                          content={
                            <>
                              <span className="hm-tooltip__title">Löschen</span>
                              {l.usage_count > 0 && (
                                <span className="hm-tooltip__line">
                                  Noch in {l.usage_count} {l.usage_count === 1 ? 'Verwendung' : 'Verwendungen'}
                                </span>
                              )}
                            </>
                          }
                        >
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            aria-label="Verteiler löschen"
                            disabled={l.usage_count > 0}
                            onClick={() => setDeleteTarget(l)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                    {l.description && (
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
                        {l.description}
                      </div>
                    )}
                    <div className="row row--wrap" style={{ gap: 6, marginTop: 6 }}>
                      <Badge tone="blue">
                        <Users size={11} /> {l.recipients}
                      </Badge>
                      <Badge tone="neutral">
                        {l.member_count} {l.member_count === 1 ? 'Mitglied' : 'Mitglieder'}
                      </Badge>
                      {l.usage_count > 0 && (
                        <Badge tone="yellow">
                          {l.usage_count} {l.usage_count === 1 ? 'Verwendung' : 'Verwendungen'}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="hm-card">
            <header className="hm-card__header">
              <div>
                <div className="hm-card__title">{creating ? 'Neuer Verteiler' : (selected?.name ?? '')}</div>
                {!creating && selected && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {selected.recipients} {selected.recipients === 1 ? 'aktive Person' : 'aktive Personen'} erreicht
                  </div>
                )}
              </div>
            </header>
            <div className="hm-card__body">
              {creating ? (
                <ListEditor
                  listId={null}
                  onSaved={(id) => {
                    setCreating(false);
                    setSelectedId(id);
                  }}
                  onCancelNew={() => setCreating(false)}
                />
              ) : selected ? (
                <ListEditor key={selected.id} listId={selected.id} onSaved={() => undefined} onCancelNew={() => undefined} />
              ) : (
                <EmptyState icon={<Contact size={40} />} title="Kein Verteiler ausgewählt" />
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Verteiler löschen"
        message={`Soll der Verteiler „${deleteTarget?.name}“ gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
