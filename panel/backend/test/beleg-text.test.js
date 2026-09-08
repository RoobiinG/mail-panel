// Belege lesen ohne Google.
//
// Der Beleg-Leser schickte das PDF als `inline_data` an Gemini — das kann nur
// Gemini. Bei „lokale KI" stieg er aus und lieferte `null`; dieser Zweig ruft
// absichtlich kein merken(), damit ein VORUEBERGEHENDER Fehler beim naechsten
// Lauf neu versucht wird. „Der Anbieter ist Ollama" ist aber kein
// voruebergehender Fehler. Folge im Betrieb: keine einzige Zeile in
// beleg_ablage, Dedupe griff nie, der Tagesdeckel war wirkungslos, und
// `datum` stand immer auf heute statt auf dem Rechnungsdatum.
//
// Der Ausweg ist nicht ein multimodales Modell (llama3.2-vision ist 11B und auf
// drei Kernen keine Option), sondern die Textebene: Fast jede Rechnung ist ein
// digitales PDF. Ist der Text heraus, ist es eine gewoehnliche Textfrage — und
// schon die Heuristik wird damit deutlich besser, ganz ohne KI.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const leser = require('../src/services/belegLeser');
const pdfText = require('../src/services/pdfText');

const heute = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  db.prepare('DELETE FROM beleg_ablage').run();
  settings.setze('ki_anbieter', 'gemini');
  settings.setze('gemini_api_key', '');
  settings.setze('beleg_lese_tagesbudget', '0');
});

// ─── Ein echtes, wenn auch winziges PDF ─────────────────────────────────────
// Von Hand gebaut, samt gueltiger xref-Tabelle. Ein Test, der die Extraktion
// nur mit Muell fuettert, prueft die Fehlerbehandlung — nicht das Auslesen.
function pdfBauen(text) {
  const inhalt = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objekte = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R'
      + '/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${inhalt.length}>>\nstream\n${inhalt}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  objekte.forEach((o, i) => {
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });

  // Die Stellen NACH dem Bauen suchen, nicht beim Bauen mitzaehlen.
  //
  // Beim Mitzaehlen war eine Stelle daneben, und pdf.js meldete dann „bad XRef
  // entry": Es springt an die Stelle und erwartet dort „N 0 obj". Ist der
  // Versatz auch nur um ein Zeichen falsch, ist das ganze Dokument unlesbar.
  // indexOf kann sich nicht verzaehlen.
  const stellen = objekte.map((_, i) => pdf.indexOf(`\n${i + 1} 0 obj\n`) + 1);
  const xref = pdf.length;
  // Jeder Eintrag ist genau 20 Byte: 10 Ziffern, Leerzeichen, 5 Ziffern,
  // Leerzeichen, n/f, CRLF. Das ist die Form, die auch alte Parser lesen.
  pdf += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f\r\n`;
  for (const s of stellen) pdf += `${String(s).padStart(10, '0')} 00000 n\r\n`;
  pdf += `trailer\n<</Size ${objekte.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  // Alles ASCII, deshalb ist die Zeichen- gleich der Bytelaenge — sonst
  // stimmten die Stellen in der xref-Tabelle nicht.
  return Buffer.from(pdf, 'latin1').toString('base64');
}

describe('Text aus dem PDF holen', () => {
  test('der Text kommt heraus', async () => {
    const r = await pdfText.textAus(pdfBauen('Rechnungsnummer: RE-2026-0042'));
    assert.equal(r.ok, true, `Extraktion fehlgeschlagen: ${r.grund}`);
    assert.match(r.text, /RE-2026-0042/);
  });

  test('ein data:-Vorspann stört nicht', async () => {
    const r = await pdfText.textAus(`data:application/pdf;base64,${pdfBauen('Rechnung 7')}`);
    assert.equal(r.ok, true, r.grund);
    assert.match(r.text, /Rechnung 7/);
  });

  // Anhaenge von Fremden sind oft kaputt, verschluesselt oder gar keine PDFs.
  // Das ist Alltag am Maileingang und darf keinen Fehlerlauf ausloesen.
  test('Müll wird abgewiesen, nicht geworfen', async () => {
    for (const eingabe of ['', null, undefined, 'xxxx', 'bm90IGEgcGRm']) {
      const r = await pdfText.textAus(eingabe);
      assert.equal(r.ok, false);
      assert.equal(typeof r.grund, 'string');
      assert.equal(r.text, '');
    }
  });

  test('ein übergroßes PDF wird gar nicht erst geparst', async () => {
    const r = await pdfText.textAus('A'.repeat(21 * 1024 * 1024));
    assert.equal(r.ok, false);
    assert.match(r.grund, /zu groß/);
  });

  test('Glätten macht aus Spaltensatz lesbaren Text', () => {
    assert.equal(pdfText.glaetten('  a   b  \r\n\n\n\n  c '), 'a b\n\nc');
  });
});

