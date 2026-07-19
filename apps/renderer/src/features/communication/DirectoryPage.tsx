import React, { useEffect, useState } from 'react';
import { Mail, Phone, Settings, BookUser, MapPin } from 'lucide-react';
import {
  DIRECTORY_FIELD_KEYS,
  DIRECTORY_FIELD_LABELS,
  type DirectoryFieldKey,
} from '@hrmonic/shared';
import { API_BASE } from '../../api/client';
import { Avatar, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useDirectory, useDirectoryFields, useOrg, useSaveDirectoryFields } from './api';

function useDebounced(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function FieldVisibilityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data: fields } = useDirectoryFields();
  const save = useSaveDirectoryFields();
  const [draft, setDraft] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open && fields) {
      setDraft(Object.fromEntries(fields.map((f) => [f.field_key, f.visible])));
    }
  }, [open, fields]);

  return (
    <Modal
      title="Sichtbare Felder im Verzeichnis"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                DIRECTORY_FIELD_KEYS.map((k) => ({ field_key: k, visible: draft[k] ?? true })),
                {
                  onSuccess: () => {
                    toast.success('Sichtbarkeit gespeichert');
                    onClose();
                  },
                  onError: (e) => toast.error(e.message),
                },
              )
            }
          >
            Speichern
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>
        Ausgeblendete Felder werden serverseitig entfernt und sind für keinen Client sichtbar.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        {DIRECTORY_FIELD_KEYS.map((key: DirectoryFieldKey) => (
          <label key={key} className="hm-checkbox">
            <input
              type="checkbox"
              checked={draft[key] ?? true}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
            />
            {DIRECTORY_FIELD_LABELS[key]}
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function DirectoryPage() {
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState<number | undefined>();
  const [locationId, setLocationId] = useState<number | undefined>();
  const [skill, setSkill] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const debouncedSearch = useDebounced(search);
  const debouncedSkill = useDebounced(skill);
  const { data: org } = useOrg();
  const { data, isLoading } = useDirectory({
    search: debouncedSearch || undefined,
    department_id: departmentId,
    location_id: locationId,
    skill: debouncedSkill || undefined,
  });

  const employees = data?.employees ?? [];
  const fields = data?.fields;

  return (
    <>
      <PageHeader
        title="Mitarbeiterverzeichnis"
        subtitle="Dienstliche Kontaktdaten und Skills der aktiven Mitarbeitenden"
        actions={
          <button
            className="hm-btn hm-btn--secondary"
            onClick={() => setSettingsOpen(true)}
            title="Sichtbare Felder konfigurieren"
          >
            <Settings size={16} /> Felder
          </button>
        }
      />

      <div className="hm-card" style={{ marginBottom: 16 }}>
        <div className="hm-card__body" style={{ padding: 14 }}>
          <div className="row row--wrap">
            <input
              className="hm-input"
              style={{ maxWidth: 260 }}
              placeholder="Suche nach Name, Funktion, E-Mail …"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="hm-select"
              style={{ maxWidth: 200 }}
              value={departmentId ?? ''}
              onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">Alle Abteilungen</option>
              {(org?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              className="hm-select"
              style={{ maxWidth: 200 }}
              value={locationId ?? ''}
              onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">Alle Standorte</option>
              {(org?.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <input
              className="hm-input"
              style={{ maxWidth: 180 }}
              placeholder="Skill, z. B. TypeScript"
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            />
          </div>
        </div>
      </div>

      {isLoading ? (
        <Spinner center />
      ) : employees.length === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<BookUser size={40} />}
            title="Keine Mitarbeitenden gefunden"
            hint="Passen Sie Suche oder Filter an."
          />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 14,
          }}
        >
          {employees.map((e) => {
            const name = `${e.first_name} ${e.last_name}`;
            return (
              <div key={e.id} className="hm-card">
                <div className="hm-card__body" style={{ padding: 16 }}>
                  <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                    <Avatar
                      name={name}
                      size={48}
                      src={e.photo_url ? `${API_BASE}${e.photo_url}` : undefined}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 650 }}>{name}</div>
                      {fields?.job_title && (
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                          {e.job_title ?? '—'}
                        </div>
                      )}
                      {(fields?.department || fields?.location) && (
                        <div
                          className="row"
                          style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', gap: 4, marginTop: 2 }}
                        >
                          <MapPin size={12} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {[e.department_name, e.team_name, e.location_name].filter(Boolean).join(' · ') || '—'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  {(fields?.email || fields?.phone) && (
                    <div className="stack" style={{ gap: 4, marginTop: 12, fontSize: 'var(--text-sm)' }}>
                      {fields?.email && e.email && (
                        <span className="row" style={{ gap: 7, color: 'var(--text-secondary)' }}>
                          <Mail size={14} /> {e.email}
                        </span>
                      )}
                      {fields?.phone && e.phone && (
                        <span className="row" style={{ gap: 7, color: 'var(--text-secondary)' }}>
                          <Phone size={14} /> {e.phone}
                        </span>
                      )}
                    </div>
                  )}
                  {fields?.skills && (e.skills?.length ?? 0) > 0 && (
                    <div className="row row--wrap" style={{ gap: 6, marginTop: 12 }}>
                      {e.skills!.map((s) => (
                        <Badge key={s.name} tone="blue">
                          {s.name} · {s.level}/5
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <FieldVisibilityDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
