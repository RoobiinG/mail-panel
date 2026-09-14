// Der nächtliche Durchgang durchs Postfach.
//
// Eine Sortier-Regel wirkte bisher nur nach vorn: Wer eine falsch gelernte
// Regel korrigierte, reparierte damit nichts von dem, was schon im falschen
// Ordner lag. Bei einem Postfach, das über Wochen von einem kleinen
// Sprachmodell einsortiert wurde, ist genau das der größere Posten.
//
// Dieser Dienst darf unbeaufsichtigt tausende Mails bewegen. Jeder Test hier
// nagelt deshalb eine Grenze fest, nicht eine Funktion — was er NICHT tun darf,
// ist wichtiger als was er tut.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const imap = require('../src/services/imap');
const themen = require('../src/services/themen');
const n = require('../src/services/nachsortierung');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const regel = (typ, muster, zielordner, opt = {}) => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, betreff_muster, aktion) VALUES (?, ?, ?, ?, ?, ?)',
).run(kontoId(), typ, muster, zielordner, opt.betreff || null, opt.aktion || 'verschieben');

// Was in welchem Ordner liegt — die Testwelt.
let postfach = {};
let ordnerListe = [];
let verschoben = [];

const echt = {
  ordnerDetails: imap.ordnerDetails,
  briefkoepfe: imap.briefkoepfe,
  mailsVerschieben: imap.mailsVerschieben,
  ordnerPfad: themen.ordnerPfad,
};

beforeEach(() => {
  db.exec("DELETE FROM sort_rules; DELETE FROM accounts; DELETE FROM konto_ordner;"
    + " DELETE FROM settings WHERE key LIKE 'nachsortierung%';");
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv, folder_spam)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1, 'Junk')").run();

  postfach = {};
  verschoben = [];
  ordnerListe = [
    { pfad: 'INBOX', spezial: 'inbox', auswaehlbar: true },
    { pfad: 'Einkauf', spezial: null, auswaehlbar: true },
    { pfad: 'Bestellungen', spezial: null, auswaehlbar: true },
  ];

  imap.ordnerDetails = async () => ordnerListe;
  imap.briefkoepfe = async ({ ordner }) => postfach[ordner] || [];
  imap.ordnerErstellen = async () => false;
  imap.mailsVerschieben = async ({ mails, von, nach }) => {
    verschoben.push({ von, nach, uids: mails.map((m) => m.uid) });
    return { verschoben: mails, fehler: [] };
  };
  // Ohne Postfach gibt es keine Ordnerliste — der Pfad bleibt, wie er ist.
  themen.ordnerPfad = async (_konto, pfad) => pfad;
});

afterEach(() => {
  imap.ordnerDetails = echt.ordnerDetails;
  imap.briefkoepfe = echt.briefkoepfe;
  imap.mailsVerschieben = echt.mailsVerschieben;
  imap.ordnerErstellen = echt.ordnerErstellen;
  themen.ordnerPfad = echt.ordnerPfad;
});

const mail = (uid, von, betreff = '') => ({ uid, von, betreff });

describe('Ordner, die nie angefasst werden', () => {
  const rollen = (liste) => n.ordnerAuswahl({ folder_spam: 'Junk' },
    liste.map((r) => ({ pfad: r === 'INBOX' ? 'INBOX' : r, spezial: r === 'INBOX' ? 'inbox' : r.toLowerCase(), auswaehlbar: true })));

  // Etwas aus dem Papierkorb zu holen hieße, Gelöschtes wiederzubeleben.
  test('Papierkorb, Entwürfe, Gesendet und Gmails „Alle Nachrichten" bleiben draußen', () => {
    const raus = rollen(['INBOX', 'trash', 'drafts', 'sent', 'all']);
    assert.deepEqual(raus, ['INBOX']);
  });

  test('das Archiv bleibt drin — dort liegt oft genau das Falschsortierte', () => {
    const details = [
      { pfad: 'Archiv', spezial: 'archive', auswaehlbar: true },
      { pfad: 'Papierkorb', spezial: 'trash', auswaehlbar: true },
    ];
    assert.deepEqual(n.ordnerAuswahl({}, details), ['Archiv']);
  });

  test('der Spam-Ordner des Kontos bleibt draußen, auch als Unterordner', () => {
    const details = [
      { pfad: 'INBOX', spezial: 'inbox', auswaehlbar: true },
      { pfad: 'Junk', spezial: null, auswaehlbar: true },
      { pfad: 'INBOX.Junk', spezial: null, auswaehlbar: true },
    ];
    assert.deepEqual(n.ordnerAuswahl({ folder_spam: 'Junk' }, details), ['INBOX']);
  });

  test('nicht auswählbare Ordner ebenso', () => {
    const details = [
      { pfad: 'Ordner', spezial: null, auswaehlbar: true },
      { pfad: 'Gruppe', spezial: null, auswaehlbar: false },
    ];
    assert.deepEqual(n.ordnerAuswahl({}, details), ['Ordner']);
  });
});

