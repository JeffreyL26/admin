/**
 * Welche Lizenz einer Instanz gilt, in zwei Bedeutungen:
 *
 *   - ausgestellt (issued): die zuletzt ausgestellte, nicht zurueckgezogene
 *     Datei. Vorlage fuer `verlaengern`, Ziel von `lizenz eingespielt`.
 *   - laufend (running): die Datei auf der Instanz. Belegt durch den letzten
 *     Bericht oder Vermerk (`instanzen.laufende_lizenz`), sonst die zuletzt
 *     eingespielte, sonst die des laufenden Zeitraums. Daran haengen
 *     Ablaufwarnung und `faellig`.
 *
 * Beide fallen auseinander, solange eine neue Datei nicht eingespielt ist,
 * und nach einem Restore, der eine alte Datei zurueckbringt (der
 * Dateiwaechter des Servers prueft keine Reihenfolge). check, faellig,
 * uebersicht, html, verlaengern und `lizenz eingespielt` fragen alle hier.
 */
import { todayIsoLocal } from '@ohrganize/shared';
import { ConspectusError, openRegister } from './db.js';

export interface LizenzRow {
  license_id: string;
  kunde_id: string;
  instanz_id: string | null;
  kid: string | null;
  v: number;
  kind: string;
  edition: string | null;
  land: string | null;
  features: string | null;
  billing: string | null;
  interval: string | null;
  installation_id: string | null;
  ausgestellt_am: string;
  ausgestellt_um: string | null;
  gueltig_ab: string;
  gueltig_bis: string;
  unbefristet: number;
  plaetze: number | null;
  datei: string | null;
  eingespielt_am: string | null;
  zurueckgezogen_am: string | null;
  notiz: string | null;
}

// rowid nur fuer Altbestand ohne ausgestellt_um.
const ISSUE_ORDER = 'ausgestellt_am DESC, ausgestellt_um DESC, rowid DESC';

export interface InstanceLicenses {
  /** null, wenn alle zurueckgezogen sind und die Instanz trotzdem eine meldet. */
  issued: LizenzRow | null;
  running: LizenzRow;
  /** Gemeldete Lizenznummer, die fuer diese Instanz nicht im Register steht. */
  unknownReported: string | null;
}

export function instanceLicenses(instanceId?: string): Map<string, InstanceLicenses> {
  const { db } = openRegister();
  const rows = (
    instanceId === undefined
      ? db.prepare(`SELECT * FROM lizenzen WHERE instanz_id IS NOT NULL ORDER BY ${ISSUE_ORDER}`).all()
      : db.prepare(`SELECT * FROM lizenzen WHERE instanz_id = ? ORDER BY ${ISSUE_ORDER}`).all(instanceId)
  ) as LizenzRow[];
  const reported = new Map(
    (
      (instanceId === undefined
        ? db.prepare('SELECT id, laufende_lizenz FROM instanzen').all()
        : db.prepare('SELECT id, laufende_lizenz FROM instanzen WHERE id = ?').all(instanceId)) as {
        id: string;
        laufende_lizenz: string | null;
      }[]
    ).map((i) => [i.id, i.laufende_lizenz]),
  );
  const byInstance = new Map<string, LizenzRow[]>();
  for (const r of rows) {
    const list = byInstance.get(r.instanz_id as string);
    if (list) list.push(r);
    else byInstance.set(r.instanz_id as string, [r]);
  }
  const today = todayIsoLocal();
  const result = new Map<string, InstanceLicenses>();
  for (const [id, list] of byInstance) {
    const active = list.filter((r) => r.zurueckgezogen_am === null);
    const reportedId = reported.get(id) ?? null;
    const reportedRow = reportedId === null ? undefined : list.find((r) => r.license_id === reportedId);
    // Alles zurueckgezogen, aber gemeldet: Die Instanz bleibt sichtbar, sonst
    // hiesse es "keine Lizenz", waehrend eine zurueckgezogene laeuft.
    const running =
      reportedRow ??
      active.find((r) => r.eingespielt_am !== null) ??
      active.find((r) => r.gueltig_ab <= today) ??
      active[0];
    if (!running) continue;
    result.set(id, {
      issued: active[0] ?? null,
      running,
      unknownReported: reportedId !== null && !reportedRow ? reportedId : null,
    });
  }
  return result;
}

