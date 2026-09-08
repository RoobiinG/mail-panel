// Eingescannte Belege lesbar machen.
//
// services/pdfText.js holt die Textebene aus einem PDF — bei fast jeder
// Rechnung reicht das. Ein SCAN hat aber keine Textebene: Dort steht ein Bild,
// und ohne Texterkennung ist nichts zu holen. Genau das war die letzte
// Faehigkeit, fuer die es noch Gemini brauchte.
//
// Der Preis, ehrlich benannt: Hierfuer laufen zwei Fremdprogramme auf einer
// Datei, die ein Fremder geschickt hat — pdftoppm rendert die Seite, tesseract
// liest sie. Bei der Textextraktion habe ich mich bewusst GEGEN einen
// C++-Parser entschieden und reines JavaScript genommen. Der Unterschied ist
// verteidigbar, aber er gehoert genannt:
//
//   * Es laeuft nur bei PDFs OHNE Textebene, also einem kleinen Bruchteil.
//   * Es laeuft erst, nachdem ClamAV den Anhang gesehen hat.
//   * execFile statt exec: kein Shell, keine Einschleusung ueber Dateinamen.
//   * Jeder Aufruf hat ein Zeitlimit, eine Seitengrenze und einen eigenen
//     Wegwerf-Ordner, der danach verschwindet.
//
// Fehlen die Programme (aelteres Abbild), wird das einmal gesagt und ohne OCR
// weitergearbeitet — nicht abgestuerzt.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loggen } = require('./panelLog');

// Zwei Seiten genuegen fuer einen Beleg: Betrag, Datum und Nummer stehen vorn.
// Jede weitere Seite kostet auf einer CPU dieselbe Zeit noch einmal.
const SEITEN_MAX = 2;
// 200 dpi ist der uebliche Kompromiss — darunter leidet die Erkennung, darueber
// waechst nur die Rechenzeit.
const DPI = 200;
const ZEIT_RENDERN_MS = 60000;
const ZEIT_LESEN_MS = 90000;
const AUSGABE_MAX = 4 * 1024 * 1024;

let verfuegbar = null; // null = noch nicht geprueft

function laufen(befehl, args, zeitlimit) {
  return new Promise((fertig) => {
    execFile(
      befehl, args,
      {
        timeout: zeitlimit,
        maxBuffer: AUSGABE_MAX,
        encoding: 'utf8',
        windowsHide: true,
        // tesseract nimmt sich sonst per OpenMP alle Kerne, die es findet. Auf
        // einer Maschine mit dreien heisst das: Waehrend eine Seite erkannt
        // wird, steht die KI. Ein Beleg darf ein paar Sekunden laenger dauern;
        // ein Sortierlauf, der deswegen in sein Zeitlimit rennt, ist teurer.
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      },
      (fehler, stdout) => fertig({
        ok: !fehler,
        text: stdout || '',
        fehler: fehler ? String(fehler.message || fehler).slice(0, 200) : '',
        fehlt: Boolean(fehler && fehler.code === 'ENOENT'),
      }),
    );
  });
}

// Eine Texterkennung zur Zeit.
//
// Ohne das kann jeder Anhang eines Laufs seinen eigenen Renderer und seinen
// eigenen tesseract starten. Bei einer Mail mit fuenf PDF-Anhaengen waeren das
// fuenf Prozesse gleichzeitig — dieselbe Falle, die bei den KI-Anfragen schon
// einmal zugeschnappt ist (services/ollamaSchlange.js): Nebenlaeufigkeit macht
// auf wenigen Kernen nichts schneller, nur alles langsamer.
let kette = Promise.resolve();
function nacheinander(aufgabe) {
  const naechste = kette.then(aufgabe, aufgabe);
  // Ein Fehler darf die Kette nicht vergiften — sonst laeuft nach dem ersten
  // kaputten PDF keine Erkennung mehr.
  kette = naechste.then(() => {}, () => {});
  return naechste;
}

