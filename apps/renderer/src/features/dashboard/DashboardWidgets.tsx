import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Maximize2, Minimize2, X } from 'lucide-react';
import {
  SICK_PAY_LIMIT_DAYS, dashboardNotice, filledSlots, formatDateInText, formatRangeInText, isOwnPersonDecision,
} from '@ohrganize/shared';
import { api, ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Tooltip } from '../../components/Tooltip';
import { initialsOf } from '../../components/ui';
import { useToast } from '../../components/Toast';
import {
  AbsenceChartWidget, BirthdaysWidget, DepartmentChartWidget, InterviewsWidget,
  LeadershipReportWidget, LeadershipTeamWidget, LicenseWidget, MeetingsWidget, SurveysWidget,
} from './widgets';
import type { DashboardData } from './api';
import { WIDGET_DEFS, widgetDef, type DashboardWidgetKey, type WidgetKey } from './dashboardConfig';
import type { HandleProps } from './SortableGrid';
import { NotificationBadge, type Notice } from './AreaBand';
import {
  AREA_COLORS, AREA_LABELS, calendarLink, personColor, requestLink, shortDate,
  type DashboardModel, type DashboardSource, type DashboardTask, type TaskAction, type TodayAbsence,
} from './dashboardModel';

/* ---------------------------------------------------------------------------
   Rahmen
   --------------------------------------------------------------------------- */

export interface FrameEdit {
  active: boolean;
  onRemove: () => void;
  wide: boolean;
  onToggleSize: () => void;
  /** Zeigergriff (Kopf) und Tastaturgriff des sortierbaren Rasters. */
  handle: HandleProps | null;
}

