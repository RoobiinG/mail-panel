// Baut aus den im Panel gepflegten Aktionen die Knoten in Workflow 07.
//
// Gleiche Spielregel wie beim Konten-Patcher: Alles mit ID-Präfix "panel-" gehört
// dem Panel und wird bei jeder Änderung neu erzeugt. Die KI liefert nur den
// Entwurf einer Regel — die Knoten selbst entstehen hier aus geprüften Vorlagen,
// damit nie kaputtes Workflow-JSON in n8n landet.
const n8n      = require('./n8n');
const db       = require('./../db');
const settings = require('./settings');
const { loggen } = require('./panelLog');

const PRAEFIX = 'panel-';
const WORKFLOW_PRAEFIX = '07';
const TRIGGER = 'Von Workflow 01/04';

// ─── Platzhalter in n8n-Ausdrücke übersetzen ────────────────────────────────
const PLATZHALTER = {
  '{{jahr}}':      "{{ $now.toFormat('yyyy') }}",
  '{{monat}}':     "{{ $now.toFormat('MM') }}",
  '{{tag}}':       "{{ $now.toFormat('dd') }}",
  '{{absender}}':  '{{ $json.von }}',
  '{{betreff}}':   '{{ $json.betreff }}',
  '{{konto}}':     '{{ $json.konto }}',
  '{{kategorie}}': '{{ $json.kategorie }}',
};

