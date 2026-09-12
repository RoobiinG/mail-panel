// Der Diagnose-Bericht: alles, was man zum Fehlersuchen braucht — und nichts,
// wofür man eine Shell auf dem Server bräuchte.
//
// Der Anlass ist eine Abwägung, die jeder Selbsthoster irgendwann trifft: Wer
// beim Suchen helfen soll, braucht Einblick; wer Docker ausführen darf, ist
// faktisch root und käme damit auch an die Postfächer. Zwischen „gar nichts
// sehen" und „alles dürfen" liegt dieser Bericht.
//
// Was hier NICHT hineingehört, ist genauso wichtig wie der Inhalt:
//   * keine Passwörter, Schlüssel oder Token — nur „gesetzt" / „nicht gesetzt",
//   * keine Mailinhalte, keine Betreffe, keine Absenderadressen. Auch nicht aus
//     den Logzeilen: Die tragen zum Beispiel „Korrektur: max@example.com von A
//     nach B" mit sich, und das ist eine Adresse aus dem Postfach.
// Wer Beispiele braucht, schaltet sie ausdrücklich zu (`mitMails`) — dann steht
// im Bericht auch, dass sie drin sind.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const db = require('../db');
const settings = require('./settings');

const MB = 1024 * 1024;

// ─── Hilfen ─────────────────────────────────────────────────────────────────

// Jeder Abschnitt einzeln abgesichert: Ein Bericht, der an einer kaputten Stelle
// ganz ausfällt, ist genau dann nutzlos, wenn man ihn am nötigsten braucht.
async function versuch(was, fn) {
  try {
    return await fn();
  } catch (err) {
    return { fehler: `${was} nicht ermittelbar: ${err.message}` };
  }
}

function zahl(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return 0; }
}

// E-Mail-Adressen aus einem Text nehmen. Grob absichtlich: Lieber einmal zu viel
// unkenntlich gemacht als eine Adresse durchgelassen.
const ADRESSE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function adressenTilgen(text) {
  return String(text || '').replace(ADRESSE, '<adresse>');
}

// Erreichbarkeit statt Container-Zustand: Das Panel hat bewusst keinen Zugriff
// auf den Docker-Socket — der wäre gleichbedeutend mit root auf dem Wirt. Ob
// ein Dienst läuft, beantwortet ein Verbindungsversuch genauso gut.
function erreichbar(host, port, msFrist = 2500) {
  return new Promise((fertig) => {
    const anfang = Date.now();
    const buchse = net.connect({ host, port: Number(port) });
    const ende = (ok, grund) => {
      buchse.destroy();
      fertig({ host: `${host}:${port}`, ok, ms: Date.now() - anfang, ...(grund ? { grund } : {}) });
    };
    buchse.setTimeout(msFrist);
    buchse.once('connect', () => ende(true));
    buchse.once('timeout', () => ende(false, 'Zeitlimit'));
    buchse.once('error', (e) => ende(false, e.code || e.message));
  });
}

function adresseZerlegen(url, standardPort) {
  try {
    const u = new URL(String(url));
    return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : standardPort) };
  } catch {
    return null;
  }
}

// ─── Die einzelnen Abschnitte ───────────────────────────────────────────────

function panelStand() {
  let version = {};
  for (const p of ['../../../../version.json', '../../../version.json', '../../version.json']) {
    try {
      const datei = path.resolve(__dirname, p);
      if (fs.existsSync(datei)) { version = JSON.parse(fs.readFileSync(datei, 'utf8')); break; }
    } catch { /* weiter suchen */ }
  }
  return {
    version: version.version || 'unbekannt',
    build: version.build || 'unbekannt',
    datum: version.date || 'unbekannt',
    node: process.version,
    laeuftSeitSekunden: Math.round(process.uptime()),
    tls: process.env.TLS_CERT && process.env.TLS_KEY ? 'eigenes Zertifikat'
      : (String(process.env.TLS_MODUS || '').toLowerCase() === 'aus' ? 'aus (Reverse Proxy davor)' : 'selbst erzeugt'),
    zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    jetzt: new Date().toISOString(),
  };
}

