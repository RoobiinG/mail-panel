// Telegram-Bot — nur so viel, wie das Panel selbst braucht.
//
// Die täglichen Nachrichten verschickt n8n (Workflow 02), nicht das Panel. Genau
// das war das Problem: Bleibt die Nachricht aus, sieht man im Panel nichts und
// in n8n einen grünen Lauf. Denn ein stillgelegter Knoten wird übersprungen,
// ohne einen Fehler zu erzeugen — der Lauf meldet trotzdem Erfolg.
//
// Deshalb kann das Panel hier selbst eine Nachricht schicken. Das ist der
// einzige Weg, die drei Dinge auseinanderzuhalten, die alle gleich aussehen
// („es kommt nichts an"):
//
//   1. Der Bot-Token stimmt nicht        → getMe antwortet 401.
//   2. Die Chat-ID stimmt nicht          → sendMessage antwortet „chat not found".
//   3. Der Chat wurde nie eröffnet       → sendMessage antwortet „bot can't
//      initiate conversation with a user". Ein Bot darf niemanden zuerst
//      anschreiben; im Chat muss einmal /start gedrückt worden sein. Das ist
//      der häufigste Fall und in keinem Log zu sehen.
//
// Der Token steht ausschliesslich in der Adresse (so schreibt Telegram die API
// vor). Er darf deshalb in keiner Fehlermeldung und in keinem Protokoll landen —
// alle Meldungen hier sind von Hand formuliert, nie eine durchgereichte URL.
const settings = require('./settings');

const API = 'https://api.telegram.org';
const ZEITLIMIT_MS = 15000;

function token() {
  return String(settings.hole('telegram_token') || '').trim();
}

function chatId() {
  return String(settings.hole('telegram_chat_id') || '').trim();
}

// Die Platzhalter aus den Workflow-Vorlagen. Steht das noch im Knoten, ist die
// Chat-ID nie eingetragen worden und jede Nachricht geht ins Leere.
const PLATZHALTER = ['DEINE_CHAT_ID', 'DEIN_CHAT_ID', 'CHAT_ID', ''];

const istPlatzhalter = (wert) => PLATZHALTER.includes(String(wert ?? '').trim());

// Eine Telegram-Antwort in einen Satz übersetzen, den man ohne Kenntnis der
// Bot-API lesen kann. Telegrams eigene Texte sind englisch und knapp.
function fehlerText(beschreibung, code) {
  const t = String(beschreibung || '').toLowerCase();
  if (code === 401 || t.includes('unauthorized')) {
    return 'Telegram kennt diesen Bot-Token nicht (401). Steht in den Einstellungen wirklich der '
      + 'Token aus dem BotFather — vollständig, mit dem Doppelpunkt in der Mitte?';
  }
  if (t.includes('chat not found')) {
    return 'Den Chat mit dieser Chat-ID gibt es nicht. Die eigene ID bekommt man, indem man dem '
      + 'Bot eine Nachricht schreibt und https://api.telegram.org/bot<TOKEN>/getUpdates aufruft — '
      + 'dort steht sie unter "chat":{"id":…}.';
  }
  if (t.includes("can't initiate conversation") || t.includes('cant initiate conversation')) {
    return 'Der Bot darf diesen Chat nicht von sich aus anschreiben. Öffne den Bot in Telegram und '
      + 'drücke einmal auf „Start" — danach darf er senden.';
  }
  if (t.includes('bot was blocked')) {
    return 'Der Bot wurde in diesem Chat blockiert. In Telegram entsperren, dann erneut testen.';
  }
  if (t.includes('not enough rights') || t.includes('need administrator')) {
    return 'In dieser Gruppe fehlen dem Bot die Rechte zum Schreiben.';
  }
  // Der Auffangfall reicht Telegrams eigenen Text durch. Der ist harmlos —
  // aber „harmlos, soweit ich weiss" ist beim Weiterreichen fremder Texte keine
  // Grundlage. Was der Token ist, weiss diese Datei; also wird er entfernt.
  return beschreibung
    ? `Telegram meldet: ${tokenTilgen(beschreibung)}`
    : `Telegram antwortete mit HTTP ${code}.`;
}

function tokenTilgen(text) {
  const t = token();
  const s = String(text ?? '');
  return t ? s.split(t).join('•••') : s;
}

async function anfrage(methode, daten) {
  const t = token();
  if (!t) throw new Error('Kein Bot-Token hinterlegt.');

  let antwort;
  try {
    antwort = await fetch(`${API}/bot${t}/${methode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(daten || {}),
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    });
  } catch (err) {
    // Hier steckt der Token in err.message, wenn fetch die Adresse mitzitiert.
    // Deshalb nie err.message durchreichen.
    throw new Error(/abort|timeout/i.test(String(err?.message))
      ? 'Telegram hat innerhalb von 15 Sekunden nicht geantwortet.'
      : 'Telegram war nicht erreichbar (Netzwerk oder DNS).');
  }

  let rumpf = null;
  try { rumpf = await antwort.json(); } catch { rumpf = null; }
  if (!antwort.ok || !rumpf || rumpf.ok === false) {
    throw new Error(fehlerText(rumpf?.description, antwort.status));
  }
  return rumpf.result;
}

/** Wer ist dieser Bot? Prüft nur den Token, verschickt nichts. */
async function botPruefen() {
  const me = await anfrage('getMe', {});
  return { name: me?.first_name || 'Bot', benutzername: me?.username || null };
}

/**
 * Eine Nachricht senden — der Weg, den auch Workflow 02 nimmt.
 * @param {string} text
 * @param {string} [ziel] Abweichende Chat-ID; sonst die aus den Einstellungen.
 */
async function sendeNachricht(text, ziel) {
  const chat = String(ziel || chatId()).trim();
  if (!chat) throw new Error('Keine Chat-ID hinterlegt.');
  await anfrage('sendMessage', { chat_id: chat, text: String(text || '').slice(0, 4000) });
  return { ok: true };
}

/**
 * Der Test für die Einstellungsseite: erst der Token, dann eine echte Nachricht.
 * In zwei Schritten, weil sonst jeder Fehler wie ein Token-Fehler aussieht.
 */
async function testVerbindung() {
  if (!token()) throw new Error('Kein Bot-Token hinterlegt — Feld oben ausfüllen und speichern.');
  if (!chatId()) throw new Error('Keine Chat-ID hinterlegt — Feld oben ausfüllen und speichern.');

  const bot = await botPruefen();
  const zeit = new Date().toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
  await sendeNachricht(`Mail-Panel: Testnachricht vom ${zeit}. Wenn du das liest, funktioniert der tägliche Digest.`);

  return {
    ok: true,
    hinweis: `Nachricht an @${bot.benutzername || bot.name} zugestellt — schau in Telegram nach.`,
  };
}

module.exports = {
  sendeNachricht, testVerbindung, botPruefen, istPlatzhalter, PLATZHALTER,
};
