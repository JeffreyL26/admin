# Erstinbetriebnahme

Diese Checkliste führt von „der Dienst läuft" bis „das System darf mit echten
Personaldaten arbeiten". Sie ist zum Abhaken gedacht und in dieser Reihenfolge
abzuarbeiten — jeder Punkt schließt eine Lücke, die vorher offen ist.

**Voraussetzung:** Server, Dienst und Reverse-Proxy stehen nach
[`../deploy/README.md`](../deploy/README.md) (Linux) bzw.
[`../deploy/windows/README.md`](../deploy/windows/README.md)
(Windows Server), und der Gesundheitsruf antwortet:

```bash
# Linux
curl -sS https://portal.firma.de/api/health
```

```powershell
# Windows
Invoke-RestMethod https://portal.firma.de/api/health
```

Erwartete Antwort — vier Felder, `version` ist die installierte Ausgabe,
`min_client_version` die älteste noch bediente Desktop-App:

```json
{"ok":true,"name":"HRMONIC Backend","version":"1.0.1","min_client_version":"1.0.0"}
```

**Zeitbedarf:** rund 60 Minuten, plus die Restore-Probe.

> **Ein Satz vorweg:** In HRMONIC liegen Gehälter, Bankverbindungen,
> Krankmeldungen und AU-Bescheinigungen. Krankheitsdaten sind besonders
> geschützt (Art. 9 DSGVO). Die Punkte 1, 2 und 7 sind deshalb keine
> Empfehlungen, sondern Bedingungen für den Produktivbetrieb.

## Diese Checkliste gilt für beide Plattformen

Fachlich ist nichts plattformabhängig — nur die Befehle sind es. Wo unten ein
Befehlsblock steht, sind beide Fassungen angegeben. Die Kurzübersicht:

| Aufgabe | Linux | Windows Server |
|---|---|---|
| Protokoll lesen | `journalctl -u hrmonic-backend` | `Get-Content 'C:\ProgramData\HRMONIC\logs\backend.log'` |
| Datei anzeigen | `cat <Datei>` | `Get-Content <Datei>` |
| Datei löschen | `rm <Datei>` | `Remove-Item <Datei>` |
| Rechte prüfen | `ls -ld <Verzeichnis>` | `icacls <Verzeichnis>` |
| Sicherung prüfen | `systemctl list-timers hrmonic-backup.timer` | `Get-ScheduledTaskInfo -TaskName 'HRMONIC-Sicherung'` |
| Dienst steuern | `systemctl stop/start hrmonic-backend` | `nssm stop/start HRMONIC` |
| HTTP-Abruf | `curl` | `Invoke-RestMethod` / `Invoke-WebRequest` |
| Datenverzeichnis | `/var/lib/hrmonic` | `C:\ProgramData\HRMONIC\data` |

> **Windows PowerShell 5.1 und Fehlerstatus:** `Invoke-RestMethod` und
> `Invoke-WebRequest` werfen bei HTTP 4xx/5xx eine **Ausnahme**, statt den
> Status zurückzugeben; das Gegenmittel `-SkipHttpErrorCheck` gibt es erst ab
> PowerShell 7. Prüfungen, die einen Fehlerstatus **erwarten** (401, 426),
> stehen unten deshalb in `try`/`catch` und lesen ihn aus
> `$_.Exception.Response.StatusCode.value__`.

---

## 1. Erstes Anmelden mit dem generierten Initialpasswort

Beim allerersten Start hat HRMONIC das Konto `admin@hrmonic.de` angelegt und
dafür ein **Zufallspasswort** erzeugt. Es steht an zwei Stellen:

```bash
# Linux — im Journal des ersten Starts
journalctl -u hrmonic-backend | grep -A 5 'Erstinbetriebnahme'

# und in einer Datei mit Rechten 0600 neben secret.key
cat /var/lib/hrmonic/initial-admin-password.txt
```

