// Die KI-Nachsortierung: Was ein Modell vorschlägt, kommt erst nach der Prüfung in
// die Vorschlagsliste — und nie ungeprüft in einen Pfad.
//
// Bis Build 253 übernahm kontoDurchgehen() `res.ordner` des Klassifizierers ohne
// Namensprüfung und ohne Blick auf die Konfidenz. Ein Name wie "../../x" oder
// "Papierkorb" erreichte die Oberfläche, und von dort über „Nur diese Mail" einen
// IMAP-CREATE.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const imap = require('../src/services/imap');
const themen = require('../src/services/themen');
const klassifizierer = require('../src/services/klassifizierer');
const n = require('../src/services/nachsortierung');

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const echt = {
  ordnerDetails: imap.ordnerDetails,
  briefkoepfe: imap.briefkoepfe,
  mailLaden: imap.mailLaden,
  ordnerErstellen: imap.ordnerErstellen,
  mailsVerschieben: imap.mailsVerschieben,
  klassifizieren: klassifizierer.klassifizieren,
  ordnerPfad: themen.ordnerPfad,
};

let postfach;
let ordnerListe;
let verschoben;
let angelegt;
let antworten; // was das „Modell" für die Mails antwortet: uid → Ergebnis

let uidZaehler = 1000;
const neueUid = () => { uidZaehler += 1; return uidZaehler; };

beforeEach(() => {
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts; DELETE FROM konto_ordner;'
    + " DELETE FROM settings WHERE key LIKE 'nachsortierung%' OR key LIKE 'themen_%';");
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv, folder_spam)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1, 'Junk')").run();
  // Ohne mindestens eine Regel steigt der Lauf aus, bevor er das Postfach ansieht.
  db.prepare("INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, 'absender', 'nie@trifft.example', 'Einkauf')")
    .run(kontoId());
  settings.setze('nachsortierung_kiAktiv', '1');
  settings.setze('themen_konfidenz', '0.7');
  settings.setze('themen_ordner_anlegen', 'freigabe');
  // Je Ordner und Lauf geht nur ein kleines Bündel an die lokale KI (Standard: 2).
  // Die Tests schicken mehr Mails auf einmal.
  settings.setze('ollama_buendel', '10');

  postfach = { INBOX: [] };
  verschoben = [];
  angelegt = [];
  antworten = new Map();
  ordnerListe = [
    { pfad: 'INBOX', spezial: 'inbox', auswaehlbar: true },
    { pfad: 'Einkauf', spezial: null, auswaehlbar: true },
    { pfad: 'INBOX.Reisen', spezial: null, auswaehlbar: true },
    { pfad: 'Rechnungen', spezial: null, auswaehlbar: true },
    { pfad: 'Gelöschte Elemente', spezial: 'trash', auswaehlbar: true },
    { pfad: 'Entwürfe', spezial: 'drafts', auswaehlbar: true },
    { pfad: 'Junk', spezial: 'junk', auswaehlbar: true },
  ];

  imap.ordnerDetails = async () => ordnerListe;
  imap.briefkoepfe = async ({ ordner }) => postfach[ordner] || [];
  imap.mailLaden = async () => ({ text: 'Hallo, das ist eine Mail.' });
  imap.ordnerErstellen = async (_k, name) => { angelegt.push(name); return true; };
  imap.mailsVerschieben = async ({ mails, von, nach }) => {
    verschoben.push({ von, nach, uids: mails.map((m) => m.uid) });
    return { verschoben: mails, fehler: [] };
  };
  themen.ordnerPfad = async (_k, pfad) => pfad;
  // Das „Modell": Antwortet je Mail nach `antworten`, in der Reihenfolge der Anfrage.
  klassifizierer.klassifizieren = async (mails) => ({
    ergebnisse: mails.map((m) => antworten.get(m.uid) ?? null),
    anfragen: 1, klassifiziert: mails.length, abgebrochen: false, hinweis: '',
  });
});

