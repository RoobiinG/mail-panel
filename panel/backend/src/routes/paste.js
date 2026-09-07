const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');
const crypto = require('crypto');

// Öffentlicher Abruf (ohne Auth, wird vom Link-Empfänger genutzt)
// Die Route lautet in index.js: /api/paste
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT payload, created_at FROM pastes WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Log nicht gefunden oder bereits abgelaufen.' });
  }
  
  // Optional: Auto-Delete nach 7 Tagen
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) {
    db.prepare('DELETE FROM pastes WHERE id = ?').run(req.params.id);
    return res.status(404).json({ error: 'Log nicht gefunden oder bereits abgelaufen.' });
  }

  res.json({ ok: true, payload: row.payload, created_at: row.created_at });
});

// Erstellen (nur für angemeldete Nutzer)
router.post('/', auth, (req, res) => {
  const { payload } = req.body;
  if (!payload || typeof payload !== 'string') {
    return res.status(400).json({ error: 'Payload fehlt' });
  }
  
  // Zufällige ID (Hex, 16 Bytes = 32 Zeichen)
  const id = crypto.randomBytes(16).toString('hex');
  
  db.prepare('INSERT INTO pastes (id, payload) VALUES (?, ?)').run(id, payload);
  res.json({ ok: true, id });
});

module.exports = router;
