# Kundenserver unter `<kunde>.ohrganize.com`

Der Fall: oHRganize läuft **beim Kunden** (eigener Server, eigene Daten,
eigenes Zertifikat), soll aber unter einem Namen in der Zone des Anbieters
erreichbar sein — `musterfirma.ohrganize.com` statt `portal.musterfirma.de`.
Bequem für Kunden ohne eigene Domainverwaltung, aber der Zoneninhaber sitzt
damit an einer Stelle, an der er Verkehr umleiten könnte. Dieses Dokument
legt fest, wie das eingerichtet wird, damit der Anbieter das **nicht
unbemerkt** kann, und wo die Grenze dieser Absicherung liegt.

Der Mehrkundenbetrieb **auf dem Server des Anbieters** (`deploy/README.md`,
Abschnitt 9, Wildcard-Zertifikat, `ohrganize-provision.sh`) ist ein anderer
Fall: Dort terminiert der Anbieter TLS ohnehin selbst. Und wer den Server
unter einer eigenen Domain betreibt, braucht von hier gar nichts.

## 1. DNS: nur ein Eintrag, nicht proxied

In der Cloudflare-Zone `ohrganize.com` bekommt der Kunde genau einen
A/AAAA-Eintrag auf seine Server-IP — **DNS only** (graue Wolke), niemals
„proxied“. Mit eingeschaltetem Proxy terminierte Cloudflare TLS; Cloudflare
würde damit zum Unterauftragsverarbeiter des Kunden (Art. 28 DSGVO, Verkehr
im Klartext bei einem US-Anbieter), und der Zoneninhaber könnte den
gesamten Verkehr der Personalakte mitlesen. TLS **muss** auf dem Server des
Kunden enden. Ebenso wenig gehören Cloudflare-Regeln (Page Rules, Workers,
Redirects) auf den Namen.

Empfohlen: kurze TTL (300 s) ist nicht nötig, 3600 s reicht; der Eintrag
ändert sich nur bei einem Serverumzug — und den beauftragt der Kunde
schriftlich (Abschnitt 7).

## 2. Zertifikat: HTTP-01 auf dem Server des Kunden

Caddy auf dem Kundenserver holt das Zertifikat selbst über HTTP-01 (Port 80
und 443 aus dem Internet erreichbar, wie in `deploy/README.md` Abschnitt 1
bzw. `deploy/windows/README.md`). **Kein Cloudflare-API-Token auf dem
Kundenserver.** DNS-01 bräuchte eines mit `DNS:Edit`, und Cloudflare erlaubt
außerhalb der Enterprise-Pläne keine Einschränkung eines solchen Tokens
unterhalb der ganzen Zone: Ein Token auf dem Server von Kunde A könnte die
Einträge von Kunde B ändern. HTTP-01 belegt dagegen nur, dass der Kunde
den Server hinter dem Namen kontrolliert — genau das, was zutrifft.

Wildcard-Zertifikate scheiden damit aus (die gibt es nur über DNS-01); der
Kunde braucht sie nicht, er hat einen Namen.

## 3. CAA: Ausstellung an das ACME-Konto des Kunden binden

Ein CAA-Eintrag **auf dem Kundennamen** legt fest, wer für genau diesen
Namen Zertifikate ausstellen darf — und mit den Parametern aus RFC 8657 auch
für **welches ACME-Konto** und **welches Prüfverfahren**:

```
musterfirma.ohrganize.com.  CAA  0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<konto-id>; validationmethods=http-01"
musterfirma.ohrganize.com.  CAA  0 issuewild ";"
```

Let's Encrypt wertet beide Parameter aus: Ein Antrag von einem anderen Konto
oder über DNS-01 wird abgelehnt — auch einer des Zoneninhabers selbst. CAA
wird bei jeder Ausstellung vom nächsten Eintrag aufwärts gelesen; ein CAA
auf `ohrganize.com` (für die eigenen Namen des Anbieters) bleibt davon
unberührt, weil der Eintrag auf dem Kundennamen Vorrang hat.

**Woher die Konto-URL kommt:** Caddy legt das ACME-Konto beim ersten
Zertifikatsbezug an und speichert es in seinem Datenverzeichnis:

