const express   = require('express');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const tokens    = require('../services/tokens');
const zweifaktor = require('../services/zweifaktor');
const { loggen } = require('../services/panelLog');
const { loginStart, loginFinish } = require('./passkeys');

const router = express.Router();

// Brute-Force-Bremse: max. 10 Login-Versuche pro Viertelstunde und IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche — bitte 15 Minuten warten.' },
});

// Die Code-Eingabe ist die zweite Hälfte desselben Schlosses und bekommt dieselbe
// Strenge: Ein sechsstelliger Code hat nur eine Million Möglichkeiten, ohne Bremse
// wäre er in Minuten durchprobiert. Zusätzlich zählt jedes Ticket seine Fehlversuche
// (fünf), und jeder Benutzer insgesamt (zehn je Viertelstunde, egal von welcher
// Adresse) — siehe services/zweifaktor.js.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche — bitte 15 Minuten warten.', code: 'gebremst' },
});

// Codes anfordern kostet eine Mail oder Discord-Nachricht — hier steht die Bremse
// gegen Mail-Bomben.
const sendenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Codes angefordert — bitte 15 Minuten warten.', code: 'gebremst' },
});

const anzahlUser = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

// Fester Hash für den Vergleich, wenn der Benutzer gar nicht existiert: Sonst
// antwortet ein unbekannter Name spürbar schneller als ein bekannter mit falschem
// Passwort, und man könnte Zugangsnamen abfragen. (bcrypt kostet ~250 ms.)
const DUMMY_HASH = '$2a$12$Ay5GPSTfPl8cEzxixnXiauG9/CXHRldWg1OMiYMJ94ysEwKhrGAmm';

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
// Der Payload trägt Rolle und Rechte (die Oberfläche filtert damit ihre
// Navigation). `amr` sagt, womit man sich angemeldet hat. Die Middleware vertraut
// dem Payload nicht, sondern lädt die Rechte bei jedem Aufruf frisch.
function tokenErzeugen(user, amr = ['pwd']) {
  const rolle = db.prepare('SELECT name, rechte, fest FROM rollen WHERE id = ?').get(user.rolle_id);
  let rechte = {};
  try { rechte = JSON.parse(rolle?.rechte || '{}'); } catch { /* leer */ }

  return tokens.sitzungSignieren({
    id: user.id,
    username: user.username,
    rolle_id: user.rolle_id,
    rolle_name: rolle?.name || 'Keine Rolle',
    rechte,
    admin: rolle?.fest === 1,
    amr,
  });
}

// Erststart-Erkennung fuer das Frontend: solange kein Benutzer existiert,
// zeigt die App den Setup-Flow statt der Login-Maske.
router.get('/setup-status', (req, res) => {
  res.json({ setupNoetig: anzahlUser() === 0 });
});

// Einmaliges Anlegen des Admin-Kontos beim Erststart.
//
// Auch hier die Bremse: Zwar schliesst die Pruefung darunter den Weg, sobald
// ein Benutzer existiert — bis dahin steht der Endpunkt aber offen, und genau
// in diesem Fenster soll niemand im Sekundentakt Versuche abfeuern koennen.
router.post('/setup', loginLimiter, async (req, res) => {
  if (anzahlUser() > 0) return res.status(403).json({ error: 'Setup ist bereits abgeschlossen.' });
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Benutzername: mindestens 3 Zeichen.' });
  }
  if (!password || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Passwort: mindestens 10 Zeichen.' });
  }
  const hash = await bcrypt.hash(password, 12);
  // Erster Benutzer bekommt automatisch die Admin-Rolle (id=1)
  const info = db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, 1)').run(username.trim(), hash);
  const user = { id: info.lastInsertRowid, username: username.trim(), rolle_id: 1 };
  const token = tokenErzeugen(user);
  authLogSchreiben(req, user.id, user.username, true, 'passwort');
  res.json({ token, username: user.username });
});

// ─── Schritt 1: Passwort ─────────────────────────────────────────────────────
//
// Hat der Benutzer eine Zwei-Faktor-Methode eingerichtet, gibt es hier KEIN
// Sitzungs-Token — nur ein Ticket, das fünf Minuten gilt und ausschließlich für
// /api/auth/verify-2fa (und das Anfordern eines Codes) taugt. Ohne eingerichtete
// 2FA läuft die Anmeldung wie bisher in einem Schritt.
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort angeben.' });
  const name = String(username).trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);

  // bcrypt rechnet asynchron und hält die Event-Loop nicht an (compareSync blockierte
  // 250 ms je Versuch — für jeden anderen Aufruf des Panels). Auch bei unbekanntem
  // Benutzer wird gerechnet, damit die Antwortzeit nichts verrät.
  const passt = await bcrypt.compare(String(password), user?.password || DUMMY_HASH);

  // Immer derselbe Fehlertext — kein Hinweis, ob der Benutzer existiert
  if (!user || !passt) {
    authLogSchreiben(req, user?.id || null, name, false, 'passwort');
    return res.status(401).json({ error: 'Anmeldung fehlgeschlagen.' });
  }

  if (zweifaktor.hatZweifaktor(user.id)) {
    const ticket = zweifaktor.ticketAusstellen(user.id);
    // Noch keine Anmeldung — als Fehlschlag verbucht, damit das Protokoll und
    // „letzter Login" nicht so tun, als wäre jemand drin.
    authLogSchreiben(req, user.id, user.username, false, 'passwort (2FA ausstehend)');
    const methoden = zweifaktor.aktiveMethoden(user.id);
    const ziele = {};
    for (const m of methoden) {
      const z = db.prepare('SELECT ziel FROM user_2fa WHERE user_id = ? AND methode = ?').get(user.id, m);
      if (m !== 'totp') ziele[m] = zweifaktor.maskieren(m, z?.ziel);
    }
    return res.json({
      zweiFaktor: true,
      auth_ticket: ticket.token,
      ablauf: ticket.ablauf,
      // Die Dauer, nicht nur der Zeitpunkt: Der Browser zählt ab Empfang selbst
      // herunter. Gegen seine eigene Uhr zu rechnen ginge schief, sobald die
      // um mehr als ein paar Minuten falsch geht.
      gueltig_sekunden: tokens.TICKET_SEKUNDEN,
      methoden,
      bevorzugt: zweifaktor.bevorzugte(user.id),
      ziele,
    });
  }

  authLogSchreiben(req, user.id, user.username, true, 'passwort');
  res.json({ token: tokenErzeugen(user), username: user.username });
});

