// Verbindungstest für IMAP-Konten, bevor sie in n8n angelegt werden.
const { ImapFlow } = require('imapflow');

async function testVerbindung({ host, port, username, passwort, tlsUnsicher = false, folder_spam, folder_invoices, folder_orders, folder_newsletter }) {
  const client = new ImapFlow({
    host,
    port: Number(port),
    // 993 = direkt verschlüsselt, 143 = Klartext mit STARTTLS-Upgrade
    secure: Number(port) === 993,
    auth: { user: username, pass: passwort },
    logger: false,
    // Eigene Mailserver laufen oft mit selbstsigniertem Zertifikat
    tls: { rejectUnauthorized: !tlsUnsicher },
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
      // Damit die Oberfläche warnen kann, wenn Zielordner fehlen
      fehlendeOrdner: [
        folder_spam || 'Quarantaene',
        folder_invoices || 'Rechnungen',
        folder_orders || 'Bestellungen',
        folder_newsletter || 'Newsletter'
      ].filter((soll) => !ordner.some((o) => o.path === soll)),
    };
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

module.exports = { testVerbindung };
