// Zwei-Faktor-Anmeldung: Methoden, Tickets, Einmalcodes.
//
// Drei Methoden, beliebig kombinierbar, beim Login wählbar:
//   totp     Authenticator-App (Code aus Geheimnis + Uhrzeit, services/totp.js)
//   email    sechsstelliger Code per Mail über den Postausgang des Panels
//   discord  sechsstelliger Code als Direktnachricht über einen Discord-Bot
//
// Der Ablauf, der manipulationssicher sein muss:
//   1. Nach dem richtigen Passwort gibt es KEIN Sitzungs-Token, sondern ein Ticket
//      (5 Minuten, anderer Schlüssel und andere Zielgruppe, services/tokens.js).
//   2. Das Ticket taugt nur für die Code-Eingabe. Es hat einen Datensatz, der
//      Fehlversuche und Sendungen zählt und sich nur einmal einlösen lässt.
//   3. Erst ein richtiger Code löst das Ticket ein — dann gibt es die Sitzung.
//
// Codes liegen nie im Klartext in der Datenbank, nur als HMAC. Ein Code gilt einmal.
const crypto   = require('crypto');
const db       = require('../db');
const settings = require('./settings');
const smtp     = require('./smtp');
const discord  = require('./discord');
const totp     = require('./totp');
const tokens   = require('./tokens');
const { verschluesseln, entschluesseln } = require('./crypto');

const METHODEN = ['totp', 'email', 'discord'];
const BEZEICHNUNG = { totp: 'Authenticator-App', email: 'E-Mail', discord: 'Discord' };

/** Wie lange ein Code per Mail/Discord gilt. Das Ticket (5 Min.) begrenzt den Login ohnehin. */
const CODE_SEKUNDEN = 10 * 60;
/** Fehlversuche, nach denen ein Ticket oder ein Code verbrannt ist. */
const MAX_FEHLVERSUCHE = 5;
/** Wie oft ein Ticket einen Code anfordern darf. */
const MAX_SENDUNGEN = 3;
/** Fehlversuche je Benutzer in 15 Minuten, nach denen niemand mehr einen Code versuchen darf — von welcher Adresse auch immer. */
const MAX_FEHLER_JE_NUTZER = 10;
/** Wie oft jemand für sich selbst Einrichtungs-Codes anfordern darf (verhindert Mail-Bomben an fremde Adressen). */
const MAX_EINRICHTUNGS_SENDUNGEN = 5;

const jetztSek = () => Math.floor(Date.now() / 1000);

// ─── Hash der Codes ──────────────────────────────────────────────────────────
//
// Sechs Ziffern sind nur eine Million Möglichkeiten — ein einfacher Hash wäre mit
// der Datenbank allein in einer Sekunde umgekehrt. Deshalb ein HMAC mit einem
// Schlüssel, der nicht in der Datenbank steht (aus JWT_SECRET abgeleitet), und mit
// Benutzer, Ticket und Methode im Kontext: Ein Hash gilt nur für genau diesen Fall.
const hashSchluessel = () => crypto
  .createHmac('sha256', String(process.env.JWT_SECRET || ''))
  .update('mail-panel/2fa-code/v1')
  .digest();

function codeHash(userId, kontext, methode, code) {
  return crypto.createHmac('sha256', hashSchluessel())
    .update(`${userId}|${kontext}|${methode}|${code}`)
    .digest('hex');
}

const hashGleich = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const neuerCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ─── Lesen ───────────────────────────────────────────────────────────────────

const zeile = (userId, methode) =>
  db.prepare('SELECT * FROM user_2fa WHERE user_id = ? AND methode = ?').get(userId, methode);

/** Die Methoden, mit denen sich jemand gerade anmelden kann (bestätigt und eingeschaltet). */
const aktiveMethoden = (userId) => db
  .prepare('SELECT methode FROM user_2fa WHERE user_id = ? AND aktiv = 1')
  .all(userId).map((r) => r.methode)
  .sort((a, b) => METHODEN.indexOf(a) - METHODEN.indexOf(b));

const hatZweifaktor = (userId) => aktiveMethoden(userId).length > 0;

/** Die vorgewählte Methode — die gespeicherte, solange sie noch aktiv ist, sonst die erste aktive. */
function bevorzugte(userId) {
  const aktiv = aktiveMethoden(userId);
  const gespeichert = db.prepare('SELECT two_factor_preference AS p FROM users WHERE id = ?').get(userId)?.p;
  return aktiv.includes(gespeichert) ? gespeichert : (aktiv[0] || null);
}

