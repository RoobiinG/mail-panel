// Warum der Bestandslauf grün lief und trotzdem nichts sortierte.
//
// Befund vom 12. September 2026 (Build 186): Ein Lauf dauerte 172 Sekunden,
// holte zwölf Mails und ordnete null ein. Im Diagnose-Bericht stand
// `bestand: { verarbeitet: 2, gesamt: 12, unklar: 0 }` — und dieselben Zahlen
// beim Lauf davor und davor.
//
// Vier Stellen arbeiteten gegeneinander. Diese Datei hält jede einzeln fest,
// denn keine davon war im Betrieb zu sehen: Der Lauf meldete jedes Mal Erfolg.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const budget = require('../src/services/budget');
const bestand = require('../src/services/bestand');
const kiText = require('../src/services/kiText');
const klassifizierer = require('../src/services/klassifizierer');
const { verschluesseln } = require('../src/services/crypto');

const inbox = (konto, von, betreff, uid) => db.prepare(
  'INSERT INTO sort_inbox (konto, von, betreff, uid, status) VALUES (?, ?, ?, ?, ?)',
).run(konto, von, betreff, uid == null ? null : String(uid), 'offen');

const log = (konto, von, betreff, uid) => db.prepare(
  'INSERT INTO quarantine_log (konto, von, betreff, uid) VALUES (?, ?, ?, ?)',
).run(konto, von, betreff, uid == null ? null : String(uid));

