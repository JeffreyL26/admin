import React, { useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, UploadCloud, X } from 'lucide-react';
import { Avatar } from './ui';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Schöne Datei-Auswahl mit Drag-and-Drop — ersetzt das native
 * <input type="file"> ("Datei auswählen / keine ausgewählt").
 */
export function FilePicker({
  file,
  onFile,
  accept,
  disabled,
  busy,
  hint,
  existingLabel,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  accept?: string;
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  /** Anzeige, wenn schon eine Datei am Server hinterlegt ist (Bearbeiten-Fall). */
  existingLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  if (file) {
    return (
      <div className="hm-filepick hm-filepick--filled">
        <span className="hm-filepick__icon">
          {busy ? <Loader2 size={17} className="hm-spin" /> : <FileText size={17} />}
        </span>
        <span className="hm-filepick__meta">
          <span className="hm-filepick__name">{file.name}</span>
          <span className="hm-filepick__sub">{busy ? 'Wird hochgeladen …' : formatSize(file.size)}</span>
        </span>
        {!busy && (
          <button
            type="button"
            className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
            onClick={() => onFile(null)}
            title="Entfernen"
          >
            <X size={15} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`hm-filepick hm-filepick--drop${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled) return;
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <span className="hm-filepick__cloud">
        <UploadCloud size={20} />
      </span>
      <span className="hm-filepick__meta">
        <span className="hm-filepick__name">
          {existingLabel ? (
            <>
              <Paperclip size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
              {existingLabel} — neue Datei wählen
            </>
          ) : (
            <>
              <b style={{ color: 'var(--brand-primary)' }}>Datei wählen</b> oder hierher ziehen
            </>
          )}
        </span>
        {hint && <span className="hm-filepick__sub">{hint}</span>}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          onFile(f);
        }}
      />
    </div>
  );
}

/**
 * Foto-Auswahl mit runder Vorschau — für das Mitarbeiterfoto. Lädt sofort hoch
 * (async) und meldet die neue file_id. `previewUrl` zeigt ein bereits
 * hinterlegtes Foto.
 */
export function PhotoPicker({
  name,
  previewUrl,
  busy,
  disabled,
  onPick,
}: {
  name: string;
  previewUrl?: string;
  busy?: boolean;
  disabled?: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const shown = localPreview ?? previewUrl;

  return (
    <div className="row" style={{ gap: 14 }}>
      <button
        type="button"
        className="hm-photopick"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        title="Foto auswählen"
      >
        {shown ? (
          <img src={shown} alt={name} />
        ) : (
          <Avatar name={name} size={64} />
        )}
        <span className="hm-photopick__overlay">
          {busy ? <Loader2 size={18} className="hm-spin" /> : <UploadCloud size={18} />}
        </span>
      </button>
      <div>
        <button
          type="button"
          className="hm-btn hm-btn--secondary hm-btn--sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Lädt …' : shown ? 'Foto ersetzen' : 'Foto hochladen'}
        </button>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 5 }}>
          JPG oder PNG, quadratisch wirkt am besten
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setLocalPreview(URL.createObjectURL(f));
          onPick(f);
        }}
      />
    </div>
  );
}
