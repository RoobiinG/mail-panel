// Die Zwei-Faktor-Anmeldung, wie ein Angreifer und ein Benutzer sie erleben.
//
// Was hier festgehalten ist:
//   1. Nach dem Passwort gibt es KEIN Sitzungs-Token, nur ein Ticket (5 Minuten), das
//      sich nirgends sonst benutzen lässt.
//   2. Ein Code löst das Ticket ein — einmal. Codes gelten einmal, verfallen, gehören
//      zu einem Ticket und liegen nie im Klartext in der Datenbank.
//   3. Durchprobieren ist gebremst: je Ticket, je Adresse UND je Benutzer.
//   4. Erst danach gibt es das Sitzungs-Token — mit Rolle und Rechten im Payload.
//   5. 2FA ist freiwillig: Wer keine eingerichtet hat, meldet sich wie bisher an.
//
// Die Uhr läuft in diesen Tests vor (siehe zeitVor): TOTP wechselt alle 30 Sekunden,
// und ein Code gilt nur einmal — ohne vorgestellte Uhr müsste jeder Test warten.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('./umgebung');

process.env.JWT_SECRET = 'jwt-geheimnis-fuer-tests-0123456789abcdef';
process.env.PANEL_DB_KEY = 'schluessel-fuer-tests-0123456789abcdef';
process.env.PANEL_SECRET = 'panel-geheimnis-fuer-tests-0123456789abcdef';

// ─── Die Uhr vorstellen ──────────────────────────────────────────────────────
const echtesNow = Date.now;
let versatz = 0;
Date.now = () => echtesNow() + versatz;
const zeitVor = (sekunden) => { versatz += sekunden * 1000; };
const naechsterSchritt = () => zeitVor(31);

const express = require('express');
const db = require('../src/db');
const settings = require('../src/services/settings');
const smtp = require('../src/services/smtp');
const discord = require('../src/services/discord');
const totp = require('../src/services/totp');
const tokens = require('../src/services/tokens');
const zweifaktor = require('../src/services/zweifaktor');
const auth = require('../src/middleware/auth');

// ─── Zustellung abfangen ─────────────────────────────────────────────────────
let gesendet = [];
let ausfall = {};
const echtesMail = smtp.mailSenden;
const echtesDm = discord.dmSenden;
smtp.mailSenden = async (o) => {
  if (ausfall.mail) throw new Error(ausfall.mail);
  gesendet.push({ art: 'email', an: o.an, text: o.text, betreff: o.betreff });
  return { ok: true };
};
discord.dmSenden = async (o) => {
  if (ausfall.discord) throw new Error(ausfall.discord);
  gesendet.push({ art: 'discord', userId: o.userId, token: o.token, text: o.text });
  return { ok: true };
};
after(() => { smtp.mailSenden = echtesMail; discord.dmSenden = echtesDm; Date.now = echtesNow; });

const codeAus = (nachricht) => /Mail-Panel: (\d{6})/.exec(nachricht.text)[1];
const letzterCode = (art) => codeAus([...gesendet].reverse().find((g) => g.art === art));

// ─── Mini-Panel ──────────────────────────────────────────────────────────────
let server;
let port;
const server_ = [];
const PW = 'ein-langes-passwort-123';
const HASH = bcrypt.hashSync(PW, 4); // billig: die Tests rechnen hunderte Male
const ids = {};
let ipZaehler = 0;
const frischeIp = () => { ipZaehler += 1; return `10.7.${Math.floor(ipZaehler / 250)}.${(ipZaehler % 250) + 1}`; };

const GLOBALER_BOT = 'TESTBOT-GLOBAL-0000000000.GlObAl.testbot-nur-fuer-tests-0000000000';
const EIGENER_BOT = 'TESTBOT-EIGENER-0000000000.EiGeNeR.testbot-nur-fuer-tests-0000000000';
const DISCORD_ID = '123456789012345678';

function benutzer(name, rolle = 1) {
  return db.prepare('INSERT INTO users (username, password, rolle_id) VALUES (?, ?, ?)').run(name, HASH, rolle).lastInsertRowid;
}

async function totpEinrichten(userId, name) {
  const { geheimnis } = zweifaktor.totpStarten(userId, name);
  assert.equal(zweifaktor.einrichtungBestaetigen({ userId, methode: 'totp', eingabe: totp.code(geheimnis) }), true);
  naechsterSchritt(); // der bestätigte Schritt ist verbraucht
  return geheimnis;
}

async function codeMethodeEinrichten(userId, methode, ziel, eigenerBot) {
  await zweifaktor.codeMethodeStarten({ userId, methode, ziel, eigenerBot });
  assert.equal(zweifaktor.einrichtungBestaetigen({ userId, methode, eingabe: letzterCode(methode) }), true);
}

before(async () => {
  settings.setze('smtp_host', 'smtp.example.org');
  settings.setze('discord_bot_token', GLOBALER_BOT);

  const nurQuarantaene = db.prepare("INSERT INTO rollen (name, fest, rechte) VALUES ('Nur Quarantäne', 0, ?)")
    .run(JSON.stringify({ quarantaene: true })).lastInsertRowid;
  ids.rolleQ = nurQuarantaene;

  ids.ohne = benutzer('ohne-2fa');
  ids.totp = benutzer('nur-totp', nurQuarantaene);
  ids.mehr = benutzer('mehrfach');
  ids.dglobal = benutzer('discord-global', nurQuarantaene);

  ids.geheimnisTotp = await totpEinrichten(ids.totp, 'nur-totp');
  ids.geheimnisMehr = await totpEinrichten(ids.mehr, 'mehrfach');
  await codeMethodeEinrichten(ids.mehr, 'email', 'mf@example.org');
  await codeMethodeEinrichten(ids.mehr, 'discord', DISCORD_ID, EIGENER_BOT);
  await codeMethodeEinrichten(ids.dglobal, 'discord', DISCORD_ID);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/zweifaktor', auth, require('../src/routes/zweifaktor'));
  app.use('/api/benutzer', auth, auth.rechtErforderlich('benutzer'), require('../src/routes/benutzer'));
  app.get('/api/geschuetzt', auth, (req, res) => res.json({ user: req.user.username, admin: req.user.admin }));
  await new Promise((fertig) => { server = app.listen(0, () => { port = server.address().port; server_.push(server); fertig(); }); });
});
after(() => { try { server.close(); } catch { /* egal */ } });
beforeEach(() => {
  gesendet = [];
  ausfall = {};
  // Falsche Codes früherer Tests würden sonst die Benutzersperre (zehn in 15
  // Minuten) auslösen — sie wirkt ja, wie sie soll. Die Tests, die genau das
  // prüfen, bauen ihren Zustand innerhalb des Tests auf.
  db.prepare("DELETE FROM auth_log WHERE methode LIKE '2fa-%'").run();
});

