// Automatische Themen-Sortierung: Die KI schlaegt einen Ordner vor, dieses Modul
// entscheidet endgueltig.
//
// Grundsatz: Der Vorschlag kommt von einem Modell, das angreiferkontrollierten
// Mailtext liest. Er ist deshalb ein Wunsch und keine Anweisung — jeder neue Name
// laeuft durch ordnerNormalisieren(), bevor er ein IMAP-Postfach zu sehen bekommt.
// Es wird nie geloescht und nie umbenannt, nur angelegt und verschoben.
const db = require('../db');
const imap = require('./imap');
const { entschluesseln } = require('./crypto');
const { loggen } = require('./panelLog');

// ─── Einstellungen ───────────────────────────────────────────────────────────

const wert = (key, standard) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : standard;
};

const ANLEGEN_MODI = ['aus', 'freigabe', 'auto'];

function einstellungen() {
  const modus = wert('themen_ordner_anlegen', 'freigabe');
  return {
    aktiv: wert('themen_sortierung_aktiv', '0') === '1',
    anlegen: ANLEGEN_MODI.includes(modus) ? modus : 'freigabe',
    max: Math.max(0, Number(wert('themen_ordner_max', '25')) || 0),
    konfidenz: Math.min(1, Math.max(0, Number(wert('themen_konfidenz', '0.7')) || 0)),
    eltern: String(wert('themen_eltern', '') || '').trim(),
    regelLernen: wert('themen_regel_lernen', '1') === '1',
    trockenlauf: wert('trockenlauf_aktiv', '0') === '1',
  };
}

// ─── Ordnernamen pruefen ─────────────────────────────────────────────────────

// Ordner, in die nie automatisch einsortiert werden darf. Die Kategorieordner
// des Kontos kommen in reserviert() dazu.
const SYSTEMORDNER = [
  'inbox', 'posteingang', 'sent', 'gesendet', 'gesendete objekte', 'sent items',
  'drafts', 'entwuerfe', 'entwürfe', 'trash', 'papierkorb', 'geloeschte objekte',
  'gelöschte objekte', 'deleted items', 'junk', 'junk-e-mail', 'spam', 'outbox',
  'postausgang', 'templates', 'vorlagen', 'notes', 'notizen',
];

function reserviert(konto = {}) {
  const namen = new Set(SYSTEMORDNER);
  for (const [feld, standard] of Object.entries(imap.STANDARD)) {
    namen.add(String(standard).toLowerCase().trim());
    if (konto[feld]) namen.add(String(konto[feld]).toLowerCase().trim());
  }
  return namen;
}

/**
 * Prueft einen von der KI vorgeschlagenen NEUEN Ordnernamen.
 * Bereits im Katalog stehende Ordner laufen hier nicht durch — deren Pfad kommt
 * unveraendert aus der Datenbank und darf deshalb auch Trennzeichen enthalten.
 * @returns {string|null} sauberer Name oder null, wenn er nicht zulaessig ist
 */
