// Die Regelliste nach Absender-Domain gebündelt.
//
// 159 Zeilen hintereinander beantworten die Frage nicht, die man vor ihnen hat:
// Was ist für DIESEN Dienst hinterlegt? Erst nebeneinander sieht man, dass ein
// Anbieter mit vier Adressen in drei verschiedene Ordner sortiert wird — und
// das ist meistens keine Absicht, sondern etwas, das sich über Wochen
// angesammelt hat. Deshalb trägt jede Gruppe ihre verschiedenen Zielordner im
// Kopf: Das ist der Befund, wegen dem man hier hinsieht.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const express = require('express');
const imap = require('../src/services/imap');
const routen = require('../src/routes/sortierung');

// Kein echter IMAP-Server im Test. Das Anlegen des Zielordners ist beim Anlegen
// einer Regel ohnehin nur ein Versuch („Best Effort") — hier soll es nur nicht
// in ein Verbindungs-Zeitlimit laufen.
imap.ordnerErstellen = async () => false;

const request = async (methode, pfad, rumpf) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/sortierung', routen);

  const server = await new Promise((fertig) => {
    const s = app.listen(0, () => fertig(s));
  });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${pfad}`, {
      method: methode,
      ...(rumpf ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rumpf) } : {}),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally {
    await new Promise((fertig) => server.close(fertig));
  }
};

const kontoId = () => db.prepare("SELECT id FROM accounts WHERE name = 'K'").get().id;

const regel = (typ, muster, zielordner, opt = {}) => db.prepare(
  'INSERT INTO sort_rules (konto_id, typ, muster, zielordner, betreff_muster, inhalt_muster, aktion, treffer)'
  + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
).run(kontoId(), typ, muster, zielordner, opt.betreff || null, opt.inhalt || null,
  opt.aktion || 'verschieben', opt.treffer || 0).lastInsertRowid;

beforeEach(() => {
  // quarantine_log gehört seit den "andereZiele"-Tests weiter unten mit dazu
  // — sonst bliebe ein Protokolleintrag über das eigene Beispiel hinaus
  // stehen und würde einen späteren Test verfälschen.
  db.exec('DELETE FROM sort_rules; DELETE FROM accounts; DELETE FROM quarantine_log;');
  db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
    + " VALUES ('K', 'h', 993, 'u', 'x', 1)").run();
});

describe('nachDomain() — die Bündelung selbst', () => {
  const gruppen = () => routen.nachDomain(db.prepare('SELECT * FROM sort_rules').all());

  test('Absender derselben Domain landen in einer Gruppe', () => {
    regel('absender', 'punkte@treue.example', 'Einkauf');
    regel('absender', 'info@treue.example', 'Einkauf');
    regel('absender', 'a@woanders.example', 'Newsletter');

    const g = gruppen();
    const treue = g.find((x) => x.domain === 'treue.example');
    assert.equal(treue.anzahl, 2);
    assert.equal(g.length, 2);
  });

  // Der eigentliche Zweck: Läuft eine Domain auseinander, steht das im Kopf.
  test('die verschiedenen Zielordner einer Domain stehen in der Gruppe', () => {
    regel('absender', 'punkte@treue.example', 'Einkauf');
    regel('absender', 'shop@treue.example', 'Bestellungen');
    regel('absender', 'news@treue.example', 'Newsletter');

    const treue = gruppen().find((x) => x.domain === 'treue.example');
    assert.equal(treue.ziele.length, 3);
    assert.deepEqual([...treue.ziele].sort(), ['Bestellungen', 'Einkauf', 'Newsletter']);
  });

  test('jedes Ziel nur einmal, auch bei vielen Regeln', () => {
    for (let i = 0; i < 4; i++) regel('absender', `nr${i}@treue.example`, 'Einkauf');
    assert.deepEqual(gruppen()[0].ziele, ['Einkauf']);
  });

  test('eine Ruhe-Regel wird als solche ausgewiesen, nicht als leeres Ziel', () => {
    regel('absender', 'a@treue.example', '', { aktion: 'behalten' });
    assert.deepEqual(gruppen()[0].ziele, ['(in Ruhe lassen)']);
  });

  test('eine Domain-Regel gehört zur selben Gruppe wie ihre Absender', () => {
    regel('domain', 'treue.example', 'Einkauf');
    regel('absender', 'shop@treue.example', 'Bestellungen');
    const g = gruppen();
    assert.equal(g.length, 1);
    assert.equal(g[0].domain, 'treue.example');
    assert.equal(g[0].anzahl, 2);
  });

  test('führendes @ an einer Domain-Regel stört nicht', () => {
    regel('domain', '@treue.example', 'Einkauf');
    regel('absender', 'shop@treue.example', 'Einkauf');
    assert.equal(gruppen().length, 1, 'sonst stünde dieselbe Domain zweimal da');
  });

  test('was keine Domain hat, kommt in ein eigenes Fach — und zwar zuletzt', () => {
    regel('betreff', 'rechnung', 'Rechnungen', { treffer: 999 });
    regel('absender', 'a@treue.example', 'Einkauf');

    const g = gruppen();
    assert.equal(g[g.length - 1].domain, routen.OHNE_DOMAIN);
    assert.equal(g[g.length - 1].anzahl, 1, 'trotz der höchsten Trefferzahl steht es hinten');
  });

  test('Treffer werden je Gruppe summiert und bestimmen die Reihenfolge', () => {
    regel('absender', 'a@selten.example', 'X', { treffer: 1 });
    regel('absender', 'b@oft.example', 'X', { treffer: 40 });
    regel('absender', 'c@oft.example', 'X', { treffer: 2 });

    const g = gruppen();
    assert.equal(g[0].domain, 'oft.example');
    assert.equal(g[0].treffer, 42);
  });

  // Innerhalb der Gruppe dieselbe Reihenfolge, in der die Regeln auch gelten —
  // sonst liest man oben eine Regel, die unten längst überstimmt wird.
  test('innerhalb der Gruppe stehen die engeren Regeln oben', () => {
    regel('domain', 'treue.example', 'Werbung');
    regel('absender', 'shop@treue.example', 'Einkauf');
    regel('absender', 'shop@treue.example', 'Bestellungen', { betreff: 'bestellung' });

    const reihenfolge = gruppen()[0].regeln.map((r) => r.zielordner);
    assert.deepEqual(reihenfolge, ['Bestellungen', 'Einkauf', 'Werbung']);
  });
});

describe('Die Route liefert Gruppen statt einer flachen Liste', () => {
  test('gruppiert=1 antwortet mit gruppen, sonst mit regeln', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');

    const flach = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}`);
    assert.ok(Array.isArray(flach.json.regeln));
    assert.equal(flach.json.gruppen, undefined);

    const gruppiert = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&gruppiert=1`);
    assert.ok(Array.isArray(gruppiert.json.gruppen));
    assert.equal(gruppiert.json.gruppen[0].domain, 'treue.example');
  });

  // Gefiltert wird in der Datenbank, gebündelt danach. Wer „treue" sucht, sieht
  // genau diese Gruppe — und nicht die halbe Liste mit einem Treffer darin.
  test('die Suche filtert vor dem Bündeln', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@woanders.example', 'Newsletter');

    const r = await request('GET', `/api/sortierung/regeln?konto_id=${kontoId()}&gruppiert=1&suche=treue`);
    assert.equal(r.json.gruppen.length, 1);
    assert.equal(r.json.gruppen[0].domain, 'treue.example');
    assert.equal(r.json.gesamt, 2, 'die Gesamtzahl bleibt sichtbar');
    assert.equal(r.json.gefiltert, 1);
  });
});

// POST /regeln/zusammenfassen — bis hierhin ohne einen einzigen Test, obwohl
// die Route Daten löscht (die Einzelregeln) und neue anlegt. Seit die Route
// { regel_ids, zielordner } statt { domain, zielordner } nimmt, ist das Ziel
// ein echter, vom Vorschlag abweichender Wert — kein Suchschlüssel mehr, der
// zur Vorschau passen MUSSTE.
describe('Zusammenfassen — regel_ids statt domain, Ziel ist frei wählbar', () => {
  const ids = () => db.prepare("SELECT id FROM sort_rules WHERE typ = 'absender' ORDER BY id").all()
    .map((r) => r.id);

  test('ersetzt die Einzelregeln durch eine Domain-Regel mit dem vorgeschlagenen Ziel', async () => {
    regel('absender', 'a@treue.example', 'Einkauf', { treffer: 3 });
    regel('absender', 'b@treue.example', 'Einkauf', { treffer: 5 });

    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(), zielordner: 'Einkauf',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ersetzt, 2);
    assert.equal(r.json.zielordner, 'Einkauf');

    const uebrig = db.prepare("SELECT * FROM sort_rules WHERE konto_id = ?").all(kontoId());
    assert.equal(uebrig.length, 1, 'die beiden Einzelregeln sind weg, eine Domain-Regel steht da');
    assert.equal(uebrig[0].typ, 'domain');
    assert.equal(uebrig[0].muster, 'treue.example');
    assert.equal(uebrig[0].zielordner, 'Einkauf');
    assert.equal(uebrig[0].treffer, 8, 'die Trefferzahlen wandern mit');
  });

  test('das Ziel lässt sich beim Zusammenfassen ändern — der eigentliche Grund für den Umbau', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');

    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(), zielordner: 'Games',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const uebrig = db.prepare("SELECT * FROM sort_rules WHERE konto_id = ?").get(kontoId());
    assert.equal(uebrig.zielordner, 'Games', 'nicht das alte Ziel der Einzelregeln, sondern das gewählte');
  });

  test('weniger als zwei regel_ids wird abgewiesen', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(), zielordner: 'Einkauf',
    });
    assert.equal(r.status, 400);
  });

  test('ohne zielordner wird abgewiesen', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(),
    });
    assert.equal(r.status, 400);
  });

  test('eine nicht mehr existierende Regel-ID wird abgewiesen — die Ansicht war veraltet', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    const echt = ids();
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: [...echt, echt[0] + 999], zielordner: 'Einkauf',
    });
    assert.equal(r.status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 1, 'nichts wurde angefasst');
  });

  test('gemischte Domains werden abgewiesen', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@anders.example', 'Einkauf');
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(), zielordner: 'Einkauf',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /verschiedene Domains/);
  });

  test('eine Regel mit Betreff-Bedingung zählt nicht mit, selbst wenn ihre ID mitgeschickt wird', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf', { betreff: 'bestellung' });
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: ids(), zielordner: 'Einkauf',
    });
    // Nur eine der beiden ids trifft die WHERE-Bedingung (ohne betreff_muster)
    // — die Route sieht das als "eine Regel existiert nicht" und lehnt ab,
    // statt die Betreff-Bedingung stillschweigend wegzuwerfen.
    assert.equal(r.status, 404);
  });

  test('gibt es die Domain-Regel schon, wird nicht dupliziert', async () => {
    regel('domain', 'treue.example', 'Altes-Ziel');
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');
    const nurAbsender = db.prepare("SELECT id FROM sort_rules WHERE typ = 'absender'").all().map((r) => r.id);
    const r = await request('POST', '/api/sortierung/regeln/zusammenfassen', {
      konto_id: kontoId(), regel_ids: nurAbsender, zielordner: 'Einkauf',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bereits eine Domain-Regel/);
  });
});

describe('Zusammenfassen lässt Betreff-Regeln in Ruhe', () => {
  // Sie zu einer Domain-Regel zu verschmelzen hieße, genau die Bedingung
  // wegzuwerfen, wegen der es sie gibt: Aus „nur Bestellbestätigungen" würde
  // stillschweigend „alles von dieser Firma".
  test('zwei Absender-Regeln mit Bedingung sind nicht zusammenfassbar', async () => {
    regel('absender', 'a@treue.example', 'Einkauf', { betreff: 'bestellung' });
    regel('absender', 'b@treue.example', 'Einkauf', { betreff: 'bestellung' });

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.deepEqual(r.json, []);
  });

  test('ohne Bedingung schlägt es weiterhin zu', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].domain, 'treue.example');
  });

  // Dieselbe Überlegung gilt für die Inhalts-Bedingung — genauer sogar: Sie
  // existiert extra für Anbieter, die dieselbe Adresse für alles benutzen
  // (Buchung, Rechnung, Werbung von derselben "donotreply@"). Sie zuerst
  // wieder zu einer Domain-Regel zu verschmelzen würde den Grund, warum es
  // sie gibt, rückgängig machen.
  test('zwei Absender-Regeln mit Inhalts-Bedingung sind nicht zusammenfassbar', async () => {
    regel('absender', 'a@easyjet.example', 'Reisen', { inhalt: 'buchungsnummer' });
    regel('absender', 'b@easyjet.example', 'Reisen', { inhalt: 'buchungsnummer' });

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.deepEqual(r.json, []);
  });
});

// Der eigentliche Grund für regel_ids statt domain (siehe Beschreibung oben
// bei der Route): Eine Domain-Regel ist die weiteste aller Regeln — sie trifft
// JEDE künftige Adresse. Ist dieselbe Domain im Protokoll schon auch woanders
// gelandet, ist eine Domain-Regel wahrscheinlich der falsche Schluss, und die
// Karte soll davor warnen, nicht daran vorbeigehen.
describe('Zusammenfassen warnt, wenn dieselbe Domain schon woanders landete', () => {
  const protokoll = (von, zielordner) => db.prepare(
    "INSERT INTO quarantine_log (konto, von, zielordner) VALUES ('K', ?, ?)",
  ).run(von, zielordner);

  test('andereZiele bleibt leer, wenn die Domain immer im selben Ordner landete', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');
    protokoll('a@treue.example', 'Einkauf');
    protokoll('c@treue.example', 'Einkauf');

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.deepEqual(r.json[0].andereZiele, []);
  });

  test('andereZiele nennt die abweichenden Ordner aus dem Protokoll', async () => {
    regel('absender', 'a@easyjet.example', 'Einkauf');
    regel('absender', 'b@easyjet.example', 'Einkauf');
    protokoll('donotreply@easyjet.example', 'Werbung');
    protokoll('donotreply@easyjet.example', 'Banking');
    protokoll('donotreply@easyjet.example', 'Einkauf'); // das vorgeschlagene Ziel selbst zählt nicht als Abweichung

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.deepEqual(r.json[0].andereZiele.sort(), ['Banking', 'Werbung']);
  });

  test('eine Adresse einer anderen Domain zählt nicht mit', async () => {
    regel('absender', 'a@treue.example', 'Einkauf');
    regel('absender', 'b@treue.example', 'Einkauf');
    protokoll('a@anders.example', 'Werbung');

    const r = await request('GET', `/api/sortierung/regeln/zusammenfassbar?konto_id=${kontoId()}`);
    assert.deepEqual(r.json[0].andereZiele, []);
  });
});

describe('Dieselbe Adresse mehrfach regeln', () => {
  test('geht — solange sich die Betreff-Bedingungen unterscheiden', async () => {
    const eins = await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Bestellungen', betreff_muster: 'bestellung', rueckwirkend: false,
    });
    assert.equal(eins.status, 200);

    const zwei = await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Rechnungen', betreff_muster: 'rechnung', rueckwirkend: false,
    });
    assert.equal(zwei.status, 200, 'genau das ist der Zweck der zweiten Bedingung');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sort_rules').get().n, 2);
  });

  test('dieselbe Bedingung zweimal wird abgewiesen', async () => {
    await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Bestellungen', betreff_muster: 'bestellung', rueckwirkend: false,
    });
    const doppelt = await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Woanders', betreff_muster: 'bestellung', rueckwirkend: false,
    });
    assert.equal(doppelt.status, 400);
    assert.match(doppelt.json.error, /bereits eine Regel/);
  });

  test('eine Regel ohne Bedingung neben einer mit Bedingung ist kein Doppel', async () => {
    await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Bestellungen', betreff_muster: 'bestellung', rueckwirkend: false,
    });
    const allgemein = await request('POST', '/api/sortierung/regeln', {
      konto_id: kontoId(), typ: 'absender', muster: 'info@treue.example',
      zielordner: 'Einkauf', rueckwirkend: false,
    });
    assert.equal(allgemein.status, 200);
  });

  test('die Bedingung lässt sich nachträglich setzen und wieder entfernen', async () => {
    const id = regel('absender', 'info@treue.example', 'Einkauf');

    await request('PUT', `/api/sortierung/regeln/${id}`, { betreff_muster: 'bestellung' });
    assert.equal(db.prepare('SELECT betreff_muster b FROM sort_rules WHERE id = ?').get(id).b, 'bestellung');

    await request('PUT', `/api/sortierung/regeln/${id}`, { betreff_muster: '' });
    assert.equal(db.prepare('SELECT betreff_muster b FROM sort_rules WHERE id = ?').get(id).b, null,
      'ein leeres Feld ist eine Ansage, kein „nicht mitgeschickt"');
  });
});
