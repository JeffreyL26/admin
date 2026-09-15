#!/usr/bin/env bash
#
# oHRganize - Release einspielen und Instanzen umstellen
#
# Ablage:  /opt/ohrganize/deploy/ohrganize-update.sh
# Aufruf:  sudo /opt/ohrganize/deploy/ohrganize-update.sh einspielen /pfad/archiv.zip
#          sudo /opt/ohrganize/deploy/ohrganize-update.sh umstellen de-vollversion-1.1.0
#          sudo /opt/ohrganize/deploy/ohrganize-update.sh update /pfad/archiv.zip
#
# "update" ist beides nacheinander und der uebliche Weg.
#
# Was dieses Skript gegen den Weg von Hand kann:
#   1. Es prueft die Pruefsumme UND, wenn vorhanden, die Signatur des
#      Anbieters, BEVOR irgendetwas entpackt wird.
#   2. Es prueft die Ausgabe (Land x Edition) des Archivs gegen die env-Datei
#      JEDER betroffenen Instanz und gegen das, was ihr laufender Dienst unter
#      /api/health meldet. Ein Archiv der falschen Ausgabe kommt nicht durch.
#   3. Es macht einen Migrations-PROBELAUF auf einer Kopie der Datenbank. Ein
#      Schema, das nicht durchlaeuft, faellt auf, waehrend der Kunde noch
#      laeuft, statt beim Start des neuen Dienstes.
#   4. Es stellt Instanz fuer Instanz um (Sicherung, stop, Symlink, start,
#      Health) und nimmt eine misslungene Instanz sofort zurueck, ohne die
#      uebrigen anzuhalten.
#
# Der Rueckweg ist der Symlink: /opt/ohrganize/kunden/<kunde> zeigt wieder auf
# das vorherige Release. Nur wenn die neue Fassung die Datenbank bereits
# migriert hat, reicht das nicht - dann wird die Sicherung von eben
# zurueckgespielt (das Backend erkennt den Fall und startet gar nicht erst).

set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ohrganize-lib.sh
. "$HIER/ohrganize-lib.sh"

SIGNIERER_DATEI="${OHRGANIZE_SIGNIERER_DATEI:-$HIER/ohrganize-release.allowed_signers}"
SIGNIERER_KENNUNG="${OHRGANIZE_SIGNIERER_KENNUNG:-release@ohrganize}"
SIGNATUR_NAMENSRAUM='ohrganize-release'

pruefe_umgebung() {
  [[ $EUID -eq 0 ]] || fehler 'Bitte als root ausfuehren (sudo).'
  local werkzeug
  for werkzeug in systemctl install unzip runuser curl; do
    command -v "$werkzeug" >/dev/null 2>&1 || fehler "\"$werkzeug\" wird gebraucht, ist aber nicht installiert."
  done
}

# ---------------------------------------------------------------------------
# Archiv pruefen und entpacken
# ---------------------------------------------------------------------------
pruefe_pruefsumme() {
  local archiv="$1" summe="$archiv.sha256"
  if [[ ! -r "$summe" ]]; then
    warnung "Keine $summe neben dem Archiv - Pruefsumme nicht geprueft."
    return 0
  fi
  command -v sha256sum >/dev/null 2>&1 || { warnung 'sha256sum fehlt - Pruefsumme nicht geprueft.'; return 0; }
  # Die .sha256 nennt nur den Dateinamen; sha256sum -c sucht ihn im AKTUELLEN
  # Verzeichnis. Deshalb in das Verzeichnis des Archivs wechseln, sonst meldet
  # es "No such file" und FAILED, obwohl alles in Ordnung ist.
  ( cd "$(dirname "$archiv")" && sha256sum -c "$(basename "$summe")" >/dev/null ) ||
    fehler "Pruefsumme von $archiv stimmt nicht. Archiv verwerfen und neu holen."
  schritt 'Pruefsumme stimmt'
}

