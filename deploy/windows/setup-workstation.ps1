<#
.SYNOPSIS
  Richtet einen HR-Arbeitsplatz fuer den Serverbetrieb ein: Desktop-App
  installieren (optional), Serveradresse und Server-Pin in config.json
  schreiben, Erreichbarkeit pruefen, App starten. Gegenstueck zu
  deploy/windows/README.md, Abschnitt 7.

.DESCRIPTION
  Muss im Windows-Konto der Person laufen, die mit der App arbeitet - die
  Konfiguration liegt in deren Profil (%APPDATA%\oHRganize\config.json).
  KEINE Adminrechte: Der Installer ist ein Benutzer-Setup, und eine erhoehte
  PowerShell unter einem anderen Konto schriebe in das falsche Profil.

  Schritte:
    1  Konto und Profil anzeigen, Eingaben pruefen
    2  App installieren, falls -Installer angegeben und noch nicht installiert
       (stiller Lauf /S, Benutzer-Setup nach %LOCALAPPDATA%\Programs\oHRganize)
    3  Kein lokales Datenverzeichnis vorhanden (sonst lief die App schon
       einmal ohne Serveradresse - Abbruch mit Hinweis, -RemoveLocalData
       loescht eine leere Erstanlage)
    4  config.json schreiben (UTF-8 ohne BOM): apiBaseUrl und, falls
       angegeben, serverKeyPins
    5  Server erreichbar (GET /api/health)
    6  App starten (ausser -NoLaunch)

  Alternative fuer den Rollout per Gruppenrichtlinie: -Machine setzt statt der
  Datei die Maschinenvariablen OHRGANIZE_API_BASE und OHRGANIZE_SERVER_KEY_PINS
  (dafuer Adminrechte noetig; gilt fuer alle Konten des Rechners).

