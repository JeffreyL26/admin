# oHRganize — Serverbetrieb unter Windows Server

Gegenstück zu `../README.md` (Linux). **Die fachlichen Erklärungen stehen dort
und sind hier bewusst nicht wiederholt** — was jede Umgebungsvariable bedeutet,
warum die Sicherung ohne `-wal` läuft, warum `X-Forwarded-For` überschrieben und
nicht angehängt wird: alles in `../README.md` und `../ohrganize.env.example`. Zwei
Erklärungen desselben Sachverhalts driften auseinander.

Hier steht nur, **was unter Windows anders ist**.

Die Erstinbetriebnahme (erste Anmeldung, Konten, Rollen) steht in
`../../docs/inbetriebnahme.md`. Sie gilt fachlich unverändert und führt beide
Befehlsfassungen — Linux und PowerShell — nebeneinander auf.

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
lesen.** Jedes lokale Konto auf dem Server könnte `ohrganize.db` öffnen. Unter
Linux erledigt der Dienst das selbst, unter Windows **muss**
`harden-data-dir.ps1` laufen. Ohne diesen Schritt ist die Installation nicht
fertig, sie sieht nur so aus.

## Pfade

| Was | Linux | Windows |
|---|---|---|
| Programm | `/opt/ohrganize` | `C:\Program Files\oHRganize` |
| Daten | `/var/lib/ohrganize` | `C:\ProgramData\oHRganize\data` |
| Konfiguration | `/etc/ohrganize/ohrganize.env` | `C:\ProgramData\oHRganize\ohrganize.env` |
| Sicherungen | `/var/backups/ohrganize` | `C:\ProgramData\oHRganize\backups` |
| Portal-Build | `/srv/ohrganize-web` | `C:\ProgramData\oHRganize\web` |
| Protokolle | journald | `C:\ProgramData\oHRganize\logs` |
| Dienstkonto | `ohrganize:ohrganize` | `NT SERVICE\oHRganize` (virtuell) |

Das Programmverzeichnis liegt bewusst unter `C:\Program Files`: Dort hat das
Dienstkonto nur Lesezugriff und kann sein eigenes Programm nicht überschreiben —
dieselbe Absicht wie `/opt/ohrganize` unter root.

## 1. Voraussetzungen

- Windows Server 2019 oder neuer (Ziel: 2025).
- **Node.js ≥ 20 LTS**, systemweit installiert (`node -v`). Der MSI-Installer
  legt `node.exe` in den PATH — der Dienst braucht das.
