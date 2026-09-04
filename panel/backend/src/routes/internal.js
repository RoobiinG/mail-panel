// Endpunkte fuer die n8n-Workflows (Header X-Panel-Secret, siehe middleware/internalAuth).
const express = require('express');
const db      = require('../db');
const listen  = require('../services/listen');
const dnsbl   = require('../services/dnsbl');
const safebrowsing = require('../services/safebrowsing');
const clamav  = require('../services/clamav');
const google  = require('../services/google');
const sortierung = require('../services/sortierung');
const budget  = require('../services/budget');
const belegLeser = require('../services/belegLeser');
const settings = require('../services/settings');
const themen  = require('../services/themen');
const imap    = require('../services/imap');
const { entschluesseln } = require('../services/crypto');

const router = express.Router();

const einstellung = (key, fallback) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : fallback;
};

const kontoZeile = (name) =>
  (name ? db.prepare('SELECT * FROM accounts WHERE name = ? AND aktiv = 1').get(String(name)) : null);

// Die Kategorie-Zielordner des Kontos. Sie stehen zwar im Set-Knoten der Triage,
// gingen aber im Normalisierer verloren — der baut ein frisches Item ohne sie.
// Dadurch landete bis v2.7.0.0 jedes Konto in den Standardnamen, egal was im
// Panel eingetragen war. In Workflow 04 gibt es den Set-Knoten ueberhaupt nicht.
// Deshalb kommen sie jetzt hier mit.
function kontoOrdner(kontoName) {
  const konto = kontoZeile(kontoName);
  if (!konto) return {};
  return {
    folder_spam: konto.folder_spam || '',
    folder_invoices: konto.folder_invoices || '',
    folder_orders: konto.folder_orders || '',
    folder_newsletter: konto.folder_newsletter || '',
  };
}

// Was der Workflow ueber die Themen-Sortierung wissen muss, um den Prompt zu bauen.
function themenKatalog(kontoName) {
  const aus = { aktiv: false, konfidenz_min: 1, ordner: [] };
  try {
    const e = themen.einstellungen();
    if (!e.aktiv) return aus;
    const konto = kontoZeile(kontoName);
    if (!konto) return aus;
    return {
      aktiv: true,
      konfidenz_min: e.konfidenz,
      neue_ordner: e.anlegen !== 'aus',
      ordner: themen.fuerPrompt(konto.id),
      // Namen, die als Thema nichts verloren haben — sonst schlaegt die KI
      // "Newsletter" vor, was hier abgewiesen wird und den Vorschlag verpuffen laesst.
      verboten: themen.kategorieOrdner(konto),
    };
  } catch {
    return aus;
  }
}

// ─── SORTIERUNG (VOR GEMINI) ─────────────────────────────────────────────────
router.post('/sort', (req, res) => {
  const { konto, von, betreff, uid } = req.body || {};
  if (!konto || !von) return res.status(400).json({ error: 'konto und von sind Pflicht' });

  try {
    // Finde konto_id
    const account = db.prepare('SELECT id FROM accounts WHERE name = ?').get(konto);
    if (account) {
      const match = sortierung.pruefeRegeln(account.id, von, betreff);
      // "In Ruhe lassen": Die Mail bleibt, wo sie ist. Sie laeuft zwar noch durch
      // den Workflow, wird aber am Ende (/einsortieren) nicht verschoben und
      // landet auch nicht in der Sortier-Inbox. Wichtig: nie als 'verschieben'
      // zurueckgeben — der Zielordner ist bei dieser Regelart leer.
      if (match && match.aktion === 'behalten') {
        return res.json({ aktion: 'inbox', behalten: true });
      }
      if (match) {
        return res.json({ aktion: 'verschieben', ordner: match.ordner });
      }
    }
    // Kein Treffer: Die Mail laeuft weiter durch Pruefdienste und KI. In die
    // Sortier-Inbox kommt sie erst ganz am Ende in /einsortieren — sonst stuende
    // jede Mail doppelt drin, einmal hier und einmal nach der Klassifizierung.
    res.json({ aktion: 'inbox' });
  } catch (err) {
    res.json({ aktion: 'inbox', fehler: err.message }); // Fehler blockieren den Mail-Fluss nicht
  }
});

