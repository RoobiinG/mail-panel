// Aufsicht über die Workflows: Stand abfragen, von Hand prüfen, einstellen.
const express = require('express');
const settings = require('../services/settings');
const aufsicht = require('../services/aufsicht');

const router = express.Router();

router.get('/', (req, res) => {
  const e = aufsicht.einstellungen();
  res.json({
    ...e,
    soll: aufsicht.soll(),
    letzterLauf: aufsicht.letzterLauf(),
  });
});

// Von Hand prüfen — die Antwort ist derselbe Bericht wie beim Zeitplan.
router.post('/pruefen', async (req, res) => {
  try {
    res.json(await aufsicht.pruefen({
      reparieren: (req.body || {}).reparieren,
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const SCHALTER = {
  aufsicht_aktiv: 'aktiv',
  aufsicht_reparieren: 'reparieren',
  aufsicht_takt: 'taktMinuten',
};

router.post('/', (req, res) => {
  const b = req.body || {};
  try {
    for (const [key, feld] of Object.entries(SCHALTER)) {
      if (b[feld] === undefined) continue;
      settings.setze(key, typeof b[feld] === 'boolean' ? (b[feld] ? '1' : '0') : String(b[feld]).trim());
    }
    // Der Takt wirkt erst beim nächsten Start der Uhr — also gleich neu stellen.
    aufsicht.zeitplanStarten();
    res.json({ ok: true, ...aufsicht.einstellungen() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Den Soll-Zustand neu aufnehmen: "was jetzt läuft, ist ab sofort richtig".
// Gedacht für den Fall, dass jemand in n8n selbst etwas umgestellt hat.
router.post('/uebernehmen', async (req, res) => {
  try {
    const n8n = require('../services/n8n');
    const karte = aufsicht.ersteAufnahme(await n8n.workflowsAuflisten());
    res.json({ ok: true, soll: karte });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
