import { useEffect, useState, useRef } from 'react';
import {
  Trash2, RefreshCw, ChevronDown, ChevronRight,
  AlertCircle, AlertTriangle, Info, Search,
} from 'lucide-react';
import api from '../api';

const LEVEL_ICON = {
  error: <AlertCircle size={15} className="text-panel-red" />,
  warn: <AlertTriangle size={15} className="text-yellow-400" />,
  info: <Info size={15} className="text-panel-accent" />,
};

const LEVEL_FARBE = {
  error: 'text-panel-red',
  warn: 'text-yellow-400',
  info: 'text-panel-accent',
};

const QUELLEN_FILTER = [
  { value: '', label: 'Alle Quellen' },
  { value: 'backend', label: 'Backend' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'container', label: 'Container' },
];

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [laedt, setLaedt] = useState(false);
  const [level, setLevel] = useState('');
  const [quelle, setQuelle] = useState('');
  const [suche, setSuche] = useState('');
  const [suchText, setSuchText] = useState('');
  const [seite, setSeite] = useState(0);
  const [aufgeklappt, setAufgeklappt] = useState(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);

  const LIMIT = 50;

  const laden = async (leise = false) => {
    if (!leise) setLaedt(true);
    try {
      const params = new URLSearchParams({
        limit: String(LIMIT),
        offset: String(seite * LIMIT),
      });
      if (level) params.set('level', level);
      if (quelle) params.set('quelle', quelle);
      if (suche) params.set('suche', suche);

      const { data } = await api.get(`/logs?${params}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch {
      // Fehler beim Laden ignorieren
    } finally {
      setLaedt(false);
    }
  };

  useEffect(() => { laden(); }, [level, quelle, suche, seite]);

  // Auto-Refresh
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => laden(true), 10000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, level, quelle, suche, seite]);

  const logsLeeren = async () => {
    if (!confirm('Alle Logs unwiderruflich löschen?')) return;
    try {
      await api.delete('/logs');
      laden();
    } catch { /* ignorieren */ }
  };

  const toggleAufklappen = (id) => {
    setAufgeklappt((prev) => {
      const neu = new Set(prev);
      if (neu.has(id)) neu.delete(id); else neu.add(id);
      return neu;
    });
  };

  const seitenGesamt = Math.ceil(total / LIMIT);

  const suchStarten = (e) => {
    e.preventDefault();
    setSuche(suchText);
    setSeite(0);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`btn-ghost flex items-center gap-1 text-xs ${autoRefresh ? 'text-panel-accent' : ''}`}
            title={autoRefresh ? 'Auto-Refresh aus' : 'Auto-Refresh an (10s)'}
          >
            <RefreshCw size={14} className={autoRefresh ? 'animate-spin' : ''} />
            {autoRefresh ? 'Live' : 'Auto'}
          </button>
          <button onClick={() => laden()} className="btn-ghost text-xs" disabled={laedt}>
            Aktualisieren
          </button>
          <button onClick={logsLeeren} className="btn-ghost text-xs text-panel-red flex items-center gap-1">
            <Trash2 size={14} /> Leeren
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="card">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block text-sm space-y-1">
            <span className="text-panel-muted">Level</span>
            <select value={level} onChange={(e) => { setLevel(e.target.value); setSeite(0); }}>
              <option value="">Alle Level</option>
              <option value="error">🔴 Error</option>
              <option value="warn">🟡 Warn</option>
              <option value="info">🔵 Info</option>
            </select>
          </label>
          <label className="block text-sm space-y-1">
            <span className="text-panel-muted">Quelle</span>
            <select value={quelle} onChange={(e) => { setQuelle(e.target.value); setSeite(0); }}>
              {QUELLEN_FILTER.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <form onSubmit={suchStarten} className="flex-1 min-w-[200px]">
            <label className="block text-sm space-y-1">
              <span className="text-panel-muted">Suche</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Freitext…"
                  value={suchText}
                  onChange={(e) => setSuchText(e.target.value)}
                  className="flex-1"
                />
                <button type="submit" className="btn-ghost !py-1">
                  <Search size={16} />
                </button>
              </div>
            </label>
          </form>
        </div>
      </div>

      {/* Ergebnis-Info */}
      <div className="flex justify-between items-center text-sm text-panel-muted">
        <span>{total} Einträge{laedt ? ' (lädt…)' : ''}</span>
        {seitenGesamt > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSeite(Math.max(0, seite - 1))}
              disabled={seite === 0}
              className="btn-ghost !py-1 !px-2 text-xs"
            >
              ← Zurück
            </button>
            <span>Seite {seite + 1} / {seitenGesamt}</span>
            <button
              onClick={() => setSeite(Math.min(seitenGesamt - 1, seite + 1))}
              disabled={seite >= seitenGesamt - 1}
              className="btn-ghost !py-1 !px-2 text-xs"
            >
              Weiter →
            </button>
          </div>
        )}
      </div>

      {/* Log-Tabelle */}
      <div className="card !p-0 overflow-hidden">
        {logs.length === 0 ? (
          <p className="p-6 text-center text-panel-muted">
            {laedt ? 'Lade Logs…' : 'Keine Log-Einträge vorhanden.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-panel-border text-left text-panel-muted text-xs">
                <th className="py-2 px-3 w-8"></th>
                <th className="py-2 px-3 w-[160px]">Zeitpunkt</th>
                <th className="py-2 px-3 w-16">Level</th>
                <th className="py-2 px-3 w-[180px]">Quelle</th>
                <th className="py-2 px-3">Nachricht</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const offen = aufgeklappt.has(log.id);
                return (
                  <tr key={log.id} className="group">
                    <td colSpan={5} className="p-0">
                      <div
                        className="flex items-start gap-0 cursor-pointer hover:bg-panel-card/50 transition-colors"
                        onClick={() => log.stack && toggleAufklappen(log.id)}
                      >
                        <div className="py-2 px-3 w-8 shrink-0">
                          {log.stack ? (
                            offen ? <ChevronDown size={14} className="text-panel-muted" /> : <ChevronRight size={14} className="text-panel-muted" />
                          ) : <span className="w-[14px] inline-block" />}
                        </div>
                        <div className="py-2 px-3 w-[160px] shrink-0 text-xs text-panel-muted font-mono">
                          {new Date(log.created_at).toLocaleString('de-DE', {
                            day: '2-digit', month: '2-digit', year: '2-digit',
                            hour: '2-digit', minute: '2-digit', second: '2-digit',
                          })}
                        </div>
                        <div className="py-2 px-3 w-16 shrink-0">
                          {LEVEL_ICON[log.level] || log.level}
                        </div>
                        <div className="py-2 px-3 w-[180px] shrink-0 text-xs font-mono text-panel-muted truncate" title={log.quelle}>
                          {log.quelle || '—'}
                        </div>
                        <div className={`py-2 px-3 flex-1 break-words ${LEVEL_FARBE[log.level] || ''}`}>
                          {log.nachricht}
                          {log.request_url && (
                            <span className="ml-2 text-xs text-panel-muted">
                              ({log.request_method} {log.request_url})
                            </span>
                          )}
                        </div>
                      </div>
                      {offen && log.stack && (
                        <div className="mx-3 mb-2 p-3 bg-panel-card border border-panel-border rounded-md">
                          <pre className="text-xs text-panel-muted font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-auto">
                            {log.stack}
                          </pre>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
