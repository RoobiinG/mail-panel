// Hält die n8n-Workflows von selbst auf Stand.
//
// Bisher war „Workflows → Synchronisieren" ein Knopf, den man drücken musste —
// und wer ihn vergaß, betrieb eine Konfiguration, die nur im Panel stand. Am
// deutlichsten beim Wechsel des KI-Anbieters: In den Einstellungen stand
// „Ollama", in n8n rief der Workflow weiter Google. Nichts deutete darauf hin;
// die Läufe waren grün und sortierten nur nichts.
//
// Zwei Anlässe:
//   * Beim Start des Containers — mit Wiederholungen, weil n8n oft noch
//     hochfährt, wenn das Panel schon steht.
//   * Nach jeder Änderung, die in den Workflows landet (KI-Anbieter, Modell,
//     Takt, Denkstufe, Umgang mit neuer Post …).
//
// Zwei Läufe gleichzeitig gibt es nie, und mehrere Anlässe kurz hintereinander
// werden zu einem zusammengefasst: Ein Sync schreibt jeden Workflow in n8n neu,
// das soll kein Dauerlauf werden.
const settings = require('./settings');
const db = require('../db');
const { loggen } = require('./panelLog');

const AN = () => settings.hole('auto_sync') !== '0';

let laeuftGerade = false;
let geplanteUhr = null;
let letzterLauf = null;   // { zeitpunkt, ok, hinweis }

function konten() {
  try {
    return db.prepare('SELECT * FROM accounts WHERE aktiv = 1 ORDER BY id').all();
  } catch {
    return [];
  }
}

// Ohne n8n-Zugang hat ein Sync nichts zu tun — und soll auch nicht alle paar
// Minuten dieselbe Fehlermeldung ins Log schreiben.
function bereit() {
  return Boolean(settings.hole('n8n_url')) && Boolean(settings.hole('n8n_api_key'));
}

async function jetzt(grund) {
  if (laeuftGerade) return { uebersprungen: 'läuft schon' };
  if (!AN()) return { uebersprungen: 'abgeschaltet' };
  if (!bereit()) return { uebersprungen: 'kein n8n-Zugang hinterlegt' };

  laeuftGerade = true;
  const patcher = require('./workflowPatcher');
  try {
    // Erst die Vorlagen: Fehlt ein Workflow ganz, kann der Sync ihn nicht
    // verdrahten.
    await patcher.basisSetup();
    const liste = konten();
    const ergebnis = liste.length > 0 ? await patcher.alleSynchronisieren(liste) : [];
    letzterLauf = { zeitpunkt: new Date().toISOString(), ok: true, grund };
    loggen('info', 'backend:autosync', `Workflows abgeglichen (${grund}).`);
    return { ok: true, ergebnis };
  } catch (err) {
    letzterLauf = { zeitpunkt: new Date().toISOString(), ok: false, grund, hinweis: err.message };
    loggen('warn', 'backend:autosync', `Abgleich fehlgeschlagen (${grund}): ${err.message}`);
    return { ok: false, fehler: err.message };
  } finally {
    laeuftGerade = false;
  }
}

/**
 * Einen Abgleich anstoßen — entprellt.
 * Wer zehn Felder speichert, löst nicht zehn Läufe aus.
 */
function anstossen(grund, verzoegerungMs = 4000) {
  if (!AN()) return;
  if (geplanteUhr) clearTimeout(geplanteUhr);
  geplanteUhr = setTimeout(() => {
    geplanteUhr = null;
    jetzt(grund).catch(() => { /* jetzt() meldet selbst */ });
  }, verzoegerungMs);
  if (geplanteUhr.unref) geplanteUhr.unref();
}

/**
 * Beim Containerstart. n8n braucht oft eine Weile, bis seine API antwortet —
 * deshalb mehrere Anläufe mit wachsendem Abstand, statt einmal zu scheitern und
 * den Tag über falsch verdrahtet zu laufen.
 */
function beimStart(abstaende = [20000, 60000, 180000]) {
  if (!AN()) {
    console.log('[autoSync] abgeschaltet (auto_sync = 0)');
    return;
  }
  let versuch = 0;
  const naechster = () => {
    const wartezeit = abstaende[Math.min(versuch, abstaende.length - 1)];
    const uhr = setTimeout(async () => {
      versuch += 1;
      const r = await jetzt('Containerstart');
      // Erfolg oder ein Grund, der sich durch Warten nicht ändert: fertig.
      if (r.ok || r.uebersprungen === 'abgeschaltet') return;
      if (versuch < abstaende.length) naechster();
      else if (!r.ok) {
        loggen('warn', 'backend:autosync',
          'Workflows liessen sich beim Start nicht abgleichen. '
          + 'Unter Workflows → Synchronisieren lässt sich das von Hand nachholen.');
      }
    }, wartezeit);
    if (uhr.unref) uhr.unref();
  };
  naechster();
}

function stand() {
  return { aktiv: AN(), laeuft: laeuftGerade, letzter: letzterLauf };
}

module.exports = { jetzt, anstossen, beimStart, stand };
