// Bündel nach Inhalt — und: verschoben wird genau das, was angezeigt wurde.
//
// Die Sortier-Inbox bündelte nur nach Absender-Domain. Bei 1.750 offenen
// Mails von sehr vielen Absendern waren das viele Gruppen mit ein, zwei Mails,
// und dieselbe Sorte Mail („Inkasso troy 28364…", „Passwort zurücksetzen")
// von verschiedenen Absendern ließ sich nicht gemeinsam entscheiden.
//
// Zwei Zusagen stehen hier fest:
//  * Ein Inhalts-Bündel verschiebt nur seine eigenen Mails. Der alte Weg über
//    ein Muster (/sammel-zuordnen) nimmt alles mit, was sonst noch passt —
//    quer über Domains wäre das gefährlich.
//  * Ohne ausdrückliche Wahl entsteht keine Regel.
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-inhalt';
const db = require('../src/db');
const express = require('express');
const imap = require('../src/services/imap');
const routen = require('../src/routes/sortierung');

let bewegt;
imap.ordnerErstellen = async () => false;
imap.mailsVerschieben = async ({ mails, nach }) => {
  bewegt.push(...mails.map((m) => ({ id: m.id, nach })));
  return { verschoben: mails, fehler: [] };
};

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

const kontoId = (name = 'K') => db.prepare('SELECT id FROM accounts WHERE name = ?').get(name).id;
const mailAnlegen = (konto, von, betreff, uid) => db.prepare(
  "INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid, status) VALUES ('K', ?, ?, ?, ?, 'offen')",
).run(konto, von, betreff, String(uid)).lastInsertRowid;
const status = (id) => db.prepare('SELECT status, vorschlag FROM sort_inbox WHERE id = ?').get(id);

beforeEach(() => {
  bewegt = [];
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts; DELETE FROM sort_inbox;');
  const neu = db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES (?, 'h', 993, 'u', 'x', 1)");
  neu.run('K');
  neu.run('Z');
});

describe('POST /inbox/verschieben', () => {
  test('verschiebt genau die übergebenen Mails, keine weitere vom selben Absender', async () => {
    const a = mailAnlegen(kontoId(), 'inkasso@troy.de', 'Inkasso troy 28364', 1);
    const b = mailAnlegen(kontoId(), 'mahnung@anders.de', 'Inkasso troy 99120', 2);
    const nichtAngezeigt = mailAnlegen(kontoId(), 'inkasso@troy.de', 'Inkasso troy 11111', 3);

    const r = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: [a, b], zielordner: 'Inkasso',
    });

    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.verschoben, 2);
    assert.deepEqual(bewegt.map((x) => x.id).sort(), [a, b].sort());
    assert.equal(status(a).status, 'zugeordnet');
    assert.equal(status(a).vorschlag, 'Inkasso');
    assert.equal(status(nichtAngezeigt).status, 'offen', 'eine nicht angezeigte Mail bleibt, wo sie ist');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 0, 'ohne Wahl keine Regel');
  });

  test('eine ID aus einem anderen Postfach wird nicht angefasst', async () => {
    const fremd = mailAnlegen(kontoId('Z'), 'a@b.de', 'Hallo Welt', 5);
    const r = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: [fremd], zielordner: 'Irgendwo',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.verschoben, 0);
    assert.equal(r.json.nichtMehrOffen, 1);
    assert.equal(status(fremd).status, 'offen');
    assert.equal(bewegt.length, 0);
  });

  test('mit ausdrücklicher Regel entsteht eine Stichwort-Regel — und nur die', async () => {
    const a = mailAnlegen(kontoId(), 'x@y.de', 'Ihre Buchung 123', 7);
    const r = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: [a], zielordner: 'Reisen', regel: { typ: 'inhalt', muster: 'Buchung' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const regeln = db.prepare('SELECT * FROM sort_rules').all();
    assert.equal(regeln.length, 1);
    assert.equal(regeln[0].typ, 'inhalt');
    assert.equal(regeln[0].muster, 'buchung');
    assert.equal(regeln[0].zielordner, 'Reisen');
  });

  test('ungültige Eingaben werden abgewiesen, bevor etwas passiert', async () => {
    const a = mailAnlegen(kontoId(), 'x@y.de', 'Test', 8);
    const kurz = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: [a], zielordner: 'X', regel: { typ: 'inhalt', muster: 'AG' },
    });
    assert.equal(kurz.status, 400);
    const ohneIds = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: [], zielordner: 'X',
    });
    assert.equal(ohneIds.status, 400);
    const unsinn = await request('POST', '/api/sortierung/inbox/verschieben', {
      konto_id: kontoId(), ids: 'alle', zielordner: 'X',
    });
    assert.equal(unsinn.status, 400);
    assert.equal(bewegt.length, 0);
    assert.equal(status(a).status, 'offen');
  });
});

