// Harte Grenzen für Anhänge — ein Postfach ist keine vertrauenswürdige Quelle.
//
// Warum es das gibt: Bis Build 252 holte das Panel höchstens 20 Anhänge einer Mail
// und schnitt den Rest STILLSCHWEIGEND ab. Wer einer Mail 21 Dateien anhängte und
// die schädliche an die 21. Stelle setzte, kam am Virenscan vorbei: Er prüfte 20,
// meldete "sauber", und niemand erfuhr, dass etwas übersprungen worden war.
//
// Jetzt gilt: Wird eine Grenze überschritten, bricht die Verarbeitung der GANZEN
// Mail ab — bevor irgendetwas heruntergeladen wird. Der Virenscan meldet dann
// "nicht sauber" (die Mail geht in die Quarantäne), das Hochladen läuft gar nicht
// erst an. Eine Grenze, die nur kürzt, ist keine.

/** Höchstens so viele Anhänge je Mail. */
const MAX_ANHAENGE = 20;

/** Höchstens so groß darf eine einzelne Datei sein (30 MB, entpackt). */
const MAX_DATEI = 30 * 1024 * 1024;

/**
 * Höchstens so viel Inhalt zusammen geht an n8n zurück. Eine Datei darf 30 MB
 * haben, zwanzig davon wären 600 MB im Arbeitsspeicher von Panel UND n8n — als
 * base64 noch ein Drittel mehr. Was darüber liegt, kommt mit Namen und Größe, aber
 * ohne Inhalt zurück.
 */
const MAX_TRANSPORT = 60 * 1024 * 1024;

const MB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

// Der Text landet in der Telegram-Warnung des Workflows — und die ist Markdown.
// Ein Dateiname wie "rechnung_2026.pdf" öffnet dort einen Eintrag, der nie schließt;
// Telegram lehnt die Nachricht dann ab. Weil der Warn-Knoten VOR dem Quarantäne-
// Knoten läuft, würde ein Fehler dort die Quarantäne gleich mit verhindern. Der
// Dateiname kommt vom Absender der Mail — er darf also nichts anrichten können.
const markdownSicher = (text) => String(text == null ? '' : text).replace(/[_*`\[\]\\]/g, ' ').replace(/ {2,}/g, ' ');

/**
 * Wie groß ist der Anhang entpackt?
 *
 * Die BODYSTRUCTURE nennt die Größe im Transportformat. Bei base64 sind das gut ein
 * Drittel mehr als der Inhalt — sonst würde eine 25-MB-Datei als 33 MB gelten und
 * zu Unrecht abgewiesen. Geschätzt wird bewusst nicht nach unten: Beim Lesen
 * greift zusätzlich die echte Grenze (siehe imap.stromLesen).
 */
function entpackteGroesse(teil) {
  const roh = Number(teil?.groesse) || 0;
  return /base64/i.test(String(teil?.encoding || '')) ? Math.floor((roh * 3) / 4) : roh;
}

/**
 * Prüft die Anhang-Liste einer Mail gegen die harten Grenzen.
 * @param {Array<{name?: string, groesse?: number, encoding?: string}>} teile
 * @returns {null | {grund: 'zu_viele_anhaenge'|'datei_zu_gross', text: string, gefunden: number, name?: string, groesse?: number}}
 *   null = alles in Ordnung
 */
function grenzverstoss(teile) {
  const liste = Array.isArray(teile) ? teile : [];
  if (liste.length > MAX_ANHAENGE) {
    return {
      grund: 'zu_viele_anhaenge',
      gefunden: liste.length,
      text: `${liste.length} Anhänge (höchstens ${MAX_ANHAENGE} erlaubt)`,
    };
  }
  for (const teil of liste) {
    const groesse = entpackteGroesse(teil);
    if (groesse > MAX_DATEI) {
      return {
        grund: 'datei_zu_gross',
        gefunden: liste.length,
        name: teil.name,
        groesse,
        text: `Anhang „${markdownSicher(teil.name) || 'ohne Namen'}“ ist ${MB(groesse)} groß (höchstens ${MB(MAX_DATEI)} erlaubt)`,
      };
    }
  }
  return null;
}

/**
 * Sammelt Anhänge für die Rückgabe an n8n und achtet auf MAX_TRANSPORT.
 *
 * Jeder Anhang wird sofort in base64 umgewandelt und der Puffer freigegeben; was
 * über die Gesamtgrenze hinausginge, kommt mit Namen und Größe, aber ohne Inhalt
 * zurück — dann steht wenigstens im Lauf, warum nichts kam.
 *
 * @param {number} [grenze] Bytes, entpackt, zusammen
 */
function transportSammler(grenze = MAX_TRANSPORT) {
  const raus = [];
  let gesamt = 0;
  return {
    raus,
    aufnehmen(anhang) {
      if (anhang.fehler || !anhang.inhalt) {
        raus.push({ name: anhang.name, fehler: anhang.fehler || 'kein Inhalt' });
        return;
      }
      if (gesamt + anhang.inhalt.length > grenze) {
        raus.push({ name: anhang.name, groesse: anhang.inhalt.length, fehler: 'zusammen zu groß' });
        return;
      }
      gesamt += anhang.inhalt.length;
      raus.push({
        name: anhang.name,
        groesse: anhang.inhalt.length,
        base64: anhang.inhalt.toString('base64'),
      });
    },
  };
}

/**
 * Wie viele Bytes stecken in diesem base64-Text? Ohne ihn zu dekodieren — genau das
 * soll ja vermieden werden, wenn er zu groß ist.
 */
function base64Groesse(text) {
  const s = String(text || '');
  if (!s) return 0;
  const auffuellung = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - auffuellung);
}

/** Ist eine als base64 gelieferte Datei größer als MAX_DATEI? */
const base64ZuGross = (text) => base64Groesse(text) > MAX_DATEI;

/** Fehler beim Lesen: Der Strom lieferte mehr, als MAX_DATEI erlaubt. */
function zuGrossFehler(name) {
  return Object.assign(new Error('Anhang ist größer als erlaubt'), {
    grenze: true,
    verstoss: {
      grund: 'datei_zu_gross',
      name,
      text: `Anhang „${markdownSicher(name) || 'ohne Namen'}“ ist größer als ${MB(MAX_DATEI)}`,
    },
  });
}

/**
 * Die Antwort des Virenscans bei einem Verstoß: ausdrücklich NICHT sauber.
 * Der Workflow wertet `clean: false` wie einen Fund — Quarantäne und Meldung.
 */
const scanAbbruch = (verstoss, gefunden) => ({
  clean: false,
  virus: `Prüfgrenze überschritten: ${verstoss.text}`,
  abgebrochen: verstoss.grund,
  gefunden: gefunden ?? verstoss.gefunden ?? 0,
  geprueft: 0,
  ungeprueft: gefunden ?? verstoss.gefunden ?? 0,
  dateien: [],
});

module.exports = {
  MAX_ANHAENGE, MAX_DATEI, MAX_TRANSPORT,
  entpackteGroesse, grenzverstoss, transportSammler, base64Groesse, base64ZuGross,
  zuGrossFehler, scanAbbruch, MB, markdownSicher,
};
