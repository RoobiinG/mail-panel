// Der Budget-Wächter entscheidet, welche Mails heute noch an die KI dürfen.
// Ein Fehler hier kostet entweder das ganze Tageslimit (zu großzügig) oder
// stoppt die Sortierung grundlos (zu streng) — beides fällt im Betrieb erst
// spät auf. Deshalb hier durchgespielt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const budget = require('../src/services/budget');
const sortierung = require('../src/services/sortierung');

function heuteLog(konto, von, betreff) {
  db.prepare("INSERT INTO quarantine_log (konto, von, betreff) VALUES (?, ?, ?)").run(konto, von, betreff);
}
function inbox(konto, von, betreff, status = 'offen') {
  db.prepare("INSERT INTO sort_inbox (konto, von, betreff, status) VALUES (?, ?, ?, ?)")
    .run(konto, von, betreff, status);
}
const kand = (n, konto = 'K') =>
  Array.from({ length: n }, (_, i) => ({ konto, von: `abs${i}@x.de`, betreff: `Betreff ${i}` }));

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_inbox; DELETE FROM sort_rules; DELETE FROM accounts;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_%' OR key LIKE 'ki_%'").run();
  // Ein Buendel von 1 macht aus Anfragen wieder Mails — nur so lassen sich die
  // Grenzfaelle des Deckels ueberhaupt auf eine Mail genau pruefen.
  settings.setze('gemini_buendel', '1');
});

describe('Tagesdeckel', () => {
  test('lässt nur so viele durch, wie das Budget noch hergibt', () => {
    settings.setze('gemini_tagesbudget', '3');
    const e = budget.entscheiden(kand(10));
    assert.equal(e.erlaubt.length, 3);
    assert.deepEqual(e.erlaubt, [0, 1, 2], 'die ersten drei');
    assert.equal(e.uebersprungen.budget, 7);
    assert.equal(e.budget.rest, 3);
  });

  test('schon heute Verbrauchtes zählt gegen das Budget', () => {
    settings.setze('gemini_tagesbudget', '5');
    budget.ausgabeMerken(2); // zwei Anfragen sind heute schon raus
    const e = budget.entscheiden(kand(10));
    assert.equal(e.erlaubt.length, 3, '5 minus 2 bereits verbraucht');
    assert.equal(e.budget.verbraucht, 2);
    assert.equal(e.budget.rest, 3);
  });

  test('aufgebrauchtes Budget lässt nichts mehr durch', () => {
    settings.setze('gemini_tagesbudget', '2');
    budget.ausgabeMerken(2);
    const e = budget.entscheiden(kand(5));
    assert.equal(e.erlaubt.length, 0);
    assert.equal(e.budget.rest, 0);
  });

  test('ohne Deckel (0) dürfen alle durch', () => {
    settings.setze('gemini_tagesbudget', '0');
    const e = budget.entscheiden(kand(50));
    assert.equal(e.erlaubt.length, 50);
    assert.equal(e.budget.unbegrenzt, true);
    assert.equal(e.budget.rest, null);
  });
});

describe('Kein Budget für schon Gesehenes', () => {
  test('Mails in der Sortier-Inbox kosten kein Budget', () => {
    settings.setze('gemini_tagesbudget', '100');
    inbox('K', 'abs0@x.de', 'Betreff 0');       // Kandidat 0 ist schon bekannt
    const e = budget.entscheiden(kand(3));
    assert.deepEqual(e.erlaubt, [1, 2], 'der schon gesehene fehlt');
    assert.equal(e.uebersprungen.gesehen, 1);
  });

  test('heute schon eingeordnete Mails werden übersprungen', () => {
    settings.setze('gemini_tagesbudget', '100');
    heuteLog('K', 'abs1@x.de', 'Betreff 1');
    const e = budget.entscheiden(kand(3));
    assert.deepEqual(e.erlaubt, [0, 2]);
    assert.equal(e.uebersprungen.gesehen, 1);
  });

  test('dasselbe Postfach zählt, ein anderes nicht', () => {
    settings.setze('gemini_tagesbudget', '100');
    inbox('Anderes', 'abs0@x.de', 'Betreff 0'); // gleiches von/betreff, anderes Konto
    const e = budget.entscheiden(kand(1, 'K'));
    assert.deepEqual(e.erlaubt, [0], 'anderes Konto blockiert nicht');
  });

  // Der eigentliche Zweck: ein zweiter Lauf am selben Tag darf für dieselben
  // liegengebliebenen Mails kein Budget mehr verbrennen.
  test('ein zweiter Lauf verbrennt kein Budget für Liegengebliebenes', () => {
    settings.setze('gemini_tagesbudget', '100');
    const mails = kand(4);
    // Erster Lauf: alle vier klassifiziert, zwei blieben in der Sortier-Inbox.
    for (const m of mails) heuteLog(m.konto, m.von, m.betreff);
    inbox('K', mails[0].von, mails[0].betreff);
    inbox('K', mails[1].von, mails[1].betreff);
    // Zweiter Lauf mit denselben Mails:
    const e = budget.entscheiden(mails);
    assert.equal(e.erlaubt.length, 0, 'nichts davon kostet erneut Budget');
    assert.equal(e.uebersprungen.gesehen, 4);
  });
});

