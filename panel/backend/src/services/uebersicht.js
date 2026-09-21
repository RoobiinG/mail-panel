// Die Übersicht fürs Dashboard: alles Wichtige an einer Stelle, gemessen statt
// geraten. Sie beantwortet die zwei Fragen, die man beim täglichen Blick hat —
// „läuft alles?" und „wie weit ist die Sortierung?".
//
// Der IMAP-Teil (wie viele Mails warten noch im Posteingang) kostet je Konto
// eine Verbindung. Deshalb wird er zwischengespeichert: Ein Dashboard, das man
// alle paar Sekunden neu lädt, soll nicht bei jedem Blick jedes Postfach
// abfragen — Mailserver begrenzen die Verbindungen.
const db = require('../db');
const settings = require('./settings');
const themen = require('./themen');
const imap = require('./imap');
const aufsicht = require('./aufsicht');
const sicherung = require('./postfachSicherung');
const belegLeser = require('./belegLeser');
const kiKontingent = require('./kiKontingent');
const { loggen } = require('./panelLog');

// ─── Posteingangs-Stände, zwischengespeichert ────────────────────────────────
const CACHE_MS = 60 * 1000;
let cache = { zeit: 0, stand: null };

async function posteingangStaende() {
  const konten = db.prepare('SELECT * FROM accounts').all();
  const raus = [];
  for (const konto of konten) {
    // Sortier-Inbox (wartet auf manuelle Freigabe/Zuordnung)
    const wartend = db.prepare("SELECT COUNT(*) n FROM sort_inbox WHERE konto_id = ? AND status='offen'").get(konto.id)?.n || 0;
    // Im Posteingang gezählte Mails (aus der Absender-Zählung)
    let posteingangGesamt = 0;
    try {
      posteingangGesamt = db.prepare("SELECT SUM(anzahl) n FROM absender_stat WHERE konto_id = ?").get(konto.id)?.n || 0;
    } catch {}
    raus.push({ konto: konto.name, konto_id: konto.id, wartend, posteingangGesamt, erreichbar: true });
  }
  return raus;
}

function cacheVerwerfen() { /* Wird nicht mehr benoetigt, aber als Dummy behalten */ }

// ─── Zahlen aus der Datenbank ────────────────────────────────────────────────

function zahl(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return 0; }
}

// Bewusst über den Budget-Dienst statt direkt aus den Einstellungen: Hat Google
// heute schon abgewiesen, gilt dessen Stand als Obergrenze — und dann soll im
// Dashboard auch die stehen und nicht die eingestellte Wunschzahl.
function tagesbudget() {
  return require('./budget').tagesbudget();
}

// Wie viele KI-Einordnungen heute? Gezählt wird, was Gemini wirklich gesehen
// hat: Mails, die eine eigene Sortier-Regel trifft, laufen im Workflow an der
// KI vorbei (ki = 0) und dürfen das Tageslimit nicht verbrauchen.
//
// Über den Budget-Dienst, weil dort auch die Anfragen mitzählen, die ein
// abgestürzter Lauf verbraucht hat, ohne sie je zu protokollieren — sonst zeigt
// das Dashboard weniger an, als Google zählt.
function heuteVerbraucht() {
  return require('./budget').heuteVerbraucht();
}

// ─── Die ganze Übersicht ─────────────────────────────────────────────────────