/** Sind pdftoppm und tesseract im Abbild? Einmal fragen, Antwort merken. */
async function bereit() {
  if (verfuegbar !== null) return verfuegbar;
  const a = await laufen('pdftoppm', ['-v'], 10000);
  const b = await laufen('tesseract', ['--version'], 10000);
  // -v/-version schreiben nach stderr und koennen mit != 0 enden; entscheidend
  // ist nur, ob das Programm ueberhaupt da ist.
  verfuegbar = !a.fehlt && !b.fehlt;
  if (!verfuegbar) {
    loggen('info', 'backend:ocr',
      'Texterkennung nicht verfügbar (pdftoppm/tesseract fehlen) — eingescannte Belege '
      + 'entscheidet die Heuristik.');
  }
  return verfuegbar;
}

/**
 * @param {Buffer} pdf
 * @returns {Promise<{ok: boolean, text: string, seiten: number, grund: string}>}
 */
async function textAus(pdf) {
  const leer = { ok: false, text: '', seiten: 0, grund: '' };
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) return { ...leer, grund: 'kein PDF' };
  if (!(await bereit())) return { ...leer, grund: 'Texterkennung nicht verfügbar' };
  return nacheinander(() => einLauf(pdf, leer));
}

async function einLauf(pdf, leer) {
  let ordner = '';
  const begonnen = Date.now();
  try {
    ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'mailpanel-ocr-'));
    const quelle = path.join(ordner, 'eingang.pdf');
    fs.writeFileSync(quelle, pdf);

    // Graustufen: Farbe bringt der Texterkennung nichts und vervierfacht die
    // Bilddaten.
    const gerendert = await laufen('pdftoppm', [
      '-png', '-gray', '-r', String(DPI), '-f', '1', '-l', String(SEITEN_MAX),
      quelle, path.join(ordner, 'seite'),
    ], ZEIT_RENDERN_MS);
    if (!gerendert.ok) return { ...leer, grund: `Rendern fehlgeschlagen: ${gerendert.fehler}` };

    // Wie pdftoppm die Seiten durchnummeriert, haengt von der Seitenzahl ab
    // (seite-1.png, seite-01.png …). Deshalb nachsehen statt raten.
    const bilder = fs.readdirSync(ordner).filter((d) => d.endsWith('.png')).sort();
    if (bilder.length === 0) return { ...leer, grund: 'keine Seite gerendert' };

    const stuecke = [];
    for (const bild of bilder.slice(0, SEITEN_MAX)) {
      const pfad = path.join(ordner, bild);
      // --psm 6: „ein zusammenhaengender Textblock". Fuer Rechnungen deutlich
      // stabiler als die automatische Layout-Erkennung, die bei Tabellen gern
      // Spalten durcheinanderwirft.
      let gelesen = await laufen('tesseract', [pfad, 'stdout', '-l', 'deu+eng', '--psm', '6'], ZEIT_LESEN_MS);
      // Fehlen die deutschen Sprachdaten, bricht tesseract ab. Dann lieber auf
      // Englisch lesen als gar nicht.
      if (!gelesen.ok) {
        gelesen = await laufen('tesseract', [pfad, 'stdout', '--psm', '6'], ZEIT_LESEN_MS);
      }
      if (gelesen.ok && gelesen.text.trim()) stuecke.push(gelesen.text);
    }

    if (stuecke.length === 0) return { ...leer, seiten: bilder.length, grund: 'nichts erkannt' };
    const sekunden = Math.round((Date.now() - begonnen) / 100) / 10;
    loggen('info', 'backend:ocr',
      `Beleg per Texterkennung gelesen: ${stuecke.length} Seite(n) in ${sekunden} s.`);
    return { ok: true, text: stuecke.join('\n'), seiten: bilder.length, grund: '' };
  } catch (err) {
    return { ...leer, grund: `Texterkennung fehlgeschlagen: ${String(err.message || err).slice(0, 150)}` };
  } finally {
    if (ordner) {
      try { fs.rmSync(ordner, { recursive: true, force: true }); } catch { /* Wegwerf-Ordner */ }
    }
  }
}

// Nur fuer die Tests.
function _verfuegbarSetzen(wert) { verfuegbar = wert; }

module.exports = { textAus, bereit, _verfuegbarSetzen, SEITEN_MAX, DPI };
