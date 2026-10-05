import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarDays,
  CircleAlert,
  Hash,
  History,
  ListChecks,
  Mail,
  MapPin,
  Phone,
  Plus,
  Save,
} from 'lucide-react';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  formatDate,
  formatDateTime,
  formatSeniority,
  todayIsoLocal,
  type EmployeeStatus,
  type EmployeeType,
  type Rating,
  type RatingCategory,
  type RatingHistoryEntry,
  type RatingPeriodKind,
  type RatingScaleKey,
} from '@ohrganize/shared';
import { ApiRequestError } from '../../api/client';
import { Avatar, Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { usePhotoUrl } from '../employees/api';
import { avatarFileId } from '../employees/avatarPhoto';
import { useLeaderStatus, useSaveRatings, useTeamMemberDetail } from './api';
import { EMPLOYEE_TYPE_TONES, PeriodSwitcher, SourceBadges } from './common';
import { ScoreBadge } from './RatingInput';
import { PROTOCOL_PARAM, TeamMemberMeetings } from './TeamMeetings';
import { TeamRatingBlock, type CategoryOption, type RatingBlock } from './TeamRatingBlock';
import { LeaderLockedState, OutOfScopeState, PeriodText, TeamNotice, isForbidden, truncate } from './TeamShared';

/**
 * Bewertungsmaske einer Person aus dem eigenen Zuständigkeitsbereich.
 *
 * Datenquelle ist ausschließlich GET /api/leadership/me/employees/:id:
 * Stammdaten, Kategorien, Bewertungen und Protokoll kommen in einer Antwort,
 * damit die Seite auch für Führungskräfte ohne Recht „personal“ funktioniert.
 * Der Zeitraum steht in der URL (?period=…), damit Links aus „Mein Team“ und
 * der Verlaufstabelle denselben Stand zeigen; fehlt der Parameter, gilt der
 * aktuelle Zeitraum.
 */
export function TeamMemberRatingPage() {
  const { id } = useParams();
  const employeeId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodParam = searchParams.get('period');
  const protocolParam = Number(searchParams.get(PROTOCOL_PARAM));
  const protocolFocus = Number.isInteger(protocolParam) && protocolParam > 0 ? protocolParam : null;

  const { data, error, isLoading, isPlaceholderData } = useTeamMemberDetail(employeeId, periodParam);
  const status = useLeaderStatus();
  // Vorschaubild reicht für 64 px bei jedem Zoom (Rechnung an PHOTO_THUMB_EDGE).
  const photo = usePhotoUrl(avatarFileId(data?.employee), data?.employee.photo_url);
  const save = useSaveRatings(employeeId);

  // ------------------------------------------------------------ Formular --
  const [blocks, setBlocks] = useState<RatingBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  /** Person + Zeitraum, aus denen die aktuellen Blöcke stammen; jeder Wechsel setzt neu auf. */
  const shownRef = useRef<string | null>(null);
  /** Aktion, die auf Bestätigung wartet, weil Eingaben verloren gingen. */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  // Verlassen der Seite (Sidebar, Befehlspalette, Tastenkürzel, Zurück-Knopf)
  // bei offenen Eingaben abfangen. Zeitraumwechsel ändern nur die Query und
  // laufen über guarded(): der Blocker vergleicht deshalb den Pfad.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  const periodKey = data?.period.key ?? null;
  // Stand des Servers als Signatur: Fokus-Refetches liefern neue Array-
  // Identitäten bei gleichem Inhalt. Die dürfen offene Eingaben nicht kippen.
  const serverSignature = data
    ? [
        ...data.ratings.map((r) => `r${r.id}:${r.version}:${r.scale}`),
        ...data.categories.map((c) => `c${c.id}:${c.effective_scale}:${c.name}`),
      ].join('|')
    : '';

  useEffect(() => {
    if (!data) return;
    const shownKey = `${employeeId}|${data.period.key}`;
    const contextChanged = shownRef.current !== shownKey;
    // Bei offenen Eingaben folgt das Formular dem Server nur, wenn Person oder
    // Zeitraum gewechselt haben (den Wechsel hat der Dirty-Schutz zuvor bestätigt).
    if (!contextChanged && dirtyRef.current) return;
    setBlocks(buildBlocks(data.ratings, data.categories));
    setDirty(false);
    shownRef.current = shownKey;
    // `data` selbst ist bewusst keine Abhängigkeit: employeeId, periodKey und
    // serverSignature decken jede inhaltliche Änderung ab.
  }, [employeeId, periodKey, serverSignature]);

  const categoryById = useMemo(
    () => new Map<number, RatingCategory>((data?.categories ?? []).map((c) => [c.id, c])),
    [data?.categories],
  );

  // ------------------------------------------------------ Fehlerzustände --
  if (!Number.isFinite(employeeId)) {
    return (
      <>
        <PageHeader title="Bewertung" />
        <OutOfScopeState onBack={() => navigate('/fuehrung/mein-team')} />
      </>
    );
  }
  if (isForbidden(error) && !data) {
    return (
      <>
        <PageHeader title="Bewertung" />
        {status.data && !status.data.is_leader ? (
          <LeaderLockedState />
        ) : (
          <OutOfScopeState message={error.message} onBack={() => navigate('/fuehrung/mein-team')} />
        )}
      </>
    );
  }
  if (error && !data) {
    return (
      <>
        <PageHeader title="Bewertung" />
        <div className="hm-card">
          <EmptyState
            title="Bewertung konnte nicht geladen werden"
            hint={error.message}
            action={
              <button type="button" className="hm-btn hm-btn--secondary" onClick={() => navigate('/fuehrung/mein-team')}>
                <ArrowLeft size={16} /> Zu Mein Team
              </button>
            }
          />
        </div>
      </>
    );
  }
  if (isLoading || !data) return <Spinner center />;

  // -------------------------------------------------------------- Ableitungen --
  const e = data.employee;
  const name = `${e.first_name} ${e.last_name}`;
  const type = e.employee_type as EmployeeType;
  const employeeStatus = e.status as EmployeeStatus;
  const kind = data.settings.period;
  const isFuture = data.period.from > todayIsoLocal();
  // Während eines Zeitraumwechsels zeigt keepPreviousData noch den alten
  // Stand. Der darf nicht bearbeitet werden, sonst landen Eingaben im
  // falschen Zeitraum.
  // … und während des Speicherns: Eingaben in dieser Zeit gingen beim
  // anschließenden Neuaufbau aus der Antwort verloren.
  const readOnly = isFuture || isPlaceholderData || save.isPending;
  const usedIds = new Set(blocks.map((b) => b.category_id));
  const firstFree = data.categories.find((c) => !usedIds.has(c.id));
  const lastSaved = data.ratings.reduce<Rating | null>(
    (acc, r) => (acc === null || r.updated_at > acc.updated_at ? r : acc),
    null,
  );
  const scaleFor = (b: RatingBlock): RatingScaleKey =>
    categoryById.get(b.category_id)?.effective_scale ?? b.saved?.scale ?? data.settings.scale;

  const facts: { icon: React.ReactNode; text: string; label: string }[] = [
    { icon: <Hash size={14} />, label: 'Personalnummer', text: e.personnel_number ? `Personalnr. ${e.personnel_number}` : 'Ohne Personalnummer' },
    {
      icon: <CalendarDays size={14} />,
      label: 'Eintritt',
      text: e.hire_date ? `Eintritt ${formatDate(e.hire_date)} · ${formatSeniority(e.hire_date)}` : 'Eintritt unbekannt',
    },
    ...(e.location_name ? [{ icon: <MapPin size={14} />, label: 'Standort', text: e.location_name }] : []),
    ...(e.email ? [{ icon: <Mail size={14} />, label: 'E-Mail', text: e.email }] : []),
    ...(e.phone ? [{ icon: <Phone size={14} />, label: 'Telefon', text: e.phone }] : []),
  ];

  // ---------------------------------------------------------- Aktionen --
  /** Führt `action` aus, bei offenen Eingaben erst nach Bestätigung. */
  const guarded = (action: () => void) => {
    if (dirtyRef.current) setPendingAction(() => action);
    else action();
  };

  const showPeriod = (key: string) =>
    guarded(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key === data.current_period.key) next.delete('period');
          else next.set('period', key);
          return next;
        },
        { replace: true },
      );
    });

  // Kein guarded(): Den Pfadwechsel fängt der Blocker oben ab.
  const backToTeam = () => navigate('/fuehrung/mein-team');

  const patchBlock = (uid: number, patch: Partial<RatingBlock>) => {
    setBlocks((bs) => bs.map((b) => (b.uid === uid ? { ...b, ...patch } : b)));
    setDirty(true);
  };

  const changeCategory = (uid: number, categoryId: number) => {
    setBlocks((bs) =>
      bs.map((b) => {
        if (b.uid !== uid) return b;
        const before = scaleFor(b);
        const after = categoryById.get(categoryId)?.effective_scale ?? data.settings.scale;
        // Andere Skala ⇒ der gewählte Wert bedeutet etwas anderes und fällt weg.
        return { ...b, category_id: categoryId, score: before === after ? b.score : null, scoreError: undefined };
      }),
    );
    setDirty(true);
  };

  const removeBlock = (uid: number) => {
    setBlocks((bs) => bs.filter((b) => b.uid !== uid));
    setDirty(true);
  };

  const addBlock = () => {
    if (!firstFree) return;
    const categoryId = firstFree.id;
    setBlocks((bs) => [...bs, newBlock(categoryId)]);
    setDirty(true);
  };

  const onSave = () => {
    let valid = true;
    const checked = blocks.map((b) => {
      const scoreError = b.score === null ? 'Bitte einen Wert auf der Skala wählen.' : undefined;
      const commentError = b.comment.trim() === '' ? 'Ein Kommentar ist Pflicht. Er wird protokolliert.' : undefined;
      if (scoreError || commentError) valid = false;
      return { ...b, scoreError, commentError };
    });
    setBlocks(checked);
    if (!valid) {
      toast.error('Bitte jeden Block mit Wert und Kommentar vervollständigen.');
      return;
    }
    save.mutate(
      {
        period_key: data.period.key,
        ratings: checked.map((b) => ({
          category_id: b.category_id,
          score: b.score as number,
          comment: b.comment.trim(),
        })),
      },
      {
        onSuccess: (res) => {
          // Die Invalidierung im Hook läuft VOR diesem Callback: Der Refetch
          // trifft ein, solange `dirty` noch gesetzt ist, und wird vom Effekt
          // oben bewusst ignoriert. Deshalb hier direkt aus der Antwort neu
          // aufbauen: sie ist derselbe Stand wie der Refetch (Versionen,
          // gespeicherte Blöcke, umgestellte Skalen).
          setBlocks(buildBlocks(res.ratings, data.categories));
          setDirty(false);
          toast.success('Bewertung gespeichert');
        },
        onError: (err) =>
          toast.error(err instanceof ApiRequestError ? err.message : 'Speichern fehlgeschlagen: Server nicht erreichbar.'),
      },
    );
  };

  // ------------------------------------------------------------ Anzeige --
  return (
    <>
      <PageHeader
        title={name}
        subtitle={[e.job_title, e.department_name, e.team_name].filter(Boolean).join(' · ') || 'Bewertung'}
        actions={
          <button type="button" className="hm-btn hm-btn--secondary" onClick={backToTeam}>
            <ArrowLeft size={16} /> Zu Mein Team
          </button>
        }
      />

      <div className="lead-profile">
        <Avatar name={name} size={64} src={photo.data} />
        <div className="lead-profile__body">
          <div className="row row--wrap" style={{ gap: 6 }}>
            {EMPLOYEE_TYPE_LABELS[type] && <Badge tone={EMPLOYEE_TYPE_TONES[type]}>{EMPLOYEE_TYPE_LABELS[type]}</Badge>}
            {employeeStatus !== 'aktiv' && EMPLOYEE_STATUS_LABELS[employeeStatus] && (
              <Badge tone="neutral">{EMPLOYEE_STATUS_LABELS[employeeStatus]}</Badge>
            )}
            <SourceBadges sources={e.sources} mutual={e.mutual} />
          </div>
          <div className="lead-facts">
            {facts.map((f) => (
              <span key={f.label} className="lead-facts__item" aria-label={f.label}>
                {f.icon}
                {f.text}
              </span>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <TeamNotice tone="warning">Der gewählte Zeitraum konnte nicht geladen werden: {error.message}</TeamNotice>
        </div>
      )}

      <div className="stack">
        <Card
          title={`Bewertung ${data.period.label}`}
          actions={<PeriodSwitcher period={data.period} current={data.current_period} onChange={showPeriod} />}
        >
          <div className="stack" style={{ gap: 14 }}>
            {isFuture && (
              <TeamNotice tone="warning">
                Zukünftiger Zeitraum: Bewertungen sind erst ab dem {formatDate(data.period.from)} möglich. Die Maske ist
                schreibgeschützt.
              </TeamNotice>
            )}

            {data.categories.length === 0 && blocks.length === 0 ? (
              <EmptyState
                title="Keine aktiven Bewertungskategorien"
                hint="Die HR pflegt Kategorien unter Führung → Einrichtung. Solange keine aktiv ist, kann nicht bewertet werden."
              />
            ) : (
              <>
                {blocks.map((b, index) => {
                  const category = categoryById.get(b.category_id);
                  const options: CategoryOption[] = data.categories
                    .filter((c) => c.id === b.category_id || !usedIds.has(c.id))
                    .map((c) => ({ id: c.id, name: c.name }));
                  // Gespeicherte Bewertung einer inzwischen deaktivierten
                  // Kategorie: bleibt sichtbar und änderbar, nur nicht neu wählbar.
                  if (!category && b.saved) {
                    options.unshift({ id: b.category_id, name: `${b.saved.category_name} (inaktiv)` });
                  }
                  return (
                    <TeamRatingBlock
                      key={b.uid}
                      block={b}
                      index={index}
                      scale={scaleFor(b)}
                      category={category}
                      options={options}
                      canRemove={blocks.length > 1 && b.saved === null}
                      readOnly={readOnly}
                      onCategoryChange={(categoryId) => changeCategory(b.uid, categoryId)}
                      onScoreChange={(score) => patchBlock(b.uid, { score, scoreError: undefined })}
                      onCommentChange={(comment) =>
                        patchBlock(b.uid, { comment, commentError: comment.trim() ? undefined : b.commentError })
                      }
                      onRemove={() => removeBlock(b.uid)}
                    />
                  );
                })}

                <div className="lead-block__add">
                  <button
                    type="button"
                    className="hm-btn hm-btn--secondary"
                    disabled={readOnly || !firstFree}
                    onClick={addBlock}
                  >
                    <Plus size={16} /> Weitere Kategorie bewerten
                  </button>
                </div>
                {!firstFree && data.categories.length > 0 && (
                  <div style={{ textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    Alle aktiven Kategorien sind in diesem Zeitraum bewertet.
                  </div>
                )}

                <div className="lead-save-bar">
                  <div className="lead-save-bar__status">
                    {lastSaved
                      ? `Zuletzt gespeichert: ${formatDateTime(lastSaved.updated_at)} von ${lastSaved.updated_by_name ?? '—'}`
                      : `Für ${data.period.label} ist noch nichts gespeichert.`}
                  </div>
                  <div className="row" style={{ gap: 14 }}>
                    {dirty && (
                      <span className="lead-dirty">
                        <CircleAlert size={14} aria-hidden="true" /> Ungespeicherte Änderungen
                      </span>
                    )}
                    <button
                      type="button"
                      className="hm-btn hm-btn--primary"
                      disabled={readOnly || !dirty || save.isPending}
                      onClick={onSave}
                    >
                      <Save size={16} /> {save.isPending ? 'Wird gespeichert …' : 'Bewertung speichern'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="Bisherige Bewertungen" flush>
          {data.all_ratings.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={40} />}
              title="Noch keine Bewertungen"
              hint={`Sobald Sie ${e.first_name} ${e.last_name} bewerten, erscheinen hier alle Zeiträume im Überblick.`}
            />
          ) : (
            <div className="hm-table-wrap" style={{ maxHeight: 420 }}>
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Zeitraum</th>
                    <th>Kategorie</th>
                    <th>Wert</th>
                    <th>Kommentar</th>
                    <th>Stand</th>
                  </tr>
                </thead>
                <tbody>
                  {data.all_ratings.map((r) => {
                    // Nur Zeiträume der eingestellten Kadenz sind anspringbar.
                    const switchable = r.period_kind === kind;
                    const shown = r.period_key === data.period.key;
                    return (
                      <tr
                        key={r.id}
                        className={switchable ? 'clickable' : undefined}
                        aria-current={shown ? 'true' : undefined}
                        onClick={switchable ? () => showPeriod(r.period_key) : undefined}
                      >
                        <td style={{ fontWeight: shown ? 650 : 500, whiteSpace: 'nowrap' }}>
                          <PeriodText periodKey={r.period_key} kind={kind} />
                        </td>
                        <td>{r.category_name}</td>
                        <td>
                          <ScoreBadge scale={r.scale} score={r.score} />
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{truncate(r.comment)}</td>
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                          {formatDateTime(r.updated_at)}
                          {r.version > 1 && (
                            <span style={{ marginLeft: 6, fontSize: 'var(--text-xs)' }}>v{r.version}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <TeamMemberMeetings employeeId={employeeId} firstName={e.first_name} focusId={protocolFocus} />

        <Card title="Rund um die Bewertung">
          <TeamNotice>
            Diese Bewertung ist die <strong>Vorgesetztenbewertung</strong>. Selbstbewertung und 360°-Feedback der Person
            entstehen unter Leistung → Beurteilungen auf denselben Kategorien; das Feedbackgespräch dazu wird unter Leistung →
            Gespräche geplant. Die Gesprächsprotokolle oben führt die HR.
            Beide Verweise setzen die Rechte des jeweiligen Bereichs voraus.
          </TeamNotice>
          <div className="row row--wrap" style={{ gap: 12, marginTop: 10, fontSize: 'var(--text-sm)' }}>
            <Link to={`/leistung/beurteilungen?tab=conduct&employee=${employeeId}`}>Beurteilungen der Person</Link>
            <Link to={`/leistung/feedback?employee=${employeeId}`}>Feedbackgespräche der Person</Link>
          </div>
        </Card>

        <Card title="Protokoll (unveränderlich)">
          <div className="stack" style={{ gap: 14 }}>
            <TeamNotice>
              Jede Speicherung erzeugt eine neue Version. Einträge werden nie gelöscht oder nachträglich verändert.
              Korrekturen erscheinen hier als weitere Version mit dem vorherigen Wert.
            </TeamNotice>
            {data.history.length === 0 ? (
              <EmptyState
                icon={<History size={40} />}
                title="Noch keine Einträge"
                hint="Mit der ersten gespeicherten Bewertung entsteht hier Version 1."
              />
            ) : (
              <ul className="lead-history">
                {data.history.map((h) => (
                  <HistoryItem key={h.id} entry={h} kind={kind} />
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingAction !== null || blocker.state === 'blocked'}
        title="Ungespeicherte Änderungen verwerfen?"
        message="Ihre Eingaben in der Bewertungsmaske sind noch nicht gespeichert und gehen verloren."
        confirmLabel="Verwerfen"
        onConfirm={() => {
          // Verwerfen heißt zurück auf den Serverstand, nicht nur das Flag
          // löschen, sonst blieben geänderte Werte mit totem Speichern-Knopf stehen.
          setBlocks(buildBlocks(data.ratings, data.categories));
          setDirty(false);
          if (blocker.state === 'blocked') blocker.proceed();
          else pendingAction?.();
        }}
        onClose={() => {
          if (blocker.state === 'blocked') blocker.reset();
          setPendingAction(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Protokollzeile
// ---------------------------------------------------------------------------

function HistoryItem({ entry, kind }: { entry: RatingHistoryEntry; kind: RatingPeriodKind }) {
  const changed = entry.change_kind === 'geaendert';
  const previousCommentDiffers =
    changed && entry.previous_comment !== null && entry.previous_comment !== entry.comment;
  return (
    <li className="lead-history__item">
      <div className="lead-history__when">
        {formatDateTime(entry.changed_at)}
        <span className="lead-history__who">{entry.changed_by_name ?? '—'}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="lead-history__line">
          <strong>{entry.category_name}</strong>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span>
            <PeriodText periodKey={entry.period_key} kind={kind} />
          </span>
          <Badge tone={changed ? 'blue' : 'green'}>{changed ? 'geändert' : 'erstellt'}</Badge>
          <ScoreBadge scale={entry.scale} score={entry.score} />
          {changed && entry.previous_score !== null && (
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              vorher: <ScoreBadge scale={entry.previous_scale ?? entry.scale} score={entry.previous_score} />
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 'var(--text-xs)' }}>
            Version {entry.version}
          </span>
        </div>
        <div className="lead-history__comment">{entry.comment}</div>
        {previousCommentDiffers && (
          <details className="lead-history__prev">
            <summary>Vorheriger Kommentar</summary>
            <div className="lead-history__comment">{entry.previous_comment}</div>
          </details>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Formularzustand
// ---------------------------------------------------------------------------

let uidSeq = 1;

function newBlock(categoryId: number, saved: Rating | null = null, score: number | null = null, comment = ''): RatingBlock {
  return { uid: uidSeq++, category_id: categoryId, score, comment, saved };
}

/**
 * Ausgangszustand aus der Serverantwort: je gespeicherter Bewertung ein Block
 * (Reihenfolge wie geliefert, Gesamtbewertung zuerst); ohne Bewertungen genau
 * ein leerer Block mit der Gesamtbewertung vorausgewählt.
 */
function buildBlocks(ratings: Rating[], categories: RatingCategory[]): RatingBlock[] {
  if (ratings.length > 0) {
    return ratings.map((r) => {
      const category = categories.find((c) => c.id === r.category_id);
      const scaleChanged = category !== undefined && category.effective_scale !== r.scale;
      return newBlock(r.category_id, r, scaleChanged ? null : r.score, r.comment);
    });
  }
  const overall = categories.find((c) => c.is_overall === 1) ?? categories[0];
  return overall ? [newBlock(overall.id)] : [];
}
