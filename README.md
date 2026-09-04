# Mail-Panel — E-Mail-Automatisierung mit n8n

Zentrale Automatisierung für beliebig viele E-Mail-Konten (Web.de, GMX, Gmail, Mailbox.org,
eigener Mailcow-Server, jedes andere IMAP-Postfach): Spam-Triage, automatische Sortierung,
Virenscan, täglicher Telegram-Digest, Newsletter-Aufräumen und eigene Aktionen wie
„Rechnungen in die Nextcloud legen".

Die eigentliche Mail-Logik läuft in **n8n**, bedient wird alles über ein eigenes **Web-Panel**.
Im Alltag musst du dich in n8n nicht anmelden — das Panel legt die Zugangsdaten dort an,
baut die Workflows zusammen und schaltet sie ein und aus.

Die KI-Klassifizierung läuft über den **kostenlosen Gemini Free Tier**. Es entstehen keine
laufenden Kosten außer dem Server.

**Zwei Grundsätze:** Es wird **nie gelöscht, nur verschoben.** Und n8n ergänzt die vorhandenen
Spamfilter (Gmail-Filter, Rspamd in Mailcow), es ersetzt sie nicht.

---

## Voraussetzungen

| | |
|---|---|
| **Server** | VPS, NAS oder Homeserver mit **Docker** und **Docker Compose** |
| **RAM** | 4 GB empfohlen, 2 GB Minimum. Gemessen im Leerlauf: ClamAV 933 MB, n8n 322 MB, PostgreSQL 48 MB, Panel 27 MB, unbound 15 MB — zusammen ~1,35 GB. Ohne Virenscan (ClamAV weglassen) genügt 1 GB. |
| **Festplatte** | ~4 GB, davon allein ~1 GB für die ClamAV-Signaturen |
| **Ports** | `3002` (Panel) und `5678` (n8n) frei, beide in der `.env` änderbar |
| **Mail-Konten** | Zugangsdaten fürs IMAP-Postfach. Bei Anbietern mit Zwei-Faktor-Anmeldung ein **App-Passwort** statt des Konto-Passworts. |
| **Google-Konto** | für den kostenlosen Gemini-API-Key |

Optional, aber empfohlen: eine Domain und ein Reverse Proxy (Nginx Proxy Manager, Traefik,
Caddy …) für HTTPS. Ohne läuft alles genauso, nur unverschlüsselt über die Server-IP.

Rein optional und nur mit eigenem Mailcow-Server sinnvoll: die Rspamd-Quarantäne im Digest
und das Rspamd-Tuning.

---

# Ersteinrichtung

Rechne mit etwa einer halben Stunde. Die Schritte bauen aufeinander auf — bitte der Reihe nach.

## Schritt 1 — Stack starten

Den Stack bekommst du auf den Server, indem du das Repository klonst — oder die `compose.yaml`
(und optional die `.env`) in ein Docker-Panel wie **Dockhand** oder **Portainer** einfügst.

Es gibt nur **eine Sache zu entscheiden: Virenscan (ClamAV) und DNS-Resolver (unbound)** —
selbst mitstarten oder vorhandene (z. B. von Mailcow) mitbenutzen. Das stellst du über die `.env`
ein (bzw. die Umgebungsvariablen deines Panels); `.env.example` erklärt jeden Wert:

| Situation | Was in die `.env` |
|---|---|
| frischer Server, nichts vorhanden | `COMPOSE_PROFILES=clamav,unbound` — der Stack startet beide selbst |
| Mailcow o. ä. schon da, mitbenutzen | `COMPOSE_PROFILES=` (leer), dazu `CLAMD_HOST=clamd-mailcow`, `UNBOUND_HOST=unbound-mailcow` und `PANEL_EXTERN_NETZ=<Mailcow-Netz>` (Namen: `docker network ls`) |
| erstmal ohne Virenscan | `COMPOSE_PROFILES=` (leer), die drei anderen weglassen — das Panel läuft, der Scan bleibt aus |

Warum die Wahl: Ein zweites ClamAV neben einem vorhandenen kostet rund 1,5 GB Arbeitsspeicher
für nichts. `PANEL_EXTERN_NETZ` hängt das Panel an ein bereits vorhandenes Docker-Netz, damit es
dessen ClamAV/unbound per Containernamen erreicht — deklarativ in der Compose, ohne
`docker network connect` von Hand.

Dann starten:

```bash
docker compose up -d
```

**Auf einem Server mit Shell-Zugriff** kannst du dir die `.env` auch abnehmen lassen:
`./einrichten.sh` sieht nach, was schon läuft, und trägt genau die obigen Werte für dich ein. Das
Skript ist bequem, aber **nicht nötig** — in einem Docker-Panel setzt du die Werte einfach dort.

Ohne jede `.env` startet der Stack **ohne** ClamAV und unbound (beide hinter Profilen); Panel,
n8n und Datenbank laufen trotzdem.

Sonst ist an Konfiguration nichts nötig: Alle Schlüssel erzeugen n8n und das Panel beim
ersten Start selbst und legen sie in ihren Volumes ab. Ports, Zeitzone und die öffentliche
n8n-Adresse stehen ebenfalls in der `.env`.

Beim ersten Start passieren drei Dinge, die etwas dauern:

- Ein Init-Container installiert den Community-Node `n8n-nodes-imap` ins n8n-Volume.
  Ohne ihn kann n8n keine Mails verschieben.
- ClamAV lädt seine Virensignaturen (~1 GB). Bis das durch ist, meldet der Virenscan
  im Panel „nicht bereit" — das ist normal und dauert beim ersten Mal einige Minuten.
- Das Panel-Image wird von ghcr.io geladen. `pull_policy: always` sorgt dafür, dass jeder
  Start nach einer neueren Fassung sieht — Updates kommen damit von selbst an.

Kontrolle:

```bash
docker compose ps
```

Alle Dienste außer `n8n-nodes-init` müssen laufen — der ist fertig und beendet sich.

