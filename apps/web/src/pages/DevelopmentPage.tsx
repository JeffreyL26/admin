import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FEEDBACK_MEETING_KIND_LABELS,
  FEEDBACK_MEETING_STATUS_LABELS,
  GOAL_KIND_LABELS,
  GOAL_STATUS_LABELS,
  TRAINING_REGISTRATION_STATUS_LABELS,
  type FeedbackMeetingStatus,
  type GoalStatus,
  type MeDevelopmentGoal,
  type MeDevelopmentMeeting,
  type MeDevelopmentResponse,
  type MeDevelopmentSkill,
  type MeDevelopmentTraining,
  type TrainingRegistrationStatus,
} from '@ohrganize/shared';
import { api } from '../api/client';
import { Card, EmptyState, LoadError, SkeletonRows } from '../components/ui';
import { Tooltip } from '../components/Tooltip';
import { formatDate, todayIso } from '../lib/format';

/**
 * „Meine Entwicklung“: die eigene Sicht auf Ziele, Trainings, Gespräche,
 * Skills. Eine Anfrage, vier Karten; leere Blöcke erscheinen nicht, und wenn alles leer ist, sagt die
 * Seite das einmal statt fünfmal.
 */
function useMyDevelopment() {
  return useQuery({
    queryKey: ['me', 'development'],
    queryFn: () => api.get<MeDevelopmentResponse>('/api/me/development'),
  });
}

const GOAL_STATUS_TONES: Record<GoalStatus, string> = {
  aktiv: 'info',
  erreicht: 'success',
  verfehlt: 'danger',
  abgebrochen: 'neutral',
};

const REGISTRATION_TONES: Record<TrainingRegistrationStatus, string> = {
  angemeldet: 'info',
  teilgenommen: 'warning',
  abgeschlossen: 'success',
  storniert: 'neutral',
};

const MEETING_TONES: Record<FeedbackMeetingStatus, string> = {
  geplant: 'info',
  stattgefunden: 'success',
  abgesagt: 'neutral',
};


function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`pt-chip pt-chip--${tone}`}>{children}</span>;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      style={{ background: 'var(--gray-100)', borderRadius: 999, height: 8, width: '100%', overflow: 'hidden' }}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: '100%',
          borderRadius: 999,
          background: clamped >= 100 ? 'var(--success)' : 'var(--brand-primary)',
        }}
      />
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Ziele
// ---------------------------------------------------------------------------

