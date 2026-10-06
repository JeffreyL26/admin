# Aenderungsprotokoll

Alle nennenswerten Aenderungen an oHRganize stehen hier, neueste zuerst.
Das Format folgt "Keep a Changelog"; die Versionsnummer folgt Semver
(`1.2.0` ist Kanal `stable`, `1.2.0-beta.1` ist Kanal `beta`). Jede
Version, die mit `scripts/release.mjs` gebaut wird, braucht hier einen
eigenen Abschnitt.

## Unveroeffentlicht

Alles seit 1.0.0. Die Version bleibt 1.0.0, bis der erste Kunde betreut ist;
die datierten Unterabschnitte sind Arbeitsstaende, kein Release. Ein
Versionsabschnitt entsteht erst mit `scripts/release.mjs` (Tag, Manifest).

### Seiten-Einfuehrung "Gehaelter" (06.10.2026)
- **Neu:** Beim ersten Besuch einer Seite startet ihre Einfuehrung: kleine Blasen
  mit farbigem Ring am Ziel, unten rechts pro Seite eine Leiste mit Haken und
  einem Segment je Schritt (Farben der Website-Leiste). Die Schritte haken sich
  ueber die echten Aktionen ab (`tourEvent`); sind alle erledigt, fliegt der
  Haken in die Fenstermitte und leuchtet auf. Fuenf Schritte fuer Gehaelter,
  weitere Seiten tragen sich in `features/tours/registry.ts` und `copy.ts` ein.
- **Ueberspringen** (Leiste, und jeder uebersprungene Schritt des Einrichtungs-
  Assistenten) zeigt eine gruene Meldung mit dem Link "Dokumentation"; er ruft
  dieselbe Aktion wie der Menueeintrag (`lib/docs.ts`). Einfuehrungen lassen
  sich unter Einstellungen → Konto erneut starten.
- **Admin-Konto im Assistenten:** mehrere angelegte Konten werden im Erfolgsmoment
  alle genannt; Platzhalter "Anzeigename"; leeres Foto traegt ein "O".

### Einrichtungs-Assistent fuer neue Installationen (06.10.2026)
- **Neu:** Geführte Einrichtung in sieben Schritten (Firma und Standort,
  Abteilungen, erste Mitarbeitende, Vorgesetzte, Abwesenheitsarten, zweites
  Admin-Konto, Portal-Zugang) als Dialog ueber dem Hauptbereich, mit
  Fortschrittsring, Erfolgsmoment je Schritt, Pause als Launcher unten rechts,
  Hervorhebung des Zieleintrags in der Seitenleiste und Abschlussseite. Er
  oeffnet sich von selbst nur bei einer leeren Installation; sonst bietet das
  Dashboard eine Karte, und ueber Befehlspalette (Strg+K, "Einrichtung") und
  Einstellungen → Konto laesst er sich jederzeit oeffnen.
- **Stand aus den Daten:** `GET /api/setup/status` liefert nur Zaehlungen, je
  Block nach Recht gefiltert (gesperrte Bloecke fehlen). Wer einen Schritt
  ueber die normalen Seiten erledigt, sieht ihn im Assistenten erledigt. Nur
  Pause, Ausblenden und "Abwesenheit bestaetigt" liegen je Konto im
  localStorage (`ohrganize.setup.<Installation>.<Konto-ID>`).
- **Schritte nach Recht:** Es erscheinen nur Schritte, die das Konto
  bearbeiten darf und die Variante und Lizenz mitbringen.
- **Wiederverwendet statt nachgebaut:** Schritt 3 oeffnet das vorhandene
  Formular "Mitarbeiter:in anlegen" (neues Prop `onCreated`), Schritt 6 und 7
  die Konto-Dialoge der Benutzerverwaltung (jetzt exportiert, `AccountDialog`
  mit `fixedRole`). Das Erstpasswort lebt nur im Dialog.
- **Texte:** alle Wortlaute stehen in `features/setup/copy.ts`.
- **Portal-Zugang zaehlt jedes Konto mit Personalprofil**, auch ein Admin-Konto
  (gleiche Zugangsdaten). Im Dialog "Konto anlegen" sind Profile, die schon ein
  Konto haben, ausgegraut (Tooltip erklaert warum), und der Name folgt dem
  gewaehlten Profil, solange er nicht selbst getippt wurde. `Select` kennt
  dafuer `data-hint` an gesperrten `<option>`.
- **Initialen** bestehen aus erstem und letztem Wort des Namens
  (`nameInitials` in shared): "Bianka Marthina Simon" ergibt "BS" (Desktop,
  Organisationsseite, Portal).

### Dateien verknuepfen nur mit Leserecht, Mitarbeiterfoto nur aus eigenem Bild-Upload (05.10.2026)
- **Sicherheit, Verknuepfen:** Dokumente, Vertraege, AU-Bescheinigungen,
  Trainingszertifikate, Freelancer-Rechnungen, Vorlagen, Ankuendigungs-
  anhaenge, Bewerberfotos und Lebenslaeufe nahmen jede Datei-ID an. Eine
  Rolle ohne `verguetung` konnte so eine Entgeltbescheinigung als Dokument
  anhaengen und danach lesen (beim Signieren genuegt ein Bereich) oder sie
  als Anhang an alle Mitarbeitenden verteilen. Jetzt verlangt jede dieser
  Routen, dass das Konto die Datei lesen darf (`assertMayLinkFiles`, sonst
  403; eine unbekannte ID gibt 404, wo die Route sie nicht schon selbst
  abweist, statt bisher teils eines Serverfehlers). Auch das Austauschen der
  Datei eines bestehenden Dokuments (`PATCH /api/documents/:id`) ist erfasst.
  Eigene Uploads, dieselbe lesbare Datei an mehreren Datensaetzen und
  erneutes Speichern mit unveraenderten Anhaengen gehen wie bisher.
  `src/test/fileLinkCheck.ts` (Teil von `npm test`) prueft statisch je
  Route, dass jedes Datei-ID-Feld eines Request-Schemas (auf jeder Ebene
  deklariert, abgeleitet oder eingebettet, auch in eingekapselten Plugins)
  durch die Pruefung geht.
- **Sicherheit, Mitarbeiterfoto:** `photo_file_id` und `photo_thumb_file_id`
  nahmen jede Datei-ID an. Mit `personal: bearbeiten` liess sich so eine
  Entgeltbescheinigung oder Ausweiskopie als Foto eintragen, und Organigramm,
  Verzeichnis (auch im Portal) und Fuehrungslisten signierten sie fuer alle,
  die die Person sehen. Beim Anlegen und Aendern einer Person muss eine neue
  Foto-ID jetzt ein Bild (`mime_type` image/...) sein, das dasselbe Konto
  hochgeladen hat und das noch nirgends verknuepft ist (`assertUsableAsPhoto`
  in `core/files.ts`, sonst 400). Unveraenderte IDs bleiben zulaessig, eine
  unbekannte ID gibt 400 statt eines Serverfehlers. Bestehende Eintraege
  werden nicht nachtraeglich geprueft. Die Fotoauswahl im Personalformular
  weist Nicht-Bilder schon vor dem Hochladen ab (`PhotoPicker imageOnly`).

