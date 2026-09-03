// Steuerung der n8n-Workflows aus dem Panel heraus.
// Ziel: Die n8n-Oberfläche wird im Alltag nicht mehr gebraucht.
const express = require('express');
const n8n     = require('../services/n8n');
const patcher = require('../services/workflowPatcher');
const db      = require('../db');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// Fehler aus der n8n-Anbindung einheitlich beantworten
function fehlerAntwort(res, err, was) {
  loggen('error', 'backend:workflows', `${was}: ${err.message}`);
  res.status(502).json({ error: err.message });
}

// GET /api/workflows — Übersicht mit Status und letztem Lauf
router.get('/', async (req, res) => {
  try {
    const [workflows, executions] = await Promise.all([
      n8n.workflowsAuflisten(),
      n8n.executionsAuflisten(100).catch(() => []),
    ]);

    // Zu jedem Workflow den jüngsten Lauf heraussuchen
    const letzte = new Map();
    for (const e of executions) {
      const id = String(e.workflowId);
      if (!letzte.has(id)) letzte.set(id, e);
    }

    res.json(workflows.map((w) => {
      const lauf = letzte.get(String(w.id));
      return {
        id: w.id,
        name: w.name,
        aktiv: Boolean(w.active),
        aktualisiert: w.updatedAt,
        letzterLauf: lauf ? { status: lauf.status, zeitpunkt: lauf.startedAt } : null,
      };
    }));
  } catch (err) {
    fehlerAntwort(res, err, 'Workflows konnten nicht geladen werden');
  }
});

// GET /api/workflows/:id — Einzelheiten inklusive der vom Panel verwalteten Knoten
router.get('/:id', async (req, res) => {
  try {
    const w = await n8n.workflowHolen(req.params.id);
    res.json({
      id: w.id,
      name: w.name,
      aktiv: Boolean(w.active),
      knoten: w.nodes
        .filter((k) => k.type !== 'n8n-nodes-base.stickyNote')
        .map((k) => ({
          name: k.name,
          typ: k.type,
          stillgelegt: Boolean(k.disabled),
          // Knoten mit diesem Präfix erzeugt das Panel bei jedem Konto-Sync neu
          vomPanel: String(k.id || '').startsWith('panel-'),
          hatZugangsdaten: Boolean(k.credentials && Object.keys(k.credentials).length),
        })),
    });
  } catch (err) {
    fehlerAntwort(res, err, `Workflow ${req.params.id} konnte nicht geladen werden`);
  }
});

// POST /api/workflows/:id/aktiv — ein- oder ausschalten
router.post('/:id/aktiv', async (req, res) => {
  const { aktiv } = req.body || {};
  try {
    const w = await n8n.workflowAktivieren(req.params.id, Boolean(aktiv));
    // Der Aufsicht sagen, dass das so gewollt ist — sonst schaltet sie einen
    // bewusst abgeschalteten Workflow beim naechsten Takt wieder ein.
    require('../services/aufsicht').absichtMerken(req.params.id, Boolean(aktiv), w.name);
    res.json({ ok: true, aktiv: Boolean(w.active) });
  } catch (err) {
    // n8n nennt hier den Grund (fehlende Zugangsdaten, kein Trigger) — der hilft
    // dem Nutzer weiter und wird deshalb unverändert durchgereicht.
    fehlerAntwort(res, err, `Workflow ${req.params.id} umschalten`);
  }
});

// GET /api/workflows/:id/laeufe — die letzten Ausführungen mit Fehlermeldung
router.get('/:id/laeufe', async (req, res) => {
  try {
    const alle = await n8n.executionsAuflisten(100);
    const eigene = alle
      .filter((e) => String(e.workflowId) === String(req.params.id))
      .slice(0, 20)
      .map((e) => ({
        id: e.id,
        status: e.status,
        gestartet: e.startedAt,
        beendet: e.stoppedAt,
        modus: e.mode,
      }));
    res.json(eigene);
  } catch (err) {
    fehlerAntwort(res, err, 'Ausführungen konnten nicht geladen werden');
  }
});

// GET /api/workflows/lauf/:id — eine Ausführung im Detail (welcher Knoten scheiterte)
router.get('/lauf/:id', async (req, res) => {
  try {
    const { data } = await n8n.client().get(`/executions/${req.params.id}`, {
      params: { includeData: true },
    });
    let daten = data.data;
    if (typeof daten === 'string') { try { daten = JSON.parse(daten); } catch { daten = null; } }
    const runData = daten?.resultData?.runData || {};

    const knoten = Object.entries(runData).map(([name, laeufe]) => {
      const l = laeufe[0] || {};
      return {
        name,
        fehler: l.error ? String(l.error.message || l.error).slice(0, 500) : null,
        items: l.error ? 0 : (l.data?.main?.[0]?.length ?? 0),
      };
    });

    res.json({
      id: data.id,
      status: data.status,
      gestartet: data.startedAt,
      fehlermeldung: daten?.resultData?.error?.message || null,
      knoten,
    });
  } catch (err) {
    fehlerAntwort(res, err, 'Ausführung konnte nicht geladen werden');
  }
});

// POST /api/workflows/neu-importieren — fehlende Basis-Workflows nach n8n bringen
router.post('/neu-importieren', async (req, res) => {
  try {
    await patcher.basisSetup();
    const alle = await n8n.workflowsAuflisten();
    res.json({ ok: true, workflows: alle.length });
  } catch (err) {
    fehlerAntwort(res, err, 'Import der Basis-Workflows');
  }
});

// POST /api/workflows/sync — Konten neu verdrahten (gleiche Wirkung wie auf der Konten-Seite)
router.post('/sync', async (req, res) => {
  try {
    const konten = db.prepare('SELECT * FROM accounts WHERE aktiv = 1 ORDER BY id').all();
    res.json({ ok: true, sync: await patcher.alleSynchronisieren(konten) });
  } catch (err) {
    fehlerAntwort(res, err, 'Konten-Sync');
  }
});

module.exports = router;