// Ein Aufruf prüft alles, was das Panel über eine Mail sagen kann.
// Reihenfolge ist bewusst: Whitelist gewinnt immer, dann Blacklist, dann DNSBL.
// Budget-Wächter: Vor dem Gemini-Aufruf fragt der Sammel-Knoten von Workflow 04
// hier, welche seiner Mails heute noch drankommen. Siehe services/budget.js.
// Wie /budget, gibt aber die erlaubten Mails komplett zurück — der Budget-Knoten
// in Workflow 04 reicht sie direkt an Gemini weiter. Grosszuegiges Limit, weil
// der ganze Bestand auf einmal ankommen kann.
// Den Budget-Waechter ruft ausschliesslich der Sammel-Knoten der Bestands-Triage
// (Workflow 04). Jeder Aufruf ist damit ein Bestandslauf — das ist der
// zuverlaessigste Zeitstempel dafuer, ganz ohne n8n danach zu fragen.
function bestandslaufMerken(durch, gesamt) {
  try {
    settings.setze('bestand_letzter_lauf', new Date().toISOString());
    settings.setze('bestand_letzter_lauf_anzahl', String(durch ?? 0));
    settings.setze('bestand_letzter_lauf_gesamt', String(gesamt ?? 0));
  } catch { /* ein fehlender Zeitstempel darf den Lauf nicht aufhalten */ }
}

router.post('/budget-filter', express.json({ limit: '25mb' }), (req, res) => {
  try {
    const ergebnis = budget.filtern((req.body || {}).mails);
    bestandslaufMerken(ergebnis.mails?.length, ergebnis.gesamt);
    res.json(ergebnis);
  } catch (err) {
    console.error('Budget-Filter-Fehler:', err.message);
    res.status(500).json({ error: err.message, mails: [] });
  }
});

router.post('/budget', express.json({ limit: '512kb' }), (req, res) => {
  try {
    const ergebnis = budget.entscheiden((req.body || {}).kandidaten);
    bestandslaufMerken(ergebnis.erlaubt?.length, ergebnis.gesamt);
    res.json(ergebnis);
  } catch (err) {
    // Scheitert das Panel hier, soll die Triage lieber nichts tun als das
    // Tageslimit sprengen — der Sammel-Knoten wertet ein Fehlen als "keine".
    console.error('Budget-Fehler:', err.message);
    res.status(500).json({ error: err.message, erlaubt: [] });
  }
});

// Beleg-Leser: Der Beleg-Knoten in Workflow 07 schickt ein PDF hierher. Das
// Panel liest es per Gemini aus und entscheidet, OB es ein aufbewahrenswerter
// Beleg ist (AGB/Werbung ⇒ nicht). Der Schluessel bleibt im Panel, wie beim
// Google-Token. Grosses Limit, weil ein PDF als base64 mehrere MB haben kann.
// Scheitert hier etwas, faellt der Leser auf eine Heuristik zurueck.
router.post('/beleg-auslesen', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    res.json(await belegLeser.auslesen(req.body || {}));
  } catch (err) {
    console.error('Beleg-Auslesen-Fehler:', err.message);
    // Nichts ablegen ist besser als ein Fremd-PDF im Belege-Ordner.
    res.status(500).json({ speichern: false, dokumenttyp: 'kein_beleg', fehler: err.message });
  }
});

