const db = require('../db');

function getApiKey() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('safebrowsing_api_key');
  return row ? row.value : null;
}

/**
 * Prüft eine Liste von Links gegen die Google Safe Browsing API v4.
 * @param {string[]} links Array von URLs
 * @returns {Promise<{ clean: boolean, treffer: string[] }>}
 */
async function pruefeLinks(links) {
  if (!links || links.length === 0) return { clean: true, treffer: [] };
  
  const apiKey = getApiKey();
  if (!apiKey) return { clean: true, treffer: [] };
  
  const url = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`;
  const payload = {
    client: {
      clientId: 'mail-panel',
      clientVersion: '1.4'
    },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: links.map(l => ({ url: l }))
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Die Link-Pruefung darf den Mail-Durchlauf nicht aufhalten
      signal: AbortSignal.timeout(10000),
    });
    
    if (!res.ok) {
      console.error(`Safe Browsing API Fehler: ${res.status} ${res.statusText}`);
      return { clean: true, treffer: [] };
    }
    
    const data = await res.json();
    if (data.matches && data.matches.length > 0) {
      const infizierteLinks = [...new Set(data.matches.map(m => m.threat.url))];
      return { clean: false, treffer: infizierteLinks };
    }
    
    return { clean: true, treffer: [] };
  } catch (err) {
    console.error(`Safe Browsing Netzwerkfehler: ${err.message}`);
    return { clean: true, treffer: [] };
  }
}

module.exports = { pruefeLinks };