function ordnerNormalisieren(roh, konto = {}) {
  let name = String(roh ?? '').trim();
  if (!name) return null;

  // "NEU:Games" ist die vereinbarte Form fuer einen Vorschlag
  name = name.replace(/^NEU\s*:\s*/i, '').trim();
  // Anfuehrungszeichen, die das Modell gern mitliefert
  name = name.replace(/^["'`]+|["'`]+$/g, '').trim();
  name = name.replace(/\s+/g, ' ');

  if (name.length < 2 || name.length > 40) return null;
  // Ein fuehrendes = macht in n8n einen Ausdruck aus dem Wert, {{ }} und ${ }
  // ebenso — dieselbe Angriffsklasse, die ordnerName() im Patcher abfaengt.
  if (name.startsWith('=') || name.includes('{{') || name.includes('${')) return null;
  // Pfadtrenner wuerden einen Unterordner an fremder Stelle erzeugen
  if (/[/\\.]/.test(name)) return null;
  // Nur Buchstaben (inkl. Umlaute), Ziffern, Leerzeichen, Bindestrich, Unterstrich
  if (!/^[\p{L}\p{N} _-]+$/u.test(name)) return null;
  if (reserviert(konto).has(name.toLowerCase())) return null;

  return name;
}

// ─── Katalog ─────────────────────────────────────────────────────────────────

function katalog(kontoId, { auchGesperrte = false } = {}) {
  const sql = auchGesperrte
    ? 'SELECT * FROM konto_ordner WHERE konto_id = ? ORDER BY treffer DESC, ordner'
    : 'SELECT * FROM konto_ordner WHERE konto_id = ? AND gesperrt = 0 ORDER BY treffer DESC, ordner';
  return db.prepare(sql).all(kontoId);
}

// Was der Prompt sehen soll: Name und Beschreibung, auf eine handliche Zahl
// gekappt — sonst blaeht ein grosses Postfach jeden Gemini-Aufruf auf.
const MAX_IM_PROMPT = 40;

function fuerPrompt(kontoId) {
  return katalog(kontoId).slice(0, MAX_IM_PROMPT).map((o) => ({
    name: o.ordner,
    beschreibung: o.beschreibung || '',
  }));
}

// Findet einen Katalogeintrag zum Vorschlag der KI. Sie antwortet mal mit dem
// vollen Pfad ("Themen/Games"), mal nur mit dem letzten Stueck ("Games").
function imKatalog(kontoId, vorschlag) {
  const gesucht = String(vorschlag || '').replace(/^NEU\s*:\s*/i, '').trim().toLowerCase();
  if (!gesucht) return null;
  for (const eintrag of katalog(kontoId)) {
    const pfad = String(eintrag.ordner).toLowerCase();
    const letztes = pfad.split(/[/.]/).pop();
    if (pfad === gesucht || letztes === gesucht) return eintrag;
  }
  return null;
}

// ─── Ordner aus dem Postfach uebernehmen ─────────────────────────────────────

// Ein Konto samt entschluesseltem Passwort, wie imap.js es erwartet
function zugang(konto) {
  return {
    host: konto.host,
    port: konto.port,
    username: konto.username,
    passwort: entschluesseln(konto.password_enc),
    tlsUnsicher: Boolean(konto.tls_unsicher),
  };
}

/**
 * Liest die vorhandenen Ordner des Postfachs ein und nimmt alles in den Katalog
 * auf, was kein System- und kein Kategorieordner ist. So sortiert die KI in die
 * Struktur ein, die der Nutzer laengst hat, statt eine zweite danebenzubauen.
 */
async function ausPostfachEinlesen(konto) {
  const ergebnis = await imap.testVerbindung({ ...konto, ...zugang(konto) });
  const gesperrteNamen = reserviert(konto);
  const vorhanden = new Set(katalog(konto.id, { auchGesperrte: true }).map((o) => o.ordner));

  const einfuegen = db.prepare(
    "INSERT OR IGNORE INTO konto_ordner (konto_id, ordner, quelle) VALUES (?, ?, 'imap')",
  );
  const neu = [];
  for (const pfad of ergebnis.ordner || []) {
    if (vorhanden.has(pfad)) continue;
    const letztes = String(pfad).split(/[/.]/).pop();
    if (gesperrteNamen.has(String(pfad).toLowerCase())) continue;
    if (gesperrteNamen.has(letztes.toLowerCase())) continue;
    einfuegen.run(konto.id, pfad);
    neu.push(pfad);
  }
  return { ok: true, neu, gesamt: katalog(konto.id, { auchGesperrte: true }).length };
}

// ─── Regeln lernen ───────────────────────────────────────────────────────────

// Ab dem wievielten gleichen Treffer eines Absenders eine feste Regel entsteht.
// Danach laeuft dieser Absender ohne KI durch — das schont das Gemini-Kontingent
// und macht die Sortierung mit der Zeit vorhersagbar.
const LERNSCHWELLE = 3;

function absenderAdresse(von) {
  const roh = String(von || '').toLowerCase().trim();
  const treffer = roh.match(/<([^>]+)>/);
  return (treffer ? treffer[1] : roh).trim();
}

function regelLernen(kontoId, von, ordner) {
  const adresse = absenderAdresse(von);
  if (!adresse || !adresse.includes('@')) return false;

  const vorhanden = db.prepare(
    'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?',
  ).get(kontoId, 'absender', adresse);
  if (vorhanden) return false;

  const konto = db.prepare('SELECT name FROM accounts WHERE id = ?').get(kontoId);
  if (!konto) return false;

  // Gezaehlt wird im Triage-Log — eine eigene Tabelle braucht es dafuer nicht.
  const zeile = db.prepare(`
    SELECT COUNT(*) AS anzahl FROM quarantine_log
    WHERE konto = ? AND zielordner = ? AND lower(von) LIKE ?
      AND created_at >= datetime('now', '-90 day')
  `).get(konto.name, ordner, `%${adresse}%`);
  if (!zeile || zeile.anzahl < LERNSCHWELLE) return false;

  db.prepare(
    "INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'absender', ?, ?)",
  ).run(kontoId, adresse, ordner);
  loggen('info', 'themen', `Regel gelernt: ${adresse} → ${ordner} (Konto ${konto.name})`);
  return true;
}

// ─── Bausteine, die auch die Panel-Routen brauchen ───────────────────────────

// Legt den Ordner unter dem eingestellten Sammelordner an und gibt den Pfad
// zurueck, den der Server tatsaechlich vergeben hat. Das Trennzeichen zwischen
// Eltern- und Unterordner kennt nur der Server — deshalb wird der Pfad als Array
// uebergeben und imapflow setzt es selbst ein.
async function ordnerAnlegen(konto, name) {
  const e = einstellungen();
  const pfad = e.eltern ? [e.eltern, name] : name;
  return imap.ordnerAnlegenPfad(zugang(konto), pfad);
}

function inKatalog(kontoId, pfad, quelle, beschreibung = null) {
  db.prepare(`
    INSERT INTO konto_ordner (konto_id, ordner, beschreibung, quelle)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(konto_id, ordner) DO UPDATE SET
      beschreibung = COALESCE(excluded.beschreibung, beschreibung)
  `).run(kontoId, pfad, beschreibung, quelle);
  return db.prepare('SELECT * FROM konto_ordner WHERE konto_id = ? AND ordner = ?')
    .get(kontoId, pfad);
}

function vorschlagMerken(kontoId, name, begruendung) {
  db.prepare(`
    INSERT INTO ordner_vorschlaege (konto_id, ordner, begruendung)
    VALUES (?, ?, ?)
    ON CONFLICT(konto_id, ordner) DO UPDATE SET
      anzahl = anzahl + 1,
      begruendung = excluded.begruendung,
      status = CASE WHEN status = 'abgelehnt' THEN 'abgelehnt' ELSE 'offen' END
  `).run(kontoId, name, begruendung);
}

// ─── Die eigentliche Entscheidung ────────────────────────────────────────────

/**
 * @param {object} konto      Zeile aus accounts (mit password_enc)
 * @param {string} vorschlag  was die KI geliefert hat ("Games" oder "NEU:Games")
 * @param {number} konfidenz  0..1
 * @returns {Promise<{ordner: string|null, neu_angelegt: boolean, grund: string}>}
 */
async function aufloesen({ konto, vorschlag, konfidenz, von }) {
  const e = einstellungen();
  if (!e.aktiv) return { ordner: null, neu_angelegt: false, grund: 'Themen-Sortierung ist aus' };
  if (!vorschlag) return { ordner: null, neu_angelegt: false, grund: 'Kein Thema erkannt' };

  const sicherheit = Number(konfidenz) || 0;
  if (sicherheit < e.konfidenz) {
    return {
      ordner: null,
      neu_angelegt: false,
      grund: `Zu unsicher (${sicherheit.toFixed(2)} < ${e.konfidenz})`,
    };
  }

  // 1. Kennen wir den Ordner schon? Dann ist nichts weiter zu tun.
  const bekannt = imKatalog(konto.id, vorschlag);
  if (bekannt) {
    db.prepare(
      'UPDATE konto_ordner SET treffer = treffer + 1, zuletzt_genutzt = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(bekannt.id);
    // regelLernen laeuft erst nach dem Protokollieren in /einsortieren — sonst
    // wuerde die laufende Mail sich bei der Zaehlung selbst uebersehen.
    return { ordner: bekannt.ordner, neu_angelegt: false, grund: 'Vorhandener Themen-Ordner' };
  }

  // 2. Ein neuer Ordner — ab hier wird streng geprueft.
  if (e.anlegen === 'aus') {
    return { ordner: null, neu_angelegt: false, grund: 'Neue Ordner sind abgeschaltet' };
  }
  const name = ordnerNormalisieren(vorschlag, konto);
  if (!name) {
    return {
      ordner: null,
      neu_angelegt: false,
      grund: `Ordnername abgelehnt: ${String(vorschlag).slice(0, 40)}`,
    };
  }

  const deckel = db.prepare(
    "SELECT COUNT(*) AS anzahl FROM konto_ordner WHERE konto_id = ? AND quelle = 'ki'",
  ).get(konto.id);
  if (deckel.anzahl >= e.max) {
    return { ordner: null, neu_angelegt: false, grund: `Obergrenze von ${e.max} KI-Ordnern erreicht` };
  }

  // Im Trockenlauf wird nichts angelegt — nur festgehalten, was passiert waere.
  if (e.trockenlauf || e.anlegen === 'freigabe') {
    vorschlagMerken(konto.id, name, `Zuletzt vorgeschlagen für: ${String(von || '').slice(0, 120)}`);
    return {
      ordner: null,
      neu_angelegt: false,
      grund: e.trockenlauf
        ? `Trockenlauf — Ordner "${name}" wäre angelegt worden`
        : `Neuer Ordner "${name}" wartet auf Freigabe`,
    };
  }

  // 3. Vollautomatik: anlegen und einsortieren
  try {
    const pfad = await ordnerAnlegen(konto, name);
    inKatalog(konto.id, pfad, 'ki');
    loggen('info', 'themen', `Neuer Themen-Ordner "${pfad}" für Konto ${konto.name} angelegt (KI).`);
    return { ordner: pfad, neu_angelegt: true, grund: 'Neuer Themen-Ordner angelegt' };
  } catch (err) {
    loggen('warn', 'themen', `Ordner "${name}" konnte nicht angelegt werden: ${err.message}`);
    return { ordner: null, neu_angelegt: false, grund: `Anlegen fehlgeschlagen: ${err.message}` };
  }
}

module.exports = {
  einstellungen,
  ordnerNormalisieren,
  reserviert,
  katalog,
  fuerPrompt,
  imKatalog,
  ausPostfachEinlesen,
  regelLernen,
  aufloesen,
  ordnerAnlegen,
  inKatalog,
  vorschlagMerken,
  zugang,
  ANLEGEN_MODI,
};
