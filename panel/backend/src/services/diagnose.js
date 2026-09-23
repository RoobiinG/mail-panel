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
const telegram = require('./telegram');

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
  auftraege.push(auftrag('Ollama', settings.hole('ollama_url'), 11434));
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
    'ki_text_kurz', 'ki_text_lang', 'ollama_url', 'ollama_modell',
    'ollama_kontext', 'ollama_buendel', 'ki_lauf_frist_ms',
    'auto_sync', 'neue_mails_ungelesen', 'spam_schwellwert', 'clamav_aktiv',
    'safebrowsing_aktiv', 'bestand_intervall', 'bestand_fenster', 'bestand_reihenfolge',
    'themen_sortierung_aktiv', 'themen_ordner_max', 'themen_konfidenz', 'n8n_url',
    'beleg_ocr_aktiv',
  ];
  const geheim = [
    'n8n_api_key', 'mailcow_api_key', 'safebrowsing_api_key',
    'telegram_token', 'nextcloud_passwort', 'smtp_passwort', 'sicherung_passwort',
    // Kein Geheimnis, steht aber trotzdem nur als „gesetzt" hier: Eine Chat-ID
    // zeigt auf einen realen Menschen, und ein Diagnose-Bericht ist zum
    // Weitergeben gedacht. Für die Fehlersuche zählt ohnehin nur, OB sie da ist —
    // ohne sie kann Workflow 02 nichts zustellen.
    'telegram_chat_id',
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
  return {
    anbieter: 'ollama',
    modellInBenutzung: settings.hole('ollama_modell') || '(nicht gesetzt)',
    lokal: (() => {
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
        messung: require('./ollamaMessung').stand(),
      };
    })(),
    heuteMails: budget.protokolliertHeute(),
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
        // Telegram und der Postausgang gehören dazu, obwohl sie weder Adresse
        // noch Code haben. Genau das war die Lücke: Ein stillgelegter
        // Telegram-Knoten tauchte im Bericht nirgends auf, der Lauf war grün,
        // und die Frage „warum kommt keine Nachricht?" liess sich aus dem
        // Bericht nicht beantworten.
        const meldeTyp = typ === 'telegram' || typ === 'telegramTrigger' || typ === 'emailSend';
        const interessant = url || meldeTyp || js.includes('candidates[0]') || js.includes('PANEL:')
          || typ === 'emailReadImap' || typ.includes('Trigger') || typ === 'scheduleTrigger';
        if (!interessant) continue;

        const zeile = { name: k.name, typ, ...(k.disabled ? { deaktiviert: true } : {}) };
        if (meldeTyp) {
          // Ohne Zugangsdaten legt der Patcher den Knoten still; n8n überspringt
          // ihn dann wortlos.
          zeile.zugangsdaten = k.credentials && Object.keys(k.credentials).length
            ? 'hinterlegt' : 'FEHLEN';
        }
        if (typ === 'telegram') {
          // Die Chat-ID selbst gehört nicht in einen Bericht, der weitergegeben
          // wird — nur, ob dort noch der Platzhalter aus der Vorlage steht.
          zeile.chatId = telegram.istPlatzhalter(p.chatId) ? 'PLATZHALTER (nie eingetragen)' : 'gesetzt';
        }
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
      // Wie der Lauf ausgelöst wurde. „integrated" ist ein Unter-Workflow
      // (07 aus 01/04), „manual" ein Klick im Editor — beide zählen nicht gegen
      // N8N_CONCURRENCY_PRODUCTION_LIMIT.
      ...(e.mode ? { modus: e.mode } : {}),
      // Beide Zeiten müssen stimmen. Ein abgebrochener Lauf kommt ohne
      // startedAt zurück, und `new Date(null)` ist nicht ungültig, sondern der
      // 1. Januar 1970 — im Bericht stand dann eine Dauer von 1788920178
      // Sekunden, also siebenundfünfzig Jahren.
      dauerSekunden: (() => {
        const a = Date.parse(e.startedAt || '');
        const b = Date.parse(e.stoppedAt || '');
        return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : null;
      })(),
      workflow: namen[String(e.workflowId)] || e.workflowId,
    };
    const daten = e.data?.resultData;
    if (daten?.lastNodeExecuted) zeile.letzterKnoten = daten.lastNodeExecuted;
    if (daten?.error?.message) zeile.fehler = adressenTilgen(daten.error.message).slice(0, 300);
    // Für den Nachschlag unten: Ohne die id lässt sich der Lauf nicht noch
    // einmal fragen. Sie fliegt gleich wieder raus, sie gehört nicht in den
    // Bericht.
    if (e.id != null) zeile.__id = e.id;
    // Die genauen Zeiten für die Überlappung. dauerSekunden ist gerundet: Aus
    // einem Lauf von 0,6 s wurde 1 s, und der überlappte dann einen zweiten, der
    // 0,65 s später begann — obwohl beide nacheinander liefen.
    zeile.__vonMs = Date.parse(e.startedAt || '');
    zeile.__bisMs = Date.parse(e.stoppedAt || '');
    return zeile;
  });

  // Gescheiterte Läufe einzeln nachfragen.
  //
  // `/executions` liefert nur „error" und schweigt darüber, woran. Genau das
  // fehlte beim Lauf vom 12.09., 01:34 Uhr: 23 Sekunden, Abbruch, keine Spur.
  // Die volle Liste mit Daten zu holen wäre zu teuer — ein Bestandslauf trägt
  // hunderte Mails mit sich —, also nur die wenigen, die etwas zu erklären
  // haben, und höchstens drei davon.
  const FEHLER_MAX = 3;
  const nachzufragen = liste
    .filter((z) => z.__id != null && !z.fehler && z.status !== 'success' && z.status !== 'running')
    .slice(0, FEHLER_MAX);
  for (const zeile of nachzufragen) {
    const detail = await n8n.executionFehler(zeile.__id);
    if (!detail) continue;
    if (detail.meldung) zeile.fehler = adressenTilgen(detail.meldung).slice(0, 300);
    if (detail.knoten) zeile.fehlerKnoten = detail.knoten;
    if (detail.letzterKnoten && !zeile.letzterKnoten) zeile.letzterKnoten = detail.letzterKnoten;
  }

  // Wo lange Läufe ihre Zeit lassen — nur Knotenname und Sekunden.
  //
  // Diagnosebericht vom 23.09.: ein Bestandslauf mit 1.144 s bei einer KI-Frist
  // von 600 s. Die KI allein erklärt das nicht, aber welcher Knoten dann? Das
  // steht nur in den Laufdaten, die die Liste nicht mitliefert. Also für die
  // drei längsten Läufe über zwei Minuten einzeln nachfragen.
  const LANG_SEKUNDEN = 120;
  const LANG_MAX = 3;
  const lange = liste
    .filter((z) => z.__id != null && Number(z.dauerSekunden) >= LANG_SEKUNDEN)
    .sort((a, b) => b.dauerSekunden - a.dauerSekunden)
    .slice(0, LANG_MAX);
  for (const zeile of lange) {
    const zeiten = typeof n8n.executionKnotenZeiten === 'function'
      ? await n8n.executionKnotenZeiten(zeile.__id)
      : null;
    if (!zeiten || zeiten.length === 0) continue;
    zeile.langsamsteKnoten = zeiten.slice(0, 5).map((k) => ({
      knoten: k.knoten,
      sekunden: Math.round(k.ms / 100) / 10,
      ...(k.items ? { items: k.items } : {}),
    }));
  }

  // Gezählt wird nur, was N8N_CONCURRENCY_PRODUCTION_LIMIT überhaupt begrenzt:
  // Läufe, die ein Auslöser (Zeitplan, IMAP, Webhook) gestartet hat.
  // Unter-Workflows (07, von 01/04 ohne Warten aufgerufen) und Klicks im Editor
  // laufen daneben. Genau das stand im Bericht vom 23.09. als „3 Läufe
  // überlappten sich … Compose greift nicht": zwei Inbox-Läufe plus ein
  // Workflow 07 — und die zwei überlappten auch nur wegen der Rundung.
  // Ein abgestürzter Lauf ohne Endzeit ist kein laufender: Er überlappte sonst
  // alles, was nach ihm kam, bis ans Ende der Liste.
  const laeuftNoch = (z) => ['running', 'new', 'waiting', 'unbekannt'].includes(String(z.status || 'unbekannt'));
  const zaehlt = (z) => !['integrated', 'manual', 'retry', 'internal', 'cli', 'error'].includes(String(z.modus || ''))
    && (Number.isFinite(z.__bisMs) || laeuftNoch(z));
  const begrenzte = liste.filter(zaehlt);
  const unterlaeufe = liste.length - begrenzte.length;
  const hoechste = gleichzeitigkeit(begrenzte);
  for (const zeile of liste) { delete zeile.__id; delete zeile.__vonMs; delete zeile.__bisMs; }

  // Welche Grenze gilt? Die Compose reicht N8N_PARALLEL auch ans Panel weiter;
  // fehlt es, gilt der Standard der Compose (2).
  const grenze = Math.max(1, Math.floor(Number(process.env.N8N_PARALLEL)) || 2);
  const eingestellt = Boolean(process.env.N8N_PARALLEL) && grenze !== 2;
  // Bei lokaler KI rechnen gleichzeitige Läufe auf derselben CPU gegeneinander.
  // Bis zur Grenze ist das der eingestellte Zustand und kein Fund — den
  // Verdacht „Compose nicht gezogen" gibt es erst darüber. Ein früherer
  // Entwurf meldete schon bei 2 Alarm und hätte damit auf eine richtig
  // eingestellte Anlage gezeigt.
  const hinweis = (() => {
    if (hoechste <= 1) return null;
    if (hoechste <= grenze) {
      return `${hoechste} Läufe überlappten sich — `
        + (eingestellt ? `erlaubt sind ${grenze} (N8N_PARALLEL). ` : 'das ist der Standardwert der Compose. ')
        + 'Bei lokaler KI rechnen sie auf derselben CPU gegeneinander; N8N_PARALLEL=1 in der .env stellt das ab.';
    }
    return `${hoechste} Läufe überlappten sich, mehr als ${eingestellt ? `N8N_PARALLEL=${grenze}` : 'die Compose ab Werk'} zulässt. `
      + 'N8N_CONCURRENCY_PRODUCTION_LIMIT greift offenbar nicht — wurde die docker-compose.yml '
      + 'beim Update mitgezogen (git pull)?';
  })();

  return {
    hoechsteGleichzeitig: hoechste,
    grenze,
    ...(unterlaeufe ? { nichtGezaehlt: `${unterlaeufe} Unter-Workflow- oder Editor-Läufe (zählen nicht gegen die Grenze)` } : {}),
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
    const von = Number.isFinite(l.__vonMs) ? l.__vonMs : Date.parse(l.start);
    if (!Number.isFinite(von)) continue;
    // Keine Dauer heißt: läuft noch. Ein solcher Lauf überlappt alles, was nach
    // ihm beginnt — und genau darum geht es hier.
    // (Number(null) wäre 0 und damit „endet sofort" — daher die eigene Prüfung.)
    // Mit genauer Endzeit (aus stoppedAt) wird die genommen statt der
    // gerundeten Sekunden.
    const dauer = (l.dauerSekunden === null || l.dauerSekunden === undefined)
      ? NaN : Number(l.dauerSekunden);
    const bis = Number.isFinite(l.__bisMs)
      ? l.__bisMs
      : (Number.isFinite(dauer) ? von + dauer * 1000 : Number.MAX_SAFE_INTEGER);
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

module.exports = { erstellen, alsText, adressenTilgen, gleichzeitigkeit, urlOhneZugang };
