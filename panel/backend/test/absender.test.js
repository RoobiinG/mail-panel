// Der schnellste Weg durch einen Berg von Mails fuehrt nicht ueber die KI.
//
// 23.000 Mails bei 400 KI-Einordnungen am Tag sind Wochen. Eine Regel fuer den
// groessten Absender raeumt Tausende ab — sofort, ohne KI, ohne Budget. Diese
// Datei nagelt fest, dass die Absender-Ansicht genau das tut: zaehlen,
// buendeln, und mit einem Handgriff Regel plus Verschieben.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const express = require('express');
const db = require('../src/db');
const imap = require('../src/services/imap');
const themen = require('../src/services/themen');
const kiText = require('../src/services/kiText');

let server;
let port;

before(async () => {
  const app = express();
  app.use(express.json());
  // Die Routen schreiben erstellt_von — im Betrieb kommt das aus der Anmeldung.
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/sortierung', require('../src/routes/sortierung'));
  await new Promise((fertig) => {
    server = app.listen(0, () => { port = server.address().port; fertig(); });
  });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function anfrage(pfad, { methode = 'GET', rumpf } = {}) {
  return new Promise((fertig, schief) => {
    const text = rumpf ? JSON.stringify(rumpf) : null;
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: methode,
      headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {},
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
    });
    a.on('error', schief);
    a.end(text);
  });
}

let konto;
beforeEach(() => {
  db.exec('DELETE FROM absender_stat; DELETE FROM sort_rules; DELETE FROM sort_inbox;'
    + ' DELETE FROM konto_ordner; DELETE FROM accounts;');
  konto = db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)",
  ).run().lastInsertRowid;
});

const stat = (adresse, domain, anzahl) => db.prepare(
  'INSERT INTO absender_stat (konto_id, adresse, domain, anzahl) VALUES (?, ?, ?, ?)',
).run(konto, adresse, domain, anzahl);

