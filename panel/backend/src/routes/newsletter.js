const express = require('express');
const db = require('../db');
const { sichererAbruf } = require('../services/urlSchutz');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// Liefert alle Newsletter-Absender
router.get('/', (req, res) => {
  try {
    const senders = db.prepare(`
      SELECT * FROM newsletter_senders 
      ORDER BY anzahl DESC, zuletzt_gesehen DESC
    `).all();
    res.json(senders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Meldet einen Newsletter ab
router.post('/unsubscribe', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id fehlt' });

  try {
    const sender = db.prepare('SELECT * FROM newsletter_senders WHERE id = ?').get(id);
    if (!sender) return res.status(404).json({ error: 'Absender nicht gefunden' });
    if (!sender.list_unsubscribe) return res.status(400).json({ error: 'Kein List-Unsubscribe Header vorhanden' });

    // Header parsen: Kann `<https://...>, <mailto:...>` sein
    const links = sender.list_unsubscribe.match(/<([^>]+)>/g)?.map(l => l.slice(1, -1)) || [];
    
    let erfolg = false;
    let methode = '';
    let hinweis = null;

    // Bevorzugt HTTPS One-Click (RFC 8058).
    // Die Adresse stammt aus der Mail und damit vom Absender — sie wird deshalb
    // erst geprüft (kein eigenes Netz, kein fremdes Schema, mit Zeitlimit).
    const httpLink = links.find(l => l.startsWith('http://') || l.startsWith('https://'));
    if (httpLink) {
      methode = 'http';
      try {
        const response = await sichererAbruf(httpLink, { method: 'POST' });
        if (response.ok) {
          erfolg = true;
        } else {
          // Manche Anbieter setzen One-Click nicht sauber um — dann per GET versuchen
          const getResponse = await sichererAbruf(httpLink);
          erfolg = getResponse.ok;
        }
      } catch (err) {
        hinweis = err.message;
        loggen('warn', 'backend:newsletter',
          `Abmelde-Link von ${sender.absender} nicht aufgerufen: ${err.message}`, { requestUrl: httpLink });
      }
    }
    
    // Fallback auf mailto, falls kein HTTP Link vorhanden oder HTTP fehlschlug
    if (!erfolg) {
      const mailtoLink = links.find(l => l.startsWith('mailto:'));
      if (mailtoLink) {
        methode = 'mailto';
        // Wir übergeben das an Workflow 06 in n8n per Webhook.
        // Diese Adresse stammt aus unserer eigenen Konfiguration, nicht aus der
        // Mail — sie braucht deshalb keine Zielprüfung, wohl aber ein Zeitlimit.
        const n8nUrl = process.env.N8N_URL || 'http://n8n:5678';
        try {
          const response = await fetch(`${n8nUrl}/webhook/panel-unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              absender: sender.absender,
              mailto: mailtoLink,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (response.ok) {
            erfolg = true;
          } else {
            hinweis = `n8n antwortete mit ${response.status} — läuft Workflow 06?`;
          }
        } catch (err) {
          hinweis = hinweis || err.message;
          loggen('warn', 'backend:newsletter', `mailto-Abmeldung über n8n fehlgeschlagen: ${err.message}`);
        }
      }
    }

    if (erfolg) {
      db.prepare('UPDATE newsletter_senders SET abbestellt_am = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      res.json({ success: true, methode });
    } else {
      res.status(502).json({
        error: hinweis
          ? `Abbestellen nicht möglich: ${hinweis}`
          : 'Abbestellen fehlgeschlagen — der Anbieter hat den Abmelde-Link abgelehnt.',
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
