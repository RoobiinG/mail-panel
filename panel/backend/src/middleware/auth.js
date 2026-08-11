const jwt = require('jsonwebtoken');
const db  = require('../db');

// Hauptmiddleware: Token prüfen, Benutzer + Rolle + Rechte laden
function auth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Kein Token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`
      SELECT u.id, u.username, u.rolle_id, r.name AS rolle_name, r.rechte
      FROM users u
      LEFT JOIN rollen r ON r.id = u.rolle_id
      WHERE u.id = ?
    `).get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    // Rechte als Objekt bereitstellen
    let rechte = {};
    try { rechte = JSON.parse(user.rechte || '{}'); } catch { /* leer lassen */ }
    req.user = {
      id: user.id,
      username: user.username,
      rolle_id: user.rolle_id,
      rolle_name: user.rolle_name || 'Keine Rolle',
      rechte,
    };
    next();
  } catch {
    res.status(403).json({ error: 'Ungültiges Token' });
  }
}

// Middleware-Factory: prüft, ob der Benutzer ein bestimmtes Recht hat
function rechtErforderlich(bereich) {
  return (req, res, next) => {
    if (!req.user?.rechte?.[bereich]) {
      return res.status(403).json({ error: `Keine Berechtigung für: ${bereich}` });
    }
    next();
  };
}

module.exports = auth;
module.exports.rechtErforderlich = rechtErforderlich;
