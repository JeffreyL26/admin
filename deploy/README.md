# oHRganize — Serverbetrieb

Diese Dateien richten oHRganize als Dienst auf einem Linux-Server ein: ein
Backend für alle Desktop-Arbeitsplätze der HR-Administration **und** das
Mitarbeitenden-Portal.

Die Erstinbetriebnahme (erste Anmeldung, Konten, Rollen, fachliche Prüfungen)
steht in **`../docs/inbetriebnahme.md`** — diese Datei endet dort, wo der
Dienst läuft.

| Datei | Zweck | Ablage auf dem Server |
|---|---|---|
| `ohrganize-backend.service` | Dienstdefinition des Backends | `/etc/systemd/system/` |
| `ohrganize.env.example` | Vorlage aller Umgebungsvariablen | `/etc/ohrganize/ohrganize.env` |
| `nginx.conf` | Reverse-Proxy (Variante A) | `/etc/nginx/conf.d/ohrganize.conf` |
| `nginx-security-headers.conf` | Kopfzeilen-Snippet für nginx | `/etc/nginx/snippets/ohrganize-security-headers.conf` |
| `Caddyfile` | Reverse-Proxy (Variante B) | `/etc/caddy/Caddyfile` |
| `ohrganize-backup.service` | Sicherungslauf | `/etc/systemd/system/` |
| `ohrganize-backup.timer` | Zeitplan der Sicherung | `/etc/systemd/system/` |

Für den Mehrkunden-Betrieb (Abschnitt 9) kommen dazu:

| Datei | Zweck | Ablage auf dem Server |
|---|---|---|
| `ohrganize-backend@.service` | Dienstvorlage je Kunde | `/etc/systemd/system/` |
| `ohrganize-kunde.env.example` | Vorlage der kundenspezifischen Variablen | bleibt im Programmverzeichnis |
| `ohrganize-backup@.service` · `ohrganize-backup@.timer` | Sicherung je Kunde | `/etc/systemd/system/` |
| `nginx-wildcard.conf` | Reverse-Proxy für `*.ohrganize.com` | `/etc/nginx/conf.d/ohrganize-wildcard.conf` |
| `ohrganize-provision.sh` | Kunden anlegen, auflisten, entfernen | bleibt im Programmverzeichnis |

**Vor dem Ausrollen ersetzen** (in `nginx.conf` bzw. `Caddyfile`):

| Platzhalter | Bedeutung |
|---|---|
| `portal.firma.de` | Domain, unter der Portal und API erreichbar sind |
| `it@firma.de` | Postfach für Let's-Encrypt-Meldungen (nur Caddy) |
| `/srv/ohrganize-web` | Zielverzeichnis des Portal-Builds |

Alle übrigen Pfade sind bewusst fest verdrahtet und über alle Dateien hinweg
konsistent:

| Was | Pfad |
|---|---|
| Programm | `/opt/ohrganize` |
| Daten (DB, Dateien, Secret, Lizenz) | `/var/lib/ohrganize` |
| Konfiguration | `/etc/ohrganize/ohrganize.env` |
| Sicherungen | `/var/backups/ohrganize` |
| Dienstbenutzer | `ohrganize:ohrganize` |

---

## 1. Voraussetzungen

- Linux mit systemd (getestete Ziele: Debian 12/13, Ubuntu 22.04/24.04).
- **Node.js ≥ 20** (`node -v`). Aus der Distribution oder von NodeSource.
- Das **Release-Archiv** `ohrganize-server-<version>.zip` des Anbieters
  (samt `.sha256`) und `unzip`. Es enthält die fertig gebauten Bundles, den
  Portal-Build, dieses Verzeichnis und die Betriebsdokumente — kein
  Quelltext, keine Build-Werkzeuge, kein `git` nötig.
