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
const bestand = require('../services/bestand');
const klassifizierer = require('../services/klassifizierer');
const belegLeser = require('../services/belegLeser');
const uploadFreigabe = require('../services/uploadFreigabe');
const digest  = require('../services/digest');
const settings = require('../services/settings');
const themen  = require('../services/themen');
const imap    = require('../services/imap');
const { entschluesseln } = require('../services/crypto');
const { loggen } = require('../services/panelLog');

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

// Welche Mails hat eine Regel sortiert — und nicht die KI?
//
// Diese Frage laesst sich nur HIER beantworten, vor der KI-Abfrage: Genau jetzt
// entscheidet der Workflow, welchen Zweig die Mail nimmt. Spaeter in
// /einsortieren nachzusehen, ob eine Regel passt, ergibt die falsche Antwort —
// denn das Panel lernt waehrend eines Laufs neue Regeln dazu (themen.regelLernen),
// und die wuerden Mails ruecklaeufig als "kostenlos" markieren, die laengst bei
// Gemini waren. Genau das ist passiert: Nach dem ersten grossen Lauf stand das
// KI-Tagesbudget auf 0 verbraucht, obwohl 189 Mails klassifiziert worden waren.
//
// Im Arbeitsspeicher, nicht in der Datenbank: Die Notiz gilt nur fuer die
// Minuten zwischen /sort und /einsortieren derselben Mail. Geht sie bei einem
// Neustart verloren, zaehlt die Mail als KI-Aufruf — die vorsichtige Richtung.
const perRegel = new Map();
const REGEL_MERK_MS = 2 * 60 * 60 * 1000;

function regelMerken(konto, uid) {
  if (uid == null) return;
  if (perRegel.size > 5000) {
    const grenze = Date.now() - REGEL_MERK_MS;
    for (const [k, t] of perRegel) if (t < grenze) perRegel.delete(k);
  }
  perRegel.set(`${konto}|${uid}`, Date.now());
}

function warRegelSortiert(konto, uid) {
  if (uid == null) return false;
  const schluessel = `${konto}|${uid}`;
  const zeit = perRegel.get(schluessel);
  if (zeit == null) return false;
  perRegel.delete(schluessel);
  return Date.now() - zeit < REGEL_MERK_MS;
}

// Darf heute ueberhaupt noch jemand Gemini fragen?
//
// Zwei Gruende koennen dagegensprechen, und der erste wiegt schwerer: Hat
// Google heute schon abgewiesen, ist Schluss — egal, was die eigene Zaehlung
// sagt. Die liegt naemlich zwangslaeufig darunter (siehe services/budget.js).
// Sonst zaehlt der eingestellte Deckel.
//
// Im Zweifel arbeiten lassen: Eine kaputte Pruefung darf nicht die ganze
// Sortierung anhalten.
function kiPlatzFrei() {
  try {
    if (budget.beobachteteGrenze() > 0) return false;
    const grenze = budget.tagesbudget();
    if (grenze === 0) return true; // kein Deckel gesetzt
    return budget.heuteVerbraucht() < grenze;
  } catch {
    return true;
  }
}

