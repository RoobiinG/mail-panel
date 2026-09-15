// Gemeinsame Diagramm-Einstellungen.
//
// Vorher hatte jede Seite ihre eigenen: Das Dashboard malte Spam bernsteinfarben,
// die Statistik rot; die Tooltips standen auf "#1a1b1e" beziehungsweise
// "#1a1d24" — zwei erfundene Grautöne, von denen keiner die Flächenfarbe des
// Panels war (panel-surface, #161b22). Dieselbe Sache sah also je nach Seite
// anders aus.
//
// Die Werte hier sind dieselben wie in tailwind.config.js. Recharts braucht
// echte Farbwerte und kann mit Klassennamen nichts anfangen — deshalb doppelt
// sie hier, aber an genau einer Stelle.
export const FARBEN = {
  akzent: '#388bfd',
  gruen: '#3fb950',
  rot: '#f85149',
  orange: '#e3b341',
  lila: '#a371f7',
  grau: '#8b949e',
  flaeche: '#161b22',
  rand: '#30363d',
  text: '#e6edf3',
};

// Reihenfolge für Diagramme mit mehreren Reihen, sodass nebeneinander liegende
// Flächen sich deutlich unterscheiden.
export const REIHENFARBEN = [
  FARBEN.akzent, FARBEN.gruen, FARBEN.orange, FARBEN.lila, FARBEN.rot, FARBEN.grau,
];

export const TOOLTIP_STIL = {
  backgroundColor: FARBEN.flaeche,
  border: `1px solid ${FARBEN.rand}`,
  borderRadius: '6px',
  fontSize: '12px',
  color: FARBEN.text,
};

// Achsenbeschriftung: klein, gedämpft, ohne Linien — dieselbe Behandlung auf
// allen Seiten.
export const ACHSE = {
  tick: { fontSize: 11, fill: FARBEN.grau },
  axisLine: false,
  tickLine: false,
};

// "2026-09-15" -> "15.09." — auf einer Tagesachse ist das Jahr nur Ballast.
export const tagKurz = (iso) => {
  const t = String(iso || '').split('-');
  return t.length === 3 ? `${t[2]}.${t[1]}.` : String(iso || '');
};