// ─── Schritt 2: Code ─────────────────────────────────────────────────────────

const TICKET_FEHLER = {
  error: 'Die Anmeldung ist abgelaufen — bitte melde dich neu an.',
  code: 'ticket_ungueltig',
};

// Einen Code per E-Mail oder Discord anfordern. TOTP braucht das nicht: Der Code
// steht in der App.
router.post('/2fa/senden', sendenLimiter, async (req, res) => {
  const { auth_ticket: ticket, methode } = req.body || {};
  const pruefung = zweifaktor.ticketPruefen(ticket);
  if (!pruefung.ok) return res.status(401).json(TICKET_FEHLER);
  if (zweifaktor.nutzerGesperrt(pruefung.ticket.user_id)) {
    return res.status(429).json({ error: 'Zu viele falsche Codes — bitte warte 15 Minuten.', code: 'gesperrt' });
  }

  try {
    const r = await zweifaktor.loginCodeSenden({ ticket: pruefung.ticket, methode: String(methode) });
    res.json({ ok: true, ablauf: r.ablauf });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    // Die Einzelheiten (Mailserver, Discord) gehören ins Protokoll, nicht zu jemandem,
    // der nur das Passwort kennt.
    loggen('warn', 'auth', `2FA-Code (${methode}) konnte nicht zugestellt werden: ${err.message}`);
    res.status(502).json({ error: 'Der Code konnte nicht zugestellt werden. Versuche eine andere Methode.' });
  }
});

// Erst nach einem richtigen Code gibt es die Sitzung.
router.post('/verify-2fa', verifyLimiter, (req, res) => {
  const { auth_ticket: ticketText, methode, code } = req.body || {};
  const pruefung = zweifaktor.ticketPruefen(ticketText);
  if (!pruefung.ok) return res.status(401).json(TICKET_FEHLER);
  const { ticket } = pruefung;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ticket.user_id);
  if (!user) return res.status(401).json(TICKET_FEHLER);

  if (!zweifaktor.METHODEN.includes(methode)) {
    return res.status(400).json({ error: 'Bitte eine Methode wählen.' });
  }
  // Vor dem Prüfen: Wer schon zu oft falsch geraten hat, kommt nicht mehr dazu —
  // auch nicht mit einem frischen Ticket oder von einer anderen Adresse.
  if (zweifaktor.nutzerGesperrt(user.id)) {
    return res.status(429).json({ error: 'Zu viele falsche Codes — bitte warte 15 Minuten.', code: 'gesperrt' });
  }

  const richtig = zweifaktor.loginCodePruefen({
    userId: user.id, ticketJti: ticket.jti, methode, eingabe: code,
  });

  if (!richtig) {
    const verbleibend = zweifaktor.fehlversuchZaehlen(ticket.jti);
    authLogSchreiben(req, user.id, user.username, false, `2fa-${methode}`);
    return res.status(401).json({
      error: verbleibend > 0
        ? 'Der Code stimmt nicht oder ist abgelaufen.'
        : 'Zu viele falsche Codes — bitte melde dich neu an.',
      code: verbleibend > 0 ? 'code_falsch' : 'ticket_ungueltig',
      verbleibend,
    });
  }

  // Das Ticket wird atomar eingelöst: Zwei gleichzeitige Anfragen mit demselben
  // Ticket können nicht beide eine Sitzung bekommen.
  if (!zweifaktor.ticketEinloesen(ticket.jti)) return res.status(401).json(TICKET_FEHLER);

  authLogSchreiben(req, user.id, user.username, true, `passwort+${methode}`);
  res.json({ token: tokenErzeugen(user, ['pwd', methode]), username: user.username });
});

router.get('/webauthn/generate-authentication-options', loginLimiter, loginStart);
router.post('/webauthn/verify-authentication', loginLimiter, loginFinish);

module.exports = router;
// Exportiert fuer die Passkey-Route, die ebenfalls Auth-Log schreiben soll
module.exports.authLogSchreiben = authLogSchreiben;
module.exports.tokenErzeugen = tokenErzeugen;
