// Die Anordnung der Dashboard-Widgets.
//
// Was hier ankommt, kommt aus dem Browser — und wird am nächsten Tag wieder
// ausgeliefert und ausgeführt. Ungeprüft gespeichert hieße: Wer einmal einen
// Aufruf absetzen kann, bestimmt, was das Dashboard beim nächsten Laden an
// Daten bekommt. Deshalb prüft `saeubern()` in routes/anordnung.js jeden
// Eintrag, und diese Tests halten genau das fest:
//
//  - nur bekannte Felder überleben (alles andere fällt weg),
//  - Zahlen bleiben in ihren Grenzen (keine Breite 9999, kein negatives y),
//  - Kennungen sind kurze, harmlose Namen, Dubletten fliegen raus,
//  - die Liste ist gedeckelt, damit niemand die Datenbank vollschreibt,
//  - und jede Seite hat ihre eigene Anordnung, ohne die andere zu überschreiben.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

const express = require('express');
const db = require('../src/db');

const BENUTZER = 7;

let server;
let port;

before(async () => {
  // Die Anordnung haengt per Fremdschluessel am Benutzer, und better-sqlite3
  // prueft Fremdschluessel — ohne diese Zeile scheitert jedes Speichern mit
  // "FOREIGN KEY constraint failed". Genau daran ist der erste Testlauf
  // gescheitert.
  db.prepare('INSERT OR IGNORE INTO users (id, username, password) VALUES (?, ?, ?)')
    .run(BENUTZER, 'testnutzer', 'nicht-echt');

  const app = express();
  app.use(express.json());
  // Statt echter Anmeldung: ein fester Benutzer. Geprüft wird hier die
  // Verarbeitung der Anordnung, nicht die Anmeldung — die hat eigene Tests.
  app.use('/api/anordnung', (req, _res, weiter) => { req.user = { id: BENUTZER }; weiter(); },
    require('../src/routes/anordnung'));
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

// Speichern und dabei gleich prüfen, dass es geklappt hat. Die Antwort des
// Servers steht in der Meldung — sonst endet ein Fehlschlag in einem Dutzend
// Folgefehlern der Art "Cannot read properties of null", und die eigentliche
// Ursache steht nirgends.
async function speichern(rumpf) {
  const { status, daten } = await ruf('PUT', '/api/anordnung', rumpf);
  assert.equal(status, 200, JSON.stringify(daten));
  return daten;
}

describe('Anordnung der Dashboard-Widgets', () => {
  test('ohne gespeicherte Anordnung kommt null zurück', async () => {
    const { status, daten } = await ruf('GET', '/api/anordnung');
    assert.equal(status, 200);
    assert.equal(daten.layout, null);
  });

  test('speichert und liefert dieselbe Anordnung wieder aus', async () => {
    const layout = [{ i: 'zutun', x: 0, y: 0, w: 8, h: 9, minW: 4, minH: 3 }];
    const gesetzt = await ruf('PUT', '/api/anordnung', { layout });
    // Die Antwort gehoert in die Meldung: Ein blankes "500 !== 200" sagt nicht,
    // woran es lag, und ein Testlauf ohne lokales Node ist ein ganzer Umlauf.
    assert.equal(gesetzt.status, 200, JSON.stringify(gesetzt.daten));
    assert.equal(gesetzt.daten.ok, true);

    const { daten } = await ruf('GET', '/api/anordnung');
    assert.deepEqual(daten.layout, layout);
  });

  test('überschreibt die vorhandene Anordnung, statt eine zweite anzulegen', async () => {
    await speichern({ layout: [{ i: 'betrieb', x: 8, y: 0, w: 4, h: 4 }] });
    const { daten } = await ruf('GET', '/api/anordnung');
    assert.equal(daten.layout.length, 1);
    assert.equal(daten.layout[0].i, 'betrieb');
  });

  test('etwas anderes als eine Liste wird abgewiesen', async () => {
    for (const unfug of [{ layout: 'alles' }, { layout: 42 }, {}]) {
      const { status } = await ruf('PUT', '/api/anordnung', unfug);
      assert.equal(status, 400);
    }
  });

  test('fremde Felder fallen weg, Zahlen bleiben in ihren Grenzen', async () => {
    await speichern({
      layout: [{
        i: 'verlauf', x: -5, y: -1, w: 9999, h: 9999,
        // Nichts davon darf in der Datenbank landen:
        onClick: 'alert(1)', html: '<script>x</script>', gross: 'A'.repeat(5000),
      }],
    });
    const { daten } = await ruf('GET', '/api/anordnung');
    const eintrag = daten.layout[0];
    assert.deepEqual(Object.keys(eintrag).sort(), ['h', 'i', 'minH', 'minW', 'w', 'x', 'y']);
    assert.equal(eintrag.x, 0);          // unter null geklemmt
    assert.equal(eintrag.y, 0);
    assert.equal(eintrag.w, 12);         // auf die Spaltenzahl geklemmt
    assert.equal(eintrag.h, 60);
  });

  test('unbrauchbare Kennungen und Dubletten fliegen raus', async () => {
    await speichern({
      layout: [
        { i: 'zutun', x: 0, y: 0, w: 4, h: 4 },
        { i: 'zutun', x: 4, y: 0, w: 4, h: 4 },          // Dublette
        { i: '../../etc/passwd', x: 0, y: 4, w: 4, h: 4 }, // Pfad
        { i: '', x: 0, y: 8, w: 4, h: 4 },                 // leer
        { i: 'a'.repeat(200), x: 0, y: 12, w: 4, h: 4 },   // zu lang
        { x: 0, y: 16, w: 4, h: 4 },                       // ohne Kennung
      ],
    });
    const { daten } = await ruf('GET', '/api/anordnung');
    assert.equal(daten.layout.length, 1);
    assert.equal(daten.layout[0].i, 'zutun');
    assert.equal(daten.layout[0].x, 0);
  });

  // Ein ausgeblendetes Widget verschwindet nicht aus der Anordnung, es wird nur
  // markiert — sonst wüsste das Panel beim Zurückholen nicht mehr, wo es lag.
  test('die Markierung „ausgeblendet" überlebt', async () => {
    await speichern({
      layout: [
        { i: 'belege', x: 8, y: 4, w: 4, h: 5, versteckt: true },
        { i: 'zutun', x: 0, y: 0, w: 8, h: 9, versteckt: 'ja' },
      ],
    });
    const { daten } = await ruf('GET', '/api/anordnung');
    assert.equal(daten.layout[0].versteckt, true);
    // Nur ein echtes true zählt; alles andere ist kein Ausblenden.
    assert.equal(daten.layout[1].versteckt, undefined);
  });

  test('die Liste ist gedeckelt', async () => {
    const viele = Array.from({ length: 200 }, (_, n) => ({ i: `w${n}`, x: 0, y: n, w: 4, h: 4 }));
    await speichern({ layout: viele });
    const { daten } = await ruf('GET', '/api/anordnung');
    assert.equal(daten.layout.length, 40);
  });

  // Dashboard und Statistik haben eigene Kataloge — eine gemeinsame Zeile wäre
  // für beide die falsche.
  test('jede Seite hat ihre eigene Anordnung', async () => {
    await speichern({ seite: 'dashboard', layout: [{ i: 'zutun', x: 0, y: 0, w: 8, h: 9 }] });
    await speichern({ seite: 'statistik', layout: [{ i: 'domains', x: 0, y: 0, w: 4, h: 7 }] });

    const armaturenbrett = await ruf('GET', '/api/anordnung?seite=dashboard');
    const auswertung = await ruf('GET', '/api/anordnung?seite=statistik');
    assert.equal(armaturenbrett.daten.layout[0].i, 'zutun');
    assert.equal(auswertung.daten.layout[0].i, 'domains');
  });

  test('ohne Angabe ist die Seite das Dashboard', async () => {
    await speichern({ layout: [{ i: 'betrieb', x: 8, y: 0, w: 4, h: 4 }] });
    const { daten } = await ruf('GET', '/api/anordnung?seite=dashboard');
    assert.equal(daten.layout[0].i, 'betrieb');
  });

  test('eine unbekannte Seite wird abgewiesen', async () => {
    const gelesen = await ruf('GET', '/api/anordnung?seite=../../etc');
    assert.equal(gelesen.status, 400);
    const geschrieben = await ruf('PUT', '/api/anordnung', { seite: 'phantasie', layout: [] });
    assert.equal(geschrieben.status, 400);
  });

  test('eine leere Liste bedeutet: zurück zur Standard-Anordnung', async () => {
    const { status } = await ruf('PUT', '/api/anordnung', { layout: [] });
    assert.equal(status, 200);
    const { daten } = await ruf('GET', '/api/anordnung');
    assert.deepEqual(daten.layout, []);
  });
});
