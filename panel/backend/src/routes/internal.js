// Endpunkte fuer die n8n-Workflows (Header X-Panel-Secret, siehe middleware/internalAuth).
const express = require('express');
const db      = require('../db');
const listen  = require('../services/listen');
const dnsbl   = require('../services/dnsbl');
const safebrowsing = require('../services/safebrowsing');
const clamav  = require('../services/clamav');
const google  = require('../services/google');
const sortierung = require('../services/sortierung');
const imap    = require('../services/imap');
const { entschluesseln } = require('../services/crypto');

const router = express.Router();

const einstellung = (key, fallback) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : fallback;
};

// ─── SORTIERUNG (VOR GEMINI) ─────────────────────────────────────────────────
router.post('/sort', (req, res) => {
  const { konto, von, betreff, uid } = req.body || {};
  if (!konto || !von) return res.status(400).json({ error: 'konto und von sind Pflicht' });

  try {
    // Finde konto_id
    const account = db.prepare('SELECT id FROM accounts WHERE name = ?').get(konto);
    if (account) {
      const match = sortierung.pruefeRegeln(account.id, von, betreff);
      if (match) {
        return res.json({ aktion: 'verschieben', ordner: match.ordner });
      }
      // Kein Match -> ab in die Sortier-Inbox
      db.prepare(`
        INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid)
        VALUES (?, ?, ?, ?, ?)
      `).run(konto, account.id, von, betreff || null, uid || null);
    }
    res.json({ aktion: 'inbox' });
  } catch (err) {
    res.json({ aktion: 'inbox', fehler: err.message }); // Fehler blockieren den Mail-Fluss nicht
  }
});

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

// Scannt alle Anhänge einer Mail. Der Workflow schickt nur Konto, UID und Ordner —
// das Panel holt die Dateien selbst per IMAP und gibt sie an ClamAV weiter.
//
// Warum nicht wie bisher die Datei mitschicken? Zwei Gründe: Der Abruf-Knoten der
// Bestands-Triage liefert überhaupt keine Dateiinhalte (nur Namen und Größen), und
// über den Umweg mit den Binärdaten wurde immer nur der erste Anhang geprüft.
// Zugangsdaten kommen ausschließlich aus der Datenbank, nie aus der Anfrage.
router.post('/scan-anhaenge', express.json({ limit: '16kb' }), async (req, res) => {
  const { konto, uid, ordner } = req.body || {};
  try {
    if (!konto) return res.status(400).json({ clean: true, fehler: 'Kein Konto angegeben.' });

    const zeile = db.prepare('SELECT * FROM accounts WHERE name = ? AND aktiv = 1').get(String(konto));
    if (!zeile) return res.status(404).json({ clean: true, fehler: `Unbekanntes Konto: ${konto}` });

    const { gefunden, anhaenge } = await imap.anhaengeHolen({
      host: zeile.host,
      port: zeile.port,
      username: zeile.username,
      passwort: entschluesseln(zeile.password_enc),
      tlsUnsicher: Boolean(zeile.tls_unsicher),
      ordner: ordner || 'INBOX',
      uid,
    });

    const dateien = [];
    let virus = null;
    for (const anhang of anhaenge) {
      if (anhang.fehler) { dateien.push({ name: anhang.name, fehler: anhang.fehler }); continue; }
      const ergebnis = await clamav.scan(anhang.inhalt);
      dateien.push({ name: anhang.name, clean: ergebnis.clean, virus: ergebnis.virus || null });
      if (!ergebnis.clean && !virus) virus = ergebnis.virus;
    }

    res.json({
      clean: virus === null,
      virus,
      // Wie viele Anhänge die Mail hat und wie viele wirklich geprüft wurden —
      // im Workflow sieht man damit sofort, ob etwas übersprungen wurde.
      gefunden,
      geprueft: dateien.filter((d) => !d.fehler).length,
      dateien,
    });
  } catch (err) {
    console.error('Anhang-Scan Fehler:', err.message);
    // Wie beim Einzel-Scan: Ein Fehler darf die Mail nicht blockieren, muss aber
    // im Ergebnis stehen, damit er im Panel sichtbar wird.
    res.json({ clean: true, fehler: err.message, gefunden: 0, geprueft: 0, dateien: [] });
  }
});

// Liefert die Log-Daten der letzten 24 Stunden, gruppiert nach Kategorie, für Workflow 02
router.get('/digest', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, virus_name 
      FROM quarantine_log 
      WHERE created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC
    `).all();

    const zusammenfassung = {
      spam: [],
      phishing: [],
      newsletter: [],
      sonstiges: [],
      quarantaene: [],
    };

    let total = 0;
    for (const row of logs) {
      total++;
      if (row.virus_name) {
        zusammenfassung.quarantaene.push(row);
      } else if (row.kategorie === 'spam') {
        zusammenfassung.spam.push(row);
      } else if (row.kategorie === 'phishing') {
        zusammenfassung.phishing.push(row);
      } else if (row.kategorie === 'newsletter') {
        zusammenfassung.newsletter.push(row);
      } else if (row.zielordner === 'Quarantine' || row.zielordner === 'Junk') {
        zusammenfassung.quarantaene.push(row);
      } else {
        zusammenfassung.sonstiges.push(row);
      }
    }

    res.json({ 
      ok: true, 
      total, 
      spam: zusammenfassung.spam, 
      phishing: zusammenfassung.phishing, 
      newsletter: zusammenfassung.newsletter, 
      quarantaene: zusammenfassung.quarantaene,
      sonstiges: zusammenfassung.sonstiges
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Frischen Google-Zugriffs-Token fuer die Kalender-Aktion in Workflow 07.
// Die Anmeldung selbst passiert im Panel — n8n bekommt hier nur einen kurzlebigen
// Token und sieht die Zugangsdaten nie.
router.get('/google-token', async (req, res) => {
  try {
    res.json(await google.zugriffsToken());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
