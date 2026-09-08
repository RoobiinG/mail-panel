// Die Frist eines Laufs — und die Kette, an der sie hängt.
//
// Der Fehler, um den es hier geht, ist einer der stilleren: `frist()` las
// `gemini_lauf_frist_ms`, und dieser Schlüssel stand weder in settings.FELDER
// noch in den EINFACHE_KEYS der Route. `PUT /api/einstellungen` warf ihn
// wortlos weg. Die Einstellung existierte im Code, ließ sich aber von außen
// **gar nicht setzen** — nur durch einen Schreibzugriff direkt in die
// Datenbank. Für eine lokale KI, bei der ein Bündel Minuten braucht, war das
// der wichtigste Hebel überhaupt.
//
// Und selbst gesetzt wäre er wirkungslos geblieben: Der Bündel-Knoten in
// Workflow 04 trug ein fest verdrahtetes `timeout: 280000`. Wer die Frist
// hochsetzte, lief in dieses Zeitlimit statt in seine eigene.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const klass = require('../src/services/klassifizierer');
const patcher = require('../src/services/workflowPatcher');

const setzeRoh = (key, wert) => db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(key, String(wert));

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key IN ('ki_lauf_frist_ms','gemini_lauf_frist_ms','ollama_buendel','gemini_buendel','ki_anbieter')").run();
});

describe('Die Frist ist von außen erreichbar', () => {
  test('ohne Angabe gilt der Standard', () => {
    assert.equal(klass.frist(), klass.FRIST_STANDARD);
  });

  test('der neue Schlüssel wirkt', () => {
    setzeRoh('ki_lauf_frist_ms', 900000);
    assert.equal(klass.frist(), 900000);
  });

  // Wer den Wert früher von Hand in die Datenbank geschrieben hat, soll ihn
  // nicht stumm verlieren.
  test('der alte Schlüssel bleibt als Rückfall gültig', () => {
    setzeRoh('gemini_lauf_frist_ms', 600000);
    assert.equal(klass.frist(), 600000);
  });

  test('der neue schlägt den alten', () => {
    setzeRoh('gemini_lauf_frist_ms', 600000);
    setzeRoh('ki_lauf_frist_ms', 900000);
    assert.equal(klass.frist(), 900000);
  });

  test('Unsinn wird eingefangen', () => {
    setzeRoh('ki_lauf_frist_ms', 5);
    assert.equal(klass.frist(), 30000);
    setzeRoh('ki_lauf_frist_ms', 99999999);
    assert.equal(klass.frist(), 3600000);
    setzeRoh('ki_lauf_frist_ms', 'lange');
    assert.equal(klass.frist(), klass.FRIST_STANDARD, 'kein NaN in die Frist');
  });
});

describe('Das Zeitlimit im Bündel-Knoten wächst mit', () => {
  const kiWorkflow = () => ({
    nodes: [{
      parameters: { url: 'http://ollama:11434/api/generate' },
      id: 'http-gemini',
      name: 'Gemini klassifizieren',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [0, 0],
    }],
    connections: {},
  });

  const zeitlimitAus = (wf) => Number(
    (wf.nodes[0].parameters.jsCode.match(/timeout:\s*(\d+)/) || [])[1],
  );

  test('bei der Standardfrist liegt es darüber, nicht darunter', () => {
    const wf = kiWorkflow();
    patcher.geminiBuendelEinbauen(wf);
    const t = zeitlimitAus(wf);
    assert.ok(t > klass.FRIST_STANDARD,
      `${t} muss ueber der Frist ${klass.FRIST_STANDARD} liegen — sonst schneidet der Knoten ab, `
      + 'bevor das Panel von sich aus zurueckgibt, was fertig ist');
  });

  test('eine größere Frist hebt auch das Zeitlimit', () => {
    setzeRoh('ki_lauf_frist_ms', 900000);
    const wf = kiWorkflow();
    patcher.geminiBuendelEinbauen(wf);
    assert.ok(zeitlimitAus(wf) > 900000, 'sonst war die Frist umsonst hochgesetzt');
  });

  // Bestandsinstallationen tragen noch die feste 280000. Der Abgleich
  // vergleicht den erzeugten Code mit dem vorhandenen — eine neue Marke ist
  // dafuer nicht noetig, aber das muss auch stimmen.
  test('ein Knoten mit dem alten festen Wert wird neu geschrieben', () => {
    setzeRoh('ki_lauf_frist_ms', 900000);
    const wf = kiWorkflow();
    patcher.geminiBuendelEinbauen(wf);
    wf.nodes[0].parameters.jsCode = wf.nodes[0].parameters.jsCode
      .replace(/timeout:\s*\d+/, 'timeout: 280000');
    assert.equal(patcher.geminiBuendelEinbauen(wf), true, 'der Abgleich muss das bemerken');
    assert.notEqual(zeitlimitAus(wf), 280000);
  });

  test('zweimal derselbe Abgleich ändert nichts mehr', () => {
    const wf = kiWorkflow();
    patcher.geminiBuendelEinbauen(wf);
    assert.equal(patcher.geminiBuendelEinbauen(wf), false);
  });
});

