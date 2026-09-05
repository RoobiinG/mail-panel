import { useEffect, useState } from 'react';
import {
  RefreshCw, Download, Play, Pause, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Loader2, AlertTriangle, KeyRound,
} from 'lucide-react';
import api from '../api';
import AktionenBereich from '../components/AktionenBereich';

const zeit = (w) => (w ? new Date(w).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// n8n reicht die Fehlermeldung des Dienstes durch — englisch und ohne Hinweis,
// was zu tun ist. Die vier Meldungen hier sind die, die im Betrieb wirklich
// vorkommen; alles andere bleibt unkommentiert stehen.
const ERKLAERUNGEN = [
  [/too many requests|rate limit|resource.?exhausted|\b429\b/i,
    'Google hat abgewiesen. Zwei Möglichkeiten: das Minutenlimit — dann hilft eine längere '
    + 'Pause unter Einstellungen → KI — oder das Tageskontingent des Gratis-Tarifs, dann geht es '
    + 'morgen weiter. Setze das KI-Tagesbudget so, dass das Panel vorher stoppt: Ein Lauf, der '
    + 'sauber endet, ist besser als einer, der mittendrin abbricht.'],
  [/credential with id .* does not exist|credentials not found|missing credential/i,
    'Die Zugangsdaten fehlen in n8n. Auf dieser Seite oben: „Zugangsdaten erneuern" — das legt '
    + 'sie neu an und trägt sie in alle Workflows ein.'],
  [/no folder|unknown mailbox|does not exist.*mailbox|\[NONEXISTENT\]/i,
    'Der Zielordner fehlt im Postfach. Unter Konten anlegen lassen oder unter Sortierung → '
    + 'Themen-Ordner aus dem Postfach einlesen.'],
  [/api key not valid|invalid api key|permission denied|401|403/i,
    'Der hinterlegte Schlüssel wird abgelehnt. Unter Einstellungen prüfen und neu speichern.'],
];

function erklaerung(text) {
  const treffer = ERKLAERUNGEN.find(([muster]) => muster.test(String(text || '')));
  return treffer ? treffer[1] : '';
}

function StatusPunkt({ status }) {
  if (status === 'success') return <CheckCircle2 size={15} className="text-emerald-500" />;
  if (status === 'error' || status === 'crashed') return <XCircle size={15} className="text-red-500" />;
  if (status === 'running' || status === 'waiting') return <Loader2 size={15} className="animate-spin text-panel-muted" />;
  return <span className="text-panel-muted text-xs">{status}</span>;
}

// Aufgeklappte Ansicht: Knoten des Workflows und die letzten Läufe
function Einzelheiten({ id }) {
  const [details, setDetails] = useState(null);
  const [laeufe, setLaeufe] = useState([]);
  const [lauf, setLauf] = useState(null);

  useEffect(() => {
    api.get(`/workflows/${id}`).then((r) => setDetails(r.data)).catch(() => setDetails({ knoten: [] }));
    api.get(`/workflows/${id}/laeufe`).then((r) => setLaeufe(r.data)).catch(() => setLaeufe([]));
  }, [id]);

  const lauföffnen = async (lid) => {
    setLauf({ laedt: true });
    try {
      const r = await api.get(`/workflows/lauf/${lid}`);
      setLauf(r.data);
    } catch (err) {
      setLauf({ fehlermeldung: err.response?.data?.error || 'Konnte nicht geladen werden' });
    }
  };

  if (!details) return <p className="text-sm text-panel-muted px-4 py-3">Lade…</p>;

  const stillgelegt = details.knoten.filter((k) => k.stillgelegt);

  return (
    <div className="border-t border-panel-border bg-panel-bg/40 px-4 py-4 space-y-4">
      {stillgelegt.length > 0 && (
        <div className="flex gap-2 text-sm text-panel-orange">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            Stillgelegt, weil keine Zugangsdaten hinterlegt sind:{' '}
            {stillgelegt.map((k) => k.name).join(', ')}. Sobald die Zugangsdaten da sind,
            laufen sie beim nächsten Synchronisieren wieder mit.
          </span>
        </div>
      )}

      <div>
        <h4 className="text-xs uppercase tracking-wide text-panel-muted mb-2">Knoten</h4>
        <div className="flex flex-wrap gap-1.5">
          {details.knoten.map((k) => (
            <span
              key={k.name}
              title={k.typ + (k.vomPanel ? ' — wird vom Panel verwaltet' : '')}
              className={`text-xs px-2 py-1 rounded border ${
                k.stillgelegt
                  ? 'border-panel-border text-panel-muted line-through'
                  : k.vomPanel
                    ? 'border-panel-accent/50 text-panel-accent'
                    : 'border-panel-border text-panel-text'
              }`}
            >
              {k.name}
            </span>
          ))}
        </div>
        <p className="text-xs text-panel-muted mt-2">
          Blau markierte Knoten legt das Panel bei jedem Konto-Sync neu an — Änderungen
          daran in n8n gehen dabei verloren.
        </p>
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-panel-muted mb-2">Letzte Läufe</h4>
        {laeufe.length === 0 ? (
          <p className="text-sm text-panel-muted">Noch keine Ausführung.</p>
        ) : (
          <ul className="space-y-1">
            {laeufe.slice(0, 8).map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => lauföffnen(l.id)}
                  className="w-full flex items-center gap-3 text-sm px-2 py-1 rounded hover:bg-panel-card text-left"
                >
                  <StatusPunkt status={l.status} />
                  <span className="text-panel-muted">{zeit(l.gestartet)}</span>
                  <span className="text-xs text-panel-muted ml-auto">{l.modus}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lauf && (
        <div className="card !p-3 text-sm">
          {lauf.laedt ? (
            <span className="text-panel-muted">Lade Ausführung…</span>
          ) : (
            <>
              {lauf.fehlermeldung && (
                <>
                  <p className="text-panel-red mb-2">{lauf.fehlermeldung}</p>
                  {erklaerung(lauf.fehlermeldung) && (
                    <p className="text-panel-muted mb-2 text-xs">{erklaerung(lauf.fehlermeldung)}</p>
                  )}
                </>
              )}
              <ul className="space-y-1">
                {(lauf.knoten || []).map((k) => (
                  <li key={k.name} className="flex gap-2">
                    <span className={k.fehler ? 'text-panel-red' : 'text-emerald-500'}>
                      {k.fehler ? '✕' : '✓'}
                    </span>
                    <span className="text-panel-text">{k.name}</span>
                    <span className="text-panel-muted">
                      {k.fehler ? k.fehler : `${k.items} Element(e)`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Workflows() {
  const [workflows, setWorkflows] = useState(null);
  const [fehler, setFehler] = useState('');
  const [meldung, setMeldung] = useState('');
  const [offen, setOffen] = useState(null);
  const [laeuft, setLaeuft] = useState(false);

  const laden = async () => {
    setFehler('');
    try {
      const r = await api.get('/workflows');
      setWorkflows(r.data);
    } catch (err) {
      setWorkflows([]);
      setFehler(err.response?.data?.error || 'n8n ist nicht erreichbar.');
    }
  };
  useEffect(() => { laden(); }, []);

  const umschalten = async (w) => {
    setMeldung('');
    setFehler('');
    try {
      await api.post(`/workflows/${w.id}/aktiv`, { aktiv: !w.aktiv });
      await laden();
      setMeldung(`„${w.name}" ist jetzt ${w.aktiv ? 'aus' : 'an'}.`);
    } catch (err) {
      setFehler(err.response?.data?.error || 'Umschalten fehlgeschlagen.');
    }
  };

  const aktion = async (pfad, text) => {
    setLaeuft(true);
    setMeldung('');
    setFehler('');
    try {
      await api.post(`/workflows/${pfad}`);
      await laden();
      setMeldung(text);
    } catch (err) {
      setFehler(err.response?.data?.error || 'Hat nicht geklappt.');
    } finally {
      setLaeuft(false);
    }
  };

  if (!workflows) return <p className="text-panel-muted">Lade…</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-panel-muted mt-1">
            Die Automatisierungen in n8n — hier steuerbar, ohne sich dort anmelden zu müssen.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {/* Hilft gegen „Credential with ID … does not exist": Das Panel vergisst
              die gemerkten IDs und legt beim Sync frische an. */}
          <button onClick={() => aktion('zugangsdaten-erneuern', 'Zugangsdaten wurden in n8n neu angelegt.')}
            disabled={laeuft} className="btn-ghost flex items-center gap-2"
            title="Wenn n8n meldet, ein Credential existiere nicht">
            <KeyRound size={16} /> Zugangsdaten erneuern
          </button>
          <button onClick={() => aktion('neu-importieren', 'Fehlende Workflows wurden importiert.')}
            disabled={laeuft} className="btn-ghost flex items-center gap-2">
            <Download size={16} /> Neu importieren
          </button>
          <button onClick={() => aktion('sync', 'Konten wurden neu verdrahtet.')}
            disabled={laeuft} className="btn-primary flex items-center gap-2">
            <RefreshCw size={16} className={laeuft ? 'animate-spin' : ''} /> Synchronisieren
          </button>
        </div>
      </div>

      {meldung && <div className="card !py-3 text-sm">{meldung}</div>}
      {fehler && <div className="card !py-3 text-sm text-panel-red">{fehler}</div>}

      <div className="card !p-0 overflow-hidden">
        {workflows.length === 0 ? (
          <p className="p-5 text-sm text-panel-muted">
            Keine Workflows gefunden. Trage unter Einstellungen den n8n-API-Key ein und
            klicke dann auf „Neu importieren".
          </p>
        ) : (
          <ul className="divide-y divide-panel-border">
            {workflows.map((w) => (
              <li key={w.id}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    onClick={() => setOffen(offen === w.id ? null : w.id)}
                    className="text-panel-muted hover:text-panel-text"
                    title="Einzelheiten"
                  >
                    {offen === w.id ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{w.name}</div>
                    <div className="text-xs text-panel-muted flex items-center gap-2">
                      {w.letzterLauf ? (
                        <>
                          <StatusPunkt status={w.letzterLauf.status} />
                          <span>zuletzt {zeit(w.letzterLauf.zeitpunkt)}</span>
                        </>
                      ) : (
                        <span>noch nie gelaufen</span>
                      )}
                    </div>
                  </div>

                  <span className={`text-xs px-2 py-1 rounded-full border ${
                    w.aktiv ? 'border-emerald-500/60 text-emerald-500' : 'border-panel-border text-panel-muted'
                  }`}>
                    {w.aktiv ? 'aktiv' : 'aus'}
                  </span>

                  <button onClick={() => umschalten(w)} className="btn-ghost !py-1 !px-2 flex items-center gap-1 text-xs">
                    {w.aktiv ? <><Pause size={14} /> Aus</> : <><Play size={14} /> An</>}
                  </button>
                </div>

                {offen === w.id && <Einzelheiten id={w.id} />}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pt-2 border-t border-panel-border">
        <AktionenBereich />
      </div>
    </div>
  );
}
