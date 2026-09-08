// Der Beleg-Leser — liest ein PDF per KI aus UND entscheidet, ob es ueberhaupt
// ein Beleg ist, der gespeichert werden soll.
//
// Zwei Wege, je nach Anbieter: Gemini bekommt das PDF selbst (es liest Layout
// und Tabellen mit), die lokale KI bekommt die Textebene, die
// services/pdfText.js herausholt. Fuer eine Rechnung genuegt der Text —
// Nummer, Datum und Firma stehen darin. Ein multimodales Modell waere der
// naheliegende, aber falsche Weg: llama3.2-vision ist 11B.
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

// Welches Modell gilt, entscheidet services/kiModell.js — eine Stelle fuer
// Workflows und Panel. Damit folgt auch das Beleg-Lesen einem Wechsel auf das
// Ersatzmodell, wenn Googles Tageskontingent aufgebraucht ist.
const kiModell = require('./kiModell');
const pdfText = require('./pdfText');

const BELEG_TYPEN = ['rechnung', 'bestellung', 'mahnung', 'kontoauszug', 'vertrag', 'lieferschein'];
// Woran die Heuristik (ohne KI) einen Beleg erkennt: eindeutige Woerter im
// Dateinamen oder Betreff. Im Zweifel NICHT ablegen — lieber ein Beleg fehlt
// einmal, als dass ein Fremd-PDF den Ordner verwirrt.
const BELEG_WORTE = /rechnung|invoice|bestell|order|mahnung|beleg|quittung|kontoauszug|lieferschein/i;

function tagesbudget() {
  const n = Number(settings.hole('beleg_lese_tagesbudget'));
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = kein Deckel
}

// Eingescannte Belege per Texterkennung lesen? Kostet auf einer CPU pro Scan
// einige Sekunden und greift nur, wenn gar keine Textebene da ist.
function ocrAktiv() {
  return String(settings.hole('beleg_ocr_aktiv') ?? '1') !== '0';
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
//
// `text` ist der Belegtext, sofern er vorliegt. Er ist nicht nur fuer die
// Heuristik gut: Laesst die KI ein Feld leer — und ein kleines Modell tut das
// oft —, stand die Antwort trotzdem im Dokument. Ohne diesen Rueckfall waere
// der KI-Weg beim Datum SCHLECHTER als der ohne KI, weil sauberDatum() dann
// stumm auf „heute" fiele. Erfunden wird weiterhin nichts: Es zaehlt nur, was
// benannt im Beleg steht (siehe ausText).
function entscheiden(roh, von, text = '') {
  const dokumenttyp = String(roh?.dokumenttyp || '').toLowerCase().trim();
  // speichern gilt nur, wenn die KI es sagt UND der Typ ein echter Beleg ist.
  const speichern = roh?.speichern === true && BELEG_TYPEN.includes(dokumenttyp);
  const imBeleg = ausText(text);
  return {
    speichern,
    dokumenttyp: dokumenttyp || 'kein_beleg',
    firma: roh?.firma ? sauberFirma(roh.firma) : firmaAus(von),
    datum: roh?.datum ? sauberDatum(roh.datum) : (imBeleg.datum || heute()),
    aktenzeichen: speichern
      ? (sauberAktenzeichen(roh?.aktenzeichen) || imBeleg.aktenzeichen)
      : null,
  };
}

// ─── Was im Belegtext steht ─────────────────────────────────────────────────
//
// Sobald die Textebene des PDF vorliegt (services/pdfText.js), muss die
// Heuristik nicht mehr aus Dateiname und Betreff raten: Rechnungsnummer, Datum
// und Dokumentart stehen auf dem Beleg. Das kostet weder eine KI-Anfrage noch
// Wartezeit und greift auch dann, wenn der Tagesdeckel voll oder die lokale KI
// ueberlastet ist.

// Die Reihenfolge ist Absicht. Eine Mahnung nennt fast immer auch eine
// Rechnung, und viele Rechnungen tragen die AGB auf der Rueckseite — wer
// zuerst nach AGB sucht, sortiert die halbe Buchhaltung als Werbung aus.
const TYP_WORTE = [
  ['mahnung', /\b(mahnung|zahlungserinnerung|zahlungsverzug)\b/i],
  ['kontoauszug', /\b(kontoauszug|umsatzanzeige|umsatzübersicht)\b/i],
  ['lieferschein', /\b(lieferschein|packzettel|delivery note)\b/i],
  ['rechnung', /\b(rechnung|rechnungsnummer|invoice|gutschrift)\b/i],
  ['bestellung', /\b(bestellbestätigung|bestellnummer|auftragsbestätigung|order confirmation)\b/i],
  ['vertrag', /\b(vertrag|vertragsurkunde|vertragsnummer)\b/i],
  ['agb', /\b(allgemeine geschäftsbedingungen|agb)\b/i],
  ['werbung', /\b(widerrufsbelehrung|datenschutzerklärung|newsletter|prospekt)\b/i],
];

const DATUM_ROH = '(\\d{1,2}[.\\/]\\s?\\d{1,2}[.\\/]\\s?\\d{2,4}|\\d{4}-\\d{2}-\\d{2})';
// Zuerst das ausdruecklich benannte Belegdatum, dann ein allgemeines „Datum:".
// „Das erste Datum im Text" waere zu oft das Faelligkeits- oder Lieferdatum,
// und ein falsches Datum ist schlimmer als gar keines: Im Ordnernamen sieht
// man ihm spaeter nicht an, dass es geraten war.
const DATUM_MUSTER = [
  new RegExp(`(?:rechnungs|belegs?|auftrags|bestell)datum\\s*[:\\s]\\s*${DATUM_ROH}`, 'i'),
  new RegExp(`\\bdatum\\s*[:\\s]\\s*${DATUM_ROH}`, 'i'),
];

const NUMMER_MUSTER = [
  /\b(?:rechnungs|beleg)[\s-]*(?:nummer|nr\.?)\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,30})/i,
  /\binvoice\s*(?:no\.?|number)\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,30})/i,
  /\b(?:bestell|auftrags|vorgangs)[\s-]*(?:nummer|nr\.?)\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,30})/i,
  /\bkunden[\s-]*(?:nummer|nr\.?)\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,30})/i,
];

