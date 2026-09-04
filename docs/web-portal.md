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
  erreichbares Portal, nicht erst nach Ablauf der Token-Laufzeit (Vorgabe
  **1 Stunde**, `tokenTtl` in `apps/backend/src/config.ts`, überschreibbar mit
  `OHRGANIZE_TOKEN_TTL`).
- Die Self-Service-Routen begrenzen Zeitspannen auf zwei Jahre
  (`MAX_SPAN_DAYS` in `modules/me/routes.ts`) — Schutz der synchronen
  Tageszählung vor absurden Spannen; längere Abwesenheiten erfasst die HR.
- Beide Clients nutzen denselben Login (`POST /api/auth/login`). Die Desktop-App
  weist Portalkonten mit einer Meldung ab, das Portal reine Admin-Konten —
  das ist nur UX; die Sicherheitsgrenze ist der Backend-Hook.
- Ein Admin-Konto **mit** verknüpftem Profil (z. B. Jürgen Wilms) kann beides:
  in der Desktop-App verwalten und das Portal für eigene Anträge nutzen.

## Self-Service-API (/api/me/*)

Das Modul ist aufgeteilt: `modules/me/routes.ts` registriert die Teil-Plugins,
gemeinsame Helfer (`requireEmployee`, `assertReasonableSpan`, `MAX_SPAN_DAYS`)
liegen in `modules/me/lib.ts` — **nicht kopieren, importieren**. Die Antragslogik
teilt sich das Modul mit dem Abwesenheitsmodul über
`modules/absences/service.ts#createRequest` (Überlappungsprüfung,
Arbeitstagszählung, Jahresobergrenzen, Auto-Genehmigung **und
Berechtigungsprüfung** sind damit in HR-Erfassung und Portal identisch):

| Route | Datei | Zweck |
|---|---|---|
| `GET /api/me/profile` | `routes.ts` | Eigene Stammdaten (ohne Bank-/Steuerdaten) |
| `GET /api/me/leave-types` | `routes.ts` | Beantragbare Arten — gefiltert über `allowedTypeIdsFor` |
| `GET/POST /api/me/leave-requests` | `routes.ts` | Eigene Anträge lesen/stellen |
| `POST /api/me/leave-requests/:id/cancel` | `routes.ts` | Eigenen offenen Antrag zurückziehen |
| `GET /api/me/leave-balance` | `routes.ts` | Eigener Urlaubssaldo |
| `GET /api/me/leave-preview` | `routes.ts` | Live-Vorschau der gezählten Tage |
| `GET/POST /api/me/sick-notes` | `routes.ts` | Krankmeldungen (AU-Frist = 3. Kalendertag) |
| `GET /api/me/salary` · `/salary/history` · `/bonuses` · `/freelancer` | `salaryRoutes.ts` | Eigene Vergütung |
| `GET /api/me/org-tree` | `orgRoutes.ts` | Abteilungs-Organigramm (`buildOrgTree()`) |
| `GET /api/me/calendar?year=&month=` | `calendarRoutes.ts` | Firmenweite Abwesenheiten |
| `GET/POST /api/me/documents` · `POST /api/me/documents/:id/download` | `documentRoutes.ts` | Eigene Dokumente |

Drei Grenzen, die bewusst gesetzt sind und beim Erweitern gelten müssen:

- **Gehalt:** `salary_components.note` enthält HR-interne Begründungen aus
  Gehaltsänderungsanträgen (`Änderungsantrag #<id>: <reason>`). Antworten deshalb
  **Feld für Feld** bauen — kein `SELECT *`, kein `{ ...row }`. Gleiches gilt für
  `bonuses.note`/`goal_id` und `freelancer_invoices.note`/`file_id`.
  Fehlen die Wochenstunden, liefert die Route bei Stundenlohn `0` statt einer
  erfundenen Hochrechnung (`monthlyCents` fiele still auf 40 h zurück).
- **Kalender:** `month` ist Pflicht (Lastgrenze — die Route ruft jede:r auf), nur
  `status='genehmigt'`, keine `conflicts` (Teamquoten sind eine HR-Kennzahl).
  Arten mit `absence_types.portal_visibility='neutral'` werden serverseitig zu
  `type_id: null` / „Abwesend" maskiert.
- **Dokumente:** Zugriff auf fremde Dokumente antwortet mit **404, nicht 403** —
  ein 403 verriete deren Existenz. Upload nur mit Kategorie
  `bescheinigung|zertifikat|sonstiges`, MIME-Whitelist, 10 MB, `supersedes_id`
  verboten; `employee_id` kommt immer aus `requireEmployee`, nie aus dem Body.

