# Lizenzierung

Wie oHRganize die Nutzungsberechtigung prüft, was nach dem Ablauf passiert, und
wie Anbieter und Kunde damit umgehen. Quelltext: `apps/backend/src/core/license.ts`
(Zustand und Durchsetzung), `licenseCodec.ts` (Dateiformat und Signatur),
`licenseKeys.ts` (Vertrauensanker), `scripts/license-tool.ts` (Werkzeug des
Anbieters), `packages/shared/src/license.ts` (Vertrag zwischen Backend und
Clients).

## 1. Das Modell

**Eine signierte Datei, kein Rückkanal.** Die Lizenz ist eine Textdatei
`lizenz.ohrganize` im Datenverzeichnis des Backends (neben `ohrganize.db` und
`secret.key`). Sie besteht aus einer Zeile
`OHRG1.<base64url(JSON)>.<base64url(Ed25519-Signatur)>`; den privaten
Signierschlüssel hat nur der Anbieter, die öffentlichen Schlüssel stecken im
Backend (`licenseKeys.ts`). Das Backend braucht zur Prüfung weder Netz noch
einen Lizenzserver, und der Anbieter kann von außen nichts abschalten: Die
Laufzeit der Datei ist der bezahlte Zeitraum, bei Nichtzahlung stellt er
schlicht keine neue aus.

**Warum signiert und nicht verschlüsselt.** Signieren liefert Unversehrtheit
und Herkunft: Ein geändertes Byte in `valid_until` lässt die Prüfung
scheitern, und den Schlüssel zum Neusignieren gibt es nur beim Anbieter.
Verschlüsseln würde nur den Inhalt verstecken, und der Schlüssel dafür müsste
auf dem Kundenserver liegen, wo er nichts mehr schützt. Der Inhalt ist ohnehin
nicht geheim (Kundenname, Laufzeit, Platzzahl).

**Ehrliche Grenze der Durchsetzung.** Das Backend läuft auf Hardware des
Kunden. Wer dort Administrator ist, kann die Systemuhr stellen, die
Datenbank ändern oder den Quelltext des Bundles patchen — jede Lizenzprüfung
auf Kundenhardware ist ein Zaun, keine Mauer. Das Modell ist darauf
ausgelegt, den **ehrlichen Kunden** rechtzeitig und verständlich auf das
Vertragsende hinzuweisen und dem Anbieter eine belastbare Grundlage
(Register, Installations-ID, Bericht) zu geben. Es ist nicht darauf
ausgelegt, einen entschlossenen Umgeher aufzuhalten, und tut so, als wäre es
das, an keiner Stelle: Es gibt kein Wasserzeichen als Riegel, keine
Telemetrie, keine Fernabschaltung. Was es ebenfalls **nicht** gibt, ist eine
Hintertür an der Prüfung selbst: Der Test-Override
`OHRGANIZE_LICENSE_PUBLIC_KEY` (ein eigener Prüfschlüssel für
`licenseSmoke.ts`) wird beim Bauen der Produktionsbundles herauskompiliert
(`esbuild --define` in `apps/backend/package.json`; `release-server.mjs`
weist ein Bundle ab, das die Variable noch liest), und die Desktop-App
löscht die Variable zusätzlich aus ihrer Umgebung, bevor sie ihr
eingebettetes Backend lädt. Auf ausgelieferten Builds ist der Override also
kein Umgehungsweg — wer die Prüfung aushebeln will, muss das Bundle ändern.

**Nie destruktiv.** Was nach dem Ablauf passiert, ist abgestuft (Warnung,
Kulanz, Nur-Lese-Betrieb) und rührt Daten nicht an. Die Personalakte
unterliegt Aufbewahrungsfristen, die einen Vertrag überdauern; Einsicht und
Export bleiben deshalb immer möglich. **Keine Lizenzlogik löscht jemals
Daten** — das ist eine Regel für jede künftige Änderung an diesem Modul.

## 2. Zustände

