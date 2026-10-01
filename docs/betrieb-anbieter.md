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

# Release-Schluessel erzeugen (Stand 15.09.2026: erzeugt, Schluessel 1 liegt im
# Tresor neben dem Lizenzschluessel als "ohrganize-release", bisher ohne
# Passphrase; nachtraeglich: ssh-keygen -p -f ohrganize-release)
ssh-keygen -t ed25519 -C release@ohrganize -f <tresor>/ohrganize-release
# Inhalt von ohrganize-release.pub als letzte beiden Felder in
# deploy/ohrganize-release.allowed_signers eintragen; die Datei liegt auch auf
# jedem Host unter /opt/ohrganize/deploy und muss dort mitgezogen werden.
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

Beim Kunden-Server gibt es kein `--einspielen`; wie der Vermerk dort ins
Register kommt, steht in Abschnitt 5. Bis die neue Datei eingespielt ist,
nennen `faellig` und `check` weiter den Ablauf der laufenden (Spalte ART:
"Nachfolge ... ausgestellt").

Eine Datei, die nie eingespielt wird (Fehlausstellung, abgelehntes Angebot,
nicht genutzte Evaluation), wird zurueckgezogen; danach gilt wieder die
vorherige als ausgestellt. Eingespielte Dateien lassen sich nicht
zurueckziehen, und die Datei selbst bleibt technisch gueltig:

