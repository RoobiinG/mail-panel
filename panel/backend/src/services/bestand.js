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

// Wie viele Mails höchstens pro Konto und Lauf.
//
// Stand lange auf 100, weil die Klassifizierung eine Anfrage je Mail brauchte
// und auf zehn Anfragen je Minute gedrosselt war. Seit der Bündelung
// (services/klassifizierer.js) ist die KI nicht mehr der Engpass, sondern das
// Abholen der Mails über IMAP — dafür sind 250 noch verträglich. Der
// Budget-Deckel liegt weiterhin darüber und greift zuerst.
const FENSTER = 250;

function zahlOderNull(uid) {
  const n = Number(uid);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Diese Mail ist entschieden und bleibt im Posteingang — beim nächsten Lauf
// nicht noch einmal anbieten.
function erledigtMerken(kontoId, ordner, uid, grund = 'ruhe') {
  const n = zahlOderNull(uid);
  if (!kontoId || !ordner || n === null) return false;
  try {
    db.prepare(
      'INSERT OR IGNORE INTO bestand_erledigt (konto_id, ordner, uid, grund) VALUES (?, ?, ?, ?)',
    ).run(kontoId, ordner, n, String(grund));
    return true;
  } catch (err) {
    loggen('warn', 'backend:bestand', `Erledigt-Vermerk fehlgeschlagen: ${err.message}`);
    return false;
  }
}

// Alles, was das Panel für dieses Konto und diesen Ordner schon entschieden hat.
function erledigteUids(kontoId, ordner) {
  const raus = new Set();
  if (!kontoId || !ordner) return raus;
  try {
    for (const z of db.prepare('SELECT uid FROM bestand_erledigt WHERE konto_id = ? AND ordner = ?').all(kontoId, ordner)) {
      const n = zahlOderNull(z.uid);
      if (n !== null) raus.add(n);
    }
  } catch { /* Tabelle fehlt noch — dann eben nichts */ }
  if (ordner === 'INBOX') {
    try {
      for (const z of db.prepare('SELECT uid FROM sort_inbox WHERE konto_id = ?').all(kontoId)) {
        const n = zahlOderNull(z.uid);
        if (n !== null) raus.add(n);
      }
    } catch { /* egal */ }
  }
  return raus;
}

// Wenn eine "In Ruhe lassen"-Regel wieder verschwindet, sollen die Mails, die
// nur ihretwegen übersprungen wurden, erneut zur Sortierung anstehen.
function ruheVergessen(kontoId) {
  try {
    db.prepare("DELETE FROM bestand_erledigt WHERE konto_id = ? AND grund = 'ruhe'").run(kontoId);
  } catch { /* nicht kritisch */ }
}

const zeigerSchluessel = (kontoId, ordner) => `bestand_zeiger_${kontoId}_${Buffer.from(ordner).toString('base64')}`;

// Welchen Ordner der letzte Lauf für dieses Konto ausgesucht hat.
//
// Gebraucht wird das beim Vermerken: erledigtMerken() will den Ordner wissen, der
// Sammel-Knoten in n8n schickt aber nur konto, von, betreff und uid mit
// (workflowPatcher.js, budgetInSammeln). Statt den Workflow zu erweitern — was
// jeden bestehenden Lauf bis zum nächsten Sync ins Leere laufen ließe — merkt
// sich das Panel, was es selbst gerade ausgewählt hat. Es ist die einzige
// Stelle, die es ohnehin weiß.
const ordnerSchluessel = (kontoId) => `bestand_ordner_${kontoId}`;

function ordnerMerken(kontoId, ordner) {
  try { settings.setze(ordnerSchluessel(kontoId), String(ordner || 'INBOX')); } catch { /* nicht kritisch */ }
}

function letzterOrdner(kontoId) {
  try { return String(settings.hole(ordnerSchluessel(kontoId)) || '') || 'INBOX'; } catch { return 'INBOX'; }
}

// Welche UIDs die letzten beiden Läufe angeboten bekommen haben.
//
// Zwei, nicht eines: Erst der Vergleich sagt, ob eine Mail schon zweimal
// drangewesen und immer noch offen ist — dann lässt sie sich offenbar nicht
// einordnen und darf den Bestand nicht weiter blockieren.
const fensterSchluessel = (kontoId, ordner) => `bestand_fenster_${kontoId}_${Buffer.from(ordner).toString('base64')}`;
const vorFensterSchluessel = (kontoId, ordner) => `bestand_fenster_vor_${kontoId}_${Buffer.from(ordner).toString('base64')}`;

function fensterMerken(kontoId, ordner, uids) {
  try {
    settings.setze(vorFensterSchluessel(kontoId, ordner), settings.hole(fensterSchluessel(kontoId, ordner)) || '');
    settings.setze(fensterSchluessel(kontoId, ordner), (uids || []).join(','));
  } catch { /* ein fehlender Vermerk darf den Lauf nicht aufhalten */ }
}

function letztesFenster(kontoId, ordner, davor = false) {
  try {
    const schluessel = davor ? vorFensterSchluessel(kontoId, ordner) : fensterSchluessel(kontoId, ordner);
    return String(settings.hole(schluessel) || '')
      .split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; }
}


// Zurückgestellte Mails wieder freigeben. „Unklar" ist kein Urteil für immer:
// Ein Zielordner kann angelegt worden sein, das Budget wieder da. Aufgerufen
// wird das, wenn eine neue Runde durchs Postfach beginnt.
function unklarVergessen(kontoId) {
  try {
    db.prepare("DELETE FROM bestand_erledigt WHERE konto_id = ? AND grund = 'unklar'").run(kontoId);
  } catch { /* nicht kritisch */ }
}
// Wie viele Mails liessen sich nicht einordnen? Sie liegen weiter im
// Posteingang — nur bietet der Bestandslauf sie nicht mehr an. Das gehört
// sichtbar gemacht, sonst ist es dasselbe stille Verschwinden wie vorher.
function unklareAnzahl(kontoId = null) {
  try {
    return kontoId
      ? db.prepare("SELECT COUNT(*) n FROM bestand_erledigt WHERE grund = 'unklar' AND konto_id = ?").get(kontoId).n
      : db.prepare("SELECT COUNT(*) n FROM bestand_erledigt WHERE grund = 'unklar'").get().n;
  } catch { return 0; }
}

// Wie viele Mails ein Lauf bei lokaler KI je Konto holt.
//
// Stand bis Build 186 an der Bündelgröße: `max(4, floor(ollama_buendel * 6 / Konten))`.
// Mit dem Standardwert 2 und drei Konten ergab das die Untergrenze — vier Mails
// je Konto, zwölf je Lauf, alle vier Stunden. Bei 39.000 Mails im Bestand wären
// das anderthalb Jahre, wenn jede durchkäme; sie kam nicht, weil die Nachzügler
// aus dem letzten Lauf (weiter unten: vor den frischen) so ein Fenster allein
// füllen. Der Lauf war grün und bewegte nichts.
//
// Die Kopplung war ohnehin ein Denkfehler: Wie viele Mails die KI in einem Zug
// beantwortet, sagt nichts darüber, wie viele der Lauf ANSEHEN soll. Der weitaus
// größte Teil kostet nämlich gar keine KI — eigene Regeln und Stichwörter greifen
// vor dem Aufruf (services/klassifizierer.js), und Dubletten fasst der
// Klassifizierer zusammen. Was die KI in ihrer Frist nicht schafft, bleibt offen
// und kommt im nächsten Lauf zuerst wieder dran; das ist der Normalfall, kein
// Fehler.
// Ein fester Wert je Konto, keine Rechnung.
//
// In Build 187 stand hier `Math.max(FENSTER_LOKAL, Math.floor(FENSTER / Konten))`
// — gedacht als „mindestens 40", tatsächlich aber das Gegenteil: Bei drei Konten
// gewinnt der zweite Term mit 83, macht 249 Mails je Lauf. Der erste Lauf danach
// brach nach 23 Sekunden ab, bevor die KI auch nur einmal gefragt wurde. 249
// Items mit vollem Mailtext durch zweiunddreißig n8n-Knoten sind zu viel, und
// der Engpass ist dabei nicht das Panel, sondern was n8n zwischen den Knoten
// durchreicht.
//
// Also fest und vorhersagbar. Wer mehr will, stellt es ein — wer weniger
// braucht, weil n8n knapp bei Speicher ist, ebenso.
const FENSTER_LOKAL = 40;

function fensterGroesse(anzahlKonten) {
  const anbieter = settings.hole('ki_anbieter');
  if (anbieter === 'ollama') {
    const eigenes = Number(settings.hole('bestand_fenster'));
    if (Number.isFinite(eigenes) && eigenes > 0) {
      return Math.min(FENSTER, Math.round(eigenes));
    }
    return FENSTER_LOKAL;
  }

  const grenze = budget.tagesbudget();
  if (grenze === 0) {
    return Math.floor(FENSTER / Math.max(1, anzahlKonten)); // kein Deckel gesetzt, z.B. Gemini Free
  }
  
  // Grenze und Verbrauch stehen in ANFRAGEN, das Fenster in Mails. Eine Anfrage
  // trägt seit der Bündelung mehrere Mails — ohne die Umrechnung bliebe das
  // Fenster bei einem Bruchteil dessen, was der Tag noch hergibt.
  const restAnfragen = Math.max(0, grenze - budget.heuteVerbraucht());
  if (restAnfragen === 0) return 0;
  const restMails = restAnfragen * budget.mailsJeAnfrage();
  return Math.max(1, Math.min(FENSTER, Math.ceil(restMails / Math.max(1, anzahlKonten))));
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
      const zugang = themen.zugang(konto);
      const ordnerDetails = await imap.ordnerDetails(zugang);
      const scanOrdner = ordnerDetails.filter(o => o.auswaehlbar && !['trash', 'sent', 'drafts', 'junk'].includes(o.spezial));
      
      // Posteingang (INBOX) nach vorn ziehen, damit er als erstes gescannt wird
      scanOrdner.sort((a, b) => {
        if (a.spezial === 'inbox') return -1;
        if (b.spezial === 'inbox') return 1;
        return 0;
      });

      let offen = [];
      let da = [];
      let aktuellerOrdner = 'INBOX';
      let erledigt = new Set();

      for (const o of scanOrdner) {
        da = await imap.uidsAuflisten({ ...zugang, ordner: o.pfad });
        erledigt = erledigteUids(konto.id, o.pfad);
        offen = [...da].filter((u) => !erledigt.has(u)).sort((a, b) => a - b);
        if (offen.length > 0) {
          aktuellerOrdner = o.pfad;
          break;
        }
      }

      raus.offen[konto.name] = offen.length;
      if (offen.length === 0) continue;

      const zeiger = Number(settings.hole(zeigerSchluessel(konto.id, aktuellerOrdner))) || 0;
      const offenSet = new Set(offen);
      const vorherige = letztesFenster(konto.id, aktuellerOrdner);
      const davor = letztesFenster(konto.id, aktuellerOrdner, true);

      // Was im letzten Lauf liegen geblieben ist (z.B. wegen KI-Timeout),
      // wird im nächsten Lauf als erstes wieder angeboten.
      const haengen = vorherige.filter((u) => offenSet.has(u));

      const nachzuegler = haengen.filter((u) => offenSet.has(u));
      const frisch = offen.filter((u) => u > zeiger && !vorherige.includes(u));
      let fenster = [...nachzuegler, ...frisch].slice(0, proKonto);
      // Nichts mehr über dem Zeiger: neue Runde. Dann bekommen auch die
      // geparkten Mails wieder eine Chance — „unklar" heisst zurückgestellt,
      // nicht aufgegeben.
      if (fenster.length === 0) {
        unklarVergessen(konto.id);
        const neueRunde = erledigteUids(konto.id, aktuellerOrdner);
        fenster = [...da].filter((u) => !neueRunde.has(u)).sort((a, b) => a - b).slice(0, proKonto);
      }
      if (fenster.length === 0) continue;

      raus.konten[konto.name] = { ordner: aktuellerOrdner, uids: fenster.join(',') };
      settings.setze(zeigerSchluessel(konto.id, aktuellerOrdner), String(Math.max(...fenster)));
      fensterMerken(konto.id, aktuellerOrdner, fenster);
      ordnerMerken(konto.id, aktuellerOrdner);
    } catch (err) {
      // Ein nicht erreichbares Postfach darf den Lauf der anderen nicht kippen.
      loggen('warn', 'backend:bestand', `Bestand von ${konto.name} nicht lesbar: ${err.message}`);
    }
  }
  return raus;
}

module.exports = {
  kandidaten, erledigtMerken, erledigteUids, ruheVergessen, unklarVergessen, unklareAnzahl,
  letzterOrdner, ordnerMerken,
  KEINE, FENSTER, FENSTER_LOKAL,
};
