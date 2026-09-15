# Betrieb beim Anbieter

Was der ANBIETER tut, nicht der Kunde. Kundenseitige Anleitungen stehen in
`docs/inbetriebnahme.md` (Erstinbetriebnahme), `deploy/README.md` (Linux) und
`deploy/windows/README.md` (Windows Server). Hier geht es um Schluessel,
Lizenzen, Releases, Rollouts und die Faelle, in denen etwas schiefgeht.

Werkzeuge:

| Wofuer | Befehl |
|---|---|
| Schluessel erzeugen, Lizenz ohne Register ausstellen, Datei ansehen | `npm run lizenz -- ...` |
| Kunden, Instanzen, Hosts, Lizenzen, Releases, Rollouts | `npm run conspectus -- ...` |
| Release bauen (alle Varianten, signiertes Manifest) | `npm run release -- --version ...` |
| Einzelnes Server-Archiv | `npm run release:server -- --variant ...` |

---

## 1. Schluessel und Geheimnisse

Es gibt ZWEI Schluesselpaare, und sie sind bewusst getrennt. Ein verlorener
Release-Schluessel darf keine Lizenzen faelschen koennen und umgekehrt.

| Schluessel | Wofuer | Wo | Rotation |
|---|---|---|---|
| Lizenzschluessel (Ed25519, PEM) | signiert `lizenz.ohrganize` | `$OHRGANIZE_CONSPECTUS_DIR/schluessel/<kid>.pem`, verschluesselt | neuer `kid`, alter bleibt in `licenseKeys.ts`, bis alle Kunden neu signiert sind |
| Release-Schluessel (Ed25519, SSH) | signiert `release.json` | ausserhalb des Repos, Passphrase | neue Zeile in `deploy/ohrganize-release.allowed_signers`, alte stehen lassen |

**Niemals** im Repository, in OneDrive oder in einer Mail. Beide Verzeichnisse
gehoeren in die eigene Datensicherung; ohne den Lizenzschluessel lassen sich
bestehende Kunden nicht mehr verlaengern.

```bash
# Lizenzschluessel erzeugen (Passphrase ueber die Umgebung)
export OHRGANIZE_LICENSE_PASSPHRASE='...'
npm run lizenz -- keygen --out "$OHRGANIZE_CONSPECTUS_DIR/schluessel" --kid 2026-09
# Den oeffentlichen Teil in apps/backend/src/core/licenseKeys.ts eintragen,
# ALTE Eintraege stehen lassen (docs/lizenzierung.md, Abschnitt 3.1).

# Bestehenden Schluessel nachtraeglich verschluesseln, ohne kid-Wechsel
npm run lizenz -- protect --key "$OHRGANIZE_CONSPECTUS_DIR/schluessel/2026-09.pem"

# Release-Schluessel erzeugen
ssh-keygen -t ed25519 -C release@ohrganize -f ~/.ssh/ohrganize-release
# Inhalt von ohrganize-release.pub als letzte beiden Felder in
# deploy/ohrganize-release.allowed_signers eintragen (Zeile mit dem Platzhalter).
```

Das **Register** von conspectus (`OHRGANIZE_CONSPECTUS_DIR`) enthaelt
Kundennamen, Hostadressen und Lizenznummern. Es liegt ausserhalb des
Repositories und ausserhalb synchronisierter Ordner; conspectus weist beides
aktiv zurueck, statt darauf zu vertrauen.

```bash
export OHRGANIZE_CONSPECTUS_DIR=/var/lib/ohrganize-anbieter   # Linux
setx OHRGANIZE_CONSPECTUS_DIR C:\ohrganize-anbieter           # Windows
```

---

## 2. Lizenzfaelle

Alle Lizenzmodelle entstehen ausschliesslich aus den Feldern der signierten
Datei. Beim Kunden ist nichts davon umstellbar; jede Aenderung ist eine neue
Datei. Die Laufzeit ist frei waehlbar (`3t`, `2w`, `6m`, `1j`, ein Datum oder
`unbefristet`); die Beispiele hier sind Beispiele, keine Tarife.

