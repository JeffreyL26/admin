# DATEV-Lohnexport

oHRganize rechnet keine Löhne ab. Es übergibt dem Lohnbüro (Steuerkanzlei
oder eigene Lohnabteilung) je Monat, was dort erfasst werden müsste:
Einmalzahlungen, Stunden, Fehltage und, bei LODAS, die Personalstammdaten
samt Festbezügen. Die Dateien folgen den DATEV-Importschnittstellen, so
dass das Lohnbüro sie einliest statt abzutippen.

Zwei Lohnprogramme werden bedient (Einstellung **Lohnprogramm**):

| Programm | Dateien | Format |
|---|---|---|
| DATEV LODAS | Bewegungsdaten, Personalstammdaten | ASCII-Import mit Satzbeschreibung (Schnittstellenhandbuch SSH LODAS) |
| DATEV Lohn und Gehalt | Bewegungsdaten | Spaltendatei für den ASCII-Import-Assistenten, elf Spalten |

Beide Dateien sind Textdateien im Zeichensatz **Windows-1252** (ANSI) mit
Satzende CR/LF, Strichpunkt als Feldtrenner, Komma als Dezimalzeichen und
Datumsangaben als TT.MM.JJJJ. Beträge stehen ohne Vorzeichen; ob eine
Position Bezug oder Abzug ist, entscheidet die Lohnart im Lohnprogramm.

Code: `apps/backend/src/modules/compensation/payrollExport/` (Kontext,
Positionsplan `positions.ts`, Prüfbericht, Adapter `lodas.ts` und
`lug.ts`), Regeln ohne Datenbank in `packages/shared/src/datev.ts`, Tests
`apps/backend/src/test/datevTest.ts` und
`apps/backend/src/modules/compensation/smoke.ts`.

**Rechte.** Prüfbericht und Export verlangen neben dem Bereich Vergütung
auch Lesen in **Personal** und **Abwesenheit**: Die Dateien enthalten
Bankverbindung, Steuer-ID, SV-Nummer und Anschrift sowie Fehltage je Tag
samt Krankheit. Einer Rolle ohne diese Bereiche antwortet der Export mit
403 und nennt, was fehlt.

## 1. Einrichtung (Einstellungen > DATEV-Lohnexport)

| Einstellung | Bedeutung |
|---|---|
| Lohnprogramm | LODAS oder Lohn und Gehalt. Entscheidet über Format und Dateien. |
| Beraternummer | 4 bis 7 Ziffern, Mandantennummer 1 bis 5 Ziffern. Beide kommen von der Steuerkanzlei. Ohne sie ist der Export gesperrt; ab Werk sind sie leer. Die Demowerte früherer Fassungen (1000001 und 10001), die die alte Einstellungsseite beim Speichern mitschrieb, entfernt das Update (Migration `403_datev_demo_numbers`). |
| Betriebliche Personalnummer (nur LODAS) | Aus: Die Personalnummer der Personalakte muss die LODAS-Mitarbeiternummer sein (1 bis 5 Ziffern). An: Jede Personalnummer bis 20 Zeichen (etwa `P-0042`) ist der Schlüssel (`BetrieblichePNrVerwenden=Ja`), LODAS vergibt die Mitarbeiternummer selbst. Die Einstellung muss zum Mandanten in LODAS passen. |
| Wiederkehrende Bezüge | **Stammdaten** (Vorgabe): Gehalt, Zulagen, Sachbezüge, VWL, bAV und sonstige Abzüge gehen als Festbezüge mit den Stammdaten, LODAS zahlt sie jeden Monat selbst; die Bewegungsdaten tragen nur Einmalzahlungen, Stunden und Fehltage. **Bewegungsdaten**: jeden Monat als Buchung. Das ist nur richtig, wenn das Lohnbüro keine Festbezüge pflegt, sonst zahlt es doppelt. |
| Vertragsstunden übergeben | oHRganize kennt keine Ist-Stunden. Eingeschaltet stehen für Stundenlöhner Wochenstunden mal 4,33 als Stunden in der Datei (mit Hinweis; ohne Wochenstunden im Profil wie im Lauf 40); ausgeschaltet enthält die Datei keine Stunden, der Prüfbericht warnt. |
| Lohnarten | Nummer je Position (Gehaltskomponenten und Bonusarten). Die Nummern legt das Lohnbüro fest; die Vorgaben sind Vorschläge. Eine leere Nummer sperrt die Datei, in der die Position steht, und nur diese. Der sonstige Abzug trägt bei LODAS mit Festbezügen über die Stammdaten die Nettobe-/abzugsnummer des Mandanten (1 bis 2 Ziffern). |
| Ausfallschlüssel | Je Abwesenheitsart (auch inaktive, deren Abwesenheiten noch abgerechnet werden) der Schlüssel des Lohnprogramms (etwa `U`, `K`, `UU`). Ohne Schlüssel bleibt die Art aus der Datei; der Prüfbericht nennt das. |

