// Der tägliche Digest kommt an — auch wenn die KI nicht antwortet.
//
// 17.09., 7:30: „KI zusammenfassen — Gateway timed out (HTTP 504)", 3 Min.
// 8 Sek., keine Nachricht. Workflow 02 hatte ALLE Mails der letzten 24 Stunden
// in einen Prompt gepackt und direkt an Ollama geschickt; seit der
// Bestands-Triage sind das Hunderte. Jetzt baut das Panel den Text, und die KI
// schreibt nur noch einen kurzen Absatz aus einer begrenzten Auswahl.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const kiText = require('../src/services/kiText');
const digest = require('../src/services/digest');
const patcher = require('../src/services/workflowPatcher');
const settings = require('../src/services/settings');

let anfragen;
const kiAntwortet = (antwort) => {
  anfragen = [];
  kiText.frageJson = async (prompt, opt) => { anfragen.push({ prompt, opt }); return antwort; };
};

const log = (kategorie, zielordner, von = 'a@firma.de', betreff = 'Hallo', extra = {}) => db.prepare(
  'INSERT INTO quarantine_log (konto, von, betreff, kategorie, zielordner, spam_score, virus_name, kurzfassung)'
  + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
).run('K', von, betreff, kategorie, zielordner, extra.spam_score ?? null, extra.virus_name ?? null, extra.kurzfassung ?? null);

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_inbox;');
  settings.setze('ki_anbieter', 'ollama');
});

describe('Der Digest-Text', () => {
  test('mit KI: der Absatz „Das Wichtigste" steht oben, Zahlen und Listen darunter', async () => {
    kiAntwortet({ ok: true, daten: { punkte: ['Rechnung von Stadtwerke bis Freitag zahlen'] } });
    log('rechnung', 'Rechnungen', 'Stadtwerke <info@stadtwerke.de>', 'Ihre Rechnung 2026-09');
    log('newsletter', 'Newsletter');
    log('spam', 'Quarantaene', 'x@spam.biz', 'Gewinn!', { spam_score: 0.97 });

    const e = await digest.erstellen();
    assert.equal(e.ki, true);
    assert.match(e.text, /Das Wichtigste:\n• Rechnung von Stadtwerke/);
    assert.match(e.text, /3 Mails in den letzten 24 Stunden: 1 sonstige, 1 Newsletter, 1 Spam\/Quarantäne/);
    assert.match(e.text, /Stadtwerke — Ihre Rechnung 2026-09/, 'Absender mit Namen statt Adresse');
    assert.match(e.text, /x@spam\.biz — Gewinn! \(Score 0\.97\)/);
    assert.ok(e.text.indexOf('Das Wichtigste') < e.text.indexOf('Quarantäne / Spam ('));
  });

  test('ohne KI (504 vom Proxy): der Digest kommt trotzdem — mit Hinweis', async () => {
    kiAntwortet({ ok: false, gatewayTimeout: true, fehler: 'Ollama antwortete mit 504' });
    log('persoenlich', null, 'oma@familie.de', 'Sonntag');

    const e = await digest.erstellen();
    assert.equal(e.ki, false);
    assert.ok(!e.text.includes('Das Wichtigste'));
    assert.match(e.text, /Mail-Digest/);
    assert.match(e.text, /oma@familie\.de — Sonntag/);
    assert.match(e.text, /Ohne KI-Zusammenfassung: Ollama antwortete mit 504/);
  });

  test('bei Hunderten Mails: die KI sieht höchstens 25, der Text passt in eine Telegram-Nachricht', async () => {
    kiAntwortet({ ok: true, daten: { punkte: ['x'.repeat(500)] } });
    for (let i = 0; i < 800; i += 1) {
      log(i % 2 ? 'rechnung' : 'newsletter', i % 2 ? 'Rechnungen' : `Ordner ${i % 30}`,
        `absender${i}@firma${i}.de`, `Betreff Nummer ${i} ${'lang '.repeat(20)}`);
    }

    const e = await digest.erstellen();
    assert.equal(anfragen.length, 1);
    const bloecke = anfragen[0].prompt.match(/^\[\d+\]$/gm) || [];
    assert.equal(bloecke.length, 25);
    assert.ok(anfragen[0].opt.zeitlimit <= 90000, 'unter der Zeitgrenze des n8n-Knotens');
    assert.ok(e.text.length <= digest.MAX_ZEICHEN, `${e.text.length} Zeichen`);
    assert.match(e.text, /… und \d+ weitere/);
    assert.match(e.text, /800 Mails/);
  });

  test('ohne wichtige Mails wird die KI gar nicht gefragt', async () => {
    kiAntwortet({ ok: true, daten: { punkte: ['sollte nicht erscheinen'] } });
    log('newsletter', 'Newsletter');
    const e = await digest.erstellen();
    assert.equal(anfragen.length, 0);
    assert.ok(!e.text.includes('sollte nicht erscheinen'));
  });

  test('der deutsche Quarantäne-Ordner zählt als Quarantäne, nicht als „sonstig"', () => {
    log('sonstiges', 'Quarantaene', 'b@c.de', 'Verdächtig');
    const d = digest.daten();
    assert.equal(d.quarantaene.length, 1);
    assert.equal(d.sonstiges.length, 0);
  });

  test('wartende Arbeit im Panel wird genannt', async () => {
    kiAntwortet({ ok: false, fehler: 'egal' });
    db.prepare("INSERT INTO sort_inbox (konto, von, uid, status) VALUES ('K', 'a@b.de', '1', 'offen')").run();
    const e = await digest.erstellen();
    assert.match(e.text, /Wartet im Panel:\n• 1 Mails in der Sortier-Inbox/);
  });
});

