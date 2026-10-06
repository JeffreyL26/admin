import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import type { AbsenceType, AdminAccount, SetupStepKey } from '@ohrganize/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/ui';
import { Select } from '../../components/Select';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, useEmployees } from '../../components/EmployeeSelect';
import { REGIONS, REGION_TERM } from '../../lib/locale';
import { EmployeeCreateModal } from '../employees/EmployeeCreateModal';
import { EMPTY_FILTERS, useDepartments, useEmployeeList } from '../employees/api';
import { useAbsenceTypes } from '../absences/api';
import { AccountDialog, InitialPasswordDialog, useAdminRoles } from '../admin/AdminUsersPage';
import { t } from './copy';
import { StepShell } from './StepShell';
import { setupActions } from './store';
import { SETUP_STATUS_KEY } from './useSetup';
import { useSetupContext } from './SetupProvider';
import type { StepVars } from './stepMeta';

/**
 * Die sieben Schritte. Jeder ruft die bestehenden Endpunkte der Fachseiten,
 * erfindet keine eigene Schreibroute und invalidiert danach die Abfragen, die
 * diese Seiten selbst benutzen. Gespeichert ist damit identisch mit "ueber die
 * Seite angelegt", und der Fortschritt (GET /api/setup/status) folgt den Daten.
 */

function useFinish(key: SetupStepKey) {
  const qc = useQueryClient();
  return (vars: StepVars) => {
    qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    setupActions.celebrate(key, vars);
  };
}

function useSaveError() {
  const toast = useToast();
  return (e: unknown) =>
    toast.error(t('error.save', { reason: e instanceof Error ? e.message : String(e) }));
}

const names = (xs: string[]) => xs.join(', ');

/* ------------------------------------------------------------------ 1 Firma */

interface CompanySettings {
  companyName: string;
  defaultBundesland: string;
}

