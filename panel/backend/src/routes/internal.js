// Endpunkte fuer die n8n-Workflows (Header X-Panel-Secret, siehe middleware/internalAuth).
const express = require('express');
const db      = require('../db');
const listen  = require('../services/listen');
const dnsbl   = require('../services/dnsbl');
const safebrowsing = require('../services/safebrowsing');
const clamav  = require('../services/clamav');

const router = express.Router();

const einstellung = (key, fallback) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : fallback;
};

// Ein Aufruf prüft alles, was das Panel über eine Mail sagen kann.
// Reihenfolge ist bewusst: Whitelist gewinnt immer, dann Blacklist, dann DNSBL.
router.post('/check', async (req, res) => {
  const { von = '', ip = null, links = [] } = req.body || {};
  const ergebnis = {
    entscheidung: 'weiter',   // weiter | freigeben | quarantaene
    score_aufschlag: 0,
    // Der Workflow soll den im Panel eingestellten Schwellwert benutzen
    spam_schwellwert: Number(einstellung('spam_schwellwert', '0.8')),
    gruende: [],
    dnsbl_treffer: [],
  };

  try {
    const weiss = listen.pruefe(von, 'whitelist');
    if (weiss) {
      ergebnis.entscheidung = 'freigeben';
      ergebnis.gruende.push(`Whitelist: ${weiss}`);
      return res.json(ergebnis);
    }

    const schwarz = listen.pruefe(von, 'blacklist');
    if (schwarz) {
      ergebnis.entscheidung = 'quarantaene';
      ergebnis.score_aufschlag = 1;
      ergebnis.gruende.push(`Blacklist: ${schwarz}`);
      return res.json(ergebnis);
    }

    if (ip) {
      const listenNamen = JSON.parse(einstellung('dnsbl_listen', '[]'));
      const { treffer, nichtNutzbar } = await dnsbl.pruefeIp(ip, listenNamen);
      if (treffer.length > 0) {
        ergebnis.dnsbl_treffer = treffer;
        // Ein Treffer allein reicht nicht für die Quarantäne — er erhöht den
        // Score, den finale Bewertung trifft weiterhin die KI. Zwei oder mehr
        // Treffer sind ein deutliches Signal.
        ergebnis.score_aufschlag += treffer.length >= 2 ? 0.6 : 0.3;
        ergebnis.gruende.push(`DNSBL-Treffer (${ip}): ${treffer.join(', ')}`);
      }
      if (nichtNutzbar.length > 0) {
        ergebnis.hinweis = `Nicht abfragbar: ${nichtNutzbar.map((n) => `${n.liste} (${n.code})`).join(', ')}`;
      }
    }
    
    const safebrowsingAktiv = einstellung('safebrowsing_aktiv', '0') === '1';
    if (safebrowsingAktiv && links && links.length > 0) {
      const sbResult = await safebrowsing.pruefeLinks(links);
      if (!sbResult.clean) {
        ergebnis.score_aufschlag += 0.8;
        ergebnis.gruende.push(`Safe Browsing: Schädliche Links gefunden (${sbResult.treffer.join(', ')})`);
      }
    }

    res.json(ergebnis);
  } catch (err) {
    // Eine gescheiterte Prüfung darf die Mail-Verarbeitung nicht aufhalten
    res.json({ ...ergebnis, fehler: err.message });
  }
});

// Konfiguration fuer die Workflows (Schwellwerte, Listen)
router.get('/config', (req, res) => {
  res.json({
    spam_schwellwert: Number(einstellung('spam_schwellwert', '0.8')),
    dnsbl_listen: JSON.parse(einstellung('dnsbl_listen', '[]')),
    clamav_aktiv: einstellung('clamav_aktiv', '1') === '1',
    safebrowsing_aktiv: einstellung('safebrowsing_aktiv', '0') === '1',
  });
});

// Triage-Ergebnis aus Workflow 01/04 — fuellt Dashboard, Quarantaene-Tab und Newsletter-Seite
router.post('/log', (req, res) => {
  const b = req.body || {};
  if (!b.konto || !b.von) return res.status(400).json({ error: 'konto und von sind Pflicht' });
  db.prepare(`
    INSERT INTO quarantine_log (konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, list_unsubscribe, virus_name, dnsbl_treffer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(b.konto), String(b.von), b.betreff ?? null, b.kategorie ?? null,
    b.spam_score != null ? Number(b.spam_score) : null, b.zielordner ?? null,
    b.kurzfassung ?? null, b.list_unsubscribe ?? null, b.virus_name ?? null,
    b.dnsbl_treffer ? JSON.stringify(b.dnsbl_treffer) : null,
  );

  // Newsletter-Absender fuer die Abbestellen-Seite mitzaehlen
  if (b.kategorie === 'newsletter') {
    db.prepare(`
      INSERT INTO newsletter_senders (absender, anzahl, list_unsubscribe, zuletzt_gesehen)
      VALUES (?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(absender) DO UPDATE SET
        anzahl = anzahl + 1,
        list_unsubscribe = COALESCE(excluded.list_unsubscribe, list_unsubscribe),
        zuletzt_gesehen = CURRENT_TIMESTAMP
    `).run(String(b.von), b.list_unsubscribe ?? null);
  }
  res.json({ ok: true });
});

// Anhang an ClamAV senden
router.post('/scan', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ clean: true, fehler: 'Keine Datei gesendet' });
    }
    
    const ergebnis = await clamav.scan(req.body);
    res.json(ergebnis);
  } catch (err) {
    console.error('ClamAV Scan Fehler:', err.message);
    // Bei Fehlern (wie Timeout) lassen wir die Mail durch, um keine Mails zu blockieren
    res.json({ clean: true, fehler: err.message });
  }
});

module.exports = router;
