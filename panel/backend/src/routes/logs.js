// Panel-Log-Routen: Fehler aus Backend, Frontend und Container-Status abfragen.
const express = require('express');
const db = require('../db');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// GET /api/logs — Logs abfragen (paginiert, filterbar)
router.get('/', (req, res) => {
  try {
    const { level, quelle, suche, limit = '100', offset = '0' } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (level) {
      where += ' AND level = ?';
      params.push(level);
    }
    if (quelle) {
      where += ' AND quelle LIKE ?';
      params.push(`%${quelle}%`);
    }
    if (suche) {
      where += ' AND (nachricht LIKE ? OR stack LIKE ?)';
      params.push(`%${suche}%`, `%${suche}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM panel_logs ${where}`).get(...params).n;

    const logs = db.prepare(`
      SELECT * FROM panel_logs ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);

    res.json({ total, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs — Alle Logs leeren
router.delete('/', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM panel_logs').run();
    res.json({ geloescht: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/client — Frontend-Fehler entgegennehmen (OHNE Auth!)
// Wird separat in index.js eingebunden, nicht ueber diesen Router.
function clientError(req, res) {
  const { nachricht, stack, url, userAgent } = req.body || {};
  if (!nachricht) return res.status(400).json({ error: 'nachricht ist Pflicht' });

  loggen('error', 'frontend', String(nachricht).slice(0, 2000), {
    stack: stack || null,
    requestUrl: url || null,
  });
  res.json({ ok: true });
}

module.exports = { router, clientError };
