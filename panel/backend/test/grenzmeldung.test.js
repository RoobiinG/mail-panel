// Überschreitet eine Mail die Prüfgrenzen (mehr als 20 Anhänge, eine Datei über
// 30 MB), meldet der Virenscan `clean: false` mit `abgebrochen`. Die Mail geht in
// die Quarantäne — aber die Warnung darf dann nicht „VIRUS GEFUNDEN" heißen, und die
// Kurzfassung nicht „Malware-Anhang entfernt".
//
// Wichtiger noch: Die Warnung läuft VOR dem Quarantäne-Knoten. Scheitert sie, bleibt
// die Mail im Posteingang. Der Text kommt zum Teil vom Absender (Dateiname) und geht
// als Markdown an Telegram — er darf dort keinen Eintrag öffnen, der nie schließt.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./umgebung');

const patcher = require('../src/services/workflowPatcher');
const grenzen = require('../src/services/anhangGrenzen');

const WORKFLOWS = ['01-inbox-triage-gemini.json', '01-inbox-triage-ollama.json',
  '04-bestand-triage-gemini.json', '04-bestand-triage-ollama.json'];

const laden = (datei) => JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../workflows', datei), 'utf8'),
);

// Wertet einen n8n-Ausdruck "={{ … }}" aus, mit $json und $('Knoten').item.json.
function auswerten(ausdruck, { json, normalisieren }) {
  const rumpf = String(ausdruck).replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const dollar = () => ({ item: { json: normalisieren } });
  return new Function('$json', '$', `return (${rumpf});`)(json, dollar);
}

const MAIL = { von: 'a@b.example', betreff: 'Rechnung' };

for (const datei of WORKFLOWS) {
  describe(`${datei}: Warnung und Kurzfassung`, () => {
    const wf = laden(datei);
    const warnung = () => wf.nodes.find((k) => k.name === 'Virus Warnung (Telegram)');

    test('der Patcher ändert die Warnung — und beim zweiten Mal nichts mehr', () => {
      const frisch = laden(datei);
      assert.equal(patcher.grenzmeldungEinbauen(frisch), true);
      assert.equal(patcher.grenzmeldungEinbauen(frisch), false, 'wiederholbar, ohne etwas aufzuschichten');
    });

    test('echter Fund: wie bisher „VIRUS GEFUNDEN" mit Virusname', () => {
      const frisch = laden(datei);
      patcher.grenzmeldungEinbauen(frisch);
      const text = auswerten(frisch.nodes.find((k) => k.name === 'Virus Warnung (Telegram)').parameters.text, {
        json: { clean: false, virus: 'Win.Test.EICAR_HDB-1' }, normalisieren: MAIL,
      });
      assert.match(text, /VIRUS GEFUNDEN/);
      assert.match(text, /\nVirus: Win\.Test\.EICAR_HDB-1/);
      assert.doesNotMatch(text, /NICHT PRÜFBAR/);
    });

    test('Grenze überschritten: ehrliche Überschrift und „Grund" statt „Virus"', () => {
      const frisch = laden(datei);
      patcher.grenzmeldungEinbauen(frisch);
      const scan = grenzen.scanAbbruch({ grund: 'zu_viele_anhaenge', text: '21 Anhänge (höchstens 20 erlaubt)' }, 21);
      const text = auswerten(frisch.nodes.find((k) => k.name === 'Virus Warnung (Telegram)').parameters.text, {
        json: scan, normalisieren: MAIL,
      });
      assert.match(text, /ANHÄNGE NICHT PRÜFBAR/);
      assert.doesNotMatch(text, /VIRUS GEFUNDEN/);
      assert.match(text, /\nGrund: Prüfgrenze überschritten: 21 Anhänge/);
      assert.doesNotMatch(text, /\nVirus:/);
      assert.match(text, /Von: a@b\.example/);
    });

    test('die Kurzfassung der Quarantäne ist bei einer Grenzverletzung nicht „Malware"', () => {
      const frisch = laden(datei);
      patcher.grenzmeldungEinbauen(frisch);
      const code = frisch.nodes.find((k) => k.name === 'Virus: Quarantäne').parameters.jsCode;
      const lauf = (scan) => new Function('$', code.replace(/^/, 'return (() => {') + '})()')(
        (name) => (name === 'Normalisieren' ? { item: { json: MAIL } } : { item: { json: scan } }),
      ).json;
      assert.equal(lauf({ clean: false, virus: 'Eicar' }).kurzfassung, 'Malware-Anhang entfernt');
      const grenze = lauf({ clean: false, virus: 'Prüfgrenze überschritten: x', abgebrochen: 'zu_viele_anhaenge' });
      assert.match(grenze.kurzfassung, /nicht prüfbar/);
      assert.equal(grenze.zielordner, 'Quarantaene', 'die Mail geht trotzdem in die Quarantäne');
      assert.equal(grenze.virus_name, 'Prüfgrenze überschritten: x');
    });
  });
}

describe('Markdown: der Dateiname darf die Warnung nicht kaputtmachen', () => {
  // Ein Eintrag mit ungerade vielen _ * ` oder [ lässt Telegram die Nachricht
  // ablehnen. Die Warnung steht vor der Quarantäne — dann bliebe die Mail liegen.
  const ZEICHEN = /[_*`\[\]\\]/;

  test('markdownSicher entfernt alles, was in Markdown etwas öffnet', () => {
    assert.ok(!ZEICHEN.test(grenzen.markdownSicher('rechnung_2026*final*[1]`x`\\.pdf')));
    assert.equal(grenzen.markdownSicher('rechnung_2026.pdf'), 'rechnung 2026.pdf');
    assert.equal(grenzen.markdownSicher(null), '');
  });

  test('ein feindlicher Dateiname landet nicht im Text der Grenzverletzung', () => {
    const v = grenzen.grenzverstoss([{ name: 'boese_*[x](http://evil.example)_.exe', groesse: 50 * 1024 * 1024, encoding: '7bit' }]);
    assert.equal(v.grund, 'datei_zu_gross');
    assert.ok(!ZEICHEN.test(v.text), `im Text: ${v.text}`);
    const scan = grenzen.scanAbbruch(v, 1);
    assert.ok(!ZEICHEN.test(scan.virus), `im Virusfeld: ${scan.virus}`);
  });

  test('auch der Fehler beim Lesen trägt einen sicheren Namen', () => {
    const e = grenzen.zuGrossFehler('a_b*c.zip');
    assert.ok(!ZEICHEN.test(e.verstoss.text), e.verstoss.text);
  });
});
