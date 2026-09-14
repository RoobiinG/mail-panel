// Der Abbrechen-Knopf, der nie etwas abbrechen konnte.
//
// Im Panel stand „läuft seit 5 Std. 57 Min." neben einem Bestandslauf, der
// längst vorbei war — und der Knopf daneben antwortete nur „Abbrechen
// fehlgeschlagen." Drei Dinge kamen dafür zusammen:
//
//   1. Die Route DELETE /workflows/stop/:id gab es nicht. Das Frontend rief sie
//      seit jeher auf, Express antwortete 404. `n8n.executionLoeschen()` war
//      ebenso lange da und wurde von niemandem aufgerufen.
//   2. Die Anzeige stützt sich auf einen Startzeitpunkt, den das Panel sich
//      selbst merkt (n8ns öffentliche API meldet keine laufenden Ausführungen).
//      Ein Ende merkt es sich nicht — und die Grenze stand bei sechs Stunden.
//   3. Der so angezeigte Lauf trägt die Kennung „aktiv". Die kennt n8n nicht;
//      danach zu fragen wäre sinnlos.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const settings = require('../src/services/settings');
const n8n = require('../src/services/n8n');
const diagnose = require('../src/services/diagnose');

const express = require('express');

// listen() ist asynchron — der Port steht erst im Callback fest.
const request = async (app, methode, pfad) => {
  const server = await new Promise((fertig) => {
    const s = app.listen(0, () => fertig(s));
  });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${pfad}`, { method: methode });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally {
    await new Promise((fertig) => server.close(fertig));
  }
};

// Die Route ohne Anmeldung einhängen — geprüft wird sie, nicht die Rechte.
function app() {
  const a = express();
  a.use('/api/workflows', require('../src/routes/workflows'));
  return a;
}

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = 'bestand_letzter_start'").run();
});

describe('Die Route gibt es überhaupt', () => {
  test('DELETE /workflows/stop/:id antwortet, statt ins Leere zu laufen', async () => {
    settings.setze('bestand_letzter_start', new Date().toISOString());
    const r = await request(app(), 'DELETE', '/api/workflows/stop/aktiv');
    assert.notEqual(r.status, 404, 'genau das war der Fehler: die Route fehlte');
    assert.equal(r.status, 200);
  });
});

describe('Ein Lauf, von dem nur das Panel weiß', () => {
  // "aktiv" ist der Platzhalter aus dem Fallback, keine n8n-Kennung.
  test('wird abgemeldet, ohne n8n zu fragen', async () => {
    settings.setze('bestand_letzter_start', new Date().toISOString());

    let gefragt = false;
    const alt = n8n.executionLoeschen;
    n8n.executionLoeschen = async () => { gefragt = true; };
    try {
      const r = await request(app(), 'DELETE', '/api/workflows/stop/aktiv');
      assert.equal(r.json.ok, true);
      assert.equal(gefragt, false, 'n8n kennt diesen Lauf nicht');
    } finally {
      n8n.executionLoeschen = alt;
    }

    assert.equal(settings.hole('bestand_letzter_start'), '',
      'ohne das Vergessen stünde weiter „läuft" im Panel');
  });
});

describe('Ein echter Lauf geht an n8n', () => {
  test('die Kennung wird durchgereicht und der Merker geleert', async () => {
    settings.setze('bestand_letzter_start', new Date().toISOString());

    let bekommen = null;
    const alt = n8n.executionLoeschen;
    n8n.executionLoeschen = async (id) => { bekommen = id; };
    try {
      const r = await request(app(), 'DELETE', '/api/workflows/stop/12345');
      assert.equal(r.status, 200);
      assert.equal(bekommen, '12345');
    } finally {
      n8n.executionLoeschen = alt;
    }
    assert.equal(settings.hole('bestand_letzter_start'), '');
  });

  test('scheitert n8n, sagt das Panel warum', async () => {
    const alt = n8n.executionLoeschen;
    n8n.executionLoeschen = async () => { throw new Error('Execution nicht gefunden'); };
    try {
      const r = await request(app(), 'DELETE', '/api/workflows/stop/999');
      assert.equal(r.status, 400);
      assert.match(r.json.error, /nicht gefunden/);
    } finally {
      n8n.executionLoeschen = alt;
    }
  });
});

describe('Die Dauer eines Laufs', () => {
  // Ein abgebrochener Lauf kommt ohne startedAt zurück. `new Date(null)` ist
  // nicht ungültig, sondern der 1. Januar 1970 — im Bericht stand deshalb eine
  // Dauer von 1788920178 Sekunden, also siebenundfünfzig Jahren.
  //
  // laeufe() ist nicht exportiert und bräuchte ein erreichbares n8n. Geprüft
  // wird deshalb, dass die alte Rechnung nicht mehr im Quelltext steht und die
  // neue beide Zeiten verlangt.
  const quelle = require('fs').readFileSync(
    require('path').resolve(__dirname, '../src/services/diagnose.js'), 'utf8',
  );

  test('die alte Rechnung ist weg', () => {
    assert.ok(!/new Date\(e\.stoppedAt\) - new Date\(e\.startedAt\)/.test(quelle),
      'genau diese Zeile ergab bei fehlender Startzeit 57 Jahre');
  });

  test('beide Zeiten müssen gültig sein', () => {
    assert.match(quelle, /Number\.isFinite\(a\) && Number\.isFinite\(b\)/,
      'sonst rechnet die Diagnose wieder gegen 1970');
  });

  test('adressenTilgen und urlOhneZugang bleiben erreichbar', () => {
    assert.equal(typeof diagnose.adressenTilgen, 'function');
    assert.equal(typeof diagnose.urlOhneZugang, 'function');
  });
});
