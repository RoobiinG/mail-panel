// Eine einzelne Frage an Gemini, Antwort als JSON.
//
// Für die kleinen Hilfen im Panel, die keine Mail klassifizieren: eine
// Ordner-Beschreibung formulieren, eine Absenderliste in Kategorien gruppieren.
// Sie laufen auf Knopfdruck, kosten je einen Aufruf und sehen nie einen
// Mailtext — nur Namen und Absenderadressen.
//
// Der Aufruf ist derselbe wie in services/aktionenKi.js (Aktions-Entwurf); hier
// steht er ohne das dortige Schema, damit beide Seiten unabhängig bleiben.
const settings = require('./settings');
const { loggen } = require('./panelLog');

// Dasselbe Modell wie in den Workflows und im Beleg-Leser — welches das ist,
// entscheidet services/kiModell.js. Damit folgt auch dieser Aufruf einem Wechsel
// auf das Ersatzmodell, wenn Googles Tageskontingent aufgebraucht ist.
const kiModell = require('./kiModell');

/**
 * @param {string} prompt
 * @param {{zeitlimit?: number, quelle?: string}} opt
 * @returns {Promise<{ok: true, daten: any} | {ok: false, fehler: string}>}
 */
async function frageJson(prompt, opt = {}) {
  const key = settings.hole('gemini_api_key');
  if (!key) return { ok: false, fehler: 'Kein Gemini-Schlüssel hinterlegt (Einstellungen → KI).' };

  const quelle = opt.quelle || 'backend:kiText';
  let rohtext = '';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${kiModell.aktiv()}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          // Die Kappung schützt vor einem versehentlich riesigen Prompt. Ein
          // Bündel aus 20 Mails ist aber legitim groß — deshalb einstellbar,
          // statt still die halbe Anfrage abzuschneiden.
          contents: [{ parts: [{ text: String(prompt).slice(0, opt.maxZeichen || 12000) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(opt.zeitlimit || 30000),
      },
    );
    // Eine Abweisung wegen Kontingent zählt auch hier: Sie sagt dasselbe wie
    // drüben in n8n — für heute ist Schluss (siehe services/kiKontingent.js).
    //
    // Der Antworttext geht mit: Darin steht Googles eigenes Limit
    // („limit: 500, model: …"), und das ist die einzige harte Zahl, die je zu
    // bekommen ist. Ohne sie bliebe nur die eigene, zu niedrige Zählung.
    if (res.status === 429) {
      let meldung = '';
      try { meldung = (await res.text()).slice(0, 2000); } catch { /* dann eben ohne */ }
      const kontingent = require('./kiKontingent');
      // Merkt nur ein echtes Tageslimit — ein Minutenlimit laesst es liegen.
      try { kontingent.abweisungMerken(new Date().toISOString(), meldung); } catch { /* egal */ }
      const gelesen = kontingent.limitAusMeldung(meldung);
      return {
        ok: false,
        // Damit der Aufrufer die drei Faelle auseinanderhalten kann: Bei einem
        // Tageslimit ist Weitermachen sinnlos, bei einem Minutenlimit lohnt sich
        // kurz warten, alles andere ist ein gewoehnlicher Fehler.
        kontingent: true,
        proMinute: gelesen.proMinute,
        wartenMs: gelesen.wartenMs,
        fehler: gelesen.proMinute
          ? 'Google hat abgewiesen — zu viele Anfragen pro Minute.'
          : 'Google hat abgewiesen — das Tageskontingent ist aufgebraucht.',
      };
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      loggen('warn', quelle, `Gemini antwortete mit ${res.status}: ${text}`);
      return { ok: false, fehler: `Gemini antwortete mit ${res.status}. Stimmt der Schlüssel?` };
    }
    const daten = await res.json();
    rohtext = daten?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    loggen('warn', quelle, `Gemini nicht erreichbar: ${err.message}`);
    return { ok: false, fehler: `Gemini war nicht erreichbar: ${err.message}` };
  }

  try {
    return { ok: true, daten: JSON.parse(String(rohtext).replace(/```json|```/g, '').trim()) };
  } catch {
    return { ok: false, fehler: 'Die Antwort der KI war nicht lesbar. Versuch es noch einmal.' };
  }
}

module.exports = { frageJson };
