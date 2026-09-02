import { useState, useEffect } from 'react';
import { Users, Shield, Clock, Plus, Edit2, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import api from '../api';
import { useMelden } from '../components/ui/Meldungen';

const BEREICHE = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'konten', label: 'E-Mail Konten' },
  { id: 'quarantaene', label: 'Quarantäne' },
  { id: 'listen', label: 'White- / Blacklist' },
  { id: 'newsletter', label: 'Newsletter' },
  { id: 'rspamd', label: 'Rspamd' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'sortierung', label: 'Sortierung' },
  { id: 'einstellungen', label: 'Einstellungen' },
  { id: 'logs', label: 'Panel-Logs' },
  { id: 'benutzer', label: 'Benutzer & Rollen' },
];

export default function BenutzerVerwaltung() {
  const { melden, nachfragen } = useMelden();
  const [tab, setTab] = useState('benutzer'); // benutzer, rollen, authlog

  const [benutzer, setBenutzer] = useState([]);
  const [rollen, setRollen] = useState([]);
  const [authLog, setAuthLog] = useState({ logs: [], total: 0 });

  const [laedt, setLaedt] = useState(false);
  const [error, setError] = useState('');

  // Modals / Formulare
  const [userModal, setUserModal] = useState({ offen: false, mode: 'neu', id: null, username: '', password: '', rolle_id: '' });
  const [rollenModal, setRollenModal] = useState({ offen: false, mode: 'neu', id: null, name: '', rechte: {} });

  const laden = async () => {
    setLaedt(true);
    setError('');
    try {
      const [resBenutzer, resRollen] = await Promise.all([
        api.get('/benutzer'),
        api.get('/rollen'),
      ]);
      setBenutzer(resBenutzer.data || []);
      setRollen(resRollen.data || []);
      if (tab === 'authlog') await logLaden();
    } catch (err) {
      setError(err.response?.data?.error || 'Fehler beim Laden');
    } finally {
      setLaedt(false);
    }
  };

  const logLaden = async () => {
    try {
      const res = await api.get('/benutzer/auth-log?limit=50');
      setAuthLog(res.data || { logs: [], total: 0 });
    } catch { /* leer */ }
  };

  useEffect(() => { laden(); }, [tab]);

  // ─── Benutzer Aktionen ─────────────────────────────────────────────────────

  const userSpeichern = async (e) => {
    e.preventDefault();
    try {
      const body = { rolle_id: userModal.rolle_id || null };
      if (userModal.mode === 'neu') {
        body.username = userModal.username;
        body.password = userModal.password;
        await api.post('/benutzer', body);
      } else {
        if (userModal.password) body.password = userModal.password;
        await api.put(`/benutzer/${userModal.id}`, body);
      }
      setUserModal({ offen: false });
      laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Speichern', 'fehler');
    }
  };

  const userLoeschen = async (id) => {
    if (!(await nachfragen({
      titel: 'Benutzer löschen?', text: 'Der Zugang wird sofort ungültig.',
      bestaetigen: 'Löschen', gefaehrlich: true,
    }))) return;
    try {
      await api.delete(`/benutzer/${id}`);
      laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Löschen', 'fehler');
    }
  };

  // ─── Rollen Aktionen ───────────────────────────────────────────────────────

  const rolleSpeichern = async (e) => {
    e.preventDefault();
    try {
      const body = { name: rollenModal.name, rechte: rollenModal.rechte };
      if (rollenModal.mode === 'neu') {
        await api.post('/rollen', body);
      } else {
        await api.put(`/rollen/${rollenModal.id}`, body);
      }
      setRollenModal({ offen: false });
      laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Speichern', 'fehler');
    }
  };

  const rolleLoeschen = async (id) => {
    if (!(await nachfragen({
      titel: 'Rolle löschen?', text: 'Benutzer mit dieser Rolle verlieren ihre Rechte.',
      bestaetigen: 'Löschen', gefaehrlich: true,
    }))) return;
    try {
      await api.delete(`/rollen/${id}`);
      laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Löschen', 'fehler');
    }
  };

  const toggleRecht = (bereichId) => {
    setRollenModal(prev => ({
      ...prev,
      rechte: {
        ...prev.rechte,
        [bereichId]: !prev.rechte[bereichId],
      }
    }));
  };

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-4 border-b border-panel-border">
        {[
          { id: 'benutzer', label: 'Benutzer', Icon: Users },
          { id: 'rollen', label: 'Rollen', Icon: Shield },
          { id: 'authlog', label: 'Auth-Log', Icon: Clock },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`pb-3 px-1 flex items-center gap-2 border-b-2 transition-colors ${
              tab === t.id ? 'border-panel-accent text-panel-accent' : 'border-transparent text-panel-muted hover:text-white'
            }`}
          >
            <t.Icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {error && <div className="card text-panel-red border border-panel-red/20">{error}</div>}

      {/* ─── TAB: BENUTZER ─────────────────────────────────────────────────── */}
      {tab === 'benutzer' && (
        <div className="card !p-0 overflow-hidden">
          <div className="p-4 border-b border-panel-border flex justify-between items-center bg-panel-card/50">
            <h2 className="font-medium">Benutzerkonten</h2>
            <button
              onClick={() => setUserModal({ offen: true, mode: 'neu', username: '', password: '', rolle_id: rollen[0]?.id || '' })}
              className="btn flex items-center gap-2"
            >
              <Plus size={16} /> Neuer Benutzer
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                <th className="py-2 px-4">Benutzername</th>
                <th className="py-2 px-4">Rolle</th>
                <th className="py-2 px-4">Letzter Login</th>
                <th className="py-2 px-4 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {benutzer.map(u => (
                <tr key={u.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                  <td className="py-3 px-4 font-medium">{u.username}</td>
                  <td className="py-3 px-4">
                    <span className="bg-panel-bg px-2 py-1 rounded text-xs border border-panel-border">{u.rolle_name || 'Keine'}</span>
                  </td>
                  <td className="py-3 px-4 text-panel-muted text-xs">
                    {u.letzter_login ? new Date(u.letzter_login).toLocaleString('de-DE') : 'Nie'}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => setUserModal({ offen: true, mode: 'edit', id: u.id, username: u.username, password: '', rolle_id: u.rolle_id || '' })}
                      className="btn-ghost !px-2 text-panel-muted hover:text-white"
                      title="Bearbeiten"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button
                      onClick={() => userLoeschen(u.id)}
                      className="btn-ghost !px-2 text-panel-red"
                      title="Löschen"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── TAB: ROLLEN ───────────────────────────────────────────────────── */}
      {tab === 'rollen' && (
        <div className="card !p-0 overflow-hidden">
          <div className="p-4 border-b border-panel-border flex justify-between items-center bg-panel-card/50">
            <h2 className="font-medium">Rollen & Rechte</h2>
            <button
              onClick={() => setRollenModal({ offen: true, mode: 'neu', name: '', rechte: {} })}
              className="btn flex items-center gap-2"
            >
              <Plus size={16} /> Neue Rolle
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                <th className="py-2 px-4">Name</th>
                <th className="py-2 px-4">Berechtigungen</th>
                <th className="py-2 px-4">Nutzer</th>
                <th className="py-2 px-4 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {rollen.map(r => (
                <tr key={r.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                  <td className="py-3 px-4 font-medium flex items-center gap-2">
                    {r.name}
                    {r.fest === 1 && <span className="text-[10px] bg-panel-accent/20 text-panel-accent px-1.5 py-0.5 rounded uppercase font-bold tracking-wider">System</span>}
                  </td>
                  <td className="py-3 px-4 text-xs text-panel-muted leading-relaxed">
                    {Object.entries(r.rechte).filter(([_, val]) => val).map(([key]) => key).join(', ') || 'Keine'}
                  </td>
                  <td className="py-3 px-4 text-xs">{r.nutzer_anzahl}</td>
                  <td className="py-3 px-4 text-right">
                    {r.fest === 0 ? (
                      <>
                        <button
                          onClick={() => setRollenModal({ offen: true, mode: 'edit', id: r.id, name: r.name, rechte: r.rechte })}
                          className="btn-ghost !px-2 text-panel-muted hover:text-white"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button onClick={() => rolleLoeschen(r.id)} className="btn-ghost !px-2 text-panel-red">
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-panel-muted px-2">Gesperrt</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── TAB: AUTH-LOG ─────────────────────────────────────────────────── */}
      {tab === 'authlog' && (
        <div className="card !p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                <th className="py-2 px-4 w-10"></th>
                <th className="py-2 px-4">Zeitpunkt</th>
                <th className="py-2 px-4">Benutzer</th>
                <th className="py-2 px-4">IP / Herkunft</th>
                <th className="py-2 px-4">Methode</th>
              </tr>
            </thead>
            <tbody>
              {authLog.logs.map(log => (
                <tr key={log.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                  <td className="py-2 px-4 text-center">
                    {log.erfolg ? <CheckCircle2 size={16} className="text-green-500 inline" /> : <XCircle size={16} className="text-panel-red inline" />}
                  </td>
                  <td className="py-2 px-4 text-xs text-panel-muted">
                    {new Date(log.created_at).toLocaleString('de-DE')}
                  </td>
                  <td className="py-2 px-4 font-medium">{log.username}</td>
                  <td className="py-2 px-4 text-xs">
                    {log.ip} <span className="text-panel-muted">{log.herkunft ? `(${log.herkunft})` : ''}</span>
                  </td>
                  <td className="py-2 px-4 text-xs text-panel-muted">{log.methode}</td>
                </tr>
              ))}
              {authLog.logs.length === 0 && (
                <tr><td colSpan="5" className="p-4 text-center text-panel-muted">Keine Logs vorhanden.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── MODAL: BENUTZER ───────────────────────────────────────────────── */}
      {userModal.offen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={userSpeichern} className="card w-full max-w-md space-y-4 shadow-2xl">
            <h2 className="text-xl font-semibold">{userModal.mode === 'neu' ? 'Neuer Benutzer' : 'Benutzer bearbeiten'}</h2>
            
            <label className="block space-y-1">
              <span className="text-sm font-medium">Benutzername</span>
              <input
                type="text" required minLength="3"
                value={userModal.username}
                onChange={e => setUserModal(p => ({ ...p, username: e.target.value }))}
                disabled={userModal.mode === 'edit'}
                className="w-full disabled:opacity-50"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Rolle</span>
              <select
                value={userModal.rolle_id}
                onChange={e => setUserModal(p => ({ ...p, rolle_id: e.target.value }))}
                className="w-full"
                required
              >
                <option value="">-- Rolle wählen --</option>
                {rollen.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Passwort {userModal.mode === 'edit' && '(nur zum Ändern)'}</span>
              <input
                type="password"
                minLength="10"
                required={userModal.mode === 'neu'}
                value={userModal.password}
                onChange={e => setUserModal(p => ({ ...p, password: e.target.value }))}
                className="w-full"
                placeholder={userModal.mode === 'edit' ? 'Leer lassen für keine Änderung' : ''}
              />
            </label>

            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setUserModal({ offen: false })} className="btn-ghost flex-1">Abbrechen</button>
              <button type="submit" className="btn flex-1">Speichern</button>
            </div>
          </form>
        </div>
      )}

      {/* ─── MODAL: ROLLE ──────────────────────────────────────────────────── */}
      {rollenModal.offen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={rolleSpeichern} className="card w-full max-w-lg space-y-4 shadow-2xl">
            <h2 className="text-xl font-semibold">{rollenModal.mode === 'neu' ? 'Neue Rolle' : 'Rolle bearbeiten'}</h2>
            
            <label className="block space-y-1">
              <span className="text-sm font-medium">Name der Rolle</span>
              <input
                type="text" required minLength="2"
                value={rollenModal.name}
                onChange={e => setRollenModal(p => ({ ...p, name: e.target.value }))}
                className="w-full"
              />
            </label>

            <div className="space-y-2 pt-2">
              <span className="text-sm font-medium">Berechtigungen (Zugriff auf Bereiche)</span>
              <div className="grid grid-cols-2 gap-2 bg-panel-bg p-3 rounded border border-panel-border h-48 overflow-y-auto">
                {BEREICHE.map(b => (
                  <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-panel-card p-1 rounded">
                    <input
                      type="checkbox"
                      checked={!!rollenModal.rechte[b.id]}
                      onChange={() => toggleRecht(b.id)}
                      className="accent-panel-accent w-4 h-4"
                    />
                    {b.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setRollenModal({ offen: false })} className="btn-ghost flex-1">Abbrechen</button>
              <button type="submit" className="btn flex-1">Speichern</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
