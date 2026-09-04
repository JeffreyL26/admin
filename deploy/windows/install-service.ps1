<#
.SYNOPSIS
  Registriert das oHRganize-Backend als Windows-Dienst (via NSSM).
  Gegenstueck zu deploy/ohrganize-backend.service.

.DESCRIPTION
  Windows kennt kein systemd. NSSM (Non-Sucking Service Manager) haengt ein
  beliebiges Programm als Dienst ein und uebernimmt Neustart, Protokollierung
  und geordnetes Beenden - genau die vier Dinge, die die systemd-Unit leistet.

  ABBILDUNG DER UNIT-EINSTELLUNGEN:
    ExecStart            -> Application + AppParameters
    EnvironmentFile      -> AppEnvironmentExtra (diese Datei liest die env ein)
    User=ohrganize       -> ObjectName "NT SERVICE\oHRganize" (virtuelles Konto)
    UMask=0077           -> harden-data-dir.ps1 (NTFS-ACLs)
    Restart=on-failure   -> AppExit Default Restart + AppRestartDelay
    KillSignal=SIGTERM   -> AppStopMethodConsole (Strg+C -> SIGINT)
    StandardOutput=...   -> AppStdout/AppStderr mit Rotation

  ZUM STOPPSIGNAL: NSSM schickt zuerst Strg+C an die Konsole des Prozesses,
  was Node unter Windows als SIGINT zustellt. index.ts behandelt SIGINT
  gleichwertig zu SIGTERM und fuehrt den WAL-Checkpoint aus. Ohne das stuenden
  die juengsten Aenderungen nur in ohrganize.db-wal. Die Wartezeit liegt wie
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
  [string]$ServiceName = 'oHRganize',
  [string]$InstallDir  = 'C:\Program Files\oHRganize',
  [string]$EnvFile     = 'C:\ProgramData\oHRganize\ohrganize.env',
  [string]$LogDir      = 'C:\ProgramData\oHRganize\logs',
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
  sind identisch und stehen nur EINMAL erklaert, in deploy/ohrganize.env.example.
#>
function Read-EnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Konfiguration nicht gefunden: $Path (Vorlage: deploy\windows\ohrganize.env.example)"
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

<#
  Ermittelt die SID des virtuellen Dienstkontos "NT SERVICE\<Name>".

  WARUM UEBER DIE SID UND NICHT UEBER DEN NAMEN: Die Haertung muss laufen,
  BEVOR der Dienst zum ersten Mal startet - der erste Start schreibt das
  erzeugte Initialpasswort nach logs\backend.log. Der Kontoname ist zu diesem
  Zeitpunkt aber noch nicht aufloesbar, weil das virtuelle Konto erst mit der
  Dienstregistrierung entsteht. sc.exe showsid rechnet die SID allein aus dem
  Dienstnamen aus und liefert sie deshalb auch fuer einen Dienst, den es noch
  gar nicht gibt.

  Ausgewertet wird per regulaerem Ausdruck, nicht ueber die Beschriftung:
  sc.exe ist lokalisiert - deutsches Windows schreibt "DIENST-SID:", englisches
  "SERVICE SID:". Dieselbe Ueberlegung wie bei den well-known SIDs in
  harden-data-dir.ps1.
