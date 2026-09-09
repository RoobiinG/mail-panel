const db = require('better-sqlite3')('/app/data/mail-panel.db');

async function test() {
  const row = db.prepare('SELECT wert FROM einstellungen WHERE schluessel = ?').get('n8n_api_key');
  const key = row ? row.wert : '';
  
  try {
    const res = await fetch('http://n8n:5678/api/v1/executions?status=running', { headers: { 'X-N8N-API-KEY': key } });
    const data = await res.json();
    console.log('running:', data.data ? data.data.length : data);
  } catch (err) {
    console.log('err running:', err.message);
  }
  try {
    const res2 = await fetch('http://n8n:5678/api/v1/executions?status=new', { headers: { 'X-N8N-API-KEY': key } });
    const data2 = await res2.json();
    console.log('new:', data2.data ? data2.data.length : data2);
  } catch (err) {
    console.log('err new:', err.message);
  }
  try {
    const res3 = await fetch('http://n8n:5678/api/v1/active-executions', { headers: { 'X-N8N-API-KEY': key } });
    const data3 = await res3.json();
    console.log('active-executions:', data3.data ? data3.data.length : data3);
  } catch (err) {
    console.log('err active-executions:', err.message);
  }
}
test();