router.post('/check', async (req, res) => {
  const { von = '', ip = null, links = [], konto = null } = req.body || {};
  const ergebnis = {
    entscheidung: 'weiter',   // weiter | freigeben | quarantaene
    score_aufschlag: 0,
    // Der Workflow soll den im Panel eingestellten Schwellwert benutzen
    spam_schwellwert: Number(einstellung('spam_schwellwert', '0.8')),
    gruende: [],
    dnsbl_treffer: [],
    // Themen-Katalog des Kontos: Daraus baut der Workflow den Gemini-Prompt.
    // Fehlt das Konto oder ist die Automatik aus, laeuft alles wie bisher.
    themen: themenKatalog(konto),
    // Die im Panel eingetragenen Kategorie-Ordner dieses Kontos
    ordner: kontoOrdner(konto),
  };

  try {
    const weiss = listen.pruefe(von, 'whitelist');
    if (weiss) {
      ergebnis.entscheidung = 'freigeben';
      ergebnis.gruende.push(`Whitelist: ${weiss}`);
      return res.json(ergebnis);
    }

    const schwarz = listen.pruefe(von, 'blacklist');
    if (schwarz) {
      ergebnis.entscheidung = 'quarantaene';
      ergebnis.score_aufschlag = 1;
      ergebnis.gruende.push(`Blacklist: ${schwarz}`);
      return res.json(ergebnis);
    }

    if (ip) {
      const listenNamen = JSON.parse(einstellung('dnsbl_listen', '[]'));
      const { treffer, nichtNutzbar } = await dnsbl.pruefeIp(ip, listenNamen);
      if (treffer.length > 0) {
        ergebnis.dnsbl_treffer = treffer;
        // Ein Treffer allein reicht nicht für die Quarantäne — er erhöht den
        // Score, den finale Bewertung trifft weiterhin die KI. Zwei oder mehr
        // Treffer sind ein deutliches Signal.
        ergebnis.score_aufschlag += treffer.length >= 2 ? 0.6 : 0.3;
        ergebnis.gruende.push(`DNSBL-Treffer (${ip}): ${treffer.join(', ')}`);
      }
      if (nichtNutzbar.length > 0) {
        ergebnis.hinweis = `Nicht abfragbar: ${nichtNutzbar.map((n) => `${n.liste} (${n.code})`).join(', ')}`;
      }
    }
    
    const safebrowsingAktiv = einstellung('safebrowsing_aktiv', '0') === '1';
    if (safebrowsingAktiv && links && links.length > 0) {
      const sbResult = await safebrowsing.pruefeLinks(links);
      if (!sbResult.clean) {
        ergebnis.score_aufschlag += 0.8;
        ergebnis.gruende.push(`Safe Browsing: Schädliche Links gefunden (${sbResult.treffer.join(', ')})`);
      }
    }

    res.json(ergebnis);
  } catch (err) {
    // Eine gescheiterte Prüfung darf die Mail-Verarbeitung nicht aufhalten
    res.json({ ...ergebnis, fehler: err.message });
  }
});

// Konfiguration fuer die Workflows (Schwellwerte, Listen)
router.get('/config', (req, res) => {
  res.json({
    spam_schwellwert: Number(einstellung('spam_schwellwert', '0.8')),
    dnsbl_listen: JSON.parse(einstellung('dnsbl_listen', '[]')),
    clamav_aktiv: einstellung('clamav_aktiv', '1') === '1',
    safebrowsing_aktiv: einstellung('safebrowsing_aktiv', '0') === '1',
  });
});

