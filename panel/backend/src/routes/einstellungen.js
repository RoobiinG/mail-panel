const express  = require('express');
const db       = require('../db');
const settings = require('../services/settings');
const n8n      = require('../services/n8n');
const mailcow  = require('../services/mailcow');
const clamav   = require('../services/clamav');
const dnsbl    = require('../services/dnsbl');
const nextcloud = require('../services/nextcloud');
const smtp      = require('../services/smtp');
const google    = require('../services/google');
const themen    = require('../services/themen');

const router = express.Router();

// Einfache Schalter/Werte (unverschlüsselt, direkt in settings)
const EINFACHE_KEYS = [
  'dnsbl_listen', 'spam_schwellwert', 'clamav_aktiv', 'safebrowsing_aktiv', 'trockenlauf_aktiv',
  // Automatische Themen-Sortierung
  'themen_sortierung_aktiv', 'themen_ordner_anlegen', 'themen_ordner_max',
  'themen_konfidenz', 'themen_konfidenz_vorhanden', 'themen_eltern', 'themen_regel_lernen',
];

router.get('/', (req, res) => {
  const zeilen = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${EINFACHE_KEYS.map(() => '?').join(',')})`,
  ).all(...EINFACHE_KEYS);
  res.json({
    ...Object.fromEntries(zeilen.map((z) => [z.key, z.value])),
    ...settings.fuerUi(),
    // Damit der Nutzer das Secret in die n8n-Workflows kopieren kann
    panel_secret: process.env.PANEL_SECRET,
  });
});

router.put('/', (req, res) => {
  const update = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const geaendert = [];

  for (const [key, value] of Object.entries(req.body || {})) {
    // Zugangsdaten laufen über den Settings-Service (verschlüsselt)
    if (settings.FELDER[key]) {
      // Maskierte Anzeige nicht zurückspeichern
      if (String(value).startsWith('••')) continue;
      settings.setze(key, value);
      geaendert.push(key);
      continue;
    }
    if (!EINFACHE_KEYS.includes(key)) continue;

    if (key === 'dnsbl_listen') {
      let listen;
      try { listen = JSON.parse(value); } catch { return res.status(400).json({ error: 'dnsbl_listen: kein gültiges JSON-Array' }); }
      if (!Array.isArray(listen) || listen.some((l) => typeof l !== 'string' || !/^[a-z0-9.-]+$/i.test(l))) {
        return res.status(400).json({ error: 'dnsbl_listen: nur Hostnamen erlaubt' });
      }
    }
    if (key === 'spam_schwellwert' && (isNaN(Number(value)) || Number(value) < 0 || Number(value) > 1)) {
      return res.status(400).json({ error: 'spam_schwellwert: Zahl zwischen 0 und 1' });
    }
    if (['themen_konfidenz', 'themen_konfidenz_vorhanden'].includes(key)
      && (isNaN(Number(value)) || Number(value) < 0 || Number(value) > 1)) {
      return res.status(400).json({ error: `${key}: Zahl zwischen 0 und 1` });
    }
    if (key === 'themen_ordner_anlegen' && !themen.ANLEGEN_MODI.includes(String(value))) {
      return res.status(400).json({ error: 'themen_ordner_anlegen: nur aus, freigabe oder auto' });
    }
    if (key === 'themen_ordner_max' && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 200)) {
      return res.status(400).json({ error: 'themen_ordner_max: ganze Zahl zwischen 1 und 200' });
    }
    // Der Sammelordner landet als Elternpfad in einem IMAP-Befehl und muss
    // deshalb durch dieselbe Prüfung wie jeder KI-Ordner. Leer heißt: keiner.
    if (key === 'themen_eltern' && String(value).trim() && !themen.ordnerNormalisieren(value)) {
      return res.status(400).json({
        error: 'themen_eltern: 2–40 Zeichen aus Buchstaben, Zahlen, Leerzeichen, - und _; System- und Kategorieordner sind gesperrt',
      });
    }
    update.run(key, String(value));
    geaendert.push(key);
  }
  res.json({ ok: true, geaendert });
});

// Verbindungstests für die Einstellungen-Seite
router.post('/test/:dienst', async (req, res) => {
  const { dienst } = req.params;
  try {
    let ergebnis;
    if (dienst === 'n8n') {
      ergebnis = await n8n.testVerbindung();
      if (ergebnis.ok) {
        const patcher = require('../services/workflowPatcher');
        // Im Hintergrund die Basis-Workflows installieren, falls sie fehlen
        patcher.basisSetup().catch(() => {});
      }
    }
    else if (dienst === 'mailcow') ergebnis = await mailcow.testVerbindung();
    else if (dienst === 'clamav') ergebnis = await clamav.ping();
    else if (dienst === 'unbound') ergebnis = await dnsbl.testVerbindung();
    else if (dienst === 'nextcloud') {
      ergebnis = await nextcloud.testVerbindung();
      // Klappt die Verbindung, gleich die Zugangsdaten in n8n hinterlegen —
      // dort muss der Nutzer dann nichts mehr eintragen.
      if (ergebnis.ok) { try { await nextcloud.credentialsAnlegen(); } catch (e) { ergebnis.hinweis = 'In n8n konnte nichts hinterlegt werden: ' + e.message; } }
    }
    else if (dienst === 'smtp') {
      ergebnis = await smtp.testVerbindung({
        host: settings.hole('smtp_host'),
        port: settings.hole('smtp_port'),
        user: settings.hole('smtp_user'),
        passwort: settings.hole('smtp_passwort'),
        tlsUnsicher: settings.hole('smtp_tls_unsicher') === '1',
      });
    }
    else if (dienst === 'gemini') {
      // Minimaler API-Call: listet Modelle auf (keine Tokens verbraucht)
      const apiKey = settings.hole('gemini_api_key');
      if (!apiKey) throw new Error('Kein Gemini-API-Key gesetzt.');
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message || `Gemini antwortete mit HTTP ${r.status}`);
      ergebnis = { ok: true, hinweis: `Verbunden — ${(body.models?.length ?? 0)} Modell(e) gefunden` };
    }
    else if (dienst === 'google') {
      // Frischen Access-Token holen: beweist, dass Refresh-Token gültig ist
      const token = await google.zugriffsToken();
      ergebnis = {
        ok: true,
        hinweis: `Verbunden — Access-Token gültig bis ${new Date(token.gueltig_bis).toLocaleTimeString('de-DE')}`,
      };
    }
    else return res.status(400).json({ error: `Unbekannter Dienst: ${dienst}` });
    res.json(ergebnis);
  } catch (err) {
    // Fehlermeldung durchreichen, aber keine Stacktraces/Interna
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