```powershell
# Windows — im Dienstprotokoll des ersten Starts (NSSM schreibt stdout dorthin)
Select-String -Path 'C:\ProgramData\HRMONIC\logs\backend*.log' -Pattern 'Erstinbetriebnahme' -Context 0,5

# und in der Datei neben secret.key
Get-Content 'C:\ProgramData\HRMONIC\data\initial-admin-password.txt'
```

Es gibt **kein** dokumentiertes Standardpasswort mehr. Falls in einer älteren
Anleitung noch `hrmonic2026` steht: Das Passwort existiert im Produktivstand
nicht; die Zeile ist veraltet.

Die HR-Administration meldet sich über die **Desktop-App** an, nicht über das
Portal (das Portal ist ausschließlich der Self-Service für Mitarbeitende).
Die App muss dafür auf den Server zeigen — entweder über die Umgebungsvariable
`HRMONIC_API_BASE=https://portal.firma.de` oder über
`%APPDATA%\HRMONIC\config.json` mit `{ "apiBaseUrl": "https://portal.firma.de" }`
(Einzelheiten in [`web-portal.md`](web-portal.md)).

Ohne installierte App lässt sich der Zugang auch direkt prüfen:

```bash
# Linux
curl -sS -X POST https://portal.firma.de/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@hrmonic.de","password":"<Initialpasswort>"}'
```

```powershell
# Windows
$body = @{ email = 'admin@hrmonic.de'; password = '<Initialpasswort>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'https://portal.firma.de/api/auth/login' `
  -ContentType 'application/json' -Body $body
