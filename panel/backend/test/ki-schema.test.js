// Ein Schema statt einer Bitte.
//
// Der Befund vom 8. September, 22:04 bis 22:06: dreizehn Antworten von
// llama3.2:1b, jede in rund zwoelf Sekunden, und danach im Log
// „0 von 19 Mails klassifiziert". Die KI hat geantwortet — nur nichts, was
// sich zuordnen liess.
//
// `format: 'json'` erzwingt GUELTIGES JSON, aber nicht die richtige FORM. Ein
// grosses Modell haelt sich trotzdem an das Beispiel im Prompt; ein kleines
// antwortet, was ihm einfaellt. Ollama kann stattdessen ein Schema entgegen-
// nehmen und daraus eine Grammatik bauen — dann KANN das Modell nichts anderes
// mehr erzeugen.
//
// Diese Datei prueft beides: dass das Schema mitgeschickt wird, und dass die
// Zuordnung als Netz darunter auch die Formen versteht, die ein Modell ohne
// Schema produziert.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const kiText = require('../src/services/kiText');
const k = require('../src/services/klassifizierer');

beforeEach(() => {
  settings.setze('ki_anbieter', 'ollama');
  settings.setze('ollama_url', 'http://ollama:11434');
  settings.setze('ollama_modell', 'llama3.2:1b');
});

describe('Das Schema geht an Ollama mit', () => {
  const abfangen = async (opt) => {
    let gesendet = null;
    const alt = global.fetch;
    global.fetch = async (_, init) => {
      gesendet = JSON.parse(init.body);
      return { ok: true, json: async () => ({ response: '{"mails":[]}', done: true }) };
    };
    try { await kiText.frageJson('frage', opt); } finally { global.fetch = alt; }
    return gesendet;
  };

  test('mit Schema steht es im format-Feld', async () => {
    const schema = k.antwortSchema();
    const gesendet = await abfangen({ schema });
    assert.deepEqual(gesendet.format, schema,
      'ohne das ist "antworte bitte im Format X" nur eine Bitte');
  });

  test('ohne Schema bleibt es beim alten json', async () => {
    assert.equal((await abfangen({})).format, 'json');
  });

  // Gemini bekommt kein Ollama-Schema — dort steuert responseMimeType das
  // Format, und ein unbekanntes Feld waere ein Fehler.
  test('bei Gemini wird es nicht mitgeschickt', async () => {
    settings.setze('ki_anbieter', 'gemini');
    settings.setze('gemini_api_key', 'x');
    let gesendet = null;
    const alt = global.fetch;
    global.fetch = async (_, init) => {
      gesendet = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
      };
    };
    try {
      await kiText.frageJson('frage', { schema: k.antwortSchema() });
    } finally { global.fetch = alt; }
    assert.equal(gesendet.format, undefined);
    assert.equal(gesendet.generationConfig.responseMimeType, 'application/json');
  });
});

describe('Das Schema beschreibt, was der Klassifizierer braucht', () => {
  const s = () => k.antwortSchema();

  test('eine Liste unter "mails"', () => {
    assert.equal(s().properties.mails.type, 'array');
    assert.ok(s().required.includes('mails'));
  });

  test('nr, kategorie und konfidenz sind Pflicht', () => {
    const pflicht = s().properties.mails.items.required;
    for (const feld of ['nr', 'kategorie', 'konfidenz']) {
      assert.ok(pflicht.includes(feld), `${feld} fehlt in required`);
    }
  });

  // Genau hier hat ein Modell schon einmal die Auswahlliste woertlich
  // abgeschrieben — "spam|rechnung|bestellung|…" stand als Kategorie in der
  // Datenbank. Ein enum macht das unmoeglich.
  test('kategorie ist auf die erlaubten Werte festgelegt', () => {
    assert.deepEqual(s().properties.mails.items.properties.kategorie.enum, k.KATEGORIEN);
  });

  test('nr ist eine ganze Zahl', () => {
    assert.equal(s().properties.mails.items.properties.nr.type, 'integer');
  });

  // Prompt und Schema duerfen nicht auseinanderlaufen, sonst kaempft das Modell
  // gegen die Grammatik statt mit ihr.
  test('der Prompt verlangt dieselbe Form', () => {
    const p = k.promptBauen([{ vertreter: { von: 'a@b.de', betreff: 'B' }, mitglieder: [] }], null, new Set());
    assert.match(p, /"mails"/, 'der Prompt muss das Feld nennen, das das Schema erzwingt');
  });
});

