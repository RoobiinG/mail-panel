// Tausende Mails in einem Rutsch verschieben — der einzige Weg, einen
// Posteingang mit 15.000 Mails leer zu bekommen.
//
// Bis Build 193 ging jede Mail einzeln über die Leitung: ein UID MOVE je Mail.
// Für die paar Mails aus der Sortier-Inbox reichte das. Der Absender-Weg
// („Regel anlegen UND alles von diesem Absender aus dem Posteingang holen")
// bewegt aber gern mehrere tausend auf einmal — und dann sind es ebenso viele
// Rundreisen zum Server, während die HTTP-Anfrage dahinter in ihr Zeitlimit
// läuft. IMAP nimmt Mengen entgegen; genau das nutzt die Funktion jetzt.
//
// Der Preis ist die Genauigkeit: Bei einem Bündel muss die uidMap sagen, welche
// Mail wirklich bewegt wurde. Eine nicht vorhandene UID wirft nämlich keinen
// Fehler, sie bewegt sich nur nicht — und das darf nicht als Erfolg zählen.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

// imapflow abfangen, BEVOR services/imap.js es lädt.
const imapflowPfad = require.resolve('imapflow');
let letzterClient = null;
// Die Antwort muss VOR dem Aufruf feststehen: mailsVerschieben erzeugt seinen
// Client selbst, wir kommen erst im Konstruktor an ihn heran.
let naechsteAntwort = null;

class FakeImapFlow {
  constructor() {
    this.befehle = [];              // jede messageMove-Anfrage, wie sie hinausging
    this.antwort = naechsteAntwort; // was messageMove zurückgibt (oder wirft)
    letzterClient = this;
  }

  async connect() { /* nichts zu tun */ }
  async getMailboxLock() { return { release() { /* nichts */ } }; }
  async logout() { /* nichts */ }

  async messageMove(menge, ziel, opt) {
    this.befehle.push({ menge: String(menge), ziel, uid: opt?.uid });
    if (typeof this.antwort === 'function') return this.antwort(String(menge));
    return this.antwort;
  }
}

require.cache[imapflowPfad] = {
  id: imapflowPfad,
  filename: imapflowPfad,
  loaded: true,
  exports: { ImapFlow: FakeImapFlow },
};

const imap = require('../src/services/imap');

const konto = { host: 'h', port: 993, username: 'u', passwort: 'p' };
const mails = (n, ab = 1) => Array.from({ length: n }, (_, i) => ({ uid: ab + i }));

// Ein Server mit UIDPLUS: bestätigt jede UID, die er bekommen hat.
const allesBewegt = (menge) => ({
  uidMap: new Map(menge.split(',').map((u) => [Number(u), Number(u) + 1000])),
});

beforeEach(() => {
  letzterClient = null;
  naechsteAntwort = allesBewegt;
});

describe('Mengen statt Einzelaufrufe', () => {
  test('zehn Mails gehen in einem einzigen Befehl hinaus', async () => {
    const r = await imap.mailsVerschieben({
      ...konto, mails: mails(10), von: 'INBOX', nach: 'Werbung',
    });

    assert.equal(letzterClient.befehle.length, 1, 'sonst sind es zehn Rundreisen zum Server');
    assert.equal(letzterClient.befehle[0].menge, '1,2,3,4,5,6,7,8,9,10');
    assert.equal(letzterClient.befehle[0].ziel, 'Werbung');
    assert.equal(letzterClient.befehle[0].uid, true, 'ohne uid:true meint IMAP laufende Nummern');
    assert.equal(r.verschoben.length, 10);
  });

  test('große Mengen werden gebündelt, nicht einzeln geschickt', async () => {
    const anzahl = imap.VERSCHIEBE_BUENDEL * 3 + 17;
    const r = await imap.mailsVerschieben({
      ...konto, mails: mails(anzahl), von: 'INBOX', nach: 'Archiv',
    });

    assert.equal(letzterClient.befehle.length, 4, `${anzahl} Mails ergeben vier Bündel`);
    assert.equal(r.verschoben.length, anzahl);
    assert.equal(r.fehler.length, 0);
  });

  test('3000 Mails kosten 15 Befehle statt 3000', async () => {
    await imap.mailsVerschieben({ ...konto, mails: mails(3000), von: 'INBOX', nach: 'X' });
    assert.equal(letzterClient.befehle.length, 15);
  });
});

