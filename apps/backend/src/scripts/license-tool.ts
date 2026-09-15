/**
 * oHRganize Lizenzwerkzeug des ANBIETERS. Laeuft aus dem Repository, nie auf
 * einem Kundensystem (es ist nicht Teil des dist-Bundles). Schlanke
 * Alternative ohne Register; mit Register, Instanzen und Rollouts arbeitet
 * tools/conspectus, das denselben Baustein core/licenseIssue.ts nutzt.
 *
 *   npm run lizenz -- keygen --out <verzeichnis> --kid 2026-09
 *   npm run lizenz -- keys
 *   npm run lizenz -- sign --key <privat.pem> --kid 2026-09 \
 *        --customer "Musterfirma GmbH" --customer-id musterfirma \
 *        --installation <32 hex | -> --until 2027-09-12|unbefristet|3t|6m|1j [--from 2026-09-13] \
 *        [--seats 50] [--grace 14] [--warn 30] [--kind standard|evaluation] \
 *        [--notice "Rechnung 2026-1234"] [--out <datei>] [--register <csv>] \
 *        [--edition vollversion --country DE] [--feature kunde.musterfirma.export ...] \
 *        [--billing kostenfrei|abo|kauf|individuell] [--interval monatlich|jaehrlich] \
 *        [--label "Partnerkonditionen"] [--headline "Ihre Lizenz ..."] [--v2]
 *   npm run lizenz -- inspect <datei> [--pubkey <oeffentlich.pem>]
 *   npm run lizenz -- protect --key <privat.pem>      (Passphrase aus OHRGANIZE_LICENSE_PASSPHRASE)
 *
 * Lizenzfassung: Ohne v2-Flag entsteht eine v1-Datei (jeder Server liest
 * sie). Sobald --edition, --country, --feature, --billing, --headline oder
 * --v2 gesetzt ist, entsteht v2; dann sind --edition und --country Pflicht,
 * und der Server des Kunden muss v2 lesen (Health und Lizenzbericht melden
 * license_format >= 2). Rollout immer Server vor Datei.
 *
 * Beispiele fuer Lizenzmodelle (alle nur ueber die Datei, nichts davon ist
 * beim Kunden umstellbar):
 *   3 Tage Test:            --kind evaluation --until 3t
 *   kostenfrei unbefristet: --until unbefristet --billing kostenfrei --edition ... --country DE
 *   Jahresabo:              --until 1j --billing abo --interval jaehrlich --edition ... --country DE
 *
 * Der private Schluessel gehoert NICHT ins Repo, nicht in OneDrive, nicht in
 * eine Mail. `keygen` legt ihn mit 0600 ab; verschluesselt, wenn
 * OHRGANIZE_LICENSE_PASSPHRASE gesetzt ist; dieselbe Variable liest `sign`.
 * Das Register (CSV, Semikolon) ist die Sicht des Anbieters auf "wer hat was
 * bis wann"; es wird bei jedem `sign` fortgeschrieben.
 *
 * Pruefung und Format teilen sich Werkzeug und Server (core/licenseCodec.ts),
 * damit eine hier erzeugte Datei genau das ist, was der Server akzeptiert.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  LICENSE_FILE_NAME,
  todayIsoLocal,
  type LicenseBilling,
  type LicenseInterval,
  type LicensePayload,
} from '@ohrganize/shared';
import {
  decodeLicenseText,
  parseLicensePayload,
  publicKeyFingerprint,
  publicKeyFrom,
  publicKeyToRawBase64,
  verifyLicenseText,
} from '../core/licenseCodec.js';
import {
  LicenseIssueError,
  REGISTER_CSV_HEADER,
  issueLicense,
  privateKeyMatches,
  registerCsvLine,
} from '../core/licenseIssue.js';
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
      laufzeit: { type: 'string' },
      seats: { type: 'string' },
      grace: { type: 'string' },
      warn: { type: 'string' },
      kind: { type: 'string' },
      notice: { type: 'string' },
      out: { type: 'string' },
      register: { type: 'string' },
      edition: { type: 'string' },
      country: { type: 'string' },
      feature: { type: 'string', multiple: true },
      billing: { type: 'string' },
      interval: { type: 'string' },
      label: { type: 'string' },
      headline: { type: 'string' },
      v2: { type: 'boolean' },
    },
  });

  const keyPath = values.key ?? fail('--key <privat.pem> fehlt');
  const kid = values.kid ?? fail('--kid fehlt (muss zu einem Eintrag in licenseKeys.ts passen)');
  const customer = values.customer ?? fail('--customer fehlt');
  const customerId = values['customer-id'] ?? fail('--customer-id fehlt');
  const installationArg = values.installation ?? fail('--installation <32 hex | -> fehlt');
  // --laufzeit ist ein Alias fuer --until mit Laufzeitangabe (3t, 6m, 1j).
  const until = values.until ?? values.laufzeit ?? fail('--until JJJJ-MM-TT | unbefristet | 3t | 6m | 1j fehlt');

  if (!TRUSTED_LICENSE_KEYS_RAW.some((k) => k.kid === kid)) {
    console.warn(
      `WARNUNG: kid ${kid} steht nicht in licenseKeys.ts; ein Server ohne diesen Eintrag lehnt die Datei ab.`,
    );
  }
  const numberOrNull = (flag: string, raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(`${flag} muss eine Zahl sein (erhalten: ${raw})`);
    return n;
  };
  const billing = values.billing;
  if (billing !== undefined && !['kostenfrei', 'abo', 'kauf', 'individuell'].includes(billing)) {
    fail('--billing: kostenfrei | abo | kauf | individuell');
  }
  const interval = values.interval;
  if (interval !== undefined && !['monatlich', 'jaehrlich'].includes(interval)) fail('--interval: monatlich | jaehrlich');

  const passphrase = process.env.OHRGANIZE_LICENSE_PASSPHRASE?.trim() || undefined;
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: fs.readFileSync(keyPath, 'utf8'), passphrase });
  } catch (err) {
    fail(`Privater Schlüssel nicht lesbar (${(err as Error).message}). Passphrase in OHRGANIZE_LICENSE_PASSPHRASE?`);
  }
  // Der eingebettete oeffentliche Schluessel muss zum privaten passen; sonst
  // signiert man Dateien, die kein Server je annimmt.
  const embedded = TRUSTED_LICENSE_KEYS_RAW.find((k) => k.kid === kid);
  if (embedded && !privateKeyMatches(privateKey, embedded.publicKey)) {
    fail(`Der private Schlüssel passt nicht zum eingebauten öffentlichen Schlüssel ${kid}.`);
  }

  let issued;
  try {
    issued = issueLicense(
      {
        kid,
        customer,
        customerId,
        installationId: installationArg === '-' ? null : installationArg,
        until,
        from: values.from ?? null,
        seats: numberOrNull('--seats', values.seats),
        graceDays: numberOrNull('--grace', values.grace),
        warnDays: numberOrNull('--warn', values.warn),
        kind: (values.kind ?? 'standard') as LicensePayload['kind'],
        notice: values.notice ?? null,
        edition: values.edition ?? null,
        country: values.country ?? null,
        features: values.feature ?? null,
        billing: (billing ?? null) as LicenseBilling | null,
        interval: (interval ?? null) as LicenseInterval | null,
        termsLabel: values.label ?? null,
        headline: values.headline ?? null,
        forceV2: values.v2 === true,
      },
      privateKey,
    );
  } catch (err) {
    if (err instanceof LicenseIssueError) fail(err.message);
    fail(`Ungültige Angaben: ${describeZod(err)}`);
  }
  const { text, payload } = issued;

  const outPath = values.out ?? `lizenz-${customerId}-${payload.valid_until}.ohrganize`;
  fs.writeFileSync(outPath, `${text}\n`, { mode: 0o644 });

  if (values.register) {
    if (!fs.existsSync(values.register)) fs.writeFileSync(values.register, REGISTER_CSV_HEADER, { mode: 0o600 });
    fs.appendFileSync(values.register, registerCsvLine(payload, path.resolve(outPath)));
  }

  const untilLabel = payload.valid_until === '2999-12-31' ? 'unbefristet' : payload.valid_until;
  console.log(`Lizenz ausgestellt (v${payload.v}): ${outPath}`);
  console.log(`  Kunde:          ${payload.customer} (${payload.customer_id})`);
  console.log(`  Installation:   ${payload.installation_id ?? 'ungebunden'}`);
  console.log(`  Gültig:         ${payload.valid_from} bis ${untilLabel} (Kulanz ${payload.grace_days} Tage, Warnung ${payload.warn_days} Tage vorher)`);
  console.log(`  Plätze:         ${payload.max_users ?? 'unbegrenzt'}   Art: ${payload.kind}`);
  if (payload.v === 2) {
    console.log(`  Ausgabe:        ${payload.country} ${payload.edition}`);
    console.log(`  Funktionen:     ${payload.features?.length ? payload.features.join(', ') : 'alle des Builds'}`);
    if (payload.terms) {
      const t = payload.terms;
      console.log(`  Bedingungen:    ${t.billing}${t.interval ? `, ${t.interval}` : ''}${t.label ? ` (${t.label})` : ''}`);
    }
    if (payload.headline) console.log(`  Überschrift:    ${payload.headline}`);
    console.log('  HINWEIS: v2-Datei. Der Server des Kunden muss license_format 2 melden (Health, Lizenzbericht), sonst lehnt er sie ab.');
  }
  console.log(`  Lizenz-ID:      ${payload.license_id}`);
  if (values.register) console.log(`  Register:       ${values.register}`);
  console.log('');
  console.log(`Beim Kunden: Datei unter Einstellungen → Lizenz einspielen (oder als ${LICENSE_FILE_NAME} ins Datenverzeichnis legen; der Dienst erkennt sie binnen Sekunden, ohne Neustart).`);
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------
// protect: vorhandenen (unverschlüsselten) privaten Schlüssel nachträglich mit
// Passphrase versehen — derselbe Schlüssel, dieselbe kid, kein Update nötig.
// Erst wird die verschlüsselte Fassung zurückgelesen und gegen den Original-
// schlüssel geprüft, dann ersetzt sie die Datei.
// ---------------------------------------------------------------------------
function protect(args: string[]): void {
  const { values } = parseArgs({ args, options: { key: { type: 'string' } } });
  const keyPath = values.key ?? fail('--key <privat.pem> fehlt');
  const passphrase = process.env.OHRGANIZE_LICENSE_PASSPHRASE?.trim() || '';
  if (passphrase.length < 12) fail('OHRGANIZE_LICENSE_PASSPHRASE muss gesetzt sein und mindestens 12 Zeichen haben.');
  if (!fs.existsSync(keyPath)) fail(`Datei nicht gefunden: ${keyPath}`);
  const pem = fs.readFileSync(keyPath, 'utf8');
  if (/ENCRYPTED/.test(pem)) fail('Der Schlüssel ist bereits verschlüsselt.');
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: pem });
  } catch (err) {
    fail(`Kein lesbarer privater Schlüssel: ${(err as Error).message}`);
  }
  const encrypted = privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }) as string;
  // Gegenprobe vor dem Überschreiben: zurücklesen und Signatur vergleichen.
  const reread = crypto.createPrivateKey({ key: encrypted, passphrase });
  const probe = Buffer.from('ohrganize-protect-probe');
  if (!crypto.verify(null, probe, crypto.createPublicKey(privateKey), crypto.sign(null, probe, reread))) {
    fail('Gegenprobe fehlgeschlagen — Datei unverändert gelassen.');
  }
  fs.writeFileSync(keyPath, encrypted, { mode: 0o600 });
  console.log(`Schlüssel verschlüsselt: ${keyPath} (kid unverändert, Fingerabdruck ${publicKeyFingerprint(crypto.createPublicKey(privateKey))})`);
  console.log('Ab jetzt braucht jedes `sign` die Passphrase in OHRGANIZE_LICENSE_PASSPHRASE. Die Passphrase gehört in den Passwort-Manager — ohne sie ist der Schlüssel wertlos.');
}

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
    case 'protect':
      protect(rest);
      break;
    default:
      console.log('Befehle: keygen | keys | sign | inspect | protect  (Aufrufbeispiele im Kopf dieser Datei)');
      process.exit(command ? 1 : 0);
  }
}
