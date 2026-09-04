// Verdrahtet die im Panel gepflegten IMAP-Konten in die n8n-Workflows.
//
// Spielregel: Alle Knoten, deren ID mit "panel-" beginnt, gehören dem Panel und
// werden bei jedem Sync neu erzeugt. Wer sie in n8n von Hand ändert, verliert die
// Änderung beim nächsten Konto-Sync — alles andere im Workflow bleibt unangetastet.
const n8n = require('./n8n');
const db  = require('../db');
const fs  = require('fs');
const path = require('path');
const settings = require('./settings');
const code = require('./workflowCode');

const PRAEFIX = 'panel-';
// Ankerpunkte in den Workflow-Vorlagen, an die das Panel andockt
const ANKER = {
  triage: {
    workflowPraefix: '01',
    ziel: 'Normalisieren',      // dorthin laufen die Konto-Trigger
    weiche: 'Verschieben?',     // davor sitzt die Konto-Weiche
  },
  bestand: {
    workflowPraefix: '04',
    kopf: 'Manuell starten',        // Kopf der Abrufkette
    ziel: 'Sammeln + Normalisieren',
    weiche: 'Verschieben?',
  },
  newsletter: {
    workflowPraefix: '03',
    trigger: 'Sonntags 3:00',
  },
};

const istPanelKnoten = (knoten) => String(knoten.id || '').startsWith(PRAEFIX);

// Ordnernamen landen als Werte in n8n-Knoten. Beginnt ein Wert dort mit "=",
// wertet n8n ihn als Ausdruck aus — ein Ordner namens "={{ $env.PANEL_SECRET }}"
// würde also das Panel-Secret in die Mail-Daten schreiben. Deshalb wird alles
// entfernt, was wie ein Ausdruck aussieht. Ein Ordnername braucht das nie.
function ordnerName(wert, standard = '') {
  const roh = String(wert || '').trim();
  if (!roh) return standard;
  return roh
    .replace(/^=+/, '')          // führendes = macht in n8n einen Ausdruck daraus
    .split('{{').join('(')       // n8n-Ausdruck
    .split('}}').join(')')
    .split('${').join('(')       // JavaScript-Einschub
    .trim() || standard;
}

// ─── Knoten-Bausteine ────────────────────────────────────────────────────────

function triggerKnoten(konto, position) {
  return {
    parameters: {
      mailbox: 'INBOX',
      postProcessAction: 'read',
      // "resolved" liefert die vollständigen Kopfzeilen (nötig für die
      // Absender-IP der DNSBL-Prüfung).
      format: 'resolved',
      // Erst damit landen Anhänge als Binärdaten im Item — ohne sie kann weder
      // der Virenscan noch eine Datei-Aktion etwas ausrichten.
      downloadAttachments: true,
      options: {},
    },
    id: `${PRAEFIX}${konto.id}-trigger`,
    name: `${konto.name} (IMAP)`,
    type: 'n8n-nodes-base.emailReadImap',
    typeVersion: 2,
    position,
    credentials: { imap: { id: String(konto.n8n_credential_id), name: `Mail-Panel: ${konto.name}` } },
  };
}

function setKnoten(konto, position) {
  return {
    parameters: {
      assignments: {
        assignments: [
          { id: `konto-${konto.id}`, name: 'konto', value: konto.name, type: 'string' },
          { id: `f1-${konto.id}`, name: 'folder_spam', value: ordnerName(konto.folder_spam), type: 'string' },
          { id: `f2-${konto.id}`, name: 'folder_invoices', value: ordnerName(konto.folder_invoices), type: 'string' },
          { id: `f3-${konto.id}`, name: 'folder_orders', value: ordnerName(konto.folder_orders), type: 'string' },
          { id: `f4-${konto.id}`, name: 'folder_newsletter', value: ordnerName(konto.folder_newsletter), type: 'string' },
        ],
      },
      includeOtherFields: true,
      options: {},
    },
    id: `${PRAEFIX}${konto.id}-set`,
    name: `Konto: ${konto.name}`,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
  };
}

// Postfach-Felder des Community-Nodes sind resourceLocator — im Modus "path"
// nehmen sie auch Ausdrücke entgegen.
const postfach = (wert) => ({ __rl: true, mode: 'path', value: wert });

// Der Community-Node kann das eingebaute imap-Credential mitbenutzen —
// dafür muss authentication auf "coreImapAccount" stehen (Standard wäre ein
// eigenes imapApi-Credential).
const imapCredential = (konto) => ({
  imap: { id: String(konto.n8n_credential_id), name: `Mail-Panel: ${konto.name}` },
});

function verschiebeKnoten(konto, position) {
  return {
    parameters: {
      authentication: 'coreImapAccount',
      resource: 'email',
      operation: 'moveEmail',
      sourceMailbox: postfach('INBOX'),
      emailUid: '={{ $json.uid }}',
      destinationMailbox: postfach('={{ $json.zielordner }}'),
    },
    id: `${PRAEFIX}${konto.id}-move`,
    name: `Verschieben: ${konto.name}`,
    type: 'n8n-nodes-imap.imap',
    typeVersion: 1,
    position,
    credentials: imapCredential(konto),
  };
}

// ── Workflow 03: Newsletter, die älter als 30 Tage sind, ins Archiv ─────────
// Suchknoten je Konto: liefert die alten Mails aus dem Newsletter-Ordner.
function altNewsletterKnoten(konto, position) {
  const quelle = ordnerName(konto.folder_newsletter, 'Newsletter');
  return {
    parameters: {
      authentication: 'coreImapAccount',
      resource: 'email',
      operation: 'getEmailsList',
      mailboxPath: postfach(quelle),
      // Nur die Kopfdaten — verschoben wird über die UID
      includeParts: [],
      limit: 200,
    },
    id: `${PRAEFIX}${konto.id}-nl-alt`,
    name: `Alte Newsletter: ${konto.name}`,
    type: 'n8n-nodes-imap.imap',
    typeVersion: 1,
    position,
    executeOnce: true,
    alwaysOutputData: true,
    // Fehlt der Ordner in einem Postfach, sollen die anderen Konten weiterlaufen
    onError: 'continueRegularOutput',
    credentials: imapCredential(konto),
  };
}

// Verschiebeknoten je Konto: Newsletter-Ordner -> Archiv
function archivKnoten(konto, position) {
  const quelle = ordnerName(konto.folder_newsletter, 'Newsletter');
  const ziel   = ordnerName(konto.folder_archive, 'Archiv');
  return {
    parameters: {
      authentication: 'coreImapAccount',
      resource: 'email',
      operation: 'moveEmail',
      sourceMailbox: postfach(quelle),
      emailUid: '={{ $json.uid }}',
      destinationMailbox: postfach(ziel),
    },
    id: `${PRAEFIX}${konto.id}-nl-archiv`,
    name: `Ins Archiv: ${konto.name}`,
    type: 'n8n-nodes-imap.imap',
    typeVersion: 1,
    position,
    onError: 'continueRegularOutput',
    credentials: imapCredential(konto),
  };
}

// Nur Mails, die älter als 30 Tage sind — als n8n-Ausdruck, damit das Datum
// bei jedem Lauf neu berechnet wird.
const AELTER_ALS_30_TAGE = "={{ 'BEFORE ' + $now.minus({ days: 30 }).toFormat('dd-MMM-yyyy') }}";

