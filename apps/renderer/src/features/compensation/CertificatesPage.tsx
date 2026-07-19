import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileBadge, Plus, Trash2 } from 'lucide-react';
import {
  CERTIFICATE_KIND_LABELS,
  CERTIFICATE_STATUS_LABELS,
  formatDate,
  type CertificateKind,
  type CertificateStatus,
} from '@hrmonic/shared';
import { api, API_BASE, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { STATUS_TONES } from './lib';

interface CertificateRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  kind: string;
  period: string;
  file_id: number | null;
  status: string;
  note: string | null;
  created_at: string;
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [kind, setKind] = useState<string>('entgeltbescheinigung_108');
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/compensation/certificates', {
        employee_id: employeeId,
        kind,
        period,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Bescheinigung wurde generiert und abgelegt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setNote('');
      onClose();
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Erstellen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Bescheinigung erstellen"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!employeeId || period.trim().length < 4 || create.isPending}
            onClick={() => create.mutate()}
          >
            Generieren
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Art" required>
          <select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {(Object.keys(CERTIFICATE_KIND_LABELS) as CertificateKind[]).map((k) => (
              <option key={k} value={k}>
                {CERTIFICATE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Jahr / Zeitraum" required hint="z. B. 2026 oder 01/2026–06/2026">
          <input className="hm-input" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="Notiz" span2>
          <input className="hm-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 12 }}>
        Die Bescheinigung wird als HTML-Dokument mit den Firmendaten aus den Einstellungen und den
        Stammdaten der Mitarbeiter:in generiert und im Dokumenten-Storage abgelegt.
      </p>
    </Modal>
  );
}

export function CertificatesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'certificates'],
    queryFn: () => api.get<{ certificates: CertificateRow[] }>('/api/compensation/certificates'),
    select: (d) => d.certificates,
  });

  const handover = useMutation({
    mutationFn: (id: number) =>
      api.post(`/api/compensation/certificates/${id}/status`, { status: 'ausgehaendigt' }),
    onSuccess: () => {
      toast.success('Bescheinigung als ausgehändigt markiert');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Statuswechsel fehlgeschlagen'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/compensation/certificates/${id}`),
    onSuccess: () => {
      toast.success('Bescheinigung gelöscht');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Löschen fehlgeschlagen'),
  });

  const download = async (cert: CertificateRow) => {
    try {
      const { url } = await api.post<{ url: string }>(`/api/compensation/certificates/${cert.id}/sign`);
      const a = document.createElement('a');
      a.href = `${API_BASE}${url}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(e instanceof ApiRequestError ? e.message : 'Download fehlgeschlagen');
    }
  };

  return (
    <>
      <PageHeader
        title="Bescheinigungen"
        subtitle="Lohnsteuer-, Arbeitgeber- und Entgeltbescheinigungen generieren und verwalten"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Bescheinigung erstellen
          </button>
        }
      />
      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            icon={<FileBadge size={40} />}
            title="Keine Bescheinigungen vorhanden"
            hint="Erstellen Sie eine Bescheinigung — sie wird automatisch generiert und abgelegt."
            action={
              <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} /> Bescheinigung erstellen
              </button>
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Art</th>
                  <th>Zeitraum</th>
                  <th>Erstellt</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>
                      {c.last_name}, {c.first_name}
                    </td>
                    <td>{CERTIFICATE_KIND_LABELS[c.kind as CertificateKind] ?? c.kind}</td>
                    <td>{c.period}</td>
                    <td>{formatDate(c.created_at?.slice(0, 10))}</td>
                    <td>
                      <Badge tone={STATUS_TONES[c.status] ?? 'neutral'}>
                        {CERTIFICATE_STATUS_LABELS[c.status as CertificateStatus] ?? c.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {c.file_id && (
                          <button
                            className="hm-btn hm-btn--secondary hm-btn--sm"
                            onClick={() => download(c)}
                          >
                            <Download size={14} /> Download
                          </button>
                        )}
                        {c.status === 'erstellt' && (
                          <button
                            className="hm-btn hm-btn--primary hm-btn--sm"
                            disabled={handover.isPending}
                            onClick={() => handover.mutate(c.id)}
                          >
                            Aushändigen
                          </button>
                        )}
                        {c.status !== 'ausgehaendigt' && (
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            aria-label="Löschen"
                            onClick={() => setDeleteId(c.id)}
                          >
                            <Trash2 size={15} />
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
      </Card>
      <CreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog
        open={deleteId !== null}
        title="Bescheinigung löschen"
        message="Soll diese Bescheinigung wirklich gelöscht werden?"
        onConfirm={() => deleteId !== null && remove.mutate(deleteId)}
        onClose={() => setDeleteId(null)}
      />
    </>
  );
}
