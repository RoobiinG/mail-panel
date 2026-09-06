// Steuerung der n8n-Workflows aus dem Panel heraus.
// Ziel: Die n8n-Oberfläche wird im Alltag nicht mehr gebraucht.
const express = require('express');
const n8n     = require('../services/n8n');
const patcher = require('../services/workflowPatcher');
const db      = require('../db');
const settings = require('../services/settings');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// Fehler aus der n8n-Anbindung einheitlich beantworten
function fehlerAntwort(res, err, was) {
  loggen('error', 'backend:workflows', `${was}: ${err.message}`);
  res.status(502).json({ error: err.message });
}

// POST /api/workflows/bestand-starten — die Bestands-Triage jetzt laufen lassen.
// n8ns öffentliche API kann keinen Workflow starten; deshalb hängt in Workflow 04
// ein Webhook, den nur das Panel auslösen kann (Header-Auth mit dem Panel-Secret).
router.post('/bestand-starten', async (req, res) => {
  const basis = String(settings.hole('n8n_url') || 'http://n8n:5678').replace(/\/$/, '');
  try {
    const antwort = await fetch(`${basis}/webhook/${patcher.BESTAND_WEBHOOK_PFAD}`, {
      method: 'POST',
      headers: { 'X-Panel-Secret': process.env.PANEL_SECRET || '', 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    });
    // 404 heisst hier fast immer: Der Haken steckt noch nicht im Workflow oder
    // Workflow 04 ist nicht aktiv — beides behebt der Nutzer selbst.
    if (antwort.status === 404) {
      return res.status(409).json({
        error: 'Der Start-Haken fehlt in Workflow 04. Einmal auf „Synchronisieren" drücken — und Workflow 04 muss aktiv sein.',
      });
    }
    if (!antwort.ok) return res.status(502).json({ error: `n8n antwortete mit ${antwort.status}.` });
    loggen('info', 'workflows', 'Bestands-Triage über das Panel gestartet.');
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `n8n nicht erreichbar: ${err.message}` });
  }
});

// GET /api/workflows — Übersicht mit Status und letztem Lauf
router.get('/', async (req, res) => {
  try {
    const [workflows, executions] = await Promise.all([
      n8n.workflowsAuflisten(),
      n8n.executionsAuflisten(100).catch(() => []),
    ]);

    // Zu jedem Workflow den jüngsten Lauf heraussuchen — und getrennt davon den,
    // der gerade läuft. Ein laufender Workflow ist nicht dasselbe wie der letzte:
    // Die Bestands-Triage arbeitet auch mal eine halbe Stunde, und in der Zeit
    // stand im Panel bisher nur das Ergebnis von vorgestern.
    const laeuftNoch = (e) => String(e.status) === 'running' || String(e.status) === 'new'
      || Boolean(e.startedAt && !e.stoppedAt);

    const letzte = new Map();
    const laufend = new Map();
    for (const e of executions) {
      const id = String(e.workflowId);
      if (!letzte.has(id)) letzte.set(id, e);
      if (laeuftNoch(e) && !laufend.has(id)) laufend.set(id, e);
    }

    res.json(workflows.map((w) => {
      const lauf = letzte.get(String(w.id));
      const jetzt = laufend.get(String(w.id));
      return {
        id: w.id,
        name: w.name,
        aktiv: Boolean(w.active),
        aktualisiert: w.updatedAt,
        letzterLauf: lauf ? { status: lauf.status, zeitpunkt: lauf.startedAt } : null,
        laeuft: jetzt ? { seit: jetzt.startedAt, ausfuehrung: jetzt.id, modus: jetzt.mode } : null,
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

// Wie lange lief eine Ausführung? Die Zahl steht schon in der Liste — sie musste
// nur ausgerechnet werden. Sie trennt zwei ganz verschiedene Fehlschläge: Ein
// Lauf über Minuten ist unterwegs gescheitert (meist an der KI), einer nach
// 60 ms ist gar nicht erst losgelaufen. In der Liste sah beides gleich aus.
function dauerVon(e) {
  const a = Date.parse(e.startedAt || '');
  const b = Date.parse(e.stoppedAt || '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

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
        dauerMs: dauerVon(e),
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

    // Scheitert ein Lauf, bevor der erste Knoten Daten liefert, ist runData leer
    // und die Meldung steckt woanders. Vorher stand dann eine leere Karte da —
    // ausgerechnet bei den Fehlschlägen, die man am wenigsten versteht. Deshalb
    // hier alle Stellen abklappern, an denen n8n den Grund ablegt.
    const fehler = daten?.resultData?.error || {};
    const meldung = fehler.message || fehler.description
      || (typeof daten?.resultData?.error === 'string' ? daten.resultData.error : null)
      || null;

    res.json({
      id: data.id,
      status: data.status,
      gestartet: data.startedAt,
      dauerMs: dauerVon(data),
      // Welcher Knoten zuletzt lief — bei einem Absturz ganz am Anfang steht
      // hier der Trigger, und genau das ist die Auskunft, die fehlte.
      letzterKnoten: daten?.resultData?.lastNodeExecuted || fehler.node?.name || null,
      fehlermeldung: meldung,
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

// POST /api/workflows/zugangsdaten-erneuern — Merkzettel leeren und neu anlegen
//
// Für den Fall, dass in n8n ein Credential von Hand gelöscht wurde oder n8n neu
// aufgesetzt ist: Dann zeigt die gemerkte ID ins Leere, und n8n bricht jeden
// Lauf ab mit „Credential with ID ... does not exist". Nachsehen kann das Panel
// nicht — die n8n-API kennt kein GET auf Credentials. Also vergisst es die IDs
// und legt beim folgenden Sync frische an.
router.post('/zugangsdaten-erneuern', async (req, res) => {
  try {
    patcher.zugangsdatenVergessen();
    const konten = db.prepare('SELECT * FROM accounts WHERE aktiv = 1 ORDER BY id').all();
    const sync = await patcher.alleSynchronisieren(konten);
    loggen('info', 'workflows', 'Zugangsdaten in n8n neu angelegt');
    res.json({
      ok: true,
      sync,
      hinweis: 'Neue Zugangsdaten angelegt und in alle Workflows eingetragen. Die alten '
        + 'bleiben in n8n stehen — sie lassen sich dort gefahrlos löschen.',
    });
  } catch (err) {
    fehlerAntwort(res, err, 'Zugangsdaten erneuern');
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
