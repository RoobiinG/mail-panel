// Der KI-Knoten heisst neutral — auch in Bestandsinstallationen.
//
// Im n8n-Editor stand „Gemini klassifizieren", waehrend darunter
// `POST http://ollama:11434/api/generate` zu lesen war. Der Name war ein
// Ueberbleibsel des ersten Imports aus der Gemini-Zeit; die Adresse hatte der
// Patcher laengst umgebogen, den Namen nie.
//
// Warum er so lange stehen blieb, ist der eigentliche Punkt: Verbindungen
// laufen in n8n ueber den NAMEN, nicht ueber die id, und
// geminiBuendelEinbauen() findet den Knoten AUSSCHLIESSLICH ueber den Namen —
// ohne Adress-Rueckfall. Ihn einfach zu aendern haette Workflow 04 stumm seine
// Buendelung gekostet, ohne dass irgendwo ein Fehler erschienen waere.
//
// Diese Datei sichert beides ab: dass umbenannt wird, und dass dabei nichts
// abreisst.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');

beforeEach(() => {
  settings.setze('ki_anbieter', 'ollama');
  settings.setze('ollama_url', 'http://ollama:11434');
  settings.setze('ollama_modell', 'llama3.2:1b');
});

// Ein Ausschnitt wie in Workflow 01: zwei Knoten zeigen auf den KI-Knoten, der
// KI-Knoten zeigt weiter auf „Antwort parsen".
const workflowMit = (kiName) => ({
  nodes: [
    { id: 'a', name: 'Hat Anhang?', type: 'n8n-nodes-base.if', position: [0, 0], parameters: {} },
    { id: 'b', name: 'Virus gefunden?', type: 'n8n-nodes-base.if', position: [0, 1], parameters: {} },
    {
      id: 'http-gemini',
      name: kiName,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1, 0],
      parameters: { url: 'http://ollama:11434/api/generate', jsonBody: '={{ 1 }}' },
    },
    { id: 'c', name: 'Antwort parsen', type: 'n8n-nodes-base.code', position: [2, 0], parameters: {} },
  ],
  connections: {
    'Hat Anhang?': { main: [[{ node: 'Anhänge scannen', type: 'main', index: 0 }],
      [{ node: kiName, type: 'main', index: 0 }]] },
    'Virus gefunden?': { main: [[], [{ node: kiName, type: 'main', index: 0 }]] },
    [kiName]: { main: [[{ node: 'Antwort parsen', type: 'main', index: 0 }]] },
  },
});

const namen = (wf) => wf.nodes.map((k) => k.name);
const zieleAuf = (wf, name) => {
  let n = 0;
  for (const aus of Object.values(wf.connections)) {
    for (const arm of aus.main || []) for (const z of arm || []) if (z.node === name) n += 1;
  }
  return n;
};

describe('Umbenennen des KI-Knotens', () => {
  test('aus „Gemini klassifizieren" wird ein neutraler Name', () => {
    const wf = workflowMit('Gemini klassifizieren');
    assert.equal(patcher.kiKnotenNeutralBenennen(wf), true);
    assert.ok(namen(wf).includes(patcher.KI_NAME));
    assert.ok(!namen(wf).includes('Gemini klassifizieren'));
  });

  test('aus „Ollama klassifizieren" ebenso — der Name soll nichts versprechen', () => {
    const wf = workflowMit('Ollama klassifizieren');
    assert.equal(patcher.kiKnotenNeutralBenennen(wf), true);
    assert.ok(namen(wf).includes(patcher.KI_NAME));
  });

  // Das ist die Gefahr an der ganzen Sache: Eine Kante, die auf den alten Namen
  // zeigt, ist danach eine Kante ins Leere — und n8n meldet das nicht.
  test('die eingehenden Kanten ziehen mit', () => {
    const wf = workflowMit('Gemini klassifizieren');
    assert.equal(zieleAuf(wf, 'Gemini klassifizieren'), 2);
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(zieleAuf(wf, 'Gemini klassifizieren'), 0, 'sonst haengt der Knoten in der Luft');
    assert.equal(zieleAuf(wf, patcher.KI_NAME), 2);
  });

  test('die ausgehende Kante bleibt erhalten', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(wf.connections[patcher.KI_NAME].main[0][0].node, 'Antwort parsen');
    assert.equal(wf.connections['Gemini klassifizieren'], undefined);
  });

  test('ein zweiter Durchgang ändert nichts mehr', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(patcher.kiKnotenNeutralBenennen(wf), false,
      'sonst schriebe jeder Abgleich den Workflow neu');
  });

  test('fremde Knoten bleiben unangetastet', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.ok(namen(wf).includes('Hat Anhang?'));
    assert.ok(namen(wf).includes('Antwort parsen'));
    assert.equal(wf.nodes.length, 4);
  });

  // Die id bleibt — an ihr haengt in n8n die Zuordnung gespeicherter Laeufe.
  test('die Knoten-id wird nicht angefasst', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(wf.nodes.find((k) => k.name === patcher.KI_NAME).id, 'http-gemini');
  });
});

describe('Der Zusammenfasser im Digest', () => {
  const digest = (name) => ({
    nodes: [{
      id: 'http-gemini-digest', name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [0, 0], parameters: { url: 'http://ollama:11434/api/generate' },
    }],
    connections: { [name]: { main: [[{ node: 'Text extrahieren', type: 'main', index: 0 }]] } },
  });

  test('heißt danach ebenfalls neutral', () => {
    const wf = digest('Gemini zusammenfassen');
    assert.equal(patcher.kiKnotenNeutralBenennen(wf), true);
    assert.equal(wf.nodes[0].name, patcher.KI_ZUSAMMENFASSER_NAME);
    assert.equal(wf.connections[patcher.KI_ZUSAMMENFASSER_NAME].main[0][0].node, 'Text extrahieren');
  });
});

// Der Grund, warum das ueberhaupt heikel war: Ohne diese Zusicherung verliert
// Workflow 04 seine Buendelung, ohne dass ein Fehler erscheint.
describe('Nach dem Umbenennen findet der Patcher den Knoten weiter', () => {
  test('istKiKnoten kennt den neuen Namen', () => {
    assert.equal(patcher.istKiKnoten(patcher.KI_NAME), true);
  });

  test('der Bündel-Knoten wird auch unter dem neuen Namen eingebaut', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(patcher.geminiBuendelEinbauen(wf), true);
    const ki = wf.nodes.find((k) => k.name === patcher.KI_NAME);
    assert.equal(ki.type, 'n8n-nodes-base.code');
    assert.ok(ki.parameters.jsCode.includes(patcher.BUENDEL_MARKE));
  });

  test('und der Rumpf wird auch danach noch repariert', () => {
    const wf = workflowMit('Gemini klassifizieren');
    patcher.kiKnotenNeutralBenennen(wf);
    assert.equal(patcher.geminiRequestReparieren(wf), true);
    assert.match(wf.nodes.find((k) => k.name === patcher.KI_NAME).parameters.jsonBody, /num_ctx/);
  });
});
