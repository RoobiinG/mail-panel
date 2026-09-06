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
  // Wie viele KI-Einordnungen pro Tag hoechstens? 0/leer = kein Deckel.
  // Schuetzt das Gemini-Tageslimit, wenn ein grosser Altbestand sortiert wird.
  gemini_tagesbudget:   { env: 'GEMINI_TAGESBUDGET', geheim: false, standard: '400' },
  // Wie viele Belege pro Tag hoechstens per KI auslesen? 0/leer = kein Deckel.
  // Eigener Topf, damit das Beleg-Lesen (services/belegLeser.js) nicht das
  // Einordnungs-Budget leersaugt. Ist er voll, wird nur noch per Heuristik abgelegt.
  beleg_lese_tagesbudget: { env: 'BELEG_LESE_TAGESBUDGET', geheim: false, standard: '200' },
  telegram_token:       { env: 'TELEGRAM_TOKEN', geheim: true },
  // Pause zwischen zwei KI-Anfragen in Millisekunden. Der Gratis-Tarif von
  // Google begrenzt nicht nur den Tag, sondern auch die Minute: Ohne Pause
  // schiebt die Bestands-Triage hundert Mails auf einmal los und bekommt
  // "The service is receiving too many requests from you". 6000 ms sind 10
  // Anfragen je Minute, und daran zaehlen Workflow 01 und 04 gemeinsam.
  // Wirkt erst nach Workflows -> Synchronisieren, weil der Wert in die
  // n8n-Knoten geschrieben wird.
  gemini_pause_ms:      { geheim: false, standard: '6000' },
  // Welches Modell Workflows und Panel benutzen. Googles Kontingente gelten je
  // Modell — ist das eine fuer heute leer, hat das andere noch sein eigenes.
  // Gewechselt wird nur, wenn hier ein Ersatzmodell steht: Das ist meist das
  // groessere, und mit aktivierter Abrechnung kostet es mehr. Solche
  // Entscheidungen trifft das Panel nicht im Hintergrund.
  gemini_modell:        { env: 'GEMINI_MODELL', geheim: false, standard: 'gemini-3.5-flash-lite' },
  gemini_modell_ersatz: { env: 'GEMINI_MODELL_ERSATZ', geheim: false, standard: '' },
  // Wie viele Mails in eine Anfrage passen. Googles Tageslimit zaehlt Anfragen,
  // nicht Mails — das ist der Unterschied zwischen 500 und 10.000 Mails am Tag.
  // Verdachtsfaelle belegen drei Plaetze und bekommen die lange Textform:
  // Kategorie und Thema haengen an Absender und Betreff, Spam an Text und Links.
  // Siehe services/klassifizierer.js.
  gemini_buendel:       { env: 'GEMINI_BUENDEL', geheim: false, standard: '20' },
  gemini_text_kurz:     { env: 'GEMINI_TEXT_KURZ', geheim: false, standard: '600' },
  gemini_text_lang:     { env: 'GEMINI_TEXT_LANG', geheim: false, standard: '1500' },
  // Bleibt neu eingegangene Post im Postfach ungelesen? Standard ja — sonst
  // sieht der Nutzer neue Mails in seinem Mailclient bereits als gelesen, weil
  // das Panel schneller war. Steckt im Workflow, wirkt also erst nach
  // "Workflows -> Synchronisieren". Siehe services/workflowPatcher.js.
  neue_mails_ungelesen: { env: 'NEUE_MAILS_UNGELESEN', geheim: false, standard: '1' },
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
  // Aufsicht: prueft, ob die Workflows tatsaechlich laufen (services/aufsicht.js)
  aufsicht_aktiv:         { env: 'AUFSICHT_AKTIV', geheim: false },
  aufsicht_reparieren:    { env: 'AUFSICHT_REPARIEREN', geheim: false },
  aufsicht_takt:          { env: 'AUFSICHT_TAKT', geheim: false, standard: '15' },
  aufsicht_soll:          { geheim: false },
  aufsicht_letzter_lauf:  { geheim: false },
  // Bestands-Triage (Workflow 04) im Hintergrund: alle N Stunden selbst nachsehen,
  // ob noch unsortierte Bestands-Mails da sind. 0 = aus (nur manueller Start).
  // Ungefaehrlich fuer die KI: der Budget-Deckel im Sammel-Knoten begrenzt die
  // Klassifizierungen pro Tag, schon Sortiertes kostet nichts.
  bestand_intervall:      { env: 'BESTAND_INTERVALL', geheim: false, standard: '0' },
  // Wann lief die Bestands-Triage (Workflow 04) zuletzt und wie viel kam durch?
  // Gesetzt beim Aufruf von /api/internal/budget — den ruft nur der Sammel-Knoten
  // von WF04, jeder Aufruf ist also ein Bestandslauf. Reine Anzeige fuers Dashboard.
  bestand_letzter_lauf:        { geheim: false },
  bestand_letzter_lauf_anzahl: { geheim: false },
  bestand_letzter_lauf_gesamt: { geheim: false },
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