- **Build-Werkzeuge: `apt install -y build-essential python3`.** Nicht für
  oHRganize selbst (das kommt fertig gebaut), sondern für `better-sqlite3`,
  die einzige native Abhängigkeit: Auf Debian 13 mit Node 20 findet sie
  **kein** passendes Fertigpaket ("No prebuilt binaries found
  (target=20.19.2 …)") und übersetzt sich beim `npm ci` aus dem Quelltext;
  ohne `make` bricht die Installation ab.
- Eine Domain, die auf den Server zeigt, und die Ports 80 und 443 aus dem
  Internet erreichbar (Port 80 wird für die Zertifikatsausstellung gebraucht).
- Bei Variante B (Abschnitt 3): **Caddy ≥ 2.8.0** — nicht das
  Distributionspaket, das ist auf allen genannten Zielen 2.6.2 und kennt die
  Pflichtzeile `reuse_private_keys` des mitgelieferten Caddyfile nicht.
- Ressourcen: 2 CPU-Kerne und 2 GB RAM reichen für die geplante Größenordnung
  bequem. oHRganize läuft bewusst als **ein** Node-Prozess mit einer
  SQLite-Datei — mehrere Prozesse auf dieselbe Datenbank sind nicht vorgesehen.

## 2. Installation

```bash
# 2.1 Dienstkonto ohne Login-Shell
adduser --system --group --home /var/lib/ohrganize --shell /usr/sbin/nologin ohrganize

# 2.2 Programm ablegen — Release-Archiv des Anbieters, OHNE Zwischenverzeichnis
install -d -o root -g root -m 0755 /opt/ohrganize
sha256sum -c ohrganize-server-<version>.zip.sha256
unzip -o ohrganize-server-<version>.zip -d /opt/ohrganize
cd /opt/ohrganize
cat LIESMICH.txt                              # Inhalt des Archivs

# 2.3 Laufzeitabhängigkeit installieren
#     Gebaut wird auf dem Server nichts: apps/backend/dist/cli.cjs (Dienst),
#     backup.cjs (Sicherung) und apps/web/dist (Portal) liegen fertig im
#     Archiv. Das Bundle enthält alle npm-Pakete bis auf eines: better-sqlite3
#     bringt eine native Bibliothek mit und muss auf dem Zielsystem installiert
#     werden. package.json und package-lock.json im Archiv sind genau darauf
#     gekürzt (rund 40 Pakete, dieselben Versionen und Prüfsummen wie im
#     Quell-Repository) — deshalb --omit=dev, und es gibt kein npm run build.
npm ci --omit=dev

#     KONTROLLE — nicht überspringen. Der Dienst startet sonst später mit einem
#     Fehler, der nicht nach der Ursache aussieht.
#     better-sqlite3 holt seine native Bibliothek über ein Installationsskript.
#     npm sperrt solche Skripte ab Version 12, sofern das Paket nicht in
#     "allowScripts" der package.json steht UND der Lockfile eine
#     "resolved"-URL dazu mitbringt (ohne die kann npm nicht auf eine Version
#     festnageln). Das Archiv bringt beides mit; fehlt trotzdem eine der beiden
#     Bedingungen (Lockfile von Hand geändert?), meldet "npm ci" Erfolg — und
#     erst der erste Datenbankzugriff bricht mit "Could not locate the
#     bindings file" ab.
#     ACHTUNG: Ein blosses require() genügt als Prüfung NICHT. Die native
#     Bindung wird erst beim "new Database" geladen.
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"

#     Schlägt die Zeile fehl, das Installationsskript von Hand nachholen und
#     die Kontrollzeile wiederholen:
#     (cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js)

# 2.4 Portal-Build ausliefern
install -d -o root -g root -m 0755 /srv/ohrganize-web
cp -a apps/web/dist/. /srv/ohrganize-web/

# 2.5 Konfiguration
install -d -o root -g ohrganize -m 0750 /etc/ohrganize
install -o root -g ohrganize -m 0640 deploy/ohrganize.env.example /etc/ohrganize/ohrganize.env
editor /etc/ohrganize/ohrganize.env

# 2.6 Dienst einrichten
cp deploy/ohrganize-backend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ohrganize-backend

# 2.7 Läuft es?
systemctl status ohrganize-backend
curl -sS http://127.0.0.1:3001/api/health     # {"ok":true,"name":"oHRganize Backend"}
```

> Beim allerersten Start legt oHRganize den Standard-Admin an und schreibt ein
> **generiertes** Initialpasswort ins Journal und nach
> `/var/lib/ohrganize/initial-admin-password.txt`. Wie es weitergeht, steht in
> `../docs/inbetriebnahme.md`. Das früher dokumentierte Passwort `hrmonic2026`
> existiert nicht mehr.

`/opt/ohrganize` gehört bewusst **root**, nicht dem Dienstbenutzer: Der Dienst
soll sein eigenes Programm nicht überschreiben können. Beschreibbar ist für ihn
nur `/var/lib/ohrganize` (und `/var/backups/ohrganize`).

> **Eigenbau aus dem Quelltext** (Entwicklung, eigener Fork, Prüfung des
> Archivs): `git clone`, `npm ci` — ausdrücklich **ohne** `--omit=dev`, der
> Build braucht esbuild und typescript —, dann `npm run build -w apps/backend`
> und `npm run build:web`; die Dienstpfade sind dieselben. Wer das Archiv
> selbst erzeugen will: `npm run release:server` baut beides und schreibt
> `release/ohrganize-server-<version>.zip` mit genau dem Inhalt, den dieser
> Abschnitt voraussetzt (`scripts/release-server.mjs`).

## 3. Reverse-Proxy

Genau **eine** der beiden Varianten wählen.

### Variante A — nginx

```bash
apt install -y nginx certbot
install -d -m 0755 /etc/nginx/snippets /var/www/certbot
cp deploy/nginx-security-headers.conf /etc/nginx/snippets/ohrganize-security-headers.conf
cp deploy/nginx.conf /etc/nginx/conf.d/ohrganize.conf
editor /etc/nginx/conf.d/ohrganize.conf        # Domain ersetzen

# Zertifikat holen (der HTTP-Server-Block muss dafür schon stehen).
# --reuse-key ist PFLICHT, siehe „Serverschlüssel festnageln“ unten: Ohne die
# Option erzeugt certbot bei jeder Erneuerung (alle ~60 Tage) ein neues
# Schlüsselpaar, und jeder HR-Arbeitsplatz verweigert danach den Start.
# --deploy-hook: nginx lädt das erneuerte Zertifikat sonst erst beim nächsten
# Reload (Abschnitt 9.3 erklärt es ausführlicher).
certbot certonly --reuse-key --webroot -w /var/www/certbot -d portal.firma.de \
  --deploy-hook 'systemctl reload nginx'

nginx -t && systemctl reload nginx
```

### Variante B — Caddy

```bash
# Caddy >= 2.8.0 ist Pflicht (reuse_private_keys im Caddyfile). Die
# Distributionspakete von Debian 12/13 und Ubuntu 22.04/24.04 sind 2.6.2 und
# melden „unknown subdirective: reuse_private_keys“ — deshalb das offizielle
# Repository (caddyserver.com/docs/install):
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
caddy version                                # erwartet: v2.8.0 oder neuer

cp deploy/Caddyfile /etc/caddy/Caddyfile
editor /etc/caddy/Caddyfile                  # Domain und E-Mail ersetzen
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy                       # Zertifikat holt Caddy selbst
```

### Serverschlüssel festnageln — gilt für beide Varianten

Die Desktop-App der HR-Administration prüft im `https://`-Betrieb zusätzlich
zur Zertifikatskette den **öffentlichen Schlüssel** des Servers (SPKI-Hash,
`sha256/<Base64>`): ohne Konfiguration merkt sie ihn sich beim ersten
Kontakt, mit `serverKeyPins` in der `config.json` ist er vorgegeben. Ein
Server, der sich mit einem anderen Schlüssel ausweist — auch mit einem
formal gültigen Zertifikat —, wird abgewiesen, und die App startet nicht.
Einrichtung, Pin-Berechnung und Rollout stehen in `windows/README.md`,
Abschnitt 7; sie gelten unverändert für Arbeitsplätze, die auf diesen
Linux-Server zeigen. Für den Server folgt daraus:

- **Der Schlüssel muss Zertifikatserneuerungen überleben.** Caddy erledigt
  das über `tls { reuse_private_keys }` im mitgelieferten Caddyfile (deshalb
  Caddy ≥ 2.8.0 — die Zeile nicht entfernen). certbot erzeugt ohne Zutun bei
  jeder Erneuerung ein neues Schlüsselpaar; `--reuse-key` beim
  `certbot certonly` oben schaltet das ab und wird je Zertifikat in
  `/etc/letsencrypt/renewal/<name>.conf` (`reuse_key = True`) gemerkt, sodass
  der Timer (`certbot renew`) den Schlüssel behält. Existiert das Zertifikat
  schon, denselben Aufruf mit `--reuse-key … --cert-name <name>` **vor der
  ersten Erneuerung** wiederholen (oder `reuse_key = True` in die
  Renewal-Datei eintragen) — der aktuelle Schlüssel bleibt dann, kein Pin
  ändert sich.
- **Ein bewusster Schlüsselwechsel ist bei ACME ein geplanter Ausfall.** Der
  neue Schlüssel existiert erst nach der Neuausstellung, sein Pin ist also
  vorher niemandem bekannt: Ankündigen, dann
  `certbot renew --cert-name <name> --new-key --reuse-key --force-renewal`
  (Caddy: Zertifikat samt Schlüssel aus dem Caddy-Speicher entfernen, siehe
  Caddyfile-Kommentar), Pin des neuen Schlüssels ablesen (Befehl im Kommentar
  des Caddyfile bzw. der `nginx.conf`) und auf **jedem** Arbeitsplatz
  eintragen (`config.json` → `serverKeyPins`; Trust-on-first-use-Arbeitsplätze
  löschen stattdessen ihre `server-pins.json`). Bis dahin startet dort keine
  Desktop-App — also Freitagabend, nicht Montagmorgen. Vorab verteilen lässt
  sich der Pin nur bei einem selbst erzeugten Schlüssel (Firmen-CA,
  statische Dateien — Variante (a) im Caddyfile).

**Beide Varianten setzen `X-Forwarded-For` bewusst mit dem echten
Absender und hängen ihn nicht an einen vom Client mitgeschickten Wert an.**
Das Backend vertraut diesem Header (`trustProxy`) und leitet daraus die
Herkunft für Protokoll und Login-Drosselung ab. Wer die Zeile auf „anhängen"
umstellt, kann sich als beliebige IP ausgeben und die Drosselung umgehen.

## 4. Firewall

| Port | Von wo | Warum |
|---|---|---|
| 443/tcp | Internet bzw. Firmennetz | Portal und API |
| 80/tcp | Internet | ACME-Prüfung und Weiterleitung auf HTTPS |
| 3001/tcp | **niemand** | Das Backend spricht keine TLS und kennt keine Herkunftsprüfung |

Bei einem Ein-Maschinen-Aufbau bleibt `OHRGANIZE_HOST` ungesetzt; das Backend
lauscht dann nur auf `127.0.0.1` und ist von außen selbst ohne Firewall nicht
erreichbar. Die Regeln sind die zweite Sicherung.

```bash
# ufw (Debian/Ubuntu)
ufw allow 80/tcp
ufw allow 443/tcp
ufw deny 3001/tcp
ufw enable

# firewalld (RHEL/Rocky)
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

**Getrennte Maschinen** (Proxy und Backend auf verschiedenen Servern): Erst
dann wird `OHRGANIZE_HOST` gesetzt, und dann ist Port 3001 ausschließlich für die
Proxy-IP zu öffnen — sonst kann jeder im Netz das Backend direkt ansprechen und
über einen selbst gesetzten `X-Forwarded-For` die Login-Drosselung aushebeln.

```bash
ufw allow from 10.0.0.5 to any port 3001 proto tcp   # 10.0.0.5 = Proxy
ufw deny 3001/tcp
```

Zusätzlich ist in diesem Fall `OHRGANIZE_CORS_ORIGIN` Pflicht — das Backend
verweigert sonst den Start (mit genau dieser Begründung im Journal).

## 5. Datensicherung

```bash
install -d -o ohrganize -g ohrganize -m 0700 /var/backups/ohrganize
cp deploy/ohrganize-backup.service deploy/ohrganize-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ohrganize-backup.timer

# Sofort einmal ausführen und zusehen
systemctl start ohrganize-backup.service
journalctl -u ohrganize-backup.service -n 30 --no-pager
systemctl list-timers ohrganize-backup.timer
```

Jeder Lauf legt `/var/backups/ohrganize/ohrganize-JJJJMMTT-HHMMSS/` an mit:

| Inhalt | Warum unverzichtbar |
|---|---|
| `ohrganize.db` | Alle Stamm-, Abwesenheits-, Vergütungs- und Bewerbungsdaten |
| `storage/` | Die Dateien selbst (Verträge, AU-Bescheinigungen, Fotos) |
| `secret.key` | Ohne diese Datei erzeugt oHRganize nach dem Restore still ein neues Secret: Alle Sitzungen und alle bereits verschickten Download-Links sind dann tot |
| `lizenz.ohrganize` (falls vorhanden) | Die signierte Lizenzdatei. Ohne sie läuft der Server nach dem Restore im Nur-Lese-Betrieb — nicht in einer neuen Testphase, denn die Datenbank weiß, dass sie schon lizenziert war (`../docs/lizenzierung.md`) |
| `MANIFEST.txt` | Zeitpunkt, Prüfergebnis, Datensatzzahlen, Restore-Schritte |

Wichtig zu verstehen:

- **Eine Dateikopie von `ohrganize.db` ohne `-wal` ist kein gültiges Backup.**
  Die Datenbank läuft im WAL-Modus; die jüngsten Änderungen stehen dann nur in
  `ohrganize.db-wal`. Das Skript benutzt deshalb die Online-Backup-Schnittstelle
  von SQLite und schreibt einen in sich geschlossenen Stand — die Sicherung
  enthält **absichtlich** keine `-wal`-Datei.
- Die Reihenfolge Datenbank → Dateien ist zwingend und darf nicht getauscht
  werden (die Begründung steht im Kopf von `apps/backend/src/scripts/backup.ts`).
- Der Dienst muss dafür **nicht** angehalten werden.
- `--keep 14` hält vierzehn Läufe vor. **Das ist keine Auslagerung**: Eine
  Sicherung, die nur auf demselben Server liegt, überlebt weder einen
  Plattendefekt noch eine Verschlüsselung durch Ransomware. `/var/backups/ohrganize`
  gehört per `rsync`/`borg`/Bandsicherung täglich auf ein anderes System —
  und weil dort dieselben Personaldaten liegen, mit demselben Schutzniveau
  (verschlüsselt, Zugriff nur für die Administration).

### Restore-Probe

Ein Backup, das nie zurückgespielt wurde, ist eine Vermutung. Die Probe
gehört einmal in die Inbetriebnahme und danach halbjährlich in den Kalender —
**auf einem Test-Server oder in einem zweiten Datenverzeichnis**, nicht im
Produktivsystem.

```bash
# Auf einem beliebigen Rechner mit ausgechecktem Stand:
BACKUP=/var/backups/ohrganize/ohrganize-20260315-023000
PROBE=/tmp/ohrganize-probe
install -d -m 0700 $PROBE
cp -a $BACKUP/ohrganize.db $BACKUP/secret.key $BACKUP/storage $PROBE/
[ -f $BACKUP/lizenz.ohrganize ] && cp -a $BACKUP/lizenz.ohrganize $PROBE/   # falls gesichert

cd /opt/ohrganize/apps/backend
OHRGANIZE_DATA_DIR=$PROBE OHRGANIZE_PORT=3999 node dist/cli.cjs
```

Erwartet: „oHRganize Backend läuft auf http://127.0.0.1:3999". In einem zweiten
Terminal prüfen und danach mit Strg+C beenden:

```bash
curl -sS http://127.0.0.1:3999/api/health
curl -sS -X POST http://127.0.0.1:3999/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"<eigene-adresse>","password":"<eigenes-passwort>"}'
```

Eine Anmeldung mit 200 belegt, dass Datenbank **und** `secret.key` stimmen.
Danach im Portal/Desktop eine Datei öffnen — das belegt `storage/`. Die
Anmeldeantwort enthält `license.state`; steht dort `valid`, ist auch die
Lizenzdatei mitgekommen (`/api/health` ohne Anmeldung nennt nur
`license.read_only`, das unterscheidet Testphase und Lizenz nicht). Zum
Schluss `rm -rf $PROBE`.

### Ernstfall-Restore

```bash
systemctl stop ohrganize-backend
mv /var/lib/ohrganize /var/lib/ohrganize.defekt-$(date +%F)
install -d -o ohrganize -g ohrganize -m 0700 /var/lib/ohrganize
cp -a $BACKUP/ohrganize.db $BACKUP/secret.key $BACKUP/storage /var/lib/ohrganize/
[ -f $BACKUP/lizenz.ohrganize ] && cp -a $BACKUP/lizenz.ohrganize /var/lib/ohrganize/
chown -R ohrganize:ohrganize /var/lib/ohrganize
chmod -R go-rwx /var/lib/ohrganize
systemctl start ohrganize-backend
```

Eventuell vorhandene `ohrganize.db-wal`/`-shm` des **defekten** Standes nicht
mitkopieren — sie gehören zu einer anderen Datenbankdatei und überschreiben
den zurückgespielten Stand.

## 6. Update

```bash
systemctl stop ohrganize-backend
systemctl start ohrganize-backup.service          # Sicherung VOR dem Update
# Prüfsumme IM Verzeichnis des Archivs prüfen: Die .sha256-Datei nennt nur den
# Dateinamen, und sha256sum -c sucht ihn im aktuellen Verzeichnis — aus
# /opt/ohrganize heraus meldet es „No such file“ und FAILED, obwohl das Archiv
# in Ordnung ist. Die folgenden Schritte hängen mit && daran, damit nach einem
# echten FAILED nichts entpackt wird.
(cd /pfad && sha256sum -c ohrganize-server-<version>.zip.sha256) \
  && cd /opt/ohrganize \
  && rm -rf apps \
  && unzip -o /pfad/ohrganize-server-<version>.zip -d /opt/ohrganize \
  && npm ci --omit=dev
# rm -rf apps: Altstand weg (node_modules bleibt), sonst sammeln sich alte
# Portal-Assets an. npm ci: nur nötig, wenn better-sqlite3 gewechselt hat —
# schadet nie.
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"
cp -a apps/web/dist/. /srv/ohrganize-web/
systemctl start ohrganize-backend
journalctl -u ohrganize-backend -n 50 --no-pager  # Migrationen und Startwarnungen prüfen
```

(Eigenbau aus dem Quelltext: `git pull`, `npm ci` ohne `--omit=dev`,
`npm run build -w apps/backend`, `npm run build:web` — siehe den Kasten in
Abschnitt 2.)

Die Datenbankmigrationen laufen automatisch beim Start, in **einer**
Transaktion: Bricht eine ab, bleibt die Datenbank auf dem Stand davor und der
Dienst startet nicht. Die Lizenzdatei liegt im Datenverzeichnis und ist vom
Update nicht betroffen; die Startzeilen im Journal nennen den Lizenzzustand.

**Ein Downgrade ist nicht vorgesehen.** Migrationen sind nicht
rückwärtskompatibel. Startet eine ältere Version gegen eine bereits migrierte
Datenbank, bricht sie jetzt mit einer klaren Meldung ab
(„Die Datenbank wurde bereits von einer neueren oHRganize-Version migriert").
Der Rückweg ist deshalb immer: neuere Version wieder einspielen **oder** das
Backup von vor dem Update zurückspielen (Abschnitt 5) — beides zusammen geht
nicht, die zwischenzeitlichen Änderungen sind dann verloren.

Nach dem Update sehen die Arbeitsplätze die neue Version automatisch; die
Desktop-App wird getrennt verteilt (siehe `../docs/web-portal.md`).

## 7. Betrieb

**Logs**

```bash
journalctl -u ohrganize-backend -f              # Backend (JSON-Zeilen, pino)
journalctl -u ohrganize-backup -n 50            # letzte Sicherung
tail -f /var/log/nginx/ohrganize.access.log     # bzw. /var/log/caddy/ohrganize.access.log
```

**`OHRGANIZE_LOG_LEVEL=warn` ist im Serverbetrieb die richtige Wahl.** Die früher
hier stehende Behauptung, `info` sei Pflicht, weil auf `warn` die
fehlgeschlagenen Anmeldungen fehlten, ist falsch: Sie werden mit `req.log.warn`
geschrieben (`apps/backend/src/core/auth.ts`, Route `POST /api/auth/login`) und
stehen deshalb auch auf `warn` im Protokoll — ebenso die Warnungen beim Start.
`info` bringt umgekehrt einen Nachteil: Dann landet **jede Anfrage** im Log —
Methode, Pfad und Herkunfts-IP. Die Signatur der Download-Links ist dabei nicht
betroffen, das Backend schneidet den Query-String im eigenen `req`-Serializer ab
(`apps/backend/src/server.ts`). Es bleibt aber ein vollständiges Bewegungsprofil:
wer wann welche Personalakte geöffnet hat.

`info` deshalb nur vorübergehend zur Fehlersuche setzen und danach
zurückstellen (Wert in `ohrganize.env` ändern, Dienst neu starten).

**Dateirechte**

`/var/lib/ohrganize` steht auf `0700`, die Dateien darin auf `0600`, und das
Backend zieht das bei jedem Start nach. Das ist Absicht: Dort liegt die
komplette Personalakte im Klartext.

> Folge für den Betrieb: Ein Backup-Agent, ein Monitoring oder ein
> Virenscanner, der als anderer Benutzer läuft, kommt **nicht** hinein. Der
> richtige Weg ist, den Agenten als `ohrganize` laufen zu lassen oder ihn auf
> `/var/backups/ohrganize` zu richten — **nicht** `chmod -R 755 /var/lib/ohrganize`.
> Dieser eine Befehl macht Gehälter und AU-Bescheinigungen für jedes lokale
> Konto lesbar, und der nächste Dienststart stellt es stillschweigend wieder
> zurück, sodass der Fehler unentdeckt bleibt, bis jemand nachsieht.

**Prüfen, ob die Härtung greift**

```bash
# Backend darf von außen NICHT erreichbar sein (erwartet: Verbindungsfehler)
curl -sS --max-time 5 http://<server-ip>:3001/api/health

# Sicherheitskopfzeilen am Proxy
curl -sSI https://portal.firma.de | grep -iE 'strict-transport|content-security|x-content-type|referrer'

# Rechte im Datenverzeichnis
ls -ld /var/lib/ohrganize /var/lib/ohrganize/storage      # erwartet: drwx------

# Absicherung der Dienste (erwartet: 0.9 SAFE bzw. 0.2 SAFE)
systemd-analyze security ohrganize-backend | tail -1
systemd-analyze security ohrganize-backup  | tail -1

# Nach JEDER Änderung an einer Unit — meldet u. a. still verworfene
# Syscall-Gruppen (siehe die Warnung zur Schreibweise in der Unit selbst)
systemd-analyze verify /etc/systemd/system/ohrganize-backend.service
```

Die Units sind über die Standardhärtung hinaus abgesichert: keine
Capabilities, ein Systemaufruf-Filter, unsichtbares `/proc`, eigener
Benutzer-Namensraum und eine Netz-Allowlist auf Loopback; die Sicherung läuft
zusätzlich ganz ohne Netz. Gemessen auf einem Debian-13-Testserver, inklusive
Erstinbetriebnahme, Login mit Audit-Schreibvorgang, Schreiben in `storage/`,
WAL-Checkpoint beim Stoppen und einem Dauerlauf ohne Neustart. Begründung je
Direktive steht in den Units, der Hintergrund in `../docs/entscheidungen.md`.

**Ein Stolperstein:** `IPAddressAllow=localhost` passt zum Normalfall (Proxy
und Backend auf derselben Maschine). Wer beide trennt und `OHRGANIZE_HOST`
setzt, muss die Adresse des Proxys dort ergänzen — sonst weist der Dienst
dessen Verbindungen ab.

### Lizenz

Die Nutzungsberechtigung ist eine vom Anbieter signierte Datei
**`/var/lib/ohrganize/lizenz.ohrganize`** — im Datenverzeichnis, neben
`ohrganize.db` und `secret.key`, mit denselben Rechten (`0600`, Eigentümer
`ohrganize`). Eine frische Installation läuft **30 Tage als Testphase**,
danach im **Nur-Lese-Betrieb** (Einsicht und Export gehen weiter, Änderungen
nicht), bis eine Lizenz eingespielt ist.

- **Einspielen** erledigt die HR-Administration in der Desktop-App unter
  Einstellungen → Lizenz; dafür ist **kein Dienstneustart** nötig. Wird die
  Datei stattdessen von Hand ins Datenverzeichnis kopiert (`install -o
  ohrganize -g ohrganize -m 0600 lizenz-<kunde>.ohrganize
  /var/lib/ohrganize/lizenz.ohrganize`), bemerkt das Backend sie innerhalb
  weniger Sekunden — ebenfalls ohne Neustart.
- **Zustand prüfen:** Ohne Anmeldung liefert `curl -sS
  http://127.0.0.1:3001/api/health` nur `license.read_only` (`false` =
  Änderungen möglich; für Monitoring gedacht, verrät nichts über den
  Vertrag). Den Zustand (`trial`, `valid`, `grace`, `expired`) tragen
  angemeldete Antworten im Header `x-ohrganize-license` und vollständig
  `GET /api/license` bzw. die Anmeldeantwort (`license.state`) — öffentliche
  Antworten haben den Header bewusst nicht, Portal-Konten sehen darin nur
  `valid`/`expired`. Der Startlauf schreibt eine Warnzeile ins Journal, sobald
  etwas Aufmerksamkeit verdient (Testphase, nahender Ablauf,
  Nur-Lese-Betrieb, verstellte Uhr) — der schnellste Blick ohne Token.
