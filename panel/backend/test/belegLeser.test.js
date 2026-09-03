// Der Beleg-Leser entscheidet, ob ein PDF ein aufbewahrenswerter Beleg ist, und
// liest Firma/Datum/Aktenzeichen aus. Zwei Fehler waeren teuer: einen AGB als
// Beleg ablegen (verwirrt den Ordner) oder jeden Beleg erneut per KI lesen
// (verbrennt das Tageslimit). Beides ist hier festgenagelt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const leser = require('../src/services/belegLeser');

function seed({ konto = 'K', von = 'a@x.de', betreff = 'B', dateiname = 'd.pdf',
  dokumenttyp = 'rechnung', gespeichert = 1, firma = 'firma', aktenzeichen = 'AZ-1',
  datum = '2026-01-02', quelle = 'ki' } = {}) {
  db.prepare(`INSERT INTO beleg_ablage
    (konto, von, betreff, dateiname, dokumenttyp, gespeichert, firma, aktenzeichen, datum, quelle)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(konto, von, betreff, dateiname, dokumenttyp, gespeichert, firma, aktenzeichen, datum, quelle);
}
const zeilen = () => db.prepare('SELECT COUNT(*) n FROM beleg_ablage').get().n;

beforeEach(() => {
  db.exec('DELETE FROM beleg_ablage');
  db.prepare("DELETE FROM settings WHERE key IN ('beleg_lese_tagesbudget','gemini_api_key')").run();
});

describe('Firma aus dem Absender', () => {
  test('zweite Ebene, Mail-Subdomain wird abgeschnitten', () => {
    assert.equal(leser.firmaAus('no-reply@news.zalando.de'), 'zalando');
    assert.equal(leser.firmaAus('versand@amazon.de'), 'amazon');
  });
  test('zweiteilige TLD (co.uk) wird erkannt', () => {
    assert.equal(leser.firmaAus('billing@amazon.co.uk'), 'amazon');
  });
  test('ohne brauchbaren Absender: unbekannt', () => {
    assert.equal(leser.firmaAus(''), 'unbekannt');
    assert.equal(leser.firmaAus('kein-at-zeichen'), 'unbekannt');
  });
});

describe('Saeuberung', () => {
  test('Firma wird kleingeschrieben und entschaerft', () => {
    assert.equal(leser.sauberFirma('Inkasso Müller GmbH'), 'inkasso-mueller-gmbh');
  });
  test('Aktenzeichen bleibt lesbar, aber ohne Schrägstriche', () => {
    assert.equal(leser.sauberAktenzeichen('AZ 12345/2024'), 'AZ-12345-2024');
    assert.equal(leser.sauberAktenzeichen('   '), null);
  });
  test('Datum nur, wenn es wie ein Datum aussieht', () => {
    assert.equal(leser.sauberDatum('2024-03-15'), '2024-03-15');
    assert.match(leser.sauberDatum('quatsch'), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Gate: nur echte Belege', () => {
  test('AGB/Werbung werden nicht gespeichert', () => {
    assert.equal(leser.entscheiden({ dokumenttyp: 'agb', speichern: true }, 'x@y.de').speichern, false);
    assert.equal(leser.entscheiden({ dokumenttyp: 'werbung', speichern: true }, 'x@y.de').speichern, false);
    assert.equal(leser.entscheiden({ dokumenttyp: 'kein_beleg', speichern: true }, 'x@y.de').speichern, false);
  });
  test('echte Rechnung wird gespeichert und die Felder übernommen', () => {
    const e = leser.entscheiden(
      { dokumenttyp: 'rechnung', speichern: true, firma: 'Amazon', datum: '2024-03-15', aktenzeichen: 'R/12/34' },
      'x@amazon.de',
    );
    assert.equal(e.speichern, true);
    assert.equal(e.firma, 'amazon');
    assert.equal(e.datum, '2024-03-15');
    assert.equal(e.aktenzeichen, 'R-12-34');
  });
  test('sagt die KI selbst speichern:false, wird nicht abgelegt', () => {
    assert.equal(leser.entscheiden({ dokumenttyp: 'rechnung', speichern: false }, 'x@y.de').speichern, false);
  });
  test('Heuristik: Beleg-Wort im Namen/Betreff genügt, sonst nicht', () => {
    assert.equal(leser.heuristik({ von: 'a@b.de', betreff: 'Ihre Rechnung', dateiname: 'x.pdf' }).speichern, true);
    assert.equal(leser.heuristik({ von: 'a@b.de', betreff: 'Neuigkeiten', dateiname: 'agb.pdf' }).speichern, false);
  });
});

describe('auslesen: Dedupe und Deckel', () => {
  test('schon gelesen ⇒ wiederverwenden, kein neuer Eintrag', async () => {
    seed({ konto: 'K', von: 'a@x.de', betreff: 'B', dateiname: 'd.pdf', firma: 'gemerkt', gespeichert: 1 });
    const vorher = zeilen();
    const r = await leser.auslesen({ konto: 'K', von: 'a@x.de', betreff: 'B', dateiname: 'd.pdf', pdf_base64: 'x' });
    assert.equal(r.quelle, 'dedupe');
    assert.equal(r.firma, 'gemerkt');
    assert.equal(r.speichern, true);
    assert.equal(zeilen(), vorher, 'kein zweiter KI-Aufruf, kein neuer Eintrag');
  });

  test('Deckel voll ⇒ Heuristik, wird protokolliert', async () => {
    settings.setze('beleg_lese_tagesbudget', '1');
    seed({ von: 'schon@x.de', quelle: 'ki' }); // 1 KI-Lesung heute
    const vorher = zeilen();
    const r = await leser.auslesen({ konto: 'K', von: 'neu@x.de', betreff: 'Ihre Rechnung', dateiname: 'r.pdf', pdf_base64: 'x' });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(r.speichern, true, 'klarer Beleg wird auch per Heuristik abgelegt');
    assert.equal(zeilen(), vorher + 1);
  });

  test('ohne KI-Schlüssel ⇒ Heuristik, aber NICHT gemerkt (Wiederholung möglich)', async () => {
    settings.setze('beleg_lese_tagesbudget', '0'); // kein Deckel
    const vorher = zeilen();
    const r = await leser.auslesen({ konto: 'K2', von: 'shop@example.com', betreff: 'Bestellbestätigung', dateiname: 'order.pdf', pdf_base64: 'x' });
    assert.equal(r.quelle, 'heuristik');
    assert.equal(zeilen(), vorher, 'ein vorübergehender Fehler darf die Entscheidung nicht 26h festnageln');
  });
});