Gespeichert wird über `PUT /api/settings/datev`. Die Route bleibt im
Nur-Lese-Betrieb der Lizenz offen wie der Export selbst, sonst wäre ein
gesperrter Export dort nicht mehr zu beheben. Lohnarten und
Ausfallschlüssel werden mit dem Gespeicherten zusammengeführt.

Personalnummern, die keine Person trägt, ersetzt der Export durch die
Profil-ID (mit Warnung). Trägt ein anderes Profil, auch ein
ausgeschiedenes, diese Zahl als Personalnummer, ist das ein Fehler: Die
Daten landeten sonst bei dessen LODAS-Personalnummer. Wer Personalnummern
führt, führt sie für alle.

## 2. Ablauf je Monat

1. **Vergütung > Abrechnung > Lauf erstellen.** Der Lauf friert Komponenten,
   Boni, Flags und Warnungen des Monats ein.
2. **Als geprüft markieren.**
3. **DATEV-Export.** Der Dialog zeigt den Prüfbericht zu der gewählten
   Datei: Fehler sperren sie, Warnungen stehen auch in ihr (LODAS, Abschnitt
   `[Hinweisdaten]`, erscheint im Prüfprotokoll von LODAS), jeweils nur zu
   den Personen, die die Datei enthält. Dann die Datei wählen
   (Bewegungsdaten; bei LODAS auch Stammdaten mit Umfang) und herunterladen.
4. Datei an das Lohnbüro geben. Der erste Export setzt den Lauf auf
   „exportiert“; jeder Export, auch ein wiederholter, schreibt einen
   Audit-Eintrag `payroll_run.export_file` mit Dateiname, Größe und
   SHA-256-Prüfsumme, damit sich belegen lässt, welche Datei das Lohnbüro
   bekam.

Stammdaten kommen aus der Personalakte zum Zeitpunkt des Exports (ein Lauf
friert Beträge ein, nicht Adressen); Fehltage aus den genehmigten
Abwesenheiten des Monats.

## 3. LODAS

### 3.1 Bewegungsdaten (`lodas_bewegungsdaten_JJJJ-MM.txt`)

```
[Allgemein]
Ziel=LODAS
Version_SST=1.0
BeraterNr=28547
MandantenNr=90909
Feldtrennzeichen=;
Zahlenkomma=,
Datumsformat=TT.MM.JJJJ
Stringbegrenzer="
Kommentarzeichen=*

[Satzbeschreibung]
1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;pnr#bwd;bs_nr#bwd;bs_wert_butab#bwd;la_eigene#bwd;
2;u_lod_bwd_buchung_kalendarium;abrechnung_zeitraum#bwd;pnr#bwd;kalendertag#bwd;as_kal#bwd;

[Bewegungsdaten]
1;01.10.2026;42;2;200,00;420;
2;01.10.2026;42;05;"U";

[Hinweisdaten]
"oHRganize, Musterfirma GmbH: Lohnexport 10/2026, erzeugt 12.10.2026, 14:03"
"Klein, Ben (2): Keine Personalnummer gepflegt, die Profil-ID wird übergeben"
```