function anfrage(methode, pfad, { rumpf, token, ip = frischeIp() } = {}) {
  return new Promise((fertig, schief) => {
    const daten = rumpf === undefined ? '' : JSON.stringify(rumpf);
    const kopf = { 'X-Forwarded-For': ip };
    if (daten) { kopf['Content-Type'] = 'application/json'; kopf['Content-Length'] = Buffer.byteLength(daten); }
    if (token) kopf.Authorization = `Bearer ${token}`;
    const a = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: kopf }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* kein JSON */ }
        fertig({ status: r.statusCode, json, text: t });
      });
    });
    a.on('error', schief);
    if (daten) a.write(daten);
    a.end();
  });
}

const login = (name, passwort = PW, ip) => anfrage('POST', '/api/auth/login', { rumpf: { username: name, password: passwort }, ip });
const verify = (ticket, methode, code, ip) => anfrage('POST', '/api/auth/verify-2fa', { rumpf: { auth_ticket: ticket, methode, code }, ip });
const senden = (ticket, methode, ip) => anfrage('POST', '/api/auth/2fa/senden', { rumpf: { auth_ticket: ticket, methode }, ip });
const geschuetzt = (token) => anfrage('GET', '/api/geschuetzt', { token });
const nutzlast = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const jtiVon = (ticket) => nutzlast(ticket).jti;
const authLog = (name) => db.prepare('SELECT erfolg, methode FROM auth_log WHERE username = ? ORDER BY id').all(name);

// ─── 5. Freiwillig ───────────────────────────────────────────────────────────
describe('Ohne eingerichtete 2FA läuft die Anmeldung wie bisher', () => {
  test('ein Schritt: Passwort → Sitzungs-Token', async () => {
    const r = await login('ohne-2fa');
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    assert.equal(r.json.zweiFaktor, undefined);
    assert.equal(r.json.auth_ticket, undefined);
    assert.equal((await geschuetzt(r.json.token)).status, 200);
  });

  test('das Token trägt Rolle und Rechte (Admin)', async () => {
    const p = nutzlast((await login('ohne-2fa')).json.token);
    assert.equal(p.username, 'ohne-2fa');
    assert.equal(p.rolle_name, 'Admin');
    assert.equal(p.admin, true);
    assert.equal(p.rechte.benutzer, true);
    assert.equal(p.aud, tokens.AUD_SITZUNG);
    assert.equal(p.iss, tokens.ISSUER);
    assert.deepEqual(p.amr, ['pwd']);
  });

  test('ein falsches Passwort: 401, und für unbekannte Benutzer dieselbe Antwort', async () => {
    const falsch = await login('ohne-2fa', 'falsch-falsch-falsch');
    const unbekannt = await login('gibt-es-nicht', PW);
    assert.equal(falsch.status, 401);
    assert.equal(unbekannt.status, 401);
    assert.deepEqual(falsch.json, unbekannt.json, 'kein Hinweis, ob es den Benutzer gibt');
  });

  test('fehlende Angaben: 400', async () => {
    assert.equal((await anfrage('POST', '/api/auth/login', { rumpf: { username: 'x' } })).status, 400);
    assert.equal((await anfrage('POST', '/api/auth/login', { rumpf: {} })).status, 400);
  });
});

// ─── 1. Ticket statt Token ───────────────────────────────────────────────────
describe('Mit 2FA: nach dem Passwort gibt es nur ein Ticket', () => {
  test('KEIN Sitzungs-Token, sondern ein Ticket und die Methoden zur Wahl', async () => {
    const r = await login('nur-totp');
    assert.equal(r.status, 200);
    assert.equal(r.json.zweiFaktor, true);
    assert.ok(r.json.auth_ticket);
    assert.equal(r.json.token, undefined, 'sonst wäre die zweite Stufe überflüssig');
    assert.ok(!/"token"/.test(r.text));
    assert.deepEqual(r.json.methoden, ['totp']);
    assert.equal(r.json.bevorzugt, 'totp');
    assert.ok(r.json.ablauf > Math.floor(Date.now() / 1000));
    assert.ok(r.json.ablauf <= Math.floor(Date.now() / 1000) + 300, 'fünf Minuten');
    // Der Browser zählt ab Empfang selbst herunter — gegen seine eigene Uhr zu rechnen
    // ginge schief, sobald sie falsch geht.
    assert.equal(r.json.gueltig_sekunden, 300);
  });

  test('das Ticket lässt sich nicht als Sitzung benutzen', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    assert.equal((await geschuetzt(t)).status, 401);
    assert.equal((await anfrage('GET', '/api/zweifaktor', { token: t })).status, 401, 'auch nicht für die 2FA-Verwaltung');
    assert.equal((await anfrage('GET', '/api/benutzer', { token: t })).status, 401);
  });

  test('das Ticket hat die richtige Zielgruppe und fünf Minuten Laufzeit', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    const p = nutzlast(t);
    assert.equal(p.aud, tokens.AUD_TICKET);
    assert.equal(p.typ, '2fa-ticket');
    assert.equal(p.exp - p.iat, 300);
    assert.equal(Number(p.sub), ids.totp);
    assert.ok(p.jti);
  });

  test('mehrere Methoden: alle stehen zur Wahl, Ziele sind maskiert', async () => {
    const r = await login('mehrfach');
    assert.deepEqual(r.json.methoden, ['totp', 'email', 'discord']);
    assert.equal(r.json.bevorzugt, 'totp');
    assert.equal(r.json.ziele.email, 'm***@example.org');
    assert.equal(r.json.ziele.discord, '…5678');
    assert.equal(r.json.ziele.totp, undefined);
    assert.ok(!r.text.includes('mf@example.org'), 'die volle Adresse steht nirgends');
    assert.ok(!r.text.includes(DISCORD_ID));
  });

  test('das Protokoll verbucht den ersten Schritt NICHT als erfolgreiche Anmeldung', async () => {
    await login('nur-totp');
    const log = authLog('nur-totp').pop();
    assert.equal(log.erfolg, 0, 'sonst zeigt „letzter Login" jemanden, der nie drin war');
    assert.match(log.methode, /2FA ausstehend/);
  });
});