- **Sicherung:** `backup.cjs` sichert die Datei automatisch mit (Abschnitt 5);
  beim Restore und beim Umzug gehört sie ins Datenverzeichnis zurück.
- Zustände, Fristen, Bericht für den Anbieter und der Ablauf einer
  Verlängerung: **`../docs/lizenzierung.md`**.

## 8. Wenn etwas nicht startet

| Meldung im Journal | Ursache | Abhilfe |
|---|---|---|
| `OHRGANIZE_HOST ist auf "…" gesetzt … aber OHRGANIZE_CORS_ORIGIN ist leer` | Absicherung: Das Backend wäre aus dem Netz erreichbar, ohne dass die erlaubten Herkünfte feststehen | Origin-Liste setzen — oder `OHRGANIZE_HOST` weglassen, wenn Proxy und Backend auf derselben Maschine laufen |
| `OHRGANIZE_TOKEN_TTL="…" ist ungültig` | Schreibweise wie `1 Stunde` statt `1h` | Sekundenzahl oder `30m`/`1h`/`8h`/`7d` |
| `Die Datenbank wurde bereits von einer neueren oHRganize-Version migriert` | Downgrade | Abschnitt 6 |
| `EADDRINUSE` | Port 3001 belegt (zweite Instanz?) | `ss -tlnp` und nach 3001 sehen |
| `SQLITE_CANTOPEN` / `EACCES` | `OHRGANIZE_DATA_DIR` gehört nicht dem Dienstbenutzer | `chown -R ohrganize:ohrganize /var/lib/ohrganize` |
| `Cannot find module 'better-sqlite3'` | `npm ci --omit=dev` im Programmverzeichnis fehlt (oder lief in einem anderen Verzeichnis) | Abschnitt 2.3 wiederholen |
| `Could not locate the bindings file` (better-sqlite3) | npm ≥ 12 hat das Installationsskript gesperrt — `npm ci` meldete trotzdem Erfolg | `prebuild-install` aus Abschnitt 2.3 nachholen |
| `caddy validate`/`systemctl reload caddy`: `unknown subdirective: reuse_private_keys` | Caddy < 2.8.0 (Distributionspaket 2.6.2) | Caddy aus dem offiziellen Repository installieren (Abschnitt 3, Variante B). Die Zeile **nicht** entfernen — sonst wechselt der Schlüssel bei jeder Erneuerung und alle Desktop-Arbeitsplätze sperren sich aus |
| `NUR-LESE-BETRIEB: …` bzw. `Keine Lizenz eingespielt — Testphase bis …` | Der Dienst startet; er meldet nur den Lizenzzustand | Lizenz einspielen (Abschnitt 7, „Lizenz“; `../docs/lizenzierung.md`). Nach einem Restore: `lizenz.ohrganize` aus der Sicherung ins Datenverzeichnis |
| `Die Systemuhr steht vor einem Datum, das diese Installation bereits gesehen hat` | Uhr zurückgestellt (NTP, VM-Snapshot) | Zeitquelle prüfen; der Dienst läuft weiter, es ist nur eine Warnung |
| Portal zeigt bei `/kalender` einen 404 | SPA-Fallback fehlt im Proxy | `try_files … /index.html` prüfen |
| Portal meldet CORS-Fehler | API läuft nicht same-origin | `OHRGANIZE_CORS_ORIGIN` auf die Portal-Domain setzen (der Wert `null` ist nicht zulässig und wird ignoriert) |
| Desktop-App kommt nicht über den Login hinaus, Portal geht | `ohrganize://app` fehlt in `OHRGANIZE_CORS_ORIGIN` | Eintrag ergänzen: `OHRGANIZE_CORS_ORIGIN=https://portal.firma.de,ohrganize://app`. Die App lädt ihre Oberfläche über ein eigenes Schema und sendet diese Herkunft; ohne den Eintrag bricht der Browserkern jede Anfrage ab. Im Serverlog ist nichts Auffälliges zu sehen — es sieht nach einem Netzwerkproblem aus. |

