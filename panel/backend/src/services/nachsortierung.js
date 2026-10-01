// Nachsortierung: nachts durch das ganze Postfach und geraderücken, was
// inzwischen anders geregelt ist.
//
// Eine Sortier-Regel wirkte bisher nur nach vorn. Wer eine falsch gelernte Regel
// korrigierte, reparierte damit nichts von dem, was schon im falschen Ordner
// lag — und bei einem Postfach, das über Wochen von einem kleinen Sprachmodell
// einsortiert wurde, ist genau das der größere Posten.
//
// Hier arbeitet KEINE KI. Verschoben wird ausschließlich, wofür eine Regel des
// Nutzers ein anderes Ziel nennt als den Ordner, in dem die Mail liegt. Das ist
// die ganze Idee: Die Regeln sind seine Entscheidung, sie sollen auch rückwärts
// gelten.
//
// Drei Dinge, die diesen Dienst von den anderen unterscheiden und die seinen
// Zuschnitt erklären:
//
//   * Er läuft unbeaufsichtigt und kann tausende Mails bewegen. Deshalb ist er
//     standardmäßig aus, beginnt als Trockenlauf und hat eine harte Obergrenze
//     je Lauf.
//   * Er fasst Ordner an, die sonst niemand anfasst. Papierkorb, Entwürfe und
//     Gesendet sind deshalb gesperrt — etwas aus dem Papierkorb zu holen hieße,
//     Gelöschtes wiederzubeleben.
//   * Er kennt keine UIDs aus der Vergangenheit. Er sieht nach, was JETZT in den
//     Ordnern liegt. Damit braucht er keinen Protokolleintrag und erwischt auch
//     die Mails, die vor dem Panel dort einsortiert wurden.
const db = require('../db');
const settings = require('./settings');
const imap = require('./imap');
const themen = require('./themen');
const sortierung = require('./sortierung');
const klassifizierer = require('./klassifizierer');
const kiVorschlag = require('./kiVorschlag');
const { loggen } = require('./panelLog');

// Ordnerrollen, die nie angefasst werden.
//
// `all` ist Gmails „Alle Nachrichten" — ein virtueller Ordner, der jede Mail ein
// zweites Mal zeigt. Dort zu verschieben hieße, dieselbe Mail doppelt zu
// bewegen. `archive` bleibt bewusst ERLAUBT: Das ist ein gewöhnliches Ablagefach
// und oft genau der Ort, an dem falsch Einsortiertes liegt.
const GESPERRTE_ROLLEN = new Set(['trash', 'drafts', 'sent', 'all', 'junk']);

// Wie viele Briefköpfe je Ordner höchstens gelesen werden.
const BRIEFKOEPFE_JE_ORDNER = 20000;
// Wie viele Beispiele das Ergebnis mitführt. Mehr liest ohnehin niemand, und der
// Eintrag steht in der Einstellungstabelle.
const BEISPIELE_MAX = 50;

function zahl(schluessel, standard, min, max) {
  const roh = Number(settings.hole(schluessel));
  if (!Number.isFinite(roh)) return standard;
  return Math.min(max, Math.max(min, Math.round(roh)));
}

function einstellungen() {
  return {
    aktiv: settings.hole('nachsortierung_aktiv') === '1',
    trockenlauf: settings.hole('nachsortierung_trockenlauf') !== '0',
    kiAktiv: settings.hole('nachsortierung_kiAktiv') === '1',
    taktStunden: zahl('nachsortierung_takt', 24, 1, 720),
    max: zahl('nachsortierung_max', 500, 1, 20000),
  };
}

function letzterLauf() {
  try {
    const roh = settings.hole('nachsortierung_letzter_lauf');
    return roh ? JSON.parse(roh) : null;
  } catch {
    return null;
  }
}

