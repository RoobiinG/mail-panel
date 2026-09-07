// Googles Tag beginnt nicht um Mitternacht — jedenfalls nicht um unsere.
//
// In Googles Dokumentation steht wörtlich: *„Requests per day (RPD) quotas
// reset at midnight Pacific time."* Das Panel rechnete dagegen mit der lokalen
// Mitternacht. Zwischen 00:00 und 09:00 unserer Zeit hielt es den Tag deshalb
// für neu, während Google noch den alten zählte:
//
//   * der Anfragen-Zähler stand auf 0,
//   * die beobachtete Grenze von gestern war verworfen,
//   * also holte jeder Lauf brav 200 Mails, schickte sie an Gemini —
//   * und bekam sie alle abgewiesen, weil das gestrige Kontingent noch galt.
//
// Genau das war zu sehen: Die Nachtläufe um 00:00, 03:17, 04:00 und 04:27
// liefen zwanzig bis dreißig Sekunden durch, meldeten „erfolgreich" und
// sortierten keine einzige Mail.
//
// Diese Datei hat bewusst keine Abhängigkeiten: Sie wird von budget.js,
// kiKontingent.js und kiModell.js gebraucht, und die verweisen schon
// gegenseitig aufeinander.
const ZONE = 'America/Los_Angeles';

let gewarnt = false;

/**
 * Der Tag, nach dem Googles Kontingent zählt — „YYYY-MM-DD".
 * @param {Date} [zeitpunkt]
 */
function kiTag(zeitpunkt = new Date()) {
  try {
    // sv-SE liefert genau die Form YYYY-MM-DD, ohne eigenes Zusammenbauen.
    return zeitpunkt.toLocaleDateString('sv-SE', { timeZone: ZONE });
  } catch (err) {
    // Ohne vollständige Zeitzonendaten (sehr kleine Node-Bauten) bleibt nur die
    // lokale Zeit. Dann stimmt die Tagesgrenze nachts wieder nicht — aber ein
    // Absturz an dieser Stelle wäre deutlich schlimmer.
    if (!gewarnt) {
      gewarnt = true;
      try {
        require('./panelLog').loggen('warn', 'ki-tag',
          `Zeitzone ${ZONE} nicht verfügbar (${err.message}) — die Tagesgrenze des KI-Kontingents `
          + 'folgt deshalb der lokalen Zeit und liegt nachts daneben.');
      } catch { /* auch das Protokoll darf hier nichts umwerfen */ }
    }
    return zeitpunkt.toLocaleDateString('sv-SE');
  }
}

// Wie weit liegt der Pazifik gerade hinter UTC? Sieben Stunden im Sommer, acht
// im Winter — ausgerechnet statt geraten, damit die Umstellung nicht zweimal im
// Jahr eine Stunde danebenliegt.
function offsetStunden(zeitpunkt = new Date()) {
  try {
    const alsUtc = new Date(zeitpunkt.toLocaleString('en-US', { timeZone: 'UTC' }));
    const alsPt = new Date(zeitpunkt.toLocaleString('en-US', { timeZone: ZONE }));
    return Math.round((alsUtc.getTime() - alsPt.getTime()) / 3600000);
  } catch { return 0; }
}

/**
 * Wann Googles Tag begonnen hat — als UTC-Zeitstempel für SQLite.
 *
 * Gebraucht, damit die Mail-Zählung im Dashboard denselben Tag meint wie der
 * Anfragen-Zähler. Sonst springt die eine Zahl um Mitternacht und die andere
 * erst um neun, und niemand versteht mehr, worauf sich der Deckel bezieht.
 */
function tagesBeginnIso(zeitpunkt = new Date()) {
  const beginn = Date.parse(`${kiTag(zeitpunkt)}T00:00:00Z`) + offsetStunden(zeitpunkt) * 3600000;
  return new Date(beginn).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { kiTag, tagesBeginnIso, offsetStunden, ZONE };