### Leistung (05.10.2026)
Ergebnis einer Performance-Pruefung mit synthetischem Bestand (2000 Personen,
sechs Jahre Historie, verschluesselt wie im Betrieb). Zurueckgestellt und in
`docs/offene-punkte.md` vermerkt: PERF-1 (Backend der Desktop-App im
Electron-Hauptprozess) und PERF-2 (Saldo-Uebersicht, Abrechnungslaeufe,
Gehaltsuebersicht).
- **Audit in derselben Transaktion:** Jede fachliche Aenderung und ihr
  Audit-Eintrag werden gemeinsam geschrieben (rund 160 Stellen in allen
  Modulen). Vorher zwei Commits: Stuerzte der Prozess dazwischen ab, blieb die
  Aenderung ohne Protokolleintrag. Ein Commit spart zudem einen fsync je
  Aenderung. Dateien werden erst nach dem Commit von der Platte entfernt
  (`detachUnreferencedFile`/`removeDetachedBlob`). Mehrere Schreibschritte
  einer Route (Timeline, Interviews, Versionskette, Einstellungen) laufen
  jetzt ebenfalls zusammen. `audit()` wirft ausserhalb einer Transaktion,
  Eintraege ohne fachliche Aenderung (Anmeldung, Fehlversuch, Signatur,
  Lizenzdatei) laufen ueber `auditStandalone()`, und
  `auditTransactionCheck.ts` in `npm test` prueft jede Stelle statisch. Im
  Betrieb (gebuendelt) schreibt ein solcher Aufruf den Eintrag trotzdem und
  meldet den Fehler im Log.
- **Behoben:** Beim Aendern einer Admin-Rolle lief die Pruefung "mindestens
  ein Konto mit Benutzerverwaltung" erst nach dem Speichern; ein 409 liess
  die Aenderung trotzdem stehen.
- **Mitarbeiterliste:** Ein Tastendruck im Suchfeld zeichnet die Tabelle nicht
  mehr neu (vorher jede Zeile je Taste); die Ergebnisse aktualisieren sich wie
  bisher nach der Entprellung.
- **Indizes** (Migrationen 006, 110, 205, 312, 331, 402, 505, 601, 701):
  Kalender, Dashboard und Portal-Kalender lesen nicht mehr alle genehmigten
  Antraege seit Inbetriebnahme (`(status, date_to)` statt des reinen
  Statusindex; Portal-Kalender 6,5 statt 33 ms ohne Verschluesselung). Alle
  Dateiverweise (Signatur, Aufraeumen; Person loeschen 25 statt 856 ms) und
  Kontoverweise (Konto loeschen dauerte 12 s bei 500 000 Audit-Zeilen) haben
  einen Teilindex, ebenso Fuehrungsbewertungen je Zeitraum und Kategorie,
  Anhaenge je Ankuendigung und Massnahmen je Gespraech. Es wird nichts
  geloescht oder gefiltert.
- **Seitencache** der Dienstverbindung 64 MB statt 16 MB, gesetzt nach den
  Migrationen (Portal-Kalender 38 statt 130 ms, Abrechnungsliste 35 statt
  320 ms bei verschluesselter Datenbank).
- **Listen:** "Alle Antraege" und die Dokumentablage laden in Seiten zu 100
  (vorher 109 MB bzw. 20 MB am Stueck; jetzt 3 bis 45 ms je Seite). Antraege
  und Krankmeldungen zeigen als Vorgabe das laufende Jahr, "Alle Jahre" bleibt
  waehlbar; die ganze Historie ist ueber die Seiten erreichbar. Der Sprung aus
  dem Kalender oeffnet die Seite des Antrags. Die Karte "Entgeltfortzahlung
  ueberzogen" folgt dem gewaehlten Jahr. Der Krankmeldungsdialog laedt nur die
  Krankmeldungen der gewaehlten Person; Zaehlung der Krankmeldungen und
  Bonusliste ohne Abfragen je Zeile; die Befehlspalette laedt nur fuenf
  Dokumenttreffer.
- **Sitzungen:** Die Desktop-App bleibt bis zum Schliessen oder Logout
  angemeldet (Token in sessionStorage, Verlaengerung nach 10 Minuten ueber
  das neue `POST /api/auth/refresh`, Laufzeit `OHRGANIZE_DESKTOP_TOKEN_TTL`,
  Vorgabe 3 Tage, zaehlt nur bei schlafendem Rechner). Das Portal bleibt bei
  Aktivitaet angemeldet und meldet nach 60 Minuten ohne Eingabe mit Hinweis
  ab. Beide Clients lesen die Laufzeit aus dem Token und verlaengern
  spaetestens nach der halben; eine kurz eingestellte Laufzeit meldet also
  niemanden mehr nach wenigen Minuten ab. Jede Sitzung endet nach einer
  Hoechstdauer ab der Anmeldung (`OHRGANIZE_SESSION_MAX`, Vorgabe 6 Stunden
  im Portal; `OHRGANIZE_DESKTOP_SESSION_MAX`, Vorgabe 5 Tage am Desktop),
  danach mit Hinweis auf der Anmeldeseite, im Portal in allen offenen Tabs.
  Zehn Minuten vorher kuendigt ein Banner das Ende samt Uhrzeit an, damit
  offene Eingaben gespeichert werden koennen. Ein abgegriffenes Token laesst
  sich so nicht beliebig lange verlaengern. Nach dem Update ist am Desktop einmal eine neue Anmeldung noetig; nach
  einem Neustart der App ebenfalls (vorher ueberlebte das Token ihn bis zu
  einer Stunde).
- **`OHRGANIZE_TOKEN_TTL`:** Eine nackte Zahl gilt jetzt als Sekunden (vorher
  las @fastify/jwt sie als Millisekunden), `0` verhindert den Start (vorher
  Tokens ohne Ablauf).
- **Anmeldung blockiert den Prozess nicht mehr:** bcrypt rechnet in einem
  Worker-Pool (`dist/password-worker.cjs`, liegt neben `server.cjs`/`cli.cjs`,
  Rueckfall synchron). Die Drosselung zaehlt laufende Versuche je Konto
  vorab, sonst kaemen parallele Fehlversuche an der Schwelle vorbei. Je IP
  zaehlen Fehlversuche erst mit dem Ergebnis, laufende Anmeldungen aber gegen
  dieselbe Schwelle (50): Auch ein paralleles Buendel rechnet hoechstens 50
  Vergleiche, und 50 gleichzeitige Anmeldungen hinter einem Firmen-NAT
  gelingen alle. Abgewiesene Kontoanlagen und Passwort-Ruecksetzungen
  (unbekanntes Konto, hoeherer Rang) kosten keinen bcrypt-Lauf mehr.
- **Mitarbeiterfotos:** Vorschaubild beim Hochladen (512 px, WebP), das
  Original bleibt fuer die Schaerfe beim Vergroessern. Listen und Karten laden
  nur sichtbare Fotos, Fotolinks in Listen bleiben 10 Minuten gleich, ein
  Refetch laedt keine Fotos neu (vorher bei 2000 Handyfotos Gigabytes je
  Seitenaufruf). Ein abgelaufener Link laedt nur die Liste neu, die ihn
  geliefert hat. Das Organigramm bestimmt die Karten fuer Originalfotos erst,
  wenn die Ansicht kurz stillsteht, und holt deren Links erst dann ueber
  `GET /api/org/chart/originals` (vorher eine Audit-Zeile je Karte bei hohem
  Zoom).
- **Fuehrung:** Report, Teamansicht und "Mein Team" loesen Zustaendigkeiten je
  Anfrage nur einmal auf (Teamansicht der Geschaeftsfuehrung bei 1000
  Personen 72 statt 2916 Abfragen); Antworten unveraendert.
- **Umfragen:** Die Auswertung einer beendeten Umfrage haelt der Prozess, statt
  bei jedem Abruf alle Antworten aller Umfragen zweimal zu lesen; bei einer
  beendeten Umfrage unter der Mindestteilnahme die Zahl der Antworten. Es
  bleiben die zuletzt benutzten 20.
- **Abwesenheitskalender (Desktop):** Die Tageszellen tragen ihren Tooltip nur
  noch an Tagen mit Inhalt (Feiertag, Betriebsruhe, Konflikt) statt leer an
  jeder Zelle. Die Tooltips der Abwesenheitsbalken (Art, Status, Zeitraum,
  Tage) und der Jahreskacheln bleiben unveraendert.
