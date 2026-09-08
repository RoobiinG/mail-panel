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

// Wie viel darf das Modell nachdenken?
//
// Gemini 3.7 und 3.8 Flash denken von Haus aus — und zahlen das aus demselben
// Ausgabebudget, aus dem die Antwort kommt. Für eine Einstufung ist das
// verschenkt: „Ist das ein Newsletter?" braucht keine Gedankenkette. Im Betrieb
// kam deshalb `content: {}` mit `finishReason: MAX_TOKENS` zurück — das Modell
// hatte nachgedacht und nichts gesagt. Die Läufe meldeten „erfolgreich" und
// sortierten keine einzige Mail.
//
// Leer = Feld gar nicht mitschicken (für Modelle, die es nicht kennen).
function denkstufeAbschalten() {
  try { settings.setze('gemini_denkstufe', 'aus'); } catch { /* dann eben beim naechsten Mal */ }
}

function denkstufe() {
  const wert = String(settings.hole('gemini_denkstufe') ?? 'low').trim().toLowerCase();
  return ['minimal', 'low', 'medium', 'high'].includes(wert) ? wert : '';
}

/**
 * @param {string} prompt
 * @param {{zeitlimit?: number, quelle?: string}} opt
 * @returns {Promise<{ok: true, daten: any} | {ok: false, fehler: string}>}
 */
async function frageJson(prompt, opt = {}) {
  const kiAnbieter = settings.hole('ki_anbieter') || 'gemini';
  const quelle = opt.quelle || 'backend:kiText';
  let rohtext = '';
  let grund = '';
  let gedanken = 0;

  if (kiAnbieter === 'ollama') {
    const ollamaUrl = (settings.hole('ollama_url') || 'http://ollama:11434').replace(/\/$/, '') + '/api/generate';
    const ollamaModell = settings.hole('ollama_modell') || 'llama3.1';
    
    try {
      const res = await fetch(ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModell,
          prompt: String(prompt).slice(0, opt.maxZeichen || 12000),
          stream: false,
          format: 'json',
          options: {
            temperature: 0.2,
            // Deutlich weniger als bei Gemini. Dort kostet ein grosszuegiges
            // Budget nichts, solange die Antwort kurz ausfaellt — hier rechnet
            // die eigene Maschine jedes einzelne Token. 8192 Token sind auf
            // einer CPU eine Viertelstunde; die Antwort auf ein Buendel von
            // fuenf Mails braucht keine 1500.
            num_predict: opt.maxAntwort || 1500,
          },
        }),
        signal: AbortSignal.timeout(opt.zeitlimit || 120000),
      });
      
      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        loggen('warn', quelle, `Ollama antwortete mit ${res.status}: ${text}`);
        return { ok: false, fehler: `Ollama antwortete mit ${res.status}. Läuft der Container?` };
      }
      
      const daten = await res.json();
      rohtext = daten?.response || '';
      grund = daten?.done_reason || (daten?.done ? 'STOP' : '');
    } catch (err) {
      loggen('warn', quelle, `Ollama nicht erreichbar: ${err.message}`);
      return { ok: false, fehler: `Ollama war nicht erreichbar: ${err.message}` };
    }
  } else {
    const key = settings.hole('gemini_api_key');
    if (!key) return { ok: false, fehler: 'Kein Gemini-Schlüssel hinterlegt (Einstellungen → KI).' };

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${kiModell.aktiv()}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: String(prompt).slice(0, opt.maxZeichen || 12000) }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: opt.maxAntwort || 8192,
              ...(denkstufe() ? { thinking_level: denkstufe() } : {}),
            },
          }),
          signal: AbortSignal.timeout(opt.zeitlimit || 30000),
        },
      );
      if (res.status === 429) {
        let meldung = '';
        try { meldung = (await res.text()).slice(0, 2000); } catch { /* dann eben ohne */ }
        const kontingent = require('./kiKontingent');
        try { kontingent.abweisungMerken(new Date().toISOString(), meldung); } catch { /* egal */ }
        const gelesen = kontingent.limitAusMeldung(meldung);
        return {
          ok: false,
          kontingent: true,
          proMinute: gelesen.proMinute,
          wartenMs: gelesen.wartenMs,
          fehler: gelesen.proMinute
            ? 'Google hat abgewiesen — zu viele Anfragen pro Minute.'
            : 'Google hat abgewiesen — das Tageskontingent ist aufgebraucht.',
        };
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        if (res.status === 400 && /thinking/i.test(text) && !opt.ohneDenkstufe) {
          loggen('info', quelle,
            `Das Modell kennt die Denkstufe nicht — ab jetzt ohne. Googles Antwort: ${text.slice(0, 150)}`);
          denkstufeAbschalten();
          return frageJson(prompt, { ...opt, ohneDenkstufe: true });
        }
        loggen('warn', quelle, `Gemini antwortete mit ${res.status}: ${text}`);
        return { ok: false, fehler: `Gemini antwortete mit ${res.status}. Stimmt der Schlüssel?` };
      }
      const daten = await res.json();
      grund = daten?.candidates?.[0]?.finishReason || '';
      gedanken = daten?.usageMetadata?.thoughtsTokenCount || 0;
      rohtext = daten?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      loggen('warn', quelle, `Gemini nicht erreichbar: ${err.message}`);
      return { ok: false, fehler: `Gemini war nicht erreichbar: ${err.message}` };
    }
  }

  try {
    return { ok: true, daten: JSON.parse(String(rohtext).replace(/```json|```/g, '').trim()) };
  } catch {
    const warum = (grund === 'MAX_TOKENS' || grund === 'length')
      ? `Die Antwort war abgeschnitten (${grund}${gedanken ? `, ${gedanken} Token fürs Nachdenken` : ''}). `
        + 'Kleinere Bündel oder eine niedrigere Denkstufe helfen.'
      : `Die Antwort der KI war nicht lesbar${grund ? ` (${grund})` : ''}.`;
    loggen('warn', quelle, warum);
    return { ok: false, fehler: warum, abgeschnitten: (grund === 'MAX_TOKENS' || grund === 'length') };
  }
}

module.exports = { frageJson };
