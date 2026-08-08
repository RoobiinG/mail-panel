// AES-256-GCM für Werte, die verschlüsselt in der SQLite-Datenbank liegen
// (Konto-Passwörter, API-Keys). Schlüssel kommt aus PANEL_DB_KEY.
const crypto = require('crypto');

const schluessel = () => crypto.createHash('sha256').update(String(process.env.PANEL_DB_KEY)).digest();

function verschluesseln(klartext) {
  if (klartext == null || klartext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  const daten = Buffer.concat([cipher.update(String(klartext), 'utf8'), cipher.final()]);
  // Format: iv:authTag:daten (alles Base64)
  return [iv, cipher.getAuthTag(), daten].map((b) => b.toString('base64')).join(':');
}

function entschluesseln(gespeichert) {
  if (!gespeichert) return '';
  const teile = String(gespeichert).split(':');
  if (teile.length !== 3) return '';
  try {
    const [iv, tag, daten] = teile.map((t) => Buffer.from(t, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', schluessel(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(daten), decipher.final()]).toString('utf8');
  } catch {
    // Falscher Schlüssel oder manipulierte Daten
    return '';
  }
}

module.exports = { verschluesseln, entschluesseln };
