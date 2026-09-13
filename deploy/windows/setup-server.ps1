<#
.SYNOPSIS
  Richtet einen oHRganize-Server unter Windows in einem Durchlauf ein -
  vom Release-Archiv bis zur Abnahme. Buendelt Abschnitt 2 bis 5 und 9 aus
  deploy/windows/README.md und ruft dafuer die vorhandenen Skripte auf
  (install-service.ps1, harden-data-dir.ps1, install-backup-task.ps1).

.DESCRIPTION
  Voraussetzungen, die das Skript NICHT installiert, sondern nur prueft:
  Node.js >= 20 LTS, nssm.exe und caddy.exe (>= 2.8.0) im PATH, das
  Release-Archiv samt .sha256 daneben (npm run release:server beim Anbieter).

  Schritte (jeder bricht bei Fehler ab, das Skript ist idempotent und kann
  nach Behebung erneut laufen):
    1  Voraussetzungen pruefen (Admin, Node, NSSM, Caddy-Version, Archiv)
    2  Pruefsumme, Zone-Kennung entfernen, nach InstallDir entpacken
    3  npm ci --omit=dev und Kontrolle der nativen better-sqlite3-Bindung
    4  Portal-Build nach <DataRoot>\web
    5  ohrganize.env anlegen (Domain in OHRGANIZE_CORS_ORIGIN), falls neu
    6  Dienst einrichten (install-service.ps1 haertet zuerst das Datenverzeichnis)
    7  Warten, bis /api/health antwortet; optional Lizenzdatei einspielen
    8  Caddy: Caddyfile mit Domain und Postfach, validate, Dienst, Zertifikat
    9  Firewall: 80/443 auf, 3001 zu
   10  Sicherung: Aufgabe anlegen, einmal laufen lassen, Ergebnis pruefen
   11  Abnahme ueber den Proxy (Zertifikat, SPA-Fallback, 401, Health)
   12  Zusammenfassung: Initialpasswort-Datei, Installations-ID, Server-Pin,
       fertiger config.json-Befehl fuer die Arbeitsplaetze

  Die Schalter -NoService, -NoCaddy, -NoFirewall, -NoBackup lassen einzelne
  Teile aus - fuer Probelaeufe ohne Dienstrechte oder wenn ein Teil schon
  anders eingerichtet ist. Ein Lauf ohne Dienst kann keine Abnahme machen.