// Triage-Ergebnis festhalten — fuellt Dashboard, Quarantaene-Tab und Newsletter-Seite.
// Aufgerufen von /log und von /einsortieren.
function triageProtokollieren(b) {
  db.prepare(`
    INSERT INTO quarantine_log (konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, list_unsubscribe, virus_name, dnsbl_treffer, thema, konfidenz, uid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(b.konto), String(b.von), b.betreff ?? null, b.kategorie ?? null,
    b.spam_score != null ? Number(b.spam_score) : null, b.zielordner ?? null,
    b.kurzfassung ?? null, b.list_unsubscribe ?? null, b.virus_name ?? null,
    b.dnsbl_treffer ? JSON.stringify(b.dnsbl_treffer) : null,
    b.thema ?? null, b.konfidenz != null ? Number(b.konfidenz) : null,
    b.uid != null ? String(b.uid) : null,
  );

  // Newsletter-Absender fuer die Abbestellen-Seite mitzaehlen
  if (b.kategorie === 'newsletter') {
    db.prepare(`
      INSERT INTO newsletter_senders (absender, anzahl, list_unsubscribe, zuletzt_gesehen)
      VALUES (?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(absender) DO UPDATE SET
        anzahl = anzahl + 1,
        list_unsubscribe = COALESCE(excluded.list_unsubscribe, list_unsubscribe),
        zuletzt_gesehen = CURRENT_TIMESTAMP
    `).run(String(b.von), b.list_unsubscribe ?? null);
  }
}

router.post('/log', (req, res) => {
  const b = req.body || {};
  if (!b.konto || !b.von) return res.status(400).json({ error: 'konto und von sind Pflicht' });
  triageProtokollieren(b);
  res.json({ ok: true });
});

// Letzter Schritt der Triage: protokollieren und den endgueltigen Zielordner
// festlegen. Der Workflow liefert seine Kategorie-Entscheidung mit, das Panel
// entscheidet darueber hinaus ueber das Thema — denn nur hier laesst sich der
// Ordnername pruefen, der Ordner anlegen und die Obergrenze durchsetzen.
//
// Rangfolge: ziel_fest (Spam, Blacklist, Virus) > Thema > Kategorie > Posteingang.
router.post('/einsortieren', async (req, res) => {
  const b = req.body || {};
  // Faellt hier irgendetwas aus, soll die Mail wenigstens dort landen, wo der
  // Workflow sie ohnehin hingelegt haette.
  // Die Antwort ersetzt im Workflow das ganze Item — sie muss deshalb alles
  // enthalten, was danach noch gebraucht wird: konto fuer die Weiche, uid und
  // zielordner fuer den Verschiebe-Knoten.
  const rueckfall = {
    konto: b.konto ?? null,
    uid: b.uid ?? null,
    kategorie: b.kategorie ?? null,
    zielordner: b.zielordner ?? null,
    neu_angelegt: false,
    grund: '',
  };
  try {
    if (!b.konto || !b.von) return res.status(400).json({ ...rueckfall, error: 'konto und von sind Pflicht' });

    const konto = kontoZeile(b.konto);
    let ordner = b.zielordner ?? null;
    let neuAngelegt = false;
    let grund = '';
    let ausThema = false;

    // "In Ruhe lassen": eine eigene Regel sagt, diese Mail soll unangetastet
    // bleiben. Sie sticht die KI-Einordnung — aber NICHT ziel_fest: Ein Virus
    // oder Blacklist-Treffer gehoert in die Quarantaene, auch wenn der Absender
    // sonst in Ruhe gelassen wird.
    const inRuhe = !b.ziel_fest && konto
      && sortierung.istBehalten(konto.id, b.von, b.betreff);

    if (b.ziel_fest) {
      grund = 'Spam, Blacklist oder Virus — Ziel steht fest';
    } else if (inRuhe) {
      ordner = null;
      grund = 'Eigene Regel: bleibt unangetastet im Posteingang';
    } else if (konto) {
      const t = await themen.aufloesen({
        konto, vorschlag: b.thema, konfidenz: b.konfidenz, von: b.von,
      });
      grund = t.grund;
      neuAngelegt = t.neu_angelegt;
      // Thema schlaegt Kategorie: Ein Games-Newsletter landet in Games.
      if (t.ordner) { ordner = t.ordner; ausThema = true; }
    } else {
      grund = `Unbekanntes Konto: ${b.konto}`;
    }

    // Existiert der Ordner ueberhaupt? Fehlt er, bricht der Verschiebe-Knoten
    // den ganzen n8n-Lauf ab ("No folder Newsletter") und die Mail bleibt
    // unbearbeitet liegen, ohne dass im Panel etwas davon zu sehen waere.
    // Themen-Ordner sind eben erst geprueft oder angelegt worden — zu pruefen
    // sind die Kategorie-Ordner aus der Konto-Konfiguration.
    if (ordner && konto && !ausThema) {
      if (!(await themen.ordnerExistiert(konto, ordner))) {
        grund = `Zielordner "${ordner}" existiert im Postfach nicht — bitte im Konto anlegen lassen`;
        ordner = null;
      }
    }

    triageProtokollieren({ ...b, zielordner: ordner });

    // Erst nach dem Protokollieren zaehlen — sonst uebersieht die Zaehlung die
    // gerade laufende Mail.
    if (ausThema && konto && themen.einstellungen().regelLernen) {
      try {
        const gelernt = themen.regelLernen(konto.id, b.von, ordner);
        // Eine frisch gelernte Regel gilt auch fuer das, was schon in der
        // Sortier-Inbox liegt. Bewusst ohne await: Der Workflow wartet auf diese
        // Antwort, und das Nachsortieren kann einen Moment dauern.
        if (gelernt) {
          sortierung.bestandAnwenden(konto, gelernt).catch((err) => {
            console.warn('Nachsortieren nach gelernter Regel fehlgeschlagen:', err.message);
          });
        }
      } catch { /* nicht kritisch */ }
    }

    // Kein Ziel: Die Mail bleibt im Posteingang und taucht in der Sortier-Inbox
    // auf — mit dem Vorschlag, den die KI gemacht hat, und dem Grund dafuer.
    // Ausser bei "in Ruhe lassen": Das ist eine bewusste Entscheidung des
    // Nutzers, sie soll nicht jedes Mal erneut zur Zuordnung vorgelegt werden.
    if (!ordner && konto && !inRuhe) {
      // Die UID immer als ganze Zahl ablegen. Frueher landete sie mal als "28",
      // mal als "28.0" in der Spalte — als Text sind das zwei verschiedene
      // Werte, und genau daran ist die Dubletten-Erkennung vorbeigelaufen: Die
      // Sortier-Inbox fuellte sich mit Mehrfach-Eintraegen derselben Mail.
      const uidText = sortierung.uidZahl(b.uid) !== null
        ? String(sortierung.uidZahl(b.uid))
        : (b.uid != null ? String(b.uid) : null);
      // Die Bestands-Triage laesst man mehrfach laufen — dieselbe Mail darf
      // dabei nicht jedes Mal neu in der Sortier-Inbox auftauchen. Stattdessen
      // wird der Eintrag mit dem frischen KI-Vorschlag aktualisiert.
      const schonDa = uidText
        ? db.prepare(
          "SELECT id FROM sort_inbox WHERE konto_id = ? AND status = 'offen'"
          + ' AND CAST(uid AS INTEGER) = CAST(? AS INTEGER)',
        ).get(konto.id, uidText)
        : null;
      if (schonDa) {
        db.prepare(
          'UPDATE sort_inbox SET betreff = ?, ki_ordner = ?, ki_konfidenz = ?, ki_grund = ? WHERE id = ?',
        ).run(
          b.betreff ?? null, b.thema ?? null,
          b.konfidenz != null ? Number(b.konfidenz) : null, grund || null, schonDa.id,
        );
      } else {
        db.prepare(`
          INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid, ki_ordner, ki_konfidenz, ki_grund)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          String(b.konto), konto.id, String(b.von), b.betreff ?? null, uidText,
          b.thema ?? null, b.konfidenz != null ? Number(b.konfidenz) : null, grund || null,
        );
      }
    }

    res.json({
      konto: b.konto,
      uid: b.uid ?? null,
      kategorie: b.kategorie ?? null,
      zielordner: ordner,
      neu_angelegt: neuAngelegt,
      grund,
    });
  } catch (err) {
    console.error('Einsortieren-Fehler:', err.message);
    res.json({ ...rueckfall, grund: `Fehler: ${err.message}` });
  }
});

