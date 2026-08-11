// Sortier-Logik: gleicht eingehende Mails mit den Konto-spezifischen Regeln ab.
const db = require('../db');
const { loggen } = require('./panelLog');

/**
 * Prueft, ob eine Mail auf eine der Sortier-Regeln des Kontos passt.
 * @param {number} kontoId 
 * @param {string} von 
 * @param {string} betreff 
 * @returns {object|null} { ordner: 'Ziel', regel_id: 123 } oder null
 */
function pruefeRegeln(kontoId, von, betreff) {
  if (!kontoId) return null;

  try {
    const regeln = db.prepare('SELECT * FROM sort_rules WHERE konto_id = ?').all(kontoId);
    
    // Einfache Extraktion: alles in Kleinbuchstaben fuer den Vergleich
    const vonLower = (von || '').toLowerCase();
    const betreffLower = (betreff || '').toLowerCase();
    
    // Email-Adresse aus dem "Von"-Feld extrahieren (falls Format: "Name <email@domain.com>")
    let absenderEmail = vonLower;
    const match = vonLower.match(/<([^>]+)>/);
    if (match) absenderEmail = match[1];

    for (const regel of regeln) {
      const musterLower = regel.muster.toLowerCase();
      let treffer = false;

      switch (regel.typ) {
        case 'absender':
          // Exakter Match auf die E-Mail-Adresse
          if (absenderEmail === musterLower || vonLower.includes(musterLower)) treffer = true;
          break;
        case 'domain':
          // Domain-Match, z.B. "@amazon.de" oder "amazon.de"
          if (absenderEmail.endsWith(musterLower.replace(/^@/, ''))) treffer = true;
          break;
        case 'betreff':
          // Substring-Match im Betreff
          if (betreffLower.includes(musterLower)) treffer = true;
          break;
      }

      if (treffer) {
        // Zaehler hochsetzen
        db.prepare('UPDATE sort_rules SET treffer = treffer + 1 WHERE id = ?').run(regel.id);
        return { ordner: regel.zielordner, regel_id: regel.id };
      }
    }

    return null; // Kein Match
  } catch (err) {
    loggen('error', 'backend:sortierung', `Fehler bei pruefeRegeln: ${err.message}`);
    return null;
  }
}

module.exports = {
  pruefeRegeln,
};
