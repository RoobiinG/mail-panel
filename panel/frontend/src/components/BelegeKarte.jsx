import { useEffect, useState } from 'react';
import {
  Archive, FileText, ScanLine, FolderTree, ChevronDown, ChevronRight,
  CheckCircle2, MinusCircle, AlertTriangle, Loader2,
} from 'lucide-react';
import api from '../api';
import { useMelden } from './ui/Meldungen';

// Kleiner Ein/Aus-Schalter im Stil der übrigen Pillen.
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

function MiniWert({ zahl, text, ton }) {
  const farbe = ton === 'gut' ? 'text-emerald-500' : ton === 'weg' ? 'text-panel-muted' : 'text-panel-accent';
  return (
    <div className="flex-1 rounded-lg bg-panel-bg/50 border border-panel-border px-3 py-2 text-center">
      <div className={`text-lg font-semibold ${farbe}`}>{zahl}</div>
      <div className="text-[11px] text-panel-muted leading-tight">{text}</div>
    </div>
  );
}

export default function BelegeKarte() {
  const { melden } = useMelden();
  const [daten, setDaten] = useState(null);
  const [busy, setBusy] = useState('');       // '' | 'automatik' | 'auslesen'
  const [listeOffen, setListeOffen] = useState(false);

  const laden = () => api.get('/sortierung/belege').then((r) => setDaten(r.data)).catch(() => setDaten(null));
  useEffect(() => { laden(); }, []);

  if (!daten) return null;
  const { automatik, lesen, nextcloud_bereit: bereit, letzte = [] } = daten;

  const rufen = async (feld, body) => {
    setBusy(feld);
    try {
      await api.post('/aktionen/beleg-automatik', body);
      await laden();
    } catch (err) {
      melden(err.response?.data?.fehler?.[0] || 'Konnte die Beleg-Ablage nicht ändern.', 'fehler');
    } finally {
      setBusy('');
    }
  };

  const automatikUmschalten = () => rufen('automatik', { an: !automatik.an, auslesen: automatik.auslesen });
  const auslesenUmschalten = () => rufen('auslesen', { an: true, auslesen: !automatik.auslesen });

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
        <Archive size={18} className="text-panel-accent" />
        <h2 className="font-medium">Belege in Nextcloud</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          automatik.an ? 'border-emerald-500/60 text-emerald-500' : 'border-panel-border text-panel-muted'
        }`}>
          {automatik.an ? 'automatisch an' : 'aus'}
        </span>
      </div>

      <div className="p-4 space-y-4">
        {!bereit && (
          <div className="flex items-start gap-2 text-sm text-panel-orange bg-panel-orange/10 rounded-lg p-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>Nextcloud ist noch nicht verbunden. Trage die Zugangsdaten unter{' '}
              <span className="font-medium">Einstellungen → Nextcloud</span> ein, dann lässt sich die Ablage einschalten.</span>
          </div>
        )}

        {/* Hauptschalter */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium text-sm">Rechnungen &amp; Bestellungen automatisch ablegen</div>
            <div className="text-xs text-panel-muted mt-0.5">
              Erkennt die KI eine Rechnung oder Bestellung mit PDF-Anhang, landet der Beleg von selbst in Nextcloud.
            </div>
          </div>
          <Schalter an={automatik.an} onClick={automatikUmschalten} disabled={!bereit} laedt={busy === 'automatik'} />
        </div>

        {/* Auslesen-Schalter */}
        <div className={`flex items-start justify-between gap-4 ${automatik.an ? '' : 'opacity-50'}`}>
          <div>
            <div className="font-medium text-sm flex items-center gap-1.5">
              <ScanLine size={15} className="text-panel-accent" /> Inhalt lesen &amp; prüfen
            </div>
            <div className="text-xs text-panel-muted mt-0.5">
              Liest Firma, Datum und Aktenzeichen aus dem PDF — und legt <span className="text-panel-text">nur echte Belege</span> ab
              (AGB, Werbung &amp; Co. werden aussortiert). Kostet je Beleg eine KI-Abfrage.
            </div>
          </div>
          <Schalter an={automatik.auslesen} onClick={auslesenUmschalten} disabled={!automatik.an} laedt={busy === 'auslesen'} />
        </div>

        {/* Zahlen des Tages */}
        <div className="flex gap-2">
          <MiniWert zahl={lesen.abgelegtHeute} text="heute abgelegt" ton="gut" />
          <MiniWert zahl={lesen.uebersprungenHeute} text="übersprungen (kein Beleg)" ton="weg" />
          <MiniWert
            zahl={lesen.grenze ? `${lesen.heute}/${lesen.grenze}` : lesen.heute}
            text={lesen.ausgeschoepft ? 'Lese-Limit erreicht' : 'heute gelesen'}
          />
        </div>

        {/* So wird abgelegt */}
        <div className="rounded-lg bg-panel-bg/40 border border-panel-border p-3 space-y-1.5">
          <div className="text-xs text-panel-muted flex items-center gap-1.5">
            <FolderTree size={14} className="text-panel-accent" /> So wird abgelegt
          </div>
          <div className="font-mono text-xs text-panel-text break-all">
            Belege/<span className="text-panel-accent">firma</span>/<span className="text-panel-accent">aktenzeichen</span>/
            <span className="text-panel-muted">2026-03-15 firma Rechnung.pdf</span>
          </div>
          <div className="font-mono text-xs text-panel-muted break-all">
            ohne Aktenzeichen: Belege/2026/<span className="text-panel-accent">firma</span>/…
          </div>
        </div>

        {/* Letzte Belege */}
        {letzte.length > 0 && (
          <div>
            <button
              onClick={() => setListeOffen((o) => !o)}
              className="text-xs text-panel-muted hover:text-panel-text flex items-center gap-1"
            >
              {listeOffen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Zuletzt verarbeitet ({letzte.length})
            </button>
            {listeOffen && (
              <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-panel-border divide-y divide-panel-border">
                {letzte.map((b, i) => (
                  <div key={i} className="px-3 py-2 flex items-center gap-2 text-xs">
                    {b.gespeichert
                      ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" title="abgelegt" />
                      : <MinusCircle size={15} className="text-panel-muted shrink-0" title="kein Beleg — übersprungen" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={b.betreff}>
                        {b.betreff || '(kein Betreff)'}
                      </div>
                      <div className="truncate text-panel-muted" title={b.von}>{b.von}</div>
                    </div>
                    <div className="text-right shrink-0">
                      {b.gespeichert ? (
                        <div className="font-mono text-panel-accent truncate max-w-[160px]" title={b.dateiname}>
                          <FileText size={11} className="inline mr-1" />{b.firma}{b.aktenzeichen ? ` · ${b.aktenzeichen}` : ''}
                        </div>
                      ) : (
                        <span className="text-panel-muted">{b.dokumenttyp || 'kein Beleg'}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