Satzart 1 bucht Beträge und Stunden mit Bearbeitungsschlüssel (`bs_nr`):
`2` Bruttobezug (Einmalzahlungen; bei „Festbezüge als Buchung“ auch Gehalt,
Zulagen, Sachbezüge, VWL, bAV), `1` Stunden (Vertragsstunden), `3`
Nettoabzug (sonstiger Abzug bei „Festbezüge als Buchung“). `la_eigene` ist
die Lohnartennummer aus den Einstellungen, `bs_wert_butab` der Wert.
Satzart 2 ist das Kalendarium: je Fehltag ein Satz mit Kalendertag und
Ausfallschlüssel. Gezählt wird wie im Urlaubskonto (`countAbsenceDays`):
ohne Wochenende, Feiertage der Region der Person und Betriebsruhe. Decken
zwei genehmigte Abwesenheiten denselben Tag (Krankheit im Urlaub), steht er
einmal da, als Krankheit. Ein halber Tag steht als ganzer Tag mit einem
Hinweis in den Hinweisdaten.

Mit betrieblicher Personalnummer lautet das Schlüsselfeld in allen Sätzen
`pnr_betriebliche#psd` (auch in den Bewegungsdaten, so die Mustervorlage
`LS_Muster_Betr_PNr.txt` des Handbuchs), der Kopf trägt
`BetrieblichePNrVerwenden=Ja`, und der Wert steht in Stringbegrenzern.

### 3.2 Stammdaten (`lodas_stammdaten_JJJJ-MM.txt`)

Umfang wahlweise alle Personen des Laufs oder nur die geänderten
(Vorgabe): Neueintritt, Austritt oder Gehaltsänderung im Monat, eine seit
Monatsbeginn geänderte Personalakte (etwa eine genehmigte neue
Bankverbindung oder Anschrift) oder eine seit dem Vormonat beendete
Komponente. Der Kopf trägt `StammdatenGueltigAb=01.MM.JJJJ`; die Werte
gelten ab dem Abrechnungsmonat. Ein leeres Feld lässt in LODAS den
bestehenden Wert stehen.

| Satzart | Tabelle | Felder | Quelle in der Personalakte |
|---|---|---|---|
| 1 | `u_lod_psd_mitarbeiter` | `duevo_familienname`, `duevo_vorname`, `adresse_strassenname`, `adresse_strasse_nr`, `adresse_plz`, `adresse_ort`, `geburtsdatum_ttmmjj`, `sozialversicherung_nr` | Name, Privatanschrift (Hausnummer abgetrennt), Geburtsdatum, SV-Nummer |
| 2 | `u_lod_psd_ma_bank` | `ma_iban`, `ma_bic` | Bankverbindung (nur mit IBAN) |
| 3 | `u_lod_psd_steuer` | `identifikationsnummer`, `st_klasse`, `kfb_anzahl`, `konf_an` | Steuer-ID, Steuerklasse 1 bis 6, Kinderfreibeträge, Konfession (0 keine, 1 ev, 11 rk) |
| 4 | `u_lod_psd_taetigkeit` | `persgrs`, `berufsbezeichnung` | Personengruppe aus der Beschäftigungsart, **nur beim Neueintritt** (101 Vollzeit und Teilzeit, 102 Auszubildende, 105 Praktikanten, 106 Werkstudenten, 109 Minijob; bei bestehenden Personen bleibt das Feld leer, damit Korrekturen in LODAS stehen bleiben), Stellenbezeichnung |
| 5 | `u_lod_psd_beschaeftigung` | `eintrittdatum`, `austrittdatum`, `arbeitsverhaeltnis` | Eintritt, Austritt (auch ohne bekanntes Eintrittsdatum), Vertragsart am Monatsende bzw. Austrittstag (0 unbefristet, 1 befristet, sonst leer) |
| 6 | `u_lod_psd_festbezuege` | `festbez_id`, `lohnart_nr`, `betrag` | Je wiederkehrende Komponente ein Festbezug mit fester Kennung je Art (Grundgehalt 1, Schichtzulage 2, ... bAV 9), damit ein späterer Export denselben Festbezug aktualisiert; eine entfallene Art geht mit 0,00 |
| 7 | `u_lod_psd_lohn_festbezuege` | `std_lohn_1` | Stundensatz der Stundenlohn-Komponente (in beiden Einstellungen der Festbezüge) |
| 8 | `u_lod_psd_nettobeabzug` | `nettobeabzug_id`, `nba_nr`, `betrag` | Sonstiger Abzug mit der Nettobe-/abzugsnummer aus den Einstellungen; entfallen mit 0,00 |