describe('Robustheit', () => {
  test('leere Eingabe ergibt leere Erlaubnis, kein Absturz', () => {
    const e = budget.entscheiden(undefined);
    assert.deepEqual(e.erlaubt, []);
    assert.equal(e.gesamt, 0);
  });
});

// "In Ruhe lassen": Regeln, die bewusst nichts tun. Sie duerfen weder KI-Budget
// kosten noch die Mail bewegen — sonst waere die Zusage an den Nutzer gebrochen.
describe('In Ruhe lassen', () => {
  const kontoAnlegen = () => db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)",
  ).run().lastInsertRowid;
  const regel = (id, muster, aktion, ziel) => db.prepare(
    'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'domain', muster, ziel || '', aktion);

  test('so eine Mail kostet kein KI-Budget', () => {
    settings.setze('gemini_tagesbudget', '100');
    const id = kontoAnlegen();
    regel(id, 'ruhe.de', 'behalten');
    const e = budget.entscheiden([
      { konto: 'K', von: 'a@ruhe.de', betreff: 'x' },
      { konto: 'K', von: 'b@andere.de', betreff: 'y' },
    ]);
    assert.deepEqual(e.erlaubt, [1], 'nur die Mail ohne Ruhe-Regel darf zur KI');
    assert.equal(e.uebersprungen.ruhe, 1);
  });

  test('istBehalten erkennt die Ruhe-Regel — und nur sie', () => {
    const id = kontoAnlegen();
    regel(id, 'ruhe.de', 'behalten');
    regel(id, 'ziel.de', 'verschieben', 'Ordner');
    assert.equal(sortierung.istBehalten(id, 'a@ruhe.de', ''), true);
    assert.equal(sortierung.istBehalten(id, 'a@ziel.de', ''), false, 'normale Regel ist keine Ruhe-Regel');
    assert.equal(sortierung.istBehalten(id, 'a@fremd.de', ''), false, 'ohne Treffer keine Ruhe');
  });

  test('zaehlt den Treffer nicht doppelt (istBehalten laesst den Zaehler in Ruhe)', () => {
    const id = kontoAnlegen();
    regel(id, 'ruhe.de', 'behalten');
    sortierung.istBehalten(id, 'a@ruhe.de', '');
    sortierung.istBehalten(id, 'a@ruhe.de', '');
    const t = db.prepare('SELECT treffer FROM sort_rules WHERE konto_id = ?').get(id).treffer;
    assert.equal(t, 0, 'die Pruefung beim Einsortieren darf nicht mitzaehlen');
  });
});

// Regeln sollen den Bestand schnell machen: Sie sortieren ohne KI. Also duerfen
// sie auch nicht am KI-Tagesbudget zehren — sonst bremst der Deckel genau das
// aus, was gar nichts kostet.
describe('Regeln kosten kein Budget', () => {
  const kontoAnlegen = () => db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)",
  ).run().lastInsertRowid;

  test('Mails mit Verschiebe-Regel duerfen auch ueber das Budget hinaus mit', () => {
    settings.setze('gemini_tagesbudget', '1');
    const id = kontoAnlegen();
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'domain', 'shop.de', 'Bestellungen', 'verschieben');
    const e = budget.entscheiden([
      { konto: 'K', von: 'a@shop.de', betreff: '1' },
      { konto: 'K', von: 'b@shop.de', betreff: '2' },
      { konto: 'K', von: 'c@fremd.de', betreff: '3' },
      { konto: 'K', von: 'd@fremd.de', betreff: '4' },
    ]);
    assert.deepEqual(e.erlaubt, [0, 1, 2],
      'beide Regel-Mails plus die eine, die das Budget noch hergibt');
    assert.equal(e.uebersprungen.budget, 1);
  });

  test('nur eine KI-Mail steht im Protokoll', () => {
    settings.setze('gemini_tagesbudget', '5');
    // Vier Zeilen von heute, aber drei davon hat eine Regel sortiert.
    db.prepare("INSERT INTO quarantine_log (konto, von, ki) VALUES ('K','a@x.de',0)").run();
    db.prepare("INSERT INTO quarantine_log (konto, von, ki) VALUES ('K','b@x.de',0)").run();
    db.prepare("INSERT INTO quarantine_log (konto, von, ki) VALUES ('K','c@x.de',0)").run();
    db.prepare("INSERT INTO quarantine_log (konto, von, ki) VALUES ('K','d@x.de',1)").run();
    assert.equal(budget.protokolliertHeute(), 1);
  });

  test('die in Ruhe gelassenen werden mit Index gemeldet', () => {
    const id = kontoAnlegen();
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'domain', 'ruhe.de', '', 'behalten');
    const e = budget.entscheiden([
      { konto: 'K', von: 'a@fremd.de', betreff: '1' },
      { konto: 'K', von: 'b@ruhe.de', betreff: '2' },
    ]);
    assert.deepEqual(e.ruheIndizes, [1], 'damit das Panel sie dauerhaft vermerken kann');
  });
});

