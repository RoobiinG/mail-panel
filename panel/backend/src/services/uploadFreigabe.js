// Anhänge, die vor dem Hochladen auf eine Freigabe warten.
//
// Warum es diese Datei gibt: Bis Build 191 ging jeder erkannte Beleg sofort in
// die Nextcloud, in einen Pfad, den ein kleines Modell aus Firma, Datum und
// Aktenzeichen zusammensetzt. Was dort einmal liegt, holt niemand zurück — und
// dasselbe Modell schreibt nachweislich Prompt-Fragmente als Ordnernamen ab.
// Mit eingeschalteter Freigabe wartet die Datei stattdessen hier, bis jemand
// sie angesehen und Pfad und Namen bestätigt hat.
//
// Die Bauart folgt ordner_vorschlaege: n8n kann nicht auf einen Menschen
// warten, also liefert Workflow 07 ab und läuft weiter — hochgeladen wird
// später vom Panel (services/nextcloud.js).
//
// Die Datei wird dabei zwischengespeichert, nicht bloß vermerkt. Der sparsamere
// Weg („nur konto+uid merken und bei der Freigabe neu aus dem Postfach ziehen")
// scheidet aus: Workflow 07 läuft als Parallelzweig zum Einsortieren, ein
// IMAP-MOVE vergibt im Zielordner eine neue UID, und zwischen Einlieferung und
// Freigabe liegen Stunden bis Tage. Die Mail ist dann nicht mehr dort, wo sie
// war — im Panel steht das schon an der Anhang-Route (routes/internal.js).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const settings = require('./settings');
const nextcloud = require('./nextcloud');
const { pfadSaeubern } = require('./aktionenPatcher');
const { loggen } = require('./panelLog');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const ABLAGE = path.join(DATA_DIR, 'upload-warteschlange');

// Grenzen beim Einliefern. Sie sind wichtiger als das Aufräumen weiter unten:
// Workflow 07 liefert unbeaufsichtigt ein, und ein volles Volume legt auch
// SQLite still. Lieber eine Datei abweisen als das Panel anhalten.
const MAX_OFFEN = 500;
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB im Zwischenlager

// Erledigte Zeilen bleiben als Protokoll stehen — aber nicht ewig.
const PROTOKOLL_TAGE = 90;

function ablageOrdner() {
  if (!fs.existsSync(ABLAGE)) fs.mkdirSync(ABLAGE, { recursive: true });
  return ABLAGE;
}

// Der Weg zur zwischengelagerten Datei.
//
// In der Datenbank steht nur der Name. Trotzdem wird hier noch einmal auf den
// Basisnamen reduziert und geprüft, dass das Ergebnis im Zwischenlager liegt:
// Diese Funktion ist die einzige Stelle, die aus einem gespeicherten Wert einen
// Dateipfad macht, und sie soll auch dann nichts hergeben, wenn in der Spalte
// etwas Unerwartetes steht.
function ablagePfad(name) {
  const sauber = path.basename(String(name || ''));
  if (!sauber || sauber === '.' || sauber === '..') return null;
  const voll = path.join(ablageOrdner(), sauber);
  if (path.dirname(voll) !== ablageOrdner()) return null;
  return voll;
}

/** Dateinamen entschärfen — dieselbe Regel wie im Beleg-Knoten in n8n. */
function sauberDatei(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'beleg';
}

function belegtByte() {
  try {
    let summe = 0;
    for (const name of fs.readdirSync(ablageOrdner())) {
      try { summe += fs.statSync(path.join(ablageOrdner(), name)).size; } catch { /* gerade weg */ }
    }
    return summe;
  } catch { return 0; }
}

const offeneAnzahl = () =>
  db.prepare("SELECT COUNT(*) n FROM upload_freigaben WHERE status = 'offen'").get().n;

// ─── Einliefern ──────────────────────────────────────────────────────────────

/**
 * Nimmt eine Datei aus Workflow 07 entgegen und legt sie in die Warteschlange.
 * Wirft nie — der n8n-Lauf soll wegen eines vollen Volumes nicht rot werden.
 * @returns {{ok: boolean, id?: number, grund?: string}}
 */
