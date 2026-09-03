// Der Budget-Wächter wird in den Sammel-Knoten von Workflow 04 geschrieben.
// Das ist die Stelle, die ich in diesem Projekt schon zweimal kaputt hatte —
// deshalb hier festgenagelt, was gelten muss: Block gesetzt, Ende sauber, und
// ein zweiter Sync stapelt nichts.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const patcher = require('../src/services/workflowPatcher');

// So sieht der Sammel-Knoten am Ende aus (gekürzt, aber mit dem echten Ende).
function frischerSammler() {
  return {
    name: 'Sammeln + Normalisieren',
    parameters: {
      jsCode: [
        'const quellen = [',
        '// PANEL:QUELLEN-START',
        '// PANEL:QUELLEN-ENDE',
        '];',
        'const out = [];',
        '// ... sammelt Mails ...',
        "if (out.length === 0) {",
        "  return [{ json: { hinweis: 'nichts' } }];",
        '}',
        'return out;',
      ].join('\n'),
    },
  };
}

describe('budgetInSammeln', () => {
  test('setzt den Block und ruft das Panel-Budget', () => {
    const s = frischerSammler();
    patcher.budgetInSammeln(s);
    const c = s.parameters.jsCode;
    assert.match(c, /PANEL:BUDGET v1/);
    assert.match(c, /api\/internal\/budget/);
    assert.match(c, /this\.helpers\.httpRequest/);
    assert.match(c, /return __erlaubt;/);
    assert.match(c, /test-geheim-123/, 'das Panel-Geheimnis muss eingebettet sein');
  });

  test('das schlichte "return out;" ist danach ersetzt', () => {
    const s = frischerSammler();
    patcher.budgetInSammeln(s);
    // Kein nacktes "return out;" mehr am Ende — der Budget-Block hat es abgelöst.
    assert.doesNotMatch(s.parameters.jsCode, /\nreturn out;\s*$/);
  });

  test('idempotent: zweimal ergibt exakt dasselbe wie einmal', () => {
    const einmal = frischerSammler();
    patcher.budgetInSammeln(einmal);
    const zweimal = frischerSammler();
    patcher.budgetInSammeln(zweimal);
    patcher.budgetInSammeln(zweimal);
    assert.equal(zweimal.parameters.jsCode, einmal.parameters.jsCode,
      'ein zweiter Sync darf keinen zweiten Block anhängen');
    assert.equal((zweimal.parameters.jsCode.match(/PANEL:BUDGET v1/g) || []).length, 1);
  });

  test('der erzeugte Code ist gültiges JavaScript', () => {
    const s = frischerSammler();
    patcher.budgetInSammeln(s);
    // In eine async-Funktion wickeln (wegen await) und nur die Syntax prüfen.
    assert.doesNotThrow(() => new Function(`return (async () => { ${s.parameters.jsCode} })`));
  });

  test('ohne jsCode passiert nichts (kein Absturz)', () => {
    assert.doesNotThrow(() => patcher.budgetInSammeln({ name: 'x', parameters: {} }));
    assert.doesNotThrow(() => patcher.budgetInSammeln(null));
  });

  test('die Quellenliste bleibt erhalten', () => {
    const s = frischerSammler();
    patcher.budgetInSammeln(s);
    assert.match(s.parameters.jsCode, /PANEL:QUELLEN-START/);
    assert.match(s.parameters.jsCode, /PANEL:QUELLEN-ENDE/);
  });
});
