import React, { useRef, useState } from 'react';
import {
  DOCUMENT_CATEGORY_LABELS,
  type DocumentSource,
  type MeDocument,
} from '@ohrganize/shared';
import { ApiRequestError } from '../api/client';
import {
  PORTAL_UPLOAD_CATEGORIES,
  useDocumentDownload,
  useMyDocuments,
  useUploadDocument,
  type PortalUploadCategory,
} from '../api/hooks';
import { Card, EmptyState, Field, LoadError, SkeletonRows } from '../components/ui';
import { IconClose, IconDocuments, type IconProps } from '../components/icons';
import { useToast } from '../components/Toast';
import { formatDate } from '../lib/format';

/*
 * Zwei Icons, die die Sidebar nicht braucht und die es deshalb (noch) nicht in
 * components/icons.tsx gibt. Gleiches Raster und gleiche Strichstärke wie dort
 * — eine Icon-Bibliothek kommt im Portal bewusst nicht dazu.
 */
function IconUploadCloud({ size = 17, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M17 17h1a4 4 0 0 0 .5-7.97 6 6 0 0 0-11.6-1.6A4.5 4.5 0 0 0 6 17h1" />
      <path d="M12 12v9" />
      <path d="m8.5 15.5 3.5-3.5 3.5 3.5" />
    </svg>
  );
}

function IconDownload({ size = 17, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </svg>
  );
}

/*
 * Grenzen des Backends (modules/me/documentRoutes.ts) — hier gespiegelt, um
 * schon vor dem Absenden verständlich zu melden, statt den Upload erst über
 * die Leitung zu schicken. Der Server prüft weiterhin selbst; diese Prüfung
 * ist Bequemlichkeit, keine Sicherheit.
 */
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
const ALLOWED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.txt'];
/** Für das native Auswahlfenster: dieselbe Liste in der accept-Schreibweise. */
const ACCEPT_ATTR = [...ALLOWED_MIME_TYPES, ...ALLOWED_EXTENSIONS].join(',');

const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'text/plain': 'Text',
};

const SOURCE_LABELS: Record<DocumentSource, string> = {
  hr: 'Personalabteilung',
  portal: 'Selbst hochgeladen',
};

/** "text/plain; charset=utf-8" → "text/plain" (Browser hängen Parameter an). */
function normalizeMime(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

function fileTypeLabel(mimeType: string): string {
  const mime = normalizeMime(mimeType);
  return MIME_LABELS[mime] ?? (mime.split('/')[1] ?? mime).toUpperCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Dateiname ohne Endung — Vorschlag für das Titelfeld. */
function titleFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Gibt eine deutsche Meldung zurück, wenn die Datei die Grenzen reißt —
 * sonst null.
 */
function validateFile(file: File): string | null {
  if (file.size === 0) return 'Die Datei ist leer.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Die Datei ist ${formatSize(file.size)} groß. Erlaubt sind höchstens ${MAX_UPLOAD_MB} MB.`;
  }
  const mime = normalizeMime(file.type);
  // Für .txt meldet Windows gelegentlich gar keinen Typ — dann entscheidet
  // die Endung, damit eine erlaubte Datei nicht grundlos abgewiesen wird.
  const allowed = mime
    ? ALLOWED_MIME_TYPES.includes(mime)
    : ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
  if (!allowed) {
    return 'Dieser Dateityp wird nicht unterstützt. Erlaubt sind PDF, PNG, JPEG und einfache Textdateien.';
  }
  return null;
}

/**
 * Ablage für die Datei: Ziehen und Ablegen plus Klick — Vorbild ist die
 * FilePicker-Dropzone der Desktop-App. Das <input type="file"> bleibt im
 * Markup (sonst gäbe es kein Auswahlfenster), ist aber versteckt und wird nur
 * über diese Fläche ausgelöst.
 */
function DocumentDropzone({
  file,
  onFile,
  busy,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT_ATTR}
      hidden
      disabled={busy}
      onChange={(e) => {
        const picked = e.target.files?.[0] ?? null;
        // Wert zurücksetzen, damit dieselbe Datei erneut gewählt werden kann.
        e.target.value = '';
        if (picked) onFile(picked);
      }}
    />
  );

  if (file) {
    return (
      <div className="doc-drop doc-drop--filled">
        <span className="doc-drop__icon">
          <IconDocuments size={19} />
        </span>
        <span className="doc-drop__meta">
          <span className="doc-drop__name">{file.name}</span>
          <span className="doc-drop__sub">
            {busy ? 'Wird hochgeladen …' : `${fileTypeLabel(file.type)} · ${formatSize(file.size)}`}
          </span>
        </span>
        {!busy && (
          <button
            type="button"
            className="pt-btn pt-btn--quiet pt-btn--sm"
            onClick={() => onFile(null)}
            aria-label={`Datei ${file.name} entfernen`}
          >
            <IconClose size={15} />
          </button>
        )}
        {input}
      </div>
    );
  }

  return (
    <div
      className={`doc-drop doc-drop--empty${dragging ? ' is-dragging' : ''}${busy ? ' is-disabled' : ''}`}
      role="button"
      tabIndex={0}
      aria-disabled={busy || undefined}
      aria-describedby="doc-drop-hint"
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Beim Wechsel auf ein Kindelement feuert dragleave ebenfalls — nur
        // ein echtes Verlassen der Fläche darf die Hervorhebung nehmen.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) onFile(dropped);
      }}
    >
      <span className="doc-drop__icon">
        <IconUploadCloud size={20} />
      </span>
      <span className="doc-drop__meta">
        <span className="doc-drop__name">
          <b style={{ color: 'var(--brand-primary)' }}>Datei wählen</b> oder hierher ziehen
        </span>
        <span className="doc-drop__sub" id="doc-drop-hint">
          PDF, PNG, JPEG oder Textdatei, höchstens {MAX_UPLOAD_MB} MB
        </span>
      </span>
      {input}
    </div>
  );
}

