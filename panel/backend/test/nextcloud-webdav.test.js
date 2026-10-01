// Das Panel lädt jetzt selbst hoch — vorher konnte es das nicht.
//
// Bis Build 192 legte dieses Modul nur die n8n-Zugangsdaten an; hochgeladen hat
// der Nextcloud-Knoten in Workflow 07. Mit der Freigabe geht das nicht mehr:
// n8n kann nicht auf einen Menschen warten, also trägt das Panel die Datei
// später selbst hinüber.
//
// WebDAV hat dabei Eigenheiten, die man einmal falsch macht:
//   * Fehlende Zwischenordner legt Nextcloud beim Hochladen NICHT an.
//   * Ein zweites MKCOL auf denselben Ordner antwortet 405 — das ist Erfolg.
//   * PUT überschreibt stillschweigend; "Overwrite: F" gilt nur für COPY/MOVE.
//
// Statt einzelne Antworten zu mocken, läuft hier ein kleiner Fake-Server, der
// Ordner und Dateien wirklich verwaltet. So lässt sich zählen, WAS das Panel
// anfragt — und in welcher Reihenfolge.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const nextcloud = require('../src/services/nextcloud');

const echtesFetch = global.fetch;
const WURZEL = '/remote.php/dav/files/robin';

/**
 * Ein Nextcloud im Arbeitsspeicher.
 * @param {object} o
 * @param {string[]} [o.ordner] vorhandene Ordner (ohne Benutzerverzeichnis)
 * @param {string[]} [o.dateien] vorhandene Dateien
 * @param {'app'|'haupt'|'unklar'|'nein'} [o.passwort] was getapppassword antwortet
 * @param {object} [o.fehler] erzwungene Statuscodes je Methode, z. B. { PUT: 507 }
 */
function fakeNextcloud({ ordner = [], dateien = [], passwort = 'app', fehler = {} } = {}) {
  const ordnerSet = new Set(ordner);
  const dateiSet = new Set(dateien);
  const aufrufe = [];
  let tokenAusgestellt = false;
  let tokenWiderrufen = false;

  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const methode = init.method || 'GET';
    const kopf = init.headers || {};
    aufrufe.push({ url: String(url), methode, headers: kopf, body: init.body, pfad: u.pathname });
    const antwort = (status, text = '', json) => ({
      ok: status >= 200 && status < 300, status, text: async () => text, json: async () => json,
    });

    if (u.pathname === '/ocs/v2.php/core/getapppassword') {
      if (passwort === 'nein') return antwort(401);
      if (passwort === 'unklar') return antwort(404);
      if (passwort === 'app') return antwort(403);
      tokenAusgestellt = true;
      return antwort(200, '', { ocs: { data: { apppassword: 'frisches-token' } } });
    }
    if (u.pathname === '/ocs/v2.php/core/apppassword' && methode === 'DELETE') {
      // Der Widerruf muss mit dem NEUEN Token beglaubigt sein.
      const erwartet = 'Basic ' + Buffer.from('robin:frisches-token').toString('base64');
      if (kopf.Authorization !== erwartet) return antwort(401);
      tokenWiderrufen = true;
      return antwort(200);
    }

    if (fehler[methode]) return antwort(fehler[methode]);
    if (!u.pathname.startsWith(`${WURZEL}/`)) return antwort(404);

    const rel = decodeURIComponent(u.pathname.slice(WURZEL.length + 1)).replace(/\/$/, '');
    const eltern = rel.split('/').slice(0, -1).join('/');
    const elternDa = eltern === '' || ordnerSet.has(eltern);

    if (methode === 'PROPFIND') {
      if (rel === '' || ordnerSet.has(rel)) {
        return antwort(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>'
          + '<d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>');
      }
      if (dateiSet.has(rel)) {
        return antwort(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>'
          + '<d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>');
      }
      return antwort(404);
    }
    if (methode === 'MKCOL') {
      if (ordnerSet.has(rel) || dateiSet.has(rel)) return antwort(405);
      if (!elternDa) return antwort(409); // genau das passiert ohne rekursives Anlegen
      ordnerSet.add(rel);
      return antwort(201);
    }
    if (methode === 'PUT') {
      if (!elternDa) return antwort(409);
      if (kopf['If-None-Match'] === '*' && dateiSet.has(rel)) return antwort(412);
      dateiSet.add(rel);
      return antwort(201);
    }
    return antwort(405);
  };

  return {
    aufrufe, ordner: ordnerSet, dateien: dateiSet,
    von: (methode) => aufrufe.filter((a) => a.methode === methode),
    get tokenAusgestellt() { return tokenAusgestellt; },
    get tokenWiderrufen() { return tokenWiderrufen; },
  };
}

