// Wer hat diese Mail sortiert — die KI oder eine Regel?
//
// Die Frage entscheidet, ob die Mail das KI-Tagesbudget verbraucht. Und sie
// laesst sich NUR vor der KI-Abfrage beantworten, also in /sort. In
// /einsortieren nachzusehen, ob eine Regel passt, ergab die falsche Antwort:
// Das Panel lernt waehrend eines Laufs neue Regeln dazu (themen.regelLernen),
// und die haben Mails ruecklaeufig als "kostenlos" markiert, die laengst bei
// Gemini waren. Im Betrieb sah das so aus: 189 Mails klassifiziert, und das
// Tagesbudget stand trotzdem auf 0 verbraucht — der Deckel war damit blind.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const express = require('express');
const db = require('../src/db');
const budget = require('../src/services/budget');

let server;
let port;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', require('../src/routes/internal'));
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

const kiSpalte = (von) => db.prepare('SELECT ki FROM quarantine_log WHERE von = ?').get(von)?.ki;

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM accounts;'
    + ' DELETE FROM sort_inbox; DELETE FROM bestand_erledigt;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
  db.prepare("DELETE FROM settings WHERE key='gemini_tagesbudget' OR key LIKE 'ki_%'").run();
});

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name='K'").get().id;
const regelAnlegen = (muster, ordner) => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)',
).run(kontoId(), 'domain', muster, ordner, 'verschieben');

describe('KI-Verbrauch ehrlich zaehlen', () => {
  test('Regel-Mail: /sort merkt es vor, /einsortieren zaehlt sie nicht', async () => {
    regelAnlegen('shop.de', 'Bestellungen');
    const s = await post('/api/internal/sort', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 11 });
    assert.equal(s.json.aktion, 'verschieben');

    await post('/api/internal/einsortieren', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 11 });
    assert.equal(kiSpalte('a@shop.de'), 0, 'die KI hat diese Mail nie gesehen');
    assert.equal(budget.heuteVerbraucht(), 0);
  });

  test('KI-Mail: ohne Regel-Vermerk zaehlt sie, auch wenn spaeter eine Regel passt', async () => {
    // Genau der Fall aus dem Betrieb: Beim /sort gab es die Regel noch nicht,
    // die KI hat gearbeitet — und erst danach wurde die Regel dazugelernt.
    await post('/api/internal/sort', { konto: 'K', von: 'b@neu.de', betreff: 'y', uid: 12 });
    regelAnlegen('neu.de', 'Irgendwas');

    await post('/api/internal/einsortieren', { konto: 'K', von: 'b@neu.de', betreff: 'y', uid: 12 });
    assert.equal(kiSpalte('b@neu.de'), 1,
      'sonst steht das Tagesbudget auf 0, obwohl Gemini gearbeitet hat');
    assert.equal(budget.heuteVerbraucht(), 1);
  });

  test('der Vermerk gilt nur fuer genau diese Mail', async () => {
    regelAnlegen('shop.de', 'Bestellungen');
    await post('/api/internal/sort', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 21 });
    // Andere UID: Die hat den Regel-Zweig nicht genommen.
    await post('/api/internal/einsortieren', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 22 });
    assert.equal(kiSpalte('a@shop.de'), 1);
  });

  test('ohne UID (Workflow 01 ohne Nummer) wird vorsichtig gezaehlt', async () => {
    regelAnlegen('shop.de', 'Bestellungen');
    await post('/api/internal/sort', { konto: 'K', von: 'c@shop.de', betreff: 'x' });
    await post('/api/internal/einsortieren', { konto: 'K', von: 'c@shop.de', betreff: 'x' });
    assert.equal(kiSpalte('c@shop.de'), 1, 'im Zweifel als KI-Aufruf — der Deckel darf nicht zu locker sein');
  });
});
