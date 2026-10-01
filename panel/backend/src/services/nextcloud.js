// Nextcloud-Anbindung: Verbindungstest und Anlegen der Zugangsdaten in n8n.
//
// Zwei Credentials sind nötig, weil zwei verschiedene Knoten damit arbeiten:
//   nextCloudApi   → der fertige Nextcloud-Knoten (Datei-Upload)
//   httpBasicAuth  → der HTTP-Knoten für Kalendereinträge per CalDAV
const crypto   = require('crypto');
const n8n      = require('./n8n');
const db       = require('./../db');
const settings = require('./settings');
const { loggen } = require('./panelLog');

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

const kopfAuth = (user, passwort) => ({
  Authorization: 'Basic ' + Buffer.from(`${user}:${passwort}`).toString('base64'),
});

function fehlerAus(status, was) {
  if (status === 401) return new Error('Nextcloud hat die Anmeldung abgelehnt — stimmt das App-Passwort?');
  return new Error(`Nextcloud antwortete beim ${was} mit ${status}.`);
}

// ─── Nur ein App-Passwort, nie das Hauptpasswort ─────────────────────────────
//
// Das Hauptpasswort öffnet das ganze Konto: Mails, Kalender, die Einstellungen,
// jede andere App. Das Panel braucht nur die Dateien — und ein App-Passwort lässt
// sich einzeln widerrufen, ohne dass sich sonst etwas ändert. Deshalb verlangt das
// Panel ausnahmslos eines, bevor es irgendetwas hochlädt oder Zugangsdaten an n8n
// weitergibt.
//
// Wie man es erkennt: Nextcloud stellt App-Passwörter unter
// /ocs/v2.php/core/getapppassword aus — aber nur, wenn man mit dem HAUPTpasswort
// anfragt. Mit einem App-Passwort antwortet es 403. Das ist eine saubere
// Unterscheidung, die ohne Raten auskommt. Antwortet es mit 200, war es das
// Hauptpasswort; das dabei ausgestellte Token wird sofort wieder widerrufen, damit
// die Prüfung nichts zurücklässt.
const HAUPTPASSWORT_TEXT =
  'In den Einstellungen steht das Hauptpasswort der Nextcloud. Das Panel nimmt nur ein '
  + 'App-Passwort: In der Nextcloud unter „Persönliche Einstellungen → Sicherheit → '
  + 'Geräte & Sitzungen“ ein neues anlegen und hier eintragen.';

const ocsKopf = (user, passwort) => ({
  ...kopfAuth(user, passwort), 'OCS-APIRequest': 'true', Accept: 'application/json',
});

// Der Fingerabdruck gilt für genau diese Adresse, diesen Benutzer und dieses
// Passwort. Ändert sich eins davon, wird neu geprüft; sonst nicht bei jedem Upload.
function fingerabdruck({ url, user, passwort }) {
  return crypto.createHmac('sha256', String(process.env.PANEL_DB_KEY || ''))
    .update(`nextcloud-app-passwort\n${url}\n${user}\n${passwort}`).digest('hex');
}

const MERKER = 'nextcloud_app_passwort_ok';

/**
 * Wirft, wenn das hinterlegte Passwort kein App-Passwort ist (oder sich das nicht
 * feststellen lässt — im Zweifel wird nichts hochgeladen).
 */