async function laden({ mitPosteingang = true } = {}) {
  const staende = mitPosteingang ? await posteingangStaende().catch(() => []) : [];

  const wartendGesamt = staende
    .filter((s) => s.erreichbar)
    .reduce((s, k) => s + (k.wartend || 0), 0);

  const budget = tagesbudget();
  const verbraucht = heuteVerbraucht();

  const einordnungen7 = zahl(
    "SELECT COUNT(*) n FROM quarantine_log WHERE created_at >= datetime('now','-7 days')",
  );
  const korrigiert7 = zahl(
    "SELECT COUNT(*) n FROM quarantine_log WHERE korrigiert_zu IS NOT NULL AND created_at >= datetime('now','-7 days')",
  );

  // ─── Was auf eine Entscheidung wartet ──────────────────────────────────────
  //
  // Die eine Frage, mit der man das Dashboard öffnet: Muss ich etwas tun? Die
  // Zahlen lagen bisher über vier Seiten verteilt, und eine davon (die
  // steckengebliebenen Bestandsmails) wurde zwar berechnet, aber nirgends
  // angezeigt — obwohl im Code daneben stand, dass sie sichtbar sein muss.
  //
  // Nur Zahlen, keine Beschriftungen: Wie sie heißen und wohin sie führen,
  // entscheidet die Oberfläche.
  const nachsortierungLauf = (() => {
    try { return require('./nachsortierung').letzterLauf(); } catch { return null; }
  })();

  const zuTun = {
    zuordnungen: zahl("SELECT COUNT(*) n FROM sort_inbox WHERE status='offen'"),
    themenVorschlaege: zahl("SELECT COUNT(*) n FROM ordner_vorschlaege WHERE status='offen'"),
    freigaben: zahl("SELECT COUNT(*) n FROM upload_freigaben WHERE status='offen'"),
    aufProbe: zahl("SELECT COUNT(*) n FROM konto_ordner WHERE auf_probe = 1"),
    // Nur ein Trockenlauf wartet auf eine Entscheidung. Lief die Nachsortierung
    // scharf, ist sie damit fertig und hat nichts offen.
    nachsortierung: nachsortierungLauf?.trockenlauf ? (nachsortierungLauf.treffer || 0) : 0,
    bestandUnklar: require('./bestand').unklareAnzahl(),
  };
  zuTun.gesamt = Object.values(zuTun).reduce((s, n) => s + (Number(n) || 0), 0);

  return {
    zeitpunkt: new Date().toISOString(),
    zuTun,

    // „Wie weit ist die Sortierung?"
    posteingang: {
      konten: staende,
      wartendGesamt,
      offeneEntscheidungen: zahl("SELECT COUNT(*) n FROM sort_inbox WHERE status='offen'"),
    },

    // KI-Nutzung. Ollama hat kein Tageslimit, wir zeigen nur die Statistik.
    budget: {
      grenze: 0,
      heute: verbraucht,
      mailsHeute: require('./budget').protokolliertHeute(),
      jeAnfrage: require('./budget').mailsJeAnfrage(),
      rest: null,
      ausgeschoepft: false,
      beobachtet: null,
      modell: settings.hole('ollama_modell') || 'llama3.1',
      kiAnbieter: 'ollama',
    },

    // Qualität und Umfang
    lernen: {
      regeln: zahl('SELECT COUNT(*) n FROM sort_rules'),
      themen: zahl("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='themen_katalog'")
        ? zahl('SELECT COUNT(*) n FROM themen_katalog') : 0,
      einordnungen7,
      korrigiert7,
      trefferquote: einordnungen7 > 0 ? Number(((1 - korrigiert7 / einordnungen7) * 100).toFixed(1)) : null,
    },

    // Belege: was heute/diese Woche nach Nextcloud ging und was das Gate aussortiert hat
    belege: (() => {
      const grenze = belegLeser.tagesbudget();
      const gelesen = belegLeser.heuteGelesen();
      return {
        heute: zahl("SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 1 AND created_at >= date('now','localtime')"),
        uebersprungenHeute: zahl("SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 0 AND created_at >= date('now','localtime')"),
        woche: zahl("SELECT COUNT(*) n FROM beleg_ablage WHERE gespeichert = 1 AND created_at >= datetime('now','-7 days')"),
        leseGrenze: grenze,           // 0 = kein Deckel
        gelesenHeute: gelesen,
      };
    })(),

    // Bestands-Triage: wann wurde der Altbestand zuletzt angefasst? Gesetzt vom
    // Budget-Waechter, den nur Workflow 04 ruft.
    bestand: {
      letzterLauf: settings.hole('bestand_letzter_lauf') || null,
      verarbeitet: Number(settings.hole('bestand_letzter_lauf_anzahl')) || 0,
      gesamt: Number(settings.hole('bestand_letzter_lauf_gesamt')) || 0,
      intervallStunden: Number(settings.hole('bestand_intervall')) || 0,
      // Mails, die zweimal angeboten wurden und trotzdem liegen blieben — kein
      // Absender, Zielordner fehlt, so etwas. Sie werden nicht mehr angeboten,
      // damit sie den Bestand nicht blockieren; sichtbar müssen sie trotzdem
      // sein, sonst ist es dasselbe stille Verschwinden wie zuvor.
      unklar: require('./bestand').unklareAnzahl(),
    },

    // „Läuft alles?"
    aufsicht: aufsicht.letzterLauf(),
    sicherung: (() => {
      const e = sicherung.einstellungen();
      const l = sicherung.letzterLauf();
      return {
        aktiv: e.aktiv, verschluesselt: e.tls, eingerichtet: sicherung.bereit(e).length === 0,
        letzter: l ? { ok: l.ok, mails: l.mails, unvollstaendig: l.unvollstaendig, zeitpunkt: l.zeitpunkt } : null,
      };
    })(),
  };
}

module.exports = { laden, posteingangStaende, cacheVerwerfen, tagesbudget, heuteVerbraucht };
