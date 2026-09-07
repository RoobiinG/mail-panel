// Warum ist diese Mail dort gelandet?
//
// Das Panel rechnet die Antwort für jede Mail aus — sie ging bisher nur an n8n
// zurück und in die Sortier-Inbox. Im Protokoll fehlte sie, und damit war die
// erste Frage bei jeder Fehleinordnung nicht mehr zu beantworten, sobald die
// Mail einmal verschoben war.
//
// Zwei Fälle sind heikel, beide stehen hier: Eine Mail, die schon in /sort von
// einer eigenen Regel abgebogen ist, hat die KI nie gesehen — die Themen-Suche
// lief ins Leere und meldet etwas, das mit der Entscheidung nichts zu tun hat.
// Und „Spam, Blacklist oder Virus" sagt nicht, welches davon es war; genau das
// ist aber die Frage, wenn eine harmlose Mail in der Quarantäne liegt.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-grund';
const express = require('express');
const db = require('../src/db');
const entscheidungen = require('../src/services/entscheidungen');

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

const grundVon = (von) => db.prepare('SELECT grund FROM quarantine_log WHERE von = ?').get(von)?.grund;

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM accounts;'
    + ' DELETE FROM sort_inbox; DELETE FROM bestand_erledigt;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
  // Ohne Themen-Sortierung endet themen.aufloesen() sofort — sonst ginge der
  // Test an einen echten IMAP-Server.
  db.prepare("DELETE FROM settings WHERE key LIKE 'themen_%'").run();
});

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name='K'").get().id;

describe('Der Grund steht im Protokoll', () => {
  test('Regel-Mail: die Regel wird genannt, nicht das Ergebnis der Themen-Suche', async () => {
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(kontoId(), 'domain', 'shop.de', 'Bestellungen', 'verschieben');

    const s = await post('/api/internal/sort', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 11 });
    assert.equal(s.json.aktion, 'verschieben');
    await post('/api/internal/einsortieren', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 11 });

    const grund = grundVon('a@shop.de');
    assert.match(grund, /Eigene Regel/, `stattdessen stand da: ${grund}`);
    assert.match(grund, /shop\.de/);
    assert.match(grund, /Bestellungen/);
  });

  test('KI-Mail: der Grund der Themen-Aufloesung bleibt stehen', async () => {
    await post('/api/internal/sort', { konto: 'K', von: 'b@fremd.de', betreff: 'y', uid: 12 });
    await post('/api/internal/einsortieren', { konto: 'K', von: 'b@fremd.de', betreff: 'y', uid: 12 });

    const grund = grundVon('b@fremd.de');
    assert.ok(grund, 'ohne Grund ist die Zeile stumm');
    assert.doesNotMatch(grund, /Eigene Regel/,
      'hier hat keine Regel entschieden — das zu behaupten zeigt bei der Fehlersuche in die falsche Richtung');
  });

  // "Spam, Blacklist oder Virus" war die alte Antwort auf alle drei Faelle.
  test('ein Virusfund wird beim Namen genannt', async () => {
    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'c@boese.example', betreff: 'z', uid: 13,
      ziel_fest: true, virus_name: 'Eicar-Test-Signature',
    });
    assert.match(grundVon('c@boese.example'), /Virus gefunden: Eicar-Test-Signature/);
  });

  test('bei Spam steht der Wert dabei', async () => {
    await post('/api/internal/einsortieren', {
      konto: 'K', von: 'd@werbung.example', betreff: 'z', uid: 14,
      ziel_fest: true, spam_score: 0.91,
    });
    assert.match(grundVon('d@werbung.example'), /Spam-Wert 0\.91/);
  });

  // Der Grund ist nur die halbe Miete, wenn man ihn nicht wiederfinden kann.
  test('nach dem Grund laesst sich suchen', async () => {
    db.prepare('INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion) VALUES (?, ?, ?, ?, ?)')
      .run(kontoId(), 'domain', 'shop.de', 'Bestellungen', 'verschieben');
    await post('/api/internal/sort', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 15 });
    await post('/api/internal/einsortieren', { konto: 'K', von: 'a@shop.de', betreff: 'x', uid: 15 });

    const treffer = entscheidungen.suchen({ konto: 'K', suche: 'Eigene Regel' });
    assert.equal(treffer.gesamt, 1);
    assert.equal(treffer.eintraege[0].von, 'a@shop.de');
  });
});
