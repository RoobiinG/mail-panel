// Der Themen-Ordner ist jetzt ein Enum, kein freier String mehr.
//
// Vorher konnte das Modell im Feld "ordner" alles zurückgeben: den Namen exakt,
// die ganze Prompt-Zeile samt Beschreibung, einen Tippfehler, einen erfundenen
// Namen. Ein Reparaturapparat (themen.vorschlagSaeubern, themen.imKatalog mit
// Levenshtein und Synonymen) fing das größtenteils wieder auf — was er nicht
// schaffte, landete als „Ordnername abgelehnt" im Protokoll (18 Mails in sieben
// Tagen, Diagnosebericht vom 15.09.).
//
// Jetzt ist "ordner" bei aktiver Themen-Sortierung an genau die Namen
// gebunden, die auch im Prompt stehen — bei Ollama durch eingeschränkte
// Grammatik erzwungen, bei Gemini über responseSchema stark gebunden. Ein
// neuer Vorschlag hat ein eigenes Feld ("neuer_ordner") statt der
// Zeichenkette "NEU:<Name>" innerhalb des jetzt festgelegten Feldes.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const kiText = require('../src/services/kiText');
const k = require('../src/services/klassifizierer');

const kontoAnlegen = () => db.prepare(
  "INSERT INTO accounts (name, host, port, username, password_enc, aktiv, folder_newsletter)"
  + " VALUES ('K', 'h', 993, 'u', 'x', 1, 'Newsletter')",
).run().lastInsertRowid;

const ordner = (kontoId, name, beschreibung = null) => db.prepare(
  "INSERT INTO konto_ordner (konto_id, ordner, beschreibung, quelle) VALUES (?, ?, ?, 'manuell')",
).run(kontoId, name, beschreibung);