> **Wichtig fürs ganze Leben der Installation:** Das Volume `n8n_data` enthält den
> Verschlüsselungsschlüssel von n8n. Löschst du es, sind alle gespeicherten Zugangsdaten
> unbrauchbar und alle Konten müssen neu angelegt werden.

## Schritt 2 — n8n einrichten und den API-Key holen

n8n öffnen: `http://<server-ip>:5678`

1. Beim ersten Aufruf legst du das **Owner-Konto** an (E-Mail + Passwort). Das ist deine
   n8n-Anmeldung — merken, aber im Alltag brauchst du sie nicht.
2. Danach in n8n auf **Einstellungen → n8n API → Create an API key**.
   Ablaufdatum am besten weit in die Zukunft oder unbegrenzt.
3. Den Key kopieren. Er wird nur einmal angezeigt.

Über diesen Key erledigt das Panel anschließend alles Weitere in n8n für dich.

## Schritt 3 — Panel einrichten und mit n8n verbinden

Panel öffnen: `http://<server-ip>:3002`

1. Beim ersten Aufruf legt der Einrichtungs-Assistent dein **Admin-Konto** an. Vergib ein
   richtiges Passwort — das Panel ist die Fernbedienung für alle deine Postfächer.
2. Auf **Einstellungen → Verbindungen**:
   - *n8n-Adresse:* `http://n8n:5678` stehen lassen (so heißt n8n im Docker-Netz)
   - *n8n-API-Key:* den Key aus Schritt 2 einfügen
   - **Speichern**
3. Weiter unten unter **Verbindungstests** auf **n8n** klicken.

Der n8n-Verbindungstest ist der eigentliche Startschuss: Läuft er grün, importiert das Panel
im Hintergrund **alle sieben Workflows** nach n8n. Von Hand importieren musst du nichts.

Auf der Seite **Workflows** kannst du das kontrollieren — dort sollten kurz darauf stehen:

| Workflow | Aufgabe |
|---|---|
| `01 - Inbox-Triage` | neue Mails klassifizieren und einsortieren |
| `02 - Täglicher Digest` | Zusammenfassung per Telegram, täglich 7:30 Uhr |
| `03 - Newsletter-Cleanup` | sonntags: Newsletter älter als 30 Tage ins Archiv |
| `04 - Bestands-Triage` | manuell: bereits vorhandene Mails aufarbeiten |
| `05 - Telegram-Callback` | die Knöpfe unter den Telegram-Nachrichten |
| `06 - Newsletter-Abmeldung` | Abbestellen aus dem Panel heraus |
| `07 - Eigene Aktionen` | deine selbst gebauten Regeln |

Fehlt etwas, hilft der Knopf **Neu importieren** oben rechts.

Die übrigen Verbindungstests nimmst du am besten gleich mit: **unbound** (Blacklist-Prüfung)
und **ClamAV** (Virenscan) sollten grün sein — ClamAV erst, wenn die Signaturen fertig
geladen sind. Mailcow darf rot bleiben, wenn du keins hast.

## Schritt 4 — Mail-Konten hinzufügen

Auf die Seite **Konten** → *IMAP-Konto hinzufügen*. Für die gängigen Anbieter gibt es
Vorlagen (Web.de, GMX, Gmail, Mailbox.org, Mailcow), die Server und Port schon ausfüllen.

Einzutragen sind Name, Server, Port, Benutzername und Passwort — mehr nicht. **Jedes
Postfach läuft über IMAP**, auch Gmail. Einen Sonderweg für einzelne Anbieter gibt es nicht.

Beim Speichern legt das Panel selbstständig in n8n an: die Zugangsdaten, den Trigger für
neue Mails sowie die Abruf- und Verschiebe-Knoten in den Workflows 01, 03 und 04.

Was bei den einzelnen Anbietern zu beachten ist:

| Anbieter | Besonderheit |
|---|---|
| **Web.de / GMX** | IMAP muss in den Einstellungen der Weboberfläche erst freigeschaltet werden, ab Werk ist es aus |
| **Gmail** | Zwei-Faktor-Anmeldung aktivieren und ein **App-Passwort** erzeugen (Google-Konto → Sicherheit → App-Passwörter); das normale Passwort lehnt Google ab |
| **Eigener Server** | Bei selbstsigniertem Zertifikat das Häkchen *Selbstsigniertes Zertifikat akzeptieren* setzen |

## Schritt 5 — Zielordner festlegen

Einsortiert wird in fünf Ordner: Quarantäne, Rechnungen, Bestellungen, Newsletter und —
fürs wöchentliche Newsletter-Aufräumen — Archiv. Du hast dabei die freie Wahl, und zwar
je Konto: im Konto-Dialog auf **Zielordner: vorhandene auswählen oder anlegen lassen**.

**Entweder deine eigenen Ordner nehmen.** Nach einem Klick auf *Verbindung testen* schlagen
die fünf Felder alle Ordner vor, die es im Postfach schon gibt — einfach den passenden
auswählen. Wer seine Rechnungen längst in `Finanzen/Belege` sammelt, trägt genau das ein.

**Oder anlegen lassen.** Fehlt einer der Ordner noch, steht im Dialog ein Knopf
**Fehlende Ordner anlegen** — ein Klick, und das Panel legt sie über IMAP im Postfach an.
Vorhandene Ordner werden dabei nicht angefasst.

Wer nichts einträgt, bekommt die Standardnamen (`Quarantaene`, `Rechnungen`,
`Bestellungen`, `Newsletter`, `Archiv`). Wichtig ist nur: Ein Ordner, in den einsortiert
werden soll, muss am Ende existieren — ob du ihn selbst angelegt hast oder das Panel,
ist egal. In **Gmail** entsprechen die Ordner den Labels.

Diese fünf sind nur die Grundausstattung. Wer will, lässt zusätzlich **nach Themen** sortieren —
„alles rund um Games in den Games-Ordner“, inklusive Ordner anlegen. Das steht weiter unten
unter *Automatische Themen-Sortierung* und ist ab Werk aus.

## Schritt 6 — Gemini-Schlüssel eintragen