// Weiche, die nach dem Feld "konto" auf die passende Verschiebe-Aktion verzweigt.
// Die Ausgänge folgen der Reihenfolge der Konten.
function weichenKnoten(konten, position) {
  const regel = (wert) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: `sw-${wert}`,
        leftValue: '={{ $json.konto }}',
        rightValue: wert,
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey: wert,
  });
  return {
    parameters: {
      rules: { values: konten.map((k) => regel(k.name)) },
      options: {},
    },
    id: `${PRAEFIX}weiche`,
    name: 'Nach Konto',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position,
  };
}

function bestandKnoten(konto, position) {
  return {
    parameters: {
      authentication: 'coreImapAccount',
      resource: 'email',
      operation: 'getEmailsList',
      mailboxPath: postfach('INBOX'),
      limit: 100,
      // headers wird für die Absender-IP der DNSBL-Prüfung gebraucht
      // attachmentsInfo liefert Namen und Größen der Anhänge — die Dateien
      // selbst holt sich das Panel später über die UID.
      includeParts: ['textContent', 'headers', 'attachmentsInfo'],
      includeAllHeaders: true,
    },
    id: `${PRAEFIX}${konto.id}-bestand`,
    name: `Bestand: ${konto.name}`,
    type: 'n8n-nodes-imap.imap',
    typeVersion: 1,
    position,
    executeOnce: true,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    credentials: imapCredential(konto),
  };
}

// Zeitplan-Auslöser für Workflow 04: lässt die Bestands-Triage alle N Stunden im
// Hintergrund laufen (zusätzlich zum manuellen Start). Ungefährlich für die KI —
// der Budget-Deckel im Sammel-Knoten (budgetInSammeln) begrenzt die Abfragen pro
// Tag und überspringt schon Sortiertes; ein häufiger Lauf läuft dann leer.
// Muster wie in Workflow 02/03 (scheduleTrigger).
function bestandZeitplanKnoten(stunden, position) {
  const n = Math.max(1, Math.floor(Number(stunden) || 0));
  return {
    parameters: {
      rule: { interval: [{ field: 'hours', hoursInterval: n }] },
    },
    id: `${PRAEFIX}bestand-zeitplan`,
    name: 'Zeitplan: Bestand',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position,
  };
}

// ─── Gemeinsame Helfer ───────────────────────────────────────────────────────

// Entfernt alle Panel-Knoten und die Verbindungen, die auf sie zeigen
function panelKnotenEntfernen(workflow) {
  const entfernteNamen = new Set(workflow.nodes.filter(istPanelKnoten).map((k) => k.name));
  workflow.nodes = workflow.nodes.filter((k) => !istPanelKnoten(k));

  const verbindungen = {};
  for (const [quelle, wert] of Object.entries(workflow.connections || {})) {
    if (entfernteNamen.has(quelle)) continue;
    verbindungen[quelle] = {
      ...wert,
      main: (wert.main || []).map((ausgang) =>
        (ausgang || []).filter((ziel) => !entfernteNamen.has(ziel.node))),
    };
  }
  workflow.connections = verbindungen;
  return workflow;
}

// Knoten aus früheren Fassungen der Vorlagen. Bis v2.2.2.0 hatten die Workflows
// einen fest eingebauten Gmail-Zweig und in 03 sogar zwei namentlich genannte
// Postfächer. Seither läuft alles über die im Panel angelegten IMAP-Konten.
// "Neu importieren" fasst bestehende Workflows nicht an — deshalb werden diese
// Knoten hier beim Synchronisieren ausgebaut.
const ALTLASTEN = [
  'trigger-gmail', 'set-gmail', 'gmail-label',            // Workflow 01
  'gmail-bestand', 'gmail-label-bestand',                 // Workflow 04
  'gmail-old-newsletter', 'gmail-add-archive', 'gmail-remove-newsletter',
  'webde-old-newsletter', 'webde-move-archive',
  'mailcow-old-newsletter', 'mailcow-move-archive',       // Workflow 03
];

// Zwei Knoten der Vorlagen trugen bis v2.4.0.1 das reservierte Präfix "panel-".
// Das ist die Marke für "gehört dem Panel und wird bei jedem Sync neu gebaut" —
// die Oberfläche wies sie deshalb falsch aus, und ein künftiger Aufruf von
// panelKnotenEntfernen auf Workflow 02 oder 05 hätte sie ersatzlos gelöscht.
const UMBENENNEN = {
  'panel-digest': 'digest-abruf',            // Workflow 02
  'panel-api': 'beispiel-panel-aufruf',      // Workflow 05
};

function reservierteIdsUmbenennen(workflow) {
  let geaendert = false;
  for (const knoten of workflow.nodes) {
    const neueId = UMBENENNEN[String(knoten.id)];
    if (!neueId) continue;
    knoten.id = neueId;
    geaendert = true;
  }
  return geaendert;
}

function altlastenEntfernen(workflow) {
  const raus = new Set(
    workflow.nodes.filter((k) => ALTLASTEN.includes(String(k.id))).map((k) => k.name),
  );
  if (raus.size === 0) return false;
  workflow.nodes = workflow.nodes.filter((k) => !raus.has(k.name));

  const verbindungen = {};
  for (const [quelle, wert] of Object.entries(workflow.connections || {})) {
    if (raus.has(quelle)) continue;
    verbindungen[quelle] = {
      ...wert,
      main: (wert.main || []).map((ausgang) => (ausgang || []).filter((ziel) => !raus.has(ziel.node))),
    };
  }
  workflow.connections = verbindungen;
  console.log('[patcher] Altlasten entfernt:', [...raus].join(', '));
  return true;
}

function verbinde(workflow, von, nach, ausgang = 0) {
  workflow.connections[von] = workflow.connections[von] || { main: [] };
  const main = workflow.connections[von].main;
  while (main.length <= ausgang) main.push([]);
  main[ausgang] = main[ausgang] || [];
  main[ausgang].push({ node: nach, type: 'main', index: 0 });
}

// Das Credential, mit dem die Workflows die Prüfdienste des Panels aufrufen.
// Wird beim ersten Sync in n8n angelegt, danach nur noch wiederverwendet —
// so muss niemand das Panel-Secret von Hand übertragen.
const PANEL_CREDENTIAL_NAME = 'Mail-Panel: Prüfdienste';

