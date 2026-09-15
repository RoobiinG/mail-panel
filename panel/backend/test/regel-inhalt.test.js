// Wenn der Absender nichts verrät — Regeln auf den Inhalt der Mail.
//
// Die Betreff-Bedingung (regel-betreff.test.js) löst den Fall „ein Absender,
// mehrere Themen" nur halb. Sehr viele Unternehmen verschicken alles über
// dieselbe Adresse UND schreiben in die Betreffzeile nichts Brauchbares:
//
//     donotreply@easyjet.com   "easyJet Buchungsnummer: K9614Z1"
//     donotreply@easyjet.com   "Ready to take off?"
//
// Eine Absender-Regel liegt dort bei zwei von drei Mails falsch, egal wohin sie
// zeigt — im Betrieb landete die Buchungsbestätigung in „Einkauf" und die
// Werbung in „Banking". Was die Fälle trennt, steht im Text.
//
// Diese Datei hält fest, was eine Inhalts-Bedingung tut und — wichtiger — was
// sie NICHT tut: Sie darf nie zufällig greifen, wenn der Text fehlt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const s = require('../src/services/sortierung');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const regel = (typ, muster, zielordner, inhaltMuster = null) => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, inhalt_muster) VALUES (?, ?, ?, ?, ?)',
).run(kontoId(), typ, muster, zielordner, inhaltMuster).lastInsertRowid;

beforeEach(() => {
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('passt() mit Inhalts-Bedingung', () => {
  const mit = (inhaltMuster) => ({
    typ: 'absender', muster: 'donotreply@easyjet.com', inhalt_muster: inhaltMuster,
  });

  test('gesucht wird im Text, nicht nur im Betreff', () => {
    const r = mit('buchungsnummer');
    assert.equal(
      s.passt(r, 'donotreply@easyjet.com', 'Ready to take off?', 'Ihre Buchungsnummer lautet K9614Z1'),
      true,
      'der Betreff verrät nichts — der Text schon',
    );
    assert.equal(
      s.passt(r, 'donotreply@easyjet.com', 'Ready to take off?', 'Nur heute 20 % auf alle Flüge'),
      false,
    );
  });

  test('der Betreff zählt als Teil des Inhalts', () => {
    assert.equal(
      s.passt(mit('buchung'), 'donotreply@easyjet.com', 'Ihre Buchung', ''),
      true,
      'der Betreff ist der erste Satz der Mail, nicht etwas anderes',
    );
  });

  // Der entscheidende Punkt: Wo der Text nicht vorliegt (Nachsortierung liest
  // nur Briefköpfe), darf die Regel höchstens etwas übersehen — nie etwas
  // Falsches verschieben.
  test('ohne Text greift die Regel nicht, statt zu raten', () => {
    for (const ohne of [undefined, null, '']) {
      assert.equal(s.passt(mit('rechnungsnummer'), 'donotreply@easyjet.com', 'Ready to take off?', ohne), false);
    }
  });

  test('beide Bedingungen müssen zutreffen — UND, nicht ODER', () => {
    const r = mit('buchungsnummer');
    assert.equal(s.passt(r, 'wer@anders.example', '', 'Ihre Buchungsnummer lautet K9614Z1'), false,
      'passender Text allein reicht nicht, der Absender gehört dazu');
  });

  test('Groß- und Kleinschreibung spielt keine Rolle', () => {
    assert.equal(s.passt(mit('Buchungsnummer'), 'donotreply@easyjet.com', '', 'IHRE BUCHUNGSNUMMER'), true);
  });

  test('ohne Bedingung bleibt alles wie bisher', () => {
    for (const leer of [null, '', '   ', undefined]) {
      assert.equal(s.passt(mit(leer), 'donotreply@easyjet.com', 'egal', ''), true);
    }
  });
});

describe('Der Regeltyp "inhalt"', () => {
  test('trifft jede Mail mit dem Stichwort, egal von wem', () => {
    const r = { typ: 'inhalt', muster: 'rechnungsnummer' };
    assert.equal(s.passt(r, 'a@x.example', 'Hallo', 'Ihre Rechnungsnummer: 4711'), true);
    assert.equal(s.passt(r, 'b@y.example', 'Rechnungsnummer 4711', ''), true);
    assert.equal(s.passt(r, 'a@x.example', 'Hallo', 'Schöne Grüße'), false);
  });

  test('ohne Text und ohne Treffer im Betreff greift er nicht', () => {
    assert.equal(s.passt({ typ: 'inhalt', muster: 'rechnung' }, 'a@x.example', 'Hallo', undefined), false);
  });
});

describe('Die Rangfolge der Regeln', () => {
  // Je enger eine Regel greift, desto früher wird sie geprüft. Eine
  // Inhalts-Regel gilt für jeden Absender und steht deshalb zuletzt — sonst
  // fischte ein einzelnes Wort Mails weg, für die es eine genaue Regel gibt.
  test('Absender + Inhalt schlägt Absender allein', () => {
    regel('absender', 'donotreply@easyjet.com', 'Werbung');
    regel('absender', 'donotreply@easyjet.com', 'Reisen', 'buchungsnummer');
    const treffer = s.regelTreffer(kontoId(), 'donotreply@easyjet.com', 'Ready to take off?',
      'Ihre Buchungsnummer lautet K9614Z1');
    assert.equal(treffer.zielordner, 'Reisen');
  });

  test('eine Inhalts-Regel greift erst, wenn keine genauere passt', () => {
    regel('inhalt', 'rechnung', 'Rechnungen');
    regel('absender', 'chef@firma.example', 'Arbeit');
    assert.equal(
      s.regelTreffer(kontoId(), 'chef@firma.example', 'Rechnung anbei', '').zielordner,
      'Arbeit',
      'der bekannte Absender gewinnt gegen das Stichwort',
    );
    assert.equal(
      s.regelTreffer(kontoId(), 'fremd@woanders.example', 'Rechnung anbei', '').zielordner,
      'Rechnungen',
    );
  });

  test('der Trefferzähler bleibt bei regelTreffer unangetastet', () => {
    const id = regel('inhalt', 'rechnung', 'Rechnungen');
    s.regelTreffer(kontoId(), 'a@x.example', 'Rechnung anbei', '');
    assert.equal(db.prepare('SELECT treffer FROM sort_rules WHERE id = ?').get(id).treffer, 0);
  });

  test('pruefeRegeln zählt den Treffer und reicht den Text durch', () => {
    const id = regel('absender', 'donotreply@easyjet.com', 'Reisen', 'buchungsnummer');
    const ohne = s.pruefeRegeln(kontoId(), 'donotreply@easyjet.com', 'Ready to take off?', 'Werbung');
    assert.equal(ohne, null, 'ohne den passenden Text darf nichts greifen');
    const mit = s.pruefeRegeln(kontoId(), 'donotreply@easyjet.com', 'Ready to take off?', 'Buchungsnummer K1');
    assert.equal(mit.ordner, 'Reisen');
    assert.equal(db.prepare('SELECT treffer FROM sort_rules WHERE id = ?').get(id).treffer, 1);
  });
});
