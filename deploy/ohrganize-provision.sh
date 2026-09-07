#!/usr/bin/env bash
#
# oHRganize — Kundeninstanzen auf einem Server anlegen, auflisten, entfernen
#
# Ablage:  /opt/ohrganize/deploy/ohrganize-provision.sh (im ausgecheckten Stand)
# Aufruf:  sudo /opt/ohrganize/deploy/ohrganize-provision.sh anlegen musterfirma
# Doku:    deploy/README.md, Abschnitt „Mehrere Kunden auf einem Server"
#
# Was ein Kunde ist: eine eigene systemd-Instanz (ohrganize-backend@<kunde>)
# mit eigenem Port, eigenem Datenverzeichnis und eigener Subdomain. oHRganize
# ist bewusst nicht mandantenfähig — ein Prozess, eine SQLite-Datei. Dieses
# Skript hält die vier Stellen zusammen, die dabei zueinander passen müssen:
# env-Datei, systemd-Instanz, nginx-Map und Sicherungs-Timer. Von Hand gerät
# spätestens der Port zwischen env-Datei und Map auseinander — und dann sieht
# ein Kunde die Daten eines anderen.

set -euo pipefail

# ---------------------------------------------------------------------------
# Einstellungen
# ---------------------------------------------------------------------------
# Überschreibbar in /etc/ohrganize/provision.conf (KEY="wert" je Zeile) oder
# per Umgebungsvariable.
BASIS_DOMAIN="${OHRGANIZE_BASIS_DOMAIN:-ohrganize.com}"
PROGRAMM_VERZ="${OHRGANIZE_PROGRAMM_VERZ:-/opt/ohrganize}"
ENV_VERZ="${OHRGANIZE_ENV_VERZ:-/etc/ohrganize/kunden}"
DATEN_VERZ="${OHRGANIZE_DATEN_VERZ:-/var/lib/ohrganize}"
SICHERUNG_VERZ="${OHRGANIZE_SICHERUNG_VERZ:-/var/backups/ohrganize}"
MAP_DATEI="${OHRGANIZE_MAP_DATEI:-/etc/nginx/ohrganize-kunden.map}"
DIENST_BENUTZER="${OHRGANIZE_DIENST_BENUTZER:-ohrganize}"
# Portbereich der Kundeninstanzen. 3001 bleibt frei — das ist der Port des
# Einzelkunden-Betriebs aus ohrganize.env.example.
PORT_VON="${OHRGANIZE_PORT_VON:-3100}"
PORT_BIS="${OHRGANIZE_PORT_BIS:-3999}"

if [[ -r /etc/ohrganize/provision.conf ]]; then
  # shellcheck disable=SC1091
  . /etc/ohrganize/provision.conf
fi

VORLAGE_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ohrganize-kunde.env.example"

# Namen, die nicht als Kundenschlüssel taugen: Sie werden auf derselben
# Basisdomain früher oder später anderweitig gebraucht, und ein Kunde, der
# "www" heißt, blockiert sie dauerhaft.
RESERVIERT=(www api admin portal mail smtp imap ns1 ns2 mx cdn static assets
            test staging demo beta app support status monitoring autodiscover)