// Im Arbeitsspeicher, nicht in der Datenbank: Nach einem Neustart läuft
// garantiert nichts mehr, und eine hängengebliebene Sperre in der Datenbank
// blockierte die Nachsortierung für immer. (Dieselbe Überlegung wie bei der
// Postfach-Sicherung.)
let laufendSeit = null;
const laeuftGerade = () => laufendSeit !== null;

/** Ist ein Lauf fällig? */
function faellig() {
  const e = einstellungen();
  if (!e.aktiv) return false;
  const letzter = letzterLauf();
  if (!letzter?.zeitpunkt) return true;
  const her = Date.now() - Date.parse(letzter.zeitpunkt);
  return !Number.isFinite(her) || her >= e.taktStunden * 3600 * 1000;
}

/**
 * Welche Ordner dieses Kontos werden durchgesehen?
 *
 * Alles, was auswählbar ist — außer den gesperrten Rollen und dem Spam-Ordner
 * des Kontos. Spam bleibt draußen, weil eine Regel eine als Spam erkannte Mail
 * sonst wieder in den Posteingangsbereich zöge; wer das will, holt sie von Hand.
 */
function ordnerAuswahl(konto, details) {
  const spam = String(konto.folder_spam || imap.STANDARD.folder_spam || '').toLowerCase();
  return details
    .filter((o) => o.auswaehlbar !== false)
    .filter((o) => !GESPERRTE_ROLLEN.has(String(o.spezial || '')))
    .filter((o) => {
      const pfad = String(o.pfad || '').toLowerCase();
      if (!spam) return true;
      // Auch "INBOX.Junk" trifft den Spam-Ordner "Junk".
      return pfad !== spam && pfad.split(/[/.]/).pop() !== spam;
    })
    .map((o) => o.pfad)
    .filter(Boolean);
}

/**
 * Die Namen der Ordner, die ein KI-Vorschlag nie treffen darf.
 *
 * Gesperrt ist, was `ordnerAuswahl` nicht durchsieht — nur als Zielordner
 * gedacht: Papierkorb, Entwürfe, Gesendet, Gmails „Alle Nachrichten", der
 * Spam-Ordner des Kontos, dazu der Posteingang, Ansichten („Markiert", „Wichtig")
 * und Zwischenknoten ohne eigene Nachrichten. Es zählt, wie der SERVER sie nennt:
 * Ein Papierkorb heißt dort oft „Gelöschte Elemente" — und diesen Namen kennt
 * keine feste Liste.
 *
 * @returns {string[]} Pfade und Endstücke der gesperrten Ordner
 */
function gesperrteOrdner(konto, details) {
  const namen = new Set();
  const spam = String(konto?.folder_spam || imap.STANDARD.folder_spam || '').trim();
  if (spam) namen.add(spam);
  for (const o of details || []) {
    const rolle = String(o.spezial || '');
    const gesperrt = GESPERRTE_ROLLEN.has(rolle)
      || ['inbox', 'flagged', 'important'].includes(rolle)
      || o.auswaehlbar === false;
    if (!gesperrt || !o.pfad) continue;
    namen.add(o.pfad);
    namen.add(kiVorschlag.letzterTeil(o.pfad));
  }
  return [...namen];
}

/**
 * Prüft den Zielordner einer von Hand bestätigten Verschiebung.
 *
 * Der Name kommt aus dem Browser, und dort steht, was der Admin im Zielfeld
 * stehen hat — vorbelegt mit dem Vorschlag der KI. Darauf verlässt sich der
 * Server nicht:
 *
 *   * Ein Ordner, den es auf dem Server gibt, gilt mit SEINEM Pfad aus der
 *     Ordnerliste (auch mit Trennzeichen — „Archiv/2024" ist ein echter Ordner),
 *     es sei denn, er ist gesperrt (siehe gesperrteOrdner).
 *   * Alles andere wäre ein NEUER Ordner. Dafür gilt dieselbe strenge Namens-
 *     prüfung wie für Modellvorschläge: ohne Pfadtrenner, ohne Sonderzeichen,
 *     nicht wie ein System- oder Kategorieordner. Ein Tippfehler im Zielfeld legt
 *     so keinen Unterordner an fremder Stelle an.
 *
 * @param {object} konto
 * @param {Array} details Ergebnis von imap.ordnerDetails()
 * @param {*} wunsch      was im Zielfeld steht
 * @returns {{ok: true, pfad: string, neu: boolean} | {ok: false, code: string, fehler: string}}
 */