Smoke-Test: `npx tsx apps/backend/src/modules/me/smoke.ts` (deckt Rollen-Guard,
Berechtigungen, Vier-Augen, Datenschutzgrenzen und Upload-Regeln ab). Neue Checks
gehören **vor** den Widerrufsblock am Ende — der entzieht Profil und Rolle und
löscht das Konto, danach schlägt alles fehl. Demo-Konten legt `npm run seed` an —
vier Admins (`ohrganize2026`) und vier Portal-Konten (`portal2026`). Das ist ein
reiner **Dev-Weg**: Auf einem Kundensystem darf `npm run seed` nie laufen,
Portal-Konten entstehen dort über *Verwaltung → Benutzer & Rechte* mit
serverseitig erzeugtem Erstpasswort (siehe `docs/inbetriebnahme.md`).

## Frontend-Architektur

- Eigener Workspace `apps/web` (Vite + React 18 + TanStack Query), Dev-Port
  **5174** (`npm run dev` startet Backend + Renderer + Portal zusammen).
- **BrowserRouter, kein `base: './'`** — das Portal wird über HTTP ausgeliefert;
  die file://-Zwänge des Desktop-Renderers gelten hier nicht.
- API-Basis: `VITE_API_BASE`, sonst im Dev `http://127.0.0.1:3001`, im
  Prod-Build **same-origin** (`''`) — gedacht für den Reverse-Proxy-Deploy unten.
  Token liegt unter `localStorage['ohrganize.portal.token']`.
- Gestaltung: Farbwelt, Typografie (Inter Variable, gleiche Größenskala),
  Radien, Schatten und Komponenten-Rezepte (Karten, Gradient-Primärbuttons,
  Tabellenköpfe, Badges) wie die Desktop-App — beide Clients sollen als ein
  Produkt wirken. Alle vier Farbschemata (Hell/Dunkel/Rosé/Silber) sind
  vorhanden: `src/design/tokens.css` und `theme.ts` spiegeln die
  Renderer-Werte 1:1 (Sync-Pflicht, siehe CLAUDE.md); die Wahl liegt im
  Portal unter Profil → „Darstellung" (localStorage `ohrganize.theme`, pro
  Gerät und Origin). Seit dem Self-Service-Ausbau trägt das Portal wie die
  Desktop-App eine **linke Seitenleiste** (`.portal-sidebar`, Verlauf und
  Linkoptik 1:1 aus `renderer/src/design/layout.css`). Zwei Abweichungen sind
  Absicht: Das Höhenmodell ist `position: sticky; height: 100dvh` — das
  `body { overflow: hidden }` des Renderers würde den Body-Scroll und den
  `background-attachment: fixed`-Farbnebel des Portals brechen. Und unter 900px
  wird die Leiste zum Off-Canvas-Drawer (Hamburger, Overlay, Escape); dafür gibt
  es im Desktop keine Vorlage, weil dessen Fenster nie so schmal wird.
  Portal-eigen bleiben Skeleton-Loader und der Verzicht auf eine
  Icon-Bibliothek — die Symbole sind schlanke Inline-SVG in
  `src/components/icons.tsx`, **`lucide-react` gehört nicht in `apps/web`**.
  Klassenpräfix `pt-` (Portal) statt `hm-`.

  Seiten: Übersicht · Anträge · Krankmeldung · Kalender (firmenweit) · Gehalt ·
  Dokumente · Organigramm · Profil. Query-Keys beginnen **immer** mit `'me'` —
  das Portal invalidiert grobkörnig über dieses Präfix; ein abweichender Key
  zeigt stille Altdaten. Das Organigramm löst CSS-Variablen zur Renderzeit über
  `getComputedStyle` in konkrete Werte auf (`features/org/chartColors.ts`) und
  liest sie bei Theme-Wechsel per `MutationObserver` neu — `var(…)` greift in
  SVG-Präsentationsattributen nicht zuverlässig.
  Die Login-Seite legt hinter Wortmarke, Claim und Karte eine langsam
  driftende Wellen-Ebene (harmonische Teilschwingungen einer Grundwelle,
  `HarmonyBackdrop` in `pages/LoginPage.tsx`; respektiert
  `prefers-reduced-motion`).

## Deployment hinter eigener Domain

Das Backend bleibt API-only; ein Reverse-Proxy liefert das statische
Portal-Build aus und reicht `/api/*` durch. Referenzaufbau (eine Maschine):

