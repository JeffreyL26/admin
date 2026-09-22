import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Check, RotateCcw, Plus, X, GripVertical } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { RequestDialog } from '../absences/RequestDialog';
import { Card, PageHeader, Spinner, StatCard, EmptyState, Tabs } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { useDashboard, type DashboardData } from './api';
import {
  ALL_STATS, ALL_WIDGETS, DEFAULT_CONFIG, STAT_DEFS, WIDGET_DEFS,
  loadDashboardConfig, saveDashboardConfig, statAllowed, widgetAllowed,
  type DashboardConfig, type StatKey, type WidgetKey,
} from './dashboardConfig';
import {
  AbsenceChartWidget, DepartmentChartWidget, AbsentTodayWidget, InterviewsWidget,
  MeetingsWidget, AnnouncementsWidget, SurveysWidget, FollowUpsWidget, BirthdaysWidget, OnboardingWidget,
  LeadershipTeamWidget, LeadershipReportWidget, LicenseWidget,
} from './widgets';
import {
  DASHBOARD_STYLE_LABELS, loadDashboardStyle, saveDashboardStyle, type DashboardStyle,
} from './dashboardStyle';
import { PersonalNotices } from './personalWidgets';

const STYLE_TABS = (Object.keys(DASHBOARD_STYLE_LABELS) as DashboardStyle[]).map((key) => ({
  key,
  label: DASHBOARD_STYLE_LABELS[key],
}));

function widgetBody(key: WidgetKey, data: DashboardData): React.ReactNode {
  switch (key) {
    case 'absence-chart': return <AbsenceChartWidget data={data} />;
    case 'department-chart': return <DepartmentChartWidget data={data} />;
    case 'absent-today': return <AbsentTodayWidget data={data} />;
    case 'interviews': return <InterviewsWidget data={data} />;
    case 'meetings': return <MeetingsWidget data={data} />;
    case 'announcements': return <AnnouncementsWidget data={data} />;
    case 'surveys': return <SurveysWidget data={data} />;
    case 'follow-ups': return <FollowUpsWidget />;
    case 'birthdays': return <BirthdaysWidget data={data} />;
    case 'onboarding': return <OnboardingWidget />;
    case 'leadership-team': return <LeadershipTeamWidget />;
    case 'leadership-report': return <LeadershipReportWidget />;
    case 'license': return <LicenseWidget />;
    default: return null;
  }
}

