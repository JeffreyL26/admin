import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Info } from 'lucide-react';
import { DOCUMENT_VISIBILITY_HR_HINT, DOCUMENT_VISIBILITY_LABELS, type DocumentVisibility } from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import type { DocumentRow } from './api';

const HR_TIP = (
  <>
    <span className="hm-tooltip__title">HR-intern</span>
    <span className="hm-tooltip__line">{DOCUMENT_VISIBILITY_HR_HINT}</span>
  </>
);

/** Info-Zeichen mit der Erklärung zu „HR-intern“ (Upload-Dialog). */
export function VisibilityHint() {
  return (
    <Tooltip content={HR_TIP}>
      <span className="hm-info-icon" tabIndex={0} aria-label="Erklärung zur Sichtbarkeit">
        <Info size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/** Kennzeichen in Listen: nur HR-interne Dokumente tragen eines, der Regelfall bleibt unbeschriftet. */
export function VisibilityBadge({ visibility }: { visibility: DocumentVisibility }) {
  if (visibility !== 'hr') return null;
  return (
    <Tooltip content={HR_TIP}>
      <span style={{ display: 'inline-flex' }}>
        <Badge tone="yellow">
          <EyeOff size={11} aria-hidden="true" /> {DOCUMENT_VISIBILITY_LABELS.hr}
        </Badge>
      </span>
    </Tooltip>
  );
}

export function useSetDocumentVisibility() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, visibility }: { id: number; visibility: DocumentVisibility }) =>
      api.patch(`/api/documents/${id}`, { visibility }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      toast.success(
        vars.visibility === 'hr' ? 'Dokument ist jetzt HR-intern' : 'Dokument ist jetzt im Portal sichtbar',
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Umschalter in der Aktionsspalte; nur für zugeordnete, aktuelle Dokumente sinnvoll. */
export function VisibilityToggle({ doc }: { doc: DocumentRow }) {
  const set = useSetDocumentVisibility();
  if (doc.employee_id === null) return null;
  const toHr = doc.visibility === 'portal';
  const label = toHr ? 'Auf HR-intern stellen' : 'Im Portal sichtbar machen';
  return (
    <Tooltip
      content={
        <>
          <span className="hm-tooltip__title">{label}</span>
          <span className="hm-tooltip__line">
            {toHr ? DOCUMENT_VISIBILITY_HR_HINT : 'Die zugeordnete Person sieht das Dokument wieder unter Dokumente im Portal.'}
          </span>
        </>
      }
    >
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
        aria-label={label}
        disabled={set.isPending}
        onClick={() => set.mutate({ id: doc.id, visibility: toHr ? 'hr' : 'portal' })}
      >
        {toHr ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </Tooltip>
  );
}