// Speicher und Platte waren im Betrieb schon zweimal die Ursache: Eine volle
// Platte legt Container mit „Exit 137" um, und das sieht man dem Panel sonst
// nirgends an.
function maschine() {
  const platte = (() => {
    try {
      const ziel = process.env.DATA_DIR || '/app/data';
      const s = fs.statfsSync(fs.existsSync(ziel) ? ziel : '/');
      const gesamt = (s.blocks * s.bsize) / MB;
      const frei = (s.bavail * s.bsize) / MB;
      return {
        pfad: ziel,
        gesamtMB: Math.round(gesamt),
        freiMB: Math.round(frei),
        belegtProzent: gesamt ? Math.round(((gesamt - frei) / gesamt) * 100) : null,
      };
    } catch (err) { return { fehler: err.message }; }
  })();

  return {
    kerne: os.cpus().length,
    last: os.loadavg().map((n) => Number(n.toFixed(2))),
    speicherMB: {
      gesamt: Math.round(os.totalmem() / MB),
      frei: Math.round(os.freemem() / MB),
      panelBelegt: Math.round(process.memoryUsage().rss / MB),
    },
    platte,
    wirtLaeuftSeitStunden: Math.round(os.uptime() / 3600),
  };
}

// Alle Verbindungsversuche nebeneinander: Nacheinander wäre der Bericht bei
// einem nicht auflösbaren Namen um mehrere Sekunden langsamer, ohne dass es
// etwas brächte.
async function dienste() {
  const auftrag = (name, url, standardPort) => {
    const ziel = adresseZerlegen(url, standardPort);
    if (!ziel) return Promise.resolve({ name, ok: null, grund: 'keine Adresse hinterlegt' });
    return erreichbar(ziel.host, ziel.port).then((r) => ({ name, ...r }));
  };

  const auftraege = [
    auftrag('n8n', settings.hole('n8n_url'), 5678),
    erreichbar(process.env.CLAMD_HOST || 'clamav', process.env.CLAMD_PORT || 3310)
      .then((r) => ({ name: 'ClamAV', ...r })),
    erreichbar(process.env.UNBOUND_HOST || 'unbound', 53)
      .then((r) => ({ name: 'unbound (DNSBL)', ...r })),
  ];
  if ((settings.hole('ki_anbieter') || 'gemini') === 'ollama') {
    auftraege.push(auftrag('Ollama', settings.hole('ollama_url'), 11434));
  }
  const nc = settings.hole('nextcloud_url');
  if (nc) auftraege.push(auftrag('Nextcloud', nc, 443));

  return Promise.all(auftraege);
}

// Zugangsdaten aus einer URL entfernen.
//
// Steht eine lokale KI hinter einem Reverse Proxy mit Basic-Auth, trägt
// `ollama_url` Benutzer und Passwort im Klartext: `https://nutzer:geheim@host`.
// Der Schlüssel steht in der offenen Liste unten — er sagt ja auch etwas
// Nützliches über die Einrichtung aus —, und damit stand das Passwort in jedem
// erzeugten Bericht. Das widerspricht der Zusage im Dateikopf („keine
// Passwörter, Schlüssel oder Token") und wiegt schwer, weil ein Diagnose-Bericht
// genau dafür gedacht ist, weitergegeben zu werden.
//
// Bewusst kein `new URL()`: Der Parser scheitert an Sonderzeichen im Passwort —
// derselbe Absturz, der in Build 180 behoben wurde. Hier fällt er zusätzlich
// unangenehm aus, denn ein Fehler beim Maskieren dürfte nie dazu führen, dass
// stattdessen der ungekürzte Wert erscheint.
function urlOhneZugang(wert) {
  const s = String(wert ?? '');
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1•••@');
}

// Einstellungen ohne Geheimnisse. Was verschlüsselt in der Datenbank liegt,
// erscheint hier nur als „gesetzt" — genau wie auf der Einstellungsseite.
function konfiguration() {
  const offen = [
    'ki_anbieter', 'gemini_modell', 'gemini_modell_ersatz', 'gemini_denkstufe',
    'gemini_tagesbudget', 'gemini_pause_ms', 'gemini_buendel', 'gemini_text_kurz',
    'gemini_text_lang', 'gemini_lauf_frist_ms', 'ollama_url', 'ollama_modell',
    'ollama_kontext', 'ollama_buendel', 'ki_lauf_frist_ms',
    'auto_sync', 'neue_mails_ungelesen', 'spam_schwellwert', 'clamav_aktiv',
    'safebrowsing_aktiv', 'bestand_intervall', 'beleg_lese_tagesbudget',
    'themen_sortierung_aktiv', 'themen_max', 'themen_konfidenz', 'n8n_url',
    'beleg_ocr_aktiv',
  ];
  const geheim = [
    'gemini_api_key', 'n8n_api_key', 'mailcow_api_key', 'safebrowsing_api_key',
    'telegram_token', 'nextcloud_passwort', 'smtp_passwort', 'sicherung_passwort',
  ];
  const werte = {};
  for (const k of offen) {
    const v = settings.hole(k);
    werte[k] = (v === '' || v === undefined) ? '(nicht gesetzt)' : urlOhneZugang(v);
  }
  const schluessel = {};
  for (const k of geheim) schluessel[k] = settings.hole(k) ? 'gesetzt' : 'nicht gesetzt';
  return { werte, schluessel };
}