// Der Fall aus dem Betrieb: Tagesbudget 50.000 eingestellt, Google macht bei
// gut 400 dicht. Ohne diese Bremse holt jeder folgende Lauf trotzdem 200 Mails,
// schickt 100 an die KI und stirbt dort — vier Minuten Arbeit fuer nichts.
describe('Was Google heute schon abgewiesen hat', () => {
  const heute = () => new Date().toLocaleDateString('sv-SE');
  const abweisungVon = (stand, tag = heute()) => {
    settings.setze('ki_429_tag', tag);
    settings.setze('ki_429_stand', String(stand));
  };

  test('ohne Abweisung gilt das eingestellte Budget', () => {
    settings.setze('gemini_tagesbudget', '50000');
    assert.equal(budget.beobachteteGrenze(), 0);
    assert.equal(budget.tagesbudget(), 50000);
  });

  test('die beobachtete Grenze schlaegt das eingestellte Budget', () => {
    settings.setze('gemini_tagesbudget', '50000');
    abweisungVon(412);
    assert.equal(budget.tagesbudget(), 412, 'was Google nicht gibt, hilft kein Wunschwert');
  });

  test('ein kleineres eingestelltes Budget bleibt kleiner', () => {
    settings.setze('gemini_tagesbudget', '100');
    abweisungVon(412);
    assert.equal(budget.tagesbudget(), 100, 'die Bremse darf nie lockern, nur anziehen');
  });

  test('ohne eingestelltes Budget gilt allein die Beobachtung', () => {
    settings.setze('gemini_tagesbudget', '0');
    abweisungVon(412);
    assert.equal(budget.tagesbudget(), 412);
  });

  test('die Abweisung von gestern bremst heute nicht mehr', () => {
    settings.setze('gemini_tagesbudget', '50000');
    abweisungVon(412, '2020-01-01');
    assert.equal(budget.tagesbudget(), 50000, 'Kontingente laufen taeglich neu');
  });

  test('nach der Abweisung darf keine Mail mehr an die KI', () => {
    settings.setze('gemini_tagesbudget', '50000');
    abweisungVon(3);
    budget.ausgabeMerken(3);

    const e = budget.entscheiden(kand(200));
    assert.equal(e.erlaubt.length, 0, 'der Lauf endet sofort, statt bei Gemini zu sterben');
    assert.equal(e.budget.grenze, 3);
    assert.equal(e.budget.rest, 0);
  });
});

// Googles Absage nennt das echte Limit. Die eigene Zaehlung kann es gar nicht
// treffen: Stirbt ein Lauf am Gemini-Knoten, laeuft keine der vorher sauber
// klassifizierten Mails bis zum Panel durch — protokolliert wird keine, bezahlt
// haben sie alle. Genau das ist die Luecke zwischen 412 und 500.
describe('Googles Zahl schlaegt die eigene', () => {
  const heute = () => new Date().toLocaleDateString('sv-SE');

  test('das Limit aus der Absage gilt, nicht der eigene Stand', () => {
    settings.setze('gemini_tagesbudget', '50000');
    settings.setze('ki_429_tag', heute());
    settings.setze('ki_429_stand', '412');
    settings.setze('ki_429_limit', '500');
    assert.equal(budget.beobachteteGrenze(), 500);
  });

  test('ohne Zahl in der Meldung bleibt der eigene Stand', () => {
    settings.setze('ki_429_tag', heute());
    settings.setze('ki_429_stand', '412');
    settings.setze('ki_429_limit', '0');
    assert.equal(budget.beobachteteGrenze(), 412);
  });

  test('ein Wechsel auf ein anderes Modell hebt den Deckel auf', () => {
    settings.setze('gemini_tagesbudget', '50000');
    settings.setze('ki_429_tag', heute());
    settings.setze('ki_429_limit', '500');
    settings.setze('ki_429_modell', 'gemini-3.5-flash-lite');
    settings.setze('gemini_modell_aktiv', 'gemini-3.5-flash');

    assert.equal(budget.beobachteteGrenze(), 0,
      'Kontingente gelten je Modell — sonst sperrt der Deckel genau das Ersatzmodell aus');
    assert.equal(budget.tagesbudget(), 50000);
  });

  test('solange dasselbe Modell laeuft, bleibt der Deckel', () => {
    settings.setze('ki_429_tag', heute());
    settings.setze('ki_429_limit', '500');
    settings.setze('ki_429_modell', 'gemini-3.5-flash-lite');
    settings.setze('gemini_modell_aktiv', 'gemini-3.5-flash-lite');
    assert.equal(budget.beobachteteGrenze(), 500);
  });
});

