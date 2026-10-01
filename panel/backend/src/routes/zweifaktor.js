// Die eigene Zwei-Faktor-Anmeldung verwalten: einrichten, bestätigen, abschalten.
//
// Jeder angemeldete Benutzer darf das für sich selbst — es gibt dafür kein eigenes
// Recht, und niemand kann damit die 2FA eines anderen ändern (die Routen kennen nur
// req.user). Der Notausgang für Verlorenes ist das Zurücksetzen durch einen Admin
// (routes/benutzer.js).
//
// Wer eine Methode einrichten oder abschalten will, muss sein Passwort noch einmal
// eingeben: Eine gestohlene Sitzung (offener Laptop, abgegriffenes Token) darf sich
// sonst eine eigene Methode anlegen und damit dauerhaft festsetzen.
const express   = require('express');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const zweifaktor = require('../services/zweifaktor');
const { loggen } = require('../services/panelLog');
const { authLogSchreiben } = require('./auth');

const router = express.Router();

// Das Passwort noch einmal abzufragen ist selbst ein Ziel zum Durchprobieren —
// deshalb eine Bremse je Benutzer (nicht je Adresse).
const passwortLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `nutzer:${req.user?.id}`,
  message: { error: 'Zu viele Passwort-Eingaben — bitte 15 Minuten warten.' },
});

const bestaetigenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `nutzer:${req.user?.id}`,
  message: { error: 'Zu viele Versuche — bitte 15 Minuten warten.' },
});

const methodeAusPfad = (req, res, next) => {
  if (!zweifaktor.METHODEN.includes(req.params.methode)) {
    return res.status(404).json({ error: 'Unbekannte Methode.' });
  }
  next();
};

// Fragt das Passwort ab. Antwortet selbst und liefert false, wenn es nicht stimmt.
async function passwortBestaetigen(req, res) {
  const user = db.prepare('SELECT id, username, password FROM users WHERE id = ?').get(req.user.id);
  const passwort = req.body?.passwort;
  const passt = Boolean(user) && typeof passwort === 'string' && passwort.length > 0
    && await bcrypt.compare(passwort, user.password);
  if (!passt) {
    authLogSchreiben(req, req.user.id, req.user.username, false, 'passwort-bestaetigung');
    res.status(403).json({ error: 'Das Passwort stimmt nicht.' });
    return false;
  }
  return true;
}

// Fehler des Dienstes (mit status) an den Aufrufer weitergeben, alles andere als 502.
function fehlerAntwort(res, err, was) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  loggen('warn', 'auth', `2FA ${was}: ${err.message}`);
  return res.status(502).json({ error: err.message });
}

// Stand: welche Methoden sind eingerichtet? Nie ein Geheimnis darin.
router.get('/', (req, res) => {
  res.json(zweifaktor.uebersicht(req.user.id));
});

// ─── Authenticator-App ───────────────────────────────────────────────────────

// Erzeugt ein Geheimnis und liefert es EINMAL aus (für den QR-Code). Aktiv ist die
// Methode erst nach der Bestätigung mit einem echten Code aus der App.
router.post('/totp/start', passwortLimiter, async (req, res) => {
  if (!(await passwortBestaetigen(req, res))) return;
  try {
    const r = zweifaktor.totpStarten(req.user.id, req.user.username);
    res.json({ geheimnis: r.geheimnis, uri: r.uri });
  } catch (err) { fehlerAntwort(res, err, 'TOTP-Start'); }
});

// ─── E-Mail und Discord ──────────────────────────────────────────────────────

router.post('/email/start', passwortLimiter, async (req, res) => {
  if (!(await passwortBestaetigen(req, res))) return;
  try {
    const r = await zweifaktor.codeMethodeStarten({
      userId: req.user.id, methode: 'email', ziel: String(req.body?.adresse || '').trim(),
    });
    res.json({ ok: true, ablauf: r.ablauf });
  } catch (err) { fehlerAntwort(res, err, 'E-Mail-Einrichtung'); }
});

router.post('/discord/start', passwortLimiter, async (req, res) => {
  if (!(await passwortBestaetigen(req, res))) return;
  try {
    const r = await zweifaktor.codeMethodeStarten({
      userId: req.user.id,
      methode: 'discord',
      ziel: String(req.body?.user_id || '').trim(),
      eigenerBot: req.body?.bot_token,
    });
    res.json({ ok: true, ablauf: r.ablauf });
  } catch (err) { fehlerAntwort(res, err, 'Discord-Einrichtung'); }
});

// ─── Bestätigen (alle Methoden) ──────────────────────────────────────────────

router.post('/:methode/bestaetigen', methodeAusPfad, bestaetigenLimiter, (req, res) => {
  const ok = zweifaktor.einrichtungBestaetigen({
    userId: req.user.id, methode: req.params.methode, eingabe: req.body?.code,
  });
  if (!ok) return res.status(400).json({ error: 'Der Code stimmt nicht oder ist abgelaufen.' });
  loggen('info', 'auth', `2FA: ${req.user.username} hat ${req.params.methode} eingerichtet.`);
  res.json(zweifaktor.uebersicht(req.user.id));
});

// ─── Vorgewählte Methode ─────────────────────────────────────────────────────

router.put('/bevorzugt', (req, res) => {
  if (!zweifaktor.bevorzugtSetzen(req.user.id, String(req.body?.methode))) {
    return res.status(400).json({ error: 'Diese Methode ist nicht eingerichtet.' });
  }
  res.json(zweifaktor.uebersicht(req.user.id));
});

// ─── Abschalten (oder eine begonnene Einrichtung abbrechen) ──────────────────

router.post('/:methode/deaktivieren', methodeAusPfad, passwortLimiter, async (req, res) => {
  if (!(await passwortBestaetigen(req, res))) return;
  zweifaktor.deaktivieren(req.user.id, req.params.methode);
  loggen('info', 'auth', `2FA: ${req.user.username} hat ${req.params.methode} abgeschaltet.`);
  res.json(zweifaktor.uebersicht(req.user.id));
});

module.exports = router;
