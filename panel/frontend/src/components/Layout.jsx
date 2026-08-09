import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Mail, ShieldAlert, ListChecks,
  Newspaper, Filter, Workflow, Settings, LogOut,
} from 'lucide-react';

const NAV = [
  { zu: '/', label: 'Dashboard', Icon: LayoutDashboard, exakt: true },
  { zu: '/konten', label: 'Konten', Icon: Mail },
  { zu: '/quarantaene', label: 'Quarantäne', Icon: ShieldAlert },
  { zu: '/listen', label: 'White- / Blacklist', Icon: ListChecks },
  { zu: '/newsletter', label: 'Newsletter', Icon: Newspaper },
  { zu: '/rspamd', label: 'Rspamd', Icon: Filter },
  { zu: '/workflows', label: 'Workflows', Icon: Workflow },
  { zu: '/einstellungen', label: 'Einstellungen', Icon: Settings },
];

export default function Layout() {
  const navigate = useNavigate();
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
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map(({ zu, label, Icon, exakt }) => (
            <NavLink
              key={zu}
              to={zu}
              end={exakt}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-panel-card text-panel-text border border-panel-border'
                    : 'text-panel-muted hover:text-panel-text hover:bg-panel-card/50'
                }`
              }
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div 
          className={`mt-auto border-t border-panel-border relative transition-all duration-300 overflow-hidden ${
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
          <button
            onClick={abmelden}
            className={`flex w-full items-center gap-3 px-5 py-4 text-sm transition-colors ${
              showPrideFlag ? 'text-white hover:text-white/80' : 'text-panel-muted hover:text-panel-red'
            }`}
          >
            <LogOut size={17} />
            Abmelden
          </button>
          <div className={`px-5 pb-4 text-[10px] font-mono tracking-wider ${
            showPrideFlag ? 'text-white/80' : 'text-panel-muted/40'
          }`}>
            v{__APP_VERSION__} ({__APP_BUILD__})
          </div>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
