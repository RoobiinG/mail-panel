// Säuberung von Pfadbestandteilen, die aus unvertrauenswürdigen Quellen stammen.
//
// Warum es das gibt: Ordner- und Dateinamen entstehen aus Dingen, die ein Fremder
// oder ein kleines Sprachmodell geschrieben hat — Betreff, Absender, Firma und
// Aktenzeichen aus einem PDF. Landen sie ungefiltert in einem Nextcloud-Pfad, genügt
// ein Betreff wie "../../" oder ein Aktenzeichen mit Schrägstrichen, um aus dem
// Belege-Ordner auszubrechen oder unerwartete Ordner anzulegen. `fetch` löst ".."
// beim Bilden der Adresse selbst auf, die Anfrage ginge dann an einen ganz anderen
// Ort der Nextcloud.
//
// Drei Stufen, von eng nach weit:
//   segmentSaeubern  EIN Ordnername aus fremden Daten — strenge Zeichenliste
//   dateiSaeubern    EIN Dateiname — großzügiger (Rechnung #5 [final].pdf bleibt)
//   pfadSaeubern     ein fertiger Pfad aus mehreren Segmenten
//   vorlageSaeubern  eine Pfad-VORLAGE mit {{platzhaltern}}, die stehen bleiben
//
// segmentSaeubern und dateiSaeubern sind absichtlich in sich geschlossen (keine
// Konstanten außerhalb): Ihr Quelltext wird unverändert in den Beleg-Knoten von
// Workflow 07 eingebettet (siehe quelltextFuerKnoten). So gibt es nur EINE
// Fassung der Regel und nicht eine im Panel und eine abweichende in n8n.

const MAX_EBENEN = 10;

/**
 * Macht aus beliebigem Text einen einzelnen, harmlosen Ordnernamen.
 * Liefert nie "", "." oder ".." — im Zweifel "unbekannt".
 * @param {*} wert
 * @param {number} [maxLaenge=60] höchstens so viele Zeichen
 */
function segmentSaeubern(wert, maxLaenge) {
  const grenze = Number(maxLaenge) > 0 ? Number(maxLaenge) : 60;
  let s = String(wert == null ? '' : wert).normalize('NFKC');
  // Jede Art Leerraum (Tab, Zeilenumbruch, geschütztes Leerzeichen …) wird ein
  // einfaches Leerzeichen — danach fliegt alles Unsichtbare raus: Steuerzeichen,
  // NUL, Zero-Width- und Richtungszeichen (Bidi-Tricks verstecken sonst, was ein
  // Ordner heißt).
  s = s.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').normalize('NFKC');
  // Alles, was wie ein Trenner aussieht, wird ein Bindestrich. NFKC erledigt die
  // Vollbreiten-Fassungen (／ ＼ ．), nicht aber den Divisionsstrich (∕) und
  // seine Verwandten — die stehen deshalb hier ausdrücklich.
  s = s.replace(/[\\/∕⁄⧸∖⧵⧹⟋⟍〳﹨]/gu, '-');
  // Zeichenliste statt Sperrliste: Was nicht ausdrücklich erlaubt ist, entfällt.
  // Damit auch "%" — ein "%2e%2e" im Namen wird nie zu ".." dekodiert.
  s = s.replace(/[^\p{L}\p{M}\p{N} _.,()&+-]/gu, '').normalize('NFKC').replace(/ {2,}/g, ' ');
  s = s.replace(/^[ .]+/, '');
  // Windows-Gerätenamen (CON, NUL, COM1 …) lassen sich auf manchen Systemen nicht
  // als Ordner anlegen — ein Vorsatz entschärft sie, ohne den Namen zu verlieren.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = '_' + s;
  s = Array.from(s).slice(0, grenze).join('').replace(/[ .]+$/, '');
  return s || 'unbekannt';
}

/**
 * Macht aus beliebigem Text einen einzelnen Dateinamen.
 * Großzügiger als segmentSaeubern: Ein Dateiname darf Sonderzeichen tragen, solange
 * er nichts bewirkt. Verboten bleibt, was einen Pfad bildet oder verwirrt.
 * Liefert nie "", "." oder ".." — im Zweifel "beleg".
 * @param {*} name
 */