Das Backend berechnet den Zustand aus Datei, Kalendertag (lokale Systemuhr)
und der Tabelle `installation` (Migration `004_license`, genau eine Zeile:
`installation_id`, `created_at`, `licensed_at`, `last_seen_date`). Er steht
vollständig in `GET /api/license`, `POST /api/auth/login` und
`GET /api/auth/me` (für Admin-Konten; Portal-Konten bekommen nur
`{ read_only }`) und als Kurzform im Header `x-ohrganize-license` — **nur auf
angemeldeten Antworten**: Admin-Konten sehen den Zustand (`trial`, `valid`,
`grace`, `expired`), Portal-Konten nur `valid` oder `expired` (ob der
Arbeitgeber in Testphase, Vorwarnung oder Kulanz ist, geht die Belegschaft
nichts an), und öffentliche Antworten (Health, Login-Fehler, signierte
Downloads) tragen den Header gar nicht. Das unangemeldete `GET /api/health`
liefert für Monitoring allein `license.read_only`.

| Zustand | Bedeutung | Schreibzugriff | Anzeige |
|---|---|---|---|
| `entwicklung` | `OHRGANIZE_DATA_DIR` ist nicht gesetzt — das Backend läuft gegen `apps/backend/data`, dieselbe Grenze, an der `seed.ts` den Produktivbetrieb erkennt. Keine Prüfung. | ja | nichts |
| `trial` | Diese Datenbank hat noch nie eine gültige Lizenz gesehen; die **Testphase** läuft **30 Tage** ab `installation.created_at` (bei einem Update einer Bestandsinstallation: ab dem Update). Unbegrenzte Plätze. | ja | Hinweisbanner für Admins; in den letzten 7 Tagen als Warnung |
| `valid` | Lizenz gültig bis einschließlich `valid_until`. `warning = true` ab `warn_days` vor Ablauf (**Vorgabe 30 Tage**, je Lizenz einstellbar). Unbefristete Lizenzen (`valid_until = 2999-12-31`) melden `perpetual = true`, keinen Countdown (`days_left = null`), keine Kulanz (`grace_until = null`) und nie eine Warnung. | ja | Banner ab `warning`; Testlizenzen (`kind = evaluation`) zeigen eine schmale Infoleiste mit Restlaufzeit |
| `grace` | `valid_until` überschritten, **Kulanzfrist** läuft (`grace_days`, **Vorgabe 14 Tage**). Voller Funktionsumfang. | ja | rotes Banner, nicht wegklickbar |
| `expired` | Kulanz vorbei, Testphase vorbei, Datei gelöscht oder unbrauchbar — **Nur-Lese-Betrieb**. | **nein** (403 `LICENSE_EXPIRED`) | rotes Banner; Portal: neutraler Hinweis |

**Was Nur-Lese-Betrieb heißt.** GET und HEAD bleiben offen: Einsicht, Listen,
Exporte (CSV, DATEV, Bescheinigungen), signierte Downloads. Offen bleiben
außerdem genau die Schreibrouten, die den Weg zurück, den Export oder den
Konto-Widerruf ermöglichen (`LICENSE_OPEN_ROUTES` in `core/license.ts`):
Anmeldung, `/api/auth/me`, Passwortwechsel, `PUT /api/license`, die drei
`…/sign`- bzw. `…/download`-POSTs, die nur eine kurzlebige Download-URL
ausgeben, sowie `DELETE`/`PATCH /api/admin/users/:id` und
`POST /api/admin/users/:id/reset-password`. Letztere aus einem
Sicherheitsgrund: Der Lesezugriff steht im Nur-Lese-Betrieb **allen**
bestehenden Konten offen — ein ausgeschiedenes oder kompromittiertes Konto
muss deshalb weiterhin gelöscht, zurückgesetzt (das entwertet alle
Sitzungen) oder seiner Rolle entzogen werden können. Das Anlegen neuer
Konten (`POST /api/admin/users`) bleibt gesperrt, und die Rechteprüfung
(`benutzer: bearbeiten`) greift danach unverändert. Jeder andere
Schreibzugriff — Desktop-App **und** Portal — antwortet
`403 { error: { code: 'LICENSE_EXPIRED', message } }`. Die Meldung ist
deutsch und hängt vom Konto ab: Admin-Konten bekommen den Sachstand
(Testphase bzw. Lizenz abgelaufen, Kulanzende, Verweis auf Einstellungen →
Lizenz) und zeigen ihn direkt an; Portal-Konten bekommen schon vom Server
nur den neutralen Hinweis („Das Portal ist derzeit nur zur Ansicht
verfügbar …“), und das Portal ersetzt eine `LICENSE_EXPIRED`-Meldung
zusätzlich selbst durch denselben Text (`apps/web/src/lib/license.ts`).
Audit-Zeilen, Login-Drosselung und die Statusbuchung des DATEV-Exports
schreiben weiterhin: Der Export ist genau das, was ein abgelaufener Kunde
noch braucht.

