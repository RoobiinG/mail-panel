// Nachsortierung: nachts durch das ganze Postfach und geraderücken, was
// inzwischen anders geregelt ist.
//
// Eine Sortier-Regel wirkte bisher nur nach vorn. Wer eine falsch gelernte Regel
// korrigierte, reparierte damit nichts von dem, was schon im falschen Ordner
// lag — und bei einem Postfach, das über Wochen von einem kleinen Sprachmodell
// einsortiert wurde, ist genau das der größere Posten.
//
// Hier arbeitet KEINE KI. Verschoben wird ausschließlich, wofür eine Regel des
// Nutzers ein anderes Ziel nennt als den Ordner, in dem die Mail liegt. Das ist
// die ganze Idee: Die Regeln sind seine Entscheidung, sie sollen auch rückwärts
// gelten.
//
// Drei Dinge, die diesen Dienst von den anderen unterscheiden und die seinen
// Zuschnitt erklären:
//
//   * Er läuft unbeaufsichtigt und kann tausende Mails bewegen. Deshalb ist er
//     standardmäßig aus, beginnt als Trockenlauf und hat eine harte Obergrenze
//     je Lauf.
//   * Er fasst Ordner an, die sonst niemand anfasst. Papierkorb, Entwürfe und
//     Gesendet sind deshalb gesperrt — etwas aus dem Papierkorb zu holen hieße,
//     Gelöschtes wiederzubeleben.
//   * Er kennt keine UIDs aus der Vergangenheit. Er sieht nach, was JETZT in den
//     Ordnern liegt. Damit braucht er keinen Protokolleintrag und erwischt auch
//     die Mails, die vor dem Panel dort einsortiert wurden.
const db = require('../db');
const settings = require('./settings');
const imap = require('./imap');
const themen = require('./themen');
const sortierung = require('./sortierung');
const { loggen } = require('./panelLog');

// Ordnerrollen, die nie angefasst werden.
//
// `all` ist Gmails „Alle Nachrichten" — ein virtueller Ordner, der jede Mail ein
// zweites Mal zeigt. Dort zu verschieben hieße, dieselbe Mail doppelt zu
// bewegen. `archive` bleibt bewusst ERLAUBT: Das ist ein gewöhnliches Ablagefach
// und oft genau der Ort, an dem falsch Einsortiertes liegt.
const GESPERRTE_ROLLEN = new Set(['trash', 'drafts', 'sent', 'all', 'junk']);

// Wie viele Briefköpfe je Ordner höchstens gelesen werden.
const BRIEFKOEPFE_JE_ORDNER = 20000;
// Wie viele Beispiele das Ergebnis mitführt. Mehr liest ohnehin niemand, und der
// Eintrag steht in der Einstellungstabelle.
const BEISPIELE_MAX = 50;

function zahl(schluessel, standard, min, max) {
  const roh = Number(settings.hole(schluessel));
  if (!Number.isFinite(roh)) return standard;
  return Math.min(max, Math.max(min, Math.round(roh)));
}

function einstellungen() {
  return {
    aktiv: settings.hole('nachsortierung_aktiv') === '1',
    trockenlauf: settings.hole('nachsortierung_trockenlauf') !== '0',
    taktStunden: zahl('nachsortierung_takt', 24, 1, 720),
    max: zahl('nachsortierung_max', 500, 1, 20000),
  };
}

function letzterLauf() {
  try {
    const roh = settings.hole('nachsortierung_letzter_lauf');
    return roh ? JSON.parse(roh) : null;
  } catch {
    return null;
  }
}

// Im Arbeitsspeicher, nicht in der Datenbank: Nach einem Neustart läuft
// garantiert nichts mehr, und eine hängengebliebene Sperre in der Datenbank
// blockierte die Nachsortierung für immer. (Dieselbe Überlegung wie bei der
// Postfach-Sicherung.)
let laufendSeit = null;
const laeuftGerade = () => laufendSeit !== null;

/** Ist ein Lauf fällig? */
function faellig() {
  const e = einstellungen();
  if (!e.aktiv) return false;
  const letzter = letzterLauf();
  if (!letzter?.zeitpunkt) return true;
  const her = Date.now() - Date.parse(letzter.zeitpunkt);
  return !Number.isFinite(her) || her >= e.taktStunden * 3600 * 1000;
}

/**
 * Welche Ordner dieses Kontos werden durchgesehen?
 *
 * Alles, was auswählbar ist — außer den gesperrten Rollen und dem Spam-Ordner
 * des Kontos. Spam bleibt draußen, weil eine Regel eine als Spam erkannte Mail
 * sonst wieder in den Posteingangsbereich zöge; wer das will, holt sie von Hand.
 */
