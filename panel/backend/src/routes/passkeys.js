const router  = require('express').Router();
const db      = require('../db');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const jwt = require('jsonwebtoken');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * RP ID = Hostname ohne Port, muss zur aktuellen Browser-Origin passen.
 * Reihenfolge:
 *  1. ALLOWED_ORIGIN env (explizit konfiguriert)
 *  2. Origin-Header des Requests (zuverlässigste Quelle beim Browser-Aufruf)
 *  3. Host-Header (Proxy-Szenarien)
 *  4. Fallback localhost
 */
// Kopfzeilen bestimmt der Aufrufer selbst. Sie als erwartete Herkunft zu nehmen,
// hebelt die Herkunftsbindung von WebAuthn aus — im Betrieb deshalb nur mit
// ALLOWED_ORIGIN. Ohne die Variable geht es nur in der Entwicklung weiter.
function kopfzeilenErlaubt() {
  return process.env.NODE_ENV !== 'production';
}

const getRpId = (req) => {
  if (process.env.ALLOWED_ORIGIN) {
    try { return new URL(process.env.ALLOWED_ORIGIN).hostname; } catch {}
  }
  if (!kopfzeilenErlaubt()) {
    throw new Error('Für Passkeys muss ALLOWED_ORIGIN gesetzt sein (Panel-Adresse, z.B. https://panel.example.org).');
  }
  if (req?.headers?.origin) {
    try { return new URL(req.headers.origin).hostname; } catch {}
  }
  if (req?.headers?.host) {
    return req.headers.host.split(':')[0];
  }
  return 'localhost';
};

/**
 * Erwartete Origin für WebAuthn-Verifizierung.
 * Muss exakt mit der Origin übereinstimmen, die der Browser beim Registrieren sah.
 */
const getOrigin = (req) => {
  if (process.env.ALLOWED_ORIGIN) return process.env.ALLOWED_ORIGIN;
  if (!kopfzeilenErlaubt()) {
    throw new Error('Für Passkeys muss ALLOWED_ORIGIN gesetzt sein (Panel-Adresse, z.B. https://panel.example.org).');
  }
  if (req?.headers?.origin) return req.headers.origin;
  const proto = req?.headers?.['x-forwarded-proto'] || (req?.secure ? 'https' : 'http');
  const host  = req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${process.env.PORT || 3001}`;
  return `${proto}://${host}`;
};

const getRpName = () => 'Mail-Panel';

// In-Memory Challenge-Store mit 5-Min-TTL
const challenges = new Map(); // key → { challenge, userId?, expiresAt }
// unref, aus demselben Grund wie in routes/google.js: Sonst haelt dieser Timer
// den Prozess offen, und ein Testlauf, der dieses Modul laedt, endet nie.
const aufraeumer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) { if (v.expiresAt < now) challenges.delete(k); }
}, 60_000);
if (aufraeumer.unref) aufraeumer.unref();

// ─── Passkey-Registrierung (erfordert auth) ───────────────────────────────────

router.get('/register/start', async (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  const existingPasskeys = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(user.id);

  const options = await generateRegistrationOptions({
    rpName:          getRpName(),
    rpID:            getRpId(req),
    userName:        user.username,
    userID:          new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map(p => ({
      id: p.credential_id,
      transports: ['internal', 'hybrid'],
    })),
    authenticatorSelection: {
      // Kein authenticatorAttachment → Browser/Enpass/Hardware-Keys alle erlaubt.
      // 'cross-platform' würde Enpass in Brave (Platform-Authenticator) blockieren.
      residentKey:      'required',    // discoverable credential → Login ohne Benutzername
      userVerification: 'preferred',
    },
  });

  challenges.set(`reg:${user.id}`, { challenge: options.challenge, expiresAt: Date.now() + 5 * 60_000 });
  res.json(options);
});

