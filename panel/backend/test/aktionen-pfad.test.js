// Der Beleg-Knoten in Workflow 07 baut den Nextcloud-Pfad aus Dingen, die ein
// Fremder geschrieben hat. Diese Datei führt den ERZEUGTEN Code wirklich aus —
// mit feindlichen Betreffs, Absendern und KI-Antworten — statt nur auf
// Quelltext-Muster zu prüfen. Genau dort sitzt der Weg aus dem Belege-Ordner.
//
// Die Lücke, die hier festgehalten ist: {{betreff}} und {{absender}} landeten
// ungefiltert im Pfad. Ein Betreff "../../" wurde von `fetch` beim Bilden der
// Adresse stillschweigend nach oben aufgelöst.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-xyz';
const settings = require('../src/services/settings');
const patcher = require('../src/services/aktionenPatcher');
const schema = require('../src/services/aktionenSchema');

const AKTION = { id: 9, name: 'Belege' };
const PDF = 'JVBERi0xLjQK'; // "%PDF-1.4"

// Führt den Code des Beleg-Knotens aus, wie n8n es täte: `$()` liefert die Mails,
// `this.helpers.httpRequest` das Panel.
async function belegLaufen(konfig, mails, { lesen } = {}) {
  const code = patcher.belegDatenKnoten(AKTION, konfig, 'Wenn: Belege', [0, 0]).parameters.jsCode;
  const aufgerufen = [];
  const ctx = {
    helpers: {
      httpRequest: async (opt) => {
        aufgerufen.push(opt.url);
        if (opt.url.endsWith('/anhaenge')) {
          return { anhaenge: [{ name: 'Rechnung.pdf', groesse: 20000, base64: PDF }] };
        }
        if (opt.url.endsWith('/beleg-auslesen')) return lesen || { speichern: true };
        throw new Error(`unerwarteter Aufruf: ${opt.url}`);
      },
    },
  };
  const quelle = () => ({ all: () => mails.map((json) => ({ json })) });
  const jetzt = { toFormat: (f) => ({ yyyy: '2026', MM: '10', dd: '01' }[f]) };
  const lauf = new Function('$', '$now', `return (async function () {\n${code}\n});`)(quelle, jetzt);
  const out = await lauf.call(ctx);
  return { out, aufgerufen };
}

const mail = (ueber = {}) => ({
  konto: 'K', uid: 7, ordner: 'INBOX', von: 'Shop <rechnung@shop.example>', betreff: 'Ihre Rechnung', ...ueber,
});

// Kein Segment darf nach oben führen, leer sein oder Steuerzeichen tragen.
function segmenteOk(pfad) {
  assert.ok(pfad.length > 0, 'nie leer');
  assert.ok(!pfad.startsWith('/'), `kein absoluter Pfad: ${pfad}`);
  for (const teil of pfad.split('/')) {
    assert.ok(teil !== '' && teil !== '.' && teil !== '..', `Segment "${teil}" in ${pfad}`);
    assert.ok(!/[\p{Cc}\p{Cf}\\]/u.test(teil), `Steuerzeichen in ${pfad}`);
  }
}

const BETREFFE = [
  '../../../etc/passwd', '..\\..\\Windows', '..', '/absolut', '%2e%2e%2f%2e%2e',
  'a/../../b', 'x∕..∕y', '．．／', 'null\u0000byte', '‮gnp.exe',
];

