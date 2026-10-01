// Entscheidungen über KI-Vorschläge — bestätigen, korrigieren, ablehnen — brauchen
// eine gültige ADMIN-Sitzung.
//
// Bis Build 253 genügte dafür das Recht „sortierung". Das lässt sich jeder selbst
// angelegten Rolle geben, und wer es hat, darf auch Regeln pflegen. Ein Vorschlag des
// Modells aber legt Ordner an, bewegt Mails und lernt Regeln — das soll nur die feste
// Admin-Rolle auslösen können.
//
// Geprüft wird der ganze Weg wie im Betrieb: auth (JWT, Benutzer aus der Datenbank),
// rechtErforderlich('sortierung'), adminErforderlich. Die Rollen-Claims des Tokens
// müssen zur Datenbank passen.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
require('./umgebung');

process.env.JWT_SECRET = 'jwt-geheimnis-fuer-tests-0123456789abcdef';
process.env.PANEL_DB_KEY = 'schluessel-fuer-tests-0123456789abcdef';
process.env.PANEL_SECRET = 'panel-geheimnis-fuer-tests-0123456789abcdef';

const express = require('express');
const db = require('../src/db');
const tokens = require('../src/services/tokens');
const imap = require('../src/services/imap');
const auth = require('../src/middleware/auth');

const { rechtErforderlich, adminErforderlich } = auth;

const ids = {};
let server;
let port;

// Die Orte, an denen KI-Vorschläge entschieden werden: Bestätigung (freigeben,
// Verschiebung), Korrektur (umleiten, zusammenfassen, Zielfeld) und Ablehnung.
const ROUTEN = [
  { name: 'Vorschlag freigeben (Bestätigung)', pfad: () => `/api/sortierung/vorschlaege/${ids.vorschlag}/freigeben`, rumpf: {} },
  { name: 'Vorschlag umleiten (Korrektur)', pfad: () => `/api/sortierung/vorschlaege/${ids.vorschlag}/umleiten`, rumpf: { ordner: 'Einkauf' } },
  { name: 'Vorschlag ablehnen', pfad: () => `/api/sortierung/vorschlaege/${ids.vorschlag}/ablehnen`, rumpf: {} },
  { name: 'Vorschläge zusammenfassen (Korrektur)', pfad: () => '/api/sortierung/vorschlaege/zusammenfassen', rumpf: { ordner: 'Sammel', vorschlag_ids: [ids.vorschlag] } },
  { name: 'Alle KI-Vorschläge übernehmen (Bestätigung)', pfad: () => '/api/sortierung/inbox/vorschlaege-uebernehmen', rumpf: { konto_id: ids.konto, ordner: ['Games'] } },
  { name: 'Nachsortierung: Vorschlag übernehmen oder korrigieren', pfad: () => '/api/sortierung/nachsortierung/verschieben', rumpf: { konto_id: ids.konto, uid: 7, von: 'INBOX', nach: 'Einkauf' } },
];

const rolle = (name, rechte, fest = 0) => db.prepare('INSERT INTO rollen (name, fest, rechte) VALUES (?, ?, ?)')
  .run(name, fest, JSON.stringify(rechte)).lastInsertRowid;
const benutzer = (name, rolleId) => db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, ?)')
  .run(name, 'x', rolleId).lastInsertRowid;

before(async () => {
  ids.rolleSortierer = rolle('Nur Sortierung', { sortierung: true });
  ids.rolleFastAdmin = rolle('Fast Admin', {
    konten: true, listen: true, einstellungen: true, benutzer: true, sortierung: true,
    quarantaene: true, newsletter: true, rspamd: true, workflows: true, logs: true, dashboard: true,
  });
  ids.rolleOhne = rolle('Nur Quarantäne', { quarantaene: true });
  ids.admin = benutzer('admin-t', 1);
  ids.sortierer = benutzer('sortierer-t', ids.rolleSortierer);
  ids.fast = benutzer('fastadmin-t', ids.rolleFastAdmin);
  ids.ohne = benutzer('ohne-t', ids.rolleOhne);

  ids.konto = db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K', 'h', 993, 'u', 'x', 1)")
    .run().lastInsertRowid;

  const app = express();
  app.use(express.json());
  // Genau wie in index.js.
  app.use('/api/sortierung', auth, rechtErforderlich('sortierung'), require('../src/routes/sortierung'));
  app.get('/api/nur-admin', auth, adminErforderlich, (req, res) => res.json({ ok: true, user: req.user.username }));
  await new Promise((fertig) => { server = app.listen(0, () => { port = server.address().port; fertig(); }); });
});
after(() => { try { server.close(); } catch { /* egal */ } });

