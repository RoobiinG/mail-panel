// Client für die n8n-REST-API. Zugangsdaten kommen aus den Panel-Einstellungen
// (oder ersatzweise aus Umgebungsvariablen).
const axios    = require('axios');
const settings = require('./settings');

// Abfragen sind schnell; das Schreiben eines Workflows dauert deutlich laenger,
// weil n8n dabei den ganzen Graphen prueft und neu indiziert. Mit einem festen
// Limit von 15 s brach der Sync auf ausgelasteten Instanzen mitten in der Kette
// ab — deshalb bekommen schreibende Aufrufe mehr Zeit.
const ZEITLIMIT_LESEN    = 15000;
const ZEITLIMIT_SCHREIBEN = 60000;

function client(zeitlimit = ZEITLIMIT_LESEN) {
  const basis = (settings.hole('n8n_url') || 'http://n8n:5678').replace(/\/$/, '');
  const key   = settings.hole('n8n_api_key');
  if (!key) throw new Error('Kein n8n-API-Key hinterlegt (Einstellungen → n8n).');
  return axios.create({
    baseURL: `${basis}/api/v1`,
    headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' },
    timeout: zeitlimit,
  });
}

// Fehlermeldungen der n8n-API lesbar machen
function fehler(err, was) {
  const detail = err.response?.data?.message || err.response?.statusText || err.message;
  return new Error(`${was}: ${detail}`);
}

async function testVerbindung() {
  try {
    const { data } = await client().get('/workflows', { params: { limit: 1 } });
    return { ok: true, workflows: Array.isArray(data.data) ? data.data.length : 0 };
  } catch (err) {
    throw fehler(err, 'n8n nicht erreichbar');
  }
}

async function workflowsAuflisten() {
  try {
    const { data } = await client().get('/workflows', { params: { limit: 250 } });
    return data.data || [];
  } catch (err) {
    throw fehler(err, 'Workflows konnten nicht geladen werden');
  }
}

async function workflowHolen(id) {
  try {
    const { data } = await client().get(`/workflows/${id}`);
    return data;
  } catch (err) {
    throw fehler(err, `Workflow ${id} konnte nicht geladen werden`);
  }
}

async function workflowErstellen(workflow) {
  try {
    const { data } = await client(ZEITLIMIT_SCHREIBEN).post('/workflows', {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings || { executionOrder: 'v1' },
    });
    return data;
  } catch (err) {
    throw fehler(err, `Workflow "${workflow.name}" konnte nicht erstellt werden`);
  }
}

// Antwortet n8n nicht mehr, heisst das nicht, dass nichts passiert ist.
//
// Beobachtet auf dem Testserver: n8n registriert beim Speichern die Trigger neu
// und laeuft dabei in das Verbindungslimit des Mailservers (bei Dovecot
// mail_max_userip_connections, ab Werk 10). Die Antwort kommt dann nie — der
// Workflow ist aber gespeichert. Wer das als Fehlschlag meldet, schickt den
// Nutzer auf die Suche nach einem Problem, das keines ist.
//
// Deshalb: Nach einem Zeitlimit nachsehen, ob die Aenderung angekommen ist.
function knotenNamen(workflow) {
  return (workflow.nodes || []).map((k) => String(k.name)).sort().join('|');
}

// n8n akzeptiert beim Update nur diese vier Felder
async function workflowSpeichern(id, workflow) {
  const rumpf = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || { executionOrder: 'v1' },
  };
  try {
    const { data } = await client(ZEITLIMIT_SCHREIBEN).put(`/workflows/${id}`, rumpf);
    return data;
  } catch (err) {
    const zeitlimit = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
    if (zeitlimit) {
      try {
        const jetzt = await workflowHolen(id);
        if (knotenNamen(jetzt) === knotenNamen(workflow)) {
          console.warn(
            `Workflow ${id}: n8n hat nicht geantwortet, die Änderung ist aber gespeichert — `
            + 'meist das IMAP-Verbindungslimit des Mailservers.',
          );
          return jetzt;
        }
      } catch { /* Nachsehen ging auch schief — dann bleibt es ein Fehler */ }
      throw new Error(
        `Workflow ${id} konnte nicht gespeichert werden: n8n hat nicht geantwortet. `
        + 'Häufigste Ursache ist das IMAP-Verbindungslimit deines Mailservers — '
        + '"docker compose restart n8n" gibt die Verbindungen frei, danach klappt das Synchronisieren.',
      );
    }
    throw fehler(err, `Workflow ${id} konnte nicht gespeichert werden`);
  }
}

