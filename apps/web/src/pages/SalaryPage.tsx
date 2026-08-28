import { Fragment, type ReactNode } from 'react';
import {
  BONUS_KIND_LABELS,
  BONUS_STATUS_LABELS,
  FREELANCER_INVOICE_STATUS_LABELS,
  FREELANCER_RATE_UNIT_LABELS,
  SALARY_COMPONENT_KINDS,
  SALARY_COMPONENT_LABELS,
  SALARY_DEDUCTION_KINDS,
  formatEuro,
  type BonusStatus,
  type FreelancerInvoiceStatus,
  type MeSalaryComponent,
  type SalaryComponentKind,
} from '@hrmonic/shared';
import { useMyBonuses, useMyFreelancer, useMySalary, useMySalaryHistory } from '../api/hooks';
import { Card, EmptyState, LoadError, Skeleton } from '../components/ui';
import { formatDate, todayIso } from '../lib/format';

/**
 * Eigene Vergütung. Ton der Seite: sachlich und zurückhaltend — Gehalt ist ein
 * sensibles Thema, die Zahlen sprechen für sich.
 *
 * Ein Grundsatz zieht sich durch die Datei: es wird nichts behauptet, was die
 * Daten nicht hergeben. Fehlen die Wochenstunden im Personalstamm, liefert das
 * Backend für Stundenlohn-Komponenten bewusst 0 statt einer Hochrechnung
 * (siehe backend/modules/me/salaryRoutes.ts). Diese 0 darf hier nie als Betrag
 * erscheinen — an ihre Stelle tritt die Erklärung, woran es liegt.
 */

/** Anzeigereihenfolge der Bestandteile: Grundgehalt zuerst, Abzüge zuletzt. */
const KIND_ORDER = new Map(SALARY_COMPONENT_KINDS.map((kind, index) => [kind, index]));

function byKind(a: MeSalaryComponent, b: MeSalaryComponent): number {
  return (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99);
}

function isDeduction(kind: SalaryComponentKind): boolean {
  return SALARY_DEDUCTION_KINDS.includes(kind);
}

/** Gültigkeit einer Komponente; ohne `valid_to` läuft sie weiter. */
function validityLabel(c: MeSalaryComponent): string {
  return c.valid_to
    ? `${formatDate(c.valid_from)} bis ${formatDate(c.valid_to)}`
    : `seit ${formatDate(c.valid_from)}`;
}

/**
 * Betragsdarstellung einer Komponente.
 *
 * Bei `stundenlohn` ist `amount_cents` der Satz je Stunde — der vereinbarte,
 * unstrittige Wert. `monthly_cents` wäre dort eine Hochrechnung und wird nur
 * separat und als solche gekennzeichnet gezeigt. Alle anderen Arten sind
 * bereits Monatsbeträge; `monthly_cents` trägt bei ihnen zusätzlich das
 * Vorzeichen (Abzüge negativ) und ist deshalb die richtige Quelle.
 */
function amountText(c: MeSalaryComponent): string {
  return c.kind === 'stundenlohn'
    ? `${formatEuro(c.amount_cents)} je Stunde`
    : formatEuro(c.monthly_cents);
}

