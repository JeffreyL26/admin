import React from 'react';
import { SURVEY_QUESTION_KIND_LABELS, type MeSurveyQuestion, type SurveyAnswer, type SurveyAnswerValue } from '@ohrganize/shared';

/**
 * Antwortformular einer Umfrage (eigene Teilnahme vom Dashboard aus).
 * Skala als Knopfreihe, Einfachauswahl als Optionsfelder, Mehrfachauswahl
 * als Kontrollkaestchen, Freitext als Textfeld. Unbeantwortete Fragen werden
 * nicht mitgeschickt (toAnswers), das Backend verlangt mindestens eine.
 *
 * Bewusst KEIN `Field` um eine Frage: Field rendert ein <label>, und ein
 * Label ohne `for` aktiviert beim Klick sein erstes beschriftbares Kind. Ein
 * Klick auf den Fragetext waehlte so den ersten Skalenwert bzw. die erste
 * Option. Stattdessen ein <fieldset> mit <legend>.
 */
export type AnswerDraft = Record<number, SurveyAnswerValue | undefined>;

export function toAnswers(draft: AnswerDraft): SurveyAnswer[] {
  return Object.entries(draft)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([question_id, value]) => ({ question_id: Number(question_id), value: value as SurveyAnswerValue }));
}

export function SurveyAnswerForm({
  questions,
  draft,
  onChange,
  disabled,
}: {
  questions: MeSurveyQuestion[];
  draft: AnswerDraft;
  onChange: (next: AnswerDraft) => void;
  disabled?: boolean;
}) {
  const set = (id: number, value: SurveyAnswerValue | undefined) => onChange({ ...draft, [id]: value });

  return (
    <div className="stack" style={{ gap: 16 }}>
      {questions.map((q, index) => (
        <fieldset key={q.id} className="hm-fieldset" disabled={disabled}>
          <legend className="hm-field__label">
            {index + 1}. {q.text}
          </legend>
          {q.kind === 'skala' ? (
            <div className="row row--wrap" style={{ gap: 6 }} role="radiogroup" aria-label={q.text}>
              {Array.from({ length: q.scale_max ?? 5 }, (_, i) => i + 1).map((n) => {
                const active = draft[q.id] === n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`hm-btn hm-btn--sm ${active ? 'hm-btn--primary' : 'hm-btn--secondary'}`}
                    style={{ minWidth: 40, justifyContent: 'center' }}
                    onClick={() => set(q.id, active ? undefined : n)}
                  >
                    {n}
                  </button>
                );
              })}
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 6 }}>
                1 = niedrig, {q.scale_max ?? 5} = hoch
              </span>
            </div>
          ) : q.kind === 'einfachauswahl' ? (
            <div className="stack" style={{ gap: 6 }}>
              {(q.options ?? []).map((o) => (
                <label key={o} className="hm-checkbox">
                  <input type="radio" name={`q-${q.id}`} checked={draft[q.id] === o} onChange={() => set(q.id, o)} />
                  {o}
                </label>
              ))}
            </div>
          ) : q.kind === 'mehrfachauswahl' ? (
            <div className="stack" style={{ gap: 6 }}>
              {(q.options ?? []).map((o) => {
                const prev = (draft[q.id] as string[] | undefined) ?? [];
                const selected = prev.includes(o);
                return (
                  <label key={o} className="hm-checkbox">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => set(q.id, e.target.checked ? [...prev, o] : prev.filter((x) => x !== o))}
                    />
                    {o}
                  </label>
                );
              })}
            </div>
          ) : (
            <textarea
              className="hm-textarea"
              rows={3}
              aria-label={q.text}
              value={(draft[q.id] as string | undefined) ?? ''}
              onChange={(e) => set(q.id, e.target.value)}
            />
          )}
          <span className="hm-field__hint">{SURVEY_QUESTION_KIND_LABELS[q.kind]}</span>
        </fieldset>
      ))}
    </div>
  );
}