beforeEach(() => {
  settings.setze('nextcloud_url', 'https://wolke.example');
  settings.setze('nextcloud_user', 'robin');
  settings.setze('nextcloud_passwort', 'app-passwort');
  // Sonst hielte der Merker einer früheren Prüfung die nächste Prüfung ab.
  db.prepare("DELETE FROM settings WHERE key = 'nextcloud_app_passwort_ok'").run();
});

afterEach(() => { global.fetch = echtesFetch; });

describe('Ordner sicherstellen', () => {
  test('ein vorhandener Ordner kostet genau eine Anfrage — kein MKCOL', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege', 'Belege/2026', 'Belege/2026/acme'] });
    await nextcloud.ordnerSicherstellen('Belege/2026/acme');
    assert.equal(nc.von('PROPFIND').length, 1, 'ein Blick auf den Zielordner genügt');
    assert.equal(nc.von('MKCOL').length, 0);
  });

  test('nur die fehlenden Ebenen werden angelegt, von oben nach unten', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege'] });
    const r = await nextcloud.ordnerSicherstellen('Belege/2026/acme');

    assert.equal(r, 'Belege/2026/acme');
    const mkcol = nc.von('MKCOL').map((a) => a.pfad);
    assert.deepEqual(mkcol, [`${WURZEL}/Belege/2026`, `${WURZEL}/Belege/2026/acme`],
      '"Belege" gab es schon; "2026" muss vor "acme" kommen, sonst antwortet Nextcloud mit 409');
    assert.ok(nc.ordner.has('Belege/2026/acme'));
  });

  test('ein komplett neuer Pfad entsteht Ebene für Ebene', async () => {
    const nc = fakeNextcloud();
    await nextcloud.ordnerSicherstellen('Belege/2026/acme');
    assert.deepEqual(nc.von('MKCOL').map((a) => a.pfad),
      [`${WURZEL}/Belege`, `${WURZEL}/Belege/2026`, `${WURZEL}/Belege/2026/acme`]);
  });

  test('geprüft wird VOR dem Anlegen: jedes MKCOL folgt auf ein PROPFIND der Ebene', async () => {
    const nc = fakeNextcloud();
    await nextcloud.ordnerSicherstellen('A/B');
    const folge = nc.aufrufe.filter((a) => a.pfad.startsWith(WURZEL)).map((a) => `${a.methode} ${a.pfad.slice(WURZEL.length)}`);
    assert.deepEqual(folge, [
      'PROPFIND /A/B', 'PROPFIND /A', 'MKCOL /A', 'MKCOL /A/B',
    ]);
  });

  test('405 beim Anlegen heißt „gibt es schon" und ist kein Fehler', async () => {
    // Zwischen Nachsehen (404) und Anlegen war jemand schneller.
    const nc = fakeNextcloud();
    const echt = global.fetch;
    let erstes = true;
    global.fetch = async (url, init = {}) => {
      if (init.method === 'MKCOL' && erstes) { erstes = false; return { ok: false, status: 405, text: async () => '' }; }
      return echt(url, init);
    };
    await assert.doesNotReject(() => nextcloud.ordnerSicherstellen('Belege'));
    assert.ok(nc.aufrufe.length > 0);
  });

  test('ist der Pfad eine Datei, wird das gemeldet', async () => {
    fakeNextcloud({ dateien: ['Belege'] });
    await assert.rejects(() => nextcloud.ordnerSicherstellen('Belege/2026'), /ist eine Datei, kein Ordner/);
  });

  test('401 nennt das App-Passwort', async () => {
    fakeNextcloud({ fehler: { PROPFIND: 401 } });
    await assert.rejects(() => nextcloud.ordnerSicherstellen('Belege'), /App-Passwort/);
  });

  test('ein echter Fehler fliegt', async () => {
    fakeNextcloud({ fehler: { MKCOL: 500 } });
    await assert.rejects(() => nextcloud.ordnerSicherstellen('Belege'), /500/);
  });

  test('der alte Name ordnerAnlegen tut dasselbe', async () => {
    const nc = fakeNextcloud();
    await nextcloud.ordnerAnlegen('Belege/2026');
    assert.ok(nc.ordner.has('Belege/2026'));
  });

  test('die Zugangsdaten gehen als Basic-Auth mit', async () => {
    const nc = fakeNextcloud();
    await nextcloud.ordnerSicherstellen('Belege');
    const erwartet = 'Basic ' + Buffer.from('robin:app-passwort').toString('base64');
    for (const a of nc.aufrufe) assert.equal(a.headers.Authorization, erwartet);
  });

  test('ohne eingerichtete Nextcloud wird das gesagt', async () => {
    settings.setze('nextcloud_passwort', '');
    fakeNextcloud();
    await assert.rejects(() => nextcloud.ordnerSicherstellen('Belege'), /nicht eingerichtet/);
  });

  test('ein leerer Pfad ist das Benutzerverzeichnis und braucht nichts', async () => {
    const nc = fakeNextcloud();
    assert.equal(await nextcloud.ordnerSicherstellen(''), '');
    assert.equal(nc.von('MKCOL').length, 0);
  });
});

