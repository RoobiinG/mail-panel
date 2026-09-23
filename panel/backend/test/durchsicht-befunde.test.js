// Kleinere Befunde aus der Durchsicht nach dem Diagnosebericht vom 23.09. —
// jeder hier festgenagelt, damit er nicht zurückkommt.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const k = require('../src/services/klassifizierer');
const nachsortierung = require('../src/services/nachsortierung');
const paste = require('../src/routes/paste');
const konten = require('../src/routes/konten');

describe('Links im Prompt', () => {
  // Drei Tracking-Links machten aus einer Mail 4.518 statt ~1.350 Token — das
  // Bündel lief am Proxy in den 504, und der Lauf schrumpfte auf Bündel zu eins.
  const ohneThemen = { text: '', namen: null, neuErlaubt: false };
  const prompt = (links) => k.promptBauen(
    [{ vertreter: { von: 'a@b.de', betreff: 'x', text: 'Text', links } }], null, new Set(), ohneThemen,
  );

  test('der Query-String fällt weg, Host und Pfad bleiben', () => {
    const p = prompt([`https://track.example/click?u=${'x'.repeat(2500)}&id=1`]);
    assert.match(p, /Links: https:\/\/track\.example\/click\n/);
    assert.ok(!p.includes('xxxxxxxxxx'), 'die Kampagnen-Kennung gehört nicht in den Prompt');
  });

  test('ein sehr langer Pfad wird gekappt', () => {
    const p = prompt([`https://safelinks.example/${'a'.repeat(3000)}`]);
    const zeile = p.split('\n').find((z) => z.startsWith('Links: '));
    assert.ok(zeile.length < 100, `Link-Zeile zu lang: ${zeile.length}`);
  });

  test('höchstens drei Links', () => {
    const p = prompt(['https://a.de/1', 'https://a.de/2', 'https://a.de/3', 'https://a.de/4']);
    assert.match(p, /Links: https:\/\/a\.de\/1 https:\/\/a\.de\/2 https:\/\/a\.de\/3\n/);
  });

  test('spam_score ist Pflicht — ohne ihn galt eine Phishing-Mail als harmlos', () => {
    assert.ok(k.antwortSchema().properties.mails.items.required.includes('spam_score'));
  });
});

describe('Nachsortierung ohne Mailtext', () => {
  // Bis Build 251 gewann bei einer Regel mit Inhalts-Stichwort die nächste
  // Regel — und Rechnungen wanderten jede Nacht aus „Rechnungen" hinaus.
  const regeln = [
    { id: 1, typ: 'absender', muster: 'info@versand.example', inhalt_muster: 'rechnung', zielordner: 'Rechnungen' },
    { id: 2, typ: 'absender', muster: 'info@versand.example', zielordner: 'Newsletter' },
  ];

  test('steht das Stichwort nicht im Betreff, ist die Mail nicht entscheidbar', () => {
    const r = nachsortierung.regelFuerBriefkopf(regeln, 'info@versand.example', 'Ihr Beleg 42');
    assert.deepEqual(r, { unentscheidbar: true }, 'nicht die Newsletter-Regel');
  });

  test('steht es im Betreff, gilt die Inhalts-Regel', () => {
    const r = nachsortierung.regelFuerBriefkopf(regeln, 'info@versand.example', 'Ihre Rechnung 42');
    assert.equal(r.id, 1);
  });

  test('ein anderer Absender ist davon nicht betroffen', () => {
    assert.equal(nachsortierung.regelFuerBriefkopf(regeln, 'x@y.example', 'Rechnung'), null);
  });
});

describe('Geteilte Berichte (Paste)', () => {
  // SQLite schreibt UTC ohne Zeitzone. Als Ortszeit gelesen, lief ein Bericht
  // mit TZ=Europe/Berlin ein bis zwei Stunden zu früh ab.
  test('das Alter wird als UTC gerechnet', () => {
    const vorEinerStunde = new Date(Date.now() - 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const alter = paste.alterMs(vorEinerStunde);
    assert.ok(alter > 3500 * 1000 && alter < 3700 * 1000, `falsches Alter: ${alter}`);
  });

  test('Unlesbares gilt als abgelaufen', () => {
    assert.equal(paste.alterMs('kaputt'), Infinity);
  });
});

describe('Ansichten sind keine Zielordner', () => {
  const test_ = { ansichten: ['[Gmail]/Markiert', '[Gmail]/Alle Nachrichten'] };

  test('„[Gmail]/Markiert" als Archiv wird erkannt', () => {
    assert.equal(konten.ansichtAlsZiel(test_, { folder_archive: '[Gmail]/Markiert' }), '[Gmail]/Markiert');
  });

  test('ein echter Ordner geht durch', () => {
    assert.equal(konten.ansichtAlsZiel(test_, { folder_archive: 'Archiv', folder_spam: '[Gmail]/Spam' }), null);
  });

  test('ohne Verbindungstest wird nichts behauptet', () => {
    assert.equal(konten.ansichtAlsZiel({}, { folder_archive: '[Gmail]/Markiert' }), null);
  });
});
