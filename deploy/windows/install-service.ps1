<#
.SYNOPSIS
  Registriert das HRMONIC-Backend als Windows-Dienst (via NSSM).
  Gegenstueck zu deploy/hrmonic-backend.service.

.DESCRIPTION
  Windows kennt kein systemd. NSSM (Non-Sucking Service Manager) haengt ein
  beliebiges Programm als Dienst ein und uebernimmt Neustart, Protokollierung
  und geordnetes Beenden - genau die vier Dinge, die die systemd-Unit leistet.

  ABBILDUNG DER UNIT-EINSTELLUNGEN:
    ExecStart            -> Application + AppParameters
    EnvironmentFile      -> AppEnvironmentExtra (diese Datei liest die env ein)
    User=hrmonic         -> ObjectName "NT SERVICE\HRMONIC" (virtuelles Konto)
    UMask=0077           -> harden-data-dir.ps1 (NTFS-ACLs)
    Restart=on-failure   -> AppExit Default Restart + AppRestartDelay
    KillSignal=SIGTERM   -> AppStopMethodConsole (Strg+C -> SIGINT)
    StandardOutput=...   -> AppStdout/AppStderr mit Rotation

  ZUM STOPPSIGNAL: NSSM schickt zuerst Strg+C an die Konsole des Prozesses,
  was Node unter Windows als SIGINT zustellt. index.ts behandelt SIGINT
  gleichwertig zu SIGTERM und fuehrt den WAL-Checkpoint aus. Ohne das stuenden
  die juengsten Aenderungen nur in hrmonic.db-wal. Die Wartezeit liegt wie
  TimeoutStopSec bewusst ueber der Selbstabbruchgrenze des Handlers (10 s).

  cli.cjs, NICHT server.cjs: server.cjs ist das Embedding-Bundle der
  Desktop-App und startet von sich aus nichts.

.NOTES
  Als Administrator ausfuehren. Idempotent: Ein vorhandener Dienst wird
  angehalten und neu konfiguriert, nicht doppelt angelegt.

  Bewusst ohne Umlaute: Windows PowerShell 5.1 liest .ps1-Dateien ohne BOM als
  ANSI. Umlaute in einer UTF-8-Datei ohne BOM kaemen als Kraut heraus.
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'HRMONIC',
  [string]$InstallDir  = 'C:\Program Files\HRMONIC',
  [string]$EnvFile     = 'C:\ProgramData\HRMONIC\hrmonic.env',
  [string]$LogDir      = 'C:\ProgramData\HRMONIC\logs',
  [string]$NssmPath    = 'nssm'
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Dieses Skript muss als Administrator laufen.'
  }
}

<#
  Liest das systemd-EnvironmentFile-Format: KEY=WERT je Zeile, Kommentare in
  eigenen Zeilen, keine Anfuehrungszeichen noetig, keine Shell-Expansion.
  Bewusst dasselbe Format wie unter Linux - die Variablen und ihre Bedeutung
  sind identisch und stehen nur EINMAL erklaert, in deploy/hrmonic.env.example.
#>
function Read-EnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Konfiguration nicht gefunden: $Path (Vorlage: deploy\windows\hrmonic.env.example)"
  }
  $pairs = @()
  foreach ($line in Get-Content -LiteralPath $Path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $key = $t.Substring(0, $i).Trim()
    $val = $t.Substring($i + 1).Trim()
    # Anfuehrungszeichen abstreifen, falls doch welche gesetzt wurden.
    if ($val.Length -ge 2 -and $val[0] -eq '"' -and $val[-1] -eq '"') {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $pairs += "$key=$val"
  }
  if ($pairs.Count -eq 0) { throw "Keine Variablen in $Path gefunden." }
  return $pairs
}

Assert-Admin

# --- Voraussetzungen -------------------------------------------------------
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node.exe nicht im PATH. Node.js >= 20 installieren.' }
$nodeVersion = (& node.exe -v)
Write-Host "Node: $nodeVersion ($($node.Source))"

