import { useCallback, useEffect, useState } from 'react';

/**
 * Lokale Farbwahl für Abwesenheitsarten im Kalender.
 *
 * Arbeitsplatz-, keine Firmeneinstellung — wie Dashboard-Konfiguration und
 * Spaltenauswahl der Mitarbeiterliste. `absence_types.color` bleibt der für
 * alle geltende Standard (gepflegt unter Abwesenheitsarten); wer hier abweicht,
 * sieht das nur am eigenen Gerät. Deshalb localStorage statt Backend, und
 * deshalb ohne Auswirkung auf Portal, Legende anderer Admins oder Exporte.
 *
 * Gespeichert wird nur die Abweichung (type_id → Hex). Eine Art ohne Eintrag
 * folgt weiterhin dem Standard — ändert die HR die Standardfarbe, kommt das
 * hier automatisch an, solange sie nicht lokal überschrieben ist.
 */
const STORAGE_KEY = 'ohrganize.absenceColors';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type ColorOverrides = Record<number, string>;

export function loadColorOverrides(): ColorOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ColorOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      // Nur, was ein <input type="color"> auch liefert — alles andere (kaputte
      // Einträge, alte Formate) still verwerfen statt den Kalender zu färben.
      if (Number.isInteger(id) && typeof value === 'string' && HEX_COLOR.test(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveColorOverrides(overrides: ColorOverrides): void {
  if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function useColorOverrides() {
  const [overrides, setOverrides] = useState<ColorOverrides>(loadColorOverrides);

  useEffect(() => {
    saveColorOverrides(overrides);
  }, [overrides]);

  const setColor = useCallback((typeId: number, color: string | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (color === null) delete next[typeId];
      else next[typeId] = color;
      return next;
    });
  }, []);

  const resetAll = useCallback(() => setOverrides({}), []);

  return { overrides, setColor, resetAll };
}
