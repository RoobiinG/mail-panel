// Ein 504 vom Reverse-Proxy ist kein hängendes Modell.
//
// Diagnosebericht vom 17.09., 12:17: Ollama läuft auf einem eigenen Server
// hinter einem Reverse-Proxy, der nach ~90 s mit „504 Gateway Time-out"
// abbricht. Fünfer-Bündel brauchten 67–90 s, einzelne Mails 5–30 s. Pro Lauf
// schaffte die KI nur noch 12, 20, 31, 44 von rund 245 Mails. Drei Fehler
// griffen ineinander:
//
//  1. Die Restzeit-Prüfung rechnete für eine EINZELNE Mail mit der Dauer des
//     langsamsten FÜNFER-Bündels (89,9 s → 108 s nötig). Nach dem 504 wurden
//     die Mails deshalb nicht mehr einzeln nachgeholt: „versuche die Mails
//     einzeln" und in derselben Sekunde „12 von 247", Lauf beendet.
//  2. Ein 504 zählte wie ein hängendes Modell — zwei davon beendeten den Lauf.
//  3. Jedes weitere Bündel lief in dieselbe Wand, statt kleiner zu werden.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const kiText = require('../src/services/kiText');
const messung = require('../src/services/ollamaMessung');
const k = require('../src/services/klassifizierer');

// Jede Mail ein anderer Absender und Betreff, damit nichts als Dublette
// zusammengefasst wird und jede Mail wirklich einen Platz im Bündel belegt.
const mail = (n) => ({
  konto: 'K', uid: n, von: `abs${n}@firma${n}.de`, betreff: `Anliegen Nummer ${'x'.repeat(n + 1)}`,
  text: 'Ein Text.', links: [],
});

const braveAntwort = (prompt) => {
  const nummern = [...prompt.matchAll(/^\[(\d+)\]$/gm)].map((m) => Number(m[1]));
  return {
    ok: true,
    daten: nummern.map((nr) => ({ nr, kategorie: 'sonstiges', spam_score: 0, kurzfassung: 'x', konfidenz: 0.5 })),
  };
};

let groessen;
function antwortenMit(fn) {
  groessen = [];
  kiText.frageJson = async (prompt, opt) => {
    groessen.push(opt.mails);
    return fn(prompt, opt);
  };
}

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM accounts; DELETE FROM konto_ordner;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_%' OR key LIKE 'ki_%' OR key LIKE 'ollama_%' OR key LIKE 'themen_%'").run();
  db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K','h',993,'u','x',1)",
  ).run();
  settings.setze('ki_anbieter', 'ollama');
  messung._zuruecksetzen();
});

describe('Die Restzeit richtet sich nach der Größe der nächsten Anfrage', () => {
  const fertig = (sekunden, mails) => messung.merken(
    messung.kennzahlen({ total_duration: sekunden * 1e9 }, 'm', mails),
  );

  test('eine einzelne Mail braucht nicht die Restzeit eines Fünfer-Bündels', () => {
    fertig(90, 5);
    fertig(86, 5);
    fertig(10, 1);
    fertig(8, 1);
    assert.ok(k.mindestRestMs(1) < k.mindestRestMs(5),
      'genau dieser Unterschied fehlte — die Einzelmails starteten nicht mehr');
    assert.equal(k.mindestRestMs(1), 20000, '10 s × 1,15 + 5 s liegt unter dem Mindestwert von 20 s');
  });

  test('mehr als die Proxy-Grenze wird nie verlangt', () => {
    fertig(89.9, 5);
    fertig(88, 5);
    messung.merken(messung.abbruch('m', 90, '504', 'gateway', 5));
    assert.equal(k.mindestRestMs(5), 95000, 'entweder die Antwort ist nach 90 s da oder der 504');
  });
});

describe('Ein 504 bei einem Bündel', () => {
  test('die Mails werden einzeln nachgeholt und der Rest des Laufs kleiner gebündelt', async () => {
    settings.setze('ollama_buendel', '4');
    antwortenMit((prompt, opt) => (opt.mails > 1
      ? { ok: false, gatewayTimeout: true, fehler: 'Ollama antwortete mit 504' }
      : braveAntwort(prompt)));

    const e = await k.klassifizieren(Array.from({ length: 8 }, (_, i) => mail(i)));

    assert.equal(e.abgebrochen, false, 'zwei 504 bei Bündeln sind kein Grund aufzuhören');
    assert.equal(e.klassifiziert, 8);
    assert.equal(groessen[0], 4, 'begonnen wird mit der eingestellten Größe');
    const nachDemErsten = groessen.slice(1);
    assert.ok(nachDemErsten.every((g) => g <= 2), `danach nie mehr als 2: ${groessen.join(',')}`);
    assert.equal(groessen.at(-1), 1, 'nach dem zweiten 504 nur noch einzeln');
  });

  test('läuft selbst eine einzelne Mail zweimal in den 504, endet der Lauf — mit der richtigen Ursache', async () => {
    settings.setze('ollama_buendel', '1');
    antwortenMit(() => ({ ok: false, gatewayTimeout: true, fehler: 'Ollama antwortete mit 504' }));

    const e = await k.klassifizieren(Array.from({ length: 4 }, (_, i) => mail(i)));

    assert.equal(e.abgebrochen, true);
    assert.equal(groessen.length, 2);
    assert.match(e.hinweis, /Reverse-Proxy/);
    assert.doesNotMatch(e.hinweis, /Modell ist für diese Maschine zu groß/,
      'ein 504 vom Proxy ist kein zu großes Modell');
  });

  test('ein echter Timeout (kein 504) beendet den Lauf weiterhin nach zweimal', async () => {
    settings.setze('ollama_buendel', '1');
    antwortenMit(() => ({ ok: false, fehler: 'Ollama war nicht erreichbar: The operation was aborted due to timeout' }));

    const e = await k.klassifizieren(Array.from({ length: 4 }, (_, i) => mail(i)));

    assert.equal(e.abgebrochen, true);
    assert.match(e.hinweis, /nicht geantwortet/);
  });
});

describe('Über Läufe hinweg: Die Bündelgröße merkt sich den 504', () => {
  test('nach einem 504 bei fünf Mails gilt zwei', () => {
    settings.setze('ollama_buendel', '5');
    assert.equal(k.buendelGroesse(), 5);
    messung.merken(messung.abbruch('m', 90, '504', 'gateway', 5));
    assert.equal(k.buendelGroesse(), 2);
  });

  test('nie größer als eingestellt', () => {
    settings.setze('ollama_buendel', '1');
    messung.merken(messung.abbruch('m', 90, '504', 'gateway', 5));
    assert.equal(k.buendelGroesse(), 1);
  });

  test('ein Netzwerk-Abbruch kappt nicht — nur der Proxy', () => {
    settings.setze('ollama_buendel', '5');
    messung.merken(messung.abbruch('m', 240, 'aborted', 'netzwerk', 5));
    assert.equal(k.buendelGroesse(), 5);
  });
});