pruefe_signatur() {
  local archiv="$1" verz manifest signatur
  verz="$(dirname "$archiv")"
  manifest="$verz/release.json"
  signatur="$verz/release.json.sig"
  if [[ ! -r "$manifest" || ! -r "$signatur" ]]; then
    warnung 'Kein release.json samt release.json.sig neben dem Archiv - Signatur nicht geprueft.'
    return 0
  fi
  command -v ssh-keygen >/dev/null 2>&1 || {
    warnung 'ssh-keygen fehlt (Paket openssh-client) - Signatur nicht geprueft.'
    return 0
  }
  [[ -r "$SIGNIERER_DATEI" ]] || {
    warnung "$SIGNIERER_DATEI fehlt - Signatur nicht geprueft."
    return 0
  }
  # Eine Datei ohne echten Schluesseleintrag (nur Kommentare) wuerde jede
  # Signatur ablehnen; das waere hier ein falscher Alarm.
  grep -qv '^[[:space:]]*\(#.*\)\?$' "$SIGNIERER_DATEI" || {
    warnung "In $SIGNIERER_DATEI steht noch kein Schluessel - Signatur nicht geprueft."
    return 0
  }
  ssh-keygen -Y verify -f "$SIGNIERER_DATEI" -I "$SIGNIERER_KENNUNG" \
    -n "$SIGNATUR_NAMENSRAUM" -s "$signatur" <"$manifest" >/dev/null ||
    fehler 'Die Signatur des Release-Manifests ist ungueltig. Archiv NICHT einspielen.'
  schritt 'Signatur des Anbieters stimmt'

  # Pruefsumme des Archivs gegen das signierte Manifest: Erst damit haengt das
  # Archiv wirklich an der Signatur (das Manifest signiert die Pruefsummen).
  local erwartet tatsaechlich
  erwartet="$(sed -n "s/.*\"file\"[[:space:]]*:[[:space:]]*\"$(basename "$archiv")\"[^}]*\"sha256\"[[:space:]]*:[[:space:]]*\"\([0-9a-f]*\)\".*/\1/p" "$manifest" | head -1)"
  if [[ -z "$erwartet" ]]; then
    # Mehrzeiliges JSON: Datei und Pruefsumme stehen in getrennten Zeilen.
    erwartet="$(tr -d '\n ' <"$manifest" | sed -n "s/.*\"file\":\"$(basename "$archiv")\",\"sha256\":\"\([0-9a-f]*\)\".*/\1/p")"
  fi
  if [[ -n "$erwartet" ]] && command -v sha256sum >/dev/null 2>&1; then
    tatsaechlich="$(sha256sum "$archiv" | awk '{print $1}')"
    [[ "$erwartet" == "$tatsaechlich" ]] ||
      fehler "Die Pruefsumme des Archivs steht nicht im signierten Manifest. Archiv NICHT einspielen."
    schritt 'Archiv steht im signierten Manifest'
  fi
}

# Variante aus dem Archiv lesen, ohne es an seinen Zielort zu entpacken.
archiv_variante() {
  unzip -p "$1" VARIANTE.txt 2>/dev/null | tr -d '[:space:]'
}

archiv_version() {
  local archiv="$1" json
  json="$(unzip -p "$archiv" release.json 2>/dev/null || true)"
  [[ -n "$json" ]] && json_feld "$json" version
}