.EXAMPLE
  .\deploy\windows\setup-server.ps1 -Archive 'C:\Temp\ohrganize-server-1.0.0-beta.1.zip' `
      -Domain 'kunde.ohrganize.com' -AcmeEmail 'it@kunde.de'

.EXAMPLE
  # Spaeter: nur eine Lizenzdatei nachlegen (kein Neustart noetig)
  .\deploy\windows\setup-server.ps1 -LicenseFile 'C:\Temp\lizenz-kunde.ohrganize' -OnlyLicense

.NOTES
  Als Administrator ausfuehren. Windows PowerShell 5.1 genuegt.
  Bewusst ohne Umlaute: 5.1 liest .ps1-Dateien ohne BOM als ANSI.
#>
[CmdletBinding()]
param(
  [string]$Archive,
  [string]$Domain,
  [string]$AcmeEmail,
  [string]$InstallDir  = 'C:\Program Files\oHRganize',
  [string]$DataRoot    = 'C:\ProgramData\oHRganize',
  [string]$CaddyDir    = 'C:\ProgramData\Caddy',
  [string]$LicenseFile = '',
  [int]   $Port        = 3001,
  [switch]$OnlyLicense,
  [switch]$NoChecksum,
  [switch]$NoService,
  [switch]$NoCaddy,
  [switch]$NoFirewall,
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
$script:StepNo = 0

function Step {
  param([string]$Text)
  $script:StepNo++
  Write-Host ''
  Write-Host ("[{0,2}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan
}
function Ok   { param([string]$Text) Write-Host "     ok  $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "     !!  $Text" -ForegroundColor Yellow }
function Fail { param([string]$Text) throw "Abbruch: $Text" }

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Dieses Skript muss in einer Administrator-PowerShell laufen.'
  }
}

# Native Programme: Exit-Code pruefen, ohne stderr umzuleiten (in 5.1 wuerde
# jede stderr-Zeile - npm schreibt dort seine Hinweise - zum Abbruch fuehren).
function Invoke-Native {
  param([string]$Exe, [string[]]$ArgList, [string]$What)
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { Fail "$What (Exit-Code $LASTEXITCODE)" }
}

# Stiller Aufruf: stderr verwerfen, stdout als Text zurueckgeben, Exit-Code in
# $script:QuietExit. Die Voreinstellung wird nur fuer den Aufruf gesenkt - unter
# 'Stop' wirft 5.1 sonst bei JEDER stderr-Zeile eines nativen Programms.
# (Parameter heisst ArgList: $Args ist eine automatische Variable.)
function Invoke-Quiet {
  param([string]$Exe, [string[]]$ArgList)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @ArgList 2>$null
    $script:QuietExit = $LASTEXITCODE
    return (($out | Out-String).Trim())
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Get-VersionFromText {
  param([string]$Text)
  if ($Text -match 'v?(\d+)\.(\d+)\.(\d+)') {
    return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
  }
  return $null
}

function Wait-Until {
  param([scriptblock]$Test, [int]$Seconds, [string]$What)
  for ($i = 0; $i -lt $Seconds; $i++) {
    try { if (& $Test) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  Fail "$What (nach $Seconds s nicht eingetreten)"
}

$dataDir   = Join-Path $DataRoot 'data'
$webDir    = Join-Path $DataRoot 'web'
$logDir    = Join-Path $DataRoot 'logs'
$backupDir = Join-Path $DataRoot 'backups'
$envFile   = Join-Path $DataRoot 'ohrganize.env'
$healthUrl = "http://127.0.0.1:$Port/api/health"
$serviceOn = -not $NoService

# ---------------------------------------------------------------------------
# Lizenz nachlegen: kopieren, kurz warten, Zustand melden. Der Dienst bemerkt
# die Datei innerhalb weniger Sekunden (core/license.ts stat-Intervall).
# ---------------------------------------------------------------------------
function Install-License {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { Fail "Lizenzdatei nicht gefunden: $Path" }
  $text = (Get-Content -LiteralPath $Path -Raw).Trim()
  if (-not $text.StartsWith('OHRG1.')) { Fail "$Path ist keine oHRganize-Lizenzdatei (erwartet: eine Zeile, die mit OHRG1. beginnt)." }
  $target = Join-Path $dataDir 'lizenz.ohrganize'
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  [IO.File]::WriteAllText($target, $text + "`n", [Text.UTF8Encoding]::new($false))
  Ok "Lizenzdatei nach $target kopiert"
  Start-Sleep -Seconds 6
}

# Zustand ueber die Anmeldung mit dem Initialpasswort - nur solange die Datei
# aus der Erstinbetriebnahme noch existiert (danach: Einstellungen -> Lizenz).
function Get-LicenseViaInitialLogin {
  $pwFile = Join-Path $dataDir 'initial-admin-password.txt'
  if (-not (Test-Path -LiteralPath $pwFile)) { return $null }
  $pw = (Get-Content -LiteralPath $pwFile -Raw).Trim()
  $body = @{ email = 'admin@ohrganize.de'; password = $pw } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/auth/login" -ContentType 'application/json' -Body $body
    return $r.license
  } catch {
    return $null
  }
}

if ($OnlyLicense) {
  Assert-Admin
  if ($LicenseFile -eq '') { Fail '-OnlyLicense braucht -LicenseFile <pfad>.' }
  Step 'Lizenzdatei einspielen'
  Install-License -Path $LicenseFile
  $lic = Get-LicenseViaInitialLogin
  if ($lic) { Ok ("Zustand: {0}, gueltig bis {1}, Plaetze {2}" -f $lic.state, $lic.valid_until, $lic.max_users) }
  else { Warn 'Zustand nicht abfragbar (Initialpasswort schon gewechselt) - in der App unter Einstellungen -> Lizenz pruefen.' }
  return
}

