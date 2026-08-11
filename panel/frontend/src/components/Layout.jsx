import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Mail, ShieldAlert, ListChecks,
  Newspaper, Filter, Workflow, Settings, LogOut, FileWarning, Users,
} from 'lucide-react';

const NAV = [
  { zu: '/', label: 'Dashboard', Icon: LayoutDashboard, exakt: true, id: 'dashboard' },
  { zu: '/konten', label: 'Konten', Icon: Mail, id: 'konten' },
  { zu: '/quarantaene', label: 'Quarantäne', Icon: ShieldAlert, id: 'quarantaene' },
  { zu: '/listen', label: 'White- / Blacklist', Icon: ListChecks, id: 'listen' },
  { zu: '/newsletter', label: 'Newsletter', Icon: Newspaper, id: 'newsletter' },
  { zu: '/rspamd', label: 'Rspamd', Icon: Filter, id: 'rspamd' },
  { zu: '/workflows', label: 'Workflows', Icon: Workflow, id: 'workflows' },
  { zu: '/einstellungen', label: 'Einstellungen', Icon: Settings, id: 'einstellungen' },
  { zu: '/benutzer', label: 'Benutzer & Rollen', Icon: Users, id: 'benutzer' },
  { zu: '/logs', label: 'Logs', Icon: FileWarning, id: 'logs' },
];

export default function Layout() {
  const navigate = useNavigate();

  const token = localStorage.getItem('token');
  let user = { username: 'Unbekannt', rolle_name: 'Keine Rolle', rechte: {} };
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      user = {
        username: payload.username,
        rolle_name: payload.rolle_name,
        rechte: payload.rechte || {},
      };
    } catch { /* leer */ }
  }

  const abmelden = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const [showPrideFlag, setShowPrideFlag] = useState(() => localStorage.getItem('show_pride_flag') !== 'false');

  useEffect(() => {
    const handleStorage = () => {
      setShowPrideFlag(localStorage.getItem('show_pride_flag') !== 'false');
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener('pride_flag_change', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('pride_flag_change', handleStorage);
    };
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-panel-surface border-r border-panel-border flex flex-col">
        <div className="px-5 py-4 border-b border-panel-border">
          <span className="text-lg font-semibold">📬 Mail-Panel</span>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.filter(e => user.rechte[e.id]).map(({ zu, label, Icon, exakt }) => (
            <NavLink
              key={zu}
              to={zu}
              end={exakt}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                  isActive
                    ? 'bg-panel-accent text-white font-medium shadow-md shadow-panel-accent/20'
                    : 'text-panel-muted hover:bg-panel-card hover:text-white'
                }`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-panel-border mt-auto">
          <div className="flex items-center justify-between mb-4 px-1">
            <div className="text-sm font-medium">
              <div>{user.username}</div>
              <div className="text-xs text-panel-muted">{user.rolle_name}</div>
            </div>
          </div>
          <button
            onClick={abmelden}
            className="flex items-center gap-3 w-full px-3 py-2 text-panel-muted hover:bg-panel-red hover:text-white rounded-md transition-colors"
          >
            <LogOut size={18} />
            <span>Abmelden</span>
          </button>
        </div>
        <div className={`px-5 pb-4 text-[10px] font-mono tracking-wider ${
          showPrideFlag ? 'text-white/80' : 'text-panel-muted/40'
        }`}>
          v{__APP_VERSION__} ({__APP_BUILD__})
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