describe('Pfade', () => {
  test('jedes Segment wird einzeln kodiert, der Schrägstrich nicht', () => {
    const url = nextcloud.pfadUrl('https://wolke.example/dav', 'Belege/A & B/Rechnung Nr 5.pdf');
    assert.match(url, /\/Belege\/A%20%26%20B\/Rechnung%20Nr%205\.pdf$/);
    assert.ok(!url.includes('%2F'), 'sonst wird aus dem Pfad ein einziger Ordnername');
  });

  // `fetch` löst ".." beim Bilden der Adresse selbst auf: Aus
  // ".../files/robin/Belege/../../anna/x" würde ".../files/anna/x" — der Upload
  // ginge in den Bereich eines ANDEREN Benutzers.
  test('ein ".." wird abgewiesen, nicht stillschweigend aufgelöst', () => {
    for (const pfad of ['..', '../x', 'Belege/..', 'Belege/../../anna/x', './x', 'a/./b']) {
      assert.throws(() => nextcloud.pfadUrl('https://wolke.example/dav', pfad), /Unzulässiger Pfadteil/, pfad);
    }
  });

  test('Steuerzeichen und Rückwärtsschrägstrich werden abgewiesen', () => {
    for (const pfad of ['a\u0000b', 'a\\b', 'a\nb', 'a\u007Fb']) {
      assert.throws(() => nextcloud.pfadUrl('https://wolke.example/dav', pfad), /Unzulässiger Pfadteil/);
    }
  });

  test('ein vorkodiertes "%2e%2e" bleibt ein gewöhnlicher Name', () => {
    const url = nextcloud.pfadUrl('https://wolke.example/dav/files/robin', 'Belege/%2e%2e/x');
    assert.match(url, /\/Belege\/%252e%252e\/x$/, 'das Prozentzeichen wird mit kodiert');
    assert.ok(new URL(url).pathname.startsWith('/dav/files/robin/'));
  });

  test('jede erzeugte Adresse bleibt unter der Wurzel', () => {
    const wurzel = 'https://wolke.example/nextcloud/remote.php/dav/files/robin';
    for (const pfad of ['', 'a', 'a/b/c', 'Müller & Söhne/Rechnung #5.pdf', '%2e%2e/%2f', 'a b/c d']) {
      const a = new URL(nextcloud.pfadUrl(wurzel, pfad));
      assert.ok(a.pathname.startsWith('/nextcloud/remote.php/dav/files/robin/'), a.pathname);
    }
  });

  test('ein ".." kommt auch über ablegen() nicht durch', async () => {
    const nc = fakeNextcloud();
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'Belege/../../anna', dateiname: 'x.pdf', inhalt: Buffer.from('x') }),
      /Unzulässiger Pfadteil/,
    );
    assert.equal(nc.von('PUT').length, 0, 'es darf nichts hochgeladen werden');
    assert.equal(nc.von('MKCOL').length, 0, 'und nichts angelegt');
  });

  test('ein Dateiname ".." kommt nicht durch', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege'] });
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'Belege', dateiname: '..', inhalt: Buffer.from('x') }),
      /Unzulässiger Pfadteil/,
    );
    assert.equal(nc.von('PUT').length, 0);
  });
});

