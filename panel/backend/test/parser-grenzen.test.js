// Wer einen eigenen JSON-Parser an eine interne Route haengt, muss den Pfad in
// index.js aus dem globalen Parser ausnehmen.
//
// Sonst passiert Folgendes: Der globale Parser laeuft zuerst, deckelt bei 1 MB
// und antwortet mit "request entity too large" — der eigene Parser mit seinen
// 25 MB kommt nie zum Zug. Die Route sieht im Code aus, als vertruege sie grosse
// Ruempfe, und tut es nicht.
//
// Im Betrieb sah das so aus: Der Buendel-Klassifizierer schickte 20 Mails mit
// vollem Text, bekam eine 413 — und ins Log schrieb er "0 von 23 Mails
// klassifiziert". Tagelang, ohne dass irgendwo "Fehler" stand.
//
// Dieser Test liest beide Seiten aus dem Quelltext und vergleicht sie. Er faellt
// damit auch dann, wenn jemand spaeter eine neue Route mit eigenem Parser
// anlegt und den Eintrag vergisst.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./umgebung');

const src = (datei) => fs.readFileSync(path.resolve(__dirname, '../src', datei), 'utf8');

// Aus routes/internal.js: jede Route, die express.json({ limit: … }) mitbringt.
function routenMitEigenemParser() {
  const text = src('routes/internal.js');
  const treffer = [...text.matchAll(/router\.post\(\s*'([^']+)'\s*,\s*express\.json\(\s*\{\s*limit:\s*'([^']+)'/g)];
  return treffer.map((m) => ({ pfad: `/api/internal${m[1]}`, grenze: m[2] }));
}

// Aus index.js: die Ausnahmeliste.
function ausnahmen() {
  const text = src('index.js');
  const block = text.match(/const EIGENER_PARSER = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'EIGENER_PARSER nicht gefunden — wurde index.js umgebaut?');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe('Eigene Parser-Grenzen greifen wirklich', () => {
  const routen = routenMitEigenemParser();
  const liste = ausnahmen();

  test('es gibt ueberhaupt Routen mit eigenem Parser', () => {
    assert.ok(routen.length >= 4, `nur ${routen.length} gefunden — stimmt das Muster noch?`);
  });

  for (const r of routen) {
    test(`${r.pfad} (${r.grenze}) ist vom globalen Parser ausgenommen`, () => {
      assert.ok(liste.has(r.pfad),
        `${r.pfad} deklariert ${r.grenze}, steht aber nicht in EIGENER_PARSER — `
        + 'der globale 1-MB-Parser laeuft davor und weist vorher ab.');
    });
  }

  // Die Gegenrichtung: Ein Eintrag ohne Route heisst, dass dort gar kein Parser
  // mehr greift — der Rumpf kaeme nie an.
  test('kein Eintrag zeigt ins Leere', () => {
    const pfade = new Set(routen.map((r) => r.pfad));
    for (const eintrag of liste) {
      assert.ok(pfade.has(eintrag),
        `${eintrag} ist ausgenommen, hat aber keinen eigenen Parser — dort wuerde der Rumpf gar nicht geparst.`);
    }
  });

  // Der Fall, der es tatsaechlich in den Betrieb geschafft hat.
  test('/klassifizieren vertraegt grosse Ruempfe', () => {
    const r = routen.find((x) => x.pfad.endsWith('/klassifizieren'));
    assert.ok(r, 'die Route fehlt');
    assert.ok(liste.has(r.pfad));
    assert.match(r.grenze, /^\d+mb$/, 'ein Buendel traegt bis zu 20 Mails mit Text');
  });
});