function zielPruefen(konto, details, wunsch) {
  const text = typeof wunsch === 'string' ? wunsch.trim() : '';
  if (!text) return { ok: false, code: 'leer', fehler: 'Kein Zielordner angegeben.' };

  const gesperrt = gesperrteOrdner(konto, details);
  const sperre = new Set(gesperrt.map(kiVorschlag.schluessel));
  const istGesperrt = (pfad) => sperre.has(kiVorschlag.schluessel(pfad))
    || sperre.has(kiVorschlag.schluessel(kiVorschlag.letzterTeil(pfad)));

  // 1. Gibt es den Ordner? Erst der genaue Pfad, dann das Endstück
  //    („Rechnungen" trifft „INBOX.Rechnungen").
  const klein = text.toLowerCase();
  const frei = (details || []).filter((o) => o.pfad && o.auswaehlbar !== false);
  const treffer = frei.find((o) => o.pfad.toLowerCase() === klein)
    || frei.find((o) => kiVorschlag.letzterTeil(o.pfad).toLowerCase() === klein);
  if (treffer) {
    if (istGesperrt(treffer.pfad) || GESPERRTE_ROLLEN.has(String(treffer.spezial || ''))) {
      return { ok: false, code: 'gesperrt', fehler: `„${treffer.pfad}" ist ein gesperrter System- oder Kategorieordner.` };
    }
    return { ok: true, pfad: treffer.pfad, neu: false };
  }

  // 2. Ein neuer Ordner — streng.
  const name = kiVorschlag.ordnerNamePruefen(text, { konto, gesperrt });
  if (!name.ok) {
    return { ok: false, code: name.code, fehler: `Ordnername nicht zulässig: ${name.detail}` };
  }
  return { ok: true, pfad: name.name, neu: true };
}

/** Zwei Ordnerpfade, die dasselbe Fach meinen? "INBOX.Rechnungen" = "Rechnungen". */
function selberOrdner(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.split(/[/.]/).pop() === y.split(/[/.]/).pop();
}

/**
 * Welche Regel gilt für diesen Briefkopf — wenn sich das ohne Mailtext
 * überhaupt sagen lässt?
 *
 * Die Nachsortierung liest nur Absender und Betreff. Eine Regel mit
 * Inhalts-Stichwort („info@versand.example + ‚Rechnung' → Rechnungen") kann
 * dann nie greifen — und bisher gewann an ihrer Stelle die nächste Regel
 * („info@versand.example → Newsletter"). Jede Nacht wanderten so die
 * Rechnungen aus „Rechnungen" in den Newsletter-Ordner: genau das, wofür die
 * Inhalts-Regel angelegt worden war.
 *
 * Deshalb: Passt eine Inhalts-Regel auf Absender und Betreff, und nur das
 * Stichwort ist unbekannt, ist die Mail nicht entscheidbar und bleibt liegen.
 * Steht das Stichwort schon im Betreff, gilt die Regel.
 *
 * @returns {object|null} die Regel, `{ unentscheidbar: true }` oder null
 */
function regelFuerBriefkopf(regeln, von, betreff) {
  for (const r of regeln) {
    const inhalt = String(r.inhalt_muster || '').trim();
    if (inhalt) {
      if (sortierung.passt(r, von, betreff)) return r;
      if (sortierung.passt({ ...r, inhalt_muster: '' }, von, betreff)) return { unentscheidbar: true };
      continue;
    }
    if (sortierung.passt(r, von, betreff)) return r;
  }
  return null;
}

