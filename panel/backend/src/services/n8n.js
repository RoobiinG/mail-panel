// Client fuer die n8n-REST-API (X-N8N-API-KEY).
// Ab Etappe 2 kommen hier Credential-Anlage und der Workflow-Patcher dazu.
const axios = require('axios');

const client = () => axios.create({
  baseURL: `${(process.env.N8N_URL || 'http://n8n:5678').replace(/\/$/, '')}/api/v1`,
  headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY || '' },
  timeout: 10000,
});

// Verbindungstest: eine minimale Workflow-Abfrage
async function testVerbindung() {
  const { data } = await client().get('/workflows', { params: { limit: 1 } });
  return { ok: true, workflows: Array.isArray(data.data) ? data.data.length : 0 };
}

async function workflowsAuflisten() {
  const { data } = await client().get('/workflows', { params: { limit: 100 } });
  return data.data || [];
}

module.exports = { client, testVerbindung, workflowsAuflisten };
