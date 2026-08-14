import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Mail, ShieldAlert, Workflow, Menu, X } from 'lucide-react';
import { navItems, sichtbareNavigation } from './Sidebar';
import { angemeldeterBenutzer } from '../../lib/auth';

// Die vier Kernseiten für die untere Leiste; alles Weitere steckt hinter „Mehr".
const PRIMAER = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard',  id: 'dashboard', exakt: true },
  { to: '/konten',      icon: Mail,            label: 'Konten',     id: 'konten' },
  { to: '/quarantaene', icon: ShieldAlert,     label: 'Quarantäne', id: 'quarantaene' },
  { to: '/workflows',   icon: Workflow,        label: 'Workflows',  id: 'workflows' },
];

export function MobileNav() {
  const [offen, setOffen] = useState(false);
  const benutzer = angemeldeterBenutzer();
  const eintraege = sichtbareNavigation(benutzer.rechte);

  const tabCls = ({ isActive }) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors ${
      isActive ? 'text-panel-accent' : 'text-panel-muted'
    }`;

  return (
    <>
      {/* Schublade mit dem vollständigen Menü */}
      {offen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOffen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-panel-surface border-r border-panel-border overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border">
              <span className="text-xs font-bold text-panel-text tracking-wide">Mail-Panel</span>
              <button onClick={() => setOffen(false)} className="text-panel-muted hover:text-panel-text">
                <X size={16} />
              </button>
            </div>
            <nav className="py-1">
              {eintraege.map((item, i) => {
                if (item.section) return <span key={`s${i}`} className="section-label">{item.section}</span>;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.exakt}
                    onClick={() => setOffen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-4 py-2.5 text-sm border-l-2 ${
                        isActive
                          ? 'text-panel-accent bg-panel-accent/10 border-panel-accent'
                          : 'text-panel-muted border-transparent hover:text-panel-text'
                      }`
                    }
                  >
                    <item.icon size={16} className="flex-shrink-0" />{item.label}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Untere Tab-Leiste */}
      <nav className="fixed bottom-0 inset-x-0 z-40 md:hidden flex bg-panel-surface border-t border-panel-border">
        {PRIMAER.filter((p) => benutzer.rechte[p.id]).map((p) => (
          <NavLink key={p.to} to={p.to} end={p.exakt} className={tabCls}>
            <p.icon size={18} />{p.label}
          </NavLink>
        ))}
        <button
          onClick={() => setOffen(true)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] text-panel-muted"
        >
          <Menu size={18} />Mehr
        </button>
      </nav>
    </>
  );
}
