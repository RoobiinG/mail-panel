// Aufsicht: Läuft eigentlich noch, was laufen soll?
//
// Der Anlass, gefunden am 2026-09-02: Die Sortierung war sechs Tage lang aus,
// und nichts hat es gemeldet. Der Ablauf war dieser —
//
//   1. Der dovecot-Container starb.
//   2. n8n wollte Workflow 01 aktivieren, der IMAP-Auslöser für Dovecot
//      scheiterte mit "getaddrinfo ENOTFOUND dovecot".
//   3. n8n rollte daraufhin die GANZE Aktivierung zurück — auch den
//      Gmail-Auslöser, dem nichts fehlte.
//   4. Nächster Versuch: einmal alle 24 Stunden.
//
// Ein einziges kurzzeitig nicht erreichbares Postfach schaltet also die
// Sortierung für alle anderen mit ab. Mit jedem weiteren Konto wird das
// wahrscheinlicher, und niemand erfährt davon — es kracht ja nicht, es
// passiert nur nichts mehr.
//
// Diese Aufsicht vergleicht regelmäßig Soll und Ist, schreibt Abweichungen ins
// Log und legt sie fürs Dashboard ab. Auf Wunsch schaltet sie selbst wieder
// ein, statt auf n8ns Tagesrhythmus zu warten.
const settings = require('./settings');
const n8n = require('./n8n');
const { loggen } = require('./panelLog');

function einstellungen() {
  const zahl = (key, standard) => {
    const n = Number(settings.hole(key));
    return Number.isFinite(n) && n > 0 ? n : standard;
  };
  return {
    aktiv: settings.hole('aufsicht_aktiv') !== '0',
    reparieren: settings.hole('aufsicht_reparieren') !== '0',
    // Fünfzehn Minuten ist ein Kompromiss: oft genug, dass ein Ausfall nicht
    // über Nacht unbemerkt bleibt, selten genug, dass es n8n nicht belästigt.
    taktMinuten: zahl('aufsicht_takt', 15),
  };
}

// ─── Soll-Zustand ───────────────────────────────────────────────────────────
//
// Woher weiß die Aufsicht, was laufen SOLL? Aus dem, was zuletzt bewusst
// eingeschaltet war. Schaltet jemand im Panel etwas ab, wird das vermerkt und
// danach nicht mehr angemahnt — sonst arbeitete die Aufsicht gegen den Willen
// des Nutzers.

function soll() {
  try { return JSON.parse(settings.hole('aufsicht_soll') || '{}'); } catch { return {}; }
}

function sollSetzen(karte) {
  settings.setze('aufsicht_soll', JSON.stringify(karte));
}

// Wird aufgerufen, wenn jemand im Panel einen Workflow umschaltet.
function absichtMerken(id, aktiv, name) {
  const karte = soll();
  karte[id] = { aktiv: Boolean(aktiv), name: name || karte[id]?.name || String(id) };
  sollSetzen(karte);
}

// Beim allerersten Lauf gibt es noch keinen Soll-Zustand. Dann gilt schlicht,
// was gerade läuft — alles andere wäre geraten.
function ersteAufnahme(workflows) {
  const karte = {};
  for (const w of workflows) karte[w.id] = { aktiv: Boolean(w.active), name: w.name };
  sollSetzen(karte);
  loggen('info', 'aufsicht',
    `Soll-Zustand aufgenommen: ${workflows.filter((w) => w.active).length} von ${workflows.length} Workflows laufen.`);
  return karte;
}

// ─── Prüfen ─────────────────────────────────────────────────────────────────

