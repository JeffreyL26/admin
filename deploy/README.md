# HRMONIC — Serverbetrieb

Diese Dateien richten HRMONIC als Dienst auf einem Linux-Server ein: ein
Backend für alle Desktop-Arbeitsplätze der HR-Administration **und** das
Mitarbeitenden-Portal.

Die Erstinbetriebnahme (erste Anmeldung, Konten, Rollen, fachliche Prüfungen)
steht in **`../docs/inbetriebnahme.md`** — diese Datei endet dort, wo der
Dienst läuft.

| Datei | Zweck | Ablage auf dem Server |
|---|---|---|
| `hrmonic-backend.service` | Dienstdefinition des Backends | `/etc/systemd/system/` |
| `hrmonic.env.example` | Vorlage aller Umgebungsvariablen | `/etc/hrmonic/hrmonic.env` |
| `nginx.conf` | Reverse-Proxy (Variante A) | `/etc/nginx/conf.d/hrmonic.conf` |
| `nginx-security-headers.conf` | Kopfzeilen-Snippet für nginx | `/etc/nginx/snippets/hrmonic-security-headers.conf` |
| `Caddyfile` | Reverse-Proxy (Variante B) | `/etc/caddy/Caddyfile` |
| `hrmonic-backup.service` | Sicherungslauf | `/etc/systemd/system/` |
| `hrmonic-backup.timer` | Zeitplan der Sicherung | `/etc/systemd/system/` |

**Vor dem Ausrollen ersetzen** (in `nginx.conf` bzw. `Caddyfile`):

| Platzhalter | Bedeutung |
|---|---|
| `portal.firma.de` | Domain, unter der Portal und API erreichbar sind |
| `it@firma.de` | Postfach für Let's-Encrypt-Meldungen (nur Caddy) |
| `/srv/hrmonic-web` | Zielverzeichnis des Portal-Builds |

Alle übrigen Pfade sind bewusst fest verdrahtet und über alle Dateien hinweg
konsistent:

| Was | Pfad |
|---|---|
| Programm | `/opt/hrmonic` |
| Daten (DB, Dateien, Secret) | `/var/lib/hrmonic` |
| Konfiguration | `/etc/hrmonic/hrmonic.env` |
| Sicherungen | `/var/backups/hrmonic` |
| Dienstbenutzer | `hrmonic:hrmonic` |

---

## 1. Voraussetzungen

- Linux mit systemd (getestete Ziele: Debian 12, Ubuntu 22.04/24.04).
- **Node.js ≥ 20** (`node -v`). Aus der Distribution oder von NodeSource.
- `git` oder ein entpacktes Release-Archiv.
- Build-Werkzeuge für den Fall, dass `better-sqlite3` kein passendes
  Fertigpaket findet: `apt install -y build-essential python3`.
  `better-sqlite3` ist die einzige native Abhängigkeit des Projekts.
- Eine Domain, die auf den Server zeigt, und die Ports 80 und 443 aus dem
  Internet erreichbar (Port 80 wird für die Zertifikatsausstellung gebraucht).
- Ressourcen: 2 CPU-Kerne und 2 GB RAM reichen für die geplante Größenordnung
  bequem. HRMONIC läuft bewusst als **ein** Node-Prozess mit einer
  SQLite-Datei — mehrere Prozesse auf dieselbe Datenbank sind nicht vorgesehen.

## 2. Installation