async function einliefern(eingang = {}) {
  const base64 = String(eingang.base64 || '');
  if (!base64) return { ok: false, grund: 'keine_datei' };

  const dateiname = sauberDatei(path.basename(String(eingang.dateiname || 'beleg.pdf')));
  const zielpfad = pfadSaeubern(String(eingang.zielpfad || ''));
  if (!zielpfad) return { ok: false, grund: 'kein_zielpfad' };

  const konto = eingang.konto == null ? null : String(eingang.konto);
  const uid = eingang.uid == null ? null : String(eingang.uid);

  // Schon in der Warteschlange? Der partielle UNIQUE-Index fängt das ohnehin ab,
  // aber dann läge die Datei bereits im Zwischenlager und müsste zurückgenommen
  // werden. Vorher fragen ist billiger.
  const schonDa = db.prepare(
    "SELECT id FROM upload_freigaben WHERE status = 'offen'"
    + ' AND IFNULL(konto, \'\') = IFNULL(?, \'\') AND IFNULL(uid, \'\') = IFNULL(?, \'\') AND dateiname = ?',
  ).get(konto, uid, dateiname);
  if (schonDa) return { ok: false, grund: 'schon_in_warteschlange', id: schonDa.id };

  if (offeneAnzahl() >= MAX_OFFEN) return { ok: false, grund: 'warteschlange_voll' };

  const inhalt = Buffer.from(base64, 'base64');
  if (inhalt.length === 0) return { ok: false, grund: 'keine_datei' };
  if (belegtByte() + inhalt.length > MAX_BYTES) return { ok: false, grund: 'zwischenlager_voll' };

  const endung = (dateiname.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  const ablageName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${endung}`;
  const ziel = ablagePfad(ablageName);
  if (!ziel) return { ok: false, grund: 'ablage_nicht_nutzbar' };

  await fsp.writeFile(ziel, inhalt);
  try {
    const info = db.prepare(`
      INSERT INTO upload_freigaben
        (aktion_id, aktion_name, konto, von, betreff, uid, ordner,
         dateiname, zielpfad, groesse, ablage, firma, aktenzeichen, datum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eingang.aktion_id ?? null,
      eingang.aktion_name ? String(eingang.aktion_name) : null,
      konto,
      eingang.von ? String(eingang.von) : null,
      eingang.betreff ? String(eingang.betreff) : null,
      uid,
      eingang.ordner ? String(eingang.ordner) : null,
      dateiname,
      zielpfad,
      inhalt.length,
      ablageName,
      eingang.firma ? String(eingang.firma) : null,
      eingang.aktenzeichen ? String(eingang.aktenzeichen) : null,
      eingang.datum ? String(eingang.datum) : null,
    );
    return { ok: true, id: info.lastInsertRowid };
  } catch (err) {
    // Ohne Datensatz ist die Datei nicht mehr auffindbar — also zurücknehmen,
    // statt sie als Waise liegen zu lassen.
    try { await fsp.unlink(ziel); } catch { /* dann holt sie der Aufräumer */ }
    loggen('warn', 'uploads', `Einlieferung fehlgeschlagen: ${err.message}`);
    return { ok: false, grund: 'nicht_gespeichert' };
  }
}

// ─── Lesen ───────────────────────────────────────────────────────────────────

function liste() {
  return db.prepare(`
    SELECT id, aktion_name, konto, von, betreff, dateiname, zielpfad, groesse,
           firma, aktenzeichen, datum, fehler, created_at
    FROM upload_freigaben WHERE status = 'offen' ORDER BY created_at DESC, id DESC
  `).all();
}

const holen = (id) => db.prepare('SELECT * FROM upload_freigaben WHERE id = ?').get(Number(id));

/** Die zwischengelagerte Datei einer Zeile — oder null, wenn sie fehlt. */
function dateiVon(zeile) {
  if (!zeile) return null;
  const p = ablagePfad(zeile.ablage);
  if (!p || !fs.existsSync(p)) return null;
  return p;
}

// ─── Entscheiden ─────────────────────────────────────────────────────────────

// Zwei offene Browser-Tabs, zweimal derselbe Knopf: Ohne Sperre liefe der Upload
// doppelt. Ein eigener Status in der Datenbank wäre dafür zu viel — nach einem
// Neustart soll davon nichts übrig sein.
const inArbeit = new Set();

/**
 * Gibt eine wartende Datei frei und lädt sie hoch.
 * Pfad und Dateiname dürfen abweichen — das ist der Sinn der Warteschlange.
 */