export function FirmaStep() {
  const { status } = useSetupContext();
  const { can } = useAuth();
  const qc = useQueryClient();
  const finish = useFinish('firma');
  const onError = useSaveError();

  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: CompanySettings }>('/api/settings'),
  });
  const saved = status?.company_saved === true;
  const [company, setCompany] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Vorbelegen, sobald die Einstellungen da sind: ein bereits gespeicherter
  // Firmenname bleibt stehen, die Vorgabe des Servers ("oHRganize GmbH") nicht.
  useEffect(() => {
    if (!data || seeded) return;
    setSeeded(true);
    if (saved) setCompany(data.settings.companyName);
    setRegion(data.settings.defaultBundesland);
  }, [data, saved, seeded]);

  const needsLocation = (status?.locations ?? 0) === 0 && can('personal', 'bearbeiten');
  const save = useMutation({
    mutationFn: async () => {
      await api.put('/api/settings', { companyName: company.trim(), defaultBundesland: region });
      if (needsLocation && city.trim()) {
        await api.post('/api/locations', { name: city.trim(), city: city.trim(), bundesland: region });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      finish({ region: REGIONS[region] ?? region });
    },
    onError,
  });

  return (
    <StepShell
      stepKey="firma"
      cta={{
        label: t('step1.cta'),
        disabled: !company.trim() || !region,
        busy: save.isPending,
        onClick: () => save.mutate(),
      }}
    >
      <div className="hm-form-grid">
        <Field label={t('step1.field.company')} required span2>
          <input
            id="setup-company"
            className="hm-input"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
          />
        </Field>
        {needsLocation && (
          <Field label={t('step1.field.city')}>
            <input
              className="hm-input"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              autoComplete="address-level2"
            />
          </Field>
        )}
        <Field label={t('step1.field.region', { regionTerm: REGION_TERM })} required span2={!needsLocation}>
          <Select className="hm-select" value={region} onChange={(e) => setRegion(e.target.value)}>
            {Object.entries(REGIONS).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </StepShell>
  );
}

/* ------------------------------------------------------------ 2 Abteilungen */

const SUGGESTIONS = t('step2.suggestions')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function AbteilungenStep() {
  const qc = useQueryClient();
  const finish = useFinish('abteilungen');
  const onError = useSaveError();
  const { data: departments, isSuccess } = useDepartments();
  const existing = useMemo(() => (departments ?? []).map((d) => d.name), [departments]);
  const existingLower = useMemo(() => new Set(existing.map((n) => n.toLowerCase())), [existing]);

  const [custom, setCustom] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);

  const offered = useMemo(
    () => [...SUGGESTIONS, ...custom].filter((n) => !existingLower.has(n.toLowerCase())),
    [custom, existingLower],
  );
  // Erste drei Vorschlaege sind vorgewaehlt: schnell weiterkommen, abwaehlbar.
  useEffect(() => {
    if (isSuccess && picked === null) setPicked(new Set(offered.slice(0, 3)));
  }, [isSuccess, picked, offered]);
  const selected = picked ?? new Set<string>();

  const toggle = (n: string) =>
    setPicked((p) => {
      const next = new Set(p ?? []);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const addCustom = () => {
    const n = draft.trim();
    if (!n) return;
    if (!offered.some((o) => o.toLowerCase() === n.toLowerCase()) && !existingLower.has(n.toLowerCase())) {
      setCustom((c) => [...c, n]);
    }
    setPicked((p) => new Set([...(p ?? []), n]));
    setDraft('');
  };

  const chosen = offered.filter((n) => selected.has(n));
  const save = useMutation({
    mutationFn: async () => {
      for (const name of chosen) await api.post('/api/departments', { name, parent_id: null });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      finish({ count: chosen.length, names: names(chosen) });
    },
    onError: (e) => {
      // Ein Teil kann schon angelegt sein: Liste neu laden, dann bieten die
      // Chips nur noch an, was fehlt.
      qc.invalidateQueries({ queryKey: ['org'] });
      onError(e);
    },
  });

  return (
    <StepShell
      stepKey="abteilungen"
      cta={{
        label: t('step2.cta'),
        disabled: chosen.length === 0,
        busy: save.isPending,
        onClick: () => save.mutate(),
      }}
    >
      {existing.length > 0 && <p className="hm-setup__hint">{t('step2.existing', { names: names(existing) })}</p>}
      <p className="hm-setup__label">{t('step2.chips.title')}</p>
      <div className="hm-setup__chips">
        {offered.map((n) => (
          <Chip key={n} on={selected.has(n)} onClick={() => toggle(n)}>
            {n}
          </Chip>
        ))}
      </div>
      <form
        className="hm-setup__inline"
        onSubmit={(e) => {
          e.preventDefault();
          addCustom();
        }}
      >
        <input
          className="hm-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('step2.custom.placeholder')}
          aria-label={t('step2.custom.placeholder')}
        />
        <button type="submit" className="hm-btn hm-btn--secondary" disabled={!draft.trim()}>
          <Plus size={15} />
          {t('step2.custom.add')}
        </button>
      </form>
    </StepShell>
  );
}

/* --------------------------------------------------------- 3 Mitarbeitende */

export function MitarbeitendeStep() {
  const qc = useQueryClient();
  const finish = useFinish('mitarbeitende');
  const { data: employees } = useEmployeeList(EMPTY_FILTERS);
  const list = employees ?? [];
  const [open, setOpen] = useState(false);
  const label = (e: { first_name: string; last_name: string }) => `${e.first_name} ${e.last_name}`;

  return (
    <StepShell
      stepKey="mitarbeitende"
      cta={{
        label: t('step3.cta'),
        disabled: list.length === 0,
        onClick: () => finish({ count: list.length, names: names(list.slice(0, 3).map(label)) }),
      }}
    >
      <p className="hm-setup__hint">{t('step3.intro')}</p>
      <div>
        <p className="hm-setup__label">{t('step3.created.title')}</p>
        {list.length === 0 ? (
          <p className="hm-setup__muted">{t('step3.created.empty')}</p>
        ) : (
          <ul className="hm-setup__list">
            {list.slice(0, 8).map((e) => (
              <li key={e.id}>
                <Check size={14} />
                {label(e)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <button type="button" className="hm-btn hm-btn--secondary" onClick={() => setOpen(true)}>
          <Plus size={15} />
          {list.length === 0 ? t('step3.add') : t('step3.addAnother')}
        </button>
      </div>
      <EmployeeCreateModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY })}
      />
    </StepShell>
  );
}

/* ------------------------------------------------------------ 4 Vorgesetzte */

export function VorgesetzteStep() {
  const qc = useQueryClient();
  const finish = useFinish('vorgesetzte');
  const onError = useSaveError();
  const { data: employees } = useEmployeeList(EMPTY_FILTERS);
  const list = (employees ?? []).slice(0, 8);
  const [mgr, setMgr] = useState<Record<number, number | null> | null>(null);

  useEffect(() => {
    if (employees && mgr === null) {
      setMgr(Object.fromEntries(employees.map((e) => [e.id, e.manager_id ?? null])));
    }
  }, [employees, mgr]);
  const current = mgr ?? {};
  const name = (id: number) => {
    const e = (employees ?? []).find((x) => x.id === id);
    return e ? `${e.first_name} ${e.last_name}` : '';
  };

  // Eine Person darf nicht (ueber Zwischenstufen) an sich selbst berichten:
  // Das Backend prueft auf POST und PATCH keine Ringe.
  const reportsTo = (start: number, target: number): boolean => {
    const seen = new Set<number>();
    let at: number | null | undefined = start;
    while (at != null && !seen.has(at)) {
      if (at === target) return true;
      seen.add(at);
      at = current[at];
    }
    return false;
  };

  const changed = list.filter((e) => (current[e.id] ?? null) !== (e.manager_id ?? null));
  const anyManager = list.some((e) => current[e.id] != null);

  const save = useMutation({
    mutationFn: async () => {
      for (const e of changed) await api.patch(`/api/employees/${e.id}`, { manager_id: current[e.id] ?? null });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      const first = list.find((e) => current[e.id] != null);
      finish({ name: first ? name(first.id) : '', boss: first ? name(current[first.id] as number) : '' });
    },
    onError,
  });

  if (list.length < 2) {
    return (
      <StepShell stepKey="vorgesetzte" cta={{ label: t('step4.cta'), disabled: true, onClick: () => undefined }}>
        <p className="hm-setup__hint">{t('step4.blocked')}</p>
        <div>
          <button type="button" className="hm-btn hm-btn--secondary" onClick={() => setupActions.go('mitarbeitende')}>
            {t('step4.blocked.cta')}
          </button>
        </div>
      </StepShell>
    );
  }

  // Vorschau: der ganze Baum aus den gewählten Berichtslinien. Wurzeln sind
  // Personen ohne Vorgesetzte im Ausschnitt, die mindestens eine Person führen.
  const inList = new Set(list.map((e) => e.id));
  const reportsOf = (id: number) => list.filter((e) => current[e.id] === id);
  const roots = list.filter(
    (e) => (current[e.id] == null || !inList.has(current[e.id] as number)) && reportsOf(e.id).length > 0,
  );
  // Mehr Personen, als der Schritt zeigt: Die untersten Karten laufen in
  // verblassende Striche aus ("es geht weiter"), ohne weitere Karten.
  const hasMore = (employees?.length ?? 0) > list.length;
  const renderNode = (id: number, depth: number): React.ReactNode => {
    const reports = reportsOf(id);
    return (
      <li key={id}>
        <span className={`hm-setup__org-card${depth === 0 ? ' hm-setup__org-card--boss' : ''}`}>{name(id)}</span>
        {depth < 6 && reports.length > 0 && <ul>{reports.map((r) => renderNode(r.id, depth + 1))}</ul>}
        {hasMore && reports.length === 0 && <span className="hm-setup__fade" aria-hidden="true" />}
      </li>
    );
  };
  return (
    <StepShell
      stepKey="vorgesetzte"
      cta={{ label: t('step4.cta'), disabled: !anyManager, busy: save.isPending, onClick: () => save.mutate() }}
    >
      <div className="hm-form-grid">
        {list.map((e) => (
          <Field key={e.id} label={t('step4.field.manager', { name: `${e.first_name} ${e.last_name}` })}>
            <Select
              className="hm-select"
              value={current[e.id] ?? ''}
              onChange={(ev) => setMgr({ ...current, [e.id]: ev.target.value === '' ? null : Number(ev.target.value) })}
            >
              <option value="">{t('step4.field.none')}</option>
              {/* Alle Personen sind waehlbar, nicht nur die acht Zeilen: Ein Vorgesetzter
                  ausserhalb des Ausschnitts bliebe sonst unsichtbar ("Keine"). */}
              {(employees ?? [])
                .filter((o) => o.id !== e.id && !reportsTo(o.id, e.id))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.first_name} {o.last_name}
                  </option>
                ))}
            </Select>
          </Field>
        ))}
      </div>
      {roots.length > 0 && (
        <div className="hm-setup__org" aria-label={t('step4.preview')}>
          <div className="hm-setup__org-title">{t('step4.preview')}</div>
          <ul className="hm-setup__tree hm-setup__tree--root">{roots.map((r) => renderNode(r.id, 0))}</ul>
        </div>
      )}
    </StepShell>
  );
}

/* -------------------------------------------------------------- 5 Abwesenheit */

export function AbwesenheitStep() {
  const qc = useQueryClient();
  const finish = useFinish('abwesenheit');
  const onError = useSaveError();
  const { data: types } = useAbsenceTypes();
  const list = types ?? [];

  const toggle = useMutation({
    mutationFn: (ty: AbsenceType) =>
      api.put(`/api/absences/types/${ty.id}`, {
        name: ty.name,
        category: ty.category,
        paid: !!ty.paid,
        affects_balance: !!ty.affects_balance,
        requires_proof: !!ty.requires_proof,
        requires_approval: !!ty.requires_approval,
        color: ty.color,
        max_days_per_year: ty.max_days_per_year,
        active: !ty.active,
        portal_visibility: ty.portal_visibility,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    },
    onError,
  });
  const activeCount = list.filter((x) => x.active).length;

  return (
    <StepShell
      stepKey="abwesenheit"
      cta={{
        label: t('step5.cta'),
        disabled: activeCount === 0,
        onClick: () => {
          setupActions.confirmAbsence();
          finish({ count: activeCount });
        },
      }}
    >
      <p className="hm-setup__label">{t('step5.chips.title')}</p>
      <div className="hm-setup__chips">
        {list.map((ty) => (
          <Chip
            key={ty.id}
            on={!!ty.active}
            // Krankheit bleibt immer aktiv: Krankmeldungen finden ihre Art ueber
            // den festen Namen, ein Abschalten legte die Erfassung lahm.
            disabled={ty.category === 'krankheit' || toggle.isPending}
            onClick={() => toggle.mutate(ty)}
          >
            {ty.name}
          </Chip>
        ))}
      </div>
      <p className="hm-setup__muted">{t('step5.more')}</p>
    </StepShell>
  );
}

/* -------------------------------------------------------- 6 Zweites Admin-Konto */

function useAccounts() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminAccount[] }>('/api/admin/users'),
    select: (d) => d.users,
  });
}

