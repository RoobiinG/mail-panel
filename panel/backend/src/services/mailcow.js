// Client fuer die Mailcow-Verwaltungs-API (X-API-Key).
// Ab Etappe 5/6 kommen Quarantaene- und Rspamd-Policy-Funktionen dazu.
const axios    = require('axios');
const settings = require('./settings');

function client() {
  const basis = settings.hole('mailcow_url');
  const key   = settings.hole('mailcow_api_key');
  if (!basis || !key) throw new Error('Mailcow ist nicht eingerichtet (Einstellungen → Mailcow).');
  return axios.create({
    baseURL: `${basis.replace(/\/$/, '')}/api/v1`,
    headers: { 'X-API-Key': key },
    timeout: 10000,
  });
}

// Verbindungstest: Quarantaene-Abfrage (harmlos, read-only)
async function testVerbindung() {
  const { data } = await client().get('/get/quarantine/all');
  // Mailcow antwortet bei falschem Key mit 200 und einem Fehlerobjekt
  if (data && data.type === 'error') throw new Error(data.msg || 'Mailcow lehnt den API-Key ab');
  return { ok: true, quarantaene: Array.isArray(data) ? data.length : 0 };
}

module.exports = { client, testVerbindung };
