// Postfach-Sicherung: einrichten, prüfen, von Hand anstoßen.
//
// Die Passwörter (Archiv und FTP) gehen nur in eine Richtung — hinein. Nach
// außen wird ausschließlich gemeldet, ob eines gesetzt ist. Wer das Panel
// öffnet, soll die Sicherung bedienen können, ohne dabei den Schlüssel zum
// gesamten Mailbestand angezeigt zu bekommen.
const express = require('express');
const settings = require('../services/settings');
const sicherung = require('../services/postfachSicherung');
const { loggen } = require('../services/panelLog');

const router = express.Router();

// Damit ein langer Lauf nicht doppelt startet, wenn jemand zweimal klickt.
let laeuft = false;

router.get('/', (req, res) => {
  const e = sicherung.einstellungen();
  res.json({
    aktiv: e.aktiv,
    host: e.host,
    port: e.port,
    benutzer: e.benutzer,
    pfad: e.pfad,
    tls: e.tls,
    tlsUnsicher: e.tlsUnsicher,
    behalten: e.behalten,
    intervallStunden: e.intervallStunden,
    dubletten: e.dubletten,
    // Nur die Tatsache, nie der Wert.
    passwortGesetzt: Boolean(e.passwort),
    ftpPasswortGesetzt: Boolean(e.ftpPasswort),
    fehlt: sicherung.bereit(e),
    letzterLauf: sicherung.letzterLauf(),
    laeuft,
  });
});

const SCHALTER = {
  sicherung_aktiv: 'aktiv',
  sicherung_ftp_host: 'host',
  sicherung_ftp_port: 'port',
  sicherung_ftp_user: 'benutzer',
  sicherung_ftp_pfad: 'pfad',
  sicherung_ftp_tls: 'tls',
  sicherung_ftp_tls_unsicher: 'tlsUnsicher',
  sicherung_behalten: 'behalten',
  sicherung_intervall: 'intervallStunden',
  sicherung_dubletten: 'dubletten',
};

router.post('/', (req, res) => {
  const b = req.body || {};
  try {
    for (const [key, feld] of Object.entries(SCHALTER)) {
      if (b[feld] === undefined) continue;
      const wert = typeof b[feld] === 'boolean' ? (b[feld] ? '1' : '0') : String(b[feld]).trim();
      settings.setze(key, wert);
    }
    // Leer gelassene Passwortfelder bedeuten "nicht ändern" — sonst würde jedes
    // Speichern der übrigen Einstellungen das Passwort löschen.
    if (b.passwort) {
      if (String(b.passwort).length < 12) {
        return res.status(400).json({ error: 'Das Archiv-Passwort braucht mindestens 12 Zeichen.' });
      }
      settings.setze('sicherung_passwort', String(b.passwort));
      loggen('info', 'sicherung', 'Archiv-Passwort geändert. Ältere Sicherungen brauchen weiterhin das alte.');
    }
    if (b.ftpPasswort) settings.setze('sicherung_ftp_passwort', String(b.ftpPasswort));

    const e = sicherung.einstellungen();
    res.json({ ok: true, fehlt: sicherung.bereit(e), tls: e.tls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    res.json(await sicherung.verbindungTesten());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/starten', async (req, res) => {
  if (laeuft) return res.status(409).json({ error: 'Es läuft bereits eine Sicherung.' });
  laeuft = true;
  try {
    res.json(await sicherung.lauf({ trockenlauf: Boolean((req.body || {}).trockenlauf) }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    laeuft = false;
  }
});

module.exports = router;
