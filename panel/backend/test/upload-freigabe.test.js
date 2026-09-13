// Der Schalter „Vor dem Hochladen fragen" und der Knoten, den er erzeugt.
//
// Zwei Fallen stecken hier, die beide gültigen Code erzeugen und trotzdem falsch
// sind — und genau deshalb ohne Test niemandem auffallen:
//
//   1. Ein Schemafeld ohne Anschluss im Patcher ist wirkungslos, erscheint aber
//      in der Oberfläche. `nur_anhaenge` steht so seit Jahren im Schema.
//   2. jsPlatzhalter kannte {{beleg_t1..3}} nicht. Das Beleg-Preset benutzt
//      genau die als Ordner — ohne Ergänzung entschärft die Funktion sie zu
//      wörtlichem "(beleg_t1)", und jede Datei läge unter einem Ordner dieses
//      Namens.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-xyz';
const schema = require('../src/services/aktionenSchema');
const patcher = require('../src/services/aktionenPatcher');

const AKTION = { id: 7, name: 'Belege' };

describe('Der Schalter steht im Schema', () => {
  const felder = schema.TYPEN.nextcloud_datei.felder;
  // pruefe() weist einen Entwurf ohne Bedingung ab — sie würde ja auf jede Mail
  // zutreffen. Für die Konfigurationsprüfung genügt irgendeine gültige.
  const mitBedingung = (konfig) => ({
    name: 'Testaktion', typ: 'nextcloud_datei',
    bedingung: { regeln: [{ feld: 'hat_anhang', vergleich: 'ist_wahr', wert: '' }] },
    konfig,
  });

  test('freigabe ist ein Boolean-Feld', () => {
    assert.equal(felder.freigabe.typ, 'boolean',
      'ohne typ:boolean rendert die Oberfläche ein Textfeld statt einer Checkbox');
  });

  test('und steht standardmäßig aus', () => {
    assert.equal(felder.freigabe.standard, false,
      'ein Update darf das Verhalten bestehender Aktionen nicht ändern');
  });

  test('pruefe() lässt den Wert durch und macht einen echten Boolean daraus', () => {
    const geprueft = schema.pruefe(mitBedingung({ ordner: 'Belege', freigabe: 'ja' }));
    assert.equal(geprueft.ok, true, JSON.stringify(geprueft.fehler));
    assert.equal(geprueft.aktion.konfig.freigabe, true);
  });

  test('ohne Angabe bleibt es aus', () => {
    const geprueft = schema.pruefe(mitBedingung({ ordner: 'Belege' }));
    assert.equal(geprueft.ok, true, JSON.stringify(geprueft.fehler));
    assert.equal(geprueft.aktion.konfig.freigabe, false);
  });
});

describe('jsPlatzhalter kennt die Beleg-Bausteine', () => {
  test('{{beleg_t1..3}} werden zu Feldern, nicht zu Klammertext', () => {
    const s = patcher.jsPlatzhalter('{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}', 'j');
    assert.match(s, /\$\{j\.beleg_t1\}/);
    assert.match(s, /\$\{j\.beleg_t2\}/);
    assert.match(s, /\$\{j\.beleg_t3\}/);
    assert.ok(!s.includes('(beleg_t1)'),
      'sonst landet jede Datei unter einem Ordner namens "(beleg_t1)"');
  });

  test('die öffentlichen Platzhalter funktionieren weiterhin', () => {
    const s = patcher.jsPlatzhalter('{{firma}}/{{datum}}', 'j');
    assert.match(s, /\$\{j\.firma\}/);
    assert.match(s, /\$\{j\.datum\}/);
  });

  // Die Entschärfung ist der Grund, warum die Ergänzung überhaupt nötig war —
  // sie muss für alles Unbekannte weiter greifen.
  test('Unbekanntes wird weiterhin entschärft', () => {
    const s = patcher.jsPlatzhalter('${process.env.PANEL_SECRET}', 'j');
    assert.ok(!s.includes('${process'), 'sonst ließe sich Code einschleusen');
  });
});

describe('Der Freigabe-Knoten', () => {
  const konfig = { ordner: '{{beleg_t1}}/{{beleg_t2}}', dateiname: '{{firma}}', freigabe: true };
  const code = patcher.freigabeKnoten(AKTION, konfig, 'Beleg lesen: Belege', [0, 0]).parameters.jsCode;

  test('erzeugter Code ist gültiges JavaScript', () => {
    assert.doesNotThrow(() => new Function(`return (async () => { ${code} })`));
  });

  test('er liefert beim Panel ab, statt hochzuladen', () => {
    assert.match(code, /api\/internal\/upload-freigabe/);
    assert.match(code, /X-Panel-Secret/);
    assert.match(code, /test-geheim-xyz/);
    assert.ok(!code.includes('nextCloud'), 'hochgeladen wird später vom Panel');
  });

  test('der Zielpfad ist ausgerechnet, nicht wörtlich', () => {
    assert.match(code, /\$\{j\.beleg_t1\}/);
    assert.ok(!code.includes('(beleg_t1)'));
  });

  test('die Datei geht als base64 mit', () => {
    assert.match(code, /base64: datei\.data/);
  });

  // Der Lauf trüge die Dateien sonst ein zweites Mal mit sich herum.
  test('zurück kommt nur eine Zusammenfassung, keine Binärdaten', () => {
    assert.match(code, /return \[\{ json: \{ eingeliefert/);
    assert.ok(!/return __raus/.test(code));
  });

  test('er liest beim Beleg-Knoten, nicht beim Bedingungs-Knoten', () => {
    assert.match(code, /\$\("Beleg lesen: Belege"\)\.all\(\)/);
  });

  test('ein Pfad mit .. wird gesäubert', () => {
    const c = patcher.freigabeKnoten(
      AKTION, { ordner: '../../etc/{{firma}}' }, 'Beleg lesen: Belege', [0, 0],
    ).parameters.jsCode;
    assert.ok(!c.includes('..'), 'sonst bricht der Pfad aus dem Zielordner aus');
  });
});
