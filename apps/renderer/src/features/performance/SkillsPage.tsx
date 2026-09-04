import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Grid3x3 } from 'lucide-react';
import { api, ApiRequestError } from '../../api/client';
import { PageHeader, Card, EmptyState, Spinner, Badge, Field, Tabs } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import type { Skill, SkillGapEntry } from '@ohrganize/shared';
import { SKILL_LEVEL_COLORS } from './common';

interface MatrixData {
  employees: { id: number; first_name: string; last_name: string; job_title: string | null; department_id: number | null; team_id: number | null }[];
  skills: Skill[];
  levels: { employee_id: number; skill_id: number; level: number }[];
  departments: { id: number; name: string }[];
  teams: { id: number; name: string; department_id: number | null }[];
}

interface ProfileRow {
  id: number;
  role_name: string;
  skill_id: number;
  required_level: number;
  skill_name: string;
}

export function SkillsPage() {
  const [tab, setTab] = useState('catalog');
  return (
    <>
      <PageHeader title="Skills & Kompetenzen" subtitle="Katalog, Skill-Matrix, Lückenanalyse und Soll-Profile je Rolle" />
      <Tabs
        tabs={[
          { key: 'catalog', label: 'Katalog' },
          { key: 'matrix', label: 'Matrix' },
          { key: 'gap', label: 'Lückenanalyse' },
          { key: 'profiles', label: 'Soll-Profile' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'matrix' && <MatrixTab />}
        {tab === 'gap' && <GapTab />}
        {tab === 'profiles' && <ProfilesTab />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

function CatalogTab() {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [form, setForm] = useState({ name: '', category: '' });
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'skills'],
    queryFn: () => api.get<{ skills: Skill[] }>('/api/performance/skills'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['performance', 'skills'] });
    qc.invalidateQueries({ queryKey: ['performance', 'skills-matrix'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      editing
        ? api.put(`/api/performance/skills/${editing.id}`, { name: form.name.trim(), category: form.category || null })
        : api.post('/api/performance/skills', { name: form.name.trim(), category: form.category || null }),
    onSuccess: () => {
      toast.success(editing ? 'Skill aktualisiert' : 'Skill angelegt');
      setEditorOpen(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Speichern'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/skills/${id}`),
    onSuccess: () => {
      toast.success('Skill gelöscht');
      invalidate();
    },
    onError: () => toast.error('Fehler beim Löschen'),
  });

  if (isLoading) return <Spinner center />;
  const skills = data?.skills ?? [];

  return (
    <>
      <Card
        title="Skill-Katalog"
        actions={
          <button
            className="hm-btn hm-btn--primary hm-btn--sm"
            onClick={() => {
              setEditing(null);
              setForm({ name: '', category: '' });
              setEditorOpen(true);
            }}
          >
            <Plus size={15} /> Skill anlegen
          </button>
        }
        flush
      >
        {skills.length === 0 ? (
          <EmptyState icon={<Grid3x3 size={40} />} title="Noch keine Skills" hint="Legen Sie den Skill-Katalog Ihres Unternehmens an." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kategorie</th>
                  <th style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {skills.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td>{s.category ?? '—'}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--secondary hm-btn--sm"
                          onClick={() => {
                            setEditing(s);
                            setForm({ name: s.name, category: s.category ?? '' });
                            setEditorOpen(true);
                          }}
                        >
                          Bearbeiten
                        </button>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => setDeleting(s)} aria-label="Löschen">
                          <Trash2 size={16} />
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

      <Modal
        title={editing ? 'Skill bearbeiten' : 'Skill anlegen'}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setEditorOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={saveMutation.isPending}
              onClick={() => {
                if (!form.name.trim()) {
                  toast.error('Bitte einen Namen angeben');
                  return;
                }
                saveMutation.mutate();
              }}
            >
              Speichern
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Name" required>
            <input className="hm-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="z. B. TypeScript" />
          </Field>
          <Field label="Kategorie" hint="z. B. Technik, Methodik, Sprache">
            <input className="hm-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Skill löschen"
        message={`„${deleting?.name}“ wird gelöscht — inklusive aller Zuordnungen zu Mitarbeitenden und Soll-Profilen.`}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Matrix (Heatmap)
// ---------------------------------------------------------------------------

function MatrixTab() {
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [cell, setCell] = useState<{ employeeId: number; skillId: number; employeeName: string; skillName: string; level: number | null } | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const params = new URLSearchParams();
  if (departmentId) params.set('department_id', String(departmentId));
  if (teamId) params.set('team_id', String(teamId));
  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'skills-matrix', departmentId, teamId],
    queryFn: () => api.get<MatrixData>(`/api/performance/skills/matrix?${params.toString()}`),
  });

  const levelMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data?.levels ?? []) m.set(`${l.employee_id}:${l.skill_id}`, l.level);
    return m;
  }, [data]);

  const setLevel = useMutation({
    mutationFn: ({ employeeId, skillId, level }: { employeeId: number; skillId: number; level: number }) =>
      api.put('/api/performance/employee-skills', { employee_id: employeeId, skill_id: skillId, level }),
    onSuccess: () => {
      toast.success('Level gesetzt');
      qc.invalidateQueries({ queryKey: ['performance', 'skills-matrix'] });
      setCell(null);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Setzen'),
  });

  const removeLevel = useMutation({
    mutationFn: ({ employeeId, skillId }: { employeeId: number; skillId: number }) =>
      api.delete(`/api/performance/employee-skills/${employeeId}/${skillId}`),
    onSuccess: () => {
      toast.success('Zuordnung entfernt');
      qc.invalidateQueries({ queryKey: ['performance', 'skills-matrix'] });
      setCell(null);
    },
    onError: () => toast.error('Fehler beim Entfernen'),
  });

  if (isLoading) return <Spinner center />;
  const d = data!;

  return (
    <>
      <Card>
        <div className="row row--wrap">
          <div style={{ minWidth: 220 }}>
            <Field label="Abteilung">
              <select
                className="hm-select"
                value={departmentId ?? ''}
                onChange={(e) => {
                  setDepartmentId(e.target.value === '' ? null : Number(e.target.value));
                  setTeamId(null);
                }}
              >
                <option value="">Alle Abteilungen</option>
                {d.departments.map((dep) => (
                  <option key={dep.id} value={dep.id}>
                    {dep.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ minWidth: 220 }}>
            <Field label="Team">
              <select className="hm-select" value={teamId ?? ''} onChange={(e) => setTeamId(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Alle Teams</option>
                {d.teams
                  .filter((t) => departmentId === null || t.department_id === departmentId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <div className="row" style={{ marginLeft: 'auto', gap: 6, alignSelf: 'flex-end' }}>
            {[1, 2, 3, 4, 5].map((lvl) => (
              <span
                key={lvl}
                style={{
                  background: SKILL_LEVEL_COLORS[lvl].bg,
                  color: SKILL_LEVEL_COLORS[lvl].fg,
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                }}
              >
                {lvl}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Skill-Matrix" style={{ marginTop: 16 }} flush>
        {d.employees.length === 0 || d.skills.length === 0 ? (
          <EmptyState
            title={d.skills.length === 0 ? 'Keine Skills im Katalog' : 'Keine Mitarbeitenden im Filter'}
            hint="Zellklick setzt das Level (1–5)."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  {d.skills.map((s) => (
                    <th key={s.id} title={s.category ?? undefined} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.employees.map((e) => (
                  <tr key={e.id}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {e.last_name}, {e.first_name}
                    </td>
                    {d.skills.map((s) => {
                      const level = levelMap.get(`${e.id}:${s.id}`) ?? null;
                      const colors = level ? SKILL_LEVEL_COLORS[level] : null;
                      return (
                        <td
                          key={s.id}
                          onClick={() =>
                            setCell({
                              employeeId: e.id,
                              skillId: s.id,
                              employeeName: `${e.first_name} ${e.last_name}`,
                              skillName: s.name,
                              level,
                            })
                          }
                          style={{
                            textAlign: 'center',
                            cursor: 'pointer',
                            background: colors?.bg,
                            color: colors?.fg,
                            fontWeight: 600,
                          }}
                          title={`${e.first_name} ${e.last_name} · ${s.name}: Level ${level ?? '—'}`}
                        >
                          {level ?? ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        title={cell ? `${cell.skillName} — ${cell.employeeName}` : ''}
        open={cell !== null}
        onClose={() => setCell(null)}
        footer={
          <>
            {cell?.level !== null && (
              <button
                className="hm-btn hm-btn--danger"
                onClick={() => cell && removeLevel.mutate({ employeeId: cell.employeeId, skillId: cell.skillId })}
              >
                Zuordnung entfernen
              </button>
            )}
            <button className="hm-btn hm-btn--secondary" onClick={() => setCell(null)}>
              Abbrechen
            </button>
          </>
        }
      >
        <p style={{ color: 'var(--text-secondary)', marginBottom: 10 }}>Level wählen (1 = Grundkenntnisse, 5 = Expert:in):</p>
        <div className="row" style={{ gap: 8 }}>
          {[1, 2, 3, 4, 5].map((lvl) => (
            <button
              key={lvl}
              className={`hm-btn ${cell?.level === lvl ? 'hm-btn--primary' : 'hm-btn--secondary'}`}
              disabled={setLevel.isPending}
              onClick={() => cell && setLevel.mutate({ employeeId: cell.employeeId, skillId: cell.skillId, level: lvl })}
              style={{ minWidth: 44 }}
            >
              {lvl}
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Lückenanalyse
// ---------------------------------------------------------------------------

function GapTab() {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState('');

  const { data: profilesData } = useQuery({
    queryKey: ['performance', 'role-skill-profiles'],
    queryFn: () => api.get<{ profiles: ProfileRow[] }>('/api/performance/role-skill-profiles'),
  });
  const roles = useMemo(
    () => [...new Set((profilesData?.profiles ?? []).map((p) => p.role_name))].sort(),
    [profilesData],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ['performance', 'skill-gap', employeeId, roleName],
    queryFn: () =>
      api.get<{ role_name: string; gaps: SkillGapEntry[] }>(
        `/api/performance/skills/gap/${employeeId}${roleName ? `?role_name=${encodeURIComponent(roleName)}` : ''}`,
      ),
    enabled: employeeId !== null && roleName !== '',
    retry: false,
  });

  return (
    <>
      <Card>
        <div className="row row--wrap">
          <div style={{ minWidth: 260 }}>
            <Field label="Mitarbeiter:in">
              <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
            </Field>
          </div>
          <div style={{ minWidth: 240 }}>
            <Field label="Soll-Rolle" hint="Rollen mit hinterlegtem Soll-Profil">
              <select className="hm-select" value={roleName} onChange={(e) => setRoleName(e.target.value)}>
                <option value="">— auswählen —</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Soll vs. Ist" style={{ marginTop: 16 }}>
        {employeeId === null || roleName === '' ? (
          <EmptyState title="Bitte Mitarbeiter:in und Soll-Rolle wählen" />
        ) : isLoading ? (
          <Spinner center />
        ) : error ? (
          <EmptyState title="Analyse nicht möglich" hint={error instanceof ApiRequestError ? error.message : undefined} />
        ) : (data?.gaps.length ?? 0) === 0 ? (
          <EmptyState title="Für diese Rolle ist kein Soll-Profil hinterlegt" />
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {data!.gaps.map((g) => (
              <div key={g.skill_id}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong>{g.skill_name}</strong>
                  <span style={{ fontSize: 'var(--text-sm)', color: g.gap > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>
                    {g.gap > 0 ? `Lücke: ${g.gap}` : 'Soll erfüllt'}
                  </span>
                </div>
                <GapBars required={g.required_level} current={g.current_level} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function GapBars({ required, current }: { required: number; current: number }) {
  const bar = (value: number, color: string, label: string) => (
    <div className="row" style={{ gap: 8 }}>
      <span style={{ width: 34, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{label}</span>
      <div style={{ flex: 1, background: 'var(--gray-100)', borderRadius: 999, height: 10, overflow: 'hidden' }}>
        <div style={{ width: `${(value / 5) * 100}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
      <span style={{ width: 16, fontSize: 'var(--text-sm)', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {bar(required, 'var(--gray-400)', 'Soll')}
      {bar(current, current < required ? 'var(--danger)' : 'var(--success)', 'Ist')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Soll-Profile
// ---------------------------------------------------------------------------

function ProfilesTab() {
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ role_name: '', skill_id: 0, required_level: 3 });
  const toast = useToast();
  const qc = useQueryClient();

  const { data: skillsData } = useQuery({
    queryKey: ['performance', 'skills'],
    queryFn: () => api.get<{ skills: Skill[] }>('/api/performance/skills'),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'role-skill-profiles'],
    queryFn: () => api.get<{ profiles: ProfileRow[] }>('/api/performance/role-skill-profiles'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['performance', 'role-skill-profiles'] });
    qc.invalidateQueries({ queryKey: ['performance', 'skill-gap'] });
  };

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/performance/role-skill-profiles', form),
    onSuccess: () => {
      toast.success('Soll-Profil-Eintrag angelegt');
      setCreateOpen(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Anlegen'),
  });

  const levelMutation = useMutation({
    mutationFn: ({ id, required_level }: { id: number; required_level: number }) =>
      api.put(`/api/performance/role-skill-profiles/${id}`, { required_level }),
    onSuccess: () => {
      toast.success('Soll-Level aktualisiert');
      invalidate();
    },
    onError: () => toast.error('Fehler beim Aktualisieren'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/role-skill-profiles/${id}`),
    onSuccess: () => {
      toast.success('Eintrag gelöscht');
      invalidate();
    },
    onError: () => toast.error('Fehler beim Löschen'),
  });

  if (isLoading) return <Spinner center />;

  const profiles = data?.profiles ?? [];
  const byRole = new Map<string, ProfileRow[]>();
  for (const p of profiles) byRole.set(p.role_name, [...(byRole.get(p.role_name) ?? []), p]);

  return (
    <>
      <Card
        title="Soll-Profile je Rolle"
        actions={
          <button
            className="hm-btn hm-btn--primary hm-btn--sm"
            onClick={() => {
              setForm({ role_name: '', skill_id: skillsData?.skills[0]?.id ?? 0, required_level: 3 });
              setCreateOpen(true);
            }}
          >
            <Plus size={15} /> Eintrag anlegen
          </button>
        }
      >
        {profiles.length === 0 ? (
          <EmptyState title="Noch keine Soll-Profile" hint="Definieren Sie je Rolle die benötigten Skills und Soll-Levels." />
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            {[...byRole.entries()].map(([role, rows]) => (
              <div key={role}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong>{role}</strong>
                  <Badge tone="navy">{rows.length} Skills</Badge>
                </div>
                <div className="hm-table-wrap">
                  <table className="hm-table">
                    <thead>
                      <tr>
                        <th>Skill</th>
                        <th style={{ width: 180 }}>Soll-Level</th>
                        <th style={{ width: 60 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id}>
                          <td>{p.skill_name}</td>
                          <td>
                            <select
                              className="hm-select"
                              value={p.required_level}
                              onChange={(e) => levelMutation.mutate({ id: p.id, required_level: Number(e.target.value) })}
                            >
                              {[1, 2, 3, 4, 5].map((l) => (
                                <option key={l} value={l}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => deleteMutation.mutate(p.id)} aria-label="Löschen">
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        title="Soll-Profil-Eintrag anlegen"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setCreateOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={createMutation.isPending}
              onClick={() => {
                if (!form.role_name.trim() || !form.skill_id) {
                  toast.error('Bitte Rolle und Skill angeben');
                  return;
                }
                createMutation.mutate();
              }}
            >
              Anlegen
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Rolle" required hint="Muss dem Jobtitel entsprechen, z. B. Entwickler:in">
            <input className="hm-input" value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })} />
          </Field>
          <Field label="Skill" required>
            <select className="hm-select" value={form.skill_id} onChange={(e) => setForm({ ...form, skill_id: Number(e.target.value) })}>
              {(skillsData?.skills ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Soll-Level" required>
            <select className="hm-select" value={form.required_level} onChange={(e) => setForm({ ...form, required_level: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>
    </>
  );
}
