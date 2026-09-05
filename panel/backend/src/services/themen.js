// Automatische Themen-Sortierung: Die KI schlaegt einen Ordner vor, dieses Modul
// entscheidet endgueltig.
//
// Grundsatz: Der Vorschlag kommt von einem Modell, das angreiferkontrollierten
// Mailtext liest. Er ist deshalb ein Wunsch und keine Anweisung — jeder neue Name
// laeuft durch ordnerNormalisieren(), bevor er ein IMAP-Postfach zu sehen bekommt.
// Es wird nie geloescht und nie umbenannt, nur angelegt und verschoben.
const db = require('../db');
const imap = require('./imap');
const sortierung = require('./sortierung');
const { entschluesseln } = require('./crypto');
const { loggen } = require('./panelLog');

// ─── Einstellungen ───────────────────────────────────────────────────────────

const wert = (key, standard) => {
  const zeile = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return zeile ? zeile.value : standard;
};

const ANLEGEN_MODI = ['aus', 'freigabe', 'auto'];

function einstellungen() {
  const modus = wert('themen_ordner_anlegen', 'freigabe');
  return {
    aktiv: wert('themen_sortierung_aktiv', '0') === '1',
    anlegen: ANLEGEN_MODI.includes(modus) ? modus : 'freigabe',
    max: Math.max(0, Number(wert('themen_ordner_max', '25')) || 0),
    konfidenz: Math.min(1, Math.max(0, Number(wert('themen_konfidenz', '0.7')) || 0)),
    eltern: String(wert('themen_eltern', '') || '').trim(),
    regelLernen: wert('themen_regel_lernen', '1') === '1',
    trockenlauf: wert('trockenlauf_aktiv', '0') === '1',
  };
}

// ─── Ordnernamen pruefen ─────────────────────────────────────────────────────

// Ordner, in die nie automatisch einsortiert werden darf. Die Kategorieordner
// des Kontos kommen in reserviert() dazu.
const SYSTEMORDNER = [
  'inbox', 'posteingang', 'sent', 'gesendet', 'gesendete objekte', 'sent items',
  'drafts', 'entwuerfe', 'entwürfe', 'trash', 'papierkorb', 'geloeschte objekte',
  'gelöschte objekte', 'deleted items', 'junk', 'junk-e-mail', 'spam', 'outbox',
  'postausgang', 'templates', 'vorlagen', 'notes', 'notizen',
];

/**
 * Die fuenf Kategorie-Ordner dieses Kontos — eingetragen oder Standard.
 *
 * Die KI muss sie kennen: Ohne diese Liste schlaegt sie bei Werbemails brav
 * "Newsletter" als Thema vor, was hier als reservierter Name abgewiesen wird.
 * Der Themen-Vorschlag ist damit verpufft und die Mail bleibt liegen.
 */
function kategorieOrdner(konto = {}) {
  return Object.entries(imap.STANDARD).map(([feld, standard]) => konto[feld] || standard);
}

function reserviert(konto = {}) {
  const namen = new Set(SYSTEMORDNER);
  for (const [feld, standard] of Object.entries(imap.STANDARD)) {
    namen.add(String(standard).toLowerCase().trim());
    if (konto[feld]) namen.add(String(konto[feld]).toLowerCase().trim());
  }
  return namen;
}

/**
 * Prueft einen von der KI vorgeschlagenen NEUEN Ordnernamen.
 * Bereits im Katalog stehende Ordner laufen hier nicht durch — deren Pfad kommt
 * unveraendert aus der Datenbank und darf deshalb auch Trennzeichen enthalten.
 * @returns {string|null} sauberer Name oder null, wenn er nicht zulaessig ist
 */
