// Wie schnell ist die lokale KI wirklich?
//
// Vier Builds lang stand in jeder Meldung „0 von N Mails klassifiziert", und
// vier Builds lang wurde geraten, woran es liegt. Der Grund für das Raten ist
// einfach: Ein Zeitlimit sagt nur „mehr als X", nie „wie viel mehr". Ob ein
// Bündel 200 Sekunden gebraucht hätte oder 2000, war aus den Logs nicht zu
// erkennen — beide sehen gleich aus, nämlich abgebrochen.
//
// Dabei liefert Ollama die Antwort bei jeder Anfrage mit. In derselben
// JSON-Antwort stehen (alle in Nanosekunden):
//
//     prompt_eval_count / prompt_eval_duration   den Prompt einlesen
//     eval_count        / eval_duration          die Antwort schreiben
//     load_duration                              das Modell laden
//     total_duration                             alles zusammen
//
// Diese Aufteilung ist die eigentliche Diagnose. Auf einer CPU kostet ein
// langer Prompt fast alles im **Einlesen** — und dagegen hilft ein kleineres
// Bündel, nicht ein kleineres Modell. Steckt die Zeit dagegen im Schreiben,
// ist das Modell zu groß. Das eine mit dem anderen zu verwechseln hat hier
// schon Tage gekostet.
//
// Gehalten wird das im Speicher, nicht in der Datenbank: Es ist eine
// Betriebsanzeige für den nächsten Diagnosebericht, kein Archiv.
const MAX = 20;

let eintraege = [];

const zahlOderNull = (wert) => {
  const n = Number(wert);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Nanosekunden → Sekunden mit einer Nachkommastelle. */
function sekunden(ns) {
  const n = zahlOderNull(ns);
  return n === null ? null : Math.round(n / 1e8) / 10;
}

function proSekunde(token, sek) {
  if (!token || !sek) return null;
  return Math.round((token / sek) * 10) / 10;
}

/**
 * Liest Ollamas Kennzahlen aus einer Antwort.
 *
 * Nicht jede Fassung liefert jedes Feld — bei einem zwischengespeicherten
 * Prompt fehlt `prompt_eval_count` schon lange. Fehlende Werte werden zu
 * `null`, nicht zu 0: Eine Null würde später als „ging unendlich schnell"
 * durch den Mittelwert laufen.
 */
function kennzahlen(daten, modell) {
  const promptToken = zahlOderNull(daten?.prompt_eval_count);
  const promptSekunden = sekunden(daten?.prompt_eval_duration);
  const antwortToken = zahlOderNull(daten?.eval_count);
  const antwortSekunden = sekunden(daten?.eval_duration);
  return {
    modell: String(modell || ''),
    abgebrochen: false,
    sekunden: sekunden(daten?.total_duration),
    ladenSekunden: sekunden(daten?.load_duration),
    promptToken,
    promptSekunden,
    promptProSekunde: proSekunde(promptToken, promptSekunden),
    antwortToken,
    antwortSekunden,
    antwortProSekunde: proSekunde(antwortToken, antwortSekunden),
  };
}

/**
 * Eine Anfrage, die nie zurückkam.
 *
 * Die gehört unbedingt mitgezählt — sonst misst die Statistik ausgerechnet die
 * Fälle nicht, um die es geht, und der Mittelwert sieht umso besser aus, je
 * öfter es schiefgeht.
 */
function abbruch(modell, dauerSekunden, grund) {
  return {
    modell: String(modell || ''),
    abgebrochen: true,
    sekunden: zahlOderNull(dauerSekunden),
    grund: String(grund || '').slice(0, 200),
    promptToken: null,
    promptSekunden: null,
    promptProSekunde: null,
    antwortToken: null,
    antwortSekunden: null,
    antwortProSekunde: null,
  };
}

/** Ein Satz fürs Log — die Zahlen so, wie ein Mensch sie lesen will. */
function satz(k) {
  if (!k) return '';
  if (k.abgebrochen) {
    return `Ollama ${k.modell}: nach ${k.sekunden ?? '?'} s abgebrochen`
      + (k.grund ? ` (${k.grund})` : '');
  }
  const teile = [];
  if (k.promptToken !== null) {
    teile.push(`${k.promptToken} Token Prompt in ${k.promptSekunden ?? '?'} s gelesen`
      + (k.promptProSekunde ? ` (${k.promptProSekunde}/s)` : ''));
  }
  if (k.antwortToken !== null) {
    teile.push(`${k.antwortToken} Token Antwort in ${k.antwortSekunden ?? '?'} s geschrieben`
      + (k.antwortProSekunde ? ` (${k.antwortProSekunde}/s)` : ''));
  }
  if (k.ladenSekunden) teile.push(`${k.ladenSekunden} s Modell laden`);
  const rumpf = teile.length ? teile.join(', ') : 'ohne Kennzahlen';
  return `Ollama ${k.modell}: ${rumpf} — zusammen ${k.sekunden ?? '?'} s`;
}

function merken(k) {
  if (!k) return;
  eintraege.push({ ...k, zeitpunkt: new Date().toISOString() });
  while (eintraege.length > MAX) eintraege.shift();
}

const mittel = (werte) => {
  const gute = werte.filter((w) => typeof w === 'number' && Number.isFinite(w));
  if (gute.length === 0) return null;
  return Math.round((gute.reduce((a, b) => a + b, 0) / gute.length) * 10) / 10;
};

/**
 * Für die Diagnoseseite. Bewusst knapp: Der Bericht ist ohnehin lang, und was
 * zählt, sind der Mittelwert und der langsamste Fall.
 */
function stand() {
  const fertige = eintraege.filter((e) => !e.abgebrochen);
  const dauern = fertige.map((e) => e.sekunden).filter((s) => typeof s === 'number');
  return {
    anfragen: eintraege.length,
    davonAbgebrochen: eintraege.filter((e) => e.abgebrochen).length,
    mittel: {
      sekunden: mittel(dauern),
      promptToken: mittel(fertige.map((e) => e.promptToken)),
      promptProSekunde: mittel(fertige.map((e) => e.promptProSekunde)),
      antwortToken: mittel(fertige.map((e) => e.antwortToken)),
      antwortProSekunde: mittel(fertige.map((e) => e.antwortProSekunde)),
    },
    schnellsteSekunden: dauern.length ? Math.min(...dauern) : null,
    langsamsteSekunden: dauern.length ? Math.max(...dauern) : null,
    letzte: eintraege.slice(-5).map((e) => ({
      zeitpunkt: e.zeitpunkt,
      modell: e.modell,
      sekunden: e.sekunden,
      promptToken: e.promptToken,
      antwortToken: e.antwortToken,
      ...(e.abgebrochen ? { abgebrochen: true } : {}),
    })),
  };
}

function _zuruecksetzen() { eintraege = []; }

module.exports = { kennzahlen, abbruch, satz, merken, stand, _zuruecksetzen, MAX };