afterEach(() => {
  Object.assign(imap, {
    ordnerDetails: echt.ordnerDetails, briefkoepfe: echt.briefkoepfe, mailLaden: echt.mailLaden,
    ordnerErstellen: echt.ordnerErstellen, mailsVerschieben: echt.mailsVerschieben,
  });
  klassifizierer.klassifizieren = echt.klassifizieren;
  themen.ordnerPfad = echt.ordnerPfad;
});

// Legt eine Mail in den Posteingang und lässt das Modell darauf antworten.
function mailMit(antwort, von = 'jemand@absender.example') {
  const uid = neueUid();
  postfach.INBOX.push({ uid, von, betreff: 'Betreff' });
  antworten.set(uid, antwort);
  return uid;
}

const ki = (ordner, konfidenz, extra = {}) => ({
  kategorie: 'sonstiges', spam_score: 0, kurzfassung: 'eine Kurzfassung', ordner, konfidenz, ...extra,
});

const lauf = () => n.lauf({ trockenlauf: true });

describe('Konfidenz: unter der Schwelle gilt der Vorschlag als „Kein Thema erkannt"', () => {
  test('über der Schwelle: der Vorschlag erscheint, mit dem Pfad des Servers', async () => {
    mailMit(ki('Einkauf', 0.9));
    const r = await lauf();
    assert.equal(r.vorschlaege, 1);
    assert.equal(r.verworfen, 0);
    const b = r.beispiele.find((x) => x.isKI);
    assert.equal(b.nachOrdner, 'Einkauf');
    assert.equal(b.neuerOrdner, false);
    assert.equal(b.konfidenz, 0.9);
  });

  test('genau auf der Schwelle gilt er, knapp darunter nicht', async () => {
    mailMit(ki('Einkauf', 0.7), 'a@x.example');
    mailMit(ki('Einkauf', 0.69), 'b@x.example');
    const r = await lauf();
    assert.equal(r.vorschlaege, 1);
    assert.equal(r.verworfen, 1);
    assert.deepEqual(r.verworfenGruende, { konfidenz: 1 });
  });

  test('der verworfene Vorschlag erreicht die Oberfläche gar nicht erst', async () => {
    mailMit(ki('Einkauf', 0.3));
    const r = await lauf();
    assert.deepEqual(r.beispiele.filter((b) => b.isKI), []);
    assert.equal(r.vorschlaege, 0);
  });

  test('die Schwelle ist die EINGESTELLTE', async () => {
    settings.setze('themen_konfidenz', '0.95');
    mailMit(ki('Einkauf', 0.9));
    assert.equal((await lauf()).vorschlaege, 0);

    settings.setze('themen_konfidenz', '0.5');
    mailMit(ki('Einkauf', 0.9));
    assert.equal((await lauf()).vorschlaege, 1);
  });

  test('fehlende oder unbrauchbare Konfidenz: verworfen', async () => {
    for (const k of [undefined, null, 'hoch', NaN, 85, -1, '']) mailMit(ki('Einkauf', k), `${neueUid()}@x.example`);
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
    assert.equal(r.verworfen, 7);
    assert.deepEqual(r.verworfenGruende, { ohne_konfidenz: 7 });
  });
});

