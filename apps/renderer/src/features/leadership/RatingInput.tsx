import React, { useState } from 'react';
import { Star } from 'lucide-react';
import {
  RATING_SCALES,
  scaleLevelLabel,
  scoreTone,
  type RatingScaleKey,
  type ScoreTone,
} from '@ohrganize/shared';
import { Badge, type BadgeTone } from '../../components/ui';

/**
 * Eingabe und Anzeige eines Bewertungswerts — je Skala eine passende Form:
 * Sterne zum Anklicken, Ampel-Pillen, Punkte- bzw. Notenknöpfe. Der Wert ist
 * immer der Rohwert 1…max der Skala (Schulnote: 1 = beste Stufe); die
 * Umrechnung in „gut/mittel/schlecht“ macht scoreTone aus @ohrganize/shared.
 *
 * Farben ausschließlich über Tokens (--rating-star, --success/--warning/
 * --danger, --brand-primary), damit alle vier Themes funktionieren.
 */

export const TONE_BADGE: Record<ScoreTone, BadgeTone> = {
  green: 'green',
  yellow: 'yellow',
  red: 'red',
};

interface InputProps {
  scale: RatingScaleKey;
  value: number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Sterngröße bzw. Knopfhöhe; Standard 26 px für Sterne. */
  size?: number;
}

export function RatingInput({ scale, value, onChange, disabled, size }: InputProps) {
  const def = RATING_SCALES[scale];
  switch (def.kind) {
    case 'stars':
      return <StarInput max={def.max} value={value} onChange={onChange} disabled={disabled} size={size ?? 26} />;
    case 'ampel':
      return <AmpelInput scale={scale} value={value} onChange={onChange} disabled={disabled} />;
    case 'points':
    case 'grade':
      return <ButtonInput scale={scale} value={value} onChange={onChange} disabled={disabled} />;
  }
}

function StarInput({
  max,
  value,
  onChange,
  disabled,
  size,
}: {
  max: number;
  value: number | null;
  onChange: (v: number) => void;
  disabled?: boolean;
  size: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div
      className="lead-stars"
      role="radiogroup"
      aria-label={`Bewertung in Sternen (1 bis ${max})`}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} von ${max} Sternen`}
          className={`lead-star${n <= shown ? ' lead-star--on' : ''}`}
          disabled={disabled}
          onMouseEnter={() => !disabled && setHover(n)}
          onFocus={() => !disabled && setHover(n)}
          onBlur={() => setHover(null)}
          onClick={() => onChange(n)}
        >
          <Star size={size} fill={n <= shown ? 'currentColor' : 'none'} strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}

function AmpelInput({
  scale,
  value,
  onChange,
  disabled,
}: {
  scale: RatingScaleKey;
  value: number | null;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const def = RATING_SCALES[scale];
  // Ampel von Rot nach Grün — so kennt man sie.
  return (
    <div className="lead-ampel" role="radiogroup" aria-label="Ampelbewertung">
      {Array.from({ length: def.max }, (_, i) => i + 1).map((n) => {
        const tone = scoreTone(scale, n);
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-pressed={value === n}
            className={`lead-ampel__btn lead-ampel__btn--${tone}`}
            disabled={disabled}
            onClick={() => onChange(n)}
          >
            <span className={`lead-dot lead-dot--${tone}`} aria-hidden="true" />
            {scaleLevelLabel(scale, n)}
          </button>
        );
      })}
    </div>
  );
}

function ButtonInput({
  scale,
  value,
  onChange,
  disabled,
}: {
  scale: RatingScaleKey;
  value: number | null;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const def = RATING_SCALES[scale];
  return (
    <div className="lead-points" role="radiogroup" aria-label={def.label}>
      {Array.from({ length: def.max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-pressed={value === n}
          aria-label={scaleLevelLabel(scale, n)}
          className={`lead-points__btn lead-points__btn--${scoreTone(scale, n)}`}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
      {def.kind === 'grade' && value !== null && (
        <span className="lead-points__hint">{def.levelLabels?.[value - 1]}</span>
      )}
    </div>
  );
}

/** Nur-Lese-Darstellung eines Werts: Sternreihe, Ampelpunkt mit Text, „7 Punkte“, „Note 2“. */
export function RatingValue({
  scale,
  score,
  size = 16,
}: {
  scale: RatingScaleKey;
  score: number;
  size?: number;
}) {
  const def = RATING_SCALES[scale];
  const tone = scoreTone(scale, score);
  if (def.kind === 'stars') {
    return (
      <span className="lead-stars lead-stars--static" aria-label={scaleLevelLabel(scale, score)}>
        {Array.from({ length: def.max }, (_, i) => i + 1).map((n) => (
          <span key={n} className={`lead-star${n <= score ? ' lead-star--on' : ''}`} aria-hidden="true">
            <Star size={size} fill={n <= score ? 'currentColor' : 'none'} strokeWidth={1.75} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="lead-value">
      <span className={`lead-dot lead-dot--${tone}`} aria-hidden="true" />
      {scaleLevelLabel(scale, score)}
      {def.kind === 'grade' && def.levelLabels ? ` · ${def.levelLabels[score - 1]}` : ''}
    </span>
  );
}

/** Kompaktes Badge in Ampelfarbe — für Tabellen und Listen. */
export function ScoreBadge({ scale, score }: { scale: RatingScaleKey; score: number }) {
  return <Badge tone={TONE_BADGE[scoreTone(scale, score)]}>{scaleLevelLabel(scale, score)}</Badge>;
}
