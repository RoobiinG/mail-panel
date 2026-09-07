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

// Die Sperre gegen Doppelstarts sitzt im Dienst selbst
// (postfachSicherung.laeuftGerade). Dort greift sie auch für den Zeitplan und
// nicht nur für den Knopf — zwei Sperren nebeneinander wären eine zu viel.

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
    // Läuft gerade eine? Ohne diese Auskunft sah die Seite bei einem langen
    // Lauf aus, als sei nichts los — und der Knopf antwortete bloß „läuft
    // bereits", ohne zu sagen, seit wann.
    laeuft: sicherung.laeuftGerade(),
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

// Anstoßen und sofort antworten — nicht auf das Ende warten.
//
// Vorher hing die Antwort am ganzen Lauf. Bei 23.000 Mails dauert der viele
// Minuten, und die HTTP-Anfrage lief unterwegs in einen Zeitüberlauf: Die Seite
// meldete „Lauf fehlgeschlagen", während die Sicherung in Wahrheit weiterlief
// und die Sperre hielt. Wer dann noch einmal drückte, bekam nur „läuft
// bereits" — ohne zu erfahren, dass das die eigene, längst gestartete war.
//
// Jetzt läuft sie im Hintergrund, und die Seite fragt den Stand ab.
router.post('/starten', (req, res) => {
  const laeuft = sicherung.laeuftGerade();
  if (laeuft) {
    const minuten = Math.round((Date.now() - new Date(laeuft.seit).getTime()) / 60000);
    return res.status(409).json({
      error: `Es läuft bereits eine Sicherung — seit ${minuten} Minuten.`,
      laeuft,
    });
  }

  const trockenlauf = Boolean((req.body || {}).trockenlauf);
  // Fehler landen im Protokoll und im „letzten Stand" — das erledigt der Dienst
  // selbst. Hier darf nichts unbehandelt bleiben, sonst reisst es den Prozess ab.
  sicherung.lauf({ trockenlauf }).catch((err) => {
    loggen('error', 'sicherung', `Sicherung fehlgeschlagen: ${err.message}`);
  });
  res.json({ gestartet: true, trockenlauf });
});

module.exports = router;