// Alles, was wie ein Ausdruck aussieht, aber keiner unserer Platzhalter ist,
// wird entschärft. Sonst könnte über ein Textfeld beliebiger Code in den
// Workflow gelangen — die Vorlagen sollen aber die einzige Quelle dafür sein.
function entschaerfen(text) {
  return String(text || '')
    .replace(/\$\{/g, '(')   // JavaScript-Einschub
    .replace(/\{\{/g, '(')   // n8n-Ausdruck
    .replace(/\}\}/g, ')');
}

// Liefert einen n8n-Ausdruck (mit führendem =), wenn Platzhalter enthalten sind
function ausdruck(text) {
  const roh = String(text || '');
  const gefunden = Object.keys(PLATZHALTER).filter((p) => roh.includes(p));
  if (gefunden.length === 0) return entschaerfen(roh);

  // Erst die bekannten Platzhalter markieren, dann den Rest entschärfen,
  // damit nur unsere eigenen Ausdrücke übrig bleiben.
  let s = roh;
  gefunden.forEach((p, i) => { s = s.split(p).join(`\u0000${i}\u0000`); });
  s = entschaerfen(s);
  gefunden.forEach((p, i) => { s = s.split(`\u0000${i}\u0000`).join(PLATZHALTER[p]); });
  return `=${s}`;
}

// Pfadangaben säubern: keine Sprünge nach oben, keine doppelten Schrägstriche
function pfadSaeubern(pfad) {
  return String(pfad || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((t) => t && t !== '.' && t !== '..')
    .join('/');
}

// Dieselben Platzhalter, aber als JavaScript-Ausdruck (für Knoten, die ihre
// Werte in JSON zusammenbauen). `quelle` ist der Ausdruck, der die Mail liefert.
function jsPlatzhalter(text, quelle) {
  const ersatz = {
    '{{jahr}}':      "${$now.toFormat('yyyy')}",
    '{{monat}}':     "${$now.toFormat('MM')}",
    '{{tag}}':       "${$now.toFormat('dd')}",
    '{{absender}}':  `\${${quelle}.von}`,
    '{{betreff}}':   `\${${quelle}.betreff}`,
    '{{konto}}':     `\${${quelle}.konto}`,
    '{{kategorie}}': `\${${quelle}.kategorie}`,
  };
  // Rückwärts-Anführungszeichen würden das Template beenden, ${…} beliebigen
  // Code einschleusen — beides wird entfernt, bevor die Platzhalter kommen.
  const marke = (i) => `\u0000${i}\u0000`;
  const roh = String(text || '').replace(/`/g, "'");
  const gefunden = Object.keys(ersatz).filter((p) => roh.includes(p));
  let s = roh;
  gefunden.forEach((p, i) => { s = s.split(p).join(marke(i)); });
  s = entschaerfen(s);
  gefunden.forEach((p, i) => { s = s.split(marke(i)).join(ersatz[p]); });
  return '`' + s + '`';
}

// ─── Bedingung → IF-Knoten ──────────────────────────────────────────────────
const OPERATOR = {
  enthaelt:    { type: 'string', operation: 'contains' },
  ist:         { type: 'string', operation: 'equals' },
  endet_auf:   { type: 'string', operation: 'endsWith' },
  beginnt_mit: { type: 'string', operation: 'startsWith' },
  ist_wahr:    { type: 'boolean', operation: 'true', singleValue: true },
};

function bedingungsKnoten(aktion, bedingung, position) {
  const regeln = (bedingung.regeln || []).map((r, i) => ({
    id: `regel-${aktion.id}-${i}`,
    leftValue: r.feld === 'hat_anhang'
      // Anhänge stecken nicht im JSON, sondern in den Binärdaten des Items
      ? '={{ $binary ? Object.keys($binary).length > 0 : false }}'
      : `={{ $json.${r.feld} }}`,
    rightValue: r.vergleich === 'ist_wahr' ? '' : r.wert,
    operator: OPERATOR[r.vergleich],
  }));

  return {
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: regeln,
        combinator: bedingung.verknuepfung === 'oder' ? 'or' : 'and',
      },
      options: {},
    },
    id: `${PRAEFIX}aktion-${aktion.id}-wenn`,
    name: `Wenn: ${aktion.name}`,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
  };
}

// ─── Aktion → Knoten ────────────────────────────────────────────────────────

// Nextcloud legt beim Hochladen keine fehlenden Ordner an — deshalb je Ebene
// ein eigener Knoten. Existiert der Ordner schon, meldet der Knoten einen
// Fehler, der bewusst ignoriert wird.
function ordnerKnoten(aktion, teilPfad, nummer, position, credentialId) {
  return {
    parameters: {
      resource: 'folder',
      operation: 'create',
      path: `=${teilPfad}`,
    },
    id: `${PRAEFIX}aktion-${aktion.id}-ordner${nummer}`,
    name: `Ordner ${nummer}: ${aktion.name}`,
    type: 'n8n-nodes-base.nextCloud',
    typeVersion: 1,
    position,
    executeOnce: true,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: credentialId
      ? { nextCloudApi: { id: String(credentialId), name: 'Mail-Panel: Nextcloud' } }
      : undefined,
  };
}

// Teilt eine Mail mit mehreren Anhängen in ein Item je Anhang auf.
// Der Nextcloud-Knoten kann immer nur eine Datei auf einmal hochladen.
// Die Mail holen wir uns ausdrücklich vom Bedingungs-Knoten: Die Ordner-Knoten
// davor liefern ihre eigene Antwort und hätten die Anhänge längst verworfen.
function anhaengeAufteilenKnoten(aktion, position, quellKnotenName) {
  return {
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Ein Item je Anhang, damit der Upload-Knoten sie einzeln bekommt.
// Der Dateiname stammt aus der Mail und damit vom Absender — ohne Säuberung
// könnte er mit "../" aus dem Zielordner ausbrechen.
function sauberer(name) {
  const roh = String(name || 'anhang').split(/[\\\\/]/).pop();
  const geputzt = roh.replace(/^\\.+/, '').replace(/[\\x00-\\x1f]/g, '').trim();
  return geputzt.slice(0, 120) || 'anhang';
}

const out = [];
for (const item of $('${quellKnotenName}').all()) {
  for (const [name, datei] of Object.entries(item.binary || {})) {
    out.push({
      json: { ...item.json, dateiname: sauberer(datei.fileName || name) },
      binary: { data: datei },
    });
  }
}
return out;`,
    },
    id: `${PRAEFIX}aktion-${aktion.id}-anhaenge`,
    name: `Anhänge: ${aktion.name}`,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function nextcloudDateiKnoten(aktion, konfig, position, credentialId) {
  // Ordner kommt vom Nutzer (mit Platzhaltern), der Dateiname vom Aufteil-Knoten
  const ordner = ausdruck(pfadSaeubern(konfig.ordner)).replace(/^=/, '');
  return {
    parameters: {
      resource: 'file',
      operation: 'upload',
      path: `=${ordner}/{{ $json.dateiname }}`,
      binaryDataUpload: true,
      binaryPropertyName: 'data',
    },
    id: `${PRAEFIX}aktion-${aktion.id}-tun`,
    name: `Nextcloud: ${aktion.name}`,
    type: 'n8n-nodes-base.nextCloud',
    typeVersion: 1,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: credentialId
      ? { nextCloudApi: { id: String(credentialId), name: 'Mail-Panel: Nextcloud' } }
      : undefined,
  };
}

// Kalendereintrag per CalDAV — dafür genügt ein HTTP-Knoten mit Basic-Auth
function nextcloudKalenderKnoten(aktion, konfig, position, credentialId) {
  const basis = String(settings.hole('nextcloud_url') || '').replace(/\/$/, '');
  const user = settings.hole('nextcloud_user');
  const kalender = settings.hole('nextcloud_kalender') || 'personal';
  const dauer = Number(konfig.dauer_minuten) || 60;

  return {
    parameters: {
      method: 'PUT',
      url: `=${basis}/remote.php/dav/calendars/${encodeURIComponent(user)}/${encodeURIComponent(kalender)}/mailpanel-{{ $json.uid || $now.toMillis() }}.ics`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/calendar; charset=utf-8',
      body: `=BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Mail-Panel//DE\nBEGIN:VEVENT\nUID:mailpanel-{{ $json.uid || $now.toMillis() }}\nDTSTAMP:{{ $now.toFormat("yyyyMMdd'T'HHmmss'Z'") }}\nDTSTART:{{ $now.toFormat("yyyyMMdd'T'HHmmss'Z'") }}\nDTEND:{{ $now.plus({ minutes: ${dauer} }).toFormat("yyyyMMdd'T'HHmmss'Z'") }}\nSUMMARY:${String(ausdruck(konfig.titel)).replace(/^=/, '')}\nDESCRIPTION:Von {{ $json.von }}\nEND:VEVENT\nEND:VCALENDAR`,
      options: {},
    },
    id: `${PRAEFIX}aktion-${aktion.id}-tun`,
    name: `Kalender: ${aktion.name}`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: credentialId
      ? { httpBasicAuth: { id: String(credentialId), name: 'Mail-Panel: Nextcloud' } }
      : undefined,
  };
}

// Google-Kalender: Der fertige n8n-Knoten kann nur OAuth2, und diese Anmeldung
// läuft in der n8n-Oberfläche. Damit alles im Panel bleibt, holt der Workflow
// den Zugriffs-Token beim Panel ab und ruft Google dann direkt auf.
function googleTokenKnoten(aktion, position, panelCredentialId) {
  return {
    parameters: {
      method: 'GET',
      url: 'http://panel:3002/api/internal/google-token',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
    },
    id: `${PRAEFIX}aktion-${aktion.id}-token`,
    name: `Google-Token: ${aktion.name}`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: panelCredentialId
      ? { httpHeaderAuth: { id: String(panelCredentialId), name: 'Mail-Panel: Prüfdienste' } }
      : undefined,
  };
}

function googleKalenderKnoten(aktion, konfig, position, wennKnotenName) {
  const kalender = settings.hole('google_kalender_id') || 'primary';
  const dauer = Number(konfig.dauer_minuten) || 60;
  // Der Token-Knoten davor hat das Item ersetzt — die Mail holen wir uns deshalb
  // ausdrücklich vom Bedingungs-Knoten.
  const mail = `$('${wennKnotenName}').item.json`;
  const titel = jsPlatzhalter(konfig.titel, mail);

  return {
    parameters: {
      method: 'POST',
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(kalender)}/events`,
      sendHeaders: true,
      headerParameters: {
        parameter: [{ name: 'Authorization', value: '={{ "Bearer " + $json.access_token }}' }],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ summary: ${titel}, description: 'Aus einer E-Mail von ' + ${mail}.von, start: { dateTime: $now.toISO() }, end: { dateTime: $now.plus({ minutes: ${dauer} }).toISO() } }) }}`,
      options: {},
    },
    id: `${PRAEFIX}aktion-${aktion.id}-tun`,
    name: `Google-Kalender: ${aktion.name}`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  };
}

function webhookKnoten(aktion, konfig, position) {
  return {
    parameters: {
      method: konfig.methode || 'POST',
      url: konfig.url,
      sendBody: (konfig.methode || 'POST') !== 'GET',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ konto: $json.konto, von: $json.von, betreff: $json.betreff, kategorie: $json.kategorie, zielordner: $json.zielordner }) }}',
      options: {},
    },
    id: `${PRAEFIX}aktion-${aktion.id}-tun`,
    name: `Aufruf: ${aktion.name}`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  };
}

