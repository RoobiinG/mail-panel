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

// Der Parser wird ausgetauscht statt ein PDF von Hand gebaut.
//
// Der erste Anlauf hat genau das versucht — samt xref-Tabelle — und pdf.js
// meldete „bad XRef entry". Das war die richtige Antwort auf die falsche
// Frage: Ob pdf.js ein PDF lesen kann, ist pdf.js' Sache. Hier gehoert
// geprueft, was DIESES Modul tut — kuerzen, glaetten, Scans erkennen, kaputte
// Dateien abfangen — und was der Belegleser daraus macht.
const einPdf = () => Buffer.from('%PDF-1.4 …').toString('base64');
const parserGibt = (text, seiten = 1) => {
  pdfText._parserSetzen(async () => ({ text, numpages: seiten }));
};
const parserWirft = (meldung) => {
  pdfText._parserSetzen(async () => { throw new Error(meldung); });
};

describe('Text aus dem PDF holen', () => {
  test('der Text kommt heraus', async () => {
    parserGibt('Rechnungsnummer: RE-2026-0042');
    const r = await pdfText.textAus(einPdf());
    assert.equal(r.ok, true, r.grund);
    assert.match(r.text, /RE-2026-0042/);
    assert.equal(r.seiten, 1);
  });

  test('ein data:-Vorspann stört nicht', async () => {
    parserGibt('Rechnung 7');
    const r = await pdfText.textAus(`data:application/pdf;base64,${einPdf()}`);
    assert.equal(r.ok, true, r.grund);
    assert.match(r.text, /Rechnung 7/);
  });

  // Der haeufigste Fall dahinter ist ein eingescanntes PDF. Das ist kein
  // Fehler, sondern eine Eigenschaft des Dokuments — der Aufrufer muss es
  // unterscheiden koennen, weil ein Scan ein STABILER Zustand ist.
  test('ohne Textebene wird das als Scan gemeldet', async () => {
    parserGibt('   \n\n  ', 3);
    const r = await pdfText.textAus(einPdf());
    assert.equal(r.ok, false);
    assert.match(r.grund, /Textebene|Scan/);
    assert.equal(r.seiten, 3);
  });

  // Anhaenge von Fremden sind oft kaputt, verschluesselt oder gar keine PDFs.
  // Das ist Alltag am Maileingang und darf keinen Fehlerlauf ausloesen.
  test('ein kaputtes PDF wird abgewiesen, nicht geworfen', async () => {
    parserWirft('bad XRef entry');
    const r = await pdfText.textAus(einPdf());
    assert.equal(r.ok, false);
    assert.match(r.grund, /nicht lesbar/);
    assert.equal(r.text, '');
  });

  test('ohne Eingabe wird gar nicht erst geparst', async () => {
    parserWirft('haette nicht gerufen werden duerfen');
    for (const eingabe of ['', null, undefined]) {
      const r = await pdfText.textAus(eingabe);
      assert.equal(r.ok, false);
      assert.match(r.grund, /kein PDF/);
    }
  });

  test('ein übergroßes PDF wird gar nicht erst geparst', async () => {
    parserWirft('haette nicht gerufen werden duerfen');
    const r = await pdfText.textAus('A'.repeat(21 * 1024 * 1024));
    assert.equal(r.ok, false);
    assert.match(r.grund, /zu groß/);
  });

  // Ein Katalog mit 300 Seiten ist entweder ein Versehen oder ein Versuch, den
  // Server zu beschaeftigen. Beides gehoert gedeckelt.
  test('sehr langer Text wird gekürzt', async () => {
    parserGibt('x'.repeat(pdfText.MAX_ZEICHEN * 2));
    const r = await pdfText.textAus(einPdf());
    assert.equal(r.ok, true);
    assert.equal(r.text.length, pdfText.MAX_ZEICHEN);
  });

  test('die Seitenzahl wird begrenzt weitergereicht', async () => {
    let optionen = null;
    pdfText._parserSetzen(async (_, opt) => { optionen = opt; return { text: 'x', numpages: 1 }; });
    await pdfText.textAus(einPdf());
    assert.equal(optionen.max, pdfText.MAX_SEITEN);
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
    parserGibt('');
    const vorher = zeilen();
    const r = await leser.auslesen({
      konto: 'K', von: 'shop@beispiel.de', betreff: 'Ihre Rechnung',
      dateiname: 'scan.pdf', pdf_base64: einPdf(),
    });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(zeilen(), vorher + 1,
      'kein Text im PDF ist ein stabiler Zustand — sonst liest jeder Lauf dasselbe Dokument neu');
  });

  test('und die Dedupe greift beim nächsten Lauf', async () => {
    settings.setze('ki_anbieter', 'ollama');
    parserGibt('');
    const eingang = {
      konto: 'K', von: 'shop@beispiel.de', betreff: 'Ihre Rechnung',
      dateiname: 'scan.pdf', pdf_base64: einPdf(),
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
    parserGibt('Rechnungsnummer: RE-1\nRechnungsdatum: 12.03.2026');
    const vorher = zeilen();
    const r = await leser.auslesen({
      konto: 'K3', von: 'shop@beispiel.de', betreff: 'Rechnung',
      dateiname: 'r.pdf', pdf_base64: einPdf(),
    });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(zeilen(), vorher, 'beim naechsten Lauf soll es erneut versucht werden');
    assert.equal(r.aktenzeichen, 'RE-1', 'der Text war trotzdem da und wurde genutzt');
    assert.equal(r.datum, '2026-03-12', 'und das Datum kam vom Beleg, nicht aus dem Kalender');
  });

  // Der Tagesdeckel schaltet die KI ab, nicht die Textebene. Genau dafuer ist
  // die verbesserte Heuristik da.
  test('bei vollem Deckel entscheidet die Heuristik — mit Belegtext', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('beleg_lese_tagesbudget', '1');
    db.prepare(`INSERT INTO beleg_ablage (konto, von, betreff, dateiname, dokumenttyp, gespeichert, quelle)
      VALUES ('X','a@b.de','B','d.pdf','rechnung',1,'ki')`).run();
    parserGibt('Rechnungsnummer: RE-77\nRechnungsdatum: 01.02.2026');
    const r = await leser.auslesen({
      konto: 'K4', von: 'shop@beispiel.de', betreff: 'Unterlagen',
      dateiname: 'anhang.pdf', pdf_base64: einPdf(),
    });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(r.speichern, true);
    assert.equal(r.aktenzeichen, 'RE-77');
    assert.equal(r.datum, '2026-02-01');
  });
});

