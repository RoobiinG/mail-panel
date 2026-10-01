// Wer darf die Anhang-Endpunkte rufen? Entweder n8n (X-Panel-Secret) oder ein
// angemeldeter ADMIN — sonst niemand.
//
// Bis Build 252 galt für alles unter /api/internal allein das Panel-Secret. Das ist
// für n8n richtig, ließ aber keinen Weg zu, dass sich ein Admin ausweist — und es
// gab keine Prüfung, ob das Geheimnis fehlt oder falsch ist, BEVOR ein Rumpf von
// 40 MB geparst wurde.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
require('./umgebung');

process.env.PANEL_SECRET = 'geheimnis-fuer-tests-0123456789abcdef';
process.env.PANEL_DB_KEY = 'schluessel-fuer-tests-0123456789abcdef';
process.env.JWT_SECRET = 'jwt-geheimnis-fuer-tests-0123456789abcdef';

const express = require('express');
const db = require('../src/db');
const tokens = require('../src/services/tokens');
const internalAuth = require('../src/middleware/internalAuth');

const { adminOderPanelSecret, panelSecret } = internalAuth;

let port;
let server;
const ids = {};

// Ein Mini-Abbild von index.js: erst der Anhang-Router (je Route mit Wächter), dann
// der allgemeine interne Router mit reinem Panel-Secret.
before(async () => {
  const rolleNurQuarantaene = db.prepare(
    "INSERT OR IGNORE INTO rollen (name, fest, rechte) VALUES ('Nur Quarantäne', 0, ?)",
  ).run(JSON.stringify({ quarantaene: true }));
  ids.rolleFremd = rolleNurQuarantaene.lastInsertRowid
    || db.prepare("SELECT id FROM rollen WHERE name = 'Nur Quarantäne'").get().id;

  // Eine selbst angelegte Rolle MIT allen Rechten: sie ist trotzdem kein Admin.
  const alleRechte = db.prepare(
    "INSERT OR IGNORE INTO rollen (name, fest, rechte) VALUES ('Fast Admin', 0, ?)",
  ).run(JSON.stringify({
    konten: true, listen: true, einstellungen: true, benutzer: true, sortierung: true,
    quarantaene: true, newsletter: true, rspamd: true, workflows: true, logs: true, dashboard: true,
  }));
  ids.rolleFastAdmin = alleRechte.lastInsertRowid
    || db.prepare("SELECT id FROM rollen WHERE name = 'Fast Admin'").get().id;

  const neu = (name, rolle) => db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, ?)')
    .run(name, 'x', rolle).lastInsertRowid;
  ids.admin = neu('admin-test', 1);
  ids.fremd = neu('fremd-test', ids.rolleFremd);
  ids.fastAdmin = neu('fastadmin-test', ids.rolleFastAdmin);

  const app = express();
  const anhang = express.Router();
  const antwort = (req, res) => res.json({ ok: true, user: req.user?.username || null });
  // Wie in routes/anhaenge.js: Wächter VOR dem Parser.
  anhang.post('/scan-anhaenge', adminOderPanelSecret, express.json({ limit: '16kb' }), antwort);
  app.use('/api/internal', anhang);
  const intern = express.Router();
  intern.post('/config', express.json(), antwort);
  app.use('/api/internal', panelSecret, intern);

  await new Promise((fertig) => { server = app.listen(0, () => { port = server.address().port; fertig(); }); });
});
after(() => { try { server.close(); } catch { /* egal */ } });

function anfrage(pfad, { kopf = {}, rumpf = '{}' } = {}) {
  return new Promise((fertig, schief) => {
    let geliefert = false;
    const a = http.request({
      host: '127.0.0.1', port, path: pfad, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rumpf), ...kopf },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* kein JSON */ }
        geliefert = true;
        fertig({ status: r.statusCode, json });
      });
    });
    // Antwortet der Server, bevor er den ganzen Rumpf gelesen hat (genau das soll
    // der Wächter tun), kann das Schreiben danach mit EPIPE/ECONNRESET enden. Die
    // Antwort zählt trotzdem.
    a.on('error', (e) => { if (!geliefert) schief(e); });
    a.write(rumpf);
    a.end();
  });
}

const sitzung = (id, extra = {}) => tokens.sitzungSignieren({ id, username: 'x', ...extra });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const SECRET = { 'X-Panel-Secret': process.env.PANEL_SECRET };
const ANHANG = '/api/internal/scan-anhaenge';