async function pruefen({ reparieren = null } = {}) {
  const e = einstellungen();
  const darfReparieren = reparieren === null ? e.reparieren : reparieren;
  const zeitpunkt = new Date().toISOString();

  let workflows;
  try {
    workflows = await n8n.workflowsAuflisten();
  } catch (err) {
    // n8n selbst nicht erreichbar ist der schwerste Fall: Dann läuft gar nichts.
    const ergebnis = {
      ok: false, zeitpunkt, n8nErreichbar: false, fehler: err.message,
      abweichungen: [], repariert: [],
    };
    settings.setze('aufsicht_letzter_lauf', JSON.stringify(ergebnis));
    loggen('error', 'aufsicht', `n8n ist nicht erreichbar: ${err.message}`);
    return ergebnis;
  }

  let karte = soll();
  if (Object.keys(karte).length === 0) karte = ersteAufnahme(workflows);

  const nachId = new Map(workflows.map((w) => [String(w.id), w]));
  const abweichungen = [];

  for (const [id, wunsch] of Object.entries(karte)) {
    if (!wunsch.aktiv) continue;
    const ist = nachId.get(String(id));
    if (!ist) {
      abweichungen.push({
        id, name: wunsch.name, art: 'weg',
        text: `Workflow "${wunsch.name}" gibt es in n8n nicht mehr.`,
      });
      continue;
    }
    if (!ist.active) {
      abweichungen.push({
        id, name: ist.name, art: 'inaktiv',
        text: `Workflow "${ist.name}" sollte laufen, ist aber ausgeschaltet.`,
      });
    }
  }

  const repariert = [];
  if (darfReparieren) {
    for (const a of abweichungen.filter((x) => x.art === 'inaktiv')) {
      try {
        await n8n.workflowAktivieren(a.id, true);
        a.behoben = true;
        repariert.push(a.name);
      } catch (err) {
        // Der Grund von n8n ist das Wertvolle: "ENOTFOUND dovecot" sagt genau,
        // welches Postfach klemmt.
        a.grund = err.message;
      }
    }
  }

  const offen = abweichungen.filter((a) => !a.behoben);
  const ergebnis = {
    ok: offen.length === 0,
    zeitpunkt,
    n8nErreichbar: true,
    geprueft: Object.values(karte).filter((w) => w.aktiv).length,
    abweichungen,
    repariert,
  };
  settings.setze('aufsicht_letzter_lauf', JSON.stringify(ergebnis));

  // Bei der Gelegenheit nachsehen, ob Google heute schon abgewiesen hat. Der
  // Rundgang ist ohnehin schon mit n8n verbunden — und die Zahl, bei der die
  // Abweisung kam, ist das Einzige, was einem Tageslimit nahekommt (Google gibt
  // keinen Rest-Zaehler heraus, siehe services/kiKontingent.js).
  try { await require('./kiKontingent').nachAbweisungSehen(); }
  catch (err) { loggen('warn', 'aufsicht', `KI-Kontingent nicht pruefbar: ${err.message}`); }

  // Neuer Tag, neues Kontingent: Steht das Panel noch auf dem Ersatzmodell,
  // geht es zurueck auf das erste (services/kiModell.js).
  try { await require('./kiModell').taeglichPruefen(); }
  catch (err) { loggen('warn', 'aufsicht', `Modell nicht zurueckgesetzt: ${err.message}`); }

  if (repariert.length) {
    loggen('warn', 'aufsicht',
      `${repariert.length} Workflow(s) waren ausgeschaltet und wurden wieder eingeschaltet: ${repariert.join(', ')}.`);
  }
  for (const a of offen) {
    loggen('error', 'aufsicht', a.text + (a.grund ? ` Grund von n8n: ${a.grund}` : ''));
  }
  return ergebnis;
}

function letzterLauf() {
  try { return JSON.parse(settings.hole('aufsicht_letzter_lauf') || 'null'); } catch { return null; }
}

// ─── Zeitplan ───────────────────────────────────────────────────────────────
let uhr = null;

function zeitplanStarten() {
  if (uhr) clearInterval(uhr);
  uhr = setInterval(() => {
    if (!einstellungen().aktiv) return;
    pruefen().catch((err) => loggen('warn', 'aufsicht', `Prüfung fehlgeschlagen: ${err.message}`));
  }, Math.max(1, einstellungen().taktMinuten) * 60 * 1000);
  if (uhr.unref) uhr.unref();

  // Einmal kurz nach dem Start, damit ein Ausfall nicht bis zum ersten Takt
  // wartet. Verzögert, weil n8n nach einem gemeinsamen Neustart selbst noch
  // hochfährt und sonst fälschlich als "nicht erreichbar" gälte.
  const ersteMal = setTimeout(() => {
    if (einstellungen().aktiv) {
      pruefen().catch((err) => loggen('warn', 'aufsicht', `Erste Prüfung fehlgeschlagen: ${err.message}`));
    }
  }, 90 * 1000);
  if (ersteMal.unref) ersteMal.unref();

  return uhr;
}

module.exports = {
  pruefen, letzterLauf, einstellungen,
  soll, sollSetzen, absichtMerken, ersteAufnahme,
  zeitplanStarten,
};
