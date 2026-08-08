# E-Mail-Automatisierung mit n8n

Zentrale Automatisierung für **Gmail**, **Web.de** und **Mailcow** (eigener Server):
Spam-Triage, automatische Sortierung, täglicher Telegram-Digest und Newsletter-Cleanup.
KI-Klassifizierung kostenlos über die **Gemini-API** (Google AI Studio Free Tier).

**Grundsatz:** n8n ergänzt die vorhandenen Spamfilter (Gmail-Filter, Rspamd in Mailcow),
es ersetzt sie nicht. Und: **Es wird nie gelöscht, nur verschoben.**

## Inhalt

| Datei | Zweck |
|---|---|
| `docker-compose.yml` | n8n + PostgreSQL (Deployment über Dockhand) |
| `.env.example` | Vorlage für die Stack-Variablen |
| `workflows/01-inbox-triage.json` | Neue Mails klassifizieren + einsortieren (alle 3 Konten) |
| `workflows/02-daily-digest.json` | Täglich 7:30 Uhr Zusammenfassung per Telegram (inkl. Rspamd-Quarantäne) |
| `workflows/03-newsletter-cleanup.json` | Sonntags: Newsletter älter 30 Tage → Archiv |
| `workflows/04-bestand-triage.json` | Manuell: bereits vorhandene Mails im Bestand aufarbeiten |

---

## 1. DNS + Nginx Proxy Manager

1. A-Record anlegen: `n8n.deine-domain.de` → VPS-IP.
2. Im NPM einen **Proxy Host** anlegen:
   - Domain: `n8n.deine-domain.de`
   - Forward: `n8n` / Port `5678` (Container-Name, gleiches Docker-Netz)
   - SSL: Let's-Encrypt-Zertifikat anfordern, „Force SSL"
   - **Wichtig: „Websockets Support" aktivieren** — sonst lädt der n8n-Editor nicht.

## 2. Stack über Dockhand deployen

1. Docker-Netz des NPM herausfinden: `docker network ls` (oder in Dockhand unter Networks).
2. In Dockhand einen neuen **Compose-Stack** anlegen und den Inhalt von
   `docker-compose.yml` einfügen (oder Dockhands Git-Integration auf dieses
   Verzeichnis zeigen lassen).
3. Env-Variablen gemäß `.env.example` im Stack hinterlegen.
   `N8N_ENCRYPTION_KEY` einmal generieren (`openssl rand -hex 24`) und **nie mehr ändern**.
4. Stack starten, dann `https://n8n.deine-domain.de` öffnen und den Owner-Account anlegen.
5. **Community-Node installieren:** Settings → Community Nodes → `n8n-nodes-imap`
   (wird für das Verschieben/Suchen per IMAP gebraucht — der eingebaute IMAP-Trigger kann nur lesen).

## 3. Konten anbinden (Credentials in n8n)

### Gmail (OAuth2)
1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt → **Gmail API aktivieren**.
2. „APIs & Dienste → Anmeldedaten" → OAuth-Client-ID (Webanwendung).
   Die **Redirect-URI** aus dem n8n-Credential-Dialog kopieren und dort eintragen.
3. Client-ID + Secret in n8n als Gmail-OAuth2-Credential speichern und verbinden.
4. **Wichtig:** OAuth-Zustimmungsbildschirm auf **„In Produktion"** stellen
   (unverifiziert reicht für den Eigengebrauch). Im Status „Testen" läuft der
   Refresh-Token nach 7 Tagen ab und die Verbindung bricht ständig ab.

### Web.de (IMAP)
1. Web.de-Webmail → Einstellungen → POP3/IMAP → **IMAP aktivieren**.
2. Credential in n8n (für IMAP-Trigger **und** den Community-IMAP-Node):
   Host `imap.web.de`, Port `993`, SSL, normale Zugangsdaten.

### Mailcow (IMAP + API)
1. IMAP-Credential: Host `mail.deine-domain.de`, Port `993`, SSL, Postfach-Zugangsdaten.
2. **API-Key** für die Rspamd-Quarantäne im Digest: Mailcow-Admin-UI → Zugang → API →
   Read-Write-Key erzeugen, Zugriff auf die VPS-IP beschränken.
   In n8n als **Header-Auth-Credential** anlegen: Name `X-API-Key`, Wert = der Key.
   (Die Mailcow-API ist eine Verwaltungs-API — Mails lesen/verschieben läuft weiter über IMAP.)

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

1. **DNS + NPM:** A-Record `panel.deine-domain.de` → VPS-IP; NPM-Proxy-Host auf `panel:3002`
   (Websockets nicht nötig), Let's-Encrypt-Zertifikat.
2. **Secrets:** In der `.env` die Panel-Variablen füllen (siehe `.env.example`):
   `JWT_SECRET`, `PANEL_SECRET`, `PANEL_DB_KEY` (je `openssl rand -hex 32`),
   `N8N_API_KEY` (n8n → Settings → n8n API), `MAILCOW_URL` + `MAILCOW_API_KEY`,
   optional `SAFEBROWSING_API_KEY`.
3. **Stack aktualisieren:** `docker compose pull && docker compose up -d` — startet
   zusätzlich `clamav` (~1,5 GB RAM, Signatur-Updates automatisch) und `unbound`
   (DNS-Resolver für DNSBL-Abfragen; öffentliche Resolver werden von Spamhaus geblockt).
4. **Erststart:** `https://panel.deine-domain.de` öffnen → Setup-Flow legt das Admin-Konto an.
5. **Verbindungstests:** Unter Einstellungen die vier Tests ausführen (n8n, Mailcow, ClamAV,
   unbound) — alle müssen grün sein, bevor die weiteren Etappen eingerichtet werden.

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
| IMAP-Node zeigt „node not found" | Community-Node `n8n-nodes-imap` unter Settings → Community Nodes installieren |

## Spätere Erweiterungen (bewusst noch nicht drin)

- Quarantäne-Freigabe per Telegram-Button (Mailcow-API kann Quarantäne-Items freigeben/löschen)
- Automatisches Newsletter-Abbestellen (List-Unsubscribe ist fehleranfällig)
- Rspamd-Tuning in Mailcow (lohnt sich, ist aber ein Thema auf dem Mailserver selbst)