describe('Ohne Auslesen: Betreff und Absender im Pfad', () => {
  const konfig = { ordner: 'Belege/{{absender}}/{{betreff}}', dateiname: '{{betreff}}', auslesen: false };

  for (const betreff of BETREFFE) {
    test(`Betreff ${JSON.stringify(betreff)} bleibt im Belege-Ordner`, async () => {
      const { out } = await belegLaufen(konfig, [mail({ betreff })]);
      assert.equal(out.length, 1);
      const z = out[0].json.zielordner;
      segmenteOk(z);
      assert.equal(z.split('/')[0], 'Belege', 'der feste Anfang bleibt der Anfang');
      assert.equal(z.split('/').length, 3, `jeder Wert bleibt EIN Segment: ${z}`);
      assert.ok(!/[\\/]/.test(out[0].json.dateiname), `Dateiname ohne Trenner: ${out[0].json.dateiname}`);
    });
  }

  test('ein feindlicher Absender macht keine neue Ebene auf', async () => {
    const { out } = await belegLaufen(konfig, [mail({ von: '../../x <../..@evil.example>' })]);
    segmenteOk(out[0].json.zielordner);
    assert.equal(out[0].json.zielordner.split('/').length, 3);
  });

  test('ein harmloser Betreff bleibt lesbar', async () => {
    const { out } = await belegLaufen(konfig, [mail({ betreff: 'Rechnung RE-2026-17 (Oktober)' })]);
    assert.match(out[0].json.zielordner, /\/Rechnung RE-2026-17 \(Oktober\)$/);
  });

  test('ein Betreff aus lauter Punkten wird "unbekannt", nicht leer', async () => {
    const { out } = await belegLaufen(konfig, [mail({ betreff: '. . .' })]);
    assert.match(out[0].json.zielordner, /\/unbekannt$/);
  });
});

describe('Mit Auslesen: Firma und Aktenzeichen aus dem PDF', () => {
  const konfig = { ordner: '{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}', dateiname: '{{firma}}', auslesen: true };

  test('../ in Firma und Aktenzeichen ändert den Ort nicht', async () => {
    const { out } = await belegLaufen(konfig, [mail()], {
      lesen: { speichern: true, firma: '../../../Eigene Dateien', aktenzeichen: 'AZ/../../geheim', datum: '2026-09-30' },
    });
    const z = out[0].json.zielordner;
    segmenteOk(z);
    assert.equal(z.split('/').length, 3, `Basis/Firma/Aktenzeichen: ${z}`);
    assert.equal(z.split('/')[0], 'Belege');
  });

  test('ein erfundenes Datum wird nicht übernommen', async () => {
    const { out } = await belegLaufen(konfig, [mail()], {
      lesen: { speichern: true, firma: 'Acme', aktenzeichen: '', datum: '../../2026' },
    });
    const z = out[0].json.zielordner;
    segmenteOk(z);
    assert.match(z, /^Belege\/\d{4}\/Acme$/, 'ohne Aktenzeichen: Basis/Jahr/Firma');
  });

  test('ein Basispfad mit .. in den Einstellungen bricht ebenfalls nicht aus', async () => {
    settings.setze('nextcloud_beleg_pfad', '../../Fremd/Belege');
    try {
      const { out } = await belegLaufen(konfig, [mail()], { lesen: { speichern: true, firma: 'Acme', aktenzeichen: 'A1' } });
      segmenteOk(out[0].json.zielordner);
      assert.equal(out[0].json.zielordner, 'Fremd/Belege/Acme/A1');
    } finally {
      settings.setze('nextcloud_beleg_pfad', '');
    }
  });

  test('ein mehrstufiger Basispfad bleibt mehrstufig', async () => {
    settings.setze('nextcloud_beleg_pfad', 'Ablage/Belege');
    try {
      const { out } = await belegLaufen(konfig, [mail()], { lesen: { speichern: true, firma: 'Acme', aktenzeichen: 'A1' } });
      assert.equal(out[0].json.zielordner, 'Ablage/Belege/Acme/A1');
    } finally {
      settings.setze('nextcloud_beleg_pfad', '');
    }
  });
});

describe('Statische Vorlagen bleiben, wie sie waren', () => {
  test('Belege/{{jahr}} wird zu Belege/2026', async () => {
    const { out } = await belegLaufen({ ordner: 'Belege/{{jahr}}', auslesen: false }, [mail()]);
    assert.equal(out[0].json.zielordner, 'Belege/2026');
  });

  test('".." in der Vorlage selbst fällt weg', async () => {
    const { out } = await belegLaufen({ ordner: '../../etc/{{jahr}}', auslesen: false }, [mail()]);
    assert.equal(out[0].json.zielordner, 'etc/2026');
  });
});