router.post('/register/finish', async (req, res) => {
  const stored = challenges.get(`reg:${req.user.id}`);
  if (!stored) return res.status(400).json({ error: 'Challenge abgelaufen — bitte neu starten' });
  challenges.delete(`reg:${req.user.id}`);

  // Frontend kann direkt attResp oder { registration: attResp, name: '...' } senden
  const regResponse = req.body.registration ?? req.body;
  const deviceName  = req.body.name || 'Passkey';

  try {
    const verification = await verifyRegistrationResponse({
      response:          regResponse,
      expectedChallenge: stored.challenge,
      expectedOrigin:    getOrigin(req),
      expectedRPID:      getRpId(req),
    });

    if (!verification.verified) return res.status(400).json({ error: 'Verifizierung fehlgeschlagen' });

    // SimpleWebAuthn v9+: registrationInfo.credential statt direkte Felder
    const { credential, credentialDeviceType } = verification.registrationInfo;

    db.prepare(
      'INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_type, transports) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      req.user.id,
      credential.id,                                               // Bereits Base64URL-String
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      deviceName,
      JSON.stringify(credential.transports || regResponse.response?.transports || []),
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Passkey-Verwaltung (eigene Passkeys) ────────────────────────────────────

router.get('/', (req, res) => {
  const passkeys = db.prepare(
    'SELECT credential_id AS id, device_type, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json(passkeys);
});

router.delete('/:id', (req, res) => {
  const pk = db.prepare('SELECT credential_id FROM passkeys WHERE credential_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!pk) return res.status(404).json({ error: 'Passkey nicht gefunden' });
  db.prepare('DELETE FROM passkeys WHERE credential_id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Passkey-Login (öffentlich — kein auth-Middleware) ───────────────────────
// Diese Endpoints werden in auth.js eingebunden

const loginStart = async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID:             getRpId(req),
      userVerification: 'preferred',
      allowCredentials: [], // Passkey sucht selbst nach passenden Keys (discoverable)
    });
    challenges.set(`login:${options.challenge}`, { challenge: options.challenge, expiresAt: Date.now() + 5 * 60_000 });
    res.json(options);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const loginFinish = async (req, res) => {
  const credId = req.body?.id;
  if (!credId) return res.status(400).json({ error: 'Ungültige Anfrage' });

  // Passkey aus DB laden
  const pk = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId);
  if (!pk) return res.status(400).json({ error: 'Unbekannter Passkey' });

  const stored = challenges.get(`login:${req.body.response?.clientDataJSON ? (() => {
    try { return JSON.parse(Buffer.from(req.body.response.clientDataJSON, 'base64url').toString()).challenge; } catch { return ''; }
  })() : ''}`);
  if (!stored) return res.status(400).json({ error: 'Challenge abgelaufen' });

  try {
    const verification = await verifyAuthenticationResponse({
      response:              req.body,
      expectedChallenge:     stored.challenge,
      expectedOrigin:        getOrigin(req),
      expectedRPID:          getRpId(req),
      credential: {
        id:        pk.credential_id,
        publicKey: Buffer.from(pk.public_key, 'base64url'),
        counter:   pk.counter,
        transports: JSON.parse(pk.transports || '[]'),
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Passkey-Verifizierung fehlgeschlagen' });

    // Counter updaten (Replay-Schutz)
    db.prepare('UPDATE passkeys SET counter = ? WHERE credential_id = ?').run(verification.authenticationInfo.newCounter, pk.credential_id);
    challenges.delete(`login:${stored.challenge}`);

    const user = db.prepare('SELECT id, username, rolle_id FROM users WHERE id = ?').get(pk.user_id);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });

    // Dasselbe Token wie beim Passwort-Login: mit Rolle und Rechten. Ohne die
    // bliebe die Navigation nach der Anmeldung leer, weil sie danach filtert.
    // Verzoegertes require, sonst greifen auth.js und passkeys.js im Kreis.
    const { tokenErzeugen, authLogSchreiben } = require('./auth');
    const token = tokenErzeugen(user);
    authLogSchreiben(req, user.id, user.username, true, 'passkey');
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = { router, loginStart, loginFinish };
