#!/usr/bin/env bash
#
# oHRganize - Kundeninstanzen auf einem Server anlegen, betreiben, entfernen
#
# Ablage:  /opt/ohrganize/deploy/ohrganize-provision.sh
# Aufruf:  sudo /opt/ohrganize/deploy/ohrganize-provision.sh anlegen musterfirma
# Doku:    deploy/README.md, Abschnitt "Mehrere Kunden auf einem Server"
#
# Was ein Kunde ist: eine eigene systemd-Instanz (ohrganize-backend@<kunde>)
# mit eigenem Port, eigenem Datenverzeichnis, eigenem Programm-Symlink und
# eigener Subdomain. oHRganize ist bewusst nicht mandantenfaehig - ein
# Prozess, eine SQLite-Datei. Dieses Skript haelt die Stellen zusammen, die
# dabei zueinander passen muessen: env-Datei, Programm-Symlink, Portal-Symlink,
# systemd-Instanz, nginx-Map und Sicherungs-Timer. Von Hand geraet spaetestens
# der Port zwischen env-Datei und Map auseinander - und dann sieht ein Kunde
# die Daten eines anderen.
#
# Alle Node-Werkzeuge laufen ueber `runuser -u <dienstbenutzer>`: Ein Zugriff
# als root legt SQLite-Hilfsdateien (-wal, -shm) mit falschem Eigentuemer an,
# und der Dienst startet danach nicht mehr. Die Werkzeuge selbst verweigern
# den Lauf als root; siehe apps/backend/src/scripts/toolkit.ts.

set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ohrganize-lib.sh
. "$HIER/ohrganize-lib.sh"

VORLAGE_ENV="$HIER/ohrganize-kunde.env.example"

# ---------------------------------------------------------------------------
# Pruefungen
# ---------------------------------------------------------------------------
pruefe_umgebung() {
  [[ $EUID -eq 0 ]] || fehler 'Bitte als root ausfuehren (sudo).'
  local werkzeug
  for werkzeug in systemctl install sed curl runuser; do
    command -v "$werkzeug" >/dev/null 2>&1 || fehler "\"$werkzeug\" wird gebraucht, ist aber nicht installiert."
  done
  [[ -r "$VORLAGE_ENV" ]] || fehler "Vorlage $VORLAGE_ENV nicht gefunden (liegt neben diesem Skript)."
  id "$DIENST_BENUTZER" >/dev/null 2>&1 ||
    fehler "Dienstbenutzer \"$DIENST_BENUTZER\" existiert nicht. Anlegen: siehe deploy/README.md, Abschnitt 2."
  [[ -f /etc/systemd/system/ohrganize-backend@.service ]] ||
    fehler 'Vorlage /etc/systemd/system/ohrganize-backend@.service fehlt. Einrichtung: deploy/README.md.'
}

# ---------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------
# releases_auflisten und neuestes_release stehen in ohrganize-lib.sh, damit
# sie sich ohne dieses Skript pruefen lassen (scripts/test-deploy.mjs).

# Portal-Verzeichnis eines Releases (statisches Build des Mitarbeitendenportals).
release_web() { printf '%s/%s/apps/web/dist' "$RELEASE_VERZ" "$1"; }

# ---------------------------------------------------------------------------
# Portvergabe
# ---------------------------------------------------------------------------
# Belegt ist ein Port, wenn er in einer env-Datei steht ODER gerade jemand
# darauf lauscht. Beides pruefen: Die env-Dateien allein uebersehen fremde
# Dienste auf dem Server, die Lauschliste allein uebersieht eine gestoppte
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
  fehler "Im Bereich $PORT_VON bis $PORT_BIS ist kein Port mehr frei."
}

