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

// Der teuerste Fehler dieses Projekts: eine Credential-ID, die es nicht mehr
// gibt, in jedem Workflow. n8n bricht dann JEDEN Lauf ab, und zwar dauerhaft.
// Die Lehre steckt in diesen vier Tests.
describe('credentialErneuern', () => {
  test('legt an und merkt sich ID samt Fingerabdruck', async () => {
    db.prepare("DELETE FROM settings WHERE key LIKE 'n8n_test_credential_id%'").run();
    const c = await patcher.credentialErneuern('n8n_test_credential_id', 'abdruck-1', async () => 'neu-1');
    assert.equal(c.id, 'neu-1');
    assert.equal(c.alt, null);
    assert.equal(settings.hole('n8n_test_credential_id'), 'neu-1');
  });

  test('unveraenderte Zugangsdaten werden gar nicht erst angefasst', async () => {
    let aufrufe = 0;
    const c = await patcher.credentialErneuern('n8n_test_credential_id', 'abdruck-1',
      async () => { aufrufe += 1; return 'neu-2'; });
    assert.equal(aufrufe, 0,
      'jedes Neuanlegen zwingt dazu, die ID in JEDEM Workflow nachzuziehen');
    assert.equal(c.id, 'neu-1');
  });

  test('geaenderte Zugangsdaten: neue ID, alte nur zum Wegraeumen gemeldet', async () => {
    const c = await patcher.credentialErneuern('n8n_test_credential_id', 'abdruck-2', async () => 'neu-3');
    assert.equal(c.id, 'neu-3');
    assert.equal(c.alt, 'neu-1',
      'geloescht wird erst, wenn alle Workflows die neue ID haben');
  });

  test('scheitert das Anlegen, bleibt die alte ID gueltig', async () => {
    const c = await patcher.credentialErneuern('n8n_test_credential_id', 'abdruck-3',
      async () => { throw new Error('n8n nicht erreichbar'); });
    assert.equal(c.id, 'neu-3', 'sonst landet eine tote ID in jedem Workflow');
    assert.equal(c.alt, null, 'und weggeraeumt wird schon gar nichts');
  });

  test('der Fingerabdruck unterscheidet, verraet aber nichts', () => {
    assert.equal(patcher.fingerabdruck('gemini', 'a'), patcher.fingerabdruck('gemini', 'a'));
    assert.notEqual(patcher.fingerabdruck('gemini', 'a'), patcher.fingerabdruck('gemini', 'b'));
    assert.doesNotMatch(patcher.fingerabdruck('gemini', 'streng-geheim'), /geheim/);
  });

  test('zugangsdatenVergessen leert den Merkzettel', () => {
    settings.setze('n8n_gemini_credential_id', 'x1');
    settings.setze('n8n_gemini_credential_id_fp', 'fp1');
    patcher.zugangsdatenVergessen();
    assert.equal(settings.hole('n8n_gemini_credential_id'), '',
      'danach legt der naechste Sync ein frisches an');
    assert.equal(settings.hole('n8n_gemini_credential_id_fp'), '');
  });
});
