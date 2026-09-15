// Die Karte mit Kopfzeile — ein Baustein statt drei Kopien.
//
// Vorher gab es diese Karte dreimal: als ungenutzte components/ui/Card.jsx, als
// wortgleiche lokale Kopie in Einstellungen.jsx und als CSS-Klasse `.card` mit
// ganz anderem Aussehen (Glassmorphism, rundere Ecken, mehr Polsterung). Welche
// man vor sich hatte, hing davon ab, auf welcher Seite man gerade war.
//
// Arbeitsteilung ab jetzt:
//   `.card` (index.css)  — die freistehende Fläche, für alles ohne Kopfzeile.
//   <Karte title="…">    — die Fläche MIT Kopfzeile, wie auf der
//                          Einstellungsseite: abgesetzter Titelbalken, Inhalt
//                          darunter mit eigenem Abstand.
//
// `aktion` nimmt einen Knopf o.ä. für die rechte Seite der Kopfzeile auf —
// dafür musste man bisher die Kopfzeile von Hand nachbauen.
export default function Karte({ title, aktion, className = '', children }) {
  return (
    <div className={`bg-panel-card border border-panel-border rounded-lg overflow-hidden ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-panel-border bg-panel-surface/50">
          <h2 className="text-xs font-semibold text-panel-text uppercase tracking-wide flex items-center gap-2">
            {title}
          </h2>
          {aktion}
        </div>
      )}
      <div className="p-4 space-y-3">
        {children}
      </div>
    </div>
  );
}
