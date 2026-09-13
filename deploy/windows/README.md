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
  ebenfalls eine einzelne Exe, **Version ≥ 2.8.0** (`caddy version`; der
  Download dort ist aktuell). Das mitgelieferte Caddyfile enthält die
  Pflichtzeile `reuse_private_keys`, die ältere Fassungen nicht kennen
  (Abschnitt 7).
- Das **Release-Archiv** `ohrganize-server-<version>.zip` des Anbieters samt
  `.sha256`. Es enthält die fertig gebauten Bundles, den Portal-Build, dieses
  Verzeichnis und die Betriebsdokumente — kein Quelltext. **Git for Windows**
  wird damit nicht gebraucht; es bleibt nur für den Eigenbau aus dem
  Quelltext (Kasten am Ende von Abschnitt 2) relevant.
- Visual Studio Build Tools **nur**, falls `npm ci` kein Fertigpaket für
  `better-sqlite3` findet. Für aktuelle Node-LTS-Versionen gibt es eines.
- Eine Domain, die auf den Server zeigt, Ports 80 und 443 aus dem Internet
  erreichbar.
- 2 vCPU, 4 GB RAM, 40 GB Platte. (Unter Linux genügen 2 GB — Windows Server
  selbst belegt mehr.)

**Heruntergeladene `.ps1` freigeben.** Ein im Browser geladenes Archiv trägt
die Zone-Kennung „aus dem Internet"; wer es mit dem Explorer entpackt, vererbt
sie an jede Datei, und PowerShell verweigert dann die Ausführung der Skripte
oder fragt bei jedem Aufruf nach. Am einfachsten die Kennung **vor** dem
Entpacken vom Archiv nehmen (`Unblock-File ohrganize-server-<version>.zip`);
`Expand-Archive` vererbt sie ohnehin nicht. Nachträglich:

```powershell
Get-ChildItem 'C:\Program Files\oHRganize\deploy\windows\*.ps1' | Unblock-File
```

**`git` in `C:\Program Files`** — nur für den Eigenbau aus dem Quelltext
relevant. Git prüft seit 2.35.2, ob das Repository
demselben Konto gehört wie der aufrufende Benutzer. `C:\Program Files` gehört
`TrustedInstaller`, nicht dem Administrator — `git pull` kann dort deshalb mit
`detected dubious ownership in repository` abbrechen. Abhilfe, einmalig in der
Administrator-PowerShell:

```powershell
git config --global --add safe.directory 'C:/Program Files/oHRganize'
```

