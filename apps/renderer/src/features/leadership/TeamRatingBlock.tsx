import React from 'react';
import { Trash2 } from 'lucide-react';
import { RATING_SCALES, formatDateTime, type Rating, type RatingCategory, type RatingScaleKey } from '@ohrganize/shared';
import { Badge, Field } from '../../components/ui';
import { RatingInput, RatingValue } from './RatingInput';
import { TeamNotice } from './TeamShared';

/**
 * Ein Bewertungsblock der Maske: Kategorie, Skalenwert, Pflichtkommentar.
 * Reine Anzeige — den Zustand hält die Seite (TeamMemberRatingPage), weil
 * Validierung, Dirty-Schutz und Speichern alle Blöcke zugleich betreffen.
 */

export interface RatingBlock {
  /** Stabiler React-Key; Kategorie-IDs taugen nicht, weil sie wechselbar sind. */
  uid: number;
  category_id: number;
  score: number | null;
  comment: string;
  /** Gespeicherte Bewertung, aus der der Block stammt — solche Blöcke sind nicht entfernbar. */
  saved: Rating | null;
  scoreError?: string;
  commentError?: string;
}

export interface CategoryOption {
  id: number;
  name: string;
}

export function TeamRatingBlock({
  block,
  index,
  scale,
  category,
  options,
  canRemove,
  readOnly,
  onCategoryChange,
  onScoreChange,
  onCommentChange,
  onRemove,
}: {
  block: RatingBlock;
  index: number;
  scale: RatingScaleKey;
  category: RatingCategory | undefined;
  options: CategoryOption[];
  canRemove: boolean;
  readOnly: boolean;
  onCategoryChange: (categoryId: number) => void;
  onScoreChange: (score: number) => void;
  onCommentChange: (comment: string) => void;
  onRemove: () => void;
}) {
  const def = RATING_SCALES[scale];
  const saved = block.saved;
  // Skala nach der Speicherung umgestellt: Der alte Wert passt nicht mehr ins
  // Raster (3 von 5 Sternen ≠ 3 von 10 Punkten) und wird nicht übernommen.
  const scaleChanged = saved !== null && saved.scale !== scale;
  const description =
    category?.description ?? (category?.is_overall === 1 ? 'Grundlage des Satisfaction-Reports.' : null);

  return (
    <div className="lead-block" aria-label={`Bewertungsblock ${index + 1}`}>
      <div className="lead-block__head">
        <div className="row row--wrap" style={{ gap: 10, minWidth: 0 }}>
          <span className="lead-block__label">Kategorie</span>
          <select
            className="hm-select lead-block__select"
            aria-label="Kategorie"
            value={block.category_id}
            // Gespeicherte Blöcke behalten ihre Kategorie: Ein Wechsel legte
            // eine zweite Bewertung an und ließe die alte unberührt stehen.
            disabled={readOnly || saved !== null}
            onChange={(e) => onCategoryChange(Number(e.target.value))}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {saved !== null && <Badge tone="neutral">Version {saved.version}</Badge>}
        </div>
        {canRemove && !readOnly && (
          <button
            type="button"
            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
            aria-label="Bewertungsblock entfernen"
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {description && <div className="lead-block__hint">{description}</div>}

      {scaleChanged && (
        <TeamNotice tone="warning">
          Die Skala wurde seit der letzten Speicherung umgestellt — gespeichert war{' '}
          <RatingValue scale={saved.scale} score={saved.score} size={14} />. Bitte auf der neuen Skala neu bewerten.
        </TeamNotice>
      )}

      {/* Kein <label>-Wrapper (Field): Der wäre mit dem ersten Stern verknüpft
          und ein Klick auf den Text setzte ungewollt „1 von 5“. */}
      <div className="hm-field lead-block__scale">
        <span className="hm-field__label">
          Bewertung <span className="req">*</span>
          <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {def.label}</span>
        </span>
        <RatingInput scale={scale} value={block.score} onChange={onScoreChange} disabled={readOnly} />
        {block.scoreError ? (
          <span className="hm-field__error">{block.scoreError}</span>
        ) : (
          <span className="hm-field__hint">{def.description}</span>
        )}
      </div>

      <Field label="Kommentar" required hint="Pflichtfeld — wird protokolliert" error={block.commentError}>
        <textarea
          className="hm-textarea"
          rows={3}
          value={block.comment}
          disabled={readOnly}
          placeholder="Beobachtungen, Beispiele, Vereinbarungen …"
          onChange={(e) => onCommentChange(e.target.value)}
        />
      </Field>

      {saved !== null && (
        <div className="lead-block__meta">
          Version {saved.version} · zuletzt geändert {formatDateTime(saved.updated_at)} von {saved.updated_by_name ?? '—'}
        </div>
      )}
    </div>
  );
}