| Plattform | Ordner |
|---|---|
| Linux (Paket aus dem offiziellen Caddy-Repository, Dienst `caddy`; `deploy/README.md`, Abschnitt 3) | `/var/lib/caddy/.local/share/caddy/acme/acme-v02.api.letsencrypt.org-directory/users/<email>/` |
| Windows (Dienst unter LocalSystem) | `C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy\acme\acme-v02.api.letsencrypt.org-directory\users\<email>\` |

`<email>` ist die Adresse aus der `email`-Direktive des Caddyfile. Im Ordner
liegt eine `.json`-Datei; ihr Feld `location` ist die Konto-URL.
Reihenfolge deshalb:
erst Caddy das erste Zertifikat holen lassen (mit einem vorläufigen
`CAA 0 issue "letsencrypt.org"`), dann die URL auslesen und den Eintrag um
`accounturi` und `validationmethods` verschärfen.

Damit die Bindung hält, darf das Konto nicht verloren gehen: Das
Caddy-Datenverzeichnis gehört in die Sicherung des Kundenservers. Wird es
neu angelegt, entsteht ein neues Konto — dann CAA anpassen, sonst
scheitert die nächste Erneuerung (sichtbar im Caddy-Protokoll).

## 4. Certificate Transparency: der Kunde schaut selbst

CAA schützt bei der Ausstellung; was tatsächlich ausgestellt wurde, steht
öffentlich in den CT-Logs. Der Kunde (nicht der Anbieter) richtet eine
Überwachung auf seinen Namen ein — zum Beispiel den Atom-Feed von crt.sh
(`https://crt.sh/atom?q=musterfirma.ohrganize.com`) oder Cert Spotter
(sslmate) mit Benachrichtigung per Mail. Erwartet wird ausschließlich das
Muster „Let's Encrypt, alle paar Wochen, für genau diesen Namen“ (Caddy
erneuert nach zwei Dritteln der Laufzeit). Jedes andere Zertifikat — andere
CA, Wildcard, unerwarteter Zeitpunkt — ist ein Alarm, den der Kunde beim
Anbieter anspricht. Der Anbieter kann und soll dieselbe Überwachung
zusätzlich fahren; ersetzen kann sie die des Kunden nicht, denn sie soll
gerade den Anbieter kontrollieren.

## 5. Das Cloudflare-Konto des Anbieters

Der Name lebt in einer fremden Zone; deren Konto ist damit Teil der
Angriffsfläche des Kunden. Mindeststandard:

- **Zwei-Faktor mit Hardware-Schlüssel** (FIDO2) für jedes Mitglied des
  Kontos; keine SMS, keine Wiederherstellungscodes im Passwortmanager der
  gesamten Firma.
- **Keine zonenweiten API-Tokens auf Vorrat.** Tokens nur je Zweck, mit
  minimalem Recht (meist `DNS:Read`) und Ablaufdatum; ungenutzte löschen.
  Ein `DNS:Edit`-Token für die Zone ist ein Generalschlüssel zu allen
  Kundennamen — es gehört auf keinen Server und in kein Skript, das
  unbeaufsichtigt läuft.
- **DNSSEC einschalten.** Ohne DNSSEC könnte ein Angreifer auf dem Weg zur
  CA den CAA-Eintrag wegfälschen; Let's Encrypt prüft DNSSEC-signierte
  Antworten.
- **Audit-Log** der Zone regelmäßig durchsehen (Cloudflare zeichnet jede
  DNS-Änderung mit Konto und Zeitpunkt auf); Mitglieder nur mit der
  DNS-Rolle, nicht als Administrator.

## 6. Die Desktop-App: Schlüssel festnageln

