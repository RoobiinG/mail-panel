// Regeln suchen und ändern.
//
// Bis Build 195 gab es nur Anlegen und Löschen, und die Liste kam immer
// vollständig. Aus 136 Regeln wurden binnen einer Woche 159, fast alle gelernt —
// und gelernte Regeln sind genau die, die man korrigieren will: Sie sortieren
// neunzig Tage lang ohne Rückfrage. Wer eine davon geradeziehen wollte, musste
// sie löschen und neu tippen und verlor dabei den Trefferzähler, also die
// einzige Zahl, die sagt, wie viel diese Regel schon bewegt hat.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const imap = require('../src/services/imap');

const express = require('express');

// listen() ist asynchron — der Port steht erst im Callback fest.
const request = async (methode, pfad, rumpf) => {
  const app = express();
  app.use(express.json());
  // Ohne Anmeldung: geprüft werden die Routen, nicht die Rechte.
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/sortierung', require('../src/routes/sortierung'));

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

const regel = (muster, zielordner, treffer = 0, typ = 'absender') => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, treffer) VALUES (?, ?, ?, ?, ?)',
).run(kontoId(), typ, muster, zielordner, treffer).lastInsertRowid;

const hole = (id) => db.prepare('SELECT * FROM sort_rules WHERE id = ?').get(id);

let ordnerErstelltAls = null;

beforeEach(() => {
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
  // Kein echter IMAP-Server im Test. Der Aufruf gehört trotzdem geprüft: Zeigt
  // eine Regel auf einen Ordner, den es im Postfach nicht gibt, scheitert jedes
  // Verschieben — und zwar erst beim nächsten Lauf, in n8n.
  ordnerErstelltAls = null;
  imap.ordnerErstellen = async (_konto, name) => { ordnerErstelltAls = name; return true; };
});

