// Verbindungstest für IMAP-Konten, bevor sie in n8n angelegt werden,
// und das Anlegen fehlender Zielordner.
const { ImapFlow } = require('imapflow');

// Die vier Zielordner der Triage plus das Archiv des Newsletter-Aufräumens.
// Leer gelassene Felder fallen auf diese Namen zurück.
const STANDARD = {
  folder_spam: 'Quarantaene',
  folder_invoices: 'Rechnungen',
  folder_orders: 'Bestellungen',
  folder_newsletter: 'Newsletter',
  folder_archive: 'Archiv',
};

function zielordner(konto) {
  return Object.entries(STANDARD).map(([feld, standard]) => (konto[feld] || standard).trim());
}

function verbindung({ host, port, username, passwort, tlsUnsicher = false }) {
  return new ImapFlow({
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
}

async function testVerbindung(konto) {
  const client = verbindung(konto);
  try {
    await client.connect();
    const postfach = await client.mailboxOpen('INBOX', { readOnly: true });
    const liste = await client.list();
    const vorhanden = liste.map((o) => o.path);
    return {
      ok: true,
      nachrichten: postfach.exists,
      // Die Oberfläche bietet diese Liste zur Auswahl an, damit man eigene
      // Ordner nehmen kann, statt neue anlegen zu müssen.
      ordner: vorhanden,
      fehlendeOrdner: zielordner(konto).filter((soll) => !vorhanden.includes(soll)),
    };
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Legt die Zielordner an, die im Postfach noch fehlen. Bereits vorhandene
// Ordner bleiben unangetastet — es wird nie etwas gelöscht oder umbenannt.
async function ordnerAnlegen(konto) {
  const client = verbindung(konto);
  const angelegt = [];
  const fehler = [];
  try {
    await client.connect();
    const vorhanden = (await client.list()).map((o) => o.path);
    for (const name of zielordner(konto)) {
      if (vorhanden.includes(name)) continue;
      try {
        await client.mailboxCreate(name);
        angelegt.push(name);
      } catch (err) {
        // Manche Server verlangen ein Präfix (z. B. "INBOX.Archiv") oder
        // verbieten das Anlegen ganz — das muss der Nutzer erfahren.
        fehler.push({ ordner: name, grund: err.message });
      }
    }
    const jetzt = (await client.list()).map((o) => o.path);
    return {
      ok: fehler.length === 0,
      angelegt,
      fehler,
      ordner: jetzt,
      fehlendeOrdner: zielordner(konto).filter((soll) => !jetzt.includes(soll)),
    };
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

module.exports = { testVerbindung, ordnerAnlegen, STANDARD };
