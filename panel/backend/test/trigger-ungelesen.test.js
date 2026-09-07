// Neue Post soll ungelesen bleiben.
//
// Wer sein Postfach oeffnete, sah neue Mails bereits als gelesen — das Panel war
// schneller, und damit war der wichtigste Hinweis weg, den ein Postfach hat.
//
// Schuld war nicht das Abholen: n8n holt mit `markSeen: false`. Es war allein
// die Nachbehandlung `postProcessAction: 'read'`, die hinterher
// `addFlags(processedUids, '\SEEN')` ausfuehrt.
//
// Die naheliegende Sorge — ohne Gelesen-Markierung findet der Ausloeser dieselbe
// Mail immer wieder — ist unbegruendet: n8n schreibt `staticData.lastMessageUid`
// unabhaengig von dieser Einstellung fort und ueberspringt jede Mail mit
// `uid <= lastMessageUid`. Dieser Merker haengt an der Knoten-ID. Deshalb steht
// hier auch ein Test auf die ID: Aendert sie sich, faengt jedes Konto von vorne
// an und schickt seinen ganzen Posteingang noch einmal durch die KI.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const settings = require('../src/services/settings');
const patcher = require('../src/services/workflowPatcher');

const konto = { id: 7, name: 'K', n8n_credential_id: 42 };

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = 'neue_mails_ungelesen'").run();
});

// Ein Rueckschlag aus dem Betrieb, der die Vorzeichen umgedreht hat.
//
// Der Gedanke stimmte: n8n fuehrt einen Wasserstand ueber die zuletzt gesehene
// UID, also schadet "nicht als gelesen markieren" nicht. Er haelt aber nur,
// solange die Laeufe durchkommen -- n8n sichert die statischen Daten eines
// Workflows erst beim erfolgreichen Ende. Am 7.9. scheiterten sie reihenweise
// an Googles Absagen, der Wasserstand wurde nie geschrieben, und damit fielen
// BEIDE Bremsen gleichzeitig weg: Der Ausloeser fand dieselben Mails wieder und
// wieder, und die Laeufe stapelten sich zu Dutzenden.
//
// Deshalb ist der Standard jetzt "als gelesen markieren". Ungelesen bleiben ist
// eine bewusste Wahl fuer den, dessen Laeufe zuverlaessig gruen sind.
describe('Der Ausloeser markiert wieder als gelesen', () => {
  test('von Haus aus — das ist die Bremse, die immer haelt', () => {
    const k = patcher.triggerKnoten(konto, [0, 0]);
    assert.equal(k.parameters.postProcessAction, 'read',
      'ohne sie haengt alles am Wasserstand, und der wird bei Fehlschlaegen nicht gesichert');
  });

  test('wer ungelesene Post will, bekommt sie', () => {
    settings.setze('neue_mails_ungelesen', '1');
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).parameters.postProcessAction, 'nothing');
  });

  test('ausdruecklich abgeschaltet heisst gelesen', () => {
    settings.setze('neue_mails_ungelesen', '0');
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).parameters.postProcessAction, 'read');
  });
});

describe('Was am Ausloeser gleich bleiben muss', () => {
  test('die Knoten-ID — daran haengt n8ns Merker fuer die letzte Mail', () => {
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).id, 'panel-7-trigger',
      'eine neue ID hiesse: Merker weg, ganzer Posteingang noch einmal durch die KI');
  });

  test('die vollstaendigen Kopfzeilen — ohne sie keine Absender-IP fuer die DNSBL', () => {
    const k = patcher.triggerKnoten(konto, [0, 0]);
    assert.equal(k.parameters.format, 'resolved');
    assert.equal(k.parameters.downloadAttachments, true, 'sonst kein Virenscan');
  });

  test('das Postfach bleibt der Posteingang', () => {
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).parameters.mailbox, 'INBOX');
  });
});
