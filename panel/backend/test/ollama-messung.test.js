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

  // Ein Reverse-Proxy vor Ollama antwortet nach seiner eigenen, meist kürzeren
  // Frist mit einem sauberen 504/502 — das Panel hätte noch gewartet, durfte
  // aber nicht. Das sieht aus wie ein Abbruch, ist aber eine andere Ursache
  // mit einer anderen Abhilfe (Reverse-Proxy anpassen statt Frist verlängern)
  // und braucht deshalb eine eigene Zählung.
  test('Gateway-Timeouts zählen extra, nicht nur als Abbruch', () => {
    messung.merken(messung.abbruch('a', 60, '504', 'gateway'));
    messung.merken(messung.abbruch('a', 240, 'aborted', 'netzwerk'));
    const s = messung.stand();
    assert.equal(s.davonAbgebrochen, 2, 'beide sind Abbrüche');
    assert.equal(s.davonGatewayTimeout, 1, 'aber nur einer davon ein Gateway-Timeout');
  });

  test('ohne Angabe gilt ein Abbruch als "netzwerk", nicht als Gateway-Timeout', () => {
    messung.merken(messung.abbruch('a', 240, 'aborted'));
    assert.equal(messung.stand().davonGatewayTimeout, 0);
  });

  test('letzte nennt bei einem Abbruch auch die Art und den Grund', () => {
    messung.merken(messung.abbruch('a', 60, 'Gateway-Zeitüberschreitung (504)', 'gateway'));
    const eintrag = messung.stand().letzte.at(-1);
    assert.equal(eintrag.abgebrochen, true);
    assert.equal(eintrag.art, 'gateway');
    assert.equal(eintrag.grund, 'Gateway-Zeitüberschreitung (504)');
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

// ─── Die Zahl, wegen der überhaupt gemessen wird ─────────────────────────────
//
// Der Lauf muss vor jeder Anfrage entscheiden, ob sie in die Restzeit passt.
// Bis Build 219 stand dort ein fester Mindestwert von 20 Sekunden — bei einem
// Modell, das gemessen 60 bis 89 Sekunden braucht, startete der Lauf also
// Anfragen, die nicht zurückkommen konnten. Zwei davon hintereinander beendeten
// ihn ("nicht innerhalb von 50 s geantwortet — 140 von 492 Mails").
describe('Die erwartete Dauer', () => {
  beforeEach(() => messung._zuruecksetzen());

  test('ohne Messwerte gibt es keine Schätzung', () => {
    assert.equal(messung.erwarteteDauerMs(), null);
  });

  test('ein einzelner Wert ist noch kein Maß', () => {
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 60_000_000_000 }, 'a'));
    assert.equal(messung.erwarteteDauerMs(), null);
  });

  // Vorsichtig, nicht mittig: Eine Anfrage, die zu spät kommt, ist ganz
  // verloren — eine, die zu früh aufhört, kostet nur Restzeit.
  test('gerechnet wird mit der langsamsten, nicht mit dem Mittel', () => {
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 40_000_000_000 }, 'a'));
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 90_000_000_000 }, 'a'));
    assert.equal(messung.erwarteteDauerMs(), 90_000);
  });

  test('Abbrüche zählen nicht mit — ihre Dauer ist das Zeitlimit, nicht die Wahrheit', () => {
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 40_000_000_000 }, 'a'));
    messung.merken(messung.kennzahlen({ ...ANTWORT, total_duration: 50_000_000_000 }, 'a'));
    messung.merken(messung.abbruch('a', 999, 'timeout'));
    assert.equal(messung.erwarteteDauerMs(), 50_000);
  });
});

// ─── Größe der Anfrage und Proxy-Grenze ──────────────────────────────────────
//
// Diagnosebericht 17.09.: Ein Fünfer-Bündel mit 89,9 s bestimmte die
// Restzeit-Prüfung auch für einzelne Mails (5–30 s) — die wurden nach einem 504
// deshalb gar nicht mehr gestartet. Die Messung muss wissen, wie groß eine
// Anfrage war.
describe('Messungen kennen die Größe der Anfrage', () => {
  const fertig = (sek, mails) => messung.merken(
    messung.kennzahlen({ ...ANTWORT, total_duration: sek * 1e9 }, 'a', mails),
  );

  test('erwarteteDauerMs(1) übersieht große Bündel', () => {
    fertig(90, 5);
    fertig(85, 5);
    fertig(12, 1);
    fertig(9, 1);
    assert.equal(messung.erwarteteDauerMs(1), 12_000);
    assert.equal(messung.erwarteteDauerMs(5), 90_000);
  });

  test('ohne Angabe gilt wie bisher die langsamste überhaupt', () => {
    fertig(90, 5);
    fertig(12, 1);
    assert.equal(messung.erwarteteDauerMs(), 90_000);
  });

  test('Messungen ohne Größe zählen nur, wenn nach keiner Größe gefragt ist', () => {
    fertig(40);
    fertig(30);
    assert.equal(messung.erwarteteDauerMs(1), null);
    assert.equal(messung.erwarteteDauerMs(), 40_000);
  });

  test('letzte nennt die Größe', () => {
    fertig(12, 3);
    assert.equal(messung.stand().letzte.at(-1).mails, 3);
  });
});

describe('Die Proxy-Grenze und was daraus folgt', () => {
  test('ohne Gateway-Abbruch keine Grenze und keine Kappung', () => {
    messung.merken(messung.abbruch('a', 240, 'aborted', 'netzwerk', 5));
    assert.equal(messung.gatewayGrenzeMs(), null);
    assert.equal(messung.sichereBuendelGroesse(), null);
  });

  test('die Grenze ist der kürzeste Gateway-Abbruch', () => {
    messung.merken(messung.abbruch('a', 92, '504', 'gateway', 5));
    messung.merken(messung.abbruch('a', 90, '504', 'gateway', 4));
    assert.equal(messung.gatewayGrenzeMs(), 90_000);
    assert.equal(messung.stand().gatewayGrenzeSekunden, 90);
  });

  test('ein 504 bei fünf Mails heißt: höchstens zwei', () => {
    messung.merken(messung.abbruch('a', 90, '504', 'gateway', 5));
    assert.equal(messung.sichereBuendelGroesse(), 2);
    assert.equal(messung.stand().sichereBuendelGroesse, 2);
  });

  test('ein 504 bei zwei Mails heißt: einzeln', () => {
    messung.merken(messung.abbruch('a', 90, '504', 'gateway', 5));
    messung.merken(messung.abbruch('a', 90, '504', 'gateway', 2));
    assert.equal(messung.sichereBuendelGroesse(), 1);
  });

  test('ein 504 bei einer einzelnen Mail kappt nichts — kleiner geht es nicht', () => {
    messung.merken(messung.abbruch('a', 90, '504', 'gateway', 1));
    assert.equal(messung.sichereBuendelGroesse(), null);
  });
});