// ─── 4. Das finale Token ─────────────────────────────────────────────────────
describe('Nach dem richtigen Code: das Sitzungs-Token mit Rolle und Rechten', () => {
  test('TOTP: Token mit Rolle „Nur Quarantäne" — und das Token funktioniert', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    const r = await verify(t, 'totp', totp.code(ids.geheimnisTotp));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.token);
    assert.equal(r.json.username, 'nur-totp');

    const p = nutzlast(r.json.token);
    assert.equal(p.rolle_name, 'Nur Quarantäne');
    assert.equal(p.rolle_id, ids.rolleQ);
    assert.deepEqual(p.rechte, { quarantaene: true });
    assert.equal(p.admin, false);
    assert.deepEqual(p.amr, ['pwd', 'totp']);
    assert.equal(p.aud, tokens.AUD_SITZUNG);

    const g = await geschuetzt(r.json.token);
    assert.equal(g.status, 200);
    assert.equal(g.json.admin, false);
  });

  test('ein Admin bekommt admin: true', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    naechsterSchritt();
    const r = await verify(t, 'totp', totp.code(ids.geheimnisMehr));
    assert.equal(nutzlast(r.json.token).admin, true);
    assert.equal(nutzlast(r.json.token).rolle_name, 'Admin');
  });

  test('das Protokoll verbucht Erfolg mit der Methode', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    naechsterSchritt();
    await verify(t, 'totp', totp.code(ids.geheimnisTotp));
    assert.deepEqual(authLog('nur-totp').pop(), { erfolg: 1, methode: 'passwort+totp' });
  });
});

describe('Ein Ticket gilt genau einmal', () => {
  test('nach der Einlösung ist es verbraucht — auch mit einem weiteren gültigen Code', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    naechsterSchritt();
    assert.equal((await verify(t, 'totp', totp.code(ids.geheimnisTotp))).status, 200);
    naechsterSchritt();
    const zweites = await verify(t, 'totp', totp.code(ids.geheimnisTotp));
    assert.equal(zweites.status, 401);
    assert.equal(zweites.json.code, 'ticket_ungueltig');
  });

  test('zwei gleichzeitige Anfragen mit demselben Ticket: höchstens eine Sitzung', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    naechsterSchritt();
    const c = totp.code(ids.geheimnisTotp);
    const [a, b] = await Promise.all([verify(t, 'totp', c), verify(t, 'totp', c)]);
    assert.equal([a, b].filter((r) => r.status === 200).length, 1);
  });

  test('ein Ticket nach fünf Minuten: abgelaufen', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    zeitVor(301);
    const r = await verify(t, 'totp', totp.code(ids.geheimnisTotp));
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'ticket_ungueltig');
    assert.equal(r.json.token, undefined);
  });

  test('ein Ticket mit abgelaufenem Datensatz (Signatur noch gültig): abgelehnt', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    db.prepare('UPDATE login_tickets SET ablauf = ? WHERE jti = ?').run(Math.floor(Date.now() / 1000) - 1, jtiVon(t));
    naechsterSchritt();
    assert.equal((await verify(t, 'totp', totp.code(ids.geheimnisTotp))).status, 401);
  });

  test('ein erfundenes Ticket, ein Sitzungs-Token oder Müll: 401', async () => {
    const sitzung = (await login('ohne-2fa')).json.token;
    for (const t of ['', 'quatsch', 'a.b.c', sitzung, null, undefined, 12345]) {
      const r = await verify(t, 'totp', '123456');
      assert.equal(r.status, 401, JSON.stringify(t));
      assert.equal(r.json.token, undefined);
    }
  });

  test('ein Ticket mit dem Sitzungsschlüssel signiert: 401', async () => {
    const falsch = jwt.sign({ typ: '2fa-ticket' }, process.env.JWT_SECRET, {
      algorithm: 'HS256', issuer: tokens.ISSUER, audience: tokens.AUD_TICKET,
      subject: String(ids.totp), jwtid: 'erfunden', expiresIn: 300,
    });
    assert.equal((await verify(falsch, 'totp', '123456')).status, 401);
  });

  test('ein echtes Ticket für Benutzer A mit der Kennung eines Tickets von Benutzer B: 401', async () => {
    const fremd = (await login('mehrfach')).json.auth_ticket;
    const gemischt = tokens.ticketSignieren(ids.totp, jtiVon(fremd)); // echte Signatur, falsche Zuordnung
    naechsterSchritt();
    assert.equal((await verify(gemischt, 'totp', totp.code(ids.geheimnisTotp))).status, 401);
  });

  test('ein Ticket ohne Datensatz (etwa nach Löschen der Datenbank): 401', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    db.prepare('DELETE FROM login_tickets WHERE jti = ?').run(jtiVon(t));
    naechsterSchritt();
    assert.equal((await verify(t, 'totp', totp.code(ids.geheimnisTotp))).status, 401);
  });
});

