// Hilfen rund um die Sortier-Inbox, die mehr als eine Ansicht braucht.
//
// Ausgangspunkt war der Diagnosebericht vom 17.09.: 1.750 offene Zuordnungen,
// und nirgends war zu sehen, woraus dieser Stapel besteht. Erst die
// Aufschlüsselung nach Kategorie und Grund zeigt, ob da 600 persönliche Mails
// ohne Thema liegen oder 300 Vorschläge für einen neuen Ordner, der nur noch
// freigegeben werden müsste — und das sind zwei völlig verschiedene Aufgaben.

// ─── Absender ────────────────────────────────────────────────────────────────

// "Name <a@b.de>" -> "a@b.de" bzw. "b.de"
export const adresse = (von) => {
  const roh = String(von || '').toLowerCase().trim();
  const t = roh.match(/<([^>]+)>/);
  return (t ? t[1] : roh).trim();
};
export const domainVon = (von) => (adresse(von).split('@')[1] || '').trim();

// ─── Vorschläge ──────────────────────────────────────────────────────────────

// Ein Stichwort aus Betreffzeilen vorschlagen.
//
// Gesucht wird das Wort, das in möglichst vielen der markierten Betreffe
// vorkommt — bei drei „easyJet Buchungsbestätigung"-Mails also
// „buchungsbestätigung". Bei Gleichstand gewinnt das längere Wort: Es ist das
// kennzeichnendere.
//
// Die frühere Fassung nahm, wenn kein Wort in ALLEN Betreffen vorkam, das
// längste Wort des ERSTEN Betreffs. Das ergab Vorschläge wie
// „datenschutzerklärung" für sieben Finanzguru-Mails, von denen nur eine so
// hieß — als Regel also ein Wort, das mit den anderen sechs nichts zu tun hat.
// Deshalb jetzt: Ein Stichwort muss in mindestens der Hälfte der Betreffe
// stehen (dieselbe Schwelle wie beim Ordner-Vorschlag), sonst bleibt das Feld
// leer. Kein Vorschlag ist besser als ein falscher — der Nutzer weiß ohnehin
// besser als jede Heuristik, woran er diese Sorte Mail erkennt.
const WORT = /[\p{L}\p{N}]{4,}/gu;

// Wörter, die in fast jedem Betreff stehen können und nichts über das Thema
// sagen. Als Regel wären sie die schlechteste Wahl: Sie greifen früher oder
// später auf alles, was dieser Absender schickt.
const FUELLWOERTER = new Set([
  'dein', 'deine', 'deinem', 'deinen', 'deiner', 'ihre', 'ihrem', 'ihren', 'ihrer',
  'unser', 'unsere', 'unserem', 'unseren', 'unserer', 'eine', 'einem', 'einen', 'einer', 'eines',
  'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'denen', 'deren',
  'oder', 'aber', 'auch', 'dass', 'damit', 'dabei', 'sowie', 'nach', 'noch', 'nicht',
  'sind', 'sich', 'über', 'unter', 'wird', 'werden', 'wurde', 'wurden',
  'haben', 'hatte', 'hatten', 'kann', 'können', 'hier', 'jetzt', 'heute', 'mehr', 'alle', 'allen',
  'bitte', 'mail', 'email', 'nachricht', 'the', 'your', 'you', 'for', 'and', 'with', 'from',
]);

export const stichwortVorschlag = (betreffe) => {
  const listen = (betreffe || [])
    .map((b) => String(b || '').toLowerCase().match(WORT) || [])
    .map((woerter) => woerter.filter((w) => !FUELLWOERTER.has(w)))
    .filter((woerter) => woerter.length > 0);
  if (listen.length === 0) return '';

  // In wie vielen Betreffen kommt das Wort vor? Mehrfach in derselben Zeile
  // zählt einmal, sonst gewänne ein Wort, das ein einziger Betreff wiederholt.
  const treffer = new Map();
  for (const liste of listen) {
    for (const w of new Set(liste)) treffer.set(w, (treffer.get(w) || 0) + 1);
  }

  const noetig = Math.ceil(listen.length / 2);
  const auswahl = [...treffer.entries()]
    .filter(([, anzahl]) => anzahl >= noetig)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  return auswahl[0]?.[0] || '';
};