```

- [ ] Anmeldung mit dem generierten Passwort erfolgreich.

## 2. Passwortwechsel — erzwungen

Das Konto ist bis zum Wechsel gesperrt: Jede andere Anfrage wird mit
`403 PASSWORD_CHANGE_REQUIRED` und dem Hinweis „Bitte vergeben Sie zuerst ein
eigenes Passwort." abgewiesen. Die App führt direkt in die Maske; das
Initialpasswort ist also kein Dauerzugang, auch wenn es jemand mitgelesen hat.

Regeln: mindestens 12 Zeichen, höchstens 72 Byte (Umlaute zählen doppelt),
nicht das alte Passwort, und keine offensichtlichen Varianten von Firmenname,
„hrmonic" oder dem eigenen E-Mail-Namen.

Nach dem Wechsel:

```bash
# Linux
rm /var/lib/hrmonic/initial-admin-password.txt
```

```powershell
# Windows
Remove-Item 'C:\ProgramData\HRMONIC\data\initial-admin-password.txt'
```

**Windows: das Erstprotokoll muss ebenfalls weg.** Das Initialpasswort wird beim
allerersten Start bewusst mit `console.log` ausgegeben (der Logger existiert zu
diesem Zeitpunkt noch nicht). Unter Linux landet es damit im Journal, das nur
root und der Gruppe `systemd-journal` offensteht; unter Windows schreibt NSSM
denselben Text in eine Protokolldatei, die es **geöffnet hält**. Sie lässt sich
deshalb erst nach dem Anhalten des Dienstes löschen:

```powershell
nssm stop HRMONIC
Remove-Item 'C:\ProgramData\HRMONIC\logs\backend*.log'
nssm start HRMONIC
```

(`backend*.log` statt `backend.log`: NSSM rotiert die Datei und legt dabei
Kopien mit Zeitstempel im Namen an — die Zeile mit dem Passwort kann in einer
davon stehen.)

- [ ] Eigenes Passwort vergeben (Passwortmanager, nicht Notizzettel).
- [ ] `initial-admin-password.txt` gelöscht.
- [ ] **Windows:** Dienst angehalten, `backend*.log` gelöscht, Dienst wieder
      gestartet.
- [ ] Falls `HRMONIC_INITIAL_ADMIN_PASSWORD` für die Provisionierung gesetzt
      war: Zeile aus `/etc/hrmonic/hrmonic.env` bzw.
      `C:\ProgramData\HRMONIC\hrmonic.env` entfernt und Dienst neu gestartet
      (sonst steht das Passwort dauerhaft im Klartext auf dem Server).
      **Unter Windows reicht ein Dienstneustart dafür nicht** — NSSM hält die
      Werte in der Registry; erst `install-service.ps1` erneut ausführen.

## 3. Eigene Konten anlegen — nicht über `npm run seed`

**`npm run seed` ist ausschließlich für die Entwicklung.** Es legt Konten mit
den überall dokumentierten Passwörtern `hrmonic2026` und `portal2026` an. Auf
einem Produktivsystem darf es **nie** laufen — auch nicht „einmal kurz zum
Ausprobieren".

Das Skript setzt das inzwischen selbst durch: Es bricht ab, sobald
`HRMONIC_DATA_DIR` gesetzt ist und nicht auf das Entwicklungsverzeichnis zeigt —
also auf jedem Server, der nach dieser Anleitung eingerichtet wurde. Die frühere
Sperre („es existieren schon Mitarbeitende") half genau dort nicht, wo es darauf
ankam: auf einem frisch installierten, noch leeren System. Der einzige Ausweg
ist die Variable `HRMONIC_ALLOW_SEED=1`; sie gehört auf ein Kundensystem nicht.
Nicht betroffen ist `npm run seed:desktop`, das die Freigabe für das
Datenverzeichnis der installierten App selbst setzt.

Konten entstehen stattdessen in der Desktop-App unter
**Verwaltung → Benutzer & Rechte → Konto anlegen** (technisch:
`POST /api/admin/users`). Dabei gilt:

- Der Server erzeugt das Erstpasswort und zeigt es **genau einmal** an —
  sofort an die betroffene Person weitergeben (Telefon, persönlich; nicht per
  E-Mail zusammen mit der Adresse).
- Jedes neue Konto muss das Passwort beim ersten Anmelden ändern.
- **Rolle `admin`** = HR-Administration (Desktop-App).
  **Rolle `mitarbeiter`** = Portal-Konto; es braucht zwingend ein verknüpftes
  Personalprofil, sonst sieht die Person nichts.
- Geht ein Passwort verloren: **Verwaltung → Benutzer & Rechte → Passwort
  zurücksetzen**. Das entwertet zugleich alle offenen Sitzungen des Kontos.

- [ ] Für jede Person der HR-Administration ein **persönliches** Konto —
      keine gemeinsam genutzten Zugänge (das Audit-Log wird sonst wertlos).
- [ ] `npm run seed` wurde auf diesem System nie ausgeführt, und
      `HRMONIC_ALLOW_SEED` ist nirgends gesetzt (weder in `hrmonic.env` noch als
      Umgebungsvariable des Servers).

## 4. Admin-Rollen zuweisen — sonst hat jeder Vollzugriff

**Ein Konto ohne Admin-Rolle hat Vollzugriff auf alle Bereiche**, also auch auf
Gehälter, Bankverbindungen und Krankmeldungen. Das ist kein Versehen, sondern
der Ausgangszustand für das allererste Konto — aber es ist kein Zustand für den
Betrieb.

Rollen pflegen und Rollen zuweisen liegt beides unter
**Verwaltung → Benutzer & Rechte**: Im Tab
**„Rollen & Rechte"** stehen die Admin-Rollen mit ihren Bereichsrechten
(`kein` / `lesen` / `bearbeiten`), ausgeliefert unter anderem
„HR-Sachbearbeitung" ohne Vergütungszugriff; im Tab **„Konten"** wird jedem
Konto eine davon zugewiesen.

> **Nicht mit „Verwaltung → Rollen" verwechseln.** Der gleichnamige Menüpunkt
> daneben führt zu den **Fachrollen**; die steuern ausschließlich, wer welche
> Abwesenheitsart beantragen darf, und vergeben keinerlei Adminrechte.

- [ ] Jedes Konto hat eine Admin-Rolle — **außer** den ein bis zwei bewusst
      gewählten Konten mit Vollzugriff.
- [ ] In der Kontenliste steht bei niemandem versehentlich „Vollzugriff".
- [ ] Prüfen, wer wirklich Gehälter sehen muss; im Zweifel „HR-Sachbearbeitung".

## 5. Standard-Admin abbauen

Sobald mindestens ein **persönliches** Konto mit Vollzugriff existiert und
damit erfolgreich angemeldet wurde, wird `admin@hrmonic.de` nicht mehr
gebraucht. Es unter Verwaltung → Benutzer & Rechte löschen. HRMONIC legt es
nur dann neu an, wenn überhaupt **kein** Konto mehr existiert — es kommt also
nicht von selbst zurück.

- [ ] Persönliches Vollzugriffs-Konto vorhanden und getestet.
- [ ] `admin@hrmonic.de` gelöscht (oder bewusst behalten, mit eigenem starkem
      Passwort und dokumentiertem Grund).

## 6. Firmeneinstellungen setzen

Unter **Einstellungen** stehen ab Werk Demowerte, die im Betrieb falsche
Ergebnisse erzeugen:

| Einstellung | Auslieferung | Wirkung, wenn sie stehen bleibt |
|---|---|---|
| Firmenname | `HRMONIC GmbH` | steht auf Bescheinigungen und in Vorlagen |
| Standard-Bundesland | `BY` | falsche Feiertage in Urlaubsberechnung und Kalender |
| Verfallsdatum Resturlaub | `31.03.` | Resturlaub verfällt zum falschen Termin |
| DATEV-Berater-/Mandantennummer | `1000001` / `10001` | Lohnexport landet beim falschen Mandanten |
| Mindestteilnehmerzahl Umfragen | `5` | Schwelle, ab der Ergebnisse sichtbar werden |

- [ ] Alle Werte auf die eigenen gesetzt, DATEV-Nummern mit der Steuerkanzlei
      abgeglichen.

## 7. Abwesenheitsarten prüfen (Gesundheitsdaten)

Der Firmenkalender im Portal ist für **alle** Mitarbeitenden sichtbar. Jede
Abwesenheitsart trägt dafür eine Portal-Sichtbarkeit:

- `name` — der Name der abwesenden Person erscheint,
- `neutral` — es erscheint nur „abwesend", ohne Grund und ohne Namen.

Für gesundheitsbezogene Arten muss `neutral` stehen. Andernfalls steht die
Krankmeldung namentlich im Kalender der gesamten Belegschaft — eine
Offenlegung von Gesundheitsdaten (Art. 9 DSGVO), die niemand angeordnet hat.

Zu prüfen unter **Abwesenheit → Abwesenheitsarten**:

- [ ] `Krankheit` → neutral
- [ ] `Kind krank` → neutral
- [ ] `Mutterschutz` → neutral
- [ ] Jede **selbst angelegte** Art mit Gesundheitsbezug (z. B.
      „Reha", „Wiedereingliederung", „Quarantäne") → neutral

Das Update setzt die drei ausgelieferten Arten automatisch auf `neutral`; die
Sichtprüfung bleibt trotzdem in der Liste, weil eine später angelegte Art
wieder auf `name` stehen kann.

## 8. Portal-Konten für die Mitarbeitenden

Portal-Konten (Rolle `mitarbeiter`) entstehen denselben Weg wie in Punkt 3,
mit verknüpftem Personalprofil. Bewährtes Vorgehen:

1. Erst die Personalprofile in der Desktop-App anlegen. **Einen Import gibt es
   nicht** — HRMONIC kennt nur den CSV-*Export* der Mitarbeitendenliste; die
   Profile werden von Hand erfasst. Das ist bei der Zeitplanung einzurechnen.
2. Dann die Portal-Konten — zunächst nur für eine kleine Testgruppe.
3. Nach der Rückmeldung der Testgruppe der Rest.

Beim Verteilen der Erstpasswörter: Adresse und Passwort auf getrennten Wegen.

- [ ] Testgruppe kann sich anmelden, sieht **nur** die eigenen Daten.
- [ ] Eine Testperson prüft den Firmenkalender: Bei Krankmeldungen steht dort
      kein Name (Gegenprobe zu Punkt 7).

## 9. Datensicherung scharf schalten

Nach [`../deploy/README.md`](../deploy/README.md), Abschnitt 5 (Linux) bzw.
[`../deploy/windows/README.md`](../deploy/windows/README.md), Abschnitt 5
(Windows):

```bash
# Linux — Zeitplan aktiv?
systemctl list-timers hrmonic-backup.timer
```

```powershell
# Windows — Zeitplan aktiv? LastTaskResult 0 = durchgelaufen
Get-ScheduledTaskInfo -TaskName 'HRMONIC-Sicherung'
Get-ChildItem 'C:\ProgramData\HRMONIC\backups' | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

