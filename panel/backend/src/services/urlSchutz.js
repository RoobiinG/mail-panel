// Schutz vor Anfragen an eigene Dienste (SSRF).
//
// Hintergrund: An mehreren Stellen ruft das Panel URLs auf, die nicht von uns
// stammen — der Abmelde-Link kommt aus dem List-Unsubscribe-Header einer Mail,
// die Webhook-Aktion aus einer Regel. Ohne Prüfung könnte ein Absender das Panel
// dazu bringen, Dienste im Docker-Netz oder die Metadaten-Adresse des Anbieters
// abzufragen. Deshalb: Nur öffentliche Ziele, mit Zeitlimit, ohne Weiterleitung.
const dns = require('dns').promises;
const net = require('net');

const ERLAUBTE_SCHEMATA = ['http:', 'https:'];

// Adressbereiche, die niemals von außen angefragt werden dürfen
function istInterneIPv4(ip) {
  const t = ip.split('.').map(Number);
  if (t.length !== 4 || t.some((z) => Number.isNaN(z))) return true;
  const [a, b] = t;
  return (
    a === 0 ||                            // "dieses Netz"
    a === 10 ||                           // privat
    a === 127 ||                          // localhost
    (a === 169 && b === 254) ||           // Link-Local, dort liegen die Cloud-Metadaten
    (a === 172 && b >= 16 && b <= 31) ||  // privat
    (a === 192 && b === 168) ||           // privat
    (a === 100 && b >= 64 && b <= 127) || // Carrier-Grade-NAT
    a >= 224                              // Multicast und reserviert
  );
}

function istInterneIPv6(ip) {
  const k = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (k === '::1' || k === '::') return true;
  if (k.startsWith('fe80') || k.startsWith('fc') || k.startsWith('fd')) return true;
  // IPv4-gemappte Adressen wie ::ffff:127.0.0.1 mitprüfen
  const v4 = k.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return istInterneIPv4(v4[1]);
  return false;
}

const istInterneAdresse = (ip) =>
  net.isIPv6(ip) ? istInterneIPv6(ip) : istInterneIPv4(ip);

/**
 * Prüft eine URL, bevor sie aufgerufen wird.
 * Wirft mit einer für die Oberfläche verständlichen Meldung, wenn sie nicht taugt.
 * @returns {Promise<URL>} die geprüfte URL
 */
async function pruefeUrl(eingabe) {
  let url;
  try {
    url = new URL(String(eingabe));
  } catch {
    throw new Error('Keine gültige Adresse.');
  }
  if (!ERLAUBTE_SCHEMATA.includes(url.protocol)) {
    throw new Error(`Nur http und https sind erlaubt (angegeben: ${url.protocol.replace(':', '')}).`);
  }

  // Steht dort direkt eine IP, brauchen wir gar nicht erst aufzulösen
  if (net.isIP(url.hostname)) {
    if (istInterneAdresse(url.hostname)) {
      throw new Error('Adressen im eigenen Netz sind nicht erlaubt.');
    }
    return url;
  }

  let adressen;
  try {
    adressen = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`Der Name ${url.hostname} lässt sich nicht auflösen.`);
  }
  // Ein einziger interner Treffer reicht zum Ablehnen (DNS-Rebinding)
  if (adressen.some((a) => istInterneAdresse(a.address))) {
    throw new Error('Die Adresse zeigt ins eigene Netz und wird nicht aufgerufen.');
  }
  return url;
}

/**
 * Wie fetch, aber nur für geprüfte, öffentliche Ziele — mit Zeitlimit und
 * ohne Weiterleitungen (eine Weiterleitung könnte sonst doch nach innen zeigen).
 */
async function sichererAbruf(eingabe, optionen = {}, timeoutMs = 10000) {
  const url = await pruefeUrl(eingabe);
  const abbruch = new AbortController();
  const wecker = setTimeout(() => abbruch.abort(), timeoutMs);
  try {
    return await fetch(url, { ...optionen, redirect: 'manual', signal: abbruch.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Zeitüberschreitung beim Aufruf.');
    throw err;
  } finally {
    clearTimeout(wecker);
  }
}

module.exports = { pruefeUrl, sichererAbruf, istInterneAdresse };
