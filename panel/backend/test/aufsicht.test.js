// Die Aufsicht — der Wächter, der es merkt, wenn nichts mehr passiert.
//
// Nachgestellt wird genau der Fall vom 2026-09-02: Ein Postfach war nicht
// erreichbar, n8n rollte deshalb die Aktivierung des ganzen Workflows zurück,
// und die Sortierung stand sechs Tage still, ohne dass jemand es erfuhr.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

// n8n wird ersetzt, nicht befragt: Ein Test, der eine laufende n8n-Instanz
// braucht, läuft in der CI nicht — und schützt damit vor nichts.
const n8nPfad = require.resolve('../src/services/n8n');
const n8nStub = {
  workflows: [],
  eingeschaltet: [],
  fehlerBeimAuflisten: null,
  fehlerBeimSchalten: null,
  async workflowsAuflisten() {
    if (n8nStub.fehlerBeimAuflisten) throw new Error(n8nStub.fehlerBeimAuflisten);
    return n8nStub.workflows;
  },
  async workflowAktivieren(id, aktiv) {
    if (n8nStub.fehlerBeimSchalten) throw new Error(n8nStub.fehlerBeimSchalten);
    n8nStub.eingeschaltet.push({ id, aktiv });
    const w = n8nStub.workflows.find((x) => String(x.id) === String(id));
    if (w) w.active = aktiv;
    return w || { id, active: aktiv };
  },
};
require.cache[n8nPfad] = {
  id: n8nPfad, filename: n8nPfad, loaded: true, children: [], paths: [], exports: n8nStub,
};

const db = require('../src/db');
const aufsicht = require('../src/services/aufsicht');

const WF = (id, name, active) => ({ id, name, active });

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'aufsicht_%'").run();
  n8nStub.workflows = [
    WF('a1', '01 - Inbox-Triage', true),
    WF('a2', '02 - Digest', true),
    WF('a3', 'ZZ Testkram', false),
  ];
  n8nStub.eingeschaltet = [];
  n8nStub.fehlerBeimAuflisten = null;
  n8nStub.fehlerBeimSchalten = null;
});

describe('Soll-Zustand', () => {
  test('beim ersten Lauf gilt, was gerade läuft', async () => {
    const erg = await aufsicht.pruefen({ reparieren: false });
    assert.equal(erg.ok, true, 'am Anfang ist alles in Ordnung');
    const karte = aufsicht.soll();
    assert.equal(karte.a1.aktiv, true);
    assert.equal(karte.a3.aktiv, false, 'was aus ist, soll aus bleiben');
  });

  test('bewusst Abgeschaltetes wird nicht angemahnt', async () => {
    await aufsicht.pruefen({ reparieren: false });     // Soll aufnehmen
    aufsicht.absichtMerken('a1', false, '01 - Inbox-Triage');
    n8nStub.workflows[0].active = false;

    const erg = await aufsicht.pruefen({ reparieren: false });
    assert.equal(erg.ok, true, 'wer selbst abschaltet, will keine Mahnung');
    assert.deepEqual(erg.abweichungen, []);
  });
});

describe('Der Ausfall vom 2026-09-02', () => {
  // n8n schaltet den Workflow ab, weil EIN Postfach nicht erreichbar ist.
  test('wird erkannt', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.workflows[0].active = false;               // n8n hat abgeschaltet

    const erg = await aufsicht.pruefen({ reparieren: false });
    assert.equal(erg.ok, false);
    assert.equal(erg.abweichungen.length, 1);
    assert.equal(erg.abweichungen[0].art, 'inaktiv');
    assert.match(erg.abweichungen[0].text, /01 - Inbox-Triage/);
    assert.match(erg.abweichungen[0].text, /sollte laufen/);
  });

  test('wird von selbst behoben, statt 24 Stunden zu warten', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.workflows[0].active = false;

    const erg = await aufsicht.pruefen({ reparieren: true });
    assert.deepEqual(n8nStub.eingeschaltet, [{ id: 'a1', aktiv: true }]);
    assert.deepEqual(erg.repariert, ['01 - Inbox-Triage']);
    assert.equal(erg.ok, true, 'behoben zählt nicht mehr als Störung');
  });

  // Das Wertvollste an einem gescheiterten Versuch ist n8ns Begründung:
  // "ENOTFOUND dovecot" sagt genau, welches Postfach klemmt.
  test('scheitert das Einschalten, wird der Grund festgehalten', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.workflows[0].active = false;
    n8nStub.fehlerBeimSchalten = 'getaddrinfo ENOTFOUND dovecot';

    const erg = await aufsicht.pruefen({ reparieren: true });
    assert.equal(erg.ok, false, 'nicht behoben heißt nicht in Ordnung');
    assert.equal(erg.repariert.length, 0);
    assert.match(erg.abweichungen[0].grund, /ENOTFOUND dovecot/);
  });

  test('ein verschwundener Workflow fällt auf', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.workflows = n8nStub.workflows.filter((w) => w.id !== 'a1');

    const erg = await aufsicht.pruefen({ reparieren: false });
    assert.equal(erg.ok, false);
    assert.equal(erg.abweichungen[0].art, 'weg');
    assert.match(erg.abweichungen[0].text, /gibt es in n8n nicht mehr/);
  });
});

describe('n8n selbst weg', () => {
  test('ist der schwerste Fall und wird als solcher gemeldet', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.fehlerBeimAuflisten = 'connect ECONNREFUSED 172.18.0.2:5678';

    const erg = await aufsicht.pruefen({ reparieren: false });
    assert.equal(erg.ok, false);
    assert.equal(erg.n8nErreichbar, false);
    assert.match(erg.fehler, /ECONNREFUSED/);
  });

  test('der Soll-Zustand geht dabei nicht verloren', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.fehlerBeimAuflisten = 'weg';
    await aufsicht.pruefen({ reparieren: false });
    assert.equal(aufsicht.soll().a1.aktiv, true, 'sonst wäre nach einem Ausfall alles vergessen');
  });
});

describe('Der Befund wird aufbewahrt', () => {
  test('letzterLauf() liefert, was das Dashboard zeigt', async () => {
    await aufsicht.pruefen({ reparieren: false });
    n8nStub.workflows[0].active = false;
    await aufsicht.pruefen({ reparieren: false });

    const l = aufsicht.letzterLauf();
    assert.equal(l.ok, false);
    assert.equal(l.abweichungen.length, 1);
    assert.ok(l.zeitpunkt, 'ohne Zeitpunkt weiß niemand, wie alt der Befund ist');
  });
});
