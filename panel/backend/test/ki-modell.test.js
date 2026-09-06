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

// Ein Ersatzmodell, das dem ersten gleicht, ist keins — und genau das stand im
// Betrieb in beiden Feldern. Der Fehlgriff sieht harmlos aus: Das Feld ist
// gefuellt, also glaubt man, es sei eingerichtet. Tatsaechlich hielt sich das
// Panel damit von der ersten Sekunde an fuer umgeschaltet.
describe('Dasselbe Modell zweimal ist kein Ersatz', () => {
  test('es zaehlt nicht als eingerichtet', () => {
    settings.setze('gemini_modell', 'gemini-3.5-flash-lite');
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash-lite');
    assert.equal(kiModell.ersatz(), '');
    assert.equal(kiModell.stand().ersatz, null);
    assert.equal(kiModell.aufErsatz(), false, 'sonst wechselt das Panel nie');
  });

  test('und es wird auch nicht gewechselt', async () => {
    settings.setze('gemini_modell_ersatz', kiModell.STANDARD);
    assert.equal(await kiModell.beiAbweisung(), null);
    assert.equal(kiModell.aktiv(), kiModell.STANDARD);
  });

  test('ein wirklich anderes Modell zaehlt', () => {
    settings.setze('gemini_modell', 'gemini-3.5-flash-lite');
    settings.setze('gemini_modell_ersatz', 'gemini-3.5-flash');
    assert.equal(kiModell.ersatz(), 'gemini-3.5-flash');
  });
});

// Statt den Modellnamen tippen zu lassen, wird Google gefragt. Ein Tippfehler
// faellt sonst erst auf, wenn mitten in einem Lauf ein 404 zurueckkommt.
describe('Die Modellliste kommt von Google', () => {
  const antwort = {
    models: [
      { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'schnell',
        supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite',
        supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Einbettungen',
        supportedGenerationMethods: ['embedContent'] },
    ],
  };

  let gerufen;
  const fetchStub = (status = 200, koerper = antwort) => {
    gerufen = [];
    global.fetch = async (url, opt) => {
      gerufen.push({ url: String(url), opt });
      return { ok: status === 200, status, json: async () => koerper };
    };
  };

  beforeEach(() => {
    kiModell.listeVergessen();
    settings.setze('gemini_api_key', 'geheimer-schluessel');
  });

  test('nur was klassifizieren kann, und ohne das Praefix "models/"', async () => {
    fetchStub();
    const { modelle, fehler } = await kiModell.verfuegbare();
    assert.equal(fehler, null);
    assert.deepEqual(modelle.map((m) => m.name), ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
      'ein Einbettungsmodell waere zur Auswahl gestellt und bei der ersten Mail gescheitert');
    assert.equal(modelle[0].anzeige, 'Gemini 3.5 Flash');
  });

  test('der Schluessel steht in der Kopfzeile, nicht in der URL', async () => {
    fetchStub();
    await kiModell.verfuegbare();
    assert.equal(gerufen[0].opt.headers['x-goog-api-key'], 'geheimer-schluessel');
    assert.doesNotMatch(gerufen[0].url, /geheimer-schluessel/,
      'eine URL landet in Protokollen — ein Geheimnis hat darin nichts verloren');
  });

  test('zweimal fragen heisst nicht zweimal abrufen', async () => {
    fetchStub();
    await kiModell.verfuegbare();
    await kiModell.verfuegbare();
    assert.equal(gerufen.length, 1);
  });

  test('ohne Schluessel wird gar nicht erst gefragt', async () => {
    settings.setze('gemini_api_key', '');
    fetchStub();
    const { modelle, fehler } = await kiModell.verfuegbare();
    assert.deepEqual(modelle, []);
    assert.match(fehler, /Schl/);
    assert.equal(gerufen.length, 0);
  });

  test('ein abgewiesener Schluessel wird gemeldet, nicht verschwiegen', async () => {
    fetchStub(403, {});
    const { modelle, fehler } = await kiModell.verfuegbare();
    assert.deepEqual(modelle, []);
    assert.match(fehler, /403/);
  });

  test('ist Google nicht erreichbar, faellt nichts um', async () => {
    global.fetch = async () => { throw new Error('offline'); };
    const { modelle, fehler } = await kiModell.verfuegbare();
    assert.deepEqual(modelle, []);
    assert.match(fehler, /offline/);
  });
});

// Der Schutz gehoert an beide Enden: Die Oberflaeche warnt, aber gespeichert
// wird ueber die API — und dort muss es ebenso abgewiesen werden.
describe('Speichern weist dasselbe Modell ab', () => {
  const http = require('http');
  const express = require('express');
  let server;
  let port;

  const put = (rumpf) => new Promise((fertig, schief) => {
    const text = JSON.stringify(rumpf);
    const a = http.request({
      host: '127.0.0.1', port, path: '/api/einstellungen', method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
    });
    a.on('error', schief);
    a.end(text);
  });

  test('gleiches Modell in beiden Feldern: 400 mit Begruendung', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/einstellungen', require('../src/routes/einstellungen'));
    await new Promise((f) => { server = app.listen(0, () => { port = server.address().port; f(); }); });
    try {
      const a = await put({ gemini_modell: 'gemini-3.5-flash', gemini_modell_ersatz: 'gemini-3.5-flash' });
      assert.equal(a.status, 400);
      assert.match(a.json.error, /anderes/);

      const b = await put({ gemini_modell: 'gemini-3.5-flash-lite', gemini_modell_ersatz: 'gemini-3.5-flash' });
      assert.equal(b.status, 200);

      const c = await put({ gemini_modell_ersatz: '' });
      assert.equal(c.status, 200, 'auf "aus" stellen muss immer gehen');
    } finally {
      try { server.close(); } catch { /* egal */ }
    }
  });
});
