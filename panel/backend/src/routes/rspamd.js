const express = require('express');
const db      = require('../db');
const mailcow = require('../services/mailcow');

const router = express.Router();

// ─── 1. Policy (Whitelist / Blacklist) von Mailcow holen ───────────────────

router.get('/policy', async (req, res) => {
  try {
    // Ruft globale Policy-Listen (Whitelist, Blacklist) aus Mailcow ab
    const whitelistRes = await mailcow.client().get('/get/policy_bl_wl/whitelist');
    const blacklistRes = await mailcow.client().get('/get/policy_bl_wl/blacklist');
    
    // Hole Spam-Scores
    const scoresRes = await mailcow.client().get('/get/spam-score/all');

    res.json({
      whitelist: Array.isArray(whitelistRes.data) ? whitelistRes.data : [],
      blacklist: Array.isArray(blacklistRes.data) ? blacklistRes.data : [],
      scores: Array.isArray(scoresRes.data) ? scoresRes.data : [],
    });
  } catch (err) {
    if (err.message.includes('nicht eingerichtet')) {
      return res.json({ disabled: true });
    }
    res.status(500).json({ error: 'Mailcow API-Fehler: ' + err.message });
  }
});

// ─── 2. Panel-Whitelist nach Mailcow synchronisieren ──────────────────────

router.post('/sync', async (req, res) => {
  try {
    // 1. Lokale Panel-Whitelist laden (Whitelist schlägt alles -> 'Geniestreich', 'Wichtig', etc.)
    // Wir synchronisieren hier nur explizite Whitelist-Einträge
    const lokaleListen = db.prepare('SELECT absender, typ FROM lists WHERE typ = ?').all('whitelist');
    const panelWhitelist = lokaleListen.map(l => l.absender);

    if (panelWhitelist.length === 0) {
      return res.json({ success: true, count: 0, msg: 'Keine Whitelist-Einträge im Panel.' });
    }

    // 2. Bestehende Mailcow Whitelist abfragen, um Duplikate zu vermeiden
    const existierende = await mailcow.client().get('/get/policy_bl_wl/whitelist');
    const existierendeDomains = Array.isArray(existierende.data) 
      ? existierende.data.map(item => item.object) 
      : [];

    // 3. Neue Einträge berechnen (Domain oder E-Mail)
    const neue = panelWhitelist.filter(p => !existierendeDomains.includes(p));

    if (neue.length === 0) {
      return res.json({ success: true, count: 0, msg: 'Mailcow-Whitelist ist bereits auf dem neuesten Stand.' });
    }

    // 4. Zur Mailcow pushen (POST /api/v1/add/policy_bl_wl)
    // Laut Mailcow API: { "object": "domain.tld", "list": "wl_domain", "domain": "all" }
    // Da wir globale Listen wollen, verwenden wir "all" für die Ziel-Domain, oder spezifische Postfächer.
    // Für dieses Beispiel fügen wir die Absender-Adressen als globale Whitelist (`wl_sender`) hinzu
    // HINWEIS: Mailcow erwartet Objekte einzeln oder in Listen, die Doku variiert. Wir senden sie als Array-Items.
    
    // Einfache Umsetzung: jeden neuen Eintrag zur Mailcow senden
    let count = 0;
    for (const eintrag of neue) {
      const isDomain = !eintrag.includes('@');
      await mailcow.client().post('/add/policy_bl_wl', {
        object: eintrag,
        list: isDomain ? 'wl_domain' : 'wl_sender',
        domain: 'all' // Gilt für alle Mailcow-Domains
      });
      count++;
    }

    res.json({ success: true, count, msg: `${count} Einträge synchronisiert.` });
  } catch (err) {
    if (err.message.includes('nicht eingerichtet')) {
      return res.status(400).json({ error: 'Mailcow ist nicht eingerichtet.' });
    }
    res.status(500).json({ error: 'Sync-Fehler: ' + err.message });
  }
});

module.exports = router;
