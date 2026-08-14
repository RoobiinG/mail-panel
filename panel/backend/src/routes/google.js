// Google-Anmeldung: Weiterleitung starten und Rücksprung entgegennehmen.
const express = require('express');
const crypto  = require('crypto');
const google  = require('../services/google');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// Kurzlebige Merkzettel gegen untergeschobene Rücksprünge (CSRF)
const laufende = new Map();
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, v] of laufende) if (v.gueltigBis < jetzt) laufende.delete(k);
}, 60_000);

// GET /api/google/status — für die Einstellungen-Seite
router.get('/status', (req, res) => {
  res.json({
    verbunden: google.istVerbunden(),
    rueckkehrAdresse: google.rueckkehrAdresse(req),
  });
});

// POST /api/google/start — liefert den Link zur Google-Anmeldung
router.post('/start', (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    laufende.set(state, { userId: req.user.id, gueltigBis: Date.now() + 10 * 60_000 });
    res.json({ link: google.anmeldeLink(req, state) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Alles, was in die Antwortseite kommt, stammt teils aus der Adresszeile.
// Ohne Maskierung wäre das eine Einfallstelle für eingeschleustes HTML.
function maskieren(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GET /api/google/rueckkehr — hier landet der Browser nach der Zustimmung.
// Ohne Anmeldung erreichbar (Google ruft es auf), abgesichert über state.
async function rueckkehr(req, res) {
  const { code, state, error } = req.query;
  const antwort = (titel, text) => res
    .status(error || !code ? 400 : 200)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><title>${maskieren(titel)}</title>
      <body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:3rem;text-align:center">
      <h1 style="font-size:1.3rem">${maskieren(titel)}</h1><p style="color:#8b949e">${maskieren(text)}</p>
      <p><a href="/einstellungen" style="color:#388bfd">Zurück zum Panel</a></p></body>`);

  if (error) return antwort('Anmeldung abgebrochen', `Google meldet: ${String(error).slice(0, 200)}`);
  if (!code || !state || !laufende.has(state)) {
    return antwort('Anmeldung nicht zuzuordnen', 'Bitte die Anmeldung im Panel noch einmal starten.');
  }
  laufende.delete(state);

  try {
    await google.tokenTauschen(code, req);
    loggen('info', 'backend:google', 'Google-Konto verbunden');
    antwort('Google ist verbunden', 'Du kannst dieses Fenster schließen.');
  } catch (err) {
    loggen('warn', 'backend:google', `Anmeldung fehlgeschlagen: ${err.message}`);
    antwort('Anmeldung fehlgeschlagen', err.message);
  }
}

// DELETE /api/google — Verbindung lösen
router.delete('/', (req, res) => {
  require('../services/settings').setze('google_refresh_token', '');
  res.json({ ok: true });
});

module.exports = { router, rueckkehr };
