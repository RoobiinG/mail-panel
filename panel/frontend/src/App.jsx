import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { angemeldet, ablaufUeberwachen } from './lib/session';
import Layout from './components/Layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Konten from './pages/Konten';
import Listen from './pages/Listen';
import Einstellungen from './pages/Einstellungen';
import Platzhalter from './pages/Platzhalter';
import Quarantaene from './pages/Quarantaene';
import Rspamd from './pages/Rspamd';
import Newsletter from './pages/Newsletter';
import Workflows from './pages/Workflows';
import Logs from './pages/Logs';
import Benutzer from './pages/Benutzer';
import Sortierung from './pages/Sortierung';

// Schuetzt alle Panel-Seiten. Geprueft wird nicht nur, OB ein Token da ist,
// sondern auch, ob es noch gilt — sonst landet man nach Ablauf auf einem
// Dashboard, das nichts mehr laden kann, statt auf der Anmeldemaske.
function Geschuetzt({ children }) {
  if (!angemeldet()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  // Laeuft die Sitzung ab, waehrend das Fenster offen ist, meldet der Wecker
  // von selbst ab — man muss nicht erst irgendwo klicken, um es zu merken.
  useEffect(() => { ablaufUeberwachen(); }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Geschuetzt>
            <Layout />
          </Geschuetzt>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="konten" element={<Konten />} />
        <Route path="quarantaene" element={<Quarantaene />} />
        <Route path="listen" element={<Listen />} />
        <Route path="newsletter" element={<Newsletter />} />
        <Route path="rspamd" element={<Rspamd />} />
        <Route path="workflows" element={<Workflows />} />
        <Route path="einstellungen" element={<Einstellungen />} />
        <Route path="benutzer" element={<Benutzer />} />
        <Route path="sortierung" element={<Sortierung />} />
        <Route path="logs" element={<Logs />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
