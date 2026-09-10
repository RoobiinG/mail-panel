// Warum die Bestands-Triage stehen blieb — und was das jetzt verhindert.
//
// Der IMAP-Knoten holt die ersten 100 Mails des Posteingangs. Immer dieselben:
// Die Suche liefert aufsteigend nach UID, der Knoten schneidet vorn ab. Alles,
// was liegen bleibt — und die KI laesst Unklares bewusst liegen —, stand beim
// naechsten Lauf wieder ganz vorn. Nach zwei Laeufen bewegte sich nichts mehr,
// waehrend 23.000 Mails dahinter warteten. Der Lauf war trotzdem gruen.
//
// Jetzt sagt das Panel, welche UIDs drankommen. Diese Datei nagelt die Regeln
// fest, nach denen es das tut.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-123';
const db = require('../src/db');
const settings = require('../src/services/settings');
const imap = require('../src/services/imap');
const bestand = require('../src/services/bestand');
const patcher = require('../src/services/workflowPatcher');

const kontoAnlegen = (name = 'K') => db.prepare(
  'INSERT INTO accounts (name, host, port, username, password_enc, aktiv)'
  + " VALUES (?, 'h', 993, 'u', 'x', 1)",
).run(name).lastInsertRowid;

// Statt eines echten Postfachs: eine feste UID-Liste.
function postfachMit(uids) {
  imap.uidsAuflisten = async () => new Set(uids);
  // Seit dem Unterordner-Scan braucht bestand.kandidaten() auch ordnerDetails.
  imap.ordnerDetails = async () => [{ pfad: 'INBOX', auswaehlbar: true, spezial: 'inbox' }];
}

beforeEach(() => {
  db.exec('DELETE FROM accounts; DELETE FROM sort_inbox; DELETE FROM bestand_erledigt;'
    + ' DELETE FROM quarantine_log; DELETE FROM sort_rules;');
  db.prepare("DELETE FROM settings WHERE key LIKE 'bestand_%' OR key LIKE 'gemini_%' OR key LIKE 'ki_%'").run();
});

