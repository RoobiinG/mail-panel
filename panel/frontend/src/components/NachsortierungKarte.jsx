import { useEffect, useState } from 'react';
import {
  Repeat, ChevronDown, ChevronRight, Loader2, AlertTriangle, ArrowRight, Play,
} from 'lucide-react';
import api from '../api';
import { useMelden } from './ui/Meldungen';

// Derselbe Schalter wie in der Belege-Karte — bewusst kopiert statt geteilt:
// Die beiden Karten sollen sich unabhängig ändern lassen.
function Schalter({ an, onClick, disabled, laedt }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || laedt}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        an ? 'bg-emerald-500' : 'bg-panel-border'
      }`}
      aria-pressed={an}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${an ? 'translate-x-5' : 'translate-x-0.5'}`} />
      {laedt && <Loader2 size={12} className="absolute -right-5 animate-spin text-panel-muted" />}
    </button>
  );
}

const zeit = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('de-DE');
};

export default function NachsortierungKarte() {
  const { melden, nachfragen } = useMelden();
  const [daten, setDaten] = useState(null);
  const [busy, setBusy] = useState('');
  const [listeOffen, setListeOffen] = useState(false);

  const laden = () => api.get('/sortierung/nachsortierung')
    .then((r) => setDaten(r.data)).catch(() => setDaten(null));
  useEffect(() => { laden(); }, []);

  // Solange ein Lauf arbeitet, alle fünf Sekunden nachsehen. Ein Postfach mit
  // 20.000 Mails braucht Minuten — ohne das bliebe die Karte stumm stehen.
  useEffect(() => {
    if (!daten?.laeuft) return undefined;
    const t = setInterval(laden, 5000);
    return () => clearInterval(t);
  }, [daten?.laeuft]);

  if (!daten) return null;
  const letzter = daten.letzter;

  const setzen = async (feld, wert) => {
    setBusy(feld);
    try {
      await api.post('/sortierung/nachsortierung', { [feld]: wert });
      await laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Konnte die Einstellung nicht ändern.', 'fehler');
    } finally {
      setBusy('');
    }
  };

  const starten = async (trockenlauf) => {
    if (!trockenlauf) {
      const ok = await nachfragen({
        titel: 'Jetzt wirklich verschieben?',
        text: 'Alle Mails im Postfach werden gegen deine Regeln geprüft und gegebenenfalls verschoben. '
          + `Höchstens ${daten.max} Mails je Lauf. Sieh dir vorher an, was der Trockenlauf vorschlägt.`,
        bestaetigen: 'Verschieben',
        gefaehrlich: true,
      });
      if (!ok) return;
    }
    setBusy('start');
    try {
      await api.post('/sortierung/nachsortierung/start', { trockenlauf });
      melden(trockenlauf
        ? 'Prüfung läuft — das Ergebnis erscheint gleich hier.'
        : 'Nachsortierung läuft.');
      await laden();
    } catch (err) {
      melden(err.response?.data?.error || 'Konnte die Nachsortierung nicht starten.', 'fehler');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap items-center gap-2">
        <Repeat size={18} className="text-panel-accent" />
        <h2 className="font-medium">Nachsortierung</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          daten.aktiv ? 'border-emerald-500/60 text-emerald-500' : 'border-panel-border text-panel-muted'
        }`}>
          {daten.aktiv ? `alle ${daten.taktStunden} Std.` : 'aus'}
        </span>
        {daten.laeuft && (
          <span className="text-xs text-panel-accent flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> läuft gerade
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        <p className="text-xs text-panel-muted">
          Geht durch <span className="text-panel-text">alle Ordner des Postfachs</span> und verschiebt, wofür
          inzwischen eine Regel etwas anderes sagt. Ohne KI — es zählen nur deine Regeln. Papierkorb,
          Entwürfe, Gesendet und der Spam-Ordner bleiben unangetastet.
        </p>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium text-sm">Nachts automatisch nachsortieren</div>
            <div className="text-xs text-panel-muted mt-0.5">
              Prüft alle {daten.taktStunden} Stunden, höchstens {daten.max} Verschiebungen je Lauf.
            </div>
          </div>
          <Schalter an={daten.aktiv} onClick={() => setzen('aktiv', !daten.aktiv)} laedt={busy === 'aktiv'} />
        </div>

        <div className={`flex items-start justify-between gap-4 ${daten.aktiv ? '' : 'opacity-50'}`}>
          <div>
            <div className="font-medium text-sm">Nur anzeigen, nicht verschieben</div>
            <div className="text-xs text-panel-muted mt-0.5">
              Trockenlauf: Der Lauf schreibt auf, was er täte, und rührt nichts an.
              Lass das an, bis die Vorschläge unten stimmen.
            </div>
          </div>
          <Schalter an={daten.trockenlauf} onClick={() => setzen('trockenlauf', !daten.trockenlauf)}
            disabled={!daten.aktiv} laedt={busy === 'trockenlauf'} />
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => starten(true)} disabled={busy === 'start' || daten.laeuft}
            className="btn !py-1.5 !px-3 text-sm flex items-center gap-1">
            <Play size={14} /> Jetzt prüfen
          </button>
          <button onClick={() => starten(false)} disabled={busy === 'start' || daten.laeuft}
            className="btn-ghost !py-1.5 !px-3 text-sm">
            Prüfen und verschieben
          </button>
        </div>

        {letzter && (
          <div className="pt-2 border-t border-panel-border/50 space-y-2">
            <div className="text-xs text-panel-muted">
              Zuletzt {zeit(letzter.zeitpunkt)} · {letzter.geprueft} Mail(s) geprüft ·{' '}
              {letzter.trockenlauf
                ? <span className="text-panel-accent">{letzter.treffer} würden verschoben (nichts bewegt)</span>
                : <span className="text-emerald-500">{letzter.verschoben} von {letzter.treffer} verschoben</span>}
              {letzter.sekunden ? ` · ${letzter.sekunden} s` : ''}
            </div>

            {letzter.fehler?.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-panel-orange bg-panel-orange/10 rounded-lg p-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{letzter.fehler[0]}{letzter.fehler.length > 1 ? ` (und ${letzter.fehler.length - 1} weitere)` : ''}</span>
              </div>
            )}

            {letzter.beispiele?.length > 0 && (
              <>
                <button onClick={() => setListeOffen((o) => !o)}
                  className="text-xs text-panel-muted hover:text-panel-text flex items-center gap-1">
                  {listeOffen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {letzter.trockenlauf ? 'Vorschläge' : 'Verschoben'} ({letzter.beispiele.length}
                  {letzter.treffer > letzter.beispiele.length ? ` von ${letzter.treffer}` : ''})
                </button>
                {listeOffen && (
                  <div className="max-h-72 overflow-auto rounded-lg border border-panel-border divide-y divide-panel-border">
                    {letzter.beispiele.map((b, i) => (
                      <div key={i} className="p-2 text-xs">
                        <div className="truncate" title={`${b.von} — ${b.betreff}`}>
                          <span className="font-mono text-panel-muted">{b.von}</span>
                          {b.betreff ? <> · {b.betreff}</> : null}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 text-panel-muted">
                          <span className="font-mono">{b.vonOrdner}</span>
                          <ArrowRight size={11} className="text-panel-accent" />
                          <span className="font-mono text-panel-accent">{b.nachOrdner}</span>
                          <span className="ml-1 truncate" title={b.regel}>({b.regel})</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
