// Die Mails, die stillschweigend verschwanden.
//
// Der Sammel-Knoten wirft jede Mail weg, bei der kein Absender herauskommt
// ("if (!mail.von) continue"). Der Normalisierer fragte dafuer genau zwei
// Stellen ab: envelope.from und from. Im ersten grossen Bestandslauf blieben so
// von 200 abgeholten Mails nur 146 uebrig — jede vierte war weg, ohne Fehler,
// ohne Eintrag, ohne dass irgendwo etwas rot geworden waere.
//
// Diese Datei nagelt fest, dass der Absender auch aus den Kopfzeilen kommt.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const patcher = require('../src/services/workflowPatcher');

// So sieht der Block in Workflow 04 aus (eingerueckt, in einer Funktion) …
const VIER = [
  'function normalisieren(j, konto) {',
  '  const e = j.envelope || {};',
  '  const h = j.headers || {};',
  '',
  '  const von = (e.from && e.from[0] && e.from[0].address)',
  '    || (j.from && j.from.value && j.from.value[0] && j.from.value[0].address)',
  '    || (j.from && j.from.text)',
  "    || (typeof j.from === 'string' ? j.from : '')",
  "    || '';",
  "  const betreff = e.subject || j.subject || '(kein Betreff)';",
  '  return { konto, von, betreff };',
  '}',
].join('\n');

// … und so in Workflow 01 (ganz aussen, mit einer Stelle mehr).
const EINS = [
  'const j = $json;',
  'const e = j.envelope || {};',
  'const h = j.headers || {};',
  '',
  'const von = (e.from && e.from[0] && e.from[0].address)',
  '  || (j.from && j.from.value && j.from.value[0] && j.from.value[0].address)',
  '  || (j.from && j.from.text)',
  '  || j.From',
  "  || (typeof j.from === 'string' ? j.from : '')",
  "  || '';",
  '',
  "const betreff = e.subject || j.subject || '(kein Betreff)';",
].join('\n');

const knotenMit = (code, name = 'Normalisieren') => ({
  nodes: [{ name, type: 'n8n-nodes-base.code', parameters: { jsCode: code } }],
});

// Holt die eingebaute Logik heraus und macht sie aufrufbar — damit hier nicht
// nur geprueft wird, DASS etwas eingebaut wurde, sondern auch, dass es stimmt.
function absenderAus(code, daten) {
  const anfang = code.indexOf(patcher.ABSENDER_MARKE);
  const ende = code.indexOf("|| '';", anfang) + "|| '';".length;
  const block = code.slice(anfang, ende);
  // eslint-disable-next-line no-new-func
  const fn = new Function('j', 'e', 'h', `${block}\nreturn von;`);
  return fn(daten, daten.envelope || {}, daten.headers || {});
}

describe('Absender-Rueckfall einbauen', () => {
  test('greift in Workflow 04 (eingerueckt in der Funktion)', () => {
    const wf = knotenMit(VIER, 'Sammeln + Normalisieren');
    assert.equal(patcher.absenderFallbackEinbauen(wf, 'Sammeln + Normalisieren'), true);
    const code = wf.nodes[0].parameters.jsCode;
    assert.ok(code.includes(patcher.ABSENDER_MARKE));
    assert.match(code, /\n {2}const __ausFeld/, 'Einrueckung der Funktion beibehalten');
    assert.ok(code.includes('const betreff'), 'der Rest des Knotens bleibt stehen');
  });

  test('greift auch in Workflow 01 (ganz aussen)', () => {
    const wf = knotenMit(EINS);
    assert.equal(patcher.absenderFallbackEinbauen(wf, 'Normalisieren'), true);
    assert.match(wf.nodes[0].parameters.jsCode, /\nconst __ausFeld/);
  });

  test('zweimal aendert nichts mehr', () => {
    const wf = knotenMit(EINS);
    patcher.absenderFallbackEinbauen(wf, 'Normalisieren');
    const einmal = wf.nodes[0].parameters.jsCode;
    assert.equal(patcher.absenderFallbackEinbauen(wf, 'Normalisieren'), false);
    assert.equal(wf.nodes[0].parameters.jsCode, einmal);
  });

  test('der erzeugte Code ist gueltiges JavaScript', () => {
    const wf = knotenMit(VIER, 'Sammeln + Normalisieren');
    patcher.absenderFallbackEinbauen(wf, 'Sammeln + Normalisieren');
    assert.doesNotThrow(() => new Function(wf.nodes[0].parameters.jsCode));
  });

  test('unbekannter Knoten: kein Absturz', () => {
    assert.equal(patcher.absenderFallbackEinbauen({ nodes: [] }, 'Normalisieren'), false);
    assert.equal(patcher.absenderFallbackEinbauen(knotenMit('const x = 1;'), 'Normalisieren'), false);
  });
});

describe('Woher der Absender kommt', () => {
  const wf = knotenMit(EINS);
  patcher.absenderFallbackEinbauen(wf, 'Normalisieren');
  const code = wf.nodes[0].parameters.jsCode;

  test('Abruf-Knoten: envelope.from', () => {
    assert.equal(absenderAus(code, { envelope: { from: [{ address: 'a@b.de' }] } }), 'a@b.de');
  });

  test('IMAP-Trigger: from.value[].address', () => {
    assert.equal(absenderAus(code, { from: { value: [{ address: 'c@d.de' }], text: 'C <c@d.de>' } }), 'c@d.de');
  });

  test('nur die Kopfzeile headers.from — bisher fiel diese Mail hinten runter', () => {
    assert.equal(absenderAus(code, { headers: { from: 'E <e@f.de>' } }), 'E <e@f.de>');
  });

  test('nur die rohen Kopfzeilen (headerLines)', () => {
    assert.equal(
      absenderAus(code, { headerLines: [{ key: 'from', line: 'From: G <g@h.de>' }] }),
      'G <g@h.de>',
    );
  });

  test('Umschlag ohne From, aber mit Sender', () => {
    assert.equal(absenderAus(code, { envelope: { sender: [{ address: 'i@j.de' }] } }), 'i@j.de');
  });

  test('wirklich nichts drin bleibt leer — die Mail gehoert dann aussortiert', () => {
    assert.equal(absenderAus(code, {}), '');
    assert.equal(absenderAus(code, { headers: {}, headerLines: [] }), '');
  });
});