/**
 * Die Lizenz, deren Ende fuer Ablaufwarnung, faellig und Uebersicht zaehlt:
 * die laufende. War die ausgestellte schon eingespielt, meldet die Instanz
 * aber eine andere (Restore oder ein aelterer Bericht zuletzt eingelesen), ist
 * offen, welche wirklich laeuft; dann zaehlt das fruehere Ende, damit es nicht
 * verdeckt wird.
 */
export function expiringLicense(licenses: InstanceLicenses): LizenzRow {
  const { issued, running } = licenses;
  if (!issued || issued === running || issued.eingespielt_am === null || issued.unbefristet === 1) return running;
  if (running.unbefristet === 1) return issued;
  return issued.gueltig_bis < running.gueltig_bis ? issued : running;
}

export function currentLicense(instanceId: string): LizenzRow | undefined {
  return instanceLicenses(instanceId).get(instanceId)?.issued ?? undefined;
}

/**
 * Vermerkt eine Lizenz als eingespielt und als laufend. Ein bestehender
 * Vermerk behaelt sein Datum. Vorgabe fuer `day` ist der lokale Kalendertag
 * wie bei `ausgestellt_am`, sonst laege der Vermerk nachts vor der
 * Ausstellung.
 *
 * Es gilt der zuletzt eingelesene Beleg, ohne Abgleich von Zeitstempeln: Wer
 * einen aelteren Bericht nach einem neueren einliest, sieht in `check` die
 * Abweichung ("Restore?") und liest den neueren noch einmal ein.
 */
export function markInstalled(instanceId: string, licenseId: string, day: string = todayIsoLocal()): void {
  const { db } = openRegister();
  db.transaction(() => {
    db.prepare(
      'UPDATE lizenzen SET eingespielt_am = ? WHERE license_id = ? AND instanz_id = ? AND eingespielt_am IS NULL',
    ).run(day, licenseId, instanceId);
    db.prepare('UPDATE instanzen SET laufende_lizenz = ? WHERE id = ?').run(licenseId, instanceId);
  })();
}

/**
 * Lokaler Kalendertag eines Berichtszeitpunkts (`generated_at`), hoechstens
 * heute; null, wenn er fehlt oder nicht lesbar ist.
 */
export function reportDay(generatedAt: string | null): string | null {
  if (!generatedAt) return null;
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = todayIsoLocal();
  return day < today ? day : today;
}

/** Lizenz ueber den Anfang ihrer Nummer finden, wie ihn die Ausgaben zeigen (8 Zeichen). */
export function findLicense(prefix: string, instanceId?: string): LizenzRow {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(p)) {
    throw new ConspectusError(`"${prefix}" ist keine Lizenznummer (mindestens die 8 Zeichen aus der Ausgabe).`);
  }
  const { db } = openRegister();
  const rows = (
    instanceId === undefined
      ? db.prepare("SELECT * FROM lizenzen WHERE license_id LIKE ? || '%'").all(p)
      : db.prepare("SELECT * FROM lizenzen WHERE license_id LIKE ? || '%' AND instanz_id = ?").all(p, instanceId)
  ) as LizenzRow[];
  if (rows.length === 0) {
    throw new ConspectusError(`Keine Lizenz ${p} im Register${instanceId ? ` fuer "${instanceId}"` : ''}.`);
  }
  if (rows.length > 1) throw new ConspectusError(`"${p}" passt auf ${rows.length} Lizenzen; bitte mehr Zeichen angeben.`);
  return rows[0];
}
