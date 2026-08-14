// Google-Anmeldung im Panel statt in n8n.
//
// Der Google-Kalender-Knoten von n8n kennt nur OAuth2, und dessen Zustimmungs-
// dialog läuft in der n8n-Oberfläche — genau das soll niemand mehr brauchen.
// Deshalb macht das Panel die Anmeldung selbst, merkt sich den Refresh-Token
// und gibt den Workflows über einen internen Endpunkt einen frischen
// Zugriffs-Token.
const settings = require('./settings');

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BEREICH   = 'https://www.googleapis.com/auth/calendar.events';

function zugangsdaten() {
  const id = settings.hole('google_client_id');
  const secret = settings.hole('google_client_secret');
  if (!id || !secret) {
    throw new Error('Google ist nicht eingerichtet (Einstellungen → Google: Client-ID und Secret).');
  }
  return { id, secret };
}

// Die Rücksprungadresse muss in der Google Cloud Console genauso hinterlegt sein
const rueckkehrAdresse = (req) => {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/google/rueckkehr`;
};

function anmeldeLink(req, state) {
  const { id } = zugangsdaten();
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: rueckkehrAdresse(req),
    response_type: 'code',
    scope: BEREICH,
    access_type: 'offline',       // nur so kommt ein Refresh-Token zurück
    prompt: 'consent',            // erzwingt ihn auch bei erneuter Anmeldung
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenTauschen(code, req) {
  const { id, secret } = zugangsdaten();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: rueckkehrAdresse(req),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const daten = await res.json();
  if (!res.ok) throw new Error(daten.error_description || daten.error || `Google antwortete mit ${res.status}`);
  if (!daten.refresh_token) {
    throw new Error('Google hat keinen Refresh-Token geschickt. Entziehe dem Panel den Zugriff im Google-Konto und melde dich neu an.');
  }
  settings.setze('google_refresh_token', daten.refresh_token);
  return true;
}

// Frischen Zugriffs-Token holen — den fragen die Workflows beim Panel ab
async function zugriffsToken() {
  const { id, secret } = zugangsdaten();
  const refresh = settings.hole('google_refresh_token');
  if (!refresh) throw new Error('Noch nicht mit Google verbunden (Einstellungen → Google).');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const daten = await res.json();
  if (!res.ok) throw new Error(daten.error_description || daten.error || `Google antwortete mit ${res.status}`);
  return { access_token: daten.access_token, gueltig_bis: Date.now() + (daten.expires_in || 3600) * 1000 };
}

const istVerbunden = () => Boolean(settings.hole('google_refresh_token'));

module.exports = { anmeldeLink, tokenTauschen, zugriffsToken, istVerbunden, rueckkehrAdresse };