describe('Die Zuordnung versteht auch unverpackte Antworten', () => {
  const gruppen = (n) => Array.from({ length: n }, () => ({ mitglieder: [] }));
  const eintrag = (nr) => ({ nr, kategorie: 'newsletter', konfidenz: 0.8 });

  test('ein blankes Array', () => {
    const t = k.antwortZuordnen([eintrag(1), eintrag(2)], gruppen(2));
    assert.equal(t.size, 2);
  });

  test('unter "mails" — die Form, die das Schema erzwingt', () => {
    assert.equal(k.antwortZuordnen({ mails: [eintrag(1)] }, gruppen(1)).size, 1);
  });

  // Ein kleines Modell ohne Schema verpackt die Liste, wie es ihm einfaellt.
  // Vorher fiel das alles still durch.
  test('unter irgendeinem anderen Feldnamen', () => {
    for (const feld of ['emails', 'classifications', 'ergebnisse', 'result']) {
      const t = k.antwortZuordnen({ [feld]: [eintrag(1), eintrag(2)] }, gruppen(2));
      assert.equal(t.size, 2, `${feld} wurde verworfen`);
    }
  });

  test('nach Nummern geschlüsselt', () => {
    const t = k.antwortZuordnen(
      { 1: { kategorie: 'spam', konfidenz: 0.9 }, 2: { kategorie: 'newsletter', konfidenz: 0.5 } },
      gruppen(2),
    );
    assert.equal(t.size, 2);
    assert.equal(t.get(1).kategorie, 'spam');
    assert.equal(t.get(2).kategorie, 'newsletter');
  });

  test('ein einzelnes Objekt bei einem Bündel aus einer Mail', () => {
    const t = k.antwortZuordnen({ kategorie: 'rechnung', konfidenz: 0.7 }, gruppen(1));
    assert.equal(t.size, 1);
    assert.equal(t.get(1).kategorie, 'rechnung');
  });

  // Bei mehreren waere es Raten, und eine falsch zugeordnete Antwort schiebt
  // eine Mail in den falschen Ordner — das merkt niemand.
  test('bei mehreren Mails wird ein einzelnes Objekt NICHT geraten', () => {
    assert.equal(k.antwortZuordnen({ kategorie: 'rechnung', konfidenz: 0.7 }, gruppen(3)).size, 0);
  });

  test('fehlt die nr, zählt die Reihenfolge', () => {
    const t = k.antwortZuordnen(
      { mails: [{ kategorie: 'spam', konfidenz: 1 }, { kategorie: 'newsletter', konfidenz: 0.4 }] },
      gruppen(2),
    );
    assert.equal(t.size, 2);
    assert.equal(t.get(1).kategorie, 'spam');
    assert.equal(t.get(2).kategorie, 'newsletter');
  });

  test('eine mitgelieferte nr schlägt die Reihenfolge', () => {
    const t = k.antwortZuordnen({ mails: [eintrag(2), eintrag(1)] }, gruppen(2));
    assert.equal(t.size, 2);
  });

  test('Unsinn bleibt Unsinn', () => {
    for (const daten of [null, undefined, 'text', 42, {}, { mails: [] }]) {
      assert.equal(k.antwortZuordnen(daten, gruppen(2)).size, 0);
    }
  });

  test('eine nr außerhalb des Bündels wird verworfen', () => {
    assert.equal(k.antwortZuordnen({ mails: [eintrag(99)] }, gruppen(2)).size, 0);
  });
});