// ─── Texterkennung: der Weg fuer eingescannte Belege ────────────────────────
//
// Ein Scan hat keine Textebene — dort steht ein Bild. Das war die letzte
// Faehigkeit, fuer die es noch Gemini brauchte. pdftoppm und tesseract sind auf
// dem CI-Laeufer nicht installiert, deshalb wird hier der Baustein
// ausgetauscht: Geprueft gehoert die Verdrahtung, nicht tesseract.
describe('Eingescannte Belege', () => {
  const ocr = require('../src/services/ocr');
  const echt = ocr.textAus;

  const ocrGibt = (text) => { ocr.textAus = async () => ({ ok: true, text, seiten: 1, grund: '' }); };
  const ocrScheitert = (grund) => {
    ocr.textAus = async () => ({ ok: false, text: '', seiten: 0, grund });
  };
  const ocrZurueck = () => { ocr.textAus = echt; };

  test('ohne Textebene springt die Texterkennung ein', async () => {
    parserGibt('');
    ocrGibt('Rechnungsnummer: RE-2026-0099');
    try {
      const r = await pdfText.textAus(einPdf(), { ocr: true });
      assert.equal(r.ok, true, r.grund);
      assert.match(r.text, /RE-2026-0099/);
      assert.equal(r.quelle, 'texterkennung');
    } finally { ocrZurueck(); }
  });

  // Die Textebene ist exakt, die Texterkennung schaetzt. Wo es beides gibt,
  // gewinnt die Textebene — und die Texterkennung wird gar nicht erst gestartet.
  test('mit Textebene wird die Texterkennung nicht bemüht', async () => {
    parserGibt('Rechnungsnummer: RE-1');
    ocr.textAus = async () => { throw new Error('haette nicht laufen duerfen'); };
    try {
      const r = await pdfText.textAus(einPdf(), { ocr: true });
      assert.equal(r.ok, true);
      assert.equal(r.quelle, 'textebene');
    } finally { ocrZurueck(); }
  });

  test('ohne die Option bleibt sie ganz aus', async () => {
    parserGibt('');
    ocr.textAus = async () => { throw new Error('haette nicht laufen duerfen'); };
    try {
      const r = await pdfText.textAus(einPdf());
      assert.equal(r.ok, false);
      assert.match(r.grund, /Textebene|Scan/);
    } finally { ocrZurueck(); }
  });

  // Auch ein PDF, dessen Textebene pdf.js nicht mag, laesst sich oft rendern.
  test('auch nach einem Parser-Fehler wird es noch versucht', async () => {
    parserWirft('bad XRef entry');
    ocrGibt('Rechnung 5');
    try {
      const r = await pdfText.textAus(einPdf(), { ocr: true });
      assert.equal(r.ok, true, r.grund);
      assert.match(r.text, /Rechnung 5/);
    } finally { ocrZurueck(); }
  });

  test('fehlt tesseract, wird der Grund genannt statt geworfen', async () => {
    parserGibt('');
    ocrScheitert('Texterkennung nicht verfügbar');
    try {
      const r = await pdfText.textAus(einPdf(), { ocr: true });
      assert.equal(r.ok, false);
      assert.match(r.grund, /nicht verfügbar/);
    } finally { ocrZurueck(); }
  });

  test('ohne die Programme meldet sich der Baustein selbst', async () => {
    ocr._verfuegbarSetzen(false);
    const r = await ocr.textAus(Buffer.from('%PDF-1.4'));
    assert.equal(r.ok, false);
    assert.match(r.grund, /nicht verfügbar/);
    ocr._verfuegbarSetzen(null);
  });

  test('ohne PDF wird gar nichts gestartet', async () => {
    ocr._verfuegbarSetzen(true);
    const r = await ocr.textAus(Buffer.alloc(0));
    assert.equal(r.ok, false);
    assert.match(r.grund, /kein PDF/);
    ocr._verfuegbarSetzen(null);
  });

  // Gemini bekommt das PDF selbst und liest einen Scan von sich aus. Dort
  // trotzdem zu rendern waeren dreissig Sekunden CPU fuer nichts.
  test('mit Gemini als Anbieter läuft keine Texterkennung', async () => {
    settings.setze('ki_anbieter', 'gemini');
    settings.setze('gemini_api_key', '');
    parserGibt('');
    ocr.textAus = async () => { throw new Error('haette nicht laufen duerfen'); };
    try {
      const r = await leser.auslesen({
        konto: 'K9', von: 'shop@beispiel.de', betreff: 'Rechnung',
        dateiname: 'scan.pdf', pdf_base64: einPdf(),
      });
      assert.equal(r.quelle, 'heuristik');
    } finally { ocrZurueck(); }
  });

  test('der Schalter schaltet sie ab', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('beleg_ocr_aktiv', '0');
    assert.equal(leser.ocrAktiv(), false);
    parserGibt('');
    ocr.textAus = async () => { throw new Error('haette nicht laufen duerfen'); };
    try {
      const r = await leser.auslesen({
        konto: 'K10', von: 'shop@beispiel.de', betreff: 'Rechnung',
        dateiname: 'scan.pdf', pdf_base64: einPdf(),
      });
      assert.equal(r.quelle, 'heuristik');
    } finally {
      ocrZurueck();
      settings.setze('beleg_ocr_aktiv', '1');
    }
  });
});

