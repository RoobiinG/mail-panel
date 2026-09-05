// Absender-Erkennung und Regel-Vergleich.
//
// Jeder Fall hier stand einmal für einen echten Fehler. Die Sammlung ist
// deshalb keine Pflichtübung, sondern das Gedächtnis des Projekts: Was hier
// steht, ist schon einmal schiefgegangen.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const s = require('../src/services/sortierung');

describe('adresse() — die echte Adresse aus einem Von-Feld holen', () => {
  test('nackte Adresse', () => {
    assert.equal(s.adresse('max@example.com'), 'max@example.com');
  });

  test('Anzeigename davor', () => {
    assert.equal(s.adresse('Max Mustermann <max@example.com>'), 'max@example.com');
  });

  test('Groß-/Kleinschreibung und Leerraum spielen keine Rolle', () => {
    assert.equal(s.adresse('  MAX@Example.COM  '), 'max@example.com');
  });

  // Der Angriff: Der Anzeigename sieht aus wie eine vertrauenswürdige Adresse,
  // die echte steht hinten. Wer den Anfang nimmt, sortiert nach der Fälschung.
  test('gefälschter Anzeigename zählt nicht — die echte Adresse steht hinten', () => {
    assert.equal(
      s.adresse('"rechnung@sparkasse.de" <betrueger@boese.example>'),
      'betrueger@boese.example',
    );
    assert.equal(
      s.adresse('service@paypal.com <phish@anderswo.example>'),
      'phish@anderswo.example',
    );
  });

  test('mehrere spitze Klammern: die letzte gilt', () => {
    assert.equal(
      s.adresse('<harmlos@gut.example> Dings <echt@boese.example>'),
      'echt@boese.example',
    );
  });
});

describe('domain() — die Domain hinter der Adresse', () => {
  test('einfacher Fall', () => {
    assert.equal(s.domain('max@example.com'), 'example.com');
  });
  test('mit Anzeigename', () => {
    assert.equal(s.domain('Max <max@sub.example.com>'), 'sub.example.com');
  });
});

describe('passt() — greift eine Regel?', () => {
  const regel = (typ, muster) => ({ typ, muster, zielordner: 'Egal' });

  test('exakter Absender', () => {
    assert.equal(s.passt(regel('absender', 'max@example.com'), 'Max <max@example.com>', ''), true);
    assert.equal(s.passt(regel('absender', 'max@example.com'), 'erik@example.com', ''), false);
  });

  test('Domain greift auch für Unterdomains', () => {
    const r = regel('domain', 'example.com');
    assert.equal(s.passt(r, 'a@example.com', ''), true);
    assert.equal(s.passt(r, 'a@post.example.com', ''), true);
  });

  // Der Angriff: "example.com.boese.example" endet auf nichts, was zur Regel
  // gehört — enthält sie aber. Ein simples includes() wäre hier eingebrochen.
  test('angehängte Fremddomain greift NICHT', () => {
    const r = regel('domain', 'example.com');
    assert.equal(s.passt(r, 'a@example.com.boese.example', ''), false);
    assert.equal(s.passt(r, 'a@nichtexample.com', ''), false);
    assert.equal(s.passt(r, 'a@boeseexample.com', ''), false);
  });

  test('Betreff-Regel, Groß-/Kleinschreibung egal', () => {
    const r = regel('betreff', 'rechnung');
    assert.equal(s.passt(r, 'a@b.example', 'Ihre RECHNUNG Nr. 5'), true);
    assert.equal(s.passt(r, 'a@b.example', 'Newsletter'), false);
  });

  test('leere Angaben werfen nicht', () => {
    assert.doesNotThrow(() => s.passt(regel('domain', 'x.example'), null, null));
    assert.doesNotThrow(() => s.passt(regel('absender', ''), '', ''));
  });
});

describe('uidZahl() — der Grund für die Dubletten in der Sortier-Inbox', () => {
  // Ältere Zeilen trugen die UID als "28.0", neuere als "28". Als Text sind
  // das zwei verschiedene Werte — daran lief die Dubletten-Erkennung vorbei,
  // und dieselbe Mail landete immer wieder neu in der Liste.
  test('"28" und "28.0" sind dieselbe UID', () => {
    assert.equal(s.uidZahl('28'), 28);
    assert.equal(s.uidZahl('28.0'), 28);
    assert.equal(s.uidZahl(28), 28);
    assert.equal(s.uidZahl(28.0), 28);
  });

  test('Unbrauchbares ergibt null, nicht NaN oder 0', () => {
    for (const wert of [null, undefined, '', 'abc', '0', 0, -5, {}, []]) {
      assert.equal(s.uidZahl(wert), null, `uidZahl(${JSON.stringify(wert)}) sollte null sein`);
    }
  });
});

// regelTreffer beantwortet nur die Frage "greift hier eine Regel?". Der
// Treffer-Zaehler soll zeigen, wie oft eine Regel wirklich sortiert hat — nicht
// wie oft jemand nachgesehen hat. Seit /einsortieren und der Budget-Waechter
// bei jeder Mail nachfragen, waere der Zaehler sonst dreimal so hoch.
const db = require('../src/db');

describe('regelTreffer', () => {
  test('findet die erste passende Regel, ohne zu zaehlen', () => {
    const konto = db.prepare(
      "INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
      + " VALUES ('Z', 'h', 993, 'u', 'x', 1)",
    ).run().lastInsertRowid;
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(konto, 'domain', 'zaehl.de', 'Ordner', 'verschieben');

    const treffer = s.regelTreffer(konto, 'a@zaehl.de', 'x');
    assert.ok(treffer, 'die Regel passt');
    assert.equal(treffer.zielordner, 'Ordner');
    assert.equal(s.regelTreffer(konto, 'a@woanders.de', 'x'), null);

    const zeile = db.prepare('SELECT treffer FROM sort_rules WHERE konto_id = ?').get(konto);
    assert.equal(zeile.treffer, 0, 'nur pruefeRegeln darf den Zaehler hochsetzen');
  });
});
