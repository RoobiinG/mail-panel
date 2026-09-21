// Warum ein Bestandslauf zwanzig Mails schaffte, wo drei je Anfrage hineingehen.
//
// Aus dem Lauf vom 14.09., 08:00–08:06 Uhr:
//
//     Ollama llama3.2:1b: 1795 Token Prompt in 4.9 s … 90 Token Antwort … 9.9 s
//     (rund zwanzig solcher Zeilen)
//     Zeitbudget des Laufs erreicht — 20 von 482 Mails klassifiziert.
//
// Zwanzig Anfragen, zwanzig Mails — bei eingestellter Bündelgröße drei. Der
// Grund steht in buendeln(): Ein Verdachtsfall kostete drei Plätze, füllte also
// allein das ganze Bündel.
//
// Der Aufschlag hat einen guten Grund, aber nur bei Gemini: Dort bekommt ein
// Verdachtsfall die lange Textform (1.500 statt 600 Zeichen). Bei der lokalen KI
// kappt mailBlock() auf 500 Zeichen — verdächtig oder nicht. Der Aufschlag
// bezahlte dort nichts und kostete zwei Drittel des Durchsatzes.
//
// Und „verdächtig" heißt hier vor allem „Absender, mit dem dieses Konto noch nie
// zu tun hatte" — im Bestand ist das der Normalfall.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const k = require('../src/services/klassifizierer');

// Ein fremder Absender ohne Abmelde-Link: genau das Muster, das verdaechtig()
// als Verdachtsfall wertet.
const fremd = (nr) => ({ von: `wer${nr}@unbekannt${nr}.example`, betreff: `Sache ${nr}`, text: 'x' });
// Ein bekannter Absender mit Abmelde-Link ist unverdaechtig.
const bekannterNewsletter = (nr) => ({
  von: `news@haus.example`, betreff: `Ausgabe ${nr}`, text: 'x', listUnsubscribe: '<mailto:x@haus.example>',
});

const bekannt = new Set(['haus.example']);

const gruppen = (mails) => mails.map((m) => ({ vertreter: m, mitglieder: [m] }));

beforeEach(() => {
  db.exec("DELETE FROM settings WHERE key IN ('ki_anbieter', 'ollama_buendel', 'ollama_buendel')");
  settings.setze('ollama_buendel', '20');
});

describe('Verdachtsfälle bei lokaler KI', () => {
  beforeEach(() => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('ollama_buendel', '3');
  });

  test('kosten einen Platz, nicht drei', () => {
    assert.equal(k.plaetzeFuer({ vertreter: fremd(1) }, bekannt), 1,
      'die lange Textform gibt es bei Ollama nicht — mailBlock() kappt auf 500 Zeichen');
  });

  test('drei fremde Absender passen in EIN Bündel', () => {
    const b = k.buendeln(gruppen([fremd(1), fremd(2), fremd(3)]), bekannt);
    assert.equal(b.length, 1, 'vorher waren das drei Anfragen à zehn Sekunden');
    assert.equal(b[0].length, 3);
  });

  test('die eingestellte Bündelgröße gilt weiterhin', () => {
    const b = k.buendeln(gruppen([fremd(1), fremd(2), fremd(3), fremd(4)]), bekannt);
    assert.deepEqual(b.map((x) => x.length), [3, 1]);
  });

  test('bei Bündelgröße 1 bleibt es bei einer Mail je Anfrage', () => {
    settings.setze('ollama_buendel', '1');
    const b = k.buendeln(gruppen([fremd(1), fremd(2)]), bekannt);
    assert.deepEqual(b.map((x) => x.length), [1, 1]);
  });
});

describe('Unverdächtige Mails kosten überall einen Platz', () => {
  test('mit Ollama', () => {
    settings.setze('ki_anbieter', 'ollama');
    assert.equal(k.plaetzeFuer({ vertreter: bekannterNewsletter(1) }, bekannt), 1);
  });
});
