// Der Stapel-Umzug: bestandAnwenden().
//
// Hier saß der schwerste Fehler der ganzen Woche — das Panel meldete Mails als
// verschoben, die es nie angefasst hatte, weil IMAP-UIDs nur je Ordner gelten
// und ein Verschiebeversuch ins Leere keinen Fehler wirft. Diese Datei hält
// fest, was seitdem gelten muss.
//
// Die IMAP-Schicht wird ersetzt, nicht aufgerufen: Ein Test, der einen echten
// Mailserver braucht, läuft in der CI nicht — und ein Test, der nicht läuft,
// schützt vor nichts.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

// Den IMAP-Baustein austauschen, BEVOR irgendetwas ihn lädt.
const imapPfad = require.resolve('../src/services/imap');
const imapStub = {
  aufrufe: [],
  antwort: null,
  STANDARD: { folder_spam: 'Quarantaene', folder_invoices: 'Rechnungen', folder_orders: 'Bestellungen', folder_newsletter: 'Newsletter', folder_archive: 'Archiv' },
  async mailsVerschieben({ mails, von, nach }) {
    imapStub.aufrufe.push({ mails: mails.map((m) => m.uid), von, nach });
    return imapStub.antwort(mails);
  },
  async uidsAuflisten() { return new Set(); },
};
require.cache[imapPfad] = {
  id: imapPfad, filename: imapPfad, loaded: true, children: [], paths: [], exports: imapStub,
};

const db = require('../src/db');
const { verschluesseln } = require('../src/services/crypto');
const sortierung = require('../src/services/sortierung');

let kontoId;

function kontoAnlegen() {
  const info = db.prepare(`
    INSERT INTO accounts (name, host, port, username, password_enc, aktiv)
    VALUES ('Testkonto', 'mail.example.invalid', 993, 'test@example.invalid', ?, 1)
  `).run(verschluesseln('geheim'));
  return info.lastInsertRowid;
}

function mailEinfuegen({ von, betreff = 'Betreff', uid, status = 'offen' }) {
  return db.prepare(`
    INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid, status)
    VALUES ('Testkonto', ?, ?, ?, ?, ?)
  `).run(kontoId, von, betreff, uid, status).lastInsertRowid;
}

const zeile = (id) => db.prepare('SELECT * FROM sort_inbox WHERE id = ?').get(id);
const konto = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(kontoId);
const REGEL = { typ: 'domain', muster: 'example.com', zielordner: 'Ziel' };

beforeEach(() => {
  db.exec('DELETE FROM sort_inbox; DELETE FROM accounts;');
  kontoId = kontoAnlegen();
  imapStub.aufrufe = [];
  imapStub.antwort = (mails) => ({ verschoben: mails, fehler: [] });
});

