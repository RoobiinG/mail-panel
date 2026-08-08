// Client fuer die Mailcow-Verwaltungs-API (X-API-Key).
// Ab Etappe 5/6 kommen Quarantaene- und Rspamd-Policy-Funktionen dazu.
const axios = require('axios');

const client = () => axios.create({
  baseURL: `${(process.env.MAILCOW_URL || '').replace(/\/$/, '')}/api/v1`,
  headers: { 'X-API-Key': process.env.MAILCOW_API_KEY || '' },
  timeout: 10000,
});

// Verbindungstest: Quarantaene-Abfrage (harmlos, read-only)
async function testVerbindung() {
  if (!process.env.MAILCOW_URL) throw new Error('MAILCOW_URL ist nicht gesetzt');
  const { data } = await client().get('/get/quarantine/all');
  return { ok: true, quarantaene: Array.isArray(data) ? data.length : 0 };
}

module.exports = { client, testVerbindung };
