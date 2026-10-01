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
//
// Seit Build 253 stehen die Anhang-Endpunkte in routes/anhaenge.js — mit einem
// Waechter VOR dem Parser. Auch das wird hier festgehalten: Wer sich nicht
// ausweist, soll keine 40 MB parsen lassen koennen.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./umgebung');

const src = (datei) => fs.readFileSync(path.resolve(__dirname, '../src', datei), 'utf8');

const ROUTENDATEIEN = ['routes/internal.js', 'routes/anhaenge.js'];

// Alle `router.post('/pfad', <Argumente>, (req, res) =>`-Routen einer Datei samt
// ihrer Argumente vor der Handler-Funktion.
function postRouten(datei) {
  const text = src(datei);
  const treffer = text.matchAll(/router\.post\(\s*'([^']+)'\s*,([\s\S]*?)(?:async\s*)?\(req,\s*res(?:,\s*next)?\)\s*=>/g);
  return [...treffer].map((m) => ({ datei, pfad: `/api/internal${m[1]}`, args: m[2], text }));
}

// Eine Grenze steht als Text ('25mb') oder als Konstante (JSON_MIT_DATEI) da.
function grenzeAus(r) {
  const j = /express\.json\(\s*\{\s*limit:\s*(?:'([^']+)'|(\w+))/.exec(r.args);
  if (!j) return null;
  if (j[1]) return j[1];
  const konstante = new RegExp(`const\\s+${j[2]}\\s*=\\s*'([^']+)'`).exec(r.text);
  assert.ok(konstante, `${r.pfad}: Konstante ${j[2]} nicht gefunden`);
  return konstante[1];
}

// Routen, die ihren Rumpf selbst parsen: JSON mit eigener Grenze oder roh.
function routenMitEigenemParser() {
  const ergebnis = [];
  for (const datei of ROUTENDATEIEN) {
    for (const r of postRouten(datei)) {
      const grenze = grenzeAus(r);
      if (grenze) ergebnis.push({ ...r, grenze });
      else if (/express\.raw\(|scanParser/.test(r.args)) ergebnis.push({ ...r, grenze: 'roh' });
    }
  }
  return ergebnis;
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

  // 30 MB Datei sind als base64 40 MB; mit dem Umschlag (Name, Konto, Betreff) passt
  // das nicht in 25. Ein Beleg zwischen 18 und 30 MB starb sonst still mit 413.
  test('Routen mit einer Datei im Rumpf fassen 30 MB als base64', () => {
    for (const pfad of ['/api/internal/beleg-auslesen', '/api/internal/upload-freigabe']) {
      const r = routen.find((x) => x.pfad === pfad);
      assert.ok(r, `${pfad} fehlt`);
      const mb = Number(/^(\d+)mb$/.exec(r.grenze)?.[1]);
      assert.ok(mb >= 41, `${pfad}: ${r.grenze} reicht nicht fuer 30 MB als base64`);
    }
  });
});

describe('Anhang-Endpunkte: Waechter vor dem Parser', () => {
  const routen = postRouten('routes/anhaenge.js');

  test('es gibt die fuenf Anhang-Endpunkte', () => {
    const pfade = routen.map((r) => r.pfad).sort();
    assert.deepEqual(pfade, [
      '/api/internal/anhaenge', '/api/internal/beleg-auslesen', '/api/internal/scan',
      '/api/internal/scan-anhaenge', '/api/internal/upload-freigabe',
    ]);
  });

  for (const r of postRouten('routes/anhaenge.js')) {
    test(`${r.pfad}: adminOderPanelSecret steht VOR dem Parser`, () => {
      const wachter = r.args.indexOf('adminOderPanelSecret');
      const parser = r.args.search(/express\.json\(|express\.raw\(|scanParser/);
      assert.ok(wachter >= 0, 'ohne Waechter kaeme jeder an die Datei');
      assert.ok(parser > wachter, 'der Waechter muss zuerst laufen — sonst parst der Parser 40 MB fuer Unangemeldete');
    });
  }

  test('routes/internal.js enthaelt keinen dieser Endpunkte mehr', () => {
    const intern = postRouten('routes/internal.js').map((r) => r.pfad);
    for (const p of ['/api/internal/scan', '/api/internal/scan-anhaenge', '/api/internal/anhaenge',
      '/api/internal/upload-freigabe', '/api/internal/beleg-auslesen']) {
      assert.ok(!intern.includes(p), `${p} steht doppelt da — der alte, schwaechere Waechter wuerde mitgelten`);
    }
  });

  test('index.js haengt routes/anhaenge VOR dem allgemeinen internen Router ein', () => {
    const text = src('index.js');
    const anhaenge = text.indexOf("app.use('/api/internal', require('./routes/anhaenge'))");
    const allgemein = text.indexOf("app.use('/api/internal', internalAuth,");
    assert.ok(anhaenge >= 0 && allgemein >= 0, 'beide Zeilen muessen da sein');
    assert.ok(anhaenge < allgemein,
      'sonst liefe das Panel-Secret allein vor den Anhang-Endpunkten und liesse die Admin-Anmeldung nie zu');
  });
});
