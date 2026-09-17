// Woraus besteht der Stapel in der Sortier-Inbox?
//
// Diagnosebericht vom 17.09.: 1.750 offene Zuordnungen, häufigster Grund „Kein
// Thema erkannt". Welche Kategorie die KI diesen Mails gegeben hatte, ging
// dabei verloren — /einsortieren schrieb sie nicht mit. Ohne sie ließ sich der
// Stapel nicht aufschlüsseln und nicht filtern.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-aufschluesselung';
const express = require('express');
const db = require('../src/db');

let server;
let port;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', require('../src/routes/internal'));
  await new Promise((fertig) => {
    server = app.listen(0, () => { port = server.address().port; fertig(); });
  });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function post(pfad, rumpf) {
  return new Promise((fertig, schief) => {
    const text = JSON.stringify(rumpf);
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
    });
    a.on('error', schief);
    a.end(text);
  });
}

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM accounts;'
    + ' DELETE FROM sort_inbox; DELETE FROM bestand_erledigt;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
  // Ohne Themen-Sortierung endet themen.aufloesen() sofort — kein IMAP.
  db.prepare("DELETE FROM settings WHERE key LIKE 'themen_%'").run();
});

const zeile = (uid) => db.prepare('SELECT * FROM sort_inbox WHERE uid = ?').get(String(uid));

describe('Die Kategorie landet in der Sortier-Inbox', () => {
  test('neuer Eintrag bekommt die Kategorie der KI', async () => {
    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'oma@familie.de', betreff: 'Hallo', uid: 21, kategorie: 'persoenlich',
    });
    assert.equal(zeile(21)?.kategorie, 'persoenlich');
  });

  test('ein späterer Lauf ohne Kategorie löscht sie nicht, einer mit Kategorie aktualisiert sie', async () => {
    const rumpf = { konto: 'K', von: 'x@y.de', betreff: 'Frage', uid: 22 };
    await post('/api/internal/einsortieren', { ...rumpf, kategorie: 'sonstiges' });
    await post('/api/internal/einsortieren', rumpf);
    assert.equal(zeile(22).kategorie, 'sonstiges');
    await post('/api/internal/einsortieren', { ...rumpf, kategorie: 'persoenlich' });
    assert.equal(zeile(22).kategorie, 'persoenlich');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_inbox').get().n, 1, 'kein zweiter Eintrag');
  });
});

describe('Aufschlüsselung und Filter (Frontend-Hilfen)', () => {
  let h;
  before(async () => {
    const datei = path.join(__dirname, '../../frontend/src/components/ui/sortierHilfen.js');
    h = await import(pathToFileURL(datei).href);
  });

  test('die Gründe aus themen.aufloesen() fallen in die richtige Klasse', () => {
    assert.equal(h.grundKlasse('Kein Thema erkannt'), 'kein-thema');
    assert.equal(h.grundKlasse('Neuer Ordner "Reisen" wartet auf Freigabe'), 'neuer-ordner');
    assert.equal(h.grundKlasse('Trockenlauf — Ordner "Reisen" wäre angelegt worden'), 'neuer-ordner');
    assert.equal(h.grundKlasse('Ordnername abgelehnt: ???'), 'abgelehnt');
    assert.equal(h.grundKlasse('Ordner "Reisen" wurde abgelehnt — die Mail bleibt liegen'), 'abgelehnt');
    assert.equal(h.grundKlasse('Für einen neuen Ordner zu unsicher (0.41 < 0.6)'), 'unsicher');
    assert.equal(h.grundKlasse('Obergrenze von 35 KI-Ordnern erreicht'), 'andere');
    assert.equal(h.grundKlasse(null), 'ohne');
  });

  test('der Filter übersteht den Weg durch die Adresse, Unsinn fällt heraus', () => {
    const f = { kategorie: 'persoenlich', grund: 'kein-thema' };
    assert.deepEqual(h.filterLesen(h.filterText(f)), f);
    assert.deepEqual(h.filterLesen('k:gibtsnicht,g:<script>'), { kategorie: null, grund: null });
    assert.equal(h.filterText({}), '');
  });

  test('ohne Filter ergeben die Kategorie-Zahlen zusammen die Gesamtzahl', () => {
    const mails = [
      { kategorie: 'persoenlich', ki_grund: 'Kein Thema erkannt' },
      { kategorie: 'persoenlich', ki_grund: 'Kein Thema erkannt' },
      { kategorie: 'sonstiges', ki_grund: 'Für einen neuen Ordner zu unsicher (0.3 < 0.6)' },
      { kategorie: null, ki_grund: null },
    ];
    const { kategorien, gruende } = h.aufschluesseln(mails, { kategorie: null, grund: null });
    assert.equal(Object.values(kategorien).reduce((a, b) => a + b, 0), mails.length);
    assert.equal(Object.values(gruende).reduce((a, b) => a + b, 0), mails.length);
    assert.equal(kategorien.unbekannt, 1, 'alte Einträge ohne Kategorie fallen nicht aus der Summe');

    // Mit Grund-Filter zählen die Kategorien nur noch diese Mails.
    const gefiltert = h.aufschluesseln(mails, { kategorie: null, grund: 'kein-thema' });
    assert.deepEqual(gefiltert.kategorien, { persoenlich: 2 });
    assert.equal(mails.filter((m) => h.passtZumFilter(m, { kategorie: 'persoenlich', grund: null })).length, 2);
  });
});
