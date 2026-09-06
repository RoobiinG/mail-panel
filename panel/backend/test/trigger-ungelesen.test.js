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

describe('Der Ausloeser markiert nicht mehr als gelesen', () => {
  test('von Haus aus bleibt die Mail ungelesen', () => {
    const k = patcher.triggerKnoten(konto, [0, 0]);
    assert.equal(k.parameters.postProcessAction, 'nothing',
      'sonst ist neue Post schon gelesen, bevor der Nutzer sie sieht');
  });

  test('wer das alte Verhalten will, bekommt es', () => {
    settings.setze('neue_mails_ungelesen', '0');
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).parameters.postProcessAction, 'read');
  });

  test('eingeschaltet heisst ungelesen', () => {
    settings.setze('neue_mails_ungelesen', '1');
    assert.equal(patcher.triggerKnoten(konto, [0, 0]).parameters.postProcessAction, 'nothing');
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
