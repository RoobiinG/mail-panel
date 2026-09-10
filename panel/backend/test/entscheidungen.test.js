// Die Entscheidungs-Chronik: alles, was sortiert wurde — such- und blätterbar.
//
// Der Anlass ist ein echter: „mir sind ein, zwei Fehler aufgefallen". Nur waren
// die Fehler nicht mehr zu finden. Sichtbar waren die letzten 25 Zeilen, und
// eine falsch einsortierte Mail von vorgestern steht da längst nicht mehr.
// Jeder Test hier hält einen Weg offen, auf dem man sie wiederfindet.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const e = require('../src/services/entscheidungen');

// „versatz" ist die Altersangabe für SQLite: '-0 days' heißt eben passiert,
// '-40 days' eine Zeile von vor gut einem Monat. Ohne die ließe sich der
// Zeitraum-Filter nicht prüfen.
const anlegen = (zeile) => db.prepare(`
  INSERT INTO quarantine_log (konto, von, betreff, kategorie, thema, konfidenz,
                              zielordner, korrigiert_zu, ki, spam_score, virus_name,
                              grund, created_at)
  VALUES (@konto, @von, @betreff, @kategorie, @thema, @konfidenz,
          @zielordner, @korrigiert_zu, @ki, @spam_score, @virus_name,
          @grund, datetime('now', @versatz))
`).run({
  konto: 'Post', von: 'x@example.com', betreff: null, kategorie: null, thema: null,
  konfidenz: null, zielordner: 'Archiv', korrigiert_zu: null, ki: 1, spam_score: null,
  virus_name: null, grund: null, versatz: '-0 days',
  ...zeile,
});

db.prepare('DELETE FROM quarantine_log').run();
anlegen({
  von: 'rechnung@amazon.de', betreff: 'Ihre Bestellung', thema: 'Bestellungen',
  zielordner: 'Bestellungen', grund: 'Vorhandener Themen-Ordner', versatz: '-40 days',
});
anlegen({
  von: 'newsletter@amazon.de', betreff: 'Angebote der Woche', thema: 'Newsletter',
  zielordner: 'Newsletter', virus_name: 'Eicar-Test-Signature', versatz: '-10 days',
});
anlegen({
  von: 'info@stadtwerke.example', betreff: 'Rechnung 2026-04', zielordner: 'Rechnungen',
  ki: 0, grund: 'Eigene Regel [domain] stadtwerke.example',
});
anlegen({ von: 'chef@firma.example', betreff: 'Urlaub', zielordner: 'Archiv', korrigiert_zu: 'Arbeit' });
anlegen({
  von: 'unklar@nirgendwo.example', betreff: '50% Rabatt', zielordner: null,
  grund: 'Zielordner "Werbung" existiert im Postfach nicht',
});
anlegen({
  konto: 'Zweitpostfach', von: 'rechnung@amazon.de', betreff: 'Rechnung',
  zielordner: 'Rechnungen', spam_score: 0.95,
});

describe('Suche — man sucht nach dem, woran man sich erinnert', () => {
  test('nach Absender', async () => {
    const t = await e.suchen({ suche: 'amazon' });
    assert.equal(t.gesamt, 3, 'zwei im ersten Postfach, eine im zweiten');
  });

  test('nach Betreff', async () => {
    const t = await e.suchen({ suche: 'Urlaub' });
    assert.equal(t.gesamt, 1);
    assert.equal(t.eintraege[0].von, 'chef@firma.example');
  });

  test('nach Ordner — auch nach dem, in den korrigiert wurde', async () => {
    assert.equal((await e.suchen({ suche: 'Bestellungen' })).gesamt, 1);
    assert.equal((await e.suchen({ suche: 'Arbeit' })).gesamt, 1);
  });

  test('Groß- und Kleinschreibung ist egal', async () => {
    assert.equal((await e.suchen({ suche: 'AMAZON' })).gesamt, 3);
  });

  // Zwei Wörter heißen „beides muss zutreffen", nicht „genau diese Zeichenkette":
  // Sonst findet „amazon bestellung" nichts, weil Absender und Betreff in
  // verschiedenen Spalten stehen.
  test('mehrere Wörter über verschiedene Felder hinweg', async () => {
    const t = await e.suchen({ suche: 'amazon bestellung' });
    assert.equal(t.gesamt, 1);
    assert.equal(t.eintraege[0].betreff, 'Ihre Bestellung');
  });

  test('mehrere Wörter schließen aus, was nur eines trifft', async () => {
    assert.equal((await e.suchen({ suche: 'amazon urlaub' })).gesamt, 0);
  });

  // % und _ sind in LIKE Platzhalter. Ungemaskiert hätte „50%" jede Zeile
  // getroffen, in der irgendwo „50" steht — und die Suche wäre wertlos.
  test('Prozentzeichen wird wörtlich gesucht, nicht als Platzhalter', async () => {
    assert.equal((await e.suchen({ suche: '50%' })).gesamt, 1);
    assert.equal((await e.suchen({ suche: '%' })).gesamt, 1, 'ein nacktes % darf nicht alles finden');
  });

  test('leere Suche liefert alles', async () => {
    assert.equal((await e.suchen({ suche: '   ' })).gesamt, 6);
  });
});