describe('Panel-Secret (n8n)', () => {
  test('das richtige Secret lässt durch', async () => {
    const r = await anfrage(ANHANG, { kopf: SECRET });
    assert.equal(r.status, 200);
  });

  test('ein falsches Secret: 401', async () => {
    assert.equal((await anfrage(ANHANG, { kopf: { 'X-Panel-Secret': 'falsch' } })).status, 401);
  });

  test('ein Secret mit richtigem Anfang, aber falschem Ende: 401', async () => {
    const fast = process.env.PANEL_SECRET.slice(0, -1) + 'X';
    assert.equal((await anfrage(ANHANG, { kopf: { 'X-Panel-Secret': fast } })).status, 401);
  });

  test('ein leeres Secret: 401', async () => {
    assert.equal((await anfrage(ANHANG, { kopf: { 'X-Panel-Secret': '' } })).status, 401);
  });

  test('ist PANEL_SECRET selbst leer, passt auch ein leerer Header nicht', async () => {
    const alt = process.env.PANEL_SECRET;
    process.env.PANEL_SECRET = '';
    try {
      assert.equal((await anfrage(ANHANG, { kopf: { 'X-Panel-Secret': '' } })).status, 401);
    } finally { process.env.PANEL_SECRET = alt; }
  });

  // Sonst taugte jeder Fehlversuch mit dem Secret als Sondierung der Anmeldung.
  test('ein falsches Secret weicht NICHT auf eine gültige Admin-Anmeldung aus', async () => {
    const r = await anfrage(ANHANG, { kopf: { 'X-Panel-Secret': 'falsch', ...bearer(sitzung(ids.admin)) } });
    assert.equal(r.status, 401);
  });

  test('das richtige Secret gilt auch, wenn daneben ein ungültiges Token mitkommt', async () => {
    const r = await anfrage(ANHANG, { kopf: { ...SECRET, Authorization: 'Bearer quatsch' } });
    assert.equal(r.status, 200);
  });
});

describe('Admin-Anmeldung', () => {
  test('ein Admin kommt durch', async () => {
    const r = await anfrage(ANHANG, { kopf: bearer(sitzung(ids.admin)) });
    assert.equal(r.status, 200);
    assert.equal(r.json.user, 'admin-test');
  });

  test('ein Benutzer mit anderer Rolle: 403, nicht 401', async () => {
    const r = await anfrage(ANHANG, { kopf: bearer(sitzung(ids.fremd)) });
    assert.equal(r.status, 403, 'die Sitzung ist in Ordnung — 401 würde das Frontend abmelden');
  });

  // Wer eine Rolle mit allen Rechten anlegt, ist damit kein Admin: Die feste
  // Admin-Rolle ist die einzige, die nicht frei bearbeitbar ist.
  test('eine selbst angelegte Rolle mit ALLEN Rechten ist trotzdem kein Admin', async () => {
    const r = await anfrage(ANHANG, { kopf: bearer(sitzung(ids.fastAdmin)) });
    assert.equal(r.status, 403);
  });

  // Der Payload ist Anzeige, die Rechte kommen aus der Datenbank.
  test('ein Token, das „admin: true" BEHAUPTET, macht niemanden zum Admin', async () => {
    const r = await anfrage(ANHANG, { kopf: bearer(sitzung(ids.fremd, { admin: true, rolle_id: 1, rechte: { benutzer: true } })) });
    assert.equal(r.status, 403);
  });

  test('wird dem Admin die Rolle entzogen, wirkt das sofort', async () => {
    const t = sitzung(ids.admin);
    assert.equal((await anfrage(ANHANG, { kopf: bearer(t) })).status, 200);
    db.prepare('UPDATE users SET rolle_id = ? WHERE id = ?').run(ids.rolleFremd, ids.admin);
    try {
      assert.equal((await anfrage(ANHANG, { kopf: bearer(t) })).status, 403, 'das alte Token gilt nicht weiter');
    } finally {
      db.prepare('UPDATE users SET rolle_id = 1 WHERE id = ?').run(ids.admin);
    }
  });

  test('ein gelöschter Benutzer: 401', async () => {
    const id = db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, 1)').run('weg-test', 'x').lastInsertRowid;
    const t = sitzung(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    const r = await anfrage(ANHANG, { kopf: bearer(t) });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'benutzer_weg');
  });
});

