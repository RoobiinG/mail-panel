import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Konten from './pages/Konten';
import Einstellungen from './pages/Einstellungen';
import Platzhalter from './pages/Platzhalter';

// Schuetzt alle Panel-Seiten: ohne Token geht es zum Login
function Geschuetzt({ children }) {
  if (!localStorage.getItem('token')) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
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
        <Route path="quarantaene" element={<Platzhalter titel="Quarantäne" etappe="5" />} />
        <Route path="listen" element={<Platzhalter titel="White- / Blacklist" etappe="3" />} />
        <Route path="newsletter" element={<Platzhalter titel="Newsletter" etappe="7" />} />
        <Route path="rspamd" element={<Platzhalter titel="Rspamd" etappe="6" />} />
        <Route path="workflows" element={<Platzhalter titel="Workflows" etappe="7" />} />
        <Route path="einstellungen" element={<Einstellungen />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
