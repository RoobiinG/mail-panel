const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');
const crypto = require('crypto');

// Wie lange ein geteilter Bericht abrufbar bleibt.
const HALTBAR_MS = 7 * 24 * 60 * 60 * 1000;

// SQLite schreibt CURRENT_TIMESTAMP als „2026-09-23 13:27:10" — das ist UTC,
// steht aber ohne Zeitzone da. new Date() las es als Ortszeit, und mit
// TZ=Europe/Berlin lief ein Bericht ein bis zwei Stunden zu früh ab.
function alterMs(createdAt) {
  const roh = String(createdAt || '');
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(roh) ? `${roh.replace(' ', 'T')}Z` : roh;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

// Abgelaufene Berichte wegräumen. Bisher verschwand ein Bericht nur, wenn ihn
// nach Ablauf noch jemand öffnete — nie geöffnete blieben für immer liegen.
function abgelaufeneLoeschen() {
  try {
    db.prepare("DELETE FROM pastes WHERE created_at < datetime('now', '-7 days')").run();
  } catch { /* Aufräumen darf nichts aufhalten */ }
}

// Öffentlicher Abruf (ohne Auth, wird vom Link-Empfänger genutzt)
// Die Route lautet in index.js: /api/paste
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT payload, created_at FROM pastes WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Log nicht gefunden oder bereits abgelaufen.' });
  }

  if (alterMs(row.created_at) > HALTBAR_MS) {
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

  abgelaufeneLoeschen();

  // Zufällige ID (Hex, 16 Bytes = 32 Zeichen)
  const id = crypto.randomBytes(16).toString('hex');

  db.prepare('INSERT INTO pastes (id, payload) VALUES (?, ?)').run(id, payload);
  res.json({ ok: true, id });
});

module.exports = router;
module.exports.alterMs = alterMs;
