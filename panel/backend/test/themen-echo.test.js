// Wenn das Modell die Prompt-Zeile zurückschickt statt einer Entscheidung.
//
// Aus dem Betrieb am 14.09., dreimal dieselbe Mail eines Versandhändlers in
// einem Lauf:
//
//     thema: "Anbieter, Vertraege und co. — E-Mails von Unternehmen und Dienstleistern, die mi"
//     zielordner: "Anbieter, Vertraege und co."   grund: "Vorhandener Themen-Ordner"
//
// Genau 50 Zeichen Beschreibung, mitten im Wort abgeschnitten — die Länge, auf
// die der Prompt sie für die lokale KI kappt. Das ist keine Einordnung, das ist
// ein Echo der Zeile, die im Prompt steht.
//
// Und es traf trotzdem: aehnlich() hält den kürzeren Begriff, der vollständig
// im längeren steckt, für dasselbe — der Name steht ja am Anfang der Zeile. So
// landeten 42 Mails in einem Ordner für Telefon- und Streaming-Verträge,
// darunter Versandbestätigungen.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const themen = require('../src/services/themen');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const ordner = (name, beschreibung = null, treffer = 0) => db.prepare(
  'INSERT INTO konto_ordner (konto_id, ordner, beschreibung, treffer) VALUES (?, ?, ?, ?)',
).run(kontoId(), name, beschreibung, treffer);

beforeEach(() => {
  db.exec('DELETE FROM konto_ordner; DELETE FROM accounts; DELETE FROM ordner_vorschlaege;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('vorschlagSaeubern() — nur der Name, nie die Erklärung', () => {
  const sauber = themen.vorschlagSaeubern;

  test('der Fall aus dem Betrieb', () => {
    assert.equal(
      sauber('Anbieter, Vertraege und co. — E-Mails von Unternehmen und Dienstleistern, die mi'),
      'Anbieter, Vertraege und co.',
    );
  });

  test('egal welcher Gedankenstrich — Modelle schreiben ihn gern um', () => {
    assert.equal(sauber('Games – Steam, Epic, Konsolen'), 'Games');
    assert.equal(sauber('Games - Steam, Epic, Konsolen'), 'Games');
    assert.equal(sauber('Games — Steam, Epic, Konsolen'), 'Games');
  });

  test('die neue Form mit Doppelpunkt und Anführungszeichen', () => {
    assert.equal(sauber('"Games": Steam, Epic, Konsolen'), 'Games');
    assert.equal(sauber('- "Finanzen": Bank und Versicherung'), 'Finanzen');
    assert.equal(sauber('Finanzen · bisher hier gelandet: bank.example'), 'Finanzen');
  });

  test('ein sauberer Name bleibt Zeichen für Zeichen derselbe', () => {
    assert.equal(sauber('Games'), 'Games');
    assert.equal(sauber('Anbieter, Vertraege und co.'), 'Anbieter, Vertraege und co.');
    assert.equal(sauber('Haus-Kram'), 'Haus-Kram', 'Bindestrich ohne Leerzeichen trennt nicht');
    assert.equal(sauber('Deutsche Post & DHL'), 'Deutsche Post & DHL');
  });

  // "NEU:Games" ist die vereinbarte Form für einen Vorschlag. Würde der
  // Doppelpunkt hier trennen, bliebe davon "NEU" übrig.
  test('die Vorschlagsform überlebt', () => {
    assert.equal(sauber('NEU:Sport'), 'Sport');
    assert.equal(sauber('NEU: Sport'), 'Sport');
    assert.equal(sauber('NEU: Sport & Freizeit'), 'Sport & Freizeit');
  });

  test('nichts drin, nichts raus', () => {
    assert.equal(sauber(''), '');
    assert.equal(sauber(null), '');
    assert.equal(sauber('   '), '');
  });
});

describe('imKatalog() — das Echo trifft nicht mehr irgendeinen Ordner', () => {
  test('die Erklärung zieht keinen fremden Ordner mehr heran', () => {
    ordner('Anbieter, Vertraege und co.', 'E-Mails von Unternehmen und Dienstleistern, die mit Vertraegen zu tun haben', 42);
    ordner('Einkauf', 'Bestellungen und Lieferungen', 3);

    const echo = 'Anbieter, Vertraege und co. — E-Mails von Unternehmen und Dienstleistern, die mi';
    assert.equal(themen.imKatalog(kontoId(), echo).ordner, 'Anbieter, Vertraege und co.',
      'der Name am Anfang stimmt ja — er soll nur nicht über die Erklärung gefunden werden');
  });

  test('ein Echo, dessen Name gar nicht im Katalog steht, trifft nichts', () => {
    ordner('Einkauf', 'Bestellungen und Lieferungen');
    // Früher fand das über die gemeinsamen Wörter der Beschreibung trotzdem
    // einen Ordner — irgendeinen.
    assert.equal(
      themen.imKatalog(kontoId(), 'Streaming: Bestellungen und Lieferungen sind hier falsch'),
      null,
    );
  });

  test('ein Ordner mit Gedankenstrich im Namen wird exakt getroffen', () => {
    ordner('Verträge - Wichtig');
    assert.equal(themen.imKatalog(kontoId(), 'Verträge - Wichtig').ordner, 'Verträge - Wichtig',
      'exakt geht vor gesäubert, sonst bliebe hier „Verträge" übrig');
  });

  test('die Ähnlichkeitssuche arbeitet weiter', () => {
    ordner('Games');
    assert.equal(themen.imKatalog(kontoId(), 'Gaming').ordner, 'Games');
    assert.equal(themen.imKatalog(kontoId(), '"Gaming": Steam und Epic').ordner, 'Games');
  });
});

describe('fuerPrompt() — die Reihenfolge ist kein Signal', () => {
  // Vorher stand der meistgenutzte Ordner oben. Ein Modell, das nicht wirklich
  // entscheidet, nimmt den ersten Eintrag — der bekam dadurch noch mehr Treffer
  // und stand beim nächsten Lauf noch sicherer oben. Wer die Position als
  // Signal benutzt, darf sie nicht aus dem Ergebnis ableiten.
  test('ausgegeben wird alphabetisch, nicht nach Treffern', () => {
    ordner('Zeitungen', null, 500);
    ordner('Arbeit', null, 1);
    ordner('Mitte', null, 50);

    const namen = themen.fuerPrompt(kontoId()).map((o) => o.name);
    assert.deepEqual(namen, ['Arbeit', 'Mitte', 'Zeitungen']);
  });

  // Ausgewählt wird weiter nach Treffern: Bei der lokalen KI passen nur 15
  // Ordner in den Prompt, und dann sollen es die wichtigen sein.
  test('ausgewählt wird weiter nach Treffern', () => {
    ordner('Aaa selten', null, 0);
    ordner('Bbb selten', null, 0);
    ordner('Zzz oft', null, 99);

    const namen = themen.fuerPrompt(kontoId(), 1).map((o) => o.name);
    assert.deepEqual(namen, ['Zzz oft'], 'die Obergrenze darf nicht nach Anfangsbuchstabe aussieben');
  });

  test('die Obergrenze gilt samt wartender Vorschläge', () => {
    ordner('Alpha', null, 9);
    db.prepare("INSERT INTO ordner_vorschlaege (konto_id, ordner, anzahl, status) VALUES (?, 'Beta', 2, 'offen')")
      .run(kontoId());
    assert.equal(themen.fuerPrompt(kontoId(), 1).length, 1);
    assert.equal(themen.fuerPrompt(kontoId(), 5).length, 2);
  });
});
