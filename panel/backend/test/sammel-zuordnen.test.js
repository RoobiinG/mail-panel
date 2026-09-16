// POST /api/sortierung/sammel-zuordnen — bis hierhin ohne einen einzigen Test,
// obwohl die Route Regeln anlegt und Ordner erzeugt.
//
// Anlass: Viele Anbieter verschicken alles über dieselbe Adresse — Buchung,
// Rechnung und Werbung von derselben "donotreply@". Der Sammelknopf der
// Sortier-Inbox kannte dafür nur "ganze Domain" oder "nur dieser Absender",
// beides zwangsläufig zu grob für so einen Absender. Diese Datei hält fest,
// dass die neue Zusatzbedingung (inhalt_muster) wirklich ankommt und beim
// Erneut-Anlegen nicht mit einer bedingungslosen Regel verwechselt wird.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-sammel';
const db = require('../src/db');
const express = require('express');
const imap = require('../src/services/imap');
const routen = require('../src/routes/sortierung');

imap.ordnerErstellen = async () => false;

const request = async (methode, pfad, rumpf) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/sortierung', routen);
  const server = await new Promise((fertig) => {
    const s = app.listen(0, () => fertig(s));
  });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${pfad}`, {
      method: methode,
      ...(rumpf ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rumpf) } : {}),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally {
    await new Promise((fertig) => server.close(fertig));
  }
};

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;
const regeln = () => db.prepare('SELECT * FROM sort_rules WHERE konto_id = ?').all(kontoId());

beforeEach(() => {
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts; DELETE FROM sort_inbox;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('Die Zusatzbedingung "inhalt_muster" kommt an', () => {
  test('typ absender + inhalt_muster wird als Regel gespeichert', async () => {
    const r = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'absender', muster: 'donotreply@easyjet.com',
      inhalt_muster: 'buchungsnummer', zielordner: 'Reisen',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rr = regeln();
    assert.equal(rr.length, 1);
    assert.equal(rr[0].typ, 'absender');
    assert.equal(rr[0].muster, 'donotreply@easyjet.com');
    assert.equal(rr[0].inhalt_muster, 'buchungsnummer');
  });

  test('typ inhalt legt eine domänenlose Stichwort-Regel an', async () => {
    const r = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'inhalt', muster: 'Rechnungsnummer', zielordner: 'Rechnungen',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rr = regeln();
    assert.equal(rr[0].typ, 'inhalt');
    assert.equal(rr[0].muster, 'rechnungsnummer', 'wird klein geschrieben gespeichert, wie jedes Muster');
  });

  test('ein zu kurzes Stichwort (typ inhalt) wird abgewiesen', async () => {
    const r = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'inhalt', muster: 'AG', zielordner: 'Rechnungen',
    });
    assert.equal(r.status, 400);
    assert.equal(regeln().length, 0);
  });

  test('ein zu kurzes Stichwort (Zusatzbedingung) wird abgewiesen', async () => {
    const r = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'absender', muster: 'a@b.de', inhalt_muster: 'ab', zielordner: 'X',
    });
    assert.equal(r.status, 400);
  });

  // Dieselbe Adresse OHNE Bedingung und MIT Bedingung sind zwei verschiedene
  // Regeln — genau der Fall, der es erlaubt, "donotreply@" für eine Sorte Mail
  // gezielt herauszugreifen, ohne den Rest mitzunehmen.
  test('dieselbe Adresse mit und ohne Stichwort bleibt getrennt', async () => {
    await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'absender', muster: 'donotreply@easyjet.com', zielordner: 'Werbung',
    });
    const zweite = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'absender', muster: 'donotreply@easyjet.com',
      inhalt_muster: 'buchungsnummer', zielordner: 'Reisen',
    });
    assert.equal(zweite.status, 200, JSON.stringify(zweite.json));
    assert.equal(regeln().length, 2, 'zwei Regeln fuer dieselbe Adresse, unterschieden durch die Bedingung');
  });

  test('derselbe Aufruf ein zweites Mal verwendet dieselbe Regel statt einer Dublette', async () => {
    const rumpf = {
      konto_id: kontoId(), typ: 'absender', muster: 'donotreply@easyjet.com',
      inhalt_muster: 'buchungsnummer', zielordner: 'Reisen',
    };
    const eins = await request('POST', '/api/sortierung/sammel-zuordnen', rumpf);
    const zwei = await request('POST', '/api/sortierung/sammel-zuordnen', rumpf);
    assert.equal(eins.json.regel_id, zwei.json.regel_id);
    assert.equal(regeln().length, 1);
  });

  test('regelMerken:false legt keine Regel an', async () => {
    const r = await request('POST', '/api/sortierung/sammel-zuordnen', {
      konto_id: kontoId(), typ: 'domain', muster: 'easyjet.com', zielordner: 'Reisen', regelMerken: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.regel_id, null);
    assert.equal(regeln().length, 0);
  });
});