const echt = {};
beforeEach(() => {
  db.prepare('DELETE FROM ordner_vorschlaege').run();
  ids.vorschlag = db.prepare("INSERT INTO ordner_vorschlaege (konto_id, ordner, status) VALUES (?, 'Games', 'offen')")
    .run(ids.konto).lastInsertRowid;
  // Kein echtes Postfach: Alles, was IMAP braucht, antwortet „nicht erreichbar".
  for (const f of ['ordnerDetails', 'mailsVerschieben', 'ordnerErstellen']) echt[f] ??= imap[f];
  imap.ordnerDetails = async () => { throw new Error('kein Postfach im Test'); };
  imap.mailsVerschieben = async () => ({ verschoben: [], fehler: [] });
  imap.ordnerErstellen = async () => false;
});

function anfrage(methode, pfad, { rumpf, token } = {}) {
  return new Promise((fertig, schief) => {
    const daten = rumpf === undefined ? '' : JSON.stringify(rumpf);
    const kopf = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(daten) };
    if (token) kopf.Authorization = `Bearer ${token}`;
    const a = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: kopf }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* kein JSON */ }
        fertig({ status: r.statusCode, json });
      });
    });
    a.on('error', schief);
    a.end(daten);
  });
}

// Ein Token, wie auth.tokenErzeugen es ausstellt — mit Rollen-Claims, die sich
// für Tests verbiegen lassen.
const sitzung = (id, claims = {}) => {
  const z = db.prepare('SELECT u.username, u.rolle_id, r.fest FROM users u LEFT JOIN rollen r ON r.id = u.rolle_id WHERE u.id = ?').get(id);
  return tokens.sitzungSignieren({
    id, username: z.username, rolle_id: z.rolle_id, admin: z.fest === 1, amr: ['pwd'], rechte: {}, ...claims,
  });
};
const bearer = (t) => ({ token: t });
const status = () => db.prepare('SELECT status FROM ordner_vorschlaege WHERE id = ?').get(ids.vorschlag)?.status;

for (const route of ROUTEN) {
  describe(route.name, () => {
    const rufen = (token) => anfrage('POST', route.pfad(), { rumpf: route.rumpf, token });

    test('ohne Anmeldung: 401', async () => {
      assert.equal((await rufen()).status, 401);
    });

    test('mit einem 2FA-Ticket statt einer Sitzung: 401', async () => {
      assert.equal((await rufen(tokens.ticketSignieren(ids.admin, 'ticket-x'))).status, 401);
    });

    test('mit dem Recht „sortierung", aber ohne Admin-Rolle: 403, und nichts passiert', async () => {
      const r = await rufen(sitzung(ids.sortierer));
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'admin_noetig');
      assert.equal(status(), 'offen', 'der Vorschlag darf nicht angefasst worden sein');
    });

    test('auch eine selbst angelegte Rolle mit ALLEN Rechten ist kein Admin', async () => {
      const r = await rufen(sitzung(ids.fast));
      assert.equal(r.status, 403);
      assert.equal(status(), 'offen');
    });

    test('ohne das Recht „sortierung" kommt man nicht einmal bis zur Admin-Prüfung', async () => {
      assert.equal((await rufen(sitzung(ids.ohne))).status, 403);
    });

    test('der Admin kommt durch', async () => {
      const r = await rufen(sitzung(ids.admin));
      assert.ok(![401, 403].includes(r.status), `Status ${r.status}: ${JSON.stringify(r.json)}`);
    });
  });
}

