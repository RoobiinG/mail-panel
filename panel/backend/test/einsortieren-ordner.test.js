// /einsortieren weiß jetzt, aus welchem Ordner eine Mail kommt — und wann sie
// geschickt wurde.
//
// Seit Build 168 geht der Bestandslauf auch Ordner außerhalb des Posteingangs
// durch. Blieb dort eine Mail ohne Ziel, landete sie mit ihrer UID in der
// Sortier-Inbox — und die kennt nur den Posteingang. Unter derselben Nummer
// liegt dort womöglich eine ganz andere Mail, und genau die wäre beim Zuordnen
// verschoben worden. Und eine Rechnung, die schon in „Rechnungen" lag, wurde
// „von Rechnungen nach Rechnungen" verschoben und kam jeden Lauf wieder.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-einsortieren-ordner';
const express = require('express');
const db = require('../src/db');
const themen = require('../src/services/themen');
const internal = require('../src/routes/internal');
const patcher = require('../src/services/workflowPatcher');

let server;
let port;

before(async () => {
  // Kein IMAP im Test: Der Ordner „gibt es" unter dem Namen, der gefragt wird.
  themen.ordnerPfad = async (_konto, pfad) => pfad;
  const app = express();
  app.use(express.json());
  app.use('/api/internal', internal);
  await new Promise((fertig) => {
    server = app.listen(0, () => { port = server.address().port; fertig(); });
  });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function post(pfad, rumpf) {
  return new Promise((fertig, schief) => {
    const text = JSON.stringify(rumpf);
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
    });
    a.on('error', schief);
    a.end(text);
  });
}

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM accounts;'
    + ' DELETE FROM sort_inbox; DELETE FROM bestand_erledigt;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'themen_%'").run();
});

const erledigt = () => db.prepare('SELECT ordner, uid, grund FROM bestand_erledigt').all();

describe('Mails aus anderen Ordnern', () => {
  test('ohne Ziel kommen sie nicht in die Sortier-Inbox, sondern werden zurückgestellt', async () => {
    const r = await post('/api/internal/einsortieren', {
      konto: 'K', von: 'x@y.de', betreff: 'Irgendwas', uid: 812, ordner: 'Rechnungen',
    });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_inbox').get().n, 0,
      'die Sortier-Inbox verschiebt „UID 812 aus INBOX" — das wäre eine andere Mail');
    assert.deepEqual(erledigt(), [{ ordner: 'Rechnungen', uid: 812, grund: 'unklar' }]);
  });

  test('aus dem Posteingang wie bisher in die Sortier-Inbox — mit Herkunft', async () => {
    await post('/api/internal/einsortieren', { konto: 'K', von: 'x@y.de', betreff: 'Hallo', uid: 7 });
    const zeile = db.prepare('SELECT uid, quell_ordner FROM sort_inbox').get();
    assert.equal(zeile.uid, '7');
    assert.equal(zeile.quell_ordner, 'INBOX');
  });

  test('liegt sie schon im Zielordner, wird nichts verschoben — und sie kommt nicht wieder', async () => {
    const r = await post('/api/internal/einsortieren', {
      konto: 'K', von: 'rechnung@a.de', betreff: 'Rechnung', uid: 55, ordner: 'Rechnungen', zielordner: 'Rechnungen',
    });
    assert.equal(r.json.zielordner, null, 'sonst „von Rechnungen nach Rechnungen"');
    assert.match(r.json.grund, /schon in/);
    assert.deepEqual(erledigt(), [{ ordner: 'Rechnungen', uid: 55, grund: 'richtig' }]);
  });

  test('auch mit Präfix des Servers', () => {
    assert.equal(internal.selberOrdner('INBOX.Rechnungen', 'Rechnungen'), true);
    assert.equal(internal.selberOrdner('Rechnungen', 'Newsletter'), false);
  });

  test('das Protokoll hält den Herkunftsordner fest', async () => {
    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'x@y.de', betreff: 'B', uid: 9, ordner: 'Archiv', zielordner: 'Newsletter',
    });
    assert.equal(db.prepare('SELECT quell_ordner FROM quarantine_log').get().quell_ordner, 'Archiv');
  });
});

describe('Das Datum der Mail', () => {
  // Relativ zu jetzt, damit der Test nicht an einem festen Kalendertag hängt.
  const gestern = new Date(Math.floor((Date.now() - 24 * 3600 * 1000) / 1000) * 1000);

  test('wird mitprotokolliert', async () => {
    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'x@y.de', betreff: 'B', uid: 3, datum: gestern.toISOString(),
    });
    assert.equal(db.prepare('SELECT mail_datum FROM quarantine_log').get().mail_datum, gestern.toISOString());
    assert.equal(db.prepare('SELECT mail_datum FROM sort_inbox').get().mail_datum, gestern.toISOString());
  });

  test('Unlesbares und Zukunft werden verworfen — die Kopfzeile schreibt der Absender', () => {
    // So steht es in der Date-Kopfzeile: RFC 2822, nicht ISO.
    assert.equal(internal.mailDatum(gestern.toUTCString()), gestern.toISOString());
    assert.equal(internal.mailDatum('kein Datum'), null);
    assert.equal(internal.mailDatum(''), null);
    assert.equal(internal.mailDatum(null), null);
    assert.equal(internal.mailDatum('2099-01-01T00:00:00Z'), null, 'Werbung, die sich nach oben mogeln will');
    assert.equal(internal.mailDatum('1970-01-01T00:00:00Z'), null);
  });

  test('der Einsortieren-Knoten schickt es mit', () => {
    const knoten = patcher.einsortierenKnoten([0, 0], null);
    assert.match(knoten.parameters.jsonBody, /datum: \$json\.datum/);
  });

  test('der Normalisierer bekommt es — einmal, nicht bei jedem Abgleich neu', () => {
    const wf = {
      nodes: [{
        name: 'Normalisieren',
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: 'const j = $json;\nconst e = j.envelope || {};\nconst h = j.headers || {};\nreturn { json: {\n    konto,\n    uid: j.uid ?? j.attributes?.uid ?? null,\n    von,\n  } };',
        },
      }],
    };
    assert.equal(patcher.datumEinbauen(wf, 'Normalisieren'), true);
    const code = wf.nodes[0].parameters.jsCode;
    assert.match(code, /\n {4}datum: \(\(\) =>/, 'mit der Einrückung der Nachbarzeile');
    assert.equal(patcher.datumEinbauen(wf, 'Normalisieren'), false, 'ein zweiter Abgleich ändert nichts');
    assert.equal(wf.nodes[0].parameters.jsCode, code);

    // Und der eingesetzte Ausdruck tut, was er soll.
    const ausdruck = code.match(/datum: (\(\(\) => \{[^\n]*\}\)\(\)),/)[1];
    const rechnen = (j, e = {}, h = {}) => new Function('j', 'e', 'h', `return ${ausdruck};`)(j, e, h);
    assert.equal(rechnen({ date: gestern.toISOString() }), gestern.toISOString());
    assert.equal(rechnen({}, { date: gestern.toUTCString() }), gestern.toISOString());
    assert.equal(rechnen({}), null);
  });
});
