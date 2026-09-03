// Das Schema für eigene Aktionen — die einzige Stelle, an der festgelegt ist,
// was eine Aktion überhaupt sein kann.
//
// Warum so streng: Die KI schlägt Regeln vor, aber sie darf nichts erfinden.
// Alles, was hier nicht steht, wird beim Prüfen verworfen. Dadurch kann aus einer
// missverstandenen Beschreibung nie ein kaputter oder gefährlicher Workflow werden.

// Felder, auf die sich eine Bedingung beziehen darf. Sie stammen alle aus der
// Normalisierung in den Workflows 01 und 04.
const FELDER = {
  von:       { label: 'Absender', typ: 'text' },
  betreff:   { label: 'Betreff', typ: 'text' },
  konto:     { label: 'Konto', typ: 'text' },
  kategorie: { label: 'Kategorie der KI', typ: 'auswahl',
               werte: ['spam', 'rechnung', 'bestellung', 'newsletter', 'persoenlich', 'sonstiges'] },
  hat_anhang: { label: 'Hat Anhang', typ: 'boolean' },
};

const VERGLEICHE = {
  enthaelt:    { label: 'enthält', fuer: ['text'] },
  ist:         { label: 'ist genau', fuer: ['text', 'auswahl'] },
  endet_auf:   { label: 'endet auf', fuer: ['text'] },
  beginnt_mit: { label: 'beginnt mit', fuer: ['text'] },
  ist_wahr:    { label: 'trifft zu', fuer: ['boolean'] },
};

// Aktionstypen mit ihren Pflicht- und Wahlfeldern
const TYPEN = {
  nextcloud_datei: {
    label: 'Anhang in Nextcloud ablegen',
    felder: {
      ordner: { label: 'Zielordner', pflicht: true, platzhalter: 'Belege/{{jahr}}/{{firma}}' },
      dateiname: { label: 'Dateiname (leer = Originalname)', platzhalter: '{{datum}} {{firma}} {{betreff}}' },
      nur_anhaenge: { label: 'Nur Anhänge (nicht die Mail selbst)', typ: 'boolean', standard: true },
      auslesen: { label: 'Inhalt lesen & prüfen (Aktenzeichen, Datum, Firma — nur echte Belege)', typ: 'boolean', standard: false },
    },
  },
  nextcloud_kalender: {
    label: 'Termin im Nextcloud-Kalender anlegen',
    felder: {
      titel: { label: 'Titel des Termins', pflicht: true, platzhalter: '{{betreff}}' },
      dauer_minuten: { label: 'Dauer in Minuten', typ: 'zahl', standard: 60 },
    },
  },
  google_kalender: {
    label: 'Termin im Google-Kalender anlegen',
    felder: {
      titel: { label: 'Titel des Termins', pflicht: true, platzhalter: '{{betreff}}' },
      dauer_minuten: { label: 'Dauer in Minuten', typ: 'zahl', standard: 60 },
    },
  },
  webhook: {
    label: 'Eigene Adresse aufrufen',
    felder: {
      url: { label: 'Adresse', pflicht: true, platzhalter: 'https://example.org/haken' },
      methode: { label: 'Methode', typ: 'auswahl', werte: ['POST', 'GET'], standard: 'POST' },
    },
  },
};

// Platzhalter, die in Textfeldern erlaubt sind. firma/datum/aktenzeichen füllt
// der Beleg-Knoten in Workflow 07 (aus dem Absender bzw. beim Auslesen aus dem PDF).
const PLATZHALTER = ['{{jahr}}', '{{monat}}', '{{tag}}', '{{absender}}', '{{betreff}}', '{{konto}}', '{{kategorie}}', '{{firma}}', '{{datum}}', '{{aktenzeichen}}'];

/**
 * Prüft einen Aktions-Entwurf (egal ob von der KI oder vom Formular).
 * @returns {{ok: true, aktion: object} | {ok: false, fehler: string[]}}
 */
function pruefe(entwurf) {
  const fehler = [];
  const e = entwurf || {};

  if (!e.name || String(e.name).trim().length < 2) fehler.push('Der Name fehlt.');
  if (!TYPEN[e.typ]) fehler.push(`Unbekannte Aktion: ${e.typ}`);

  // ── Bedingungen ──
  const bedingungen = Array.isArray(e.bedingung?.regeln) ? e.bedingung.regeln : [];
  if (bedingungen.length === 0) {
    fehler.push('Ohne Bedingung würde die Aktion auf jede Mail zutreffen.');
  }
  const geprüfteRegeln = [];
  for (const r of bedingungen) {
    const feld = FELDER[r.feld];
    if (!feld) { fehler.push(`Unbekanntes Feld: ${r.feld}`); continue; }
    const vgl = VERGLEICHE[r.vergleich];
    if (!vgl) { fehler.push(`Unbekannter Vergleich: ${r.vergleich}`); continue; }
    if (!vgl.fuer.includes(feld.typ)) {
      fehler.push(`„${vgl.label}" passt nicht zu „${feld.label}".`);
      continue;
    }
    if (feld.typ === 'auswahl' && !feld.werte.includes(String(r.wert))) {
      fehler.push(`„${r.wert}" ist kein gültiger Wert für ${feld.label}.`);
      continue;
    }
    if (feld.typ !== 'boolean' && !String(r.wert || '').trim()) {
      fehler.push(`Für ${feld.label} fehlt der Wert.`);
      continue;
    }
    geprüfteRegeln.push({
      feld: r.feld,
      vergleich: r.vergleich,
      wert: feld.typ === 'boolean' ? true : String(r.wert).trim(),
    });
  }

  // ── Konfiguration der Aktion ──
  const konfig = {};
  if (TYPEN[e.typ]) {
    for (const [name, feld] of Object.entries(TYPEN[e.typ].felder)) {
      let wert = e.konfig?.[name];
      if (wert === undefined || wert === '') wert = feld.standard;
      if (feld.pflicht && (wert === undefined || String(wert).trim() === '')) {
        fehler.push(`${feld.label} fehlt.`);
        continue;
      }
      if (feld.typ === 'zahl') wert = Number(wert) || feld.standard;
      if (feld.typ === 'boolean') wert = Boolean(wert);
      if (feld.typ === 'auswahl' && !feld.werte.includes(wert)) wert = feld.standard;
      konfig[name] = wert;
    }
  }

  if (fehler.length) return { ok: false, fehler };
  return {
    ok: true,
    aktion: {
      name: String(e.name).trim().slice(0, 60),
      beschreibung: e.beschreibung ? String(e.beschreibung).slice(0, 300) : null,
      typ: e.typ,
      bedingung: { verknuepfung: e.bedingung?.verknuepfung === 'oder' ? 'oder' : 'und', regeln: geprüfteRegeln },
      konfig,
    },
  };
}

// Für die Oberfläche und den KI-Prompt
const beschreibung = () => ({ felder: FELDER, vergleiche: VERGLEICHE, typen: TYPEN, platzhalter: PLATZHALTER });

module.exports = { FELDER, VERGLEICHE, TYPEN, PLATZHALTER, pruefe, beschreibung };
