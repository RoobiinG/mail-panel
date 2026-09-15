const express = require('express');
const db = require('../db');
const uebersicht = require('../services/uebersicht');

const router = express.Router();

router.get('/stats', (req, res) => {
  try {
    const konto = req.query.konto;
    
    let logs;
    if (konto) {
      logs = db.prepare(`
        SELECT kategorie, virus_name, zielordner, date(created_at) as tag 
        FROM quarantine_log 
        WHERE created_at >= date('now', '-30 days') AND konto = ?
      `).all(konto);
    } else {
      logs = db.prepare(`
        SELECT kategorie, virus_name, zielordner, date(created_at) as tag 
        FROM quarantine_log 
        WHERE created_at >= date('now', '-30 days')
      `).all();
    }
    
    // Hole Liste der verfügbaren Konten für den Filter
    const kontenRows = db.prepare(`
      SELECT DISTINCT konto FROM quarantine_log 
      WHERE created_at >= date('now', '-30 days') 
      ORDER BY konto
    `).all();
    const verfuegbareKonten = kontenRows.map(r => r.konto);

    const stats = {
      total: logs.length,
      spam: 0,
      phishing: 0,
      viren: 0,
      newsletter: 0,
      whitelist: 0,
    };

    // Tages-Aggregation für das Bar-Chart
    const historyMap = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const tag = d.toISOString().split('T')[0];
      historyMap[tag] = { tag, Spam: 0, Viren: 0, Clean: 0, Phishing: 0, Newsletter: 0 };
    }

    logs.forEach(log => {
      // Globale Summen
      if (log.virus_name) stats.viren++;
      else if (log.kategorie === 'spam') stats.spam++;
      else if (log.kategorie === 'phishing') stats.phishing++;
      else if (log.kategorie === 'newsletter') stats.newsletter++;
      else {
        stats.whitelist++; // bzw. "Clean" (beinhaltet jetzt alle korrekt sortierten Themen wie Rechnungen, etc.)
      }

      // Tages-Verlauf
      if (historyMap[log.tag]) {
        if (log.virus_name) historyMap[log.tag].Viren++;
        else if (log.kategorie === 'spam') historyMap[log.tag].Spam++;
        else if (log.kategorie === 'phishing') historyMap[log.tag].Phishing++;
        else if (log.kategorie === 'newsletter') historyMap[log.tag].Newsletter++;
        else historyMap[log.tag].Clean++;
      }
    });

    res.json({
      summen: stats,
      history: Object.values(historyMap),
      konten: verfuegbareKonten
    });
  } catch (err) {
    console.error('DASHBOARD STATS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// Alles fürs Dashboard an einer Stelle — Posteingangs-Rückstand, KI-Budget,
// Aufsicht, Sicherung, Trefferquote. Siehe services/uebersicht.js.
router.get('/uebersicht', async (req, res) => {
  try {
    res.json(await uebersicht.laden({ mitPosteingang: req.query.leicht !== '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/n8n-status', async (req, res) => {
  try {
    const n8nUrl = process.env.N8N_URL || 'http://n8n:5678';
    // Holt den Status von n8n (ob es erreichbar ist)
    // Der API-Key steht in den Panel-Einstellungen; die Env-Variable ist nur
    // noch der optionale Vorrang. Zeitlimit, damit die Seite nicht haengt.
    const settings = require('../services/settings');
    const response = await fetch(`${n8nUrl}/api/v1/workflows`, {
      headers: { 'X-N8N-API-KEY': settings.hole('n8n_api_key') || '' },
      signal: AbortSignal.timeout(8000),
    });
    
    if (response.ok) {
      const data = await response.json();
      const activeCount = data.data ? data.data.filter(w => w.active).length : 0;
      res.json({ online: true, activeWorkflows: activeCount });
    } else {
      res.json({ online: false, error: response.statusText });
    }
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

// ─── Anordnung der Dashboard-Widgets ─────────────────────────────────────────
//
// Jeder Benutzer schiebt sich sein Dashboard selbst zurecht, deshalb hängt die
// Anordnung an der Benutzer-ID und nicht an den Einstellungen. Gespeichert wird
// das Format von react-grid-layout.
//
// Was hier ankommt, kommt aus dem Browser — also wird es nicht einfach
// weggeschrieben. `saeubern()` lässt nur die bekannten Felder durch, zwingt sie
// in sinnvolle Grenzen und deckelt die Anzahl. Sonst stünde in der Datenbank
// genau das, was jemand in den Aufruf schreibt, und das Dashboard würde es beim
// nächsten Laden wieder ausführen.
const LAYOUT_MAX = 40;

function zahl(wert, min, max, ersatz) {
  const n = Math.round(Number(wert));
  if (!Number.isFinite(n)) return ersatz;
  return Math.max(min, Math.min(max, n));
}

function saeubern(liste) {
  if (!Array.isArray(liste)) return null;
  const gesehen = new Set();
  const raus = [];
  for (const roh of liste.slice(0, LAYOUT_MAX)) {
    if (!roh || typeof roh !== 'object') continue;
    const id = String(roh.i || '');
    // Kennungen sind Widget-Namen aus dem Katalog: kurz, ohne Sonderzeichen.
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || gesehen.has(id)) continue;
    gesehen.add(id);
    const eintrag = {
      i: id,
      x: zahl(roh.x, 0, 11, 0),
      y: zahl(roh.y, 0, 999, 0),
      w: zahl(roh.w, 1, 12, 4),
      h: zahl(roh.h, 1, 60, 4),
      minW: zahl(roh.minW, 1, 12, 2),
      minH: zahl(roh.minH, 1, 60, 2),
    };
    if (roh.versteckt === true) eintrag.versteckt = true;
    raus.push(eintrag);
  }
  return raus;
}

router.get('/layout', (req, res) => {
  try {
    const zeile = db.prepare('SELECT layout FROM dashboard_layouts WHERE user_id = ?').get(req.user.id);
    res.json({ layout: zeile ? JSON.parse(zeile.layout) : null });
  } catch {
    // Eine kaputte Zeile darf das Dashboard nicht blockieren — dann eben Standard.
    res.json({ layout: null });
  }
});

router.put('/layout', (req, res) => {
  const layout = saeubern(req.body?.layout);
  if (!layout) return res.status(400).json({ error: 'layout muss eine Liste sein' });
  try {
    db.prepare(`
      INSERT INTO dashboard_layouts (user_id, layout, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, JSON.stringify(layout));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
