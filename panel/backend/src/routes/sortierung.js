// Routen fuer die Ordner-Sortierung (Regeln verwalten, Inbox abarbeiten)
// Nur mit Recht "sortierung" zugaenglich.
const express = require('express');
const db      = require('../db');
const { loggen } = require('../services/panelLog');
const imap = require('../services/imap');
const bestand = require('../services/bestand');
const themen = require('../services/themen');
const sortierung = require('../services/sortierung');
const belegLeser = require('../services/belegLeser');
const settings = require('../services/settings');
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
  // "In Ruhe lassen": eine Regel ganz ohne Zielordner — die Mail bleibt
  // unangetastet liegen und wird auch nicht mehr zur Zuordnung vorgelegt.
  const aktion = req.body?.aktion === 'behalten' ? 'behalten' : 'verschieben';
  const ziel = aktion === 'behalten' ? '' : String(zielordner || '').trim();
  if (!konto_id || !typ || !muster || (aktion === 'verschieben' && !ziel)) {
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
      INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion, erstellt_von)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(konto_id, typ, muster.trim(), ziel, aktion, req.user.id);

    // "In Ruhe lassen": nichts anlegen, nichts verschieben. Was schon in der
    // Sortier-Inbox liegt und dazu passt, verschwindet aus der Liste — genau
    // darum geht es bei dieser Regel.
    if (aktion === 'behalten') {
      let beruhigt = 0;
      try {
        const offen = db.prepare("SELECT id, von, betreff FROM sort_inbox WHERE konto_id = ? AND status = 'offen'").all(konto_id);
        const setzen = db.prepare("UPDATE sort_inbox SET status = 'ignoriert' WHERE id = ?");
        for (const m of offen) {
          if (!sortierung.passt({ typ, muster }, m.von, m.betreff)) continue;
          setzen.run(m.id);
          beruhigt++;
        }
      } catch (err) {
        loggen('warn', 'sortierung', `Sortier-Inbox konnte nicht bereinigt werden: ${err.message}`);
      }
      loggen('info', 'sortierung', `Ruhe-Regel [${typ}] ${muster.trim()} für ${konto.name} angelegt (${beruhigt} Einträge entfernt).`);
      return res.json({ id: info.lastInsertRowid, status: 'ok', aktion, beruhigt });
    }

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
    const alt = db.prepare('SELECT konto_id, aktion FROM sort_rules WHERE id = ?').get(Number(req.params.id));
    const info = db.prepare('DELETE FROM sort_rules WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ error: 'Regel nicht gefunden.' });
    // War es eine "In Ruhe lassen"-Regel, wurden Mails ihretwegen dauerhaft
    // uebersprungen. Ohne die Regel sollen sie wieder zur Sortierung anstehen.
    if (alt && (alt.aktion || 'verschieben') === 'behalten') bestand.ruheVergessen(alt.konto_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SORTIER-INBOX ───────────────────────────────────────────────────────────

// GET /api/sortierung/inbox — Offene Mails aus der Inbox
// Wann wurde zuletzt mit dem Postfach abgeglichen? Ohne Drosselung machte jeder
// Klick auf "Aktualisieren" eine neue IMAP-Verbindung auf — und Mailserver
// begrenzen die (Dovecot standardmaessig auf zehn je Adresse).
const abgleichZuletzt = new Map();
const ABGLEICH_PAUSE = 60 * 1000;

async function inboxAbgleichen() {
  const konten = db.prepare(`
    SELECT DISTINCT a.* FROM accounts a
    JOIN sort_inbox i ON i.konto_id = a.id
    WHERE i.status = 'offen'
  `).all();
  for (const konto of konten) {
    const zuletzt = abgleichZuletzt.get(konto.id) || 0;
    if (Date.now() - zuletzt < ABGLEICH_PAUSE) continue;
    abgleichZuletzt.set(konto.id, Date.now());
    try {
      await sortierung.abgleichen(konto);
    } catch (err) {
      // Ist das Postfach gerade nicht erreichbar, wird die Liste eben ungeprueft
      // angezeigt — das ist besser als eine Fehlermeldung statt der Liste.
      loggen('warn', 'sortierung', `Abgleich mit ${konto.name} nicht moeglich: ${err.message}`);
    }
  }
}

router.get('/inbox', async (req, res) => {
  try {
    // Erst mit dem Postfach abgleichen: Eintraege zu Mails, die den Posteingang
    // laengst verlassen haben, gehoeren nicht in die Liste. Sie liessen sich nie
    // verschieben und tauchten trotzdem bei jedem Laden wieder auf.
    await inboxAbgleichen();
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

// ─── LETZTE ENTSCHEIDUNGEN UND KORREKTUR ─────────────────────────────────────
//
// Bisher sah man eine Fehlentscheidung, korrigierte sie von Hand im
// Mailprogramm — und die KI traf sie beim naechsten Mal genauso. Hier wird
// daraus eine Rueckmeldung: Die Mail zieht um, und aus der Korrektur entsteht
// eine Regel, die kuenftig vor der KI greift.

// GET /api/sortierung/entscheidungen?konto_id=1&limit=30
router.get('/entscheidungen', (req, res) => {
  const konto = kontoLaden(req.query.konto_id);
  if (!konto) return res.status(400).json({ error: 'konto_id fehlt oder unbekannt.' });
  const anzahl = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  try {
    res.json(db.prepare(`
      SELECT id, von, betreff, kategorie, thema, konfidenz, zielordner, kurzfassung,
             uid, korrigiert_zu, created_at
      FROM quarantine_log
      WHERE konto = ? AND zielordner IS NOT NULL
      ORDER BY id DESC LIMIT ?
    `).all(konto.name, anzahl));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/korrigieren
// { log_id, zielordner, regelTyp: 'domain'|'absender'|'keine' }
router.post('/korrigieren', async (req, res) => {
  const { log_id, zielordner, regelTyp = 'domain' } = req.body || {};
  if (!log_id || !zielordner) return res.status(400).json({ error: 'log_id und zielordner sind Pflicht.' });

  const eintrag = db.prepare('SELECT * FROM quarantine_log WHERE id = ?').get(Number(log_id));
  if (!eintrag) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
  const konto = db.prepare('SELECT * FROM accounts WHERE name = ?').get(eintrag.konto);
  if (!konto) return res.status(400).json({ error: `Konto "${eintrag.konto}" existiert nicht mehr.` });

  const ziel = String(zielordner).trim();
  if (ziel === eintrag.zielordner) {
    return res.status(400).json({ error: 'Das ist der Ordner, in dem die Mail schon liegt.' });
  }

  try {
    // 1. Zielordner sicherstellen
    try {
      const neu = await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, ziel);
      if (neu) loggen('info', 'sortierung', `Ordner "${ziel}" für ${konto.name} angelegt (Korrektur).`);
    } catch (err) {
      return res.status(502).json({ error: `Zielordner nicht nutzbar: ${err.message}` });
    }

    // 2. Die Mail selbst umziehen.
    //
    // Nicht ueber die gespeicherte UID: Die stammt aus dem Posteingang, und IMAP
    // vergibt UIDs je Ordner. Im Zielordner zeigt sie ins Leere — oder auf eine
    // ganz andere Nachricht, die dann faelschlich verschoben wuerde. Deshalb
    // wird die Mail dort ueber Absender und Betreff gesucht.
    let verschoben = false;
    let hinweis = null;
    try {
      const zugang = themen.zugang(konto);
      const treffer = await imap.mailsSuchen({
        ...zugang,
        ordner: eintrag.zielordner,
        von: sortierung.adresse(eintrag.von),
        betreff: eintrag.betreff || undefined,
      });

      if (treffer.length === 0) {
        hinweis = `In "${eintrag.zielordner}" war diese Mail nicht mehr zu finden — `
          + 'vermutlich schon von Hand verschoben oder gelöscht. Die Regel gilt trotzdem.';
      } else {
        // Bei mehreren Treffern die juengste nehmen: Wiederkehrende Newsletter
        // haben denselben Betreff, gemeint ist die zuletzt einsortierte.
        const uid = Math.max(...treffer);
        await imap.mailVerschieben({ ...zugang, uid, von: eintrag.zielordner, nach: ziel });
        verschoben = true;
        if (treffer.length > 1) {
          hinweis = `${treffer.length} Mails passten zu Absender und Betreff — verschoben wurde die neueste.`;
        }
      }
    } catch (err) {
      hinweis = `Die Mail selbst ließ sich nicht verschieben (${err.message}). Die Regel wurde angelegt.`;
      loggen('warn', 'sortierung', `Korrektur: ${hinweis}`);
    }

    // 3. Aus der Korrektur lernen
    let regel = null;
    if (regelTyp !== 'keine') {
      const typ = regelTyp === 'absender' ? 'absender' : 'domain';
      const muster = typ === 'domain' ? sortierung.domain(eintrag.von) : sortierung.adresse(eintrag.von);
      if (muster) {
        const vorhanden = db.prepare(
          'SELECT id, zielordner FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?',
        ).get(konto.id, typ, muster);
        if (vorhanden) {
          // Eine bestehende Regel zeigte auf den falschen Ordner — die wird umgebogen,
          // sonst korrigiert man dieselbe Mail immer wieder.
          db.prepare('UPDATE sort_rules SET zielordner = ? WHERE id = ?').run(ziel, vorhanden.id);
          regel = { typ, muster, zielordner: ziel, aktualisiert: true };
        } else {
          db.prepare(`
            INSERT INTO sort_rules (konto_id, typ, muster, zielordner, erstellt_von)
            VALUES (?, ?, ?, ?, ?)
          `).run(konto.id, typ, muster, ziel, req.user.id);
          regel = { typ, muster, zielordner: ziel, aktualisiert: false };
        }
      }
    }

    // 4. Was noch wartet und dazu passt, gleich mitnehmen
    let nachsortiert = { treffer: 0, verschoben: 0, fehler: [] };
    if (regel) {
      try {
        nachsortiert = await sortierung.bestandAnwenden(konto, regel);
      } catch (err) {
        loggen('warn', 'sortierung', `Nachsortieren nach Korrektur fehlgeschlagen: ${err.message}`);
      }
    }

    db.prepare('UPDATE quarantine_log SET korrigiert_zu = ? WHERE id = ?').run(ziel, eintrag.id);
    themen.cacheVerwerfen(konto.id);
    loggen('info', 'sortierung',
      `Korrektur: ${eintrag.von} von "${eintrag.zielordner}" nach "${ziel}"`
      + (regel ? ` — Regel [${regel.typ}] ${regel.muster}` : ' — ohne Regel'));

    res.json({ ok: true, verschoben, hinweis, regel, nachsortiert });
  } catch (err) {
    res.status(502).json({ error: err.message });
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
      error: 'Ungültiger Ordnername. Erlaubt sind 2–40 Zeichen aus Buchstaben, Zahlen, Leerzeichen und - _ & + ( ); Pfadtrenner, System- und Kategorieordner sind gesperrt.',
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
    const ergebnis = await themen.ausPostfachEinlesen(konto);
    // Systemordner, die vor v2.8.4.0 in den Katalog gerutscht sind, dabei
    // gleich stilllegen — sonst bliebe "[Gmail]/Alle Nachrichten" ein
    // moegliches Ziel, obwohl es nur eine Ansicht ist.
    const gesperrt = await themen.systemordnerSperren(konto);
    res.json({ ...ergebnis, gesperrt });
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
    // Vorher zusammenfassen, was dasselbe meint („Games" und „Gaming"). Das hier
    // ist der Ort dafür: Was sich vor dieser Änderung angesammelt hat, soll sich
    // nicht erst nach und nach auflösen, sondern beim ersten Blick auf die Liste.
    themen.vorschlaegeAufraeumen();
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

    // Wartende Mails nachsortieren. Schlägt eine fehl (Mail schon weg, UID alt),
    // laufen die übrigen weiter — deshalb je Mail ein eigener try.
    const wartend = db.prepare(`
      SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?
    `).all(konto.id, vorschlag.ordner);

    // Die Beschreibung ist kein Notizzettel, sondern Arbeitsmaterial: Sie geht
    // wörtlich in den Prompt, und seit Build 93 wertet das Panel ihre Stichworte
    // selbst aus. Bis hierher stand dort die interne Notiz „Zuletzt vorgeschlagen
    // für: …" — im Prompt nutzlos und als Stichwort sogar schädlich („zuletzt",
    // „vorgeschlagen"). Sinnvoll sind die Absender, für die der Ordner gedacht
    // ist: Damit sortiert er ab sofort ohne KI.
    const domains = [...new Set(wartend.map((m) => sortierung.domain(m.von)).filter(Boolean))];
    themen.inKatalog(konto.id, pfad, 'ki', domains.slice(0, 5).join(', ') || null);
    db.prepare("UPDATE ordner_vorschlaege SET status = 'freigegeben' WHERE id = ?").run(vorschlag.id);

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

// GET /api/sortierung/vorschlaege/:id/mails — die Mails, die diesen Vorschlag
// ausgelöst haben und im Posteingang darauf warten, dass er entschieden wird.
// Ohne diese Liste musste man einem Ordnernamen blind glauben.
router.get('/vorschlaege/:id/mails', (req, res) => {
  try {
    const v = db.prepare('SELECT * FROM ordner_vorschlaege WHERE id = ?').get(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    const mails = db.prepare(`
      SELECT id, von, betreff, uid, ki_konfidenz, ki_grund, created_at
      FROM sort_inbox
      WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?
      ORDER BY created_at DESC LIMIT 100
    `).all(v.konto_id, v.ordner);
    res.json({ ordner: v.ordner, konto_id: v.konto_id, mails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/vorschlaege/:id/umleiten — { ordner }
//
// „Kein neuer Ordner — das gehört nach X." Verschiebt die wartenden Mails in
// einen Ordner, den es schon gibt, und merkt sich den Namen: Schlägt die KI ihn
// wieder vor, landet die Mail künftig direkt dort. Vorher blieb nur Ablehnen,
// und die nächste Mail derselben Art stand wieder unsortiert im Posteingang.
router.post('/vorschlaege/:id/umleiten', async (req, res) => {
  const ziel = String(req.body?.ordner || '').trim();
  if (!ziel) return res.status(400).json({ error: 'Kein Zielordner angegeben.' });

  const vorschlag = db.prepare('SELECT * FROM ordner_vorschlaege WHERE id = ?').get(Number(req.params.id));
  if (!vorschlag) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
  const konto = kontoHolen(vorschlag.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht mehr.' });

  try {
    if (!(await themen.ordnerExistiert(konto, ziel))) {
      return res.status(400).json({ error: `Den Ordner "${ziel}" gibt es im Postfach nicht.` });
    }

    const wartend = db.prepare(
      "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?",
    ).all(konto.id, vorschlag.ordner);
    const zugang = themen.zugang(konto);
    let verschoben = 0;
    for (const mail of wartend) {
      if (!mail.uid) continue;
      try {
        await imap.mailVerschieben({ ...zugang, uid: mail.uid, von: 'INBOX', nach: ziel });
        db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?")
          .run(ziel, mail.id);
        verschoben += 1;
      } catch (err) {
        loggen('warn', 'sortierung', `Mail ${mail.uid} konnte nicht nach "${ziel}" verschoben werden: ${err.message}`);
      }
    }

    themen.aliasMerken(konto.id, vorschlag.ordner, ziel);
    db.prepare("UPDATE ordner_vorschlaege SET status = 'abgelehnt', begruendung = ? WHERE id = ?")
      .run(`Umgeleitet nach "${ziel}"`, vorschlag.id);

    loggen('info', 'sortierung',
      `Vorschlag "${vorschlag.ordner}" nach "${ziel}" umgeleitet, ${verschoben} Mail(s) verschoben.`);
    res.json({ ok: true, ordner: ziel, verschoben, wartend: wartend.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/sortierung/stichworte-anwenden — { konto_id, vorschau }
//
// Wendet die Stichworte aus den Ordner-Beschreibungen rückwirkend auf die Mails
// an, die schon in der Sortier-Inbox liegen. Nötig, weil die Beschreibung bis
// Build 92 nur im Prompt stand: Alles, was die KI damals nicht zuordnen konnte,
// wartet noch — obwohl das passende Stichwort längst hinterlegt ist.
router.post('/stichworte-anwenden', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });
  try {
    res.json(await sortierung.stichworteNachtragen(konto, { vorschau: Boolean(req.body?.vorschau) }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/sortierung/alias?konto_id= — welche Namen auf welchen Ordner zeigen
router.get('/alias', (req, res) => {
  const kontoId = Number(req.query.konto_id);
  if (!kontoId) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    res.json(themen.aliasListe(kontoId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sortierung/alias/:id — Umleitung wieder lösen
router.delete('/alias/:id', (req, res) => {
  try {
    if (!themen.aliasVergessen(req.params.id)) {
      return res.status(404).json({ error: 'Umleitung nicht gefunden.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// GET /api/sortierung/belege — Zustand der Beleg-Ablage für die Sortierung-Karte:
// ist die Automatik an, wie viele Belege heute gelesen/übersprungen wurden, und
// die letzten Entscheidungen. So sieht man, was das Qualitäts-Gate herausgefiltert hat.
router.get('/belege', (req, res) => {
  try {
    const preset = db.prepare("SELECT aktiv, konfig FROM aktionen WHERE schluessel = 'belege_auto'").get();
    let auslesen = false;
    try { auslesen = Boolean(JSON.parse(preset?.konfig || '{}').auslesen); } catch { /* egal */ }

    const zahl = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    const heuteWo = "created_at >= date('now','localtime')";
    const woche = "created_at >= datetime('now','-7 days')";
    const grenze = belegLeser.tagesbudget();
    const heuteGelesen = belegLeser.heuteGelesen();

    const nextcloudBereit = Boolean(settings.hole('nextcloud_url') && settings.hole('nextcloud_user') && settings.hole('nextcloud_passwort'));

    const letzte = db.prepare(`
      SELECT von, betreff, firma, aktenzeichen, dokumenttyp, gespeichert, dateiname, quelle, created_at
      FROM beleg_ablage ORDER BY id DESC LIMIT 25
    `).all().map((r) => ({ ...r, gespeichert: Boolean(r.gespeichert) }));

    res.json({
      automatik: { an: Boolean(preset?.aktiv), auslesen, eingerichtet: Boolean(preset) },
      nextcloud_bereit: nextcloudBereit,
      lesen: {
        grenze,                                   // 0 = kein Deckel
        heute: heuteGelesen,
        rest: grenze ? Math.max(0, grenze - heuteGelesen) : null,
        ausgeschoepft: grenze ? heuteGelesen >= grenze : false,
        abgelegtHeute: zahl(`SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 1 AND ${heuteWo}`),
        uebersprungenHeute: zahl(`SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 0 AND ${heuteWo}`),
        abgelegt7: zahl(`SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 1 AND ${woche}`),
        uebersprungen7: zahl(`SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 0 AND ${woche}`),
      },
      letzte,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