async function panelCredentialId() {
  const zeile = db.prepare("SELECT value FROM settings WHERE key = 'n8n_panel_credential_id'").get();
  if (zeile?.value) return zeile.value;
  const id = await n8n.headerCredentialAnlegen(
    PANEL_CREDENTIAL_NAME, 'X-Panel-Secret', process.env.PANEL_SECRET,
  );
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('n8n_panel_credential_id', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(id);
  return id;
}

// Ruft nach der Klassifizierung den Workflow "07 - Eigene Aktionen" auf.
// Bewusst als zweiter Abzweig neben "Verschieben?" statt in Reihe: Der
// Execute-Workflow-Knoten würde das Item sonst durch seine Antwort ersetzen und
// die Mail wäre für die Sortierung verloren (derselbe Stolperstein wie bei den
// HTTP-Knoten). So laufen beide Zweige unabhängig.
function aktionenKnotenEinhaengen(workflow, aktionenWorkflowId) {
  if (!aktionenWorkflowId) return;
  const quelle = 'Antwort parsen';
  if (!workflow.nodes.some((k) => k.name === quelle)) return;

  const knoten = {
    parameters: {
      workflowId: { __rl: true, mode: 'id', value: String(aktionenWorkflowId) },
      options: { waitForSubWorkflow: false },
    },
    id: `${PRAEFIX}eigene-aktionen`,
    name: 'Eigene Aktionen',
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position: [1320, 560],
    // Eine fehlgeschlagene Aktion darf die Einsortierung nicht aufhalten
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  };
  workflow.nodes.push(knoten);
  verbinde(workflow, quelle, knoten.name, 0);
}

// Hängt das Panel-Credential an den Prüf-Knoten der Vorlage
// Jeder Knoten, der einen internen Endpunkt des Panels aufruft, braucht den
// Header X-Panel-Secret. Erkannt werden sie an der Adresse und nicht am Namen —
// so bleibt keiner übrig, wenn später weitere dazukommen. (Bis v2.4.0.0 wurde
// nur "Panel-Prüfung" in 01 und 04 verdrahtet; die übrigen liefen in
// "Credentials not found" beziehungsweise in eine 401.)
function panelKnotenVerdrahten(workflow, credentialId) {
  if (!credentialId) return false;
  let geaendert = false;
  for (const knoten of workflow.nodes) {
    if (knoten.type !== 'n8n-nodes-base.httpRequest') continue;
    const adresse = String(knoten.parameters?.url || '');
    if (!adresse.includes('/api/internal/')) continue;

    knoten.parameters.authentication = 'genericCredentialType';
    knoten.parameters.genericAuthType = 'httpHeaderAuth';
    knoten.credentials = {
      ...(knoten.credentials || {}),
      httpHeaderAuth: { id: String(credentialId), name: PANEL_CREDENTIAL_NAME },
    };
    geaendert = true;
  }
  return geaendert;
}

// ─── Anhang-Kette (Virenscan) ───────────────────────────────────────────────
//
// Bis v2.4.0.1 lief der Virenscan nie: Die Code-Knoten geben nur zurück, was sie
// selbst bauen, und die HTTP-Knoten dazwischen ersetzen das Item komplett — die
// Anhänge waren also längst weg. Zusätzlich lässt sich `$binary` weder im IF-
// noch im HTTP-Knoten auflösen, und dem Scan-Knoten fehlte `contentType`.
// Deshalb hier drei zusammengehörige Reparaturen, die auch bestehende Workflows
// beim Synchronisieren mitnehmen.

// Der Knoten, der die Mail samt Anhang liefert — je Workflow anders benannt.
const NORMALISIERER = { '01': 'Normalisieren', '04': 'Sammeln + Normalisieren' };

// Der IMAP-Trigger liefert die UID unter attributes, nicht direkt. Ohne diesen
// Rückfall blieb sie null — und ohne UID konnte der Verschiebe-Knoten keine
// einzige Mail einsortieren ("Unable to move email").
function uidReparieren(workflow, normalisierer) {
  const knoten = workflow.nodes.find((k) => k.name === normalisierer && k.type === 'n8n-nodes-base.code');
  if (!knoten?.parameters?.jsCode) return false;
  const alt = 'uid: j.uid ?? null,';
  if (!knoten.parameters.jsCode.includes(alt)) return false;
  knoten.parameters.jsCode = knoten.parameters.jsCode.replace(
    alt, 'uid: j.uid ?? j.attributes?.uid ?? null,',
  );
  return true;
}

// Woher der Normalisierer weiß, ob eine Mail Anhänge hat: Workflow 01 bekommt
// sie als Binärdaten vom Trigger, Workflow 04 nur als Liste vom Abruf-Knoten.
const ANHANG_ERKENNUNG = {
  Normalisieren: 'Object.keys($input.item.binary ?? {}).length > 0',
  'Sammeln + Normalisieren': 'Array.isArray(j.attachmentsInfo) && j.attachmentsInfo.length > 0',
};

function anhangKetteReparieren(workflow, quelle) {
  let geaendert = false;
  if (uidReparieren(workflow, quelle)) geaendert = true;

  // 1. Der Normalisierer meldet, ob Anhänge dranhängen. Von dort wandert das
  //    Feld über die üblichen `...mail`-Kopien durch die ganze Kette.
  const norm = workflow.nodes.find((k) => k.name === quelle && k.type === 'n8n-nodes-base.code');
  const erkennung = ANHANG_ERKENNUNG[quelle];
  if (norm?.parameters?.jsCode && erkennung && !norm.parameters.jsCode.includes('hat_anhang')) {
    const anker = 'uid: j.uid ?? j.attributes?.uid ?? null,';
    if (norm.parameters.jsCode.includes(anker)) {
      norm.parameters.jsCode = norm.parameters.jsCode.replace(
        anker,
        anker + `\n    hat_anhang: ${erkennung},`,
      );
      geaendert = true;
    }
  }

  // 2. Den früheren Umweg über die Binärdaten ausbauen (v2.4.0.2).
  //    Wichtig: Dessen Zeile in "Sortierung auswerten" zeigte fest auf
  //    $('Normalisieren') — in Workflow 04 heißt der Knoten aber anders, und der
  //    Lauf brach dort mit "Referenced node doesn't exist" ab.
  for (const name of ['Prüfung auswerten', 'Sortierung auswerten']) {
    const knoten = workflow.nodes.find((k) => k.name === name && k.type === 'n8n-nodes-base.code');
    if (!knoten?.parameters?.jsCode) continue;
    const vorher = knoten.parameters.jsCode;
    let code = vorher;
    // Kommentar samt hat_anhang-Zeile, dann eine eventuell nackte hat_anhang-Zeile
    code = code.replace(/ *\/\/ Für den Virenscan[\s\S]*?\n *hat_anhang:[^\n]*\n/, '');
    code = code.replace(/ *hat_anhang:[^\n]*\n/, '');
    // Kommentarzeilen, die zum Durchreichen gehörten — die Formulierungen
    // haben sich zwischen den Fassungen unterschieden, deshalb großzügig.
    // Das Durchreichen selbst: einmal als Funktionsblock, einmal als schlichte Zeile
    code = code.replace(/ *binary: \(\(\) => \{[\s\S]*?\n *\}\)\(\),\n/, '');
    code = code.replace(/ *binary:[^\n]*\n/, '');
    // Übrig gebliebene Kommentare dazu — die Formulierungen haben sich zwischen
    // den Fassungen unterschieden, deshalb wird nach Stichwort aufgeräumt.
    code = code.replace(/ *\/\/[^\n]*(Anhang|Anhänge|Anhaenge|Binärdaten|\$binary|Feldname)[^\n]*\n(?= *(\/\/|\}))/g, '');
    if (code !== vorher) { knoten.parameters.jsCode = code; geaendert = true; }
  }

  // 3. Weiche auf das gewöhnliche Feld ($binary löst in IF-Knoten nicht auf)
  const weiche = workflow.nodes.find((k) => k.name === 'Hat Anhang?');
  const bedingung = weiche?.parameters?.conditions?.conditions?.[0];
  if (bedingung && String(bedingung.leftValue) !== '={{ $json.hat_anhang }}') {
    weiche.parameters.conditions.conditions = [{
      id: 'cond-has-binary',
      leftValue: '={{ $json.hat_anhang }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }];
    geaendert = true;
  }

  // 4. Scan-Knoten: schickt nur noch Konto und UID, das Panel holt die Dateien
  const scan = workflow.nodes.find((k) => k.name === 'ClamAV Scan' || k.name === 'Anhänge scannen');
  if (scan?.parameters) {
    const zielAdresse = 'http://panel:3002/api/internal/scan-anhaenge';
    if (scan.parameters.url !== zielAdresse || scan.name !== 'Anhänge scannen') {
      delete scan.parameters.inputDataFieldName;
      delete scan.parameters.specifyBody;
      scan.parameters.url = zielAdresse;
      scan.parameters.sendBody = true;
      scan.parameters.contentType = 'json';
      scan.parameters.specifyBody = 'json';
      scan.parameters.jsonBody =
        `={{ JSON.stringify({ konto: $json.konto, uid: $json.uid, ordner: "INBOX" }) }}`;
      knotenUmbenennen(workflow, scan, 'Anhänge scannen');
      geaendert = true;
    }
  }

  // 5. Der Virusname wird beim Scan-Knoten geholt — Name nachziehen
  const quarantaene = workflow.nodes.find((k) => k.name === 'Virus: Quarantäne');
  if (quarantaene?.parameters?.jsCode) {
    const vorher = quarantaene.parameters.jsCode;
    let code = vorher
      .replace("$json.virus || 'Unbekannt'", "$('Anhänge scannen').item.json.virus || 'Unbekannt'")
      .replace("$('ClamAV Scan')", "$('Anhänge scannen')");
    if (code !== vorher) { quarantaene.parameters.jsCode = code; geaendert = true; }
  }

  return geaendert;
}

// Knoten umbenennen heißt in n8n auch: alle Verbindungen nachziehen, denn die
// laufen über den Namen und nicht über die ID.
function knotenUmbenennen(workflow, knoten, neuerName) {
  const alt = knoten.name;
  if (alt === neuerName) return;
  knoten.name = neuerName;
  for (const wert of Object.values(workflow.connections || {})) {
    for (const arm of wert.main || []) {
      for (const ziel of arm || []) if (ziel.node === alt) ziel.node = neuerName;
    }
  }
  if (workflow.connections[alt]) {
    workflow.connections[neuerName] = workflow.connections[alt];
    delete workflow.connections[alt];
  }
}

// Ersetzt den harten Ordnernamen-Code im "Antwort parsen" Knoten durch die dynamischen Variablen
function patchAntwortParsen(workflow) {
  const knoten = workflow.nodes.find((k) => k.name === 'Antwort parsen');
  if (!knoten || !knoten.parameters || !knoten.parameters.jsCode) return;
  
  let code = knoten.parameters.jsCode;
  code = code.replace(/zielordner = 'Quarantaene';/g, "zielordner = mail.folder_spam || 'Quarantaene';");
  code = code.replace(/zielordner = 'Rechnungen';/g, "zielordner = mail.folder_invoices || 'Rechnungen';");
  code = code.replace(/zielordner = 'Bestellungen';/g, "zielordner = mail.folder_orders || 'Bestellungen';");
  code = code.replace(/zielordner = 'Newsletter';/g, "zielordner = mail.folder_newsletter || 'Newsletter';");

  // Übrig aus der Zeit mit fest eingebautem Gmail-Zweig
  code = code.replace(/\n\/\/ >>> HIER die eigenen Gmail-Label-IDs[\s\S]*?\n\};\n/, '\n');
  code = code.replace(/,\n    gmailLabelId: zielordner \? GMAIL_LABELS\[zielordner\] : null,/, ',');

  knoten.parameters.jsCode = code;
}

// ─── Themen-Sortierung ───────────────────────────────────────────────────────
//
// Nach der Klassifizierung fragt der Workflow beim Panel nach dem endgueltigen
// Zielordner. Warum nicht gleich in n8n entscheiden? Weil der Ordnername von
// einem Modell kommt, das Mailtext liest: Er muss geprueft werden, der Ordner
// muss unter Umstaenden erst angelegt werden, und es gibt eine Obergrenze. Das
// alles kann nur das Panel.
//
// Der Knoten antwortet mit konto, uid und zielordner — also genau dem, was
// "Verschieben?", die Weiche und der Verschiebe-Knoten danach brauchen. Deshalb
// braucht es hier ausnahmsweise keinen nachgelagerten Code-Knoten, der das Item
// wieder zusammensetzt.
function einsortierenKnoten(position, credentialId) {
  const felder = [
    'konto: $json.konto', 'von: $json.von', 'betreff: $json.betreff', 'uid: $json.uid',
    'kategorie: $json.kategorie', 'spam_score: $json.spam_score',
    'kurzfassung: $json.kurzfassung', 'list_unsubscribe: $json.listUnsubscribe',
    'virus_name: $json.virus_name', 'dnsbl_treffer: $json.dnsbl_treffer',
    'zielordner: $json.zielordner', 'ziel_fest: $json.ziel_fest',
    'thema: $json.thema', 'konfidenz: $json.konfidenz',
  ].join(', ');

  const knoten = {
    parameters: {
      method: 'POST',
      url: 'http://panel:3002/api/internal/einsortieren',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ ${felder} }) }}`,
      options: {},
    },
    id: `${PRAEFIX}einsortieren`,
    name: 'Einsortieren',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    // Ist das Panel nicht erreichbar, reicht der Knoten das Item unveraendert
    // weiter — dann greift die Kategorie-Entscheidung aus "Antwort parsen".
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  };
  if (credentialId) {
    knoten.parameters.authentication = 'genericCredentialType';
    knoten.parameters.genericAuthType = 'httpHeaderAuth';
    knoten.credentials = { httpHeaderAuth: { id: String(credentialId), name: PANEL_CREDENTIAL_NAME } };
  }
  return knoten;
}

// Die drei Zweige, die bisher unmittelbar auf "Verschieben?" zeigten
const VOR_EINSORTIEREN = ['Antwort parsen', 'Blacklist: Quarantäne', 'Virus: Quarantäne'];

function themenKetteEinbauen(workflow, normalisierer, credentialId) {
  // 1. Ohne den Kontonamen kann das Panel den Themen-Katalog nicht zuordnen
  const pruefung = workflow.nodes.find((k) => k.name === 'Panel-Prüfung');
  if (pruefung?.parameters?.jsonBody && !pruefung.parameters.jsonBody.includes('konto:')) {
    pruefung.parameters.jsonBody =
      '={{ JSON.stringify({ konto: $json.konto, von: $json.von, ip: $json.ip, links: $json.links }) }}';
  }

  // 2. Der Prompt entsteht jetzt in "Prüfung auswerten", weil erst die Antwort
  //    des Panels den Katalog mitbringt. Der Normalisierer reicht nur den Text durch.
  const norm = workflow.nodes.find((k) => k.name === normalisierer && k.type === 'n8n-nodes-base.code');
  if (norm?.parameters?.jsCode && norm.parameters.jsCode.includes('const promptText')) {
    let js = norm.parameters.jsCode;
    // Bis zum abschliessenden Backtick der Vorlage schneiden. In Workflow 04
    // steht der Block eingerueckt in einer Schleife — deshalb kein Anker auf
    // den Zeilenanfang und keine Annahme ueber Leerzeilen davor oder danach.
    js = js.replace(/[ \t]*const promptText = [\s\S]*?`;\n[ \t]*\n?/, '');
    js = js.replace(/^([ \t]*)promptText,$/m, '$1text,');
    norm.parameters.jsCode = js;
  }

  // 3. Die vier Code-Knoten auf den Stand des Panels bringen. Steht die Marke
  //    schon drin, bleibt der Knoten unangetastet — dann darf er in n8n von Hand
  //    angepasst werden, ohne dass der naechste Sync die Aenderung wegputzt.
  const setzeCode = (name, neuerCode) => {
    const knoten = workflow.nodes.find((k) => k.name === name && k.type === 'n8n-nodes-base.code');
    if (!knoten?.parameters) return;
    if (String(knoten.parameters.jsCode || '').includes(code.MARKE)) return;
    knoten.parameters.jsCode = neuerCode;
  };
  setzeCode('Prüfung auswerten', code.fuer(code.PRUEFUNG_AUSWERTEN, normalisierer));
  setzeCode('Antwort parsen', code.ANTWORT_PARSEN);
  setzeCode('Blacklist: Quarantäne', code.BLACKLIST_QUARANTAENE);
  setzeCode('Virus: Quarantäne', code.fuer(code.VIRUS_QUARANTAENE, normalisierer));

  // 4. Verdrahten: die drei Zweige laufen kuenftig ueber "Einsortieren".
  const ziel = workflow.nodes.find((k) => k.name === 'Verschieben?');
  if (!ziel) return;
  for (const name of VOR_EINSORTIEREN) {
    const verbindung = workflow.connections[name];
    if (!verbindung?.main) continue;
    verbindung.main = verbindung.main.map((arm) => (arm || []).filter((z) => z.node !== 'Verschieben?'));
  }
  const platz = [(ziel.position?.[0] ?? 2640) - 140, (ziel.position?.[1] ?? 200) + 200];
  const knoten = einsortierenKnoten(platz, credentialId);
  workflow.nodes.push(knoten);
  for (const name of VOR_EINSORTIEREN) {
    if (workflow.nodes.some((k) => k.name === name)) verbinde(workflow, name, knoten.name, 0);
  }
  verbinde(workflow, knoten.name, 'Verschieben?', 0);
}