- **Geldbetraege:** `formatMoney` haelt einen Formatierer je Sprache und
  Waehrung (vorher bei jedem Aufruf neu, eine Gehaltsliste mit 2000 Zeilen
  kostete rund eine Sekunde je Neuzeichnen).

### Nachbesserungen zur Verschluesselung (05.10.2026)
- **Windows-Update:** `update-server.ps1` wartet auf das Ende eines NEUEN
  Sicherungslaufs und bricht ab, wenn dessen Ergebnis nicht 0 ist, noch
  bevor der Dienst angehalten wird (bisher lief es mit einer fehlgeschlagenen
  Sicherung weiter in die einseitige Umstellung). `setup-server.ps1` wartet
  beim ersten Start bis zu 15 Minuten statt 30 Sekunden.
- **Modul ohne Verschluesselung:** Ein SQLite-Modul, das nicht verschluesseln
  kann (Fremdmodul nach `npm install` statt `npm ci`), ist ein Startabbruch
  (`CipherUnavailableError`, geprueft vor Schluessel und Vermerk), auch auf
  einem Klartextbestand; vorher lief der Dienst mit Klartext weiter. Die
  Lade-Proben in `ohrganize-update.sh`, `update-server.ps1` und
  `setup-server.ps1` pruefen jetzt `PRAGMA cipher`.
- **Umfragen, grosse Antworten:** Ab einem Achtel der Seitengroesse (512 Byte)
  nimmt eine Teilnahme 256 zufaellige Antworten aus der ganzen Tabelle in das
  gemischte Neuschreiben auf (`REWRITE_SAMPLE_ROWS`; eine kleinere Tabelle
  ganz). Die Nachbarschaft allein liess bei Antworten ab etwa 700 Byte die
  Seitenvergabe die Teilnahmereihenfolge verraten (gemessen: 40 bis 76 Prozent
  Treffer gegen 2 bis 10 bei Zufall; nach der Aenderung wie Zufall). Aufwand
  je Teilnahme 35 bis 100 ms, unabhaengig von der Umfragegroesse. Eine Erfassung
  der HR nach dem Enddatum streicht den Ablaufvermerk, damit der naechste
  Durchlauf ihre Kopien ebenfalls raeumt.
- **Dateiablage:** Eine Kennung mit unbekannter Fassung (neuere Programm-
  fassung, gekipptes Bit im letzten Kennungsbyte) gilt als beschaedigt und
  wird weder ausgeliefert noch umgestellt (vorher als Klartext ausgeliefert
  und ein zweites Mal verschluesselt). Eine gescheiterte Umstellung nennt im
  Journal Datei und Grund. Nicht geaendert: die Dateikennung bindet den
  gespeicherten Namen nicht in die Authentisierung (Formatwechsel; ausserhalb
  des Bedrohungsmodells: Schreibzugriff auf `storage/` ohne `data.key`).
- **`data.key`:** Das Verzeichnis wird nach dem Einhaengen durchgeschrieben;
  `config.ts` raeumt `data.key.*.neu` nur noch auf, solange `data.key` steht
  (fehlt es, kann die Zwischendatei die einzige Kopie sein); ein Rest der
  Zwischendatei macht den Start nicht mehr zum Fehler. Die Umstellung setzt
  den Journalmodus DELETE unter der Sperre erneut.
- **Loeschen und Ersetzen:** Bewerber (Foto, Lebenslaeufe), AU-Bescheinigung,
  Trainingszertifikat, Vorlagen und Mitarbeiterfoto raeumen ihre Datei ab,
  wenn sie geloescht oder ersetzt werden und nirgends sonst verknuepft sind.
  `deleteFileIfUnreferenced` wirft nach dem Commit nicht mehr (ein Fehler beim
  Entfernen des Blobs liess die Bescheinigungsloeschung ohne Audit-Eintrag).
- **Hosting:** `ohrganize-backend@.service` und `ohrganize-backend.service`
  setzen `RestartSec=30`, `StartLimitIntervalSec=600` und
  `StartLimitBurst=10`: Ein Start, der immer scheitert (etwa die Pruefung nach
  der Umstellung), laeuft nicht mehr endlos im Fuenf-Sekunden-Takt, sondern
  endet nach etwa fuenf Minuten; kurze Ausfaelle heilen sich in dieser Zeit. Auf einem bestehenden Host wirkt das erst
  mit neu kopierter Vorlage (`deploy/README.md`, Abschnitt 9.6); danach
  `systemctl reset-failed ohrganize-backend@<kunde>` und neu starten. Die
  Ruecknahme in `ohrganize-update.sh` legt die verworfene Datenbank (samt
  `-wal`) und `storage/` als `.verworfen-<zeit>` beiseite, statt sie zu
  ueberschreiben.
- **Startlimit und Skripte:** `ohrganize-provision.sh` (fortsetzen, restore) und
  `ohrganize-update.sh` starten das Backend ueber `backend_starten`
  (`ohrganize-lib.sh`), das vorher `systemctl reset-failed` ausfuehrt; sonst
  lehnt systemd nach einem Dauerfehler jeden Start ab (`Start request repeated
  too quickly`), und ein Restore innerhalb der naechsten zehn Minuten liess den
  Dienst gestoppt zurueck. Die Restore-Schritte im README tragen den Aufruf
  ebenfalls. Die Units haben jetzt `RestartSec=30` und `StartLimitBurst=10`.
- **Ersetzen von Dateien:** Das Ersetzen oder Entfernen einer Datei an einer
  Krankmeldung, einer Trainingsanmeldung, einer Vorlage oder am
  Mitarbeiterfoto loescht die alte Datei endgueltig; der Audit-Eintrag der
  Aenderung nennt sie jetzt (`removed_file`: ID und Pruefsumme, kein Dateiname,
  `removeReplacedFile` in `core/files.ts`). Wer das Ersetzen nicht
  destruktiv will, ruft an diesen Stellen `deleteFileIfUnreferenced` nicht auf.
- Kleinigkeiten: Die Desktop-App zeigt bei einem Startabbruch des Backends nur
  den Text, nicht den Stack (der geht ins Log). Das MANIFEST der Sicherung nennt
  `secret.key` nur, wenn es mitgesichert wurde.

### Verschluesselung im Ruhezustand, anonyme Umfragen (04.10.2026)
- Datenbank (`ohrganize.db` samt WAL), die Dateien in `storage/` und damit
  jede Sicherung liegen verschluesselt auf der Platte: Datenbank im
  SQLCipher-4-Format, Dateien mit AES-256-GCM. Der Schluessel steht in
  `data.key` im Datenverzeichnis und entsteht beim ersten Start; ein Bestand
  aus einer aelteren Fassung wird beim ersten Start umgestellt (Datenbank
  sofort, Dateiablage im Hintergrund). Bedienung, Routen und Oberflaeche sind
  unveraendert.
- **Fuer den Betrieb:** `data.key` gehoert zu jeder Sicherung und zu jedem
  Restore (das Sicherungsskript, `ohrganize-provision.sh restore` und das
  MANIFEST beruecksichtigen sie). Ohne sie ist der Bestand nicht lesbar. Ein
  Zurueck auf eine aeltere Fassung geht nur ueber den vollstaendigen Restore
  einer Sicherung von davor.
- Optional kann `data.key` auf eine Schluesseldatei ausserhalb des
  Datenverzeichnisses verweisen (`extern:<absoluter Pfad>`); die Sicherung
  enthaelt dann nur den Verweis und kein `secret.key`.
- `better-sqlite3` ist jetzt ein npm-Alias auf
  `better-sqlite3-multiple-ciphers` gleicher Version (Fertigpakete fuer
  dieselben Node- und Electron-Fassungen). Sicherung und Migrations-Probelauf
  kopieren die Datenbank mit `VACUUM INTO` statt ueber die
  Online-Backup-Schnittstelle.
