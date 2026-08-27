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

// Legt gezielt einen bestimmten Ordnernamen an, falls er nicht existiert.
// Nützlich, wenn in der UI ein neuer Ordner für eine Sortier-Regel getippt wird.
async function ordnerErstellen(konto, ordnerName) {
  if (!ordnerName) return false;
  const client = verbindung(konto);
  try {
    await client.connect();
    const vorhanden = (await client.list()).map((o) => o.path);
    if (!vorhanden.includes(ordnerName)) {
      await client.mailboxCreate(ordnerName);
      return true; // Wurde neu angelegt
    }
    return false; // Existierte bereits
  } catch (err) {
    throw err;
  } finally {
    try { await client.logout(); } catch { }
  }
}

// Grenzen für das Holen der Anhänge — ein Postfach ist keine vertrauenswürdige
// Quelle, deshalb wird nicht unbegrenzt in den Speicher geladen.
const MAX_ANHAENGE = 20;
const MAX_GROESSE = 30 * 1024 * 1024; // 30 MB je Datei

// Läuft rekursiv durch die Struktur einer Mail und sammelt die Anhang-Teile ein.
// imapflow liefert sie als Baum; ein Teil gilt als Anhang, wenn er so ausgewiesen
// ist oder einen Dateinamen trägt.
function anhangTeile(knoten, gefunden = []) {
  if (!knoten) return gefunden;
  for (const teil of knoten.childNodes || []) anhangTeile(teil, gefunden);
  const name = knoten.dispositionParameters?.filename || knoten.parameters?.name;
  const istAnhang = knoten.disposition === 'attachment' || (name && knoten.part);
  if (istAnhang && knoten.part) {
    gefunden.push({ part: knoten.part, name: name || knoten.part, groesse: knoten.size || 0 });
  }
  return gefunden;
}

async function stromLesen(strom, grenze) {
  const stuecke = [];
  let gesamt = 0;
  for await (const stueck of strom) {
    gesamt += stueck.length;
    if (gesamt > grenze) throw new Error('Anhang ist größer als erlaubt');
    stuecke.push(stueck);
  }
  return Buffer.concat(stuecke);
}

