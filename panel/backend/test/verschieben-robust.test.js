// Eine Mail, die sich nicht verschieben lässt, darf nicht die anderen mitnehmen.
//
// Befund vom 12. September 2026, 02:11 Uhr: Der Bestandslauf holte 120 Mails,
// scheiterte an einer einzigen mit „Unable to move email" und endete als Fehler.
// Alles, was hinter dieser Mail stand, war verloren — obwohl es nichts damit zu
// tun hatte. Sichtbar wurde das erst, als das Auswahlfenster groß genug war;
// bei vier Mails je Konto fiel es nicht auf.
//
// Zwei Ursachen, beide hier festgehalten:
//   * Der Verschiebe-Knoten war der einzige Panel-Knoten ohne onError.
//   * Die Ordnerprüfung ließ „INBOX.Rechnungen" als Treffer für „Rechnungen"
//     gelten, gab als Ziel aber den kurzen Namen zurück — den es nicht gibt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const patcher = require('../src/services/workflowPatcher');
const themen = require('../src/services/themen');
const imap = require('../src/services/imap');
const { verschluesseln } = require('../src/services/crypto');

const kontoAnlegen = (name = 'K') => db.prepare(
  'INSERT INTO accounts (name, host, port, username, password_enc, aktiv, n8n_credential_id)'
  + " VALUES (?, 'h', 993, 'u', ?, 1, 'cred-1')",
).run(name, verschluesseln('x')).lastInsertRowid;

beforeEach(() => {
  db.exec('DELETE FROM accounts; DELETE FROM konto_ordner;');
  themen.cacheVerwerfen(1);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Der Verschiebe-Knoten reißt den Lauf nicht mehr ab', () => {
  const knoten = () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return patcher.verschiebeKnoten(konto, [0, 0]);
  };

  test('er lässt den Lauf weiterlaufen, wenn eine Mail scheitert', () => {
    assert.equal(knoten().onError, 'continueRegularOutput',
      'ohne das nimmt eine einzige unverschiebbare Mail den ganzen Lauf mit');
  });

  test('und gibt auch ohne Erfolg etwas aus', () => {
    assert.equal(knoten().alwaysOutputData, true);
  });

  // Der Grund, warum es überhaupt auffiel: Jeder andere Panel-Knoten hatte
  // beides längst. Bleibt das so, fällt der nächste Ausreißer wieder auf.
  test('damit verhält er sich wie die übrigen Panel-Knoten', () => {
    const id = kontoAnlegen('B');
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    const andere = patcher.bestandKnoten(konto, [0, 0]);
    const move = patcher.verschiebeKnoten(konto, [0, 0]);
    assert.equal(move.onError, andere.onError);
    assert.equal(move.alwaysOutputData, andere.alwaysOutputData);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Der Zielordner wird so geschrieben, wie der Server ihn führt', () => {
  const mitOrdnern = (...ordner) => {
    imap.testVerbindung = async () => ({ ordner });
  };

  test('liegt er unter dem Posteingang, kommt der volle Pfad zurück', async () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    mitOrdnern('INBOX', 'INBOX.Rechnungen', 'INBOX.Werbung');
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerPfad(konto, 'Rechnungen'), 'INBOX.Rechnungen',
      'mit dem kurzen Namen antwortet IMAP „Unable to move email"');
  });

  test('die Schreibweise des Servers gewinnt', async () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    mitOrdnern('INBOX', 'Rechnungen');
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerPfad(konto, 'rechnungen'), 'Rechnungen');
  });

  test('ein Ordner, den es nicht gibt, ist null', async () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    mitOrdnern('INBOX', 'Werbung');
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerPfad(konto, 'Rechnungen'), null,
      'nur so kann /einsortieren ihn anlegen lassen');
  });

  // Ein unerreichbares Postfach darf die Sortierung nicht anhalten — dann gilt
  // der gewünschte Name unverändert, wie bisher.
  test('ist das Postfach nicht erreichbar, bleibt der Wunschname stehen', async () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    imap.testVerbindung = async () => { throw new Error('keine Verbindung'); };
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerPfad(konto, 'Rechnungen'), 'Rechnungen');
  });

  test('ordnerExistiert bleibt die Ja-Nein-Frage darüber', async () => {
    const id = kontoAnlegen();
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    mitOrdnern('INBOX', 'INBOX.Rechnungen');
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerExistiert(konto, 'Rechnungen'), true);
    themen.cacheVerwerfen(konto.id);
    assert.equal(await themen.ordnerExistiert(konto, 'Gibtsnicht'), false);
  });
});