// ─── Workflow 07 neu aufbauen ───────────────────────────────────────────────

function aktiveAktionen() {
  return db.prepare('SELECT * FROM aktionen WHERE aktiv = 1 ORDER BY id').all().map((a) => ({
    ...a,
    bedingung: JSON.parse(a.bedingung || '{}'),
    konfig: JSON.parse(a.konfig || '{}'),
  }));
}

async function workflowSuchen(praefix) {
  const alle = await n8n.workflowsAuflisten();
  const treffer = alle.find((w) => String(w.name).trim().startsWith(praefix));
  if (!treffer) throw new Error(`Workflow "${praefix} - ..." fehlt in n8n — bitte auf der Workflows-Seite neu importieren.`);
  return treffer;
}

// Workflow 07 ist ein Unter-Workflow ohne eigenen Auslöser. Ab n8n 2 muss er
// trotzdem veröffentlicht sein, sonst verweigert n8n das Einschalten der
// Workflows, die ihn aufrufen. Ein Fehler hier darf den Rest nicht aufhalten.
async function veroeffentlichen(id) {
  try {
    await n8n.workflowAktivieren(id, true);
    return true;
  } catch (err) {
    loggen('warn', 'backend:aktionen', `Workflow 07 konnte nicht veröffentlicht werden: ${err.message}`);
    return false;
  }
}

