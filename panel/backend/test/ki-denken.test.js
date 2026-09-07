// Ein denkendes Modell hat die Sortierung stillgelegt — ohne einen einzigen
// Fehler zu melden.
//
// Gemini 3.7 und 3.8 Flash denken von Haus aus und zahlen das aus demselben
// Ausgabebudget, aus dem die Antwort kommt. Aus einem echten Test kam zurueck:
//
//   "candidates": [{ "content": {}, "finishReason": "MAX_TOKENS" }],
//   "usageMetadata": { "thoughtsTokenCount": 5 }
//
// Also: nachgedacht, nichts gesagt. Der Klassifizierer bekam keine Antwort, die
// Mails blieben liegen, und die Laeufe meldeten "erfolgreich". Genau diese
// Kombination — kein Fehler, kein Ergebnis — ist die teuerste.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const kiText = require('../src/services/kiText');

let gesendet;
function antwortenMit(status, koerper) {
  gesendet = [];
  global.fetch = async (url, opt) => {
    gesendet.push({ url: String(url), body: JSON.parse(opt.body) });
    return {
      ok: status === 200,
      status,
      json: async () => koerper,
      text: async () => (typeof koerper === 'string' ? koerper : JSON.stringify(koerper)),
    };
  };
}

const gut = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] };

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_%'").run();
  settings.setze('gemini_api_key', 'schluessel');
});

describe('Die Denkstufe geht mit', () => {
  test('von Haus aus niedrig', async () => {
    antwortenMit(200, gut);
    await kiText.frageJson('hallo');
    assert.equal(gesendet[0].body.generationConfig.thinking_level, 'low',
      'ohne das verbraucht ein denkendes Modell sein Budget mit Nachdenken');
  });

  test('und es gibt Platz fuer die Antwort', async () => {
    antwortenMit(200, gut);
    await kiText.frageJson('hallo');
    assert.equal(gesendet[0].body.generationConfig.maxOutputTokens, 8192);
  });

  test('auf "aus" gestellt wird das Feld weggelassen', async () => {
    settings.setze('gemini_denkstufe', 'aus');
    antwortenMit(200, gut);
    await kiText.frageJson('hallo');
    assert.equal('thinking_level' in gesendet[0].body.generationConfig, false,
      'manche Modelle kennen das Feld nicht — dann darf es gar nicht erst mitgehen');
  });

  test('Unsinn in der Einstellung zaehlt als "aus"', async () => {
    settings.setze('gemini_denkstufe', 'sehr viel bitte');
    antwortenMit(200, gut);
    await kiText.frageJson('hallo');
    assert.equal('thinking_level' in gesendet[0].body.generationConfig, false);
  });
});

describe('Kennt das Modell die Denkstufe nicht', () => {
  test('wird einmal ohne sie nachgefragt — und kuenftig weggelassen', async () => {
    let ruf = 0;
    global.fetch = async (url, opt) => {
      ruf += 1;
      const body = JSON.parse(opt.body);
      if (ruf === 1) {
        assert.ok('thinking_level' in body.generationConfig);
        return {
          ok: false, status: 400,
          text: async () => '{"error":{"message":"Unknown name \\"thinking_level\\""}}',
        };
      }
      assert.equal('thinking_level' in body.generationConfig, false, 'der zweite Versuch ohne');
      return { ok: true, status: 200, json: async () => gut };
    };

    const a = await kiText.frageJson('hallo');
    assert.equal(a.ok, true, 'ein unbekanntes Feld darf nicht die ganze Sortierung stoppen');
    assert.equal(ruf, 2);
    assert.equal(settings.hole('gemini_denkstufe'), 'aus', 'gemerkt, nicht bei jeder Mail neu');
  });
});

describe('Wenn doch nur nachgedacht wurde', () => {
  test('sagt die Meldung, was los war', async () => {
    antwortenMit(200, {
      candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 5 },
    });
    const a = await kiText.frageJson('hallo');
    assert.equal(a.ok, false);
    assert.equal(a.abgeschnitten, true);
    assert.match(a.fehler, /abgeschnitten/);
    assert.match(a.fehler, /5 Token/, 'die Gedanken gehoeren in die Meldung — sie sind die Ursache');
  });

  test('ein anderer unlesbarer Fall nennt wenigstens den Grund', async () => {
    antwortenMit(200, { candidates: [{ content: { parts: [{ text: 'kein JSON' }] }, finishReason: 'SAFETY' }] });
    const a = await kiText.frageJson('hallo');
    assert.equal(a.ok, false);
    assert.match(a.fehler, /SAFETY/);
    assert.notEqual(a.abgeschnitten, true);
  });
});
