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

// Liefert einen n8n-Ausdruck (mit führendem =), wenn Platzhalter enthalten sind
function ausdruck(text) {
  let s = String(text || '');
  let ersetzt = false;
  for (const [platzhalter, ausdr] of Object.entries(PLATZHALTER)) {
    if (s.includes(platzhalter)) { s = s.split(platzhalter).join(ausdr); ersetzt = true; }
  }
  return ersetzt ? `=${s}` : s;
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
  let s = String(text || '').replace(/`/g, "'");
  for (const [p, a] of Object.entries(ersatz)) s = s.split(p).join(a);
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
      jsCode: `// Ein Item je Anhang, damit der Upload-Knoten sie einzeln bekommt
const out = [];
for (const item of $('${quellKnotenName}').all()) {
  for (const [name, datei] of Object.entries(item.binary || {})) {
    out.push({
      json: { ...item.json, dateiname: datei.fileName || name },
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
  loggen('info', 'backend:aktionen', `Workflow 07 neu gebaut: ${aktionen.length} Aktion(en)`);
  return { workflow: info.name, aktionen: aktionen.length };
}

module.exports = { synchronisieren, ausdruck, pfadSaeubern };
