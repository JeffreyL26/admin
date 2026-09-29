import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, MessageSquareText } from 'lucide-react';
import {
  MEETING_OCCASION_LABELS,
  formatDate,
  isFollowUpDue,
  moduleEnabled,
  todayIsoLocal,
  type LeaderMeeting,
  type MeetingOccasion,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { Badge, Card, EmptyState, Spinner } from '../../components/ui';
import { leaderFollowUpsQuery, useLeaderFollowUps, useTeamMemberMeetings } from './api';
import { TeamNotice } from './TeamShared';

/**
 * Gesprächsprotokolle in „Mein Team“. Die HR führt sie unter Kommunikation und
 * gibt sie je Protokoll für die Führung frei; hier sieht die zuständige
 * Führungskraft, was für sie bestimmt ist. Nur lesen. Beide Bausteine
 * erscheinen nur in Varianten mit Kommunikation (sonst gibt es die Routen
 * nicht) und laufen ausschließlich über /api/leadership/me/*, brauchen also
 * weder „kommunikation“ noch „personal“.
 */
const COMMUNICATION = moduleEnabled(VARIANT, 'communication');

/** URL-Parameter, mit dem „Fällige Wiedervorlagen“ ein bestimmtes Protokoll öffnet. */
export const PROTOCOL_PARAM = 'protokoll';

function occasionLabel(occasion: MeetingOccasion): string {
  return MEETING_OCCASION_LABELS[occasion] ?? occasion;
}

function TextBlock({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div>
      <div className="lead-meeting__label">{label}</div>
      <p className="lead-meeting__text">{text}</p>
    </div>
  );
}

function PortalBadge({ meeting }: { meeting: LeaderMeeting }) {
  if (meeting.released_to_employee !== 1) return null;
  return meeting.visible_to_employee === 1 ? (
    <Badge tone="blue">Auch im Portal sichtbar</Badge>
  ) : (
    <Badge tone="neutral">Für die Person freigegeben, ohne Portalzugang</Badge>
  );
}

function MeetingItem({
  meeting,
  open,
  focused,
  onToggle,
}: {
  meeting: LeaderMeeting;
  open: boolean;
  focused: boolean;
  onToggle: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const due = isFollowUpDue(meeting.follow_up_date, todayIsoLocal());
  // Aus „Fällige Wiedervorlagen“ angesprungen: einmal in den Blick holen.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  return (
    <details
      ref={ref}
      className={`lead-meeting${focused ? ' lead-meeting--focused' : ''}`}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next !== open) onToggle(next);
      }}
    >
      <summary className="lead-meeting__summary">
        <ChevronRight size={16} className="lead-meeting__chevron" aria-hidden="true" />
        <span className="lead-meeting__title">{occasionLabel(meeting.occasion)}</span>
        <span className="lead-meeting__date">{formatDate(meeting.meeting_date)}</span>
        <span className="lead-meeting__badges">
          {meeting.follow_up_date && (
            <Badge tone={due ? 'yellow' : 'neutral'}>Wiedervorlage {formatDate(meeting.follow_up_date)}</Badge>
          )}
          <PortalBadge meeting={meeting} />
        </span>
      </summary>
      <div className="lead-meeting__body">
        {meeting.participants && (
          <div className="lead-meeting__participants">
            <span className="lead-meeting__label">Teilnehmende: </span>
            {meeting.participants}
          </div>
        )}
        <TextBlock label="Gesprächsinhalt" text={meeting.content} />
        <TextBlock label="Vereinbarungen" text={meeting.agreements} />
        {!meeting.content && !meeting.agreements && (
          <p className="lead-meeting__text lead-meeting__text--muted">Zu diesem Gespräch wurde kein Inhalt hinterlegt.</p>
        )}
      </div>
    </details>
  );
}

/**
 * Freigegebene Protokolle einer Person auf ihrer Bewertungsseite.
 * `focusId`: Protokoll, das aufgeklappt und angesprungen wird (aus einer
 * Wiedervorlage); sonst ist das neueste offen. Der Aufklappzustand hängt an
 * der Protokoll-ID, nicht an der Position: ein neu freigegebenes Protokoll
 * klappt beim Nachladen nichts zu, was gerade gelesen wird.
 */
