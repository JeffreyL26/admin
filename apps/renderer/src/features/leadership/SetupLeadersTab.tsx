import React, { useMemo, useState } from 'react';
import { Handshake, Plus, Users, UserX } from 'lucide-react';
import { formatDate, type Leader } from '@ohrganize/shared';
import { Avatar, Badge, Card, EmptyState, Field, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { usePhotoUrl } from '../employees/api';
import { useGrantLeader, useLeaders, useRevokeLeader, useUpdateLeader } from './api';
import { SetupScopeModal } from './SetupScopeModal';
import { SetupEmployeeSelect, SetupNote, errorMessage, personCount } from './SetupShared';

/**
 * Reiter „Führungskräfte“: Wer ist freigeschaltet, wofür ist die Person
 * zuständig, hat sie ein Desktop-Konto? Freischalten, Automatik umschalten,
 * Zuständigkeit ansehen/ergänzen, entziehen.
 */
export function SetupLeadersTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data: leaders, isLoading } = useLeaders();
  const update = useUpdateLeader();
  const revoke = useRevokeLeader();
  const [granting, setGranting] = useState(false);
  const [scopeFor, setScopeFor] = useState<Leader | null>(null);
  const [revoking, setRevoking] = useState<Leader | null>(null);
  /** Server-Warnungen der letzten Freischaltung (z. B. gegenseitige Verantwortung). */
  const [warnings, setWarnings] = useState<string[]>([]);

  const toggleAuto = (leader: Leader) =>
    update.mutate(
      { employeeId: leader.employee_id, patch: { auto_scope: leader.auto_scope !== 1 } },
      {
        onSuccess: () =>
          toast.success(
            leader.auto_scope === 1
              ? 'Automatische Ableitung ausgeschaltet — nur manuelle Zuweisungen gelten'
              : 'Zuständigkeit wird wieder automatisch aus der Organisation abgeleitet',
          ),
        onError: (e) => toast.error(errorMessage(e, 'Änderung fehlgeschlagen')),
      },
    );

  return (
    <div className="stack">
      <SetupNote>
        Die Zuständigkeit einer Führungskraft ergibt sich <strong>automatisch aus der Organisation</strong>:
        als Vorgesetzte:r (Feld „Vorgesetzte:r“ im Personalprofil), als Abteilungsleitung (alle
        Mitarbeitenden der Abteilung inklusive Unterabteilungen) und als Teamleitung (alle Teammitglieder).
        Ergänzungen und Ausnahmen — etwa für Projekte, Vertretungen oder Matrixstrukturen — pflegen Sie
        manuell unter „Zuständigkeit“. Die Funktion erscheint der Person als <strong>„Mein Team“</strong> in
        der Seitenleiste, sobald ihr Desktop-Konto mit dem Personalprofil verknüpft ist.
      </SetupNote>

      {warnings.length > 0 && (
        <SetupNote tone="warning" icon={<Handshake size={15} />} onDismiss={() => setWarnings([])}>
          {warnings.join(' ')}
        </SetupNote>
      )}

      <Card
        title="Freigeschaltete Führungskräfte"
        flush
        actions={
          canEdit ? (
            <button type="button" className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setGranting(true)}>
              <Plus size={15} /> Führungskraft freischalten
            </button>
          ) : undefined
        }
      >
        {isLoading ? (
          <Spinner center />
        ) : (leaders?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Users size={40} />}
            title="Noch keine Führungskräfte freigeschaltet"
            hint={
              canEdit
                ? 'Schalten Sie die erste Person frei. Sie sieht anschließend „Mein Team“ mit allen ihr zugeordneten Mitarbeitenden und kann diese je Zeitraum bewerten.'
                : 'Freischaltungen nimmt ein Konto mit Bearbeitungsrecht im Bereich „Führung“ vor.'
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Abteilung</th>
                  <th>Konto</th>
                  <th>Zuständigkeit</th>
                  <th style={{ width: 150 }}>Freigeschaltet</th>
                  <th style={{ width: canEdit ? 330 : 130 }} />
                </tr>
              </thead>
              <tbody>
                {leaders!.map((l) => (
                  <LeaderRow
                    key={l.employee_id}
                    leader={l}
                    canEdit={canEdit}
                    busy={update.isPending || revoke.isPending}
                    onScope={() => setScopeFor(l)}
                    onToggleAuto={() => toggleAuto(l)}
                    onRevoke={() => setRevoking(l)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <GrantDialog
        open={granting}
        existing={leaders ?? []}
        onClose={() => setGranting(false)}
        onWarnings={setWarnings}
      />
      <SetupScopeModal leader={scopeFor} canEdit={canEdit} onClose={() => setScopeFor(null)} />
      <ConfirmDialog
        open={revoking !== null}
        title={`Freischaltung für „${revoking ? `${revoking.first_name} ${revoking.last_name}` : ''}“ entziehen?`}
        confirmLabel="Entziehen"
        message={
          <>
            Die Person verliert den Zugang zu „Mein Team“ und kann keine Bewertungen mehr abgeben. Ihre
            manuellen Zuweisungen werden entfernt.{' '}
            <strong>Bereits abgegebene Bewertungen und das Protokoll bleiben vollständig erhalten</strong> und
            sind weiterhin in der Einsicht und im Report sichtbar.
          </>
        }
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.employee_id, {
            onSuccess: () => toast.success('Freischaltung entzogen'),
            onError: (e) => toast.error(errorMessage(e, 'Entziehen fehlgeschlagen')),
          })
        }
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabellenzeile
// ---------------------------------------------------------------------------

function LeaderRow({
  leader,
  canEdit,
  busy,
  onScope,
  onToggleAuto,
  onRevoke,
}: {
  leader: Leader;
  canEdit: boolean;
  busy: boolean;
  onScope: () => void;
  onToggleAuto: () => void;
  onRevoke: () => void;
}) {
  // Kein photo_url in der Leader-Antwort: usePhotoUrl signiert selbst und
  // fällt ohne personal:lesen still auf Initialen zurück.
  const photo = usePhotoUrl(leader.photo_file_id);
  const name = `${leader.first_name} ${leader.last_name}`;
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 10 }}>
          <Avatar name={name} size={34} src={photo.data} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{name}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {leader.job_title ?? '—'}
              {leader.personnel_number ? ` · ${leader.personnel_number}` : ''}
            </div>
          </div>
        </div>
      </td>
      <td style={{ color: 'var(--text-secondary)' }}>{leader.department_name ?? '—'}</td>
      <td>
        {leader.user_id !== null ? (
          <div className="stack" style={{ gap: 3 }}>
            <span>
              <Badge tone="green">Desktop-Konto</Badge>
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{leader.user_email}</span>
          </div>
        ) : (
          <Tooltip
            content={
              <>
                <div className="hm-tooltip__title">Kein Desktop-Konto verknüpft</div>
                <div className="hm-tooltip__line">Verwaltung → Benutzer &amp; Rechte: Konto anlegen</div>
                <div className="hm-tooltip__line">Mit diesem Profil verknüpfen · z. B. Admin-Rolle „Führungskraft“</div>
                <div className="hm-tooltip__line">Bis dahin sieht die Person „Mein Team“ nicht</div>
              </>
            }
          >
            <span>
              <Badge tone="yellow">Kein Desktop-Konto</Badge>
            </span>
          </Tooltip>
        )}
      </td>
      <td>
        <div className="stack" style={{ gap: 3 }}>
          <span style={{ fontWeight: 600 }}>{personCount(leader.team_size)}</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {leader.auto_scope === 1 ? 'automatisch' : 'nur manuell'}
            {' · '}
            {leader.assignment_count} {leader.assignment_count === 1 ? 'Zuweisung' : 'Zuweisungen'}
          </span>
        </div>
      </td>
      <td style={{ color: 'var(--text-secondary)' }}>
        <div className="stack" style={{ gap: 3 }}>
          <span>{formatDate(leader.created_at.slice(0, 10))}</span>
          {leader.granted_by_name && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>von {leader.granted_by_name}</span>
          )}
        </div>
      </td>
      <td>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button type="button" className="hm-btn hm-btn--sm hm-btn--secondary" onClick={onScope}>
            <Users size={14} /> Zuständigkeit
          </button>
          {canEdit && (
            <>
              <Tooltip
                content={
                  <>
                    <div className="hm-tooltip__title">Automatische Ableitung</div>
                    <div className="hm-tooltip__line">
                      {leader.auto_scope === 1
                        ? 'An · Organisation + manuelle Zuweisungen'
                        : 'Aus · nur manuelle Zuweisungen'}
                    </div>
                  </>
                }
              >
                <button
                  type="button"
                  className="hm-btn hm-btn--sm hm-btn--ghost"
                  disabled={busy}
                  aria-pressed={leader.auto_scope === 1}
                  onClick={onToggleAuto}
                >
                  {leader.auto_scope === 1 ? 'Automatik aus' : 'Automatik an'}
                </button>
              </Tooltip>
              <button
                type="button"
                className="hm-btn hm-btn--sm hm-btn--ghost"
                style={{ color: 'var(--danger)' }}
                disabled={busy}
                onClick={onRevoke}
              >
                <UserX size={14} /> Entziehen
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Dialog: Führungskraft freischalten
// ---------------------------------------------------------------------------

function GrantDialog({
  open,
  existing,
  onClose,
  onWarnings,
}: {
  open: boolean;
  existing: Leader[];
  onClose: () => void;
  onWarnings: (warnings: string[]) => void;
}) {
  const toast = useToast();
  const grant = useGrantLeader();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [autoScope, setAutoScope] = useState(true);
  const [note, setNote] = useState('');

  const exclude = useMemo(() => new Set(existing.map((l) => l.employee_id)), [existing]);

  const reset = () => {
    setEmployeeId(null);
    setAutoScope(true);
    setNote('');
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = () => {
    if (employeeId === null) return;
    grant.mutate(
      { employee_id: employeeId, auto_scope: autoScope, note: note.trim() || null },
      {
        onSuccess: (res) => {
          toast.success(`${res.leader.first_name} ${res.leader.last_name} als Führungskraft freigeschaltet`);
          onWarnings(res.warnings);
          close();
        },
        onError: (e) => toast.error(errorMessage(e, 'Freischaltung fehlgeschlagen')),
      },
    );
  };

  return (
    <Modal
      title="Führungskraft freischalten"
      open={open}
      onClose={close}
      footer={
        <>
          <button type="button" className="hm-btn hm-btn--secondary" onClick={close}>
            Abbrechen
          </button>
          <button
            type="button"
            className="hm-btn hm-btn--primary"
            disabled={employeeId === null || grant.isPending}
            onClick={submit}
          >
            Freischalten
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field
          label="Person"
          required
          span2
          hint="Nur aktive Mitarbeitende; bereits freigeschaltete Personen werden nicht angeboten."
        >
          <SetupEmployeeSelect value={employeeId} onChange={setEmployeeId} exclude={exclude} autoFocus />
        </Field>
        <div className="span-2">
          <label className="hm-checkbox">
            <input type="checkbox" checked={autoScope} onChange={(e) => setAutoScope(e.target.checked)} />
            <span>Zuständigkeit automatisch aus der Organisation ableiten</span>
          </label>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Empfohlen. Ohne Automatik gelten ausschließlich manuelle Zuweisungen — sinnvoll etwa für
            HR-Sachbearbeiter:innen, die gezielt einzelne Personen bewerten sollen.
          </p>
        </div>
        <Field label="Notiz" span2 hint="Optional, z. B. Anlass der Freischaltung. Nur in der Verwaltung sichtbar.">
          <textarea
            className="hm-textarea"
            rows={2}
            value={note}
            maxLength={400}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className="span-2">
          <SetupNote>
            Ein Personalprofil ohne Desktop-Konto darf freigeschaltet werden. Damit die Person „Mein Team“
            sieht, legen Sie unter <strong>Verwaltung → Benutzer &amp; Rechte</strong> ein Konto an und verknüpfen
            es mit dem Profil (z. B. mit der Admin-Rolle „Führungskraft“).
          </SetupNote>
        </div>
      </div>
    </Modal>
  );
}
