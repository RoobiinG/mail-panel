// Interne Endpunkte rund um Anhänge: Virenscan, Abruf, Beleg-Lesen, Upload-Einlieferung.
//
// Warum sie nicht mehr in routes/internal.js stehen: Diese fünf holen Dateien aus
// Postfächern und tragen sie in Nextcloud und KI-Dienste. Sie sind der Teil des
// Panels, an dem ein Fremder (der Absender einer Mail) am meisten Einfluss hat —
// und sie brauchen deshalb einen anderen, strengeren Wächter als der Rest von
// /api/internal:
//
//   X-Panel-Secret (n8n)   ODER   Admin-Anmeldung (JWT der festen Admin-Rolle)
//
// Der Wächter steht bei jeder Route VOR dem Body-Parser: Wer sich nicht ausweist,
// kann keine 40 MB parsen lassen. Jeder Pfad mit eigenem Parser MUSS außerdem in
// EIGENER_PARSER (index.js) stehen, sonst greift der globale 1-MB-Parser davor — ein
// Test (parser-grenzen.test.js) wacht darüber.
//
// Grenzen: höchstens 20 Anhänge je Mail und 30 MB je Datei (anhangGrenzen.js). Wird
// eine überschritten, bricht die Verarbeitung ab, statt zu kürzen.
const express = require('express');
const db      = require('../db');
const clamav  = require('../services/clamav');
const imap    = require('../services/imap');
const belegLeser     = require('../services/belegLeser');
const uploadFreigabe = require('../services/uploadFreigabe');
const { entschluesseln } = require('../services/crypto');
const { loggen } = require('../services/panelLog');
const { adminOderPanelSecret } = require('../middleware/internalAuth');
const {
  MAX_DATEI, base64ZuGross, transportSammler, scanAbbruch, MB,
} = require('../services/anhangGrenzen');

const router = express.Router();

// 30 MB Datei als base64 sind 40 MB; dazu der Umschlag (Name, Konto, Betreff …).
const JSON_MIT_DATEI = '42mb';

const einstellung = (key, fallback) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : fallback;
};

// Zugangsdaten kommen ausschließlich aus der Datenbank, nie aus der Anfrage.
const kontoZugang = (zeile) => ({
  host: zeile.host,
  port: zeile.port,
  username: zeile.username,
  passwort: entschluesseln(zeile.password_enc),
  tlsUnsicher: Boolean(zeile.tls_unsicher),
});

const aktivesKonto = (name) =>
  db.prepare('SELECT * FROM accounts WHERE name = ? AND aktiv = 1').get(String(name));

// ─── Anhang an ClamAV senden ─────────────────────────────────────────────────
// Der Rumpf ist die Datei selbst. Zu groß = ausdrücklich NICHT sauber: Ein Parser-
// Fehler wird hier in die Antwort des Virenscans übersetzt, nicht dem allgemeinen
// Fehlerbehandler überlassen.
const rohParser = express.raw({ type: '*/*', limit: MAX_DATEI });
const scanParser = (req, res, next) => rohParser(req, res, (err) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json(scanAbbruch({
      grund: 'datei_zu_gross', text: `Datei ist größer als ${MB(MAX_DATEI)}`,
    }, 1));
  }
  return next(err);
});

router.post('/scan', adminOderPanelSecret, scanParser, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ clean: true, fehler: 'Keine Datei gesendet' });
  }
  try {
    res.json(await clamav.scan(req.body));
  } catch (err) {
    console.error('ClamAV Scan Fehler:', err.message);
    // Bei Fehlern (wie Timeout) lassen wir die Mail durch, um keine Mails zu blockieren
    res.json({ clean: true, fehler: err.message });
  }
});

