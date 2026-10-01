// Prüfung dessen, was ein Sprachmodell als Ordner vorschlägt.
//
// Warum es das gibt: Der Ordnername einer KI-Antwort ist Text von einem kleinen
// Modell, das schon Prompt-Fragmente als Ordnernamen abgeschrieben hat — und er
// landet in einer Vorschlagsliste, auf einem Knopf („Nur diese Mail") und von
// dort in einem IMAP-CREATE. Bis Build 253 übernahm die Nachsortierung ihn ohne
// jede Prüfung und ohne Blick auf die Sicherheit, die das Modell selbst angab.
//
// Zwei Prüfungen, und beide VERWERFEN, statt zu „reparieren":
//
//   Name        2–40 Zeichen, ausschließlich Buchstaben, Ziffern, Leerzeichen,
//               Bindestrich und Unterstrich. Kein Pfadtrenner (auch kein Unicode-
//               Doppelgänger), keine Steuerzeichen, keine gemischten Schriften,
//               kein gesperrter System- oder Kategorieordner.
//   Sicherheit  Liegt die Konfidenz unter der eingestellten Schwelle (oder fehlt
//               sie, oder ist sie keine Zahl zwischen 0 und 1), gilt der Vorschlag
//               als „Kein Thema erkannt" — noch bevor er ins Frontend gelangt.
//
// Ein Name, der durchgeht, wird nie als Pfad benutzt: Gehört er zu einem Ordner,
// den es schon gibt, steht danach dessen Pfad aus der Ordnerliste des Servers da.
// Nur ein wirklich neuer Name bleibt ein Name — und der darf keinen Trenner
// enthalten, kann also nie einen Unterordner an fremder Stelle erzeugen.
const themen = require('./themen');

const NAME_MIN = 2;
const NAME_MAX = 40;

/** So heißt jeder verworfene Vorschlag nach außen. */
const KEIN_THEMA = 'Kein Thema erkannt';

// Zeichen, die einen Ordnerpfad gliedern — auf Servern je nach Hersteller "/" oder
// ".". Dazu die Unicode-Doppelgänger, die NFKC nicht auflöst (∕ ⁄ ⧸ ∖ ／ ＼).
const PFADTRENNER = /[\\/.∕⁄⧸∖⧵⧹／＼]/u;

// Das, woran zwei Namen als „derselbe Ordner" erkannt werden: klein, ohne Leer-
// zeichen, Bindestriche und Unterstriche. Sonst entkäme „Papier_korb" der Sperre
// für „Papierkorb".
const schluessel = (text) => String(text || '').toLowerCase().replace(/[\s_-]+/g, '');

// Der letzte Teil eines Serverpfads: "INBOX.Rechnungen" → "Rechnungen".
const letzterTeil = (pfad) => String(pfad || '').split(/[/.]/).pop();

const nein = (code, detail) => ({ ok: false, grund: KEIN_THEMA, code, detail });

/**
 * Prüft den Namen, den ein Modell als Ordner genannt hat.
 *
 * @param {*} roh                was das Modell geliefert hat
 * @param {object} [opt]
 * @param {object} [opt.konto]   Kontozeile (für dessen Kategorieordner)
 * @param {Iterable<string>} [opt.gesperrt] weitere gesperrte Namen — etwa der
 *   Papierkorb, wie der Server ihn tatsächlich nennt („Gelöschte Elemente")
 * @returns {{ok: true, name: string} | {ok: false, grund: string, code: string, detail: string}}
 */
