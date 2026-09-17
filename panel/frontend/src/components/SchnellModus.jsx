// Schnell-Modus der Sortier-Inbox: eine Gruppe nach der anderen, per Tastatur.
//
// Auch mit Bündeln bleibt bei 1.700 offenen Mails viel zu entscheiden, und
// jede Gruppe kostete Maus, Feld, Auswahl, Knopf. Hier ist es ein Tastendruck:
//
//   Enter      KI-Vorschlag übernehmen
//   1–9        einer der neun meistgenutzten Ordner
//   /          beliebigen Ordner tippen
//   P          im Posteingang lassen (ohne Regel)
//   Leertaste  überspringen (auch →)
//   ←          zurück
//   Esc        schließen
//
// Grundsätze wie bei den Inhalts-Bündeln: Verschoben werden genau die Mails
// der Karte (per ID), und es entstehen KEINE Regeln. Wer eine Regel will, nimmt
// die normale Ansicht.
//
// Die Gruppen werden beim Öffnen festgehalten. Würde die Liste nach jeder
// Aktion neu gebündelt, verrutschten die Karten unter dem Finger — erst beim
// Schließen lädt die Seite neu.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, Inbox, Wand2, X, Zap } from 'lucide-react';
import api from '../api';
import OrdnerFeld from './ui/OrdnerFeld';

const kurzname = (pfad) => String(pfad || '').split(/[/.]/).pop() || pfad;

