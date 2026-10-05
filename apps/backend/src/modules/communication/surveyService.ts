import { randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { clearWalSoon, getDb, inTransaction } from '../../db/db.js';
import { assertSecureDelete } from '../../db/secureDelete.js';
import { rebuildTableInKeyOrder } from '../../db/rebuildTable.js';
import { REBUILD_STATE_TABLE } from '../../db/migrations/500_communication.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import type { AudienceType } from './audience.js';
import { errorText } from '../../core/errorText.js';
import { todayIso } from '../../core/dates.js';

/**
 * Teilnahme an Umfragen, gemeinsam fuer die HR-Testerfassung
 * (POST /api/communication/surveys/:id/responses) und das Portal
 * (POST /api/me/surveys/:id/responses). Es gibt genau EINE Pruefung der
 * Antworten und EINEN Schreibpfad, sonst liesse die eine Seite Werte durch,
 * an denen die Auswertung der anderen scheitert.
 *
 * ANONYMITAET: Die Teilnahme wird in survey_participations markiert (Dedup
 * und Quote), die Antworten landen OHNE employee_id, OHNE Zeitstempel und
 * unter ZUFAELLIGER ID in survey_responses (Migration 502_survey_anonymity).
 * Beide Zeilen entstehen in derselben Transaktion; eine fortlaufende ID oder
 * ein Zeitstempel an der Antwort machte sie ueber die Reihenfolge der
 * Teilnahmen wieder zuordenbar. Aus demselben Grund schreibt jede Teilnahme
 * die Nachbarn der neuen Antwort gemischt neu (storeAnonymousResponse) und
 * leert danach das -wal. Deshalb wird hier auch nicht auditiert.
 */

interface ResponseRow {
  id: number;
  survey_id: number;
  answers: string;
}

/**
 * Antwort-IDs liegen in [1, RESPONSE_ID_LIMIT). Derselbe Bereich gilt fuer
 * Migration 503 und den Seed; an einer abweichenden Groesse liessen sich
 * Antworten verschiedener Herkunft trennen.
 */
export const RESPONSE_ID_LIMIT = 2 ** 48;

/**
 * Ab einem Achtel der Seitengroesse fasst eine Seite nur noch wenige Zeilen.
 * Dann haengt fast jede Teilnahme EINE Seite am Dateiende an, und die geht an
 * eine zufaellige Zeile der Nachbarschaft, also an eine mit aehnlicher ID wie
 * die der neuen Antwort. Wer die Seiten nach ihrer Nummer ordnet, grenzt die
 * juengsten Teilnehmer so auf rund 21 Antworten ein (gemessen an 400 bis 1200
 * Antworten zu 0,7 bis 2,5 KB: Trefferquote 40 bis 76 Prozent gegen 2 bis 10
 * Prozent bei Zufall; bei 300 Byte, mit ueber 40 Zeilen je Seite, trat es nicht
 * auf). Das Umschreiben der Nachbarn mischt nur Zellen INNERHALB der Seiten und
 * die Zuordnung Zeile zu Seite unter den Nachbarn, nicht die Vergabe der neuen
 * Seite. Deshalb nimmt eine grosse Antwort (oder grosse Nachbarn) eine
 * Stichprobe zufaelliger Antworten aus der ganzen Tabelle in das gemischte
 * Neuschreiben auf: Die angehaengte Seite gehoert dann einer beliebigen Zeile
 * der Stichprobe, die neue Antwort verraet nur noch, dass sie unter rund
 * REWRITE_SAMPLE_ROWS liegt (gemessen: Trefferquote wie bei Zufall).
 */
const FULL_REWRITE_DIVISOR = 8;

/**
 * Zeilen der Stichprobe (siehe oben): Anonymitaetsmenge UND Obergrenze der
 * Kosten je Teilnahme. Die ganze Tabelle neu zu schreiben wuchs mit der Umfrage
 * (gemessen, verschluesselt: 41 ms bei 1 MiB, 135 ms bei 2,4 MiB, 210 ms bei
 * 3,6 MiB Antworttext, gegen 4 ms mit der Nachbarschaft); mit 256 Zeilen
 * bleiben es 35 bis 100 ms auch bei Umfragen mit 3000 bis 6000 Antworten, und
 * der Neuaufbau des -wal (db.ts) bleibt klein. Hat die Tabelle hoechstens so
 * viele Zeilen, wird sie ganz neu geschrieben.
 */
export const REWRITE_SAMPLE_ROWS = 256;

/**
 * Bis zu REWRITE_SAMPLE_ROWS zufaellige Antworten. IDs sind gleichverteilte
 * 48-Bit-Zahlen, die naechste Zeile ab einer zufaelligen ID ist deshalb eine
 * (fast) gleichverteilte Wahl; eine Indexsuche je Zeile, ohne die Tabelle zu
 * lesen. Eine kleine Tabelle kommt ganz zurueck.
 */
function sampleResponseTable(db: Database.Database, columns: string): ResponseRow[] {
  const head = db.prepare(`${columns} LIMIT ?`).all(REWRITE_SAMPLE_ROWS + 1) as ResponseRow[];
  if (head.length <= REWRITE_SAMPLE_ROWS) return head;
  const up = db.prepare(`${columns} WHERE id >= ? ORDER BY id LIMIT 1`);
  const down = db.prepare(`${columns} WHERE id < ? ORDER BY id DESC LIMIT 1`);
  const sample = new Map<number, ResponseRow>();
  for (let i = 0; i < REWRITE_SAMPLE_ROWS; i++) {
    const probe = randomInt(1, RESPONSE_ID_LIMIT);
    const row = (up.get(probe) ?? down.get(probe)) as ResponseRow | undefined;
    if (row) sample.set(row.id, row);
  }
  return [...sample.values()];
}

/**
 * Legt eine Antwort so ab, dass weder ID noch Lage in der Datei die
 * Reihenfolge der Teilnahmen verraten. Innerhalb der Transaktion der
 * Teilnahme aufrufen.
 *
 * Die zufaellige ID allein genuegt nicht: SQLite legt neue Zellen einer Seite
 * in Einfuegereihenfolge ab (nur der Zeigerbereich ist nach ID sortiert).
 * Wer Datei und Schluessel hat, sortierte die Zellen nach ihrer Lage und
 * bekaeme die Reihenfolge der Teilnahmen zurueck (gemessen: genau 1 bis 12).
 * Deshalb werden die Nachbarn der neuen Antwort geloescht und samt ihr in
 * zufaelliger Reihenfolge wieder eingefuegt: alle Zeilen, die mit ihr auf
 * einer Seite der Tabelle liegen koennen (nach ID, ueber alle Umfragen;
 * einen Index hat die Tabelle seit Migration 503 nicht mehr). Eine Seite
 * fasst hoechstens page_size Bytes an Zellen; gesammelt wird zu beiden Seiten
 * der neuen ID, bis die Untergrenze der belegten Bytes eine Seite
 * uebersteigt. Damit ist die Zelle der neuen Antwort auf ihrer Seite nur eine
 * von vielen frisch eingefuegten, und der Aufwand je Teilnahme bleibt bei
 * einigen Dutzend Zeilen, statt mit der Umfrage zu wachsen. (Bei grossen
 * Antworten genuegt das nicht: FULL_REWRITE_DIVISOR.) secure_delete
 * ueberschreibt die geloeschten Zellen; sonst stuende der vorige Stand
 * daneben, und die eine Antwort, die dort fehlt, waere die neue.
 *
 * Was bleibt: Verschiebt SQLite Zellen zwischen Seiten (Teilen und
 * Zusammenlegen), bleiben vereinzelt Kopien aelterer Antworten in der
 * unbelegten Luecke einer Seite stehen; secure_delete erfasst diese Luecken
 * nicht (gemessen: 8 von 1200). Das Beenden einer Umfrage baut deshalb die
 * ganze Tabelle neu auf (rebuildResponseTable). Kopien, die Teilnahmen
 * danach hinterlassen, auch solche von Antworten einer schon beendeten
 * Umfrage, verraten nur die Reihenfolge der Antworten, die zu dieser Zeit
 * hinzukamen (Umfragen, die noch laufen), und das naechste Umfrageende
 * raeumt sie. Und wer zwei Staende der Datei vergleicht (zwei Sicherungen),
 * sieht die Antworten, die dazwischen hinzukamen, und die Teilnahmen dieses
 * Zeitraums. Das gilt fuer jede Speicherung und ist nicht Ziel hiervon.
 */
export function storeAnonymousResponse(db: Database.Database, surveyId: number, answers: string): void {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  // Eine Tabellenzeile belegt auf ihrer Seite mindestens ihre Nutzlast bis
  // zur Ueberlaufgrenze (gut ein Achtel der Seite; hier vorsichtig ein
  // Zehntel) plus Zeiger und Laengen.
  const tableCell = (row: ResponseRow) => Math.min(Buffer.byteLength(row.answers), Math.floor(pageSize / 10)) + 4;
  const taken = db.prepare('SELECT 1 AS x FROM survey_responses WHERE id = ?');
  let id: number;
  do id = randomInt(1, RESPONSE_ID_LIMIT);
  while (taken.get(id));

  const neighbours = new Map<number, ResponseRow>();
  const collect = (sql: string) => {
    let covered = 0;
    for (const row of db.prepare(sql).iterate(id) as IterableIterator<ResponseRow>) {
      neighbours.set(row.id, row);
      covered += tableCell(row);
      if (covered > pageSize) break;
    }
  };
  const columns = 'SELECT id, survey_id, answers FROM survey_responses';
  collect(`${columns} WHERE id < ? ORDER BY id DESC`);
  collect(`${columns} WHERE id > ? ORDER BY id`);
  // Grosse Antworten: siehe FULL_REWRITE_DIVISOR. Reicht die Nachbarschaft nicht,
  // kommt eine Stichprobe der ganzen Tabelle in das gemischte Neuschreiben.
  const largeFrom = Math.floor(pageSize / FULL_REWRITE_DIVISOR);
  const large =
    Buffer.byteLength(answers) >= largeFrom ||
    [...neighbours.values()].some((row) => Buffer.byteLength(row.answers) >= largeFrom);
  if (large) for (const row of sampleResponseTable(db, columns)) neighbours.set(row.id, row);

  const rows: ResponseRow[] = [...neighbours.values(), { id, survey_id: surveyId, answers }];
  for (let i = rows.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  // Die gelöschten Zellen überschreibt secure_delete der Verbindung
  // (configureConnection); ohne es stünde der vorige Stand daneben.
  assertSecureDelete(db);
  const remove = db.prepare('DELETE FROM survey_responses WHERE id = ?');
  for (const neighbour of neighbours.keys()) remove.run(neighbour);
  const insert = db.prepare('INSERT INTO survey_responses (id, survey_id, answers) VALUES (?, ?, ?)');
  for (const row of rows) insert.run([row.id, row.survey_id, row.answers]);
  markResponsesWritten(db);
}

/*
 * Zustand des Neuaufbaus von survey_responses, eine Tabelle aus Migration
 * 504 (REBUILD_STATE_TABLE), je Vermerk eine Zeile, ohne Zeitstempel:
 *  - 'written': Seit dem letzten Neuaufbau kamen Antworten hinzu (im Commit
 *    der Antwort). Nur dann kann die Tabelle Kopien in Seitenluecken tragen
 *    (storeAnonymousResponse ist der einzige Schreibweg); ohne ihn ist ein
 *    Neuaufbau ueberfluessig.
 *  - 'pending': Ein Neuaufbau steht aus (im Commit des Umfrageendes).
 *  - 'expired:<id>': Fuer diese ausgelaufene, nicht beendete Umfrage ist der
 *    Neuaufbau nach dem Ablauf gelaufen (rebuildForExpiredSurveys).
 * Zeilen statt eigener Tabellen: Keine Teilnahme aendert das Schema.
 */
const WRITTEN = 'written';
const PENDING = 'pending';
const EXPIRED_PREFIX = 'expired:';

function hasState(db: Database.Database, key: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM ${REBUILD_STATE_TABLE} WHERE key = ?`).get(key) !== undefined;
}

function setState(db: Database.Database, key: string): void {
  db.prepare(`INSERT OR IGNORE INTO ${REBUILD_STATE_TABLE} (key) VALUES (?)`).run(key);
}

function markResponsesWritten(db: Database.Database): void {
  setState(db, WRITTEN);
}

/** true, wenn seit dem letzten Neuaufbau Antworten hinzukamen (markResponsesWritten). */
export function responsesWrittenSinceRebuild(db: Database.Database): boolean {
  return hasState(db, WRITTEN);
}

function rebuildPending(db: Database.Database): boolean {
  return hasState(db, PENDING);
}

/**
 * Vermerkt den Neuaufbau von survey_responses, wenn seit dem letzten Antworten
 * hinzukamen; Rueckgabe: ob ein Neuaufbau aussteht. In der Transaktion
 * aufrufen, die eine Umfrage beendet: Scheitert der Neuaufbau danach (oder
 * bricht der Prozess dazwischen ab), holt ihn der naechste Start nach
 * (retryResponseTableRebuild).
 */
export function markResponseTableRebuild(db: Database.Database): boolean {
  if (!responsesWrittenSinceRebuild(db)) return rebuildPending(db);
  setState(db, PENDING);
  return true;
}

/**
 * Baut survey_responses neu auf und entfernt damit die Kopien aelterer
 * Antworten, die das Neuschreiben der Nachbarn in Seitenluecken hinterlaesst
 * (storeAnonymousResponse). In EINER Transaktion (db/rebuildTable.ts):
 * alle Zeilen in eine temporaere Tabelle, die Tabelle entfernen und neu
 * anlegen, in Schluesselreihenfolge zurueckschreiben; ein Vermerk
 * (markResponseTableRebuild) und der Vermerk geschriebener Antworten
 * (markResponsesWritten) fallen im selben Commit weg.
 *
 * Mit secure_delete ueberschreibt SQLite jede dabei freiwerdende Seite mit
 * Nullen, also auch die Luecken samt ihren Kopien; die neuen Zellen liegen in
 * Schluesselreihenfolge, die Einfuegereihenfolge verraet nichts (gemessen:
 * danach keine Kopie mehr in der Datei, auch nicht in der Wurzelseite, die
 * ein blosses DELETE FROM bei eingeschalteten Fremdschluesseln nie
 * freigibt). Seiten, die schon VORHER frei
 * waren, erreicht das nicht; sie tragen keine Umfragedaten, weil jede
 * Verbindung des Dienstes und der Werkzeuge secure_delete gesetzt hat
 * (configureConnection in db/encryption.ts), also auch jede Kaskade
 * (gelöschte Umfrage, gelöschtes Personalprofil). rebuildTableInKeyOrder
 * setzt es für seine Arbeit zusätzlich selbst (es läuft auch in
 * Migrationen auf beliebigen Verbindungen). Bewusst kein VACUUM: Es
 * blockierte fuer die ganze Datei statt fuer eine Tabelle und hielte bei
 * einer verschluesselten Datenbank eine Kopie der ganzen Datenbank im
 * Arbeitsspeicher (configureConnection in db/encryption.ts). Die
 * temporaere Tabelle liegt bei einer verschluesselten Datenbank im
 * Arbeitsspeicher.
 */
export function rebuildResponseTable(db: Database.Database): void {
  db.transaction(() => {
    rebuildTableInKeyOrder(db, 'survey_responses');
    db.prepare(`DELETE FROM ${REBUILD_STATE_TABLE} WHERE key IN (?, ?)`).run([PENDING, WRITTEN]);
  })();
}

/**
 * Neuaufbau beim Beenden einer Umfrage (communication/routes.ts), danach das
 * -wal leeren: Dessen Frames hielten den Stand vor dem Neuaufbau fest.
 */
export function rebuildResponseTableNow(): void {
  rebuildResponseTable(getDb());
  // Ohne Messung: Die Frames des Neuaufbaus nennen nur frisch geschriebene
  // Seiten; als offene Füllung zählten sie, so gross wie die ganze Tabelle.
  clearWalSoon({ measure: false });
}

/**
 * Neuaufbau fuer Umfragen, die ohne Statuswechsel ausgelaufen sind: Status
 * `laufend`, `date_to` ueberschritten. Das Portal bietet sie nicht mehr an
 * (me/communicationRoutes.ts), praktisch sind sie beendet, aber nur das
 * Beenden durch die HR loest den Neuaufbau aus; ohne das blieben Kopien
 * aelterer Antworten unbefristet in Seitenluecken stehen. Laeuft beim Start des
 * Moduls und stuendlich (communication/routes.ts); der Status bleibt
 * unveraendert. Je Umfrage EINMAL nach ihrem Ablauf ('expired:<id>'):
 * Danach tragen Kopien nur noch die Reihenfolge von Antworten, die spaeter
 * hinzukamen, wie nach einem Beenden auch; sonst liefe der Neuaufbau jede
 * Stunde, solange andere Umfragen Antworten bekommen. Neu aufgebaut wird nur,
 * wenn seit dem letzten Neuaufbau Antworten hinzukamen. Rueckgabe: ob neu
 * aufgebaut wurde.
 */
export function rebuildForExpiredSurveys(): boolean {
  const db = getDb();
  const today = todayIso();
  const expiredSql = "SELECT ? || id FROM surveys WHERE status = 'laufend' AND date_to < ?";
  // Wieder offen (date_to verlaengert) oder beendet: Der Vermerk faellt weg,
  // ein spaeteres Auslaufen zaehlt neu.
  db.prepare(
    `DELETE FROM ${REBUILD_STATE_TABLE} WHERE key LIKE ? AND key NOT IN (${expiredSql})`,
  ).run([`${EXPIRED_PREFIX}%`, EXPIRED_PREFIX, today]);
  const fresh = (
    db.prepare(`${expiredSql} EXCEPT SELECT key FROM ${REBUILD_STATE_TABLE}`).pluck().all([EXPIRED_PREFIX, today]) as string[]
  );
  if (fresh.length === 0) return false;
  const rebuild = responsesWrittenSinceRebuild(db);
  if (rebuild) rebuildResponseTableNow();
  db.transaction(() => {
    for (const key of fresh) setState(db, key);
  })();
  return rebuild;
}

/** Holt einen vermerkten, noch nicht gelungenen Neuaufbau nach (Start des Moduls). */
export function retryResponseTableRebuild(warn: (message: string) => void): void {
  if (!rebuildPending(getDb())) return;
  try {
    rebuildResponseTableNow();
  } catch (err) {
    warn(
      'Neuaufbau der Umfrageantworten nach einem Umfrageende ist erneut gescheitert; der nächste Start versucht es wieder ' +
        `(${errorText(err)}).`,
    );
  }
}

export interface SurveyRow {
  id: number;
  title: string;
  description: string | null;
  audience_type: AudienceType;
  audience_id: number | null;
  date_from: string;
  date_to: string;
  min_participants: number | null;
  status: 'entwurf' | 'laufend' | 'beendet';
  created_by_user_id: number | null;
  created_at: string;
}

export interface QuestionRow {
  id: number;
  survey_id: number;
  kind: 'skala' | 'einfachauswahl' | 'mehrfachauswahl' | 'freitext';
  text: string;
  options: string | null;
  scale_max: number | null;
  sort_order: number;
}

export const answersSchema = z
  .array(
    z.object({
      question_id: z.number().int().positive(),
      value: z.union([z.string(), z.number(), z.array(z.string())]),
    }),
  )
  .min(1, 'Mindestens eine Antwort erforderlich');

export type SurveyAnswers = z.infer<typeof answersSchema>;

export function getSurvey(id: number): SurveyRow {
  const row = getDb().prepare('SELECT * FROM surveys WHERE id = ?').get(id) as SurveyRow | undefined;
  if (!row) throw notFound('Umfrage nicht gefunden');
  return row;
}

export function getQuestions(surveyId: number): QuestionRow[] {
  return getDb()
    .prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id')
    .all(surveyId) as QuestionRow[];
}

export function questionToJson(q: QuestionRow) {
  return {
    id: q.id,
    survey_id: q.survey_id,
    kind: q.kind,
    text: q.text,
    options: q.options ? (JSON.parse(q.options) as string[]) : null,
    scale_max: q.scale_max,
    sort_order: q.sort_order,
  };
}

export function hasParticipated(surveyId: number, employeeId: number): boolean {
  return (
    getDb()
      .prepare('SELECT 1 AS x FROM survey_participations WHERE survey_id = ? AND employee_id = ?')
      .get(surveyId, employeeId) !== undefined
  );
}

/** Prueft jede Antwort gegen Art und Wertebereich ihrer Frage. */
export function validateAnswers(surveyId: number, answers: SurveyAnswers): void {
  const questions = new Map(getQuestions(surveyId).map((q) => [q.id, q]));
  for (const a of answers) {
    const q = questions.get(a.question_id);
    if (!q) throw badRequest(`Frage ${a.question_id} gehört nicht zu dieser Umfrage`);
    if (q.kind === 'skala') {
      if (typeof a.value !== 'number' || !Number.isInteger(a.value) || a.value < 1 || a.value > (q.scale_max ?? 5)) {
        throw badRequest(`Ungültiger Skalenwert für Frage „${q.text}“`);
      }
    } else if (q.kind === 'einfachauswahl') {
      const options = q.options ? (JSON.parse(q.options) as string[]) : [];
      if (typeof a.value !== 'string' || !options.includes(a.value)) {
        throw badRequest(`Ungültige Auswahl für Frage „${q.text}“`);
      }
    } else if (q.kind === 'mehrfachauswahl') {
      const options = q.options ? (JSON.parse(q.options) as string[]) : [];
      if (!Array.isArray(a.value) || a.value.some((v) => !options.includes(v))) {
        throw badRequest(`Ungültige Auswahl für Frage „${q.text}“`);
      }
    } else if (typeof a.value !== 'string') {
      throw badRequest(`Freitextantwort für Frage „${q.text}“ muss Text sein`);
    }
  }
}

/**
 * Teilnahme einer aktiven Person an einer laufenden Umfrage. Wirft 409 bei
 * Doppelteilnahme oder wenn die Umfrage nicht laeuft, 400 bei ungueltigen
 * Antworten. Liefert die neue Teilnahmezahl.
 */
export function recordParticipation(surveyId: number, employeeId: number, answers: SurveyAnswers): number {
  const survey = getSurvey(surveyId);
  if (survey.status !== 'laufend') {
    throw conflict('Antworten sind nur möglich, während die Umfrage läuft');
  }
  const employee = getDb()
    .prepare("SELECT id FROM employees WHERE id = ? AND status = 'aktiv'")
    .get(employeeId);
  if (!employee) throw badRequest('Mitarbeiter:in nicht gefunden oder nicht aktiv');
  // Antworten ZUERST pruefen: Mit ungueltigen Antworten verriete sonst die
  // Unterscheidung 409/400, ob eine Person schon teilgenommen hat, ohne dass
  // etwas geschrieben wird (HR-Testerfassung fuer beliebige Personen).
  validateAnswers(surveyId, answers);
  if (hasParticipated(surveyId, employeeId)) {
    throw conflict('Diese Person hat an der Umfrage bereits teilgenommen');
  }

  inTransaction(() => {
    getDb()
      .prepare('INSERT INTO survey_participations (survey_id, employee_id) VALUES (?, ?)')
      .run(surveyId, employeeId);
    storeAnonymousResponse(getDb(), surveyId, JSON.stringify(answers));
    // Die HR-Erfassung darf auch nach dem Enddatum nachtragen (Status noch
    // `laufend`). Der Neuaufbau nach dem Ablauf lief aber schon (einmal je
    // Umfrage, rebuildForExpiredSurveys); den Vermerk streichen, damit der
    // naechste Durchlauf die Kopien dieser Nachtragung ebenfalls raeumt.
    if (survey.date_to < todayIso()) {
      getDb().prepare(`DELETE FROM ${REBUILD_STATE_TABLE} WHERE key = ?`).run(`${EXPIRED_PREFIX}${surveyId}`);
    }
  });
  // Jeder Commit steht als eigener Stand im -wal: Neben dem vorigen Stand der
  // Datei zeigte er, welche Antwort und welche Teilnahme hinzukamen (gemessen).
  // Der Checkpoint schreibt den Stand an seine Stelle und leert das -wal, ohne
  // zu warten; hält gerade ein Leser seinen Stand, holt clearWalSoon es nach.
  clearWalSoon();
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM survey_participations WHERE survey_id = ?')
      .get(surveyId) as { c: number }
  ).c;
}
