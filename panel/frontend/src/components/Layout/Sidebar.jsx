import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Mail, ShieldAlert, ListChecks, Newspaper, Filter,
  Workflow, FolderInput, Settings, Users, FileWarning,
  ChevronLeft, ChevronRight, Inbox,
} from 'lucide-react';
import { angemeldeterBenutzer } from '../../lib/auth';

// Navigation in Abschnitten — `id` ist zugleich der Rechte-Schlüssel aus dem JWT.
export const navItems = [
  { section: 'Übersicht' },
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', id: 'dashboard', exakt: true },

  { section: 'Postfächer' },
  { to: '/konten',      icon: Mail,        label: 'Konten',     id: 'konten' },
  { to: '/quarantaene', icon: ShieldAlert, label: 'Quarantäne', id: 'quarantaene' },
  { to: '/sortierung',  icon: FolderInput, label: 'Sortierung', id: 'sortierung' },

  { section: 'Spam-Schutz' },
  { to: '/listen',     icon: ListChecks, label: 'White- / Blacklist', id: 'listen' },
  { to: '/newsletter', icon: Newspaper,  label: 'Newsletter',         id: 'newsletter' },
  { to: '/rspamd',     icon: Filter,     label: 'Rspamd',             id: 'rspamd' },

  { section: 'Automatisierung' },
  { to: '/workflows', icon: Workflow, label: 'Workflows', id: 'workflows' },

  { section: 'Verwaltung' },
  { to: '/einstellungen', icon: Settings,    label: 'Einstellungen',    id: 'einstellungen' },
  { to: '/benutzer',      icon: Users,       label: 'Benutzer & Rollen', id: 'benutzer' },
  { to: '/logs',          icon: FileWarning, label: 'Logs',              id: 'logs' },
];

// Ein Abschnitt verschwindet mit, wenn der Benutzer auf keinen seiner Punkte
// Zugriff hat — sonst stünde dort eine Überschrift ohne Inhalt.
export function sichtbareNavigation(rechte) {
  const raus = [];
  for (let i = 0; i < navItems.length; i++) {
    const eintrag = navItems[i];
    if (!eintrag.section) {
      if (rechte[eintrag.id]) raus.push(eintrag);
      continue;
    }
    // Nur mitnehmen, wenn bis zum nächsten Abschnitt etwas Sichtbares folgt
    let hatInhalt = false;
    for (let j = i + 1; j < navItems.length && !navItems[j].section; j++) {
      if (rechte[navItems[j].id]) { hatInhalt = true; break; }
    }
    if (hatInhalt) raus.push(eintrag);
  }
  return raus;
}

export const Sidebar = () => {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === 'true');
  const benutzer = angemeldeterBenutzer();
  const eintraege = sichtbareNavigation(benutzer.rechte);

  const [showPrideFlag, setShowPrideFlag] = useState(() => localStorage.getItem('show_pride_flag') !== 'false');
  useEffect(() => {
    const handler = () => setShowPrideFlag(localStorage.getItem('show_pride_flag') !== 'false');
    window.addEventListener('storage', handler);
    window.addEventListener('pride_flag_change', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('pride_flag_change', handler);
    };
  }, []);

  const umschalten = () => {
    setCollapsed((c) => {
      localStorage.setItem('sidebar_collapsed', String(!c));
      return !c;
    });
  };

  return (
    <aside className={`flex flex-col bg-panel-surface border-r border-panel-border transition-all duration-200 flex-shrink-0 ${collapsed ? 'w-14' : 'w-56'}`}>

      {/* ── Kopfzeile ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-4 border-b border-panel-border min-h-[57px]">
        {!collapsed && (
          <div className="flex items-center gap-2 min-w-0">
            <Inbox size={15} className="text-panel-accent flex-shrink-0" />
            <span className="text-xs font-bold text-panel-text truncate tracking-wide">Mail-Panel</span>
          </div>
        )}
        <button
          onClick={umschalten}
          title={collapsed ? 'Menü ausklappen' : 'Menü einklappen'}
          className="ml-auto text-panel-muted hover:text-panel-text transition-colors p-1 rounded hover:bg-panel-card"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* ── Navigation ───────────────────────────────────────────────────── */}
      <nav className="flex-1 py-1 overflow-y-auto">
        {eintraege.map((item, i) => {
          if (item.section) {
            if (collapsed) return null;
            return <span key={`s${i}`} className="section-label">{item.section}</span>;
          }
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exakt}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 py-2 mx-1 my-0.5 rounded-md text-xs font-medium transition-all duration-150 border-l-2 px-2.5 ${
                  isActive
                    ? 'bg-panel-accent/10 text-panel-accent border-panel-accent'
                    : 'text-panel-muted hover:text-panel-text hover:bg-panel-card border-transparent'
                }`
              }
            >
              <item.icon size={15} className="flex-shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* ── Benutzer-Info + Version ──────────────────────────────────────── */}
      <div
        className={`px-3 py-3 border-t border-panel-border relative transition-all duration-300 overflow-hidden ${
          showPrideFlag ? 'text-white shadow-inner' : ''
        }`}
        style={
          showPrideFlag
            ? {
                background:
                  'linear-gradient(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.18)), linear-gradient(135deg, #E40303 0%, #FF8C00 14%, #FFED00 28%, #008026 42%, #004DFF 56%, #750787 70%, #5BCEFA 85%, #F5A9B8 100%)',
                textShadow: '0 1px 3px rgba(0, 0, 0, 0.95), 0 1px 2px rgba(0, 0, 0, 0.85)',
              }
            : {}
        }
      >
        {!collapsed && (
          <div className={`flex items-center justify-between text-xs ${showPrideFlag ? 'text-white' : 'text-panel-muted'}`}>
            <div className="truncate">
              <span className={`font-medium ${showPrideFlag ? 'text-white font-bold' : 'text-panel-text'}`}>
                {benutzer.username}
              </span>
              <span className="ml-1 opacity-80">({benutzer.rolle_name})</span>
            </div>
          </div>
        )}
        <div
          className={`mt-1 flex items-center text-[10px] ${
            showPrideFlag ? 'text-white/90 font-medium' : 'text-panel-muted/50'
          } ${collapsed ? 'justify-center' : 'justify-between'}`}
          title={`Build ${__APP_BUILD__}`}
        >
          <span>{collapsed ? `v${__APP_VERSION__}` : `v${__APP_VERSION__} · Build ${__APP_BUILD__}`}</span>
        </div>
      </div>
    </aside>
  );
};