# ---------------------------------------------------------------------------
# anlegen
# ---------------------------------------------------------------------------
anlegen() {
  local kunde='' variante='' release=''
  kunde="${1:-}"
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh anlegen <kunde> [--variante <id>] [--release <ordner>]'
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --variante) variante="${2:-}"; shift 2 ;;
      --release)  release="${2:-}";  shift 2 ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
  done
  pruefe_schluessel "$kunde"
  kunde_vorhanden "$kunde" && fehler "Kunde \"$kunde\" existiert bereits ($ENV_VERZ/$kunde.env)."

  # ---- Release und Variante bestimmen --------------------------------------
  # Beides haengt zusammen: Das Release BESTIMMT die Ausgabe, die env-Datei
  # muss sie nennen, und das Backend prueft beides beim Start gegeneinander.
  if [[ -z "$release" ]]; then
    if [[ -z "$variante" ]]; then
      local verfuegbar
      verfuegbar="$(releases_auflisten | tr '\n' ' ')"
      [[ -n "${verfuegbar// /}" ]] ||
        fehler "Unter $RELEASE_VERZ liegt kein Release. Zuerst eines einspielen (ohrganize-update.sh einspielen <archiv>)."
      fehler "Bitte --variante <id> oder --release <ordner> angeben. Vorhandene Releases: $verfuegbar"
    fi
    release="$(neuestes_release "$variante")"
    [[ -n "$release" ]] ||
      fehler "Kein stabiles Release der Variante \"$variante\" unter $RELEASE_VERZ (eine Beta nur mit --release <ordner>)."
  fi
  [[ -d "$RELEASE_VERZ/$release" ]] || fehler "Release $RELEASE_VERZ/$release existiert nicht."
  local release_var
  release_var="$(release_variante "$RELEASE_VERZ/$release")"
  [[ -n "$release_var" ]] ||
    fehler "In $RELEASE_VERZ/$release fehlt VARIANTE.txt. Stammt das Archiv aus einer aelteren Fassung? Dann die Ausgabe von Hand in die env-Datei eintragen."
  if [[ -n "$variante" && "$variante" != "$release_var" ]]; then
    fehler "Release $release ist die Ausgabe \"$release_var\", angefordert war \"$variante\"."
  fi
  variante="$release_var"

  local domain port
  domain="$kunde.$BASIS_DOMAIN"
  port="$(freier_port)"

  printf 'Lege Kunde "%s" an - %s auf Port %s, Ausgabe %s (Release %s)\n' \
    "$kunde" "$domain" "$port" "$variante" "$release"

  # Ab hier wird geschrieben. Schlaegt etwas fehl, wird alles wieder abgeraeumt:
  # Eine halb angelegte Instanz (env-Datei ohne laufenden Dienst, Map-Eintrag
  # ins Leere) ist schlimmer als gar keine - sie sieht beim naechsten `liste`
  # aus wie ein funktionierender Kunde.
  local aufraeumen=1
  # shellcheck disable=SC2317
  zuruecknehmen() {
    [[ $aufraeumen -eq 1 ]] || return 0
    printf '\nAbbruch - nehme die angefangenen Schritte zurueck.\n' >&2
    systemctl disable --now "ohrganize-backend@$kunde" >/dev/null 2>&1 || true
    systemctl disable --now "ohrganize-backup@$kunde.timer" >/dev/null 2>&1 || true
    map_austragen "$kunde"
    nginx_vorhanden && nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    rm -f "$ENV_VERZ/$kunde.env" "$(kunden_programm "$kunde")" "$WEB_VERZ/kunden/$domain"
    # Das Datenverzeichnis bleibt absichtlich stehen: Falls beim allerersten
    # Start doch schon eine Datenbank entstanden ist, wird sie nicht von einem
    # Fehlerpfad geloescht.
    printf 'Zurueckgenommen. Ein evtl. angelegtes %s/%s bleibt bestehen.\n' "$DATEN_VERZ" "$kunde" >&2
  }
  trap zuruecknehmen EXIT

  schritt "Programm-Symlink $(kunden_programm "$kunde") -> releases/$release"
  install -d -m 0755 "$KUNDEN_VERZ"
  ln -sfn "$RELEASE_VERZ/$release" "$(kunden_programm "$kunde")"

  schritt "Portal-Symlink $WEB_VERZ/kunden/$domain"
  install -d -m 0755 "$WEB_VERZ/kunden"
  [[ -d "$(release_web "$release")" ]] ||
    warnung "$(release_web "$release") fehlt - das Portal dieses Releases ist nicht entpackt."
  ln -sfn "$(release_web "$release")" "$WEB_VERZ/kunden/$domain"

  schritt "Konfiguration $ENV_VERZ/$kunde.env"
  install -d -m 0750 -o root -g "$DIENST_BENUTZER" "$ENV_VERZ"
  sed -e "s/__KUNDE__/$kunde/g" -e "s/__PORT__/$port/g" -e "s/__DOMAIN__/$domain/g" \
    -e "s/__VARIANTE__/$variante/g" \
    "$VORLAGE_ENV" >"$ENV_VERZ/$kunde.env"
  chown root:"$DIENST_BENUTZER" "$ENV_VERZ/$kunde.env"
  chmod 0640 "$ENV_VERZ/$kunde.env"

  schritt "Sicherungsverzeichnis $SICHERUNG_VERZ/$kunde"
  install -d -m 0700 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$SICHERUNG_VERZ"
  install -d -m 0700 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$SICHERUNG_VERZ/$kunde"

  schritt "Dienst ohrganize-backend@$kunde starten"
  systemctl enable --now "ohrganize-backend@$kunde" >/dev/null

  schritt 'Auf Antwort des Backends warten'
  if ! warte_auf_health "$port" 30; then
    printf '\nDie letzten Zeilen aus dem Journal:\n' >&2
    journalctl -u "ohrganize-backend@$kunde" -n 20 --no-pager >&2 || true
    fehler "Das Backend von \"$kunde\" antwortet nach 30 s nicht auf 127.0.0.1:$port."
  fi

  # Gegenprobe am laufenden Dienst: Meldet er eine andere Ausgabe als die
  # env-Datei, zeigt der Symlink woandershin als gedacht. Das Backend selbst
  # bricht bei Abweichung ab, deshalb kann das hier eigentlich nicht mehr
  # passieren - die Zeile ist der Gurt zum Hosenträger.
  local gemeldet
  gemeldet="$(json_feld "$(health_json "$port")" variant id)"
  [[ -z "$gemeldet" || "$gemeldet" == "$variante" ]] ||
    fehler "Der Dienst meldet die Ausgabe \"$gemeldet\", erwartet war \"$variante\"."

  schritt 'Taegliche Sicherung aktivieren'
  systemctl enable --now "ohrganize-backup@$kunde.timer" >/dev/null

  schritt "Subdomain $domain im Reverse-Proxy eintragen"
  map_eintragen "$kunde" "$port"
  nginx_uebernehmen

  aufraeumen=0
  trap - EXIT

  # -------------------------------------------------------------------------
  # Uebergabe
  # -------------------------------------------------------------------------
  printf '\nKunde "%s" ist eingerichtet.\n\n' "$kunde"
  printf '  Portal          https://%s\n' "$domain"
  printf '  Backend         127.0.0.1:%s (nur lokal, erreichbar ueber den Proxy)\n' "$port"
  printf '  Ausgabe         %s (Release %s)\n' "$variante" "$release"
  printf '  Programm        %s -> %s\n' "$(kunden_programm "$kunde")" "$RELEASE_VERZ/$release"
  printf '  Daten           %s/%s\n' "$DATEN_VERZ" "$kunde"
  printf '  Sicherungen     %s/%s (taeglich, 14 Staende)\n' "$SICHERUNG_VERZ" "$kunde"
  printf '  Journal         journalctl -t ohrganize-%s\n\n' "$kunde"
  printf '  Erstanmeldung   ohrganize-provision.sh passwort %s\n' "$kunde"
  printf '  Installations-ID  ohrganize-provision.sh id %s   (fuer die Lizenz)\n\n' "$kunde"
  printf '  Desktop-Arbeitsplaetze dieses Kunden bekommen\n'
  printf '  %%APPDATA%%\\oHRganize\\config.json mit:\n'
  printf '      { "apiBaseUrl": "https://%s" }\n\n' "$domain"
  printf '  Voraussetzung: Der DNS-Eintrag *.%s zeigt auf diesen Server\n' "$BASIS_DOMAIN"
  printf '  und das Wildcard-Zertifikat ist ausgestellt (deploy/README.md).\n'
}

