// Eine Stelle für alles rund um die Anmeldung. Vorher lag das Token an vier
// Stellen im localStorage verstreut, und ob es noch gültig war, hat niemand
// geprüft — man blieb scheinbar angemeldet und bekam nur noch Fehler.
//
// Zwei Ablagen:
//   localStorage   — „Angemeldet bleiben": übersteht das Schließen des Browsers
//   sessionStorage — Standard: gilt nur für diesen Tab, danach ist Schluss
//
// Geprüft wird trotzdem immer im Backend. Das hier ist nur die Kür, damit die
// Oberfläche nicht erst auf einen fehlgeschlagenen Aufruf warten muss.

const SCHLUESSEL = 'token';
const GRUND_SCHLUESSEL = 'abmeldegrund';

/** Wo das Token liegt — je nachdem, ob „Angemeldet bleiben" gewählt war. */
function ablage() {
  return localStorage.getItem(SCHLUESSEL) ? localStorage : sessionStorage;
}

export function token() {
  return localStorage.getItem(SCHLUESSEL) || sessionStorage.getItem(SCHLUESSEL) || null;
}

export function tokenSetzen(neu, angemeldetBleiben) {
  localStorage.removeItem(SCHLUESSEL);
  sessionStorage.removeItem(SCHLUESSEL);
  (angemeldetBleiben ? localStorage : sessionStorage).setItem(SCHLUESSEL, neu);
  sessionStorage.removeItem(GRUND_SCHLUESSEL);
}

export function tokenLoeschen() {
  localStorage.removeItem(SCHLUESSEL);
  sessionStorage.removeItem(SCHLUESSEL);
}

/** Nutzlast des JWT, ohne Signaturprüfung — die macht das Backend. */
export function nutzlast(wert = token()) {
  if (!wert) return null;
  try {
    return JSON.parse(atob(wert.split('.')[1]));
  } catch {
    return null;
  }
}

/** Millisekunden bis zum Ablauf. 0 heißt: abgelaufen oder unlesbar. */
export function restlaufzeit(wert = token()) {
  const daten = nutzlast(wert);
  if (!daten?.exp) return 0;
  return Math.max(0, daten.exp * 1000 - Date.now());
}

/** Gibt es eine Anmeldung, die jetzt noch gilt? */
export function angemeldet() {
  return Boolean(token()) && restlaufzeit() > 0;
}

/**
 * Abmelden und zum Login. `grund` wird dort einmalig angezeigt, damit niemand
 * rätselt, warum er plötzlich wieder auf der Anmeldemaske steht.
 */
export function abmelden(grund = '') {
  tokenLoeschen();
  if (grund) sessionStorage.setItem(GRUND_SCHLUESSEL, grund);
  if (window.location.pathname !== '/login') window.location.href = '/login';
}

/** Holt den Abmeldegrund ab und löscht ihn — er soll nur einmal erscheinen. */
export function abmeldegrundHolen() {
  const grund = sessionStorage.getItem(GRUND_SCHLUESSEL);
  if (grund) sessionStorage.removeItem(GRUND_SCHLUESSEL);
  return grund || '';
}

// ─── Von selbst abmelden, wenn die Zeit abgelaufen ist ──────────────────────
//
// Ohne das merkt man den Ablauf erst beim nächsten Klick — und sieht bis dahin
// eine Oberfläche, die längst nichts mehr laden kann.
let wecker = null;

export function ablaufUeberwachen() {
  if (wecker) clearTimeout(wecker);
  const rest = restlaufzeit();
  if (!token()) return;
  if (rest <= 0) {
    abmelden('Deine Sitzung ist abgelaufen. Bitte melde dich neu an.');
    return;
  }
  // setTimeout kann keine beliebig langen Zeiträume; in Häppchen prüfen.
  const haeppchen = Math.min(rest, 60 * 1000);
  wecker = setTimeout(ablaufUeberwachen, haeppchen);
}

// Ein Tab, der lange im Hintergrund lag, hat womöglich Stunden verschlafen —
// beim Zurückkommen sofort nachsehen statt auf den Timer zu warten.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ablaufUeberwachen();
  });
}
