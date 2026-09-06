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
  if (cache.stand && Date.now() - cache.zeit < CACHE_MS) return cache.stand;

  const konten = db.prepare('SELECT * FROM accounts').all();
  const raus = [];
  for (const konto of konten) {
    try {
      const uids = await imap.uidsAuflisten({ ...themen.zugang(konto), ordner: 'INBOX' });
      raus.push({ konto: konto.name, konto_id: konto.id, wartend: uids.size, erreichbar: true });
    } catch (err) {
      // Ein nicht erreichbares Postfach darf die Übersicht nicht scheitern
      // lassen — es wird als solches ausgewiesen.
      raus.push({ konto: konto.name, konto_id: konto.id, wartend: null, erreichbar: false, fehler: err.message });
      loggen('warn', 'uebersicht', `Posteingang von ${konto.name} nicht lesbar: ${err.message}`);
    }
  }
  cache = { zeit: Date.now(), stand: raus };
  return raus;
}

function cacheVerwerfen() { cache = { zeit: 0, stand: null }; }

// ─── Zahlen aus der Datenbank ────────────────────────────────────────────────

function zahl(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return 0; }
}

function tagesbudget() {
  const n = Number(settings.hole('gemini_tagesbudget'));
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = kein Deckel gesetzt
}

// Wie viele KI-Einordnungen heute? Gezählt wird, was Gemini wirklich gesehen
// hat: Mails, die eine eigene Sortier-Regel trifft, laufen im Workflow an der
// KI vorbei (ki = 0) und dürfen das Tageslimit nicht verbrauchen.
function heuteVerbraucht() {
  return zahl("SELECT COUNT(*) n FROM quarantine_log WHERE created_at >= date('now','localtime')"
    + ' AND IFNULL(ki, 1) = 1');
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

  return {
    zeitpunkt: new Date().toISOString(),

    // „Wie weit ist die Sortierung?"
    posteingang: {
      konten: staende,
      wartendGesamt,
      offeneEntscheidungen: zahl("SELECT COUNT(*) n FROM sort_inbox WHERE status='offen'"),
    },

    // KI-Tagesbudget
    budget: {
      grenze: budget,               // 0 = nicht gesetzt
      heute: verbraucht,
      rest: budget ? Math.max(0, budget - verbraucht) : null,
      ausgeschoepft: budget ? verbraucht >= budget : false,
      // Wo Google heute abgewiesen hat — das Nächste an einem echten Tageslimit,
      // was sich überhaupt beschaffen lässt. Siehe services/kiKontingent.js.
      beobachtet: kiKontingent.stand().beobachtet,
      // Welches Modell gerade arbeitet. Nach einer Abweisung kann das Panel auf
      // ein Ersatzmodell wechseln — dessen Kontingent ist ein eigenes.
      modell: require('./kiModell').stand(),
    },

    // Qualität und Umfang
    lernen: {
      regeln: zahl('SELECT COUNT(*) n FROM sort_rules'),
      themen: zahl("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='themen_katalog'")
        ? zahl('SELECT COUNT(*) n FROM themen_katalog') : 0,
      einordnungen7,
      korrigiert7,
      trefferquote: einordnungen7 > 0 ? Math.round((1 - korrigiert7 / einordnungen7) * 100) : null,
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