function UploadCard() {
  const toast = useToast();
  const upload = useUploadDocument();

  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<PortalUploadCategory>('bescheinigung');
  const [title, setTitle] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  function pickFile(picked: File | null) {
    setApiError(null);
    if (!picked) {
      setFile(null);
      setFileError(null);
      return;
    }
    const problem = validateFile(picked);
    setFileError(problem);
    // Eine unzulässige Datei wird gar nicht erst übernommen — sonst stünde ein
    // absendbereites Formular neben der Fehlermeldung.
    setFile(problem ? null : picked);
    if (!problem && !title.trim()) setTitle(titleFromFileName(picked.name));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || upload.isPending) return;
    setApiError(null);
    upload.mutate(
      { file, category, title: title.trim() || undefined },
      {
        onSuccess: (res) => {
          setFile(null);
          setTitle('');
          setFileError(null);
          toast.success(`„${res.document.title}“ wurde hochgeladen`);
        },
        onError: (err) => {
          setApiError(
            err instanceof ApiRequestError
              ? err.message
              : 'Das Dokument konnte nicht hochgeladen werden. Bitte versuchen Sie es erneut.',
          );
        },
      },
    );
  }

  return (
    <Card title="Dokument hochladen">
      <form onSubmit={submit}>
        <DocumentDropzone file={file} onFile={pickFile} busy={upload.isPending} />

        {upload.isPending && (
          // Der Upload läuft als eine Anfrage; einen Bytestand meldet das
          // Backend nicht zurück, deshalb ein unbestimmter Balken statt eines
          // Prozentwerts, der nur geschätzt wäre.
          <div
            className="doc-progress"
            style={{ marginTop: 12 }}
            role="progressbar"
            aria-label="Dokument wird hochgeladen"
          >
            <div className="doc-progress__bar" />
          </div>
        )}

        {fileError && (
          <p className="pt-alert pt-alert--danger" style={{ marginTop: 14 }} role="alert">
            {fileError}
          </p>
        )}

        <div className="pt-form-grid" style={{ marginTop: 18 }}>
          <Field label="Titel" hint="Ohne Angabe wird der Dateiname übernommen.">
            <input
              className="pt-input"
              type="text"
              value={title}
              maxLength={300}
              disabled={upload.isPending}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="z. B. Immatrikulationsbescheinigung"
            />
          </Field>
          <Field label="Kategorie" required hint="Verträge und Zeugnisse legt die Personalabteilung ab.">
            <select
              className="pt-select"
              value={category}
              disabled={upload.isPending}
              onChange={(e) => setCategory(e.target.value as PortalUploadCategory)}
            >
              {PORTAL_UPLOAD_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {DOCUMENT_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {apiError && (
          <p className="pt-alert pt-alert--danger" style={{ marginTop: 18 }} role="alert">
            {apiError}
          </p>
        )}

        <div className="row" style={{ marginTop: 20 }}>
          <button
            type="submit"
            className="pt-btn pt-btn--primary"
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? 'Wird hochgeladen …' : 'Hochladen'}
          </button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Ihre Personalabteilung sieht hochgeladene Dokumente und behält sie in Ihrer Akte.
          </span>
        </div>
      </form>
    </Card>
  );
}

