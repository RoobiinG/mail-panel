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
          { id: `f1-${konto.id}`, name: 'folder_spam', value: konto.folder_spam || '', type: 'string' },
          { id: `f2-${konto.id}`, name: 'folder_invoices', value: konto.folder_invoices || '', type: 'string' },
          { id: `f3-${konto.id}`, name: 'folder_orders', value: konto.folder_orders || '', type: 'string' },
          { id: `f4-${konto.id}`, name: 'folder_newsletter', value: konto.folder_newsletter || '', type: 'string' },
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
  const quelle = konto.folder_newsletter || 'Newsletter';
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
  const quelle = konto.folder_newsletter || 'Newsletter';
  const ziel   = konto.folder_archive || 'Archiv';
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
      includeParts: ['textContent', 'headers'],
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
function pruefKnotenVerdrahten(workflow, credentialId) {
  const knoten = workflow.nodes.find((k) => k.name === 'Panel-Prüfung');
  if (!knoten) return false;
  knoten.credentials = {
    httpHeaderAuth: { id: String(credentialId), name: PANEL_CREDENTIAL_NAME },
  };
  return true;
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

async function workflowSuchen(praefix) {
  const alle = await n8n.workflowsAuflisten();
  const treffer = alle.find((w) => String(w.name).trim().startsWith(praefix));
  if (!treffer) throw new Error(`Workflow "${praefix} - ..." nicht in n8n gefunden — bitte zuerst importieren.`);
  return treffer;
}

// ─── Workflow 01: Trigger + Konto-Kennzeichnung je Konto ─────────────────────

async function triageSynchronisieren(konten, credentialId, aktionenWorkflowId) {
  const info = await workflowSuchen(ANKER.triage.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  altlastenEntfernen(workflow);
  if (credentialId) pruefKnotenVerdrahten(workflow, credentialId);
  patchAntwortParsen(workflow);

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
  verbinde(workflow, ANKER.triage.weiche, weiche.name, 0);
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

async function bestandSynchronisieren(konten, credentialId, aktionenWorkflowId) {
  const info = await workflowSuchen(ANKER.bestand.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  altlastenEntfernen(workflow);
  if (credentialId) pruefKnotenVerdrahten(workflow, credentialId);
  patchAntwortParsen(workflow);

  const sammler = workflow.nodes.find((k) => k.name === ANKER.bestand.ziel);
  const kopf    = workflow.nodes.find((k) => k.name === ANKER.bestand.kopf);
  if (!sammler || !kopf) {
    throw new Error(`Workflow 04 passt nicht zur Vorlage (Knoten "${ANKER.bestand.kopf}"/"${ANKER.bestand.ziel}" fehlen).`);
  }

  // Abrufkette: Manuell starten -> Bestand: A -> Bestand: B -> ... -> Sammler
  // (nacheinander, damit der Sammel-Knoten nur einmal läuft)
  let vorheriger = kopf.name;
  konten.forEach((konto, i) => {
    const knoten = bestandKnoten(konto, [440 + i * 220, 100]);
    workflow.nodes.push(knoten);
    workflow.connections[vorheriger] = { main: [[{ node: knoten.name, type: 'main', index: 0 }]] };
    vorheriger = knoten.name;
  });
  workflow.connections[vorheriger] = { main: [[{ node: sammler.name, type: 'main', index: 0 }]] };

  // Quellenliste im Sammel-Knoten aktualisieren
  if (sammler.parameters?.jsCode) {
    sammler.parameters.jsCode = quellenEintragen(sammler.parameters.jsCode, konten);
  }

  // Ausgang: Weiche + Verschiebe-Knoten wie in Workflow 01
  const weiche = weichenKnoten(konten, [1780, 20]);
  workflow.nodes.push(weiche);
  verbinde(workflow, ANKER.bestand.weiche, weiche.name, 0);
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

  konten.forEach((konto, i) => {
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
  if (info.active) await n8n.workflowAktivieren(info.id, true);
  return { workflow: info.name, konten: konten.length };
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

  // Alle Workflows durchsuchen und anpassen
  try {
    const alle = await n8n.workflowsAuflisten();
    for (const wfInfo of alle) {
      let geaendert = false;
      const workflow = await n8n.workflowHolen(wfInfo.id);

      for (const knoten of workflow.nodes) {
        if (['Gemini klassifizieren', 'Gemini zusammenfassen'].includes(knoten.name) && geminiCredId) {
          knoten.credentials = { httpHeaderAuth: { id: String(geminiCredId), name: 'Gemini API' } };
          geaendert = true;
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

  const ergebnisse = [];
  ergebnisse.push(await triageSynchronisieren(konten, credentialId, aktionenId));
  ergebnisse.push(await bestandSynchronisieren(konten, credentialId, aktionenId));
  // Workflow 03 gibt es erst seit dem Wegfall der fest eingebauten Konten —
  // fehlt er in einer älteren Installation, läuft der Rest trotzdem durch.
  try {
    ergebnisse.push(await newsletterSynchronisieren(konten));
  } catch (err) {
    console.warn('Workflow 03 konnte nicht verdrahtet werden:', err.message);
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
  panelKnotenEntfernen, quellenEintragen, triggerKnoten, setKnoten, bestandKnoten,
};
