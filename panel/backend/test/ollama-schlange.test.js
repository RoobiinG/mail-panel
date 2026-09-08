// Eine Anfrage nach der anderen an die lokale KI.
//
// Aus dem Diagnose-Bericht vom 8. September, 16:12 — alles in derselben Sekunde:
//
//     16:08:33 WARN  Ein Buendel blieb unbeantwortet: Ollama war nicht
//                    erreichbar: fetch failed        (neunmal hintereinander)
//     16:12:25 INFO  Zeitbudget des Laufs erreicht — 0 von 454 Mails  (zweimal)
//
// Neun Bündel scheitern nicht gleichzeitig, wenn sie nacheinander laufen. In
// n8n standen dazu fünf Inbox-Triage-Läufe, gestartet zwischen 16:02:42 und
// 16:02:55, jeder rot nach rund 345 Sekunden. Sie rechneten nicht nacheinander,
// sondern gegeneinander — drei Kerne, ein Ollama.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const schlange = require('../src/services/ollamaSchlange');

const schlafen = (ms) => new Promise((f) => { setTimeout(f, ms); });

beforeEach(() => { schlange._zuruecksetzen(); });

describe('Die Warteschlange lässt nur eine Anfrage durch', () => {
  test('zwei Aufgaben überlappen sich nicht', async () => {
    let gleichzeitig = 0;
    let hoechste = 0;
    const aufgabe = async () => {
      gleichzeitig += 1;
      if (gleichzeitig > hoechste) hoechste = gleichzeitig;
      await schlafen(20);
      gleichzeitig -= 1;
      return 'fertig';
    };

    const alle = await Promise.all([
      schlange.nacheinander(aufgabe),
      schlange.nacheinander(aufgabe),
      schlange.nacheinander(aufgabe),
    ]);

    assert.equal(hoechste, 1, 'genau das war der Fehler: drei Anfragen auf einmal');
    assert.deepEqual(alle, ['fertig', 'fertig', 'fertig'], 'trotzdem kommt jede dran');
  });

  test('die Reihenfolge bleibt erhalten', async () => {
    const gelaufen = [];
    const bauen = (n) => () => schlafen(5).then(() => { gelaufen.push(n); });
    await Promise.all([1, 2, 3, 4].map((n) => schlange.nacheinander(bauen(n))));
    assert.deepEqual(gelaufen, [1, 2, 3, 4]);
  });

  // Eine Aufgabe, die scheitert, darf die Schlange nicht verstopfen — sonst
  // steht das Panel nach dem ersten Fehler bis zum Neustart.
  test('ein Fehler blockiert die Schlange nicht', async () => {
    const kaputt = schlange.nacheinander(async () => { throw new Error('geplatzt'); });
    await assert.rejects(kaputt, /geplatzt/);
    assert.equal(await schlange.nacheinander(async () => 'geht noch'), 'geht noch');
    assert.equal(schlange.stand().inArbeit, false);
  });
});

describe('Warten hat eine Grenze', () => {
  // Sonst wartet ein Lauf die ganze Frist ab und meldet danach „0 von 454" —
  // dieselbe Zeile wie vorher, nur aus einem anderen Grund.
  test('wer zu lange ansteht, wird abgewiesen', async () => {
    const lang = schlange.nacheinander(() => schlafen(200));
    const kurz = schlange.nacheinander(() => schlafen(5), 30);
    await assert.rejects(kurz, /beschäftigt/);
    await lang;
  });

  // Ein freier Platz sofort — dann darf die Grenze nicht greifen.
  test('ohne Andrang wird nicht abgewiesen', async () => {
    assert.equal(await schlange.nacheinander(async () => 'sofort', 1), 'sofort');
  });

  // Der Klassifizierer erkennt daran, dass Weiterfragen sinnlos ist.
  test('die Absage ist als Zeitproblem erkennbar', async () => {
    const lang = schlange.nacheinander(() => schlafen(200));
    let fehler = '';
    try { await schlange.nacheinander(() => schlafen(5), 20); } catch (e) { fehler = e.message; }
    const wieImKlassifizierer = /timeout|aborted|abgebrochen|ETIMEDOUT|beschäftigt/i;
    assert.match(fehler, wieImKlassifizierer,
      'sonst fragt der Lauf das nächste Bündel und verbrennt den Rest der Frist');
    await lang;
  });
});

describe('Der Stand ist für die Diagnoseseite lesbar', () => {
  test('inArbeit und wartend zählen mit', async () => {
    assert.deepEqual(schlange.stand().inArbeit, false);
    const lang = schlange.nacheinander(() => schlafen(60));
    const zweite = schlange.nacheinander(() => schlafen(1));
    await schlafen(10);
    const s = schlange.stand();
    assert.equal(s.inArbeit, true);
    assert.equal(s.wartend, 1, 'die zweite steht an — genau das will man im Bericht sehen');
    await Promise.all([lang, zweite]);
    assert.equal(schlange.stand().inArbeit, false);
    assert.ok(schlange.stand().laengsteWarteSekunden >= 0);
  });
});

