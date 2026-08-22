// Der angemeldete Benutzer steckt im JWT — Rolle und Rechte kommen von dort,
// damit die Navigation ohne zusätzliche Anfrage weiß, was sie anzeigen darf.
// Geprüft wird trotzdem immer im Backend. Wo das Token liegt, weiß session.js.

import { nutzlast, abmelden } from './session';

const LEER = { username: 'Unbekannt', rolle_name: 'Keine Rolle', rechte: {} };

export function angemeldeterBenutzer() {
  const daten = nutzlast();
  if (!daten) return LEER;
  return {
    username: daten.username || LEER.username,
    rolle_name: daten.rolle_name || LEER.rolle_name,
    rechte: daten.rechte || {},
  };
}

export { abmelden };
