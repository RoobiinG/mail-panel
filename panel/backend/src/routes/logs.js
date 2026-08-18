// Panel-Log-Routen: Fehler aus Backend, Frontend und Container-Status abfragen.
const express = require('express');
const db = require('../db');
const { loggen } = require('../services/panelLog');

const router = express.Router();

const MAX_MSG = 2000;
const MAX_STK = 5000;

// Hilfsfunktion: altes und neues Schema harmonisieren (für die GET-Antwort)
function harmonisieren(log) {
  return {
    ...log,
    source:  log.source  ?? log.quelle        ?? null,
    message: log.message ?? log.nachricht      ?? null,
    url:     log.url     ?? log.request_url    ?? null,
  };
}

// GET /api/logs — Logs abfragen (paginiert, filterbar)
router.get('/', (req, res) => {
  try {
    const { level, source, suche, limit = '100', offset = '0' } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (level) {
      where += ' AND level = ?';
      params.push(level);
    }
    if (source) {
      // Suche sowohl in neuer (source) als auch in alter (quelle) Spalte
      where += ' AND (source = ? OR quelle LIKE ?)';
      params.push(source, `%${source}%`);
    }
    if (suche) {
      where += ' AND (nachricht LIKE ? OR message LIKE ? OR stack LIKE ?)';
      params.push(`%${suche}%`, `%${suche}%`, `%${suche}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM panel_logs ${where}`).get(...params).n;

    const logs = db.prepare(`
      SELECT * FROM panel_logs ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);

    res.json({ total, logs: logs.map(harmonisieren) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/sources — Distinct-Quellen für den dynamischen Filter
router.get('/sources', (req, res) => {
  try {
    // Neue + alte Quellen-Spalte zusammenführen
    const rows = db.prepare(`
      SELECT DISTINCT COALESCE(source, quelle) AS src
      FROM panel_logs
      WHERE COALESCE(source, quelle) IS NOT NULL
      ORDER BY src
    `).all();
    res.json(rows.map(r => r.src));
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

// DELETE /api/logs/bulk — Ausgewählte Logs löschen
router.delete('/bulk', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids fehlt' });
    }
    const safeIds = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'Keine gültigen IDs' });
    const placeholders = safeIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM panel_logs WHERE id IN (${placeholders})`).run(...safeIds);
    res.json({ ok: true, geloescht: safeIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/client — Frontend-Fehler entgegennehmen (OHNE Auth!).
// Unterstützt altes Schema (nachricht/quelle) und neues Schema (message/source).
// Wird separat in index.js eingebunden, nicht über diesen Router.
function clientError(req, res) {
  const body = req.body || {};

  // Neues Schema (Überwachungs-Panel-kompatibel)
  const source   = body.source   || body.quelle    || 'frontend';
  const message  = body.message  || body.nachricht  || '';
  const stack    = body.stack    || null;
  const url      = body.url      || null;

  if (!message) return res.status(400).json({ error: 'message ist Pflicht' });

  // Duplikats-Unterdrückung: gleiche Meldung innerhalb von 10 Sekunden ignorieren
  const recent = db.prepare(
    "SELECT id FROM panel_logs WHERE (source = ? OR quelle = ?) AND (message = ? OR nachricht = ?) AND created_at >= datetime('now', '-10 seconds') LIMIT 1"
  ).get(source, source, String(message).slice(0, MAX_MSG), String(message).slice(0, MAX_MSG));
  if (recent) return res.json({ ok: true, skipped: true });

  db.prepare(
    'INSERT INTO panel_logs (level, source, message, stack, url) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'error',
    String(source).slice(0, 100),
    String(message).slice(0, MAX_MSG),
    stack ? String(stack).slice(0, MAX_STK) : null,
    url   ? String(url).slice(0, 500)       : null,
  );

  res.json({ ok: true });
}

module.exports = { router, clientError };
