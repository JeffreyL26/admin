import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  RATING_SCALES,
  RATING_SCALE_KEYS,
  type RatingCategory,
  type RatingScaleKey,
} from '@ohrganize/shared';
import { Badge, Card, EmptyState, Field, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import {
  useCreateCategory,
  useDeleteCategory,
  useLeadershipSettings,
  useRatingCategories,
  useReorderCategories,
  useUpdateCategory,
} from './api';
import { SetupNote, errorMessage } from './SetupShared';

/**
 * Reiter „Kategorien“: zentrale Bewertungskategorien für alle Führungskräfte.
 * Die Gesamtbewertung ist fest (Grundlage des Reports) und steht immer oben;
 * alles andere ist umbenenn-, sortier-, deaktivier- und (ohne Bewertungen)
 * löschbar.
 */
export function SetupCategoriesTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data: categories, isLoading, error } = useRatingCategories();
  const { data: settings } = useLeadershipSettings();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const reorder = useReorderCategories();
  const [dialog, setDialog] = useState<{ open: boolean; category: RatingCategory | null }>({
    open: false,
    category: null,
  });
  const [deleting, setDeleting] = useState<RatingCategory | null>(null);

  const uniform = settings ? settings.uniform_scale === 1 : true;
  const busy = update.isPending || remove.isPending || reorder.isPending;

  const onError = (fallback: string) => (e: unknown) => toast.error(errorMessage(e, fallback));

  const toggleActive = (c: RatingCategory) =>
    update.mutate(
      { id: c.id, patch: { active: c.active !== 1 } },
      {
        onSuccess: () => toast.success(c.active === 1 ? 'Kategorie deaktiviert' : 'Kategorie aktiviert'),
        onError: onError('Änderung fehlgeschlagen'),
      },
    );

  const setScale = (c: RatingCategory, scale: RatingScaleKey | null) =>
    update.mutate(
      { id: c.id, patch: { scale } },
      {
        onSuccess: () => toast.success('Skala gespeichert'),
        onError: onError('Skala konnte nicht gespeichert werden'),
      },
    );

  /**
   * Nachbartausch in der sortierten Liste; gesendet wird die KOMPLETTE
   * ID-Liste (Backend-Kontrakt). Die Gesamtbewertung steht an Index 0 und
   * bleibt dort: der Server sortiert sie ohnehin immer nach vorn.
   */
  const move = (index: number, delta: -1 | 1) => {
    if (!categories) return;
    const target = index + delta;
    if (target < 1 || target >= categories.length || index < 1) return;
    const ids = categories.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids, { onError: onError('Reihenfolge konnte nicht gespeichert werden') });
  };

  return (
    <div className="stack">
      <SetupNote>
        Kategorien gelten <strong>zentral für alle Führungskräfte</strong>: Was Sie hier anlegen, steht sofort in
        jeder Bewertungsmaske zur Wahl. Die <strong>Gesamtbewertung</strong> ist fest: Sie ist die Grundlage
        des Satisfaction-Reports und steht immer an erster Stelle. Kategorien mit vorhandenen Bewertungen
        lassen sich nicht löschen, aber deaktivieren: Sie verschwinden dann aus der Auswahl, das Protokoll
        bleibt nachvollziehbar.
      </SetupNote>

      <Card
        title="Bewertungskategorien"
        flush
        actions={
          canEdit ? (
            <button
              type="button"
              className="hm-btn hm-btn--primary hm-btn--sm"
              onClick={() => setDialog({ open: true, category: null })}
            >
              <Plus size={15} /> Kategorie hinzufügen
            </button>
          ) : undefined
        }
      >
        {error && !categories ? (
          <SetupNote tone="warning">
            Kategorien konnten nicht geladen werden: {errorMessage(error, 'Server nicht erreichbar')}
          </SetupNote>
        ) : isLoading || !categories ? (
          <Spinner center />
        ) : categories.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={40} />}
            title="Keine Kategorien vorhanden"
            hint="Legen Sie die erste Kategorie an, z. B. „Pünktlichkeit“ oder „Fachliche Kompetenz“."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Reihenfolge</th>
                  <th>Kategorie</th>
                  <th style={{ width: 220 }}>Skala</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 120 }}>Bewertungen</th>
                  {canEdit && <th style={{ width: 230 }} />}
                </tr>
              </thead>
              <tbody>
                {categories.map((c, index) => {
                  const overall = c.is_overall === 1;
                  const count = c.rating_count ?? 0;
                  return (
                    <tr key={c.id}>
                      <td>
                        {overall ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>fest</span>
                        ) : (
                          <span className="lead-order">
                            <button
                              type="button"
                              className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                              aria-label={`${c.name} nach oben`}
                              disabled={!canEdit || busy || index <= 1}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              type="button"
                              className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                              aria-label={`${c.name} nach unten`}
                              disabled={!canEdit || busy || index >= categories.length - 1}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown size={14} />
                            </button>
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          {c.description || '—'}
                        </div>
                      </td>
                      <td>
                        <ScaleCell
                          category={c}
                          uniform={uniform}
                          defaultScale={settings?.scale ?? c.effective_scale}
                          canEdit={canEdit}
                          busy={busy}
                          onChange={(scale) => setScale(c, scale)}
                        />
                      </td>
                      <td>
                        {overall ? (
                          <Badge tone="navy">Gesamtbewertung</Badge>
                        ) : c.active === 1 ? (
                          <Badge tone="green">Aktiv</Badge>
                        ) : (
                          <Badge tone="neutral">Inaktiv</Badge>
                        )}
                      </td>
                      <td>
                        {count}{' '}
                        <span style={{ color: 'var(--text-muted)' }}>{count === 1 ? 'Bewertung' : 'Bewertungen'}</span>
                      </td>
                      {canEdit && (
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                            {!overall && (
                              <button
                                type="button"
                                className="hm-btn hm-btn--sm hm-btn--ghost"
                                disabled={busy}
                                onClick={() => toggleActive(c)}
                              >
                                {c.active === 1 ? 'Deaktivieren' : 'Aktivieren'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                              aria-label={`Kategorie ${c.name} bearbeiten`}
                              disabled={busy}
                              onClick={() => setDialog({ open: true, category: c })}
                            >
                              <Pencil size={15} />
                            </button>
                            {!overall && (
                              <Tooltip
                                content={
                                  count > 0 ? (
                                    <>
                                      <div className="hm-tooltip__title">Nicht löschbar</div>
                                      <div className="hm-tooltip__line">
                                        {count} {count === 1 ? 'Bewertung' : 'Bewertungen'} vorhanden · stattdessen
                                        deaktivieren
                                      </div>
                                    </>
                                  ) : null
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                                    aria-label={`Kategorie ${c.name} löschen`}
                                    disabled={busy || count > 0}
                                    onClick={() => setDeleting(c)}
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                </span>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CategoryDialog
        open={dialog.open}
        category={dialog.category}
        onClose={() => setDialog({ open: false, category: null })}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Kategorie „${deleting?.name ?? ''}“ löschen?`}
        message="Die Kategorie wird entfernt und steht in keiner Bewertungsmaske mehr zur Wahl. Das ist nur möglich, solange keine Bewertungen dazu existieren."
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => toast.success('Kategorie gelöscht'),
            // 409 (bereits bewertet / Gesamtbewertung) kommt mit Erklärung vom Server.
            onError: onError('Löschen fehlgeschlagen'),
          })
        }
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skalen-Zelle
// ---------------------------------------------------------------------------

function ScaleCell({
  category,
  uniform,
  defaultScale,
  canEdit,
  busy,
  onChange,
}: {
  category: RatingCategory;
  uniform: boolean;
  defaultScale: RatingScaleKey;
  canEdit: boolean;
  busy: boolean;
  onChange: (scale: RatingScaleKey | null) => void;
}) {
  const label = RATING_SCALES[category.effective_scale].label;
  if (uniform || !canEdit) {
    return (
      <div className="stack" style={{ gap: 3 }}>
        <span>
          <Badge tone="blue">{label}</Badge>
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {uniform ? 'zentral (Skala & Zeitraum)' : category.scale ? 'eigene Skala' : 'Standard'}
        </span>
      </div>
    );
  }
  // uniform_scale = 0: jede Kategorie darf eine eigene Skala tragen.
  return (
    <select
      className="hm-select"
      aria-label={`Skala für ${category.name}`}
      value={category.scale ?? ''}
      disabled={busy}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as RatingScaleKey))}
    >
      <option value="">Standard ({RATING_SCALES[defaultScale].label})</option>
      {RATING_SCALE_KEYS.map((k) => (
        <option key={k} value={k}>
          {RATING_SCALES[k].label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Dialog: anlegen / bearbeiten
// ---------------------------------------------------------------------------

function CategoryDialog({
  open,
  category,
  onClose,
}: {
  open: boolean;
  category: RatingCategory | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setDescription(category?.description ?? '');
  }, [open, category]);

  const pending = create.isPending || update.isPending;
  const body = { name: name.trim(), description: description.trim() || null };

  const submit = () => {
    if (!body.name) return;
    if (category) {
      update.mutate(
        { id: category.id, patch: body },
        {
          onSuccess: () => {
            toast.success('Kategorie gespeichert');
            onClose();
          },
          onError: (e) => toast.error(errorMessage(e, 'Speichern fehlgeschlagen')),
        },
      );
    } else {
      create.mutate(body, {
        onSuccess: (res) => {
          toast.success(`Kategorie „${res.category.name}“ angelegt. Ab sofort für alle Führungskräfte wählbar.`);
          onClose();
        },
        onError: (e) => toast.error(errorMessage(e, 'Anlegen fehlgeschlagen')),
      });
    }
  };

  return (
    <Modal
      title={category ? `Kategorie bearbeiten: ${category.name}` : 'Kategorie hinzufügen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className="hm-btn hm-btn--primary"
            disabled={!body.name || pending}
            onClick={submit}
          >
            {category ? 'Speichern' : 'Anlegen'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2 hint="Muss eindeutig sein. Erscheint als Überschrift des Bewertungsblocks.">
          <input
            className="hm-input"
            value={name}
            maxLength={80}
            placeholder="z. B. Pünktlichkeit"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Beschreibung" span2 hint="Worauf soll die Führungskraft bei dieser Kategorie achten?">
          <textarea
            className="hm-textarea"
            rows={3}
            value={description}
            maxLength={300}
            placeholder="z. B. Einhaltung von Arbeitszeiten und Terminen"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {category?.is_overall === 1 && (
          <div className="span-2">
            <SetupNote>
              Die Gesamtbewertung lässt sich umbenennen und beschreiben, aber weder deaktivieren noch löschen:
              Sie ist die Grundlage des Reports.
            </SetupNote>
          </div>
        )}
      </div>
    </Modal>
  );
}
