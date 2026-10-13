import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CircleX, Download } from 'lucide-react';
import {
  DATEV_PROGRAM_LABELS,
  DATEV_STAMMDATEN_SCOPE_LABELS,
  issuesForFile,
  type DatevCheckReport,
  type DatevExportKind,
  type DatevIssue,
  type DatevStammdatenScope,
} from '@ohrganize/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { useToast } from '../../components/Toast';
import { downloadAuthenticated, formatMonth } from './lib';

interface CheckResponse {
  report: DatevCheckReport;
  files: {
    kind: DatevExportKind;
    label: string;
    person_count: number;
    changed_count?: number;
    changed_employee_ids?: number[];
  }[];
}

/**
 * DATEV-Export eines Abrechnungslaufs: Zuerst der Pruefbericht zu genau der
 * gewaehlten Datei (Fehler sperren sie, Warnungen stehen auch in der Datei),
 * dann die Wahl der Datei (Bewegungsdaten, bei LODAS auch Stammdaten mit
 * Umfang) und der Download. Welches Lohnprogramm und welche Nummern gelten,
 * steht in den Einstellungen; der Dialog zeigt es nur an. Gefiltert wird
 * mit issuesForFile wie in der Route, damit Knopf und Server dieselbe
 * Sperre sehen.
 */