// Welche Mails schon einmal als KI-Vorschlag gezeigt wurden.
//
// Ohne das nahm jeder Lauf dieselben ersten Mails eines Ordners — bei gleichem
// Ergebnis. Im Arbeitsspeicher, weil es nur um die Abwechslung zwischen
// Läufen geht; nach einem Neustart darf es von vorn beginnen.
const kiGezeigt = new Set();
const KI_GEZEIGT_MAX = 20000;

/**
 * Ein Konto durchsehen.
 * @returns {Promise<{geprueft:number, treffer:number, verschoben:number,
 *                    fehlgeschlagen:number, vorschlaege:number,
 *                    fehler:string[], beispiele:object[]}>}
 */
async function kontoDurchgehen(konto, { trockenlauf, rest }) {
  const ergebnis = {
    geprueft: 0, treffer: 0, verschoben: 0, fehlgeschlagen: 0, vorschlaege: 0,
    // KI-Vorschläge, die die Prüfung (Name, Konfidenz) nicht bestanden haben —
    // sie gelten als „Kein Thema erkannt" und erreichen nie die Oberfläche.
    verworfen: 0, verworfenGruende: {},
    fehler: [], beispiele: [],
  };
  const regeln = sortierung.regelnGeordnet(konto.id);
  if (regeln.length === 0) return ergebnis;

  const zugang = themen.zugang(konto);
  const details = await imap.ordnerDetails({ ...konto, ...zugang });
  const ordner = ordnerAuswahl(konto, details);

  for (const quelle of ordner) {
    if (rest.uebrig <= 0) break;

    let mails = [];
    try {
      mails = await imap.briefkoepfe({ ...zugang, ordner: quelle, grenze: BRIEFKOEPFE_JE_ORDNER });
    } catch (err) {
      ergebnis.fehler.push(`${konto.name}/${quelle}: ${err.message}`);
      continue;
    }
    ergebnis.geprueft += mails.length;

    // Je Zielordner sammeln — verschoben wird gebündelt, nicht Mail für Mail.
    const nachZiel = new Map();
    for (const m of mails) {
      if (rest.uebrig <= 0) break;
      const regel = regelFuerBriefkopf(regeln, m.von, m.betreff);
      if (!regel || regel.unentscheidbar) continue;
      // „In Ruhe lassen" heißt ausdrücklich: nicht anfassen. Diese Regel ist
      // die einzige, die ein Nichthandeln anordnet — sie hier zu übergehen
      // wäre das Gegenteil dessen, was der Nutzer gesagt hat.
      if ((regel.aktion || 'verschieben') === 'behalten') continue;
      const ziel = String(regel.zielordner || '').trim();
      if (!ziel || selberOrdner(quelle, ziel)) continue;

      if (!nachZiel.has(ziel)) nachZiel.set(ziel, []);
      nachZiel.get(ziel).push({ ...m, regel });
      ergebnis.treffer += 1;
      rest.uebrig -= 1;
      if (ergebnis.beispiele.length < BEISPIELE_MAX) {
        ergebnis.beispiele.push({
          konto: konto.name,
          // Beides gehört dazu, sonst ist die Liste nur zum Lesen da: Mit der
          // UID lässt sich diese eine Mail umlenken, mit der Regel-Kennung die
          // Ursache — also alle künftigen Mails dieses Absenders gleich mit.
          kontoId: konto.id,
          uid: m.uid,
          regelId: regel.id,
          von: m.von,
          betreff: String(m.betreff || '').slice(0, 120),
          vonOrdner: quelle,
          nachOrdner: ziel,
          regel: `${regel.typ}: ${regel.muster}${regel.betreff_muster ? ` + Betreff „${regel.betreff_muster}"` : ''}`,
        });
      }
    }

    const fuerKI = [];
    const e = einstellungen();
    if (e.kiAktiv) {
      for (const m of mails) {
        const regel = regelFuerBriefkopf(regeln, m.von, m.betreff);
        if (!regel && !themen.istGelernt(konto.id, quelle, m.von, m.betreff)) {
          fuerKI.push(m);
        }
      }
    }

    // KI-Vorschläge berechnen. Sie werden nur ANGEZEIGT, nie verschoben — und
    // zählen deshalb auch nicht gegen die Obergrenze. Bisher verbrauchten sie
    // deren Plätze: „470 von 500 verschoben … Obergrenze erreicht", obwohl 30
    // der 500 gar keine Verschiebungen waren.
    if (e.kiAktiv && fuerKI.length > 0) {
      // Nur einen kleinen Bündel an KI übergeben — bevorzugt Mails, die noch
      // nicht vorgeschlagen wurden.
      const kiBuendelGroesse = zahl('ollama_buendel', 2, 1, 10);
      const schluessel = (m) => `${konto.id}|${quelle}|${m.uid}`;
      const neu = fuerKI.filter((m) => !kiGezeigt.has(schluessel(m)));
      const batchKI = (neu.length ? neu : fuerKI).slice(0, kiBuendelGroesse);
      if (kiGezeigt.size > KI_GEZEIGT_MAX) kiGezeigt.clear();
      for (const m of batchKI) kiGezeigt.add(schluessel(m));
      try {
        const geladen = [];
        for (const m of batchKI) {
           try {
             const inhalt = await imap.mailLaden({ ...zugang, ordner: quelle, uid: m.uid });
             if (inhalt && inhalt.text) {
               geladen.push({ ...m, konto: konto.name, text: inhalt.text });
             }
           } catch { /* ignorieren */ }
        }

        if (geladen.length > 0) {
          const kiErgebnis = await klassifizierer.klassifizieren(geladen);

          // Was die Prüfung der Modellvorschläge braucht — einmal je Ordner
          // ausgerechnet, nicht je Mail.
          const themenEinst = themen.einstellungen();
          const pruefOptionen = {
            konto,
            // Die eingestellte Mindest-Sicherheit (Einstellungen → Themen-Sortierung),
            // nicht eine eigene: Wer sie anhebt, will sie überall.
            schwelle: themenEinst.konfidenz,
            neueErlaubt: themenEinst.anlegen !== 'aus',
            gesperrt: gesperrteOrdner(konto, details),
            // Nur Ordner, die es gibt UND die ein Ziel sein dürfen. Ihr Pfad stammt
            // vom Server oder aus dem Katalog — nie aus dem Text des Modells.
            bekannt: [...new Set([...ordner, ...themen.katalog(konto.id).map((o) => o.ordner)])],
          };

          for (let i = 0; i < geladen.length; i++) {
            const res = kiErgebnis.ergebnisse[i];
            if (!res || !res.ordner) continue;

            const m = geladen[i];
            let ziel;
            let neuerOrdner = false;
            let konfidenz = Number(res.konfidenz) || 0;

            if (res.regel) {
              // Eine eigene Regel oder ein Stichwort, das erst mit dem Mailtext
              // greift: Der Ordner stammt aus den Einstellungen des Nutzers, nicht
              // aus dem Modell — hier gibt es nichts zu prüfen.
              ziel = String(res.ordner).trim();
            } else {
              const urteil = kiVorschlag.vorschlagPruefen(
                { ordner: res.ordner, konfidenz: res.konfidenz }, pruefOptionen,
              );
              if (!urteil.ok) {
                ergebnis.verworfen += 1;
                ergebnis.verworfenGruende[urteil.code] = (ergebnis.verworfenGruende[urteil.code] || 0) + 1;
                continue;
              }
              ziel = urteil.ordner;
              neuerOrdner = urteil.neu;
              konfidenz = urteil.konfidenz;
            }
            if (!ziel || selberOrdner(quelle, ziel)) continue;

            ergebnis.vorschlaege += 1;
            if (ergebnis.beispiele.length < BEISPIELE_MAX) {
              ergebnis.beispiele.push({
                konto: konto.name,
                kontoId: konto.id,
                uid: m.uid,
                regelId: null, // KI hat keine RegelId
                von: m.von,
                betreff: String(m.betreff || '').slice(0, 120),
                vonOrdner: quelle,
                nachOrdner: ziel,
                regel: res.regel
                  ? `Regel/Stichwort mit Mailtext: ${String(res.kurzfassung || '').slice(0, 80)}`
                  : `KI-Vorschlag (${Math.round(konfidenz * 100)}%)`,
                isKI: true,
                // Ein Ordner, den es noch nicht gibt: Er entsteht erst, wenn ein
                // Admin den Vorschlag bestätigt.
                neuerOrdner,
                konfidenz,
                grund: String(res.kurzfassung || 'KI-Vorschlag').slice(0, 200),
              });
            }
          }
        }
      } catch (err) {
         ergebnis.fehler.push(`${konto.name}/${quelle} (KI): ${err.message}`);
      }
    }

    if (trockenlauf) continue;

    for (const [ziel, liste] of nachZiel) {
      try {
        const pfad = (await themen.ordnerPfad(konto, ziel)) || ziel;
        if (selberOrdner(quelle, pfad)) continue;
        const r = await imap.mailsVerschieben({
          ...zugang, mails: liste, von: quelle, nach: pfad,
        });
        ergebnis.verschoben += r.verschoben.length;
        ergebnis.fehlgeschlagen += r.fehler.length;
        for (const f of r.fehler.slice(0, 5)) {
          ergebnis.fehler.push(`${konto.name}/${quelle} UID ${f.uid}: ${f.grund}`);
        }
        // Nur was wirklich umgezogen ist: Eine Mail, die sich nicht verschieben
        // ließ, liegt weiter hier — das Gelernte über diesen Ordner stimmt dann.
        for (const m of r.verschoben) {
          try { themen.gelerntVergessen(konto.id, quelle, m.von); } catch { /* nicht so wichtig */ }
        }
      } catch (err) {
        ergebnis.fehler.push(`${konto.name}/${quelle} → ${ziel}: ${err.message}`);
      }
    }
    themen.cacheVerwerfen(konto.id);
  }

  return ergebnis;
}

