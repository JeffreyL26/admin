import React, { useState } from 'react';
import { Plus, KanbanSquare, GripVertical } from 'lucide-react';
import { formatDate, type RecruitingStageDto } from '@ohrganize/shared';
import { api } from '../../api/client';
import { useToast } from '../../components/Toast';
import { PageHeader, Spinner, Avatar, EmptyState, Card } from '../../components/ui';
import { usePostings, useApplications, useStages, useInvalidate, type Application } from './api';
import { ApplicationDrawer, NewApplicationModal, RatingStars } from './common';

function ApplicationCard({
  app,
  onOpen,
  onDragStart,
}: {
  app: Application;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  return (
    <div
      className="hm-card hm-card--clickable"
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      style={{ padding: 10, cursor: 'grab' }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Avatar name={`${app.candidate_first_name} ${app.candidate_last_name}`} size={30} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            {app.candidate_first_name} {app.candidate_last_name}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {app.posting_title}
          </div>
        </div>
        <GripVertical size={14} style={{ color: 'var(--gray-300)', flexShrink: 0 }} />
      </div>
      <div className="row row--between" style={{ marginTop: 8 }}>
        <RatingStars value={app.rating} size={13} />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
          {(app.days_in_stage ?? 0)} T · {app.interview_count ?? 0} Iv
        </span>
      </div>
    </div>
  );
}

export function PipelinePage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: stages } = useStages();
  const { data: postings } = usePostings();
  const [postingFilter, setPostingFilter] = useState<number | ''>('');
  const { data: applications, isLoading } = useApplications({
    status: 'aktiv',
    posting_id: postingFilter || undefined,
  });
  const [openId, setOpenId] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<Record<number, number>>({});

  const activeStages: RecruitingStageDto[] = (stages ?? []).filter((s) => s.category === 'aktiv');
  const apps = applications ?? [];

  const byStage = (stageId: number) =>
    apps.filter((a) => (pendingMove[a.id] ?? a.stage_id) === stageId);

  // Optimistischer Move per Drag&Drop; Server-Aufruf über den API-Client.
  const move = async (appId: number, stageId: number) => {
    setPendingMove((m) => ({ ...m, [appId]: stageId }));
    try {
      await api.post(`/api/recruiting/applications/${appId}/stage`, { stage_id: stageId });
      invalidate();
    } catch (e) {
      setPendingMove((m) => {
        const next = { ...m };
        delete next[appId];
        return next;
      });
      toast.error(e instanceof Error ? e.message : 'Verschieben fehlgeschlagen');
    }
  };

  const onDrop = (stageId: number) => {
    if (dragId !== null) {
      const current = apps.find((a) => a.id === dragId);
      if (current && current.stage_id !== stageId) void move(dragId, stageId);
    }
    setDragId(null);
    setDragOverStage(null);
  };

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Bewerbungen per Drag & Drop durch die Auswahlstufen bewegen"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setNewOpen(true)}>
            <Plus size={16} /> Neue Bewerbung
          </button>
        }
      />

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <select className="hm-select" style={{ maxWidth: 280 }} value={postingFilter} onChange={(e) => setPostingFilter(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Alle Stellen</option>
          {(postings ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <Spinner center />
      ) : apps.length === 0 ? (
        <Card>
          <EmptyState icon={<KanbanSquare size={40} />} title="Keine aktiven Bewerbungen" hint="Erfassen Sie eine Bewerbung oder passen Sie den Filter an." />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${activeStages.length}, minmax(190px, 1fr))`, gap: 12, alignItems: 'start', overflowX: 'auto', paddingBottom: 8 }}>
          {activeStages.map((stage) => {
            const items = byStage(stage.id);
            const isOver = dragOverStage === stage.id;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage.id); }}
                onDragLeave={() => setDragOverStage((s) => (s === stage.id ? null : s))}
                onDrop={() => onDrop(stage.id)}
                style={{
                  background: isOver ? 'var(--blue-50)' : 'var(--bg-tint-1)',
                  border: `1px solid ${isOver ? 'var(--brand-primary)' : 'var(--border)'}`,
                  borderRadius: 10,
                  padding: 8,
                  minHeight: 120,
                  transition: 'background .12s',
                }}
              >
                <div className="row row--between" style={{ marginBottom: 8, padding: '2px 4px' }}>
                  <span className="row" style={{ gap: 6, fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: stage.color }} />
                    {stage.name}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{items.length}</span>
                </div>
                <div className="stack" style={{ gap: 8 }}>
                  {items.map((a) => (
                    <ApplicationCard
                      key={a.id}
                      app={a}
                      onOpen={() => setOpenId(a.id)}
                      onDragStart={() => setDragId(a.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ApplicationDrawer applicationId={openId} onClose={() => setOpenId(null)} />
      <NewApplicationModal open={newOpen} onClose={() => setNewOpen(false)} presetPostingId={postingFilter || null} />
    </>
  );
}
