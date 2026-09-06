// Die Dashboard-Übersicht rechnet aus, was man beim täglichen Blick sehen will.
// Hier wird geprüft, dass die Zahlen stimmen — falsche Zahlen auf einem
// Dashboard sind schlimmer als keine, weil man ihnen glaubt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

// IMAP ersetzen: kein echtes Postfach in der CI.
const imapPfad = require.resolve('../src/services/imap');
const imapStub = {
  STANDARD: {},
  antwort: new Map(),
  async uidsAuflisten({ ordner }) {
    void ordner;
    if (imapStub.wirft) throw new Error('Postfach nicht erreichbar');
    return imapStub.naechste ?? new Set();
  },
};
require.cache[imapPfad] = {
  id: imapPfad, filename: imapPfad, loaded: true, children: [], paths: [], exports: imapStub,
};

const db = require('../src/db');
const settings = require('../src/services/settings');
const { verschluesseln } = require('../src/services/crypto');
const uebersicht = require('../src/services/uebersicht');
const budget = require('../src/services/budget');

function konto(name) {
  db.prepare(`INSERT INTO accounts (name, host, port, username, password_enc, aktiv)
    VALUES (?, 'h', 993, 'u', ?, 1)`).run(name, verschluesseln('x'));
}
function log({ von = 'a@b.de', kat = 'clean', ziel = 'Games', korr = null, alter = 0 }) {
  const id = db.prepare(`INSERT INTO quarantine_log (konto, von, kategorie, zielordner, korrigiert_zu)
    VALUES ('K', ?, ?, ?, ?)`).run(von, kat, ziel, korr).lastInsertRowid;
  if (alter) db.prepare("UPDATE quarantine_log SET created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${alter} days`, id);
  return id;
}

beforeEach(() => {
  db.exec('DELETE FROM accounts; DELETE FROM quarantine_log; DELETE FROM sort_inbox; DELETE FROM sort_rules;');
  db.prepare("DELETE FROM settings WHERE key IN ('gemini_tagesbudget','bestand_letzter_lauf','bestand_letzter_lauf_anzahl','bestand_letzter_lauf_gesamt','bestand_intervall') OR key LIKE 'ki_%'").run();
  uebersicht.cacheVerwerfen();
  imapStub.wirft = false; imapStub.naechste = new Set();
});

describe('KI-Tagesbudget', () => {
  // Anfragen und Mails sind zweierlei: Googles Limit zaehlt Anfragen, eine davon
  // traegt seit der Buendelung bis zu zwanzig Mails.
  test('gezaehlt werden Anfragen, angezeigt auch die Mails', async () => {
    log({}); log({}); log({ alter: 2 }); // zwei Mails heute, eine vor zwei Tagen
    budget.ausgabeMerken(1);             // in einer einzigen Anfrage
    assert.equal(uebersicht.heuteVerbraucht(), 1);
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.budget.heute, 1, 'Anfragen');
    assert.equal(u.budget.mailsHeute, 2, 'Mails');
  });

  test('Budget mit Grenze rechnet Rest und Ausschöpfung', async () => {
    settings.setze('gemini_tagesbudget', '5');
    budget.ausgabeMerken(3);
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.budget.grenze, 5);
    assert.equal(u.budget.heute, 3);
    assert.equal(u.budget.rest, 2);
    assert.equal(u.budget.ausgeschoepft, false);
  });

  test('aufgebrauchtes Budget wird erkannt', async () => {
    settings.setze('gemini_tagesbudget', '2');
    budget.ausgabeMerken(3);
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.budget.ausgeschoepft, true);
    assert.equal(u.budget.rest, 0, 'nie negativ');
  });

  test('ausdrücklich auf 0 gesetzt heißt kein Deckel', async () => {
    settings.setze('gemini_tagesbudget', '0');
    log({});
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.budget.grenze, 0);
    assert.equal(u.budget.rest, null);
    assert.equal(u.budget.ausgeschoepft, false);
  });

  // Sonst steht im Dashboard weiter die Wunschzahl, waehrend das Panel laengst
  // nach der von Google gesetzten Grenze arbeitet — zwei Wahrheiten, von denen
  // die sichtbare die falsche waere.
  test('was Google heute abgewiesen hat, ist die angezeigte Grenze', async () => {
    settings.setze('gemini_tagesbudget', '50000');
    settings.setze('ki_429_tag', new Date().toLocaleDateString('sv-SE'));
    settings.setze('ki_429_stand', '412');
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.budget.grenze, 412);
    assert.equal(u.budget.beobachtet.stand, 412);
  });
});

describe('Trefferquote', () => {
  test('korrigierte Einordnungen senken die Quote', async () => {
    for (let i = 0; i < 10; i++) log({});     // 10 einsortiert
    log({ korr: 'Sport' }); log({ korr: 'Sport' }); // 2 davon korrigiert -> 12 gesamt, 2 falsch
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.lernen.einordnungen7, 12);
    assert.equal(u.lernen.korrigiert7, 2);
    assert.equal(u.lernen.trefferquote, Math.round((1 - 2 / 12) * 100));
  });

  test('ohne Einordnungen keine erfundene Quote', async () => {
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.lernen.trefferquote, null);
  });
});

describe('Posteingangs-Rückstand', () => {
  test('summiert erreichbare Postfächer', async () => {
    konto('Eins'); konto('Zwei');
    imapStub.naechste = new Set([1, 2, 3]);
    const u = await uebersicht.laden();
    assert.equal(u.posteingang.konten.length, 2);
    assert.equal(u.posteingang.wartendGesamt, 6, '3 + 3');
  });

  test('ein nicht erreichbares Postfach lässt die Übersicht nicht scheitern', async () => {
    konto('Kaputt');
    imapStub.wirft = true;
    const u = await uebersicht.laden();
    assert.equal(u.posteingang.konten[0].erreichbar, false);
    assert.equal(u.posteingang.wartendGesamt, 0, 'unlesbare zählen nicht mit');
  });
});

// Wann wurde der Altbestand zuletzt angefasst? Der Zeitstempel kommt vom
// Budget-Waechter (nur Workflow 04 ruft ihn) und landet aufs Dashboard.
describe('Bestands-Triage im Dashboard', () => {
  test('ohne Lauf steht ehrlich nichts da', async () => {
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.bestand.letzterLauf, null);
    assert.equal(u.bestand.verarbeitet, 0);
  });

  test('gemerkter Lauf kommt mit Zahlen durch', async () => {
    settings.setze('bestand_letzter_lauf', '2026-09-04T10:00:00.000Z');
    settings.setze('bestand_letzter_lauf_anzahl', '120');
    settings.setze('bestand_letzter_lauf_gesamt', '232');
    settings.setze('bestand_intervall', '6');
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.bestand.letzterLauf, '2026-09-04T10:00:00.000Z');
    assert.equal(u.bestand.verarbeitet, 120);
    assert.equal(u.bestand.gesamt, 232);
    assert.equal(u.bestand.intervallStunden, 6);
  });
});