# ---------------------------------------------------------------------------
# liste
# ---------------------------------------------------------------------------
liste() {
  local kunden
  kunden="$(alle_kunden)"
  if [[ -z "$kunden" ]]; then
    printf 'Noch kein Kunde angelegt (%s ist leer).\n' "$ENV_VERZ"
    return 0
  fi
  printf '%-20s %-6s %-9s %-18s %-9s %-10s %s\n' KUNDE PORT DIENST AUSGABE LIZENZ DATENBANK LETZTE-SICHERUNG
  local kunde port zustand groesse sicherung variante lizenz
  while read -r kunde; do
    [[ -n "$kunde" ]] || continue
    port="$(kunden_port "$kunde")"
    zustand="$(systemctl is-active "ohrganize-backend@$kunde" 2>/dev/null || true)"
    variante="$(kunden_variante "$kunde")"
    if [[ -f "$DATEN_VERZ/$kunde/ohrganize.db" ]]; then
      groesse="$(du -h "$DATEN_VERZ/$kunde/ohrganize.db" | cut -f1)"
    else
      groesse='-'
    fi
    lizenz="$(lizenz_zustand "$kunde")"
    # Nur Ordner der Form ohrganize-JJJJMMTT-HHMMSS zaehlen: Im Zielverzeichnis
    # koennen auch temporaere Reste liegen, und `find -type f` nahm frueher
    # jede beliebige Datei als "letzte Sicherung".
    sicherung="$(find "$SICHERUNG_VERZ/$kunde" -mindepth 1 -maxdepth 1 -type d -name 'ohrganize-[0-9]*' -printf '%f\n' 2>/dev/null | sort | tail -1)"
    sicherung="${sicherung#ohrganize-}"
    printf '%-20s %-6s %-9s %-18s %-9s %-10s %s\n' \
      "$kunde" "${port:-?}" "${zustand:-inaktiv}" "${variante:--}" "${lizenz:--}" "$groesse" "${sicherung:0:8}"
  done <<<"$kunden"
}

