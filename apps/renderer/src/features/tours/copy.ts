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
} as const;

export type CopyKey = keyof typeof COPY;

export function t(key: CopyKey, vars?: Record<string, string | number>): string {
  return fillPlaceholders(COPY[key], vars);
}