/** "robin@example.org" → "r***@example.org"; eine Discord-ID → "…4567". */
function maskieren(methode, ziel) {
  const t = String(ziel || '');
  if (!t) return '';
  if (methode === 'email') {
    const [lokal, domain] = t.split('@');
    return `${lokal.slice(0, 1)}***@${domain || ''}`;
  }
  if (methode === 'discord') return `…${t.slice(-4)}`;
  return '';
}

const smtpEinstellungen = () => ({
  host: settings.hole('smtp_host'),
  port: settings.hole('smtp_port'),
  user: settings.hole('smtp_user'),
  passwort: settings.hole('smtp_passwort'),
  absender: settings.hole('smtp_absender'),
  tlsUnsicher: settings.hole('smtp_tls_unsicher') === '1',
});

const smtpBereit = () => Boolean(settings.hole('smtp_host'));
const discordGlobalBereit = () => Boolean(settings.hole('discord_bot_token'));

/** Was die Oberfläche über die 2FA eines Benutzers wissen muss. Nie ein Geheimnis. */
function uebersicht(userId) {
  const methoden = {};
  for (const m of METHODEN) {
    const z = zeile(userId, m);
    methoden[m] = {
      aktiv: Boolean(z?.aktiv),
      ausstehend: Boolean(z && !z.aktiv),
      ziel: z?.aktiv ? maskieren(m, z.ziel) : '',
      eigener_bot: m === 'discord' && Boolean(z?.geheimnis_enc),
    };
  }
  return {
    methoden,
    bevorzugt: bevorzugte(userId),
    smtp_bereit: smtpBereit(),
    discord_global_bereit: discordGlobalBereit(),
  };
}

// ─── Zustellung ──────────────────────────────────────────────────────────────

const nachrichtText = (code, zweck) => (
  `Dein Code für das Mail-Panel: ${code}\n\n`
  + (zweck === 'einrichtung'
    ? 'Damit bestätigst du, dass du diese Adresse für die Zwei-Faktor-Anmeldung nutzen willst.\n'
    : 'Damit meldest du dich im Mail-Panel an.\n')
  + `Der Code gilt ${CODE_SEKUNDEN / 60} Minuten und nur ein einziges Mal.\n\n`
  + 'Hast du das nicht ausgelöst, ignoriere diese Nachricht — und ändere dein Passwort, '
  + 'denn jemand kennt es.'
);

/**
 * Schickt einen Code an das Ziel der Methode. Wirft mit einer Meldung, die der
 * Nutzer lesen darf (keine Geheimnisse darin).
 */
async function zustellen(methode, z, code, zweck) {
  if (methode === 'email') {
    if (!smtpBereit()) {
      throw new Error('Der Postausgang ist nicht eingerichtet (Einstellungen → Postausgang).');
    }
    await smtp.mailSenden({
      ...smtpEinstellungen(),
      an: z.ziel,
      betreff: zweck === 'einrichtung' ? 'Mail-Panel: Adresse bestätigen' : 'Mail-Panel: dein Anmeldecode',
      text: nachrichtText(code, zweck),
    });
    return;
  }
  if (methode === 'discord') {
    // Ein eigener Bot des Benutzers hat Vorrang vor dem des Panels.
    const token = entschluesseln(z.geheimnis_enc) || settings.hole('discord_bot_token');
    if (!token) throw new Error('Es ist kein Discord-Bot hinterlegt.');
    await discord.dmSenden({ token, userId: z.ziel, text: nachrichtText(code, zweck) });
    return;
  }
  throw new Error('Diese Methode verschickt keinen Code.');
}

// ─── Ticket ──────────────────────────────────────────────────────────────────

let letzteReinigung = 0;
function vielleichtAufraeumen() {
  const jetzt = Date.now();
  if (jetzt - letzteReinigung < 10 * 60 * 1000) return;
  letzteReinigung = jetzt;
  const grenze = jetztSek() - 24 * 60 * 60;
  db.prepare('DELETE FROM login_tickets WHERE ablauf < ?').run(grenze);
  db.prepare('DELETE FROM zweifaktor_codes WHERE ablauf < ?').run(grenze);
}

