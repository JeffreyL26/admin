import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from '@hrmonic/shared';
import { api, uploadFile } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import type { DocumentRow } from './api';

/**
 * Upload-Dialog: erst Datei über POST /api/files (Core), danach Metadaten.
 * `supersedes` = neue Version eines bestehenden Dokuments.
 */
export function DocumentUploadModal({
  open,
  onClose,
  fixedEmployeeId,
  supersedes,
}: {
  open: boolean;
  onClose: () => void;
  fixedEmployeeId?: number;
  supersedes?: DocumentRow | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(fixedEmployeeId ?? null);
  const [category, setCategory] = useState<DocumentCategory>(supersedes?.category ?? 'sonstiges');
  const [title, setTitle] = useState(supersedes?.title ?? '');
  const [note, setNote] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reminderDays, setReminderDays] = useState('30');

  React.useEffect(() => {
    if (open) {
      setFile(null);
      setEmployeeId(fixedEmployeeId ?? supersedes?.employee_id ?? null);
      setCategory(supersedes?.category ?? 'sonstiges');
      setTitle(supersedes?.title ?? '');
      setNote('');
      setExpiryDate(supersedes?.expiry_date ?? '');
      setReminderDays(String(supersedes?.reminder_days ?? 30));
    }
  }, [open, fixedEmployeeId, supersedes]);

  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Bitte eine Datei auswählen');
      const uploaded = await uploadFile(file);
      return api.post('/api/documents', {
        employee_id: employeeId,
        file_id: uploaded.file.id,
        category,
        title: title.trim() || file.name,
        note: note.trim() || null,
        expiry_date: expiryDate || null,
        reminder_days: Number(reminderDays) || 30,
        supersedes_id: supersedes?.id ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      toast.success(supersedes ? 'Neue Dokumentversion gespeichert' : 'Dokument gespeichert');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={supersedes ? `Neue Version: ${supersedes.title}` : 'Dokument hochladen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!file || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Wird hochgeladen…' : 'Hochladen'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Datei" required span2>
          <input className="hm-input" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Titel" required span2 hint="Leer = Dateiname">
          <input className="hm-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Kategorie">
          <select
            className="hm-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as DocumentCategory)}
          >
            {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mitarbeiter:in" hint="Leer = allgemeines Dokument">
          <EmployeeSelect
            value={employeeId}
            onChange={setEmployeeId}
            allowEmpty
            disabled={fixedEmployeeId !== undefined || !!supersedes}
            emptyLabel="— allgemein —"
          />
        </Field>
        <Field label="Ablaufdatum" hint="Leer = läuft nicht ab">
          <input className="hm-input" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </Field>
        <Field label="Erinnerung (Tage vor Ablauf)">
          <input
            className="hm-input"
            type="number"
            min={0}
            max={730}
            value={reminderDays}
            onChange={(e) => setReminderDays(e.target.value)}
          />
        </Field>
        <Field label="Notiz" span2>
          <textarea className="hm-textarea" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
