import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, ShieldCheck, Trash2, Users } from 'lucide-react';
import { formatDate, type Role, type RoleMember } from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useEmployees, type EmployeeLite } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';

const ROLES_KEY = ['admin', 'roles'];

function useRoles() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: () => api.get<{ roles: Role[] }>('/api/admin/roles'),
    select: (d) => d.roles,
  });
}

/**
 * Rollen einer jeden Person — Map employee_id -> role_ids.
 *
 * Warum diese Umkehrung? Das Backend kennt bewusst nur das vollständige Ersetzen
 * je Person (`PUT /api/admin/employees/:id/roles`); ein „Person zu Rolle X
 * hinzufügen" gibt es nicht. Um beim Speichern einer Mitgliederliste die
 * *übrigen* Rollen einer Person nicht zu verlieren, brauchen wir deren
 * kompletten Bestand. Die Rollenliste ist klein (Startbestand: sieben), daher
 * ist das parallele Abrufen aller Mitgliederlisten günstiger und einfacher als
 * ein neuer Endpunkt.
 */
function useRoleAssignments(roles: Role[] | undefined, enabled: boolean) {
  const roleIds = (roles ?? []).map((r) => r.id);
  return useQuery({
    queryKey: [...ROLES_KEY, 'assignments', roleIds],
    enabled: enabled && roleIds.length > 0,
    queryFn: async () => {
      const perRole = await Promise.all(
        roleIds.map(async (id) => ({
          id,
          members: (await api.get<{ employees: RoleMember[] }>(`/api/admin/roles/${id}/members`))
            .employees,
        })),
      );
      const byEmployee = new Map<number, number[]>();
      for (const { id, members } of perRole) {
        for (const m of members) byEmployee.set(m.id, [...(byEmployee.get(m.id) ?? []), id]);
      }
      return byEmployee;
    },
  });
}

/**
 * Fachrollen der Organisation. Bewusst getrennt von der Zugriffsrolle des
 * Kontos (`admin`/`mitarbeiter`) und von der Beschäftigungsart: Rollen steuern
 * fachliche Berechtigungen, allen voran die Frage, wer welche Abwesenheitsart
 * beantragen darf (Abwesenheit → Abwesenheitsarten).
 */
