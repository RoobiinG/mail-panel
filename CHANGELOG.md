# Changelog — Mail-Panel

Versionsschema: `Major.Minor.Änderung.Fix` (siehe AGENTS.md, Abschnitt 2).

## [3.6.0.1] - 2026-09-03 (Build 70) — *Erst prüfen, dann bauen*

### Geändert

- **Ein roter Testlauf verhindert jetzt den Image-Bau.** Bis hierher liefen beide nebeneinander.
  Am 2026-09-02 hat das zugeschlagen: Der Testlauf von Build 66 war rot, der Bau lief
  unbeeindruckt durch und veröffentlichte ein Abbild, dessen Oberfläche über HTTPS nicht
  erreichbar war. Grüner Haken am Repository, kaputtes Image in der Registry.

  Der Testlauf ist deshalb als Stufe `test` in `docker-build.yml` gewandert, und `build` hängt
  über `needs: test` daran. Schlägt er fehl, entsteht kein Image.

- **`tests.yml` läuft auf master nur noch für Dateien, die kein Image erzeugen** —
  `docker-compose.yml`, `.env.example`, `einrichten.sh`, `LICENSE`. Sonst würde auf jedem Push
  doppelt geprüft. Für Pull Requests bleibt er wie gehabt.

- **Der Bau springt jetzt auch bei Änderungen an `docker-compose.yml` und `.env.example` an.**
  `konfiguration.test.js` vergleicht genau diese beiden miteinander und hätte sonst nie
  angeschlagen, wenn jemand nur eine davon ändert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein. **n8n-Workflows:** Unverändert. **Panel-Code:** Unverändert.
- **Ausrollen dauert länger:** Vor jedem Image laufen erst die Tests (rund eine halbe Minute
  mit Installation der Abhängigkeiten).
- **Ein kaputter Test blockiert ab jetzt das Ausrollen.** Das ist der Zweck. Wer in einem
  Notfall daran vorbei muss, kann den Bau von Hand über *Actions → Docker Image bauen & pushen →
  Run workflow* starten — auch dann läuft die Teststufe zuerst.

## [3.6.0.0] - 2026-09-02 (Build 69) — *Aufsicht*

### Der Anlass

Die Sortierung war **sechs Tage lang aus**, und nichts hat es gemeldet. Gefunden nur, weil beim
Nachmessen auffiel, dass die letzte KI-Entscheidung vom 27. August stammte. Der Ablauf, aus dem
n8n-Log:

1. Der `dovecot`-Container starb (Neustart-Regel `no`, inzwischen behoben).
2. n8n wollte Workflow 01 aktivieren, der IMAP-Auslöser für Dovecot scheiterte mit
   `getaddrinfo ENOTFOUND dovecot`.
3. n8n rollte daraufhin die **ganze** Aktivierung zurück — auch den Gmail-Auslöser, dem nichts
   fehlte. `Rolled back partial activation`.
4. Nächster Versuch: `retry in 86400 seconds`. Einmal am Tag.

**Ein einziges kurzzeitig nicht erreichbares Postfach schaltet die Sortierung für alle anderen
mit ab.** Mit jedem weiteren Konto wird das wahrscheinlicher — und es kracht nicht, es passiert
nur nichts mehr.

### Features

- **Neue Aufsicht** (`services/aufsicht.js`). Sie vergleicht alle 15 Minuten den Soll- mit dem
  Ist-Zustand, schreibt Abweichungen ins Log und legt sie fürs Dashboard ab.

- **Sie schaltet von selbst wieder ein**, statt auf n8ns Tagesrhythmus zu warten. Scheitert das,
  wird n8ns Begründung mitgeschrieben — `ENOTFOUND dovecot` sagt schließlich präzise, welches
  Postfach klemmt. Abschaltbar über `AUFSICHT_REPARIEREN=0`, dann meldet sie nur.

- **Der Soll-Zustand kommt aus der Absicht, nicht aus einer Liste.** Was zuletzt bewusst
  eingeschaltet war, soll laufen. Schaltest du im Panel etwas ab, wird das vermerkt und danach
  nicht mehr angemahnt — sonst arbeitete die Aufsicht gegen dich. Beim allerersten Lauf gilt,
  was gerade läuft.

- **Auf dem Dashboard** steht eine rote Karte, wenn etwas nicht läuft, samt Grund und Zeitpunkt
  der letzten Prüfung. Wurde etwas selbst repariert, erscheint ein gelber Hinweis — man soll
  wissen, dass es einen Ausfall gab, auch wenn er behoben ist.

- **Ist n8n selbst nicht erreichbar**, ist das der schwerste Fall und wird als solcher gemeldet.
  Der Soll-Zustand bleibt dabei erhalten; sonst wäre nach einem Ausfall alles vergessen.

- **Neun Tests** (`test/aufsicht.test.js`, jetzt 100 insgesamt) stellen genau den Fall vom
  2. September nach: erkannt, behoben, Grund festgehalten, und bewusst Abgeschaltetes bleibt
  unangetastet.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein, nur neue Schlüssel in `settings`.
- **n8n-Workflows:** Unverändert, kein Sync nötig.
- **Beim ersten Start nach dem Update** nimmt die Aufsicht den aktuellen Zustand als Soll auf.
  Läuft zu diesem Zeitpunkt etwas nicht, das laufen sollte, gilt es fälschlich als gewollt —
  deshalb einmal auf der Workflow-Seite nachsehen und über *Aufsicht → übernehmen* neu
  aufnehmen, wenn nötig.
- **Sie schaltet Workflows selbst wieder ein.** Wer das nicht will, setzt `AUFSICHT_REPARIEREN=0`
  oder stellt es im Panel um.
- **Erste Prüfung 90 Sekunden nach dem Start** — verzögert, weil n8n nach einem gemeinsamen
  Neustart selbst noch hochfährt und sonst fälschlich als tot gälte.

## [3.5.0.2] - 2026-09-02 (Build 68) — *Fix: Einstellungen, die es gar nicht gab*

### Bugfixes

Zwei Löcher derselben Art — beschrieben, aber wirkungslos:

- **Die HTTPS-Einstellungen kamen nie im Container an.** `.env.example` erklärte `TLS_CERT`,
  `TLS_KEY`, `TLS_MODUS` und `PANEL_HOST`; die `docker-compose.yml` reichte keine davon durch.
  Wer sie eingetragen hätte, wäre auf eine Einstellung hereingefallen, die es nicht gab — der
  Container hätte weiter sein selbst erzeugtes Zertifikat benutzt, ohne ein Wort dazu.

- **`CLAMD_HOST` und `UNBOUND_HOST` standen mit festem Wert in der compose-Datei.** Damit war
  `einrichten.sh` aus Build 65 **wirkungslos**: Das Skript trägt einen gefundenen Dienst in die
  `.env` ein, und compose überschrieb ihn eine Zeile später wieder mit `clamav`. Die ganze
  Erkennung lief ins Leere.

### Features

- **Ein Test hält Beschreibung und Aufbau ab jetzt zusammen** (`test/konfiguration.test.js`).
  Er prüft, dass jede in `.env.example` beschriebene Variable in der `docker-compose.yml`
  tatsächlich benutzt wird, dass nichts fest verdrahtet ist, was `einrichten.sh` setzen soll,
  dass ClamAV und unbound hinter Profilen stehen, dass eine Lizenz existiert — und dass in den
  ausgelieferten Dateien keine echten Adressen oder Zugangsdaten stehen. Letzteres, weil man
  nicht zurückholt, was einmal veröffentlicht ist.

  Gegengeprüft: Mit dem wieder eingebauten Fehler schlägt er an und benennt beide Variablen.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein. **n8n-Workflows:** Unverändert.
- **Ab jetzt wirken die Einstellungen wirklich.** Wer `TLS_MODUS=aus` oder ein eigenes
  Zertifikat einträgt, bekommt auch das Verhalten dazu. Wer bisher nichts eingetragen hat,
  merkt nichts.
- **`docker compose up -d` allein genügt nicht** — Compose liest die geänderte Datei erst beim
  nächsten Aufruf im Projektordner. Bestehende Installationen: Datei aktualisieren, dann
  `docker compose up -d`.

## [3.5.0.1] - 2026-09-02 (Build 67) — *Fix: HTTPS hing beim Handshake*

### Bugfixes

- **Der Aufruf über `https://` blieb hängen.** Kein Fehler, kein Logeintrag — die Verbindung
  wartete einfach ewig. Ursache war die Weiche, die anhand des ersten Bytes zwischen HTTPS und
  einer HTTP-Umleitung unterscheidet: Sie las das Byte mit `once('data')`. In dieser Form
  erreichen die zurückgelegten Bytes die TLS-Schicht nicht, und der Handshake kommt nie
  zustande. Mit `read(1)` funktioniert es. Der Unterschied ist im Quelltext vermerkt, damit
  ihn niemand wegvereinfacht.

- **Build 66 hat trotzdem ein Image erzeugt.** Der Testlauf war rot, aber Testlauf und
  Image-Build hängen nicht zusammen — der Build lief unbeeindruckt durch und veröffentlichte
  ein Abbild, dessen Oberfläche über HTTPS nicht erreichbar war. **Dieses Image bitte nicht
  benutzen.** Genau die Verkettung der beiden Abläufe stand als offene Entscheidung im
  Changelog von Build 64; hier ist der Beleg, warum sie fehlt.

## [3.5.0.0] - 2026-09-02 (Build 66) — *HTTPS ab Werk, MIT-Lizenz*

### Features

