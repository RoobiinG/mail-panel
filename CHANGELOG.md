# Changelog — Mail-Panel

Versionsschema: `Major.Minor.Änderung.Fix` (siehe AGENTS.md, Abschnitt 2).

## [1.8.0.0] - 2026-08-11 (Build 16) — *Panel-Logs*

### Features / Bugfixes

- **Feature:** Zentrales Fehler-Logging für das gesamte Panel. Alle Backend-Fehler (Express-Exceptions, unbehandelte Promises), Frontend-JS-Fehler und Container-Statusprobleme (ClamAV, unbound) werden in einer SQLite-Tabelle (`panel_logs`) mit Ring-Buffer (max. 1000 Einträge) gespeichert.
- **Feature:** Neue Seite „Logs" im Panel mit Log-Tabelle, aufklappbarem Stack-Trace, Filtern nach Level (Error/Warn/Info), Quelle (Backend/Frontend/Container) und Freitextsuche. Pagination und optionaler Auto-Refresh (10 Sekunden).
- **Feature:** Frontend-Fehler-Handler (`window.onerror`, `onunhandledrejection`) meldet JS-Crashes automatisch an das Backend (`POST /api/logs/client`, ohne Auth).
- **Feature:** Container-Health-Check: prüft alle 5 Minuten die Erreichbarkeit von ClamAV (PING) und unbound (DNS-Auflösung) und loggt Warnungen bei Ausfall.
- **Feature:** Express Error-Handler als letzte Middleware — fängt alle unbehandelten Route-Fehler und schreibt sie ins Log statt sie nur auf die Konsole zu schreiben.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Neue Tabelle `panel_logs` mit Indizes auf `created_at` und `level`. Wird beim Start automatisch angelegt — kein manueller Eingriff nötig.
- **n8n-Workflow-Kompatibilität:** Keine Änderungen an den Workflows.
- **Neustart-/Session-Verhalten:** Der Container-Health-Check startet 30 Sekunden nach dem Backend-Start. Bestehende Sessions bleiben gültig.

## [1.7.0.3] - 2026-08-10 (Build 15) — *Hotfix: Black Screen of Death*

### Features / Bugfixes

- **Fix:** Es wurde ein Fehler behoben, bei dem das Dashboard nach dem Einloggen komplett abstürzte (schwarzer Bildschirm), wenn die Datenbank oder API noch keine gültigen Statistiken (null) zurückliefern konnte. Der Zustand wird nun korrekt abgefangen und eine hilfreiche Fehlermeldung eingeblendet.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.7.0.2] - 2026-08-10 (Build 14) — *Pride*

### Features / Bugfixes

- **Feature:** Rainbow-Flag-Design für den Footer-Bereich (Abmelden-Button & Version) in der Seitenleiste implementiert. Passt sich an die aus dem Überwachungs-Panel bekannte Einstellung `show_pride_flag` an.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.7.0.1] - 2026-08-10 (Build 13) — *Hotfix: Docker Build*

### Features / Bugfixes

- **Fix:** Der Ordner `workflows/` wurde aus der `.dockerignore` entfernt, da er ansonsten beim Docker Build-Prozess nicht gefunden werden konnte, was zum Absturz der GitHub Action führte.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.7.0.0] - 2026-08-10 (Build 12) — *Auto-Setup*

### Features / Bugfixes

- **Feature:** Automatischer Import der Basis-Workflows. Bei einer Neuinstallation (oder wenn Workflows in n8n fehlen) installiert das Panel diese nun selbstständig. Dies passiert im Hintergrund, sobald in den Einstellungen ein erfolgreicher n8n-Verbindungstest durchgeführt wird, oder wenn ein E-Mail-Konto gespeichert wird. Die `.json`-Vorlagen werden dafür direkt im Docker-Image mitgeliefert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine Änderungen an den Workflows selbst.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.6.2.0] - 2026-08-09 (Build 11) — *Wartung*

### Features / Bugfixes

- **Doku (Änderung):** In der `.env.example` wurden die Kommentarzeichen (`#`) vor den Variablen entfernt. Die Datei kann nun direkt als `.env` kopiert und verwendet werden, ohne dass Nutzer die Rauten manuell löschen müssen.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen auf bestehende Installationen.

## [1.6.1.0] - 2026-08-09 (Build 10) — *Wartung & UI*

### Features / Bugfixes

- **Deployment (Fix):** Alpine-Build-Tools (`python3`, `make`, `g++`) zum `panel/Dockerfile` hinzugefügt, um native `better-sqlite3` Kompilierungsfehler unter Node 24 zu beheben.
- **Docker-Volumes (Fix):** Berechtigungen für das `n8n_data`-Volume gefixt. Das `n8n-nodes-init` Skript läuft nun als Root zur fehlerfreien Modul-Installation und übernimmt anschließend den `chown` für den n8n-Benutzer.
- **UI (Änderung):** Anzeige der aktuellen Version und Build-Nummer im Frontend direkt unter dem Abmelden-Button (integriert über Vite `define` und Anpassung des Docker Build Contexts).

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine.
- **n8n-Workflow-Kompatibilität:** Keine Änderungen an den Workflows.
- **Neustart-/Session-Verhalten:** Bei einem Pull des neuen Images über Docker Compose startet der Stack fehlerfrei und stabil. Keine Session-Auswirkungen.

