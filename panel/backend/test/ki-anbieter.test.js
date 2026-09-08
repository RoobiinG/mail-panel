// Läuft das Panel wirklich auf der lokalen KI, wenn man sie einstellt?
//
// Der Anlass ist eine Beobachtung aus dem Betrieb: „Ollama" war gewählt, die
// Workflows waren synchronisiert — und sortiert wurde trotzdem nichts. Die
// Ursachen lagen verteilt, jede für sich unscheinbar. Hier steht jede einzeln.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./umgebung');

const settings = require('../src/services/settings');
const budget = require('../src/services/budget');
const patcher = require('../src/services/workflowPatcher');

const anbieterSetzen = (wert) => settings.setze('ki_anbieter', wert);

beforeEach(() => {
  anbieterSetzen('gemini');
  settings.setze('gemini_tagesbudget', '400');
  settings.setze('ki_429_tag', '');
});

describe('Die lokale KI hat kein Tageskontingent', () => {
  // Der Fund, der alles erklärt: kiPlatzFrei() in routes/internal.js fragt das
  // Budget, bevor eine neue Mail zur KI darf. Mit Ollama zählte dort weiter
  // Googles Gratisstufe — wer den Zähler aus der Gemini-Zeit mitschleppte oder
  // eine offene 429-Sperre hatte, bekam bei JEDER Mail „kein Kontingent".
  test('mit Ollama gibt es keinen Deckel', () => {
    anbieterSetzen('ollama');
    assert.equal(budget.tagesbudget(), 0, '0 heisst: kein Deckel');
  });

  test('mit Gemini gilt der eingestellte Deckel weiter', () => {
    anbieterSetzen('gemini');
    assert.equal(budget.tagesbudget(), 400);
  });

  // Eine Absage von Google sperrt den Rest des Tages. Fuer einen Server, der im
  // Keller steht, ist das eine fremde Auskunft.
  test('eine alte Google-Absage sperrt die lokale KI nicht', () => {
    const { kiTag } = require('../src/services/kiTag');
    settings.setze('ki_429_tag', kiTag());
    settings.setze('ki_429_art', 'tag');
    settings.setze('ki_429_modell', '');
    settings.setze('ki_429_limit', '50');

    // Gegenprobe zuerst: Mit Gemini greift die Absage — sonst wuerde der Test
    // unten auch bestehen, wenn er gar nichts prueft.
    anbieterSetzen('gemini');
    assert.equal(budget.beobachteteGrenze(), 50);
    assert.equal(budget.tagesbudget(), 50, 'Googles Zahl schlaegt den eingestellten Deckel');

    anbieterSetzen('ollama');
    assert.equal(budget.beobachteteGrenze(), 0);
    assert.equal(budget.tagesbudget(), 0);
  });
});

describe('Der KI-Knoten heisst nicht ueberall gleich', () => {
  // In der Ollama-Vorlage heisst er "Ollama klassifizieren". Der Patcher suchte
  // nach "Gemini klassifizieren" — und fand ihn nie. Folge: Die Bestands-Triage
  // bekam ihre Buendelung nicht und fragte weiter Mail fuer Mail einzeln.
  const wf = (name) => ({
    nodes: [{
      parameters: { url: 'http://ollama:11434/api/generate', jsonBody: '={{ 1 }}' },
      id: 'x1', name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
    }],
    connections: {},
  });

  test('der Buendel-Knoten wird auch bei Ollama eingebaut', () => {
    const w = wf('Ollama klassifizieren');
    assert.equal(patcher.geminiBuendelEinbauen(w), true);
    assert.equal(w.nodes[0].type, 'n8n-nodes-base.code');
    assert.ok(w.nodes[0].parameters.jsCode.includes(patcher.BUENDEL_MARKE));
  });

  test('und bei Gemini genauso', () => {
    const w = wf('Gemini klassifizieren');
    assert.equal(patcher.geminiBuendelEinbauen(w), true);
    assert.equal(w.nodes[0].type, 'n8n-nodes-base.code');
  });

  test('ein beliebiger anderer Knoten bleibt unangetastet', () => {
    const w = wf('Anhänge scannen');
    assert.equal(patcher.geminiBuendelEinbauen(w), false);
    assert.equal(w.nodes[0].type, 'n8n-nodes-base.httpRequest');
  });
});