```bash
npm run conspectus -- lizenz zurueckziehen 1a2b3c4d
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
# Host mit eigenem SSH-Schluessel (sonst gilt der Standardschluessel des Aufrufers)
npm run conspectus -- host anlegen hz1 --adresse hz1.example.net --schluessel <tresor>/hz1_ed25519
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

Statt der Ausgabe von `status.cjs` taugt auch der Lizenzbericht der
Desktop-App (Einstellungen, Lizenz, Bericht), den der Kunde ohnehin schickt;
bei einem Einzelplatz ist er der einzige Bericht. Die Lizenznummer, die ein
Bericht meldet, gilt als die laufende der Instanz und wird als eingespielt
vermerkt, gleich ob es die zuletzt ausgestellte ist. Meldet die Instanz eine
aeltere als die zuletzt eingespielte (etwa nach einem Restore), sagt `check`
das.

Ein Bericht, der erkennbar zu einer anderen Instanz gehoert, wird abgelehnt
und aendert nichts: fremde Installations-ID, eine Lizenz einer anderen
Instanz oder (beim Lizenzbericht) ein anderer Kunde. Kommt die Ablehnung aus
einem Hostbericht (`status --host` oder dessen gespeicherte Ausgabe, erkennbar
am Feld `kunde` je Eintrag), bleibt sie an der Instanz vermerkt und `check`
meldet sie, bis ein Bericht kommt, der sich ausweist (Installations-ID,
Lizenz oder Kunde) und passt, oder `instanz id` die Kennung neu setzt. Bei
einer Einzelausgabe oder einem Lizenzbericht genuegt die Fehlermeldung, denn
dort kann es auch die falsche Datei gewesen sein.

Es gilt der zuletzt eingelesene Bericht oder Vermerk; Zeitstempel werden nicht
verglichen. Schickt der Kunde mehrere Berichte, den neuesten zuletzt einlesen.
Wurde ein aelterer nach einem neueren eingelesen, meldet `check` "Lizenz ...
war eingespielt, die Instanz meldet aber ...: Restore beim Kunden oder ein
aelterer Bericht nach einem neueren eingelesen?"; den neuesten noch einmal
einlesen behebt es. Als Tag des Einspielens zaehlt beim Lizenzbericht der Tag,
an dem er erzeugt wurde, sonst der Tag des Einlesens.

Hat der Kunde wirklich neu installiert (frische Datenbank, neue
Installations-ID), bestaetigt das `--neue-installation` beim Import; bei
`status --host` mit dem Schluessel genau dieser Instanz
(`--neue-installation <instanz>`), damit es nicht fuer alle Instanzen des
Hosts gilt. Danach meldet `check` jede Lizenz, die noch an die alte
Installation gebunden ist, und sagt, ob eine passende schon ausgestellt ist
(dann nur einspielen lassen) oder eine neue noetig ist. Fuer die neue nennt er
das Ende der zuletzt ausgestellten: `lizenz ausstellen` uebernimmt die bezahlte
Laufzeit nicht, ein `--until 1j` ab heute endete womoeglich frueher.

Kommt nach dem Einspielen kein Bericht zurueck, von Hand nachtragen, sonst
meldet `check` die Lizenz dauerhaft als nicht eingespielt:

```bash
npm run conspectus -- lizenz eingespielt musterfirma --am 2026-10-01
```

Vorgabe ist die zuletzt ausgestellte Lizenz, mit `--lizenz <nummer>` eine
andere der Instanz. `--am` liegt zwischen Ausstellung und heute; ist die
Lizenz schon als laufend vermerkt, bricht der Aufruf ab.

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

Wer das vergisst, sieht es nach dem naechsten Bericht in `check`: "Lizenz ...
war eingespielt, die Instanz meldet aber ...: Restore beim Kunden ...?".

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

Je Instanz unterscheidet das Register zwei Lizenzen. **Ausgestellt** ist die
zuletzt ausgestellte, nicht zurueckgezogene Datei; auf ihr bauen
`verlaengern` und `lizenz eingespielt` auf, und `check` meldet, solange sie
nicht eingespielt ist. **Laufend** ist die Datei auf der Instanz: die zuletzt
gemeldete oder vermerkte, ohne Beleg die zuletzt eingespielte, sonst die des
laufenden Zeitraums. Ablaufwarnung, `faellig` und die Spalte "Lizenz bis" der
Uebersichten richten sich nach ihr, denn eine ausgestellte, aber nicht
eingespielte Verlaengerung verlaengert beim Kunden nichts. War die
ausgestellte schon eingespielt und meldet die Instanz trotzdem eine andere
(Restore oder ein aelterer Bericht zuletzt eingelesen), ist offen, welche
laeuft; dann zaehlt das fruehere der beiden Enden, und `faellig` vermerkt
"Instanz meldet ...".

Die Version einer Instanz wird mit dem juengsten stabilen Release verglichen,
bei einer Beta mit dem juengsten Release ueberhaupt (auch das fertige loest
sie ab). Ob Beta, folgt aus der Versionsnummer.

Die HTML-Uebersicht enthaelt Kundennamen und Hostschluessel. Sie gehoert nicht
in ein Repository und nicht in einen synchronisierten Ordner.

---

## 10. Durchstich auf dem Testserver

Durchgespielt am 15.09.2026 von einem Windows-Arbeitsplatz aus gegen den
Debian-13-Testserver (ssh ueber 127.0.0.1:2222 mit eigenem Schluessel,
`host anlegen --schluessel`), Register in einem lokalen Verzeichnis
ausserhalb von Repo und OneDrive:

1. `kunde anlegen`, `host anlegen --port 2222 --schluessel ...`,
   `instanz anlegen --host wsl --installation <id>`.
2. `status --host wsl` liest Installations-ID, Version, Kanal, Lizenzzustand,
   Platzzahl und `license_format` ein (aus `provision.sh status --json`).
3. `lizenz ausstellen --until 60t --kind evaluation --einspielen`: erst
   abgelehnt, solange kein Bericht `license_format >= 2` belegt (Server vor
   Datei), nach dem Bericht ausgestellt und per scp plus
   `provision.sh lizenz` eingespielt; die Datei liegt mit 0600 beim
   Dienstbenutzer, der Zustand wechselt ohne Neustart.
4. `release erfassen release/1.0.0/stable/de-vollversion/release.json` mit
   dem echten Schluessel: Signatur geprueft. Ein manipuliertes Manifest wird
   von `ssh-keygen -Y verify` abgelehnt.
5. `rollout starten --probelauf` (alle drei Instanzen des Hosts) und ein
   echter Rollout auf eine Instanz: `ohrganize-update.sh` prueft auf dem
   Host Signatur, Pruefsumme gegen das Manifest, Ausgabe, Migrations-Probelauf
   und stellt die Instanz um; Register vermerkt `fertig`. Die Ruecknahme
   bei kaputtem Release ist in `deploy/README.md` 9.7 protokolliert (dort
   mit einem absichtlich abbrechenden `cli.cjs`; eine brechende Migration
   braucht ein Release mit Schemaaenderung).
6. `check`, `lizenz faellig`, `uebersicht`, `html`.

Dabei behoben: Dateipfade in Argumenten galten relativ zum Workspace statt
zum Aufruferverzeichnis; `check` rechnete Resttage mit falschem Vorzeichen
("noch -59 Tage"); ohne `license_format` im Bericht war v2 nie belegt
(`status.cjs` und `provision.sh status --json` liefern es jetzt).