// ─── 3. Brute-Force ──────────────────────────────────────────────────────────
describe('Durchprobieren ist gebremst', () => {
  const falsch = (ticketCode) => String((Number(ticketCode) + 1) % 1000000).padStart(6, '0');

  test('je Ticket fünf Fehlversuche, dann ist es verbrannt — auch für den richtigen Code', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    naechsterSchritt();
    const richtig = totp.code(ids.geheimnisTotp);
    for (let i = 1; i <= 5; i += 1) {
      const r = await verify(t, 'totp', falsch(richtig));
      assert.equal(r.status, 401);
      assert.equal(r.json.verbleibend, 5 - i);
      assert.equal(r.json.code, i < 5 ? 'code_falsch' : 'ticket_ungueltig');
    }
    const danach = await verify(t, 'totp', richtig);
    assert.equal(danach.status, 401, 'der richtige Code hilft einem verbrannten Ticket nicht mehr');
    assert.equal(danach.json.token, undefined);
    // Und die Datenbank sagt dasselbe.
    assert.ok(db.prepare('SELECT verbraucht_am FROM login_tickets WHERE jti = ?').get(jtiVon(t)).verbraucht_am);
  });

  test('fehlgeschlagene Codes landen im Protokoll', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    const vorher = authLog('nur-totp').filter((e) => e.methode === '2fa-totp').length;
    await verify(t, 'totp', '000000');
    assert.equal(authLog('nur-totp').filter((e) => e.methode === '2fa-totp').length, vorher + 1);
  });

  // Mit je einem frischen Ticket fünf neue Versuche — ohne diese Grenze ginge das
  // endlos: Passwort, Ticket, fünf Versuche, wieder von vorn.
  test('je Benutzer: nach zehn falschen Codes ist Schluss, über alle Tickets und Adressen', async () => {
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
    for (let ticketNr = 0; ticketNr < 2; ticketNr += 1) {
      const t = (await login('mehrfach')).json.auth_ticket; // jedes Mal eine andere IP
      for (let i = 0; i < 5; i += 1) await verify(t, 'totp', '000000');
    }
    assert.equal(zweifaktor.nutzerGesperrt(ids.mehr), true);

    const t3 = (await login('mehrfach')).json.auth_ticket;
    naechsterSchritt();
    const r = await verify(t3, 'totp', totp.code(ids.geheimnisMehr));
    assert.equal(r.status, 429, 'selbst der RICHTIGE Code kommt nicht mehr an');
    assert.equal(r.json.code, 'gesperrt');
    assert.equal(r.json.token, undefined);

    // Auch Codes anfordern ist dann gesperrt — niemand soll sich Mails schicken lassen können.
    assert.equal((await senden(t3, 'email')).status, 429);

    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run(); // aufräumen
    assert.equal(zweifaktor.nutzerGesperrt(ids.mehr), false);
  });

  test('die Sperre gilt für diesen Benutzer, nicht für andere', async () => {
    db.prepare("DELETE FROM auth_log WHERE username IN ('mehrfach', 'nur-totp')").run();
    for (let i = 0; i < 10; i += 1) {
      db.prepare("INSERT INTO auth_log (user_id, username, erfolg, methode) VALUES (?, 'mehrfach', 0, '2fa-totp')").run(ids.mehr);
    }
    assert.equal(zweifaktor.nutzerGesperrt(ids.mehr), true);
    assert.equal(zweifaktor.nutzerGesperrt(ids.totp), false);
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
  });

  test('Fehlversuche von vor mehr als 15 Minuten zählen nicht mehr', () => {
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
    for (let i = 0; i < 10; i += 1) {
      db.prepare("INSERT INTO auth_log (user_id, username, erfolg, methode, created_at) VALUES (?, 'mehrfach', 0, '2fa-totp', datetime('now', '-20 minutes'))").run(ids.mehr);
    }
    assert.equal(zweifaktor.nutzerGesperrt(ids.mehr), false);
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
  });

  test('falsche PASSWÖRTER sperren nicht die Code-Eingabe (nur 2FA-Fehlversuche zählen)', () => {
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
    for (let i = 0; i < 12; i += 1) {
      db.prepare("INSERT INTO auth_log (user_id, username, erfolg, methode) VALUES (?, 'mehrfach', 0, 'passwort')").run(ids.mehr);
    }
    assert.equal(zweifaktor.nutzerGesperrt(ids.mehr), false, 'sonst könnte jeder einen Benutzer aussperren, indem er sein Passwort rät');
    db.prepare("DELETE FROM auth_log WHERE username = 'mehrfach'").run();
  });

  test('je Adresse: zehn Anfragen in 15 Minuten, die elfte wird gebremst', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 10; i += 1) assert.equal((await verify('x', 'totp', '123456', ip)).status, 401);
    const r = await verify('x', 'totp', '123456', ip);
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'gebremst');
    // Eine andere Adresse ist davon nicht betroffen.
    assert.equal((await verify('x', 'totp', '123456', '203.0.113.78')).status, 401);
  });

  test('Codes anfordern ist je Adresse gebremst', async () => {
    const ip = '203.0.113.90';
    for (let i = 0; i < 6; i += 1) assert.equal((await senden('x', 'email', ip)).status, 401);
    assert.equal((await senden('x', 'email', ip)).status, 429);
  });
});

describe('Eine Methode, die nicht eingerichtet ist', () => {
  test('wird abgelehnt und als Fehlversuch gezählt', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    const r = await verify(t, 'email', '123456');
    assert.equal(r.status, 401);
    assert.equal(r.json.verbleibend, 4);
  });

  test('ein unbekannter Methodenname: 400', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    for (const m of ['pin', '', 'TOTP', null, undefined, '../x']) {
      assert.equal((await verify(t, m, '123456')).status, 400, JSON.stringify(m));
    }
  });
});

// ─── 2. TOTP: ein Code gilt einmal ───────────────────────────────────────────
describe('TOTP', () => {
  test('derselbe Code lässt sich nicht ein zweites Mal verwenden — auch nicht mit neuem Ticket', async () => {
    naechsterSchritt();
    const code = totp.code(ids.geheimnisTotp);
    const a = (await login('nur-totp')).json.auth_ticket;
    assert.equal((await verify(a, 'totp', code)).status, 200);

    const b = (await login('nur-totp')).json.auth_ticket;
    const r = await verify(b, 'totp', code);
    assert.equal(r.status, 401, 'ein mitgelesener Code gilt nicht noch einmal');
    assert.equal(r.json.code, 'code_falsch');
  });

  test('ein Code mit Leerzeichen ("123 456") wird akzeptiert', async () => {
    naechsterSchritt();
    const c = totp.code(ids.geheimnisTotp);
    const t = (await login('nur-totp')).json.auth_ticket;
    assert.equal((await verify(t, 'totp', `${c.slice(0, 3)} ${c.slice(3)}`)).status, 200);
  });

  test('keine sechs Ziffern: 401, ohne dass etwas abstürzt', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    for (const c of ['', 'abcdef', '12345', '1234567', null, undefined, {}, [], '１２３４５６']) {
      assert.equal((await verify(t, 'totp', c)).status, 401, JSON.stringify(c));
    }
  });

  test('das Geheimnis liegt verschlüsselt in der Datenbank, nicht im Klartext', () => {
    const z = db.prepare("SELECT geheimnis_enc FROM user_2fa WHERE user_id = ? AND methode = 'totp'").get(ids.totp);
    assert.ok(z.geheimnis_enc);
    assert.ok(!z.geheimnis_enc.includes(ids.geheimnisTotp));
    assert.equal(z.geheimnis_enc.split(':').length, 3, 'iv:tag:daten wie bei allen anderen Geheimnissen');
  });
});

