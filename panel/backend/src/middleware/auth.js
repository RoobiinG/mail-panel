const jwt = require('jsonwebtoken');
const db  = require('../db');

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Kein Token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    req.user = user;
    next();
  } catch {
    res.status(403).json({ error: 'Ungültiges Token' });
  }
};
