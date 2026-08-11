// Rollen-Verwaltung: CRUD (nur mit Recht "benutzer" - Rollen gehoeren zur Benutzerverwaltung)
const express = require('express');
const db      = require('../db');
const { rechtErforderlich } = require('../middleware/auth');

const router = express.Router();

// GET /api/rollen — alle Rollen auflisten
router.get('/', (req, res) => {
  try {
    const rollen = db.prepare(`
      SELECT id, name, fest, rechte, created_at,
        (SELECT COUNT(*) FROM users WHERE rolle_id = rollen.id) AS nutzer_anzahl
      FROM rollen
      ORDER BY id
    `).all();
    // Rechte-String als Objekt parsen
    const response = rollen.map(r => {
      let rechteObj = {};
      try { rechteObj = JSON.parse(r.rechte || '{}'); } catch { /* leer */ }
      return { ...r, rechte: rechteObj };
    });
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rollen — neue Rolle anlegen
router.post('/', (req, res) => {
  const { name, rechte } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Name: mindestens 2 Zeichen.' });
  }
  let rechteStr = '{}';
  if (rechte && typeof rechte === 'object') {
    rechteStr = JSON.stringify(rechte);
  }
  try {
    const info = db.prepare('INSERT INTO rollen (name, rechte) VALUES (?, ?)').run(name.trim(), rechteStr);
    res.json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Der Rollenname existiert bereits.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rollen/:id — Rolle bearbeiten (Name & Rechte)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, rechte } = req.body || {};

  const rolle = db.prepare('SELECT id, fest FROM rollen WHERE id = ?').get(id);
  if (!rolle) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
  if (rolle.fest === 1) return res.status(403).json({ error: 'System-Rollen können nicht bearbeitet werden.' });

  let updateQuery = [];
  let params = [];

  if (name && typeof name === 'string' && name.trim().length >= 2) {
    updateQuery.push('name = ?');
    params.push(name.trim());
  }
  if (rechte && typeof rechte === 'object') {
    updateQuery.push('rechte = ?');
    params.push(JSON.stringify(rechte));
  }

  if (updateQuery.length === 0) return res.status(400).json({ error: 'Nichts zum Aktualisieren.' });

  try {
    params.push(id);
    db.prepare(`UPDATE rollen SET ${updateQuery.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Der Rollenname existiert bereits.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rollen/:id — Rolle loeschen
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);

  const rolle = db.prepare('SELECT id, fest FROM rollen WHERE id = ?').get(id);
  if (!rolle) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
  if (rolle.fest === 1) return res.status(403).json({ error: 'System-Rollen können nicht gelöscht werden.' });

  const nutzer = db.prepare('SELECT COUNT(*) AS n FROM users WHERE rolle_id = ?').get(id).n;
  if (nutzer > 0) return res.status(400).json({ error: `Die Rolle wird noch von ${nutzer} Benutzer(n) verwendet.` });

  try {
    db.prepare('DELETE FROM rollen WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
