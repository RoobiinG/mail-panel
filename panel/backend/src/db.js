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
  CREATE TABLE IF NOT EXISTS sort_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    konto_id INTEGER NOT NULL,
    typ TEXT NOT NULL CHECK(typ IN ('absender','betreff','domain')),
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
    uid INTEGER NOT NULL,
    grund TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (konto_id, uid)
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

  -- Umgeleitete Vorschlaege: "Das gehoert nicht in einen neuen Ordner, das
  -- gehoert nach X." Schlaegt die KI denselben Namen wieder vor, wird er direkt
  -- aufgeloest — es entsteht kein zweiter Ordner und keine neue Nachfrage.
  -- Der Nutzer sieht die Zuordnung unter den Themen-Ordnern und kann sie loesen.
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
  // Hat für diese Mail wirklich die KI gearbeitet? Eine Mail, die eine eigene
  // Sortier-Regel trifft, läuft im Workflow an Gemini vorbei — sie darf das
  // Tagesbudget nicht verbrauchen. Vorher zählte jede Zeile als KI-Aufruf.
  'ALTER TABLE quarantine_log ADD COLUMN ki INTEGER DEFAULT 1',
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