function kiStand() {
  const budget = require('./budget');
  const kontingent = require('./kiKontingent');
  const modell = require('./kiModell');
  const anbieter = settings.hole('ki_anbieter') || 'gemini';
  return {
    anbieter,
    // Welches Modell wirklich arbeitet. kiModell.stand() kennt nur Googles
    // Modelle samt Ersatzmodell — bei „ollama" stand dort trotzdem ein
    // Gemini-Name, und das führt beim Lesen des Berichts genau in die
    // Richtung, aus der das Problem nicht kommt.
    modellInBenutzung: anbieter === 'ollama'
      ? (settings.hole('ollama_modell') || '(nicht gesetzt)')
      : (() => { try { return modell.stand().aktiv; } catch { return null; } })(),
    geminiModelle: anbieter === 'ollama'
      ? '(nicht in Benutzung — Anbieter ist Ollama)'
      : (() => { try { return modell.stand(); } catch { return null; } })(),
    // Nur bei Ollama aussagekräftig: Wie viel Prompt passt überhaupt hinein,
    // und stauen sich die Anfragen? Neun gleichzeitig gescheiterte Bündel in
    // derselben Sekunde waren im Bericht vom 8. September der einzige Hinweis
    // darauf, dass mehrere Läufe parallel auf dieselbe CPU eingeredet haben —
    // und der war nur zu erkennen, wenn man die Zeitstempel zählt.
    lokal: anbieter === 'ollama' ? (() => {
      const kiText = require('./kiText');
      const kontext = kiText.kontextFenster();
      return {
        kontextFenster: kontext,
        promptPlatzZeichen: kiText.promptPlatz(kontext, 1500),
        buendelGroesse: (() => {
          try { return require('./klassifizierer').buendelGroesse(); } catch { return null; }
        })(),
        laufFristMs: (() => {
          try { return require('./klassifizierer').frist(); } catch { return null; }
        })(),
        schlange: require('./ollamaSchlange').stand(),
        // Die Zahl, um die es geht: wie lange eine Anfrage wirklich dauert und
        // wo die Zeit hingeht. Steckt sie im Prompt, hilft ein kleineres
        // Bündel; steckt sie in der Antwort, ist das Modell zu groß.
        messung: require('./ollamaMessung').stand(),
      };
    })() : '(nicht in Benutzung — Anbieter ist Gemini)',
    tagesbudget: budget.tagesbudget(),
    heuteAnfragen: budget.heuteVerbraucht(),
    heuteMails: budget.protokolliertHeute(),
    beobachtet: (() => { try { return kontingent.stand().beobachtet; } catch { return null; } })(),
    abweisung: {
      tag: settings.hole('ki_429_tag') || null,
      art: settings.hole('ki_429_art') || null,
      bis: settings.hole('ki_429_bis') || null,
      limit: settings.hole('ki_429_limit') || null,
      modell: settings.hole('ki_429_modell') || null,
    },
  };
}

// Kontonamen, Hosts und Zielordner sind Konfiguration, keine Post. Zugangsdaten
// tauchen nicht auf — auch nicht verschlüsselt.
function konten() {
  try {
    return db.prepare('SELECT * FROM accounts ORDER BY id').all().map((k) => ({
      id: k.id,
      name: k.name,
      host: `${k.host}:${k.port}`,
      aktiv: Boolean(k.aktiv),
      inN8nVerdrahtet: Boolean(k.n8n_credential_id),
      tlsUnsicher: Boolean(k.tls_unsicher),
      ordner: {
        spam: k.folder_spam || null, rechnungen: k.folder_invoices || null,
        bestellungen: k.folder_orders || null, newsletter: k.folder_newsletter || null,
        archiv: k.folder_archive || null,
      },
    }));
  } catch (err) { return { fehler: err.message }; }
}

