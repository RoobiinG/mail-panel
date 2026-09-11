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
  ki_anbieter:          { env: 'KI_ANBIETER', geheim: false, standard: 'gemini' },
  ollama_url:           { env: 'OLLAMA_URL', geheim: false, standard: 'http://ollama:11434' },
  ollama_modell:        { env: 'OLLAMA_MODELL', geheim: false, standard: 'llama3.1' },
  // Kontextfenster in Token. Ohne Angabe nimmt Ollama seinen eigenen Standard
  // (je nach Fassung 2048 oder 4096) und schneidet laengere Prompts
  // stillschweigend ab — und zwar vorne, wo die Anweisung steht. Ein groesseres
  // Fenster kostet Arbeitsspeicher, ein zu kleines kostet die ganze Antwort.
  ollama_kontext:       { env: 'OLLAMA_KONTEXT', geheim: false, standard: '8192' },
  // Wie viele Mails hoechstens in ein Buendel? Deckelt gemini_buendel nach
  // unten, sobald die lokale KI arbeitet. Bei CPU-Inferenz ist das die
  // wirksamste Schraube ueberhaupt: Die Zeit zum Einlesen des Prompts waechst
  // mit seiner Laenge, und zwei Mails, die zurueckkommen, sind mehr wert als
  // fuenf, die ins Zeitlimit laufen — dort ist das Ergebnis null.
  ollama_buendel:       { env: 'OLLAMA_BUENDEL', geheim: false, standard: '2' },
  // Wie viele CPU-Kerne soll Ollama zur Inferenz nutzen?
  ollama_threads:       { env: 'OLLAMA_THREADS', geheim: false, standard: '6' },
  // Wie lange darf ein Klassifizier-Lauf insgesamt dauern?
  //
  // Bewusst OHNE Standardwert: hole() gaebe ihn sonst zurueck, und der
  // Rueckfall auf den alten Schluessel gemini_lauf_frist_ms kaeme nie zum Zug.
  // Leer heisst 240000 — das entscheidet klassifizierer.frist().
  //
  // Achtung, die Frist haengt an einer Kette: Ueber ~240 s braucht es auch ein
  // groesseres Zeitlimit im Buendel-Knoten (setzt workflowPatcher selbst) und
  // N8N_RUNNERS_TASK_TIMEOUT in der docker-compose.yml. Ohne das schneidet n8n
  // den Code-Knoten weiter bei 300 s ab.
  ki_lauf_frist_ms:     { env: 'KI_LAUF_FRIST_MS', geheim: false },
  gemini_api_key:       { env: 'GEMINI_API_KEY', geheim: true },
  // Wie viele KI-Einordnungen pro Tag hoechstens? 0/leer = kein Deckel.
  // Schuetzt das Gemini-Tageslimit, wenn ein grosser Altbestand sortiert wird.
  gemini_tagesbudget:   { env: 'GEMINI_TAGESBUDGET', geheim: false, standard: '400' },
  // Wie viele Belege pro Tag hoechstens per KI auslesen? 0/leer = kein Deckel.
  // Eigener Topf, damit das Beleg-Lesen (services/belegLeser.js) nicht das
  // Einordnungs-Budget leersaugt. Ist er voll, wird nur noch per Heuristik abgelegt.
  beleg_lese_tagesbudget: { env: 'BELEG_LESE_TAGESBUDGET', geheim: false, standard: '200' },
  // Eingescannte Belege per Texterkennung lesen (services/ocr.js)? Greift nur
  // bei lokaler KI und nur, wenn das PDF gar keine Textebene hat — Gemini liest
  // einen Scan selbst. Kostet auf einer CPU einige Sekunden je Beleg.
  beleg_ocr_aktiv:      { env: 'BELEG_OCR_AKTIV', geheim: false, standard: '1' },
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
  // Wie viel darf das Modell nachdenken? Gemini 3.7/3.8 Flash denken von Haus
  // aus und zahlen das aus demselben Budget, aus dem die Antwort kommt — bei
  // einer Einstufung ist das verschenkt. "aus" schickt das Feld gar nicht mit
  // (fuer Modelle, die es nicht kennen). Siehe services/kiText.js.
  gemini_denkstufe:     { env: 'GEMINI_DENKSTUFE', geheim: false, standard: 'low' },
  // Bleibt neu eingegangene Post im Postfach ungelesen? Standard ja — sonst
  // sieht der Nutzer neue Mails in seinem Mailclient bereits als gelesen, weil
  // das Panel schneller war. Steckt im Workflow, wirkt also erst nach
  // "Workflows -> Synchronisieren". Siehe services/workflowPatcher.js.
  // Bleibt neu eingegangene Post im Postfach ungelesen?
  //
  // Standard ist AUS — nach einem Rueckschlag im Betrieb. Der Gedanke war
  // richtig (n8n fuehrt einen Wasserstand ueber die zuletzt gesehene UID, also
  // schadet "nicht als gelesen markieren" nicht), aber er haelt nur, solange die
  // Laeufe durchkommen: n8n sichert die statischen Daten eines Workflows erst
  // beim erfolgreichen Ende. Scheiterten die Laeufe reihenweise -- wie am 7.9.
  // an den Gemini-Absagen --, wurde der Wasserstand nie geschrieben. Damit
  // fielen BEIDE Bremsen gleichzeitig weg: kein Gelesen-Merkmal und kein
  // Wasserstand. Der Ausloeser fand dieselben Mails wieder und wieder, und die
  // Laeufe stapelten sich zu Dutzenden.
  //
  // Wer die Mails ungelesen behalten will, kann das einschalten -- aber erst,
  // wenn die Laeufe zuverlaessig gruen durchgehen. Siehe workflowPatcher.js.
  neue_mails_ungelesen: { env: 'NEUE_MAILS_UNGELESEN', geheim: false, standard: '0' },
  // Workflows von selbst abgleichen: beim Containerstart und nach jeder
  // Aenderung, die in den Workflows landet. Bis dahin war das ein Knopf, den man
  // druecken musste — und wer ihn vergass, hatte eine Einstellung, die nur im
  // Panel stand. Auf '0' bleibt es beim Knopf. Siehe services/autoSync.js.
  auto_sync:            { env: 'AUTO_SYNC', geheim: false, standard: '1' },
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
  nextcloud_kalender:   { env: 'NEXTCLOUD_KALENDER', geheim: false, standard: 'personal' },
  nextcloud_beleg_pfad: { env: 'NEXTCLOUD_BELEG_PFAD', geheim: false, standard: 'Belege' },
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
  let wert;
  if (feld?.env && process.env[feld.env]) wert = process.env[feld.env];
  else {
    const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!zeile) wert = feld?.standard || '';
    else wert = feld?.geheim ? entschluesseln(zeile.value) : zeile.value;
  }

  // Fallback: Selbst wenn die URL unencodiert in der DB steht (z.B. vor dem Update),
  // wird sie hier fuer den Aufrufer (n8n, fetch) sicher encodiert.
  if (key.endsWith('_url') && typeof wert === 'string' && wert) {
    const match = wert.match(/^(https?:\/\/)([^:]+):(.+)@([^@/]+.*)$/);
    if (match) {
      try {
        const user = encodeURIComponent(decodeURIComponent(match[2]));
        const pass = encodeURIComponent(decodeURIComponent(match[3]));
        wert = match[1] + user + ':' + pass + '@' + match[4];
      } catch (e) {
        wert = match[1] + encodeURIComponent(match[2]) + ':' + encodeURIComponent(match[3]) + '@' + match[4];
      }
    }
  }

  return wert;
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
      let uiWert = wert;
      // Fuer die Anzeige in der UI wieder decodieren, damit der Nutzer nicht
      // %23 statt # sieht und beim naechsten Speichern doppelt encodiert wird.
      if (key.endsWith('_url') && uiWert) {
        const match = String(uiWert).match(/^(https?:\/\/)([^:]+):(.+)@([^@/]+.*)$/);
        if (match) {
          try {
            uiWert = match[1] + decodeURIComponent(match[2]) + ':' + decodeURIComponent(match[3]) + '@' + match[4];
          } catch (e) { /* Falls es manuell kaputt-encodiert wurde */ }
        }
      }
      ergebnis[key] = uiWert;
    }
    ergebnis[`${key}_per_env`] = Boolean(feld.env && process.env[feld.env]);
  }
  return ergebnis;
}

module.exports = { hole, setze, fuerUi, FELDER };
