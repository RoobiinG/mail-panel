import { useEffect, useState } from 'react';
import {
  Repeat, ChevronDown, ChevronRight, Loader2, AlertTriangle, ArrowRight, Play, X, Trash2,
} from 'lucide-react';
import api from '../api';
import { useMelden } from './ui/Meldungen';
import OrdnerFeld from './ui/OrdnerFeld';

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

export default function NachsortierungKarte({ ordner = [] }) {
  const { melden, nachfragen } = useMelden();
  const [daten, setDaten] = useState(null);
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState('');
  // Eigener Reiter statt Anhängsel unter den Regeln — wer hier hinklickt,
  // will die Liste sehen, also standardmäßig aufgeklappt.
  const [listeOffen, setListeOffen] = useState(true);
  // Je Zeile der Vorschlagsliste: der eingetippte Zielordner, welche Zeile
  // gerade arbeitet, und welche ausgeblendet ist.
  const [zielWahl, setZielWahl] = useState({});
  const [zeileBusy, setZeileBusy] = useState(null);
  const [versteckt, setVersteckt] = useState({});

  const laden = () => api.get('/sortierung/nachsortierung')
    .then((r) => { setDaten(r.data); setFehler(''); })
    .catch((err) => {
      setDaten(null);
      setFehler(err.response?.status === 404
        ? 'Das Panel kennt diese Funktion noch nicht — vermutlich läuft noch eine ältere Fassung. '
          + 'Nach „docker compose pull && up -d" und einem harten Neuladen (Strg+F5) ist sie da.'
        : (err.response?.data?.error || 'Der Stand der Nachsortierung ließ sich nicht laden.'));
    });
  useEffect(() => { laden(); }, []);

  // Solange ein Lauf arbeitet, alle fünf Sekunden nachsehen. Ein Postfach mit
  // 20.000 Mails braucht Minuten — ohne das bliebe die Karte stumm stehen.
  useEffect(() => {
    if (!daten?.laeuft) return undefined;
    const t = setInterval(laden, 5000);
    return () => clearInterval(t);
  }, [daten?.laeuft]);

  // Eine Karte, die bei einem Fehler einfach verschwindet, ist der schlimmste
  // Zustand: Der Nutzer sucht dann etwas, das er nicht findet, und nichts sagt
  // ihm warum. Also lieber ein Kasten mit der Begründung.
  if (!daten) {
    return (
      <div className="card !p-0 overflow-hidden">
        <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
          <Repeat size={18} className="text-panel-muted" />
          <h2 className="font-medium">Nachsortierung</h2>
        </div>
        <div className="p-4 flex items-start gap-2 text-sm text-panel-muted">
          {fehler ? <AlertTriangle size={16} className="shrink-0 mt-0.5 text-panel-orange" />
            : <Loader2 size={16} className="shrink-0 mt-0.5 animate-spin" />}
          <span>{fehler || 'Wird geladen …'}</span>
        </div>
      </div>
    );
  }
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

  // Alle Zeilen ausblenden, die dieselbe Regel betreffen: Ist die Ursache
  // beseitigt, sind auch die übrigen Vorschläge dieser Regel hinfällig.
  const gleicheRegelAusblenden = (regelId) => {
    if (!regelId) return;
    setVersteckt((p) => {
      const neu = { ...p };
      letzter.beispiele.forEach((x, idx) => { if (x.regelId === regelId) neu[idx] = true; });
      return neu;
    });
  };

  const regelUmbiegen = async (b, ziel, i) => {
    setZeileBusy(i);
    try {
      await api.put(`/sortierung/regeln/${b.regelId}`, { zielordner: ziel.trim() });
      melden(`Regel geändert — künftig geht das nach „${ziel.trim()}".`);
      gleicheRegelAusblenden(b.regelId);
    } catch (err) {
      melden(err.response?.data?.error || 'Die Regel ließ sich nicht ändern.', 'fehler');
    } finally {
      setZeileBusy(null);
    }
  };

  const regelWeg = async (b, i) => {
    const ok = await nachfragen({
      titel: 'Regel löschen?',
      text: `Die Regel „${b.regel}" wird gelöscht. Mails dieses Absenders entscheidet danach `
        + 'wieder die KI. Die Mails selbst bleiben, wo sie sind.',
      bestaetigen: 'Löschen',
      gefaehrlich: true,
    });
    if (!ok) return;
    setZeileBusy(i);
    try {
      await api.delete(`/sortierung/regeln/${b.regelId}`);
      melden('Regel gelöscht.');
      gleicheRegelAusblenden(b.regelId);
    } catch (err) {
      melden(err.response?.data?.error || 'Die Regel ließ sich nicht löschen.', 'fehler');
    } finally {
      setZeileBusy(null);
    }
  };

  const eineMail = async (b, ziel, i) => {
    setZeileBusy(i);
    try {
      const { data } = await api.post('/sortierung/nachsortierung/verschieben', {
        konto_id: b.kontoId, uid: b.uid, von: b.vonOrdner, nach: ziel.trim(), absender: b.von, isKI: b.isKI
      });
      melden(`Verschoben nach „${data.ordner}". Die Regel bleibt unverändert.`);
      setVersteckt((p) => ({ ...p, [i]: true }));
    } catch (err) {
      melden(err.response?.data?.error || 'Die Mail ließ sich nicht verschieben.', 'fehler');
    } finally {
      setZeileBusy(null);
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
    <div className="space-y-6">
      <div className="card !p-0 overflow-hidden">
        <div className="p-4 flex flex-wrap items-center gap-2">
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
          <span className="text-xs text-panel-muted ml-auto hidden lg:inline">
            Geht durch alle Ordner des Postfachs und verschiebt, wofür inzwischen eine Regel etwas
            anderes sagt — ohne KI, nur nach deinen Regeln.
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
        {/* LINKE SEITE: Einstellungen und Aktionen */}
        <div className="card space-y-4">
          <p className="text-xs text-panel-muted lg:hidden">
            Geht durch <span className="text-panel-text">alle Ordner des Postfachs</span> und verschiebt, wofür
            inzwischen eine Regel etwas anderes sagt. Ohne KI — es zählen nur deine Regeln.
          </p>
          <p className="text-xs text-panel-muted">
            Papierkorb, Entwürfe, Gesendet und der Spam-Ordner bleiben unangetastet.
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
                Lass das an, bis die Vorschläge rechts stimmen.
              </div>
            </div>
            <Schalter an={daten.trockenlauf} onClick={() => setzen('trockenlauf', !daten.trockenlauf)}
              disabled={!daten.aktiv} laedt={busy === 'trockenlauf'} />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-medium text-sm text-panel-accent flex items-center gap-1">KI-Nachsortierung aktivieren</div>
              <div className="text-xs text-panel-muted mt-0.5">
                Das gesamte Postfach wird schrittweise von der lokalen KI geprüft. Unbekannte Mails erhalten einen Vorschlag.
              </div>
            </div>
            <Schalter an={daten.kiAktiv} onClick={() => setzen('kiAktiv', !daten.kiAktiv)} laedt={busy === 'kiAktiv'} />
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
            <div className="pt-3 border-t border-panel-border/50 space-y-2">
              <div className="text-xs text-panel-muted">
                Zuletzt {zeit(letzter.zeitpunkt)}<br />
                {letzter.geprueft} Mail(s) geprüft ·{' '}
                {letzter.trockenlauf
                  ? <span className="text-panel-accent">{letzter.treffer} würden verschoben</span>
                  : <span className="text-emerald-500">{letzter.verschoben} von {letzter.treffer} verschoben</span>}
                {letzter.sekunden ? ` · ${letzter.sekunden} s` : ''}
              </div>

              {letzter.fehler?.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-panel-orange bg-panel-orange/10 rounded-lg p-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>{letzter.fehler[0]}{letzter.fehler.length > 1 ? ` (und ${letzter.fehler.length - 1} weitere)` : ''}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RECHTE SEITE: Vorschlagsliste */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <button
            onClick={() => setListeOffen((o) => !o)}
            disabled={!letzter?.beispiele?.length}
            className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2
                       text-left w-full disabled:cursor-default"
          >
            {letzter?.beispiele?.length > 0 && (
              listeOffen ? <ChevronDown size={16} className="text-panel-muted shrink-0" />
                : <ChevronRight size={16} className="text-panel-muted shrink-0" />
            )}
            <h2 className="font-medium">
              {letzter?.trockenlauf === false ? 'Verschoben (KI: nur Vorschläge)' : 'Vorschläge'}
            </h2>
            {letzter?.beispiele?.length > 0 && (
              <span className="bg-panel-border/60 text-xs px-1.5 py-0.5 rounded whitespace-nowrap">
                {letzter.beispiele.length}
                {letzter.treffer > letzter.beispiele.length ? ` von ${letzter.treffer}` : ''}
              </span>
            )}
          </button>

          {!letzter?.beispiele?.length ? (
            <div className="p-8 text-center text-panel-muted flex flex-col items-center gap-2">
              <Repeat size={28} className="text-panel-muted/40" />
              <p className="text-sm">
                {letzter ? 'Nichts zu tun — alle Mails liegen da, wo sie hingehören.'
                  : 'Noch kein Lauf. „Jetzt prüfen" zeigt, was sich ändern würde, ohne etwas zu verschieben.'}
              </p>
            </div>
          ) : listeOffen && (
                  <div className="flex-1 overflow-auto max-h-[600px] p-3 space-y-2">
                    {letzter.beispiele.map((b, i) => {
                      if (versteckt[i]) return null;
                      const ziel = zielWahl[i] ?? b.nachOrdner;
                      const geaendert = ziel.trim() && ziel.trim() !== b.nachOrdner;
                      return (
                        <div key={i} className="rounded-lg bg-panel-bg/40 hover:bg-panel-bg/70
                                                 transition-colors p-3 flex flex-col sm:flex-row
                                                 sm:items-center gap-3 text-xs">
                          {/* Links: worum es geht */}
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-panel-text truncate" title={b.von}>{b.von}</div>
                            {b.betreff && (
                              <div className="text-panel-muted truncate mt-0.5" title={b.betreff}>{b.betreff}</div>
                            )}
                          </div>

                          {/* Rechts: Ordner-Fluss und Aktionen */}
                          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                            <span
                              className="font-mono bg-panel-bg/60 border border-panel-border/60 rounded
                                         px-1.5 py-0.5 text-[11px] text-panel-muted cursor-help"
                              title={b.isKI ? `Grund: ${b.grund}` : `Regel: ${b.regel}`}
                            >
                              {b.vonOrdner}
                            </span>
                            <ArrowRight size={12} className="text-panel-accent shrink-0" title={b.isKI ? `KI-Vorschlag (${Math.round(b.konfidenz * 100)}%)` : `Regel: ${b.regel}`} />
                            <div className="w-36 shrink-0 flex flex-col">
                              <OrdnerFeld
                                value={ziel}
                                onChange={(v) => setZielWahl((p) => ({ ...p, [i]: v }))}
                                optionen={ordner}
                                className="!py-0.5 !px-1.5 text-xs font-mono"
                                title="Zielordner ändern"
                              />
                              {b.isKI && b.konfidenz > 0 && (
                                <span className="text-[10px] text-panel-muted/60 mt-0.5 ml-1">KI ({Math.round(b.konfidenz * 100)}%)</span>
                              )}
                            </div>

                            <div className="flex items-center gap-1 pl-1 ml-1 border-l border-panel-border/50">
                              {/* Die Regel umbiegen wirkt auf ALLE Mails dieses Absenders —
                                  das ist der Knopf, der ein Problem wirklich erledigt. */}
                              <button
                                onClick={() => regelUmbiegen(b, ziel, i)}
                                disabled={!geaendert || !b.regelId || zeileBusy === i}
                                className="btn-ghost !py-0.5 !px-2 text-[11px] disabled:opacity-40"
                                title="Ändert die Regel — gilt für alle Mails dieses Absenders"
                              >
                                Regel ändern
                              </button>
                              <button
                                onClick={() => eineMail(b, ziel, i)}
                                disabled={!ziel.trim() || zeileBusy === i}
                                className="btn-ghost !py-0.5 !px-2 text-[11px] disabled:opacity-40"
                                title="Verschiebt nur diese eine Mail. Die Regel bleibt, wie sie ist."
                              >
                                Nur diese Mail
                              </button>
                              <button
                                onClick={() => regelWeg(b, i)}
                                disabled={!b.regelId || zeileBusy === i}
                                className="btn-ghost !p-1.5 text-panel-red disabled:opacity-40"
                                title="Löscht die Regel dahinter — künftig entscheidet wieder die KI"
                              >
                                <Trash2 size={13} />
                              </button>
                              <button
                                onClick={() => setVersteckt((p) => ({ ...p, [i]: true }))}
                                className="btn-ghost !p-1.5"
                                title="Nur ausblenden — beim nächsten Lauf steht der Vorschlag wieder da"
                              >
                                <X size={13} />
                              </button>
                              {zeileBusy === i && <Loader2 size={12} className="animate-spin text-panel-muted" />}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
          </div>
        </div>
      </div>
  );
}
