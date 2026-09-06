// Wie viele KI-Abfragen laesst Google heute noch zu?
//
// Die ehrliche Antwort: Google gibt das nicht heraus — keine Kopfzeile mit dem
// Rest, kein Endpunkt zum Nachfragen, nur das Dashboard im AI Studio. Was das
// Panel stattdessen tut, steht hier: selbst zaehlen, und sich merken, an welcher
// Stelle Google abgewiesen hat. Diese Zahl ist das praktische Tageslimit.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const n8n = require('../src/services/n8n');
const kontingent = require('../src/services/kiKontingent');

// n Mails durch die KI — und n Anfragen dafuer. In Workflow 01 ist das dasselbe
// (eine Mail je Ausloesung), und genau so zaehlt es das Panel: protokolliert
// wird die Mail, vermerkt wird die Anfrage.
const kiLog = (n) => {
  for (let i = 0; i < n; i += 1) {
    db.prepare("INSERT INTO quarantine_log (konto, von, ki) VALUES ('K', ?, 1)").run(`m${i}@x.de`);
  }
  require('../src/services/budget').ausgabeMerken(n);
};

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'ki_%' OR key = 'gemini_tagesbudget'").run();
});

describe('Was das Panel weiss', () => {
  test('ohne Abweisung nur die eigene Zaehlung', () => {
    settings.setze('gemini_tagesbudget', '400');
    kiLog(12);
    const s = kontingent.stand();
    assert.equal(s.verbraucht, 12);
    assert.equal(s.grenze, 400);
    assert.equal(s.rest, 388);
    assert.equal(s.beobachtet, null);
    assert.match(s.quelle, /eigene/, 'die Zahl kommt nicht von Google, das muss dranstehen');
  });

  test('ohne Budget gibt es keinen Rest — und das ist kein Fehler', () => {
    settings.setze('gemini_tagesbudget', '0');
    kiLog(3);
    const s = kontingent.stand();
    assert.equal(s.grenze, 0);
    assert.equal(s.rest, null);
    assert.equal(s.verbraucht, 3, 'gezaehlt wird trotzdem');
  });

  test('eine Abweisung haelt den Stand fest', () => {
    kiLog(412);
    assert.equal(kontingent.abweisungMerken('2026-09-05T16:00:00.000Z'), 412);
    const s = kontingent.stand();
    assert.equal(s.beobachtet.stand, 412, 'so viele Abfragen gingen heute durch');
    assert.equal(s.beobachtet.zeit, '2026-09-05T16:00:00.000Z');
  });

  test('die Abweisung von gestern zaehlt heute nicht mehr', () => {
    kiLog(5);
    kontingent.abweisungMerken();
    settings.setze('ki_429_tag', '2020-01-01');
    assert.equal(kontingent.stand().beobachtet, null,
      'Kontingente laufen taeglich neu — eine alte Zahl waere eine Falschauskunft');
  });
});

describe('Abweisung in den n8n-Laeufen finden', () => {
  test('erkennt die Kontingent-Meldung und merkt sich den Stand', async () => {
    kiLog(207);
    n8n.executionsAuflisten = async () => ([
      { id: '51', status: 'error', stoppedAt: '2026-09-05T14:00:00.000Z' },
    ]);
    n8n.client = () => ({
      get: async () => ({
        data: {
          data: { resultData: { error: { message: 'The service is receiving too many requests from you' } } },
        },
      }),
    });

    assert.equal(await kontingent.nachAbweisungSehen(), 207);
    assert.equal(kontingent.stand().beobachtet.stand, 207);
  });

  test('ein anderer Fehler ist keine Abweisung', async () => {
    kiLog(9);
    n8n.executionsAuflisten = async () => ([{ id: '52', status: 'error' }]);
    n8n.client = () => ({
      get: async () => ({ data: { data: { resultData: { error: { message: 'No folder Newsletter' } } } } }),
    });

    assert.equal(await kontingent.nachAbweisungSehen(), null);
    assert.equal(kontingent.stand().beobachtet, null);
  });

  test('ist die Abweisung fuer heute bekannt, wird n8n gar nicht erst gefragt', async () => {
    kiLog(4);
    kontingent.abweisungMerken();
    let gefragt = false;
    n8n.executionsAuflisten = async () => { gefragt = true; return []; };

    await kontingent.nachAbweisungSehen();
    assert.equal(gefragt, false, 'eine Detailabfrage bringt Megabytes mit — nicht ohne Not');
  });

  test('schon geprüfte Ausfuehrungen werden nicht erneut geladen', async () => {
    let geladen = 0;
    n8n.executionsAuflisten = async () => ([{ id: '60', status: 'error' }]);
    n8n.client = () => ({
      get: async () => {
        geladen += 1;
        return { data: { data: { resultData: { error: { message: 'irgendwas' } } } } };
      },
    });

    await kontingent.nachAbweisungSehen();
    await kontingent.nachAbweisungSehen();
    assert.equal(geladen, 1);
  });

  test('ist n8n nicht erreichbar, passiert einfach nichts', async () => {
    n8n.executionsAuflisten = async () => { throw new Error('weg'); };
    assert.equal(await kontingent.nachAbweisungSehen(), null);
  });
});