beforeEach(() => {
  db.exec('DELETE FROM quarantine_log; DELETE FROM sort_inbox; DELETE FROM sort_rules;'
    + ' DELETE FROM accounts; DELETE FROM bestand_erledigt;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'gemini_%' OR key LIKE 'ki_%'"
    + " OR key LIKE 'ollama_%' OR key LIKE 'bestand_%'").run();
  settings.setze('gemini_buendel', '1');
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Ein wiederholter Betreff ist keine schon gesehene Mail', () => {
  // Der Kern des Stillstands. „Login von einem neuen Endgerät" kommt hundertmal;
  // liegt eine davon in der Sortier-Inbox, galten vorher alle weiteren als
  // erledigt — und wurden verworfen, ohne dass irgendwo ein Vermerk entstand.
  // Beim nächsten Lauf bot das Panel dieselbe Mail wieder an, weil sie nach UID
  // ja offen war. Eine Schleife, die bei jedem Durchgang einen Platz im
  // Auswahlfenster kostete.
  test('gleicher Betreff, andere UID: die Mail ist neu', () => {
    inbox('K', 'no-reply@schul.cloud', 'Login von einem neuen Endgerät', 100);
    assert.equal(
      budget.schonGesehen('K', 'no-reply@schul.cloud', 'Login von einem neuen Endgerät', 250),
      false,
      'sonst kommt keine zweite Mail dieses Absenders je durch',
    );
  });

  test('dieselbe UID ist dieselbe Mail', () => {
    inbox('K', 'no-reply@schul.cloud', 'Login von einem neuen Endgerät', 100);
    assert.equal(
      budget.schonGesehen('K', 'no-reply@schul.cloud', 'Login von einem neuen Endgerät', 100),
      true,
    );
  });

  test('auch das Quarantäne-Log wird nach UID gefragt', () => {
    log('K', 'a@x.de', 'Rechnung', 7);
    assert.equal(budget.schonGesehen('K', 'a@x.de', 'Rechnung', 7), true);
    assert.equal(budget.schonGesehen('K', 'a@x.de', 'Rechnung', 8), false);
  });

  test('ein anderes Konto mit derselben UID blockiert nicht', () => {
    inbox('Anderes', 'a@x.de', 'Rechnung', 5);
    assert.equal(budget.schonGesehen('K', 'a@x.de', 'Rechnung', 5), false);
  });

  // Ohne UID bleibt es beim alten Vergleich — es gibt Aufrufer, die keine haben,
  // und für die ist eine grobe Prüfung besser als gar keine.
  test('ohne UID zählt weiterhin der Betreff', () => {
    inbox('K', 'a@x.de', 'Rechnung', 100);
    assert.equal(budget.schonGesehen('K', 'a@x.de', 'Rechnung'), true);
  });

  test('entscheiden() reicht die UID durch', () => {
    settings.setze('gemini_tagesbudget', '100');
    inbox('K', 'a@x.de', 'Newsletter', 1);
    const e = budget.entscheiden([
      { konto: 'K', von: 'a@x.de', betreff: 'Newsletter', uid: 1 },   // dieselbe
      { konto: 'K', von: 'a@x.de', betreff: 'Newsletter', uid: 2 },   // die nächste Ausgabe
    ]);
    assert.deepEqual(e.erlaubt, [1], 'nur die schon einsortierte fällt weg');
    assert.equal(e.uebersprungen.gesehen, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Vermerke landen wirklich in der Datenbank', () => {
  // `erledigtMerken` bekam irgendwann einen Ordner-Parameter dazu. Die drei
  // Aufrufe in routes/internal.js wurden nicht nachgezogen und übergaben weiter
  // (kontoId, uid, grund) — 'ruhe' landete als UID, zahlOderNull() gab null,
  // die Funktion stieg mit `return false` aus. Es wurde nie etwas vermerkt.
  //
  // Aufgefallen ist es nicht, weil die Tests die richtige Signatur benutzten.
  // Diese beiden Fälle halten deshalb das Ergebnis fest, nicht den Aufruf.
  const kontoAnlegen = () => db.prepare(
    "INSERT INTO accounts (name, host, port, username, password_enc, aktiv) VALUES ('K','h',993,'u',?,1)",
  ).run(verschluesseln('x')).lastInsertRowid;

  test('ein Vermerk mit Ordner wird gespeichert', () => {
    const id = kontoAnlegen();
    assert.equal(bestand.erledigtMerken(id, 'INBOX', 42, 'ruhe'), true);
    assert.ok(bestand.erledigteUids(id, 'INBOX').has(42));
  });

  test('eine UID, die keine Zahl ist, wird abgewiesen statt still verschluckt', () => {
    const id = kontoAnlegen();
    assert.equal(bestand.erledigtMerken(id, 'INBOX', 'ruhe', 'ruhe'), false,
      'genau so sah der Fehler aus: der Grund stand an der Stelle der UID');
  });

  test('der zuletzt ausgewählte Ordner ist abrufbar', () => {
    const id = kontoAnlegen();
    bestand.ordnerMerken(id, 'Archiv');
    assert.equal(bestand.letzterOrdner(id), 'Archiv');
  });

  test('ohne Vermerk gilt INBOX', () => {
    assert.equal(bestand.letzterOrdner(999), 'INBOX');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Beim Kürzen bleibt die Anweisung stehen', () => {
  // Vorher schnitt ein blankes slice(0, platz) hinten ab — dort stehen die
  // Mails. Das Modell bekam vollständige Anweisungen zu Mails, die nicht mehr
  // dastanden, und antwortete mit erfundenen Nummern (`nr: [12345, 67890]`).
  const anweisung = 'Du bist ein E-Mail-Klassifizierer. Antworte NUR mit JSON.\n\n--- E-Mails ---';
  const mail = (n) => `[${n}]\nVon: a${n}@x.de\nBetreff: Betreff ${n}\nText: ${'x'.repeat(200)}\n`;
  const prompt = `${anweisung}\n${mail(1)}\n${mail(2)}\n${mail(3)}`;

  test('passt alles, bleibt alles', () => {
    const s = kiText.promptKuerzen(prompt, prompt.length);
    assert.equal(s.text, prompt);
    assert.equal(s.weggefallen, 0);
  });

  test('was nicht passt, kostet ganze Mails — nie die Anweisung', () => {
    const s = kiText.promptKuerzen(prompt, anweisung.length + mail(1).length + 40);
    assert.ok(s.text.startsWith(anweisung), 'ohne die Anweisung ist die Frage sinnlos');
    assert.ok(s.text.includes('[1]'), 'die erste Mail muss drin sein');
    assert.ok(!s.text.includes('[3]'), 'die letzte muss weg sein');
    assert.equal(s.weggefallen + 1, s.gesamt);
  });

  test('keine halb abgeschnittene Mail', () => {
    const s = kiText.promptKuerzen(prompt, anweisung.length + mail(1).length + 40);
    // Jede Mail, deren Nummer dasteht, muss auch ihren Text vollständig haben.
    const bloecke = s.text.split('--- E-Mails ---')[1].split(/\n(?=\[\d+\]\n)/).filter((b) => b.trim());
    for (const b of bloecke) {
      assert.match(b, /Text: x{200}/, 'eine angeschnittene Mail beantwortet das Modell trotzdem');
    }
  });

  test('passt nicht einmal eine Mail, wird das gemeldet', () => {
    const s = kiText.promptKuerzen(prompt, anweisung.length + 10);
    assert.equal(s.kopfZuGross, true, 'sonst sucht man den Fehler beim Modell');
  });

  // Beleg-Leser und Aktions-Entwurf schicken Prompts ohne diesen Aufbau.
  test('ein Prompt ohne Mail-Marke wird wie bisher behandelt', () => {
    const s = kiText.promptKuerzen('a'.repeat(100), 40);
    assert.equal(s.text.length, 40);
    assert.equal(s.gesamt, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Das Schema begrenzt die Antwortlänge', () => {
  // Ohne maxItems erlaubt die Grammatik ein beliebig langes Array. llama3.2:1b
  // schrieb daraufhin die vollen 800 Token voll — 62 Sekunden für zwei Mails,
  // und am Ende kein gültiges JSON („abgeschnitten (length)").
  test('nicht mehr Einträge, als das Bündel Mails hat', () => {
    assert.equal(klassifizierer.antwortSchema(3).properties.mails.maxItems, 3);
  });

  test('auch bei einer einzelnen Mail', () => {
    assert.equal(klassifizierer.antwortSchema(1).properties.mails.maxItems, 1);
  });

  // Kein minItems: Fällt beim Kürzen eine Mail weg, stünde sonst eine Antwort
  // zu einer Mail in der Grammatik, die gar nicht im Prompt steht.
  test('aber keine Untergrenze, die zum Raten zwingt', () => {
    assert.equal(klassifizierer.antwortSchema(3).properties.mails.minItems, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Das Auswahlfenster hängt nicht mehr an der Bündelgröße', () => {
  // Vorher: max(4, floor(ollama_buendel * 6 / Konten)). Mit dem Standardwert 2
  // und drei Konten waren das vier Mails je Konto — zwölf je Lauf, alle vier
  // Stunden. Die Nachzügler aus dem letzten Lauf füllen so ein Fenster allein.
  const kontoAnlegen = (name) => db.prepare(
    'INSERT INTO accounts (name, host, port, username, password_enc, aktiv)'
    + " VALUES (?, 'h', 993, 'u', ?, 1)",
  ).run(name, verschluesseln('x')).lastInsertRowid;

  const fensterVon = async () => {
    const imap = require('../src/services/imap');
    imap.ordnerDetails = async () => [{ pfad: 'INBOX', auswaehlbar: true, spezial: 'inbox' }];
    imap.uidsAuflisten = async () => new Set([1, 2, 3]);
    return (await bestand.kandidaten()).fenster;
  };

  test('eine kleine Bündelgröße schrumpft das Fenster nicht mehr', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('ollama_buendel', '2');
    kontoAnlegen('A'); kontoAnlegen('B'); kontoAnlegen('C');
    const fenster = await fensterVon();
    assert.ok(fenster >= bestand.FENSTER_LOKAL,
      `${fenster} Mails je Konto — vorher waren es vier, und der Lauf kam nie vom Fleck`);
  });

  test('ein eigener Wert sticht den Standard', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('bestand_fenster', '25');
    kontoAnlegen('A');
    assert.equal(await fensterVon(), 25);
  });

  test('auch ein eigener Wert bleibt unter der Obergrenze', async () => {
    settings.setze('ki_anbieter', 'ollama');
    settings.setze('bestand_fenster', '9999');
    kontoAnlegen('A');
    assert.equal(await fensterVon(), bestand.FENSTER);
  });
});