export function RolesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [membersRole, setMembersRole] = useState<Role | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);

  const { data: roles, isLoading } = useRoles();

  const invalidate = () => qc.invalidateQueries({ queryKey: ROLES_KEY });

  const toggleActive = useMutation({
    mutationFn: (role: Role) =>
      api.patch(`/api/admin/roles/${role.id}`, { active: role.active !== 1 }),
    onSuccess: (_d, role) => {
      invalidate();
      toast.success(role.active === 1 ? 'Rolle deaktiviert' : 'Rolle aktiviert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/roles/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Rolle gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Rollen"
        subtitle="Fachrollen der Organisation — Grundlage dafür, wer welche Abwesenheitsart beantragen darf."
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setEditRole(null);
              setDialogOpen(true);
            }}
          >
            <Plus size={16} /> Rolle anlegen
          </button>
        }
      />

      {/* Der Startbestand stammt aus den Beschäftigungsarten — ohne diesen Hinweis
          wirken gleichnamige Rollen wie eine Dopplung des Personalstammdatums. */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '12px 14px',
          marginBottom: 16,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--info-bg)',
          border: '1px solid var(--blue-200)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
        }}
      >
        <ShieldCheck size={18} style={{ flexShrink: 0, color: 'var(--info)' }} aria-hidden="true" />
        <span>
          Beim ersten Start wurde je Beschäftigungsart eine gleichnamige Rolle angelegt und allen
          Mitarbeitenden passend zugewiesen. Seitdem werden Rollen unabhängig davon gepflegt: Sie
          dürfen frei von der Beschäftigungsart abweichen, und Änderungen hier wirken sich nicht auf
          das Personalprofil aus.
        </span>
      </div>

      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (roles?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={40} />}
            title="Keine Rollen vorhanden"
            hint="Legen Sie die erste Rolle an — z. B. „Werkstudent“ oder „Außendienst“ — und weisen Sie ihr anschließend Mitglieder zu."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Rolle</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 130 }}>Mitglieder</th>
                  <th style={{ width: 120 }}>Angelegt</th>
                  <th style={{ width: 260 }} />
                </tr>
              </thead>
              <tbody>
                {roles!.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {r.description || '—'}
                      </div>
                    </td>
                    <td>
                      {r.active === 1 ? (
                        <Badge tone="green">Aktiv</Badge>
                      ) : (
                        <Badge tone="neutral">Inaktiv</Badge>
                      )}
                    </td>
                    <td>
                      {r.member_count ?? 0}{' '}
                      <span style={{ color: 'var(--text-muted)' }}>
                        {(r.member_count ?? 0) === 1 ? 'Person' : 'Personen'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>
                      {formatDate(r.created_at.slice(0, 10))}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--sm hm-btn--secondary"
                          onClick={() => setMembersRole(r)}
                        >
                          <Users size={14} /> Mitglieder
                        </button>
                        <button
                          className="hm-btn hm-btn--sm hm-btn--ghost"
                          disabled={toggleActive.isPending}
                          onClick={() => toggleActive.mutate(r)}
                        >
                          {r.active === 1 ? 'Deaktivieren' : 'Aktivieren'}
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Rolle bearbeiten"
                          aria-label={`Rolle ${r.name} bearbeiten`}
                          onClick={() => {
                            setEditRole(r);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Rolle löschen"
                          aria-label={`Rolle ${r.name} löschen`}
                          onClick={() => setConfirmDelete(r)}
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

      <RoleDialog open={dialogOpen} role={editRole} onClose={() => setDialogOpen(false)} />
      <MembersDialog role={membersRole} onClose={() => setMembersRole(null)} />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Rolle „${confirmDelete?.name ?? ''}“ löschen?`}
        message={
          <>
            Die Rolle wird vollständig entfernt. Damit entfallen auch:
            <ul style={{ margin: '10px 0 10px 18px', display: 'grid', gap: 4 }}>
              <li>
                die Zuweisung an {confirmDelete?.member_count ?? 0}{' '}
                {(confirmDelete?.member_count ?? 0) === 1 ? 'Person' : 'Personen'},
              </li>
              <li>
                alle mit dieser Rolle formulierten Berechtigungsregeln für Abwesenheitsarten.
              </li>
            </ul>
            War sie bei einer Abwesenheitsart die einzige freigegebene Rolle, darf diese Art danach
            wieder von allen beantragt werden. Der Vorgang lässt sich nicht rückgängig machen —
            eine gleichnamige Rolle müsste neu angelegt und neu zugewiesen werden.
          </>
        }
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}

/** Anlegen und Bearbeiten teilen sich einen Dialog — die Felder sind identisch. */
function RoleDialog({
  open,
  role,
  onClose,
}: {
  open: boolean;
  role: Role | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setActive(role ? role.active === 1 : true);
  }, [open, role]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        active,
      };
      return role
        ? api.patch(`/api/admin/roles/${role.id}`, body)
        : api.post('/api/admin/roles', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROLES_KEY });
      toast.success(role ? 'Rolle gespeichert' : 'Rolle angelegt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={role ? `Rolle bearbeiten: ${role.name}` : 'Rolle anlegen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2 hint="Muss eindeutig sein, z. B. „Werkstudent“.">
          <input
            className="hm-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Beschreibung"
          span2
          hint="Wofür steht die Rolle? Hilft bei der Pflege der Berechtigungen."
        >
          <textarea
            className="hm-textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="span-2">
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Aktiv</span>
          </label>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Inaktive Rollen bleiben mitsamt ihren Zuweisungen erhalten und werden bei der
            Rollenvergabe nur nicht mehr angeboten.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** Mitgliederpflege einer Rolle: Checkbox-Liste über alle Mitarbeitenden mit Suche. */
function MembersDialog({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const open = role !== null;

  // Inaktive bewusst mit: wer bereits Mitglied ist, muss sichtbar bleiben,
  // sonst zeigt die Liste eine Mitgliedschaft, die es gar nicht gibt.
  const { data: employees } = useEmployees(true);
  const { data: roles } = useRoles();
  const { data: assignments, isLoading: assignmentsLoading } = useRoleAssignments(roles, open);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initial, setInitial] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!open || !assignments || !role) return;
    const members = new Set<number>();
    for (const [employeeId, roleIds] of assignments) {
      if (roleIds.includes(role.id)) members.add(employeeId);
    }
    setSelected(members);
    setInitial(members);
    setSearch('');
    setProgress(null);
  }, [open, assignments, role]);

  const visible = useMemo(() => {
    const list = employees ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? list.filter((e) =>
          `${e.first_name} ${e.last_name} ${e.job_title ?? ''}`.toLowerCase().includes(q),
        )
      : list;
    return [...filtered].sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'de'),
    );
  }, [employees, search]);

  const changed = useMemo(() => {
    const ids = new Set([...selected, ...initial]);
    return [...ids].filter((id) => selected.has(id) !== initial.has(id));
  }, [selected, initial]);

  /**
   * Gespeichert wird je *geänderter* Person ein vollständiges Ersetzen ihrer
   * Rollen — das ist der einzige Schreibweg des Backends. Nacheinander statt
   * parallel: SQLite serialisiert Schreibvorgänge ohnehin, und bei einem Fehler
   * mittendrin bleibt der Zustand nachvollziehbar (alles bis zur Fehlerstelle
   * ist gespeichert, der Rest unverändert). Der Fortschritt wird angezeigt,
   * weil bei großen Rollen spürbar viele Aufrufe zusammenkommen.
   */
  const save = useMutation({
    mutationFn: async () => {
      if (!role || !assignments) return;
      setProgress({ done: 0, total: changed.length });
      for (const [index, employeeId] of changed.entries()) {
        const current = assignments.get(employeeId) ?? [];
        const next = selected.has(employeeId)
          ? [...new Set([...current, role.id])]
          : current.filter((id) => id !== role.id);
        await api.put(`/api/admin/employees/${employeeId}/roles`, { role_ids: next });
        setProgress({ done: index + 1, total: changed.length });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROLES_KEY });
      toast.success(
        changed.length === 1 ? 'Mitgliedschaft gespeichert' : `${changed.length} Änderungen gespeichert`,
      );
      onClose();
    },
    onError: (e: Error) => {
      // Teilerfolge sind bereits geschrieben — Liste neu laden, damit die
      // Anzeige nicht mehr behauptet, nichts sei passiert.
      qc.invalidateQueries({ queryKey: ROLES_KEY });
      toast.error(e.message);
    },
    onSettled: () => setProgress(null),
  });

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setAllVisible = (value: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of visible) {
        if (value) next.add(e.id);
        else next.delete(e.id);
      }
      return next;
    });

  return (
    <Modal
      title={role ? `Mitglieder der Rolle „${role.name}“` : 'Mitglieder'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {progress
              ? `${progress.done} von ${progress.total} gespeichert …`
              : changed.length === 0
                ? 'Keine Änderungen'
                : `${changed.length} ${changed.length === 1 ? 'Änderung' : 'Änderungen'} offen`}
          </span>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={changed.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      {assignmentsLoading || !employees ? (
        <Spinner center />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search
                size={15}
                aria-hidden="true"
                style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }}
              />
              <input
                className="hm-input"
                style={{ paddingLeft: 34 }}
                placeholder="Mitarbeitende suchen (Name, Position)"
                aria-label="Mitarbeitende suchen"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              className="hm-btn hm-btn--sm hm-btn--secondary"
              onClick={() => setAllVisible(true)}
            >
              Alle auswählen
            </button>
            <button
              className="hm-btn hm-btn--sm hm-btn--secondary"
              onClick={() => setAllVisible(false)}
            >
              Auswahl leeren
            </button>
          </div>

          <div
            role="group"
            aria-label={role ? `Mitglieder der Rolle ${role.name}` : 'Mitglieder'}
            style={{
              maxHeight: 380,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: 6,
            }}
          >
            {visible.length === 0 ? (
              <p style={{ padding: 14, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                Keine Mitarbeitenden gefunden. Passen Sie den Suchbegriff an.
              </p>
            ) : (
              visible.map((e: EmployeeLite) => (
                <label
                  key={e.id}
                  className="hm-checkbox"
                  style={{ padding: '6px 8px', width: '100%' }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    disabled={save.isPending}
                    onChange={() => toggle(e.id)}
                  />
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>
                      {e.last_name}, {e.first_name}
                    </span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      {e.job_title || '—'}
                    </span>
                    {e.status !== 'aktiv' && <Badge tone="neutral">Nicht aktiv</Badge>}
                  </span>
                </label>
              ))
            )}
          </div>

          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Gespeichert wird nur, was Sie geändert haben. Andere Rollen der ausgewählten Personen
            bleiben unverändert.
          </p>
        </div>
      )}
    </Modal>
  );
}
