// Die Zustellwege für Einmalcodes: Mail über den Postausgang des Panels und
// Direktnachricht über einen Discord-Bot.
//
// Beide verschicken etwas, das ein Fremder beeinflussen könnte (Zieladresse, Betreff),
// und beide schicken Zugangsdaten durch die Leitung. Deshalb hier gegen einen echten
// Fake-SMTP-Server und eine nachgebaute Discord-API geprüft, nicht gegen Annahmen.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
require('./umgebung');

const smtp = require('../src/services/smtp');
const discord = require('../src/services/discord');

// ─── Ein kleiner SMTP-Server ─────────────────────────────────────────────────

/**
 * Antwortet wie ein Postausgang ohne STARTTLS. Hält fest, was ankam.
 * @param {object} [o]
 * @param {number} [o.rcpt] Antwortcode auf RCPT TO (550 = Empfänger abgelehnt)
 * @param {boolean} [o.auth] AUTH LOGIN verlangen
 */
function fakeSmtp({ rcpt = 250, auth = false } = {}) {
  const protokoll = [];
  const mails = [];
  let anmeldeSchritt = 0;
  let anmeldung = {};

  const server = net.createServer((socket) => {
    let datenModus = false;
    let datenPuffer = '';
    const zeile = (t) => socket.write(`${t}\r\n`);
    zeile('220 fake.example ESMTP');
    let rest = '';

    socket.on('data', (teil) => {
      rest += teil.toString('utf8');
      // Befehle sind zeilenweise, der DATA-Teil bis zur Zeile "."
      let ende;
      while ((ende = rest.indexOf('\r\n')) >= 0) {
        const z = rest.slice(0, ende);
        rest = rest.slice(ende + 2);
        if (datenModus) {
          if (z === '.') {
            datenModus = false;
            mails.push(datenPuffer);
            datenPuffer = '';
            zeile('250 2.0.0 queued');
          } else {
            datenPuffer += `${z.startsWith('..') ? z.slice(1) : z}\r\n`;
          }
          continue;
        }
        protokoll.push(z);
        if (anmeldeSchritt === 1) { anmeldung.user = Buffer.from(z, 'base64').toString(); anmeldeSchritt = 2; zeile('334 UGFzc3dvcmQ6'); continue; }
        if (anmeldeSchritt === 2) {
          anmeldung.passwort = Buffer.from(z, 'base64').toString();
          anmeldeSchritt = 0;
          zeile(anmeldung.passwort === 'richtig' ? '235 2.7.0 ok' : '535 5.7.8 falsch');
          continue;
        }
        if (/^EHLO/i.test(z)) zeile(auth ? '250-fake.example\r\n250 AUTH LOGIN' : '250 fake.example');
        else if (/^AUTH LOGIN/i.test(z)) { anmeldeSchritt = 1; zeile('334 VXNlcm5hbWU6'); }
        else if (/^MAIL FROM/i.test(z)) zeile('250 ok');
        else if (/^RCPT TO/i.test(z)) zeile(rcpt === 250 ? '250 ok' : `${rcpt} 5.1.1 nein`);
        else if (/^DATA/i.test(z)) { datenModus = true; zeile('354 los'); }
        else if (/^QUIT/i.test(z)) { zeile('221 tschuess'); socket.end(); }
        else zeile('500 ?');
      }
    });
    socket.on('error', () => { /* Client hat aufgelegt */ });
  });

  return new Promise((fertig) => server.listen(0, '127.0.0.1', () => fertig({
    port: server.address().port, protokoll, mails, anmeldung: () => anmeldung, schliessen: () => server.close(),
  })));
}

