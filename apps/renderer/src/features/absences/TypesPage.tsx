import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, ListPlus, Pencil, Trash2 } from 'lucide-react';
import {
  formatDate,
  ABSENCE_CATEGORY_LABELS,
  type AbsenceCategory,
  type AbsenceType,
  type CompanyClosure,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useAbsenceTypes, useClosures } from './api';

interface TypeForm {
  name: string;
  category: AbsenceCategory;
  paid: boolean;
  affects_balance: boolean;
  requires_proof: boolean;
  requires_approval: boolean;
  color: string;
  max_days_per_year: number | null;
  active: boolean;
}

const EMPTY_FORM: TypeForm = {
  name: '',
  category: 'sonder',
  paid: true,
  affects_balance: false,
  requires_proof: false,
  requires_approval: true,
  color: '#0864C6',
  max_days_per_year: null,
  active: true,
};

export function TypesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: types, isLoading } = useAbsenceTypes();
  const [editing, setEditing] = useState<{ id: number | null; form: TypeForm } | null>(null);
  const [deleting, setDeleting] = useState<AbsenceType | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['absences'] });

  const save = useMutation({
    mutationFn: ({ id, form }: { id: number | null; form: TypeForm }) =>
      id === null ? api.post('/api/absences/types', form) : api.put(`/api/absences/types/${id}`, form),
    onSuccess: () => {
      invalidate();
      toast.success('Abwesenheitsart gespeichert');
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/absences/types/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Abwesenheitsart gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Abwesenheitsarten"
        subtitle="Arten, Regeln und Betriebsruhetage konfigurieren."
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => setEditing({ id: null, form: { ...EMPTY_FORM } })}
          >
            <ListPlus size={16} /> Neue Art
          </button>
        }
      />
      <div className="stack">
        <Card flush>
          {isLoading ? (
            <Spinner center />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kategorie</th>
                    <th>Eigenschaften</th>
                    <th className="num">Max. Tage/Jahr</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(types ?? []).map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <span
                            style={{ width: 13, height: 13, borderRadius: 4, background: t.color, display: 'inline-block', flexShrink: 0 }}
                          />
                          <strong>{t.name}</strong>
                        </span>
                      </td>
                      <td>{ABSENCE_CATEGORY_LABELS[t.category]}</td>
                      <td>
                        <span className="row row--wrap" style={{ gap: 5 }}>
                          <Badge tone={t.paid === 1 ? 'green' : 'neutral'}>{t.paid === 1 ? 'bezahlt' : 'unbezahlt'}</Badge>
                          {t.affects_balance === 1 && <Badge tone="blue">saldowirksam</Badge>}
                          {t.requires_proof === 1 && <Badge tone="yellow">Nachweis</Badge>}
                          {t.requires_approval === 1 && <Badge tone="navy">Genehmigung</Badge>}
                        </span>
                      </td>
                      <td className="num">{t.max_days_per_year ?? '—'}</td>
                      <td>{t.active === 1 ? <Badge tone="green">aktiv</Badge> : <Badge tone="neutral">deaktiviert</Badge>}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button
                            className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                            aria-label="Bearbeiten"
                            onClick={() =>
                              setEditing({
                                id: t.id,
                                form: {
                                  name: t.name,
                                  category: t.category,
                                  paid: t.paid === 1,
                                  affects_balance: t.affects_balance === 1,
                                  requires_proof: t.requires_proof === 1,
                                  requires_approval: t.requires_approval === 1,
                                  color: t.color,
                                  max_days_per_year: t.max_days_per_year,
                                  active: t.active === 1,
                                },
                              })
                            }
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                            aria-label="Löschen"
                            onClick={() => setDeleting(t)}
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

        <ClosuresCard />
      </div>

      <TypeDialog
        state={editing}
        onClose={() => setEditing(null)}
        onSave={(id, form) => save.mutate({ id, form })}
        saving={save.isPending}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Abwesenheitsart löschen"
        message={
          deleting
            ? `Die Art "${deleting.name}" wird gelöscht. Wird sie bereits verwendet, schlägt das Löschen fehl — deaktivieren Sie sie dann stattdessen über "Bearbeiten".`
            : ''
        }
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function TypeDialog({
  state,
  onClose,
  onSave,
  saving,
}: {
  state: { id: number | null; form: TypeForm } | null;
  onClose: () => void;
  onSave: (id: number | null, form: TypeForm) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<TypeForm>(EMPTY_FORM);
  const [key, setKey] = useState<string | null>(null);
  // Formular beim Öffnen mit den Werten des Dialog-Ziels initialisieren.
  const stateKey = state === null ? null : `${state.id ?? 'neu'}`;
  if (stateKey !== key) {
    setKey(stateKey);
    if (state) setForm(state.form);
  }
  if (!state) return null;

  const set = (patch: Partial<TypeForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Modal
      title={state.id === null ? 'Neue Abwesenheitsart' : 'Abwesenheitsart bearbeiten'}
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={saving || form.name.trim().length === 0}
            onClick={() => onSave(state.id, { ...form, name: form.name.trim() })}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2>
          <input className="hm-input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Kategorie" required>
          <select
            className="hm-select"
            value={form.category}
            onChange={(e) => set({ category: e.target.value as AbsenceCategory })}
          >
            {Object.entries(ABSENCE_CATEGORY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Farbe">
          <input
            className="hm-input"
            type="color"
            value={form.color}
            onChange={(e) => set({ color: e.target.value })}
            style={{ padding: 3, height: 36 }}
          />
        </Field>
        <Field label="Max. Tage pro Jahr" hint="Leer lassen für unbegrenzt">
          <input
            className="hm-input"
            type="number"
            min={0.5}
            step={0.5}
            value={form.max_days_per_year ?? ''}
            onChange={(e) => set({ max_days_per_year: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </Field>
        <div className="hm-field">
          <span className="hm-field__label">Eigenschaften</span>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.paid} onChange={(e) => set({ paid: e.target.checked })} />
            bezahlt
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.affects_balance} onChange={(e) => set({ affects_balance: e.target.checked })} />
            saldowirksam (zählt gegen Urlaubsanspruch)
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.requires_proof} onChange={(e) => set({ requires_proof: e.target.checked })} />
            Nachweis erforderlich
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.requires_approval} onChange={(e) => set({ requires_approval: e.target.checked })} />
            genehmigungspflichtig
          </label>
          <label className="hm-checkbox">
            <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
            aktiv
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ClosuresCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: closures, isLoading } = useClosures();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [deleting, setDeleting] = useState<CompanyClosure | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/api/absences/closures', { name: name.trim(), date_from: from, date_to: to }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('Betriebsruhe angelegt');
      setName('');
      setFrom('');
      setTo('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/absences/closures/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('Betriebsruhe gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card title="Betriebsruhetage" flush>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Bezeichnung">
            <input
              className="hm-input"
              style={{ width: 220 }}
              value={name}
              placeholder="z. B. Zwischen den Jahren"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Von">
            <input className="hm-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Bis">
            <input className="hm-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button
            className="hm-btn hm-btn--secondary"
            disabled={!name.trim() || !from || !to || to < from || create.isPending}
            onClick={() => create.mutate()}
          >
            Anlegen
          </button>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 8 }}>
          Betriebsruhetage werden bei der Berechnung der Abwesenheitstage nicht mitgezählt.
        </div>
      </div>
      {isLoading ? (
        <Spinner center />
      ) : !closures || closures.length === 0 ? (
        <EmptyState icon={<CalendarOff size={40} />} title="Keine Betriebsruhetage hinterlegt" />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th>Zeitraum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {closures.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    {formatDate(c.date_from)} – {formatDate(c.date_to)}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="hm-btn hm-btn--sm hm-btn--ghost hm-btn--icon"
                        aria-label="Löschen"
                        onClick={() => setDeleting(c)}
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
      <ConfirmDialog
        open={deleting !== null}
        title="Betriebsruhe löschen"
        message={deleting ? `"${deleting.name}" (${formatDate(deleting.date_from)} – ${formatDate(deleting.date_to)}) löschen? Bereits berechnete Anträge bleiben unverändert.` : ''}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
