import { useLocation } from 'react-router-dom';
import { LogOut, User } from 'lucide-react';
import { navItems } from './Sidebar';
import { angemeldeterBenutzer, abmelden } from '../../lib/auth';

// Seitentitel aus der Navigation ableiten, damit beides nie auseinanderläuft.
function seitenTitel(pfad) {
  const treffer = navItems
    .filter((e) => e.to)
    .filter((e) => (e.to === '/' ? pfad === '/' : pfad.startsWith(e.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return treffer ? treffer.label : 'Mail-Panel';
}

export const Header = () => {
  const { pathname } = useLocation();
  const benutzer = angemeldeterBenutzer();

  return (
    <header className="flex items-center justify-between gap-3 px-4 py-3 bg-panel-surface border-b border-panel-border min-h-[57px] flex-shrink-0">
      <h1 className="text-sm font-semibold text-panel-text truncate">{seitenTitel(pathname)}</h1>

      <div className="flex items-center gap-3 flex-shrink-0">
        {/* Am Rechner steht der Benutzer unten in der Seitenleiste — am Handy
            gibt es die nicht, deshalb hier. */}
        <div className="flex md:hidden items-center gap-1.5 text-xs text-panel-muted">
          <User size={13} className="flex-shrink-0" />
          <span className="text-panel-text font-medium">{benutzer.username}</span>
        </div>
        <button
          onClick={abmelden}
          title="Abmelden"
          className="flex items-center gap-1.5 text-xs text-panel-muted hover:text-panel-text transition-colors"
        >
          <LogOut size={13} />
          <span className="hidden sm:inline">Abmelden</span>
        </button>
      </div>
    </header>
  );
};
