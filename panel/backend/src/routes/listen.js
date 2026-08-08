const express = require('express');
const listen  = require('../services/listen');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    whitelist: listen.eintraege('whitelist'),
    blacklist: listen.eintraege('blacklist'),
  });
});

router.post('/', (req, res) => {
  const { typ, muster, kommentar } = req.body || {};
  if (typ !== 'whitelist' && typ !== 'blacklist') {
    return res.status(400).json({ error: 'Typ muss whitelist oder blacklist sein.' });
  }
  try {
    res.json(listen.hinzufuegen(typ, muster, kommentar));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!listen.entfernen(req.params.id)) {
    return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
  }
  res.json({ ok: true });
});

module.exports = router;
