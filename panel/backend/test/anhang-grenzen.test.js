// Harte Grenzen für Anhänge: höchstens 20 je Mail, höchstens 30 MB je Datei.
//
// Die Lücke, die hier festgehalten ist: Bis Build 252 holte das Panel höchstens 20
// Anhänge und schnitt den Rest STILLSCHWEIGEND ab. Eine Mail mit 21 Dateien, deren
// letzte schädlich war, kam durch den Virenscan als „sauber" — geprüft waren nur 20,
// und nirgends stand, dass etwas fehlte. Eine Grenze, die nur kürzt, ist keine.
//
// Jetzt bricht die Verarbeitung der ganzen Mail ab, BEVOR etwas heruntergeladen
// wird, und der Virenscan meldet „nicht sauber" (→ Quarantäne).
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Readable } = require('stream');
require('./umgebung');

process.env.PANEL_SECRET = 'geheimnis-fuer-tests-0123456789abcdef';
process.env.PANEL_DB_KEY = 'schluessel-fuer-tests-0123456789abcdef';
process.env.JWT_SECRET = 'jwt-geheimnis-fuer-tests-0123456789abcdef';

// imapflow abfangen, BEVOR services/imap.js es lädt.
const imapflowPfad = require.resolve('imapflow');
let client = null;
let mail = null; // { teile: [{name, groesse, encoding, inhalt|stuecke|fehler}] }

const MB = 1024 * 1024;

class FakeImapFlow {
  constructor() { this.downloads = []; client = this; }
  async connect() { /* nichts */ }
  async logout() { /* nichts */ }
  async getMailboxLock() { return { release() { /* nichts */ } }; }
  async fetchOne() {
    if (!mail) return false;
    return {
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain' },
          ...mail.teile.map((t, i) => ({
            part: String(i + 2),
            type: 'application/octet-stream',
            disposition: 'attachment',
            dispositionParameters: { filename: t.name },
            size: t.groesse ?? (t.inhalt ? t.inhalt.length : 100),
            encoding: t.encoding || '7bit',
          })),
        ],
      },
    };
  }
  async download(uid, part) {
    this.downloads.push(part);
    const t = mail.teile[Number(part) - 2];
    if (t.fehler) throw new Error(t.fehler);
    return { content: Readable.from(t.stuecke || [t.inhalt]) };
  }
}

require.cache[imapflowPfad] = {
  id: imapflowPfad, filename: imapflowPfad, loaded: true, exports: { ImapFlow: FakeImapFlow },
};

const express = require('express');
const db = require('../src/db');
const settings = require('../src/services/settings');
const imap = require('../src/services/imap');
const clamav = require('../src/services/clamav');
const grenzen = require('../src/services/anhangGrenzen');
const uploadFreigabe = require('../src/services/uploadFreigabe');
const { verschluesseln } = require('../src/services/crypto');

const konto = { host: 'h', port: 993, username: 'u', passwort: 'p' };
const dateien = (n, vorlage = {}) => Array.from({ length: n }, (_, i) => ({
  name: `datei-${i + 1}.pdf`, inhalt: Buffer.from(`inhalt ${i + 1}`), ...vorlage,
}));

beforeEach(() => { client = null; mail = { teile: [] }; });

