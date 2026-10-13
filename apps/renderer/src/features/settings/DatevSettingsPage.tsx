import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import {
  ABSENCE_CATEGORY_LABELS,
  DATEV_ABZUG_UEBER_LOHNART,
  DATEV_FESTBEZUEGE_MODE_LABELS,
  DATEV_LOHNART_DEFAULTS,
  DATEV_LOHNART_KEYS,
  DATEV_LOHNART_LABELS,
  DATEV_PROGRAM_LABELS,
  DATEV_PROGRAMS,
  isValidAusfallschluessel,
  isValidBeraterNr,
  isValidMandantenNr,
  LODAS_POSITION_KIND,
  lohnartNumberKind,
  lohnartNumberProblem,
  LUG_COLUMNS,
  type AbsenceType,
  type DatevFestbezuegeMode,
  type DatevLohnartKey,
  type DatevProgram,
  type LodasPositionKind,
} from '@ohrganize/shared';
import { ApiRequestError, api } from '../../api/client';
import { Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';

/**
 * Einstellungen des DATEV-Lohnexports (Bereich `einstellungen`): Programm,
 * Berater- und Mandantennummer, Schluesselfeld, Festbezuege, Lohnarten und
 * Ausfallschluessel. Die Regeln (Form der Nummern, Einordnung der
 * Positionen) kommen aus packages/shared/src/datev.ts; das Backend prueft
 * dieselben beim Speichern und im Pruefbericht des Exports.
 */

interface DatevSettings {
  datevBeraterNr: string;
  datevMandantenNr: string;
  datevProgramm: DatevProgram;
  datevBetrieblichePnr: boolean;
  datevFestbezuege: DatevFestbezuegeMode;
  datevVertragsstunden: boolean;
  datevLohnarten: Record<string, string>;
  datevAusfallschluessel: Record<string, string>;
}

const POSITION_HINT: Record<LodasPositionKind, string> = {
  festbezug: 'Festbezug (monatlich)',
  stundenlohn: 'Stundensatz und Stunden',
  nettoabzug: 'Nettoabzug',
  einmalbezug: 'Einmalzahlung (Bruttobezug)',
};

const SCALAR_KEYS = [
  'datevBeraterNr',
  'datevMandantenNr',
  'datevProgramm',
  'datevBetrieblichePnr',
  'datevFestbezuege',
  'datevVertragsstunden',
] as const;

/**
 * Nur, was sich gegenueber dem Server geaendert hat: Ein zweiter
 * Arbeitsplatz, der inzwischen etwas anderes gespeichert hat, wird nicht mit
 * dem alten Stand dieser Seite ueberschrieben. Lohnarten, die noch nicht
 * gespeichert sind, gehen mit ihrem angezeigten Vorschlag mit: Erst
 * gespeichert gilt eine Nummer im Export.
 */
function changesOf(form: DatevSettings, server: DatevSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    const value = typeof form[key] === 'string' ? (form[key] as string).trim() : form[key];
    if (value !== server[key]) patch[key] = value;
  }
  const lohnarten: Record<string, string> = {};
  for (const key of DATEV_LOHNART_KEYS) {
    const value = (form.datevLohnarten[key] ?? DATEV_LOHNART_DEFAULTS[key]).trim();
    if (server.datevLohnarten[key] !== value) lohnarten[key] = value;
  }
  if (Object.keys(lohnarten).length) patch.datevLohnarten = lohnarten;
  const ausfall: Record<string, string> = {};
  for (const [id, value] of Object.entries(form.datevAusfallschluessel)) {
    if ((server.datevAusfallschluessel[id] ?? '') !== value.trim()) ausfall[id] = value.trim();
  }
  if (Object.keys(ausfall).length) patch.datevAusfallschluessel = ausfall;
  return patch;
}

