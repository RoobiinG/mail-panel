// Sortier-Logik: gleicht eingehende Mails mit den Konto-spezifischen Regeln ab.
const db = require('../db');
const { loggen } = require('./panelLog');

/**
 * Die reine Adresse aus einem "Von"-Feld: "Name <a@b.de>" -> "a@b.de"
 *
 * Genommen wird die LETZTE spitze Klammer, nicht die erste: Der Anzeigename ist
 * frei waehlbar, und ein Absender wie
 *   "Rechnung <buchhaltung@echte-firma.de>" <angreifer@woanders.tld>
 * wuerde sonst als buchhaltung@echte-firma.de durchgehen und fremde Regeln
 * ausloesen. Die tatsaechliche Adresse steht immer am Ende.
 */
function adresse(von) {
  const roh = String(von || '').toLowerCase().trim();
  const treffer = roh.match(/<([^<>]*)>\s*$/) || [...roh.matchAll(/<([^<>]+)>/g)].pop();
  return (treffer ? treffer[1] : roh).trim();
}

/** Die Domain einer Adresse: "a@news.amazon.de" -> "news.amazon.de" */
function domain(von) {
  return (adresse(von).split('@')[1] || '').trim();
}

/**
 * Passt eine einzelne Regel auf diese Mail?
 *
 * Der Domain-Vergleich lief bis v2.8.0.0 ueber ein blankes endsWith. Damit traf
 * eine Regel fuer "google.com" auch auf "boesegoogle.com" zu — wer eine solche
 * Domain registriert, haette sich in den Zielordner einschleusen koennen.
 * Jetzt wird auf Punktgrenzen geprueft: "google.com" trifft google.com selbst
 * und jede Unterdomain, aber nichts, was blos so endet.
 */
function passt(regel, von, betreff) {
  const muster = String(regel.muster || '').toLowerCase().trim();
  if (!muster) return false;
  const email = adresse(von);

  switch (regel.typ) {
    case 'absender': {
      if (email === muster) return true;
      // Verglichen wird immer gegen die ausgelesene Adresse, nie gegen das ganze
      // Von-Feld: Sonst reicht der Anzeigename, um eine Regel vorzutaeuschen.
      // "rechnung@" meint den lokalen Teil, "rechnung" ein Bruchstueck.
      // Eine vollstaendige Adresse muss dagegen exakt passen.
      if (muster.endsWith('@')) return email.startsWith(muster);
      if (!muster.includes('@')) return email.includes(muster);
      return false;
    }
    case 'domain': {
      const d = muster.replace(/^@/, '');
      return email.endsWith(`@${d}`) || email.endsWith(`.${d}`);
    }
    case 'betreff':
      return String(betreff || '').toLowerCase().includes(muster);
    default:
      return false;
  }
}

/**
 * Prueft, ob eine Mail auf eine der Sortier-Regeln des Kontos passt.
 * @param {number} kontoId 
 * @param {string} von 
 * @param {string} betreff 
 * @returns {object|null} { ordner: 'Ziel', regel_id: 123 } oder null
 */
function pruefeRegeln(kontoId, von, betreff) {
  if (!kontoId) return null;

  try {
    const regeln = db.prepare('SELECT * FROM sort_rules WHERE konto_id = ?').all(kontoId);
    
    for (const regel of regeln) {
      if (!passt(regel, von, betreff)) continue;
      {
        // Zaehler hochsetzen
        db.prepare('UPDATE sort_rules SET treffer = treffer + 1 WHERE id = ?').run(regel.id);
        return { ordner: regel.zielordner, regel_id: regel.id };
      }
    }

    return null; // Kein Match
  } catch (err) {
    loggen('error', 'backend:sortierung', `Fehler bei pruefeRegeln: ${err.message}`);
    return null;
  }
}

// ─── Bestand nachsortieren ───────────────────────────────────────────────────

/**
 * Wendet eine Regel auf die Mails an, die schon in der Sortier-Inbox liegen.
 *
 * Das ist der Sinn der Sache: Wer eine Mail von @google.com einsortiert, will
 * die anderen neunzehn nicht auch noch einzeln anfassen. Verschoben wird direkt
 * per IMAP durch das Panel — der n8n-Lauf, der die Mail urspruenglich gemeldet
 * hat, ist laengst vorbei.
 *
 * Es wird nichts geloescht: Die Zeilen bekommen den Status "zugeordnet" und
 * bleiben zum Nachsehen stehen.
 *
 * @param {object} konto  Zeile aus accounts (mit password_enc)
 * @param {object} regel  { typ, muster, zielordner }
 * @param {object} [opt]  { nurZaehlen: true } liefert nur die Trefferzahl
 * @returns {Promise<{treffer: number, verschoben: number, fehler: string[]}>}
 */
async function bestandAnwenden(konto, regel, opt = {}) {
  const offen = db.prepare(
    "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen'",
  ).all(konto.id);
  const passende = offen.filter((m) => passt(regel, m.von, m.betreff));

  if (opt.nurZaehlen) return { treffer: passende.length, verschoben: 0, fehler: [] };
  if (passende.length === 0) return { treffer: 0, verschoben: 0, fehler: [] };

  // Verzoegert laden: themen zieht selbst sortierung herein
  const themen = require('./themen');
  const imap = require('./imap');
  const zugang = themen.zugang(konto);

  // Alles ueber eine einzige Verbindung — sonst laeuft ein groesserer Stapel in
  // das Verbindungslimit des Mailservers.
  const mitUid = passende.filter((m) => m.uid);
  const { verschoben: erledigt, fehler: probleme } = await imap.mailsVerschieben({
    ...zugang, mails: mitUid, von: 'INBOX', nach: regel.zielordner,
  });

  const abhaken = db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?");
  for (const mail of erledigt) abhaken.run(regel.zielordner, mail.id);
  // Zeilen ohne UID lassen sich im Postfach nicht wiederfinden. Sie werden
  // trotzdem abgehakt, sonst bleiben sie fuer immer in der Liste stehen.
  for (const mail of passende.filter((m) => !m.uid)) abhaken.run(regel.zielordner, mail.id);

  const verschoben = erledigt.length;
  const fehler = probleme.map((p) => `UID ${p.uid}: ${p.grund}`);

  if (verschoben > 0 || fehler.length > 0) {
    loggen('info', 'sortierung',
      `Regel [${regel.typ}] ${regel.muster} → ${regel.zielordner}: ${verschoben} von ${passende.length} Mail(s) nachsortiert`
      + (fehler.length ? `, ${fehler.length} Fehler` : ''));
  }
  return { treffer: passende.length, verschoben, fehler };
}

module.exports = {
  pruefeRegeln,
  bestandAnwenden,
  passt,
  adresse,
  domain,
};
