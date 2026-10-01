import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, MessageCircle, ShieldCheck, Smartphone } from 'lucide-react';
import api from '../api';
import { tokenSetzen, abmeldegrundHolen, ablaufUeberwachen } from '../lib/session';

// Die Methoden der Zwei-Faktor-Anmeldung, so wie der Benutzer sie beim Login sieht.
// `sendet`: Der Code muss erst angefordert werden (E-Mail, Discord). Bei der
// Authenticator-App steht er schon in der App.
const METHODEN = {
  totp:    { label: 'Authenticator-App', Icon: Smartphone,    sendet: false },
  email:   { label: 'E-Mail',            Icon: Mail,          sendet: true },
  discord: { label: 'Discord',           Icon: MessageCircle, sendet: true },
};

// Login-Maske mit integriertem Erststart-Setup: existiert noch kein Benutzer,
// wird stattdessen das Admin-Konto angelegt (Backend erzwingt Einmaligkeit).
//
// Hat der Benutzer eine Zwei-Faktor-Methode eingerichtet, antwortet das Backend auf
// das Passwort NICHT mit einer Sitzung, sondern mit einem Ticket (fünf Minuten):
// Dann folgt hier ein zweiter Schritt, in dem man sich eine der eingerichteten
// Methoden aussucht und den Code eingibt.
export default function Login() {
  const navigate = useNavigate();
  const [setupNoetig, setSetupNoetig] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fehler, setFehler] = useState('');
  const [laedt, setLaedt] = useState(false);
  const [pkLaedt, setPkLaedt] = useState(false);
  const [angemeldetBleiben, setAngemeldetBleiben] = useState(false);
  // Warum steht man wieder hier? Ohne diesen Hinweis wirkt ein abgelaufenes
  // Token wie ein Fehler des Panels.
  const [hinweis, setHinweis] = useState('');

  // Zweiter Schritt: das Ticket und was man damit gerade tut.
  const [ticket, setTicket] = useState(null);      // Antwort des Backends auf das Passwort
  const [methode, setMethode] = useState('totp');
  const [code, setCode] = useState('');
  const [gesendet, setGesendet] = useState({});    // je Methode: wurde ein Code angefordert?
  const [restSek, setRestSek] = useState(0);

  useEffect(() => {
    setHinweis(abmeldegrundHolen());
    api.get('/auth/setup-status')
      .then((res) => setSetupNoetig(res.data.setupNoetig))
      .catch(() => setFehler('Backend nicht erreichbar.'));
  }, []);

  const anmelden = (token) => {
    tokenSetzen(token, angemeldetBleiben);
    ablaufUeberwachen();
    navigate('/');
  };

  // Zurück zum Passwort. Das Passwort selbst wird nie behalten, sobald das Ticket da ist.
  const zurueck = (meldung = '') => {
    setTicket(null);
    setCode('');
    setGesendet({});
    setPassword('');
    setFehler(meldung);
  };

  // Die Restzeit des Tickets läuft sichtbar mit — danach wäre jeder Code vergeblich.
  useEffect(() => {
    if (!ticket) return undefined;
    const tick = () => {
      // Gegen die Dauer ab Empfang gerechnet, nicht gegen die Serveruhr: Geht der
      // Browser falsch, würde die Anmeldung sonst sofort „ablaufen".
      const rest = Math.ceil((ticket.endeMs - Date.now()) / 1000);
      setRestSek(Math.max(0, rest));
      if (rest <= 0) zurueck('Die Anmeldung ist abgelaufen — bitte melde dich neu an.');
    };
    tick();
    const uhr = setInterval(tick, 1000);
    return () => clearInterval(uhr);
  }, [ticket]);

  const absenden = async (e) => {
    e.preventDefault();
    setFehler('');
    setLaedt(true);
    try {
      const pfad = setupNoetig ? '/auth/setup' : '/auth/login';
      const res = await api.post(pfad, { username, password });
      if (res.data.zweiFaktor) {
        setTicket({ ...res.data, endeMs: Date.now() + (res.data.gueltig_sekunden ?? 300) * 1000 });
        setMethode(res.data.bevorzugt || res.data.methoden[0]);
        setPassword('');
        return;
      }
      anmelden(res.data.token);
    } catch (err) {
      setFehler(err.response?.data?.error || 'Anmeldung fehlgeschlagen.');
    } finally {
      setLaedt(false);
    }
  };

  const codeAnfordern = async () => {
    setFehler('');
    setLaedt(true);
    try {
      await api.post('/auth/2fa/senden', { auth_ticket: ticket.auth_ticket, methode });
      setGesendet((g) => ({ ...g, [methode]: true }));
    } catch (err) {
      if (err.response?.data?.code === 'ticket_ungueltig') return zurueck(err.response.data.error);
      setFehler(err.response?.data?.error || 'Der Code konnte nicht angefordert werden.');
    } finally {
      setLaedt(false);
    }
    return undefined;
  };

  const codePruefen = async (e) => {
    e.preventDefault();
    setFehler('');
    setLaedt(true);
    try {
      const res = await api.post('/auth/verify-2fa', {
        auth_ticket: ticket.auth_ticket, methode, code,
      });
      anmelden(res.data.token);
    } catch (err) {
      const daten = err.response?.data;
      // Ticket verbraucht, abgelaufen oder verbrannt: Mit diesem Ticket geht nichts mehr.
      if (daten?.code === 'ticket_ungueltig') return zurueck(daten.error);
      setCode('');
      setFehler(daten?.error || 'Der Code stimmt nicht.');
    } finally {
      setLaedt(false);
    }
    return undefined;
  };

  const handlePasskeyLogin = async () => {
    setFehler('');
    setPkLaedt(true);
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const optRes  = await api.get('/auth/webauthn/generate-authentication-options');
      const assertion = await startAuthentication({ optionsJSON: optRes.data });
      const finRes  = await api.post('/auth/webauthn/verify-authentication', assertion);
      anmelden(finRes.data.token);
    } catch (err) {
      setFehler(err.response?.data?.error || err.message || 'Passkey-Anmeldung fehlgeschlagen.');
    } finally {
      setPkLaedt(false);
    }
  };

  // ─── Zweiter Schritt: Code ─────────────────────────────────────────────────
  if (ticket) {
    const m = METHODEN[methode];
    const braucheSenden = m.sendet && !gesendet[methode];
    const ziel = ticket.ziele?.[methode];
    const minuten = `${Math.floor(restSek / 60)}:${String(restSek % 60).padStart(2, '0')}`;

    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <form onSubmit={codePruefen} className="card w-full max-w-sm space-y-4">
          <div className="text-center space-y-1">
            <ShieldCheck size={30} className="mx-auto text-panel-accent" />
            <h1 className="text-xl font-semibold">Zweiter Faktor</h1>
            <p className="text-sm text-panel-muted">
              Bestätige, dass du es bist — noch <span className="tabular-nums">{minuten}</span> Minuten Zeit.
            </p>
          </div>

          {/* Methodenwahl — nur, was der Benutzer eingerichtet hat */}
          {ticket.methoden.length > 1 && (
            <div className="grid gap-2" role="radiogroup" aria-label="Methode">
              {ticket.methoden.map((id) => {
                const { label, Icon } = METHODEN[id];
                const aktiv = id === methode;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={aktiv}
                    onClick={() => { setMethode(id); setCode(''); setFehler(''); }}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-md border text-sm text-left transition-colors ${
                      aktiv
                        ? 'border-panel-accent bg-panel-accent/10 text-panel-accent'
                        : 'border-panel-border text-panel-muted hover:text-panel-text hover:border-panel-accent/50'
                    }`}
                  >
                    <Icon size={15} className="flex-shrink-0" />
                    <span className="flex-1">{label}</span>
                    {ticket.ziele?.[id] && <span className="text-xs opacity-70">{ticket.ziele[id]}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {!m.sendet && (
            <p className="text-sm text-panel-muted">
              Gib den 6-stelligen Code aus deiner Authenticator-App ein.
            </p>
          )}

          {braucheSenden ? (
            <>
              <p className="text-sm text-panel-muted">
                Wir schicken dir einen Code per {m.label}{ziel ? ` an ${ziel}` : ''}.
              </p>
              <button type="button" onClick={codeAnfordern} disabled={laedt} className="btn-primary w-full">
                {laedt ? 'Wird gesendet…' : 'Code senden'}
              </button>
            </>
          ) : (
            <>
              {m.sendet && (
                <p className="text-sm text-panel-muted">
                  Code gesendet{ziel ? ` an ${ziel}` : ''}. Er gilt wenige Minuten und nur einmal.
                </p>
              )}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                pattern="[0-9 ]*"
                placeholder="123456"
                aria-label="Code"
                className="text-center text-xl tracking-[0.35em] tabular-nums"
              />
              <button
                type="submit"
                disabled={laedt || code.replace(/\s/g, '').length !== 6}
                className="btn-primary w-full"
              >
                {laedt ? 'Bitte warten…' : 'Bestätigen'}
              </button>
              {m.sendet && (
                <button type="button" onClick={codeAnfordern} disabled={laedt}
                  className="w-full text-xs text-panel-muted hover:text-panel-text underline-offset-2 hover:underline">
                  Code erneut senden
                </button>
              )}
            </>
          )}

          {fehler && <p className="text-sm text-panel-red" role="alert">{fehler}</p>}

          <button type="button" onClick={() => zurueck()}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-panel-muted hover:text-panel-text">
            <ArrowLeft size={13} /> Zurück zur Anmeldung
          </button>
        </form>
      </div>
    );
  }

  // ─── Erster Schritt: Passwort ──────────────────────────────────────────────
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

        {!setupNoetig && (
          <label className="flex items-center gap-2 text-xs cursor-pointer text-panel-muted">
            <input
              type="checkbox"
              checked={angemeldetBleiben}
              onChange={(e) => setAngemeldetBleiben(e.target.checked)}
              className="accent-panel-accent"
            />
            Angemeldet bleiben
            <span className="text-[10px] text-panel-muted/70">
              — sonst endet die Sitzung, sobald du den Browser schließt
            </span>
          </label>
        )}

        {hinweis && (
          <p className="text-sm text-panel-muted bg-panel-surface border border-panel-border rounded-md px-3 py-2">
            {hinweis}
          </p>
        )}
        {fehler && <p className="text-sm text-panel-red">{fehler}</p>}
        <button type="submit" disabled={laedt || pkLaedt} className="btn-primary w-full">
          {laedt ? 'Bitte warten…' : setupNoetig ? 'Konto anlegen' : 'Anmelden'}
        </button>

        {!setupNoetig && (
          <>
            <div className="flex items-center gap-3 pt-2">
              <div className="flex-1 h-px bg-panel-border" />
              <span className="text-xs text-panel-muted">oder</span>
              <div className="flex-1 h-px bg-panel-border" />
            </div>
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={laedt || pkLaedt}
              className="w-full flex items-center justify-center gap-2 border border-panel-border hover:border-panel-accent bg-panel-surface hover:bg-panel-card text-panel-text text-sm font-medium py-2 rounded-md transition-colors disabled:opacity-50"
            >
              <span className="text-panel-accent text-lg">🔑</span>
              {pkLaedt ? 'Warte auf Passkey...' : 'Mit Passkey anmelden'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