// ─── 2. Codes per E-Mail / Discord ───────────────────────────────────────────
describe('Codes per E-Mail', () => {
  test('anfordern, zugestellt an die hinterlegte Adresse, eingeben, angemeldet', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    const s = await senden(t, 'email');
    assert.equal(s.status, 200, s.text);
    assert.ok(s.json.ablauf > Math.floor(Date.now() / 1000));

    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].art, 'email');
    assert.equal(gesendet[0].an, 'mf@example.org');
    const code = letzterCode('email');
    assert.match(code, /^\d{6}$/);
    assert.match(gesendet[0].text, /Der Code gilt 10 Minuten und nur ein einziges Mal/);

    const r = await verify(t, 'email', code);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(nutzlast(r.json.token).amr, ['pwd', 'email']);
    assert.equal((await geschuetzt(r.json.token)).status, 200);
  });

  // Sechs Ziffern sind nur eine Million Möglichkeiten: Ein Klartext oder ein
  // einfacher Hash in der Datenbank wäre sofort umgekehrt.
  test('der Code liegt nie im Klartext in der Datenbank — nur als HMAC', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const code = letzterCode('email');
    const zeile = db.prepare('SELECT * FROM zweifaktor_codes WHERE ticket_jti = ?').get(jtiVon(t));
    assert.match(zeile.code_hash, /^[0-9a-f]{64}$/);
    for (const [spalte, wert] of Object.entries(zeile)) {
      assert.notEqual(String(wert), code, `Spalte ${spalte} enthält den Klartext`);
    }
    const spalten = db.prepare("PRAGMA table_info('zweifaktor_codes')").all().map((c) => c.name);
    assert.ok(!spalten.some((n) => /^(code|klartext)$/i.test(n)));

    // Kein einfacher Hash: SHA-256 des Codes allein ergäbe einen anderen Wert.
    const einfach = require('crypto').createHash('sha256').update(code).digest('hex');
    assert.notEqual(zeile.code_hash, einfach);
    // Und der Hash gilt nur für genau diesen Fall (Benutzer, Ticket, Methode).
    assert.notEqual(zeile.code_hash, zweifaktor.codeHash(ids.mehr, 'anderes-ticket', 'email', code));
    assert.notEqual(zeile.code_hash, zweifaktor.codeHash(ids.mehr, jtiVon(t), 'discord', code));
    assert.notEqual(zeile.code_hash, zweifaktor.codeHash(ids.totp, jtiVon(t), 'email', code));
    assert.equal(zeile.code_hash, zweifaktor.codeHash(ids.mehr, jtiVon(t), 'email', code));
  });

  test('ein Code gilt nur einmal', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const code = letzterCode('email');
    assert.equal((await verify(t, 'email', code)).status, 200);
    // Ein zweites Ticket, derselbe Code: nichts zu holen.
    const t2 = (await login('mehrfach')).json.auth_ticket;
    assert.equal((await verify(t2, 'email', code)).status, 401);
    assert.ok(db.prepare('SELECT verbraucht_am FROM zweifaktor_codes WHERE ticket_jti = ?').get(jtiVon(t)).verbraucht_am);
  });

  test('ein Code gehört zu GENAU einem Ticket', async () => {
    const a = (await login('mehrfach')).json.auth_ticket;
    const b = (await login('mehrfach')).json.auth_ticket;
    await senden(a, 'email');
    const codeA = letzterCode('email');
    await senden(b, 'email');
    const codeB = letzterCode('email');
    if (codeA !== codeB) {
      assert.equal((await verify(b, 'email', codeA)).status, 401, 'der Code von Ticket A gilt nicht für Ticket B');
    }
    assert.equal((await verify(b, 'email', codeB)).status, 200);
  });

  test('ohne angeforderten Code gibt es nichts zu raten', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    assert.equal((await verify(t, 'email', '123456')).status, 401);
  });

  test('ein abgelaufener Code gilt nicht mehr', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const code = letzterCode('email');
    db.prepare('UPDATE zweifaktor_codes SET ablauf = ? WHERE ticket_jti = ?').run(Math.floor(Date.now() / 1000) - 1, jtiVon(t));
    assert.equal((await verify(t, 'email', code)).status, 401);
  });

  test('der Code verfällt spätestens mit dem Ticket', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const z = db.prepare('SELECT c.ablauf AS code, t.ablauf AS ticket FROM zweifaktor_codes c JOIN login_tickets t ON t.jti = c.ticket_jti WHERE c.ticket_jti = ?').get(jtiVon(t));
    assert.ok(z.code <= z.ticket, 'zehn Minuten Code-Laufzeit, aber das Ticket (5 Min.) setzt die Grenze');
  });

  test('erneut anfordern macht den vorigen Code ungültig', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const erster = letzterCode('email');
    await senden(t, 'email');
    const zweiter = letzterCode('email');
    if (erster !== zweiter) assert.equal((await verify(t, 'email', erster)).status, 401);
    assert.equal((await verify(t, 'email', zweiter)).status, 200);
  });

  test('höchstens dreimal anfordern je Ticket', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    for (let i = 0; i < 3; i += 1) assert.equal((await senden(t, 'email')).status, 200);
    const r = await senden(t, 'email');
    assert.equal(r.status, 429);
    assert.match(r.json.error, /dreimal/);
    assert.equal(gesendet.length, 3, 'die vierte Mail wird nicht verschickt');
  });

  test('ein Code pro Code-Versuch: fünf falsche, dann ist auch der gesendete Code tot', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    await senden(t, 'email');
    const code = letzterCode('email');
    const falsch = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await verify(t, 'email', falsch);
    assert.equal((await verify(t, 'email', code)).status, 401);
  });

  test('scheitert die Zustellung: allgemeine Meldung, kein Code bleibt liegen, die Sendung zählt', async () => {
    ausfall.mail = '550 5.7.1 relay denied for internal-host.corp.example (10.0.0.5)';
    const t = (await login('mehrfach')).json.auth_ticket;
    const r = await senden(t, 'email');
    assert.equal(r.status, 502);
    assert.ok(!/relay|internal-host|10\.0\.0\.5|550/.test(r.text), `Einzelheiten dürfen nicht an jemanden, der nur das Passwort kennt: ${r.text}`);
    assert.match(r.json.error, /andere Methode/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zweifaktor_codes WHERE ticket_jti = ?').get(jtiVon(t)).n, 0);
    assert.equal(db.prepare('SELECT sendungen FROM login_tickets WHERE jti = ?').get(jtiVon(t)).sendungen, 1);
  });

  test('für TOTP gibt es nichts zu senden', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    assert.equal((await senden(t, 'totp')).status, 400);
    assert.equal(gesendet.length, 0);
  });

  test('für eine nicht eingerichtete Methode wird nichts gesendet', async () => {
    const t = (await login('nur-totp')).json.auth_ticket;
    assert.equal((await senden(t, 'email')).status, 400);
    assert.equal((await senden(t, 'discord')).status, 400);
    assert.equal(gesendet.length, 0);
  });

  test('mit einem ungültigen Ticket wird nichts gesendet', async () => {
    assert.equal((await senden('quatsch', 'email')).status, 401);
    assert.equal(gesendet.length, 0);
  });
});