describe('selberOrdner() — dasselbe Fach, andere Schreibweise', () => {
  test('IMAP-Pfade mit Präfix meinen denselben Ordner', () => {
    assert.equal(n.selberOrdner('INBOX.Rechnungen', 'Rechnungen'), true);
    assert.equal(n.selberOrdner('INBOX/Rechnungen', 'rechnungen'), true);
    assert.equal(n.selberOrdner('Rechnungen', 'Rechnungen'), true);
  });

  test('verschiedene Ordner bleiben verschieden', () => {
    assert.equal(n.selberOrdner('Einkauf', 'Bestellungen'), false);
    assert.equal(n.selberOrdner('', 'Bestellungen'), false);
  });
});

describe('Was verschoben wird — und was nicht', () => {
  test('eine Mail, für die eine Regel einen anderen Ordner nennt', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example', 'Deine Lieferung')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 1);
    assert.equal(r.verschoben, 1);
    assert.deepEqual(verschoben, [{ von: 'Einkauf', nach: 'Bestellungen', uids: [1] }]);
  });

  test('eine Mail, die schon im richtigen Ordner liegt, bleibt liegen', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Bestellungen = [mail(1, 'shop@versand.example')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 0);
    assert.deepEqual(verschoben, [], 'sonst zöge sie jede Nacht aufs Neue um');
  });

  test('auch dann, wenn der Server den Ordner mit Präfix schreibt', async () => {
    regel('absender', 'shop@versand.example', 'Rechnungen');
    ordnerListe.push({ pfad: 'INBOX.Rechnungen', spezial: null, auswaehlbar: true });
    postfach['INBOX.Rechnungen'] = [mail(1, 'shop@versand.example')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 0, '„INBOX.Rechnungen" ist derselbe Ordner wie „Rechnungen"');
  });

  // Diese Regel ist die einzige, die ein Nichthandeln anordnet.
  test('eine „in Ruhe lassen"-Regel verschiebt nichts', async () => {
    regel('absender', 'shop@versand.example', '', { aktion: 'behalten' });
    postfach.INBOX = [mail(1, 'shop@versand.example')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 0);
    assert.deepEqual(verschoben, []);
  });

  test('ohne passende Regel passiert nichts — hier arbeitet keine KI', async () => {
    regel('absender', 'wer@anders.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example', 'Deine Lieferung')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.geprueft, 1);
    assert.equal(r.treffer, 0);
  });

  test('die Betreff-Bedingung gilt auch hier', async () => {
    regel('absender', 'info@versand.example', 'Bestellungen', { betreff: 'bestellung' });
    postfach.Einkauf = [
      mail(1, 'info@versand.example', 'Deine Bestellung wurde versandt'),
      mail(2, 'info@versand.example', 'Angebote der Woche'),
    ];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 1);
    assert.deepEqual(verschoben[0].uids, [1]);
  });

  test('mehrere Mails in denselben Ordner gehen in einem Befehl hinaus', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example'), mail(2, 'shop@versand.example')];

    await n.lauf({ trockenlauf: false });
    assert.equal(verschoben.length, 1, 'sonst ist jede Mail eine eigene Rundreise zum Server');
    assert.deepEqual(verschoben[0].uids, [1, 2]);
  });
});

