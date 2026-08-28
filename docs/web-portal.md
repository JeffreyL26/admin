# Mitarbeitenden-Web-Portal (apps/web)

Das Portal ist der zweite Client auf dem client-agnostischen Backend: Mitarbeitende
melden sich im Browser an, beantragen Abwesenheiten, melden sich krank und sehen
ihre Stammdaten und ihren Urlaubssaldo. Die HR-Administration arbeitet weiterhin
ausschließlich in der Desktop-App und entscheidet dort über die Anträge.

## Rollen- und Kontenmodell

- `users` hat seit Migration `001_users_employee_link` eine Spalte
  `employee_id` (nullable, `UNIQUE` über Partial-Index, `ON DELETE SET NULL`):
  Ein Konto kann auf genau ein Personalprofil zeigen.
- Rollen: `admin` (HR-Administration) und `mitarbeiter` (Portal). Die Rolle
  steckt im JWT-Payload (`{ id, email, name, role, employee_id }`).
- **Durchsetzung ausschließlich im Backend** (globaler Hook in `server.ts`):
  Accounts ohne Rolle `admin` erreichen nur `/api/auth/*` und `/api/me/*`;
  alle übrigen Routen antworten mit `403 FORBIDDEN`. Die Self-Service-Routen
  wiederum verlangen ein verknüpftes, aktives Personalprofil und liefern
  ausschließlich eigene Daten.
- **Das Token belegt nur die Identität:** Rolle und `employee_id` werden im
  Hook pro Request frisch aus `users` geladen. Rollenentzug, Umverknüpfung
  oder Kontolöschung wirken damit sofort — wichtig für ein internetseitig
  erreichbares Portal, nicht erst nach Ablauf der 12-Stunden-Token-Laufzeit.
- Die Self-Service-Routen begrenzen Zeitspannen auf zwei Jahre
  (`MAX_SPAN_DAYS` in `modules/me/routes.ts`) — Schutz der synchronen
  Tageszählung vor absurden Spannen; längere Abwesenheiten erfasst die HR.
- Beide Clients nutzen denselben Login (`POST /api/auth/login`). Die Desktop-App
  weist Portalkonten mit einer Meldung ab, das Portal reine Admin-Konten —
  das ist nur UX; die Sicherheitsgrenze ist der Backend-Hook.
- Ein Admin-Konto **mit** verknüpftem Profil (z. B. Jürgen Wilms) kann beides:
  in der Desktop-App verwalten und das Portal für eigene Anträge nutzen.

## Self-Service-API (/api/me/*)

Implementiert in `apps/backend/src/modules/me/routes.ts` (Antragslogik geteilt
mit dem Abwesenheitsmodul über `modules/absences/service.ts#createRequest` —
Überlappungsprüfung, Arbeitstagszählung, Jahresobergrenzen und Auto-Genehmigung
sind damit in HR-Erfassung und Portal identisch):

| Route | Zweck |
|---|---|
| `GET /api/me/profile` | Eigene Stammdaten (ohne Bank-/Steuerdaten) |
| `GET /api/me/leave-types` | Beantragbare Arten (aktiv, ohne Kategorie Krankheit) |
| `GET/POST /api/me/leave-requests` | Eigene Anträge lesen/stellen |
| `POST /api/me/leave-requests/:id/cancel` | Eigenen offenen Antrag zurückziehen |
| `GET /api/me/leave-balance` | Eigener Urlaubssaldo |
| `GET /api/me/leave-preview` | Live-Vorschau der gezählten Tage |
| `GET/POST /api/me/sick-notes` | Krankmeldungen einsehen/einreichen (AU-Frist = 3. Kalendertag) |

Smoke-Test: `npx tsx apps/backend/src/modules/me/smoke.ts` (deckt auch den
Rollen-Guard ab). Demo-Konten legt `npm run seed` an — vier Admins
(`hrmonic2026`) und vier Portal-Konten (`portal2026`), siehe Seed-Ausgabe.

## Frontend-Architektur

- Eigener Workspace `apps/web` (Vite + React 18 + TanStack Query), Dev-Port
  **5174** (`npm run dev` startet Backend + Renderer + Portal zusammen).
- **BrowserRouter, kein `base: './'`** — das Portal wird über HTTP ausgeliefert;
  die file://-Zwänge des Desktop-Renderers gelten hier nicht.
- API-Basis: `VITE_API_BASE`, sonst im Dev `http://127.0.0.1:3001`, im
  Prod-Build **same-origin** (`''`) — gedacht für den Reverse-Proxy-Deploy unten.
  Token liegt unter `localStorage['hrmonic.portal.token']`.
- Gestaltung: HRMONIC-Farbwelt, Wortmarke und Typografie wie die Desktop-App
  (`src/design/tokens.css`, Farb- und Schriftwerte identisch zu
  `apps/renderer`; Inter Variable, gleiche Größenskala), aber eigene,
  ruhig-dokumentenhafte Formensprache: flache Karten mit Hairlines statt
  Schatten, keine Icon-Bibliothek, Skeleton-Loader statt Spinner, responsive
  bis Smartphone-Breite. Klassenpräfix `pt-` (Portal) statt `hm-`.
  Die Login-Seite legt hinter Wortmarke, Claim und Karte eine langsam
  driftende Wellen-Ebene (harmonische Teilschwingungen einer Grundwelle,
  `HarmonyBackdrop` in `pages/LoginPage.tsx`; respektiert
  `prefers-reduced-motion`).

## Deployment hinter eigener Domain

Das Backend bleibt API-only; ein Reverse-Proxy liefert das statische
Portal-Build aus und reicht `/api/*` durch. Referenzaufbau (eine Maschine):

```
Browser ── https://portal.firma.de ──> nginx/Caddy
                    ├── /api/*  → http://127.0.0.1:3001   (HRMONIC Backend)
                    └── /*      → apps/web/dist            (SPA-Fallback auf index.html)
```

1. Build: `npm run build:web` → `apps/web/dist` (statisch, beliebig hostbar).
2. Backend als Dienst: `npm run build -w apps/backend`, dann
   `node apps/backend/dist/cli.cjs` (z. B. via systemd) mit:
   - `HRMONIC_DATA_DIR=/var/lib/hrmonic` — Datenbank, Dateien, Secret
   - `HRMONIC_PORT=3001`
   - `HRMONIC_HOST` nur setzen, wenn Proxy und Backend nicht auf derselben
     Maschine laufen (Standard bleibt bewusst `127.0.0.1`).
   - `HRMONIC_CORS_ORIGIN=https://portal.firma.de` — Pflicht, sobald das Portal
     NICHT same-origin über den Proxy läuft; same-origin braucht kein CORS.
3. Caddy-Beispiel:

   ```
   portal.firma.de {
     handle /api/* {
       reverse_proxy 127.0.0.1:3001
     }
     handle {
       root * /srv/hrmonic-web
       try_files {path} /index.html
       file_server
     }
   }
   ```

   nginx analog: `location /api/ { proxy_pass http://127.0.0.1:3001; }` und
   `location / { try_files $uri /index.html; }` (SPA-Fallback wegen
   BrowserRouter nicht vergessen).
4. Die Desktop-App der HR-Administration kann auf demselben Backend arbeiten,
   sobald sie gegen `https://portal.firma.de` konfiguriert wird; im heutigen
   Rollout läuft sie weiterhin mit eingebettetem Backend bzw. im LAN.

Lokal testen: `npm run dev` (drei Prozesse), Portal auf
http://127.0.0.1:5174, HR-Administration auf http://127.0.0.1:5173.
