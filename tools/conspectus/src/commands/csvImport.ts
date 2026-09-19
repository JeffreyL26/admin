/**
 * CSV-Import: Kundenliste und Zahlungen aus der Buchhaltung uebernehmen.
 *
 * Semikolon als Trennzeichen und ein BOM am Anfang werden erwartet: Das ist
 * das Format, das Excel in deutscher Einstellung schreibt, und aus Excel
 * kommen diese Listen.
 */
import fs from 'node:fs';
import type { Args } from '../args.js';
import { ConspectusError, openRegister } from '../db.js';
import { readTextFile } from '../textfile.js';
import { assertKey } from './kunde.js';

/** Sehr kleiner CSV-Leser: Semikolon, Anfuehrungszeichen, doppelte darin. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ';') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function spalten(kopf: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  kopf.forEach((name, i) => {
    map[name.trim().toLowerCase()] = i;
  });
  return map;
}

/** Betrag "1.234,56" oder "1234.56" nach Cent. */
export function betragNachCent(raw: string): number | null {
  const s = raw.trim().replace(/\s|€|EUR/gi, '');
  if (!s) return null;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normal);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

export function csvImportCommand(was: string, args: Args): void {
  const { db } = openRegister();
  const datei = args.positional[0] ?? args.values.datei;
  if (!datei) throw new ConspectusError(`Aufruf: conspectus csv-import ${was} <datei.csv>`);
  if (!fs.existsSync(datei)) throw new ConspectusError(`${datei} existiert nicht.`);
  const rows = parseCsv(readTextFile(datei));
  if (rows.length < 2) throw new ConspectusError('Die Datei hat keine Datenzeilen (Kopfzeile erwartet).');
  const idx = spalten(rows[0]);

  if (was === 'kunden') {
    const need = ['id', 'name'];
    for (const n of need) {
      if (idx[n] === undefined) {
        throw new ConspectusError(`Die Kopfzeile braucht die Spalte "${n}" (vorhanden: ${rows[0].join(', ')}).`);
      }
    }
    const insert = db.prepare(
      `INSERT INTO kunden (id, name, kontakt, email, notiz) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
         kontakt = COALESCE(excluded.kontakt, kunden.kontakt),
         email = COALESCE(excluded.email, kunden.email)`,
    );
    let n = 0;
    db.transaction(() => {
      for (const r of rows.slice(1)) {
        const id = (r[idx.id] ?? '').trim().toLowerCase();
        if (!id) continue;
        assertKey(id, 'Kundenschluessel');
        insert.run(
          id,
          (r[idx.name] ?? id).trim(),
          idx.kontakt !== undefined ? r[idx.kontakt]?.trim() || null : null,
          idx.email !== undefined ? r[idx.email]?.trim() || null : null,
          idx.notiz !== undefined ? r[idx.notiz]?.trim() || null : null,
        );
        n++;
      }
    })();
    console.log(`${n} Kunde(n) uebernommen.`);
    return;
  }

  if (was === 'zahlungen') {
    for (const n of ['kunde', 'datum', 'betrag']) {
      if (idx[n] === undefined) {
        throw new ConspectusError(`Die Kopfzeile braucht die Spalte "${n}" (vorhanden: ${rows[0].join(', ')}).`);
      }
    }
    const insert = db.prepare(
      "INSERT INTO vorgaenge (kunde_id, art, datum, betrag_cent, waehrung, beleg, text) VALUES (?, 'zahlung', ?, ?, ?, ?, ?)",
    );
    let n = 0;
    const unbekannt = new Set<string>();
    db.transaction(() => {
      for (const r of rows.slice(1)) {
        const kunde = (r[idx.kunde] ?? '').trim().toLowerCase();
        if (!kunde) continue;
        const bekannt = db.prepare('SELECT 1 FROM kunden WHERE id = ?').get(kunde);
        if (!bekannt) {
          unbekannt.add(kunde);
          continue;
        }
        insert.run(
          kunde,
          (r[idx.datum] ?? '').trim(),
          betragNachCent(r[idx.betrag] ?? ''),
          idx.waehrung !== undefined ? r[idx.waehrung]?.trim() || 'EUR' : 'EUR',
          idx.beleg !== undefined ? r[idx.beleg]?.trim() || null : null,
          idx.text !== undefined ? r[idx.text]?.trim() || null : null,
        );
        n++;
      }
    })();
    console.log(`${n} Zahlung(en) uebernommen.`);
    if (unbekannt.size > 0) {
      // Nicht still ueberspringen: Eine Zahlung auf einen unbekannten Kunden
      // ist entweder ein Tippfehler oder ein fehlender Registereintrag.
      console.warn(`Uebersprungen, Kunde nicht im Register: ${[...unbekannt].join(', ')}`);
    }
    return;
  }

  throw new ConspectusError(`Unbekannter Import "${was}". Bekannt: kunden, zahlungen.`);
}

/** Einzelne Zahlung erfassen, ohne CSV. */
export function zahlungCommand(args: Args): void {
  const { db } = openRegister();
  const kunde = args.values.kunde ?? args.positional[0];
  if (!kunde) throw new ConspectusError('Aufruf: conspectus zahlung <kunde> --betrag 1190,00 [--datum 2026-09-15] [--beleg RE-1234]');
  const bekannt = db.prepare('SELECT 1 FROM kunden WHERE id = ?').get(kunde);
  if (!bekannt) throw new ConspectusError(`Kunde "${kunde}" ist nicht im Register.`);
  const betrag = betragNachCent(args.values.betrag ?? '');
  if (betrag === null) throw new ConspectusError('--betrag fehlt oder ist keine Zahl (Beispiel: --betrag 1190,00).');
  const datum = args.values.datum ?? new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO vorgaenge (kunde_id, art, datum, betrag_cent, waehrung, beleg, text) VALUES (?, 'zahlung', ?, ?, ?, ?, ?)",
  ).run(kunde, datum, betrag, args.values.waehrung ?? 'EUR', args.values.beleg ?? null, args.values.text ?? null);
  console.log(`Zahlung erfasst: ${kunde}, ${(betrag / 100).toFixed(2)} ${args.values.waehrung ?? 'EUR'}, ${datum}`);
}