describe('Was im Belegtext steht', () => {
  test('das Rechnungsdatum schlägt ein beliebiges Datum', () => {
    const g = leser.ausText('Lieferdatum: 01.01.2026\nRechnungsdatum: 12.03.2026\nFällig: 30.04.2026');
    assert.equal(g.datum, '2026-03-12');
  });

  test('yyyy-mm-dd wird übernommen', () => {
    assert.equal(leser.ausText('Datum: 2026-03-12').datum, '2026-03-12');
  });

  // Ohne benanntes Datum lieber keines: Das erste Datum im Text ist zu oft das
  // Faelligkeits- oder Lieferdatum, und im Ordnernamen sieht man einem falschen
  // Datum spaeter nicht an, dass es geraten war.
  test('ein unbenanntes Datum wird nicht geraten', () => {
    assert.equal(leser.ausText('Zahlbar bis 30.04.2026 ohne Abzug.').datum, null);
  });

  test('die Rechnungsnummer wird gefunden', () => {
    assert.equal(leser.ausText('Rechnungsnummer: RE-2026-0042').aktenzeichen, 'RE-2026-0042');
    assert.equal(leser.ausText('Rechnungs-Nr. 12345').aktenzeichen, '12345');
    assert.equal(leser.ausText('Invoice No: INV/99/7').aktenzeichen, 'INV-99-7');
  });

  // Die Rechnungsnummer ist die bessere Auskunft als die Kundennummer, wenn
  // beide dastehen — und auf einer Rechnung stehen fast immer beide.
  test('die Rechnungsnummer geht der Kundennummer vor', () => {
    const g = leser.ausText('Kundennummer: 555\nRechnungsnummer: RE-9');
    assert.equal(g.aktenzeichen, 'RE-9');
  });

  test('ohne Nummer bleibt es leer statt geraten', () => {
    assert.equal(leser.ausText('Vielen Dank für Ihren Einkauf.').aktenzeichen, null);
  });

  // Eine Mahnung nennt fast immer auch eine Rechnung. Wer nur nach "Rechnung"
  // sucht, findet nie eine Mahnung.
  test('Mahnung schlägt Rechnung', () => {
    const g = leser.ausText('Mahnung\nWir haben zu unserer Rechnung Nr. 5 noch keinen Zahlungseingang.');
    assert.equal(g.dokumenttyp, 'mahnung');
  });

  // Viele Rechnungen tragen die AGB auf der Rueckseite. Wer zuerst nach AGB
  // sucht, sortiert die halbe Buchhaltung als Werbung aus.
  test('AGB auf der Rückseite machen aus einer Rechnung keine AGB', () => {
    const g = leser.ausText('Rechnung Nr. 5\n\nAllgemeine Geschäftsbedingungen\n§1 …');
    assert.equal(g.dokumenttyp, 'rechnung');
  });

  test('eine reine Widerrufsbelehrung bleibt Werbung', () => {
    assert.equal(leser.ausText('Widerrufsbelehrung\nSie haben das Recht …').dokumenttyp, 'werbung');
  });

  test('leerer Text liefert nichts statt irgendetwas', () => {
    assert.deepEqual(leser.ausText(''), { dokumenttyp: null, datum: null, aktenzeichen: null });
  });
});

describe('Datumsformate', () => {
  test('deutsche Schreibweise', () => {
    assert.equal(leser.datumNormalisieren('12.03.2026'), '2026-03-12');
    assert.equal(leser.datumNormalisieren('1.3.2026'), '2026-03-01');
    assert.equal(leser.datumNormalisieren('12/03/2026'), '2026-03-12');
  });

  test('zweistellige Jahre werden zu 20xx', () => {
    assert.equal(leser.datumNormalisieren('12.03.26'), '2026-03-12');
  });

  test('Unsinn ergibt null, nicht ein erfundenes Datum', () => {
    for (const w of ['', '99.99.2026', '2026', 'gestern', '12.13.2026', '32.01.2026']) {
      assert.equal(leser.datumNormalisieren(w), null, `${w} haette null sein muessen`);
    }
  });
});

