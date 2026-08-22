// Routen fuer die Ordner-Sortierung (Regeln verwalten, Inbox abarbeiten)
// Nur mit Recht "sortierung" zugaenglich.
const express = require('express');
const db      = require('../db');
const { loggen } = require('../services/panelLog');
const imap = require('../services/imap');
const themen = require('../services/themen');
const sortierung = require('../services/sortierung');
const { entschluesseln } = require('../services/crypto');

const router = express.Router();

// GET /api/sortierung/regeln?konto_id=1 — Regeln fuer ein Konto
router.get('/regeln', (req, res) => {
  const konto_id = Number(req.query.konto_id);
  if (!konto_id) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    const regeln = db.prepare('SELECT * FROM sort_rules WHERE konto_id = ? ORDER BY created_at DESC').all(konto_id);
    res.json(regeln);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/regeln — Neue Regel anlegen
router.post('/regeln', async (req, res) => {
  const { konto_id, typ, muster, zielordner } = req.body || {};
  if (!konto_id || !typ || !muster || !zielordner) {
    return res.status(400).json({ error: 'Alle Felder müssen ausgefüllt sein.' });
  }
  if (!['absender', 'betreff', 'domain'].includes(typ)) {
    return res.status(400).json({ error: 'Ungültiger Typ.' });
  }
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(konto_id));
  if (!konto) {
    return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
      VALUES (?, ?, ?, ?, ?)
    `).run(konto_id, typ, muster.trim(), zielordner.trim(), req.user.id);

    // Versuche den Zielordner direkt anzulegen (Best Effort)
    try {
      konto.passwort = entschluesseln(konto.password_enc);
      const angelegt = await imap.ordnerErstellen(konto, zielordner.trim());
      if (angelegt) loggen('info', 'sortierung', `Neuer Ordner "${zielordner.trim()}" für Konto ${konto.name} via IMAP angelegt.`);
    } catch (err) {
      loggen('warn', 'sortierung', `Konnte Ordner "${zielordner.trim()}" nicht via IMAP anlegen: ${err.message}`);
    }

    // Eine neue Regel gilt auch fuer das, was schon liegt — sonst muesste man
    // den Bestand trotzdem von Hand durchgehen. Abschaltbar per rueckwirkend:false.
    let nachsortiert = { treffer: 0, verschoben: 0, fehler: [] };
    if (req.body?.rueckwirkend !== false) {
      try {
        nachsortiert = await sortierung.bestandAnwenden(konto, {
          typ, muster: muster.trim().toLowerCase(), zielordner: zielordner.trim(),
        });
      } catch (err) {
        loggen('warn', 'sortierung', `Bestand konnte nicht nachsortiert werden: ${err.message}`);
      }
    }

    res.json({ id: info.lastInsertRowid, status: 'ok', nachsortiert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sortierung/regeln/:id — Regel loeschen
router.delete('/regeln/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM sort_rules WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ error: 'Regel nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SORTIER-INBOX ───────────────────────────────────────────────────────────

// GET /api/sortierung/inbox — Offene Mails aus der Inbox
router.get('/inbox', (req, res) => {
  try {
    // Hole alle offene Mails, sowie Kontonamen für die Dropdowns
    const inbox = db.prepare(`
      SELECT i.*, a.id AS account_id, a.name AS account_name
      FROM sort_inbox i
      LEFT JOIN accounts a ON a.id = i.konto_id OR a.name = i.konto
      WHERE i.status = 'offen'
      ORDER BY i.created_at DESC
    `).all();
    res.json(inbox);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/zuordnen — Mail aus Inbox einem Ordner zuweisen
router.post('/zuordnen', async (req, res) => {
  const { id, zielordner, regelAnlegen } = req.body || {};
  if (!id || !zielordner) return res.status(400).json({ error: 'ID und Zielordner fehlen.' });
  
  try {
    const mail = db.prepare('SELECT * FROM sort_inbox WHERE id = ?').get(id);
    if (!mail) throw new Error('Mail nicht gefunden.');

    db.transaction(() => {
      // In der Inbox als zugeordnet markieren (Wird nicht gelöscht, für spätere Analyse/Logs)
      db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?").run(zielordner, id);

      // Regel anlegen? regelAnlegen ist entweder true (= Absender, wie frueher)
      // oder 'absender' / 'domain'.
      if (regelAnlegen && mail.konto_id) {
        const typ = regelAnlegen === 'domain' ? 'domain' : 'absender';
        const muster = typ === 'domain'
          ? sortierung.domain(mail.von)
          : sortierung.adresse(mail.von);

        if (muster) {
          const exists = db.prepare(
            'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?',
          ).get(mail.konto_id, typ, muster);
          if (!exists) {
            db.prepare(`
              INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
              VALUES (?, ?, ?, ?, ?)
            `).run(mail.konto_id, typ, muster, zielordner, req.user.id);
          }
        }
      }
    })();

    if (mail.konto_id) {
      try {
        const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(mail.konto_id);
        if (konto) {
          konto.passwort = entschluesseln(konto.password_enc);
          const angelegt = await imap.ordnerErstellen(konto, zielordner.trim());
          if (angelegt) loggen('info', 'sortierung', `Neuer Ordner "${zielordner.trim()}" für Konto ${konto.name} via IMAP angelegt.`);
        }
      } catch (err) {
        loggen('warn', 'sortierung', `Konnte Ordner "${zielordner.trim()}" nicht anlegen: ${err.message}`);
      }
    }

    loggen('info', 'sortierung', `Mail ${mail.uid} (Konto ${mail.konto}) soll in Ordner ${zielordner} verschoben werden.`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/ignorieren — Mail aus Inbox entfernen ohne Regel
router.post('/ignorieren', (req, res) => {
  try {
    db.prepare("UPDATE sort_inbox SET status = 'ignoriert' WHERE id = ?").run(Number(req.body.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REGELN ZUSAMMENFASSEN ───────────────────────────────────────────────────
//
// Wer eine Weile von Hand sortiert hat, sammelt Einzelregeln fuer denselben
// Dienst an: noreply-accounts@google.com, googleplay-noreply@google.com,
// googleone-noreply@google.com … Alle mit demselben Ziel, alle ersetzbar durch
// eine Regel fuer die Domain — die zusaetzlich jede kuenftige Adresse abdeckt.

/** Gruppen von mindestens zwei Absender-Regeln mit gleicher Domain und gleichem Ziel. */
function zusammenfassbar(kontoId) {
  const regeln = db.prepare(
    "SELECT id, typ, muster, zielordner, treffer FROM sort_rules WHERE konto_id = ? AND typ = 'absender'",
  ).all(kontoId);
  const domainRegeln = new Set(
    db.prepare("SELECT muster FROM sort_rules WHERE konto_id = ? AND typ = 'domain'")
      .all(kontoId).map((r) => r.muster),
  );

  const gruppen = new Map();
  for (const r of regeln) {
    const dom = sortierung.domain(r.muster);
    if (!dom || domainRegeln.has(dom)) continue;
    const schluessel = `${dom}|${r.zielordner}`;
    if (!gruppen.has(schluessel)) gruppen.set(schluessel, { domain: dom, zielordner: r.zielordner, regeln: [] });
    gruppen.get(schluessel).regeln.push(r);
  }
  return [...gruppen.values()].filter((g) => g.regeln.length >= 2);
}

// GET /api/sortierung/regeln/zusammenfassbar?konto_id=1
router.get('/regeln/zusammenfassbar', (req, res) => {
  const konto_id = Number(req.query.konto_id);
  if (!konto_id) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    res.json(zusammenfassbar(konto_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/regeln/zusammenfassen  { konto_id, domain, zielordner }
// Legt die Domain-Regel an und raeumt die ersetzten Einzelregeln weg.
router.post('/regeln/zusammenfassen', async (req, res) => {
  const { konto_id, domain, zielordner } = req.body || {};
  const konto = kontoLaden(konto_id);
  if (!konto || !domain || !zielordner) {
    return res.status(400).json({ error: 'konto_id, domain und zielordner sind Pflicht.' });
  }
  const gruppe = zusammenfassbar(konto.id)
    .find((g) => g.domain === String(domain).toLowerCase() && g.zielordner === zielordner);
  if (!gruppe) return res.status(404).json({ error: 'Dazu gibt es nichts zusammenzufassen.' });

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO sort_rules (konto_id, typ, muster, zielordner, treffer, erstellt_von)
        VALUES (?, 'domain', ?, ?, ?, ?)
      `).run(
        konto.id, gruppe.domain, gruppe.zielordner,
        gruppe.regeln.reduce((s, r) => s + (r.treffer || 0), 0),
        req.user.id,
      );
      const weg = db.prepare('DELETE FROM sort_rules WHERE id = ?');
      for (const r of gruppe.regeln) weg.run(r.id);
    })();

    // Die neue Regel ist weiter gefasst als die alten — was jetzt passt, gleich mitnehmen
    const nachsortiert = await sortierung.bestandAnwenden(konto, {
      typ: 'domain', muster: gruppe.domain, zielordner: gruppe.zielordner,
    });
    loggen('info', 'sortierung',
      `${gruppe.regeln.length} Einzelregeln zu einer Domain-Regel für @${gruppe.domain} zusammengefasst.`);
    res.json({ ok: true, ersetzt: gruppe.regeln.length, domain: gruppe.domain, nachsortiert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BESTAND: ÄHNLICHE MAILS GLEICH MITSORTIEREN ─────────────────────────────
//
// Der eigentliche Zeitfresser war nicht das Sortieren, sondern das Einzeln-
// Anfassen: 20 Mails von @accounts.google.com bedeuteten 20 Klicks. Hier kommt
// deshalb alles zusammen — Regel anlegen, Ordner sicherstellen und die schon
// wartenden Mails in einem Rutsch nachziehen.

const kontoLaden = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));

// POST /api/sortierung/sammel-zuordnen
// { konto_id, typ: 'absender'|'domain'|'betreff', muster, zielordner, regelMerken }
router.post('/sammel-zuordnen', async (req, res) => {
  const { konto_id, typ, muster, zielordner, regelMerken = true } = req.body || {};
  if (!konto_id || !typ || !muster || !zielordner) {
    return res.status(400).json({ error: 'konto_id, typ, muster und zielordner sind Pflicht.' });
  }
  if (!['absender', 'domain', 'betreff'].includes(typ)) {
    return res.status(400).json({ error: 'Ungültiger Typ.' });
  }
  const konto = kontoLaden(konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });

  const regel = { typ, muster: String(muster).trim().toLowerCase(), zielordner: String(zielordner).trim() };

  try {
    // 1. Zielordner sicherstellen — ohne ihn scheitert jedes Verschieben
    try {
      const neu = await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, regel.zielordner);
      if (neu) loggen('info', 'sortierung', `Ordner "${regel.zielordner}" für ${konto.name} angelegt.`);
    } catch (err) {
      return res.status(502).json({ error: `Zielordner nicht nutzbar: ${err.message}` });
    }

    // 2. Regel merken, damit künftige Mails gar nicht erst hier landen
    let regelId = null;
    if (regelMerken) {
      const schonDa = db.prepare(
        'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?',
      ).get(konto.id, regel.typ, regel.muster);
      if (schonDa) regelId = schonDa.id;
      else {
        regelId = db.prepare(`
          INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
          VALUES (?, ?, ?, ?, ?)
        `).run(konto.id, regel.typ, regel.muster, regel.zielordner, req.user.id).lastInsertRowid;
      }
    }

    // 3. Alles nachziehen, was schon wartet
    const ergebnis = await sortierung.bestandAnwenden(konto, regel);
    themen.cacheVerwerfen(konto.id);

    res.json({ ok: true, regel_id: regelId, ...ergebnis });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/sortierung/vorschau?konto_id=1&typ=domain&muster=google.com
// Wie viele wartende Mails würde diese Regel erfassen? Für die Anzeige „… und
// 19 weitere", bevor der Nutzer den Knopf drückt.
router.get('/vorschau', async (req, res) => {
  const { konto_id, typ, muster } = req.query;
  const konto = kontoLaden(konto_id);
  if (!konto || !typ || !muster) return res.status(400).json({ error: 'konto_id, typ und muster fehlen.' });
  try {
    const { treffer } = await sortierung.bestandAnwenden(
      konto, { typ, muster: String(muster).toLowerCase(), zielordner: '' }, { nurZaehlen: true },
    );
    res.json({ treffer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── THEMEN-KATALOG ──────────────────────────────────────────────────────────
// Die Ordner, in die die KI einsortieren darf. Was hier nicht steht, waehlt sie
// auch nicht aus — der Katalog ist die Leine.

const kontoHolen = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));

// GET /api/sortierung/katalog?konto_id=1
router.get('/katalog', (req, res) => {
  const konto_id = Number(req.query.konto_id);
  if (!konto_id) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    res.json(themen.katalog(konto_id, { auchGesperrte: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/katalog — Ordner von Hand aufnehmen (und anlegen, falls er fehlt)
router.post('/katalog', async (req, res) => {
  const { konto_id, ordner, beschreibung } = req.body || {};
  const konto = kontoHolen(konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });

  const name = themen.ordnerNormalisieren(ordner, konto);
  if (!name) {
    return res.status(400).json({
      error: 'Ungültiger Ordnername. Erlaubt sind 2–40 Zeichen aus Buchstaben, Zahlen, Leerzeichen, - und _; System- und Kategorieordner sind gesperrt.',
    });
  }
  try {
    const pfad = await themen.ordnerAnlegen(konto, name);
    const eintrag = themen.inKatalog(konto.id, pfad, 'manuell', beschreibung || null);
    loggen('info', 'sortierung', `Themen-Ordner "${pfad}" für Konto ${konto.name} aufgenommen.`);
    res.json({ ok: true, eintrag });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// PUT /api/sortierung/katalog/:id — Beschreibung pflegen, sperren/entsperren
router.put('/katalog/:id', (req, res) => {
  const { beschreibung, gesperrt } = req.body || {};
  try {
    const info = db.prepare(`
      UPDATE konto_ordner
      SET beschreibung = COALESCE(?, beschreibung),
          gesperrt = COALESCE(?, gesperrt)
      WHERE id = ?
    `).run(
      beschreibung !== undefined ? String(beschreibung).slice(0, 200) : null,
      gesperrt !== undefined ? (gesperrt ? 1 : 0) : null,
      Number(req.params.id),
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sortierung/katalog/:id — nur aus dem Katalog nehmen.
// Der Ordner im Postfach bleibt stehen: Es wird nie gelöscht, nur verschoben.
router.delete('/katalog/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM konto_ordner WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    res.json({ ok: true, hinweis: 'Aus dem Katalog entfernt. Der Ordner im Postfach bleibt bestehen.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/katalog/einlesen — vorhandene Ordner aus dem Postfach übernehmen
router.post('/katalog/einlesen', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  try {
    res.json(await themen.ausPostfachEinlesen(konto));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── ORDNER-VORSCHLÄGE DER KI ────────────────────────────────────────────────
// Steht "Neue Ordner" auf *Freigabe*, landen die Wünsche der KI hier, statt
// sofort im Postfach zu erscheinen.

// GET /api/sortierung/vorschlaege — offene Vorschläge samt wartender Mails
router.get('/vorschlaege', (req, res) => {
  try {
    res.json(db.prepare(`
      SELECT v.*, a.name AS konto_name,
             (SELECT COUNT(*) FROM sort_inbox i
               WHERE i.konto_id = v.konto_id AND i.status = 'offen' AND i.ki_ordner = v.ordner) AS wartend
      FROM ordner_vorschlaege v
      LEFT JOIN accounts a ON a.id = v.konto_id
      WHERE v.status = 'offen'
      ORDER BY v.anzahl DESC, v.created_at DESC
    `).all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/vorschlaege/:id/freigeben
// Legt den Ordner an, nimmt ihn in den Katalog und sortiert die Mails nach, die
// währenddessen im Posteingang liegen geblieben sind.
router.post('/vorschlaege/:id/freigeben', async (req, res) => {
  const vorschlag = db.prepare('SELECT * FROM ordner_vorschlaege WHERE id = ?').get(Number(req.params.id));
  if (!vorschlag) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
  const konto = kontoHolen(vorschlag.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht mehr.' });

  // Der Name wurde beim Vorschlagen schon geprüft — vor dem Anlegen trotzdem
  // noch einmal, denn zwischenzeitlich kann sich die Konto-Konfiguration ändern.
  const name = themen.ordnerNormalisieren(vorschlag.ordner, konto);
  if (!name) return res.status(400).json({ error: 'Der Ordnername ist nicht (mehr) zulässig.' });

  try {
    const pfad = await themen.ordnerAnlegen(konto, name);
    themen.inKatalog(konto.id, pfad, 'ki', vorschlag.begruendung);
    db.prepare("UPDATE ordner_vorschlaege SET status = 'freigegeben' WHERE id = ?").run(vorschlag.id);

    // Wartende Mails nachsortieren. Schlägt eine fehl (Mail schon weg, UID alt),
    // laufen die übrigen weiter — deshalb je Mail ein eigener try.
    const wartend = db.prepare(`
      SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?
    `).all(konto.id, vorschlag.ordner);
    const zugang = themen.zugang(konto);
    let verschoben = 0;
    for (const mail of wartend) {
      if (!mail.uid) continue;
      try {
        await imap.mailVerschieben({ ...zugang, uid: mail.uid, von: 'INBOX', nach: pfad });
        db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?").run(pfad, mail.id);
        verschoben++;
      } catch (err) {
        loggen('warn', 'sortierung', `Mail ${mail.uid} konnte nicht nach "${pfad}" verschoben werden: ${err.message}`);
      }
    }
    loggen('info', 'sortierung', `Ordner "${pfad}" freigegeben, ${verschoben} wartende Mail(s) nachsortiert.`);
    res.json({ ok: true, ordner: pfad, verschoben, wartend: wartend.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/sortierung/vorschlaege/:id/ablehnen — kommt nicht wieder
router.post('/vorschlaege/:id/ablehnen', (req, res) => {
  try {
    const info = db.prepare("UPDATE ordner_vorschlaege SET status = 'abgelehnt' WHERE id = ?")
      .run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