# ---------------------------------------------------------------------------
# 1  Voraussetzungen
# ---------------------------------------------------------------------------
Step 'Voraussetzungen pruefen'
$needsAdmin = $serviceOn -or (-not $NoCaddy) -or (-not $NoFirewall) -or (-not $NoBackup)
if ($needsAdmin) { Assert-Admin } else { Warn 'Probelauf ohne Dienst, Caddy, Firewall und Sicherung - kein Administrator noetig' }
foreach ($p in @('Archive', 'Domain', 'AcmeEmail')) {
  if ((Get-Variable -Name $p -ValueOnly) -in @($null, '')) { Fail "-$p fehlt. Beispiel im Kopf des Skripts." }
}
if ($Domain -notmatch '^[a-z0-9.-]+\.[a-z]{2,}$') { Fail "-Domain '$Domain' sieht nicht nach einem Hostnamen aus (klein, ohne https://, ohne Pfad)." }
if ($AcmeEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail "-AcmeEmail '$AcmeEmail' ist keine E-Mail-Adresse." }
if (-not (Test-Path -LiteralPath $Archive)) { Fail "Archiv nicht gefunden: $Archive" }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node.exe nicht im PATH - Node.js LTS (MSI, systemweit) installieren und die PowerShell neu oeffnen.' }
$nodeVer = Get-VersionFromText (& node -v)
if ($nodeVer -lt [version]'20.0.0') { Fail "Node.js $nodeVer ist zu alt (>= 20 noetig)." }
Ok "Node.js $nodeVer"

if ($serviceOn -or -not $NoCaddy) {
  $nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if (-not $nssm) { Fail 'nssm.exe nicht im PATH (C:\Program Files\nssm\ anlegen und in den System-PATH aufnehmen).' }
  Ok "NSSM: $($nssm.Source)"
}
if (-not $NoCaddy) {
  $caddy = Get-Command caddy.exe -ErrorAction SilentlyContinue
  if (-not $caddy) { Fail 'caddy.exe nicht im PATH (C:\Program Files\Caddy\ anlegen und in den System-PATH aufnehmen).' }
  $caddyVer = Get-VersionFromText ((& caddy version) | Select-Object -First 1)
  if (-not $caddyVer -or $caddyVer -lt [version]'2.8.0') {
    Fail "Caddy $caddyVer ist zu alt - >= 2.8.0 noetig (reuse_private_keys im Caddyfile). Download: caddyserver.com/download"
  }
  Ok "Caddy $caddyVer"
}

