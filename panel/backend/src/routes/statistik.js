const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/internal/statistik
router.get('/', (req, res) => {
  try {
    // 1. Quarantäne Logs (Kategorien pro Konto)
    const qLog = db.prepare(`
      SELECT konto, kategorie, COUNT(*) as anzahl
      FROM quarantine_log
      GROUP BY konto, kategorie
    `).all();

    // 2. Sort Inbox (Status pro Konto)
    const sInbox = db.prepare(`
      SELECT konto, status, COUNT(*) as anzahl
      FROM sort_inbox
      GROUP BY konto, status
    `).all();

    // 3. Bestands Triage (Erledigt pro Konto)
    const bestand = db.prepare(`
      SELECT a.name as konto, COUNT(b.uid) as anzahl
      FROM accounts a
      LEFT JOIN bestand_erledigt b ON a.id = b.konto_id
      GROUP BY a.id
    `).all();

    // 4. Eigene Regeln (Treffer pro Konto)
    const regeln = db.prepare(`
      SELECT a.name as konto, SUM(r.treffer) as treffer
      FROM accounts a
      LEFT JOIN sort_rules r ON a.id = r.konto_id
      GROUP BY a.id
    `).all();

    // Transformiere Daten in ein frontend-freundliches Format:
    // Ein Array von Konten, jedes mit seinen Statistiken.
    const kontenStats = {};

    const getKonto = (name) => {
      if (!name) name = 'Unbekannt';
      if (!kontenStats[name]) {
        kontenStats[name] = {
          name,
          kategorien: { clean: 0, spam: 0, phishing: 0, newsletter: 0, sonstiges: 0 },
          sortInbox: { offen: 0, zugeordnet: 0, ignoriert: 0 },
          bestandErledigt: 0,
          regelTreffer: 0,
          gesamtMails: 0
        };
      }
      return kontenStats[name];
    };

    // quarantine_log verarbeiten
    for (const row of qLog) {
      const k = getKonto(row.konto);
      const cat = (row.kategorie || '').toLowerCase();
      if (['clean', 'spam', 'phishing', 'newsletter'].includes(cat)) {
        k.kategorien[cat] += row.anzahl;
      } else {
        k.kategorien.sonstiges += row.anzahl;
      }
      k.gesamtMails += row.anzahl;
    }

    // sort_inbox verarbeiten
    for (const row of sInbox) {
      const k = getKonto(row.konto);
      const status = row.status || 'offen';
      if (k.sortInbox[status] !== undefined) {
        k.sortInbox[status] += row.anzahl;
      }
    }

    // bestand_erledigt verarbeiten
    for (const row of bestand) {
      const k = getKonto(row.konto);
      k.bestandErledigt += row.anzahl;
    }

    // sort_rules verarbeiten
    for (const row of regeln) {
      const k = getKonto(row.konto);
      k.regelTreffer += row.treffer || 0;
    }

    res.json({ ok: true, konten: Object.values(kontenStats) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