async function workflowAktivieren(id, aktiv) {
  try {
    const pfad = aktiv ? 'activate' : 'deactivate';
    const basis = (settings.hole('n8n_url') || 'http://n8n:5678').replace(/\/$/, '');
    const key = settings.hole('n8n_api_key');

    // Nativ fetch nutzen, um Axios-Probleme mit Content-Type und Body zu umgehen.
    // n8n (Fastify) lehnt {} inzwischen mit "Bad request - please check your parameters" ab.
    const response = await fetch(`${basis}/api/v1/workflows/${id}/${pfad}`, {
      method: 'POST',
      headers: {
        'X-N8N-API-KEY': key,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(ZEITLIMIT_SCHREIBEN)
    });

    if (!response.ok) {
      const fehlertext = await response.text().catch(() => response.statusText);
      throw new Error(`n8n-API antwortete mit ${response.status}: ${fehlertext}`);
    }

    return await response.json();
  } catch (err) {
    throw fehler(err, `Workflow ${id} konnte nicht ${aktiv ? 'aktiviert' : 'deaktiviert'} werden`);
  }
}

// Ein einziges Credential vom eingebauten Typ "imap" reicht für alles: den
// Email-Trigger von n8n selbst und — über die Einstellung
// authentication = coreImapAccount — auch den Community-Node n8n-nodes-imap.
async function credentialAnlegen({ name, host, port, username, passwort, tlsUnsicher = false }) {
  try {
    const { data } = await client().post('/credentials', {
      name,
      type: 'imap',
      data: {
        host,
        port: Number(port),
        user: username,
        password: passwort,
        secure: Number(port) === 993,
        allowUnauthorizedCerts: Boolean(tlsUnsicher),
      },
    });
    return data.id;
  } catch (err) {
    throw fehler(err, 'IMAP-Credential konnte nicht angelegt werden');
  }
}

// Header-Auth-Credential, mit dem die Workflows die Prüfdienste des Panels
// aufrufen. Wird einmalig angelegt; die ID merkt sich das Panel.
async function headerCredentialAnlegen(name, headerName, headerWert) {
  try {
    const { data } = await client().post('/credentials', {
      name,
      type: 'httpHeaderAuth',
      data: { name: headerName, value: headerWert },
    });
    return data.id;
  } catch (err) {
    throw fehler(err, 'Panel-Credential konnte nicht in n8n angelegt werden');
  }
}

async function credentialLoeschen(id) {
  if (!id) return;
  try {
    await client().delete(`/credentials/${id}`);
  } catch (err) {
    // Nicht mehr vorhanden ist kein Fehler — Hauptsache, es ist weg
    if (err.response?.status !== 404) throw fehler(err, 'IMAP-Credential konnte nicht gelöscht werden');
  }
}

async function telegramCredentialAnlegen(name, accessToken) {
  try {
    const { data } = await client().post('/credentials', {
      name,
      type: 'telegramApi',
      data: { accessToken },
    });
    return data.id;
  } catch (err) {
    throw fehler(err, 'Telegram-Credential konnte nicht in n8n angelegt werden');
  }
}

// Postausgang für den Send-Email-Knoten. Feldnamen laut Schema von n8n:
// user, password, host, port, secure, disableStartTls, hostName.
async function smtpCredentialAnlegen(name, { host, port, user, passwort, tlsUnsicher = false }) {
  const nummer = Number(port) || 587;
  try {
    const { data } = await client().post('/credentials', {
      name,
      type: 'smtp',
      data: {
        host,
        port: nummer,
        user: user || '',
        password: passwort || '',
        // 465 ist von Anfang an verschlüsselt, 587 und 25 steigen per STARTTLS um
        secure: nummer === 465,
        disableStartTls: false,
        ...(tlsUnsicher ? { hostName: host } : {}),
      },
    });
    return data.id;
  } catch (err) {
    throw fehler(err, 'SMTP-Credential konnte nicht in n8n angelegt werden');
  }
}

async function executionsAuflisten(limit = 20) {
  try {
    const { data } = await client().get('/executions', { params: { limit } });
    return data.data || [];
  } catch (err) {
    throw fehler(err, 'Executions konnten nicht geladen werden');
  }
}

module.exports = {
  client, testVerbindung, workflowsAuflisten, workflowHolen, workflowErstellen, workflowSpeichern,
  workflowAktivieren, credentialAnlegen, headerCredentialAnlegen, telegramCredentialAnlegen,
  smtpCredentialAnlegen, credentialLoeschen,
  executionsAuflisten,
};
