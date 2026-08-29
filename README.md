<p align="center"><img src="logo.png" alt="HRMONIC" width="220"></p>

# HRMONIC

HR-Verwaltungssoftware für den deutschsprachigen Markt. Desktop-Anwendung
(Windows primär, macOS/Linux sekundär) für HR-Administrator:innen — mit
Personalverwaltung, Abwesenheitsmanagement, Leistungs- und Vergütungsverwaltung
sowie interner Kommunikation.

## Schnellstart (Entwicklung)

```bash
npm install
npm run dev            # Backend auf :3001, Renderer auf :5173
npm run dev:desktop    # zusätzlich das Electron-Fenster
```

Erst-Login: `admin@hrmonic.de`. Das Passwort wird beim allerersten Start
**zufällig erzeugt** und einmalig ausgegeben — auf der Konsole und in
`apps/backend/data/initial-admin-password.txt` (installierte App:
`%APPDATA%\HRMONIC\data\`). Der erste Login erzwingt einen Passwortwechsel;
danach die Datei löschen. Ein fest verdrahtetes Passwort gibt es bewusst nicht
mehr — es stand in dieser Datei, in CLAUDE.md und im ausgelieferten Bundle und
hätte auf einem über einen Reverse-Proxy erreichbaren Server für die
vollständige Übernahme aller Personaldaten genügt.

Für automatisierte Abläufe kann `HRMONIC_INITIAL_ADMIN_PASSWORD` das
Initialpasswort vorgeben (nur beim allerersten Start ausgewertet, dann ohne
Wechselzwang). **Nicht für Produktivsysteme** — dort ist das Zufallspasswort
der richtige Weg. Vollständige Erstinbetriebnahme: `docs/inbetriebnahme.md`.

Demo-Daten (Dev-Datenbank): `npm run seed`

## Demo-Daten in die installierte Desktop-App laden

Die **installierte** App hat eine eigene, getrennte Datenbank in
`%APPDATA%\HRMONIC\data` und startet nach der Installation bewusst leer (nur der
Admin-Login). Um sie mit den Beispieldaten zu füllen:

```bash
# 1. HRMONIC schließen (SQLite sperrt die Datei, solange die App läuft)
# 2. Demo-Daten in die installierte App laden:
npm run seed:desktop -- --force
```

Danach die App normal über die Startmenü-Verknüpfung starten. Der Befehl leert
vorhandene Daten (`--force`) und legt 28 Beispiel-Mitarbeitende samt Verträgen,
Abwesenheiten, Zielen, Gehältern und Kommunikation an.

## Windows-Installer bauen

```bash
npm run dist:win       # → apps/desktop/release/HRMONIC Setup <version>.exe
```

## Struktur

| Pfad | Inhalt |
|---|---|
| `apps/backend` | Fastify-REST-API + SQLite (client-agnostisch, auch standalone lauffähig) |
| `apps/renderer` | React-Oberfläche (Vite) |
| `apps/desktop` | Electron-Hülle, natives Menü, Installer-Konfiguration |
| `packages/shared` | Gemeinsame Typen/Konstanten |
| `docs/` | Architekturentscheidungen inkl. verworfener Ansätze |

Die API-Spezifikation liegt unter `apps/backend/openapi/` — Endpunkte des
späteren Mitarbeitenden-Web-Clients sind dort bereits benannt und mit
`x-status: planned` markiert.
