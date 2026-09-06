// Der KI-Budget-Wächter — die harte Grenze, nicht bloß die Anzeige.
//
// Warum es diese Stelle überhaupt gibt: Workflow 04 ruft Gemini einmal pro Mail
// auf, und die Gratisstufe hat ein Tageslimit. Wer ein großes Postfach neu
// hinzufügt, würde ohne Bremse an einem Tag das ganze Limit verbrennen — danach
// steht auch die Sortierung der laufenden Post still. Diese Funktion entscheidet
// VOR dem Gemini-Aufruf, welche Mails heute noch drankommen.
//
// Zwei Regeln, in dieser Reihenfolge:
//
//   1. Schon einmal eingeordnete Mails kosten kein Budget mehr. Eine Mail, die
//      unsicher war und im Posteingang liegen blieb, taucht bei jedem Lauf
//      wieder auf — sie erneut an Gemini zu schicken, wäre pure Verschwendung.
//      Erkennbar daran, dass sie schon in der Sortier-Inbox oder frisch im
//      Quarantäne-Log steht.
//   2. Vom Rest so viele, wie das Tagesbudget noch hergibt.
//
// Gibt Indizes zurück, keine Mail-Inhalte: Der Sammel-Knoten schickt seine
// Kandidaten in einer festen Reihenfolge und kürzt seine Liste auf die erlaubten
// Plätze — eindeutig, auch wenn zwei Mails gleich aussehen.
const db = require('../db');
const settings = require('./settings');
const sortierung = require('./sortierung');

// "In Ruhe lassen"-Regeln: Mails, die der Nutzer bewusst nicht angefasst haben
// will, sollen gar nicht erst KI-Budget kosten. Die Regeln werden je Konto
// EINMAL geladen — entscheiden() bekommt schnell mal hunderte Kandidaten, da
// soll nicht jede Zeile die Datenbank erneut befragen.
function regelPruefer() {
  const cache = new Map();
  return (kontoName, von, betreff) => {
    const name = String(kontoName || '');
    if (!cache.has(name)) {
      let regeln = [];
      try {
        const id = db.prepare('SELECT id FROM accounts WHERE name = ?').get(name)?.id;
        if (id) regeln = db.prepare('SELECT * FROM sort_rules WHERE konto_id = ?').all(id);
      } catch { regeln = []; }
      cache.set(name, regeln);
    }
    // Erste passende Regel gewinnt — dieselbe Rangfolge wie in pruefeRegeln.
    return cache.get(name).find((r) => sortierung.passt(r, von, betreff)) || null;
  };
}

