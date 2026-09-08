// Der KI-Knoten darf keinen leeren Prompt verschicken.
//
// Aus dem Betrieb am 8. September, sichtbar im n8n-Editor:
//
//     {"model":"llama3.2:latest","prompt":"","stream":false,…}
//     The connection was aborted, perhaps the server is offline
//
// Der Knoten fragte nach `$json.promptText`. An der Stelle, an der er sitzt,
// heißt das Feld aber `text` — themenKetteEinbauen() benennt es im
// Normalisierer genau so um, weil die Bündelung in Workflow 04 es so braucht.
// Ergebnis: ein leerer Prompt.
//
// Bei Gemini käme darauf eine schnelle, unbrauchbare Antwort. Ollama mit
// `format: 'json'` fängt an zu schreiben und hört nicht auf, bis das Zeitlimit
// greift — vier Minuten pro Mail, für nichts. Das erklärt sowohl die roten
// Läufe als auch „konfidenz: 0" bei praktisch jeder Entscheidung.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');

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

const OLLAMA_URL = 'http://ollama:11434/api/generate';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent';

const altesOllamaBody = "={{ JSON.stringify({ model: 'llama3.2:latest', prompt: String($json.promptText || ''), stream: false, format: 'json', options: { temperature: 0.1 } }) }}";
const altesGeminiBody = "={{ JSON.stringify({ contents: [{ parts: [{ text: String($json.promptText || '') }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) }}";

beforeEach(() => {
  settings.setze('ki_anbieter', 'gemini');
  settings.setze('ollama_url', 'http://ollama:11434');
  settings.setze('ollama_modell', 'llama3.2:latest');
});

describe('Der Prompt-Ausdruck fragt beide Feldnamen ab', () => {
  test('Ollama: promptText mit text als Rückfall', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    const body = wf.nodes[0].parameters.jsonBody;
    assert.match(body, /\$json\.promptText \|\| \$json\.text/,
      `ohne den Rückfall geht ein leerer Prompt hinaus: ${body}`);
  });

  test('Gemini: derselbe Rückfall', () => {
    const wf = knotenMit(altesGeminiBody, GEMINI_URL);
    patcher.geminiRequestReparieren(wf);
    assert.match(wf.nodes[0].parameters.jsonBody, /\$json\.promptText \|\| \$json\.text/);
  });

  test('ein bereits umgestellter Knoten wird nicht doppelt umgebaut', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    const einmal = wf.nodes[0].parameters.jsonBody;
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].parameters.jsonBody, einmal, 'jeder Sync schriebe sonst dasselbe neu');
    assert.equal((einmal.match(/\$json\.text/g) || []).length, 1);
  });

  // Wer in n8n einen eigenen Ausdruck eingetragen hat (etwa mit $('Knoten').item),
  // soll ihn behalten — angefasst wird nur die bekannte Standardform.
  test('ein eigener Ausdruck bleibt stehen', () => {
    settings.setze('ki_anbieter', 'ollama');
    const eigen = "={{ JSON.stringify({ model: 'x', prompt: String($('Prüfung auswerten').item.json.promptText), stream: false }) }}";
    const wf = knotenMit(eigen, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    assert.match(wf.nodes[0].parameters.jsonBody, /Prüfung auswerten/);
  });
});

describe('Die Antwortlänge ist begrenzt', () => {
  // Ohne num_predict schreibt Ollama, bis der Kontext voll ist. Bei einem leeren
  // Prompt heißt das: bis zum Zeitlimit. Auf einer CPU ist jedes Token, das
  // nicht erzeugt wird, gesparte Zeit.
  test('der Ollama-Rumpf setzt num_predict', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = knotenMit(altesOllamaBody, OLLAMA_URL);
    patcher.geminiRequestReparieren(wf);
    const body = wf.nodes[0].parameters.jsonBody;
    assert.match(body, /num_predict:\s*\d+/, 'ohne Grenze schreibt Ollama bis zum Zeitlimit');
    const n = Number(body.match(/num_predict:\s*(\d+)/)[1]);
    assert.ok(n > 0 && n <= 2000, `${n} Token sind fuer ein JSON-Objekt mit fuenf Feldern zu viel`);
  });

  test('auch der Panel-Pfad bleibt bescheiden', () => {
    const quelle = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/kiText.js'), 'utf8',
    );
    // Seit Build 150 steht der Wert eine Zeile hoeher in einer Konstanten, weil
    // ihn auch die Platzberechnung fuer den Prompt braucht. Die Regel ist
    // dieselbe geblieben: Was das Panel selbst an Ollama schickt, bleibt kurz.
    const n = Number(quelle.match(/antwortTokens = opt\.maxAntwort \|\| (\d+)/)[1]);
    assert.ok(n <= 2000, `${n} Token sind auf einer CPU eine Viertelstunde`);
  });
});
