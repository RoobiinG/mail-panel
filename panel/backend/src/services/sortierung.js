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
        // aktion 'behalten': die Mail wird bewusst NICHT angefasst. Der Aufrufer
        // muss das auswerten — ein leerer Zielordner darf nie als Verschiebe-
        // Auftrag durchgehen.
        return { ordner: regel.zielordner, regel_id: regel.id, aktion: regel.aktion || 'verschieben' };
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
// Eine UID ist nur als ganze Zahl vergleichbar. Aeltere Zeilen tragen sie als
// "28.0", neuere als "28" — als Text sind das zwei verschiedene Dinge, und
// genau daran ist die Dubletten-Erkennung bisher vorbeigelaufen.
function uidZahl(roh) {
  const n = Number(roh);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Die Sortier-Inbox mit dem Postfach abgleichen.
//
// Eine Zeile darin ist nur so lange gueltig, wie die Mail auch noch im
// Posteingang liegt. Wird sie vorher woanders einsortiert — von Hand, von der
// KI oder von einem frueheren Stapel —, dann zeigt die gespeicherte UID ins
// Leere, denn UIDs gelten je Ordner. Solche Zeilen scheiterten bisher bei
// jedem Verschieben aufs Neue und blieben trotzdem stehen: Sie blaehten die
// Liste auf, verfaelschten die Zaehler und erzeugten die "X Fehler".
//
// Gibt zurueck, wie viele Zeilen geschlossen wurden.
async function abgleichen(konto, opt = {}) {
  const themen = require('./themen');
  const imap = require('./imap');
  const offen = db.prepare(
    "SELECT id, uid FROM sort_inbox WHERE konto_id = ? AND status = 'offen'",
  ).all(konto.id);
  if (offen.length === 0) return 0;

  const daSet = opt.vorhanden || await imap.uidsAuflisten({ ...themen.zugang(konto), ordner: 'INBOX' });

  const schliessen = db.prepare(
    "UPDATE sort_inbox SET status = 'ignoriert', vorschlag = ? WHERE id = ?",
  );
  let geschlossen = 0;
  const gesehen = new Set();
  for (const zeile of offen) {
    const nummer = uidZahl(zeile.uid);
    // Ohne UID oder nicht mehr im Posteingang: Die Zeile ist nicht mehr
    // verwertbar. Eine zweite Zeile zur selben UID ist eine Dublette.
    if (nummer === null || !daSet.has(nummer)) {
      schliessen.run('(nicht mehr im Posteingang)', zeile.id);
      geschlossen++;
    } else if (gesehen.has(nummer)) {
      schliessen.run('(Dublette)', zeile.id);
      geschlossen++;
    } else {
      gesehen.add(nummer);
    }
  }
  if (geschlossen > 0) {
    loggen('info', 'sortierung',
      `${konto.name}: ${geschlossen} Sortier-Inbox-Eintrag/Eintraege geschlossen — die Mails liegen nicht mehr im Posteingang.`);
  }
  return geschlossen;
}

async function bestandAnwenden(konto, regel, opt = {}) {
  const alle = db.prepare(
    "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen'",
  ).all(konto.id).filter((m) => passt(regel, m.von, m.betreff));

  // Die Vorschau zaehlt, was der Nutzer erwartet: Mails, nicht Zeilen. Ohne die
  // Entdopplung verspricht sie mehr, als der Stapel dann bewegt.
  if (opt.nurZaehlen) {
    const uids = new Set(alle.map((m) => uidZahl(m.uid)).filter((n) => n !== null));
    return { treffer: uids.size, verschoben: 0, fehler: [] };
  }
  if (alle.length === 0) return { treffer: 0, verschoben: 0, fehler: [] };

  // Verzoegert laden: themen zieht selbst sortierung herein
  const themen = require('./themen');
  const imap = require('./imap');
  const zugang = themen.zugang(konto);

  // Dubletten und Zeilen ohne UID gleich hier abraeumen — sie kosten sonst je
  // einen sinnlosen IMAP-Versuch. Bewusst ohne zweite Verbindung: Der Abgleich
  // mit dem Postfach faellt beim Verschieben von selbst ab (siehe unten), und
  // eine zusaetzliche Verbindung liefe waehrend eines Workflow-Laufs leicht in
  // das Verbindungslimit des Mailservers.
  const schliessen = db.prepare(
    "UPDATE sort_inbox SET status = 'ignoriert', vorschlag = ? WHERE id = ?",
  );
  let veraltet = 0;
  const gesehen = new Set();
  const passende = [];
  for (const mail of alle) {
    const nummer = uidZahl(mail.uid);
    if (nummer === null) { schliessen.run('(ohne UID nicht auffindbar)', mail.id); veraltet++; }
    else if (gesehen.has(nummer)) { schliessen.run('(Dublette)', mail.id); veraltet++; }
    else { gesehen.add(nummer); passende.push(mail); }
  }
  if (passende.length === 0) return { treffer: 0, verschoben: 0, fehler: [], veraltet };

  // Alles ueber eine einzige Verbindung — sonst laeuft ein groesserer Stapel in
  // das Verbindungslimit des Mailservers.
  const { verschoben: erledigt, fehler: probleme } = await imap.mailsVerschieben({
    ...zugang, mails: passende, von: 'INBOX', nach: regel.zielordner,
  });

  const abhaken = db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?");
  for (const mail of erledigt) abhaken.run(regel.zielordner, mail.id);

  // Eine Mail, die nicht mehr im Posteingang liegt, ist kein Fehler, den der
  // Nutzer beheben koennte — sie wurde vorher schon einsortiert. Frueher blieb
  // so eine Zeile 'offen' stehen und scheiterte bei jedem Versuch aufs Neue.
  const fehler = [];
  for (const p of probleme) {
    const zeile = passende.find((m) => String(m.uid) === String(p.uid));
    if (/nicht in/.test(p.grund) && zeile) {
      schliessen.run('(nicht mehr im Posteingang)', zeile.id);
      veraltet++;
    } else {
      fehler.push(`${zeile ? zeile.von : `UID ${p.uid}`}: ${p.grund}`);
    }
  }

  const verschoben = erledigt.length;
  if (verschoben > 0 || fehler.length > 0 || veraltet > 0) {
    loggen('info', 'sortierung',
      `Regel [${regel.typ}] ${regel.muster} → ${regel.zielordner}: ${verschoben} von ${passende.length} Mail(s) nachsortiert`
      + (veraltet ? `, ${veraltet} veraltete Eintraege geschlossen` : '')
      + (fehler.length ? `, ${fehler.length} Fehler` : ''));
  }
  return { treffer: passende.length, verschoben, fehler, veraltet };
}


/**
 * Soll diese Mail bewusst unangetastet bleiben ("in Ruhe lassen")?
 *
 * Wie pruefeRegeln, aber OHNE den Trefferzaehler hochzusetzen: Beim Einsortieren
 * wurde die Regel in /sort bereits gezaehlt — ein zweites Mal waere geschummelt.
 * Es zaehlt die ERSTE passende Regel, genau wie bei pruefeRegeln.
 */
// Die erste passende Regel — ohne den Treffer-Zähler hochzusetzen. Gebraucht an
// allen Stellen, die nur wissen wollen, ob eine Regel greift: Der Zähler soll
// zählen, wie oft eine Regel wirklich sortiert hat, nicht wie oft jemand
// nachgeschaut hat.
function regelTreffer(kontoId, von, betreff) {
  if (!kontoId) return null;
  try {
    for (const regel of db.prepare('SELECT * FROM sort_rules WHERE konto_id = ?').all(kontoId)) {
      if (passt(regel, von, betreff)) return regel;
    }
  } catch (err) {
    loggen('warn', 'backend:sortierung', `regelTreffer fehlgeschlagen: ${err.message}`);
  }
  return null;
}

function istBehalten(kontoId, von, betreff) {
  const regel = regelTreffer(kontoId, von, betreff);
  return Boolean(regel) && (regel.aktion || 'verschieben') === 'behalten';
}
module.exports = {
  pruefeRegeln,
  regelTreffer,
  istBehalten,
  bestandAnwenden,
  abgleichen,
  uidZahl,
  passt,
  adresse,
  domain,
};
