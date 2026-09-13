// Nextcloud-Anbindung: Verbindungstest und Anlegen der Zugangsdaten in n8n.
//
// Zwei Credentials sind nötig, weil zwei verschiedene Knoten damit arbeiten:
//   nextCloudApi   → der fertige Nextcloud-Knoten (Datei-Upload)
//   httpBasicAuth  → der HTTP-Knoten für Kalendereinträge per CalDAV
const n8n      = require('./n8n');
const db       = require('./../db');
const settings = require('./settings');

const basis = () => String(settings.hole('nextcloud_url') || '').replace(/\/$/, '');

function zugangsdaten() {
  const url = basis();
  const user = settings.hole('nextcloud_user');
  const passwort = settings.hole('nextcloud_passwort');
  if (!url || !user || !passwort) {
    throw new Error('Nextcloud ist nicht eingerichtet (Einstellungen → Nextcloud).');
  }
  return { url, user, passwort };
}

const webDavUrl = (url, user) => `${url}/remote.php/dav/files/${encodeURIComponent(user)}`;

// Verbindungstest über WebDAV — liefert gleich die Ordner der obersten Ebene
async function testVerbindung() {
  const { url, user, passwort } = zugangsdaten();
  const kopf = {
    Authorization: 'Basic ' + Buffer.from(`${user}:${passwort}`).toString('base64'),
    Depth: '1',
    'Content-Type': 'application/xml',
  };
  const res = await fetch(webDavUrl(url, user) + '/', {
    method: 'PROPFIND',
    headers: kopf,
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error('Anmeldung abgelehnt — stimmt das App-Passwort?');
  if (!res.ok) throw new Error(`Nextcloud antwortete mit ${res.status}.`);

  const text = await res.text();
  const ordner = [...text.matchAll(/<d:href>([^<]+)<\/d:href>/gi)]
    .map((m) => decodeURIComponent(m[1]))
    .map((p) => p.split('/files/')[1] || '')
    .map((p) => p.split('/').filter(Boolean).slice(1).join('/'))
    .filter(Boolean);

  return { ok: true, ordner: ordner.slice(0, 25) };
}

// Legt beide Credentials in n8n an (und ersetzt vorhandene), damit der Nutzer
// dort nichts eintragen muss. IDs werden in settings gemerkt.
async function credentialsAnlegen() {
  const { url, user, passwort } = zugangsdaten();
  const merken = (key, wert) => db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(wert));

  for (const key of ['n8n_nextcloud_credential_id', 'n8n_nextcloud_basic_id']) {
    const alt = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    if (alt) { try { await n8n.credentialLoeschen(alt); } catch { /* war schon weg */ } }
  }

  const { data: dav } = await n8n.client().post('/credentials', {
    name: 'Mail-Panel: Nextcloud',
    type: 'nextCloudApi',
    data: { webDavUrl: webDavUrl(url, user), user, password: passwort },
  });
  merken('n8n_nextcloud_credential_id', dav.id);

  const { data: basic } = await n8n.client().post('/credentials', {
    name: 'Mail-Panel: Nextcloud',
    type: 'httpBasicAuth',
    data: { user, password: passwort },
  });
  merken('n8n_nextcloud_basic_id', basic.id);

  return { webdav: dav.id, basic: basic.id };
}

// ─── Hochladen ───────────────────────────────────────────────────────────────
//
// Bis Build 192 lud ausschließlich n8n hoch (der Nextcloud-Knoten in Workflow
// 07), und dieses Modul legte dafür nur die Zugangsdaten an. Mit der Freigabe
// vor dem Upload geht das nicht mehr: n8n kann nicht auf einen Menschen warten,
// also liefert es die Datei ab und das Panel trägt sie später selbst hinüber —
// genauso, wie es beim Freigeben eines Ordners selbst per IMAP verschiebt.

const kopfAuth = (user, passwort) => ({
  Authorization: 'Basic ' + Buffer.from(`${user}:${passwort}`).toString('base64'),
});

// Jedes Pfadsegment einzeln kodieren, den Schrägstrich nicht — sonst wird aus
// "Belege/A & B" entweder ein kaputter Pfad oder ein einziger Ordnername.
const pfadUrl = (basis, pfad) =>
  `${basis}/${String(pfad).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;

const TYPEN = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};
const typAus = (name) => TYPEN[(String(name).match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase()]
  || 'application/octet-stream';

function fehlerAus(status, was) {
  if (status === 401) return new Error('Nextcloud hat die Anmeldung abgelehnt — stimmt das App-Passwort?');
  return new Error(`Nextcloud antwortete beim ${was} mit ${status}.`);
}

/**
 * Legt den Ordnerpfad an — Ebene für Ebene von oben nach unten.
 * Nextcloud erzeugt fehlende Zwischenordner beim Hochladen NICHT; wer direkt
 * nach "Belege/2026/acme" schreibt, bekommt 409 statt eines Ordners.
 */
async function ordnerAnlegen(pfad) {
  const { url, user, passwort } = zugangsdaten();
  const basis = webDavUrl(url, user);
  const teile = String(pfad).split('/').filter(Boolean);

  let bisher = '';
  for (const teil of teile) {
    bisher = bisher ? `${bisher}/${teil}` : teil;
    const res = await fetch(pfadUrl(basis, bisher), {
      method: 'MKCOL',
      headers: kopfAuth(user, passwort),
      signal: AbortSignal.timeout(20000),
    });
    // 405 heißt "gibt es schon" — der Normalfall ab dem zweiten Beleg.
    if (res.ok || res.status === 405) continue;
    throw fehlerAus(res.status, `Anlegen von "${bisher}"`);
  }
  return teile.join('/');
}

/** Gibt es dort schon etwas? */
async function existiert(pfad) {
  const { url, user, passwort } = zugangsdaten();
  const res = await fetch(pfadUrl(webDavUrl(url, user), pfad), {
    method: 'HEAD',
    headers: kopfAuth(user, passwort),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw fehlerAus(401, 'Nachsehen');
  return res.ok;
}

async function dateiHochladen(pfad, inhalt, mimeType) {
  const { url, user, passwort } = zugangsdaten();
  const res = await fetch(pfadUrl(webDavUrl(url, user), pfad), {
    method: 'PUT',
    headers: { ...kopfAuth(user, passwort), 'Content-Type': mimeType || 'application/octet-stream' },
    body: inhalt,
    // 15 Sekunden wie beim Verbindungstest reichen für 15 MB nicht.
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw fehlerAus(res.status, 'Hochladen');
  return true;
}

/**
 * Eine Datei ablegen: Ordner anlegen, freien Namen suchen, hochladen.
 *
 * Ein PUT überschreibt stillschweigend, und `Overwrite: F` gilt nur für COPY und
 * MOVE. Deshalb wird vorher nachgesehen und bei Bedarf " (2)" angehängt — das
 * Panel löscht und überschreibt grundsätzlich nichts.
 *
 * @returns {Promise<{ok: true, pfad: string, dateiname: string}>}
 */
async function ablegen({ zielpfad, dateiname, inhalt }) {
  const ordner = await ordnerAnlegen(zielpfad);
  const endung = (String(dateiname).match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  const rumpf = String(dateiname).slice(0, String(dateiname).length - endung.length);

  let name = dateiname;
  for (let n = 2; n <= 50; n += 1) {
    const voll = ordner ? `${ordner}/${name}` : name;
    if (!(await existiert(voll))) break;
    name = `${rumpf} (${n})${endung}`;
  }

  const ziel = ordner ? `${ordner}/${name}` : name;
  await dateiHochladen(ziel, inhalt, typAus(name));
  return { ok: true, pfad: ordner, dateiname: name };
}

module.exports = {
  testVerbindung, credentialsAnlegen, webDavUrl,
  ordnerAnlegen, dateiHochladen, existiert, ablegen, pfadUrl,
};
