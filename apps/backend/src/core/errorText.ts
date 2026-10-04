/**
 * Text eines gefangenen Fehlers für Meldungen und Log. Ohne Abhängigkeiten,
 * damit auch db/ und die Betreiberwerkzeuge es nutzen dürfen (core/errors.ts
 * zöge zod in deren Bundles).
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
