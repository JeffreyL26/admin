import { CircleHelp } from 'lucide-react';
import { Tooltip } from './Tooltip';

/**
 * Fragezeichen neben Zahlenfeldern, deren Pfeilknöpfe ganze Schritte machen,
 * die aber halbe Werte annehmen (Wochenstunden, Urlaubstage). Die Pfeile
 * zählen bewusst in ganzen Schritten, das war im Alltag weniger lästig.
 */
export function HalfStepHint() {
  return (
    <Tooltip
      content={
        <>
          <span className="hm-tooltip__title">Halbe Werte</span>
          <span className="hm-tooltip__line">Einfach eintippen, z. B. 27,5</span>
        </>
      }
    >
      <span
        className="hm-info-icon"
        tabIndex={0}
        aria-label="Halbe Werte einfach eintippen"
        // Sitzt in einem <label>: Ohne preventDefault ginge der Klick an das
        // Zahlenfeld und setzte dort den Cursor.
        onClick={(e) => e.preventDefault()}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