describe('Die Heuristik nutzt den Belegtext', () => {
  const mail = { von: 'shop@beispiel.de', betreff: 'Ihre Unterlagen', dateiname: 'anhang.pdf' };

  // Vorher hing alles am Dateinamen: "anhang.pdf" mit "Ihre Unterlagen" als
  // Betreff war garantiert kein Beleg — auch wenn eine Rechnung drinstand.
  test('ein nichtssagender Dateiname mit Rechnung darin ist ein Beleg', () => {
    const h = leser.heuristik(mail, 'Rechnungsnummer: RE-7\nRechnungsdatum: 12.03.2026');
    assert.equal(h.speichern, true);
    assert.equal(h.dokumenttyp, 'rechnung');
    assert.equal(h.aktenzeichen, 'RE-7');
    assert.equal(h.datum, '2026-03-12', 'das Datum steht auf dem Beleg, nicht im Kalender');
  });

  test('und umgekehrt: rechnung.pdf mit Widerruf darin ist keiner', () => {
    const h = leser.heuristik(
      { ...mail, dateiname: 'rechnung.pdf' },
      'Widerrufsbelehrung\nSie haben das Recht, binnen vierzehn Tagen …',
    );
    assert.equal(h.speichern, false);
    assert.equal(h.dokumenttyp, 'werbung');
  });

  test('ohne Text bleibt es beim alten Verhalten', () => {
    const h = leser.heuristik({ ...mail, dateiname: 'rechnung.pdf' });
    assert.equal(h.speichern, true);
    assert.equal(h.dokumenttyp, 'unbekannt');
    assert.equal(h.datum, heute());
  });

  test('kein Fund ⇒ heute, nicht null', () => {
    assert.equal(leser.heuristik(mail, 'Hallo, anbei die Unterlagen.').datum, heute());
  });
});

describe('Mit lokaler KI entstehen wieder Zeilen in beleg_ablage', () => {
  const zeilen = () => db.prepare('SELECT COUNT(*) n FROM beleg_ablage').get().n;

  // Der eigentliche Fehler: Der Ollama-Zweig lieferte null, und der Aufrufer
  // wertete das als voruebergehenden Fehler — also wurde nie gemerkt. Ergebnis
  // in der Produktion: dauerhaft null Zeilen, Dedupe ohne Wirkung, Tagesdeckel
  // ohne Wirkung, Belege-Zahlen im Dashboard immer 0.
  test('ein Scan ohne Textebene wird als Entscheidung festgehalten', async () => {
    settings.setze('ki_anbieter', 'ollama');
    const vorher = zeilen();
    const r = await leser.auslesen({
      konto: 'K', von: 'shop@beispiel.de', betreff: 'Ihre Rechnung',
      dateiname: 'scan.pdf', pdf_base64: 'bm90IGEgcGRm',
    });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(zeilen(), vorher + 1,
      'kein Text im PDF ist ein stabiler Zustand — sonst liest jeder Lauf dasselbe Dokument neu');
  });

  test('und die Dedupe greift beim nächsten Lauf', async () => {
    settings.setze('ki_anbieter', 'ollama');
    const eingang = {
      konto: 'K', von: 'shop@beispiel.de', betreff: 'Ihre Rechnung',
      dateiname: 'scan.pdf', pdf_base64: 'bm90IGEgcGRm',
    };
    await leser.auslesen(eingang);
    const vorher = zeilen();
    const zweite = await leser.auslesen(eingang);
    assert.equal(zweite.quelle, 'dedupe');
    assert.equal(zeilen(), vorher, 'kein zweiter Eintrag');
  });

  // Ein Netzfehler ist dagegen voruebergehend und darf die Entscheidung nicht
  // 26 Stunden festnageln — diese Unterscheidung ist der ganze Punkt.
  test('ein vorübergehender KI-Fehler wird weiterhin nicht gemerkt', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('ollama_url', 'http://127.0.0.1:1');
    const vorher = zeilen();
    const r = await leser.auslesen({
      konto: 'K3', von: 'shop@beispiel.de', betreff: 'Rechnung',
      dateiname: 'r.pdf', pdf_base64: pdfBauen('Rechnungsnummer: RE-1'),
    });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(zeilen(), vorher, 'beim naechsten Lauf soll es erneut versucht werden');
    assert.equal(r.aktenzeichen, 'RE-1', 'der Text war trotzdem da und wurde genutzt');
  });
});