// Dieselbe Frage aus der anderen Richtung: Der Bericht soll es sagen, statt
// dass man Startzeit plus Dauer im Kopf addiert.
describe('Die Diagnose zählt überlappende Läufe', () => {
  const diagnose = require('../src/services/diagnose');
  const z = (sek) => new Date(Date.UTC(2026, 8, 8, 16, 0, sek)).toISOString();

  test('nacheinander ist eins', () => {
    assert.equal(diagnose.gleichzeitigkeit([
      { start: z(0), dauerSekunden: 10 },
      { start: z(20), dauerSekunden: 10 },
    ]), 1);
  });

  // Genau der Fall aus dem Bericht: fuenf Inbox-Triage-Laeufe, gestartet
  // zwischen 16:02:42 und 16:02:55, jeder rund 345 Sekunden lang.
  test('fünf sich überlappende Läufe sind fünf', () => {
    const laeufe = [0, 3, 6, 7, 13].map((s) => ({ start: z(s), dauerSekunden: 345 }));
    assert.equal(diagnose.gleichzeitigkeit(laeufe), 5);
  });

  test('ein Lauf, der endet, wenn der nächste beginnt, zählt nicht doppelt', () => {
    assert.equal(diagnose.gleichzeitigkeit([
      { start: z(0), dauerSekunden: 10 },
      { start: z(10), dauerSekunden: 10 },
    ]), 1);
  });

  test('noch laufende Einträge ohne Dauer stürzen nicht ab', () => {
    assert.equal(diagnose.gleichzeitigkeit([
      { start: z(0), dauerSekunden: null },
      { start: 'kaputt', dauerSekunden: 5 },
      {},
    ]), 1);
  });

  test('keine Läufe sind keine', () => {
    assert.equal(diagnose.gleichzeitigkeit([]), 0);
  });
});

// Ein Hinweis, der bei richtiger Einstellung Alarm schlaegt, ist schlimmer als
// keiner: Er schickt den Leser auf die Suche nach einem Fehler, den es nicht
// gibt. Die Compose deckelt ab Werk auf 2.
describe('Der Hinweis zu überlappenden Läufen', () => {
  const settings = require('../src/services/settings');
  const diagnose = require('../src/services/diagnose');
  const z = (sek) => new Date(Date.UTC(2026, 8, 8, 22, 0, sek)).toISOString();
  const laeufe = (n) => Array.from({ length: n }, (_, i) => ({ start: z(i), dauerSekunden: 300 }));

  const hinweisFuer = async (n) => {
    const n8n = require('../src/services/n8n');
    const altWf = n8n.workflowsAuflisten;
    const altEx = n8n.executionsAuflisten;
    n8n.workflowsAuflisten = async () => [];
    n8n.executionsAuflisten = async () => laeufe(n).map((l) => ({
      startedAt: l.start, status: 'success', workflowId: 'W',
      stoppedAt: new Date(Date.parse(l.start) + l.dauerSekunden * 1000).toISOString(),
    }));
    try {
      const b = await diagnose.erstellen({ mitMails: false });
      return b.laeufe;
    } finally {
      n8n.workflowsAuflisten = altWf;
      n8n.executionsAuflisten = altEx;
    }
  };

  test('bei zwei Läufen wird nicht die Compose verdächtigt', async () => {
    settings.setze('ki_anbieter', 'ollama');
    const r = await hinweisFuer(2);
    assert.equal(r.hoechsteGleichzeitig, 2);
    assert.match(r.hinweis, /Standardwert/);
    assert.ok(!/git pull/.test(r.hinweis), 'zwei Laeufe sind der eingestellte Zustand');
  });

  test('darüber schon', async () => {
    settings.setze('ki_anbieter', 'ollama');
    const r = await hinweisFuer(4);
    assert.equal(r.hoechsteGleichzeitig, 4);
    assert.match(r.hinweis, /git pull/);
  });

  test('ein einzelner Lauf ist kein Hinweis wert', async () => {
    settings.setze('ki_anbieter', 'ollama');
    const r = await hinweisFuer(1);
    assert.equal(r.hinweis, undefined);
  });

  test('mit Gemini ist Gleichzeitigkeit kein Problem', async () => {
    settings.setze('ki_anbieter', 'gemini');
    const r = await hinweisFuer(4);
    assert.equal(r.hinweis, undefined, 'dort rechnet Google, nicht dieser Server');
  });
});
