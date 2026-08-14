// Verbindungstest für den Postausgang (Workflow 06 verschickt darüber die
// Abmelde-Mails). Bewusst ohne zusätzliche Abhängigkeit: Der Ablauf ist
// Begrüßung → EHLO → ggf. STARTTLS → AUTH LOGIN → QUIT.
const net = require('net');
const tls = require('tls');

const ZEITLIMIT = 12000;

// Liest so lange, bis eine vollständige SMTP-Antwort da ist. Mehrzeilige
// Antworten erkennt man am Bindestrich hinter dem Code ("250-STARTTLS").
function antwort(socket) {
  return new Promise((fertig, fehler) => {
    let puffer = '';
    const uhr = setTimeout(() => { aufraeumen(); fehler(new Error('Zeitüberschreitung beim Warten auf den Server')); }, ZEITLIMIT);
    const aufraeumen = () => {
      clearTimeout(uhr);
      socket.removeListener('data', beiDaten);
      socket.removeListener('error', beiFehler);
    };
    const beiDaten = (teil) => {
      puffer += teil.toString('utf8');
      const zeilen = puffer.split(/\r?\n/).filter(Boolean);
      const letzte = zeilen[zeilen.length - 1] || '';
      // Abgeschlossen ist die Antwort erst bei "250 " (Leerzeichen statt Strich)
      if (/^\d{3} /.test(letzte)) {
        aufraeumen();
        fertig({ code: Number(letzte.slice(0, 3)), text: puffer.trim(), zeilen });
      }
    };
    const beiFehler = (err) => { aufraeumen(); fehler(err); };
    socket.on('data', beiDaten);
    socket.on('error', beiFehler);
  });
}

function senden(socket, zeile) {
  socket.write(zeile + '\r\n');
  return antwort(socket);
}

function verbinden(optionen) {
  return new Promise((fertig, fehler) => {
    const uhr = setTimeout(() => fehler(new Error('Zeitüberschreitung beim Verbinden')), ZEITLIMIT);
    const socket = optionen.secure
      ? tls.connect({ host: optionen.host, port: optionen.port, rejectUnauthorized: !optionen.tlsUnsicher, servername: optionen.host })
      : net.connect({ host: optionen.host, port: optionen.port });
    const ereignis = optionen.secure ? 'secureConnect' : 'connect';
    socket.once(ereignis, () => { clearTimeout(uhr); fertig(socket); });
    socket.once('error', (err) => { clearTimeout(uhr); fehler(err); });
  });
}

async function testVerbindung({ host, port, user, passwort, tlsUnsicher = false }) {
  if (!host) throw new Error('Kein SMTP-Server eingetragen.');
  const nummer = Number(port) || 587;
  // 465 spricht von Anfang an verschlüsselt, 587 und 25 steigen per STARTTLS um
  let socket = await verbinden({ host, port: nummer, secure: nummer === 465, tlsUnsicher });

  try {
    const gruss = await antwort(socket);
    if (gruss.code !== 220) throw new Error(`Server meldet: ${gruss.text.slice(0, 120)}`);

    let ehlo = await senden(socket, `EHLO mail-panel`);
    if (ehlo.code !== 250) throw new Error(`EHLO abgelehnt: ${ehlo.text.slice(0, 120)}`);

    let verschluesselt = nummer === 465;
    if (!verschluesselt && /STARTTLS/i.test(ehlo.text)) {
      const start = await senden(socket, 'STARTTLS');
      if (start.code !== 220) throw new Error(`STARTTLS abgelehnt: ${start.text.slice(0, 120)}`);
      socket = await new Promise((fertig, fehler) => {
        const sicher = tls.connect(
          { socket, rejectUnauthorized: !tlsUnsicher, servername: host },
          () => fertig(sicher),
        );
        sicher.once('error', fehler);
      });
      verschluesselt = true;
      ehlo = await senden(socket, `EHLO mail-panel`);
    }

    if (!user) {
      socket.write('QUIT\r\n');
      return { ok: true, verschluesselt, hinweis: 'Verbunden — ohne Benutzernamen wurde keine Anmeldung versucht.' };
    }

    const login = await senden(socket, 'AUTH LOGIN');
    if (login.code !== 334) throw new Error(`Der Server bietet AUTH LOGIN nicht an: ${login.text.slice(0, 120)}`);
    const benutzer = await senden(socket, Buffer.from(String(user)).toString('base64'));
    if (benutzer.code !== 334) throw new Error(`Benutzername abgelehnt: ${benutzer.text.slice(0, 120)}`);
    const kennwort = await senden(socket, Buffer.from(String(passwort || '')).toString('base64'));
    if (kennwort.code !== 235) throw new Error(`Anmeldung fehlgeschlagen: ${kennwort.text.slice(0, 120)}`);

    socket.write('QUIT\r\n');
    return { ok: true, verschluesselt, hinweis: 'Verbunden und angemeldet.' };
  } finally {
    try { socket.destroy(); } catch { /* war schon zu */ }
  }
}

module.exports = { testVerbindung };