// ─── Alle Anhänge einer Mail scannen ─────────────────────────────────────────
// Der Workflow schickt nur Konto, UID und Ordner — das Panel holt die Dateien selbst
// per IMAP und gibt sie an ClamAV weiter.
//
// Warum nicht wie bisher die Datei mitschicken? Zwei Gründe: Der Abruf-Knoten der
// Bestands-Triage liefert überhaupt keine Dateiinhalte (nur Namen und Größen), und
// über den Umweg mit den Binärdaten wurde immer nur der erste Anhang geprüft.
router.post('/scan-anhaenge', adminOderPanelSecret, express.json({ limit: '16kb' }), async (req, res) => {
  const { konto, uid, ordner } = req.body || {};
  try {
    if (!konto) return res.status(400).json({ clean: true, fehler: 'Kein Konto angegeben.' });

    const zeile = aktivesKonto(konto);
    if (!zeile) return res.status(404).json({ clean: true, fehler: `Unbekanntes Konto: ${konto}` });
    const zugang = { ...kontoZugang(zeile), ordner: ordner || 'INBOX', uid };

    // Ist der Virenscanner überhaupt eingeschaltet? Ohne diese Frage lädt das
    // Panel jeden Anhang über IMAP herunter, um ihn dann an einen Dienst zu
    // schicken, den es nicht gibt — deshalb hier nur zählen.
    if (einstellung('clamav_aktiv', '1') !== '1') {
      const { gefunden } = await imap.anhaengeHolen({ ...zugang, nurStruktur: true });
      return res.json({
        clean: true, virus: null, gefunden, geprueft: 0, ungeprueft: gefunden, dateien: [],
        fehler: gefunden ? 'Virenscanner ist abgeschaltet — Anhänge wurden nicht geprüft.' : null,
      });
    }

    const dateien = [];
    let virus = null;
    let ungeprueft = 0;

    // Jede Datei wird sofort geprüft und wieder freigegeben — nicht alle zugleich
    // im Speicher gehalten.
    const { gefunden, abgebrochen } = await imap.anhaengeHolen({
      ...zugang,
      beiAnhang: async (anhang) => {
        if (anhang.fehler) {
          dateien.push({ name: anhang.name, fehler: anhang.fehler });
          ungeprueft += 1;
          return;
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
      },
    });

    // Grenze überschritten: ausdrücklich NICHT sauber. Der Workflow behandelt das
    // wie einen Fund (Quarantäne, Meldung). Vorher wurde der Rest einer Mail mit
    // mehr als 20 Anhängen stillschweigend übersprungen und galt als geprüft.
    if (abgebrochen) {
      loggen('warn', 'virenscan',
        `Mail ${konto}/${uid}: Prüfung abgebrochen — ${abgebrochen.text}. Die Mail gilt als nicht sauber.`);
      return res.json(scanAbbruch(abgebrochen, gefunden));
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

// ─── Die Anhänge einer Mail als base64 — für die eigenen Aktionen in Workflow 07 ─
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
// Grenzen: höchstens 20 Dateien zu je 30 MB, sonst gibt es nichts zurück. Zusammen
// gehen höchstens 60 MB an n8n; was darüber liegt, kommt mit Namen und Größe, aber
// ohne Inhalt — dann steht wenigstens im Lauf, warum nichts kam.
router.post('/anhaenge', adminOderPanelSecret, express.json({ limit: '16kb' }), async (req, res) => {
  const { konto, uid, ordner } = req.body || {};
  try {
    if (!konto) return res.status(400).json({ anhaenge: [], fehler: 'Kein Konto angegeben.' });

    const zeile = aktivesKonto(konto);
    if (!zeile) return res.status(404).json({ anhaenge: [], fehler: `Unbekanntes Konto: ${konto}` });

    const sammler = transportSammler();
    const { abgebrochen, gefunden } = await imap.anhaengeHolen({
      ...kontoZugang(zeile),
      ordner: ordner || 'INBOX',
      uid,
      // Gleich umwandeln und die Datei freigeben, statt 20 × 30 MB zu halten.
      beiAnhang: async (anhang) => sammler.aufnehmen(anhang),
    });

    if (abgebrochen) {
      loggen('warn', 'aktionen',
        `Anhänge von ${konto}/${uid} nicht geholt — ${abgebrochen.text}.`);
      return res.json({
        anhaenge: [], gefunden, abgebrochen: abgebrochen.grund, fehler: abgebrochen.text,
      });
    }
    res.json({ anhaenge: sammler.raus, gefunden });
  } catch (err) {
    // Die Mail kann inzwischen verschoben worden sein — Workflow 07 läuft
    // parallel zum Einsortieren. Dann ist die UID im alten Ordner weg, und das
    // ist kein Grund, den Lauf scheitern zu lassen.
    loggen('warn', 'aktionen',
      `Anhänge von ${konto}/${uid} konnten nicht geholt werden: ${err.message}`);
    res.json({ anhaenge: [], fehler: err.message });
  }
});

// ─── Eine Datei in die Freigabe-Warteschlange legen, statt sie sofort hochzuladen ─
//
// Ruft der Freigabe-Knoten in Workflow 07 auf, wenn bei der Aktion „Vor dem
// Hochladen fragen" eingeschaltet ist. Das Panel lädt danach selbst hoch —
// n8n kann nicht auf eine menschliche Entscheidung warten.
router.post('/upload-freigabe', adminOderPanelSecret, express.json({ limit: JSON_MIT_DATEI }), async (req, res) => {
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

// ─── Beleg-Leser ─────────────────────────────────────────────────────────────
// Der Beleg-Knoten in Workflow 07 schickt ein PDF hierher. Das Panel liest es per
// KI aus und entscheidet, OB es ein aufbewahrenswerter Beleg ist (AGB/Werbung ⇒
// nicht). Der Schlüssel bleibt im Panel. Scheitert hier etwas, fällt der Leser auf
// eine Heuristik zurück — und nichts abzulegen ist besser als ein Fremd-PDF im
// Belege-Ordner.
router.post('/beleg-auslesen', adminOderPanelSecret, express.json({ limit: JSON_MIT_DATEI }), async (req, res) => {
  try {
    const eingang = req.body || {};
    if (base64ZuGross(eingang.pdf_base64)) {
      return res.status(413).json({
        speichern: false, dokumenttyp: 'kein_beleg', grund: 'datei_zu_gross',
        fehler: `Datei ist größer als ${MB(MAX_DATEI)}`,
      });
    }
    res.json(await belegLeser.auslesen(eingang));
  } catch (err) {
    console.error('Beleg-Auslesen-Fehler:', err.message);
    // Nichts ablegen ist besser als ein Fremd-PDF im Belege-Ordner.
    res.status(500).json({ speichern: false, dokumenttyp: 'kein_beleg', fehler: err.message });
  }
});

module.exports = router;
