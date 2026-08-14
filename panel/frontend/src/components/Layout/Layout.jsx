import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { useIsMobile } from '../../hooks/useIsMobile';

// Aufbau wie im Überwachungs-Panel: am Rechner Sidebar plus Kopfzeile,
// am Handy Kopfzeile oben und Tab-Leiste unten.
export default function Layout() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-panel-bg">
        <Header />
        <main className="flex-1 overflow-y-auto p-3 pb-20">
          <Outlet />
        </main>
        <MobileNav />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-panel-bg overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
