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
  db.exec('DELETE FROM konto_ordner; DELETE FROM sort_inbox; DELETE FROM accounts;'
    + ' DELETE FROM quarantine_log;');
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

  test('ein sicherer KI-Vorschlag auf einen vorhandenen Ordner wird vom Stichwort überschrieben', async () => {
    einstellung('sichere_ordner', 'rechnungen privat');
    ordner(konto, 'Anbieter', 'Telekom');
    ordner(konto, 'Rechnungen Privat');
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Rechnungen Privat', konfidenz: 0.95,
      von: 'info@telekom.de', betreff: 'x',
    });
    // Ab Stufe 6 sticht das Stichwort (harte Nutzervorgabe) immer die KI!
    assert.equal(t.ordner, 'Anbieter', 'Stichwort ist eine harte Vorgabe und sticht KI');
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

// Die KI soll aus der Beschreibung schliessen, nicht nur abgleichen — und was
// sie dabei erkennt, muss haengenbleiben. Sonst wird dieselbe Einsicht bei jeder
// Mail neu (und kostenpflichtig) getroffen.
describe('Gelerntes aus der KI-Zuordnung', () => {
  const einstellung = (key, wert) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, wert);
  const kontoZeile = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto);
  const eintrag = (name) => db.prepare('SELECT * FROM konto_ordner WHERE ordner = ?').get(name);

  beforeEach(() => {
    einstellung('themen_sortierung_aktiv', '1');
    einstellung('themen_ordner_anlegen', 'freigabe');
  });

  test('ein vorhandener Ordner, der NICHT als sicher markiert ist, geht in die Sortier-Inbox', async () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky');
    einstellung('sichere_ordner', 'games'); // Anbieter ist NICHT sicher
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Anbieter', konfidenz: 0.95, von: 'info@o2.de', betreff: 'x',
    });
    assert.equal(t.ordner, null, 'es ist kein sicherer Ordner, daher null für Sortier-Inbox');
    assert.match(t.grund, /Kritischer Ordner/);
  });

  test('fuer einen neuen Ordner reicht dieselbe Sicherheit nicht', async () => {
    const t = await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'NEU:Irgendwas', konfidenz: 0.5, von: 'a@b.de', betreff: 'x',
    });
    assert.equal(t.ordner, null);
    assert.match(t.grund, /neuen Ordner zu unsicher/);
  });

  // Seit Build 200 genügt dafür nicht mehr EINE Einordnung: Was am Ordner
  // steht, wirkt beim nächsten Mal ohne KI, und dafür ist eine einzelne
  // Vermutung eines kleinen Modells zu wenig (siehe „Gelernt wird erst, wenn es
  // belegt ist" weiter unten). Die Absicht bleibt dieselbe — nur der Beleg
  // muss jetzt da sein.
  const belege = (von, ordnerName, anzahl = 2) => {
    for (let i = 0; i < anzahl; i += 1) {
      db.prepare("INSERT INTO quarantine_log (konto, von, zielordner) VALUES ('K', ?, ?)")
        .run(von, ordnerName);
    }
  };

  test('der erkannte Absender wird vermerkt', async () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky');
    belege('info@o2.de', 'Anbieter');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Anbieter', konfidenz: 0.8, von: 'info@o2.de', betreff: 'x',
    });
    assert.equal(eintrag('Anbieter').gelernt, 'o2.de');
  });

  test('und trifft danach ohne KI', async () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky');
    belege('info@o2.de', 'Anbieter');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Anbieter', konfidenz: 0.8, von: 'info@o2.de', betreff: 'x',
    });
    const t = themen.stichwortTreffer(konto, 'werbung@o2.de', 'Neues Angebot');
    assert.equal(t?.ordner, 'Anbieter', 'die zweite o2-Mail kostet kein Budget mehr');
  });

  test('was schon per Stichwort traf, wird nicht doppelt vermerkt', async () => {
    ordner(konto, 'Anbieter', 'Vodafone');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Anbieter', konfidenz: 0.9, von: 'info@vodafone.de', betreff: 'x',
    });
    assert.equal(eintrag('Anbieter').gelernt, null, 'stand ja schon in der Beschreibung');
  });

  test('hoechstens zwoelf, die aelteste faellt raus', () => {
    ordner(konto, 'Sammel');
    const id = eintrag('Sammel').id;
    for (let i = 1; i <= 14; i += 1) themen.gelerntMerken(id, `a@nr${i}.de`);
    const liste = themen.gelernteListe(eintrag('Sammel'));
    assert.equal(liste.length, 12);
    assert.equal(liste[0], 'nr3.de', 'die ersten beiden sind rausgefallen');
    assert.equal(liste[11], 'nr14.de');
  });

  test('eine Korrektur nimmt den Absender wieder heraus', () => {
    ordner(konto, 'Anbieter');
    const id = eintrag('Anbieter').id;
    themen.gelerntMerken(id, 'info@o2.de');
    assert.equal(themen.gelerntVergessen(konto, 'Anbieter', 'info@o2.de'), true);
    assert.equal(eintrag('Anbieter').gelernt, null,
      'sonst zementiert sich ein Fehler und wirkt beim naechsten Mal ohne KI');
  });

  test('Gelerntes steht im Prompt, getrennt vom Nutzertext', () => {
    ordner(konto, 'Anbieter', 'Vodafone, Sky');
    themen.gelerntMerken(eintrag('Anbieter').id, 'info@o2.de');
    const [zeile] = themen.fuerPrompt(konto).filter((o) => o.name === 'Anbieter');
    assert.match(zeile.beschreibung, /Vodafone, Sky/);
    assert.match(zeile.beschreibung, /bisher hier gelandet: o2\.de/);
  });
});

