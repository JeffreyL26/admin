import React, { useMemo, useState } from 'react';
import {
  EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS,
  EMPLOYEE_SELF_EDITABLE_GROUP_LABELS,
  type EmployeeChangeRequest,
  type EmployeeChangeRequestStatus,
  type EmployeeSelfEditableField,
  type MeProfile,
} from '@ohrganize/shared';
import {
  useChangeRequestFields,
  useCreateChangeRequest,
  useMyChangeRequests,
  useMyProfile,
  useWithdrawChangeRequest,
} from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { Card, EmptyState, Field, LoadError, Skeleton } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatDate } from '../lib/format';
import { apiErrorMessage, PORTAL_READ_ONLY_NOTICE, READ_ONLY_NOTICE_ID } from '../lib/license';

const STATUS_TONES: Record<EmployeeChangeRequestStatus, string> = {
  beantragt: 'warning',
  genehmigt: 'success',
  abgelehnt: 'danger',
  zurueckgezogen: 'neutral',
};

/**
 * Eigene Statuspille statt `StatusChip` aus components/ui: Die dortige
 * Komponente ist auf `AbsenceRequestStatus` typisiert und kennt den Zustand
 * „zurueckgezogen" nicht. Maße und Töne kommen aus denselben pt-chip-Klassen,
 * die Anzeige bleibt damit identisch.
 */