// Anhang an ClamAV senden
router.post('/scan', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ clean: true, fehler: 'Keine Datei gesendet' });
    }
    
    const ergebnis = await clamav.scan(req.body);
    res.json(ergebnis);
  } catch (err) {
    console.error('ClamAV Scan Fehler:', err.message);
    // Bei Fehlern (wie Timeout) lassen wir die Mail durch, um keine Mails zu blockieren
    res.json({ clean: true, fehler: err.message });
  }
});

// Scannt alle Anhänge einer Mail. Der Workflow schickt nur Konto, UID und Ordner —
// das Panel holt die Dateien selbst per IMAP und gibt sie an ClamAV weiter.
//
// Warum nicht wie bisher die Datei mitschicken? Zwei Gründe: Der Abruf-Knoten der
// Bestands-Triage liefert überhaupt keine Dateiinhalte (nur Namen und Größen), und
// über den Umweg mit den Binärdaten wurde immer nur der erste Anhang geprüft.
// Zugangsdaten kommen ausschließlich aus der Datenbank, nie aus der Anfrage.
router.post('/scan-anhaenge', express.json({ limit: '16kb' }), async (req, res) => {
  const { konto, uid, ordner } = req.body || {};
  try {
    if (!konto) return res.status(400).json({ clean: true, fehler: 'Kein Konto angegeben.' });

    const zeile = db.prepare('SELECT * FROM accounts WHERE name = ? AND aktiv = 1').get(String(konto));
    if (!zeile) return res.status(404).json({ clean: true, fehler: `Unbekanntes Konto: ${konto}` });

    const { gefunden, anhaenge } = await imap.anhaengeHolen({
      host: zeile.host,
      port: zeile.port,
      username: zeile.username,
      passwort: entschluesseln(zeile.password_enc),
      tlsUnsicher: Boolean(zeile.tls_unsicher),
      ordner: ordner || 'INBOX',
      uid,
    });

    const dateien = [];
    let virus = null;
    for (const anhang of anhaenge) {
      if (anhang.fehler) { dateien.push({ name: anhang.name, fehler: anhang.fehler }); continue; }
      const ergebnis = await clamav.scan(anhang.inhalt);
      dateien.push({ name: anhang.name, clean: ergebnis.clean, virus: ergebnis.virus || null });
      if (!ergebnis.clean && !virus) virus = ergebnis.virus;
    }

    res.json({
      clean: virus === null,
      virus,
      // Wie viele Anhänge die Mail hat und wie viele wirklich geprüft wurden —
      // im Workflow sieht man damit sofort, ob etwas übersprungen wurde.
      gefunden,
      geprueft: dateien.filter((d) => !d.fehler).length,
      dateien,
    });
  } catch (err) {
    console.error('Anhang-Scan Fehler:', err.message);
    // Wie beim Einzel-Scan: Ein Fehler darf die Mail nicht blockieren, muss aber
    // im Ergebnis stehen, damit er im Panel sichtbar wird.
    res.json({ clean: true, fehler: err.message, gefunden: 0, geprueft: 0, dateien: [] });
  }
});

