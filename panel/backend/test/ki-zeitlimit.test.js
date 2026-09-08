// Kein KI-Aufruf ohne Zeitlimit — und keine Anfrage, die den Lauf überdauert.
//
// Beides stammt aus einem Diagnose-Bericht vom 8. September, und beides sah im
// Panel nach „läuft" aus, während nichts passierte:
//
//   * In n8n stand „01 - Inbox-Triage · 15 Min. 7 Sek. · The connection was
//     aborted, perhaps the server is offline". Der KI-Knoten hatte kein
//     Zeitlimit, n8n nahm seine 300 Sekunden, und mit drei Anläufen wurde daraus
//     eine Viertelstunde Stillstand.
//   * Im Log standen zwei Zeitüberschreitungen im Abstand von genau drei Minuten
//     und darunter „0 von 456 Mails klassifiziert". Die Anfrage durfte 180 s
//     dauern, der ganze Lauf 240 — die zweite Anfrage lief also bis Sekunde 360,
//     lange nachdem n8n den Knoten abgeschnitten hatte.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');

const kiWorkflow = (url) => ({
  nodes: [{
    parameters: {
      url,
      jsonBody: "={{ JSON.stringify({ contents: [{ parts: [{ text: String($json.promptText || '') }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) }}",
    },
    id: 'ki-1',
    name: 'Gemini klassifizieren',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [0, 0],
  }],
  connections: {},
});

beforeEach(() => {
  settings.setze('ki_anbieter', 'gemini');
  settings.setze('ollama_url', 'http://ollama:11434');
  settings.setze('ollama_modell', 'llama3.2:latest');
});

describe('Der KI-Knoten bekommt ein Zeitlimit', () => {
  test('mit Gemini', () => {
    const wf = kiWorkflow('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent');
    patcher.geminiRequestReparieren(wf);
    const k = wf.nodes[0];
    assert.equal(k.parameters.options.timeout, patcher.KI_ZEITLIMIT_GEMINI);
    assert.ok(k.parameters.options.timeout > 0, 'ohne Zeitlimit nimmt n8n 300 s');
  });

  test('mit Ollama — und großzügiger, weil die eigene Maschine rechnet', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = kiWorkflow('http://ollama:11434/api/generate');
    patcher.geminiRequestReparieren(wf);
    const k = wf.nodes[0];
    assert.equal(k.parameters.options.timeout, patcher.KI_ZEITLIMIT_OLLAMA);
    assert.ok(patcher.KI_ZEITLIMIT_OLLAMA > patcher.KI_ZEITLIMIT_GEMINI);
  });

  // 3 × 300 s ergaben die Viertelstunde aus dem Screenshot. Zwei Anlaeufe mit
  // Zeitlimit sind hoechstens acht Minuten — und der zweite bringt bei einer
  // lokalen KI ohnehin selten etwas.
  test('mit Ollama wird höchstens zweimal angesetzt', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = kiWorkflow('http://ollama:11434/api/generate');
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].maxTries, 2);
    assert.equal(wf.nodes[0].retryOnFail, true);
  });

  test('das Zeitlimit überlebt einen zweiten Abgleich unverändert', () => {
    settings.setze('ki_anbieter', 'ollama');
    const wf = kiWorkflow('http://ollama:11434/api/generate');
    patcher.geminiRequestReparieren(wf);
    const nochmal = patcher.geminiRequestReparieren(wf);
    assert.equal(nochmal, false, 'ein zweiter Lauf darf nichts mehr aendern');
    assert.equal(wf.nodes[0].parameters.options.timeout, patcher.KI_ZEITLIMIT_OLLAMA);
  });
});

describe('Eine Anfrage darf den Lauf nicht überdauern', () => {
  // Der Klassifizierer prueft die Frist NUR vor einem Buendel. Ein festes
  // Anfrage-Zeitlimit von 180 s neben einer Frist von 240 s heisst deshalb: Die
  // zweite Anfrage startet bei Sekunde 180 und laeuft bis 360.
  const klass = require('../src/services/klassifizierer');

  test('das Anfrage-Zeitlimit richtet sich nach der Restzeit', () => {
    const quelle = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/klassifizierer.js'), 'utf8',
    );
    assert.match(quelle, /anfrageZeitlimit\(/,
      'die Restzeit muss in das Zeitlimit eingehen');
    assert.ok(!/zeitlimit:\s*180000/.test(quelle),
      'ein festes Zeitlimit neben einer kuerzeren Frist ist genau der Fehler');
  });

  // Kommt gar keine Antwort, wird die naechste Anfrage nicht schneller — dann
  // ist Weiterfragen nur verbrannte Frist.
  test('nach einer Zeitüberschreitung hört der Lauf auf', () => {
    const quelle = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/klassifizierer.js'), 'utf8',
    );
    assert.match(quelle, /istZeitueberschreitung/);
    assert.match(quelle, /Modell ist für diese Maschine zu groß/,
      'die Meldung soll sagen, was zu tun ist — nicht nur, dass es nicht ging');
  });

  test('klassifizieren() bleibt bei leerer Liste ruhig', async () => {
    const r = await klass.klassifizieren([]);
    assert.equal(r.anfragen, 0);
    assert.equal(r.abgebrochen, false);
  });
});
