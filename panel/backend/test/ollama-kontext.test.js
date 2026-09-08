// Ollama muss sagen dürfen, wie groß sein Fenster ist — sonst schneidet es.
//
// Gemini nimmt entgegen, was kommt, und meldet hinterher „MAX_TOKENS", wenn die
// ANTWORT nicht mehr passte. Ollama hat ein festes Fenster für Frage und
// Antwort zusammen und wirft weg, was vorne nicht hineinpasst: ohne Fehler,
// ohne Hinweis, ohne Spur in der Antwort.
//
// Im Betrieb sah das so aus (Bericht vom 8. September):
//
//     "gruende7Tage": [ { "grund": "Kein Thema erkannt", "anzahl": 166 } ]
//     "konfidenz": 0   — bei jeder einzelnen der letzten zehn Entscheidungen
//
// Das Modell hatte die Anweisung nie gelesen, nur den Schwanz der Mailliste.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const kiText = require('../src/services/kiText');
const patcher = require('../src/services/workflowPatcher');

const OLLAMA_URL = 'http://ollama:11434/api/generate';
const altesOllamaBody = "={{ JSON.stringify({ model: 'llama3.2:latest', prompt: String($json.promptText || ''), stream: false, format: 'json', options: { temperature: 0.1 } }) }}";

const knotenMit = (body, url) => ({
  nodes: [{
    parameters: { url, jsonBody: body },
    id: 'ki-1',
    name: 'Gemini klassifizieren',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [0, 0],
  }],
  connections: {},
});

beforeEach(() => {
  settings.setze('ki_anbieter', 'ollama');
  settings.setze('ollama_url', 'http://ollama:11434');
  settings.setze('ollama_modell', 'llama3.2:latest');
  settings.setze('ollama_kontext', '');
});

describe('Das Kontextfenster ist eine Einstellung mit Grenzen', () => {
  test('ohne Angabe gilt der Standard', () => {
    assert.equal(kiText.kontextFenster(), kiText.KONTEXT_STANDARD);
  });

  test('ein eingetragener Wert zählt', () => {
    settings.setze('ollama_kontext', '16384');
    assert.equal(kiText.kontextFenster(), 16384);
  });

  // Unter 2048 passt nicht einmal die Anweisung; über 32768 belegt das Modell
  // mehr Arbeitsspeicher, als ein kleiner Server hat, und wird OOM-getötet.
  test('Unsinn wird eingefangen, nicht durchgereicht', () => {
    settings.setze('ollama_kontext', '8');
    assert.equal(kiText.kontextFenster(), 2048);
    settings.setze('ollama_kontext', '999999');
    assert.equal(kiText.kontextFenster(), 32768);
    settings.setze('ollama_kontext', 'viel');
    assert.equal(kiText.kontextFenster(), kiText.KONTEXT_STANDARD);
  });
});

describe('Der Prompt bekommt nur so viel Platz, wie übrig bleibt', () => {
  test('die Antwort ist mit eingerechnet', () => {
    const klein = kiText.promptPlatz(8192, 4000);
    const gross = kiText.promptPlatz(8192, 200);
    assert.ok(gross > klein, 'wer weniger Antwort erlaubt, darf mehr fragen');
  });

  test('ein größeres Fenster erlaubt einen längeren Prompt', () => {
    assert.ok(kiText.promptPlatz(16384, 1500) > kiText.promptPlatz(8192, 1500));
  });

  // Ein Bündel aus fünf Mails à 1500 Zeichen plus Themenliste und Anweisung —
  // das muss in den Standard passen, sonst ist die Voreinstellung falsch.
  test('ein Bündel aus fünf Mails passt in den Standard', () => {
    const gebraucht = 5 * 1500 + 3000; // Mails + Themenblock + Anweisung
    assert.ok(kiText.promptPlatz(kiText.KONTEXT_STANDARD, 1500) > gebraucht,
      'sonst schneidet Ollama bei jeder Anfrage die Anweisung ab');
  });

  test('der Platz bleibt auch im kleinsten Fenster positiv', () => {
    assert.ok(kiText.promptPlatz(2048, 1500) > 0);
  });
});

describe('Der Workflow-Knoten schickt num_ctx mit', () => {
  test('der Ollama-Rumpf nennt das Fenster', () => {
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    const body = wf.nodes[0].parameters.jsonBody;
    assert.match(body, /num_ctx:\s*\d+/,
      'ohne num_ctx schneidet Ollama den Prompt vorne ab — dort steht die Anweisung');
    assert.equal(Number(body.match(/num_ctx:\s*(\d+)/)[1]), kiText.kontextFenster());
  });

  test('eine geänderte Einstellung landet beim nächsten Abgleich im Knoten', () => {
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    settings.setze('ollama_kontext', '16384');
    assert.equal(patcher.geminiRequestReparieren(wf), true, 'der Abgleich muss das merken');
    assert.match(wf.nodes[0].parameters.jsonBody, /num_ctx:\s*16384/);
  });

  test('zweimal derselbe Abgleich ändert nichts mehr', () => {
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    const einmal = wf.nodes[0].parameters.jsonBody;
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].parameters.jsonBody, einmal);
  });

  // num_ctx ist ein Ollama-Begriff. In einem Gemini-Rumpf hätte er nichts zu
  // suchen und würde von Google als unbekanntes Feld abgewiesen.
  test('bei Gemini steht kein num_ctx im Rumpf', () => {
    settings.setze('ki_anbieter', 'gemini');
    const wf = knotenMit(
      "={{ JSON.stringify({ contents: [{ parts: [{ text: String($json.promptText || '') }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) }}",
      'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
    );
    patcher.geminiRequestReparieren(wf);
    assert.ok(!/num_ctx/.test(wf.nodes[0].parameters.jsonBody));
  });
});
