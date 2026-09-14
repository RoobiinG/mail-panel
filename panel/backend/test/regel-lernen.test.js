// Woraus eine Dauerregel entstehen darf — und woraus nicht.
//
// Eine gelernte Regel sortiert neunzig Tage lang ohne KI und ohne Rückfrage.
// Sie ist damit das Folgenreichste, was das Panel von allein tut; eine falsche
// fällt niemandem auf, weil danach genau nichts mehr passiert.
//
// Gezählt wurde bis Build 189 nach der DOMAIN, während die Regel auf den exakten
// Absender ging. Im Betrieb am 13.09.:
//
//     Regel gelernt [absender]: suche@portal.example    → Newsletter (3 Mails)
//     Regel gelernt [absender]: konto@portal.example → Rechnungen (3 Mails)
//
// Beide „3 Mails" waren dieselbe Domain-Zählung. Die Erfahrung mit einem
// Absender stützte die Dauerregel eines anderen — genau die Fehleranfälligkeit,
// wegen der die Domain-Regeln abgeschaltet wurden, nur eine Ebene tiefer.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const themen = require('../src/services/themen');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const log = (von, zielordner) => db.prepare(
  "INSERT INTO quarantine_log (konto, von, zielordner) VALUES ('K', ?, ?)",
).run(von, zielordner);

const regeln = () => db.prepare('SELECT typ, muster, zielordner FROM sort_rules').all();

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_rules; DELETE FROM accounts;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('Gelernt wird nur aus dem, was der Absender selbst belegt', () => {
  test('drei Mails desselben Absenders im selben Ordner ergeben eine Regel', () => {
    for (let i = 0; i < 3; i++) log('suche@portal.example', 'Newsletter');
    const gelernt = themen.regelLernen(kontoId(), 'suche@portal.example', 'Newsletter');
    assert.ok(gelernt, 'dafür ist die Funktion da');
    assert.equal(gelernt.typ, 'absender');
    assert.equal(gelernt.muster, 'suche@portal.example');
    assert.equal(gelernt.zielordner, 'Newsletter');
  });

  // Der Kern des Fehlers: Die Belege gehören einem anderen Absender.
  test('drei Mails derselben Domain, aber anderer Absender: keine Regel', () => {
    for (let i = 0; i < 3; i++) log('suche@portal.example', 'Rechnungen');
    assert.equal(
      themen.regelLernen(kontoId(), 'konto@portal.example', 'Rechnungen'),
      false,
      'sonst sortiert ein Absender neunzig Tage nach der Erfahrung mit einem anderen',
    );
    assert.equal(regeln().length, 0);
  });

  test('gemischt gezählt reicht es nicht — nur die eigenen Mails zählen', () => {
    log('konto@portal.example', 'Rechnungen');
    log('suche@portal.example', 'Rechnungen');
    log('newsletter@portal.example', 'Rechnungen');
    assert.equal(
      themen.regelLernen(kontoId(), 'konto@portal.example', 'Rechnungen'),
      false,
      'drei Mails der Domain, aber nur eine von diesem Absender',
    );
  });

  test('unter der Schwelle passiert nichts', () => {
    log('a@shop.de', 'Bestellungen');
    log('a@shop.de', 'Bestellungen');
    assert.equal(themen.regelLernen(kontoId(), 'a@shop.de', 'Bestellungen'), false);
  });

  // Mails desselben Absenders in einen ANDEREN Ordner sind kein Beleg für diesen.
  test('Mails in einen anderen Ordner zählen nicht mit', () => {
    for (let i = 0; i < 3; i++) log('a@shop.de', 'Newsletter');
    assert.equal(themen.regelLernen(kontoId(), 'a@shop.de', 'Bestellungen'), false);
  });

  test('die Schreibweise des Absenders ist egal', () => {
    log('"Shop" <A@Shop.de>', 'Bestellungen');
    log('a@shop.de', 'Bestellungen');
    log('<A@SHOP.DE>', 'Bestellungen');
    const gelernt = themen.regelLernen(kontoId(), 'a@shop.de', 'Bestellungen');
    assert.ok(gelernt, 'dieselbe Adresse, nur anders geschrieben');
    assert.equal(gelernt.muster, 'a@shop.de');
  });
});

