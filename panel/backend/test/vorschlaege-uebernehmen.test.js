// „Alle Vorschläge übernehmen" — was darf mit, was nicht?
//
// Zu vielen wartenden Mails hat die KI einen vorhandenen Ordner genannt, war
// sich aber zu unsicher, um selbst zu verschieben. Das in einem Schritt zu
// übernehmen spart hunderte Klicks — aber nur, wenn drei Grenzen halten:
//  * Nur Ordner aus dem Katalog. Ein neuer Ordner, den die KI erfindet, läuft
//    weiter über die Freigabe.
//  * Der Stapel wird auf dem Server neu berechnet. IDs vom Client zählen nicht.
//  * Es entstehen keine Regeln — die Vorschläge waren ja unsicher.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-vorschlaege';
const db = require('../src/db');
const express = require('express');
const imap = require('../src/services/imap');
const themen = require('../src/services/themen');
const sortierung = require('../src/services/sortierung');
const routen = require('../src/routes/sortierung');

let bewegt;
imap.ordnerErstellen = async () => false;
imap.mailsVerschieben = async ({ mails, nach }) => {
  bewegt.push(...mails.map((m) => ({ id: m.id, nach })));
  return { verschoben: mails, fehler: [] };
};
themen.ordnerPfad = async (_konto, pfad) => pfad;
sortierung.abgleichen = async () => {};

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

let konto;
const mail = (kiOrdner, uid, betreff = `Mail ${uid}`) => db.prepare(
  "INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid, status, ki_ordner, ki_konfidenz) VALUES ('K', ?, 'a@b.de', ?, ?, 'offen', ?, 0.3)",
).run(konto, betreff, String(uid), kiOrdner).lastInsertRowid;
const status = (id) => db.prepare('SELECT status FROM sort_inbox WHERE id = ?').get(id).status;

let ids;
beforeEach(() => {
  bewegt = [];
  db.exec('DELETE FROM sort_rules; DELETE FROM sort_inbox; DELETE FROM konto_ordner; DELETE FROM accounts;');
  konto = db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)",
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO konto_ordner (konto_id, ordner, gesperrt) VALUES (?, 'Reisen', 0)").run(konto);
  db.prepare("INSERT INTO konto_ordner (konto_id, ordner, gesperrt) VALUES (?, 'Archiv alt', 1)").run(konto);
  themen.cacheVerwerfen(konto);
  ids = {
    reisen1: mail('Reisen', 1, 'Ihre Buchung'),
    reisen2: mail('reisen', 2, 'Boarding Pass'),
    neu: mail('Steuererklaerung', 3),
    gesperrt: mail('Archiv alt', 4),
    ohne: mail(null, 5),
  };
});

describe('Vorschau', () => {
  test('nur Katalog-Ordner zählen, neue und gesperrte stehen getrennt', async () => {
    const r = await request('GET', `/api/sortierung/inbox/vorschlaege-vorschau?konto_id=${konto}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.gesamt, 2);
    assert.equal(r.json.ordner.length, 1);
    assert.equal(r.json.ordner[0].ordner, 'Reisen', 'Groß-/Kleinschreibung des Vorschlags spielt keine Rolle');
    assert.equal(r.json.ordner[0].anzahl, 2);
    assert.deepEqual(r.json.ordner[0].beispiele.sort(), ['Boarding Pass', 'Ihre Buchung']);
    const neu = r.json.neueOrdner.map((o) => o.name).sort();
    assert.deepEqual(neu, ['Archiv alt', 'Steuererklaerung']);
  });
});

describe('Übernehmen', () => {
  test('verschiebt die Vorschläge des gewählten Ordners — und legt keine Regel an', async () => {
    const r = await request('POST', '/api/sortierung/inbox/vorschlaege-uebernehmen', {
      konto_id: konto, ordner: ['Reisen'],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.verschoben, 2);
    assert.deepEqual(bewegt.map((b) => b.id).sort(), [ids.reisen1, ids.reisen2].sort());
    assert.ok(bewegt.every((b) => b.nach === 'Reisen'));
    for (const bleibt of [ids.neu, ids.gesperrt, ids.ohne]) assert.equal(status(bleibt), 'offen');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 0);
  });

  test('IDs vom Client werden ignoriert, ein neuer Ordner wird nie übernommen', async () => {
    const r = await request('POST', '/api/sortierung/inbox/vorschlaege-uebernehmen', {
      konto_id: konto, ordner: ['Steuererklaerung', 'Archiv alt'], ids: [ids.neu, ids.gesperrt, ids.ohne],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.verschoben, 0);
    assert.equal(bewegt.length, 0);
    assert.equal(status(ids.neu), 'offen');
  });

  test('ohne Auswahl passiert nichts', async () => {
    const r = await request('POST', '/api/sortierung/inbox/vorschlaege-uebernehmen', { konto_id: konto, ordner: [] });
    assert.equal(r.status, 400);
    assert.equal(bewegt.length, 0);
  });
});