export default function SchnellModus({ gruppen: start, schnellOrdner, ordnerOptionen, melden, onSchliessen }) {
  const [gruppen] = useState(start);
  const [pos, setPos] = useState(0);
  const [status, setStatus] = useState({});      // schluessel -> { art, text }
  const [laeuft, setLaeuft] = useState(false);
  const [tippen, setTippen] = useState(false);
  const [getippt, setGetippt] = useState('');
  const [hinweis, setHinweis] = useState('');
  const feldRef = useRef(null);

  const gruppe = gruppen[pos];
  const fertig = pos >= gruppen.length;
  const erledigteMails = Object.values(status).reduce((s, x) => s + (x.mails || 0), 0);
  const ordner = schnellOrdner.slice(0, 9);

  const weiter = () => { setHinweis(''); setPos((p) => Math.min(p + 1, gruppen.length)); };
  const zurueck = () => { setHinweis(''); setPos((p) => Math.max(p - 1, 0)); };

  const ausfuehren = async (aktion, ziel) => {
    if (!gruppe || laeuft) return;
    if (status[gruppe.schluessel]) {
      setHinweis('Diese Gruppe ist schon erledigt — Leertaste für die nächste.');
      return;
    }
    const ids = gruppe.mails.map((m) => m.id);
    setLaeuft(true);
    setHinweis('');
    try {
      if (aktion === 'verschieben') {
        const { data } = await api.post('/sortierung/inbox/verschieben', {
          konto_id: gruppe.mails[0].konto_id, ids, zielordner: ziel,
        });
        // Nichts bewegt, aber Fehler: Die Karte bleibt stehen, damit man
        // einen anderen Ordner wählen kann.
        if (data.verschoben === 0 && data.fehler?.length) {
          melden(`Nicht verschoben:\n${data.fehler.slice(0, 5).map((f) => `• ${f}`).join('\n')}`, 'fehler');
          return;
        }
        const teile = [`→ ${ziel}: ${data.verschoben} verschoben`];
        if (data.veraltet || data.nichtMehrOffen) teile.push(`${(data.veraltet || 0) + (data.nichtMehrOffen || 0)} schon weg`);
        if (data.fehler?.length) teile.push(`${data.fehler.length} Fehler`);
        setStatus((s) => ({ ...s, [gruppe.schluessel]: { art: 'verschoben', text: teile.join(' · '), mails: data.verschoben } }));
      } else {
        const { data } = await api.post('/sortierung/ignorieren', { ids });
        setStatus((s) => ({
          ...s, [gruppe.schluessel]: { art: 'ignoriert', text: 'bleibt im Posteingang', mails: data.ignoriert || 0 },
        }));
      }
      setTippen(false);
      setGetippt('');
      weiter();
    } catch (err) {
      melden(err.response?.data?.error || 'Aktion fehlgeschlagen', 'fehler');
    } finally {
      setLaeuft(false);
    }
  };

  // Die Tastatur. Solange eine Anfrage läuft, wird jede Taste verschluckt —
  // sonst trifft ein zweites Enter die nächste Karte, bevor man sie gesehen hat.
  useEffect(() => {
    const taste = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (laeuft) { e.preventDefault(); return; }
      if (tippen) {
        // Enter übernimmt das Formular, Pfeile gehören dem Ordnerfeld.
        if (e.key === 'Escape') { e.preventDefault(); setTippen(false); setGetippt(''); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); onSchliessen(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); zurueck(); return; }
      if (fertig) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (gruppe?.kiVorschlag) ausfuehren('verschieben', gruppe.kiVorschlag);
        else setHinweis('Kein KI-Vorschlag — eine Zahl von 1 bis 9 oder / zum Tippen.');
      } else if (/^[1-9]$/.test(e.key)) {
        const ziel = ordner[Number(e.key) - 1];
        if (ziel) { e.preventDefault(); ausfuehren('verschieben', ziel); }
      } else if (e.key === '/') {
        e.preventDefault();
        setTippen(true);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        ausfuehren('ignorieren');
      } else if (e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        weiter();
      }
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  });

  useEffect(() => {
    if (tippen) setTimeout(() => feldRef.current?.querySelector('input')?.focus(), 0);
  }, [tippen]);

  const erledigt = gruppe ? status[gruppe.schluessel] : null;

  return createPortal(
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-2xl space-y-4 shadow-2xl max-h-[92vh] overflow-auto" role="dialog" aria-label="Schnell-Modus">
        {/* Kopf: Fortschritt */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap size={18} className="text-panel-accent" /> Schnell-Modus
          </h2>
          <div className="text-xs text-panel-muted text-right">
            {fertig ? 'Fertig' : `Gruppe ${pos + 1} von ${gruppen.length}`} · {erledigteMails} Mails erledigt
          </div>
          <button onClick={onSchliessen} disabled={laeuft} className="btn-ghost !p-1.5" title="Schließen (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="h-1 rounded-full bg-panel-border overflow-hidden">
          <div
            className="h-full bg-panel-accent transition-all"
            style={{ width: `${gruppen.length ? (Math.min(pos, gruppen.length) / gruppen.length) * 100 : 100}%` }}
          />
        </div>

        {fertig ? (
          <div className="py-8 text-center space-y-3">
            <Check size={32} className="mx-auto text-panel-green" />
            <p className="text-sm">
              Alle {gruppen.length} Gruppen durchgesehen — {Object.keys(status).length} entschieden,
              {' '}{erledigteMails} Mails erledigt.
            </p>
            <div className="flex justify-center gap-2">
              <button onClick={zurueck} className="btn-ghost text-sm">Zurück</button>
              <button onClick={onSchliessen} className="btn text-sm">Schließen</button>
            </div>
          </div>
        ) : (
          <>
            {/* Die Karte */}
            <div className={`rounded-xl border p-4 space-y-2 ${erledigt ? 'border-panel-green/50 opacity-70' : 'border-panel-border bg-panel-bg/40'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-base break-all">{gruppe.titel}</span>
                <span className="bg-panel-border/60 text-xs px-1.5 py-0.5 rounded whitespace-nowrap">
                  {gruppe.mails.length} Mail{gruppe.mails.length === 1 ? '' : 's'}
                </span>
                {gruppe.info && <span className="text-xs text-panel-muted">{gruppe.info}</span>}
              </div>
              <ul className="text-sm text-panel-muted space-y-0.5">
                {gruppe.mails.slice(0, 5).map((m) => (
                  <li key={m.id} className="truncate" title={`${m.von} — ${m.betreff || ''}`}>
                    {m.betreff || '(Kein Betreff)'}
                  </li>
                ))}
                {gruppe.mails.length > 5 && <li className="text-xs">… und {gruppe.mails.length - 5} weitere</li>}
              </ul>
              {erledigt ? (
                <div className="text-sm text-panel-green flex items-center gap-1.5">
                  <Check size={14} /> {erledigt.text}
                </div>
              ) : gruppe.kiVorschlag ? (
                <div className="text-sm text-panel-accent flex items-center gap-1.5">
                  <Wand2 size={14} /> KI schlägt „{gruppe.kiVorschlag}" vor — <kbd className="kbd">Enter</kbd>
                </div>
              ) : (
                <div className="text-xs text-panel-muted">Kein KI-Vorschlag für diese Gruppe.</div>
              )}
            </div>

            {hinweis && <p className="text-xs text-panel-orange">{hinweis}</p>}

            {/* Beliebiger Ordner */}
            {tippen ? (
              <form
                ref={feldRef}
                onSubmit={(e) => { e.preventDefault(); if (getippt.trim()) ausfuehren('verschieben', getippt.trim()); }}
                className="flex gap-2"
              >
                <OrdnerFeld
                  value={getippt}
                  onChange={setGetippt}
                  optionen={ordnerOptionen}
                  placeholder="Ordner tippen, Enter verschiebt, Esc bricht ab"
                  className="flex-1 min-w-0 text-sm"
                />
                <button type="submit" disabled={laeuft || !getippt.trim()} className="btn !py-1.5 !px-3 text-sm disabled:opacity-50">
                  Verschieben
                </button>
              </form>
            ) : (
              /* Die neun Ordner — anklickbar, damit es auch ohne Tastatur geht */
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {ordner.map((o, i) => (
                  <button
                    key={o}
                    onClick={() => ausfuehren('verschieben', o)}
                    disabled={laeuft}
                    title={o}
                    className="text-left text-sm px-2.5 py-1.5 rounded-xl border border-panel-border hover:border-panel-accent disabled:opacity-50 flex items-center gap-2 min-w-0"
                  >
                    <kbd className="kbd shrink-0">{i + 1}</kbd>
                    <span className="truncate">{kurzname(o)}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Legende und Maus-Ersatz für die übrigen Tasten */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-panel-muted border-t border-panel-border pt-3">
              <button onClick={() => setTippen(true)} disabled={laeuft || tippen} className="hover:text-panel-text">
                <kbd className="kbd">/</kbd> Ordner tippen
              </button>
              <button onClick={() => ausfuehren('ignorieren')} disabled={laeuft} className="hover:text-panel-text flex items-center gap-1">
                <kbd className="kbd">P</kbd> <Inbox size={12} /> Im Posteingang lassen
              </button>
              <button onClick={zurueck} disabled={laeuft || pos === 0} className="hover:text-panel-text flex items-center gap-1">
                <kbd className="kbd">←</kbd> <ArrowLeft size={12} /> zurück
              </button>
              <button onClick={weiter} disabled={laeuft} className="hover:text-panel-text flex items-center gap-1">
                <kbd className="kbd">Leertaste</kbd> <ArrowRight size={12} /> überspringen
              </button>
              <span className="ml-auto">
                {laeuft ? 'Läuft …' : <><kbd className="kbd">Esc</kbd> schließen · keine Regeln</>}
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