describe('bestandAnwenden()', () => {
  test('verschiebt die passenden Mails und hakt sie ab', async () => {
    const a = mailEinfuegen({ von: 'eins@example.com', uid: '11' });
    const b = mailEinfuegen({ von: 'zwei@example.com', uid: '12' });
    const fremd = mailEinfuegen({ von: 'drei@anderswo.invalid', uid: '13' });

    const erg = await sortierung.bestandAnwenden(konto(), REGEL);

    assert.equal(erg.verschoben, 2);
    assert.equal(erg.treffer, 2);
    assert.deepEqual(erg.fehler, []);
    assert.equal(zeile(a).status, 'zugeordnet');
    assert.equal(zeile(b).status, 'zugeordnet');
    assert.equal(zeile(fremd).status, 'offen', 'fremde Domain bleibt unangetastet');
    assert.equal(imapStub.aufrufe[0].nach, 'Ziel');
  });

  // Der Kern des Fehlers: Die Mail liegt nicht mehr im Posteingang. Früher
  // blieb die Zeile auf 'offen' stehen und scheiterte bei jedem Versuch aufs
  // Neue — eine Sackgasse, aus der man nicht herauskam.
  test('nicht mehr im Posteingang: geschlossen statt als Fehler gezählt', async () => {
    const a = mailEinfuegen({ von: 'weg@example.com', uid: '21' });
    imapStub.antwort = () => ({
      verschoben: [],
      fehler: [{ uid: '21', grund: 'nicht in "INBOX" gefunden' }],
    });

    const erg = await sortierung.bestandAnwenden(konto(), REGEL);

    assert.equal(erg.verschoben, 0);
    assert.equal(erg.veraltet, 1);
    assert.deepEqual(erg.fehler, [], 'ist kein Fehler, den jemand beheben könnte');
    assert.notEqual(zeile(a).status, 'offen', 'darf nicht wieder auftauchen');
    assert.match(zeile(a).vorschlag, /nicht mehr im Posteingang/);
  });

  test('echte Fehler bleiben Fehler — mit Absender statt nackter UID', async () => {
    mailEinfuegen({ von: 'kaputt@example.com', uid: '31' });
    imapStub.antwort = () => ({
      verschoben: [],
      fehler: [{ uid: '31', grund: 'Server sagt nein' }],
    });

    const erg = await sortierung.bestandAnwenden(konto(), REGEL);

    assert.equal(erg.fehler.length, 1);
    assert.match(erg.fehler[0], /kaputt@example\.com/);
    assert.match(erg.fehler[0], /Server sagt nein/);
  });

  // "28" und "28.0" sind dieselbe Mail. Ohne Entdopplung wurde sie doppelt
  // gezählt und zweimal verschoben — beim zweiten Mal ins Leere.
  test('Dubletten werden nur einmal angefasst', async () => {
    const a = mailEinfuegen({ von: 'doppelt@example.com', uid: '28' });
    const b = mailEinfuegen({ von: 'doppelt@example.com', uid: '28.0' });

    const erg = await sortierung.bestandAnwenden(konto(), REGEL);

    assert.equal(imapStub.aufrufe[0].mails.length, 1, 'nur ein Verschiebeversuch');
    assert.equal(erg.veraltet, 1);
    assert.equal(erg.verschoben, 1);
    const stati = [zeile(a).status, zeile(b).status].sort();
    assert.deepEqual(stati, ['ignoriert', 'zugeordnet'], 'beide Zeilen sind erledigt');
  });

  test('Zeilen ohne UID werden geschlossen, nicht an IMAP geschickt', async () => {
    const a = mailEinfuegen({ von: 'ohne@example.com', uid: null });
    const erg = await sortierung.bestandAnwenden(konto(), REGEL);

    assert.equal(imapStub.aufrufe.length, 0, 'gar kein IMAP-Versuch');
    assert.equal(erg.veraltet, 1);
    assert.notEqual(zeile(a).status, 'offen');
  });

  test('nurZaehlen zählt Mails, nicht Zeilen — und ändert nichts', async () => {
    mailEinfuegen({ von: 'a@example.com', uid: '41' });
    mailEinfuegen({ von: 'a@example.com', uid: '41.0' });
    mailEinfuegen({ von: 'b@example.com', uid: '42' });

    const erg = await sortierung.bestandAnwenden(konto(), REGEL, { nurZaehlen: true });

    assert.equal(erg.treffer, 2, 'die Dublette zählt nicht doppelt');
    assert.equal(imapStub.aufrufe.length, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sort_inbox WHERE status='offen'").get().n, 3,
      'die Vorschau verändert nichts',
    );
  });

  test('nichts Passendes: kein IMAP-Versuch', async () => {
    mailEinfuegen({ von: 'a@anderswo.invalid', uid: '51' });
    const erg = await sortierung.bestandAnwenden(konto(), REGEL);
    assert.equal(erg.treffer, 0);
    assert.equal(imapStub.aufrufe.length, 0);
  });

  test('bereits erledigte Zeilen werden nicht erneut angefasst', async () => {
    mailEinfuegen({ von: 'alt@example.com', uid: '61', status: 'zugeordnet' });
    mailEinfuegen({ von: 'alt@example.com', uid: '62', status: 'ignoriert' });
    const erg = await sortierung.bestandAnwenden(konto(), REGEL);
    assert.equal(erg.treffer, 0);
    assert.equal(imapStub.aufrufe.length, 0);
  });
});

describe('abgleichen() — Karteileichen aus der Sortier-Inbox räumen', () => {
  test('was nicht mehr im Posteingang liegt, fliegt raus', async () => {
    const da = mailEinfuegen({ von: 'hier@example.com', uid: '71' });
    const weg = mailEinfuegen({ von: 'fort@example.com', uid: '72' });
    const doppelt = mailEinfuegen({ von: 'hier@example.com', uid: '71.0' });

    const geschlossen = await sortierung.abgleichen(konto(), { vorhanden: new Set([71]) });

    assert.equal(geschlossen, 2);
    assert.equal(zeile(da).status, 'offen', 'die vorhandene bleibt');
    assert.equal(zeile(weg).status, 'ignoriert');
    assert.match(zeile(weg).vorschlag, /nicht mehr im Posteingang/);
    assert.equal(zeile(doppelt).status, 'ignoriert');
    assert.match(zeile(doppelt).vorschlag, /Dublette/);
  });

  test('ohne offene Zeilen passiert nichts', async () => {
    assert.equal(await sortierung.abgleichen(konto(), { vorhanden: new Set() }), 0);
  });
});
