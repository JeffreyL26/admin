import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Check, RotateCcw } from 'lucide-react';
import { Card, Field, PageHeader } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useSetupContext } from '../setup/SetupProvider';
import { setupActions } from '../setup/store';
import { t } from '../setup/copy';
import { t as tourT, type CopyKey as TourCopyKey } from '../tours/copy';
import { TOURS, visibleStepCount } from '../tours/registry';
import { tourActions, useTourState } from '../tours/store';
import { useNavigate } from 'react-router-dom';
import { applyTheme, getTheme, THEMES, type ThemeName } from '../../design/theme';
import { NAV_SECTIONS } from '../../layout/nav';
import { SIDEBAR_DEFAULT_ORDER, resetSidebarOrder, saveSidebarOrder, useSidebarOrder } from '../../layout/sidebarConfig';

/**
 * Persoenliche Einstellungen des Kontos: Passwort, Darstellung, Seitenleiste.
 *
 * Bewusst getrennt von den Firmeneinstellungen (SettingsPage.tsx): Diese
 * Seite haengt an KEINEM Rechtebereich (Nav-Eintrag „Konto“ in layout/nav.ts
 * ohne `area`), denn das eigene Passwort muss auch eine Rolle mit
 * `einstellungen: kein` aendern koennen. Theme und Reihenfolge der
 * Seitenleiste sind Geraeteeinstellungen (localStorage), keine Firmendaten.
 */

/** Passwortregel des Backends (MIN_PASSWORD_CHARS in core/auth.ts). Als
 *  Konstante statt als Zahl im Hinweistext UND in der Absende-Bedingung, damit
 *  beide nicht auseinanderlaufen. Gleiches Muster wie im Portal
 *  (apps/web/src/pages/ProfilePage.tsx). */
const MIN_PASSWORD_CHARS = 12;

export function AccountPage() {
  return (
    <>
      <PageHeader title="Konto" subtitle="Passwort, Darstellung und Seitenleiste dieses Kontos." />
      <div className="stack" style={{ maxWidth: 760 }}>
        <PasswordCard />
        <AssistantCard />
        <ThemeCard />
        <SidebarCard />
      </div>
    </>
  );
}

/**
 * Einrichtungs-Assistent und Seiten-Einführungen in EINER Karte: erst der
 * Assistent (nur für Konten, denen er Schritte bietet), darunter die Rundgänge
 * mit Stand und "Erneut starten".
 */