// Die Zahl, die es angeblich nicht gibt, steht doch in der Absage:
//   "Quota exceeded for metric: ...generate_content_free_tier_requests,
//    limit: 500, model: gemini-3.5-flash-lite"
// Aus einem echten Lauf. Sie schlaegt die eigene Zaehlung, denn die liegt
// zwangslaeufig zu niedrig: Stirbt ein Lauf am Gemini-Knoten, wird keine der
// vorher klassifizierten Mails protokolliert — gekostet haben sie trotzdem.
describe('Googles eigene Zahl aus der Absage', () => {
  const echteMeldung = 'The service is receiving too many requests from you. You exceeded your'
    + ' current quota. * Quota exceeded for metric:'
    + ' generativelanguage.googleapis.com/generate_content_free_tier_requests,'
    + ' limit: 500, model: gemini-3.5-flash-lite Please retry in 53.834900834s.';

  test('Limit und Modell werden herausgelesen', () => {
    assert.deepEqual(kontingent.limitAusMeldung(echteMeldung),
      { limit: 500, modell: 'gemini-3.5-flash-lite' });
  });

  test('eine Meldung ohne Zahlen ergibt keine erfundene', () => {
    assert.deepEqual(kontingent.limitAusMeldung('too many requests'), { limit: 0, modell: null });
    assert.deepEqual(kontingent.limitAusMeldung(null), { limit: 0, modell: null });
  });

  test('die Abweisung merkt sich beides', () => {
    kiLog(412);
    kontingent.abweisungMerken('2026-09-06T00:24:00.000Z', echteMeldung);
    const s = kontingent.stand();
    assert.equal(s.beobachtet.limit, 500, 'Googles Zahl');
    assert.equal(s.beobachtet.stand, 412, 'die eigene daneben — die Luecke ist die Aussage');
    assert.equal(s.beobachtet.modell, 'gemini-3.5-flash-lite');
  });

  test('ohne Zahl in der Meldung bleibt es beim eigenen Stand', () => {
    kiLog(207);
    kontingent.abweisungMerken(undefined, 'too many requests');
    const s = kontingent.stand();
    assert.equal(s.beobachtet.limit, 0);
    assert.equal(s.beobachtet.stand, 207);
  });

  test('die ausfuehrliche Meldung steht am Knoten, nicht oben', async () => {
    kiLog(400);
    n8n.executionsAuflisten = async () => ([{ id: '77', status: 'error' }]);
    n8n.client = () => ({
      get: async () => ({
        data: {
          data: {
            resultData: {
              // Oben nur der erste Satz — genau wie n8n es liefert.
              error: { message: 'The service is receiving too many requests from you' },
              runData: { 'Gemini klassifizieren': [{ error: { message: echteMeldung } }] },
            },
          },
        },
      }),
    });

    await kontingent.nachAbweisungSehen();
    assert.equal(kontingent.stand().beobachtet.limit, 500,
      'sonst bliebe die einzige harte Zahl liegen, die Google je herausgibt');
  });
});