// Liefert die Log-Daten der letzten 24 Stunden, gruppiert nach Kategorie, für Workflow 02
router.get('/digest', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, virus_name 
      FROM quarantine_log 
      WHERE created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC
    `).all();

    const zusammenfassung = {
      spam: [],
      phishing: [],
      newsletter: [],
      sonstiges: [],
      quarantaene: [],
    };

    let total = 0;
    for (const row of logs) {
      total++;
      if (row.virus_name) {
        zusammenfassung.quarantaene.push(row);
      } else if (row.kategorie === 'spam') {
        zusammenfassung.spam.push(row);
      } else if (row.kategorie === 'phishing') {
        zusammenfassung.phishing.push(row);
      } else if (row.kategorie === 'newsletter') {
        zusammenfassung.newsletter.push(row);
      } else if (row.zielordner === 'Quarantine' || row.zielordner === 'Junk') {
        zusammenfassung.quarantaene.push(row);
      } else {
        zusammenfassung.sonstiges.push(row);
      }
    }

    res.json({ 
      ok: true, 
      total, 
      spam: zusammenfassung.spam, 
      phishing: zusammenfassung.phishing, 
      newsletter: zusammenfassung.newsletter, 
      quarantaene: zusammenfassung.quarantaene,
      sonstiges: zusammenfassung.sonstiges
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Frischen Google-Zugriffs-Token fuer die Kalender-Aktion in Workflow 07.
// Die Anmeldung selbst passiert im Panel — n8n bekommt hier nur einen kurzlebigen
// Token und sieht die Zugangsdaten nie.
router.get('/google-token', async (req, res) => {
  try {
    res.json(await google.zugriffsToken());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