function dateiSaeubern(name) {
  let s = String(name == null ? '' : name).normalize('NFC');
  s = s.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  s = s.replace(/[\\/:*?"<>|∕⁄⧸∖／＼]/g, ' ');
  s = Array.from(s.replace(/ {2,}/g, ' ').trim()).slice(0, 120).join('').replace(/[ .]+$/, '');
  // ".." allein ist ein Sprung nach oben, "." ein Verweis auf den Ordner selbst.
  // Geprüft wird die NFKC-Fassung: Der Punkt-Doppelgänger "‥" (U+2025) ist für
  // jeden, der so normalisiert, ein "..".
  if (/^[ .]*$/.test(s.normalize('NFKC'))) return 'beleg';
  return s;
}

// Trenner, die wie ein "/" wirken — für pfadSaeubern und vorlageSaeubern.
const TRENNER = /[\\∕⁄⧸∖／＼]/g;

/**
 * Säubert einen fertigen Pfad ("Belege/Amazon/RE-2026-17") Segment für Segment.
 * Sprünge nach oben ("..", ".") und leere Teile fallen weg, es bleiben höchstens
 * MAX_EBENEN Ebenen.
 * @returns {string} "" wenn nichts übrig bleibt
 */
function pfadSaeubern(pfad) {
  return String(pfad == null ? '' : pfad)
    .normalize('NFKC')
    .replace(TRENNER, '/')
    .split('/')
    .filter((t) => t.trim() !== '' && !/^[ .]*$/.test(t))
    .map((t) => segmentSaeubern(t))
    .slice(0, MAX_EBENEN)
    .join('/');
}

// {{name}} — die Platzhalter der Aktionen. Ob der Name bekannt ist, entscheidet
// aktionenPatcher.ausdruck(); hier zählt nur, dass sie unangetastet bleiben.
const PLATZHALTER = /(\{\{[a-z_0-9]+\}\})/gi;

/**
 * Säubert eine Pfad-VORLAGE wie "Belege/{{firma}}/{{aktenzeichen}}": Der
 * Literaltext wird gesäubert, die Platzhalter bleiben stehen. Ihre Werte kommen
 * erst zur Laufzeit und werden dort einzeln mit segmentSaeubern behandelt.
 * @returns {string}
 */
function vorlageSaeubern(vorlage) {
  const segmente = String(vorlage == null ? '' : vorlage)
    .normalize('NFKC')
    .replace(TRENNER, '/')
    .split('/')
    .filter((t) => t.trim() !== '' && !/^[ .]*$/.test(t));

  const saubere = segmente.map((segment) => {
    const teile = segment.split(PLATZHALTER).map((teil, i) => {
      // Ungerade Positionen sind die Platzhalter selbst (split mit Fanggruppe).
      if (i % 2 === 1) return teil;
      return teil
        .replace(/\s+/g, ' ')
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
        .replace(/[^\p{L}\p{M}\p{N} _.,()&+-]/gu, '');
    });
    // Ränder des GANZEN Segments, nicht der einzelnen Teile: ".pdf" hinter einem
    // Platzhalter muss seinen Punkt behalten.
    return teile.join('').replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  }).filter((t) => t !== '');

  return saubere.slice(0, MAX_EBENEN).join('/');
}

/**
 * Wie viele Ordnerebenen hat der Pfad? Für die Frage, wie viele Ordner angelegt
 * werden müssen.
 */
const ebenen = (pfad) => String(pfad || '').split('/').filter(Boolean).length;

/**
 * Quelltext einer der Funktionen oben, als Funktion namens `name` — zum
 * Einbetten in einen n8n-Code-Knoten.
 * @param {Function} fn segmentSaeubern oder dateiSaeubern
 * @param {string} name Name der Funktion im Knoten
 */
function quelltextFuerKnoten(fn, name) {
  return String(fn).replace(/^function\s+\w+/, `function ${name}`);
}

module.exports = {
  segmentSaeubern, dateiSaeubern, pfadSaeubern, vorlageSaeubern,
  ebenen, quelltextFuerKnoten, MAX_EBENEN,
};
