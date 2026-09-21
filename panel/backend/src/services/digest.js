// Der tägliche Digest (Workflow 02) — vom Panel erstellt, nicht von n8n.
//
// Bis Build 233 baute n8n aus ALLEN Mails der letzten 24 Stunden einen Prompt
// („Erstelle eine Zusammenfassung … Zähler-Zeile … Quarantäne-Liste") und
// schickte ihn direkt an die KI. Am 17.09. um 7:30 scheiterte das so:
//
//     KI zusammenfassen — Gateway timed out (HTTP 504), Dauer 3 Min. 8 Sek.
//
// Drei Gründe griffen ineinander:
//   * Seit die Bestands-Triage läuft, stehen Hunderte Mails am Tag im
//     Protokoll. Jede wurde eine Zeile im Prompt — weit mehr, als das
//     Kontextfenster fasst. Ollama schneidet dann vorn ab, also die Anweisung.
//   * Der Knoten bekam beim Abgleich dieselben Einstellungen wie die
//     Klassifizierung: `format: 'json'` und höchstens 600 Token Antwort — für
//     einen Fließtext von 3.000 Zeichen beides falsch.
//   * Er fragte Ollama an Warteschlange und Messung vorbei, lief zweimal in die
//     90-Sekunden-Grenze des Reverse-Proxys (90 + 5 + 90 s) — und ohne Antwort
//     kam gar keine Nachricht.
//
// Jetzt zählt und listet das Panel selbst; das kann es exakt und ohne KI. Die
// KI schreibt nur noch das, was ein Zähler nicht kann — ein paar Sätze zu den
// wichtigen Mails —, aus einer kleinen, begrenzten Auswahl, über den normalen
// Weg (services/kiText.js). Scheitert sie, kommt der Digest trotzdem, nur ohne
// diesen Absatz.
const db = require('../db');
const settings = require('./settings');
const kiText = require('./kiText');
const { loggen } = require('./panelLog');

// Telegram nimmt 4.096 Zeichen; „Text extrahieren" in n8n kappt bei 4.000.
const MAX_ZEICHEN = 3900;
const MAX_LISTE = 10;
const MAX_ORDNER = 8;
// So viele Mails sieht die KI höchstens. Mehr macht die Sätze nicht besser,
// nur die Anfrage langsamer.
const MAX_KI_MAILS = 25;
const WICHTIG = ['persoenlich', 'rechnung', 'bestellung'];

// Die Rohdaten der letzten 24 Stunden, nach Art sortiert. Dieselbe Einteilung
// wie bisher in GET /api/internal/digest — der Endpunkt bleibt für eigene
// Workflows bestehen und nutzt jetzt diese Funktion.
function daten() {
  const logs = db.prepare(`
    SELECT konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, virus_name
    FROM quarantine_log
    WHERE created_at >= datetime('now', '-1 day')
    ORDER BY created_at DESC
  `).all();

  const z = { spam: [], phishing: [], newsletter: [], sonstiges: [], quarantaene: [] };
  for (const row of logs) {
    if (row.virus_name) z.quarantaene.push(row);
    else if (row.kategorie === 'spam') z.spam.push(row);
    else if (row.kategorie === 'phishing') z.phishing.push(row);
    else if (row.kategorie === 'newsletter') z.newsletter.push(row);
    // Der Standardname ist „Quarantaene" (Workflow 01/04). Geprüft wurde bis
    // hierher nur auf „Quarantine" und „Junk" — eine Mail im deutschen
    // Quarantäne-Ordner zählte also als „sonstiges".
    else if (/quarant|junk/i.test(String(row.zielordner || ''))) z.quarantaene.push(row);
    else z.sonstiges.push(row);
  }
  return { ok: true, total: logs.length, logs, ...z };
}

const tausender = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// "Max Muster <max@firma.de>" -> "Max Muster"; ohne Namen die Adresse.
function absenderKurz(von) {
  const roh = String(von || '').trim();
  const name = roh.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return (name ? name[1] : roh.replace(/[<>]/g, '')).trim().slice(0, 40) || '(unbekannt)';
}

