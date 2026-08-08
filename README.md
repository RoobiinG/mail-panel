# Mail-Panel — E-Mail-Automatisierung mit n8n

Zentrale Automatisierung für mehrere E-Mail-Konten (Gmail per OAuth, beliebige
IMAP-Postfächer wie Web.de/GMX, optional ein eigener Mailcow-Server):
Spam-Triage, automatische Sortierung, täglicher Telegram-Digest und Newsletter-Cleanup.
KI-Klassifizierung kostenlos über die **Gemini-API** (Google AI Studio Free Tier).
Installierbar auf jedem Server mit Docker.

**Grundsatz:** n8n ergänzt die vorhandenen Spamfilter (Gmail-Filter, Rspamd in Mailcow),
es ersetzt sie nicht. Und: **Es wird nie gelöscht, nur verschoben.**

## Voraussetzungen

- Ein Server (VPS, NAS, Homeserver, ...) mit **Docker + Docker Compose**
- **RAM:** 4 GB empfohlen, 2 GB Minimum. Gemessener Bedarf im Leerlauf: ClamAV 933 MB,
  n8n 322 MB, PostgreSQL 48 MB, Panel 27 MB, unbound 15 MB (zusammen ~1,35 GB).
  Ohne Virenscan (ClamAV-Dienst weglassen) genügt 1 GB.
- Für HTTPS: eine Domain und ein beliebiger Reverse Proxy (Nginx Proxy Manager,
  Traefik, Caddy, ...) — optional, die Dienste laufen auch direkt über ihre Ports
- Ein Google-Konto für den kostenlosen Gemini-API-Key; für Gmail-Anbindung zusätzlich
  ein Google-Cloud-Projekt (kostenlos)
- Die Mailcow-Teile (Rspamd-Quarantäne im Digest, Rspamd-Tuning) sind **optional**
  und werden nur mit eigenem Mailcow-Server aktiv

## Inhalt

| Datei | Zweck |
|---|---|
| `docker-compose.yml` | Kompletter Stack: n8n, PostgreSQL, Panel, ClamAV, unbound |
| `docker-compose.proxy.example.yml` | Optionales Override für Container-Reverse-Proxys |
| `.env.example` | Vorlage für die Stack-Variablen |
| `panel/` | Web-Panel (Verwaltungsoberfläche + Prüfdienste-Backend) |
| `workflows/01-inbox-triage.json` | Neue Mails klassifizieren + einsortieren (alle Konten) |
| `workflows/02-daily-digest.json` | Täglich 7:30 Uhr Zusammenfassung per Telegram (inkl. Rspamd-Quarantäne) |
| `workflows/03-newsletter-cleanup.json` | Sonntags: Newsletter älter 30 Tage → Archiv |
| `workflows/04-bestand-triage.json` | Manuell: bereits vorhandene Mails im Bestand aufarbeiten |

---

## 1. Stack deployen

1. Repository auf den Server klonen (oder die Dateien in ein Compose-fähiges
   Docker-Panel wie Dockhand/Portainer einfügen).
2. `.env` aus `.env.example` erstellen und füllen.
   `N8N_ENCRYPTION_KEY` einmal generieren (`openssl rand -hex 24`) und **nie mehr ändern**.
3. `docker compose up -d` — danach ist n8n auf Port `5678` und das Panel auf
   Port `3002` erreichbar. Der Community-Node `n8n-nodes-imap` (nötig fürs Verschieben
   und Suchen per IMAP) wird dabei automatisch mitinstalliert.
4. n8n öffnen und den Owner-Account anlegen.

## 2. HTTPS / Reverse Proxy (empfohlen, optional)