export function DatevSettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: DatevSettings }>('/api/settings'),
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  });
  // Die Abwesenheitsarten gehoeren zum Bereich `abwesenheit`; fehlt er der
  // Rolle, bleibt die Zuordnung der Ausfallschluessel ausgeblendet. Auch
  // inaktive Arten: Ihre genehmigten Abwesenheiten gehen weiter in den
  // Export und brauchen einen Schluessel (die Liste kommt aktive zuerst).
  const types = useQuery({
    queryKey: ['absences', 'types'],
    queryFn: () => api.get<{ types: AbsenceType[] }>('/api/absences/types'),
    select: (d) => d.types,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  });
  const [form, setForm] = useState<DatevSettings | null>(null);
  const settings = form ?? data?.settings ?? null;

  const save = useMutation({
    mutationFn: (s: DatevSettings) => api.put('/api/settings/datev', data ? changesOf(s, data.settings) : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['compensation'] });
      setForm(null);
      toast.success('DATEV-Einstellungen gespeichert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (error instanceof ApiRequestError && error.status === 403) {
    return (
      <>
        <PageHeader title="DATEV-Lohnexport" />
        <Card>
          <EmptyState
            icon={<Lock size={40} />}
            title="Für die Firmeneinstellungen fehlt Ihnen die Berechtigung"
            hint="Ihre Admin-Rolle umfasst den Bereich Einstellungen nicht."
          />
        </Card>
      </>
    );
  }
  if (isLoading || !settings) return <Spinner center />;

  const set = (patch: Partial<DatevSettings>) => setForm({ ...settings, ...patch });
  const lodas = settings.datevProgramm === 'lodas';
  const lohnart = (key: DatevLohnartKey) => settings.datevLohnarten[key] ?? DATEV_LOHNART_DEFAULTS[key];
  // Dieselbe Regel wie Positionsplan und Pruefbericht (lohnartNumberKind in shared).
  const lohnartErrors = new Map(
    DATEV_LOHNART_KEYS.map((key) => [
      key,
      lohnartNumberProblem(lohnart(key), lohnartNumberKind(key, settings.datevProgramm, settings.datevFestbezuege)),
    ]),
  );
  const unsaved = DATEV_LOHNART_KEYS.filter((key) => data && data.settings.datevLohnarten[key] === undefined);
  const beraterError = settings.datevBeraterNr.trim() && !isValidBeraterNr(settings.datevBeraterNr.trim()) ? '4 bis 7 Ziffern' : undefined;
  const mandantError = settings.datevMandantenNr.trim() && !isValidMandantenNr(settings.datevMandantenNr.trim()) ? '1 bis 5 Ziffern' : undefined;
  const invalid =
    !!beraterError ||
    !!mandantError ||
    [...lohnartErrors.values()].some(Boolean) ||
    Object.values(settings.datevAusfallschluessel).some((v) => v.trim() !== '' && !isValidAusfallschluessel(v.trim()));

  return (
    <>
      <PageHeader
        title="DATEV-Lohnexport"
        subtitle="Lohnprogramm, Nummern und Zuordnungen für die Übergabe der Abrechnungsläufe an das Lohnbüro."
      />
      <div className="stack" style={{ maxWidth: 860 }}>
        <Card title="Lohnbüro">
          <div className="hm-form-grid">
            <Field label="Lohnprogramm" span2 hint="LODAS bekommt Bewegungs- und Stammdaten; Lohn und Gehalt nur Bewegungsdaten (elf Spalten, Satzbeschreibung siehe unten).">
              <Select
                className="hm-select"
                value={settings.datevProgramm}
                onChange={(e) => set({ datevProgramm: e.target.value as DatevProgram })}
              >
                {DATEV_PROGRAMS.map((p) => (
                  <option key={p} value={p}>
                    {DATEV_PROGRAM_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Beraternummer" required error={beraterError} hint="4 bis 7 Ziffern, von der Steuerkanzlei">
              <input
                className="hm-input"
                inputMode="numeric"
                value={settings.datevBeraterNr}
                onChange={(e) => set({ datevBeraterNr: e.target.value })}
              />
            </Field>
            <Field label="Mandantennummer" required error={mandantError} hint="1 bis 5 Ziffern, von der Steuerkanzlei">
              <input
                className="hm-input"
                inputMode="numeric"
                value={settings.datevMandantenNr}
                onChange={(e) => set({ datevMandantenNr: e.target.value })}
              />
            </Field>
            {lodas && (
              <div className="hm-field span-2">
                <span className="hm-field__label">Schlüsselfeld</span>
                <label className="hm-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.datevBetrieblichePnr}
                    onChange={(e) => set({ datevBetrieblichePnr: e.target.checked })}
                  />
                  Betriebliche Personalnummer verwenden (BetrieblichePNrVerwenden=Ja)
                </label>
                <span className="hm-field__hint">
                  Aus: Die Personalnummer muss die LODAS-Mitarbeiternummer sein (1 bis 5 Ziffern). An: Jede
                  Personalnummer bis 20 Zeichen (etwa P-0042) ist der Schlüssel; LODAS vergibt die
                  Mitarbeiternummer selbst. Die Einstellung muss zum Mandanten in LODAS passen.
                </span>
              </div>
            )}
          </div>
        </Card>

        <Card title="Positionen">
          <div className="hm-form-grid">
            <Field
              label="Wiederkehrende Bezüge"
              span2
              hint={
                lodas
                  ? 'Vorgabe: Gehalt, Zulagen, Sachbezüge, VWL, bAV und Abzüge gehen als Festbezüge mit den Stammdaten; die Bewegungsdaten enthalten dann nur Einmalzahlungen, Stunden und Fehltage. Die monatliche Buchung ist nur richtig, wenn das Lohnbüro keine Festbezüge pflegt (sonst doppelt).'
                  : 'Lohn und Gehalt bekommt keine Stammdaten aus oHRganize. Mit „Stammdaten“ pflegt das Lohnbüro die Festbezüge selbst; mit „Bewegungsdaten“ stehen sie jeden Monat als Wert in der Datei.'
              }
            >
              <Select
                className="hm-select"
                value={settings.datevFestbezuege}
                onChange={(e) => set({ datevFestbezuege: e.target.value as DatevFestbezuegeMode })}
              >
                {(Object.keys(DATEV_FESTBEZUEGE_MODE_LABELS) as DatevFestbezuegeMode[]).map((m) => (
                  <option key={m} value={m}>
                    {DATEV_FESTBEZUEGE_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="hm-field span-2">
              <span className="hm-field__label">Stundenlöhner</span>
              <label className="hm-checkbox">
                <input
                  type="checkbox"
                  checked={settings.datevVertragsstunden}
                  onChange={(e) => set({ datevVertragsstunden: e.target.checked })}
                />
                Vertragsstunden übergeben (Wochenstunden × 4,33 als Stunden des Monats)
              </label>
              <span className="hm-field__hint">
                oHRganize kennt keine Ist-Stunden. Ausgeschaltet enthalten die Bewegungsdaten keine Stunden,
                das Lohnbüro trägt sie aus der Zeiterfassung ein. Eingeschaltet stehen die Vertragsstunden in
                der Datei und als Hinweis dabei; ohne Wochenstunden im Profil gilt wie im Abrechnungslauf 40.
                Den Stundensatz bekommt LODAS mit den Stammdaten, Lohn und Gehalt als abweichenden Faktor.
              </span>
            </div>
          </div>
        </Card>

        <Card title="Lohnarten">
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
            Die Nummern legt das Lohnbüro im Lohnprogramm fest; die Vorgaben hier sind nur ein Vorschlag und
            gelten erst, wenn sie gespeichert sind. Eine fehlende Nummer sperrt die Datei, in der die Position
            steht.
            {lodas && settings.datevFestbezuege === 'stammdaten' && (
              <> Der sonstige Abzug trägt die Nettobe-/abzugsnummer des Mandanten (1 bis 2 Ziffern).</>
            )}
            {unsaved.length > 0 && <> {unsaved.length} Vorschläge sind noch nicht gespeichert.</>}
          </p>
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>In LODAS</th>
                  <th style={{ width: 160 }}>Nummer</th>
                </tr>
              </thead>
              <tbody>
                {DATEV_LOHNART_KEYS.map((key) => (
                  <tr key={key}>
                    <td style={{ fontWeight: 600 }}>
                      {DATEV_LOHNART_LABELS[key]}
                      {unsaved.includes(key) && (
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (Vorschlag, nicht gespeichert)</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {POSITION_HINT[LODAS_POSITION_KIND[key]]}
                      {DATEV_ABZUG_UEBER_LOHNART.includes(key) && ', Lohnart als Abzug vom Brutto anlegen'}
                    </td>
                    <td>
                      <input
                        className="hm-input"
                        inputMode="numeric"
                        value={lohnart(key)}
                        aria-label={`Lohnart ${DATEV_LOHNART_LABELS[key]}`}
                        onChange={(e) =>
                          set({ datevLohnarten: { ...settings.datevLohnarten, [key]: e.target.value } })
                        }
                      />
                      {lohnartErrors.get(key) && <span className="hm-field__error">{lohnartErrors.get(key)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Fehltage">
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
            Genehmigte Abwesenheiten des Monats gehen als Fehltage mit, wenn die Art einen Ausfallschlüssel
            trägt (LODAS: Kalendarium, Lohn und Gehalt: Kalendertag mit Tagesanzahl), gezählt wie im
            Urlaubskonto: ohne Wochenenden, Feiertage und Betriebsruhe. Decken zwei Abwesenheiten denselben
            Tag (Krankheit im Urlaub), geht er einmal mit, als Krankheit. Die Schlüssel stehen im
            Lohnprogramm unter Ausfallschlüssel, etwa U für Urlaub oder K für Krankheit. Ohne Schlüssel bleibt
            die Art aus der Datei; das steht dann als Warnung im Prüfbericht.
          </p>
          {types.error instanceof ApiRequestError && types.error.status === 403 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Die Abwesenheitsarten gehören zum Bereich Abwesenheit, den Ihre Rolle nicht lesen darf.
            </p>
          ) : types.isLoading ? (
            <Spinner center />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Abwesenheitsart</th>
                    <th>Kategorie</th>
                    <th style={{ width: 160 }}>Ausfallschlüssel</th>
                  </tr>
                </thead>
                <tbody>
                  {(types.data ?? []).map((t) => {
                    const v = settings.datevAusfallschluessel[String(t.id)] ?? '';
                    const bad = v.trim() !== '' && !isValidAusfallschluessel(v.trim());
                    return (
                      <tr key={t.id}>
                        <td style={{ fontWeight: 600 }}>
                          {t.name}
                          {t.active !== 1 && (
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (inaktiv)</span>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>{ABSENCE_CATEGORY_LABELS[t.category]}</td>
                        <td>
                          <input
                            className="hm-input"
                            value={v}
                            placeholder={t.paid ? '' : 'z. B. UU'}
                            aria-label={`Ausfallschlüssel ${t.name}`}
                            onChange={(e) =>
                              set({
                                datevAusfallschluessel: {
                                  ...settings.datevAusfallschluessel,
                                  [String(t.id)]: e.target.value.toUpperCase(),
                                },
                              })
                            }
                          />
                          {bad && <span className="hm-field__error">1 bis 4 Buchstaben oder Ziffern</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="hm-btn hm-btn--primary"
            disabled={save.isPending || (!form && unsaved.length === 0) || invalid}
            onClick={() => settings && save.mutate(settings)}
          >
            Speichern
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          Export und Prüfbericht: <Link to="/verguetung/abrechnung">Vergütung, Abrechnung</Link>. LODAS liest
          den Aufbau aus der Datei selbst. Für Lohn und Gehalt legt das Lohnbüro einmalig im
          ASCII-Import-Assistenten eine Satzbeschreibung an (Trennzeichen Strichpunkt, Zahlenkomma Komma, Datum
          TT.MM.JJJJ) mit diesen elf Spalten: {LUG_COLUMNS.join(', ')}.
        </p>
      </div>
    </>
  );
}