function ordnerNormalisieren(roh, konto = {}) {
  let name = String(roh ?? '').trim();
  if (!name) return null;

  // Steuerzeichen fliegen raus, BEVOR Leerraum zusammengefasst wird.
  //
  // Sonst wird aus "Ordner\r\nA001 DELETE INBOX" durch das Glaetten unten ein
  // "Ordner A001 DELETE INBOX" — ein Name, der jede weitere Pruefung besteht,
  // obwohl er eingeschleusten Text enthielt. Dass imapflow Ordnernamen ohnehin
  // quotiert, macht das nicht harmlos: Eine Abwehr darf sich nicht darauf
  // verlassen, dass die naechste Schicht sauber arbeitet.
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;

  // "NEU:Games" ist die vereinbarte Form fuer einen Vorschlag
  name = name.replace(/^NEU\s*:\s*/i, '').trim();
  // Anfuehrungszeichen, die das Modell gern mitliefert
  name = name.replace(/^["'`]+|["'`]+$/g, '').trim();
  name = name.replace(/\s+/g, ' ');

  if (name.length < 2 || name.length > 40) return null;
  // Ein fuehrendes = macht in n8n einen Ausdruck aus dem Wert, {{ }} und ${ }
  // ebenso — dieselbe Angriffsklasse, die ordnerName() im Patcher abfaengt.
  if (name.startsWith('=') || name.includes('{{') || name.includes('${')) return null;
  // Pfadtrenner wuerden einen Unterordner an fremder Stelle erzeugen
  if (/[/\\.]/.test(name)) return null;
  // Buchstaben (inkl. Umlaute), Ziffern, Leerzeichen und ein paar gaengige
  // Zeichen aus echten Ordnernamen: - _ & + ( ). Kein Pfadtrenner, kein "." und
  // (durch die Pruefung oben) kein n8n-Ausdruck. & und + sind mit imapflow sicher,
  // das den Namen selbst nach modified-UTF-7 kodiert.
  if (!/^[\p{L}\p{N} _&+()-]+$/u.test(name)) return null;
  if (reserviert(konto).has(name.toLowerCase())) return null;

  return name;
}

// ─── Zwei Namen, eine Sache ──────────────────────────────────────────────────
//
// Die KI erfindet für dasselbe Thema gern zwei Namen: „Games" und „Gaming",
// „Rechnung" und „Rechnungen", „News" und „Nachrichten". Jeder davon wurde
// bisher ein eigener Vorschlag und am Ende ein eigener Ordner — im Panel
// standen 34 Vorschläge, von denen etliche dasselbe meinten.
//
// Zwei Stufen, beide absichtlich schlicht gehalten:
//   1. Wortstamm — klein schreiben, Umlaute auflösen, gängige Endungen
//      abschneiden. „games" und „gaming" werden beide zu „gam".
//   2. Eine kurze Liste echter Synonyme, vor allem deutsch/englisch.
//
// Beides greift ausschließlich, um einen VORHANDENEN Ordner oder Vorschlag zu
// treffen. Erfunden wird nie etwas, und der Name, den der Nutzer sieht, bleibt
// der, den er selbst freigegeben hat.
const ENDUNGEN = ['ungen', 'ingen', 'ung', 'ing', 'nen', 'en', 'es', 'er', 'n', 's', 'e'];

function schlicht(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[/.]/).pop() // "Themen/Games" → "games"
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

// Höchstens zwei Endungen: "newsletters" → "newsletter" → "newslett", damit es
// die Einzahl trifft. Der Rest muss mindestens drei Zeichen behalten, sonst
// bliebe von kurzen Namen nichts übrig, was noch etwas unterscheidet.
function stamm(name) {
  let s = schlicht(name);
  for (let runde = 0; runde < 2; runde += 1) {
    for (const endung of ENDUNGEN) {
      if (s.length - endung.length >= 3 && s.endsWith(endung)) {
        s = s.slice(0, -endung.length);
        break;
      }
    }
  }
  return s;
}

// Bewusst kurz. Jede Zeile hier ist eine Behauptung darüber, was dasselbe ist —
// bei Zweifeln lieber weglassen und zwei Ordner in Kauf nehmen.
const SYNONYME = [
  ['games', 'gaming', 'spiele', 'videospiele', 'gamer'],
  ['news', 'nachrichten', 'neuigkeiten'],
  ['shopping', 'einkauf', 'einkaufen'],
  ['reisen', 'travel', 'urlaub'],
  ['gesundheit', 'health'],
  ['finanzen', 'finance'],
  ['arbeit', 'work', 'job'],
  ['schule', 'school'],
  ['musik', 'music'],
  ['fotos', 'bilder', 'photos'],
  ['streaming', 'stream'],
  ['software', 'apps'],
  ['lernen', 'learning'],
];

const SYNONYM_GRUPPE = new Map();
SYNONYME.forEach((gruppe, nummer) => gruppe.forEach((wort) => SYNONYM_GRUPPE.set(stamm(wort), nummer)));

function aehnlich(a, b) {
  const sa = stamm(a);
  const sb = stamm(b);
  if (!sa || !sb || sa.length < 3 || sb.length < 3) return false;
  if (sa === sb) return true;
  const ga = SYNONYM_GRUPPE.get(sa);
  return ga !== undefined && ga === SYNONYM_GRUPPE.get(sb);
}

// ─── Katalog ─────────────────────────────────────────────────────────────────

function katalog(kontoId, { auchGesperrte = false } = {}) {
  const sql = auchGesperrte
    ? 'SELECT * FROM konto_ordner WHERE konto_id = ? ORDER BY treffer DESC, ordner'
    : 'SELECT * FROM konto_ordner WHERE konto_id = ? AND gesperrt = 0 ORDER BY treffer DESC, ordner';
  return db.prepare(sql).all(kontoId);
}

// Was der Prompt sehen soll: Name und Beschreibung, auf eine handliche Zahl
// gekappt — sonst blaeht ein grosses Postfach jeden Gemini-Aufruf auf.
const MAX_IM_PROMPT = 40;

// Höchstens so viele wartende Vorschläge wandern zusätzlich in den Prompt.
const MAX_VORSCHLAEGE_IM_PROMPT = 15;

function fuerPrompt(kontoId) {
  const liste = katalog(kontoId).slice(0, MAX_IM_PROMPT).map((o) => ({
    name: o.ordner,
    beschreibung: o.beschreibung || '',
  }));

  // Auch die Vorschläge, die noch auf Freigabe warten. Ohne sie kennt das Modell
  // den Namen nicht, den es vorgestern selbst vorgeschlagen hat — und erfindet
  // beim nächsten Mal einen zweiten dafür. Genau so entstanden „Games" (8×) und
  // „Gaming" (6×) nebeneinander.
  let offen = [];
  try {
    offen = db.prepare(
      "SELECT ordner FROM ordner_vorschlaege WHERE konto_id = ? AND status = 'offen'"
      + ' ORDER BY anzahl DESC, ordner',
    ).all(kontoId);
  } catch { offen = []; }

  for (const v of offen.slice(0, MAX_VORSCHLAEGE_IM_PROMPT)) {
    if (liste.some((o) => aehnlich(o.name, v.ordner))) continue;
    liste.push({ name: v.ordner, beschreibung: 'vorgeschlagen, noch nicht angelegt' });
  }
  return liste;
}

// ─── Umgeleitete Namen ───────────────────────────────────────────────────────
//
// „Das gehört nicht in einen neuen Ordner, das gehört nach X." Die Entscheidung
// trifft der Nutzer an einem Vorschlag; hier wird sie festgehalten, damit sie
// beim nächsten Mal von selbst greift.

function aliasListe(kontoId) {
  try {
    return db.prepare('SELECT * FROM ordner_alias WHERE konto_id = ? ORDER BY alias').all(kontoId);
  } catch { return []; }
}

function aliasMerken(kontoId, alias, ordner) {
  const name = String(alias || '').trim();
  const ziel = String(ordner || '').trim();
  if (!kontoId || !name || !ziel) return false;
  db.prepare(`
    INSERT INTO ordner_alias (konto_id, alias, ordner) VALUES (?, ?, ?)
    ON CONFLICT(konto_id, alias) DO UPDATE SET ordner = excluded.ordner
  `).run(kontoId, name, ziel);
  return true;
}

function aliasVergessen(id) {
  return db.prepare('DELETE FROM ordner_alias WHERE id = ?').run(Number(id)).changes > 0;
}

// Findet einen Katalogeintrag zum Vorschlag der KI. Sie antwortet mal mit dem
// vollen Pfad ("Themen/Games"), mal nur mit dem letzten Stueck ("Games").
function imKatalog(kontoId, vorschlag) {
  const gesucht = String(vorschlag || '').replace(/^NEU\s*:\s*/i, '').trim().toLowerCase();
  if (!gesucht) return null;
  const liste = katalog(kontoId);
  for (const eintrag of liste) {
    const pfad = String(eintrag.ordner).toLowerCase();
    const letztes = pfad.split(/[/.]/).pop();
    if (pfad === gesucht || letztes === gesucht) return eintrag;
  }

  // Hat der Nutzer diesen Namen einmal umgeleitet, gilt seine Entscheidung —
  // und zwar vor jeder Ähnlichkeitsrechnerei.
  const umgeleitet = aliasListe(kontoId)
    .find((a) => schlicht(a.alias) === schlicht(gesucht) || aehnlich(a.alias, gesucht));
  if (umgeleitet) {
    const ziel = liste.find((e) => String(e.ordner).toLowerCase() === String(umgeleitet.ordner).toLowerCase());
    if (ziel) return ziel;
  }

  // Zweiter Anlauf über den Wortstamm: „Gaming" trifft damit den vorhandenen
  // Ordner „Games", statt einen zweiten danebenzustellen.
  return liste.find((eintrag) => aehnlich(eintrag.ordner, gesucht)) || null;
}

// ─── Ordner aus dem Postfach uebernehmen ─────────────────────────────────────

// Ein Konto samt entschluesseltem Passwort, wie imap.js es erwartet
function zugang(konto) {
  return {
    host: konto.host,
    port: konto.port,
    username: konto.username,
    passwort: entschluesseln(konto.password_enc),
    tlsUnsicher: Boolean(konto.tls_unsicher),
  };
}

/**
 * Liest die vorhandenen Ordner des Postfachs ein und nimmt alles in den Katalog
 * auf, was kein System- und kein Kategorieordner ist. So sortiert die KI in die
 * Struktur ein, die der Nutzer laengst hat, statt eine zweite danebenzubauen.
 */
async function ausPostfachEinlesen(konto) {
  const ordner = await imap.ordnerDetails({ ...konto, ...zugang(konto) });
  const gesperrteNamen = reserviert(konto);
  const vorhanden = new Set(katalog(konto.id, { auchGesperrte: true }).map((o) => o.ordner));

  const einfuegen = db.prepare(
    "INSERT OR IGNORE INTO konto_ordner (konto_id, ordner, quelle) VALUES (?, ?, 'imap')",
  );
  const neu = [];
  const uebersprungen = [];
  for (const o of ordner) {
    if (vorhanden.has(o.pfad)) continue;

    // Der Server sagt selbst, was Papierkorb, Entwuerfe, "Alle Nachrichten"
    // oder ein blosser Zwischenknoten ist. Darauf zu hoeren ist zuverlaessiger
    // als Namen zu raten: Gmail nennt seine Ansichten je nach Kontosprache
    // anders ("[Gmail]/Alle Nachrichten", "[Gmail]/All Mail", ...), und
    // hineinschieben laesst sich dort ohnehin nichts Sinnvolles.
    if (o.spezial) { uebersprungen.push(`${o.pfad} (${o.spezial})`); continue; }
    if (!o.auswaehlbar) { uebersprungen.push(`${o.pfad} (kein Zielordner)`); continue; }

    const letztes = String(o.pfad).split(/[/.]/).pop();
    if (gesperrteNamen.has(String(o.pfad).toLowerCase())) continue;
    if (gesperrteNamen.has(letztes.toLowerCase())) continue;

    einfuegen.run(konto.id, o.pfad);
    neu.push(o.pfad);
  }
  if (uebersprungen.length) {
    loggen('info', 'themen',
      `${konto.name}: ${uebersprungen.length} Systemordner nicht in den Katalog übernommen — ${uebersprungen.join(', ')}`);
  }
  return {
    ok: true,
    neu,
    uebersprungen,
    gesamt: katalog(konto.id, { auchGesperrte: true }).length,
  };
}

/**
 * Nimmt Systemordner, die frueher versehentlich in den Katalog geraten sind,
 * wieder heraus. Sie werden nicht geloescht, sondern gesperrt — sichtbar bleibt
 * damit, dass es sie gibt, befuellt werden sie nie.
 * @returns {Promise<string[]>} die gesperrten Pfade
 */
async function systemordnerSperren(konto) {
  const ordner = await imap.ordnerDetails({ ...konto, ...zugang(konto) });
  const heikel = new Set(
    ordner.filter((o) => o.spezial || !o.auswaehlbar).map((o) => o.pfad),
  );
  const sperren = db.prepare('UPDATE konto_ordner SET gesperrt = 1 WHERE id = ?');
  const gesperrt = [];
  for (const eintrag of katalog(konto.id, { auchGesperrte: true })) {
    if (eintrag.gesperrt || !heikel.has(eintrag.ordner)) continue;
    sperren.run(eintrag.id);
    gesperrt.push(eintrag.ordner);
  }
  if (gesperrt.length) {
    loggen('info', 'themen', `${konto.name}: ${gesperrt.length} Systemordner im Katalog gesperrt — ${gesperrt.join(', ')}`);
  }
  return gesperrt;
}

// ─── Regeln lernen ───────────────────────────────────────────────────────────

// Ab wie vielen gleichen Treffern eine feste Regel entsteht. Danach laeuft der
// Absender ohne KI durch — das schont das Gemini-Kontingent und macht die
// Sortierung mit der Zeit vorhersagbar.
const LERNSCHWELLE = 3;
// Ab wie vielen VERSCHIEDENEN Absendern derselben Domain eine Domain-Regel
// entsteht statt weiterer Einzelregeln.
const DOMAIN_SCHWELLE = 2;

/**
 * Merkt sich, wohin Mails eines Absenders gehen.
 *
 * Bevorzugt wird die Domain-Regel: Viele Dienste verschicken aus einer ganzen
 * Reihe von Adressen derselben Domain (googleplay-noreply@, googleone-noreply@,
 * google-noreply@ …) oder gleich aus Wegwerf-Adressen mit Hash im Namen. Eine
 * Absender-Regel greift dort kein zweites Mal — sie erzeugt nur Regel-Müll.
 * Deshalb: Sobald zwei verschiedene Absender derselben Domain im selben Ordner
 * gelandet sind, entsteht eine Regel für die Domain.
 */
function regelLernen(kontoId, von, ordner) {
  const adresse = sortierung.adresse(von);
  const domain = sortierung.domain(von);
  if (!adresse.includes('@') || !domain) return false;

  const konto = db.prepare('SELECT name FROM accounts WHERE id = ?').get(kontoId);
  if (!konto) return false;

  const schonDa = (typ, muster) => db.prepare(
    'SELECT id FROM sort_rules WHERE konto_id = ? AND typ = ? AND muster = ?',
  ).get(kontoId, typ, muster);

  if (schonDa('domain', domain) || schonDa('absender', adresse)) return false;

  // Wer ist aus dieser Domain schon in diesem Ordner gelandet? Gezaehlt wird im
  // Triage-Log — eine eigene Tabelle braucht es dafuer nicht.
  const zeilen = db.prepare(`
    SELECT von FROM quarantine_log
    WHERE konto = ? AND zielordner = ? AND created_at >= datetime('now', '-90 day')
  `).all(konto.name, ordner);

  const ausDomain = zeilen.filter((z) => sortierung.domain(z.von) === domain);
  const absender = new Set(ausDomain.map((z) => sortierung.adresse(z.von)));

  let typ = null;
  if (absender.size >= DOMAIN_SCHWELLE) typ = 'domain';
  else if (ausDomain.length >= LERNSCHWELLE) typ = 'absender';
  if (!typ) return false;

  const muster = typ === 'domain' ? domain : adresse;
  db.prepare(
    'INSERT INTO sort_rules (konto_id, typ, muster, zielordner) VALUES (?, ?, ?, ?)',
  ).run(kontoId, typ, muster, ordner);
  loggen('info', 'themen',
    `Regel gelernt [${typ}]: ${muster} → ${ordner} (Konto ${konto.name}, ${absender.size} Absender / ${ausDomain.length} Mails)`);
  return { typ, muster, zielordner: ordner };
}

// ─── Existiert der Zielordner ueberhaupt? ────────────────────────────────────
//
// Fehlt er, bricht der Verschiebe-Knoten den ganzen n8n-Lauf ab
// ("9 NO [TRYCREATE] No folder Newsletter") und die Mail bleibt unbearbeitet
// liegen — ohne dass im Panel etwas davon zu sehen waere. Lieber vorher hier
// merken und die Mail mit klarer Begruendung in der Sortier-Inbox zeigen.
//
// Die Ordnerliste je Konto wird kurz zwischengespeichert: Ohne das kaeme auf
// jede einzelne Mail eine eigene IMAP-Verbindung.
const ORDNER_CACHE_MS = 60000;
const ordnerCache = new Map();

async function ordnerListe(konto) {
  const eintrag = ordnerCache.get(konto.id);
  if (eintrag && Date.now() - eintrag.zeit < ORDNER_CACHE_MS) return eintrag.ordner;
  const ergebnis = await imap.testVerbindung({ ...konto, ...zugang(konto) });
  const ordner = ergebnis.ordner || [];
  ordnerCache.set(konto.id, { zeit: Date.now(), ordner });
  return ordner;
}

/** Nach dem Anlegen eines Ordners ist die Liste veraltet. */
function cacheVerwerfen(kontoId) {
  ordnerCache.delete(kontoId);
}

/**
 * @returns {Promise<boolean>} true, wenn der Ordner im Postfach existiert.
 * Laesst sich das Postfach nicht erreichen, wird true angenommen — eine
 * gescheiterte Pruefung darf die Sortierung nicht blockieren.
 */
async function ordnerExistiert(konto, pfad) {
  if (!pfad) return false;
  try {
    return (await ordnerListe(konto)).includes(pfad);
  } catch (err) {
    loggen('warn', 'themen', `Ordnerliste für ${konto.name} nicht abrufbar: ${err.message}`);
    return true;
  }
}

// ─── Bausteine, die auch die Panel-Routen brauchen ───────────────────────────

// Legt den Ordner unter dem eingestellten Sammelordner an und gibt den Pfad
// zurueck, den der Server tatsaechlich vergeben hat. Das Trennzeichen zwischen
// Eltern- und Unterordner kennt nur der Server — deshalb wird der Pfad als Array
// uebergeben und imapflow setzt es selbst ein.
async function ordnerAnlegen(konto, name) {
  const e = einstellungen();
  const pfad = e.eltern ? [e.eltern, name] : name;
  const angelegt = await imap.ordnerAnlegenPfad(zugang(konto), pfad);
  cacheVerwerfen(konto.id);
  return angelegt;
}

function inKatalog(kontoId, pfad, quelle, beschreibung = null) {
  db.prepare(`
    INSERT INTO konto_ordner (konto_id, ordner, beschreibung, quelle)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(konto_id, ordner) DO UPDATE SET
      beschreibung = COALESCE(excluded.beschreibung, beschreibung)
  `).run(kontoId, pfad, beschreibung, quelle);
  return db.prepare('SELECT * FROM konto_ordner WHERE konto_id = ? AND ordner = ?')
    .get(kontoId, pfad);
}

// Legt einen Vorschlag an oder zählt den passenden hoch.
// @returns {{ordner: string, status: string}} unter welchem Namen gezählt wurde
function vorschlagMerken(kontoId, name, begruendung) {
  // Gibt es schon einen Vorschlag, der dasselbe meint? Dann den hochzählen —
  // sonst stehen „Games" und „Gaming" als zwei Zeilen nebeneinander. Bereits
  // freigegebene bleiben außen vor: Deren Ordner gibt es, der gehört in den
  // Katalog und wird oben gefunden.
  const schon = db.prepare(
    "SELECT * FROM ordner_vorschlaege WHERE konto_id = ? AND status != 'freigegeben'",
  ).all(kontoId).find((v) => aehnlich(v.ordner, name));

  if (schon) {
    // Abgelehnt bleibt abgelehnt — auch unter anderem Namen. Sonst käme
    // dieselbe Idee als „Gaming" zurück, nachdem „Games" abgelehnt wurde.
    if (schon.status === 'abgelehnt') return { ordner: schon.ordner, status: 'abgelehnt' };
    db.prepare(
      'UPDATE ordner_vorschlaege SET anzahl = anzahl + 1, begruendung = ? WHERE id = ?',
    ).run(begruendung, schon.id);
    return { ordner: schon.ordner, status: 'offen' };
  }

  db.prepare(`
    INSERT INTO ordner_vorschlaege (konto_id, ordner, begruendung)
    VALUES (?, ?, ?)
    ON CONFLICT(konto_id, ordner) DO UPDATE SET
      anzahl = anzahl + 1,
      begruendung = excluded.begruendung,
      status = CASE WHEN status = 'abgelehnt' THEN 'abgelehnt' ELSE 'offen' END
  `).run(kontoId, name, begruendung);
  return { ordner: name, status: 'offen' };
}

// Räumt auf, was sich vor dieser Änderung angesammelt hat: Vorschläge, die
// dasselbe meinen, werden zu einem. Es gewinnt der mit den meisten Nennungen,
// bei Gleichstand der kürzere Name.
//
// Läuft beim Öffnen der Vorschlagsliste. Die wartenden Mails werden mitgezogen
// (sort_inbox.ki_ordner), sonst fände die Freigabe sie später nicht mehr — sie
// sucht die Mails über genau diesen Namen.
function vorschlaegeAufraeumen(kontoId = null) {
  const wo = kontoId ? 'WHERE konto_id = ?' : '';
  const alle = db.prepare(
    `SELECT * FROM ordner_vorschlaege ${wo} ORDER BY anzahl DESC, LENGTH(ordner), ordner`,
  ).all(...(kontoId ? [kontoId] : []));

  const behalten = [];
  let zusammengefuehrt = 0;
  for (const v of alle) {
    // Nur innerhalb desselben Status zusammenführen: Ein abgelehnter Vorschlag
    // darf keinen offenen verschlucken und umgekehrt.
    const sieger = behalten.find((b) => b.konto_id === v.konto_id
      && b.status === v.status && aehnlich(b.ordner, v.ordner));
    if (!sieger) { behalten.push({ ...v }); continue; }

    db.prepare('UPDATE ordner_vorschlaege SET anzahl = anzahl + ? WHERE id = ?').run(v.anzahl, sieger.id);
    db.prepare('UPDATE sort_inbox SET ki_ordner = ? WHERE konto_id = ? AND ki_ordner = ?')
      .run(sieger.ordner, v.konto_id, v.ordner);
    db.prepare('DELETE FROM ordner_vorschlaege WHERE id = ?').run(v.id);
    sieger.anzahl += v.anzahl;
    zusammengefuehrt += 1;
  }
  return zusammengefuehrt;
}

// ─── Die eigentliche Entscheidung ────────────────────────────────────────────

/**
 * @param {object} konto      Zeile aus accounts (mit password_enc)
 * @param {string} vorschlag  was die KI geliefert hat ("Games" oder "NEU:Games")
 * @param {number} konfidenz  0..1
 * @returns {Promise<{ordner: string|null, neu_angelegt: boolean, grund: string}>}
 */
async function aufloesen({ konto, vorschlag, konfidenz, von }) {
  const e = einstellungen();
  if (!e.aktiv) return { ordner: null, neu_angelegt: false, grund: 'Themen-Sortierung ist aus' };
  if (!vorschlag) return { ordner: null, neu_angelegt: false, grund: 'Kein Thema erkannt' };

  const sicherheit = Number(konfidenz) || 0;
  if (sicherheit < e.konfidenz) {
    return {
      ordner: null,
      neu_angelegt: false,
      grund: `Zu unsicher (${sicherheit.toFixed(2)} < ${e.konfidenz})`,
    };
  }

  // 1. Kennen wir den Ordner schon? Dann ist nichts weiter zu tun.
  const bekannt = imKatalog(konto.id, vorschlag);
  if (bekannt) {
    db.prepare(
      'UPDATE konto_ordner SET treffer = treffer + 1, zuletzt_genutzt = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(bekannt.id);
    // regelLernen laeuft erst nach dem Protokollieren in /einsortieren — sonst
    // wuerde die laufende Mail sich bei der Zaehlung selbst uebersehen.
    return { ordner: bekannt.ordner, neu_angelegt: false, grund: 'Vorhandener Themen-Ordner' };
  }

  // 2. Ein neuer Ordner — ab hier wird streng geprueft.
  if (e.anlegen === 'aus') {
    return { ordner: null, neu_angelegt: false, grund: 'Neue Ordner sind abgeschaltet' };
  }
  const name = ordnerNormalisieren(vorschlag, konto);
  if (!name) {
    return {
      ordner: null,
      neu_angelegt: false,
      grund: `Ordnername abgelehnt: ${String(vorschlag).slice(0, 40)}`,
    };
  }

  const deckel = db.prepare(
    "SELECT COUNT(*) AS anzahl FROM konto_ordner WHERE konto_id = ? AND quelle = 'ki'",
  ).get(konto.id);
  if (deckel.anzahl >= e.max) {
    return { ordner: null, neu_angelegt: false, grund: `Obergrenze von ${e.max} KI-Ordnern erreicht` };
  }

  // Im Trockenlauf wird nichts angelegt — nur festgehalten, was passiert waere.
  if (e.trockenlauf || e.anlegen === 'freigabe') {
    const gemerkt = vorschlagMerken(konto.id, name, `Zuletzt vorgeschlagen für: ${String(von || '').slice(0, 120)}`);
    const zusammen = gemerkt.ordner === name ? '' : ` (zusammengefasst mit "${gemerkt.ordner}")`;
    if (gemerkt.status === 'abgelehnt') {
      return {
        ordner: null,
        neu_angelegt: false,
        grund: `Ordner "${gemerkt.ordner}" wurde abgelehnt — die Mail bleibt liegen`,
      };
    }
    return {
      ordner: null,
      neu_angelegt: false,
      grund: e.trockenlauf
        ? `Trockenlauf — Ordner "${gemerkt.ordner}" wäre angelegt worden`
        : `Neuer Ordner "${gemerkt.ordner}" wartet auf Freigabe${zusammen}`,
    };
  }

  // 3. Vollautomatik: anlegen und einsortieren
  try {
    const pfad = await ordnerAnlegen(konto, name);
    inKatalog(konto.id, pfad, 'ki');
    loggen('info', 'themen', `Neuer Themen-Ordner "${pfad}" für Konto ${konto.name} angelegt (KI).`);
    return { ordner: pfad, neu_angelegt: true, grund: 'Neuer Themen-Ordner angelegt' };
  } catch (err) {
    loggen('warn', 'themen', `Ordner "${name}" konnte nicht angelegt werden: ${err.message}`);
    return { ordner: null, neu_angelegt: false, grund: `Anlegen fehlgeschlagen: ${err.message}` };
  }
}

module.exports = {
  einstellungen,
  ordnerNormalisieren,
  reserviert,
  kategorieOrdner,
  katalog,
  fuerPrompt,
  imKatalog,
  ausPostfachEinlesen,
  systemordnerSperren,
  regelLernen,
  aufloesen,
  ordnerExistiert,
  cacheVerwerfen,
  ordnerAnlegen,
  inKatalog,
  vorschlagMerken,
  vorschlaegeAufraeumen,
  aliasListe,
  aliasMerken,
  aliasVergessen,
  aehnlich,
  stamm,
  zugang,
  ANLEGEN_MODI,
};