function ordnerNamePruefen(roh, { konto = {}, gesperrt = [] } = {}) {
  if (typeof roh !== 'string') return nein('kein_text', 'Der Vorschlag ist kein Text.');

  let name = roh.normalize('NFC');
  // Abgelehnt, nicht entfernt: Aus "Ordner\r\nA001 DELETE INBOX" durch Streichen
  // des Umbruchs einen harmlos aussehenden Namen zu machen wäre genau die Lücke.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    return nein('steuerzeichen', 'Der Name enthält Steuer- oder unsichtbare Zeichen.');
  }
  name = name.trim().replace(/ {2,}/g, ' ');

  const laenge = Array.from(name).length;
  if (laenge < NAME_MIN || laenge > NAME_MAX) {
    return nein('laenge', `Der Name muss ${NAME_MIN} bis ${NAME_MAX} Zeichen lang sein (hat ${laenge}).`);
  }

  // Auch die kompatible Form prüfen: "．．" (Vollbreite) wird dort zu "..".
  const kompatibel = name.normalize('NFKC');
  if (PFADTRENNER.test(name) || PFADTRENNER.test(kompatibel)) {
    return nein('pfadtrenner', 'Der Name enthält einen Pfadtrenner.');
  }
  // Zeichenliste statt Sperrliste: Was nicht ausdrücklich erlaubt ist, fällt durch.
  if (!/^[\p{L}\p{Nd} _-]+$/u.test(name)) {
    return nein('zeichen', 'Erlaubt sind nur Buchstaben, Ziffern, Leerzeichen, "-" und "_".');
  }
  // Ligaturen, Vollbreite-Buchstaben & Co.: sehen aus wie Text, sind aber ein
  // anderer — und damit ein Weg, einen vorhandenen Namen zu imitieren.
  if (kompatibel !== name) return nein('zeichen', 'Der Name enthält Zeichen in Sonderform.');
  if (!/[\p{L}\p{Nd}]/u.test(name)) return nein('zeichen', 'Der Name besteht nur aus Trennzeichen.');

  // „Rechnungen" mit kyrillischem „с" ist kein Rechtschreibfehler, sondern ein
  // Doppelgänger. Eine Schrift je Name genügt für jeden echten Ordner.
  const schriften = ['Latin', 'Cyrillic', 'Greek']
    .filter((s) => new RegExp(`\\p{Script=${s}}`, 'u').test(name));
  if (schriften.length > 1) return nein('schriften', 'Der Name mischt verschiedene Schriften.');

  const sperre = new Set([...themen.reserviert(konto)].map(schluessel));
  for (const g of gesperrt) sperre.add(schluessel(g));
  if (sperre.has(schluessel(name))) {
    return nein('gesperrt', `„${name}" ist ein gesperrter System- oder Kategorieordner.`);
  }

  return { ok: true, name };
}

/**
 * Macht aus der Konfidenz-Angabe eines Modells eine Zahl — oder null.
 * Nur 0 bis 1 gilt. „85" (gemeint: Prozent) oder „hoch" ist keine Konfidenz,
 * sondern ein Formatfehler, und den darf man nicht schönrechnen.
 */
function konfidenzWert(roh) {
  if (typeof roh === 'string' && roh.trim() !== '') roh = Number(roh);
  if (typeof roh !== 'number' || !Number.isFinite(roh)) return null;
  return roh >= 0 && roh <= 1 ? roh : null;
}

/**
 * Prüft einen KI-Vorschlag als Ganzes.
 *
 * @param {{ordner: *, konfidenz: *}} vorschlag
 * @param {object} opt
 * @param {object} [opt.konto]
 * @param {number} opt.schwelle        die eingestellte Mindest-Konfidenz (z. B. 0.7)
 * @param {Array<string>} [opt.bekannt] Pfade der Ordner, die es schon gibt
 * @param {Iterable<string>} [opt.gesperrt]
 * @param {boolean} [opt.neueErlaubt]  false: ein neuer Ordnername wird verworfen
 * @returns {{ok: true, ordner: string, neu: boolean, konfidenz: number}
 *          | {ok: false, grund: string, code: string, detail: string}}
 */
function vorschlagPruefen({ ordner, konfidenz }, { konto = {}, schwelle, bekannt = [], gesperrt = [], neueErlaubt = true } = {}) {
  const pruefung = ordnerNamePruefen(ordner, { konto, gesperrt });
  if (!pruefung.ok) return pruefung;

  const wert = konfidenzWert(konfidenz);
  if (wert === null) {
    return nein('ohne_konfidenz', 'Die KI hat keine brauchbare Konfidenz (0 bis 1) geliefert.');
  }
  // Eine fehlende oder kaputte Schwelle macht STRENG, nicht offen: Number(null) ist
  // 0, und damit ginge jeder Vorschlag durch. Deshalb wird sie wie eine Konfidenz
  // gelesen (nur Zahlen von 0 bis 1) und fällt sonst auf 1 zurück.
  const grenze = konfidenzWert(schwelle) ?? 1;
  if (wert < grenze) {
    return nein('konfidenz', `Zu unsicher (${wert.toFixed(2)} < ${grenze}).`);
  }

  // Gibt es den Ordner schon? Dann zählt SEIN Pfad, nicht der Text des Modells.
  const gesucht = schluessel(pruefung.name);
  const treffer = [...bekannt].filter(Boolean).filter((p) => schluessel(letzterTeil(p)) === gesucht);
  if (treffer.length) {
    const genau = treffer.find((p) => p.toLowerCase() === pruefung.name.toLowerCase());
    return { ok: true, ordner: genau || treffer[0], neu: false, konfidenz: wert };
  }

  if (!neueErlaubt) return nein('neue_ordner_aus', 'Neue Ordner sind abgeschaltet.');
  return { ok: true, ordner: pruefung.name, neu: true, konfidenz: wert };
}

module.exports = {
  ordnerNamePruefen, konfidenzWert, vorschlagPruefen,
  schluessel, letzterTeil, NAME_MIN, NAME_MAX, KEIN_THEMA,
};
