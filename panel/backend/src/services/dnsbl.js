// DNSBL-Abfragen über den eigenen unbound-Resolver.
// Wichtig: Spamhaus & Co. blocken öffentliche Resolver (Google/Cloudflare) —
// deshalb läuft jede Abfrage über den unbound-Container aus dem Compose-Stack.
const dns = require('dns');
const { Resolver } = dns.promises;

const UNBOUND_HOST = process.env.UNBOUND_HOST || 'unbound';
const UNBOUND_PORT = parseInt(process.env.UNBOUND_PORT || '53', 10);

// setServers() akzeptiert nur IP-Adressen — der Container-Name muss also
// zuerst über den Docker-DNS aufgelöst werden. Ergebnis wird gecacht.
let resolverIpCache = null;
async function resolverIp() {
  if (resolverIpCache) return resolverIpCache;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(UNBOUND_HOST)) {
    resolverIpCache = UNBOUND_HOST;
  } else {
    const { address } = await dns.promises.lookup(UNBOUND_HOST, { family: 4 });
    resolverIpCache = address;
  }
  return resolverIpCache;
}

async function resolver() {
  const r = new Resolver({ timeout: 5000, tries: 1 });
  r.setServers([`${await resolverIp()}:${UNBOUND_PORT}`]);
  return r;
}

// Antworten aus 127.255.255.0/24 sind KEINE Treffer, sondern Fehlercodes der
// Liste ("Abfrage abgelehnt", "Kontingent erschöpft", "Resolver gesperrt").
// Spamhaus liefert das z.B. für Anfragen aus Rechenzentrums-Netzen ohne
// eigenen Zugangsschlüssel. Würde man das als Treffer werten, landete jede
// Mail in der Quarantäne — deshalb streng trennen.
const istFehlercode = (adressen) => adressen.some((a) => a.startsWith('127.255.255.'));

// Prüft eine IP gegen alle konfigurierten Listen.
// Liefert { treffer: [...], nichtNutzbar: [{liste, code}] }
async function pruefeIp(ip, listen) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(ip))) return { treffer: [], nichtNutzbar: [] };
  const umgedreht = String(ip).split('.').reverse().join('.');
  const treffer = [];
  const nichtNutzbar = [];

  await Promise.all(listen.map(async (liste) => {
    try {
      const r = await resolver();
      const adressen = await r.resolve4(`${umgedreht}.${liste}`);
      if (istFehlercode(adressen)) nichtNutzbar.push({ liste, code: adressen[0] });
      else treffer.push(liste);
    } catch (err) {
      // NXDOMAIN heißt schlicht "nicht gelistet" — alles andere ist ein Problem
      if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') {
        nichtNutzbar.push({ liste, code: err.code || 'FEHLER' });
      }
    }
  }));
  return { treffer, nichtNutzbar };
}

// Verbindungstest: 127.0.0.2 ist die Standard-Testadresse, die jede DNSBL als
// gelistet meldet. Damit lassen sich Resolver UND Listen auf einmal prüfen.
async function testVerbindung(listen = ['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org']) {
  const { treffer, nichtNutzbar } = await pruefeIp('127.0.0.2', listen);
  if (treffer.length === 0) {
    const grund = nichtNutzbar.map((n) => `${n.liste} (${n.code})`).join(', ') || 'keine Antwort';
    throw new Error(`Keine DNSBL antwortet verwertbar: ${grund}`);
  }
  return {
    ok: true,
    nutzbar: treffer,
    // Hinweis für die Oberfläche: diese Listen lehnen den Server ab
    nichtNutzbar: nichtNutzbar.map((n) => `${n.liste} (${n.code})`),
  };
}

module.exports = { testVerbindung, pruefeIp };