**Platz-Obergrenze (`max_users`).** Zählt aktive Personalprofile
(`employees.status = 'aktiv'`, dieselbe Zahl wie die Kopfzahl auf dem
Dashboard). Geprüft wird ausschließlich dort, wo Profile aktiv **werden**:
Anlegen, Reaktivieren, Sammeländerung, Einstellung aus dem Recruiting.
Darüber hinaus antwortet der Server `409 LICENSE_SEATS_EXCEEDED`; bestehende
Profile bleiben unangetastet, es entstehen nur keine neuen. Ohne `max_users`
(und in der Testphase) gibt es keine Grenze.

**Monoton über den Ausstelltag.** Eine neue Datei wird übernommen, wenn sie
nicht früher ausgestellt wurde als die eingespielte (`issued_at`). Eine
später ausgestellte Datei darf auch kürzer laufen: So löst ein Jahresabo
eine kostenfreie unbefristete Lizenz ab, und ein gekürzter Vertrag wird
abbildbar. Nur bei gleichem Ausstelltag gilt zusätzlich "nicht kürzer",
weil dann nichts die Reihenfolge belegt. Ein alter Mail-Anhang kann damit
weiterhin keine bezahlte Laufzeit verkürzen und keine später ausgestellte
Datei mit geänderter Platzzahl verdrängen. Abgelehnt werden außerdem
Dateien, deren Kulanzfrist schon vorbei ist, und Dateien für eine andere
Installation. `valid_until` reicht höchstens bis **2999-12-31**; das ist im
Werkzeug „unbefristet“ — weit genug, aber diesseits der Jahr-10000-Grenze,
an der die ISO-Datumsarithmetik kippte und eine Dauerlizenz als abgelaufen
gälte.

**Keine zweite Testphase.** Mit der ersten gültigen Lizenz setzt das Backend
`installation.licensed_at`. Danach führt „Datei löschen“ nicht zurück in 30
freie Tage, sondern direkt in den Nur-Lese-Betrieb. Eine Datenbank, die
nie eine Lizenz hatte, behält ihre Testphase auch über Sicherung und
Restore hinweg — der Stichtag steht in der Datenbank, nicht in einer Datei.
Umgekehrt beendet eine **bereits über die Kulanz hinaus abgelaufene** Datei,
die jemand während der Testphase von Hand ins Datenverzeichnis kopiert, die
Testphase nicht: Das Backend wendet dieselbe Regel an wie der Upload,
ignoriert die Datei (Grund in `invalid_reason`) und setzt `licensed_at`
nicht — die Testphase läuft weiter, statt in den Nur-Lese-Betrieb zu kippen.

**Unbrauchbare Datei.** Falsche Signatur, unbekannter Schlüssel (`kid`),
kaputtes Format, andere Installations-ID: Die Datei wird ignoriert, der
Zustand fällt auf `trial` bzw. `expired` zurück, und der Grund steht für die
Administration in `invalid_reason` (Einstellungen → Lizenz) und im
Startprotokoll. Der Upload über die Oberfläche lehnt eine solche Datei mit
`400 LICENSE_INVALID` und derselben Meldung ab, **bevor** sie geschrieben
wird — die alte Datei bleibt dann unverändert.