export function DatevExportDialog({
  runId,
  month,
  runStatus,
  open,
  onClose,
}: {
  runId: number;
  month: string;
  runStatus: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<DatevExportKind>('bewegungsdaten');
  const [scope, setScope] = useState<DatevStammdatenScope>('aenderungen');
  const [busy, setBusy] = useState(false);
  const checkKey = ['compensation', 'payroll-run', runId, 'datev-check'];
  const { data, isLoading, error } = useQuery({
    queryKey: checkKey,
    queryFn: () => api.get<CheckResponse>(`/api/compensation/payroll-runs/${runId}/datev-check`),
    enabled: open,
  });

  // Bietet das Programm die gewaehlte Datei nicht mehr an (anderes
  // Lohnprogramm, an diesem oder einem anderen Arbeitsplatz eingestellt),
  // springt die Auswahl auf die erste angebotene.
  useEffect(() => {
    if (data && !data.files.some((f) => f.kind === kind)) setKind(data.files[0]?.kind ?? 'bewegungsdaten');
  }, [data, kind]);

  const report = data?.report;
  const file = data?.files.find((f) => f.kind === kind);
  const personIds =
    file?.kind === 'stammdaten' && scope === 'aenderungen' ? new Set(file.changed_employee_ids ?? []) : null;
  const relevant = report && file ? issuesForFile(report.issues, file.kind, personIds) : [];
  const errors = relevant.filter((i) => i.level === 'fehler');
  const warnings = relevant.filter((i) => i.level === 'warnung');
  const lohnarten = report && file ? report.lohnarten_in_use.filter((l) => l.kinds.includes(file.kind)) : [];
  const personCount = file ? (personIds ? personIds.size : file.person_count) : 0;
  const blocked = runStatus === 'offen' || !report || !file || errors.length > 0 || personCount === 0;

  const download = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ kind: file.kind });
      if (file.kind === 'stammdaten') params.set('scope', scope);
      await downloadAuthenticated(
        `/api/compensation/payroll-runs/${runId}/export.datev?${params.toString()}`,
        `datev_${file.kind}_${month}.txt`,
      );
      toast.success('DATEV-Datei erstellt');
      onClose();
      // Status und Listen neu laden, den Pruefbericht dieses Dialogs nicht:
      // Er waere noch aktiv und rechnete den ganzen Lauf fuer niemanden neu.
      queryClient.invalidateQueries({ queryKey: ['compensation'], predicate: (q) => q.queryKey[3] !== 'datev-check' });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'DATEV_EXPORT_BLOCKED') {
        // Einstellungen oder Daten haben sich seit dem Bericht geaendert: neu laden, nicht raten.
        queryClient.invalidateQueries({ queryKey: checkKey });
      }
      toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`DATEV-Export ${formatMonth(month)}`}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Schließen
          </button>
          <button className="hm-btn hm-btn--primary" disabled={blocked || busy} onClick={download}>
            <Download size={16} /> Datei herunterladen
          </button>
        </>
      }
    >
      {isLoading && <Spinner center />}
      {error && (
        <p className="hm-field__error">
          {error instanceof Error ? error.message : 'Prüfbericht konnte nicht geladen werden'}
        </p>
      )}
      {report && data && file && (
        <div className="stack">
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Badge tone="blue">{DATEV_PROGRAM_LABELS[report.program]}</Badge>
            {report.program === 'lodas' && (
              <Badge tone="neutral">
                {report.pnr_mode === 'betrieblich' ? 'Betriebliche Personalnummer' : 'Mitarbeiternummer (Ziffern)'}
              </Badge>
            )}
            <Badge tone="neutral">
              {report.festbezuege === 'bewegungsdaten'
                ? 'Festbezüge als Buchung'
                : report.program === 'lodas'
                  ? 'Festbezüge über Stammdaten'
                  : 'Festbezüge pflegt das Lohnbüro'}
            </Badge>
            <Link to="/einstellungen/datev" style={{ fontSize: 'var(--text-sm)' }}>
              Einstellungen
            </Link>
          </div>
          {runStatus === 'offen' && (
            <p className="hm-field__error">Der Lauf muss zuerst als geprüft markiert werden.</p>
          )}
          <div className="hm-form-grid">
            <label className="hm-field">
              <span className="hm-field__label">Datei</span>
              <Select
                className="hm-select"
                value={file.kind}
                onChange={(e) => setKind(e.target.value as DatevExportKind)}
              >
                {data.files.map((f) => (
                  <option key={f.kind} value={f.kind}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <span className="hm-field__hint">
                {file.kind === 'stammdaten' && scope === 'aenderungen'
                  ? `${file.changed_count ?? 0} von ${file.person_count} Personen`
                  : `${file.person_count} Personen`}
                {personCount === 0 && ', nichts zu übergeben'}
              </span>
            </label>
            {file.kind === 'stammdaten' && (
              <label className="hm-field">
                <span className="hm-field__label">Umfang</span>
                <Select
                  className="hm-select"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as DatevStammdatenScope)}
                >
                  {(Object.keys(DATEV_STAMMDATEN_SCOPE_LABELS) as DatevStammdatenScope[]).map((s) => (
                    <option key={s} value={s}>
                      {DATEV_STAMMDATEN_SCOPE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {lohnarten.length > 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>
              Lohnarten in dieser Datei: {lohnarten.map((l) => `${l.label} = ${l.number || '?'}`).join(' · ')}
            </p>
          )}
          <IssueList
            title={`${errors.length} Fehler`}
            hint="Fehler sperren diese Datei, bis sie behoben sind."
            issues={errors}
            tone="red"
            icon={<CircleX size={16} />}
          />
          <IssueList
            title={`${warnings.length} Warnungen`}
            hint={
              report.program === 'lodas'
                ? 'Warnungen stehen auch in den Hinweisdaten der Datei; LODAS zeigt sie im Prüfprotokoll.'
                : 'Warnungen stehen nur hier; die Datei für Lohn und Gehalt hat keinen Hinweisteil.'
            }
            issues={warnings}
            tone="yellow"
            icon={<AlertTriangle size={16} />}
          />
        </div>
      )}
    </Modal>
  );
}

function IssueList({
  title,
  hint,
  issues,
  tone,
  icon,
}: {
  title: string;
  hint: string;
  issues: DatevIssue[];
  tone: 'red' | 'yellow';
  icon: React.ReactNode;
}) {
  if (issues.length === 0) return null;
  // Je Person gebuendelt, allgemeine Meldungen zuerst.
  const groups = new Map<string, DatevIssue[]>();
  for (const i of issues) {
    const key = i.person ? `${i.person} (${i.personnel_number})` : '';
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return (
    <section>
      <div className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <Badge tone={tone}>
          {icon} {title}
        </Badge>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{hint}</span>
      </div>
      <div className="hm-table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
        <table className="hm-table">
          <tbody>
            {[...groups.entries()].map(([who, list]) => (
              <tr key={who || '(allgemein)'}>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{who || 'Einstellungen'}</td>
                <td>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {list.map((i, n) => (
                      <li key={n}>{i.message}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