// Der Teil, für den ich sonst in n8n hineinsehen müsste: Welche Knoten stehen
// drin, wohin zeigt der KI-Aufruf, versteht der Parser beide Antwortformate,
// und was macht der Auslöser mit gelesenen Mails.
async function workflows() {
  const n8n = require('./n8n');
  const liste = await n8n.workflowsAuflisten();
  const raus = [];
  for (const meta of liste) {
    const eintrag = { name: meta.name, id: meta.id, aktiv: Boolean(meta.active), knoten: [] };
    try {
      const wf = await n8n.workflowHolen(meta.id);
      eintrag.knotenAnzahl = wf.nodes.length;
      for (const k of wf.nodes) {
        const typ = String(k.type).replace('n8n-nodes-base.', '');
        const p = k.parameters || {};
        const js = String(p.jsCode || '');
        const url = String(p.url || '');
        const interessant = url || js.includes('candidates[0]') || js.includes('PANEL:')
          || typ === 'emailReadImap' || typ.includes('Trigger') || typ === 'scheduleTrigger';
        if (!interessant) continue;

        const zeile = { name: k.name, typ, ...(k.disabled ? { deaktiviert: true } : {}) };
        if (url) {
          // Dieselbe Maskierung wie bei den Einstellungen: Der KI-Knoten trägt
          // die Ollama-Adresse samt Basic-Auth, sonst stünde das Passwort hier
          // ein zweites Mal im Bericht.
          zeile.url = urlOhneZugang(url);
          if (p.options?.timeout) zeile.zeitlimitMs = p.options.timeout;
          // Nur das Modell aus dem Rumpf, nicht der ganze Prompt — der enthält
          // Platzhalter auf Mailinhalte.
          const m = String(p.jsonBody || '').match(/model:\s*'([^']+)'|models\/([\w.:-]+):generateContent/);
          if (m) zeile.modell = m[1] || m[2];
        }
        if (js.includes('candidates[0]')) {
          zeile.antwortFormat = js.includes('$json.response') ? 'Gemini + Ollama' : 'NUR Gemini';
        }
        const marke = js.match(/\/\/ PANEL:([A-Z]+ v\d+)/);
        if (marke) zeile.panelMarke = marke[1];
        if (typ === 'emailReadImap') {
          zeile.nachDemEmpfang = p.postProcessAction || '(Standard)';
          zeile.nurUngelesen = p.options?.customEmailConfig || '(Standard)';
        }
        if (typ === 'scheduleTrigger') zeile.zeitplan = JSON.stringify(p.rule || {}).slice(0, 120);
        eintrag.knoten.push(zeile);
      }
    } catch (err) {
      eintrag.fehler = err.message;
    }
    raus.push(eintrag);
  }
  return raus;
}

// Läufe samt Fehlerstelle. Ohne die rät man beim Fehlersuchen.
async function laeufe(anzahl = 15) {
  const n8n = require('./n8n');
  const namen = {};
  try { for (const w of await n8n.workflowsAuflisten()) namen[String(w.id)] = w.name; } catch { /* egal */ }
  const ex = await n8n.executionsAuflisten(anzahl);
  const liste = (Array.isArray(ex) ? ex : []).map((e) => {
    const zeile = {
      start: e.startedAt,
      status: e.status || (e.finished ? 'success' : 'unbekannt'),
      dauerSekunden: e.stoppedAt
        ? Math.round((new Date(e.stoppedAt) - new Date(e.startedAt)) / 1000) : null,
      workflow: namen[String(e.workflowId)] || e.workflowId,
    };
    const daten = e.data?.resultData;
    if (daten?.lastNodeExecuted) zeile.letzterKnoten = daten.lastNodeExecuted;
    if (daten?.error?.message) zeile.fehler = adressenTilgen(daten.error.message).slice(0, 300);
    return zeile;
  });
  const hoechste = gleichzeitigkeit(liste);
  // Bei lokaler KI rechnen gleichzeitige Läufe auf derselben CPU gegeneinander.
  // Steht hier etwas über 1, ist N8N_CONCURRENCY_PRODUCTION_LIMIT nicht
  // wirksam — und das heißt fast immer: Die docker-compose.yml wurde beim
  // Update nicht mitgezogen. Der Hinweis gehört in den Bericht, weil genau das
  // beim letzten Mal untergegangen ist.
  const lokal = (() => {
    try { return (settings.hole('ki_anbieter') || 'gemini') === 'ollama'; } catch { return false; }
  })();
  // Die Compose deckelt ab Werk auf 2. Zwei überlappende Läufe sind also der
  // eingestellte Zustand und kein Fund — den Verdacht „Compose nicht gezogen"
  // gibt es erst darüber. Ein früherer Entwurf meldete schon bei 2 Alarm und
  // hätte damit auf eine richtig eingestellte Anlage gezeigt.
  const hinweis = (() => {
    if (!lokal || hoechste <= 1) return null;
    if (hoechste === 2) {
      return '2 Läufe überlappten sich — das ist der Standardwert der Compose. Bei lokaler KI '
        + 'rechnen sie auf derselben CPU gegeneinander; N8N_PARALLEL=1 in der .env stellt das ab.';
    }
    return `${hoechste} Läufe überlappten sich, mehr als die Compose ab Werk zulässt. `
      + 'N8N_CONCURRENCY_PRODUCTION_LIMIT greift offenbar nicht — wurde die docker-compose.yml '
      + 'beim Update mitgezogen (git pull)?';
  })();

  return {
    hoechsteGleichzeitig: hoechste,
    ...(hinweis ? { hinweis } : {}),
    liste,
  };
}

