import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Download, FileClock, FilePlus2, FileText, Pencil, Plus, Trash2, Users,
} from 'lucide-react';
import {
  CONTRACT_TYPE_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  formatDate,
  type ContractDto,
} from '@hrmonic/shared';
import { api, downloadFile } from '../../api/client';
import { Avatar, Badge, Card, EmptyState, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useContracts, useDocuments, useEmployee, usePhotoUrl, type DocumentRow, type EmployeeRow } from './api';
import {
  EmploymentFields,
  FinanceFields,
  PersonFields,
  employeeToForm,
  formToPayload,
  type EmployeeFormState,
} from './employeeForm';
import { ContractModal } from './ContractModal';
import { DocumentUploadModal } from './DocumentUploadModal';
import { TYPE_TONES } from './EmployeeListPage';

export function EmployeeDetailPage() {
  const { id } = useParams();
  const employeeId = Number(id);
  const navigate = useNavigate();
  const { data, isLoading } = useEmployee(employeeId);
  const [tab, setTab] = useState('stammdaten');
  const photo = usePhotoUrl(data?.employee.photo_file_id);

  if (isLoading || !data) return <Spinner center />;
  const e = data.employee;

  return (
    <>
      <PageHeader
        title={`${e.first_name} ${e.last_name}`}
        subtitle={[e.job_title, e.department_name, e.location_name].filter(Boolean).join(' · ') || 'Personalakte'}
        actions={
          <button className="hm-btn hm-btn--secondary" onClick={() => navigate('/personal/mitarbeitende')}>
            <ArrowLeft size={16} /> Zur Übersicht
          </button>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <Avatar name={`${e.first_name} ${e.last_name}`} size={56} src={photo.data} />
        <Badge tone={TYPE_TONES[e.employee_type]}>{EMPLOYEE_TYPE_LABELS[e.employee_type]}</Badge>
        <Badge tone={e.status === 'aktiv' ? 'green' : 'neutral'}>{EMPLOYEE_STATUS_LABELS[e.status]}</Badge>
        {e.hire_date && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Eintritt {formatDate(e.hire_date)}
          </span>
        )}
      </div>

      <Tabs
        tabs={[
          { key: 'stammdaten', label: 'Stammdaten' },
          { key: 'vertrag', label: 'Vertrag' },
          { key: 'dokumente', label: 'Dokumente' },
          { key: 'organisation', label: 'Organisation' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'stammdaten' && <MasterDataTab employee={e} />}
        {tab === 'vertrag' && <ContractsTab employeeId={employeeId} />}
        {tab === 'dokumente' && <DocumentsTab employeeId={employeeId} />}
        {tab === 'organisation' && <OrgTab employee={e} reportingLine={data.reporting_line} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Stammdaten
// ---------------------------------------------------------------------------

function MasterDataTab({ employee }: { employee: EmployeeRow }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<EmployeeFormState>(() => employeeToForm(employee));
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setForm(employeeToForm(employee));
    setDirty(false);
  }, [employee]);

  const set = (patch: Partial<EmployeeFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => api.patch(`/api/employees/${employee.id}`, formToPayload(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      toast.success('Stammdaten gespeichert');
      setDirty(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/employees/${employee.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast.success('Mitarbeiter:in gelöscht');
      navigate('/personal/mitarbeitende');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="stack">
      <Card title="Person & Kontakt">
        <PersonFields form={form} set={set} />
      </Card>
      <Card title="Beschäftigung">
        <EmploymentFields form={form} set={set} />
      </Card>
      <Card title="Finanzen, Steuer & Sozialversicherung">
        <FinanceFields form={form} set={set} />
      </Card>
      <div className="row row--between">
        <button className="hm-btn hm-btn--danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={16} /> Löschen
        </button>
        <button
          className="hm-btn hm-btn--primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Mitarbeiter:in löschen?"
        message={`${employee.first_name} ${employee.last_name} wird endgültig gelöscht. Wenn andere Module Daten referenzieren, setzen Sie stattdessen den Status auf „ausgeschieden“.`}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verträge (Historie als Timeline)
// ---------------------------------------------------------------------------

function ContractsTab({ employeeId }: { employeeId: number }) {
  const { data: contracts, isLoading } = useContracts(employeeId);
  const [modalOpen, setModalOpen] = useState(false);
  const [correct, setCorrect] = useState<ContractDto | null>(null);

  if (isLoading) return <Spinner center />;

  return (
    <Card
      title="Vertragshistorie"
      actions={
        <button
          className="hm-btn hm-btn--primary hm-btn--sm"
          onClick={() => {
            setCorrect(null);
            setModalOpen(true);
          }}
        >
          <Plus size={15} /> Neue Version
        </button>
      }
    >
      {(contracts?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FileText size={40} />}
          title="Noch kein Vertrag hinterlegt"
          hint="Legen Sie die erste Vertragsversion an — spätere Änderungen erzeugen neue Versionen mit lückenloser Historie."
        />
      ) : (
        <div className="stack">
          {contracts!.map((c, i) => (
            <div
              key={c.id}
              className="row"
              style={{
                alignItems: 'flex-start',
                gap: 14,
                paddingBottom: i < contracts!.length - 1 ? 16 : 0,
                borderBottom: i < contracts!.length - 1 ? '1px solid var(--border)' : undefined,
              }}
            >
              <div style={{ paddingTop: 3 }}>
                <Badge tone={c.valid_to === null ? 'green' : 'neutral'}>
                  {c.valid_to === null ? 'Offen' : 'Geschlossen'}
                </Badge>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {CONTRACT_TYPE_LABELS[c.contract_type]} · {formatDate(c.valid_from)} –{' '}
                  {c.valid_to ? formatDate(c.valid_to) : 'offen'}
                </div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 3 }}>
                  {[
                    c.weekly_hours !== null ? `${c.weekly_hours} Std./Woche` : null,
                    c.annual_leave_days !== null ? `${c.annual_leave_days} Urlaubstage` : null,
                    c.notice_period_weeks !== null ? `Kündigungsfrist ${c.notice_period_weeks} Wochen` : null,
                    c.probation_end ? `Probezeit bis ${formatDate(c.probation_end)}` : null,
                    c.fixed_term_reason ? `Befristung: ${c.fixed_term_reason}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
                {c.note && (
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 3 }}>
                    {c.note}
                  </div>
                )}
              </div>
              <div className="row">
                {c.document_file_id && (
                  <button
                    className="hm-btn hm-btn--ghost hm-btn--sm"
                    title="Vertragsdokument herunterladen"
                    onClick={() => downloadFile(c.document_file_id!)}
                  >
                    <Download size={15} />
                  </button>
                )}
                {c.valid_to === null && (
                  <button
                    className="hm-btn hm-btn--secondary hm-btn--sm"
                    onClick={() => {
                      setCorrect(c);
                      setModalOpen(true);
                    }}
                  >
                    <Pencil size={14} /> Korrigieren
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <ContractModal open={modalOpen} onClose={() => setModalOpen(false)} employeeId={employeeId} correct={correct} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dokumente des Mitarbeitenden
// ---------------------------------------------------------------------------

export function expiryBadge(doc: DocumentRow): React.ReactNode {
  if (doc.days_until_expiry === null || doc.expiry_date === null) return null;
  if (doc.days_until_expiry < 0) return <Badge tone="red">abgelaufen</Badge>;
  if (doc.days_until_expiry <= doc.reminder_days)
    return <Badge tone="yellow">läuft in {doc.days_until_expiry} Tagen ab</Badge>;
  return null;
}

function DocumentsTab({ employeeId }: { employeeId: number }) {
  const { data: documents, isLoading } = useDocuments({ employee_id: employeeId, include_superseded: true });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newVersionOf, setNewVersionOf] = useState<DocumentRow | null>(null);

  if (isLoading) return <Spinner center />;

  return (
    <Card
      title="Dokumente"
      flush
      actions={
        <button
          className="hm-btn hm-btn--primary hm-btn--sm"
          onClick={() => {
            setNewVersionOf(null);
            setUploadOpen(true);
          }}
        >
          <Plus size={15} /> Dokument hochladen
        </button>
      }
    >
      {(documents?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FileClock size={40} />}
          title="Keine Dokumente vorhanden"
          hint="Verträge, Zeugnisse und Bescheinigungen werden hier versioniert abgelegt."
        />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Titel</th>
                <th>Kategorie</th>
                <th>Version</th>
                <th>Ablauf</th>
                <th>Hochgeladen</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {documents!.map((d) => (
                <tr key={d.id} style={{ opacity: d.is_superseded ? 0.55 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.title}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{d.original_name}</div>
                  </td>
                  <td>
                    <Badge tone="neutral">{DOCUMENT_CATEGORY_LABELS[d.category]}</Badge>
                  </td>
                  <td>
                    v{d.version} {d.is_superseded ? <Badge tone="neutral">abgelöst</Badge> : null}
                  </td>
                  <td>
                    {d.expiry_date ? formatDate(d.expiry_date) : '—'} {expiryBadge(d)}
                  </td>
                  <td>{formatDate(d.created_at.slice(0, 10))}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                        title="Herunterladen"
                        onClick={() => downloadFile(d.file_id)}
                      >
                        <Download size={15} />
                      </button>
                      {!d.is_superseded && (
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Neue Version hochladen"
                          onClick={() => {
                            setNewVersionOf(d);
                            setUploadOpen(true);
                          }}
                        >
                          <FilePlus2 size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DocumentUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        fixedEmployeeId={employeeId}
        supersedes={newVersionOf}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Organisation & Reporting-Line
// ---------------------------------------------------------------------------

function OrgTab({
  employee,
  reportingLine,
}: {
  employee: EmployeeRow;
  reportingLine: { id: number; name: string; job_title: string | null }[];
}) {
  const navigate = useNavigate();
  return (
    <div className="stack">
      <Card title="Organisatorische Zuordnung">
        <div className="hm-form-grid">
          <ReadonlyField label="Abteilung" value={employee.department_name} />
          <ReadonlyField label="Team" value={employee.team_name} />
          <ReadonlyField label="Standort" value={employee.location_name} />
          <ReadonlyField label="Vorgesetzte:r" value={employee.manager_name} />
        </div>
        <p style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          Zuordnungen ändern Sie im Tab „Stammdaten“ (Bereich Beschäftigung) oder per
          Massenbearbeitung in der Übersicht.
        </p>
      </Card>
      <Card title="Reporting-Line">
        {reportingLine.length === 0 ? (
          <EmptyState
            icon={<Users size={40} />}
            title="Keine Vorgesetzten hinterlegt"
            hint="Diese Person steht an der Spitze der Reporting-Line oder hat noch keine Zuordnung."
          />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row">
              <Avatar name={`${employee.first_name} ${employee.last_name}`} size={30} />
              <div>
                <div style={{ fontWeight: 600 }}>
                  {employee.first_name} {employee.last_name}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {employee.job_title ?? '—'}
                </div>
              </div>
            </div>
            {reportingLine.map((m, i) => (
              <div key={m.id} className="row" style={{ paddingLeft: (i + 1) * 22 }}>
                <span style={{ color: 'var(--text-muted)' }}>↳</span>
                <Avatar name={m.name} size={30} />
                <button
                  className="hm-btn hm-btn--ghost hm-btn--sm"
                  onClick={() => navigate(`/personal/mitarbeitende/${m.id}`)}
                >
                  <span style={{ fontWeight: 600 }}>{m.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{m.job_title ?? ''}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="hm-field">
      <span className="hm-field__label">{label}</span>
      <div style={{ fontWeight: 550 }}>{value ?? '—'}</div>
    </div>
  );
}