# Lizenzzustand einer Instanz, kurz (fuer Tabellen). Leer, wenn status.cjs
# fehlt oder die Instanz noch nie gestartet wurde.
lizenz_zustand() {
  local kunde="$1" werk daten json
  werk="$(werkzeug "$kunde" status.cjs)" || return 0
  daten="$(kunden_datenverz "$kunde")"
  [[ -n "$daten" && -f "$daten/ohrganize.db" ]] || return 0
  json="$(als_dienst node "$werk" --data-dir "$daten" --json 2>/dev/null || true)"
  [[ -n "$json" ]] || return 0
  json_feld "$json" license state
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
status() {
  local json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
  done
  local kunden
  kunden="$(alle_kunden)"
  [[ -n "$kunden" ]] || { printf 'Noch kein Kunde angelegt.\n'; return 0; }

  if [[ $json -eq 1 ]]; then
    printf '[\n'
    local erste=1 kunde
    while read -r kunde; do
      [[ -n "$kunde" ]] || continue
      [[ $erste -eq 1 ]] || printf ',\n'
      erste=0
      status_json_eintrag "$kunde"
    done <<<"$kunden"
    printf '\n]\n'
    return 0
  fi

  local kunde
  while read -r kunde; do
    [[ -n "$kunde" ]] || continue
    status_text "$kunde"
    printf '\n'
  done <<<"$kunden"
}

# Ein JSON-Objekt je Kunde: das JSON von status.cjs plus die Angaben, die nur
# der Host kennt (Port, Release, Dienstzustand, Health der laufenden Instanz).
status_json_eintrag() {
  local kunde="$1" daten werk port json health
  daten="$(kunden_datenverz "$kunde")"
  port="$(kunden_port "$kunde")"
  json=''
  if werk="$(werkzeug "$kunde" status.cjs)" && [[ -n "$daten" && -f "$daten/ohrganize.db" ]]; then
    json="$(als_dienst node "$werk" --data-dir "$daten" --json 2>/dev/null || true)"
  fi
  health="$(health_json "$port")"
  printf '  {\n'
  printf '    "kunde": "%s",\n' "$kunde"
  printf '    "domain": "%s.%s",\n' "$kunde" "$BASIS_DOMAIN"
  printf '    "port": %s,\n' "${port:-0}"
  printf '    "dienst": "%s",\n' "$(systemctl is-active "ohrganize-backend@$kunde" 2>/dev/null || echo inaktiv)"
  printf '    "release": "%s",\n' "$(kunden_release "$kunde")"
  printf '    "variante_env": "%s",\n' "$(kunden_variante "$kunde")"
  printf '    "variante_health": "%s",\n' "$(json_feld "$health" variant id)"
  printf '    "version_health": "%s",\n' "$(json_feld "$health" version)"
  printf '    "kanal": "%s",\n' "$(json_feld "$health" channel)"
  # Zahl, kein String: hoechste lesbare Lizenzfassung laut Health (fehlt bei
  # Servern vor Lizenz v2, dann null). conspectus prueft sie vor dem Ausstellen.
  local format
  format="$(printf '%s' "$health" | tr -d '\n' | sed -n 's/.*"license_format"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' | head -1)"
  printf '    "license_format_health": %s,\n' "${format:-null}"
  if [[ -n "$json" ]]; then
    # Das Werkzeug liefert bereits ein Objekt; es wird als Unterobjekt
    # eingehaengt statt neu zusammengesetzt zu werden.
    printf '    "instanz": %s\n' "$json"
  else
    printf '    "instanz": null\n'
  fi
  printf '  }'
}

status_text() {
  local kunde="$1" daten werk port health
  daten="$(kunden_datenverz "$kunde")"
  port="$(kunden_port "$kunde")"
  health="$(health_json "$port")"
  printf '== %s (%s.%s)\n' "$kunde" "$kunde" "$BASIS_DOMAIN"
  printf '   Dienst      %s auf Port %s\n' "$(systemctl is-active "ohrganize-backend@$kunde" 2>/dev/null || echo inaktiv)" "${port:-?}"
  printf '   Release     %s\n' "$(kunden_release "$kunde")"
  printf '   Ausgabe     env=%s  health=%s\n' "$(kunden_variante "$kunde")" "$(json_feld "$health" variant id)"
  printf '   Version     %s (Kanal %s)\n' "$(json_feld "$health" version)" "$(json_feld "$health" channel)"
  if werk="$(werkzeug "$kunde" status.cjs)" && [[ -n "$daten" && -f "$daten/ohrganize.db" ]]; then
    als_dienst node "$werk" --data-dir "$daten" | sed 's/^/   /'
  else
    printf '   (status.cjs nicht im Release oder Instanz noch nie gestartet)\n'
  fi
}

# ---------------------------------------------------------------------------
# id - Installations-ID (die braucht der Anbieter fuer die Lizenz)
# ---------------------------------------------------------------------------
id_zeigen() {
  local kunde="${1:-}"
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh id <kunde>'
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  local daten werk json
  daten="$(kunden_datenverz "$kunde")"
  werk="$(werkzeug "$kunde" status.cjs)" ||
    fehler 'status.cjs fehlt im Release dieser Instanz (aeltere Fassung).'
  [[ -f "$daten/ohrganize.db" ]] || fehler "Die Instanz wurde noch nie gestartet ($daten/ohrganize.db fehlt)."
  json="$(als_dienst node "$werk" --data-dir "$daten" --json)"
  printf '%s\n' "$(json_feld "$json" installation_id)"
}

# ---------------------------------------------------------------------------
# lizenz - signierte Lizenzdatei einspielen
# ---------------------------------------------------------------------------
# Ohne Neustart: Der Server liest die Datei beim naechsten Zugriff neu und
# schreibt einen Audit-Eintrag (license.file_changed). Rechte 0600 und
# Eigentuemer Dienstbenutzer, sonst kann der Dienst sie nicht lesen.
lizenz_einspielen() {
  local kunde="${1:-}" datei="${2:-}"
  [[ -n "$kunde" && -n "$datei" ]] || fehler 'Aufruf: ohrganize-provision.sh lizenz <kunde> <datei>'
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  [[ -r "$datei" ]] || fehler "Lizenzdatei $datei ist nicht lesbar."
  local daten ziel
  daten="$(kunden_datenverz "$kunde")"
  [[ -d "$daten" ]] || fehler "Datenverzeichnis $daten existiert nicht."
  ziel="$daten/lizenz.ohrganize"

  # Erste Zeile grob pruefen, bevor die alte Datei ueberschrieben wird: Der
  # haeufigste Fehler ist die falsche Datei (Angebot statt Lizenz, oder die
  # Lizenz eines anderen Kunden im selben Mailanhang).
  head -c 6 "$datei" | grep -q '^OHRG1' ||
    fehler "$datei beginnt nicht mit OHRG1 - das ist keine oHRganize-Lizenzdatei."

  # Probe VOR dem Einspielen: status.cjs bewertet die neue Datei fuer diese
  # Instanz (Signatur, Bindung, Ausgabe, Laufzeit), ohne etwas zu schreiben.
  # Eine unbrauchbare Datei ersetzte sonst eine gueltige, und die Instanz
  # fiele in den Nur-Lese-Betrieb.
  local werk probe grund probedatei
  if werk="$(werkzeug "$kunde" status.cjs)"; then
    schritt 'Datei fuer diese Instanz pruefen'
    # Kopie, die der Dienstbenutzer lesen darf: Die Datei liegt meist unter
    # /root, und die Probe laeuft wie alle Werkzeuge als Dienstbenutzer.
    probedatei="$(mktemp /tmp/ohrganize-lizenzprobe.XXXXXX)"
    install -m 0600 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$datei" "$probedatei"
    probe="$(als_dienst node "$werk" --data-dir "$daten" --lizenzdatei "$probedatei" --json 2>&1)" ||
      { rm -f "$probedatei"; fehler "Pruefung fehlgeschlagen: $probe"; }
    rm -f "$probedatei"
    grund="$(json_feld "$probe" license invalid_reason)"
    if [[ -n "$grund" ]]; then
      fehler "Die Datei ist fuer diese Instanz unbrauchbar und wurde NICHT eingespielt: $grund"
    fi
    hinweis "Zustand mit dieser Datei: $(json_feld "$probe" license state), $(json_feld "$probe" license headline)"
  fi

  if [[ -f "$ziel" ]]; then
    schritt "Alte Lizenz sichern nach $ziel.alt"
    cp -a "$ziel" "$ziel.alt"
  fi
  schritt "Lizenz nach $ziel schreiben"
  install -m 0600 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$datei" "$ziel"

  printf '\nZustand nach dem Einspielen:\n'
  if [[ -n "$werk" ]]; then
    als_dienst node "$werk" --data-dir "$daten" | sed 's/^/  /'
  else
    printf '  (status.cjs fehlt im Release dieser Instanz)\n'
  fi
  printf '\nEin Neustart ist nicht noetig: Der Server liest die Datei beim naechsten\n'
  printf 'Zugriff neu und vermerkt den Wechsel im Audit-Log (license.file_changed).\n'
}

# ---------------------------------------------------------------------------
# passwort - Initialpasswort zeigen oder Konto zuruecksetzen
# ---------------------------------------------------------------------------
passwort() {
  local kunde="${1:-}" loeschen=0 zuruecksetzen=0 email='admin@ohrganize.de'
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh passwort <kunde> [--loeschen] [--zuruecksetzen] [--email <adresse>]'
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --loeschen)      loeschen=1; shift ;;
      --zuruecksetzen) zuruecksetzen=1; shift ;;
      --email)         email="${2:-}"; shift 2 ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
  done
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  local daten datei
  daten="$(kunden_datenverz "$kunde")"
  datei="$daten/initial-admin-password.txt"

  if [[ $loeschen -eq 1 ]]; then
    [[ -f "$datei" ]] || { printf 'Es liegt keine %s (bereits geloescht oder nie erzeugt).\n' "$datei"; return 0; }
    rm -f "$datei"
    printf 'Geloescht: %s\n' "$datei"
    return 0
  fi

  if [[ $zuruecksetzen -eq 1 ]]; then
    local werk
    werk="$(werkzeug "$kunde" admin-reset.cjs)" ||
      fehler 'admin-reset.cjs fehlt im Release dieser Instanz (aeltere Fassung).'
    als_dienst node "$werk" --data-dir "$daten" --email "$email"
    return 0
  fi

  if [[ -r "$datei" ]]; then
    printf 'Erstanmeldung fuer %s:\n' "$kunde"
    printf '  Benutzer: admin@ohrganize.de\n'
    printf '  Passwort: %s\n' "$(cat "$datei")"
    printf '  Wird beim ersten Login zwingend geaendert.\n'
    printf '  Danach loeschen: ohrganize-provision.sh passwort %s --loeschen\n' "$kunde"
    return 0
  fi

  printf 'Es liegt keine %s.\n' "$datei"
  printf 'Entweder wurde sie bereits geloescht oder das Konto ist eingerichtet.\n'
  printf 'Kommt niemand mehr hinein:\n'
  printf '  ohrganize-provision.sh passwort %s --zuruecksetzen [--email <adresse>]\n' "$kunde"
}

