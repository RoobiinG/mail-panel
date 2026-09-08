// Den Text aus einem PDF holen — ohne KI, ohne Netz, ohne Google.
//
// Der Beleg-Leser schickte das PDF bisher als `inline_data` an Gemini. Das kann
// nur Gemini: Ollamas /api/generate nimmt Text und (bei Vision-Modellen) Bilder,
// aber keine PDFs. Der naheliegende Ausweg wäre ein multimodales Modell —
// llama3.2-vision ist aber 11B, und diese Maschine kämpft schon mit einem 3B
// Textmodell auf drei Kernen. Das ist keine Option.
//
// Der Umweg ist der kürzere: Fast jede Rechnung ist ein DIGITALES PDF mit
// Textebene. Der Text steht bereits darin. Ist er einmal heraus, ist es eine
// ganz gewöhnliche Textfrage — und die beantwortet jedes kleine Modell.
//
// Bewusst reines JavaScript (pdf-parse bringt seine eigene pdf.js-Kopie mit)
// statt poppler/pdftotext per `apk add`. Hier werden Anhänge von Fremden
// geparst; ein C++-Programm auf diesem Pfad wäre ein größeres Risiko als ein
// Parser, der im JS-Speichermodell bleibt. Und das Abbild braucht so weiterhin
// keine Werkzeugkette — die wird nach dem Installieren absichtlich weggeworfen.
const { loggen } = require('./panelLog');

// Eine Rechnung hat ein bis drei Seiten. Alles darüber ist entweder ein Katalog
// oder ein Versuch, den Server zu beschäftigen.
const MAX_SEITEN = 8;
const MAX_ZEICHEN = 12000;
// 20 MB Base64 sind rund 15 MB PDF. Darüber wird gar nicht erst geparst.
const MAX_BASE64 = 20 * 1024 * 1024;

// Einmal laden, Ergebnis merken. Fehlt das Paket (etwa in einem alten Abbild),
// soll das Panel nicht abstürzen, sondern ohne Textebene weiterarbeiten — dann
// greift wie bisher die Heuristik.
let parser;
let parserGeprueft = false;

function ladeParser() {
  if (parserGeprueft) return parser;
  parserGeprueft = true;
  try {
    // eslint-disable-next-line global-require
    parser = require('pdf-parse');
  } catch (err) {
    parser = null;
    loggen('warn', 'backend:pdfText',
      `PDF-Textextraktion nicht verfügbar (${err.message}) — Belege werden per Heuristik entschieden.`);
  }
  return parser;
}

/** Aus dem Rohtext eines PDF wird selten sauberer Fließtext. Etwas glätten. */
function glaetten(text) {
  return String(text || '')
    .replace(/\r/g, '')
    // Mehr als eine Leerzeile sagt nichts und kostet Token.
    .replace(/\n{3,}/g, '\n\n')
    // pdf.js setzt gern viele Leerzeichen zwischen Spalten.
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((z) => z.trim())
    .join('\n')
    .trim();
}

/**
 * @param {string} base64 PDF als Base64, mit oder ohne data:-Vorspann.
 * @returns {Promise<{ok: boolean, text: string, seiten: number, grund: string}>}
 *   `ok: false` heißt: keine Textebene da (Scan) oder nicht lesbar. Das ist kein
 *   Fehler, sondern eine Eigenschaft des Dokuments — der Aufrufer entscheidet
 *   dann per Heuristik.
 */
async function textAus(base64) {
  const leer = { ok: false, text: '', seiten: 0, grund: '' };
  const roh = String(base64 || '').replace(/^data:[^,]*,/, '');
  if (!roh) return { ...leer, grund: 'kein PDF mitgeliefert' };
  if (roh.length > MAX_BASE64) return { ...leer, grund: 'PDF zu groß' };

  const lesen = ladeParser();
  if (!lesen) return { ...leer, grund: 'Textextraktion nicht verfügbar' };

  try {
    const daten = await lesen(Buffer.from(roh, 'base64'), { max: MAX_SEITEN });
    const text = glaetten(daten?.text).slice(0, MAX_ZEICHEN);
    if (!text) {
      // Der häufigste Fall dahinter: ein eingescanntes PDF. Dafür bräuchte es
      // OCR (tesseract), und das ist eine eigene Entscheidung — 50 MB im Abbild
      // und auf dieser CPU nichts, was nebenbei läuft.
      return { ...leer, seiten: Number(daten?.numpages) || 0, grund: 'keine Textebene (Scan?)' };
    }
    return { ok: true, text, seiten: Number(daten?.numpages) || 0, grund: '' };
  } catch (err) {
    // Ein kaputtes oder verschlüsseltes PDF ist Alltag bei Maileingang und kein
    // Grund für einen Fehlerlauf.
    return { ...leer, grund: `nicht lesbar: ${String(err.message || err).slice(0, 120)}` };
  }
}

// Nur für die Tests: den Parser austauschen.
//
// Ein von Hand gebautes PDF an dieser Stelle zu prüfen, hiesse pdf.js zu
// testen statt dieses Modul — und eine falsch berechnete xref-Tabelle im
// Testaufbau sagt nichts über den Belegleser. Getestet gehört, was hier
// passiert: kürzen, glätten, Scans erkennen, kaputte Dateien abfangen.
function _parserSetzen(fn) {
  parser = fn;
  parserGeprueft = true;
}

module.exports = { textAus, glaetten, _parserSetzen, MAX_SEITEN, MAX_ZEICHEN };
