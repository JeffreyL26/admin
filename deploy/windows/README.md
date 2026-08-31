# HRMONIC — Serverbetrieb unter Windows Server

Gegenstück zu `../README.md` (Linux). **Die fachlichen Erklärungen stehen dort
und sind hier bewusst nicht wiederholt** — was jede Umgebungsvariable bedeutet,
warum die Sicherung ohne `-wal` läuft, warum `X-Forwarded-For` überschrieben und
nicht angehängt wird: alles in `../README.md` und `../hrmonic.env.example`. Zwei
Erklärungen desselben Sachverhalts driften auseinander.

Hier steht nur, **was unter Windows anders ist**.

Die Erstinbetriebnahme (erste Anmeldung, Konten, Rollen) steht unverändert in
`../../docs/inbetriebnahme.md`.

## Was sich gegenüber Linux unterscheidet — und was nicht

Die Anwendung selbst ist plattformneutral: dasselbe Node, dieselbe Datenbank,
dieselben Migrationen, dieselben Umgebungsvariablen. Unterschiedlich sind genau
vier Dinge:

| | Linux | Windows |
|---|---|---|
| Dienst | systemd-Unit | NSSM (`install-service.ps1`) |
| Reverse-Proxy | nginx oder Caddy | Caddy (`Caddyfile`) |
| Zeitplan der Sicherung | systemd-Timer | Aufgabenplanung (`install-backup-task.ps1`) |
| Dateirechte | `chmod 0700` / `UMask=0077` | NTFS-ACLs (`harden-data-dir.ps1`) |

**Der vierte Punkt ist der gefährlichste.** `config.ts` härtet das
Datenverzeichnis beim Start selbst per `chmod` — unter Windows kennt `chmod` nur
das Read-only-Bit, der Aufruf verpufft folgenlos (`chmodQuiet` fängt ihn bewusst
ab). Es gilt dann, was `C:\ProgramData` vererbt: **die Gruppe „Benutzer" darf
lesen.** Jedes lokale Konto auf dem Server könnte `hrmonic.db` öffnen. Unter
Linux erledigt der Dienst das selbst, unter Windows **muss**
`harden-data-dir.ps1` laufen. Ohne diesen Schritt ist die Installation nicht
fertig, sie sieht nur so aus.

## Pfade

| Was | Linux | Windows |
|---|---|---|
| Programm | `/opt/hrmonic` | `C:\Program Files\HRMONIC` |
| Daten | `/var/lib/hrmonic` | `C:\ProgramData\HRMONIC\data` |
| Konfiguration | `/etc/hrmonic/hrmonic.env` | `C:\ProgramData\HRMONIC\hrmonic.env` |
| Sicherungen | `/var/backups/hrmonic` | `C:\ProgramData\HRMONIC\backups` |
| Portal-Build | `/srv/hrmonic-web` | `C:\ProgramData\HRMONIC\web` |
| Protokolle | journald | `C:\ProgramData\HRMONIC\logs` |
| Dienstkonto | `hrmonic:hrmonic` | `NT SERVICE\HRMONIC` (virtuell) |

Das Programmverzeichnis liegt bewusst unter `C:\Program Files`: Dort hat das
Dienstkonto nur Lesezugriff und kann sein eigenes Programm nicht überschreiben —
dieselbe Absicht wie `/opt/hrmonic` unter root.

## 1. Voraussetzungen

- Windows Server 2019 oder neuer (Ziel: 2025).
- **Node.js ≥ 20 LTS**, systemweit installiert (`node -v`). Der MSI-Installer
  legt `node.exe` in den PATH — der Dienst braucht das.
