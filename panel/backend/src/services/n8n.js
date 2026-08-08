// Client für die n8n-REST-API. Zugangsdaten kommen aus den Panel-Einstellungen
// (oder ersatzweise aus Umgebungsvariablen).
const axios    = require('axios');
const settings = require('./settings');

function client() {
  const basis = (settings.hole('n8n_url') || 'http://n8n:5678').replace(/\/$/, '');
  const key   = settings.hole('n8n_api_key');
  if (!key) throw new Error('Kein n8n-API-Key hinterlegt (Einstellungen → n8n).');
  return axios.create({
    baseURL: `${basis}/api/v1`,
    headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' },
    timeout: 15000,
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

// n8n akzeptiert beim Update nur diese vier Felder
async function workflowSpeichern(id, workflow) {
  try {
    const { data } = await client().put(`/workflows/${id}`, {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings || { executionOrder: 'v1' },
    });
    return data;
  } catch (err) {
    throw fehler(err, `Workflow ${id} konnte nicht gespeichert werden`);
  }
}

async function workflowAktivieren(id, aktiv) {
  try {
    const pfad = aktiv ? 'activate' : 'deactivate';
    const { data } = await client().post(`/workflows/${id}/${pfad}`);
    return data;
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

async function credentialLoeschen(id) {
  if (!id) return;
  try {
    await client().delete(`/credentials/${id}`);
  } catch (err) {
    // Nicht mehr vorhanden ist kein Fehler — Hauptsache, es ist weg
    if (err.response?.status !== 404) throw fehler(err, 'IMAP-Credential konnte nicht gelöscht werden');
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
  client, testVerbindung, workflowsAuflisten, workflowHolen, workflowSpeichern,
  workflowAktivieren, credentialAnlegen, credentialLoeschen, executionsAuflisten,
};
