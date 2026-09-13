/**
 * oHRganize — Lizenzwerkzeug des ANBIETERS. Läuft aus dem Repository, nie auf
 * einem Kundensystem (es ist nicht Teil des dist-Bundles).
 *
 *   npm run lizenz -- keygen --out <verzeichnis> --kid 2026-09
 *   npm run lizenz -- keys
 *   npm run lizenz -- sign --key <privat.pem> --kid 2026-09 \
 *        --customer "Musterfirma GmbH" --customer-id musterfirma \
 *        --installation <32 hex | -> --until 2027-09-12 [--from 2026-09-13] \
 *        [--seats 50] [--grace 14] [--warn 30] [--kind standard|evaluation] \
 *        [--notice "Rechnung 2026-1234"] [--out <datei>] [--register <csv>]
 *   npm run lizenz -- inspect <datei> [--pubkey <oeffentlich.pem>]
 *
 * Der private Schlüssel gehört NICHT ins Repo, nicht in OneDrive, nicht in
 * eine Mail. `keygen` legt ihn mit 0600 ab; verschlüsselt, wenn
 * OHRGANIZE_LICENSE_PASSPHRASE gesetzt ist — dieselbe Variable liest `sign`.
 * Das Register (CSV, Semikolon) ist die Sicht des Anbieters auf „wer hat was
 * bis wann“; es wird bei jedem `sign` fortgeschrieben.
 *
 * Prüfung und Format teilen sich Werkzeug und Server (core/licenseCodec.ts),
 * damit eine hier erzeugte Datei genau das ist, was der Server akzeptiert.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  LICENSE_DEFAULT_GRACE_DAYS,
  LICENSE_DEFAULT_WARN_DAYS,
  LICENSE_FILE_NAME,
  type LicensePayload,
} from '@ohrganize/shared';
import {
  LICENSE_MAX_DATE,
  decodeLicenseText,
  parseLicensePayload,
  publicKeyFingerprint,
  publicKeyFrom,
  publicKeyToRawBase64,
  signLicensePayload,
  verifyLicenseText,
} from '../core/licenseCodec.js';
import { TRUSTED_LICENSE_KEYS_RAW } from '../core/licenseKeys.js';

function fail(message: string): never {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

/** Erste zod-Meldung als Satz — die JSON-Liste der Issues gehört nicht auf die Konsole. */
function describeZod(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues?.length) return (err as Error).message;
  const first = issues[0];
  return `${first.path.length ? first.path.join('.') + ': ' : ''}${first.message}`;
}

