// HTTPS auf dem eigenen Port — ohne Reverse Proxy davor.
//
// Das Panel verwaltet IMAP-Zugangsdaten und zeigt Mailinhalte. Wer es über eine
// unverschlüsselte Verbindung bedient, gibt sein Panel-Passwort und alles
// Weitere jedem preis, der auf dem Weg mithört. Deshalb spricht es von sich aus
// HTTPS, auch wenn niemand etwas einrichtet.
//
// Drei Betriebsarten, gesteuert über die Umgebung:
//
//   TLS_CERT + TLS_KEY gesetzt  → genau diese Dateien werden benutzt.
//                                 Der übliche Fall auf einem Server mit eigener
//                                 Domain: die Let's-Encrypt-Dateien einhängen.
//   nichts gesetzt (Standard)   → beim ersten Start wird ein eigenes Zertifikat
//                                 erzeugt und im Datenverzeichnis abgelegt.
//                                 Der Browser warnt davor, weil niemand dafür
//                                 bürgt — die Verbindung ist trotzdem
//                                 verschlüsselt.
//   TLS_MODUS=aus               → schlichtes HTTP. Nur sinnvoll, wenn schon ein
//                                 Reverse Proxy davorsteht, der TLS übernimmt.
//
// Wer versehentlich http:// aufruft, landet nicht im Nichts: Auf demselben Port
// wird anhand des ersten Bytes unterschieden und auf https:// umgeleitet.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const DATEN = process.env.DATA_DIR || '/app/data';
const EIGENE = path.join(DATEN, 'tls');

function modus() {
  const roh = String(process.env.TLS_MODUS || '').trim().toLowerCase();
  if (['aus', 'off', 'nein', '0', 'false'].includes(roh)) return 'aus';
  return 'an';
}

// Für welchen Namen soll das selbst erzeugte Zertifikat gelten? Wer PANEL_HOST
// setzt, bekommt seinen Namen hinein; sonst der Rechnername. Zusätzlich immer
// localhost, damit der Aufruf auf der Maschine selbst nicht warnt.
function namen() {
  const eigen = String(process.env.PANEL_HOST || '').trim();
  const liste = ['localhost'];
  if (eigen && !liste.includes(eigen)) liste.unshift(eigen);
  const rechner = os.hostname();
  if (rechner && !liste.includes(rechner)) liste.push(rechner);
  return liste;
}

function selbstErzeugen() {
  fs.mkdirSync(EIGENE, { recursive: true });
  const zertDatei = path.join(EIGENE, 'panel.crt');
  const schluesselDatei = path.join(EIGENE, 'panel.key');
  if (fs.existsSync(zertDatei) && fs.existsSync(schluesselDatei)) {
    return { cert: fs.readFileSync(zertDatei), key: fs.readFileSync(schluesselDatei), quelle: 'selbst' };
  }

  const liste = namen();
  const san = liste.map((n) => `DNS:${n}`).concat('IP:127.0.0.1').join(',');
  // Zehn Jahre: Ein selbst erzeugtes Zertifikat abläufig zu machen hilft
  // niemandem — es würde nur irgendwann unbemerkt den Zugang sperren.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', schluesselDatei, '-out', zertDatei,
    '-days', '3650', '-subj', `/CN=${liste[0]}`,
    '-addext', `subjectAltName=${san}`,
  ], { stdio: 'pipe' });
  fs.chmodSync(schluesselDatei, 0o600);

  return {
    cert: fs.readFileSync(zertDatei),
    key: fs.readFileSync(schluesselDatei),
    quelle: 'selbst',
    neu: true,
    namen: liste,
  };
}

function zertifikat() {
  const zertPfad = String(process.env.TLS_CERT || '').trim();
  const schluesselPfad = String(process.env.TLS_KEY || '').trim();

  if (zertPfad || schluesselPfad) {
    // Halb gesetzt ist ein Fehler und keine Einladung, still auf etwas anderes
    // auszuweichen — sonst läuft jemand mit selbst erzeugtem Zertifikat, obwohl
    // er ein echtes hinterlegen wollte.
    if (!zertPfad || !schluesselPfad) {
      throw new Error('TLS_CERT und TLS_KEY müssen beide gesetzt sein oder beide leer bleiben.');
    }
    for (const p of [zertPfad, schluesselPfad]) {
      if (!fs.existsSync(p)) throw new Error(`TLS-Datei nicht gefunden: ${p}`);
    }
    return {
      cert: fs.readFileSync(zertPfad),
      key: fs.readFileSync(schluesselPfad),
      quelle: 'eigene',
    };
  }
  return selbstErzeugen();
}

// Startet den Server und meldet zurück, was er geworden ist.
function starten(app, port, fertig) {
  if (modus() === 'aus') {
    const server = http.createServer(app);
    server.listen(port, () => fertig({ tls: false, quelle: 'aus' }));
    return server;
  }

  const z = zertifikat();
  const sicher = https.createServer({ cert: z.cert, key: z.key }, app);

  const umleitung = http.createServer((req, res) => {
    // Ausnahme: die interne Schnittstelle.
    //
    // n8n ruft das Panel im Docker-Netz über http://panel:3002 auf — diese
    // Adresse steht in den Workflow-Vorlagen und in bereits eingerichteten
    // Workflows. Würde sie hier umgeleitet, bräche bei jeder bestehenden
    // Installation die Sortierung, sobald jemand das Update einspielt, ohne
    // vorher zu synchronisieren. Und zwar lautlos.
    //
    // Diese Schnittstelle ist durch ein eigenes Geheimnis geschützt und für
    // Maschinen gedacht. Wer auch sie nicht im Klartext haben will, gibt den
    // Port nicht nach außen frei (PANEL_PORT=127.0.0.1:3002).
    if (String(req.url || '').startsWith('/api/internal/')) return app(req, res);

    // Zweite Ausnahme: Anfragen von einem Reverse Proxy, der TLS schon
    // übernommen hat.
    //
    // Ein Nginx Proxy Manager davor spricht das Panel innen über http an. Eine
    // Umleitung wäre hier nicht nur überflüssig, sondern schädlich: Sie schickte
    // den Browser mit "https://<name>:3002" am Proxy VORBEI direkt auf diesen
    // Port — und verriete dabei die interne Adresse. Wer die Anfrage
    // weitergereicht hat, sagt uns über X-Forwarded-Proto, dass außen bereits
    // verschlüsselt wurde. Dann wird schlicht bedient.
    if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') {
      return app(req, res);
    }

    // Alles andere: Wer http:// eingibt, soll nicht auf Kauderwelsch starren.
    const host = String(req.headers.host || '').replace(/:\d+$/, '') || 'localhost';
    res.writeHead(308, { Location: `https://${host}:${port}${req.url}` });
    return res.end('Dieses Panel spricht HTTPS. Bitte https:// verwenden.\n');
  });

  // Ein TLS-Handshake beginnt immer mit 0x16. Daran lässt sich schon am ersten
  // Byte erkennen, wohin die Verbindung gehört — beides auf demselben Port.
  const weiche = net.createServer((verbindung) => {
    verbindung.once('data', (erstes) => {
      verbindung.unshift(erstes);
      (erstes[0] === 0x16 ? sicher : umleitung).emit('connection', verbindung);
    });
    verbindung.on('error', () => { /* abgebrochene Verbindungen sind normal */ });
  });

  weiche.listen(port, () => fertig({ tls: true, quelle: z.quelle, neu: z.neu, namen: z.namen }));
  return weiche;
}

module.exports = { starten, modus, zertifikat, namen };
