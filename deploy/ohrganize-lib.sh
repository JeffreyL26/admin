#!/usr/bin/env bash
#
# oHRganize - gemeinsame Pfade und Hilfsfunktionen der Betriebsskripte
#
# Wird von ohrganize-provision.sh und ohrganize-update.sh eingebunden:
#   . "$(dirname "${BASH_SOURCE[0]}")/ohrganize-lib.sh"
#
# Warum eine gemeinsame Datei: Provisionierung und Update muessen dieselben
# Verzeichnisse meinen. Standen sie zweimal, war die erste Abweichung eine
# Frage der Zeit, und sie faellt erst auf, wenn ein Update die Instanzen
# eines anderen Wurzelverzeichnisses nicht findet.

# ---------------------------------------------------------------------------
# Einstellungen (ueberschreibbar in /etc/ohrganize/provision.conf oder per
# Umgebungsvariable)
# ---------------------------------------------------------------------------
BASIS_DOMAIN="${OHRGANIZE_BASIS_DOMAIN:-ohrganize.com}"
# Programmverzeichnis EINER Instanz: ein Symlink auf ein Release unter
# RELEASE_VERZ. Das Pinnen einer Instanz auf ihren alten Stand ist genau
# dieser Symlink; ein misslungenes Update wird zurueckgenommen, indem er
# wieder auf das vorherige Release zeigt.
PROGRAMM_VERZ="${OHRGANIZE_PROGRAMM_VERZ:-/opt/ohrganize}"
RELEASE_VERZ="${OHRGANIZE_RELEASE_VERZ:-$PROGRAMM_VERZ/releases}"
KUNDEN_VERZ="${OHRGANIZE_KUNDEN_VERZ:-$PROGRAMM_VERZ/kunden}"
WEB_VERZ="${OHRGANIZE_WEB_VERZ:-/srv/ohrganize-web}"
ENV_VERZ="${OHRGANIZE_ENV_VERZ:-/etc/ohrganize/kunden}"
DATEN_VERZ="${OHRGANIZE_DATEN_VERZ:-/var/lib/ohrganize}"
SICHERUNG_VERZ="${OHRGANIZE_SICHERUNG_VERZ:-/var/backups/ohrganize}"
MAP_DATEI="${OHRGANIZE_MAP_DATEI:-/etc/nginx/ohrganize-kunden.map}"
DIENST_BENUTZER="${OHRGANIZE_DIENST_BENUTZER:-ohrganize}"
PORT_VON="${OHRGANIZE_PORT_VON:-3100}"
PORT_BIS="${OHRGANIZE_PORT_BIS:-3999}"

if [[ -r /etc/ohrganize/provision.conf ]]; then
  # shellcheck disable=SC1091
  . /etc/ohrganize/provision.conf
fi

