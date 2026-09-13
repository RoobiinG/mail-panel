// Die Warteschlange der Dateien, die vor dem Hochladen auf eine Freigabe warten.
//
// Gegenstück zu POST /api/internal/upload-freigabe, über das Workflow 07
// einliefert. Hier entscheidet der Mensch: ansehen, Pfad und Namen korrigieren,
// hochladen oder verwerfen. Die Arbeit selbst macht services/uploadFreigabe.js —
// diese Datei bleibt bewusst dünn.
const express = require('express');
const fs = require('fs');
const path = require('path');
const uploadFreigabe = require('../services/uploadFreigabe');
const settings = require('../services/settings');

const router = express.Router();

const nextcloudBereit = () => Boolean(
  settings.hole('nextcloud_url') && settings.hole('nextcloud_user') && settings.hole('nextcloud_passwort'),
);

router.get('/', (req, res) => {
  try {
    res.json({
      dateien: uploadFreigabe.liste(),
      // Bei aktiver Freigabe lädt das PANEL hoch, nicht n8n. Ohne Zugangsdaten
      // in den Einstellungen bleibt jede Freigabe wirkungslos — das gehört in
      // die Oberfläche, bevor jemand vergeblich auf "Hochladen" drückt.
      nextcloud_bereit: nextcloudBereit(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, dateien: [] });
  }
});

// Vorschau. Ohne sie hieße "darf das hoch?" raten: Dateiname und Betreff sagen
// oft nicht, was wirklich im PDF steht.
const VORSCHAU_TYPEN = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

router.get('/:id/datei', (req, res) => {
  try {
    const zeile = uploadFreigabe.holen(req.params.id);
    if (!zeile) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    const datei = uploadFreigabe.dateiVon(zeile);
    if (!datei) return res.status(404).json({ error: 'Die Datei ist nicht mehr im Zwischenlager.' });

    const endung = (String(zeile.dateiname).match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
    // Nur bekannte Typen inline anzeigen. Alles andere geht als Download raus —
    // ein Anhang aus einer fremden Mail ist nichts, was der Browser in unserem
    // Namen rendern soll.
    const typ = VORSCHAU_TYPEN[endung];
    res.setHeader('Content-Type', typ || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `${typ ? 'inline' : 'attachment'}; filename="${path.basename(zeile.dateiname).replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(datei).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/freigeben', express.json(), async (req, res) => {
  try {
    const { zielpfad, dateiname } = req.body || {};
    const ergebnis = await uploadFreigabe.freigeben(req.params.id, { zielpfad, dateiname });
    res.status(ergebnis.ok ? 200 : 400).json(ergebnis);
  } catch (err) {
    res.status(500).json({ ok: false, fehler: err.message });
  }
});

router.post('/:id/verwerfen', express.json(), async (req, res) => {
  try {
    const ergebnis = await uploadFreigabe.verwerfen(req.params.id);
    res.status(ergebnis.ok ? 200 : 400).json(ergebnis);
  } catch (err) {
    res.status(500).json({ ok: false, fehler: err.message });
  }
});

// Mehrere auf einmal. Je Datei ein eigener Versuch: Eine, die nicht hochgeht,
// darf die anderen nicht aufhalten — dieselbe Haltung wie beim Freigeben eines
// Ordners in routes/sortierung.js.
router.post('/sammel', express.json(), async (req, res) => {
  const { ids, aktion } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, fehler: 'Keine Dateien ausgewählt.' });
  }
  if (!['hochladen', 'verwerfen'].includes(String(aktion))) {
    return res.status(400).json({ ok: false, fehler: 'Unbekannte Aktion.' });
  }

  let erledigt = 0;
  const fehlgeschlagen = [];
  for (const id of ids.slice(0, 200)) {
    try {
      const ergebnis = aktion === 'hochladen'
        ? await uploadFreigabe.freigeben(id)
        : await uploadFreigabe.verwerfen(id);
      if (ergebnis.ok) erledigt += 1;
      else fehlgeschlagen.push({ id, fehler: ergebnis.fehler });
    } catch (err) {
      fehlgeschlagen.push({ id, fehler: err.message });
    }
  }
  res.json({ ok: true, erledigt, fehlgeschlagen });
});

module.exports = router;
