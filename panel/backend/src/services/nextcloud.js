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

module.exports = { testVerbindung, credentialsAnlegen, webDavUrl };
