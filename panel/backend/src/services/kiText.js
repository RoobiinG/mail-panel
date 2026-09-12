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
const schlange = require('./ollamaSchlange');
const messung = require('./ollamaMessung');
const fetchMitAuth = require('./fetchAuth');

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

// ─── Wie viel passt in eine Ollama-Anfrage? ──────────────────────────────────
//
// Gemini nimmt entgegen, was kommt, und sagt hinterher „MAX_TOKENS", wenn die
// ANTWORT nicht mehr passte. Ollama arbeitet umgekehrt: Es hat ein festes
// Fenster für Frage und Antwort zusammen, und was vorne nicht hineinpasst,
// fällt heraus — ohne Fehler, ohne Hinweis, ohne Merkmal in der Antwort.
//
// Genau das war im Betrieb zu sehen: Anfragen liefen minutenlang und kamen mit
// „Kein Thema erkannt" und Konfidenz 0 zurück. Das Modell hatte die Anweisung
// nie gelesen, nur den letzten Rest der Mailliste.
const KONTEXT_STANDARD = 8192;
const KONTEXT_MIN = 2048;
const KONTEXT_MAX = 32768;

// Ein Token sind bei deutschen Mailtexten grob drei Zeichen — großzügig
// gerechnet, damit die Grenze eher zu früh greift als zu spät. Lieber der
// eigene Hinweis im Log als Ollamas stiller Schnitt.
const ZEICHEN_JE_TOKEN = 3;

function kontextFenster() {
  const n = Number(settings.hole('ollama_kontext'));
  if (!Number.isFinite(n) || n <= 0) return KONTEXT_STANDARD;
  return Math.min(KONTEXT_MAX, Math.max(KONTEXT_MIN, Math.round(n)));
}

/** Wie viele Zeichen der Prompt haben darf, wenn die Antwort noch Platz braucht. */
function promptPlatz(kontext = kontextFenster(), antwortTokens = 1500) {
  // Ein Achtel Sicherheitsabstand: Der Zeichen-je-Token-Schätzwert ist ein
  // Schätzwert, und ein abgeschnittener Prompt kostet die ganze Anfrage.
  const frei = Math.max(512, kontext - antwortTokens - Math.round(kontext / 8));
  return frei * ZEICHEN_JE_TOKEN;
}

// ─── Kürzen, ohne die Frage zu verlieren ─────────────────────────────────────
//
// Ein Klassifizier-Prompt besteht aus zwei sehr ungleichen Teilen: vorn die
// Anweisung — Aufgabe, Antwortformat, erlaubte Kategorien, Themen-Ordner —, und
// hinter der Marke das Material, ein nummerierter Block je Mail.
//
// Bis Build 186 kürzte hier ein blankes `slice(0, platz)`. Das schneidet hinten
// ab, also genau die Mails weg. Der Kommentar daneben begründete das mit dem
// Gegenteil ("Ollama würde am Anfang abschneiden, wo die Anweisung steht") — und
// das Ergebnis war der schlechteste denkbare Prompt: vollständige Anweisungen zu
// Mails, die nicht mehr dastehen, oder zu einer, die mitten im Satz endet. Das
// Modell beantwortete daraufhin Mails, die es nie gesehen hatte; im Log standen
// erfundene Nummern wie `nr: [12345, 67890]`.
//
// Richtig ist die andere Richtung: Die Anweisung bleibt vollständig, und es
// fallen ganze Mails weg. Was wegfällt, bleibt unklassifiziert und kommt im
// nächsten Lauf wieder — das ist der eingebaute Weg (services/bestand.js), nur
// diesmal ohne falsche Antworten.
const MAIL_MARKE = '--- E-Mails ---';
const BLOCK_TRENNER = /\n(?=\[\d+\]\n)/;

