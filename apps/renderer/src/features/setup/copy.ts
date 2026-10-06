/**
 * Alle Texte des Einrichtungs-Assistenten an EINER Stelle.
 *
 * Die Schluessel entsprechen 1:1 dem Textartefakt, in dem die Wortlaute
 * abgestimmt wurden (`step1.title` und so weiter). Wer einen Text aendert,
 * aendert ihn hier und nirgends sonst. Platzhalter in geschweiften Klammern
 * fuellt `t()` zur Laufzeit; sie duerfen verschoben, aber nicht umbenannt
 * werden. Keine en- oder em-Dashes in Texten (scripts/check-dashes.mjs).
 */

import { fillPlaceholders } from '../../lib/localStore';

export const COPY = {
  // ---- Launcher und Einstieg ------------------------------------------------
  'launcher.title.open': 'Einrichtung fortsetzen',
  'launcher.title.done': 'Einrichtung abgeschlossen',
  'launcher.sub.open': '{done} von {total} · weiter mit {next}',
  'launcher.sub.done': '{total} von {total} erledigt',
  'launcher.aria': 'Einrichtungs-Assistent öffnen',
  'command.reopen': 'Einrichtungs-Assistent öffnen',
  'settings.reopen.title': 'Einrichtungs-Assistent',
  'settings.reopen.text': 'Öffnet die geführte Einrichtung erneut.',
  'settings.reopen.button': 'Assistent öffnen',

  // ---- Willkommen -----------------------------------------------------------
  'welcome.eyebrow': 'Einrichtungs-Assistent',
  'welcome.title': 'Willkommen bei oHRganize!',
  'welcome.text':
    'In {total} kurzen Schritten ist Ihr HR-System startklar, in etwa {minutes} Minuten. Zeit für oHRganize.',
  'welcome.minutes': '{n} Min',
  'welcome.start': "Los geht's",
  'welcome.later': 'Später',

  // ---- Rahmen ---------------------------------------------------------------
  'frame.rail.title': 'Einrichtung',
  'frame.rail.remaining': 'Noch etwa {minutes} Min',
  'frame.rail.allDone': 'Alles erledigt',
  'frame.rail.doneBadge': 'erledigt',
  'frame.stepLine': 'Schritt {n} von {total} · etwa {minutes} Min',
  'frame.why.label': 'Der Baustein, den Sie legen',
  'frame.where.label': 'Später zu finden unter',
  'frame.skip': 'Überspringen',
  'frame.minimize.aria': 'Assistent minimieren',
  'frame.spotlight.badge': 'Später hier',

  // ---- Schritt 1: Firma und Standort ----------------------------------------
  'step1.label': 'Firma & Standort',
  'step1.title': 'Wo sitzt Ihr Unternehmen?',
  'step1.why':
    'Das {regionTerm} bestimmt die Feiertage im Kalender und setzt die erste Urlaubsberechnung. Weitere Standorte können Sie später hinzufügen.',
  'step1.field.company': 'Firmenname',
  'step1.field.city': 'Standort (Ort)',
  'step1.field.region': '{regionTerm}',
  'step1.cta': 'Standort speichern',
  'step1.where': 'Einstellungen',
  'step1.milestone': 'Standfest',
  'step1.win': 'Standort gesetzt.',
  'step1.result': 'Feiertage für {region} sind im Kalender hinterlegt.',
  'step1.unlock': 'Der Kalender hat sich nun auf Ihre lokalen Begebenheiten angepasst.',

  // ---- Schritt 2: Abteilungen -----------------------------------------------
  'step2.label': 'Abteilungen',
  'step2.title': 'Wie ist Ihr Unternehmen aufgebaut?',
  'step2.why':
    'Legen wir nun Abteilungen an, bevor Sie ihnen Personen zuordnen. Teams und Unterabteilungen können Sie auch später nach Belieben anlegen und konfigurieren.',
  'step2.chips.title': 'Ein paar Vorschläge. Weitere können Sie auch später unter Organisation anlegen.',
  'step2.suggestions':
    'Geschäftsführung, HR, Vertrieb, Entwicklung, Produktion, Verwaltung, Einkauf, Juristik',
  'step2.existing': 'Bereits vorhanden: {names}',
  'step2.custom.placeholder': 'Eigene Abteilung hinzufügen',
  'step2.custom.add': 'Hinzufügen',
  'step2.cta': 'Abteilungen anlegen',
  'step2.where': 'Personal → Organisation',
  'step2.milestone': 'Strukturiert',
  'step2.win': 'Unternehmensstruktur steht.',
  'step2.result.one': '1 Abteilung angelegt: {names}.',
  'step2.result.many': '{count} Abteilungen angelegt: {names}.',
  'step2.unlock': 'Personen lassen sich nun den Abteilungen zuordnen.',

  // ---- Schritt 3: Erste Mitarbeitende ---------------------------------------
  'step3.label': 'Erste Mitarbeitende',
  'step3.title': 'Wer gehört zum Team?',
  'step3.why':
    'Das Herz eines Unternehmens: Die Menschen dahinter. Legen Sie die ersten Personen an. Stammdaten können Sie später näher definieren.',
  'step3.intro': 'Legen Sie mindestens eine Person an. Für die nächsten Schritte sind zwei ideal.',
  'step3.add': 'Person anlegen',
  'step3.addAnother': 'Weitere Person anlegen',
  'step3.created.title': 'Bereits angelegt',
  'step3.created.empty': 'Noch niemand angelegt.',
  'step3.cta': 'Weiter',
  'step3.where': 'Personal → Mitarbeiter',
  'step3.milestone': 'Fast die Hälfte',
  'step3.win.one': 'Die erste Person ist da.',
  'step3.win.many': 'Das Team wächst.',
  'step3.result.one': '{names} ist angelegt.',
  'step3.result.many': '{names} sind angelegt.',
  'step3.unlock': 'Mitarbeiterliste und Kalender zeigen jetzt Personen. Das Herzstück steht.',

  // ---- Schritt 4: Vorgesetzte -----------------------------------------------
  'step4.label': 'Vorgesetzte',
  'step4.title': 'Wer berichtet an wen?',
  'step4.why': 'Vorgesetzte entscheiden später über Anträge und bilden das Organigramm.',
  'step4.field.manager': '{name} berichtet an',
  'step4.field.none': 'Keine Vorgesetzten',
  'step4.preview': 'Vorschau Organigramm',
  'step4.blocked': 'Für diesen Schritt brauchen Sie mindestens zwei Personen.',
  'step4.blocked.cta': 'Zurück zu Schritt 3',
  'step4.cta': 'Berichtslinie speichern',
  'step4.where': 'Personal → Organisation',
  'step4.milestone': 'Übersichtlich',
  'step4.win': 'Organigramm wächst.',
  'step4.result': '{name} berichtet an {boss}.',
  'step4.unlock': 'Genehmigungen laufen jetzt über die richtige Person!',

  // ---- Schritt 5: Abwesenheit -----------------------------------------------
  'step5.label': 'Abwesenheit',
  'step5.title': 'Welche Abwesenheiten gibt es?',
  'step5.why':
    'Erst wenn Abwesenheitsarten existieren, kann jemand Urlaub beantragen. oHRganize bringt gängige Arten bereits mit.',
  'step5.chips.title':
    'Diese Arten stehen jetzt zur Verfügung. Abgewählte lassen sich später wieder aktivieren.',
  'step5.more':
    'Weitere Abwesenheitsarten und Regeln legen Sie problemlos unter Abwesenheitsarten an.',
  'step5.cta': 'Abwesenheit bestätigen',
  'step5.where': 'Abwesenheit → Abwesenheitsarten',
  'step5.milestone': 'Klarheit',
  'step5.win': 'Abwesenheiten können nun beantragt werden.',
  'step5.result': '{count} Abwesenheitsarten sind aktiv.',
  'step5.unlock': 'Anträge und Abwesenheitskalender sitzen!',

  // ---- Schritt 6: Zweites Admin-Konto ---------------------------------------
  'step6.label': 'Zweites Admin-Konto',
  'step6.title': 'Wer entscheidet noch mit?',
  'step6.why':
    'Vier-Augen-Prinzip: Eigene Anträge entscheiden Sie nicht selbst. Ohne zweites Admin-Konto kann niemand sie genehmigen.',
  'step6.intro':
    'Legen Sie ein zweites Konto für die Administration an. oHRganize erzeugt das Passwort und zeigt es einmalig an. Geben Sie es persönlich weiter.',
  'step6.add': 'Admin-Konto anlegen',
  'step6.created': 'Angelegt: {email}',
  'step6.cta': 'Weiter',
  'step6.where': 'Verwaltung → Benutzer & Rechte',
  'step6.milestone': 'Transparent',
  'step6.win': 'Vier-Augen-Prinzip umgesetzt.',
  'step6.result': 'Zweites Admin-Konto für {email} angelegt.',
  'step6.result.many': '{count} Admin-Konten angelegt: {emails}.',
  'step6.unlock': 'Auch die Administration kann nun in den Urlaub!',

  // ---- Schritt 7: Portal-Zugang ---------------------------------------------
  'step7.label': 'Portal-Zugang',
  'step7.title': 'Geben Sie Personen Zugang zum Portal',
  'step7.why':
    'Mit einem Portal-Konto beantragt die Person Urlaub über das Portal selber. Der Zugang ist auf eigene Daten beschränkt.',
  'step7.person': 'Person',
  'step7.person.hasAccess':
    'Portal-Zugang wurde bei der Kontoerstellung automatisch diesem Konto zugewiesen. Zugangsdaten sind dieselben.',
  'step7.add': 'Portal-Zugang anlegen',
  'step7.created': 'Angelegt für {name}',
  'step7.empty': 'Alle angelegten Personen haben bereits einen Zugang.',
  'step7.cta': 'Einrichtung abschließen',
  'step7.where': 'Verwaltung → Benutzer & Rechte',
  'step7.milestone': 'Offen',
  'step7.win': 'Das Portal ist offen.',
  'step7.result': '{name} kann sich anmelden und Urlaub selbst beantragen.',
  'step7.result.many': '{names} können sich anmelden und Urlaub selbst beantragen.',
  'step7.unlock': 'Self-Service für Ihre Mitarbeitenden.',

  // ---- Erfolgsmoment (gemeinsame Teile) -------------------------------------
  'celebration.unlock': 'Freigeschaltet: {unlock}',
  'celebration.count': '{done} von {total} erledigt',
  'celebration.next': 'Weiter: {next}',
  'celebration.toEnd': 'Zum Abschluss',
  'celebration.pause': 'Pause',

  // ---- Abschluss ------------------------------------------------------------
  'done.title': 'oHRganisiert.',
  'done.line.all':
    'Alle {total} Schritte sind erledigt. Ihre Mitarbeitenden können beantragen, Sie können verwalten.',
  'done.line.some': '{done} von {total} Schritten erledigt. Den Rest holen Sie in Ruhe nach.',
  'done.summary.title': 'Ihr Ergebnis',
  'done.catchup': 'Nachholen',
  'done.next.title': 'Vorgeschlagene Einrichtungen:',
  'done.next.salaries.title': 'Gehälter',
  'done.next.salaries.text': 'Vergütung je Person festlegen.',
  'done.next.roles.title': 'Rollen',
  'done.next.roles.text': 'Festlegen, wer was konfigurieren und einsehen darf.',
  'done.next.jobs.title': 'Stellen',
  'done.next.jobs.text': 'Offene Positionen anlegen und Bewerbungen sammeln.',
  'done.next.news.title': 'Ankündigungen',
  'done.next.news.text': 'Die erste Nachricht absenden.',
  'done.dashboard': 'Zum Dashboard',
  'done.back': 'Zurück',
  'done.trial': 'Probe-Urlaubsantrag im Portal',

  // ---- Dashboard-Karte ------------------------------------------------------
  'card.title': 'Einrichtung',
  'card.next': 'Als Nächstes: {next}, etwa {minutes} Min',
  'card.cta': 'Fortsetzen',
  'card.dismiss': 'Ausblenden',
  'card.dismiss.aria': 'Einrichtungskarte ausblenden',

  // ---- Hinweise ausserhalb des Dialogs --------------------------------------
  'toast.stepDone': 'Schritt {n} erledigt: {label}',
  'trial.label': 'Zum Ausprobieren',
  'trial.title': 'Probe-Urlaubsantrag',
  'trial.text': 'Im Portal anmelden, beantragen und hier genehmigen.',
  'trial.badge': 'ca. 2 Min',

  // ---- Hinweiskaesten im Dialog Konto anlegen ---------------------------------
  'account.hint.name':
    'Der Name ist nur die Anzeige des Kontos, etwa in der Auflistung aller Konten und im Änderungsprotokoll. Der Login ist die E-Mail-Adresse.',
  'account.hint.profile.1':
    'Ein Admin-Konto kann auch ohne Personalprofil angelegt werden. Es existiert dann rein für administrative Zwecke. Soll eine Person gleichzeitig diese Rechte haben, ohne ständig zwischen den Konten wechseln zu müssen, ordnen Sie dem Admin-Konto ein Profil zu. Ein Anwendungsfall wären Personen in der Personalabteilung.',
  'account.hint.profile.2':
    'Mit zugewiesenem Personalprofil kann sich dasselbe Konto nämlich regulär im Portal anmelden, mit denselben Zugangsdaten. Es kann eigene Abwesenheiten und Änderungen beantragen. Dann gilt auch das Vier-Augen-Prinzip: Dieses Konto darf seine eigenen Anträge nicht genehmigen.',

  // ---- Fehler und Sonderfaelle ----------------------------------------------
  'error.save': 'Das hat nicht geklappt: {reason}. Bitte versuchen Sie es erneut.',
  'error.noRights':
    'Für diesen Schritt fehlt Ihrem Konto das Recht. Bitten Sie eine Person mit Vollzugriff, ihn zu übernehmen.',
  'error.skippedHidden': 'Schritte ohne passende Rechte werden nicht angezeigt.',
} as const;

export type CopyKey = keyof typeof COPY;

/** Text holen und Platzhalter fuellen. Unbekannte Platzhalter bleiben stehen. */
export function t(key: CopyKey, vars?: Record<string, string | number>): string {
  return fillPlaceholders(COPY[key], vars);
}
