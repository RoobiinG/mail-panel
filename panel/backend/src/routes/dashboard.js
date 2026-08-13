const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/stats', (req, res) => {
  try {
    // Hole alle Logs der letzten 30 Tage
    const logs = db.prepare(`
      SELECT kategorie, virus_name, zielordner, date(created_at) as tag 
      FROM quarantine_log 
      WHERE created_at >= date('now', '-30 days')
    `).all();

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
      historyMap[tag] = { tag, Spam: 0, Viren: 0, Clean: 0, Phishing: 0 };
    }

    logs.forEach(log => {
      // Globale Summen
      if (log.virus_name) stats.viren++;
      else if (log.kategorie === 'spam') stats.spam++;
      else if (log.kategorie === 'phishing') stats.phishing++;
      else if (log.kategorie === 'newsletter') stats.newsletter++;
      else if (log.zielordner === 'INBOX' && (log.kategorie === 'clean' || log.kategorie === 'Geniestreich' || log.kategorie === 'Wichtig')) {
        stats.whitelist++; // bzw. "Clean"
      }

      // Tages-Verlauf
      if (historyMap[log.tag]) {
        if (log.virus_name) historyMap[log.tag].Viren++;
        else if (log.kategorie === 'spam') historyMap[log.tag].Spam++;
        else if (log.kategorie === 'phishing') historyMap[log.tag].Phishing++;
        else historyMap[log.tag].Clean++;
      }
    });

    res.json({
      summen: stats,
      history: Object.values(historyMap)
    });
  } catch (err) {
    console.error('DASHBOARD STATS ERROR:', err);
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

module.exports = router;
