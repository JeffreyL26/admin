/**
 * Eigene Gespraechsprotokolle im Portal (GET /api/me/meetings).
 *
 * Es erscheinen nur Protokolle, die die Personalabteilung mit Sichtbarkeit
 * „HR, Fuehrungskraefte und Mitarbeiter:in“ angelegt hat; alles andere
 * kennt das Backend fuer diese Route gar nicht. Reine Leseansicht: Das
 * Protokoll fuehrt die HR, Rueckfragen laufen ueber sie.
 */
import { useQuery } from '@tanstack/react-query';
import { MEETING_OCCASION_LABELS, type MeMeeting } from '@ohrganize/shared';
import { api } from '../api/client';
import { Card, EmptyState, LoadError, SkeletonRows } from '../components/ui';
import { formatDate, todayIso } from '../lib/format';

function useMyMeetings() {
  return useQuery({
    queryKey: ['me', 'meetings'],
    queryFn: () => api.get<{ meetings: MeMeeting[] }>('/api/me/meetings'),
    select: (d) => d.meetings,
  });
}

function TextBlock({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div>
      <span className="pt-label">{label}</span>
      <p style={{ marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{text}</p>
    </div>
  );
}

function MeetingCard({ meeting }: { meeting: MeMeeting }) {
  const followUpDue = meeting.follow_up_date !== null && meeting.follow_up_date <= todayIso();
  return (
    <article className="pt-card">
      <header className="pt-card__header">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 650 }}>{MEETING_OCCASION_LABELS[meeting.occasion] ?? meeting.occasion}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {formatDate(meeting.meeting_date)}
          </span>
        </div>
        {meeting.follow_up_date && (
          <span className={`pt-chip pt-chip--${followUpDue ? 'warning' : 'neutral'}`}>
            Wiedervorlage {formatDate(meeting.follow_up_date)}
          </span>
        )}
      </header>
      <div className="pt-card__body stack" style={{ gap: 16 }}>
        {meeting.participants && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Teilnehmende: </span>
            {meeting.participants}
          </div>
        )}
        <TextBlock label="Gesprächsinhalt" text={meeting.content} />
        <TextBlock label="Vereinbarungen" text={meeting.agreements} />
        {!meeting.content && !meeting.agreements && (
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Zu diesem Gespräch wurde kein Inhalt hinterlegt.
          </p>
        )}
      </div>
    </article>
  );
}

export function MeetingsPage() {
  const { data: meetings, isLoading, error } = useMyMeetings();

  return (
    <div style={{ maxWidth: 860 }}>
      <header className="portal-page-header">
        <h1 className="portal-title">Gesprächsprotokolle</h1>
        <p className="portal-subtitle">
          Protokolle Ihrer Mitarbeitergespräche, die die Personalabteilung für Sie freigegeben hat.
          Bei Rückfragen oder Einwänden wenden Sie sich bitte an die Personalabteilung.
        </p>
      </header>

      {error ? (
        <LoadError error={error} />
      ) : isLoading || !meetings ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : meetings.length === 0 ? (
        <Card>
          <EmptyState
            title="Noch keine freigegebenen Protokolle"
            hint="Sobald die Personalabteilung ein Gesprächsprotokoll für Sie freigibt, erscheint es hier."
          />
        </Card>
      ) : (
        <div className="stack">
          {meetings.map((m) => (
            <MeetingCard key={m.id} meeting={m} />
          ))}
        </div>
      )}
    </div>
  );
}