export function AdminkontoStep() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { status } = useSetupContext();
  const finish = useFinish('adminkonto');
  const roles = useAdminRoles().data ?? [];
  const { data: accounts } = useAccounts();
  const [dialog, setDialog] = useState(false);
  const [issued, setIssued] = useState<{ account: AdminAccount; password: string } | null>(null);
  // Alle in dieser Sitzung angelegten Konten, nicht nur das letzte.
  const [created, setCreated] = useState<string[]>([]);

  const done = (status?.admin_users ?? 0) >= 2;
  const other = (accounts ?? []).filter((a) => a.role === 'admin' && a.id !== user?.id).pop();
  const emails = created.length > 0 ? created : other ? [other.email] : [];

  return (
    <StepShell
      stepKey="adminkonto"
      cta={{ label: t('step6.cta'), disabled: !done, onClick: () => finish({ count: emails.length, email: emails.join(', '), emails: emails.join(', ') }) }}
    >
      <p className="hm-setup__hint">{t('step6.intro')}</p>
      {created.map((email) => (
        <p key={email} className="hm-setup__ok">
          <Check size={15} />
          {t('step6.created', { email })}
        </p>
      ))}
      <div>
        <button type="button" className="hm-btn hm-btn--secondary" onClick={() => setDialog(true)}>
          <Plus size={15} />
          {t('step6.add')}
        </button>
      </div>
      {dialog && (
        <AccountDialog
          roles={roles}
          fixedRole="admin"
          onClose={() => setDialog(false)}
          onCreated={(res) => {
            setDialog(false);
            setCreated((c) => [...c, res.user.email]);
            setIssued({ account: res.user, password: res.initial_password });
            qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
          }}
        />
      )}
      {/* Das Passwort lebt nur, solange dieser Dialog offen ist. */}
      {issued && (
        <InitialPasswordDialog account={issued.account} password={issued.password} onClose={() => setIssued(null)} />
      )}
    </StepShell>
  );
}