describe('Codes per Discord', () => {
  test('der eigene Bot des Benutzers hat Vorrang', async () => {
    const t = (await login('mehrfach')).json.auth_ticket;
    assert.equal((await senden(t, 'discord')).status, 200);
    assert.equal(gesendet[0].art, 'discord');
    assert.equal(gesendet[0].userId, DISCORD_ID);
    assert.equal(gesendet[0].token, EIGENER_BOT);
    const r = await verify(t, 'discord', letzterCode('discord'));
    assert.equal(r.status, 200);
    assert.deepEqual(nutzlast(r.json.token).amr, ['pwd', 'discord']);
  });

  test('ohne eigenen Bot gilt der des Panels', async () => {
    const t = (await login('discord-global')).json.auth_ticket;
    await senden(t, 'discord');
    assert.equal(gesendet[0].token, GLOBALER_BOT);
    assert.equal((await verify(t, 'discord', letzterCode('discord'))).status, 200);
    // Rolle bleibt Rolle.
    const t2 = (await login('discord-global')).json.auth_ticket;
    await senden(t2, 'discord');
    const p = nutzlast((await verify(t2, 'discord', letzterCode('discord'))).json.token);
    assert.equal(p.rolle_name, 'Nur Quarantäne');
  });

  test('der Bot-Token des Benutzers liegt verschlüsselt in der Datenbank', () => {
    const z = db.prepare("SELECT geheimnis_enc FROM user_2fa WHERE user_id = ? AND methode = 'discord'").get(ids.mehr);
    assert.ok(z.geheimnis_enc && !z.geheimnis_enc.includes('EiGeNeR'));
  });

  test('scheitert Discord: allgemeine Meldung', async () => {
    ausfall.discord = 'Discord erlaubt dem Bot keine Direktnachricht an dich — geheimer Servername X';
    const t = (await login('mehrfach')).json.auth_ticket;
    const r = await senden(t, 'discord');
    assert.equal(r.status, 502);
    assert.ok(!/Servername|geheim/.test(r.text));
  });
});

