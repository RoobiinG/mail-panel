// Endpunkte fuer die n8n-Workflows (Header X-Panel-Secret, siehe middleware/internalAuth).
// Etappe 1: config + log. Die Check-/Scan-Endpunkte kommen in Etappe 3/4.
const express = require('express');
const db      = require('../db');

const router = express.Router();

// Konfiguration fuer die Workflows (Schwellwerte, Listen)
router.get('/config', (req, res) => {
  const hole = (key, fallback) => {
    const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return zeile ? zeile.value : fallback;
  };
  res.json({
    spam_schwellwert: Number(hole('spam_schwellwert', '0.8')),
    dnsbl_listen: JSON.parse(hole('dnsbl_listen', '[]')),
    clamav_aktiv: hole('clamav_aktiv', '1') === '1',
    safebrowsing_aktiv: hole('safebrowsing_aktiv', '0') === '1',
  });
});

// Triage-Ergebnis aus Workflow 01/04 — fuellt Dashboard, Quarantaene-Tab und Newsletter-Seite
router.post('/log', (req, res) => {
  const b = req.body || {};
  if (!b.konto || !b.von) return res.status(400).json({ error: 'konto und von sind Pflicht' });
  db.prepare(`
    INSERT INTO quarantine_log (konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, list_unsubscribe, virus_name, dnsbl_treffer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(b.konto), String(b.von), b.betreff ?? null, b.kategorie ?? null,
    b.spam_score != null ? Number(b.spam_score) : null, b.zielordner ?? null,
    b.kurzfassung ?? null, b.list_unsubscribe ?? null, b.virus_name ?? null,
    b.dnsbl_treffer ? JSON.stringify(b.dnsbl_treffer) : null,
  );

  // Newsletter-Absender fuer die Abbestellen-Seite mitzaehlen
  if (b.kategorie === 'newsletter') {
    db.prepare(`
      INSERT INTO newsletter_senders (absender, anzahl, list_unsubscribe, zuletzt_gesehen)
      VALUES (?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(absender) DO UPDATE SET
        anzahl = anzahl + 1,
        list_unsubscribe = COALESCE(excluded.list_unsubscribe, list_unsubscribe),
        zuletzt_gesehen = CURRENT_TIMESTAMP
    `).run(String(b.von), b.list_unsubscribe ?? null);
  }
  res.json({ ok: true });
});

module.exports = router;
