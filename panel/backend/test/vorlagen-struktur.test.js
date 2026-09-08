// Zeigen die Verbindungen in den Vorlagen auf Knoten, die es gibt?
//
// Anlass ist ein Fund, der monatelang unbemerkt geblieben ist. In
// 01-inbox-triage-ollama.json und 04-bestand-triage-ollama.json heisst der
// KI-Knoten „Ollama klassifizieren" — aber die beiden EINGEHENDEN Kanten
// zeigten weiter auf „Gemini klassifizieren":
//
//     "Hat Anhang?"     → { "node": "Gemini klassifizieren" }
//     "Virus gefunden?" → { "node": "Gemini klassifizieren" }
//
// Diesen Knoten gibt es in diesen Dateien nicht. Der KI-Knoten hatte also gar
// keinen Eingang: Eine FRISCHE Ollama-Installation bekam einen Workflow 01,
// dessen KI nie eine Mail zu sehen bekommt. Kein Patcher-Schritt repariert das,
// und n8n meldet es auch nicht — eine Kante ins Leere ist dort einfach eine
// Kante, die nichts tut.
//
// Aufgefallen ist es nur, weil bei einer Bestandsinstallation aus der
// Gemini-Zeit der Knoten noch so hiess und deshalb alles lief.
//
// In n8n laufen Verbindungen ueber den NAMEN, nicht ueber die id
// (siehe knotenUmbenennen() in services/workflowPatcher.js). Ein umbenannter
// Knoten ohne nachgezogene Kanten ist damit immer ein stiller Abriss — genau
// das prueft diese Datei, fuer alle Vorlagen auf einmal.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ORDNER = path.resolve(__dirname, '../../../workflows');
const vorhanden = fs.existsSync(ORDNER);
// Im fertigen Docker-Abbild liegen die Vorlagen unter /app/workflows, nicht
// relativ zum Backend. Fehlen sie, wird uebersprungen statt Alarm geschlagen.
const nurImRepo = { skip: vorhanden ? false : 'Vorlagen nicht im Abbild' };

const dateien = vorhanden
  ? fs.readdirSync(ORDNER).filter((d) => d.endsWith('.json'))
  : [];

const laden = (d) => JSON.parse(fs.readFileSync(path.join(ORDNER, d), 'utf8'));

describe('Workflow-Vorlagen: Verbindungen zeigen auf vorhandene Knoten', () => {
  test('es gibt ueberhaupt Vorlagen', nurImRepo, () => {
    assert.ok(dateien.length >= 7, `nur ${dateien.length} Vorlagen gefunden`);
  });

  for (const datei of dateien) {
    test(`${datei}: keine Kante ins Leere`, nurImRepo, () => {
      const wf = laden(datei);
      const namen = new Set((wf.nodes || []).map((k) => k.name));
      const fehlend = [];

      for (const [quelle, ausgaenge] of Object.entries(wf.connections || {})) {
        // Auch der Ausgangspunkt einer Verbindung ist ein Knotenname.
        if (!namen.has(quelle)) fehlend.push(`${quelle} (als Quelle)`);
        for (const strang of Object.values(ausgaenge || {})) {
          for (const zweig of strang || []) {
            for (const ziel of zweig || []) {
              if (ziel && ziel.node && !namen.has(ziel.node)) {
                fehlend.push(`${quelle} → ${ziel.node}`);
              }
            }
          }
        }
      }

      assert.deepEqual(fehlend, [],
        'Verbindungen laufen in n8n ueber den Namen. Diese Ziele gibt es nicht: '
        + fehlend.join(', '));
    });

    test(`${datei}: Knotennamen sind eindeutig`, nurImRepo, () => {
      const wf = laden(datei);
      const gesehen = new Set();
      const doppelt = [];
      for (const k of wf.nodes || []) {
        if (gesehen.has(k.name)) doppelt.push(k.name);
        gesehen.add(k.name);
      }
      assert.deepEqual(doppelt, [],
        'Zwei Knoten mit demselben Namen: n8n kann Verbindungen dann nicht zuordnen');
    });
  }
});

describe('Die Ollama-Vorlagen sprechen nicht von Gemini', () => {
  const ollama = dateien.filter((d) => d.includes('-ollama.json'));

  test('es gibt Ollama-Fassungen', nurImRepo, () => {
    assert.ok(ollama.length >= 3, `nur ${ollama.length} Ollama-Vorlagen`);
  });

  for (const datei of ollama) {
    // Die Knoten-ids duerfen bleiben (sie sind intern und stehen in
    // Bestandsinstallationen ohnehin so drin) — der sichtbare Text nicht.
    // „Den Gemini-Schluessel eintragen" auf einem Notizzettel schickt den
    // Leser genau in die falsche Richtung.
    test(`${datei}: kein Gemini im sichtbaren Text`, nurImRepo, () => {
      const wf = laden(datei);
      const treffer = [];
      for (const k of wf.nodes || []) {
        if (/gemini/i.test(k.name || '')) treffer.push(`Knotenname: ${k.name}`);
        const inhalt = k.parameters?.content;      // Notizzettel
        if (typeof inhalt === 'string' && /gemini/i.test(inhalt)) {
          treffer.push(`Notiz in ${k.name}`);
        }
      }
      assert.deepEqual(treffer, [], treffer.join(', '));
    });
  }
});

// Beide Fassungen eines Paares muessen denselben Workflow-Namen tragen.
// Sonst legt basisSetup() beim Anbieterwechsel einen ZWEITEN Workflow neben
// den bestehenden — und der Digest kaeme doppelt.
describe('Gemini- und Ollama-Fassung tragen denselben Namen', () => {
  test('jedes Paar stimmt ueberein', nurImRepo, () => {
    const paare = dateien
      .filter((d) => d.includes('-gemini.json'))
      .map((g) => [g, g.replace('-gemini.json', '-ollama.json')]);
    assert.ok(paare.length >= 3, `nur ${paare.length} Paare gefunden`);
    for (const [g, o] of paare) {
      assert.ok(dateien.includes(o), `${o} fehlt zu ${g}`);
      assert.equal(laden(o).name, laden(g).name, `${g} und ${o} tragen verschiedene Namen`);
    }
  });
});
