// Wie viele KI-Abfragen lässt Google heute noch zu?
//
// Die ehrliche Antwort zuerst: **Google gibt das nicht heraus.** Die Gemini-API
// liefert keine Kopfzeile mit dem Rest, und es gibt keinen Endpunkt, den man
// fragen könnte. Die offizielle Dokumentation verweist für den Verbrauch auf das
// Dashboard im AI Studio — sonst nichts. Wer eine Zahl im Panel sehen will,
// bekommt sie also nur aus zwei eigenen Quellen:
//
//   1. **Selbst zählen.** Das tut das Panel seit Build 89 ehrlich: Jede Zeile im
//      Quarantäne-Log mit ki = 1 war eine Abfrage bei Gemini. Regel-Mails, die an
//      der KI vorbeilaufen, zählen nicht mit.
//   2. **Das Limit lernen.** Weist Google ab, ist der eigene Tagesstand in genau
//      diesem Moment das, was durchgegangen ist — das praktische Tageslimit für
//      dieses Konto und Modell. Danach lässt sich das Budget setzen, und das
//      Panel stoppt künftig von selbst, bevor Google es tut.
//
// Punkt 2 braucht die Fehlermeldung aus n8n. Die holt sich die Aufsicht bei
// ihrem Rundgang — und zwar sparsam: höchstens zwei Detailabfragen, und nur
// solange für heute noch keine Abweisung bekannt ist. Eine Detailabfrage bringt
// die kompletten Ausführungsdaten mit, das sind bei 170 Mails einige Megabyte.
const settings = require('./settings');
const n8n = require('./n8n');
const budget = require('./budget');
const { loggen } = require('./panelLog');

// Womit Google (über n8n) eine Abweisung wegen Kontingent meldet.
const KONTINGENT = /too many requests|resource.?exhausted|rate.?limit|quota|\b429\b/i;

const heute = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, lokal

/**
 * Was das Panel über das Tageslimit weiß.
 * @returns {{verbraucht:number, grenze:number, rest:number|null,
 *            beobachtet:{stand:number, zeit:string}|null, quelle:string}}
 */
function stand() {
  const grenze = budget.tagesbudget();
  const verbraucht = budget.heuteVerbraucht();

  let beobachtet = null;
  if (settings.hole('ki_429_tag') === heute()) {
    const zahl = Number(settings.hole('ki_429_stand'));
    if (Number.isFinite(zahl) && zahl > 0) {
      beobachtet = { stand: zahl, zeit: settings.hole('ki_429_zeit') || null };
    }
  }

  return {
    verbraucht,
    grenze,
    rest: grenze ? Math.max(0, grenze - verbraucht) : null,
    beobachtet,
    // Damit die Oberfläche nicht so tut, als käme die Zahl von Google.
    quelle: 'eigene Zählung',
  };
}

// Eine Abweisung festhalten. Der Tagesstand in diesem Moment ist die Zahl, auf
// die es ankommt: So viele Abfragen sind heute durchgegangen, bevor Google
// dichtmachte.
function abweisungMerken(zeitpunkt) {
  const stand429 = budget.heuteVerbraucht();
  settings.setze('ki_429_tag', heute());
  settings.setze('ki_429_stand', String(stand429));
  settings.setze('ki_429_zeit', zeitpunkt || new Date().toISOString());
  loggen('warn', 'ki-kontingent',
    `Google hat abgewiesen — heute waren ${stand429} KI-Abfragen durchgegangen. `
    + 'Das KI-Tagesbudget knapp darunter zu setzen, beendet die Läufe künftig sauber.');

  // Ist ein Ersatzmodell eingetragen, wird jetzt darauf gewechselt: Dessen
  // Tageskontingent ist ein eigenes. Ohne Ersatzmodell passiert nichts.
  // Absichtlich ohne await — der Wechsel schreibt in n8n und darf den Aufrufer
  // (auch den Beleg-Leser mitten in einem Lauf) nicht aufhalten.
  try {
    require('./kiModell').beiAbweisung().catch((err) => {
      loggen('warn', 'ki-kontingent', `Modellwechsel fehlgeschlagen: ${err.message}`);
    });
  } catch { /* kein Modellwechsel eingerichtet */ }

  return stand429;
}

/**
 * Sucht in den letzten n8n-Ausführungen nach einer Abweisung wegen Kontingent.
 * Wird von der Aufsicht aufgerufen; Fehler bleiben hier und stören sie nicht.
 */
async function nachAbweisungSehen() {
  // Für heute schon bekannt? Dann ist nichts mehr zu holen.
  if (settings.hole('ki_429_tag') === heute()) return null;

  let laeufe;
  try {
    laeufe = await n8n.executionsAuflisten(20);
  } catch { return null; }

  const gesehen = Number(settings.hole('ki_429_gesehen_id')) || 0;
  const kandidaten = laeufe
    .filter((l) => ['error', 'crashed'].includes(String(l.status)))
    .filter((l) => Number(l.id) > gesehen)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 2);

  if (kandidaten.length === 0) return null;
  // Auch ohne Treffer merken, wie weit geschaut wurde — sonst holt jede Runde
  // dieselben Ausführungen erneut.
  settings.setze('ki_429_gesehen_id', String(Math.max(...kandidaten.map((k) => Number(k.id)))));

  for (const lauf of kandidaten) {
    try {
      const { data } = await n8n.client().get(`/executions/${lauf.id}`, { params: { includeData: true } });
      let daten = data.data;
      if (typeof daten === 'string') { try { daten = JSON.parse(daten); } catch { daten = null; } }
      const meldung = String(daten?.resultData?.error?.message || '');
      if (KONTINGENT.test(meldung)) {
        return abweisungMerken(lauf.stoppedAt || lauf.startedAt);
      }
    } catch { /* eine Ausführung, die sich nicht laden laesst, ist kein Drama */ }
  }
  return null;
}

module.exports = { stand, nachAbweisungSehen, abweisungMerken, KONTINGENT };
