// Der Beleg-Knoten wird als jsCode in Workflow 07 geschrieben — genau die Sorte
// Stelle, die in diesem Projekt schon zweimal kaputt war. Deshalb hier festgenagelt:
// gültiges JavaScript, Gate vorhanden, Secret eingebettet, Ordner-Logik korrekt.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-xyz';
const patcher = require('../src/services/aktionenPatcher');

const AKTION = { id: 5, name: 'Test' };
const gueltig = (code) => assert.doesNotThrow(
  () => new Function(`return (async () => { ${code} })`),
  'erzeugter Code muss gültiges JavaScript sein',
);

describe('belegDatenKnoten mit Auslesen', () => {
  const konfig = {
    ordner: '{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}',
    dateiname: '{{datum}} {{firma}} {{betreff}}',
    auslesen: true,
  };
  const code = patcher.belegDatenKnoten(AKTION, konfig, 'Wenn: Test', [0, 0]).parameters.jsCode;

  test('ruft das Panel zum Auslesen und trägt das Secret ein', () => {
    assert.match(code, /api\/internal\/beleg-auslesen/);
    assert.match(code, /X-Panel-Secret/);
    assert.match(code, /test-geheim-xyz/);
    assert.match(code, /this\.helpers\.httpRequest/);
  });
  test('verwirft Nicht-Belege (speichern !== true ⇒ continue)', () => {
    assert.match(code, /r\.speichern !== true/);
    assert.match(code, /continue/);
  });
  test('Vorfilter und Ordner-Bausteine sind da', () => {
    assert.match(code, /istPdf/);
    assert.match(code, /BLOCK/);
    assert.match(code, /firmaAus/);
    assert.match(code, /beleg_t1/);
    assert.match(code, /beleg_t2 = firma/, 'mit Aktenzeichen: Ordner nach Firma/Aktenzeichen');
  });
  test('Dateiname-Vorlage ist eingesetzt', () => {
    assert.match(code, /\$\{j\.datum\}/);
    assert.match(code, /\$\{j\.firma\}/);
    assert.match(code, /\$\{j\.betreff\}/);
  });
  test('ist gültiges JavaScript', () => gueltig(code));
});

describe('belegDatenKnoten ohne Auslesen (Altverhalten)', () => {
  const konfig = { ordner: 'Belege/{{jahr}}', auslesen: false };
  const code = patcher.belegDatenKnoten(AKTION, konfig, 'Wenn: Test', [0, 0]).parameters.jsCode;

  test('kein Panel-Aufruf, keine Ordner-Bausteine, Originalname', () => {
    assert.doesNotMatch(code, /beleg-auslesen/);
    assert.doesNotMatch(code, /beleg_t1/);
    assert.match(code, /rohOhne/);
    assert.match(code, /firmaAus/);
  });
  test('ist gültiges JavaScript', () => gueltig(code));
});

describe('ordnerKnoten: executeOnce', () => {
  const ist = (pfad) => patcher.ordnerKnoten(AKTION, pfad, 1, [0, 0], null).executeOnce;
  test('statischer Pfad ⇒ einmal', () => {
    assert.equal(ist('Belege'), true);
    assert.equal(ist("Belege/{{ $now.toFormat('yyyy') }}"), true);
  });
  test('pro-Anhang-Pfad (Firma/Aktenzeichen) ⇒ je Anhang', () => {
    assert.equal(ist('{{ $json.firma }}'), false);
    assert.equal(ist('Belege/{{ $json.beleg_t2 }}'), false);
    assert.equal(ist('{{ $json.aktenzeichen }}'), false);
  });
});

describe('belegBereitstellenKnoten', () => {
  test('holt die Anhänge vom Beleg-Knoten zurück', () => {
    const code = patcher.belegBereitstellenKnoten(AKTION, 'Beleg lesen: Test', [0, 0]).parameters.jsCode;
    assert.match(code, /Beleg lesen: Test/);
    assert.match(code, /\.all\(\)/);
    gueltig(code);
  });
});
