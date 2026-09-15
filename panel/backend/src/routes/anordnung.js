// Die Anordnung der Widgets — je Benutzer und je Seite.
//
// Warum eine eigene Route und nicht unter /api/dashboard: Das Dashboard hängt
// am Recht "dashboard", die Statistik am Recht "sortierung". Läge das Speichern
// beim Dashboard, könnte jemand mit Zugriff auf die Statistik seine eigene
// Statistik-Anordnung nicht sichern. Sich seine Kacheln zurechtzuschieben ist
// aber keine Befugnis, sondern eine Einstellung — sie braucht nur eine
// Anmeldung, und jeder ändert ausschließlich seine eigene (`req.user.id`).
//
// Gespeichert wird das Format von react-grid-layout. Was hier ankommt, kommt
// aus dem Browser und wird beim nächsten Laden wieder ausgeliefert — deshalb
// wird es nicht durchgereicht, sondern geprüft: `saeubern()` lässt nur die
// bekannten Felder durch, zwingt jede Zahl in ihre Grenzen und deckelt die
// Liste. Sonst stünde in der Datenbank genau das, was jemand in den Aufruf
// schreibt.
const express = require('express');

const router = express.Router();
const db = require('../db');

const LAYOUT_MAX = 40;
// Bekannte Seiten. Eine unbekannte wird abgewiesen, damit niemand die Tabelle
// mit beliebig vielen Zeilen je Benutzer füllt.
const SEITEN = ['dashboard', 'statistik'];

function seiteVon(roh) {
  const name = String(roh || 'dashboard').trim();
  return SEITEN.includes(name) ? name : null;
}

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

router.get('/', (req, res) => {
  const seite = seiteVon(req.query.seite);
  if (!seite) return res.status(400).json({ error: 'Unbekannte Seite' });
  try {
    const zeile = db.prepare('SELECT layout FROM dashboard_layouts WHERE user_id = ? AND seite = ?')
      .get(req.user.id, seite);
    res.json({ seite, layout: zeile ? JSON.parse(zeile.layout) : null });
  } catch {
    // Eine kaputte Zeile darf die Seite nicht blockieren — dann eben Standard.
    res.json({ seite, layout: null });
  }
});

router.put('/', (req, res) => {
  const seite = seiteVon(req.body?.seite);
  if (!seite) return res.status(400).json({ error: 'Unbekannte Seite' });
  const layout = saeubern(req.body?.layout);
  if (!layout) return res.status(400).json({ error: 'layout muss eine Liste sein' });
  try {
    db.prepare(`
      INSERT INTO dashboard_layouts (user_id, seite, layout, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, seite) DO UPDATE SET layout = excluded.layout, updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, seite, JSON.stringify(layout));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
