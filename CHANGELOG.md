# Aenderungsprotokoll

Alle nennenswerten Aenderungen an oHRganize stehen hier, neueste zuerst.
Das Format folgt "Keep a Changelog"; die Versionsnummer folgt Semver
(`1.2.0` ist Kanal `stable`, `1.2.0-beta.1` ist Kanal `beta`). Jede
Version, die mit `scripts/release.mjs` gebaut wird, braucht hier einen
eigenen Abschnitt.

## Unveroeffentlicht

### Geaendert
- Lizenztexte kommen fuer Desktop-App, Portal und Backend aus einer
  Funktion (`describeLicense` in `packages/shared`). Unbefristete Lizenzen
  melden `perpetual = true`, keinen Countdown und kein Kulanzdatum mehr
  (bisher "Kulanz bis 14.01.3000"). `kind = evaluation` heisst in der
  Oberflaeche "Testlizenz". Neues Feld `issued_at` im Lizenzzustand.
- Der Zustandsautomat der Lizenz ist eine reine Funktion
  (`core/licenseState.ts`), tabellengetrieben geprueft.

### Hinzugefuegt
- `scripts/check-dashes.mjs` und `npm run check:dashes`: prueft neue Zeilen
  auf Gedankenstriche (drei UI-Konventionen bleiben erlaubt).
- Feiertags-Fixture `apps/backend/src/test/fixtures/holidays-de.json` mit
  Regressionstest `npm run test:holidays` (128 Kombinationen aus 8 Jahren
  und 16 Regionen).
- Umsetzungsplan `docs/umsetzungsplan-varianten-lizenz.md` fuer Varianten,
  Lizenz v2, Feature-Schluessel, Laender, Kanaele, Hosting und conspectus.

## 1.0.0 (2026-09-13)

Erste Auslieferung: Desktop-App (Electron) fuer die Personalabteilung und
Mitarbeitenden-Portal (Web) auf demselben Backend (Fastify, SQLite).
Signierte Offline-Lizenz mit Testphase, Warnfrist, Kulanz und
Nur-Lese-Betrieb; Serverauslieferung als Release-Archiv mit systemd-Units
(Linux) und PowerShell-Einrichtung (Windows).
