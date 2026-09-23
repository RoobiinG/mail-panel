// Routen fuer die Ordner-Sortierung (Regeln verwalten, Inbox abarbeiten)
// Nur mit Recht "sortierung" zugaenglich.
const express = require('express');
const db      = require('../db');
const { loggen } = require('../services/panelLog');
const imap = require('../services/imap');
const bestand = require('../services/bestand');
const kiText = require('../services/kiText');
const themen = require('../services/themen');
const sortierung = require('../services/sortierung');
const nachsortierung = require('../services/nachsortierung');
const entscheidungen = require('../services/entscheidungen');
const belegLeser = require('../services/belegLeser');
const settings = require('../services/settings');
const uebersicht = require('../services/uebersicht');
// Zugangsdaten kommen über themen.zugang() (Passwort UND tlsUnsicher) — siehe dort.

const router = express.Router();

// Für LIKE: Prozent, Unterstrich und der Escape selbst dürfen nicht als
// Platzhalter wirken. Ohne das findet die Suche nach "_" jede Regel.
const likeSicher = (text) => String(text).replace(/[\\%_]/g, (z) => `\\${z}`);

// Wie viele Regeln ohne ausdrückliche Angabe zurückkommen.
//
// Aus 136 Regeln wurden binnen einer Woche 159, fast alle gelernt. Die Liste
// vollständig auszuliefern und im Browser zu filtern hätte eine Weile noch
// funktioniert — aber die Frage, die man vor dieser Liste hat, lautet nie „zeig
// mir alle", sondern „was ist für diesen Absender hinterlegt?".
const REGELN_PRO_SEITE = 200;

// Ein Sammelbecken für alles, was keine Domain hat: Betreff-Regeln und
// Absender-Bruchstücke wie "rechnung@". Steht immer zuletzt.
const OHNE_DOMAIN = '(ohne Domain)';

/**
 * Regeln nach Absender-Domain bündeln.
 *
 * Eine flache Liste aus 159 Zeilen beantwortet die Frage nicht, die man vor ihr
 * hat: Was ist für DIESEN Dienst hinterlegt? Erst nebeneinander sieht man, dass
 * ein Anbieter mit vier Adressen in drei verschiedene Ordner sortiert wird —
 * und das ist meistens keine Absicht, sondern ein Fehler, der sich über Wochen
 * angesammelt hat.
 *
 * Deshalb trägt jede Gruppe ihre verschiedenen Zielordner im Kopf: Das ist der
 * Befund, wegen dem man hier hinsieht.
 */
function nachDomain(regeln) {
  const gruppen = new Map();
  for (const r of regeln) {
    const dom = r.typ === 'domain'
      ? String(r.muster || '').toLowerCase().replace(/^@/, '')
      : sortierung.domain(r.muster);
    const schluessel = dom || OHNE_DOMAIN;
    if (!gruppen.has(schluessel)) {
      gruppen.set(schluessel, { domain: schluessel, anzahl: 0, treffer: 0, ziele: [], regeln: [] });
    }
    const g = gruppen.get(schluessel);
    g.regeln.push(r);
    g.anzahl += 1;
    g.treffer += r.treffer || 0;
    const ziel = (r.aktion || 'verschieben') === 'behalten' ? '(in Ruhe lassen)' : r.zielordner;
    if (ziel && !g.ziele.includes(ziel)) g.ziele.push(ziel);
  }

  for (const g of gruppen.values()) {
    // Innerhalb der Gruppe in der Reihenfolge, in der die Regeln auch gelten —
    // sonst liest man oben eine Regel, die unten längst überstimmt wird.
    g.regeln.sort((a, b) => {
      const bedingung = (r) => (String(r.betreff_muster || '').trim() ? 0 : 1);
      const rang = (r) => (r.typ === 'absender' ? 0 : (r.typ === 'domain' ? 1 : 2));
      return bedingung(a) - bedingung(b) || rang(a) - rang(b) || (b.treffer || 0) - (a.treffer || 0);
    });
  }

  return [...gruppen.values()].sort((a, b) => {
    if (a.domain === OHNE_DOMAIN) return 1;
    if (b.domain === OHNE_DOMAIN) return -1;
    return b.treffer - a.treffer || a.domain.localeCompare(b.domain, 'de');
  });
}

