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
  // Vom Beleg-Knoten gesetzt (aus dem Absender bzw. beim Auslesen aus dem PDF):
  '{{firma}}':        '{{ $json.firma }}',
  '{{datum}}':        '{{ $json.datum }}',
  '{{aktenzeichen}}': '{{ $json.aktenzeichen }}',
  // Interne Bausteine des Beleg-Presets (Ordner je Vorgang) — nicht in der UI.
  '{{beleg_t1}}':     '{{ $json.beleg_t1 }}',
  '{{beleg_t2}}':     '{{ $json.beleg_t2 }}',
  '{{beleg_t3}}':     '{{ $json.beleg_t3 }}',
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
    '{{firma}}':        `\${${quelle}.firma}`,
    '{{datum}}':        `\${${quelle}.datum}`,
    '{{aktenzeichen}}': `\${${quelle}.aktenzeichen}`,
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

// Enthält ein Pfad einen Wert, der von Anhang zu Anhang wechselt (Firma,
// Aktenzeichen, Absender …)? Dann darf der Ordner-Knoten NICHT nur einmal laufen —
// sonst würde bei mehreren Absendern/Vorgängen in einem Lauf nur der erste Ordner
// angelegt und der Rest liefe ins Leere. $now und $json.konto sind pro Lauf stabil.
const PRO_ITEM = /\$json\.(firma|aktenzeichen|beleg_t2|beleg_t3|von|betreff|kategorie|dateiname)\b/;

// Nextcloud legt beim Hochladen keine fehlenden Ordner an — deshalb je Ebene
// ein eigener Knoten. Existiert der Ordner schon, meldet der Knoten einen
// Fehler, der bewusst ignoriert wird.
//
// `dynamisch` = enthält der GESAMTE Zielpfad einen Pro-Anhang-Platzhalter? Wenn ja,
// darf KEIN Knoten der Kette nur einmal laufen — auch nicht der statische Anfang
// (z.B. "Belege"). Denn ein `executeOnce`-Knoten in n8n verarbeitet nur das erste
// Item und gibt genau eines weiter; er würde den Item-Strom auf einen Anhang kürzen,
// und die Ordner aller weiteren Belege eines Laufs entstünden nie. Fehlt der Wert,
// entscheidet der Teilpfad allein (für Aufrufer ausserhalb der Kette / Tests).
function ordnerKnoten(aktion, teilPfad, nummer, position, credentialId, dynamisch) {
  const einmal = dynamisch === undefined ? !PRO_ITEM.test(teilPfad) : !dynamisch;
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
    // Statischer Gesamtpfad: einmal genügt. Dynamischer: jeder Knoten je Anhang.
    executeOnce: einmal,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: credentialId
      ? { nextCloudApi: { id: String(credentialId), name: 'Mail-Panel: Nextcloud' } }
      : undefined,
  };
}