describe('Ungültige Tokens', () => {
  test('ohne Secret und ohne Token: 401', async () => {
    const r = await anfrage(ANHANG);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'kein_token');
  });

  test('ein abgelaufenes Token: 401', async () => {
    const t = tokens.sitzungSignieren({ id: ids.admin }, { expiresIn: '-10s' });
    const r = await anfrage(ANHANG, { kopf: bearer(t) });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'abgelaufen');
  });

  test('mit fremdem Schlüssel signiert: 401', async () => {
    const t = jwt.sign({ id: ids.admin }, 'ein-ganz-anderer-schluessel-0123456789', {
      algorithm: 'HS256', issuer: tokens.ISSUER, audience: tokens.AUD_SITZUNG,
    });
    assert.equal((await anfrage(ANHANG, { kopf: bearer(t) })).status, 401);
  });

  test('„alg: none" geht nicht durch', async () => {
    const kopf = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const last = Buffer.from(JSON.stringify({
      id: ids.admin, iss: tokens.ISSUER, aud: tokens.AUD_SITZUNG, exp: Math.floor(Date.now() / 1000) + 600,
    })).toString('base64url');
    const r = await anfrage(ANHANG, { kopf: bearer(`${kopf}.${last}.`) });
    assert.equal(r.status, 401);
  });

  test('ein Token im alten Format (ohne Zielgruppe) gilt nicht mehr', async () => {
    const t = jwt.sign({ id: ids.admin }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await anfrage(ANHANG, { kopf: bearer(t) })).status, 401);
  });

  test('ein Token mit anderer Zielgruppe: 401', async () => {
    const t = jwt.sign({ id: ids.admin }, process.env.JWT_SECRET, {
      algorithm: 'HS256', issuer: tokens.ISSUER, audience: 'etwas-anderes',
    });
    assert.equal((await anfrage(ANHANG, { kopf: bearer(t) })).status, 401);
  });

  // Das Ticket nach dem Passwort darf nie eine Sitzung ersetzen.
  test('ein 2FA-Ticket ist kein Sitzungs-Token: 401', async () => {
    const ticket = tokens.ticketSignieren(ids.admin, 'ticket-1');
    const r = await anfrage(ANHANG, { kopf: bearer(ticket) });
    assert.equal(r.status, 401);
  });

  test('ein Ticket, das mit dem Sitzungsschlüssel signiert wurde, taugt auch nicht als Ticket', () => {
    const falsch = jwt.sign({ typ: '2fa-ticket' }, process.env.JWT_SECRET, {
      algorithm: 'HS256', issuer: tokens.ISSUER, audience: tokens.AUD_TICKET, subject: String(ids.admin), jwtid: 'x', expiresIn: 60,
    });
    assert.throws(() => tokens.ticketVerifizieren(falsch));
  });

  test('ein Sitzungs-Token taugt nicht als Ticket', () => {
    assert.throws(() => tokens.ticketVerifizieren(sitzung(ids.admin)));
  });

  test('der Authorization-Kopf ohne „Bearer": 401', async () => {
    assert.equal((await anfrage(ANHANG, { kopf: { Authorization: sitzung(ids.admin) } })).status, 401);
  });
});

describe('Reihenfolge: erst ausweisen, dann parsen', () => {
  // Läge der Parser vor dem Wächter, antwortete er hier mit 413 — er hätte den Rumpf
  // schon gelesen. So kommt der Aufrufer nie so weit.
  test('ein großer Rumpf ohne Ausweis bekommt 401, nicht 413', async () => {
    const gross = JSON.stringify({ x: 'A'.repeat(3 * 1024 * 1024) });
    const r = await anfrage(ANHANG, { rumpf: gross });
    assert.equal(r.status, 401);
  });

  test('mit Ausweis wird derselbe Rumpf vom Parser abgewiesen (16 kB)', async () => {
    const gross = JSON.stringify({ x: 'A'.repeat(3 * 1024 * 1024) });
    const r = await anfrage(ANHANG, { kopf: SECRET, rumpf: gross });
    assert.equal(r.status, 413);
  });
});

describe('Alle übrigen internen Endpunkte: nur das Panel-Secret', () => {
  test('mit Secret: durch', async () => {
    assert.equal((await anfrage('/api/internal/config', { kopf: SECRET })).status, 200);
  });

  // Admin-Anmeldung öffnet NUR die Anhang-Endpunkte — sonst wäre jeder Admin-Browser
  // zugleich ein Aufrufer für alles, was n8n tun darf.
  test('eine Admin-Anmeldung reicht dort NICHT', async () => {
    const r = await anfrage('/api/internal/config', { kopf: bearer(sitzung(ids.admin)) });
    assert.equal(r.status, 401);
  });

  test('ohne alles: 401', async () => {
    assert.equal((await anfrage('/api/internal/config')).status, 401);
  });
});