// Anfragen und Mails sind seit der Buendelung zwei verschiedene Zahlen. Googles
// Limit zaehlt Anfragen, das Protokoll zaehlt Mails. Wer sie verwechselt, bremst
// bei 500 Mails, wo 10.000 gegangen waeren.
describe('Anfragen und Mails sind zweierlei', () => {
  test('das Protokoll allein bewegt den Verbrauch nicht', () => {
    heuteLog('K', 'a@x.de', '1');
    assert.equal(budget.protokolliertHeute(), 1, 'eine Mail ist eingeordnet');
    assert.equal(budget.heuteVerbraucht(), 0, 'aber keine Anfrage vermerkt');
  });

  test('ein Vermerk summiert sich ueber die Laeufe', () => {
    budget.ausgabeMerken(7);
    budget.ausgabeMerken(3);
    assert.equal(budget.ausgegebenHeute(), 10);
    assert.equal(budget.heuteVerbraucht(), 10);
  });

  test('zwanzig Mails in einer Anfrage kosten eine', () => {
    // So rechnet der Klassifizierer: je Buendel ein Vermerk, egal wie viele
    // Mails darin stecken.
    for (let i = 0; i < 20; i += 1) heuteLog('K', `m${i}@x.de`, 'x');
    budget.ausgabeMerken(1);
    assert.equal(budget.protokolliertHeute(), 20);
    assert.equal(budget.heuteVerbraucht(), 1, 'darum geht die ganze Uebung');
  });

  test('Unsinn wird nicht vermerkt', () => {
    budget.ausgabeMerken(0);
    budget.ausgabeMerken(-5);
    budget.ausgabeMerken('viele');
    assert.equal(budget.ausgegebenHeute(), 0);
  });

  test('der Vermerk von gestern zaehlt heute nicht mehr', () => {
    budget.ausgabeMerken(101);
    settings.setze('ki_ausgabe_tag', '2020-01-01');
    assert.equal(budget.ausgegebenHeute(), 0);
  });

  test('nur die KI-Anfragen werden gemeldet, nicht die Regel-Mails', () => {
    settings.setze('gemini_tagesbudget', '50');
    const id = db.prepare(
      "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)",
    ).run().lastInsertRowid;
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'domain', 'shop.de', 'Bestellungen', 'verschieben');

    const e = budget.entscheiden([
      { konto: 'K', von: 'a@shop.de', betreff: '1' },
      { konto: 'K', von: 'b@shop.de', betreff: '2' },
      { konto: 'K', von: 'c@fremd.de', betreff: '3' },
    ]);
    assert.equal(e.erlaubt.length, 3);
    assert.equal(e.kiMails, 1, 'zwei Regel-Mails kosten Google nichts');
  });
});

// Der Deckel steht in Anfragen, das Fenster in Mails. Ohne Umrechnung boete das
// Panel bei 500 uebrigen Anfragen 500 Mails an — statt zehntausend.
describe('Von Anfragen auf Mails umrechnen', () => {
  test('eine uebrige Anfrage traegt mehrere Mails', () => {
    settings.setze('gemini_buendel', '20');
    settings.setze('gemini_tagesbudget', '2');
    const e = budget.entscheiden(kand(100));
    // Vorsichtig gerechnet mit der halben Buendelgroesse: 2 Anfragen x 10.
    assert.equal(budget.mailsJeAnfrage(), 10);
    assert.equal(e.erlaubt.length, 20);
    assert.equal(e.budget.restMails, 20);
  });

  test('keine Anfrage uebrig heisst keine Mail', () => {
    settings.setze('gemini_buendel', '20');
    settings.setze('gemini_tagesbudget', '2');
    budget.ausgabeMerken(2);
    const e = budget.entscheiden(kand(100));
    assert.equal(e.erlaubt.length, 0);
    assert.equal(e.budget.restMails, 0);
  });
});