- [ ] Zeitplan aktiv (Timer bzw. geplante Aufgabe) und mit einem
      erfolgreichen Lauf hinterlegt.
- [ ] Ein Lauf erfolgreich, Verzeichnis enthält `hrmonic.db`, `storage/`,
      `secret.key`, `MANIFEST.txt`.
- [ ] Auslagerung auf ein zweites System eingerichtet (eine Sicherung neben den
      Daten schützt vor keinem der Fälle, für die man sichert).
- [ ] **Restore-Probe** einmal durchgeführt und protokolliert (Datum, wer,
      Ergebnis). Wiedervorlage in sechs Monaten.

## 10. Abnahme

**Linux:**

```bash
# Backend von außen NICHT erreichbar (erwartet: Verbindungsfehler/Timeout)
curl -sS --max-time 5 http://<server-ip>:3001/api/health

# HTTPS, Kopfzeilen, Weiterleitung
curl -sSI http://portal.firma.de | head -1          # 301 auf https
curl -sSI https://portal.firma.de | grep -iE 'strict-transport|content-security|x-content-type|referrer'

# Ohne Anmeldung kommt nichts heraus (erwartet: 401)
curl -sS -o /dev/null -w '%{http_code}\n' https://portal.firma.de/api/employees

# Falsches Passwort wird protokolliert (erwartet: eine Warnzeile)
curl -sS -X POST https://portal.firma.de/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"admin@hrmonic.de","password":"falsch"}'
journalctl -u hrmonic-backend -n 20 --no-pager | grep -i login

# Rechte im Datenverzeichnis (erwartet: drwx------)
ls -ld /var/lib/hrmonic /var/lib/hrmonic/storage
```

