// Die Beschreibung eines Themen-Ordners war bisher reine Prompt-Dekoration.
//
// Wer bei einem Ordner "Vodafone, Sky, Netflix, Telekom" hinterlegt hatte,
// wunderte sich zu Recht: Die Telekom-Mail landete trotzdem im Newsletter-
// Ordner. Der Grund lag nicht an der Beschreibung, sondern daran, dass alles am
// Urteil der KI hing — und die liefert bei einem Newsletter meist "ordner: null"
// oder ist unsicher. Dann zog der Kategorie-Ordner, und die gepflegte
// Beschreibung war wirkungslos.
//
// Hier steht, was die Stichworte jetzt entscheiden duerfen — und wo Schluss ist.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const themen = require('../src/services/themen');

const kontoAnlegen = () => db.prepare(
  "INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
  + " VALUES ('K', 'h', 993, 'u', 'x', 1)",
).run().lastInsertRowid;

const ordner = (kontoId, name, beschreibung = null, gesperrt = 0) => db.prepare(
  'INSERT INTO konto_ordner (konto_id, ordner, beschreibung, quelle, gesperrt)'
  + " VALUES (?, ?, ?, 'manuell', ?)",
).run(kontoId, name, beschreibung, gesperrt);

let konto;
beforeEach(() => {
  db.exec('DELETE FROM konto_ordner; DELETE FROM sort_inbox; DELETE FROM accounts;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'themen_%'").run();
  konto = kontoAnlegen();
});

describe('Stichwort im Absender', () => {
  test('der Fall aus dem Betrieb: Telekom-Mail in den Anbieter-Ordner', () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky, Netflix, Telekom');
    const t = themen.stichwortTreffer(konto, 'newsletter@telekom.de', 'Ihre Rechnung ist da');
    assert.equal(t?.ordner, 'Anbieter');
    assert.equal(t.wort, 'telekom');
    assert.equal(t.wo, 'absender');
  });

  test('auch aus dem Anzeigenamen', () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky');
    assert.equal(themen.stichwortTreffer(konto, 'Sky Deutschland <no-reply@a1b2.net>', 'x')?.ordner,
      'Anbieter');
  });

  test('auch bei zusammengesetzter Domain', () => {
    ordner(konto, 'Anbieter', 'Telekom');
    assert.equal(themen.stichwortTreffer(konto, 'info@telekom-deutschland.de', 'x')?.ordner, 'Anbieter');
  });

  test('der Ordnername zaehlt selbst als Stichwort', () => {
    ordner(konto, 'Vodafone');
    assert.equal(themen.stichwortTreffer(konto, 'news@vodafone.de', 'x')?.ordner, 'Vodafone');
  });

  test('nur ganze Teile, kein Teilstring', () => {
    ordner(konto, 'Anbieter', 'Sky');
    assert.equal(themen.stichwortTreffer(konto, 'riskymail@shop.de', 'Hallo'), null,
      '"sky" steckt in "riskymail" — das ist kein Treffer, sondern Zufall');
  });

  test('Allerweltsteile wie info@ oder newsletter@ treffen nichts', () => {
    ordner(konto, 'Anbieter', 'Newsletter, Info, Service');
    assert.equal(themen.stichwortTreffer(konto, 'newsletter@fremde-firma.de', 'Hallo'), null,
      'sonst saugt dieser Ordner jede Newsletter-Adresse an');
  });
});

describe('Stichwort im Betreff', () => {
  test('greift bei einem eindeutigen Wort', () => {
    ordner(konto, 'Bewerbungen', 'Jobsuche, Bewerbung, Vorstellungsgespräch');
    const t = themen.stichwortTreffer(konto, 'personal@firma.de', 'Ihre Bewerbung bei uns');
    assert.equal(t?.ordner, 'Bewerbungen');
    assert.equal(t.wo, 'betreff');
  });

  test('auch als Wortanfang — deutsche Komposita', () => {
    ordner(konto, 'Bewerbungen', 'Bewerbung');
    assert.equal(themen.stichwortTreffer(konto, 'x@y.de', 'Ihre Bewerbungsunterlagen')?.ordner,
      'Bewerbungen');
  });

  test('kurze Woerter ruehren den Betreff nicht an', () => {
    ordner(konto, 'Anbieter', 'Sky, Netflix');
    assert.equal(themen.stichwortTreffer(konto, 'x@y.de', 'Der Blick in den Sky'), null,
      'drei Buchstaben im Betreff sind Zufall, kein Treffer');
  });

  test('zwei Ordner im Betreff heisst: keine Entscheidung', () => {
    ordner(konto, 'Reisen', 'Urlaub, Flugreise');
    ordner(konto, 'Familie', 'Urlaub, Kinder');
    assert.equal(themen.stichwortTreffer(konto, 'x@y.de', 'Unser Urlaub'), null,
      'lieber gar nicht sortieren als falsch');
  });

  test('der Absender schlaegt den Betreff', () => {
    ordner(konto, 'Anbieter', 'Vodafone');
    ordner(konto, 'Bewerbungen', 'Bewerbung');
    assert.equal(themen.stichwortTreffer(konto, 'info@vodafone.de', 'Ihre Bewerbung')?.ordner,
      'Anbieter');
  });
});

