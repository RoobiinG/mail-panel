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

function scan(buffer, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: CLAMD_HOST, port: CLAMD_PORT, timeout: timeoutMs });
    let antwort = '';
    
    socket.on('connect', () => {
      socket.write('nINSTREAM\n');
      
      let offset = 0;
      const chunkSize = 8 * 1024 * 1024; // 8MB Chunks (Standard bei ClamAV)
      
      while (offset < buffer.length) {
        const length = Math.min(chunkSize, buffer.length - offset);
        const chunk = buffer.subarray(offset, offset + length);
        
        // Länge als 4-Byte Integer (Big Endian / Network Byte Order) schreiben
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32BE(length, 0);
        
        socket.write(lengthBuffer);
        socket.write(chunk);
        
        offset += length;
      }
      
      // Ende-Signal (Länge 0)
      const endBuffer = Buffer.alloc(4);
      endBuffer.writeUInt32BE(0, 0);
      socket.write(endBuffer);
    });

    socket.on('data', (chunk) => {
      antwort += chunk.toString();
      if (antwort.includes('FOUND') || antwort.includes('OK')) {
        socket.end();
      }
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error('clamd: Timeout beim Scan')); });
    socket.on('error', (err) => reject(new Error(`clamd: ${err.message}`)));
    socket.on('close', () => {
      if (antwort.includes('FOUND')) {
        const match = antwort.match(/stream: (.+) FOUND/);
        const virusName = match ? match[1] : 'Unknown.Malware';
        resolve({ clean: false, virus: virusName });
      } else if (antwort.includes('OK')) {
        resolve({ clean: true });
      } else {
        reject(new Error(`clamd: unerwartete Antwort: ${antwort.trim()}`));
      }
    });
  });
}

module.exports = { ping, scan };
