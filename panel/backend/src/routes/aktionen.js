// Eigene Aktionen: anlegen, prüfen, in n8n bauen.
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db      = require('../db');
const schema  = require('../services/aktionenSchema');
const ki      = require('../services/aktionenKi');
const patcher = require('../services/aktionenPatcher');
const { pruefeUrl } = require('../services/urlSchutz');
const { loggen } = require('../services/panelLog');

const router = express.Router();

const ausDb = (a) => ({
  ...a,
  aktiv: Boolean(a.aktiv),
  bedingung: JSON.parse(a.bedingung || '{}'),
  konfig: JSON.parse(a.konfig || '{}'),
});

// Webhook-Ziele dürfen nicht ins eigene Netz zeigen (gleiche Regel wie beim
// Abmelde-Link) — sonst wäre die Aktion ein Werkzeug für Anfragen nach innen.
async function zielPruefen(aktion) {
  if (aktion.typ !== 'webhook') return null;
  try {
    await pruefeUrl(aktion.konfig.url);
    return null;
  } catch (err) {
    return err.message;
  }
}

// GET /api/aktionen/schema — Felder, Vergleiche und Typen für die Oberfläche
router.get('/schema', (req, res) => res.json(schema.beschreibung()));

// GET /api/aktionen
router.get('/', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM aktionen ORDER BY id').all().map(ausDb));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jeder Entwurf kostet eine Gemini-Anfrage. Das Freikontingent ist am Tag
// begrenzt, deshalb eine Obergrenze pro Panel-Benutzer.
const entwurfLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Angemeldete Nutzer zaehlen ueber ihre ID. Faellt die aus, zaehlt die
  // Adresse — dann aber ueber ipKeyGenerator. Ohne ihn bekaeme jede einzelne
  // IPv6-Adresse einen eigenen Zaehler, und wer ein Praefix hat (die meisten
  // Anschluesse), koennte die Bremse durch Adresswechsel beliebig umgehen.
  // Der Helfer fasst ein ganzes /56 zu einem Schluessel zusammen.
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: { ok: false, fehler: 'Zu viele Entwürfe hintereinander — bitte kurz warten.' },
});

// POST /api/aktionen/entwurf — Beschreibung von der KI in eine Regel übersetzen
router.post('/entwurf', entwurfLimiter, async (req, res) => {
  const ergebnis = await ki.entwurfBauen(req.body?.beschreibung);
  if (!ergebnis.ok) return res.status(400).json(ergebnis);
  res.json(ergebnis);
});

// POST /api/aktionen — Regel speichern und in n8n bauen
router.post('/', async (req, res) => {
  const geprueft = schema.pruefe(req.body);
  if (!geprueft.ok) return res.status(400).json({ fehler: geprueft.fehler });

  const zielFehler = await zielPruefen(geprueft.aktion);
  if (zielFehler) return res.status(400).json({ fehler: [zielFehler] });

  try {
    const a = geprueft.aktion;
    const info = db.prepare(`
      INSERT INTO aktionen (name, beschreibung, bedingung, typ, konfig, erstellt_von)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(a.name, a.beschreibung, JSON.stringify(a.bedingung), a.typ, JSON.stringify(a.konfig), req.user.id);

    const sync = await patcher.synchronisieren();
    res.json({ ok: true, id: info.lastInsertRowid, sync });
  } catch (err) {
    loggen('error', 'backend:aktionen', `Anlegen fehlgeschlagen: ${err.message}`);
    res.status(502).json({ fehler: [err.message] });
  }
});

// PUT /api/aktionen/:id — ändern oder ein-/ausschalten
router.put('/:id', async (req, res) => {
  const vorhanden = db.prepare('SELECT * FROM aktionen WHERE id = ?').get(req.params.id);
  if (!vorhanden) return res.status(404).json({ fehler: ['Aktion nicht gefunden.'] });

  // Nur den Schalter umlegen
  if (Object.keys(req.body || {}).length === 1 && 'aktiv' in req.body) {
    db.prepare('UPDATE aktionen SET aktiv = ? WHERE id = ?').run(req.body.aktiv ? 1 : 0, vorhanden.id);
    try {
      return res.json({ ok: true, sync: await patcher.synchronisieren() });
    } catch (err) {
      return res.status(502).json({ fehler: [err.message] });
    }
  }

  const geprueft = schema.pruefe(req.body);
  if (!geprueft.ok) return res.status(400).json({ fehler: geprueft.fehler });
  const zielFehler = await zielPruefen(geprueft.aktion);
  if (zielFehler) return res.status(400).json({ fehler: [zielFehler] });

  try {
    const a = geprueft.aktion;
    db.prepare(`
      UPDATE aktionen SET name = ?, beschreibung = ?, bedingung = ?, typ = ?, konfig = ?
      WHERE id = ?
    `).run(a.name, a.beschreibung, JSON.stringify(a.bedingung), a.typ, JSON.stringify(a.konfig), vorhanden.id);
    res.json({ ok: true, sync: await patcher.synchronisieren() });
  } catch (err) {
    res.status(502).json({ fehler: [err.message] });
  }
});

// DELETE /api/aktionen/:id
router.delete('/:id', async (req, res) => {
  const info = db.prepare('DELETE FROM aktionen WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ fehler: ['Aktion nicht gefunden.'] });
  try {
    res.json({ ok: true, sync: await patcher.synchronisieren() });
  } catch (err) {
    res.status(502).json({ fehler: [err.message] });
  }
});

// POST /api/aktionen/sync — Workflow 07 neu aufbauen
router.post('/sync', async (req, res) => {
  try {
    res.json({ ok: true, sync: await patcher.synchronisieren() });
  } catch (err) {
    res.status(502).json({ fehler: [err.message] });
  }
});

module.exports = router;
