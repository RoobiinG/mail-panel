// Wie schnell ist die lokale KI wirklich?
//
// Vier Builds lang stand in jeder Meldung „0 von N Mails klassifiziert", und
// vier Builds lang wurde geraten, woran es liegt — weil ein Zeitlimit nur
// „mehr als X" sagt, nie „wie viel mehr". Ob ein Bündel 200 Sekunden gebraucht
// hätte oder 2000, sah im Log identisch aus: abgebrochen.
//
// Dabei liefert Ollama die Zahlen bei jeder Antwort mit. Diese Datei prüft,
// dass sie richtig ankommen — und dass die Fälle, um die es geht, nämlich die
// abgebrochenen, nicht aus der Statistik herausfallen.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const messung = require('../src/services/ollamaMessung');

// Eine echte Ollama-Antwort, gekürzt auf die Kennzahlen. Alle Zeiten in
// Nanosekunden — das ist Ollamas Einheit, und genau daran scheitert man beim
// ersten Lesen der Antwort.
const ANTWORT = {
  response: '{"treffer":[]}',
  done: true,
  done_reason: 'stop',
  total_duration: 124_000_000_000,
  load_duration: 2_000_000_000,
  prompt_eval_count: 4200,
  prompt_eval_duration: 84_000_000_000,
  eval_count: 190,
  eval_duration: 38_000_000_000,
};

beforeEach(() => { messung._zuruecksetzen(); });

describe('Ollamas Kennzahlen werden richtig umgerechnet', () => {
  test('Nanosekunden werden zu Sekunden', () => {
    const k = messung.kennzahlen(ANTWORT, 'llama3.2:1b');
    assert.equal(k.sekunden, 124);
    assert.equal(k.promptSekunden, 84);
    assert.equal(k.antwortSekunden, 38);
    assert.equal(k.ladenSekunden, 2);
  });

  test('Token je Sekunde — die Zahl, die die Frage beantwortet', () => {
    const k = messung.kennzahlen(ANTWORT, 'llama3.2:1b');
    assert.equal(k.promptProSekunde, 50, '4200 Token in 84 s');
    assert.equal(k.antwortProSekunde, 5, '190 Token in 38 s');
  });

  // Steckt die Zeit im Lesen, hilft ein kleineres Bündel; steckt sie im
  // Schreiben, ist das Modell zu groß. Das eine mit dem anderen zu verwechseln
  // hat hier schon Tage gekostet — also müssen beide Zahlen getrennt ankommen.
  test('Lesen und Schreiben bleiben getrennt', () => {
    const k = messung.kennzahlen(ANTWORT, 'x');
    assert.ok(k.promptSekunden > k.antwortSekunden,
      'in diesem Beispiel steckt die Zeit im Prompt — das muss sichtbar bleiben');
  });

  // Nicht jede Ollama-Fassung liefert jedes Feld; bei einem zwischengespeicherten
  // Prompt fehlt prompt_eval_count schon lange. Eine 0 würde später als
  // „ging unendlich schnell" durch den Mittelwert laufen.
  test('fehlende Felder werden null, nicht 0', () => {
    const k = messung.kennzahlen({ total_duration: 5_000_000_000 }, 'x');
    assert.equal(k.sekunden, 5);
    assert.equal(k.promptToken, null);
    assert.equal(k.promptSekunden, null);
    assert.equal(k.promptProSekunde, null);
    assert.equal(k.antwortProSekunde, null);
  });

  test('eine leere Antwort stürzt nicht ab', () => {
    const k = messung.kennzahlen(undefined, undefined);
    assert.equal(k.sekunden, null);
    assert.equal(k.abgebrochen, false);
  });
});

describe('Der Satz fürs Log ist lesbar', () => {
  test('er nennt beide Anteile und die Summe', () => {
    const s = messung.satz(messung.kennzahlen(ANTWORT, 'llama3.2:1b'));
    assert.match(s, /llama3\.2:1b/);
    assert.match(s, /4200 Token Prompt in 84 s gelesen \(50\/s\)/);
    assert.match(s, /190 Token Antwort in 38 s geschrieben \(5\/s\)/);
    assert.match(s, /zusammen 124 s/);
  });

  test('ohne Kennzahlen wird nicht gelogen', () => {
    assert.match(messung.satz(messung.kennzahlen({}, 'x')), /ohne Kennzahlen/);
  });

  test('ein Abbruch sagt, dass er einer ist', () => {
    const s = messung.satz(messung.abbruch('llama3.2', 240.5, 'timeout'));
    assert.match(s, /nach 240\.5 s abgebrochen/);
    assert.match(s, /timeout/);
  });
});

describe('Die Statistik zählt auch das, was nicht geklappt hat', () => {
  // Sonst misst sie ausgerechnet die Fälle nicht, um die es geht — und der
  // Mittelwert sieht umso besser aus, je öfter es schiefgeht.
  test('Abbrüche erscheinen im Stand', () => {
    messung.merken(messung.kennzahlen(ANTWORT, 'a'));
    messung.merken(messung.abbruch('a', 240, 'timeout'));
    const s = messung.stand();
    assert.equal(s.anfragen, 2);
    assert.equal(s.davonAbgebrochen, 1);
  });

  test('der Mittelwert rechnet nur mit den fertigen', () => {
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 100_000_000_000 }, 'a'));
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 200_000_000_000 }, 'a'));
    messung.merken(messung.abbruch('a', 999, 'timeout'));
    const s = messung.stand();
    assert.equal(s.mittel.sekunden, 150, 'die 999 des Abbruchs gehoeren nicht in den Mittelwert');
    assert.equal(s.schnellsteSekunden, 100);
    assert.equal(s.langsamsteSekunden, 200);
  });

  test('ohne jede Anfrage bleibt alles null statt NaN', () => {
    const s = messung.stand();
    assert.equal(s.anfragen, 0);
    assert.equal(s.mittel.sekunden, null);
    assert.equal(s.schnellsteSekunden, null);
    assert.deepEqual(s.letzte, []);
  });

  // Eine Betriebsanzeige, kein Archiv: Der Diagnosebericht ist ohnehin lang.
  test('es bleiben höchstens die letzten paar Anfragen liegen', () => {
    for (let i = 0; i < messung.MAX + 5; i += 1) {
      messung.merken(messung.kennzahlen(ANTWORT, `m${i}`));
    }
    const s = messung.stand();
    assert.equal(s.anfragen, messung.MAX);
    assert.ok(s.letzte.length <= 5);
    assert.equal(s.letzte[s.letzte.length - 1].modell, `m${messung.MAX + 4}`,
      'die juengste Anfrage steht hinten');
  });

  test('fehlende Kennzahlen ziehen den Mittelwert nicht nach unten', () => {
    messung.merken(messung.kennzahlen({ ...ANTWORT }, 'a'));
    messung.merken(messung.kennzahlen({ total_duration: 124_000_000_000 }, 'a'));
    const s = messung.stand();
    assert.equal(s.mittel.promptToken, 4200, 'die Anfrage ohne Zahl zaehlt gar nicht mit');
    assert.equal(s.mittel.sekunden, 124);
  });
});