function promptKuerzen(ganz, platz) {
  if (ganz.length <= platz) {
    return { text: ganz, weggefallen: 0, gesamt: 0, kopfZuGross: false };
  }

  const marke = ganz.indexOf(MAIL_MARKE);
  if (marke < 0) {
    // Kein bekannter Aufbau (Beleg-Leser, Aktions-Entwurf): Da lässt sich nicht
    // sagen, was vorn und was hinten steht — dann bleibt es beim harten Schnitt.
    return { text: ganz.slice(0, platz), weggefallen: 0, gesamt: 0, kopfZuGross: false };
  }

  const trenn = marke + MAIL_MARKE.length;
  const kopf = ganz.slice(0, trenn);
  const bloecke = ganz.slice(trenn).split(BLOCK_TRENNER).filter((b) => b.trim() !== '');

  let text = kopf;
  let genommen = 0;
  for (const block of bloecke) {
    const kandidat = `${text}\n${block}`;
    if (kandidat.length > platz) break;
    text = kandidat;
    genommen += 1;
  }

  // Nicht einmal die erste Mail passt hinter die Anweisung. Dann ist das
  // Kontextfenster für diese Aufgabe zu klein — eine angeschnittene Mail ist
  // hier immer noch besser als gar keine, aber es gehört gesagt.
  if (genommen === 0) {
    return {
      text: `${kopf}\n${bloecke[0] || ''}`.slice(0, platz),
      weggefallen: Math.max(0, bloecke.length - 1),
      gesamt: bloecke.length,
      kopfZuGross: true,
    };
  }

  return {
    text,
    weggefallen: bloecke.length - genommen,
    gesamt: bloecke.length,
    kopfZuGross: false,
  };
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
    const zeitlimit = opt.zeitlimit || 120000;
    const antwortTokens = opt.maxAntwort || 1500;
    const kontext = kontextFenster();

    // Was nicht ins Fenster passt, wirft Ollama weg — schweigend, und zwar vorn,
    // wo die Anweisung steht. Also kürzt das Panel selbst: siehe promptKuerzen().
    const platz = Math.min(promptPlatz(kontext, antwortTokens), opt.maxZeichen || Infinity);
    const ganz = String(prompt);
    const schnitt = promptKuerzen(ganz, platz);
    const gekuerzt = schnitt.text;
    if (ganz.length > gekuerzt.length) {
      const was = schnitt.gesamt > 0
        ? `${schnitt.weggefallen} von ${schnitt.gesamt} Mails fielen weg — die Anweisung bleibt vollständig`
        : 'der Text wurde hinten abgeschnitten';
      loggen('warn', quelle,
        `Der Prompt war ${ganz.length} Zeichen lang und musste auf ${gekuerzt.length} gekürzt werden `
        + `(Kontextfenster ${kontext} Token): ${was}. Was wegfiel, bleibt unklassifiziert und kommt `
        + 'im nächsten Lauf wieder. Kleinere Bündel oder ein größeres Kontextfenster '
        + '(Einstellungen → KI) helfen.');
      if (schnitt.kopfZuGross) {
        loggen('warn', quelle,
          'Schon die Anweisung allein füllt das Kontextfenster — für eine einzelne Mail bleibt kaum '
          + `Platz. Bei ${kontext} Token hilft nur ein größeres Fenster oder weniger Themen-Ordner `
          + 'im Prompt.');
      }
    }

    // Wann die Anfrage wirklich losging — nicht, wann sie sich angestellt hat.
    // Bleibt 0, wenn die Warteschlange sie gar nicht erst durchgelassen hat;
    // dann ist es keine Messung an Ollama und gehört nicht in die Statistik.
    let angefangen = 0;
    const angestelltUm = Date.now();

    try {
      // Eine Anfrage zur Zeit — siehe services/ollamaSchlange.js.
      // Wir lassen bis zu 80% des Limits fürs Warten zu; die restliche Zeit (mindestens 20%) 
      // muss für die Anfrage selbst reichen.
      const wartenMaxMs = Math.round(zeitlimit * 0.8);
      const res = await schlange.nacheinander(() => { 
        angefangen = Date.now(); 
        const restFrist = zeitlimit - (angefangen - angestelltUm);
        return fetchMitAuth(ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModell,
          prompt: gekuerzt,
          stream: false,
          format: opt.schema || 'json',
          options: {
            temperature: 0.2,
            repeat_penalty: 1.1,
            num_ctx: kontext,
            // Genau so viel, wie der Aufrufer angefordert hat. Vorher stand hier
            // `Math.max(800, …)` — eine Untergrenze, die niemand brauchte: Zwei
            // Mails ergeben rund 80 Token Antwort. Die 800 waren doppelt teuer,
            // weil promptPlatz() sie oben vom Prompt abzieht: Sie kosteten rund
            // 2.000 Zeichen Material und gaben dem Modell zugleich den Raum,
            // sinnlos weiterzuschreiben, bis die Antwort als „length" abbrach.
            num_predict: antwortTokens,
            num_thread: Number(settings.hole('ollama_threads') || 6),
          },
        }),
        signal: AbortSignal.timeout(Math.max(10000, restFrist)),
      }); }, wartenMaxMs);

      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        loggen('warn', quelle, `Ollama antwortete mit ${res.status}: ${text}`);
        const istGateway = res.status === 504 || res.status === 502;
        return {
          ok: false,
          gatewayTimeout: istGateway,
          status: res.status,
          fehler: istGateway
            ? `Ollama antwortete mit ${res.status} (Gateway Timeout/Proxy — Anfrage dauerte zu lange).`
            : `Ollama antwortete mit ${res.status}. Läuft der Container?`,
        };
      }

      const daten = await res.json();
      rohtext = daten?.response || '';
      grund = daten?.done_reason || (daten?.done ? 'STOP' : '');

      // Ollamas eigene Kennzahlen mitnehmen — siehe services/ollamaMessung.js.
      // Ohne sie steht am Ende wieder nur „hat nicht geantwortet" im Log, und
      // die Frage, ob es am Prompt oder am Modell liegt, bleibt offen.
      const k = messung.kennzahlen(daten, ollamaModell);
      messung.merken(k);
      loggen('info', quelle, messung.satz(k));
    } catch (err) {
      if (angefangen) {
        messung.merken(messung.abbruch(
          ollamaModell, Math.round((Date.now() - angefangen) / 100) / 10, err.message,
        ));
      }
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

module.exports = {
  frageJson, kontextFenster, promptPlatz, promptKuerzen, KONTEXT_STANDARD, MAIL_MARKE,
};