describe('Die Antwort kommt je nach Anbieter woanders her', () => {
  // Gemini: candidates[0].content.parts[0].text — Ollama: response.
  //
  // Die Vorlagen lesen laengst beides, aber basisSetup legt Workflows nur an,
  // wenn sie fehlen, und ruehrt vorhandene nie wieder an. Wer frueher importiert
  // und spaeter umgestellt hat, hatte einen Knoten stehen, der nur nach
  // candidates schaut. Im Telegram stand dann "KI-Antwort war leer" — genau so
  // gemeldet am 8. September.
  const codeWf = (js) => ({
    nodes: [{ parameters: { jsCode: js }, name: 'Digest bauen', type: 'n8n-nodes-base.code' }],
    connections: {},
  });

  test('ein alter Gemini-Parser wird zweigleisig gemacht', () => {
    const w = codeWf("let t = ''; try { t = $json.candidates[0].content.parts[0].text; } catch (e) {}");
    assert.equal(patcher.kiAntwortLesenAngleichen(w), true);
    assert.ok(w.nodes[0].parameters.jsCode.includes('$json.response ||'));
    assert.ok(w.nodes[0].parameters.jsCode.includes('candidates[0].content.parts[0].text'),
      'der Gemini-Weg muss erhalten bleiben');
  });

  test('ein bereits zweigleisiger Knoten wird nicht angefasst', () => {
    const js = "let t = ''; try { t = $json.response || $json.candidates[0].content.parts[0].text; } catch (e) {}";
    const w = codeWf(js);
    assert.equal(patcher.kiAntwortLesenAngleichen(w), false);
    assert.equal(w.nodes[0].parameters.jsCode, js);
  });

  test('Knoten ohne KI-Antwort bleiben unberuehrt', () => {
    const w = codeWf('return $input.all();');
    assert.equal(patcher.kiAntwortLesenAngleichen(w), false);
  });
});

// Die Vorlagen sind Teil des Auslieferungsumfangs. Zwei von ihnen trugen ein
// BOM und waren durchgehend doppelt UTF-8-kodiert: JSON.parse warf, der Import
// brach ab -- und weil 01 alphabetisch zuerst kommt, wurde danach GAR NICHTS
// mehr importiert. Wer Ollama gewaehlt hatte, stand ohne einen einzigen
// Workflow da.
describe('Die mitgelieferten Workflow-Vorlagen', () => {
  const ordner = path.resolve(__dirname, '../../../workflows');
  const dateien = fs.existsSync(ordner)
    ? fs.readdirSync(ordner).filter((d) => d.endsWith('.json'))
    : [];

  test('es gibt sie ueberhaupt', () => {
    assert.ok(dateien.length >= 7, `nur ${dateien.length} Vorlagen gefunden`);
  });

  for (const datei of dateien) {
    test(`${datei}: lesbar, ohne BOM, ohne doppelte Kodierung`, () => {
      const roh = fs.readFileSync(path.join(ordner, datei));
      assert.ok(!(roh[0] === 0xEF && roh[1] === 0xBB && roh[2] === 0xBF),
        'BOM am Anfang — daran scheitert JSON.parse');
      // "Ã" als Byte-Folge C3 83 ist das sichere Zeichen fuer doppelt kodiertes
      // UTF-8. Damit heisst der Knoten "PrÃ¼fung auswerten" statt "Prüfung
      // auswerten" — und der Patcher findet ihn nicht mehr.
      assert.ok(!roh.includes(Buffer.from([0xC3, 0x83])),
        'doppelt kodiertes UTF-8 — Umlaute in Knotennamen sind kaputt');
      const wf = JSON.parse(roh.toString('utf8'));
      assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0, 'keine Knoten');
      assert.ok(wf.name, 'kein Name');
    });
  }

  // Gleiche Aufgabe, gleicher Name: Sonst legt basisSetup beim Anbieterwechsel
  // einen zweiten Workflow daneben, und der Digest kaeme doppelt.
  test('Gemini- und Ollama-Fassung tragen denselben Namen', () => {
    const paare = dateien
      .filter((d) => d.includes('-gemini.json'))
      .map((d) => [d, d.replace('-gemini.json', '-ollama.json')])
      .filter(([, o]) => dateien.includes(o));
    assert.ok(paare.length >= 3, 'es sollte drei Paare geben');
    for (const [g, o] of paare) {
      const nameVon = (d) => JSON.parse(fs.readFileSync(path.join(ordner, d), 'utf8')).name;
      assert.equal(nameVon(o), nameVon(g), `${o} heisst anders als ${g}`);
    }
  });
});
