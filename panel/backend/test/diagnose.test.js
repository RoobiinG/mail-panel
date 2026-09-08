// Der Diagnose-Bericht — und vor allem: was NICHT drinstehen darf.
//
// Der Bericht existiert, damit niemand eine Shell auf dem Mailserver braucht, um
// beim Fehlersuchen zu helfen. Er wird also weitergegeben. Jede Zeile, die ein
// Geheimnis oder eine Adresse aus einem Postfach enthält, ist damit ein Leck —
// und es fällt niemandem auf, weil der Bericht ja „nur Technik" ist.
//
// Deshalb prüfen die Tests hier zuerst das Weglassen und erst danach den Inhalt.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const diagnose = require('../src/services/diagnose');

const GEHEIM = 'streng-geheimer-api-schluessel-4711';
const ADRESSE = 'max.mustermann@example.com';
const BETREFF = 'Ihre Rechnung 2026-0815';

let bericht;
let text;

before(async () => {
  settings.setze('gemini_api_key', GEHEIM);
  settings.setze('n8n_api_key', GEHEIM);
  settings.setze('telegram_token', GEHEIM);
  settings.setze('ki_anbieter', 'gemini');
  settings.setze('gemini_modell', 'gemini-3.5-flash-lite');

  db.prepare(`INSERT INTO accounts (name, host, port, username, password_enc, aktiv)
              VALUES ('Post', 'imap.example.org', 993, ?, ?, 1)`).run(ADRESSE, 'VERSCHLUESSELT-' + GEHEIM);

  db.prepare(`INSERT INTO quarantine_log (konto, von, betreff, kategorie, zielordner, grund)
              VALUES ('Post', ?, ?, 'rechnung', 'Rechnungen', ?)`)
    .run(ADRESSE, BETREFF, `Stichwort aus der Beschreibung, gemeldet von ${ADRESSE}`);

  // Über den echten Logger, nicht per INSERT: So wird nebenbei geprüft, dass der
  // Bericht die Zeilen findet, die im Betrieb tatsächlich geschrieben werden.
  require('../src/services/panelLog')
    .loggen('warn', 'sortierung', `Korrektur: ${ADRESSE} von Archiv nach Rechnungen`);

  bericht = await diagnose.erstellen({ mitMails: false });
  text = diagnose.alsText(bericht);
});

describe('Was nicht hineingehört', () => {
  test('kein API-Schlüssel, nirgends', () => {
    assert.ok(!JSON.stringify(bericht).includes(GEHEIM),
      'ein Geheimnis steht im Bericht — er wird weitergegeben');
    assert.ok(!text.includes(GEHEIM), 'ein Geheimnis steht im Text');
  });

  test('kein verschlüsseltes Passwort aus der Kontotabelle', () => {
    assert.ok(!JSON.stringify(bericht).includes('VERSCHLUESSELT-'),
      'password_enc ist mitgekommen — auch verschlüsselt hat es hier nichts verloren');
  });

  // Der unauffälligste Weg nach draußen: Logzeilen wie
  // "Korrektur: max@example.com von A nach B".
  test('keine Mailadresse, auch nicht aus Logzeilen oder Gründen', () => {
    const alles = JSON.stringify(bericht) + text;
    assert.ok(!alles.includes(ADRESSE), 'eine Adresse aus dem Postfach ist im Bericht gelandet');
    assert.ok(!alles.includes(BETREFF), 'ein Betreff ist im Bericht gelandet');
  });

  test('die Logzeile ist trotzdem noch lesbar', () => {
    const zeile = (bericht.logs || []).find((l) => String(l.text).includes('Korrektur'));
    assert.ok(zeile, 'die Logzeile fehlt ganz — dann nützt der Bericht nichts');
    assert.match(zeile.text, /<adresse>/, 'die Adresse muss ersetzt, nicht gelöscht sein');
    assert.match(zeile.text, /von Archiv nach Rechnungen/, 'der Rest muss stehen bleiben');
  });

  test('Geheimnisse erscheinen als Zustand, nicht als Wert', () => {
    assert.equal(bericht.konfiguration.schluessel.gemini_api_key, 'gesetzt');
    assert.equal(bericht.konfiguration.schluessel.mailcow_api_key, 'nicht gesetzt');
  });
});

