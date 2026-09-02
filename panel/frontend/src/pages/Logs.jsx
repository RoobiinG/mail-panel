import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Trash2, RefreshCw, ChevronDown, ChevronUp,
  AlertCircle, Info, TriangleAlert,
  Copy, Check, Square, CheckSquare,
} from 'lucide-react';
import api from '../api';
import { useMelden } from '../components/ui/Meldungen';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const LEVEL_STYLE = {
  error: {
    card:  'border-panel-red/40 bg-panel-red/5',
    icon:  AlertCircle,
    badge: 'bg-panel-red/15 text-panel-red',
  },
  warn: {
    card:  'border-yellow-500/40 bg-yellow-500/5',
    icon:  TriangleAlert,
    badge: 'bg-yellow-500/15 text-yellow-400',
  },
  info: {
    card:  'border-panel-accent/40 bg-panel-accent/5',
    icon:  Info,
    badge: 'bg-panel-accent/15 text-panel-accent',
  },
};

// Quellen-Chip-Farben (dynamisch anhand des Quellennamens)
const QUELLE_FARBEN = [
  'bg-yellow-500/15 text-yellow-400',
  'bg-blue-500/15 text-blue-400',
  'bg-orange-500/15 text-orange-400',
  'bg-green-500/15 text-green-400',
  'bg-purple-500/15 text-purple-400',
  'bg-pink-500/15 text-pink-400',
  'bg-teal-500/15 text-teal-400',
];
const quelleChipFarbe = (() => {
  const cache = {};
  let idx = 0;
  return (src) => {
    if (!cache[src]) cache[src] = QUELLE_FARBEN[idx++ % QUELLE_FARBEN.length];
    return cache[src];
  };
})();

function fmtDate(s) {
  const d = new Date(s);
  return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE');
}

// ─── Icon-Button mit kurzem Feedback ─────────────────────────────────────────

