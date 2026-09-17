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
 *
 * `art` unterscheidet WARUM: 'netzwerk' (AbortSignal, Verbindung weg — das
 * Panel selbst hat aufgegeben) gegen 'gateway' (ein sauberer 504/502 — ein
 * Reverse-Proxy vor Ollama hat aufgegeben, bevor das Panel es überhaupt
 * durfte). Beides sieht für den Aufrufer wie "abgebrochen" aus, aber die
 * Abhilfe ist eine andere: bei 'netzwerk' hilft eine längere Frist
 * (Einstellungen → KI), bei 'gateway' nur eine Änderung am Reverse-Proxy
 * selbst oder ein kleineres Bündel.
 */
function abbruch(modell, dauerSekunden, grund, art = 'netzwerk') {
  return {
    modell: String(modell || ''),
    abgebrochen: true,
    art,
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
    // Eigene Zeile, weil die Abhilfe eine andere ist als bei einem gewöhnlichen
    // Abbruch: Ein Reverse-Proxy vor Ollama, der nach seiner eigenen, meist
    // kürzeren Frist einen 504 zurückgibt, bevor das Panel überhaupt so lange
    // hätte warten wollen. Vorher stand das nirgends — die Statistik zeigte
    // "davonAbgebrochen: 0", obwohl im Log mehrfach am Tag "504" stand.
    davonGatewayTimeout: eintraege.filter((e) => e.abgebrochen && e.art === 'gateway').length,
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
      // Der Grund gehört dazu, sobald abgebrochen wurde — sonst steht im
      // Bericht nur "abgebrochen: true" und die Frage "woran?" bleibt offen.
      // Ein Netzwerkfehler (AbortSignal, Verbindung weg) und ein sauberer 504
      // vom Reverse-Proxy sehen für den Aufrufer gleich aus, sind aber zwei
      // ganz verschiedene Ursachen mit zwei ganz verschiedenen Abhilfen.
      ...(e.abgebrochen ? { abgebrochen: true, art: e.art || 'netzwerk', grund: e.grund || null } : {}),
    })),
  };
}

/**
 * Womit ist bei der nächsten Anfrage zu rechnen? — in Millisekunden.
 *
 * Gemessen wird das ohnehin; benutzt wurde es bisher nur im Diagnosebericht.
 * Dabei ist es genau die Zahl, die der Lauf braucht, um zu entscheiden, ob noch
 * eine Anfrage in die Restzeit passt. Ohne sie stand dort ein fester
 * Mindestwert von 20 Sekunden — und bei einem Modell, das im Mittel 60 braucht,
 * ist jede Anfrage, die mit 25 Sekunden Rest startet, von vornherein verloren.
 * Zwei davon hintereinander beenden den Lauf („nicht innerhalb von 50 s
 * geantwortet").
 *
 * Genommen wird der LANGSAMSTE der fertigen Läufe, nicht der Mittelwert: Eine
 * Anfrage, die zu spät kommt, ist komplett verloren — eine, die zu früh
 * aufhört, kostet nur ein bisschen ungenutzte Restzeit. Der Fehler darf also
 * ruhig auf der vorsichtigen Seite liegen.
 *
 * Ohne Messwerte (frischer Start) kommt `null` zurück; dann gilt wieder der
 * feste Mindestwert des Aufrufers.
 */
function erwarteteDauerMs() {
  const dauern = eintraege
    .filter((e) => !e.abgebrochen && typeof e.sekunden === 'number' && e.sekunden > 0)
    .map((e) => e.sekunden);
  if (dauern.length < 2) return null;   // ein einzelner Wert ist noch kein Maß
  return Math.round(Math.max(...dauern) * 1000);
}

function _zuruecksetzen() { eintraege = []; }

module.exports = { kennzahlen, abbruch, satz, merken, stand, erwarteteDauerMs, _zuruecksetzen, MAX };