// Wie viele Läufe überlappten sich zur selben Zeit höchstens?
//
// Im Bericht vom 8. September standen fünf Inbox-Triage-Läufe untereinander,
// gestartet zwischen 16:02:42 und 16:02:55, jeder knapp sechs Minuten lang und
// jeder rot. Dass sie sich überlappten, musste man aus Startzeit plus Dauer
// selbst ausrechnen — dabei ist genau das die Ursache: Sie rechneten nicht
// nacheinander, sondern gegeneinander, auf drei Kernen und einem Ollama.
// Diese eine Zahl sagt es sofort.
function gleichzeitigkeit(liste) {
  const punkte = [];
  for (const l of liste) {
    const von = Date.parse(l.start);
    if (!Number.isFinite(von)) continue;
    // Keine Dauer heißt: läuft noch. Ein solcher Lauf überlappt alles, was nach
    // ihm beginnt — und genau darum geht es hier.
    // (Number(null) wäre 0 und damit „endet sofort" — daher die eigene Prüfung.)
    const dauer = (l.dauerSekunden === null || l.dauerSekunden === undefined)
      ? NaN : Number(l.dauerSekunden);
    const bis = Number.isFinite(dauer) ? von + dauer * 1000 : Number.MAX_SAFE_INTEGER;
    punkte.push({ t: von, d: 1 });
    punkte.push({ t: bis, d: -1 });
  }
  // Endpunkte vor Startpunkten bei gleichem Zeitstempel: Ein Lauf, der genau
  // dann endet, wenn der nächste beginnt, lief nicht gleichzeitig.
  punkte.sort((a, b) => (a.t - b.t) || (a.d - b.d));
  let offen = 0;
  let hoechste = 0;
  for (const p of punkte) {
    offen += p.d;
    if (offen > hoechste) hoechste = offen;
  }
  return hoechste;
}

