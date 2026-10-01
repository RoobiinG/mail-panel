// Zeitbasierte Einmalcodes (TOTP, RFC 6238) für Authenticator-Apps wie Aegis,
// Google Authenticator oder Bitwarden. Bewusst ohne zusätzliche Abhängigkeit: Der
// Algorithmus ist HMAC-SHA1 über einen Zähler plus eine Kürzung — das kann node:crypto.
//
// Parameter sind die, die jede App erwartet: SHA-1, 6 Stellen, 30 Sekunden.
const crypto = require('crypto');

const SCHRITT_SEKUNDEN = 30;
const STELLEN = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648

/** Ein neues Geheimnis: 20 Zufallsbytes (160 Bit, so viel wie SHA-1 hat), als base32. */
const neuesGeheimnis = () => base32Kodieren(crypto.randomBytes(20));

function base32Kodieren(puffer) {
  let bits = 0;
  let wert = 0;
  let aus = '';
  for (const byte of puffer) {
    wert = (wert << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      aus += ALPHABET[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) aus += ALPHABET[(wert << (5 - bits)) & 31];
  return aus;
}

function base32Dekodieren(text) {
  const sauber = String(text || '').toUpperCase().replace(/[\s=-]+/g, '');
  let bits = 0;
  let wert = 0;
  const bytes = [];
  for (const zeichen of sauber) {
    const i = ALPHABET.indexOf(zeichen);
    if (i < 0) throw new Error('Kein gültiges base32-Geheimnis.');
    wert = (wert << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((wert >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Der Code für einen Zähler (RFC 4226). */
function hotp(schluessel, zaehler) {
  const nachricht = Buffer.alloc(8);
  nachricht.writeBigUInt64BE(BigInt(zaehler));
  const h = crypto.createHmac('sha1', schluessel).update(nachricht).digest();
  const versatz = h[h.length - 1] & 0x0f;
  const zahl = ((h[versatz] & 0x7f) << 24) | (h[versatz + 1] << 16) | (h[versatz + 2] << 8) | h[versatz + 3];
  return String(zahl % 10 ** STELLEN).padStart(STELLEN, '0');
}

/** Der Zeitschritt zu einem Zeitpunkt (Millisekunden). */
const schrittVon = (jetzt = Date.now()) => Math.floor(jetzt / 1000 / SCHRITT_SEKUNDEN);

/** Der aktuell gültige Code — für Tests und für „Code zur Probe zeigen". */
const code = (geheimnis, jetzt = Date.now()) => hotp(base32Dekodieren(geheimnis), schrittVon(jetzt));

/**
 * Prüft einen eingegebenen Code.
 *
 * Das Fenster von ±1 Schritt fängt eine leicht gehende Uhr und die Zeit zum Tippen
 * ab. `nachSchritt` ist der zuletzt akzeptierte Schritt: Ein Code, der in einem
 * Schritt gilt, der nicht NACH diesem liegt, wird abgelehnt — sonst ließe sich ein
 * mitgelesener Code innerhalb seiner 90 Sekunden noch einmal verwenden.
 *
 * Alle drei Schritte werden immer verglichen (kein früher Abbruch), damit die
 * Antwortzeit nicht verrät, welcher getroffen hat.
 *
 * @returns {number|null} der Zeitschritt, in dem der Code galt — oder null
 */
function pruefen(geheimnis, eingabe, { jetzt = Date.now(), fenster = 1, nachSchritt = null } = {}) {
  const gesucht = String(eingabe == null ? '' : eingabe).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(gesucht)) return null;

  let schluessel;
  try { schluessel = base32Dekodieren(geheimnis); } catch { return null; }
  if (schluessel.length === 0) return null;

  const aktuell = schrittVon(jetzt);
  let treffer = null;
  for (let d = -fenster; d <= fenster; d += 1) {
    const schritt = aktuell + d;
    const a = Buffer.from(hotp(schluessel, schritt));
    const b = Buffer.from(gesucht);
    const gleich = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (gleich && (nachSchritt == null || schritt > nachSchritt) && (treffer == null || schritt > treffer)) {
      treffer = schritt;
    }
  }
  return treffer;
}

/** Die Adresse, die eine App per QR-Code oder Link einliest. */
function uri({ geheimnis, konto, aussteller = 'Mail-Panel' }) {
  const bezeichnung = `${encodeURIComponent(aussteller)}:${encodeURIComponent(konto)}`;
  const parameter = new URLSearchParams({
    secret: geheimnis, issuer: aussteller, algorithm: 'SHA1', digits: String(STELLEN), period: String(SCHRITT_SEKUNDEN),
  });
  return `otpauth://totp/${bezeichnung}?${parameter}`;
}

module.exports = {
  neuesGeheimnis, base32Kodieren, base32Dekodieren, hotp, code, pruefen, schrittVon, uri,
  SCHRITT_SEKUNDEN, STELLEN,
};
