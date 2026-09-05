// Welche Bestands-Mails sind noch nicht durch die Triage gelaufen?
//
// Warum es diese Datei gibt: Der IMAP-Knoten in Workflow 04 holt die ersten 100
// Mails des Posteingangs — und zwar bei jedem Lauf dieselben. Der Node schneidet
// serverseitig ab (`uids.slice(0, limit)`), die Suche liefert aufsteigend nach
// UID. Alles, was liegen bleibt, steht beim nächsten Lauf also wieder ganz vorn.
// Und liegen bleibt eine Menge: Die KI lässt Unklares bewusst im Posteingang.
//
// Ergebnis war ein Stillstand, der wie ein Erfolg aussah: Der Lauf lief grün
// durch, sortierte aber nichts mehr, während zehntausende Mails dahinter
// warteten. Deshalb sagt jetzt das Panel, welche UIDs drankommen — es weiß als
// Einziges, was schon entschieden ist.
//
// Drei Quellen fließen in "schon entschieden" ein:
//   * sort_inbox — die Mail liegt zur Zuordnung vor (bleibt im Posteingang),
//   * bestand_erledigt — bewusst in Ruhe gelassen (eigene Regel),
//   * der Zeiger je Konto — damit ein Lauf, der irgendwo hängen bleibt, das
//     Fenster nicht dauerhaft blockiert.
// Verschobene Mails brauchen keinen Eintrag: Sie sind nicht mehr im Posteingang.
// Genau deshalb wird eine Mail mit Zielordner auch NICHT vermerkt — scheitert
// das Verschieben (fehlender Ordner), kommt sie beim nächsten Lauf wieder dran.
const db = require('../db');
const imap = require('./imap');
const themen = require('./themen');
const settings = require('./settings');
const budget = require('./budget');
const { loggen } = require('./panelLog');

// Eine UID, die es nicht gibt. Der IMAP-Knoten braucht immer einen Wert: Ein
// leeres Suchfeld wäre eine ungültige IMAP-Suche, und "kein Filter" hieße
// "wieder alles von vorn" — also lieber ausdrücklich nichts.
const KEINE = '4294967295';

// Wie viele Mails höchstens pro Konto und Lauf. Mehr bringt nichts: Die
// Klassifizierung ist auf 10 Anfragen je Minute gedrosselt.
const FENSTER = 100;

function zahlOderNull(uid) {
  const n = Number(uid);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Diese Mail ist entschieden und bleibt im Posteingang — beim nächsten Lauf
// nicht noch einmal anbieten.
function erledigtMerken(kontoId, uid, grund = 'ruhe') {
  const n = zahlOderNull(uid);
  if (!kontoId || n === null) return false;
  try {
    db.prepare(
      'INSERT OR IGNORE INTO bestand_erledigt (konto_id, uid, grund) VALUES (?, ?, ?)',
    ).run(kontoId, n, String(grund));
    return true;
  } catch (err) {
    loggen('warn', 'backend:bestand', `Erledigt-Vermerk fehlgeschlagen: ${err.message}`);
    return false;
  }
}

// Alles, was das Panel für dieses Konto schon entschieden hat.
function erledigteUids(kontoId) {
  const raus = new Set();
  if (!kontoId) return raus;
  try {
    for (const z of db.prepare('SELECT uid FROM bestand_erledigt WHERE konto_id = ?').all(kontoId)) {
      const n = zahlOderNull(z.uid);
      if (n !== null) raus.add(n);
    }
  } catch { /* Tabelle fehlt noch — dann eben nichts */ }
  try {
    for (const z of db.prepare('SELECT uid FROM sort_inbox WHERE konto_id = ?').all(kontoId)) {
      const n = zahlOderNull(z.uid);
      if (n !== null) raus.add(n);
    }
  } catch { /* egal */ }
  return raus;
}

// Wenn eine "In Ruhe lassen"-Regel wieder verschwindet, sollen die Mails, die
// nur ihretwegen übersprungen wurden, erneut zur Sortierung anstehen.
function ruheVergessen(kontoId) {
  try {
    db.prepare("DELETE FROM bestand_erledigt WHERE konto_id = ? AND grund = 'ruhe'").run(kontoId);
  } catch { /* nicht kritisch */ }
}

const zeigerSchluessel = (kontoId) => `bestand_zeiger_${kontoId}`;

// Wie viele Mails darf dieser Lauf überhaupt anfassen? Mehr anzubieten, als das
// Tagesbudget hergibt, wäre schädlich: Der Zeiger würde über Mails hinweglaufen,
// die gar nicht drankamen — die wären dann eine ganze Runde lang weg.
function fensterGroesse(anzahlKonten) {
  const grenze = budget.tagesbudget();
  if (grenze === 0) return FENSTER; // kein Deckel gesetzt
  const rest = Math.max(0, grenze - budget.heuteVerbraucht());
  if (rest === 0) return 0;
  return Math.max(1, Math.min(FENSTER, Math.ceil(rest / Math.max(1, anzahlKonten))));
}

// Die Antwort für den Auswahl-Knoten in Workflow 04: je Konto die UIDs, die
// dieser Lauf holen soll — als Liste, wie sie die IMAP-Suche erwartet.
async function kandidaten(grenze = 0) {
  const konten = db.prepare('SELECT * FROM accounts').all();
  const proKonto = grenze > 0 ? Math.min(FENSTER, grenze) : fensterGroesse(konten.length);
  const raus = { konten: {}, offen: {}, fenster: proKonto };

  for (const konto of konten) {
    raus.konten[konto.name] = KEINE;
    raus.offen[konto.name] = null;
    if (proKonto === 0) continue;
    try {
      const da = await imap.uidsAuflisten({ ...themen.zugang(konto), ordner: 'INBOX' });
      const erledigt = erledigteUids(konto.id);
      const offen = [...da].filter((u) => !erledigt.has(u)).sort((a, b) => a - b);
      raus.offen[konto.name] = offen.length;
      if (offen.length === 0) continue;

      // Ab dem Zeiger weiter, sonst von vorn. Der Zeiger ist die Versicherung
      // gegen Mails, die sich nicht entscheiden lassen (kein Absender, Ordner
      // fehlt): Sie blockieren höchstens ein Fenster, nicht den ganzen Bestand.
      const zeiger = Number(settings.hole(zeigerSchluessel(konto.id))) || 0;
      let fenster = offen.filter((u) => u > zeiger).slice(0, proKonto);
      if (fenster.length === 0) fenster = offen.slice(0, proKonto);

      raus.konten[konto.name] = fenster.join(',');
      settings.setze(zeigerSchluessel(konto.id), String(fenster[fenster.length - 1]));
    } catch (err) {
      // Ein nicht erreichbares Postfach darf den Lauf der anderen nicht kippen.
      loggen('warn', 'backend:bestand', `Bestand von ${konto.name} nicht lesbar: ${err.message}`);
    }
  }
  return raus;
}

module.exports = { kandidaten, erledigtMerken, erledigteUids, ruheVergessen, KEINE, FENSTER };
