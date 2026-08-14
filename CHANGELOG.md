# Changelog — Mail-Panel

Versionsschema: `Major.Minor.Änderung.Fix` (siehe AGENTS.md, Abschnitt 2).

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
