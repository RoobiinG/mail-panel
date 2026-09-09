const http = require('http');
const req = http.request({
  host: 'n8n',
  port: 5678,
  path: '/api/v1/executions?status=running',
  headers: { 'X-N8N-API-KEY': 'n8n' } // API key doesn't matter if we just test if the endpoint accepts the param without crashing. Wait, we need the real key to get data.
});
