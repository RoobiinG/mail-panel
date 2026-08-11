import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Konten from './pages/Konten';
import Listen from './pages/Listen';
import Einstellungen from './pages/Einstellungen';
import Platzhalter from './pages/Platzhalter';
import Quarantaene from './pages/Quarantaene';
import Rspamd from './pages/Rspamd';
import Newsletter from './pages/Newsletter';
import Logs from './pages/Logs';

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
        <Route path="quarantaene" element={<Quarantaene />} />
        <Route path="listen" element={<Listen />} />
        <Route path="newsletter" element={<Newsletter />} />
        <Route path="rspamd" element={<Rspamd />} />
        <Route path="workflows" element={<Platzhalter titel="Workflows" etappe="7" />} />
        <Route path="einstellungen" element={<Einstellungen />} />
        <Route path="logs" element={<Logs />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
