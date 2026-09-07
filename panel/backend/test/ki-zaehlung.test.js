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
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_%' OR key LIKE 'ki_%' OR key LIKE 'themen_%'").run();
  db.exec('DELETE FROM konto_ordner;');
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

// Was schon feststeht, muss die KI nicht mehr sagen.
//
// Der Stichwort-Treffer — Ordner-Beschreibung, gelernte Absender, Umleitungen —
// wurde bisher erst NACH dem Gemini-Aufruf ausgewertet. Die Mail wurde bezahlt
// und dann von etwas entschieden, das schon vorher feststand. Damit war das
// Versprechen "einmal von der KI geschlossen, danach woertliches Wissen" nie
// eingeloest: Der zweite Absender derselben Firma kostete so viel wie der erste.
describe('Stichworte entscheiden vor der KI', () => {
  const ordnerAnlegen = (ordner, beschreibung, gelernt = null) => db.prepare(
    'INSERT INTO konto_ordner (konto_id, ordner, beschreibung, gelernt, quelle) VALUES (?, ?, ?, ?, ?)',
  ).run(kontoId(), ordner, beschreibung, gelernt, 'manuell');

  test('ein Wort aus der Beschreibung reicht — ohne KI', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('themen_sortierung_aktiv','1')").run();
    ordnerAnlegen('Anbieter', 'Vodafone, Sky, Telekom');

    const s = await post('/api/internal/sort', {
      konto: 'K', von: 'info@vodafone.de', betreff: 'Ihre Rechnung', uid: 31,
    });
    assert.equal(s.json.aktion, 'verschieben');
    assert.equal(s.json.ordner, 'Anbieter');
    assert.match(s.json.grund, /Stichwort/);

    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'info@vodafone.de', betreff: 'Ihre Rechnung', uid: 31,
    });
    assert.equal(kiSpalte('info@vodafone.de'), 0, 'Gemini hat diese Mail nie gesehen');
    assert.equal(budget.heuteVerbraucht(), 0, 'und sie kostet kein Kontingent');
  });

  test('ein gelernter Absender ebenso — genau darum wird gelernt', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('themen_sortierung_aktiv','1')").run();
    ordnerAnlegen('Anbieter', 'Vodafone, Sky', 'o2.de');

    const s = await post('/api/internal/sort', {
      konto: 'K', von: 'news@o2.de', betreff: 'Neues Angebot', uid: 32,
    });
    assert.equal(s.json.ordner, 'Anbieter');
    assert.equal(budget.heuteVerbraucht(), 0);
  });

  test('ohne Themen-Sortierung bleibt alles beim Alten', async () => {
    ordnerAnlegen('Anbieter', 'Vodafone, Sky, Telekom');
    const s = await post('/api/internal/sort', {
      konto: 'K', von: 'info@vodafone.de', betreff: 'x', uid: 33,
    });
    assert.equal(s.json.aktion, 'inbox', 'dann entscheidet weiter die KI');
  });

  test('eine eigene Regel geht weiterhin vor', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('themen_sortierung_aktiv','1')").run();
    ordnerAnlegen('Anbieter', 'Vodafone');
    regelAnlegen('vodafone.de', 'Meine Regel');

    const s = await post('/api/internal/sort', {
      konto: 'K', von: 'info@vodafone.de', betreff: 'x', uid: 34,
    });
    assert.equal(s.json.ordner, 'Meine Regel', 'was der Nutzer selbst eingetragen hat, zaehlt zuerst');
  });
});

// Der Deckel schuetzte nur die Bestands-Triage. Neu eintreffende Post fragte
// gar nicht erst nach dem Kontingent: Jede Mail rannte in Gemini, bekam "too
// many requests", wiederholte es fuenfmal und stand als fehlgeschlagener Lauf
// da — 21 Sekunden fuer nichts, und das bei jeder einzelnen Mail.
describe('Ohne Kontingent gar nicht erst fragen', () => {
  const settings = require('../src/services/settings');
  // Dieselbe Definition wie im Code: Googles Tag, nicht unserer.
  const { kiTag: heute } = require('../src/services/kiTag');

  test('ist das Budget aufgebraucht, bleibt die Mail liegen', async () => {
    settings.setze('gemini_tagesbudget', '10');
    budget.ausgabeMerken(10);

    const s = await post('/api/internal/sort', { konto: 'K', von: 'neu@fremd.de', betreff: 'x', uid: 41 });
    assert.equal(s.json.warten, true);
    assert.equal(s.json.ordner, null,
      'ohne Zielordner laeuft die Mail nach "Bleibt in der Inbox" — kein neuer Knoten noetig');
    assert.match(s.json.grund, /Kontingent/);
  });

  test('hat Google heute abgewiesen, zaehlt das mehr als die eigene Zaehlung', async () => {
    settings.setze('gemini_tagesbudget', '50000');
    settings.setze('ki_429_tag', heute());
    settings.setze('ki_429_limit', '500');
    // Eigene Zaehlung weit unter der Grenze — trotzdem ist Schluss.
    budget.ausgabeMerken(12);

    const s = await post('/api/internal/sort', { konto: 'K', von: 'neu@fremd.de', betreff: 'x', uid: 42 });
    assert.equal(s.json.warten, true);
  });

  test('eine eigene Regel greift trotzdem — sie kostet ja nichts', async () => {
    settings.setze('gemini_tagesbudget', '1');
    budget.ausgabeMerken(5);
    regelAnlegen('shop.de', 'Bestellungen');

    const s = await post('/api/internal/sort', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 43 });
    assert.equal(s.json.ordner, 'Bestellungen');
    assert.notEqual(s.json.warten, true, 'Regeln duerfen nie am KI-Deckel haengen');
  });

  test('ein Stichwort ebenso', async () => {
    settings.setze('gemini_tagesbudget', '1');
    budget.ausgabeMerken(5);
    db.prepare("INSERT INTO settings (key, value) VALUES ('themen_sortierung_aktiv','1')").run();
    db.prepare('INSERT INTO konto_ordner (konto_id, ordner, beschreibung, quelle) VALUES (?, ?, ?, ?)')
      .run(kontoId(), 'Anbieter', 'Vodafone, Sky', 'manuell');

    const s = await post('/api/internal/sort', { konto: 'K', von: 'x@vodafone.de', betreff: 'y', uid: 44 });
    assert.equal(s.json.ordner, 'Anbieter');
  });

  test('ohne Deckel laeuft alles wie bisher', async () => {
    settings.setze('gemini_tagesbudget', '0');
    budget.ausgabeMerken(9999);
    const s = await post('/api/internal/sort', { konto: 'K', von: 'neu@fremd.de', betreff: 'x', uid: 45 });
    assert.equal(s.json.aktion, 'inbox', 'dann entscheidet die KI');
  });
});
