import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock } from 'lucide-react';
import { SETUP_STEPS, nextOpenAfter, type SetupStepKey } from '@ohrganize/shared';
import { useAuth } from '../../auth/AuthContext';
import { NAV_SECTIONS, navItemAllowedByFeatures } from '../../layout/nav';
import { t } from './copy';
import { STEP_COMPONENTS } from './steps';
import { celebrationFor, stepText } from './stepMeta';
import { setupActions, useSetupState } from './store';
import { useSetupContext } from './SetupProvider';

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

/** Fortschrittsring (SVG), Spur und Fuellung ueber Tokens, damit alle Themes passen. */
export function ProgressRing({ done, total, size = 64 }: { done: number; total: number; size?: number }) {
  const frac = total > 0 ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="hm-setup__ring">
      <circle cx="32" cy="32" r={RING_R} className="hm-setup__ring-track" />
      <circle
        cx="32"
        cy="32"
        r={RING_R}
        className="hm-setup__ring-fill"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - frac)}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="37" textAnchor="middle" className="hm-setup__ring-text">
        {done}/{total}
      </text>
    </svg>
  );
}

/** Dialog, Launcher: haengt im <main> der Shell, damit die Seitenleiste bedienbar bleibt. */
export function SetupLayer() {
  const { eligible, status, progress } = useSetupContext();
  const s = useSetupState();
  const dialogOpen = eligible && !!status && progress.total > 0 && s.open;

  // Die Seite hinter dem Dialog bleibt fuer Tastatur und Screenreader aussen
  // vor, die Seitenleiste nicht: Sie zeigt, wo der Schritt zu finden ist.
  useEffect(() => {
    if (!dialogOpen) return;
    const page = document.querySelector('.hm-setup-host > .page');
    page?.setAttribute('inert', '');
    return () => page?.removeAttribute('inert');
  }, [dialogOpen]);

  if (!eligible || !status || !s.bound || progress.total === 0) return null;
  if (!s.open) {
    const show = s.welcomed && !(progress.complete && s.doneSeen);
    return show ? <SetupLauncher /> : null;
  }
  return <SetupDialog />;
}

function SetupLauncher() {
  const { progress } = useSetupContext();
  const s = useSetupState();
  const nextKey = progress.next;
  const done = progress.complete;
  const sub = done
    ? t('launcher.sub.done', { total: progress.total })
    : t('launcher.sub.open', {
        done: progress.doneCount,
        total: progress.total,
        next: nextKey ? stepText(nextKey, 'label') : '',
      });
  return (
    <button
      type="button"
      className="hm-setup-launcher"
      aria-label={t('launcher.aria')}
      onClick={() => (done ? setupActions.reopen(null) : setupActions.openAt(nextKey ?? s.current ?? progress.steps[0].def.key))}
    >
      <ProgressRing done={progress.doneCount} total={progress.total} size={46} />
      <span>
        <strong>{t(done ? 'launcher.title.done' : 'launcher.title.open')}</strong>
        <span>{sub}</span>
      </span>
    </button>
  );
}