describe('Zählen', () => {
  test('schreibt die Absender weg', async () => {
    imap.absenderZaehlen = async () => ({
      gesamt: 1200, ohneAbsender: 4,
      absender: [
        { adresse: 'news@shop.de', domain: 'shop.de', anzahl: 900 },
        { adresse: 'info@shop.de', domain: 'shop.de', anzahl: 200 },
        { adresse: 'a@klein.de', domain: 'klein.de', anzahl: 100 },
      ],
    });
    const r = await anfrage('/api/sortierung/absender-zaehlen', {
      methode: 'POST', rumpf: { konto_id: konto },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.gesamt, 1200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM absender_stat').get().n, 3);
  });

  test('ein zweiter Lauf ersetzt den ersten, statt zu verdoppeln', async () => {
    stat('alt@weg.de', 'weg.de', 5);
    imap.absenderZaehlen = async () => ({
      gesamt: 1, ohneAbsender: 0, absender: [{ adresse: 'neu@da.de', domain: 'da.de', anzahl: 1 }],
    });
    await anfrage('/api/sortierung/absender-zaehlen', { methode: 'POST', rumpf: { konto_id: konto } });
    const zeilen = db.prepare('SELECT adresse FROM absender_stat').all();
    assert.deepEqual(zeilen.map((z) => z.adresse), ['neu@da.de']);
  });
});

describe('Die Liste', () => {
  test('bündelt nach Domain, die größte zuerst', async () => {
    stat('news@shop.de', 'shop.de', 900);
    stat('info@shop.de', 'shop.de', 200);
    stat('a@klein.de', 'klein.de', 100);

    const r = await anfrage(`/api/sortierung/absender?konto_id=${konto}`);
    assert.equal(r.json.absender[0].domain, 'shop.de');
    assert.equal(r.json.absender[0].anzahl, 1100, 'beide Adressen zusammen');
    assert.equal(r.json.absender[0].adressen, 2);
    assert.equal(r.json.absender[1].domain, 'klein.de');
  });

  test('sagt, wofür es schon eine Regel gibt', async () => {
    stat('news@shop.de', 'shop.de', 900);
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'domain', 'shop.de', 'Bestellungen')")
      .run(konto);
    const r = await anfrage(`/api/sortierung/absender?konto_id=${konto}`);
    assert.equal(r.json.absender[0].regel, 'Bestellungen', 'die muss man nicht noch einmal anfassen');
  });
});

describe('Ein Handgriff: Regel und Verschieben', () => {
  beforeEach(() => {
    themen.ordnerExistiert = async () => true;
    imap.mailsSuchen = async () => [11, 12, 13];
    imap.mailsVerschieben = async ({ mails }) => ({ verschoben: mails, fehler: [] });
  });

  test('legt die Regel an und holt die Mails aus dem Posteingang', async () => {
    stat('news@shop.de', 'shop.de', 900);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('K', ?, 'news@shop.de', '11', 'offen')")
      .run(konto);

    const r = await anfrage('/api/sortierung/absender/einsortieren', {
      methode: 'POST', rumpf: { konto_id: konto, domain: 'shop.de', zielordner: 'Bestellungen' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.verschoben, 3);

    const regel = db.prepare("SELECT * FROM sort_rules WHERE muster = 'shop.de'").get();
    assert.equal(regel.zielordner, 'Bestellungen', 'kuenftige Mails gehen ohne KI dorthin');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM absender_stat').get().n, 0,
      'erledigt gehoert nicht mehr in die Liste');
    assert.equal(db.prepare("SELECT status FROM sort_inbox").get().status, 'zugeordnet',
      'was das Panel selbst offen hatte, ist damit auch erledigt');
  });

  test('eine vorhandene Regel wird umgebogen, nicht verdoppelt', async () => {
    stat('news@shop.de', 'shop.de', 5);
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'domain', 'shop.de', 'Alt')")
      .run(konto);
    await anfrage('/api/sortierung/absender/einsortieren', {
      methode: 'POST', rumpf: { konto_id: konto, domain: 'shop.de', zielordner: 'Neu' },
    });
    const regeln = db.prepare("SELECT zielordner FROM sort_rules WHERE muster = 'shop.de'").all();
    assert.deepEqual(regeln.map((r) => r.zielordner), ['Neu']);
  });

  test('ohne Ziel passiert nichts', async () => {
    const r = await anfrage('/api/sortierung/absender/einsortieren', {
      methode: 'POST', rumpf: { konto_id: konto, domain: 'shop.de' },
    });
    assert.equal(r.status, 400);
  });
});

describe('Kategorien aus der Absenderliste', () => {
  test('nimmt nur Domains, die es wirklich gibt', async () => {
    stat('a@plesk.de', 'plesk.de', 40);
    stat('b@mc-host24.de', 'mc-host24.de', 30);
    kiText.frageJson = async () => ({
      ok: true,
      daten: {
        gruppen: [
          { ordner: 'Server & Hosting', absender: ['plesk.de', 'mc-host24.de', 'erfunden.de'] },
          { ordner: 'Leer', absender: ['gibtesnicht.de'] },
        ],
      },
    });

    const r = await anfrage('/api/sortierung/absender/kategorien', {
      methode: 'POST', rumpf: { konto_id: konto },
    });
    assert.equal(r.json.gruppen.length, 1, 'eine Gruppe ohne echte Absender faellt weg');
    assert.deepEqual(r.json.gruppen[0].absender, ['plesk.de', 'mc-host24.de']);
    assert.equal(r.json.gruppen[0].mails, 70);
  });

  test('ein unzulässiger Ordnername fällt raus', async () => {
    stat('a@plesk.de', 'plesk.de', 40);
    kiText.frageJson = async () => ({
      ok: true, daten: { gruppen: [{ ordner: '../etc/passwd', absender: ['plesk.de'] }] },
    });
    const r = await anfrage('/api/sortierung/absender/kategorien', {
      methode: 'POST', rumpf: { konto_id: konto },
    });
    assert.deepEqual(r.json.gruppen, [], 'dieselbe Pruefung wie fuer jeden anderen Ordnernamen');
  });

  test('ohne Zählung gibt es nichts zu gruppieren', async () => {
    const r = await anfrage('/api/sortierung/absender/kategorien', {
      methode: 'POST', rumpf: { konto_id: konto },
    });
    assert.equal(r.status, 400);
  });

  test('eine Kategorie anwenden macht aus jeder Domain eine Regel', async () => {
    stat('a@plesk.de', 'plesk.de', 40);
    stat('b@mc-host24.de', 'mc-host24.de', 30);
    themen.ordnerExistiert = async () => true;
    imap.mailsSuchen = async () => [1, 2];
    imap.mailsVerschieben = async ({ mails }) => ({ verschoben: mails, fehler: [] });

    const r = await anfrage('/api/sortierung/absender/kategorie-anwenden', {
      methode: 'POST',
      rumpf: { konto_id: konto, ordner: 'Server & Hosting', absender: ['plesk.de', 'mc-host24.de'] },
    });
    assert.equal(r.json.regeln, 2);
    assert.equal(r.json.verschoben, 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 2);
    const ordner = db.prepare("SELECT gelernt FROM konto_ordner WHERE ordner = 'Server & Hosting'").get();
    assert.match(ordner.gelernt, /plesk\.de/, 'die Absender gehoeren jetzt sichtbar zum Ordner');
  });
});
