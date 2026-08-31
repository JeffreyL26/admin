import { z } from 'zod';
import { isValidIsoDate } from './dates.js';

/**
 * Datums-Schema für alle Module: Form UND echte Kalenderprüfung
 * (isValidIsoDate lehnt '2026-02-31' oder '2026-13-05' ab). Ein reiner Regex
 * reicht nicht: Phantasiedaten landen sonst in der DB, verfälschen
 * String-Vergleiche und lassen Datumshelfer wie addDaysIso mit einem
 * RangeError abbrechen — aus einer Admin-Eingabe wird ein 500er (reproduziert
 * bei der Vertragsanlage mit valid_from '2026-02-31').
 */
export const isoDateString = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum im Format JJJJ-MM-TT erwartet' });
