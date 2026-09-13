/**
 * Öffentliche Signierschlüssel des Anbieters — die Vertrauensanker der
 * Lizenzprüfung. Hier stehen ausschließlich ÖFFENTLICHE Schlüssel; der
 * zugehörige private Schlüssel liegt beim Anbieter außerhalb des Repos und
 * wird von scripts/license-tool.ts benutzt.
 *
 * Mehrere Einträge erlauben einen Schlüsselwechsel ohne Bruch: Der neue
 * Schlüssel kommt als weiterer Eintrag hinzu und wird mit einem Update
 * ausgeliefert; Lizenzen nennen ihren Schlüssel über `kid`. Ein alter
 * Schlüssel bleibt, solange Lizenzen damit im Umlauf sind — entfernt wird er
 * erst, wenn alle Kunden neu signierte Dateien haben (sonst fällt deren Server
 * nach dem Update in den Nur-Lese-Betrieb).
 *
 * Fingerabdruck zum Abgleich mit dem Werkzeug (`npm run lizenz -- keys`):
 *   2026-09  e3020b0c94b399dc
 *
 * Kein Eintrag aus der Umgebung an dieser Stelle — den Test-Override
 * (OHRGANIZE_LICENSE_PUBLIC_KEY) wertet core/license.ts aus und protokolliert ihn.
 */

/** 32 Rohbytes je Schlüssel, Base64 (Format siehe licenseCodec.publicKeyFrom). */
export const TRUSTED_LICENSE_KEYS_RAW: ReadonlyArray<{ kid: string; publicKey: string }> = [
  { kid: '2026-09', publicKey: 'Wf+klsGc445t5+2c3/sjPRAHZUSYXcwfhRANSQtg/Fs=' },
];
