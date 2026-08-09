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
`);

// ─── Migrationen: neue Spalten kommen als try/catch-ALTER dazu ───────────────
const migrations = [
  // Eigene Mailserver laufen oft mit selbstsigniertem Zertifikat
  'ALTER TABLE accounts ADD COLUMN tls_unsicher INTEGER NOT NULL DEFAULT 0',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* Spalte existiert schon */ }
}

// ─── Default-Einstellungen beim ersten Start ─────────────────────────────────
const defaults = {
  dnsbl_listen: JSON.stringify(['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org']),
  spam_schwellwert: '0.8',
  clamav_aktiv: '1',
  safebrowsing_aktiv: '0',
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) insertDefault.run(key, value);

module.exports = db;