# ---------------------------------------------------------------------------
# einspielen: Archiv nach releases/<variante>-<version> entpacken
# ---------------------------------------------------------------------------
einspielen() {
  local archiv="${1:-}"
  [[ -n "$archiv" ]] || fehler 'Aufruf: ohrganize-update.sh einspielen <archiv.zip>'
  [[ -r "$archiv" ]] || fehler "Archiv $archiv ist nicht lesbar."

  printf 'Pruefe %s\n' "$archiv"
  pruefe_pruefsumme "$archiv"
  pruefe_signatur "$archiv"

  local variante version
  variante="$(archiv_variante "$archiv")"
  version="$(archiv_version "$archiv")"
  [[ -n "$variante" ]] ||
    fehler "Im Archiv fehlt VARIANTE.txt. Ein Archiv ohne Ausgabe wird nicht eingespielt - der Kunde liefe sonst still mit fremdem Funktionsumfang."
  [[ -n "$version" ]] || fehler 'Im Archiv fehlt release.json (oder es nennt keine version).'
  schritt "Ausgabe $variante, Version $version"

  local ziel="$RELEASE_VERZ/$variante-$version"
  if [[ -d "$ziel" ]]; then
    warnung "$ziel existiert bereits - wird ueberschrieben (die Instanzen bleiben so lange auf ihrem Symlink)."
  fi
  install -d -m 0755 "$RELEASE_VERZ"
  # In ein temporaeres Verzeichnis entpacken und erst danach umbenennen: Ein
  # abgebrochenes Entpacken darf kein halbes Release hinterlassen, auf das
  # jemand einen Symlink setzt.
  local tmp="$RELEASE_VERZ/.tmp-$variante-$version.$$"
  rm -rf "$tmp"
  install -d -m 0755 "$tmp"
  schritt "Entpacke nach $ziel"
  unzip -q -o "$archiv" -d "$tmp"

  # Gegenprobe im entpackten Stand: Ein Archiv, dessen VARIANTE.txt nicht zu
  # dem passt, was wir gelesen haben, ist manipuliert oder kaputt.
  [[ "$(release_variante "$tmp")" == "$variante" ]] ||
    { rm -rf "$tmp"; fehler 'Die VARIANTE.txt im entpackten Stand passt nicht zum Archiv.'; }

  schritt 'Laufzeitabhaengigkeit installieren (npm ci --omit=dev)'
  ( cd "$tmp" && npm ci --omit=dev >/dev/null ) ||
    { rm -rf "$tmp"; fehler 'npm ci --omit=dev ist fehlgeschlagen.'; }

  schritt 'better-sqlite3 laedt (Bindung vorhanden)'
  # Ein blosses require() laedt die native Bindung noch nicht; erst `new`
  # zeigt, ob sie da ist. Genau daran ist frueher ein scheinbar erfolgreiches
  # npm ci aufgefallen (siehe CLAUDE.md, allowScripts).
  ( cd "$tmp" && node -e "new (require('better-sqlite3'))(':memory:')" ) ||
    { rm -rf "$tmp"; fehler 'better-sqlite3 laedt nicht. Build-Werkzeuge fehlen? Siehe deploy/README.md, Abschnitt 1.'; }

  rm -rf "$ziel"
  mv "$tmp" "$ziel"
  chown -R root:root "$ziel"
  printf '\nRelease eingespielt: %s\n' "$ziel"
  printf 'Umstellen der Instanzen: ohrganize-update.sh umstellen %s-%s\n' "$variante" "$version"
}