function ordnerAuswahl(konto, details) {
  const spam = String(konto.folder_spam || imap.STANDARD.folder_spam || '').toLowerCase();
  return details
    .filter((o) => o.auswaehlbar !== false)
    .filter((o) => !GESPERRTE_ROLLEN.has(String(o.spezial || '')))
    .filter((o) => {
      const pfad = String(o.pfad || '').toLowerCase();
      if (!spam) return true;
      // Auch "INBOX.Junk" trifft den Spam-Ordner "Junk".
      return pfad !== spam && pfad.split(/[/.]/).pop() !== spam;
    })
    .map((o) => o.pfad)
    .filter(Boolean);
}

/** Zwei Ordnerpfade, die dasselbe Fach meinen? "INBOX.Rechnungen" = "Rechnungen". */
function selberOrdner(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.split(/[/.]/).pop() === y.split(/[/.]/).pop();
}

/**
 * Ein Konto durchsehen.
 * @returns {Promise<{geprueft:number, treffer:number, verschoben:number,
 *                    fehler:string[], beispiele:object[]}>}
 */
async function kontoDurchgehen(konto, { trockenlauf, rest }) {
  const ergebnis = { geprueft: 0, treffer: 0, verschoben: 0, fehler: [], beispiele: [] };
  const regeln = sortierung.regelnGeordnet(konto.id);
  if (regeln.length === 0) return ergebnis;

  const zugang = themen.zugang(konto);
  const details = await imap.ordnerDetails({ ...konto, ...zugang });
  const ordner = ordnerAuswahl(konto, details);

  for (const quelle of ordner) {
    if (rest.uebrig <= 0) break;

    let mails = [];
    try {
      mails = await imap.briefkoepfe({ ...zugang, ordner: quelle, grenze: BRIEFKOEPFE_JE_ORDNER });
    } catch (err) {
      ergebnis.fehler.push(`${konto.name}/${quelle}: ${err.message}`);
      continue;
    }
    ergebnis.geprueft += mails.length;

    // Je Zielordner sammeln — verschoben wird gebündelt, nicht Mail für Mail.
    const nachZiel = new Map();
    for (const m of mails) {
      if (rest.uebrig <= 0) break;
      const regel = regeln.find((r) => sortierung.passt(r, m.von, m.betreff));
      if (!regel) continue;
      // „In Ruhe lassen" heißt ausdrücklich: nicht anfassen. Diese Regel ist
      // die einzige, die ein Nichthandeln anordnet — sie hier zu übergehen
      // wäre das Gegenteil dessen, was der Nutzer gesagt hat.
      if ((regel.aktion || 'verschieben') === 'behalten') continue;
      const ziel = String(regel.zielordner || '').trim();
      if (!ziel || selberOrdner(quelle, ziel)) continue;

      if (!nachZiel.has(ziel)) nachZiel.set(ziel, []);
      nachZiel.get(ziel).push({ ...m, regel });
      ergebnis.treffer += 1;
      rest.uebrig -= 1;
      if (ergebnis.beispiele.length < BEISPIELE_MAX) {
        ergebnis.beispiele.push({
          konto: konto.name,
          // Beides gehört dazu, sonst ist die Liste nur zum Lesen da: Mit der
          // UID lässt sich diese eine Mail umlenken, mit der Regel-Kennung die
          // Ursache — also alle künftigen Mails dieses Absenders gleich mit.
          kontoId: konto.id,
          uid: m.uid,
          regelId: regel.id,
          von: m.von,
          betreff: String(m.betreff || '').slice(0, 120),
          vonOrdner: quelle,
          nachOrdner: ziel,
          regel: `${regel.typ}: ${regel.muster}${regel.betreff_muster ? ` + Betreff „${regel.betreff_muster}"` : ''}`,
        });
      }
    }

    if (trockenlauf) continue;

    for (const [ziel, liste] of nachZiel) {
      try {
        // Die Schreibweise des Servers holen, sonst scheitert der Move an
        // "INBOX.Rechnungen" vs. "Rechnungen".
        const pfad = (await themen.ordnerPfad(konto, ziel)) || ziel;
        if (selberOrdner(quelle, pfad)) continue;
        const r = await imap.mailsVerschieben({
          ...zugang, mails: liste, von: quelle, nach: pfad,
        });
        ergebnis.verschoben += r.verschoben.length;
        for (const f of r.fehler.slice(0, 5)) {
          ergebnis.fehler.push(`${konto.name}/${quelle} UID ${f.uid}: ${f.grund}`);
        }
        // Was die KI einmal in diesen Ordner gelernt hat, zieht die nächste Mail
        // sonst wieder dorthin — ohne KI und ohne dass es auffiele. Dieselbe
        // Aufräumarbeit macht die Korrektur von Hand (routes/sortierung.js).
        for (const m of liste) {
          try { themen.gelerntVergessen(konto.id, quelle, m.von); } catch { /* nicht so wichtig */ }
        }
      } catch (err) {
        ergebnis.fehler.push(`${konto.name}/${quelle} → ${ziel}: ${err.message}`);
      }
    }
    themen.cacheVerwerfen(konto.id);
  }

  return ergebnis;
}

