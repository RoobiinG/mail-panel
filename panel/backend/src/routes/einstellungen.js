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
const kiModell  = require('../services/kiModell');

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

// GET /api/einstellungen/ki-modelle — welche Gemini-Modelle stehen zur Wahl?
//
// Google kennt seine Modelle selbst, also wird gefragt, statt den Nutzer einen
// Namen eintippen zu lassen. Ein Tippfehler faellt sonst erst auf, wenn Google
// mitten in einem Lauf mit 404 antwortet — Stunden spaeter.
router.get('/ki-modelle', async (req, res) => {
  res.json(await kiModell.verfuegbare());
});

// POST /api/einstellungen/ki-test — eine einzige echte Anfrage an Gemini.
//
// Der kuerzeste Weg von "es scheitert" zu "deshalb": Die Antwort kommt
// ungekuerzt zurueck, samt quotaId, limit und model. Kostet eine Anfrage.
router.post('/ki-test', async (req, res) => {
  res.json(await kiModell.pruefen());
});

router.put('/', (req, res) => {
  const update = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const geaendert = [];

  // Ein Ersatz-Modell, das dem ersten gleicht, ist keins — es sieht nur so aus.
  // Das Panel hielte sich damit von Anfang an für umgeschaltet und wechselte
  // deshalb nie. Lieber klar abweisen als still wirkungslos speichern.
  {
    const b = req.body || {};
    const erst = String(b.gemini_modell ?? settings.hole('gemini_modell') ?? '').trim();
    const zweit = String(b.gemini_modell_ersatz ?? '').trim();
    if (zweit && erst && zweit === erst) {
      return res.status(400).json({
        error: 'Das Ersatz-Modell muss ein anderes sein als das erste — sonst gibt es kein zweites Kontingent.',
      });
    }
  }

  for (const [key, value] of Object.entries(req.body || {})) {
    // Ein zu kleines Kontextfenster schneidet den Prompt ab, ohne es zu sagen;
    // ein zu großes belegt Arbeitsspeicher, den die Maschine nicht hat. Leer
    // ist erlaubt und heißt „Standard".
    if (key === 'ollama_kontext' && String(value).trim()
      && (!Number.isInteger(Number(value)) || Number(value) < 2048 || Number(value) > 32768)) {
      return res.status(400).json({ error: 'ollama_kontext: ganze Zahl zwischen 2048 und 32768' });
    }
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

  // Diese Werte stehen nicht nur im Panel, sondern werden in die n8n-Workflows
  // hineingeschrieben. Wer sie ändert und danach nicht „Workflows →
  // Synchronisieren" drückt, betreibt eine Einstellung, die es nur auf dem
  // Bildschirm gibt — beim KI-Anbieter hieß das: Panel sagt Ollama, n8n ruft
  // weiter Google. Deshalb stößt das Speichern den Abgleich jetzt selbst an.
  const inDenWorkflows = [
    'ki_anbieter', 'ollama_url', 'ollama_modell', 'ollama_kontext',
    'gemini_modell', 'gemini_modell_ersatz', 'gemini_pause_ms', 'gemini_denkstufe',
    'neue_mails_ungelesen', 'bestand_intervall', 'spam_schwellwert',
  ];
  if (geaendert.some((k) => inDenWorkflows.includes(k))) {
    require('../services/autoSync').anstossen(`Einstellung geändert: ${geaendert.join(', ')}`);
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
      // Der Schlüssel geht als Kopfzeile, nicht als URL-Parameter: Eine URL
      // steht in Protokollen und Fehlerberichten — ein Geheimnis hat dort
      // nichts verloren.
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(10000) }
      );
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message || `Gemini antwortete mit HTTP ${r.status}`);
      ergebnis = { ok: true, hinweis: `Verbunden — ${(body.models?.length ?? 0)} Modell(e) gefunden` };
    }
    else if (dienst === 'ollama') {
      const url = settings.hole('ollama_url');
      if (!url) throw new Error('Keine Ollama Host-URL gesetzt.');
      const r = await fetch(url.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(5000) });
      const body = await r.json();
      if (!r.ok) throw new Error(`Ollama antwortete mit HTTP ${r.status}`);
      ergebnis = { ok: true, hinweis: `Verbunden — ${(body.models?.length ?? 0)} Modell(e) geladen` };
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

