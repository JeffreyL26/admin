import React, { useState } from 'react';
import { Check, Inbox, X } from 'lucide-react';
import {
  EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS,
  formatDateTime,
  selfEditableField,
  type EmployeeChangeRequestField,
  type EmployeeChangeRequestForHr,
  type EmployeeChangeRequestStatus,
} from '@ohrganize/shared';
import { ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs, type BadgeTone } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useDecideChangeRequest, useEmployeeChangeRequests } from './api';

/**
 * Änderungsanträge zu Stammdaten — Entscheidungsseite der Personalabteilung.
 *
 * Gegenstück zum Mitarbeitenden-Portal: Dort wird beantragt, hier wird
 * entschieden. Genehmigen schreibt die Personalakte (das erledigt das Backend
 * in einer Transaktion), Ablehnen verlangt eine Begründung — sie ist das
 * einzige, was die Person zur Ablehnung zu sehen bekommt. Eine
 * E-Mail-Benachrichtigung gibt es nicht; kein Text hier darf eine versprechen.
 */

const STATUS_TONES: Record<EmployeeChangeRequestStatus, BadgeTone> = {
  beantragt: 'yellow',
  genehmigt: 'green',
  abgelehnt: 'red',
  zurueckgezogen: 'neutral',
};

type Decision = 'genehmigt' | 'abgelehnt';
interface DecisionTarget {
  request: EmployeeChangeRequestForHr;
  decision: Decision;
}

/** Ein leeres Feld ist eine Aussage („bitte löschen“) und braucht ein Zeichen. */
const EMPTY_VALUE = '(leer)';

const MUTED_LINE: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-muted)',
  marginTop: 2,
};

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function EmployeeCell({ request }: { request: EmployeeChangeRequestForHr }) {
  return (
    <>
      <div style={{ fontWeight: 600 }}>
        {request.last_name}, {request.first_name}
      </div>
      <div style={MUTED_LINE}>{request.personnel_number ?? 'ohne Personalnummer'}</div>
    </>
  );
}

/**
 * Gegenüberstellung „Bisher → Gewünscht“. Der alte Wert steht gedämpft, der
 * gewünschte kräftig — beim Überfliegen einer Liste zählt, was neu wird.
 *
 * Die Personalabteilung sieht Bankdaten im Klartext (das Portal nur gekürzt);
 * der Vermerk „vertraulich“ erinnert daran, dass diese Zeile mehr zeigt als
 * die antragstellende Person selbst zu sehen bekommt.
 */
