// "Games" und "Gaming". "News" und "Nachrichten". "Rechnung" und "Rechnungen".
//
// Die KI erfindet fuer dasselbe Thema gern zwei Namen, und jeder davon wurde
// bisher ein eigener Vorschlag und am Ende ein eigener Ordner. Im Panel standen
// 34 Vorschlaege, von denen etliche dasselbe meinten.
//
// Diese Datei nagelt fest, was als "dasselbe" gilt — und, mindestens genauso
// wichtig, was NICHT. Jede Zeile in der Synonymliste ist eine Behauptung; hier
// steht, wo sie aufhoert.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const themen = require('../src/services/themen');

const kontoAnlegen = (name = 'K') => db.prepare(
  "INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
  + " VALUES (?, 'h', 993, 'u', 'x', 1)",
).run(name).lastInsertRowid;

const ordner = (kontoId, name, treffer = 0) => db.prepare(
  "INSERT INTO konto_ordner (konto_id, ordner, quelle, treffer) VALUES (?, ?, 'ki', ?)",
).run(kontoId, name, treffer);

const vorschlag = (kontoId, name, anzahl = 1, status = 'offen') => db.prepare(
  'INSERT INTO ordner_vorschlaege (konto_id, ordner, anzahl, status) VALUES (?, ?, ?, ?)',
).run(kontoId, name, anzahl, status).lastInsertRowid;

const offeneVorschlaege = (kontoId) => db.prepare(
  "SELECT ordner, anzahl FROM ordner_vorschlaege WHERE konto_id = ? AND status = 'offen' ORDER BY ordner",
).all(kontoId);

beforeEach(() => {
  db.exec('DELETE FROM ordner_vorschlaege; DELETE FROM konto_ordner; DELETE FROM sort_inbox;'
    + ' DELETE FROM ordner_alias; DELETE FROM accounts;');
});

describe('Was dasselbe meint', () => {
  test('Einzahl und Mehrzahl', () => {
    assert.ok(themen.aehnlich('Rechnung', 'Rechnungen'));
    assert.ok(themen.aehnlich('Reise', 'Reisen'));
    assert.ok(themen.aehnlich('Newsletter', 'Newsletters'));
    assert.ok(themen.aehnlich('Sport', 'Sports'));
  });

  test('dieselbe Wurzel, andere Endung — der Fall aus dem Panel', () => {
    assert.ok(themen.aehnlich('Games', 'Gaming'));
    assert.ok(themen.aehnlich('Streaming', 'Streams'));
    assert.ok(themen.aehnlich('Bank', 'Banking'));
  });

  test('Gross-/Kleinschreibung, Umlaute, Pfade', () => {
    assert.ok(themen.aehnlich('GESUNDHEIT', 'gesundheit'));
    assert.ok(themen.aehnlich('Bücher', 'Buecher') === false, 'ue wird nicht zu ü geraten');
    assert.ok(themen.aehnlich('Themen/Games', 'Games'), 'der Pfad zaehlt nur mit dem letzten Stueck');
  });

  test('deutsch und englisch fuer dieselbe Sache', () => {
    assert.ok(themen.aehnlich('News', 'Nachrichten'));
    assert.ok(themen.aehnlich('Gesundheit', 'Health'));
    assert.ok(themen.aehnlich('Spiele', 'Games'));
  });

  test('und wo es aufhoert — sonst landet alles in einem Topf', () => {
    assert.equal(themen.aehnlich('Games', 'Gesundheit'), false);
    assert.equal(themen.aehnlich('Auto', 'Autor'), false);
    assert.equal(themen.aehnlich('Bank', 'Bankrott'), false);
    assert.equal(themen.aehnlich('Reisen', 'Reifen'), false);
    assert.equal(themen.aehnlich('Musik', 'Muskel'), false);
    assert.equal(themen.aehnlich('', 'Games'), false);
    assert.equal(themen.aehnlich('AB', 'ABC'), false, 'zu kurz, um etwas zu unterscheiden');
  });
});