# ---------------------------------------------------------------------------
# umstellen: Instanzen auf ein eingespieltes Release umhaengen
# ---------------------------------------------------------------------------
umstellen() {
  local release="${1:-}" nur='' probelauf=0
  [[ -n "$release" ]] || fehler 'Aufruf: ohrganize-update.sh umstellen <release> [--kunde <kunde>] [--probelauf]'
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kunde)     nur="${2:-}"; shift 2 ;;
      --probelauf) probelauf=1; shift ;;
      *) fehler "Unbekannte Option: $1" ;;
    esac
  done
  local verz="$RELEASE_VERZ/$release"
  [[ -d "$verz" ]] || fehler "Release $verz existiert nicht (zuerst einspielen)."
  local variante
  variante="$(release_variante "$verz")"
  [[ -n "$variante" ]] || fehler "In $verz fehlt VARIANTE.txt."

  local kunden
  if [[ -n "$nur" ]]; then
    kunde_vorhanden "$nur" || fehler "Kunde \"$nur\" ist nicht angelegt."
    kunden="$nur"
  else
    kunden="$(alle_kunden)"
  fi
  [[ -n "$kunden" ]] || { printf 'Keine Instanz zum Umstellen.\n'; return 0; }

  printf 'Release %s (Ausgabe %s)\n' "$release" "$variante"
  local kunde env_var betroffen=()
  while read -r kunde; do
    [[ -n "$kunde" ]] || continue
    env_var="$(kunden_variante "$kunde")"
    if [[ -z "$env_var" ]]; then
      warnung "$kunde: In der env-Datei fehlt OHRGANIZE_VARIANT - wird uebersprungen."
      continue
    fi
    if [[ "$env_var" != "$variante" ]]; then
      printf '  uebersprungen  %s (Ausgabe %s)\n' "$kunde" "$env_var"
      continue
    fi
    betroffen+=("$kunde")
  done <<<"$kunden"

  [[ ${#betroffen[@]} -gt 0 ]] || { printf 'Keine Instanz dieser Ausgabe.\n'; return 0; }
  printf '  betroffen      %s\n\n' "${betroffen[*]}"

  # ---- Migrations-Probelauf auf einer Kopie, bevor irgendetwas stoppt ------
  local pruef="$verz/apps/backend/dist/migrate-check.cjs"
  if [[ -f "$pruef" ]]; then
    printf 'Migrations-Probelauf (auf Kopien, die Kundendatenbanken bleiben unberuehrt):\n'
    local daten fehlgeschlagen=()
    for kunde in "${betroffen[@]}"; do
      daten="$(kunden_datenverz "$kunde")"
      [[ -f "$daten/ohrganize.db" ]] || { printf '  uebersprungen  %s (noch keine Datenbank)\n' "$kunde"; continue; }
      if als_dienst node "$pruef" --db "$daten/ohrganize.db" >/dev/null 2>&1; then
        printf '  ok             %s\n' "$kunde"
      else
        printf '  FEHLER         %s\n' "$kunde"
        als_dienst node "$pruef" --db "$daten/ohrganize.db" 2>&1 | sed 's/^/                 /' || true
        fehlgeschlagen+=("$kunde")
      fi
    done
    if [[ ${#fehlgeschlagen[@]} -gt 0 ]]; then
      fehler "Der Probelauf scheitert bei: ${fehlgeschlagen[*]}. Es wurde nichts umgestellt."
    fi
    printf '\n'
  else
    warnung "migrate-check.cjs fehlt in $release - kein Probelauf moeglich (aelteres Release)."
  fi

  if [[ $probelauf -eq 1 ]]; then
    printf 'Probelauf beendet. Es wurde nichts umgestellt.\n'
    return 0
  fi

  # ---- Instanz fuer Instanz ------------------------------------------------
  local fehler_kunden=()
  for kunde in "${betroffen[@]}"; do
    printf '== %s\n' "$kunde"
    instanz_umstellen "$kunde" "$release" || fehler_kunden+=("$kunde")
    printf '\n'
  done

  if [[ ${#fehler_kunden[@]} -gt 0 ]]; then
    printf 'Nicht umgestellt: %s\n' "${fehler_kunden[*]}"
    printf 'Diese Instanzen laufen auf ihrem alten Release weiter; die Markerdatei\n'
    printf '%s/<kunde>/.update-fehlgeschlagen nennt den Zeitpunkt.\n' "$DATEN_VERZ"
    return 1
  fi
  printf 'Alle Instanzen laufen auf %s.\n' "$release"
}

instanz_umstellen() {
  local kunde="$1" release="$2"
  local link daten port alt sicherung
  link="$(kunden_programm "$kunde")"
  daten="$(kunden_datenverz "$kunde")"
  port="$(kunden_port "$kunde")"
  alt="$(readlink -f "$link" 2>/dev/null || true)"

  schritt 'Sicherung vor dem Update'
  if ! systemctl start "ohrganize-backup@$kunde.service"; then
    warnung "$kunde: Die Sicherung ist fehlgeschlagen. Ohne sie gibt es keinen Rueckweg aus einer Migration."
    return 1
  fi
  sicherung="$(find "$SICHERUNG_VERZ/$kunde" -mindepth 1 -maxdepth 1 -type d -name 'ohrganize-[0-9]*' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)"
  sicherung="${sicherung#* }"
  [[ -n "$sicherung" ]] || { warnung "$kunde: Keine Sicherung gefunden."; return 1; }
  hinweis "Sicherung: $sicherung"

  schritt 'Dienst anhalten'
  systemctl stop "ohrganize-backend@$kunde" || true

  schritt "Symlink auf $release setzen"
  ln -sfn "$RELEASE_VERZ/$release" "$link"
  ln -sfn "$RELEASE_VERZ/$release/apps/web/dist" "$WEB_VERZ/kunden/$kunde.$BASIS_DOMAIN"

  schritt 'Dienst starten'
  systemctl start "ohrganize-backend@$kunde" || true

  if warte_auf_health "$port" 45; then
    local health gemeldet
    health="$(health_json "$port")"
    gemeldet="$(json_feld "$health" variant id)"
    if [[ -n "$gemeldet" && "$gemeldet" != "$(kunden_variante "$kunde")" ]]; then
      warnung "$kunde: Der Dienst meldet die Ausgabe \"$gemeldet\", erwartet war \"$(kunden_variante "$kunde")\"."
      instanz_zuruecknehmen "$kunde" "$alt" "$sicherung"
      return 1
    fi
    hinweis "laeuft: Version $(json_feld "$health" version), Ausgabe $gemeldet, Kanal $(json_feld "$health" channel)"
    rm -f "$daten/.update-fehlgeschlagen"
    return 0
  fi

  warnung "$kunde: Das Backend antwortet nach 45 s nicht."
  journalctl -u "ohrganize-backend@$kunde" -n 30 --no-pager >&2 || true
  instanz_zuruecknehmen "$kunde" "$alt" "$sicherung"
  return 1
}

instanz_zuruecknehmen() {
  local kunde="$1" alt="$2" sicherung="$3"
  local link daten port
  link="$(kunden_programm "$kunde")"
  daten="$(kunden_datenverz "$kunde")"
  port="$(kunden_port "$kunde")"

  printf '  Nehme %s zurueck.\n' "$kunde"
  systemctl stop "ohrganize-backend@$kunde" || true
  if [[ -n "$alt" && -d "$alt" ]]; then
    schritt "Symlink zurueck auf $(basename "$alt")"
    ln -sfn "$alt" "$link"
    ln -sfn "$alt/apps/web/dist" "$WEB_VERZ/kunden/$kunde.$BASIS_DOMAIN"
  else
    warnung "$kunde: Kein vorheriges Release bekannt - der Symlink bleibt, wie er ist."
  fi
  systemctl start "ohrganize-backend@$kunde" || true

  if warte_auf_health "$port" 45; then
    hinweis 'Die alte Fassung laeuft wieder.'
  else
    # Der haeufigste Grund: Die neue Fassung hat die Datenbank bereits
    # migriert, und die alte verweigert deshalb den Start ("von einer neueren
    # Version migriert"). Dann hilft nur die Sicherung von eben.
    warnung "$kunde: Auch die alte Fassung startet nicht. Vermutlich wurde die Datenbank bereits migriert."
    if [[ -n "$sicherung" && -d "$sicherung" ]]; then
      schritt "Datenbank aus $sicherung zurueckspielen"
      systemctl stop "ohrganize-backend@$kunde" || true
      cp -a "$sicherung/ohrganize.db" "$daten/ohrganize.db"
      rm -f "$daten/ohrganize.db-wal" "$daten/ohrganize.db-shm"
      chown "$DIENST_BENUTZER":"$DIENST_BENUTZER" "$daten/ohrganize.db"
      chmod 0600 "$daten/ohrganize.db"
      systemctl start "ohrganize-backend@$kunde" || true
      if warte_auf_health "$port" 45; then
        hinweis 'Die alte Fassung laeuft mit der zurueckgespielten Datenbank.'
      else
        warnung "$kunde: Auch das hat nicht geholfen. Bitte von Hand nachsehen (journalctl -t ohrganize-$kunde)."
      fi
    fi
  fi
  date -Iseconds >"$daten/.update-fehlgeschlagen" 2>/dev/null || true
  # Dem Dienstbenutzer geben: Im Datenverzeichnis soll nichts root gehoeren
  # (find /var/lib/ohrganize -user root ist Teil der Abnahme).
  chown "$DIENST_BENUTZER":"$DIENST_BENUTZER" "$daten/.update-fehlgeschlagen" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
update() {
  local archiv="${1:-}"
  [[ -n "$archiv" ]] || fehler 'Aufruf: ohrganize-update.sh update <archiv.zip> [--kunde <kunde>] [--probelauf]'
  shift || true
  einspielen "$archiv"
  local variante version
  variante="$(archiv_variante "$archiv")"
  version="$(archiv_version "$archiv")"
  printf '\n'
  umstellen "$variante-$version" "$@"
}

hilfe() {
  cat <<HILFE
oHRganize - Release einspielen und Instanzen umstellen

  einspielen <archiv.zip>            Pruefsumme, Signatur und Ausgabe pruefen,
                                     nach $RELEASE_VERZ/<variante>-<version>
                                     entpacken, npm ci, better-sqlite3 pruefen
  umstellen <release> [--kunde <k>] [--probelauf]
                                     Migrations-Probelauf auf Kopien, dann je
                                     Instanz: Sicherung, stop, Symlink, start,
                                     Health; bei Fehler Ruecknahme
  update <archiv.zip> [--kunde <k>] [--probelauf]
                                     einspielen und umstellen nacheinander
  releases                           Eingespielte Releases auflisten

Betroffen sind nur Instanzen, deren OHRGANIZE_VARIANT zur Ausgabe des
Releases passt. Andere Ausgaben bleiben unangetastet.

Einstellungen: siehe ohrganize-lib.sh bzw. /etc/ohrganize/provision.conf
Doku: deploy/README.md, Abschnitt 9
HILFE
}

releases() {
  [[ -d "$RELEASE_VERZ" ]] || { printf 'Noch kein Release unter %s.\n' "$RELEASE_VERZ"; return 0; }
  printf '%-34s %-18s %s\n' RELEASE AUSGABE BENUTZT-VON
  local eintrag kunde benutzer
  while read -r eintrag; do
    [[ -n "$eintrag" ]] || continue
    benutzer=''
    while read -r kunde; do
      [[ -n "$kunde" ]] || continue
      [[ "$(kunden_release "$kunde")" == "$eintrag" ]] && benutzer="$benutzer $kunde"
    done <<<"$(alle_kunden)"
    printf '%-34s %-18s %s\n' "$eintrag" "$(release_variante "$RELEASE_VERZ/$eintrag")" "${benutzer:- -}"
  done <<<"$(find "$RELEASE_VERZ" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)"
}

befehl="${1:-hilfe}"
[[ $# -gt 0 ]] && shift || true
case "$befehl" in
  einspielen) pruefe_umgebung; einspielen "$@" ;;
  umstellen)  pruefe_umgebung; umstellen "$@" ;;
  update)     pruefe_umgebung; update "$@" ;;
  releases)   releases "$@" ;;
  hilfe|-h|--help) hilfe ;;
  *) printf 'Unbekannter Befehl: %s\n\n' "$befehl" >&2; hilfe >&2; exit 1 ;;
esac