```
Browser ── https://portal.firma.de ──> nginx/Caddy
                    ├── /api/*  → http://127.0.0.1:3001   (oHRganize Backend)
                    └── /*      → apps/web/dist            (SPA-Fallback auf index.html)
```

1. Build: `npm run build:web` → `apps/web/dist` (statisch, beliebig hostbar).
2. Backend als Dienst: `npm run build -w apps/backend`, dann
   `node apps/backend/dist/cli.cjs` (z. B. via systemd) mit:
   - `OHRGANIZE_DATA_DIR=/var/lib/ohrganize` — Datenbank, Dateien, Secret
   - `OHRGANIZE_PORT=3001`
   - `OHRGANIZE_HOST` nur setzen, wenn Proxy und Backend nicht auf derselben
     Maschine laufen (Standard bleibt bewusst `127.0.0.1`).
   - `OHRGANIZE_CORS_ORIGIN=https://portal.firma.de` — Pflicht, sobald das Portal
     NICHT same-origin über den Proxy läuft; same-origin braucht kein CORS.
3. Caddy-Beispiel:

   ```
   portal.firma.de {
     handle /api/* {
       reverse_proxy 127.0.0.1:3001
     }
     handle {
       root * /srv/ohrganize-web
       try_files {path} /index.html
       file_server
     }
   }
   ```

   nginx analog: `location /api/ { proxy_pass http://127.0.0.1:3001; }` und
   `location / { try_files $uri /index.html; }` (SPA-Fallback wegen
   BrowserRouter nicht vergessen).
4. Die Desktop-App der HR-Administration arbeitet auf demselben Backend,
   sobald eine Basis-URL konfiguriert ist — dann startet sie **kein** eigenes
   Backend mehr und HR-Administration und Portal teilen sich eine Datenbank.
   Zwei Quellen, Umgebungsvariable schlägt Datei
   (`readConfiguredApiBase` in `apps/desktop/src/main.ts`):

   | Quelle | Wofür |
   |---|---|
   | `OHRGANIZE_API_BASE=https://portal.firma.de` | skriptierter Rollout, Verknüpfung, MDM |
   | `%APPDATA%\oHRganize\config.json` → `{ "apiBaseUrl": "https://portal.firma.de" }` | IT-Konfiguration je Installation |

   Ohne Konfiguration bleibt alles wie bisher: eingebettetes Backend mit
   lokaler Datenbank in `%APPDATA%\oHRganize\data` (Einzelplatz-Betrieb).
   Beim Start prüft die App `GET /api/health` und bricht bei nicht
   erreichbarem Backend mit klarer Meldung ab statt mit leerem Fenster.

   **CORS nicht vergessen:** Der Desktop-Renderer lädt im Produktivbetrieb
   über ein eigenes Schema (`ohrganize://app`, siehe `apps/desktop/src/main.ts`)
   und sendet damit eine benannte Herkunft. Sobald `OHRGANIZE_CORS_ORIGIN`
   gesetzt ist, muss dieser Wert mit in der Liste stehen, sonst blockiert der
   Browserkern der Desktop-App jede Anfrage:

   ```
   OHRGANIZE_CORS_ORIGIN=https://portal.firma.de,ohrganize://app
   ```

   **Nicht mehr `null` eintragen.** Das früher hier dokumentierte Rezept
   `…,null` ist der Grund, warum die Umstellung auf `ohrganize://app`
   überhaupt nötig war: `null` ist nicht die Herkunft einer bestimmten Seite,
   sondern der Sammelwert *jedes* opaken Kontexts (sandboxed `<iframe>`,
   `data:`-URL, `file://`). Mit `null` in der Liste hätte faktisch jede fremde
   Webseite auf die API zugreifen können — die Whitelist wäre so durchlässig
   gewesen wie gar keine. `config.ts` filtert den Wert deshalb aktiv heraus
   und warnt beim Start.

   `OHRGANIZE_CORS_ORIGIN` niemals auf einem Arbeitsplatz setzen: Das in die
   Desktop-App eingebettete Backend erbt die Variable und sperrt dann den
   eigenen Renderer aus.

   Lokal zum Ausprobieren (beide Clients auf einer Maschine, gemeinsamer
   Datenbestand): Backend auf 3001 starten und die installierte App per
   `config.json` mit `{ "apiBaseUrl": "http://127.0.0.1:3001" }` darauf
   zeigen lassen — CORS bleibt dabei offen, es braucht keine Liste.

Lokal testen: `npm run dev` (drei Prozesse), Portal auf
http://127.0.0.1:5174, HR-Administration auf http://127.0.0.1:5173.