function FieldDiff({ fields }: { fields: EmployeeChangeRequestField[] }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {fields.map((f) => (
        <div key={f.field}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            {f.label}
            {selfEditableField(f.field)?.confidential && (
              <span style={{ color: 'var(--text-muted)' }}> · vertraulich</span>
            )}
          </div>
          <div style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--text-muted)' }}>{f.old_value ?? EMPTY_VALUE}</span>
            <span style={{ color: 'var(--text-muted)' }}> → </span>
            <strong>{f.new_value ?? EMPTY_VALUE}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Vier-Augen-Prinzip, erster Arm: Ein HR-Konto MIT verknüpftem Personalprofil
 * darf den Antrag zum eigenen Profil nicht genehmigen (Backend: 400). Die
 * Schaltfläche wird deshalb gar nicht erst angeboten, statt sie in den Fehler
 * laufen zu lassen. Ablehnen bleibt erlaubt — das ist kein Entscheid zugunsten
 * der eigenen Sache. Den zweiten Arm (jemand genehmigt einen Antrag, den er
 * selbst gestellt hat) kann die Liste nicht erkennen: Sie kennt nur den Namen
 * der antragstellenden Person, nicht deren Benutzerkonto. Dort greift die
 * Fehlermeldung des Backends.
 */
function useIsOwnProfile() {
  const { user } = useAuth();
  const ownEmployeeId = user?.employee_id ?? null;
  return (r: EmployeeChangeRequestForHr) => ownEmployeeId !== null && r.employee_id === ownEmployeeId;
}

function DecisionButtons({
  request,
  isOwnProfile,
  onDecide,
}: {
  request: EmployeeChangeRequestForHr;
  isOwnProfile: boolean;
  onDecide: (target: DecisionTarget) => void;
}) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      {isOwnProfile ? (
        <span style={{ maxWidth: 240, textAlign: 'right', ...MUTED_LINE, marginTop: 0 }}>
          Eigenes Profil — Genehmigung durch eine andere Person der Personalabteilung
        </span>
      ) : (
        <button className="hm-btn hm-btn--sm hm-btn--primary" onClick={() => onDecide({ request, decision: 'genehmigt' })}>
          <Check size={14} /> Genehmigen
        </button>
      )}
      <button
        className="hm-btn hm-btn--sm hm-btn--secondary"
        style={{ flexShrink: 0 }}
        onClick={() => onDecide({ request, decision: 'abgelehnt' })}
      >
        <X size={14} /> Ablehnen
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entscheidungsdialog (für Genehmigen UND Ablehnen derselbe)
// ---------------------------------------------------------------------------

function DecisionDialog({ target, onClose }: { target: DecisionTarget | null; onClose: () => void }) {
  const toast = useToast();
  const decide = useDecideChangeRequest();
  const [note, setNote] = useState('');
  // Der Dialog bleibt gemountet (Modal rendert bei open=false nur null) — eine
  // abgebrochene Begründung darf nicht am nächsten Antrag kleben. Der Schlüssel
  // enthält auch die Entscheidung: Wer von „Genehmigen“ auf „Ablehnen“ wechselt,
  // beginnt einen neuen Text.
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = target ? `${target.request.id}:${target.decision}` : null;
  if (key !== lastKey) {
    setLastKey(key);
    setNote('');
  }

  const isRejection = target?.decision === 'abgelehnt';
  // Ohne Begründung antwortet das Backend bei Ablehnung mit 400 — dieselbe
  // Mindestlänge wie bei den Abwesenheitsanträgen.
  const mayDecide = target !== null && (!isRejection || note.trim().length >= 3);

  const submit = () => {
    if (!target) return;
    decide.mutate(
      { id: target.request.id, decision: target.decision, decision_note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(
            target.decision === 'genehmigt'
              ? 'Antrag genehmigt — die Stammdaten wurden übernommen.'
              : 'Antrag abgelehnt.',
          );
          onClose();
        },
        // Der Dialog bleibt bei einem Fehler offen: Nach dem Vier-Augen-400
        // kann dieselbe Person den Antrag immer noch ablehnen, ohne ihn erneut
        // heraussuchen zu müssen. Die Meldung kommt aus dem Backend und ist
        // bereits ein deutscher Satz.
        onError: (e: Error) =>
          toast.error(e instanceof ApiRequestError ? e.message : 'Entscheidung fehlgeschlagen.'),
      },
    );
  };

  return (
    <Modal
      title={isRejection ? 'Antrag ablehnen' : 'Antrag genehmigen'}
      open={target !== null}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className={`hm-btn ${isRejection ? 'hm-btn--danger' : 'hm-btn--primary'}`}
            disabled={!mayDecide || decide.isPending}
            onClick={submit}
          >
            {isRejection ? 'Ablehnen' : 'Genehmigen & übernehmen'}
          </button>
        </>
      }
    >
      {target && (
        <div className="stack" style={{ gap: 14 }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {target.request.first_name} {target.request.last_name}
            {target.request.personnel_number ? ` (${target.request.personnel_number})` : ''} — beantragt am{' '}
            {formatDateTime(target.request.created_at)}
            {target.request.requested_by_name ? ` von ${target.request.requested_by_name}` : ''}.
          </p>
          <FieldDiff fields={target.request.fields} />
          {target.request.note && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Begründung der Person: {target.request.note}
            </p>
          )}
          <Field
            label="Begründung der Entscheidung"
            required={isRejection}
            hint={
              isRejection
                ? 'Pflichtfeld. Die Begründung wird der Person im Portal angezeigt.'
                : 'Optional. Wird der Person im Portal angezeigt.'
            }
          >
            <textarea
              className="hm-textarea"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </Field>
          {!isRejection && (
            <p style={{ margin: 0, ...MUTED_LINE }}>
              Die gewünschten Werte werden mit der Genehmigung in die Personalakte übernommen.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tab „Offen“
// ---------------------------------------------------------------------------

function OpenTab({ onDecide }: { onDecide: (target: DecisionTarget) => void }) {
  const { data, isLoading } = useEmployeeChangeRequests({ status: 'beantragt' });
  const isOwnProfile = useIsOwnProfile();
  const requests = data?.requests ?? [];

  if (isLoading) return <Spinner center />;
  return (
    <Card flush>
      {requests.length === 0 ? (
        <EmptyState
          icon={<Inbox size={40} />}
          title="Keine offenen Änderungsanträge"
          hint="Anträge aus dem Mitarbeitenden-Portal erscheinen hier zur Entscheidung."
        />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Mitarbeiter:in</th>
                <th>Beantragt am</th>
                <th>Bisher → Gewünscht</th>
                <th>Begründung</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <EmployeeCell request={r} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.created_at)}</td>
                  <td style={{ minWidth: 260 }}>
                    <FieldDiff fields={r.fields} />
                  </td>
                  <td style={{ maxWidth: 240, color: 'var(--text-secondary)' }}>{r.note ?? '—'}</td>
                  <td>
                    <DecisionButtons request={r} isOwnProfile={isOwnProfile(r)} onDecide={onDecide} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab „Alle“
// ---------------------------------------------------------------------------

function AllTab({ onDecide }: { onDecide: (target: DecisionTarget) => void }) {
  const [status, setStatus] = useState<'' | EmployeeChangeRequestStatus>('');
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const { data, isLoading } = useEmployeeChangeRequests({
    status: status || undefined,
    employee_id: employeeId,
  });
  const isOwnProfile = useIsOwnProfile();
  const requests = data?.requests ?? [];

  return (
    <div className="stack">
      <Card>
        <div className="hm-form-grid">
          <Field label="Status">
            <Select
              className="hm-select"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | EmployeeChangeRequestStatus)}
            >
              <option value="">Alle</option>
              {Object.entries(EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mitarbeiter:in">
            <EmployeeSelect value={employeeId} onChange={setEmployeeId} emptyLabel="Alle" />
          </Field>
        </div>
      </Card>
      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : requests.length === 0 ? (
          <EmptyState
            title="Keine Änderungsanträge gefunden"
            hint="Passen Sie die Filter an — bisher wurde für diese Auswahl nichts beantragt."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Beantragt am</th>
                  <th>Bisher → Gewünscht</th>
                  <th>Status</th>
                  <th>Entscheidung</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <EmployeeCell request={r} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.created_at)}</td>
                    <td style={{ minWidth: 240 }}>
                      <FieldDiff fields={r.fields} />
                      {r.note && <div style={MUTED_LINE}>Begründung: {r.note}</div>}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONES[r.status]}>
                        {EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS[r.status]}
                      </Badge>
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      {r.decided_at ? (
                        <>
                          <div style={{ fontSize: 'var(--text-sm)' }}>
                            {formatDateTime(r.decided_at)}
                            {r.decided_by_name ? ` · ${r.decided_by_name}` : ''}
                          </div>
                          {r.decision_note && (
                            <div style={{ ...MUTED_LINE, whiteSpace: 'normal' }}>{r.decision_note}</div>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {r.status === 'beantragt' ? (
                        <DecisionButtons request={r} isOwnProfile={isOwnProfile(r)} onDecide={onDecide} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function ChangeRequestsPage() {
  const [tab, setTab] = useState<'offen' | 'alle'>('offen');
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  // Derselbe Query-Key wie im Tab „Offen“ — react-query liefert beiden dieselbe
  // Antwort, die Zahl im Reiter kostet also keine zweite Abfrage.
  const { data: open } = useEmployeeChangeRequests({ status: 'beantragt' });
  const openCount = open?.open_count ?? 0;

  return (
    <>
      <PageHeader
        title="Änderungsanträge"
        subtitle="Von Mitarbeitenden beantragte Änderungen an ihren Stammdaten prüfen und entscheiden."
      />
      <Tabs
        tabs={[
          { key: 'offen', label: openCount > 0 ? `Offen (${openCount})` : 'Offen' },
          { key: 'alle', label: 'Alle' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'offen' ? <OpenTab onDecide={setTarget} /> : <AllTab onDecide={setTarget} />}
      </div>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
