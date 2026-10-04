/**
 * Zustand EINER Instanz, ohne sie anzufassen.
 *
 *   node apps/backend/dist/status.cjs --data-dir /var/lib/ohrganize/musterfirma [--json]
 *   node apps/backend/dist/status.cjs --data-dir <pfad> --lizenzdatei <datei> [--json]
 *
 * `--lizenzdatei` bewertet eine andere Datei als die im Datenverzeichnis
 * (Probe VOR dem Einspielen: provision.sh lizenz lehnt eine Datei ab, die
 * fuer diese Instanz unbrauchbar waere, statt eine gueltige zu ersetzen).
 *
 * Beantwortet die Fragen, die ein Betreiber an eine fremde Installation hat:
 * Welche Variante und Version? Welche Installations-ID (die braucht die
 * Lizenz)? Welcher Lizenzzustand, und laeuft sie bald ab? Wie viele
 * Personalprofile und Konten? Sind Migrationen ausstehend?
 *
 * Das Werkzeug OEFFNET die Datenbank ausschliesslich lesend
 * (`readonly, fileMustExist`) und SCHREIBT nichts: kein `last_seen_date`,
 * kein `licensed_at`, keine Migration. Der Lizenzzustand entsteht ueber die
 * reine Funktion `deriveLicenseState`; die Uhrenwarnung wird aus
 * `last_seen_date` berechnet, statt sie fortzuschreiben. Genau dafuer ist der
 * Zustandsautomat aus Phase 1 seiteneffektfrei.
 *
 * Kein Import von config.ts (siehe toolkit.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LICENSE_FORMAT_VERSION,
  LICENSE_KIND_LABELS,
  LICENSE_STATE_LABELS,
  COUNTRY_LABELS,
  daysBetweenIso,
  describeLicense,
  formatDate,
  type LicenseStatus,
} from '@ohrganize/shared';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { APP_VERSION } from '../core/version.js';
import { verifyLicenseText } from '../core/licenseCodec.js';
import { TRUSTED_LICENSE_KEYS_RAW } from '../core/licenseKeys.js';
import { publicKeyFrom } from '../core/licenseCodec.js';
import { deriveLicenseState, type LoadedLicenseInput } from '../core/licenseState.js';
import { allMigrations } from '../db/migrations/index.js';
import { CONVERSION_FAILED_FILE, databaseState, readDataKey } from '../db/encryption.js';
import { storageEncryptionState } from '../core/fileCrypto.js';
import {
  dataDirFrom,
  directorySize,
  fail,
  formatBytes,
  openInstanceDb,
  parseArgs,
  refuseRoot,
  todayLocal,
  variantBanner,
} from './toolkit.js';
import { errorText } from '../core/errorText.js';

const { values, flags } = parseArgs(process.argv.slice(2));
const asJson = flags.has('json');
refuseRoot('runuser -u ohrganize -- node /opt/ohrganize/apps/backend/dist/status.cjs --data-dir <pfad>');
const paths = dataDirFrom(values['data-dir'], 'apps/backend/dist/status.cjs');
if (!fs.existsSync(paths.db)) fail(`${paths.db} existiert nicht (Instanz noch nie gestartet?).`);

// Verschluesselung im Ruhezustand: Eine Instanz, deren Umstellung beim Start
// gescheitert ist, laeuft weiter, nur unverschluesselt; Dateien, die die
// Umstellung nicht erfasst hat, bleiben im Klartext. Beides soll hier und in
// provision.sh check auffallen, nicht nur in einer Journalzeile.
// VOR dem Oeffnen der Verbindung: Den Dateikopf bei offener Verbindung zu
// lesen gaebe unter POSIX deren Sperren frei (db/encryption.ts).
let keyState: 'internal' | 'external' | 'missing' | 'invalid';
try {
  const key = readDataKey(paths.dir);
  keyState = key === null ? 'missing' : key.external ? 'external' : 'internal';
} catch {
  keyState = 'invalid';
}
const storageState = storageEncryptionState(paths.storage);
const encryption = {
  // Erst nach dem Schliessen bestimmt (unten): Das Oeffnen spielt ein
  // liegengebliebenes Journal einer abgebrochenen Umstellung zurueck und kann
  // den Zustand dabei aendern.
  database: 'plaintext' as 'encrypted' | 'plaintext',
  key: keyState,
  storage: storageState.state,
  storage_plaintext_files: storageState.plaintext,
  // Kennung vorhanden, aber abgeschnitten: Der Download dieser Dateien scheitert.
  storage_damaged_files: storageState.damaged,
  // Nicht zu öffnen (Rechte, Sperre); gezählt statt abzubrechen.
  storage_unreadable_files: storageState.unreadable,
  // 1, wenn der Vermerk der Umstellung liegt (umstellung-pruefung-gescheitert.txt):
  // neben einer verschluesselten Datenbank startet der Dienst nur nach
  // bestandener Pruefung, neben einer unverschluesselten stellt der naechste
  // Start erneut um. Als Zahl, damit provision.sh es mit json_zahl liest.
  conversion_marker: fs.existsSync(path.join(paths.dir, CONVERSION_FAILED_FILE)) ? 1 : 0,
};

const db = openInstanceDb(paths.db, { readonly: true, dataDir: paths.dir });

function count(table: string, where = ''): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number };
    return row.n;
  } catch {
    // Tabelle gibt es in dieser Fassung noch nicht: kein Grund abzubrechen.
    return null;
  }
}

const installation = db
  .prepare('SELECT installation_id, created_at, licensed_at, last_seen_date FROM installation WHERE id = 1')
  .get() as
  | { installation_id: string; created_at: string; licensed_at: string | null; last_seen_date: string | null }
  | undefined;
if (!installation) fail('Die Tabelle `installation` ist leer. Ist das eine oHRganize-Datenbank?');

const appliedMigrations = (db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(
  (r) => r.name,
);
const known = new Set(allMigrations.map((m) => m.name));
const pending = allMigrations.filter((m) => !appliedMigrations.includes(m.name)).map((m) => m.name);
/** Migrationen, die diese Datenbank kennt, dieses Programm aber nicht: Downgrade. */
const fromNewer = appliedMigrations.filter((name) => !known.has(name));