// Die Adresse des Ollama-Servers kommt AUSSCHLIESSLICH aus den Einstellungen.
//
// Vorher durfte der Aufrufer sie mitschicken (req.body.url / req.query.url). Das
// machte aus dem Panel ein Fernrohr ins interne Netz: Wer angemeldet ist, hätte
// beliebige Adressen abrufen lassen können — den n8n-Container, den
// Metadaten-Dienst des Hosters, was sonst im Docker-Netz erreichbar ist — und
// bekam die Antwort im Klartext zurückgestreamt. Serverseitige Anfragen gehören
// dorthin, wo der Betreiber sie eingetragen hat, und sonst nirgendwo.
function ollamaAdresse() {
  const url = String(settings.hole('ollama_url') || '').trim();
  return url ? url.replace(/\/$/, '') : null;
}

router.post('/ollama/modelle', async (req, res) => {
  const url = ollamaAdresse();
  if (!url) return res.status(400).json({ error: 'Keine Ollama-Adresse in den Einstellungen hinterlegt.' });
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const body = await r.json();
    if (!r.ok) throw new Error(`Ollama antwortete mit HTTP ${r.status}`);
    res.json(body.models?.map(m => m.name) || []);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Ein Modell herunterladen. Läuft als Ereignisstrom, weil es Minuten dauert und
// der Fortschritt sichtbar sein soll.
//
// POST statt GET: Der Browser konnte an eine EventSource keine Kopfzeilen
// hängen, also stand das Anmelde-Token vorher im Link — und damit im
// Zugriffsprotokoll jedes Proxys, im Verlauf des Browsers und in jedem
// Fehlerbericht. Die Oberfläche liest den Strom jetzt selbst und schickt das
// Token dort hin, wo es hingehört: in die Authorization-Kopfzeile.
router.post('/ollama/pull', async (req, res) => {
  const model = String(req.body?.model || '').trim();
  const url = ollamaAdresse();
  if (!model || !url) return res.status(400).json({ error: 'Modellname oder Ollama-Adresse fehlt.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Ein Ereignis darf keine Zeilenumbrüche enthalten — sonst endet es mittendrin
  // und der Empfänger liest Bruchstücke. Die Fehlermeldung wurde vorher roh in
  // ein JSON-Literal geklebt; ein Anführungszeichen darin reichte, um sie
  // unlesbar zu machen.
  const senden = (objekt) => res.write(`data: ${JSON.stringify(objekt).replace(/\n/g, ' ')}\n\n`);

  // Ohne Zeitlimit hing die Anfrage an einem stummen Server unbegrenzt — samt
  // offener Verbindung. Ein Modell-Download darf lange dauern, aber nicht ewig.
  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), 30 * 60 * 1000);

  try {
    const r = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: abbruch.signal,
    });

    if (!r.ok) {
      senden({ error: `Ollama antwortete mit HTTP ${r.status}` });
      return res.end();
    }

    // Ollama schickt eine JSON-Zeile je Fortschrittsschritt. Ein Netzwerkpaket
    // endet nicht zwingend auf einem Zeilenumbruch — der Rest wandert deshalb in
    // die nächste Runde, statt als halbe Zeile beim Empfänger zu landen.
    let rest = '';
    for await (const stueck of r.body) {
      const zeilen = (rest + stueck.toString()).split('\n');
      rest = zeilen.pop() || '';
      for (const zeile of zeilen) {
        if (zeile.trim()) res.write(`data: ${zeile.trim()}\n\n`);
      }
    }
    if (rest.trim()) res.write(`data: ${rest.trim()}\n\n`);

    senden({ status: 'success' });
    res.end();
  } catch (err) {
    senden({ error: err.name === 'AbortError' ? 'Zeitlimit überschritten.' : String(err.message) });
    res.end();
  } finally {
    clearTimeout(uhr);
  }
});

module.exports = router;