/* ------------------------------------------------------------ 7 Portal-Zugang */

export function PortalStep() {
  const qc = useQueryClient();
  const { status } = useSetupContext();
  const finish = useFinish('portal');
  const roles = useAdminRoles().data ?? [];
  const { data: accounts } = useAccounts();
  const { data: employees } = useEmployees();
  // Wer schon ein Konto hat, bleibt sichtbar, ist aber ausgegraut: Ein Konto mit
  // Personalprofil (auch ein Admin-Konto) ist zugleich der Portal-Zugang.
  const taken = useMemo(
    () => new Set((accounts ?? []).flatMap((a) => (a.employee_id != null ? [a.employee_id] : []))),
    [accounts],
  );
  const candidates = useMemo(
    () => (employees ?? []).filter((e) => e.status === 'aktiv' && !taken.has(e.id)),
    [employees, taken],
  );
  const [personId, setPersonId] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);
  const [issued, setIssued] = useState<{ account: AdminAccount; password: string } | null>(null);
  const [created, setCreated] = useState<string[]>([]);

  const chosen = candidates.find((c) => c.id === personId) ?? candidates[0] ?? null;
  const done = (status?.portal_users ?? 0) >= 1;
  const withAccess = (employees ?? []).find((e) => taken.has(e.id));

  return (
    <StepShell
      stepKey="portal"
      cta={{
        label: t('step7.cta'),
        disabled: !done,
        onClick: () => {
          const people = created.length > 0 ? created : withAccess ? [`${withAccess.first_name} ${withAccess.last_name}`] : [];
          finish({ count: people.length, name: people.join(', '), names: people.join(', ') });
        },
      }}
    >
      {created.map((name) => (
        <p key={name} className="hm-setup__ok">
          <Check size={15} />
          {t('step7.created', { name })}
        </p>
      ))}
      {candidates.length === 0 && <p className="hm-setup__hint">{t('step7.empty')}</p>}
      <Field label={t('step7.person')}>
        <EmployeeSelect
          value={chosen?.id ?? null}
          onChange={setPersonId}
          disabledIds={taken}
          disabledHint={t('step7.person.hasAccess')}
        />
      </Field>
      {chosen && (
        <div>
          <button type="button" className="hm-btn hm-btn--secondary" onClick={() => setDialog(true)}>
            <Plus size={15} />
            {t('step7.add')}
          </button>
        </div>
      )}
      {dialog && chosen && (
        <AccountDialog
          roles={roles}
          fixedRole="mitarbeiter"
          profileTakenHint={t('step7.person.hasAccess')}
          initialEmployeeId={chosen.id}
          initialName={`${chosen.first_name} ${chosen.last_name}`}
          onClose={() => setDialog(false)}
          onCreated={(res) => {
            setDialog(false);
            setCreated((c) => [...c, res.user.name]);
            setIssued({ account: res.user, password: res.initial_password });
            setPersonId(null);
            qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
          }}
        />
      )}
      {issued && (
        <InitialPasswordDialog account={issued.account} password={issued.password} onClose={() => setIssued(null)} />
      )}
    </StepShell>
  );
}

/* ------------------------------------------------------------------- Bausteine */

function Chip({
  on,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`hm-setup__chip${on ? ' is-on' : ''}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {on && <Check size={14} />}
      {children}
    </button>
  );
}

export const STEP_COMPONENTS: Record<SetupStepKey, React.ComponentType> = {
  firma: FirmaStep,
  abteilungen: AbteilungenStep,
  mitarbeitende: MitarbeitendeStep,
  vorgesetzte: VorgesetzteStep,
  abwesenheit: AbwesenheitStep,
  adminkonto: AdminkontoStep,
  portal: PortalStep,
};
