// Welches Gemini-Modell benutzt das Panel gerade — und was, wenn dessen
// Kontingent für heute leer ist?
//
// Googles Kontingente gelten **je Modell**. Ist das Tageslimit von
// gemini-3.5-flash-lite erreicht, hat ein anderes Modell noch sein eigenes. Ein
// Wechsel bringt also wirklich zusätzliche Läufe — er ist kein Trick, sondern
// die Art, wie die Limits gebaut sind.
//
// Bewusst NICHT von allein an: Ein Ersatzmodell ist meist das größere, und mit
// aktivierter Abrechnung kostet jede Anfrage dort mehr. Solche Entscheidungen
// trifft niemand im Hintergrund für den Nutzer. Solange kein Ersatzmodell
// eingetragen ist, passiert hier gar nichts.
const settings = require('./settings');
const { loggen } = require('./panelLog');

// Dasselbe Modell wie bisher überall fest verdrahtet — jetzt an einer Stelle.
const STANDARD = 'gemini-3.5-flash-lite';

const heute = () => new Date().toLocaleDateString('sv-SE');

const primaer = () => String(settings.hole('gemini_modell') || STANDARD).trim() || STANDARD;

// Ein Ersatzmodell, das dem ersten gleicht, ist keins.
//
// Steht in beiden Feldern dasselbe, hielte aufErsatz() das Panel von der ersten
// Sekunde an für umgeschaltet — und beiAbweisung() täte dann nie etwas, weil es
// glaubt, schon auf dem Ersatz zu stehen. Das Feld sähe gefüllt aus und wäre
// wirkungslos. Genau das ist im Betrieb passiert. Die Oberfläche verhindert es
// jetzt schon bei der Eingabe; hier steht die zweite Absicherung, denn alte
// Einträge stehen ja bereits in der Datenbank.
function ersatz() {
  const zweit = String(settings.hole('gemini_modell_ersatz') || '').trim();
  return zweit && zweit !== primaer() ? zweit : '';
}

/** Das Modell, das gerade in den Workflows und im Panel benutzt wird. */
function aktiv() {
  const gewaehlt = String(settings.hole('gemini_modell_aktiv') || '').trim();
  return gewaehlt || primaer();
}

/** Steht das Panel gerade auf dem Ersatzmodell? */
const aufErsatz = () => Boolean(ersatz()) && aktiv() === ersatz();

// Das Modell in den Gemini-Knoten der Workflows nachziehen. Ohne diesen Schritt
// stünde der Wechsel nur in der Datenbank, und n8n würde weiter das alte Modell
// aufrufen. Verzögert geladen, weil workflowPatcher selbst Einstellungen liest.
async function inWorkflowsNachziehen() {
  try {
    return await require('./workflowPatcher').geminiModellNachziehen();
  } catch (err) {
    loggen('warn', 'ki-modell', `Modellwechsel kam nicht in die Workflows: ${err.message}`);
    return 0;
  }
}

/**
 * Google hat abgewiesen. Gibt es ein Ersatzmodell und laufen wir noch auf dem
 * ersten, wird gewechselt — dessen Tageskontingent ist ein eigenes.
 */
async function beiAbweisung() {
  const zweit = ersatz();
  if (!zweit) return null;              // nicht eingerichtet: nichts tun
  if (aufErsatz()) return null;         // schon dort — dann ist heute Schluss

  settings.setze('gemini_modell_aktiv', zweit);
  settings.setze('gemini_modell_seit', heute());
  const workflows = await inWorkflowsNachziehen();
  loggen('warn', 'ki-modell',
    `Tageskontingent von "${primaer()}" ist aufgebraucht — umgeschaltet auf "${zweit}" `
    + `(${workflows} Workflow(s) angepasst). Morgen geht es wieder mit dem ersten Modell weiter.`);
  return zweit;
}

/**
 * Ein neuer Tag, ein neues Kontingent: zurück auf das erste Modell. Läuft im
 * Rundgang der Aufsicht mit.
 */
async function taeglichPruefen() {
  if (!aufErsatz()) return null;
  if (settings.hole('gemini_modell_seit') === heute()) return null;

  settings.setze('gemini_modell_aktiv', primaer());
  settings.setze('gemini_modell_seit', heute());
  const workflows = await inWorkflowsNachziehen();
  loggen('info', 'ki-modell',
    `Neuer Tag, neues Kontingent: zurück auf "${primaer()}" (${workflows} Workflow(s) angepasst).`);
  return primaer();
}

// ─── Welche Modelle gibt es überhaupt? ───────────────────────────────────────
//
// Ein Freitextfeld für einen Modellnamen ist eine Falle: Ein Tippfehler fällt
// erst auf, wenn Google mit 404 antwortet — im Zweifel mitten in einem Lauf,
// Stunden später. Google kann die Liste selbst liefern, also fragen wir sie.
//
// Der Schlüssel geht als Kopfzeile mit, nicht als URL-Parameter: Eine URL landet
// in Protokollen und Verläufen, ein Geheimnis hat darin nichts verloren.
//
// Zwischengespeichert, weil die Einstellungsseite bei jedem Aufruf fragt und
// sich die Liste allenfalls alle paar Wochen ändert.
const LISTE_CACHE_MS = 60 * 60 * 1000;
let listeCache = { zeit: 0, modelle: null };

function listeVergessen() { listeCache = { zeit: 0, modelle: null }; }

async function verfuegbare() {
  if (listeCache.modelle && Date.now() - listeCache.zeit < LISTE_CACHE_MS) {
    return { modelle: listeCache.modelle, fehler: null };
  }
  const key = settings.hole('gemini_api_key');
  if (!key) return { modelle: [], fehler: 'Kein Gemini-Schlüssel hinterlegt.' };

  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { modelle: [], fehler: `Google antwortete mit ${res.status}. Stimmt der Schlüssel?` };
    }
    const daten = await res.json();
    const modelle = (daten?.models || [])
      // Nur was klassifizieren kann. Einbettungs- und Bildmodelle stünden sonst
      // zur Auswahl und würden bei der ersten Mail scheitern.
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        name: String(m.name || '').replace(/^models\//, ''),
        anzeige: m.displayName || '',
        beschreibung: String(m.description || '').slice(0, 200),
      }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    listeCache = { zeit: Date.now(), modelle };
    return { modelle, fehler: null };
  } catch (err) {
    loggen('warn', 'ki-modell', `Modellliste nicht abrufbar: ${err.message}`);
    return { modelle: [], fehler: `Google war nicht erreichbar: ${err.message}` };
  }
}

/** Für die Anzeige im Panel. */
function stand() {
  return {
    aktiv: aktiv(),
    primaer: primaer(),
    ersatz: ersatz() || null,
    aufErsatz: aufErsatz(),
    seit: settings.hole('gemini_modell_seit') || null,
  };
}

module.exports = {
  STANDARD, aktiv, primaer, ersatz, aufErsatz, beiAbweisung, taeglichPruefen, stand,
  verfuegbare, listeVergessen,
};