describe('Name: nichts wird blind übernommen', () => {
  const ANGRIFFE = [
    '../../etc/passwd', '..', 'Themen/Games', 'INBOX.Games', 'a\\b', 'Ordner\r\nA001 DELETE INBOX',
    '{{ $json.von }}', '${process.env.X}', '=cmd|calc', "x'; DROP TABLE users;--",
    'a'.repeat(41), 'x', '', '   ', '∕∕', 'Rеchnungen', '<b>fett</b>',
  ];

  for (const name of ANGRIFFE) {
    test(`verworfen: ${JSON.stringify(name).slice(0, 50)}`, async () => {
      mailMit(ki(name, 0.99));
      const r = await lauf();
      assert.equal(r.vorschlaege, 0, 'darf nie als Vorschlag auftauchen');
      assert.ok(r.beispiele.every((b) => !b.isKI));
      assert.deepEqual(verschoben, [], 'und schon gar nichts bewegen');
      assert.deepEqual(angelegt, [], 'oder anlegen');
    });
  }

  test('gesperrte Ordner: Papierkorb, Entwürfe, Spam, Posteingang — unter dem Namen, den der SERVER ihnen gibt', async () => {
    for (const name of ['Gelöschte Elemente', 'Entwürfe', 'Junk', 'INBOX', 'Papierkorb', 'Posteingang', 'Spam']) {
      mailMit(ki(name, 0.99), `${neueUid()}@x.example`);
    }
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
    assert.deepEqual(r.verworfenGruende, { gesperrt: 7 });
  });

  test('ein Papierkorb mit ungewöhnlichem Namen ist trotzdem gesperrt, weil der Server ihn so kennzeichnet', async () => {
    ordnerListe.push({ pfad: 'Weggeworfenes', spezial: 'trash', auswaehlbar: true });
    mailMit(ki('Weggeworfenes', 0.99));
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
    assert.equal(r.verworfenGruende.gesperrt, 1);
  });

  test('Kategorieordner des Kontos sind gesperrt', async () => {
    for (const name of ['Rechnungen', 'Bestellungen', 'Newsletter', 'Quarantaene']) {
      mailMit(ki(name, 0.99), `${neueUid()}@x.example`);
    }
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
    assert.equal(r.verworfenGruende.gesperrt, 4);
  });

  test('ein Name in anderer Schreibweise trifft den vorhandenen Ordner — mit SEINEM Pfad', async () => {
    mailMit(ki('reisen', 0.9));
    const r = await lauf();
    assert.equal(r.beispiele.find((b) => b.isKI).nachOrdner, 'INBOX.Reisen', 'der Pfad des Servers, nicht der Text des Modells');
  });

  test('der Text des Modells erscheint nie als Pfad: Auch ein gültiger Name wird nur als Name geführt', async () => {
    mailMit(ki('  Kunden   2026 ', 0.9));
    const b = (await lauf()).beispiele.find((x) => x.isKI);
    assert.equal(b.nachOrdner, 'Kunden 2026');
    assert.equal(b.neuerOrdner, true);
  });

  test('ein neuer Ordner entsteht durch den Vorschlag NICHT — nur durch die Bestätigung', async () => {
    mailMit(ki('Kunden 2026', 0.9));
    await n.lauf({ trockenlauf: false });
    assert.deepEqual(angelegt, [], 'der Lauf zeigt nur an');
    assert.deepEqual(verschoben, [], 'KI-Vorschläge werden nie verschoben');
  });

  test('sind neue Ordner abgeschaltet, erscheint kein Vorschlag für einen neuen Namen', async () => {
    settings.setze('themen_ordner_anlegen', 'aus');
    mailMit(ki('Kunden 2026', 0.9), 'a@x.example');
    mailMit(ki('Einkauf', 0.9), 'b@x.example');
    const r = await lauf();
    assert.equal(r.vorschlaege, 1, 'nur der vorhandene Ordner');
    assert.deepEqual(r.verworfenGruende, { neue_ordner_aus: 1 });
  });

  test('der Ordner, in dem die Mail schon liegt, ist kein Vorschlag', async () => {
    postfach.Einkauf = [{ uid: neueUid(), von: 'x@y.example', betreff: 'b' }];
    antworten.set(postfach.Einkauf[0].uid, ki('Einkauf', 0.99));
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
  });
});

