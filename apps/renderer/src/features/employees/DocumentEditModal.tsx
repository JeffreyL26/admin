import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from '@ohrganize/shared';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';
import type { DocumentRow } from './api';

/**
 * Metadaten eines bestehenden Dokuments aendern (Titel, Kategorie, Notiz,
 * Ablaufdatum, Erinnerungstage) ueber PATCH /api/documents/:id. Die Datei
 * selbst und die Zuordnung bleiben unangetastet; dafuer gibt es „Neue
 * Version“. Sichtbarkeit hat ihren eigenen Umschalter in der Aktionsspalte.
 */
export function DocumentEditModal({ doc, onClose }: { doc: DocumentRow | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocumentCategory>('sonstiges');
  const [note, setNote] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reminderDays, setReminderDays] = useState('30');

  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title);
    setCategory(doc.category);
    setNote(doc.note ?? '');
    setExpiryDate(doc.expiry_date ?? '');
    setReminderDays(String(doc.reminder_days));
  }, [doc]);

  const save = useMutation({
    mutationFn: () => {
      if (!doc) throw new Error('Kein Dokument gewählt');
      // „0“ ist gueltig (keine Vorwarnung); nur leer oder Unlesbares faellt
      // auf den bisherigen Wert zurueck.
      const parsedReminder = Number(reminderDays);
      const reminder =
        reminderDays.trim() === '' || Number.isNaN(parsedReminder) ? doc.reminder_days : parsedReminder;
      return api.patch(`/api/documents/${doc.id}`, {
        title: title.trim() || doc.title,
        category,
        note: note.trim() || null,
        expiry_date: expiryDate || null,
        reminder_days: reminder,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      toast.success('Dokument aktualisiert');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={doc ? `Dokument bearbeiten: ${doc.title}` : 'Dokument bearbeiten'}
      open={doc !== null}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!title.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Wird gespeichert…' : 'Speichern'}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        Datei und Zuordnung bleiben unverändert. Eine neue Datei legen Sie als neue Version ab.
      </p>
      <div className="hm-form-grid">
        <Field label="Titel" required span2>
          <input className="hm-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Kategorie">
          <Select
            className="hm-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as DocumentCategory)}
          >
            {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Datei">
          <input className="hm-input" value={doc?.original_name ?? ''} readOnly disabled />
        </Field>
        <Field label="Ablaufdatum" hint="Leer = läuft nicht ab">
          <input className="hm-input" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </Field>
        <Field label="Erinnerung (Tage vor Ablauf)" hint="0 = keine Vorwarnung">
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
