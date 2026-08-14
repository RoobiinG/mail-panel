// Der angemeldete Benutzer steckt im JWT im localStorage — Rolle und Rechte
// kommen von dort, damit die Navigation ohne zusätzliche Anfrage weiß, was
// sie anzeigen darf. Geprüft wird trotzdem immer im Backend.

const LEER = { username: 'Unbekannt', rolle_name: 'Keine Rolle', rechte: {} };

export function angemeldeterBenutzer() {
  const token = localStorage.getItem('token');
  if (!token) return LEER;
  try {
    const nutzlast = JSON.parse(atob(token.split('.')[1]));
    return {
      username: nutzlast.username || LEER.username,
      rolle_name: nutzlast.rolle_name || LEER.rolle_name,
      rechte: nutzlast.rechte || {},
    };
  } catch {
    return LEER;
  }
}

export function abmelden() {
  localStorage.removeItem('token');
  window.location.href = '/login';
}