## [1.6.0.0] - 2026-08-09 (Build 9) — *Newsletter & Dashboard (Etappe 7)*

### Features

- **Newsletter-Verwaltung:** Neue Seite im Frontend, die alle von der KI erkannten Newsletter-Absender auflistet und One-Click-Abbestellen (RFC-8058) direkt aus dem Panel ermöglicht. Für reine `mailto:`-Abmeldungen wird ein n8n-Webhook getriggert.
- **Dashboard & Statistiken:** Startseite des Panels zeigt nun KPI-Karten (Mails, Spam, Phishing, Viren) und Diagramme (`recharts`) über die letzten 30 Tage. Außerdem wird der Verbindungsstatus zur n8n-Engine geprüft und angezeigt.
- **n8n Workflow Update:** Der Workflow 02 (Täglicher Digest) nutzt nun die bereinigten SQLite-Daten des Panels (`/api/internal/digest`) anstelle von teuren IMAP-Suchen. Neu hinzugekommen ist Workflow 06 für den Mailto-Newsletter-Versand.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine neuen Tabellen erforderlich; die bestehende `newsletter_senders` wird nun aktiv befüllt.
- **n8n-Workflow-Kompatibilität:** Workflow 02 (`02-daily-digest.json`) muss zwingend neu importiert werden, da die Architektur von IMAP auf REST-API umgestellt wurde. Zudem sollte Workflow 06 (`06-newsletter-unsubscribe.json`) neu importiert und mit einem SMTP-Credential versehen werden.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.5.0.0] - 2026-08-09 (Build 8) — *Passkeys, Quarantäne & Rspamd (Etappe 5 & 6)*

### Features

- **Passkeys (WebAuthn):** Unterstützung für passwortlose Anmeldung via Fingerabdruck, Face ID, Hardware-Key etc. (aus Überwachungs-Panel portiert). Backend nutzt `@simplewebauthn/server`, Frontend `@simplewebauthn/browser`.
- **Mailcow-Quarantäne (Etappe 5):** Neues Panel-Modul `Quarantäne` mit zwei Tabs. Der erste Tab zeigt KI-Klassifizierungs-Logs an, der zweite Tab listet über die Mailcow-API in Rspamd zurückgehaltene E-Mails auf. Diese können direkt gelöscht oder zugestellt werden.
- **Telegram Digest & Callback (Etappe 5):** Der tägliche Digest-Workflow in n8n (02) enthält nun Inline-Knöpfe (`Panel öffnen`, `Alle freigeben`). Zudem gibt es einen neuen Beispiel-Workflow (05), um Telegram Callbacks zu verarbeiten.
- **Rspamd-Feinschliff (Etappe 6):** Neues Panel-Modul `Rspamd`. Listet die globalen Whitelists, Blacklists und die konfigurierten Spam-Scores von Mailcow auf. Enthält außerdem einen Sync-Button, um die im Panel gepflegten Whitelists (die KI-basiert gepflegt werden) direkt als `wl_domain` / `wl_sender` in die globale Mailcow-Richtlinie zu übernehmen.
- **Rspamd Overrides (Etappe 6):** Ordner `mailcow/rspamd-override` mit Basisdatei `options.inc` hinzugefügt, um globale Spam-Schwellwerte von Mailcow zu überschreiben.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Es wurde die Tabelle `passkeys` in der Datenbank eingeführt (automatisch via `db.js` `CREATE TABLE IF NOT EXISTS`). Bestehende Setups laufen nach dem Pull problemlos weiter.
- **n8n-Workflow-Kompatibilität:** Workflow 02 (`02-daily-digest.json`) wurde um Inline-Knöpfe erweitert und sollte in n8n neu importiert werden. Für Telegram Callbacks existiert nun Workflow 05, der bei Bedarf (optional) aktiviert werden kann.
- **Neustart-/Session-Verhalten:** Login via Passkeys nutzt den regulären JWT-Flow; Sitzungen bleiben wie bisher erhalten. Für Rspamd-Änderungen in `mailcow/rspamd-override/` muss der `rspamd-mailcow` Container manuell neugestartet werden.

---

## [1.4.0.0] - 2026-08-09 (Build 7) — *ClamAV & Safe Browsing (Etappe 4)*

### Features

