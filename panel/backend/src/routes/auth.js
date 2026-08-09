const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const { loginStart, loginFinish } = require('./passkeys');

const router = express.Router();

// Brute-Force-Bremse: max. 10 Login-Versuche pro Viertelstunde und IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche — bitte 15 Minuten warten.' },
});

const anzahlUser = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

// Erststart-Erkennung fuer das Frontend: solange kein Benutzer existiert,
// zeigt die App den Setup-Flow statt der Login-Maske.
router.get('/setup-status', (req, res) => {
  res.json({ setupNoetig: anzahlUser() === 0 });
});

// Einmaliges Anlegen des Admin-Kontos beim Erststart
router.post('/setup', (req, res) => {
  if (anzahlUser() > 0) return res.status(403).json({ error: 'Setup ist bereits abgeschlossen.' });
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Benutzername: mindestens 3 Zeichen.' });
  }
  if (!password || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Passwort: mindestens 10 Zeichen.' });
  }
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username.trim(), hash);
  const token = jwt.sign({ id: info.lastInsertRowid, username: username.trim() }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username: username.trim() });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort angeben.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  // Immer derselbe Fehlertext — kein Hinweis, ob der Benutzer existiert
  if (!user || !bcrypt.compareSync(String(password), user.password)) {
    return res.status(401).json({ error: 'Anmeldung fehlgeschlagen.' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username: user.username });
});

router.get('/webauthn/generate-authentication-options', loginLimiter, loginStart);
router.post('/webauthn/verify-authentication', loginLimiter, loginFinish);

module.exports = router;
