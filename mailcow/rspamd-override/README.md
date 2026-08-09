# Rspamd Overrides (Etappe 6)

Dieser Ordner enthält Konfigurationsdateien, die die Standard-Rspamd-Konfiguration von Mailcow überschreiben oder erweitern.
Sie werden dazu verwendet, Spam-Schwellwerte, Greylisting-Optionen oder andere Modul-Einstellungen global oder pro Domain anzupassen.

## Installation

1. Kopiere die gewünschten `.inc` oder `.conf` Dateien aus diesem Ordner in das Mailcow-Datenverzeichnis deines Servers unter:
   `/opt/mailcow-dockerized/data/conf/rspamd/override.d/`
2. Starte den Rspamd-Container neu, damit die Änderungen wirksam werden:
   `docker compose restart rspamd-mailcow`

## Enthaltene Beispiele

- `options.inc`: Überschreibt die globalen Spam-Scores (Spam, Reject, Greylisting).
- `antivirus.conf`: Konfiguration zur Einbindung von ClamAV (oder anderen AV-Scannern) direkt in Rspamd (anstelle von Postfix-MILTER), falls gewünscht.

> **Hinweis:** Die Mailcow-API erlaubt teilweise die Konfiguration von Spam-Scores pro Postfach. Globale Änderungen sollten hier in `options.inc` erfolgen.
