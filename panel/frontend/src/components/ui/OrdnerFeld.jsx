// Ersetzt die native Kombination aus <input list="…"> und <datalist>: Deren
// Vorschlagsliste ist Browser-Chrome, lässt sich nicht ins Dark-Theme einfärben
// (heller Kasten im dunklen Panel) und wird — weil sie eigentlich außerhalb der
// Seite gerendert wird — von scrollenden Elternelementen mal abgeschnitten, mal
// nicht. Diese Liste hängt deshalb per Portal direkt am <body> und positioniert
// sich anhand der tatsächlichen Bildschirmposition des Eingabefelds, unabhängig
// von jedem `overflow` oder `backdrop-blur` auf dem Weg dorthin.
//
// Tippen bleibt immer gültig — ein Ordner, der noch nicht existiert, ist ein
// neuer Ordner, keine ungültige Eingabe. Die Liste ist nur ein Vorschlag.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TREFFER_MAX = 40;

export default function OrdnerFeld({
  value, onChange, optionen, className = '', onBlur: externOnBlur, onKeyDown: externOnKeyDown, ...rest
}) {
  const inputRef = useRef(null);
  const [offen, setOffen] = useState(false);
  const [hervorgehoben, setHervorgehoben] = useState(null);
  const [position, setPosition] = useState(null);

  const gefiltert = useMemo(() => {
    const q = (value || '').trim().toLowerCase();
    const basis = q ? optionen.filter((o) => o.toLowerCase().includes(q)) : optionen;
    return basis.slice(0, TREFFER_MAX);
  }, [optionen, value]);

  const positionieren = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setPosition({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  useEffect(() => {
    if (!offen) return undefined;
    positionieren();
    window.addEventListener('scroll', positionieren, true);
    window.addEventListener('resize', positionieren);
    return () => {
      window.removeEventListener('scroll', positionieren, true);
      window.removeEventListener('resize', positionieren);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen]);

  const waehlen = (o) => {
    onChange(o);
    setOffen(false);
    setHervorgehoben(null);
    inputRef.current?.focus();
  };

  const behandleBlur = (e) => {
    externOnBlur?.(e);
    setOffen(false);
  };

  // Pfeiltasten und Mausklick funktionieren überall. Enter/Escape nur dort
  // selbst behandeln, wo die aufrufende Stelle nicht schon eigenes
  // Enter/Escape-Verhalten mitbringt (z. B. Inline-Bearbeitung mit
  // Speichern-bei-Blur) — sonst würden sich beide in die Quere kommen.
  const behandleKeyDown = (e) => {
    externOnKeyDown?.(e);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOffen(true);
      setHervorgehoben((h) => Math.min((h ?? -1) + 1, gefiltert.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHervorgehoben((h) => Math.max((h ?? 0) - 1, 0));
    } else if (!externOnKeyDown && e.key === 'Enter') {
      if (offen && hervorgehoben != null && gefiltert[hervorgehoben]) {
        e.preventDefault();
        waehlen(gefiltert[hervorgehoben]);
      } else {
        setOffen(false);
      }
    } else if (!externOnKeyDown && e.key === 'Escape') {
      setOffen(false);
      setHervorgehoben(null);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        {...rest}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOffen(true); setHervorgehoben(null); }}
        onFocus={() => setOffen(true)}
        onBlur={behandleBlur}
        onKeyDown={behandleKeyDown}
        className={className}
      />
      {offen && position && gefiltert.length > 0 && createPortal(
        <div
          className="fixed z-[60] max-h-56 overflow-auto rounded-xl border border-panel-border
                     bg-panel-surface shadow-[0_8px_30px_rgba(0,0,0,0.4)] py-1"
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          {gefiltert.map((o, i) => (
            <button
              type="button"
              key={o}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => waehlen(o)}
              className={`block w-full text-left px-3 py-1.5 text-sm truncate transition-colors ${
                i === hervorgehoben
                  ? 'bg-panel-accent/20 text-panel-text'
                  : 'text-panel-muted hover:bg-panel-card hover:text-panel-text'
              }`}
            >
              {o}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