$nssm = (Get-Command $NssmPath -ErrorAction SilentlyContinue)
if (-not $nssm) { throw "nssm nicht gefunden ($NssmPath). Siehe deploy\windows\README.md, Abschnitt 2." }

$entry = Join-Path $InstallDir 'apps\backend\dist\cli.cjs'
if (-not (Test-Path -LiteralPath $entry)) {
  throw "Backend-Bundle fehlt: $entry - zuerst 'npm run build -w apps/backend' ausfuehren."
}

$envPairs = Read-EnvFile -Path $EnvFile
Write-Host "Konfiguration: $($envPairs.Count) Variablen aus $EnvFile"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# --- Dienst anlegen bzw. neu konfigurieren ---------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Dienst $ServiceName existiert - wird angehalten und neu konfiguriert."
  if ($existing.Status -ne 'Stopped') { & $NssmPath stop $ServiceName | Out-Null }
} else {
  & $NssmPath install $ServiceName $node.Source $entry
  if ($LASTEXITCODE -ne 0) { throw "nssm install fehlgeschlagen (Code $LASTEXITCODE)." }
}

& $NssmPath set $ServiceName Application    $node.Source            | Out-Null
& $NssmPath set $ServiceName AppParameters  "`"$entry`""            | Out-Null
& $NssmPath set $ServiceName AppDirectory   (Join-Path $InstallDir 'apps\backend') | Out-Null
& $NssmPath set $ServiceName DisplayName    'HRMONIC Backend'       | Out-Null
& $NssmPath set $ServiceName Description    'HRMONIC Backend (HR-Verwaltung, REST-API)' | Out-Null
& $NssmPath set $ServiceName Start          SERVICE_AUTO_START      | Out-Null

# Umgebungsvariablen. AppEnvironmentExtra erwartet die Paare als getrennte
# Argumente; ERSETZT (nicht ergaenzt) bei jedem Lauf, damit eine entfernte
# Variable auch wirklich verschwindet.
& $NssmPath set $ServiceName AppEnvironmentExtra @envPairs | Out-Null

# Protokoll. Gegenstueck zu journalctl: eine Datei mit Rotation.
& $NssmPath set $ServiceName AppStdout      (Join-Path $LogDir 'backend.log') | Out-Null
& $NssmPath set $ServiceName AppStderr      (Join-Path $LogDir 'backend.log') | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1          | Out-Null
& $NssmPath set $ServiceName AppRotateOnline 1         | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 20971520   | Out-Null

# Neustart bei Absturz (Restart=on-failure / RestartSec=5).
& $NssmPath set $ServiceName AppExit Default Restart   | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000      | Out-Null

# Geordnetes Beenden: nur Strg+C (=SIGINT) zulassen und 20 s Zeit geben.
# 1 = Console. WM_CLOSE/Thread/Terminate bleiben aus, damit der Prozess nicht
# hart abgeschossen wird, bevor der WAL-Checkpoint durch ist.
& $NssmPath set $ServiceName AppStopMethodSkip 6       | Out-Null
& $NssmPath set $ServiceName AppStopMethodConsole 20000 | Out-Null

# Virtuelles Dienstkonto statt LocalSystem: Windows-Gegenstueck zum
# Systemkonto "hrmonic" der Unit. Es entsteht automatisch mit dem Dienst und
# hat kein Passwort und kein Anmelderecht.
& sc.exe config $ServiceName obj= "NT SERVICE\$ServiceName" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Virtuelles Dienstkonto konnte nicht gesetzt werden; der Dienst laeuft als LocalSystem.'
}

# NTFS-Rechte jetzt setzen - erst hier existiert das Dienstkonto.
& (Join-Path $PSScriptRoot 'harden-data-dir.ps1') -ServiceAccount "NT SERVICE\$ServiceName"

& $NssmPath start $ServiceName
Start-Sleep -Seconds 2
Get-Service -Name $ServiceName | Format-List Name, Status, StartType

Write-Host ''
Write-Host 'Pruefen:'
Write-Host '  Invoke-RestMethod http://127.0.0.1:3001/api/health'
Write-Host "  Get-Content $LogDir\backend.log -Tail 40"
