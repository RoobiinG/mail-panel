// Die Auswertung.
//
// Vorher standen hier vier Abfragen ohne jedes WHERE: Alle Zahlen waren
// Gesamtwerte seit Installation. Ein Spam-Ausschlag von letztem Dienstag war
// damit unsichtbar, und ein Konto, das seit einem halben Jahr sauber läuft, sah
// genauso aus wie eines, das gestern aus dem Ruder lief. Dazu fiel alles außer
// vier Kategorien in einen Topf "sonstiges" — also ausgerechnet die
// Themen-Sortierung, die die eigentliche Arbeit des Panels ist.
//
// Jetzt: ein Zeitfenster (7/30/90 Tage), ein Kontofilter, und vier Abschnitte
// entlang der Fragen, die man tatsächlich an so eine Seite hat — wie gut
// sortiert es, wie viel läuft durch, wer schreibt mir, was kostet es.
//
// Alle Abfragen laufen gegen `quarantine_log` (Index auf created_at) und sind
// gruppiert, statt Zeilen zu holen und in JavaScript zu zählen.
const express = require('express');

const router = express.Router();
const db = require('../db');

const ERLAUBTE_TAGE = [7, 30, 90];

function fensterTage(roh) {
  const n = Number(roh);
  return ERLAUBTE_TAGE.includes(n) ? n : 30;
}

// Baut die gemeinsame Einschränkung. Das Konto kommt als NAME — im
// quarantine_log steht der Name, nicht die id.
function bedingung(tage, konto) {
  const teile = ["created_at >= datetime('now', ?)"];
  const werte = [`-${tage} days`];
  if (konto) {
    teile.push('konto = ?');
    werte.push(konto);
  }
  return { wo: teile.join(' AND '), werte };
}

const alle = (sql, werte = []) => {
  try { return db.prepare(sql).all(...werte); } catch { return []; }
};
const eine = (sql, werte = []) => {
  try { return db.prepare(sql).get(...werte) || {}; } catch { return {}; }
};

// "Name <a@b.de>" -> "b.de". In der Datenbank steht meist schon die nackte
// Adresse, aber eben nicht immer — deshalb hier statt in SQL, wo beide Fälle
// eine unleserliche Verschachtelung ergäben.
function domainVon(von) {
  const roh = String(von || '').toLowerCase().trim();
  const spitz = roh.match(/<([^>]+)>/);
  const adresse = (spitz ? spitz[1] : roh).trim();
  return adresse.split('@')[1] || '';
}

