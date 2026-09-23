// Kennungen, die in einen n8n-API-Pfad gehen, müssen Kennungen sein.
//
// DELETE /api/workflows/stop/:id reichte :id ungeprüft an `/executions/${id}`
// weiter. Express dekodiert %2F zu „/", axios löst „../" auf — aus
// `..%2Fcredentials%2F42` wurde ein DELETE auf `/credentials/42`, ausgeführt
// mit dem API-Schlüssel des Panels. Wer das Recht „workflows" hatte, konnte so
// jedes Objekt in n8n löschen.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const express = require('express');
const n8n = require('../src/services/n8n');

describe('n8n.idPfad', () => {
  test('echte Kennungen gehen durch', () => {
    assert.equal(n8n.idPfad('12345'), '12345');
    assert.equal(n8n.idPfad('XMSZRiHsj1S8R7MH'), 'XMSZRiHsj1S8R7MH');
    assert.equal(n8n.idPfad(42), '42');
  });

  test('Pfadteile, Punkte und Leerzeichen nicht', () => {
    for (const boese of ['../credentials/42', '..%2Fx', '1/2', '.', '', 'a b', '1?x=2', null, undefined]) {
      assert.throws(() => n8n.idPfad(boese), /Ungültige Kennung/, `„${boese}" hätte abgewiesen werden müssen`);
    }
  });
});

describe('DELETE /api/workflows/stop/:id', () => {
  const request = async (pfad) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
    app.use('/api/workflows', require('../src/routes/workflows'));
    const server = await new Promise((f) => { const s = app.listen(0, () => f(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${pfad}`, { method: 'DELETE' });
      return { status: r.status, json: await r.json().catch(() => null) };
    } finally {
      await new Promise((f) => server.close(f));
    }
  };

  test('eine eingeschleuste Pfadangabe wird abgewiesen, bevor n8n gefragt wird', async () => {
    const alt = n8n.executionLoeschen;
    let gefragt = false;
    n8n.executionLoeschen = async () => { gefragt = true; };
    try {
      const r = await request('/api/workflows/stop/..%2Fcredentials%2F42');
      assert.equal(r.status, 400);
      assert.equal(gefragt, false);
    } finally {
      n8n.executionLoeschen = alt;
    }
  });
});
