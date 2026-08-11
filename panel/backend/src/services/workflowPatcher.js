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
    gmailZiel: 'Gmail: Label setzen',
  },
  bestand: {
    workflowPraefix: '04',
    kopf: 'Gmail Bestand',          // Kopf der Abrufkette
    ziel: 'Sammeln + Normalisieren',
    weiche: 'Verschieben?',
    gmailZiel: 'Gmail: Label setzen',
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
      // Absender-IP der DNSBL-Prüfung) und legt Anhänge als Binärdaten ab
      // (nötig für den Virenscan).
      format: 'resolved',
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

// Weiche, die nach dem Feld "konto" auf die passende Verschiebe-Aktion verzweigt.
// Ausgang 0 ist immer Gmail, danach folgen die Panel-Konten in Reihenfolge.
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
      rules: { values: [regel('gmail'), ...konten.map((k) => regel(k.name))] },
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

// Hängt das Panel-Credential an den Prüf-Knoten der Vorlage
function pruefKnotenVerdrahten(workflow, credentialId) {
  const knoten = workflow.nodes.find((k) => k.name === 'Panel-Prüfung');
  if (!knoten) return false;
  knoten.credentials = {
    httpHeaderAuth: { id: String(credentialId), name: PANEL_CREDENTIAL_NAME },
  };
  return true;
}

async function workflowSuchen(praefix) {
  const alle = await n8n.workflowsAuflisten();
  const treffer = alle.find((w) => String(w.name).trim().startsWith(praefix));
  if (!treffer) throw new Error(`Workflow "${praefix} - ..." nicht in n8n gefunden — bitte zuerst importieren.`);
  return treffer;
}

// ─── Workflow 01: Trigger + Konto-Kennzeichnung je Konto ─────────────────────

async function triageSynchronisieren(konten, credentialId) {
  const info = await workflowSuchen(ANKER.triage.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  if (credentialId) pruefKnotenVerdrahten(workflow, credentialId);

  for (const name of [ANKER.triage.ziel, ANKER.triage.weiche, ANKER.triage.gmailZiel]) {
    if (!workflow.nodes.some((k) => k.name === name)) {
      throw new Error(`Knoten "${name}" fehlt im Workflow 01 — bitte die mitgelieferte Vorlage importieren.`);
    }
  }

  // Eingang: je Konto ein IMAP-Trigger, der die Mail mit dem Kontonamen versieht
  konten.forEach((konto, i) => {
    const y = 400 + i * 200; // unterhalb der fest eingebauten Gmail-Knoten
    const trigger = triggerKnoten(konto, [0, y]);
    const set     = setKnoten(konto, [220, y]);
    workflow.nodes.push(trigger, set);
    verbinde(workflow, trigger.name, set.name);
    verbinde(workflow, set.name, ANKER.triage.ziel);
  });

  // Ausgang: Weiche + je Konto ein Verschiebe-Knoten (Ausgang 0 bleibt Gmail)
  const weiche = weichenKnoten(konten, [1340, 120]);
  workflow.nodes.push(weiche);
  verbinde(workflow, ANKER.triage.weiche, weiche.name, 0);
  verbinde(workflow, weiche.name, ANKER.triage.gmailZiel, 0);
  konten.forEach((konto, i) => {
    const move = verschiebeKnoten(konto, [1600, 160 + i * 160]);
    workflow.nodes.push(move);
    verbinde(workflow, weiche.name, move.name, i + 1);
  });

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

async function bestandSynchronisieren(konten, credentialId) {
  const info = await workflowSuchen(ANKER.bestand.workflowPraefix);
  const workflow = await n8n.workflowHolen(info.id);
  panelKnotenEntfernen(workflow);
  if (credentialId) pruefKnotenVerdrahten(workflow, credentialId);

  const sammler = workflow.nodes.find((k) => k.name === ANKER.bestand.ziel);
  const kopf    = workflow.nodes.find((k) => k.name === ANKER.bestand.kopf);
  if (!sammler || !kopf) {
    throw new Error(`Workflow 04 passt nicht zur Vorlage (Knoten "${ANKER.bestand.kopf}"/"${ANKER.bestand.ziel}" fehlen).`);
  }

  // Abrufkette: Gmail Bestand -> Bestand: A -> Bestand: B -> ... -> Sammler
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
  verbinde(workflow, weiche.name, ANKER.bestand.gmailZiel, 0);
  konten.forEach((konto, i) => {
    const move = verschiebeKnoten(konto, [2040, 60 + i * 160]);
    workflow.nodes.push(move);
    verbinde(workflow, weiche.name, move.name, i + 1);
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

  let geminiCredId = null;
  let telegramCredId = null;

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

      if (geaendert) {
        await n8n.workflowSpeichern(wfInfo.id, workflow);
      }
    }
  } catch (err) {
    console.warn('Fehler beim Patchen der Workflows (KI/Telegram):', err.message);
  }
}

// Beide Workflows auf den aktuellen Kontenstand bringen
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

  const ergebnisse = [];
  ergebnisse.push(await triageSynchronisieren(konten, credentialId));
  ergebnisse.push(await bestandSynchronisieren(konten, credentialId));
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
  alleSynchronisieren, triageSynchronisieren, bestandSynchronisieren, basisSetup,
  // für Tests
  panelKnotenEntfernen, quellenEintragen, triggerKnoten, setKnoten, bestandKnoten,
};