**Windows Server:** Dieselben Prüfungen. Alles, was einen **Fehlerstatus**
erwartet, steht in `try`/`catch` — Windows PowerShell 5.1 wirft bei 4xx/5xx eine
Ausnahme, statt den Status zurückzugeben, und kennt `-SkipHttpErrorCheck` noch
nicht (das kam erst mit PowerShell 7).

```powershell
# Backend von außen NICHT erreichbar (erwartet: Verbindungsfehler/Timeout;
# StatusCode bleibt leer, weil gar keine HTTP-Antwort zustande kommt)
try {
  Invoke-WebRequest 'http://<server-ip>:3001/api/health' -TimeoutSec 5 -UseBasicParsing | Out-Null
  'FEHLER: Backend ist von aussen erreichbar'
} catch {
  "nicht erreichbar (gut): $($_.Exception.Message)"
}

# Weiterleitung auf HTTPS (erwartet: 301)
try {
  Invoke-WebRequest 'http://portal.firma.de' -MaximumRedirection 0 -UseBasicParsing | Out-Null
  'unerwartet: keine Weiterleitung'
} catch {
  $_.Exception.Response.StatusCode.value__
}

# Sicherheitskopfzeilen (erwartet: 200, danach die vier Kopfzeilen)
$r = Invoke-WebRequest 'https://portal.firma.de' -UseBasicParsing
$r.Headers.GetEnumerator() |
  Where-Object { $_.Key -match 'Strict-Transport|Content-Security|X-Content-Type|Referrer' }

# Ohne Anmeldung kommt nichts heraus (erwartet: 401)
try {
  Invoke-WebRequest 'https://portal.firma.de/api/employees' -UseBasicParsing | Out-Null
  'FEHLER: Antwort ohne Anmeldung'
} catch {
  $_.Exception.Response.StatusCode.value__
}

# Zu alte Desktop-App wird abgewiesen (erwartet: 426)
try {
  Invoke-WebRequest 'https://portal.firma.de/api/employees' -UseBasicParsing `
    -Headers @{ 'x-hrmonic-client-version' = '0.0.1' } | Out-Null
  'FEHLER: alte Client-Version nicht abgewiesen'
} catch {
  $_.Exception.Response.StatusCode.value__
}

