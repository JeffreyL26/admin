import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Check, RotateCcw, Plus, X, GripVertical } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { Card, PageHeader, Spinner, StatCard, EmptyState } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useDashboard, type DashboardData } from './api';
import {
  ALL_STATS, ALL_WIDGETS, DEFAULT_CONFIG, STAT_DEFS, WIDGET_DEFS,
  loadDashboardConfig, saveDashboardConfig,
  type DashboardConfig, type StatKey, type WidgetKey,
} from './dashboardConfig';
import {
  AbsenceChartWidget, DepartmentChartWidget, AbsentTodayWidget, InterviewsWidget,
  MeetingsWidget, AnnouncementsWidget, SurveysWidget, BirthdaysWidget,
} from './widgets';

/** Widgets, deren Inhalt bis an den Card-Rand läuft (Tabellen). */
const FLUSH_WIDGETS: WidgetKey[] = ['absent-today'];

function widgetBody(key: WidgetKey, data: DashboardData): React.ReactNode {
  switch (key) {
    case 'absence-chart': return <AbsenceChartWidget data={data} />;
    case 'department-chart': return <DepartmentChartWidget data={data} />;
    case 'absent-today': return <AbsentTodayWidget data={data} />;
    case 'interviews': return <InterviewsWidget data={data} />;
    case 'meetings': return <MeetingsWidget data={data} />;
    case 'announcements': return <AnnouncementsWidget data={data} />;
    case 'surveys': return <SurveysWidget data={data} />;
    case 'birthdays': return <BirthdaysWidget data={data} />;
    default: return null;
  }
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading } = useDashboard();

  const [config, setConfig] = useState<DashboardConfig>(loadDashboardConfig);
  const [edit, setEdit] = useState(false);
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
  const hiddenWidgets = ALL_WIDGETS.filter((w) => !config.widgets.includes(w));

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
        <button
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          title="Widget entfernen"
          onClick={() => removeWidget(key)}
        >
          <X size={14} />
        </button>
      </>
    ) : undefined;

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''} 👋`}
        subtitle={`${today} — Ihr persönlicher Überblick.`}
        actions={
          edit ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="hm-btn hm-btn--ghost" onClick={reset} title="Standard-Layout wiederherstellen">
                <RotateCcw size={15} /> Zurücksetzen
              </button>
              <button className="hm-btn hm-btn--primary" onClick={() => setEdit(false)}>
                <Check size={15} /> Fertig
              </button>
            </div>
          ) : (
            <button className="hm-btn hm-btn--secondary" onClick={() => setEdit(true)}>
              <SlidersHorizontal size={15} /> Anpassen
            </button>
          )
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
              <button key={key} className="hm-btn hm-btn--secondary hm-btn--sm" title={def.description} onClick={() => addWidget(key)}>
                <Plus size={13} /> <def.icon size={13} /> {def.title}
              </button>
            );
          })}
        </div>
      )}

      {config.widgets.length === 0 ? (
        <Card>
          <EmptyState
            title="Ihr Dashboard ist leer"
            hint="Fügen Sie über „Anpassen“ die Widgets hinzu, die für Sie zählen."
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
          {config.widgets.map((key) => {
            const def = WIDGET_DEFS[key];

            // KPI-Leiste: volle Breite, eigene Darstellung ohne Card-Rahmen.
            if (key === 'kpis') {
              const wrap = editWrapProps(key);
              return (
                <div key={key} {...wrap} style={{ gridColumn: '1 / -1', ...wrap.style }}>
                  {edit && (
                    <div className="row row--between" style={{ marginBottom: 8 }}>
                      <span className="row" style={{ gap: 6, fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                        <GripVertical size={15} style={{ color: 'var(--gray-400)' }} /> Kennzahlen — Kacheln wählen:
                      </span>
                      <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" title="Widget entfernen" onClick={() => removeWidget(key)}>
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {edit && (
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                      {ALL_STATS.map((sk) => {
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
                  {config.kpis.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                      Keine Kennzahlen ausgewählt.
                    </p>
                  ) : (
                    <div className="grid-stats">
                      {config.kpis.map((sk) => {
                        const sd = STAT_DEFS[sk];
                        return (
                          <StatCard
                            key={sk}
                            label={sd.label}
                            value={sd.value(stats)}
                            sub={sd.sub?.(stats)}
                            icon={<sd.icon size={15} />}
                            onClick={edit ? undefined : () => navigate(sd.path)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={key} {...editWrapProps(key)}>
                <Card
                  title={<span className="row"><def.icon size={16} /> {def.title}</span>}
                  actions={editActions(key)}
                  flush={FLUSH_WIDGETS.includes(key)}
                >
                  {widgetBody(key, data)}
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