describe('Ablegen', () => {
  test('legt den Ordner an und lädt dann hoch', async () => {
    const nc = fakeNextcloud();
    const r = await nextcloud.ablegen({
      zielpfad: 'Belege/2026',
      dateiname: 'Rechnung.pdf',
      inhalt: Buffer.from('%PDF'),
    });

    assert.equal(r.ok, true);
    assert.equal(r.dateiname, 'Rechnung.pdf');
    assert.equal(r.pfad, 'Belege/2026');
    const put = nc.von('PUT')[0];
    assert.ok(put, 'ohne PUT liegt nichts in der Nextcloud');
    assert.match(put.url, /\/Belege\/2026\/Rechnung\.pdf$/);
    assert.equal(put.headers['Content-Type'], 'application/pdf');
    assert.ok(Buffer.isBuffer(put.body));
    assert.ok(nc.dateien.has('Belege/2026/Rechnung.pdf'));
  });

  // Das Panel überschreibt und löscht grundsätzlich nichts.
  test('eine vorhandene Datei wird nicht überschrieben, sondern nummeriert', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege'], dateien: ['Belege/Rechnung.pdf'] });
    const r = await nextcloud.ablegen({ zielpfad: 'Belege', dateiname: 'Rechnung.pdf', inhalt: Buffer.from('%PDF') });

    assert.equal(r.dateiname, 'Rechnung (2).pdf');
    assert.match(nc.von('PUT')[0].url, /Rechnung%20\(2\)\.pdf$/);
    assert.ok(nc.dateien.has('Belege/Rechnung.pdf'), 'das Original bleibt');
  });

  test('der Upload geht mit If-None-Match: * — der Server selbst verbietet das Überschreiben', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege'] });
    await nextcloud.ablegen({ zielpfad: 'Belege', dateiname: 'a.pdf', inhalt: Buffer.from('x') });
    assert.equal(nc.von('PUT')[0].headers['If-None-Match'], '*');
  });

  // Zwischen Nachsehen und Hochladen kann dieselbe Datei auftauchen (zwei
  // Freigaben gleichzeitig, ein Sync-Client). Ohne die Bedingung wäre sie weg.
  test('taucht die Datei zwischen Nachsehen und Hochladen auf, kommt der nächste Name dran', async () => {
    const nc = fakeNextcloud({ ordner: ['Belege'] });
    const echt = global.fetch;
    let erstesPropfindAufDatei = true;
    global.fetch = async (url, init = {}) => {
      if (init.method === 'PROPFIND' && String(url).endsWith('/Rechnung.pdf') && erstesPropfindAufDatei) {
        erstesPropfindAufDatei = false;
        nc.dateien.add('Belege/Rechnung.pdf'); // erscheint NACH der Antwort „404"
        return { ok: false, status: 404, text: async () => '' };
      }
      return echt(url, init);
    };

    const r = await nextcloud.ablegen({ zielpfad: 'Belege', dateiname: 'Rechnung.pdf', inhalt: Buffer.from('neu') });
    assert.equal(r.dateiname, 'Rechnung (2).pdf');
    assert.ok(nc.dateien.has('Belege/Rechnung.pdf') && nc.dateien.has('Belege/Rechnung (2).pdf'));
  });

  test('sind 50 Namen belegt, fliegt ein Fehler — nichts wird überschrieben', async () => {
    const belegt = ['Belege/a.pdf', ...Array.from({ length: 49 }, (_, i) => `Belege/a (${i + 2}).pdf`)];
    const nc = fakeNextcloud({ ordner: ['Belege'], dateien: belegt });
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'Belege', dateiname: 'a.pdf', inhalt: Buffer.from('x') }),
      /Kein freier Dateiname/,
    );
    assert.equal(nc.von('PUT').length, 0);
  });

  test('der Inhaltstyp folgt der Endung', async () => {
    const nc = fakeNextcloud({ ordner: ['X'] });
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'bild.png', inhalt: Buffer.from('x') });
    assert.equal(nc.von('PUT')[0].headers['Content-Type'], 'image/png');
  });

  test('Unbekanntes geht als Oktett-Strom', async () => {
    const nc = fakeNextcloud({ ordner: ['X'] });
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'datei.xyz', inhalt: Buffer.from('x') });
    assert.equal(nc.von('PUT')[0].headers['Content-Type'], 'application/octet-stream');
  });

  test('scheitert das Hochladen, fliegt der Fehler nach oben', async () => {
    fakeNextcloud({ ordner: ['X'], fehler: { PUT: 507 } }); // Speicher voll
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'X', dateiname: 'a.pdf', inhalt: Buffer.from('x') }),
      /507/,
      'der Aufrufer muss den Eintrag offen lassen können',
    );
  });
});

