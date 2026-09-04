import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileStack, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  HR_TEMPLATE_CATEGORY_LABELS,
  formatDate,
  type HrTemplate,
  type HrTemplateCategory,
} from '@ohrganize/shared';
import { api, downloadFile, uploadFile } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { FilePicker } from '../../components/FilePicker';
import { useToast } from '../../components/Toast';
import { useHrTemplates } from './api';

/**
 * HR-Dokumentverzeichnis der Abteilung: zentrale Vorlagen (Schreiben, Verträge,
 * Formulare …), die alle in HR nutzen — getrennt von der mitarbeiterbezogenen
 * Dokumentenablage unter Personal → Dokumente.
 */
export function TemplatesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState<HrTemplate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HrTemplate | null>(null);

  const { data: templates, isLoading } = useHrTemplates(search, category);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'templates'] });
      toast.success('Vorlage gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="HR-Vorlagen"
        subtitle="Zentrales Dokumentverzeichnis der Abteilung — Vorlagen für Schreiben, Verträge und Formulare."
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setEditTemplate(null);
              setDialogOpen(true);
            }}
          >
            <Plus size={16} /> Vorlage hochladen
          </button>
        }
      />

      <Card flush style={{ marginBottom: 16 }}>
        <div className="row row--wrap" style={{ padding: 14 }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }} />
            <input
              className="hm-input"
              style={{ paddingLeft: 34 }}
              placeholder="Suche (Titel, Beschreibung, Dateiname)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="hm-select"
            style={{ width: 190 }}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Alle Kategorien</option>
            {Object.entries(HR_TEMPLATE_CATEGORY_LABELS).map(([v, l]) => (
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
        ) : (templates?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<FileStack size={40} />}
            title="Keine Vorlagen gefunden"
            hint={
              search || category
                ? 'Passen Sie Suchbegriff oder Kategorie-Filter an.'
                : 'Laden Sie die erste Vorlage hoch — z. B. ein Musterschreiben oder eine Vertragsvorlage.'
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Kategorie</th>
                  <th>Datei</th>
                  <th>Aktualisiert</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {templates!.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t.title}</div>
                      {t.description && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          {t.description}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge tone="blue">{HR_TEMPLATE_CATEGORY_LABELS[t.category]}</Badge>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                      {t.original_name}
                    </td>
                    <td>{formatDate(t.updated_at.slice(0, 10))}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Herunterladen"
                          onClick={() => downloadFile(t.file_id)}
                        >
                          <Download size={15} />
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Bearbeiten / neue Datei"
                          onClick={() => {
                            setEditTemplate(t);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Löschen"
                          onClick={() => setConfirmDelete(t)}
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

      <TemplateDialog open={dialogOpen} onClose={() => setDialogOpen(false)} template={editTemplate} />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Vorlage löschen?"
        message={`„${confirmDelete?.title}“ wird aus dem HR-Dokumentverzeichnis entfernt.`}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}

/** Anlegen (Datei Pflicht) und Bearbeiten (Datei optional austauschbar) in einem Dialog. */
function TemplateDialog({
  open,
  onClose,
  template,
}: {
  open: boolean;
  onClose: () => void;
  template: HrTemplate | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<HrTemplateCategory>('schreiben');
  const [description, setDescription] = useState('');

  React.useEffect(() => {
    if (open) {
      setFile(null);
      setTitle(template?.title ?? '');
      setCategory(template?.category ?? 'schreiben');
      setDescription(template?.description ?? '');
    }
  }, [open, template]);

  const save = useMutation({
    mutationFn: async () => {
      let fileId: number | undefined;
      if (file) {
        const uploaded = await uploadFile(file);
        fileId = uploaded.file.id;
      }
      if (template) {
        return api.patch(`/api/admin/templates/${template.id}`, {
          title: title.trim() || undefined,
          category,
          description: description.trim() || null,
          ...(fileId !== undefined ? { file_id: fileId } : {}),
        });
      }
      if (fileId === undefined) throw new Error('Bitte eine Datei auswählen');
      return api.post('/api/admin/templates', {
        file_id: fileId,
        title: title.trim() || file!.name,
        category,
        description: description.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'templates'] });
      toast.success(template ? 'Vorlage aktualisiert' : 'Vorlage gespeichert');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={template ? `Vorlage bearbeiten: ${template.title}` : 'Vorlage hochladen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={(!template && !file) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Wird gespeichert…' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field
          label="Datei"
          required={!template}
          span2
          hint={template ? 'Leer lassen = bisherige Datei behalten' : 'Word, PDF oder anderes Office-Dokument'}
        >
          <FilePicker file={file} onFile={setFile} hint="Vorlagendatei" />
        </Field>
        <Field label="Titel" required span2 hint={template ? undefined : 'Leer = Dateiname'}>
          <input className="hm-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Kategorie">
          <select
            className="hm-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as HrTemplateCategory)}
          >
            {Object.entries(HR_TEMPLATE_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Beschreibung" span2 hint="Wofür ist die Vorlage gedacht?">
          <textarea
            className="hm-textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