(Schrägstriche wie hier, nicht Backslashes — Git erwartet den Pfad in dieser
Schreibweise.) **Im Probelauf war der Aufruf nicht nötig** (siehe „Was der
Probelauf gezeigt hat" am Ende): Ein aus einer Administrator-PowerShell
angelegtes `C:\Program Files\oHRganize` gehört der Gruppe Administratoren, und
Git nimmt das an. Ob der Fall auftritt, hängt davon ab, wie das Verzeichnis
angelegt wurde und unter welchem Konto geklont wird — wird das Repository etwa
von einem Dienstkonto oder über eine Freigabe eingespielt, kann er wiederkommen.
Deshalb bleibt der Befehl hier stehen: als Abhilfe, nicht als Pflichtschritt.

## 2. Installation

> **Schnellweg: `setup-server.ps1`.** Die Abschnitte 2 bis 5 und der
> Sicherungs-Probelauf aus Abschnitt 9 stecken in einem Skript, das die
> vorhandenen Bausteine (`install-service.ps1`, `harden-data-dir.ps1`,
> `install-backup-task.ps1`) in der richtigen Reihenfolge aufruft, nach jedem
> Schritt prüft und bei Fehlern abbricht — idempotent, also nach Behebung
> einfach erneut starten. Voraussetzungen aus Abschnitt 1 (Node, NSSM, Caddy
> ≥ 2.8, Archiv samt `.sha256` unter `C:\Temp`) prüft es, installiert sie
> aber nicht. Aus dem entpackten Archiv oder direkt aus `C:\Temp` (das Skript
> liegt auch dort im Archiv unter `deploy\windows\`):
>
> ```powershell
> Expand-Archive 'C:\Temp\ohrganize-server-<version>.zip' -DestinationPath 'C:\Temp\ohrganize-release' -Force
> & 'C:\Temp\ohrganize-release\deploy\windows\setup-server.ps1' -Archive 'C:\Temp\ohrganize-server-<version>.zip' -Domain 'portal.firma.de' -AcmeEmail 'it@firma.de'
> ```
>
> Am Ende stehen Initialpasswort-Datei, Installations-ID, der Server-Pin und
> der fertige `config.json`-Befehl für die Arbeitsplätze (Abschnitt 7). Eine
> später ausgestellte Lizenzdatei spielt `setup-server.ps1 -OnlyLicense
> -LicenseFile <datei>` ein — oder die HR in der App. Wer die Schritte
> einzeln nachvollziehen will (oder ein Teil ist schon anders eingerichtet:
> `-NoCaddy`, `-NoFirewall`, `-NoBackup`), folgt dem Rest dieses Abschnitts;
> die Ergebnisse sind dieselben.

Alle Schritte in einer **Administrator**-PowerShell.

```powershell
# 2.1 Programm ablegen — Release-Archiv des Anbieters, OHNE Zwischenverzeichnis
#     (Prüfsumme: Get-FileHash gegen die .sha256-Datei neben dem Archiv)
(Get-FileHash 'C:\Temp\ohrganize-server-<version>.zip' -Algorithm SHA256).Hash.ToLower()
Get-Content 'C:\Temp\ohrganize-server-<version>.zip.sha256'
New-Item -ItemType Directory 'C:\Program Files\oHRganize' -Force
Expand-Archive 'C:\Temp\ohrganize-server-<version>.zip' -DestinationPath 'C:\Program Files\oHRganize' -Force
Set-Location 'C:\Program Files\oHRganize'
Get-Content LIESMICH.txt                        # Inhalt des Archivs

# 2.2 Laufzeitabhängigkeit installieren
#     Gebaut wird auf dem Server nichts: apps\backend\dist\cli.cjs (Dienst),
#     backup.cjs (Sicherung) und apps\web\dist (Portal) liegen fertig im
#     Archiv. Das Bundle enthält alle npm-Pakete bis auf eines: better-sqlite3
#     bringt eine native Bibliothek mit und muss auf dem Zielsystem installiert
#     werden. package.json und package-lock.json im Archiv sind genau darauf
#     gekürzt — deshalb --omit=dev, und es gibt kein npm run build.
npm ci --omit=dev

#     KONTROLLE — nicht überspringen. Der Dienst startet sonst später mit einem
#     Fehler, der nicht nach der Ursache aussieht.
#     better-sqlite3 holt seine native Bibliothek über ein Installationsskript.
#     npm sperrt solche Skripte ab Version 12, sofern das Paket nicht in
#     "allowScripts" der package.json steht UND der Lockfile eine
#     "resolved"-URL dazu mitbringt (ohne die kann npm nicht auf eine Version
#     festnageln). Das Archiv bringt beides mit; fehlt trotzdem eine der beiden
#     Bedingungen, meldet npm ci Erfolg — und erst der erste Datenbankzugriff
#     bricht mit "Could not locate the bindings file" ab.
#     ACHTUNG: Ein blosses require() genügt als Prüfung NICHT. Die native
#     Bindung wird erst beim "new Database" geladen.
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"

#     Schlägt die Zeile fehl, das Installationsskript von Hand nachholen:
#       Push-Location node_modules\better-sqlite3
#       node ..\prebuild-install\bin.js
#       Pop-Location
#     und danach die Kontrollzeile wiederholen.

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

Das Archiv bringt `apps\backend\dist\` mit `cli.cjs` (Diensteinstieg) und
`backup.cjs` (Sicherung) fertig gebaut und minifiziert mit; `server.cjs`, das
Embedding-Bundle der Desktop-App, gehört nicht zum Serverpaket.

> Beim allerersten Start legt oHRganize den Standard-Admin an und schreibt ein
> **generiertes** Initialpasswort ins Protokoll und nach
> `C:\ProgramData\oHRganize\data\initial-admin-password.txt`. Weiter geht es in
> `../../docs/inbetriebnahme.md`.

> **Eigenbau aus dem Quelltext** (Entwicklung, eigener Fork): `git clone
> <repository-url> 'C:\Program Files\oHRganize'`, `npm ci` — ausdrücklich
> **ohne** `--omit=dev`, der Build braucht esbuild und typescript —, dann
> `npm run build -w apps/backend` und `npm run build:web`; die Dienstpfade
> sind dieselben. `npm run release:server` erzeugt aus dem Quelltext genau das
> Archiv, das Schritt 2.1 voraussetzt.

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

Läuft der Server unter einem Namen in der Zone des Anbieters
(`<kunde>.ohrganize.com` statt eigener Domain), gilt zusätzlich
`../../docs/kunden-subdomain.md`: DNS-only, HTTP-01 ohne API-Token auf dem
Server, CAA auf das eigene ACME-Konto, CT-Überwachung — und das Pinning der
Desktop-App aus Abschnitt 7.

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
if (Test-Path "$Backup\lizenz.ohrganize") { Copy-Item "$Backup\lizenz.ohrganize" $Probe }   # falls gesichert

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
belegt `storage\`. Die Anmeldeantwort enthält `license.state`; steht dort
`valid`, ist auch die Lizenzdatei mitgekommen (`/api/health` ohne Anmeldung
nennt nur `license.read_only` und unterscheidet Testphase und Lizenz nicht).
Zum Schluss aufräumen:

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
if (Test-Path "$Backup\lizenz.ohrganize") { Copy-Item "$Backup\lizenz.ohrganize" 'C:\ProgramData\oHRganize\data' }

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
(Get-FileHash 'C:\Temp\ohrganize-server-<version>.zip' -Algorithm SHA256).Hash.ToLower()   # gegen .sha256 vergleichen
Remove-Item 'apps' -Recurse -Force                # Altstand weg (node_modules bleibt); sonst sammeln sich alte Portal-Assets an
Expand-Archive 'C:\Temp\ohrganize-server-<version>.zip' -DestinationPath 'C:\Program Files\oHRganize' -Force
npm ci --omit=dev                                 # nur nötig, wenn better-sqlite3 gewechselt hat — schadet nie
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"
Remove-Item 'C:\ProgramData\oHRganize\web\*' -Recurse -Force
Copy-Item 'apps\web\dist\*' 'C:\ProgramData\oHRganize\web' -Recurse -Force
nssm start oHRganize
Get-Content 'C:\ProgramData\oHRganize\logs\backend.log' -Tail 50
```

(Eigenbau aus dem Quelltext: `git pull`, `npm ci` ohne `--omit=dev`,
`npm run build -w apps/backend`, `npm run build:web` — Kasten in Abschnitt 2.)

Die Sicherung läuft bewusst **vor** dem Update. Migrationen laufen automatisch
beim Start in **einer** Transaktion; bricht eine ab, bleibt die Datenbank auf
dem Stand davor und der Dienst startet nicht. **Ein Downgrade ist nicht
vorgesehen** — der Rückweg ist immer das Backup von vor dem Update. Die
Lizenzdatei liegt im Datenverzeichnis und ist vom Update nicht betroffen.

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

> **Schnellweg: `setup-workstation.ps1`.** `npm run dist:win` legt das Skript
> neben den Installer nach `apps\desktop\release`; es steckt auch im
> Release-Archiv unter `deploy\windows\`. Im Windows-Konto der HR-Person
> (keine Adminrechte), Installer und Skript z. B. auf einem Stick:
>
> ```powershell
> .\setup-workstation.ps1 -ApiBaseUrl 'https://portal.firma.de' -ServerPin 'sha256/…' -Installer '.\oHRganize Setup <Version>.exe'
> ```
>
> Es installiert die App still, wenn sie fehlt, schreibt die `config.json`
> ohne BOM (Adresse und Pin), prüft, dass kein lokales Datenverzeichnis
> existiert und der Server antwortet, und startet die App. Den Pin liefert
> `setup-server.ps1` am Ende seines Laufs; ohne `-ServerPin` lernt die App
> den Schlüssel beim ersten Kontakt. `-Machine` setzt stattdessen die
> Maschinenvariablen (Adminrechte, alle Konten des Rechners),
> `-RemoveLocalData` räumt eine leere Erstanlage weg (Schritt 4 unten). Die
> Schritte 1–4 sind dasselbe von Hand.

1. Installer ausführen (`oHRganize Setup <Version>.exe` aus
   `apps\desktop\release`). Danach die App **noch nicht öffnen**.
2. Serveradresse hinterlegen — eine der beiden Quellen genügt:

   | Quelle | Wofür | Reichweite |
   |---|---|---|
   | Maschinenvariable `OHRGANIZE_API_BASE` | Rollout per Gruppenrichtlinie oder Skript | ganzer Rechner |
   | `%APPDATA%\oHRganize\config.json` mit `{ "apiBaseUrl": "https://portal.firma.de" }` | Einrichtung von Hand, je Benutzerprofil | ein Windows-Profil |

   **Die Umgebungsvariable gewinnt** für die Adresse, wenn beides gesetzt
   ist (`readDesktopConfig` in `apps/desktop/src/main.ts`). Wer eine falsche
   Adresse in der Variablen sucht, während er die `config.json` korrigiert,
   sucht lange. Die `config.json` wird trotzdem **immer** gelesen — sie kann
   die `serverKeyPins` enthalten (unten). Ohne Umgebungsvariable bricht eine
   defekte Datei den Start ab (sonst liefe der Arbeitsplatz still mit
   eingebettetem Backend und leerer Datenbank); gibt `OHRGANIZE_API_BASE` die
   Adresse vor, wird die Datei nur mit einer Warnung im Protokoll übersprungen —
   dann gelten allein Pins aus `OHRGANIZE_SERVER_KEY_PINS` bzw. das Lernen beim
   ersten Kontakt.

   Von Hand — **ohne BOM schreiben**: `Set-Content -Encoding utf8` setzt in
   Windows PowerShell 5.1 eine Byte-Order-Markierung (EF BB BF) an den
   Dateianfang, die ein strenger JSON-Parser als „kein gültiges JSON“
   abweist. Die App toleriert die Markierung inzwischen, die Anleitung
   verlässt sich darauf nicht; `[IO.File]::WriteAllText` mit
   `UTF8Encoding($false)` schreibt in 5.1 und pwsh dieselben Bytes
   (`-Encoding ascii` ginge ebenfalls, der Inhalt ist reines ASCII):

   ```powershell
   New-Item -ItemType Directory "$env:APPDATA\oHRganize" -Force | Out-Null
   [IO.File]::WriteAllText("$env:APPDATA\oHRganize\config.json",
     '{ "apiBaseUrl": "https://portal.firma.de" }', [Text.UTF8Encoding]::new($false))
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

### Serverschlüssel festnageln (`serverKeyPins`)

Die Desktop-App prüft im Serverbetrieb über `https://` zusätzlich zur
normalen Zertifikatskette den **öffentlichen Schlüssel** des Servers —
SHA-256 über die SPKI des Blattzertifikats, Base64, in der HPKP-Schreibweise
`sha256/<44 Zeichen>` (`apps/desktop/src/serverPinning.ts`). Dann hilft einem
Angreifer auch ein regulär ausgestelltes Zertifikat für den Namen nichts
(untergeschobene CA im Firmennetz, umgebogener DNS-Eintrag — siehe
`../../docs/kunden-subdomain.md`). Für `http://127.0.0.1:3001` und das
eingebettete Backend gilt es nicht (kein TLS).

**Ohne Konfiguration** merkt sich die App den Schlüssel beim ersten
erfolgreichen Kontakt („trust on first use“) in
`%APPDATA%\oHRganize\server-pins.json` und bricht bei jedem späteren
Wechsel mit einer klaren Meldung ab, die diese Datei nennt. Das schützt ab
dem zweiten Start. **Mit Konfiguration** — empfohlen, sobald der Verkehr der
HR-Administration das Firmennetz verlässt — gilt der Schutz ab dem ersten
Start, und ein Wechsel ist eine bewusste IT-Entscheidung:

1. **Der Serverschlüssel muss Erneuerungen überleben.** Caddy erzeugt bei
   jeder Erneuerung sonst ein neues Schlüsselpaar. Die mitgelieferten
   `Caddyfile`s (Linux wie Windows) enthalten deshalb im Site-Block
   `tls { reuse_private_keys }` — **nicht entfernen**, auch nicht bei
   `tls internal` (dort erneuert Caddy mehrmals täglich). Die Zeile gibt es
   ab **Caddy 2.8.0**; meldet `caddy validate` eine unbekannte Option, ist
   die Exe zu alt — aktualisieren, nicht die Zeile löschen. Zeigt der
   Arbeitsplatz auf einen Linux-Server mit nginx, leistet dort
   `certbot --reuse-key` dasselbe (`../README.md`, Abschnitt 3).

2. **Pin ermitteln**, gegen das Zertifikat, das Caddy tatsächlich ausliefert
   (Node ist auf dem Server ohnehin da; bei `tls internal` in den Optionen
   `rejectUnauthorized:false` ergänzen). Die `openssl`-Fassung derselben
   Zeile steht im Kommentar des Caddyfile.

   ```powershell
   node -e "const tls=require('tls'),c=require('crypto');const s=tls.connect(443,'portal.firma.de',{servername:'portal.firma.de'},()=>{const x=new c.X509Certificate(s.getPeerCertificate().raw);console.log('sha256/'+c.createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('base64'));s.end()})"
   ```

3. **Auf jedem Arbeitsplatz eintragen**, neben `apiBaseUrl` — als Datei oder
   per Rollout über die Maschinenvariable `OHRGANIZE_SERVER_KEY_PINS`
   (kommagetrennt; sie schlägt die Datei):

   ```powershell
   [IO.File]::WriteAllText("$env:APPDATA\oHRganize\config.json",
     '{ "apiBaseUrl": "https://portal.firma.de", "serverKeyPins": ["sha256/<Base64-Hash>"] }',
     [Text.UTF8Encoding]::new($false))
   ```

   (Wieder ohne BOM — nicht `Set-Content -Encoding utf8`, siehe Schritt 2
   oben.) Stimmt der Pin nicht, startet die App nicht, sondern nennt
   erwarteten und vorgefundenen Wert samt der Datei, in der der neue
   einzutragen wäre.

**Schlüsselwechsel** (planmäßig oder nach einem Vorfall) ist bei ACME und bei
`tls internal` ein **geplanter Ausfall der Arbeitsplätze** — das lässt sich
nicht wegdokumentieren: Den neuen Schlüssel erzeugt Caddy erst bei der
Neuausstellung, sein Pin ist vorher niemandem bekannt und kann deshalb nicht
vorab verteilt werden (`reuse_private_keys` lädt nur einen Schlüssel, der
noch im Speicher liegt). Ablauf: (1) Wechsel ankündigen — Freitagabend, nicht
Montagmorgen. (2) `nssm stop Caddy`, im Caddy-Speicher den Ordner
`certificates\<aussteller>\<domain>\` samt `.key` entfernen (unter
`%APPDATA%\Caddy` des Dienstkontos, bei LocalSystem
`C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy`),
`nssm start Caddy` — es holt ein Zertifikat mit neuem Schlüssel, und
`reuse_private_keys` hält ab jetzt diesen fest. (3) Neuen Pin mit dem Befehl
aus Schritt 2 ablesen und auf **jedem** Arbeitsplatz eintragen
(`config.json` oder `OHRGANIZE_SERVER_KEY_PINS`); Arbeitsplätze im
Trust-on-first-use-Modus löschen stattdessen ihre `server-pins.json`. Bis
dahin startet die Desktop-App dort nicht — ihre Fehlermeldung nennt den neu
vorgefundenen Pin, das ist die zweite Quelle für Schritt 3. (4) Alten Pin
austragen. **Ohne Ausfall** geht ein Wechsel nur mit einem selbst erzeugten
Schlüssel (Variante (a) im Caddyfile, Firmen-CA): neues Paar erzeugen, Pin
berechnen, auf allen Arbeitsplätzen **neben** dem alten eintragen (die Liste
darf mehrere Werte enthalten), dann die Dateien tauschen, zuletzt den alten
Pin austragen.

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
| `lizenz.ohrganize` (falls vorhanden) | die Lizenz ist an die Installations-ID gebunden, und die steht in der Datenbank — Datei und Datenbank gehören zusammen; ohne die Datei läuft der Server im Nur-Lese-Betrieb |

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

### Lizenz

Die Nutzungsberechtigung ist eine vom Anbieter signierte Datei
**`C:\ProgramData\oHRganize\data\lizenz.ohrganize`** — im Datenverzeichnis
neben `ohrganize.db` und `secret.key`, mit denselben NTFS-Rechten
(`harden-data-dir.ps1` härtet das ganze Verzeichnis). Eine frische
Installation läuft **30 Tage als Testphase**, danach im **Nur-Lese-Betrieb**
(Einsicht und Export gehen weiter, Änderungen nicht), bis eine Lizenz
eingespielt ist.

- **Einspielen** erledigt die HR-Administration in der Desktop-App unter
  Einstellungen → Lizenz; **kein Dienstneustart**, kein erneutes
  `install-service.ps1`. Wird die Datei stattdessen von Hand ins
  Datenverzeichnis kopiert, bemerkt das Backend sie innerhalb weniger
  Sekunden — ebenfalls ohne Neustart. (Das Verzeichnis ist für die Gruppe
  „Benutzer" gesperrt; kopieren aus einer Administrator-PowerShell.)
- **Zustand prüfen:** Ohne Anmeldung liefert
  `(Invoke-RestMethod 'http://127.0.0.1:3001/api/health').license.read_only`
  nur, ob Änderungen möglich sind (`False`; für Monitoring gedacht, verrät
  nichts über den Vertrag). Den Zustand (`trial`, `valid`, `grace`,
  `expired`) tragen angemeldete Antworten im Header `x-ohrganize-license`
  und vollständig `GET /api/license` bzw. die Anmeldeantwort
  (`license.state`); öffentliche Antworten haben den Header bewusst nicht.
  Beim Start steht eine Warnzeile in `backend.log`, sobald etwas
  Aufmerksamkeit verdient (Testphase, nahender Ablauf, Nur-Lese-Betrieb,
  verstellte Uhr) — der schnellste Blick ohne Token.
- **Sicherung:** `backup.cjs` sichert die Datei automatisch mit; beim
  Restore (Abschnitt 5) und beim Umzug (Abschnitt 8) gehört sie ins
  Datenverzeichnis zurück.
- Zustände, Fristen, Bericht für den Anbieter und der Ablauf einer
  Verlängerung: **`../../docs/lizenzierung.md`**.

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
| `MODULE_NOT_FOUND: better-sqlite3` | `npm ci --omit=dev` in `C:\Program Files\oHRganize` fehlt (oder lief in einem anderen Verzeichnis) | Schritt 2.2 wiederholen |
| `backend.log` beginnt mit `NUR-LESE-BETRIEB` oder `Keine Lizenz eingespielt — Testphase bis …` | Der Dienst läuft; er meldet nur den Lizenzzustand | Lizenz einspielen (Abschnitt 9, „Lizenz"); nach einem Restore `lizenz.ohrganize` aus der Sicherung ins Datenverzeichnis |
| `Could not locate the bindings file` (better-sqlite3) | npm ≥ 12 hat das Installationsskript gesperrt — `npm ci` meldete trotzdem Erfolg | `prebuild-install` aus Schritt 2.2 nachholen |
| Dienst steht auf *Angehalten*, `backend.log` zeigt `Cannot find module 'C:\Program'` | `AppParameters` steht ohne Anführungszeichen in der Registry, der Pfad bricht am Leerzeichen von `C:\Program Files` ab | `install-service.ps1` erneut ausführen (es prüft den Wert seit dem Probelauf selbst) |
| `harden-data-dir.ps1` meldet „Dienstkonto noch unbekannt" | `icacls` weist eine Dienst-SID mit `ERROR_NONE_MAPPED` (1332) ab, solange der Dienst nie existiert hat | Nichts tun — das Skript trägt die SID danach über .NET ein. Bleibt die Meldung *und* fehlt das Konto in `icacls`, ist der Rückfall gescheitert |
| Portal zeigt bei `/kalender` einen 404 | SPA-Fallback fehlt | `try_files` im Caddyfile prüfen |
| `caddy validate` meldet `unknown subdirective: reuse_private_keys` | `caddy.exe` älter als 2.8.0 | Aktuelle Exe von caddyserver.com einsetzen. Die Zeile **nicht** entfernen — sonst wechselt der Schlüssel bei jeder Erneuerung und alle Desktop-Arbeitsplätze sperren sich aus (Abschnitt 7) |
| Desktop-App meldet „Die Konfigurationsdatei … enthält kein gültiges JSON" | Tippfehler in der `config.json`; bei älteren App-Fassungen auch ein BOM aus `Set-Content -Encoding utf8` (PowerShell 5.1) | Datei wie in Abschnitt 7 mit `[IO.File]::WriteAllText(…, UTF8Encoding($false))` neu schreiben |

## Was der Probelauf gezeigt hat

Am 08.09.2026 wurde diese Anleitung auf einer Windows-11-Maschine (26200)
vollständig durchgespielt — Server und Arbeitsplatz dieselbe Maschine, Hostname
`localhost`, Node 24.16 / npm 12.0.1, NSSM 2.24, Caddy 2.11.4. Sie führte an
**vier** Stellen nicht zum Ziel; alle vier sind repariert und danach erneut
durchlaufen. Die Begründungen stehen in `../../docs/entscheidungen.md`.

**Abgehakt — tatsächlich durchlaufen:**

- [x] `git clone` nach `C:\Program Files\oHRganize`, `npm ci`, beide Builds
- [x] Dienstregistrierung über NSSM inklusive virtuellem Konto
      `NT SERVICE\oHRganize` (`sc.exe qc` bestätigt es)
- [x] NTFS-Härtung: `data`, `logs` und `backups` tragen danach **nur** SYSTEM,
      Administratoren und das Dienstkonto — kein `Benutzer`
- [x] Erststart mit generiertem Initialpasswort; die Datei ist für die Gruppe
      `Benutzer` nicht lesbar
- [x] Caddy als Dienst mit `tls internal`: Portal 200, SPA-Fallback
      (`/kalender`) 200 statt 404, `http` → 308, alle vier
      Sicherheitskopfzeilen gesetzt, keine `Server`-Kennung, Signatur im
      Query-String **nicht** im Zugriffsprotokoll
- [x] API über den Proxy: `/api/health` 200, ohne Anmeldung 401, zu alte
      Desktop-App 426, falsches Passwort 401 **und** Warnzeile in `backend.log`
- [x] Backend lauscht nur auf `127.0.0.1`, über den Rechnernamen nicht erreichbar
- [x] Geplante Sicherungsaufgabe: `LastTaskResult 0`, gefüllter Ordner mit
      `ohrganize.db`, `storage\`, `secret.key`, `MANIFEST.txt`, keine
      `-wal`-Datei, `integrity_check` der gesicherten Datenbank `ok`
- [x] Restore-Probe in ein eigenes Verzeichnis auf Port 3999: Anmeldung liefert
      ein Token und belegt damit Datenbank **und** `secret.key`
- [x] WAL-Checkpoint beim geordneten Stopp — danach weder `-wal` noch `-shm`
- [x] `git` in `C:\Program Files`: **keine** „dubious ownership". Das
      Verzeichnis gehört, aus einer Administrator-Sitzung angelegt, der Gruppe
      Administratoren, und Git nimmt das an. Der `safe.directory`-Aufruf in
      Abschnitt 1 ist damit nur noch Notnagel, keine Voraussetzung.
- [x] Ein `git clone` erzeugt keine Zone-Kennung; `Unblock-File` bleibt nur für
      den Weg über Download oder Netzlaufwerk nötig.
- [x] **Release-Archiv** (13.09.2026, Node 24.16 / npm 12.0.1): `Expand-Archive`
      in ein leeres Verzeichnis, `npm ci --omit=dev` mit dem gekürzten Lockfile
      (38 Pakete, `npm install-scripts ls` ohne offene Einträge), Kontrollzeile
      `better-sqlite3 ok`, Start von `apps\backend\dist\cli.cjs` auf Port 3999,
      `/api/health` mit `license.read_only: false` (der Header
      `x-ohrganize-license: trial` stand damals noch auf dieser öffentlichen
      Antwort; seit dem Lizenz-Audit tragen ihn nur angemeldete Antworten,
      Abschnitt 9), Anmeldung mit Token, `GET /api/license`,
      unbrauchbare Lizenz → `400 LICENSE_INVALID`, Sicherungslauf mit
      `backup.cjs`. Ohne Dienstregistrierung — die ist gegenüber dem Probelauf
      oben unverändert, weil die Dienstpfade dieselben sind.

**Weiterhin offen:**

| Offen | Was genau ungewiss ist | Wie man es prüft |
|---|---|---|
| Windows **Server** statt Windows 11 | Node, NTFS, NSSM und die Aufgabenplanung verhalten sich gleich; unterschiedlich sein können die lokalisierten Ausgaben von `sc.exe` und `icacls`, die beide Skripte auswerten. Beide vergleichen deshalb SIDs statt Klarnamen. | Nach `install-service.ps1` muss `icacls 'C:\ProgramData\oHRganize\data'` das Dienstkonto zeigen. |
| Caddy mit einem **echten** Zertifikat | Geprüft wurde `tls internal`. Der ACME-Weg über Let's Encrypt braucht eine öffentliche Domain und Port 80/443 aus dem Internet. | `caddy validate`, dann im Protokoll den erfolgreichen Zertifikatsbezug abwarten und `https://<domain>` von außen aufrufen. |
| `package-lock.json` ohne `integrity` | Der ausgelieferte Lockfile trägt für **keinen** der 538 Einträge eine Prüfsumme — `npm ci` verifiziert damit kein einziges Paket. Der Bezug funktioniert, die Absicherung fehlt. | `node -e "const l=require('./package-lock.json');console.log(Object.entries(l.packages).filter(([k,v])=>k.startsWith('node_modules/')&&!v.integrity).length)"` — erwartet: `0`. |
| Rückbau bei fehlgeschlagener Kontozuweisung | Scheitert `sc.exe config obj=`, entfernt `install-service.ps1` den soeben angelegten Dienst wieder bzw. nimmt einem vorhandenen den Autostart. Dieser Fehlerpfad ist nicht ausgelöst worden. | `sc.exe qc oHRganize` nach einem Abbruch: Der Dienst darf entweder nicht existieren oder nicht auf `AUTO_START` stehen. |
| Umzug einer Einzelplatz-Installation (Abschnitt 8) | Der Weg ist aus dem Verhalten der App abgeleitet (kein WAL-Checkpoint beim Beenden), aber nicht mit einem echten gewachsenen Datenbestand durchgespielt. | Vor dem Umzug eine Kopie des Arbeitsplatz-Verzeichnisses beiseitelegen und den Serverstand gegen den bekannten Datenbestand prüfen (Anzahl Mitarbeitende, jüngster Antrag). |
