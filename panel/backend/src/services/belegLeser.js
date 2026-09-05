// Der Beleg-Leser — liest ein PDF per Gemini aus UND entscheidet, ob es
// ueberhaupt ein Beleg ist, der gespeichert werden soll.
//
// Warum es diese Stelle gibt: Workflow 07 legt Anhaenge von Rechnungs- und
// Bestellmails in Nextcloud ab. Aber nicht jeder Anhang einer solchen Mail ist
// ein Beleg — oft haengt eine AGB, eine Widerrufsbelehrung oder ein Logo mit
// dran. Die sollen NICHT im Belege-Ordner landen, sonst wird er unuebersichtlich.
// Deshalb liest die KI das PDF und liefert zwei Dinge zurueck:
//   1. speichern: true  → echter Beleg (Rechnung, Bestellung, Mahnung, …)
//      speichern: false → kein Beleg (AGB, Werbung, sonstiges) ⇒ wird verworfen
//   2. firma, datum, aktenzeichen → daraus baut der Workflow Ordner und Dateiname.
//
// Drei Bremsen schuetzen das Gemini-Tageslimit (dieselbe Idee wie budget.js):
//   • Dedupe: dieselbe Mail bei einem Wiederhollauf nicht erneut lesen.
//   • Tagesdeckel (beleg_lese_tagesbudget): ist er voll, wird ohne KI per
//     Heuristik entschieden (nur klare Belege werden dann abgelegt).
//   • Vorfilter im Workflow (nur PDFs, Blockliste) — kostet gar keine Abfrage.
const db = require('../db');
const settings = require('./settings');
const { loggen } = require('./panelLog');

// gemini-2.5-flash-lite ist abgekuendigt — dieselbe Falle wie in aktionenKi.js.
// Bewusst als Konstante, damit der naechste Modellwechsel eine Zeile ist.
const MODELL = 'gemini-3.5-flash-lite';

const BELEG_TYPEN = ['rechnung', 'bestellung', 'mahnung', 'kontoauszug', 'vertrag', 'lieferschein'];
// Woran die Heuristik (ohne KI) einen Beleg erkennt: eindeutige Woerter im
// Dateinamen oder Betreff. Im Zweifel NICHT ablegen — lieber ein Beleg fehlt
// einmal, als dass ein Fremd-PDF den Ordner verwirrt.
const BELEG_WORTE = /rechnung|invoice|bestell|order|mahnung|beleg|quittung|kontoauszug|lieferschein/i;

function tagesbudget() {
  const n = Number(settings.hole('beleg_lese_tagesbudget'));
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = kein Deckel
}

// Nur echte KI-Lesungen von heute zaehlen gegen das Budget.
function heuteGelesen() {
  try {
    return db.prepare(
      "SELECT COUNT(*) n FROM beleg_ablage WHERE quelle = 'ki' AND created_at >= date('now','localtime')",
    ).get().n;
  } catch { return 0; }
}

// ─── Aufraeumen ─────────────────────────────────────────────────────────────
// beleg_ablage dient nur der Dedupe (26 h) und der Anzeige (letzte 7 Tage). Alles
// Aeltere ist Ballast. 30 Tage bleiben als grosszuegiger Puffer stehen.
const BEHALTEN_TAGE = 30;

function aufraeumen(tage = BEHALTEN_TAGE) {
  try {
    return db.prepare("DELETE FROM beleg_ablage WHERE created_at < datetime('now', ?)")
      .run(`-${Number(tage) || BEHALTEN_TAGE} days`).changes;
  } catch { return 0; }
}

// Gedrosselt statt per Dauer-Timer: laeuft hoechstens alle 6 Stunden mit, wenn
// ohnehin Belege verarbeitet werden. Kein Aufraeumen ohne Betrieb — dann waechst
// die Tabelle aber auch nicht.
let letzteReinigung = 0;
function vielleichtAufraeumen() {
  const jetzt = Date.now();
  if (jetzt - letzteReinigung < 6 * 60 * 60 * 1000) return;
  letzteReinigung = jetzt;
  aufraeumen();
}

// ─── Saeuberung: alles, was in einen Datei-/Ordnernamen darf ────────────────
function sauberFirma(wert) {
  const s = String(wert || '')
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' }[c]))
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'unbekannt';
}