describe('Die Knoten danach setzen nichts Fremdes mehr selbst ein', () => {
  test('hatFremdes unterscheidet Uhr-Werte von Mail- und PDF-Werten', () => {
    assert.equal(patcher.hatFremdes('Belege/{{jahr}}/{{monat}}'), false);
    assert.equal(patcher.hatFremdes('Belege/{{firma}}'), true);
    assert.equal(patcher.hatFremdes('Belege/{{betreff}}'), true);
    assert.equal(patcher.hatFremdes('{{beleg_t1}}/{{beleg_t2}}'), true);
    assert.equal(patcher.hatFremdes('Belege'), false);
  });

  test('Upload-Knoten: bei fremden Werten der fertige Zielordner', () => {
    const k = patcher.nextcloudDateiKnoten(AKTION, { ordner: 'Belege/{{betreff}}' }, [0, 0], null);
    assert.equal(k.parameters.path, '={{ $json.zielordner }}/{{ $json.dateiname }}');
  });

  test('Upload-Knoten: bei rein statischem Pfad wie gehabt', () => {
    const k = patcher.nextcloudDateiKnoten(AKTION, { ordner: 'Belege/{{jahr}}' }, [0, 0], null);
    assert.equal(k.parameters.path, "=Belege/{{ $now.toFormat('yyyy') }}/{{ $json.dateiname }}");
  });

  test('Ordner-Knoten: die ersten n Ebenen des fertigen Zielordners, vom Beleg-Knoten', () => {
    const v = patcher.vorlageAufloesen('Belege/{{firma}}/{{aktenzeichen}}');
    assert.equal(
      patcher.teilPfadAusdruck(v, 2, 'Beleg lesen: Belege'),
      "{{ $(\"Beleg lesen: Belege\").item.json.zielordner.split('/').slice(0, 2).join('/') }}",
    );
  });

  test('Ordner-Knoten: ein statischer Pfad bleibt ein statischer Pfad', () => {
    const v = patcher.vorlageAufloesen('Belege/{{jahr}}');
    assert.equal(patcher.teilPfadAusdruck(v, 1, 'x'), 'Belege');
    assert.equal(patcher.teilPfadAusdruck(v, 2, 'x'), "Belege/{{ $now.toFormat('yyyy') }}");
  });

  test('im Pfad-Ausdruck steht kein Mail-Feld', () => {
    for (const vorlage of ['Belege/{{betreff}}', '{{absender}}/{{firma}}', 'x/{{beleg_t2}}']) {
      const v = patcher.vorlageAufloesen(vorlage);
      const a = patcher.teilPfadAusdruck(v, 1, 'B');
      assert.ok(!/\$json\.(von|betreff|firma|aktenzeichen)/.test(a), a);
    }
  });
});

// Der Name der Aktion steckt in Knotennamen, und die stehen in n8n-Ausdrücken.
describe('Aktionsnamen können keinen Code einschleusen', () => {
  const entwurf = (name) => ({
    name,
    typ: 'webhook',
    bedingung: { verknuepfung: 'und', regeln: [{ feld: 'kategorie', vergleich: 'ist', wert: 'rechnung' }] },
    konfig: { url: 'https://example.org/x' },
  });

  for (const name of ["x') + process.exit() + ('", 'a}}{{ $env.X', 'a`b', 'a\\b', '${x}', 'a"b']) {
    test(`Name ${JSON.stringify(name)} verliert die Ausbruchszeichen`, () => {
      const r = schema.pruefe(entwurf(name));
      if (!r.ok) return; // zu kurz geworden — auch in Ordnung
      assert.ok(!/['"`\\${}]/.test(r.aktion.name), r.aktion.name);
    });
  }

  test('ein gewöhnlicher Name bleibt unverändert', () => {
    assert.equal(schema.pruefe(entwurf('Rechnungen ablegen')).aktion.name, 'Rechnungen ablegen');
  });

  test('besteht der Name nur aus Ausbruchszeichen, ist er ungültig', () => {
    assert.equal(schema.pruefe(entwurf("'\"`")).ok, false);
  });
});