Voraussetzung ist jeweils ein Kunde und eine Instanz im Register:

```bash
npm run conspectus -- kunde anlegen musterfirma --name "Musterfirma GmbH" --email it@musterfirma.de
npm run conspectus -- host anlegen hz1 --adresse hz1.example.net --basis-domain ohrganize.com
npm run conspectus -- instanz anlegen musterfirma --kunde musterfirma \
  --variante de-vollversion --host hz1
# Installations-ID holen (sie entsteht mit der Datenbank, nicht mit dem Vertrag)
npm run conspectus -- status --host hz1          # liest sie samt Zustand ein
# oder von Hand: ohrganize-provision.sh id musterfirma
```

### Testlizenz mit freier Laufzeit

```bash
npm run conspectus -- lizenz ausstellen --instanz musterfirma \
  --kind evaluation --until 3t --einspielen
```

`evaluation` setzt die Vorgaben passend: keine Kulanz (`grace_days = 0`) und
eine Warnung ab der halben Laufzeit. Beides bleibt mit `--grace` und `--warn`
ueberschreibbar. In der Oberflaeche heisst die Art "Testlizenz".

### Kostenfrei und unbefristet

```bash
npm run conspectus -- lizenz ausstellen --instanz musterfirma \
  --until unbefristet --billing kostenfrei --label "Pilotkunde 2026"
```

Die Lizenzseite zeigt dann "Ihre Lizenz laeuft unbegrenzt und kostenfrei." und
kein Kulanzdatum. Intern ist "unbefristet" der Sentinel `2999-12-31`; der
Zustand traegt `perpetual: true`, kein Countdown und keine Warnung.

### Abonnement

```bash
npm run conspectus -- lizenz ausstellen --instanz musterfirma \
  --until 1j --billing abo --interval jaehrlich --seats 50 \
  --notice "Rechnung 2026-1234"
```

`--seats` ist die Platzgrenze: Sie wird genau dort geprueft, wo ein
Personalprofil aktiv wird (Anlegen, Reaktivieren, Sammelaenderung,
Einstellung aus dem Recruiting) und antwortet dann mit
`409 LICENSE_SEATS_EXCEEDED`.

### Kauflizenz

```bash
npm run conspectus -- lizenz ausstellen --instanz musterfirma \
  --until unbefristet --billing kauf --label "Kauf inkl. 12 Monate Wartung"
```

### Kundenfunktion (Feature-Schluessel)

Eine massgeschneiderte Funktion wird als Feature im Hauptprodukt gebaut (nie
als Branch) und ueber die Lizenz freigeschaltet:

1. Eintrag in `FEATURES` (`packages/shared/src/features.ts`) mit `key`,
   `label`, `routes` und, falls sichtbar, `navPaths`/`widgets`/`portalPaths`.
2. Code im Hauptprodukt.
3. Freischaltung in der Datei:

```bash
npm run conspectus -- lizenz ausstellen --instanz musterfirma \
  --until 1j --billing abo --feature kunde.musterfirma.export
```

Ohne einschraenkende Lizenz ist alles an (Entwicklung, Testphase, v1-Dateien,
v2 ohne `features`). Fehlt ein Feature, antwortet der Server mit
`403 LICENSE_FEATURE_MISSING`; die Desktop-App zeigt das als Hinweis.

### Verlaengerung

```bash
npm run conspectus -- lizenz faellig --tage 45          # was laeuft bald ab
npm run conspectus -- lizenz verlaengern --instanz musterfirma --until 1j --einspielen
```

`verlaengern` erbt Art, Abrechnung, Intervall, Plaetze, Funktionen und den
Schluessel der letzten Datei und beginnt am Tag NACH dem bisherigen Ende, damit
keine Luecke entsteht. Alles bleibt ueberschreibbar. War die letzte Datei eine
v1, bleibt es dabei.

