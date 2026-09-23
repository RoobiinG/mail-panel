// Die Sammel-Entscheidung: viele Einträge der Chronik auf einmal — jeder mit
// eigenem Ziel und eigener Merk-Art.
//
// Der Wunsch dahinter, wörtlich: „dass ich einfach mehrere anklicken kann,
// auch unterschiedliche Absender, die dann aber auch unterschiedliche Regeln in
// Anspruch nehmen … aber nur einmal auf Bearbeiten drücken muss". Vorher gab es
// ein Ziel für alle Markierten, und liegengebliebene Mails ließen sich gar
// nicht korrigieren.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const express = require('express');
const imap = require('../src/services/imap');
const themen = require('../src/services/themen');
const routen = require('../src/routes/sortierung');

// Was im Postfach passiert — die Testwelt.
let bewegt;
let gesucht;
imap.ordnerErstellen = async () => false;
themen.ordnerPfad = async (_konto, pfad) => pfad;
imap.mailsVerschieben = async ({ mails, von, nach }) => {
  bewegt.push({ art: 'uid', von, nach, uids: mails.map((m) => Number(m.uid)) });
  return { verschoben: mails, fehler: [] };
};
imap.mailsSuchen = async ({ ordner, von, betreff }) => {
  gesucht.push({ ordner, von, betreff });
  return [99];
};
imap.mailVerschieben = async ({ uid, von, nach }) => {
  bewegt.push({ art: 'suche', von, nach, uids: [Number(uid)] });
  return {};
};

const request = async (pfad, rumpf) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/sortierung', routen);
  const server = await new Promise((fertig) => { const s = app.listen(0, () => fertig(s)); });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${pfad}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rumpf),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally {
    await new Promise((fertig) => server.close(fertig));
  }
};

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;
const eintrag = (felder) => db.prepare(`
  INSERT INTO quarantine_log (konto, von, betreff, zielordner, korrigiert_zu, uid, ki)
  VALUES ('K', @von, @betreff, @zielordner, @korrigiert_zu, @uid, 1)
`).run({ betreff: 'Betreff', zielordner: null, korrigiert_zu: null, uid: null, ...felder }).lastInsertRowid;
const regeln = () => db.prepare('SELECT typ, muster, zielordner, inhalt_muster, aktion FROM sort_rules ORDER BY id').all();

beforeEach(() => {
  bewegt = [];
  gesucht = [];
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM sort_inbox; DELETE FROM konto_ordner; DELETE FROM accounts;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('Drei Absender, drei Entscheidungen, ein Klick', () => {
  test('jede Zeile bekommt ihr eigenes Ziel und ihre eigene Regel', async () => {
    const rechnung = eintrag({ von: 'rechnung@anbieter.example', betreff: 'Ihre Rechnung', zielordner: 'Newsletter', uid: '11' });
    const newsletter = eintrag({ von: 'news@shop.example', betreff: 'Angebote', zielordner: 'Bestellungen', uid: '12' });
    const einzeln = eintrag({ von: 'chef@firma.example', betreff: 'Urlaub', zielordner: 'Werbung', uid: '13' });

    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [
        { log_id: rechnung, zielordner: 'Rechnungen', regelTyp: 'absender' },
        { log_id: newsletter, zielordner: 'Newsletter', regelTyp: 'domain' },
        { log_id: einzeln, zielordner: 'Arbeit', regelTyp: 'keine' },
      ],
    });

    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.erledigt, 3);
    assert.deepEqual(r.json.fehler, []);
    assert.deepEqual(regeln().map((x) => [x.typ, x.muster, x.zielordner]), [
      ['absender', 'rechnung@anbieter.example', 'Rechnungen'],
      ['domain', 'shop.example', 'Newsletter'],
    ], '„nur diese Mail" legt keine Regel an');
    // Einsortierte Mails haben im Zielordner eine andere UID — also gesucht.
    assert.deepEqual(gesucht.map((s) => s.ordner), ['Newsletter', 'Bestellungen', 'Werbung']);
    const korrigiert = db.prepare('SELECT id, korrigiert_zu FROM quarantine_log ORDER BY id').all();
    assert.deepEqual(korrigiert.map((k) => k.korrigiert_zu), ['Rechnungen', 'Newsletter', 'Arbeit']);
  });

  test('derselbe Absender zweimal: eine Regel, kein Doppel', async () => {
    const a = eintrag({ von: 'info@versand.example', betreff: 'Bestellung 1', zielordner: 'Werbung' });
    const b = eintrag({ von: 'info@versand.example', betreff: 'Bestellung 2', zielordner: 'Werbung' });
    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [
        { log_id: a, zielordner: 'Bestellungen', regelTyp: 'absender' },
        { log_id: b, zielordner: 'Bestellungen', regelTyp: 'absender' },
      ],
    });
    assert.equal(r.json.erledigt, 2);
    assert.equal(regeln().length, 1);
  });

  test('Absender + Stichwort und Stichwort allein gehen nebeneinander', async () => {
    const a = eintrag({ von: 'donotreply@reise.example', betreff: 'Ihre Buchungsnummer 42', zielordner: 'Werbung' });
    const b = eintrag({ von: 'x@y.example', betreff: 'Kontoauszug September', zielordner: 'Werbung' });
    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [
        { log_id: a, zielordner: 'Reisen', regelTyp: 'absender_inhalt', stichwort: 'Buchungsnummer' },
        { log_id: b, zielordner: 'Finanzen', regelTyp: 'inhalt', stichwort: 'Kontoauszug' },
      ],
    });
    assert.equal(r.json.erledigt, 2, JSON.stringify(r.json));
    assert.deepEqual(regeln().map((x) => [x.typ, x.muster, x.inhalt_muster]), [
      ['absender', 'donotreply@reise.example', 'buchungsnummer'],
      ['inhalt', 'kontoauszug', null],
    ]);
  });
});