- **Das Panel spricht auf seinem eigenen Port HTTPS — ohne dass jemand etwas einrichtet.**
  Bisher stand im README nur „stell dir einen Reverse Proxy davor". Wer das nicht tat, tippte
  sein Panel-Passwort über eine offene Leitung, und das Panel verwaltet IMAP-Zugangsdaten und
  zeigt Mailinhalte.

  Drei Betriebsarten:

  | Umgebung | Verhalten |
  |---|---|
  | nichts gesetzt (Standard) | erzeugt beim ersten Start ein eigenes Zertifikat im Volume |
  | `TLS_CERT` + `TLS_KEY` | benutzt genau diese Dateien (z. B. Let's Encrypt eingehängt) |
  | `TLS_MODUS=aus` | schlichtes HTTP — für alle, die schon einen Proxy davor haben |

  Nur eines von `TLS_CERT`/`TLS_KEY` zu setzen bricht den Start mit einer klaren Meldung ab,
  statt stillschweigend auf das selbst erzeugte Zertifikat zurückzufallen — sonst liefe jemand
  mit einem Behelfszertifikat, obwohl er ein echtes hinterlegen wollte.

- **Wer `http://` eingibt, wird umgeleitet.** Auf demselben Port: Ein TLS-Handshake beginnt
  immer mit dem Byte `0x16`, daran lässt sich schon an der ersten Zustellung erkennen, wohin
  die Verbindung gehört. Niemand starrt auf Kauderwelsch, weil er das `s` vergessen hat.

- **Eine Ausnahme, bewusst:** `/api/internal/…` bleibt über HTTP erreichbar. n8n ruft das Panel
  im Docker-Netz über `http://panel:3002` auf — diese Adresse steht in den Workflow-Vorlagen
  und in jedem bereits eingerichteten Workflow. Würde sie umgeleitet, bräche bei jeder
  bestehenden Installation die Sortierung, sobald jemand das Update einspielt, ohne vorher zu
  synchronisieren. Und zwar lautlos. Die Schnittstelle ist durch ein eigenes Geheimnis
  geschützt; wer auch sie nicht offen haben will, setzt `PANEL_PORT=127.0.0.1:3002`.

- **MIT-Lizenz** (`LICENSE`). Ohne sie darf ein veröffentlichtes Projekt rechtlich niemand
  benutzen.

- **Hinter einem Reverse Proxy wird nicht umgeleitet.** Reicht der Proxy
  `X-Forwarded-Proto: https` weiter — Nginx Proxy Manager, Traefik und Caddy tun das von Haus
  aus —, bedient das Panel die Anfrage einfach. Ohne diese Erkennung schickte die Umleitung
  den Browser mit `https://<name>:3002` **am Proxy vorbei** direkt auf den Port und verriete
  dabei die interne Adresse.

- **Sechs weitere Tests** (`test/tls.test.js`, jetzt 82 insgesamt). Sie fahren einen echten
  Server hoch und reden mit ihm — bei einer Verschlüsselung nützt es wenig zu prüfen, ob eine
  Funktion „durchläuft".

### Geändert

- **HSTS nur noch bei einem echten Zertifikat.** Der Kopfzeile folgend ruft ein Browser die
  Adresse ein Jahr lang ausschließlich über HTTPS auf. Bei einem selbst erzeugten Zertifikat
  wäre das eine Falle: Wer später auf HTTP zurückgeht oder einen Proxy davorsetzt, käme ein
  Jahr lang nicht mehr an sein Panel.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein.
- **n8n-Workflows:** Unverändert, und das ist der Grund für die Ausnahme oben. Kein Sync nötig.
- **Die Adresse ändert sich:** Das Panel ist nach dem Update unter **`https://…:3002`**
  erreichbar statt `http://…:3002`. Der alte Aufruf leitet weiter, es geht also nichts
  verloren — aber Lesezeichen zeigen auf die Umleitung.
- **Beim ersten Start nach dem Update** entsteht `/app/data/tls/panel.{crt,key}`. Das Erzeugen
  dauert einen Moment; im Log steht, für welche Namen das Zertifikat gilt.
- **Image:** `openssl` ist neu im Abbild — damit erzeugt das Panel das Zertifikat.
- **Wer schon einen Reverse Proxy hat**, setzt `TLS_MODUS=aus`. Sonst verschlüsseln Proxy und
  Panel dasselbe zweimal hintereinander.

## [3.4.0.0] - 2026-09-02 (Build 65) — *Nicht installieren, was schon da ist*

### Features

- **ClamAV und unbound werden nicht mehr blind mitinstalliert.** Beide sind auf vielen
  Servern längst vorhanden — Mailcow liefert sie mit. Ein zweites ClamAV daneben kostet rund
  **1,5 GB Arbeitsspeicher**, ohne irgendetwas zu können, was das vorhandene nicht könnte, und
  zwar ausgerechnet auf der Maschine, die die Post ausliefert.

  Neu ist `einrichten.sh`: Es sieht einmal nach, was läuft, fragt nach und schreibt das
  Ergebnis in die `.env`. Danach genügt in jedem Fall ein schlichtes `docker compose up -d`.

  | Gefunden | Was eingetragen wird |
  |---|---|
  | nichts | `COMPOSE_PROFILES=clamav,unbound` — der Stack startet beide selbst |
  | ein fremder ClamAV-Container | `CLAMD_HOST=<name>`, das eigene bleibt aus |
  | ClamAV auf dem Host (Port 3310) | `CLAMD_HOST=172.17.0.1` |

  Liegt ein gefundener Dienst in einem eigenen Docker-Netz, nennt das Skript den
  `docker network connect`-Befehl, mit dem das Panel dort hineinkommt — auf Wunsch führt es
  ihn gleich aus. Ohne Terminal sagt es nur, was zu tun ist, und startet von sich aus nichts:
  Ein unbeaufsichtigtes Skript soll keine Dienste hochfahren.

  Die beiden Dienste stehen dafür hinter Compose-Profilen. Wer die `.env` von Hand pflegt,
  findet alles in `.env.example` erklärt.

### Aufräumen

- **`update.tar.gz` aus dem Repository entfernt.** Ein versehentlich eingechecktes Archiv des
  Repositorys selbst (244 KB). Steht jetzt in `.gitignore`.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein.
- **n8n-Workflows:** Unverändert.
- **Bestehende Installationen:** `docker compose up -d` **ohne** `.env` startet ClamAV und
  unbound ab jetzt **nicht** mehr — sie hängen an Profilen. Wer sie weiter mitlaufen lassen
  will, legt eine `.env` mit `COMPOSE_PROFILES=clamav,unbound` an oder ruft einmal
  `./einrichten.sh` auf. Bereits laufende Container bleiben davon unberührt, bis das nächste
  `docker compose up -d` sie abräumt.
- **Virenscan:** Ohne erreichbares ClamAV wird nicht gescannt; das Panel meldet das im Log als
  Warnung und sortiert weiter.

## [3.3.0.0] - 2026-09-02 (Build 64) — *Testlauf*

### Features

- **76 automatisierte Tests**, ausführbar mit `npm test` im Backend, und eine CI-Stufe, die sie
  bei jeder Änderung an `panel/backend/` laufen lässt. Bisher gab es keine einzige Prüfung, die
  von selbst anschlägt — jeder Fehler der letzten Woche wurde mit einem Wegwerf-Skript gefunden,
  das danach verschwand. Damit konnte jeder dieser Fehler jederzeit zurückkommen, ohne dass es
  jemand bemerkt.

  Die Sammlung ist kein Selbstzweck, sondern das Gedächtnis des Projekts: **Jeder Fall darin
  stand einmal für einen echten Fehler.**

  | Datei | Was festgehalten wird |
  |---|---|
  | `sortierung.test.js` | Absender-Erkennung, Domain-Vergleich, UID-Normalisierung |
  | `themen.test.js` | die Ordnernamen-Prüfung gegen eingeschleuste Vorschläge |
  | `sicherung.test.js` | Verschlüsselung hin und zurück, mbox, tar, FTP-Fehlertexte |
  | `bestand.test.js` | der Stapel-Umzug samt Dubletten und veralteten Einträgen |

  Besonders festgezurrt sind die Fälle, die im Betrieb nicht auffallen, weil nichts kracht:
  ein gefälschter Anzeigename (`"rechnung@sparkasse.de" <betrueger@boese.example>`), eine
  angehängte Fremddomain (`example.com.boese.example`), `"28"` gegen `"28.0"`, und eine Mail,
  die nicht mehr im Posteingang liegt und trotzdem als verschoben gemeldet wurde.

  Die IMAP-Schicht wird für die Tests ersetzt, nicht aufgerufen — ein Test, der einen echten
  Mailserver braucht, läuft in der CI nicht, und ein Test, der nicht läuft, schützt vor nichts.

### Bugfixes — beide vom neuen Testlauf gefunden

- **Steuerzeichen im Ordnernamen wurden geglättet statt abgewiesen.** Aus
  `"Ordner\r\nA001 DELETE INBOX"` machte das Zusammenfassen von Leerraum ein
  `"Ordner A001 DELETE INBOX"` — ein Name, der jede weitere Prüfung besteht, obwohl er
  eingeschleusten Text enthielt. Steuerzeichen führen jetzt sofort zur Ablehnung, **bevor**
  irgendetwas geglättet wird. Dass imapflow Ordnernamen ohnehin quotiert, macht das nicht
  harmlos: Eine Abwehr darf sich nicht darauf verlassen, dass die nächste Schicht sauber
  arbeitet.

- **Der Dateiname im Sicherungsarchiv ließ `..` stehen.** Ohne Schrägstriche wäre daraus kein
  Verzeichniswechsel geworden, aber ein Archiv soll auch dann harmlos sein, wenn es jemand mit
  einem anderen Werkzeug auspackt als unserem. Doppelte Punkte werden jetzt zusammengezogen,
  und ein Name, der nur noch aus Trennzeichen besteht, wird zu „Ordner".

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein. Die Tests legen ihre eigene Datenbank in einem Wegwerf-Ordner an
  (`DATA_DIR`) und fassen keine vorhandenen Daten an.
- **n8n-Workflows:** Unverändert.
- **CI:** Neue Datei `.github/workflows/tests.yml`, Node 22 wie im Image. Der Image-Build läuft
  weiterhin unabhängig — wer will, dass ein roter Testlauf den Build verhindert, muss die beiden
  Workflows verketten.
- **Ordnernamen:** Die KI kann ab jetzt keine Namen mehr mit Steuerzeichen vorschlagen. Bestehende
  Ordner sind nicht betroffen; es wird nichts umbenannt.

## [3.2.0.2] - 2026-09-02 (Build 63) — *Fix: „(control socket)" sagte niemandem etwas*

### Bugfixes

- **FTP-Fehler kamen unübersetzt aus der Bibliothek durch.** Ein falscher Port meldete sich als
  `Timeout (control socket)` — eine Meldung, aus der niemand ableiten kann, was zu tun ist. Der
  konkrete Anlass: Bei Hetzner-Storage-Boxen ist **Port 23 der SSH-Zugang**, FTP läuft auf **21**.
  Wer 23 einträgt, landet auf OpenSSH, und die Bibliothek wartet vergeblich auf eine FTP-Begrüßung.

  Die Verbindungsprüfung hört jetzt zuerst hin, was auf dem Port antwortet. Meldet sich dort SSH,
  steht das wörtlich in der Fehlermeldung — samt Hinweis auf Port 21. Auch die übrigen Fälle sind
  übersetzt: Name nicht auflösbar, Verbindung abgelehnt, Zugangsdaten abgelehnt, Zertifikat nicht
  überprüfbar (mit Hinweis auf den passenden Haken), Zugriff auf das Verzeichnis verweigert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein.
- **n8n-Workflows:** Unverändert.
- **Verhalten:** Die Verbindungsprüfung baut eine zusätzliche, sehr kurze Verbindung auf, um die
  Begrüßung zu lesen. Beim regulären Hochladen passiert das nur im Fehlerfall.

## [3.2.0.1] - 2026-09-02 (Build 62) — *Fix: Sicherung verschwieg ein fehlendes Postfach*

### Bugfixes

- **Eine Sicherung, der ein ganzes Postfach fehlt, meldete sich als fertig.** Aufgefallen beim
  Nachmessen: Der Probelauf gab `ok: true` und „56 Mails" zurück, obwohl das Dovecot-Konto
  überhaupt nicht erreichbar war und mit null Mails im Bericht stand. Wer sich darauf verlässt,
  merkt den Verlust erst, wenn er die Sicherung braucht.

  Der Lauf trägt jetzt `unvollstaendig` samt Begründung je Konto. Die Oberfläche zeigt das rot
  über dem letzten Stand, und der Logeintrag wechselt von `info` auf `warn`. Hochgeladen wird
  weiterhin — ein Teilstand ist mehr wert als keiner —, aber er ist als solcher gekennzeichnet.

- **Kam von keinem einzigen Konto etwas an, wurde ein leeres Archiv erzeugt und hochgeladen.**
  Das ist schlimmer als ein Fehlschlag, weil es über die Aufbewahrungsgrenze einen älteren,
  brauchbaren Stand verdrängt hätte. Jetzt bricht der Lauf mit den Gründen ab.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein. `sicherung_letzter_lauf` bekommt zwei zusätzliche Felder; ältere
  Einträge ohne sie werden weiterhin angezeigt.
- **n8n-Workflows:** Unverändert.
- **Betrieb:** Am Testserver war der `dovecot`-Container seit vier Tagen aus — als einziger
  Container mit der Neustart-Regel `no`. Er wurde gestartet und auf `unless-stopped` gesetzt,
  wie alle anderen.

## [3.2.0.0] - 2026-09-02 (Build 61) — *Keine Browser-Dialoge mehr*

### Features

- **`alert()` und `confirm()` sind restlos verschwunden.** 24 Meldungen und 10 Rückfragen liefen
  bisher über die grauen Kästen des Browsers. Die reißen einen aus der Arbeit, sehen auf jedem
  System anders aus, blockieren die ganze Seite und stellen dem Text ungefragt den Hostnamen des
  Servers voran.

  An ihrer Stelle steht jetzt `components/ui/Meldungen.jsx`:
  - `melden(text, art)` blendet unten rechts eine Karte im Panel-Stil ein, die von selbst wieder
    verschwindet — Fehler bleiben doppelt so lange stehen wie Erfolgsmeldungen, weil man sie
    lesen will.
  - `nachfragen({…})` stellt die Rückfrage als Dialog im Panel-Stil und liefert ein Versprechen,
    sodass die Aufrufstelle lesbar bleibt. Escape bricht ab, Enter bestätigt. Löschungen sind rot
    hervorgehoben und beschreiben jetzt die Folge, statt nur „wirklich löschen?" zu fragen.

### Bugfixes

- **„Verbindung prüfen" und „Probelauf" arbeiteten auf dem gespeicherten Stand, nicht auf dem
  Formular.** Wer seine FTP-Zugangsdaten eintippte und gleich auf Prüfen drückte, bekam
  „Noch nicht vollständig: FTP-Server, FTP-Benutzer, FTP-Passwort" — obwohl alles sichtbar im
  Formular stand. Das sah aus, als ließe sich nichts speichern. Beide Schaltflächen übernehmen
  die Angaben jetzt zuerst. Aus demselben Grund ist „Jetzt sichern" nicht mehr gesperrt, solange
  nur der gespeicherte Stand unvollständig ist.

- **Ein Schreibfehler im Arbeitsverzeichnis meldete sich als „Datei nicht gefunden".** Der
  Schreibstrom hatte keinen Fehler-Zuhörer; sein Fehlschlag fiel erst weiter unten beim `stat()`
  auf — an einer Stelle, die auf die falsche Fährte führt. Jetzt wird der Fehler dort gemeldet,
  wo er entsteht. Zusätzlich prüft der Lauf vorab, ob das Panel im Arbeitsverzeichnis überhaupt
  schreiben darf, und nennt im Fehlerfall den Befehl, der es geraderückt.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein.
- **n8n-Workflows:** Unverändert.
- **Sitzungen/Neustart:** Keine Auswirkung.
- **Sichtbare Änderung:** Alle Rückmeldungen erscheinen ab jetzt in der Seite statt im Browser.
  Wer Löschungen bisher blind mit Enter bestätigt hat, sollte kurz hinsehen — der neue Dialog
  bestätigt zwar ebenfalls mit Enter, benennt aber die Folge.
- **Rechte auf dem Datenträger:** Wurde `/app/data` einmal von einem Wartungsbefehl als root
  angelegt, kann der als `node` laufende Dienst dort nicht schreiben. Geraderücken mit
  `docker exec -u root mail-panel chown -R node:node /app/data`.

## [3.1.0.2] - 2026-08-28 (Build 60) — *Nachzügler zur Postfach-Sicherung*

### Bugfixes

- **Ereignis-Zuhörer sammelten sich beim Packen an.** Jeder Ordner wurde mit `pipeline()` an den
  offenen tar-Strom gehängt; weil der Strom offen bleiben muss, räumt Node die Zuhörer dabei nicht
  wieder ab. Schon bei zwölf Ordnern warnte er, bei fünfzig wäre es ein echtes Leck geworden.
  Angehängt wird jetzt in Stücken mit Rückstau-Beachtung — das hält den Speicherbedarf auch bei
  großen Ordnern klein.

- **`wiederherstellen.js` liegt jetzt im Image** (`/app/wiederherstellen.js`). Wer nur den
  Container hat und eine Sicherung zurückholen will, kam sonst nicht an das Skript heran.

### Geprüft

Probelauf gegen die echten Postfächer: 77 Mails gesichert, 77 im Postfach vorhanden, 77 nach dem
Auspacken wieder da. 55 Gmail-Dubletten aus „Alle Nachrichten" korrekt übersprungen. Falsches
Passwort und nachträglich verändertes Archiv werden abgewiesen.

## [3.1.0.1] - 2026-08-28 (Build 59) — *Fix: Build 58 ließ sich nicht bauen*

### Bugfixes

- **Falscher Import-Pfad in der neuen Sicherungs-Seite.** `Sicherung.jsx` holte `api` aus
  `../lib/api`; die Datei liegt aber unter `src/api.js`, so wie es alle anderen Seiten auch
  machen. Der Docker-Build von Build 58 scheiterte daran, es wurde also **kein Image erzeugt** —
  3.1.0.0 ist nie irgendwo gelaufen.

  Damit das nicht wieder erst in der CI auffällt, prüft ein Skript im Arbeitsverzeichnis jetzt
  vor dem Commit, ob sich **jeder relative Import** im Frontend auflösen lässt. Das dauert eine
  Sekunde, der fehlgeschlagene CI-Lauf dagegen mehrere Minuten.

## [3.1.0.0] - 2026-08-28 (Build 58) — *Postfach-Sicherung*

### Features

- **Ganze Postfächer sichern.** Neue Seite *Verwaltung → Sicherung*. Das Panel holt alle Mails
  aller Konten über IMAP, packt sie zusammen, verschlüsselt das Archiv und legt es auf einen
  FTP-Server. Gelesen wird nur — im Postfach ändert sich dabei nichts.

- **Verschlüsselt, bevor etwas den Server verlässt.** AES-256-GCM, der Schlüssel wird mit scrypt
  aus einem Passwort abgeleitet. Auf dem FTP-Server liegt danach der vollständige Mailbestand;
  wer dort Zugriff hat — der Anbieter, ein Mitbenutzer, ein Angreifer — kann damit nichts
  anfangen. GCM erkennt zusätzlich jede nachträgliche Veränderung: Ein beschädigtes oder
  manipuliertes Archiv fällt beim Öffnen auf, statt halb ausgepackt zu werden.

- **Das Archiv ist ohne das Panel zu öffnen.** Es ist ein gewöhnliches `tar.gz` mit je einer
  `.mbox`-Datei pro Ordner — mbox liest jedes Mailprogramm. Dazu liegt `panel/wiederherstellen.js`
  bei: ein eigenständiges Skript, das nur Node braucht, keine Pakete, keine Datenbank, kein
  laufendes Panel. Im Kopf des Skripts steht das Dateiformat ausgeschrieben, sodass man notfalls
  auch mit `openssl` herankommt. Eine Sicherung, die sich nur mit der Software öffnen lässt, die
  gerade ausgefallen ist, wäre keine.

- **Jede Sicherung liest sich selbst gegen.** Vor dem Hochladen wird das fertige Archiv wieder
  entschlüsselt und mit dem Ausgangsstand verglichen. Schlägt das fehl, wird nichts hochgeladen
  und der Lauf als Fehler gemeldet.

- **Probelauf.** Baut und prüft das Archiv, lädt aber nichts hoch und setzt den Zeitplan nicht
  zurück. Damit lässt sich die Sicherung ausprobieren, bevor überhaupt ein FTP-Zugang eingerichtet
  ist.

- **FTPS ist Standard, einfaches FTP möglich.** Ohne TLS geht das FTP-Passwort im Klartext durchs
  Netz; das Archiv bleibt zwar verschlüsselt, der Zugang zum Server aber nicht. Die Oberfläche
  sagt das an der Stelle, an der man den Haken entfernt.

- **Zeitplan ohne neuen Zeitplaner.** Stündlich wird nachgesehen, ob der letzte Lauf lange genug
  her ist; der Zeitpunkt steht in den Einstellungen, nicht im Arbeitsspeicher. Ein Neustart
  verschiebt den Plan deshalb nicht. Standard ist wöchentlich, acht Stände werden aufgehoben,
  ältere räumt das Panel auf dem FTP-Server weg.

- **Dubletten überspringen.** Gmail führt jede Nachricht zusätzlich in „Alle Nachrichten". Ohne
  diese Bereinigung läge jede Mail doppelt im Archiv. Die echten Ordner werden zuerst gesichert,
  damit eine Mail dort landet, wo sie einsortiert ist, und nicht im Sammelordner.

### Technisches

- Neue Abhängigkeit: `basic-ftp` (^6.2.1) — zieht selbst nichts nach und wird erst geladen, wenn
  wirklich hochgeladen wird. Das `tar` schreibt das Panel selbst (rund fünfzig Zeilen ustar);
  dafür lohnt keine Abhängigkeit, die man dauerhaft auf Sicherheitslücken beobachten muss.
- Neu: `services/postfachSicherung.js`, `routes/sicherung.js`, `pages/Sicherung.jsx`,
  `panel/wiederherstellen.js`.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein. Nur neue Schlüssel in `settings`, die beim ersten Speichern entstehen.
- **n8n-Workflows:** Unverändert. Die Sicherung läuft vollständig im Panel, kein Sync nötig.
- **Sitzungen/Neustart:** Keine Auswirkung.
- **Ohne Einrichtung passiert nichts.** Der Zeitplan bleibt still, solange Archiv-Passwort und
  FTP-Zugang fehlen; die Bibliothek wird dann gar nicht erst geladen.
- **Platzbedarf:** Beim Lauf entstehen unter `/app/data/sicherung-arbeit` kurzzeitig
  unverschlüsselte Zwischenstände in der Größe des Postfachs. Sie werden in jedem Fall wieder
  gelöscht, auch wenn der Lauf scheitert.
- **Rechte:** Die Seite hängt am Recht `einstellungen`.
- **Das Archiv-Passwort ist nicht wiederherstellbar.** Geht es verloren, ist keine ältere
  Sicherung mehr zu öffnen. Es wird verschlüsselt gespeichert und nie an die Oberfläche
  zurückgegeben.

## [3.0.0.3] - 2026-08-28 (Build 57) — *Fix: Workflow 03 räumte ins Leere*

### Bugfixes

- **Das wöchentliche Newsletter-Aufräumen lief gegen Ordner, die es nicht gab.** Fehlten am Konto
  der Newsletter- oder der Archiv-Ordner, fielen die Namen still auf `Newsletter` und `Archiv`
  zurück. Die wenigsten Postfächer haben genau diese Ordner — der Workflow suchte also Woche für
  Woche in einem Ordner, den es nicht gibt, und niemand erfuhr davon.

  Jetzt wird für ein Konto ohne diese Angaben **gar kein Knoten** gebaut. Lieber nicht aufräumen
  als so tun, als würde man. Bleibt kein einziges Konto übrig, schaltet sich der Workflow ab,
  statt eine Automatik vorzutäuschen, die nichts tut.

- **Der Konten-Sync meldete „alles gut", auch wenn er einen Workflow übersprungen hatte.** Die
  Hinweise, die er dabei erzeugt, wurden verworfen. Genau deshalb blieb der Punkt oben so lange
  unbemerkt. Sie stehen jetzt in der Rückmeldung auf der Konten-Seite.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Nein.
- **n8n-Workflows:** Workflow 03 wird beim nächsten Konten-Sync neu gebaut. Wer Newsletter- und
  Archiv-Ordner gesetzt hat, merkt nichts; wer sie nicht gesetzt hat, bei dem verschwinden die
  wirkungslosen Knoten und der Workflow schaltet sich ab.
- **Sitzungen/Neustart:** Keine Auswirkung.

## [3.0.0.2] - 2026-08-28 (Build 56) — *Fix: Sortier-Inbox zeigte Karteileichen*

### Bugfixes

Drei Symptome, eine Ursache — deshalb ein Eintrag.

- **„X von Y verschoben (4 Fehler)" bei jedem Versuch aufs Neue.** Die gescheiterten Mails lagen
  gar nicht mehr im Posteingang: Sie waren vorher schon einsortiert worden. Die gespeicherte UID
  gilt nur für den Posteingang und trifft danach nichts mehr — der Umzug scheiterte, die Zeile
  blieb aber auf `offen` stehen und scheiterte beim nächsten Mal wieder. Eine Sackgasse, aus der
  man als Nutzer nicht herauskam.

  Ursache dahinter ist ein Wettlauf: Die Bestands-Triage braucht wegen der 4-Sekunden-Drossel bei
  100 Mails rund sieben Minuten. Wird in dieser Zeit von Hand sortiert, meldet der Lauf am Ende
  Mails zurück, die den Posteingang längst verlassen haben.

  Solche Zeilen werden jetzt als erledigt geschlossen statt als Fehler gezählt — sie sind keiner:
  Die Mail ist ja bereits am Ziel.

- **Dieselbe Mail stand mehrfach in der Liste.** Die Prüfung auf schon vorhandene Einträge
  verglich die UID als **Text**. Ältere Zeilen tragen sie als `28.0`, neuere als `28` — für
  SQLite zwei verschiedene Werte, also wurde jedes Mal ein neuer Eintrag angelegt. Der Vergleich
  läuft jetzt über `CAST(uid AS INTEGER)`, die UID wird beim Schreiben auf eine ganze Zahl
  normalisiert, und eine Migration begradigt den Bestand in `sort_inbox` und `quarantine_log`.
  Dadurch waren auch die Zähler falsch: Die Gruppe „7 Mails" enthielt in Wahrheit vier.

- **Die Liste gleicht sich jetzt mit dem Postfach ab.** Beim Laden der Sortier-Inbox wird je Konto
  geprüft, welche UIDs wirklich im Posteingang liegen; alles andere fliegt raus. Gedrosselt auf
  einmal pro Minute je Konto, damit nicht jeder Klick eine IMAP-Verbindung kostet — Mailserver
  begrenzen die (Dovecot standardmäßig auf zehn je Adresse).

- **Das Feld für den Zielordner war auf wenige Pixel zusammengequetscht** und damit unbenutzbar.
  Formularelemente stehen im Panel global auf `w-full`; die Regel-Auswahl daneben nahm sich
  dadurch die ganze Zeile. Sie nimmt das jetzt ab Breite `sm` zurück, das Eingabefeld bekommt
  `min-w-0`.

- **Die Meldung nach dem Stapel-Umzug nennt jetzt Ross und Reiter** — welche Mail nicht bewegt
  wurde und warum, statt nur einer Zahl. Veraltete Einträge werden getrennt ausgewiesen, weil sie
  kein Fehler sind.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Ja, aber ohne Schemaänderung. Ein einmaliges `UPDATE` begradigt vorhandene
  UID-Werte der Form `28.0` in `sort_inbox` und `quarantine_log`. Läuft beim Start, ist
  wiederholbar und braucht keine Handgriffe.
- **n8n-Workflows:** Unverändert. Kein Neuimport, kein Sync nötig — die Code-Knoten sind nicht
  betroffen, die Marke bleibt `PANEL:THEMEN v3`.
- **Sitzungen/Neustart:** Keine Auswirkung, niemand wird abgemeldet.
- **Sichtbare Folge beim ersten Aufruf:** Die Sortier-Inbox wird beim ersten Laden nach dem
  Ausrollen deutlich kürzer. Das ist beabsichtigt — die verschwundenen Einträge waren Dubletten
  und Mails, die längst einsortiert sind. Es geht dabei keine Mail verloren; geschlossen werden
  nur Panel-Einträge, nie etwas im Postfach.
- **IMAP-Last:** Ein zusätzlicher, kurzer Verbindungsaufbau je Konto und Minute beim Betrachten
  der Sortierseite.

## [3.0.0.1] - 2026-08-27 (Build 55) — *Fix: Korrektur meldete Erfolg, ohne zu verschieben*

### Bugfixes

- **Die Korrektur-Schleife verschob nichts und meldete trotzdem Erfolg.** Aufgefallen im
  End-to-End-Test: Das Panel antwortete `verschoben: true`, die Ordnerstände blieben aber
  unverändert.

  Ursache: **IMAP vergibt UIDs je Ordner.** Im Log steht die UID aus dem Posteingang; sobald die
  Mail in den Zielordner gewandert ist, hat sie dort eine andere. Die alte zeigt ins Leere — oder,
  bei entsprechender Belegung, auf eine **völlig andere Nachricht**, die dann fälschlich
  verschoben worden wäre. Die Korrektur sucht die Mail jetzt im Zielordner über Absender und
  Betreff; passen mehrere (wiederkehrende Newsletter), wird die neueste genommen und das gesagt.

- **`messageMove` meldet keinen Fehler, wenn die UID nicht existiert** — es passiert schlicht
  nichts. Beide Verschiebe-Wege prüfen jetzt die `uidMap` der Antwort und zählen nur, was
  tatsächlich bewegt wurde. Das betraf auch den Massenumzug beim Stapel-Sortieren: Dort wären
  nicht gefundene Mails als verschoben gemeldet worden.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. Die Spalte `quarantine_log.uid` bleibt — sie dokumentiert, aus
  welcher Nachricht der Eintrag stammt, wird für das Verschieben aber nicht mehr benutzt.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig. **Neustart**: ausreichend.

## [3.0.0.0] - 2026-08-27 (Build 54) — *Feature: Korrektur-Schleife*

> Die zweite Stelle bleibt laut Versionsschema einstellig. Nach `2.9` läuft sie über, deshalb
> springt die erste Stelle — ein reiner Überlaufzähler, kein Bruch in der Anwendung.

### Features

- **„War falsch" — und die Sortierung lernt daraus.** Bisher sah man eine Fehlentscheidung, schob
  die Mail von Hand im Mailprogramm um, und die KI traf beim nächsten Mal dieselbe Entscheidung.
  Auf der Seite *Sortierung* steht jetzt eine Liste **Letzte Entscheidungen** mit Absender,
  Betreff, erkanntem Thema samt Sicherheit und Zielordner. Ein Klick auf *War falsch* öffnet die
  Korrektur: richtiger Ordner eintragen, wählen was gemerkt werden soll — und das Panel
  - **verschiebt die Mail** aus dem falschen in den richtigen Ordner (per IMAP, aus dem
    Zielordner heraus, nicht aus dem Posteingang),
  - **legt eine Regel an** für den Absender oder die ganze Domain; zeigt eine bestehende Regel auf
    den falschen Ordner, wird sie umgebogen statt eine zweite danebenzustellen,
  - **zieht alles Wartende nach**, was zur neuen Regel passt.

  Ist die Mail inzwischen von Hand verschoben oder gelöscht worden, wird das gemeldet — die Regel
  entsteht trotzdem, denn die ist der eigentliche Gewinn.

### Bugfixes

- **Die Bremse für KI-Entwürfe war über IPv6 umgehbar.** Ihr Schlüsselgenerator nutzte `req.ip`
  direkt; damit bekommt jede einzelne IPv6-Adresse einen eigenen Zähler, und wer ein Präfix hat
  (die meisten Anschlüsse), konnte durch Adresswechsel beliebig viele Entwürfe erzeugen und so das
  Gemini-Kontingent verbrennen. Jetzt fasst `ipKeyGenerator` ein ganzes `/56` zu einem Schlüssel
  zusammen. Aufgefallen ist das durch eine Warnung von `express-rate-limit 8` — die Anmelde-Bremse
  war nie betroffen, sie nutzt den Standardgenerator.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: zwei neue Spalten in `quarantine_log` (`uid`, `korrigiert_zu`). Laufen beim
  Start automatisch.
- **Ältere Einträge lassen sich nicht vollständig korrigieren:** Ihnen fehlt die `uid`, weil die
  erst ab dieser Version mitgeschrieben wird. Für sie entsteht die Regel, die Mail selbst bleibt
  liegen — das Panel sagt das dazu.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig. **Neustart**: ausreichend.

## [2.9.1.0] - 2026-08-27 (Build 53) — *Abhängigkeiten nachgezogen*

Vier Pakete hingen bei ihrer Hauptversion zurück. Keines hatte eine bekannte Lücke — das hier ist
Wartung, damit der Abstand nicht so groß wird, dass ein Update später riskant ist.

### Änderungen

| Paket | von → nach | Anmerkung |
|---|---|---|
| `bcryptjs` | 2.4.3 → ^3.0.3 | **Bestehende Passwörter funktionieren weiter** — vorab geprüft |
| `better-sqlite3` | ^12.2.0 → ^13.0.3 | natives Modul, wird beim Abbild-Bau übersetzt |
| `dotenv` | ^16.4.5 → ^17.4.2 | `config({ quiet: true })`, sonst ein Hinweis in jedem Start-Log |
| `express-rate-limit` | ^7.3.1 → ^8.6.2 | `max:` heißt jetzt `limit:` — drei Stellen angepasst |

**Zum Passwort-Wechsel im Detail**, weil daran die Anmeldung hängt: Vorab in einem eigenen
Container geprüft, dass ein mit 2.4.3 erzeugter Hash von 3.0.3 weiterhin verifiziert wird und ein
falsches Passwort weiterhin abgelehnt. Ebenfalls geprüft, dass `require('bcryptjs')` die
Funktionen direkt liefert — Version 3 ist ESM-first, und ein `.default` davor hätte jede Anmeldung
lahmgelegt. Neu vergebene Passwörter tragen künftig das Präfix `$2b$` statt `$2a$`; beides ist
gültiges bcrypt und wird gegenseitig verstanden.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. Gespeicherte Passwort-Hashes bleiben unverändert gültig.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig.
- **Neustart**: ausreichend.
- **`express` bleibt bewusst bei 4.** Der Sprung auf 5 tauscht `path-to-regexp` und ändert das
  Verhalten des Query-Parsers; die SPA-Rückfallroute ist ein regulärer Ausdruck. Das bekommt einen
  eigenen Durchgang mit eigener Prüfung.

## [2.9.0.1] - 2026-08-27 (Build 52) — *Fix: vite mit hoher Schwachstelle*

### Bugfixes

- **`vite` von `^5.2.11` auf `^6.4.3`.** Die Prüfung meldete für `vite <= 6.4.2` drei Advisories,
  eines davon **hoch**: Path Traversal in der `.map`-Behandlung optimierter Abhängigkeiten,
  Umgehung von `server.fs.deny` über Windows-Alternativpfade, und NTLMv2-Hash-Preisgabe über
  UNC-Pfade unter Windows.

  **Betroffen ist der Entwicklungsserver, nicht die Auslieferung.** `vite` ist eine reine
  Build-Abhängigkeit; im fertigen Abbild steckt nur das gebaute Frontend, kein vite. Wer das Panel
  betreibt, war nie exponiert. Wer daran **entwickelt**, schon: Zwei der drei Lücken sind
  Windows-spezifisch und greifen, während `npm run dev` läuft.

  Angehoben wurde auf die kleinste Fassung, die es behebt — `6.4.3` statt des von npm
  vorgeschlagenen Sprungs auf 8. `@vitejs/plugin-react 4.7.0` deckt `vite ^6` bereits ab und
  bleibt unverändert; die Build-Konfiguration nutzt nichts, was sich zwischen 5 und 6 geändert hat.

### Hinweis zur Messung

Der Befund war in einer eigenen Prüfung zunächst **nicht** zu sehen: `npm audit` unter Node 22
(npm 10.9.8) meldete null hohe, unter Node 20 (npm 10.8.2, wie die CI) dagegen eine. Dazu kommt,
dass das Projekt **keine `package-lock.json` mitführt** — wer gegen eine lokal vorhandene prüft,
misst einen Baum, der so nie gebaut wird. Maßgeblich ist die frische Auflösung mit der
Node-Version der CI.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. **n8n-Workflows**: unverändert, kein Sync nötig. **Neustart**: ausreichend.
- **Wer lokal entwickelt**, sollte `node_modules` im Frontend einmal neu aufbauen, damit die alte
  vite-Fassung verschwindet.

## [2.9.0.0] - 2026-08-27 (Build 51) — *Sicherheits-Härtung*

> Build 50 scheiterte am Frontend-Build (eine react-router-Version, die es nicht gibt) und wurde
> nie veröffentlicht. Build 51 ist die erste ausgelieferte Fassung dieser Version.

Ergebnis einer Durchsicht von Abhängigkeiten, Angriffsfläche und Container-Aufbau.
Die Backend-Abhängigkeiten hatten dabei **0 Schwachstellen** (`npm audit`); die folgenden Punkte
sind Härtung, keine ausgenutzten Lücken.

### Features

- **Sicherheits-Kopfzeilen über `helmet`.** Das Panel lieferte bisher **keine** einzige:
  keine `Content-Security-Policy`, kein `X-Frame-Options`, kein `X-Content-Type-Options`, kein
  `Referrer-Policy` — dafür `X-Powered-By: Express`. Das wiegt hier schwerer als anderswo, weil
  die Anmeldung als JWT im Browser-Speicher liegt: Eine XSS-Lücke hätte eine ganze Sitzung
  ausgehändigt.
  Die CSP konnte streng ausfallen, weil das Frontend weder Skripte noch Schriften von fremden
  Adressen lädt und `dangerouslySetInnerHTML` nirgends vorkommt: `default-src 'self'`,
  `script-src 'self'` (**ohne** `unsafe-inline`), `object-src 'none'`, `frame-ancestors 'none'`.
  `'unsafe-inline'` gibt es nur bei `style-src` — React und recharts setzen Inline-Styles.

### Bugfixes

- **react-router auf die letzte 6.x** (`6.30.4` → `^6.30.6`). `npm audit` meldet für 6.x zwei
  moderate Advisories; nachgeprüft ist **keines davon hier erreichbar**:
  - *Open Redirect über einen Backslash in `<Link>`/`useNavigate`* setzt ein Navigationsziel
    voraus, das ein Angreifer beeinflussen kann. Im Panel sind alle Ziele feste Zeichenketten im
    Quelltext — weder Nutzereingaben noch Mailinhalte erreichen ein `to=` oder `navigate()`. Das
    Abmelden läuft über `window.location` und damit gar nicht durch den Router.
  - *Constructor Injection bei der SSR-Hydration* betrifft serverseitiges Rendern, das es hier
    nicht gibt.

  Ein Sprung auf 7 wäre nötig, um die Advisories formal loszuwerden — der Fix kam erst in 7.18.0,
  ein gepatchtes 6.x existiert nicht. Das ist ein Hauptversionswechsel für eine Lücke, die in
  diesem Programm nicht erreichbar ist; er bleibt als eigener Schritt vorgemerkt. Wer künftig ein
  Navigationsziel aus Daten baut, muss ihn vorziehen.
- **Der Container lief als root.** Jetzt läuft das Panel als Benutzer `node`. Ein Startskript
  richtet vorher das Datenverzeichnis her und gibt die Rechte dann ab — nötig, weil das Volume
  bei bestehenden Installationen root gehört.
- **Die Werkzeugkette blieb im fertigen Abbild liegen.** `python3`, `make` und `g++` werden nur
  zum Übersetzen von `better-sqlite3` gebraucht und danach wieder entfernt.
- **Zeilenenden festgenagelt** (`.gitattributes`): Skripte und Dockerfile liegen im Repository
  immer mit LF. Ein `start.sh` mit CRLF scheitert in Alpine mit der irreführenden Meldung
  „not found".

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. **n8n-Workflows**: unverändert, kein Sync nötig.
- **Neustart**: erforderlich. **Beim ersten Start nach dem Update übergibt der Container das
  Datenverzeichnis an den Benutzer `node`** — das dauert je nach Größe einen Moment und steht im
  Log. Danach läuft das Panel ohne root-Rechte.
- **Wer eigene Erweiterungen ins Frontend eingebaut hat**, die Skripte oder Schriften von fremden
  Adressen laden, muss die CSP in `panel/backend/src/index.js` entsprechend erweitern — sonst
  blockiert der Browser sie.

## [2.8.5.0] - 2026-08-27 (Build 49) — *Schärferer Prompt, gelassenerer Sync*

### Änderungen

- **Die KI weiß jetzt, welche Ordnernamen vergeben sind.** Im Betrieb schlug sie bei Werbemails
  von Plesk und Wargaming als Thema `Newsletter` vor — ein reservierter Kategoriename, der
  abgewiesen wird. Der Themen-Vorschlag verpuffte damit und die Mail blieb liegen; das Modell
  konnte es schlicht nicht wissen. Der Prompt nennt die Kategorie-Ordner des Kontos jetzt
  ausdrücklich und weist an, in solchen Fällen `null` zu setzen, damit die Kategorie greift.

### Bugfixes

- **Ein Zeitlimit beim Speichern galt als Fehlschlag, obwohl gespeichert wurde.** n8n registriert
  beim Sichern eines Workflows die Trigger neu und läuft dabei in das Verbindungslimit des
  Mailservers (bei Dovecot `mail_max_userip_connections`, ab Werk 10). Die HTTP-Antwort kommt dann
  nie — der Workflow ist aber gespeichert. Das Panel sieht jetzt nach dem Zeitlimit nach, ob die
  Änderung angekommen ist, und meldet in dem Fall Erfolg. Bleibt es ein echter Fehlschlag, nennt
  die Meldung die wahrscheinliche Ursache und den Ausweg (`docker compose restart n8n`) — das
  stand bisher nur im README, wo im Ernstfall niemand nachschaut.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: **Synchronisieren zwingend erforderlich.** Die Marke der
  Code-Knoten steigt von `// PANEL:THEMEN v2` auf `v3`, damit der Patcher den neuen Prompt
  einsetzt. Wer *Prüfung auswerten* oder *Antwort parsen* von Hand angepasst hat, verliert das
  dabei.
- **Neustart**: ausreichend.

## [2.8.4.1] - 2026-08-24 (Build 48) — *Fix: Gmails „Wichtig" blieb ein mögliches Sortierziel*

### Bugfixes

- **Nicht jede Sonderrolle steht in `specialUse`.** Der Filter aus v2.8.4.0 fing `[Gmail]`,
  `[Gmail]/Alle Nachrichten` und `[Gmail]/Markiert` ab, ließ aber **`[Gmail]/Wichtig`** durch:
  Gmail weist diesen Ordner nur über das LIST-Flag `\Important` aus, nicht über `specialUse`.
  Aufgefallen ist das beim Scharfschalten auf dem Testserver — drei von vier Ansichten wurden
  gesperrt, die vierte blieb ein erlaubtes Ziel. Jetzt zählen beide Quellen, und die bekannten
  Rollen (`\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash`, `\Important`,
  `\Inbox`) werden einheitlich behandelt, egal wo der Server sie hinschreibt.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. Bestehende Katalog-Einträge werden beim nächsten
  *Aus Postfach einlesen* nachträglich gesperrt.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig. **Neustart**: ausreichend.

## [2.8.4.0] - 2026-08-24 (Build 47) — *Systemordner kommen nicht mehr in den Themen-Katalog*

### Bugfixes

- **Gmails Ansichten landeten als mögliche Sortierziele im Katalog.** „Aus Postfach einlesen"
  übernahm `[Gmail]`, `[Gmail]/Alle Nachrichten`, `[Gmail]/Markiert` und `[Gmail]/Wichtig` wie
  gewöhnliche Ordner. Das sind aber keine Ordner, sondern Ansichten — hätte die KI eines davon
  gewählt, wäre die Mail scheinbar verschwunden, und `[Gmail]` selbst kann als `\Noselect`-Knoten
  überhaupt keine Nachrichten aufnehmen.
  Der bisherige Filter verglich **Namen** gegen eine Liste deutscher und englischer Systemordner —
  an Gmails Benennung, die sich nach der Kontosprache richtet, ging er vorbei. Jetzt entscheidet
  der Mailserver selbst: Alles, was eine IMAP-Sonderrolle trägt (`\All`, `\Trash`, `\Sent`,
  `\Drafts`, `\Junk`, `\Flagged`, `\Important`, `\Archive`) oder als `\Noselect` / `\NonExistent`
  ausgewiesen ist, kommt nicht in den Katalog. Was übersprungen wurde, steht im Log.
- **Altbestand wird mit aufgeräumt:** „Aus Postfach einlesen" sperrt solche Einträge, wenn sie
  früher schon hineingeraten sind. Gelöscht wird nichts — sie bleiben sichtbar, werden aber nie
  befüllt.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. Bestehende Katalog-Einträge werden erst beim nächsten
  *Aus Postfach einlesen* gesperrt, nicht automatisch beim Start.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig.
- **Neustart**: ausreichend.

## [2.8.3.0] - 2026-08-22 (Build 46) — *Doku: Warnung vor dem Selbstbauen auf dem Server*

### Änderungen

- **`docker compose up -d --build` kann die Anwendung zurückdrehen** — das steht jetzt in der
  Anleitung. `--build` erzeugt das Image aus dem Ordner, in dem man steht, und legt es unter
  demselben Namen ab wie das fertige Image aus der Registry. Liegen dort ältere Dateien, läuft
  danach dieser ältere Stand, auch wenn vorher ein `docker compose pull` etwas Neues geholt hat.
  Auf dem Testserver führte das zu einem Frontend von Build 44 mit einem Backend vom 13. August:
  Die Hälfte der API-Routen antwortete mit `Cannot GET /api/…`, Dashboard und Sortierseite blieben
  leer, während die Datenbank völlig in Ordnung war.
- **Neuer Eintrag in der Fehlertabelle** für genau dieses Bild (leere Seiten, 404 auf API-Aufrufe)
  samt Prüfbefehl und dem Weg zurück:
  `docker pull …` und `docker compose up -d --force-recreate --no-build panel`.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. **n8n-Workflows**: unverändert, kein Sync nötig. Reine Doku-Änderung.

## [2.8.2.1] - 2026-08-22 (Build 45) — *Fix: n8n Workflow-Aktivierung*

### Bugfixes

- **Workflows ließen sich nicht mehr über das Panel aktivieren/deaktivieren.** Die n8n-API hat neuere Validierungsregeln für Body-Payloads. Da der bisherige Axios-Aufruf ein leeres Objekt `{}` gesendet hat, um einem Content-Type-Fehler aus dem Weg zu gehen, lehnte n8n die Anfrage jetzt mit "Bad request - please check your parameters" ab. Die Aktivierung nutzt jetzt die native `fetch`-API, womit ein vollständig leerer Body ohne störende Header verschickt werden kann, was von n8n wieder problemlos akzeptiert wird.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: unverändert.
- **Neustart**: ausreichend.

## [2.8.2.0] - 2026-08-22 (Build 44) — *Filter Inbox by Account*

### Features

- **Sortier-Inbox nach Postfach gefiltert.** Wenn links in den Sortier-Regeln ein bestimmtes Postfach ausgewählt ist, zeigt die Sortier-Inbox auf der rechten Seite jetzt nur noch die E-Mails, die auch zu diesem Postfach gehören. So sieht man beim Sortieren nicht mehr die Mails anderer Konten.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: unverändert.
- **Neustart**: ausreichend.

## [2.8.1.0] - 2026-08-22 (Build 43) — *Einzelregeln zu Domain-Regeln zusammenfassen*

### Features

- **Aufgesammelte Einzelregeln lassen sich bündeln.** Wer eine Weile von Hand sortiert hat, hat für
  denselben Dienst mehrere Regeln angelegt — im Testpostfach vier Stück für `@google.com`
  (`noreply-accounts@`, `googleplay-noreply@`, `googleone-noreply@`, `google-noreply@`), alle mit
  demselben Ziel. Die Regel-Übersicht weist jetzt darauf hin und ersetzt sie auf einen Klick durch
  **eine** Domain-Regel, die zusätzlich jede künftige Adresse dieser Domain abdeckt. Die bisherigen
  Trefferzahlen werden dabei zusammengezählt, und was gerade in der Sortier-Inbox wartet und zur
  neuen, weiter gefassten Regel passt, wird gleich mitsortiert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine. Die ersetzten Einzelregeln werden beim Zusammenfassen gelöscht — das
  passiert nur auf ausdrückliche Bestätigung im Panel, nie von selbst.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig.
- **Neustart**: ausreichend.

## [2.8.0.0] - 2026-08-22 (Build 42) — *Feature: Stapelweise sortieren, saubere Sitzungen*

### Features

- **Ähnliche Mails wandern gleich mit.** Die Sortier-Inbox ist nach Absender-Domain gebündelt:
  „20 Mails von `accounts.google.com`" statt zwanzig Einzeleinträge. Ein Zielordner, ein Klick —
  und das Panel legt den Ordner an, merkt sich die Regel und verschiebt **alle** wartenden Mails
  der Gruppe per IMAP. Auf dem Testserver hätte das 53 von 63 offenen Mails in sieben Handgriffen
  erledigt.
- **Neue Regeln gelten rückwirkend.** Bisher galt eine Regel nur für das, was danach kam; den
  Bestand musste man trotzdem von Hand durchgehen. Jetzt zieht jede neu angelegte Regel die schon
  wartenden Mails sofort nach (abschaltbar).
- **Das Panel lernt Domain-Regeln statt Regel-Müll.** Viele Dienste verschicken aus einer ganzen
  Reihe von Adressen (`googleplay-noreply@`, `googleone-noreply@`, `google-noreply@` …) oder gleich
  aus Wegwerf-Adressen mit Hash im Namen — eine Absender-Regel greift dort kein zweites Mal.
  Sobald zwei verschiedene Absender derselben Domain im selben Ordner gelandet sind, entsteht
  deshalb eine Regel für die **Domain**.
- **Regeltyp direkt wählbar:** Beim Zuordnen einer einzelnen Mail steht jetzt zur Wahl, ob sich das
  Panel den Absender, die ganze Domain oder gar nichts merken soll.
- **Angemeldet bleiben.** Ohne Haken endet die Sitzung, sobald der Browser geschlossen wird
  (`sessionStorage`); mit Haken bleibt sie wie bisher erhalten.

### Bugfixes

- **Sicherheitslücke im Domain-Abgleich.** Der Vergleich lief über ein blankes
  `absenderEmail.endsWith('google.com')` — damit passte eine Regel für `google.com` auch auf
  `boesegoogle.com`. Wer eine solche Domain registriert, hätte Mails gezielt in einen fremden
  Zielordner einschleusen können. Jetzt wird auf Punktgrenzen geprüft: `google.com` trifft die
  Domain selbst und ihre Unterdomains, aber nichts, was bloß so endet.
- **Nach Ablauf der Sitzung passierte gar nichts.** Ein abgelaufenes Token lieferte HTTP **403**,
  das Frontend meldet aber nur bei **401** ab. Man blieb also scheinbar angemeldet, jede Anfrage
  scheiterte still und im Dashboard standen nur noch Fehler — genau das Verhalten, über das
  gestolpert wurde. Auth-Fehler liefern jetzt 401 (mit Grund), 403 bleibt den fehlenden Rechten
  vorbehalten, und das Frontend meldet sauber ab.
- **Ein abgelaufenes Token galt als Anmeldung.** Der Routen-Schutz prüfte nur, *ob* ein Token da
  ist, nicht ob es noch gilt. Jetzt wird die Laufzeit mitgeprüft, ein Wecker meldet bei Ablauf von
  selbst ab, und ein Tab, der stundenlang im Hintergrund lag, prüft beim Zurückkommen sofort nach.
- **Die Anmeldemaske sagt jetzt, warum man dort steht** („Deine Sitzung ist abgelaufen") statt
  wortlos aufzutauchen.
- **Massenumzüge öffnen nur noch eine IMAP-Verbindung** statt einer je Mail. Bei größeren Stapeln
  wäre man sonst in dasselbe Verbindungslimit gelaufen, an dem schon der Workflow-Sync hing.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig.
- **Neustart**: ausreichend. **Alle angemeldeten Benutzer müssen sich einmal neu anmelden** — das
  Token liegt jetzt woanders. Das ist einmalig und beabsichtigt.
- **Bestehende Domain-Regeln greifen enger als vorher.** Wer bewusst eine Regel angelegt hat, die
  nur über das lose `endsWith` gepasst hat, muss sie anpassen. Regeln für echte Domains und deren
  Unterdomains funktionieren unverändert.

## [2.7.0.4] - 2026-08-22 (Build 41) — *Fix: Dubletten in der Sortier-Inbox aufräumen*

### Bugfixes

- **Die Sortier-Inbox füllte sich mit Kopien derselben Mail.** Bis v2.7.0.0 schrieb
  `/api/internal/sort` jede Mail ohne Regel-Treffer dort hinein — bei **jedem** Lauf erneut. Wer
  die Bestands-Triage mehrfach gestartet hat (und genau dazu ist sie da), fand dieselbe Mail bis
  zu einem Dutzend Mal in der Liste. Auf dem Testserver waren von 304 offenen Einträgen 239
  überzählig. Neue Dubletten entstehen seit v2.7.0.0 nicht mehr; für den Altbestand läuft jetzt
  einmalig eine Bereinigung.
  **Es wird dabei nichts gelöscht:** Die jüngste Zeile je Konto und UID bleibt offen, die älteren
  bekommen den Status *ignoriert* und verschwinden nur aus der Ansicht.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: eine einmalige Bereinigung von `sort_inbox`, abgesichert über den Schlüssel
  `migration_sortinbox_dubletten` — sie läuft genau einmal und fasst später hinzugekommene
  Einträge nicht mehr an.
- **n8n-Workflow-Kompatibilität**: unverändert, kein Sync nötig.
- **Neustart**: ausreichend — die Bereinigung läuft beim Start.

## [2.7.0.3] - 2026-08-22 (Build 40) — *Fix: Abgekündigtes Gemini-Modell und fehlende Zielordner*

Beide Fehler kamen aus der Fehlerliste des Testservers, nicht aus dem Schreibtisch.

### Bugfixes

- **Der tägliche Digest scheiterte jeden Morgen.** Workflow 02 lief noch auf
  `gemini-2.5-flash-lite`; Google antwortet darauf mit *„This model is no longer available to new
  users"*. Der Patcher hob das Modell zwar an, erkannte die Knoten aber am **Namen** — und hieß
  einer `Gemini zusammenfassen` statt `Gemini klassifizieren`, blieb er stehen. Dazu wurde
  `geminiRequestReparieren` nur für die Workflows 01 und 04 aufgerufen, 02 also nie angefasst.
  Jetzt werden die Knoten an ihrer **Adresse** erkannt (dasselbe Muster wie bei
  `panelKnotenVerdrahten`), und die Reparatur läuft über alle Workflows.
- **Der KI-Assistent für eigene Aktionen** stand auf demselben abgekündigten Modell
  (`services/aktionenKi.js`) und hätte mit derselben Meldung abgebrochen.
- **Ein fehlender Zielordner riss den ganzen Lauf ab.** Der Verschiebe-Knoten meldete
  `9 NO [TRYCREATE] No folder Newsletter`, n8n brach die Ausführung ab und die Mail blieb
  unbearbeitet liegen — im Panel war davon nichts zu sehen. Das Panel prüft jetzt vor der
  Rückgabe, ob der Ordner im Postfach existiert; fehlt er, bleibt die Mail im Posteingang und
  steht mit genau dieser Begründung in der Sortier-Inbox. Die Ordnerliste wird dafür je Konto
  60 Sekunden zwischengespeichert, sonst käme auf jede Mail eine eigene IMAP-Verbindung.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: **Synchronisieren erforderlich**, damit Workflow 02 das neue
  Modell bekommt. Die mitgelieferte Vorlage `02-daily-digest.json` ist ebenfalls aktualisiert.
- **Neustart**: ausreichend.

## [2.7.0.2] - 2026-08-22 (Build 39) — *Fix: Die KI schlug nie einen neuen Themen-Ordner vor*

### Bugfixes

- **Der Prompt verlangte Unmögliches.** Er ließ einen neuen Ordner nur vorschlagen, wenn das Thema
  „erkennbar öfter vorkommt" — das kann ein Modell aus einer einzelnen Mail nicht beurteilen, also
  antwortete es sicherheitshalber `null`. Im Test auf dem Testserver landete ein Steam-Newsletter
  dadurch in `Newsletter` statt in einem Games-Ordner: genau der Fall, für den das Feature gebaut
  wurde. Die Anweisung lautet jetzt, das Thema der Mail selbst zu benennen und dafür einen
  allgemeinen Oberbegriff zu wählen (`Games`, nicht `Steam Sommer-Sale`); `null` bleibt den Mails
  ohne erkennbares Sachthema vorbehalten. Zusätzlich steht ausdrücklich im Prompt, dass das
  Sachthema zählt und nicht die Form — ein Newsletter über Spiele gehört nach `Games`.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: **Synchronisieren zwingend erforderlich.** Die Marke der
  Code-Knoten steigt von `// PANEL:THEMEN v1` auf `v2`, damit der Patcher die schon umgestellten
  Knoten noch einmal anfasst — sonst käme der neue Prompt nie an. Wer *Prüfung auswerten* oder
  *Antwort parsen* seit v2.7.0.0 von Hand angepasst hat, verliert diese Änderung dabei.
- **Neustart**: ausreichend.

## [2.7.0.1] - 2026-08-22 (Build 38) — *Fix: Synchronisieren bricht nicht mehr auf halber Strecke ab*

### Bugfixes

- **Der Sync riss beim ersten Fehler die ganze Kette mit.** Lief das Speichern von Workflow 01 in
  ein Zeitlimit, wurden 04 und 03 gar nicht mehr angefasst — und zwar unbemerkt, weil die
  Fehlermeldung nur den ersten Workflow nannte. Ergebnis: eine halb umgestellte Installation, in
  der 01 die neue Themen-Kette hatte und 04 noch die alte. Jetzt wird jeder Workflow einzeln
  versucht und am Ende gesammelt gemeldet, welche nicht durchliefen.
- **Zeitlimit der n8n-API angehoben.** 15 Sekunden galten für jeden Aufruf; das Schreiben eines
  Workflows dauert aber deutlich länger, weil n8n dabei den ganzen Graphen prüft. Seit v2.7.0.0
  sind die Workflows zusätzlich gewachsen, damit lief das Speichern auf ausgelasteten Instanzen
  regelmäßig in den Timeout. Lesende Aufrufe bleiben bei 15 s, schreibende bekommen 60 s.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine.
- **n8n-Workflow-Kompatibilität**: **Synchronisieren erforderlich**, wenn v2.7.0.0 zuvor mit einem
  Timeout abgebrochen ist — dann steht Workflow 04 noch auf dem alten Stand. Ein erneuter Klick auf
  *Synchronisieren* holt ihn nach.
- **Neustart**: ausreichend.

## [2.7.0.0] - 2026-08-22 (Build 37) — *Feature: Automatische Themen-Sortierung*

### Features

- **Die KI sortiert nach Themen — und legt die Ordner selbst an.** Bisher konnte sie nur vier
  feste Kategorien bedienen (Rechnungen, Bestellungen, Newsletter, Quarantäne); alles andere blieb
  liegen und musste in der Sortier-Inbox einzeln weggeklickt werden. Jetzt bekommt sie den
  Ordner-Katalog des Kontos in den Prompt und wählt daraus — „alles rund um Games in den
  Games-Ordner“. Fehlt ein passender Ordner, schlägt sie einen neuen vor.
  - **Thema schlägt Kategorie:** Ein Games-Newsletter landet in Games, nicht in Newsletter.
    Nur Spam, Blacklist-Treffer und Viren stehen darüber — die gehen weiterhin immer in die Quarantäne.
  - **Weiterhin nur ein Gemini-Aufruf je Mail.** Der Prompt entsteht jetzt in *Prüfung auswerten*
    statt im Normalisierer, weil erst dort die Antwort des Panels den Katalog mitbringt.
- **Themen-Katalog je Konto** (*Sortierung → Themen-Ordner*): Aus diesen Ordnern wählt die KI —
  und nur aus diesen. **Aus Postfach einlesen** übernimmt die vorhandene Struktur, damit niemand
  eine zweite danebenbauen muss. Je Ordner ein Satz Beschreibung, der wörtlich in den Prompt geht;
  einzelne Ordner lassen sich sperren.
- **Neue Ordner mit Bremse** (*Einstellungen → KI & Prüfung*): drei Modi — `aus`, `freigabe`
  (Standard: die KI schlägt vor, ein Klick legt an **und sortiert die wartenden Mails nach**) und
  `auto`. Dazu eine Obergrenze je Konto (Standard 25), eine Mindest-Sicherheit (Standard 0,7) und
  ein optionaler Sammelordner, unter dem alle KI-Ordner entstehen (leer = direkt im Postfach).
- **Regeln lernen:** Landen drei Mails desselben Absenders im selben Ordner, entsteht daraus eine
  feste Sortier-Regel. Der Absender läuft danach ohne KI durch — das schont das Gemini-Kontingent
  und macht die Sortierung mit der Zeit vorhersagbar.
- **Sortier-Inbox zeigt jetzt, was die KI wollte:** Vorschlag, Sicherheit und der Grund, warum es
  nicht gereicht hat („Zu unsicher (0,55 < 0,7)“, „Obergrenze erreicht“, „wartet auf Freigabe“).
  Ein Klick übernimmt den Vorschlag ins Eingabefeld.

### Bugfixes

- **Workflow 01 und 04 protokollieren endlich.** `POST /api/internal/log` wurde von keinem
  Workflow aufgerufen — `quarantine_log` blieb leer, Dashboard und Quarantäne-Seite zeigten nichts.
  Der neue Knoten *Einsortieren* schreibt das Log mit, auch für Blacklist- und Virus-Treffer.
- **Eigene Zielordner je Konto wurden nie benutzt.** Der Normalisierer baut ein frisches Item und
  warf dabei die Felder des Set-Knotens (`folder_spam`, `folder_invoices`, …) weg — `Antwort parsen`
  fand sie deshalb nie und fiel immer auf die Standardnamen zurück. Wer im Panel `Finanzen/Belege`
  eingetragen hatte, bekam trotzdem `Rechnungen`. In Workflow 04 gab es den Set-Knoten überhaupt
  nicht. Die Ordner kommen jetzt über die Antwort von `/api/internal/check` — damit stimmt es in
  beiden Workflows.
- **Blacklist- und Virus-Treffer landeten fest in `Quarantaene`**, statt im Ordner, den das Konto
  konfiguriert hat. Wer die Quarantäne umbenannt hatte, bekam Mails in einen Ordner, den es nicht gibt.
- Die Sortier-Inbox wurde doppelt befüllt, sobald eine Mail durch die KI lief: einmal vorab in
  `/sort` und einmal danach. Jetzt schreibt nur noch `/einsortieren` hinein.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: zwei neue Tabellen (`konto_ordner`, `ordner_vorschlaege`) und fünf neue
  Spalten (`sort_inbox.ki_ordner/ki_konfidenz/ki_grund`, `quarantine_log.thema/konfidenz`).
  Laufen beim Start automatisch, kein Eingriff nötig.
- **n8n-Workflow-Kompatibilität**: **Synchronisieren zwingend erforderlich.** Der Patcher baut den
  neuen Knoten *Einsortieren* ein, hängt *Antwort parsen*, *Blacklist: Quarantäne* und
  *Virus: Quarantäne* darauf um und schreibt vier Code-Knoten neu.
  **Achtung:** Wer *Prüfung auswerten*, *Antwort parsen*, *Blacklist: Quarantäne* oder
  *Virus: Quarantäne* in n8n von Hand angepasst hat, verliert diese Änderung einmalig — die Knoten
  tragen danach die Marke `// PANEL:THEMEN v1` und bleiben bei künftigen Syncs unangetastet.
- **Neu importieren nicht nötig**: Der Patcher nimmt bestehende Workflows mit.
- **Neustart**: ausreichend. Die Themen-Sortierung ist ab Werk **aus** — ohne den Schalter in
  *Einstellungen → KI & Prüfung* ändert sich am Verhalten nichts.

## [2.6.0.0] - 2026-08-18 (Build 36) — *Feature: Panel-Trockenlauf*

### Features

- **Trockenlauf per Knopfdruck:** Es muss nun keine Verbindung in den Workflows mehr manuell getrennt werden. Unter *Einstellungen → KI & Prüfung* gibt es einen Schalter „Trockenlauf aktivieren“.
  - Ist dieser aktiv, trennt der Workflow-Patcher beim Synchronisieren die Verschiebe-Knoten in Workflow 01 und 04 einfach ab.
  - Die Mails werden klassifiziert, durchlaufen alle Prüfungen, führen eigene Aktionen (Workflow 07) aus und landen im Log — bleiben aber sicher im Posteingang.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine (`trockenlauf_aktiv` läuft als einfacher String in der `settings`-Tabelle).
- **n8n-Workflow-Kompatibilität**: **Sync zwingend erforderlich**. Wer den Trockenlauf nutzen will, muss ihn aktivieren und danach auf der Workflows-Seite auf **Synchronisieren** klicken, damit die Workflows frisch gepatched werden.
- **Neustart**: ausreichend

## [2.5.3.1] - 2026-08-18 (Build 35) — *Einstellungen: Google-Kalender Anleitung*

### Änderungen

- Kurze Schritt-für-Schritt-Anleitung samt Direktlink zur Google Cloud Console in den
  Einstellungen (Sektion *Google-Kalender*) eingefügt.
- Gleiche Anleitung ausführlich in die `README.md` übernommen.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine
- **n8n-Workflow-Kompatibilität**: nicht betroffen
- **Neustart**: ausreichend

## [2.5.3.0] - 2026-08-18 (Build 34) — *Einstellungen: Tab-Layout wie Überwachungs-Panel*

### Änderungen

- **Einstellungen-Seite erneut überarbeitet** — jetzt mit Tab-Navigation + Karten-Masonry-Layout
  exakt nach dem Muster des Überwachungs-Panels:
  - **Tab-Bar** (`Verbindungen` / `KI & Prüfung` / `Dienste` / `Konto`) — Tab-Status in
    `bg-panel-card` hervorgehoben, inaktive Tabs `text-panel-muted`
  - **`columns-1 lg:columns-2`-Masonry-Layout** innerhalb jedes Tabs — Karten füllen die
    Spalten von oben nach unten, keine feste Zeilenaufteilung
  - **`Card`-Komponente** mit `uppercase`-Titelzeile und `border-b` Trennlinie wie im ÜP
  - Verbindungstests nun im Tab `Verbindungen` integriert als vertikale Liste mit Inline-Ergebnis
  - Safe-Browsing-API-Key-Feld erscheint nur, wenn Safe Browsing aktiviert ist

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine
- **n8n-Workflow-Kompatibilität**: nicht betroffen
- **Neustart**: ausreichend

## [2.5.2.0] - 2026-08-18 (Build 33) — *Einstellungen: modernes UI + Gemini/Google-Test*


### Änderungen

- **Einstellungen-Seite vollständig überarbeitet:**
  - **Aufklappbare Sektionen** — alle Bereiche (Verbindungen, KI, SMTP, Aktionen, Passkeys…)
    können einzeln auf- und zugeklappt werden; selten genutzte Bereiche starten zugeklappt
  - **Toggle-Switches** statt Checkboxen für boolean-Optionen (ClamAV, Safe Browsing, SMTP-TLS)
  - **Passwortfelder mit Auge-Icon** — Sichtbarkeit per Klick umschalten
  - **Meldungen per Sektion** — jeder Bereich hat seinen eigenen Speichern-Button und zeigt
    Erfolg/Fehler direkt darunter an (kein gemeinsamer globaler Status mehr)
  - **2-Spalten-Grid** für Felder, die thematisch zusammengehören
- **Verbindungstest: Gemini-API** — prüft API-Key mit minimalem Modell-Listen-Request
  (keine Token verbraucht); zeigt Anzahl der gefundenen Modelle im Ergebnis
- **Verbindungstest: Google-Kalender** — holt einen frischen Access-Token über den
  Refresh-Token und bestätigt so die Verbindung; zeigt Gültigkeitsdauer
- **Backend** `einstellungen.js`: neue Test-Zweige `gemini` und `google` in
  `POST /api/einstellungen/test/:dienst`
- **Google-Verbindungsblock** in der Aktionen-Sektion umgestaltet: kompakter Status-Badge,
  Rücksprung-URI direkt darunter

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migrationen**: keine
- **n8n-Workflow-Kompatibilität**: nicht betroffen
- **Neustart**: Container-Neustart nach Deployment ausreichend

## [2.5.1.0] - 2026-08-18 (Build 32) — *Panel-Logs: Karten-Layout*


### Änderungen

- **Panel-Logs-Seite vollständig überarbeitet** nach dem Vorbild des Überwachungs-Panels:
  - Layout von Tabelle auf **Karten-Design** umgestellt — farbiger linker Border je nach Level
    (rot = Error, gelb = Warn, blau = Info), farbige Quellen-Chips
  - **Checkbox-Auswahl** pro Eintrag und **Auswahl-Toolbar** mit Bulk-Löschen und Kopieren
  - **Dynamische Quellliste** — neuer Endpunkt `GET /api/logs/sources` liefert alle distinct
    Quellen aus der Datenbank; kein statischer Filter mehr
  - **Copy-Button** pro Eintrag kopiert Level, Zeitpunkt, Quelle, URL und Nachricht als Text
  - **Stack-Trace** weiterhin aufklappbar per Button
  - Auto-Refresh (10 s) bleibt, jetzt als umschaltbarer Toggle-Button
- **Backend**: neuer Endpunkt `DELETE /api/logs/bulk` für selektives Löschen
- **DB-Migration**: Spalten `source`, `message`, `url` in `panel_logs` ergänzt —
  abwärtskompatibel; bestehende Logs (mit `quelle`/`nachricht`) werden beim Lesen automatisch
  harmonisiert und bleiben erhalten
- **Frontend-Fehler-Reporter** (`main.jsx`) nutzt jetzt das neue Schema
  `{source, message, stack, url}` (Überwachungs-Panel-kompatibel); `source` ist jetzt
  `JavaScript` bzw. `Promise` statt generisch `frontend`

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration**: läuft automatisch beim nächsten Start; keine manuelle Aktion nötig;
  kein Datenverlust (ALTER TABLE, try/catch)
- **n8n-Workflow-Kompatibilität**: nicht betroffen
- **Neustart**: Container-Neustart nach Deployment ausreichend; kein Session-Verlust

## [2.5.0.0] - 2026-08-16 (Build 31) — *Anhänge über das Panel scannen*


### Features

- **Neuer Endpunkt `POST /api/internal/scan-anhaenge`.** Der Workflow schickt nur noch
  Konto, Nachrichten-Nummer und Ordner; das Panel holt sich die Anhänge selbst per IMAP und
  gibt jeden einzelnen an ClamAV. Zurück kommt ein Gesamtergebnis plus eine Liste je Datei
  (`gefunden`, `geprueft`, `dateien`). Zugangsdaten stammen ausschließlich aus der
  Datenbank, nie aus der Anfrage.
- **Alle Anhänge werden geprüft, nicht nur der erste.** Nachgewiesen mit einer Mail, deren
  **zweiter** Anhang EICAR enthielt — der alte Weg hätte sie durchgelassen.
- **Die Bestands-Triage prüft jetzt ebenfalls.** Bisher war das gar nicht möglich: Ihr
  Abruf-Knoten liefert nur `attachmentsInfo` (Name, Größe), keine Dateiinhalte. Er meldet
  jetzt die Anhang-Liste, und die Dateien holt das Panel über die Nachrichten-Nummer.
- Grenzen zum Schutz des Panels: höchstens 20 Anhänge je Mail, höchstens 30 MB je Datei.
  Was übersprungen wird, steht im Ergebnis und ist im Panel unter *Workflows → Läufe* zu sehen.

### Bugfixes

- **Workflow 04 lief seit v2.4.0.2 gar nicht mehr.** Das damalige Durchreichen der
  Binärdaten setzte in *Sortierung auswerten* einen festen Verweis auf `$('Normalisieren')` —
  in Workflow 04 heißt der Knoten aber *Sammeln + Normalisieren*, der Lauf brach mit
  „Referenced node doesn't exist" ab. Der Umweg über die Binärdaten entfällt jetzt komplett,
  und der Patcher räumt ihn in bestehenden Installationen weg.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration.
- **n8n-Workflows:** **Nach dem Update einmal „Synchronisieren" drücken.** Dabei wird der
  Scan-Knoten auf den neuen Endpunkt umgestellt und umbenannt (*ClamAV Scan* →
  *Anhänge scannen*), der Abruf-Knoten der Bestands-Triage bekommt `attachmentsInfo`, und
  die Reste des alten Binär-Umwegs verschwinden.
- **Mehr IMAP-Verkehr:** Für jede Mail mit Anhang öffnet das Panel eine zusätzliche
  IMAP-Verbindung. Bei großen Bestandsläufen dauert das entsprechend länger.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.

## [2.4.0.2] - 2026-08-14 (Build 30) — *Prüfdurchgang 3: Virenscan und Verschieben*

Dritter Prüfdurchgang, diesmal mit echten Testmails statt nur gegen die Endpunkte.
Dabei kam heraus, dass zwei Kernfunktionen noch nie gelaufen sind.

### Bugfixes

- **Es wurde nie eine Mail verschoben.** Der IMAP-Trigger legt die UID unter
  `attributes.uid` ab, der Normalisierer las aber `j.uid` — also immer `null`. Ohne UID
  scheiterte der Verschiebe-Knoten mit „Unable to move email". Aufgefallen ist das nie, weil
  die Läufe vorher schon an anderer Stelle abbrachen. Jetzt mit Rückfall auf `attributes`.
- **Der Virenscan lief nie.** Drei Ursachen hintereinander:
  1. Code-Knoten geben nur zurück, was sie selbst bauen, und die HTTP-Knoten dazwischen
     ersetzen das Item komplett — die Anhänge waren längst weg, bevor die Weiche sie suchte.
  2. `$binary` lässt sich weder im IF- noch im HTTP-Knoten auflösen. Die Weiche prüft jetzt
     ein gewöhnliches Feld (`hat_anhang`), und der Anhang wird unter dem festen Namen
     `anhang` weitergereicht.
  3. Dem Scan-Knoten fehlte `contentType: binaryData` — er schickte gar keine Datei und
     bekam vom Panel eine 400 zurück.
  Nachgewiesen mit einer Mail mit EICAR-Anhang: erkannt als `Eicar-Test-Signature`,
  Telegram-Warnung raus, Mail in der Quarantäne.
- **Der Virusname stand als „Unbekannt" im Protokoll**, weil er über `$json` gelesen wurde.
  Jetzt direkt beim Scan-Knoten geholt.
- **Verwaiste Verweise auf gelöschte Credentials.** Wurde ein Gemini- oder Telegram-Schlüssel
  wieder entfernt, behielt der Knoten den Verweis und meldete „Credential with ID … does not
  exist" — der Workflow ließ sich weder ausführen noch einschalten. Der Verweis wird jetzt
  abgehängt, wie beim Postausgang schon seit v2.4.0.0.

### Sicherheit

- **Gespeicherte Postfach-Passwörter waren auslesbar.** Der Verbindungstest übernahm Server
  und Port aus der Anfrage, das Passwort aber aus der Datenbank. Wer das Recht `konten`
  hatte, konnte den Test damit auf einen eigenen Server richten und bekam das Passwort im
  Klartext zugeschickt — im Panel selbst ist es nicht lesbar. Kommt das Passwort aus der
  Datenbank, stammen Server, Port und Benutzername jetzt zwingend ebenfalls von dort. Wer den
  Server ändern will, muss das Passwort neu eingeben. Betrifft `/api/konten/test` und
  `/api/konten/ordner-anlegen`.
- **Ordnernamen konnten n8n-Ausdrücke einschleusen.** Ein Ordner namens
  `={{ $env.PANEL_SECRET }}` landete unverändert im Workflow, wo n8n das führende `=` als
  Ausdruck versteht — das Panel-Secret wäre so in den Mail-Daten gelandet. Führendes `=`
  sowie `{{ }}` und `${ }` werden jetzt entschärft.
- **Zwei Vorlagen-Knoten trugen das reservierte Präfix `panel-`** (`Daten vom Panel holen` in
  Workflow 02, der Beispielknoten in 05). Die Oberfläche wies sie dadurch fälschlich als
  „wird bei jedem Sync neu gebaut" aus — und ein künftiger Aufruf des Aufräumers auf diese
  Workflows hätte sie ersatzlos gelöscht. Beide haben jetzt eigene IDs.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration.
- **n8n-Workflows:** **Nach dem Update einmal „Synchronisieren" drücken.** Der Patcher zieht
  bestehende Workflows nach: UID-Rückfall, Anhang-Kette, Virusname, Knoten-IDs und die
  verwaisten Credential-Verweise. Alles wiederholbar, alles andere bleibt unangetastet.
- **Bekannte Grenze:** Gescannt wird der **erste** Anhang einer Mail. Und in Workflow 04
  (Bestands-Triage) gibt es gar keinen Scan — der Abruf-Knoten liefert nur
  `attachmentsInfo` (Dateiname, Größe), keine Dateiinhalte. Neu eintreffende Mails über
  Workflow 01 werden vollständig geprüft.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.

## [2.4.0.1] - 2026-08-14 (Build 29) — *Alle Panel-Aufrufe verdrahtet*

### Bugfixes

- **„Credentials not found" im täglichen Digest.** Der Knoten *Daten vom Panel holen* in
  Workflow 02 bekam nie das Panel-Credential: Verdrahtet wurde bisher nur ein Knoten mit dem
  festen Namen *Panel-Prüfung*, und auch nur in den Workflows 01 und 04. Ab jetzt erkennt
  der Patcher die Knoten an ihrer Adresse (`/api/internal/…`) statt am Namen und verdrahtet
  sie in **allen** Workflows. Betroffen waren neben Workflow 02 auch *Sortierung prüfen* in
  01 und 04 sowie der Beispielknoten in Workflow 05.
- **Virenscan schlug bei jeder Mail mit Anhang fehl.** Der Knoten *ClamAV Scan* hatte in den
  Vorlagen überhaupt keine Authentifizierung eingetragen und rief `/api/internal/scan` ohne
  den Header `X-Panel-Secret` auf — der Endpunkt antwortet darauf mit 401. Da der Knoten
  keine Fehlertoleranz hat, brach damit der komplette Triage-Lauf ab und die Mail blieb
  unsortiert liegen. Die Vorlagen tragen die Header-Authentifizierung jetzt, und der Patcher
  ergänzt sie in bestehenden Installationen.

Das Verhalten bei einem echten Ausfall von ClamAV bleibt bewusst unverändert: Der Lauf
bricht ab, statt die Mail ungeprüft als sauber durchzuwinken.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration.
- **n8n-Workflows:** **Nach dem Update einmal „Synchronisieren" drücken.** Dabei bekommen
  alle acht Knoten, die das Panel aufrufen, ihr Credential und die fehlende
  Header-Authentifizierung. Ein Neuimport ist nicht nötig.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.

## [2.4.0.0] - 2026-08-14 (Build 28) — *Postausgang im Panel*

### Features

- **Postausgang (SMTP) im Panel einrichten.** Unter *Einstellungen → Postausgang (SMTP)*
  trägt man Server, Port, Benutzer, Passwort und Absenderadresse ein; das Panel legt daraus
  das Credential in n8n an und verdrahtet es in Workflow 06. Bisher stand in dessen Notiz
  „im Node Send Email ein SMTP-Credential hinterlegen" — also genau die Handarbeit in n8n,
  die das Panel eigentlich abnehmen soll.
- **Verbindungstest für den Postausgang**, wie bei n8n, Mailcow, ClamAV, unbound und
  Nextcloud. Der Test führt den echten Ablauf durch (Begrüßung, EHLO, bei Bedarf STARTTLS,
  AUTH LOGIN) und gibt die Antwort des Servers im Klartext zurück — ein falsches Passwort
  meldet er also als solches. Ohne zusätzliche Abhängigkeit, nur mit `net` und `tls`.

### Bugfixes

- **Workflow 06 ließ sich nicht einschalten.** n8n lehnte mit „Cannot publish workflow:
  Node ‚Send Email' — Missing required credential: smtp" ab. Der Knoten stand nicht auf der
  Liste der Knoten, die ohne Zugangsdaten stillgelegt werden; jetzt schon. Ohne
  SMTP-Angaben bleibt er also aus und der Workflow lässt sich trotzdem einschalten.
- Werden die SMTP-Angaben wieder entfernt, hängt der Patcher das Credential vom Knoten ab.
  Sonst zeigte er auf ein gelöschtes Credential und blockierte erneut die Aktivierung.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration. Die sechs neuen Einstellungen (`smtp_host`, `smtp_port`,
  `smtp_user`, `smtp_passwort`, `smtp_absender`, `smtp_tls_unsicher`) liegen in der
  vorhandenen `settings`-Tabelle, das Passwort verschlüsselt.
- **n8n-Workflows:** **Nach dem Update einmal „Synchronisieren" drücken.** Erst dabei wird
  der Send-Email-Knoten stillgelegt beziehungsweise mit dem Postausgang verdrahtet. Wer
  bisher von Hand ein SMTP-Credential in n8n eingetragen hat, kann es behalten — sobald im
  Panel ein Postausgang steht, wird es beim Synchronisieren durch das eigene ersetzt.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.

## [2.3.0.0] - 2026-08-14 (Build 27) — *Ein Weg für alle Postfächer*

### Features

- **Zielordner: auswählen statt anlegen müssen.** Bisher musste man die vier Ordner vorab
  von Hand im Postfach anlegen, sonst lief die Einsortierung ins Leere. Jetzt hat man im
  Konto-Dialog die Wahl:
  - **Vorhandene auswählen** — nach dem Verbindungstest schlagen die Felder alle Ordner vor,
    die es im Postfach schon gibt. Wer seine Rechnungen längst in `Finanzen/Belege` sammelt,
    trägt genau das ein.
  - **Anlegen lassen** — ein Knopf **Fehlende Ordner anlegen** erzeugt die fehlenden Ordner
    über IMAP. Vorhandene bleiben unangetastet, gelöscht oder umbenannt wird nie etwas.
  - Neuer Ordner **Archiv** je Konto (`folder_archive`) für das Newsletter-Aufräumen; bisher
    hieß er fest `Archiv`.
- **Workflow 03 wird jetzt aus den Konten gebaut.** Er enthielt zwei namentlich fest
  eingebaute Postfächer („Web.de", „Mailcow"), die bei niemand anderem passten. Das Panel
  baut nun je Konto eine Such- und eine Verschiebe-Stufe ein — wie in 01 und 04.

### Änderungen

- **Gmail ist kein Sonderfall mehr.** Die Workflows 01, 03 und 04 hatten einen fest
  verdrahteten Gmail-Zweig (OAuth-Trigger, Label-Knoten, eine Tabelle mit von Hand
  einzutragenden Label-IDs). Der ist raus. **Jedes Postfach läuft über IMAP** — Gmail mit
  einem App-Passwort, wie GMX oder Web.de auch. Das spart die Google-Cloud-Einrichtung,
  den alle sieben Tage ablaufenden Refresh-Token und das Nachschlagen der Label-IDs.
- Die Konto-Weiche in 01 und 04 hat keinen festen ersten Ausgang mehr; die Ausgänge folgen
  jetzt einfach der Reihenfolge der Konten.
- Der Sammel-Knoten in Workflow 04 kennt keine feste Gmail-Quelle mehr, und die Abrufkette
  beginnt direkt am Knoten *Manuell starten*.
- Die Notizzettel in den Workflows 01, 03 und 04 beschreiben den Weg über das Panel statt
  der früheren Handarbeit in n8n.
- README: Der Ordner-Schritt ist kein Muss mehr, sondern beschreibt beide Wege; der
  Abschnitt zur Gmail-OAuth-Einrichtung entfällt.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** eine neue Spalte `accounts.folder_archive`, wird beim Start automatisch
  ergänzt. Bestehende Konten bekommen `NULL` und damit den Standardnamen `Archiv`.
- **n8n-Workflows:** **Nach dem Update einmal auf der Workflows-Seite „Synchronisieren"
  drücken.** „Neu importieren" fasst bestehende Workflows nicht an, deshalb baut der Patcher
  die alten Knoten beim Synchronisieren selbst aus: den Gmail-Zweig in 01, 03 und 04, die
  fest eingebauten Postfächer in 03 und die Gmail-Label-Tabelle im Knoten *Antwort parsen*.
  Der Vorgang ist wiederholbar und lässt alles andere im Workflow unberührt.
- **Wer Gmail bisher über OAuth angebunden hatte:** Dieser Zweig verschwindet beim
  Synchronisieren. Gmail danach unter *Konten* als normales IMAP-Konto anlegen
  (`imap.gmail.com:993`, App-Passwort). Das Gmail-Credential in n8n kann anschließend weg.
- **Newsletter-Aufräumen:** Workflow 03 braucht je Konto den Newsletter- und den
  Archiv-Ordner. Fehlt einer, meldet der betroffene Abruf-Knoten das und die übrigen Konten
  laufen weiter — anlegen lassen sich beide im Konto-Dialog.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.

## [2.2.2.0] - 2026-08-14 (Build 26) — *Gleiches Gesicht*

### Änderungen

- **Oberfläche an das Überwachungs-Panel angeglichen.** Die Farben waren schon dieselben,
  jetzt stimmt auch der Aufbau überein:
  - `components/Layout.jsx` ist aufgeteilt in `Layout/`, `Sidebar`, `Header` und `MobileNav`.
  - Die Seitenleiste ist **einklappbar** (56 px statt 224 px, Zustand wird im Browser gemerkt)
    und gliedert die elf Punkte in Abschnitte: Übersicht, Postfächer, Spam-Schutz,
    Automatisierung, Verwaltung. Ein Abschnitt verschwindet mit, wenn der Benutzer auf
    keinen seiner Punkte Zugriff hat.
  - Neue **Kopfzeile** mit dem Seitentitel; die Seiten selbst tragen ihre Überschrift nicht
    mehr doppelt. Benutzer, Rolle und Version stehen unten in der Seitenleiste.
  - **Handy-Ansicht:** Tab-Leiste unten mit Dashboard, Konten, Quarantäne und Workflows,
    dahinter eine Schublade mit dem vollständigen Menü.
  - Neuer Baukasten `components/ui/` mit `Card`, `Button`, `Badge`, `Modal` und `StatCard` —
    zeichengleich mit dem Schwesterprojekt.
  - `index.css` übernimmt dessen Basis (Bildlaufleisten, `.input-field`, `.section-label`,
    `.list-row`). Die bisherigen Klassen `.card`, `.btn-primary` und `.btn-ghost` gelten
    weiter, sehen aber aus wie die neuen Bausteine. Kästchen und Radios werden nicht mehr
    über die volle Breite gezogen.
- **README neu geschrieben** als vollständige Einrichtungsanleitung: zehn aufeinander
  aufbauende Schritte vom `docker compose up -d` bis zum aufgearbeiteten Altbestand, dazu
  die optionalen Erweiterungen, Betriebshinweise und eine deutlich erweiterte Fehlertabelle.
  Zwei veraltete Angaben sind dabei rausgeflogen: Die Workflows müssen **nicht** von Hand in
  n8n importiert werden (das erledigt der n8n-Verbindungstest im Panel), und einen
  `N8N_ENCRYPTION_KEY` muss man nicht selbst erzeugen — n8n legt ihn beim ersten Start an.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration.
- **n8n-Workflows:** unverändert. Kein Neuimport, kein Synchronisieren nötig.
- **Neustart & Sitzungen:** nur der Panel-Container startet neu, keine Abmeldung.
- **Sichtbare Änderung im Betrieb:** Der Seitentitel steht ab jetzt in der Kopfzeile statt
  im Inhalt. Zeigt der Browser nach dem Update noch das alte Layout, hilft `Strg+F5` —
  Name und Prüfsumme der Bündeldatei ändern sich zwar, aber `index.html` kann im Cache liegen.

## [2.2.1.0] - 2026-08-14 (Build 25) — *Nachprüfung*

Zweiter Prüfdurchgang über den kompletten Stand: 17 Prüfpunkte gegen die laufende Anlage
(Zugriffsschutz, Eingabeprüfung, Einschleusung, Pfad-Ausbruch, Prüfdienste,
Workflow-Steuerung, Rollen). Fünf Befunde, alle behoben und am laufenden System nachgewiesen.

### Bugfixes

- **Workflows 01 und 04 ließen sich nicht mehr einschalten, sobald eine eigene Aktion
  bestand.** Ab n8n 2 muss ein aufgerufener Unter-Workflow veröffentlicht sein; n8n lehnte
  mit „references workflow … which is not published" ab. Beim Speichern schaltet n8n einen
  Workflow ab — Workflow 07 war danach also immer unveröffentlicht. Er wird jetzt nach jedem
  Bau der Aktionen wieder veröffentlicht, und beim Konto-Sync geschieht das, *bevor* 01 und
  04 ihren alten Zustand zurückbekommen.
- **Ausbruch aus dem Zielordner über den Dateinamen eines Anhangs.** Den Namen bestimmt, wer
  die Mail schickt; er lief ungefiltert in den Nextcloud-Pfad. Ein Anhang
  `../../../ausbruch.txt` hätte in der Wurzel der Nextcloud gelandet. Der erzeugte Knoten
  „Anhänge aufteilen" schneidet jetzt Verzeichnisanteile, führende Punkte und Steuerzeichen
  ab und begrenzt auf 120 Zeichen.
- **Eingeschleuste Ausdrücke in den Textfeldern der Aktionen.** `{{ … }}` und `${ … }` in
  Ordner- oder Titelangaben landeten unverändert im Workflow und wurden dort ausgewertet —
  damit wären `{{ $env.PANEL_SECRET }}` oder beliebiger JavaScript-Code erreichbar gewesen.
  Nur noch die eigenen Platzhalter (`{{jahr}}`, `{{absender}}` …) bleiben aktiv, alles andere
  wird entschärft.
- **Reflektiertes HTML im Google-Rücksprung.** `GET /api/google/rueckkehr` ist ohne Anmeldung
  erreichbar und baute den Parameter `error` roh in die Antwortseite ein. Damit war fremdes
  HTML oder Skript auf der Panel-Adresse ausführbar. Alle eingesetzten Werte werden jetzt
  maskiert.

### Änderungen

- **Obergrenze für KI-Entwürfe:** `POST /api/aktionen/entwurf` erlaubt zehn Anfragen pro
  Minute und Benutzer. Jeder Entwurf kostet eine Gemini-Anfrage, und das Freikontingent ist
  am Tag begrenzt.
- `services/aktionenPatcher.js` benutzte NUL-Zeichen als interne Marker und galt Git dadurch
  als Binärdatei — Änderungen daran waren im Diff nicht prüfbar. Jetzt stehen sie als
  Escape-Sequenz in der Datei; das Verhalten ist unverändert.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** keine Migration, kein Schemawechsel.
- **n8n-Workflows:** **kein Neuimport nötig.** Aber einmal nach dem Update auf der
  Workflows-Seite **„Konten neu verdrahten"** drücken (oder eine Aktion speichern) — erst
  dabei wird Workflow 07 veröffentlicht und die Aktionsknoten werden mit der abgesicherten
  Fassung neu erzeugt. Ohne diesen Schritt bleiben bestehende Aktionsknoten in ihrer alten
  Form und 01/04 lassen sich weiter nicht einschalten.
- **Neustart & Sitzungen:** nur ein Neustart des Panel-Containers, keine Abmeldung,
  Tokens und Passkeys bleiben gültig.
- **Sichtbare Änderung im Betrieb:** Workflow 07 steht in der Übersicht ab jetzt auf
  „aktiv". Das ist beabsichtigt — er hat keinen eigenen Auslöser und läuft nur, wenn 01
  oder 04 ihn aufrufen.

## [2.2.0.0] - 2026-08-14 (Build 24) — *Eigene Aktionen mit KI-Assistent*

### Features

- **Eigene Aktionen** (neuer Bereich auf der Workflows-Seite). Man beschreibt in einem Satz,
  was passieren soll — etwa „Rechnungen von amazon.de als PDF in Nextcloud unter
  Belege/{{jahr}} ablegen". Gemini übersetzt das in eine Regel, das Panel zeigt sie als
  Formular zur Kontrolle, und erst nach Bestätigung wird sie gespeichert und in n8n gebaut.
  Wer lieber selbst tippt, füllt dasselbe Formular direkt aus.
- **Vier Ziele:** Anhänge in einen Nextcloud-Ordner legen, Termine im Nextcloud-Kalender
  (CalDAV) oder im Google-Kalender anlegen, oder eine beliebige Adresse aufrufen.
  In Textfeldern gibt es Platzhalter wie `{{jahr}}`, `{{absender}}` oder `{{betreff}}`.
- **Die KI kann nichts kaputt machen.** Sie füllt nur ein festes Schema aus
  (`services/aktionenSchema.js`); erfundene Felder, Vergleiche oder Aktionstypen werden
  verworfen. Die n8n-Knoten entstehen anschließend aus geprüften Vorlagen im Panel —
  von der KI erzeugtes Workflow-JSON kommt nie in n8n an.
- **Neuer Workflow `07 - Eigene Aktionen`.** Die Workflows 01 und 04 rufen ihn nach der
  Klassifizierung auf, bewusst als zweiter Abzweig neben dem Verschieben: Eine
  fehlgeschlagene Aktion hält die Einsortierung so nicht auf.
- **Nextcloud im Panel einrichten:** Adresse, Benutzer und App-Passwort eintragen, Verbindung
  testen — das Panel legt die beiden nötigen Credentials selbst in n8n an. Fehlende Ordner
  im Zielpfad werden beim Ablegen automatisch erstellt.
- **Google-Anmeldung im Panel statt in n8n.** Der Google-Kalender-Knoten von n8n kennt nur
  OAuth2, dessen Zustimmungsdialog in der n8n-Oberfläche läuft. Stattdessen meldet man sich
  im Panel an; die Workflows holen sich über den internen Endpunkt
  `/api/internal/google-token` einen kurzlebigen Zugriffs-Token. n8n sieht die Zugangsdaten nie.
- **Webhook-Ziele werden geprüft:** Adressen im eigenen Netz lehnt das Panel beim Speichern
  ab — sonst wäre die Aktion ein Werkzeug für Anfragen nach innen (derselbe Schutz wie beim
  Abmelde-Link).

### Bugfixes

- **Gemini-Schlüssel und Telegram-Token ließen sich gar nicht speichern.** Die Felder gab es
  in der Oberfläche, gelesen wurden sie auch — nur fehlten sie in der Liste der erlaubten
  Einstellungen, sodass jede Eingabe stillschweigend verworfen wurde. Damit lief die
  KI-Klassifizierung bei niemandem, der sie über das Panel eingerichtet hat.
- **Anhänge kamen nie in den Workflows an.** Dem IMAP-Trigger fehlte `downloadAttachments`;
  ohne das gibt es keine Binärdaten — der Virenscan und alle Datei-Aktionen liefen deshalb ins Leere.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Workflows 01 und 04 neu importieren**, danach „Synchronisieren" — der Sync trägt den
  Aufruf von Workflow 07 ein. Workflow 07 selbst kommt über „Neu importieren".
- **Neue Tabelle `aktionen`** (wird automatisch angelegt), neue Einstellungen für Nextcloud
  und Google.
- **Anhänge werden jetzt heruntergeladen.** Das kostet Arbeitsspeicher je Ausführung —
  bei sehr großen Anhängen entsprechend mehr.
- Für Google muss die im Panel angezeigte Rücksprung-Adresse in der Google Cloud Console
  als Weiterleitungs-URI hinterlegt sein.
- Auf dem Testserver verifiziert: Regel anlegen, Workflow 07 wird gebaut, Aufruf aus einem
  Workflow, Webhook erhält die Maildaten, unpassende Mails lösen nichts aus, und ein echter
  Anhang landet in einer echten Nextcloud unter `Belege/2026/`.
  Nicht getestet mangels Zugangsdaten: Google-Kalender und der Nextcloud-Kalender.

## [2.1.0.0] - 2026-08-13 (Build 23) — *n8n aus dem Panel steuern*

### Features

- **Neue Seite „Workflows"** (löst den Platzhalter ab). Sie zeigt alle Workflows mit
  Status und letztem Lauf, schaltet sie ein und aus und listet die letzten Ausführungen.
  Ein Klick auf einen Lauf zeigt jeden Knoten einzeln — mit Fehlertext im Klartext, statt
  ihn in n8n suchen zu müssen.
- **Aufgeklappte Ansicht je Workflow:** alle Knoten mit Kennzeichnung, welche davon das
  Panel verwaltet (Präfix `panel-`) und welche mangels Zugangsdaten stillgelegt sind —
  samt Hinweis, dass sie wieder mitlaufen, sobald die Zugangsdaten da sind.
- **Knöpfe „Neu importieren" und „Synchronisieren"** direkt auf der Seite: fehlende
  Basis-Workflows nach n8n bringen und die Konten neu verdrahten.
- Scheitert das Einschalten, reicht das Panel den Grund von n8n unverändert durch
  (fehlende Zugangsdaten, kein Trigger-Knoten) statt nur zu melden, dass es nicht ging.

### Bugfixes

- **Aktive Workflows wurden bei jedem Konto-Sync stillschweigend abgeschaltet.** Die
  Aktivierung über die n8n-API scheiterte an einem falschen Content-Type: Ohne Rumpf
  schickt axios `application/x-www-form-urlencoded`, was n8n mit „unsupported media type"
  ablehnt. Da der Patcher nach dem Speichern wieder aktiviert, blieb ein zuvor aktiver
  Workflow danach aus — die Live-Triage lief nach jeder Kontoänderung nicht mehr.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Neues Recht `workflows`** wird für die Seite gebraucht. Die Admin-Rolle hat es bereits;
  eigene Rollen brauchen es einmalig unter „Benutzer & Rollen".
- Keine DB-Migration, keine Änderung an den Workflow-Vorlagen.
- Die n8n-Oberfläche bleibt erreichbar und wird für Sonderfälle auch weiterhin gebraucht
  (etwa für die Gmail-Anmeldung per OAuth).

## [2.0.0.2] - 2026-08-13 (Build 22) — *Prüfbericht abgearbeitet*

Alle Punkte stammen aus einer Code-Durchsicht plus rund 50 Prüfungen gegen den laufenden
Stack auf dem Testserver (echtes n8n, echtes Dovecot-Postfach, ClamAV, unbound).

### Sicherheit

- **Rechteausweitung beim Neustart geschlossen.** Beim Start wurde `rolle_id = 1` für alle
  Benutzer ohne Rolle gesetzt — jeder bewusst ohne Rolle angelegte Zugang wurde damit beim
  nächsten Neustart Administrator. Die Übernahme läuft jetzt einmalig als Migration
  (Marker `migration_rollen_erledigt`), und beim Anlegen ist eine Rolle Pflicht.
- **Serverseitige Anfragefälschung (SSRF) beim Newsletter-Abbestellen geschlossen.** Die
  aufgerufene Adresse stammt aus dem `List-Unsubscribe`-Header und damit vom Absender der
  Mail. Ohne Prüfung ließen sich darüber Dienste im eigenen Docker-Netz erreichen
  (nachgewiesen mit `http://n8n:5678/healthz`). Neuer Helfer `services/urlSchutz.js`:
  nur http/https, Auflösung des Namens, Ablehnung privater, lokaler, Link-Local- und
  Metadaten-Adressen, 10 s Zeitlimit, keine Weiterleitungen.
- **Der letzte Administrator kann sich nicht mehr selbst herabstufen** — bisher war nur das
  Löschen abgesichert, nicht der Rollenwechsel. Danach kam niemand mehr an die
  Benutzerverwaltung.
- **Log-Endpunkt gebremst:** `POST /api/logs/client` nimmt weiterhin ohne Anmeldung
  Browser-Fehler an (der Fehler kann ja die Anmeldung selbst betreffen), jetzt aber
  begrenzt auf 30 Meldungen je Minute und IP, mit 64 KB Obergrenze je Meldung.
- **Passkeys:** Ohne `ALLOWED_ORIGIN` wurden erwartete Herkunft und RP-ID aus den
  Kopfzeilen der Anfrage abgeleitet — also aus Werten, die der Aufrufer selbst bestimmt.
  Im Produktivbetrieb wird das jetzt abgelehnt, in der Entwicklung bleibt es erlaubt.

### Bugfixes

- **Die Triage-Workflows liefen überhaupt nicht.** In den Knoten *Sortierung prüfen* und
  *Gleich sortieren?* fehlte in fünf Ausdrücken das `$json` (`{{ .konto }}` statt
  `{{ $json.konto }}`) — n8n brach jeden Lauf mit „invalid syntax" ab, bevor eine Mail
  klassifiziert wurde.
- **Neuer Knoten *Sortierung auswerten*.** Der HTTP-Knoten davor ersetzt das Item durch
  seine Antwort; danach kannten alle folgenden Knoten die Mail nicht mehr, sodass die
  Panel-Prüfung mit leerem Absender lief und weder White- noch Blacklist griffen.
- **Workflow 01 ließ sich ohne Gmail-Konto gar nicht aktivieren** („Missing required
  credential"). Knoten ohne hinterlegte Zugangsdaten (Gmail, Telegram, verwaiste
  IMAP-Knoten) werden beim Konto-Sync jetzt automatisch stillgelegt und laufen wieder mit,
  sobald Zugangsdaten da sind. Damit ist auch **Workflow 03** wieder aktivierbar, der
  wegen alter, fest verdrahteter IMAP-Knoten für alle blockiert war.
- **Workflow 04:** *Virus Warnung (Telegram)* und *Virus: Quarantäne* zeigten auf
  `$('Normalisieren')` — dort heißt der Knoten *Sammeln + Normalisieren*. Bei einem
  Virusfund brach genau der Zweig ab, der warnen sollte.
- Sortier-Regeln lassen sich nicht mehr für nicht existierende Konten anlegen; das Löschen
  einer unbekannten Regel meldet jetzt 404 statt Erfolg.
- Zeitlimits für alle externen Aufrufe (Safe Browsing, n8n-Status, Abmelde-Links).
- Der n8n-Status im Dashboard nutzt jetzt den im Panel hinterlegten API-Key statt einer
  Umgebungsvariablen, die im Normalfall gar nicht gesetzt ist.
- Debug-Datei `backend/src/test-db.js` entfernt.

### Verbesserungen

- Beim Anlegen eines Kontos weist das Formular auf Port 993 hin. Auf Port 143 verweigern
  viele Server die Anmeldung, weil der IMAP-Trigger von n8n dort kein STARTTLS anbietet.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Workflows 01, 03 und 04 müssen neu importiert werden**, danach einmal „Workflows
  synchronisieren" im Panel klicken. Der Sync legt dabei Knoten ohne Zugangsdaten still.
- **Benutzer ohne Rolle** lassen sich nicht mehr anlegen. Bestehende Zugänge ohne Rolle
  behalten ihre (fehlenden) Rechte und werden nicht mehr stillschweigend zu Admins —
  ihnen muss einmalig von Hand eine Rolle zugewiesen werden.
- **Passkeys im Produktivbetrieb brauchen `ALLOWED_ORIGIN`** (die Panel-Adresse, z.B.
  `https://panel.example.org`). Fehlt die Variable, lehnt das Panel die Passkey-Anmeldung
  mit einer entsprechenden Meldung ab.
- Neue Einstellung `migration_rollen_erledigt` in der Panel-Datenbank; keine Migration nötig.
- Bekannte Einschränkung: In Workflow 04 werden beim Bestandsabruf keine Anhänge geladen,
  der ClamAV-Zweig greift dort deshalb nicht. Für neu eintreffende Mails (Workflow 01)
  funktioniert der Virenscan.

## [2.0.0.1] - 2026-08-12 (Build 21) — *Dashboard DB Fix*

### Features / Bugfixes

- **Fix:** Fehlende Datenbank-Migration für die `virus_name`-Spalte in der `quarantine_log`-Tabelle hinzugefügt. Zuvor führte eine fehlende Spalte bei bestehenden Installationen zu einem 500-Fehler beim Laden der Dashboard-Statistiken, wodurch das Dashboard nicht gerendert wurde.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **Datenbank:** Fügt die `virus_name`-Spalte zur `quarantine_log`-Tabelle per `ALTER TABLE` hinzu, wenn sie nicht existiert. Das Dashboard sollte danach wieder normal laden.

---

## [2.0.0.0] - 2026-08-11 (Build 20) — *Custom Folders & 2FA Hint*

- **Feature:** Eigene IMAP-Ordnernamen! Unterhalb der Kontodaten im Panel kann nun definiert werden, in welche Ordner Spam, Rechnungen, Bestellungen und Newsletter verschoben werden sollen, falls man die Standardnamen nicht mag. Bleiben Felder leer, werden die Standardnamen (z. B. "Quarantaene") verwendet.
- **Feature:** Der n8n-Patcher wurde erweitert: Klickt man auf "Workflows synchronisieren", sucht er nun automatisch in den laufenden Workflows (01 und 04) den "Antwort parsen"-Knoten und rüstet den JS-Code so um, dass er die eigenen Ordnernamen unterstützt. (Ein manuelles Neuimportieren der Vorlagen ist damit nicht nötig).
- **Feature:** Das Panel-Frontend hilft Nutzern, die Gmail-Verbindungsprobleme haben, indem es explizit auf die Notwendigkeit eines speziellen App-Passworts hinweist, sobald das Passwort-Feld fokussiert oder ausgefüllt wird, falls 2FA im Google-Konto aktiv ist.
- **Fix:** Die Preset-Auswahl (z. B. "Gmail (IMAP)") setzt den Kontonamen nun auf "Gmail" anstatt den in Klammern gesetzten String zu verwenden. Das Backend lehnte Klammern aus Sicherheitsgründen zuvor beim Speichern ab.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Tabelle `accounts` wurde um die Spalten `folder_spam`, `folder_invoices`, `folder_orders`, und `folder_newsletter` erweitert (via `ALTER TABLE`).
- **n8n-Workflow-Kompatibilität:** 100% kompatibel. Der Patcher passt bestehende Workflows dynamisch an. Die mitgelieferten Vorlagen `01-inbox-triage.json` und `04-bestand-triage.json` wurden im Codebase geupdatet.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen auf aktive Sessions.

## [1.9.2.0] - 2026-08-11 (Build 19) — *Auto-Config für KI & Telegram*

### Features / Bugfixes

- **Feature:** Konfiguration für Gemini (API-Key) und Telegram (Bot-Token, Chat-ID) direkt in die Panel-Einstellungen integriert.
- **Feature:** Der n8n-Workflow-Patcher überträgt die KI- und Benachrichtigungs-Zugangsdaten (sowie Parameter wie `chatId`) nun bei jedem "Workflows synchronisieren" automatisch in alle Workflows. Manuelles Bearbeiten der Knoten in n8n entfällt damit komplett.
- **Doku:** README.md aktualisiert, um die neue Auto-Konfiguration zu erklären.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine (Werte landen als einfache Keys in der `settings`-Tabelle).
- **n8n-Workflow-Kompatibilität:** Workflows müssen über das Panel synchronisiert werden, damit die neuen Keys ankommen. Keine Änderungen an der Logik.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.9.1.0] - 2026-08-11 (Build 18) — *Pride Flag Toggle*

### Features / Bugfixes

- **Feature:** Option zum Ein- und Ausblenden der Pride Flag (im Version-Bereich der Seitenleiste) direkt in den Panel-Einstellungen unter „Oberfläche" hinzugefügt (analog zum Überwachungs-Panel).

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Keine. Wird lokal im Browser (localStorage) gespeichert.
- **n8n-Workflow-Kompatibilität:** Keine Auswirkungen.
- **Neustart-/Session-Verhalten:** Keine Auswirkungen.

## [1.9.0.0] - 2026-08-11 (Build 17) — *Mehrbenutzer & Rollen*

### Features / Bugfixes

- **Feature:** Dynamisches Rollen-System zur feingranularen Rechteverwaltung. Eine Admin-Rolle mit Vollzugriff ist fest im System integriert; weitere Rollen (z. B. Viewer oder Operator) können frei angelegt und mit spezifischen Rechten (pro Bereich wie Quarantäne, Einstellungen, etc.) versehen werden.
- **Feature:** Neue Seite „Benutzer & Rollen" im Frontend zur Verwaltung von Konten und deren Rollenzuweisung.
- **Feature:** Umfassendes Auth-Log. Jeder Anmeldeversuch (sowohl erfolgreiche als auch fehlgeschlagene) wird mit Zeitstempel, Benutzername, IP-Adresse, User-Agent und abgeleiteter Herkunft (GeoIP) protokolliert und kann in der Benutzer-Seite eingesehen werden.
- **Feature:** Backend-Sicherheit verschärft: Alle geschützten API-Routen prüfen nun explizit, ob der anfragende Nutzer das entsprechende Recht (`rechtErforderlich()`) aus seiner Rolle besitzt. Das Frontend blendet Seiten und Menüeinträge entsprechend aus.
- **Sicherheit:** Schutzmechanismen eingebaut, die verhindern, dass Nutzer sich selbst löschen oder der letzte verbleibende Admin gelöscht wird.

### System-Auswirkungen & Nachwirken (Impact Analysis)

- **DB-Migration:** Neue Tabellen `rollen` und `auth_log` angelegt. Die Tabelle `users` erhält die neue Spalte `rolle_id`. Bestehende Benutzer bekommen bei der Migration automatisch die Admin-Rolle zugewiesen, um Abwärtskompatibilität zu gewährleisten.
- **n8n-Workflow-Kompatibilität:** Keine Änderungen an den Workflows.
- **Neustart-/Session-Verhalten:** Da sich die Struktur des JWT-Tokens ändert (es enthält nun die Rechte), ist ein erneuter Login ratsam. Zwar werden alte Tokens vom Backend verifiziert, jedoch fehlt ihnen die Berechtigung für die neuen API-Endpunkte.

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
