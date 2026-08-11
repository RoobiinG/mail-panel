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

// ─── GeoIP (optional, fällt still zurück wenn nicht verfügbar) ───────────────
let geoLookup = null;
try {
  const geoip = require('geoip-lite');
  geoLookup = (ip) => {
    const geo = geoip.lookup(ip);
    if (!geo) return null;
    const teile = [geo.country];
    if (geo.city) teile.push(geo.city);
    return teile.join(', ');
  };
} catch {
  geoLookup = () => null;
}

// ─── Auth-Log schreiben ──────────────────────────────────────────────────────
const stmtAuthLog = db.prepare(`
  INSERT INTO auth_log (user_id, username, erfolg, ip, user_agent, herkunft, methode)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function authLogSchreiben(req, userId, username, erfolg, methode = 'passwort') {
  try {
    const ip = req.ip || req.connection?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const herkunft = ip ? geoLookup(ip) : null;
    stmtAuthLog.run(userId || null, username, erfolg ? 1 : 0, ip, userAgent, herkunft, methode);
  } catch (err) {
    console.error('Auth-Log Fehler:', err.message);
  }
}

// ─── JWT mit Rolle erzeugen ──────────────────────────────────────────────────
function tokenErzeugen(user) {
  // Rechte aus der Rolle laden
  const rolle = db.prepare('SELECT name, rechte FROM rollen WHERE id = ?').get(user.rolle_id);
  let rechte = {};
  try { rechte = JSON.parse(rolle?.rechte || '{}'); } catch { /* leer */ }

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      rolle_id: user.rolle_id,
      rolle_name: rolle?.name || 'Keine Rolle',
      rechte,
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' },
  );
}

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
  // Erster Benutzer bekommt automatisch die Admin-Rolle (id=1)
  const info = db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, 1)').run(username.trim(), hash);
  const user = { id: info.lastInsertRowid, username: username.trim(), rolle_id: 1 };
  const token = tokenErzeugen(user);
  authLogSchreiben(req, user.id, user.username, true, 'passwort');
  res.json({ token, username: user.username });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort angeben.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  // Immer derselbe Fehlertext — kein Hinweis, ob der Benutzer existiert
  if (!user || !bcrypt.compareSync(String(password), user.password)) {
    authLogSchreiben(req, user?.id || null, String(username).trim(), false, 'passwort');
    return res.status(401).json({ error: 'Anmeldung fehlgeschlagen.' });
  }
  authLogSchreiben(req, user.id, user.username, true, 'passwort');
  const token = tokenErzeugen(user);
  res.json({ token, username: user.username });
});

router.get('/webauthn/generate-authentication-options', loginLimiter, loginStart);
router.post('/webauthn/verify-authentication', loginLimiter, loginFinish);

module.exports = router;
// Exportiert fuer die Passkey-Route, die ebenfalls Auth-Log schreiben soll
module.exports.authLogSchreiben = authLogSchreiben;
module.exports.tokenErzeugen = tokenErzeugen;
