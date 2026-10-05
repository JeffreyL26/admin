import React, { useEffect, useMemo, useState } from 'react';
import { Handshake, Plus, Trash2 } from 'lucide-react';
import {
  ASSIGNMENT_KIND_LABELS,
  ASSIGNMENT_TARGET_LABELS,
  formatDate,
  type AssignmentKind,
  type AssignmentTargetType,
  type Leader,
  type LeadershipAssignment,
  type TeamMember,
} from '@ohrganize/shared';
import { Avatar, Badge, Field, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useAvatarPhoto } from '../employees/avatarPhoto';
import { useCreateAssignment, useDeleteAssignment, useLeaderTeam, useLeadershipLookup } from './api';
import { SourceBadges } from './common';
import { SetupEmployeeSelect, SetupNote, errorMessage, personCount } from './SetupShared';
import { Select } from '../../components/Select';

/**
 * Zuständigkeit einer Führungskraft: Vorschau der abgeleiteten Personen mit
 * Quelle, die manuellen Zuweisungen/Ausnahmen und das Formular für neue
 * Zuweisungen. Alles, was hier zu sehen ist, berechnet das Backend
 * (service.scopeFor). Die Oberfläche zeigt nur, was tatsächlich gilt.
 */
export function SetupScopeModal({
  leader,
  canEdit,
  own = false,
  onClose,
}: {
  leader: Leader | null;
  canEdit: boolean;
  /**
   * Das eigene Profil (Selbstschutz, service.assertNotOwnLeadership): nur
   * Änderungen, die den Bereich verkleinern, also Ausnahmen anlegen und
   * Ergänzungen entfernen.
   */
  own?: boolean;
  onClose: () => void;
}) {
  const open = leader !== null;
  const { data, isLoading } = useLeaderTeam(leader?.employee_id ?? null);
  const name = leader ? `${leader.first_name} ${leader.last_name}` : '';
  // Die Antwort trägt die frischeren Zahlen (nach einer Zuweisung), die
  // Zeile aus der Liste bleibt als Fallback bis zum ersten Laden.
  const current = data?.leader ?? leader;

  return (
    <Modal title={`Zuständigkeit: ${name}`} open={open} onClose={onClose} wide>
      {isLoading || !data || !current ? (
        <Spinner center />
      ) : (
        <div className="stack" style={{ gap: 22 }}>
          <div className="row row--wrap" style={{ gap: 8 }}>
            <Badge tone="blue">{personCount(current.team_size)} zuständig</Badge>
            {current.auto_scope === 1 ? (
              <Badge tone="green">Automatisch aus der Organisation</Badge>
            ) : (
              <Badge tone="neutral">Nur manuelle Zuweisungen</Badge>
            )}
            <Badge tone="neutral">
              {data.assignments.length}{' '}
              {data.assignments.length === 1 ? 'manuelle Zuweisung' : 'manuelle Zuweisungen'}
            </Badge>
          </div>

          {data.mutual.length > 0 && (
            <SetupNote tone="warning" icon={<Handshake size={15} />}>
              Gegenseitige Verantwortung mit{' '}
              <strong>{data.mutual.map((m) => `${m.first_name} ${m.last_name}`).join(', ')}</strong>: Diese
              Person{data.mutual.length === 1 ? ' ist ihrerseits' : 'en sind ihrerseits'} für {name} zuständig
              und bewertet {name} ebenfalls.
            </SetupNote>
          )}

          {canEdit && own && (
            <SetupNote>
              Das ist Ihr eigenes Profil. Den eigenen Bereich <strong>verkleinern</strong> können Sie hier
              (Ausnahme anlegen, Ergänzung entfernen); <strong>erweitern</strong> muss ihn eine andere Person mit
              Recht „Führung“, denn „Mein Team“ öffnet auch Gesprächsprotokolle.
            </SetupNote>
          )}

          <section>
            <h3 className="lead-setup-section__title">Aktuelle Zuständigkeit</h3>
            <TeamPreview team={data.team} />
          </section>

          <section>
            <h3 className="lead-setup-section__title">Manuelle Zuweisungen</h3>
            <AssignmentTable assignments={data.assignments} canEdit={canEdit} own={own} />
          </section>

          {canEdit && (
            <section>
              <h3 className="lead-setup-section__title">Zuweisung hinzufügen</h3>
              <AssignmentForm leaderId={current.employee_id} own={own} />
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Vorschau der abgeleiteten Personen
// ---------------------------------------------------------------------------

function MemberAvatar({ member }: { member: TeamMember }) {
  const photo = useAvatarPhoto(member);
  return <Avatar name={`${member.first_name} ${member.last_name}`} size={30} src={photo.src} photoRef={photo.ref} />;
}

function TeamPreview({ team }: { team: TeamMember[] }) {
  if (team.length === 0) {
    return (
      <p className="lead-setup-empty">
        Aktuell ist niemand zugeordnet. Prüfen Sie, ob die Person in der Organisation als Vorgesetzte:r,
        Abteilungs- oder Teamleitung hinterlegt ist, oder ergänzen Sie unten eine Zuweisung.
      </p>
    );
  }
  return (
    <div className="hm-table-wrap lead-setup-table">
      <table className="hm-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Abteilung / Team</th>
            <th>Quellen</th>
          </tr>
        </thead>
        <tbody>
          {team.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="row" style={{ gap: 10 }}>
                  <MemberAvatar member={m} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {m.first_name} {m.last_name}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{m.job_title ?? '—'}</div>
                  </div>
                </div>
              </td>
              <td style={{ color: 'var(--text-secondary)' }}>
                {[m.department_name, m.team_name].filter(Boolean).join(' · ') || '—'}
              </td>
              <td>
                <SourceBadges sources={m.sources} mutual={m.mutual} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manuelle Zuweisungen
// ---------------------------------------------------------------------------

function validityLabel(a: LeadershipAssignment): string {
  if (!a.valid_from && !a.valid_to) return 'unbefristet';
  if (a.valid_from && a.valid_to) return `${formatDate(a.valid_from)} – ${formatDate(a.valid_to)}`;
  if (a.valid_from) return `ab ${formatDate(a.valid_from)}`;
  return `bis ${formatDate(a.valid_to)}`;
}

function AssignmentTable({
  assignments,
  canEdit,
  own,
}: {
  assignments: LeadershipAssignment[];
  canEdit: boolean;
  own: boolean;
}) {
  const toast = useToast();
  const remove = useDeleteAssignment();
  const [deleting, setDeleting] = useState<LeadershipAssignment | null>(null);

  if (assignments.length === 0) {
    return (
      <p className="lead-setup-empty">
        Keine manuellen Zuweisungen. Die Zuständigkeit ergibt sich vollständig aus der Organisation.
      </p>
    );
  }
  return (
    <>
      <div className="hm-table-wrap lead-setup-table">
        <table className="hm-table">
          <thead>
            <tr>
              <th style={{ width: 160 }}>Art</th>
              <th>Ziel</th>
              <th style={{ width: 190 }}>Gültig</th>
              <th>Notiz</th>
              {canEdit && <th style={{ width: 56 }} />}
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td>
                  <Badge tone={a.kind === 'include' ? 'green' : 'red'}>{ASSIGNMENT_KIND_LABELS[a.kind]}</Badge>
                </td>
                <td>
                  <span style={{ color: 'var(--text-muted)' }}>{ASSIGNMENT_TARGET_LABELS[a.target_type]}:</span>{' '}
                  <span style={{ fontWeight: 600 }}>{a.target_name}</span>
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{validityLabel(a)}</td>
                <td style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{a.note || '—'}</td>
                {canEdit && (
                  <td>
                    {/* Eigenes Profil: eine Ausnahme zu löschen erweitert den Bereich. */}
                    {!(own && a.kind === 'exclude') && (
                    <button
                      type="button"
                      className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                      aria-label={`Zuweisung ${a.target_name} löschen`}
                      disabled={remove.isPending}
                      onClick={() => setDeleting(a)}
                    >
                      <Trash2 size={15} />
                    </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="Zuweisung löschen?"
        message={
          deleting
            ? `„${ASSIGNMENT_KIND_LABELS[deleting.kind]} · ${ASSIGNMENT_TARGET_LABELS[deleting.target_type]}: ${deleting.target_name}“ wird entfernt. Die Zuständigkeit richtet sich danach wieder allein nach Organisation und übrigen Zuweisungen; Bewertungen bleiben erhalten.`
            : ''
        }
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => toast.success('Zuweisung gelöscht'),
            onError: (e) => toast.error(errorMessage(e, 'Zuweisung konnte nicht gelöscht werden')),
          })
        }
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Formular: neue Zuweisung
// ---------------------------------------------------------------------------

const TARGET_TYPES: AssignmentTargetType[] = ['employee', 'department', 'team', 'role'];
const KINDS: AssignmentKind[] = ['include', 'exclude'];

function AssignmentForm({ leaderId, own }: { leaderId: number; own: boolean }) {
  const toast = useToast();
  const create = useCreateAssignment();
  // Eigenes Profil: nur Ausnahmen, eine Ergänzung erweiterte den eigenen Bereich.
  const kinds: AssignmentKind[] = own ? ['exclude'] : KINDS;
  const [kind, setKind] = useState<AssignmentKind>(own ? 'exclude' : 'include');
  const [targetType, setTargetType] = useState<AssignmentTargetType>('employee');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [note, setNote] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  // Zieltyp gewechselt → alte Ziel-ID gehört zu einer anderen Tabelle.
  useEffect(() => setTargetId(null), [targetType]);

  const exclude = useMemo(() => new Set([leaderId]), [leaderId]);
  const rangeInvalid = validFrom !== '' && validTo !== '' && validFrom > validTo;
  const canSubmit = targetId !== null && !rangeInvalid && !create.isPending;

  const submit = () => {
    if (targetId === null) return;
    create.mutate(
      {
        leaderId,
        input: {
          kind,
          target_type: targetType,
          target_id: targetId,
          valid_from: validFrom || null,
          valid_to: validTo || null,
          note: note.trim() || null,
        },
      },
      {
        onSuccess: (res) => {
          toast.success(kind === 'include' ? 'Zuweisung hinzugefügt' : 'Ausnahme hinzugefügt');
          setWarnings(res.warnings);
          setTargetId(null);
          setValidFrom('');
          setValidTo('');
          setNote('');
        },
        // 409 (gegenseitige Verantwortung nicht zugelassen) kommt mit
        // erklärender Meldung vom Server: direkt anzeigen.
        onError: (e) => toast.error(errorMessage(e, 'Zuweisung konnte nicht gespeichert werden')),
      },
    );
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {warnings.length > 0 && (
        <SetupNote tone="warning" icon={<Handshake size={15} />} onDismiss={() => setWarnings([])}>
          {warnings.join(' ')}
        </SetupNote>
      )}
      <div className="hm-form-grid">
        <Field label="Art" required>
          <Select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value as AssignmentKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {ASSIGNMENT_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Zieltyp" required>
          <Select
            className="hm-select"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as AssignmentTargetType)}
          >
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {ASSIGNMENT_TARGET_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={ASSIGNMENT_TARGET_LABELS[targetType]}
          required
          span2
          hint={
            targetType === 'department'
              ? 'Gilt für alle aktiven Mitarbeitenden der Abteilung inklusive Unterabteilungen.'
              : targetType === 'role'
                ? 'Gilt für alle aktiven Mitglieder der Fachrolle (Verwaltung → Rollen).'
                : targetType === 'team'
                  ? 'Gilt für alle aktiven Mitglieder des Teams.'
                  : undefined
          }
        >
          <TargetSelect type={targetType} value={targetId} onChange={setTargetId} exclude={exclude} />
        </Field>
        <Field label="Gültig ab" hint="Leer = ab sofort">
          <input className="hm-input" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field
          label="Gültig bis"
          hint={rangeInvalid ? undefined : 'Leer = unbefristet (z. B. für Projekte oder Vertretungen befristen)'}
          error={rangeInvalid ? '„Gültig bis“ darf nicht vor „Gültig ab“ liegen.' : undefined}
        >
          <input className="hm-input" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
        <Field label="Notiz" span2 hint="Warum diese Zuweisung? Erscheint in der Tabelle oben.">
          <input
            className="hm-input"
            value={note}
            maxLength={400}
            placeholder="z. B. Projektleitung bis Jahresende"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="hm-btn hm-btn--primary hm-btn--sm" disabled={!canSubmit} onClick={submit}>
          <Plus size={15} /> Zuweisung hinzufügen
        </button>
      </div>
    </div>
  );
}

function TargetSelect({
  type,
  value,
  onChange,
  exclude,
}: {
  type: AssignmentTargetType;
  value: number | null;
  onChange: (id: number | null) => void;
  exclude: Set<number>;
}) {
  // Alle Listen kommen aus dem Lookup des Bereichs fuehrung (eine Antwort):
  // /api/departments, /api/teams und /api/admin/roles hingen an `personal`
  // bzw. `verwaltung`: ein reines Einrichtungs-Konto sähe dort nichts.
  const lookup = useLeadershipLookup().data;

  if (type === 'employee') {
    return <SetupEmployeeSelect value={value} onChange={onChange} exclude={exclude} />;
  }
  const options: { id: number; label: string }[] =
    type === 'department'
      ? (lookup?.departments ?? []).map((d) => ({ id: d.id, label: d.name }))
      : type === 'team'
        ? (lookup?.teams ?? []).map((t) => ({ id: t.id, label: t.name }))
        : (lookup?.roles ?? []).map((r) => ({ id: r.id, label: r.name }));
  const sorted = [...options].sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return (
    <Select
      className="hm-select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">— {ASSIGNMENT_TARGET_LABELS[type]} auswählen —</option>
      {sorted.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