describe('Regeln und Stichworte sind keine KI-Vorschläge', () => {
  test('ein Ergebnis aus eigener Regel kommt unverändert durch — der Ordner stammt vom Nutzer', async () => {
    // Auch mit Trennzeichen: Der Pfad steht so in der Regel des Nutzers.
    mailMit({ ...ki('Themen/Games', 1.0), regel: true, kurzfassung: 'Eigene Regel [absender]: x' });
    const r = await lauf();
    const b = r.beispiele.find((x) => x.isKI);
    assert.equal(b.nachOrdner, 'Themen/Games');
    assert.match(b.regel, /Regel\/Stichwort mit Mailtext/);
    assert.equal(r.verworfen, 0);
  });

  test('ohne Ordner im Ergebnis passiert nichts', async () => {
    mailMit(ki('', 0.9));
    mailMit(ki(null, 0.9), 'b@x.example');
    mailMit(null, 'c@x.example');
    const r = await lauf();
    assert.equal(r.vorschlaege, 0);
    assert.equal(r.verworfen, 0, 'ein leeres Feld ist „kein Thema", nicht „abgelehnt"');
  });
});

describe('Der Lauf berichtet, was er verworfen hat', () => {
  test('die Zahlen stehen im Ergebnis und im gespeicherten letzten Lauf', async () => {
    mailMit(ki('Einkauf', 0.2), 'a@x.example');
    mailMit(ki('../x', 0.99), 'b@x.example');
    mailMit(ki('Papierkorb', 0.99), 'c@x.example');
    mailMit(ki('Einkauf', 0.9), 'd@x.example');
    const r = await lauf();
    assert.equal(r.vorschlaege, 1);
    assert.equal(r.verworfen, 3);
    assert.deepEqual(r.verworfenGruende, { konfidenz: 1, pfadtrenner: 1, gesperrt: 1 });
    assert.equal(n.letzterLauf().verworfen, 3);
  });

  test('das Protokoll nennt die Gründe — ein Modell, das plötzlich nur Unbrauchbares liefert, soll auffallen', async () => {
    mailMit(ki('../x', 0.99));
    await lauf();
    const z = db.prepare("SELECT nachricht FROM panel_logs WHERE quelle = 'nachsortierung' ORDER BY id DESC").get();
    assert.match(z.nachricht, /1 KI-Vorschlag\/Vorschläge verworfen \(Kein Thema erkannt: pfadtrenner 1\)/);
  });

  test('ist die KI aus, wird das Modell gar nicht erst gefragt', async () => {
    settings.setze('nachsortierung_kiAktiv', '0');
    let gefragt = 0;
    klassifizierer.klassifizieren = async () => { gefragt += 1; return { ergebnisse: [] }; };
    mailMit(ki('Einkauf', 0.9));
    await lauf();
    assert.equal(gefragt, 0);
  });
});

// ─── Die Zielprüfung der Route ───────────────────────────────────────────────