async function freigeben(id, { zielpfad, dateiname } = {}) {
  const nr = Number(id);
  if (inArbeit.has(nr)) return { ok: false, fehler: 'Wird gerade hochgeladen.' };

  const zeile = holen(nr);
  if (!zeile) return { ok: false, fehler: 'Eintrag nicht gefunden.' };
  if (zeile.status !== 'offen') return { ok: false, fehler: `Schon erledigt (${zeile.status}).` };

  const datei = dateiVon(zeile);
  if (!datei) {
    // Zeile da, Datei weg (Volume neu aufgesetzt, von Hand aufgeräumt). Endlos
    // daran zu scheitern hilft niemandem.
    db.prepare(
      "UPDATE upload_freigaben SET status='verworfen', fehler=?, erledigt_am=CURRENT_TIMESTAMP WHERE id=?",
    ).run('Datei im Zwischenlager nicht mehr vorhanden', nr);
    return { ok: false, fehler: 'Die Datei ist nicht mehr im Zwischenlager.' };
  }

  // Auch der von Hand eingetippte Pfad läuft durch dieselbe Säuberung wie der
  // Vorschlag — ein ".." im Eingabefeld ist kein Sonderfall.
  const pfad = pfadSaeubern(String(zielpfad || '').trim()) || zeile.zielpfad;
  const name = sauberDatei(String(dateiname || '').trim() || zeile.dateiname);

  inArbeit.add(nr);
  try {
    const inhalt = await fsp.readFile(datei);
    const ergebnis = await nextcloud.ablegen({ zielpfad: pfad, dateiname: name, inhalt });

    db.prepare(`
      UPDATE upload_freigaben
      SET status='hochgeladen', zielpfad_final=?, dateiname_final=?, fehler=NULL,
          erledigt_am=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(pfad, ergebnis.dateiname || name, nr);

    try { await fsp.unlink(datei); } catch { /* der Aufräumer holt sie */ }
    loggen('info', 'uploads', `Hochgeladen: ${pfad}/${ergebnis.dateiname || name}`);
    return { ok: true, pfad, dateiname: ergebnis.dateiname || name };
  } catch (err) {
    // Der Status bleibt 'offen' — sonst wäre ein zweiter Versuch unmöglich,
    // und genau den braucht man, wenn die Nextcloud kurz nicht erreichbar war.
    db.prepare('UPDATE upload_freigaben SET fehler=? WHERE id=?').run(String(err.message).slice(0, 300), nr);
    loggen('warn', 'uploads', `Upload von "${name}" fehlgeschlagen: ${err.message}`);
    return { ok: false, fehler: err.message };
  } finally {
    inArbeit.delete(nr);
  }
}

async function verwerfen(id, grund = 'Vom Nutzer verworfen') {
  const zeile = holen(id);
  if (!zeile) return { ok: false, fehler: 'Eintrag nicht gefunden.' };
  if (zeile.status !== 'offen') return { ok: false, fehler: `Schon erledigt (${zeile.status}).` };

  const datei = dateiVon(zeile);
  if (datei) { try { await fsp.unlink(datei); } catch { /* nicht kritisch */ } }
  db.prepare(
    "UPDATE upload_freigaben SET status='verworfen', fehler=?, erledigt_am=CURRENT_TIMESTAMP WHERE id=?",
  ).run(grund, Number(id));
  return { ok: true };
}

// ─── Aufräumen ───────────────────────────────────────────────────────────────

function fristTage() {
  const n = Number(settings.hole('upload_freigabe_frist_tage'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 30;
}

/**
 * Überfällige Einträge verwerfen, alte Protokollzeilen löschen und Dateien
 * einsammeln, zu denen es keinen Datensatz mehr gibt.
 */
async function aufraeumen() {
  let verworfen = 0;
  let verwaist = 0;
  try {
    const faellig = db.prepare(
      "SELECT * FROM upload_freigaben WHERE status = 'offen'"
      + " AND created_at < datetime('now', ?)",
    ).all(`-${fristTage()} day`);
    for (const zeile of faellig) {
      await verwerfen(zeile.id, `Frist von ${fristTage()} Tagen abgelaufen`);
      verworfen += 1;
    }

    db.prepare(
      "DELETE FROM upload_freigaben WHERE status != 'offen' AND erledigt_am < datetime('now', ?)",
    ).run(`-${PROTOKOLL_TAGE} day`);

    // Dateien ohne Datensatz. Die entstehen, wenn das Panel zwischen Schreiben
    // und INSERT abstürzt — selten, aber sonst bleibt es für immer liegen.
    const bekannt = new Set(
      db.prepare("SELECT ablage FROM upload_freigaben WHERE status = 'offen'").all().map((z) => z.ablage),
    );
    for (const name of fs.readdirSync(ablageOrdner())) {
      if (bekannt.has(name)) continue;
      try { await fsp.unlink(path.join(ablageOrdner(), name)); verwaist += 1; } catch { /* egal */ }
    }
  } catch (err) {
    loggen('warn', 'uploads', `Aufräumen fehlgeschlagen: ${err.message}`);
  }
  if (verworfen || verwaist) {
    loggen('info', 'uploads',
      `Warteschlange aufgeräumt: ${verworfen} überfällig verworfen, ${verwaist} verwaiste Datei(en) gelöscht.`);
  }
  return { verworfen, verwaist };
}

let uhr = null;
function zeitplanStarten(taktMs = 6 * 60 * 60 * 1000) {
  if (uhr) clearInterval(uhr);
  uhr = setInterval(() => {
    aufraeumen().catch(() => { /* loggt selbst */ });
  }, taktMs);
  if (uhr.unref) uhr.unref();
}

module.exports = {
  einliefern, liste, holen, dateiVon, freigeben, verwerfen, aufraeumen, zeitplanStarten,
  sauberDatei, ablageOrdner,
  MAX_OFFEN, MAX_BYTES,
};