function SetupDialog() {
  const { progress } = useSetupContext();
  const s = useSetupState();
  const ref = useRef<HTMLDivElement>(null);

  // Ansicht, die der Zustand verlangt; ein Schritt, den die Rolle nicht sieht,
  // faellt auf den naechsten offenen zurueck.
  const keys = progress.steps.map((x) => x.def.key);
  const current: SetupStepKey | null =
    s.current && keys.includes(s.current) ? s.current : (progress.next ?? keys[0] ?? null);
  const view = s.view === 'step' && !current ? 'done' : s.view;

  // Fokus beim Wechsel der Ansicht auf die Ueberschrift, damit Tastatur und
  // Screenreader dort weitermachen, wo der Inhalt wechselt.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-setup-focus]')?.focus({ preventScroll: true });
  }, [view, current]);

  return (
    <div
      className="hm-setup"
      // Nur Escape aus dem Panel selbst: Dialoge der Schritte haengen per Portal im
      // React-Baum darunter, ihr Escape schliesst nur sie (Modal) und nicht den Assistenten.
      onKeyDown={(e) => e.key === 'Escape' && ref.current?.contains(e.target as Node) && setupActions.minimize()}
    >
      <div className="hm-setup__dim" aria-hidden="true" />
      <div
        ref={ref}
        className={`hm-setup__panel${view === 'welcome' || view === 'done' ? ' hm-setup__panel--single' : ''}`}
        role="dialog"
        aria-labelledby="hm-setup-title"
      >
        {view === 'welcome' && <Welcome />}
        {view === 'done' && <Done />}
        {(view === 'step' || view === 'celebrate') && <Flow current={current} view={view} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Willkommen */

function Welcome() {
  const { progress } = useSetupContext();
  const first = progress.next ?? progress.steps[0].def.key;
  return (
    <div className="hm-setup__single">
      <div className="hm-setup__hero">
        <div className="hm-setup__eyebrow">{t('welcome.eyebrow')}</div>
        <h2 className="hm-setup__hero-title" id="hm-setup-title" tabIndex={-1} data-setup-focus>
          {t('welcome.title')}
        </h2>
        <p>{t('welcome.text', { total: progress.total, minutes: progress.remainingMinutes })}</p>
      </div>
      <ol className="hm-setup__preview">
        {progress.steps.map((st) => (
          <li key={st.def.key}>
            <span className="hm-setup__num">{st.n}</span>
            <span className="hm-setup__preview-label">{stepText(st.def.key, 'label')}</span>
            <span className="hm-setup__muted">{t('welcome.minutes', { n: st.def.minutes })}</span>
          </li>
        ))}
      </ol>
      <div className="hm-setup__actions">
        <button type="button" className="hm-btn hm-btn--ghost" onClick={setupActions.minimize}>
          {t('welcome.later')}
        </button>
        <button type="button" className="hm-btn hm-btn--primary" onClick={() => setupActions.openAt(first)}>
          {t('welcome.start')}
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Rail + Schritte */

function Flow({ current, view }: { current: SetupStepKey | null; view: 'step' | 'celebrate' }) {
  const { progress } = useSetupContext();
  if (!current) return null;
  const Step = STEP_COMPONENTS[current];
  return (
    <>
      <div className="hm-setup__rail">
        <div className="hm-setup__rail-head">
          <ProgressRing done={progress.doneCount} total={progress.total} />
          <div>
            <strong>{t('frame.rail.title')}</strong>
            <span>
              {progress.remainingMinutes > 0
                ? t('frame.rail.remaining', { minutes: progress.remainingMinutes })
                : t('frame.rail.allDone')}
            </span>
          </div>
        </div>
        {progress.steps.map((st) => {
          const isCur = st.def.key === current;
          return (
            <button
              key={st.def.key}
              type="button"
              className={`hm-setup__rail-item${isCur ? ' is-current' : ''}${st.done ? ' is-done' : ''}`}
              aria-current={isCur ? 'step' : undefined}
              onClick={() => setupActions.go(st.def.key)}
            >
              <span className="hm-setup__num">{st.done && !isCur ? <Check size={14} /> : st.n}</span>
              <span className="hm-setup__rail-label">{stepText(st.def.key, 'label')}</span>
              <span className="hm-setup__rail-meta">
                {st.done && !isCur ? t('frame.rail.doneBadge') : t('welcome.minutes', { n: st.def.minutes })}
              </span>
            </button>
          );
        })}
        {progress.steps.length < SETUP_STEPS.length && (
          <p className="hm-setup__rail-note">
            <Lock size={12} /> {t('error.skippedHidden')}
          </p>
        )}
      </div>
      <div className="hm-setup__content">
        {view === 'celebrate' ? <Celebration current={current} /> : <Step key={current} />}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- Erfolgsmoment */

function Celebration({ current }: { current: SetupStepKey }) {
  const { progress } = useSetupContext();
  const s = useSetupState();
  const vars = s.celebrate?.key === current ? s.celebrate.vars : {};
  const c = celebrationFor(current, vars);
  const next = nextOpenAfter(progress, current);
  const pct = progress.total ? Math.round((progress.doneCount / progress.total) * 100) : 0;

  return (
    <div className="hm-setup__cel">
      <div className="hm-setup__confetti" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <div className="hm-setup__check hm-setup-pop" aria-hidden="true">
        <Check size={44} strokeWidth={3} />
      </div>
      <div className="hm-setup__badge hm-setup-rise">{c.milestone}</div>
      <h2 className="hm-setup__cel-title hm-setup-rise" id="hm-setup-title" tabIndex={-1} data-setup-focus>
        {c.win}
      </h2>
      <p className="hm-setup__cel-text hm-setup-rise">{c.result}</p>
      <div className="hm-setup__unlock hm-setup-rise">
        <Lock size={16} />
        <span>{t('celebration.unlock', { unlock: c.unlock })}</span>
      </div>
      <div className="hm-setup__bar">
        <div className="hm-setup__bar-row">
          <span>{t('celebration.count', { done: progress.doneCount, total: progress.total })}</span>
          <span>{pct} %</span>
        </div>
        <div className="hm-setup__bar-track">
          <div className="hm-setup__bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="hm-setup__actions hm-setup__actions--center">
        <button type="button" className="hm-btn hm-btn--ghost" onClick={setupActions.minimize}>
          {t('celebration.pause')}
        </button>
        <button type="button" className="hm-btn hm-btn--primary" onClick={() => setupActions.afterCelebrate(next)}>
          {next ? t('celebration.next', { next: stepText(next, 'label') }) : t('celebration.toEnd')}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- Abschluss */

const NEXT_CARDS = [
  { id: 'salaries', path: '/verguetung/gehaelter' },
  { id: 'goals', path: '/leistung/ziele' },
  { id: 'jobs', path: '/recruiting/stellen' },
  { id: 'news', path: '/kommunikation/ankuendigungen' },
] as const;

const NAV_ITEMS = NAV_SECTIONS.flatMap((sec) => sec.items.map((i) => ({ ...i, area: i.area ?? sec.area })));

function Done() {
  const { progress } = useSetupContext();
  const { reopened } = useSetupState();
  const { can, features } = useAuth();
  // Vorschlaege nur dort, wo die Seite fuer dieses Konto auch aufgeht.
  const cards = NEXT_CARDS.filter((c) => {
    const item = NAV_ITEMS.find((n) => n.path === c.path);
    return item && navItemAllowedByFeatures(item, features) && (!item.area || can(item.area));
  });
  const all = progress.complete;

  return (
    <div className="hm-setup__single">
      <div className="hm-setup__hero hm-setup__hero--done">
        <div className="hm-setup__check hm-setup__check--sm hm-setup-pop" aria-hidden="true">
          <Check size={30} strokeWidth={3} />
        </div>
        <div>
          <h2 className="hm-setup__hero-title" id="hm-setup-title" tabIndex={-1} data-setup-focus>
            {t('done.title')}
          </h2>
          <p>
            {all
              ? t('done.line.all', { total: progress.total })
              : t('done.line.some', { done: progress.doneCount, total: progress.total })}
          </p>
        </div>
      </div>
      <div className="hm-setup__cols">
        <div>
          <p className="hm-setup__label">{t('done.summary.title')}</p>
          <ul className="hm-setup__sum">
            {progress.steps.map((st) => (
              <li key={st.def.key} className={st.done ? 'is-done' : ''}>
                <span className="hm-setup__num">{st.done ? <Check size={13} /> : ''}</span>
                <span className="hm-setup__sum-label">{stepText(st.def.key, 'label')}</span>
                {!st.done && (
                  <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => setupActions.go(st.def.key)}>
                    {t('done.catchup')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="hm-setup__label">{t('done.next.title')}</p>
          <div className="hm-setup__cards">
            {cards.map((c) => (
              <Link key={c.id} to={c.path} className="hm-setup__card" onClick={setupActions.closeDone}>
                <strong>{t(`done.next.${c.id}.title` as 'done.next.jobs.title')}</strong>
                <span>{t(`done.next.${c.id}.text` as 'done.next.jobs.text')}</span>
              </Link>
            ))}
          </div>
          {all && (
            <div className="hm-setup__trial">
              <span className="hm-setup__trial-label">{t('trial.label')}</span>
              <div>
                <strong>{t('trial.title')}</strong>
                <span>{t('trial.text')}</span>
              </div>
              <span className="hm-setup__badge">{t('trial.badge')}</span>
            </div>
          )}
        </div>
      </div>
      <div className="hm-setup__actions">
        <button type="button" className="hm-btn hm-btn--primary" onClick={setupActions.closeDone}>
          {reopened ? t('done.back') : t('done.dashboard')}
        </button>
      </div>
    </div>
  );
}
