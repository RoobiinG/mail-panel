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

Repository auf den Server holen (oder die Dateien in ein Docker-Panel wie Dockhand oder
Portainer einfügen) und in den Ordner wechseln. Dann:

```bash
docker compose up -d
```

Das war's an Konfiguration. Alle Schlüssel erzeugen n8n und das Panel beim ersten Start
selbst und legen sie in ihren Volumes ab. Eine `.env` brauchst du nur, wenn du Ports,
Zeitzone oder die öffentliche n8n-Adresse ändern willst — dann `.env.example` nach `.env`
kopieren und anpassen.

Beim ersten Start passieren drei Dinge, die etwas dauern:

- Ein Init-Container installiert den Community-Node `n8n-nodes-imap` ins n8n-Volume.
  Ohne ihn kann n8n keine Mails verschieben.
- ClamAV lädt seine Virensignaturen (~1 GB). Bis das durch ist, meldet der Virenscan
  im Panel „nicht bereit" — das ist normal und dauert beim ersten Mal einige Minuten.
- Ist das fertige Panel-Image nicht verfügbar, baut Compose es selbst aus dem Ordner
  `panel/`. Auch das dauert ein paar Minuten und passiert nur einmal.

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

## Schritt 9 — Trockenlauf, dann scharf schalten

Nicht sofort alles einschalten. Erst zusehen, ob die KI so einsortiert, wie du es erwartest.

1. In n8n den Workflow `01 - Inbox-Triage` öffnen und die Verbindung **hinter** dem Knoten
   *Verschieben?* trennen. Dann im Panel auf der Workflows-Seite einschalten — jetzt
   klassifiziert er nur und fasst nichts an.
2. Ein bis zwei Tage laufen lassen und die Läufe ansehen (Panel → Workflows → Workflow
   anklicken). Stimmen die Kategorien?
3. Passt es, die Verbindung wieder herstellen — ab jetzt wird einsortiert.
4. Testmails an jedes Konto schicken: etwas offensichtlicher Spam, eine Rechnung, ein
   Newsletter. Landen sie in den richtigen Ordnern?
5. `02 - Täglicher Digest` einmal von Hand starten → kommt die Telegram-Nachricht an?

Ist die KI daneben, schärfst du den Klassifizierungs-Text im Knoten *Normalisieren* nach.

## Schritt 10 — Altbestand aufarbeiten

`04 - Bestands-Triage` arbeitet die Mails ab, die schon im Postfach liegen. Er läuft
**nur, wenn du ihn manuell startest** — es gibt keinen Zeitplan.

Erst mit einem kleinen Limit (10) in den Abruf-Knoten testen, dann auf 100 stellen und so
oft starten, bis der Bestand durch ist. Die Klassifizierung ist auf einen Gemini-Aufruf alle
vier Sekunden gedrosselt, damit das Freikontingent reicht: 300 Mails brauchen etwa
20 Minuten. Das ist so gewollt.

**Damit ist die Grundeinrichtung fertig.** Alles Folgende ist optional.

---

# Optionale Erweiterungen

## HTTPS über einen Reverse Proxy

Dringend empfohlen, sobald der Server aus dem Internet erreichbar ist — sonst gehen deine
Panel-Anmeldung und alle Mail-Zugangsdaten unverschlüsselt über die Leitung.

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

## Eigene Aktionen — Nextcloud und Kalender

Auf der Seite **Workflows** im Bereich *Eigene Aktionen* beschreibst du in einem Satz, was
passieren soll:

> Rechnungen von amazon.de als PDF in Nextcloud unter Belege/{{jahr}} ablegen

Die KI macht daraus eine Regel und zeigt sie dir als Formular zur Kontrolle. Erst wenn du
bestätigst, wird sie gespeichert und in n8n gebaut. Jedes Feld bleibt änderbar — ohne
Gemini-Schlüssel füllst du das Formular einfach selbst aus.

| Ziel | Was du dafür brauchst |
|---|---|
| Anhang in Nextcloud ablegen | Adresse, Benutzer und **App-Passwort** unter *Einstellungen → Ziele für eigene Aktionen* |
| Termin im Nextcloud-Kalender | dieselben Zugangsdaten plus den Kalendernamen aus der Adresszeile |
| Termin im Google-Kalender | Client-ID und Secret aus der Google Cloud Console, danach im Panel verbinden |
| Beliebige Adresse aufrufen | die Adresse (Ziele im eigenen Netz werden abgelehnt) |

In Textfeldern sind diese Platzhalter erlaubt: `{{jahr}}`, `{{monat}}`, `{{tag}}`,
`{{absender}}`, `{{betreff}}`, `{{konto}}`, `{{kategorie}}`. Fehlende Ordner im Zielpfad
legt das Panel beim Ablegen selbst an.

Für Nextcloud unbedingt ein App-Passwort verwenden (Nextcloud → Einstellungen → Sicherheit),
nicht das Konto-Passwort.

**Google ohne n8n-Anmeldung:** Der Google-Kalender-Knoten von n8n kann nur OAuth2, und
dessen Zustimmungsdialog läuft in der n8n-Oberfläche — genau das wollen wir vermeiden.
Deshalb meldest du dich im Panel an, und die Workflows holen sich den Zugriffs-Token dort
ab. Die im Panel angezeigte Rücksprung-Adresse muss dafür in der Google Cloud Console als
Weiterleitungs-URI eingetragen sein.

Die Aktionen laufen im Workflow `07 - Eigene Aktionen`, den die Workflows 01 und 04 nach der
Klassifizierung aufrufen. Schlägt eine Aktion fehl, wird die Mail trotzdem einsortiert.

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

# Betrieb

## Aktualisieren

```bash
docker compose pull && docker compose up -d
```

Die Volumes bleiben dabei erhalten. Nach einem Update lohnt ein Blick in die `CHANGELOG.md`:
Steht dort unter *System-Auswirkungen* etwas von einem nötigen Synchronisieren, drück im
Panel auf der Workflows-Seite einmal auf **Synchronisieren**.

Kommt beim Pull ein `unauthorized`, liegt das Panel-Image in einer privaten Registry, für die
dein Server keine Anmeldung hat. Dann entweder mit `docker login ghcr.io` anmelden oder
selbst bauen:

```bash
docker compose up -d --build panel
```

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
| DNSBL-Test meldet `zen.spamhaus.org (127.255.255.254)` | Spamhaus lehnt Anfragen aus vielen Rechenzentrums-Netzen ab. Die Liste in den Einstellungen entfernen oder einen kostenlosen Spamhaus-DQS-Zugang nutzen — SpamCop und Barracuda laufen weiter. |
| Passkey lässt sich nicht anlegen | Hinter einem Reverse Proxy muss `ALLOWED_ORIGIN` auf die Panel-Adresse gesetzt sein |
| Panel zeigt nach dem Update die alte Versionsnummer | Browser-Cache — mit `Strg+F5` neu laden |

Weiter kommst du mit den Protokollen: im Panel unter **Logs**, für die Container mit
`docker compose logs -f panel` bzw. `docker compose logs -f n8n`.

---

# Für Entwickler

## Inhalt des Repositorys

| Ort | Zweck |
|---|---|
| `docker-compose.yml` | der komplette Stack: n8n, PostgreSQL, Panel, ClamAV, unbound |
| `docker-compose.proxy.example.yml` | optionales Override für Reverse Proxys im Container |
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