describe('Vorschlag ablehnen: die Wirkung', () => {
  const ablehnen = (token) => anfrage('POST', `/api/sortierung/vorschlaege/${ids.vorschlag}/ablehnen`, { rumpf: {}, token });

  test('der Admin lehnt ab — der Status ändert sich', async () => {
    const r = await ablehnen(sitzung(ids.admin));
    assert.equal(r.status, 200);
    assert.equal(status(), 'abgelehnt');
  });

  test('ein anderer Benutzer kann es nicht, auch mit gültigem Token', async () => {
    assert.equal((await ablehnen(sitzung(ids.sortierer))).status, 403);
    assert.equal(status(), 'offen');
  });
});

describe('Die Rollen-Claims des Tokens müssen zur Datenbank passen', () => {
  const nurAdmin = (token) => anfrage('GET', '/api/nur-admin', bearer(token));

  test('Admin mit stimmendem Token: 200', async () => {
    const r = await nurAdmin(sitzung(ids.admin));
    assert.equal(r.status, 200);
    assert.equal(r.json.user, 'admin-t');
  });

  test('der Admin-Rolle ENTZOGEN, Token noch gültig: 403', async () => {
    const id = benutzer('entzogen-t', 1);
    const token = sitzung(id); // sagt: admin
    assert.equal((await nurAdmin(token)).status, 200);
    db.prepare('UPDATE users SET rolle_id = ? WHERE id = ?').run(ids.rolleSortierer, id);
    const r = await nurAdmin(token);
    assert.equal(r.status, 403, 'das Token behauptet weiter „admin" — die Datenbank sagt Nein');
    assert.equal(r.json.code, 'admin_noetig');
  });

  test('ZUM Admin gemacht, Token noch von davor: 401 mit Hinweis auf neues Anmelden', async () => {
    const id = benutzer('befoerdert-t', ids.rolleSortierer);
    const altesToken = sitzung(id); // sagt: kein Admin
    db.prepare('UPDATE users SET rolle_id = 1 WHERE id = ?').run(id);
    const r = await nurAdmin(altesToken);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'rolle_geaendert');
    assert.match(r.json.error, /neu an/);
    // Mit einem frischen Token geht es.
    assert.equal((await nurAdmin(sitzung(id))).status, 200);
  });

  test('die Rollen-Nummer im Token weicht ab: 401', async () => {
    const r = await nurAdmin(sitzung(ids.admin, { rolle_id: 999 }));
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'rolle_geaendert');
  });

  test('ein Token ohne Rollen-Claims (etwa von vor dem Update): 401', async () => {
    const roh = tokens.sitzungSignieren({ id: ids.admin, username: 'admin-t', amr: ['pwd'] });
    const r = await nurAdmin(roh);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'rolle_geaendert');
  });

  test('„admin: true" im Token macht niemanden zum Admin, solange die Datenbank es nicht sagt', async () => {
    const r = await nurAdmin(sitzung(ids.sortierer, { admin: true, rolle_id: ids.rolleSortierer }));
    assert.equal(r.status, 403);
  });

  test('ein selbst gebautes Token mit „admin: true" und fremdem Schlüssel: 401', async () => {
    const falsch = jwt.sign({ id: ids.sortierer, admin: true, rolle_id: 1 }, 'ein-anderer-schluessel-0123456789abcdef', {
      algorithm: 'HS256', issuer: tokens.ISSUER, audience: tokens.AUD_SITZUNG,
    });
    assert.equal((await nurAdmin(falsch)).status, 401);
  });

  test('„alg: none": 401', async () => {
    const kopf = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const last = Buffer.from(JSON.stringify({
      id: ids.sortierer, admin: true, rolle_id: 1, iss: tokens.ISSUER, aud: tokens.AUD_SITZUNG,
      exp: Math.floor(Date.now() / 1000) + 600,
    })).toString('base64url');
    assert.equal((await nurAdmin(`${kopf}.${last}.`)).status, 401);
  });

  test('abgelaufen: 401', async () => {
    const t = tokens.sitzungSignieren({ id: ids.admin, admin: true, rolle_id: 1 }, { expiresIn: '-10s' });
    const r = await nurAdmin(t);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'abgelaufen');
  });

  test('gelöschter Benutzer: 401', async () => {
    const id = benutzer('weg-t', 1);
    const t = sitzung(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    const r = await nurAdmin(t);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'benutzer_weg');
  });

  test('ohne Token, mit kaputtem Kopf: 401', async () => {
    assert.equal((await anfrage('GET', '/api/nur-admin')).status, 401);
    assert.equal((await nurAdmin('quatsch')).status, 401);
  });
});