- DNS: A-Records für z.B. `n8n.example.org` und `panel.example.org` auf die Server-IP.
- Beliebigen Reverse Proxy auf `http://<server>:5678` bzw. `:3002` zeigen lassen —
  **für n8n Websocket-Unterstützung aktivieren** (im Nginx Proxy Manager das Häkchen
  „Websockets Support"), sonst lädt der Editor nicht.
- Läuft der Proxy selbst als Container, stattdessen `docker-compose.proxy.example.yml`
  verwenden (Anleitung steht in der Datei) — dann geht der Traffic über das interne
  Docker-Netz und die Ports können auf localhost beschränkt oder entfernt werden.
- In der `.env` `N8N_HOST` auf die n8n-Domain setzen, damit OAuth-Redirects und
  Webhook-URLs stimmen.

## 3. Konten anbinden (Credentials in n8n)

### Gmail (OAuth2)
1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt → **Gmail API aktivieren**.
2. „APIs & Dienste → Anmeldedaten" → OAuth-Client-ID (Webanwendung).
   Die **Redirect-URI** aus dem n8n-Credential-Dialog kopieren und dort eintragen.
3. Client-ID + Secret in n8n als Gmail-OAuth2-Credential speichern und verbinden.
4. **Wichtig:** OAuth-Zustimmungsbildschirm auf **„In Produktion"** stellen
   (unverifiziert reicht für den Eigengebrauch). Im Status „Testen" läuft der
   Refresh-Token nach 7 Tagen ab und die Verbindung bricht ständig ab.

### IMAP-Konten (Web.de, GMX, Mailcow, beliebige andere)
**Nicht in n8n anlegen — das macht das Panel.** Unter *Konten → IMAP-Konto hinzufügen*
Server, Port und Zugangsdaten eintragen; das Panel testet die Verbindung, legt das
Credential in n8n an und baut Trigger und Verschiebe-Knoten in die Workflows 01 und 04 ein.
Voraussetzung: Der n8n-API-Key ist im Panel hinterlegt (siehe Panel-Kapitel).

Hinweise: Bei Web.de/GMX muss IMAP erst in den Weboberflächen-Einstellungen freigeschaltet
werden. Bei Anbietern mit Zwei-Faktor-Authentifizierung ein App-Passwort verwenden.

### Mailcow-API (optional)
Für die Rspamd-Quarantäne im Digest: Mailcow-Admin-UI → Zugang → API → Read-Write-Key
erzeugen und den Zugriff auf die Server-IP beschränken. Key im Panel unter *Einstellungen*
eintragen. (Die Mailcow-API ist eine Verwaltungs-API — Mails lesen und verschieben läuft
weiterhin über IMAP.)

### Gemini (kostenlos)
1. [aistudio.google.com](https://aistudio.google.com) → API-Key erzeugen
   (unabhängig vom Gemini-Pro-Abo; der Free Tier steht jedem Google-Konto zur Verfügung).
2. In n8n als **Header-Auth-Credential** anlegen: Name `x-goog-api-key`, Wert = der Key.
3. Hinweis: Im Free Tier darf Google Eingaben zur Produktverbesserung nutzen.
   Falls das bei Mail-Inhalten stört: später auf Paid Tier (Centbeträge) oder
   lokales Ollama wechseln — die Workflows bleiben gleich, nur der HTTP-Node ändert sich.

### Telegram
1. In Telegram mit **@BotFather** chatten → `/newbot` → Token kopieren.
2. Token in n8n als Telegram-Credential speichern.
3. Chat-ID ermitteln: dem eigenen Bot eine Nachricht schicken, dann
   `https://api.telegram.org/bot<TOKEN>/getUpdates` aufrufen → `chat.id` ablesen.

## 4. Ordner anlegen

In **Web.de** und **Mailcow** (z.B. per Webmail) diese IMAP-Ordner anlegen,
in **Gmail** gleichnamige Labels:

```
Quarantaene   Rechnungen   Bestellungen   Newsletter   Archiv
```

## 5. Workflows importieren und konfigurieren

Import: n8n → Workflows → „Import from File" für alle vier Dateien aus `workflows/`.
Jeder Workflow hat eine gelbe Notiz mit seinen Konfigurationsschritten. Zusammengefasst:

1. **Credentials zuordnen** — jeden Node mit rotem Warndreieck öffnen und das passende Credential wählen.
2. **Gmail-Label-IDs eintragen** — einmalig die IDs holen (Gmail-Node: Label → Get Many)
   und in den „Antwort parsen"-Nodes von Workflow 01 + 04 sowie den Label-Nodes
   von Workflow 03 eintragen.
3. **IMAP-Nodes prüfen** — die Nodes des Community-Pakets (`Verschieben`, `Get Many`)
   einmal öffnen und Operation/Felder bestätigen; je nach Paketversion heißen die
   Parameter leicht anders, dann einfach im UI neu auswählen (Ziel steht in der Notiz).
4. **Digest** — Mailcow-URL im Node „Rspamd-Quarantäne" und die Telegram-Chat-ID eintragen.

## 6. Trockentest, dann scharf schalten

1. **Workflow 01:** Verbindung nach dem Node „Verschieben?" trennen und den Workflow
   aktivieren → er klassifiziert nur. 1–2 Tage die Executions ansehen: stimmen die
   Kategorien? Dann Verbindung wiederherstellen.
2. Testmails an alle drei Konten schicken (offensichtlicher Spam, eine Rechnung,
   ein Newsletter) und prüfen, ob sie in den richtigen Ordnern landen.
3. **Workflow 02** einmal manuell ausführen → kommt die Telegram-Nachricht an?
4. **Workflow 04 (Bestand):** erst mit Limit 10 in den Fetch-Nodes testen, dann auf 100
   stellen und so oft manuell starten, bis der Altbestand durch ist.
   (Gedrosselt auf 1 Gemini-Aufruf alle 4 Sekunden — 300 Mails ≈ 20 Minuten, das ist normal.)
5. Eine Woche beobachten; die Quarantäne-Liste im Digest zeigt False Positives.
   Bei Bedarf den Klassifizierungs-Prompt in den „Normalisieren"-Nodes nachschärfen.

## Mail-Panel (Verwaltungsoberfläche)

Eigenes Web-Panel (Express + React, Container `mail-panel`) als Fernbedienung für die
Automatisierung: Konten-Verwaltung mit n8n-Onboarding, Quarantäne, White-/Blacklists,
Newsletter-Abbestellen, Rspamd-Tuning und Prüfdienste (DNSBL via unbound, ClamAV, Safe Browsing).

### Einrichtung

1. **Erststart:** Panel öffnen (`http://<server>:3002` bzw. die Panel-Domain hinter dem
   Reverse Proxy) → der Setup-Flow legt das Admin-Konto an. Schlüssel erzeugt das Panel
   selbst; eine `.env` ist nicht nötig.
2. **n8n verbinden:** In n8n unter *Einstellungen → n8n API* einen Key erzeugen und im
   Panel unter *Einstellungen → Verbindungen* eintragen. Optional dort auch Mailcow-URL
   samt API-Key und den Safe-Browsing-Key hinterlegen.
3. **Verbindungstests:** Unter Einstellungen die Tests ausführen (n8n, Mailcow, ClamAV,
   unbound) — die genutzten Dienste müssen grün sein (Mailcow darf rot bleiben, wenn
   kein Mailcow eingebunden wird).
4. **Konten anlegen:** Unter *Konten* die IMAP-Postfächer hinzufügen — das Panel testet
   die Verbindung, legt die Credentials in n8n an und verdrahtet die Workflows 01 und 04.

**Gut zu wissen:** Alle Knoten in den Workflows 01/04, deren ID mit `panel-` beginnt,
gehören dem Panel und werden bei jedem Konto-Sync neu erzeugt. Änderungen daran gehen
verloren — der Rest des Workflows bleibt unangetastet und kann frei angepasst werden.

### Spam-Prüfung: White-/Blacklist und DNSBL

Unter *White- / Blacklist* pflegst du eigene Absenderlisten, die für alle Konten gelten.
Ein Eintrag ist entweder eine vollständige Adresse (`info@example.org`) oder eine Domain
(`example.org`, gilt dann auch für alle Unterdomains).

Die Workflows fragen vor der KI-Klassifizierung beim Panel nach. Die Reihenfolge:

1. **Whitelist** gewinnt immer — diese Mails landen nie in der Quarantäne.
2. **Blacklist** bedeutet direkt Quarantäne, ohne KI-Abfrage (spart Gemini-Kontingent).
3. Sonst wird die Absender-IP gegen die **DNSBL-Listen** geprüft; Treffer erhöhen den
   Spam-Score, entscheiden aber nicht allein.

Das Credential, mit dem die Workflows das Panel erreichen, legt das Panel beim ersten
Konto-Sync selbst in n8n an — du musst dafür nichts eintragen.

### Entwicklung (lokal)

```bash
cd panel/backend && npm install && npm run dev
```

```bash
cd panel/frontend && npm install && npm run dev
```

Frontend-Dev-Server läuft auf Vite-Standardport und proxyt `/api` an `localhost:3002`.
Fürs Backend lokal eine `panel/backend/.env` mit `JWT_SECRET` und `PANEL_SECRET` anlegen.

## Betrieb & Kosten

- **Updates:** In Dockhand das n8n-Image aktualisieren (Volumes bleiben erhalten).
- **Backup:** Die Volumes `n8n_data` + `n8n_db_data` sichern; Workflows zusätzlich
  regelmäßig als JSON exportieren (hierher, dann synct Nextcloud sie automatisch).
- **Kosten:** 0 € zusätzlich — VPS/NPM vorhanden, n8n Community Edition, Gemini Free Tier.

## Troubleshooting

| Problem | Lösung |
|---|---|
| n8n-Editor lädt nicht / hängt | „Websockets Support" im NPM-Proxy-Host aktivieren |
| Gmail-Verbindung bricht nach 7 Tagen ab | OAuth-App in der Google Console auf „In Produktion" stellen |
| Web.de-Login schlägt fehl | IMAP in den Web.de-Einstellungen aktivieren (standardmäßig aus) |
| Gemini-Fehler 429 | Free-Tier-Limit erreicht — Drosselung erhöhen (batchInterval) oder später weitermachen |
| IMAP-Node zeigt „node not found" | `docker compose up -d` erneut ausführen — der Init-Container installiert `n8n-nodes-imap` ins n8n-Volume |
| DNSBL-Test meldet `zen.spamhaus.org (127.255.255.254)` | Spamhaus lehnt Abfragen aus vielen Rechenzentrums-Netzen ab. Entweder die Liste in den Einstellungen entfernen oder einen kostenlosen Spamhaus-DQS-Zugang nutzen; SpamCop und Barracuda funktionieren weiterhin. |
| IMAP-Verbindung scheitert mit „self-signed certificate" | Beim Konto das Häkchen „Selbstsigniertes Zertifikat akzeptieren" setzen |

## Spätere Erweiterungen (bewusst noch nicht drin)

- Quarantäne-Freigabe per Telegram-Button (Mailcow-API kann Quarantäne-Items freigeben/löschen)
- Automatisches Newsletter-Abbestellen (List-Unsubscribe ist fehleranfällig)
- Rspamd-Tuning in Mailcow (lohnt sich, ist aber ein Thema auf dem Mailserver selbst)