/** „12.03.2026" und „2026-03-12" zu yyyy-mm-dd; alles andere: null. */
function datumNormalisieren(roh) {
  const s = String(roh || '').replace(/\s/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/);
  if (!t) return null;
  const [, tag, monat, jahrRoh] = t;
  if (Number(monat) < 1 || Number(monat) > 12 || Number(tag) < 1 || Number(tag) > 31) return null;
  // Zweistellige Jahre: 26 → 2026. Belege aus dem letzten Jahrhundert kommen
  // hier nicht per Mail an.
  const jahr = jahrRoh.length === 2 ? `20${jahrRoh}` : jahrRoh.padStart(4, '0');
  return `${jahr}-${monat.padStart(2, '0')}-${tag.padStart(2, '0')}`;
}

function ausText(text) {
  const t = String(text || '');
  if (!t) return { dokumenttyp: null, datum: null, aktenzeichen: null };
  const typ = TYP_WORTE.find(([, muster]) => muster.test(t));
  let datum = null;
  for (const muster of DATUM_MUSTER) {
    const treffer = t.match(muster);
    if (treffer) { datum = datumNormalisieren(treffer[1]); if (datum) break; }
  }
  let nummer = null;
  for (const muster of NUMMER_MUSTER) {
    const treffer = t.match(muster);
    if (treffer) { nummer = sauberAktenzeichen(treffer[1]); if (nummer) break; }
  }
  return { dokumenttyp: typ ? typ[0] : null, datum, aktenzeichen: nummer };
}