// Der Beleg-Knoten: teilt eine Mail in ein Item je Anhang, wirft alles weg, was
// kein Beleg ist, und reichert firma/datum/aktenzeichen + Dateiname an.
//
// Warum je Anhang lesen und nicht je Mail: Einer Rechnungsmail liegt oft eine AGB
// oder ein Logo bei — die sollen NICHT im Belege-Ordner landen. Nur PDFs kommen
// überhaupt in Frage (Vorfilter, ohne KI), und mit "auslesen" entscheidet das
// Panel je PDF, ob es ein aufbewahrenswerter Beleg ist.
//
// Die Mail holen wir vom Bedingungs-Knoten: dort liegen die Anhänge noch als
// Binärdaten. Der Dateiname stammt vom Absender — ohne Säuberung könnte er mit
// "/" oder ".." aus dem Zielordner ausbrechen.
function belegDatenKnoten(aktion, konfig, quellKnotenName, position) {
  const k = konfig || {};
  const auslesen = Boolean(k.auslesen);
  const geheim = process.env.PANEL_SECRET || '';
  const nameRoh = String(k.dateiname || '').trim();
  const nameAusdruck = nameRoh ? jsPlatzhalter(nameRoh, 'j') : 'rohOhne';

  // Nur beim Auslesen: das PDF ans Panel schicken und Nicht-Belege verwerfen.
  const leseBlock = auslesen ? String.raw`
    try {
      const r = await this.helpers.httpRequest({
        method: 'POST', url: 'http://panel:3002/api/internal/beleg-auslesen',
        headers: { 'X-Panel-Secret': __geheim, 'Content-Type': 'application/json' },
        body: { konto: mail.json.konto, von: mail.json.von, betreff: mail.json.betreff, dateiname: fn, pdf_base64: datei.data },
        json: true,
      });
      if (!r || r.speichern !== true) continue;
      if (r.firma) firma = String(r.firma);
      if (r.datum) datum = String(r.datum);
      if (r.aktenzeichen) aktenzeichen = String(r.aktenzeichen);
    } catch (e) { continue; }` : '';

  // Nur beim Auslesen: eigener Ordner je Vorgang (Belege/Firma/Aktenzeichen),
  // sonst nach Jahr (Belege/Jahr/Firma). Die drei Teile füllen {{beleg_t1..3}}.
  const ordnerBlock = auslesen ? String.raw`
    j.beleg_t1 = 'Belege';
    if (aktenzeichen) { j.beleg_t2 = firma; j.beleg_t3 = aktenzeichen; }
    else { j.beleg_t2 = (datum || '').slice(0, 4) || heute().slice(0, 4); j.beleg_t3 = firma; }` : '';

  const jsCode = String.raw`// Vom Mail-Panel gepflegt, bitte nicht von Hand ändern.
// Prüft je Anhang, ob es ein Beleg ist, und reichert firma/datum/aktenzeichen an.
function sauberDatei(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'beleg';
}
function firmaAus(von) {
  const a = String(von || '').toLowerCase().match(/[^<\s]+@[^>\s]+/);
  const dom = (a ? a[0].split('@')[1] : '').replace(/^(www|mail|email|smtp|mx|news|newsletter|mailer|send|bounce|reply|no-?reply)\./, '');
  const t = dom.split('.').filter(Boolean);
  let s;
  if (t.length < 2) { s = t[0] || ''; }
  else { const z = ['co','com','org','net','gov','ac']; const i = (z.indexOf(t[t.length - 2]) >= 0 && t.length >= 3) ? t.length - 3 : t.length - 2; s = t[i]; }
  s = String(s || '').replace(/[äöü]/g, (c) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' }[c])).replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'unbekannt';
}
const heute = () => new Date().toISOString().slice(0, 10);
const istPdf = (d, fn) => String((d && d.mimeType) || '').toLowerCase().indexOf('pdf') >= 0 || /\.pdf$/i.test(String(fn || ''));
const BLOCK = /agb|widerruf|datenschutz|teilnahmebedingung|nutzungsbedingung|hinweisblatt|prospekt|katalog|logo|signatur|unsubscribe/i;
const __geheim = ${JSON.stringify(geheim)};
const out = [];
for (const mail of $('${quellKnotenName}').all()) {
  const bin = mail.binary || {};
  for (const prop of Object.keys(bin)) {
    const datei = bin[prop];
    const fn = String((datei && datei.fileName) || prop || 'anhang');
    if (!istPdf(datei, fn)) continue;
    if (BLOCK.test(fn)) continue;
    const groesse = Number((datei && datei.fileSize) || 0);
    if (groesse && groesse < 5000) continue;
    let firma = firmaAus(mail.json.von);
    let datum = heute();
    let aktenzeichen = '';${leseBlock}
    const j = Object.assign({}, mail.json, { firma, datum, aktenzeichen });${ordnerBlock}
    const rohName = String(fn).split(/[\\/]/).pop();
    const endung = (rohName.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
    const rohOhne = rohName.slice(0, rohName.length - endung.length);
    const basis = ${nameAusdruck};
    j.dateiname = sauberDatei(basis) + endung;
    out.push({ json: j, binary: { data: datei } });
  }
}
return out;`;

  return {
    parameters: { mode: 'runOnceForAllItems', jsCode },
    id: `${PRAEFIX}aktion-${aktion.id}-beleg`,
    name: `Beleg lesen: ${aktion.name}`,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

// Die Ordner-Knoten liefern ihre eigene Antwort und verlieren dabei die
// Binärdaten. Für den Upload holen wir die vorbereiteten Anhänge deshalb direkt
// vom Beleg-Knoten zurück (dieselbe Technik wie früher beim Aufteil-Knoten).
function belegBereitstellenKnoten(aktion, belegDatenName, position) {
  return {
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Anhänge (mit Binärdaten) nach den Ordner-Knoten wiederherstellen.\nreturn $('${belegDatenName}').all();`,
    },
    id: `${PRAEFIX}aktion-${aktion.id}-bereit`,
    name: `Anhang bereitstellen: ${aktion.name}`,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function nextcloudDateiKnoten(aktion, konfig, position, credentialId) {
  // Ordner kommt vom Nutzer (mit Platzhaltern), der Dateiname vom Beleg-Knoten
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
      // Kette: Bedingung → Beleg lesen → Ordner je Ebene → Anhang bereitstellen → Hochladen.
      // Der Beleg-Knoten fällt zuerst (er liest die Anhänge und wirft Nicht-Belege raus);
      // die Ordner-Knoten bauen den Pfad aus den gelesenen Feldern.
      const beleg = belegDatenKnoten(a, a.konfig, wenn.name, [480, y]);
      workflow.nodes.push(beleg);
      workflow.connections[wenn.name] = { main: [[{ node: beleg.name, type: 'main', index: 0 }], []] };

      const teile = pfadSaeubern(a.konfig.ordner).split('/').filter(Boolean);
      // Ist der Gesamtpfad dynamisch (Firma/Aktenzeichen …)? Dann darf kein
      // Ordner-Knoten der Kette den Item-Strom auf einen Anhang kürzen.
      const dynamisch = PRO_ITEM.test(ausdruck(pfadSaeubern(a.konfig.ordner)));
      let vorheriger = beleg.name;
      let x = 700;
      teile.forEach((_, tiefe) => {
        const bisher = ausdruck(teile.slice(0, tiefe + 1).join('/')).replace(/^=/, '');
        const knoten = ordnerKnoten(a, bisher, tiefe + 1, [x, y], nextcloudCred, dynamisch);
        workflow.nodes.push(knoten);
        workflow.connections[vorheriger] = { main: [[{ node: knoten.name, type: 'main', index: 0 }]] };
        vorheriger = knoten.name;
        x += 220;
      });

      const bereit = belegBereitstellenKnoten(a, beleg.name, [x, y]);
      const upload = nextcloudDateiKnoten(a, a.konfig, [x + 220, y], nextcloudCred);
      workflow.nodes.push(bereit, upload);
      workflow.connections[vorheriger] = { main: [[{ node: bereit.name, type: 'main', index: 0 }]] };
      workflow.connections[bereit.name] = { main: [[{ node: upload.name, type: 'main', index: 0 }]] };
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

module.exports = {
  synchronisieren, veroeffentlichen, ausdruck, pfadSaeubern,
  belegDatenKnoten, belegBereitstellenKnoten, ordnerKnoten,
};
