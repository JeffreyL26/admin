# Wettbewerbsanalyse & Ausbau: Recruiting-Modul

Vergleich von oHRganize mit den gängigen HR-Verwaltungs-/Personalportalen
(Personio, rexx systems, SAP SuccessFactors, HeavenHR, Sage HR, BambooHR).
Ziel: Schwächen erkennen und den größten Rückstand mit mehr Tiefe schließen.

## 1. Ausgangslage: Wo oHRganize bereits stark ist

| Bereich | oHRganize | Personio & Co. | Bewertung |
|---|---|---|---|
| Stammdaten / Personalakte | Vollständig (inkl. Vertragshistorie, versionierte Dokumente, Volltextsuche) | ✓ | **Gleichauf** |
| Abwesenheit & Urlaub | Anträge, Genehmigung, AU-Fristen, Betriebsruhe, Feiertage je Bundesland | ✓ | **Gleichauf** |
| Leistung & Entwicklung | Ziele/OKR, 360°-Beurteilungen, Skills-Gap, Trainings, Karrierepfade | teils Zusatzmodul | **Stärker** |
| Vergütung / Payroll-Vorbereitung | Gehaltshistorie, Änderungs-Workflow, Boni, Abrechnungsläufe, DATEV | ✓ | **Gleichauf** |
| Kommunikation & Engagement | Verzeichnis, Ankündigungen, anonyme Umfragen, Kanäle | teils Zusatzmodul | **Stärker** |

## 2. Erkannte Schwächen (Lücken gegenüber dem Marktstandard)

Ohne Zeiterfassung (bewusst ausgeklammert) bleiben vier Lücken:

1. **Recruiting / Bewerbermanagement (ATS) — vollständig gefehlt.**
   Das ist die *Kernsäule* von Personio und der auffälligste Rückstand: keine
   Stellenausschreibungen, keine Bewerberverwaltung, keine Auswahl-Pipeline,
   keine Interviews, keine Recruiting-Kennzahlen. Ohne Recruiting endet der
   Mitarbeiter-Lebenszyklus **vor** dem Eintritt — genau der Teil, mit dem
   Personio den Markt besetzt.
2. Onboarding-/Offboarding-Workflows (strukturierte Aufgabenlisten).
3. Spesen-/Auslagenerstattung für Angestellte.
4. Betriebsmittel-/Inventarverwaltung (Laptops, Diensthandys).

Priorisierung: **Recruiting** hat mit Abstand den größten Hebel — es ist die
größte funktionale Lücke, ein eigenständiges Kaufargument und schließt den
Lebenszyklus lückenlos an das bestehende Personal-Modul an (Einstellung →
Mitarbeitender). Deshalb wird dieser Bereich hier mit voller Tiefe umgesetzt.

## 3. Umgesetzt: Modul „Recruiting & Bewerbermanagement“ (Nummernkreis 6xx)

Ein vollständiges Applicant-Tracking-System, das den Bewerbungslebenszyklus
end-to-end abbildet und sich nahtlos in die bestehende Architektur einfügt
(eigene Migrationsdatei, eigenes Fastify-Plugin, eigene Feature-Routen,
gemeinsame Bausteine).

### Funktionsumfang

- **Stellenausschreibungen** mit Zustandsautomat
  (Entwurf → veröffentlicht → pausiert → besetzt → geschlossen), Beschäftigungsart,
  Abteilung/Team/Standort, Hiring Manager, Anzahl Plätze, Gehaltsband,
  Beschreibung/Anforderungen. Automatische Besetzung, sobald alle Plätze vergeben sind.
- **Bewerber:innen-Pool** mit Herkunftskanal, Kurzprofil, Profil-Link und
  **DSGVO-Einwilligungsfrist** (Aufbewahrung bis Datum).
- **Bewerbungen** verknüpfen Bewerber:in ↔ Stelle (eindeutig je Kombination),
  mit Gesamtbewertung (1–5 Sterne), Gehaltsvorstellung, Verfügbarkeit, Lebenslauf.
- **Konfigurierbare Auswahl-Pipeline** (Eingegangen → Sichtung → Telefoninterview
  → Interview → Angebot → Eingestellt/Abgelehnt) als **Kanban-Board mit
  Drag & Drop**.
- **Verlaufs-Timeline** je Bewerbung: Eingang, Stufenwechsel, Notizen,
  Bewertungen, Interviews, Absagen, Einstellung — lückenlos und auditiert.
- **Interviews & Scorecards**: Terminplanung mit Interviewer:innen,
  strukturierte Bewertung je Kriterium und Empfehlung (Einstellen/Ablehnen/Unentschieden).
- **Einstellung als Lebenszyklus-Brücke**: Ein Klick legt aus der Bewerbung einen
  Mitarbeitenden-Grunddatensatz im Personal-Modul an (`converted_employee_id`).
- **Recruiting-Analyse**: offene Stellen/Plätze, aktive Bewerbungen,
  Einstellungen im Jahr, anstehende Interviews, **Ø Time-to-Hire**,
  Bewerbungstrichter und Auswertung je Herkunftskanal.
- **Dashboard-Integration**: neue Kennzahl „Offene Stellen“ und Karte
  „Anstehende Interviews“.

### Architektur-Konformität

- **Backend** = einzige Sicherheitsgrenze: alle Routen laufen durch den globalen
  JWT-Hook; Feldvalidierung mit Zod; Fehler über `AppError`; Änderungen auditiert.
- **Datenmodell**: `job_postings`, `recruiting_stages`, `candidates`,
  `applications`, `application_events`, `interviews` (Migration `600_recruiting.ts`).
- **Kontrakt-Ausnahme** (dokumentiert in `docs/modul-kontrakte.md`): Die
  Einstellung ist der einzige zugelassene Schreibzugriff auf `employees`
  außerhalb des Personal-Moduls und legt bewusst nur ein Grundgerüst an; Steuer-,
  SV- und Bankdaten ergänzt die HR anschließend im Personal-Modul.
- **Frontend**: fünf Seiten unter `/recruiting/*`, ausschließlich mit den
  gemeinsamen `hm-*`-Bausteinen, Theme-Variablen und TanStack Query.
- **Tests**: `modules/recruiting/smoke.ts` deckt den vollen Ablauf ab
  (Stellen-Zustandsautomat, Duplikatschutz, Stufenwechsel, Interview-Feedback,
  Absage, Einstellung inkl. Mitarbeitenden-Anlage, Analyse).

## 4. Nicht umgesetzt (bewusst)

- **Zeiterfassung** — laut Aufgabenstellung nicht erforderlich.
- Onboarding-/Offboarding-Checklisten, Spesen, Betriebsmittel — nächste sinnvolle
  Ausbauschritte, aber gegenüber dem ATS nachrangig.
