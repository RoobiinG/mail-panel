// Warum ein Lauf gescheitert ist, hing bisher an einer Zahl, die niemand sah.
//
// In der n8n-Liste standen nebeneinander: Fehlschlaege nach vier Minuten und
// Fehlschlaege nach 63 Millisekunden. Das sind zwei voellig verschiedene
// Krankheiten — der eine Lauf ist unterwegs gestorben (die KI), der andere kam
// nie ueber den Ausloeser hinaus. Das Panel zeigte beide gleich an, und bei den
// kurzen blieb die Detailkarte sogar ganz leer, weil n8n zu ihnen keine
// Knotendaten speichert. Genau diese beiden Luecken sind hier festgenagelt.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const express = require('express');
const n8n = require('../src/services/n8n');

let server;
let port;
let antwortDetail;

before(async () => {
  n8n.executionsAuflisten = async () => ([
    { id: '1', workflowId: 'W1', status: 'error', mode: 'trigger',
      startedAt: '2026-09-06T00:20:00.000Z', stoppedAt: '2026-09-06T00:20:00.063Z' },
    { id: '2', workflowId: 'W1', status: 'error', mode: 'trigger',
      startedAt: '2026-09-06T00:24:00.000Z', stoppedAt: '2026-09-06T00:28:12.000Z' },
    { id: '3', workflowId: 'W1', status: 'running', mode: 'trigger',
      startedAt: '2026-09-06T00:30:00.000Z', stoppedAt: null },
    { id: '9', workflowId: 'W2', status: 'success', mode: 'trigger',
      startedAt: '2026-09-06T00:00:00.000Z', stoppedAt: '2026-09-06T00:00:01.000Z' },
  ]);
  n8n.client = () => ({ get: async () => ({ data: antwortDetail }) });

  const app = express();
  app.use('/api/workflows', require('../src/routes/workflows'));
  await new Promise((fertig) => {
    server = app.listen(0, () => { port = server.address().port; fertig(); });
  });
});
after(() => { try { server.close(); } catch { /* egal */ } });

const anfrage = (pfad) => new Promise((fertig, schief) => {
  http.get({ host: '127.0.0.1', port, path: pfad }, (r) => {
    let t = '';
    r.on('data', (d) => { t += d; });
    r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
  }).on('error', schief);
});

describe('Die Dauer steht in der Liste', () => {
  test('nur die Laeufe des eigenen Workflows, mit Dauer', async () => {
    const { json } = await anfrage('/api/workflows/W1/laeufe');
    assert.equal(json.length, 3, 'der Lauf von W2 gehoert nicht dazu');
    assert.equal(json[0].dauerMs, 63, 'der kurze Fehlschlag — daran erkennt man ihn');
    assert.equal(json[1].dauerMs, 252000);
  });

  test('ein laufender Lauf hat noch keine Dauer', async () => {
    const { json } = await anfrage('/api/workflows/W1/laeufe');
    assert.equal(json[2].dauerMs, null, 'lieber nichts als eine erfundene Zahl');
  });
});

describe('Der Lauf im Detail', () => {
  test('Knoten, Fehler und zuletzt gelaufener Knoten', async () => {
    antwortDetail = {
      id: '2', status: 'error', startedAt: '2026-09-06T00:24:00.000Z',
      stoppedAt: '2026-09-06T00:28:12.000Z',
      data: {
        resultData: {
          lastNodeExecuted: 'Gemini klassifizieren',
          error: { message: 'The service is receiving too many requests from you' },
          runData: {
            'Sammeln + Normalisieren': [{ data: { main: [[{}, {}, {}]] } }],
            'Gemini klassifizieren': [{ error: { message: 'too many requests' } }],
          },
        },
      },
    };
    const { json } = await anfrage('/api/workflows/lauf/2');
    assert.equal(json.letzterKnoten, 'Gemini klassifizieren');
    assert.equal(json.dauerMs, 252000);
    assert.match(json.fehlermeldung, /too many requests/);
    assert.equal(json.knoten.find((k) => k.name === 'Sammeln + Normalisieren').items, 3);
    assert.ok(json.knoten.find((k) => k.name === 'Gemini klassifizieren').fehler);
  });

  test('ein Absturz vor dem ersten Knoten hat trotzdem eine Auskunft', async () => {
    // Genau der 63-ms-Fall: keine runData, der Grund steht nur oben.
    antwortDetail = {
      id: '1', status: 'error', startedAt: '2026-09-06T00:20:00.000Z',
      stoppedAt: '2026-09-06T00:20:00.063Z',
      data: { resultData: { error: { message: 'Connection closed unexpectedly' }, runData: {} } },
    };
    const { json } = await anfrage('/api/workflows/lauf/1');
    assert.deepEqual(json.knoten, [], 'n8n hat hier wirklich nichts');
    assert.equal(json.fehlermeldung, 'Connection closed unexpectedly',
      'ohne das stand vor der Aenderung eine leere Karte da');
    assert.equal(json.dauerMs, 63);
  });

  test('n8n liefert die Daten manchmal als Zeichenkette', async () => {
    antwortDetail = {
      id: '1', status: 'error', startedAt: '2026-09-06T00:20:00.000Z',
      stoppedAt: '2026-09-06T00:20:00.100Z',
      data: JSON.stringify({ resultData: { error: { message: 'Kaputt' }, runData: {} } }),
    };
    const { json } = await anfrage('/api/workflows/lauf/1');
    assert.equal(json.fehlermeldung, 'Kaputt');
  });

  test('steht die Meldung nur in der Beschreibung, gilt die', async () => {
    antwortDetail = {
      id: '1', status: 'error', startedAt: null, stoppedAt: null,
      data: { resultData: { error: { description: 'Kein Ordner Newsletter' }, runData: {} } },
    };
    const { json } = await anfrage('/api/workflows/lauf/1');
    assert.equal(json.fehlermeldung, 'Kein Ordner Newsletter');
    assert.equal(json.dauerMs, null);
  });
});
