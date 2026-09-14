// Ein Absender, viele Themen — und die Frage, welche Regel zuerst gilt.
//
// Unternehmen verschicken Bestellbestätigung, Rechnung und Werbung über
// dieselbe Adresse. Eine Absender-Regel kennt aber nur einen Zielordner:
// entweder geht alles nach „Einkauf" oder alles nach „Bestellungen", und beides
// ist falsch. Im Betrieb sah das am 14.09. so aus — derselbe Absender, zwei
// gelernte Regeln, zwei Ordner:
//
//     marktplatz@versand.example → Anbieter, Vertraege und co.
//     info@versand.example       → Einkauf
//
// Deshalb gibt es jetzt eine zweite, freiwillige Bedingung auf dem Betreff.
// Und weil damit mehrere Regeln auf dieselbe Mail passen können, braucht es
// eine Rangfolge — bis Build 197 gewann schlicht die zuerst angelegte Regel,
// für den Nutzer also eine Zufallsreihenfolge.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const s = require('../src/services/sortierung');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const regel = (typ, muster, zielordner, betreffMuster = null, aktion = 'verschieben') => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, betreff_muster, aktion) VALUES (?, ?, ?, ?, ?, ?)',
).run(kontoId(), typ, muster, zielordner, betreffMuster, aktion).lastInsertRowid;

beforeEach(() => {
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('passt() mit Betreff-Bedingung', () => {
  const mit = (betreffMuster) => ({ typ: 'absender', muster: 'info@versand.example', betreff_muster: betreffMuster });

  test('beide Bedingungen müssen zutreffen — UND, nicht ODER', () => {
    const r = mit('bestellung');
    assert.equal(s.passt(r, 'info@versand.example', 'Deine Bestellung wurde versandt'), true);
    assert.equal(s.passt(r, 'info@versand.example', 'Unsere Angebote der Woche'), false,
      'derselbe Absender, anderer Betreff — genau darum geht es');
    assert.equal(s.passt(r, 'wer@anders.example', 'Deine Bestellung wurde versandt'), false,
      'passender Betreff allein reicht nicht');
  });

  test('Groß- und Kleinschreibung spielt keine Rolle', () => {
    assert.equal(s.passt(mit('Bestellung'), 'info@versand.example', 'DEINE BESTELLUNG'), true);
    assert.equal(s.passt(mit('BESTELLUNG'), 'info@versand.example', 'deine bestellung'), true);
  });

  // „Enthält nichts" ist keine Erfüllung der Bedingung, sondern ihr Gegenteil.
  test('eine Mail ohne Betreff trifft eine solche Regel nie', () => {
    assert.equal(s.passt(mit('bestellung'), 'info@versand.example', ''), false);
    assert.equal(s.passt(mit('bestellung'), 'info@versand.example', null), false);
    assert.equal(s.passt(mit('bestellung'), 'info@versand.example', undefined), false);
  });

  test('ohne Bedingung bleibt alles wie bisher', () => {
    for (const leer of [null, '', '   ', undefined]) {
      assert.equal(
        s.passt({ typ: 'absender', muster: 'info@versand.example', betreff_muster: leer },
          'info@versand.example', 'irgendwas'),
        true,
        `leeres Betreff-Muster (${JSON.stringify(leer)}) darf nicht plötzlich filtern`,
      );
    }
  });

  test('sie wirkt auch auf Domain-Regeln', () => {
    const r = { typ: 'domain', muster: 'versand.example', betreff_muster: 'rechnung' };
    assert.equal(s.passt(r, 'beliebig@versand.example', 'Ihre Rechnung 4711'), true);
    assert.equal(s.passt(r, 'beliebig@versand.example', 'Newsletter'), false);
  });
});

describe('Rangfolge: je enger die Regel, desto früher gilt sie', () => {
  test('Absender + Betreff vor Absender allein', () => {
    // Absichtlich in der „falschen" Reihenfolge angelegt: Bis Build 197 hätte
    // die zuerst angelegte gewonnen, und die Betreff-Regel wäre nie zum Zug
    // gekommen.
    regel('absender', 'info@versand.example', 'Einkauf');
    regel('absender', 'info@versand.example', 'Bestellungen', 'bestellung');

    const t = s.regelTreffer(kontoId(), 'info@versand.example', 'Deine Bestellung wurde versandt');
    assert.equal(t.zielordner, 'Bestellungen');

    const rest = s.regelTreffer(kontoId(), 'info@versand.example', 'Angebote der Woche');
    assert.equal(rest.zielordner, 'Einkauf', 'was die Bedingung verfehlt, fällt auf die allgemeine Regel');
  });

  test('Absender vor Domain', () => {
    regel('domain', 'versand.example', 'Werbung');
    regel('absender', 'info@versand.example', 'Bestellungen');
    assert.equal(
      s.regelTreffer(kontoId(), 'info@versand.example', 'x').zielordner,
      'Bestellungen',
      'die Regel für genau diesen Korrespondenten ist die engere',
    );
  });

  test('Domain vor Betreff', () => {
    regel('betreff', 'rechnung', 'Rechnungen');
    regel('domain', 'versand.example', 'Einkauf');
    assert.equal(
      s.regelTreffer(kontoId(), 'info@versand.example', 'Ihre Rechnung').zielordner,
      'Einkauf',
      'ein Stichwort im Betreff trifft jeden Absender — das ist die weiteste Regel',
    );
  });

  test('bei gleichem Rang entscheidet weiterhin das Alter', () => {
    const alt = regel('absender', 'info@versand.example', 'Zuerst');
    // Ein Bruchstueck ohne @ trifft dieselbe Adresse und hat denselben Rang.
    regel('absender', 'info', 'Danach');
    assert.equal(s.regelTreffer(kontoId(), 'info@versand.example', 'x').id, alt,
      'sonst wäre nicht mehr vorhersagbar, welche von zwei gleichrangigen Regeln greift');
  });

  test('regelnGeordnet liefert die Reihenfolge, nach der auch entschieden wird', () => {
    regel('betreff', 'rechnung', 'A');
    regel('domain', 'versand.example', 'B');
    regel('absender', 'info@versand.example', 'C');
    regel('absender', 'info@versand.example', 'D', 'bestellung');

    assert.deepEqual(
      s.regelnGeordnet(kontoId()).map((r) => r.zielordner),
      ['D', 'C', 'B', 'A'],
    );
  });
});

describe('Was das Verschieben in Ruhe lässt', () => {
  test('eine Ruhe-Regel mit Betreff-Bedingung gilt nur für passende Mails', () => {
    regel('absender', 'info@versand.example', '', 'newsletter', 'behalten');
    assert.equal(s.istBehalten(kontoId(), 'info@versand.example', 'Unser Newsletter'), true);
    assert.equal(s.istBehalten(kontoId(), 'info@versand.example', 'Deine Rechnung'), false);
  });
});
