const express = require('express');
const db      = require('../db');
const n8n     = require('../services/n8n');
const mailcow = require('../services/mailcow');
const clamav  = require('../services/clamav');
const dnsbl   = require('../services/dnsbl');

const router = express.Router();

// Nur diese Schluessel sind ueber die API les-/schreibbar
const ERLAUBTE_KEYS = ['dnsbl_listen', 'spam_schwellwert', 'clamav_aktiv', 'safebrowsing_aktiv'];

router.get('/', (req, res) => {
  const zeilen = db.prepare(`SELECT key, value FROM settings WHERE key IN (${ERLAUBTE_KEYS.map(() => '?').join(',')})`).all(...ERLAUBTE_KEYS);
  const settings = Object.fromEntries(zeilen.map((z) => [z.key, z.value]));
  res.json(settings);
});

router.put('/', (req, res) => {
  const update = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP');
  const geaendert = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!ERLAUBTE_KEYS.includes(key)) continue;
    if (key === 'dnsbl_listen') {
      // Muss ein JSON-Array aus Hostnamen sein
      let listen;
      try { listen = JSON.parse(value); } catch { return res.status(400).json({ error: 'dnsbl_listen: kein gültiges JSON-Array' }); }
      if (!Array.isArray(listen) || listen.some((l) => typeof l !== 'string' || !/^[a-z0-9.-]+$/i.test(l))) {
        return res.status(400).json({ error: 'dnsbl_listen: nur Hostnamen erlaubt' });
      }
    }
    if (key === 'spam_schwellwert' && (isNaN(Number(value)) || Number(value) < 0 || Number(value) > 1)) {
      return res.status(400).json({ error: 'spam_schwellwert: Zahl zwischen 0 und 1' });
    }
    update.run(key, String(value));
    geaendert.push(key);
  }
  res.json({ ok: true, geaendert });
});

// Verbindungstests fuer die Einstellungen-Seite
router.post('/test/:dienst', async (req, res) => {
  const { dienst } = req.params;
  try {
    let ergebnis;
    if (dienst === 'n8n') ergebnis = await n8n.testVerbindung();
    else if (dienst === 'mailcow') ergebnis = await mailcow.testVerbindung();
    else if (dienst === 'clamav') ergebnis = await clamav.ping();
    else if (dienst === 'unbound') ergebnis = await dnsbl.testVerbindung();
    else return res.status(400).json({ error: `Unbekannter Dienst: ${dienst}` });
    res.json(ergebnis);
  } catch (err) {
    // Fehlermeldung durchreichen, aber keine Stacktraces/Interna
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