/**
 * Ein Lauf über alle aktiven Konten.
 * @param {object} [opt]
 * @param {boolean} [opt.trockenlauf] Überschreibt die Einstellung.
 */
async function lauf(opt = {}) {
  if (laufendSeit) {
    const her = Math.round((Date.now() - laufendSeit) / 1000);
    throw new Error(`Es läuft bereits eine Nachsortierung (seit ${her} s).`);
  }
  const e = einstellungen();
  const trockenlauf = opt.trockenlauf === undefined ? e.trockenlauf : Boolean(opt.trockenlauf);
  laufendSeit = Date.now();

  const gesamt = {
    zeitpunkt: new Date().toISOString(),
    trockenlauf,
    geprueft: 0,
    treffer: 0,
    verschoben: 0,
    fehler: [],
    beispiele: [],
    sekunden: 0,
  };
  // Die Obergrenze gilt für den ganzen Lauf, nicht je Konto — sonst wären es
  // bei drei Konten unversehens dreimal so viele.
  const rest = { uebrig: e.max };

  try {
    const konten = db.prepare('SELECT * FROM accounts WHERE aktiv = 1').all();
    for (const konto of konten) {
      try {
        const r = await kontoDurchgehen(konto, { trockenlauf, rest });
        gesamt.geprueft += r.geprueft;
        gesamt.treffer += r.treffer;
        gesamt.verschoben += r.verschoben;
        gesamt.fehler.push(...r.fehler);
        for (const b of r.beispiele) {
          if (gesamt.beispiele.length < BEISPIELE_MAX) gesamt.beispiele.push(b);
        }
      } catch (err) {
        // Ein nicht erreichbares Postfach darf den Lauf der anderen nicht kippen
        // — dieselbe Haltung wie in der Bestands-Auswahl.
        gesamt.fehler.push(`${konto.name}: ${err.message}`);
      }
    }

    gesamt.sekunden = Math.round((Date.now() - laufendSeit) / 1000);
    gesamt.fehler = gesamt.fehler.slice(0, 20);
    settings.setze('nachsortierung_letzter_lauf', JSON.stringify(gesamt));

    const wort = trockenlauf
      ? `${gesamt.treffer} Mail(s) würden verschoben (Trockenlauf, nichts bewegt)`
      : `${gesamt.verschoben} von ${gesamt.treffer} Mail(s) verschoben`;
    loggen(gesamt.fehler.length ? 'warn' : 'info', 'nachsortierung',
      `Nachsortierung: ${gesamt.geprueft} Mail(s) geprüft, ${wort}, ${gesamt.sekunden} s.`
      + (gesamt.treffer >= e.max ? ` Obergrenze von ${e.max} erreicht — der Rest kommt beim nächsten Lauf.` : '')
      + (gesamt.fehler.length ? ` ${gesamt.fehler.length} Fehler.` : ''));
    return gesamt;
  } finally {
    laufendSeit = null;
  }
}

// Das Panel hat keinen eigenen Zeitplaner. Statt einen einzuführen, wird
// stündlich nachgesehen, ob der letzte Lauf lange genug her ist. Das übersteht
// auch einen Neustart, weil der Zeitpunkt in den Einstellungen steht und nicht
// im Arbeitsspeicher.
let uhr = null;

function zeitplanStarten(intervallMs = 3600 * 1000) {
  if (uhr) clearInterval(uhr);
  uhr = setInterval(() => {
    if (!faellig() || laeuftGerade()) return;
    lauf().catch((err) => loggen('error', 'nachsortierung', `Lauf gescheitert: ${err.message}`));
  }, intervallMs);
  if (uhr.unref) uhr.unref();
  return uhr;
}

module.exports = {
  lauf,
  faellig,
  laeuftGerade,
  einstellungen,
  letzterLauf,
  ordnerAuswahl,
  selberOrdner,
  zeitplanStarten,
  GESPERRTE_ROLLEN,
};
