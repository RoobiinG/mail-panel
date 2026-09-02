// Jede Testdatei bekommt ihre eigene, leere Datenbank in einem Wegwerf-Ordner.
//
// Ohne das würden die Tests die Entwicklungs- oder gar die Produktivdatenbank
// anfassen — und Tests, die Daten verändern, sind keine Tests, sondern ein
// Risiko. Das hier muss VOR jedem require aus src/ laufen, weil db.js den Pfad
// beim Laden auswertet.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'mailpanel-test-'));
process.env.DATA_DIR = ordner;
// secrets.js legt seinen Schlüssel im selben Ordner ab; ohne festen Wert
// erzeugt jeder Lauf einen neuen, was für Tests genügt.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

process.on('exit', () => {
  try { fs.rmSync(ordner, { recursive: true, force: true }); } catch { /* egal */ }
});

module.exports = { ordner };
