// Googles Kontingente gelten je Modell. Ist das Tageslimit des einen erreicht,
// hat ein anderes noch sein eigenes — ein Wechsel bringt also wirklich neue
// Laeufe. Was hier festgenagelt wird, ist vor allem die Zurueckhaltung: Ohne
// eingetragenes Ersatzmodell passiert gar nichts, denn das Ersatzmodell ist
// meist das groessere und kostet mit Abrechnung mehr.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');
const kiModell = require('../src/services/kiModell');

const heute = () => new Date().toLocaleDateString('sv-SE');

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_modell%'").run();
  // Der Wechsel schreibt in die Workflows — hier nur zaehlen, nicht n8n rufen.
  patcher.geminiModellNachziehen = async () => 2;
});

describe('Welches Modell gilt', () => {
  test('ohne alles das Standardmodell', () => {
    assert.equal(kiModell.aktiv(), kiModell.STANDARD);
    assert.equal(kiModell.stand().ersatz, null);
    assert.equal(kiModell.stand().aufErsatz, false);
  });

  test('ein eingetragenes erstes Modell gilt', () => {
    settings.setze('gemini_modell', 'gemini-4-mini');
    assert.equal(kiModell.aktiv(), 'gemini-4-mini');
  });
});

describe('Wechsel bei voller Quote', () => {
  test('ohne Ersatzmodell passiert nichts', async () => {
    assert.equal(await kiModell.beiAbweisung(), null);
    assert.equal(kiModell.aktiv(), kiModell.STANDARD, 'niemand wechselt ungefragt das Modell');
  });

  test('mit Ersatzmodell wird umgeschaltet', async () => {
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    assert.equal(await kiModell.beiAbweisung(), 'gemini-3.5-flash');
    assert.equal(kiModell.aktiv(), 'gemini-3.5-flash');
    assert.equal(kiModell.stand().aufErsatz, true);
  });

  test('ein zweites Mal am selben Tag bringt nichts mehr', async () => {
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    await kiModell.beiAbweisung();
    assert.equal(await kiModell.beiAbweisung(), null,
      'dann ist auch das zweite Kontingent leer — weiterspringen waere Unsinn');
  });
});

describe('Zurueck am naechsten Tag', () => {
  test('neuer Tag, erstes Modell', async () => {
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    await kiModell.beiAbweisung();
    settings.setze('gemini_modell_seit', '2020-01-01');

    assert.equal(await kiModell.taeglichPruefen(), kiModell.STANDARD);
    assert.equal(kiModell.aktiv(), kiModell.STANDARD);
  });

  test('am selben Tag bleibt es beim Ersatzmodell', async () => {
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    await kiModell.beiAbweisung();
    assert.equal(settings.hole('gemini_modell_seit'), heute());
    assert.equal(await kiModell.taeglichPruefen(), null);
    assert.equal(kiModell.aktiv(), 'gemini-3.5-flash');
  });

  test('wer nie gewechselt hat, hat auch nichts zurueckzusetzen', async () => {
    assert.equal(await kiModell.taeglichPruefen(), null);
  });
});

describe('Das Modell steht in den Workflow-Knoten', () => {
  const geminiKnoten = () => ({
    nodes: [{
      name: 'Gemini klassifizieren',
      type: 'n8n-nodes-base.httpRequest',
      parameters: {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
      },
    }],
  });

  test('das aktive Modell wird eingetragen — auch das abgekuendigte alte ersetzt', () => {
    const wf = geminiKnoten();
    assert.equal(patcher.geminiRequestReparieren(wf), true);
    assert.match(wf.nodes[0].parameters.url, new RegExp(`models/${kiModell.STANDARD}:generateContent`));
  });

  test('nach dem Wechsel steht das Ersatzmodell drin', async () => {
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    await kiModell.beiAbweisung();

    const wf = geminiKnoten();
    patcher.geminiRequestReparieren(wf);
    assert.match(wf.nodes[0].parameters.url, /models\/gemini-3\.5-flash:generateContent/);
  });

  test('steht es schon richtig, wird der Workflow nicht angefasst', () => {
    const wf = geminiKnoten();
    patcher.geminiRequestReparieren(wf);
    assert.equal(patcher.geminiRequestReparieren(wf), false,
      'sonst schreibt jeder Rundgang denselben Workflow neu nach n8n');
  });
});