# ---------------------------------------------------------------------------
# pin - SPKI-Pin des Zertifikats (fuer die Desktop-Arbeitsplaetze)
# ---------------------------------------------------------------------------
# Die Desktop-App kann den Serverschluessel festnageln (config.json). Der Pin
# ist der base64-kodierte SHA-256 des SubjectPublicKeyInfo - derselbe Wert,
# den deploy/nginx.conf im Kommentar nennt. Er haengt am SCHLUESSEL, nicht am
# Zertifikat: Bei einer Erneuerung mit --reuse-key bleibt er gleich.
pin() {
  local pfad="${1:-/etc/letsencrypt/live/$BASIS_DOMAIN/fullchain.pem}"
  [[ -r "$pfad" ]] || fehler "Zertifikat $pfad ist nicht lesbar (Pfad als Argument uebergeben)."
  command -v openssl >/dev/null 2>&1 || fehler 'openssl wird gebraucht, ist aber nicht installiert.'
  local wert
  wert="$(openssl x509 -in "$pfad" -pubkey -noout |
    openssl pkey -pubin -outform der |
    openssl dgst -sha256 -binary |
    openssl enc -base64)"
  printf 'SPKI-Pin von %s\n' "$pfad"
  printf '  sha256/%s\n\n' "$wert"
  printf 'In %%APPDATA%%\\oHRganize\\config.json der Arbeitsplaetze:\n'
  printf '  { "apiBaseUrl": "https://<kunde>.%s", "pin": "sha256/%s" }\n\n' "$BASIS_DOMAIN" "$wert"
  printf 'Achtung: Der Pin haengt am Schluessel. Eine Erneuerung ohne --reuse-key\n'
  printf 'erzeugt einen neuen Schluessel und sperrt alle Arbeitsplaetze aus.\n'
}

# ---------------------------------------------------------------------------
# pausieren / fortsetzen
# ---------------------------------------------------------------------------
# Fuer Wartung und fuer den Fall, dass ein Kunde vorruebergehend stillgelegt
# wird (offene Rechnung, Vertragspause). Die Daten bleiben; der Proxy liefert
# die Wartungsseite aus (error_page 502/503 in nginx-wildcard.conf).
pausieren() {
  local kunde="${1:-}"
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh pausieren <kunde>'
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  schritt "Dienst und Sicherungs-Timer von \"$kunde\" anhalten"
  systemctl stop "ohrganize-backend@$kunde" || true
  systemctl stop "ohrganize-backup@$kunde.timer" || true
  printf 'Kunde "%s" ist pausiert. Daten und Konfiguration bleiben unveraendert.\n' "$kunde"
  printf 'Der Proxy liefert bis zum Fortsetzen die Wartungsseite aus.\n'
  printf 'Fortsetzen: ohrganize-provision.sh fortsetzen %s\n' "$kunde"
}