// Gefunden beim Nachlesen des eigenen Codes, nicht im Betrieb.
describe('Die KI-Antwort wirft nicht weg, was im Beleg steht', () => {
  // Der Prompt erlaubt der KI ausdruecklich, ein Feld leer zu lassen
  // („Unbekannt ⇒ \"\""), und ein kleines Modell tut das oft. sauberDatum()
  // fiel dann stumm auf HEUTE zurueck — und damit war der KI-Weg beim Datum
  // schlechter als der ganz ohne KI, der es im Belegtext gefunden haette.
  const belegtext = 'Rechnungsnummer: RE-2026-0500\nRechnungsdatum: 05.03.2026';

  test('leeres Datum der KI ⇒ das Datum vom Beleg', () => {
    const r = leser.entscheiden(
      { dokumenttyp: 'rechnung', speichern: true, datum: '', aktenzeichen: '' },
      'a@b.de', belegtext,
    );
    assert.equal(r.datum, '2026-03-05', 'nicht heute');
    assert.equal(r.aktenzeichen, 'RE-2026-0500');
  });

  test('die KI hat trotzdem Vorrang, wenn sie etwas sagt', () => {
    const r = leser.entscheiden(
      { dokumenttyp: 'rechnung', speichern: true, datum: '2026-01-01', aktenzeichen: 'AZ-9' },
      'a@b.de', belegtext,
    );
    assert.equal(r.datum, '2026-01-01');
    assert.equal(r.aktenzeichen, 'AZ-9');
  });

  test('ohne Belegtext bleibt es beim alten Verhalten', () => {
    const r = leser.entscheiden({ dokumenttyp: 'rechnung', speichern: true }, 'a@b.de');
    assert.equal(r.datum, heute());
    assert.equal(r.aktenzeichen, null);
  });

  // Kein Beleg heisst: kein Aktenzeichen, auch wenn eines im Text stuende.
  test('bei „nicht speichern" bleibt das Aktenzeichen leer', () => {
    const r = leser.entscheiden(
      { dokumenttyp: 'werbung', speichern: false }, 'a@b.de', belegtext,
    );
    assert.equal(r.speichern, false);
    assert.equal(r.aktenzeichen, null);
  });

  test('und im ganzen Durchlauf kommt das Datum vom Beleg an', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('ollama_url', 'http://127.0.0.1:1'); // KI nicht erreichbar
    parserGibt(belegtext);
    const r = await leser.auslesen({
      konto: 'K11', von: 'shop@beispiel.de', betreff: 'Unterlagen',
      dateiname: 'anhang.pdf', pdf_base64: einPdf(),
    });
    assert.equal(r.datum, '2026-03-05');
    assert.equal(r.aktenzeichen, 'RE-2026-0500');
  });
});
