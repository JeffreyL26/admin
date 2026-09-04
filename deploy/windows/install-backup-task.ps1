<#
.SYNOPSIS
  Richtet die taegliche oHRganize-Sicherung als geplante Aufgabe ein.
  Gegenstueck zu ohrganize-backup.service + ohrganize-backup.timer.

.DESCRIPTION
  Das Sicherungsskript (dist/backup.cjs) ist reines Node und laeuft auf Windows
  unveraendert. Es benutzt die Online-Backup-Schnittstelle von SQLite und
  braucht KEINE Auszeit des Dienstes.

  Warum die Aufgabe als SYSTEM laeuft und nicht als Dienstkonto:
  Ein virtuelles Dienstkonto (NT SERVICE\oHRganize) laesst sich in der
  Aufgabenplanung nicht zuverlaessig als Prinzipal hinterlegen. SYSTEM ist das
  Windows-Gegenstueck zu root und hat durch harden-data-dir.ps1 ohnehin
  Vollzugriff auf Daten- und Sicherungsverzeichnis. Das ist mehr Recht als
  unter Linux (dort laeuft der Lauf als Dienstbenutzer) - der Unterschied ist
  bewusst und dokumentiert, nicht uebersehen.

  -keep 14 haelt vierzehn Laeufe vor. DAS IST KEINE AUSLAGERUNG: Eine Sicherung,
  die nur auf demselben Server liegt, ueberlebt weder einen Plattendefekt noch
  eine Verschluesselung durch Ransomware. Wie sie heruntergeholt wird, steht in
  deploy\windows\README.md, Abschnitt 5.

.NOTES
  Als Administrator ausfuehren. Idempotent: Eine vorhandene Aufgabe wird
  ersetzt.
#>
[CmdletBinding()]
param(
  [string]$TaskName   = 'oHRganize-Sicherung',
  [string]$InstallDir = 'C:\Program Files\oHRganize',
  [string]$BackupDir  = 'C:\ProgramData\oHRganize\backups',
  [string]$DataDir    = 'C:\ProgramData\oHRganize\data',
  [int]   $Keep       = 14,
  [string]$At         = '02:30'
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Dieses Skript muss als Administrator laufen.'
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node.exe nicht im PATH. Node.js >= 20 installieren.' }

$script = Join-Path $InstallDir 'apps\backend\dist\backup.cjs'
if (-not (Test-Path -LiteralPath $script)) {
  throw "Sicherungsskript fehlt: $script - zuerst 'npm run build -w apps/backend' ausfuehren."
}

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

# OHRGANIZE_DATA_DIR muss die Aufgabe selbst mitbringen: Sie erbt die Umgebung
# des Dienstes nicht. Zeigt sie auf ein anderes Verzeichnis als der Dienst,
# bricht der Lauf laut ab - backup.ts prueft config.dbPath und beendet sich mit
# Exit 1 und der Meldung "Keine Datenbank unter ... gefunden". Der Fehler faellt
# also auf (Letztes Ausfuehrungsergebnis in der Aufgabenplanung), er sichert
# nicht heimlich ins Leere. Trotzdem muessen beide Werte uebereinstimmen, sonst
# gibt es schlicht keine Sicherung.
#
# WARUM UEBER cmd.exe UND NICHT UEBER EINE MASCHINENVARIABLE: Frueher setzte
# dieses Skript OHRGANIZE_DATA_DIR maschinenweit. Damit zeigte JEDER Node-Prozess
# auf dem Server auf die Produktivdatenbank - ein versehentlich gestarteter
# zweiter cli.cjs oder ein Seed-Lauf haette die echte Personalakte getroffen.
# Ausserdem uebernimmt der Aufgabenplanungsdienst eine frisch gesetzte
# Maschinenvariable unter Umstaenden erst nach einem Neustart, der erste
# naechtliche Lauf waere also womoeglich ins Leere gegangen.
# Die Aufgabenplanung kennt kein eigenes Umgebungsfeld, deshalb setzt cmd.exe
# die Variable unmittelbar vor dem Aufruf - sie lebt nur fuer diesen einen
# Prozessbaum.
#
# ZUM QUOTING: "/s" ist hier wichtig. Ohne den Schalter entscheidet cmd nach
# einer verwickelten Regel, ob es die aeusseren Anfuehrungszeichen abstreift;
# mit "/s" tut es das immer und nimmt den Rest woertlich. Die inneren
# Anfuehrungszeichen brauchen wir, weil Node und die Pfade unter
# "C:\Program Files\..." Leerzeichen enthalten. set "VAR=Wert" ist die
# empfohlene Schreibweise: Die Anfuehrungszeichen landen NICHT im Wert.
# Der Exit-Code bleibt erhalten - cmd /c gibt den des letzten Befehls zurueck.
$backupCommand =
  "set `"OHRGANIZE_DATA_DIR=$DataDir`" && " +
  "`"$($node.Source)`" `"$script`" --out `"$BackupDir`" --keep $Keep"

$action = New-ScheduledTaskAction `
  -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') `
  -Argument "/s /c `"$backupCommand`"" `
  -WorkingDirectory (Join-Path $InstallDir 'apps\backend')

# RandomDelay entspricht RandomizedDelaySec der systemd-Timer-Einheit.
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$trigger.RandomDelay = 'PT5M'

$principal = New-ScheduledTaskPrincipal `
  -UserId 'NT AUTHORITY\SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

# StartWhenAvailable entspricht Persistent=true: War der Server zur geplanten
# Zeit aus, wird der Lauf nachgeholt.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Vorhandene Aufgabe '$TaskName' entfernt."
}

Register-ScheduledTask `
  -TaskName    $TaskName `
  -Description 'Taegliche oHRganize-Datensicherung (Datenbank, Dateien, Secret)' `
  -Action      $action `
  -Trigger     $trigger `
  -Principal   $principal `
  -Settings    $settings | Out-Null

Write-Host "Aufgabe '$TaskName' eingerichtet: taeglich $At (+ bis zu 5 min Streuung)."
Write-Host "Datenverzeichnis der Aufgabe: $DataDir (muss OHRGANIZE_DATA_DIR aus ohrganize.env entsprechen)."

# Hinweis fuer Server, die noch von einer aelteren Fassung dieses Skripts
# stammen: Die damals gesetzte Maschinenvariable wird hier bewusst NICHT
# geloescht - sie koennte inzwischen von Hand gesetzt worden sein, und ein
# Skript, das ungefragt Maschinenvariablen entfernt, ist unangenehmer als der
# Hinweis. Der Betreiber entscheidet.
$staleMachineVar = [Environment]::GetEnvironmentVariable('OHRGANIZE_DATA_DIR', 'Machine')
if ($staleMachineVar) {
  Write-Warning ("Maschinenvariable OHRGANIZE_DATA_DIR ist gesetzt ($staleMachineVar). " +
    'Die Aufgabe braucht sie nicht mehr. Solange sie steht, zeigt JEDER Node-Prozess ' +
    'auf dem Server auf die Produktivdatenbank - Empfehlung: entfernen mit ' +
    "[Environment]::SetEnvironmentVariable('OHRGANIZE_DATA_DIR', `$null, 'Machine')")
}

Write-Host ''
Write-Host 'Sofort einmal ausfuehren und nachsehen:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ChildItem '$BackupDir' | Sort-Object LastWriteTime -Descending | Select-Object -First 3"
Write-Host "  Get-Content (Join-Path (Get-ChildItem '$BackupDir' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName 'MANIFEST.txt')"