function ChangeStatusChip({ status }: { status: EmployeeChangeRequestStatus }) {
  return (
    <span className={`pt-chip pt-chip--${STATUS_TONES[status] ?? 'neutral'}`}>
      {EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** HTML-Eingabetyp je Feldart. `zip` bleibt Text — `number` erlaubt Vorzeichen
 *  und Exponenten und verliert führende Nullen. */
const INPUT_TYPES: Record<EmployeeSelfEditableField['input'], string> = {
  text: 'text',
  email: 'email',
  tel: 'tel',
  zip: 'text',
  iban: 'text',
  bic: 'text',
};

/**
 * Ausfüllhilfe des Browsers. Für die Bankverbindung bewusst „off": Der aktuelle
 * Stand wird im Portal nicht angezeigt, ein automatisch eingesetzter Wert aus
 * einem fremden Formular wäre hier ein unbemerkter Änderungsantrag.
 */
const AUTOCOMPLETE: Record<string, string> = {
  private_street: 'street-address',
  private_zip: 'postal-code',
  private_city: 'address-level2',
  private_phone: 'tel',
  private_email: 'email',
};

/**
 * Ist-Wert eines Feldes aus dem eigenen Profil. Der Zugriff läuft über einen
 * Index, weil `field` aus der Serverliste kommt und deshalb kein Literaltyp
 * ist; vertrauliche Felder stehen ohnehin nicht in der Profil-Projektion.
 */
function profileValue(profile: MeProfile | undefined, field: string): string {
  const value = profile ? (profile as unknown as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' ? value : '';
}

/** Leere Werte als Gedankenstrich, wie in der Profilansicht. */
function displayValue(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

/** Zurückziehen mit Zwischenschritt statt Browser-Dialog (wie bei Abwesenheiten). */
function WithdrawButton({ request }: { request: EmployeeChangeRequest }) {
  const [confirming, setConfirming] = useState(false);
  const withdraw = useWithdrawChangeRequest();
  const toast = useToast();
  const { readOnly } = useAuth();

  if (request.status !== 'beantragt') return null;

  // Nur-Lese-Betrieb: sichtbar, aber gesperrt; den Grund nennt der globale
  // Hinweis der Shell (aria-describedby) — neben dem Knopf ist kein Platz.
  if (!confirming) {
    return (
      <button
        type="button"
        className="pt-btn pt-btn--danger-quiet pt-btn--sm"
        disabled={readOnly}
        aria-describedby={readOnly ? READ_ONLY_NOTICE_ID : undefined}
        onClick={() => setConfirming(true)}
      >
        Zurückziehen
      </button>
    );
  }
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <button
        type="button"
        className="pt-btn pt-btn--danger-quiet pt-btn--sm"
        disabled={readOnly || withdraw.isPending}
        aria-describedby={readOnly ? READ_ONLY_NOTICE_ID : undefined}
        onClick={() =>
          withdraw.mutate(request.id, {
            onSuccess: () => toast.success('Antrag zurückgezogen'),
            onError: (err) => toast.error(apiErrorMessage(err, 'Aktion fehlgeschlagen')),
            onSettled: () => setConfirming(false),
          })
        }
      >
        Wirklich zurückziehen?
      </button>
      <button
        type="button"
        className="pt-btn pt-btn--quiet pt-btn--sm"
        onClick={() => setConfirming(false)}
      >
        Behalten
      </button>
    </span>
  );
}

export function StammdatenPage() {
  const toast = useToast();
  const { readOnly } = useAuth();
  const { data: profile, isLoading: profileLoading, error: profileError } = useMyProfile();
  const { data: fields, isLoading: fieldsLoading, error: fieldsError } = useChangeRequestFields();
  const { data: requests, isLoading: requestsLoading, error: requestsError } = useMyChangeRequests();
  const create = useCreateChangeRequest();

  // Nur ANGEFASSTE Felder stehen hier; der Rest kommt aus `baseline`. So muss
  // das Formular nicht auf das Eintreffen des Profils warten und weiß ohne
  // Zusatzzustand, welche Felder tatsächlich geändert wurden.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);

  const loading = profileLoading || fieldsLoading;
  const loadError = profileError ?? fieldsError;

  // Höchstens ein offener Antrag je Person (Regel des Backends). Das Formular
  // zeigt das an, statt den Absendeknopf in ein 409 laufen zu lassen.
  const openRequest = (requests ?? []).find((r) => r.status === 'beantragt');
  const locked = openRequest !== undefined;

  /**
   * Ist-Stand je Feld. Für vertrauliche Felder bleibt er leer: Die
   * Bankverbindung liefert das Backend nicht ans Portal aus, eine Vorbelegung
   * gäbe es also nur als Erfindung.
   */
  const baseline = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields ?? []) {
      map[f.field] = f.confidential ? '' : profileValue(profile, f.field);
    }
    return map;
  }, [fields, profile]);

  const changed = (fields ?? []).filter((f) => {
    const draft = edits[f.field];
    return draft !== undefined && draft.trim() !== (baseline[f.field] ?? '').trim();
  });

  const groups = useMemo(() => {
    const byGroup = new Map<EmployeeSelfEditableField['group'], EmployeeSelfEditableField[]>();
    for (const f of fields ?? []) {
      const list = byGroup.get(f.group) ?? [];
      list.push(f);
      byGroup.set(f.group, list);
    }
    return [...byGroup.entries()];
  }, [fields]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || locked || changed.length === 0) return;
    setApiError(null);
    // Nur geänderte Felder: Ein unverändert mitgeschicktes Feld würde das
    // Backend zwar aussortieren, stünde bei der Personalabteilung aber als
    // vermeintliche Änderung auf dem Zettel.
    const payload: Record<string, string | null> = {};
    for (const f of changed) {
      const value = (edits[f.field] ?? '').trim();
      payload[f.field] = value === '' ? null : value; // leer = Feld löschen
    }
    create.mutate(
      { fields: payload, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Änderungsantrag eingereicht');
          setEdits({});
          setNote('');
        },
        onError: (err) =>
          setApiError(apiErrorMessage(err, 'Der Antrag konnte nicht eingereicht werden')),
      },
    );
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <header className="portal-page-header">
        <h1 className="portal-title">Stammdaten ändern</h1>
        <p className="portal-subtitle">
          Ihre Personalabteilung prüft jede Änderung. Bis zur Freigabe bleibt der bisherige Stand in
          Ihrer Personalakte. Den Bearbeitungsstand sehen Sie unten auf dieser Seite.
        </p>
      </header>

      {loadError && (
        <div style={{ marginBottom: 20 }}>
          <LoadError error={loadError} />
        </div>
      )}

      <form onSubmit={submit}>
        <Card title="Änderung beantragen">
          {openRequest && (
            <div className="pt-alert pt-alert--info" style={{ marginBottom: 18 }}>
              <div className="row row--between" style={{ gap: 12, alignItems: 'flex-start' }}>
                <span>
                  Ihr Antrag vom {formatDate(openRequest.created_at.slice(0, 10))} wird noch geprüft.
                  Solange er offen ist, ist dieses Formular gesperrt.
                  {/* Im Nur-Lese-Betrieb wäre die Aufforderung zum Zurückziehen leer —
                      der Knopf daneben ist gesperrt, der Grund steht in der Shell. */}
                  {!readOnly &&
                    ' Ziehen Sie den Antrag zurück, wenn Sie stattdessen etwas anderes ändern möchten.'}
                </span>
                <WithdrawButton request={openRequest} />
              </div>
            </div>
          )}

          {loadError ? null : loading ? (
            <div className="stack" style={{ gap: 18 }}>
              <Skeleton height={40} />
              <Skeleton height={40} />
              <Skeleton height={88} />
            </div>
          ) : (
            <div className="stack" style={{ gap: 22 }}>
              {groups.map(([group, list]) => (
                <div key={group}>
                  <span className="pt-label">{EMPLOYEE_SELF_EDITABLE_GROUP_LABELS[group]}</span>
                  <div className="pt-form-grid" style={{ marginTop: 10 }}>
                    {list.map((f) => (
                      <Field
                        key={f.field}
                        label={f.label}
                        hint={
                          f.hint ??
                          (f.confidential
                            ? 'Der hinterlegte Wert wird im Portal nicht angezeigt. Nur ausfüllen, wenn er sich ändert.'
                            : undefined)
                        }
                      >
                        <input
                          className="pt-input"
                          type={INPUT_TYPES[f.input]}
                          inputMode={f.input === 'zip' ? 'numeric' : undefined}
                          value={edits[f.field] ?? baseline[f.field] ?? ''}
                          maxLength={f.maxLength}
                          disabled={locked || create.isPending}
                          autoComplete={AUTOCOMPLETE[f.field] ?? 'off'}
                          spellCheck={f.input === 'text' ? undefined : false}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [f.field]: e.target.value }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                </div>
              ))}

              <Field
                label="Begründung für die Personalabteilung"
                hint="Optional, z. B. „Umzug zum 1. Oktober“."
              >
                <textarea
                  className="pt-textarea"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                  disabled={locked || create.isPending}
                />
              </Field>
            </div>
          )}

          {apiError && (
            <p className="pt-alert pt-alert--danger" style={{ marginTop: 18 }} role="alert">
              {apiError}
            </p>
          )}

          <div className="row" style={{ marginTop: 22, gap: 14 }}>
            <button
              type="submit"
              className="pt-btn pt-btn--primary"
              disabled={readOnly || locked || loading || create.isPending || changed.length === 0}
            >
              {create.isPending ? 'Wird eingereicht …' : 'Änderung beantragen'}
            </button>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {readOnly
                ? PORTAL_READ_ONLY_NOTICE
                : locked
                  ? 'Erst nach der Entscheidung über den offenen Antrag wieder möglich.'
                  : changed.length === 0
                    ? 'Ändern Sie mindestens ein Feld — übermittelt wird nur, was Sie angepasst haben.'
                    : `${changed.length} ${changed.length === 1 ? 'geändertes Feld wird' : 'geänderte Felder werden'} übermittelt.`}
            </span>
          </div>
        </Card>
      </form>

      <div style={{ marginTop: 20 }}>
        <Card title="Ihre Änderungsanträge" flush>
          {requestsError ? (
            <div className="pt-card__body">
              <LoadError error={requestsError} />
            </div>
          ) : requestsLoading ? (
            <div className="pt-card__body stack" style={{ gap: 14 }}>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="row">
                  <Skeleton width={100} />
                  <Skeleton width={220} />
                  <Skeleton width={90} style={{ marginLeft: 'auto' }} />
                </div>
              ))}
            </div>
          ) : (requests ?? []).length === 0 ? (
            <EmptyState
              title="Noch kein Änderungsantrag"
              hint="Gestellte Anträge erscheinen hier mit ihrem Bearbeitungsstand."
            />
          ) : (
            <div className="pt-table-wrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Gestellt am</th>
                    <th>Beantragte Änderung</th>
                    <th>Status</th>
                    <th>Entscheidung</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {(requests ?? []).map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {formatDate(r.created_at.slice(0, 10))}
                      </td>
                      <td>
                        <div className="stack" style={{ gap: 4 }}>
                          {r.fields.map((f) => (
                            <span key={f.field}>
                              <span style={{ color: 'var(--text-muted)' }}>{f.label}: </span>
                              {displayValue(f.old_value)} →{' '}
                              <strong>{displayValue(f.new_value)}</strong>
                            </span>
                          ))}
                        </div>
                        {r.fields.some((f) => f.masked) && (
                          <span
                            style={{
                              display: 'block',
                              marginTop: 6,
                              color: 'var(--text-muted)',
                              fontSize: 'var(--text-xs)',
                            }}
                          >
                            Bankdaten werden hier nur gekürzt angezeigt.
                          </span>
                        )}
                        {r.note && (
                          <span
                            style={{
                              display: 'block',
                              marginTop: 6,
                              color: 'var(--text-muted)',
                              fontSize: 'var(--text-xs)',
                            }}
                          >
                            Ihre Begründung: {r.note}
                          </span>
                        )}
                      </td>
                      <td>
                        <ChangeStatusChip status={r.status} />
                      </td>
                      <td style={{ color: 'var(--text-muted)' }}>
                        {r.decided_at ? (
                          <>
                            <span style={{ whiteSpace: 'nowrap' }}>
                              {formatDate(r.decided_at.slice(0, 10))}
                            </span>
                            {r.decision_note && (
                              <span
                                style={{
                                  display: 'block',
                                  marginTop: 4,
                                  maxWidth: 240,
                                  fontSize: 'var(--text-xs)',
                                  color:
                                    r.status === 'abgelehnt' ? 'var(--danger)' : 'var(--text-muted)',
                                }}
                              >
                                {r.decision_note}
                              </span>
                            )}
                          </>
                        ) : r.status === 'beantragt' ? (
                          'ausstehend'
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <WithdrawButton request={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
