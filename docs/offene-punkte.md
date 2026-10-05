# Offene Punkte

Bewusst zurückgestellte Arbeiten mit Kennung, damit sie auffindbar bleiben.
Jeder Eintrag nennt Befund, Wirkung, Vorschlag und warum er warten darf.
Erledigte Punkte wandern ins CHANGELOG und werden hier gestrichen.

Messbasis der Zahlen (Performance-Prüfung vom 05.10.2026): synthetischer
Bestand mit 2000 aktiven und 600 ausgeschiedenen Personen, sechs Jahren
Historie (221 000 Abwesenheitsanträge, 120 000 Abrechnungspositionen,
500 000 Audit-Zeilen), Datenbank eingerichtet wie im Betrieb (SQLCipher, WAL,
`synchronous = FULL`, `secure_delete`), gemessen auf einem Büro-Notebook.
Die Werte zeigen Größenordnungen.

## PERF-1: Backend der Desktop-App im Electron-Hauptprozess

**Befund.** `apps/desktop/src/main.ts` lädt `server.cjs` per `require` in den
Hauptprozess und ruft dort `startServer(0)` auf (bewusst so entschieden,
docs/entscheidungen.md, „Desktop-Stack“). Derselbe Prozess bedient Fenster,
Titelleiste, IPC und das `ohrganize://`-Protokoll. better-sqlite3 arbeitet
synchron; jede längere Arbeit des Backends hält deshalb auch das Fenster an
(Ziehen, Minimieren, Titelleistenmenü). Das Fenster entsteht außerdem erst,
wenn das Backend gestartet ist (`main.ts`, `startBackend()` vor dem Fenster),
ohne Ladeanzeige.

**Wirkung.** Betroffen ist nur der Einzelplatzbetrieb (eingebettetes
Backend); mit Serveradresse startet kein Backend in der App. Spürbar bei:
- Rechenseiten aus PERF-2 (bis 1,5 s);
- Umfrageende mit vielen Antworten (Neuaufbau der Antworttabelle, 1,5 bis
  4,4 s bei 50 000 Antworten; im Einzelplatzbetrieb ohne Portal selten);
- erstem Start nach einem Update: Migrationen, VACUUM nach Migrationen,
  einmalige Umstellung auf Verschlüsselung; so lange ist gar kein Fenster zu
  sehen (Sekunden bis Minuten je nach Datenmenge).

**Vorschlag.** Backend per `utilityProcess.fork()` (Electron-Bordmittel) in
einen eigenen Prozess legen; der Port kommt per `parentPort.postMessage`
zurück, ein `StartupError` als Nachricht. better-sqlite3 läuft dort mit
derselben Electron-ABI. Dazu sofort ein schlichtes Ladefenster, das nach dem
Start gegen das Hauptfenster getauscht wird. Berührt Start, Fehlerdialoge,
Beenden (Datenbank sauber schließen) und den Desktop-Build.

**Warum zurückgestellt.** Eingriff in den Start der App, bisher keine
Probleme im Betrieb, noch keine Kundeninstallation. Wieder aufgreifen, sobald
Rückmeldungen über eingefrorene Fenster kommen oder ein Einzelplatzkunde mit
mehreren hundert Personen Umfragen nutzt.

## PERF-2: Rechenintensive Übersichten

**Befund.** Drei Seiten rechnen bei jedem Aufruf über den ganzen Bestand,
synchron im einzigen Backend-Prozess (alle anderen Anfragen warten so lange):

| Seite | Route | Dauer | Ursache |
|---|---|---|---|
| Saldo-Übersicht | `absences/routes.ts`, `computeBalance` (`service.ts`) | 1,2 bis 1,5 s | reines JS: je Person die Übertragskette bis zu fünf Jahre zurück, jeder Antrag Tag für Tag mit Feiertagsprüfung |
| Abrechnungsläufe | `compensation/payrollRoutes.ts`, Liste der Läufe | 0,9 bis 1,0 s | summiert bei jedem Aufruf alle `payroll_items` aller Läufe samt `json_array_length` |
| Gehaltsübersicht | `compensation/salaryRoutes.ts` mit `componentsAt` (`lib.ts`) | 0,4 bis 0,65 s | eine Abfrage je Person (2600 Abfragen) |

**Vorschlag.**
- Saldo: gezählte Tage je Antrag und Jahr einmal berechnen; Anträge, die
  ganz in einem Jahr liegen und keinen Stichtag schneiden, über das
  gespeicherte `days_counted`; nur Grenzfälle Tag für Tag. Optional ein
  Ergebniscache, den jeder Schreibzugriff auf Anträge verwirft.
- Abrechnungsläufe: `item_count`, `total_cents` und `warning_count` beim
  Anlegen des Laufs in `payroll_runs` speichern (Positionen sind
  unveränderliche Momentaufnahmen).
- Gehaltsübersicht: eine Sammelabfrage wie in `assembleMonth` (gemessen 11
  bis 19 ms statt 0,4 bis 0,65 s).

**Warum zurückgestellt.** Entscheidung des Auftraggebers; bei den
Kundengrößen der ersten Installationen deutlich unter den gemessenen Werten.
Wieder aufgreifen ab etwa 1000 Personen oder bei Rückmeldungen über träge
Übersichten.
