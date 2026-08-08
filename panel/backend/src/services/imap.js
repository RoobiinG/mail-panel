// Verbindungstest für IMAP-Konten, bevor sie in n8n angelegt werden.
const { ImapFlow } = require('imapflow');

async function testVerbindung({ host, port, username, passwort }) {
  const client = new ImapFlow({
    host,
    port: Number(port),
    secure: Number(port) === 993,
    auth: { user: username, pass: passwort },
    logger: false,
    // Nicht ewig hängen bleiben, wenn Host/Port nicht stimmen
    socketTimeout: 15000,
    greetingTimeout: 10000,
    connectionTimeout: 10000,
  });
  try {
    await client.connect();
    const postfach = await client.mailboxOpen('INBOX', { readOnly: true });
    const ordner = await client.list();
    return {
      ok: true,
      nachrichten: postfach.exists,
      ordner: ordner.map((o) => o.path),
    };
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

module.exports = { testVerbindung };