# ---------------------------------------------------------------------------
# 2  Archiv pruefen und entpacken
# ---------------------------------------------------------------------------
Step 'Archiv pruefen und entpacken'
$archiveFull = (Resolve-Path -LiteralPath $Archive).Path
if (-not $NoChecksum) {
  $sumFile = "$archiveFull.sha256"
  if (-not (Test-Path -LiteralPath $sumFile)) { Fail "Pruefsummendatei fehlt: $sumFile (liegt beim Anbieter neben dem Archiv; -NoChecksum ueberspringt die Pruefung bewusst)." }
  $expected = ((Get-Content -LiteralPath $sumFile -Raw).Trim() -split '\s+')[0].ToLower()
  $actual   = (Get-FileHash -LiteralPath $archiveFull -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { Fail "SHA-256 stimmt nicht: erwartet $expected, Archiv hat $actual. Archiv neu uebertragen." }
  Ok "SHA-256 stimmt ($actual)"
} else {
  Warn 'Pruefsumme uebersprungen (-NoChecksum)'
}
Unblock-File -LiteralPath $archiveFull

if ($serviceOn) {
  $svc = Get-Service -Name 'oHRganize' -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Stopped') {
    & nssm stop oHRganize | Out-Null
    Ok 'Laufender Dienst oHRganize angehalten (Update)'
  }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -LiteralPath $archiveFull -DestinationPath $InstallDir -Force
foreach ($rel in @('apps\backend\dist\cli.cjs', 'apps\backend\dist\backup.cjs', 'apps\web\dist\index.html', 'deploy\windows\install-service.ps1', 'package-lock.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $rel))) { Fail "Nach dem Entpacken fehlt $rel - falsches Archiv oder Zwischenverzeichnis?" }
}
Get-ChildItem -LiteralPath (Join-Path $InstallDir 'deploy\windows') -Filter '*.ps1' | Unblock-File
Ok "Entpackt nach $InstallDir"

# ---------------------------------------------------------------------------
# 3  Laufzeitabhaengigkeit
# ---------------------------------------------------------------------------
Step 'better-sqlite3 installieren (npm ci --omit=dev)'
Push-Location $InstallDir
try {
  Invoke-Native -Exe 'npm.cmd' -ArgList @('ci', '--omit=dev', '--no-audit', '--no-fund') -What 'npm ci --omit=dev fehlgeschlagen'
  # Einfache Anfuehrungszeichen IM JavaScript: Windows PowerShell 5.1 reicht
  # innere doppelte nicht an native Programme weiter.
  $probe = "new (require('better-sqlite3'))(':memory:'); console.log('ok')"
  $out = Invoke-Quiet -Exe 'node' -ArgList @('-e', $probe)
  if ($QuietExit -ne 0 -or $out -ne 'ok') {
    Warn 'Native Bindung fehlt - Installationsskript wird nachgeholt (prebuild-install)'
    Push-Location (Join-Path $InstallDir 'node_modules\better-sqlite3')
    try { & node ..\prebuild-install\bin.js } finally { Pop-Location }
    $out = Invoke-Quiet -Exe 'node' -ArgList @('-e', $probe)
    if ($QuietExit -ne 0 -or $out -ne 'ok') { Fail 'better-sqlite3 laedt seine native Bibliothek nicht. Siehe deploy\windows\README.md, Abschnitt 2.2 (allowScripts, Build Tools).' }
  }
  Ok 'better-sqlite3 bereit'
} finally { Pop-Location }

# ---------------------------------------------------------------------------
# 4  Portal
# ---------------------------------------------------------------------------
Step 'Portal-Build ausliefern'
if (Test-Path -LiteralPath $webDir) { Remove-Item -LiteralPath $webDir -Recurse -Force }
New-Item -ItemType Directory -Path $webDir -Force | Out-Null
Copy-Item -Path (Join-Path $InstallDir 'apps\web\dist\*') -Destination $webDir -Recurse -Force
Ok "Portal unter $webDir (alte Assets entfernt)"

# ---------------------------------------------------------------------------
# 5  Konfiguration
# ---------------------------------------------------------------------------
Step 'ohrganize.env'
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$corsWanted = "https://$Domain,ohrganize://app"
if (-not (Test-Path -LiteralPath $envFile)) {
  $tpl = Get-Content -LiteralPath (Join-Path $InstallDir 'deploy\windows\ohrganize.env.example')
  $lines = foreach ($l in $tpl) {
    if ($l -match '^OHRGANIZE_DATA_DIR=')    { "OHRGANIZE_DATA_DIR=$dataDir" }
    elseif ($l -match '^OHRGANIZE_PORT=')    { "OHRGANIZE_PORT=$Port" }
    elseif ($l -match '^OHRGANIZE_CORS_ORIGIN=') { "OHRGANIZE_CORS_ORIGIN=$corsWanted" }
    elseif ($l -match '^OHRGANIZE_LOG_LEVEL=') { 'OHRGANIZE_LOG_LEVEL=warn' }
    else { $l }
  }
  [IO.File]::WriteAllLines($envFile, [string[]]$lines, [Text.UTF8Encoding]::new($false))
  Ok "Angelegt: $envFile (CORS: $corsWanted)"
} else {
  $cors = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^OHRGANIZE_CORS_ORIGIN=' } | Select-Object -First 1)
  if ($cors -and $cors -like "*$Domain*" -and $cors -like '*ohrganize://app*') {
    Ok "Vorhanden, unveraendert: $envFile"
  } else {
    Warn "$envFile existiert, aber OHRGANIZE_CORS_ORIGIN enthaelt nicht '$Domain' und 'ohrganize://app' - bitte pruefen: $cors"
  }
}

# ---------------------------------------------------------------------------
# 6  Dienst
# ---------------------------------------------------------------------------
if ($serviceOn) {
  Step 'Dienst einrichten (install-service.ps1: NTFS-Rechte, NSSM, Start)'
  & (Join-Path $InstallDir 'deploy\windows\install-service.ps1') -InstallDir $InstallDir -EnvFile $envFile -LogDir $logDir
  $acl = (& icacls $dataDir) -join ' '
  if ($acl -match '\\(Benutzer|Users):') { Fail "$dataDir ist noch fuer die Gruppe Benutzer lesbar - harden-data-dir.ps1 pruefen." }
  Ok 'Datenverzeichnis: keine Leserechte fuer Benutzer'
} else {
  Step 'Dienst uebersprungen (-NoService)'
}

# ---------------------------------------------------------------------------
# 7  Backend erreichbar, Lizenz
# ---------------------------------------------------------------------------
if ($serviceOn) {
  Step 'Warten auf das Backend'
  Wait-Until -Seconds 30 -What "Backend antwortet nicht auf $healthUrl" -Test {
    (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3).ok -eq $true
  } | Out-Null
  $health = Invoke-RestMethod -Uri $healthUrl
  Ok ("Backend {0} laeuft, read_only={1}" -f $health.version, $health.license.read_only)
  $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }
  if ($listen) { Fail "Port $Port lauscht auf $($listen.LocalAddress -join ', ') - OHRGANIZE_HOST darf auf einem Einzelserver nicht gesetzt sein." }
  Ok "Port $Port nur auf Loopback"

  if ($LicenseFile -ne '') {
    Step 'Lizenzdatei einspielen'
    Install-License -Path $LicenseFile
  }
}

# ---------------------------------------------------------------------------
# 8  Caddy
# ---------------------------------------------------------------------------
if (-not $NoCaddy) {
  Step 'Caddy: Caddyfile, validate, Dienst, Zertifikat'
  New-Item -ItemType Directory -Path $CaddyDir -Force | Out-Null
  $caddyfile = Join-Path $CaddyDir 'Caddyfile'
  $src = Get-Content -LiteralPath (Join-Path $InstallDir 'deploy\windows\Caddyfile') -Raw
  if ($src -notmatch 'reuse_private_keys') { Fail 'Das Caddyfile im Archiv enthaelt kein reuse_private_keys - falsches Archiv?' }
  $cfg = $src.Replace('portal.example.invalid', $Domain).Replace('it@firma.de', $AcmeEmail)
  if ((Test-Path -LiteralPath $caddyfile) -and ((Get-Content -LiteralPath $caddyfile -Raw) -ne $cfg)) {
    Copy-Item -LiteralPath $caddyfile -Destination "$caddyfile.vorher" -Force
    Warn "Vorhandenes Caddyfile ersetzt; alte Fassung: $caddyfile.vorher"
  }
  [IO.File]::WriteAllText($caddyfile, $cfg, [Text.UTF8Encoding]::new($false))
  Invoke-Native -Exe 'caddy' -ArgList @('validate', '--config', $caddyfile) -What 'caddy validate lehnt das Caddyfile ab'
  Ok 'Caddyfile gueltig'

  $caddySvc = Get-Service -Name 'Caddy' -ErrorAction SilentlyContinue
  if (-not $caddySvc) {
    Invoke-Native -Exe 'nssm' -ArgList @('install', 'Caddy', $caddy.Source, 'run', '--config', $caddyfile) -What 'nssm install Caddy fehlgeschlagen'
    & nssm set Caddy Start SERVICE_AUTO_START | Out-Null
    & nssm set Caddy AppStdout (Join-Path $logDir 'caddy.log') | Out-Null
    & nssm set Caddy AppStderr (Join-Path $logDir 'caddy.log') | Out-Null
    & nssm set Caddy AppRotateFiles 1 | Out-Null
    & nssm set Caddy AppRotateBytes 20971520 | Out-Null
    & nssm start Caddy | Out-Null
    Ok 'Dienst Caddy angelegt und gestartet'
  } else {
    & nssm restart Caddy | Out-Null
    Ok 'Dienst Caddy neu gestartet'
  }
}

# ---------------------------------------------------------------------------
# 9  Firewall
# ---------------------------------------------------------------------------
if (-not $NoFirewall) {
  Step 'Firewall'
  $rules = @(
    @{ Name = 'oHRganize HTTPS';           Port = 443;   Action = 'Allow' },
    @{ Name = 'oHRganize ACME';            Port = 80;    Action = 'Allow' },
    @{ Name = 'oHRganize Backend sperren'; Port = $Port; Action = 'Block' }
  )
  foreach ($r in $rules) {
    if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) {
      Ok "$($r.Name): vorhanden"
    } else {
      New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP -LocalPort $r.Port -Action $r.Action | Out-Null
      Ok "$($r.Name): angelegt ($($r.Action) $($r.Port))"
    }
  }
}