fortsetzen() {
  local kunde="${1:-}"
  [[ -n "$kunde" ]] || fehler 'Aufruf: ohrganize-provision.sh fortsetzen <kunde>'
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  schritt "Dienst von \"$kunde\" starten"
  systemctl start "ohrganize-backend@$kunde"
  systemctl start "ohrganize-backup@$kunde.timer" || true
  local port
  port="$(kunden_port "$kunde")"
  if warte_auf_health "$port" 30; then
    printf 'Kunde "%s" laeuft wieder (127.0.0.1:%s).\n' "$kunde" "$port"
  else
    journalctl -u "ohrganize-backend@$kunde" -n 20 --no-pager >&2 || true
    fehler "Das Backend von \"$kunde\" antwortet nach 30 s nicht."
  fi
}

# ---------------------------------------------------------------------------
# restore
# ---------------------------------------------------------------------------
# Der Weg, den das MANIFEST jeder Sicherung nennt. Er macht genau das, was
# sonst von Hand schiefgeht: Dienst stoppen, ALTEN Stand wegsichern statt
# ueberschreiben, kopieren, Rechte nachziehen, starten, Zustand zeigen.
restore() {
  local kunde="${1:-}" ordner="${2:-}" ja=0
  [[ -n "$kunde" && -n "$ordner" ]] || fehler 'Aufruf: ohrganize-provision.sh restore <kunde> <sicherungsordner> [--ja]'
  shift 2 || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ja) ja=1; shift ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
  done
  kunde_vorhanden "$kunde" || fehler "Kunde \"$kunde\" ist nicht angelegt."
  [[ -d "$ordner" ]] || fehler "Sicherungsordner $ordner existiert nicht."
  [[ -f "$ordner/ohrganize.db" ]] || fehler "In $ordner liegt keine ohrganize.db."

  local daten
  daten="$(kunden_datenverz "$kunde")"
  [[ -n "$daten" ]] || fehler "In $ENV_VERZ/$kunde.env steht kein OHRGANIZE_DATA_DIR."

  printf 'Restore fuer Kunde "%s"\n' "$kunde"
  printf '  Quelle: %s\n' "$ordner"
  printf '  Ziel:   %s (der jetzige Stand wird nach %s.alt-<zeit> verschoben)\n' "$daten" "$daten"
  if [[ $ja -eq 1 ]]; then
    # --ja ist fuer skriptierte Ablaeufe ohne Terminal (conspectus ueber ssh);
    # von Hand bleibt die Rueckfrage der Schutz gegen den falschen Kunden.
    hinweis 'Rueckfrage uebersprungen (--ja).'
  else
    [[ -t 0 ]] || fehler 'restore verlangt eine Rueckfrage und damit ein Terminal (oder --ja fuer Skripte).'
    printf 'Zum Bestaetigen den Kundenschluessel eintippen: '
    local antwort
    read -r antwort
    [[ "$antwort" == "$kunde" ]] || fehler 'Eingabe stimmt nicht ueberein - nichts geaendert.'
  fi

  schritt 'Dienst anhalten'
  systemctl stop "ohrganize-backend@$kunde" || true

  local weg
  weg="$daten.alt-$(date +%Y%m%d-%H%M%S)"
  schritt "Jetzigen Stand nach $weg verschieben"
  mv "$daten" "$weg"
  install -d -m 0700 -o "$DIENST_BENUTZER" -g "$DIENST_BENUTZER" "$daten"

  schritt 'Datenbank, storage/, secret.key und Lizenz einspielen'
  cp -a "$ordner/ohrganize.db" "$daten/"
  [[ -d "$ordner/storage" ]] && cp -a "$ordner/storage" "$daten/"
  [[ -f "$ordner/secret.key" ]] && cp -a "$ordner/secret.key" "$daten/"
  [[ -f "$ordner/lizenz.ohrganize" ]] && cp -a "$ordner/lizenz.ohrganize" "$daten/"
  # -wal und -shm gehoeren NICHT dazu: Die Sicherung enthaelt einen in sich
  # geschlossenen Stand (Online-Backup-API). Eine mitkopierte -wal aus einem
  # anderen Lauf ueberschriebe ihn beim ersten Oeffnen.
  rm -f "$daten/ohrganize.db-wal" "$daten/ohrganize.db-shm"

  schritt 'Rechte nachziehen'
  chown -R "$DIENST_BENUTZER":"$DIENST_BENUTZER" "$daten"
  chmod -R go-rwx "$daten"

  schritt 'Dienst starten'
  systemctl start "ohrganize-backend@$kunde"
  local port
  port="$(kunden_port "$kunde")"
  if ! warte_auf_health "$port" 30; then
    journalctl -u "ohrganize-backend@$kunde" -n 30 --no-pager >&2 || true
    fehler "Nach dem Restore antwortet \"$kunde\" nicht. Der alte Stand liegt unter $weg."
  fi

  printf '\nRestore abgeschlossen.\n'
  printf '  Alter Stand: %s (nach der Kontrolle loeschen)\n\n' "$weg"
  local werk
  if werk="$(werkzeug "$kunde" status.cjs)"; then
    als_dienst node "$werk" --data-dir "$daten" | sed 's/^/  /'
  fi
  printf '\nWurde seit dieser Sicherung eine NEUERE Lizenz eingespielt, jetzt erneut\n'
  printf 'ablegen: ohrganize-provision.sh lizenz %s <datei>\n' "$kunde"
}