describe('Postfächer', () => {
  test('ein Konto zeigt nur seine eigenen Entscheidungen', async () => {
    assert.equal((await e.suchen({ konto: 'Post' })).gesamt, 5);
    assert.equal((await e.suchen({ konto: 'Zweitpostfach' })).gesamt, 1);
  });

  // Wer eine falsch einsortierte Mail sucht, weiß oft nicht mehr, wo sie ankam.
  test('ohne Konto wird über alle Postfächer gesucht', async () => {
    assert.equal((await e.suchen({ konto: null, suche: 'amazon' })).gesamt, 3);
  });
});

describe('Filter', () => {
  test('nur KI beziehungsweise nur eigene Regeln', async () => {
    assert.equal((await e.suchen({ nur: 'ki' })).gesamt, 5);
    assert.equal((await e.suchen({ nur: 'regel' })).gesamt, 1);
  });

  test('nur bereits korrigierte', async () => {
    const t = await e.suchen({ nur: 'korrigiert' });
    assert.equal(t.gesamt, 1);
    assert.equal(t.eintraege[0].korrigiert_zu, 'Arbeit');
  });

  // Der häufigste Grund für „warum wurde die nicht sortiert?" — und bis hierher
  // war er unsichtbar: Die alte Abfrage verlangte einen Zielordner und ließ
  // genau die Zeilen weg, die man sucht.
  test('liegengebliebene Mails sind auffindbar', async () => {
    const t = await e.suchen({ nur: 'liegen' });
    assert.equal(t.gesamt, 1);
    assert.equal(t.eintraege[0].zielordner, null);
  });

  test('ohne Filter sind sie trotzdem dabei', async () => {
    assert.ok((await e.suchen({})).eintraege.some((z) => z.zielordner === null));
  });

  // Der Blick für „ich glaube, die Spam- und Virenprüfung stimmt nicht".
  test('Spam und Viren zusammen', async () => {
    const t = await e.suchen({ nur: 'spam' });
    assert.equal(t.gesamt, 2, 'ein Virenfund und ein Wert über der Schwelle');
    assert.ok(t.eintraege.some((z) => z.virus_name));
    assert.ok(t.eintraege.some((z) => z.spam_score >= 0.8));
  });

  // Die Schwelle darf nicht im Code stehen: Sonst zeigt der Filter etwas
  // anderes an, als in den Workflows tatsächlich passiert ist.
  test('die Schwelle kommt aus den Einstellungen', async () => {
    const settings = require('../src/services/settings');
    const vorher = settings.hole('spam_schwellwert');
    try {
      settings.setze('spam_schwellwert', '0.99');
      const t = await e.suchen({ nur: 'spam' });
      assert.equal(t.gesamt, 1, 'bei 0,99 bleibt nur noch der Virenfund übrig');
      assert.ok(t.eintraege[0].virus_name);
    } finally {
      settings.setze('spam_schwellwert', vorher || '0.8');
    }
  });
});

describe('Zeitraum', () => {
  test('die letzten 7 Tage lassen alles Ältere weg', async () => {
    assert.equal((await e.suchen({ tage: 7 })).gesamt, 4, 'ohne die Zeilen von vor 10 und 40 Tagen');
  });

  test('30 Tage nehmen die von vor 10 Tagen wieder mit', async () => {
    assert.equal((await e.suchen({ tage: 30 })).gesamt, 5);
  });

  test('ohne Angabe zählt alles', async () => {
    assert.equal((await e.suchen({ tage: 0 })).gesamt, 6);
    assert.equal((await e.suchen({})).gesamt, 6);
  });

  test('Unsinn im Feld grenzt nicht versehentlich ein', async () => {
    assert.equal((await e.suchen({ tage: 'übermorgen' })).gesamt, 6);
    assert.equal((await e.suchen({ tage: -5 })).gesamt, 6);
  });

  test('Zeitraum und Suche greifen zusammen', async () => {
    assert.equal((await e.suchen({ suche: 'amazon' })).gesamt, 3);
    assert.equal((await e.suchen({ suche: 'amazon', tage: 7 })).gesamt, 1, 'nur die aus dem Zweitpostfach');
  });
});