// ─── Einrichten (mit Sitzung) ────────────────────────────────────────────────
describe('Die eigene 2FA einrichten', () => {
  let sitzung;
  let name;
  let uid;
  let n = 0;
  beforeEach(async () => {
    n += 1;
    name = `einrichter-${n}`;
    uid = benutzer(name);
    sitzung = (await login(name)).json.token;
  });

  const api = (methode, pfad, rumpf) => anfrage(methode, `/api/zweifaktor${pfad}`, { rumpf, token: sitzung, ip: frischeIp() });

  test('ohne Anmeldung: 401', async () => {
    assert.equal((await anfrage('GET', '/api/zweifaktor')).status, 401);
    assert.equal((await anfrage('POST', '/api/zweifaktor/totp/start', { rumpf: { passwort: PW } })).status, 401);
  });

  test('der Stand zeigt, was möglich ist — und nie ein Geheimnis', async () => {
    const r = await api('GET', '');
    assert.equal(r.status, 200);
    assert.equal(r.json.methoden.totp.aktiv, false);
    assert.equal(r.json.bevorzugt, null);
    assert.equal(r.json.smtp_bereit, true);
    assert.equal(r.json.discord_global_bereit, true);
  });

  describe('Authenticator-App', () => {
    test('das Passwort wird noch einmal verlangt', async () => {
      assert.equal((await api('POST', '/totp/start', {})).status, 403);
      assert.equal((await api('POST', '/totp/start', { passwort: 'falsch-falsch-falsch' })).status, 403);
      assert.equal((await api('POST', '/totp/start', { passwort: ['x'] })).status, 403);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_2fa WHERE user_id = ?').get(uid).n, 0, 'nichts wurde angelegt');
    });

    test('vollständiger Weg: starten, bestätigen, aktiv — danach verlangt der Login den Code', async () => {
      const start = await api('POST', '/totp/start', { passwort: PW });
      assert.equal(start.status, 200);
      assert.match(start.json.geheimnis, /^[A-Z2-7]{32}$/);
      assert.match(start.json.uri, new RegExp(`^otpauth://totp/Mail-Panel:${name}\\?`));

      // Noch nicht aktiv: Der Login bleibt einstufig, ein Tippfehler sperrt niemanden aus.
      const stand = await api('GET', '');
      assert.equal(stand.json.methoden.totp.aktiv, false);
      assert.equal(stand.json.methoden.totp.ausstehend, true);
      assert.ok((await login(name)).json.token, 'solange nichts bestätigt ist, gilt das Passwort allein');

      assert.equal((await api('POST', '/totp/bestaetigen', { code: '000000' })).status, 400);
      const ok = await api('POST', '/totp/bestaetigen', { code: totp.code(start.json.geheimnis) });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.methoden.totp.aktiv, true);
      assert.equal(ok.json.bevorzugt, 'totp', 'die erste Methode wird gleich vorgewählt');
      assert.ok(!JSON.stringify(ok.json).includes(start.json.geheimnis), 'das Geheimnis kommt nie wieder zurück');

      const danach = await login(name);
      assert.equal(danach.json.zweiFaktor, true);
      assert.equal(danach.json.token, undefined);
    });

    test('der Code der Einrichtung gilt nicht noch einmal als Login-Code', async () => {
      const start = await api('POST', '/totp/start', { passwort: PW });
      const c = totp.code(start.json.geheimnis);
      await api('POST', '/totp/bestaetigen', { code: c });
      const t = (await login(name)).json.auth_ticket;
      assert.equal((await verify(t, 'totp', c)).status, 401, 'derselbe Zeitschritt ist verbraucht');
    });

    test('schon eingerichtet: 409', async () => {
      const start = await api('POST', '/totp/start', { passwort: PW });
      await api('POST', '/totp/bestaetigen', { code: totp.code(start.json.geheimnis) });
      assert.equal((await api('POST', '/totp/start', { passwort: PW })).status, 409);
    });

    test('ein Neustart der Einrichtung ersetzt das unbestätigte Geheimnis', async () => {
      const a = await api('POST', '/totp/start', { passwort: PW });
      const b = await api('POST', '/totp/start', { passwort: PW });
      assert.notEqual(a.json.geheimnis, b.json.geheimnis);
      assert.equal((await api('POST', '/totp/bestaetigen', { code: totp.code(a.json.geheimnis) })).status, 400, 'das alte gilt nicht mehr');
      assert.equal((await api('POST', '/totp/bestaetigen', { code: totp.code(b.json.geheimnis) })).status, 200);
    });

    test('Bestätigen ohne begonnene Einrichtung: 400', async () => {
      assert.equal((await api('POST', '/totp/bestaetigen', { code: '123456' })).status, 400);
    });
  });

  describe('E-Mail', () => {
    test('eine ungültige Adresse: 400, nichts wird gesendet', async () => {
      for (const adresse of ['', 'quatsch', 'a@b', 'a@b.de\r\nBcc: x@y.de', 'a b@c.de', null]) {
        assert.equal((await api('POST', '/email/start', { passwort: PW, adresse })).status, 400, JSON.stringify(adresse));
      }
      assert.equal(gesendet.length, 0);
    });

    test('ohne Postausgang: klare Meldung', async () => {
      settings.setze('smtp_host', '');
      try {
        const r = await api('POST', '/email/start', { passwort: PW, adresse: 'a@example.org' });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /Postausgang/);
      } finally { settings.setze('smtp_host', 'smtp.example.org'); }
    });

    test('vollständiger Weg: Code kommt per Mail, erst die Bestätigung schaltet es scharf', async () => {
      const start = await api('POST', '/email/start', { passwort: PW, adresse: 'neu@example.org' });
      assert.equal(start.status, 200, start.text);
      assert.equal(gesendet[0].an, 'neu@example.org');
      assert.match(gesendet[0].betreff, /Adresse bestätigen/);

      assert.equal((await api('GET', '')).json.methoden.email.aktiv, false);
      assert.ok((await login(name)).json.token, 'unbestätigt: Passwort allein');

      assert.equal((await api('POST', '/email/bestaetigen', { code: '000000' })).status, 400);
      const ok = await api('POST', '/email/bestaetigen', { code: letzterCode('email') });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.methoden.email.aktiv, true);
      assert.equal(ok.json.methoden.email.ziel, 'n***@example.org');

      const l = await login(name);
      assert.deepEqual(l.json.methoden, ['email']);
    });

    test('scheitert das Senden, bleibt nichts Halbes zurück', async () => {
      ausfall.mail = 'boom';
      const r = await api('POST', '/email/start', { passwort: PW, adresse: 'neu@example.org' });
      assert.equal(r.status, 502);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_2fa WHERE user_id = ?').get(uid).n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zweifaktor_codes WHERE user_id = ?').get(uid).n, 0);
    });

    // Sonst ließe sich über die Einrichtung jede beliebige Adresse zuspammen.
    test('nach fünf Codes in 15 Minuten ist Schluss (keine Mail-Bombe an fremde Adressen)', async () => {
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await api('POST', '/email/start', { passwort: PW, adresse: 'opfer@example.org' })).status, 200);
      }
      const r = await api('POST', '/email/start', { passwort: PW, adresse: 'opfer@example.org' });
      assert.equal(r.status, 429);
      assert.equal(gesendet.length, 5);
    });

    test('ein Einrichtungs-Code gilt nicht als Login-Code', async () => {
      await api('POST', '/email/start', { passwort: PW, adresse: 'neu@example.org' });
      const einrichtungsCode = letzterCode('email');
      await api('POST', '/email/bestaetigen', { code: einrichtungsCode });
      const t = (await login(name)).json.auth_ticket;
      assert.equal((await verify(t, 'email', einrichtungsCode)).status, 401);
    });
  });

  describe('Discord', () => {
    test('eine ungültige Benutzer-ID: 400', async () => {
      for (const id of ['', 'abc', '123', '../../x']) {
        assert.equal((await api('POST', '/discord/start', { passwort: PW, user_id: id })).status, 400, id);
      }
    });

    test('ein eigener Bot-Token, der keiner ist: 400', async () => {
      const r = await api('POST', '/discord/start', { passwort: PW, user_id: DISCORD_ID, bot_token: 'kein-token' });
      assert.equal(r.status, 400);
    });

    test('ohne Bot (weder eigener noch des Panels): klare Meldung', async () => {
      settings.setze('discord_bot_token', '');
      try {
        const r = await api('POST', '/discord/start', { passwort: PW, user_id: DISCORD_ID });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /kein Discord-Bot/);
      } finally { settings.setze('discord_bot_token', GLOBALER_BOT); }
    });

    test('vollständiger Weg mit eigenem Bot', async () => {
      const start = await api('POST', '/discord/start', { passwort: PW, user_id: DISCORD_ID, bot_token: EIGENER_BOT });
      assert.equal(start.status, 200, start.text);
      assert.equal(gesendet[0].token, EIGENER_BOT);
      const ok = await api('POST', '/discord/bestaetigen', { code: letzterCode('discord') });
      assert.equal(ok.json.methoden.discord.aktiv, true);
      assert.equal(ok.json.methoden.discord.eigener_bot, true);
      assert.equal(ok.json.methoden.discord.ziel, '…5678');
      assert.ok(!JSON.stringify(ok.json).includes('EiGeNeR'), 'der Token kommt nie zurück');
    });

    test('mit dem Bot des Panels', async () => {
      await api('POST', '/discord/start', { passwort: PW, user_id: DISCORD_ID });
      assert.equal(gesendet[0].token, GLOBALER_BOT);
    });
  });

  describe('Vorgewählte Methode und Abschalten', () => {
    beforeEach(async () => {
      const s = await api('POST', '/totp/start', { passwort: PW });
      await api('POST', '/totp/bestaetigen', { code: totp.code(s.json.geheimnis) });
      await api('POST', '/email/start', { passwort: PW, adresse: 'neu@example.org' });
      await api('POST', '/email/bestaetigen', { code: letzterCode('email') });
    });

    test('die vorgewählte Methode lässt sich umstellen — nur auf eine aktive', async () => {
      assert.equal((await api('PUT', '/bevorzugt', { methode: 'email' })).json.bevorzugt, 'email');
      assert.equal((await login(name)).json.bevorzugt, 'email');
      assert.equal((await api('PUT', '/bevorzugt', { methode: 'discord' })).status, 400);
      assert.equal((await api('PUT', '/bevorzugt', { methode: 'pin' })).status, 400);
      assert.equal((await api('PUT', '/bevorzugt', {})).status, 400);
    });

    test('abschalten verlangt das Passwort', async () => {
      assert.equal((await api('POST', '/email/deaktivieren', {})).status, 403);
      assert.equal((await api('POST', '/email/deaktivieren', { passwort: 'falsch-falsch-falsch' })).status, 403);
      assert.equal((await api('GET', '')).json.methoden.email.aktiv, true);
    });

    test('eine Methode abschalten: die andere bleibt, die Vorwahl rückt nach', async () => {
      await api('PUT', '/bevorzugt', { methode: 'email' });
      const r = await api('POST', '/email/deaktivieren', { passwort: PW });
      assert.equal(r.status, 200);
      assert.equal(r.json.methoden.email.aktiv, false);
      assert.equal(r.json.methoden.totp.aktiv, true);
      assert.equal(r.json.bevorzugt, 'totp');
      assert.deepEqual((await login(name)).json.methoden, ['totp']);
    });

    test('alles abschalten: der Login ist wieder einstufig', async () => {
      await api('POST', '/email/deaktivieren', { passwort: PW });
      const r = await api('POST', '/totp/deaktivieren', { passwort: PW });
      assert.equal(r.json.bevorzugt, null);
      assert.ok((await login(name)).json.token);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zweifaktor_codes WHERE user_id = ?').get(uid).n, 0);
    });

    test('eine unbekannte Methode: 404', async () => {
      assert.equal((await api('POST', '/pin/deaktivieren', { passwort: PW })).status, 404);
      assert.equal((await api('POST', '/pin/bestaetigen', { code: '123456' })).status, 404);
    });
  });

  test('das Passwort wird nicht endlos abgefragt (8 Versuche je Benutzer in 15 Minuten)', async () => {
    for (let i = 0; i < 8; i += 1) assert.equal((await api('POST', '/totp/start', { passwort: 'falsch-falsch-falsch' })).status, 403);
    const r = await api('POST', '/totp/start', { passwort: PW });
    assert.equal(r.status, 429, 'auch das RICHTIGE Passwort kommt dann nicht mehr durch');
  });

  test('jeder ändert nur seine eigene 2FA', async () => {
    await api('POST', '/totp/start', { passwort: PW });
    // Die Routen kennen keine Benutzer-ID im Pfad oder Rumpf — ein fremder Wert wird nicht beachtet.
    const r = await api('POST', '/email/start', { passwort: PW, adresse: 'a@example.org', user_id: ids.totp, userId: ids.totp });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_2fa WHERE user_id = ? AND methode = ?').get(ids.totp, 'email').n, 0);
  });
});