export function WidgetFrame({
  widgetKey, notice, showArea, edit, children,
}: {
  widgetKey: DashboardWidgetKey;
  notice: Notice | null;
  showArea?: boolean;
  edit: FrameEdit;
  children: React.ReactNode;
}) {
  const def = widgetDef(widgetKey);
  return (
    <section className="hm-db-w" style={{ '--hm-db-c': AREA_COLORS[def.area] } as React.CSSProperties}>
      <header
        className={`hm-db-w__head${edit.active ? ' hm-db-w__head--grab' : ''}`}
        onPointerDown={edit.active ? edit.handle?.onPointerDown : undefined}
      >
        {edit.active && (
          <Tooltip content={<><span className="hm-tooltip__title">Verschieben</span><span className="hm-tooltip__line">Ziehen · oder Pfeiltasten</span></>}>
            <button
              className="hm-db-w__grip"
              data-drag-handle
              aria-label={`${def.title} verschieben, Pfeiltasten bewegen um eine Stelle`}
              onKeyDown={edit.handle?.onKeyDown}
            >
              <GripVertical size={16} />
            </button>
          </Tooltip>
        )}
        <span className="hm-db-w__icon" aria-hidden="true"><def.icon size={16} /></span>
        <h2 className="hm-db-w__title">{def.title}</h2>
        {showArea && <span className="hm-db-w__tag">{AREA_LABELS[def.area]}</span>}
        <span className="hm-db-w__notice"><NotificationBadge notice={notice} /></span>
        {edit.active && (
          <span className="hm-db-w__edit">
            <Tooltip content={<span className="hm-tooltip__title">{edit.wide ? 'Halbe Breite' : 'Volle Breite'}</span>}>
              <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" aria-label={edit.wide ? 'Halbe Breite' : 'Volle Breite'} onClick={edit.onToggleSize}>
                {edit.wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </Tooltip>
            <Tooltip content={<span className="hm-tooltip__title">Widget entfernen</span>}>
              <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" aria-label="Widget entfernen" onClick={edit.onRemove}>
                <X size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      </header>
      <div className="hm-db-w__body">{children}</div>
    </section>
  );
}

/**
 * Quadrat rechts im Kopf, abgeleitet aus dem Modell. Rot mit Zahl: offene
 * Punkte fuer die HR. Grau mit Sanduhr: nichts offen, aber etwas laeuft und
 * wartet auf andere. Sonst nichts (der Inhalt sagt dann selbst, dass alles ruhig ist).
 */
export function widgetNotice(key: DashboardWidgetKey, model: DashboardModel): Notice | null {
  // Rot zaehlt nur, was das Konto erledigen kann (Recht, Vier-Augen-Prinzip).
  const n = (kind: DashboardTask['kind']) => model.tasks.filter((t) => t.kind === kind && t.actionable).length;
  const openRequest = new Set(model.tasks.filter((t) => t.kind === 'request' && t.actionable).map((t) => t.key));
  switch (key) {
    case 'absent-today': return dashboardNotice(model.pendingTodayDecidable.length, 0);
    case 'plan': return dashboardNotice(model.plan.rows.filter((r) => r.status === 'beantragt' && openRequest.has(`req-${r.id}`)).length, 0);
    case 'requests': return dashboardNotice(n('request'), 0);
    case 'sick': return dashboardNotice(n('sick'), 0);
    case 'salary': return dashboardNotice(n('salary'), 0);
    case 'profile': return dashboardNotice(n('profile'), 0);
    case 'documents': return dashboardNotice(n('document'), 0);
    case 'follow-ups': return dashboardNotice(n('followup'), 0);
    case 'onboarding': return dashboardNotice(0, model.tasks.filter((t) => t.kind === 'onboarding' && (t.progress?.total ?? 0) > (t.progress?.done ?? 0)).length);
    case 'announcements': return dashboardNotice(0, model.tasks.filter((t) => t.kind === 'announcement').length);
    default: return null;
  }
}

const approveKey = (id: number) => ['absences', 'approve', id] as const;

/**
 * Antrag direkt genehmigen; Rueckfrage zum Resturlaub und Fehler wie auf der
 * Antragsseite. Der Schluessel je Antrag laesst jeden Knopf desselben Antrags
 * (Antraege-Widget und Plan) sperren, solange die Genehmigung laeuft oder
 * sobald sie gelungen ist.
 */
function useApproveRequest(id: number) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  return useMutation({
    mutationKey: approveKey(id),
    mutationFn: () => api.post(`/api/absences/requests/${id}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Antrag genehmigt');
    },
    onError: (e: Error) => {
      // Uebersteigt der Antrag den Resturlaub, fragt die Antragsseite ausdruecklich nach.
      if (e instanceof ApiRequestError && e.code === 'BALANCE_EXCEEDED') {
        toast.error('Der Antrag übersteigt den Resturlaub. Bitte unter Anträge bestätigen.');
        navigate(requestLink(id));
        return;
      }
      toast.error(e.message);
    },
  });
}

const OWN_DECISION = 'Über eigene Anträge entscheidet eine andere Person';

/* ---------------------------------------------------------------------------
   Bausteine
   --------------------------------------------------------------------------- */

function Av({ task, size }: { task: DashboardTask; size?: 'sm' }) {
  return (
    <span className={`hm-db-av${size === 'sm' ? ' hm-db-av--sm' : ''}`} style={{ '--hm-db-c': personColor(task.employeeId) } as React.CSSProperties} aria-hidden="true">
      {initialsOf(task.person)}
    </span>
  );
}

/**
 * Gesperrter Knopf mit Begruendung: aria-disabled statt disabled, weil ein
 * deaktivierter Knopf weder Maus- noch Fokusereignisse bekommt und der
 * Tooltip sonst nie erschiene.
 */
function BlockedButton({ action, reason }: { action: TaskAction; reason: string }) {
  return (
    <Tooltip content={<span className="hm-tooltip__title">{reason}</span>}>
      <button className={`hm-db-btn${action.primary ? ' hm-db-btn--primary' : ''}`} aria-disabled="true" onClick={(e) => e.preventDefault()}>
        {action.label}
      </button>
    </Tooltip>
  );
}

function ApproveButton({ action, id }: { action: TaskAction; id: number }) {
  const approve = useApproveRequest(id);
  const running = useIsMutating({ mutationKey: approveKey(id) }) > 0;
  const done = useMutationState({ filters: { mutationKey: approveKey(id), status: 'success' } }).length > 0;
  return (
    <button
      className={`hm-db-btn${action.primary ? ' hm-db-btn--primary' : ''}`}
      disabled={running || done}
      onClick={() => approve.mutate()}
    >
      {action.label}
    </button>
  );
}

function ActionButton({ action, own }: { action: TaskAction; own: boolean }) {
  const navigate = useNavigate();
  if (own && action.decision === true) return <BlockedButton action={action} reason={OWN_DECISION} />;
  if (action.approveId !== undefined) return <ApproveButton action={action} id={action.approveId} />;
  return (
    <button className={`hm-db-btn${action.primary ? ' hm-db-btn--primary' : ''}`} onClick={() => navigate(action.to)}>
      {action.label}
    </button>
  );
}

/** Knoepfe einer Aufgabe; ohne Recht `bearbeiten` im Bereich der Aktion entfaellt sie. */
function TaskButtons({ actions, employeeId }: { actions: TaskAction[]; employeeId: number | null }) {
  const { user, can } = useAuth();
  // Vier-Augen-Regel aus shared/fourEyes.ts (dieselbe wie im Backend).
  const own = isOwnPersonDecision(user?.employee_id, employeeId);
  const usable = actions.filter((a) => !a.area || can(a.area, 'bearbeiten'));
  if (usable.length === 0) return null;
  return (
    <div className="hm-db-tl__acts">
      {usable.map((a) => <ActionButton key={a.label} action={a} own={own} />)}
    </div>
  );
}

function TaskLines({ tasks, empty }: { tasks: DashboardTask[]; empty: string }) {
  if (tasks.length === 0) return <p className="hm-db-empty">{empty}</p>;
  return (
    <div className="hm-db-tl-list">
      {tasks.map((t) => (
        <div key={t.key} className="hm-db-tl">
          <Av task={t} />
          <div className="hm-db-tl__main">
            <span className="hm-db-tl__title">{t.person}<small> · {t.title}</small></span>
            <span className="hm-db-tl__meta">{t.meta}</span>
          </div>
          <div className="hm-db-tl__age">
            <span className={`hm-db-tl__num hm-db-tl__num--${t.tone}`}>{t.age}</span>
            <span className="hm-db-tl__unit">{t.unit}</span>
          </div>
          <TaskButtons actions={t.actions} employeeId={t.employeeId} />
        </div>
      ))}
    </div>
  );
}

const fmtRange = (from: string, to: string, today: string) =>
  from === to ? shortDate(from, today) : `${shortDate(from, today)} bis ${shortDate(to, today)}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/* ---------------------------------------------------------------------------
   Neue und neu gezeichnete Widgets
   --------------------------------------------------------------------------- */

const PLAN_ROWS_COLLAPSED = 6;

function PlanBody({ model }: { model: DashboardModel }) {
  const [all, setAll] = useState(false);
  const { plan, today } = model;
  const rows = all ? plan.rows : plan.rows.slice(0, PLAN_ROWS_COLLAPSED);
  return (
    <div className="hm-db-plan">
      <div className="hm-db-legend">
        <span><i className="hm-db-hatch" />beantragt, offen</span>
        <span><i className="hm-db-bar-ok" />genehmigt</span>
        <span><i className="hm-db-bar-sick" />krank</span>
      </div>
      <div className="hm-db-plan__scroll">
        <div className="hm-db-plan__grid">
          <div className="hm-db-plan__row">
            <div />
            <div className="hm-db-plan__weeks">
              <div className="hm-db-plan__weeks-grid">
                {plan.weeks.map((w) => (
                  <div key={w.kw + w.date} className="hm-db-plan__week"><b>KW {w.kw}</b><span>{w.date}</span></div>
                ))}
              </div>
              <div className="hm-db-plan__today-badge" style={{ left: `${plan.todayLeft + plan.todayWidth / 2}%` }}>Heute</div>
            </div>
            <div />
          </div>
          {plan.rows.length === 0 && <p className="hm-db-empty" style={{ padding: '14px 0', borderTop: '1px solid var(--border)' }}>Im angezeigten Zeitraum ist niemand eingetragen.</p>}
          {rows.map((r) => {
            const task = model.tasks.find((t) => t.key === `req-${r.id}`);
            const right = r.left + r.width;
            const side = right > 68 ? { right: `calc(${100 - r.left}% + 8px)` } : { left: `calc(${right}% + 8px)` };
            const barClass = r.status === 'beantragt' ? 'hm-db-hatch' : r.category === 'krankheit' ? 'hm-db-bar-sick' : 'hm-db-bar-ok';
            const isToday = r.from <= today && r.to >= today;
            return (
              <div key={r.id} className="hm-db-plan__row hm-db-plan__row--body">
                <div className="hm-db-plan__who">
                  <span className="hm-db-av" style={{ '--hm-db-c': personColor(r.employeeId) } as React.CSSProperties} aria-hidden="true">{initialsOf(r.person)}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span className="hm-db-plan__name">{r.person}</span>
                    <span className="hm-db-plan__type">{r.typeName}{r.proxy ? ', vom HR erfasst' : ''}</span>
                  </span>
                </div>
                <div className="hm-db-plan__track">
                  <div className="hm-db-plan__todaycol" style={{ left: `${plan.todayLeft}%`, width: `${plan.todayWidth}%` }} />
                  <div className="hm-db-plan__todayline" style={{ left: `${plan.todayLeft + plan.todayWidth / 2}%` }} />
                  <div className={`hm-db-plan__bar ${barClass}`} style={{ left: `${r.left}%`, width: `${r.width}%` }} />
                  <div className="hm-db-plan__label" style={side}>{fmtRange(r.from, r.to, today)}, {r.days} {plural(r.days, 'Tag', 'Tage')}</div>
                  <div className="hm-db-plan__sub" style={side}>
                    {r.status === 'genehmigt' ? (isToday ? 'Genehmigt, heute abwesend' : 'Genehmigt') : task ? `${task.age} ${task.unit}` : 'Offen'}
                  </div>
                </div>
                <div className="hm-db-plan__acts">
                  {r.status === 'beantragt' ? (
                    <TaskButtons
                      employeeId={r.employeeId}
                      actions={task?.actions ?? [
                        { label: 'Genehmigen', primary: true, to: requestLink(r.id), approveId: r.id, area: 'abwesenheit', decision: true },
                        { label: 'Ablehnen', to: requestLink(r.id), area: 'abwesenheit', decision: true },
                      ]}
                    />
                  ) : (
                    <span className="hm-db-note">entschieden</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {plan.rows.length > PLAN_ROWS_COLLAPSED && (
        <div className="hm-db-plan__foot">
          <button className="hm-db-btn" onClick={() => setAll((v) => !v)}>
            {all ? 'Weniger anzeigen' : `Alle ${plan.rows.length} Einträge anzeigen`}
          </button>
        </div>
      )}
    </div>
  );
}

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const fmtDay = (iso: string, today: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${shortDate(iso, today)}`;
};

function AbsenceRow({ a, today }: { a: TodayAbsence; today: string }) {
  return (
    <div className={`hm-db-abs${a.pending ? ' hm-db-abs--pending' : ''}`}>
      <span className="hm-db-av" style={{ '--hm-db-c': personColor(a.employeeId) } as React.CSSProperties} aria-hidden="true">{initialsOf(a.name)}</span>
      <div className="hm-db-abs__main">
        <Link className="hm-db-abs__name" to={a.pending ? requestLink(a.requestId) : calendarLink(a.employeeId)}>{a.name}</Link>
        <span className="hm-db-abs__type">
          <i style={{ background: a.color }} aria-hidden="true" />
          {a.typeName}
          {a.halfToday && <em>heute halber Tag</em>}
          {a.pending && <em>laut offenem Antrag, nicht genehmigt</em>}
        </span>
      </div>
      <div className="hm-db-abs__when">
        <span>bis {fmtDay(a.to, today)}</span>
        <b>wieder da {a.backToday ? 'heute' : fmtDay(a.back, today)}</b>
      </div>
    </div>
  );
}

function AbsentTodayBody({ model }: { model: DashboardModel }) {
  const navigate = useNavigate();
  const all = [...model.todayAbsences, ...model.pendingToday];
  const decidable = model.pendingTodayDecidable;
  return (
    <div className="hm-db-abs-wrap">
      {all.length === 0 ? (
        <p className="hm-db-allhere">Heute sind alle da.</p>
      ) : (
        <div className="hm-db-tl-list">{all.map((a) => <AbsenceRow key={a.key} a={a} today={model.today} />)}</div>
      )}
      {/* Nur, was dieses Konto entscheiden darf (Recht, nicht der eigene Antrag). */}
      {decidable.length > 0 && (
        <div className="hm-db-hint">
          <span>{decidable.length === 1 ? 'Eine Abwesenheit läuft' : `${decidable.length} Abwesenheiten laufen`} ohne Entscheidung.</span>
          <button
            className="hm-db-btn hm-db-btn--primary"
            onClick={() => navigate(decidable.length === 1 ? requestLink(decidable[0].requestId) : '/abwesenheit/antraege')}
          >
            Jetzt entscheiden
          </button>
        </div>
      )}
      <div className="hm-db-soon">
        <span className="hm-db-soon__head">Nächste 7 Tage</span>
        {model.failed.has('soon') || model.offline.has('soon') ? (
          <span className="hm-db-note hm-db-bad">Ließ sich nicht laden.</span>
        ) : model.pendingSources.has('soon') ? (
          <span className="hm-db-note">Wird geladen …</span>
        ) : model.soonAbsences.length === 0 ? (
          <span className="hm-db-note">Es beginnt keine weitere Abwesenheit.</span>
        ) : (
          model.soonAbsences.map((s) => (
            <span key={s.key} className="hm-db-soon__row">
              <b>{fmtDay(s.from, model.today)}</b>
              <span>{s.name}</span>
              <span className="hm-db-abs__type"><i style={{ background: s.color }} aria-hidden="true" />{s.typeName}{s.pending ? ', beantragt' : ''}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function SickBody({ model }: { model: DashboardModel }) {
  const sick = model.tasks.filter((t) => t.kind === 'sick');
  return (
    <div className="hm-db-tl-list">
      <span className="hm-db-soon__head">Aktuell krankgemeldet</span>
      {model.currentSick.length === 0 && <p className="hm-db-empty">Aktuell ist niemand krankgemeldet.</p>}
      {model.currentSick.map((c) => {
        const left = SICK_PAY_LIMIT_DAYS - c.payUsed;
        return (
          <div key={c.key} className="hm-db-abs">
            <span className="hm-db-av" style={{ '--hm-db-c': personColor(c.employeeId) } as React.CSSProperties} aria-hidden="true">{initialsOf(c.name)}</span>
            <div className="hm-db-abs__main">
              <span className="hm-db-abs__name">{c.name}{c.childSick ? <small> · Kind krank</small> : null}</span>
              <span className="hm-db-note">
                {formatRangeInText(c.from, c.to, model.today)}{c.hasCertificate ? ', AU liegt vor' : ', AU noch nicht da'}
              </span>
              {/* Kind krank laeuft ueber Kinderkrankengeld, nicht ueber die Entgeltfortzahlung. */}
              {c.childSick ? (
                <span className="hm-db-note">Kinderkrankengeld, keine Entgeltfortzahlung</span>
              ) : (
                <span className="hm-db-meterrow">
                  <span className="hm-db-meter" style={{ flex: 1 }}>
                    <i style={{ width: `${Math.min(100, (c.payUsed / SICK_PAY_LIMIT_DAYS) * 100)}%`, background: c.exceeded ? 'var(--danger)' : left <= 7 ? 'var(--warning)' : 'var(--brand-primary)' }} />
                  </span>
                  <b style={{ color: c.exceeded ? 'var(--danger)' : 'var(--text-secondary)', minWidth: 150 }}>
                    {c.exceeded || left <= 0 ? 'Entgeltfortzahlung ausgeschöpft' : `Entgeltfortzahlung noch ${left} ${left === 1 ? 'Tag' : 'Tage'}`}
                  </b>
                </span>
              )}
            </div>
          </div>
        );
      })}
      <span className="hm-db-soon__head" style={{ marginTop: 10 }}>AU-Nachweise</span>
      {sick.length === 0 && <p className="hm-db-empty">Alle Nachweise liegen vor.</p>}
      {sick.map((t) => (
        <div key={t.key} className="hm-db-alert">
          <div className="hm-db-tl" style={{ padding: 0, border: 0 }}>
            <Av task={t} />
            <div className="hm-db-tl__main">
              <span className="hm-db-tl__title">{t.person}<small> · {t.title}</small></span>
              <span className="hm-db-tl__meta">{t.meta}</span>
            </div>
          </div>
          <div className="hm-db-meter"><i style={{ width: '100%' }} /></div>
          <div className="hm-db-tl" style={{ padding: 0, border: 0, justifyContent: 'space-between' }}>
            <b className="hm-db-bad">{t.age} {t.unit}</b>
            <TaskButtons actions={t.actions} employeeId={t.employeeId} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FollowUpsBody({ model }: { model: DashboardModel }) {
  const navigate = useNavigate();
  const items = model.tasks.filter((t) => t.kind === 'followup');
  if (items.length === 0) return <p className="hm-db-empty">Keine Wiedervorlage fällig.</p>;
  const max = Math.max(1, ...items.map((t) => Number(t.age) || 0));
  return (
    <div className="hm-db-tl-list">
      {items.map((t) => (
        <div key={t.key} className="hm-db-line">
          <div className="hm-db-line__main" style={{ gap: 6 }}>
            <span style={{ fontWeight: 700 }}>
              {t.person}<span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}> · {t.title.replace('Wiedervorlage ', '')}</span>
            </span>
            <span className="hm-db-meterrow">
              <span className="hm-db-meter" style={{ flex: 1 }}><i style={{ width: `${((Number(t.age) || 0) / max) * 100}%` }} /></span>
              <b>{t.age === 'heute' ? 'heute' : `${t.age} Tage`}</b>
            </span>
          </div>
          <button className="hm-db-btn" onClick={() => navigate(t.to)}>Erfassen</button>
        </div>
      ))}
    </div>
  );
}

const pct = (t: DashboardTask) =>
  t.progress && t.progress.total > 0 ? Math.round((t.progress.done / t.progress.total) * 100) : 0;

function OnboardingBody({ model }: { model: DashboardModel }) {
  const items = model.tasks.filter((t) => t.kind === 'onboarding');
  if (items.length === 0) return <p className="hm-db-empty">Niemand ist gerade im On- oder Offboarding.</p>;
  return (
    <div className="hm-db-tl-list">
      {items.map((t) => (
        <Link key={t.key} to={t.to} className="hm-db-card-soft hm-db-onb">
          <span className="hm-db-onb__top">
            <span className="hm-db-av" style={{ '--hm-db-c': personColor(t.employeeId) } as React.CSSProperties} aria-hidden="true">{initialsOf(t.person)}</span>
            <span className="hm-db-onb__who">
              <b>{t.person}</b>
              <span className="hm-db-note">{t.title}{t.meta ? ` · ${t.meta}` : ''}</span>
            </span>
            <span className="hm-db-onb__pct">{pct(t)} %</span>
          </span>
          <span className="hm-db-onb__bar"><i style={{ width: `${pct(t)}%` }} /></span>
          <span className="hm-db-note">{t.progress?.done ?? 0} von {t.progress?.total ?? 0} Aufgaben erledigt, {(t.progress?.total ?? 0) - (t.progress?.done ?? 0)} offen</span>
        </Link>
      ))}
    </div>
  );
}

function AnnouncementsBody({ model }: { model: DashboardModel }) {
  const items = model.announcements;
  if (items.length === 0) return <p className="hm-db-empty">Keine aktive Ankündigung.</p>;
  return (
    <div className="hm-db-tl-list">
      {items.map((a) => {
        const needs = a.ack >= 0;
        return (
          <Link key={a.id} to="/kommunikation/ankuendigungen" className="hm-db-card-soft">
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <b>{a.title}</b>
              <span className="hm-db-note">{a.audience}, seit {formatDateInText(a.publishAt, model.today)}</span>
            </span>
            {needs && a.total > 0 && (
              // Hoechstens 40 Kaestchen; gefuellt im Verhaeltnis, nicht je Person.
              <span className="hm-db-pips hm-db-pips--sq">
                {Array.from({ length: Math.min(a.total, 40) }, (_, i) => (
                  <i key={i} className={i < filledSlots(a.ack, a.total, Math.min(a.total, 40)) ? 'is-on' : ''} />
                ))}
              </span>
            )}
            <b className={needs && a.ack < a.total ? 'hm-db-warn' : 'hm-db-ok'} style={{ fontSize: 'var(--text-sm)' }}>
              {needs ? `${a.ack} von ${a.total} haben bestätigt` : 'Zur Kenntnis, keine Bestätigung nötig'}
            </b>
          </Link>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Auswahl des Inhalts je Schluessel
   --------------------------------------------------------------------------- */

/** Quellen je neu gezeichnetem Widget: Scheitert eine, steht das statt einer Leermeldung da. */
const WIDGET_SOURCES: Partial<Record<DashboardWidgetKey, DashboardSource[]>> = {
  // `soon` nur fuer den Abschnitt „Naechste 7 Tage“, der seinen Fehler selbst zeigt.
  'absent-today': ['today'],
  plan: ['window', 'pending'],
  requests: ['pending'],
  sick: ['missing', 'sickNotes'],
  salary: ['salary'],
  profile: ['changes'],
  documents: ['documents'],
  'follow-ups': ['followUps'],
  onboarding: ['onboarding'],
  announcements: ['announcements'],
};

export function WidgetBody({ widgetKey, model, data }: { widgetKey: DashboardWidgetKey; model: DashboardModel; data: DashboardData }) {
  const sources = WIDGET_SOURCES[widgetKey] ?? [];
  if (sources.some((src) => model.offline.has(src))) {
    return <p className="hm-db-empty hm-db-bad">Keine Verbindung zum Server. Das Dashboard lädt, sobald sie wieder besteht.</p>;
  }
  if (sources.some((src) => model.failed.has(src))) {
    return <p className="hm-db-empty hm-db-bad">Die Daten ließen sich nicht laden. Beim nächsten Fokus oder Menüwechsel lädt das Dashboard neu.</p>;
  }
  // Kommt eine Abfrage nach dem ersten Aufbau neu hinzu (neues Recht), laedt nur dieses Widget.
  if (sources.some((src) => model.pendingSources.has(src))) {
    return <p className="hm-db-empty">Wird geladen …</p>;
  }
  switch (widgetKey) {
    case 'absent-today': return <AbsentTodayBody model={model} />;
    case 'plan': return <PlanBody model={model} />;
    case 'requests': return <TaskLines tasks={model.tasks.filter((t) => t.kind === 'request')} empty="Keine offenen Anträge." />;
    case 'sick': return <SickBody model={model} />;
    case 'salary': return <TaskLines tasks={model.tasks.filter((t) => t.kind === 'salary')} empty="Keine offenen Gehaltsanträge." />;
    case 'profile': return <TaskLines tasks={model.tasks.filter((t) => t.kind === 'profile')} empty="Keine offenen Stammdaten-Anträge." />;
    case 'documents': return <TaskLines tasks={model.tasks.filter((t) => t.kind === 'document')} empty="Kein Dokument ist in seiner Erinnerungsfrist." />;
    case 'follow-ups': return <FollowUpsBody model={model} />;
    case 'onboarding': return <OnboardingBody model={model} />;
    case 'announcements': return <AnnouncementsBody model={model} />;
    default: break;
  }
  // Bestehende Widgets (widgets.tsx), unveraendert im neuen Rahmen.
  const accent = WIDGET_DEFS[widgetKey as WidgetKey].accent;
  let body: React.ReactNode = null;
  switch (widgetKey) {
    case 'absence-chart': body = <AbsenceChartWidget data={data} />; break;
    case 'department-chart': body = <DepartmentChartWidget data={data} />; break;
    case 'interviews': body = <InterviewsWidget data={data} />; break;
    case 'meetings': body = <MeetingsWidget data={data} />; break;
    case 'surveys': body = <SurveysWidget data={data} />; break;
    case 'birthdays': body = <BirthdaysWidget data={data} />; break;
    case 'leadership-team': body = <LeadershipTeamWidget />; break;
    case 'leadership-report': body = <LeadershipReportWidget />; break;
    case 'license': body = <LicenseWidget />; break;
    default: body = null;
  }
  return <div className="hm-widget" style={{ '--hm-accent': `var(${accent})` } as React.CSSProperties}>{body}</div>;
}
