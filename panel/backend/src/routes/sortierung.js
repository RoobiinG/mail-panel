// Routen fuer die Ordner-Sortierung (Regeln verwalten, Inbox abarbeiten)
// Nur mit Recht "sortierung" zugaenglich.
const express = require('express');
const db      = require('../db');
const { loggen } = require('../services/panelLog');
// Wir muessen IMAP-Ordner live vom Konto holen. Dazu brauchen wir n8n (oder den imap-client)
// Das bestehende Backend nutzt node-imap nicht direkt für die Mail-Verwaltung, aber wir koennen
// die Ordner ueber n8n (oder eine rudimentaere IMAP-Abfrage) holen.
// Für diese Ausbaustufe lassen wir den Nutzer den Ordnernamen per Freitext oder Dropdown eintragen.
// Optional: IMAP-Abfrage hier einbauen.

const router = express.Router();

// GET /api/sortierung/regeln?konto_id=1 — Regeln fuer ein Konto
router.get('/regeln', (req, res) => {
  const konto_id = Number(req.query.konto_id);
  if (!konto_id) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    const regeln = db.prepare('SELECT * FROM sort_rules WHERE konto_id = ? ORDER BY created_at DESC').all(konto_id);
    res.json(regeln);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/regeln — Neue Regel anlegen
router.post('/regeln', (req, res) => {
  const { konto_id, typ, muster, zielordner } = req.body || {};
  if (!konto_id || !typ || !muster || !zielordner) {
    return res.status(400).json({ error: 'Alle Felder müssen ausgefüllt sein.' });
  }
  if (!['absender', 'betreff', 'domain'].includes(typ)) {
    return res.status(400).json({ error: 'Ungültiger Typ.' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
      VALUES (?, ?, ?, ?, ?)
    `).run(konto_id, typ, muster.trim(), zielordner.trim(), req.user.id);
    res.json({ id: info.lastInsertRowid, status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sortierung/regeln/:id — Regel loeschen
router.delete('/regeln/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM sort_rules WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SORTIER-INBOX ───────────────────────────────────────────────────────────

// GET /api/sortierung/inbox — Offene Mails aus der Inbox
router.get('/inbox', (req, res) => {
  try {
    // Hole alle offene Mails, sowie Kontonamen für die Dropdowns
    const inbox = db.prepare(`
      SELECT i.*, a.id AS account_id, a.name AS account_name
      FROM sort_inbox i
      LEFT JOIN accounts a ON a.id = i.konto_id OR a.name = i.konto
      WHERE i.status = 'offen'
      ORDER BY i.created_at DESC
    `).all();
    res.json(inbox);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/zuordnen — Mail aus Inbox einem Ordner zuweisen
router.post('/zuordnen', (req, res) => {
  const { id, zielordner, regelAnlegen } = req.body || {};
  if (!id || !zielordner) return res.status(400).json({ error: 'ID und Zielordner fehlen.' });
  
  try {
    db.transaction(() => {
      const mail = db.prepare('SELECT * FROM sort_inbox WHERE id = ?').get(id);
      if (!mail) throw new Error('Mail nicht gefunden.');

      // In der Inbox als zugeordnet markieren (Wird nicht gelöscht, für spätere Analyse/Logs)
      db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?").run(zielordner, id);

      // Regel anlegen?
      if (regelAnlegen && mail.konto_id) {
        // Extrahiere E-Mail für Absender-Regel
        let absenderEmail = mail.von;
        const match = mail.von.match(/<([^>]+)>/);
        if (match) absenderEmail = match[1];

        // Vermeide Duplikate
        const exists = db.prepare('SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?').get(mail.konto_id, 'absender', absenderEmail);
        if (!exists) {
          db.prepare(`
            INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
            VALUES (?, 'absender', ?, ?, ?)
          `).run(mail.konto_id, absenderEmail, zielordner, req.user.id);
        }
      }

      // HIER muesste der eigentliche IMAP-Move passieren! 
      // In dieser Architektur uebergeben wir die Verschiebe-Aktionen oft an n8n zurueck,
      // oder wir rufen einen Webhook in n8n auf, der die UID im Konto verschiebt.
      // Da wir in Workflow 04/01 sind: Die Mail wurde temporaer pausiert? 
      // NEIN, das Architekturkonzept von Etappe 8 (Block A) besagt: "Zuordnung wird als Regel gespeichert, sodass n8n künftige Mails gleich sortiert.
      // Die eigentliche Sortier-Inbox im Panel MUSS Mails eigentlich live verschieben.
      // => Dazu schicken wir einen Trigger-Request an einen neuen n8n-Verschiebe-Workflow.
      // Workaround fuer Etappe 8: Wir loggen es erstmal nur. Die eigentliche Live-Verschiebung
      // erfordert einen dedizierten IMAP-Move-Workflow.
      loggen('info', 'sortierung', `Mail ${mail.uid} (Konto ${mail.konto}) soll in Ordner ${zielordner} verschoben werden.`);
    })();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/ignorieren — Mail aus Inbox entfernen ohne Regel
router.post('/ignorieren', (req, res) => {
  try {
    db.prepare("UPDATE sort_inbox SET status = 'ignoriert' WHERE id = ?").run(Number(req.body.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