```bash
# 2.1 Dienstkonto ohne Login-Shell
adduser --system --group --home /var/lib/hrmonic --shell /usr/sbin/nologin hrmonic

# 2.2 Programm ablegen
install -d -o root -g root -m 0755 /opt/hrmonic
git clone <repository-url> /opt/hrmonic     # oder: Release-Archiv nach /opt/hrmonic entpacken
cd /opt/hrmonic

# 2.3 Abhängigkeiten und Build
#     WICHTIG: kein --omit=dev. Der Build braucht esbuild und typescript aus
#     den devDependencies. Ein "npm ci --omit=dev" bricht in Schritt 2.4 ab.
npm ci
npm run build -w apps/backend      # → apps/backend/dist/{cli.cjs,server.cjs,backup.cjs}
npm run build:web                  # → apps/web/dist (statisches Portal)

# 2.4 Portal-Build ausliefern
install -d -o root -g root -m 0755 /srv/hrmonic-web
cp -a apps/web/dist/. /srv/hrmonic-web/

# 2.5 Konfiguration
install -d -o root -g hrmonic -m 0750 /etc/hrmonic
install -o root -g hrmonic -m 0640 deploy/hrmonic.env.example /etc/hrmonic/hrmonic.env
editor /etc/hrmonic/hrmonic.env

# 2.6 Dienst einrichten
cp deploy/hrmonic-backend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hrmonic-backend

# 2.7 Läuft es?
systemctl status hrmonic-backend
curl -sS http://127.0.0.1:3001/api/health     # {"ok":true,"name":"HRMONIC Backend"}
```

> Beim allerersten Start legt HRMONIC den Standard-Admin an und schreibt ein
> **generiertes** Initialpasswort ins Journal und nach
> `/var/lib/hrmonic/initial-admin-password.txt`. Wie es weitergeht, steht in
> `../docs/inbetriebnahme.md`. Das früher dokumentierte Passwort `hrmonic2026`
> existiert nicht mehr.

`/opt/hrmonic` gehört bewusst **root**, nicht dem Dienstbenutzer: Der Dienst
soll sein eigenes Programm nicht überschreiben können. Beschreibbar ist für ihn
nur `/var/lib/hrmonic` (und `/var/backups/hrmonic`).

## 3. Reverse-Proxy

Genau **eine** der beiden Varianten wählen.

### Variante A — nginx

```bash
apt install -y nginx certbot
install -d -m 0755 /etc/nginx/snippets /var/www/certbot
cp deploy/nginx-security-headers.conf /etc/nginx/snippets/hrmonic-security-headers.conf
cp deploy/nginx.conf /etc/nginx/conf.d/hrmonic.conf
editor /etc/nginx/conf.d/hrmonic.conf        # Domain ersetzen

# Zertifikat holen (der HTTP-Server-Block muss dafür schon stehen)
certbot certonly --webroot -w /var/www/certbot -d portal.firma.de

nginx -t && systemctl reload nginx
```

### Variante B — Caddy

```bash
apt install -y caddy
cp deploy/Caddyfile /etc/caddy/Caddyfile
editor /etc/caddy/Caddyfile                  # Domain und E-Mail ersetzen
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy                       # Zertifikat holt Caddy selbst
```

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

Bei einem Ein-Maschinen-Aufbau bleibt `HRMONIC_HOST` ungesetzt; das Backend
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
dann wird `HRMONIC_HOST` gesetzt, und dann ist Port 3001 ausschließlich für die
Proxy-IP zu öffnen — sonst kann jeder im Netz das Backend direkt ansprechen und
über einen selbst gesetzten `X-Forwarded-For` die Login-Drosselung aushebeln.

```bash
ufw allow from 10.0.0.5 to any port 3001 proto tcp   # 10.0.0.5 = Proxy
ufw deny 3001/tcp
```

Zusätzlich ist in diesem Fall `HRMONIC_CORS_ORIGIN` Pflicht — das Backend
verweigert sonst den Start (mit genau dieser Begründung im Journal).

## 5. Datensicherung

```bash
install -d -o hrmonic -g hrmonic -m 0700 /var/backups/hrmonic
cp deploy/hrmonic-backup.service deploy/hrmonic-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hrmonic-backup.timer

# Sofort einmal ausführen und zusehen
systemctl start hrmonic-backup.service
journalctl -u hrmonic-backup.service -n 30 --no-pager
systemctl list-timers hrmonic-backup.timer
```

Jeder Lauf legt `/var/backups/hrmonic/hrmonic-JJJJMMTT-HHMMSS/` an mit:

| Inhalt | Warum unverzichtbar |
|---|---|
| `hrmonic.db` | Alle Stamm-, Abwesenheits-, Vergütungs- und Bewerbungsdaten |
| `storage/` | Die Dateien selbst (Verträge, AU-Bescheinigungen, Fotos) |
| `secret.key` | Ohne diese Datei erzeugt HRMONIC nach dem Restore still ein neues Secret: Alle Sitzungen und alle bereits verschickten Download-Links sind dann tot |
| `MANIFEST.txt` | Zeitpunkt, Prüfergebnis, Datensatzzahlen, Restore-Schritte |

Wichtig zu verstehen:

- **Eine Dateikopie von `hrmonic.db` ohne `-wal` ist kein gültiges Backup.**
  Die Datenbank läuft im WAL-Modus; die jüngsten Änderungen stehen dann nur in
  `hrmonic.db-wal`. Das Skript benutzt deshalb die Online-Backup-Schnittstelle
  von SQLite und schreibt einen in sich geschlossenen Stand — die Sicherung
  enthält **absichtlich** keine `-wal`-Datei.
- Die Reihenfolge Datenbank → Dateien ist zwingend und darf nicht getauscht
  werden (die Begründung steht im Kopf von `apps/backend/src/scripts/backup.ts`).
- Der Dienst muss dafür **nicht** angehalten werden.
- `--keep 14` hält vierzehn Läufe vor. **Das ist keine Auslagerung**: Eine
  Sicherung, die nur auf demselben Server liegt, überlebt weder einen
  Plattendefekt noch eine Verschlüsselung durch Ransomware. `/var/backups/hrmonic`
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
BACKUP=/var/backups/hrmonic/hrmonic-20260315-023000
PROBE=/tmp/hrmonic-probe
install -d -m 0700 $PROBE
cp -a $BACKUP/hrmonic.db $BACKUP/secret.key $BACKUP/storage $PROBE/