async function appPasswortPruefen(zugang = zugangsdaten()) {
  const { url, user, passwort } = zugang;
  const fp = fingerabdruck(zugang);
  if (settings.hole(MERKER) === fp) return true;

  let res;
  try {
    res = await fetch(`${url}/ocs/v2.php/core/getapppassword?format=json`, {
      headers: ocsKopf(user, passwort),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Nextcloud nicht erreichbar, das App-Passwort ließ sich nicht prüfen: ${err.message}`);
  }

  if (res.status === 403) {
    // Genau so antwortet Nextcloud auf ein App-Passwort.
    settings.setze(MERKER, fp);
    return true;
  }
  if (res.status === 401) throw fehlerAus(401, 'Prüfen');

  if (res.ok) {
    // Hauptpasswort. Das ausgestellte Token wieder einziehen — der Widerruf muss
    // mit dem neuen Token selbst beglaubigt werden.
    let widerrufen = false;
    try {
      const token = (await res.json())?.ocs?.data?.apppassword;
      if (token) {
        const weg = await fetch(`${url}/ocs/v2.php/core/apppassword`, {
          method: 'DELETE',
          headers: ocsKopf(user, token),
          signal: AbortSignal.timeout(15000),
        });
        widerrufen = weg.ok;
      }
    } catch { /* unten gemeldet */ }
    if (!widerrufen) {
      loggen('warn', 'nextcloud',
        'Beim Prüfen des Passworts wurde ein App-Passwort ausgestellt und ließ sich nicht widerrufen — '
        + 'bitte in der Nextcloud unter „Geräte & Sitzungen“ entfernen.');
    }
    throw new Error(HAUPTPASSWORT_TEXT);
  }

  // 404, 5xx: Unklar, was hinterlegt ist. „Ausnahmslos" heißt, dass dann nichts
  // hochgeladen wird — und weil nichts gemerkt wird, klappt ein späterer Versuch.
  throw new Error(
    `Ob das hinterlegte Passwort ein App-Passwort ist, ließ sich nicht prüfen (Nextcloud antwortete ${res.status}). `
    + 'Hochgeladen wird erst, wenn die Prüfung gelingt.',
  );
}

/** Zugangsdaten für alles, was schreibt: nur mit bestätigtem App-Passwort. */
async function uploadZugang() {
  const zugang = zugangsdaten();
  await appPasswortPruefen(zugang);
  return zugang;
}

// Verbindungstest über WebDAV — liefert gleich die Ordner der obersten Ebene
async function testVerbindung() {
  const zugang = zugangsdaten();
  const { url, user, passwort } = zugang;
  await appPasswortPruefen(zugang);
  const kopf = {
    ...kopfAuth(user, passwort),
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
  const zugang = zugangsdaten();
  const { url, user, passwort } = zugang;
  // n8n bekommt nie ein Hauptpasswort — es speichert die Zugangsdaten im Klartext
  // seiner eigenen Datenbank und reicht sie an jeden Workflow weiter.
  await appPasswortPruefen(zugang);
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

/**
 * Zerlegt einen Pfad in seine Teile — und lehnt ab, was nicht dorthin gehört.
 *
 * Gesäubert wird hier bewusst NICHT: Wer das Panel erreicht, hat seinen Pfad
 * längst durch pfadSicherheit.js geschickt. Kommt hier trotzdem ein ".." an, ist
 * irgendwo davor etwas schiefgegangen, und das soll laut werden statt unbemerkt
 * in einen anderen Ordner zu schreiben.
 */
function pfadTeile(pfad) {
  const teile = String(pfad == null ? '' : pfad).split('/').filter((t) => t !== '');
  for (const t of teile) {
    if (t === '.' || t === '..' || /[\u0000-\u001f\u007f\\]/.test(t)) {
      throw new Error(`Unzulässiger Pfadteil für die Nextcloud: ${JSON.stringify(t)}`);
    }
  }
  return teile;
}

// Jedes Pfadsegment einzeln kodieren, den Schrägstrich nicht — sonst wird aus
// "Belege/A & B" entweder ein kaputter Pfad oder ein einziger Ordnername.
//
// Danach wird nachgesehen, ob die Adresse noch im eigenen Bereich liegt. encodeURI-
// Component lässt Punkte stehen, ".." wurde oben schon abgewiesen; ein "%2e%2e" im
// Namen wird zu "%252e%252e" und damit ein gewöhnlicher Name. Die Prüfung hier ist
// der Gürtel zum Hosenträger: Sie bleibt richtig, auch wenn jemand an dieser
// Kodierung dreht.
function pfadUrl(wurzel, pfad) {
  const teile = pfadTeile(pfad);
  const adresse = teile.length
    ? `${wurzel}/${teile.map(encodeURIComponent).join('/')}`
    : `${wurzel}/`;
  const a = new URL(adresse);
  const w = new URL(`${wurzel}/`);
  if (a.origin !== w.origin || !a.pathname.startsWith(w.pathname)) {
    throw new Error('Der Pfad führt aus dem Nextcloud-Bereich des Benutzers heraus.');
  }
  return adresse;
}

/**
 * Gibt es dort etwas — und ist es ein Ordner? Per PROPFIND (Depth 0), also ohne
 * den Inhalt eines Ordners zu laden.
 * @returns {Promise<{existiert: boolean, istOrdner: boolean}>}
 */
async function davStatus(pfad, zugang) {
  const { url, user, passwort } = zugang || await uploadZugang();
  const res = await fetch(pfadUrl(webDavUrl(url, user), pfad), {
    method: 'PROPFIND',
    headers: {
      ...kopfAuth(user, passwort), Depth: '0', 'Content-Type': 'application/xml',
    },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return { existiert: false, istOrdner: false };
  if (res.status === 207 || res.status === 200) {
    const text = await res.text();
    // Ein Ordner trägt <d:resourcetype><d:collection/></d:resourcetype>.
    return { existiert: true, istOrdner: /<[A-Za-z0-9]*:?collection\b/i.test(text) };
  }
  throw fehlerAus(res.status, `Nachsehen nach "${pfad}"`);
}

/**
 * Stellt sicher, dass der Ordnerpfad existiert — und legt fehlende Ebenen an.
 *
 * Erst wird nachgesehen (PROPFIND). Fehlt ein Ordner, kümmert sich die Funktion
 * rekursiv zuerst um den darüberliegenden und legt DANN den eigenen an (MKCOL).
 * Nextcloud erzeugt fehlende Zwischenordner beim Hochladen nämlich NICHT: Wer direkt
 * nach "Belege/2026/acme" schreibt, bekommt 409 statt eines Ordners.
 *
 * Der Normalfall — der Ordner ist schon da — kostet damit genau eine Anfrage statt
 * eines MKCOL je Ebene.
 *
 * @returns {Promise<string>} der Pfad, ohne führende und doppelte Schrägstriche
 */
async function ordnerSicherstellen(pfad, zugang) {
  const teile = pfadTeile(pfad);
  if (teile.length === 0) return '';
  const z = zugang || await uploadZugang();

  const sicherstellen = async (anzahl) => {
    if (anzahl === 0) return; // das Benutzerverzeichnis selbst gibt es immer
    const teil = teile.slice(0, anzahl).join('/');
    const stand = await davStatus(teil, z);
    if (stand.existiert) {
      if (!stand.istOrdner) throw new Error(`"${teil}" ist eine Datei, kein Ordner.`);
      return;
    }
    await sicherstellen(anzahl - 1);

    const res = await fetch(pfadUrl(webDavUrl(z.url, z.user), teil), {
      method: 'MKCOL',
      headers: kopfAuth(z.user, z.passwort),
      signal: AbortSignal.timeout(20000),
    });
    // 405 heißt "gibt es schon" — jemand war zwischen Nachsehen und Anlegen schneller.
    if (res.ok || res.status === 405) return;
    throw fehlerAus(res.status, `Anlegen von "${teil}"`);
  };

  await sicherstellen(teile.length);
  return teile.join('/');
}

/** Wie ordnerSicherstellen — der alte Name bleibt für Aufrufer und Tests. */
const ordnerAnlegen = (pfad) => ordnerSicherstellen(pfad);

/** Gibt es dort schon etwas? */
async function existiert(pfad, zugang) {
  return (await davStatus(pfad, zugang)).existiert;
}

/**
 * Lädt eine Datei hoch.
 * @param {object} [optionen]
 * @param {boolean} [optionen.nurNeu] nichts überschreiben: Gibt es die Datei schon,
 *   lehnt der Server mit 412 ab (If-None-Match: *) und die Funktion liefert false.
 * @returns {Promise<boolean>} true = hochgeladen, false = gab es schon (nur mit nurNeu)
 */
async function dateiHochladen(pfad, inhalt, mimeType, { nurNeu = false, zugang } = {}) {
  const { url, user, passwort } = zugang || await uploadZugang();
  const res = await fetch(pfadUrl(webDavUrl(url, user), pfad), {
    method: 'PUT',
    headers: {
      ...kopfAuth(user, passwort),
      'Content-Type': mimeType || 'application/octet-stream',
      ...(nurNeu ? { 'If-None-Match': '*' } : {}),
    },
    body: inhalt,
    // 15 Sekunden wie beim Verbindungstest reichen für 30 MB nicht.
    signal: AbortSignal.timeout(120000),
  });
  if (nurNeu && res.status === 412) return false;
  if (!res.ok) throw fehlerAus(res.status, 'Hochladen');
  return true;
}

/**
 * Eine Datei ablegen: Ordner sicherstellen, freien Namen suchen, hochladen.
 *
 * Ein PUT überschreibt stillschweigend, und `Overwrite: F` gilt nur für COPY und
 * MOVE. Deshalb wird vorher nachgesehen und bei Bedarf " (2)" angehängt — das
 * Panel löscht und überschreibt grundsätzlich nichts. Der Upload selbst geht mit
 * `If-None-Match: *` raus: Taucht die Datei zwischen Nachsehen und Hochladen auf,
 * lehnt der Server ab und der nächste Name kommt dran.
 *
 * @returns {Promise<{ok: true, pfad: string, dateiname: string}>}
 */
async function ablegen({ zielpfad, dateiname, inhalt }) {
  const zugang = await uploadZugang();
  const ordner = await ordnerSicherstellen(zielpfad, zugang);
  const endung = (String(dateiname).match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  const rumpf = String(dateiname).slice(0, String(dateiname).length - endung.length);

  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? String(dateiname) : `${rumpf} (${n})${endung}`;
    const voll = ordner ? `${ordner}/${name}` : name;
    if (await existiert(voll, zugang)) continue;
    if (await dateiHochladen(voll, inhalt, typAus(name), { nurNeu: true, zugang })) {
      return { ok: true, pfad: ordner, dateiname: name };
    }
  }
  // Früher wurde hier der letzte Name einfach überschrieben.
  throw new Error(`Kein freier Dateiname für "${dateiname}" gefunden (50 Versuche).`);
}

module.exports = {
  testVerbindung, credentialsAnlegen, webDavUrl,
  ordnerAnlegen, ordnerSicherstellen, davStatus, dateiHochladen, existiert, ablegen, pfadUrl,
  appPasswortPruefen, uploadZugang,
};
