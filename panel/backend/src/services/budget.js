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

function tagesbudget() {
  const n = Number(settings.hole('gemini_tagesbudget'));
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = kein Deckel
}

function heuteVerbraucht() {
  try {
    return db.prepare(
      "SELECT COUNT(*) n FROM quarantine_log WHERE created_at >= date('now','localtime')",
    ).get().n;
  } catch { return 0; }
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
  let uebersprungenGesehen = 0;
  let uebersprungenBudget = 0;

  for (let i = 0; i < liste.length; i++) {
    const k = liste[i] || {};
    if (schonGesehen(k.konto, k.von, k.betreff)) { uebersprungenGesehen++; continue; }
    if (erlaubt.length >= rest) { uebersprungenBudget++; continue; }
    erlaubt.push(i);
  }

  return {
    erlaubt,
    budget: {
      grenze,
      verbraucht,
      rest: grenze === 0 ? null : Math.max(0, grenze - verbraucht),
      unbegrenzt: grenze === 0,
    },
    uebersprungen: { gesehen: uebersprungenGesehen, budget: uebersprungenBudget },
    gesamt: liste.length,
  };
}

module.exports = { entscheiden, tagesbudget, heuteVerbraucht, schonGesehen };

// Für den Budget-Knoten in Workflow 04: nimmt die vollen Mail-Objekte, gibt die
// erlaubten unverändert zurück. Der HTTP-Knoten reicht genau diese an Gemini
// weiter — alles andere fällt vor dem KI-Aufruf weg und kostet kein Budget.
function filtern(mails) {
  const liste = Array.isArray(mails) ? mails : [];
  const { erlaubt, budget, uebersprungen } = entscheiden(
    liste.map((m) => ({ konto: m && m.konto, von: m && m.von, betreff: m && m.betreff })),
  );
  return { mails: erlaubt.map((i) => liste[i]), budget, uebersprungen, gesamt: liste.length };
}

module.exports.filtern = filtern;