describe('Der Trockenlauf', () => {
  test('zählt, bewegt aber nichts', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example')];

    const r = await n.lauf({ trockenlauf: true });
    assert.equal(r.treffer, 1);
    assert.equal(r.verschoben, 0);
    assert.deepEqual(verschoben, [], 'genau dafür ist er da');
    assert.equal(r.trockenlauf, true);
  });

  test('und sagt, was er täte', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example', 'Deine Lieferung')];

    const r = await n.lauf({ trockenlauf: true });
    const b = r.beispiele[0];
    assert.equal(b.vonOrdner, 'Einkauf');
    assert.equal(b.nachOrdner, 'Bestellungen');
    assert.match(b.regel, /shop@versand\.example/);
  });

  // Ohne diese drei Felder wäre die Liste nur zum Lesen da. Mit der UID lässt
  // sich diese eine Mail umlenken, mit der Regel-Kennung die Ursache — also
  // alle künftigen Mails dieses Absenders gleich mit.
  test('jeder Vorschlag trägt UID, Konto und Regel mit sich', async () => {
    const id = regel('absender', 'shop@versand.example', 'Bestellungen').lastInsertRowid;
    postfach.Einkauf = [mail(7, 'shop@versand.example', 'Deine Lieferung')];

    const b = (await n.lauf({ trockenlauf: true })).beispiele[0];
    assert.equal(b.uid, 7);
    assert.equal(b.kontoId, kontoId());
    assert.equal(b.regelId, id);
  });

  test('ohne Angabe wird die Einstellung genommen — und die steht auf Trockenlauf', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example')];

    const r = await n.lauf();
    assert.equal(r.trockenlauf, true, 'die Voreinstellung darf nichts bewegen');
    assert.deepEqual(verschoben, []);
  });
});

describe('Die Obergrenze', () => {
  test('greift über alle Ordner hinweg, nicht je Ordner', async () => {
    settings.setze('nachsortierung_max', '2');
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.INBOX = [mail(1, 'shop@versand.example'), mail(2, 'shop@versand.example')];
    postfach.Einkauf = [mail(3, 'shop@versand.example')];

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 2, 'die dritte Mail kommt beim nächsten Lauf dran');
  });
});

describe('Ein kaputtes Konto kippt den Lauf nicht', () => {
  test('ist ein Postfach nicht erreichbar, läuft der Rest weiter', async () => {
    const kaputt = db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
      + " VALUES ('Kaputt', 'h2', 993, 'u', 'x', 1)").run().lastInsertRowid;
    regel('absender', 'shop@versand.example', 'Bestellungen');
    // Auch das kaputte Konto braucht eine Regel — ohne Regeln steigt der Lauf
    // aus, bevor er das Postfach überhaupt anspricht.
    db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'absender', 'x@y.example', 'Z')")
      .run(kaputt);
    postfach.Einkauf = [mail(1, 'shop@versand.example')];

    imap.ordnerDetails = async (konto) => {
      if (konto.name === 'Kaputt') throw new Error('Postfach nicht erreichbar');
      return ordnerListe;
    };

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 1, 'das gesunde Konto wurde bearbeitet');
    assert.equal(r.fehler.length, 1);
    assert.match(r.fehler[0], /Kaputt/);
  });

  test('ein Ordner, der sich nicht lesen lässt, überspringt nur sich selbst', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example')];
    imap.briefkoepfe = async ({ ordner }) => {
      if (ordner === 'INBOX') throw new Error('gesperrt');
      return postfach[ordner] || [];
    };

    const r = await n.lauf({ trockenlauf: false });
    assert.equal(r.treffer, 1);
    assert.match(r.fehler[0], /INBOX/);
  });
});