**Uhren-Stolperdraht.** Das Backend merkt sich den größten je gesehenen
Kalendertag (`last_seen_date`, nur vorwärts). Steht die Systemuhr mehr als
einen Tag davor, wird `clock_warning` gesetzt, protokolliert und Admins
angezeigt. Es ist ausdrücklich **kein Riegel**: Windows stellt Uhren auch
von selbst um (Secure Time Seeding), und ein harter Riegel träfe zuerst den
ehrlichen Kunden.

**Bindung an die Installation.** `installation_id` ist eine Zufalls-ID, die
die Migration je Datenbank erzeugt. Sie wandert mit der Datenbank — Restore
und Umzug behalten sie, eine frisch angelegte Datenbank bekommt eine neue.
Eine Lizenz nennt die ID, für die sie gilt (`--installation <id>`), oder ist
ungebunden (`--installation -`, für Auswertungslizenzen vor der
Installation). Die Bindung ist eine Kennung für Support und Register, kein
Kopierschutz: Eine kopierte Datenbank trägt dieselbe ID.

**Heißes Nachladen.** Das Backend prüft die Datei höchstens alle fünf
Sekunden auf Änderung (mtime/Größe). Ein Upload über die Oberfläche wirkt
sofort; eine von Hand ins Datenverzeichnis kopierte Datei innerhalb weniger
Sekunden — ein Dienstneustart ist in keinem Fall nötig.

## 3. Der Anbieter: Schlüssel, Signieren, Register

Alles läuft über `npm run lizenz -- <befehl>` aus dem Repository (nie auf
einem Kundensystem; das Werkzeug ist nicht Teil des Release-Archivs). Der
Aufruf läuft im Workspace `apps/backend` — **relative Pfade (`--out`,
`--key`, `--register`) beziehen sich darauf**, am sichersten sind absolute.

### 3.1 Schlüsselpaar

```bash
OHRGANIZE_LICENSE_PASSPHRASE='…' npm run lizenz -- keygen --out /pfad/zum/tresor --kid 2026-09
npm run lizenz -- keys        # eingebaute öffentliche Schlüssel mit Fingerabdruck
```

`keygen` legt `lizenz-privat-<kid>.pem` (0600, mit gesetzter Passphrase
AES-256-verschlüsselt) und `lizenz-oeffentlich-<kid>.pem` ab, überschreibt
nie, und gibt die Zeile aus, die in `apps/backend/src/core/licenseKeys.ts`
gehört. `--kid` ist die Kennung des Schlüssels (Vorgabe: aktueller Monat,
`JJJJ-MM`); jede Lizenzdatei nennt ihren `kid`, so findet das Backend den
passenden Prüfschlüssel.

**Verwahrung des privaten Schlüssels:** nie im Repository, nie in OneDrive
oder einem anderen synchronisierten Ordner, nie in einer Mail oder einem
Chat. Ablage in einem Passwortmanager-Tresor oder auf einem verschlüsselten
Datenträger, Passphrase getrennt davon. Wer den Schlüssel hat, kann jedem
Kunden unbegrenzte Lizenzen ausstellen; wer ihn verliert, kann keinem Kunden
mehr eine verlängern, bis ein neuer Schlüssel per Update ausgeliefert ist.

**Nachträglich verschlüsseln** — ein ohne Passphrase erzeugter Schlüssel
bleibt derselbe Schlüssel (gleiche `kid`, kein Update, kein Eintrag in
`licenseKeys.ts`), nur die Datei wird geschützt:

```bash
OHRGANIZE_LICENSE_PASSPHRASE='…' npm run lizenz -- protect --key /pfad/zum/tresor/lizenz-privat-2026-09.pem
```

`protect` liest die verschlüsselte Fassung zurück, prüft eine Signatur
gegen den Originalschlüssel und ersetzt erst dann die Datei; die Passphrase
muss mindestens zwölf Zeichen haben. Ab da braucht jedes `sign` dieselbe
Variable.

