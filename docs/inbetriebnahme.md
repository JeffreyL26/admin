# Erstinbetriebnahme

Diese Checkliste führt von „der Dienst läuft" bis „das System darf mit echten
Personaldaten arbeiten". Sie ist zum Abhaken gedacht und in dieser Reihenfolge
abzuarbeiten — jeder Punkt schließt eine Lücke, die vorher offen ist.

**Voraussetzung:** Server, Dienst und Reverse-Proxy stehen nach
[`../deploy/README.md`](../deploy/README.md), und
`curl -sS https://portal.firma.de/api/health` antwortet mit
`{"ok":true,"name":"HRMONIC Backend"}`.

**Zeitbedarf:** rund 60 Minuten, plus die Restore-Probe.

> **Ein Satz vorweg:** In HRMONIC liegen Gehälter, Bankverbindungen,
> Krankmeldungen und AU-Bescheinigungen. Krankheitsdaten sind besonders
> geschützt (Art. 9 DSGVO). Die Punkte 1, 2 und 7 sind deshalb keine
> Empfehlungen, sondern Bedingungen für den Produktivbetrieb.

---

## 1. Erstes Anmelden mit dem generierten Initialpasswort

Beim allerersten Start hat HRMONIC das Konto `admin@hrmonic.de` angelegt und
dafür ein **Zufallspasswort** erzeugt. Es steht an zwei Stellen:

```bash
# im Journal des ersten Starts
journalctl -u hrmonic-backend | grep -A 5 'Erstinbetriebnahme'

# und in einer Datei mit Rechten 0600 neben secret.key
cat /var/lib/hrmonic/initial-admin-password.txt
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
curl -sS -X POST https://portal.firma.de/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@hrmonic.de","password":"<Initialpasswort>"}'
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
rm /var/lib/hrmonic/initial-admin-password.txt
```

- [ ] Eigenes Passwort vergeben (Passwortmanager, nicht Notizzettel).
- [ ] `initial-admin-password.txt` gelöscht.
- [ ] Falls `HRMONIC_INITIAL_ADMIN_PASSWORD` für die Provisionierung gesetzt
      war: Zeile aus `/etc/hrmonic/hrmonic.env` entfernt und Dienst neu
      gestartet (sonst steht das Passwort dauerhaft im Klartext auf dem Server).

## 3. Eigene Konten anlegen — nicht über `npm run seed`

**`npm run seed` ist ausschließlich für die Entwicklung.** Es legt Konten mit
den überall dokumentierten Passwörtern `hrmonic2026` und `portal2026` an. Auf
einem Produktivsystem darf es **nie** laufen — auch nicht „einmal kurz zum
Ausprobieren".

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
- [ ] `npm run seed` wurde auf diesem System nie ausgeführt.

## 4. Admin-Rollen zuweisen — sonst hat jeder Vollzugriff

**Ein Konto ohne Admin-Rolle hat Vollzugriff auf alle Bereiche**, also auch auf
Gehälter, Bankverbindungen und Krankmeldungen. Das ist kein Versehen, sondern
der Ausgangszustand für das allererste Konto — aber es ist kein Zustand für den
Betrieb.

Unter **Verwaltung → Rollen** stehen Rollen mit Bereichsrechten
(`kein` / `lesen` / `bearbeiten`) bereit, ausgeliefert unter anderem
„HR-Sachbearbeitung" ohne Vergütungszugriff. Unter **Verwaltung → Benutzer &
Rechte** wird jedem Konto eine zugewiesen.

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

1. Erst die Personalprofile anlegen oder importieren.
2. Dann die Portal-Konten — zunächst nur für eine kleine Testgruppe.
3. Nach der Rückmeldung der Testgruppe der Rest.

Beim Verteilen der Erstpasswörter: Adresse und Passwort auf getrennten Wegen.

- [ ] Testgruppe kann sich anmelden, sieht **nur** die eigenen Daten.
- [ ] Eine Testperson prüft den Firmenkalender: Bei Krankmeldungen steht dort
      kein Name (Gegenprobe zu Punkt 7).

## 9. Datensicherung scharf schalten

Nach [`../deploy/README.md`](../deploy/README.md), Abschnitt 5:

- [ ] `hrmonic-backup.timer` aktiv (`systemctl list-timers hrmonic-backup.timer`).
- [ ] Ein Lauf erfolgreich, Verzeichnis enthält `hrmonic.db`, `storage/`,
      `secret.key`, `MANIFEST.txt`.
- [ ] Auslagerung auf ein zweites System eingerichtet (eine Sicherung neben den
      Daten schützt vor keinem der Fälle, für die man sichert).
- [ ] **Restore-Probe** einmal durchgeführt und protokolliert (Datum, wer,
      Ergebnis). Wiedervorlage in sechs Monaten.

## 10. Abnahme

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

- [ ] Punkte 1 bis 9 abgehakt.
- [ ] Ein Arbeitsplatz der HR-Administration arbeitet über die Desktop-App
      gegen den Server (nicht mehr gegen die lokale Datenbank).
- [ ] Ein Portal-Konto hat einen Antrag gestellt und die HR hat ihn gesehen.
- [ ] Ein Dokument wurde hochgeladen, heruntergeladen und im Backup
      wiedergefunden.
- [ ] Zuständigkeit hinterlegt: Wer prüft die Sicherungen, wer spielt Updates
      ein, wer ist Ansprechpartner bei Störungen?

## Was Sie danach im Blick behalten sollten

| Rhythmus | Aufgabe |
|---|---|
| täglich (automatisch) | Sicherung; bei Fehlschlag meldet sich systemd — `systemctl status hrmonic-backup` |
| wöchentlich | Journal auf gehäufte Anmeldefehler durchsehen |
| monatlich | Kontenliste durchgehen: ausgeschiedene Personen, Rollen noch passend? |
| halbjährlich | Restore-Probe |
| bei jedem Update | Sicherung vorher, Journal nachher (`deploy/README.md`, Abschnitt 6) |
