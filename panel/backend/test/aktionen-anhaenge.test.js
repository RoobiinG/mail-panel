// Warum nie eine Datei auf der Nextcloud ankam.
//
// Workflow 07 lief seit jeher „erfolgreich" — und zwar in null Sekunden, ohne
// je etwas hochzuladen. Zwei Stellen zusammen sorgten dafür, dass die Kette nie
// anlief:
//
//   1. Die Bedingung „hat Anhang" prüfte `$binary`. Das löst in einem IF-Knoten
//      gar nicht auf — derselbe Stolperstein, der in Workflow 01/04 längst
//      ausgebaut ist (workflowPatcher.js, anhangKetteReparieren, Punkt 3).
//   2. Der Beleg-Knoten suchte die Dateien in `item.binary`. Die Abruf-Knoten
//      holen aber nur `attachmentsInfo` — Namen und Größen, keine Dateien. Bei
//      120 Mails je Lauf ist das Absicht.
//
// Beides ist hier festgehalten, weil kein Test es bemerkt hätte: Der erzeugte
// Code war gültiges JavaScript, die Knoten standen an der richtigen Stelle, und
// der Lauf meldete Erfolg.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-xyz';
const patcher = require('../src/services/aktionenPatcher');

const AKTION = { id: 7, name: 'Belege' };

describe('Die Anhang-Bedingung fragt das JSON, nicht die Binärdaten', () => {
  const bedingung = (feld) => patcher.bedingungsKnoten(
    AKTION, { regeln: [{ feld, vergleich: 'ist_wahr', wert: '' }] }, [0, 0],
  ).parameters.conditions.conditions[0];

  test('hat_anhang liest $json.hat_anhang', () => {
    assert.equal(bedingung('hat_anhang').leftValue, '={{ $json.hat_anhang }}');
  });

  test('und nicht mehr $binary', () => {
    assert.ok(!String(bedingung('hat_anhang').leftValue).includes('$binary'),
      '$binary löst in einem IF-Knoten nicht auf — die Bedingung wäre immer falsch');
  });

  test('andere Felder bleiben, wie sie waren', () => {
    assert.equal(bedingung('kategorie').leftValue, '={{ $json.kategorie }}');
  });
});

describe('Der Beleg-Knoten holt die Dateien über die UID', () => {
  const konfig = { ordner: 'Belege/{{jahr}}', dateiname: '{{datum}} {{firma}}', auslesen: false };
  const code = patcher.belegDatenKnoten(AKTION, konfig, 'Wenn: Belege', [0, 0]).parameters.jsCode;

  test('erzeugter Code ist gültiges JavaScript', () => {
    assert.doesNotThrow(() => new Function(`return (async () => { ${code} })`));
  });

  test('er fragt den Anhang-Endpunkt des Panels', () => {
    assert.match(code, /api\/internal\/anhaenge/);
    assert.match(code, /X-Panel-Secret/);
    assert.match(code, /test-geheim-xyz/);
  });

  test('mit Konto, UID und Ordner — sonst findet das Panel die Mail nicht', () => {
    assert.match(code, /konto: mail\.json\.konto/);
    assert.match(code, /uid: mail\.json\.uid/);
    assert.match(code, /ordner: mail\.json\.ordner/);
  });

  // Der eigentliche Fehler: Die Schleife lief über ein Feld, das immer leer war.
  test('er sucht die Dateien nicht mehr in den Binärdaten des Items', () => {
    const ohneKommentare = code.split('\n').filter((z) => !z.trim().startsWith('//')).join('\n');
    assert.ok(!/mail\.binary/.test(ohneKommentare),
      'mail.binary ist leer — die Abruf-Knoten holen nur attachmentsInfo');
  });

  test('das Ergebnis wird als n8n-Binärdatei weitergereicht', () => {
    assert.match(code, /data: __a\.base64/, 'der Upload-Knoten liest binaryPropertyName "data"');
    assert.match(code, /fileName: fn/);
    assert.match(code, /binary: \{ data: datei \}/);
  });

  test('Dateien ohne Inhalt werden übersprungen, nicht hochgeladen', () => {
    assert.match(code, /if \(!__a \|\| !__a\.base64\)/);
  });

  test('die Vorfilter bleiben erhalten', () => {
    assert.match(code, /istPdf/, 'nur Belege, keine Bilder aus der Signatur');
    assert.match(code, /BLOCK/, 'AGB und Widerrufsbelehrungen fliegen raus');
    assert.match(code, /groesse < 5000/, 'winzige Dateien sind keine Belege');
  });
});

describe('Auch mit Auslesen bleibt der Weg derselbe', () => {
  const konfig = { ordner: '{{beleg_t1}}/{{beleg_t2}}', dateiname: '{{firma}}', auslesen: true };
  const code = patcher.belegDatenKnoten(AKTION, konfig, 'Wenn: Belege', [0, 0]).parameters.jsCode;

  test('erzeugter Code ist gültiges JavaScript', () => {
    assert.doesNotThrow(() => new Function(`return (async () => { ${code} })`));
  });

  test('das PDF geht zum Auslesen ans Panel — mit dem geholten Inhalt', () => {
    assert.match(code, /beleg-auslesen/);
    assert.match(code, /pdf_base64: datei\.data/);
  });

  test('beide Panel-Aufrufe stehen drin', () => {
    assert.match(code, /api\/internal\/anhaenge/);
    assert.match(code, /api\/internal\/beleg-auslesen/);
  });
});