function AssistantCard() {
  const { eligible, progress } = useSetupContext();
  const { can } = useAuth();
  const { tours } = useTourState();
  const navigate = useNavigate();
  const available = TOURS.filter((x) => visibleStepCount(x, can) > 0);
  if (!eligible && available.length === 0) return null;
  return (
    <Card title={t('settings.reopen.title')}>
      <div className="stack" style={{ gap: 18 }}>
        {eligible && (
          <div className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('settings.reopen.text')}</span>
            <button
              type="button"
              className="hm-btn hm-btn--secondary"
              onClick={() => setupActions.reopen(progress.next)}
            >
              {t('settings.reopen.button')}
            </button>
          </div>
        )}
        {available.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <div>
              <strong>{tourT('konto.title')}</strong>
              <p style={{ margin: '2px 0 0', color: 'var(--text-secondary)' }}>{tourT('konto.text')}</p>
            </div>
            {available.map((x) => {
              const state = tours[x.id]?.status ?? 'new';
              return (
                <div key={x.id} className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
                  <span>
                    {tourT(`${x.id}.title` as TourCopyKey)}{' '}
                    <span style={{ color: 'var(--text-muted)' }}>{tourT(`konto.state.${state}` as TourCopyKey)}</span>
                  </span>
                  <button
                    type="button"
                    className="hm-btn hm-btn--secondary"
                    onClick={() => {
                      tourActions.start(x.id);
                      navigate(x.path);
                    }}
                  >
                    {tourT('konto.restart')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

function PasswordCard() {
  const pw = usePasswordForm();
  return (
    <Card title="Passwort ändern">
      <div className="hm-form-grid">
        <Field label="Aktuelles Passwort" required>
          <input
            className="hm-input"
            type="password"
            autoComplete="current-password"
            value={pw.current}
            onChange={(e) => pw.setCurrent(e.target.value)}
          />
        </Field>
        <Field label="Neues Passwort" required hint={`Mindestens ${MIN_PASSWORD_CHARS} Zeichen`}>
          <input
            className="hm-input"
            type="password"
            autoComplete="new-password"
            value={pw.next}
            onChange={(e) => pw.setNext(e.target.value)}
          />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          className="hm-btn hm-btn--secondary"
          disabled={pw.busy || pw.next.length < MIN_PASSWORD_CHARS || !pw.current}
          onClick={pw.submit}
        >
          Passwort ändern
        </button>
      </div>
    </Card>
  );
}

/**
 * Reihenfolge der Seitenleiste, je Gerät (localStorage, siehe
 * layout/sidebarConfig.ts). Dashboard (oben) und System (unten) sind fest
 * und tauchen hier nicht auf.
 */
function SidebarCard() {
  const order = useSidebarOrder();
  const titles = new Map(NAV_SECTIONS.map((s) => [s.key, s.title ?? 'Dashboard']));
  const isDefault = order.join() === SIDEBAR_DEFAULT_ORDER.join();
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    saveSidebarOrder(next);
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
  };
  return (
    <Card
      title="Seitenleiste"
      actions={
        <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={resetSidebarOrder} disabled={isDefault}>
          <RotateCcw size={15} /> Standard
        </button>
      }
    >
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        Die Reihenfolge der Abschnitte gilt sofort und wird auf diesem Gerät gespeichert.
      </p>
      <div className="stack" style={{ gap: 6 }}>
        {order.map((key, i) => (
          <div key={key} style={rowStyle}>
            <span
              style={{
                width: 22,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
                fontFamily: 'var(--font-numeric)',
                color: 'var(--text-muted)',
              }}
            >
              {i + 1}.
            </span>
            <span style={{ flex: 1, fontWeight: 600 }}>{titles.get(key)}</span>
            <button
              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
              onClick={() => move(i, i - 1)}
              disabled={i === 0}
              aria-label={`${titles.get(key)} nach oben`}
            >
              <ArrowUp size={15} />
            </button>
            <button
              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
              onClick={() => move(i, i + 1)}
              disabled={i === order.length - 1}
              aria-label={`${titles.get(key)} nach unten`}
            >
              <ArrowDown size={15} />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ThemeCard() {
  const [active, setActive] = useState<ThemeName>(getTheme());
  return (
    <Card title="Darstellung">
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        Das Farbschema gilt sofort und wird auf diesem Gerät gespeichert.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        {THEMES.map((t) => {
          const selected = active === t.name;
          return (
            <button
              key={t.name}
              onClick={() => {
                applyTheme(t.name);
                setActive(t.name);
              }}
              style={{
                font: 'inherit',
                // Native <button>-Elemente ohne eigene Farbe rendern mit der
                // UA-Vorgabe (Schwarz), unabhängig vom Theme. Im Dunkel-Theme
                // ergibt das schwarze Schrift auf dunklem Kachelgrund, deshalb
                // hier explizit wie beim Fließtext der Karte.
                color: 'var(--text-primary)',
                textAlign: 'left',
                cursor: 'pointer',
                padding: 12,
                borderRadius: 12,
                background: 'var(--bg-surface)',
                border: selected
                  ? '2px solid var(--brand-primary)'
                  : '1px solid var(--border-strong)',
                boxShadow: selected ? 'var(--shadow-primary-sm)' : 'var(--shadow-sm)',
                transition: 'border-color .15s ease, box-shadow .15s ease',
              }}
            >
              <span className="row" style={{ gap: 5, marginBottom: 8 }}>
                {t.swatch.map((color, i) => (
                  <span
                    key={i}
                    style={{
                      width: i === 0 ? 34 : 18,
                      height: 18,
                      borderRadius: 6,
                      background: color,
                      border: '1px solid rgb(0 0 0 / 0.08)',
                    }}
                  />
                ))}
                <span style={{ flex: 1 }} />
                {selected && <Check size={16} color="var(--brand-primary)" />}
              </span>
              <div style={{ fontWeight: 620 }}>{t.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {t.description}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function usePasswordForm() {
  const toast = useToast();
  // Bewusst über den Auth-Kontext statt direkt über api.put: Der Wechsel
  // entwertet serverseitig alle älteren Tokens (users.sessions_valid_from).
  // Wer das mitgelieferte frische Token nicht übernimmt, wird beim nächsten
  // Request mit 401 abgemeldet.
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await changePassword(current, next);
      toast.success('Passwort geändert');
      setCurrent('');
      setNext('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fehler beim Ändern');
    } finally {
      setBusy(false);
    }
  }

  return { current, setCurrent, next, setNext, busy, submit };
}
