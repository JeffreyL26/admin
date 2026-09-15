/**
 * Tabellen des Registers.
 *
 * Bewusst flach und ohne Migrationsmaschinerie: Das Register hat genau einen
 * Benutzer (den Anbieter) und eine Datei. `CREATE TABLE IF NOT EXISTS` beim
 * Oeffnen genuegt; spaetere Spalten kommen als `ALTER TABLE` daneben, mit
 * derselben Bedingung.
 *
 * Zahlungen sind KEINE eigene Tabelle, sondern ein `vorgaenge.art = 'zahlung'`.
 * Grund: Ein Vorgang ist alles, was zu einem Kunden datiert festgehalten
 * wird (Angebot, Lizenz ausgestellt, Rechnung, Zahlung, Stoerung, Kuendigung).
 * Eine eigene Zahlungstabelle haette die Haelfte dieser Spalten doppelt und
 * die Chronik eines Kunden auf zwei Abfragen verteilt.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kunden (
  id TEXT PRIMARY KEY,                       -- Kurzschluessel, z. B. musterfirma
  name TEXT NOT NULL,
  kontakt TEXT,
  email TEXT,
  notiz TEXT,
  angelegt_am TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,                       -- Kurzschluessel, z. B. hz1
  adresse TEXT NOT NULL,                     -- Hostname oder IP fuer ssh
  ssh_benutzer TEXT NOT NULL DEFAULT 'root',
  ssh_port INTEGER NOT NULL DEFAULT 22,
  basis_domain TEXT,
  notiz TEXT,
  angelegt_am TEXT NOT NULL DEFAULT (date('now'))
);

-- Eine Instanz ist eine laufende Installation: beim Hosting eine
-- systemd-Instanz auf einem Host, beim Einzelkunden dessen eigener Server.
-- installation_id ist der Schluessel, an den eine gebundene Lizenz haengt.
CREATE TABLE IF NOT EXISTS instanzen (
  id TEXT PRIMARY KEY,                       -- <kunde> oder <kunde>-test
  kunde_id TEXT NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  art TEXT NOT NULL DEFAULT 'hosting' CHECK (art IN ('hosting', 'kunde-server', 'einzelplatz')),
  variante TEXT NOT NULL,                    -- de-vollversion
  domain TEXT,
  installation_id TEXT,                      -- 32 Hex, aus status.cjs bzw. dem Bericht
  version TEXT,                              -- zuletzt gesehene Version
  kanal TEXT,                                -- stable | beta
  license_format INTEGER,                    -- hoechste lesbare Lizenzfassung
  lizenz_zustand TEXT,                       -- trial | valid | grace | expired ...
  aktive_profile INTEGER,
  zuletzt_gesehen TEXT,
  notiz TEXT,
  angelegt_am TEXT NOT NULL DEFAULT (date('now'))
);

-- Jede ausgestellte Datei, nicht nur die aktuelle: Wer wissen will, was ein
-- Kunde wann bekommen hat, braucht die Kette, nicht den letzten Stand.
CREATE TABLE IF NOT EXISTS lizenzen (
  license_id TEXT PRIMARY KEY,
  kunde_id TEXT NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  instanz_id TEXT REFERENCES instanzen(id) ON DELETE SET NULL,
  kid TEXT,                                  -- Schluessel, mit dem signiert wurde
  v INTEGER NOT NULL,
  kind TEXT NOT NULL,
  edition TEXT,
  land TEXT,
  features TEXT,                             -- kommagetrennt
  billing TEXT,
  interval TEXT,
  installation_id TEXT,
  ausgestellt_am TEXT NOT NULL,
  gueltig_ab TEXT NOT NULL,
  gueltig_bis TEXT NOT NULL,
  unbefristet INTEGER NOT NULL DEFAULT 0,
  plaetze INTEGER,
  datei TEXT,                                -- Pfad im Register
  eingespielt_am TEXT,
  notiz TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,                       -- <variante>-<version>
  version TEXT NOT NULL,
  kanal TEXT NOT NULL,
  variante TEXT NOT NULL,
  commit_hash TEXT,
  gebaut_am TEXT,
  signatur_geprueft INTEGER NOT NULL DEFAULT 0,
  manifest TEXT,                             -- Pfad zum release.json
  artefakte TEXT,                            -- JSON-Liste { file, sha256, bytes }
  erfasst_am TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS rollouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  instanz_id TEXT REFERENCES instanzen(id) ON DELETE SET NULL,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  zustand TEXT NOT NULL DEFAULT 'offen' CHECK (zustand IN ('offen', 'laeuft', 'fertig', 'fehlgeschlagen', 'probelauf')),
  begonnen_am TEXT NOT NULL DEFAULT (datetime('now')),
  beendet_am TEXT,
  protokoll TEXT
);

CREATE TABLE IF NOT EXISTS vorgaenge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kunde_id TEXT NOT NULL REFERENCES kunden(id) ON DELETE CASCADE,
  art TEXT NOT NULL,                         -- zahlung | lizenz | stoerung | notiz | kuendigung
  datum TEXT NOT NULL,
  betrag_cent INTEGER,
  waehrung TEXT NOT NULL DEFAULT 'EUR',
  beleg TEXT,
  text TEXT
);

CREATE INDEX IF NOT EXISTS idx_instanzen_kunde ON instanzen(kunde_id);
CREATE INDEX IF NOT EXISTS idx_lizenzen_kunde ON lizenzen(kunde_id, gueltig_bis);
CREATE INDEX IF NOT EXISTS idx_vorgaenge_kunde ON vorgaenge(kunde_id, datum);
CREATE INDEX IF NOT EXISTS idx_rollouts_release ON rollouts(release_id);
`;

/**
 * Spalten, die nach der ersten Fassung dazugekommen sind. `CREATE TABLE IF
 * NOT EXISTS` legt sie in einem bestehenden Register nicht mehr an, deshalb
 * hier je Spalte ein ALTER, das ein "duplicate column name" schluckt. Das
 * genuegt bei einem Register mit genau einem Benutzer; eine
 * Migrationsmaschinerie waere hier mehr Apparat als Nutzen.
 */
export const SPAETERE_SPALTEN: { tabelle: string; spalte: string; typ: string }[] = [
  { tabelle: 'lizenzen', spalte: 'kid', typ: 'TEXT' },
  // Privater SSH-Schluessel je Host (-i), wenn nicht der Standardschluessel gilt.
  { tabelle: 'hosts', spalte: 'ssh_schluessel', typ: 'TEXT' },
];