// Der zweite Fall, aus dem Betrieb am 14.09.: Das Modell stufte dieselbe Mail
// innerhalb eines Laufs dreimal verschieden ein — einmal „newsletter", zweimal
// „rechnung", mit drei verschiedenen Themen. Aus solchen Läufen entstand
//
//     Regel gelernt [absender]: marktplatz@versand.example → Anbieter, Vertraege und co.
//
// und damit wanderte neunzig Tage lang jede Versandbestätigung dieses Absenders
// in einen Ordner für Telefon- und Streaming-Verträge. Ohne KI, ohne Rückfrage,
// ohne dass es noch auffiel.
describe('Widersprüchliche Belege ergeben keine Regel', () => {
  test('derselbe Absender in zwei Ordnern: nichts wird gelernt', () => {
    for (let i = 0; i < 3; i++) log('marktplatz@versand.example', 'Bestellungen');
    log('marktplatz@versand.example', 'Werbung');

    assert.equal(
      themen.regelLernen(kontoId(), 'marktplatz@versand.example', 'Bestellungen'),
      false,
      'drei Treffer reichen nicht, wenn derselbe Absender auch anderswo landet',
    );
    assert.equal(regeln().length, 0);
  });

  test('erst wenn es eindeutig ist, wird gelernt', () => {
    for (let i = 0; i < 3; i++) log('marktplatz@versand.example', 'Bestellungen');
    const gelernt = themen.regelLernen(kontoId(), 'marktplatz@versand.example', 'Bestellungen');
    assert.ok(gelernt);
    assert.equal(gelernt.zielordner, 'Bestellungen');
  });

  // Ein Versandhändler, der Bestellbestätigungen UND Werbung schickt, bekommt
  // gar keine Regel. Richtig so: Genau dafür wurden die Domain-Regeln schon
  // einmal abgeschaltet.
  test('wer zweierlei verschickt, bekommt keine Dauerregel', () => {
    for (let i = 0; i < 5; i++) log('info@versand.example', 'Bestellungen');
    for (let i = 0; i < 5; i++) log('info@versand.example', 'Newsletter');
    assert.equal(themen.regelLernen(kontoId(), 'info@versand.example', 'Bestellungen'), false);
    assert.equal(themen.regelLernen(kontoId(), 'info@versand.example', 'Newsletter'), false);
  });

  // Ein anderer Absender darf weiter lernen, auch wenn der Nachbar uneindeutig
  // ist — gezählt wird ja je Absender.
  test('der Widerspruch eines anderen Absenders stört nicht', () => {
    log('durcheinander@versand.example', 'Bestellungen');
    log('durcheinander@versand.example', 'Newsletter');
    for (let i = 0; i < 3; i++) log('klar@versand.example', 'Bestellungen');

    const gelernt = themen.regelLernen(kontoId(), 'klar@versand.example', 'Bestellungen');
    assert.ok(gelernt, 'die Belege dieses Absenders sind eindeutig');
  });
});

describe('Was schon geregelt ist, wird nicht neu gelernt', () => {
  test('eine vorhandene Absender-Regel genügt', () => {
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'absender', 'a@shop.de', 'X')")
      .run(kontoId());
    for (let i = 0; i < 3; i++) log('a@shop.de', 'Bestellungen');
    assert.equal(themen.regelLernen(kontoId(), 'a@shop.de', 'Bestellungen'), false);
    assert.equal(regeln().length, 1, 'keine zweite, widersprüchliche Regel');
  });

  test('eine von Hand angelegte Domain-Regel ebenso', () => {
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'domain', 'shop.de', 'X')")
      .run(kontoId());
    for (let i = 0; i < 3; i++) log('a@shop.de', 'Bestellungen');
    assert.equal(themen.regelLernen(kontoId(), 'a@shop.de', 'Bestellungen'), false,
      'die Domain-Regel ist die Entscheidung des Nutzers');
  });

  test('ohne brauchbare Absenderadresse wird nichts gelernt', () => {
    assert.equal(themen.regelLernen(kontoId(), 'kein-at-zeichen', 'X'), false);
    assert.equal(themen.regelLernen(kontoId(), '', 'X'), false);
  });
});