// Hat Google heute schon abgewiesen? Dann gilt dessen Grenze für den Rest des
// Tages — egal, was im Panel eingestellt ist.
//
// Ohne das lief Folgendes: Das Tagesbudget stand auf 50.000, Google machte bei
// gut 400 dicht, und jeder weitere Lauf holte trotzdem 200 Mails, schickte 100
// an die KI und starb dort. Vier Minuten Arbeit für nichts, alle vier Stunden.
//
// Die Zahl kommt aus services/kiKontingent.js; hier wird sie nur gelesen — jenes
// Modul liest umgekehrt dieses hier. Am liebsten die, die Google selbst in der
// Absage nennt („limit: 500, model: …"); sonst der eigene Stand im Moment der
// Abweisung.
function beobachteteGrenze() {
  try {
    const heute = new Date().toLocaleDateString('sv-SE');
    if (settings.hole('ki_429_tag') !== heute) return 0;

    // Kontingente gelten je Modell. Wurde inzwischen auf ein anderes gewechselt,
    // hat das sein eigenes — die Abweisung von vorhin sagt darüber nichts. Ohne
    // diese Prüfung würde der Deckel genau das Ersatzmodell aussperren, dessen
    // frisches Kontingent der einzige Grund für den Wechsel war.
    const abgewiesen = settings.hole('ki_429_modell');
    if (abgewiesen && abgewiesen !== require('./kiModell').aktiv()) return 0;

    // Googles eigene Zahl schlägt die eigene Zählung: Stirbt ein Lauf bei
    // Gemini, wird keine der vorher klassifizierten Mails protokolliert —
    // verbraucht waren sie trotzdem. Die eigene Zählung liegt also zu niedrig.
    const vonGoogle = Number(settings.hole('ki_429_limit'));
    if (Number.isFinite(vonGoogle) && vonGoogle > 0) return vonGoogle;

    const n = Number(settings.hole('ki_429_stand'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function tagesbudget() {
  const n = Number(settings.hole('gemini_tagesbudget'));
  const eingestellt = Number.isFinite(n) && n > 0 ? n : 0; // 0 = kein Deckel
  const beobachtet = beobachteteGrenze();
  if (!beobachtet) return eingestellt;
  return eingestellt ? Math.min(eingestellt, beobachtet) : beobachtet;
}

// Wie viele Anfragen hat das Panel heute an Gemini herausgegeben?
//
// Diese Zahl gibt es, weil die Protokollzählung systematisch zu niedrig liegt:
// Stirbt ein Lauf am Gemini-Knoten, scheitert der ganze Knoten — die Mails, die
// vorher sauber klassifiziert wurden, laufen nie bis zum Panel weiter und werden
// deshalb nirgends protokolliert. Googles Kontingent haben sie trotzdem gekostet.
// Genau daher die Lücke zwischen „412 gezählt" und „limit: 500".
//
// Gezählt wird beim Herausgeben, also bevor etwas schiefgehen kann. Lieber einmal
// zu viel gezählt (ein Lauf stirbt vor Gemini) als ein Deckel, der zu spät greift.
const AUSGABE_TAG = 'ki_ausgabe_tag';
const AUSGABE_STAND = 'ki_ausgabe_stand';

function ausgegebenHeute() {
  try {
    if (settings.hole(AUSGABE_TAG) !== new Date().toLocaleDateString('sv-SE')) return 0;
    const n = Number(settings.hole(AUSGABE_STAND));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function ausgabeMerken(anzahl) {
  const n = Number(anzahl);
  if (!Number.isFinite(n) || n <= 0) return ausgegebenHeute();
  try {
    const stand = ausgegebenHeute() + n;
    settings.setze(AUSGABE_TAG, new Date().toLocaleDateString('sv-SE'));
    settings.setze(AUSGABE_STAND, String(stand));
    return stand;
  } catch { return 0; }
}

function protokolliertHeute() {
  try {
    return db.prepare(
      // ki = 0 sind Mails, die eine eigene Regel sortiert hat — die haben Gemini
      // nie gesehen und dürfen das Tageslimit nicht anknabbern.
      "SELECT COUNT(*) n FROM quarantine_log WHERE created_at >= date('now','localtime')"
      + ' AND IFNULL(ki, 1) = 1',
    ).get().n;
  } catch { return 0; }
}

// Die höhere der beiden Zahlen ist die ehrliche: Workflow 01 protokolliert ohne
// Ausgabe-Vermerk (er fragt den Wächter nicht), ein gestorbener Bestandslauf hat
// den Vermerk ohne Protokoll.
function heuteVerbraucht() {
  return Math.max(protokolliertHeute(), ausgegebenHeute());
}

// Kennt das Panel diese Mail schon? von + betreff + konto, gegen die
// Sortier-Inbox (jeder Status) und das Quarantäne-Log der letzten 26 Stunden.
// 26 statt 24, damit ein Lauf um Mitternacht nicht durch die Ritze fällt.
function schonGesehen(konto, von, betreff) {
  const v = String(von || '');
  const b = String(betreff || '');
  try {
    const inInbox = db.prepare(
      'SELECT 1 FROM sort_inbox WHERE konto = ? AND von = ? AND IFNULL(betreff,\'\') = ? LIMIT 1',
    ).get(konto, v, b);
    if (inInbox) return true;
    const imLog = db.prepare(
      "SELECT 1 FROM quarantine_log WHERE konto = ? AND von = ? AND IFNULL(betreff,'') = ?"
      + " AND created_at >= datetime('now','-26 hours') LIMIT 1",
    ).get(konto, v, b);
    return Boolean(imLog);
  } catch {
    return false; // Im Zweifel nicht blockieren — lieber einmal zu viel prüfen.
  }
}

// kandidaten: [{ konto, von, betreff }] in der Reihenfolge, in der der
// Sammel-Knoten sie hält.
function entscheiden(kandidaten) {
  const liste = Array.isArray(kandidaten) ? kandidaten : [];
  const grenze = tagesbudget();
  const verbraucht = heuteVerbraucht();
  const rest = grenze === 0 ? Infinity : Math.max(0, grenze - verbraucht);

  const erlaubt = [];
  const ruheIndizes = [];
  let uebersprungenGesehen = 0;
  let uebersprungenBudget = 0;
  let uebersprungenRuhe = 0;
  // Wie viele Plätze am Tagesbudget sind in diesem Lauf schon vergeben? Nicht
  // erlaubt.length nehmen: Darin stecken auch die Mails, die eine Regel ohne
  // KI sortiert.
  let kiPlaetze = 0;
  const regelFuer = regelPruefer();

  for (let i = 0; i < liste.length; i++) {
    const k = liste[i] || {};
    const regel = regelFuer(k.konto, k.von, k.betreff);
    if (regel && (regel.aktion || 'verschieben') === 'behalten') {
      uebersprungenRuhe++; ruheIndizes.push(i); continue;
    }
    if (schonGesehen(k.konto, k.von, k.betreff)) { uebersprungenGesehen++; continue; }
    // Eine Regel sortiert im Workflow vor der KI-Abfrage ("Gleich sortieren?").
    // Solche Mails laufen an Gemini vorbei und kosten deshalb kein Budget —
    // sonst bremst der Deckel genau das aus, was gar nichts kostet.
    if (regel) { erlaubt.push(i); continue; }
    if (kiPlaetze >= rest) { uebersprungenBudget++; continue; }
    kiPlaetze++;
    erlaubt.push(i);
  }

  return {
    erlaubt,
    ruheIndizes,
    // Wie viele davon wirklich bei Gemini landen. Regel-Mails sind in
    // erlaubt mit drin, kosten aber nichts — nur diese Zahl darf gezaehlt
    // werden, wenn der Aufrufer den Verbrauch vermerkt.
    kiAnfragen: kiPlaetze,
    budget: {
      grenze,
      verbraucht,
      rest: grenze === 0 ? null : Math.max(0, grenze - verbraucht),
      unbegrenzt: grenze === 0,
    },
    uebersprungen: { gesehen: uebersprungenGesehen, budget: uebersprungenBudget, ruhe: uebersprungenRuhe },
    gesamt: liste.length,
  };
}

module.exports = {
  entscheiden, tagesbudget, heuteVerbraucht, schonGesehen, beobachteteGrenze,
  ausgegebenHeute, ausgabeMerken, protokolliertHeute,
};

// Für den Budget-Knoten in Workflow 04: nimmt die vollen Mail-Objekte, gibt die
// erlaubten unverändert zurück. Der HTTP-Knoten reicht genau diese an Gemini
// weiter — alles andere fällt vor dem KI-Aufruf weg und kostet kein Budget.
function filtern(mails) {
  const liste = Array.isArray(mails) ? mails : [];
  const { erlaubt, ruheIndizes, budget, uebersprungen, kiAnfragen } = entscheiden(
    liste.map((m) => ({ konto: m && m.konto, von: m && m.von, betreff: m && m.betreff })),
  );
  return {
    mails: erlaubt.map((i) => liste[i]),
    ruheMails: (ruheIndizes || []).map((i) => liste[i]),
    budget,
    uebersprungen,
    kiAnfragen,
    gesamt: liste.length,
  };
}

module.exports.filtern = filtern;