function GoalRow({ goal, indent }: { goal: MeDevelopmentGoal; indent?: boolean }) {
  return (
    <div style={{ marginLeft: indent ? 24 : 0, display: 'grid', gap: 6 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{goal.title}</span>
        <Chip tone="neutral">{GOAL_KIND_LABELS[goal.kind]}</Chip>
        <Chip tone={GOAL_STATUS_TONES[goal.status]}>{GOAL_STATUS_LABELS[goal.status]}</Chip>
        <span style={{ marginLeft: 'auto', fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-numeric)' }}>
          {goal.progress} %
        </span>
      </div>
      {goal.description && <Muted>{goal.description}</Muted>}
      {(goal.metric || goal.period_from) && (
        <Muted>
          {goal.metric && (
            <>
              {goal.metric}
              {goal.target_value ? ` · Ziel ${goal.target_value}` : ''}
              {goal.current_value ? ` · aktuell ${goal.current_value}` : ''}
            </>
          )}
          {goal.metric && goal.period_from ? ' · ' : ''}
          {goal.period_from && `${formatDate(goal.period_from)} bis ${formatDate(goal.period_to)}`}
        </Muted>
      )}
      <ProgressBar value={goal.progress} label={`Fortschritt ${goal.title}`} />
    </div>
  );
}

function GoalsCard({ goals }: { goals: MeDevelopmentGoal[] }) {
  const objectives = goals.filter((g) => g.kind === 'objective');
  const keyResults = (id: number) => goals.filter((g) => g.kind === 'key_result' && g.parent_goal_id === id);
  const orphans = goals.filter((g) => g.kind === 'key_result' && !objectives.some((o) => o.id === g.parent_goal_id));
  const kpis = goals.filter((g) => g.kind === 'kpi');
  const active = goals.filter((g) => g.status === 'aktiv').length;
  return (
    <Card title="Meine Ziele" actions={<Muted>{active} aktiv · {goals.length} gesamt</Muted>}>
      <div style={{ display: 'grid', gap: 18 }}>
        {objectives.map((o) => (
          <div key={o.id} style={{ display: 'grid', gap: 12 }}>
            <GoalRow goal={o} />
            {keyResults(o.id).map((kr) => (
              <GoalRow key={kr.id} goal={kr} indent />
            ))}
          </div>
        ))}
        {[...orphans, ...kpis].map((g) => (
          <GoalRow key={g.id} goal={g} />
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trainings
// ---------------------------------------------------------------------------

function TrainingsCard({ trainings }: { trainings: MeDevelopmentTraining[] }) {
  return (
    <Card title="Meine Trainings" flush>
      <div className="pt-table-wrap">
        <table className="pt-table">
          <thead>
            <tr>
              <th>Training</th>
              <th>Termin</th>
              <th>Status</th>
              <th>Abgeschlossen</th>
            </tr>
          </thead>
          <tbody>
            {trainings.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ fontWeight: 600 }}>{t.training_title}</span>
                    {t.mandatory ? <Chip tone="neutral">Pflicht</Chip> : null}
                  </div>
                  {t.provider && (
                    <div>
                      <Muted>{t.provider}</Muted>
                    </div>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{t.date ? formatDate(t.date) : 'offen'}</td>
                <td>
                  <Chip tone={REGISTRATION_TONES[t.status]}>{TRAINING_REGISTRATION_STATUS_LABELS[t.status]}</Chip>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{t.completed_at ? formatDate(t.completed_at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Gespräche
// ---------------------------------------------------------------------------

function MeetingItem({ meeting, today }: { meeting: MeDevelopmentMeeting; today: string }) {
  const overdue = meeting.status === 'geplant' && meeting.scheduled_date < today;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{FEEDBACK_MEETING_KIND_LABELS[meeting.kind]}</span>
        <Chip tone={MEETING_TONES[meeting.status]}>{FEEDBACK_MEETING_STATUS_LABELS[meeting.status]}</Chip>
        {overdue && <Chip tone="warning">Termin liegt zurück</Chip>}
        <Muted>
          {formatDate(meeting.scheduled_date)}
          {meeting.held_date ? ` · stattgefunden am ${formatDate(meeting.held_date)}` : ''}
          {meeting.recurrence_months ? ` · alle ${meeting.recurrence_months} Monate` : ''}
        </Muted>
      </div>
      {meeting.actions.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          {meeting.actions.map((a) => (
            <li
              key={a.id}
              style={a.status === 'erledigt' ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}
            >
              {a.title}
              <Muted>
                {a.owner_name ? ` · ${a.owner_name}` : ''}
                {a.due_date ? ` · fällig ${formatDate(a.due_date)}` : ''}
              </Muted>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MeetingsCard({ meetings }: { meetings: MeDevelopmentMeeting[] }) {
  const today = todayIso();
  const upcoming = meetings.filter((m) => m.status === 'geplant').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  const past = meetings.filter((m) => m.status !== 'geplant');
  return (
    <Card title="Meine Gespräche">
      <div style={{ display: 'grid', gap: 18 }}>
        {upcoming.length > 0 && (
          <section style={{ display: 'grid', gap: 12 }}>
            <span className="pt-label">Anstehend</span>
            {upcoming.map((m) => (
              <MeetingItem key={m.id} meeting={m} today={today} />
            ))}
          </section>
        )}
        {past.length > 0 && (
          <section style={{ display: 'grid', gap: 12 }}>
            <span className="pt-label">Vergangen</span>
            {past.map((m) => (
              <MeetingItem key={m.id} meeting={m} today={today} />
            ))}
          </section>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function SkillsCard({ skills }: { skills: MeDevelopmentSkill[] }) {
  const byCategory = new Map<string, MeDevelopmentSkill[]>();
  for (const s of skills) {
    const key = s.category ?? 'Ohne Kategorie';
    byCategory.set(key, [...(byCategory.get(key) ?? []), s]);
  }
  return (
    <Card title="Meine Skills">
      <div style={{ display: 'grid', gap: 14 }}>
        {[...byCategory.entries()].map(([category, list]) => (
          <div key={category} style={{ display: 'grid', gap: 6 }}>
            <span className="pt-label">{category}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {list.map((s) => (
                <Tooltip
                  key={s.skill_id}
                  content={
                    <>
                      <div className="pt-tooltip__title">{s.name}</div>
                      <div className="pt-tooltip__line">
                        Level {s.level} von 5{s.assessed_at ? ` · Stand ${formatDate(s.assessed_at)}` : ''}
                      </div>
                    </>
                  }
                >
                  <span className="pt-chip pt-chip--neutral" tabIndex={0}>
                    {s.name} · {s.level}/5
                  </span>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function DevelopmentPage() {
  const { data, isLoading, error } = useMyDevelopment();
  const empty =
    !!data &&
    data.goals.length === 0 &&
    data.trainings.length === 0 &&
    data.meetings.length === 0 &&
    data.skills.length === 0;

  return (
    <div>
      <header className="portal-page-header">
        <h1 className="portal-title">Meine Entwicklung</h1>
        <p className="portal-subtitle">
          Ziele, Trainings, Gespräche und Skills auf einen Blick.
        </p>
      </header>

      <div className="stack">
        {error ? (
          <Card>
            <LoadError error={error} />
          </Card>
        ) : isLoading || !data ? (
          <Card>
            <SkeletonRows rows={5} />
          </Card>
        ) : empty ? (
          <Card flush>
            <EmptyState
              title="Noch nichts hinterlegt"
              hint="Sobald die Personalabteilung Ziele, Trainings oder Gespräche für Sie anlegt, erscheint es hier."
            />
          </Card>
        ) : (
          <>
            {data.goals.length > 0 && <GoalsCard goals={data.goals} />}
            {data.meetings.length > 0 && <MeetingsCard meetings={data.meetings} />}
            {data.trainings.length > 0 && <TrainingsCard trainings={data.trainings} />}
            {data.skills.length > 0 && <SkillsCard skills={data.skills} />}
          </>
        )}
      </div>
    </div>
  );
}
