// Alle JWTs des Panels an einer Stelle: Sitzung und 2FA-Ticket.
//
// Warum die Trennung so streng ist: Nach dem Passwort-Check darf ein Anmelder noch
// KEINE Sitzung haben, sondern nur ein Ticket, das ausschließlich für die
// Code-Eingabe taugt. Würde das Ticket mit demselben Schlüssel und ohne Zielgruppe
// signiert, ließe es sich als Sitzungs-Token vorzeigen — und die zweite Stufe wäre
// ein Umweg, den man einfach nicht geht.
//
// Deshalb zwei Sicherungen, die jede für sich genügen:
//   1. getrennte Schlüssel — das Ticket wird mit einem aus JWT_SECRET abgeleiteten
//      Schlüssel signiert, die Sitzung mit JWT_SECRET selbst;
//   2. getrennte Zielgruppe (aud) und fester Algorithmus (HS256), damit weder ein
//      Token mit "alg: none" noch eines für einen anderen Zweck durchgeht.
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const ISSUER = 'mail-panel';
const AUD_SITZUNG = 'mail-panel:sitzung';
const AUD_TICKET  = 'mail-panel:2fa';
const ALGORITHMEN = ['HS256'];

/** Laufzeit des Tickets zwischen Passwort und Code: fünf Minuten. */
const TICKET_SEKUNDEN = 5 * 60;

const sitzungsSchluessel = () => String(process.env.JWT_SECRET || '');

// Abgeleitet statt zweites Geheimnis: Es gibt nichts Neues zu konfigurieren oder zu
// verlieren, und wer JWT_SECRET nicht kennt, kann auch das Ticket nicht fälschen.
const ticketSchluessel = () => crypto
  .createHmac('sha256', sitzungsSchluessel())
  .update('mail-panel/auth-ticket/v1')
  .digest();

function secretPruefen() {
  if (!sitzungsSchluessel()) throw new Error('JWT_SECRET ist nicht gesetzt.');
}

// ─── Sitzung ─────────────────────────────────────────────────────────────────

/**
 * Das Token für die API. Trägt Benutzer, Rolle und Rechte — die Middleware lädt
 * die Rechte trotzdem frisch aus der Datenbank, der Payload dient der Anzeige.
 * @param {object} payload id, username, rolle_id, rolle_name, rechte, admin, amr
 */
function sitzungSignieren(payload, { expiresIn = '12h' } = {}) {
  secretPruefen();
  return jwt.sign(payload, sitzungsSchluessel(), {
    algorithm: ALGORITHMEN[0], issuer: ISSUER, audience: AUD_SITZUNG, expiresIn,
  });
}

/** Prüft ein Sitzungs-Token; wirft bei jedem Mangel (Ablauf, Signatur, Zielgruppe …). */
function sitzungVerifizieren(token) {
  secretPruefen();
  return jwt.verify(token, sitzungsSchluessel(), {
    algorithms: ALGORITHMEN, issuer: ISSUER, audience: AUD_SITZUNG,
  });
}

// ─── 2FA-Ticket ──────────────────────────────────────────────────────────────

/**
 * Das Ticket nach dem Passwort. Es öffnet nichts außer /api/auth/verify-2fa und den
 * Endpunkten zum Anfordern eines Codes.
 * @param {number} userId
 * @param {string} jti  eindeutige Kennung — die Datenbank merkt sich Fehlversuche je Ticket
 */
function ticketSignieren(userId, jti) {
  secretPruefen();
  return jwt.sign({ typ: '2fa-ticket' }, ticketSchluessel(), {
    algorithm: ALGORITHMEN[0],
    issuer: ISSUER,
    audience: AUD_TICKET,
    subject: String(userId),
    jwtid: jti,
    expiresIn: TICKET_SEKUNDEN,
  });
}

/** @returns {{userId: number, jti: string, exp: number}} */
function ticketVerifizieren(token) {
  secretPruefen();
  const p = jwt.verify(token, ticketSchluessel(), {
    algorithms: ALGORITHMEN, issuer: ISSUER, audience: AUD_TICKET,
  });
  const userId = Number(p.sub);
  if (p.typ !== '2fa-ticket' || !Number.isInteger(userId) || !p.jti) {
    throw new jwt.JsonWebTokenError('Kein gültiges Ticket');
  }
  return { userId, jti: p.jti, exp: p.exp };
}

module.exports = {
  sitzungSignieren, sitzungVerifizieren, ticketSignieren, ticketVerifizieren,
  TICKET_SEKUNDEN, ISSUER, AUD_SITZUNG, AUD_TICKET,
};
