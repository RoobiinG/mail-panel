# Changelog — Mail-Panel

Versionsschema: `Major.Minor.Änderung.Fix` (siehe AGENTS.md, Abschnitt 2).

## [1.1.0.0] - 2026-08-08 (Build 2) — *Panel-Grundgerüst*

### Features

- **Mail-Panel** (`panel/`): Express-Backend (Port 3002) mit JWT-Auth, Erststart-Setup-Flow
  (erster Aufruf legt das Admin-Konto an, danach gesperrt), Login-Rate-Limit und
  SQLite-Datenbank (Schema: accounts, quarantine_log, lists, newsletter_senders, settings).
- **Interne n8n-Endpunkte** unter `/api/internal/*` (Shared-Secret-Header `X-Panel-Secret`,
  timing-sicherer Vergleich): `GET /config` liefert Schwellwerte/Listen an die Workflows,
  `POST /log` nimmt Triage-Ergebnisse entgegen und zählt Newsletter-Absender mit.
- **React-Frontend** (Vite, Tailwind, dark-only im Design des Überwachungs-Panels):
  Login/Setup, Sidebar-Navigation für alle acht Bereiche, Einstellungen-Seite mit
  Spam-Schwellwert, DNSBL-Listen-Editor und Verbindungstests (n8n, Mailcow, ClamAV, unbound).
- **Neue Compose-Services**: `panel` (ghcr-Image), `clamav` (clamd für Anhang-Scans ab
  Etappe 4) und `unbound` (eigener Resolver für DNSBL-Abfragen ab Etappe 3).
- **CI**: GitHub Action baut das Panel-Image nach ghcr.io (Pfadfilter auf `panel/`),
  wöchentlicher npm-audit-Lauf für Backend und Frontend.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Neue Pflicht-Env-Variablen** (Stack startet der Panel-Container sonst bewusst nicht):
  `JWT_SECRET`, `PANEL_SECRET`; dazu `PANEL_DB_KEY`, `N8N_API_KEY`, `MAILCOW_URL`,
  `MAILCOW_API_KEY`, `SAFEBROWSING_API_KEY` (siehe `.env.example`).
- **Neue Volumes** `panel_data` (SQLite) und `clamav_db` (Signaturen); ClamAV braucht
  ~1,5 GB RAM zusätzlich.
- **Keine Änderungen an den n8n-Workflows** — die Workflow-Erweiterungen folgen ab Etappe 3.
- SQLite-Schema wird beim ersten Start automatisch angelegt; keine Migrationen nötig.
- Node-Basis ist 24 (better-sqlite3 v12 mit vorgebauten Binaries).

## [1.0.0.0] - 2026-08-08 (Build 1) — *Grundstein*

### Features

- **Docker-Stack** für n8n + PostgreSQL (`docker-compose.yml`): Deployment als Compose-Stack über
  Dockhand, SSL über den vorhandenen Nginx Proxy Manager (Proxy Host auf `n8n:5678`, Websockets an),
  n8n-Port 5678 veröffentlicht, Zeitzone Europe/Berlin, Credentials-Verschlüsselung per
  `N8N_ENCRYPTION_KEY` (`.env.example` als Vorlage).
- **Workflow 01 — Inbox-Triage:** Trigger für Gmail (OAuth2), Web.de und Mailcow (IMAP);
  Gemini-Klassifizierung (`gemini-2.5-flash-lite`, Free Tier, gedrosselt auf 1 Aufruf/4 s) in
  Kategorien spam/rechnung/bestellung/newsletter/persoenlich/sonstiges mit Spam-Score;
  Routing in die Ordner Quarantaene/Rechnungen/Bestellungen/Newsletter. Es wird nie gelöscht.
- **Workflow 02 — Täglicher Digest:** 7:30 Uhr, Mails der letzten 24 h aus allen drei Konten plus
  Rspamd-Quarantäne über die Mailcow-API, Zusammenfassung per Gemini, Versand per Telegram.
- **Workflow 03 — Newsletter-Cleanup:** sonntags 3:00 Uhr, Newsletter älter als 30 Tage → Archiv.
- **Workflow 04 — Bestands-Triage:** manueller Lauf für bereits vorhandene Mails,
  100 Mails je Konto und Lauf.
- **README** mit kompletter Einrichtungsanleitung (NPM, Dockhand, Gmail-OAuth, Web.de-IMAP,
  Mailcow-IMAP + API-Key, Telegram-Bot, Gemini-Key, Community-Node `n8n-nodes-imap`,
  Trockentest-Ablauf, Troubleshooting).

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Erstauslieferung** — noch nichts deployt; alle Workflows sind Import-Vorlagen mit Platzhaltern
  (Gmail-Label-IDs, Mailcow-Domain, Telegram-Chat-ID) und werden erst nach Credential-Zuordnung aktiv.
- **Keine DB-Migrationen** (Panel existiert noch nicht; n8n legt seine PostgreSQL-Datenbank beim
  ersten Start selbst an).
- Der Community-Node `n8n-nodes-imap` ist Voraussetzung für die Verschiebe-/Suchoperationen;
  ohne ihn laufen nur die Lese-Trigger.
