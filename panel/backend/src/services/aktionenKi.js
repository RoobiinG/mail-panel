// Übersetzt eine Beschreibung in normaler Sprache in einen Aktions-Entwurf.
//
// Die KI füllt nur ein festes Schema aus (siehe aktionenSchema.js) — sie schreibt
// kein Workflow-JSON. Was sie liefert, läuft anschließend durch dieselbe Prüfung
// wie ein von Hand ausgefülltes Formular und wird dem Nutzer zur Bestätigung
// gezeigt. Versteht sie etwas falsch, sieht man es also, bevor etwas passiert.
const settings = require('./settings');
const schema   = require('./aktionenSchema');
const { loggen } = require('./panelLog');

const MODELL = 'gemini-2.5-flash-lite';

function promptBauen(beschreibung) {
  const s = schema.beschreibung();
  const felder = Object.entries(s.felder)
    .map(([k, f]) => `  ${k} (${f.label}${f.werte ? ': ' + f.werte.join('|') : ''})`)
    .join('\n');
  const vergleiche = Object.entries(s.vergleiche).map(([k, v]) => `  ${k} (${v.label})`).join('\n');
  const typen = Object.entries(s.typen)
    .map(([k, t]) => `  ${k} (${t.label}) — Felder: ${Object.keys(t.felder).join(', ')}`)
    .join('\n');

  return `Du hilfst beim Einrichten einer E-Mail-Automatisierung. Wandle die Beschreibung des
Nutzers in genau ein JSON-Objekt um. Antworte NUR mit dem JSON, ohne Erklärung.

Format:
{
  "name": "kurzer Name der Regel",
  "typ": "einer der Aktionstypen",
  "bedingung": { "verknuepfung": "und|oder", "regeln": [ {"feld": "...", "vergleich": "...", "wert": "..."} ] },
  "konfig": { ... Felder des gewählten Typs ... },
  "rueckfrage": "nur setzen, wenn die Beschreibung zu unklar ist"
}

Erlaubte Felder für Bedingungen:
${felder}

Erlaubte Vergleiche:
${vergleiche}

Erlaubte Aktionstypen:
${typen}

In Textfeldern sind diese Platzhalter erlaubt: ${s.platzhalter.join(' ')}

Regeln:
- Erfinde keine Feldnamen, Vergleiche oder Aktionstypen. Nur die obigen sind gültig.
- Nenne mindestens eine Bedingung. Wenn der Nutzer keine nennt, leite eine sinnvolle ab.
- Geht es um Anhänge, setze zusätzlich die Bedingung hat_anhang / ist_wahr.
- Bei Jahres- oder Datumsangaben im Pfad nimm Platzhalter statt fester Zahlen.
- Ist unklar, was gemeint ist, fülle so viel wie möglich aus und setze "rueckfrage".

Beschreibung des Nutzers:
${beschreibung}`;
}

/**
 * @returns {Promise<{ok: boolean, aktion?: object, rueckfrage?: string, fehler?: string[]}>}
 */
async function entwurfBauen(beschreibung) {
  const key = settings.hole('gemini_api_key');
  if (!key) {
    return { ok: false, fehler: ['Kein Gemini-Schlüssel hinterlegt (Einstellungen → Gemini API-Key).'] };
  }
  if (!beschreibung || String(beschreibung).trim().length < 5) {
    return { ok: false, fehler: ['Bitte beschreibe in einem Satz, was passieren soll.'] };
  }

  let rohtext = '';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptBauen(String(beschreibung).slice(0, 1000)) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      loggen('warn', 'backend:aktionenKi', `Gemini antwortete mit ${res.status}: ${text}`);
      return { ok: false, fehler: [`Gemini antwortete mit ${res.status}. Stimmt der Schlüssel?`] };
    }
    const daten = await res.json();
    rohtext = daten?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    loggen('warn', 'backend:aktionenKi', `Gemini nicht erreichbar: ${err.message}`);
    return { ok: false, fehler: [`Gemini war nicht erreichbar: ${err.message}`] };
  }

  let entwurf;
  try {
    entwurf = JSON.parse(String(rohtext).replace(/```json|```/g, '').trim());
  } catch {
    return { ok: false, fehler: ['Die Antwort der KI war nicht lesbar. Versuch es noch einmal oder trage die Regel von Hand ein.'] };
  }

  const geprueft = schema.pruefe(entwurf);
  if (!geprueft.ok) {
    return { ok: false, fehler: geprueft.fehler, rueckfrage: entwurf.rueckfrage || null, roh: entwurf };
  }
  return { ok: true, aktion: geprueft.aktion, rueckfrage: entwurf.rueckfrage || null };
}

module.exports = { entwurfBauen };