const kuerzen = (text, n) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function datumHeute(jetzt = new Date()) {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      ...(process.env.TZ ? { timeZone: process.env.TZ } : {}),
    }).format(jetzt);
  } catch {
    return jetzt.toISOString().slice(0, 10);
  }
}

function offenZaehlen() {
  const zahl = (sql) => { try { return db.prepare(sql).get().n || 0; } catch { return 0; } };
  return {
    sortierInbox: zahl("SELECT COUNT(*) n FROM sort_inbox WHERE status = 'offen'"),
    ordnerVorschlaege: zahl("SELECT COUNT(*) n FROM ordner_vorschlaege WHERE status = 'offen'"),
    freigaben: zahl("SELECT COUNT(*) n FROM upload_freigaben WHERE status = 'offen'"),
  };
}

// ─── Der KI-Teil ─────────────────────────────────────────────────────────────

function kiPrompt(mails) {
  const bloecke = mails.map((m, i) => [
    `[${i + 1}]`,
    `Von: ${kuerzen(m.von, 80)}`,
    `Betreff: ${kuerzen(m.betreff, 150) || '(kein Betreff)'}`,
    `Art: ${m.kategorie || 'unbekannt'}`,
    m.kurzfassung ? `Kurzfassung: ${kuerzen(m.kurzfassung, 200)}` : null,
  ].filter(Boolean).join('\n'));
  return [
    'Du bekommst die wichtigen E-Mails der letzten 24 Stunden: persönliche Post, Rechnungen, Bestellungen.',
    'Schreibe auf Deutsch 2 bis 5 kurze Stichpunkte für eine Morgen-Nachricht: Was sollte der Empfänger',
    'heute wissen oder erledigen? Nenne jeweils Absender oder Firma. Fasse Gleichartiges zusammen.',
    'Keine Einleitung, keine Aufzählung aller Mails, nichts erfinden, was nicht in den Mails steht.',
    'Antworte NUR mit JSON: {"punkte": ["…", "…"]}',
    '',
    kiText.MAIL_MARKE,
    ...bloecke,
  ].join('\n');
}

const KI_SCHEMA = {
  type: 'object',
  properties: { punkte: { type: 'array', items: { type: 'string' }, maxItems: 5 } },
  required: ['punkte'],
};

async function kiPunkte(mails) {
  if (mails.length === 0) return { punkte: [], hinweis: '' };
  const r = await kiText.frageJson(kiPrompt(mails), {
    schema: KI_SCHEMA,
    quelle: 'digest',
    maxAntwort: 400,
    // Unter der Zeitgrenze des n8n-Knotens (120 s) — mit Luft für das Zählen
    // davor und danach. Auf die Warteschlange darf höchstens ein Teil davon
    // gehen (siehe kiText.frageJson).
    zeitlimit: 90000,
    mails: mails.length,
  });
  if (!r.ok) return { punkte: [], hinweis: r.fehler || 'KI nicht erreichbar' };
  const punkte = (Array.isArray(r.daten?.punkte) ? r.daten.punkte : [])
    .map((p) => kuerzen(p, 220))
    .filter((p) => p.length > 3)
    .slice(0, 5);
  if (punkte.length === 0) return { punkte: [], hinweis: 'Die KI hat nichts Verwertbares geliefert.' };
  return { punkte, hinweis: '' };
}

// ─── Zusammensetzen ──────────────────────────────────────────────────────────

function liste(titel, zeilen, gesamt) {
  if (zeilen.length === 0) return null;
  const rest = gesamt - zeilen.length;
  return [titel, ...zeilen.map((z) => `• ${z}`), ...(rest > 0 ? [`… und ${tausender(rest)} weitere`] : [])].join('\n');
}

/**
 * Den Text für Telegram bauen.
 * @param {{ohneKi?: boolean, jetzt?: Date}} opt
 * @returns {Promise<{text: string, ki: boolean, hinweis: string, total: number}>}
 */
