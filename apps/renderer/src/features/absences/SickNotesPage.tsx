import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FilePlus2, FileWarning, Stethoscope, Upload } from 'lucide-react';
import { formatDate, todayIsoLocal, SICK_PAY_LIMIT_DAYS, type SickNote } from '@hrmonic/shared';
import { api, uploadFile } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { FilePicker } from '../../components/FilePicker';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { useMissingSickNotes, useSickNotes } from './api';

/** AU-Status: fehlt / fristgerecht / verspätet / überfällig. */
function certificateBadge(note: SickNote) {
  if (note.certificate_file_id) {
    const late = note.received_date && note.received_date > note.certificate_due_date;
    return late ? <Badge tone="yellow">verspätet eingegangen</Badge> : <Badge tone="green">fristgerecht</Badge>;
  }
  if (note.certificate_due_date < todayIsoLocal()) return <Badge tone="red">überfällig</Badge>;
  return <Badge tone="neutral">fehlt noch</Badge>;
}

/** Bereits angefallene Fehltage; laufende Erkrankungen und überzogene Entgeltfortzahlung markieren. */
function missedDaysCell(note: SickNote) {
  const ongoing = note.date_to !== undefined && note.date_to >= todayIsoLocal();
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      {(note.days_absent_so_far ?? 0).toLocaleString('de-DE')}
      {ongoing && (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>laufend</span>
      )}
      {note.sick_pay_exceeded && (
        <span
          title={`Entgeltfortzahlung überzogen: ${note.sick_pay_days_used} von ${SICK_PAY_LIMIT_DAYS} Kalendertagen seit Beginn der AU-Kette — Übergang ins Krankengeld prüfen.`}
        >
          <Badge tone="red">Überzogen ❗</Badge>
        </span>
      )}
    </span>
  );
}

