// Was die KI zurückgibt, ist nicht das, was das Panel bekommen wollte.
//
// Alle Fälle hier stammen aus einem einzigen Diagnose-Bericht vom 8. September:
// Ein lokal laufendes 3B-Modell (llama3.2) hat die Auswahlliste aus dem Beispiel
// wörtlich abgeschrieben, und das Panel hat sie ungeprüft in die Datenbank
// geschrieben. In der Chronik standen daraufhin Kategorien wie
// "spam|rechnung|bestellung|newsletter|persoenlich|sonstiges" — keine Weiche
// traf sie, der Newsletter-Zähler sah sie nicht, und lesen konnte man sie auch
// nicht.
//
// Worauf ein fremdes Modell antwortet, hat das Panel nicht in der Hand. Was es
// davon übernimmt, schon.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const k = require('../src/services/klassifizierer');

beforeEach(() => {
  settings.setze('ki_anbieter', 'gemini');
  settings.setze('gemini_buendel', '20');
});

describe('kategoriePruefen() — nur gültige Kategorien kommen durch', () => {
  test('die erlaubten Werte bleiben, wie sie sind', () => {
    for (const gueltig of k.KATEGORIEN) {
      assert.equal(k.kategoriePruefen(gueltig), gueltig);
    }
  });

  test('Groß- und Kleinschreibung und Leerraum stören nicht', () => {
    assert.equal(k.kategoriePruefen('  Rechnung '), 'rechnung');
    assert.equal(k.kategoriePruefen('NEWSLETTER'), 'newsletter');
  });

  // Der Fall aus dem Bericht.
  test('die abgeschriebene Auswahlliste wird zu "sonstiges"', () => {
    assert.equal(
      k.kategoriePruefen('spam|rechnung|bestellung|newsletter|persoenlich|sonstiges'),
      'sonstiges',
      'bei sechs genannten Kategorien wäre jede Wahl geraten',
    );
  });

  // Auch das stand so im Bericht: "persoenlich|Abonnements". Eine erlaubte
  // Kategorie, eine erfundene — die Absicht ist dann klar genug.
  test('steht genau eine erlaubte Kategorie darin, gilt die', () => {
    assert.equal(k.kategoriePruefen('persoenlich|Abonnements'), 'persoenlich');
    assert.equal(k.kategoriePruefen('spam, sonstiges-verdacht'), 'spam');
    assert.equal(k.kategoriePruefen('kategorie: newsletter'), 'newsletter');
  });

  test('zwei erlaubte Kategorien heißen: geraten wird nicht', () => {
    assert.equal(k.kategoriePruefen('spam|sonstiges'), 'sonstiges');
  });

  test('leer, null und Unsinn landen bei "sonstiges"', () => {
    assert.equal(k.kategoriePruefen(''), 'sonstiges');
    assert.equal(k.kategoriePruefen(null), 'sonstiges');
    assert.equal(k.kategoriePruefen(undefined), 'sonstiges');
    assert.equal(k.kategoriePruefen('Abonnements'), 'sonstiges');
    assert.equal(k.kategoriePruefen(42), 'sonstiges');
  });
});

describe('antwortZuordnen() nimmt die Prüfung mit', () => {
  const gruppen = [{}, {}];

  test('eine abgeschriebene Auswahlliste kommt geprüft heraus', () => {
    const treffer = k.antwortZuordnen([
      { nr: 1, kategorie: 'spam|rechnung|bestellung|newsletter|persoenlich|sonstiges', spam_score: 0 },
      { nr: 2, kategorie: 'rechnung', spam_score: 0.1 },
    ], gruppen);
    assert.equal(treffer.get(1).kategorie, 'sonstiges');
    assert.equal(treffer.get(2).kategorie, 'rechnung');
  });
});

describe('Der Prompt gibt kleinen Modellen keine Vorlage zum Abschreiben', () => {
  const prompt = () => k.promptBauen([], null, new Set());

  // Genau daran ist es gescheitert: "kategorie": "a|b|c" war als „eines davon"
  // gemeint und wurde wörtlich übernommen.
  test('das JSON-Beispiel enthält keine Auswahlliste mit senkrechten Strichen', () => {
    const beispiel = prompt().match(/\[\{"nr": 1[^\]]*\]/);
    assert.ok(beispiel, 'das Beispiel-Objekt fehlt im Prompt');
    assert.ok(!beispiel[0].includes('|'),
      `ein senkrechter Strich im Beispiel wird abgeschrieben: ${beispiel[0]}`);
  });

  test('das Beispiel zeigt einen gültigen Wert', () => {
    assert.match(prompt(), /"kategorie": "newsletter"/);
  });

  test('die erlaubten Werte stehen trotzdem im Prompt', () => {
    const p = prompt();
    for (const kat of k.KATEGORIEN) assert.ok(p.includes(kat), `${kat} fehlt im Prompt`);
  });
});

describe('Bündelgröße: bei der lokalen KI kleiner', () => {
  // Gebündelt wird, weil Googles Limit Anfragen zählt. Ollama zählt nichts —
  // übrig bleibt, dass eine Anfrage über zwanzig Mails minutenlang rechnet und
  // bei einem Zeitlimit alle zwanzig mitreißt.
  test('mit Gemini gilt der eingestellte Wert', () => {
    assert.equal(k.buendelGroesse(), 20);
  });

  test('mit Ollama wird gedeckelt', () => {
    settings.setze('ki_anbieter', 'ollama');
    assert.ok(k.buendelGroesse() <= 5, `20er-Bündel sind für die lokale KI zu groß (${k.buendelGroesse()})`);
  });

  test('ein kleinerer eingestellter Wert wird nicht heraufgesetzt', () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('gemini_buendel', '3');
    assert.equal(k.buendelGroesse(), 3);
  });
});
