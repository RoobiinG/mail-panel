// Der Diagnose-Bericht als Route. Siehe services/diagnose.js — dort steht auch,
// was bewusst NICHT hineingehört.
//
// Hinter dem Recht "einstellungen": Der Bericht zeigt die Konfiguration, die
// Konten und den Zustand der angebundenen Dienste. Wer das sehen darf, darf es
// ohnehin auch ändern.
const express = require('express');
const diagnose = require('../services/diagnose');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// GET /api/diagnose?mails=1&logs=60
//
// Antwortet mit dem Bericht als Objekt UND als fertigem Text. Beides, weil die
// Seite ihn anzeigen soll und der Text das ist, was am Ende jemand bekommt.
router.get('/', async (req, res) => {
  const mitMails = String(req.query.mails || '') === '1';
  try {
    const bericht = await diagnose.erstellen({
      mitMails,
      logZeilen: Number(req.query.logs) || 40,
    });
    // Nachvollziehbar halten: Ein Bericht, der Absender und Betreffe enthält,
    // verlässt womöglich das Haus. Dass er erstellt wurde, gehört ins Protokoll.
    loggen('info', 'backend:diagnose',
      `Diagnose-Bericht erstellt von ${req.user?.username || 'unbekannt'}`
      + (mitMails ? ' — MIT Mailinhalten' : ' (ohne Mailinhalte)'));
    res.json({ bericht, text: diagnose.alsText(bericht) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