describe('Was drinstehen muss', () => {
  test('Version und Laufzeit des Panels', () => {
    assert.ok(bericht.panel.node, 'ohne Node-Version fehlt der halbe Kontext');
    assert.equal(typeof bericht.panel.laeuftSeitSekunden, 'number');
  });

  // Zweimal war eine volle Platte die Ursache für "Exit 137" — das sieht man
  // dem Panel sonst nirgends an.
  test('Speicher und Platte', () => {
    assert.equal(typeof bericht.maschine.speicherMB.gesamt, 'number');
    assert.ok(bericht.maschine.platte.gesamtMB > 0 || bericht.maschine.platte.fehler);
    assert.equal(typeof bericht.maschine.kerne, 'number');
  });

  test('Konten mit Host, aber ohne Zugangsdaten', () => {
    const k = bericht.konten.find((x) => x.name === 'Post');
    assert.ok(k, 'das Konto fehlt');
    assert.equal(k.host, 'imap.example.org:993');
    assert.equal(k.aktiv, true);
    assert.ok(!('password_enc' in k) && !('username' in k),
      'Benutzername und Passwort gehören nicht in den Bericht');
  });

  test('Zahlen zur Sortierung, keine Inhalte', () => {
    assert.equal(typeof bericht.sortierung.entscheidungenGesamt, 'number');
    assert.ok(Array.isArray(bericht.sortierung.zielordner7Tage));
    assert.ok(Array.isArray(bericht.sortierung.gruende7Tage));
  });

  // "Spalte grund fehlt" erklaert auf einen Blick, warum ein Feld leer bleibt.
  test('das Datenbank-Schema verrät fehlende Migrationen', () => {
    assert.ok(bericht.schema.quarantine_log.includes('grund'));
    assert.ok(bericht.schema.quarantine_log.includes('ki'));
  });

  test('der Zustand der KI', () => {
    assert.equal(bericht.ki.anbieter, 'gemini');
    assert.equal(typeof bericht.ki.tagesbudget, 'number');
  });

  // Ein Abschnitt darf scheitern, ohne den Bericht mitzunehmen: n8n ist im Test
  // nicht erreichbar, und trotzdem muss der Rest herauskommen.
  test('ein nicht erreichbares n8n kippt den Bericht nicht', () => {
    assert.ok('workflows' in bericht);
    assert.ok(bericht.workflows.fehler || Array.isArray(bericht.workflows),
      'entweder eine Liste oder eine benannte Fehlermeldung — aber kein Absturz');
    assert.ok(bericht.sortierung.entscheidungenGesamt >= 1, 'der Rest muss trotzdem dastehen');
  });
});

describe('Der Text zum Weitergeben', () => {
  test('sagt oben, ob Mailinhalte drin sind', () => {
    assert.match(text, /Ohne Mailinhalte/);
  });

  test('enthält die Abschnitte, nach denen man sucht', () => {
    for (const ueberschrift of ['## Panel', '## Maschine', '## Dienste', '## KI',
      '## Workflows in n8n', '## Letzte Läufe', '## Sortierung', '## Logs']) {
      assert.ok(text.includes(ueberschrift), `Abschnitt fehlt: ${ueberschrift}`);
    }
  });

  test('nennt die Grenze, die das Panel selbst hat', () => {
    assert.match(text, /Docker-Socket/,
      'dass Container-Zustände fehlen, muss dabeistehen — sonst sucht man sie');
  });
});

describe('Mit Mailinhalten — die bewusste Ausnahme', () => {
  test('erst dann stehen Absender und Betreff drin, und es steht dabei', async () => {
    const offen = await diagnose.erstellen({ mitMails: true });
    const offenerText = diagnose.alsText(offen);
    assert.equal(offen.mitMailinhalten, true);
    assert.match(offenerText, /enthält Absender und Betreffe/);
    assert.ok(JSON.stringify(offen.letzteEntscheidungen).includes(ADRESSE));
    // Auch dann bleiben Geheimnisse draußen — das ist keine Freigabe für alles.
    assert.ok(!JSON.stringify(offen).includes(GEHEIM),
      'Mailinhalte freizugeben heisst nicht, Schluessel freizugeben');
  });
});

describe('adressenTilgen()', () => {
  test('ersetzt Adressen und lässt den Rest stehen', () => {
    assert.equal(
      diagnose.adressenTilgen('von a.b-c@sub.example.co.uk an x@y.de: fertig'),
      'von <adresse> an <adresse>: fertig',
    );
  });
  test('kommt mit leer und undefined klar', () => {
    assert.equal(diagnose.adressenTilgen(null), '');
    assert.equal(diagnose.adressenTilgen(''), '');
  });
});