Satzarten 6 und 8 fehlen, wenn „Wiederkehrende Bezüge“ auf Bewegungsdaten
steht. Feldlängen werden eingehalten (Name 30, Straße 33, Hausnummer 9,
Ort 34, Berufsbezeichnung 30 Zeichen); der Prüfbericht warnt, wenn gekürzt
wird. Eine Anschrift, die nicht vollständig hinausgehen kann (im Ausland,
oder mit einer Postleitzahl, die keine 5 Ziffern hat), geht gar nicht:
Alle Anschriftfelder bleiben leer, LODAS behält die bisherige, und der
Prüfbericht sagt das.

### 3.3 Import in LODAS

Datenübernahme > ASCII-Daten importieren, Datei wählen, **Prüflauf**
eingeschaltet lassen. LODAS zeigt dabei die Hinweisdaten (Warnungen aus
oHRganize) und eigene Beanstandungen. Nur eine Datensicht
(Abrechnungsmonat) je Datei: Bewegungs- und Stammdaten sind deshalb zwei
Dateien.

## 4. Lohn und Gehalt

### 4.1 Satzbeschreibung einmalig anlegen

Extras > ASCII-Import-Assistent > Neu: Trennzeichen „Strichpunkt“,
Satztrenner „Zeilenende“, Zahlenkomma „,“, Datum TT.MM.JJJJ, dann die elf
Felder in genau dieser Reihenfolge:

1. Personalnummer
2. Kalendertag
3. Ausfallschlüssel
4. Lohnartennummer
5. Stundenanzahl
6. Tagesanzahl
7. Wert
8. Abweichender Faktor
9. Abweichende Lohnveränderung
10. Kostenstellennummer
11. Kostenträger

### 4.2 Datei (`lug_bewegungsdaten_JJJJ-MM.txt`)

Kein Kopf, keine Abschnitte, jede Zeile alle elf Felder:

```
42;;;420;;;200,00;;;;
42;;;300;152,75;;;13,50;;;
42;05.10.2026;U;;;1;;;;;
42;06.10.2026;U;;;0,5;;;;;
```

Einmalzahlungen (und bei „Festbezüge als Buchung“ die wiederkehrenden
Bezüge) stehen als Wert mit Lohnartennummer, Vertragsstunden als
Stundenanzahl mit dem Stundensatz als abweichendem Faktor, Fehltage mit
Kalendertag, Ausfallschlüssel und Tagesanzahl (1 oder 0,5). Mit
„Festbezüge über die Stammdaten“ pflegt das Lohnbüro Gehälter selbst; der
Prüfbericht erinnert an Neueintritte und Gehaltsänderungen des Monats. Die Personalnummer ist die Mitarbeiternummer in Lohn und
Gehalt (Ziffern). Import unter Erfassen > Bewegungsdaten > Importieren,
Hersteller = die angelegte Satzbeschreibung.

Personalstammdaten gehen hier nicht mit: Der Stammdatenimport von Lohn und
Gehalt ist ein eigenes, maskenbasiertes Format (`Ziel=LuG`), das ein
Personalfragebogen abdeckt. Dafür bleibt das Lohnbüro zuständig.

## 5. Prüfbericht

Jede Meldung betrifft bestimmte Dateien (Lohnart des Grundgehalts: die
Stammdaten; Bonus: die Bewegungsdaten; IBAN: die Stammdaten) und, wenn sie
eine Person nennt, nur Dateien mit dieser Person.

**Fehler** (sperren die betroffene Datei, 409 `DATEV_EXPORT_BLOCKED`):
Beraternummer oder Mandantennummer fehlt oder hat die falsche Form; eine
Position ohne gültige Lohnartennummer in einer Datei, die sie trägt; eine
Personalnummer, die zum Schlüsselfeld nicht passt; doppelte Personalnummern
im Lauf (als Zahl verglichen: `042` und `42` sind dieselbe); eine
Personalnummer oder Ersatz-Profil-ID, die ein anderes Profil als
Personalnummer trägt; eine Gehaltskomponente, die der Export nicht kennt.