/** Stellt nach dem Passwort ein Ticket aus. Es gilt fünf Minuten und nur für die Code-Eingabe. */
function ticketAusstellen(userId) {
  vielleichtAufraeumen();
  const jti = crypto.randomUUID();
  const ablauf = jetztSek() + tokens.TICKET_SEKUNDEN;
  db.prepare('INSERT INTO login_tickets (jti, user_id, ablauf) VALUES (?, ?, ?)').run(jti, userId, ablauf);
  return { token: tokens.ticketSignieren(userId, jti), jti, ablauf };
}

/**
 * Prüft ein Ticket gegen Signatur UND Datenbank: Es muss echt, unabgelaufen,
 * nicht eingelöst und nicht verbrannt sein.
 * @returns {{ok: true, ticket: object} | {ok: false, grund: string}}
 */
function ticketPruefen(token) {
  let t;
  try { t = tokens.ticketVerifizieren(token); } catch { return { ok: false, grund: 'ungueltig' }; }
  const z = db.prepare('SELECT * FROM login_tickets WHERE jti = ?').get(t.jti);
  if (!z || z.user_id !== t.userId) return { ok: false, grund: 'ungueltig' };
  if (z.verbraucht_am) return { ok: false, grund: 'verbraucht' };
  if (z.ablauf <= jetztSek()) return { ok: false, grund: 'abgelaufen' };
  if (z.fehlversuche >= MAX_FEHLVERSUCHE) return { ok: false, grund: 'verbrannt' };
  return { ok: true, ticket: z };
}

const ticketEinloesen = (jti) => db
  .prepare('UPDATE login_tickets SET verbraucht_am = CURRENT_TIMESTAMP WHERE jti = ? AND verbraucht_am IS NULL')
  .run(jti).changes === 1;

/** Zählt einen Fehlversuch. @returns {number} wie viele noch bleiben */
function fehlversuchZaehlen(jti) {
  db.prepare('UPDATE login_tickets SET fehlversuche = fehlversuche + 1 WHERE jti = ?').run(jti);
  const f = db.prepare('SELECT fehlversuche FROM login_tickets WHERE jti = ?').get(jti)?.fehlversuche ?? MAX_FEHLVERSUCHE;
  const rest = Math.max(0, MAX_FEHLVERSUCHE - f);
  if (rest === 0) {
    db.prepare("UPDATE login_tickets SET verbraucht_am = COALESCE(verbraucht_am, CURRENT_TIMESTAMP) WHERE jti = ?").run(jti);
  }
  return rest;
}

/**
 * Hat jemand für diesen Benutzer in den letzten 15 Minuten zu oft einen falschen
 * Code versucht? Gezählt wird über ALLE Tickets und Adressen — sonst bliebe
 * unbegrenztes Durchprobieren: neu anmelden, neues Ticket, weiter.
 */
function nutzerGesperrt(userId) {
  const n = db.prepare(`
    SELECT COUNT(*) AS n FROM auth_log
    WHERE user_id = ? AND erfolg = 0 AND methode LIKE '2fa-%'
      AND created_at > datetime('now', '-15 minutes')
  `).get(userId).n;
  return n >= MAX_FEHLER_JE_NUTZER;
}

// ─── Codes (E-Mail, Discord) ─────────────────────────────────────────────────

/**
 * Legt einen Code an, schickt ihn und verwirft ältere ungenutzte derselben Art.
 * Scheitert das Senden, bleibt kein Code liegen.
 */
