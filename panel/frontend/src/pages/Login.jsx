import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

// Login-Maske mit integriertem Erststart-Setup: existiert noch kein Benutzer,
// wird stattdessen das Admin-Konto angelegt (Backend erzwingt Einmaligkeit).
export default function Login() {
  const navigate = useNavigate();
  const [setupNoetig, setSetupNoetig] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fehler, setFehler] = useState('');
  const [laedt, setLaedt] = useState(false);

  useEffect(() => {
    api.get('/auth/setup-status')
      .then((res) => setSetupNoetig(res.data.setupNoetig))
      .catch(() => setFehler('Backend nicht erreichbar.'));
  }, []);

  const absenden = async (e) => {
    e.preventDefault();
    setFehler('');
    setLaedt(true);
    try {
      const pfad = setupNoetig ? '/auth/setup' : '/auth/login';
      const res = await api.post(pfad, { username, password });
      localStorage.setItem('token', res.data.token);
      navigate('/');
    } catch (err) {
      setFehler(err.response?.data?.error || 'Anmeldung fehlgeschlagen.');
    } finally {
      setLaedt(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={absenden} className="card w-full max-w-sm space-y-4">
        <div className="text-center space-y-1">
          <div className="text-3xl">📬</div>
          <h1 className="text-xl font-semibold">Mail-Panel</h1>
          <p className="text-sm text-panel-muted">
            {setupNoetig
              ? 'Erststart: Lege dein Admin-Konto an.'
              : 'Melde dich an.'}
          </p>
        </div>
        <div className="space-y-3">
          <input
            placeholder="Benutzername"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder={setupNoetig ? 'Passwort (mind. 10 Zeichen)' : 'Passwort'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setupNoetig ? 'new-password' : 'current-password'}
          />
        </div>
        {fehler && <p className="text-sm text-panel-red">{fehler}</p>}
        <button type="submit" disabled={laedt} className="btn-primary w-full">
          {laedt ? 'Bitte warten…' : setupNoetig ? 'Konto anlegen' : 'Anmelden'}
        </button>
      </form>
    </div>
  );
}
