// Schlüssel-Bootstrap: Damit die Installation ohne .env auskommt, erzeugt das
// Panel beim ersten Start seine Schlüssel selbst und legt sie im Datenvolume ab.
// Sind die Werte als Umgebungsvariablen gesetzt, haben diese immer Vorrang.
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DATEI    = path.join(DATA_DIR, 'secrets.json');
const SCHLUESSEL = ['JWT_SECRET', 'PANEL_SECRET', 'PANEL_DB_KEY'];

function laden() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let gespeichert = {};
  if (fs.existsSync(DATEI)) {
    try { gespeichert = JSON.parse(fs.readFileSync(DATEI, 'utf8')); } catch { gespeichert = {}; }
  }

  let veraendert = false;
  for (const name of SCHLUESSEL) {
    // Vorrang: Umgebungsvariable > gespeicherter Wert > neu erzeugen
    if (process.env[name] && process.env[name].length >= 32) continue;
    if (!gespeichert[name]) {
      gespeichert[name] = crypto.randomBytes(32).toString('hex');
      veraendert = true;
    }
    process.env[name] = gespeichert[name];
  }

  if (veraendert) {
    fs.writeFileSync(DATEI, JSON.stringify(gespeichert, null, 2), { mode: 0o600 });
    console.log('Panel-Schlüssel erzeugt und in secrets.json abgelegt.');
  }
}

module.exports = { laden };