.EXAMPLE
  .\setup-workstation.ps1 -ApiBaseUrl 'https://kunde.ohrganize.com' `
      -ServerPin 'sha256/…' -Installer '.\oHRganize Setup 1.0.0-beta.1.exe'

.NOTES
  Windows PowerShell 5.1 genuegt. Bewusst ohne Umlaute (5.1 liest .ps1 ohne
  BOM als ANSI). Den Server-Pin liefert setup-server.ps1 am Ende seines Laufs.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ApiBaseUrl,
  [string]$ServerPin = '',
  [string]$Installer = '',
  [string]$ConfigDir = (Join-Path $env:APPDATA 'oHRganize'),
  [string]$AppExe    = (Join-Path $env:LOCALAPPDATA 'Programs\oHRganize\oHRganize.exe'),
  [switch]$Machine,
  [switch]$RemoveLocalData,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$script:StepNo = 0
function Step { param([string]$Text) $script:StepNo++; Write-Host ''; Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan }
function Ok   { param([string]$Text) Write-Host "    ok  $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "    !!  $Text" -ForegroundColor Yellow }
function Fail { param([string]$Text) throw "Abbruch: $Text" }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# 1  Eingaben
# ---------------------------------------------------------------------------
Step "Konto $env:USERNAME, Profil $env:APPDATA"
$ApiBaseUrl = $ApiBaseUrl.Trim()
# https ueber das Netz; http nur fuer den lokalen Test gegen 127.0.0.1 (README Abschnitt 7).
if ($ApiBaseUrl -notmatch '^https://[a-z0-9.-]+(:\d+)?$' -and $ApiBaseUrl -notmatch '^http://127\.0\.0\.1(:\d+)?$') {
  Fail "-ApiBaseUrl muss 'https://<host>' sein - ohne Pfad, ohne Schraegstrich am Ende (erhalten: $ApiBaseUrl)."
}
$pins = @()
if ($ServerPin -ne '') {
  foreach ($p in ($ServerPin -split ',')) {
    $t = $p.Trim()
    if ($t -notmatch '^sha256/[A-Za-z0-9+/=]{44}$') { Fail "-ServerPin '$t' hat nicht die Form sha256/<44 Zeichen Base64> (Wert aus der Ausgabe von setup-server.ps1)." }
    $pins += $t
  }
  Ok "Server-Pin: $($pins -join ', ')"
} else {
  Warn 'Kein -ServerPin: Die App merkt sich den Serverschluessel beim ersten Kontakt (trust on first use).'
}
if ($Machine) {
  if (-not (Test-Admin)) { Fail '-Machine setzt Maschinenvariablen und braucht eine Administrator-PowerShell.' }
} elseif (Test-Admin) {
  Warn "Erhoehte PowerShell: config.json landet im Profil von $env:USERNAME - ist das die HR-Person? Sonst ohne Adminrechte in deren Konto ausfuehren."
}

# ---------------------------------------------------------------------------
# 2  App
# ---------------------------------------------------------------------------
Step 'Desktop-App'
if (Test-Path -LiteralPath $AppExe) {
  Ok "Installiert: $AppExe"
} elseif ($Installer -ne '') {
  if (-not (Test-Path -LiteralPath $Installer)) { Fail "Installer nicht gefunden: $Installer" }
  Unblock-File -LiteralPath $Installer
  $proc = Start-Process -FilePath (Resolve-Path -LiteralPath $Installer).Path -ArgumentList '/S' -Wait -PassThru
  if ($proc.ExitCode -ne 0) { Fail "Installer beendete sich mit Code $($proc.ExitCode)." }
  if (-not (Test-Path -LiteralPath $AppExe)) { Fail "Nach der Installation fehlt $AppExe - Installer manuell ausfuehren und Zielordner pruefen." }
  Ok "Installiert (still): $AppExe"
} else {
  Fail "App nicht installiert ($AppExe fehlt). Installer mit -Installer '<pfad>\oHRganize Setup <version>.exe' angeben."
}

# ---------------------------------------------------------------------------
# 3  Kein lokales Datenverzeichnis
# ---------------------------------------------------------------------------
Step 'Lokales Datenverzeichnis'
$localData = Join-Path $ConfigDir 'data'
if (Test-Path -LiteralPath $localData) {
  $db = Join-Path $localData 'ohrganize.db'
  $size = if (Test-Path -LiteralPath $db) { (Get-Item -LiteralPath $db).Length } else { 0 }
  if ($RemoveLocalData) {
    # Nur eine frische Erstanlage loeschen: Eine Datenbank mit Echtdaten ist
    # deutlich groesser als die leere (Migrationen + Standard-Admin, < 1 MB).
    if ($size -gt 1MB) { Fail "$db ist $([math]::Round($size / 1MB, 1)) MB gross - vermutlich Echtdaten. Nicht loeschen; siehe README Abschnitt 8 (Umzug)." }
    Get-Process -Name 'oHRganize' -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item -LiteralPath $localData -Recurse -Force
    Ok "Leere lokale Datenbank entfernt ($localData)"
  } else {
    Fail "$localData existiert - die App lief hier schon einmal ohne Serveradresse. Enthaelt sie nur die leere Erstanlage: erneut mit -RemoveLocalData. Wurde darin gearbeitet: README Abschnitt 8 (Umzug)."
  }
} else {
  Ok 'Keins vorhanden'
}

# ---------------------------------------------------------------------------
# 4  Konfiguration
# ---------------------------------------------------------------------------
if ($Machine) {
  Step 'Maschinenvariablen (alle Konten dieses Rechners)'
  [Environment]::SetEnvironmentVariable('OHRGANIZE_API_BASE', $ApiBaseUrl, 'Machine')
  if ($pins.Count -gt 0) { [Environment]::SetEnvironmentVariable('OHRGANIZE_SERVER_KEY_PINS', ($pins -join ','), 'Machine') }
  else { [Environment]::SetEnvironmentVariable('OHRGANIZE_SERVER_KEY_PINS', $null, 'Machine') }
  Ok ("OHRGANIZE_API_BASE=$ApiBaseUrl" + $(if ($pins.Count -gt 0) { ', OHRGANIZE_SERVER_KEY_PINS gesetzt' } else { '' }))
  Warn 'Gilt fuer Prozesse, die NACH dieser Aenderung gestartet werden (Explorer/Startmenue ggf. neu anmelden).'
} else {
  Step "config.json in $ConfigDir"
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
  $cfgPath = Join-Path $ConfigDir 'config.json'
  $cfg = [ordered]@{ apiBaseUrl = $ApiBaseUrl }
  if ($pins.Count -gt 0) { $cfg.serverKeyPins = $pins }
  $json = ($cfg | ConvertTo-Json -Compress)
  if ((Test-Path -LiteralPath $cfgPath) -and ((Get-Content -LiteralPath $cfgPath -Raw) -ne $json)) {
    Copy-Item -LiteralPath $cfgPath -Destination "$cfgPath.vorher" -Force
    Warn "Vorhandene config.json ersetzt; alte Fassung: $cfgPath.vorher"
  }
  # UTF-8 OHNE BOM: Set-Content -Encoding utf8 schreibt in 5.1 eine BOM.
  [IO.File]::WriteAllText($cfgPath, $json, [Text.UTF8Encoding]::new($false))
  Ok "Geschrieben: $json"
}

# ---------------------------------------------------------------------------
# 5  Server erreichbar
# ---------------------------------------------------------------------------
Step "Server $ApiBaseUrl"
try {
  $health = Invoke-RestMethod -Uri "$ApiBaseUrl/api/health" -TimeoutSec 10
} catch {
  Fail "Server nicht erreichbar: $($_.Exception.Message) (DNS, Firewall, Zertifikat?)"
}
if ($health.ok -ne $true) { Fail "Unerwartete Antwort von /api/health: $($health | ConvertTo-Json -Compress)" }
Ok ("Backend {0}, Aenderungen moeglich: {1}" -f $health.version, (-not $health.license.read_only))

# ---------------------------------------------------------------------------
# 6  Start
# ---------------------------------------------------------------------------
if (-not $NoLaunch) {
  Step 'App starten'
  Start-Process -FilePath $AppExe | Out-Null
  Ok 'Gestartet - jetzt mit dem HR-Konto anmelden.'
}

Write-Host ''
Write-Host 'Danach pruefen (muss False bleiben; sonst lief die App ohne Serveradresse):'
Write-Host "  Test-Path '$localData'"
if ($pins.Count -eq 0) {
  Write-Host 'Beim ersten Start erscheint einmalig "Serverschluessel gemerkt" - den dort gezeigten Wert fuer weitere Arbeitsplaetze als -ServerPin verwenden.'
}