describe('grenzverstoss (reine Prüfung)', () => {
  const teile = (n, groesse = 1000, encoding = '7bit') =>
    Array.from({ length: n }, (_, i) => ({ name: `f${i}`, groesse, encoding }));

  test('genau 20 Anhänge sind in Ordnung', () => {
    assert.equal(grenzen.grenzverstoss(teile(20)), null);
  });

  test('21 Anhänge sind ein Verstoß — und die Zahl stimmt', () => {
    const v = grenzen.grenzverstoss(teile(21));
    assert.equal(v.grund, 'zu_viele_anhaenge');
    assert.equal(v.gefunden, 21);
    assert.match(v.text, /21 Anhänge/);
    assert.match(v.text, /höchstens 20/);
  });

  test('keine Anhänge sind in Ordnung', () => {
    assert.equal(grenzen.grenzverstoss([]), null);
    assert.equal(grenzen.grenzverstoss(undefined), null);
  });

  test('genau 30 MB sind in Ordnung, ein Byte mehr nicht', () => {
    assert.equal(grenzen.grenzverstoss(teile(1, 30 * MB)), null);
    const v = grenzen.grenzverstoss(teile(1, 30 * MB + 1));
    assert.equal(v.grund, 'datei_zu_gross');
    assert.match(v.text, /30 MB/);
  });

  // base64 macht aus 30 MB gut 40 MB. Ohne Umrechnung würde eine 25-MB-Datei als
  // 33 MB gelten und zu Unrecht abgewiesen.
  test('bei base64 zählt die entpackte Größe', () => {
    assert.equal(grenzen.grenzverstoss(teile(1, 40 * MB, 'base64')), null, '40 MB base64 = 30 MB Inhalt');
    assert.equal(grenzen.grenzverstoss(teile(1, 33 * MB, 'BASE64')), null, 'Schreibweise egal');
    assert.equal(grenzen.grenzverstoss(teile(1, 42 * MB, 'base64')).grund, 'datei_zu_gross');
  });

  test('eine große Datei unter vielen kleinen wird gefunden', () => {
    const liste = [...teile(5), { name: 'gross.zip', groesse: 31 * MB, encoding: '7bit' }, ...teile(5)];
    const v = grenzen.grenzverstoss(liste);
    assert.equal(v.grund, 'datei_zu_gross');
    assert.equal(v.name, 'gross.zip');
  });

  test('zu viele Anhänge schlagen die Größe: die Anzahl wird zuerst gemeldet', () => {
    assert.equal(grenzen.grenzverstoss(teile(25, 31 * MB)).grund, 'zu_viele_anhaenge');
  });
});

describe('base64Groesse', () => {
  test('zählt Bytes, ohne zu dekodieren', () => {
    assert.equal(grenzen.base64Groesse(''), 0);
    assert.equal(grenzen.base64Groesse(null), 0);
    assert.equal(grenzen.base64Groesse(Buffer.from('abc').toString('base64')), 3);
    assert.equal(grenzen.base64Groesse(Buffer.from('ab').toString('base64')), 2);
    assert.equal(grenzen.base64Groesse(Buffer.from('a').toString('base64')), 1);
    assert.equal(grenzen.base64Groesse(Buffer.alloc(1000).toString('base64')), 1000);
  });

  test('base64ZuGross: Grenze bei 30 MB', () => {
    assert.equal(grenzen.base64ZuGross(Buffer.alloc(1000).toString('base64')), false);
    assert.equal(grenzen.base64ZuGross('A'.repeat(41 * MB)), true, '41 Millionen Zeichen ≈ 30,75 MB');
    assert.equal(grenzen.base64ZuGross('A'.repeat(39 * MB)), false);
  });
});

describe('transportSammler: höchstens 60 MB zusammen an n8n', () => {
  test('alles unter der Grenze geht mit Inhalt durch', () => {
    const s = grenzen.transportSammler(100);
    s.aufnehmen({ name: 'a', inhalt: Buffer.alloc(40) });
    s.aufnehmen({ name: 'b', inhalt: Buffer.alloc(60) });
    assert.equal(s.raus.length, 2);
    assert.ok(s.raus.every((r) => r.base64));
  });

  test('was darüber läge, kommt ohne Inhalt zurück — mit Namen und Größe', () => {
    const s = grenzen.transportSammler(100);
    s.aufnehmen({ name: 'a', inhalt: Buffer.alloc(70) });
    s.aufnehmen({ name: 'b', inhalt: Buffer.alloc(40) });
    s.aufnehmen({ name: 'c', inhalt: Buffer.alloc(30) });
    assert.ok(s.raus[0].base64);
    assert.deepEqual(s.raus[1], { name: 'b', groesse: 40, fehler: 'zusammen zu groß' });
    assert.ok(s.raus[2].base64, 'was noch hineinpasst, darf mit');
  });

  test('Fehler und leere Anhänge werden benannt', () => {
    const s = grenzen.transportSammler();
    s.aufnehmen({ name: 'x', fehler: 'kaputt' });
    s.aufnehmen({ name: 'y' });
    assert.deepEqual(s.raus, [{ name: 'x', fehler: 'kaputt' }, { name: 'y', fehler: 'kein Inhalt' }]);
  });

  test('die Standardgrenze sind 60 MB', () => {
    assert.equal(grenzen.MAX_TRANSPORT, 60 * MB);
  });
});

