const db  = require('../db');
const { sitzungVerifizieren } = require('../services/tokens');

/**
 * Prüft ein Sitzungs-Token und lädt Benutzer, Rolle und Rechte aus der Datenbank.
 * Wirft nie: Das Ergebnis sagt, ob die Sitzung taugt und — wenn nicht — warum.
 *
 * Eigene Funktion, weil zwei Middlewares sie brauchen (auth und die Admin-Prüfung
 * der internen Endpunkte) und beide dieselbe Antwort geben sollen.
 *
 * Die Rechte kommen aus der Datenbank, nicht aus dem Token: Wer einem Benutzer die
 * Rolle entzieht, soll das sofort spüren und nicht erst, wenn dessen Token abläuft.
 *
 * @returns {{ok: true, user: object} | {ok: false, status: number, code: string, error: string}}
 */
function sitzungPruefen(token) {
  if (!token) return { ok: false, status: 401, code: 'kein_token', error: 'Nicht angemeldet.' };
  try {
    const decoded = sitzungVerifizieren(token);
    const user = db.prepare(`
      SELECT u.id, u.username, u.rolle_id, r.name AS rolle_name, r.rechte, r.fest AS rolle_fest
      FROM users u
      LEFT JOIN rollen r ON r.id = u.rolle_id
      WHERE u.id = ?
    `).get(decoded.id);
    // Zugang inzwischen geloescht: Das Token ist formal gueltig, gehoert aber
    // niemandem mehr — also abmelden statt weiterlaufen lassen.
    if (!user) {
      return { ok: false, status: 401, code: 'benutzer_weg', error: 'Dieser Zugang existiert nicht mehr.' };
    }
    // Rechte als Objekt bereitstellen
    let rechte = {};
    try { rechte = JSON.parse(user.rechte || '{}'); } catch { /* leer lassen */ }
    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        rolle_id: user.rolle_id,
        rolle_name: user.rolle_name || 'Keine Rolle',
        rechte,
        // Die feste Admin-Rolle (rollen.fest = 1) — nicht frei bearbeitbar, anders
        // als jede selbst angelegte Rolle, in die sich beliebige Rechte schreiben lassen.
        admin: user.rolle_fest === 1,
        amr: Array.isArray(decoded.amr) ? decoded.amr : [],
      },
    };
  } catch (err) {
    // TokenExpiredError | JsonWebTokenError | NotBeforeError — in allen Faellen
    // ist die Sitzung hinueber und der Nutzer muss sich neu anmelden. Dazu zaehlt
    // auch ein Token mit falscher Zielgruppe, etwa ein 2FA-Ticket.
    const abgelaufen = err.name === 'TokenExpiredError';
    return {
      ok: false,
      status: 401,
      code: abgelaufen ? 'abgelaufen' : 'ungueltig',
      error: abgelaufen ? 'Deine Sitzung ist abgelaufen.' : 'Die Anmeldung ist ungültig.',
    };
  }
}

/** Das Token aus dem Authorization-Header ("Bearer …"). */
const tokenAusKopf = (req) => {
  const kopf = req.headers['authorization'];
  return (kopf && kopf.split(' ')[1]) || null;
};

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
  // Bewusst NUR die Kopfzeile: Ein Token im Query-String landet im
  // Zugriffsprotokoll jedes Proxys, im Browser-Verlauf und in Fehlerberichten.
  // Die einzige Stelle, die das brauchte (der Ollama-Download per EventSource),
  // liest den Strom inzwischen mit fetch und schickt die Kopfzeile mit.
  const ergebnis = sitzungPruefen(tokenAusKopf(req));
  if (!ergebnis.ok) {
    return res.status(ergebnis.status).json({ error: ergebnis.error, code: ergebnis.code });
  }
  req.user = ergebnis.user;
  next();
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
module.exports.sitzungPruefen = sitzungPruefen;
module.exports.tokenAusKopf = tokenAusKopf;