Ohne diesen Schlüssel bricht die Klassifizierung ab und es wird nichts sortiert.

1. [aistudio.google.com](https://aistudio.google.com) öffnen → **API-Key erzeugen**.
   Das geht mit jedem Google-Konto und ist unabhängig von einem Gemini-Abo.
2. Im Panel unter **Einstellungen → KI & Benachrichtigungen** eintragen und speichern.

Das Panel legt daraus das Credential in n8n an und verteilt es beim nächsten
Synchronisieren in die Workflows.

Zwei Hinweise zum Free Tier: Google darf die Eingaben zur Produktverbesserung nutzen — wenn
dich das bei Mail-Inhalten stört, wechsle später auf den Paid Tier (Centbeträge) oder auf ein
lokales Ollama; in den Workflows ändert sich dabei nur ein einziger Knoten. Und das
Tageskontingent ist begrenzt: bei Fehler 429 ist es aufgebraucht.

## Schritt 7 — Telegram (optional)

Ohne Telegram funktioniert alles, du bekommst nur keine Benachrichtigungen und kein Digest.

1. In Telegram **@BotFather** anschreiben → `/newbot` → Token kopieren.
2. Dem eigenen Bot eine beliebige Nachricht schicken, dann
   `https://api.telegram.org/bot<TOKEN>/getUpdates` im Browser aufrufen und die `chat.id`
   ablesen.
3. Beides im Panel unter **Einstellungen → KI & Benachrichtigungen** eintragen.

## Schritt 8 — Synchronisieren

Auf der Seite **Workflows** oben rechts auf **Synchronisieren**.

Damit verteilt das Panel alles Eingetragene in die Workflows: Konten, Gemini, Telegram, die
Ordnernamen und die Zugangsdaten für die Prüfdienste. Diesen Knopf brauchst du immer dann
wieder, wenn du an den Einstellungen etwas geändert hast.

> Merke dir für später: Alle Knoten in n8n, deren ID mit `panel-` beginnt, gehören dem Panel
> und werden bei jedem Synchronisieren **neu erzeugt**. Änderst du sie in n8n von Hand, sind
> sie beim nächsten Mal weg. Der Rest jedes Workflows bleibt unangetastet und darf frei
> angepasst werden.

## Schritt 9 — Trockenlauf aktivieren (Wichtig!)

Bevor das System wild E-Mails verschiebt, solltest du es testen.
1. Gehe im Panel auf **Einstellungen → KI & Prüfung**.
2. Aktiviere den Schalter **Trockenlauf aktivieren**.
3. Klicke auf **Speichern** und danach auf der *Workflows*-Seite auf **Synchronisieren**.

Jetzt werden alle eingehenden E-Mails zwar von der KI analysiert und im Log erfasst, aber sie bleiben in deinem Posteingang. So kannst du im Panel unter *Workflows → Läufe* (oder in den Logs) entspannt prüfen, ob das System Spam, Newsletter und Rechnungen so erkennt, wie du dir das vorstellst. Sobald du zufrieden bist, schaltest du den Trockenlauf einfach wieder aus und synchronisierst erneut.

## Schritt 10 — Altbestand aufarbeiten

`04 - Bestands-Triage` arbeitet die Mails ab, die schon im Postfach liegen. Er läuft ab Werk
**nur, wenn du ihn manuell startest**.

Erst mit einem kleinen Limit (10) in den Abruf-Knoten testen, dann auf 100 stellen und so
oft starten, bis der Bestand durch ist. Die Klassifizierung ist auf einen Gemini-Aufruf alle
vier Sekunden gedrosselt, damit das Freikontingent reicht: 300 Mails brauchen etwa
20 Minuten. Das ist so gewollt.

**Optional: im Hintergrund laufen lassen.** Setzt du `BESTAND_INTERVALL=6` in der `.env`
(Stunden; `0` = aus), läuft die Bestands-Triage zusätzlich alle sechs Stunden von selbst und
holt nach, was noch unsortiert ist. Das kann die KI **nicht** überlasten: Der
KI-Tagesbudget-Deckel (`GEMINI_TAGESBUDGET`, Standard 400) begrenzt die Klassifizierungen, und
schon Sortiertes kostet kein Budget — nach ein paar Tagen läuft der Zeitplan quasi leer. Nach
dem Setzen einmal **Workflows → Synchronisieren**; Workflow 04 muss dafür „aktiv" sein.

**Damit ist die Grundeinrichtung fertig.** Alles Folgende ist optional.

---

# Optionale Erweiterungen

## HTTPS

**Das Panel spricht von sich aus HTTPS — du musst nichts einrichten.** Beim ersten Start
erzeugt es ein eigenes Zertifikat und legt es im Volume ab. Rufst du versehentlich `http://`
auf, wirst du auf `https://` umgeleitet; beides läuft über denselben Port.

Der Browser warnt beim ersten Besuch, weil niemand für ein selbst erzeugtes Zertifikat bürgt.
Die Verbindung ist trotzdem verschlüsselt — niemand liest dein Passwort mit. Einmal
durchklicken genügt.

### Ein echtes Zertifikat hinterlegen

Wenn du eine Domain hast, ist das die bessere Wahl: keine Warnung mehr. Zertifikat und
Schlüssel ins Panel einhängen und beides in der `.env` eintragen:

```yaml
# in docker-compose.yml beim Dienst "panel"
volumes:
  - panel_data:/app/data
  - /etc/letsencrypt/live/panel.example.org:/tls:ro
```

```bash
# in .env
TLS_CERT=/tls/fullchain.pem
TLS_KEY=/tls/privkey.pem
```

Beides muss gesetzt sein oder beides leer bleiben — nur eines von beiden bricht den Start
mit einer klaren Meldung ab, statt stillschweigend auf das selbst erzeugte zurückzufallen.

Soll im selbst erzeugten Zertifikat dein Name stehen, setze `PANEL_HOST=panel.example.org`.

### Eine Ausnahme, die du kennen solltest

n8n ruft das Panel im Docker-Netz über `http://panel:3002` auf. Dieser eine Pfad
(`/api/internal/…`) wird deshalb **nicht** umgeleitet und bleibt unverschlüsselt erreichbar.
Er ist durch ein eigenes Geheimnis geschützt und für Maschinen gedacht. Wer auch das nicht im
Klartext haben will, gibt den Port gar nicht erst nach außen frei:

```bash
# in .env
PANEL_PORT=127.0.0.1:3002
```

### Mit einem Reverse Proxy davor (Nginx Proxy Manager & Co.)

**Das funktioniert ohne Zutun.** Reicht dein Proxy die Kopfzeile `X-Forwarded-Proto: https`
weiter — Nginx Proxy Manager, Traefik und Caddy tun das von Haus aus —, erkennt das Panel,
dass außen bereits verschlüsselt wurde, und leitet nicht um. Trag als Ziel schlicht
`http://<server>:3002` ein.

Das ist kein Schönheitsfehler, sondern wichtig: Ohne diese Erkennung schickte die Umleitung
den Browser mit `https://<name>:3002` **am Proxy vorbei** direkt auf den Port — und verriete
dabei die interne Adresse.

Sauberer ist trotzdem, die eigene Verschlüsselung abzuschalten, wenn ohnehin ein Proxy davor
steht. Dann verschlüsselt nicht zweimal hintereinander jemand dasselbe:

```bash
# in .env
TLS_MODUS=aus
PANEL_PORT=127.0.0.1:3002   # dazu: Port gar nicht erst nach außen freigeben
```

1. DNS: A-Records für z. B. `panel.example.org` und `n8n.example.org` auf die Server-IP.
2. Den Reverse Proxy auf `http://<server>:3002` bzw. `:5678` zeigen lassen.
   **Für n8n unbedingt Websockets aktivieren** (im Nginx Proxy Manager das Häkchen
   „Websockets Support"), sonst bleibt der n8n-Editor beim Laden hängen.
3. In der `.env` `N8N_PUBLIC_URL=https://n8n.example.org/` setzen, damit OAuth-Rücksprünge
   und Webhook-Adressen stimmen. Danach `docker compose up -d`.

Läuft dein Proxy selbst als Container, nimm stattdessen `docker-compose.proxy.example.yml`
(Anleitung steht in der Datei). Dann läuft alles über das interne Docker-Netz und du kannst
die Ports `3002` und `5678` ganz schließen.

## Passkeys statt Passwort

Unter **Einstellungen → Passkeys** kannst du Fingerabdruck, Gesichtserkennung oder einen
Sicherheitsschlüssel für die Panel-Anmeldung hinterlegen.

Hinter einem Reverse Proxy muss dafür die Umgebungsvariable `ALLOWED_ORIGIN` auf die
Panel-Adresse gesetzt sein (`https://panel.example.org`) — sonst weigert sich das Panel,
Passkeys anzulegen. Das ist Absicht: Ohne festgelegte Herkunft ließen sich Passkeys
untergeschoben registrieren.

## Mailcow anbinden

Nur für die Rspamd-Quarantäne im Digest und das Rspamd-Tuning. Mails lesen und verschieben
läuft weiterhin über IMAP.

Mailcow-Admin → *Zugang → API* → Read-Write-Key erzeugen und den Zugriff auf die Server-IP
beschränken. Adresse und Key im Panel unter **Einstellungen → Verbindungen** eintragen.

## Google Safe Browsing

Prüft Links in Mails gegen Googles Liste bekannter Betrugsseiten. Key in der Google Cloud
Console erzeugen (Safe Browsing API aktivieren) und im Panel unter
**Einstellungen → Verbindungen** eintragen. Ohne Key entfällt diese Prüfung, alles andere
läuft weiter.

## Postausgang für das Newsletter-Abbestellen

Die meisten Newsletter lassen sich über einen Link abbestellen — dafür ist nichts
einzurichten. Manche Verteiler wollen aber eine Mail an eine Abmeldeadresse. Nur dafür
braucht das Panel einen Postausgang.

Unter **Einstellungen → Postausgang (SMTP)** Server, Port, Benutzer, Passwort und
Absenderadresse eintragen, dann unter *Verbindungstests* auf **Postausgang (SMTP)** —
der Test meldet sich testweise am Server an. Das Panel legt daraus das Credential in n8n
an und trägt es in Workflow 06 ein.

Ohne diese Angaben bleibt der Versand-Knoten stillgelegt. Workflow 06 lässt sich trotzdem
einschalten, es wird dann nur nichts verschickt.

## Eigene Aktionen — Nextcloud und Kalender

Auf der Seite **Workflows** im Bereich *Eigene Aktionen* beschreibst du in einem Satz, was
passieren soll:

> Rechnungen von amazon.de als PDF in Nextcloud unter Belege/{{jahr}} ablegen

Die KI macht daraus eine Regel und zeigt sie dir als Formular zur Kontrolle. Erst wenn du
bestätigst, wird sie gespeichert und in n8n gebaut. Jedes Feld bleibt änderbar — ohne
Gemini-Schlüssel füllst du das Formular einfach selbst aus.

### Belege automatisch ablegen (der schnelle Weg)

Für den häufigsten Fall — **Rechnungen und Bestellungen als PDF in die Nextcloud** — brauchst
du keine eigene Regel zu bauen. Auf der Seite **Sortierung** gibt es die Karte **„Belege in
Nextcloud"** mit einem Schalter. Einmal an, fertig: Sobald die KI eine Mail als Rechnung oder
Bestellung mit PDF-Anhang erkennt, landet der Beleg von selbst in der Nextcloud.

Ein zweiter Schalter, **„Inhalt lesen & prüfen"**, macht das Ganze schlau:

- Die KI **liest das PDF** und zieht **Firma, Datum und Aktenzeichen** heraus.
- Sie legt **nur echte Belege** ab. AGB, Widerrufsbelehrungen, Werbung, Logos und anderer
  Beikram werden erkannt und **aussortiert** — geprüft wird je Anhang, damit eine beiliegende
  AGB die Rechnung nicht mitzieht. Im Zweifel wird lieber nichts abgelegt.
- Einsortiert wird nach `Belege/Firma/Aktenzeichen` (wenn ein Aktenzeichen erkannt wurde, z. B.
  bei einem Inkasso-Vorgang) oder sonst `Belege/Jahr/Firma`, mit sprechendem Dateinamen
  `Datum Firma Betreff.pdf`.

Das Lesen kostet je Beleg eine KI-Abfrage; ein eigener **Tagesdeckel** (Standard 200, Variable
`BELEG_LESE_TAGESBUDGET`) schützt das Gemini-Kontingent, und schon gelesene Belege werden nicht
erneut geprüft. Die Karte zeigt „heute abgelegt / übersprungen / gelesen" und die zuletzt
verarbeiteten Belege; auf dem Dashboard gibt es dazu eine eigene Kachel. Voraussetzung ist eine
verbundene Nextcloud (siehe *Einstellungen → Ziele für eigene Aktionen*).

Wer es feiner steuern will — nur bestimmte Absender, ein anderer Zielordner, ein Kalendereintrag
statt einer Ablage — baut sich zusätzlich eine eigene Aktion wie unten beschrieben.

| Ziel | Was du dafür brauchst |
|---|---|
| Anhang in Nextcloud ablegen | Adresse, Benutzer und **App-Passwort** unter *Einstellungen → Ziele für eigene Aktionen* |
| Termin im Nextcloud-Kalender | dieselben Zugangsdaten plus den Kalendernamen aus der Adresszeile |
| Termin im Google-Kalender | Client-ID und Secret aus der Google Cloud Console, danach im Panel verbinden |
| Beliebige Adresse aufrufen | die Adresse (Ziele im eigenen Netz werden abgelehnt) |

In Textfeldern sind diese Platzhalter erlaubt: `{{jahr}}`, `{{monat}}`, `{{tag}}`,
`{{absender}}`, `{{betreff}}`, `{{konto}}`, `{{kategorie}}`. Ist bei einer Datei-Aktion
**„Inhalt lesen & prüfen"** aktiv, kommen `{{firma}}`, `{{datum}}` und `{{aktenzeichen}}`
hinzu — sie werden aus dem PDF gelesen. Ein optionales Feld **Dateiname** benennt die abgelegte
Datei um (leer = Originalname). Fehlende Ordner im Zielpfad legt das Panel beim Ablegen selbst an.

Für Nextcloud unbedingt ein App-Passwort verwenden (Nextcloud → Einstellungen → Sicherheit),
nicht das Konto-Passwort.

**Google ohne n8n-Anmeldung:** Der Google-Kalender-Knoten von n8n kann nur OAuth2, und
dessen Zustimmungsdialog läuft in der n8n-Oberfläche — genau das wollen wir vermeiden.
Deshalb meldest du dich im Panel an, und die Workflows holen sich den Zugriffs-Token dort
ab.

So richtest du es ein:
1. Öffne die [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Erstelle ein neues Projekt und aktiviere die **Google Calendar API**.
3. Richte den **OAuth-Zustimmungsbildschirm** ein (Nutzertyp: Extern).
   *Wichtig:* Füge hier unter **Testnutzer** deine eigene E-Mail-Adresse hinzu, sonst blockiert Google den Login später mit „Fehler 403: access_denied“.
4. Erstelle unter *Anmeldedaten* eine neue **OAuth-Client-ID** (Typ: *Webanwendung*).
5. Trage die im Panel angezeigte Rücksprung-Adresse als **Autorisierte Weiterleitungs-URIs** ein.
6. Kopiere Client-ID und Client-Secret ins Panel und klicke auf Verbinden.

Die Aktionen laufen im Workflow `07 - Eigene Aktionen`, den die Workflows 01 und 04 nach der
Klassifizierung aufrufen. Schlägt eine Aktion fehl, wird die Mail trotzdem einsortiert.

## Virenscan der Anhänge

Hat eine Mail Anhänge, schickt der Workflow nur **Konto und Nachrichten-Nummer** ans Panel.
Das Panel holt sich die Dateien selbst über IMAP und gibt jede einzelne an ClamAV weiter
(`POST /api/internal/scan-anhaenge`). Findet sich etwas, wandert die Mail in die Quarantäne
und — sofern eingerichtet — geht sofort eine Telegram-Warnung raus.

Warum der Umweg über das Panel? Weil so **alle** Anhänge geprüft werden, nicht nur der erste,
und weil es auch für die **Bestands-Triage** funktioniert: Deren Abruf-Knoten liefert nur die
Namen der Anhänge, nicht die Dateien selbst.

Grenzen: höchstens 20 Anhänge je Mail, höchstens 30 MB je Datei. Was darüber liegt, wird im
Ergebnis als übersprungen ausgewiesen — sichtbar im Panel unter *Workflows → Läufe*.

Ist ClamAV nicht erreichbar, bricht der Lauf ab und die Mail bleibt liegen. Das ist Absicht:
Lieber unsortiert als ungeprüft durchgewunken.

## Automatische Themen-Sortierung

Die fünf Zielordner aus Schritt 5 decken Spam, Rechnungen, Bestellungen und Newsletter ab.
Alles andere bleibt liegen. Mit der Themen-Sortierung ordnet die KI **jede** Mail zusätzlich
einem eigenen Ordner zu — Games, Reisen, Uni, was bei dir eben anfällt.

Einschalten unter **Einstellungen → KI & Prüfung → Automatische Themen-Sortierung**. Danach
einmal *Workflows → Synchronisieren*.

**Was die KI wählen darf, bestimmst du.** Auf der Seite **Sortierung** steht der *Themen-Katalog*
je Konto. Ein Klick auf **Aus Postfach einlesen** übernimmt die Ordner, die es in deinem Postfach
schon gibt — die KI baut also keine zweite Struktur neben deiner auf. Aus diesem Katalog wählt
sie, und nur daraus. Schreib zu jedem Ordner einen Satz dazu („Spiele, Steam, Konsolen“): Der
geht wörtlich in den Prompt und verbessert die Treffer deutlich. Ordner, in die nie einsortiert
werden soll, sperrst du mit dem Schloss-Symbol.

**Neue Ordner** sind eine eigene Entscheidung:

| Modus | Was passiert |
|---|---|
| *Nicht anlegen* | Es wird nur benutzt, was schon im Katalog steht |
| *Erst freigeben* (Standard) | Die KI schlägt vor, du bestätigst mit einem Klick — dabei wird der Ordner angelegt **und** die Mails, die inzwischen im Posteingang gewartet haben, wandern gleich hinein |
| *Vollautomatisch* | Die KI legt selbst an und sortiert sofort ein |

Dazu drei Bremsen: eine **Obergrenze** (ab Werk 25 KI-Ordner je Konto), eine
**Mindest-Sicherheit** (ab Werk 0,7 — darunter bleibt die Mail lieber liegen) und ein optionaler
**Sammelordner**, unter dem alle KI-Ordner entstehen (leer = direkt im Postfach, sonst z. B.
`Themen/Games`).

**Vorrang:** Ein erkanntes Thema schlägt die feste Kategorie — ein Games-Newsletter landet in
Games, nicht in Newsletter. Nur Spam, Blacklist-Treffer und Viren stehen darüber, die gehen
immer in die Quarantäne.

**Was die KI vorschlägt, prüft immer das Panel.** Ordnernamen aus einem Modell, das fremden
Mailtext liest, werden nicht ungeprüft an dein Postfach weitergereicht: erlaubt sind 2–40 Zeichen
aus Buchstaben, Zahlen, Leerzeichen, `-` und `_`; Pfadtrenner, System- und Kategorieordner sind
gesperrt. Und im **Trockenlauf** wird nie ein Ordner angelegt — dort siehst du nur, was passiert
wäre.

**Mit der Zeit wird es günstiger:** Landen drei Mails desselben Absenders im selben Ordner, macht
das Panel daraus eine feste Regel. Dieser Absender läuft danach ohne KI-Abfrage durch.

Was die KI nicht sicher zuordnen konnte, bleibt im Posteingang und steht in der **Sortier-Inbox** —
dort siehst du den Vorschlag, die Sicherheit und den Grund, warum es nicht gereicht hat.

## Bestand aufräumen: ähnliche Mails auf einmal

Wer die Bestands-Triage laufen lässt, hat hinterher oft hunderte Mails in der **Sortier-Inbox**.
Sie ist deshalb nicht nach Mails sortiert, sondern nach **Absender-Domain** gebündelt:

```
▸ @accounts.google.com   20 Mails
▸ @plesk.com              6 Mails
▸ @mail.anthropic.com     4 Mails · 4 Absender
```

Zielordner eintippen, einmal klicken — das Panel legt den Ordner an, merkt sich die Regel und
verschiebt **alle** Mails der Gruppe. Was sich das Panel merken soll, wählst du daneben:

| Auswahl | Wofür |
|---|---|
| **Ganze Domain** | Der Regelfall. Deckt auch Unterdomains ab und alle Absender, die dieser Dienst noch benutzt |
| **Nur dieser Absender** | Wenn aus derselben Domain Verschiedenes kommt und nur ein Absender gemeint ist |
| **Nur jetzt** | Einmal aufräumen, ohne dass eine Regel entsteht |

**Domain-Regeln sind fast immer die richtige Wahl.** Viele Dienste verschicken aus einer ganzen
Reihe von Adressen — `googleplay-noreply@`, `googleone-noreply@`, `google-noreply@` — oder gleich
aus Wegwerf-Adressen mit einem Hash im Namen. Eine Absender-Regel greift dort schlicht kein
zweites Mal.

Das Panel merkt sich das mit der Zeit selbst: Sobald zwei verschiedene Absender derselben Domain
im selben Ordner gelandet sind, legt es eine Domain-Regel an. Und **jede neue Regel gilt
rückwirkend** — was schon in der Sortier-Inbox liegt und dazu passt, wird sofort mitverschoben.

Hast du früher schon mehrere Einzelregeln für denselben Dienst angelegt, weist die Regel-Übersicht
darauf hin und fasst sie auf Wunsch zu einer Domain-Regel zusammen.

## White- und Blacklist

Unter **White- / Blacklist** pflegst du eigene Absenderlisten, die für alle Konten gelten.
Ein Eintrag ist entweder eine vollständige Adresse (`info@example.org`) oder eine Domain
(`example.org` — gilt dann auch für alle Unterdomains).

Die Workflows fragen vor der KI beim Panel nach, in dieser Reihenfolge:

1. **Whitelist gewinnt immer.** Diese Mails landen nie in der Quarantäne.
2. **Blacklist heißt sofort Quarantäne**, ohne KI-Abfrage — das spart Gemini-Kontingent.
3. Sonst wird die Absender-IP gegen die **DNSBL-Listen** geprüft. Ein Treffer erhöht den
   Spam-Wert, entscheidet aber nicht allein.

Das Credential, mit dem die Workflows das Panel erreichen, legt das Panel beim ersten
Synchronisieren selbst in n8n an. Du musst dafür nichts eintragen.

## Weitere Benutzer

Unter **Benutzer & Rollen** legst du weitere Zugänge an und gibst ihnen einzelne Seiten frei
oder verwehrst sie. Praktisch, wenn jemand nur die Quarantäne durchsehen, aber keine
Einstellungen ändern soll.

---

# Vor dem Produktivbetrieb

Für einen Testserver im eigenen Netz kannst du sofort loslegen. Bevor das Panel auf einem
erreichbaren Server **echte Post** verwaltet, geh einmal diese Liste durch:

- [ ] **Netz absichern — der wichtigste Punkt.** Standardmäßig sind Panel (`3002`) **und der
  n8n-Editor (`5678`)** nach außen offen. Der n8n-Editor ist Vollzugriff auf die Automatisierung
  und gehört nicht offen ins Internet. Setz einen **Reverse Proxy mit HTTPS** davor und schließ
  die Ports, oder binde sie an `127.0.0.1` (`PANEL_PORT=127.0.0.1:3002`, dito n8n). Wie genau,
  steht oben unter *Optionale Erweiterungen → HTTPS → Mit einem Reverse Proxy davor*.
- [ ] **Starke Passwörter** für das Panel-Admin-Konto und das n8n-Owner-Konto; für das Panel
  zusätzlich gern einen **Passkey** (Fingerabdruck/Sicherheitsschlüssel).
- [ ] **Erst Trockenlauf, dann scharf** (Schritt 9): einschalten, im Log prüfen, ob Spam,
  Newsletter und Rechnungen richtig erkannt werden, und erst dann ausschalten. So bewegt nichts
  deine echte Post, bevor du zufrieden bist.
- [ ] **Sicherung einrichten.** Die Volumes `panel_data`, `n8n_data` und `n8n_db_data` sichern —
  in `panel_data` liegen die Schlüssel, ohne die keine gespeicherten Zugangsdaten mehr lesbar
  sind. Zusätzlich die eingebaute **Postfach-Sicherung** (*Verwaltung → Sicherung*) einrichten,
  wenn du verschlüsselte Kopien deiner Mails auf einen FTP-Server legen willst.
- [ ] **Gemini-Tageslimit kennen.** Der KI-Free-Tier ist am Tag begrenzt (Fehler 429). Der
  **Budget-Deckel** (Standard 400 Einordnungen/Tag, plus 200 fürs Beleg-Lesen) fängt das ab und
  arbeitet einen großen Bestand über mehrere Tage ab. Bei viel Post ggf. auf den Paid Tier
  (Centbeträge) oder ein lokales Ollama wechseln — dafür ist nur ein Knoten umzubiegen.
- [ ] **Aufsicht anlassen.** Der Watchdog (`AUFSICHT_AKTIV`) prüft alle 15 Minuten, ob die
  Workflows laufen, und schaltet sie nötigenfalls wieder ein — empfehlenswert im Dauerbetrieb.

---

# Betrieb

## Aktualisieren

```bash
docker compose pull && docker compose up -d
```

Die Volumes bleiben dabei erhalten. Nach einem Update lohnt ein Blick in die `CHANGELOG.md`:
Steht dort unter *System-Auswirkungen* etwas von einem nötigen Synchronisieren, drück im
Panel auf der Workflows-Seite einmal auf **Synchronisieren**.

Kommt beim Pull ein `unauthorized`, liegt das Panel-Image in einer privaten Registry, für die
dein Server keine Anmeldung hat — dann mit `docker login ghcr.io` anmelden.

**Selbst bauen statt ziehen** (eigene Änderungen, kein Registry-Zugang): Die Haupt-Compose zieht
bewusst nur — sonst versucht ein Docker-Panel wie Dockhand oder Portainer beim Deployen zu
bauen, was dort mangels Quellcode und Schreibrechten scheitert. Das Bauen steht deshalb in einer
eigenen Datei, die du zusätzlich dazunimmst:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build panel
```

> **Nur mit vollständigem, aktuellem Quellstand bauen.** Das Image entsteht aus dem Ordner, in
> dem du stehst, und trägt denselben Namen wie das fertige aus der Registry. Liegen dort ältere
> Dateien, läuft danach genau dieser ältere Stand. Zurück auf den Registry-Stand:
>
> ```bash
> docker compose pull panel
> docker compose up -d --force-recreate panel
> ```

## Sichern

Sichere die Volumes `n8n_data`, `n8n_db_data` und `panel_data`. In `panel_data` liegen die
Panel-Datenbank und die automatisch erzeugten Schlüssel — ohne die kommst du an die
gespeicherten Zugangsdaten nicht mehr heran.

Zusätzlich lohnt es sich, die Workflows ab und zu aus n8n als JSON zu exportieren.

## Kosten

Keine, außer dem Server. n8n Community Edition, Gemini Free Tier, ClamAV und unbound sind
kostenlos. Nur wenn du das Gemini-Tageskontingent regelmäßig sprengst, wird der Paid Tier
nötig — der kostet für dieses Aufkommen Centbeträge.

---

# Wenn etwas klemmt

| Problem | Ursache und Lösung |
|---|---|
| n8n-Editor lädt nicht, dreht sich endlos | Websockets im Reverse Proxy aktivieren (NPM: Häkchen „Websockets Support") |
| Workflow lässt sich nicht einschalten, n8n meldet „not published" | Auf der Workflows-Seite einmal **Synchronisieren** — dabei wird der Unter-Workflow 07 veröffentlicht |
| IMAP-Knoten meldet „node not found" | `docker compose up -d` erneut ausführen; der Init-Container installiert `n8n-nodes-imap` ins n8n-Volume |
| Nichts wird sortiert, der Lauf bricht bei *Gemini klassifizieren* ab mit „Credentials not found" | Gemini-Schlüssel fehlt (Schritt 6) oder es wurde danach nicht synchronisiert |
| Gemini meldet Fehler 429 | Tageskontingent des Free Tier aufgebraucht — morgen weitermachen oder die Drosselung erhöhen |
| Gmail lehnt die Anmeldung ab | Gmail verlangt Zwei-Faktor-Anmeldung plus **App-Passwort**; das normale Konto-Passwort funktioniert nicht |
| Web.de- oder GMX-Anmeldung schlägt fehl | IMAP in den Einstellungen der Weboberfläche freischalten |
| IMAP scheitert mit „self-signed certificate" | Beim Konto *Selbstsigniertes Zertifikat akzeptieren* anhaken |
| Mails landen nicht im Zielordner | Der Ordner existiert im Postfach nicht — im Konto-Dialog auf *Fehlende Ordner anlegen* drücken oder den vorhandenen Ordner auswählen (Schritt 5) |
| Virenscan meldet „nicht bereit" | ClamAV lädt noch seine Signaturen; beim ersten Start dauert das einige Minuten |
| Anhänge werden nicht geprüft | Auf der Workflows-Seite **Synchronisieren** drücken — erst dabei bekommen die Workflows den Scan-Knoten |
| DNSBL-Test meldet `zen.spamhaus.org (127.255.255.254)` | Spamhaus lehnt Anfragen aus vielen Rechenzentrums-Netzen ab. Die Liste in den Einstellungen entfernen oder einen kostenlosen Spamhaus-DQS-Zugang nutzen — SpamCop und Barracuda laufen weiter. |
| Workflow lässt sich nicht einschalten, n8n meldet „Missing required credential: smtp" | Postausgang unter *Einstellungen → Postausgang (SMTP)* eintragen und synchronisieren — oder leer lassen, dann wird der Knoten stillgelegt und der Workflow lässt sich einschalten |
| Google-Verbindung bricht mit „Fehler 403: access_denied“ ab | Die App in der Google Cloud Console steht auf Status *Testing*. Die eigene E-Mail-Adresse muss dort unter **OAuth-Zustimmungsbildschirm → Testnutzer** eingetragen werden. |
| Passkey lässt sich nicht anlegen | Hinter einem Reverse Proxy muss `ALLOWED_ORIGIN` auf die Panel-Adresse gesetzt sein |
| Panel zeigt nach dem Update die alte Versionsnummer | Browser-Cache — mit `Strg+F5` neu laden |
| Seiten bleiben leer, viele Aufrufe enden in 404 („Cannot GET /api/…") | Frontend und Backend stammen aus verschiedenen Ständen. Fast immer die Folge eines Selbstbaus mit unvollständigem Quellstand. Prüfen mit `docker exec mail-panel grep -c '^router\.' src/routes/sortierung.js`, dann `docker pull ghcr.io/roobiing/mail-panel:latest` und `docker compose up -d --force-recreate panel` |
| Nach dem Update ist man abgemeldet | Einmalig und beabsichtigt: Seit v2.8.0.0 liegt die Anmeldung an anderer Stelle. Wer über einen Neustart des Browsers hinweg angemeldet bleiben will, setzt beim Anmelden den Haken **Angemeldet bleiben** |
| Man bleibt scheinbar angemeldet, aber nichts lädt mehr | War bis v2.8.0.0 der Fall, wenn die Sitzung ablief. Seither wird sauber abgemeldet und die Anmeldemaske nennt den Grund |
| Synchronisieren läuft in einen Timeout, n8n meldet „Maximum number of connections from user+IP exceeded" | Dein Mailserver begrenzt die gleichzeitigen IMAP-Verbindungen (bei Dovecot `mail_max_userip_connections`, ab Werk oft 10). n8n baut beim Speichern alle Trigger neu auf und läuft ins Limit; der Aufruf kommt dann nie zurück. `docker compose restart n8n` gibt die alten Verbindungen frei, danach klappt der Sync. Dauerhaft: das Limit am Mailserver anheben |
| Themen-Sortierung läuft, aber es entstehen keine Ordner | Einer von vieren: *Neue Ordner* steht auf *Nicht anlegen* oder *Erst freigeben* (dann warten die Vorschläge auf der Seite *Sortierung*), die Obergrenze je Konto ist erreicht, oder der **Trockenlauf** ist noch an |
| Mails bleiben trotz Themen-Sortierung im Posteingang | Der Katalog ist leer (*Sortierung → Aus Postfach einlesen*) oder die Mindest-Sicherheit ist zu hoch. Der Grund steht bei jeder Mail in der Sortier-Inbox |
| Sortiert wird in die alten Kategorien statt ins Thema | Nach dem Einschalten wurde nicht synchronisiert — ohne *Workflows → Synchronisieren* fehlt den Workflows der neue Knoten *Einsortieren* |

Weiter kommst du mit den Protokollen: im Panel unter **Logs**, für die Container mit
`docker compose logs -f panel` bzw. `docker compose logs -f n8n`.

---

# Für Entwickler

## Inhalt des Repositorys

| Ort | Zweck |
|---|---|
| `docker-compose.yml` | der komplette Stack: n8n, PostgreSQL, Panel, ClamAV, unbound |
| `docker-compose.proxy.example.yml` | optionales Override für Reverse Proxys im Container |
| `docker-compose.build.yml` | optionales Override, um das Panel aus dem Quellcode zu bauen |
| `.env.example` | Vorlage für die optionalen Stack-Variablen |
| `panel/backend/` | Express-Backend: n8n-Steuerung, Prüfdienste, Datenbank |
| `panel/frontend/` | React-Oberfläche (Vite + Tailwind) |
| `workflows/` | die sieben Workflow-Vorlagen, die das Panel nach n8n importiert |
| `mailcow/` | optionale Rspamd-Bausteine |

## Lokal entwickeln

```bash
cd panel/backend && npm install && npm run dev
```

```bash
cd panel/frontend && npm install && npm run dev
```

Der Frontend-Dev-Server leitet `/api` an `localhost:3002` weiter. Fürs Backend eine
`panel/backend/.env` mit `JWT_SECRET` und `PANEL_SECRET` anlegen.

## Wie Panel und n8n zusammenspielen

Das Panel steuert n8n ausschließlich über dessen öffentliche API. Es erzeugt dort Credentials
und schreibt Knoten in die Workflows. Jeder vom Panel erzeugte Knoten trägt eine ID mit dem
Präfix `panel-` und wird bei jedem Synchronisieren gelöscht und neu gebaut — alles andere im
Workflow bleibt unberührt und ist frei anpassbar.

Umgekehrt rufen die Workflows die Prüfdienste des Panels auf
(`/api/internal/check`, `/scan`, `/config`, `/log`), abgesichert über den Header
`X-Panel-Secret`.

## Ideen für später

- **Lokale KI (Ollama)** statt Gemini — dafür muss nur ein HTTP-Knoten umgebogen werden.
- Feinere Rechte im Mehrbenutzer-Betrieb, damit mehrere Leute getrennte Konten verwalten.