/** Eine Zeile der Dokumentenliste samt eigenem Ladezustand für den Download. */
function DocumentRow({ doc }: { doc: MeDocument }) {
  const toast = useToast();
  const download = useDocumentDownload();
  // Die signierte URL gilt nur wenige Minuten — sie wird deshalb bei jedem
  // Klick neu geholt und nirgends zwischengespeichert.
  const busy = download.isPending;

  return (
    <tr>
      <td>
        <span style={{ fontWeight: 600 }}>{doc.title}</span>
        <span className="doc-file">{doc.original_name}</span>
      </td>
      <td>{DOCUMENT_CATEGORY_LABELS[doc.category] ?? doc.category}</td>
      <td>
        <span className={`pt-chip pt-chip--${doc.source === 'portal' ? 'info' : 'neutral'}`}>
          {SOURCE_LABELS[doc.source] ?? doc.source}
        </span>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(doc.created_at.slice(0, 10))}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {fileTypeLabel(doc.mime_type)}
        <span style={{ color: 'var(--text-muted)' }}> · {formatSize(doc.size_bytes)}</span>
      </td>
      <td className="num">{doc.version}</td>
      <td style={{ textAlign: 'right' }}>
        <button
          type="button"
          className="pt-btn pt-btn--secondary pt-btn--sm"
          disabled={busy}
          aria-label={`${doc.title} herunterladen`}
          onClick={() =>
            download.mutate(doc.id, {
              onError: (err) =>
                toast.error(
                  err instanceof ApiRequestError
                    ? err.message
                    : 'Der Download konnte nicht gestartet werden.',
                ),
            })
          }
        >
          <IconDownload size={15} />
          {busy ? 'Wird geladen …' : 'Herunterladen'}
        </button>
      </td>
    </tr>
  );
}

export function DocumentsPage() {
  const { data: documents, isLoading, error } = useMyDocuments();

  return (
    <div>
      <header className="portal-page-header">
        <h1 className="portal-title">Dokumente</h1>
        <p className="portal-subtitle">
          Ihre Personalunterlagen zum Herunterladen — und Platz für eigene Nachweise.
        </p>
      </header>

      <div className="stack">
        <UploadCard />

        <Card
          title="Ihre Dokumente"
          flush
          actions={
            documents && documents.length > 0 ? (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {documents.length} {documents.length === 1 ? 'Dokument' : 'Dokumente'}
              </span>
            ) : undefined
          }
        >
          {error ? (
            <div className="pt-card__body">
              <LoadError error={error} />
            </div>
          ) : isLoading ? (
            <div className="pt-card__body">
              <SkeletonRows rows={4} />
            </div>
          ) : !documents || documents.length === 0 ? (
            <EmptyState
              title="Noch keine Dokumente"
              hint="Sobald die Personalabteilung etwas für Sie ablegt oder Sie selbst einen Nachweis hochladen, erscheint er hier."
            />
          ) : (
            <div className="pt-table-wrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Dokument</th>
                    <th>Kategorie</th>
                    <th>Herkunft</th>
                    <th>Hinterlegt am</th>
                    <th>Datei</th>
                    <th className="num">Version</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <DocumentRow key={doc.id} doc={doc} />
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
