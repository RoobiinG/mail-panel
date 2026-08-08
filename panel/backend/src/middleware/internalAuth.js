// Absicherung der internen Endpunkte, die die n8n-Workflows aufrufen.
// n8n schickt den Shared-Secret-Header X-Panel-Secret (Wert aus PANEL_SECRET).
const crypto = require('crypto');

module.exports = (req, res, next) => {
  const geliefert = req.headers['x-panel-secret'] || '';
  const erwartet  = process.env.PANEL_SECRET || '';
  const a = Buffer.from(String(geliefert));
  const b = Buffer.from(String(erwartet));
  // timingSafeEqual verlangt gleiche Laenge — bei Abweichung direkt ablehnen
  if (!erwartet || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Ungültiges Panel-Secret' });
  }
  next();
};