async function workflowSuchen(praefix) {
  const alle = await n8n.workflowsAuflisten();
  const treffer = alle.find((w) => String(w.name).trim().startsWith(praefix));
  if (!treffer) throw new Error(`Workflow "${praefix} - ..." nicht in n8n gefunden — bitte zuerst importieren.`);
  return treffer;
}

// Repariert den Bug, bei dem n8n's JSON.stringify den promptText verwirft, weil
// die Eigenschaft unter bestimmten Umständen als Proxy-Feld nicht iterierbar ist,
// und rüstet alte 2.5-flash-lite Modelle auf 3.5 auf.
//
// Erkannt werden die Knoten an der Adresse, nicht am Namen. Vorher zählte nur
// "Gemini klassifizieren" — dadurch blieb "Gemini zusammenfassen" im Workflow 02
// auf dem abgekündigten Modell hängen und der tägliche Digest scheiterte jeden
// Morgen mit "This model models/gemini-2.5-flash-lite is no longer available".
// Dasselbe Muster wie bei panelKnotenVerdrahten: über die URL, damit kein Knoten
// übrig bleibt, wenn später weitere dazukommen.
function geminiRequestReparieren(workflow) {
  let geaendert = false;
  for (const knoten of workflow.nodes) {
    if (knoten.type !== 'n8n-nodes-base.httpRequest') continue;
    if (!String(knoten.parameters?.url || '').includes('generativelanguage.googleapis.com')) continue;

    // Bugfix: JSON.stringify
    if (knoten.parameters?.jsonBody) {
      const alt = '{ text: $json.promptText }';
      const neu = "{ text: String($json.promptText || '') }";
      if (knoten.parameters.jsonBody.includes(alt)) {
        knoten.parameters.jsonBody = knoten.parameters.jsonBody.replace(alt, neu);
        geaendert = true;
      }
    }

    // Bugfix: Gemini 2.5 ist deprecated
    if (knoten.parameters?.url) {
      const altUrl = 'models/gemini-2.5-flash-lite:generateContent';
      const neuUrl = 'models/gemini-3.5-flash-lite:generateContent';
      if (knoten.parameters.url.includes(altUrl)) {
        knoten.parameters.url = knoten.parameters.url.replace(altUrl, neuUrl);
        geaendert = true;
      }
    }
  }
  return geaendert;
}

