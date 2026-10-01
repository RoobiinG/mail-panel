// Postausgang des Panels: Verbindungstest und Versand einzelner Mails.
//
// Workflow 06 verschickt darüber die Abmelde-Mails (dafür gibt es hier den Test);
// das Panel selbst verschickt Einmalcodes für die Zwei-Faktor-Anmeldung.
// Bewusst ohne zusätzliche Abhängigkeit: Der Ablauf ist
// Begrüßung → EHLO → ggf. STARTTLS → AUTH LOGIN → (MAIL FROM, RCPT TO, DATA) → QUIT.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

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
  // Ein Zeilenumbruch im Befehl schleuste weitere Befehle ein (SMTP-Injection).
  if (/[\r\n]/.test(zeile)) throw new Error('Ungültige Zeichen im SMTP-Befehl.');
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

/**
 * Baut eine SMTP-Sitzung auf: verbinden, begrüßen, verschlüsseln, anmelden.
 * Der Aufrufer schließt den Socket.
 * @returns {Promise<{socket: object, verschluesselt: boolean, angemeldet: boolean}>}
 */
async function sitzungOeffnen({ host, port, user, passwort, tlsUnsicher = false }) {
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

    if (!user) return { socket, verschluesselt, angemeldet: false };

    const login = await senden(socket, 'AUTH LOGIN');
    if (login.code !== 334) throw new Error(`Der Server bietet AUTH LOGIN nicht an: ${login.text.slice(0, 120)}`);
    const benutzer = await senden(socket, Buffer.from(String(user)).toString('base64'));
    if (benutzer.code !== 334) throw new Error(`Benutzername abgelehnt: ${benutzer.text.slice(0, 120)}`);
    const kennwort = await senden(socket, Buffer.from(String(passwort || '')).toString('base64'));
    if (kennwort.code !== 235) throw new Error(`Anmeldung fehlgeschlagen: ${kennwort.text.slice(0, 120)}`);
    return { socket, verschluesselt, angemeldet: true };
  } catch (err) {
    try { socket.destroy(); } catch { /* war schon zu */ }
    throw err;
  }
}

async function testVerbindung(optionen) {
  const sitzung = await sitzungOeffnen(optionen);
  try {
    sitzung.socket.write('QUIT\r\n');
    return {
      ok: true,
      verschluesselt: sitzung.verschluesselt,
      hinweis: sitzung.angemeldet
        ? 'Verbunden und angemeldet.'
        : 'Verbunden — ohne Benutzernamen wurde keine Anmeldung versucht.',
    };
  } finally {
    try { sitzung.socket.destroy(); } catch { /* war schon zu */ }
  }
}

// ─── Mail senden ─────────────────────────────────────────────────────────────

// Eine Zeichenliste statt einer Sperrliste: Nur Buchstaben, Ziffern und . _ % + -
// kommen durch. Alles andere — Leerzeichen, Steuerzeichen (auch NUL), Anführungs-
// zeichen, Klammern, Komma, Semikolon, Nicht-ASCII — kann auch keinen Kopf einer
// Mail verlängern, keinen zweiten Empfänger anhängen und keinen Befehl einschleusen.
// Ungewöhnliche, aber gültige Adressen (Anführungszeichen im Namen, Umlaut-Domains)
// sind dafür der Preis.
const ADRESSE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const istAdresse = (text) => typeof text === 'string' && text.length <= 254 && ADRESSE.test(text);

// Nicht-ASCII im Betreff als RFC-2047-Codewort. Immer base64, auch bei reinem
// ASCII — dann gibt es nichts, was ein Zeilenumbruch verlängern könnte.
const kopfText = (text) => `=?UTF-8?B?${Buffer.from(String(text).replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;

function nachricht({ von, an, betreff, text }) {
  const domain = von.split('@')[1];
  // Der Text geht als base64 hinaus: keine Zeile beginnt mit ".", und kein Zeichen
  // des Textes kann das Ende der Daten ("\r\n.\r\n") vortäuschen.
  const rumpf = Buffer.from(String(text), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: <${von}>`,
    `To: <${an}>`,
    `Subject: ${kopfText(betreff)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    // Verhindert Abwesenheits-Antworten auf Einmalcodes
    'Auto-Submitted: auto-generated',
    '',
    rumpf,
  ].join('\r\n');
}

/**
 * Verschickt eine Textmail über den Postausgang des Panels (Einstellungen → SMTP).
 * @param {object} p
 * @param {string} p.host @param {number|string} [p.port] @param {string} [p.user] @param {string} [p.passwort]
 * @param {boolean} [p.tlsUnsicher]
 * @param {string} [p.absender] Absenderadresse; ohne sie dient der SMTP-Benutzer, wenn er eine Adresse ist
 * @param {string} p.an Empfänger
 * @param {string} p.betreff @param {string} p.text
 */
async function mailSenden({ host, port, user, passwort, tlsUnsicher = false, absender, an, betreff, text }) {
  if (!istAdresse(an)) throw new Error('Die Empfängeradresse ist ungültig.');
  const von = istAdresse(absender) ? absender : (istAdresse(user) ? user : null);
  if (!von) throw new Error('Kein Absender eingetragen (Einstellungen → Postausgang → Absender).');

  const sitzung = await sitzungOeffnen({ host, port, user, passwort, tlsUnsicher });
  const { socket } = sitzung;
  try {
    const mail = await senden(socket, `MAIL FROM:<${von}>`);
    if (mail.code !== 250) throw new Error(`Absender abgelehnt: ${mail.text.slice(0, 120)}`);
    const rcpt = await senden(socket, `RCPT TO:<${an}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251) throw new Error(`Empfänger abgelehnt: ${rcpt.text.slice(0, 120)}`);
    const daten = await senden(socket, 'DATA');
    if (daten.code !== 354) throw new Error(`DATA abgelehnt: ${daten.text.slice(0, 120)}`);

    socket.write(`${nachricht({ von, an, betreff, text })}\r\n.\r\n`);
    const ende = await antwort(socket);
    if (ende.code !== 250) throw new Error(`Mail nicht angenommen: ${ende.text.slice(0, 120)}`);

    socket.write('QUIT\r\n');
    return { ok: true, verschluesselt: sitzung.verschluesselt };
  } finally {
    try { socket.destroy(); } catch { /* war schon zu */ }
  }
}

module.exports = { testVerbindung, mailSenden, sitzungOeffnen, istAdresse };