# ---------------------------------------------------------------------------
# Ausgabe
# ---------------------------------------------------------------------------
fehler()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
warnung() { printf 'Achtung: %s\n' "$*" >&2; }
schritt() { printf '  -> %s\n' "$*"; }
hinweis() { printf '     %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Kundenschluessel
# ---------------------------------------------------------------------------
# Der Schluessel wird zu einem DNS-Label, einem systemd-Instanznamen UND einem
# Verzeichnisnamen. Deshalb streng: Kleinbuchstaben, Ziffern, Bindestrich in
# der Mitte, hoechstens 40 Zeichen. Ein Punkt oder Schraegstrich brachte
# systemd und die Pfade durcheinander.
RESERVIERT=(www api admin portal mail smtp imap ns1 ns2 mx cdn static assets
            test staging demo beta app support status monitoring autodiscover)

pruefe_schluessel() {
  local k="$1"
  [[ "$k" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] ||
    fehler "\"$k\" ist kein gueltiger Kundenschluessel. Erlaubt: Kleinbuchstaben, Ziffern und Bindestriche (nicht am Anfang oder Ende), hoechstens 40 Zeichen."
  local r
  for r in "${RESERVIERT[@]}"; do
    [[ "$k" == "$r" ]] && fehler "\"$k\" ist ein reservierter Name und darf kein Kundenschluessel sein."
  done
  return 0
}

kunde_vorhanden() { [[ -f "$ENV_VERZ/$1.env" ]]; }

# Alle angelegten Kunden, alphabetisch.
alle_kunden() {
  local datei
  compgen -G "$ENV_VERZ/*.env" >/dev/null || return 0
  for datei in "$ENV_VERZ"/*.env; do basename "$datei" .env; done | sort
}

# Wert einer Variablen aus der env-Datei eines Kunden (ohne die Datei zu sourcen:
# sie gehoert root und koennte im Fehlerfall beliebigen Code enthalten).
env_wert() {
  local kunde="$1" name="$2"
  [[ -r "$ENV_VERZ/$kunde.env" ]] || return 0
  sed -n "s/^[[:space:]]*$name=\(.*\)$/\1/p" "$ENV_VERZ/$kunde.env" | head -1
}

kunden_port()     { env_wert "$1" OHRGANIZE_PORT; }
kunden_variante() { env_wert "$1" OHRGANIZE_VARIANT; }
kunden_datenverz() { env_wert "$1" OHRGANIZE_DATA_DIR; }

# ---------------------------------------------------------------------------
# Programmverzeichnis einer Instanz
# ---------------------------------------------------------------------------
# /opt/ohrganize/kunden/<kunde> ist ein Symlink auf
# /opt/ohrganize/releases/<variante>-<version>.
kunden_programm() { printf '%s/%s' "$KUNDEN_VERZ" "$1"; }

# Release, auf das der Symlink einer Instanz zeigt (Ordnername), sonst leer.
kunden_release() {
  local ziel
  ziel="$(readlink -f "$(kunden_programm "$1")" 2>/dev/null || true)"
  [[ -n "$ziel" ]] && basename "$ziel"
}

# Variante, die IM Programmverzeichnis einer Instanz steckt (VARIANTE.txt aus
# dem Archiv). Leer, wenn der Symlink fehlt oder das Release sie nicht nennt.
release_variante() {
  local verz="$1"
  [[ -r "$verz/VARIANTE.txt" ]] && tr -d '[:space:]' <"$verz/VARIANTE.txt"
}

# Version eines entpackten Releases aus seinem release.json, leer ohne Datei.
release_version() {
  local datei="$1/release.json"
  [[ -r "$datei" ]] || return 0
  json_feld "$(cat "$datei")" version
}

# ---------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------
# Ein Release ist ein entpacktes Archiv unter $RELEASE_VERZ, benannt
# <variante>-<version> (so legt es ohrganize-update.sh ab). Ausgabe und
# Version stehen zusaetzlich in VARIANTE.txt und release.json im Release -
# danach wird geprueft, nicht nach dem Ordnernamen: Ein umbenannter Ordner
# darf nicht die falsche Ausgabe oder Version verstecken.
releases_auflisten() {
  [[ -d "$RELEASE_VERZ" ]] || return 0
  find "$RELEASE_VERZ" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort
}

# Neuestes STABILES Release einer Variante, je Stelle numerisch verglichen
# (als Text laege 1.9.0 hinter 1.10.0). Eine Beta waehlt nur, wer
# `anlegen --release <ordner>` nennt.
neuestes_release() {
  local variante="$1" kandidat version
  while read -r kandidat; do
    [[ -n "$kandidat" ]] || continue
    [[ "$(release_variante "$RELEASE_VERZ/$kandidat")" == "$variante" ]] || continue
    version="$(release_version "$RELEASE_VERZ/$kandidat")" || continue
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    printf '%s\t%s\n' "$version" "$kandidat"
  done < <(releases_auflisten) | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | cut -f2
}

# ---------------------------------------------------------------------------
# Node-Werkzeuge als Dienstbenutzer
# ---------------------------------------------------------------------------
# NIE als root: Jeder Zugriff auf eine SQLite-Datenbank im WAL-Modus legt
# -wal und -shm daneben an, auch ein lesender. Als root gehoeren die beiden
# dann root, und die naechste Schreibsperre des Dienstes scheitert an den
# Rechten. Die Werkzeuge selbst verweigern den Lauf als root; dieser Aufruf
# ist die Gegenseite davon.
als_dienst() {
  runuser -u "$DIENST_BENUTZER" -- "$@"
}

# Werkzeug aus dem Programmverzeichnis EINER Instanz (status.cjs, admin-reset.cjs,
# migrate-check.cjs). Fehlt es, stammt das Release aus einer aelteren Fassung.
werkzeug() {
  local kunde="$1" name="$2" pfad
  pfad="$(kunden_programm "$kunde")/apps/backend/dist/$name"
  [[ -f "$pfad" ]] || return 1
  printf '%s' "$pfad"
}

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------
nginx_vorhanden() { command -v nginx >/dev/null 2>&1; }

nginx_uebernehmen() {
  nginx_vorhanden || {
    warnung "nginx ist nicht installiert - $MAP_DATEI wurde geschrieben, aber nicht uebernommen."
    return 0
  }
  nginx -t >/dev/null 2>&1 || {
    nginx -t || true
    fehler 'nginx -t schlaegt fehl. Die Map wurde geaendert, aber NICHT uebernommen - bitte pruefen.'
  }
  systemctl reload nginx
}

map_austragen() {
  local kunde="$1" tmp
  [[ -f "$MAP_DATEI" ]] || return 0
  tmp="$(mktemp)"
  grep -v "^$kunde\.$BASIS_DOMAIN[[:space:]]" "$MAP_DATEI" >"$tmp" || true
  mv "$tmp" "$MAP_DATEI"
  chmod 0644 "$MAP_DATEI"
}

map_eintragen() {
  local kunde="$1" port="$2" zeile
  zeile="$kunde.$BASIS_DOMAIN 127.0.0.1:$port;"
  touch "$MAP_DATEI"
  # Vorhandene Zeile desselben Kunden ersetzen statt anhaengen: Ein zweiter
  # Eintrag zum selben Namen ist in nginx ein Fehler ("duplicate parameter").
  map_austragen "$kunde"
  printf '%s\n' "$zeile" >>"$MAP_DATEI"
  sort -o "$MAP_DATEI" "$MAP_DATEI"
  chmod 0644 "$MAP_DATEI"
}

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
# Antwort von /api/health einer laufenden Instanz; leer, wenn sie nicht
# antwortet. Ohne jq: ein Feld herausschneiden reicht fuer Version, Variante
# und Kanal, und jq ist auf einem frischen Server nicht zwingend vorhanden.
health_json() {
  local port="$1"
  curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null || true
}

# json_feld '<json>' 'variant' 'id'  -> Wert eines verschachtelten Feldes.
# json_feld '<json>' 'version'       -> Wert eines Feldes erster Ebene.
json_feld() {
  local json="$1" a="$2" b="${3:-}"
  # Zeilenumbrueche entfernen: status.cjs gibt mehrzeiliges JSON aus, und
  # sed arbeitet zeilenweise; ohne diese Zeile fand json_feld dort nie ein
  # verschachteltes Feld (license.state blieb leer, liste zeigte "-").
  json="$(printf '%s' "$json" | tr -d '\n\r')"
  if [[ -n "$b" ]]; then
    printf '%s' "$json" | sed -n "s/.*\"$a\"[[:space:]]*:[[:space:]]*{[^}]*\"$b\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  else
    printf '%s' "$json" | sed -n "s/.*\"$a\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  fi
}

# Wie json_feld, aber fuer Zahlen (ohne Anfuehrungszeichen), etwa
# encryption.storage_damaged_files aus status.cjs. Leer, wenn das Feld fehlt.
json_zahl() {
  local json="$1" a="$2" b="$3"
  json="$(printf '%s' "$json" | tr -d '\n\r')"
  printf '%s' "$json" | sed -n "s/.*\"$a\"[[:space:]]*:[[:space:]]*{[^}]*\"$b\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -1
}

warte_auf_health() {
  local port="$1" sekunden="${2:-30}" versuch
  for ((versuch = 1; versuch <= sekunden; versuch++)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Wartet auf /api/health, solange der Dienst laeuft, hoechstens $3 Sekunden
# (Vorgabe 900). Ein erster Start einer Fassung kann deutlich laenger brauchen
# als ein gewoehnlicher (Umstellung auf Verschluesselung, VACUUM nach einer
# Migration, beides waechst mit der Datenbank); eine feste Frist von 45 s
# hielt einen solchen Start fuer gescheitert und nahm ihn bei jedem Versuch
# zurueck. Ein abgestuerzter Dienst bricht das Warten dagegen sofort ab:
# systemd meldet failed/inactive oder zaehlt einen Neustart (NRestarts).
# Eine leere Antwort (systemctl scheitert unter Last an D-Bus) ist keine
# Auskunft und zaehlt weder als Neustart noch als Ausgangswert; sonst naehme
# eine einzige verlorene Antwort einen gesunden, langen Start zurueck.
warte_auf_start() {
  local unit="$1" port="$2" sekunden="${3:-900}" ende zustand neustarts vorher
  vorher="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || true)"
  # Echte Zeit (SECONDS) statt Durchlaeufe: Jeder Durchlauf kostet bis zu 2 s
  # curl plus 1 s Pause, gezaehlt waeren 900 Durchlaeufe bis zu 45 Minuten.
  ende=$((SECONDS + sekunden))
  while ((SECONDS < ende)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      return 0
    fi
    zustand="$(systemctl is-active "$unit" 2>/dev/null || true)"
    neustarts="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || true)"
    if [[ -z "$vorher" ]]; then
      vorher="$neustarts"
    elif [[ -n "$neustarts" && "$neustarts" != "$vorher" ]]; then
      return 1
    fi
    if [[ "$zustand" == failed || "$zustand" == inactive ]]; then
      return 1
    fi
    sleep 1
  done
  return 1
}
