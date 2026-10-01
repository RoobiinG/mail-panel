// Direktnachrichten über einen Discord-Bot — für Einmalcodes der Zwei-Faktor-Anmeldung.
//
// Es gibt zwei Wege, einen Bot zu hinterlegen: einen für das ganze Panel
// (Einstellungen → discord_bot_token) oder einen eigenen je Benutzer. Welcher
// gilt, entscheidet der Aufrufer (services/zweifaktor.js); hier kommt nur ein Token an.
//
// Ablauf laut Discord-API: Erst einen Direktnachrichten-Kanal zum Benutzer öffnen
// (POST /users/@me/channels), dann dort eine Nachricht senden.
const API = () => (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/$/, '');

// Eine Discord-User-ID ist eine „Snowflake": 17–20 Ziffern. (Etwas großzügiger
// geprüft, damit auch sehr alte und künftige IDs durchgehen.)
const istBenutzerId = (text) => /^\d{15,22}$/.test(String(text == null ? '' : text));

// Ein Bot-Token besteht aus drei Teilen mit Punkten: ID, Zeit, Signatur.
const sieheAusWieToken = (text) => /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(String(text == null ? '' : text).trim());

const KOPF = (token) => ({
  Authorization: `Bot ${String(token).trim()}`,
  'Content-Type': 'application/json',
  'User-Agent': 'DiscordBot (mail-panel, 1)',
});

// Übersetzt die Antworten der API in etwas, womit ein Mensch etwas anfangen kann.
async function fehlerAus(res, was) {
  let koerper = null;
  try { koerper = await res.json(); } catch { /* kein JSON */ }
  const code = koerper?.code;

  if (res.status === 401) return new Error('Discord lehnt den Bot-Token ab — stimmt er?');
  if (res.status === 429) return new Error('Discord bremst gerade (zu viele Anfragen) — bitte kurz warten.');
  // 50007: „Cannot send messages to this user". Der häufigste Fall: Der Bot teilt
  // keinen Server mit dem Benutzer, oder dieser hat Direktnachrichten gesperrt.
  if (code === 50007 || (res.status === 403 && was === 'nachricht')) {
    return new Error(
      'Discord erlaubt dem Bot keine Direktnachricht an dich. Dazu muss der Bot mit dir einen Server teilen, '
      + 'und in deinen Discord-Datenschutzeinstellungen müssen Direktnachrichten von Servermitgliedern erlaubt sein.',
    );
  }
  if (res.status === 404 || code === 10013) return new Error('Discord kennt diese Benutzer-ID nicht.');
  if (res.status === 400) return new Error('Discord hat die Anfrage abgelehnt — ist die Benutzer-ID richtig?');
  return new Error(`Discord antwortete mit ${res.status}.`);
}

/**
 * Schickt einem Benutzer eine Direktnachricht.
 * @param {object} p
 * @param {string} p.token  Bot-Token
 * @param {string} p.userId Discord-User-ID
 * @param {string} p.text
 */
async function dmSenden({ token, userId, text }) {
  if (!token) throw new Error('Kein Discord-Bot hinterlegt.');
  if (!istBenutzerId(userId)) throw new Error('Die Discord-Benutzer-ID besteht aus 17 bis 20 Ziffern.');

  let kanal;
  try {
    kanal = await fetch(`${API()}/users/@me/channels`, {
      method: 'POST',
      headers: KOPF(token),
      body: JSON.stringify({ recipient_id: String(userId) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Discord nicht erreichbar: ${err.message}`);
  }
  if (!kanal.ok) throw await fehlerAus(kanal, 'kanal');
  const kanalId = (await kanal.json())?.id;
  if (!kanalId || !/^\d+$/.test(String(kanalId))) throw new Error('Discord lieferte keinen Kanal zurück.');

  let nachricht;
  try {
    nachricht = await fetch(`${API()}/channels/${kanalId}/messages`, {
      method: 'POST',
      headers: KOPF(token),
      // Keine Erwähnungen auslösen, egal was im Text steht.
      body: JSON.stringify({ content: String(text).slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Discord nicht erreichbar: ${err.message}`);
  }
  if (!nachricht.ok) throw await fehlerAus(nachricht, 'nachricht');
  return { ok: true };
}

module.exports = { dmSenden, istBenutzerId, sieheAusWieToken };
