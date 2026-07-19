import React from 'react';
import { AUDIENCE_TYPE_LABELS, type AudienceType } from '@hrmonic/shared';
import { Field } from '../../components/ui';
import { useOrg } from './api';

export interface AudienceValue {
  audience_type: AudienceType;
  audience_id: number | null;
}

/**
 * Kaskadierende Zielgruppen-Auswahl (einheitliches Muster des Moduls):
 * erst der Typ (alle/abteilung/team/standort), dann die konkrete Einheit.
 */
export function AudienceSelect({
  value,
  onChange,
}: {
  value: AudienceValue;
  onChange: (v: AudienceValue) => void;
}) {
  const { data: org } = useOrg();

  const entities =
    value.audience_type === 'abteilung'
      ? org?.departments
      : value.audience_type === 'team'
        ? org?.teams
        : value.audience_type === 'standort'
          ? org?.locations
          : undefined;

  return (
    <>
      <Field label="Zielgruppe" required>
        <select
          className="hm-select"
          value={value.audience_type}
          onChange={(e) =>
            onChange({ audience_type: e.target.value as AudienceType, audience_id: null })
          }
        >
          {(Object.keys(AUDIENCE_TYPE_LABELS) as AudienceType[]).map((t) => (
            <option key={t} value={t}>
              {AUDIENCE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {value.audience_type !== 'alle' && (
        <Field label={AUDIENCE_TYPE_LABELS[value.audience_type]} required>
          <select
            className="hm-select"
            value={value.audience_id ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                audience_id: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            <option value="">— auswählen —</option>
            {(entities ?? []).map((ent) => (
              <option key={ent.id} value={ent.id}>
                {ent.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}

/** Kompakte Anzeige einer Zielgruppe (für Listen). */
export function audienceLabel(v: {
  audience_type: AudienceType;
  audience_name: string | null;
}): string {
  if (v.audience_type === 'alle') return AUDIENCE_TYPE_LABELS.alle;
  return `${AUDIENCE_TYPE_LABELS[v.audience_type]}: ${v.audience_name ?? '—'}`;
}