export function DashboardPage() {
  const { user, features } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading } = useDashboard();

  const [config, setConfig] = useState<DashboardConfig>(loadDashboardConfig);
  const [style, setStyle] = useState<DashboardStyle>(loadDashboardStyle);
  const [edit, setEdit] = useState(false);
  const changeStyle = (next: DashboardStyle) => {
    setStyle(next);
    saveDashboardStyle(next);
  };
  const [quickAbsenceOpen, setQuickAbsenceOpen] = useState(false);
  const [dragKey, setDragKey] = useState<WidgetKey | null>(null);
  const [overKey, setOverKey] = useState<WidgetKey | null>(null);

  const update = (next: DashboardConfig) => {
    setConfig(next);
    saveDashboardConfig(next);
  };

  const removeWidget = (key: WidgetKey) =>
    update({ ...config, widgets: config.widgets.filter((w) => w !== key) });
  const addWidget = (key: WidgetKey) => update({ ...config, widgets: [...config.widgets, key] });
  const toggleKpi = (key: StatKey) => {
    const active = new Set(config.kpis);
    if (active.has(key)) active.delete(key);
    else active.add(key);
    update({ ...config, kpis: ALL_STATS.filter((k) => active.has(k)) });
  };
  const reset = () => {
    update(DEFAULT_CONFIG);
    toast.success('Dashboard zurückgesetzt');
  };

  /** Drag & Drop: gezogenes Widget vor dem Ziel einsortieren. */
  const dropOn = (target: WidgetKey) => {
    if (dragKey !== null && dragKey !== target) {
      const rest = config.widgets.filter((w) => w !== dragKey);
      const idx = rest.indexOf(target);
      rest.splice(idx, 0, dragKey);
      update({ ...config, widgets: rest });
    }
    setDragKey(null);
    setOverKey(null);
  };

  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : 'Guten Abend';
  const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  if (isLoading || !data) return <Spinner center />;
  const { stats } = data;

  /**
   * Rechtefilter: Das Backend liefert in `allowed_areas`, welche Bereiche
   * dieses Konto lesen darf, und lässt gesperrte Blöcke aus der Antwort weg.
   * Hier fallen die zugehörigen Widgets und Kacheln aus der Anzeige — ohne die
   * gespeicherte Auswahl zu verändern, damit sie nach einer Rechteerweiterung
   * unverändert zurückkommt. Das ist Kosmetik, keine Sicherheitsgrenze: die
   * Daten kommen bereits gefiltert an.
   */
  const allowedAreas = new Set(data.allowed_areas ?? []);
  const visibleWidgets = config.widgets.filter((w) => widgetAllowed(w, allowedAreas, features));
  const visibleKpis = config.kpis.filter((k) => statAllowed(k, allowedAreas, features));
  const selectableStats = ALL_STATS.filter((k) => statAllowed(k, allowedAreas, features));
  const hiddenWidgets = ALL_WIDGETS.filter(
    (w) => !config.widgets.includes(w) && widgetAllowed(w, allowedAreas, features),
  );

  /** Rahmen im Bearbeitungsmodus: Greifer, gestrichelte Kontur, Entfernen-Knopf. */
  const editWrapProps = (key: WidgetKey): React.HTMLAttributes<HTMLDivElement> =>
    edit
      ? {
          draggable: true,
          onDragStart: () => setDragKey(key),
          onDragOver: (e) => { e.preventDefault(); setOverKey(key); },
          onDragLeave: () => setOverKey((k) => (k === key ? null : k)),
          onDrop: () => dropOn(key),
          style: {
            cursor: 'grab',
            opacity: dragKey === key ? 0.45 : 1,
            outline: overKey === key && dragKey !== key ? '2px dashed var(--brand-primary)' : 'none',
            outlineOffset: 3,
            borderRadius: 12,
          },
        }
      : {};

  const editActions = (key: WidgetKey) =>
    edit ? (
      <>
        <GripVertical size={15} style={{ color: 'var(--gray-400)' }} />
        <Tooltip content={<span className="hm-tooltip__title">Widget entfernen</span>}>
          <button
            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
            aria-label="Widget entfernen"
            onClick={() => removeWidget(key)}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </>
    ) : key === 'absent-today' ? (
      // Schnelleintrag: Abwesenheit direkt vom Dashboard aus erfassen.
      <Tooltip content={<span className="hm-tooltip__title">Abwesenheit schnell erfassen</span>}>
        <button
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Abwesenheit schnell erfassen"
          onClick={() => setQuickAbsenceOpen(true)}
        >
          <Plus size={15} />
        </button>
      </Tooltip>
    ) : undefined;

  return (
    <div className={`hm-dash${style === 'farbenfroh' ? ' hm-dash--bunt' : ''}`}>
      <PageHeader
        title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''} 👋`}
        subtitle={`${today} — Ihr persönlicher Überblick.`}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Tabs
              size="sm"
              ariaLabel="Darstellung des Dashboards"
              tabs={STYLE_TABS}
              active={style}
              onChange={(key) => changeStyle(key as DashboardStyle)}
            />
            {edit ? (
              <>
                <Tooltip content={<span className="hm-tooltip__title">Standard-Layout wiederherstellen</span>}>
                  <button className="hm-btn hm-btn--ghost" onClick={reset}>
                    <RotateCcw size={15} /> Zurücksetzen
                  </button>
                </Tooltip>
                <button className="hm-btn hm-btn--primary" onClick={() => setEdit(false)}>
                  <Check size={15} /> Fertig
                </button>
              </>
            ) : (
              <button className="hm-btn hm-btn--secondary" onClick={() => setEdit(true)}>
                <SlidersHorizontal size={15} /> Anpassen
              </button>
            )}
          </div>
        }
      />

      {/* Galerie ausgeblendeter Widgets (nur im Bearbeitungsmodus). */}
      {edit && (
        <div
          style={{
            border: '1px dashed var(--border-strong)', borderRadius: 12, padding: '10px 14px',
            marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 600 }}>
            Widget hinzufügen:
          </span>
          {hiddenWidgets.length === 0 && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Alle Widgets sind bereits sichtbar.
            </span>
          )}
          {hiddenWidgets.map((key) => {
            const def = WIDGET_DEFS[key];
            return (
              <Tooltip key={key} content={<span className="hm-tooltip__title">{def.description}</span>}>
                <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => addWidget(key)}>
                  <Plus size={13} /> <def.icon size={13} /> {def.title}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* Persoenliche Hinweise (Ankuendigungen, Umfragen an dieses Konto):
          erscheinen nur mit Inhalt, unabhaengig von der Widget-Konfiguration. */}
      <PersonalNotices />

      {visibleWidgets.length === 0 ? (
        <Card>
          <EmptyState
            title="Ihr Dashboard ist leer"
            hint={
              config.widgets.length > 0
                ? 'Für die gewählten Widgets fehlt Ihnen die Berechtigung. Wählen Sie über „Anpassen“ andere aus.'
                : 'Fügen Sie über „Anpassen“ die Widgets hinzu, die für Sie zählen.'
            }
            action={
              !edit && (
                <button className="hm-btn hm-btn--primary" onClick={() => setEdit(true)}>
                  <SlidersHorizontal size={15} /> Anpassen
                </button>
              )
            }
          />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
          {visibleWidgets.map((key) => {
            const def = WIDGET_DEFS[key];

            // KPI-Leiste: volle Breite, eigene Darstellung ohne Card-Rahmen.
            if (key === 'kpis') {
              const wrap = editWrapProps(key);
              return (
                <div key={key} {...wrap} style={{ gridColumn: '1 / -1', ...wrap.style }}>
                  {edit && (
                    <div className="row row--between" style={{ marginBottom: 8 }}>
                      <span className="row" style={{ gap: 6, fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                        <GripVertical size={15} style={{ color: 'var(--gray-400)' }} /> Kennzahlen wählen:
                      </span>
                      <Tooltip content={<span className="hm-tooltip__title">Widget entfernen</span>}>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" aria-label="Widget entfernen" onClick={() => removeWidget(key)}>
                          <X size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                  {edit && (
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                      {selectableStats.map((sk) => {
                        const sd = STAT_DEFS[sk];
                        const active = config.kpis.includes(sk);
                        return (
                          <button
                            key={sk}
                            className={`hm-btn hm-btn--sm ${active ? 'hm-btn--primary' : 'hm-btn--secondary'}`}
                            onClick={() => toggleKpi(sk)}
                          >
                            <sd.icon size={13} /> {sd.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {visibleKpis.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                      {config.kpis.length > 0
                        ? 'Für die gewählten Kennzahlen fehlt Ihnen die Berechtigung.'
                        : 'Keine Kennzahlen ausgewählt.'}
                    </p>
                  ) : (
                    <div className="grid-stats">
                      {visibleKpis.map((sk) => {
                        const sd = STAT_DEFS[sk];
                        const value = sd.value(stats);
                        // Doppelter Boden: Liefert das Backend den Wert wider
                        // Erwarten nicht, bleibt die Kachel weg statt eine 0 zu
                        // zeigen, die es so nicht gibt.
                        if (value === undefined) return null;
                        return (
                          <StatCard
                            key={sk}
                            label={sd.label}
                            value={value}
                            sub={sd.sub?.(stats)}
                            subTone={sd.subTone?.(stats)}
                            icon={<sd.icon size={16} />}
                            accent={sd.accent}
                            onClick={edit ? undefined : () => navigate(sd.path)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            const wrap = editWrapProps(key);
            return (
              <div
                key={key}
                {...wrap}
                className="hm-widget"
                style={{ '--hm-accent': `var(${def.accent})`, ...wrap.style } as React.CSSProperties}
              >
                <Card
                  title={
                    <span className="row" style={{ gap: 10 }}>
                      <span className="hm-widget__icon"><def.icon size={15} /></span>
                      {def.title}
                    </span>
                  }
                  actions={editActions(key)}
                >
                  {widgetBody(key, data)}
                </Card>
              </div>
            );
          })}
        </div>
      )}

      <RequestDialog open={quickAbsenceOpen} onClose={() => setQuickAbsenceOpen(false)} />
    </div>
  );
}
