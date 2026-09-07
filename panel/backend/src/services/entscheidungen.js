// Die Chronik: was ist mit welcher Mail passiert — und wer hat das entschieden.
//
// Sichtbar waren bisher nur die letzten 25 Einordnungen. Wer einen Fehler
// bemerkt („die Rechnung von letzter Woche liegt im falschen Ordner"), findet
// ihn dort nicht mehr: Bei ein paar hundert Mails am Tag ist er längst
// herausgerutscht. Ohne Suche bleibt nur, das Postfach von Hand zu
// durchforsten — und genau dann korrigiert man die Fehleinordnung nicht mehr,
// und die KI trifft sie beim nächsten Mal wieder.
//
// Deshalb hier: der ganze Bestand, blätterbar, durchsuchbar über die Felder,
// nach denen man tatsächlich sucht — Absender, Betreff, Thema, Ordner.
const db = require('../db');
const settings = require('./settings');

// Was die Liste zeigt. spam_score und virus_name gehören dazu, weil eine
// Fehlentscheidung auch „fälschlich als Spam" heißen kann; ki sagt, ob die KI
// oder eine eigene Regel entschieden hat — die zwei Fälle repariert man
// verschieden; grund sagt, weshalb überhaupt so entschieden wurde.
const SPALTEN = `id, konto, von, betreff, kategorie, thema, konfidenz, zielordner,
                 kurzfassung, spam_score, virus_name, dnsbl_treffer, uid, korrigiert_zu, grund,
                 IFNULL(ki, 1) AS ki, created_at`;

// Die Felder, in denen gesucht wird. Der Grund gehört dazu: „existiert nicht"
// findet damit auf einen Schlag alle Mails, die an einem fehlenden Zielordner
// gescheitert sind. Bewusst nicht die Kurzfassung — das ist der Text der KI,
// nicht der der Mail; Treffer darin wären für den Suchenden nicht
// nachvollziehbar.
const SUCHFELDER = ['von', 'betreff', 'thema', 'kategorie', 'zielordner', 'korrigiert_zu', 'grund'];

// In LIKE-Mustern sind % und _ Platzhalter. Wer nach „50%" sucht, meint das
// Zeichen wörtlich — ungemaskiert stünde es für „irgendetwas", und die Suche
// fände jede Zeile. Der Backslash selbst muss mit, sonst bliebe am Ende eines
// Musters eine angefangene Maskierung stehen.
function maskieren(text) {
  return String(text).replace(/[\\%_]/g, (zeichen) => '\\' + zeichen);
}

// Mehrere Wörter heißen: alle müssen vorkommen, jedes darf in einem anderen
// Feld stehen. "amazon rechnung" findet damit die Amazon-Mail mit Rechnung im
// Betreff — ein einziges LIKE über den zusammengeklebten Text täte das nicht.
function suchTeile(suche) {
  return String(suche || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

// Ein LIKE über alle Suchfelder, als fertiges SQL-Stück.
const LIKE_ODER = SUCHFELDER
  .map((feld) => `IFNULL(${feld}, '') LIKE ? ESCAPE '\\'`)
  .join(' OR ');

// Ab welchem Wert eine Mail als Spam galt — dieselbe Schwelle, mit der die
// Workflows arbeiten. Sie hier fest einzutragen hieße, dass der Filter etwas
// anderes zeigt, als tatsächlich passiert ist.
function spamSchwelle() {
  const n = Number(settings.hole('spam_schwellwert'));
  return Number.isFinite(n) && n > 0 ? n : 0.8;
}

// Der WHERE-Teil samt Werten — als eigene Funktion, weil ihn Liste und Zählung
// beide brauchen und ein Auseinanderlaufen der beiden eine falsche Gesamtzahl
// ergäbe.
function bedingung({ konto, suche, nur, tage } = {}) {
  const teile = [];
  const werte = [];

  if (konto) { teile.push('konto = ?'); werte.push(konto); }

  for (const wort of suchTeile(suche)) {
    const muster = `%${maskieren(wort)}%`;
    teile.push(`(${LIKE_ODER})`);
    for (let i = 0; i < SUCHFELDER.length; i += 1) werte.push(muster);
  }

  // „Letzte Woche" ist die Art, wie man sich an eine Mail erinnert — nicht
  // „Eintrag 1.240 bis 1.290".
  const spanne = Math.floor(Number(tage));
  if (Number.isFinite(spanne) && spanne > 0) {
    teile.push("created_at >= datetime('now', ?)");
    werte.push(`-${spanne} days`);
  }

  // „Liegengeblieben" ist eine eigene Sorte Entscheidung: Die Mail wurde
  // angesehen und blieb im Posteingang — weil eine Regel sie in Ruhe lässt oder
  // weil der Zielordner fehlte. Früher fehlten diese Zeilen ganz (die Abfrage
  // verlangte einen Zielordner), und damit war der häufigste Grund für „warum
  // wurde die nicht sortiert?" unsichtbar.
  if (nur === 'ki') teile.push('IFNULL(ki, 1) = 1');
  else if (nur === 'regel') teile.push('IFNULL(ki, 1) = 0');
  else if (nur === 'korrigiert') teile.push('korrigiert_zu IS NOT NULL');
  else if (nur === 'liegen') teile.push('zielordner IS NULL');
  else if (nur === 'spam') {
    // Alles, was die Prüfdienste angeschlagen haben: Virenfund, DNSBL-Treffer
    // oder ein Spam-Wert über der Schwelle. Genau die Zeilen, die man ansieht,
    // wenn man der Spam- und Virenprüfung nicht traut.
    teile.push('(virus_name IS NOT NULL OR dnsbl_treffer IS NOT NULL OR IFNULL(spam_score, 0) >= ?)');
    werte.push(spamSchwelle());
  }

  return { wo: teile.length ? `WHERE ${teile.join(' AND ')}` : '', werte };
}

const GRENZE = 200;

/**
 * Eine Seite der Chronik.
 * @param {object} o
 * @param {string} [o.konto]  Kontoname; fehlt er, wird über alle Postfächer gesucht.
 * @param {string} [o.suche]  Freitext über Absender, Betreff, Thema, Ordner, Grund.
 * @param {string} [o.nur]    'ki' | 'regel' | 'korrigiert' | 'liegen' | 'spam'
 * @param {number} [o.tage]   Nur die letzten N Tage; 0 oder fehlend = alles.
 * @param {number} [o.seite]  1-basiert.
 * @param {number} [o.limit]  Zeilen je Seite, höchstens 200.
 */
function suchen({ konto, suche, nur, tage, seite, limit } = {}) {
  const proSeite = Math.min(GRENZE, Math.max(1, Number(limit) || 50));
  const { wo, werte } = bedingung({ konto, suche, nur, tage });

  const gesamt = db.prepare(`SELECT COUNT(*) n FROM quarantine_log ${wo}`).get(...werte).n;
  const seiten = Math.max(1, Math.ceil(gesamt / proSeite));
  // Eine Seitenzahl jenseits des Endes soll nicht ins Leere zeigen — das
  // passiert regelmäßig, wenn man auf Seite 7 einen Suchbegriff eingibt.
  const aktuell = Math.min(seiten, Math.max(1, Math.floor(Number(seite)) || 1));

  const eintraege = db.prepare(`
    SELECT ${SPALTEN} FROM quarantine_log ${wo}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...werte, proSeite, (aktuell - 1) * proSeite);

  return { eintraege, gesamt, seite: aktuell, seiten, limit: proSeite };
}

module.exports = { suchen, bedingung, maskieren, suchTeile, SUCHFELDER };
