// Hilfen rund um die Sortier-Inbox, die mehr als eine Ansicht braucht.
//
// Ausgangspunkt war der Diagnosebericht vom 17.09.: 1.750 offene Zuordnungen,
// und nirgends war zu sehen, woraus dieser Stapel besteht. Erst die
// Aufschlüsselung nach Kategorie und Grund zeigt, ob da 600 persönliche Mails
// ohne Thema liegen oder 300 Vorschläge für einen neuen Ordner, der nur noch
// freigegeben werden müsste — und das sind zwei völlig verschiedene Aufgaben.

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