Der empfindlichste Verkehr ist der der HR-Administration (Desktop-App), und
der lässt sich vollständig gegen ein untergeschobenes Zertifikat absichern:
Die App prüft im `https://`-Betrieb zusätzlich zur Zertifikatskette den
SHA-256-Hash des öffentlichen Schlüssels (SPKI, Schreibweise
`sha256/<Base64>`) des Servers und verbindet sich mit keinem anderen —
gleich welche CA das Zertifikat unterschrieben hat. Ohne Konfiguration merkt
sie sich den Schlüssel beim ersten Kontakt (`server-pins.json` neben der
`config.json`) und schlägt bei jedem Wechsel Alarm; mit `serverKeyPins` in
der `config.json` (oder `OHRGANIZE_SERVER_KEY_PINS` im Rollout) gilt der
Schutz ab dem ersten Start. Damit die Pins nicht bei jeder Erneuerung
brechen, muss der Server seinen privaten Schlüssel über Erneuerungen hinweg
behalten — **je Proxy anders, und ohne eine der beiden Maßnahmen bricht der
Pin bei der ersten Erneuerung (Let's Encrypt: nach ~60 Tagen)**:

| Proxy | Maßnahme |
|---|---|
| Caddy (Linux und Windows) | `tls { reuse_private_keys }` — in den mitgelieferten Caddyfiles gesetzt, setzt Caddy ≥ 2.8.0 voraus (nicht das Debian/Ubuntu-Paket 2.6.2) |
| nginx mit certbot (Linux) | `certbot certonly --reuse-key …` — wird je Zertifikat in `/etc/letsencrypt/renewal/<name>.conf` gemerkt; bei einem schon ausgestellten Zertifikat vor der ersten Erneuerung nachholen (`deploy/README.md`, Abschnitt 3, „Serverschlüssel festnageln“) |

Einrichtung, Hash-Berechnung und Rotation stehen in
`deploy/windows/README.md`, Abschnitt 7 („Serverschlüssel festnageln“); die
Angaben zum Arbeitsplatz gelten unverändert, wenn er auf einen Linux-Server
zeigt — serverseitig tritt dann die Zeile aus der Tabelle an die Stelle
des Caddyfile-Hinweises. Ein bewusster Schlüsselwechsel ist bei ACME ein
geplanter Ausfall der Arbeitsplätze, weil der neue Pin erst nach der
Neuausstellung existiert (Ablauf im Caddyfile-Kommentar bzw. in
`deploy/README.md`, Abschnitt 3).

Für das Portal im Browser gibt es dieses Werkzeug nicht — Browser kennen
kein Pinning mehr. Dort bleiben CAA und CT (Abschnitte 3 und 4).

## 7. Vertrag

Was zwischen Anbieter und Kunde festgehalten gehört:

- Der Name `<kunde>.ohrganize.com` und die Zone gehören dem Anbieter; der
  Kunde erhält ein Nutzungsrecht für die Vertragsdauer.
- Der Anbieter stellt **keine** Zertifikate für den Namen aus, richtet
  keinen Proxy und keine Weiterleitung ein und ändert den Eintrag
  **ausschließlich auf schriftliche Weisung** des Kunden (Serverumzug).
- Bei Vertragsende bleibt der Eintrag **mindestens drei Monate** bestehen
  bzw. zeigt auf Weisung des Kunden auf dessen eigene Domain (CNAME), damit
  Lesezeichen, Portal-Links und die `config.json` der Arbeitsplätze
  geordnet umgestellt werden können.
- Der Kunde überwacht CT (Abschnitt 4) und meldet Auffälligkeiten; der
  Anbieter benennt einen Ansprechpartner für DNS-Änderungen.

## 8. Was bleibt

Ehrlich benannt: Der Zoneninhaber **kann** den A-Eintrag umbiegen, den CAA
ändern und sich von Let's Encrypt ein Zertifikat für den Namen holen — und
damit den Browserpfad des Portals umleiten. Er kann es nur nicht
**unsichtbar**: Das Zertifikat erscheint in den CT-Logs (Abschnitt 4), die
DNS-Änderung im Audit-Log, und die Desktop-App bricht die Verbindung wegen
des falschen Schlüssels ab (Abschnitt 6). Das ist dieselbe Vertrauensklasse
wie die Auslieferung der Software selbst: Wer das Programm liefert, das auf
der Personalakte läuft, könnte es auch manipulieren — der Schutz dagegen ist
Nachvollziehbarkeit und Vertrag, keine Technik, die den Anbieter aussperrt.
Wer diese Vertrauensklasse nicht will, betreibt den Server unter der
eigenen Domain; alles Übrige bleibt gleich.

## 9. Let's-Encrypt-Laufzeiten werden kürzer

Zertifikate von Let's Encrypt gelten heute 90 Tage; ab dem 10. Februar 2027
sind es 64 Tage, ab dem 16. Februar 2028 noch 45. Caddy erneuert von selbst
(nach zwei Dritteln der Laufzeit, also künftig alle paar Wochen), solange
**Port 80 aus dem Internet erreichbar bleibt** — eine Firewall-Änderung, die
Port 80 schließt, fällt erst Wochen später auf, wenn das Zertifikat abläuft.
Für die CT-Überwachung heißt das: häufigere, aber gleichförmige Einträge.
Das Pinning (Abschnitt 6) ist davon nicht betroffen, **solange** der
Schlüssel gleich bleibt — also mit `reuse_private_keys` (Caddy) bzw.
`--reuse-key` (certbot). Ohne die jeweilige Einstellung kämen die
Aussperrungen mit den kürzeren Laufzeiten nur schneller.