describe('Der Katalog trifft den vorhandenen Ordner', () => {
  test('"Gaming" landet im vorhandenen Ordner "Games"', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games', 8);
    const treffer = themen.imKatalog(id, 'Gaming');
    assert.ok(treffer, 'sonst entsteht ein zweiter Ordner daneben');
    assert.equal(treffer.ordner, 'Games');
  });

  test('der genaue Name geht weiterhin vor', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games', 2);
    ordner(id, 'Gaming', 9);
    assert.equal(themen.imKatalog(id, 'Gaming').ordner, 'Gaming');
  });

  test('"NEU:" davor stoert nicht', () => {
    const id = kontoAnlegen();
    ordner(id, 'Reisen');
    assert.equal(themen.imKatalog(id, 'NEU: Reise').ordner, 'Reisen');
  });

  test('was nicht passt, passt nicht', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games');
    assert.equal(themen.imKatalog(id, 'Steuern'), null);
  });
});

describe('Vorschläge zusammenfassen', () => {
  test('ein aehnlicher Vorschlag zaehlt hoch, statt danebenzustehen', () => {
    const id = kontoAnlegen();
    themen.vorschlagMerken(id, 'Games', 'erste');
    const zweiter = themen.vorschlagMerken(id, 'Gaming', 'zweite');
    assert.equal(zweiter.ordner, 'Games', 'gezaehlt wird unter dem ersten Namen');
    assert.deepEqual(offeneVorschlaege(id), [{ ordner: 'Games', anzahl: 2 }]);
  });

  test('abgelehnt bleibt abgelehnt — auch unter anderem Namen', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Games', 3, 'abgelehnt');
    const wieder = themen.vorschlagMerken(id, 'Gaming', 'noch mal');
    assert.equal(wieder.status, 'abgelehnt');
    assert.deepEqual(offeneVorschlaege(id), [], 'sonst kaeme dieselbe Idee unter neuem Namen zurueck');
  });

  test('etwas anderes wird auch als etwas anderes gefuehrt', () => {
    const id = kontoAnlegen();
    themen.vorschlagMerken(id, 'Games', 'a');
    themen.vorschlagMerken(id, 'Steuern', 'b');
    assert.equal(offeneVorschlaege(id).length, 2);
  });

  test('zwei Konten kommen sich nicht in die Quere', () => {
    const a = kontoAnlegen('A');
    const b = kontoAnlegen('B');
    themen.vorschlagMerken(a, 'Games', '1');
    themen.vorschlagMerken(b, 'Gaming', '2');
    assert.deepEqual(offeneVorschlaege(a), [{ ordner: 'Games', anzahl: 1 }]);
    assert.deepEqual(offeneVorschlaege(b), [{ ordner: 'Gaming', anzahl: 1 }]);
  });
});

describe('Nachträglich aufräumen', () => {
  test('führt zusammen, was sich schon angesammelt hat', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Games', 8);
    vorschlag(id, 'Gaming', 6);
    vorschlag(id, 'Streaming', 6);

    assert.equal(themen.vorschlaegeAufraeumen(), 1);
    assert.deepEqual(offeneVorschlaege(id), [
      { ordner: 'Games', anzahl: 14 },
      { ordner: 'Streaming', anzahl: 6 },
    ]);
  });

  test('bei Gleichstand gewinnt der kürzere Name', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Videospiele', 5);
    vorschlag(id, 'Games', 5);
    themen.vorschlaegeAufraeumen();
    assert.deepEqual(offeneVorschlaege(id), [{ ordner: 'Games', anzahl: 10 }]);
  });

  test('die wartenden Mails werden mitgezogen', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Games', 8);
    vorschlag(id, 'Gaming', 6);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, ki_ordner, status)"
      + " VALUES ('K', ?, 'a@b.de', '5', 'Gaming', 'offen')").run(id);

    themen.vorschlaegeAufraeumen();
    const mail = db.prepare('SELECT ki_ordner FROM sort_inbox WHERE konto_id = ?').get(id);
    assert.equal(mail.ki_ordner, 'Games',
      'sonst findet die Freigabe die wartende Mail spaeter nicht mehr');
  });

  test('Abgelehntes verschluckt keinen offenen Vorschlag', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Games', 9, 'abgelehnt');
    vorschlag(id, 'Gaming', 2, 'offen');
    themen.vorschlaegeAufraeumen();
    assert.deepEqual(offeneVorschlaege(id), [{ ordner: 'Gaming', anzahl: 2 }]);
  });

  test('zweimal aufräumen ändert nichts mehr', () => {
    const id = kontoAnlegen();
    vorschlag(id, 'Games', 8);
    vorschlag(id, 'Gaming', 6);
    themen.vorschlaegeAufraeumen();
    assert.equal(themen.vorschlaegeAufraeumen(), 0);
  });
});