- Jede API-Antwort traegt `Cache-Control: no-store`: Antworten mit
  Stammdaten, Gehaeltern oder Exporten landen nicht mehr im Cache des
  Browserkerns auf der Platte.
- Eine geloeschte Bescheinigung entfernt jetzt auch ihre Datei aus dem
  Storage; bisher blieb sie liegen und fuer das anlegende Konto abrufbar.
- Hosting: Eine Kundeninstanz sieht die Sicherungen der anderen nicht mehr
  (`InaccessiblePaths` in `ohrganize-backend@.service`). Auf einem
  bestehenden Host wirkt das erst, wenn die Vorlage von Hand neu kopiert ist;
  das Update-Skript zieht Unit-Vorlagen nicht nach (`deploy/README.md`,
  Abschnitt 9.6).
- **Umstellung der Datenbank beim ersten Start:** an Ort und Stelle in einer
  Transaktion (`PRAGMA rekey`), die Datei ist dabei exklusiv gesperrt, davor
  und danach `quick_check`. Ein Abbruch an beliebiger Stelle wird beim
  naechsten Oeffnen zurueckgespielt (gemessen an ueber 60 Abbruchstellen unter
  Linux und Windows). Scheitert die Umstellung, auch weil der Bestand schon
  vorher die Pruefung nicht besteht, laeuft der Dienst unveraendert weiter und
  versucht es beim naechsten Start. Scheitert nur die Pruefung danach,
  startet er nicht: Der Vermerk `umstellung-pruefung-gescheitert.txt` entsteht
  vor dem Umschluesseln und faellt erst nach bestandener Pruefung weg; jeder
  Start mit Vermerk prueft erneut, und nach dem Zurueckspielen der Sicherung
  von vor dem Update erledigt er sich mit dem naechsten Start von selbst;
  `status.cjs` und `provision.sh check` melden ihn. Hilfsdateien von SQLite
  entstehen bei verschluesselter Datenbank nur im Arbeitsspeicher (SQLite
  verschluesselt sie nicht; ein VACUUM legte sonst eine Klartextkopie ab),
  bei einem unverschluesselten Bestand in `.sqlite-tmp` im
  Datenverzeichnis. Jede Verbindung loescht mit `secure_delete` (Geloeschtes
  wird mit Nullen ueberschrieben, auch ueber Kaskaden); das VACUUM nach
  Migrationen entfaellt ueber 300 MB Nutzdaten mit Warnung, ohne dass
  entfernte Umfragedaten in der Datei bleiben. Verwaiste Umfragezeilen
  (Umfrage oder Person fehlt) uebernimmt Migration 502 nicht. `data.key`
  entsteht atomar.
- **Dateiablage:** AES-256-GCM in Abschnitten zu 64 KiB; ein Download prueft
  jeden Abschnitt, bevor er hinausgeht, den ersten vor den Kopfzeilen. Der
  Bestand wird nach dem Start im Hintergrund umgestellt (Zwischendateien in
  `storage/.umstellung`), danach prueft jeder Start die Dateien, deren
  Fingerabdruck (Datei-ID, Groesse, mtime) sich seit der letzten Pruefung
  geaendert hat, auch einzeln aus einer Sicherung zurueckgelegte. Eine Datei,
  die waehrend ihrer Umstellung geloescht wird, bleibt geloescht; ein gerade
  beginnender Upload wird nicht angefasst.
  Verschluesselt geschrieben wird erst, wenn die Datenbank verschluesselt ist.
- **Sicherung:** prueft die laufende Datenbank vor dem Kopieren
  (`quick_check`), kopiert per `VACUUM INTO`, nimmt `data.key` mit und nennt
  im MANIFEST nur, was sie enthaelt, samt dem tatsaechlichen Stand von
  `storage/` (auch abgeschnittene Dateien unter Linux, die Kopie behaelt die
  Zeitstempel); unter Windows die PowerShell-Schritte. Eine unbrauchbare
  `data.key` haelt die Sicherung eines noch unverschluesselten Bestands nicht
  auf.
- **Betreiberskripte:** `status.cjs` und `provision.sh check` melden den
  Verschluesselungszustand sowie unverschluesselte, abgeschnittene und nicht
  lesbare Dateien. Die Ruecknahme in `ohrganize-update.sh` spielt Datenbank
  (erst daneben kopieren, dann tauschen) und `storage/` aus derselben
  Sicherung zurueck, jeder Schritt einzeln geprueft. Beide Update-Skripte
  warten auf den ersten Start bis zu 15 Minuten (gemessene Zeit), solange
  der Dienst laeuft, und brechen bei einem Absturz sofort ab (eine leere
  Antwort von `systemctl` gilt nicht als Absturz). `update-server.ps1` nennt
  bei einer gescheiterten Ruecknahme Migration und Umstellung als Grund. Der
  Migrations-Probelauf laesst das VACUUM aus. `update-server.ps1` findet
  `better-sqlite3` beim Probelauf ueber `NODE_PATH` (vorher brach jedes
  Update ab). Die Anleitung zum Kopieren der Unit-Vorlage nutzt
  `systemctl try-restart` (pausierte Instanzen bleiben aus).
- Am Deployment selbst (Subdomain, Zertifikat, Proxy, Einrichtung) aendert
  sich nichts. Noch offen ist der Durchlauf ueber `ohrganize-provision.sh`,
  `ohrganize-update.sh` und die Windows-Skripte mit einem Archiv dieser
  Fassung; geprueft sind bisher die Einzelschritte (`deploy/README.md`,
  Abschnitt 9.7).
- **Umfragen sind auch gegenueber der Datei anonym:** Antworten ohne
  Zeitstempel und unter zufaelliger 48-Bit-ID, Teilnahmen ohne Zeitstempel
  (Migrationen `502_survey_anonymity` und `503_survey_response_ids`, stellen
  auch den Bestand um; vorher liess sich die n-te Teilnahme der n-ten Antwort
  zuordnen). Jede Teilnahme schreibt die Nachbarschaft der neuen Antwort
  gemischt neu und leert danach das `-wal` samt Seitenliste der `-shm`, ohne
  auf Leser zu warten; das Beenden einer Umfrage baut die Antworttabelle neu
  auf, sofern seit dem letzten Neuaufbau Antworten hinzukamen, ebenso eine
  Umfrage, die ohne Beenden ueber ihr Enddatum hinaus laeuft (einmal je Umfrage; Status bleibt;
  Zustand in `_survey_rebuild_state`, Migration `504_survey_rebuild_state`;
  kein VACUUM; ein gescheiterter Neuaufbau wird beim naechsten Start
  nachgeholt). Ein Leeren, das ein Neustart unterbricht, holt der naechste
  Start nach. Die HR-Testerfassung
  prueft die Antworten vor der Doppelteilnahme. Freitextantworten erscheinen
  in der Auswertung bewusst nicht mehr in der Reihenfolge der Abgabe (die
  waere genau die geschlossene Luecke).

### Release-Signatur (01.10.2026)
- `scripts/release.mjs` entfernt vor dem Schreiben des Manifests eine
  `release.json.sig` aus einem frueheren Lauf derselben Version. Bisher fragte
  ssh-keygen nach dem Ueberschreiben, brach ohne Antwort ab und endete mit 0:
  Die alte Signatur blieb neben dem neuen Manifest, und erst
  `update-server.ps1` bzw. conspectus lehnten sie ab. Nach dem Signieren
  prueft das Skript die Signatur gegen `deploy/ohrganize-release.allowed_signers`
  wie die Gegenstellen.

