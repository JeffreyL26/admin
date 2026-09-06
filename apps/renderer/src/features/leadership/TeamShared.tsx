import React from 'react';
import { AlertTriangle, ArrowLeft, Info, LockKeyhole, UserX } from 'lucide-react';
import { RATING_PERIOD_LABELS, periodFromKey, periodKindOfKey, type RatingPeriodKind } from '@ohrganize/shared';
import { ApiRequestError } from '../../api/client';
import { EmptyState } from '../../components/ui';

/**
 * Bausteine der Führungsfunktion („Mein Team“ und Bewertungsmaske). Beide
 * Seiten laufen ausschließlich über /api/leadership/me/* — sie müssen auch
 * für Führungskräfte OHNE das Recht „personal“ funktionieren, deshalb
 * greift hier nichts auf die Personalakte zu.
 */

/** 403 der Führungsfunktion: Konto nicht freigeschaltet oder Person außerhalb des Bereichs. */
export function isForbidden(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 403;
}

/** Hinweisbox in Info- oder Warnton — nur Tokens, themetauglich. */
export function TeamNotice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning';
  children: React.ReactNode;
}) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  return (
    <div className={`lead-notice lead-notice--${tone}`} role={tone === 'warning' ? 'alert' : 'note'}>
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** Leerseite für Konten, für die die Führungsfunktion nicht freigeschaltet ist. */
export function LeaderLockedState() {
  return (
    <div className="hm-card">
      <EmptyState
        icon={<LockKeyhole size={40} />}
        title="Die Führungsfunktion ist für Ihr Konto nicht freigeschaltet"
        hint="Die HR schaltet Führungskräfte unter Führung → Einrichtung frei. Voraussetzung ist ein mit Ihrem Konto verknüpftes Personalprofil."
      />
    </div>
  );
}

/** Leerseite, wenn eine Person nicht (mehr) zum eigenen Zuständigkeitsbereich gehört. */
export function OutOfScopeState({ message, onBack }: { message?: string; onBack: () => void }) {
  return (
    <div className="hm-card">
      <EmptyState
        icon={<UserX size={40} />}
        title="Diese Person gehört nicht zu Ihrem Zuständigkeitsbereich"
        hint={
          message ??
          'Die Zuständigkeit ergibt sich aus der Organisation oder aus Zuweisungen der HR unter Führung → Einrichtung.'
        }
        action={
          <button type="button" className="hm-btn hm-btn--secondary" onClick={onBack}>
            <ArrowLeft size={16} /> Zu Mein Team
          </button>
        }
      />
    </div>
  );
}

/**
 * Anzeige eines Zeitraum-Schlüssels. Nur Schlüssel der eingestellten Kadenz
 * bekommen das Label („Q3 2026“); Bewertungen aus einer früheren Kadenz
 * (etwa „2026-05“ nach Umstellung auf Quartale) zeigen den rohen Schlüssel
 * mit Kadenz-Hinweis — so bleibt sichtbar, dass sie nicht ins aktuelle
 * Raster passen und im Wechsler nicht ansteuerbar sind.
 */
export function PeriodText({ periodKey, kind }: { periodKey: string; kind: RatingPeriodKind }) {
  const detected = periodKindOfKey(periodKey);
  if (detected === kind) return <>{periodFromKey(periodKey).label}</>;
  return (
    <>
      {periodKey}
      {detected && (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginLeft: 6 }}>
          ({RATING_PERIOD_LABELS[detected]})
        </span>
      )}
    </>
  );
}

/** Kürzt Fließtext für Tabellenzellen; der volle Text steht im Protokoll. */
export function truncate(text: string, max = 90): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}
