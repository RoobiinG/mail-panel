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
        <div className="mt-auto border-t border-panel-border">
          <button
            onClick={abmelden}
            className="flex w-full items-center gap-3 px-5 py-4 text-sm text-panel-muted hover:text-panel-red transition-colors"
          >
            <LogOut size={17} />
            Abmelden
          </button>
          <div className="px-5 pb-4 text-[10px] text-panel-muted/40 font-mono tracking-wider">
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
