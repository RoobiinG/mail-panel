// Eine einzelne Frage an die lokale KI (Ollama), Antwort als JSON.
const settings = require('./settings');
const { loggen } = require('./panelLog');
const schlange = require('./ollamaSchlange');
const messung = require('./ollamaMessung');
const fetchMitAuth = require('./fetchAuth');

const KONTEXT_STANDARD = 8192;
const KONTEXT_MIN = 2048;
const KONTEXT_MAX = 32768;

const ZEICHEN_JE_TOKEN = 3;

function kontextFenster() {
  const n = Number(settings.hole('ollama_kontext'));
  if (!Number.isFinite(n) || n <= 0) return KONTEXT_STANDARD;
  return Math.min(KONTEXT_MAX, Math.max(KONTEXT_MIN, Math.round(n)));
}

function promptPlatz(kontext = kontextFenster(), antwortTokens = 1500) {
  const frei = Math.max(512, kontext - antwortTokens - Math.round(kontext / 8));
  return frei * ZEICHEN_JE_TOKEN;
}

const MAIL_MARKE = '--- E-Mails ---';
const BLOCK_TRENNER = /\n(?=\[\d+\]\n)/;

function promptKuerzen(ganz, platz) {
  if (ganz.length <= platz) {
    return { text: ganz, weggefallen: 0, gesamt: 0, kopfZuGross: false };
  }

  const marke = ganz.indexOf(MAIL_MARKE);
  if (marke < 0) {
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

async function frageJson(prompt, opt = {}) {
  const quelle = opt.quelle || 'backend:kiText';
  let rohtext = '';
  let grund = '';
  let gedanken = 0;

  const ollamaUrl = (settings.hole('ollama_url') || 'http://ollama:11434').replace(/\/$/, '') + '/api/generate';
  const ollamaModell = settings.hole('ollama_modell') || 'llama3.1';
  const zeitlimit = opt.zeitlimit || 120000;
  const antwortTokens = opt.maxAntwort || 1500;
  const kontext = kontextFenster();

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

  let angefangen = 0;
  const angestelltUm = Date.now();

  try {
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
          num_predict: antwortTokens,
          num_thread: Number(settings.hole('ollama_threads') || 6),
        },
      }),
      signal: AbortSignal.timeout(Math.max(10000, restFrist)),
    }); }, wartenMaxMs);

    if (!res.ok) {
      const text = (await res.text()).slice(0, 400);
      loggen('warn', quelle, `Ollama antwortete mit ${res.status}: ${text}`);
      // Ein 504 ist die Zeitgrenze des Proxys. Ein 502 dagegen kommt meist nach
      // Millisekunden — Ollama startet neu oder ist ohne Speicher gestorben — und
      // sagt über die Größe des Bündels gar nichts. Als Gateway-Abbruch gezählt,
      // halbierte er die Bündelgröße und drückte die gemessene „Proxy-Grenze"
      // auf fast null. Nur ein 502, der selbst lange gedauert hat, ist einer.
      const dauerSek = Math.round((Date.now() - angefangen) / 100) / 10;
      const istGateway = res.status === 504 || (res.status === 502 && dauerSek >= 30);
      if (istGateway) {
        messung.merken(messung.abbruch(
          ollamaModell, dauerSek,
          `Gateway-Zeitüberschreitung (${res.status}) — vermutlich ein Reverse-Proxy vor Ollama`,
          'gateway', opt.mails,
        ));
      }
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

    const k = messung.kennzahlen(daten, ollamaModell, opt.mails);
    messung.merken(k);
    loggen('info', quelle, messung.satz(k));
  } catch (err) {
    if (angefangen) {
      messung.merken(messung.abbruch(
        ollamaModell, Math.round((Date.now() - angefangen) / 100) / 10, err.message, 'netzwerk', opt.mails,
      ));
    }
    loggen('warn', quelle, `Ollama nicht erreichbar: ${err.message}`);
    return { ok: false, fehler: `Ollama war nicht erreichbar: ${err.message}` };
  }

  try {
    return { ok: true, daten: JSON.parse(String(rohtext).replace(/```json|```/g, '').trim()) };
  } catch {
    const warum = (grund === 'MAX_TOKENS' || grund === 'length')
      ? `Die Antwort war abgeschnitten (${grund}${gedanken ? `, ${gedanken} Token fürs Nachdenken` : ''}). `
        + 'Kleinere Bündel helfen.'
      : `Die Antwort der KI war nicht lesbar${grund ? ` (${grund})` : ''}.`;
    loggen('warn', quelle, warum);
    return { ok: false, fehler: warum, abgeschnitten: (grund === 'MAX_TOKENS' || grund === 'length') };
  }
}

module.exports = {
  frageJson, kontextFenster, promptPlatz, promptKuerzen, KONTEXT_STANDARD, MAIL_MARKE,
};
