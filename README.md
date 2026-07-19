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

Erst-Login: `admin@hrmonic.de` / `hrmonic2026` — Passwort unter
*Einstellungen → Passwort ändern* anpassen.

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