describe('Auswahl der Bestands-Mails', () => {
  test('bietet die offenen UIDs an, aufsteigend', async () => {
    kontoAnlegen();
    postfachMit([5, 1, 3]);
    const a = await bestand.kandidaten();
    assert.equal(a.konten.K, '1,3,5');
    assert.equal(a.offen.K, 3);
  });

  test('was in der Sortier-Inbox liegt, wird nicht erneut angeboten', async () => {
    const id = kontoAnlegen();
    db.prepare("INSERT INTO sort_inbox (konto, konto_id, von, uid) VALUES ('K', ?, 'a@b.de', '3')").run(id);
    postfachMit([1, 2, 3]);
    const a = await bestand.kandidaten();
    assert.equal(a.konten.K, '1,2', 'die 3 ist schon entschieden');
  });

  test('in Ruhe gelassene Mails ebenfalls nicht', async () => {
    const id = kontoAnlegen();
    bestand.erledigtMerken(id, 2, 'ruhe');
    postfachMit([1, 2, 3]);
    assert.equal((await bestand.kandidaten()).konten.K, '1,3');
  });

  // Die Kernfrage: Kann eine Mail aus dem Blick geraten, ohne dass es auffaellt?
  //
  // Die zweite Chance galt frueher fuers ganze Fenster. Wurden 200 von 250 Mails
  // sortiert, rueckte der Zeiger ueber alle 250 — und die 50, die liegen blieben,
  // warteten einen kompletten Durchlauf des Postfachs. Jetzt wird je Mail
  // nachgehalten.
  test('was liegen blieb, kommt beim naechsten Lauf zuerst dran', async () => {
    const id = kontoAnlegen();
    postfachMit([1, 2, 3, 4, 5, 6]);
    assert.equal((await bestand.kandidaten(3)).konten.K, '1,2,3');

    // Zwei sind durch, die 2 blieb liegen — sie muss vorn wieder auftauchen.
    bestand.erledigtMerken(id, 1, 'ruhe');
    bestand.erledigtMerken(id, 3, 'ruhe');
    assert.equal((await bestand.kandidaten(3)).konten.K, '2,4,5',
      'sonst wartet die 2 einen ganzen Durchlauf des Postfachs');
  });

  test('wer zweimal drankam und immer noch liegt, wird weiterhin angeboten', async () => {
    const id = kontoAnlegen();
    postfachMit([1, 2, 3, 4, 5, 6]);
    assert.equal((await bestand.kandidaten(2)).konten.K, '1,2');

    // Der Lauf hat etwas geschafft (1), die 2 blieb liegen.
    bestand.erledigtMerken(id, 1, 'ruhe');
    assert.equal((await bestand.kandidaten(2)).konten.K, '2,3', 'die 2 kommt zuerst wieder');

    // Wieder etwas geschafft (3), die 2 liegt immer noch — zweimal drangewesen.
    bestand.erledigtMerken(id, 3, 'ruhe');
    assert.equal((await bestand.kandidaten(2)).konten.K, '2,4',
      'die 2 bleibt hartnaeckig vorn, da es kein automatisches unklar-Abstempeln mehr gibt');
  });

  test('zurueckgestellte Mails kommen in der naechsten Runde wieder', async () => {
    const id = kontoAnlegen();
    postfachMit([1, 2, 3]);
    await bestand.kandidaten(2);           // 1,2
    bestand.erledigtMerken(id, 1, 'ruhe');
    await bestand.kandidaten(2);           // 2 (Nachzuegler) + 3
    bestand.erledigtMerken(id, 3, 'ruhe'); // etwas geschafft, 2 liegt weiter
    await bestand.kandidaten(2);           // 2 wird zurueckgestellt, nichts mehr da
    assert.equal((await bestand.kandidaten(2)).konten.K, '2',
      '„unklar" heisst zurueckgestellt, nicht aufgegeben');
    assert.equal(bestand.unklareAnzahl(id), 0);
  });

  test('leerer Posteingang: eine UID, die es nicht gibt', async () => {
    kontoAnlegen();
    postfachMit([]);
    const a = await bestand.kandidaten();
    assert.equal(a.konten.K, bestand.KEINE);
    assert.notEqual(a.konten.K, '', 'ein leeres Suchfeld waere eine ungueltige IMAP-Suche');
  });

  test('unerreichbares Postfach kippt die anderen Konten nicht', async () => {
    kontoAnlegen('A');
    kontoAnlegen('B');
    imap.uidsAuflisten = async () => { throw new Error('Verbindung abgelehnt'); };
    const a = await bestand.kandidaten();
    assert.equal(a.konten.A, bestand.KEINE);
    assert.equal(a.konten.B, bestand.KEINE);
  });

  test('ist das Tagesbudget aufgebraucht, wird nichts angeboten', async () => {
    kontoAnlegen();
    postfachMit([1, 2, 3]);
    // Gezaehlt werden Anfragen, nicht Mails — seit der Buendelung zweierlei.
    settings.setze('gemini_tagesbudget', '2');
    require('../src/services/budget').ausgabeMerken(2);
    const a = await bestand.kandidaten();
    assert.equal(a.konten.K, bestand.KEINE,
      'sonst laeuft der Zeiger ueber Mails, die gar nicht drankamen');
  });

  test('eine geloeschte Ruhe-Regel gibt die Mails wieder frei', async () => {
    const id = kontoAnlegen();
    bestand.erledigtMerken(id, 2, 'ruhe');
    bestand.ruheVergessen(id);
    postfachMit([1, 2]);
    assert.equal((await bestand.kandidaten()).konten.K, '1,2');
  });
});

describe('Der Abruf-Knoten in Workflow 04', () => {
  test('filtert auf die UIDs aus der Panel-Auswahl', () => {
    const k = patcher.bestandKnoten({ id: 7, name: 'Kontakt-E-Mail' }, [0, 0]);
    const uid = k.parameters.emailSearchFilters.uid;
    assert.match(uid, /^=\{\{/, 'muss ein Ausdruck sein');
    assert.ok(uid.includes(patcher.AUSWAHL_KNOTEN), 'holt die Liste aus dem Auswahl-Knoten');
    assert.ok(uid.includes('"Kontakt-E-Mail"'), 'und zwar die des eigenen Kontos');
    assert.ok(uid.includes("|| '" + bestand.KEINE + "'"),
      'ohne Antwort dieselbe Ersatz-UID, die auch das Panel zurueckgibt');
  });

  test('der Auswahl-Knoten laesst den Lauf nicht platzen', () => {
    const k = patcher.bestandAuswahlKnoten([0, 0], 'cred-1');
    assert.equal(k.alwaysOutputData, true);
    assert.equal(k.onError, 'continueRegularOutput');
    assert.equal(k.credentials.httpHeaderAuth.id, 'cred-1');
    assert.match(k.parameters.url, /bestand-kandidaten$/);
    assert.match(String(k.id), /^panel-/);
  });
});