- **NSSM** ([nssm.cc](https://nssm.cc)) — eine einzelne Exe, nach
  `C:\Program Files\nssm\nssm.exe`, und dieses Verzeichnis in den PATH.
- **Caddy für Windows** ([caddyserver.com](https://caddyserver.com/download)) —
  ebenfalls eine einzelne Exe.
- Visual Studio Build Tools **nur**, falls `npm ci` kein Fertigpaket für
  `better-sqlite3` findet. Für aktuelle Node-LTS-Versionen gibt es eines.
- Eine Domain, die auf den Server zeigt, Ports 80 und 443 aus dem Internet
  erreichbar.
- 2 vCPU, 4 GB RAM, 40 GB Platte. (Unter Linux genügen 2 GB — Windows Server
  selbst belegt mehr.)

## 2. Installation

Alle Schritte in einer **Administrator**-PowerShell.

```powershell
# 2.1 Programm ablegen
New-Item -ItemType Directory 'C:\Program Files\HRMONIC' -Force
git clone <repository-url> 'C:\Program Files\HRMONIC'
Set-Location 'C:\Program Files\HRMONIC'

# 2.2 Abhängigkeiten und Build
#     WICHTIG: kein --omit=dev. Der Build braucht esbuild und typescript aus
#     den devDependencies.
npm ci
npm run build -w apps/backend
npm run build:web

# 2.3 Portal-Build ausliefern
New-Item -ItemType Directory 'C:\ProgramData\HRMONIC\web' -Force
Copy-Item 'apps\web\dist\*' 'C:\ProgramData\HRMONIC\web' -Recurse -Force

# 2.4 Konfiguration
New-Item -ItemType Directory 'C:\ProgramData\HRMONIC' -Force
Copy-Item 'deploy\windows\hrmonic.env.example' 'C:\ProgramData\HRMONIC\hrmonic.env'
notepad 'C:\ProgramData\HRMONIC\hrmonic.env'

# 2.5 Dienst einrichten (setzt am Ende auch die NTFS-Rechte)
.\deploy\windows\install-service.ps1

# 2.6 Läuft es?
Get-Service HRMONIC
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

Schritt 2.2 erzeugt `apps\backend\dist\` mit `cli.cjs` (Diensteinstieg),
`server.cjs` (Embedding-Bundle der Desktop-App) und `backup.cjs`.

> Beim allerersten Start legt HRMONIC den Standard-Admin an und schreibt ein
> **generiertes** Initialpasswort ins Protokoll und nach
> `C:\ProgramData\HRMONIC\data\initial-admin-password.txt`. Weiter geht es in
> `../../docs/inbetriebnahme.md`.

**Eine Falle, die es unter Linux nicht gibt:** systemd liest die
`EnvironmentFile` bei jedem Start neu. NSSM speichert die Werte **einmalig in
der Registry**. Ein Dienstneustart übernimmt Änderungen an `hrmonic.env` also
**nicht** — nach jeder Änderung `install-service.ps1` erneut ausführen. Das
Skript ist idempotent und dafür gedacht.

## 3. Reverse-Proxy (Caddy)

```powershell
New-Item -ItemType Directory 'C:\ProgramData\Caddy' -Force
Copy-Item 'deploy\windows\Caddyfile' 'C:\ProgramData\Caddy\Caddyfile'
notepad 'C:\ProgramData\Caddy\Caddyfile'
```

Domain und E-Mail ersetzen, dann prüfen und als Dienst einhängen:

```powershell
caddy validate --config 'C:\ProgramData\Caddy\Caddyfile'
nssm install Caddy 'C:\Program Files\Caddy\caddy.exe' run --config 'C:\ProgramData\Caddy\Caddyfile'
nssm set Caddy Start SERVICE_AUTO_START
nssm start Caddy
```

Caddy holt und erneuert das Zertifikat selbst — kein certbot, kein win-acme,
keine Aufgabenplanung dafür.

## 4. Firewall

| Port | Von wo | Warum |
|---|---|---|
| 443/tcp | Internet | Portal und API |
| 80/tcp | Internet | ACME-Prüfung und Weiterleitung auf HTTPS |
| 3001/tcp | **niemand** | Das Backend spricht kein TLS und kennt keine Herkunftsprüfung |

```powershell
New-NetFirewallRule -DisplayName 'HRMONIC HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName 'HRMONIC ACME' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName 'HRMONIC Backend sperren' -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Block
```

Bleibt `HRMONIC_HOST` ungesetzt, lauscht das Backend ohnehin nur auf
`127.0.0.1`. Die Regel ist die zweite Sicherung.

## 5. Datensicherung

```powershell
.\deploy\windows\install-backup-task.ps1
Start-ScheduledTask -TaskName 'HRMONIC-Sicherung'
Get-ChildItem 'C:\ProgramData\HRMONIC\backups' | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

Inhalt und Logik sind identisch zur Linux-Fassung — siehe `../README.md`,
Abschnitt 5. Insbesondere gilt unverändert: **Eine Dateikopie von `hrmonic.db`
ohne `-wal` ist kein gültiges Backup**, und `--keep 14` ist **keine
Auslagerung**.

Der Windows-typische Weg für die Auslagerung: Die VM läuft ohnehin in der
Sicherung des Hauses (Veeam o. ä.). Es genügt, wenn diese
`C:\ProgramData\HRMONIC\backups` mitnimmt. Wichtig ist die Reihenfolge — erst
erzeugt die Aufgabe den konsistenten Stand, dann holt ihn die Haussicherung ab.

Die `MANIFEST.txt` jeder Sicherung nennt die Restore-Schritte für das System,
auf dem sie erstellt wurde — unter Windows also PowerShell und `nssm`, nicht
`systemctl`.

## 6. Update

```powershell
nssm stop HRMONIC
Start-ScheduledTask -TaskName 'HRMONIC-Sicherung'
Set-Location 'C:\Program Files\HRMONIC'
git pull
npm ci
npm run build -w apps/backend
npm run build:web
Copy-Item 'apps\web\dist\*' 'C:\ProgramData\HRMONIC\web' -Recurse -Force
nssm start HRMONIC
Get-Content 'C:\ProgramData\HRMONIC\logs\backend.log' -Tail 50
```

Die Sicherung läuft bewusst **vor** dem Update. Migrationen laufen automatisch
beim Start in **einer** Transaktion; bricht eine ab, bleibt die Datenbank auf
dem Stand davor und der Dienst startet nicht. **Ein Downgrade ist nicht
vorgesehen** — der Rückweg ist immer das Backup von vor dem Update.

Hat sich `MIN_CLIENT_VERSION` erhöht (`packages/shared/src/version.ts`), weist
der Server ältere Desktop-Apps nach dem Update mit einer klaren Meldung ab. Die
Reihenfolge ist deshalb immer: **erst der Server, dann die Arbeitsplätze.**

## 7. Betrieb

```powershell
Get-Content 'C:\ProgramData\HRMONIC\logs\backend.log' -Tail 50 -Wait
Get-ScheduledTaskInfo -TaskName 'HRMONIC-Sicherung'
Get-Content 'C:\ProgramData\HRMONIC\logs\caddy-access.log' -Tail 50
```

`LastTaskResult` von `0` bedeutet, dass die Sicherung durchlief.

**Rechte prüfen** — der wichtigste wiederkehrende Check:

```powershell
icacls 'C:\ProgramData\HRMONIC\data'
```

Erwartet werden **nur** `NT AUTHORITY\SYSTEM`, die Administratoren-Gruppe und
`NT SERVICE\HRMONIC`. Taucht dort `Benutzer` oder `Users` auf, ist das
Verzeichnis offen — dann `harden-data-dir.ps1` erneut ausführen.

> Folge für den Betrieb: Ein Backup-Agent, ein Monitoring oder ein
> Virenscanner, der unter einem anderen Konto läuft, kommt **nicht** hinein.
> Der richtige Weg ist, ihn auf `C:\ProgramData\HRMONIC\backups` zu richten —
> **nicht** die Vererbung wieder einzuschalten. Ein `icacls /reset` macht
> Gehälter und AU-Bescheinigungen für jedes lokale Konto lesbar, und anders als
> unter Linux zieht der nächste Dienststart das **nicht** wieder zurecht.

**Erreichbarkeit von außen prüfen** (erwartet: Verbindungsfehler):

```powershell
Invoke-WebRequest "http://$env:COMPUTERNAME:3001/api/health" -TimeoutSec 5
```

## 8. Wenn etwas nicht startet

Die fachlichen Startfehler (CORS, Token-Laufzeit, Downgrade, `SQLITE_CANTOPEN`)
stehen in `../README.md`, Abschnitt 8 — sie gelten unverändert. Windows-eigen
sind diese:

| Symptom | Ursache | Abhilfe |
|---|---|---|
| Dienst startet und stoppt sofort | `node.exe` nicht im PATH des Dienstkontos | Vollen Pfad setzen: `nssm set HRMONIC Application "C:\Program Files\nodejs\node.exe"` |
| Änderung an `hrmonic.env` wirkt nicht | NSSM hält die Werte in der Registry | `install-service.ps1` erneut ausführen |
| `SQLITE_CANTOPEN` / `EACCES` | Dienstkonto hat keine NTFS-Rechte | `harden-data-dir.ps1` ausführen |
| Sicherung läuft, Verzeichnis bleibt leer | Aufgabe hat anderes `HRMONIC_DATA_DIR` als der Dienst | Beide Werte vergleichen |
| `nssm` meldet `OpenSCManager` | PowerShell ohne Administratorrechte | Als Administrator starten |
| Umlaute in `.ps1` erscheinen als Kraut | PowerShell 5.1 liest `.ps1` ohne BOM als ANSI | Die Skripte hier sind deshalb umlautfrei — beim Erweitern so lassen |
| `MODULE_NOT_FOUND: better-sqlite3` | `npm ci` fehlt oder lief mit `--omit=dev` | Schritt 2.2 wiederholen |
| Portal zeigt bei `/kalender` einen 404 | SPA-Fallback fehlt | `try_files` im Caddyfile prüfen |

## Was hier noch NICHT verifiziert ist

Der Ehrlichkeit halber: Verifiziert sind das Backend im Standalone-Betrieb unter
Windows, das Sicherungsskript samt Restore-Probe und die NTFS-Härtung — alles
auf einer Windows-11-Maschine, auf der sich Node und NTFS wie auf Windows Server
verhalten.

**Nicht** durchgespielt sind die Dienstregistrierung über NSSM, die geplante
Aufgabe und Caddy mit einem echten Zertifikat. Dafür braucht es eine
Windows-Server-VM mit öffentlicher Domain. Diese drei Schritte gehören dort
einmal komplett durchlaufen, bevor jemand auf eine Kundenmaschine geht.