### conspectus: Versionen, laufende Lizenz, Eingespielt-Vermerk (01.10.2026)
- `check` bestimmt das juengste Release nach Semver (1.10.0 nach 1.9.0) und
  meldet nur Instanzen, die AELTER sind. Ob eine Instanz Beta faehrt, folgt
  aus ihrer Version; eine Beta wird auch mit dem fertigen Release verglichen.
  Leere Health-Felder ueberschreiben Version und Kanal nicht mehr.
  `release liste` sortiert ebenfalls nach Semver.
- Je Instanz unterscheidet das Register die AUSGESTELLTE Lizenz (zuletzt
  ausgestellt, nicht zurueckgezogen; Grundlage fuer `verlaengern`) und die
  LAUFENDE (zuletzt gemeldet oder vermerkt, Spalte
  `instanzen.laufende_lizenz`). Ablaufwarnung, `lizenz faellig` und die
  Uebersichten richten sich nach der laufenden: Eine ausgestellte, aber nicht
  eingespielte Verlaengerung blendet den Ablauf der laufenden nicht mehr aus,
  eine nie eingespielte Evaluation meldet keinen falschen Ablauf. Meldet die
  Instanz eine andere als die schon eingespielte ausgestellte, zaehlt das
  fruehere der beiden Enden, damit keine Ablaufwarnung verdeckt wird. `check`
  meldet, wenn eine Instanz nach einem Restore wieder eine aeltere Lizenz
  faehrt oder eine unbekannte oder zurueckgezogene meldet, und nun auch
  ungebundene Lizenzen, die nicht eingespielt sind. Dateien desselben Tages
  ordnet ein Ausstellzeitpunkt (`lizenzen.ausgestellt_um`).
- Neu `lizenz eingespielt <instanz> [--lizenz <nummer>] [--am JJJJ-MM-TT]`
  zum Nachtragen von Hand (`--am` ein echter Kalendertag zwischen Ausstellung
  und heute) und `lizenz zurueckziehen <nummer>` fuer nie eingespielte
  Dateien. Vermerke tragen den lokalen Kalendertag.
- `bericht importieren` liest auch den Lizenzbericht der Desktop-App und
  lehnt Berichte ab, die zu einer anderen Instanz gehoeren (fremde
  Installations-ID, Lizenz einer anderen Instanz, anderer Kunde). Eine
  Ablehnung aus einem Hostbericht bleibt an der Instanz vermerkt und
  erscheint in `check`, bis ein passender Bericht mit Kennung kommt oder
  `instanz id` die Kennung neu setzt. Eine neue Installation bestaetigt
  `--neue-installation`, bei `status --host` nur fuer die genannte Instanz;
  `check` meldet danach Lizenzen, die noch an die alte Installation gebunden
  sind, und raet zum Einspielen, wenn die passende schon ausgestellt ist,
  sonst zu einer neuen mit dem Ende der zuletzt ausgestellten.
  `--instanz` waehlt aus einem Sammelbericht nur den passenden Eintrag und
  nennt sonst, welche er enthaelt.
- Es gilt der zuletzt eingelesene Bericht, ohne Zeitstempel-Abgleich; wird
  ein aelterer nach einem neueren eingelesen, zeigt `check` die Abweichung,
  der neueste noch einmal eingelesen behebt sie. Beim Lizenzbericht zaehlt
  sein Erzeugungstag als Tag des Einspielens.
- `lizenz ausstellen --ungebunden` gilt auch, wenn die Installations-ID
  bekannt ist. Optionen verstehen auch die Form `--name=wert`.

### Hosting: Release-Auswahl beim Anlegen (01.10.2026)
- `ohrganize-provision.sh anlegen` waehlt das neueste STABILE Release
  numerisch und liest die Version aus `release.json` statt aus dem
  Ordnernamen; eine Beta nur mit `--release`. Die Auswahl steht jetzt in
  `ohrganize-lib.sh` und wird von `scripts/test-deploy.mjs` geprueft (Teil
  von `npm test`, einzeln `npm run test:deploy`; unter Windows mit der
  Git-Bash, ein anderer Ort ueber `OHRGANIZE_BASH`).

### Gespraechsprotokolle fuer Fuehrungskraefte (29.09.2026)
- Die Sichtbarkeit „HR und Fuehrungskraefte“ wirkt jetzt: Die zustaendige
  Fuehrungskraft liest unter „Mein Team“ (Bewertungsseite der Person) die
  Protokolle der Stufen `hr_vorgesetzte` und `hr_vorgesetzte_mitarbeiter`,
  nur lesend und nie „Nur HR“. Neue Routen
  `GET /api/leadership/me/employees/:id/meetings` und
  `GET /api/leadership/me/meetings/follow-ups`; „Mein Team“ zeigt zudem die
  Karte „Faellige Wiedervorlagen“, sobald es welche gibt.
- Zustaendig ist allein `scopeFor` (heutiger Bereich): Eine neue Fuehrungskraft
  sieht auch aeltere freigegebene Protokolle ihrer Leute, wer nicht mehr
  zustaendig ist, sieht nichts mehr.
- HR-Editor der Protokolle nennt beim Erfassen die Fuehrungskraefte, die das
  Protokoll heute erreicht (`GET /api/communication/meetings/recipients`), und
  warnt, wenn keine davon „Mein Team“ oeffnen kann (auch bei Ladefehler).
  Die Zustaendigkeitsquellen sieht dort nur, wer `fuehrung: lesen` hat. Labels
  und Hinweise der Stufen ohne „noch ohne eigene Ansicht“, Badge „Fuer Fuehrung
  sichtbar“, neutrale Bezeichnung „Person“ bzw. „Mitarbeitende“ statt der
  Gender-Schreibweise. Varianten ohne Fuehrung versprechen keine
  Fuehrungsansicht.
- Selbstschutz in der Fuehrungsverwaltung: Niemand schaltet das eigene Profil
  frei oder erweitert die eigene Zustaendigkeit (403); sonst oeffnete
  `fuehrung: bearbeiten` die Protokolle ohne Recht `kommunikation`. Was den
  eigenen Bereich nur verkleinert (Automatik aus, Ausnahme, Ergaenzung
  entfernen, Notiz, Entziehen), bleibt erlaubt; die Einrichtung zeigt das.
- Selbstschutz beim Lesen: Wer die Zustaendigkeit selbst formen oder die
  eigenen Rechte danach senken kann (`personal`, `verwaltung`, `fuehrung`,
  `recruiting` oder `benutzer` auf bearbeiten), sieht Protokolle unter
  „Mein Team“ nur mit `kommunikation: lesen` (`/me/status`:
  `protocols_readable`). Der Editor zaehlt solche Konten nicht als erreicht
  (`can_read`).
- Rang eines Kontos (`core/accountRights.ts`): Ein Desktop-Konto mit
  freigeschaltetem Profil zaehlt in der Benutzerverwaltung mit
  `fuehrung: bearbeiten` und `kommunikation: lesen`. Zuruecksetzen,
  Verknuepfen, Loesen, Rolle aendern und Loeschen verlangen diese Rechte.
  Jedes Konto merkt sich die Rechte der Person, die sein Passwort zuletzt
  ausgegeben hat (Migration `005_credentials_issuer`, auch beim
  Betreiberwerkzeug `admin-reset`). Bekommt ein Konto mehr Rechte (Rolle
  zuweisen oder erweitern, Profil verknuepfen oder freischalten, Herabstufung,
  die das Lesen der Protokolle oeffnet), muss diese Person sie gehabt haben,
  sonst 409 mit der Bitte, das Passwort zuerst neu auszugeben. Die
  Freischaltung gibt kein Passwort mehr heraus.
- Empfaengerliste im Protokolleditor: Vorauswahl der moeglichen
  Fuehrungskraefte statt `scopeFor` fuer alle, dazu Indizes auf Vorgesetzte,
  Team und Leitungen (Migration `311_leadership_scope_indexes`).
