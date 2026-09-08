// Eine Anfrage nach der anderen an die lokale KI.
//
// Aus dem Bericht vom 8. September, 16:12 — in ein und derselben Sekunde:
//
//     16:08:33 WARN  Ein Buendel blieb unbeantwortet: Ollama war nicht
//                    erreichbar: fetch failed          (neunmal hintereinander)
//     16:08:33 INFO  Zeitbudget des Laufs erreicht — 0 von 26 Mails
//     16:12:25 INFO  Zeitbudget des Laufs erreicht — 0 von 454 Mails  (zweimal)
//
// Neun Bündel scheitern nicht gleichzeitig, wenn sie nacheinander laufen. Sie
// liefen nebeneinander: n8n hatte fünf Inbox-Triage-Läufe gleichzeitig offen
// (alle zwischen 16:02:42 und 16:02:55 gestartet, alle rot nach ~345 s), dazu
// die Bestands-Triage. Jeder Lauf klopft an /api/internal/klassifizieren, und
// die Schleife dort ist zwar in sich der Reihe nach — aber nichts hinderte
// sechs Schleifen daran, parallel zu laufen.
//
// Für Gemini war das nie ein Problem: Google rechnet auf seinen Maschinen.
// Ollama rechnet auf dieser hier, mit drei Kernen. Sechs gleichzeitige
// Anfragen sind nicht sechsmal schneller fertig, sondern jede einzelne
// sechsmal langsamer — und dann laufen alle zusammen ins Zeitlimit.
//
// Ollama selbst steht in der Compose auf OLLAMA_NUM_PARALLEL=1, stellt die
// Überzähligen also ohnehin in eine eigene Warteschlange. Nur sieht das Panel
// die nicht: Für den Aufrufer sieht Warten aus wie Rechnen, und sein Zeitlimit
// läuft die ganze Zeit mit. Hier zu warten ist dasselbe Warten — nur eines, bei
// dem man weiß, dass man wartet, und es abbrechen kann, bevor die Frist des
// Laufs weg ist.
const { loggen } = require('./panelLog');

let laeuft = false;
let begonnenAm = 0;
const wartend = [];

// Höchste je gemessene Wartezeit — nur für die Diagnoseseite. Sagt, ob sich
// überhaupt je eine Schlange gebildet hat.
let laengsteWarteMs = 0;

function weiter() {
  if (laeuft || wartend.length === 0) return;
  const eintrag = wartend.shift();
  if (eintrag.uhr) clearTimeout(eintrag.uhr);
  const gewartet = Date.now() - eintrag.seit;
  if (gewartet > laengsteWarteMs) laengsteWarteMs = gewartet;
  laeuft = true;
  begonnenAm = Date.now();
  Promise.resolve()
    .then(() => eintrag.aufgabe())
    .then(eintrag.erfuellen, eintrag.ablehnen)
    .finally(() => {
      laeuft = false;
      begonnenAm = 0;
      weiter();
    });
}

/**
 * Führt `aufgabe` aus, sobald keine andere Ollama-Anfrage mehr offen ist.
 *
 * @param {() => Promise<any>} aufgabe
 * @param {number} wartenMaxMs Wie lange auf einen freien Platz gewartet wird.
 *   Danach wird abgelehnt, statt eine Anfrage zu starten, deren Antwort nach
 *   dem Ende des Laufs käme. 0 heißt: unbegrenzt warten.
 * @returns {Promise<any>}
 */
function nacheinander(aufgabe, wartenMaxMs = 0) {
  return new Promise((erfuellen, ablehnen) => {
    const eintrag = { aufgabe, erfuellen, ablehnen, seit: Date.now(), uhr: null };
    // Der freie Platz kommt sofort? Dann gar nicht erst eine Uhr stellen.
    if (wartenMaxMs > 0 && (laeuft || wartend.length > 0)) {
      eintrag.uhr = setTimeout(() => {
        const i = wartend.indexOf(eintrag);
        if (i < 0) return; // hat inzwischen doch angefangen
        wartend.splice(i, 1);
        const sek = Math.round(wartenMaxMs / 1000);
        loggen('warn', 'backend:ollama',
          `Eine Anfrage wurde nach ${sek} s Warten aufgegeben — die lokale KI war die ganze Zeit `
          + 'mit einer anderen beschäftigt. Laufen mehrere Workflows gleichzeitig?');
        ablehnen(new Error(
          `Die lokale KI war ${sek} s lang mit einer anderen Anfrage beschäftigt — aufgegeben, `
          + 'bevor die Frist des Laufs abläuft.',
        ));
      }, wartenMaxMs);
      if (typeof eintrag.uhr.unref === 'function') eintrag.uhr.unref();
    }
    wartend.push(eintrag);
    weiter();
  });
}

/** Für die Diagnoseseite: Wie voll ist die Schlange gerade? */
function stand() {
  return {
    inArbeit: laeuft,
    seitSekunden: begonnenAm ? Math.round((Date.now() - begonnenAm) / 1000) : 0,
    wartend: wartend.length,
    laengsteWarteSekunden: Math.round(laengsteWarteMs / 1000),
  };
}

// Nur für die Tests: Zustand zurücksetzen.
function _zuruecksetzen() {
  laeuft = false;
  begonnenAm = 0;
  laengsteWarteMs = 0;
  while (wartend.length) {
    const e = wartend.pop();
    if (e.uhr) clearTimeout(e.uhr);
  }
}

module.exports = { nacheinander, stand, _zuruecksetzen };