describe('Was wirklich bewegt wurde', () => {
  // Der Grund, warum die uidMap ausgewertet wird: Eine UID, die es nicht mehr
  // gibt, wirft keinen Fehler — sie bewegt sich nur nicht.
  test('nicht bestätigte UIDs gelten als Fehler, nicht als Erfolg', async () => {
    // Der Server bestätigt nur 1 und 3.
    naechsteAntwort = () => ({ uidMap: new Map([[1, 101], [3, 103]]) });

    const r = await imap.mailsVerschieben({
      ...konto, mails: mails(4), von: 'INBOX', nach: 'Werbung',
    });

    assert.deepEqual(r.verschoben.map((m) => m.uid), [1, 3]);
    assert.deepEqual(r.fehler.map((f) => f.uid), [2, 4]);
    assert.match(r.fehler[0].grund, /nicht in "INBOX" gefunden/);
  });

  test('ungültige UIDs verderben das Bündel nicht', async () => {
    const r = await imap.mailsVerschieben({
      ...konto,
      mails: [{ uid: 5 }, { uid: 'abc' }, { uid: 0 }, { uid: 7 }],
      von: 'INBOX', nach: 'X',
    });

    assert.equal(letzterClient.befehle[0].menge, '5,7', 'nur die brauchbaren gehen hinaus');
    assert.equal(r.verschoben.length, 2);
    assert.equal(r.fehler.length, 2);
    assert.match(r.fehler[0].grund, /ungültige UID/);
  });

  // Nicht jeder Server kann UIDPLUS. Dann gilt: kein Fehler = hat gewirkt.
  test('ohne uidMap zählt der ausgebliebene Fehler', async () => {
    naechsteAntwort = () => ({});

    const r = await imap.mailsVerschieben({ ...konto, mails: mails(5), von: 'INBOX', nach: 'X' });
    assert.equal(r.verschoben.length, 5);
    assert.equal(r.fehler.length, 0);
  });

  test('wirft der Server, gilt das ganze Bündel als gescheitert', async () => {
    naechsteAntwort = () => { throw new Error('Postfach voll'); };

    const r = await imap.mailsVerschieben({ ...konto, mails: mails(3), von: 'INBOX', nach: 'X' });
    assert.equal(r.verschoben.length, 0);
    assert.equal(r.fehler.length, 3);
    assert.match(r.fehler[0].grund, /Postfach voll/);
  });

  test('ein Bündel scheitert, das nächste läuft weiter', async () => {
    let erstes = true;
    naechsteAntwort = (menge) => {
      if (erstes) { erstes = false; throw new Error('kurz gestolpert'); }
      return allesBewegt(menge);
    };

    const r = await imap.mailsVerschieben({
      ...konto, mails: mails(imap.VERSCHIEBE_BUENDEL + 10), von: 'INBOX', nach: 'X',
    });
    assert.equal(r.fehler.length, imap.VERSCHIEBE_BUENDEL);
    assert.equal(r.verschoben.length, 10, 'der Rest darf nicht mit untergehen');
  });
});

describe('Randfälle', () => {
  test('ohne Mails passiert nichts', async () => {
    const r = await imap.mailsVerschieben({ ...konto, mails: [], von: 'INBOX', nach: 'X' });
    assert.deepEqual(r, { verschoben: [], fehler: [] });
  });

  test('ohne Zielordner wird abgelehnt', async () => {
    await assert.rejects(
      () => imap.mailsVerschieben({ ...konto, mails: mails(1), von: 'INBOX' }),
      /Kein Zielordner/,
    );
  });

  test('nur unbrauchbare UIDs: kein Befehl geht hinaus', async () => {
    const r = await imap.mailsVerschieben({
      ...konto, mails: [{ uid: 'x' }, { uid: -1 }], von: 'INBOX', nach: 'X',
    });
    assert.equal(r.verschoben.length, 0);
    assert.equal(r.fehler.length, 2);
  });
});
