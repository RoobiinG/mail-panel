const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const k = require('../src/services/klassifizierer');

describe('Fehlertolerante Antwortzuordnung (Ollama / kleine Modelle)', () => {
  test('Einzel-Mail-Garantie: Modell liefert nr: 0 (der reale Fall aus den Logs)', () => {
    // Bei 1 Mail in der Anfrage lieferte llama3.2:1b "nr: 0"
    const gruppen = [{ vertreter: { von: 'a@test.de', betreff: 'Hallo' } }];
    const antwortDaten = {
      mails: [
        { nr: 0, kategorie: 'newsletter', spam_score: 0.1, kurzfassung: 'Info', ordner: 'News', konfidenz: 0.9 },
      ],
    };

    const treffer = k.antwortZuordnen(antwortDaten, gruppen);
    assert.equal(treffer.size, 1, 'Die Klassifizierung darf nicht verworfen werden');
    const mail1 = treffer.get(1);
    assert.ok(mail1, 'Muss Mail 1 zugeordnet sein');
    assert.equal(mail1.kategorie, 'newsletter');
    assert.equal(mail1.ordner, 'News');
    assert.equal(mail1.konfidenz, 0.9);
  });

  test('Einzel-Mail-Garantie: Modell liefert erfundene ID statt nr', () => {
    const gruppen = [{ vertreter: { von: 'b@test.de', betreff: 'Rechnung' } }];
    const antwortDaten = {
      mails: [
        { nr: 89765, kategorie: 'rechnung', spam_score: 0, kurzfassung: 'Rechnung', ordner: 'Rechnungen', konfidenz: 0.95 },
      ],
    };

    const treffer = k.antwortZuordnen(antwortDaten, gruppen);
    assert.equal(treffer.size, 1);
    assert.equal(treffer.get(1).kategorie, 'rechnung');
  });

  test('0-basierte Indizierung bei mehreren Mails wird automatisch korrigiert', () => {
    const gruppen = [
      { vertreter: { von: 'a@test.de' } },
      { vertreter: { von: 'b@test.de' } },
    ];
    const antwortDaten = [
      { nr: 0, kategorie: 'newsletter', spam_score: 0.2 },
      { nr: 1, kategorie: 'rechnung', spam_score: 0.0 },
    ];

    const treffer = k.antwortZuordnen(antwortDaten, gruppen);
    assert.equal(treffer.size, 2);
    assert.equal(treffer.get(1).kategorie, 'newsletter');
    assert.equal(treffer.get(2).kategorie, 'rechnung');
  });

  test('Positions-Fallback, wenn nr ganz fehlt oder außerhalb liegt', () => {
    const gruppen = [
      { vertreter: { von: 'x@test.de' } },
      { vertreter: { von: 'y@test.de' } },
    ];
    const antwortDaten = {
      mails: [
        { kategorie: 'bestellung', spam_score: 0.05 }, // ohne nr
        { nr: 999, kategorie: 'persoenlich', spam_score: 0.0 }, // ungültige nr
      ],
    };

    const treffer = k.antwortZuordnen(antwortDaten, gruppen);
    assert.equal(treffer.size, 2);
    assert.equal(treffer.get(1).kategorie, 'bestellung');
    assert.equal(treffer.get(2).kategorie, 'persoenlich');
  });

  test('antwortSchema bindet Ollama auf minimum 1', () => {
    const schema = k.antwortSchema(5);
    const nrProp = schema.properties.mails.items.properties.nr;
    assert.equal(nrProp.minimum, 1);
    assert.equal(nrProp.maximum, 5);
  });
});