## 9. Mehrere Kunden auf einem Server (`<kunde>.ohrganize.com`)

Die Abschnitte 1–8 beschreiben **einen** Kunden auf **einem** Server. Für einen
Betrieb mit mehreren Kunden unter einer gemeinsamen Basisdomain gilt derselbe
Aufbau je Kunde — nur eben mehrfach.

> Der **umgekehrte** Fall — der Server steht beim Kunden, nur der Name
> `<kunde>.ohrganize.com` liegt in der Zone des Anbieters — ist ein anderer:
> DNS-only statt Proxy, HTTP-01 statt Wildcard, CAA auf das ACME-Konto des
> Kunden, CT-Überwachung, Pinning der Desktop-App. Das steht in
> **`../docs/kunden-subdomain.md`**.

**Der Grund, warum es nicht anders geht:** oHRganize ist bewusst nicht
mandantenfähig. Ein Node-Prozess, eine SQLite-Datei, ein Datenverzeichnis; es
gibt keine Spalte `mandant_id` und keinen Filter, der Kunden innerhalb einer
Datenbank trennt. Jeder Kunde bekommt deshalb eine **eigene Instanz**. Das ist
kein Provisorium: Die Trennung ist dadurch eine Dateisystem- und
Prozessgrenze und nicht eine Bedingung in jeder einzelnen SQL-Abfrage, die man
genau einmal vergessen muss.

