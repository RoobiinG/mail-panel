# Changelog — Mail-Panel

Versionsschema: `Major.Minor.Änderung.Fix` (siehe AGENTS.md, Abschnitt 2).

## [1.2.1.0] - 2026-08-09 (Build 5) — *Praxistest auf echtem Server*

Alle Punkte dieser Version stammen aus einem vollständigen Testlauf auf einem echten
Server (Debian 12, Docker, echtes n8n, echter Dovecot-IMAP-Server) — die Mock-Tests
hatten sie nicht zeigen können.

### Bugfixes

- **DNSBL: falsche Treffer verhindert.** Antworten aus `127.255.255.0/24` sind keine
  Treffer, sondern Fehlercodes der Liste („Abfrage abgelehnt", „Kontingent erschöpft").
  Spamhaus liefert das z.B. für Anfragen aus Rechenzentrums-Netzen ohne eigenen
  Zugangsschlüssel. Bisher hätte das jede Mail in die Quarantäne befördert.
  Der Verbindungstest zeigt jetzt an, welche Listen nutzbar sind und welche ablehnen.
- **DNSBL: Resolver wurde nie erreicht.** `dns.Resolver.setServers()` akzeptiert nur
  IP-Adressen — der Containername `unbound` führte zu „Invalid IP address". Der Name
  wird jetzt vorher aufgelöst.
- **Betreff und Absender blieben leer.** Der IMAP-Node liefert die Kopfdaten unter
  `envelope.subject` / `envelope.from[].address` und den Text als `textContent`, während
  der Trigger `subject` / `from` / `textPlain` verwendet. Die Normalisierung in den
  Workflows 01 und 04 versteht jetzt beide Formate — sonst wäre jede Bestandsmail als
  „(kein Betreff)" ohne Absender in die KI-Klassifizierung gegangen.
- **Falscher Credential-Typ und falsche Operationen.** Der Community-Node erwartet
  `moveEmail` / `getEmailsList` (nicht `move` / `getMany`), Postfach-Felder als
  resourceLocator und heißt seine Felder `sourceMailbox` / `destinationMailbox`.
  Statt eines zweiten Credential-Typs nutzt er über `authentication: coreImapAccount`
  jetzt dasselbe `imap`-Credential wie der Trigger — ein Credential pro Konto genügt.

### Verbesserungen

- **Community-Node wird automatisch installiert.** Ein Einmal-Container legt
  `n8n-nodes-imap` vor dem n8n-Start ins Volume; die manuelle Installation über die
  Oberfläche entfällt.
- **Selbstsignierte Zertifikate:** Konten können sie per Häkchen akzeptieren — üblich bei
  eigenen Mailservern. Die Einstellung wird an das n8n-Credential durchgereicht.
- **Der Verbindungstest meldet fehlende Zielordner** (Quarantaene, Rechnungen,
  Bestellungen, Newsletter), damit man sie vor dem ersten Lauf anlegen kann.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Workflows 01 und 04 neu importieren** — die Normalisierung ist geändert.
- **DB-Migration** (läuft automatisch): neue Spalte `tls_unsicher` in `accounts`.
- **Bestehende Konten neu speichern**, damit die n8n-Knoten die korrigierten Operationen
  bekommen — oder einmal auf „Workflows synchronisieren" klicken.
- Der Init-Container `n8n-nodes-init` läuft bei jedem `up -d` kurz an und beendet sich
  wieder; ist das Paket schon da, tut er nichts.
- **Gemessener RAM-Bedarf** (Leerlauf, echter Server): ClamAV 933 MB, n8n 322 MB,
  PostgreSQL 48 MB, Panel 27 MB, unbound 15 MB — zusammen rund 1,35 GB.
  Empfehlung: 4 GB, Minimum 2 GB.

## [1.2.0.0] - 2026-08-08 (Build 4) — *Konten aus dem Panel*

### Features

- **Konten-Verwaltung im Panel:** IMAP-Konten anlegen, bearbeiten, entfernen — mit
  Vorlagen für gängige Anbieter und einem Verbindungstest, der vor dem Speichern einen
  echten IMAP-Handshake macht (`imapflow`). Passwörter liegen AES-256-GCM-verschlüsselt
  in der Panel-Datenbank und werden nie an die Oberfläche zurückgegeben.