// Gelerntes sind ganze Domains. Als Woerter zerlegt faellt ausgerechnet das
// durch, was kurz ist — "o2" hat zwei Zeichen, "de" sagt nichts.
describe('Gelerntes wird als Domain verglichen', () => {
  test('kurze Marken wie o2 treffen trotzdem', () => {
    ordner(konto, 'Anbieter', 'Vodafone');
    const id = db.prepare("SELECT id FROM konto_ordner WHERE ordner = 'Anbieter'").get().id;
    themen.gelerntMerken(id, 'info@o2.de');
    assert.equal(themen.stichwortTreffer(konto, 'werbung@o2.de', 'Angebot')?.ordner, 'Anbieter');
  });

  test('auch eine Unterdomain zaehlt', () => {
    ordner(konto, 'Anbieter');
    const id = db.prepare("SELECT id FROM konto_ordner WHERE ordner = 'Anbieter'").get().id;
    themen.gelerntMerken(id, 'a@o2.de');
    assert.equal(themen.stichwortTreffer(konto, 'x@news.o2.de', 'y')?.ordner, 'Anbieter');
  });

  test('eine fremde Domain nicht', () => {
    ordner(konto, 'Anbieter');
    const id = db.prepare("SELECT id FROM konto_ordner WHERE ordner = 'Anbieter'").get().id;
    themen.gelerntMerken(id, 'a@o2.de');
    assert.equal(themen.stichwortTreffer(konto, 'x@no2.de', 'y'), null,
      '"no2.de" endet zwar auf "o2.de", ist aber eine andere Domain');
  });
});

// ─── Was sich am Ordner festsetzen darf ──────────────────────────────────────
//
// Steht eine Absender-Domain erst am Ordner, trifft beim nächsten Mal schon der
// Stichwort-Vergleich — ohne KI, ohne Rückfrage, ohne dass es im Protokoll
// auffiele. Im Betrieb am 14.09. sah man genau das:
//
//     Regel gelernt [absender]: notifications@lieferung.example → Banking
//     Stichwort „lieferung.example" aus der Ordner-Beschreibung (Absender)   13×
//
// Eine Essenslieferung im Banking-Ordner, dreizehnmal, ohne dass die KI je
// wieder gefragt wurde. Eine einzelne Einordnung eines kleinen Modells ist kein
// Beleg, sondern eine Vermutung.
describe('Gelernt wird erst, wenn es belegt ist', () => {
  const log = (von, zielordner) => db.prepare(
    "INSERT INTO quarantine_log (konto, von, zielordner) VALUES ('K', ?, ?)",
  ).run(von, zielordner);

  const kontoZeile = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto);
  const gelernt = (name) => db.prepare('SELECT gelernt FROM konto_ordner WHERE ordner = ?').get(name)?.gelernt;

  beforeEach(() => {
    db.exec('DELETE FROM quarantine_log;');
    db.prepare("INSERT INTO settings (key, value) VALUES ('themen_sortierung_aktiv', '1')"
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
  });

  test('eine einzelne KI-Einordnung schreibt nichts fest', async () => {
    ordner(konto, 'Banking');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Banking', konfidenz: 1,
      von: 'notifications@lieferung.example', betreff: 'Änderung Deiner Lieferzeit',
    });
    assert.equal(gelernt('Banking'), null,
      'sonst entscheidet ab der zweiten Mail der Stichwort-Vergleich statt der KI');
  });

  test('zwei gleiche Einordnungen genügen', async () => {
    ordner(konto, 'Banking');
    log('notifications@lieferung.example', 'Banking');
    log('notifications@lieferung.example', 'Banking');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Banking', konfidenz: 1,
      von: 'notifications@lieferung.example', betreff: 'x',
    });
    assert.match(gelernt('Banking') || '', /lieferung\.example/);
  });

  test('widersprüchliche Belege schreiben nichts fest', async () => {
    ordner(konto, 'Banking');
    log('notifications@lieferung.example', 'Banking');
    log('notifications@lieferung.example', 'Banking');
    log('notifications@lieferung.example', 'Werbung');
    await themen.aufloesen({
      konto: kontoZeile(), vorschlag: 'Banking', konfidenz: 1,
      von: 'notifications@lieferung.example', betreff: 'x',
    });
    assert.equal(gelernt('Banking'), null,
      'wer zweierlei verschickt, gehört in keinen der beiden Ordner zementiert');
  });

  test('gelerntBelegt zählt nach Domain, nicht nach Anzeigename', () => {
    log('"lieferung.example Support" <a@fremd.example>', 'Banking');
    log('"lieferung.example Support" <a@fremd.example>', 'Banking');
    assert.equal(
      themen.gelerntBelegt(kontoZeile(), 'Banking', 'b@lieferung.example'),
      false,
      'der Anzeigename ist frei wählbar — er darf nichts belegen',
    );
  });

  // Eine Korrektur des Nutzers ist etwas anderes als eine KI-Vermutung: Sie
  // schreibt weiterhin sofort fest, denn dort hat ein Mensch hingesehen.
  test('gelerntMerken selbst bleibt unverändert — die Korrektur wirkt sofort', () => {
    ordner(konto, 'Banking');
    const id = db.prepare("SELECT id FROM konto_ordner WHERE ordner = 'Banking'").get().id;
    assert.equal(themen.gelerntMerken(id, 'a@lieferung.example'), true);
    assert.match(gelernt('Banking'), /lieferung\.example/);
  });
});