// Zahlen, keine Inhalte: Wie viel wurde einsortiert, von wem entschieden, was
// blieb liegen. Das beantwortet „arbeitet es überhaupt?" ohne eine einzige
// Mailzeile.
function sortierung() {
  const seit = (tage) => `datetime('now','-${tage} days')`;
  const t = (sql) => zahl(`SELECT COUNT(*) n FROM quarantine_log WHERE ${sql}`);
  return {
    entscheidungenGesamt: zahl('SELECT COUNT(*) n FROM quarantine_log'),
    heute: t(`created_at >= date('now')`),
    siebenTage: t(`created_at >= ${seit(7)}`),
    davon7Tage: {
      vonDerKi: t(`IFNULL(ki,1) = 1 AND created_at >= ${seit(7)}`),
      vonRegeln: t(`IFNULL(ki,1) = 0 AND created_at >= ${seit(7)}`),
      liegengeblieben: t(`zielordner IS NULL AND created_at >= ${seit(7)}`),
      korrigiert: t(`korrigiert_zu IS NOT NULL AND created_at >= ${seit(7)}`),
      mitGrund: t(`grund IS NOT NULL AND created_at >= ${seit(7)}`),
      virenfund: t(`virus_name IS NOT NULL AND created_at >= ${seit(7)}`),
    },
    zielordner7Tage: (() => {
      try {
        return db.prepare(`
          SELECT IFNULL(zielordner,'(liegengeblieben)') ordner, COUNT(*) anzahl
          FROM quarantine_log WHERE created_at >= datetime('now','-7 days')
          GROUP BY ordner ORDER BY anzahl DESC LIMIT 15
        `).all();
      } catch { return []; }
    })(),
    // Die häufigsten Gründe — das ist der schnellste Weg zu „warum wird nichts
    // sortiert?", und es steht kein Absender darin.
    gruende7Tage: (() => {
      try {
        return db.prepare(`
          SELECT grund, COUNT(*) anzahl FROM quarantine_log
          WHERE grund IS NOT NULL AND created_at >= datetime('now','-7 days')
          GROUP BY grund ORDER BY anzahl DESC LIMIT 10
        `).all().map((z) => ({ grund: adressenTilgen(z.grund), anzahl: z.anzahl }));
      } catch { return []; }
    })(),
    offeneZuordnung: zahl("SELECT COUNT(*) n FROM sort_inbox WHERE status='offen'"),
    regeln: zahl('SELECT COUNT(*) n FROM sort_rules'),
    themenOrdner: zahl('SELECT COUNT(*) n FROM konto_ordner'),
    bestand: {
      letzterLauf: settings.hole('bestand_letzter_lauf') || null,
      verarbeitet: Number(settings.hole('bestand_letzter_lauf_anzahl')) || 0,
      gesamt: Number(settings.hole('bestand_letzter_lauf_gesamt')) || 0,
      unklar: (() => { try { return require('./bestand').unklareAnzahl(); } catch { return null; } })(),
    },
  };
}

// Zeigt, ob die Migrationen durch sind. „Spalte grund fehlt" erklärt auf einen
// Blick, warum ein Feld leer bleibt.
function schema() {
  const spalten = (tabelle) => {
    try { return db.prepare(`PRAGMA table_info(${tabelle})`).all().map((s) => s.name); } catch { return []; }
  };
  return {
    quarantine_log: spalten('quarantine_log'),
    sort_inbox: spalten('sort_inbox'),
    accounts: spalten('accounts'),
    indizes: (() => {
      try {
        return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
          .all().map((z) => z.name);
      } catch { return []; }
    })(),
  };
}

function logzeilen(anzahl, mitMails) {
  try {
    return db.prepare(`
      SELECT created_at, level, IFNULL(source, quelle) quelle,
             IFNULL(message, nachricht) text, stack
      FROM panel_logs ORDER BY id DESC LIMIT ?
    `).all(anzahl).map((z) => ({
      zeit: z.created_at,
      stufe: z.level,
      quelle: z.quelle,
      // Logzeilen tragen Adressen mit sich („Korrektur: max@example.com von A
      // nach B"). Ohne ausdrückliche Freigabe fliegen sie hier raus.
      text: mitMails ? String(z.text || '').slice(0, 400) : adressenTilgen(z.text).slice(0, 400),
      ...(z.stack ? { stack: adressenTilgen(z.stack).split('\n').slice(0, 4).join('\n') } : {}),
    }));
  } catch (err) { return [{ fehler: err.message }]; }
}

// Nur auf ausdrücklichen Wunsch: die letzten Entscheidungen samt Absender und
// Betreff. Manchmal ist eine einzelne Fehleinordnung ohne Beispiel nicht zu
// verstehen — aber dann soll es eine bewusste Entscheidung sein.
function mailBeispiele(anzahl = 10) {
  try {
    return db.prepare(`
      SELECT created_at, konto, von, betreff, kategorie, thema, konfidenz,
             spam_score, zielordner, korrigiert_zu, grund, IFNULL(ki,1) ki
      FROM quarantine_log ORDER BY id DESC LIMIT ?
    `).all(anzahl);
  } catch (err) { return [{ fehler: err.message }]; }
}

// ─── Der ganze Bericht ──────────────────────────────────────────────────────

/**
 * @param {{mitMails?: boolean, logZeilen?: number}} opt
 *   mitMails: Absender und Betreffe mit aufnehmen (Standard: nein).
 */