describe('Suchen statt scrollen', () => {
  test('ohne Suche kommt alles, mit Zählung', async () => {
    regel('a@shop.de', 'Bestellungen');
    regel('b@bank.de', 'Finanzen');

    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.regeln.length, 2);
    assert.equal(r.json.gesamt, 2);
    assert.equal(r.json.gefiltert, 2);
  });

  test('gesucht wird im Muster', async () => {
    regel('a@shop.de', 'Bestellungen');
    regel('b@bank.de', 'Finanzen');

    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&suche=shop`);
    assert.equal(r.json.regeln.length, 1);
    assert.equal(r.json.regeln[0].muster, 'a@shop.de');
    assert.equal(r.json.gefiltert, 1);
    assert.equal(r.json.gesamt, 2, 'die Gesamtzahl bleibt sichtbar');
  });

  // „Was landet alles in Rechnungen?" ist dieselbe Frage an dieselbe Liste.
  test('und im Zielordner', async () => {
    regel('a@shop.de', 'Rechnungen');
    regel('b@bank.de', 'Finanzen');

    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&suche=rechnung`);
    assert.equal(r.json.regeln.length, 1);
    assert.equal(r.json.regeln[0].zielordner, 'Rechnungen');
  });

  test('Groß- und Kleinschreibung ist egal', async () => {
    regel('Marktplatz@Shop.de', 'Einkauf');
    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&suche=MARKTPLATZ`);
    assert.equal(r.json.regeln.length, 1);
  });

  // Ohne Maskierung findet die Suche nach "_" oder "%" jede Regel — und der
  // Nutzer glaubt, seine Eingabe passe überall.
  test('Platzhalterzeichen der Datenbank wirken nicht als Platzhalter', async () => {
    regel('a@shop.de', 'Bestellungen');
    regel('b_c@shop.de', 'Bestellungen');

    const prozent = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&suche=%25`);
    assert.equal(prozent.json.regeln.length, 0, '„%" ist ein Zeichen, keine Wildcard');

    const strich = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&suche=b_c`);
    assert.equal(strich.json.regeln.length, 1);
  });

  test('die meistgenutzte Regel steht oben', async () => {
    regel('selten@shop.de', 'X', 1);
    regel('oft@shop.de', 'X', 99);
    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}`);
    assert.equal(r.json.regeln[0].muster, 'oft@shop.de');
  });

  test('limit und offset blättern', async () => {
    for (let i = 0; i < 5; i++) regel(`nr${i}@shop.de`, 'X', 10 - i);
    const seite = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&limit=2&offset=2`);
    assert.equal(seite.json.regeln.length, 2);
    assert.equal(seite.json.regeln[0].muster, 'nr2@shop.de');
    assert.equal(seite.json.gefiltert, 5, 'die Zahl meint alle Treffer, nicht die Seite');
  });
});

describe('Ändern statt löschen und neu tippen', () => {
  test('der Zielordner lässt sich korrigieren', async () => {
    const id = regel('marktplatz@shop.de', 'Rechnungen', 17);

    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { zielordner: 'Bestellungen' });
    assert.equal(r.status, 200);

    const neu = hole(id);
    assert.equal(neu.zielordner, 'Bestellungen');
    assert.equal(neu.treffer, 17, 'der Zähler ist das Gedächtnis der Regel');
    assert.equal(neu.muster, 'marktplatz@shop.de', 'was nicht mitgeschickt wird, bleibt stehen');
  });

  test('ein fehlender Zielordner wird im Postfach angelegt', async () => {
    const id = regel('a@shop.de', 'Alt');
    await request('PUT', `/api/sortierung/regeln/${id}`, { zielordner: 'Neu' });
    assert.equal(ordnerErstelltAls, 'Neu',
      'sonst zeigt die Regel ins Leere und jedes Verschieben scheitert in n8n');
  });

  test('bleibt der Ordner derselbe, wird nichts angelegt', async () => {
    const id = regel('a@shop.de', 'Gleich');
    await request('PUT', `/api/sortierung/regeln/${id}`, { muster: 'b@shop.de' });
    assert.equal(ordnerErstelltAls, null);
    assert.equal(hole(id).muster, 'b@shop.de');
  });

  test('auf „in Ruhe lassen" umstellen räumt den Zielordner weg', async () => {
    const id = regel('a@shop.de', 'Rechnungen');
    await request('PUT', `/api/sortierung/regeln/${id}`, { aktion: 'behalten' });
    const neu = hole(id);
    assert.equal(neu.aktion, 'behalten');
    assert.equal(neu.zielordner, '', 'eine Ruhe-Regel hat kein Ziel');
  });

  test('ein scheiternder IMAP-Server kippt die Änderung nicht', async () => {
    imap.ordnerErstellen = async () => { throw new Error('Postfach nicht erreichbar'); };
    const id = regel('a@shop.de', 'Alt');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { zielordner: 'Neu' });
    assert.equal(r.status, 200);
    assert.equal(hole(id).zielordner, 'Neu', 'die Regel gilt, der Ordner wird eben von Hand angelegt');
  });
});

describe('Was beim Ändern nicht durchgehen darf', () => {
  test('eine Regel, die es nicht gibt', async () => {
    const r = await request('PUT', '/api/sortierung/regeln/999999', { zielordner: 'X' });
    assert.equal(r.status, 404);
  });

  test('ein leeres Muster', async () => {
    const id = regel('a@shop.de', 'X');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { muster: '   ' });
    assert.equal(r.status, 400);
    assert.equal(hole(id).muster, 'a@shop.de');
  });

  test('ein Typ, den es nicht gibt', async () => {
    const id = regel('a@shop.de', 'X');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { typ: 'regex' });
    assert.equal(r.status, 400);
  });

  test('Verschieben ohne Ziel', async () => {
    const id = regel('a@shop.de', 'X');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { zielordner: '' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Zielordner/);
  });

  // Zwei Regeln mit demselben Muster widersprechen sich zwangsläufig; welche
  // zuerst greift, entscheidet dann die Reihenfolge in der Datenbank.
  test('ein Muster, das es schon gibt', async () => {
    regel('a@shop.de', 'Rechnungen');
    const id = regel('b@shop.de', 'Bestellungen');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { muster: 'a@shop.de' });
    assert.equal(r.status, 400);
    assert.equal(hole(id).muster, 'b@shop.de');
  });

  test('das eigene Muster beizubehalten ist kein Doppel', async () => {
    const id = regel('a@shop.de', 'Rechnungen');
    const r = await request('PUT', `/api/sortierung/regeln/${id}`, { zielordner: 'Bestellungen' });
    assert.equal(r.status, 200);
  });
});