describe('Nur ein App-Passwort', () => {
  test('ein App-Passwort (403) geht durch und wird gemerkt', async () => {
    const nc = fakeNextcloud({ passwort: 'app', ordner: ['X'] });
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'a.pdf', inhalt: Buffer.from('x') });
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'b.pdf', inhalt: Buffer.from('x') });
    const pruefungen = nc.aufrufe.filter((a) => a.pfad === '/ocs/v2.php/core/getapppassword');
    assert.equal(pruefungen.length, 1, 'nur beim ersten Mal — nicht bei jedem Upload');
  });

  test('das Hauptpasswort wird abgewiesen, und es wird NICHTS hochgeladen', async () => {
    const nc = fakeNextcloud({ passwort: 'haupt', ordner: ['X'] });
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'X', dateiname: 'a.pdf', inhalt: Buffer.from('x') }),
      /App-Passwort/,
    );
    assert.equal(nc.von('PUT').length, 0);
    assert.equal(nc.von('MKCOL').length, 0);
    assert.equal(nc.von('PROPFIND').length, 0, 'nicht einmal nachgesehen');
  });

  test('das dabei ausgestellte Token wird sofort widerrufen', async () => {
    const nc = fakeNextcloud({ passwort: 'haupt' });
    await assert.rejects(() => nextcloud.appPasswortPruefen(), /App-Passwort/);
    assert.equal(nc.tokenAusgestellt, true, 'die Prüfung selbst stellt eines aus');
    assert.equal(nc.tokenWiderrufen, true, 'und lässt es nicht zurück');
  });

  test('das Hauptpasswort wird nicht als „geprüft" gemerkt', async () => {
    fakeNextcloud({ passwort: 'haupt' });
    await assert.rejects(() => nextcloud.appPasswortPruefen());
    assert.equal(settings.hole('nextcloud_app_passwort_ok'), '');
  });

  test('ein Wechsel des Passworts löst eine neue Prüfung aus', async () => {
    const nc = fakeNextcloud({ passwort: 'app' });
    await nextcloud.appPasswortPruefen();
    settings.setze('nextcloud_passwort', 'ein-anderes');
    await nextcloud.appPasswortPruefen();
    assert.equal(nc.aufrufe.filter((a) => a.pfad === '/ocs/v2.php/core/getapppassword').length, 2);
  });

  test('401: falsche Zugangsdaten', async () => {
    fakeNextcloud({ passwort: 'nein' });
    await assert.rejects(() => nextcloud.appPasswortPruefen(), /Anmeldung abgelehnt/);
  });

  test('unklare Antwort (404): im Zweifel nichts hochladen, und nichts merken', async () => {
    const nc = fakeNextcloud({ passwort: 'unklar', ordner: ['X'] });
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'X', dateiname: 'a.pdf', inhalt: Buffer.from('x') }),
      /ließ sich nicht prüfen/,
    );
    assert.equal(nc.von('PUT').length, 0);
    assert.equal(settings.hole('nextcloud_app_passwort_ok'), '');
  });

  test('Nextcloud nicht erreichbar: ebenfalls kein Upload', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(() => nextcloud.appPasswortPruefen(), /nicht erreichbar/);
  });

  test('n8n bekommt kein Hauptpasswort: credentialsAnlegen bricht vorher ab', async () => {
    fakeNextcloud({ passwort: 'haupt' });
    await assert.rejects(() => nextcloud.credentialsAnlegen(), /App-Passwort/);
  });

  test('der Verbindungstest meldet es dem Nutzer', async () => {
    fakeNextcloud({ passwort: 'haupt' });
    await assert.rejects(() => nextcloud.testVerbindung(), /Persönliche Einstellungen/);
  });

  test('die Prüfung verlangt den OCS-Kopf und fragt nie ohne Anmeldung', async () => {
    const nc = fakeNextcloud({ passwort: 'app' });
    await nextcloud.appPasswortPruefen();
    const a = nc.aufrufe.find((x) => x.pfad === '/ocs/v2.php/core/getapppassword');
    assert.equal(a.headers['OCS-APIRequest'], 'true');
    assert.match(a.headers.Authorization, /^Basic /);
  });
});
