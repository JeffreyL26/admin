import React, { useMemo, useState } from 'react';
import { Handshake, Plus, Users, UserX } from 'lucide-react';
import { formatDateTime, moduleEnabled, type Leader } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { Avatar, Badge, Card, EmptyState, Field, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useAvatarPhoto } from '../employees/avatarPhoto';
import { useGrantLeader, useLeaders, useLeadershipLookup, useRevokeLeader, useUpdateLeader } from './api';
import { SetupScopeModal } from './SetupScopeModal';
import { SetupEmployeeSelect, SetupNote, errorMessage, personCount } from './SetupShared';
import { tourEvent } from '../tours/events';

/**
 * Reiter „Führungskräfte“: Wer ist freigeschaltet, wofür ist die Person
 * zuständig, hat sie ein Desktop-Konto? Freischalten, Automatik umschalten,
 * Zuständigkeit ansehen/ergänzen, entziehen.
 */
export function SetupLeadersTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  // Selbstschutz (Backend: service.assertNotOwnLeadership): den eigenen Bereich
  // ERWEITERN (freischalten, Automatik an, Ergänzung, Ausnahme entfernen) macht
  // eine andere Person; verkleinern und entziehen bleibt möglich.
  const ownId = useAuth().user?.employee_id ?? null;
  const { data: leaders, isLoading, error } = useLeaders();
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
              ? 'Automatische Ableitung ausgeschaltet: nur manuelle Zuweisungen gelten'
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
        Ergänzungen und Ausnahmen (etwa für Projekte, Vertretungen oder Matrixstrukturen) pflegen Sie
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
            <button
              type="button"
              className="hm-btn hm-btn--primary hm-btn--sm"
              data-tour="lf-grant-btn lf-grant-alt"
              onClick={() => {
                setGranting(true);
                tourEvent('leistung-fuehrung.grant-dialog');
              }}
            >
              <Plus size={15} /> Führungskraft freischalten
            </button>
          ) : undefined
        }
      >
        {error && !leaders ? (
          <SetupNote tone="warning">
            Führungskräfte konnten nicht geladen werden: {errorMessage(error, 'Server nicht erreichbar')}
          </SetupNote>
        ) : isLoading ? (
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
                    own={l.employee_id === ownId}
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
        ownId={ownId}
        onClose={() => setGranting(false)}
        onWarnings={setWarnings}
      />
      <SetupScopeModal
        leader={scopeFor}
        canEdit={canEdit}
        own={scopeFor !== null && scopeFor.employee_id === ownId}
        onClose={() => setScopeFor(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={`Freischaltung für „${revoking ? `${revoking.first_name} ${revoking.last_name}` : ''}“ entziehen?`}
        confirmLabel="Entziehen"
        message={
          <>
            Die Person verliert den Zugang zu „Mein Team“ und kann keine Bewertungen mehr abgeben.{' '}
            {revoking && revoking.assignment_count > 0
              ? `${revoking.assignment_count === 1 ? 'Ihre eine manuelle Zuweisung wird' : `Ihre ${revoking.assignment_count} manuellen Zuweisungen werden`} dabei entfernt. Ein späteres erneutes Freischalten startet ohne sie.`
              : 'Manuelle Zuweisungen bestehen keine.'}{' '}
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
  own,
  busy,
  onScope,
  onToggleAuto,
  onRevoke,
}: {
  leader: Leader;
  canEdit: boolean;
  /** Das eigene Profil: nur ansehen und entziehen (Selbstschutz). */
  own: boolean;
  busy: boolean;
  onScope: () => void;
  onToggleAuto: () => void;
  onRevoke: () => void;
}) {
  // Kein photo_url in der Leader-Antwort: usePhotoUrl signiert selbst und
  // fällt ohne personal:lesen still auf Initialen zurück. Erst bei
  // Sichtbarkeit, damit eine lange Liste nicht je Zeile signiert.
  const photo = useAvatarPhoto(leader);
  const name = `${leader.first_name} ${leader.last_name}`;
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 10 }}>
          <Avatar name={name} size={34} src={photo.src} photoRef={photo.ref} />
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
                <div className="hm-tooltip__line">Bestehendes Portal-Konto? Löschen · Desktop-Konto ist zugleich portalfähig</div>
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
          <span>{formatDateTime(leader.created_at)}</span>
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
          {canEdit && own && (
            <Tooltip
              content={
                <>
                  <div className="hm-tooltip__title">Eigenes Profil</div>
                  <div className="hm-tooltip__line">Bereich erweitern · nur eine andere Person mit Recht „Führung“</div>
                  <div className="hm-tooltip__line">Verkleinern · Automatik aus, Ausnahmen, Entziehen</div>
                </>
              }
            >
              <span>
                <Badge tone="neutral">Eigenes Profil</Badge>
              </span>
            </Tooltip>
          )}
          {canEdit && (
            <>
              {/* Eigenes Profil: nur ausschalten (verkleinert den Bereich). */}
              {(!own || leader.auto_scope === 1) && (
              <Tooltip
                content={
                  <>
                    <div className="hm-tooltip__title">Automatische Ableitung</div>
                    <div className="hm-tooltip__line">
                      An · Zuständigkeit aus Organisation (Vorgesetzte:r, Abteilungs- oder Teamleitung) + manuelle Zuweisungen
                    </div>
                    <div className="hm-tooltip__line">Aus · nur manuelle Zuweisungen</div>
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
              )}
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
  ownId,
  onClose,
  onWarnings,
}: {
  open: boolean;
  existing: Leader[];
  /** Eigenes Profil: wird nicht angeboten (Selbstschutz). */
  ownId: number | null;
  onClose: () => void;
  onWarnings: (warnings: string[]) => void;
}) {
  const toast = useToast();
  const grant = useGrantLeader();
  // Rang (backend core/accountRights.ts): Ein vorhandenes Konto liest nach der
  // Freischaltung Protokolle; freischalten darf es nur, wer das selbst darf.
  // Vorher sagen, statt nach dem Klick. Nur in Varianten mit Protokollen.
  const { can } = useAuth();
  const protocolsInVariant = moduleEnabled(VARIANT, 'communication');
  const mayGrantWithAccount = !protocolsInVariant || can('kommunikation', 'lesen');
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [autoScope, setAutoScope] = useState(true);
  const [note, setNote] = useState('');

  const exclude = useMemo(
    () => new Set([...existing.map((l) => l.employee_id), ...(ownId === null ? [] : [ownId])]),
    [existing, ownId],
  );

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
          tourEvent('leistung-fuehrung.grant-saved');
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
      <GrantFormGrid exclude={exclude}>
        <Field
          label="Person"
          required
          span2
          hint="Nur aktive Mitarbeitende; bereits freigeschaltete Personen und das eigene Profil werden nicht angeboten."
        >
          <SetupEmployeeSelect value={employeeId} onChange={setEmployeeId} exclude={exclude} autoFocus />
        </Field>
        <div className="span-2">
          <label className="hm-checkbox">
            <input type="checkbox" checked={autoScope} onChange={(e) => setAutoScope(e.target.checked)} />
            <span>Zuständigkeit automatisch aus der Organisation ableiten</span>
          </label>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Empfohlen. Ohne Automatik gelten ausschließlich manuelle Zuweisungen. Das eignet sich etwa für
            Sachbearbeitende in der HR, die gezielt einzelne Personen bewerten sollen.
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
        {!mayGrantWithAccount && (
          <div className="span-2">
            <SetupNote tone="warning">
              Ohne Leserecht „Kommunikation“ können Sie nur Personen <strong>ohne</strong> Desktop-Konto
              freischalten: Mit Konto läse die Person danach Gesprächsprotokolle, und dieses Recht können Sie
              nicht weitergeben.
            </SetupNote>
          </div>
        )}
        <div className="span-2">
          <SetupNote>
            Hat jemand das Passwort eines vorhandenen Kontos ausgegeben, dem „Führung“
            {protocolsInVariant && ' oder „Kommunikation“'} fehlte, lehnt die Freischaltung ab. Dann setzt zuerst
            jemand mit diesen Rechten und der Benutzerverwaltung das Passwort zurück.{' '}
            Ein Personalprofil ohne Desktop-Konto darf freigeschaltet werden. Damit die Person „Mein Team“
            sieht, legen Sie unter <strong>Verwaltung → Benutzer &amp; Rechte</strong> ein Konto an und verknüpfen
            es mit dem Profil (z. B. mit der Admin-Rolle „Führungskraft“).
          </SetupNote>
        </div>
      </GrantFormGrid>
    </Modal>
  );
}

/**
 * Formularraster des Dialogs und Ziel der Einfuehrung. Eigene Komponente, damit die Personenliste
 * nur geladen wird, solange der Dialog offen ist. Ist niemand mehr frei (eigenes Profil und
 * Freigeschaltete ausgenommen), zeigt die Einfuehrung ihren Hinweis statt des Formulars.
 */
function GrantFormGrid({ exclude, children }: { exclude: Set<number>; children: React.ReactNode }) {
  const employees = useLeadershipLookup().data?.employees;
  // Bis die Liste da ist, kein Ziel: sonst zeigte die Einfuehrung kurz den Formulartext und wechselte dann auf den Hinweis.
  const tour = employees === undefined ? undefined : employees.every((e) => exclude.has(e.id)) ? 'lf-grant-empty' : 'lf-grant-form';
  return (
    <div className="hm-form-grid" data-tour={tour}>
      {children}
    </div>
  );
}