export function TeamMemberMeetings(props: { employeeId: number; firstName: string; focusId: number | null }) {
  return COMMUNICATION ? <TeamMemberMeetingsCard {...props} /> : null;
}

function TeamMemberMeetingsCard({
  employeeId,
  firstName,
  focusId,
}: {
  employeeId: number;
  firstName: string;
  focusId: number | null;
}) {
  const { data, error, isLoading } = useTeamMemberMeetings(employeeId);
  const [openIds, setOpenIds] = useState<Set<number> | null>(null);

  // Erste Antwort (oder neues Sprungziel) legt fest, was offen ist; danach
  // entscheidet allein die Person.
  useEffect(() => {
    if (!data) return;
    const initial = focusId !== null && data.some((m) => m.id === focusId) ? focusId : data[0]?.id;
    setOpenIds(new Set(initial === undefined ? [] : [initial]));
    // `data` bewusst nicht: Nachladen soll den Aufklappzustand nicht zurücksetzen.
  }, [employeeId, focusId, data === undefined]);

  const toggle = (id: number, open: boolean) =>
    setOpenIds((prev) => {
      const next = new Set(prev ?? []);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card title="Gesprächsprotokolle" flush={!!data && data.length > 0}>
      {error ? (
        <TeamNotice tone="warning">Die Gesprächsprotokolle konnten nicht geladen werden: {error.message}</TeamNotice>
      ) : isLoading || !data ? (
        <Spinner center />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText size={40} />}
          title="Keine freigegebenen Gesprächsprotokolle"
          hint={`Die HR entscheidet je Protokoll, ob die Führung es sieht. Sobald sie eines für ${firstName} freigibt, erscheint es hier.`}
        />
      ) : (
        <div>
          {data.map((m) => (
            <MeetingItem
              key={m.id}
              meeting={m}
              open={openIds?.has(m.id) ?? false}
              focused={m.id === focusId}
              onToggle={(open) => toggle(m.id, open)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Stößt die Abfrage der Wiedervorlagen parallel zur Teamabfrage an. Die Karte
 * selbst erscheint erst nach dem Team; ohne Vorabruf begänne ihr Request erst dann.
 */
export function usePrefetchLeaderFollowUps(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (COMMUNICATION) void qc.prefetchQuery(leaderFollowUpsQuery);
  }, [qc]);
}

/**
 * Fällige Wiedervorlagen über den ganzen Bereich. Erscheint nur, wenn es
 * welche gibt: keine feste Kachel, kein „keine Wiedervorlagen“. Ein Klick
 * öffnet die Person mit genau diesem Protokoll aufgeklappt.
 */
export function FollowUpsCard(props: { onOpen: (employeeId: number, meetingId: number) => void }) {
  return COMMUNICATION ? <FollowUpsList {...props} /> : null;
}

function FollowUpsList({ onOpen }: { onOpen: (employeeId: number, meetingId: number) => void }) {
  const { data } = useLeaderFollowUps();
  if (!data || data.length === 0) return null;
  const today = todayIsoLocal();

  return (
    <section className="lead-section lead-followups-section">
      <div className="lead-section__head">
        <h2 className="lead-section__title">
          <CalendarClock size={16} aria-hidden="true" />
          Fällige Wiedervorlagen
          <span className="lead-section__count">{data.length}</span>
        </h2>
        <span className="lead-section__hint">Aus Gesprächsprotokollen, die die HR für Sie freigegeben hat</span>
      </div>
      <div className="lead-followups">
        {data.map((m) => (
          <button key={m.id} type="button" className="lead-followup" onClick={() => onOpen(m.employee_id, m.id)}>
            <span className="lead-followup__name">
              {m.first_name} {m.last_name}
            </span>
            <span className="lead-followup__what">
              {occasionLabel(m.occasion)} vom {formatDate(m.meeting_date)}
            </span>
            <span className="lead-followup__due">
              {/* `>=` statt `===`: Liegt die Serveruhr einen Tag vor dem
                  Arbeitsplatz (andere Zeitzone), stünde sonst „Fällig seit“
                  mit einem Datum in der Zukunft da. */}
              {(m.follow_up_date as string) >= today
                ? 'Heute fällig'
                : `Fällig seit ${formatDate(m.follow_up_date as string)}`}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
