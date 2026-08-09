const express = require('express');
const db = require('../db');

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

    // Bevorzugt HTTPS One-Click (RFC 8058)
    const httpLink = links.find(l => l.startsWith('http://') || l.startsWith('https://'));
    if (httpLink) {
      methode = 'http';
      try {
        const response = await fetch(httpLink, { method: 'POST' });
        if (response.ok) {
          erfolg = true;
        } else {
          // Fallback auf GET, da manche Systeme One-Click nicht 100% sauber umsetzen
          const getResponse = await fetch(httpLink);
          erfolg = getResponse.ok;
        }
      } catch (err) {
        console.error('Fehler beim HTTP Unsubscribe:', err);
      }
    } 
    
    // Fallback auf mailto, falls kein HTTP Link vorhanden oder HTTP fehlschlug
    if (!erfolg) {
      const mailtoLink = links.find(l => l.startsWith('mailto:'));
      if (mailtoLink) {
        methode = 'mailto';
        // Wir übergeben das an Workflow 06 in n8n per Webhook
        const n8nUrl = process.env.N8N_URL || 'http://n8n:5678';
        try {
          const response = await fetch(`${n8nUrl}/webhook/panel-unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              absender: sender.absender, 
              mailto: mailtoLink 
            })
          });
          if (response.ok) {
            erfolg = true;
          }
        } catch (err) {
          console.error('Fehler beim n8n mailto Webhook:', err);
        }
      }
    }

    if (erfolg) {
      db.prepare('UPDATE newsletter_senders SET abbestellt_am = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      res.json({ success: true, methode });
    } else {
      res.status(500).json({ error: 'Abbestellen fehlgeschlagen (weder HTTP noch n8n-Webhook waren erfolgreich).' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
