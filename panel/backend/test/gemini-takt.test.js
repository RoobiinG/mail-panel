// Zwei Fehler aus dem laufenden Betrieb, hier festgenagelt.
//
// 1. "The service is receiving too many requests from you": Die Bestands-Triage
//    schob 143 Mails in einem Rutsch zu Gemini und Google machte dicht. Der
//    Tagesdeckel half nicht — der begrenzt die Menge, nicht das Tempo.
//
// 2. "Credential with ID ... does not exist for type httpHeaderAuth": Beim
//    Erneuern der Zugangsdaten wurde erst geloescht und dann angelegt. Ging das
//    Anlegen schief, stand die tote ID danach in jedem Workflow und kein
//    einziger Lauf kam mehr durch.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');

function geminiKnoten(extra = {}) {
  return {
    name: 'Gemini klassifizieren',
    type: 'n8n-nodes-base.httpRequest',
    parameters: {
      url: 'https://generativelanguage.googleapis.com/v1beta/'
        + 'models/gemini-3.5-flash-lite:generateContent',
      ...extra,
    },
  };
}
const pauseWeg = () => db.prepare("DELETE FROM settings WHERE key='gemini_pause_ms'").run();

describe('Tempo der KI-Anfragen', () => {
  test('ein Element pro Durchgang, dazwischen eine Pause', () => {
    pauseWeg();
    const wf = { nodes: [geminiKnoten()] };
    assert.equal(patcher.geminiRequestReparieren(wf), true);
    const takt = wf.nodes[0].parameters.options.batching.batch;
    assert.equal(takt.batchSize, 1, 'sonst gehen wieder 50 Anfragen gleichzeitig raus');
    assert.equal(takt.batchInterval, 6000);
  });

  test('die Pause kommt aus den Einstellungen', () => {
    settings.setze('gemini_pause_ms', '1500');
    const wf = { nodes: [geminiKnoten()] };
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].parameters.options.batching.batch.batchInterval, 1500);
    pauseWeg();
  });

  test('Unsinn faellt auf den Standard zurueck', () => {
    settings.setze('gemini_pause_ms', 'gleich');
    const wf = { nodes: [geminiKnoten()] };
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].parameters.options.batching.batch.batchInterval, 6000);
    settings.setze('gemini_pause_ms', '-5');
    const wf2 = { nodes: [geminiKnoten()] };
    patcher.geminiRequestReparieren(wf2);
    assert.equal(wf2.nodes[0].parameters.options.batching.batch.batchInterval, 6000);
    pauseWeg();
  });

  test('eine abgewiesene Anfrage wird wiederholt, nicht der Lauf abgebrochen', () => {
    pauseWeg();
    const wf = { nodes: [geminiKnoten()] };
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].retryOnFail, true);
    assert.equal(wf.nodes[0].maxTries, 5);
    assert.ok(wf.nodes[0].waitBetweenTries > 0);
  });

  test('beim zweiten Mal gibt es nichts mehr zu aendern', () => {
    pauseWeg();
    const wf = { nodes: [geminiKnoten()] };
    patcher.geminiRequestReparieren(wf);
    assert.equal(patcher.geminiRequestReparieren(wf), false,
      'sonst schreibt jeder Sync denselben Workflow wieder nach n8n');
  });

  test('vorhandene Optionen des Knotens bleiben stehen', () => {
    pauseWeg();
    const wf = { nodes: [geminiKnoten({ options: { timeout: 30000 } })] };
    patcher.geminiRequestReparieren(wf);
    assert.equal(wf.nodes[0].parameters.options.timeout, 30000);
    assert.equal(wf.nodes[0].parameters.options.batching.batch.batchSize, 1);
  });

  test('andere HTTP-Knoten werden nicht gedrosselt', () => {
    const wf = { nodes: [{
      name: 'Panel-Pruefung', type: 'n8n-nodes-base.httpRequest',
      parameters: { url: 'http://panel:3002/api/internal/pruefen' },
    }] };
    assert.equal(patcher.geminiRequestReparieren(wf), false);
    assert.equal(wf.nodes[0].parameters.options, undefined,
      'das Panel darf so schnell antworten, wie es kann');
  });
});

describe('credentialErneuern', () => {
  test('legt an und merkt sich die neue ID', async () => {
    db.prepare("DELETE FROM settings WHERE key='n8n_test_credential_id'").run();
    const id = await patcher.credentialErneuern('n8n_test_credential_id', async () => 'neu-1');
    assert.equal(id, 'neu-1');
    assert.equal(settings.hole('n8n_test_credential_id'), 'neu-1');
  });

  test('scheitert das Anlegen, bleibt die alte ID gueltig', async () => {
    settings.setze('n8n_test_credential_id', 'alt-7');
    const id = await patcher.credentialErneuern('n8n_test_credential_id',
      async () => { throw new Error('n8n nicht erreichbar'); });
    assert.equal(id, 'alt-7',
      'sonst landet eine geloeschte ID in jedem Workflow und kein Lauf kommt mehr durch');
    assert.equal(settings.hole('n8n_test_credential_id'), 'alt-7',
      'und in der Datenbank darf auch nichts kaputtgehen');
  });
});
