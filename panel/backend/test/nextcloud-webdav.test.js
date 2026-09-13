// Das Panel lädt jetzt selbst hoch — vorher konnte es das nicht.
//
// Bis Build 192 legte dieses Modul nur die n8n-Zugangsdaten an; hochgeladen hat
// der Nextcloud-Knoten in Workflow 07. Mit der Freigabe geht das nicht mehr:
// n8n kann nicht auf einen Menschen warten, also trägt das Panel die Datei
// später selbst hinüber.
//
// WebDAV hat dabei drei Eigenheiten, die man einmal falsch macht:
//   * Fehlende Zwischenordner legt Nextcloud beim Hochladen NICHT an.
//   * Ein zweites MKCOL auf denselben Ordner antwortet 405 — das ist Erfolg.
//   * PUT überschreibt stillschweigend; "Overwrite: F" gilt nur für COPY/MOVE.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const nextcloud = require('../src/services/nextcloud');

const echtesFetch = global.fetch;

// Nimmt jeden Aufruf auf und antwortet nach Vorgabe.
function fetchMit(antwort) {
  const aufrufe = [];
  global.fetch = async (url, init = {}) => {
    aufrufe.push({ url: String(url), methode: init.method, headers: init.headers || {}, body: init.body });
    const a = antwort(String(url), init.method) || {};
    return { ok: a.status ? a.status < 400 : true, status: a.status || 200, text: async () => '' };
  };
  return aufrufe;
}

beforeEach(() => {
  settings.setze('nextcloud_url', 'https://wolke.example');
  settings.setze('nextcloud_user', 'robin');
  settings.setze('nextcloud_passwort', 'app-passwort');
});

afterEach(() => { global.fetch = echtesFetch; });

describe('Ordner anlegen', () => {
  test('eine Ebene nach der anderen, von oben nach unten', async () => {
    const aufrufe = fetchMit(() => ({ status: 201 }));
    await nextcloud.ordnerAnlegen('Belege/2026/acme');

    const mkcol = aufrufe.filter((a) => a.methode === 'MKCOL').map((a) => a.url);
    assert.equal(mkcol.length, 3, 'Nextcloud legt Zwischenordner nicht von selbst an');
    assert.match(mkcol[0], /\/Belege$/);
    assert.match(mkcol[1], /\/Belege\/2026$/);
    assert.match(mkcol[2], /\/Belege\/2026\/acme$/);
  });

  test('405 heißt „gibt es schon" und ist kein Fehler', async () => {
    fetchMit(() => ({ status: 405 }));
    await assert.doesNotReject(() => nextcloud.ordnerAnlegen('Belege/2026'),
      'ab dem zweiten Beleg ist das der Normalfall');
  });

  test('401 nennt das App-Passwort', async () => {
    fetchMit(() => ({ status: 401 }));
    await assert.rejects(() => nextcloud.ordnerAnlegen('Belege'), /App-Passwort/);
  });

  test('ein echter Fehler fliegt', async () => {
    fetchMit(() => ({ status: 500 }));
    await assert.rejects(() => nextcloud.ordnerAnlegen('Belege'), /500/);
  });

  test('die Zugangsdaten gehen als Basic-Auth mit', async () => {
    const aufrufe = fetchMit(() => ({ status: 201 }));
    await nextcloud.ordnerAnlegen('Belege');
    const erwartet = 'Basic ' + Buffer.from('robin:app-passwort').toString('base64');
    assert.equal(aufrufe[0].headers.Authorization, erwartet);
  });

  test('ohne eingerichtete Nextcloud wird das gesagt', async () => {
    settings.setze('nextcloud_passwort', '');
    await assert.rejects(() => nextcloud.ordnerAnlegen('Belege'), /nicht eingerichtet/);
  });
});

describe('Pfade', () => {
  test('jedes Segment wird einzeln kodiert, der Schrägstrich nicht', () => {
    const url = nextcloud.pfadUrl('https://wolke.example/dav', 'Belege/A & B/Rechnung Nr 5.pdf');
    assert.match(url, /\/Belege\/A%20%26%20B\/Rechnung%20Nr%205\.pdf$/);
    assert.ok(!url.includes('%2F'), 'sonst wird aus dem Pfad ein einziger Ordnername');
  });
});

describe('Ablegen', () => {
  test('legt den Ordner an und lädt dann hoch', async () => {
    const aufrufe = fetchMit((url, methode) => {
      if (methode === 'HEAD') return { status: 404 };  // noch nichts da
      return { status: 201 };
    });

    const r = await nextcloud.ablegen({
      zielpfad: 'Belege/2026',
      dateiname: 'Rechnung.pdf',
      inhalt: Buffer.from('%PDF'),
    });

    assert.equal(r.ok, true);
    assert.equal(r.dateiname, 'Rechnung.pdf');
    const put = aufrufe.find((a) => a.methode === 'PUT');
    assert.ok(put, 'ohne PUT liegt nichts in der Nextcloud');
    assert.match(put.url, /\/Belege\/2026\/Rechnung\.pdf$/);
    assert.equal(put.headers['Content-Type'], 'application/pdf');
    assert.ok(Buffer.isBuffer(put.body));
  });

  // Das Panel überschreibt und löscht grundsätzlich nichts.
  test('eine vorhandene Datei wird nicht überschrieben, sondern nummeriert', async () => {
    let gesehen = 0;
    const aufrufe = fetchMit((url, methode) => {
      if (methode === 'HEAD') {
        gesehen += 1;
        return { status: gesehen === 1 ? 200 : 404 }; // die erste existiert schon
      }
      return { status: 201 };
    });

    const r = await nextcloud.ablegen({
      zielpfad: 'Belege',
      dateiname: 'Rechnung.pdf',
      inhalt: Buffer.from('%PDF'),
    });

    assert.equal(r.dateiname, 'Rechnung (2).pdf');
    assert.match(aufrufe.find((a) => a.methode === 'PUT').url, /Rechnung%20\(2\)\.pdf$/);
  });

  test('der Inhaltstyp folgt der Endung', async () => {
    const aufrufe = fetchMit((url, methode) => ({ status: methode === 'HEAD' ? 404 : 201 }));
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'bild.png', inhalt: Buffer.from('x') });
    assert.equal(aufrufe.find((a) => a.methode === 'PUT').headers['Content-Type'], 'image/png');
  });

  test('Unbekanntes geht als Oktett-Strom', async () => {
    const aufrufe = fetchMit((url, methode) => ({ status: methode === 'HEAD' ? 404 : 201 }));
    await nextcloud.ablegen({ zielpfad: 'X', dateiname: 'datei.xyz', inhalt: Buffer.from('x') });
    assert.equal(aufrufe.find((a) => a.methode === 'PUT').headers['Content-Type'], 'application/octet-stream');
  });

  test('scheitert das Hochladen, fliegt der Fehler nach oben', async () => {
    fetchMit((url, methode) => {
      if (methode === 'HEAD') return { status: 404 };
      if (methode === 'PUT') return { status: 507 };   // Speicher voll
      return { status: 201 };
    });
    await assert.rejects(
      () => nextcloud.ablegen({ zielpfad: 'X', dateiname: 'a.pdf', inhalt: Buffer.from('x') }),
      /507/,
      'der Aufrufer muss den Eintrag offen lassen können',
    );
  });
});
