const express = require('express');
const db      = require('../db');
const mailcow = require('../services/mailcow');

const router = express.Router();

// ─── 1. n8n Log (Ergebnisse aus der KI-Klassifizierung) ───────────────────

router.get('/log', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM quarantine_log ORDER BY created_at DESC LIMIT 100').all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. Mailcow Quarantäne (über die Mailcow-API) ─────────────────────────

router.get('/mailcow', async (req, res) => {
  try {
    const { data } = await mailcow.client().get('/get/quarantine/all');
    // Mailcow antwortet oft mit einem Array von Objekten oder einem Fehler
    if (data && data.type === 'error') {
      return res.status(400).json({ error: data.msg });
    }
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    // Wenn Mailcow nicht eingerichtet ist
    if (err.message.includes('nicht eingerichtet')) {
      return res.json({ disabled: true });
    }
    res.status(500).json({ error: 'Mailcow API-Fehler: ' + err.message });
  }
});

// Quarantäne löschen (Mailcow)
router.post('/mailcow/delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Keine IDs übergeben.' });
  }
  try {
    const { data } = await mailcow.client().post('/delete/qitem', ids);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Löschen: ' + err.message });
  }
});

// Quarantäne zustellen (Mailcow)
router.post('/mailcow/deliver', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Keine IDs übergeben.' });
  }
  try {
    // Laut Mailcow-Doku: action: "deliver" oder "release", und items: ["id1"]
    const { data } = await mailcow.client().post('/edit/qitem', {
      action: 'deliver',
      items: ids
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Fehler bei der Zustellung: ' + err.message });
  }
});

module.exports = router;
