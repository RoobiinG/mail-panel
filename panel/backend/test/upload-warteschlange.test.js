// Die Warteschlange zwischen n8n und der Nextcloud.
//
// Sie ist der einzige Ort im Panel, an dem Nutzerdateien liegen — und sie wird
// von einem unbeaufsichtigten Workflow befüllt. Entsprechend geht es hier
// weniger um den Normalfall als um die Ränder: doppelte Einlieferung, Pfade mit
// "..", Dateien ohne Datensatz, abgelaufene Fristen.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const warteschlange = require('../src/services/uploadFreigabe');

const INHALT = Buffer.from('%PDF-1.4 Testbeleg').toString('base64');

const eingang = (ueber = {}) => ({
  aktion_id: 1,
  aktion_name: 'Belege',
  konto: 'K',
  von: 'rechnung@firma.example',
  betreff: 'Ihre Rechnung',
  uid: '42',
  ordner: 'INBOX',
  dateiname: 'Rechnung.pdf',
  zielpfad: 'Belege/2026',
  base64: INHALT,
  ...ueber,
});

const dateienImLager = () => fs.readdirSync(warteschlange.ablageOrdner());
const offene = () => db.prepare("SELECT * FROM upload_freigaben WHERE status='offen'").all();

beforeEach(() => {
  db.exec('DELETE FROM upload_freigaben;');
  for (const name of dateienImLager()) {
    try { fs.unlinkSync(path.join(warteschlange.ablageOrdner(), name)); } catch { /* egal */ }
  }
  db.prepare("DELETE FROM settings WHERE key = 'upload_freigabe_frist_tage'").run();
});

describe('Einliefern', () => {
  test('legt Datensatz und Datei an', async () => {
    const r = await warteschlange.einliefern(eingang());
    assert.equal(r.ok, true, r.grund);

    const zeilen = offene();
    assert.equal(zeilen.length, 1);
    assert.equal(zeilen[0].dateiname, 'Rechnung.pdf');
    assert.equal(zeilen[0].zielpfad, 'Belege/2026');
    assert.equal(dateienImLager().length, 1, 'die Datei muss wirklich im Lager liegen');
  });

  // DATA_DIR unterscheidet sich zwischen Docker und Entwicklung — ein absoluter
  // Pfad in der Spalte wäre nach einem Umzug falsch.
  test('in der Datenbank steht nur der Name, nie ein Pfad', async () => {
    await warteschlange.einliefern(eingang());
    const zeile = offene()[0];
    assert.ok(!String(zeile.ablage).includes('/'));
    assert.ok(!String(zeile.ablage).includes('\\'));
  });

  // Der Pfad kommt aus einem Modell, das Ordnernamen erfindet — er ist kein
  // vertrauenswürdiger Wert.
  test('ein Pfad mit .. wird gesäubert', async () => {
    await warteschlange.einliefern(eingang({ zielpfad: '../../etc/Belege' }));
    const zeile = offene()[0];
    assert.ok(!zeile.zielpfad.includes('..'), `stattdessen: ${zeile.zielpfad}`);
  });

  test('ein Dateiname mit Pfadanteil wird auf den Namen reduziert', async () => {
    await warteschlange.einliefern(eingang({ dateiname: '../../../etc/passwd' }));
    const zeile = offene()[0];
    assert.ok(!zeile.dateiname.includes('/'));
    assert.ok(!zeile.dateiname.includes('..'), `stattdessen: ${zeile.dateiname}`);
  });

  test('ohne Zielpfad wird nichts angenommen', async () => {
    const r = await warteschlange.einliefern(eingang({ zielpfad: '' }));
    assert.equal(r.ok, false);
    assert.equal(r.grund, 'kein_zielpfad');
    assert.equal(dateienImLager().length, 0, 'und es darf auch keine Datei entstehen');
  });

  test('ohne Inhalt ebenso', async () => {
    const r = await warteschlange.einliefern(eingang({ base64: '' }));
    assert.equal(r.ok, false);
    assert.equal(r.grund, 'keine_datei');
  });

  // Die Bestands-Triage läuft mehrfach über dieselben Mails.
  test('dieselbe Datei kommt nicht zweimal in die Warteschlange', async () => {
    await warteschlange.einliefern(eingang());
    const zweit = await warteschlange.einliefern(eingang());

    assert.equal(zweit.ok, false);
    assert.equal(zweit.grund, 'schon_in_warteschlange');
    assert.equal(offene().length, 1);
    assert.equal(dateienImLager().length, 1,
      'die Prüfung muss VOR dem Schreiben greifen, sonst bleibt eine Waise liegen');
  });

  test('eine andere Datei derselben Mail schon', async () => {
    await warteschlange.einliefern(eingang());
    const r = await warteschlange.einliefern(eingang({ dateiname: 'Anhang2.pdf' }));
    assert.equal(r.ok, true, r.grund);
    assert.equal(offene().length, 2);
  });
});