# Falsches Passwort wird protokolliert (erwartet: 401, danach eine Warnzeile)
$body = @{ email = 'admin@hrmonic.de'; password = 'falsch' } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri 'https://portal.firma.de/api/auth/login' `
    -ContentType 'application/json' -Body $body | Out-Null
} catch {
  $_.Exception.Response.StatusCode.value__
}
Select-String -Path 'C:\ProgramData\HRMONIC\logs\backend*.log' -Pattern 'Anmeldung fehlgeschlagen' |
  Select-Object -Last 3

# Rechte im Datenverzeichnis (erwartet: NUR SYSTEM, Administratoren,
# NT SERVICE\HRMONIC — kein "Benutzer"/"Users")
icacls 'C:\ProgramData\HRMONIC\data'
icacls 'C:\ProgramData\HRMONIC\data\storage'
```

> Die Weiterleitungsprüfung ist die einzige, die je nach PowerShell-Ausgabe
> unterschiedlich aussehen kann: Meldet der `catch`-Zweig statt `301` einen
> Text über zu viele Weiterleitungen, liegt keine `Response` bei — dann ist die
> Weiterleitung im Browser (Adresszeile springt auf `https://`) oder mit
> `curl -sSI http://portal.firma.de` von einem beliebigen anderen Rechner zu
> prüfen.

- [ ] Punkte 1 bis 9 abgehakt.
- [ ] Ein Arbeitsplatz der HR-Administration arbeitet über die Desktop-App
      gegen den Server (nicht mehr gegen die lokale Datenbank).
- [ ] Ein Portal-Konto hat einen Antrag gestellt und die HR hat ihn gesehen.
- [ ] Ein Dokument wurde hochgeladen, heruntergeladen und im Backup
      wiedergefunden.
- [ ] Zuständigkeit hinterlegt: Wer prüft die Sicherungen, wer spielt Updates
      ein, wer ist Ansprechpartner bei Störungen?

## Was Sie danach im Blick behalten sollten

| Rhythmus | Aufgabe (Linux) | Aufgabe (Windows) |
|---|---|---|
| täglich (automatisch) | Sicherung; bei Fehlschlag meldet sich systemd — `systemctl status hrmonic-backup` | Sicherung; Ergebnis über `Get-ScheduledTaskInfo -TaskName 'HRMONIC-Sicherung'` (`LastTaskResult` = 0) |
| wöchentlich | Journal auf gehäufte Anmeldefehler durchsehen | `Select-String -Path 'C:\ProgramData\HRMONIC\logs\backend*.log' -Pattern 'Anmeldung fehlgeschlagen'` |
| monatlich | Kontenliste durchgehen: ausgeschiedene Personen, Rollen noch passend? | dito |
| halbjährlich | Restore-Probe | Restore-Probe (`deploy/windows/README.md`) |
| bei jedem Update | Sicherung vorher, Journal nachher (`deploy/README.md`, Abschnitt 6) | Sicherung vorher, `backend.log` nachher (`deploy/windows/README.md`, Abschnitt 6) |
| nach jeder Rechteänderung am Server | `ls -ld /var/lib/hrmonic` | `icacls 'C:\ProgramData\HRMONIC\data'` — anders als unter Linux zieht der Dienststart die Rechte **nicht** von selbst zurecht |
