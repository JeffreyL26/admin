import { useEffect, useState } from 'react';

/**
 * Entprellter Wert für Sucheingaben: Der Rückgabewert folgt `value` erst nach
 * einer Tipppause. Gemeinsamer Baustein für CommandPalette, DirectoryPage und
 * EmployeeListPage — vorher existierte der Hook dort als driftende Kopien mit
 * unterschiedlichen Delays.
 */
export function useDebounced(value: string, delayMs = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
