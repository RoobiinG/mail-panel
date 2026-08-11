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
`);

// ─── Migrationen: neue Spalten kommen als try/catch-ALTER dazu ───────────────
const migrations = [
  // Eigene Mailserver laufen oft mit selbstsigniertem Zertifikat
  'ALTER TABLE accounts ADD COLUMN tls_unsicher INTEGER NOT NULL DEFAULT 0',
  // Mehrbenutzer: Rollenzuweisung
  'ALTER TABLE users ADD COLUMN rolle_id INTEGER DEFAULT NULL',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* Spalte existiert schon */ }
}

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

// Bestehende Benutzer ohne Rolle bekommen automatisch Admin
db.prepare(`UPDATE users SET rolle_id = 1 WHERE rolle_id IS NULL`).run();

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
