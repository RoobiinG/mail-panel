// Die Anordnung der Dashboard-Widgets.
//
// Was hier ankommt, kommt aus dem Browser — und wird am nächsten Tag wieder
// ausgeliefert und ausgeführt. Ungeprüft gespeichert hieße: Wer einmal einen
// Aufruf absetzen kann, bestimmt, was das Dashboard beim nächsten Laden an
// Daten bekommt. Deshalb prüft `saeubern()` in routes/dashboard.js jeden
// Eintrag, und diese Tests halten genau das fest:
//
//  - nur bekannte Felder überleben (alles andere fällt weg),
//  - Zahlen bleiben in ihren Grenzen (keine Breite 9999, kein negatives y),
//  - Kennungen sind kurze, harmlose Namen, Dubletten fliegen raus,
//  - die Liste ist gedeckelt, damit niemand die Datenbank vollschreibt.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

const express = require('express');
require('../src/db');

let server;
let port;

before(async () => {
  const app = express();
  app.use(express.json());
  // Statt echter Anmeldung: ein fester Benutzer. Geprüft wird hier die
  // Verarbeitung der Anordnung, nicht die Anmeldung — die hat eigene Tests.
  app.use('/api/dashboard', (req, _res, weiter) => { req.user = { id: 7 }; weiter(); },
    require('../src/routes/dashboard'));
  await new Promise((fertig) => {
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; fertig(); });
  });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function ruf(methode, pfad, rumpf) {
  return new Promise((fertig, schief) => {
    const text = rumpf === undefined ? null : JSON.stringify(rumpf);
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: methode,
      headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {},
    }, (res) => {
      let roh = '';
      res.on('data', (t) => { roh += t; });
      res.on('end', () => {
        try { fertig({ status: res.statusCode, daten: JSON.parse(roh || '{}') }); }
        catch (err) { schief(err); }
      });
    });
    a.on('error', schief);
    if (text) a.write(text);
    a.end();
  });
}

describe('Anordnung der Dashboard-Widgets', () => {
  test('ohne gespeicherte Anordnung kommt null zurück', async () => {
    const { status, daten } = await ruf('GET', '/api/dashboard/layout');
    assert.equal(status, 200);
    assert.equal(daten.layout, null);
  });

  test('speichert und liefert dieselbe Anordnung wieder aus', async () => {
    const layout = [{ i: 'zutun', x: 0, y: 0, w: 8, h: 9, minW: 4, minH: 3 }];
    const gesetzt = await ruf('PUT', '/api/dashboard/layout', { layout });
    assert.equal(gesetzt.status, 200);
    assert.equal(gesetzt.daten.ok, true);

    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.deepEqual(daten.layout, layout);
  });

  test('überschreibt die vorhandene Anordnung, statt eine zweite anzulegen', async () => {
    await ruf('PUT', '/api/dashboard/layout', { layout: [{ i: 'betrieb', x: 8, y: 0, w: 4, h: 4 }] });
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.equal(daten.layout.length, 1);
    assert.equal(daten.layout[0].i, 'betrieb');
  });

  test('etwas anderes als eine Liste wird abgewiesen', async () => {
    for (const unfug of [{ layout: 'alles' }, { layout: 42 }, {}]) {
      const { status } = await ruf('PUT', '/api/dashboard/layout', unfug);
      assert.equal(status, 400);
    }
  });

  test('fremde Felder fallen weg, Zahlen bleiben in ihren Grenzen', async () => {
    await ruf('PUT', '/api/dashboard/layout', {
      layout: [{
        i: 'verlauf', x: -5, y: -1, w: 9999, h: 9999,
        // Nichts davon darf in der Datenbank landen:
        onClick: 'alert(1)', html: '<script>x</script>', gross: 'A'.repeat(5000),
      }],
    });
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    const eintrag = daten.layout[0];
    assert.deepEqual(Object.keys(eintrag).sort(), ['h', 'i', 'minH', 'minW', 'w', 'x', 'y']);
    assert.equal(eintrag.x, 0);          // unter null geklemmt
    assert.equal(eintrag.y, 0);
    assert.equal(eintrag.w, 12);         // auf die Spaltenzahl geklemmt
    assert.equal(eintrag.h, 60);
  });

  test('unbrauchbare Kennungen und Dubletten fliegen raus', async () => {
    await ruf('PUT', '/api/dashboard/layout', {
      layout: [
        { i: 'zutun', x: 0, y: 0, w: 4, h: 4 },
        { i: 'zutun', x: 4, y: 0, w: 4, h: 4 },          // Dublette
        { i: '../../etc/passwd', x: 0, y: 4, w: 4, h: 4 }, // Pfad
        { i: '', x: 0, y: 8, w: 4, h: 4 },                 // leer
        { i: 'a'.repeat(200), x: 0, y: 12, w: 4, h: 4 },   // zu lang
        { x: 0, y: 16, w: 4, h: 4 },                       // ohne Kennung
      ],
    });
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.equal(daten.layout.length, 1);
    assert.equal(daten.layout[0].i, 'zutun');
    assert.equal(daten.layout[0].x, 0);
  });

  // Ein ausgeblendetes Widget verschwindet nicht aus der Anordnung, es wird nur
  // markiert — sonst wüsste das Panel beim Zurückholen nicht mehr, wo es lag.
  test('die Markierung „ausgeblendet" überlebt', async () => {
    await ruf('PUT', '/api/dashboard/layout', {
      layout: [
        { i: 'belege', x: 8, y: 4, w: 4, h: 5, versteckt: true },
        { i: 'zutun', x: 0, y: 0, w: 8, h: 9, versteckt: 'ja' },
      ],
    });
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.equal(daten.layout[0].versteckt, true);
    // Nur ein echtes true zählt; alles andere ist kein Ausblenden.
    assert.equal(daten.layout[1].versteckt, undefined);
  });

  test('die Liste ist gedeckelt', async () => {
    const viele = Array.from({ length: 200 }, (_, n) => ({ i: `w${n}`, x: 0, y: n, w: 4, h: 4 }));
    await ruf('PUT', '/api/dashboard/layout', { layout: viele });
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.equal(daten.layout.length, 40);
  });

  test('eine leere Liste bedeutet: zurück zur Standard-Anordnung', async () => {
    const { status } = await ruf('PUT', '/api/dashboard/layout', { layout: [] });
    assert.equal(status, 200);
    const { daten } = await ruf('GET', '/api/dashboard/layout');
    assert.deepEqual(daten.layout, []);
  });
});