describe('POST /ignorieren mit ids', () => {
  test('nimmt das ganze Bündel aus der Liste, ohne Regel', async () => {
    const a = mailAnlegen(kontoId(), 'a@b.de', 'Newsletter Mai', 11);
    const b = mailAnlegen(kontoId(), 'c@d.de', 'Newsletter Juni', 12);
    const bleibt = mailAnlegen(kontoId(), 'e@f.de', 'Newsletter Juli', 13);
    const r = await request('POST', '/api/sortierung/ignorieren', { ids: [a, b] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ignoriert, 2);
    assert.equal(status(a).status, 'ignoriert');
    assert.equal(status(bleibt).status, 'offen');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 0);
  });

  test('die bisherige Form mit einer einzelnen id bleibt gültig', async () => {
    const a = mailAnlegen(kontoId(), 'a@b.de', 'Einzeln', 14);
    const r = await request('POST', '/api/sortierung/ignorieren', { id: a });
    assert.equal(r.status, 200);
    assert.equal(status(a).status, 'ignoriert');
  });
});

describe('Bündel nach Inhalt (Frontend-Hilfen)', () => {
  let h;
  before(async () => {
    const datei = path.join(__dirname, '../../frontend/src/components/ui/sortierHilfen.js');
    h = await import(pathToFileURL(datei).href);
  });

  test('Nummern, Satzzeichen und Antwort-Vorsilben fallen aus dem Muster', () => {
    assert.equal(h.inhaltsSchluessel('Inkasso troy 28364'), h.inhaltsSchluessel('INKASSO TROY 99120!'));
    assert.equal(h.inhaltsSchluessel('Re: AW: Angebot'), h.inhaltsSchluessel('Angebot'));
    assert.equal(h.inhaltsSchluessel('12345'), '', 'nur Nummern sind kein Inhalt');
    assert.equal(h.inhaltsSchluessel('Hi'), '', 'ein zu kurzes Wort bündelt Zufälle');
  });

  test('bündelt über Absender hinweg, lässt Einzelne einzeln und trennt Postfächer', () => {
    const mails = [
      { id: 1, konto_id: 1, von: 'a@troy.de', betreff: 'Inkasso troy 1', ki_ordner: 'Inkasso', kategorie: 'rechnung' },
      { id: 2, konto_id: 1, von: 'b@andere.de', betreff: 'Inkasso troy 2', ki_ordner: 'Inkasso', kategorie: 'rechnung' },
      { id: 3, konto_id: 1, von: 'c@dritte.de', betreff: 'Inkasso troy 3', ki_ordner: null, kategorie: 'sonstiges' },
      { id: 4, konto_id: 1, von: 'oma@familie.de', betreff: 'Grüße aus dem Urlaub' },
      { id: 5, konto_id: 2, von: 'a@troy.de', betreff: 'Inkasso troy 4' },
    ];
    const { buendel, einzeln } = h.inhaltsBuendel(mails);
    assert.equal(buendel.length, 1);
    assert.deepEqual(buendel[0].mails.map((m) => m.id), [1, 2, 3]);
    assert.equal(buendel[0].domains.anzahl, 3);
    assert.equal(buendel[0].kiVorschlag, 'Inkasso', 'zwei von drei sind die Mehrheit');
    assert.equal(buendel[0].kategorie, 'rechnung');
    assert.equal(einzeln, 2, 'die Urlaubsmail und die Mail aus dem zweiten Postfach');
  });

  test('ohne Mehrheit gibt es keinen vorbelegten Ordner', () => {
    assert.equal(h.mehrheitsVorschlag([{ ki_ordner: 'A' }, { ki_ordner: 'B' }, { ki_ordner: null }]), null);
    assert.equal(h.mehrheitsVorschlag([{ ki_ordner: 'A' }, { ki_ordner: 'B' }]), 'A',
      'genau die Hälfte reicht — wie bisher bei den Domain-Gruppen');
  });
});
