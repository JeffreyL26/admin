import { LOCALE } from '../../lib/locale';
import { Tooltip } from '../../components/Tooltip';

/**
 * Gezaehlte Tage einer Abwesenheit fuer Tabellenzellen. Deckt eine
 * Betriebsruhe den Zeitraum ab (`closure_covered` aus dem Backend,
 * CLOSURE_COVERED_SQL), steht dort „Betriebsruhe“ statt einer 0; eine 0 aus
 * anderen Gruenden (Wochenende, Feiertag) bleibt eine 0.
 */
export function DaysCounted({ days, closureCovered }: { days: number | undefined; closureCovered?: number }) {
  if (closureCovered === 1) {
    return (
      <Tooltip
        content={
          <>
            <span className="hm-tooltip__title">Keine zu zählenden Tage</span>
            <span className="hm-tooltip__line">Zeitraum liegt in einer Betriebsruhe</span>
          </>
        }
      >
        <span className="hm-badge hm-badge--neutral" tabIndex={0}>
          Betriebsruhe
        </span>
      </Tooltip>
    );
  }
  return <>{days?.toLocaleString(LOCALE)}</>;
}