describe('imap.anhaengeHolen', () => {
  test('20 Anhänge werden alle geholt', async () => {
    mail.teile = dateien(20);
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.gefunden, 20);
    assert.equal(r.anhaenge.length, 20);
    assert.equal(r.abgebrochen, undefined);
    assert.equal(r.anhaenge[19].inhalt.toString(), 'inhalt 20');
  });

  test('21 Anhänge: nichts wird geholt, die echte Zahl wird gemeldet', async () => {
    mail.teile = dateien(21);
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.abgebrochen.grund, 'zu_viele_anhaenge');
    assert.equal(r.gefunden, 21, 'früher stand hier 20 — der 21. blieb unsichtbar');
    assert.deepEqual(r.anhaenge, []);
    assert.equal(client.downloads.length, 0, 'nicht ein Byte wird heruntergeladen');
  });

  test('100 Anhänge werden als 100 gemeldet, nicht als 20', async () => {
    mail.teile = dateien(100);
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.gefunden, 100);
    assert.equal(client.downloads.length, 0);
  });

  test('eine Datei über 30 MB (laut Mailstruktur): Abbruch ohne Download', async () => {
    mail.teile = [...dateien(2), { name: 'riesig.zip', groesse: 31 * MB, inhalt: Buffer.alloc(1) }];
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.abgebrochen.grund, 'datei_zu_gross');
    assert.equal(r.abgebrochen.name, 'riesig.zip');
    assert.deepEqual(r.anhaenge, []);
    assert.equal(client.downloads.length, 0, 'auch die kleinen davor werden nicht geholt');
  });

  // Die Mailstruktur kann sich bei der Größe irren, der Strom nicht.
  test('lügt die Mailstruktur bei der Größe, greift die Grenze beim Lesen', async () => {
    const achtMB = () => Buffer.alloc(8 * MB);
    mail.teile = [
      ...dateien(1),
      { name: 'luege.bin', groesse: 1000, stuecke: [achtMB(), achtMB(), achtMB(), achtMB()] }, // 32 MB
    ];
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.abgebrochen.grund, 'datei_zu_gross');
    assert.deepEqual(r.anhaenge, [], 'schon Geholtes wird verworfen — die Mail gilt als Ganzes als abgebrochen');
  });

  test('nurStruktur zählt und prüft, lädt aber nichts', async () => {
    mail.teile = dateien(5);
    const r = await imap.anhaengeHolen({ ...konto, uid: 1, nurStruktur: true });
    assert.equal(r.gefunden, 5);
    assert.equal(client.downloads.length, 0);
    mail.teile = dateien(21);
    assert.equal((await imap.anhaengeHolen({ ...konto, uid: 1, nurStruktur: true })).abgebrochen.grund, 'zu_viele_anhaenge');
  });

  test('beiAnhang: jede Datei einzeln, nichts wird gesammelt', async () => {
    mail.teile = dateien(3);
    const gesehen = [];
    const r = await imap.anhaengeHolen({
      ...konto, uid: 1, beiAnhang: async (a) => { gesehen.push(a.name); },
    });
    assert.deepEqual(gesehen, ['datei-1.pdf', 'datei-2.pdf', 'datei-3.pdf']);
    assert.deepEqual(r.anhaenge, []);
    assert.equal(r.gefunden, 3);
  });

  test('ein Fehler bei EINER Datei ist kein Verstoß: die anderen kommen durch', async () => {
    mail.teile = [...dateien(1), { name: 'kaputt.pdf', fehler: 'Verbindung weg' }, ...dateien(1)];
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.equal(r.abgebrochen, undefined);
    assert.equal(r.anhaenge.length, 3);
    assert.equal(r.anhaenge[1].fehler, 'Verbindung weg');
  });

  test('eine Mail ohne Anhänge', async () => {
    const r = await imap.anhaengeHolen({ ...konto, uid: 1 });
    assert.deepEqual(r, { gefunden: 0, anhaenge: [] });
  });

  test('eine ungültige UID wird abgewiesen', async () => {
    await assert.rejects(() => imap.anhaengeHolen({ ...konto, uid: 'x' }), /Ungültige UID/);
  });
});

