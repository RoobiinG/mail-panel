// Der Abgleich, den man bisher von Hand anstossen musste.
//
// „Workflows → Synchronisieren" war ein Knopf. Wer ihn vergass, betrieb eine
// Einstellung, die es nur im Panel gab — beim KI-Anbieter hiess das: Panel sagt
// Ollama, n8n ruft weiter Google, und die Laeufe sind gruen und sortieren
// nichts. Diese Tests halten die Bedingungen fest, unter denen der Abgleich von
// selbst laufen darf — und vor allem die, unter denen er es NICHT tut.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const settings = require('../src/services/settings');
const autoSync = require('../src/services/autoSync');

beforeEach(() => {
  settings.setze('auto_sync', '1');
  settings.setze('n8n_api_key', '');
});

describe('Wann der Abgleich NICHT laeuft', () => {
  // Ohne Zugang gaebe es nur alle paar Minuten dieselbe Fehlermeldung im Log —
  // und einen Netzwerkversuch, der von vornherein aussichtslos ist.
  test('ohne n8n-Zugang passiert nichts', async () => {
    const r = await autoSync.jetzt('Test');
    assert.equal(r.uebersprungen, 'kein n8n-Zugang hinterlegt');
  });

  test('abgeschaltet heisst abgeschaltet', async () => {
    settings.setze('auto_sync', '0');
    settings.setze('n8n_api_key', 'irgendein-schluessel');
    const r = await autoSync.jetzt('Test');
    assert.equal(r.uebersprungen, 'abgeschaltet');
  });

  // beimStart() darf im abgeschalteten Zustand nicht einmal einen Zeitgeber
  // hinterlassen — sonst haengt der Prozess daran.
  test('beimStart legt abgeschaltet nichts an', () => {
    settings.setze('auto_sync', '0');
    autoSync.beimStart([50]);
    assert.equal(autoSync.stand().aktiv, false);
  });
});

describe('Der Stand ist ablesbar', () => {
  test('vor dem ersten Lauf steht dort nichts Erfundenes', () => {
    const s = autoSync.stand();
    assert.equal(s.aktiv, true);
    assert.equal(s.laeuft, false);
    assert.ok(s.letzter === null || typeof s.letzter === 'object');
  });
});
