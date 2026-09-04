import React, { useState } from 'react';
import { CalendarClock, Clock, Users } from 'lucide-react';
import {
  INTERVIEW_KIND_LABELS, INTERVIEW_STATUS_LABELS, INTERVIEW_RECOMMENDATION_LABELS,
  formatDate, type InterviewDto,
} from '@ohrganize/shared';
import { Badge, Card, EmptyState, PageHeader, Spinner, Tabs } from '../../components/ui';
import { useInterviews } from './api';
import { ApplicationDrawer, InterviewEditor } from './common';

function timeOf(scheduledAt: string): string {
  return scheduledAt.length > 10 ? scheduledAt.slice(11, 16) : '';
}

function InterviewRow({
  iv,
  onFeedback,
  onOpenApplication,
}: {
  iv: InterviewDto;
  onFeedback: () => void;
  onOpenApplication: () => void;
}) {
  const time = timeOf(iv.scheduled_at);
  return (
    <div className="row row--between" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>{iv.candidate_first_name} {iv.candidate_last_name}</strong>
          <Badge tone={iv.status === 'stattgefunden' ? 'green' : iv.status === 'abgesagt' ? 'neutral' : 'blue'}>
            {INTERVIEW_STATUS_LABELS[iv.status]}
          </Badge>
          {iv.recommendation && (
            <Badge tone={iv.recommendation === 'ja' ? 'green' : iv.recommendation === 'nein' ? 'red' : 'yellow'}>
              {INTERVIEW_RECOMMENDATION_LABELS[iv.recommendation]}
            </Badge>
          )}
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
          <span>{INTERVIEW_KIND_LABELS[iv.kind]}</span>
          <span className="row" style={{ gap: 3 }}><Clock size={12} /> {formatDate(iv.scheduled_at.slice(0, 10))}{time ? ` ${time}` : ''}</span>
          {iv.interviewer_names && iv.interviewer_names.length > 0 && (
            <span className="row" style={{ gap: 3 }}><Users size={12} /> {iv.interviewer_names.join(', ')}</span>
          )}
          <span>· {iv.posting_title}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
        <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={onOpenApplication}>Bewerbung</button>
        <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={onFeedback}>
          {iv.status === 'geplant' ? 'Bearbeiten' : 'Feedback'}
        </button>
      </div>
    </div>
  );
}

export function InterviewsPage() {
  const [tab, setTab] = useState('upcoming');
  const { data: upcoming, isLoading: loadingUpcoming } = useInterviews({ upcoming: true });
  const { data: all, isLoading: loadingAll } = useInterviews();
  const [editIv, setEditIv] = useState<InterviewDto | null>(null);
  const [appId, setAppId] = useState<number | null>(null);

  const list = tab === 'upcoming' ? upcoming : all;
  const isLoading = tab === 'upcoming' ? loadingUpcoming : loadingAll;

  return (
    <>
      <PageHeader title="Interviews" subtitle="Geplante Gespräche und Feedback-Erfassung" />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'upcoming', label: `Anstehend${upcoming ? ` (${upcoming.length})` : ''}` },
          { key: 'all', label: 'Alle Interviews' },
        ]}
      />

      <div style={{ marginTop: 16 }}>
        {isLoading ? (
          <Spinner center />
        ) : (list?.length ?? 0) === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarClock size={40} />}
              title={tab === 'upcoming' ? 'Keine anstehenden Interviews' : 'Noch keine Interviews'}
              hint="Interviews planen Sie direkt aus einer Bewerbung heraus."
            />
          </Card>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {list!.map((iv) => (
              <InterviewRow
                key={iv.id}
                iv={iv}
                onFeedback={() => setEditIv(iv)}
                onOpenApplication={() => setAppId(iv.application_id)}
              />
            ))}
          </div>
        )}
      </div>

      {editIv && (
        <InterviewEditor
          open={editIv !== null}
          applicationId={editIv.application_id}
          interview={editIv}
          onClose={() => setEditIv(null)}
        />
      )}
      <ApplicationDrawer applicationId={appId} onClose={() => setAppId(null)} />
    </>
  );
}