# ---------------------------------------------------------------------------
# 10 Sicherung
# ---------------------------------------------------------------------------
if (-not $NoBackup -and $serviceOn) {
  Step 'Sicherung: Aufgabe anlegen und Probelauf'
  & (Join-Path $InstallDir 'deploy\windows\install-backup-task.ps1') -InstallDir $InstallDir -BackupDir $backupDir -DataDir $dataDir
  $before = (Get-ScheduledTaskInfo -TaskName 'oHRganize-Sicherung').LastRunTime
  Start-ScheduledTask -TaskName 'oHRganize-Sicherung'
  Wait-Until -Seconds 90 -What 'Sicherungslauf nicht beendet' -Test {
    $i = Get-ScheduledTaskInfo -TaskName 'oHRganize-Sicherung'
    ($i.LastRunTime -ne $before) -and ((Get-ScheduledTask -TaskName 'oHRganize-Sicherung').State -ne 'Running')
  } | Out-Null
  $info = Get-ScheduledTaskInfo -TaskName 'oHRganize-Sicherung'
  if ($info.LastTaskResult -ne 0) { Fail "Sicherung meldet LastTaskResult $($info.LastTaskResult) - $logDir\backup.log pruefen." }
  $latest = Get-ChildItem -LiteralPath $backupDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $latest -or -not (Test-Path (Join-Path $latest.FullName 'MANIFEST.txt'))) { Fail "Kein vollstaendiger Sicherungsordner unter $backupDir." }
  Ok "Sicherung gelaufen: $($latest.Name)"
} elseif (-not $NoBackup) {
  Step 'Sicherung uebersprungen (ohne Dienst kein Probelauf)'
}