// ─── Die Endpunkte, so wie n8n sie aufruft ───────────────────────────────────

const server = [];
after(() => server.forEach((s) => { try { s.close(); } catch { /* egal */ } }));

function starten() {
  const app = express();
  app.use('/api/internal', require('../src/routes/anhaenge'));
  return new Promise((fertig) => {
    const s = app.listen(0, () => fertig(s.address().port));
    server.push(s);
  });
}

function anfrage(port, pfad, { rumpf, roh, kopf = {} } = {}) {
  return new Promise((fertig, schief) => {
    const daten = roh !== undefined ? roh : JSON.stringify(rumpf ?? {});
    const k = {
      'X-Panel-Secret': process.env.PANEL_SECRET,
      'Content-Type': roh !== undefined ? 'application/octet-stream' : 'application/json',
      'Content-Length': Buffer.byteLength(daten),
      ...kopf,
    };
    const a = http.request({ host: '127.0.0.1', port, path: pfad, method: 'POST', headers: k }, (r) => {
      const stuecke = [];
      r.on('data', (d) => stuecke.push(d));
      r.on('end', () => {
        const text = Buffer.concat(stuecke).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* kein JSON */ }
        fertig({ status: r.statusCode, json, text });
      });
    });
    a.on('error', schief);
    a.write(daten);
    a.end();
  });
}