- **Automatisches n8n-Onboarding:** Beim Speichern legt das Panel das IMAP-Credential
  über die n8n-API an und verdrahtet das Konto in den Workflows 01 und 04 — Trigger,
  Konto-Kennzeichnung, Konto-Weiche und Verschiebe-Knoten. Beim Entfernen wird alles
  wieder sauber zurückgebaut, inklusive Credential. Der Sync ist idempotent und lässt
  sich über „Workflows synchronisieren" jederzeit wiederholen.
- **Installation ohne Konfiguration:** `docker compose up -d` genügt jetzt. Das Panel
  erzeugt `JWT_SECRET`, `PANEL_SECRET` und `PANEL_DB_KEY` beim ersten Start selbst und
  legt sie im Datenvolume ab; n8n erzeugt seinen Encryption-Key ohnehin selbst. Die
  Zugangsdaten zu n8n, Mailcow und Safe Browsing pflegt man in der Oberfläche statt in
  Umgebungsvariablen — Env-Variablen bleiben als Vorrang möglich.
- **Panel-Secret in der Oberfläche** sichtbar, damit es sich in die n8n-Workflows
  übernehmen lässt.

### Änderungen

- **Nur noch eine Compose-Datei.** Das Override `docker-compose.proxy.example.yml`
  entfällt; n8n (5678) und Panel (3002) veröffentlichen ihre Ports, ein Reverse Proxy
  wird einfach davorgehängt. `.env` ist jetzt komplett optional.
- **Workflows 01 und 04 umgebaut:** Die fest verdrahteten Web.de-/Mailcow-Knoten sind
  raus — diese Bereiche verwaltet jetzt das Panel. Gmail bleibt unverändert fest im
  Workflow. Der Sammel-Knoten in Workflow 04 bekommt seine Quellenliste vom Panel
  eingesetzt (Marker `PANEL:QUELLEN`).

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Workflows 01 und 04 müssen neu importiert werden** — die alten Vorlagen haben die
  Andockpunkte für den Patcher nicht. Bestehende Gmail-Credentials und Label-IDs müssen
  danach erneut zugeordnet werden. Workflows 02 und 03 sind unverändert.
- **Wer bisher ein Proxy-Netz genutzt hat**, hängt den Reverse Proxy jetzt auf
  `<server>:5678` bzw. `:3002`; `NPM_NETWORK` und `PROXY_NETWORK` entfallen.
- **Knoten mit ID-Präfix `panel-`** gehören dem Sync und werden bei jedem Konto-Sync
  neu erzeugt — Handarbeit an diesen Knoten geht verloren (im Workflow als Notiz vermerkt).
- Keine DB-Migration nötig; die Tabelle `accounts` existiert seit v1.1.0.0.
- Neue Backend-Abhängigkeit `imapflow`.
- Der n8n-API-Key muss einmalig im Panel hinterlegt werden (n8n → Einstellungen → n8n API),
  sonst schlägt die Konten-Verwaltung mit einer entsprechenden Meldung fehl.

## [1.1.1.0] - 2026-08-08 (Build 3) — *Für alle installierbar*

### Verbesserungen

- **Stack läuft jetzt ohne Vorbedingungen auf jedem Docker-Host:** Das externe
  Proxy-Netz ist keine Pflicht mehr — `docker compose up -d` genügt, n8n (5678) und
  Panel (3002) sind direkt über ihre Ports erreichbar. Wer einen containerisierten
  Reverse Proxy nutzt, hängt die Dienste über das neue Override
  `docker-compose.proxy.example.yml` ins Proxy-Netz (Env-Variable `PROXY_NETWORK`
  ersetzt `NPM_NETWORK`).
- **README verallgemeinert:** Voraussetzungen-Abschnitt, Reverse Proxy und
  Docker-Panels (NPM, Dockhand, Portainer) nur noch als Beispiele, Mailcow-Teile
  ausdrücklich optional.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Bestehende Installationen mit Proxy-Netz** müssen auf das Override-Muster wechseln
  (`docker-compose.proxy.yml` anlegen, `PROXY_NETWORK` statt `NPM_NETWORK` in der `.env`),
  sonst verlieren die Container beim nächsten `up -d` die Anbindung ans Proxy-Netz.
- Panel-Port 3002 ist jetzt standardmäßig veröffentlicht — wer das nicht will,
  beschränkt ihn auf `127.0.0.1:3002:3002` oder entfernt ihn im Override.
- Keine Änderungen an Workflows, Datenbank oder Panel-Code.

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
