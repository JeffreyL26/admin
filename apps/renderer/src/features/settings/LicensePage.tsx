import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Check, CheckCircle2, Copy, Download, Info, ShieldAlert, Upload,
} from 'lucide-react';
import {
  COUNTRY_LABELS, LICENSE_CLOCK_WARNING_TEXT, LICENSE_READ_ONLY_DETAIL, formatDate, termsLabel, todayIsoLocal,
  type LicenseStatus,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { FilePicker } from '../../components/FilePicker';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { downloadAuthenticated } from '../compensation/lib';
import {
  LICENSE_FILE_MAX_BYTES, LICENSE_KIND_LABELS, LICENSE_QUERY_KEY, LICENSE_STATE_LABELS,
  describeLicense, licenseStateTone, seatsLabel, validUntilLabel,
} from './license';

/**
 * Einstellungen → Lizenz: Zustand, Vertragsdaten, Lizenzdatei einspielen,
 * Lizenzbericht. Die Seite liest GET /api/license (frische Platzzahl statt
 * des Login-Standes); nach dem Einspielen zieht sie den Auth-Kontext nach,
 * damit das Banner sofort umschaltet. Das Einspielen ist ein JSON-PUT mit
 * dem Dateitext — die Lizenz gehört nicht in die files-Tabelle und muss auch
 * im Nur-Lese-Betrieb funktionieren (core/licenseRoutes.ts).
 */

/** Dateiinhalt im Browser lesen — ein paar hundert Byte Text. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Zwei Saetze zum Zustand, unter dem Badge: Ueberschrift und Detail aus
 * describeLicense (packages/shared). Bei unbrauchbarer Datei steht der Grund
 * zusaetzlich darunter im roten Hinweis; hier reicht die Nur-Lese-Erklaerung.
 */
function statusLine(l: LicenseStatus): string {
  const d = describeLicense(l);
  const detail = l.state === 'expired' ? LICENSE_READ_ONLY_DETAIL : d.detail;
  return [d.headline, detail].filter(Boolean).join(' ');
}

type UploadResult = { ok: true; license: LicenseStatus } | { ok: false; message: string };

export function LicensePage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can, license: contextLicense, refreshLicense } = useAuth();
  const mayEdit = can('einstellungen', 'bearbeiten');

  const { data, isLoading } = useQuery({
    queryKey: LICENSE_QUERY_KEY,
    queryFn: () => api.get<{ license: LicenseStatus }>('/api/license'),
  });
  // Solange die Abfrage läuft (oder scheitert), reicht der Stand vom Login.
  const license = data?.license ?? contextLicense;

  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const text = await readAsText(f);
      return api.put<{ license: LicenseStatus }>('/api/license', { license: text });
    },
    onSuccess: async (res) => {
      qc.setQueryData(LICENSE_QUERY_KEY, res);
      setFile(null);
      setResult({ ok: true, license: res.license });
      toast.success('Lizenz eingespielt');
      // Banner und Widget lesen den Auth-Kontext — nachziehen, sonst stünde
      // dort bis zum nächsten Login der alte Zustand.
      await refreshLicense();
    },
    // Server-Meldungen sind Deutsch und für die Anzeige gedacht
    // (LICENSE_INVALID: Signatur, Format, Bindung, Laufzeit).
    onError: (e: Error) => {
      setResult({ ok: false, message: e.message });
      toast.error(e.message);
    },
  });

  const [downloading, setDownloading] = useState(false);
  async function downloadReport() {
    setDownloading(true);
    try {
      await downloadAuthenticated('/api/license/report', `ohrganize-lizenzbericht-${todayIsoLocal()}.json`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lizenzbericht konnte nicht geladen werden.');
    } finally {
      setDownloading(false);
    }
  }

  if (!license) {
    return isLoading ? (
      <Spinner center />
    ) : (
      <>
        <PageHeader title="Lizenz" />
        <Card>
          <EmptyState title="Lizenzzustand nicht verfügbar" hint="Das Backend hat keinen Lizenzzustand geliefert. Kontaktieren Sie uns gerne bei Fragen zu Ihrer Lizenz." />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Lizenz" subtitle="Alles rund um Nutzungsberechtigung: Zustand, Vertragsdaten, Lizenzdatei." />
      <div className="stack" style={{ maxWidth: 760 }}>
        <Card title="Zustand">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
            <Badge tone={licenseStateTone(license)}>{LICENSE_STATE_LABELS[license.state]}</Badge>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              {statusLine(license)}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '14px 18px',
            }}
          >
            <Fact label="Kunde" value={license.customer ?? '—'} />
            <Fact label="Art" value={license.kind ? LICENSE_KIND_LABELS[license.kind] : '—'} />
            <Fact
              label="Ausgabe"
              value={license.country ? `${COUNTRY_LABELS[license.country]} ${license.edition ?? ''}`.trim() : '—'}
              hint={license.license_id && !license.country ? 'Lizenz v1, ohne Ausgabe' : undefined}
            />
            <Fact label="Vertrag" value={license.terms ? termsLabel(license.terms).replace(/\.$/, '') : '—'} />
            <Fact label="Gültig bis" value={validUntilLabel(license)} />
            {license.license_id && (
              <Fact label="Kulanz bis" value={license.perpetual ? 'entfällt' : formatDate(license.grace_until)} />
            )}
            <Fact
              label="Plätze"
              value={seatsLabel(license)}
              hint={
                license.max_users === null
                  ? `${license.seats_used} aktive Personalprofile`
                  : 'aktive Personalprofile'
              }
            />
            <Fact label="Lizenz-ID" value={license.license_id ?? '—'} mono />
            <div style={{ gridColumn: '1 / -1' }}>
              <Fact
                label="Funktionen"
                value={
                  license.features === null
                    ? 'alle Funktionen dieser Ausgabe'
                    : license.features.length === 0
                      ? 'keine Zusatzfunktionen'
                      : ''
                }
                hint={license.features === null ? undefined : 'Zusatzfunktionen laut Lizenzdatei'}
                action={
                  license.features && license.features.length > 0 ? (
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {license.features.map((f) => (
                        <Badge key={f} tone="neutral">
                          {f}
                        </Badge>
                      ))}
                    </span>
                  ) : undefined
                }
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Fact
                label="Installations-ID"
                value={license.installation_id}
                mono
                action={<CopyButton text={license.installation_id} />}
                hint="Diese ID gehört in die Bestellung beim Anbieter."
              />
            </div>
          </div>

          {(license.notice || license.invalid_reason || license.clock_warning) && (
            <div className="stack" style={{ gap: 10, marginTop: 18 }}>
              {license.notice && (
                <div className="hm-notice">
                  <Info size={16} />
                  <div>
                    <b>Hinweis des Anbieters:</b> {license.notice}
                  </div>
                </div>
              )}
              {license.invalid_reason && (
                <div className="hm-notice hm-notice--danger">
                  <ShieldAlert size={16} />
                  <div>
                    <b>Lizenzdatei unbrauchbar:</b> {license.invalid_reason}
                  </div>
                </div>
              )}
              {license.clock_warning && (
                <div className="hm-notice hm-notice--warning">
                  <AlertTriangle size={16} />
                  <div>{LICENSE_CLOCK_WARNING_TEXT}</div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Lizenz einspielen">
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
            Die Lizenzdatei stellt oHRganize aus. Nach dem Einspielen gilt sie sofort.
          </p>
          <FilePicker
            file={file}
            onFile={(f) => {
              // `accept` filtert nur den Dateidialog, die Dropzone nimmt alles.
              // Größe VOR dem Einlesen prüfen: Ein daneben abgelegtes
              // Backup-Archiv würde sonst komplett in den Speicher gelesen,
              // bevor der Server es ablehnt.
              if (f && f.size > LICENSE_FILE_MAX_BYTES) {
                setFile(null);
                setResult({
                  ok: false,
                  message:
                    `„${f.name}“ ist keine Lizenzdatei (zu groß: ${Math.round(f.size / 1024)} KB. ` +
                    'Die Lizenzdatei hat wenige hundert Byte).',
                });
                return;
              }
              setFile(f);
              setResult(null);
            }}
            accept=".ohrganize,.txt"
            disabled={!mayEdit}
            busy={upload.isPending}
            hint="Datei lizenz.ohrganize (oder als .txt)"
          />
          {result && (
            <div
              className={`hm-notice ${result.ok ? 'hm-notice--success' : 'hm-notice--danger'}`}
              style={{ marginTop: 12 }}
            >
              {result.ok ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
              <div>
                {result.ok ? (
                  <>
                    Lizenz eingespielt: Zustand jetzt <b>{LICENSE_STATE_LABELS[result.license.state]}</b>
                    {result.license.valid_until ? <>, gültig bis {validUntilLabel(result.license)}</> : null}.
                  </>
                ) : (
                  result.message
                )}
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              {mayEdit ? '' : 'Zum Einspielen ist das Recht „Einstellungen: bearbeiten“ nötig.'}
            </span>
            <button
              className="hm-btn hm-btn--primary"
              disabled={!file || !mayEdit || upload.isPending}
              onClick={() => file && upload.mutate(file)}
            >
              <Upload size={15} /> Lizenz einspielen
            </button>
          </div>
        </Card>

        <Card title="Lizenzbericht">
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
            Kennungen und Platzzahl dieser Installation als JSON-Datei. Bitte legen Sie diese bei
            Nachfragen oder bei einer Bestellung/Verlängerung bei. Enthält keine Personendaten.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="hm-btn hm-btn--secondary" disabled={downloading} onClick={downloadReport}>
              <Download size={15} /> Lizenzbericht herunterladen
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}

function Fact({
  label,
  value,
  hint,
  mono,
  action,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div className="row" style={{ gap: 6 }}>
        <span
          style={{
            fontWeight: 600,
            overflowWrap: 'anywhere',
            ...(mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 'var(--text-sm)' } : {}),
          }}
        >
          {value}
        </span>
        {action}
      </div>
      {hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Die Zwischenablage kann vom Browserkern verweigert werden — die ID
      // steht sichtbar daneben, abschreiben geht immer.
      toast.error('Kopieren nicht möglich — bitte abschreiben');
    }
  }
  return (
    <Tooltip content={<div className="hm-tooltip__title">{copied ? 'Kopiert' : 'In die Zwischenablage kopieren'}</div>}>
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
        onClick={copy}
        aria-label="Installations-ID kopieren"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </Tooltip>
  );
}