async function synchronisieren() {
  const info = await workflowSuchen(WORKFLOW_PRAEFIX);
  const workflow = await n8n.workflowHolen(info.id);

  // Alles Panel-Eigene raus (wiederholbar)
  const raus = new Set(workflow.nodes.filter((k) => String(k.id || '').startsWith(PRAEFIX)).map((k) => k.name));
  workflow.nodes = workflow.nodes.filter((k) => !raus.has(k.name));
  const verbindungen = {};
  for (const [quelle, wert] of Object.entries(workflow.connections || {})) {
    if (raus.has(quelle)) continue;
    verbindungen[quelle] = { ...wert, main: (wert.main || []).map((a) => (a || []).filter((z) => !raus.has(z.node))) };
  }
  workflow.connections = verbindungen;

  const nextcloudCred = db.prepare("SELECT value FROM settings WHERE key = 'n8n_nextcloud_credential_id'").get()?.value;
  const basicCred     = db.prepare("SELECT value FROM settings WHERE key = 'n8n_nextcloud_basic_id'").get()?.value;
  const panelCred     = db.prepare("SELECT value FROM settings WHERE key = 'n8n_panel_credential_id'").get()?.value;

  const aktionen = aktiveAktionen();
  aktionen.forEach((a, i) => {
    const y = 100 + i * 220;
    const wenn = bedingungsKnoten(a, a.bedingung, [240, y]);
    workflow.nodes.push(wenn);
    workflow.connections[TRIGGER] = workflow.connections[TRIGGER] || { main: [[]] };
    workflow.connections[TRIGGER].main[0].push({ node: wenn.name, type: 'main', index: 0 });

    if (a.typ === 'nextcloud_datei') {
      // Kette: Bedingung → Ordner je Ebene → Anhänge aufteilen → Hochladen
      const teile = pfadSaeubern(a.konfig.ordner).split('/').filter(Boolean);
      let vorheriger = wenn.name;
      let x = 480;
      teile.forEach((_, tiefe) => {
        const bisher = ausdruck(teile.slice(0, tiefe + 1).join('/')).replace(/^=/, '');
        const knoten = ordnerKnoten(a, bisher, tiefe + 1, [x, y], nextcloudCred);
        workflow.nodes.push(knoten);
        workflow.connections[vorheriger] = vorheriger === wenn.name
          ? { main: [[{ node: knoten.name, type: 'main', index: 0 }], []] }
          : { main: [[{ node: knoten.name, type: 'main', index: 0 }]] };
        vorheriger = knoten.name;
        x += 220;
      });

      const teilen = anhaengeAufteilenKnoten(a, [x, y], wenn.name);
      const upload = nextcloudDateiKnoten(a, a.konfig, [x + 220, y], nextcloudCred);
      workflow.nodes.push(teilen, upload);
      workflow.connections[vorheriger] = vorheriger === wenn.name
        ? { main: [[{ node: teilen.name, type: 'main', index: 0 }], []] }
        : { main: [[{ node: teilen.name, type: 'main', index: 0 }]] };
      workflow.connections[teilen.name] = { main: [[{ node: upload.name, type: 'main', index: 0 }]] };
    } else if (a.typ === 'google_kalender') {
      const token = googleTokenKnoten(a, [480, y], panelCred);
      const termin = googleKalenderKnoten(a, a.konfig, [720, y], wenn.name);
      workflow.nodes.push(token, termin);
      workflow.connections[wenn.name] = { main: [[{ node: token.name, type: 'main', index: 0 }], []] };
      workflow.connections[token.name] = { main: [[{ node: termin.name, type: 'main', index: 0 }]] };
    } else {
      const knoten = a.typ === 'nextcloud_kalender'
        ? nextcloudKalenderKnoten(a, a.konfig, [480, y], basicCred)
        : webhookKnoten(a, a.konfig, [480, y]);
      workflow.nodes.push(knoten);
      workflow.connections[wenn.name] = { main: [[{ node: knoten.name, type: 'main', index: 0 }], []] };
    }
  });

  await n8n.workflowSpeichern(info.id, workflow);
  // n8n schaltet einen Workflow beim Speichern ab. Workflow 07 muss aber
  // veröffentlicht bleiben: Ab n8n 2 lassen sich die Workflows 01 und 04 sonst
  // gar nicht mehr einschalten („references workflow … which is not published").
  const veroeffentlicht = await veroeffentlichen(info.id);
  loggen('info', 'backend:aktionen', `Workflow 07 neu gebaut: ${aktionen.length} Aktion(en)`);
  return { workflow: info.name, aktionen: aktionen.length, veroeffentlicht };
}

module.exports = { synchronisieren, veroeffentlichen, ausdruck, pfadSaeubern };