// Firma aus der Absenderadresse ableiten, wenn die KI keine liefert.
function firmaAus(von) {
  const adresse = String(von || '').toLowerCase().match(/[^<\s]+@[^>\s]+/);
  const dom = (adresse ? adresse[0].split('@')[1] : '')
    .replace(/^(www|mail|email|smtp|mx|news|newsletter|mailer|send|bounce|reply|no-?reply)\./, '');
  const teile = dom.split('.').filter(Boolean);
  if (teile.length < 2) return sauberFirma(teile[0] || '');
  const zweiTeilig = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  const idx = zweiTeilig.has(teile[teile.length - 2]) && teile.length >= 3
    ? teile.length - 3 : teile.length - 2;
  return sauberFirma(teile[idx]);
}

// Aktenzeichen pfadtauglich: Buchstaben/Ziffern behalten, Trenner zu '-', keine
// Schraegstriche (die wuerden neue Ordnerebenen aufmachen).
function sauberAktenzeichen(wert) {
  const s = String(wert || '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return s || null;
}

function heute() {
  return new Date().toISOString().slice(0, 10);
}

// Ein Datum nur uebernehmen, wenn es wie yyyy-mm-dd aussieht — sonst heute.
function sauberDatum(wert) {
  const s = String(wert || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : heute();
}

// ─── Antwort der KI in eine Entscheidung uebersetzen ────────────────────────
function entscheiden(roh, von) {
  const dokumenttyp = String(roh?.dokumenttyp || '').toLowerCase().trim();
  // speichern gilt nur, wenn die KI es sagt UND der Typ ein echter Beleg ist.
  const speichern = roh?.speichern === true && BELEG_TYPEN.includes(dokumenttyp);
  return {
    speichern,
    dokumenttyp: dokumenttyp || 'kein_beleg',
    firma: roh?.firma ? sauberFirma(roh.firma) : firmaAus(von),
    datum: sauberDatum(roh?.datum),
    aktenzeichen: speichern ? sauberAktenzeichen(roh?.aktenzeichen) : null,
  };
}

// ─── Heuristik, wenn ohne KI entschieden werden muss ────────────────────────
function heuristik({ von, betreff, dateiname }) {
  const speichern = BELEG_WORTE.test(`${dateiname || ''} ${betreff || ''}`);
  return {
    speichern,
    dokumenttyp: speichern ? 'unbekannt' : 'kein_beleg',
    firma: firmaAus(von),
    datum: heute(),
    aktenzeichen: null,
  };
}

function merken(eingang, ergebnis, quelle) {
  try {
    db.prepare(`
      INSERT INTO beleg_ablage (konto, von, betreff, dateiname, dokumenttyp, gespeichert, firma, aktenzeichen, datum, quelle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eingang.konto ?? null, eingang.von ?? null, eingang.betreff ?? null, eingang.dateiname ?? null,
      ergebnis.dokumenttyp ?? null, ergebnis.speichern ? 1 : 0,
      ergebnis.firma ?? null, ergebnis.aktenzeichen ?? null, ergebnis.datum ?? null, quelle,
    );
  } catch (err) {
    loggen('warn', 'backend:belegLeser', `Konnte Beleg-Entscheidung nicht merken: ${err.message}`);
  }
}

// Schon in den letzten 26 Stunden gelesen? Dann die Entscheidung wiederverwenden
// (26 statt 24, damit ein Lauf um Mitternacht nicht durch die Ritze faellt).
function frueher(eingang) {
  try {
    const r = db.prepare(`
      SELECT dokumenttyp, gespeichert, firma, aktenzeichen, datum FROM beleg_ablage
      WHERE konto IS ? AND von IS ? AND IFNULL(betreff,'') = ? AND IFNULL(dateiname,'') = ?
        AND created_at >= datetime('now','-26 hours')
      ORDER BY id DESC LIMIT 1
    `).get(eingang.konto ?? null, eingang.von ?? null, String(eingang.betreff || ''), String(eingang.dateiname || ''));
    if (!r) return null;
    return {
      speichern: Boolean(r.gespeichert),
      dokumenttyp: r.dokumenttyp,
      firma: r.firma,
      datum: r.datum,
      aktenzeichen: r.aktenzeichen,
    };
  } catch { return null; }
}

function prompt() {
  return `Du bekommst ein PDF aus dem Anhang einer E-Mail. Entscheide, ob es ein
aufbewahrenswerter Beleg ist, und lies die wichtigsten Felder aus. Antworte NUR mit
einem JSON-Objekt, ohne Erklaerung, in exakt diesem Format:
{"dokumenttyp":"rechnung|bestellung|mahnung|kontoauszug|vertrag|lieferschein|agb|werbung|kein_beleg","speichern":true,"firma":"kurzer Firmenname","datum":"YYYY-MM-DD","aktenzeichen":"..."}

Regeln:
- "speichern": true NUR bei echten Belegen (rechnung, bestellung, mahnung, kontoauszug, vertrag, lieferschein).
- "speichern": false bei AGB, Widerrufsbelehrung, Datenschutz, Werbung, Prospekten, Logos oder allem, was kein Beleg ist.
- "firma": der Absender/das Unternehmen des Belegs, kurz (z.B. "Amazon", "Inkasso Müller GmbH").
- "datum": das Datum AUF dem Beleg (Rechnungs-/Briefdatum), Format YYYY-MM-DD. Unbekannt ⇒ "".
- "aktenzeichen": Aktenzeichen, Rechnungs-, Vorgangs- oder Kundennummer, falls vorhanden — sonst "".
- Erfinde nichts. Was du nicht sicher liest, lass leer.`;
}

async function fragGemini(pdfBase64) {
  const key = settings.hole('gemini_api_key');
  if (!key) return null; // ohne Schluessel kann nicht gelesen werden ⇒ Heuristik
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt() },
              { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
        signal: AbortSignal.timeout(45000),
      },
    );
    // Der einzige Gemini-Aufruf, den das Panel selbst macht — und damit die
    // einzige Gelegenheit, an Zahlen zu kommen, die sonst niemand liefert.
    // Kopfzeilen mit dem verbleibenden Kontingent sind nicht dokumentiert;
    // schickt Google sie doch, werden sie mitgenommen. Und eine 429 ist hier
    // dieselbe Auskunft wie drüben in n8n: Für heute ist Schluss.
    try {
      const rest = res.headers.get('x-ratelimit-remaining-requests');
      if (rest !== null) settings.setze('ki_rest_kopfzeile', String(rest));
      if (res.status === 429) require('./kiKontingent').abweisungMerken(new Date().toISOString());
    } catch { /* eine Zusatzinfo darf das Belege-Lesen nicht aufhalten */ }

    if (!res.ok) {
      loggen('warn', 'backend:belegLeser', `Gemini antwortete mit ${res.status}`);
      return null;
    }
    const daten = await res.json();
    const rohtext = daten?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(String(rohtext).replace(/```json|```/g, '').trim());
  } catch (err) {
    loggen('warn', 'backend:belegLeser', `Beleg-Lesen fehlgeschlagen: ${err.message}`);
    return null;
  }
}

/**
 * Liest einen PDF-Anhang aus und entscheidet ueber die Ablage.
 * @param {{konto,von,betreff,dateiname,pdf_base64}} eingang
 * @returns {Promise<{speichern,dokumenttyp,firma,datum,aktenzeichen,quelle}>}
 */
async function auslesen(eingang = {}) {
  vielleichtAufraeumen(); // gedrosselt: haelt beleg_ablage klein, ohne Dauer-Timer
  const e = {
    konto: eingang.konto ?? null,
    von: eingang.von ?? null,
    betreff: eingang.betreff ?? null,
    dateiname: eingang.dateiname ?? null,
  };

  // 1. Schon gelesen? Entscheidung wiederverwenden — kein KI-Aufruf.
  const alt = frueher(e);
  if (alt) return { ...alt, quelle: 'dedupe' };

  // 2. Deckel voll oder kein PDF ⇒ ohne KI per Heuristik entscheiden.
  const grenze = tagesbudget();
  if ((grenze > 0 && heuteGelesen() >= grenze) || !eingang.pdf_base64) {
    const h = heuristik(e);
    merken(e, h, 'heuristik');
    return { ...h, quelle: 'heuristik' };
  }

  // 3. Von der KI lesen lassen.
  const roh = await fragGemini(eingang.pdf_base64);
  if (!roh) {
    // Fehler/kein Schluessel: Heuristik, aber NICHT merken — damit ein
    // voruebergehender Fehler beim naechsten Lauf erneut versucht wird und die
    // Entscheidung nicht 26 Stunden lang festgenagelt ist.
    return { ...heuristik(e), quelle: 'heuristik' };
  }
  const ergebnis = entscheiden(roh, e.von);
  merken(e, ergebnis, 'ki');
  return { ...ergebnis, quelle: 'ki' };
}

module.exports = {
  auslesen, entscheiden, heuristik, tagesbudget, heuteGelesen, aufraeumen,
  sauberFirma, firmaAus, sauberAktenzeichen, sauberDatum,
};