# ---------------------------------------------------------------------------
# check - stille Abweichungen finden, bevor sie auffallen
# ---------------------------------------------------------------------------
check() {
  local befunde=0
  meld() { printf '  BEFUND  %s\n' "$*"; befunde=$((befunde + 1)); }
  ok()   { printf '  ok      %s\n' "$*"; }

  printf 'Pruefe Einrichtung ...\n'

  # Symlink-Ziele und Ausgaben
  local kunde ziel release_var env_var port health health_var daten
  while read -r kunde; do
    [[ -n "$kunde" ]] || continue
    ziel="$(readlink -f "$(kunden_programm "$kunde")" 2>/dev/null || true)"
    if [[ -z "$ziel" || ! -d "$ziel" ]]; then
      meld "$kunde: Programm-Symlink $(kunden_programm "$kunde") zeigt ins Leere."
      continue
    fi
    release_var="$(release_variante "$ziel")"
    env_var="$(kunden_variante "$kunde")"
    port="$(kunden_port "$kunde")"
    health="$(health_json "$port")"
    health_var="$(json_feld "$health" variant id)"
    if [[ -z "$env_var" ]]; then
      meld "$kunde: In der env-Datei fehlt OHRGANIZE_VARIANT."
    elif [[ -n "$release_var" && "$release_var" != "$env_var" ]]; then
      meld "$kunde: Release ist \"$release_var\", env-Datei sagt \"$env_var\"."
    elif [[ -n "$health_var" && "$health_var" != "$env_var" ]]; then
      meld "$kunde: Dienst meldet \"$health_var\", env-Datei sagt \"$env_var\"."
    else
      ok "$kunde: Ausgabe $env_var, Release $(basename "$ziel")"
    fi

    # Port gegen die nginx-Map
    if [[ -f "$MAP_DATEI" ]]; then
      local map_port
      map_port="$(sed -n "s/^$kunde\.$BASIS_DOMAIN[[:space:]]\+127\.0\.0\.1:\([0-9]\+\);.*/\1/p" "$MAP_DATEI" | head -1)"
      if [[ -z "$map_port" ]]; then
        meld "$kunde: kein Eintrag in $MAP_DATEI."
      elif [[ "$map_port" != "$port" ]]; then
        meld "$kunde: Map zeigt auf Port $map_port, env-Datei sagt $port. Ein Kunde landet damit auf fremden Daten."
      fi
    fi

    # Portal-Symlink
    if [[ ! -e "$WEB_VERZ/kunden/$kunde.$BASIS_DOMAIN" ]]; then
      meld "$kunde: Portal-Symlink $WEB_VERZ/kunden/$kunde.$BASIS_DOMAIN fehlt."
    fi

    # Sicherung juenger als zwei Tage
    local letzte alter
    letzte="$(find "$SICHERUNG_VERZ/$kunde" -mindepth 1 -maxdepth 1 -type d -name 'ohrganize-[0-9]*' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1)"
    if [[ -z "$letzte" ]]; then
      meld "$kunde: keine Sicherung unter $SICHERUNG_VERZ/$kunde."
    else
      # %T@ liefert Sekunden mit Nachkommastellen; Bash rechnet nur ganzzahlig.
      local zeit="${letzte%% *}"
      zeit="${zeit%%.*}"
      alter=$(( ( $(date +%s) - zeit ) / 86400 ))
      [[ $alter -le 2 ]] || meld "$kunde: juengste Sicherung ist $alter Tage alt (${letzte#* })."
    fi

    # Lizenz
    daten="$(kunden_datenverz "$kunde")"
    local zustand
    zustand="$(lizenz_zustand "$kunde")"
    case "$zustand" in
      expired) meld "$kunde: Lizenz abgelaufen, die Instanz laeuft im Nur-Lese-Betrieb." ;;
      grace)   meld "$kunde: Lizenz abgelaufen, Kulanzfrist laeuft." ;;
      '')      : ;;
      *)       ok "$kunde: Lizenzzustand $zustand" ;;
    esac
  done <<<"$(alle_kunden)"

  # Platz auf den Datentraegern
  local frei
  for pfad in "$DATEN_VERZ" "$SICHERUNG_VERZ" "$RELEASE_VERZ"; do
    [[ -d "$pfad" ]] || continue
    frei="$(df -P "$pfad" | awk 'NR==2 {print $5}' | tr -d '%')"
    if [[ -n "$frei" && "$frei" -ge 90 ]]; then
      meld "$pfad: Datentraeger zu $frei Prozent belegt."
    else
      ok "$pfad: Datentraeger zu ${frei:-?} Prozent belegt."
    fi
  done

  # Units
  if command -v systemd-analyze >/dev/null 2>&1; then
    local unit
    for unit in ohrganize-backend@.service ohrganize-backup@.service; do
      if [[ -f "/etc/systemd/system/$unit" ]]; then
        if systemd-analyze verify "/etc/systemd/system/$unit" 2>&1 | grep -q .; then
          meld "$unit: systemd-analyze verify meldet etwas (Ausgabe pruefen)."
        else
          ok "$unit: systemd-analyze verify ohne Befund."
        fi
      fi
    done
  fi

  printf '\n'
  if [[ $befunde -eq 0 ]]; then
    printf 'Kein Befund.\n'
    return 0
  fi
  printf '%s Befund(e).\n' "$befunde"
  return 1
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

  # Die Rueckfrage steht VOR dem ersten Eingriff. Stuende sie erst vor dem
  # Loeschen, waeren Dienst, Konfiguration und Subdomain beim Abbrechen schon
  # weg: Der Kunde waere offline, obwohl gerade "nein" gesagt wurde, und
  # muesste neu angelegt werden. (Im Testlauf genau so passiert.)
  if [[ $loeschen -eq 1 ]]; then
    [[ -t 0 ]] || fehler '--daten-loeschen verlangt eine Rueckfrage und damit ein Terminal.'
    printf 'Es werden UNWIDERRUFLICH geloescht:\n'
    printf '  %s/%s (Datenbank, hochgeladene Dateien, Secret)\n' "$DATEN_VERZ" "$kunde"
    printf '  %s/%s (alle Sicherungen)\n' "$SICHERUNG_VERZ" "$kunde"
    printf 'Zum Bestaetigen den Kundenschluessel eintippen: '
    local antwort
    read -r antwort
    [[ "$antwort" == "$kunde" ]] || fehler 'Eingabe stimmt nicht ueberein - nichts geaendert.'
  fi

  printf 'Entferne Kunde "%s".\n' "$kunde"
  schritt 'Subdomain aus dem Reverse-Proxy nehmen'
  map_austragen "$kunde"
  nginx_uebernehmen

  schritt 'Dienst und Sicherungs-Timer stoppen'
  systemctl disable --now "ohrganize-backup@$kunde.timer" >/dev/null 2>&1 || true
  systemctl disable --now "ohrganize-backend@$kunde" >/dev/null 2>&1 || true

  schritt 'Symlinks und Konfiguration entfernen'
  rm -f "$(kunden_programm "$kunde")" "$WEB_VERZ/kunden/$kunde.$BASIS_DOMAIN"
  rm -f "$ENV_VERZ/$kunde.env"

  if [[ $loeschen -eq 0 ]]; then
    printf '\nDaten und Sicherungen bleiben liegen:\n'
    printf '  %s/%s\n  %s/%s\n' "$DATEN_VERZ" "$kunde" "$SICHERUNG_VERZ" "$kunde"
    printf 'Das ist Absicht: In der Datenbank stehen Personalakten, deren\n'
    printf 'Aufbewahrungsfristen den Vertrag ueberdauern koennen. Erst loeschen,\n'
    printf 'wenn die Uebergabe an den Kunden bestaetigt ist - dann mit\n'
    printf '  %s entfernen %s --daten-loeschen\n' "${BASH_SOURCE[0]}" "$kunde"
    printf 'Ein spaeteres "anlegen %s" nimmt die liegen gebliebenen Daten wieder auf.\n' "$kunde"
    return 0
  fi

  schritt 'Daten und Sicherungen loeschen'
  rm -rf "${DATEN_VERZ:?}/$kunde" "${SICHERUNG_VERZ:?}/$kunde"
  printf 'Kunde "%s" samt Daten geloescht.\n' "$kunde"
}