Was sich alle Kunden teilen: den Server, das Programmverzeichnis
`/opt/ohrganize`, den Reverse-Proxy und **ein** Portal-Build. Der Build
enthält nichts Kundenspezifisches — er spricht die API same-origin über den
gerade aufgerufenen Namen an.

| Je Kunde eigen | Pfad |
|---|---|
| Dienst | `ohrganize-backend@<kunde>` |
| Konfiguration | `/etc/ohrganize/kunden/<kunde>.env` |
| Daten (DB, storage/, secret, Lizenz) | `/var/lib/ohrganize/<kunde>` |
| Sicherungen | `/var/backups/ohrganize/<kunde>` |
| Port | 3100 aufwärts, vergeben von `ohrganize-provision.sh` |
| Subdomain | `<kunde>.ohrganize.com` |

### 9.1 Einmalige Einrichtung

Abschnitt 1 und 2 gelten unverändert (Dienstkonto, Archiv nach
`/opt/ohrganize`, `npm ci --omit=dev` samt Kontrollzeile, Portal-Build nach
`/srv/ohrganize-web`). **Nicht** eingerichtet werden für den Mehrkunden-Betrieb:
`ohrganize-backend.service`, `ohrganize-backup.*` und `nginx.conf` — deren
Aufgabe übernehmen die Vorlagen unten.

