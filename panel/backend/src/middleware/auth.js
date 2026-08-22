const jwt = require('jsonwebtoken');
const db  = require('../db');

// Hauptmiddleware: Token prüfen, Benutzer + Rolle + Rechte laden
// Statuscodes sind hier kein Detail, sondern Verhalten:
//
// 401 heisst "deine Sitzung taugt nicht mehr" — das Frontend meldet daraufhin ab
// und schickt zum Login. 403 heisst "angemeldet, aber nicht berechtigt" — da
// waere ein Abmelden falsch.
//
// Bis v2.8.0.0 lieferte ein ABGELAUFENES Token 403. Das Frontend loggt aber nur
// bei 401 aus, also passierte nach Ablauf der Sitzung genau nichts: Man blieb
// scheinbar angemeldet, jede Anfrage scheiterte still, und im Dashboard standen
// nur noch Fehler. Genau deshalb steht das hier jetzt getrennt.
function auth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.', code: 'kein_token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`
      SELECT u.id, u.username, u.rolle_id, r.name AS rolle_name, r.rechte
      FROM users u
      LEFT JOIN rollen r ON r.id = u.rolle_id
      WHERE u.id = ?
    `).get(decoded.id);
    // Zugang inzwischen geloescht: Das Token ist formal gueltig, gehoert aber
    // niemandem mehr — also abmelden statt weiterlaufen lassen.
    if (!user) {
      return res.status(401).json({ error: 'Dieser Zugang existiert nicht mehr.', code: 'benutzer_weg' });
    }
    // Rechte als Objekt bereitstellen
    let rechte = {};
    try { rechte = JSON.parse(user.rechte || '{}'); } catch { /* leer lassen */ }
    req.user = {
      id: user.id,
      username: user.username,
      rolle_id: user.rolle_id,
      rolle_name: user.rolle_name || 'Keine Rolle',
      rechte,
    };
    next();
  } catch (err) {
    // TokenExpiredError | JsonWebTokenError | NotBeforeError — in allen Faellen
    // ist die Sitzung hinueber und der Nutzer muss sich neu anmelden.
    const abgelaufen = err.name === 'TokenExpiredError';
    res.status(401).json({
      error: abgelaufen ? 'Deine Sitzung ist abgelaufen.' : 'Die Anmeldung ist ungültig.',
      code: abgelaufen ? 'abgelaufen' : 'ungueltig',
    });
  }
}

// Middleware-Factory: prüft, ob der Benutzer ein bestimmtes Recht hat
function rechtErforderlich(bereich) {
  return (req, res, next) => {
    if (!req.user?.rechte?.[bereich]) {
      return res.status(403).json({ error: `Keine Berechtigung für: ${bereich}` });
    }
    next();
  };
}

module.exports = auth;
module.exports.rechtErforderlich = rechtErforderlich;