async function codeSenden({ userId, ticketJti = null, methode, z, zweck }) {
  const kontext = ticketJti || 'einrichtung';
  const code = neuerCode();
  const ablauf = Math.min(jetztSek() + CODE_SEKUNDEN, ...(ticketJti
    ? [db.prepare('SELECT ablauf FROM login_tickets WHERE jti = ?').get(ticketJti)?.ablauf ?? Infinity]
    : []));

  // Alte Codes derselben Art ungültig machen: Es soll immer genau EIN Code gelten,
  // sonst vervielfacht jedes „erneut senden" die Menge der Treffer.
  db.prepare(`
    UPDATE zweifaktor_codes SET verbraucht_am = CURRENT_TIMESTAMP
    WHERE user_id = ? AND methode = ? AND zweck = ? AND IFNULL(ticket_jti, '') = IFNULL(?, '') AND verbraucht_am IS NULL
  `).run(userId, methode, zweck, ticketJti);

  const id = db.prepare(`
    INSERT INTO zweifaktor_codes (user_id, ticket_jti, methode, zweck, code_hash, ablauf)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, ticketJti, methode, zweck, codeHash(userId, kontext, methode, code), ablauf).lastInsertRowid;

  try {
    await zustellen(methode, z, code, zweck);
  } catch (err) {
    db.prepare('DELETE FROM zweifaktor_codes WHERE id = ?').run(id);
    throw err;
  }
  return { ablauf };
}

/**
 * Prüft einen eingegebenen Code gegen den gespeicherten Hash. Ein richtiger Code
 * wird dabei verbraucht — atomar, damit er nicht zweimal gilt.
 */
function codePruefen({ userId, ticketJti = null, methode, zweck, eingabe }) {
  const eingegeben = String(eingabe == null ? '' : eingabe).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(eingegeben)) return false;

  const z = db.prepare(`
    SELECT * FROM zweifaktor_codes
    WHERE user_id = ? AND methode = ? AND zweck = ? AND IFNULL(ticket_jti, '') = IFNULL(?, '')
      AND verbraucht_am IS NULL AND ablauf > ?
    ORDER BY id DESC LIMIT 1
  `).get(userId, methode, zweck, ticketJti, jetztSek());
  if (!z) return false;

  const erwartet = codeHash(userId, ticketJti || 'einrichtung', methode, eingegeben);
  if (!hashGleich(z.code_hash, erwartet)) {
    // Auch ein einzelner Code verträgt nur wenige Versuche.
    db.prepare('UPDATE zweifaktor_codes SET versuche = versuche + 1 WHERE id = ?').run(z.id);
    if (z.versuche + 1 >= MAX_FEHLVERSUCHE) {
      db.prepare('UPDATE zweifaktor_codes SET verbraucht_am = CURRENT_TIMESTAMP WHERE id = ? AND verbraucht_am IS NULL').run(z.id);
    }
    return false;
  }
  return db.prepare('UPDATE zweifaktor_codes SET verbraucht_am = CURRENT_TIMESTAMP WHERE id = ? AND verbraucht_am IS NULL')
    .run(z.id).changes === 1;
}

// ─── TOTP ────────────────────────────────────────────────────────────────────

/**
 * Prüft einen Authenticator-Code gegen das gespeicherte Geheimnis. Ein Zeitschritt
 * gilt nur einmal: Der zuletzt benutzte wird gemerkt und nicht noch einmal akzeptiert.
 * @param {boolean} [ausstehend] gegen die noch unbestätigte Einrichtung prüfen
 */
function totpPruefen(userId, eingabe, { ausstehend = false } = {}) {
  const z = zeile(userId, 'totp');
  if (!z || !z.geheimnis_enc || Boolean(z.aktiv) === ausstehend) return false;
  const geheimnis = entschluesseln(z.geheimnis_enc);
  const schritt = totp.pruefen(geheimnis, eingabe, { nachSchritt: z.letzter_schritt });
  if (schritt == null) return false;
  return db.prepare(`
    UPDATE user_2fa SET letzter_schritt = ?
    WHERE user_id = ? AND methode = 'totp' AND (letzter_schritt IS NULL OR letzter_schritt < ?)
  `).run(schritt, userId, schritt).changes === 1;
}

// ─── Login ───────────────────────────────────────────────────────────────────

/**
 * Prüft den Code eines Logins für eine Methode.
 * @returns {boolean}
 */
function loginCodePruefen({ userId, ticketJti, methode, eingabe }) {
  if (!METHODEN.includes(methode) || !aktiveMethoden(userId).includes(methode)) return false;
  if (methode === 'totp') return totpPruefen(userId, eingabe);
  return codePruefen({ userId, ticketJti, methode, zweck: 'login', eingabe });
}

/** Schickt den Code eines Logins (E-Mail oder Discord). Zählt gegen die Sendungen des Tickets. */
async function loginCodeSenden({ ticket, methode }) {
  if (!['email', 'discord'].includes(methode)) throw Object.assign(new Error('Diese Methode braucht keinen Code zum Senden.'), { status: 400 });
  const z = zeile(ticket.user_id, methode);
  if (!z?.aktiv) throw Object.assign(new Error('Diese Methode ist nicht eingerichtet.'), { status: 400 });

  // Vor dem Senden zählen — auch ein fehlgeschlagener Versuch kostet, sonst wäre
  // ein kaputter Postausgang ein Dauerfeuer.
  const gezaehlt = db.prepare(
    'UPDATE login_tickets SET sendungen = sendungen + 1 WHERE jti = ? AND sendungen < ?',
  ).run(ticket.jti, MAX_SENDUNGEN).changes === 1;
  if (!gezaehlt) throw Object.assign(new Error('Du hast den Code schon dreimal angefordert. Bitte melde dich neu an.'), { status: 429 });

  return codeSenden({ userId: ticket.user_id, ticketJti: ticket.jti, methode, z, zweck: 'login' });
}

// ─── Einrichten ──────────────────────────────────────────────────────────────

function einrichtungsSendungenFrei(userId) {
  const n = db.prepare(`
    SELECT COUNT(*) AS n FROM zweifaktor_codes
    WHERE user_id = ? AND zweck = 'einrichtung' AND created_at > datetime('now', '-15 minutes')
  `).get(userId).n;
  return n < MAX_EINRICHTUNGS_SENDUNGEN;
}

const ADRESSE_FEHLER = 'Bitte eine gültige E-Mail-Adresse angeben.';

/** Beginnt die Einrichtung der Authenticator-App: erzeugt ein Geheimnis (noch nicht aktiv). */
function totpStarten(userId, username) {
  if (zeile(userId, 'totp')?.aktiv) throw Object.assign(new Error('Die Authenticator-App ist schon eingerichtet — schalte sie zuerst ab.'), { status: 409 });
  const geheimnis = totp.neuesGeheimnis();
  db.prepare(`
    INSERT INTO user_2fa (user_id, methode, aktiv, geheimnis_enc, letzter_schritt)
    VALUES (?, 'totp', 0, ?, NULL)
    ON CONFLICT(user_id, methode) DO UPDATE SET aktiv = 0, geheimnis_enc = excluded.geheimnis_enc, letzter_schritt = NULL
  `).run(userId, verschluesseln(geheimnis));
  return { geheimnis, uri: totp.uri({ geheimnis, konto: username }) };
}

/**
 * Beginnt die Einrichtung per E-Mail oder Discord: Schickt einen Code an das Ziel.
 * Aktiv wird die Methode erst, wenn dieser Code zurückkommt — sonst sperrt ein
 * Tippfehler in der Adresse den Benutzer beim nächsten Login aus.
 */
async function codeMethodeStarten({ userId, methode, ziel, eigenerBot }) {
  if (!['email', 'discord'].includes(methode)) throw Object.assign(new Error('Unbekannte Methode.'), { status: 400 });
  if (zeile(userId, methode)?.aktiv) throw Object.assign(new Error(`${BEZEICHNUNG[methode]} ist schon eingerichtet — schalte es zuerst ab.`), { status: 409 });
  if (!einrichtungsSendungenFrei(userId)) {
    throw Object.assign(new Error('Du hast in kurzer Zeit zu viele Codes angefordert. Bitte warte ein paar Minuten.'), { status: 429 });
  }

  let geheimnis = null;
  if (methode === 'email') {
    if (!smtp.istAdresse(ziel)) throw Object.assign(new Error(ADRESSE_FEHLER), { status: 400 });
    if (!smtpBereit()) throw Object.assign(new Error('Der Postausgang ist nicht eingerichtet (Einstellungen → Postausgang).'), { status: 400 });
  } else {
    if (!discord.istBenutzerId(ziel)) throw Object.assign(new Error('Die Discord-Benutzer-ID besteht aus 17 bis 20 Ziffern.'), { status: 400 });
    const eigener = String(eigenerBot || '').trim();
    if (eigener && !discord.sieheAusWieToken(eigener)) throw Object.assign(new Error('Das sieht nicht wie ein Discord-Bot-Token aus.'), { status: 400 });
    if (!eigener && !discordGlobalBereit()) {
      throw Object.assign(new Error('Es ist kein Discord-Bot hinterlegt — trage einen eigenen ein oder bitte einen Admin, einen in den Einstellungen zu hinterlegen.'), { status: 400 });
    }
    geheimnis = eigener ? verschluesseln(eigener) : null;
  }

  db.prepare(`
    INSERT INTO user_2fa (user_id, methode, aktiv, ziel, geheimnis_enc)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(user_id, methode) DO UPDATE SET aktiv = 0, ziel = excluded.ziel, geheimnis_enc = excluded.geheimnis_enc
  `).run(userId, methode, String(ziel), geheimnis);
  try {
    return await codeSenden({ userId, methode, z: zeile(userId, methode), zweck: 'einrichtung' });
  } catch (err) {
    // Ohne zugestellten Code lässt sich die Einrichtung nicht abschließen — die
    // halbe Zeile (samt eigenem Bot-Token) soll dann nicht liegen bleiben.
    db.prepare('DELETE FROM user_2fa WHERE user_id = ? AND methode = ? AND aktiv = 0').run(userId, methode);
    throw err;
  }
}

/**
 * Schließt die Einrichtung mit einem Code ab: Erst jetzt ist die Methode aktiv.
 * @returns {boolean}
 */
function einrichtungBestaetigen({ userId, methode, eingabe }) {
  const z = zeile(userId, methode);
  if (!z || z.aktiv) return false;

  const ok = methode === 'totp'
    ? totpPruefen(userId, eingabe, { ausstehend: true })
    : codePruefen({ userId, methode, zweck: 'einrichtung', eingabe });
  if (!ok) return false;

  db.transaction(() => {
    db.prepare("UPDATE user_2fa SET aktiv = 1, bestaetigt_am = CURRENT_TIMESTAMP WHERE user_id = ? AND methode = ?").run(userId, methode);
    // Die erste Methode wird gleich zur vorgewählten.
    db.prepare('UPDATE users SET two_factor_preference = ? WHERE id = ? AND two_factor_preference IS NULL').run(methode, userId);
  })();
  return true;
}

/** Schaltet eine Methode ab (oder bricht eine begonnene Einrichtung ab). */
function deaktivieren(userId, methode) {
  db.transaction(() => {
    db.prepare('DELETE FROM user_2fa WHERE user_id = ? AND methode = ?').run(userId, methode);
    db.prepare('DELETE FROM zweifaktor_codes WHERE user_id = ? AND methode = ?').run(userId, methode);
    const rest = aktiveMethoden(userId);
    const pref = db.prepare('SELECT two_factor_preference AS p FROM users WHERE id = ?').get(userId)?.p;
    if (pref === methode || !rest.includes(pref)) {
      db.prepare('UPDATE users SET two_factor_preference = ? WHERE id = ?').run(rest[0] || null, userId);
    }
  })();
}

/** Setzt die vorgewählte Methode — nur eine aktive. @returns {boolean} */
function bevorzugtSetzen(userId, methode) {
  if (!aktiveMethoden(userId).includes(methode)) return false;
  db.prepare('UPDATE users SET two_factor_preference = ? WHERE id = ?').run(methode, userId);
  return true;
}

/**
 * Notausgang für einen Admin: Wer sein Gerät verloren hat, kommt sonst nie wieder
 * hinein. Entfernt alle Methoden und macht offene Tickets und Codes unbrauchbar.
 */
function zuruecksetzen(userId) {
  db.transaction(() => {
    db.prepare('DELETE FROM user_2fa WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM zweifaktor_codes WHERE user_id = ?').run(userId);
    db.prepare("UPDATE login_tickets SET verbraucht_am = COALESCE(verbraucht_am, CURRENT_TIMESTAMP) WHERE user_id = ?").run(userId);
    db.prepare('UPDATE users SET two_factor_preference = NULL WHERE id = ?').run(userId);
  })();
}

module.exports = {
  METHODEN, BEZEICHNUNG,
  CODE_SEKUNDEN, MAX_FEHLVERSUCHE, MAX_SENDUNGEN, MAX_FEHLER_JE_NUTZER, MAX_EINRICHTUNGS_SENDUNGEN,
  aktiveMethoden, hatZweifaktor, bevorzugte, maskieren, uebersicht, smtpBereit, discordGlobalBereit,
  ticketAusstellen, ticketPruefen, ticketEinloesen, fehlversuchZaehlen, nutzerGesperrt,
  loginCodeSenden, loginCodePruefen,
  totpStarten, codeMethodeStarten, einrichtungBestaetigen, deaktivieren, bevorzugtSetzen, zuruecksetzen,
  // für Tests
  codeHash, codePruefen, codeSenden,
};