describe('Was bisher gar nicht ging', () => {
  // 962 liegengebliebene Mails in sieben Tagen — und kein Knopf, um sie
  // einzusortieren. Sie liegen noch im Posteingang, ihre UID stimmt dort.
  test('eine liegengebliebene Mail wird aus dem Posteingang einsortiert', async () => {
    const id = eintrag({ von: 'news@shop.example', zielordner: null, uid: '12' });
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('K', ?, 'news@shop.example', '12', 'offen')")
      .run(kontoId());

    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [{ log_id: id, zielordner: 'Newsletter', regelTyp: 'keine' }],
    });
    assert.equal(r.json.erledigt, 1, JSON.stringify(r.json));
    assert.deepEqual(bewegt, [{ art: 'uid', von: 'INBOX', nach: 'Newsletter', uids: [12] }]);
    assert.equal(db.prepare('SELECT status FROM sort_inbox').get().status, 'zugeordnet',
      'sonst bietet die Sortier-Inbox eine Mail an, die es dort nicht mehr gibt');
  });

  test('eine schon korrigierte Mail wird dort gesucht, wohin sie korrigiert wurde', async () => {
    const id = eintrag({ von: 'a@b.example', zielordner: 'Newsletter', korrigiert_zu: 'Werbung' });
    await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [{ log_id: id, zielordner: 'Rechnungen', regelTyp: 'keine' }],
    });
    assert.equal(gesucht[0].ordner, 'Werbung', 'nicht mehr im ursprünglichen Ziel');
    assert.equal(bewegt[0].von, 'Werbung');
  });

  test('eine vorhandene „in Ruhe lassen"-Regel wird zu einer, die verschiebt', async () => {
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, 'absender', 'a@b.example', '', 'behalten')")
      .run(kontoId());
    const id = eintrag({ von: 'a@b.example', zielordner: null, uid: '5' });
    await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [{ log_id: id, zielordner: 'Rechnungen', regelTyp: 'absender' }],
    });
    const [regel] = regeln();
    assert.equal(regel.zielordner, 'Rechnungen');
    assert.equal(regel.aktion, 'verschieben', 'sonst bleibt die nächste Mail trotzdem liegen');
  });

  test('eine Regel mit Betreff-Bedingung wird nicht umgebogen', async () => {
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner, betreff_muster) VALUES (?, 'absender', 'a@b.example', 'Bestellungen', 'bestellung')")
      .run(kontoId());
    const id = eintrag({ von: 'a@b.example', zielordner: 'Bestellungen' });
    await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [{ log_id: id, zielordner: 'Rechnungen', regelTyp: 'absender' }],
    });
    const alle = regeln();
    assert.equal(alle.length, 2, 'die Betreff-Regel bleibt, daneben entsteht die Absender-Regel');
    assert.equal(alle[0].zielordner, 'Bestellungen');
  });
});

describe('Grenzen', () => {
  test('ein Fehler in einer Zeile hält die anderen nicht auf', async () => {
    const gut = eintrag({ von: 'a@b.example', zielordner: 'Werbung' });
    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [
        { log_id: 999999, zielordner: 'X', regelTyp: 'keine' },
        { log_id: gut, zielordner: 'Rechnungen', regelTyp: 'keine' },
        { log_id: gut, zielordner: 'Rechnungen', regelTyp: 'inhalt', stichwort: 'ab' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.erledigt, 1);
    assert.equal(r.json.fehler.length, 2);
    assert.deepEqual(r.json.erledigteIds, [gut]);
  });

  test('das Ziel, in dem die Mail schon liegt, ist kein Ziel', async () => {
    const id = eintrag({ von: 'a@b.example', zielordner: 'Rechnungen' });
    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: [{ log_id: id, zielordner: 'rechnungen', regelTyp: 'keine' }],
    });
    assert.equal(r.json.erledigt, 0);
    assert.match(r.json.fehler[0].error, /schon liegt/);
  });

  test('zu viele auf einmal werden abgewiesen — die Oberfläche schickt Portionen', async () => {
    const r = await request('/api/sortierung/korrigieren-sammel', {
      eintraege: Array.from({ length: 26 }, (_, i) => ({ log_id: i + 1, zielordner: 'X' })),
    });
    assert.equal(r.status, 400);
  });

  test('eine leere Liste ebenso', async () => {
    const r = await request('/api/sortierung/korrigieren-sammel', { eintraege: [] });
    assert.equal(r.status, 400);
  });

  test('die Einzelkorrektur läuft über denselben Weg', async () => {
    const id = eintrag({ von: 'a@b.example', zielordner: 'Werbung' });
    const r = await request('/api/sortierung/korrigieren', { log_id: id, zielordner: 'Rechnungen', regelTyp: 'domain' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.regel.muster, 'b.example');
  });
});
