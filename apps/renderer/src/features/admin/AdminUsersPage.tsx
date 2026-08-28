import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, ShieldAlert, Trash2, UserCog } from 'lucide-react';
import {
  ADMIN_AREAS,
  ADMIN_AREA_HINTS,
  ADMIN_AREA_LABELS,
  PERMISSION_LEVELS,
  PERMISSION_LEVEL_LABELS,
  formatDate,
  type AdminAccount,
  type AdminPermissions,
  type AdminRole,
  type PermissionLevel,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';

const KEY = ['admin', 'admin-roles'];
const USERS_KEY = ['admin', 'users'];

const EMPTY_PERMISSIONS: AdminPermissions = Object.fromEntries(
  ADMIN_AREAS.map((a) => [a, 'kein' as PermissionLevel]),
) as AdminPermissions;

function useAdminRoles() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ admin_roles: AdminRole[] }>('/api/admin/admin-roles'),
    select: (d) => d.admin_roles,
  });
}

function useAdminAccounts() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => api.get<{ users: AdminAccount[] }>('/api/admin/users'),
    select: (d) => d.users.filter((u) => u.role === 'admin'),
  });
}

const LEVEL_TONE: Record<PermissionLevel, 'neutral' | 'yellow' | 'green'> = {
  kein: 'neutral',
  lesen: 'yellow',
  bearbeiten: 'green',
};