describe('Grenzen', () => {
  test('gesperrte Ordner kommen nicht in Frage', () => {
    ordner(konto, 'Archiv', 'Telekom', 1);
    assert.equal(themen.stichwortTreffer(konto, 'info@telekom.de', 'x'), null);
  });

  test('ohne Katalog kein Treffer', () => {
    assert.equal(themen.stichwortTreffer(konto, 'info@telekom.de', 'x'), null);
  });

  test('leere Angaben stuerzen nicht ab', () => {
    ordner(konto, 'Anbieter', 'Telekom');
    assert.equal(themen.stichwortTreffer(konto, '', ''), null);
    assert.equal(themen.stichwortTreffer(konto, null, null), null);
    assert.equal(themen.stichwortTreffer(null, 'a@b.de', 'x'), null);
  });
});

// aufloesen() ist die Stelle, an der die Reihenfolge zaehlt: Ein sicheres Urteil
// der KI ueber einen vorhandenen Ordner geht vor, danach erst die Stichworte —
// und die greifen auch dort, wo die KI vorher alles blockierte.
describe('Zusammenspiel mit der KI-Einordnung', () => {
  const einstellung = (key, wert) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, wert);

  const kontoZeile = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto);

  beforeEach(() => {
    einstellung('themen_sortierung_aktiv', '1');
    einstellung('themen_ordner_anlegen', 'freigabe');
  });

  test('kein Thema von der KI — das Stichwort entscheidet trotzdem', async () => {
    ordner(konto, 'Anbieter', 'Telekom');
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: null, konfidenz: 0, von: 'info@telekom.de', betreff: 'Rechnung',
    });
    assert.equal(t.ordner, 'Anbieter');
    assert.match(t.grund, /Stichwort/);
  });

  test('unsichere KI — das Stichwort entscheidet trotzdem', async () => {
    ordner(konto, 'Anbieter', 'Telekom');
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Irgendwas', konfidenz: 0.2, von: 'info@telekom.de', betreff: 'x',
    });
    assert.equal(t.ordner, 'Anbieter');
  });

  test('ein sicherer KI-Vorschlag auf einen vorhandenen Ordner geht vor', async () => {
    ordner(konto, 'Anbieter', 'Telekom');
    ordner(konto, 'Rechnungen Privat');
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Rechnungen Privat', konfidenz: 0.95,
      von: 'info@telekom.de', betreff: 'x',
    });
    assert.equal(t.ordner, 'Rechnungen Privat', 'die KI hat die Mail gelesen, das Stichwort nicht');
  });

  test('ohne Treffer bleibt es beim alten Verhalten', async () => {
    ordner(konto, 'Anbieter', 'Telekom');
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: null, konfidenz: 0, von: 'a@fremd.de', betreff: 'Hallo',
    });
    assert.equal(t.ordner, null);
    assert.equal(t.grund, 'Kein Thema erkannt');
  });

  test('der Treffer zaehlt am Ordner mit', async () => {
    ordner(konto, 'Anbieter', 'Telekom');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: null, konfidenz: 0, von: 'info@telekom.de', betreff: 'x',
    });
    const zeile = db.prepare("SELECT treffer FROM konto_ordner WHERE ordner = 'Anbieter'").get();
    assert.equal(zeile.treffer, 1);
  });
});

// Die Beschreibung ist kein Notizzettel: Sie geht woertlich in den Prompt und
// wird seit Build 93 als Stichwort ausgewertet. Bis Build 95 landete dort beim
// Freigeben eines Vorschlags die interne Notiz "Zuletzt vorgeschlagen fuer:
// noreply@steampowered.com" — im Prompt nutzlos, als Stichwort schaedlich.
describe('Beschreibungen, die im Katalog gelandet sind', () => {
  test('die alte Notiz macht "vorgeschlagen" zu einem Stichwort', () => {
    ordner(konto, 'Games', 'Zuletzt vorgeschlagen für: noreply@steampowered.com');
    assert.equal(
      themen.stichwortTreffer(konto, 'a@fremd.de', 'Was wurde vorgeschlagen?')?.ordner,
      'Games',
      'genau deshalb wird die Notiz beim Freigeben nicht mehr als Beschreibung gespeichert',
    );
  });

  test('bereinigt bleibt der Absender stehen — und der ist brauchbar', () => {
    ordner(konto, 'Games', 'noreply@steampowered.com');
    assert.equal(themen.stichwortTreffer(konto, 'a@fremd.de', 'Was wurde vorgeschlagen?'), null);
    assert.equal(themen.stichwortTreffer(konto, 'news@steampowered.com', 'Sale')?.ordner, 'Games');
  });
});