- **NSSM** ([nssm.cc](https://nssm.cc)) — eine einzelne Exe, nach
  `C:\Program Files\nssm\nssm.exe`, und dieses Verzeichnis in den PATH.
- **Caddy für Windows** ([caddyserver.com](https://caddyserver.com/download)) —
  ebenfalls eine einzelne Exe.
- **Git for Windows** ([git-scm.com](https://git-scm.com/download/win)) — Schritt
  2.1 klont damit das Repository, und Abschnitt 6 aktualisiert damit. Wer
  stattdessen ein Release-Archiv entpackt, braucht es nicht; dann entfallen
  `git clone` und `git pull`.
- Visual Studio Build Tools **nur**, falls `npm ci` kein Fertigpaket für
  `better-sqlite3` findet. Für aktuelle Node-LTS-Versionen gibt es eines.
- Eine Domain, die auf den Server zeigt, Ports 80 und 443 aus dem Internet
  erreichbar.
- 2 vCPU, 4 GB RAM, 40 GB Platte. (Unter Linux genügen 2 GB — Windows Server
  selbst belegt mehr.)

**Heruntergeladene `.ps1` freigeben.** Kommen die Skripte aus diesem Verzeichnis
über den Browser oder eine Dateifreigabe auf den Server, hängt Windows ihnen die
Zone-Kennung „aus dem Internet" an; PowerShell verweigert dann die Ausführung
oder fragt bei jedem Aufruf nach. Einmal entfernen:

```powershell
Get-ChildItem 'C:\Program Files\oHRganize\deploy\windows\*.ps1' | Unblock-File
```

Aus einem `git clone` heraus entsteht die Kennung nicht — dieser Schritt gilt
nur für den Weg über Download oder Netzlaufwerk.

**`git` in `C:\Program Files`.** Git prüft seit 2.35.2, ob das Repository
demselben Konto gehört wie der aufrufende Benutzer. `C:\Program Files` gehört
`TrustedInstaller`, nicht dem Administrator — `git pull` kann dort deshalb mit
`detected dubious ownership in repository` abbrechen. Abhilfe, einmalig in der
Administrator-PowerShell:

```powershell
git config --global --add safe.directory 'C:/Program Files/oHRganize'
```

(Schrägstriche wie hier, nicht Backslashes — Git erwartet den Pfad in dieser
Schreibweise.) **Noch nicht auf Windows Server verifiziert**, siehe den Abschnitt
„Was hier noch NICHT verifiziert ist" am Ende: Ob der Fall auftritt, hängt davon
ab, wie das Verzeichnis angelegt wurde und unter welchem Konto geklont wird.

## 2. Installation

Alle Schritte in einer **Administrator**-PowerShell.

```powershell
# 2.1 Programm ablegen
New-Item -ItemType Directory 'C:\Program Files\oHRganize' -Force
git clone <repository-url> 'C:\Program Files\oHRganize'
Set-Location 'C:\Program Files\oHRganize'

# 2.2 Abhängigkeiten und Build
#     WICHTIG: kein --omit=dev. Der Build braucht esbuild und typescript aus
#     den devDependencies.
npm ci
npm run build -w apps/backend
npm run build:web

# 2.3 Portal-Build ausliefern
New-Item -ItemType Directory 'C:\ProgramData\oHRganize\web' -Force
Copy-Item 'apps\web\dist\*' 'C:\ProgramData\oHRganize\web' -Recurse -Force

# 2.4 Konfiguration
New-Item -ItemType Directory 'C:\ProgramData\oHRganize' -Force
Copy-Item 'deploy\windows\ohrganize.env.example' 'C:\ProgramData\oHRganize\ohrganize.env'
notepad 'C:\ProgramData\oHRganize\ohrganize.env'

# 2.5 Dienst einrichten (setzt zuerst die NTFS-Rechte, dann den Dienst)
.\deploy\windows\install-service.ps1

# 2.6 Läuft es?
Get-Service oHRganize
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

Schritt 2.2 erzeugt `apps\backend\dist\` mit `cli.cjs` (Diensteinstieg),
`server.cjs` (Embedding-Bundle der Desktop-App) und `backup.cjs`.

> Beim allerersten Start legt oHRganize den Standard-Admin an und schreibt ein
> **generiertes** Initialpasswort ins Protokoll und nach
> `C:\ProgramData\oHRganize\data\initial-admin-password.txt`. Weiter geht es in
> `../../docs/inbetriebnahme.md`.

**Eine Falle, die es unter Linux nicht gibt:** systemd liest die
`EnvironmentFile` bei jedem Start neu. NSSM speichert die Werte **einmalig in
der Registry**. Ein Dienstneustart übernimmt Änderungen an `ohrganize.env` also
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
New-NetFirewallRule -DisplayName 'oHRganize HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName 'oHRganize ACME' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName 'oHRganize Backend sperren' -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Block
```

Bleibt `OHRGANIZE_HOST` ungesetzt, lauscht das Backend ohnehin nur auf
`127.0.0.1`. Die Regel ist die zweite Sicherung.

## 5. Datensicherung

```powershell
.\deploy\windows\install-backup-task.ps1
Start-ScheduledTask -TaskName 'oHRganize-Sicherung'
Get-ChildItem 'C:\ProgramData\oHRganize\backups' | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

Inhalt und Logik sind identisch zur Linux-Fassung — siehe `../README.md`,
Abschnitt 5. Insbesondere gilt unverändert: **Eine Dateikopie von `ohrganize.db`
ohne `-wal` ist kein gültiges Backup**, und `--keep 14` ist **keine
Auslagerung**.

Der Windows-typische Weg für die Auslagerung: Die VM läuft ohnehin in der
Sicherung des Hauses (Veeam o. ä.). Es genügt, wenn diese
`C:\ProgramData\oHRganize\backups` mitnimmt. Wichtig ist die Reihenfolge — erst
erzeugt die Aufgabe den konsistenten Stand, dann holt ihn die Haussicherung ab.

Die `MANIFEST.txt` jeder Sicherung nennt die Restore-Schritte für das System,
auf dem sie erstellt wurde — unter Windows also PowerShell und `nssm`, nicht
`systemctl`.

### Restore-Probe

Gegenstück zu `../README.md`, Abschnitt 5. Ein Backup, das nie zurückgespielt
wurde, ist eine Vermutung; die Probe gehört einmal in die Inbetriebnahme und
danach halbjährlich in den Kalender.

Zwei Dinge sind dabei nicht verhandelbar: ein **eigenes Datenverzeichnis** und
ein **eigener Port**. Sonst schreibt die Probe in den Produktivbestand oder
kollidiert mit dem laufenden Dienst auf 3001.

Im Probeverzeichnis liegen echte Personaldaten. Es erbt die Rechte seines
Elternordners und ist deshalb genauso zu härten wie das Produktivverzeichnis —
und danach zu löschen.

```powershell
$Backup = 'C:\ProgramData\oHRganize\backups\ohrganize-20260315-023000'
$Probe  = 'C:\ProgramData\oHRganize\probe'

New-Item -ItemType Directory $Probe -Force | Out-Null

# Vererbung kappen, BEVOR die Daten hineinkommen: Das Verzeichnis erbt sonst
# den Lesezugriff der Gruppe "Benutzer" von C:\ProgramData. Konten als SID,
# weil die Administratorengruppe je nach Sprachversion anders heisst - dieselbe
# Begruendung wie in harden-data-dir.ps1. (Das Skript selbst passt hier nicht:
# Es haertet immer auch Log- und Konfigurationspfad.)
icacls $Probe /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F'     | Out-Null   # SYSTEM
icacls $Probe /grant:r      '*S-1-5-32-544:(OI)(CI)F'           | Out-Null   # Administratoren

Copy-Item "$Backup\ohrganize.db","$Backup\secret.key" $Probe
Copy-Item "$Backup\storage" $Probe -Recurse

# OHRGANIZE_DATA_DIR ausdruecklich setzen: Ohne die Variable faellt das Backend
# auf sein Vorgabe-Datenverzeichnis zurueck und legte dort eine leere Datenbank
# an — die Probe liefe dann gegen den falschen Bestand und belegte nichts.
$env:OHRGANIZE_DATA_DIR = $Probe
$env:OHRGANIZE_PORT     = '3999'
node 'C:\Program Files\oHRganize\apps\backend\dist\cli.cjs'
```

Erwartet: „oHRganize Backend läuft auf http://127.0.0.1:3999". In einem **zweiten**
PowerShell-Fenster prüfen, danach das erste mit Strg+C beenden:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3999/api/health'

$body = @{ email = '<eigene-adresse>'; password = '<eigenes-passwort>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3999/api/auth/login' `
  -ContentType 'application/json' -Body $body
```

Eine Anmeldung, die ein Token liefert, belegt Datenbank **und** `secret.key`.
Danach in der Desktop-App gegen `http://127.0.0.1:3999` eine Datei öffnen — das
belegt `storage\`. Zum Schluss aufräumen:

```powershell
Remove-Item $Probe -Recurse -Force
Remove-Item Env:\OHRGANIZE_DATA_DIR, Env:\OHRGANIZE_PORT
```

Das zweite `Remove-Item` betrifft nur die Variablen dieser einen Sitzung.
Sicherheitshalber das Fenster schließen.

### Ernstfall-Restore

```powershell
nssm stop oHRganize
Rename-Item 'C:\ProgramData\oHRganize\data' "data.defekt-$(Get-Date -Format yyyy-MM-dd)"

New-Item -ItemType Directory 'C:\ProgramData\oHRganize\data' -Force | Out-Null
Copy-Item "$Backup\ohrganize.db","$Backup\secret.key" 'C:\ProgramData\oHRganize\data'
Copy-Item "$Backup\storage" 'C:\ProgramData\oHRganize\data' -Recurse

# Das frisch angelegte Verzeichnis erbt die Rechte von C:\ProgramData —
# also inklusive Lesezugriff der Gruppe "Benutzer". Ohne diesen Aufruf ist der
# Restore nicht fertig, er sieht nur so aus.
& 'C:\Program Files\oHRganize\deploy\windows\harden-data-dir.ps1'

nssm start oHRganize
Get-Content 'C:\ProgramData\oHRganize\logs\backend.log' -Tail 50
```

Eventuell vorhandene `ohrganize.db-wal`/`-shm` des **defekten** Standes nicht
mitkopieren — sie gehören zu einer anderen Datenbankdatei und überschreiben den
zurückgespielten Stand. In einem Sicherungsordner gibt es sie ohnehin nicht: Das
Sicherungsskript schreibt über die Online-Backup-Schnittstelle von SQLite einen
in sich geschlossenen Stand. (Beim **Umzug einer laufenden Einzelplatz-App** gilt
das Gegenteil — siehe Abschnitt 8.)

## 6. Update

```powershell
nssm stop oHRganize
Start-ScheduledTask -TaskName 'oHRganize-Sicherung'
Set-Location 'C:\Program Files\oHRganize'
git pull
npm ci
npm run build -w apps/backend
npm run build:web
Copy-Item 'apps\web\dist\*' 'C:\ProgramData\oHRganize\web' -Recurse -Force
nssm start oHRganize
Get-Content 'C:\ProgramData\oHRganize\logs\backend.log' -Tail 50
```

Die Sicherung läuft bewusst **vor** dem Update. Migrationen laufen automatisch
beim Start in **einer** Transaktion; bricht eine ab, bleibt die Datenbank auf
dem Stand davor und der Dienst startet nicht. **Ein Downgrade ist nicht
vorgesehen** — der Rückweg ist immer das Backup von vor dem Update.

Hat sich `MIN_CLIENT_VERSION` erhöht (`packages/shared/src/version.ts`), weist
der Server ältere Desktop-Apps nach dem Update mit einer klaren Meldung ab. Die
Reihenfolge ist deshalb immer: **erst der Server, dann die Arbeitsplätze.**

## 7. Arbeitsplätze einrichten

Die HR-Administration arbeitet in der Desktop-App. Sie muss auf den Server
zeigen — sonst startet sie ihr **eigenes eingebettetes Backend** und legt eine
lokale Datenbank in `%APPDATA%\oHRganize\data` an. Das scheitert nicht, es fällt
nur monatelang niemandem auf: Zwei Personen pflegen dieselben Mitarbeitenden in
zwei getrennten Datenbeständen.

**Deshalb: Serveradresse setzen, bevor die App das erste Mal startet.**

1. Installer ausführen (`oHRganize Setup <Version>.exe` aus
   `apps\desktop\release`). Danach die App **noch nicht öffnen**.
2. Serveradresse hinterlegen — eine der beiden Quellen genügt:

   | Quelle | Wofür | Reichweite |
   |---|---|---|
   | Maschinenvariable `OHRGANIZE_API_BASE` | Rollout per Gruppenrichtlinie oder Skript | ganzer Rechner |
   | `%APPDATA%\oHRganize\config.json` mit `{ "apiBaseUrl": "https://portal.firma.de" }` | Einrichtung von Hand, je Benutzerprofil | ein Windows-Profil |

   **Die Umgebungsvariable gewinnt**, wenn beides gesetzt ist
   (`readConfiguredApiBase` in `apps/desktop/src/main.ts`). Wer eine falsche
   Adresse in der Variablen sucht, während er die `config.json` korrigiert,
   sucht lange.

   Von Hand:

   ```powershell
   New-Item -ItemType Directory "$env:APPDATA\oHRganize" -Force | Out-Null
   '{ "apiBaseUrl": "https://portal.firma.de" }' |
     Set-Content "$env:APPDATA\oHRganize\config.json" -Encoding utf8
   ```

   Per Gruppenrichtlinie/Skript (Computerkonfiguration → Einstellungen →
   Umgebung, oder einmalig als Administrator):

   ```powershell
   [Environment]::SetEnvironmentVariable('OHRGANIZE_API_BASE', 'https://portal.firma.de', 'Machine')
   ```

3. App starten und anmelden.
4. Kontrolle — **es darf kein lokales Datenverzeichnis entstanden sein**:

   ```powershell
   Test-Path "$env:APPDATA\oHRganize\data"     # erwartet: False
   ```

   Steht dort `True`, lief die App mindestens einmal ohne Konfiguration. Dann:
   App schließen, Adresse setzen, das Verzeichnis löschen (es enthält nur die
   frisch angelegte, leere Datenbank) und neu starten. **Ausnahme:** Wurde in
   dieser lokalen Datenbank bereits mit Echtdaten gearbeitet, nichts löschen —
   dann gilt Abschnitt 8.

**Regeln für die Adresse**

- Nur `https://` — im lokalen Test auch `http://127.0.0.1:3001`, aber niemals
  ungesichertes `http://` über das Netz: Darüber gehen Anmeldedaten und
  vollständige Personalakten.
- **Kein Schrägstrich am Ende.** `https://portal.firma.de/` erzeugt Aufrufe
  gegen `…//api/health`; der Proxy antwortet darauf nicht wie erwartet.
- Kein Pfad, kein Port, wenn der Proxy auf 443 lauscht — nur der Ursprung.

**`OHRGANIZE_CORS_ORIGIN` gehört NICHT auf einen Arbeitsplatz.** Das ist eine
**Server**-Variable. Steht sie auf einem Arbeitsplatz, erbt sie das in die App
eingebettete Backend und sperrt den eigenen Renderer aus — die App kommt dann
nicht über den Login hinaus, und im Serverlog ist nichts zu sehen. Gehört auf
demselben Rechner sowohl Server als auch Arbeitsplatz (nur im Testaufbau
sinnvoll), muss `ohrganize://app` mit in der Liste stehen (siehe
`../../docs/web-portal.md`).

**Reihenfolge bei Updates:** erst der Server, dann die Arbeitsplätze
(Abschnitt 6). Umgekehrt weist ein Arbeitsplatz mit zu **neuer** App den
Serverstand ab — dieselbe Prüfung, andere Richtung.

## 8. Umzug einer Einzelplatz-Installation

Der häufige Fall: Die HR hat die Desktop-App schon eine Weile **ohne Server**
benutzt, mit echten Personaldaten in `%APPDATA%\oHRganize\data`. Diese Daten
sollen auf den Server. Dann wird **das gesamte Datenverzeichnis** übernommen,
nicht nur die Datenbankdatei.

**Bei geschlossener App** (die SQLite-Datei ist sonst gesperrt) kopieren:

| Was | Warum |
|---|---|
| `ohrganize.db` | die Daten |
| `ohrganize.db-wal`, `ohrganize.db-shm` | **die jüngsten Änderungen** — siehe unten |
| `storage\` | Verträge, AU-Bescheinigungen, Fotos |
| `secret.key` | ohne sie erzeugt der Server ein neues Secret: alle Sitzungen und alle verschickten Download-Links sind tot |

**Warum hier `-wal` mitmuss — und beim Restore nicht.** Das sind zwei
verschiedene Fälle, und wer sie verwechselt, verliert Daten:

- **Umzug einer laufenden Installation:** Die Desktop-App beendet ihr
  eingebettetes Backend, ohne einen WAL-Checkpoint zu erzwingen. Die zuletzt
  erfassten Änderungen stehen deshalb **nur** in `ohrganize.db-wal`. Wer allein
  `ohrganize.db` mitnimmt, verliert sie stillschweigend — die Datei ist für sich
  gültig, nur eben älter. Also: `-wal` und `-shm` mitkopieren.
- **Restore aus einem Sicherungsordner:** Dort gibt es keine `-wal`-Datei, weil
  das Sicherungsskript über die Online-Backup-Schnittstelle von SQLite einen in
  sich geschlossenen Stand schreibt. Taucht dort trotzdem eine auf, gehört sie
  zu einer **anderen** Datenbankdatei und würde den zurückgespielten Stand
  zerstören — nicht mitkopieren (Abschnitt 5, „Ernstfall-Restore").

Ablauf:

```powershell
# Auf dem Arbeitsplatz, App geschlossen: das ganze Verzeichnis einpacken
Compress-Archive "$env:APPDATA\oHRganize\data\*" "$env:USERPROFILE\ohrganize-umzug.zip"
```

Das Archiv auf den Server bringen (Netzwerkfreigabe, USB, Kopieren über RDP) —
hier nach `C:\Temp`. Es enthält die vollständige Personalakte; die Kopie danach
löschen, nicht auf einer Freigabe liegen lassen.

```powershell
# Auf dem Server, Dienst gestoppt
nssm stop oHRganize
Rename-Item 'C:\ProgramData\oHRganize\data' "data.leer-$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory 'C:\ProgramData\oHRganize\data' -Force | Out-Null
Expand-Archive 'C:\Temp\ohrganize-umzug.zip' 'C:\ProgramData\oHRganize\data'

# Pflicht: das neue Verzeichnis erbt sonst den Lesezugriff der Gruppe "Benutzer"
& 'C:\Program Files\oHRganize\deploy\windows\harden-data-dir.ps1'

nssm start oHRganize
Get-Content 'C:\ProgramData\oHRganize\logs\backend.log' -Tail 50
```

Drei Punkte, die dabei regelmäßig übersehen werden:

- **App- und Serverversion müssen zusammenpassen.** Die mitgebrachte Datenbank
  ist auf dem Stand der Desktop-App migriert. Ist der Server **älter**, bricht
  er beim Start ab („Die Datenbank wurde bereits von einer neueren
  oHRganize-Version migriert") — ein Downgrade ist nicht vorgesehen. Deshalb den
  Server vor dem Umzug auf denselben oder einen neueren Stand bringen
  (Abschnitt 6). Der umgekehrte Fall geht: Ein neuerer Server migriert die
  Datenbank beim ersten Start weiter — dann muss aber auch der Arbeitsplatz
  nachgezogen werden, sonst weist ihn `MIN_CLIENT_VERSION` ab. Am einfachsten
  ist deshalb, beide Seiten vor dem Umzug auf denselben Stand zu bringen.
- **Die mitgezogenen Konten gelten.** Das Datenverzeichnis bringt die
  `users`-Tabelle mit; es sind die Konten und Passwörter des Arbeitsplatzes.
  Das `initial-admin-password.txt`, das der Server bei seinem eigenen ersten
  Start erzeugt hat, gehört zur verdrängten leeren Datenbank und ist damit
  **ungültig** — es kann gelöscht werden. Die Erstinbetriebnahme
  (`../../docs/inbetriebnahme.md`) beginnt in diesem Fall nicht bei Punkt 1,
  sondern bei den fachlichen Prüfungen ab Punkt 4.
- **Danach zeigt der Arbeitsplatz auf den Server** (Abschnitt 7). Das alte
  lokale Verzeichnis dort erst löschen, wenn der Serverbetrieb nachweislich
  läuft — bis dahin ist es die einzige Kopie.

## 9. Betrieb

```powershell
Get-Content 'C:\ProgramData\oHRganize\logs\backend.log' -Tail 50 -Wait
Get-ScheduledTaskInfo -TaskName 'oHRganize-Sicherung'
Get-Content 'C:\ProgramData\oHRganize\logs\caddy-access.log' -Tail 50
```

`LastTaskResult` von `0` bedeutet, dass die Sicherung durchlief.

**Rechte prüfen** — der wichtigste wiederkehrende Check:

```powershell
icacls 'C:\ProgramData\oHRganize\data'
```

Erwartet werden **nur** `NT AUTHORITY\SYSTEM`, die Administratoren-Gruppe und
`NT SERVICE\oHRganize`. Taucht dort `Benutzer` oder `Users` auf, ist das
Verzeichnis offen — dann `harden-data-dir.ps1` erneut ausführen.

> Folge für den Betrieb: Ein Backup-Agent, ein Monitoring oder ein
> Virenscanner, der unter einem anderen Konto läuft, kommt **nicht** hinein.
> Der richtige Weg ist, ihn auf `C:\ProgramData\oHRganize\backups` zu richten —
> **nicht** die Vererbung wieder einzuschalten. Ein `icacls /reset` macht
> Gehälter und AU-Bescheinigungen für jedes lokale Konto lesbar, und anders als
> unter Linux zieht der nächste Dienststart das **nicht** wieder zurecht.

**Erreichbarkeit von außen prüfen** (erwartet: Verbindungsfehler):

```powershell
Invoke-WebRequest "http://$env:COMPUTERNAME:3001/api/health" -TimeoutSec 5
```

## 10. Wenn etwas nicht startet

Die fachlichen Startfehler (CORS, Token-Laufzeit, Downgrade, `SQLITE_CANTOPEN`)
stehen in `../README.md`, Abschnitt 8 — sie gelten unverändert. Windows-eigen
sind diese:

| Symptom | Ursache | Abhilfe |
|---|---|---|
| Dienst startet und stoppt sofort | `node.exe` nicht im PATH des Dienstkontos | Vollen Pfad setzen: `nssm set oHRganize Application "C:\Program Files\nodejs\node.exe"` |
| Änderung an `ohrganize.env` wirkt nicht | NSSM hält die Werte in der Registry | `install-service.ps1` erneut ausführen |
| `SQLITE_CANTOPEN` / `EACCES` | Dienstkonto hat keine NTFS-Rechte | `harden-data-dir.ps1` ausführen |
| Sicherung läuft, Verzeichnis bleibt leer | Aufgabe hat anderes `OHRGANIZE_DATA_DIR` als der Dienst | Beide Werte vergleichen |
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

Ebenfalls noch offen — alles Punkte, die erst auf einer echten Server-VM
belastbar sind:

| Offen | Was genau ungewiss ist | Wie man es prüft |
|---|---|---|
| Dienst-SID vor der Dienstinstallation | `install-service.ps1` härtet, **bevor** der Dienst existiert — sonst stünde das Initialpasswort ungeschützt im Protokoll. Das virtuelle Konto `NT SERVICE\oHRganize` ist zu diesem Zeitpunkt noch nicht über seinen Namen auflösbar; das Skript ermittelt deshalb die SID mit `sc.exe showsid`. Ob Windows Server dieselbe (lokalisierte) Ausgabe liefert wie Windows 11, ist ungeprüft. | Nach `install-service.ps1` muss `icacls 'C:\ProgramData\oHRganize\data'` `NT SERVICE\oHRganize` zeigen. Fehlt der Eintrag, `harden-data-dir.ps1` erneut ausführen. |
| Geplante Aufgabe mit eigenem Datenverzeichnis | Die Sicherungsaufgabe erbt keine Umgebung und bekommt `OHRGANIZE_DATA_DIR` deshalb über `cmd.exe /s /c set …` unmittelbar vor dem Aufruf mit (`install-backup-task.ps1`) — bewusst **keine** Maschinenvariable, damit nicht jeder Node-Prozess auf dem Server auf die Produktivdatenbank zeigt. Ungeprüft ist, ob die Aufgabenplanung das Quoting unverändert durchreicht. | `Start-ScheduledTask -TaskName 'oHRganize-Sicherung'`, danach muss unter `C:\ProgramData\oHRganize\backups` ein neuer, **gefüllter** Ordner stehen. Ein leerer Ordner heißt: falsches Datenverzeichnis. |
| Rückbau bei fehlgeschlagener Kontozuweisung | Scheitert `sc.exe config obj=`, entfernt `install-service.ps1` den soeben angelegten Dienst wieder bzw. nimmt einem vorhandenen den Autostart, damit kein Dienst als LocalSystem zurückbleibt. Dieser Fehlerpfad ist nicht durchgespielt. | `sc.exe qc oHRganize` nach einem Abbruch: Der Dienst darf entweder nicht existieren oder nicht auf `AUTO_START` stehen. |
| `git safe.directory` in `C:\Program Files` | Ob `git pull` dort wegen „dubious ownership" abbricht, hängt vom Besitzer des Verzeichnisses und vom aufrufenden Konto ab. Auf Windows Server nicht nachgestellt. | Abschnitt 1. Tritt der Fehler auf, den dort genannten `git config`-Aufruf setzen. |
| Umzug einer Einzelplatz-Installation (Abschnitt 8) | Der Weg ist aus dem Verhalten der App abgeleitet (kein WAL-Checkpoint beim Beenden), aber nicht mit einem echten gewachsenen Datenbestand durchgespielt. | Vor dem Umzug eine Kopie des Arbeitsplatz-Verzeichnisses beiseitelegen und den Serverstand gegen den bekannten Datenbestand prüfen (Anzahl Mitarbeitende, jüngster Antrag). |
