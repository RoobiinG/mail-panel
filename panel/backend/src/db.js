const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Datenbank liegt im Volume /app/data (Docker) bzw. panel/backend/data (Entwicklung)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'mail-panel.db'));

// ─── SQLite Performance-Pragmas (Muster: Überwachungs-Panel) ─────────────────
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('cache_size   = -16000');
db.pragma('temp_store   = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    device_type TEXT NOT NULL,
    backed_up INTEGER NOT NULL,
    transports TEXT,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- IMAP-Konten, die das Panel in n8n verdrahtet (Gmail bleibt fest in n8n)
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    n8n_credential_id TEXT,
    aktiv INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Triage-Ergebnisse aus Workflow 01/04 (via /api/internal/log)
  CREATE TABLE IF NOT EXISTS quarantine_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto TEXT NOT NULL,
    von TEXT NOT NULL,
    betreff TEXT,
    kategorie TEXT,
    spam_score REAL,
    zielordner TEXT,
    kurzfassung TEXT,
    list_unsubscribe TEXT,
    virus_name TEXT,
    dnsbl_treffer TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_qlog_created ON quarantine_log(created_at);

  -- Eigene White-/Blacklist (Whitelist schlaegt alles, Blacklist = direkt Quarantaene)
  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    typ TEXT NOT NULL CHECK(typ IN ('whitelist','blacklist')),
    muster TEXT NOT NULL,
    kommentar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Newsletter-Absender fuer die Abbestellen-Seite
  CREATE TABLE IF NOT EXISTS newsletter_senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absender TEXT UNIQUE NOT NULL,
    anzahl INTEGER NOT NULL DEFAULT 1,
    list_unsubscribe TEXT,
    abbestellt_am DATETIME,
    zuletzt_gesehen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Panel-Logs: Backend-Fehler, Frontend-Fehler, Container-Status
  CREATE TABLE IF NOT EXISTS panel_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'error',
    quelle TEXT,
    nachricht TEXT NOT NULL,
    stack TEXT,
    request_url TEXT,
    request_method TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_plogs_created ON panel_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_plogs_level ON panel_logs(level);

  -- Verschlüsselte geteilte Logs (Zero-Knowledge)
  CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Rollen: Admin fest, weitere frei erstellbar
  CREATE TABLE IF NOT EXISTS rollen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    fest INTEGER NOT NULL DEFAULT 0,
    rechte TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Auth-Log: jede Anmeldung wird protokolliert
  CREATE TABLE IF NOT EXISTS auth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    erfolg INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT,
    herkunft TEXT,
    methode TEXT DEFAULT 'passwort',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_authlog_created ON auth_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_authlog_user ON auth_log(user_id);

  -- Sortier-Regeln pro Konto
  --
  -- Vier Arten, von eng nach weit: ein exakter Absender, ein Stichwort im
  -- Betreff, eine ganze Domain, ein Stichwort im INHALT der Mail. Dazu zwei
  -- freiwillige Zusatzbedingungen (betreff_muster, inhalt_muster), die eine
  -- Absender- oder Domain-Regel einengen.
  --
  -- Warum der Inhalt: Viele Unternehmen verschicken alles ueber dieselbe
  -- Adresse — Buchungsbestaetigung, Rechnung und Werbung kommen von
  -- "donotreply@". Eine Absender-Regel kann da nur falsch liegen, egal wohin
  -- sie zeigt. Erst der Text der Mail trennt die Faelle.
  CREATE TABLE IF NOT EXISTS sort_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto_id INTEGER NOT NULL,
    typ TEXT NOT NULL CHECK(typ IN ('absender','betreff','domain','inhalt')),
    muster TEXT NOT NULL,
    zielordner TEXT NOT NULL,
    treffer INTEGER NOT NULL DEFAULT 0,
    erstellt_von INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Sortier-Inbox fuer unbekannte Mails
  CREATE TABLE IF NOT EXISTS sort_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto TEXT NOT NULL,
    konto_id INTEGER,
    von TEXT NOT NULL,
    betreff TEXT,
    uid TEXT,
    vorschlag TEXT,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','zugeordnet','ignoriert')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sortinbox_status ON sort_inbox(status);

  -- Bestands-Triage: Mails, die entschieden sind und trotzdem im Posteingang
  -- bleiben. Ohne diese Liste böte das Panel dieselbe Mail bei jedem Lauf
  -- wieder an, und die Triage käme nie über die ersten hundert Mails hinaus.
  -- Verschobene Mails stehen hier bewusst NICHT: Die sind aus dem Posteingang
  -- verschwunden, und scheitert das Verschieben, sollen sie wiederkommen.
  CREATE TABLE IF NOT EXISTS bestand_erledigt (
    konto_id INTEGER NOT NULL,
    ordner TEXT NOT NULL,
    uid INTEGER NOT NULL,
    grund TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (konto_id, ordner, uid)
  );

  -- Eigene Aktionen: "Wenn eine Mail so aussieht, mach das damit."
  -- bedingung und konfig sind JSON; der Aktionen-Patcher baut daraus die
  -- Knoten in Workflow 07.
  CREATE TABLE IF NOT EXISTS aktionen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    beschreibung TEXT,
    bedingung TEXT NOT NULL DEFAULT '{}',
    typ TEXT NOT NULL CHECK(typ IN ('nextcloud_datei','nextcloud_kalender','google_kalender','webhook')),
    konfig TEXT NOT NULL DEFAULT '{}',
    aktiv INTEGER NOT NULL DEFAULT 1,
    treffer INTEGER NOT NULL DEFAULT 0,
    erstellt_von INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Themen-Katalog: die Ordner, in die die KI einsortieren darf. Gefuellt aus dem
  -- Postfach (quelle 'imap'), von Hand ('manuell') oder von der KI selbst ('ki').
  -- Die Beschreibung wandert eins zu eins in den Gemini-Prompt.
  CREATE TABLE IF NOT EXISTS konto_ordner (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto_id INTEGER NOT NULL,
    ordner TEXT NOT NULL,
    beschreibung TEXT,
    quelle TEXT NOT NULL DEFAULT 'imap' CHECK(quelle IN ('imap','ki','manuell')),
    gesperrt INTEGER NOT NULL DEFAULT 0,
    treffer INTEGER NOT NULL DEFAULT 0,
    zuletzt_genutzt DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(konto_id, ordner),
    FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Beleg-Ablage: Protokoll dessen, was der Beleg-Leser (services/belegLeser.js)
  -- aus PDF-Anhaengen gelesen und entschieden hat. Zwei Zwecke: Deduplizierung
  -- (dieselbe Mail bei einem Wiederhollauf nicht erneut per KI lesen) und Anzeige
  -- unter Sortierung/Dashboard (heute gelesen / uebersprungen). gespeichert=0 heisst:
  -- geprueft, aber kein Beleg (AGB, Werbung, …) — landet NICHT in Nextcloud.
  CREATE TABLE IF NOT EXISTS beleg_ablage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto TEXT,
    von TEXT,
    betreff TEXT,
    dateiname TEXT,
    dokumenttyp TEXT,
    gespeichert INTEGER NOT NULL DEFAULT 0,
    firma TEXT,
    aktenzeichen TEXT,
    datum TEXT,
    -- 'ki' = wirklich per Gemini gelesen (zaehlt gegen das Lese-Budget),
    -- 'heuristik' = ohne KI entschieden (Deckel voll / kein Schluessel).
    quelle TEXT NOT NULL DEFAULT 'ki',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_beleg_created ON beleg_ablage(created_at);

  -- Ordner, die die KI vorgeschlagen hat und die auf eine Freigabe warten
  CREATE TABLE IF NOT EXISTS ordner_vorschlaege (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto_id INTEGER NOT NULL,
    ordner TEXT NOT NULL,
    begruendung TEXT,
    anzahl INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','freigegeben','abgelehnt')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(konto_id, ordner),
    FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_vorschlaege_status ON ordner_vorschlaege(status);

  -- Anhaenge, die auf eine Freigabe warten, bevor sie in die Nextcloud gehen.
  --
  -- n8n kann nicht auf einen Menschen warten: Workflow 07 liefert die Datei ab
  -- und laeuft weiter, hochgeladen wird spaeter hier im Panel — dasselbe Muster
  -- wie bei ordner_vorschlaege, wo das Panel nach der Freigabe selbst per IMAP
  -- verschiebt.
  --
  -- Vorschlag und Entscheidung stehen getrennt (wie ki_ordner/vorschlag in
  -- sort_inbox): Nur so laesst sich hinterher sehen, was die Automatik wollte
  -- und was der Mensch daraus gemacht hat.
  --
  -- Die Datei selbst liegt im Zwischenlager unter DATA_DIR, nicht als BLOB:
  -- 15 MB je Zeile blaehen die WAL-Datei und jedes SELECT * auf. In "ablage"
  -- steht nur der Dateiname, nie ein Pfad — DATA_DIR unterscheidet sich
  -- zwischen Docker und Entwicklung.
  CREATE TABLE IF NOT EXISTS upload_freigaben (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Kein FOREIGN KEY: Wird die Aktion geloescht, bleibt die wartende Datei
    -- trotzdem gueltig — sie ist ja schon da.
    aktion_id INTEGER,
    aktion_name TEXT,
    konto TEXT,
    von TEXT,
    betreff TEXT,
    uid TEXT,
    ordner TEXT,
    dateiname TEXT NOT NULL,
    dateiname_final TEXT,
    zielpfad TEXT NOT NULL,
    zielpfad_final TEXT,
    groesse INTEGER NOT NULL DEFAULT 0,
    ablage TEXT NOT NULL,
    firma TEXT,
    aktenzeichen TEXT,
    datum TEXT,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','hochgeladen','verworfen')),
    fehler TEXT,
    erledigt_am DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_upload_freigaben_status ON upload_freigaben(status);
  -- Ein Wiederhollauf der Bestands-Triage liefert dieselbe Datei erneut ein.
  -- Der Index verhindert die Dublette in der Warteschlange, laesst eine spaetere
  -- Einlieferung nach dem Erledigen aber wieder zu.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_freigaben_offen
    ON upload_freigaben(konto, uid, dateiname) WHERE status = 'offen';

  -- Umgeleitete Vorschlaege: "Das gehoert nicht in einen neuen Ordner, das
  -- gehoert nach X." Schlaegt die KI denselben Namen wieder vor, wird er direkt
  -- aufgeloest — es entsteht kein zweiter Ordner und keine neue Nachfrage.
  -- Der Nutzer sieht die Zuordnung unter den Themen-Ordnern und kann sie loesen.
  -- Wer schickt die meisten Mails im Posteingang? Die Antwort entscheidet bei
  -- einem grossen Bestand alles: Eine Regel fuer den groessten Absender raeumt
  -- Tausende ab, ohne KI. Gefuellt wird die Tabelle auf Knopfdruck (das Zaehlen
  -- liest alle Umschlaege und dauert bei zehntausenden Mails eine Weile), gelesen
  -- wird sie danach beliebig oft.
  CREATE TABLE IF NOT EXISTS absender_stat (
    konto_id INTEGER NOT NULL,
    adresse TEXT NOT NULL,
    domain TEXT,
    anzahl INTEGER NOT NULL DEFAULT 0,
    aktualisiert DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (konto_id, adresse),
    FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Anordnung der Widgets, je Benutzer und Seite. Gespeichert wird genau das
  -- Format von react-grid-layout ({i,x,y,w,h,...}) als JSON — das Panel deutet
  -- es nicht, es reicht es nur durch. Passt eine gespeicherte Anordnung nicht
  -- mehr zum Widget-Katalog (weil Widgets dazukommen oder wegfallen), gleicht
  -- das Frontend sie beim Laden ab; hier ist deshalb nie etwas zu migrieren.
  --
  -- "seite" trennt Dashboard und Statistik: Jede Seite hat ihren eigenen
  -- Katalog, eine gemeinsame Zeile waere fuer beide die falsche.
  --
  -- Der Schluessel steht als eigene Zeile statt als Spaltenzusatz: So ist er
  -- eine echte Eindeutigkeitsbedingung und kein rowid-Aliasname — nur darauf
  -- darf sich das ON CONFLICT der Speicher-Route beziehen.
  CREATE TABLE IF NOT EXISTS dashboard_layouts (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seite      TEXT    NOT NULL DEFAULT 'dashboard',
    layout     TEXT    NOT NULL DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, seite)
  );

  CREATE TABLE IF NOT EXISTS ordner_alias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    ordner TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(konto_id, alias),
    FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
`);

// ─── Migrationen: neue Spalten kommen als try/catch-ALTER dazu ───────────────
const migrations = [
  // Eigene Mailserver laufen oft mit selbstsigniertem Zertifikat
  'ALTER TABLE accounts ADD COLUMN tls_unsicher INTEGER NOT NULL DEFAULT 0',
  // Mehrbenutzer: Rollenzuweisung
  'ALTER TABLE users ADD COLUMN rolle_id INTEGER DEFAULT NULL',
  // Eigene IMAP-Ordnernamen pro Konto
  'ALTER TABLE accounts ADD COLUMN folder_spam TEXT',
  'ALTER TABLE accounts ADD COLUMN folder_invoices TEXT',
  'ALTER TABLE accounts ADD COLUMN folder_orders TEXT',
  'ALTER TABLE accounts ADD COLUMN folder_newsletter TEXT',
  // Zielordner des Newsletter-Aufräumens (Workflow 03)
  'ALTER TABLE accounts ADD COLUMN folder_archive TEXT',
  // Viren-Scanner: Speichern des Virus-Namens
  'ALTER TABLE quarantine_log ADD COLUMN virus_name TEXT',
  // Panel-Logs: neues Schema (Überwachungs-Panel-kompatibel)
  'ALTER TABLE panel_logs ADD COLUMN source TEXT',
  'ALTER TABLE panel_logs ADD COLUMN message TEXT',
  'ALTER TABLE panel_logs ADD COLUMN url TEXT',
  // Themen-Sortierung: was die KI vorgeschlagen hat, auch wenn es verworfen wurde
  'ALTER TABLE sort_inbox ADD COLUMN ki_ordner TEXT',
  'ALTER TABLE sort_inbox ADD COLUMN ki_konfidenz REAL',
  'ALTER TABLE sort_inbox ADD COLUMN ki_grund TEXT',
  // Welche Kategorie die KI der wartenden Mail gab — für die Aufschlüsselung
  // und die Filter in der Sortier-Inbox (persönlich, sonstiges, …).
  'ALTER TABLE sort_inbox ADD COLUMN kategorie TEXT',
  'ALTER TABLE quarantine_log ADD COLUMN thema TEXT',
  'ALTER TABLE quarantine_log ADD COLUMN konfidenz REAL',
  // Ohne die UID laesst sich eine falsch einsortierte Mail im Postfach nicht
  // wiederfinden — und ohne das gibt es keine Korrektur.
  'ALTER TABLE quarantine_log ADD COLUMN uid TEXT',
  'ALTER TABLE quarantine_log ADD COLUMN korrigiert_zu TEXT',
  // System-Presets unter den Aktionen markieren (z.B. die automatische
  // Beleg-Ablage). NULL = vom Nutzer angelegt, sonst ein fester Schluessel.
  'ALTER TABLE aktionen ADD COLUMN schluessel TEXT',
  // Sortier-Regeln koennen jetzt auch "nichts tun" heissen: 'verschieben' (wie
  // bisher) oder 'behalten' — die Mail bleibt unangetastet im Posteingang und
  // taucht auch nicht mehr in der Sortier-Inbox auf.
  "ALTER TABLE sort_rules ADD COLUMN aktion TEXT NOT NULL DEFAULT 'verschieben'",
  // Eine zweite, freiwillige Bedingung: Der Betreff muss diesen Text enthalten.
  //
  // Unternehmen verschicken Bestellbestaetigung, Rechnung und Werbung ueber
  // dieselbe Adresse. Eine Absender-Regel kennt aber nur einen Zielordner —
  // entweder geht alles nach "Einkauf" oder alles nach "Bestellungen", und
  // beides ist falsch. Mit dieser Spalte laesst sich derselbe Absender nach dem
  // Betreff aufteilen. Leer/NULL = die Regel gilt wie bisher fuer alles.
  'ALTER TABLE sort_rules ADD COLUMN betreff_muster TEXT',
  // Die zweite freiwillige Bedingung: ein Stichwort im Text der Mail.
  'ALTER TABLE sort_rules ADD COLUMN inhalt_muster TEXT',
  // Hat für diese Mail wirklich die KI gearbeitet? Eine Mail, die eine eigene
  // Sortier-Regel trifft, läuft im Workflow an Gemini vorbei — sie darf das
  // Tagesbudget nicht verbrauchen. Vorher zählte jede Zeile als KI-Aufruf.
  'ALTER TABLE quarantine_log ADD COLUMN ki INTEGER DEFAULT 1',
  // Was die KI ueber einen Ordner gelernt hat: Absender-Domains, die sie dort
  // einsortiert hat, obwohl sie nicht in der Beschreibung stehen. Getrennt vom
  // Nutzertext, damit der nie ueberschrieben wird — und beim naechsten Mal
  // trifft schon der Stichwort-Vergleich, ganz ohne KI.
  'ALTER TABLE konto_ordner ADD COLUMN gelernt TEXT',
  // Warum ist diese Mail dort gelandet? Die Begründung stand bisher nur in der
  // Antwort an n8n und in der Sortier-Inbox — im Protokoll fehlte sie. Damit war
  // die häufigste Frage bei einer Fehleinordnung („wieso das?") nicht mehr zu
  // beantworten, sobald die Mail einmal verschoben war.
  'ALTER TABLE quarantine_log ADD COLUMN grund TEXT',
  // Die Entscheidungs-Chronik wird seitenweise durchblättert und durchsucht;
  // ohne Index las SQLite dafür bei jedem Klick die ganze Tabelle. Bei
  // fünfstelligen Zeilenzahlen ist das der Unterschied zwischen sofort und
  // spürbar.
  'CREATE INDEX IF NOT EXISTS idx_qlog_konto ON quarantine_log(konto, id)',
  // Einmalige Bereinigung: Bis Build 95 wurde beim Freigeben eines Vorschlags
  // dessen interne Notiz als Beschreibung in den Katalog geschrieben ("Zuletzt
  // vorgeschlagen für: noreply@steampowered.com"). Im Prompt war das nutzlos —
  // und seit Build 93 wertet das Panel die Beschreibung als Stichworte aus, wo
  // "zuletzt" und "vorgeschlagen" nichts verloren haben. Die Adresse bleibt
  // stehen, die sagt etwas aus. Laeuft bei jedem Start, trifft aber nach dem
  // ersten Mal nichts mehr.
  "UPDATE konto_ordner SET beschreibung = TRIM(REPLACE(beschreibung, 'Zuletzt vorgeschlagen für:', ''))"
  + " WHERE beschreibung LIKE 'Zuletzt vorgeschlagen für:%'",
  // Hier stand bis Build 251 eine „einmalige" Umbenennung eines Kontos von
  // „Web.de" auf einen festen Kontonamen. Sie lief in Wahrheit bei JEDEM Start
  // und bei JEDER Installation — wer sein Konto „Web.de" nannte, dessen
  // Protokoll wurde bei jedem Neustart einem fremden Konto zugeschlagen. Die
  // Korrektur auf der Installation, für die sie gedacht war, ist längst gelaufen.
  // Stufe 6: Probe-Lauf für neue KI-Ordner
  'ALTER TABLE konto_ordner ADD COLUMN auf_probe INTEGER NOT NULL DEFAULT 0',
  // Aus welchem Ordner die Mail kam. Seit der Bestandslauf auch andere Ordner
  // als den Posteingang durchgeht, ist „die UID" ohne Ordner mehrdeutig: IMAP
  // vergibt UIDs je Ordner, UID 812 in „Rechnungen" ist eine andere Mail als
  // UID 812 im Posteingang. NULL heißt: Altbestand, vermutlich Posteingang.
  'ALTER TABLE quarantine_log ADD COLUMN quell_ordner TEXT',
  'ALTER TABLE sort_inbox ADD COLUMN quell_ordner TEXT',
  // Wann die Mail geschickt wurde (Date-Kopfzeile) — nicht, wann das Panel sie
  // einsortiert hat. Danach sucht man in der Chronik („die Mail von Montag").
  'ALTER TABLE quarantine_log ADD COLUMN mail_datum TEXT',
  'ALTER TABLE sort_inbox ADD COLUMN mail_datum TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* Spalte existiert schon */ }
}

// Einmalig: krumme UIDs begradigen. Aeltere Zeilen tragen die UID als "28.0",
// neuere als "28". Als Text sind das zwei verschiedene Werte — die Pruefung auf
// schon vorhandene Eintraege lief daran vorbei, und dieselbe Mail landete
// mehrfach in der Sortier-Inbox.
try {
  db.exec(`
    UPDATE sort_inbox SET uid = CAST(CAST(uid AS INTEGER) AS TEXT)
    WHERE uid IS NOT NULL AND uid LIKE '%.%';
    UPDATE quarantine_log SET uid = CAST(CAST(uid AS INTEGER) AS TEXT)
    WHERE uid IS NOT NULL AND uid LIKE '%.%';
  `);
} catch { /* Tabelle noch nicht da */ }

// ─── Admin-Rolle fest einbauen (nicht lösch-/bearbeitbar) ────────────────────
const ADMIN_RECHTE = JSON.stringify({
  konten: true, listen: true, einstellungen: true, benutzer: true,
  sortierung: true, quarantaene: true, newsletter: true, rspamd: true,
  workflows: true, logs: true, dashboard: true,
});
db.prepare(`
  INSERT OR IGNORE INTO rollen (id, name, fest, rechte)
  VALUES (1, 'Admin', 1, ?)
`).run(ADMIN_RECHTE);
// Bestehende Admin-Rolle aktualisieren (falls neue Rechte hinzukamen)
db.prepare(`UPDATE rollen SET rechte = ? WHERE id = 1 AND fest = 1`).run(ADMIN_RECHTE);

// Einmalige Übernahme für Bestandsinstallationen: Benutzer, die es schon vor der
// Rollenverwaltung gab, bekommen die Admin-Rolle.
// WICHTIG: Das darf nur ein einziges Mal laufen. Sonst würde jeder später bewusst
// ohne Rolle angelegte Zugang beim nächsten Neustart stiller Admin werden.
const rollenMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration_rollen_erledigt'").get();
if (!rollenMigration) {
  db.prepare('UPDATE users SET rolle_id = 1 WHERE rolle_id IS NULL').run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration_rollen_erledigt', ?)")
    .run(new Date().toISOString());
}

// ─── Einmalige Bereinigung: Dubletten in der Sortier-Inbox ───────────────────
//
// Bis v2.7.0.0 schrieb /api/internal/sort jede Mail ohne Regel-Treffer in die
// Sortier-Inbox — bei jedem Lauf erneut. Wer die Bestands-Triage mehrfach
// gestartet hat, fand dieselbe Mail dort bis zu einem Dutzend Mal. Seither
// schreibt nur noch /einsortieren hinein und aktualisiert vorhandene Zeilen.
//
// Der Altbestand wird nicht geloescht, sondern auf "ignoriert" gesetzt: Die
// juengste Zeile je Konto und UID bleibt offen, die aelteren verschwinden nur
// aus der Ansicht und lassen sich jederzeit wieder ansehen.
const inboxMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration_sortinbox_dubletten'").get();
if (!inboxMigration) {
  const info = db.prepare(`
    UPDATE sort_inbox SET status = 'ignoriert'
    WHERE status = 'offen' AND uid IS NOT NULL AND konto_id IS NOT NULL AND id NOT IN (
      SELECT MAX(id) FROM sort_inbox
      WHERE status = 'offen' AND uid IS NOT NULL AND konto_id IS NOT NULL
      GROUP BY konto_id, uid
    )
  `).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration_sortinbox_dubletten', ?)")
    .run(new Date().toISOString());
  if (info.changes > 0) {
    console.log(`[db] Sortier-Inbox: ${info.changes} doppelte Zeile(n) auf "ignoriert" gesetzt.`);
  }
}

// ─── Einmalige Migration: Ordner in bestand_erledigt ─────────────────────────
const bestandMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration_bestand_erledigt_ordner'").get();
if (!bestandMigration) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bestand_erledigt_neu (
        konto_id INTEGER NOT NULL,
        ordner TEXT NOT NULL,
        uid INTEGER NOT NULL,
        grund TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (konto_id, ordner, uid)
      );
      INSERT OR IGNORE INTO bestand_erledigt_neu (konto_id, ordner, uid, grund, created_at)
      SELECT konto_id, 'INBOX', uid, grund, created_at FROM bestand_erledigt;
      DROP TABLE bestand_erledigt;
      ALTER TABLE bestand_erledigt_neu RENAME TO bestand_erledigt;
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration_bestand_erledigt_ordner', ?)")
      .run(new Date().toISOString());
    console.log(`[db] Tabelle bestand_erledigt erfolgreich auf neues Schema (inkl. Ordner) migriert.`);
  } catch (err) {
    console.warn('[db] Fehler bei Migration von bestand_erledigt:', err.message);
  }
}


// ─── Migration: dashboard_layouts bekommt die Spalte "seite" ─────────────────
//
// Build 218 kannte nur eine Anordnung je Benutzer — die des Dashboards. Mit der
// Statistik gibt es eine zweite, und der Schluessel muss beide auseinanderhalten
// koennen. SQLite kann einen Primaerschluessel nicht erweitern, also wird die
// Tabelle neu gebaut. Der vorhandene Bestand gehoert dem Dashboard.
try {
  const spalten = db.prepare('PRAGMA table_info(dashboard_layouts)').all();
  if (spalten.length > 0 && !spalten.some((s) => s.name === 'seite')) {
    db.exec(`
      CREATE TABLE dashboard_layouts_neu (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seite      TEXT    NOT NULL DEFAULT 'dashboard',
        layout     TEXT    NOT NULL DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, seite)
      );
      INSERT INTO dashboard_layouts_neu (user_id, seite, layout, updated_at)
        SELECT user_id, 'dashboard', layout, updated_at FROM dashboard_layouts;
      DROP TABLE dashboard_layouts;
      ALTER TABLE dashboard_layouts_neu RENAME TO dashboard_layouts;
    `);
    console.log('[db] Tabelle dashboard_layouts um die Spalte "seite" erweitert.');
  }
} catch (err) {
  console.warn('[db] Fehler bei Migration von dashboard_layouts:', err.message);
}

// ─── Migration: sort_rules erlaubt den Typ "inhalt" ──────────────────────────
//
// Die Spalte inhalt_muster kommt oben per ALTER dazu, der neue Typ nicht: Eine
// CHECK-Bedingung laesst sich in SQLite nicht aendern, sie gehoert zur
// Tabellendefinition. Also wird die Tabelle einmal neu gebaut — mit denselben
// Zeilen und denselben ids, damit nichts ins Leere zeigt.
//
// Erkannt wird der Altbestand am gespeicherten CREATE-Text: Steht dort kein
// 'inhalt', ist die Tabelle alt.
try {
  const alt = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sort_rules'").get();
  if (alt && alt.sql && !alt.sql.includes("'inhalt'")) {
    const spalten = db.prepare('PRAGMA table_info(sort_rules)').all().map((s) => s.name);
    const hatAktion = spalten.includes('aktion');
    const hatBetreff = spalten.includes('betreff_muster');
    const hatInhalt = spalten.includes('inhalt_muster');
    db.exec(`
      CREATE TABLE sort_rules_neu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        konto_id INTEGER NOT NULL,
        typ TEXT NOT NULL CHECK(typ IN ('absender','betreff','domain','inhalt')),
        muster TEXT NOT NULL,
        zielordner TEXT NOT NULL,
        treffer INTEGER NOT NULL DEFAULT 0,
        erstellt_von INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        aktion TEXT NOT NULL DEFAULT 'verschieben',
        betreff_muster TEXT,
        inhalt_muster TEXT,
        FOREIGN KEY(konto_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      INSERT INTO sort_rules_neu
        (id, konto_id, typ, muster, zielordner, treffer, erstellt_von, created_at, aktion, betreff_muster, inhalt_muster)
        SELECT id, konto_id, typ, muster, zielordner, treffer, erstellt_von, created_at,
               ${hatAktion ? "IFNULL(aktion, 'verschieben')" : "'verschieben'"},
               ${hatBetreff ? 'betreff_muster' : 'NULL'},
               ${hatInhalt ? 'inhalt_muster' : 'NULL'}
        FROM sort_rules;
      DROP TABLE sort_rules;
      ALTER TABLE sort_rules_neu RENAME TO sort_rules;
    `);
    console.log('[db] Tabelle sort_rules neu gebaut — der Regeltyp "inhalt" ist jetzt erlaubt.');
  }
} catch (err) {
  console.warn('[db] Fehler bei Migration von sort_rules:', err.message);
}
// ─── Default-Einstellungen beim ersten Start ─────────────────────────────────
const defaults = {
  dnsbl_listen: JSON.stringify(['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org']),
  spam_schwellwert: '0.8',
  clamav_aktiv: '1',
  safebrowsing_aktiv: '0',
  // Automatische Themen-Sortierung: ab Werk aus, neue Ordner nur nach Freigabe
  themen_sortierung_aktiv: '0',
  themen_ordner_anlegen: 'freigabe',
  themen_ordner_max: '25',
  themen_konfidenz: '0.7',
  themen_eltern: '',
  themen_regel_lernen: '1',
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) insertDefault.run(key, value);

module.exports = db;
