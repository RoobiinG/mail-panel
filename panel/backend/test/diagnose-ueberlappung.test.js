// Der Überlappungs-Hinweis im Diagnosebericht — und woran er am 23.09. falsch lag.
//
// Gemeldet wurde „3 Läufe überlappten sich … N8N_CONCURRENCY_PRODUCTION_LIMIT
// greift offenbar nicht". Tatsächlich waren es zwei Inbox-Läufe von je unter
// einer Sekunde und ein Workflow 07 — ein Unter-Workflow, für den die Grenze
// gar nicht gilt. Die zwei Inbox-Läufe überlappten auch nur, weil ihre Dauer
// auf ganze Sekunden gerundet wurde.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const diagnose = require('../src/services/diagnose');
const n8n = require('../src/services/n8n');

const echt = {
  workflowsAuflisten: n8n.workflowsAuflisten,
  executionsAuflisten: n8n.executionsAuflisten,
  executionKnotenZeiten: n8n.executionKnotenZeiten,
};
afterEach(() => Object.assign(n8n, echt));

const ms = (s) => new Date(Date.UTC(2026, 8, 23, 11, 19, 0) + s * 1000).toISOString();

const laeufeAus = async (liste, zeiten = null) => {
  n8n.workflowsAuflisten = async () => [];
  n8n.executionsAuflisten = async () => liste;
  if (zeiten) n8n.executionKnotenZeiten = zeiten;
  settings.setze('ki_anbieter', 'ollama');
  const b = await diagnose.erstellen({ mitMails: false });
  return b.laeufe;
};

describe('Gezählt wird nur, was die Grenze auch begrenzt', () => {
  test('Unter-Workflows und Editor-Läufe zählen nicht', async () => {
    const r = await laeufeAus([
      { id: 1, startedAt: ms(0), stoppedAt: ms(300), status: 'success', mode: 'trigger', workflowId: 'A' },
      { id: 2, startedAt: ms(10), stoppedAt: ms(20), status: 'success', mode: 'integrated', workflowId: 'B' },
      { id: 3, startedAt: ms(30), stoppedAt: ms(40), status: 'success', mode: 'manual', workflowId: 'C' },
    ]);
    assert.equal(r.hoechsteGleichzeitig, 1);
    assert.equal(r.hinweis, undefined);
    assert.match(r.nichtGezaehlt, /2 Unter-Workflow/);
    assert.equal(r.liste[1].modus, 'integrated', 'der Modus steht im Bericht');
  });

  test('genaue Zeiten statt gerundeter Sekunden', async () => {
    // Genau der Fall vom 23.09.: 0,6 s und 0,65 s später der nächste.
    const a = Date.UTC(2026, 8, 23, 11, 19, 41, 615);
    const r = await laeufeAus([
      { id: 1, startedAt: new Date(a).toISOString(), stoppedAt: new Date(a + 600).toISOString(), status: 'success', mode: 'trigger' },
      { id: 2, startedAt: new Date(a + 685).toISOString(), stoppedAt: new Date(a + 1200).toISOString(), status: 'success', mode: 'trigger' },
    ]);
    assert.equal(r.hoechsteGleichzeitig, 1, 'nacheinander, nicht gleichzeitig');
  });

  test('ein abgestürzter Lauf ohne Endzeit überlappt nicht alles Spätere', async () => {
    const r = await laeufeAus([
      { id: 1, startedAt: ms(0), stoppedAt: null, status: 'crashed', mode: 'trigger' },
      { id: 2, startedAt: ms(10), stoppedAt: ms(20), status: 'success', mode: 'trigger' },
    ]);
    assert.equal(r.hoechsteGleichzeitig, 1);
  });

  test('echte Überlappung über der Grenze meldet weiterhin den Verdacht', async () => {
    const r = await laeufeAus([0, 1, 2].map((i) => ({
      id: i + 1, startedAt: ms(i), stoppedAt: ms(300), status: 'success', mode: 'trigger',
    })));
    assert.equal(r.hoechsteGleichzeitig, 3);
    assert.match(r.hinweis, /git pull/);
  });
});

describe('Wo lange Läufe ihre Zeit lassen', () => {
  test('für Läufe über zwei Minuten stehen die langsamsten Knoten im Bericht', async () => {
    const gefragt = [];
    const r = await laeufeAus([
      { id: 7, startedAt: ms(0), stoppedAt: ms(1144), status: 'success', mode: 'trigger' },
      { id: 8, startedAt: ms(2000), stoppedAt: ms(2030), status: 'success', mode: 'trigger' },
    ], async (id) => {
      gefragt.push(id);
      return [
        { knoten: 'Bestand: g.example', ms: 540000, items: 250 },
        { knoten: 'KI klassifizieren', ms: 598000, items: 40 },
      ].sort((a, b) => b.ms - a.ms);
    });
    assert.deepEqual(gefragt, [7], 'der kurze Lauf wird nicht nachgefragt');
    const lang = r.liste.find((l) => l.dauerSekunden === 1144);
    assert.equal(lang.langsamsteKnoten[0].knoten, 'KI klassifizieren');
    assert.equal(lang.langsamsteKnoten[0].sekunden, 598);
    assert.equal(lang.langsamsteKnoten[1].items, 250);
    assert.equal(lang.__id, undefined, 'interne Felder gehören nicht in den Bericht');
  });
});