// ─── Workflow 01: Trigger + Konto-Kennzeichnung je Konto ─────────────────────

async function triageSynchronisieren(konten, credentialId, aktionenWorkflowId) {
  const info = await workflowSuchen(ANKER.triage.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  altlastenEntfernen(workflow);
  if (credentialId) panelKnotenVerdrahten(workflow, credentialId);
  patchAntwortParsen(workflow);
  geminiRequestReparieren(workflow);
  anhangKetteReparieren(workflow, NORMALISIERER['01']);
  themenKetteEinbauen(workflow, NORMALISIERER['01'], credentialId);

  for (const name of [ANKER.triage.ziel, ANKER.triage.weiche]) {
    if (!workflow.nodes.some((k) => k.name === name)) {
      throw new Error(`Knoten "${name}" fehlt im Workflow 01 — bitte die mitgelieferte Vorlage importieren.`);
    }
  }

  // Eingang: je Konto ein IMAP-Trigger, der die Mail mit dem Kontonamen versieht
  konten.forEach((konto, i) => {
    const y = 100 + i * 200;
    const trigger = triggerKnoten(konto, [0, y]);
    const set     = setKnoten(konto, [220, y]);
    workflow.nodes.push(trigger, set);
    verbinde(workflow, trigger.name, set.name);
    verbinde(workflow, set.name, ANKER.triage.ziel);
  });

  // Ausgang: Weiche + je Konto ein Verschiebe-Knoten
  const weiche = weichenKnoten(konten, [1340, 120]);
  workflow.nodes.push(weiche);
  if (settings.hole('trockenlauf_aktiv') !== '1') {
    verbinde(workflow, ANKER.triage.weiche, weiche.name, 0);
  }
  konten.forEach((konto, i) => {
    const move = verschiebeKnoten(konto, [1600, 160 + i * 160]);
    workflow.nodes.push(move);
    verbinde(workflow, weiche.name, move.name, i);
  });

  aktionenKnotenEinhaengen(workflow, aktionenWorkflowId);
  await n8n.workflowSpeichern(info.id, workflow);
  // Nach dem Speichern deaktiviert n8n den Workflow — vorherigen Zustand wiederherstellen
  if (info.active) await n8n.workflowAktivieren(info.id, true);
  return { workflow: info.name, konten: konten.length };
}

// ─── Workflow 04: Abrufkette für den Bestand ─────────────────────────────────

// Der Sammel-Knoten bekommt die Liste seiner Quellen vom Panel eingesetzt.
function quellenEintragen(code, konten) {
  const liste = konten.map((k) => `  ['${k.name.replace(/'/g, "\\'")}', 'Bestand: ${k.name.replace(/'/g, "\\'")}'],`).join('\n');
  return code.replace(
    /(\/\/ PANEL:QUELLEN-START)[\s\S]*?(\/\/ PANEL:QUELLEN-ENDE)/,
    `$1\n${liste}\n$2`,
  );
}

// Setzt vor der KI-Abfrage den Budget-Wächter in den Sammel-Knoten von
// Workflow 04. Der Sammel-Knoten ist die einzige Stelle, die ALLE Mails eines
// Laufs auf einmal in der Hand hat — genau das braucht der Wächter, um „nur die
// ersten N" zu entscheiden. Ein HTTP-Knoten feuert pro Mail einzeln und könnte
// innerhalb eines Laufs nicht mitzählen.
//
// Der Aufruf läuft über `this.helpers.httpRequest` (auf dem Testserver
// nachgewiesen) und trägt das Panel-Geheimnis mit — dasselbe, das ohnehin schon
// als n8n-Credential hinterlegt ist, also kein neues Leck. Bei fehlendem Panel
// wird bewusst NICHTS sortiert, statt das Tageslimit zu riskieren.
//
// Idempotent: ein vorhandener Block wird erst entfernt, dann frisch gesetzt,
// damit ein erneuter Sync nicht zwei davon stapelt.
const BUDGET_MARKE = '// PANEL:BUDGET v1';

function budgetInSammeln(sammler) {
  if (!sammler?.parameters?.jsCode) return;
  const geheim = process.env.PANEL_SECRET || '';
  let code = String(sammler.parameters.jsCode);

  // Vorhandenen Block herausnehmen und das kanonische Ende wiederherstellen.
  code = code.replace(/\n*\/\/ PANEL:BUDGET[\s\S]*$/, '\nreturn out;\n');
  if (!/return out;\s*$/.test(`${code.replace(/\s+$/, '')}\n`)) return;

  const block = [
    `${BUDGET_MARKE} — vom Mail-Panel gepflegt, bitte nicht von Hand aendern.`,
    '// Fragt vor der KI-Abfrage, welche Mails das Tagesbudget noch zulaesst.',
    `const __geheim = ${JSON.stringify(geheim)};`,
    'let __erlaubt = out;',
    'try {',
    '  const __r = await this.helpers.httpRequest({',
    "    method: 'POST', url: 'http://panel:3002/api/internal/budget',",
    "    headers: { 'X-Panel-Secret': __geheim, 'Content-Type': 'application/json' },",
    '    body: { kandidaten: out.map((m) => ({ konto: m.json.konto, von: m.json.von, betreff: m.json.betreff })) },',
    '    json: true,',
    '  });',
    '  if (__r && Array.isArray(__r.erlaubt)) {',
    '    const __ok = new Set(__r.erlaubt);',
    '    __erlaubt = out.filter((__m, __i) => __ok.has(__i));',
    '  }',
    '} catch (__e) {',
    "  return [{ json: { hinweis: 'Budget-Pruefung nicht moeglich (' + (__e.message || __e) + ') — es wird nichts sortiert.' } }];",
    '}',
    'if (__erlaubt.length === 0) {',
    "  return [{ json: { hinweis: 'KI-Tagesbudget aufgebraucht oder nichts Neues zu sortieren — morgen geht es weiter.' } }];",
    '}',
    'return __erlaubt;',
  ].join('\n');

  sammler.parameters.jsCode = code.replace(/return out;\s*$/, `${block}\n`);
}

async function bestandSynchronisieren(konten, credentialId, aktionenWorkflowId) {
  const info = await workflowSuchen(ANKER.bestand.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  altlastenEntfernen(workflow);
  if (credentialId) panelKnotenVerdrahten(workflow, credentialId);
  patchAntwortParsen(workflow);
  geminiRequestReparieren(workflow);
  anhangKetteReparieren(workflow, NORMALISIERER['04']);
  themenKetteEinbauen(workflow, NORMALISIERER['04'], credentialId);

  const sammler = workflow.nodes.find((k) => k.name === ANKER.bestand.ziel);
  const kopf    = workflow.nodes.find((k) => k.name === ANKER.bestand.kopf);
  if (!sammler || !kopf) {
    throw new Error(`Workflow 04 passt nicht zur Vorlage (Knoten "${ANKER.bestand.kopf}"/"${ANKER.bestand.ziel}" fehlen).`);
  }

  // Abrufkette: Manuell starten -> Bestand: A -> Bestand: B -> ... -> Sammler
  // (nacheinander, damit der Sammel-Knoten nur einmal läuft)
  let vorheriger = kopf.name;
  let erstesKonto = null;
  konten.forEach((konto, i) => {
    const knoten = bestandKnoten(konto, [440 + i * 220, 100]);
    if (i === 0) erstesKonto = knoten.name;
    workflow.nodes.push(knoten);
    workflow.connections[vorheriger] = { main: [[{ node: knoten.name, type: 'main', index: 0 }]] };
    vorheriger = knoten.name;
  });
  workflow.connections[vorheriger] = { main: [[{ node: sammler.name, type: 'main', index: 0 }]] };

  // Optionaler Hintergrund-Zeitplan: lässt WF04 alle N Stunden von selbst laufen
  // (zusätzlich zum manuellen Start), speist dieselbe Kette. 0 = aus. Der
  // Budget-Deckel im Sammel-Knoten schützt die KI. WF04 muss dafür aktiv sein.
  const bestandIntervall = Math.floor(Number(settings.hole('bestand_intervall')) || 0);
  if (bestandIntervall > 0 && erstesKonto) {
    const zeitplan = bestandZeitplanKnoten(bestandIntervall, [240, 320]);
    workflow.nodes.push(zeitplan);
    workflow.connections[zeitplan.name] = { main: [[{ node: erstesKonto, type: 'main', index: 0 }]] };
  }

  // Quellenliste im Sammel-Knoten aktualisieren
  if (sammler.parameters?.jsCode) {
    sammler.parameters.jsCode = quellenEintragen(sammler.parameters.jsCode, konten);
  }
  // KI-Tagesbudget: den Wächter vor die KI-Abfrage setzen (nur im Bestand,
  // Workflow 04 — die laufende Post in Workflow 01 ist wenig und braucht das nicht).
  budgetInSammeln(sammler);

  // Ausgang: Weiche + Verschiebe-Knoten wie in Workflow 01
  const weiche = weichenKnoten(konten, [1780, 20]);
  workflow.nodes.push(weiche);
  if (settings.hole('trockenlauf_aktiv') !== '1') {
    verbinde(workflow, ANKER.bestand.weiche, weiche.name, 0);
  }
  konten.forEach((konto, i) => {
    const move = verschiebeKnoten(konto, [2040, 60 + i * 160]);
    workflow.nodes.push(move);
    verbinde(workflow, weiche.name, move.name, i);
  });

  aktionenKnotenEinhaengen(workflow, aktionenWorkflowId);
  await n8n.workflowSpeichern(info.id, workflow);
  if (info.active) await n8n.workflowAktivieren(info.id, true);
  return { workflow: info.name, konten: konten.length };
}

// ─── Workflow 03: je Konto eine Such- und eine Verschiebe-Stufe ──────────────

async function newsletterSynchronisieren(konten) {
  const info = await workflowSuchen(ANKER.newsletter.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  altlastenEntfernen(workflow);

  const trigger = workflow.nodes.find((k) => k.name === ANKER.newsletter.trigger);
  if (!trigger) {
    throw new Error(`Knoten "${ANKER.newsletter.trigger}" fehlt im Workflow 03 — bitte die mitgelieferte Vorlage importieren.`);
  }

  // Ohne gesetzte Ordner wird fuer dieses Konto gar kein Knoten gebaut.
  //
  // Frueher fielen die Namen still auf "Newsletter" und "Archiv" zurueck. Hat
  // das Postfach diese Ordner nicht — und die wenigsten haben sie —, lief der
  // Workflow woechentlich gegen ins Leere und niemand erfuhr davon. Lieber gar
  // nicht aufraeumen als so tun, als wuerde man.
  const uebersprungen = [];
  const passend = konten.filter((konto) => {
    const fehlt = [];
    if (!String(konto.folder_newsletter || '').trim()) fehlt.push('Newsletter-Ordner');
    if (!String(konto.folder_archive || '').trim()) fehlt.push('Archiv-Ordner');
    if (fehlt.length === 0) return true;
    uebersprungen.push(`${konto.name}: ${fehlt.join(' und ')} nicht gesetzt`);
    return false;
  });

  passend.forEach((konto, i) => {
    const y = 100 + i * 180;
    const suchen = altNewsletterKnoten(konto, [260, y]);
    // Das Suchkriterium steht im Knoten, damit es in n8n sichtbar bleibt
    suchen.parameters.searchCriteria = AELTER_ALS_30_TAGE;
    const archiv = archivKnoten(konto, [520, y]);
    workflow.nodes.push(suchen, archiv);
    verbinde(workflow, trigger.name, suchen.name, 0);
    verbinde(workflow, suchen.name, archiv.name, 0);
  });

  await n8n.workflowSpeichern(info.id, workflow);
  // Ohne ein einziges eingerichtetes Konto hat der Workflow nichts zu tun. Ihn
  // dann eingeschaltet zu lassen, taeuscht eine Aufraeum-Automatik nur vor.
  if (info.active && passend.length === 0) {
    await n8n.workflowAktivieren(info.id, false);
  } else if (info.active) {
    await n8n.workflowAktivieren(info.id, true);
  }

  const ergebnis = { workflow: info.name, konten: passend.length };
  if (uebersprungen.length) {
    ergebnis.hinweis = `Ohne Newsletter- und Archiv-Ordner läuft das wöchentliche Aufräumen nicht — `
      + `unter Konten eintragen. Übersprungen: ${uebersprungen.join('; ')}.`;
  }
  return ergebnis;
}

// Synchronisiert die KI- und Telegram-Einstellungen in die Workflows
async function kiUndBenachrichtigungenSynchronisieren() {
  const geminiKey = settings.hole('gemini_api_key');
  const telegramToken = settings.hole('telegram_token');
  const telegramChatId = settings.hole('telegram_chat_id');
  const smtpHost = settings.hole('smtp_host');
  const smtpAbsender = settings.hole('smtp_absender');

  let geminiCredId = null;
  let telegramCredId = null;
  let smtpCredId = null;

  if (geminiKey) {
    try {
      const dbGemini = db.prepare("SELECT value FROM settings WHERE key = 'n8n_gemini_credential_id'").get();
      if (dbGemini?.value) {
        geminiCredId = dbGemini.value;
        await n8n.credentialLoeschen(geminiCredId);
      }
      geminiCredId = await n8n.headerCredentialAnlegen('Gemini API', 'x-goog-api-key', geminiKey);
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('n8n_gemini_credential_id', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(geminiCredId);
    } catch (err) { console.warn('Gemini-Credential Fehler:', err.message); }
  }

  if (telegramToken) {
    try {
      const dbTg = db.prepare("SELECT value FROM settings WHERE key = 'n8n_telegram_credential_id'").get();
      if (dbTg?.value) {
        telegramCredId = dbTg.value;
        await n8n.credentialLoeschen(telegramCredId);
      }
      telegramCredId = await n8n.telegramCredentialAnlegen('Telegram Bot', telegramToken);
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('n8n_telegram_credential_id', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(telegramCredId);
    } catch (err) { console.warn('Telegram-Credential Fehler:', err.message); }
  }

  if (smtpHost) {
    try {
      const dbSmtp = db.prepare("SELECT value FROM settings WHERE key = 'n8n_smtp_credential_id'").get();
      if (dbSmtp?.value) {
        smtpCredId = dbSmtp.value;
        await n8n.credentialLoeschen(smtpCredId);
      }
      smtpCredId = await n8n.smtpCredentialAnlegen('Mail-Panel: Postausgang', {
        host: smtpHost,
        port: settings.hole('smtp_port'),
        user: settings.hole('smtp_user'),
        passwort: settings.hole('smtp_passwort'),
        tlsUnsicher: settings.hole('smtp_tls_unsicher') === '1',
      });
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('n8n_smtp_credential_id', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(smtpCredId);
    } catch (err) { console.warn('SMTP-Credential Fehler:', err.message); }
  }

  // Das Panel-Credential brauchen auch Workflows, die der Konten-Sync nicht anfasst
  let panelCredId = null;
  try { panelCredId = await panelCredentialId(); }
  catch (err) { console.warn('Panel-Credential konnte nicht angelegt werden:', err.message); }

  // Alle Workflows durchsuchen und anpassen
  try {
    const alle = await n8n.workflowsAuflisten();
    for (const wfInfo of alle) {
      let geaendert = false;
      const workflow = await n8n.workflowHolen(wfInfo.id);

      if (reservierteIdsUmbenennen(workflow)) geaendert = true;
      if (panelKnotenVerdrahten(workflow, panelCredId)) geaendert = true;
      // Auch hier, nicht nur in 01 und 04: Sonst bleibt der Digest-Workflow auf
      // dem abgekündigten Gemini-Modell stehen, weil ihn sonst niemand anfasst.
      if (geminiRequestReparieren(workflow)) geaendert = true;

      for (const knoten of workflow.nodes) {
        if (['Gemini klassifizieren', 'Gemini zusammenfassen'].includes(knoten.name)) {
          if (geminiCredId) {
            knoten.credentials = { httpHeaderAuth: { id: String(geminiCredId), name: 'Gemini API' } };
            geaendert = true;
          } else if (knoten.credentials?.httpHeaderAuth) {
            // Kein Schlüssel mehr hinterlegt: Der Verweis zeigt sonst auf ein
            // gelöschtes Credential ("Credential with ID ... does not exist")
            // und der Workflow lässt sich weder ausführen noch einschalten.
            delete knoten.credentials.httpHeaderAuth;
            geaendert = true;
          }
        }
        if (knoten.type === 'n8n-nodes-base.emailSend') {
          if (smtpCredId) {
            knoten.credentials = { smtp: { id: String(smtpCredId), name: 'Mail-Panel: Postausgang' } };
            // Die Absenderadresse gehört zum Postausgang und stand bisher fest im Knoten
            if (smtpAbsender) {
              knoten.parameters = knoten.parameters || {};
              knoten.parameters.fromEmail = smtpAbsender;
            }
            geaendert = true;
          } else if (knoten.credentials?.smtp) {
            // Postausgang wurde entfernt — sonst zeigt der Knoten auf ein
            // gelöschtes Credential und blockiert wieder die Aktivierung.
            delete knoten.credentials.smtp;
            geaendert = true;
          }
        }
        if (['Telegram senden', 'Virus Warnung (Telegram)', 'Telegram Trigger'].includes(knoten.name)) {
          if (telegramCredId) {
            knoten.credentials = { telegramApi: { id: String(telegramCredId), name: 'Telegram Bot' } };
            geaendert = true;
          } else if (knoten.credentials?.telegramApi) {
            delete knoten.credentials.telegramApi;
            geaendert = true;
          }
          if (telegramChatId && knoten.type === 'n8n-nodes-base.telegram') {
            knoten.parameters = knoten.parameters || {};
            knoten.parameters.chatId = telegramChatId;
            geaendert = true;
          }
        }
      }

      // Knoten ohne Zugangsdaten stilllegen. n8n verweigert sonst das
      // Aktivieren des ganzen Workflows ("Missing required credential") —
      // wer kein Gmail und kein Telegram nutzt, könnte die Triage sonst gar
      // nicht einschalten. Sobald Zugangsdaten da sind, laufen sie wieder mit.
      if (knotenStilllegen(workflow)) geaendert = true;

      if (geaendert) {
        await n8n.workflowSpeichern(wfInfo.id, workflow);
      }
    }
  } catch (err) {
    console.warn('Fehler beim Patchen der Workflows (KI/Telegram):', err.message);
  }
}

// Diese Knotentypen brauchen zwingend Zugangsdaten — fehlen sie, blockieren sie
// die Aktivierung des gesamten Workflows.
const BRAUCHT_ZUGANGSDATEN = [
  // Telegram bleibt aus, solange kein Bot-Token hinterlegt ist
  'n8n-nodes-base.telegram',
  'n8n-nodes-base.telegramTrigger',
  // Ebenso der Postausgang: ohne SMTP-Daten ließe sich Workflow 06 nicht einschalten
  'n8n-nodes-base.emailSend',
  // Greift bei Installationen, in denen noch Knoten aus einer älteren Fassung
  // der Vorlagen stehen (Gmail, fest verdrahtete Postfächer).
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.gmailTrigger',
  'n8n-nodes-imap.imap',
  'n8n-nodes-base.emailReadImap',
];

function knotenStilllegen(workflow) {
  let geaendert = false;
  for (const knoten of workflow.nodes) {
    if (!BRAUCHT_ZUGANGSDATEN.includes(knoten.type)) continue;
    const hatZugangsdaten = knoten.credentials && Object.keys(knoten.credentials).length > 0;
    if (!hatZugangsdaten && !knoten.disabled) {
      knoten.disabled = true;
      geaendert = true;
    } else if (hatZugangsdaten && knoten.disabled) {
      delete knoten.disabled;
      geaendert = true;
    }
  }
  return geaendert;
}

// Beide Workflows auf den aktuellen Kontenstand bringen
// Verzögert geladen: aktionenPatcher hängt selbst an diesem Modul.
function aktionenPatcher() {
  return require('./aktionenPatcher');
}

async function alleSynchronisieren(konten) {
  // Zuerst sicherstellen, dass die Basis-Workflows überhaupt in n8n existieren
  await basisSetup();

  // KI- und Telegram-Einstellungen in alle Workflows pushen
  await kiUndBenachrichtigungenSynchronisieren();

  // Fehlt das Credential, laufen die Workflows trotzdem — der Prüf-Knoten
  // meldet dann nur einen Fehler und die Mail läuft ungeprüft weiter.
  let credentialId = null;
  try { credentialId = await panelCredentialId(); }
  catch (err) { console.warn('Panel-Credential konnte nicht angelegt werden:', err.message); }

  // Workflow 07 nimmt die eigenen Aktionen auf; fehlt er, bleibt der Aufruf
  // schlicht weg und die Triage läuft wie bisher.
  let aktionenId = null;
  try {
    const alle = await n8n.workflowsAuflisten();
    const treffer = alle.find((w) => String(w.name).trim().startsWith('07'));
    aktionenId = treffer?.id || null;
    // Ab n8n 2 muss ein aufgerufener Unter-Workflow veröffentlicht sein, sonst
    // lassen sich 01 und 04 nicht mehr einschalten. Das muss vor dem Speichern
    // passieren, weil direkt danach ihr alter Zustand wiederhergestellt wird.
    if (treffer && !treffer.active) await aktionenPatcher().veroeffentlichen(aktionenId);
  } catch { /* ohne Aktionen weitermachen */ }

  // Jeder Workflow wird einzeln versucht. Vorher riss der erste Fehlschlag die
  // ganze Kette mit: Lief das Speichern von 01 in ein Zeitlimit, blieben 04 und
  // 03 auf dem alten Stand — und zwar unbemerkt, weil der Fehler nur den ersten
  // Workflow nannte. Jetzt wird alles angefasst und am Ende gesammelt gemeldet.
  const ergebnisse = [];
  const fehlgeschlagen = [];

  for (const [bezeichnung, aufgabe] of [
    ['01 - Inbox-Triage', () => triageSynchronisieren(konten, credentialId, aktionenId)],
    ['04 - Bestands-Triage', () => bestandSynchronisieren(konten, credentialId, aktionenId)],
  ]) {
    try {
      ergebnisse.push(await aufgabe());
    } catch (err) {
      fehlgeschlagen.push(`${bezeichnung}: ${err.message}`);
      console.warn(`Sync fehlgeschlagen — ${bezeichnung}:`, err.message);
    }
  }

  // Workflow 03 gibt es erst seit dem Wegfall der fest eingebauten Konten —
  // fehlt er in einer älteren Installation, läuft der Rest trotzdem durch.
  try {
    ergebnisse.push(await newsletterSynchronisieren(konten));
  } catch (err) {
    console.warn('Workflow 03 konnte nicht verdrahtet werden:', err.message);
    ergebnisse.push({ workflow: '03 - Newsletter-Cleanup', hinweis: err.message });
  }

  if (fehlgeschlagen.length > 0) {
    const err = new Error(fehlgeschlagen.join(' | '));
    err.teilergebnisse = ergebnisse;
    throw err;
  }
  return ergebnisse;
}

// Prüft, ob die Workflows in n8n existieren, und importiert sie bei Bedarf
// aus dem lokalen Verzeichnis (/app/workflows/).
async function basisSetup() {
  console.log('[basisSetup] gestartet');
  try {
    const alle = await n8n.workflowsAuflisten();
    console.log(`[basisSetup] ${alle.length} Workflows in n8n gefunden.`);
    const lokal = path.resolve(__dirname, '../../../../workflows');
    const docker = path.resolve(__dirname, '../../../workflows');
    const workflowDir = fs.existsSync(docker) ? docker : lokal;
    console.log(`[basisSetup] workflowDir: ${workflowDir}, exists: ${fs.existsSync(workflowDir)}`);
    
    // Prüfen, ob das Verzeichnis überhaupt da ist
    if (!fs.existsSync(workflowDir)) return;
    
    const dateien = fs.readdirSync(workflowDir).filter((d) => d.endsWith('.json'));
    console.log(`[basisSetup] ${dateien.length} Vorlagen gefunden:`, dateien);
    
    for (const datei of dateien) {
      const inhalt = fs.readFileSync(path.join(workflowDir, datei), 'utf-8');
      const wf = JSON.parse(inhalt);
      
      // Anhand des Namens (oder Präfix) suchen
      const existiert = alle.some((w) => String(w.name).trim() === String(wf.name).trim());
      
      if (!existiert) {
        console.log(`[basisSetup] Workflow "${wf.name}" fehlt in n8n. Importiere...`);
        try {
          const erstellt = await n8n.workflowErstellen(wf);
          console.log(`[basisSetup] Erfolgreich erstellt: ${erstellt.id}`);
          // Aktivieren, falls möglich
          try { await n8n.workflowAktivieren(erstellt.id, true); } catch (e) { /* ignorieren */ }
        } catch (innerErr) {
          console.error(`[basisSetup] Fehler beim Erstellen von "${wf.name}":`, innerErr.message);
        }
      } else {
        console.log(`[basisSetup] Workflow "${wf.name}" existiert bereits.`);
      }
    }
  } catch (err) {
    console.error('[basisSetup] Fehler beim automatischen Workflow-Setup:', err.message, err.stack);
  }
}

module.exports = {
  alleSynchronisieren, triageSynchronisieren, bestandSynchronisieren, newsletterSynchronisieren, basisSetup,
  // für Tests
  panelKnotenEntfernen, quellenEintragen, budgetInSammeln, triggerKnoten, setKnoten, bestandKnoten,
  themenKetteEinbauen, einsortierenKnoten, bestandZeitplanKnoten,
};