### Variantenwechsel (Kunde bekommt eine andere Ausgabe)

Eine Ausgabe ist ein eigener Build. Der Wechsel ist deshalb **Installer plus
Lizenz, ohne Migration** (das Datenbankschema ist in allen Varianten gleich):

1. Instanz im Register auf die neue Ausgabe stellen
   (`conspectus instanz anlegen` mit neuer `--variante`, oder von Hand).
2. `OHRGANIZE_VARIANT` in der env-Datei der Instanz aendern.
3. Release der neuen Ausgabe einspielen und die Instanz umstellen
   (`ohrganize-update.sh`), Portal-Symlink zieht mit.
4. Neue Lizenz ausstellen. Die alte v2-Datei nennt die alte Ausgabe und wird
   vom neuen Build abgelehnt.

Reihenfolge zaehlt: Erst Build und env-Datei, dann Lizenz. Umgekehrt stuende
die Instanz zwischen den Schritten mit einer Datei da, die sie fuer
unbrauchbar haelt.

### Lizenz ohne Register (Einzelfall, kleiner Weg)

```bash
npm run lizenz -- sign --key <privat.pem> --kid 2026-09 \
  --customer "Musterfirma GmbH" --customer-id musterfirma \
  --installation <32 hex> --until 1j \
  --edition vollversion --country DE --billing abo --interval jaehrlich
npm run lizenz -- inspect <datei>
```

Das Werkzeug fuehrt ein CSV-Register mit (`--register`), kennt aber weder
Instanzen noch Rollouts. Fuer alles Wiederkehrende ist conspectus der Weg.

---

## 3. Release bauen und veroeffentlichen

```bash
# 1. CHANGELOG: Abschnitt "Unveroeffentlicht" in "## 1.1.0" umbenennen
# 2. Alles committen (das Skript verlangt einen sauberen Arbeitsbaum)
npm run release -- --version 1.1.0 --variants de-vollversion \
  --sign-key ~/.ssh/ohrganize-release
```

Das Skript setzt die Version ueber alle Workspaces, committet, taggt
(`v1.1.0`), baut je Variante Bundles, Server-Archiv und Installer, prueft die
Bundles mit `check-variant` und schreibt je Variante ein `release.json` mit
den Pruefsummen aller Artefakte, signiert mit
`ssh-keygen -Y sign -n ohrganize-release`. Ablage:
`release/<version>/<kanal>/<variante>/`. Zum Schluss laeuft
`npm rebuild better-sqlite3`, weil `dist:win` die native Bibliothek auf die
Electron-ABI umbaut.

Der **Kanal** ist eine Funktion der Version: `1.1.0` ist `stable`,
`1.1.0-beta.1` ist `beta`. Eine Beta gehoert auf einen Testkunden, nie auf
eine Produktivinstanz.

```bash
# Gegenprobe vor dem Versand
cd release/1.1.0/stable/de-vollversion
ssh-keygen -Y verify -f ../../../../deploy/ohrganize-release.allowed_signers \
  -I release@ohrganize -n ohrganize-release -s release.json.sig < release.json
sha256sum -c ohrganize-server-de-vollversion-1.1.0.zip.sha256

# Ins Register
npm run conspectus -- release erfassen release/1.1.0/stable/de-vollversion/release.json
git push && git push origin v1.1.0
```

Download-Struktur beim Anbieter: `releases/<kanal>/<variante>/` mit einer
`latest.json` als Kopie des juengsten `release.json`.

---

## 4. Rollout im Hosting

```bash
npm run conspectus -- rollout starten --release de-vollversion-1.1.0 --probelauf
npm run conspectus -- rollout starten --release de-vollversion-1.1.0
npm run conspectus -- rollout starten --release de-vollversion-1.1.0 --kunde musterfirma
npm run conspectus -- rollout liste
```