let konto;
beforeEach(() => {
  db.exec('DELETE FROM konto_ordner; DELETE FROM accounts; DELETE FROM quarantine_log;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'themen_%' OR key LIKE 'ki_%' OR key LIKE 'gemini_%'").run();
  konto = { id: kontoAnlegen(), name: 'K', folder_newsletter: 'Newsletter' };
});

describe('themenKontext() — eine Quelle für Text und Schema', () => {
  test('ohne aktive Themen-Sortierung gibt es keine Namen', () => {
    const ktx = k.themenKontext(konto);
    assert.equal(ktx.text, '');
    assert.equal(ktx.namen, null);
    assert.equal(ktx.neuErlaubt, false);
  });

  test('die Namen im Schema sind genau die im Prompt-Text', () => {
    settings.setze('themen_sortierung_aktiv', '1');
    ordner(konto.id, 'Games', 'Steam, Epic, Konsolen');
    ordner(konto.id, 'Reisen', 'Flüge, Hotels');
    const ktx = k.themenKontext(konto);
    assert.deepEqual(ktx.namen.sort(), ['Games', 'Reisen']);
    assert.match(ktx.text, /"Games": Steam, Epic, Konsolen/);
    assert.match(ktx.text, /"Reisen": Flüge, Hotels/);
  });

  test('Kategorie-Ordner fliegen aus dem Enum, auch wenn sie im Katalog stehen', () => {
    settings.setze('themen_sortierung_aktiv', '1');
    ordner(konto.id, 'Games');
    ordner(konto.id, 'Newsletter'); // == folder_newsletter des Kontos
    const ktx = k.themenKontext(konto);
    assert.deepEqual(ktx.namen, ['Games']);
  });

  test('neuErlaubt folgt themen_ordner_anlegen', () => {
    settings.setze('themen_sortierung_aktiv', '1');
    settings.setze('themen_ordner_anlegen', 'aus');
    assert.equal(k.themenKontext(konto).neuErlaubt, false);
    settings.setze('themen_ordner_anlegen', 'freigabe');
    assert.equal(k.themenKontext(konto).neuErlaubt, true);
  });
});

describe('antwortSchema() erzwingt die Ordner-Auswahl', () => {
  test('ohne Themen-Namen bleibt "ordner" ein freier String — wie vorher', () => {
    const s = k.antwortSchema(5, null, false);
    assert.deepEqual(s.properties.mails.items.properties.ordner, { type: 'string' });
    assert.equal('neuer_ordner' in s.properties.mails.items.properties, false);
  });

  test('mit Themen-Namen ist "ordner" ein Enum aus genau diesen plus leer', () => {
    const s = k.antwortSchema(5, ['Games', 'Reisen'], true);
    assert.deepEqual(
      s.properties.mails.items.properties.ordner.enum.sort(),
      ['', 'Games', 'Reisen'],
    );
  });

  test('"neuer_ordner" steht nur im Schema, wenn neue Ordner erlaubt sind', () => {
    const mit = k.antwortSchema(5, ['Games'], true);
    assert.ok('neuer_ordner' in mit.properties.mails.items.properties);
    const ohne = k.antwortSchema(5, ['Games'], false);
    assert.equal('neuer_ordner' in ohne.properties.mails.items.properties, false);
  });

  test('"neuer_ordner" ist nicht in required — ein Modell darf es weglassen', () => {
    const s = k.antwortSchema(5, ['Games'], true);
    assert.equal(s.properties.mails.items.required.includes('neuer_ordner'), false);
  });

  test('kategorie bleibt unverändert an KATEGORIEN gebunden', () => {
    const s = k.antwortSchema(5, ['Games'], true);
    assert.deepEqual(s.properties.mails.items.properties.kategorie.enum, k.KATEGORIEN);
  });
});

describe('promptBauen() und antwortSchema() sehen dieselben Namen', () => {
  test('jeder Name im Schema-Enum steht auch als Anführungszeichen-Zeile im Prompt', () => {
    settings.setze('themen_sortierung_aktiv', '1');
    ordner(konto.id, 'Games');
    ordner(konto.id, 'Reisen');
    const ktx = k.themenKontext(konto);
    const prompt = k.promptBauen(
      [{ vertreter: { von: 'a@b.de', betreff: 'B', text: '' }, mitglieder: [] }], konto, new Set(), ktx,
    );
    for (const name of ktx.namen) {
      assert.match(prompt, new RegExp(`"${name}"`), `${name} fehlt im Prompt-Text`);
    }
  });

  test('das Beispiel im Prompt zeigt "neuer_ordner" nur, wenn es das Feld gibt', () => {
    settings.setze('themen_sortierung_aktiv', '1');
    settings.setze('themen_ordner_anlegen', 'aus');
    const ohne = k.promptBauen([{ vertreter: { von: 'a', betreff: 'b', text: '' }, mitglieder: [] }], konto, new Set());
    assert.doesNotMatch(ohne, /"neuer_ordner"/);

    settings.setze('themen_ordner_anlegen', 'freigabe');
    const mit = k.promptBauen([{ vertreter: { von: 'a', betreff: 'b', text: '' }, mitglieder: [] }], konto, new Set());
    assert.match(mit, /"neuer_ordner"/);
  });
});

describe('antwortZuordnen() führt "ordner" und "neuer_ordner" zusammen', () => {
  const gruppen = (n) => Array.from({ length: n }, () => ({ mitglieder: [] }));

  test('ein gewählter vorhandener Ordner gewinnt', () => {
    const t = k.antwortZuordnen(
      { mails: [{ nr: 1, kategorie: 'sonstiges', konfidenz: 0.8, ordner: 'Games', neuer_ordner: 'Sollte egal sein' }] },
      gruppen(1),
    );
    assert.equal(t.get(1).ordner, 'Games');
  });

  test('ohne vorhandenen Ordner zählt der neue Vorschlag', () => {
    const t = k.antwortZuordnen(
      { mails: [{ nr: 1, kategorie: 'sonstiges', konfidenz: 0.8, ordner: '', neuer_ordner: 'Hobbys' }] },
      gruppen(1),
    );
    assert.equal(t.get(1).ordner, 'Hobbys');
  });

  test('ohne beides bleibt es null', () => {
    const t = k.antwortZuordnen(
      { mails: [{ nr: 1, kategorie: 'sonstiges', konfidenz: 0.8, ordner: '', neuer_ordner: '' }] },
      gruppen(1),
    );
    assert.equal(t.get(1).ordner, null);
  });

  test('ein Modell ohne das Feld "neuer_ordner" (aeltere Antwortform) stürzt nicht ab', () => {
    const t = k.antwortZuordnen(
      { mails: [{ nr: 1, kategorie: 'sonstiges', konfidenz: 0.8, ordner: null }] },
      gruppen(1),
    );
    assert.equal(t.get(1).ordner, null);
  });
});

