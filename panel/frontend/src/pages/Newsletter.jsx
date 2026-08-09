import React, { useState, useEffect } from 'react';
import api from '../api';

export default function Newsletter() {
  const [daten, setDaten] = useState([]);
  const [loading, setLoading] = useState(true);
  const [abbestellenLäuft, setAbbestellenLäuft] = useState(null);
  const [fehler, setFehler] = useState('');

  const laden = async () => {
    try {
      const res = await api.get('/newsletter');
      setDaten(res.data);
    } catch (err) {
      setFehler('Konnte Newsletter nicht laden.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { laden(); }, []);

  const abbestellen = async (id) => {
    setFehler('');
    setAbbestellenLäuft(id);
    try {
      const res = await api.post('/newsletter/unsubscribe', { id });
      if (res.data.success) {
        // Aktualisieren
        await laden();
      }
    } catch (err) {
      setFehler(err.response?.data?.error || 'Fehler beim Abbestellen.');
    } finally {
      setAbbestellenLäuft(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-semibold">Newsletter-Übersicht</h1>
          <p className="text-sm text-panel-muted mt-1">
            Alle von der KI als "Newsletter" erkannten Absender. Wenn ein Abmelden-Link gefunden wurde, kannst du den Newsletter hier mit einem Klick abbestellen.
          </p>
        </div>
      </div>

      {fehler && <div className="bg-red-500/10 border border-red-500/50 text-red-500 p-4 rounded">{fehler}</div>}

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-white/[0.02]">
                <th className="p-4 font-medium text-panel-muted">Absender</th>
                <th className="p-4 font-medium text-panel-muted w-32">Anzahl</th>
                <th className="p-4 font-medium text-panel-muted w-48">Zuletzt gesehen</th>
                <th className="p-4 font-medium text-panel-muted w-48 text-right">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td colSpan="4" className="p-4 text-center text-panel-muted">Lade Daten...</td>
                </tr>
              ) : daten.length === 0 ? (
                <tr>
                  <td colSpan="4" className="p-4 text-center text-panel-muted">Noch keine Newsletter erfasst.</td>
                </tr>
              ) : (
                daten.map((row) => (
                  <tr key={row.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="p-4 font-medium truncate max-w-[200px]" title={row.absender}>
                      {row.absender}
                    </td>
                    <td className="p-4 text-panel-muted">
                      <span className="bg-panel-bg px-2 py-1 rounded text-xs border border-white/5">
                        {row.anzahl} {row.anzahl === 1 ? 'Mail' : 'Mails'}
                      </span>
                    </td>
                    <td className="p-4 text-panel-muted text-sm">
                      {new Date(row.zuletzt_gesehen).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute:'2-digit' })}
                    </td>
                    <td className="p-4 text-right">
                      {row.abbestellt_am ? (
                        <span className="text-emerald-500 text-sm flex items-center justify-end gap-1">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Abbestellt
                        </span>
                      ) : row.list_unsubscribe ? (
                        <button
                          onClick={() => abbestellen(row.id)}
                          disabled={abbestellenLäuft === row.id}
                          className="px-3 py-1.5 text-sm bg-panel-bg hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 border border-white/10 rounded transition-colors disabled:opacity-50"
                        >
                          {abbestellenLäuft === row.id ? 'Läuft...' : 'Abbestellen'}
                        </button>
                      ) : (
                        <span className="text-panel-muted text-sm" title="Kein List-Unsubscribe Header gefunden">Nicht unterstützt</span>
                      )}
                    </td>
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