router.get('/', (req, res) => {
  try {
    const tage = fensterTage(req.query.tage);
    const konto = String(req.query.konto || '').trim() || null;
    const { wo, werte } = bedingung(tage, konto);

    // ─── Der Verlauf: eine Zeile je Tag ──────────────────────────────────────
    // Trägt drei der vier Fragen gleichzeitig: Menge (Durchsatz), Anteil der
    // KI gegenüber den Regeln (Kosten) und was liegenblieb (Qualität).
    const verlauf = alle(`
      SELECT date(created_at) AS tag,
             COUNT(*)                                            AS gesamt,
             SUM(CASE WHEN IFNULL(ki, 1) = 1 THEN 1 ELSE 0 END)  AS vonKi,
             SUM(CASE WHEN IFNULL(ki, 1) = 0 THEN 1 ELSE 0 END)  AS vonRegel,
             SUM(CASE WHEN korrigiert_zu IS NOT NULL THEN 1 ELSE 0 END) AS korrigiert,
             SUM(CASE WHEN zielordner IS NULL OR zielordner = '' THEN 1 ELSE 0 END) AS liegengeblieben
      FROM quarantine_log
      WHERE ${wo}
      GROUP BY date(created_at)
      ORDER BY tag
    `, werte);

    const summe = eine(`
      SELECT COUNT(*) AS gesamt,
             SUM(CASE WHEN IFNULL(ki, 1) = 1 THEN 1 ELSE 0 END) AS vonKi,
             SUM(CASE WHEN IFNULL(ki, 1) = 0 THEN 1 ELSE 0 END) AS vonRegel,
             SUM(CASE WHEN korrigiert_zu IS NOT NULL THEN 1 ELSE 0 END) AS korrigiert,
             SUM(CASE WHEN zielordner IS NULL OR zielordner = '' THEN 1 ELSE 0 END) AS liegengeblieben
      FROM quarantine_log WHERE ${wo}
    `, werte);

    // ─── Wie gut sortiert es? ────────────────────────────────────────────────
    const konfidenz = alle(`
      SELECT CASE
               WHEN konfidenz IS NULL THEN 'unbekannt'
               WHEN konfidenz >= 0.9  THEN 'sehr sicher'
               WHEN konfidenz >= 0.7  THEN 'sicher'
               WHEN konfidenz >= 0.5  THEN 'unsicher'
               ELSE 'sehr unsicher'
             END AS stufe,
             COUNT(*) AS anzahl
      FROM quarantine_log
      WHERE ${wo} AND IFNULL(ki, 1) = 1
      GROUP BY stufe
    `, werte);

    const gruende = alle(`
      SELECT grund, COUNT(*) AS anzahl
      FROM quarantine_log
      WHERE ${wo} AND grund IS NOT NULL AND grund != ''
      GROUP BY grund ORDER BY anzahl DESC LIMIT 8
    `, werte);

    // ─── Wo landet die Post? ─────────────────────────────────────────────────
    // Nach Zielordner statt nach Kategorie: Die Kategorie kennt fünf Werte, der
    // Zielordner zeigt die tatsächliche Ablage — Themen-Ordner inklusive.
    const zielordner = alle(`
      SELECT zielordner AS ordner, COUNT(*) AS anzahl
      FROM quarantine_log
      WHERE ${wo} AND zielordner IS NOT NULL AND zielordner != ''
      GROUP BY zielordner ORDER BY anzahl DESC LIMIT 12
    `, werte);

    // ─── Wer schreibt mir? ───────────────────────────────────────────────────
    const topAbsender = alle(`
      SELECT von, COUNT(*) AS anzahl
      FROM quarantine_log
      WHERE ${wo} AND von IS NOT NULL AND von != ''
      GROUP BY von ORDER BY anzahl DESC LIMIT 200
    `, werte);

    const domains = (() => {
      const topf = new Map();
      for (const zeile of topAbsender) {
        const d = domainVon(zeile.von);
        if (!d) continue;
        topf.set(d, (topf.get(d) || 0) + zeile.anzahl);
      }
      return [...topf.entries()]
        .map(([domain, anzahl]) => ({ domain, anzahl }))
        .sort((a, b) => b.anzahl - a.anzahl)
        .slice(0, 10);
    })();

    // Die Treffer einer Regel sind ein Zähler ohne Zeitstempel — er lässt sich
    // nur ranken, nicht über die Zeit auftragen. Deshalb hier als Bestenliste
    // und ausdrücklich als Gesamtwert beschriftet.
    const regeln = alle(`
      SELECT r.typ, r.muster, r.zielordner, r.treffer, a.name AS konto
      FROM sort_rules r JOIN accounts a ON a.id = r.konto_id
      ${konto ? 'WHERE a.name = ?' : ''}
      ORDER BY r.treffer DESC LIMIT 10
    `, konto ? [konto] : []);

    const newsletterOffen = eine(
      'SELECT COUNT(*) AS n FROM newsletter_senders WHERE abbestellt_am IS NULL',
    ).n || 0;

    // ─── Was hakt? ───────────────────────────────────────────────────────────
    // Zeitüberschreitungen und abgebrochene Bündel stehen im Panel-Protokoll,
    // nicht im Quarantäne-Log — hier werden sie je Tag gezählt, damit ein
    // schlechter Tag als Ausschlag sichtbar wird statt als Zeile im Log.
    const stoerungen = alle(`
      SELECT date(created_at) AS tag, COUNT(*) AS anzahl
      FROM panel_logs
      WHERE created_at >= datetime('now', ?) AND level IN ('warn','error')
        AND (quelle LIKE '%klassifizierer%' OR quelle LIKE '%ollama%')
      GROUP BY date(created_at) ORDER BY tag
    `, [`-${tage} days`]);

    // ─── Was kostet es? ──────────────────────────────────────────────────────
    const budget = (() => {
      try {
        const b = require('../services/budget');
        const settings = require('../services/settings');
        return {
          grenze: b.tagesbudget(),
          heuteAnfragen: b.heuteVerbraucht(),
          heuteMails: b.protokolliertHeute(),
          anbieter: settings.hole('ki_anbieter') || 'gemini',
        };
      } catch {
        return null;
      }
    })();

    const konten = alle(
      "SELECT DISTINCT konto FROM quarantine_log WHERE created_at >= datetime('now', ?) AND konto IS NOT NULL ORDER BY konto",
      [`-${tage} days`],
    ).map((z) => z.konto);

    res.json({
      ok: true,
      zeitraum: { tage },
      konten,
      gewaehltesKonto: konto,
      summe: {
        gesamt: summe.gesamt || 0,
        vonKi: summe.vonKi || 0,
        vonRegel: summe.vonRegel || 0,
        korrigiert: summe.korrigiert || 0,
        liegengeblieben: summe.liegengeblieben || 0,
        // Anteil der Einordnungen, die der Nutzer hinterher geradegezogen hat.
        // Die aussagekräftigste Einzelzahl der Seite: Sie misst, wie oft das
        // Panel danebenlag — soweit es jemand bemerkt und korrigiert hat.
        korrekturQuote: summe.gesamt
          ? Number(((summe.korrigiert / summe.gesamt) * 100).toFixed(1)) : null,
      },
      verlauf,
      konfidenz,
      gruende,
      zielordner,
      absender: topAbsender.slice(0, 10),
      domains,
      regeln,
      newsletterOffen,
      stoerungen,
      budget,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