- **ClamAV-Integration:** Anhang-Scanner über das INSTREAM-Protokoll an clamd. E-Mails mit schädlichen Anhängen werden direkt und ohne KI-Abfrage aussortiert.
- **Safe-Browsing-Integration:** Die in der E-Mail gefundenen Links werden gegen die Google Safe Browsing API v4 geprüft (falls in den Einstellungen aktiviert). Schädliche Links fließen stark in den Spam-Score ein.
- **Workflows aktualisiert (01 & 04):** Vor der Gemini-Klassifizierung prüft ein neuer Knoten auf Anhänge. Sind welche vorhanden, fragt der Workflow den neuen Panel-Endpunkt `/api/internal/scan` ab. Bei Fund wird sofort eine Warnung per Telegram verschickt und die Mail in die Quarantäne verschoben.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **n8n-Workflow-Kompatibilität:** Da die Workflows 01 (`01-inbox-triage.json`) und 04 (`04-bestand-triage.json`) um die ClamAV-Scan-Schritte und den neuen Telegram-Warnungs-Knoten erweitert wurden, müssen bestehende Installationen diese Workflows neu importieren. Danach ist im Panel ein Klick auf „Workflows synchronisieren“ nötig, damit der Workflow-Patcher die Konto-spezifischen Trigger und Verschiebungen wieder einbaut.
- **Telegram-Warnung:** Im neu hinzugefügten Telegram-Knoten (`Virus Warnung (Telegram)`) muss der Benutzer ein gültiges Telegram-Credential auswählen und seine `chatId` eintragen, damit die sofortigen Benachrichtigungen bei Malware-Funden funktionieren.
- **Abhängigkeiten:** Keine neuen Datenbank-Migrationen erforderlich. Die `package.json` bleibt unverändert, da für den Safe-Browsing-Aufruf die native `fetch`-API genutzt wird.

---

## [1.3.0.0] - 2026-08-09 (Build 6) — *Blocklisten und eigene Listen*

### Features

- **Eigene White- und Blacklist** (neue Panel-Seite „White- / Blacklist"): Einträge als
  vollständige Adresse oder als Domain, wobei eine Domain auch alle Unterdomains abdeckt.
  Ein Absender kann nie auf beiden Listen stehen — beim Eintragen wandert er automatisch
  von der einen auf die andere.
- **DNSBL-Prüfung** der Absender-IP über den eigenen unbound-Resolver. Ein Treffer erhöht
  den Spam-Score um 0,3, mehrere um 0,6 — die endgültige Bewertung trifft weiterhin die KI.
  Listen, die den Server ablehnen, werden als solche erkannt und nicht als Treffer gewertet.
- **Prüf-Endpunkt `/api/internal/check`**: ein Aufruf beantwortet alles auf einmal.
  Reihenfolge: Whitelist gewinnt immer und beendet die Prüfung, Blacklist bedeutet direkt
  Quarantäne, sonst entscheidet die DNSBL-Abfrage über den Score-Aufschlag.
- **Prüfschritt in den Workflows 01 und 04**: Nach der Normalisierung fragt ein
  HTTP-Knoten das Panel, ein Code-Knoten führt das Ergebnis mit der Mail zusammen.
  Blacklist-Mails gehen über einen eigenen Zweig direkt in die Quarantäne — **ohne
  KI-Abfrage**, was Gemini-Kontingent spart.
- **Das Panel legt sein eigenes n8n-Credential an.** Beim ersten Konto-Sync entsteht in
  n8n automatisch ein Header-Auth-Credential mit dem Panel-Secret und wird an den
  Prüf-Knoten gehängt — niemand muss das Secret von Hand übertragen.
- **Die Normalisierung liest jetzt mehr aus der Mail**: die Absender-IP aus der obersten
  Received-Kopfzeile (private und reservierte Netze werden übersprungen), alle Links im
  Text sowie den `List-Unsubscribe`-Header für die spätere Newsletter-Verwaltung.
  Der IMAP-Trigger holt dafür das Format „resolved", der IMAP-Knoten zusätzlich die Kopfzeilen.
- Der eingestellte **Spam-Schwellwert** wird nun tatsächlich von den Workflows benutzt
  (kam vorher aus einem festen Wert im Code).

### Bugfixes

- Knoten ohne Zugangsdaten (etwa Gmail, wenn es nicht eingerichtet ist) lieferten ein
  leeres Platzhalter-Item, das als Mail ohne Absender weiterlief. Solche Items werden
  jetzt aussortiert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Workflows 01 und 04 müssen neu importiert werden** (vier neue Knoten, geänderte
  Normalisierung). Danach einmal „Workflows synchronisieren" im Panel klicken — das
  verdrahtet die Konten und das Panel-Credential neu.
- **Neue Einstellung** `n8n_panel_credential_id` in der Panel-Datenbank; keine Migration nötig.
- **Der IMAP-Trigger läuft jetzt im Format „resolved"** und legt Anhänge als Binärdaten ab.
  Das erhöht den Speicherbedarf je Ausführung etwas, ist aber Voraussetzung für den
  Virenscan in der nächsten Etappe.
- Ist das Panel nicht erreichbar, läuft die Mail ungeprüft weiter statt hängen zu bleiben.
- Auf dem Testserver verifiziert: 13 Prüfungen für Endpunkt und Listen, dazu ein
  Durchlauf von Workflow 04 mit echten Mails (IP-Erkennung, Blacklist-Zweig ohne
  KI-Abfrage, tatsächliches Verschieben in die Quarantäne).

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
