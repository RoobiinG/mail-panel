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
  db.prepare("DELETE FROM settings WHERE key='gemini_tagesbudget'").run();
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
    heuteLog('K', 'schon@x.de', 'egal');  // 1 heute schon verbraucht
    heuteLog('K', 'auch@x.de', 'egal');   // 2
    const e = budget.entscheiden(kand(10));
    assert.equal(e.erlaubt.length, 3, '5 minus 2 bereits verbraucht');
    assert.equal(e.budget.verbraucht, 2);
    assert.equal(e.budget.rest, 3);
  });

  test('aufgebrauchtes Budget lässt nichts mehr durch', () => {
    settings.setze('gemini_tagesbudget', '2');
    heuteLog('K', 'a@x.de', 'x'); heuteLog('K', 'b@x.de', 'y');
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