/**
 * Ein Lauf über alle aktiven Konten.
 * @param {object} [opt]
 * @param {boolean} [opt.trockenlauf] Überschreibt die Einstellung.
 */
async function lauf(opt = {}) {
  if (laufendSeit) {
    const her = Math.round((Date.now() - laufendSeit) / 1000);
    throw new Error(`Es läuft bereits eine Nachsortierung (seit ${her} s).`);
  }
  const e = einstellungen();
  const trockenlauf = opt.trockenlauf === undefined ? e.trockenlauf : Boolean(opt.trockenlauf);
  laufendSeit = Date.now();

  const gesamt = {
    zeitpunkt: new Date().toISOString(),
    trockenlauf,
    geprueft: 0,
    treffer: 0,
    verschoben: 0,
    fehlgeschlagen: 0,
    vorschlaege: 0,
    verworfen: 0,
    verworfenGruende: {},
    fehler: [],
    beispiele: [],
    sekunden: 0,
  };
  // Die Obergrenze gilt für den ganzen Lauf, nicht je Konto — sonst wären es
  // bei drei Konten unversehens dreimal so viele.
  const rest = { uebrig: e.max };

  try {
    const konten = db.prepare('SELECT * FROM accounts WHERE aktiv = 1').all();
    for (const konto of konten) {
      try {
        const r = await kontoDurchgehen(konto, { trockenlauf, rest });
        gesamt.geprueft += r.geprueft;
        gesamt.treffer += r.treffer;
        gesamt.verschoben += r.verschoben;
        gesamt.fehlgeschlagen += r.fehlgeschlagen || 0;
        gesamt.vorschlaege += r.vorschlaege || 0;
        gesamt.verworfen += r.verworfen || 0;
        for (const [code, anzahl] of Object.entries(r.verworfenGruende || {})) {
          gesamt.verworfenGruende[code] = (gesamt.verworfenGruende[code] || 0) + anzahl;
        }
        gesamt.fehler.push(...r.fehler);
        for (const b of r.beispiele) {
          if (gesamt.beispiele.length < BEISPIELE_MAX) gesamt.beispiele.push(b);
        }
      } catch (err) {
        // Ein nicht erreichbares Postfach darf den Lauf der anderen nicht kippen
        // — dieselbe Haltung wie in der Bestands-Auswahl.
        gesamt.fehler.push(`${konto.name}: ${err.message}`);
      }
    }

    gesamt.sekunden = Math.round((Date.now() - laufendSeit) / 1000);
    gesamt.fehler = gesamt.fehler.slice(0, 20);
    settings.setze('nachsortierung_letzter_lauf', JSON.stringify(gesamt));

    // Jede Zahl steht für sich: verschoben, gescheitert, nur vorgeschlagen.
    // „470 von 500" ließ offen, was mit den 30 anderen war.
    const wort = trockenlauf
      ? `${gesamt.treffer} Mail(s) würden verschoben (Trockenlauf, nichts bewegt)`
      : `${gesamt.verschoben} Mail(s) verschoben`
        + (gesamt.fehlgeschlagen ? `, ${gesamt.fehlgeschlagen} ließen sich nicht verschieben` : '');
    loggen(gesamt.fehler.length ? 'warn' : 'info', 'nachsortierung',
      `Nachsortierung: ${gesamt.geprueft} Mail(s) geprüft, ${wort}`
      + (gesamt.vorschlaege ? `, ${gesamt.vorschlaege} KI-Vorschlag/Vorschläge zur Ansicht` : '')
      // Was die Prüfung aussortiert hat, soll auffallen: Ein Modell, das plötzlich
      // lauter unzulässige Namen liefert, ist ein Hinweis, dass etwas nicht stimmt.
      + (gesamt.verworfen
        ? `, ${gesamt.verworfen} KI-Vorschlag/Vorschläge verworfen (Kein Thema erkannt: `
          + `${Object.entries(gesamt.verworfenGruende).map(([c, n]) => `${c} ${n}`).join(', ')})`
        : '')
      + `, ${gesamt.sekunden} s.`
      + (gesamt.treffer >= e.max ? ` Obergrenze von ${e.max} erreicht — der Rest kommt beim nächsten Lauf.` : ''));
    return gesamt;
  } finally {
    laufendSeit = null;
  }
}

// Das Panel hat keinen eigenen Zeitplaner. Statt einen einzuführen, wird
// stündlich nachgesehen, ob der letzte Lauf lange genug her ist. Das übersteht
// auch einen Neustart, weil der Zeitpunkt in den Einstellungen steht und nicht
// im Arbeitsspeicher.
let uhr = null;

function zeitplanStarten(intervallMs = 3600 * 1000) {
  if (uhr) clearInterval(uhr);
  uhr = setInterval(() => {
    if (!faellig() || laeuftGerade()) return;
    lauf().catch((err) => loggen('error', 'nachsortierung', `Lauf gescheitert: ${err.message}`));
  }, intervallMs);
  if (uhr.unref) uhr.unref();
  return uhr;
}

module.exports = {
  lauf,
  faellig,
  laeuftGerade,
  einstellungen,
  letzterLauf,
  ordnerAuswahl,
  gesperrteOrdner,
  zielPruefen,
  selberOrdner,
  zeitplanStarten,
  regelFuerBriefkopf,
  GESPERRTE_ROLLEN,
};
