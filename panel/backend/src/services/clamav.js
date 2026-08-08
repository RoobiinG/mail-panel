// Direkte Anbindung an clamd ueber das TCP-Protokoll (kein REST-Wrapper noetig).
// Etappe 1: PING-Verbindungstest. Etappe 4: INSTREAM-Scan von Anhaengen.
const net = require('net');

const CLAMD_HOST = process.env.CLAMD_HOST || 'clamav';
const CLAMD_PORT = parseInt(process.env.CLAMD_PORT || '3310', 10);

function ping(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: CLAMD_HOST, port: CLAMD_PORT, timeout: timeoutMs });
    let antwort = '';
    socket.on('connect', () => socket.write('nPING\n'));
    socket.on('data', (chunk) => {
      antwort += chunk.toString();
      if (antwort.includes('PONG')) { socket.end(); resolve({ ok: true }); }
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('clamd: Timeout')); });
    socket.on('error', (err) => reject(new Error(`clamd: ${err.message}`)));
    socket.on('close', () => { if (!antwort.includes('PONG')) reject(new Error('clamd: keine PONG-Antwort')); });
  });
}

module.exports = { ping };