# ---------------------------------------------------------------------------
# Hilfe
# ---------------------------------------------------------------------------
hilfe() {
  cat <<HILFE
oHRganize - Kundeninstanzen verwalten

  anlegen <kunde> [--variante <id>] [--release <ordner>]
                                     Neue Instanz: Programm- und Portal-Symlink,
                                     env-Datei, Dienst, Sicherung, Subdomain
                                     <kunde>.$BASIS_DOMAIN
  liste                              Alle Kunden: Port, Dienst, Ausgabe, Lizenz,
                                     DB-Groesse, letzte Sicherung
  status [--json]                    Ausfuehrlicher Zustand je Instanz
                                     (Lizenz, Plaetze, Migrationen, Health)
  id <kunde>                         Installations-ID (fuer die Lizenz)
  lizenz <kunde> <datei>             Lizenzdatei einspielen (ohne Neustart)
  passwort <kunde> [--loeschen]      Initialpasswort zeigen bzw. Datei loeschen
  passwort <kunde> --zuruecksetzen [--email <adresse>]
                                     Passwort eines Kontos neu setzen
  pin [<fullchain.pem>]              SPKI-Pin fuer config.json der Arbeitsplaetze
  pausieren <kunde>                  Instanz anhalten (Wartungsseite im Proxy)
  fortsetzen <kunde>                 Instanz wieder starten
  restore <kunde> <ordner>           Sicherung zurueckspielen (mit Rueckfrage)
  check                              Stille Abweichungen suchen (Symlinks,
                                     Ausgaben, Ports, Sicherungen, Platz, Units)
  entfernen <kunde> [--daten-loeschen]
                                     Instanz abschalten; Daten bleiben, sofern
                                     nicht ausdruecklich geloescht

Updates: ohrganize-update.sh (Archiv pruefen, einspielen, Instanzen umstellen)

Einstellungen (ueberschreibbar in /etc/ohrganize/provision.conf):
  BASIS_DOMAIN=$BASIS_DOMAIN
  PORT_VON=$PORT_VON  PORT_BIS=$PORT_BIS
  RELEASE_VERZ=$RELEASE_VERZ
  KUNDEN_VERZ=$KUNDEN_VERZ
  WEB_VERZ=$WEB_VERZ
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
  anlegen)    pruefe_umgebung; anlegen "$@" ;;
  liste)      liste "$@" ;;
  status)     pruefe_umgebung; status "$@" ;;
  id)         pruefe_umgebung; id_zeigen "$@" ;;
  lizenz)     pruefe_umgebung; lizenz_einspielen "$@" ;;
  passwort)   pruefe_umgebung; passwort "$@" ;;
  pin)        pin "$@" ;;
  pausieren)  pruefe_umgebung; pausieren "$@" ;;
  fortsetzen) pruefe_umgebung; fortsetzen "$@" ;;
  restore)    pruefe_umgebung; restore "$@" ;;
  check)      pruefe_umgebung; check "$@" ;;
  entfernen)  pruefe_umgebung; entfernen "$@" ;;
  hilfe|-h|--help) hilfe ;;
  *) printf 'Unbekannter Befehl: %s\n\n' "$befehl" >&2; hilfe >&2; exit 1 ;;
esac
