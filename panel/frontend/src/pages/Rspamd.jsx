import { useEffect, useState } from 'react';
import { Filter, RefreshCw, Server, AlertTriangle } from 'lucide-react';
import api from '../api';

export default function Rspamd() {
  const [daten, setDaten] = useState({ whitelist: [], blacklist: [], scores: [] });
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState('');
  const [syncLaedt, setSyncLaedt] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [mcDisabled, setMcDisabled] = useState(false);

  useEffect(() => {
    ladeDaten();
  }, []);

  const ladeDaten = async () => {
    setLaedt(true);
    setFehler('');
    try {
      const { data } = await api.get('/rspamd/policy');
      if (data.disabled) {
        setMcDisabled(true);
      } else {
        setDaten(data);
        setMcDisabled(false);
      }
    } catch (err) {
      setFehler(err.response?.data?.error || 'Fehler beim Laden der Rspamd-Daten.');
    } finally {
      setLaedt(false);
    }
  };

  const syncPanelWhitelist = async () => {
    setSyncLaedt(true);
    setSyncMsg('');
    try {
      const { data } = await api.post('/rspamd/sync');
      setSyncMsg(data.msg || 'Sync erfolgreich.');
      await ladeDaten(); // Refresh nach dem Sync
    } catch (err) {
      setSyncMsg(err.response?.data?.error || 'Fehler beim Synchronisieren.');
    } finally {
      setSyncLaedt(false);
    }
  };

  if (laedt && !daten.whitelist.length) return <p className="text-panel-muted">Lade Rspamd-Daten…</p>;

  if (mcDisabled) {
    return (
      <div className="space-y-6 max-w-5xl">
        <h1 className="text-2xl font-semibold">Rspamd-Konfiguration</h1>
        <div className="card text-center py-10 space-y-3">
          <Server size={40} className="mx-auto text-panel-muted opacity-50" />
          <p className="text-panel-muted">Mailcow ist im Panel nicht eingerichtet.</p>
          <p className="text-sm text-panel-muted">Diese Ansicht benötigt die Mailcow-API.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Filter size={24} className="text-panel-accent" /> Rspamd-Richtlinien (Mailcow)
        </h1>
        <button 
          onClick={syncPanelWhitelist} 
          disabled={syncLaedt}
          className="btn-primary flex items-center gap-2"
        >
          <RefreshCw size={16} className={syncLaedt ? 'animate-spin' : ''} />
          Panel-Whitelist nach Mailcow kopieren
        </button>
      </div>

      {fehler && <div className="p-3 bg-panel-red/10 border border-panel-red/30 text-panel-red rounded text-sm">{fehler}</div>}
      {syncMsg && <div className="p-3 bg-panel-green/10 border border-panel-green/30 text-panel-green rounded text-sm">{syncMsg}</div>}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card space-y-4">
          <h2 className="font-medium text-lg">Mailcow Whitelist (Global & Domain)</h2>
          <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
            {daten.whitelist.length === 0 ? (
              <p className="text-sm text-panel-muted">Keine Whitelist-Einträge vorhanden.</p>
            ) : (
              daten.whitelist.map((w, i) => (
                <div key={i} className="bg-panel-surface border border-panel-border p-2 rounded flex justify-between text-sm">
                  <span>{w.object}</span>
                  <span className="text-panel-muted text-xs">{w.list}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card space-y-4">
          <h2 className="font-medium text-lg">Mailcow Blacklist</h2>
          <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
            {daten.blacklist.length === 0 ? (
              <p className="text-sm text-panel-muted">Keine Blacklist-Einträge vorhanden.</p>
            ) : (
              daten.blacklist.map((b, i) => (
                <div key={i} className="bg-panel-surface border border-panel-border p-2 rounded flex justify-between text-sm">
                  <span>{b.object}</span>
                  <span className="text-panel-muted text-xs">{b.list}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium text-lg flex items-center gap-2">
          <AlertTriangle size={18} className="text-panel-orange" /> Spam-Schwellwerte (Spam-Scores)
        </h2>
        <p className="text-sm text-panel-muted">
          Hier siehst du die aktuellen Spam-Scores deiner Mailcow-Postfächer.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-panel-border text-panel-muted">
                <th className="py-2 px-3 font-medium">Postfach / Domain</th>
                <th className="py-2 px-3 font-medium text-center">Greylist</th>
                <th className="py-2 px-3 font-medium text-center">Spam</th>
                <th className="py-2 px-3 font-medium text-center">Reject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-panel-border">
              {daten.scores.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-panel-muted">Keine angepassten Scores gefunden (Standardwerte gelten).</td>
                </tr>
              ) : (
                daten.scores.map((s, i) => (
                  <tr key={i} className="hover:bg-panel-surface">
                    <td className="py-2 px-3 font-medium">{s.domain || s.mailbox || 'Global'}</td>
                    <td className="py-2 px-3 text-center">{s.greylist ?? 'Std'}</td>
                    <td className="py-2 px-3 text-center text-panel-orange">{s.spam ?? 'Std'}</td>
                    <td className="py-2 px-3 text-center text-panel-red">{s.reject ?? 'Std'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