# ---------------------------------------------------------------------------
# Ausgabe
# ---------------------------------------------------------------------------
fehler()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
warnung() { printf 'Achtung: %s\n' "$*" >&2; }
schritt() { printf '  → %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Prüfungen
# ---------------------------------------------------------------------------
pruefe_umgebung() {
  [[ $EUID -eq 0 ]] || fehler 'Bitte als root ausführen (sudo).'
  for werkzeug in systemctl install sed curl; do
    command -v "$werkzeug" >/dev/null 2>&1 || fehler "\"$werkzeug\" wird gebraucht, ist aber nicht installiert."
  done
  [[ -r "$VORLAGE_ENV" ]] || fehler "Vorlage $VORLAGE_ENV nicht gefunden (liegt neben diesem Skript)."
  id "$DIENST_BENUTZER" >/dev/null 2>&1 ||
    fehler "Dienstbenutzer \"$DIENST_BENUTZER\" existiert nicht. Anlegen: siehe deploy/README.md, Abschnitt 2."
  [[ -f /etc/systemd/system/ohrganize-backend@.service ]] ||
    fehler 'Vorlage /etc/systemd/system/ohrganize-backend@.service fehlt. Einrichtung: deploy/README.md.'
}

# Der Schlüssel wird zu einem DNS-Label, einem systemd-Instanznamen UND einem
# Verzeichnisnamen. Deshalb streng: Kleinbuchstaben, Ziffern, Bindestrich in
# der Mitte, höchstens 40 Zeichen. Ein Punkt oder Schrägstrich würde sowohl
# systemd als auch die Pfade durcheinanderbringen.
pruefe_schluessel() {
  local k="$1"
  [[ "$k" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] ||
    fehler "\"$k\" ist kein gültiger Kundenschlüssel. Erlaubt: Kleinbuchstaben, Ziffern und Bindestriche (nicht am Anfang oder Ende), höchstens 40 Zeichen."
  local r
  for r in "${RESERVIERT[@]}"; do
    [[ "$k" == "$r" ]] && fehler "\"$k\" ist ein reservierter Name und darf kein Kundenschlüssel sein."
  done
  return 0
}

kunde_vorhanden() { [[ -f "$ENV_VERZ/$1.env" ]]; }

# ---------------------------------------------------------------------------
# Portvergabe
# ---------------------------------------------------------------------------
# Belegt ist ein Port, wenn er in einer env-Datei steht ODER gerade jemand
# darauf lauscht. Beides prüfen: Die env-Dateien allein übersehen fremde
# Dienste auf dem Server, die Lauschliste allein übersieht eine gestoppte
# Kundeninstanz.
belegte_ports() {
  if compgen -G "$ENV_VERZ/*.env" >/dev/null; then
    sed -n 's/^[[:space:]]*OHRGANIZE_PORT=\([0-9]\+\).*/\1/p' "$ENV_VERZ"/*.env
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Htln 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -E '^[0-9]+$' || true
  fi
}

freier_port() {
  local belegt port
  belegt=" $(belegte_ports | tr '\n' ' ') "
  for ((port = PORT_VON; port <= PORT_BIS; port++)); do
    [[ "$belegt" == *" $port "* ]] && continue
    printf '%s' "$port"
    return 0
  done
  fehler "Im Bereich $PORT_VON–$PORT_BIS ist kein Port mehr frei."
}

# ---------------------------------------------------------------------------
# nginx-Map
# ---------------------------------------------------------------------------
nginx_vorhanden() { command -v nginx >/dev/null 2>&1; }

map_eintragen() {
  local kunde="$1" port="$2" zeile
  zeile="$kunde.$BASIS_DOMAIN 127.0.0.1:$port;"
  touch "$MAP_DATEI"
  # Vorhandene Zeile desselben Kunden ersetzen statt anhängen: Ein zweiter
  # Eintrag zum selben Namen ist in nginx ein Fehler ("duplicate parameter").
  map_austragen "$kunde"
  printf '%s\n' "$zeile" >>"$MAP_DATEI"
  sort -o "$MAP_DATEI" "$MAP_DATEI"
  chmod 0644 "$MAP_DATEI"
}

map_austragen() {
  local kunde="$1" tmp
  [[ -f "$MAP_DATEI" ]] || return 0
  tmp="$(mktemp)"
  grep -v "^$kunde\.$BASIS_DOMAIN[[:space:]]" "$MAP_DATEI" >"$tmp" || true
  mv "$tmp" "$MAP_DATEI"
  chmod 0644 "$MAP_DATEI"
}

nginx_uebernehmen() {
  nginx_vorhanden || {
    warnung "nginx ist nicht installiert — $MAP_DATEI wurde geschrieben, aber nicht übernommen."
    return 0
  }
  nginx -t >/dev/null 2>&1 || {
    nginx -t || true
    fehler 'nginx -t schlägt fehl. Die Map wurde geändert, aber NICHT übernommen — bitte prüfen.'
  }
  systemctl reload nginx
}

# ---------------------------------------------------------------------------
# anlegen
# ---------------------------------------------------------------------------
anlegen() {
  local kunde="${1:-}"
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh anlegen <kunde>'
  pruefe_schluessel "$kunde"
  kunde_vorhanden "$kunde" && fehler "Kunde \"$kunde\" existiert bereits ($ENV_VERZ/$kunde.env)."

  local domain port
  domain="$kunde.$BASIS_DOMAIN"
  port="$(freier_port)"

  printf 'Lege Kunde "%s" an — %s auf Port %s\n' "$kunde" "$domain" "$port"

  # Ab hier wird geschrieben. Schlägt etwas fehl, wird alles wieder abgeräumt:
  # Eine halb angelegte Instanz (env-Datei ohne laufenden Dienst, Map-Eintrag
  # ins Leere) ist schlimmer als gar keine — sie sieht beim nächsten `liste`
  # aus wie ein funktionierender Kunde.
  local aufraeumen=1
  # shellcheck disable=SC2317
  zuruecknehmen() {
    [[ $aufraeumen -eq 1 ]] || return 0
    printf '\nAbbruch — nehme die angefangenen Schritte zurück.\n' >&2
    systemctl disable --now "ohrganize-backend@$kunde" >/dev/null 2>&1 || true
    systemctl disable --now "ohrganize-backup@$kunde.timer" >/dev/null 2>&1 || true
    map_austragen "$kunde"
    nginx_vorhanden && nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    rm -f "$ENV_VERZ/$kunde.env"
    # Das Datenverzeichnis bleibt absichtlich stehen: Falls beim allerersten
    # Start doch schon eine Datenbank entstanden ist, wird sie nicht von einem
    # Fehlerpfad gelöscht.
    printf 'Zurückgenommen. Ein evtl. angelegtes %s/%s bleibt bestehen.\n' "$DATEN_VERZ" "$kunde" >&2
  }
  trap zuruecknehmen EXIT

  schritt "Konfiguration $ENV_VERZ/$kunde.env"
  install -d -m 0750 -o root -g "$DIENST_BENUTZER" "$ENV_VERZ"
  sed -e "s/__KUNDE__/$kunde/g" -e "s/__PORT__/$port/g" -e "s/__DOMAIN__/$domain/g" \
    "$VORLAGE_ENV" >"$ENV_VERZ/$kunde.env"
  chown root:"$DIENST_BENUTZER" "$ENV_VERZ/$kunde.env"
  chmod 0640 "$ENV_VERZ/$kunde.env"

  schritt "Sicherungsverzeichnis $SICHERUNG_VERZ/$kunde"
  install -d -m 0700 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$SICHERUNG_VERZ"
  install -d -m 0700 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$SICHERUNG_VERZ/$kunde"

  schritt "Dienst ohrganize-backend@$kunde starten"
  systemctl enable --now "ohrganize-backend@$kunde" >/dev/null

  schritt 'Auf Antwort des Backends warten'
  local versuch
  for versuch in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      break
    fi
    if [[ $versuch -eq 30 ]]; then
      printf '\nDie letzten Zeilen aus dem Journal:\n' >&2
      journalctl -u "ohrganize-backend@$kunde" -n 20 --no-pager >&2 || true
      fehler "Das Backend von \"$kunde\" antwortet nach 30 s nicht auf 127.0.0.1:$port."
    fi
    sleep 1
  done

  schritt "Tägliche Sicherung aktivieren"
  systemctl enable --now "ohrganize-backup@$kunde.timer" >/dev/null

  schritt "Subdomain $domain im Reverse-Proxy eintragen"
  map_eintragen "$kunde" "$port"
  nginx_uebernehmen

  aufraeumen=0
  trap - EXIT

  # -------------------------------------------------------------------------
  # Übergabe
  # -------------------------------------------------------------------------
  local pwdatei="$DATEN_VERZ/$kunde/initial-admin-password.txt"
  printf '\nKunde "%s" ist eingerichtet.\n\n' "$kunde"
  printf '  Portal          https://%s\n' "$domain"
  printf '  Backend         127.0.0.1:%s (nur lokal, erreichbar über den Proxy)\n' "$port"
  printf '  Daten           %s/%s\n' "$DATEN_VERZ" "$kunde"
  printf '  Sicherungen     %s/%s (täglich, 14 Stände)\n' "$SICHERUNG_VERZ" "$kunde"
  printf '  Journal         journalctl -t ohrganize-%s\n\n' "$kunde"

  if [[ -r "$pwdatei" ]]; then
    printf '  Erstanmeldung   admin@ohrganize.de / %s\n' "$(cat "$pwdatei")"
    printf '                  Das Passwort muss beim ersten Login gewechselt werden.\n'
    printf '                  Danach %s löschen.\n\n' "$pwdatei"
  else
    printf '  Erstanmeldung   Passwort steht im Journal: journalctl -t ohrganize-%s | grep -i passwort\n\n' "$kunde"
  fi

  printf '  Desktop-Arbeitsplätze dieses Kunden bekommen\n'
  printf '  %%APPDATA%%\\oHRganize\\config.json mit:\n'
  printf '      { "apiBaseUrl": "https://%s" }\n\n' "$domain"
  printf '  Voraussetzung: Der DNS-Eintrag *.%s zeigt auf diesen Server\n' "$BASIS_DOMAIN"
  printf '  und das Wildcard-Zertifikat ist ausgestellt (deploy/README.md).\n'
}

# ---------------------------------------------------------------------------
# liste
# ---------------------------------------------------------------------------
liste() {
  if ! compgen -G "$ENV_VERZ/*.env" >/dev/null; then
    printf 'Noch kein Kunde angelegt (%s ist leer).\n' "$ENV_VERZ"
    return 0
  fi
  printf '%-24s %-6s %-10s %-10s %s\n' KUNDE PORT DIENST DATENBANK LETZTE-SICHERUNG
  local datei kunde port zustand groesse sicherung
  for datei in "$ENV_VERZ"/*.env; do
    kunde="$(basename "$datei" .env)"
    port="$(sed -n 's/^[[:space:]]*OHRGANIZE_PORT=\([0-9]\+\).*/\1/p' "$datei" | head -1)"
    zustand="$(systemctl is-active "ohrganize-backend@$kunde" 2>/dev/null || true)"
    if [[ -f "$DATEN_VERZ/$kunde/ohrganize.db" ]]; then
      groesse="$(du -h "$DATEN_VERZ/$kunde/ohrganize.db" | cut -f1)"
    else
      groesse='—'
    fi
    sicherung="$(find "$SICHERUNG_VERZ/$kunde" -maxdepth 1 -type f -printf '%TY-%Tm-%Td\n' 2>/dev/null | sort | tail -1)"
    printf '%-24s %-6s %-10s %-10s %s\n' "$kunde" "${port:-?}" "${zustand:-inaktiv}" "$groesse" "${sicherung:-—}"
  done
}

# ---------------------------------------------------------------------------
# entfernen
# ---------------------------------------------------------------------------
entfernen() {
  local kunde="${1:-}" loeschen=0
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh entfernen <kunde> [--daten-loeschen]'
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --daten-loeschen) loeschen=1 ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
    shift
  done
  pruefe_schluessel "$kunde"
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."

  printf 'Entferne Kunde "%s".\n' "$kunde"
  schritt 'Subdomain aus dem Reverse-Proxy nehmen'
  map_austragen "$kunde"
  nginx_uebernehmen

  schritt 'Dienst und Sicherungs-Timer stoppen'
  systemctl disable --now "ohrganize-backup@$kunde.timer" >/dev/null 2>&1 || true
  systemctl disable --now "ohrganize-backend@$kunde" >/dev/null 2>&1 || true

  schritt 'Konfiguration entfernen'
  rm -f "$ENV_VERZ/$kunde.env"

  if [[ $loeschen -eq 0 ]]; then
    printf '\nDaten und Sicherungen bleiben liegen:\n'
    printf '  %s/%s\n  %s/%s\n' "$DATEN_VERZ" "$kunde" "$SICHERUNG_VERZ" "$kunde"
    printf 'Das ist Absicht: In der Datenbank stehen Personalakten, deren\n'
    printf 'Aufbewahrungsfristen den Vertrag überdauern können. Erst löschen,\n'
    printf 'wenn die Übergabe an den Kunden bestätigt ist — dann mit\n'
    printf '  %s entfernen %s --daten-loeschen\n' "${BASH_SOURCE[0]}" "$kunde"
    return 0
  fi

  # Unwiderruflich, deshalb Rückfrage. Ohne Terminal (Skript, CI) wird
  # abgebrochen statt blind gelöscht.
  [[ -t 0 ]] || fehler '--daten-loeschen verlangt eine Rückfrage und damit ein Terminal.'
  printf '\nEs werden UNWIDERRUFLICH gelöscht:\n'
  printf '  %s/%s (Datenbank, hochgeladene Dateien, Secret)\n' "$DATEN_VERZ" "$kunde"
  printf '  %s/%s (alle Sicherungen)\n' "$SICHERUNG_VERZ" "$kunde"
  printf 'Zum Bestätigen den Kundenschlüssel eintippen: '
  local antwort
  read -r antwort
  [[ "$antwort" == "$kunde" ]] || fehler 'Eingabe stimmt nicht überein — nichts gelöscht.'
  rm -rf "${DATEN_VERZ:?}/$kunde" "${SICHERUNG_VERZ:?}/$kunde"
  printf 'Daten von "%s" gelöscht.\n' "$kunde"
}

# ---------------------------------------------------------------------------
# Hilfe
# ---------------------------------------------------------------------------
hilfe() {
  cat <<HILFE
oHRganize — Kundeninstanzen verwalten

  anlegen <kunde>                    Neue Instanz: env-Datei, Dienst, Sicherung,
                                     Subdomain <kunde>.$BASIS_DOMAIN
  liste                              Alle Kunden mit Port, Zustand, DB-Größe
  entfernen <kunde> [--daten-loeschen]
                                     Instanz abschalten; Daten bleiben, sofern
                                     nicht ausdrücklich gelöscht

Einstellungen (überschreibbar in /etc/ohrganize/provision.conf):
  BASIS_DOMAIN=$BASIS_DOMAIN
  PORT_VON=$PORT_VON  PORT_BIS=$PORT_BIS
  ENV_VERZ=$ENV_VERZ
  DATEN_VERZ=$DATEN_VERZ
  MAP_DATEI=$MAP_DATEI

Einrichtung des Servers: deploy/README.md
HILFE
}

# ---------------------------------------------------------------------------
befehl="${1:-hilfe}"
[[ $# -gt 0 ]] && shift || true
case "$befehl" in
  anlegen)   pruefe_umgebung; anlegen "$@" ;;
  liste)     liste "$@" ;;
  entfernen) pruefe_umgebung; entfernen "$@" ;;
  hilfe|-h|--help) hilfe ;;
  *) printf 'Unbekannter Befehl: %s\n\n' "$befehl" >&2; hilfe >&2; exit 1 ;;
esac