**Schlüsselwechsel** (Kompromittierung, Turnus): `keygen` mit neuem `kid`,
den Eintrag in `licenseKeys.ts` **hinzufügen** (nicht ersetzen), Update
ausliefern, ab dann mit dem neuen Schlüssel signieren. Der alte Eintrag
bleibt, bis alle Kunden neu signierte Dateien haben — sonst fällt deren
Server nach dem Update in den Nur-Lese-Betrieb. Erst dann den alten Eintrag
entfernen. `npm run lizenz -- keys` zeigt, was eingebaut ist; der
Fingerabdruck steht auch im Kopf von `licenseKeys.ts`.

### 3.2 Lizenz ausstellen

```bash
OHRGANIZE_LICENSE_PASSPHRASE='…' npm run lizenz -- sign \
  --key /pfad/zum/tresor/lizenz-privat-2026-09.pem --kid 2026-09 \
  --customer "Musterfirma GmbH" --customer-id musterfirma \
  --installation 799b5d35736252a62f5ad3f8a5903945 \
  --until 2027-09-12|unbefristet|3t|6m|1j [--from 2026-09-13] \
  [--seats 50] [--grace 14] [--warn 30] [--kind standard|evaluation] \
  [--notice "Rechnung 2026-1234"] \
  [--out /pfad/lizenz-musterfirma-2027-09-12.ohrganize] \
  [--register /pfad/zum/tresor/lizenzen.csv] \
  [--edition vollversion --country DE] [--feature kunde.musterfirma.export] \
  [--billing kostenfrei|abo|kauf|individuell] [--interval monatlich|jaehrlich] \
  [--label "Partnerkonditionen"] [--headline "Ihre Partnerlizenz"] [--v2]
```

**Lizenzfassung v1 und v2.** Ohne eines der Flags `--edition`, `--country`,
`--feature`, `--billing`, `--headline`, `--v2` entsteht eine v1-Datei, die
jeder Server liest. Sobald eines gesetzt ist, entsteht v2; dann sind
`--edition` und `--country` Pflicht, und der Server des Kunden muss v2
lesen: `GET /api/health` und der Lizenzbericht melden `license_format`
(2 = liest v2; fehlt das Feld, ist der Server älter). **Rollout immer
Server vor Datei.** Ein v2-Server prüft Ausgabe und Land der Datei gegen
seine Variante (ab dem Varianten-Build) und lehnt eine fremde Ausgabe ab.
Welche Editionen es gibt, legt der Anbieter im Variantenregister fest;
das Werkzeug prüft nur das Muster (Kleinbuchstaben, Ziffern, Bindestrich).

**Lizenzmodelle entstehen nur aus der Datei.** Nichts davon ist beim
Kunden umstellbar; jede Änderung ist eine neue signierte Datei:

| Modell | Aufruf (Auszug) | Anzeige beim Kunden |
|---|---|---|
| Testlizenz, 3 Tage | `--kind evaluation --until 3t` | Testlizenz bis TT.MM.JJJJ, noch 3 Tage. |
| Testlizenz, 6 Wochen | `--kind evaluation --until 6w` | wie oben, Warnung ab der Hälfte der Laufzeit |
| kostenfrei unbefristet | `--until unbefristet --billing kostenfrei --edition ... --country DE` | Ihre Lizenz läuft unbegrenzt und kostenfrei. |
| Kauflizenz | `--until unbefristet --billing kauf ...` | Ihre Lizenz läuft unbegrenzt. Kauflizenz. |
| Jahresabo | `--until 1j --billing abo --interval jaehrlich ...` | Ihre Lizenz gilt bis TT.MM.JJJJ (noch N Tage). Abonnement, jährliche Verlängerung. |
| Kundenfunktion | `... --feature kunde.musterfirma.export` | Funktionen: kunde.musterfirma.export |
| eigene Überschrift | `... --headline "Partnerlizenz der Musterfirma"` | ersetzt die erzeugte Überschrift, solange die Lizenz gültig ist |