describe('Eine einzelne Mail aus der Vorschlagsliste umlenken', () => {
  const express = require('express');

  const request = async (pfad, rumpf) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
    app.use('/api/sortierung', require('../src/routes/sortierung'));
    const server = await new Promise((f) => { const s = app.listen(0, () => f(s)); });
    try {
      const { port } = server.address();
      const r = await fetch(`http://127.0.0.1:${port}${pfad}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rumpf),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    } finally {
      await new Promise((f) => server.close(f));
    }
  };

  test('verschiebt genau diese Mail — und lässt die Regel in Ruhe', async () => {
    const id = regel('absender', 'shop@versand.example', 'Bestellungen').lastInsertRowid;
    imap.ordnerErstellen = async () => false;

    const r = await request('/api/sortierung/nachsortierung/verschieben', {
      konto_id: kontoId(), uid: 7, von: 'Einkauf', nach: 'Rechnungen',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(verschoben, [{ von: 'Einkauf', nach: 'Rechnungen', uids: [7] }]);
    assert.equal(
      db.prepare('SELECT zielordner z FROM sort_rules WHERE id = ?').get(id).z,
      'Bestellungen',
      'die Regel bleibt falsch — genau das ist der Unterschied zu „Regel ändern"',
    );
  });

  test('eine unbrauchbare UID wird abgewiesen, bevor IMAP überhaupt gefragt wird', async () => {
    for (const uid of [0, -1, 'abc', null]) {
      const r = await request('/api/sortierung/nachsortierung/verschieben', {
        konto_id: kontoId(), uid, von: 'Einkauf', nach: 'Rechnungen',
      });
      assert.equal(r.status, 400, `UID ${JSON.stringify(uid)} hätte abgewiesen werden müssen`);
    }
    assert.deepEqual(verschoben, []);
  });

  test('ohne Quell- oder Zielordner passiert nichts', async () => {
    const ohneZiel = await request('/api/sortierung/nachsortierung/verschieben', {
      konto_id: kontoId(), uid: 7, von: 'Einkauf', nach: '  ',
    });
    assert.equal(ohneZiel.status, 400);
    assert.deepEqual(verschoben, []);
  });

  test('ein unbekanntes Konto ebenso', async () => {
    const r = await request('/api/sortierung/nachsortierung/verschieben', {
      konto_id: 99999, uid: 7, von: 'Einkauf', nach: 'Rechnungen',
    });
    assert.equal(r.status, 400);
  });

  test('bewegt sich nichts, meldet die Route das auch', async () => {
    imap.ordnerErstellen = async () => false;
    imap.mailsVerschieben = async () => ({ verschoben: [], fehler: [{ uid: 7, grund: 'nicht in "Einkauf" gefunden' }] });

    const r = await request('/api/sortierung/nachsortierung/verschieben', {
      konto_id: kontoId(), uid: 7, von: 'Einkauf', nach: 'Rechnungen',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /nicht in "Einkauf" gefunden/);
  });
});

describe('Das Ergebnis bleibt stehen', () => {
  test('der letzte Lauf steht in den Einstellungen und übersteht einen Neustart', async () => {
    regel('absender', 'shop@versand.example', 'Bestellungen');
    postfach.Einkauf = [mail(1, 'shop@versand.example')];

    await n.lauf({ trockenlauf: true });
    const gelesen = n.letzterLauf();
    assert.equal(gelesen.treffer, 1);
    assert.ok(gelesen.zeitpunkt, 'ohne Zeitpunkt weiß der Zeitplan nicht, wann er wieder dran ist');
  });

  test('faellig() wartet den eingestellten Takt ab', async () => {
    settings.setze('nachsortierung_aktiv', '1');
    settings.setze('nachsortierung_takt', '24');
    assert.equal(n.faellig(), true, 'ohne bisherigen Lauf ist sofort fällig');

    settings.setze('nachsortierung_letzter_lauf', JSON.stringify({ zeitpunkt: new Date().toISOString() }));
    assert.equal(n.faellig(), false);

    const gestern = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    settings.setze('nachsortierung_letzter_lauf', JSON.stringify({ zeitpunkt: gestern }));
    assert.equal(n.faellig(), true);
  });

  test('ausgeschaltet ist nie etwas fällig', () => {
    settings.setze('nachsortierung_aktiv', '0');
    assert.equal(n.faellig(), false);
  });
});
