// DNSBL-Abfragen ueber den eigenen unbound-Resolver.
// Wichtig: Spamhaus & Co. blocken oeffentliche Resolver (Google/Cloudflare) —
// deshalb laeuft jede Abfrage ueber den unbound-Container aus dem Compose-Stack.
const { Resolver } = require('dns').promises;

const UNBOUND_HOST = process.env.UNBOUND_HOST || 'unbound';
const UNBOUND_PORT = parseInt(process.env.UNBOUND_PORT || '53', 10);

function resolver() {
  const r = new Resolver({ timeout: 5000, tries: 1 });
  r.setServers([`${UNBOUND_HOST}:${UNBOUND_PORT}`]);
  return r;
}

// Verbindungstest: 127.0.0.2 ist die Standard-Testadresse, die jede DNSBL
// als gelistet meldet — ideal, um Resolver UND Listen-Erreichbarkeit zu pruefen.
async function testVerbindung(liste = 'zen.spamhaus.org') {
  const name = `2.0.0.127.${liste}`;
  const adressen = await resolver().resolve4(name);
  return { ok: true, liste, antwort: adressen };
}

// Etappe 3: IP gegen alle konfigurierten Listen pruefen
async function pruefeIp(ip, listen) {
  const umgedreht = String(ip).split('.').reverse().join('.');
  const treffer = [];
  await Promise.all(listen.map(async (liste) => {
    try {
      await resolver().resolve4(`${umgedreht}.${liste}`);
      treffer.push(liste);
    } catch { /* NXDOMAIN = nicht gelistet */ }
  }));
  return treffer;
}

module.exports = { testVerbindung, pruefeIp };