async function erstellen(opt = {}) {
  const d = daten();
  const offen = offenZaehlen();
  const teile = [`📬 Mail-Digest ${datumHeute(opt.jetzt)}`];

  const spamGesamt = d.spam.length + d.phishing.length + d.quarantaene.length;
  teile.push(d.total === 0
    ? 'In den letzten 24 Stunden wurde keine Mail verarbeitet.'
    : `${tausender(d.total)} Mails in den letzten 24 Stunden: ${tausender(d.sonstiges.length)} sonstige, `
      + `${tausender(d.newsletter.length)} Newsletter, ${tausender(spamGesamt)} Spam/Quarantäne.`);

  // Das Wichtigste zuerst — und genau der Teil, den nur die KI kann.
  const wichtig = d.sonstiges.filter((m) => WICHTIG.includes(m.kategorie));
  let ki = false;
  let hinweis = '';
  if (!opt.ohneKi && wichtig.length > 0) {
    const r = await kiPunkte(wichtig.slice(0, MAX_KI_MAILS));
    if (r.punkte.length > 0) {
      ki = true;
      teile.push(['Das Wichtigste:', ...r.punkte.map((p) => `• ${p}`)].join('\n'));
    } else {
      hinweis = r.hinweis;
      loggen('warn', 'digest', `Digest ohne KI-Absatz verschickt: ${hinweis}`);
    }
  }

  teile.push(liste(
    `Persönlich, Rechnungen, Bestellungen (${tausender(wichtig.length)}):`,
    wichtig.slice(0, MAX_LISTE).map((m) => `${absenderKurz(m.von)} — ${kuerzen(m.betreff, 70) || '(kein Betreff)'}`),
    wichtig.length,
  ));

  // Wohin ist die Post gegangen? Ohne Spam, der hat seinen eigenen Abschnitt.
  const ordner = new Map();
  for (const m of [...d.sonstiges, ...d.newsletter]) {
    const o = m.zielordner || 'im Posteingang geblieben';
    ordner.set(o, (ordner.get(o) || 0) + 1);
  }
  const ordnerListe = [...ordner.entries()].sort((a, b) => b[1] - a[1]);
  teile.push(liste(
    'Einsortiert:',
    ordnerListe.slice(0, MAX_ORDNER).map(([o, n]) => `${tausender(n)} × ${o}`),
    ordnerListe.length,
  ));

  const spam = [...d.quarantaene, ...d.phishing, ...d.spam];
  teile.push(liste(
    `Quarantäne / Spam (${tausender(spamGesamt)}):`,
    spam.slice(0, MAX_LISTE).map((m) => `${absenderKurz(m.von)} — ${kuerzen(m.betreff, 60) || '?'}`
      + (m.virus_name ? ` [VIRUS: ${m.virus_name}]` : m.spam_score != null ? ` (Score ${Number(m.spam_score).toFixed(2)})` : '')),
    spam.length,
  ) || 'Quarantäne / Spam: keine Einträge.');

  const warten = [
    offen.sortierInbox && `${tausender(offen.sortierInbox)} Mails in der Sortier-Inbox`,
    offen.ordnerVorschlaege && `${tausender(offen.ordnerVorschlaege)} Ordner-Vorschläge`,
    offen.freigaben && `${tausender(offen.freigaben)} Dateien zur Freigabe`,
  ].filter(Boolean);
  if (warten.length) teile.push(['Wartet im Panel:', ...warten.map((w) => `• ${w}`)].join('\n'));

  if (hinweis) teile.push(`(Ohne KI-Zusammenfassung: ${kuerzen(hinweis, 160)})`);

  let text = teile.filter(Boolean).join('\n\n');
  if (text.length > MAX_ZEICHEN) text = `${text.slice(0, MAX_ZEICHEN - 1)}…`;
  return { text, ki, hinweis, total: d.total };
}

module.exports = { daten, erstellen, absenderKurz, kiPrompt, MAX_ZEICHEN };