// Holt alle Anhänge einer Mail. `uid` ist die IMAP-UID, `ordner` das Postfach.
// Gibt je Anhang Name und Inhalt zurück — gescannt wird eine Ebene höher.
async function anhaengeHolen({ ordner = 'INBOX', uid, ...konto }) {
  const nummer = Number(uid);
  if (!Number.isInteger(nummer) || nummer <= 0) throw new Error('Ungültige UID.');

  const client = verbindung(konto);
  try {
    await client.connect();
    const schloss = await client.getMailboxLock(String(ordner || 'INBOX'));
    try {
      const nachricht = await client.fetchOne(String(nummer), { bodyStructure: true }, { uid: true });
      if (!nachricht) return { gefunden: 0, anhaenge: [] };

      const teile = anhangTeile(nachricht.bodyStructure).slice(0, MAX_ANHAENGE);
      const anhaenge = [];
      for (const teil of teile) {
        if (teil.groesse > MAX_GROESSE) {
          anhaenge.push({ name: teil.name, fehler: 'zu groß für den Scan' });
          continue;
        }
        try {
          const { content } = await client.download(String(nummer), teil.part, { uid: true });
          anhaenge.push({ name: teil.name, inhalt: await stromLesen(content, MAX_GROESSE) });
        } catch (err) {
          anhaenge.push({ name: teil.name, fehler: err.message });
        }
      }
      return { gefunden: teile.length, anhaenge };
    } finally {
      schloss.release();
    }
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Die Ordner eines Postfachs mit ihren IMAP-Kennzeichnungen.
//
// Nur der Pfad reicht nicht: Gmail liefert "[Gmail]/Alle Nachrichten",
// "[Gmail]/Markiert" und "[Gmail]/Wichtig" wie gewoehnliche Ordner aus, obwohl
// es Ansichten sind — dort etwas hineinzuschieben geht schief oder laesst die
// Mail verschwinden. "[Gmail]" selbst traegt \Noselect und kann ueberhaupt
// keine Nachrichten aufnehmen. Erkennbar ist das nur an specialUse und den
// Flags, nicht am Namen: Der ist je nach Sprache des Kontos anders.
// Sonderrollen nach RFC 6154 plus die Erweiterungen, die Gmail benutzt.
// Wichtig: Nicht jede davon steht in `specialUse`. Gmail weist "Wichtig" nur
// ueber das LIST-Flag \Important aus — wer nur specialUse liest, uebersieht es
// und laesst damit eine Ansicht als Sortierziel zu.
const SONDERROLLEN = new Set([
  'all', 'archive', 'drafts', 'flagged', 'junk', 'sent', 'trash',
  'important', 'inbox', 'noselect', 'nonexistent',
]);

// Flags kommen mit fuehrendem Backslash ("\Important") — den schneiden wir ab.
const rolle = (wert) => String(wert || '').replace(/^\\/, '').toLowerCase();

async function ordnerDetails(konto) {
  const client = verbindung(konto);
  try {
    await client.connect();
    return (await client.list()).map((o) => {
      const flags = [...(o.flags || [])];
      const ausFlags = flags.map(rolle).find((f) => SONDERROLLEN.has(f)) || null;
      const gefunden = o.specialUse ? rolle(o.specialUse) : ausFlags;
      return {
        pfad: o.path,
        name: o.name,
        // Der Rollenname ohne Backslash, oder null fuer einen gewoehnlichen Ordner
        spezial: gefunden && gefunden !== 'noselect' && gefunden !== 'nonexistent' ? gefunden : null,
        flags,
        // Noselect und NonExistent sind reine Zwischenknoten im Ordnerbaum und
        // koennen ueberhaupt keine Nachrichten aufnehmen.
        auswaehlbar: !flags.map(rolle).some((f) => f === 'noselect' || f === 'nonexistent'),
      };
    });
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Legt einen Ordner an und gibt den Pfad zurueck, den der Server vergeben hat.
// `pfad` darf ein Array sein ([Eltern, Kind]) — dann setzt imapflow das
// Trennzeichen des Servers selbst ein (bei Dovecot meist "/", bei anderen ".").
// Genau deshalb wird hier nicht selbst zusammengebaut.
async function ordnerAnlegenPfad(konto, pfad) {
  const client = verbindung(konto);
  try {
    await client.connect();
    const ergebnis = await client.mailboxCreate(pfad);
    return ergebnis.path;
  } catch (err) {
    // "ALREADYEXISTS" ist kein Fehler — dann steht der Ordner eben schon da
    if (/exist/i.test(err.message)) {
      const gesucht = Array.isArray(pfad) ? pfad[pfad.length - 1] : pfad;
      const liste = await client.list();
      const treffer = liste.find((o) => o.path === pfad || o.name === gesucht);
      if (treffer) return treffer.path;
    }
    throw err;
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Verschiebt eine einzelne Mail. Wird gebraucht, wenn ein KI-Ordner erst
// nachtraeglich freigegeben wird und die wartenden Mails noch im Posteingang
// liegen. Geloescht wird dabei nichts — IMAP MOVE ist ein Umhaengen.
async function mailVerschieben({ uid, von = 'INBOX', nach, ...konto }) {
  const nummer = Number(uid);
  if (!Number.isInteger(nummer) || nummer <= 0) throw new Error('Ungültige UID.');
  if (!nach) throw new Error('Kein Zielordner angegeben.');

  const client = verbindung(konto);
  try {
    await client.connect();
    const schloss = await client.getMailboxLock(String(von));
    try {
      const ergebnis = await client.messageMove(String(nummer), String(nach), { uid: true });
      // messageMove meldet keinen Fehler, wenn die UID in diesem Ordner gar
      // nicht existiert — es passiert dann einfach nichts. Wer sich auf das
      // stille Gelingen verlaesst, meldet dem Nutzer einen Umzug, den es nie
      // gab. Deshalb wird hier geprueft, ob wirklich etwas bewegt wurde.
      const bewegt = ergebnis?.uidMap instanceof Map
        ? ergebnis.uidMap.size
        : Object.keys(ergebnis?.uidMap || {}).length;
      if (!bewegt) {
        throw new Error(`Keine Nachricht mit UID ${nummer} in "${von}" gefunden.`);
      }
      return ergebnis;
    } finally {
      schloss.release();
    }
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Sucht eine Mail in einem bestimmten Ordner ueber Absender und Betreff.
//
// Warum nicht einfach die gespeicherte UID nehmen? Weil IMAP die UIDs **je
// Ordner** vergibt. Sobald eine Mail vom Posteingang in den Zielordner
// gewandert ist, hat sie dort eine andere Nummer — die alte zeigt entweder ins
// Leere oder, schlimmer, auf eine ganz andere Nachricht. Ein Verschieben ueber
// die alte UID meldet dann klaglos Erfolg und tut nichts.
//
// @returns {Promise<number[]>} gefundene UIDs, neueste zuletzt
async function mailsSuchen({ ordner, von, betreff, ...konto }) {
  const client = verbindung(konto);
  try {
    await client.connect();
    const schloss = await client.getMailboxLock(String(ordner));
    try {
      const kriterien = {};
      if (von) kriterien.from = String(von);
      if (betreff) kriterien.subject = String(betreff);
      if (!kriterien.from && !kriterien.subject) return [];
      const treffer = await client.search(kriterien, { uid: true });
      return Array.isArray(treffer) ? treffer : [];
    } finally {
      schloss.release();
    }
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
}

// Verschiebt mehrere Mails ueber EINE Verbindung.
//
// Wichtig, weil Mailserver die gleichzeitigen IMAP-Verbindungen begrenzen
// (Dovecot: mail_max_userip_connections, ab Werk oft 10). Eine Verbindung je
// Mail waere nicht nur langsam, sondern liefe bei groesseren Stapeln genau in
// dieses Limit — mit demselben Ergebnis, das n8n beim Speichern schon zeigt.
//
// @param {Array<{uid: string|number, id?: any}>} mails
// @returns {Promise<{verschoben: Array, fehler: Array<{uid, grund}>}>}
async function mailsVerschieben({ mails, von = 'INBOX', nach, ...konto }) {
  if (!nach) throw new Error('Kein Zielordner angegeben.');
  const verschoben = [];
  const fehler = [];
  if (!mails?.length) return { verschoben, fehler };

  const client = verbindung(konto);
  try {
    await client.connect();
    const schloss = await client.getMailboxLock(String(von));
    try {
      for (const mail of mails) {
        const nummer = Number(mail.uid);
        if (!Number.isInteger(nummer) || nummer <= 0) {
          fehler.push({ uid: mail.uid, grund: 'ungültige UID' });
          continue;
        }
        try {
          const ergebnis = await client.messageMove(String(nummer), String(nach), { uid: true });
          // Auch hier gilt: Eine nicht vorhandene UID ergibt keinen Fehler,
          // sondern schlicht keine Bewegung. Das darf nicht als Erfolg zaehlen.
          const bewegt = ergebnis?.uidMap instanceof Map
            ? ergebnis.uidMap.size
            : Object.keys(ergebnis?.uidMap || {}).length;
          if (bewegt) verschoben.push(mail);
          else fehler.push({ uid: mail.uid, grund: `nicht in "${von}" gefunden` });
        } catch (err) {
          fehler.push({ uid: mail.uid, grund: err.message });
        }
      }
    } finally {
      schloss.release();
    }
  } finally {
    try { await client.logout(); } catch { /* Verbindung war schon zu */ }
  }
  return { verschoben, fehler };
}

module.exports = {
  testVerbindung,
  ordnerAnlegen,
  ordnerErstellen,
  ordnerAnlegenPfad,
  ordnerDetails,
  mailVerschieben,
  mailsVerschieben,
  mailsSuchen,
  anhaengeHolen,
  STANDARD,
};
