import React from 'react';
import { Lightbulb } from 'lucide-react';

/**
 * Hinweiskasten mit leuchtendem Rand und Glühbirne an der oberen linken Ecke.
 * Für Erklärungen, die genau dort stehen sollen, wo die Verwirrung entstehen
 * könnte, und beim ersten Auftreten genügen. Kein Ersatz für Fehlermeldungen
 * (Toast) und nicht für Pflichtangaben (Field-Hinweis). Mehrere Absätze als
 * einzelne Kinder übergeben. Farben nur über Tokens (components.css, `.hm-hint`).
 */
export function HintBox({ children }: { children: React.ReactNode }) {
  return (
    <aside className="hm-hint">
      <span className="hm-hint__bulb" aria-hidden="true">
        <Lightbulb size={16} />
      </span>
      <div className="hm-hint__body">{children}</div>
    </aside>
  );
}
