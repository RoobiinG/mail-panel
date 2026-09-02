import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, HelpCircle } from 'lucide-react';

// Ersatz für die Browser-Dialoge `alert()` und `confirm()`.
//
// Die grauen Kästen des Browsers reißen einen aus der Arbeit, sehen auf jedem
// System anders aus, nennen ungefragt den Hostnamen des Servers und blockieren
// die ganze Seite, bis man klickt. Stattdessen:
//
//   melden('…')      → Einblendung unten rechts, verschwindet von selbst
//   nachfragen({…})  → Rückfrage im Panel-Stil, liefert ein Versprechen
//
// Beides läuft über einen Kontext, damit jede Seite ohne eigenen Zustand
// auskommt.

const MeldungsKontext = createContext(null);

export function useMelden() {
  const kontext = useContext(MeldungsKontext);
  if (!kontext) throw new Error('useMelden braucht den MeldungsAnbieter im Baum.');
  return kontext;
}

const FARBEN = {
  gut:     { rand: 'border-green-600/60',  icon: CheckCircle2,  ton: 'text-green-500' },
  fehler:  { rand: 'border-panel-red',     icon: AlertTriangle, ton: 'text-panel-red' },
  hinweis: { rand: 'border-yellow-600/60', icon: Info,          ton: 'text-yellow-500' },
};

export function MeldungsAnbieter({ children }) {
  const [meldungen, setMeldungen] = useState([]);
  const [frage, setFrage] = useState(null);
  const naechsteId = useRef(1);

  const schliessen = useCallback((id) => {
    setMeldungen((liste) => liste.filter((m) => m.id !== id));
  }, []);

  // Fehler bleiben länger stehen als Erfolgsmeldungen — sie will man lesen.
  const melden = useCallback((text, art = 'gut', dauer) => {
    if (!text) return;
    const id = naechsteId.current++;
    const stehzeit = dauer ?? (art === 'fehler' ? 12000 : 6000);
    setMeldungen((liste) => [...liste, { id, text: String(text), art }]);
    if (stehzeit > 0) setTimeout(() => schliessen(id), stehzeit);
    return id;
  }, [schliessen]);

  // Liefert ein Versprechen, das mit true/false aufgelöst wird. Damit bleibt
  // der Aufruf an der Stelle lesbar:  if (!(await nachfragen({…}))) return;
  const nachfragen = useCallback((optionen) => new Promise((antworten) => {
    const o = typeof optionen === 'string' ? { text: optionen } : (optionen || {});
    setFrage({
      titel: o.titel || 'Sicher?',
      text: o.text || '',
      bestaetigen: o.bestaetigen || 'Ja',
      abbrechen: o.abbrechen || 'Abbrechen',
      gefaehrlich: Boolean(o.gefaehrlich),
      antworten,
    });
  }), []);

  const beantworten = (wert) => {
    setFrage((f) => { f?.antworten(wert); return null; });
  };

  // Escape bricht ab, Enter bestätigt — wie man es von Dialogen erwartet.
  useEffect(() => {
    if (!frage) return undefined;
    const taste = (e) => {
      if (e.key === 'Escape') beantworten(false);
      if (e.key === 'Enter') beantworten(true);
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [frage]);

  return (
    <MeldungsKontext.Provider value={{ melden, nachfragen }}>
      {children}

      {/* Einblendungen */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[min(28rem,calc(100vw-2rem))]">
        {meldungen.map((m) => {
          const f = FARBEN[m.art] || FARBEN.gut;
          const Zeichen = f.icon;
          return (
            <div key={m.id}
              role="status"
              className={`card !py-3 !px-4 ${f.rand} shadow-lg flex items-start gap-2 text-sm
                          animate-[einblenden_150ms_ease-out]`}>
              <Zeichen size={16} className={`mt-0.5 shrink-0 ${f.ton}`} />
              <span className="flex-1 whitespace-pre-line break-words">{m.text}</span>
              <button onClick={() => schliessen(m.id)}
                className="text-panel-muted hover:text-panel-text shrink-0" title="Schließen">
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Rückfrage */}
      {frage && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => beantworten(false)}>
          <div className="card max-w-md w-full space-y-4" onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true">
            <h2 className="font-medium flex items-center gap-2">
              <HelpCircle size={18} className={frage.gefaehrlich ? 'text-panel-red' : 'text-panel-accent'} />
              {frage.titel}
            </h2>
            {frage.text && <p className="text-sm text-panel-muted whitespace-pre-line">{frage.text}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => beantworten(false)} className="btn-ghost">{frage.abbrechen}</button>
              <button onClick={() => beantworten(true)} autoFocus
                className={`btn ${frage.gefaehrlich ? '!bg-panel-red hover:!bg-red-700' : ''}`}>
                {frage.bestaetigen}
              </button>
            </div>
          </div>
        </div>
      )}
    </MeldungsKontext.Provider>
  );
}
