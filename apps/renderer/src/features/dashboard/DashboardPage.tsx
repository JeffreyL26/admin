import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { dashboardNotice, uncoveredBreakdown } from '@ohrganize/shared';
import { useAuth } from '../../auth/AuthContext';
import { LOCALE } from '../../lib/locale';
import { PageHeader, Spinner } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { RequestDialog } from '../absences/RequestDialog';
import { SetupDashboardCard } from '../setup/SetupDashboardCard';
import { useDashboard } from './api';
import { AreaBand, NotificationBadge } from './AreaBand';
import { WIDGET_ORDER, useDashboardLayout, widgetAllowed, widgetDef, type DashboardWidgetKey } from './dashboardConfig';
import { AREA_COLORS, AREA_LABELS, AREA_PATHS, useDashboardModel, type AreaKey } from './dashboardModel';
import { WidgetBody, WidgetFrame, widgetNotice, widgetOpenKeys } from './DashboardWidgets';
import { PersonalNotices } from './personalWidgets';
import { SortableGrid } from './SortableGrid';

/** Ergaenzung einer Zelle, deren Zahlen eine Quelle fehlt (Fehler oder laedt noch). */
const INCOMPLETE = 'Daten unvollständig';

/**
 * Dashboard aus Sicht der HR: oben die Bereichsleiste (je Bereich die Zahl, die
 * man zuerst wissen will, dazu das Benachrichtigungs-Quadrat), darunter frei
 * waehl- und anordbare Widgets. Hintergrund: docs/entscheidungen.md,
 * Abschnitt „Dashboard aus Sicht der HR“.
 */
