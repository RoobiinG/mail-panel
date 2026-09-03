// Stimmt die Dokumentation mit der Wirklichkeit überein?
//
// Anlass: `.env.example` erklärte `TLS_CERT`, `TLS_KEY`, `TLS_MODUS` und
// `PANEL_HOST` — die `docker-compose.yml` reichte keine davon an den Container
// durch. Wer sie eingetragen hätte, wäre auf eine Einstellung hereingefallen,
// die es gar nicht gab. Im selben Zug war `CLAMD_HOST` fest verdrahtet, was
// `einrichten.sh` stillschweigend wirkungslos machte.
//
// Beides sind keine Programmierfehler im engeren Sinn, sondern das übliche
// Auseinanderlaufen von Beschreibung und Aufbau. Genau dagegen ist dieser Test.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WURZEL = path.resolve(__dirname, '../../..');

// Diese Prüfungen brauchen die Dateien aus dem Repository-Wurzelverzeichnis.
// Im fertigen Docker-Image liegen sie nicht — dort wird nur panel/backend/
// hineinkopiert, nicht .env.example und docker-compose.yml. Fehlen sie, werden
// die Tests übersprungen statt zu scheitern: Ein `npm test` im Container soll
// nicht wegen einer Prüfung Alarm schlagen, die dort gar nicht greifen kann.
// In der CI (voller Checkout) laufen sie normal.
const imRepo = fs.existsSync(path.join(WURZEL, '.env.example'))
  && fs.existsSync(path.join(WURZEL, 'docker-compose.yml'));
const beispiel = imRepo ? fs.readFileSync(path.join(WURZEL, '.env.example'), 'utf8') : '';
const compose = imRepo ? fs.readFileSync(path.join(WURZEL, 'docker-compose.yml'), 'utf8') : '';
const nurImRepo = { skip: imRepo ? false : 'nur im Repository, nicht im Docker-Image' };

// Variablen, die Docker Compose selbst auswertet — sie tauchen deshalb nicht
// als ${...} in der Datei auf und dürfen es auch nicht.
const COMPOSE_EIGENE = new Set(['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME']);

function variablenAus(text) {
  const raus = new Set();
  for (const zeile of text.split('\n')) {
    // Auch auskommentierte Beispiele zählen: Sie sind eine Zusage an den Leser.
    const treffer = zeile.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/);
    if (treffer) raus.add(treffer[1]);
  }
  return raus;
}

describe('.env.example gegen docker-compose.yml', () => {
  test('jede beschriebene Variable wird auch durchgereicht', nurImRepo, () => {
    const fehlend = [];
    for (const name of variablenAus(beispiel)) {
      if (COMPOSE_EIGENE.has(name)) continue;
      if (!compose.includes(`\${${name}`)) fehlend.push(name);
    }
    assert.deepEqual(fehlend, [],
      'In .env.example beschrieben, aber in docker-compose.yml nicht benutzt — '
      + 'wer sie einträgt, bekommt keine Wirkung: ' + fehlend.join(', '));
  });

  test('nichts ist fest verdrahtet, was einrichten.sh setzen soll', nurImRepo, () => {
    // Das Einrichtungsskript trägt diese beiden in die .env ein. Stünden sie in
    // der compose-Datei mit festem Wert, überschriebe sie den Fund sofort.
    for (const name of ['CLAMD_HOST', 'UNBOUND_HOST']) {
      assert.doesNotMatch(compose, new RegExp(`- ${name}=[^$\\n]`),
        `${name} steht mit festem Wert in docker-compose.yml und macht einrichten.sh wirkungslos`);
      assert.ok(compose.includes(`\${${name}`), `${name} wird nicht aus der Umgebung übernommen`);
    }
  });

  test('ClamAV und unbound hängen an Profilen', nurImRepo, () => {
    // Ohne Profil würden sie auf jedem Server mitlaufen, auch wo es sie schon
    // gibt — bei ClamAV sind das rund 1,5 GB Arbeitsspeicher für nichts.
    for (const dienst of ['clamav', 'unbound']) {
      assert.match(compose, new RegExp(`profiles: \\["${dienst}"\\]`),
        `Der Dienst ${dienst} steht nicht hinter einem Profil`);
    }
  });
});

describe('Das Projekt lässt sich veröffentlichen', () => {
  test('es gibt eine Lizenz', nurImRepo, () => {
    const lizenz = path.join(WURZEL, 'LICENSE');
    assert.ok(fs.existsSync(lizenz), 'Ohne LICENSE darf niemand das Projekt benutzen');
    assert.match(fs.readFileSync(lizenz, 'utf8'), /MIT License/);
  });

  test('keine echten Adressen oder Zugangsdaten in den ausgelieferten Dateien', nurImRepo, () => {
    // Was einmal veröffentlicht ist, holt niemand zurück.
    const verdaechtig = /robin-glaser|u463253|your-storagebox|\b45\.81\.\d+\.\d+\b/i;
    for (const datei of ['.env.example', 'docker-compose.yml', 'einrichten.sh', 'README.md']) {
      const pfad = path.join(WURZEL, datei);
      if (!fs.existsSync(pfad)) continue;
      const inhalt = fs.readFileSync(pfad, 'utf8');
      assert.doesNotMatch(inhalt, verdaechtig, `${datei} enthält eine echte Adresse`);
    }
  });
});