**Warnungen** (in der Datei und im Dialog): fehlende Personalnummer
(Profil-ID), IBAN fehlt oder ungültig (Prüfsumme), BIC-Form, Steuer-ID
fehlt oder ungültig (Prüfziffer), SV-Nummer fehlt oder ungültig
(Prüfziffer), Geburtsdatum, Eintrittsdatum, Steuerklasse, unvollständige
Anschrift, Anschrift wird nicht übergeben (Ausland, Postleitzahl),
Hausnummer nicht erkannt, Krankenkassen werden nicht übergeben (einmal),
Neueintritt ohne Personengruppe, gekürzte Felder, Zeichen außerhalb von
Windows-1252 (werden `?`), Bonus mit 0,00, halbe Fehltage (LODAS),
Abwesenheitsarten ohne Ausfallschlüssel, Stundenlohn ohne Stunden,
fehlende Wochenstunden, Festbezüge bei Lohn und Gehalt, Minijob-Grenze.

## 6. Grenzen

- Keine Ist-Stunden: oHRganize hat keine Zeiterfassung. Vertragsstunden
  sind ein Behelf und als solcher in der Datei gekennzeichnet.
- Keine Beitragsgruppen, keine Krankenkassen-Betriebsnummer, kein
  Tätigkeitsschlüssel: Die Personalakte führt sie nicht. Die Personengruppe
  ist aus der Beschäftigungsart abgeleitet, geht nur beim Neueintritt mit
  und ist als Hinweis markiert; Sonderfälle (Altersrentner, Altersteilzeit,
  kurzfristig Beschäftigte) korrigiert das Lohnbüro in LODAS, ein späterer
  Export überschreibt das nicht.
- Das Konfessionsfeld heißt `konf_an#psd` (Feldbeschreibung des Handbuchs,
  Fach 4); die Mustervorlage von 2016 nennt noch `konf#psd`. Meldet der
  Prüflauf den Feldnamen als unbekannt, ist das die Stelle.
- Eine erstmals angelegte Zulage einer bestehenden Person setzt im Lauf
  kein Flag „Gehaltsänderung“; beim Umfang „nur Änderungen“ ist die Person
  trotzdem dabei, weil die Personalakte im Monat geändert wurde. Im Zweifel
  „alle Personen“ exportieren; LODAS aktualisiert bestehende Festbezüge über
  die feste Kennung.
- Entfallene Festbezüge gehen mit 0,00 unter ihrer Kennung mit (kein
  `[Entfernen]`); ein Festbezug, den das Lohnbüro unter einer anderen
  Kennung angelegt hat, bleibt davon unberührt.
- Eine Gehaltsänderung zur Monatsmitte gilt in LODAS ab dem Monatsersten
  (`StammdatenGueltigAb`), wie der volle Monatswert im Lauf.
- Fehltage: halbe Tage in LODAS als ganzer Tag mit Hinweis. Mit einer
  abgelaufenen Lizenz lassen sich die DATEV-Einstellungen ändern, doppelte
  Personalnummern aber nicht (die Personalakte ist dann nur lesbar).
- Der Export liest Stammdaten und Abwesenheiten beim Export, nicht beim
  Anlegen des Laufs. Die Prüfsumme im Audit-Eintrag belegt, welche Fassung
  das Lohnbüro bekam.

## 7. Quellen

- DATEV Schnittstellenhandbuch SSH LODAS (Fach 1 bis 4, Mustervorlagen
  `LSST1.txt` und `LS_Muster_Betr_PNr.txt`); DATEV Hilfe-Center Dokument
  1080789 „Schnittstellen in den DATEV-Programmen“.
- DATEV Lohn und Gehalt: Satzbeschreibung des ASCII-Import-Assistenten
  (Bewegungsdaten), Stammdatenimport-Beschreibung (Ziel=LuG).
- Prüfziffern: IBAN nach ISO 13616, Versicherungsnummer nach der
  Gewichtung 2,1,2,5,7,1,2,1,2,1,2,1 mit Quersummen, steuerliche
  Identifikationsnummer nach ISO 7064 MOD 11,10.
