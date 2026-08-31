<#
.SYNOPSIS
  Richtet die taegliche HRMONIC-Sicherung als geplante Aufgabe ein.
  Gegenstueck zu hrmonic-backup.service + hrmonic-backup.timer.

.DESCRIPTION
  Das Sicherungsskript (dist/backup.cjs) ist reines Node und laeuft auf Windows
  unveraendert. Es benutzt die Online-Backup-Schnittstelle von SQLite und
  braucht KEINE Auszeit des Dienstes.

  Warum die Aufgabe als SYSTEM laeuft und nicht als Dienstkonto:
  Ein virtuelles Dienstkonto (NT SERVICE\HRMONIC) laesst sich in der
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
  [string]$TaskName   = 'HRMONIC-Sicherung',
  [string]$InstallDir = 'C:\Program Files\HRMONIC',
  [string]$BackupDir  = 'C:\ProgramData\HRMONIC\backups',
  [string]$DataDir    = 'C:\ProgramData\HRMONIC\data',
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

# HRMONIC_DATA_DIR muss die Aufgabe selbst mitbringen: Sie erbt die Umgebung
# des Dienstes nicht. Zeigt sie auf ein anderes Verzeichnis als der Dienst,
# sichert sie stillschweigend eine leere Datenbank.
$arguments = "`"$script`" --out `"$BackupDir`" --keep $Keep"

$action = New-ScheduledTaskAction `
  -Execute $node.Source `
  -Argument $arguments `
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
  -Description 'Taegliche HRMONIC-Datensicherung (Datenbank, Dateien, Secret)' `
  -Action      $action `
  -Trigger     $trigger `
  -Principal   $principal `
  -Settings    $settings | Out-Null

# Die Aufgabe braucht HRMONIC_DATA_DIR. Geplante Aufgaben kennen keine eigene
# Umgebung, deshalb als Maschinenvariable setzen - der Dienst liest denselben
# Wert aus seiner env-Datei, beide muessen uebereinstimmen.
[Environment]::SetEnvironmentVariable('HRMONIC_DATA_DIR', $DataDir, 'Machine')

Write-Host "Aufgabe '$TaskName' eingerichtet: taeglich $At (+ bis zu 5 min Streuung)."
Write-Host ''
Write-Host 'Sofort einmal ausfuehren und nachsehen:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ChildItem '$BackupDir' | Sort-Object LastWriteTime -Descending | Select-Object -First 3"
Write-Host "  Get-Content (Join-Path (Get-ChildItem '$BackupDir' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName 'MANIFEST.txt')"