# ---------------------------------------------------------------------------
# 11 Abnahme ueber den Proxy
# ---------------------------------------------------------------------------
$pin = $null
if ($serviceOn -and -not $NoCaddy) {
  Step 'Abnahme ueber https (Zertifikat, Portal, API)'
  # --resolve: der Name wird lokal auf 127.0.0.1 gelenkt, die Zertifikatspruefung
  # laeuft trotzdem gegen den echten Namen - unabhaengig davon, ob NAT-Hairpin
  # funktioniert. Let's Encrypt braucht fuer die Ausstellung ein paar Sekunden.
  $resolve = "${Domain}:443:127.0.0.1"
  function Get-HttpCode { param([string]$Url) Invoke-Quiet -Exe 'curl.exe' -ArgList @('-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '5', '--resolve', $resolve, $Url) }
  Wait-Until -Seconds 120 -What "https://$Domain antwortet nicht mit gueltigem Zertifikat (Port 80/443 von aussen erreichbar? DNS gesetzt? $logDir\caddy.log)" -Test {
    (Get-HttpCode "https://$Domain/api/health") -eq '200'
  } | Out-Null
  Ok 'Zertifikat gueltig, Health ueber https'
  $codeSpa = Get-HttpCode "https://$Domain/kalender"
  if ($codeSpa -ne '200') { Fail "/kalender liefert $codeSpa statt 200 - SPA-Fallback im Caddyfile pruefen." }
  Ok '/kalender: 200 (SPA-Fallback)'
  $codeApi = Get-HttpCode "https://$Domain/api/employees"
  if ($codeApi -ne '401') { Fail "/api/employees liefert $codeApi statt 401." }
  Ok '/api/employees: 401 (Auth-Pflicht)'
  $hsts = Invoke-Quiet -Exe 'curl.exe' -ArgList @('-sSI', '--max-time', '5', '--resolve', $resolve, "https://$Domain/")
  if ($hsts -match 'x-content-type-options') { Ok 'Sicherheitskopfzeilen vorhanden' } else { Warn 'Sicherheitskopfzeilen fehlen - Caddyfile header-Block pruefen' }

  # Server-Pin fuer die Desktop-App (SPKI-SHA-256 des Blattzertifikats)
  $pinJs = "const tls=require('tls'),c=require('crypto');const s=tls.connect(443,'127.0.0.1',{servername:'$Domain'},()=>{const x=new c.X509Certificate(s.getPeerCertificate().raw);console.log('sha256/'+c.createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('base64'));s.end()});s.on('error',e=>{console.error(e.message);process.exit(1)})"
  $pin = Invoke-Quiet -Exe 'node' -ArgList @('-e', $pinJs)
  if ($QuietExit -eq 0 -and $pin -match '^sha256/') { Ok "Server-Pin: $pin" } else { Warn 'Server-Pin nicht ermittelbar (spaeter von einem Arbeitsplatz aus, README Abschnitt 7)'; $pin = $null }
}

# ---------------------------------------------------------------------------
# 12 Zusammenfassung
# ---------------------------------------------------------------------------
Step 'Zusammenfassung'
$pwFile = Join-Path $dataDir 'initial-admin-password.txt'
if (Test-Path -LiteralPath $pwFile) {
  Write-Host "     Initialpasswort admin@ohrganize.de: $pwFile (Wechsel beim ersten Login erzwungen; danach Datei loeschen)"
} else {
  Write-Host '     Initialpasswort-Datei nicht (mehr) vorhanden - Konten sind bereits eingerichtet.'
}
if ($serviceOn) {
  $lic = Get-LicenseViaInitialLogin
  if ($lic) {
    Write-Host ("     Installations-ID: {0}" -f $lic.installation_id)
    Write-Host ("     Lizenz: {0}{1}" -f $lic.state, $(if ($lic.valid_until) { " (bis $($lic.valid_until))" } else { '' }))
    if ($lic.state -eq 'trial') {
      Write-Host '     -> Lizenz beim Anbieter mit dieser ID ausstellen lassen und mit'
      Write-Host "        .\deploy\windows\setup-server.ps1 -OnlyLicense -LicenseFile <datei>  einspielen (oder in der App: Einstellungen -> Lizenz)."
    }
  } else {
    Write-Host '     Installations-ID: in der Desktop-App unter Einstellungen -> Lizenz.'
  }
}
Write-Host ''
Write-Host '     Arbeitsplatz (im Benutzerprofil der HR-Person, KEIN Set-Content -Encoding utf8 - das schreibt eine BOM):'
$pins = if ($pin) { ", `"serverKeyPins`": [`"$pin`"]" } else { '' }
Write-Host '       New-Item -ItemType Directory "$env:APPDATA\oHRganize" -Force | Out-Null'
Write-Host ('       [IO.File]::WriteAllText("$env:APPDATA\oHRganize\config.json", ''{{ "apiBaseUrl": "https://{0}"{1} }}'', [Text.UTF8Encoding]::new($false))' -f $Domain, $pins)
Write-Host ''
Write-Host "     Protokolle: $logDir\backend.log, $logDir\caddy.log, $logDir\backup.log"
Write-Host '     Weiter mit docs\inbetriebnahme.md (Konten, Rollen, Lizenz, Abnahme).'