- Sichtbarkeit zentral: `MEETING_VISIBILITY_READERS` (shared) bestimmt, welche
  Stufe Fuehrung und Person erreicht; Portal, Fuehrung und HR-Oberflaeche
  leiten sich daraus ab. `/me`-Routen der Fuehrung laufen ueber
  `registerLeaderRoutes`.
- Portal: Die Seite Gespraechsprotokolle sagt, dass die zustaendigen
  Fuehrungskraefte die freigegebenen Protokolle ebenfalls sehen.
- Die Routen haengen an den Modulen Fuehrung UND Kommunikation
  (`leaderMeetingRoutes`, Verdrahtung mit `requires`).

### Durchgaengigkeitspruefung aller Module (22.09.2026)
- Betriebsruhe rechnet ueberlappende Antraege neu, storniert aber nie:
  vollstaendig abgedeckte Antraege stehen mit 0 Tagen und Kennzeichnung
  „Betriebsruhe“ in den Listen, Krankmeldungen bleiben erhalten, und das
  Loeschen der Betriebsruhe rechnet die Tage zurueck. Die Kennzeichnung
  kommt als `closure_covered` vom Backend und steht ueberall, wo Tage
  erscheinen (Antraege, Krankmeldungen, Personalakte, Kalender,
  Portal-Uebersicht). Krankmeldungen lassen sich auch vollstaendig in einer
  Betriebsruhe oder am Wochenende erfassen. Ob die Betriebsruhe die 0
  verursacht, entscheidet der Server beim Zaehlen und speichert es
  (Migration `204_absence_closure_covered`); eine 0 vom Wochenende bleibt 0.
  Abgelehnte und stornierte Antraege bleiben bei einer nachtraeglichen
  Betriebsruhe unangetastet; nur solche, die wegen einer Betriebsruhe auf 0
  stehen, bekommen beim Loeschen der Betriebsruhe ihre Tage zurueck.
- Vertragsspiegelung: Ein Vertrag, der nur Urlaubstage aendert, scheitert
  nicht mehr an zu hohen Altstunden der Personalakte.
- Sackgassen geschlossen: Gespraechsprotokolle mit Sichtbarkeit
  „HR + Vorgesetzte + Mitarbeiter:in“, Ziele, Trainings, Gespraeche,
  und Skills erreichen das Portal (ohne Vorgesetztenbewertung und HR-Notizen)
  (`/gespraeche`, `/entwicklung`); Verzeichnis im Portal (`/kollegen`)
  mit derselben Feldsichtbarkeit wie in der HR, die auch das
  Portal-Organigramm filtert; ausgehaendigte Bescheinigungen erscheinen
  im Portal unter Dokumente; Entwicklungsplaene und Karrierestufen ohne
  Oberflaeche entfernt (Migration `330_drop_development_plans`).
- Konto-Seite ohne Bereichsbindung (Passwort, Darstellung, Seitenleiste),
  damit jede Admin-Rolle ihr Passwort aendern kann; bereichsneutrale
  Personenliste `GET /api/lookup/employees` fuer Auswahlfelder.
- Personal: Teamleitung setzbar, befristete Vertraege als aktuell
  erkannt und gespiegelt (mit Typregel-Pruefung), Loeschen einer Person
  raeumt Dateien auf und nennt die Folgen, Dokumente bearbeitbar mit
  Herkunft „aus dem Portal“ und abgeloesten Versionen, Foto entfernbar,
  Team muss zur Abteilung passen, Unterabteilungen sperren das Loeschen.
- Abwesenheit: AU-Bescheinigung herunterladbar, HR-Erfassung ohne
  Krankheitsarten und mit Berechtigung je Person, Portal-Krankmeldungen
  verketten Folgebescheinigungen, Betriebsruhe berechnet betroffene
  Antraege neu, Konflikte ignorieren Feiertage.
- Leistung und Fuehrung: Deep-Link auf Gespraeche der Person, leere
  Trainingsfelder speicherbar, einheitliche Zaehlung „bewertet“,
  Bearbeiten und Loeschen von Zyklen, Beurteilungen, Gespraechen und
  Massnahmen mit Rueckfrage, Kommentare ohne Bewertung bleiben erhalten.
- Verguetung: entschiedene Antraege mit Anmerkung sichtbar, Vier-Augen
  in der Oberflaeche, Ueberschneidung schon beim Antrag, Personalnummer
  in CSV, LODAS und Bescheinigung, Abrechnungslauf verwerfbar,
  Freiberufler ohne Gehaltskarte und ohne Boni, Rechnungsbeleg als Datei,
  geplante Boni bleiben dem Portal verborgen.
- Recruiting und Verwaltung: Einstellen mit Beschaeftigungsart der Stelle
  und Pflichtfeldern, Rueckzug erfassbar, Interviews bei Entscheidung
  abgesagt, Link zur Personalakte und Onboarding nach der Einstellung,
  Onboarding-Vorlagen pflegbar, Bewerbungen nach Status, Lebenslauf und
  Gehaltsvorstellung erfassbar, abgelaufene Einwilligungen markiert.
- Kommunikation: Umfragen mit Mindestteilnehmerzahl 2, Start und Ende
  mit Rueckfrage, Frist abgelaufen sichtbar, Wiedervorlagen als
  Dashboard-Widget, Deep-Links auf Ankuendigung und Umfrage.

### Ankuendigungen und Umfragen erreichen die Mitarbeitenden, Kanaele entfernt (22.09.2026)
- Kanaele sind entfernt (Migration `501_distribution_lists` loescht die
  Tabellen): Sie hatten keinen Empfaenger und ueberschnitten sich mit den
  Ankuendigungen. Routen `/api/communication/channels*`, Seite und
  Navigationseintrag sind weg.
- Neue Portal-Routen `GET /api/me/announcements`, `POST .../:id/ack`,
  `GET /api/me/surveys[/:id]`, `POST .../:id/responses`: nur, was sich an
  die Person richtet (404 sonst). Portal-Uebersicht und Desktop-Dashboard
  (auch Admin-Konten mit verknuepftem Profil) zeigen daraus Karten, die nur
  mit Inhalt erscheinen; Lesebestaetigung und anonyme Umfrageteilnahme
  direkt dort.
- Zielgruppe `abteilung` schliesst Unterabteilungen ein; neue Zielgruppe
  `verteiler`: HR-gepflegte Verteiler (Kommunikation → Verteiler) aus
  Abteilungen, Teams, Standorten und einzelnen Personen, wobei eine Person,
  die ueber eine Einheit erreicht wird, nicht zusaetzlich waehlbar ist.
  Eine Zielgruppe auf eine geloeschte Einheit wird beim Speichern mit 400
  abgewiesen; ein Verteiler in Verwendung ist nicht loeschbar (409).
- `GET /api/communication/org` liefert `parent_id` je Abteilung und
  `distribution_lists`; die HR-Testerfassung einer Umfrage und die
  Portal-Teilnahme teilen sich Pruefung und Schreibpfad
  (`surveyService.ts`).

### Nachtraegliche Erfassung von Abwesenheiten (21.09.2026)
- Die HR-Erfassung (Abwesenheit → Antraege → Neuer Antrag, auch vom
  Dashboard) kann mit "Direkt genehmigen" erfassen und genehmigen in einem
  Schritt (`approve: true`), fuer vergessene Antraege und Personen ohne
  Portalzugang. Das Vier-Augen-Prinzip bleibt: die eigene Abwesenheit wird
  mit 403 abgewiesen, das Audit-Detail traegt `approved_on_create`.
- Portal und Desktop zeigen an einem Antrag, dass die Personalabteilung ihn
  stellvertretend erfasst hat (`created_by_name`, `created_by_proxy` in
  beiden Listen-Antworten; ein Admin, der fuer sich selbst beantragt, gilt
  nicht als stellvertretend).