// ---------------------------------------------------------------------------
// Lizenz: lesen, pruefen, Zustand ableiten. Nichts davon schreibt.
// ---------------------------------------------------------------------------
const trusted = TRUSTED_LICENSE_KEYS_RAW.map((k) => ({ kid: k.kid, publicKey: publicKeyFrom(k.publicKey) }));
let loaded: LoadedLicenseInput = { exists: false, payload: null, invalidReason: null };
const licenseFile = values['lizenzdatei'] ? path.resolve(values['lizenzdatei']) : paths.license;
if (values['lizenzdatei'] && !fs.existsSync(licenseFile)) fail(`Lizenzdatei ${licenseFile} existiert nicht.`);
if (fs.existsSync(licenseFile)) {
  try {
    loaded = { exists: true, payload: verifyLicenseText(fs.readFileSync(licenseFile, 'utf8'), trusted), invalidReason: null };
  } catch (err) {
    loaded = { exists: true, payload: null, invalidReason: errorText(err) };
  }
}

const today = todayLocal();
// Uhrenwarnung wie im Betrieb (core/license.ts advanceLastSeen), nur ohne das
// UPDATE: Liegt der zuletzt gesehene Tag mehr als einen Tag in der Zukunft
// oder Vergangenheit, stimmt etwas mit der Uhr nicht.
const clockWarning =
  installation.last_seen_date !== null &&
  today <= installation.last_seen_date &&
  daysBetweenIso(today, installation.last_seen_date) > 1;

const { core } = deriveLicenseState({
  today,
  variant: { country: VARIANT.country, edition: VARIANT.edition, label: VARIANT.label },
  enforced: true,
  installation: {
    installation_id: installation.installation_id,
    created_at: installation.created_at,
    licensed_at: installation.licensed_at,
  },
  loaded,
  clockWarning,
});

const activeEmployees = count('employees', "WHERE status = 'aktiv'") ?? 0;

const status: LicenseStatus = {
  ...core,
  kind: core.payload?.kind ?? null,
  customer: core.payload?.customer ?? null,
  max_users: core.payload?.max_users ?? null,
  license_id: core.payload?.license_id ?? null,
  edition: core.payload?.edition ?? null,
  country: core.payload?.country ?? null,
  features: core.payload?.features ?? null,
  terms: core.payload?.terms ?? null,
  headline: core.payload?.headline ?? null,
  notice: core.payload?.notice ?? null,
  seats_used: activeEmployees,
};

const text = describeLicense(status);

const dbBytes = fs.statSync(paths.db).size;
const storage = directorySize(paths.storage);