describe('zielPruefen: das Zielfeld ist Browser-Eingabe', () => {
  const konto = { folder_spam: 'Junk' };
  const liste = () => [...ordnerListe, { pfad: 'Archiv/2024', spezial: null, auswaehlbar: true }];

  test('ein vorhandener Ordner gilt mit seinem Pfad — auch mit Trennzeichen', () => {
    assert.deepEqual(n.zielPruefen(konto, liste(), 'Einkauf'), { ok: true, pfad: 'Einkauf', neu: false });
    assert.deepEqual(n.zielPruefen(konto, liste(), 'Archiv/2024'), { ok: true, pfad: 'Archiv/2024', neu: false });
    assert.equal(n.zielPruefen(konto, liste(), 'reisen').pfad, 'INBOX.Reisen');
  });

  test('ein NEUER Name muss die strenge Prüfung bestehen', () => {
    assert.deepEqual(n.zielPruefen(konto, liste(), 'Kunden 2026'), { ok: true, pfad: 'Kunden 2026', neu: true });
    for (const roh of ['Kunden/2026', '../x', 'a.b', 'a&b', 'x', 'Ordner\nA001', '{{x}}']) {
      const r = n.zielPruefen(konto, liste(), roh);
      assert.equal(r.ok, false, roh);
    }
  });

  test('ein Tippfehler in einem verschachtelten Namen legt keinen Unterordner an', () => {
    // „Archiv/2024" gibt es; „Archiv/2025" nicht — und wäre neu mit Trenner.
    const r = n.zielPruefen(konto, liste(), 'Archiv/2025');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'pfadtrenner');
  });

  test('gesperrte Ordner sind auch als vorhandene Ordner kein Ziel', () => {
    for (const roh of ['Gelöschte Elemente', 'Entwürfe', 'Junk', 'INBOX']) {
      const r = n.zielPruefen(konto, liste(), roh);
      assert.equal(r.ok, false, roh);
      assert.equal(r.code, 'gesperrt', roh);
    }
  });

  test('ein vorhandener Kategorieordner ist ein gewöhnliches Ziel — nur ein NEUER mit diesem Namen nicht', () => {
    assert.equal(n.zielPruefen(konto, liste(), 'Rechnungen').ok, true, 'es gibt ihn');
    const ohne = ordnerListe.filter((o) => o.pfad !== 'Rechnungen');
    assert.equal(n.zielPruefen({ ...konto, folder_invoices: 'Rechnungen' }, ohne, 'Rechnungen').ok, false);
  });

  test('leer und Nicht-Text', () => {
    for (const roh of ['', '   ', null, undefined, 5, {}, ['Einkauf']]) {
      assert.equal(n.zielPruefen(konto, liste(), roh).ok, false);
    }
  });

  test('nicht auswählbare Zwischenknoten sind kein Ziel — und ihr Name auch nicht als neuer Ordner', () => {
    const l = [...liste(), { pfad: 'Gruppe', spezial: null, auswaehlbar: false }];
    const r = n.zielPruefen(konto, l, 'Gruppe');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'gesperrt', 'ein zweiter Ordner gleichen Namens wäre nur verwirrend');
  });
});

describe('gesperrteOrdner', () => {
  test('Rollen, Spam-Ordner, Posteingang und Zwischenknoten — in beiden Schreibweisen', () => {
    const g = n.gesperrteOrdner({ folder_spam: 'Verdacht' }, [
      { pfad: 'INBOX', spezial: 'inbox', auswaehlbar: true },
      { pfad: 'INBOX.Gelöscht', spezial: 'trash', auswaehlbar: true },
      { pfad: 'Archiv', spezial: 'archive', auswaehlbar: true },
      { pfad: 'Gruppe', spezial: null, auswaehlbar: false },
      { pfad: 'Normal', spezial: null, auswaehlbar: true },
    ]);
    assert.ok(g.includes('Verdacht'));
    assert.ok(g.includes('INBOX') && g.includes('INBOX.Gelöscht') && g.includes('Gelöscht'));
    assert.ok(g.includes('Gruppe'));
    assert.ok(!g.includes('Archiv'), 'das Archiv ist ausdrücklich erlaubt');
    assert.ok(!g.includes('Normal'));
  });
});

// ─── Die Route: Bestätigen/Korrigieren ───────────────────────────────────────