```bash
# Vorlagen für Dienst und Sicherung
cp deploy/ohrganize-backend@.service /etc/systemd/system/
cp deploy/ohrganize-backup@.service  /etc/systemd/system/
cp deploy/ohrganize-backup@.timer    /etc/systemd/system/
systemctl daemon-reload

# Verzeichnisse
install -d -m 0750 -o root -g ohrganize /etc/ohrganize/kunden
install -d -m 0700 -o ohrganize -g ohrganize /var/backups/ohrganize

# Basisdomain hinterlegen (sonst gilt die Vorgabe ohrganize.com)
printf 'BASIS_DOMAIN="ohrganize.com"\n' > /etc/ohrganize/provision.conf
chmod 0644 /etc/ohrganize/provision.conf

chmod +x deploy/ohrganize-provision.sh
```

### 9.2 DNS

Ein Wildcard-Eintrag zeigt alle Kundennamen auf den Server:

```
*.ohrganize.com.   A     198.51.100.10
*.ohrganize.com.   AAAA  2001:db8::10        # nur wenn IPv6 vorhanden
```

Zwei Fallen:

- **Ein Wildcard deckt genau eine Ebene ab.** `musterfirma.ohrganize.com` ja,
  `hr.musterfirma.ohrganize.com` nein. Kundenschlüssel dürfen deshalb keinen
  Punkt enthalten — das Skript weist solche Namen ab.
- **Die Basisdomain selbst ist nicht mitgemeint.** Wer `ohrganize.com` (ohne
  Subdomain) betreiben will, braucht dafür einen eigenen Eintrag.

### 9.3 Wildcard-Zertifikat (DNS-01)

Ein Wildcard-Zertifikat lässt sich **nur** über die DNS-Prüfung ausstellen;
HTTP-01 kann `*.ohrganize.com` nicht belegen. Dafür braucht certbot ein Plugin
für den DNS-Anbieter und ein API-Token mit Schreibrecht auf die Zone —
Beispiel Cloudflare, andere Anbieter analog:

```bash
apt install -y certbot python3-certbot-dns-cloudflare

install -m 0600 /dev/null /etc/letsencrypt/dns.ini
editor /etc/letsencrypt/dns.ini        # dns_cloudflare_api_token = …

certbot certonly --reuse-key \
  --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/dns.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d '*.ohrganize.com' -d ohrganize.com \
  --deploy-hook 'systemctl reload nginx'

certbot renew --dry-run                # Erneuerung einmal durchspielen
```

- Die Anmeldedaten stehen im Klartext auf dem Server. `0600` und
  Dateieigentümer `root` sind Pflicht; ein Token, das nur diese eine Zone
  bearbeiten darf, begrenzt den Schaden bei einem Servereinbruch.