// Der Mehrheitsvorschlag der KI für einen Stapel Mails.
//
// Die KI schlägt zu jeder einzelnen Mail einen Ordner vor. Stimmen mindestens
// die Hälfte der Mails überein, ist das kein Vorschlag mehr, den man erst
// suchen muss — er wird vorbelegt. Änderbar bleibt er trotzdem.
export function mehrheitsVorschlag(mails) {
  const zaehler = new Map();
  for (const m of mails || []) {
    const o = String(m.ki_ordner || '').trim();
    if (!o) continue;
    zaehler.set(o, (zaehler.get(o) || 0) + 1);
  }
  if (zaehler.size === 0) return null;
  const [ordner, anzahl] = [...zaehler.entries()].sort((a, b) => b[1] - a[1])[0];
  return anzahl >= Math.ceil(mails.length / 2) ? ordner : null;
}

// ─── Bündel nach Inhalt ──────────────────────────────────────────────────────
//
// Die Absender-Ansicht bündelt nach Domain. Bei persönlicher Post und bei
// Anbietern, die alles über dieselbe Adresse schicken, hilft das wenig: viele
// Gruppen mit ein, zwei Mails, und dieselbe Sorte Mail („Passwort
// zurücksetzen", „Inkasso troy 28364…") von verschiedenen Absendern steht an
// verschiedenen Stellen. Hier zählt der Betreff, nicht die Adresse.
//
// Zahlen werden zu #, Satzzeichen fallen weg — wie betreffMuster() in
// services/klassifizierer.js. Zusätzlich fallen Antwort-Vorsilben weg, damit
// „Re: Angebot" und „Angebot" in dasselbe Bündel kommen.
const ANTWORT = /^(?:(?:re|aw|wg|fw|fwd|antw|sv|tr)\s+)+/;
export function inhaltsSchluessel(betreff) {
  const muster = String(betreff || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-zäöüß#\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ANTWORT, '')
    .slice(0, 60)
    .trim();
  // Nur Nummern oder ein kurzes Wort („#", „info") sind kein Inhalt, sondern
  // Zufall — daraus entstünden Bündel aus Mails, die nichts gemeinsam haben.
  const buchstaben = (muster.match(/[a-zäöüß]/g) || []).length;
  return buchstaben >= 4 ? muster : '';
}

const zaehlen = (werte) => {
  const map = new Map();
  for (const w of werte) map.set(w, (map.get(w) || 0) + 1);
  return [...map.entries()]
    .map(([wert, anzahl]) => ({ wert, anzahl }))
    .sort((a, b) => b.anzahl - a.anzahl || String(a.wert).localeCompare(String(b.wert)));
};

// Bündel ab zwei Mails; alles andere zählt als „einzeln" und bleibt in der
// Absender-Ansicht zu entscheiden.
export function inhaltsBuendel(mails) {
  const map = new Map();
  let einzeln = 0;
  for (const m of mails || []) {
    const muster = inhaltsSchluessel(m.betreff);
    if (!muster) { einzeln += 1; continue; }
    // Nie über Postfächer hinweg: Verschoben wird mit den Zugangsdaten EINES
    // Kontos.
    const schluessel = `${m.konto_id}|${muster}`;
    if (!map.has(schluessel)) map.set(schluessel, { schluessel, muster, mails: [] });
    map.get(schluessel).mails.push(m);
  }
  const buendel = [];
  for (const b of map.values()) {
    if (b.mails.length < 2) { einzeln += b.mails.length; continue; }
    const domains = zaehlen(b.mails.map((m) => domainVon(m.von) || '(ohne Absender)'));
    buendel.push({
      ...b,
      domains: { anzahl: domains.length, top: domains.slice(0, 3) },
      beispiele: [...new Set(b.mails.map((m) => String(m.betreff || '').trim()).filter(Boolean))].slice(0, 3),
      kiVorschlag: mehrheitsVorschlag(b.mails),
      kategorie: zaehlen(b.mails.map(kategorieVon))[0]?.wert || 'unbekannt',
    });
  }
  buendel.sort((a, b) => b.mails.length - a.mails.length || a.muster.localeCompare(b.muster));
  return { buendel, einzeln };
}

// ─── Aufschlüsselung und Filter ──────────────────────────────────────────────

// Dieselben Werte wie KATEGORIEN in services/klassifizierer.js.
export const KATEGORIEN = [
  { wert: 'persoenlich', text: 'Persönlich' },
  { wert: 'sonstiges', text: 'Sonstiges' },
  { wert: 'newsletter', text: 'Newsletter' },
  { wert: 'rechnung', text: 'Rechnung' },
  { wert: 'bestellung', text: 'Bestellung' },
  { wert: 'spam', text: 'Spam' },
  // Einträge von vor Build 229 haben keine Kategorie. Sie füllt sich beim
  // nächsten Bestandslauf nach — bis dahin sollen sie nicht einfach aus der
  // Summe fallen.
  { wert: 'unbekannt', text: 'noch nicht erfasst' },
];

// Warum die Mail liegen blieb. Die Texte stammen aus themen.aufloesen() und
// /einsortieren; hier werden sie zu wenigen Klassen zusammengefasst, weil
// „zu unsicher (0.41 < 0.6)" und „zu unsicher (0.38 < 0.6)" für die Frage
// „was ist zu tun?" dasselbe sind.
export const GRUENDE = [
  {
    wert: 'kein-thema', text: 'Kein Thema erkannt',
    hilfe: 'Die KI hat keinen Ordner genannt — meist persönliche Post oder Einzelstücke',
  },
  {
    wert: 'neuer-ordner', text: 'Neuer Ordner vorgeschlagen',
    hilfe: 'Die KI wollte einen neuen Ordner — er wartet auf Freigabe (Reiter „Ordner") oder es läuft der Trockenlauf',
  },
  {
    wert: 'abgelehnt', text: 'Ordnername abgelehnt',
    hilfe: 'Der vorgeschlagene Name war ungültig oder der Ordner wurde schon einmal abgelehnt',
  },
  {
    wert: 'unsicher', text: 'Zu unsicher',
    hilfe: 'Für einen neuen Ordner lag die Sicherheit der KI unter der eingestellten Schwelle',
  },
  {
    wert: 'andere', text: 'Anderer Grund',
    hilfe: 'Zum Beispiel Obergrenze der KI-Ordner erreicht, neue Ordner abgeschaltet oder Ordner fehlt im Postfach',
  },
  { wert: 'ohne', text: 'ohne Angabe', hilfe: 'Kein Grund vermerkt (ältere Einträge)' },
];

export function kategorieVon(mail) {
  const k = String(mail?.kategorie || '').trim().toLowerCase();
  return KATEGORIEN.some((x) => x.wert === k) ? k : 'unbekannt';
}

export function grundKlasse(kiGrund) {
  const g = String(kiGrund || '').trim();
  if (!g) return 'ohne';
  if (/^Kein Thema erkannt/i.test(g)) return 'kein-thema';
  if (/wartet auf Freigabe|^Trockenlauf/i.test(g)) return 'neuer-ordner';
  if (/^Ordnername abgelehnt|wurde abgelehnt/i.test(g)) return 'abgelehnt';
  if (/zu unsicher/i.test(g)) return 'unsicher';
  return 'andere';
}

// Der Filter steht in der Adresse (?filter=k:persoenlich,g:kein-thema), damit
// er ein Neuladen übersteht und sich verlinken lässt. Je Dimension höchstens
// ein Wert — zwei Kategorien gleichzeitig wären eine Oder-Verknüpfung, und
// die macht die Zahlen an den Chips unverständlich.
export function filterLesen(text) {
  const f = { kategorie: null, grund: null };
  for (const teil of String(text || '').split(',')) {
    const [art, wert] = teil.split(':');
    if (art === 'k' && KATEGORIEN.some((x) => x.wert === wert)) f.kategorie = wert;
    if (art === 'g' && GRUENDE.some((x) => x.wert === wert)) f.grund = wert;
  }
  return f;
}

export function filterText(f) {
  return [f.kategorie && `k:${f.kategorie}`, f.grund && `g:${f.grund}`].filter(Boolean).join(',');
}

export function passtZumFilter(mail, f) {
  if (f.kategorie && kategorieVon(mail) !== f.kategorie) return false;
  if (f.grund && grundKlasse(mail.ki_grund) !== f.grund) return false;
  return true;
}

// Die Zahlen an den Chips. Jede Dimension zählt unter dem Filter der jeweils
// ANDEREN: Wer „Kein Thema erkannt" gewählt hat, sieht an den Kategorien, wie
// sich genau diese Mails verteilen — und die Kategorie-Zahlen ergeben
// zusammen weiterhin die angezeigte Menge.
export function aufschluesseln(mails, f) {
  const kategorien = {};
  const gruende = {};
  for (const m of mails) {
    const k = kategorieVon(m);
    const g = grundKlasse(m.ki_grund);
    if (!f.grund || g === f.grund) kategorien[k] = (kategorien[k] || 0) + 1;
    if (!f.kategorie || k === f.kategorie) gruende[g] = (gruende[g] || 0) + 1;
  }
  return { kategorien, gruende };
}
