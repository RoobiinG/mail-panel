// Zentrale Einstellungsverwaltung. Zugangsdaten zu n8n, Mailcow und Safe Browsing
// pflegt der Nutzer im Panel (verschlüsselt in SQLite) — Umgebungsvariablen sind
// nur noch optionaler Vorrang für alle, die lieber alles per Env setzen.
const db = require('../db');
const { verschluesseln, entschluesseln } = require('./crypto');

// key -> { env: Name der Umgebungsvariablen, geheim: verschlüsselt speichern }
const FELDER = {
  n8n_url:              { env: 'N8N_URL', geheim: false, standard: 'http://n8n:5678' },
  n8n_api_key:          { env: 'N8N_API_KEY', geheim: true },
  mailcow_url:          { env: 'MAILCOW_URL', geheim: false },
  mailcow_api_key:      { env: 'MAILCOW_API_KEY', geheim: true },
  safebrowsing_api_key: { env: 'SAFEBROWSING_API_KEY', geheim: true },
  // KI und Benachrichtigung: Das Panel legt daraus die Credentials in n8n an
  // (siehe workflowPatcher.kiUndBenachrichtigungenSynchronisieren).
  gemini_api_key:       { env: 'GEMINI_API_KEY', geheim: true },
  telegram_token:       { env: 'TELEGRAM_TOKEN', geheim: true },
  telegram_chat_id:     { env: 'TELEGRAM_CHAT_ID', geheim: false },
  // Postausgang für Workflow 06 (Newsletter abbestellen per Mail)
  smtp_host:            { env: 'SMTP_HOST', geheim: false },
  smtp_port:            { env: 'SMTP_PORT', geheim: false, standard: '587' },
  smtp_user:            { env: 'SMTP_USER', geheim: false },
  smtp_passwort:        { env: 'SMTP_PASSWORT', geheim: true },
  smtp_absender:        { env: 'SMTP_ABSENDER', geheim: false },
  smtp_tls_unsicher:    { env: 'SMTP_TLS_UNSICHER', geheim: false },
  // Ziele für eigene Aktionen
  nextcloud_url:        { env: 'NEXTCLOUD_URL', geheim: false },
  nextcloud_user:       { env: 'NEXTCLOUD_USER', geheim: false },
  nextcloud_passwort:   { env: 'NEXTCLOUD_PASSWORT', geheim: true },
  nextcloud_kalender:   { env: 'NEXTCLOUD_KALENDER', geheim: false },
  google_client_id:     { env: 'GOOGLE_CLIENT_ID', geheim: false },
  google_client_secret: { env: 'GOOGLE_CLIENT_SECRET', geheim: true },
  google_refresh_token: { geheim: true },
  google_kalender_id:   { geheim: false, standard: 'primary' },
  // Postfach-Sicherung: verschlüsseltes Archiv aller Mails auf einen FTP-Server.
  // Das Archiv-Passwort ist der Schlüssel zu allem, was dort liegt — geht es
  // verloren, ist keine Sicherung mehr zu öffnen. Es steht deshalb verschlüsselt
  // in der Datenbank und wird nie an die Oberfläche zurückgegeben.
  sicherung_aktiv:        { env: 'SICHERUNG_AKTIV', geheim: false },
  sicherung_passwort:     { env: 'SICHERUNG_PASSWORT', geheim: true },
  sicherung_ftp_host:     { env: 'SICHERUNG_FTP_HOST', geheim: false },
  sicherung_ftp_port:     { env: 'SICHERUNG_FTP_PORT', geheim: false, standard: '21' },
  sicherung_ftp_user:     { env: 'SICHERUNG_FTP_USER', geheim: false },
  sicherung_ftp_passwort: { env: 'SICHERUNG_FTP_PASSWORT', geheim: true },
  sicherung_ftp_pfad:     { env: 'SICHERUNG_FTP_PFAD', geheim: false, standard: '/' },
  sicherung_ftp_tls:      { env: 'SICHERUNG_FTP_TLS', geheim: false, standard: '1' },
  sicherung_ftp_tls_unsicher: { geheim: false },
  sicherung_behalten:     { geheim: false, standard: '8' },
  sicherung_intervall:    { geheim: false, standard: '168' },
  sicherung_dubletten:    { geheim: false, standard: '1' },
  sicherung_letzter_lauf: { geheim: false },
};

function hole(key) {
  const feld = FELDER[key];
  if (feld?.env && process.env[feld.env]) return process.env[feld.env];
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!zeile) return feld?.standard || '';
  return feld?.geheim ? entschluesseln(zeile.value) : zeile.value;
}

function setze(key, wert) {
  const feld = FELDER[key];
  const gespeichert = feld?.geheim ? verschluesseln(wert) : String(wert);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, gespeichert);
}

// Für die UI: Geheimnisse werden nie zurückgegeben, nur ob sie gesetzt sind
function fuerUi() {
  const ergebnis = {};
  for (const [key, feld] of Object.entries(FELDER)) {
    const wert = hole(key);
    if (feld.geheim) {
      ergebnis[key] = wert ? '••••••••' : '';
      ergebnis[`${key}_gesetzt`] = Boolean(wert);
    } else {
      ergebnis[key] = wert;
    }
    ergebnis[`${key}_per_env`] = Boolean(feld.env && process.env[feld.env]);
  }
  return ergebnis;
}

module.exports = { hole, setze, fuerUi, FELDER };
