import React from 'react';
import type { BadgeTone } from '../../components/ui';
import {
  todayIsoLocal,
  type GoalStatus,
  type ReviewStatus,
  type ReviewCycleStatus,
  type TrainingRegistrationStatus,
  type FeedbackMeetingStatus,
} from '@hrmonic/shared';

/** Gemeinsame Kleinteile des Leistungs-Moduls. */

export function ProgressBar({ value, height = 8 }: { value: number; height?: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      style={{
        background: 'var(--gray-100)',
        borderRadius: 999,
        height,
        width: '100%',
        overflow: 'hidden',
      }}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: '100%',
          borderRadius: 999,
          background: clamped >= 100 ? 'var(--success)' : 'var(--brand-primary)',
          transition: 'width .2s ease',
        }}
      />
    </div>
  );
}

export const GOAL_STATUS_TONES: Record<GoalStatus, BadgeTone> = {
  aktiv: 'blue',
  erreicht: 'green',
  verfehlt: 'red',
  abgebrochen: 'neutral',
};

export const REVIEW_STATUS_TONES: Record<ReviewStatus, BadgeTone> = {
  offen: 'neutral',
  in_bearbeitung: 'yellow',
  abgeschlossen: 'green',
};

export const CYCLE_STATUS_TONES: Record<ReviewCycleStatus, BadgeTone> = {
  geplant: 'neutral',
  laufend: 'blue',
  abgeschlossen: 'green',
};

export const REGISTRATION_STATUS_TONES: Record<TrainingRegistrationStatus, BadgeTone> = {
  angemeldet: 'blue',
  teilgenommen: 'yellow',
  abgeschlossen: 'green',
  storniert: 'neutral',
};

export const MEETING_STATUS_TONES: Record<FeedbackMeetingStatus, BadgeTone> = {
  geplant: 'blue',
  stattgefunden: 'green',
  abgesagt: 'neutral',
};

/** Farbcodierung der Skill-Levels 1–5 für die Matrix-Heatmap. */
export const SKILL_LEVEL_COLORS: Record<number, { bg: string; fg: string }> = {
  1: { bg: 'var(--blue-50)', fg: 'var(--text-primary)' },
  2: { bg: 'var(--blue-100)', fg: 'var(--text-primary)' },
  3: { bg: 'var(--blue-200)', fg: 'var(--text-primary)' },
  4: { bg: 'var(--blue-300)', fg: 'var(--text-primary)' },
  5: { bg: 'var(--blue-500)', fg: '#fff' },
};

export function todayIso(): string {
  return todayIsoLocal();
}
