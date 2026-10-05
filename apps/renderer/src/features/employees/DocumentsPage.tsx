import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, FilePlus2, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { DOCUMENT_CATEGORY_LABELS, formatDate, type DocumentSource } from '@ohrganize/shared';
import { api, downloadFile } from '../../api/client';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { useDocumentPage, useExpiringDocuments, type DocumentRow } from './api';
import { DocumentUploadModal } from './DocumentUploadModal';
import { SourceBadge, VisibilityBadge, VisibilityToggle } from './documentVisibility';
import { DocumentEditModal } from './DocumentEditModal';
import { expiryBadge } from './EmployeeDetailPage';
import { Select } from '../../components/Select';
import { backToState } from '../../lib/backTo';
import { useFocusRow } from '../../lib/focusRow';
import { Pagination, usePageState } from '../../components/Pagination';
import { useDebounced } from '../../components/useDebounced';

/** Seitengröße der Dokumentablage. */
const DOCUMENT_PAGE_SIZE = 100;

/** Zugeordnete Person als Absprung in die Personalakte; „Zurück“ dort landet wieder bei diesem Dokument. */
function documentOwner(d: DocumentRow) {
  if (d.employee_id === null) return <Badge tone="neutral">Allgemein</Badge>;
  return (
    <Link
      className="hm-text-link"
      to={`/personal/mitarbeitende/${d.employee_id}`}
      state={backToState(`/personal/dokumente?dokument=${d.id}`, 'Zurück zu den Dokumenten')}
    >
      {d.employee_name}
    </Link>
  );
}

export function DocumentsPage() {
  const focusId = useFocusRow('dokument');
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState<'' | DocumentSource>('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newVersionOf, setNewVersionOf] = useState<DocumentRow | null>(null);
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentRow | null>(null);

  // Geblättert: Die Ablage lud früher alle Dokumente am Stück. Ein Absprung
  // zurück aus der Personalakte (?dokument=<id>) landet auf dessen Seite.
  const paging = usePageState(DOCUMENT_PAGE_SIZE, focusId);
  const debouncedSearch = useDebounced(search);
  // Zurück auf Seite 1 erst mit dem entprellten Suchbegriff, der auch in die
  // Abfrage geht: Je Tastendruck zurückgesetzt, lud die Liste beim Tippen auf
  // einer späteren Seite sofort Seite 1 des ALTEN Suchbegriffs. Nicht beim
  // ersten Rendern, sonst ginge der Absprung auf ein Dokument verloren.
  const lastSearch = useRef(debouncedSearch);
  useEffect(() => {
    if (lastSearch.current === debouncedSearch) return;
    lastSearch.current = debouncedSearch;
    paging.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  const { data, isLoading, isPlaceholderData } = useDocumentPage(
    {
      search: debouncedSearch || undefined,
      category: category || undefined,
      source: source || undefined,
      include_superseded: includeSuperseded,
    },
    paging.query,
  );
  useEffect(() => {
    if (data && !isPlaceholderData) {
      paging.settle({ total: data.total, offset: data.offset, rows: data.documents.length });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isPlaceholderData]);
  const documents = data?.documents;
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
                    {d.employee_id === null ? 'Allgemein' : documentOwner(d)} · {DOCUMENT_CATEGORY_LABELS[d.category]}
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
          <Select
            className="hm-select"
            style={{ width: 180 }}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              paging.reset();
            }}
          >
            <option value="">Alle Kategorien</option>
            {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select
            className="hm-select"
            style={{ width: 170 }}
            value={source}
            aria-label="Herkunft"
            onChange={(e) => {
              setSource(e.target.value as '' | DocumentSource);
              paging.reset();
            }}
          >
            <option value="">Jede Herkunft</option>
            <option value="portal">Aus dem Portal</option>
            <option value="hr">Von HR abgelegt</option>
          </Select>
          <label className="hm-checkbox" style={{ whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={includeSuperseded}
              onChange={(e) => {
                setIncludeSuperseded(e.target.checked);
                paging.reset();
              }}
            />
            Abgelöste Versionen anzeigen
          </label>
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
              search || category || source
                ? 'Passen Sie Suchbegriff, Kategorie oder Herkunft an.'
                : 'Laden Sie das erste Dokument hoch. Sie können zwischen Mitarbeiter-Zuordnung oder ohne entscheiden.'
            }
          />
        ) : (
          <div className={`hm-table-wrap${isPlaceholderData ? ' hm-table-wrap--stale' : ''}`}>
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Mitarbeiter:in</th>
                  <th>Kategorie</th>
                  <th>Version</th>
                  <th>Ablauf</th>
                  <th>Hochgeladen</th>
                  <th style={{ width: 210 }} />
                </tr>
              </thead>
              <tbody>
                {documents!.map((d) => (
                  <tr
                    key={d.id}
                    data-focus-id={d.id}
                    className={d.id === focusId ? 'hm-row--focus' : undefined}
                    style={{ opacity: d.is_superseded ? 0.55 : 1 }}
                  >
                    <td>
                      <div style={{ fontWeight: 600 }}>{d.title}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {d.original_name}
                        {d.note ? ` · ${d.note}` : ''}
                      </div>
                    </td>
                    <td>{documentOwner(d)}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Badge tone="blue">{DOCUMENT_CATEGORY_LABELS[d.category]}</Badge>
                        <SourceBadge source={d.source} />
                        <VisibilityBadge visibility={d.visibility} />
                      </span>
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
                        <VisibilityToggle doc={d} />
                        <Tooltip content="Herunterladen">
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                            aria-label="Herunterladen"
                            onClick={() => downloadFile(d.file_id)}
                          >
                            <Download size={15} />
                          </button>
                        </Tooltip>
                        <Tooltip content={<span className="hm-tooltip__title">Metadaten bearbeiten</span>}>
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                            aria-label="Metadaten bearbeiten"
                            onClick={() => setEditing(d)}
                          >
                            <Pencil size={15} />
                          </button>
                        </Tooltip>
                        {!d.is_superseded && (
                          <Tooltip content="Neue Version hochladen">
                            <button
                              className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                              aria-label="Neue Version hochladen"
                              onClick={() => {
                                setNewVersionOf(d);
                                setUploadOpen(true);
                              }}
                            >
                              <FilePlus2 size={15} />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip content="Löschen">
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                            aria-label="Löschen"
                            onClick={() => setConfirmDelete(d)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && (documents?.length ?? 0) > 0 && (
          <Pagination
            page={paging.page}
            pageSize={paging.pageSize}
            total={data?.total ?? 0}
            onChange={paging.go}
            label="Dokumente"
          />
        )}
      </Card>

      <DocumentUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} supersedes={newVersionOf} />
      <DocumentEditModal doc={editing} onClose={() => setEditing(null)} />
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