// ─── SORTIERUNG (VOR GEMINI) ─────────────────────────────────────────────────
router.post('/sort', (req, res) => {
  // `text` ist freiwillig und nur fuer Regeln da, die auf den Inhalt sehen.
  // Aeltere Workflow-Staende schicken ihn nicht; dann greifen Inhalts-Regeln
  // eine Station spaeter, bei der Vorpruefung vor dem KI-Aufruf.
  const { konto, von, betreff, uid, text } = req.body || {};
  if (!konto || !von) return res.status(400).json({ error: 'konto und von sind Pflicht' });

  try {
    // Finde konto_id
    const account = db.prepare('SELECT id FROM accounts WHERE name = ?').get(konto);
    if (account) {
      const match = sortierung.pruefeRegeln(account.id, von, betreff, text);
      // "In Ruhe lassen": Die Mail bleibt, wo sie ist. Sie laeuft zwar noch durch
      // den Workflow, wird aber am Ende (/einsortieren) nicht verschoben und
      // landet auch nicht in der Sortier-Inbox. Wichtig: nie als 'verschieben'
      // zurueckgeben — der Zielordner ist bei dieser Regelart leer.
      if (match && match.aktion === 'behalten') {
        return res.json({ aktion: 'inbox', behalten: true });
      }
      if (match) {
        // Diese Mail nimmt gleich den Regel-Zweig und sieht die KI nie.
        regelMerken(konto, uid);
        return res.json({ aktion: 'verschieben', ordner: match.ordner });
      }

      // Und was ohnehin schon feststeht, muss die KI auch nicht mehr sagen.
      //
      // Der Stichwort-Treffer (Ordner-Beschreibung, gelernte Absender,
      // Umleitungen) wurde bisher erst in themen.aufloesen() ausgewertet — also
      // NACH dem Gemini-Aufruf. Die Mail wurde bezahlt und dann von etwas
      // entschieden, das schon vorher feststand. Damit war das Versprechen
      // „einmal von der KI geschlossen, danach wörtliches Wissen" nie eingelöst:
      // Der zweite Absender derselben Firma kostete genauso viel wie der erste.
      //
      // Hier oben kostet er nichts. Der Zweig existiert schon — es ist derselbe,
      // den die eigenen Regeln nehmen.
      try {
        if (themen.einstellungen().aktiv) {
          const stich = themen.stichwortTreffer(account.id, von, betreff);
          if (stich && stich.ordner) {
            regelMerken(konto, uid);
            return res.json({
              aktion: 'verschieben',
              ordner: stich.ordner,
              grund: `Stichwort „${stich.wort}" (${stich.wo === 'absender' ? 'Absender' : 'Betreff'})`,
            });
          }
        }
      } catch { /* im Zweifel laeuft die Mail eben normal weiter zur KI */ }
    }

    // Ist fuer heute ueberhaupt noch KI-Kontingent da?
    //
    // Der Deckel schuetzte bisher nur die Bestands-Triage. Neu eintreffende Post
    // fragte gar nicht erst: Jede Mail rannte in Gemini, bekam "too many
    // requests", wiederholte es fuenfmal und stand danach als fehlgeschlagener
    // Lauf da — 21 Sekunden fuer nichts, und das bei jeder einzelnen Mail.
    //
    // Diese Pruefung steht ganz bewusst NACH den Regeln und Stichworten: Die
    // kosten kein Kontingent und muessen weiterarbeiten, auch wenn Google fuer
    // heute zu hat.
    //
    // Der Ausstieg braucht keinen neuen Knoten. "Verschieben?" prueft, ob ein
    // Zielordner dasteht — ohne einen laeuft die Mail nach "Bleibt in der
    // Inbox". Genau das ist hier gewollt: nichts anfassen, nichts
    // protokollieren. Die Mail bleibt ungelesen liegen und wird spaeter von der
    // Bestands-Triage geholt, die ihr eigenes Budget verwaltet.
    if (!kiPlatzFrei() || klassifizierer.istBeschaeftigt()) {
      return res.json({
        aktion: 'verschieben',
        ordner: null,
        warten: true,
        grund: 'KI-Kontingent aufgebraucht oder KI ist ausgelastet — die Mail bleibt liegen und wird vom Bestands-Workflow verarbeitet',
      });
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

// Mails, die wegen einer "In Ruhe lassen"-Regel uebersprungen wurden, sind
// entschieden — sie bleiben liegen. Ohne Vermerk wuerde das Panel sie bei jedem
// Lauf erneut anbieten und damit Plaetze im Auswahlfenster verbrauchen.
//
// Der Ordner kommt aus der Mail, wenn sie einen mitbringt — sonst aus dem, was
// die Auswahl für dieses Konto zuletzt ausgesucht hat. Der Sammel-Knoten in n8n
// schickt nur konto, von, betreff und uid (workflowPatcher.js, budgetInSammeln);
// den Ordner weiß nur das Panel selbst (services/bestand.js).
function ruheVermerken(mails) {
  for (const m of mails || []) {
    if (!m || m.uid == null) continue;
    const konto = kontoZeile(m.konto);
    if (konto) bestand.erledigtMerken(konto.id, m.ordner || bestand.letzterOrdner(konto.id), m.uid, 'ruhe');
  }
}

// Welche Mails hat der Buendel-Klassifizierer bearbeitet?
//
// Er zaehlt seine Anfragen selbst (eine je Buendel, nicht je Mail). Damit
// /einsortieren fuer dieselben Mails nicht noch einmal je Mail eine Anfrage
// vermerkt, merkt er sich hier, wen er in der Hand hatte — dieselbe Bauart wie
// regelMerken() weiter oben, aus demselben Grund: Die Frage laesst sich nur im
// Moment der Klassifizierung beantworten.
const perBuendel = new Map();

function buendelMerken(konto, uid) {
  if (uid == null) return;
  if (perBuendel.size > 20000) {
    const grenze = Date.now() - REGEL_MERK_MS;
    for (const [k, t] of perBuendel) if (t < grenze) perBuendel.delete(k);
  }
  perBuendel.set(`${konto}|${uid}`, Date.now());
}

function warGebuendelt(konto, uid) {
  if (uid == null) return false;
  const schluessel = `${konto}|${uid}`;
  const zeit = perBuendel.get(schluessel);
  if (zeit == null) return false;
  perBuendel.delete(schluessel);
  return Date.now() - zeit < REGEL_MERK_MS;
}

router.post('/budget-filter', express.json({ limit: '25mb' }), (req, res) => {
  try {
    const ergebnis = budget.filtern((req.body || {}).mails);
    ruheVermerken((ergebnis.ruheMails || []).map((m) => (m && m.json) || m));
    bestandslaufMerken(ergebnis.mails?.length, ergebnis.gesamt);
    res.json(ergebnis);
  } catch (err) {
    console.error('Budget-Filter-Fehler:', err.message);
    res.status(500).json({ error: err.message, mails: [] });
  }
});

// Welche Mails soll die Bestands-Triage in diesem Lauf ueberhaupt holen? Der
// Auswahl-Knoten am Anfang von Workflow 04 fragt hier nach den UIDs — siehe
// services/bestand.js, warum das noetig ist.
router.post('/bestand-kandidaten', express.json(), async (req, res) => {
  try {
    const grenze = Number((req.body || {}).limit) || 0;
    const auswahl = await bestand.kandidaten(grenze);
    // Diesen Knoten ruft jeder Bestandslauf als Erstes auf — auch einer, der am
    // Ende nichts zu tun findet. Damit stimmt "zuletzt gelaufen" im Dashboard
    // auch dann, wenn gar nichts mehr zu sortieren war.
    try { settings.setze('bestand_letzter_lauf', new Date().toISOString()); } catch { /* egal */ }
    res.json(auswahl);
  } catch (err) {
    console.error('Bestand-Kandidaten-Fehler:', err.message);
    // Ohne Auswahl holt der IMAP-Knoten nichts — besser als der alte Zustand,
    // in dem er wieder bei den aeltesten hundert Mails angefangen haette.
    res.status(500).json({ error: err.message, konten: {}, offen: {} });
  }
});

// Alle Mails eines Bestandslaufs auf einmal klassifizieren.
//
// Der Knoten "Gemini klassifizieren" in Workflow 04 ist deshalb kein
// HTTP-Knoten mehr, sondern ein Code-Knoten, der genau hier anklopft: Googles
// Tageslimit zaehlt ANFRAGEN, nicht Mails. Eine Anfrage je Mail waren 500 Mails
// am Tag; zwanzig Mails je Anfrage sind zehntausend. Siehe
// services/klassifizierer.js.
//
// Grosses Limit, weil der ganze Lauf auf einmal ankommt. Faellt hier etwas aus,
// gibt der Knoten keine Items aus — die Mails bleiben unangetastet liegen und
// kommen im naechsten Lauf wieder.
router.post('/klassifizieren', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const mails = (req.body || {}).mails;
    const ergebnis = await klassifizierer.klassifizieren(mails);
    // Diese Mails sind bezahlt bzw. vorab durch Regeln entschieden.
    // /einsortieren soll für Regel-Mails keine KI verbuchen (ki: 0), für KI-Mails kein zweites Mal.
    (Array.isArray(mails) ? mails : []).forEach((m, i) => {
      const erg = ergebnis.ergebnisse[i];
      if (erg) {
        if (erg.regel) {
          regelMerken(m && m.konto, m && m.uid);
        } else {
          buendelMerken(m && m.konto, m && m.uid);
        }
      }
    });
    res.json(ergebnis);
  } catch (err) {
    console.error('Klassifizier-Fehler:', err.message);
    res.status(500).json({ error: err.message, ergebnisse: [] });
  }
});

router.post('/budget', express.json({ limit: '512kb' }), (req, res) => {
  try {
    const kandidaten = (req.body || {}).kandidaten;
    const ergebnis = budget.entscheiden(kandidaten);
    ruheVermerken((ergebnis.ruheIndizes || []).map((i) => (kandidaten || [])[i]));
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

// Das Datum aus der Date-Kopfzeile, wie es der Normalisierer mitschickt.
//
// Es kommt aus der Mail — also aus der Hand des Absenders. Ein kaputtes oder
// absichtlich verdrehtes Datum („Jahr 2099", damit die Werbung ganz oben steht)
// soll die Chronik nicht durcheinanderbringen: Was sich nicht lesen lässt oder
// mehr als einen Tag in der Zukunft liegt, wird verworfen.
function mailDatum(roh) {
  if (roh == null || roh === '') return null;
  const d = new Date(roh);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < Date.UTC(1990, 0, 1) || ms > Date.now() + 24 * 60 * 60 * 1000) return null;
  return d.toISOString();
}

// Der Ordner, aus dem die Mail kam. Workflow 01 schickt keinen mit — dort ist
// es immer der Posteingang.
const quellOrdner = (b) => String((b && b.ordner) || 'INBOX').slice(0, 200);
const istPosteingang = (ordner) => String(ordner || 'INBOX').toUpperCase() === 'INBOX';

// Zeigt das Ziel auf den Ordner, in dem die Mail schon liegt? „INBOX.Rechnungen"
// und „Rechnungen" sind auf manchen Servern derselbe Ordner.
function selberOrdner(a, b) {
  const kurz = (x) => String(x || '').trim().toLowerCase().replace(/^inbox[./]/, '');
  return kurz(a) !== '' && kurz(a) === kurz(b);
}

// Triage-Ergebnis festhalten — fuellt Dashboard, Quarantaene-Tab und Newsletter-Seite.
// Aufgerufen von /log und von /einsortieren.
function triageProtokollieren(b) {
  db.prepare(`
    INSERT INTO quarantine_log (konto, von, betreff, kategorie, spam_score, zielordner, kurzfassung, list_unsubscribe, virus_name, dnsbl_treffer, thema, konfidenz, uid, ki, grund, quell_ordner, mail_datum)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(b.konto), String(b.von), b.betreff ?? null, b.kategorie ?? null,
    b.spam_score != null ? Number(b.spam_score) : null, b.zielordner ?? null,
    b.kurzfassung ?? null, b.list_unsubscribe ?? null, b.virus_name ?? null,
    b.dnsbl_treffer ? JSON.stringify(b.dnsbl_treffer) : null,
    b.thema ?? null, b.konfidenz != null ? Number(b.konfidenz) : null,
    b.uid != null ? String(b.uid) : null,
    b.ki === 0 ? 0 : 1,
    // Warum diese Mail dort gelandet ist. Ohne die Zeile steht in der Chronik
    // zwar, WAS entschieden wurde, aber nie WESHALB — und danach fragt man bei
    // einer Fehleinordnung als Erstes.
    b.grund ? String(b.grund).slice(0, 500) : null,
    b.ordner ? String(b.ordner).slice(0, 200) : null,
    mailDatum(b.datum),
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

// Der Nextcloud-Ordner-/Upload-Knoten in Workflow 07 läuft absichtlich mit
// onError: continueErrorOutput weiter (ein einzelner fehlgeschlagener Beleg
// soll nicht den ganzen Lauf stoppen). Damit ein echter Fehler (falsches
// Passwort, volle Quota, falscher Pfad) trotzdem sichtbar wird, meldet der
// nachgeschaltete Fehler-Knoten ihn hierüber ins Panel-Log.
router.post('/nextcloud-fehler', (req, res) => {
  const b = req.body || {};
  const dateiname = String(b.dateiname || '').slice(0, 200);
  const aktion = String(b.aktion_name || '').slice(0, 200);
  const fehler = String(b.fehler || 'unbekannt').slice(0, 500);
  loggen('error', 'aktionen:nextcloud', `Upload fehlgeschlagen (Aktion "${aktion}", Datei "${dateiname}"): ${fehler}`);
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
    ordner: b.ordner || 'INBOX',
  };
  try {
    if (!b.konto || !b.von) {
      const k = kontoZeile(b.konto);
      if (k && b.uid != null) {
        bestand.erledigtMerken(k.id, b.ordner || bestand.letzterOrdner(k.id), b.uid, 'unklar');
      }
      return res.status(400).json({ ...rueckfall, error: 'konto und von sind Pflicht' });
    }

    const konto = kontoZeile(b.konto);
    let ordner = b.zielordner ?? null;
    let neuAngelegt = false;
    let grund = '';
    let ausThema = false;
    // Unter welchem Namen ein KI-Vorschlag geführt wird — nicht zwingend das
    // Wort, das die KI geschrieben hat (siehe themen.aufloesen).
    let vorschlagName = null;
    const quelle = quellOrdner(b);

    // "In Ruhe lassen": eine eigene Regel sagt, diese Mail soll unangetastet
    // bleiben. Sie sticht die KI-Einordnung — aber NICHT ziel_fest: Ein Virus
    // oder Blacklist-Treffer gehoert in die Quarantaene, auch wenn der Absender
    // sonst in Ruhe gelassen wird.
    // Einmal nachsehen, ob eine eigene Regel greift — die Antwort wird gleich
    // dreifach gebraucht: fuer "in Ruhe lassen", fuer den Vermerk und fuer die
    // Frage, ob dieser Mail ueberhaupt ein KI-Aufruf zuzurechnen ist.
    const regel = konto ? sortierung.regelTreffer(konto.id, b.von, b.betreff, b.text) : null;
    const inRuhe = !b.ziel_fest && Boolean(regel)
      && (regel.aktion || 'verschieben') === 'behalten';

    if (b.ziel_fest) {
      // „Spam, Blacklist oder Virus" sagt nicht, welches davon. Genau das ist
      // aber die Frage, wenn eine harmlose Mail in der Quarantaene liegt.
      grund = b.virus_name
        ? `Virus gefunden: ${b.virus_name}`
        : b.spam_score != null
          ? `Spam-Wert ${Number(b.spam_score).toFixed(2)} — Ziel steht fest`
          : 'Blacklist oder feste Vorgabe — Ziel steht fest';
    } else if (inRuhe) {
      ordner = null;
      grund = 'Eigene Regel: bleibt unangetastet im Posteingang';
      // Diese Mail ist entschieden und bleibt liegen: nicht wieder anbieten.
      bestand.erledigtMerken(konto.id, b.ordner || bestand.letzterOrdner(konto.id), b.uid, 'ruhe');
    } else if (konto) {
      const t = await themen.aufloesen({
        konto, vorschlag: b.thema, konfidenz: b.konfidenz, von: b.von, betreff: b.betreff,
      });
      grund = t.grund;
      neuAngelegt = t.neu_angelegt;
      vorschlagName = t.vorschlag_ordner || null;
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
    //
    // Geprüft wird jetzt AUCH bei Themen-Ordnern. Sie sind zwar eben erst
    // angelegt worden, aber der Name, unter dem der Server sie führt, muss
    // deshalb nicht derselbe sein: Wo alles unter dem Posteingang liegt, heißt
    // der Ordner `INBOX.Rechnungen`. Genau daran scheiterte am 12.09. ein Lauf
    // mit 120 Mails — die Prüfung sagte „existiert" (der Suffix passte), als
    // Ziel ging aber der kurze Name hinaus, und der IMAP-Knoten antwortete
    // „Unable to move email".
    //
    // themen.ordnerPfad() gibt deshalb den Pfad in der Schreibweise des Servers
    // zurück, und genau der wird weitergereicht.
    if (ordner && konto) {
      const echt = await themen.ordnerPfad(konto, ordner);
      if (echt) {
        ordner = echt;
      } else {
        try {
          await imap.ordnerErstellen(themen.zugang(konto), ordner);
          themen.cacheVerwerfen(konto.id);
          // Unter welchem Pfad der Server den Ordner nun führt, weiß nur er —
          // also noch einmal nachsehen, jetzt mit frischer Liste.
          ordner = (await themen.ordnerPfad(konto, ordner)) || ordner;
          loggen('info', 'themen', `${konto.name}: Fehlender Zielordner "${ordner}" wurde im Postfach angelegt und abonniert.`);
        } catch (createErr) {
          loggen('warn', 'themen', `${konto.name}: Zielordner "${ordner}" konnte nicht im Postfach angelegt werden: ${createErr.message}`);
          grund = `Zielordner "${ordner}" existiert im Postfach nicht — bitte im Konto anlegen lassen`;
          ordner = null;
        }
      }
    }

    // Liegt die Mail schon dort, wo sie hinsoll? Seit der Bestandslauf auch
    // Ordner außerhalb des Posteingangs durchgeht, kommt das ständig vor: Eine
    // Rechnung in „Rechnungen" wird als Rechnung erkannt. Bisher bekam der
    // Verschiebe-Knoten dann „von Rechnungen nach Rechnungen", und weil eine
    // Mail mit Zielordner nie als erledigt vermerkt wird, stand sie beim
    // nächsten Lauf wieder im Fenster — jede Stunde aufs Neue.
    let liegtRichtig = false;
    if (ordner && selberOrdner(quelle, ordner)) {
      grund = `Liegt schon in „${quelle}" — nichts zu verschieben`;
      ordner = null;
      liegtRichtig = true;
      if (konto) bestand.erledigtMerken(konto.id, quelle, b.uid, 'richtig');
    }

    // Eine Mail, die eine Regel trifft, laeuft im Workflow vor der KI-Abfrage
    // ab ("Gleich sortieren?"). Sie als KI-Aufruf zu zaehlen, haette das
    // Tagesbudget genau dann leergesaugt, wenn man sich Regeln angelegt hat.
    // Massgeblich ist der Vermerk aus /sort — nicht, ob jetzt gerade eine Regel
    // passt: Die kann in diesem Lauf erst dazugelernt worden sein.
    const perKi = !warRegelSortiert(b.konto, b.uid);

    // Was ins Protokoll kommt, muss die Entscheidung erklaeren, die wirklich
    // gefallen ist. Eine Mail, die schon in /sort von einer eigenen Regel oder
    // einem Stichwort abgebogen ist, hat die KI nie gesehen — themen.aufloesen()
    // lief dann ins Leere und meldet "Kein Thema erkannt". Das im Protokoll
    // stehen zu lassen, waere schlicht falsch und wuerde bei der Fehlersuche in
    // die verkehrte Richtung zeigen.
    let protokollGrund = grund;
    if (!perKi && !ausThema && !b.ziel_fest && !inRuhe && !liegtRichtig) {
      protokollGrund = regel
        ? `Eigene Regel [${regel.typ}] ${regel.muster} → ${regel.zielordner}`
        : 'Vor der KI entschieden — eigene Regel oder Stichwort';
    }
    triageProtokollieren({ ...b, zielordner: ordner, ki: perKi ? 1 : 0, grund: protokollGrund });

    // Und was hat diese Mail an Kontingent gekostet?
    //
    // Der Buendel-Klassifizierer zaehlt seine Anfragen selbst — eine je zwanzig
    // Mails. Workflow 01 fragt Gemini dagegen weiter direkt und je Mail; dort ist
    // eine Mail genau eine Anfrage, und gezaehlt wird sie hier. Ohne diese Zeile
    // liefe die laufende Post am Tageslimit vorbei.
    if (perKi && !warGebuendelt(b.konto, b.uid)) {
      try { budget.ausgabeMerken(1); } catch { /* ein Vermerk darf nichts aufhalten */ }
    }

    // Erst nach dem Protokollieren zaehlen — sonst uebersieht die Zaehlung die
    // gerade laufende Mail.
    if (ausThema && ordner && konto && themen.einstellungen().regelLernen) {
      try {
        // Die KI hat entschieden, nicht der Nutzer — also erst ab der Schwelle
        // für KI-Einordnungen (drei gleiche), siehe themen.LERNSCHWELLE_KI.
        const gelernt = themen.regelLernen(konto.id, b.von, ordner, { schwelle: themen.LERNSCHWELLE_KI });
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
    // Eine Mail aus einem ANDEREN Ordner als dem Posteingang gehört nicht in die
    // Sortier-Inbox. Die kennt nur den Posteingang: Jede Aktion dort verschiebt
    // „UID n aus INBOX". Stammt n aus „Rechnungen", trägt im Posteingang eine
    // ganz andere Mail dieselbe Nummer — und genau die wäre verschoben worden.
    // Solche Mails liegen ja schon in einem Ordner; sie werden als „unklar"
    // zurückgestellt und kommen in der nächsten Runde wieder dran.
    if (!ordner && konto && !inRuhe && !liegtRichtig && !istPosteingang(quelle)) {
      bestand.erledigtMerken(konto.id, quelle, b.uid, 'unklar');
    } else if (!ordner && konto && !inRuhe && !liegtRichtig) {
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
      // Die Kategorie der KI kommt mit — daraus entstehen in der Sortier-Inbox
      // die Zähler und Filter ("612 persönlich, 540 sonstiges …"). Ohne sie
      // war nicht zu sehen, woraus der Stapel eigentlich besteht. Bestehende
      // Einträge bekommen sie beim nächsten Bestandslauf über das UPDATE.
      const kategorie = b.kategorie ? String(b.kategorie).slice(0, 40) : null;
      // Der Name, unter dem die Freigabe die Mail später sucht: der des
      // Vorschlags, nicht das Wort der KI.
      const kiOrdner = vorschlagName || (b.thema ?? null);
      const datum = mailDatum(b.datum);
      if (schonDa) {
        db.prepare(
          'UPDATE sort_inbox SET betreff = ?, ki_ordner = ?, ki_konfidenz = ?, ki_grund = ?,'
          + ' kategorie = COALESCE(?, kategorie), mail_datum = COALESCE(?, mail_datum),'
          + " quell_ordner = 'INBOX' WHERE id = ?",
        ).run(
          b.betreff ?? null, kiOrdner,
          b.konfidenz != null ? Number(b.konfidenz) : null, grund || null, kategorie, datum, schonDa.id,
        );
      } else {
        db.prepare(`
          INSERT INTO sort_inbox (konto, konto_id, von, betreff, uid, ki_ordner, ki_konfidenz, ki_grund, kategorie, quell_ordner, mail_datum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INBOX', ?)
        `).run(
          String(b.konto), konto.id, String(b.von), b.betreff ?? null, uidText,
          kiOrdner, b.konfidenz != null ? Number(b.konfidenz) : null, grund || null, kategorie, datum,
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
      ordner: b.ordner || 'INBOX',
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
// Die Anhänge einer Mail als base64 — für die eigenen Aktionen in Workflow 07.
//
// Warum das nötig ist: Die Abruf-Knoten holen `attachmentsInfo`, also nur Namen
// und Größen, nicht die Dateien (siehe workflowPatcher.js). Das ist Absicht —
// bei 120 Mails je Lauf wären die Dateien eine erhebliche Last, und gebraucht
// werden sie nur in Ausnahmefällen. Der Virenscan holt sie deshalb seit jeher
// über die UID hier ab, und Workflow 07 tut das ab jetzt genauso.
//
// Ohne diesen Weg lief die Upload-Kette ins Leere: Der Beleg-Knoten suchte die
// Anhänge in `item.binary`, das in beiden Workflows leer ist. Der Lauf meldete
// „erfolgreich" nach null Sekunden, und es wurde nie eine Datei hochgeladen.
//
// Grenzen, weil eine Mail kein vertrauenswürdiger Absender ist: höchstens zehn
// Dateien und zusammen 15 MB. Was darüber liegt, kommt mit Namen und Größe,
// aber ohne Inhalt zurück — dann steht wenigstens im Lauf, warum nichts kam.
const ANHANG_MAX_ANZAHL = 10;
const ANHANG_MAX_GESAMT = 15 * 1024 * 1024;

router.post('/anhaenge', express.json({ limit: '16kb' }), async (req, res) => {
  const { konto, uid, ordner } = req.body || {};
  try {
    if (!konto) return res.status(400).json({ anhaenge: [], fehler: 'Kein Konto angegeben.' });

    const zeile = db.prepare('SELECT * FROM accounts WHERE name = ? AND aktiv = 1').get(String(konto));
    if (!zeile) return res.status(404).json({ anhaenge: [], fehler: `Unbekanntes Konto: ${konto}` });

    const { anhaenge } = await imap.anhaengeHolen({
      host: zeile.host,
      port: zeile.port,
      username: zeile.username,
      passwort: entschluesseln(zeile.password_enc),
      tlsUnsicher: Boolean(zeile.tls_unsicher),
      ordner: ordner || 'INBOX',
      uid,
    });

    const raus = [];
    let gesamt = 0;
    for (const anhang of anhaenge) {
      if (raus.length >= ANHANG_MAX_ANZAHL) break;
      if (anhang.fehler || !anhang.inhalt) {
        raus.push({ name: anhang.name, fehler: anhang.fehler || 'kein Inhalt' });
        continue;
      }
      if (gesamt + anhang.inhalt.length > ANHANG_MAX_GESAMT) {
        raus.push({ name: anhang.name, groesse: anhang.inhalt.length, fehler: 'zusammen zu groß' });
        continue;
      }
      gesamt += anhang.inhalt.length;
      raus.push({
        name: anhang.name,
        groesse: anhang.inhalt.length,
        base64: anhang.inhalt.toString('base64'),
      });
    }
    res.json({ anhaenge: raus });
  } catch (err) {
    // Die Mail kann inzwischen verschoben worden sein — Workflow 07 läuft
    // parallel zum Einsortieren. Dann ist die UID im alten Ordner weg, und das
    // ist kein Grund, den Lauf scheitern zu lassen.
    loggen('warn', 'aktionen',
      `Anhänge von ${konto}/${uid} konnten nicht geholt werden: ${err.message}`);
    res.json({ anhaenge: [], fehler: err.message });
  }
});

// Eine Datei in die Freigabe-Warteschlange legen, statt sie sofort hochzuladen.
//
// Ruft der Freigabe-Knoten in Workflow 07 auf, wenn bei der Aktion „Vor dem
// Hochladen fragen" eingeschaltet ist. Das Panel lädt danach selbst hoch —
// n8n kann nicht auf eine menschliche Entscheidung warten.
//
// 25 MB, weil eine Datei bis 15 MB als base64 rund 20 MB wiegt. Der Pfad MUSS
// in EIGENER_PARSER (index.js) stehen, sonst greift der globale 1-MB-Parser
// davor und die Einlieferung stirbt mit 413, während der Lauf Erfolg meldet.
router.post('/upload-freigabe', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const ergebnis = await uploadFreigabe.einliefern(req.body || {});
    if (!ergebnis.ok) {
      loggen('info', 'uploads',
        `Datei nicht in die Warteschlange genommen (${ergebnis.grund}): `
        + `${(req.body || {}).dateiname || 'ohne Namen'}`);
    }
    res.json(ergebnis);
  } catch (err) {
    // Niemals 5xx: Ein volles Volume darf den n8n-Lauf nicht rot färben.
    loggen('warn', 'uploads', `Einlieferung fehlgeschlagen: ${err.message}`);
    res.json({ ok: false, grund: 'fehler', fehler: err.message });
  }
});

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

    // Ist der Virenscanner überhaupt eingeschaltet? Ohne diese Frage lädt das
    // Panel jeden Anhang über IMAP herunter, um ihn dann an einen Dienst zu
    // schicken, den es nicht gibt.
    if (einstellung('clamav_aktiv', '1') !== '1') {
      return res.json({
        clean: true, virus: null, gefunden, geprueft: 0, ungeprueft: gefunden, dateien: [],
        fehler: gefunden ? 'Virenscanner ist abgeschaltet — Anhänge wurden nicht geprüft.' : null,
      });
    }

    const dateien = [];
    let virus = null;
    let ungeprueft = 0;
    for (const anhang of anhaenge) {
      if (anhang.fehler) {
        dateien.push({ name: anhang.name, fehler: anhang.fehler });
        ungeprueft += 1;
        continue;
      }
      // Ein Scanner, der nicht antwortet, darf nicht wie ein sauberes Ergebnis
      // aussehen. Genau das ist vorher passiert: Fiel ClamAV aus, kam für jede
      // Mail „clean: true" zurück — die Virenprüfung lief ins Leere, ohne dass
      // es irgendwo stand.
      try {
        const ergebnis = await clamav.scan(anhang.inhalt);
        dateien.push({ name: anhang.name, clean: ergebnis.clean, virus: ergebnis.virus || null });
        if (!ergebnis.clean && !virus) virus = ergebnis.virus;
      } catch (err) {
        ungeprueft += 1;
        dateien.push({ name: anhang.name, fehler: `Scanner nicht erreichbar: ${err.message}` });
        loggen('warn', 'virenscan',
          `Anhang "${anhang.name}" von ${konto} konnte nicht geprüft werden: ${err.message}. `
          + 'Die Mail läuft weiter — sie gilt aber NICHT als geprüft.');
      }
    }

    res.json({
      clean: virus === null,
      virus,
      // Wie viele Anhänge die Mail hat und wie viele wirklich geprüft wurden —
      // im Workflow sieht man damit sofort, ob etwas übersprungen wurde.
      gefunden,
      geprueft: dateien.filter((d) => !d.fehler).length,
      // Wie viele Anhänge NICHT geprüft werden konnten. „clean" heißt dann
      // bloß „kein Fund", nicht „nichts gefunden, weil gesucht wurde".
      ungeprueft,
      dateien,
    });
  } catch (err) {
    console.error('Anhang-Scan Fehler:', err.message);
    // Wie beim Einzel-Scan: Ein Fehler darf die Mail nicht blockieren, muss aber
    // im Ergebnis stehen, damit er im Panel sichtbar wird.
    res.json({ clean: true, fehler: err.message, gefunden: 0, geprueft: 0, dateien: [] });
  }
});

// Liefert die Log-Daten der letzten 24 Stunden, gruppiert nach Kategorie.
// Workflow 02 braucht sie seit Build 234 nicht mehr selbst (siehe
// /digest-text) — der Endpunkt bleibt für eigene Workflows bestehen.
router.get('/digest', (req, res) => {
  try {
    const { logs, ...d } = digest.daten();
    res.json(d);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Der fertige Text für den täglichen Digest (Workflow 02, Knoten
// „KI zusammenfassen"). Das Feld heißt `response` wie bei Ollama — so liest
// „Text extrahieren" ihn unverändert. Antwortet immer mit einem Text: Scheitert
// die KI, fehlt nur der Absatz „Das Wichtigste".
router.post('/digest-text', async (req, res) => {
  try {
    const e = await digest.erstellen();
    res.json({ response: e.text, ki: e.ki, hinweis: e.hinweis, total: e.total });
  } catch (err) {
    loggen('error', 'digest', `Digest konnte nicht erstellt werden: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// „Alle freigeben" aus dem täglichen Digest.
//
// Der Knopf „✅ Alle freigeben" unter der Telegram-Nachricht von Workflow 02
// landet in Workflow 05, und der ruft hier an. Den Endpunkt gab es bis Build
// 251 schlicht nicht — der Knopf lief seit jeher in ein 404.
//
// Was er tut, ist bewusst genau das, was draufsteht: ALLE Einträge der
// Mailcow-Quarantäne zustellen. Wer in Telegram drückt, hat die Liste im
// Digest gesehen. Wer drücken darf, prüft Workflow 05 über die Chat-ID
// (siehe workflowPatcher.absenderpruefungFuellen) — ohne hinterlegte Chat-ID
// läuft der Zweig gar nicht erst an.
//
// Antwortet immer mit einem fertigen Satz (`text`) für die Bestätigung in
// Telegram, auch im Fehlerfall: Ein roter n8n-Lauf erreicht niemanden, eine
// Nachricht „hat nicht geklappt, weil …" schon.
router.post('/quarantaene/deliver-all', async (req, res) => {
  let client;
  try {
    client = require('../services/mailcow').client();
  } catch (err) {
    return res.json({
      ok: false, zugestellt: 0,
      text: `ℹ️ ${err.message} Ohne Mailcow gibt es keine Quarantäne, die sich freigeben ließe.`,
    });
  }
  try {
    const { data } = await client.get('/get/quarantine/all');
    if (data && data.type === 'error') throw new Error(data.msg || 'Mailcow meldet einen Fehler');
    const ids = (Array.isArray(data) ? data : [])
      .map((q) => (q && q.id != null ? String(q.id) : null))
      .filter(Boolean);
    if (ids.length === 0) {
      return res.json({ ok: true, zugestellt: 0, text: '✅ Die Quarantäne ist leer — es gab nichts freizugeben.' });
    }
    const { data: antwort } = await client.post('/edit/qitem', { action: 'deliver', items: ids });
    // Mailcow antwortet je Eintrag mit einem Objekt { type: 'success'|'danger'|'error', msg }.
    const meldungen = Array.isArray(antwort) ? antwort : [antwort];
    const gescheitert = meldungen.filter((m) => m && (m.type === 'danger' || m.type === 'error')).length;
    const zugestellt = Math.max(0, ids.length - gescheitert);
    loggen(gescheitert ? 'warn' : 'info', 'quarantaene',
      `„Alle freigeben" über Telegram: ${zugestellt} von ${ids.length} Mailcow-Quarantäne-Einträgen zugestellt`
      + (gescheitert ? `, ${gescheitert} abgelehnt.` : '.'));
    res.json({
      ok: gescheitert === 0,
      zugestellt,
      gescheitert,
      text: gescheitert
        ? `⚠️ ${zugestellt} von ${ids.length} Quarantäne-Einträgen zugestellt, ${gescheitert} lehnte Mailcow ab.`
        : `✅ ${zugestellt} Quarantäne-Einträge wurden zugestellt.`,
    });
  } catch (err) {
    loggen('warn', 'quarantaene', `„Alle freigeben" über Telegram fehlgeschlagen: ${err.message}`);
    res.json({ ok: false, zugestellt: 0, text: `⚠️ Freigeben fehlgeschlagen: ${err.message}` });
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
module.exports.regelMerken = regelMerken;
module.exports.mailDatum = mailDatum;
module.exports.selberOrdner = selberOrdner;
