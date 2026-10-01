// Der letzte Fehlerhandler von Express: Wer ist schuld, der Aufrufer oder das Panel?
//
// Bis Build 252 wurde JEDER Fehler zu einem 500 — auch das saubere 413 des
// Body-Parsers bei einem zu großen Rumpf und das 400 bei kaputtem JSON. Für die
// harten Grenzen bei Anhängen (30 MB) ist das falsch: Ein zu großer Anhang ist
// kein Serverfehler, und der Aufrufer soll am Statuscode erkennen, dass eine
// Wiederholung nichts ändert.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

const express = require('express');
const { expressErrorHandler } = require('../src/services/panelLog');
const db = require('../src/db');

let server;
let port;

before(async () => {
  const app = express();
  app.post('/json', express.json({ limit: '1kb' }), (req, res) => res.json({ ok: true }));
  app.get('/kaputt', () => { throw new Error('Datenbank ist weg: Passwort=geheim123'); });
  app.get('/teilweise', (req, res) => {
    res.write('{"anfang":');
    setTimeout(() => res.destroy(new Error('mittendrin')), 5);
  });
  app.get('/verboten', () => { const e = new Error('nicht erlaubt'); e.status = 403; throw e; });
  app.use(expressErrorHandler);
  await new Promise((fertig) => { server = app.listen(0, () => { port = server.address().port; fertig(); }); });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function anfrage(methode, pfad, rumpf) {
  return new Promise((fertig, schief) => {
    const daten = rumpf ?? '';
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: methode,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(daten) },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* kein JSON */ }
        fertig({ status: r.statusCode, json, text: t });
      });
      r.on('error', () => fertig({ status: r.statusCode, json: null, text: '' }));
    });
    a.on('error', schief);
    a.end(daten);
  });
}

const logZeilen = (muster) => db.prepare('SELECT level, nachricht FROM panel_logs WHERE nachricht LIKE ? ORDER BY id DESC').all(muster);

describe('Fehler des Aufrufers behalten ihren Statuscode', () => {
  test('ein zu großer Rumpf: 413, nicht 500', async () => {
    const r = await anfrage('POST', '/json', JSON.stringify({ x: 'a'.repeat(5000) }));
    assert.equal(r.status, 413);
    assert.equal(r.json.error, 'Die Anfrage ist zu groß.');
  });

  test('kaputtes JSON: 400, nicht 500', async () => {
    const r = await anfrage('POST', '/json', '{"kaputt":');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Die Anfrage ist ungültig.');
  });

  test('ein anderer 4xx-Status bleibt erhalten, mit allgemeinem Text', async () => {
    const r = await anfrage('GET', '/verboten');
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Anfrage abgelehnt.');
    assert.ok(!r.text.includes('nicht erlaubt'), 'die interne Meldung geht nicht nach draußen');
  });

  test('ein Client-Fehler steht als Warnung im Panel-Log, nicht als Fehler', async () => {
    await anfrage('POST', '/json', JSON.stringify({ x: 'b'.repeat(5000) }));
    const z = logZeilen('%too large%')[0];
    assert.ok(z, 'der Fehler muss im Log auftauchen — sonst bleibt unsichtbar, warum ein Lauf nichts erreicht');
    assert.equal(z.level, 'warn');
  });
});

describe('Fehler des Panels bleiben 500 — ohne Einzelheiten nach draußen', () => {
  test('ein gewöhnlicher Fehler: 500 mit allgemeinem Text', async () => {
    const r = await anfrage('GET', '/kaputt');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'Interner Serverfehler' });
    assert.ok(!r.text.includes('geheim123'), 'weder Meldung noch Stack dürfen an den Aufrufer');
  });

  test('im Log steht der Fehler als Fehler, mit Stack', async () => {
    await anfrage('GET', '/kaputt');
    const z = logZeilen('%Datenbank ist weg%')[0];
    assert.equal(z.level, 'error');
  });

  test('hat die Antwort schon begonnen, stürzt der Handler nicht ab', async () => {
    const r = await anfrage('GET', '/teilweise');
    // Die Verbindung wurde mittendrin abgebrochen — wichtig ist, dass der Server danach noch antwortet.
    assert.ok(r.status === 200 || r.status === undefined);
    const danach = await anfrage('POST', '/json', '{}');
    assert.equal(danach.status, 200);
  });
});