cd /opt/hrmonic/apps/backend
HRMONIC_DATA_DIR=$PROBE HRMONIC_PORT=3999 node dist/cli.cjs
```

Erwartet: „HRMONIC Backend läuft auf http://127.0.0.1:3999". In einem zweiten
Terminal prüfen und danach mit Strg+C beenden:

```bash
curl -sS http://127.0.0.1:3999/api/health
curl -sS -X POST http://127.0.0.1:3999/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"<eigene-adresse>","password":"<eigenes-passwort>"}'
```

Eine Anmeldung mit 200 belegt, dass Datenbank **und** `secret.key` stimmen.
Danach im Portal/Desktop eine Datei öffnen — das belegt `storage/`.
Zum Schluss `rm -rf $PROBE`.

### Ernstfall-Restore

```bash
systemctl stop hrmonic-backend
mv /var/lib/hrmonic /var/lib/hrmonic.defekt-$(date +%F)
install -d -o hrmonic -g hrmonic -m 0700 /var/lib/hrmonic
cp -a $BACKUP/hrmonic.db $BACKUP/secret.key $BACKUP/storage /var/lib/hrmonic/
chown -R hrmonic:hrmonic /var/lib/hrmonic
chmod -R go-rwx /var/lib/hrmonic
systemctl start hrmonic-backend
```

Eventuell vorhandene `hrmonic.db-wal`/`-shm` des **defekten** Standes nicht
mitkopieren — sie gehören zu einer anderen Datenbankdatei und überschreiben
den zurückgespielten Stand.

## 6. Update

```bash
systemctl stop hrmonic-backend
systemctl start hrmonic-backup.service          # Sicherung VOR dem Update
cd /opt/hrmonic
git pull                                        # oder neues Archiv entpacken
npm ci                                          # weiterhin ohne --omit=dev
npm run build -w apps/backend
npm run build:web
cp -a apps/web/dist/. /srv/hrmonic-web/
systemctl start hrmonic-backend
journalctl -u hrmonic-backend -n 50 --no-pager  # Migrationen und Startwarnungen prüfen
```

Die Datenbankmigrationen laufen automatisch beim Start, in **einer**
Transaktion: Bricht eine ab, bleibt die Datenbank auf dem Stand davor und der
Dienst startet nicht.

**Ein Downgrade ist nicht vorgesehen.** Migrationen sind nicht
rückwärtskompatibel. Startet eine ältere Version gegen eine bereits migrierte
Datenbank, bricht sie jetzt mit einer klaren Meldung ab
(„Die Datenbank wurde bereits von einer neueren HRMONIC-Version migriert").
Der Rückweg ist deshalb immer: neuere Version wieder einspielen **oder** das
Backup von vor dem Update zurückspielen (Abschnitt 5) — beides zusammen geht
nicht, die zwischenzeitlichen Änderungen sind dann verloren.

Nach dem Update sehen die Arbeitsplätze die neue Version automatisch; die
Desktop-App wird getrennt verteilt (siehe `../docs/web-portal.md`).

## 7. Betrieb

**Logs**

```bash
journalctl -u hrmonic-backend -f              # Backend (JSON-Zeilen, pino)
journalctl -u hrmonic-backup -n 50            # letzte Sicherung
tail -f /var/log/nginx/hrmonic.access.log     # bzw. /var/log/caddy/hrmonic.access.log
```

`HRMONIC_LOG_LEVEL=info` ist im Serverbetrieb Pflicht: Auf `warn` fehlen die
Zeilen zu fehlgeschlagenen Anmeldungen, und genau die will man sehen.

**Dateirechte**

`/var/lib/hrmonic` steht auf `0700`, die Dateien darin auf `0600`, und das
Backend zieht das bei jedem Start nach. Das ist Absicht: Dort liegt die
komplette Personalakte im Klartext.

> Folge für den Betrieb: Ein Backup-Agent, ein Monitoring oder ein
> Virenscanner, der als anderer Benutzer läuft, kommt **nicht** hinein. Der
> richtige Weg ist, den Agenten als `hrmonic` laufen zu lassen oder ihn auf
> `/var/backups/hrmonic` zu richten — **nicht** `chmod -R 755 /var/lib/hrmonic`.
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
ls -ld /var/lib/hrmonic /var/lib/hrmonic/storage      # erwartet: drwx------
```

## 8. Wenn etwas nicht startet

| Meldung im Journal | Ursache | Abhilfe |
|---|---|---|
| `HRMONIC_HOST ist auf "…" gesetzt … aber HRMONIC_CORS_ORIGIN ist leer` | Absicherung: Das Backend wäre aus dem Netz erreichbar, ohne dass die erlaubten Herkünfte feststehen | Origin-Liste setzen — oder `HRMONIC_HOST` weglassen, wenn Proxy und Backend auf derselben Maschine laufen |
| `HRMONIC_TOKEN_TTL="…" ist ungültig` | Schreibweise wie `1 Stunde` statt `1h` | Sekundenzahl oder `30m`/`1h`/`8h`/`7d` |
| `Die Datenbank wurde bereits von einer neueren HRMONIC-Version migriert` | Downgrade | Abschnitt 6 |
| `EADDRINUSE` | Port 3001 belegt (zweite Instanz?) | `ss -tlnp` und nach 3001 sehen |
| `SQLITE_CANTOPEN` / `EACCES` | `HRMONIC_DATA_DIR` gehört nicht dem Dienstbenutzer | `chown -R hrmonic:hrmonic /var/lib/hrmonic` |
| `Cannot find module 'better-sqlite3'` | `npm ci` fehlt, oder es wurde mit `--omit=dev` gebaut | Abschnitt 2.3 wiederholen |
| Portal zeigt bei `/kalender` einen 404 | SPA-Fallback fehlt im Proxy | `try_files … /index.html` prüfen |
| Portal meldet CORS-Fehler | API läuft nicht same-origin | `HRMONIC_CORS_ORIGIN` auf die Portal-Domain setzen (der Wert `null` ist nicht zulässig und wird ignoriert) |