describe('adminErforderlich als Funktion', () => {
  const lauf = (req) => {
    let ergebnis = { weiter: false };
    const res = {
      status(code) { ergebnis.status = code; return this; },
      json(daten) { ergebnis.json = daten; return this; },
    };
    adminErforderlich(req, res, () => { ergebnis.weiter = true; });
    return ergebnis;
  };

  test('ohne req.user (auth nicht gelaufen): 401, nie „weiter"', () => {
    const r = lauf({});
    assert.equal(r.status, 401);
    assert.equal(r.weiter, false);
  });

  test('nur wenn Datenbank UND Token übereinstimmen, geht es weiter', () => {
    assert.equal(lauf({ user: { admin: true, rolle_id: 1, claims: { admin: true, rolle_id: 1 } } }).weiter, true);
    assert.equal(lauf({ user: { admin: false, rolle_id: 1, claims: { admin: true, rolle_id: 1 } } }).status, 403);
    assert.equal(lauf({ user: { admin: true, rolle_id: 1, claims: { admin: false, rolle_id: 1 } } }).status, 401);
    assert.equal(lauf({ user: { admin: true, rolle_id: 1, claims: { admin: true, rolle_id: 2 } } }).status, 401);
    assert.equal(lauf({ user: { admin: true, rolle_id: 1 } }).status, 401);
    assert.equal(lauf({ user: { admin: true, rolle_id: 1, claims: { admin: 'true', rolle_id: 1 } } }).status, 401, 'nur echtes true zählt');
  });

  test('ein Benutzer ohne admin-Feld ist kein Admin', () => {
    assert.equal(lauf({ user: { id: 1 } }).status, 403);
  });
});

// Dieselbe Absicht wie in parser-grenzen.test.js: Wer später eine neue Entscheidungs-
// Route anlegt oder die Prüfung versehentlich entfernt, soll hier hängen bleiben.
describe('Quelltext: wo die Prüfung steht', () => {
  const quelle = fs.readFileSync(path.resolve(__dirname, '../src/routes/sortierung.js'), 'utf8');

  const argumenteVon = (methode, pfad) => {
    const muster = new RegExp(`router\\.${methode}\\(\\s*'${pfad.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*,([\\s\\S]*?)\\(req,\\s*res\\)\\s*=>`);
    const m = muster.exec(quelle);
    assert.ok(m, `${methode.toUpperCase()} ${pfad} nicht gefunden`);
    return m[1];
  };

  for (const pfad of [
    '/vorschlaege/:id/freigeben', '/vorschlaege/:id/umleiten', '/vorschlaege/:id/ablehnen',
    '/vorschlaege/zusammenfassen', '/inbox/vorschlaege-uebernehmen', '/nachsortierung/verschieben',
  ]) {
    test(`POST ${pfad} verlangt adminErforderlich`, () => {
      assert.match(argumenteVon('post', pfad), /adminErforderlich/);
    });
  }

  test('index.js hängt sortierung hinter auth UND rechtErforderlich (die Admin-Prüfung setzt auf beides auf)', () => {
    const index = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    assert.match(index, /app\.use\('\/api\/sortierung', auth, rechtErforderlich\('sortierung'\)/);
  });
});
