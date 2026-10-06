import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Pencil, Plus, ShieldAlert, Trash2, UserCog } from 'lucide-react';
import {
  ADMIN_AREAS,
  ADMIN_AREA_HINTS,
  ADMIN_AREA_LABELS,
  PERMISSION_LEVELS,
  PERMISSION_LEVEL_LABELS,
  formatDate,
  type AdminAccount,
  type AdminAccountWithPassword,
  type AdminPermissions,
  type AdminRole,
  type PermissionLevel,
} from '@ohrganize/shared';
import { moduleEnabled } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { EmployeeSelect, employeeName, useEmployees } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { Tooltip } from '../../components/Tooltip';
import { Select } from '../../components/Select';
import { HintBox } from '../../components/HintBox';
import { t } from '../setup/copy';

const KEY = ['admin', 'admin-roles'];
const USERS_KEY = ['admin', 'users'];

const EMPTY_PERMISSIONS: AdminPermissions = Object.fromEntries(
  ADMIN_AREAS.map((a) => [a, 'kein' as PermissionLevel]),
) as AdminPermissions;

export function useAdminRoles() {
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
    // Bewusst OHNE Filter auf role === 'admin': Portal-Konten werden auf
    // derselben Seite angelegt und zurückgesetzt (docs/inbetriebnahme.md
    // Punkt 3 und 8). Ein Konto, das man anlegt, muss danach auch in der
    // Liste auftauchen.
    select: (d) => d.users,
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
  const leaderGuardHint = useLeaderGuardHint();
  const { data: accounts, isLoading } = useAdminAccounts();
  const { data: roles } = useAdminRoles();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminAccount | null>(null);
  const [deleting, setDeleting] = useState<AdminAccount | null>(null);
  const [linking, setLinking] = useState<AdminAccount | null>(null);
  // Alle Profile (auch ausgeschiedene), um den verknüpften Namen anzuzeigen.
  const { data: employees } = useEmployees(true);
  const employeeById = useMemo(
    () => new Map((employees ?? []).map((e) => [e.id, e])),
    [employees],
  );
  /** Einmalig anzuzeigendes Erstpasswort (Anlage oder Zurücksetzen). */
  const [issued, setIssued] = useState<{ account: AdminAccount; password: string } | null>(null);

  const assign = useMutation({
    mutationFn: ({ id, admin_role_id }: { id: number; admin_role_id: number | null }) =>
      api.patch(`/api/admin/users/${id}`, { admin_role_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('Rolle zugewiesen');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Zuweisung fehlgeschlagen'),
  });

  const reset = useMutation({
    mutationFn: (id: number) =>
      api.post<AdminAccountWithPassword>(`/api/admin/users/${id}/reset-password`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      setResetting(null);
      setIssued({ account: res.user, password: res.initial_password });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Zurücksetzen fehlgeschlagen'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      setDeleting(null);
      toast.success('Konto gelöscht');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Löschen fehlgeschlagen'),
  });

  if (isLoading) return <Spinner center />;

  return (
    <>
      <Card flush>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
            padding: '12px 14px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', flex: 1 }}>
            Ohne zugewiesene Rolle hat ein Konto <strong>Vollzugriff</strong>. Dies ist dazu da, damit
            sich eine frische Installation und neu angelegte Konten nicht selbst aussperren.
          </p>
          <button
            className="hm-btn hm-btn--primary"
            style={{ flex: 'none' }}
            onClick={() => setCreating(true)}
          >
            <Plus size={15} /> Konto anlegen
          </button>
        </div>
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Konto</th>
                <th>E-Mail</th>
                <th>Zugang</th>
                <th>Personalprofil</th>
                <th>Rolle</th>
                <th style={{ width: 96 }}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {(accounts ?? []).map((a) => {
                const self = a.id === user?.id;
                const portal = a.role === 'mitarbeiter';
                return (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>
                      {a.name}
                      {self && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge tone="blue">Sie</Badge>
                        </span>
                      )}
                      {a.must_change_password === 1 && (
                        <Tooltip
                          content={
                            <>
                              <div className="hm-tooltip__title">Erstpasswort noch nicht geändert</div>
                              <div className="hm-tooltip__line">Bis zum Wechsel nur die Passwortseite erreichbar</div>
                            </>
                          }
                        >
                          <span style={{ marginLeft: 8 }}>
                            <Badge tone="yellow">Erstpasswort</Badge>
                          </span>
                        </Tooltip>
                      )}
                    </td>
                    <td>{a.email}</td>
                    <td>
                      <Badge tone={portal ? 'neutral' : 'navy'}>
                        {portal ? 'Portal' : 'HR-Administration'}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {a.employee_id ? (
                          <Badge tone="green">
                            {employeeById.get(a.employee_id)
                              ? employeeName(employeeById.get(a.employee_id)!)
                              : 'verknüpft'}
                          </Badge>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                        {/* Nachträglich verknüpfen: Erst mit Profil sieht ein
                            Konto die Führungsfunktion (Führung → Einrichtung). */}
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          aria-label={`Personalprofil von ${a.name} verknüpfen`}
                          disabled={self}
                          onClick={() => setLinking(a)}
                        >
                          <Link2 size={14} />
                        </button>
                      </div>
                    </td>
                    <td>
                      {portal ? (
                        // Portal-Konten kennen keine Admin-Rolle; sie erreichen
                        // ausschließlich den Self-Service (Hook in server.ts).
                        <span style={{ color: 'var(--text-muted)' }}>Self-Service</span>
                      ) : (
                        <Tooltip content={self ? <><span className="hm-tooltip__title">Eigene Rolle</span><span className="hm-tooltip__line">Nur eine andere Person mit Benutzerverwaltung ändert sie</span></> : null}>
                          <span style={{ display: 'inline-block' }}>
                          <Select
                            className="hm-select"
                            style={{ width: 210 }}
                            value={a.admin_role_id ?? ''}
                            disabled={self || assign.isPending}
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
                          </Select>
                          </span>
                        </Tooltip>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {/* Tooltip statt title (CLAUDE.md): Host ist ein span, weil ein
                            deaktivierter Button keine Mausereignisse liefert. */}
                        <Tooltip
                          content={
                            <div className="hm-tooltip__title">
                              {self ? 'Eigenes Passwort · unter System → Konto ändern' : 'Passwort zurücksetzen'}
                            </div>
                          }
                        >
                          <span>
                            <button
                              className="hm-btn hm-btn--quiet hm-btn--sm"
                              aria-label={self ? 'Das eigene Passwort ändern Sie unter System → Konto.' : 'Passwort zurücksetzen'}
                              disabled={self}
                              onClick={() => setResetting(a)}
                            >
                              <KeyRound size={14} />
                            </button>
                          </span>
                        </Tooltip>
                        <Tooltip
                          content={
                            <div className="hm-tooltip__title">
                              {self ? 'Eigenes Konto · nicht löschbar' : 'Konto löschen'}
                            </div>
                          }
                        >
                          <span>
                            <button
                              className="hm-btn hm-btn--quiet hm-btn--sm"
                              aria-label={self ? 'Das eigene Konto kann nicht gelöscht werden.' : 'Konto löschen'}
                              disabled={self}
                              onClick={() => setDeleting(a)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </Tooltip>
                      </div>
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
            Die eigene Rolle lässt sich hier nicht ändern und das eigene Konto nicht löschen. Ebenso
            bleibt immer mindestens ein Konto mit Benutzerverwaltung übrig.
          </span>
        </div>
      </Card>

      {creating && (
        <AccountDialog
          roles={roles ?? []}
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setIssued({ account: res.user, password: res.initial_password });
          }}
        />
      )}

      <ConfirmDialog
        open={!!resetting}
        title="Passwort zurücksetzen"
        confirmLabel="Zurücksetzen"
        message={
          <>
            Für <strong>{resetting?.name}</strong> ({resetting?.email}) wird ein neues Erstpasswort
            erzeugt. Alle offenen Sitzungen dieses Kontos werden sofort beendet, und der Zugang ist
            bis zum Setzen eines eigenen Passworts gesperrt. Das neue Passwort wird{' '}
            <strong>nur einmal</strong> angezeigt.
            {leaderGuardHint && <> {leaderGuardHint}</>}
          </>
        }
        onConfirm={() => resetting && reset.mutate(resetting.id)}
        onClose={() => setResetting(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        title="Konto löschen"
        message={
          <>
            Das Konto <strong>{deleting?.name}</strong> ({deleting?.email}) wird dauerhaft gelöscht.
            Bereits erfasste Daten und Anträge bleiben erhalten; im Änderungsprotokoll verliert der
            Eintrag nur seine Zuordnung. Das Personalprofil selbst bleibt unberührt.
          </>
        }
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />

      {issued && (
        <InitialPasswordDialog
          account={issued.account}
          password={issued.password}
          onClose={() => setIssued(null)}
        />
      )}

      {linking && <LinkProfileDialog account={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

/**
 * Personalprofil eines bestehenden Kontos verknüpfen oder lösen.
 *
 * Nötig für die Führungsfunktion: „Mein Team“ sieht ein Konto nur, wenn sein
 * Profil unter Führung → Einrichtung freigeschaltet ist. Ohne diesen Dialog
 * müsste ein Konto ohne Profil gelöscht und neu angelegt werden. Portal-Konten
 * brauchen zwingend ein Profil — das Lösen ist dort gesperrt.
 */
function LinkProfileDialog({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const portal = account.role === 'mitarbeiter';
  const leaderGuardHint = useLeaderGuardHint();
  const [employeeId, setEmployeeId] = useState<number | null>(account.employee_id);

  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/users/${account.id}`, { employee_id: employeeId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(employeeId ? 'Personalprofil verknüpft' : 'Verknüpfung gelöst');
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Verknüpfen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Personalprofil verknüpfen"
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={save.isPending || (portal && !employeeId) || employeeId === account.employee_id}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          Konto <strong>{account.name}</strong> ({account.email}).{' '}
          {portal
            ? 'Das Portal zeigt ausschließlich die Daten des verknüpften Profils.'
            : 'Mit verknüpftem Profil kann das Konto zusätzlich im Portal anmelden und (nach Freischaltung unter Führung → Einrichtung sein Team unter „Mein Team“) bewerten.'}
          {!portal && leaderGuardHint && <> {leaderGuardHint}</>}
        </p>
        <Field label="Personalprofil" required={portal}>
          <EmployeeSelect
            value={employeeId}
            onChange={setEmployeeId}
            allowEmpty={!portal}
            emptyLabel={portal ? '— auswählen —' : '— kein Profil —'}
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Anlegen eines Kontos.
 *
 * Bewusst OHNE Passwortfeld: Der Server erzeugt das Erstpasswort zufällig
 * (POST /api/admin/users) und erzwingt den Wechsel beim ersten Login. Damit
 * kann hier kein schwaches oder aus einer Anleitung bekanntes Passwort
 * gesetzt werden — genau das war der Grund, warum `npm run seed` mit seinen
 * Demo-Passwörtern der De-facto-Weg zum Anlegen von Konten war.
 */
export function AccountDialog({
  roles,
  onClose,
  onCreated,
  fixedRole,
  initialName,
  initialEmployeeId,
  profileTakenHint,
}: {
  roles: AdminRole[];
  onClose: () => void;
  onCreated: (res: AdminAccountWithPassword) => void;
  /** Einrichtungs-Assistent: Zugangsart steht fest, das Feld entfällt. */
  fixedRole?: 'admin' | 'mitarbeiter';
  initialName?: string;
  initialEmployeeId?: number | null;
  /** Tooltip an Profilen, die schon ein Konto haben (ausgegraut). */
  profileTakenHint?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user: authUser } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState(initialName ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  // Pro Personalprofil gibt es genau ein Konto, und es dient zugleich als
  // Portal-Zugang. Wer schon eins hat, ist nicht noch einmal wählbar.
  const { data: accounts } = useAdminAccounts();
  const { data: people } = useEmployees();
  const takenProfiles = useMemo(
    () => new Set((accounts ?? []).flatMap((a) => (a.employee_id != null ? [a.employee_id] : []))),
    [accounts],
  );
  const [role, setRole] = useState<'admin' | 'mitarbeiter'>(fixedRole ?? 'admin');
  const [employeeId, setEmployeeId] = useState<number | null>(initialEmployeeId ?? null);
  const [adminRoleId, setAdminRoleId] = useState<number | null>(null);

  // Der Name folgt dem gewählten Profil, solange niemand ihn selbst getippt hat:
  // Wer das Profil wechselt, behält sonst den Namen der vorigen Person.
  useEffect(() => {
    if (nameTouched) return;
    const person = people?.find((p) => p.id === employeeId);
    if (person) setName(employeeName(person));
  }, [employeeId, people, nameTouched]);

  const create = useMutation({
    mutationFn: () =>
      api.post<AdminAccountWithPassword>('/api/admin/users', {
        email: email.trim(),
        name: name.trim(),
        role,
        // Portal-Konten brauchen zwingend ein Profil, Admin-Konten dürfen eins
        // haben (dann sind sie zusätzlich portalfähig).
        employee_id: employeeId,
        admin_role_id: role === 'admin' ? adminRoleId : null,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      onCreated(res);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen'),
  });

  const portal = role === 'mitarbeiter';
  const valid = email.trim().includes('@') && name.trim().length > 0 && (!portal || !!employeeId);
  // Einrichtungs-Assistent: Admin-Konten entstehen dort mit Vollzugriff (keine
  // Rolle), die Auswahl entfällt. Hat das ANLEGENDE Konto selbst nur eine Rolle,
  // bleibt sie sichtbar: Das Backend lässt es nur Rechte vergeben, die es hat
  // (core/accountRights.ts), Vollzugriff wäre dort ein 403.
  const showRoleSelect = !portal && !(fixedRole === 'admin' && authUser?.admin_role_id == null);

  return (
    <Modal
      title="Konto anlegen"
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Wird angelegt …' : 'Anlegen'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required>
          <input
            className="hm-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder="Anzeigename"
            autoFocus
          />
        </Field>
        <Field label="E-Mail-Adresse" required hint="Dient als Anmeldename.">
          <input
            className="hm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vorname.nachname@firma.de"
          />
        </Field>
        <HintBox>
          <p>{t('account.hint.name')}</p>
        </HintBox>
        {!fixedRole && (
          <Field label="Zugang" required>
            <Select
              className="hm-select"
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'mitarbeiter')}
            >
              <option value="admin">HR-Administration (Desktop-App)</option>
              <option value="mitarbeiter">Mitarbeitenden-Portal (Self-Service)</option>
            </Select>
          </Field>
        )}
        <Field
          label="Personalprofil"
          required={portal}
          hint={
            portal
              ? 'Pflicht: Das Portal zeigt ausschließlich die Daten dieses Profils.'
              : 'Optional.'
          }
        >
          <EmployeeSelect
            value={employeeId}
            onChange={setEmployeeId}
            allowEmpty={!portal}
            emptyLabel="— kein Profil —"
            disabledIds={takenProfiles}
            disabledHint={
              profileTakenHint ??
              'Für dieses Profil gibt es bereits ein Konto. Es dient auch als Portal-Zugang, die Zugangsdaten sind dieselben.'
            }
          />
        </Field>
        {!portal && (
          <HintBox>
            <p>{t('account.hint.profile.1')}</p>
            <p>{t('account.hint.profile.2')}</p>
          </HintBox>
        )}
        {showRoleSelect && (
          <Field
            label="Admin-Rolle"
            span2
            hint="Ohne Rolle hat das Konto Vollzugriff. Nur vergeben, was Sie selbst besitzen."
          >
            <Select
              className="hm-select"
              value={adminRoleId ?? ''}
              onChange={(e) => setAdminRoleId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Vollzugriff (keine Rolle)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <p
        style={{
          margin: '14px 0 0',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        Ein Passwort geben Sie hier nicht ein. oHRganize erzeugt ein Erstpasswort, zeigt es Ihnen
        einmalig an und verlangt beim ersten Login den Wechsel.
      </p>
    </Modal>
  );
}

/**
 * Rang (backend core/accountRights.ts): Ein Konto, dessen Profil als
 * Führungskraft freigeschaltet ist, bewertet und liest Gesprächsprotokolle.
 * Zurücksetzen, verknüpfen, lösen, Rolle ändern oder löschen darf es darum
 * nur, wer „Führung & Bewertung“ bearbeiten und (in Varianten mit
 * Protokollen) „Kommunikation“ lesen darf. Die Liste zeigt nicht, welche
 * Konten das sind; scheitert ein Eingriff daran, nennt die Meldung die
 * fehlenden Bereiche wie bei jedem ranghöheren Konto. Das ist hingenommen:
 * Wer Führungskraft ist, steht ohnehin im Organigramm.
 */
function useLeaderGuardHint(): string | null {
  const { can } = useAuth();
  if (!moduleEnabled(VARIANT, 'leadership')) return null;
  const protocols = moduleEnabled(VARIANT, 'communication');
  if (can('fuehrung', 'bearbeiten') && (!protocols || can('kommunikation', 'lesen'))) return null;
  return protocols
    ? 'Gehört das Konto einer freigeschalteten Führungskraft, braucht dieser Schritt Bearbeitungsrecht in „Führung & Bewertung“ und Leserecht in „Kommunikation“: Die Führungskraft bewertet und liest Gesprächsprotokolle.'
    : 'Gehört das Konto einer freigeschalteten Führungskraft, braucht dieser Schritt Bearbeitungsrecht in „Führung & Bewertung“.';
}

/**
 * Einmalige Anzeige des Erstpassworts.
 *
 * Der Server speichert nur den Hash — das Klartextpasswort existiert nach
 * diesem Dialog nirgends mehr. Wird es hier nicht notiert, hilft nur ein
 * erneutes Zurücksetzen.
 */
export function InitialPasswordDialog({
  account,
  password,
  onClose,
}: {
  account: AdminAccount;
  password: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      toast.success('Passwort in die Zwischenablage kopiert');
    } catch {
      // Zwischenablage kann vom Browserkern verweigert werden — das Passwort
      // steht sichtbar im Dialog, abschreiben geht immer.
      toast.error('Kopieren nicht möglich, bitte abschreiben');
    }
  }

  return (
    <Modal
      title="Erstpasswort"
      open
      onClose={onClose}
      footer={
        <button className="hm-btn hm-btn--primary" onClick={onClose}>
          Notiert
        </button>
      }
    >
      <p style={{ marginTop: 0, fontSize: 'var(--text-sm)' }}>
        Zugangsdaten für <strong>{account.name}</strong>:
      </p>
      <div
        style={{
          display: 'grid',
          gap: 10,
          padding: '12px 14px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-tint-1)',
        }}
      >
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Anmeldename</div>
          <div style={{ fontWeight: 600 }}>{account.email}</div>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Erstpasswort</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <code
              style={{
                fontSize: 'var(--text-md)',
                fontWeight: 700,
                letterSpacing: '0.04em',
                userSelect: 'all',
              }}
            >
              {password}
            </code>
            <button className="hm-btn hm-btn--secondary" onClick={copy}>
              {copied ? 'Kopiert' : 'Kopieren'}
            </button>
          </div>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginTop: 14,
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <ShieldAlert size={16} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          Dieses Passwort wird <strong>nur jetzt</strong> angezeigt. oHRganize speichert es nicht im
          Klartext. Geben Sie es der Person über einen anderen Kanal als die E-Mail-Adresse weiter.
          Beim ersten Login muss sie ein eigenes Passwort vergeben. Ist es verloren, setzen Sie es
          einfach erneut zurück.
        </span>
      </div>
    </Modal>
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
                          <Tooltip content={own ? <span className="hm-tooltip__title">{'Die eigene Rolle kann nicht gelöscht werden.'}</span> : null}>
                            <button
                              className="hm-btn hm-btn--quiet hm-btn--sm"
                              onClick={() => setDeleting(r)}
                              disabled={own}
                            >
                              <Trash2 size={14} />
                            </button>
                          </Tooltip>
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
            nicht erweitern, und die Benutzerverwaltung muss auf „Bearbeiten“ bleiben. Ansonsten
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