- Der `--deploy-hook` ist wichtig: Ohne ihn erneuert certbot das Zertifikat
  im Hintergrund, und nginx liefert bis zum nächsten Reload das alte aus —
  bis es abläuft und **alle** Kunden gleichzeitig nicht mehr hereinkommen.
- `--reuse-key` ist ebenso wichtig, und hier wiegt es schwerer als im
  Einzelbetrieb (Abschnitt 3, „Serverschlüssel festnageln“): Die
  Desktop-Arbeitsplätze **aller** Kunden pinnen denselben Schlüssel, weil sie
  sich das Wildcard-Zertifikat teilen. Ohne die Option erneuert certbot nach
  ~60 Tagen mit neuem Schlüssel, der `--deploy-hook` liefert ihn sofort aus,
  und am selben Morgen startet bei keinem Kunden mehr eine HR-Desktop-App.
  Ein bewusster Schlüsselwechsel trifft entsprechend alle Kunden auf einmal
  und ist als gemeinsames Wartungsfenster anzukündigen.
- Der Zertifikatspfad heißt `/etc/letsencrypt/live/ohrganize.com/`, nicht
  `*.ohrganize.com`. Existiert dort schon ein Zertifikat aus einem früheren
  Einzelbetrieb, legt certbot `ohrganize.com-0001` an — dann zeigen die Pfade
  in der nginx-Konfiguration nach der nächsten Erneuerung auf das falsche
  Zertifikat. In dem Fall das alte vorher mit `certbot delete` entfernen.

### 9.4 Reverse-Proxy

```bash
cp deploy/nginx-security-headers.conf /etc/nginx/snippets/ohrganize-security-headers.conf
cp deploy/nginx-wildcard.conf /etc/nginx/conf.d/ohrganize-wildcard.conf
editor /etc/nginx/conf.d/ohrganize-wildcard.conf     # Basisdomain ersetzen

touch /etc/nginx/ohrganize-kunden.map                # MUSS existieren
nginx -t && systemctl reload nginx
```

Ein `server`-Block bedient alle Kunden; welche Instanz antwortet, entscheidet
die Subdomain über `/etc/nginx/ohrganize-kunden.map`. Unbekannte Namen
beantwortet nginx mit 404, statt in einen Fehler zu laufen — ein
Wildcard-Zertifikat beantwortet schließlich auch getippte und längst
gekündigte Namen.

Die Datei kann neben `nginx.conf` aus Abschnitt 3 liegen (alle Zonen- und
Formatnamen tragen den Zusatz `_wc`), falls parallel ein Kunde auf einer
eigenen Domain betrieben wird. **Für Caddy ist der Mehrkunden-Betrieb nicht
vorbereitet** — `deploy/Caddyfile` bleibt die Einzelkunden-Variante.

### 9.5 Kunden anlegen

```bash
/opt/ohrganize/deploy/ohrganize-provision.sh anlegen musterfirma
```

Das Skript vergibt einen freien Port, erzeugt die env-Datei aus
`ohrganize-kunde.env.example`, startet `ohrganize-backend@musterfirma`, wartet
auf dessen `/api/health`, aktiviert die tägliche Sicherung und trägt die
Subdomain in die Map ein. Scheitert ein Schritt, nimmt es die vorherigen
zurück — eine halb angelegte Instanz sähe in der Liste sonst aus wie ein
funktionierender Kunde.

Am Ende gibt es aus, was zur Übergabe gebraucht wird: das erzeugte
Initialpasswort für `admin@ohrganize.de` (Wechsel beim ersten Login erzwungen,
siehe `../docs/inbetriebnahme.md`) und den Inhalt der `config.json` für die
Desktop-Arbeitsplätze des Kunden:

```json
{ "apiBaseUrl": "https://musterfirma.ohrganize.com" }
```

Sie gehört auf jedem HR-Arbeitsplatz nach `%APPDATA%\oHRganize\config.json`.
Damit startet die App **kein** eigenes Backend mehr, sondern arbeitet auf
demselben Server wie das Portal — beide Clients sehen dieselben Daten.
Alternativ per Rollout-Skript die Umgebungsvariable `OHRGANIZE_API_BASE`
setzen; sie schlägt die Datei. Weil der Verkehr der Kunden hier das
Firmennetz verlässt, gehört in dieselbe Datei `serverKeyPins` — der Pin des
Wildcard-Schlüssels, für alle Kunden derselbe (`windows/README.md`,
Abschnitt 7; Voraussetzung `--reuse-key`, Abschnitt 9.3).

Jede Instanz hat ihre eigene Installations-ID und damit ihre eigene
Lizenzdatei (`/var/lib/ohrganize/<kunde>/lizenz.ohrganize`); die Testphase
von 30 Tagen beginnt mit dem Anlegen. Die ID steht nach dem ersten Login
unter Einstellungen → Lizenz, oder direkt über die API (`GET /api/license`
mit dem Token des Kundenadmins) — ein Punkt für die Übergabe, weil der
Anbieter hier zugleich Betreiber ist und die Lizenz gleich mit ausstellen
kann (`../docs/lizenzierung.md`, Abschnitt 3).

Weitere Befehle:

```bash
ohrganize-provision.sh liste                              # Port, Zustand, DB-Größe, letzte Sicherung
ohrganize-provision.sh entfernen musterfirma              # abschalten, Daten bleiben liegen
ohrganize-provision.sh entfernen musterfirma --daten-loeschen   # mit Rückfrage, unwiderruflich
```

`entfernen` löscht **absichtlich** keine Daten: In der Datenbank stehen
Personalakten, deren Aufbewahrungsfristen den Vertrag überdauern können.

### 9.6 Betrieb mit mehreren Kunden

```bash
journalctl -t ohrganize-musterfirma -f                 # Logs genau eines Kunden
systemctl status 'ohrganize-backend@*'                 # Zustand aller Instanzen
systemctl list-timers 'ohrganize-backup@*'             # Sicherungspläne
grep ' musterfirma.ohrganize.com ' /var/log/nginx/ohrganize-wildcard.access.log
```

**Update** (Abschnitt 6 sinngemäß, nur über alle Instanzen):

```bash
kunden() { for f in /etc/ohrganize/kunden/*.env; do basename "$f" .env; done; }

for k in $(kunden); do systemctl start "ohrganize-backup@$k.service"; done   # Sicherung VOR dem Update
for k in $(kunden); do systemctl stop  "ohrganize-backend@$k"; done
# Prüfsumme im Archivverzeichnis prüfen (die .sha256 nennt nur den Dateinamen, Abschnitt 6)
(cd /pfad && sha256sum -c ohrganize-server-<version>.zip.sha256) && cd /opt/ohrganize && rm -rf apps && unzip -o /pfad/ohrganize-server-<version>.zip -d /opt/ohrganize && npm ci --omit=dev
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"
cp -a apps/web/dist/. /srv/ohrganize-web/
for k in $(kunden); do systemctl start "ohrganize-backend@$k"; done
for k in $(kunden); do systemctl is-active "ohrganize-backend@$k" || journalctl -t "ohrganize-$k" -n 30 --no-pager; done
```