/** 'YYYY-MM' → 'März 2026'. */
function formatMonth(yearMonth: string): string {
  const date = new Date(`${yearMonth}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return yearMonth;
  return date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

/** Dezimalzahlen (Wochen-/Rechnungsstunden) deutsch: 37.5 → "37,5". */
function formatNumber(value: number): string {
  return value.toLocaleString('de-DE');
}

const BONUS_STATUS_TONES: Record<BonusStatus, string> = {
  geplant: 'neutral',
  freigegeben: 'info',
  ausgezahlt: 'success',
};

const INVOICE_STATUS_TONES: Record<FreelancerInvoiceStatus, string> = {
  offen: 'neutral',
  geprueft: 'info',
  bezahlt: 'success',
};

const MUTED_SM = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' } as const;

/** Gruppenüberschrift innerhalb einer Tabelle (erbt die Kopfzeilenoptik). */
function GroupRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <th colSpan={span} scope="colgroup">
        {label}
      </th>
    </tr>
  );
}

/** Rahmen für eine Kartensektion mit Tabelle: Laden, Fehler, Leerzustand. */
function TableCard({
  title,
  isLoading,
  error,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card title={title} flush>
      {error ? (
        <div className="pt-card__body">
          <LoadError error={error} />
        </div>
      ) : isLoading ? (
        <div className="pt-card__body stack" style={{ gap: 14 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="row">
              <Skeleton width={`${46 - (i % 3) * 8}%`} />
              <Skeleton width={110} />
              <Skeleton width={80} style={{ marginLeft: 'auto' }} />
            </div>
          ))}
        </div>
      ) : isEmpty ? (
        empty
      ) : (
        <div className="pt-table-wrap">{children}</div>
      )}
    </Card>
  );
}

// ------------------------------------------------- Aktuelle Vergütung ---

function CurrentSalary() {
  const { data: salary, isLoading, error } = useMySalary();

  if (error) {
    return (
      <Card>
        <LoadError error={error} />
      </Card>
    );
  }
  if (isLoading || !salary) {
    return (
      <Card>
        <Skeleton width={120} height={12} />
        <div style={{ marginTop: 14 }}>
          <Skeleton width={220} height={40} />
        </div>
        <div style={{ marginTop: 16 }}>
          <Skeleton width="70%" height={16} />
        </div>
      </Card>
    );
  }

  const components = [...salary.components].sort(byKind);
  const hasHourly = components.some((c) => c.kind === 'stundenlohn');
  // Kernfall der Seite: Stundenlohn ohne hinterlegte Wochenstunden. Das
  // Monatsbrutto ist dann rechnerisch 0 — aber eben nicht "null Euro Gehalt".
  const hoursMissing = hasHourly && salary.weekly_hours === null;
  const earnings = components.filter((c) => !isDeduction(c.kind));
  const deductions = components.filter((c) => isDeduction(c.kind));
  const grouped = earnings.length > 0 && deductions.length > 0;

  const rows = (items: MeSalaryComponent[]) =>
    items.map((c) => (
      <tr key={c.id}>
        <td style={{ fontWeight: 600 }}>{SALARY_COMPONENT_LABELS[c.kind] ?? c.kind}</td>
        <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{validityLabel(c)}</td>
        <td className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
          {amountText(c)}
          {c.kind === 'stundenlohn' && !hoursMissing && (
            <span
              style={{
                display: 'block',
                fontWeight: 400,
                color: 'var(--text-muted)',
                fontSize: 'var(--text-xs)',
                marginTop: 3,
              }}
            >
              rechnerisch {formatEuro(c.monthly_cents)} im Monat
            </span>
          )}
        </td>
      </tr>
    ));

  return (
    <>
      <Card>
        <span className="pt-label">Monatsbrutto</span>
        {components.length === 0 ? (
          <p style={{ ...MUTED_SM, marginTop: 10 }}>
            Zurzeit sind für Sie keine Gehaltsbestandteile hinterlegt. Sobald die
            Personalabteilung sie erfasst hat, erscheinen sie hier.
          </p>
        ) : hoursMissing ? (
          <p className="pt-alert pt-alert--info" style={{ marginTop: 10 }}>
            Ihr Monatsbrutto können wir hier nicht ausweisen: Im Personalstamm sind keine
            Wochenstunden hinterlegt, und ohne sie ließe sich Ihr Stundenlohn nur schätzen. Ihr
            vereinbarter Stundensatz steht unverändert unten. Die Personalabteilung ergänzt die
            Wochenstunden; danach erscheint der Betrag an dieser Stelle.
          </p>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'baseline', gap: 12, marginTop: 6 }}>
              <span className="pt-big">{formatEuro(salary.monthly_gross_cents)}</span>
              <span style={{ color: 'var(--text-secondary)' }}>brutto im Monat</span>
            </div>
            <p style={{ ...MUTED_SM, marginTop: 10 }}>
              Stand {formatDate(todayIso())}. Summe der unten aufgeführten Bestandteile, vor
              Steuern und Sozialabgaben.
              {hasHourly && salary.weekly_hours !== null && (
                <> Der Stundenlohn ist dabei auf {formatNumber(salary.weekly_hours)} Wochenstunden
                hochgerechnet.</>
              )}
            </p>
          </>
        )}
      </Card>

      {components.length > 0 && (
        <Card title="Aktuelle Bestandteile" flush>
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Bestandteil</th>
                  <th>Gültigkeit</th>
                  <th className="num">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {grouped && <GroupRow label="Bezüge" span={3} />}
                {rows(earnings)}
                {grouped && <GroupRow label="Abzüge" span={3} />}
                {rows(deductions)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

// ------------------------------------------------------------ Historie ---

function SalaryHistory() {
  const { data: history, isLoading, error } = useMySalaryHistory();

  // Nach Bestandteil gruppiert, innerhalb der Gruppe absteigend: so liest sich
  // die Entwicklung je Art als Kette ("seit …", davor "… bis …").
  const groups = SALARY_COMPONENT_KINDS.map((kind) => ({
    kind,
    items: (history ?? [])
      .filter((c) => c.kind === kind)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from)),
  })).filter((g) => g.items.length > 0);

  return (
    <TableCard
      title="Verlauf"
      isLoading={isLoading}
      error={error}
      isEmpty={groups.length === 0}
      empty={
        <EmptyState
          title="Noch kein Verlauf"
          hint="Sobald sich ein Bestandteil ändert, bleibt der bisherige hier nachvollziehbar."
        />
      }
    >
      <table className="pt-table">
        <thead>
          <tr>
            <th>Zeitraum</th>
            <th className="num">Betrag</th>
          </tr>
        </thead>
        <tbody>
          {/* Gruppenkopf und Zeilen sind Geschwister im <tbody>; sie kommen
              deshalb als Fragment aus der Schleife. Der key gehört an das
              Fragment selbst — am GroupRow darin würde React ihn nicht als
              Schlüssel des Listenelements sehen und eine Warnung schreiben. */}
          {groups.map((group) => (
            <Fragment key={group.kind}>
              <GroupRow
                label={SALARY_COMPONENT_LABELS[group.kind] ?? group.kind}
                span={2}
              />
              {group.items.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{validityLabel(c)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {amountText(c)}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

// ---------------------------------------------------------------- Boni ---

function Bonuses() {
  const { data: bonuses, isLoading, error } = useMyBonuses();
  const list = bonuses ?? [];
  const hasProjected = list.some((b) => b.is_projected);

  return (
    <>
      <TableCard
        title="Boni und Sonderzahlungen"
        isLoading={isLoading}
        error={error}
        isEmpty={list.length === 0}
        empty={
          <EmptyState
            title="Keine Boni erfasst"
            hint="Geplante und ausgezahlte Sonderzahlungen erscheinen hier."
          />
        }
      >
        <table className="pt-table">
          <thead>
            <tr>
              <th>Titel</th>
              <th>Art</th>
              <th>Auszahlung</th>
              <th>Status</th>
              <th className="num">Betrag</th>
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.id}>
                <td style={{ fontWeight: 600 }}>{b.title}</td>
                <td style={{ color: 'var(--text-secondary)' }}>
                  {BONUS_KIND_LABELS[b.kind] ?? b.kind}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{formatMonth(b.payout_month)}</td>
                <td>
                  <span className={`pt-chip pt-chip--${BONUS_STATUS_TONES[b.status] ?? 'neutral'}`}>
                    {BONUS_STATUS_LABELS[b.status] ?? b.status}
                  </span>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {formatEuro(b.payout_cents)}
                  {b.is_projected && (
                    <span style={{ display: 'block', marginTop: 5 }}>
                      <span className="pt-chip pt-chip--warning">Voraussichtlich</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {hasProjected && (
        <p style={{ ...MUTED_SM, marginTop: -8 }}>
          Als „Voraussichtlich“ gekennzeichnete Beträge sind zielgekoppelt: Sie ergeben sich aus dem
          heutigen Stand der Zielerreichung und ändern sich mit ihm. Verbindlich ist erst der
          Betrag, der zur Auszahlung festgesetzt wird.
        </p>
      )}
    </>
  );
}

// -------------------------------------------------------- Freiberuflich ---

/**
 * Honorarsätze und eigene Rechnungen. Die Route antwortet für alle anderen
 * Beschäftigungsarten mit zwei leeren Listen — dann bleibt der Abschnitt
 * vollständig aus, statt leere Kästen zu zeigen. Aus demselben Grund wird
 * während des Ladens nichts gerendert: ein Skeleton, der gleich darauf
 * verschwindet, wäre für die große Mehrheit nur Unruhe.
 */
function Freelancer() {
  const { data, isLoading, error } = useMyFreelancer();

  if (error) {
    return (
      <Card title="Honorare">
        <LoadError error={error} />
      </Card>
    );
  }
  if (isLoading || !data) return null;
  if (data.rates.length === 0 && data.invoices.length === 0) return null;

  return (
    <>
      {data.rates.length > 0 && (
        <Card title="Honorarsätze" flush>
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Leistung</th>
                  <th>Gültig ab</th>
                  <th className="num">Satz</th>
                </tr>
              </thead>
              <tbody>
                {data.rates.map((rate) => (
                  <tr key={rate.id}>
                    <td style={{ fontWeight: 600 }}>{rate.description}</td>
                    <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {formatDate(rate.valid_from)}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {formatEuro(rate.rate_cents)}{' '}
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                        {FREELANCER_RATE_UNIT_LABELS[rate.unit] ?? rate.unit}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data.invoices.length > 0 && (
        <Card title="Ihre Rechnungen" flush>
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Rechnung</th>
                  <th>Datum</th>
                  <th>Leistungszeitraum</th>
                  <th className="num">Stunden</th>
                  <th>Status</th>
                  <th className="num">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {invoice.invoice_number}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(invoice.invoice_date)}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{invoice.period ?? '—'}</td>
                    <td className="num">
                      {invoice.hours === null ? '—' : formatNumber(invoice.hours)}
                    </td>
                    <td>
                      <span
                        className={`pt-chip pt-chip--${INVOICE_STATUS_TONES[invoice.status] ?? 'neutral'}`}
                      >
                        {FREELANCER_INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
                      </span>
                      {invoice.paid_date && (
                        <span
                          style={{
                            display: 'block',
                            color: 'var(--text-muted)',
                            fontSize: 'var(--text-xs)',
                            marginTop: 4,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          bezahlt am {formatDate(invoice.paid_date)}
                        </span>
                      )}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {formatEuro(invoice.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

export function SalaryPage() {
  return (
    <div>
      <header className="portal-page-header">
        <h1 className="portal-title">Gehalt</h1>
        <p className="portal-subtitle">
          Ihre aktuellen Gehaltsbestandteile, die Entwicklung und Ihre Boni.
        </p>
      </header>

      <div className="stack">
        <CurrentSalary />
        <SalaryHistory />
        <Bonuses />
        <Freelancer />

        <p
          style={{
            ...MUTED_SM,
            borderTop: '1px solid var(--border)',
            paddingTop: 16,
          }}
        >
          Fragen zu Ihrer Vergütung, zu einzelnen Bestandteilen oder zu einer Abrechnung beantwortet
          Ihre Personalabteilung. Änderungen an den hier gezeigten Daten nimmt ausschließlich sie
          vor.
        </p>
      </div>
    </div>
  );
}
