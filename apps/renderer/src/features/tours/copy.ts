/**
 * Texte der Seiten-Einfuehrungen (Mini-Onboardings). Wie im Einrichtungs-
 * Assistenten (features/setup/copy.ts) die EINZIGE Textquelle: Schluessel
 * `<Tour>.<Feld>`, Platzhalter in geschweiften Klammern. Keine en- oder
 * em-Dashes in Texten (scripts/check-dashes.mjs).
 */

import { fillPlaceholders } from '../../lib/localStore';
export const COPY = {
  // ---- Gemeinsam ------------------------------------------------------------
  'bar.label': '{title} {done}/{total}',
  'bar.skip': 'Überspringen',
  'bar.skip.aria': 'Einführung überspringen',
  'skip.notice': 'Über die {docs} können Sie alles in Ruhe nachschauen.',
  'skip.docs': 'Dokumentation',
  'bar.goto': 'Weiter bei {page}',
  'notice.close': 'Hinweis schließen',
  'konto.title': 'Einführungen',
  'konto.text': 'Kurze Rundgänge durch einzelne Seiten. Übersprungene und abgeschlossene lassen sich erneut starten.',
  'konto.restart': 'Erneut starten',
  'konto.state.active': 'läuft',
  'konto.state.done': 'abgeschlossen',
  'konto.state.skipped': 'übersprungen',
  'konto.state.new': 'noch nicht gestartet',

  // ---- Gehälter -------------------------------------------------------------
  'gehaelter.title': 'Gehälter kennenlernen',
  'gehaelter.finale': 'Gehälter erledigt',
  'gehaelter.step1.title': 'Alle auf einen Blick',
  'gehaelter.step1.text': 'Hier steht das aktuelle Monatsbrutto jeder Person.',
  'gehaelter.step1.todo': 'Öffnen Sie eine Zeile.',
  'gehaelter.step2.title': 'Die erste Komponente',
  'gehaelter.step2.text': 'Grundgehalt, Zulagen und Boni sind einzelne Komponenten.',
  'gehaelter.step2.todo': 'Klicken Sie hier und legen Sie eine an.',
  'gehaelter.step3.title': 'Betrag und Gültigkeit',
  'gehaelter.step3.text':
    'Wählen Sie die Art, den Betrag und ab wann er gilt. Ein gültiger Vorgängereintrag gleicher Art wird automatisch geschlossen.',
  'gehaelter.step3.todo': 'Legen Sie die Komponente an.',
  'gehaelter.step3.alt': 'Hier geht es mit der Komponente weiter.',
  'gehaelter.step4.title': 'Änderungen mit Begründung',
  'gehaelter.step4.text':
    'Spätere Änderungen laufen über eine Anfrage. Die Begründung ist Pflicht und landet im Änderungsprotokoll.',
  'gehaelter.step4.todo': 'Öffnen Sie die Anfrage, um sie anzusehen.',
  'gehaelter.step5.title': 'Vier Augen',
  'gehaelter.step5.text':
    'Wer eine Anfrage stellt, entscheidet sie nicht selbst. Entschiedene Anträge bleiben hier nachvollziehbar.',
  'gehaelter.step5.todo': 'Wechseln Sie zwischen den Reitern.',
  'gehaelter.step5.alt': 'Zurück zur Übersicht, dort stehen die Anträge.',

  // ---- Rollen & Rechte ------------------------------------------------------
  'rollen-rechte.title': 'Rollen & Rechte kennenlernen',
  'rollen-rechte.finale': 'Rollen & Rechte erledigt',
  'rollen-rechte.page.rollen': 'Rollen',
  'rollen-rechte.page.benutzer': 'Benutzer & Rechte',
  'rollen-rechte.step1.title': 'Die erste eigene Rolle',
  'rollen-rechte.step1.text':
    'Rollen bestimmen, wer welche Abwesenheitsart beantragen darf. Für jede Beschäftigungsart gibt es schon eine.',
  'rollen-rechte.step1.todo': 'Klicken Sie hier und legen Sie eine an.',
  'rollen-rechte.step2.title': 'Name und Sichtbarkeit',
  'rollen-rechte.step2.text':
    'Vergeben Sie einen Namen, etwa Außendienst. Aktiv und Kalender im Portal lassen Sie für den Anfang angehakt.',
  'rollen-rechte.step2.todo': 'Legen Sie die Rolle an.',
  'rollen-rechte.step2.alt': 'Hier geht es mit der Rolle weiter.',
  'rollen-rechte.step3.title': 'Wer gehört dazu?',
  'rollen-rechte.step3.text':
    'Eine Person kann mehrere Rollen haben. Ihr Personalprofil bleibt dabei unverändert.',
  'rollen-rechte.step3.todo': 'Öffnen Sie die Mitglieder der neuen Rolle.',
  'rollen-rechte.step4.title': 'Mitglieder wählen',
  'rollen-rechte.step4.text':
    'Wählen Sie eine Person aus. Solange keine Abwesenheitsart die Rolle verlangt, ändert sich für niemanden etwas. Zurücknehmen geht jederzeit.',
  'rollen-rechte.step4.todo': 'Speichern Sie die Auswahl.',
  'rollen-rechte.step4.alt': 'Hier geht es mit den Mitgliedern weiter.',
  'rollen-rechte.step4.empty':
    'Noch niemand angelegt. Legen Sie unter Personal → Mitarbeiter eine Person an, danach geht es hier weiter.',
  'rollen-rechte.step5.enter':
    'Nun sind wir im Bereich Benutzer & Rechte. Hier legen Sie fest, wer in der HR-Administration was sehen und bearbeiten darf.',
  'rollen-rechte.step5.title': 'Rechte bündeln',
  'rollen-rechte.step5.text':
    'Anders als die Rollen eben regeln diese, welche Bereiche ein Konto in der App sieht und bearbeitet.',
  'rollen-rechte.step5.todo': 'Klicken Sie hier und legen Sie eine an.',
  'rollen-rechte.step5.alt': 'Wechseln Sie auf den Reiter Rollen & Rechte.',
  'rollen-rechte.step6.title': 'Bereich für Bereich',
  'rollen-rechte.step6.text':
    'Je Bereich gilt: kein Zugriff, nur lesen oder bearbeiten. Was nicht freigegeben ist, bleibt dem Konto verborgen.',
  'rollen-rechte.step6.todo': 'Legen Sie die Rolle an.',
  'rollen-rechte.step6.alt': 'Hier geht es mit der Rolle weiter.',
  'rollen-rechte.step7.title': 'Rolle zuweisen',
  'rollen-rechte.step7.text':
    'Konten ohne Rolle haben Vollzugriff. Mit dieser Auswahl weisen Sie einem Konto eine Rolle zu.',
  'rollen-rechte.step7.todo': 'Öffnen Sie die Auswahl. Ändern müssen Sie nichts.',
  'rollen-rechte.step7.alt': 'Zurück zu den Konten, dort weisen Sie Rollen zu.',
  'rollen-rechte.step7.empty':
    'Es gibt noch kein weiteres Administrator-Konto. Legen Sie eines an, danach geht es hier weiter.',

  // ---- Stellen --------------------------------------------------------------
  'stellen.title': 'Stellen kennenlernen',
  'stellen.finale': 'Stellen erledigt',
  'stellen.step1.title': 'Die erste Stelle',
  'stellen.step1.text': 'Eine Stelle ist ein Besetzungsbedarf. Bewerbungen hängen später an ihr.',
  'stellen.step1.todo': 'Klicken Sie hier und legen Sie eine an.',
  'stellen.step2.title': 'Die Eckdaten',
  'stellen.step2.text':
    'Pflicht sind nur Titel, Beschäftigungsart und Anzahl. Abteilung, Standort, Führungskraft und Gehaltsspanne ergänzen Sie, wenn Sie sie kennen.',
  'stellen.step2.todo': 'Legen Sie die Stelle an.',
  'stellen.step2.alt': 'Hier geht es mit der Stelle weiter.',
  'stellen.step3.title': 'Vom Entwurf zur Besetzung',
  'stellen.step3.text':
    'Neue Stellen starten als Entwurf. Von dort geht es über veröffentlicht, pausiert und besetzt bis geschlossen. Angeboten wird nur, was zum aktuellen Stand passt.',
  'stellen.step3.todo': 'Öffnen Sie die Auswahl. Ändern müssen Sie nichts.',
  'stellen.step3.alt': 'Legen Sie zuerst eine Stelle an.',
  'stellen.step4.title': 'Die Stelle im Detail',
  'stellen.step4.text': 'Die Karte zeigt aktive, gesamte und eingestellte Bewerbungen auf einen Blick.',
  'stellen.step4.todo': 'Öffnen Sie die Stelle.',
  'stellen.step4.alt': 'Legen Sie zuerst eine Stelle an.',
  'stellen.step5.title': 'Bewerbungen je Stufe',
  'stellen.step5.text': 'Hier sehen Sie, in welcher Stufe der Pipeline wie viele Bewerbungen stehen.',
  'stellen.step5.todo': 'Schließen Sie die Ansicht.',
  'stellen.step6.title': 'Nach Status filtern',
  'stellen.step6.text': 'Mit dem Filter finden Sie Entwürfe, offene und besetzte Stellen schnell wieder.',
  'stellen.step6.todo': 'Wählen Sie einen Status.',

  // ---- Ankündigungen --------------------------------------------------------
  'ankuendigungen.title': 'Ankündigungen kennenlernen',
  'ankuendigungen.finale': 'Ankündigungen erledigt',
  'ankuendigungen.step1.title': 'Die erste Ankündigung',
  'ankuendigungen.step1.text':
    'Ankündigungen erscheinen als Karte auf dem Dashboard der Mitarbeitenden, in der App und im Portal.',
  'ankuendigungen.step1.todo': 'Klicken Sie hier und legen Sie eine an.',
  'ankuendigungen.step2.title': 'Titel und Text',
  'ankuendigungen.step2.text': 'Ein kurzer Titel und ein Text genügen. Anhänge sind optional.',
  'ankuendigungen.step2.todo': 'Geben Sie Titel und Text ein.',
  'ankuendigungen.step2.alt': 'Hier geht es mit der Ankündigung weiter.',
  'ankuendigungen.step3.title': 'Wer sieht sie, und ab wann?',
  'ankuendigungen.step3.text':
    'Wählen Sie die Zielgruppe und den Zeitraum. Liegt der Beginn in der Zukunft, bleibt die Ankündigung geplant und ist noch für niemanden sichtbar. Für den Anfang empfehlen wir das.',
  'ankuendigungen.step3.todo': 'Wählen Sie ein Datum.',
  'ankuendigungen.step3.alt': 'Hier geht es mit der Ankündigung weiter.',
  'ankuendigungen.step4.title': 'Lesebestätigung',
  'ankuendigungen.step4.text':
    'Wichtige Mitteilungen lassen sich bestätigen. Danach sehen Sie, wer sie gelesen hat.',
  'ankuendigungen.step4.todo': 'Haken Sie die Option an.',
  'ankuendigungen.step4.alt': 'Hier geht es mit der Ankündigung weiter.',
  'ankuendigungen.step5.title': 'Anlegen',
  'ankuendigungen.step5.text': 'Mit dem Speichern entsteht die Ankündigung. Bearbeiten und Löschen bleiben jederzeit möglich.',
  'ankuendigungen.step5.todo': 'Legen Sie die Ankündigung an.',
  'ankuendigungen.step5.alt': 'Hier geht es mit der Ankündigung weiter.',
  'ankuendigungen.step6.title': 'Die Übersicht',
  'ankuendigungen.step6.text': 'Status, Zielgruppe, Zeitraum und Lesequote sehen Sie auf einen Blick.',
  'ankuendigungen.step6.todo': 'Öffnen Sie die Ankündigung.',
  'ankuendigungen.step6.alt': 'Legen Sie zuerst eine Ankündigung an.',
  'ankuendigungen.step7.title': 'Status und Empfänger',
  'ankuendigungen.step7.text':
    'Oben stehen Status und Zielgruppe. Bei Lesebestätigung sehen Sie darunter, wer schon bestätigt hat.',
  'ankuendigungen.step7.todo': 'Schließen Sie die Ansicht.',
} as const;

export type CopyKey = keyof typeof COPY;

export function t(key: CopyKey, vars?: Record<string, string | number>): string {
  return fillPlaceholders(COPY[key], vars);
}
