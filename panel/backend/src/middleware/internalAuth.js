// Absicherung der internen Endpunkte, die die n8n-Workflows aufrufen.
//
// Zwei Wächter, je nachdem, wer den Endpunkt rufen darf:
//
//   panelSecret          n8n (Header X-Panel-Secret, Wert aus PANEL_SECRET) — der
//                        Normalfall für alles unter /api/internal.
//   adminOderPanelSecret n8n ODER ein angemeldeter Admin. Für die Endpunkte, die
//                        Anhänge verarbeiten (Virenscan, Beleg-Lesen, Upload):
//                        Sie holen Dateien aus Postfächern und schreiben in die
//                        Nextcloud — das soll weder jeder Angemeldete noch jemand
//                        ohne Anmeldung auslösen können.
//
// Beide gehören VOR den Body-Parser: Wer sich nicht ausweist, soll keine 40 MB
// parsen lassen können.
const crypto = require('crypto');
const { sitzungPruefen, tokenAusKopf } = require('./auth');

// timingSafeEqual verlangt gleiche Laenge — bei Abweichung direkt ablehnen. Der
// Vergleich laeuft ueber SHA-256 beider Seiten, damit weder die Laenge des
// Geheimnisses noch der Ort des ersten Unterschieds durchsickert.
function secretPasst(geliefert) {
  const erwartet = process.env.PANEL_SECRET || '';
  if (!erwartet) return false;
  const a = crypto.createHash('sha256').update(String(geliefert || '')).digest();
  const b = crypto.createHash('sha256').update(erwartet).digest();
  return crypto.timingSafeEqual(a, b);
}

function panelSecret(req, res, next) {
  if (!secretPasst(req.headers['x-panel-secret'])) {
    return res.status(401).json({ error: 'Ungültiges Panel-Secret' });
  }
  next();
}

function adminOderPanelSecret(req, res, next) {
  // Ist der Header da, entscheidet allein er. Ein falsches Secret darf nicht auf
  // eine Anmeldung ausweichen können — sonst taugte jeder Fehlversuch als Sondierung.
  if (req.headers['x-panel-secret'] !== undefined) return panelSecret(req, res, next);

  const ergebnis = sitzungPruefen(tokenAusKopf(req));
  if (!ergebnis.ok) {
    return res.status(401).json({
      error: 'Weder ein gültiges Panel-Secret noch eine Admin-Anmeldung.',
      code: ergebnis.code,
    });
  }
  // Angemeldet, aber kein Admin: 403 — die Sitzung selbst ist in Ordnung.
  if (!ergebnis.user.admin) {
    return res.status(403).json({ error: 'Dafür ist die Admin-Rolle nötig.' });
  }
  req.user = ergebnis.user;
  next();
}

// Der bisherige Export bleibt die Funktion selbst: index.js und Tests binden sie so ein.
module.exports = panelSecret;
module.exports.panelSecret = panelSecret;
module.exports.adminOderPanelSecret = adminOderPanelSecret;
module.exports.secretPasst = secretPasst;
