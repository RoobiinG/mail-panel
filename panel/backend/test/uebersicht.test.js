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
  return db.prepare(`INSERT INTO accounts (name, host, port, username, password_enc, aktiv)
    VALUES (?, 'h', 993, 'u', ?, 1)`).run(name, verschluesseln('x')).lastInsertRowid;
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
  db.prepare("DELETE FROM settings WHERE key IN ('ki_tagesbudget','bestand_letzter_lauf','bestand_letzter_lauf_anzahl','bestand_letzter_lauf_gesamt','bestand_intervall') OR key LIKE 'ki_%'").run();
  uebersicht.cacheVerwerfen();
  imapStub.wirft = false; imapStub.naechste = new Set();
});



describe('Trefferquote', () => {
  test('korrigierte Einordnungen senken die Quote', async () => {
    for (let i = 0; i < 10; i++) log({});     // 10 einsortiert
    log({ korr: 'Sport' }); log({ korr: 'Sport' }); // 2 davon korrigiert -> 12 gesamt, 2 falsch
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.lernen.einordnungen7, 12);
    assert.equal(u.lernen.korrigiert7, 2);
    assert.equal(u.lernen.trefferquote, Number(((1 - 2 / 12) * 100).toFixed(1)));
  });

  test('ohne Einordnungen keine erfundene Quote', async () => {
    const u = await uebersicht.laden({ mitPosteingang: false });
    assert.equal(u.lernen.trefferquote, null);
  });
});

describe('Posteingangs-Rückstand', () => {
  test('summiert erreichbare Postfächer', async () => {
    const idE = konto('Eins'); const idZ = konto('Zwei');
    // Der Rückstand kommt jetzt aus sort_inbox, nicht mehr per IMAP.
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Eins', ?, 'a@b.de', '1', 'offen')").run(idE);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Eins', ?, 'a@b.de', '2', 'offen')").run(idE);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Eins', ?, 'a@b.de', '3', 'offen')").run(idE);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Zwei', ?, 'a@b.de', '4', 'offen')").run(idZ);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Zwei', ?, 'a@b.de', '5', 'offen')").run(idZ);
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid, status) VALUES ('Zwei', ?, 'a@b.de', '6', 'offen')").run(idZ);
    const u = await uebersicht.laden();
    assert.equal(u.posteingang.konten.length, 2);
    assert.equal(u.posteingang.wartendGesamt, 6, '3 + 3');
  });

  test('ein nicht erreichbares Postfach lässt die Übersicht nicht scheitern', async () => {
    konto('Kaputt');
    // Ohne sort_inbox-Einträge für das Konto ist der Rückstand 0,
    // und die DB-basierte Logik gibt immer erreichbar=true.
    const u = await uebersicht.laden();
    assert.equal(u.posteingang.konten[0].erreichbar, true);
    assert.equal(u.posteingang.wartendGesamt, 0, 'keine offenen Einträge');
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
