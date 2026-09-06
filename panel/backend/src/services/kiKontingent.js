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
//   2. **Das Limit lernen.** Weist Google ab, steht die Zahl in der Absage:
//      „limit: 500, model: gemini-3.5-flash-lite". Das ist das echte Tageslimit
//      für dieses Modell — und es zählt mehr als die eigene Zählung, die
//      zwangsläufig zu niedrig liegt. Ab da stoppt das Panel von selbst, bevor
//      Google es tut. Nennt die Meldung keine Zahl, bleibt der eigene Stand im
//      Moment der Abweisung die beste Schätzung.
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

// Und dann steht in derselben Meldung doch die Zahl, die es angeblich nicht
// gibt. Im Klartext aus einem echten Lauf:
//
//   "Quota exceeded for metric:
//    generativelanguage.googleapis.com/generate_content_free_tier_requests,
//    limit: 500, model: gemini-3.5-flash-lite"
//
// Das ist Googles eigenes Tageslimit für genau dieses Modell — und damit weit
// besser als die eigene Zählung, die zwangsläufig zu niedrig liegt: Stirbt ein
// Lauf bei Gemini, protokolliert das Panel keine einzige der Mails, die vorher
// sauber klassifiziert wurden. Verbraucht waren sie trotzdem.
function limitAusMeldung(meldung) {
  const t = String(meldung || '');
  const zahl = t.match(/limit:\s*(\d+)/i);
  const modell = t.match(/model:\s*([A-Za-z0-9._-]+)/i);
  return { limit: zahl ? Number(zahl[1]) : 0, modell: modell ? modell[1] : null };
}

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
    const googleLimit = Number(settings.hole('ki_429_limit')) || 0;
    if ((Number.isFinite(zahl) && zahl > 0) || googleLimit > 0) {
      beobachtet = {
        stand: Number.isFinite(zahl) ? zahl : 0,
        zeit: settings.hole('ki_429_zeit') || null,
        // Was Google selbst in der Fehlermeldung genannt hat — 0, wenn die
        // Meldung nur "too many requests" hergab.
        limit: googleLimit,
        modell: settings.hole('ki_429_modell') || null,
      };
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
function abweisungMerken(zeitpunkt, meldung) {
  const stand429 = budget.heuteVerbraucht();
  const gelesen = limitAusMeldung(meldung);
  settings.setze('ki_429_tag', heute());
  settings.setze('ki_429_stand', String(stand429));
  settings.setze('ki_429_zeit', zeitpunkt || new Date().toISOString());
  // Für welches Modell die Abweisung galt. Ohne das würde der Deckel auch das
  // Ersatzmodell aussperren — dabei ist genau dessen eigenes Kontingent der
  // Grund, warum es überhaupt eingetragen wurde.
  settings.setze('ki_429_modell', gelesen.modell || require('./kiModell').aktiv());
  settings.setze('ki_429_limit', String(gelesen.limit || 0));

  loggen('warn', 'ki-kontingent', gelesen.limit
    ? `Google hat abgewiesen: ${gelesen.limit} Anfragen pro Tag für "${gelesen.modell || 'das aktive Modell'}". `
      + `Das Panel hatte ${stand429} gezählt — die Lücke sind Mails aus Läufen, die bei Gemini `
      + 'starben und deshalb nie protokolliert wurden. Ab jetzt gilt Googles Zahl.'
    : `Google hat abgewiesen — heute waren ${stand429} KI-Abfragen durchgegangen. `
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
      // Auch die Knotenfehler mitlesen: Die ausführliche Meldung mit "limit:"
      // und "model:" steht am Gemini-Knoten, oben bleibt oft nur der erste Satz.
      const oben = String(daten?.resultData?.error?.message || '');
      const knoten = Object.values(daten?.resultData?.runData || {})
        .map((l) => String(l?.[0]?.error?.message || l?.[0]?.error?.description || ''))
        .filter(Boolean);
      const meldung = [oben, ...knoten].join(' — ');
      if (KONTINGENT.test(meldung)) {
        return abweisungMerken(lauf.stoppedAt || lauf.startedAt, meldung);
      }
    } catch { /* eine Ausführung, die sich nicht laden laesst, ist kein Drama */ }
  }
  return null;
}

module.exports = { stand, nachAbweisungSehen, abweisungMerken, limitAusMeldung, KONTINGENT };