// GET /api/sortierung/regeln?konto_id=1&suche=otto&limit=50&offset=0&gruppiert=1
//
// Antwortet mit einem Objekt, nicht mehr mit dem blanken Array: Ohne die Zahl
// der Treffer neben der Seite weiss die Oberflaeche nicht, ob sie alles zeigt.
// Mit `gruppiert=1` kommen statt `regeln` die nach Domain gebuendelten `gruppen`.
router.get('/regeln', (req, res) => {
  const konto_id = Number(req.query.konto_id);
  if (!konto_id) return res.status(400).json({ error: 'konto_id fehlt' });
  const suche = String(req.query.suche || '').trim();
  const gruppiert = String(req.query.gruppiert || '') === '1';
  // Gruppiert wird über das, was auf der Seite steht. Eine Domain, deren Regeln
  // über die Seitengrenze hinausreichen, ergäbe eine unvollständige Gruppe —
  // und die Kopfzeile behauptete dann drei Zielordner, wo es vier sind.
  const standardGrenze = gruppiert ? 1000 : REGELN_PRO_SEITE;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || standardGrenze));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    // Gesucht wird über Muster UND Zielordner: „Wohin geht Otto?" und „Was
    // landet alles in Rechnungen?" sind dieselbe Frage an dieselbe Liste.
    const wo = ['konto_id = ?'];
    const werte = [konto_id];
    if (suche) {
      wo.push("(muster LIKE ? ESCAPE '\\' OR zielordner LIKE ? ESCAPE '\\')");
      werte.push(`%${likeSicher(suche)}%`, `%${likeSicher(suche)}%`);
    }
    const bedingung = wo.join(' AND ');

    const gefiltert = db.prepare(`SELECT COUNT(*) AS n FROM sort_rules WHERE ${bedingung}`)
      .get(...werte).n;
    const gesamt = suche
      ? db.prepare('SELECT COUNT(*) AS n FROM sort_rules WHERE konto_id = ?').get(konto_id).n
      : gefiltert;
    // Treffer zuerst: Eine Regel, die oft greift, ist die, die man sucht — und
    // die, deren Fehler am meisten anrichtet.
    const regeln = db.prepare(
      `SELECT * FROM sort_rules WHERE ${bedingung} ORDER BY treffer DESC, created_at DESC LIMIT ? OFFSET ?`,
    ).all(...werte, limit, offset);

    if (gruppiert) {
      return res.json({ gruppen: nachDomain(regeln), gesamt, gefiltert, offset, limit });
    }
    res.json({ regeln, gesamt, gefiltert, offset, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sortierung/regeln/:id — eine Regel ändern
//
// Bisher gab es nur Anlegen und Löschen. Wer eine gelernte Regel korrigieren
// wollte („der Absender gehört nach Bestellungen, nicht nach Rechnungen"),
// musste sie löschen und neu tippen — und verlor dabei den Trefferzähler, also
// genau die Information, wie viel diese Regel schon bewegt hat.
router.put('/regeln/:id', async (req, res) => {
  const id = Number(req.params.id);
  const alt = db.prepare('SELECT * FROM sort_rules WHERE id = ?').get(id);
  if (!alt) return res.status(404).json({ error: 'Regel nicht gefunden.' });

  const typ = String(req.body?.typ || alt.typ);
  const muster = String(req.body?.muster ?? alt.muster).trim();
  const aktion = req.body?.aktion === 'behalten' ? 'behalten'
    : (req.body?.aktion === 'verschieben' ? 'verschieben' : (alt.aktion || 'verschieben'));
  const ziel = aktion === 'behalten' ? '' : String(req.body?.zielordner ?? alt.zielordner).trim();
  // Ein leerer String ist hier eine Ansage („Bedingung weg"), kein „nicht
  // mitgeschickt" — deshalb ?? und nicht ||.
  const betreffMuster = typ === 'betreff'
    ? '' : String(req.body?.betreff_muster ?? alt.betreff_muster ?? '').trim();
  // Dieselbe Überlegung für den Inhalt: Bei typ='inhalt' steht das Stichwort
  // schon im Muster, eine zusätzliche Inhaltsbedingung wäre doppelt gemoppelt.
  const inhaltMuster = typ === 'inhalt'
    ? '' : String(req.body?.inhalt_muster ?? alt.inhalt_muster ?? '').trim();

  if (!['absender', 'betreff', 'domain', 'inhalt'].includes(typ)) {
    return res.status(400).json({ error: 'Ungültiger Typ.' });
  }
  if (!muster) return res.status(400).json({ error: 'Das Muster darf nicht leer sein.' });
  if (aktion === 'verschieben' && !ziel) {
    return res.status(400).json({ error: 'Ohne Zielordner wüsste die Regel nicht, wohin.' });
  }

  // Zwei Regeln mit derselben Bedingung widersprechen sich zwangsläufig — welche
  // zuerst greift, entscheidet dann die Reihenfolge in der Datenbank. Der
  // Betreff gehört zum Vergleich: Derselbe Absender DARF mehrfach geregelt
  // sein, solange sich die Betreff-Bedingungen unterscheiden.
  const doppelt = db.prepare(
    'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?'
    + " AND IFNULL(betreff_muster, '') = ? AND IFNULL(inhalt_muster, '') = ? AND id != ?",
  ).get(alt.konto_id, typ, muster, betreffMuster, inhaltMuster, id);
  if (doppelt) {
    return res.status(400).json({
      error: betreffMuster || inhaltMuster
        ? `Für dieses Muster mit derselben Zusatzbedingung („${betreffMuster || inhaltMuster}") gibt es bereits eine Regel.`
        : 'Für dieses Muster gibt es bereits eine Regel.',
    });
  }

  try {
    db.prepare(
      'UPDATE sort_rules SET typ = ?, muster = ?, zielordner = ?, aktion = ?, betreff_muster = ?, inhalt_muster = ? WHERE id = ?',
    ).run(typ, muster, ziel, aktion, betreffMuster || null, inhaltMuster || null, id);

    // Neuer Zielordner: Gibt es ihn im Postfach nicht, scheitert jedes
    // Verschieben — und zwar erst beim nächsten Lauf, in n8n. Lieber jetzt
    // anlegen (Best Effort, wie beim Anlegen einer Regel).
    let ordnerAngelegt = false;
    if (aktion === 'verschieben' && ziel && ziel !== alt.zielordner) {
      try {
        const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(alt.konto_id);
        if (konto) {
          Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
          ordnerAngelegt = Boolean(await imap.ordnerErstellen(konto, ziel));
          if (ordnerAngelegt) {
            loggen('info', 'sortierung', `Neuer Ordner "${ziel}" beim Ändern einer Regel angelegt.`);
          }
        }
      } catch (err) {
        loggen('warn', 'sortierung', `Ordner "${ziel}" konnte nicht angelegt werden: ${err.message}`);
      }
    }

    // War es eine Ruhe-Regel und ist es keine mehr, sollen die übersprungenen
    // Mails wieder zur Sortierung anstehen — dieselbe Überlegung wie beim
    // Löschen einer Ruhe-Regel.
    if ((alt.aktion || 'verschieben') === 'behalten' && aktion !== 'behalten') {
      bestand.ruheVergessen(alt.konto_id);
    }

    loggen('info', 'sortierung',
      `Regel geändert [${typ}] ${muster} → ${aktion === 'behalten' ? '(bleibt liegen)' : ziel}`);
    res.json({ ok: true, ordnerAngelegt });
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
  // Die freiwillige zweite Bedingung. Bei typ='betreff' waere sie doppelt
  // gemoppelt — dort steht der Betreff schon im Muster.
  const betreffMuster = typ === 'betreff' ? '' : String(req.body?.betreff_muster || '').trim();
  // Und die dritte: ein Stichwort im Text der Mail. Bei typ='inhalt' steht es
  // schon im Muster.
  const inhaltMuster = typ === 'inhalt' ? '' : String(req.body?.inhalt_muster || '').trim();
  if (!konto_id || !typ || !muster || (aktion === 'verschieben' && !ziel)) {
    return res.status(400).json({ error: 'Alle Felder müssen ausgefüllt sein.' });
  }
  if (!['absender', 'betreff', 'domain', 'inhalt'].includes(typ)) {
    return res.status(400).json({ error: 'Ungültiger Typ.' });
  }
  // Ein zu kurzes Stichwort trifft fast jede Mail. „AG" steht in jeder zweiten
  // Signatur — eine Regel daraus verschiebt wahllos.
  if ((typ === 'inhalt' ? String(muster).trim() : inhaltMuster).length > 0
      && (typ === 'inhalt' ? String(muster).trim() : inhaltMuster).length < 3) {
    return res.status(400).json({ error: 'Ein Stichwort für den Inhalt braucht mindestens 3 Zeichen.' });
  }
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(konto_id));
  if (!konto) {
    return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  }
  // Dieselbe Bedingung zweimal ergibt zwei Regeln, die sich widersprechen
  // koennen — welche zuerst greift, entschiede dann die Einfuegereihenfolge.
  // Der Betreff gehoert zum Vergleich: Genau darum geht es ja, denselben
  // Absender mit verschiedenen Betreffen mehrfach zu regeln.
  const doppelt = db.prepare(
    'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?'
    + " AND IFNULL(betreff_muster, '') = ? AND IFNULL(inhalt_muster, '') = ?",
  ).get(Number(konto_id), typ, muster.trim(), betreffMuster, inhaltMuster);
  if (doppelt) {
    return res.status(400).json({
      error: betreffMuster || inhaltMuster
        ? `Für dieses Muster mit derselben Zusatzbedingung („${betreffMuster || inhaltMuster}") gibt es bereits eine Regel.`
        : 'Für dieses Muster gibt es bereits eine Regel.',
    });
  }
  try {
    const info = db.prepare(`
      INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion, betreff_muster, inhalt_muster, erstellt_von)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(konto_id, typ, muster.trim(), ziel, aktion, betreffMuster || null, inhaltMuster || null, req.user.id);

    // "In Ruhe lassen": nichts anlegen, nichts verschieben. Was schon in der
    // Sortier-Inbox liegt und dazu passt, verschwindet aus der Liste — genau
    // darum geht es bei dieser Regel.
    if (aktion === 'behalten') {
      let beruhigt = 0;
      try {
        const offen = db.prepare("SELECT id, von, betreff FROM sort_inbox WHERE konto_id = ? AND status = 'offen'").all(konto_id);
        const setzen = db.prepare("UPDATE sort_inbox SET status = 'ignoriert' WHERE id = ?");
        for (const m of offen) {
          if (!sortierung.passt({ typ, muster, betreff_muster: betreffMuster, inhalt_muster: inhaltMuster }, m.von, m.betreff)) continue;
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
      Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
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
          // Ohne die Bedingung holte das Nachsortieren ALLES von diesem Absender
          // in den Ordner — also genau das, was die Regel verhindern soll.
          betreff_muster: betreffMuster,
          // Dasselbe gilt für das Inhalts-Stichwort. Die Sortier-Inbox kennt
          // nur Absender und Betreff; steht das Wort nicht im Betreff, bleibt
          // die Mail liegen, statt auf Verdacht mitzuwandern.
          inhalt_muster: inhaltMuster,
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
    // Immer nur ein Postfach. Ohne diesen Filter standen Mails aus allen Konten
    // in einer Liste, und die Ordner-Vorschläge daneben kamen vom gerade
    // gewählten Konto — man bekam also Ordner angeboten, die es im Postfach der
    // Mail gar nicht gibt.
    const kontoId = Number(req.query.konto_id) || null;
    const inbox = db.prepare(`
      SELECT i.*, a.id AS account_id, a.name AS account_name
      FROM sort_inbox i
      LEFT JOIN accounts a ON a.id = i.konto_id OR a.name = i.konto
      WHERE i.status = 'offen' AND (? IS NULL OR i.konto_id = ?)
      ORDER BY i.created_at DESC
    `).all(kontoId, kontoId);
    res.json(inbox);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ordner-inhalt', async (req, res) => {
  const { konto_id, ordner } = req.query;
  if (!konto_id || !ordner) return res.status(400).json({ error: 'konto_id und ordner fehlen' });
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto_id);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden' });
  
  try {
    Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
    const inhalt = await imap.ordnerInhaltLaden({ ...konto, ordner, limit: 100, mitUnsubscribe: true });
    res.json(inhalt.eintraege || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wie GET /mail/:id, nur ohne sort_inbox-Zeile dahinter: der Ordner-Tab zeigt
// Mails direkt aus dem IMAP-Ordner, kennt Konto/Ordner/UID also schon selbst.
router.get('/ordner-mail', async (req, res) => {
  const { konto_id, ordner, uid } = req.query;
  if (!konto_id || !ordner || !uid) return res.status(400).json({ error: 'konto_id, ordner und uid fehlen' });
  try {
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto_id);
    if (!konto) return res.status(404).json({ error: 'Konto nicht gefunden.' });

    Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher

    const { text, unsubscribe } = await imap.mailLaden({
      host: konto.host,
      port: konto.port,
      username: konto.username,
      passwort: konto.passwort,
      tlsUnsicher: konto.tlsUnsicher,
      uid: Number(uid),
      ordner,
    });

    res.json({ text, unsubscribe });
  } catch (err) {
    loggen('error', 'sortierung', `Konnte E-Mail ${uid} aus „${ordner}" nicht laden: ${err.message}`);
    res.status(500).json({ error: 'Konnte E-Mail nicht vom Server laden.' });
  }
});

// POST /api/sortierung/zuordnen — Mail(s) aus Inbox einem Ordner zuweisen
router.post('/zuordnen', async (req, res) => {
  const { zielordner, regelAnlegen } = req.body || {};
  let ids = req.body?.ids || (req.body?.id ? [req.body.id] : []);
  if (!ids.length || !zielordner) return res.status(400).json({ error: 'ID(s) und Zielordner fehlen.' });
  
  try {
    const uebergeben = [];
    db.transaction(() => {
      for (const id of ids) {
        const mail = db.prepare('SELECT * FROM sort_inbox WHERE id = ?').get(id);
        if (!mail) continue;

        db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?").run(zielordner, id);
        uebergeben.push(mail);

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
      }
    })();

    const genutzteKonten = new Set(uebergeben.map(m => m.konto_id).filter(Boolean));
    for (const konto_id of genutzteKonten) {
      try {
        const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto_id);
        if (konto) {
          Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
          const angelegt = await imap.ordnerErstellen(konto, zielordner.trim());
          if (angelegt) loggen('info', 'sortierung', `Neuer Ordner "${zielordner.trim()}" für Konto ${konto.name} via IMAP angelegt.`);
        }
      } catch (err) {
        loggen('warn', 'sortierung', `Konnte Ordner "${zielordner.trim()}" nicht anlegen: ${err.message}`);
      }
    }

    loggen('info', 'sortierung', `${uebergeben.length} Mail(s) sollen in Ordner ${zielordner} verschoben werden.`);
    uebersicht.cacheVerwerfen();
    res.json({ ok: true, aktualisiert: uebergeben.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/mails-verschieben — Mails direkt per IMAP verschieben (Ordner-Ansicht)
router.post('/mails-verschieben', async (req, res) => {
  const { konto_id, von, nach, uids } = req.body || {};
  if (!konto_id || !von || !nach || !Array.isArray(uids)) return res.status(400).json({ error: 'Parameter fehlen' });
  
  try {
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(konto_id);
    if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden' });
    Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
    
    // Zielordner anlegen falls nötig
    await imap.ordnerErstellen(konto, nach.trim());
    
    const mails = uids.map(uid => ({ uid }));
    const ergebnis = await imap.mailsVerschieben({ ...konto, mails, von, nach });
    
    loggen('info', 'sortierung', `${ergebnis.verschoben.length} Mail(s) von ${von} nach ${nach} verschoben.`);
    uebersicht.cacheVerwerfen();
    res.json(ergebnis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eine ID-Liste aus dem Rumpf: nur positive ganze Zahlen, ohne Dubletten.
// Die Obergrenze liegt über jedem realistischen Stapel — sie verhindert nur,
// dass ein kaputter Aufruf eine Abfrage mit hunderttausend Parametern baut.
const MAX_IDS = 5000;
function idListe(roh) {
  if (!Array.isArray(roh)) return null;
  const ids = [...new Set(roh.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length > 0 && ids.length <= MAX_IDS ? ids : null;
}

// POST /api/sortierung/ignorieren — Mail(s) aus der Inbox nehmen, ohne Regel
// { id } für eine Mail, { ids: [...] } für ein ganzes Bündel.
router.post('/ignorieren', (req, res) => {
  try {
    if (req.body?.ids !== undefined) {
      const ids = idListe(req.body.ids);
      if (!ids) return res.status(400).json({ error: `ids muss eine Liste mit 1 bis ${MAX_IDS} Einträgen sein.` });
      const platzhalter = ids.map(() => '?').join(',');
      const info = db.prepare(
        `UPDATE sort_inbox SET status = 'ignoriert' WHERE status = 'offen' AND id IN (${platzhalter})`,
      ).run(...ids);
      uebersicht.cacheVerwerfen();
      return res.json({ ok: true, ignoriert: info.changes });
    }
    db.prepare("UPDATE sort_inbox SET status = 'ignoriert' WHERE id = ?").run(Number(req.body.id));
    uebersicht.cacheVerwerfen();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/inbox/verschieben — genau diese Mails in einen Ordner
// { konto_id, ids: [...], zielordner, regel?: { typ, muster, inhalt_muster } }
//
// Der Unterschied zu /sammel-zuordnen ist Absicht: Dort wird über ein Muster
// verschoben (Domain, Absender) und alles mitgenommen, was sonst noch passt.
// Ein Bündel nach Inhalt geht quer über viele Absender, ein gefilterter Stapel
// zeigt nur einen Teil — hier wird deshalb nur verschoben, was angezeigt
// wurde, keine Mail mehr. Eine Regel entsteht nur, wenn ausdrücklich eine
// mitgeschickt wird, und sie wirkt dann erst für künftige Mails.
router.post('/inbox/verschieben', async (req, res) => {
  const { konto_id } = req.body || {};
  const ids = idListe(req.body?.ids);
  const zielordner = String(req.body?.zielordner || '').trim();
  if (!konto_id || !ids || !zielordner) {
    return res.status(400).json({ error: `konto_id, ids (1 bis ${MAX_IDS}) und zielordner sind Pflicht.` });
  }
  const konto = kontoLaden(konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });

  let regel = null;
  if (req.body?.regel) {
    const geprueft = regelAusRumpf({ ...req.body.regel, zielordner });
    if (geprueft.fehler) return res.status(400).json({ error: geprueft.fehler });
    regel = geprueft.regel;
  }

  try {
    // Konto-gebunden: Eine ID aus einem anderen Postfach wird schlicht nicht
    // gefunden, statt mit den Zugangsdaten dieses Kontos verschoben zu werden.
    const platzhalter = ids.map(() => '?').join(',');
    const zeilen = db.prepare(
      `SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND id IN (${platzhalter})`
    ).all(konto.id, ...ids);

    try {
      const neu = await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, zielordner);
      if (neu) loggen('info', 'sortierung', `Ordner "${zielordner}" für ${konto.name} angelegt.`);
    } catch (err) {
      return res.status(400).json({ error: `Zielordner nicht nutzbar: ${err.message}` });
    }

    const regelId = regel ? regelMerken(konto.id, regel, req.user.id) : null;
    const ergebnis = zeilen.length > 0
      ? await sortierung.stapelVerschieben(konto, zeilen, zielordner, `Sortier-Inbox (${zeilen.length} ausgewählt)`)
      : { treffer: 0, verschoben: 0, fehler: [], veraltet: 0 };
      
    // (Stufe 6) Lern-Automatik: Wenn Mails aus der Inbox verschoben werden, 
    // protokollieren wir das im quarantine_log (als haetten sie direkt diesen Zielordner gehabt)
    // und loesen die Lern-Pruefung aus. Wenn es fuer den Absender das dritte Mal in Folge ist,
    // entsteht automatisch eine harte Regel.
    // Nur die Mails, die wirklich umgezogen sind. Vorher lief die Schleife über
    // den ganzen Stapel, sobald irgendeine verschoben war: Gescheiterte standen
    // danach als verschoben im Protokoll und dienten als Beleg fürs Lernen.
    lernenAusVerschiebung(konto, zeilen, ergebnis.verschobeneIds, zielordner, { regelSchonDa: Boolean(regel) });

    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();

    // „Nicht mehr offen" heißt: Jemand anders (ein Workflow-Lauf, ein zweites
    // Fenster) war schneller. Das ist kein Fehler, aber es gehört gesagt.
    res.json({ ok: true, regel_id: regelId, ...ergebnis, nichtMehrOffen: ids.length - zeilen.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Aus einer Verschiebung durch den Nutzer lernen: das Protokoll nachtragen und,
// wenn die Lern-Automatik an ist, eine Absender-Regel festhalten.
//
// Nutzer-Schwelle (themen.LERNSCHWELLE_NUTZER): Wer eine Mail von Hand
// einsortiert oder einen Vorschlag abnickt, gibt eine Ansage, kein Indiz.
//
// `ids` sind die sort_inbox-Zeilen, die tatsächlich umgezogen sind.
function lernenAusVerschiebung(konto, zeilen, ids, zielordner, { regelSchonDa = false } = {}) {
  const erledigt = new Set((ids || []).map(Number));
  if (erledigt.size === 0) return;
  const protokoll = db.prepare(`
    UPDATE quarantine_log SET zielordner = ?, korrigiert_zu = ?
    WHERE konto = ? AND uid = ? AND (zielordner IS NULL OR zielordner = '')
      AND IFNULL(quell_ordner, 'INBOX') = 'INBOX'
  `);
  const lernen = !regelSchonDa && themen.einstellungen().regelLernen;
  for (const z of zeilen) {
    if (!erledigt.has(Number(z.id))) continue;
    try { protokoll.run(zielordner, zielordner, konto.name, z.uid); } catch { /* nicht blockieren */ }
    if (!lernen) continue;
    try {
      const gelernt = themen.regelLernen(konto.id, z.von, zielordner, { schwelle: themen.LERNSCHWELLE_NUTZER });
      if (gelernt) sortierung.bestandAnwenden(konto, gelernt).catch(() => {});
    } catch { /* nicht blockieren */ }
  }
}

// ─── ALLE VORSCHLÄGE AUF EINMAL ──────────────────────────────────────────────
//
// Zu vielen wartenden Mails hat die KI einen Ordner genannt, der im Katalog
// längst existiert — nur war sie sich zu unsicher, um selbst zu verschieben.
// Bisher ließ sich das nur Gruppe für Gruppe übernehmen. Hier geht es in einem
// Schritt, mit Vorschau und Häkchen je Ordner.
//
// Übernommen wird ausschließlich in Ordner, die im Katalog stehen (und nicht
// gesperrt sind). Neue Ordner, die die KI vorschlägt, werden nur genannt — sie
// laufen weiter über die Freigabe im Reiter „Ordner". Es entstehen keine
// Regeln: Die Vorschläge sind unsicher, eine Regel daraus würde den Fehler
// für jede künftige Mail wiederholen.

function vorschlagsStapel(konto) {
  const zeilen = db.prepare(
    "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen'"
    + " AND TRIM(IFNULL(ki_ordner, '')) <> '' ORDER BY created_at DESC",
  ).all(konto.id);

  // imKatalog liest bei jedem Aufruf den Katalog und die Umleitungen — je
  // Vorschlagsname genügt einmal.
  const aufgeloest = new Map();
  const ordner = new Map();
  const neu = new Map();
  for (const z of zeilen) {
    const name = String(z.ki_ordner).trim();
    const schluessel = name.toLowerCase();
    if (!aufgeloest.has(schluessel)) aufgeloest.set(schluessel, themen.imKatalog(konto.id, name));
    const eintrag = aufgeloest.get(schluessel);
    if (!eintrag) {
      if (!neu.has(schluessel)) neu.set(schluessel, { name, anzahl: 0 });
      neu.get(schluessel).anzahl += 1;
      continue;
    }
    if (!ordner.has(eintrag.ordner)) ordner.set(eintrag.ordner, { ordner: eintrag.ordner, mails: [] });
    ordner.get(eintrag.ordner).mails.push(z);
  }
  return {
    ordner: [...ordner.values()].sort((a, b) => b.mails.length - a.mails.length || a.ordner.localeCompare(b.ordner)),
    neueOrdner: [...neu.values()].sort((a, b) => b.anzahl - a.anzahl),
  };
}

// GET /api/sortierung/inbox/vorschlaege-vorschau?konto_id=1
router.get('/inbox/vorschlaege-vorschau', async (req, res) => {
  const konto = kontoLaden(req.query.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  try {
    await inboxAbgleichen();
    const { ordner, neueOrdner } = vorschlagsStapel(konto);
    const sicherheit = (mails) => {
      const werte = mails.map((m) => m.ki_konfidenz).filter((k) => k != null);
      return werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
    };
    res.json({
      ordner: ordner.map((o) => ({
        ordner: o.ordner,
        anzahl: o.mails.length,
        sicherheit: sicherheit(o.mails),
        beispiele: [...new Set(o.mails.map((m) => String(m.betreff || '').trim()).filter(Boolean))].slice(0, 3),
      })),
      neueOrdner,
      gesamt: ordner.reduce((s, o) => s + o.mails.length, 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/inbox/vorschlaege-uebernehmen { konto_id, ordner: [...] }
//
// Bewusst ohne IDs vom Client: Der Stapel wird hier neu berechnet. Zwischen
// Vorschau und Klick kann ein Workflow-Lauf Mails einsortiert oder neue
// Vorschläge gebracht haben — verschoben wird, was JETZT zu den gewählten
// Ordnern vorgeschlagen ist.
router.post('/inbox/vorschlaege-uebernehmen', async (req, res) => {
  const konto = kontoLaden(req.body?.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  const gewaehlt = Array.isArray(req.body?.ordner)
    ? [...new Set(req.body.ordner.map((o) => String(o).trim()).filter(Boolean))]
    : [];
  if (gewaehlt.length === 0) return res.status(400).json({ error: 'Kein Ordner ausgewählt.' });

  try {
    const { ordner } = vorschlagsStapel(konto);
    const ergebnisse = [];
    for (const name of gewaehlt) {
      const gruppe = ordner.find((o) => o.ordner === name);
      // Nicht (mehr) im Stapel — etwa weil der Ordner inzwischen gesperrt ist
      // oder die Mails schon einsortiert sind. Kein Fehler, nur nichts zu tun.
      if (!gruppe) { ergebnisse.push({ ordner: name, treffer: 0, verschoben: 0, veraltet: 0, fehler: [] }); continue; }

      // Die Schreibweise des Servers: Wo alles unter dem Posteingang liegt,
      // heißt der Ordner „INBOX.Reisen". Fehlt er, wird er angelegt.
      let ziel = await themen.ordnerPfad(konto, gruppe.ordner);
      if (!ziel) {
        try {
          await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, gruppe.ordner);
          themen.cacheVerwerfen(konto.id);
          ziel = (await themen.ordnerPfad(konto, gruppe.ordner)) || gruppe.ordner;
        } catch (err) {
          ergebnisse.push({
            ordner: name, treffer: gruppe.mails.length, verschoben: 0, veraltet: 0,
            fehler: [`Ordner nicht nutzbar: ${err.message}`],
          });
          continue;
        }
      }
      const r = await sortierung.stapelVerschieben(konto, gruppe.mails, ziel, 'Alle KI-Vorschläge übernommen');

      // Der Nutzer hat die Vorschläge abgenickt — das ist eine Bestätigung, also
      // gilt die Nutzer-Schwelle. Gelernt wird nur aus dem, was wirklich umzog.
      lernenAusVerschiebung(konto, gruppe.mails, r.verschobeneIds, ziel);

      const { verschobeneIds: _ids, ...ohneIds } = r;
      ergebnisse.push({ ordner: name, ...ohneIds });
    }
    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();

    const summe = (feld) => ergebnisse.reduce((s, e) => s + (e[feld] || 0), 0);
    loggen('info', 'sortierung',
      `${konto.name}: KI-Vorschläge für ${gewaehlt.length} Ordner übernommen — ${summe('verschoben')} Mail(s) verschoben.`);
    res.json({
      ok: true,
      ergebnisse,
      verschoben: summe('verschoben'),
      veraltet: summe('veraltet'),
      fehler: ergebnisse.flatMap((e) => e.fehler.map((f) => `${e.ordner}: ${f}`)),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── LETZTE ENTSCHEIDUNGEN UND KORREKTUR ─────────────────────────────────────
//
// Bisher sah man eine Fehlentscheidung, korrigierte sie von Hand im
// Mailprogramm — und die KI traf sie beim naechsten Mal genauso. Hier wird
// daraus eine Rueckmeldung: Die Mail zieht um, und aus der Korrektur entsteht
// eine Regel, die kuenftig vor der KI greift.

// GET /api/sortierung/entscheidungen
//   ?konto_id=1|alle & suche=… & nur=ki|regel|korrigiert|liegen|spam
//   & tage=7 & seite=1 & limit=50
//
// Die Antwort ist ein Objekt, kein Array: Ohne Gesamtzahl gibt es kein
// Blättern, und ohne Blättern wäre man wieder auf die letzten paar Zeilen
// beschränkt — genau daran scheiterte bisher jede nachträgliche Korrektur.
router.get('/entscheidungen', async (req, res) => {
  // "alle": Wer eine falsch einsortierte Mail sucht, weiß oft nicht mehr, in
  // welchem Postfach sie ankam. Danach erst das Konto zu raten, wäre eine
  // Hürde ohne Zweck — die Zeile trägt ihr Konto ohnehin bei sich.
  const ueberAlle = String(req.query.konto_id || '') === 'alle';
  const konto = ueberAlle ? null : kontoLaden(req.query.konto_id);
  if (!ueberAlle && !konto) return res.status(400).json({ error: 'konto_id fehlt oder unbekannt.' });
  try {
    res.json(await entscheidungen.suchen({
      konto: konto,
      suche: req.query.suche,
      nur: req.query.nur,
      ordner: req.query.ordner,
      tage: req.query.tage,
      seite: req.query.seite,
      limit: req.query.limit,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Die fünf Arten, aus einer Korrektur zu lernen — siehe korrekturAusfuehren().
const REGEL_ARTEN = ['keine', 'domain', 'absender', 'absender_inhalt', 'inhalt'];

// Meinen zwei Ordnernamen dasselbe Fach? „INBOX.Rechnungen" = „Rechnungen".
function gleicherOrdner(a, b) {
  const kurz = (x) => String(x || '').trim().toLowerCase().replace(/^inbox[./]/, '');
  return kurz(a) !== '' && kurz(a) === kurz(b);
}

// Der Zielordner in der Schreibweise des Servers — angelegt, falls er fehlt.
//
// Mit dem getippten Namen scheiterte das Verschieben auf Servern, die alles
// unter den Posteingang legen („INBOX.Reisen"): Der Ordner „existierte", der
// Umzug nach „Reisen" ging trotzdem ins Leere.
async function zielPfad(konto, name) {
  const echt = await themen.ordnerPfad(konto, name);
  if (echt) return echt;
  const neu = await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, name);
  if (neu) loggen('info', 'sortierung', `Ordner "${name}" für ${konto.name} angelegt.`);
  themen.cacheVerwerfen(konto.id);
  return (await themen.ordnerPfad(konto, name)) || name;
}

/**
 * Eine Zeile der Entscheidungs-Chronik korrigieren: die Mail umziehen und aus
 * der Korrektur lernen.
 *
 * Herausgelöst aus POST /korrigieren, weil die Sammel-Entscheidung
 * (POST /korrigieren-sammel) genau dasselbe für viele Zeilen tut — jede mit
 * eigenem Ziel und eigener Merk-Art. Zwei Fassungen liefen zwangsläufig
 * auseinander.
 *
 * @param {object} body  { log_id, zielordner, regelTyp, stichwort, imap_* }
 * @returns {Promise<{status: number, json: object}>}
 */
async function korrekturAusfuehren(body, userId) {
  const {
    log_id, zielordner, regelTyp: regelTypRoh = 'domain', stichwort: stichwortRoh,
    imap_uid, imap_konto, imap_ordner, imap_von, imap_betreff,
  } = body || {};
  const absage = (status, error) => ({ status, json: { error } });
  if (!log_id || !zielordner) return absage(400, 'log_id und zielordner sind Pflicht.');
  const regelTyp = REGEL_ARTEN.includes(regelTypRoh) ? regelTypRoh : 'domain';

  // Zwei der Merk-Arten brauchen ein Stichwort, und zwar BEVOR irgendetwas
  // passiert: Die Mail wird weiter unten verschoben, und eine Absage danach
  // hinterließe eine verschobene Mail ohne die Regel, um die es ging.
  const stichwort = String(stichwortRoh || '').trim();
  const brauchtStichwort = regelTyp === 'absender_inhalt' || regelTyp === 'inhalt';
  if (brauchtStichwort && stichwort.length < 3) {
    return absage(400, 'Für eine Regel auf den Inhalt braucht es ein Stichwort mit mindestens 3 Zeichen.');
  }

  const isVirtual = String(log_id).startsWith('imap-');
  let eintrag;
  let konto;

  if (isVirtual) {
    konto = db.prepare('SELECT * FROM accounts WHERE name = ?').get(imap_konto);
    if (!konto) return absage(400, 'Konto existiert nicht.');
    eintrag = {
      id: log_id,
      konto: imap_konto,
      von: imap_von,
      betreff: imap_betreff,
      zielordner: imap_ordner,
      uid: imap_uid,
    };
  } else {
    eintrag = db.prepare('SELECT * FROM quarantine_log WHERE id = ?').get(Number(log_id));
    if (!eintrag) return absage(404, 'Eintrag nicht gefunden.');
    konto = db.prepare('SELECT * FROM accounts WHERE name = ?').get(eintrag.konto);
    if (!konto) return absage(400, `Konto "${eintrag.konto}" existiert nicht mehr.`);
  }

  // Wo liegt die Mail JETZT?
  //
  //   korrigiert_zu  schon einmal korrigiert — dann dort, nicht mehr im alten Ziel
  //   zielordner     einsortiert
  //   quell_ordner   liegengeblieben — dort, wo sie herkam (fast immer der Posteingang)
  //
  // Bis Build 251 zählte nur `zielordner`. Eine zweite Korrektur suchte die
  // Mail im ursprünglichen Ordner und fand sie nicht; eine liegengebliebene
  // Mail (kein Zielordner) ließ sich gar nicht korrigieren — der Knopf fehlte,
  // und das Backend hätte einen Ordner namens „null" geöffnet. In den sieben
  // Tagen vor dem 23.09. waren das 962 Mails.
  const liegtIn = String(eintrag.korrigiert_zu || eintrag.zielordner || eintrag.quell_ordner || 'INBOX');
  // Liegt sie noch dort, wo sie das Panel gesehen hat, stimmt ihre UID dort
  // noch. Nach einem Umzug vergibt der Server eine neue.
  const uidGiltHier = isVirtual || (!eintrag.korrigiert_zu && !eintrag.zielordner);

  const ziel = String(zielordner).trim();
  if (gleicherOrdner(ziel, liegtIn)) {
    return absage(400, 'Das ist der Ordner, in dem die Mail schon liegt.');
  }

  try {
    const zugang = themen.zugang(konto);

    // 1. Zielordner sicherstellen — in der Schreibweise des Servers.
    let pfad;
    try {
      pfad = await zielPfad(konto, ziel);
    } catch (err) {
      return absage(400, `Zielordner nicht nutzbar: ${err.message}`);
    }

    // 2. Die Mail selbst umziehen.
    //
    // Über die gespeicherte UID nur, solange die Mail noch dort liegt, wo das
    // Panel sie gesehen hat — und mit Gegenprobe auf den Absender. Sonst über
    // Absender und Betreff suchen: IMAP vergibt UIDs je Ordner, im Zielordner
    // zeigt die alte ins Leere oder auf eine ganz andere Nachricht.
    let verschoben = false;
    let hinweis = null;
    try {
      if (uidGiltHier && eintrag.uid) {
        const r = await imap.mailsVerschieben({
          ...zugang, mails: [{ uid: eintrag.uid, von: eintrag.von }], von: liegtIn, nach: pfad, absenderPruefen: true,
        });
        verschoben = r.verschoben.length > 0;
      }
      if (!verschoben) {
        const treffer = await imap.mailsSuchen({
          ...zugang,
          ordner: liegtIn,
          von: sortierung.adresse(eintrag.von),
          betreff: eintrag.betreff || undefined,
        });
        if (treffer.length === 0) {
          hinweis = `In "${liegtIn}" war diese Mail nicht mehr zu finden — `
            + 'vermutlich schon von Hand verschoben oder gelöscht.'
            + (regelTyp !== 'keine' ? ' Die Regel gilt trotzdem.' : '');
        } else {
          // Bei mehreren Treffern die juengste nehmen: Wiederkehrende Newsletter
          // haben denselben Betreff, gemeint ist die zuletzt einsortierte.
          const uid = Math.max(...treffer);
          await imap.mailVerschieben({ ...zugang, uid, von: liegtIn, nach: pfad });
          verschoben = true;
          if (treffer.length > 1) {
            hinweis = `${treffer.length} Mails passten zu Absender und Betreff — verschoben wurde die neueste.`;
          }
        }
      }
    } catch (err) {
      hinweis = `Die Mail selbst ließ sich nicht verschieben (${err.message}).`
        + (regelTyp !== 'keine' ? ' Die Regel wurde angelegt.' : '');
      loggen('warn', 'sortierung', `Korrektur: ${hinweis}`);
    }

    // 3. Aus der Korrektur lernen
    // Fünf Arten, aus einer Korrektur zu lernen — von „gar nicht" bis „immer,
    // wenn dieses Wort in der Mail steht":
    //
    //   keine            nur diese eine Mail verschieben
    //   domain           alles von dieser Domain
    //   absender         alles von genau dieser Adresse
    //   absender_inhalt  von dieser Adresse, aber nur wenn das Stichwort drinsteht
    //   inhalt           jede Mail mit diesem Stichwort, egal von wem
    //
    // Die vierte Art ist der Grund für den ganzen Umbau: Viele Unternehmen
    // verschicken alles über dieselbe Adresse. Von "donotreply@" kommen
    // Buchungsbestätigung, Rechnung und Werbung — eine reine Absender-Regel
    // liegt dort bei zwei von drei Mails falsch, egal wohin sie zeigt.
    let regel = null;
    if (regelTyp !== 'keine') {
      const typ = regelTyp === 'inhalt' ? 'inhalt'
        : (regelTyp === 'absender' || regelTyp === 'absender_inhalt') ? 'absender' : 'domain';
      const muster = typ === 'inhalt' ? stichwort.toLowerCase()
        : typ === 'domain' ? sortierung.domain(eintrag.von) : sortierung.adresse(eintrag.von);
      const inhaltMuster = regelTyp === 'absender_inhalt' ? stichwort.toLowerCase() : null;
      if (muster) {
        // Verglichen wird die VOLLE Bedingung: Eine Regel mit Betreff-Bedingung
        // ist eine andere Regel und darf hier nicht umgebogen werden — sonst
        // zeigte „Absender + Betreff ‚Bestellung' → Bestellungen" plötzlich
        // nach Rechnungen, nur weil eine Rechnung korrigiert wurde.
        const vorhanden = db.prepare(
          'SELECT id, zielordner, aktion FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?'
          + " AND IFNULL(inhalt_muster, '') = ? AND IFNULL(betreff_muster, '') = ''",
        ).get(konto.id, typ, muster, inhaltMuster || '');
        if (vorhanden) {
          // Eine bestehende Regel zeigte auf den falschen Ordner — die wird
          // umgebogen, sonst korrigiert man dieselbe Mail immer wieder. War es
          // eine „in Ruhe lassen"-Regel, verschiebt sie ab jetzt: Genau das hat
          // der Nutzer gerade verlangt.
          db.prepare("UPDATE sort_rules SET zielordner = ?, aktion = 'verschieben' WHERE id = ?").run(pfad, vorhanden.id);
          if ((vorhanden.aktion || 'verschieben') === 'behalten') bestand.ruheVergessen(konto.id);
          regel = { typ, muster, zielordner: pfad, inhalt_muster: inhaltMuster, aktualisiert: true };
        } else {
          db.prepare(`
            INSERT INTO sort_rules (konto_id, typ, muster, zielordner, inhalt_muster, erstellt_von)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(konto.id, typ, muster, pfad, inhaltMuster, userId);
          regel = { typ, muster, zielordner: pfad, inhalt_muster: inhaltMuster, aktualisiert: false };
        }
      }
    }

    // 4. Was noch wartet und dazu passt, gleich mitnehmen
    let nachsortiert = { treffer: 0, verschoben: 0, fehler: [] };
    if (regel) {
      try {
        const { verschobeneIds: _ids, ...r } = await sortierung.bestandAnwenden(konto, regel);
        nachsortiert = r;
      } catch (err) {
        loggen('warn', 'sortierung', `Nachsortieren nach Korrektur fehlgeschlagen: ${err.message}`);
      }
    }

    // 5. Das Gelernte geradeziehen. Hat die KI diesen Absender einmal dem
    //    falschen Ordner zugeordnet, steht er dort als Stichwort — und würde die
    //    nächste Mail wieder dorthin schieben, diesmal ohne KI. Eine Korrektur
    //    muss beides können: verschieben und die Ursache beseitigen.
    themen.gelerntVergessen(konto.id, liegtIn, eintrag.von);
    // Den Absender dem neuen Ordner zuschreiben — aber nur, wenn die Korrektur
    // überhaupt am Absender festgemacht war. Dieser Vermerk geht als „bisher
    // hier gelandet" in den KI-Prompt und wirkt wie eine Regel ohne Bedingung.
    // Wer gerade gesagt hat „nur diese eine" oder „nur wenn das Wort
    // drinsteht", bekäme damit durch die Hintertür genau die Absender-Regel,
    // die er nicht wollte.
    if (regelTyp === 'domain' || regelTyp === 'absender') {
      const zielEintrag = db.prepare('SELECT id FROM konto_ordner WHERE konto_id = ? AND ordner IN (?, ?)')
        .get(konto.id, pfad, ziel);
      if (zielEintrag) themen.gelerntMerken(zielEintrag.id, eintrag.von);
    }

    if (!isVirtual) {
      db.prepare('UPDATE quarantine_log SET korrigiert_zu = ? WHERE id = ?').run(pfad, eintrag.id);
    }
    // Eine liegengebliebene Mail steht zugleich in der Sortier-Inbox. Ist sie
    // umgezogen, gehört der Eintrag dort geschlossen — sonst bietet die Inbox
    // eine Mail an, die es im Posteingang nicht mehr gibt.
    if (verschoben && uidGiltHier && !isVirtual && String(liegtIn).toUpperCase() === 'INBOX' && eintrag.uid) {
      db.prepare(
        "UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE konto_id = ? AND status = 'offen'"
        + ' AND CAST(uid AS INTEGER) = CAST(? AS INTEGER)',
      ).run(pfad, konto.id, eintrag.uid);
    }
    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();
    loggen('info', 'sortierung',
      `Korrektur: ${eintrag.von} von "${liegtIn}" nach "${pfad}"`
      + (regel
        ? ` — Regel [${regel.typ}] ${regel.muster}`
          + (regel.inhalt_muster ? ` + Inhalt „${regel.inhalt_muster}"` : '')
        : ' — ohne Regel'));

    return { status: 200, json: { ok: true, verschoben, hinweis, regel, nachsortiert, zielordner: pfad } };
  } catch (err) {
    return absage(400, err.message);
  }
}

// POST /api/sortierung/korrigieren
// { log_id, zielordner, regelTyp: 'domain'|'absender'|'absender_inhalt'|'inhalt'|'keine', stichwort }
router.post('/korrigieren', async (req, res) => {
  const { status, json } = await korrekturAusfuehren(req.body, req.user.id);
  res.status(status).json(json);
});

// POST /api/sortierung/korrigieren-sammel
// { eintraege: [{ log_id, zielordner, regelTyp, stichwort, imap_* }, …] }
//
// Die Sammel-Entscheidung: viele Zeilen der Chronik auf einmal, jede mit
// EIGENEM Ziel und EIGENER Merk-Art — die Rechnung von A nach „Rechnungen"
// mit Absender-Regel, der Newsletter von B nach „Newsletter" mit Domain-Regel,
// die Einzelmail von C nur verschieben. Ein Klick statt eines je Zeile.
//
// Nacheinander, nicht gleichzeitig: Zeigen zwei Zeilen auf denselben
// Absender, biegt die zweite die Regel der ersten nur um, statt eine Dublette
// anzulegen — und der Mailserver bekommt nicht zehn Verbindungen auf einmal.
// Ein Fehler in einer Zeile hält die übrigen nicht auf.
//
// Höchstens SAMMEL_MAX Zeilen je Aufruf. Die Oberfläche schickt größere
// Stapel in Portionen, damit ein Reverse-Proxy (üblich: 60 s) nicht mitten im
// Stapel abbricht.
const SAMMEL_MAX = 25;
router.post('/korrigieren-sammel', async (req, res) => {
  const eintraege = req.body?.eintraege;
  if (!Array.isArray(eintraege) || eintraege.length === 0) {
    return res.status(400).json({ error: 'eintraege muss eine nicht leere Liste sein.' });
  }
  if (eintraege.length > SAMMEL_MAX) {
    return res.status(400).json({ error: `Höchstens ${SAMMEL_MAX} Einträge je Aufruf.` });
  }

  const ergebnisse = [];
  for (const e of eintraege) {
    try {
      const { status, json } = await korrekturAusfuehren(e, req.user.id);
      ergebnisse.push({ log_id: e?.log_id ?? null, status, ...json });
    } catch (err) {
      ergebnisse.push({ log_id: e?.log_id ?? null, status: 500, error: err.message });
    }
  }

  const erledigt = ergebnisse.filter((r) => r.status === 200);
  loggen('info', 'sortierung',
    `Sammel-Entscheidung: ${erledigt.length} von ${eintraege.length} Einträgen korrigiert.`);
  res.json({
    ok: true,
    gesamt: eintraege.length,
    erledigt: erledigt.length,
    erledigteIds: erledigt.map((r) => r.log_id),
    verschoben: erledigt.filter((r) => r.verschoben).length,
    regeln: erledigt.filter((r) => r.regel).map((r) => r.regel),
    nachsortiert: erledigt.reduce((s, r) => s + (r.nachsortiert?.verschoben || 0), 0),
    hinweise: erledigt.filter((r) => r.hinweis).map((r) => ({ log_id: r.log_id, hinweis: r.hinweis })),
    fehler: ergebnisse.filter((r) => r.status !== 200).map((r) => ({ log_id: r.log_id, error: r.error })),
  });
});

// ─── REGELN ZUSAMMENFASSEN ───────────────────────────────────────────────────
//
// Wer eine Weile von Hand sortiert hat, sammelt Einzelregeln fuer denselben
// Dienst an: noreply-accounts@google.com, googleplay-noreply@google.com,
// googleone-noreply@google.com … Alle mit demselben Ziel, alle ersetzbar durch
// eine Regel fuer die Domain — die zusaetzlich jede kuenftige Adresse abdeckt.

/** Gruppen von mindestens zwei Absender-Regeln mit gleicher Domain und gleichem Ziel. */
function zusammenfassbar(kontoId) {
  // Regeln mit Betreff- ODER Inhalts-Bedingung bleiben außen vor. Sie zu einer
  // Domain-Regel zu verschmelzen hieße, genau die Bedingung wegzuwerfen, wegen
  // der es sie gibt — und aus „nur Bestellbestätigungen" oder „nur wenn
  // 'Buchungsnummer' drinsteht" würde stillschweigend „alles von dieser
  // Firma". Gerade die Inhalts-Bedingung existiert extra für Anbieter, die
  // dieselbe Adresse für alles benutzen (Buchung, Rechnung, Werbung von
  // derselben "donotreply@") — die als erste wieder zu verschmelzen wäre der
  // Grund, warum es sie gibt, rückgängig gemacht.
  const regeln = db.prepare(
    "SELECT id, typ, muster, zielordner, treffer FROM sort_rules WHERE konto_id = ? AND typ = 'absender'"
    + " AND IFNULL(betreff_muster, '') = '' AND IFNULL(inhalt_muster, '') = ''",
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

  const kandidaten = [...gruppen.values()].filter((g) => g.regeln.length >= 2);

  // Warnt, statt zu verschweigen: Ist dieselbe Domain im Protokoll schon auch
  // WOANDERS gelandet, verschickt sie erkennbar nicht nur eine Sorte Mail —
  // genau der Fall, vor dem eine Domain-Regel nicht schützen kann. Dieselbe
  // Prüfung, die themen.js beim automatischen Lernen anstellt (dort auf den
  // exakten Absender bezogen), hier auf die Domain bezogen, weil DAS die
  // vorgeschlagene Regel wäre.
  for (const g of kandidaten) {
    try {
      // von steht im Protokoll normalerweise als nackte Adresse (die
      // Normalisierer ziehen sie schon vorher aus envelope.from), gelegentlich
      // aber als "Name <a@b.de>" — deshalb beide Endungen prüfen.
      const andereZiele = db.prepare(
        `SELECT DISTINCT zielordner FROM quarantine_log
         WHERE konto = (SELECT name FROM accounts WHERE id = ?)
           AND (von LIKE ? OR von LIKE ?)
           AND zielordner IS NOT NULL AND zielordner != '' AND zielordner != ?`,
      ).all(kontoId, `%@${g.domain}`, `%@${g.domain}>`, g.zielordner);
      g.andereZiele = andereZiele.map((z) => z.zielordner);
    } catch { g.andereZiele = []; }
  }

  return kandidaten;
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

// POST /api/sortierung/regeln/zusammenfassen  { konto_id, regel_ids, zielordner }
//
// Vorher stand hier { domain, zielordner } — und zielordner war kein Ziel,
// sondern nur ein Schlüssel: Die Funktion suchte die Vorschau-Gruppe, deren
// zielordner GENAU dazu passte. Ändern ließ sich das Ziel damit gar nicht; wer
// die Zusammenfassung lieber woanders hinlegen wollte, konnte es nur nachher
// per Hand umbiegen (PUT /regeln/:id).
//
// Jetzt kommen die betroffenen Regeln als IDs — dieselben, die das Frontend
// schon aus GET .../zusammenfassbar kennt — und das Ziel ist ein echter,
// eigener Wert. Ein Absender-Domain kann mehr als eine zusammenfassbare Gruppe
// haben (dieselbe Domain, aber zwei verschiedene bisherige Ziele) — über die
// IDs ist immer eindeutig, welche gemeint ist, auch wenn sich das Ziel dabei
// ändert und der alte Gruppen-Schlüssel gar nicht mehr passt.
router.post('/regeln/zusammenfassen', async (req, res) => {
  const { konto_id, zielordner } = req.body || {};
  const regelIds = Array.isArray(req.body?.regel_ids)
    ? [...new Set(req.body.regel_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  const konto = kontoLaden(konto_id);
  const ziel = String(zielordner || '').trim();
  if (!konto || regelIds.length < 2 || !ziel) {
    return res.status(400).json({ error: 'konto_id, mindestens zwei regel_ids und zielordner sind Pflicht.' });
  }

  const platzhalter = regelIds.map(() => '?').join(',');
  const regeln = db.prepare(
    `SELECT id, typ, muster, zielordner, treffer FROM sort_rules
     WHERE konto_id = ? AND typ = 'absender' AND IFNULL(betreff_muster, '') = ''
       AND id IN (${platzhalter})`,
  ).all(konto.id, ...regelIds);
  if (regeln.length !== regelIds.length) {
    return res.status(404).json({
      error: 'Mindestens eine der Regeln existiert nicht mehr — die Ansicht ist veraltet. Bitte neu laden.',
    });
  }

  const domains = new Set(regeln.map((r) => sortierung.domain(r.muster)).filter(Boolean));
  if (domains.size !== 1) {
    return res.status(400).json({ error: 'Die Regeln zeigen auf verschiedene Domains — so lassen sie sich nicht zusammenfassen.' });
  }
  const gruppe = { domain: [...domains][0], zielordner: ziel, regeln };

  const domainSchonDa = db.prepare(
    "SELECT id FROM sort_rules WHERE konto_id = ? AND typ = 'domain' AND muster = ?",
  ).get(konto.id, gruppe.domain);
  if (domainSchonDa) {
    return res.status(400).json({ error: `Für @${gruppe.domain} gibt es bereits eine Domain-Regel.` });
  }

  // Zeigt keine der zusammengefassten Regeln schon dorthin, ist das Ziel neu
  // gewählt — dann existiert der Ordner vielleicht noch nicht. Best Effort,
  // wie beim Anlegen einer einzelnen Regel (POST /regeln).
  if (!regeln.some((r) => r.zielordner === gruppe.zielordner)) {
    try {
      Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
      const angelegt = await imap.ordnerErstellen(konto, gruppe.zielordner);
      if (angelegt) loggen('info', 'sortierung', `Neuer Ordner "${gruppe.zielordner}" für Konto ${konto.name} via IMAP angelegt.`);
    } catch (err) {
      loggen('warn', 'sortierung', `Konnte Ordner "${gruppe.zielordner}" nicht via IMAP anlegen: ${err.message}`);
    }
  }

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
    // Ziel im Log nur nennen, wenn es sich vom bisherigen unterscheidet —
    // sonst wiederholt der Satz nur, was die Regeln ohnehin schon sagten.
    const altesZiel = gruppe.regeln[0]?.zielordner;
    const zielHinweis = altesZiel && altesZiel !== gruppe.zielordner
      ? ` → "${gruppe.zielordner}" (vorher "${altesZiel}")` : ` → "${gruppe.zielordner}"`;
    loggen('info', 'sortierung',
      `${gruppe.regeln.length} Einzelregeln zu einer Domain-Regel für @${gruppe.domain}${zielHinweis} zusammengefasst.`);
    res.json({ ok: true, ersetzt: gruppe.regeln.length, domain: gruppe.domain, zielordner: gruppe.zielordner, nachsortiert });
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
// { konto_id, typ: 'absender'|'domain'|'betreff'|'inhalt', muster, zielordner, inhalt_muster, regelMerken }
// Eine Regel aus dem Rumpf einer Sammelaktion lesen und prüfen. Gebraucht von
// /sammel-zuordnen und /inbox/verschieben — vorher stand die Prüfung nur in
// der ersten, und eine zweite Kopie wäre beim nächsten neuen Regeltyp
// auseinandergelaufen.
//
// Die Zusatzbedingung „diese Adresse, aber nur wenn das Stichwort in der Mail
// steht" ist derselbe Mechanismus wie beim einzelnen Korrigieren (POST
// /korrigieren) und beim Anlegen einer Regel (POST /regeln). Bei typ='inhalt'
// steht das Stichwort schon im Muster, eine zweite Bedingung wäre doppelt.
function regelAusRumpf({ typ, muster, zielordner, inhalt_muster: roh }) {
  const inhaltMuster = typ === 'inhalt' ? '' : String(roh || '').trim();
  if (!typ || !muster || !zielordner) return { fehler: 'typ, muster und zielordner sind Pflicht.' };
  if (!['absender', 'domain', 'betreff', 'inhalt'].includes(typ)) return { fehler: 'Ungültiger Typ.' };
  if (typ === 'inhalt' && String(muster).trim().length < 3) {
    return { fehler: 'Ein Stichwort für den Inhalt braucht mindestens 3 Zeichen.' };
  }
  if (inhaltMuster && inhaltMuster.length < 3) {
    return { fehler: 'Ein Stichwort für den Inhalt braucht mindestens 3 Zeichen.' };
  }
  return {
    regel: {
      typ, muster: String(muster).trim().toLowerCase(), zielordner: String(zielordner).trim(),
      inhalt_muster: inhaltMuster || null,
    },
  };
}

// Regel speichern, falls es sie nicht schon gibt; gibt die ID zurück. Die
// Zusatzbedingung gehört zum Vergleich: Dieselbe Adresse mit UND ohne
// Stichwort sind zwei verschiedene Regeln, keine Dublette.
//
// Gibt es sie schon, wird sie auf das neue Ziel umgebogen. Vorher kam nur die
// alte ID zurück: Wer alle Mails eines Absenders nach „Rechnungen" schob,
// dessen Regel zeigte weiter nach „Newsletter" — und die nächste Mail landete
// wieder dort. War es eine „in Ruhe lassen"-Regel, wird daraus eine, die
// verschiebt: Genau das hat der Nutzer gerade getan.
function regelMerken(kontoId, regel, userId) {
  const schonDa = db.prepare(
    'SELECT id, zielordner, aktion FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?'
    + " AND IFNULL(inhalt_muster, '') = ? AND IFNULL(betreff_muster, '') = ''",
  ).get(kontoId, regel.typ, regel.muster, regel.inhalt_muster || '');
  if (schonDa) {
    if (schonDa.zielordner !== regel.zielordner || (schonDa.aktion || 'verschieben') !== 'verschieben') {
      db.prepare("UPDATE sort_rules SET zielordner = ?, aktion = 'verschieben' WHERE id = ?")
        .run(regel.zielordner, schonDa.id);
      if ((schonDa.aktion || 'verschieben') === 'behalten') bestand.ruheVergessen(kontoId);
    }
    return schonDa.id;
  }
  return db.prepare(`
    INSERT INTO sort_rules (konto_id, typ, muster, zielordner, inhalt_muster, erstellt_von)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kontoId, regel.typ, regel.muster, regel.zielordner, regel.inhalt_muster, userId).lastInsertRowid;
}

router.post('/sammel-zuordnen', async (req, res) => {
  const { konto_id, regelMerken: merken = true } = req.body || {};
  if (!konto_id) {
    return res.status(400).json({ error: 'konto_id, typ, muster und zielordner sind Pflicht.' });
  }
  const { regel, fehler: ungueltig } = regelAusRumpf(req.body || {});
  if (ungueltig) {
    return res.status(400).json({
      error: ungueltig.endsWith('Pflicht.') ? 'konto_id, typ, muster und zielordner sind Pflicht.' : ungueltig,
    });
  }
  const konto = kontoLaden(konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });

  try {
    // 1. Zielordner sicherstellen — ohne ihn scheitert jedes Verschieben
    try {
      const neu = await imap.ordnerErstellen({ ...konto, ...themen.zugang(konto) }, regel.zielordner);
      if (neu) loggen('info', 'sortierung', `Ordner "${regel.zielordner}" für ${konto.name} angelegt.`);
    } catch (err) {
      return res.status(400).json({ error: `Zielordner nicht nutzbar: ${err.message}` });
    }

    // 2. Regel merken, damit künftige Mails gar nicht erst hier landen
    const regelId = merken ? regelMerken(konto.id, regel, req.user.id) : null;

    // 3. Alles nachziehen, was schon wartet
    const ergebnis = await sortierung.bestandAnwenden(konto, regel);
    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();

    res.json({ ok: true, regel_id: regelId, ...ergebnis });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/sortierung/katalog/:id — Beschreibung pflegen, sperren/entsperren, Probe aufheben
router.put('/katalog/:id', (req, res) => {
  const { beschreibung, gesperrt, auf_probe } = req.body || {};
  try {
    const info = db.prepare(`
      UPDATE konto_ordner
      SET beschreibung = COALESCE(?, beschreibung),
          gesperrt = COALESCE(?, gesperrt),
          auf_probe = COALESCE(?, auf_probe)
      WHERE id = ?
    `).run(
      beschreibung !== undefined ? String(beschreibung).slice(0, 200) : null,
      gesperrt !== undefined ? (gesperrt ? 1 : 0) : null,
      auf_probe !== undefined ? (auf_probe ? 1 : 0) : null,
      Number(req.params.id),
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sortierung/katalog/:id — nur aus dem Katalog nehmen.
// (Das tatsächliche Löschen im Postfach passiert hier bewusst nicht.)
router.delete('/katalog/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM konto_ordner WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sortierung/katalog/:id/probe-rueckgaengig
router.post('/katalog/:id/probe-rueckgaengig', async (req, res) => {
  try {
    const eintrag = db.prepare('SELECT * FROM konto_ordner WHERE id = ?').get(Number(req.params.id));
    if (!eintrag) return res.status(404).json({ error: 'Ordner nicht gefunden.' });
    if (!eintrag.auf_probe) return res.status(400).json({ error: 'Ordner ist nicht auf Probe.' });

    const konto = kontoHolen(eintrag.konto_id);
    if (!konto) return res.status(404).json({ error: 'Konto nicht gefunden.' });

    const imapService = require('../services/imap');
    
    // 1. Alle Mails in diesem Ordner finden
    const uidsSet = await imapService.uidsAuflisten({ ...themen.zugang(konto), ordner: eintrag.ordner });
    const mails = Array.from(uidsSet).map(u => ({ uid: u }));
    
    // 2. Zurückschieben in INBOX
    if (mails.length > 0) {
      await imapService.mailsVerschieben({
        ...themen.zugang(konto),
        mails,
        von: eintrag.ordner,
        nach: 'INBOX'
      });
      // Quarantine Log bereinigen? Wir belassen es besser, oder markieren es, 
      // aber INBOX ist ja der Ursprung.
    }

    // 3. Aus dem Katalog werfen
    db.prepare('DELETE FROM konto_ordner WHERE id = ?').run(eintrag.id);

    // 4. (Optional) Ordner per IMAP löschen? Das Panel löscht eigentlich nie Ordner, 
    // aber bei "Probe" ist das genau der Sinn. Doch das Risiko, was falsches zu löschen, 
    // ist hoch. Wir nehmen ihn nur aus dem Katalog und verschieben die Mails.
    // Der leere Ordner bleibt im Postfach, stört aber nicht weiter.

    res.json({ ok: true, verschoben: mails.length });
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
    res.status(400).json({ error: err.message });
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
    // Auch hier nur ein Postfach: Ein Vorschlag gehört zu einem Konto, und die
    // Ordner, in die man ihn umleiten kann, ebenfalls. Gemischt angezeigt sah
    // man Vorschläge aus Konto B, während daneben die Ordner aus Konto A standen.
    const kontoId = Number(req.query.konto_id) || null;
    res.json(db.prepare(`
      SELECT v.*, a.name AS konto_name,
             (SELECT COUNT(*) FROM sort_inbox i
               WHERE i.konto_id = v.konto_id AND i.status = 'offen' AND i.ki_ordner = v.ordner) AS wartend
      FROM ordner_vorschlaege v
      LEFT JOIN accounts a ON a.id = v.konto_id
      WHERE v.status = 'offen' AND (? IS NULL OR v.konto_id = ?)
      ORDER BY v.anzahl DESC, v.created_at DESC
    `).all(kontoId, kontoId));
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
    // Gebündelt über EINE Verbindung statt je Mail eine eigene — bei vielen
    // wartenden Mails sonst schnell am mail_max_userip_connections-Limit des
    // Mailservers vorbei (siehe imap.js: mailsVerschieben).
    const ergebnisVerschieben = await imap.mailsVerschieben({
      ...zugang, mails: wartend.filter((m) => m.uid), von: 'INBOX', nach: pfad, absenderPruefen: true,
    });
    for (const mail of ergebnisVerschieben.verschoben) {
      db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?").run(pfad, mail.id);
    }
    for (const f of ergebnisVerschieben.fehler) {
      loggen('warn', 'sortierung', `Mail ${f.uid} konnte nicht nach "${pfad}" verschoben werden: ${f.grund}`);
    }
    const verschoben = ergebnisVerschieben.verschoben.length;
    loggen('info', 'sortierung', `Ordner "${pfad}" freigegeben, ${verschoben} wartende Mail(s) nachsortiert.`);
    res.json({ ok: true, ordner: pfad, verschoben, wartend: wartend.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sortierung/vorschlaege/zusammenfassen — { ordner, vorschlag_ids }
//
// Das Aufräumwerkzeug gegen die Zersplitterung: „Plesk", „MC-HOST24" und
// „Fritzbox" sind drei Vorschläge für dieselbe Sache. Hier werden sie zu einem
// Ordner — und weil jeder der Namen als Umleitung hinterlegt wird, schlagen sie
// nie wieder auf, sondern landen künftig ohne Nachfrage im Sammelordner.
router.post('/vorschlaege/zusammenfassen', async (req, res) => {
  const ziel = String(req.body?.ordner || '').trim();
  const ids = Array.isArray(req.body?.vorschlag_ids) ? req.body.vorschlag_ids.map(Number) : [];
  if (!ziel) return res.status(400).json({ error: 'Kein Ordnername angegeben.' });
  if (ids.length === 0) return res.status(400).json({ error: 'Keine Vorschläge ausgewählt.' });

  const vorschlaege = ids
    .map((id) => db.prepare('SELECT * FROM ordner_vorschlaege WHERE id = ?').get(id))
    .filter(Boolean);
  if (vorschlaege.length === 0) return res.status(404).json({ error: 'Vorschläge nicht gefunden.' });

  const kontoIds = new Set(vorschlaege.map((v) => v.konto_id));
  if (kontoIds.size > 1) {
    return res.status(400).json({ error: 'Die Vorschläge gehören zu verschiedenen Postfächern.' });
  }
  const konto = kontoHolen(vorschlaege[0].konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht mehr.' });

  try {
    // Gibt es den Ordner schon, wird er genommen — sonst angelegt. Beides ist
    // hier richtig: Oft ist die Kategorie längst da und nur zersplittert.
    // In der Schreibweise des Servers („INBOX.Reisen"), nicht so, wie getippt —
    // sonst geht das Verschieben auf Servern mit Präfix ins Leere.
    let pfad = await themen.ordnerPfad(konto, ziel);
    if (!pfad) {
      const name = themen.ordnerNormalisieren(ziel, konto);
      if (!name) return res.status(400).json({ error: 'Der Ordnername ist nicht zulässig.' });
      pfad = await themen.ordnerAnlegen(konto, name);
    }
    const katalogEintrag = themen.inKatalog(konto.id, pfad, 'manuell');

    const zugang = themen.zugang(konto);
    let verschoben = 0;
    let wartend = 0;
    const namen = [];
    for (const v of vorschlaege) {
      const mails = db.prepare(
        "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?",
      ).all(konto.id, v.ordner);
      wartend += mails.length;

      // Gebündelt über EINE Verbindung statt je Mail eine eigene (siehe
      // imap.js: mailsVerschieben — verhindert, dass viele wartende Mails das
      // Verbindungslimit des Mailservers sprengen).
      const mailsMitUid = mails.filter((mail) => mail.uid);
      const ergebnisVerschieben = await imap.mailsVerschieben({
        ...zugang, mails: mailsMitUid, von: 'INBOX', nach: pfad, absenderPruefen: true,
      });
      for (const mail of ergebnisVerschieben.verschoben) {
        db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?")
          .run(pfad, mail.id);
        // Die Absender dieser Mails gehören ab jetzt sichtbar zu diesem
        // Ordner — damit greift beim nächsten Mal schon das Stichwort.
        if (katalogEintrag) themen.gelerntMerken(katalogEintrag.id, mail.von);
        verschoben += 1;
      }
      for (const f of ergebnisVerschieben.fehler) {
        loggen('warn', 'sortierung',
          `Mail ${f.uid} konnte nicht nach "${pfad}" verschoben werden: ${f.grund}`);
      }

      // Der Name des Vorschlags wird zur Umleitung — auch der, der zum Ordner
      // wurde, schadet nicht (er trifft ohnehin über den Katalog).
      if (v.ordner !== pfad) themen.aliasMerken(konto.id, v.ordner, pfad);
      db.prepare("UPDATE ordner_vorschlaege SET status = ?, begruendung = ? WHERE id = ?")
        .run(v.ordner === pfad ? 'freigegeben' : 'abgelehnt', `Zusammengefasst in "${pfad}"`, v.id);
      namen.push(v.ordner);
    }

    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();
    loggen('info', 'sortierung',
      `${namen.length} Vorschläge zu "${pfad}" zusammengefasst (${namen.join(', ')}), `
      + `${verschoben} von ${wartend} Mail(s) verschoben.`);
    res.json({ ok: true, ordner: pfad, verschoben, wartend, zusammengefasst: namen.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    // Der Pfad, unter dem der Server den Ordner führt — der kurze Name trifft
    // auf Servern mit Präfix („INBOX.Reisen") ins Leere.
    const pfad = (await themen.ordnerPfad(konto, ziel)) || ziel;

    let wartend = db.prepare(
      "SELECT * FROM sort_inbox WHERE konto_id = ? AND status = 'offen' AND ki_ordner = ?",
    ).all(konto.id, vorschlag.ordner);

    // Nur bestimmte Mails? Dann bleibt der Vorschlag offen: Die übrigen warten
    // weiter, und für sie kann eine andere Entscheidung fallen.
    const auswahl = Array.isArray(req.body?.mail_ids) ? req.body.mail_ids.map(Number) : null;
    const nurEinzelne = auswahl !== null && auswahl.length > 0;
    if (nurEinzelne) wartend = wartend.filter((m) => auswahl.includes(m.id));

    const zugang = themen.zugang(konto);
    // Gebündelt über EINE Verbindung statt je Mail eine eigene (siehe
    // imap.js: mailsVerschieben — verhindert, dass viele wartende Mails das
    // Verbindungslimit des Mailservers sprengen).
    const ergebnisVerschieben = await imap.mailsVerschieben({
      ...zugang, mails: wartend.filter((m) => m.uid), von: 'INBOX', nach: pfad, absenderPruefen: true,
    });
    for (const mail of ergebnisVerschieben.verschoben) {
      db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?")
        .run(pfad, mail.id);
    }
    for (const f of ergebnisVerschieben.fehler) {
      loggen('warn', 'sortierung', `Mail ${f.uid} konnte nicht nach "${ziel}" verschoben werden: ${f.grund}`);
    }
    const verschoben = ergebnisVerschieben.verschoben.length;

    // Den Namen nur dann dauerhaft umleiten, wenn der ganze Vorschlag gemeint
    // war. Wer drei von zwanzig Mails woandershin schiebt, trifft keine
    // Aussage über den Ordnernamen.
    if (!nurEinzelne) {
      themen.aliasMerken(konto.id, vorschlag.ordner, pfad);
      db.prepare("UPDATE ordner_vorschlaege SET status = 'abgelehnt', begruendung = ? WHERE id = ?")
        .run(`Umgeleitet nach "${ziel}"`, vorschlag.id);
    }

    loggen('info', 'sortierung',
      `Vorschlag "${vorschlag.ordner}": ${verschoben} Mail(s) nach "${ziel}" verschoben`
      + (nurEinzelne ? ' (Einzelauswahl, Vorschlag bleibt offen).' : ', Name dauerhaft umgeleitet.'));
    res.json({ ok: true, ordner: ziel, verschoben, wartend: wartend.length, umgeleitet: !nurEinzelne });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sortierung/katalog/:id/beschreibung-vorschlagen
//
// Die Beschreibung ist die Grundlage für alles: Sie geht in den Prompt und wird
// als Stichwort ausgewertet. Nur schreibt sie niemand gern — der Ordner „robin"
// hat 17 Treffer und kein Wort dazu. Eine einzige KI-Abfrage über die Absender,
// die dort bisher gelandet sind, liefert einen brauchbaren Entwurf. Gespeichert
// wird nichts: Der Text landet im Feld, ändern und speichern bleibt beim Nutzer.
router.post('/katalog/:id/beschreibung-vorschlagen', async (req, res) => {
  const eintrag = db.prepare('SELECT * FROM konto_ordner WHERE id = ?').get(Number(req.params.id));
  if (!eintrag) return res.status(404).json({ error: 'Ordner nicht gefunden.' });
  const konto = kontoHolen(eintrag.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht mehr.' });

  // Wer ist dort bisher gelandet? Nur Absender, keine Betreffs und keine Texte.
  const absender = db.prepare(`
    SELECT DISTINCT von FROM quarantine_log
    WHERE konto = ? AND zielordner = ? ORDER BY created_at DESC LIMIT 40
  `).all(konto.name, eintrag.ordner)
    .map((z) => sortierung.adresse(z.von)).filter(Boolean);

  const gelernt = themen.gelernteListe(eintrag);
  if (absender.length === 0 && gelernt.length === 0 && !eintrag.beschreibung) {
    return res.status(400).json({
      error: `In "${eintrag.ordner}" ist noch nichts gelandet — dafür lässt sich nichts beschreiben. `
        + 'Trag ein paar Absender oder Stichworte von Hand ein.',
    });
  }

  const prompt = 'Du hilfst beim Sortieren eines E-Mail-Postfachs. Zu einem Ordner soll eine kurze '
    + 'Beschreibung entstehen, die spaeter einem Klassifizierer sagt, was hier hineingehoert.\n\n'
    + `Ordnername: ${eintrag.ordner}\n`
    + (eintrag.beschreibung ? `Bisherige Beschreibung: ${eintrag.beschreibung}\n` : '')
    + `Absender, die bisher hier gelandet sind:\n${[...new Set([...absender, ...gelernt])].join('\n') || '(keine)'}\n\n`
    + 'Antworte NUR mit JSON: {"beschreibung": "..."}\n'
    + 'Regeln:\n'
    + '- Hoechstens 150 Zeichen, auf Deutsch.\n'
    + '- Nenne die Art der Mails und die typischen Absender oder Marken, mit Komma getrennt.\n'
    + '- Schreib Oberbegriffe dazu, nicht nur die Namen aus der Liste: Die Beschreibung soll auch '
    + 'zu aehnlichen Absendern passen, die noch nicht dabei waren.\n'
    + '- Keine Anrede, kein Satzanfang wie "Dieser Ordner", einfach die Stichworte.';

  const antwort = await kiText.frageJson(prompt, { quelle: 'backend:sortierung' });
  if (!antwort.ok) return res.status(400).json({ error: antwort.fehler });

  const text = String(antwort.daten?.beschreibung || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Die KI hat nichts geliefert.' });
  res.json({ ok: true, beschreibung: text, absender: absender.length });
});

// GET /api/sortierung/postfach-ordner?konto_id= — alle Ordner, die es im
// Postfach wirklich gibt.
//
// Nicht dasselbe wie der Themen-Katalog: Der enthält nur, was jemand eingelesen
// oder die KI angelegt hat. Wer eine Mail von Hand woandershin schieben will,
// meint aber jeden Ordner, den es gibt — und wunderte sich zu Recht, dass in der
// Auswahl die Hälfte fehlte. Zwischenknoten und Systemordner (Papierkorb,
// Entwürfe) bleiben draußen: Dort etwas einzusortieren ergibt keinen Sinn.
router.get('/postfach-ordner', async (req, res) => {
  const konto = kontoHolen(req.query.konto_id);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });
  try {
    // Papierkorb, Entwürfe, Gesendet und Spam sind keine Ablage — alles andere
    // schon, auch die Kategorie-Ordner (Rechnungen, Newsletter …). Die sind nur
    // als KI-Themenname gesperrt, nicht als Ziel von Hand.
    const keineAblage = new Set(['trash', 'drafts', 'sent', 'junk', 'all']);
    const alle = await imap.ordnerDetails({ ...konto, ...themen.zugang(konto) });
    const ordner = alle
      .filter((o) => o.auswaehlbar && !keineAblage.has(o.spezial))
      .map((o) => o.pfad)
      .filter((pfad) => pfad.toLowerCase() !== 'inbox')
      .sort((a, b) => a.localeCompare(b, 'de'));
    res.json(ordner);
  } catch (err) {
    res.status(400).json({ error: `Postfach nicht erreichbar: ${err.message}` });
  }
});

// ─── ABSENDER-STATISTIK ──────────────────────────────────────────────────────
//
// Bei 23.000 Mails im Posteingang ist die KI nicht das Werkzeug: 400 Einordnungen
// am Tag brauchen Wochen. Eine Regel für den größten Absender räumt Tausende ab —
// sofort, ohne KI, ohne Budget. Es wusste nur niemand, wer die großen Absender
// sind. Genau das steht hier.

// POST /api/sortierung/absender-zaehlen — { konto_id }
// Liest alle Umschläge des Posteingangs. Dauert bei großen Postfächern.
router.post('/absender-zaehlen', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });
  try {
    const { gesamt, ohneAbsender, absender } = await imap.absenderZaehlen({
      ...themen.zugang(konto), ordner: 'INBOX',
    });

    // Nur die größten behalten — der lange Schwanz aus Einzelabsendern hilft
    // beim Aufräumen nicht und bläht die Tabelle auf.
    const merken = absender.slice(0, 300);
    db.prepare('DELETE FROM absender_stat WHERE konto_id = ?').run(konto.id);
    const einfuegen = db.prepare(
      'INSERT INTO absender_stat (konto_id, adresse, domain, anzahl) VALUES (?, ?, ?, ?)',
    );
    const alle = db.transaction((liste) => {
      for (const a of liste) einfuegen.run(konto.id, a.adresse, a.domain, a.anzahl);
    });
    alle(merken);

    loggen('info', 'sortierung',
      `${konto.name}: ${gesamt} Mails im Posteingang gezählt, ${absender.length} verschiedene Absender.`);
    res.json({ ok: true, gesamt, ohneAbsender, absender: merken.length });
  } catch (err) {
    res.status(400).json({ error: `Posteingang nicht lesbar: ${err.message}` });
  }
});

// GET /api/sortierung/absender?konto_id= — die größten Absender, nach Domain
// gebündelt. Eine Domain ist die richtige Einheit: Newsletter kommen mal von
// news@, mal von info@ derselben Firma, und eine Domain-Regel deckt beides ab.
router.get('/absender', (req, res) => {
  const kontoId = Number(req.query.konto_id);
  if (!kontoId) return res.status(400).json({ error: 'konto_id fehlt' });
  try {
    const zeilen = db.prepare(`
      SELECT domain, SUM(anzahl) AS anzahl, COUNT(*) AS adressen, MAX(aktualisiert) AS aktualisiert
      FROM absender_stat WHERE konto_id = ? AND domain IS NOT NULL AND domain != ''
      GROUP BY domain ORDER BY anzahl DESC LIMIT ?
    `).all(kontoId, Number(req.query.limit) || 50);

    // Wofür es schon eine Regel gibt, muss man nicht noch einmal anfassen.
    const regeln = db.prepare('SELECT typ, muster, zielordner, betreff_muster FROM sort_rules WHERE konto_id = ?')
      .all(kontoId);
    const fuerDomain = (domain) => regeln.filter((r) => (r.typ === 'domain' && r.muster === domain)
      || (r.typ === 'absender' && String(r.muster).endsWith(`@${domain}`)));

    res.json({
      aktualisiert: zeilen[0]?.aktualisiert || null,
      absender: zeilen.map((z) => {
        const passende = fuerDomain(z.domain);
        // Eine Regel MIT Betreff-Bedingung deckt nur einen Teil ab. Sie als
        // „geregelt" zu zeigen wäre irreführend: Der Rest geht weiter an die KI,
        // und genau darüber will man hier entscheiden können.
        const ohneBedingung = passende.find((r) => !String(r.betreff_muster || '').trim());
        return {
          ...z,
          regel: ohneBedingung?.zielordner || null,
          teilweiseGeregelt: !ohneBedingung && passende.length > 0,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sortierung/absender/adressen?konto_id=&domain= — alle konkreten E-Mail-Adressen einer Domain
router.get('/absender/adressen', (req, res) => {
  const kontoId = Number(req.query.konto_id);
  const domain = String(req.query.domain || '').trim().toLowerCase();
  if (!kontoId || !domain) return res.status(400).json({ error: 'konto_id und domain fehlen' });

  try {
    const konto = db.prepare('SELECT name FROM accounts WHERE id = ?').get(kontoId);
    const zeilen = db.prepare(`
      SELECT adresse, anzahl, aktualisiert
      FROM absender_stat
      WHERE konto_id = ? AND domain = ?
      ORDER BY anzahl DESC, adresse
    `).all(kontoId, domain);

    const regeln = db.prepare(
      "SELECT typ, muster, zielordner FROM sort_rules WHERE konto_id = ? AND (typ = 'absender' OR (typ = 'domain' AND muster = ?))",
    ).all(kontoId, domain);

    const domainRegel = regeln.find((r) => r.typ === 'domain');

    const adressen = zeilen.map((z) => {
      const addr = String(z.adresse || '').toLowerCase().trim();
      const eigeneRegel = regeln.find((r) => r.typ === 'absender' && r.muster.toLowerCase() === addr);

      let letzterBetreff = null;
      try {
        const log = db.prepare(
          "SELECT betreff FROM quarantine_log WHERE konto = ? AND von LIKE ? ORDER BY id DESC LIMIT 1",
        ).get(konto?.name, `%${addr}%`);
        letzterBetreff = log?.betreff || null;
        if (!letzterBetreff) {
          const inbox = db.prepare(
            "SELECT betreff FROM sort_inbox WHERE konto_id = ? AND von LIKE ? ORDER BY id DESC LIMIT 1",
          ).get(kontoId, `%${addr}%`);
          letzterBetreff = inbox?.betreff || null;
        }
      } catch {}

      return {
        adresse: z.adresse,
        anzahl: z.anzahl,
        regel: eigeneRegel ? eigeneRegel.zielordner : (domainRegel ? `(Domain: ${domainRegel.zielordner})` : null),
        hatEigeneRegel: Boolean(eigeneRegel),
        letzterBetreff,
      };
    });

    res.json({ ok: true, domain, adressen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Den Zielordner finden oder anlegen — und ihn so zurückgeben, wie der Server
// ihn führt. `ordnerExistiert()` beantwortete nur ja/nein: Auf einem Server mit
// „INBOX.Reisen" hieß das „ja", verschoben wurde dann aber nach „Reisen" — ins
// Leere. Und der Pfad, den `ordnerAnlegen()` zurückgibt (mit Elternordner),
// ging bisher verloren.
async function pfadOderAnlegen(konto, ziel) {
  const vorhanden = await themen.ordnerPfad(konto, ziel);
  if (vorhanden) return { pfad: vorhanden };
  const name = themen.ordnerNormalisieren(ziel, konto);
  if (!name) return { fehler: 'Der Ordnername ist nicht zulässig.' };
  return { pfad: await themen.ordnerAnlegen(konto, name) };
}

// Nur die tatsächliche Absenderadresse zählt (siehe imap.mailsSuchen).
function adressFilter(typ, muster) {
  const m = String(muster || '').toLowerCase().replace(/^@/, '');
  if (typ === 'absender') return (a) => a === m;
  return (a) => a.endsWith(`@${m}`) || a.endsWith(`.${m}`);
}

// Offene Sortier-Inbox-Zeilen zu Mails abhaken, die eben aus dem Posteingang
// umgezogen sind — über die UID, nicht über ein LIKE auf den Absender.
function inboxAbhaken(konto, uids, ziel) {
  if (!uids || uids.size === 0) return;
  const offen = db.prepare("SELECT id, uid FROM sort_inbox WHERE konto_id = ? AND status = 'offen'").all(konto.id);
  const abhaken = db.prepare("UPDATE sort_inbox SET status = 'zugeordnet', vorschlag = ? WHERE id = ?");
  for (const z of offen) {
    const n = sortierung.uidZahl(z.uid);
    if (n !== null && uids.has(n)) abhaken.run(ziel, z.id);
  }
}

// POST /api/sortierung/absender/einsortieren — { konto_id, domain, adresse?, typ?, zielordner }
//
// Der eine Handgriff, der wirklich etwas bewegt: Regel anlegen UND die Mails
// dieses Absenders aus dem Posteingang holen. Nicht über bestandAnwenden — das
// kennt nur die Sortier-Inbox, also die paar Mails, die das Panel schon gesehen
// hat. Hier geht es um alle, die im Postfach liegen.
router.post('/absender/einsortieren', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  const typ = req.body?.typ === 'absender' ? 'absender' : 'domain';
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const adresse = String(req.body?.adresse || '').trim().toLowerCase();
  const ziel = String(req.body?.zielordner || '').trim();
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });
  if (typ === 'absender' && !adresse) return res.status(400).json({ error: 'Adresse fehlt.' });
  if (typ === 'domain' && !domain) return res.status(400).json({ error: 'Domain fehlt.' });
  if (!ziel) return res.status(400).json({ error: 'Absender und Zielordner sind Pflicht.' });

  try {
    const zugang = themen.zugang(konto);
    const ort = await pfadOderAnlegen(konto, ziel);
    if (ort.fehler) return res.status(400).json({ error: ort.fehler });
    const pfad = ort.pfad;

    const muster = typ === 'absender' ? adresse : domain;

    // Regel merken, damit künftige Mails gar nicht erst zur KI gehen.
    regelMerken(konto.id, { typ, muster, zielordner: pfad, inhalt_muster: null }, req.user.id);

    // Und jetzt der Berg: alles von diesem Absender bzw. dieser Domain aus dem
    // Posteingang — und zwar genau diese Adresse bzw. Domain, nicht alles, was
    // sie im Namen trägt.
    const sucheVon = typ === 'absender' ? adresse : domain;
    const uids = await imap.mailsSuchen({
      ...zugang, ordner: 'INBOX', von: sucheVon, adressePasst: adressFilter(typ, muster),
    });
    let verschoben = 0;
    const fehler = [];
    const umgezogen = new Set();
    if (uids.length) {
      const ergebnis = await imap.mailsVerschieben({
        ...zugang, mails: uids.map((uid) => ({ uid })), von: 'INBOX', nach: pfad,
      });
      verschoben = ergebnis.verschoben.length;
      for (const m of ergebnis.verschoben) umgezogen.add(Number(m.uid));
      for (const p of ergebnis.fehler.slice(0, 5)) fehler.push(`UID ${p.uid}: ${p.grund}`);
    }

    // Was das Panel selbst noch offen hatte, gleich mit abhaken — aber nur, was
    // wirklich umgezogen ist. Vorher galt jede passende Zeile als erledigt,
    // auch wenn ihr Verschieben gescheitert war.
    inboxAbhaken(konto, umgezogen, pfad);

    if (typ === 'absender') {
      db.prepare('DELETE FROM absender_stat WHERE konto_id = ? AND LOWER(adresse) = ?').run(konto.id, adresse);
    } else {
      db.prepare('DELETE FROM absender_stat WHERE konto_id = ? AND domain = ?').run(konto.id, domain);
    }

    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();

    const bez = typ === 'absender' ? adresse : `@${domain}`;
    loggen('info', 'sortierung',
      `Absender-Regel [${typ}] ${bez} → "${pfad}": ${verschoben} von ${uids.length} Mail(s) aus dem `
      + 'Posteingang verschoben (ohne KI).');
    res.json({ ok: true, typ, muster, ziel: pfad, gefunden: uids.length, verschoben, fehler });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sortierung/absender/kategorien — { konto_id }
//
// Eine einzige KI-Abfrage über die größten Absender — nur Domains, keine
// Mailinhalte, kein Bezug zu einzelnen Mails. Sie sieht die ganze Liste auf
// einmal und schlägt deshalb Kategorien vor statt einer Marke je Mail. Das ist
// der Unterschied zwischen „Plesk", „MC-HOST24", „Fritzbox" und einem Ordner
// „Server & Hosting".
router.post('/absender/kategorien', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });

  const zeilen = db.prepare(`
    SELECT domain, SUM(anzahl) AS anzahl FROM absender_stat
    WHERE konto_id = ? AND domain IS NOT NULL AND domain != ''
    GROUP BY domain ORDER BY anzahl DESC LIMIT 40
  `).all(konto.id);
  if (zeilen.length === 0) {
    return res.status(400).json({ error: 'Erst zählen lassen — dann gibt es etwas zu gruppieren.' });
  }

  // Schon vorhandene Ordner mitgeben: Eine bestehende Kategorie ist immer besser
  // als eine neue daneben.
  const vorhandene = themen.katalog(konto.id).map((o) => o.ordner);
  const prompt = 'Du hilfst beim Aufraeumen eines E-Mail-Postfachs. Hier sind die Absender-Domains '
    + 'mit der Anzahl ihrer Mails:\n\n'
    + zeilen.map((z) => `${z.domain} (${z.anzahl})`).join('\n')
    + `\n\nVorhandene Ordner: ${vorhandene.join(', ') || '(noch keine)'}\n\n`
    + 'Bilde daraus wenige, breite Kategorien und antworte NUR mit JSON:\n'
    + '{"gruppen": [{"ordner": "Server & Hosting", "absender": ["plesk.de", "mc-host24.de"]}]}\n\n'
    + 'Regeln:\n'
    + '- Hoechstens 8 Gruppen. Lieber eine Gruppe zu breit als drei zu schmal.\n'
    + '- Passt eine Gruppe zu einem vorhandenen Ordner, nimm dessen Namen unveraendert.\n'
    + '- Ein Ordnername ist ein Lebensbereich, keine Firma: "Streaming", nicht "Netflix".\n'
    + '- Deutsch, hoechstens 20 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, & und Bindestriche.\n'
    + '- Jede Domain hoechstens einmal. Domains, die zu nichts passen, laesst du weg.';

  const antwort = await kiText.frageJson(prompt, { quelle: 'backend:sortierung', zeitlimit: 45000 });
  if (!antwort.ok) return res.status(400).json({ error: antwort.fehler });

  const zahlen = new Map(zeilen.map((z) => [z.domain, z.anzahl]));
  const gruppen = (Array.isArray(antwort.daten?.gruppen) ? antwort.daten.gruppen : [])
    .map((g) => {
      const name = themen.ordnerNormalisieren(g.ordner, konto);
      const absender = (Array.isArray(g.absender) ? g.absender : [])
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => zahlen.has(d));   // nur, was wirklich im Postfach vorkommt
      return name && absender.length
        ? {
          ordner: name,
          absender,
          mails: absender.reduce((s, d) => s + (zahlen.get(d) || 0), 0),
          vorhanden: vorhandene.includes(name),
        }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mails - a.mails);

  res.json({ ok: true, gruppen });
});

// POST /api/sortierung/absender/kategorie-anwenden — { konto_id, ordner, absender: [] }
// Legt den Ordner an (oder nimmt ihn), macht aus jeder Domain eine Regel und
// holt deren Mails aus dem Posteingang. Ein Klick statt zwanzig.
router.post('/absender/kategorie-anwenden', async (req, res) => {
  const konto = kontoHolen(req.body?.konto_id);
  const ziel = String(req.body?.ordner || '').trim();
  const domains = (Array.isArray(req.body?.absender) ? req.body.absender : [])
    .map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!konto) return res.status(400).json({ error: 'Konto nicht gefunden.' });
  if (!ziel || domains.length === 0) {
    return res.status(400).json({ error: 'Ordner und Absender sind Pflicht.' });
  }

  try {
    const zugang = themen.zugang(konto);
    const ort = await pfadOderAnlegen(konto, ziel);
    if (ort.fehler) return res.status(400).json({ error: ort.fehler });
    const pfad = ort.pfad;
    const eintrag = themen.inKatalog(konto.id, pfad, 'manuell');

    let verschoben = 0;
    let gefunden = 0;
    for (const domain of domains) {
      regelMerken(konto.id, { typ: 'domain', muster: domain, zielordner: pfad, inhalt_muster: null }, req.user.id);
      if (eintrag) themen.gelerntMerken(eintrag.id, domain);

      try {
        const uids = await imap.mailsSuchen({
          ...zugang, ordner: 'INBOX', von: domain, adressePasst: adressFilter('domain', domain),
        });
        gefunden += uids.length;
        const umgezogen = new Set();
        if (uids.length) {
          const ergebnis = await imap.mailsVerschieben({
            ...zugang, mails: uids.map((uid) => ({ uid })), von: 'INBOX', nach: pfad,
          });
          verschoben += ergebnis.verschoben.length;
          for (const m of ergebnis.verschoben) umgezogen.add(Number(m.uid));
        }
        inboxAbhaken(konto, umgezogen, pfad);
        db.prepare('DELETE FROM absender_stat WHERE konto_id = ? AND domain = ?').run(konto.id, domain);
      } catch (err) {
        loggen('warn', 'sortierung', `${domain} → "${pfad}" fehlgeschlagen: ${err.message}`);
      }
    }

    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();
    loggen('info', 'sortierung',
      `Kategorie "${pfad}": ${domains.length} Absender-Regeln, ${verschoben} von ${gefunden} Mail(s) verschoben.`);
    res.json({ ok: true, ordner: pfad, regeln: domains.length, gefunden, verschoben });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// POST /api/sortierung/katalog/:id/aufgehen-in — { ziel, vorschau }
//
// Für Ordner, die dasselbe meinen: „Fritzbox-Robin" geht in „Fritzbox" auf.
// Alle Mails wandern hinüber, der Katalogeintrag verschwindet und der alte Name
// wird zur Umleitung — die KI schlägt ihn dann nicht wieder vor.
//
// Der leere IMAP-Ordner bleibt stehen. Das Panel löscht im Postfach grundsätzlich
// nichts; wegräumen kann ihn der Nutzer selbst, wenn er sicher ist.
router.post('/katalog/:id/aufgehen-in', async (req, res) => {
  const quelle = db.prepare('SELECT * FROM konto_ordner WHERE id = ?').get(Number(req.params.id));
  if (!quelle) return res.status(404).json({ error: 'Ordner nicht gefunden.' });
  const ziel = String(req.body?.ziel || '').trim();
  if (!ziel) return res.status(400).json({ error: 'Kein Zielordner angegeben.' });
  if (ziel === quelle.ordner) return res.status(400).json({ error: 'Das ist derselbe Ordner.' });

  const konto = kontoHolen(quelle.konto_id);
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht mehr.' });

  try {
    const zugang = themen.zugang(konto);
    const uids = [...await imap.uidsAuflisten({ ...zugang, ordner: quelle.ordner })];

    // Erst zeigen, wie viele es sind — hier bewegen sich echte Mails, das
    // gehört vor die Rückfrage und nicht danach.
    if (req.body?.vorschau) {
      return res.json({ vorschau: true, anzahl: uids.length, ordner: quelle.ordner, ziel });
    }
    if (!(await themen.ordnerExistiert(konto, ziel))) {
      return res.status(400).json({ error: `Den Ordner "${ziel}" gibt es im Postfach nicht.` });
    }
    // In der Schreibweise des Servers, sonst geht der Umzug auf Servern mit
    // Präfix („INBOX.Reisen") ins Leere.
    const pfad = (await themen.ordnerPfad(konto, ziel)) || ziel;

    let verschoben = 0;
    const fehler = [];
    if (uids.length) {
      const ergebnis = await imap.mailsVerschieben({
        ...zugang, mails: uids.map((uid) => ({ uid })), von: quelle.ordner, nach: pfad,
      });
      verschoben = ergebnis.verschoben.length;
      for (const p of ergebnis.fehler) fehler.push(`UID ${p.uid}: ${p.grund}`);
    }

    // Das Gelernte zieht mit um, der alte Name wird zur Umleitung.
    const zielEintrag = db.prepare('SELECT * FROM konto_ordner WHERE konto_id = ? AND ordner IN (?, ?)')
      .get(konto.id, pfad, ziel);
    if (zielEintrag) {
      for (const domain of themen.gelernteListe(quelle)) themen.gelerntMerken(zielEintrag.id, domain);
    }
    themen.aliasMerken(konto.id, quelle.ordner, pfad);
    db.prepare('DELETE FROM konto_ordner WHERE id = ?').run(quelle.id);
    db.prepare('UPDATE sort_rules SET zielordner = ? WHERE konto_id = ? AND zielordner = ?')
      .run(pfad, konto.id, quelle.ordner);
    themen.cacheVerwerfen(konto.id);
    uebersicht.cacheVerwerfen();

    loggen('info', 'sortierung',
      `Ordner "${quelle.ordner}" ist in "${ziel}" aufgegangen: ${verschoben} von ${uids.length} Mail(s) `
      + 'verschoben, Name als Umleitung hinterlegt. Der leere Ordner bleibt im Postfach stehen.');
    res.json({ ok: true, ordner: quelle.ordner, ziel, verschoben, gesamt: uids.length, fehler: fehler.slice(0, 5) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/sortierung/katalog/:id/gelernt — vergessen, was die KI hier
// gelernt hat. Für den Fall, dass sich etwas Falsches festgesetzt hat.
router.delete('/katalog/:id/gelernt', (req, res) => {
  if (!themen.gelerntLeeren(req.params.id)) {
    return res.status(404).json({ error: 'Ordner nicht gefunden.' });
  }
  res.json({ ok: true });
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
    let freigabe = false;
    try {
      const k = JSON.parse(preset?.konfig || '{}');
      auslesen = Boolean(k.auslesen);
      freigabe = Boolean(k.freigabe);
    } catch { /* egal */ }

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
      automatik: { an: Boolean(preset?.aktiv), auslesen, freigabe, eingerichtet: Boolean(preset) },
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

// GET /api/sortierung/mail/:id — lädt eine wartende Mail (für die Vorschau im Frontend)
router.get('/mail/:id', async (req, res) => {
  try {
    const eintrag = db.prepare('SELECT konto_id, uid FROM sort_inbox WHERE id = ?').get(req.params.id);
    if (!eintrag) return res.status(404).json({ error: 'Mail nicht in der Sortier-Inbox gefunden.' });
    
    const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(eintrag.konto_id);
    if (!konto) return res.status(404).json({ error: 'Zugehöriges Konto nicht gefunden.' });
    
    Object.assign(konto, themen.zugang(konto)); // passwort + tlsUnsicher
    
    const { text, unsubscribe } = await imap.mailLaden({
      host: konto.host,
      port: konto.port,
      username: konto.username,
      passwort: konto.passwort,
      tlsUnsicher: konto.tlsUnsicher,
      uid: eintrag.uid,
      ordner: 'INBOX'
    });
    
    res.json({ text, unsubscribe });
  } catch (err) {
    loggen('error', 'sortierung', `Konnte E-Mail ${req.params.id} nicht laden: ${err.message}`);
    res.status(500).json({ error: 'Konnte E-Mail nicht vom Server laden.' });
  }
});

// ─── NACHSORTIERUNG ──────────────────────────────────────────────────────────
//
// Der nächtliche Lauf durch das ganze Postfach. Die Arbeit steckt in
// services/nachsortierung.js; hier steht nur, wie man hineinsieht und ihn von
// Hand anstößt.

// GET /api/sortierung/nachsortierung — Einstellungen, Zustand, letztes Ergebnis
router.get('/nachsortierung', (req, res) => {
  try {
    res.json({
      ...nachsortierung.einstellungen(),
      laeuft: nachsortierung.laeuftGerade(),
      letzter: nachsortierung.letzterLauf(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/nachsortierung — Einstellungen ändern
//
// Eigene Route statt PUT /einstellungen: Die Karte steht auf der Sortierseite,
// und wer dort arbeitet, hat das Recht „sortierung" — nicht zwingend das Recht
// auf die Einstellungsseite.
router.post('/nachsortierung', (req, res) => {
  const b = req.body || {};
  try {
    if (b.aktiv !== undefined) settings.setze('nachsortierung_aktiv', b.aktiv ? '1' : '0');
    if (b.trockenlauf !== undefined) settings.setze('nachsortierung_trockenlauf', b.trockenlauf ? '1' : '0');
    if (b.kiAktiv !== undefined) settings.setze('nachsortierung_kiAktiv', b.kiAktiv ? '1' : '0');
    if (b.takt !== undefined) {
      const takt = Math.min(720, Math.max(1, Math.round(Number(b.takt) || 24)));
      settings.setze('nachsortierung_takt', String(takt));
    }
    if (b.max !== undefined) {
      const max = Math.min(20000, Math.max(1, Math.round(Number(b.max) || 500)));
      settings.setze('nachsortierung_max', String(max));
    }
    loggen('info', 'nachsortierung', 'Einstellungen der Nachsortierung geändert.');
    res.json({ ok: true, ...nachsortierung.einstellungen() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sortierung/nachsortierung/verschieben  { konto_id, uid, von, nach }
//
// Eine einzelne Mail aus der Vorschlagsliste umlenken, ohne die Regel
// anzufassen. Der Vorbehalt gehoert dazu und steht auch in der Oberflaeche: Die
// Regel bleibt, wie sie ist, und schlaegt beim naechsten Lauf wieder zu. Wer die
// Ursache beseitigen will, aendert die Regel — dafuer gibt es den Knopf daneben.
router.post('/nachsortierung/verschieben', async (req, res) => {
  const { konto_id, uid, von, nach } = req.body || {};
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(konto_id));
  if (!konto) return res.status(400).json({ error: 'Das Konto existiert nicht.' });
  const nummer = Number(uid);
  if (!Number.isInteger(nummer) || nummer <= 0) return res.status(400).json({ error: 'Ungültige UID.' });
  const quelle = String(von || '').trim();
  const ziel = String(nach || '').trim();
  if (!quelle || !ziel) return res.status(400).json({ error: 'Quell- und Zielordner sind Pflicht.' });

  try {
    const zugang = themen.zugang(konto);
    // Zielordner sicherstellen und die Schreibweise des Servers holen — sonst
    // scheitert der Umzug an "INBOX.Rechnungen" vs. "Rechnungen".
    try { await imap.ordnerErstellen({ ...konto, ...zugang }, ziel); } catch { /* Best Effort */ }
    const pfad = (await themen.ordnerPfad(konto, ziel)) || ziel;

    const r = await imap.mailsVerschieben({
      ...zugang, mails: [{ uid: nummer }], von: quelle, nach: pfad,
    });
    if (r.verschoben.length === 0) {
      return res.status(400).json({ error: r.fehler[0]?.grund || 'Die Mail ließ sich nicht verschieben.' });
    }
    // Was die KI einmal in den Quellordner gelernt hat, zoege die naechste Mail
    // sonst wieder dorthin — ohne KI und ohne dass es auffiele.
    try { themen.gelerntVergessen(konto.id, quelle, req.body?.absender || ''); } catch { /* egal */ }

    // (KI-Nachsortierung) Lerneffekt: Wenn ein KI-Vorschlag übernommen wird,
    // behandeln wir das als "bestätigt" und lassen die Automatik daraus lernen.
    //
    // Bis Build 251 geschah das über `UPDATE quarantine_log … WHERE uid = ?` —
    // mit der UID aus dem QUELLORDNER. Das Protokoll führt aber Posteingangs-
    // UIDs: Getroffen wurde eine beliebige andere Zeile, deren Ziel dann
    // überschrieben war. Fand sich keine, entstand eine Scheinzeile mit ki=1
    // und dieser UID, und die Budget-Prüfung übersprang daraufhin 26 Stunden
    // lang die Posteingangs-Mail mit derselben Nummer.
    //
    // Jetzt: ein eigener Beleg ohne UID (keine Verwechslung möglich), ki=0
    // (entschieden hat der Nutzer), mit Grund — und gelernt wird mit der
    // Nutzer-Schwelle.
    if (req.body?.isKI && req.body?.absender) {
      try {
        db.prepare(
          'INSERT INTO quarantine_log (konto, von, betreff, zielordner, ki, grund, quell_ordner)'
          + ' VALUES (?, ?, ?, ?, 0, ?, ?)',
        ).run(
          konto.name, String(req.body.absender), req.body.betreff ? String(req.body.betreff).slice(0, 300) : null,
          pfad, `Nachsortierung: KI-Vorschlag von Hand übernommen (aus „${quelle}")`, quelle,
        );
        if (themen.einstellungen().regelLernen) {
          themen.regelLernen(konto.id, req.body.absender, pfad, { schwelle: themen.LERNSCHWELLE_NUTZER });
        }
      } catch { /* best effort */ }
    }

    loggen('info', 'nachsortierung', `Einzelne Mail von "${quelle}" nach "${pfad}" verschoben (${konto.name}).`);
    res.json({ ok: true, ordner: pfad });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sortierung/nachsortierung/start  { trockenlauf }
//
// Antwortet sofort und laesst den Lauf weiterarbeiten. Ein Postfach mit 20.000
// Mails braucht Minuten — die Oberflaeche liefe sonst in ihr Zeitlimit, und der
// Nutzer haette keine Ahnung, ob noch etwas passiert.
router.post('/nachsortierung/start', (req, res) => {
  if (nachsortierung.laeuftGerade()) {
    return res.status(409).json({ error: 'Es läuft bereits eine Nachsortierung.' });
  }
  // Ohne ausdrückliche Angabe wird geprüft, nicht verschoben. Ein Knopf, der
  // beim Verrutschen tausende Mails bewegt, hat die falsche Voreinstellung.
  const trockenlauf = req.body?.trockenlauf !== false;
  nachsortierung.lauf({ trockenlauf })
    .catch((err) => loggen('error', 'nachsortierung', `Lauf gescheitert: ${err.message}`));
  res.json({ ok: true, gestartet: true, trockenlauf });
});

module.exports = router;
// Fuer die Tests: die Gruppierung laesst sich so ohne HTTP pruefen.
module.exports.nachDomain = nachDomain;
module.exports.OHNE_DOMAIN = OHNE_DOMAIN;