#>
function Get-ServiceSid {
  param([string]$Name)

  # ErrorActionPreference kurz zuruecknehmen: Windows PowerShell 5.1 verpackt
  # jede stderr-Zeile eines nativen Programms in einen ErrorRecord, sobald man
  # sie umleitet - unter 'Stop' braeche das Skript an dieser Zeile ab, statt die
  # Auswertung unten erreichen zu koennen.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out  = (& sc.exe showsid $Name 2>&1) -join "`n"
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap

  # S-1-5-80-... ist der Praefix aller Dienst-SIDs (NT SERVICE).
  $match = [regex]::Match($out, 'S-1-5-80-[0-9]+(?:-[0-9]+)+')
  if ($code -ne 0 -or -not $match.Success) {
    throw ("Dienst-SID fuer '$Name' nicht ermittelbar (sc.exe showsid, Code $code). " +
      'Abbruch statt ungehaerteter Weiterlauf: Ohne die SID bekaeme das Log-Verzeichnis ' +
      'keine passende ACL, und der erste Dienststart legte das Initialpasswort fuer ' +
      'jedes lokale Konto lesbar ab.')
  }
  # Fuehrendes "*" ist die icacls-Schreibweise fuer "das ist eine SID, kein Name".
  return "*$($match.Value)"
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

# OHRGANIZE_DATA_DIR ist Pflicht, und zwar HIER pruefbar statt spaeter schmerzhaft:
# Fehlt die Variable, faellt config.ts auf ein Verzeichnis NEBEN dem
# Programmverzeichnis zurueck (C:\Program Files\oHRganize\...). Als virtuelles
# Dienstkonto scheitert das Anlegen dort an den Rechten - der Dienst landet in
# einer Neustartschleife. Faellt der Dienst mangels Dienstkonto auf LocalSystem
# zurueck, gelingt es sogar: Dann laeuft oHRganize still mit einer leeren
# Datenbank am falschen Ort, die Sicherung greift ins Leere, und beim naechsten
# Update ist alles weg. Beide Ausgaenge sind schlechter als ein Abbruch jetzt.
$dataDirPair = $envPairs | Where-Object { $_ -like 'OHRGANIZE_DATA_DIR=*' } | Select-Object -First 1
if (-not $dataDirPair) {
  throw "OHRGANIZE_DATA_DIR fehlt in $EnvFile. Ohne die Variable legt das Backend seine Daten neben dem Programmverzeichnis an. Vorlage: deploy\windows\ohrganize.env.example"
}
$dataDir = $dataDirPair.Substring('OHRGANIZE_DATA_DIR='.Length).Trim()
if ($dataDir -eq '') {
  throw "OHRGANIZE_DATA_DIR ist in $EnvFile leer. Bitte einen Pfad eintragen, z. B. C:\ProgramData\oHRganize\data"
}
Write-Host "Datenverzeichnis laut Konfiguration: $dataDir"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# --- NTFS-Rechte VOR jeder Dienstaktion ------------------------------------
# Reihenfolge ist sicherheitsrelevant: Der erste Dienststart schreibt das
# erzeugte Initialpasswort fuer admin@ohrganize.de nach logs\backend.log. Liegt
# die ACL erst danach, war das Passwort zwischenzeitlich fuer die Gruppe
# "Benutzer" lesbar (Erbe von C:\ProgramData). Deshalb haerten wir hier, noch
# vor "nssm install" - und uebergeben das Dienstkonto als SID, weil sein Name
# zu diesem Zeitpunkt noch nicht existiert.
#
# $dataDir kommt aus der env-Datei, nicht aus der Vorgabe von
# harden-data-dir.ps1: Gehaertet wird das Verzeichnis, das der Dienst wirklich
# benutzt.
$serviceSid = Get-ServiceSid -Name $ServiceName
& (Join-Path $PSScriptRoot 'harden-data-dir.ps1') `
  -DataDir $dataDir -LogDir $LogDir -EnvFile $EnvFile -ServiceAccount $serviceSid

# --- Dienst anlegen bzw. neu konfigurieren ---------------------------------
# Merkt, ob dieser Lauf den Dienst angelegt hat - entscheidet unten, ob ein
# Fehlschlag beim Setzen des Dienstkontos den Dienst entfernt oder nur den
# Autostart zurueckdreht.
$freshlyInstalled = $false
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Dienst $ServiceName existiert - wird angehalten und neu konfiguriert."
  if ($existing.Status -ne 'Stopped') { & $NssmPath stop $ServiceName | Out-Null }
} else {
  & $NssmPath install $ServiceName $node.Source $entry
  if ($LASTEXITCODE -ne 0) { throw "nssm install fehlgeschlagen (Code $LASTEXITCODE)." }
  $freshlyInstalled = $true
}

# Virtuelles Dienstkonto statt LocalSystem: Windows-Gegenstueck zum
# Systemkonto "ohrganize" der Unit. Es entsteht automatisch mit dem Dienst und
# hat kein Passwort und kein Anmelderecht.
#
# WARUM DIREKT HIER und nicht am Ende: NSSM legt den Dienst mit LocalSystem an.
# Stuende die Zuweisung nach "Start SERVICE_AUTO_START", liesse ein Abbruch an
# dieser Stelle einen vollstaendig registrierten Dienst zurueck, der beim
# naechsten Serverstart genau so hochkaeme, wie der Abbruch es verhindern soll:
# als LocalSystem. Erst das Konto, dann der Autostart.
& sc.exe config $ServiceName obj= "NT SERVICE\$ServiceName" | Out-Null
if ($LASTEXITCODE -ne 0) {
  $scCode = $LASTEXITCODE
  # Halbfertigen Dienst nicht mit Autostart zuruecklassen. Einen frisch
  # angelegten entfernen wir ganz; einen vorhandenen lassen wir stehen (er war
  # vor diesem Lauf konfiguriert), nehmen ihm aber den Autostart, damit ein
  # Neustart des Servers keinen falsch berechtigten Dienst hochzieht.
  if ($freshlyInstalled) {
    & $NssmPath remove $ServiceName confirm | Out-Null
  } else {
    & $NssmPath set $ServiceName Start SERVICE_DEMAND_START | Out-Null
  }
  # Abbruch statt Warnung: Der Rueckfall auf LocalSystem ist keine Kleinigkeit,
  # die man im Installationsprotokoll uebersieht. LocalSystem ist das
  # hoechstprivilegierte Konto der Maschine - der HR-Dienst laeuft dann mit
  # Vollzugriff auf das gesamte System statt in seinem eigenen Kaefig. Und weil
  # LocalSystem ueberall schreiben darf, faellt auch ein falsch gesetztes
  # OHRGANIZE_DATA_DIR nicht mehr durch einen Startfehler auf.
  throw ("Virtuelles Dienstkonto 'NT SERVICE\$ServiceName' konnte nicht gesetzt werden " +
    "(sc.exe config, Code $scCode). Abbruch: Der Dienst liefe sonst als LocalSystem " +
    'und damit mit weit mehr Rechten als vorgesehen.')
}

& $NssmPath set $ServiceName Application    $node.Source            | Out-Null
& $NssmPath set $ServiceName AppParameters  "`"$entry`""            | Out-Null
& $NssmPath set $ServiceName AppDirectory   (Join-Path $InstallDir 'apps\backend') | Out-Null
& $NssmPath set $ServiceName DisplayName    'oHRganize Backend'       | Out-Null
& $NssmPath set $ServiceName Description    'oHRganize Backend (HR-Verwaltung, REST-API)' | Out-Null
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

# Geordnetes Beenden. AppStopMethodSkip ist eine Bitmaske der zu
# UEBERSPRINGENDEN Methoden:
#   1 = Console (Strg+C)   2 = WM_CLOSE   4 = Thread-Nachrichten   8 = Terminate
# 6 = 2 + 4 laesst also WM_CLOSE und die Thread-Nachrichten aus - beides zielt
# auf Fensteranwendungen und richtet bei einem Konsolenprozess nichts aus.
# Aktiv bleiben Console (1) als erster Versuch und Terminate (8) als letztes
# Mittel, falls der Prozess die Wartezeit unten nicht nutzt. Genau so ist es
# gewollt: Strg+C stellt Node ein SIGINT zu, index.ts fuehrt den
# WAL-Checkpoint aus, und erst wenn das nicht klappt, wird hart beendet.
& $NssmPath set $ServiceName AppStopMethodSkip 6       | Out-Null
& $NssmPath set $ServiceName AppStopMethodConsole 20000 | Out-Null

& $NssmPath start $ServiceName
Start-Sleep -Seconds 2
Get-Service -Name $ServiceName | Format-List Name, Status, StartType

Write-Host ''
Write-Host 'Pruefen:'
Write-Host '  Invoke-RestMethod http://127.0.0.1:3001/api/health'
Write-Host "  Get-Content $LogDir\backend.log -Tail 40"