export function DashboardPage() {
  const layout = useDashboardLayout();
  // Den Plan (zehn Wochen der ganzen Firma) nur laden, wenn er zu sehen ist.
  const model = useDashboardModel({ needsPlan: layout.layout.widgets.includes('plan') });
  const dash = useDashboard();
  const { user, features, can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [chosenArea, setAreaFilter] = useState<'alle' | AreaKey>('alle');
  // Verschwindet der gewaehlte Bereich (Rechte oder Ausgabe geaendert), gilt wieder „Alle Bereiche“.
  const areaFilter = chosenArea === 'alle' || model.areas.some((a) => a.key === chosenArea) ? chosenArea : 'alle';
  // Offenes, das nur nicht gewaehlte Widgets zeigen, meldet der „Anpassen“-Knopf. Gezaehlt
  // wird nur, was „Anpassen“ im gewaehlten Bereich auch anbietet; abgeglichen gegen alle
  // gewaehlten Widgets (der Bereichsfilter blendet sie nur voruebergehend aus).
  const chosenWidgets = layout.layout.widgets;
  // Je angebotenem Widget dasselbe noch einmal, damit die Galerie zeigt, welches es bringt,
  // und mit welchen anderen es Punkte teilt (sonst ergaebe die Summe mehr als der Knopf).
  const { hiddenOpen, hiddenOpenOf } = useMemo(() => {
    const perWidget = new Map<DashboardWidgetKey, { count: number; alsoIn: string[] }>();
    if (model.loading) return { hiddenOpen: 0, hiddenOpenOf: perWidget };
    const ok = (k: DashboardWidgetKey) => widgetAllowed(k, model.allowed, features);
    const offered = WIDGET_ORDER.filter(
      (k) => !chosenWidgets.includes(k) && ok(k) && (areaFilter === 'alle' || widgetDef(k).area === areaFilter),
    );
    const visibleKeys = chosenWidgets.filter(ok).map((k) => widgetOpenKeys(k, model));
    const split = uncoveredBreakdown(visibleKeys, offered.map((k) => widgetOpenKeys(k, model)));
    offered.forEach((k, i) => perWidget.set(k, {
      count: split.each[i], alsoIn: split.sharedWith[i].map((j) => widgetDef(offered[j]).title),
    }));
    return { hiddenOpen: split.total, hiddenOpenOf: perWidget };
  }, [model, features, chosenWidgets, areaFilter]);
  // Ohne Grunddaten (Rechte der Bereiche) kein Dashboard; dann sagen, warum, statt endlos zu laden.
  if (!dash.data && !dash.isLoading) {
    const offline = dash.fetchStatus === 'paused';
    return (
      <div className="hm-db">
        <PageHeader title="Dashboard" />
        <div className="hm-db-emptybox">
          <p className="hm-db-empty hm-db-bad">
            {offline
              ? 'Keine Verbindung zum Server. Das Dashboard lädt, sobald sie wieder besteht.'
              : 'Das Dashboard ließ sich nicht laden.'}
          </p>
          {!offline && (
            <button className="hm-db-btn" onClick={() => void dash.refetch()}>Erneut versuchen</button>
          )}
        </div>
      </div>
    );
  }
  if (model.loading || !dash.data) return <Spinner center />;
  const data = dash.data;

  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : 'Guten Abend';
  const today = new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  // Geburtstag heute ersetzt den Standardtext (die Liste kommt nur mit Leserecht
  // Personal, ohne die Grenze der Vorschau und mit dem 29. Februar).
  const birthdayNames = (data.birthdays_today ?? []).map((b) => `${b.first_name} ${b.last_name}`);
  const birthdayText =
    birthdayNames.length === 0
      ? null
      : birthdayNames.length === 1
        ? `Heute hat ${birthdayNames[0]} Geburtstag!`
        : `Heute haben ${birthdayNames.slice(0, -1).join(', ')} und ${birthdayNames[birthdayNames.length - 1]} Geburtstag!`;

  const inArea = (k: DashboardWidgetKey) => areaFilter === 'alle' || widgetDef(k).area === areaFilter;
  const allowedKey = (k: DashboardWidgetKey) => widgetAllowed(k, model.allowed, features);
  const shown = layout.layout.widgets.filter((k) => allowedKey(k) && inArea(k));
  // Im Anpassen-Modus nur Widgets des gewaehlten Bereichs anbieten, bei „Alle Bereiche“ alle.
  const addable = WIDGET_ORDER.filter((k) => !layout.layout.widgets.includes(k) && allowedKey(k) && inArea(k));
  // Was auf eine Entscheidung oder Nacharbeit dieses Kontos wartet (Summe der Bereiche).
  const totalOpen = model.openTasks.length;
  const canRecord = can('abwesenheit', 'bearbeiten');

  return (
    <div className="hm-db">
      <PageHeader
        title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''} 👋`}
        subtitle={
          <>
            {today}: {birthdayText ? <strong className="hm-db-birthday">{birthdayText}</strong> : 'Ihr persönlicher Überblick.'}
          </>
        }
        actions={
          <div className="hm-db-actions">
            {canRecord && (
              <>
                <button className="hm-db-btn hm-db-btn--primary" onClick={() => navigate('/abwesenheit/krankmeldungen?neu=1')}>
                  Krankmeldung erfassen
                </button>
                <button className="hm-db-btn" onClick={() => setQuickOpen(true)}>Abwesenheit erfassen</button>
              </>
            )}
            {edit ? (
              <>
                <button className="hm-db-btn" onClick={() => { layout.reset(); toast.success('Dashboard zurückgesetzt'); }}>
                  <RotateCcw size={15} /> Zurücksetzen
                </button>
                <button className="hm-db-btn hm-db-btn--primary" onClick={() => setEdit(false)}>
                  <Check size={15} /> Fertig
                </button>
              </>
            ) : (
              <button className="hm-db-btn hm-db-btn--badged" onClick={() => setEdit(true)}>
                <SlidersHorizontal size={15} /> Anpassen
                {hiddenOpen > 0 && (
                  <NotificationBadge
                    notice={dashboardNotice(hiddenOpen, 0)}
                    className="hm-db-badge--button"
                    srText={`${hiddenOpen} offen in nicht gewählten Widgets`}
                  />
                )}
              </button>
            )}
          </div>
        }
      />

      <SetupDashboardCard />
      {/* Persoenliche Hinweise (Ankuendigungen, Umfragen an dieses Konto):
          erscheinen nur mit Inhalt, unabhaengig von der Widget-Auswahl. */}
      <PersonalNotices />

      {model.areas.length > 0 && (
        <AreaBand
          ariaLabel="Aufschlüsselung nach Bereichen"
          selected={areaFilter}
          onSelect={(key) => setAreaFilter(key === areaFilter && key !== 'alle' ? 'alle' : (key as 'alle' | AreaKey))}
          cells={[
            {
              key: 'alle', label: 'Alle Bereiche', value: totalOpen, valueLabel: 'Aufgaben für Sie',
              // Fehlt einem Bereich eine Quelle, ist auch die Summe unvollstaendig.
              extra: model.areas.some((a) => a.incomplete) ? INCOMPLETE : undefined,
              // Kein rotes Quadrat: Es zeigte genau die grosse Zahl. Nur die Sanduhr sagt hier
              // etwas Eigenes (keine Aufgabe offen, aber etwas wartet auf andere).
              notice: dashboardNotice(0, totalOpen > 0 ? 0 : model.areas.reduce((s, a) => s + a.running, 0)),
            },
            ...model.areas.map((a) => ({
              key: a.key, label: a.label, value: a.value, valueLabel: a.valueLabel,
              extra: a.incomplete ? INCOMPLETE : a.extra,
              notice: dashboardNotice(a.open, a.running), noticeDetail: a.openDetail, color: AREA_COLORS[a.key],
            })),
          ]}
        />
      )}

      {edit && (
        <div className="hm-db-gallery">
          <span className="hm-db-gallery__label">
            {areaFilter === 'alle' ? 'Widget hinzufügen:' : `Widget aus „${AREA_LABELS[areaFilter]}“ hinzufügen:`}
          </span>
          {addable.length === 0 && (
            <span className="hm-db-note">
              {areaFilter === 'alle' ? 'Alle Widgets sind bereits sichtbar.' : 'Alle Widgets dieses Bereichs sind bereits sichtbar.'}
            </span>
          )}
          {addable.map((k) => {
            const def = widgetDef(k);
            const open = hiddenOpenOf.get(k);
            return (
              <Tooltip
                key={k}
                content={
                  <>
                    <span className="hm-tooltip__title">{def.description}</span>
                    <span className="hm-tooltip__line">{AREA_LABELS[def.area]}</span>
                    {open && open.alsoIn.length > 0 && (
                      <span className="hm-tooltip__line">Offenes teils auch in · {open.alsoIn.join(' · ')}</span>
                    )}
                  </>
                }
              >
                <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => layout.add(k)}>
                  <Plus size={13} /> <def.icon size={13} /> {def.title}
                  {open && open.count > 0 && (
                    <NotificationBadge
                      notice={dashboardNotice(open.count, 0)}
                      className="hm-db-badge--inline"
                      srText={`${open.count} offen, sonst in keinem gewählten Widget${open.alsoIn.length > 0 ? `, teils auch in ${open.alsoIn.join(', ')}` : ''}`}
                    />
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="hm-db-emptybox">
          <p className="hm-db-empty">
            {areaFilter === 'alle'
              ? 'Ihr Dashboard ist leer. Über „Anpassen“ fügen Sie die Widgets hinzu, die für Sie zählen.'
              : 'Für diesen Bereich ist kein Widget gewählt. Über „Anpassen“ lassen sich welche hinzufügen.'}
          </p>
          {areaFilter !== 'alle' && (
            <button className="hm-db-btn" onClick={() => navigate(AREA_PATHS[areaFilter])}>
              {AREA_LABELS[areaFilter]} öffnen
            </button>
          )}
        </div>
      ) : (
        <SortableGrid
          className="hm-db-wgrid"
          items={shown}
          enabled={edit}
          wide={(k) => layout.sizeOf(k) === 'wide'}
          onCommit={layout.reorderVisible}
          renderItem={(k, handle) => (
            <WidgetFrame
              widgetKey={k}
              notice={widgetNotice(k, model)}
              showArea={areaFilter === 'alle'}
              edit={{
                active: edit,
                onRemove: () => layout.remove(k),
                wide: layout.sizeOf(k) === 'wide',
                onToggleSize: () => layout.toggleSize(k),
                handle,
              }}
            >
              <WidgetBody widgetKey={k} model={model} data={data} />
            </WidgetFrame>
          )}
        />
      )}
      {/* Nur mit Recht: der Dialog laedt beim Einhaengen die Abwesenheitsarten. */}
      {canRecord && <RequestDialog open={quickOpen} onClose={() => setQuickOpen(false)} />}
    </div>
  );
}
