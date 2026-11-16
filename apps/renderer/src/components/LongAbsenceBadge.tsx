import React from 'react';
import { longAbsenceText, type LongAbsence } from '@ohrganize/shared';
import { Badge } from './ui';

/**
 * Zusatz zum Status bei langer Abwesenheit (Elternzeit, Mutterschutz,
 * Langzeitkrank; shared longAbsenceFor): Personalliste, Personalakte und
 * Gehaltsübersicht zeigen ihn gleich. Ohne Zusatz (oder ohne Recht
 * Abwesenheit, dann liefert der Server null) erscheint nichts.
 */
export function LongAbsenceBadge({ absence }: { absence: LongAbsence | null | undefined }) {
  return absence ? <Badge tone="yellow">{longAbsenceText(absence)}</Badge> : null;
}