describe('POST /api/internal/scan-anhaenge', () => {
  let port;
  let scans;
  const echtesScan = clamav.scan;

  beforeEach(async () => {
    port ??= await starten();
    db.prepare("DELETE FROM accounts WHERE name = 'Testkonto'").run();
    db.prepare('INSERT INTO accounts (name, host, port, username, password_enc) VALUES (?, ?, ?, ?, ?)')
      .run('Testkonto', 'imap.example', 993, 'u', verschluesseln('pw'));
    settings.setze('clamav_aktiv', '1');
    scans = [];
    clamav.scan = async (puffer) => {
      scans.push(puffer.toString());
      return puffer.toString().includes('EICAR') ? { clean: false, virus: 'Eicar-Test' } : { clean: true };
    };
  });
  after(() => { clamav.scan = echtesScan; });

  const rufen = (extra = {}) => anfrage(port, '/api/internal/scan-anhaenge', {
    rumpf: { konto: 'Testkonto', uid: 7, ordner: 'INBOX', ...extra },
  });

  test('saubere Mail: alle Anhänge geprüft, clean', async () => {
    mail.teile = dateien(3);
    const r = await rufen();
    assert.equal(r.status, 200);
    assert.equal(r.json.clean, true);
    assert.equal(r.json.gefunden, 3);
    assert.equal(r.json.geprueft, 3);
    assert.equal(r.json.ungeprueft, 0);
    assert.equal(scans.length, 3);
  });

  test('ein Fund: nicht sauber, mit Virusname', async () => {
    mail.teile = [...dateien(1), { name: 'x.pdf', inhalt: Buffer.from('EICAR') }];
    const r = await rufen();
    assert.equal(r.json.clean, false);
    assert.equal(r.json.virus, 'Eicar-Test');
  });

  // Der Kern: Vorher galt diese Mail als sauber, weil nur 20 geprüft wurden.
  test('21 Anhänge, die letzte schädlich: NICHT sauber, und nichts wurde gescannt', async () => {
    mail.teile = [...dateien(20), { name: 'boese.exe', inhalt: Buffer.from('EICAR') }];
    const r = await rufen();
    assert.equal(r.status, 200);
    assert.equal(r.json.clean, false, 'sonst käme die Mail durch');
    assert.match(r.json.virus, /^Prüfgrenze überschritten: 21 Anhänge/);
    assert.equal(r.json.abgebrochen, 'zu_viele_anhaenge');
    assert.equal(r.json.gefunden, 21);
    assert.equal(r.json.geprueft, 0);
    assert.equal(r.json.ungeprueft, 21, 'im Workflow sieht man, dass nichts geprüft wurde');
    assert.equal(scans.length, 0);
    assert.equal(client.downloads.length, 0);
  });

  test('eine zu große Datei: ebenfalls nicht sauber', async () => {
    mail.teile = [...dateien(2), { name: 'riesig.iso', groesse: 31 * MB, inhalt: Buffer.alloc(1) }];
    const r = await rufen();
    assert.equal(r.json.clean, false);
    assert.equal(r.json.abgebrochen, 'datei_zu_gross');
    assert.match(r.json.virus, /riesig\.iso/);
    assert.equal(scans.length, 0);
  });

  test('eine Datei, die beim Lesen zu groß wird, kippt auch die schon geprüften', async () => {
    mail.teile = [
      ...dateien(2),
      { name: 'luege.bin', groesse: 10, stuecke: Array.from({ length: 4 }, () => Buffer.alloc(8 * MB)) },
    ];
    const r = await rufen();
    assert.equal(r.json.clean, false);
    assert.equal(r.json.abgebrochen, 'datei_zu_gross');
  });

  test('Scanner nicht erreichbar: die Datei zählt als UNGEPRÜFT, nicht als geprüft', async () => {
    mail.teile = dateien(2);
    clamav.scan = async () => { throw new Error('clamd: ECONNREFUSED'); };
    const r = await rufen();
    assert.equal(r.json.clean, true, 'bisheriges Verhalten: ein Ausfall blockiert keine Mail …');
    assert.equal(r.json.geprueft, 0);
    assert.equal(r.json.ungeprueft, 2, '… muss aber im Ergebnis stehen');
  });

  test('Scanner ausgeschaltet: es wird nichts heruntergeladen', async () => {
    settings.setze('clamav_aktiv', '0');
    mail.teile = dateien(4);
    const r = await rufen();
    assert.equal(r.json.clean, true);
    assert.equal(r.json.gefunden, 4);
    assert.equal(r.json.geprueft, 0);
    assert.match(r.json.fehler, /abgeschaltet/);
    assert.equal(client.downloads.length, 0, 'sonst lädt das Panel Dateien für einen Dienst, der nicht läuft');
    assert.equal(scans.length, 0);
  });

  test('unbekanntes Konto: 404', async () => {
    const r = await rufen({ konto: 'Gibt-es-nicht' });
    assert.equal(r.status, 404);
  });

  test('ohne Konto: 400', async () => {
    const r = await anfrage(port, '/api/internal/scan-anhaenge', { rumpf: {} });
    assert.equal(r.status, 400);
  });
});