describe('Die Bündelgröße für die lokale KI ist einstellbar', () => {
  // Fuenf war geraten und zu viel: Die Zeit zum Einlesen des Prompts waechst
  // mit seiner Laenge, und zwei Mails, die zurueckkommen, sind mehr wert als
  // fuenf, die ins Zeitlimit laufen — dort ist das Ergebnis null.
  test('bei Ollama deckelt sie den eingestellten Wert', () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('gemini_buendel', '20');
    assert.equal(klass.buendelGroesse(), klass.OLLAMA_BUENDEL_STANDARD);
  });

  test('ein eigener Wert wird genommen', () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('gemini_buendel', '20');
    settings.setze('ollama_buendel', '4');
    assert.equal(klass.buendelGroesse(), 4);
  });

  // Deckel heisst Deckel: Wer 20 einstellt und lokal 4 erlaubt, bekommt 4 —
  // wer 2 einstellt und lokal 4 erlaubt, bekommt 2.
  test('der kleinere von beiden gewinnt', () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('gemini_buendel', '2');
    settings.setze('ollama_buendel', '8');
    assert.equal(klass.buendelGroesse(), 2);
  });

  test('bei Gemini bleibt der eingestellte Wert unberührt', () => {
    settings.setze('ki_anbieter', 'gemini');
    settings.setze('gemini_buendel', '20');
    settings.setze('ollama_buendel', '2');
    assert.equal(klass.buendelGroesse(), 20);
  });
});

// Der eigentliche Fehler von heute: Der Wert liess sich nie setzen.
describe('Speichern nimmt die neuen Schlüssel an', () => {
  const http = require('http');
  const express = require('express');

  const mitServer = async (arbeit) => {
    const app = express();
    app.use(express.json());
    app.use('/api/einstellungen', require('../src/routes/einstellungen'));
    const server = await new Promise((f) => {
      const s = app.listen(0, () => f(s));
    });
    const port = server.address().port;
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
    try { await arbeit(put); } finally { server.close(); }
  };

  test('ki_lauf_frist_ms kommt an — vorher fiel es wortlos unter den Tisch', async () => {
    await mitServer(async (put) => {
      const a = await put({ ki_lauf_frist_ms: '900000' });
      assert.equal(a.status, 200);
      assert.ok(a.json.geaendert.includes('ki_lauf_frist_ms'),
        'genau hier war der Fehler: die Route kannte den Schluessel nicht');
      assert.equal(klass.frist(), 900000, 'und er muss auch wirken');
    });
  });

  test('ein unsinniger Wert wird abgewiesen, nicht gespeichert', async () => {
    await mitServer(async (put) => {
      const a = await put({ ki_lauf_frist_ms: '10' });
      assert.equal(a.status, 400);
      assert.match(a.json.error, /30000/);
      const b = await put({ ki_lauf_frist_ms: '' });
      assert.equal(b.status, 200, 'leer heisst Standard und muss erlaubt bleiben');
    });
  });

  test('ollama_buendel kommt an und wird geprüft', async () => {
    await mitServer(async (put) => {
      assert.equal((await put({ ollama_buendel: '3' })).status, 200);
      settings.setze('ki_anbieter', 'ollama');
      settings.setze('gemini_buendel', '20');
      assert.equal(klass.buendelGroesse(), 3);

      const zuViel = await put({ ollama_buendel: '99' });
      assert.equal(zuViel.status, 400);
      assert.match(zuViel.json.error, /zwischen 1 und 10/);
    });
  });
});