async function erstellen(opt = {}) {
  const mitMails = Boolean(opt.mitMails);
  const logAnzahl = Math.min(200, Math.max(10, Number(opt.logZeilen) || 40));

  const bericht = {
    erstellt: new Date().toISOString(),
    mitMailinhalten: mitMails,
    panel: await versuch('Panel-Stand', panelStand),
    maschine: await versuch('Maschine', maschine),
    dienste: await versuch('Dienste', dienste),
    ki: await versuch('KI-Stand', kiStand),
    autoSync: await versuch('Auto-Sync', () => require('./autoSync').stand()),
    konfiguration: await versuch('Konfiguration', konfiguration),
    konten: await versuch('Konten', konten),
    workflows: await versuch('Workflows', workflows),
    laeufe: await versuch('Läufe', () => laeufe(15)),
    sortierung: await versuch('Sortierung', sortierung),
    schema: await versuch('Schema', schema),
    sicherung: await versuch('Sicherung', () => {
      const s = require('./postfachSicherung');
      const l = s.letzterLauf();
      return {
        eingerichtet: s.bereit(s.einstellungen()).length === 0,
        laeuft: s.laeuftGerade(),
        letzter: l ? { ok: l.ok, mails: l.mails, zeitpunkt: l.zeitpunkt } : null,
      };
    }),
    logs: logzeilen(logAnzahl, mitMails),
  };
  if (mitMails) bericht.letzteEntscheidungen = mailBeispiele(10);
  return bericht;
}

// ─── Als lesbarer Text ──────────────────────────────────────────────────────
//
// Der Bericht wird in ein Chatfenster geklebt, nicht von einer Maschine gelesen.
// Deshalb Markdown statt JSON: Man sieht auf den ersten Blick, was drinsteht —
// und was eben nicht.

function alsText(b) {
  const z = [];
  const abschnitt = (titel) => { z.push('', `## ${titel}`, ''); };
  const paar = (k, v) => z.push(`- **${k}:** ${v === null || v === undefined ? '—' : v}`);
  const block = (o) => z.push('```json', JSON.stringify(o, null, 2), '```');

  z.push(`# Mail-Panel — Diagnose-Bericht`);
  z.push('', `Erstellt: ${b.erstellt}`);
  z.push(b.mitMailinhalten
    ? '> **Achtung:** Dieser Bericht enthält Absender und Betreffe echter Mails.'
    : '> Ohne Mailinhalte: keine Absender, keine Betreffe. Adressen in Logzeilen sind durch `<adresse>` ersetzt.');

  abschnitt('Panel');
  for (const [k, v] of Object.entries(b.panel || {})) paar(k, v);

  abschnitt('Maschine');
  block(b.maschine);

  abschnitt('Dienste (Verbindungsversuch)');
  for (const d of b.dienste || []) {
    paar(d.name, d.ok === null ? d.grund : (d.ok ? `erreichbar (${d.ms} ms)` : `NICHT erreichbar — ${d.grund}`));
  }
  z.push('', '_Container-Zustände kann das Panel nicht sehen: Es hat bewusst keinen Zugriff auf den Docker-Socket._');

  abschnitt('KI');
  block(b.ki);

  abschnitt('Automatischer Workflow-Abgleich');
  block(b.autoSync);

  abschnitt('Konfiguration (ohne Geheimnisse)');
  block(b.konfiguration);

  abschnitt('Konten');
  block(b.konten);

  abschnitt('Workflows in n8n');
  block(b.workflows);

  abschnitt('Letzte Läufe');
  block(b.laeufe);

  abschnitt('Sortierung (Zahlen, keine Inhalte)');
  block(b.sortierung);

  abschnitt('Datenbank-Schema');
  block(b.schema);

  abschnitt('Sicherung');
  block(b.sicherung);

  abschnitt(`Logs (letzte ${(b.logs || []).length})`);
  for (const l of b.logs || []) {
    if (l.fehler) { z.push(`- ${l.fehler}`); continue; }
    z.push(`- \`${l.zeit}\` **${String(l.stufe || '').toUpperCase()}** [${l.quelle}] ${l.text}`);
    if (l.stack) z.push('  ```', `  ${l.stack.split('\n').join('\n  ')}`, '  ```');
  }

  if (b.letzteEntscheidungen) {
    abschnitt('Letzte Entscheidungen (mit Mailinhalten)');
    block(b.letzteEntscheidungen);
  }

  return z.join('\n');
}

module.exports = { erstellen, alsText, adressenTilgen, gleichzeitigkeit };