describe('POST /api/internal/anhaenge', () => {
  let port;
  beforeEach(async () => {
    port ??= await starten();
    db.prepare("DELETE FROM accounts WHERE name = 'Testkonto'").run();
    db.prepare('INSERT INTO accounts (name, host, port, username, password_enc) VALUES (?, ?, ?, ?, ?)')
      .run('Testkonto', 'imap.example', 993, 'u', verschluesseln('pw'));
  });

  const rufen = () => anfrage(port, '/api/internal/anhaenge', { rumpf: { konto: 'Testkonto', uid: 7 } });

  test('die Anhänge kommen als base64 zurück', async () => {
    mail.teile = dateien(2);
    const r = await rufen();
    assert.equal(r.json.anhaenge.length, 2);
    assert.equal(Buffer.from(r.json.anhaenge[0].base64, 'base64').toString(), 'inhalt 1');
    assert.equal(r.json.anhaenge[0].name, 'datei-1.pdf');
  });

  test('mehr als 20: nichts kommt zurück, und der Grund steht da', async () => {
    mail.teile = dateien(21);
    const r = await rufen();
    assert.deepEqual(r.json.anhaenge, []);
    assert.equal(r.json.abgebrochen, 'zu_viele_anhaenge');
    assert.match(r.json.fehler, /21 Anhänge/);
    assert.equal(r.json.gefunden, 21);
    assert.equal(client.downloads.length, 0);
  });

  test('eine zu große Datei: nichts kommt zurück', async () => {
    mail.teile = [...dateien(1), { name: 'riesig.zip', groesse: 35 * MB, inhalt: Buffer.alloc(1) }];
    const r = await rufen();
    assert.deepEqual(r.json.anhaenge, []);
    assert.equal(r.json.abgebrochen, 'datei_zu_gross');
  });
});

describe('POST /api/internal/scan (roh)', () => {
  let port;
  const echtesScan = clamav.scan;
  beforeEach(async () => { port ??= await starten(); clamav.scan = async () => ({ clean: true }); });
  after(() => { clamav.scan = echtesScan; });

  test('eine kleine Datei wird gescannt', async () => {
    const r = await anfrage(port, '/api/internal/scan', { roh: Buffer.from('hallo') });
    assert.equal(r.status, 200);
    assert.equal(r.json.clean, true);
  });

  test('eine leere Anfrage: 400', async () => {
    const r = await anfrage(port, '/api/internal/scan', { roh: Buffer.alloc(0) });
    assert.equal(r.status, 400);
  });

  test('über 30 MB: 413 und ausdrücklich NICHT sauber', async () => {
    const r = await anfrage(port, '/api/internal/scan', { roh: Buffer.alloc(31 * MB) });
    assert.equal(r.status, 413);
    assert.equal(r.json.clean, false);
    assert.equal(r.json.abgebrochen, 'datei_zu_gross');
  });
});

describe('Dateien über 30 MB im JSON-Rumpf', () => {
  let port;
  beforeEach(async () => { port ??= await starten(); });

  test('/beleg-auslesen: 413, nichts wird abgelegt', async () => {
    const r = await anfrage(port, '/api/internal/beleg-auslesen', {
      rumpf: { konto: 'K', von: 'a@b.c', betreff: 'x', dateiname: 'a.pdf', pdf_base64: 'A'.repeat(41 * MB) },
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.speichern, false);
    assert.equal(r.json.grund, 'datei_zu_gross');
  });

  test('upload-freigabe: abgewiesen, ohne dass eine Datei im Zwischenlager landet', async () => {
    const vorher = require('fs').readdirSync(uploadFreigabe.ablageOrdner()).length;
    const r = await anfrage(port, '/api/internal/upload-freigabe', {
      rumpf: { konto: 'K', uid: '1', dateiname: 'a.pdf', zielpfad: 'Belege', base64: 'A'.repeat(41 * MB) },
    });
    assert.equal(r.status, 200, 'niemals 5xx: der n8n-Lauf soll nicht rot werden');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.grund, 'datei_zu_gross');
    assert.equal(require('fs').readdirSync(uploadFreigabe.ablageOrdner()).length, vorher);
  });

  test('einliefern: eine Datei knapp unter 30 MB wird angenommen', async () => {
    const r = await uploadFreigabe.einliefern({
      konto: 'K', uid: '2', dateiname: 'gross.pdf', zielpfad: 'Belege', base64: Buffer.alloc(1000).toString('base64'),
    });
    assert.equal(r.ok, true, r.grund);
  });
});
