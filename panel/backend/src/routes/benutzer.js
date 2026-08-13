// Benutzer-Verwaltung: CRUD + Auth-Log-Abfrage (nur mit Recht "benutzer")
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');

const router = express.Router();

// GET /api/benutzer — alle Benutzer mit Rollen auflisten
router.get('/', (req, res) => {
  try {
    const benutzer = db.prepare(`
      SELECT u.id, u.username, u.rolle_id, r.name AS rolle_name, u.created_at,
        (SELECT MAX(created_at) FROM auth_log WHERE user_id = u.id AND erfolg = 1) AS letzter_login
      FROM users u
      LEFT JOIN rollen r ON r.id = u.rolle_id
      ORDER BY u.id
    `).all();
    res.json(benutzer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/benutzer — neuen Benutzer anlegen
router.post('/', (req, res) => {
  const { username, password, rolle_id } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Benutzername: mindestens 3 Zeichen.' });
  }
  if (!password || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Passwort: mindestens 10 Zeichen.' });
  }
  // Rolle ist Pflicht: Ein Zugang ohne Rolle hätte keine Rechte und wäre nur
  // Verwirrung — ausserdem verhindert das Grenzfaelle bei der Rechtevergabe.
  if (!rolle_id) return res.status(400).json({ error: 'Bitte eine Rolle auswählen.' });
  const rolle = db.prepare('SELECT id FROM rollen WHERE id = ?').get(rolle_id);
  if (!rolle) return res.status(400).json({ error: 'Rolle existiert nicht.' });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const info = db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, ?)').run(
      username.trim(), hash, rolle_id,
    );
    res.json({ id: info.lastInsertRowid, username: username.trim(), rolle_id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Benutzername ist bereits vergeben.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/benutzer/:id — Benutzer bearbeiten (Rolle aendern, Passwort zuruecksetzen)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { rolle_id, password } = req.body || {};

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });

  // Rolle aendern
  if (rolle_id !== undefined) {
    if (rolle_id !== null) {
      const rolle = db.prepare('SELECT id FROM rollen WHERE id = ?').get(rolle_id);
      if (!rolle) return res.status(400).json({ error: 'Rolle existiert nicht.' });
    }
    // Den letzten Admin nicht herabstufen — sonst kommt niemand mehr an die
    // Benutzerverwaltung und nur noch ein Eingriff in der Datenbank hilft.
    const bisher = db.prepare('SELECT rolle_id FROM users WHERE id = ?').get(id);
    if (bisher.rolle_id === 1 && rolle_id !== 1) {
      const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE rolle_id = 1').get().n;
      if (admins <= 1) {
        return res.status(400).json({
          error: 'Das ist der letzte Administrator — lege zuerst einen zweiten an.',
        });
      }
    }
    db.prepare('UPDATE users SET rolle_id = ? WHERE id = ?').run(rolle_id, id);
  }

  // Passwort zuruecksetzen
  if (password) {
    if (typeof password !== 'string' || password.length < 10) {
      return res.status(400).json({ error: 'Passwort: mindestens 10 Zeichen.' });
    }
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
  }

  res.json({ ok: true });
});

// DELETE /api/benutzer/:id — Benutzer loeschen
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);

  // Sich selbst loeschen verbieten
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen.' });
  }

  // Letzten Admin schuetzen
  const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE rolle_id = 1').get().n;
  const user = db.prepare('SELECT rolle_id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
  if (user.rolle_id === 1 && admins <= 1) {
    return res.status(400).json({ error: 'Der letzte Admin kann nicht gelöscht werden.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  // Passkeys mitloeschen (CASCADE sollte greifen, aber sicherheitshalber)
  db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

// GET /api/benutzer/auth-log — Anmelde-Protokoll (paginiert, filterbar)
router.get('/auth-log', (req, res) => {
  try {
    const { user_id, nur_fehlgeschlagen, limit = '100', offset = '0' } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (user_id) {
      where += ' AND a.user_id = ?';
      params.push(Number(user_id));
    }
    if (nur_fehlgeschlagen === '1') {
      where += ' AND a.erfolg = 0';
    }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM auth_log a ${where}`).get(...params).n;

    const logs = db.prepare(`
      SELECT a.*, u.username AS aktueller_name
      FROM auth_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);

    res.json({ total, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