### Farbwahl (21.09.2026)
- Abwesenheitsarten-Dialog und Kalender "Farben bearbeiten" nutzen einen
  eigenen Farbwaehler (`components/ColorPicker.tsx`) statt
  `<input type="color">`, weil das Chromium-Pop-up keinem Theme folgt:
  Farbflaeche, Farbtonspur, Pipette, Hex- und R/G/B-Felder, vollstaendig
  per Tastatur bedienbar (Pfeil nach unten oeffnet, Escape schliesst nur den
  Waehler, Tab kreist im Panel). Die Farbmathematik (Hex/RGB/HSV) liegt in
  `packages/shared/src/color.ts`; `src/test/colorTest.ts` prueft alle 2^24
  Werte auf Drift und laeuft in `npm test` mit.
- Nebenbei: `.hm-popover` rundet mit `--radius-sm` (das bisher genannte
  `--radius-md` existierte nie, alle Popovers waren eckig); ein Klick auf den
  Popover-Rahmen wirft den Fokus nicht mehr auf die Seite; das Kaestchen in
  `.hm-checkbox` schrumpft nicht mehr, wenn der Text umbricht.

### Schrift (20.09.2026)
- Desktop-App und Portal verwenden Creato Display, die Hausschrift der
  Website, statt Inter Variable. Die Schnitte liegen im Workspace-Paket
  `packages/fonts` (`@ohrganize/fonts/creato-display.css`, WOFF2, SIL OFL);
  `@fontsource-variable/inter` entfaellt. Gewichte, Groessen und Abstaende
  im Code bleiben unveraendert; welche Zwischenstufe welchen Schnitt traegt,
  legen die `font-weight`-Bereiche in der Stildatei fest (bis 479 Regular,
  480-599 Medium, 600-749 Bold).
- Zweitschrift Plus Jakarta Sans Variable (wie auf der Website): erste
  Rueckfallschrift fuer Zeichen, die Creato Display nicht hat (einige
  osteuropaeische Buchstaben), und ueber das Token `--font-numeric` die
  Familie an allen Stellen mit Tabellenziffern (Zahlenspalten, Kennzahlen,
  Urlaubskonto), weil Creato Display keine Tabellenziffern hat. Pfeile kamen
  schon bisher aus der Systemschrift und tun es weiterhin.

### Windows-Einzelkunde (19.09.2026)
- conspectus: `bericht importieren` und `csv-import` lesen Dateien mit
  UTF-16- oder UTF-8-BOM (so schreibt Windows PowerShell 5.1 bei
  `node status.cjs --json > bericht.json`); bisher "kein gueltiges JSON".
- `setup-server.ps1` nennt den Lizenzzustand in Worten: "unbefristet" statt
  2999-12-31, "Plaetze unbegrenzt" statt einer leeren Stelle.

### conspectus-Durchstich (15.09.2026)
- Release-Signaturschluessel erzeugt und in `deploy/ohrganize-release.allowed_signers`
  eingetragen; `scripts/release.mjs` signiert damit, `ohrganize-update.sh`
  und conspectus pruefen die Signatur. Release-Skripte starten npm unter
  Windows ueber `npm-cli.js` statt `npm.cmd`.
- conspectus: `host anlegen --schluessel` (eigener SSH-Schluessel je Host),
  Dateipfade relativ zum Aufruferverzeichnis, Resttage in `check` mit
  richtigem Vorzeichen, `license_format` aus dem Hostbericht.

### Hosting-Durchstich (15.09.2026)
- `ohrganize-provision.sh lizenz` prueft die Datei vor dem Einspielen fuer
  die Instanz (`status.cjs --lizenzdatei`) und lehnt unbrauchbare Dateien
  ab, statt eine gueltige zu ersetzen. `restore --ja` fuer Skripte ohne
  Terminal. `check` rechnete mit Sekundenbruchteilen und brach ab;
  `json_feld` fand in mehrzeiligem JSON keine verschachtelten Felder
  (`liste` ohne Lizenzzustand). Markerdatei `.update-fehlgeschlagen`
  gehoert dem Dienstbenutzer. Rezept fuer Bestandshosts in
  `deploy/README.md` 9.1, Protokoll und Messwerte in 9.7.

### Hinzugefuegt (Varianten)
- Varianten als getrennte Builds (Land x Edition): Register
  `packages/shared/src/variants/registry.json` (Editionen frei
  definierbar, keine feste Liste), erzeugte Verdrahtungsdateien je App
  (`npm run variants:gen` / `variants:check`), Aliasse `@variant` und
  `@variant-manifest`, Builds je Variante ueber `OHRGANIZE_VARIANT`,
  Bundle-Pruefung `npm run check:variant`. Health meldet die Variante, die
  Desktop-App prueft sie beim Start, das Backend beim Start gegen
  `OHRGANIZE_VARIANT`, v2-Lizenzen fremder Ausgabe werden abgelehnt.
  Installername `oHRganize-Setup-<version>-<variante>.exe`; Sicherungen
  nennen die Variante im MANIFEST. Heute gibt es genau `de-vollversion`.

### Hinzugefuegt (conspectus)
- `tools/conspectus` (neuer Workspace, `npm run conspectus -- --help`):
  Register des Anbieters ueber Kunden, Hosts, Instanzen, ausgestellte
  Lizenzen, Releases, Rollouts und Vorgaenge (Zahlungen inbegriffen).
  Befehle: `kunde`, `host`, `instanz`, `lizenz ausstellen|verlaengern|faellig`,
  `release erfassen`, `rollout starten`, `status`, `bericht importieren`,
  `check`, `uebersicht`, `html`, `csv-import`, `zahlung`.
- Das Register liegt ausserhalb des Repositories
  (`OHRGANIZE_CONSPECTUS_DIR`, Pflicht); Pfade im Repo und in
  synchronisierten Ordnern werden abgewiesen. Lizenzen entstehen ueber
  denselben Baustein wie im schlanken Werkzeug; Ausgabe und
  Installations-ID kommen aus der Instanz, und eine v2-Datei entsteht nur,
  wenn die Instanz v2 lesen kann (`license_format` aus dem Bericht).
- `docs/betrieb-anbieter.md` (neu): Schluessel und Geheimnisse, Lizenzfaelle,
  Release bauen, Rollout, Einzelkunde, Stoerungen, Restore, Kuendigung.

### Hinzugefuegt (Hosting und Betreiberwerkzeuge)
- Drei Werkzeuge im Backend-Bundle: `status.cjs` (Zustand einer Instanz mit
  Installations-ID, Lizenz, Plaetzen, Zaehlungen und ausstehenden
  Migrationen, `--json`), `admin-reset.cjs` (Passwort neu setzen, Sitzungen
  entwerten, Audit-Zeile) und `migrate-check.cjs` (Migrations-Probelauf auf
  einer Kopie der Datenbank). Sie importieren `config.ts` nicht, verweigern
  den Lauf als root und wandern mit ins Release-Archiv.
- `deploy/ohrganize-update.sh` (neu): Pruefsumme, Signatur, Ausgabe gegen
  env-Datei und `/api/health`, `npm ci --omit=dev`, better-sqlite3-Probe,
  Migrations-Probelauf, dann je Instanz Sicherung, stop, Symlink, start,
  Health; bei Fehler Ruecknahme auf das alte Release, notfalls samt
  Datenbank aus der eben erstellten Sicherung. Windows-Gegenstueck:
  `deploy/windows/update-server.ps1`.
- Hosting: Programmverzeichnis je Instanz als Symlink auf ein Release
  (`/opt/ohrganize/releases/<variante>-<version>`), Portal ebenso
  (`/srv/ohrganize-web/kunden/<domain>`, nginx `root ... $host`). Damit
  laufen verschiedene Ausgaben auf einem Host, ein Update ist zuruecknehmbar
  und eine Instanz laesst sich auf einem alten Stand pinnen.