describe('Verwerfen', () => {
  test('löscht die Datei und merkt den Grund', async () => {
    const { id } = await warteschlange.einliefern(eingang());
    const r = await warteschlange.verwerfen(id, 'Kein Beleg');

    assert.equal(r.ok, true);
    assert.equal(dateienImLager().length, 0, 'sonst bleibt sie für immer liegen');
    const zeile = warteschlange.holen(id);
    assert.equal(zeile.status, 'verworfen');
    assert.equal(zeile.fehler, 'Kein Beleg');
    assert.ok(zeile.erledigt_am);
  });

  test('zweimal verwerfen geht nicht', async () => {
    const { id } = await warteschlange.einliefern(eingang());
    await warteschlange.verwerfen(id);
    const zweit = await warteschlange.verwerfen(id);
    assert.equal(zweit.ok, false);
  });

  test('ein unbekannter Eintrag wirft nicht', async () => {
    const r = await warteschlange.verwerfen(999999);
    assert.equal(r.ok, false);
  });
});

describe('Aufräumen', () => {
  test('was zu lange wartet, wird verworfen', async () => {
    const { id } = await warteschlange.einliefern(eingang());
    settings.setze('upload_freigabe_frist_tage', '7');
    db.prepare("UPDATE upload_freigaben SET created_at = datetime('now','-8 day') WHERE id = ?").run(id);

    const r = await warteschlange.aufraeumen();
    assert.equal(r.verworfen, 1);
    assert.equal(warteschlange.holen(id).status, 'verworfen');
    assert.equal(dateienImLager().length, 0);
  });

  test('was noch in der Frist liegt, bleibt', async () => {
    const { id } = await warteschlange.einliefern(eingang());
    settings.setze('upload_freigabe_frist_tage', '30');
    db.prepare("UPDATE upload_freigaben SET created_at = datetime('now','-3 day') WHERE id = ?").run(id);

    await warteschlange.aufraeumen();
    assert.equal(warteschlange.holen(id).status, 'offen');
  });

  // Entsteht, wenn das Panel zwischen Schreiben und INSERT abstürzt.
  test('Dateien ohne Datensatz werden eingesammelt', async () => {
    fs.writeFileSync(path.join(warteschlange.ablageOrdner(), '1700000000000-abcdef.pdf'), 'ohne Datensatz');
    assert.equal(dateienImLager().length, 1);

    const r = await warteschlange.aufraeumen();
    assert.equal(r.verwaist, 1);
    assert.equal(dateienImLager().length, 0);
  });

  test('die Datei eines wartenden Eintrags wird dabei nicht angefasst', async () => {
    await warteschlange.einliefern(eingang());
    await warteschlange.aufraeumen();
    assert.equal(dateienImLager().length, 1, 'sonst wäre die Warteschlange nach sechs Stunden leer');
  });
});

describe('Freigeben ohne Datei', () => {
  // Volume neu aufgesetzt, von Hand aufgeräumt: Die Zeile steht noch, die Datei
  // ist weg. Endlos daran zu scheitern hilft niemandem.
  test('meldet sauber und stellt den Eintrag ruhig', async () => {
    const { id } = await warteschlange.einliefern(eingang());
    for (const name of dateienImLager()) {
      fs.unlinkSync(path.join(warteschlange.ablageOrdner(), name));
    }

    const r = await warteschlange.freigeben(id);
    assert.equal(r.ok, false);
    assert.match(r.fehler, /Zwischenlager/);
    assert.equal(warteschlange.holen(id).status, 'verworfen');
  });
});

describe('Die Liste zeigt nur Wartendes', () => {
  test('Erledigtes fällt heraus', async () => {
    const a = await warteschlange.einliefern(eingang());
    await warteschlange.einliefern(eingang({ dateiname: 'Zweite.pdf' }));
    await warteschlange.verwerfen(a.id);

    const liste = warteschlange.liste();
    assert.equal(liste.length, 1);
    assert.equal(liste[0].dateiname, 'Zweite.pdf');
  });

  test('der Inhalt der Datei steht nicht in der Liste', async () => {
    await warteschlange.einliefern(eingang());
    const zeile = warteschlange.liste()[0];
    assert.equal(zeile.base64, undefined);
    assert.equal(zeile.ablage, undefined, 'der Lagername gehört nicht in die Oberfläche');
  });
});