// ─── Notausgang ──────────────────────────────────────────────────────────────
describe('Ein Admin kann die 2FA eines Benutzers zurücksetzen', () => {
  async function adminToken() {
    const t = (await login('ohne-2fa')).json.token;
    assert.ok(t);
    return t;
  }

  test('danach genügt wieder das Passwort — und offene Tickets sind unbrauchbar', async () => {
    const opfer = benutzer('verlorenes-geraet');
    const geheimnis = await totpEinrichten(opfer, 'verlorenes-geraet');
    const offenesTicket = (await login('verlorenes-geraet')).json.auth_ticket;

    const r = await anfrage('PUT', `/api/benutzer/${opfer}`, { rumpf: { zweifaktor_zuruecksetzen: true }, token: await adminToken() });
    assert.equal(r.status, 200);

    assert.equal(zweifaktor.hatZweifaktor(opfer), false);
    assert.equal(db.prepare('SELECT two_factor_preference AS p FROM users WHERE id = ?').get(opfer).p, null);
    const l = await login('verlorenes-geraet');
    assert.ok(l.json.token, 'wieder einstufig');
    naechsterSchritt();
    assert.equal((await verify(offenesTicket, 'totp', totp.code(geheimnis))).status, 401, 'das alte Ticket ist tot');
  });

  test('die Benutzerliste zeigt, wer 2FA hat', async () => {
    const r = await anfrage('GET', '/api/benutzer', { token: await adminToken() });
    const mf = r.json.find((b) => b.username === 'mehrfach');
    assert.deepEqual([...mf.zweifaktor].sort(), ['discord', 'email', 'totp']);
    assert.deepEqual(r.json.find((b) => b.username === 'ohne-2fa').zweifaktor, []);
    assert.ok(!r.text.includes('geheimnis'));
  });

  test('ohne das Recht „benutzer": 403', async () => {
    const t = (await login('discord-global')).json.auth_ticket; // Rolle „Nur Quarantäne"
    await senden(t, 'discord');
    const token = (await verify(t, 'discord', letzterCode('discord'))).json.token;
    const r = await anfrage('PUT', `/api/benutzer/${ids.mehr}`, { rumpf: { zweifaktor_zuruecksetzen: true }, token });
    assert.equal(r.status, 403);
    assert.equal(zweifaktor.hatZweifaktor(ids.mehr), true);
  });

  test('ein gelöschter Benutzer nimmt seine 2FA-Daten mit', async () => {
    const weg = benutzer('wird-geloescht');
    await totpEinrichten(weg, 'wird-geloescht');
    const t = (await login('wird-geloescht')).json.auth_ticket;
    const r = await anfrage('DELETE', `/api/benutzer/${weg}`, { token: await adminToken() });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_2fa WHERE user_id = ?').get(weg).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_tickets WHERE user_id = ?').get(weg).n, 0);
    assert.equal((await verify(t, 'totp', '123456')).status, 401);
  });
});

// ─── Schema ──────────────────────────────────────────────────────────────────
describe('Datenbank', () => {
  test('users hat two_factor_preference', () => {
    assert.ok(db.prepare("PRAGMA table_info('users')").all().some((c) => c.name === 'two_factor_preference'));
  });

  test('die neuen Tabellen sind da', () => {
    for (const t of ['user_2fa', 'login_tickets', 'zweifaktor_codes']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    }
  });

  test('es gibt nur drei Methoden', () => {
    assert.throws(() => db.prepare("INSERT INTO user_2fa (user_id, methode) VALUES (?, 'pin')").run(ids.ohne), /CHECK/);
  });
});