function IconAction({ icon: Icon, doneIcon: DoneIcon = Check, title, onClick }) {
  const [done, setDone] = useState(false);
  const handle = async () => {
    await onClick();
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  return (
    <button
      onClick={handle}
      title={title}
      className="p-1 rounded text-panel-muted/40 hover:text-panel-muted transition-colors"
    >
      {done
        ? <DoneIcon size={12} className="text-panel-accent" />
        : <Icon     size={12} />
      }
    </button>
  );
}

// ─── Log-Eintrag-Karte ────────────────────────────────────────────────────────

function LogEntry({ log, selected, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const style   = LEVEL_STYLE[log.level] ?? LEVEL_STYLE.error;
  const LevelIcon = style.icon;
  const src     = log.source || log.quelle || '—';
  const msg     = log.message || log.nachricht || '';
  const url     = log.url || log.request_url || null;

  const copyText = () => {
    const lines = [
      `[${(log.level || 'error').toUpperCase()}] ${fmtDate(log.created_at)}`,
      `Quelle: ${src}${url ? `  —  ${url}` : ''}`,
      '',
      msg,
    ];
    if (log.stack) lines.push('', log.stack);
    return navigator.clipboard.writeText(lines.join('\n'));
  };

  return (
    <div
      id={`log-${log.id}`}
      className={`border rounded-md px-3 py-2 text-xs transition-all ${style.card} ${
        selected ? 'ring-2 ring-panel-accent/60' : ''
      }`}
    >
      <div className="flex items-start gap-2">

        {/* Checkbox */}
        <button
          onClick={onToggle}
          className="flex-shrink-0 mt-0.5 text-panel-muted/40 hover:text-panel-accent transition-colors"
          title={selected ? 'Auswahl aufheben' : 'Auswählen'}
        >
          {selected
            ? <CheckSquare size={13} className="text-panel-accent" />
            : <Square      size={13} />
          }
        </button>

        <LevelIcon size={12} className="flex-shrink-0 mt-0.5" />

        <div className="flex-1 min-w-0">
          {/* Zeile 1: Quelle + Zeit + Aktions-Buttons */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${quelleChipFarbe(src)}`}>
              {src}
            </span>
            <span className="text-[10px] text-panel-muted/60 tabular-nums">
              {fmtDate(log.created_at)}
            </span>
            {url && (
              <span className="text-[10px] text-panel-muted/50 truncate max-w-[200px]" title={url}>
                {url}
              </span>
            )}
            {/* Aktions-Icons rechts */}
            <div className="ml-auto flex items-center gap-0.5">
              <IconAction
                icon={Copy}
                title="Fehlertext kopieren"
                onClick={copyText}
              />
            </div>
          </div>

          {/* Nachricht */}
          <p className="break-words leading-snug font-mono text-[11px]">{msg}</p>

          {/* Stack Trace */}
          {log.stack && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="flex items-center gap-1 mt-1.5 text-[10px] text-panel-muted/70 hover:text-panel-muted transition-colors"
            >
              {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              Stack Trace {expanded ? 'ausblenden' : 'anzeigen'}
            </button>
          )}
          {log.stack && expanded && (
            <pre className="mt-1.5 text-[10px] font-mono bg-black/20 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed text-panel-muted">
              {log.stack}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

export default function Logs() {
  const { nachfragen } = useMelden();
  const [logs,    setLogs]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [laedt,   setLaedt]   = useState(false);
  const [quellen, setQuellen] = useState([]);

  // Filter
  const [level,        setLevel]        = useState('');
  const [quelleFilter, setQuelleFilter] = useState('');
  const [seite,        setSeite]        = useState(0);

  // Auswahl
  const [ausgewaehlt, setAusgewaehlt] = useState(new Set());

  // Auto-Refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);

  const LIMIT = 50;

  const laden = useCallback(async (leise = false) => {
    if (!leise) setLaedt(true);
    setAusgewaehlt(new Set());
    try {
      const params = new URLSearchParams({
        limit:  String(LIMIT),
        offset: String(seite * LIMIT),
      });
      if (level)        params.set('level',  level);
      if (quelleFilter) params.set('source', quelleFilter);

      const { data } = await api.get(`/logs?${params}`);
      setLogs(data.logs  || []);
      setTotal(data.total || 0);
    } catch {
      // Fehler beim Laden ignorieren
    } finally {
      if (!leise) setLaedt(false);
    }
  }, [level, quelleFilter, seite]);

  const quellenLaden = useCallback(async () => {
    try {
      const { data } = await api.get('/logs/sources');
      setQuellen(data || []);
    } catch { /* ignorieren */ }
  }, []);

  useEffect(() => { laden(); quellenLaden(); }, [laden, quellenLaden]);

  // Auto-Refresh alle 10 s
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => laden(true), 10000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, laden]);

  // Filter-Änderung → Seite zurücksetzen
  const filterSetzen = (setter) => (val) => { setter(val); setSeite(0); };

  // ── Auswahl-Aktionen ────────────────────────────────────────────────────────

  const toggleEinen = (id) => setAusgewaehlt(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const alleIds       = logs.map(l => l.id);
  const alleGewaehlt  = alleIds.length > 0 && alleIds.every(id => ausgewaehlt.has(id));

  const alleToggle = () => {
    if (alleGewaehlt) setAusgewaehlt(new Set());
    else              setAusgewaehlt(new Set(alleIds));
  };

  const auswahlLoeschen = async () => {
    if (!ausgewaehlt.size) return;
    if (!(await nachfragen({
      titel: 'Einträge löschen?', text: `${ausgewaehlt.size} Eintrag(e) werden entfernt.`,
      bestaetigen: 'Löschen', gefaehrlich: true,
    }))) return;
    await api.delete('/logs/bulk', { data: { ids: [...ausgewaehlt] } }).catch(() => {});
    await laden();
    quellenLaden();
  };

  const [kopiert, setKopiert] = useState(false);
  const auswahlKopieren = () => {
    const ausgewLogs = logs.filter(l => ausgewaehlt.has(l.id));
    const text = ausgewLogs.map(log => {
      const msg = log.message || log.nachricht || '';
      const src = log.source  || log.quelle   || '—';
      const url = log.url     || log.request_url || null;
      return [
        `[${(log.level || 'error').toUpperCase()}] ${fmtDate(log.created_at)}`,
        `Quelle: ${src}${url ? `  —  ${url}` : ''}`,
        '',
        msg,
        ...(log.stack ? ['', log.stack] : []),
      ].join('\n');
    }).join('\n\n─────────────────────────\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    });
  };

  // ── Alle löschen ─────────────────────────────────────────────────────────────

  const alleLoeschen = async () => {
    if (!(await nachfragen({
      titel: 'Alle Logs löschen?', text: 'Der gesamte Verlauf wird entfernt. Das lässt sich nicht rückgängig machen.',
      bestaetigen: 'Alle löschen', gefaehrlich: true,
    }))) return;
    await api.delete('/logs').catch(() => {});
    setLogs([]);
    setTotal(0);
    setQuellen([]);
    setAusgewaehlt(new Set());
  };

  const seitenGesamt = Math.ceil(total / LIMIT);

  const selectCls = 'bg-panel-card border border-panel-border rounded px-2 py-1 text-xs text-panel-text focus:outline-none focus:border-panel-accent';

  return (
    <div className="space-y-3">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-panel-text">Panel-Logs</h1>
          {total > 0 && (
            <span className="px-1.5 py-0.5 bg-panel-red/20 text-panel-red text-[10px] rounded-full tabular-nums">
              {total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={level} onChange={e => filterSetzen(setLevel)(e.target.value)} className={selectCls}>
            <option value="">Alle Level</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
          </select>
          <select value={quelleFilter} onChange={e => filterSetzen(setQuelleFilter)(e.target.value)} className={selectCls}>
            <option value="">Alle Quellen</option>
            {quellen.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
          <button
            onClick={() => { setAutoRefresh(r => !r); }}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              autoRefresh
                ? 'border-panel-accent/50 text-panel-accent bg-panel-accent/10'
                : 'border-panel-border text-panel-muted hover:text-panel-text'
            }`}
            title={autoRefresh ? 'Auto-Refresh aus' : 'Auto-Refresh an (10 s)'}
          >
            <RefreshCw size={12} className={`inline mr-1 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Live' : 'Auto'}
          </button>
          <button
            onClick={() => laden()}
            disabled={laedt}
            className="px-2 py-1 text-xs rounded border border-panel-border text-panel-muted hover:text-panel-text transition-colors disabled:opacity-50"
          >
            {laedt ? 'Lädt…' : 'Aktualisieren'}
          </button>
          {total > 0 && (
            <button
              onClick={alleLoeschen}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-panel-red/40 text-panel-red hover:bg-panel-red/10 transition-colors"
            >
              <Trash2 size={12} />
              Alle löschen
            </button>
          )}
        </div>
      </div>

      {/* ── Auswahl-Toolbar ──────────────────────────────────────────────────── */}
      {ausgewaehlt.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-panel-accent/10 border border-panel-accent/30 rounded-md text-xs text-panel-accent">
          <button
            onClick={alleToggle}
            className="flex items-center gap-1.5 hover:text-panel-text transition-colors"
          >
            {alleGewaehlt ? <CheckSquare size={13} /> : <Square size={13} />}
            <span>{alleGewaehlt ? 'Alle abwählen' : 'Alle auswählen'}</span>
          </button>
          <span className="text-panel-muted/60">|</span>
          <span className="font-medium tabular-nums">{ausgewaehlt.size} ausgewählt</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={auswahlKopieren}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-panel-accent/30 hover:bg-panel-accent/20 transition-colors"
            >
              {kopiert
                ? <><Check size={11} className="text-panel-accent" /><span>Kopiert!</span></>
                : <><Copy  size={11} /><span>Kopieren</span></>
              }
            </button>
            <button
              onClick={auswahlLoeschen}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-panel-red/40 text-panel-red hover:bg-panel-red/10 transition-colors"
            >
              <Trash2 size={11} />
              Auswahl löschen
            </button>
          </div>
        </div>
      )}

      {/* Alle auswählen (wenn nichts selektiert, aber Logs vorhanden) */}
      {ausgewaehlt.size === 0 && logs.length > 0 && (
        <button
          onClick={alleToggle}
          className="flex items-center gap-1.5 text-[11px] text-panel-muted/50 hover:text-panel-muted transition-colors"
        >
          <Square size={12} />
          Alle auswählen
        </button>
      )}

      {/* ── Log-Liste ────────────────────────────────────────────────────────── */}
      <div className="card space-y-2">
        {laedt && logs.length === 0 ? (
          <p className="text-panel-muted text-sm text-center py-8">Lade…</p>
        ) : logs.length === 0 ? (
          <p className="text-panel-muted text-sm text-center py-8">
            {level || quelleFilter ? 'Keine Logs mit diesem Filter.' : 'Keine Log-Einträge vorhanden — alles grün!'}
          </p>
        ) : (
          logs.map(log => (
            <LogEntry
              key={log.id}
              log={log}
              selected={ausgewaehlt.has(log.id)}
              onToggle={() => toggleEinen(log.id)}
            />
          ))
        )}
      </div>

      {/* ── Paginierung ──────────────────────────────────────────────────────── */}
      {seitenGesamt > 1 && (
        <div className="flex items-center justify-center gap-2 text-xs text-panel-muted">
          <button
            disabled={seite === 0}
            onClick={() => setSeite(s => s - 1)}
            className="px-2 py-1 rounded border border-panel-border hover:text-panel-text transition-colors disabled:opacity-40"
          >
            ← Zurück
          </button>
          <span>Seite {seite + 1} / {seitenGesamt}</span>
          <button
            disabled={seite >= seitenGesamt - 1}
            onClick={() => setSeite(s => s + 1)}
            className="px-2 py-1 rounded border border-panel-border hover:text-panel-text transition-colors disabled:opacity-40"
          >
            Weiter →
          </button>
        </div>
      )}

      <p className="text-[10px] text-panel-muted/50 text-center">
        JavaScript-Fehler, unhandled Promises und Backend-Fehler werden automatisch erfasst.
      </p>
    </div>
  );
}