Die Migrationen laufen je Instanz beim Start, jeweils in einer Transaktion.
Eine Instanz, die dabei scheitert, hält die anderen nicht auf — deshalb die
Kontrollschleife am Ende: Ohne sie fällt ein einzelner nicht gestarteter
Kunde erst auf, wenn er anruft.

### 9.7 Stand der Erprobung

Der Ablauf aus 9.1–9.6 ist auf einem Debian-13-Testserver (systemd 257,
nginx 1.26.3, Node 20.19.2) vollständig durchgespielt worden — 41 Prüfungen,
keine offen: zwei Kunden anlegen, Portal und API über beide Subdomains,
unbekannte Subdomain, HTTP-Weiterleitung, Rechte auf Datenverzeichnis und
env-Datei, getrennte Secrets, Sicherungslauf samt Inhalt, Neustart aller
Instanzen, Entfernen eines Kunden mit und ohne Datenlöschung, Koexistenz mit
der Einzelkunden-Konfiguration aus Abschnitt 3 sowie die Fehlerfälle
(doppelter Name, ungültiger Schlüssel, Rücknahme nach misslungenem Start,
abgelehnte Löschbestätigung).

Drei Dinge sind dabei aufgefallen und behoben worden: `http2 on;` gibt es
erst ab nginx 1.25.1 und hätte auf allen dokumentierten Zielsystemen den
Start verhindert; `limit_req_status` darf je Kontext nur einmal vorkommen und
kollidierte mit `nginx.conf`; und `entfernen --daten-loeschen` riss Dienst,
Konfiguration und Subdomain ab, BEVOR es nach der Bestätigung fragte.

In einer zweiten Runde außerdem belegt: Die Login-Drosselung wirkt in zwei
Schichten (Backend nach 10 Fehlversuchen, nginx nach dem Burst von rund 30)
und trifft nur die angesprochene Subdomain — ein Kunde von derselben IP bleibt
unbehelligt. Die fünf Sicherheitskopfzeilen stehen auf Portal, API, Assets und
404; der Server nennt keine Version; das Zugriffsprotokoll enthält den
Kundennamen, aber keinen Query-String. 12/55 MB Größenlimits, TLS 1.3, HTTP/2
und IPv6 greifen. Eine Instanz kann unter den Unit-Direktiven weder das
Verzeichnis eines anderen Kunden noch das Programmverzeichnis beschreiben
(„Read-only file system“). Die Sicherung behält nach 16 Läufen genau 14
Stände; der Ernstfall-Restore aus Abschnitt 5 funktioniert je Kunde und
behält das Secret. Hinweis: Wer eine Sicherung von Hand in schneller Folge
startet, läuft in systemds Startlimit (5 Starts je 10 s) — dann
`systemctl reset-failed ohrganize-backup@<kunde>`; der tägliche Timer ist
davon nicht betroffen.

**Nicht** erprobt und beim ersten echten Kunden zu prüfen:

- **certbot mit DNS-01.** Auf dem Testserver stand ein selbst signiertes
  Wildcard-Zertifikat an derselben Stelle; die Ausstellung hängt am
  DNS-Anbieter und ist von hier aus nicht nachstellbar. Damit ungeprüft ist
  auch, dass `--reuse-key` eine **echte** Erneuerung überlebt: nach der
  ersten Erneuerung (~Tag 60) den Pin mit dem Befehl aus der `nginx.conf`
  ablesen und mit dem Wert vom ersten Tag vergleichen — er muss gleich sein.
- **Echtes DNS.** Die Namen wurden mit `curl --resolve` auf 127.0.0.1
  gezeigt, statt über einen Nameserver aufgelöst.
- **Debian 12 und Ubuntu.** Geprüft wurde Debian 13.
- **Das Release-Archiv auf Debian.** Auf dem Testserver lief noch der
  Quelltextweg (`git clone`, `npm ci`, Build). Entpacken, `npm ci --omit=dev`
  mit dem gekürzten Lockfile, die Kontrollzeile für `better-sqlite3`, Start
  von `cli.cjs`, `/api/health` mit `license.read_only: false`, Anmeldung
  (Zustand `trial`) und ein Sicherungslauf mit `backup.cjs` sind am
  13.09.2026 auf der Entwicklungsmaschine (Windows, Node 24.16, npm 12.0.1)
  durchgespielt worden. (Der Header `x-ohrganize-license` stand damals noch
  auf `/api/health`; seit dem Lizenz-Audit tragen ihn nur angemeldete
  Antworten, Abschnitt 7.)
  Offen ist damit nur, ob `better-sqlite3` auf dem Zielsystem ein
  Fertigpaket findet — dieselbe Frage wie beim Quelltextweg (Abschnitt 1).

### 9.8 Was dieser Aufbau nicht leistet

Ehrlich benannt, damit es niemand später herausfinden muss:

- **Alle Instanzen laufen unter demselben Dienstbenutzer** (`ohrganize`). Die
  Trennung zwischen den Kunden ist die Verzeichnisstruktur plus
  `ReadWritePaths` in der Unit — kein Unix-Benutzer je Kunde. Wer eine
  Kompromittierung eines Kunden strikt vom nächsten trennen muss, betreibt je
  Kunde einen Container oder eine VM; die Vorlagen bleiben dieselben.
- **Ein Server ist ein gemeinsamer Ausfallpunkt.** Ein voller Datenträger,
  ein misslungenes Update am Reverse-Proxy oder ein Neustart trifft alle
  Kunden gleichzeitig.
- **Keine gemeinsame Lastgrenze.** Jede Instanz ist ein eigener Node-Prozess;
  ein Kunde mit sehr vielen Anfragen belegt CPU, die den anderen fehlt. Bei
  der geplanten Größenordnung (zwei Kerne, 2 GB je Server) ist das
  unkritisch, bei dreißig aktiven Kunden nicht mehr — dann Instanzen auf
  mehrere Server verteilen, der DNS-Eintrag entscheidet.
- **Kein Self-Service.** Ein Kunde entsteht durch einen Aufruf auf dem Server,
  nicht durch eine Anmeldeseite. Das ist Absicht: Jede automatische
  Bereitstellung müsste Vertragsdaten, Zahlungsstatus und
  Auftragsverarbeitung mit abbilden.
