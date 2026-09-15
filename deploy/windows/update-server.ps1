<#
.SYNOPSIS
  Spielt ein oHRganize-Release auf einem Windows-Server ein.
  Gegenstueck zu deploy/ohrganize-update.sh (Linux).

.DESCRIPTION
  Der Windows-Server betreibt EINEN Kunden (kein Mehrkunden-Hosting, siehe
  deploy/README.md). Dieses Skript macht den Update-Weg aus
  deploy/windows/README.md, Abschnitt 6, in einem Lauf und prueft dabei
  genau die Dinge, die von Hand uebersehen werden:

    1. Pruefsumme des Archivs (.sha256 daneben).
    2. Signatur des Anbieters (release.json + release.json.sig, geprueft mit
       ssh-keygen -Y verify gegen ohrganize-release.allowed_signers). Fehlt
       der OpenSSH-Client, wird gewarnt statt abgebrochen.
    3. AUSGABE (Land x Edition): VARIANTE.txt des Archivs gegen
       OHRGANIZE_VARIANT der env-Datei und gegen das, was der laufende Dienst
       unter /api/health meldet. Ein Archiv der falschen Ausgabe kommt nicht
       durch - der Dienst startete damit gar nicht erst, und eine Lizenz der
       richtigen Ausgabe wuerde spaeter abgelehnt.
    4. Migrations-PROBELAUF auf einer Kopie der Datenbank (migrate-check.cjs),
       BEVOR der Dienst angehalten wird.
    5. Sicherung, Dienst anhalten, altes apps\ wegsichern, entpacken,
       npm ci --omit=dev, better-sqlite3 laden, Portal kopieren, Dienst
       starten, Health pruefen.

  Geht der Start schief, wird der vorherige Stand aus dem Wegsicherungsordner
  zurueckgestellt. Hat die neue Fassung die Datenbank bereits migriert,
  startet die alte nicht mehr (Downgrade-Sperre) - dann muss die Sicherung von
  Schritt 5 zurueckgespielt werden; das Skript sagt, welche.

.PARAMETER Archive
  Pfad zum Release-Archiv (ohrganize-server-<variante>-<version>.zip).

.PARAMETER DryRun
  Nur pruefen (Schritte 1 bis 4), nichts veraendern.

.NOTES
  Als Administrator ausfuehren. PowerShell 5.1 tauglich.
  Bewusst ohne Umlaute: Windows PowerShell 5.1 liest .ps1-Dateien ohne BOM als
  ANSI. Umlaute in einer UTF-8-Datei ohne BOM kaemen als Kraut heraus.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [string]$ServiceName = 'oHRganize',
  [string]$InstallDir  = 'C:\Program Files\oHRganize',
  [string]$EnvFile     = 'C:\ProgramData\oHRganize\ohrganize.env',
  [string]$WebDir      = 'C:\ProgramData\oHRganize\web',
  [string]$NssmPath    = 'nssm',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Dieses Skript muss als Administrator laufen.'
  }
}

function Write-Step($text) { Write-Host "  -> $text" }
function Write-Note($text) { Write-Host "     $text" -ForegroundColor DarkGray }
function Write-Warn($text) { Write-Host "Achtung: $text" -ForegroundColor Yellow }

<#
  Native Programme (npm, node, ssh-keygen, nssm) schreiben Fortschritt nach
  stderr. Unter $ErrorActionPreference = 'Stop' wuerde PowerShell 5.1 das als
  Fehler werten und abbrechen - auch bei Exitcode 0. Deshalb laeuft jeder
  native Aufruf durch diese Huelle: stderr wird eingesammelt, entschieden wird
  am Exitcode. (Dieselbe Falle wie in setup-server.ps1, dort Invoke-Quiet.)
#>
function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$WorkDir = $null)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($WorkDir) { Push-Location $WorkDir }
    $output = & $File @Arguments 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Code = $code; Output = ($output | Out-String) }
  } finally {
    if ($WorkDir) { Pop-Location }
    $ErrorActionPreference = $prev
  }
}

<#
  Liest das systemd-EnvironmentFile-Format (KEY=WERT je Zeile) - dasselbe
  Format wie unter Linux, damit die Variablen nur EINMAL erklaert sind
  (deploy/ohrganize.env.example).
