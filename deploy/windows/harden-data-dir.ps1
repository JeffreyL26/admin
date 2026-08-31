<#
.SYNOPSIS
  Setzt die NTFS-Rechte des HRMONIC-Datenverzeichnisses. Gegenstueck zu
  UMask=0077 / StateDirectoryMode=0700 der systemd-Unit.

.DESCRIPTION
  WARUM DAS NOETIG IST: config.ts haertet das Verzeichnis beim Start selbst per
  chmod auf 0700 - auf Windows kennt chmod aber nur das Read-only-Bit, der
  Aufruf verpufft (chmodQuiet faengt ihn bewusst ab). Ohne dieses Skript gilt
  daher, was C:\ProgramData vererbt: "Benutzer" duerfen lesen. Damit kann jedes
  lokale Konto auf dem Server hrmonic.db oeffnen - die komplette Personalakte
  mit Gehaeltern und AU-Bescheinigungen.

  /inheritance:r ist der eigentliche Kern: Es entfernt die geerbten Eintraege.
  Ein blosses "Recht ergaenzen" wuerde den Lesezugriff der Gruppe "Benutzer"
  stehen lassen.

  Die Konten stehen als SID da, nicht als Name: Auf einem deutschen Windows
  heisst die Gruppe "Administratoren", auf einem englischen "Administrators".
  Ein Skript mit Klarnamen scheitert je nach Sprachversion des Servers.

.NOTES
  Idempotent - nach jedem Restore und nach jedem Update erneut ausfuehrbar.
  Muss als Administrator laufen.
#>
[CmdletBinding()]
param(
  [string]$DataDir    = 'C:\ProgramData\HRMONIC\data',
  [string]$BackupDir  = 'C:\ProgramData\HRMONIC\backups',
  [string]$ServiceAccount = 'NT SERVICE\HRMONIC'
)

$ErrorActionPreference = 'Stop'

# Well-known SIDs statt Klarnamen (sprachunabhaengig):
#   S-1-5-18     LOCAL SYSTEM   - Windows-Gegenstueck zu root
#   S-1-5-32-544 Administratoren
$SID_SYSTEM = '*S-1-5-18'
$SID_ADMINS = '*S-1-5-32-544'

function Set-HrmonicAcl {
  param([string]$Path, [string]$Label)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Write-Host "  angelegt: $Path"
  }

  # /inheritance:r  Vererbung kappen (entfernt u. a. "Benutzer: Lesen")
  # /grant:r        vorhandenes Recht des Kontos ersetzen statt ergaenzen
  # (OI)(CI)F       Vollzugriff, vererbt auf Dateien und Unterordner
  & icacls $Path /inheritance:r /grant:r "$($SID_SYSTEM):(OI)(CI)F" | Out-Null
  & icacls $Path /grant:r "$($SID_ADMINS):(OI)(CI)F" | Out-Null

  # Das Dienstkonto existiert erst, nachdem der Dienst registriert wurde.
  # Vor der Dienstinstallation ist das kein Fehler - dann greift der Lauf am
  # Ende von install-service.ps1.
  # Exit-Code statt Ausnahme pruefen: icacls ist ein externes Programm und
  # wirft nichts - $LASTEXITCODE ist die eindeutige Auskunft.
  #
  # ErrorActionPreference wird dafuer kurz zurueckgenommen: Windows PowerShell
  # 5.1 verpackt JEDE stderr-Zeile eines nativen Programms in einen
  # ErrorRecord, sobald man sie umleitet. Unter 'Stop' bricht das Skript dann
  # an dieser Zeile ab - obwohl ein noch fehlendes Dienstkonto der erwartete
  # Normalfall ist, wenn die Haertung vor der Dienstinstallation laeuft.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $null = & icacls $Path /grant:r "$($ServiceAccount):(OI)(CI)F" 2>&1
  $grantCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap

  if ($grantCode -eq 0) {
    Write-Host "  $Label - SYSTEM, Administratoren, $ServiceAccount"
  } else {
    Write-Warning "  $Label - $ServiceAccount noch unbekannt (Dienst noch nicht installiert?)"
  }
}

Write-Host 'HRMONIC - NTFS-Rechte setzen'
Set-HrmonicAcl -Path $DataDir   -Label 'Datenverzeichnis'
Set-HrmonicAcl -Path $BackupDir -Label 'Sicherungen'

Write-Host ''
Write-Host 'Kontrolle (erwartet: KEIN Eintrag fuer "Benutzer"/"Users"):'
& icacls $DataDir
