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
// Bewusst reines JavaScript (pdfjs-dist) statt poppler/pdftotext per `apk add`.
// Hier werden Anhänge von Fremden geparst; ein C++-Programm auf diesem Pfad
// wäre ein größeres Risiko als ein Parser, der im JS-Speichermodell bleibt.
const { loggen } = require('./panelLog');

// Eine Rechnung hat ein bis drei Seiten. Alles darüber ist entweder ein Katalog
// oder ein Versuch, den Server zu beschäftigen.
const MAX_SEITEN = 8;
const MAX_ZEICHEN = 12000;
// 20 MB Base64 sind rund 15 MB PDF. Darüber wird gar nicht erst geparst.
const MAX_BASE64 = 20 * 1024 * 1024;

// Warum nicht mehr pdf-parse.
//
// pdf-parse (1.1.1) ist seit 2018 unverändert und bringt eine ebenso alte
// pdf.js-Kopie mit. Für diese Generation gilt die Lücke, die 2024 als
// CVE-2024-4367 bekannt wurde: Eine präparierte Schrift im PDF bringt pdf.js
// dazu, mitgelieferten JavaScript-Code auszuführen — hier also im Panel-Prozess,
// mit allem, woran der herankommt. Behoben ist das ab pdf.js 4.2.67.
//
// Auf diesem Pfad landen Anhänge von Fremden: Jeder, der eine Mail schicken
// kann, bestimmt, was hier geparst wird. Deshalb das aktuelle pdfjs-dist —
// und zusätzlich `isEvalSupported: false`, was genau den Mechanismus abschaltet,
// über den die Lücke lief. Schriften werden ohnehin nicht gebraucht: Gesucht ist
// die Textebene, nicht ein Bild der Seite.
const PDFJS_KANDIDATEN = [
  'pdfjs-dist/legacy/build/pdf.mjs',
  'pdfjs-dist/legacy/build/pdf.js',
  'pdfjs-dist',
];

let pdfjs;

async function ladePdfjs() {
  if (pdfjs !== undefined) return pdfjs;
  for (const spezifizierer of PDFJS_KANDIDATEN) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const geladen = await import(spezifizierer);
      const getDocument = geladen?.getDocument || geladen?.default?.getDocument;
      if (getDocument) {
        pdfjs = { getDocument };
        return pdfjs;
      }
    } catch { /* naechster Versuch */ }
  }
  pdfjs = null;
  loggen('warn', 'backend:pdfText',
    'PDF-Textextraktion nicht verfügbar (pdfjs-dist fehlt) — Belege werden per Heuristik entschieden.');
  return pdfjs;
}

// Die Brücke zur bisherigen Schnittstelle: Aufruf `parser(puffer, { max })`,
// Antwort `{ text, numpages }`. So bleibt alles darunter unverändert — und die
// Tests, die den Parser austauschen, beschreiben weiterhin dieselbe Form.
async function pdfjsParser(puffer, opt = {}) {
  const lib = await ladePdfjs();
  if (!lib) throw new Error('pdfjs-dist nicht verfügbar');

  const dokument = await lib.getDocument({
    data: new Uint8Array(puffer),
    // Der Kern der Sache: kein eval, keine Schriftverarbeitung, keine
    // Systemschriften. Nichts davon wird für reinen Text gebraucht.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Ein PDF von fremder Hand darf nicht auch noch etwas nachladen.
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  }).promise;

  try {
    const gesamt = Number(dokument.numPages) || 0;
    const bis = Math.min(gesamt, Number(opt.max) || gesamt);
    const teile = [];
    for (let nr = 1; nr <= bis; nr += 1) {
      // eslint-disable-next-line no-await-in-loop
      const seite = await dokument.getPage(nr);
      // eslint-disable-next-line no-await-in-loop
      const inhalt = await seite.getTextContent();
      teile.push((inhalt.items || []).map((stueck) => stueck.str || '').join(' '));
      seite.cleanup();
    }
    return { text: teile.join('\n'), numpages: gesamt };
  } finally {
    // Ohne das hält ein Langläufer wie das Panel jedes je gelesene PDF fest.
    await Promise.resolve(dokument.destroy()).catch(() => {});
  }
}

// Einmal prüfen, Ergebnis merken. Fehlt das Paket (etwa in einem alten Abbild),
// soll das Panel nicht abstürzen, sondern ohne Textebene weiterarbeiten — dann
// greift wie bisher die Heuristik.
let parser;
let parserGeprueft = false;

function ladeParser() {
  if (parserGeprueft) return parser;
  parserGeprueft = true;
  parser = pdfjsParser;
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
async function textAus(base64, opt = {}) {
  const leer = { ok: false, text: '', seiten: 0, grund: '' };
  const roh = String(base64 || '').replace(/^data:[^,]*,/, '');
  if (!roh) return { ...leer, grund: 'kein PDF mitgeliefert' };
  if (roh.length > MAX_BASE64) return { ...leer, grund: 'PDF zu groß' };

  const puffer = Buffer.from(roh, 'base64');
  const lesen = ladeParser();
  if (!lesen) return { ...leer, grund: 'Textextraktion nicht verfügbar' };

  // Erst die Textebene: kostet Millisekunden und ist bei einem digitalen PDF
  // exakt, wo die Texterkennung nur schätzt.
  let seiten = 0;
  try {
    const daten = await lesen(puffer, { max: MAX_SEITEN });
    seiten = Number(daten?.numpages) || 0;
    const text = glaetten(daten?.text).slice(0, MAX_ZEICHEN);
    if (text) return { ok: true, text, seiten, quelle: 'textebene', grund: '' };
  } catch (err) {
    // Ein kaputtes oder verschlüsseltes PDF ist Alltag bei Maileingang und kein
    // Grund für einen Fehlerlauf. Ein Scan-Versuch lohnt danach trotzdem: Auch
    // ein PDF, dessen Textebene pdf.js nicht mag, lässt sich oft rendern.
    if (!opt.ocr) {
      return { ...leer, grund: `nicht lesbar: ${String(err.message || err).slice(0, 120)}` };
    }
  }

  // Keine Textebene — der häufigste Fall dahinter ist ein Scan.
  if (!opt.ocr) return { ...leer, seiten, grund: 'keine Textebene (Scan?)' };

  const erkannt = await require('./ocr').textAus(puffer);
  if (erkannt.ok) {
    return {
      ok: true,
      text: glaetten(erkannt.text).slice(0, MAX_ZEICHEN),
      seiten: seiten || erkannt.seiten,
      quelle: 'texterkennung',
      grund: '',
    };
  }
  return { ...leer, seiten: seiten || erkannt.seiten, grund: `keine Textebene; ${erkannt.grund}` };
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