export function SickNotesPage() {
  const [childFilter, setChildFilter] = useState<'' | '0' | '1'>('');
  const { data: notes, isLoading } = useSickNotes(childFilter === '' ? null : childFilter);
  const { data: missing } = useMissingSickNotes();
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadFor, setUploadFor] = useState<SickNote | null>(null);

  return (
    <>
      <PageHeader
        title="Krankmeldungen"
        subtitle="Arbeitsunfähigkeiten erfassen und AU-Bescheinigungen überwachen."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <FilePlus2 size={16} /> Krankmeldung erfassen
          </button>
        }
      />
      <div className="stack">
        {(() => {
          // Überzogene Entgeltfortzahlung: je Mitarbeiter:in nur einmal warnen
          // (die Kette teilt sich sick_pay_days_used über alle Bescheinigungen).
          const exceeded = new Map<number, SickNote>();
          for (const n of notes ?? []) {
            if (!n.sick_pay_exceeded || n.employee_id === undefined) continue;
            const prev = exceeded.get(n.employee_id);
            if (!prev || (n.sick_pay_days_used ?? 0) > (prev.sick_pay_days_used ?? 0)) {
              exceeded.set(n.employee_id, n);
            }
          }
          if (exceeded.size === 0) return null;
          return (
            <Card
              title={
                <span className="row" style={{ gap: 8, color: 'var(--danger)' }}>
                  <AlertTriangle size={17} /> Entgeltfortzahlung überzogen ({exceeded.size})
                </span>
              }
            >
              <div className="stack" style={{ gap: 8 }}>
                {[...exceeded.values()].map((n) => (
                  <div key={n.id} className="row row--between">
                    <span style={{ fontWeight: 600 }}>
                      {n.last_name}, {n.first_name}
                    </span>
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      {n.sick_pay_days_used} von {SICK_PAY_LIMIT_DAYS} Kalendertagen — Übergang ins
                      Krankengeld prüfen
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          );
        })()}
        {missing && missing.length > 0 && (
          <Card
            title={
              <span className="row" style={{ gap: 8, color: 'var(--danger)' }}>
                <FileWarning size={17} /> Fehlende Bescheinigungen ({missing.length})
              </span>
            }
            flush
          >
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
                    <th>Zeitraum</th>
                    <th>AU fällig seit</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {missing.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {n.last_name}, {n.first_name}
                        {n.child_sick === 1 && (
                          <span style={{ marginLeft: 8 }}>
                            <Badge tone="blue">Kind krank</Badge>
                          </span>
                        )}
                      </td>
                      <td>
                        {formatDate(n.date_from)} – {formatDate(n.date_to)}
                      </td>
                      <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{formatDate(n.certificate_due_date)}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="hm-btn hm-btn--sm hm-btn--secondary" onClick={() => setUploadFor(n)}>
                            <Upload size={14} /> AU nachtragen
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card
          title="Alle Krankmeldungen"
          actions={
            <select
              className="hm-select"
              style={{ width: 170 }}
              value={childFilter}
              onChange={(e) => setChildFilter(e.target.value as typeof childFilter)}
            >
              <option value="">Alle</option>
              <option value="0">Nur eigene Erkrankung</option>
              <option value="1">Nur Kind krank</option>
            </select>
          }
          flush
        >
          {isLoading ? (
            <Spinner center />
          ) : !notes || notes.length === 0 ? (
            <EmptyState
              icon={<Stethoscope size={40} />}
              title="Keine Krankmeldungen"
              hint="Erfassen Sie eine Krankmeldung über den Button oben rechts."
            />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
                    <th>Zeitraum</th>
                    <th className="num">Tage</th>
                    <th className="num">Bereits fehlend</th>
                    <th>Art</th>
                    <th>AU-Status</th>
                    <th>AU-Frist</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {n.last_name}, {n.first_name}
                      </td>
                      <td>
                        {formatDate(n.date_from)} – {formatDate(n.date_to)}
                      </td>
                      <td className="num">{n.days_counted?.toLocaleString('de-DE')}</td>
                      <td className="num">{missedDaysCell(n)}</td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          {n.child_sick === 1 ? <Badge tone="blue">Kind krank</Badge> : <Badge tone="neutral">Krankheit</Badge>}
                          {n.follow_up_of_id !== null && <Badge tone="navy">Folge-AU</Badge>}
                        </span>
                      </td>
                      <td>{certificateBadge(n)}</td>
                      <td>{formatDate(n.certificate_due_date)}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {!n.certificate_file_id && (
                            <button className="hm-btn hm-btn--sm hm-btn--ghost" onClick={() => setUploadFor(n)}>
                              <Upload size={14} /> AU nachtragen
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <CreateSickNoteDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <UploadCertificateDialog note={uploadFor} onClose={() => setUploadFor(null)} />
    </>
  );
}

function CreateSickNoteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [childSick, setChildSick] = useState(false);
  const [followUpOf, setFollowUpOf] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [receivedDate, setReceivedDate] = useState('');
  const { data: allNotes } = useSickNotes(null);
  const employeeNotes = (allNotes ?? []).filter((n) => n.employee_id === employeeId);

  const reset = () => {
    setEmployeeId(null);
    setDateFrom('');
    setDateTo('');
    setChildSick(false);
    setFollowUpOf(null);
    setFile(null);
    setReceivedDate('');
  };

  const create = useMutation({
    mutationFn: async () => {
      let certificateFileId: number | null = null;
      if (file) {
        const uploaded = await uploadFile(file);
        certificateFileId = uploaded.file.id;
      }
      return api.post('/api/absences/sick-notes', {
        employee_id: employeeId,
        date_from: dateFrom,
        date_to: dateTo,
        child_sick: childSick,
        certificate_file_id: certificateFileId,
        received_date: certificateFileId ? receivedDate || todayIsoLocal() : null,
        follow_up_of_id: followUpOf,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('Krankmeldung erfasst');
      reset();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid = !!employeeId && !!dateFrom && !!dateTo && dateFrom <= dateTo;

  return (
    <Modal
      title="Krankmeldung erfassen"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="hm-btn hm-btn--primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            Erfassen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Krank von" required>
          <input className="hm-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="Krank bis" required error={dateFrom && dateTo && dateTo < dateFrom ? 'Enddatum liegt vor dem Startdatum' : undefined}>
          <input className="hm-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
        <label className="hm-checkbox span-2">
          <input type="checkbox" checked={childSick} onChange={(e) => setChildSick(e.target.checked)} />
          Kind krank (Betreuung eines erkrankten Kindes)
        </label>
        <Field
          label="Folgebescheinigung von"
          span2
          hint="Nur bei nahtloser Fortsetzung einer bestehenden Krankmeldung."
        >
          <select
            className="hm-select"
            value={followUpOf ?? ''}
            onChange={(e) => setFollowUpOf(e.target.value ? Number(e.target.value) : null)}
            disabled={!employeeId || employeeNotes.length === 0}
          >
            <option value="">— keine (Erstbescheinigung) —</option>
            {employeeNotes.map((n) => (
              <option key={n.id} value={n.id}>
                {formatDate(n.date_from)} – {formatDate(n.date_to)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="AU-Bescheinigung (optional)" span2 hint="Ausstellungspflicht ab dem 3. Kalendertag.">
          <FilePicker file={file} onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" hint="PDF oder Bild" />
        </Field>
        {file && (
          <Field label="Eingangsdatum der AU" span2>
            <input className="hm-input" type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function UploadCertificateDialog({ note, onClose }: { note: SickNote | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [receivedDate, setReceivedDate] = useState(todayIsoLocal());

  const save = useMutation({
    mutationFn: async () => {
      if (!note || !file) return;
      const uploaded = await uploadFile(file);
      return api.patch(`/api/absences/sick-notes/${note.id}`, {
        certificate_file_id: uploaded.file.id,
        received_date: receivedDate,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      toast.success('AU-Bescheinigung hinterlegt');
      setFile(null);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title="AU-Bescheinigung nachtragen"
      open={note !== null}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="hm-btn hm-btn--primary" disabled={!file || !receivedDate || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </>
      }
    >
      {note && (
        <div className="stack" style={{ gap: 12 }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            {note.first_name} {note.last_name}, krank {formatDate(note.date_from)} – {formatDate(note.date_to)}. AU war
            fällig am {formatDate(note.certificate_due_date)}.
          </p>
          <Field label="Bescheinigung" required span2>
            <FilePicker file={file} onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" hint="PDF oder Bild" />
          </Field>
          <Field label="Eingangsdatum" required>
            <input className="hm-input" type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