// ─── Heuristik, wenn ohne KI entschieden werden muss ────────────────────────
function heuristik({ von, betreff, dateiname }, text = '') {
  const ausDemNamen = BELEG_WORTE.test(`${dateiname || ''} ${betreff || ''}`);
  const gelesen = ausText(text);
  // Der Belegtext schlaegt den Dateinamen: „anhang.pdf" mit einer
  // Rechnungsnummer darin ist eine Rechnung, „rechnung.pdf" mit nichts als
  // einer Widerrufsbelehrung darin ist keine.
  const istBeleg = gelesen.dokumenttyp
    ? BELEG_TYPEN.includes(gelesen.dokumenttyp)
    : ausDemNamen;
  return {
    speichern: istBeleg,
    dokumenttyp: gelesen.dokumenttyp || (istBeleg ? 'unbekannt' : 'kein_beleg'),
    firma: firmaAus(von),
    // Ohne Fund bleibt es wie bisher bei heute.
    datum: gelesen.datum || heute(),
    aktenzeichen: istBeleg ? gelesen.aktenzeichen : null,
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

// Die lokale KI liest den TEXT des Belegs, nicht das PDF.
//
// Ollamas /api/generate nimmt Text und — bei Vision-Modellen — Bilder, aber
// keine PDFs. Der naheliegende Ausweg waere ein multimodales Modell; llama3.2
// -vision ist allerdings 11B, und auf drei Kernen ist das keine Option.
//
// Der Umweg ist der kuerzere: Fast jede Rechnung ist ein digitales PDF mit
// Textebene (services/pdfText.js holt sie heraus). Ist der Text einmal da, ist
// es eine ganz gewoehnliche Textfrage — und die beantwortet auch ein kleines
// Modell. Gemini bekommt weiterhin das PDF selbst, weil es Layout und Tabellen
// mitliest; das ist bei einer Rechnung ein Vorteil, aber keine Bedingung.
async function fragOllama(text) {
  if (!text) return null;
  const kiText = require('./kiText');
  const antwort = await kiText.frageJson(
    `${prompt()}\n\nHier der Text des PDF:\n---\n${text}\n---`,
    {
      quelle: 'backend:belegLeser',
      zeitlimit: 120000,
      // Fuenf Felder, mehr wird nicht gebraucht — und jedes Token, das nicht
      // erzeugt wird, ist auf einer CPU gesparte Zeit.
      maxAntwort: 400,
      maxZeichen: 12000,
    },
  );
  if (!antwort.ok) {
    loggen('warn', 'backend:belegLeser', `Beleg-Lesen per lokaler KI fehlgeschlagen: ${antwort.fehler}`);
    return null;
  }
  return antwort.daten;
}

async function fragGemini(pdfBase64) {
  const key = settings.hole('gemini_api_key');
  if (!key) return null; // ohne Schluessel kann nicht gelesen werden ⇒ Heuristik
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${kiModell.aktiv()}:generateContent`,
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

  // 2. Kein PDF ⇒ es gibt nichts zu lesen.
  if (!eingang.pdf_base64) {
    const h = heuristik(e);
    merken(e, h, 'heuristik');
    return { ...h, quelle: 'heuristik' };
  }

  // 3. Textebene herausholen. Kostet keine KI-Anfrage und macht schon die
  //    Heuristik deutlich besser: Rechnungsnummer, Datum und Dokumentart
  //    stehen auf dem Beleg, nicht im Dateinamen.
  //
  //    Texterkennung nur bei lokaler KI: Gemini bekommt das PDF selbst und
  //    liest einen Scan von sich aus. Sie dort trotzdem laufen zu lassen waeren
  //    dreissig Sekunden CPU fuer nichts.
  const lokal = (settings.hole('ki_anbieter') || 'gemini') === 'ollama';
  const auszug = await pdfText.textAus(eingang.pdf_base64, { ocr: lokal && ocrAktiv() });
  const text = auszug.ok ? auszug.text : '';

  // 4. Deckel voll ⇒ ohne KI entscheiden, jetzt aber mit dem Belegtext.
  const grenze = tagesbudget();
  if (grenze > 0 && heuteGelesen() >= grenze) {
    const h = heuristik(e, text);
    merken(e, h, 'heuristik');
    return { ...h, quelle: 'heuristik' };
  }

  // 5. Von der KI lesen lassen — Gemini das PDF, Ollama den Text.
  if (lokal && !text) {
    // Weder Textebene noch Texterkennung haben etwas geliefert. Das ist ein
    // STABILER Zustand, kein voruebergehender Fehler — also wird die
    // Entscheidung gemerkt, sonst liest jeder Lauf dasselbe Dokument neu.
    loggen('info', 'backend:belegLeser',
      `Kein Text im PDF (${auszug.grund || 'unbekannt'}) — mit lokaler KI entscheidet die Heuristik.`);
    const h = heuristik(e, '');
    merken(e, h, 'heuristik');
    return { ...h, quelle: 'heuristik' };
  }

  const roh = lokal ? await fragOllama(text) : await fragGemini(eingang.pdf_base64);
  if (!roh) {
    // Fehler/kein Schluessel: Heuristik, aber NICHT merken — damit ein
    // voruebergehender Fehler beim naechsten Lauf erneut versucht wird und die
    // Entscheidung nicht 26 Stunden lang festgenagelt ist.
    return { ...heuristik(e, text), quelle: 'heuristik' };
  }
  const ergebnis = entscheiden(roh, e.von, text);
  merken(e, ergebnis, 'ki');
  return { ...ergebnis, quelle: 'ki' };
}

module.exports = {
  auslesen, entscheiden, heuristik, tagesbudget, heuteGelesen, aufraeumen, ocrAktiv,
  ausText, datumNormalisieren,
  sauberFirma, firmaAus, sauberAktenzeichen, sauberDatum,
};
