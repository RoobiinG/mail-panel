// Generischer Platzhalter fuer Seiten, deren Etappe noch nicht umgesetzt ist.
export default function Platzhalter({ titel, etappe }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{titel}</h1>
      <div className="card">
        <p className="text-panel-muted text-sm">
          Diese Seite wird in <span className="text-panel-text">Etappe {etappe}</span> umgesetzt
          (siehe ROADMAP.md im Projektordner).
        </p>
      </div>
    </div>
  );
}
