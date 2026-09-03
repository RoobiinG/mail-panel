// Die Fallen beim Wechsel von Express 4 auf 5.
//
// Drei davon betreffen dieses Projekt, und alle drei fallen im Betrieb erst
// auf, wenn jemand die richtige Stelle trifft:
//
//   1. path-to-regexp v8 lehnt Routenmuster ab, die vorher durchgingen — der
//      Fehler kommt beim MOUNTEN, also beim Start, nicht beim Aufruf.
//   2. Der SPA-Rückfall ist ein regulärer Ausdruck. Funktionierte er nicht mehr,
//      bekäme jede Seite außer der Startseite eine 404 — die API liefe weiter,
//      die Oberfläche wäre weg.
//   3. req.body ist undefined statt {}, wenn kein Parser gegriffen hat. Ein
//      Dutzend Routen schreibt `const { ids } = req.body` und stürzte damit ab,
//      statt eine saubere 400 zu liefern.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
require('./umgebung');

const express = require('express');

const offen = [];
after(() => offen.forEach((s) => { try { s.close(); } catch { /* egal */ } }));

function starten(app) {
  return new Promise((fertig) => {
    const server = app.listen(0, () => fertig(server.address().port));
    offen.push(server);
  });
}

function anfragen(port, pfad, { methode = 'GET', rumpf, typ } = {}) {
  return new Promise((fertig, schief) => {
    const kopf = {};
    if (typ) kopf['Content-Type'] = typ;
    const a = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: kopf }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, text: t }));
    });
    a.on('error', schief);
    if (rumpf !== undefined) a.write(rumpf);
    a.end();
  });
}

describe('Express 5 ist wirklich installiert', () => {
  test('Hauptversion 5', () => {
    const v = require('express/package.json').version;
    assert.match(v, /^5\./, `installiert ist ${v}`);
  });
});

describe('Die Routen des Panels lassen sich mounten', () => {
  // path-to-regexp v8 wirft beim Mounten, nicht beim Aufruf. Ein einziges
  // schlechtes Muster verhindert also den Start des ganzen Panels — und zwar
  // mit einer Fehlermeldung, die den Ort nicht nennt.
  test('jede Routendatei geht ohne Fehler an eine App', () => {
    const dateien = require('fs')
      .readdirSync(path.join(__dirname, '../src/routes'))
      .filter((d) => d.endsWith('.js'));
    assert.ok(dateien.length >= 10, `nur ${dateien.length} Routendateien gefunden?`);

    // Nebenbei mitgeprüft: Kein Modul darf beim Laden einen Timer starten, der
    // den Prozess offen hält. Zwei taten es (routes/google.js und
    // routes/passkeys.js räumen ihre Merkzettel auf) — der Testlauf lief
    // daraufhin nicht in einen Fehler, sondern hing zehn Minuten, bis die CI
    // ihn abbrach. Ein Hänger ist die unangenehmste Art zu scheitern, weil er
    // nicht sagt, woran es liegt.
    const timerVorher = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    for (const datei of dateien) {
      const app = express();
      assert.doesNotThrow(() => {
        app.use('/api/probe', require(`../src/routes/${datei}`));
      }, `routes/${datei} lässt sich nicht mounten`);
    }

    const timerNachher = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.equal(timerNachher, timerVorher,
      'Ein Routenmodul startet beim Laden einen Timer ohne unref() — '
      + 'damit endet der Prozess nie, und der Testlauf hängt statt zu scheitern.');
  });
});

describe('Der SPA-Rückfall', () => {
  // Genau der Ausdruck aus index.js. Ginge er kaputt, wäre die Oberfläche weg,
  // während die API munter weiterliefe — man würde es zuerst dem Frontend
  // anlasten.
  const bauen = () => {
    const app = express();
    app.get('/api/etwas', (req, res) => res.json({ api: true }));
    app.get(/^(?!\/api\/).*/, (req, res) => res.type('html').send('<!doctype html>OBERFLAECHE'));
    return app;
  };

  test('liefert die Oberfläche für gewöhnliche Seiten', async () => {
    const port = await starten(bauen());
    for (const pfad of ['/', '/sortierung', '/einstellungen/tief/verschachtelt']) {
      const a = await anfragen(port, pfad);
      assert.equal(a.status, 200, `${pfad} sollte die Oberfläche liefern`);
      assert.match(a.text, /OBERFLAECHE/, pfad);
    }
  });

  test('lässt die API in Ruhe', async () => {
    const port = await starten(bauen());
    const a = await anfragen(port, '/api/etwas');
    assert.equal(a.status, 200);
    assert.equal(a.text, '{"api":true}', 'die API darf NICHT vom Rückfall geschluckt werden');
  });

  test('und unbekannte API-Pfade bleiben 404, statt die Oberfläche zu liefern', async () => {
    const port = await starten(bauen());
    const a = await anfragen(port, '/api/gibtsnicht');
    assert.equal(a.status, 404);
  });
});

describe('req.body ohne Parser', () => {
  const bauen = () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    // Der Ausgleich aus index.js
    app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.post('/test', (req, res) => {
      // So schreiben es die echten Routen — ungeschützt.
      const { ids } = req.body;
      res.json({ ids: ids ?? null });
    });
    return app;
  };

  test('ohne Rumpf gibt es eine Antwort statt eines Absturzes', async () => {
    const port = await starten(bauen());
    const a = await anfragen(port, '/test', { methode: 'POST' });
    assert.equal(a.status, 200, 'in Express 5 ohne Ausgleich waere das eine 500');
    assert.equal(a.text, '{"ids":null}');
  });

  test('mit falschem Content-Type ebenso', async () => {
    const port = await starten(bauen());
    const a = await anfragen(port, '/test', { methode: 'POST', rumpf: 'irgendwas', typ: 'text/plain' });
    assert.equal(a.status, 200);
  });

  test('und mit richtigem Rumpf kommt an, was gesendet wurde', async () => {
    const port = await starten(bauen());
    const a = await anfragen(port, '/test', {
      methode: 'POST', rumpf: JSON.stringify({ ids: [1, 2] }), typ: 'application/json',
    });
    assert.equal(a.text, '{"ids":[1,2]}');
  });
});