Laufzeiten: `3t` Tage, `2w` Wochen, `6m` Monate, `1j` Jahre, jeweils ab
`--from` (Vorgabe heute) bis einschließlich des letzten Tages. Vorgaben je
Art: `standard` Kulanz 14 und Warnung 30 Tage; `evaluation` Kulanz 0 und
Warnung ab der Hälfte der Laufzeit (höchstens 30 Tage). Beides ist mit
`--grace` und `--warn` frei überschreibbar.

| Option | Bedeutung |
|---|---|
| `--key`, `--kid` | privater Schlüssel und seine Kennung; das Werkzeug prüft, dass der Schlüssel zum eingebauten öffentlichen Schlüssel dieses `kid` passt, und warnt, wenn der `kid` in `licenseKeys.ts` fehlt |
| `--customer`, `--customer-id` | Anzeigename und stabile Kennung (Dateiname, Register) |
| `--installation` | 32 Hex-Zeichen aus Einstellungen → Lizenz beim Kunden, oder `-` für eine ungebundene Datei (alles andere weist das Werkzeug ab) |
| `--until`, `--from` | letzter gültiger Tag (einschließlich) und erster Tag (Vorgabe: heute); echte Kalendertage `JJJJ-MM-TT`, `--until` höchstens `2999-12-31` — oder wörtlich `--until unbefristet` (die App zeigt dann „unbefristet“ statt eines Datums; zusammen mit weggelassenem `--seats` die Lizenz für einen Kunden ohne Laufzeit und Platzgrenze) |
| `--seats` | `max_users`; ohne Angabe unbegrenzt |
| `--grace`, `--warn` | Kulanz- und Vorwarntage (Vorgaben 14 und 30) |
| `--kind` | `standard` (Vorgabe) oder `evaluation` (in der Oberfläche "Testlizenz"); nur Anzeige und Register. Die Laufzeit einer Testlizenz ist frei: `--until` bestimmt sie, drei Tage sind so möglich wie drei Monate |
| `--notice` | Freitext, den Admins unter Einstellungen → Lizenz sehen (z. B. Rechnungsbezug); nicht für Portal-Konten |
| `--out` | Dateiname (Vorgabe: `lizenz-<customer-id>-<until>.ohrganize`) |
| `--register` | CSV-Register, wird angelegt und fortgeschrieben (Spalten inklusive `v`, `edition`, `country`, `features`, `billing`, `interval`, `headline`) |
| `--edition`, `--country` | Ausgabe der Datei (ab v2 Pflicht); Land `DE`, `AT` oder `CH` |
| `--feature` | Feature-Schlüssel, mehrfach möglich (`kunde.musterfirma.export`); ohne das Flag sind alle Funktionen des Builds an |
| `--billing`, `--interval`, `--label` | Vertragsbedingungen, nur Anzeige und Register: Abrechnungsart, Intervall, freier Kurztext, der den erzeugten Satz ersetzt |
| `--headline` | signierte Überschrift des Anbieters (höchstens 120 Zeichen), ersetzt im Zustand gültig die erzeugte Überschrift |
| `--v2` | erzwingt v2 auch ohne weitere v2-Felder |

Das Werkzeug prüft die Eingaben **vor** dem Signieren (Installations-ID
32 Hex oder `-`, `--until`/`--from` echte Kalendertage, `--until` nicht nach
`2999-12-31`, `--seats` ganzzahlig ≥ 1) — ein Tippfehler soll hier
scheitern, nicht erst beim Kunden —, macht nach dem Signieren die Gegenprobe
mit genau der Prüfung, die der Server ausführt, und gibt die Eckdaten aus.
Jede Lizenz erhält eine zufällige `license_id`. Der abschließende Hinweis
nennt den Weg beim Kunden: Datei unter Einstellungen → Lizenz einspielen
oder als `lizenz.ohrganize` ins Datenverzeichnis legen — der Dienst erkennt
sie binnen Sekunden, ein Neustart ist nicht nötig (Abschnitt 2, „Heißes
Nachladen“).