describe('POST /nachsortierung/verschieben prüft Quelle und Ziel', () => {
  const ADMIN = { id: 1, username: 'test-admin', rolle_id: 1, admin: true, claims: { admin: true, rolle_id: 1 } };

  async function anfrage(rumpf) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = ADMIN; next(); });
    app.use('/api/sortierung', require('../src/routes/sortierung'));
    const server = await new Promise((f) => { const s = app.listen(0, () => f(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/sortierung/nachsortierung/verschieben`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rumpf),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    } finally {
      await new Promise((f) => server.close(f));
    }
  }

  const standard = (extra = {}) => ({ konto_id: kontoId(), uid: 7, von: 'INBOX', nach: 'Einkauf', ...extra });

  test('ein vorhandener Ordner: verschoben, mit dem Pfad des Servers', async () => {
    const r = await anfrage(standard({ nach: 'reisen' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.ordner, 'INBOX.Reisen');
    assert.equal(r.json.neu, false);
    assert.deepEqual(verschoben, [{ von: 'INBOX', nach: 'INBOX.Reisen', uids: [7] }]);
    assert.deepEqual(angelegt, [], 'es gibt ihn ja schon');
  });

  test('ein neuer, gültiger Name: wird angelegt und dann verschoben', async () => {
    const r = await anfrage(standard({ nach: 'Kunden 2026' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.neu, true);
    assert.deepEqual(angelegt, ['Kunden 2026']);
    assert.deepEqual(verschoben, [{ von: 'INBOX', nach: 'Kunden 2026', uids: [7] }]);
  });

  for (const nach of ['../../etc', 'Kunden/2026', 'a.b', 'Ordner\r\nA001 DELETE INBOX', '{{ $json }}', "x'; DROP--"]) {
    test(`ein Ziel wie ${JSON.stringify(nach).slice(0, 40)} wird abgewiesen — nichts angelegt, nichts bewegt`, async () => {
      const r = await anfrage(standard({ nach }));
      assert.equal(r.status, 400);
      assert.match(r.json.error, /Ordnername nicht zulässig/);
      assert.deepEqual(angelegt, []);
      assert.deepEqual(verschoben, []);
    });
  }

  test('gesperrte Ziele: Papierkorb, Entwürfe, Spam, Posteingang', async () => {
    for (const nach of ['Gelöschte Elemente', 'Entwürfe', 'Junk', 'INBOX']) {
      const r = await anfrage(standard({ von: 'Einkauf', nach }));
      assert.equal(r.status, 400, nach);
    }
    assert.deepEqual(verschoben, []);
  });

  test('gesperrte QUELLEN: aus dem Papierkorb lässt sich nichts zurückholen', async () => {
    for (const von of ['Gelöschte Elemente', 'Entwürfe', 'Junk', 'Gibt es nicht', '../x']) {
      const r = await anfrage(standard({ von }));
      assert.equal(r.status, 400, von);
    }
    assert.deepEqual(verschoben, []);
  });

  test('die Quelle gilt mit dem Pfad des Servers (Groß/Klein egal)', async () => {
    const r = await anfrage(standard({ von: 'einkauf', nach: 'INBOX.Reisen' }));
    assert.equal(r.status, 200);
    assert.equal(verschoben[0].von, 'Einkauf');
  });

  test('ist das Postfach nicht erreichbar, wird nichts auf Verdacht getan', async () => {
    imap.ordnerDetails = async () => { throw new Error('ECONNREFUSED'); };
    const r = await anfrage(standard());
    assert.equal(r.status, 502);
    assert.match(r.json.error, /nicht erreichbar/);
    assert.deepEqual(verschoben, []);
  });

  test('lässt sich der neue Ordner nicht anlegen, wird nichts verschoben', async () => {
    imap.ordnerErstellen = async () => { throw new Error('CREATE abgelehnt'); };
    const r = await anfrage(standard({ nach: 'Kunden 2026' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /ließ sich nicht anlegen/);
    assert.deepEqual(verschoben, []);
  });

  test('Absender und Betreff aus dem Browser landen begrenzt im Protokoll', async () => {
    const lang = 'x'.repeat(2000);
    const r = await anfrage(standard({ isKI: true, absender: `${lang}@y.example`, betreff: lang }));
    assert.equal(r.status, 200);
    const z = db.prepare("SELECT von, betreff FROM quarantine_log WHERE grund LIKE 'Nachsortierung: KI-Vorschlag%' ORDER BY id DESC").get();
    assert.ok(z.von.length <= 320);
    assert.ok(z.betreff.length <= 300);
  });

  test('Konto, UID und Pflichtfelder werden weiterhin geprüft', async () => {
    assert.equal((await anfrage(standard({ konto_id: 99999 }))).status, 400);
    for (const uid of [0, -1, 'abc', null, 1.5]) assert.equal((await anfrage(standard({ uid }))).status, 400, String(uid));
    for (const nach of ['', '  ', null, 5, {}]) assert.equal((await anfrage(standard({ nach }))).status, 400, JSON.stringify(nach));
    assert.equal((await anfrage(standard({ von: '' }))).status, 400);
    assert.deepEqual(verschoben, []);
  });
});