describe('Was die KI im Prompt sieht', () => {
  test('wartende Vorschläge stehen mit drin', () => {
    const id = kontoAnlegen();
    ordner(id, 'Rechnungen', 5);
    vorschlag(id, 'Games', 8);
    const namen = themen.fuerPrompt(id).map((o) => o.name);
    assert.ok(namen.includes('Rechnungen'));
    assert.ok(namen.includes('Games'),
      'ohne diesen Eintrag erfindet das Modell beim naechsten Mal "Gaming"');
  });

  test('ein Vorschlag, den es als Ordner schon gibt, steht nicht doppelt drin', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games', 5);
    vorschlag(id, 'Gaming', 3);
    const namen = themen.fuerPrompt(id).map((o) => o.name);
    assert.deepEqual(namen, ['Games']);
  });
});

// "Kein neuer Ordner — das gehoert nach X." Diese Entscheidung trifft der
// Nutzer an einem Vorschlag, und sie muss beim naechsten Mal von selbst
// greifen. Sonst steht dieselbe Mail in einer Woche wieder unsortiert da.
describe('Umgeleitete Namen', () => {
  test('der umgeleitete Name landet im gewaehlten Ordner', () => {
    const id = kontoAnlegen();
    ordner(id, 'Spiele', 4);
    themen.aliasMerken(id, 'Gaming', 'Spiele');
    assert.equal(themen.imKatalog(id, 'Gaming').ordner, 'Spiele');
  });

  test('die Entscheidung des Nutzers schlaegt die Aehnlichkeit', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games', 9);     // waere der Treffer ueber den Wortstamm
    ordner(id, 'Spiele', 1);
    themen.aliasMerken(id, 'Gaming', 'Spiele');
    assert.equal(themen.imKatalog(id, 'Gaming').ordner, 'Spiele',
      'wer umleitet, meint es auch so');
  });

  test('der genaue Ordnername bleibt unangetastet', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games');
    ordner(id, 'Spiele');
    themen.aliasMerken(id, 'Gaming', 'Spiele');
    assert.equal(themen.imKatalog(id, 'Games').ordner, 'Games');
  });

  test('zeigt die Umleitung ins Leere, greift wieder die Aehnlichkeit', () => {
    const id = kontoAnlegen();
    ordner(id, 'Games');
    themen.aliasMerken(id, 'Gaming', 'Geloescht');
    assert.equal(themen.imKatalog(id, 'Gaming').ordner, 'Games');
  });

  test('geloest ist geloest', () => {
    const id = kontoAnlegen();
    ordner(id, 'Steuern');
    themen.aliasMerken(id, 'Finanzamt', 'Steuern');
    const [a] = themen.aliasListe(id);
    assert.equal(themen.imKatalog(id, 'Finanzamt').ordner, 'Steuern');
    assert.equal(themen.aliasVergessen(a.id), true);
    assert.equal(themen.imKatalog(id, 'Finanzamt'), null);
  });

  test('Umleitungen gelten je Konto', () => {
    const a = kontoAnlegen('A');
    const b = kontoAnlegen('B');
    ordner(a, 'Spiele');
    ordner(b, 'Spiele');
    themen.aliasMerken(a, 'Gaming', 'Spiele');
    assert.equal(themen.imKatalog(a, 'Gaming').ordner, 'Spiele');
    assert.equal(themen.imKatalog(b, 'Gaming'), null);
  });
});