**Das Register** (`--register`, CSV mit Semikolon, Spalten `issued_at;
license_id; kid; customer_id; customer; installation_id; kind; valid_from;
valid_until; grace_days; warn_days; max_users; notice; file`) ist die Sicht
des Anbieters auf „wer hat was bis wann“ — die einzige, denn einen
Rückkanal gibt es nicht. Es gehört mit dem privaten Schlüssel in den Tresor
(es enthält Kundennamen) und ist die Grundlage für die Wiedervorlage vor
dem Ablauf.

### 3.3 Prüfen

```bash
npm run lizenz -- inspect /pfad/lizenz-musterfirma-2027-09-12.ohrganize [--pubkey /pfad/lizenz-oeffentlich-2026-09.pem]
```

zeigt den Inhalt und ob die Signatur gegen die eingebauten Schlüssel (oder
den angegebenen) gültig ist. Beendet sich mit Status 1 bei ungültiger
Signatur — tauglich für Skripte.

## 4. Der Kunde: einspielen, verlängern, berichten

1. **Installations-ID ablesen.** Desktop-App → **Einstellungen → Lizenz**
   zeigt die 32-stellige ID, den Zustand, das Ablaufdatum und die
   Platzbelegung. Dieselben Werte liefert `GET /api/license` (Bereich
   `einstellungen`, `lesen`).
2. **Dem Anbieter mitteilen** — am einfachsten den **Lizenzbericht**
   herunterladen (Einstellungen → Lizenz → Bericht; `GET /api/license/report`,
   Datei `ohrganize-lizenzbericht-<datum>.json`) und mitschicken. Er enthält
   Installations-ID, Lizenz-ID, Zustand, Ablauf, belegte und lizenzierte
   Plätze und die Serverversion — **keine Personendaten**.
3. **Datei erhalten und einspielen.** Einstellungen → Lizenz → Datei wählen
   (technisch `PUT /api/license` mit dem Dateiinhalt als Text; verlangt
   `einstellungen: bearbeiten`; funktioniert auch im Nur-Lese-Betrieb). Die
   Oberfläche zeigt sofort den neuen Zustand; jede Ablehnung nennt den Grund.
   Alternativ die Datei als `lizenz.ohrganize` ins Datenverzeichnis legen
   (Linux `/var/lib/ohrganize`, Windows `C:\ProgramData\oHRganize\data`,
   Rechte wie `secret.key`) — das Backend übernimmt sie innerhalb weniger
   Sekunden ohne Neustart. Jedes Einspielen steht im Audit-Log
   (`license.install`).
4. **Prüfen:** Zustand „gültig“, Ablaufdatum und Platzzahl wie bestellt.

**Verlängerung.** Der Anbieter stellt die neue Datei **nach Zahlungseingang**
aus; ihre Laufzeit ist der bezahlte Zeitraum (`--from` = Tag nach dem
bisherigen Ablauf, `--until` = Ende der neuen Periode). Sie kann jederzeit
vorab eingespielt werden — der Server übernimmt das spätere Ablaufdatum,
ein früheres nie. Die Warnung erscheint `warn_days` (30) Tage vor Ablauf;
das ist der Moment zum Bestellen. Nach `valid_until` bleibt die Kulanzfrist
(14 Tage) mit vollem Funktionsumfang, danach Nur-Lese-Betrieb bis zum
Einspielen — Daten gehen dabei nie verloren.

**Sicherung und Umzug.** `backup.cjs` sichert `lizenz.ohrganize` mit (und
vermerkt im MANIFEST, wenn keine da ist); beim Umzug wandert sie mit dem
Datenverzeichnis. Ohne die Datei startet der Server nach einem Restore im
Zustand `expired` (nicht `trial`, siehe oben) — die Datei ist beim Anbieter
über das Register jederzeit erneut erhältlich.

**Portal-Konten** erfahren vom Vertrag nichts: kein Banner in Testphase,
Warnung oder Kulanz. Erst im Nur-Lese-Betrieb sehen sie einen neutralen
Hinweis, dass Anträge und Änderungen vorübergehend nicht möglich sind.

## 5. Vertrag — Stichworte für die anwaltliche Prüfung, keine Rechtsberatung

Das technische Modell trägt nur, wenn der Vertrag dasselbe sagt. Punkte, die
der Vertragsentwurf abdecken sollte:

- **Befristete Softwaremiete** (§ 542 Abs. 2 BGB): Die Nutzungsüberlassung
  endet mit Ablauf der vereinbarten Zeit; die Laufzeit der Lizenzdatei ist
  die Vertragslaufzeit.
- **Offengelegte Ablaufsperre** (BGH 03.06.1981, VIII ZR 153/80): Der
  Übergang in den Nur-Lese-Betrieb nach Laufzeit plus Kulanzfrist steht
  ausdrücklich im Vertrag — samt dem, was offen bleibt (Einsicht, Export).
  Eine unangekündigte Sperre wäre ein Mangel.
- **Kein Eingriff von außen** (BGH 26.10.2022, XII ZR 89/21): Es gibt
  technisch keine Fernabschaltung; der Vertrag sollte das ebenso festhalten
  wie die Tatsache, dass der Anbieter zur Verlängerung eine Datei ausstellt
  und sonst nichts am System des Kunden tut.
- **§ 545 BGB ausschließen**: Die Weiternutzung während der Kulanzfrist und
  im Nur-Lese-Betrieb ist keine stillschweigende Verlängerung des
  Mietverhältnisses.
- **Keine Sperre bei geringfügigem Zahlungsverzug** (OLG Koblenz 30.09.2010,
  2 U 1388/09): Die Kulanzfrist ist genau dafür da; Ausstellung der
  Verlängerung nach Zahlungseingang, keine vorzeitige Sperre.
- **Auftragsverarbeitungsvertrag** (Art. 28 DSGVO) für jeden Supportzugriff
  auf das Kundensystem — die Lizenz selbst überträgt keine Personendaten,
  der Support möglicherweise schon.
- **Anbieter-Exit**: Was gilt, wenn der Anbieter ausfällt (Insolvenz,
  Geschäftsaufgabe)? Optionen: hinterlegter Signierschlüssel (Escrow) oder
  die Zusage einer letzten, lang laufenden Lizenzdatei, damit die
  Personalakte über die gesetzlichen Aufbewahrungsfristen hinweg bedienbar
  bleibt.

Hintergrund der Entscheidungen (Rückkanal, Nur-Lese statt Sperre,
Wasserzeichen nur als Stolperdraht): `entscheidungen.md`.

## 6. Texte: eine Quelle fuer alle Oberflaechen

Alle Saetze zum Lizenzzustand (Banner, Seite Einstellungen → Lizenz,
Dashboard-Widget, 403-Meldung des Backends, Startlog) entstehen in
`packages/shared/src/licenseText.ts` (`describeLicense`). Die Funktion
liefert Ueberschrift, Detail, Tonlage (`neutral` heisst: kein Banner) und
den Handlungssatz. Beispiele:

| Lage | Ueberschrift |
|---|---|
| Testphase ohne Datei | Testphase bis 15.10.2026, noch 28 Tage. |
| Testlizenz | Testlizenz bis 20.09.2026, noch 3 Tage. |
| unbefristet | Ihre Lizenz läuft unbegrenzt. |
| unbefristet, Abrechnungsart kostenfrei (ab Lizenz v2) | Ihre Lizenz läuft unbegrenzt und kostenfrei. |
| befristet | Ihre Lizenz gilt bis 31.12.2027 (noch 470 Tage). |
| Warnfrist | Ihre Lizenz läuft am 29.09.2026 ab (noch 12 Tage). |
| Kulanz | Ihre Lizenz ist am 12.09.2026 abgelaufen. |
| Nur-Lese | Ihre Lizenz ist am 01.08.2026 abgelaufen; die Kulanzfrist endete am 15.08.2026. |

Der reine Zustandsautomat steht in `apps/backend/src/core/licenseState.ts`
(`deriveLicenseState`, ohne Datenbank und Datei); `core/license.ts` haelt
nur noch Cache, Dateizugriff und die beiden Schreibvorgaenge (`licensed_at`,
`last_seen_date`). Tabellengetriebener Test: `src/test/licenseStateTest.ts`.