describe('Der Grund — weshalb ist die Mail dort gelandet?', () => {
  test('er kommt mit der Zeile heraus', async () => {
    const t = await e.suchen({ suche: 'stadtwerke' });
    assert.equal(t.eintraege[0].grund, 'Eigene Regel [domain] stadtwerke.example');
  });

  // Der Grund ist das schnellste Sieb: „existiert nicht" findet auf einen
  // Schlag alle Mails, die an einem fehlenden Zielordner gescheitert sind.
  test('nach ihm lässt sich suchen', async () => {
    const t = await e.suchen({ suche: 'existiert nicht' });
    assert.equal(t.gesamt, 1);
    assert.equal(t.eintraege[0].von, 'unklar@nirgendwo.example');
  });

  test('Zeilen ohne Grund stören die Suche nicht', async () => {
    assert.equal((await e.suchen({ suche: 'Urlaub' })).eintraege[0].grund, null);
  });
});

describe('Blättern', () => {
  test('Gesamtzahl und Seitenzahl passen zusammen', async () => {
    const t = await e.suchen({ limit: 2 });
    assert.equal(t.gesamt, 6);
    assert.equal(t.seiten, 3);
    assert.equal(t.eintraege.length, 2);
  });

  test('Seite 2 setzt fort, statt zu wiederholen', async () => {
    const s1 = (await e.suchen({ limit: 2, seite: 1 })).eintraege.map((z) => z.id);
    const s2 = (await e.suchen({ limit: 2, seite: 2 })).eintraege.map((z) => z.id);
    assert.equal(s1.length, 2);
    assert.equal(s2.length, 2);
    assert.equal(s1.filter((id) => s2.includes(id)).length, 0, 'keine Zeile darf doppelt erscheinen');
  });

  test('das Neueste steht oben', async () => {
    const ids = (await e.suchen({})).eintraege.map((z) => z.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  });

  // Wer auf Seite 3 einen Suchbegriff eintippt, hätte sonst eine leere Liste vor
  // sich und hielte die Suche für kaputt.
  test('eine Seite hinter dem Ende zeigt die letzte, nicht nichts', async () => {
    const t = await e.suchen({ limit: 2, seite: 99 });
    assert.equal(t.seite, 3);
    assert.ok(t.eintraege.length > 0);
  });

  test('unsinnige Werte kippen die Abfrage nicht', async () => {
    assert.equal((await e.suchen({ seite: -5, limit: 0 })).seite, 1);
    assert.ok((await e.suchen({ limit: 99999 })).limit <= 200, 'die Seitengröße bleibt gedeckelt');
  });
});

// Kein HTTP-Server: Der Handler wird direkt aus dem Router geholt. Das prüft die
// Stelle, an der Route und Dienst zusammenkommen — dort hat schon einmal ein
// Tippfehler eine ganze Seite mit „Interner Serverfehler" lahmgelegt.
describe('Die Route liefert das auch aus', () => {
  const router = require('../src/routes/sortierung');
  const handler = (() => {
    const schicht = router.stack.find((s) => s.route?.path === '/entscheidungen' && s.route.methods.get);
    assert.ok(schicht, 'Route GET /entscheidungen fehlt');
    return schicht.route.stack[schicht.route.stack.length - 1].handle;
  })();

  const attrappe = () => {
    const antwort = { code: 200, koerper: null };
    return {
      res: {
        status(c) { antwort.code = c; return this; },
        json(k) { antwort.koerper = k; return this; },
      },
      antwort,
    };
  };

  test('konto_id=alle sucht über alle Postfächer', async () => {
    const { res, antwort } = attrappe();
    await handler({ query: { konto_id: 'alle', suche: 'amazon' } }, res);
    assert.equal(antwort.code, 200, `Fehler: ${antwort.koerper && antwort.koerper.error}`);
    assert.equal(antwort.koerper.gesamt, 3);
    for (const feld of ['eintraege', 'gesamt', 'seite', 'seiten', 'limit']) {
      assert.ok(feld in antwort.koerper, `Feld "${feld}" fehlt — ohne das kann die Seite nicht blättern`);
    }
  });

  test('ein bekanntes Konto grenzt ein', async () => {
    db.prepare(`INSERT INTO accounts (name, host, port, username, password_enc)
                VALUES ('Post', 'imap.example', 993, 'p', 'x')`).run();
    const id = db.prepare("SELECT id FROM accounts WHERE name = 'Post'").get().id;
    const { res, antwort } = attrappe();
    await handler({ query: { konto_id: id } }, res);
    assert.equal(antwort.code, 200);
    assert.equal(antwort.koerper.gesamt, 5);
  });

  test('ein unbekanntes Konto ist ein Fehler, kein leeres Ergebnis', async () => {
    const { res, antwort } = attrappe();
    await handler({ query: { konto_id: 999999 } }, res);
    assert.equal(antwort.code, 400);
  });
});