conspectus kopiert Archiv, Pruefsumme und signiertes Manifest auf den Host und
ruft dort `ohrganize-update.sh update` auf. Die Umstelllogik steht bewusst NUR
dort: Pruefsumme, Signatur, Ausgabe gegen env-Datei UND `/api/health`,
`npm ci`, better-sqlite3-Probe, Migrations-Probelauf auf Kopien, dann je
Instanz Sicherung, stop, Symlink, start, Health, bei Fehler Ruecknahme.
Instanzen einer anderen Ausgabe bleiben unangetastet.

Ein ungeprueftes Release wird nicht ausgerollt (`--ohne-signatur` uebergeht
das bewusst). Schlaegt ein Host fehl, macht conspectus mit dem naechsten
weiter und vermerkt den Fehlschlag samt Protokoll im Register.

---

## 5. Einzelkunde (eigener Server, eigener Arbeitsplatz)

Verschickt werden je Ausgabe:

- `ohrganize-server-<variante>-<version>.zip` samt `.sha256`,
- `release.json` und `release.json.sig` (damit der Kunde die Signatur pruefen
  kann),
- `oHRganize-Setup-<version>-<variante>.exe` fuer die Arbeitsplaetze,
- die Lizenzdatei, getrennt.

**Immer die Ausgabe dazusagen.** Der Kunde prueft vor dem Entpacken
`VARIANTE.txt` gegen `OHRGANIZE_VARIANT` seiner env-Datei und gegen
`/api/health`; die LIESMICH im Archiv beginnt mit diesem Schritt. Ein Archiv
der falschen Ausgabe startet nicht und nimmt spaeter keine Lizenz an.

Auf Windows-Servern macht `deploy/windows/update-server.ps1` dasselbe wie
`ohrganize-update.sh`, nur fuer eine Instanz.

Instanzen ohne Hosting werden im Register als `--art kunde-server` gefuehrt;
`--einspielen` gibt es dort nicht (conspectus hat keinen Zugang). Der Bericht
kommt per Datei zurueck:

```bash
# Der Kunde schickt die Ausgabe von:  node apps/backend/dist/status.cjs --data-dir <pfad> --json
npm run conspectus -- bericht importieren bericht.json --instanz musterfirma
```

---

## 6. Stoerungen

| Bild beim Kunden | Ursache | Weg |
|---|---|---|
| "Die Lizenzdatei ist unbrauchbar." | Signatur, Format, falscher `kid`, fremde Installations-ID oder fremde Ausgabe | `npm run lizenz -- inspect <datei>` zeigt den Grund. Passt der `kid` nicht, fehlt der Eintrag in `licenseKeys.ts` des Kundenstands. |
| "Diese Lizenz gilt fuer die Ausgabe X; installiert ist Y." | v2-Datei der falschen Variante | Neue Datei mit der richtigen Ausgabe; die Instanz im Register pruefen. |
| Nur-Lese-Betrieb | Lizenz abgelaufen, Kulanz vorbei, oder keine Datei nach der Testphase | Neue Datei einspielen. Es gehen keine Daten verloren: Lesen und Exportieren bleiben offen. |
| "Die Systemzeit ist auffaellig." | Uhr des Servers verstellt | Der Stolperdraht `last_seen_date` warnt, sperrt nie. Zeit richten (NTP). |
| Dienst startet nach einem Update nicht | Archiv der falschen Ausgabe, oder Migration gescheitert | `ohrganize-update.sh` haette beides abgefangen. Von Hand: Journal lesen, Symlink zurueck, notfalls Sicherung. |
| Arbeitsplatz meldet "zu alt"/"zu neu" | `MIN_CLIENT_VERSION` bzw. `MIN_SERVER_VERSION` | Erst Server, dann Arbeitsplaetze. Waehrend einer Beta muss `MIN_CLIENT_VERSION` auf die Beta zeigen (siehe `packages/shared/src/version.ts`). |
| Niemand kommt mehr hinein | Passwort verloren, Konto gesperrt | `ohrganize-provision.sh passwort <kunde> --zuruecksetzen` |