function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------
function keygen(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, kid: { type: 'string' } },
  });
  const out = values.out ?? fail('--out <verzeichnis> fehlt');
  const kid = values.kid ?? todayIsoLocal().slice(0, 7);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(kid)) fail('--kid: nur Buchstaben, Ziffern, . _ - (max. 32)');

  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const privPath = path.join(out, `lizenz-privat-${kid}.pem`);
  const pubPath = path.join(out, `lizenz-oeffentlich-${kid}.pem`);
  if (fs.existsSync(privPath)) fail(`${privPath} existiert bereits — nichts überschrieben.`);

  const passphrase = process.env.OHRGANIZE_LICENSE_PASSPHRASE?.trim() || undefined;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export(
    passphrase
      ? { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }
      : { format: 'pem', type: 'pkcs8' },
  );
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 });

  console.log(`Schlüsselpaar erzeugt (kid ${kid})${passphrase ? ', privater Schlüssel verschlüsselt' : ''}.`);
  console.log(`  privat:     ${privPath}   ← sichern, nie weitergeben`);
  console.log(`  öffentlich: ${pubPath}`);
  console.log(`  Fingerabdruck: ${publicKeyFingerprint(publicKey)}`);
  console.log('');
  console.log('Eintrag für apps/backend/src/core/licenseKeys.ts:');
  console.log(`  { kid: '${kid}', publicKey: '${publicKeyToRawBase64(publicKey)}' },`);
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
function keys(): void {
  console.log('Eingebaute Prüfschlüssel (core/licenseKeys.ts):');
  for (const k of TRUSTED_LICENSE_KEYS_RAW) {
    console.log(`  ${k.kid}  Fingerabdruck ${publicKeyFingerprint(publicKeyFrom(k.publicKey))}`);
  }
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------
function sign(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      kid: { type: 'string' },
      customer: { type: 'string' },
      'customer-id': { type: 'string' },
      installation: { type: 'string' },
      from: { type: 'string' },
      until: { type: 'string' },
      seats: { type: 'string' },
      grace: { type: 'string' },
      warn: { type: 'string' },
      kind: { type: 'string' },
      notice: { type: 'string' },
      out: { type: 'string' },
      register: { type: 'string' },
    },
  });

  const keyPath = values.key ?? fail('--key <privat.pem> fehlt');
  const kid = values.kid ?? fail('--kid fehlt (muss zu einem Eintrag in licenseKeys.ts passen)');
  const customer = values.customer ?? fail('--customer fehlt');
  const customerId = values['customer-id'] ?? fail('--customer-id fehlt');
  const installationArg = values.installation ?? fail('--installation <32 hex | -> fehlt');
  const validUntil = values.until ?? fail('--until JJJJ-MM-TT fehlt');
  const validFrom = values.from ?? todayIsoLocal();
  const seats = values.seats === undefined ? null : Number(values.seats);
  const grace = values.grace === undefined ? LICENSE_DEFAULT_GRACE_DAYS : Number(values.grace);
  const warn = values.warn === undefined ? LICENSE_DEFAULT_WARN_DAYS : Number(values.warn);
  const kind = (values.kind ?? 'standard') as LicensePayload['kind'];
  const notice = values.notice ?? null;

  if (!TRUSTED_LICENSE_KEYS_RAW.some((k) => k.kid === kid)) {
    console.warn(
      `WARNUNG: kid ${kid} steht nicht in licenseKeys.ts — ein Server ohne diesen Eintrag lehnt die Datei ab.`,
    );
  }
  if (seats !== null && (!Number.isInteger(seats) || seats < 1)) fail('--seats muss eine ganze Zahl ≥ 1 sein');
  if (installationArg !== '-' && !/^[0-9a-fA-F]{32}$/.test(installationArg)) {
    fail('--installation muss die 32-stellige Installations-ID (Einstellungen → Lizenz) oder - für ungebunden sein');
  }
  for (const [flag, value] of [['--until', validUntil], ['--from', validFrom]] as const) {
    const t = Date.parse(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
      fail(`${flag} muss ein gültiger Kalendertag JJJJ-MM-TT sein (erhalten: ${value})`);
    }
  }
  if (validUntil > LICENSE_MAX_DATE) fail(`--until darf nicht nach ${LICENSE_MAX_DATE} liegen („unbefristet“ = ${LICENSE_MAX_DATE})`);
  if (kind !== 'standard' && kind !== 'evaluation') fail('--kind: standard | evaluation');

  const passphrase = process.env.OHRGANIZE_LICENSE_PASSPHRASE?.trim() || undefined;
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: fs.readFileSync(keyPath, 'utf8'), passphrase });
  } catch (err) {
    fail(`Privater Schlüssel nicht lesbar (${(err as Error).message}). Passphrase in OHRGANIZE_LICENSE_PASSPHRASE?`);
  }
  // Der eingebettete öffentliche Schlüssel muss zum privaten passen — sonst
  // signiert man Dateien, die kein Server je annimmt.
  const embedded = TRUSTED_LICENSE_KEYS_RAW.find((k) => k.kid === kid);
  if (embedded) {
    const derived = publicKeyToRawBase64(crypto.createPublicKey(privateKey));
    if (derived !== embedded.publicKey) {
      fail(`Der private Schlüssel passt nicht zum eingebauten öffentlichen Schlüssel ${kid}.`);
    }
  }

  const payload: LicensePayload = {
    v: 1,
    license_id: crypto.randomUUID(),
    kid,
    customer,
    customer_id: customerId,
    installation_id: installationArg === '-' ? null : installationArg.toLowerCase(),
    kind,
    issued_at: todayIsoLocal(),
    valid_from: validFrom,
    valid_until: validUntil,
    grace_days: grace,
    warn_days: warn,
    max_users: seats,
    notice,
  };

  let text: string;
  try {
    text = signLicensePayload(payload, privateKey);
  } catch (err) {
    fail(`Ungültige Angaben: ${describeZod(err)}`);
  }
  // Gegenprobe mit genau der Prüfung, die der Server macht.
  verifyLicenseText(text, [{ kid, publicKey: crypto.createPublicKey(privateKey) }]);

  const outPath = values.out ?? `lizenz-${customerId}-${validUntil}.ohrganize`;
  fs.writeFileSync(outPath, `${text}\n`, { mode: 0o644 });

  if (values.register) {
    const header =
      'issued_at;license_id;kid;customer_id;customer;installation_id;kind;valid_from;valid_until;grace_days;warn_days;max_users;notice;file\n';
    const line =
      [
        payload.issued_at,
        payload.license_id,
        payload.kid,
        payload.customer_id,
        payload.customer,
        payload.installation_id ?? '',
        payload.kind,
        payload.valid_from,
        payload.valid_until,
        payload.grace_days,
        payload.warn_days,
        payload.max_users ?? '',
        payload.notice ?? '',
        path.resolve(outPath),
      ]
        .map(csvCell)
        .join(';') + '\n';
    if (!fs.existsSync(values.register)) fs.writeFileSync(values.register, header, { mode: 0o600 });
    fs.appendFileSync(values.register, line);
  }

  console.log(`Lizenz ausgestellt: ${outPath}`);
  console.log(`  Kunde:          ${customer} (${customerId})`);
  console.log(`  Installation:   ${payload.installation_id ?? 'ungebunden'}`);
  console.log(`  Gültig:         ${validFrom} bis ${validUntil} (Kulanz ${grace} Tage, Warnung ${warn} Tage vorher)`);
  console.log(`  Plätze:         ${seats ?? 'unbegrenzt'}   Art: ${kind}`);
  console.log(`  Lizenz-ID:      ${payload.license_id}`);
  if (values.register) console.log(`  Register:       ${values.register}`);
  console.log('');
  console.log(`Beim Kunden: Datei unter Einstellungen → Lizenz einspielen (oder als ${LICENSE_FILE_NAME} ins Datenverzeichnis legen — der Dienst erkennt sie binnen Sekunden, ohne Neustart).`);
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------
function inspect(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { pubkey: { type: 'string' } },
    allowPositionals: true,
  });
  const file = positionals[0] ?? fail('Dateipfad fehlt');
  if (!fs.existsSync(file)) fail(`Datei nicht gefunden: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  let payload: LicensePayload;
  try {
    payload = parseLicensePayload(decodeLicenseText(text).payloadBytes);
  } catch (err) {
    fail((err as Error).message);
  }
  console.log(JSON.stringify(payload, null, 2));

  const trusted = values.pubkey
    ? [{ kid: payload.kid, publicKey: publicKeyFrom(fs.readFileSync(values.pubkey, 'utf8')) }]
    : TRUSTED_LICENSE_KEYS_RAW.map((k) => ({ kid: k.kid, publicKey: publicKeyFrom(k.publicKey) }));
  try {
    verifyLicenseText(text, trusted);
    console.log(`Signatur: gültig (kid ${payload.kid}${values.pubkey ? ', gegen --pubkey' : ', eingebauter Schlüssel'})`);
  } catch (err) {
    console.log(`Signatur: UNGÜLTIG — ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
const [command, ...rest] = process.argv.slice(2);
try {
  run(command, rest);
} catch (err) {
  // Tippfehler in Optionen: deutsche Einzeiler-Meldung statt Stacktrace.
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (code.startsWith('ERR_PARSE_ARGS_')) fail(`${(err as Error).message} (Aufrufbeispiele im Kopf dieser Datei)`);
  throw err;
}

function run(command: string | undefined, rest: string[]): void {
  switch (command) {
    case 'keygen':
      keygen(rest);
      break;
    case 'keys':
      keys();
      break;
    case 'sign':
      sign(rest);
      break;
    case 'inspect':
      inspect(rest);
      break;
    default:
      console.log('Befehle: keygen | keys | sign | inspect  (Aufrufbeispiele im Kopf dieser Datei)');
      process.exit(command ? 1 : 0);
  }
}
