// Das Aktions-Schema ist der Torwächter: Was hier nicht durchkommt, landet nie
// in n8n. Die neuen Beleg-Felder (dateiname, auslesen) und der Preset müssen
// sauber durch die Prüfung gehen.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const schema = require('../src/services/aktionenSchema');

describe('nextcloud_datei: neue Felder', () => {
  test('dateiname und auslesen werden übernommen', () => {
    const r = schema.pruefe({
      name: 'Belege',
      typ: 'nextcloud_datei',
      bedingung: { verknuepfung: 'und', regeln: [{ feld: 'von', vergleich: 'enthaelt', wert: 'amazon' }] },
      konfig: { ordner: 'Belege/{{jahr}}/{{firma}}', dateiname: '{{datum}} {{firma}}', auslesen: true },
    });
    assert.equal(r.ok, true, JSON.stringify(r.fehler));
    assert.equal(r.aktion.konfig.auslesen, true);
    assert.equal(r.aktion.konfig.dateiname, '{{datum}} {{firma}}');
  });

  test('auslesen fehlt ⇒ Standard false', () => {
    const r = schema.pruefe({
      name: 'Belege',
      typ: 'nextcloud_datei',
      bedingung: { verknuepfung: 'und', regeln: [{ feld: 'von', vergleich: 'enthaelt', wert: 'x' }] },
      konfig: { ordner: 'Belege' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.aktion.konfig.auslesen, false);
  });
});

describe('Platzhalter', () => {
  test('firma, datum, aktenzeichen sind erlaubt', () => {
    const p = schema.beschreibung().platzhalter;
    for (const t of ['{{firma}}', '{{datum}}', '{{aktenzeichen}}']) {
      assert.ok(p.includes(t), `${t} sollte in der Platzhalterliste stehen`);
    }
  });
});

describe('Beleg-Automatik-Preset', () => {
  test('die Bedingung (Rechnung oder Bestellung) besteht die Prüfung', () => {
    const r = schema.pruefe({
      name: 'Belege automatisch in Nextcloud',
      typ: 'nextcloud_datei',
      bedingung: {
        verknuepfung: 'oder',
        regeln: [
          { feld: 'kategorie', vergleich: 'ist', wert: 'rechnung' },
          { feld: 'kategorie', vergleich: 'ist', wert: 'bestellung' },
        ],
      },
      konfig: {
        ordner: '{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}',
        dateiname: '{{datum}} {{firma}} {{betreff}}',
        nur_anhaenge: true,
        auslesen: true,
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r.fehler));
    assert.equal(r.aktion.bedingung.verknuepfung, 'oder');
    assert.equal(r.aktion.bedingung.regeln.length, 2);
  });
});