#>
function Read-EnvFile([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $i = $trimmed.IndexOf('=')
    if ($i -lt 1) { continue }
    $map[$trimmed.Substring(0, $i).Trim()] = $trimmed.Substring($i + 1).Trim()
  }
  return $map
}

function Get-Health([int]$port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
  } catch {
    return $null
  }
}

function Wait-ForHealth([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Get-Health $port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Assert-Admin
if (-not (Test-Path -LiteralPath $Archive)) { throw "Archiv $Archive nicht gefunden." }
$Archive = (Resolve-Path -LiteralPath $Archive).Path
$archiveDir = Split-Path -Parent $Archive
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host "oHRganize Update auf einem Windows-Server"
Write-Host "  Archiv:  $Archive"
Write-Host "  Ziel:    $InstallDir"
Write-Host ''

# ---------------------------------------------------------------------------
# 1. Pruefsumme
# ---------------------------------------------------------------------------
Write-Host '1. Pruefsumme'
$sumFile = "$Archive.sha256"
if (Test-Path -LiteralPath $sumFile) {
  $expected = ((Get-Content -LiteralPath $sumFile -First 1) -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    throw "Pruefsumme stimmt nicht. Erwartet $expected, berechnet $actual. Archiv verwerfen und neu holen."
  }
  Write-Step 'Pruefsumme stimmt'
} else {
  Write-Warn "Keine $sumFile neben dem Archiv - Pruefsumme nicht geprueft."
}

# ---------------------------------------------------------------------------
# 2. Signatur des Anbieters
# ---------------------------------------------------------------------------
Write-Host '2. Signatur'
$manifestFile = Join-Path $archiveDir 'release.json'
$sigFile = Join-Path $archiveDir 'release.json.sig'
$signers = Join-Path $InstallDir 'deploy\ohrganize-release.allowed_signers'
if ((Test-Path $manifestFile) -and (Test-Path $sigFile)) {
  $ssh = Get-Command ssh-keygen -ErrorAction SilentlyContinue
  if (-not $ssh) {
    Write-Warn 'ssh-keygen fehlt (Optionale Features -> OpenSSH-Client) - Signatur nicht geprueft.'
  } elseif (-not (Test-Path $signers)) {
    Write-Warn "$signers fehlt - Signatur nicht geprueft."
  } elseif (-not ((Get-Content -LiteralPath $signers) -notmatch '^\s*(#.*)?$')) {
    Write-Warn "In $signers steht noch kein Schluessel - Signatur nicht geprueft."
  } else {
    # ssh-keygen -Y verify liest das Manifest von stdin.
    $verify = Invoke-Native -File 'cmd.exe' -Arguments @(
      '/c', "ssh-keygen -Y verify -f `"$signers`" -I release@ohrganize -n ohrganize-release -s `"$sigFile`" < `"$manifestFile`""
    )
    if ($verify.Code -ne 0) {
      throw "Die Signatur des Release-Manifests ist ungueltig. Archiv NICHT einspielen.`n$($verify.Output)"
    }
    Write-Step 'Signatur des Anbieters stimmt'

    # Erst die Pruefsumme im signierten Manifest bindet das Archiv an die Signatur.
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $entry = $manifest.artifacts | Where-Object { $_.file -eq (Split-Path -Leaf $Archive) }
    if ($entry) {
      $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLower()
      if ($entry.sha256.ToLower() -ne $actual) {
        throw 'Die Pruefsumme des Archivs steht nicht im signierten Manifest. Archiv NICHT einspielen.'
      }
      Write-Step 'Archiv steht im signierten Manifest'
    }
  }
} else {
  Write-Warn 'Kein release.json samt release.json.sig neben dem Archiv - Signatur nicht geprueft.'
}

# ---------------------------------------------------------------------------
# 3. Ausgabe (Variante)
# ---------------------------------------------------------------------------
Write-Host '3. Ausgabe'
$peek = Join-Path ([IO.Path]::GetTempPath()) ("ohrganize-peek-$stamp")
New-Item -ItemType Directory -Path $peek -Force | Out-Null
try {
  Expand-Archive -LiteralPath $Archive -DestinationPath $peek -Force
  $variantFile = Join-Path $peek 'VARIANTE.txt'
  if (-not (Test-Path $variantFile)) {
    throw 'Im Archiv fehlt VARIANTE.txt. Ein Archiv ohne Ausgabe wird nicht eingespielt - der Server liefe sonst still mit fremdem Funktionsumfang.'
  }
  $archiveVariant = (Get-Content -LiteralPath $variantFile -Raw).Trim()
  $releaseInfo = $null
  $releaseFile = Join-Path $peek 'release.json'
  if (Test-Path $releaseFile) { $releaseInfo = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json }
  Write-Step "Archiv: Ausgabe $archiveVariant, Version $(if ($releaseInfo) { $releaseInfo.version } else { 'unbekannt' })"

  $envMap = Read-EnvFile $EnvFile
  $envVariant = $envMap['OHRGANIZE_VARIANT']
  if ($envVariant -and $envVariant -ne $archiveVariant) {
    throw "Die env-Datei nennt die Ausgabe `"$envVariant`", das Archiv ist `"$archiveVariant`". Falsches Archiv - NICHT einspielen."
  }
  if (-not $envVariant) {
    Write-Warn "In $EnvFile steht kein OHRGANIZE_VARIANT. Bitte nachtragen: OHRGANIZE_VARIANT=$archiveVariant"
  }

  $port = 3001
  if ($envMap['OHRGANIZE_PORT']) { $port = [int]$envMap['OHRGANIZE_PORT'] }
  $health = Get-Health $port
  if ($health -and $health.variant -and $health.variant.id -ne $archiveVariant) {
    throw "Der laufende Dienst meldet die Ausgabe `"$($health.variant.id)`", das Archiv ist `"$archiveVariant`". Falsches Archiv - NICHT einspielen."
  }
  if ($health) {
    Write-Step "Laufender Dienst: Version $($health.version), Ausgabe $($health.variant.id), Kanal $($health.channel)"
  } else {
    Write-Note "Der Dienst antwortet auf 127.0.0.1:$port nicht (gestoppt?) - Vergleich uebersprungen."
  }

  # -------------------------------------------------------------------------
  # 4. Migrations-Probelauf auf einer Kopie
  # -------------------------------------------------------------------------
  Write-Host '4. Migrations-Probelauf'
  $dataDir = $envMap['OHRGANIZE_DATA_DIR']
  if (-not $dataDir) { $dataDir = 'C:\ProgramData\oHRganize\data' }
  $dbFile = Join-Path $dataDir 'ohrganize.db'
  $checker = Join-Path $peek 'apps\backend\dist\migrate-check.cjs'
  if (-not (Test-Path $checker)) {
    Write-Warn 'migrate-check.cjs fehlt im Archiv (aelteres Release) - kein Probelauf moeglich.'
  } elseif (-not (Test-Path $dbFile)) {
    Write-Note 'Noch keine Datenbank vorhanden - nichts zu pruefen.'
  } else {
    # Der Probelauf braucht node_modules des Archivs noch nicht: better-sqlite3
    # liegt bereits im Zielverzeichnis der laufenden Installation.
    $probe = Invoke-Native -File 'node' -Arguments @($checker, '--db', $dbFile) -WorkDir $InstallDir
    Write-Host $probe.Output
    if ($probe.Code -ne 0) {
      throw 'Der Migrations-Probelauf ist fehlgeschlagen. Es wurde nichts veraendert.'
    }
    Write-Step 'Probelauf ohne Befund'
  }

  if ($DryRun) {
    Write-Host ''
    Write-Host 'DryRun: geprueft, nichts veraendert.' -ForegroundColor Cyan
    return
  }

  # -------------------------------------------------------------------------
  # 5. Umstellen
  # -------------------------------------------------------------------------
  Write-Host '5. Umstellen'
  Write-Step 'Sicherung vor dem Update'
  $task = Get-ScheduledTask -TaskName 'oHRganize-Sicherung' -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName 'oHRganize-Sicherung'
    # Die Aufgabe laeuft asynchron; auf ihr Ende warten, sonst sichert sie
    # gegen eine Datenbank, die gleich ersetzt wird.
    while ((Get-ScheduledTask -TaskName 'oHRganize-Sicherung').State -eq 'Running') { Start-Sleep -Seconds 2 }
    Write-Note 'Sicherung abgeschlossen (Zielordner siehe Aufgabendefinition).'
  } else {
    Write-Warn 'Die geplante Aufgabe oHRganize-Sicherung gibt es nicht. Ohne Sicherung gibt es keinen Rueckweg aus einer Migration.'
  }

  Write-Step "Dienst $ServiceName anhalten"
  Invoke-Native -File $NssmPath -Arguments @('stop', $ServiceName) | Out-Null

  $appsDir = Join-Path $InstallDir 'apps'
  $appsBackup = Join-Path $InstallDir "apps.alt-$stamp"
  if (Test-Path $appsDir) {
    Write-Step "Alten Stand nach $appsBackup verschieben"
    Move-Item -LiteralPath $appsDir -Destination $appsBackup
  }

  Write-Step "Archiv nach $InstallDir entpacken"
  Expand-Archive -LiteralPath $Archive -DestinationPath $InstallDir -Force

  Write-Step 'npm ci --omit=dev'
  $npm = Invoke-Native -File 'npm.cmd' -Arguments @('ci', '--omit=dev') -WorkDir $InstallDir
  if ($npm.Code -ne 0) { throw "npm ci ist fehlgeschlagen.`n$($npm.Output)" }

  Write-Step 'better-sqlite3 laedt'
  # Ein blosses require() laedt die native Bindung noch nicht; erst `new` zeigt,
  # ob sie da ist.
  $probe = Invoke-Native -File 'node' -Arguments @('-e', "new (require('better-sqlite3'))(':memory:')") -WorkDir $InstallDir
  if ($probe.Code -ne 0) {
    throw "better-sqlite3 laedt nicht. Build-Werkzeuge fehlen? Siehe deploy/windows/README.md, Abschnitt 1.`n$($probe.Output)"
  }

  Write-Step "Portal nach $WebDir kopieren"
  if (Test-Path $WebDir) { Remove-Item -Path (Join-Path $WebDir '*') -Recurse -Force }
  New-Item -ItemType Directory -Path $WebDir -Force | Out-Null
  Copy-Item -Path (Join-Path $InstallDir 'apps\web\dist\*') -Destination $WebDir -Recurse -Force

  Write-Step "Dienst $ServiceName starten"
  Invoke-Native -File $NssmPath -Arguments @('start', $ServiceName) | Out-Null

  if (Wait-ForHealth $port 45) {
    $health = Get-Health $port
    Write-Host ''
    Write-Host "Update abgeschlossen: Version $($health.version), Ausgabe $($health.variant.id), Kanal $($health.channel)" -ForegroundColor Green
    Write-Note "Alter Stand: $appsBackup (nach der Kontrolle loeschen)"
  } else {
    Write-Warn 'Das Backend antwortet nach 45 s nicht. Nehme den alten Stand zurueck.'
    Invoke-Native -File $NssmPath -Arguments @('stop', $ServiceName) | Out-Null
    if (Test-Path $appsBackup) {
      Remove-Item -LiteralPath $appsDir -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $appsBackup -Destination $appsDir
      Invoke-Native -File $NssmPath -Arguments @('start', $ServiceName) | Out-Null
      if (Wait-ForHealth $port 45) {
        Write-Host 'Die alte Fassung laeuft wieder.' -ForegroundColor Yellow
      } else {
        Write-Host ''
        Write-Host 'Auch die alte Fassung startet nicht. Vermutlich hat die neue Fassung die' -ForegroundColor Red
        Write-Host 'Datenbank bereits migriert; ein Downgrade ist dann gesperrt. Bitte die' -ForegroundColor Red
        Write-Host 'Sicherung von eben zurueckspielen (deploy/windows/README.md, Abschnitt 5)' -ForegroundColor Red
        Write-Host 'und danach das Log pruefen:' -ForegroundColor Red
        Write-Host '  Get-Content C:\ProgramData\oHRganize\logs\backend.log -Tail 50' -ForegroundColor Red
      }
    }
    throw 'Update fehlgeschlagen.'
  }
} finally {
  Remove-Item -LiteralPath $peek -Recurse -Force -ErrorAction SilentlyContinue
}