describe('Workflow 02: der Knoten holt den fertigen Text vom Panel', () => {
  const workflow = () => ({
    nodes: [
      { id: 'code-collect', name: 'Digest zusammenstellen', type: 'n8n-nodes-base.code', position: [440, 100], parameters: {} },
      {
        id: 'http-gemini-digest', name: 'Ollama zusammenfassen', type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2, position: [660, 100], retryOnFail: true, maxTries: 3,
        parameters: { method: 'POST', url: 'http://ollama:11434/api/generate', jsonBody: '={{ 1 }}' },
      },
      { id: 'code-digest-parse', name: 'Text extrahieren', type: 'n8n-nodes-base.code', position: [880, 100], parameters: {} },
    ],
    connections: {
      'Digest zusammenstellen': { main: [[{ node: 'Ollama zusammenfassen', type: 'main', index: 0 }]] },
      'Ollama zusammenfassen': { main: [[{ node: 'Text extrahieren', type: 'main', index: 0 }]] },
    },
  });

  test('aus dem Ollama-Aufruf wird ein Panel-Aufruf — id, Name und Kanten bleiben', () => {
    const wf = workflow();
    assert.equal(patcher.digestKnotenUmbauen(wf), true);
    const k = wf.nodes.find((n) => n.id === 'http-gemini-digest');
    assert.equal(k.name, 'Ollama zusammenfassen');
    assert.equal(k.parameters.url, patcher.DIGEST_URL);
    assert.equal(k.parameters.jsonBody, undefined);
    assert.equal(k.retryOnFail, undefined, 'das Panel liefert auch ohne KI einen Text');
    assert.equal(wf.connections['Ollama zusammenfassen'].main[0][0].node, 'Text extrahieren');
    assert.equal(patcher.digestKnotenUmbauen(wf), false, 'ein zweiter Abgleich ändert nichts');
  });

  test('die übrigen Abgleich-Schritte machen daraus nicht wieder einen KI-Knoten', () => {
    const wf = workflow();
    patcher.digestKnotenUmbauen(wf);
    patcher.panelKnotenVerdrahten(wf, 'cred-7');
    patcher.kiRequestReparieren(wf);
    patcher.kiKnotenNeutralBenennen(wf);
    patcher.panelZeitlimitSetzen(wf);

    const k = wf.nodes.find((n) => n.id === 'http-gemini-digest');
    assert.equal(k.name, patcher.KI_ZUSAMMENFASSER_NAME);
    assert.equal(k.parameters.url, patcher.DIGEST_URL, 'nicht zurück auf Ollama');
    assert.equal(k.parameters.jsonBody, undefined, 'kein format:json, keine 600 Token');
    assert.equal(k.credentials.httpHeaderAuth.id, 'cred-7');
    assert.equal(k.parameters.options.timeout, 120000, 'mehr als die 90 s, die das Panel der KI gibt');
    assert.equal(wf.connections[patcher.KI_ZUSAMMENFASSER_NAME].main[0][0].node, 'Text extrahieren');
  });
});