- `ohrganize-provision.sh` kann `status [--json]`, `id`, `lizenz`,
  `passwort [--loeschen|--zuruecksetzen]`, `pin`, `pausieren`, `fortsetzen`,
  `restore` und `check`; `anlegen` nimmt `--variante` und `--release`. Alle
  Node-Aufrufe ueber `runuser -u <dienstbenutzer>`. Gemeinsame Pfade in
  `deploy/ohrganize-lib.sh`.
- Leseisolation zwischen den Instanzen (`TemporaryFileSystem` plus
  `BindPaths` in beiden Units) und Ressourcengrenzen (`MemoryHigh`,
  `MemoryMax`, `TasksMax`, `CPUWeight`, `IOWeight`).
- `OHRGANIZE_QUIET_INITIAL_PASSWORD=1`: Das Initialpasswort steht dann nur in
  der Datei im Datenverzeichnis, nicht im Journal.
- Wartungsseite `deploy/wartung.html`, ausgeliefert bei 502/503/504.

### Hinzugefuegt (Release und Kanal)
- Der Kanal ist eine Funktion der Version: `channelOf` in
  `packages/shared/src/version.ts` (`1.2.0` = stable, `1.2.0-beta.1` = beta),
  `CHANNELS` und `CHANNEL_LABELS`. `/api/health` meldet `channel`, die
  Titelleiste zeigt eine Beta als Abzeichen.
- `npm run release -- --version <v> [--variants a,b] [--no-desktop]
  [--sign-key <pfad>]`: setzt die Version ueber alle Workspaces, committet und
  taggt, baut je Variante Bundles, Server-Archiv und Installer, prueft die
  Bundles mit `check-variant` und schreibt je Variante ein `release.json` mit
  Pruefsummen aller Artefakte, signiert mit `ssh-keygen -Y sign`
  (Namensraum `ohrganize-release`, Vertrauensanker
  `deploy/ohrganize-release.allowed_signers`). Ablage:
  `release/<version>/<kanal>/<variante>/`. Zum Schluss `npm rebuild
  better-sqlite3`, weil electron-builder die ABI umbaut.
- `npm run release:server` kennt `--variant` und `--out`; der Archivname
  traegt Land und Edition (`ohrganize-server-de-vollversion-1.2.0.zip`), das
  Archiv enthaelt `VARIANTE.txt` und ein unsigniertes `release.json`, und die
  LIESMICH beginnt mit dem Schritt "Variante pruefen".

### Hinzugefuegt (Laender)
- Land und Region sind eine Datendimension: `packages/shared/src/country.ts`
  haelt Regionen, Sprachkennung, Waehrung und Regionsbegriff je Land; das
  Land einer Installation kommt aus der Variante, nicht aus einer
  Einstellung. Feiertage stehen als Regeltabelle je Land
  (`HOLIDAY_RULES`), Beschaeftigungsarten, Steuerklassen und
  Kirchensteuermerkmale als Kataloge je Land. Neue Route
  `GET /api/regions[?country=]` (`/api/bundeslaender` bleibt als Alias).
  Lohnexport und Bescheinigungen laufen ueber Adapter-Registrys
  (`payrollExport/`, `certificates/`), die Route `/export.datev` bleibt.
  Migration `107_locations_country` (additiv: `locations.country`,
  `employees.private_country`). AT und CH bekommen Strukturen, keine
  Inhalte.
- Kalender- und Vorschau-Routen liefern neben `bundesland` zusaetzlich
  `region` und `country`; `bundesland` bleibt aus Kompatibilitaet.
- `formatMoney(cents, locale, currency)` in `@ohrganize/shared`;
  `formatEuro` ist die Huelle dafuer. Beide Clients haben ein
  `lib/locale.ts` mit `LOCALE`, `CURRENCY`, `REGIONS` und `REGION_TERM`.

### Hinzugefuegt (Feature-Schluessel)
- Feature-Gate: Funktionen innerhalb eines Builds koennen ueber die Lizenz
  (`features`) freigeschaltet werden. Registry `packages/shared/src/features.ts`
  (zu Beginn leer), Durchsetzung im globalen Hook
  (`403 LICENSE_FEATURE_MISSING`), Navigation und Widgets beider Clients
  folgen der Lizenz. Ohne einschraenkende Lizenz ist alles an.

### Geaendert
- Das MANIFEST einer Sicherung nennt im Hosting
  `ohrganize-provision.sh restore <kunde> <ordner>` statt der pauschalen
  Einzelschritte (die stoppten den Dienst ohne Instanznamen) und weist darauf
  hin, dass eine seither eingespielte neuere Lizenzdatei erneut abzulegen ist.
- Die Versionsordnung kennt Vorabkennungen: `1.1.0-beta.1` ist AELTER als
  `1.1.0`, `beta.2` neuer als `beta.1`. Damit wird `isAtLeast('1.1.0-beta.1',
  '1.1.0')` falsch; solange eine Beta derselben Nummer im Umlauf sein soll,
  muss `MIN_CLIENT_VERSION` auf die Beta zeigen.
- Update-Anleitungen (Linux und Windows) beginnen mit dem Schritt
  "Variante pruefen" und beschreiben die Signaturpruefung des Release-Manifests.
- Lizenz v2: Dateien koennen Ausgabe (`edition`, `country`), Funktionen
  (`features`), Vertragsbedingungen (`terms`) und eine signierte
  Ueberschrift (`headline`) tragen. v1-Dateien bleiben gueltig. Werkzeug:
  neue Flags `--edition`, `--country`, `--feature`, `--billing`,
  `--interval`, `--label`, `--headline`, `--v2` und Laufzeiten
  `--until 3t|2w|6m|1j`.
- Monotonie beim Einspielen haengt nur noch am Ausstelltag: Eine spaeter
  ausgestellte Datei wird angenommen, auch wenn sie kuerzer laeuft (bisher
  wurde jede kuerzere Datei abgelehnt). Gleichtaegig bleibt "nicht kuerzer".
- `/api/health` und der Lizenzbericht melden `license_format` (2).
- Ein Tausch der Lizenzdatei im Datenverzeichnis ohne Upload erzeugt eine
  Audit-Zeile `license.file_changed` (user_id NULL) und eine Journalzeile.
- Lizenztexte kommen fuer Desktop-App, Portal und Backend aus einer
  Funktion (`describeLicense` in `packages/shared`). Unbefristete Lizenzen
  melden `perpetual = true`, keinen Countdown und kein Kulanzdatum mehr
  (bisher "Kulanz bis 14.01.3000"). `kind = evaluation` heisst in der
  Oberflaeche "Testlizenz". Neues Feld `issued_at` im Lizenzzustand.
- Der Zustandsautomat der Lizenz ist eine reine Funktion
  (`core/licenseState.ts`), tabellengetrieben geprueft.

### Hinzugefuegt
- `scripts/check-dashes.mjs` und `npm run check:dashes`: prueft neue Zeilen
  auf Gedankenstriche (drei UI-Konventionen bleiben erlaubt).
- Feiertags-Fixture `apps/backend/src/test/fixtures/holidays-de.json` mit
  Regressionstest `npm run test:holidays` (128 Kombinationen aus 8 Jahren
  und 16 Regionen).
- Umsetzungsplan `docs/umsetzungsplan-varianten-lizenz.md` fuer Varianten,
  Lizenz v2, Feature-Schluessel, Laender, Kanaele, Hosting und conspectus.

## 1.0.0 (2026-09-13)

Erste Auslieferung: Desktop-App (Electron) fuer die Personalabteilung und
Mitarbeitenden-Portal (Web) auf demselben Backend (Fastify, SQLite).
Signierte Offline-Lizenz mit Testphase, Warnfrist, Kulanz und
Nur-Lese-Betrieb; Serverauslieferung als Release-Archiv mit systemd-Units
(Linux) und PowerShell-Einrichtung (Windows).