const kopfZeilen = (mail) => Object.fromEntries(
  mail.split('\r\n\r\n')[0].split('\r\n').map((z) => [z.slice(0, z.indexOf(':')), z.slice(z.indexOf(':') + 2)]),
);
const rumpf = (mail) => Buffer.from(mail.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('smtp.mailSenden', () => {
  let s;
  afterEach(() => s?.schliessen());

  const senden = (extra = {}) => smtp.mailSenden({
    host: '127.0.0.1', port: s.port, absender: 'panel@example.org', an: 'robin@example.org',
    betreff: 'Dein Code', text: 'Dein Code: 123456', ...extra,
  });

  test('eine Mail geht hinaus: Umschlag, Köpfe und Text stimmen', async () => {
    s = await fakeSmtp();
    const r = await senden({ text: 'Dein Code: 482913\n\nGilt zehn Minuten.' });
    assert.equal(r.ok, true);

    assert.ok(s.protokoll.includes('MAIL FROM:<panel@example.org>'));
    assert.ok(s.protokoll.includes('RCPT TO:<robin@example.org>'));
    assert.equal(s.mails.length, 1);

    const k = kopfZeilen(s.mails[0]);
    assert.equal(k.From, '<panel@example.org>');
    assert.equal(k.To, '<robin@example.org>');
    assert.match(k['Content-Type'], /text\/plain; charset=utf-8/);
    assert.equal(k['Content-Transfer-Encoding'], 'base64');
    assert.match(k['Message-ID'], /^<[0-9a-f]{24}@example\.org>$/);
    assert.equal(k['Auto-Submitted'], 'auto-generated');
    assert.equal(rumpf(s.mails[0]), 'Dein Code: 482913\n\nGilt zehn Minuten.');
  });

  test('Umlaute im Betreff kommen als RFC-2047-Codewort an', async () => {
    s = await fakeSmtp();
    await senden({ betreff: 'Dein Anmeldecode für das Mail-Panel' });
    const wert = kopfZeilen(s.mails[0]).Subject;
    assert.match(wert, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.equal(Buffer.from(wert.slice(10, -2), 'base64').toString(), 'Dein Anmeldecode für das Mail-Panel');
  });

  // Header-Injection: Ein Zeilenumbruch im Betreff oder in der Adresse schleuste
  // sonst weitere Kopfzeilen (Bcc!) oder SMTP-Befehle ein.
  describe('Einschleusen weiterer Kopfzeilen und Befehle', () => {
    const ANGRIFFE = [
      'robin@example.org\r\nBcc: boese@example.org',
      'robin@example.org\nRCPT TO:<boese@example.org>',
      'robin@example.org>\r\nRCPT TO:<boese@example.org',
      'a@b.example, c@d.example',
      'a@b.example;c@d.example',
      '<robin@example.org>',
      '"robin"@example.org',
      'robin@example',
      'robin @example.org',
      'robin@example.org\u0000',
      '',
      null,
    ];
    for (const adresse of ANGRIFFE) {
      test(`Empfänger ${JSON.stringify(adresse)} wird abgewiesen — ohne Verbindung`, async () => {
        s = await fakeSmtp();
        await assert.rejects(() => senden({ an: adresse }), /Empfängeradresse ist ungültig/);
        assert.equal(s.protokoll.length, 0, 'es darf nicht einmal eine Verbindung entstehen');
      });
    }

    test('ein Absender mit Zeilenumbruch wird nicht benutzt', async () => {
      s = await fakeSmtp();
      await assert.rejects(
        () => senden({ absender: 'panel@example.org\r\nBcc: x@y.example', user: undefined }),
        /Kein Absender/,
      );
      assert.equal(s.protokoll.length, 0);
    });

    test('ein Zeilenumbruch im Betreff bleibt in EINER Kopfzeile', async () => {
      s = await fakeSmtp();
      await senden({ betreff: 'Hallo\r\nBcc: boese@example.org\r\n\r\nLos' });
      const kopf = s.mails[0].split('\r\n\r\n')[0];
      assert.ok(!/^Bcc:/mi.test(kopf), 'keine eingeschleuste Kopfzeile');
      assert.equal(kopf.split('\r\n').filter((z) => z.startsWith('Subject:')).length, 1);
    });

    test('ein Text, der wie das Ende der Daten aussieht, beendet sie nicht', async () => {
      s = await fakeSmtp();
      await senden({ text: 'vorher\r\n.\r\nQUIT\r\nRCPT TO:<boese@example.org>\r\n.\r\nnachher' });
      assert.equal(s.mails.length, 1);
      assert.equal(rumpf(s.mails[0]), 'vorher\r\n.\r\nQUIT\r\nRCPT TO:<boese@example.org>\r\n.\r\nnachher');
      assert.ok(!s.protokoll.some((z) => /boese/.test(z)), 'als Befehl kam nichts davon an');
    });
  });

  test('ohne Absender und ohne Adresse als Benutzer: klare Meldung', async () => {
    s = await fakeSmtp();
    await assert.rejects(() => senden({ absender: '' }), /Kein Absender/);
  });

  test('ein Benutzername in Adressform dient als Absender', async () => {
    s = await fakeSmtp({ auth: true });
    await senden({ absender: '', user: 'panel@example.org', passwort: 'richtig' });
    assert.ok(s.protokoll.includes('MAIL FROM:<panel@example.org>'));
  });

  test('mit Anmeldung: Benutzer und Passwort gehen per AUTH LOGIN hinaus', async () => {
    s = await fakeSmtp({ auth: true });
    await senden({ user: 'panel@example.org', passwort: 'richtig' });
    assert.deepEqual(s.anmeldung(), { user: 'panel@example.org', passwort: 'richtig' });
    assert.equal(s.mails.length, 1);
  });

  test('ein falsches Passwort: Fehler, und es wird nichts gesendet', async () => {
    s = await fakeSmtp({ auth: true });
    await assert.rejects(() => senden({ user: 'panel@example.org', passwort: 'falsch' }), /Anmeldung fehlgeschlagen/);
    assert.equal(s.mails.length, 0);
  });

  test('ein abgelehnter Empfänger wird gemeldet', async () => {
    s = await fakeSmtp({ rcpt: 550 });
    await assert.rejects(() => senden(), /Empfänger abgelehnt/);
    assert.equal(s.mails.length, 0);
  });

  test('kein Server eingetragen: klare Meldung', async () => {
    await assert.rejects(() => smtp.mailSenden({ host: '', an: 'a@b.example', absender: 'x@y.example', betreff: 'x', text: 'x' }), /Kein SMTP-Server/);
  });

  test('der Server antwortet nicht: Fehler statt ewigem Warten', async () => {
    const tot = net.createServer(() => { /* nimmt an, sagt nichts */ });
    await new Promise((f) => tot.listen(0, '127.0.0.1', f));
    try {
      const t0 = Date.now();
      await assert.rejects(() => smtp.mailSenden({
        host: '127.0.0.1', port: tot.address().port, absender: 'p@e.org', an: 'r@e.org', betreff: 'x', text: 'x',
      }), /Zeitüberschreitung/);
      assert.ok(Date.now() - t0 < 20000);
    } finally { tot.close(); }
  });
});

describe('smtp.testVerbindung (wie vor dem Umbau)', () => {
  let s;
  afterEach(() => s?.schliessen());

  test('ohne Benutzer: verbunden, keine Anmeldung', async () => {
    s = await fakeSmtp();
    const r = await smtp.testVerbindung({ host: '127.0.0.1', port: s.port });
    assert.equal(r.ok, true);
    assert.match(r.hinweis, /ohne Benutzernamen/);
  });

  test('mit Benutzer: verbunden und angemeldet', async () => {
    s = await fakeSmtp({ auth: true });
    const r = await smtp.testVerbindung({ host: '127.0.0.1', port: s.port, user: 'a', passwort: 'richtig' });
    assert.equal(r.hinweis, 'Verbunden und angemeldet.');
  });

  test('falsches Passwort wird gemeldet', async () => {
    s = await fakeSmtp({ auth: true });
    await assert.rejects(() => smtp.testVerbindung({ host: '127.0.0.1', port: s.port, user: 'a', passwort: 'x' }), /Anmeldung fehlgeschlagen/);
  });

  test('kein Server: klare Meldung', async () => {
    await assert.rejects(() => smtp.testVerbindung({ host: '' }), /Kein SMTP-Server/);
  });
});

describe('smtp.istAdresse', () => {
  test('gewöhnliche Adressen gehen durch', () => {
    for (const a of ['a@b.de', 'robin.x+tag@mail.example.org', 'a_b-c@sub.domain.example', 'x%y@a-b.example.org']) assert.equal(smtp.istAdresse(a), true, a);
  });
  test('alles andere nicht', () => {
    for (const a of ['', 'a', 'a@b', '@b.de', 'a@@b.de', 'a b@c.de', `${'x'.repeat(250)}@b.de`, 5, null, undefined,
      'a\u0000@b.de', 'a@b.de\u0000', 'a@b.dé', 'ä@b.de', 'a@b..de', "a'b@c.de", 'a|b@c.de', 'a`b@c.de']) {
      assert.equal(smtp.istAdresse(a), false, String(a));
    }
  });
});

// ─── Discord ─────────────────────────────────────────────────────────────────

const echtesFetch = global.fetch;
const ID = '123456789012345678';
const TOKEN = 'TESTBOT-FUER-TESTS-0000000.GAbCdE.testbot-nur-fuer-tests-0000000000';

/** Eine nachgebaute Discord-API: antwortet nach Vorgabe und hält die Aufrufe fest. */
function fakeDiscord(antworten = {}) {
  const aufrufe = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    aufrufe.push({ url: u, methode: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const schluessel = u.endsWith('/users/@me/channels') ? 'kanal' : 'nachricht';
    const a = antworten[schluessel] || (schluessel === 'kanal' ? { status: 200, json: { id: '999000111' } } : { status: 200, json: { id: '5' } });
    return { ok: a.status < 400, status: a.status, json: async () => a.json };
  };
  return aufrufe;
}

describe('discord.dmSenden', () => {
  beforeEach(() => { delete process.env.DISCORD_API_BASE; });
  afterEach(() => { global.fetch = echtesFetch; });

  test('erst den Direktnachrichten-Kanal öffnen, dann dort senden', async () => {
    const a = fakeDiscord();
    const r = await discord.dmSenden({ token: TOKEN, userId: ID, text: 'Dein Code: 482913' });
    assert.equal(r.ok, true);
    assert.equal(a.length, 2);
    assert.equal(a[0].url, 'https://discord.com/api/v10/users/@me/channels');
    assert.deepEqual(a[0].body, { recipient_id: ID });
    assert.equal(a[1].url, 'https://discord.com/api/v10/channels/999000111/messages');
    assert.equal(a[1].body.content, 'Dein Code: 482913');
  });

  test('der Bot-Token geht als „Bot …" — und nur an Discord', async () => {
    const a = fakeDiscord();
    await discord.dmSenden({ token: `  ${TOKEN}  `, userId: ID, text: 'x' });
    for (const aufruf of a) {
      assert.equal(aufruf.headers.Authorization, `Bot ${TOKEN}`, 'ohne umgebende Leerzeichen');
      assert.match(aufruf.url, /^https:\/\/discord\.com\//);
    }
  });

  test('der Text löst keine Erwähnungen aus', async () => {
    const a = fakeDiscord();
    await discord.dmSenden({ token: TOKEN, userId: ID, text: '@everyone <@&123> ping' });
    assert.deepEqual(a[1].body.allowed_mentions, { parse: [] });
  });

  test('die Länge ist gedeckelt (Discord erlaubt 2000 Zeichen)', async () => {
    const a = fakeDiscord();
    await discord.dmSenden({ token: TOKEN, userId: ID, text: 'x'.repeat(5000) });
    assert.ok(a[1].body.content.length <= 1900);
  });

  test('ungültige Benutzer-IDs gehen gar nicht erst raus', async () => {
    const a = fakeDiscord();
    for (const id of ['', 'abc', '123', '12345678901234567x', '../../x', '1 2', null, undefined, '1'.repeat(30)]) {
      await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: id, text: 'x' }), /Benutzer-ID/, String(id));
    }
    assert.equal(a.length, 0);
  });

  test('ohne Token: klare Meldung, kein Aufruf', async () => {
    const a = fakeDiscord();
    await assert.rejects(() => discord.dmSenden({ token: '', userId: ID, text: 'x' }), /Kein Discord-Bot/);
    assert.equal(a.length, 0);
  });

  test('401: der Token wird abgelehnt', async () => {
    fakeDiscord({ kanal: { status: 401, json: { message: '401: Unauthorized' } } });
    await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }), /Bot-Token ab/);
  });

  test('50007: der Bot darf dem Benutzer nicht schreiben — mit Hinweis, was zu tun ist', async () => {
    fakeDiscord({ nachricht: { status: 403, json: { code: 50007, message: 'Cannot send messages to this user' } } });
    await assert.rejects(
      () => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }),
      /Server teilen.*Direktnachrichten/s,
    );
  });

  test('404: unbekannte Benutzer-ID', async () => {
    fakeDiscord({ kanal: { status: 404, json: { code: 10013 } } });
    await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }), /kennt diese Benutzer-ID nicht/);
  });

  test('429: Discord bremst', async () => {
    fakeDiscord({ kanal: { status: 429, json: {} } });
    await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }), /bremst/);
  });

  test('Discord nicht erreichbar: Fehler mit Ursache', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }), /nicht erreichbar: ECONNREFUSED/);
  });

  test('eine Kanal-ID, die keine Zahl ist, wird nicht in die Adresse eingesetzt', async () => {
    const a = fakeDiscord({ kanal: { status: 200, json: { id: '../../guilds/1' } } });
    await assert.rejects(() => discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' }), /keinen Kanal/);
    assert.equal(a.length, 1, 'die zweite Anfrage geht nicht an einen manipulierten Pfad');
  });

  test('DISCORD_API_BASE lenkt um (für Tests und Proxys)', async () => {
    process.env.DISCORD_API_BASE = 'http://127.0.0.1:9/api/';
    const a = fakeDiscord();
    await discord.dmSenden({ token: TOKEN, userId: ID, text: 'x' });
    assert.ok(a[0].url.startsWith('http://127.0.0.1:9/api/users/'));
  });

  test('istBenutzerId und sieheAusWieToken', () => {
    assert.equal(discord.istBenutzerId(ID), true);
    assert.equal(discord.istBenutzerId('12345'), false);
    assert.equal(discord.sieheAusWieToken(TOKEN), true);
    assert.equal(discord.sieheAusWieToken('einfach-ein-text'), false);
    assert.equal(discord.sieheAusWieToken(''), false);
  });
});