Ein Tausch der Lizenzdatei im Datenverzeichnis ohne Upload erzeugt eine
Audit-Zeile `license.file_changed` mit `user_id NULL` und eine Journalzeile.
Wer wissen will, ob jemand die Datei von Hand ausgetauscht hat, findet es
dort.

---

## 7. Restore

Im Hosting ist der Weg ein Befehl:

```bash
ohrganize-provision.sh restore <kunde> /var/backups/ohrganize/<kunde>/ohrganize-JJJJMMTT-HHMMSS
```

Danach **immer pruefen**, ob seit dieser Sicherung eine neuere Lizenzdatei
eingespielt wurde. Der Dateiwaechter des Servers prueft keine Monotonie; ein
alter Stand bringt also still die alte Datei zurueck:

```bash
ohrganize-provision.sh lizenz <kunde> <neueste-datei>
npm run conspectus -- status --host <host>
```

Beim Einzelkunden nennt das `MANIFEST.txt` jeder Sicherung die
plattformgerechten Schritte.

---

## 8. Kuendigung und Datenherausgabe

1. **Daten herausgeben, bevor irgendetwas geloescht wird.** Die Sicherung ist
   dafuer der richtige Stand: Sie enthaelt Datenbank, `storage/`, `secret.key`
   und die Lizenzdatei in einem in sich geschlossenen Abzug.
2. Instanz abschalten, Daten liegen lassen:
   `ohrganize-provision.sh entfernen <kunde>`. Das loescht **absichtlich**
   keine Daten: In der Datenbank stehen Personalakten, deren
   Aufbewahrungsfristen den Vertrag ueberdauern koennen.
3. Erst wenn die Uebergabe bestaetigt ist:
   `ohrganize-provision.sh entfernen <kunde> --daten-loeschen` (mit Rueckfrage,
   unwiderruflich).
4. Im Register als Vorgang festhalten:
   `npm run conspectus -- zahlung <kunde> --betrag 0 --text "Vertragsende, Daten uebergeben am ..."`.

Die Lizenzlogik loescht **nie** Daten. Nur-Lese heisst lesbar und
exportierbar; eine abgelaufene Lizenz ist kein Grund, einen Bestand zu
verlieren.

---

## 9. Regelmaessig

```bash
npm run conspectus -- check          # abgelaufen, bald faellig, offene Rollouts, veraltete Instanzen
npm run conspectus -- lizenz faellig --tage 45
npm run conspectus -- uebersicht
npm run conspectus -- html --out /pfad/uebersicht.html
```

`check` arbeitet auf dem Register, ohne Netzzugriff. Damit die Zahlen stimmen,
gehoert vorher ein `conspectus status --host <host>` je Host dazu (das liest
Version, Kanal, Lizenzzustand und Platzzahl ein).

Die HTML-Uebersicht enthaelt Kundennamen und Hostschluessel. Sie gehoert nicht
in ein Repository und nicht in einen synchronisierten Ordner.

---

## 10. Durchstich auf dem Testserver

Noch offen (Phase 8 ist gebaut und in ihren Einzelteilen geprueft, aber der
Durchstich gegen einen echten Host steht aus). Zu pruefen sind:

1. `kunde anlegen`, `host anlegen`, `instanz anlegen --host test`.
2. `status --host test` liest Installations-ID, Version, Kanal,
   Lizenzzustand und Platzzahl ein.
3. `lizenz ausstellen ... --einspielen`: Datei liegt danach mit 0600 beim
   Dienstbenutzer, der Zustand wechselt ohne Neustart, die Kopie unter `/tmp`
   des Servers ist weg.
4. `release erfassen` mit echter Signatur (Signatur wird geprueft, nicht nur
   vermerkt).
5. `rollout --probelauf`, dann ein echter Rollout samt absichtlich brechender
   Migration, um die Ruecknahme zu sehen.
6. `check`, `uebersicht`, `html`.