const result = {
  variant: {
    id: VARIANT.id,
    country: VARIANT.country,
    edition: VARIANT.edition,
    label: VARIANT.label,
    marker: VARIANT_MARKER,
  },
  version: APP_VERSION,
  /** Hoechste lesbare Lizenzfassung dieses Standes (wie /api/health); conspectus prueft sie vor v2. */
  license_format: LICENSE_FORMAT_VERSION,
  data_dir: paths.dir,
  installation_id: installation.installation_id,
  installed_at: installation.created_at,
  licensed_at: installation.licensed_at,
  last_seen_date: installation.last_seen_date,
  clock_warning: clockWarning,
  license: {
    state: core.state,
    state_label: LICENSE_STATE_LABELS[core.state],
    read_only: core.read_only,
    warning: core.warning,
    perpetual: core.perpetual,
    valid_until: core.valid_until,
    grace_until: core.grace_until,
    days_left: core.days_left,
    kind: status.kind,
    kind_label: status.kind ? LICENSE_KIND_LABELS[status.kind] : null,
    customer: status.customer,
    license_id: status.license_id,
    max_users: status.max_users,
    active_users: status.seats_used,
    edition: status.edition,
    country: status.country,
    features: status.features,
    invalid_reason: core.invalid_reason,
    file_present: loaded.exists,
    headline: text.headline,
    detail: text.detail,
  },
  counts: {
    employees_active: count('employees', "WHERE status = 'aktiv'"),
    employees_total: count('employees'),
    users: count('users'),
    users_admin: count('users', "WHERE role = 'admin'"),
    users_portal: count('users', "WHERE role = 'mitarbeiter'"),
    files: count('files'),
  },
  storage: { db_bytes: dbBytes, files: storage.files, file_bytes: storage.bytes },
  encryption,
  migrations: { applied: appliedMigrations.length, pending, from_newer_version: fromNewer },
};

db.close();
encryption.database = databaseState(paths.db) === 'encrypted' ? 'encrypted' : 'plaintext';

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const line = (label: string, value: string | number | null | undefined) =>
    console.log(`  ${label.padEnd(22)}${value ?? '(leer)'}`);
  console.log(variantBanner());
  console.log('');
  line('Datenverzeichnis', result.data_dir);
  line('Installations-ID', result.installation_id);
  line('Angelegt am', formatDate(result.installed_at.slice(0, 10)));
  line('Lizenziert seit', result.licensed_at ? formatDate(result.licensed_at.slice(0, 10)) : 'noch nie');
  console.log('');
  console.log(`  Lizenz: ${text.headline}`);
  if (text.detail) console.log(`          ${text.detail}`);
  line('Zustand', `${result.license.state} (${result.license.state_label})`);
  line('Nur-Lese-Betrieb', result.license.read_only ? 'JA' : 'nein');
  if (result.license.customer) line('Kunde', result.license.customer);
  if (result.license.license_id) line('Lizenznummer', result.license.license_id);
  if (result.license.country && result.license.edition) {
    line('Ausgabe', `${COUNTRY_LABELS[result.license.country]} ${result.license.edition}`);
  }
  if (result.license.max_users !== null) {
    line('Plaetze', `${result.license.active_users} von ${result.license.max_users}`);
  }
  if (result.license.features) line('Funktionen', result.license.features.join(', ') || '(keine)');
  if (result.license.invalid_reason) line('Datei unbrauchbar', result.license.invalid_reason);
  if (result.clock_warning) line('Uhr', 'Der zuletzt gesehene Tag liegt in der Zukunft. Systemzeit pruefen.');
  console.log('');
  line('Personalprofile', `${result.counts.employees_active} aktiv von ${result.counts.employees_total}`);
  line('Konten', `${result.counts.users} (${result.counts.users_admin} Administration, ${result.counts.users_portal} Portal)`);
  line('Datenbank', formatBytes(result.storage.db_bytes));
  const keyLabel = { internal: 'data.key im Datenverzeichnis', external: 'data.key verweist nach aussen', missing: 'keine data.key', invalid: 'data.key UNBRAUCHBAR' }[encryption.key];
  line('Verschluesselung', `${encryption.database === 'encrypted' ? 'verschluesselt' : 'NICHT verschluesselt'} (${keyLabel})`);
  if (encryption.conversion_marker) {
    line(
      'Umstellung',
      encryption.database === 'encrypted'
        ? `Pruefung NICHT bestanden oder nie beendet (${CONVERSION_FAILED_FILE}); der Dienst startet nur, wenn sie beim Start besteht`
        : `abgebrochen (${CONVERSION_FAILED_FILE}); der naechste Start stellt erneut um`,
    );
  }
  const storageLabel = { empty: 'keine Dateien', encrypted: 'alle verschluesselt', mixed: `${encryption.storage_plaintext_files} NICHT verschluesselt`, plaintext: 'NICHT verschluesselt' }[encryption.storage];
  const storageNotes = [
    storageLabel,
    ...(encryption.storage_damaged_files > 0 ? [`${encryption.storage_damaged_files} BESCHAEDIGT (abgeschnitten)`] : []),
    ...(encryption.storage_unreadable_files > 0 ? [`${encryption.storage_unreadable_files} NICHT LESBAR (Rechte?)`] : []),
  ];
  line('Dateiablage', storageNotes.join(', '));
  line('Dateien', `${result.storage.files} (${formatBytes(result.storage.file_bytes)})`);
  line('Migrationen', `${result.migrations.applied} angewendet, ${pending.length} ausstehend`);
  if (fromNewer.length > 0) {
    console.log('');
    console.log('  ACHTUNG: Diese Datenbank wurde von einer NEUEREN Version migriert.');
    console.log(`  Unbekannte Migrationen: ${fromNewer.join(', ')}`);
  }
}
