import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, FilePlus2, FolderOpen, Plus, Search, Trash2 } from 'lucide-react';
import { DOCUMENT_CATEGORY_LABELS, formatDate } from '@ohrganize/shared';
import { api, downloadFile } from '../../api/client';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useDocuments, useExpiringDocuments, type DocumentRow } from './api';
import { DocumentUploadModal } from './DocumentUploadModal';
import { expiryBadge } from './EmployeeDetailPage';

export function DocumentsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newVersionOf, setNewVersionOf] = useState<DocumentRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentRow | null>(null);

  const { data: documents, isLoading } = useDocuments({
    search: search || undefined,
    category: category || undefined,
  });
  const { data: expiring } = useExpiringDocuments();

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/documents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      toast.success('Dokument gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Dokumente"
        subtitle="Modulübergreifende Dokumentenablage mit Volltextsuche und Ablauf-Überwachung."
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setNewVersionOf(null);
              setUploadOpen(true);
            }}
          >
            <Plus size={16} /> Dokument hochladen
          </button>
        }
      />

      {(expiring?.length ?? 0) > 0 && (
        <Card
          title={
            <span className="row">
              <AlertTriangle size={17} style={{ color: 'var(--warning)' }} /> Ablaufende Dokumente
            </span>
          }
          style={{ marginBottom: 16 }}
        >
          <div className="stack" style={{ gap: 8 }}>
            {expiring!.map((d) => (
              <div key={d.id} className="row row--between">
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{d.title}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                    {d.employee_name ?? 'Allgemein'} · {DOCUMENT_CATEGORY_LABELS[d.category]}
                  </span>
                  {expiryBadge(d)}
                </div>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  Ablauf {formatDate(d.expiry_date)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card flush style={{ marginBottom: 16 }}>
        <div className="row row--wrap" style={{ padding: 14 }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }} />
            <input
              className="hm-input"
              style={{ paddingLeft: 34 }}
              placeholder="Volltextsuche (Titel, Notiz, Dateiname, Mitarbeitername, …)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="hm-select"
            style={{ width: 180 }}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Alle Kategorien</option>
            {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (documents?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<FolderOpen size={40} />}
            title="Keine Dokumente gefunden"
            hint={
              search || category
                ? 'Passen Sie Suchbegriff oder Kategorie-Filter an.'
                : 'Laden Sie das erste Dokument hoch. Sie können zwischen Mitarbeiter-Zuordnung oder ohne entscheiden.'
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Mitarbeiter:in</th>
                  <th>Kategorie</th>
                  <th>Version</th>
                  <th>Ablauf</th>
                  <th>Hochgeladen</th>
                  <th style={{ width: 140 }} />
                </tr>
              </thead>
              <tbody>
                {documents!.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{d.title}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {d.original_name}
                        {d.note ? ` · ${d.note}` : ''}
                      </div>
                    </td>
                    <td>{d.employee_name ?? <Badge tone="neutral">Allgemein</Badge>}</td>
                    <td>
                      <Badge tone="blue">{DOCUMENT_CATEGORY_LABELS[d.category]}</Badge>
                    </td>
                    <td>v{d.version}</td>
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
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Löschen"
                          onClick={() => setConfirmDelete(d)}
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

      <DocumentUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} supersedes={newVersionOf} />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Dokument löschen?"
        message={`„${confirmDelete?.title}“ wird aus der Dokumentenverwaltung entfernt.`}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}