export function AdminUsersPage() {
  const [tab, setTab] = useState('konten');

  return (
    <>
      <PageHeader
        title="Benutzer & Rechte"
        subtitle="Wer in der HR-Administration welche Bereiche sehen und bearbeiten darf."
      />
      <Tabs
        tabs={[
          { key: 'konten', label: 'Konten' },
          { key: 'rollen', label: 'Rollen & Rechte' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'konten' ? <AccountsTab /> : <RolesTab />}
    </>
  );
}

// ---------------------------------------------------------------------- Konten
function AccountsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: accounts, isLoading } = useAdminAccounts();
  const { data: roles } = useAdminRoles();

  const assign = useMutation({
    mutationFn: ({ id, admin_role_id }: { id: number; admin_role_id: number | null }) =>
      api.patch(`/api/admin/users/${id}`, { admin_role_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('Rolle zugewiesen');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Zuweisung fehlgeschlagen'),
  });

  if (isLoading) return <Spinner center />;

  return (
    <Card flush>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Ohne zugewiesene Rolle hat ein Konto <strong>Vollzugriff</strong>. Das ist Absicht, damit
          sich eine frische Installation und neu angelegte Konten nicht selbst aussperren — die
          Einschränkung ist die bewusste Entscheidung.
        </p>
      </div>
      <div className="hm-table-wrap">
        <table className="hm-table">
          <thead>
            <tr>
              <th>Konto</th>
              <th>E-Mail</th>
              <th>Personalprofil</th>
              <th>Rolle</th>
            </tr>
          </thead>
          <tbody>
            {(accounts ?? []).map((a) => {
              const self = a.id === user?.id;
              return (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>
                    {a.name}
                    {self && (
                      <span style={{ marginLeft: 8 }}>
                        <Badge tone="blue">Sie</Badge>
                      </span>
                    )}
                  </td>
                  <td>{a.email}</td>
                  <td>
                    {a.employee_id ? (
                      <Badge tone="green">verknüpft</Badge>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <select
                      className="hm-select"
                      style={{ width: 210 }}
                      value={a.admin_role_id ?? ''}
                      disabled={self || assign.isPending}
                      title={
                        self
                          ? 'Die eigene Rolle kann nur eine andere Person mit Benutzerverwaltung ändern.'
                          : undefined
                      }
                      onChange={(e) =>
                        assign.mutate({
                          id: a.id,
                          admin_role_id: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">Vollzugriff (keine Rolle)</option>
                      {(roles ?? []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '10px 14px',
          borderTop: '1px solid var(--border)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <ShieldAlert size={14} style={{ flex: 'none', marginTop: 1 }} />
        <span>
          Die eigene Rolle lässt sich hier nicht ändern — sonst wäre jede Einschränkung mit einem
          Klick aufgehoben. Ebenso bleibt immer mindestens ein Konto mit Benutzerverwaltung übrig.
        </span>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- Rollen & Rechte
function RolesTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: roles, isLoading } = useAdminRoles();
  const [editing, setEditing] = useState<AdminRole | 'neu' | null>(null);
  const [deleting, setDeleting] = useState<AdminRole | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/admin-roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('Rolle gelöscht');
      setDeleting(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Löschen fehlgeschlagen'),
  });

  if (isLoading) return <Spinner center />;

  return (
    <>
      <Card
        title="Rollen"
        actions={
          <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setEditing('neu')}>
            <Plus size={15} /> Rolle anlegen
          </button>
        }
        flush
      >
        {(roles ?? []).length === 0 ? (
          <EmptyState icon={<KeyRound size={36} />} title="Noch keine Rollen" hint="Legen Sie die erste an." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Rolle</th>
                  <th>Rechte</th>
                  <th>Konten</th>
                  <th>Angelegt</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {roles!.map((r) => {
                  const own = user?.admin_role_id === r.id;
                  const granted = ADMIN_AREAS.filter((a) => r.permissions[a] !== 'kein');
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {r.name}
                          {own && (
                            <span style={{ marginLeft: 8 }}>
                              <Badge tone="blue">Ihre Rolle</Badge>
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {r.description}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {granted.length === 0 ? (
                            <span style={{ color: 'var(--text-muted)' }}>Kein Bereich</span>
                          ) : (
                            granted.map((a) => (
                              <Badge key={a} tone={LEVEL_TONE[r.permissions[a]]}>
                                {ADMIN_AREA_LABELS[a]}
                                {r.permissions[a] === 'lesen' ? ' (lesen)' : ''}
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td>{r.member_count ?? 0}</td>
                      <td>{formatDate(r.created_at.slice(0, 10))}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <button
                            className="hm-btn hm-btn--quiet hm-btn--sm"
                            onClick={() => setEditing(r)}
                          >
                            <Pencil size={14} /> Bearbeiten
                          </button>
                          <button
                            className="hm-btn hm-btn--quiet hm-btn--sm"
                            onClick={() => setDeleting(r)}
                            disabled={own}
                            title={own ? 'Die eigene Rolle kann nicht gelöscht werden.' : undefined}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <RoleDialog
          role={editing === 'neu' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: KEY });
            qc.invalidateQueries({ queryKey: USERS_KEY });
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Rolle löschen"
        message={
          <>
            <p>
              Soll die Rolle <strong>{deleting?.name}</strong> gelöscht werden?
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Möglich ist das nur, solange ihr kein Konto zugewiesen ist — Konten ohne Rolle hätten
              sonst schlagartig Vollzugriff.
            </p>
          </>
        }
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

// --------------------------------------------------------------------- Dialog
function RoleDialog({
  role,
  onClose,
  onSaved,
}: {
  role: AdminRole | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const isOwnRole = role !== null && user?.admin_role_id === role.id;

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<AdminPermissions>(
    role?.permissions ?? { ...EMPTY_PERMISSIONS },
  );

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || null, permissions };
      return role
        ? api.patch(`/api/admin/admin-roles/${role.id}`, body)
        : api.post('/api/admin/admin-roles', body);
    },
    onSuccess: () => {
      toast.success(role ? 'Rolle gespeichert' : 'Rolle angelegt');
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Speichern fehlgeschlagen'),
  });

  const setLevel = (area: (typeof ADMIN_AREAS)[number], level: PermissionLevel) =>
    setPermissions((p) => ({ ...p, [area]: level }));

  const grantedCount = useMemo(
    () => ADMIN_AREAS.filter((a) => permissions[a] !== 'kein').length,
    [permissions],
  );

  return (
    <Modal
      title={role ? `Rolle „${role.name}“ bearbeiten` : 'Neue Rolle'}
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
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required>
          <input className="hm-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Beschreibung">
          <input
            className="hm-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Wofür ist diese Rolle gedacht?"
          />
        </Field>
      </div>

      {isOwnRole && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            margin: '14px 0 4px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-tint-1)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <ShieldAlert size={16} style={{ flex: 'none', marginTop: 2 }} />
          <span>
            Das ist <strong>Ihre eigene Rolle</strong>. Sie können Rechte hier nur zurücknehmen,
            nicht erweitern, und die Benutzerverwaltung muss auf „Bearbeiten“ bleiben — sonst
            könnten Sie die Änderung nicht rückgängig machen.
          </span>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>Rechte je Bereich</strong>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {grantedCount} von {ADMIN_AREAS.length} Bereichen freigegeben
          </span>
        </div>
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Bereich</th>
                <th style={{ width: 330 }}>Zugriff</th>
              </tr>
            </thead>
            <tbody>
              {ADMIN_AREAS.map((area) => (
                <tr key={area}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{ADMIN_AREA_LABELS[area]}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      {ADMIN_AREA_HINTS[area]}
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {PERMISSION_LEVELS.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`hm-btn hm-btn--sm ${
                            permissions[area] === level ? 'hm-btn--primary' : 'hm-btn--secondary'
                          }`}
                          onClick={() => setLevel(area, level)}
                        >
                          {PERMISSION_LEVEL_LABELS[level]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 10, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <UserCog size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          „Nur lesen“ erlaubt das Ansehen, aber kein Anlegen, Ändern oder Löschen. Das Dashboard
          bleibt immer erreichbar und zeigt nur Kacheln freigegebener Bereiche.
        </p>
      </div>
    </Modal>
  );
}
