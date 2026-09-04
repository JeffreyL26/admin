<#
.SYNOPSIS
  Setzt die NTFS-Rechte der oHRganize-Verzeichnisse und der Konfigurationsdatei.
  Gegenstueck zu UMask=0077 / StateDirectoryMode=0700 der systemd-Unit.

.DESCRIPTION
  WARUM DAS NOETIG IST: config.ts haertet das Verzeichnis beim Start selbst per
  chmod auf 0700 - auf Windows kennt chmod aber nur das Read-only-Bit, der
  Aufruf verpufft (chmodQuiet faengt ihn bewusst ab). Ohne dieses Skript gilt
  daher, was C:\ProgramData vererbt: "Benutzer" duerfen lesen. Damit kann jedes
  lokale Konto auf dem Server ohrganize.db oeffnen - die komplette Personalakte
  mit Gehaeltern und AU-Bescheinigungen.

  DAS LOG-VERZEICHNIS GEHOERT MIT DAZU: Beim allerersten Dienststart erzeugt das
  Backend das Initialpasswort fuer admin@ohrganize.de und gibt es einmalig auf
  stdout aus. NSSM leitet stdout nach logs\backend.log um - das Passwort steht
  damit auf der Platte. Ohne Haertung erbt auch dieses Verzeichnis von
  C:\ProgramData das Leserecht der Gruppe "Benutzer": Jedes lokale Konto koennte
  sich das Administratorpasswort abholen, solange es noch nicht gewechselt ist.

  DIE KONFIGURATIONSDATEI EBENSO: ohrganize.env darf
  OHRGANIZE_INITIAL_ADMIN_PASSWORD enthalten und verraet mindestens den Ablageort
  der Personalakte.

  /inheritance:r ist der eigentliche Kern: Es entfernt die geerbten Eintraege.
  Ein blosses "Recht ergaenzen" wuerde den Lesezugriff der Gruppe "Benutzer"
  stehen lassen.

  Die Konten stehen als SID da, nicht als Name: Auf einem deutschen Windows
  heisst die Gruppe "Administratoren", auf einem englischen "Administrators".
  Ein Skript mit Klarnamen scheitert je nach Sprachversion des Servers.
  Aus demselben Grund darf -ServiceAccount auch als SID uebergeben werden
  (icacls-Schreibweise "*S-1-5-80-..."); install-service.ps1 tut das, weil der
  Name "NT SERVICE\oHRganize" erst nach der Dienstregistrierung aufloesbar ist.

.NOTES
  Idempotent - nach jedem Restore und nach jedem Update erneut ausfuehrbar.
  Muss als Administrator laufen.
#>
[CmdletBinding()]
param(
  [string]$DataDir    = 'C:\ProgramData\oHRganize\data',
  [string]$BackupDir  = 'C:\ProgramData\oHRganize\backups',
  [string]$LogDir     = 'C:\ProgramData\oHRganize\logs',
  [string]$EnvFile    = 'C:\ProgramData\oHRganize\ohrganize.env',
  [string]$ServiceAccount = 'NT SERVICE\oHRganize'
)

$ErrorActionPreference = 'Stop'

# Well-known SIDs statt Klarnamen (sprachunabhaengig):
#   S-1-5-18     LOCAL SYSTEM   - Windows-Gegenstueck zu root
#   S-1-5-32-544 Administratoren
$SID_SYSTEM = '*S-1-5-18'
$SID_ADMINS = '*S-1-5-32-544'

function Set-OhrganizeAcl {
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

  # Das Dienstkonto ist ueber seinen NAMEN erst aufloesbar, nachdem der Dienst
  # registriert wurde. Beim Aufruf aus install-service.ps1 kann das nicht mehr
  # schiefgehen - von dort kommt die Dienst-SID, und die gilt auch fuer einen
  # noch nicht installierten Dienst. Ein Fehlschlag bleibt hier trotzdem
  # abgefangen, weil dieses Skript auch von Hand aufgerufen wird (nach einem
  # Restore, nach einem Update) und dann die Vorgabe mit dem Klarnamen greift.
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

<#
  Haertet eine einzelne DATEI (ohrganize.env), nicht ein Verzeichnis.

  Zwei Unterschiede zu Set-OhrganizeAcl:
    * Kein (OI)(CI): Vererbungsflags gibt es nur fuer Container. icacls wuerde
      sie auf einer Datei als Fehler zurueckweisen.
    * KEIN Recht fuer das Dienstkonto. Das Backend liest ohrganize.env nie
      selbst: install-service.ps1 wertet die Datei als Administrator aus und
      uebergibt die Paare an "nssm set ... AppEnvironmentExtra". NSSM legt sie
      in der Registry ab, und der Dienst bekommt sie beim Start als Umgebung
      gereicht (siehe Kopfkommentar von install-service.ps1). SYSTEM und
      Administratoren genuegen daher - und je weniger Konten die Datei lesen
      duerfen, desto besser, weil dort OHRGANIZE_INITIAL_ADMIN_PASSWORD stehen
      darf.

  Fehlt die Datei, wird sie NICHT angelegt: Eine leere ohrganize.env waere
  schlimmer als keine - install-service.ps1 bricht bei "keine Variablen
  gefunden" ab, und der Betreiber suchte den Fehler an der falschen Stelle.
#>
function Set-OhrganizeFileAcl {
  param([string]$Path, [string]$Label)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Warning "  $Label - $Path nicht gefunden, uebersprungen (Vorlage: ohrganize.env.example)."
    return
  }

  # Exit-Code pruefen und hart abbrechen: Anders als beim Dienstkonto in
  # Set-OhrganizeAcl (das vor der Dienstinstallation erwartbar noch nicht
  # existiert) gibt es hier keinen zulaessigen Fehlschlag. Bleibt er
  # unbemerkt, meldet das Skript "SYSTEM, Administratoren", waehrend die Datei
  # weiter fuer die Gruppe "Benutzer" lesbar ist - samt einem eventuell darin
  # stehenden OHRGANIZE_INITIAL_ADMIN_PASSWORD.
  & icacls $Path /inheritance:r /grant:r "$($SID_SYSTEM):F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "ACL auf $Path konnte nicht gesetzt werden (icacls, Code $LASTEXITCODE)."
  }
  & icacls $Path /grant:r "$($SID_ADMINS):F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "ACL auf $Path konnte nicht gesetzt werden (icacls, Code $LASTEXITCODE)."
  }
  Write-Host "  $Label - SYSTEM, Administratoren (Dienstkonto braucht keinen Lesezugriff)"
}

Write-Host 'oHRganize - NTFS-Rechte setzen'
Set-OhrganizeAcl -Path $DataDir   -Label 'Datenverzeichnis'
Set-OhrganizeAcl -Path $BackupDir -Label 'Sicherungen'
# Log-Verzeichnis: Das Dienstkonto braucht hier Schreibrecht - NSSM schreibt
# backend.log unter der Identitaet des Dienstes.
Set-OhrganizeAcl -Path $LogDir    -Label 'Protokolle'
Set-OhrganizeFileAcl -Path $EnvFile -Label 'Konfiguration'

Write-Host ''
Write-Host 'Kontrolle (erwartet: KEIN Eintrag fuer "Benutzer"/"Users"):'
foreach ($p in @($DataDir, $BackupDir, $LogDir, $EnvFile)) {
  if (Test-Path -LiteralPath $p) { & icacls $p }
}
