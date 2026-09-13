// Dateien, die vor dem Hochladen auf eine Entscheidung warten.
//
// Gegenstück zum Schalter "Vor dem Hochladen fragen" bei einer Nextcloud-Aktion.
// Ist er an, liefert Workflow 07 die Anhänge nur noch ab; hier wird entschieden,
// ob sie hochgehen — und wohin.
import { useEffect, useState, useCallback } from 'react';
import {
  CloudUpload, FileText, AlertTriangle, Loader2, Trash2, Eye,
} from 'lucide-react';
import api from '../api';
import { useMelden } from './ui/Meldungen';

const groesseText = (n) => {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} kB`;
  return `${b} B`;
};

export default function UploadFreigabenKarte({ onAnzahl }) {
  const { melden, nachfragen } = useMelden();
  const [daten, setDaten] = useState(null);
  const [busy, setBusy] = useState(null);        // id | 'sammel'
  const [gewaehlt, setGewaehlt] = useState(new Set());
  // Was der Nutzer in die Felder getippt hat, je Zeile: { [id]: {zielpfad, dateiname} }
  const [entwurf, setEntwurf] = useState({});

  const laden = useCallback(async () => {
    try {
      const r = await api.get('/uploads');
      setDaten(r.data);
      onAnzahl?.(r.data.dateien?.length || 0);
    } catch {
      setDaten({ dateien: [], nextcloud_bereit: false });
    }
  }, [onAnzahl]);

  useEffect(() => { laden(); }, [laden]);

  if (!daten) return null;
  const { dateien = [], nextcloud_bereit: bereit } = daten;

  const feld = (d, name) => entwurf[d.id]?.[name] ?? d[name];
  const setzeFeld = (id, name, wert) =>
    setEntwurf((e) => ({ ...e, [id]: { ...e[id], [name]: wert } }));

  const umschalten = (id) => setGewaehlt((s) => {
    const neu = new Set(s);
    if (neu.has(id)) neu.delete(id); else neu.add(id);
    return neu;
  });

  const alleUmschalten = () => setGewaehlt((s) =>
    (s.size === dateien.length ? new Set() : new Set(dateien.map((d) => d.id))));

  // Vorschau: Ein schlichtes <a href> bekäme eine 401 — das JWT hängt in api.js
  // als Header, und den schickt der Browser bei einem Seitenaufruf nicht mit.
  const ansehen = async (d) => {
    try {
      const r = await api.get(`/uploads/${d.id}/datei`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      window.open(url, '_blank', 'noopener');
      // Etwas Luft, damit der neue Tab die Daten noch lesen kann.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      melden('Die Datei lässt sich nicht öffnen — vielleicht ist sie nicht mehr da.', 'fehler');
    }
  };

  const hochladen = async (d) => {
    setBusy(d.id);
    try {
      const { data } = await api.post(`/uploads/${d.id}/freigeben`, {
        zielpfad: feld(d, 'zielpfad'),
        dateiname: feld(d, 'dateiname'),
      });
      melden(`„${data.dateiname}" liegt jetzt in ${data.pfad}.`, 'gut');
      await laden();
    } catch (err) {
      melden(err.response?.data?.fehler || 'Das Hochladen ist fehlgeschlagen.', 'fehler');
      await laden();
    } finally {
      setBusy(null);
    }
  };

  const verwerfen = async (d) => {
    const ja = await nachfragen({
      titel: 'Datei verwerfen?',
      text: `„${d.dateiname}" wird nicht hochgeladen und aus der Warteschlange gelöscht. `
        + 'Die Mail selbst bleibt unangetastet.',
      bestaetigen: 'Verwerfen',
      gefaehrlich: true,
    });
    if (!ja) return;
    setBusy(d.id);
    try {
      await api.post(`/uploads/${d.id}/verwerfen`);
      await laden();
    } catch (err) {
      melden(err.response?.data?.fehler || 'Konnte die Datei nicht verwerfen.', 'fehler');
    } finally {
      setBusy(null);
    }
  };

  const sammel = async (aktion) => {
    if (aktion === 'verwerfen') {
      const ja = await nachfragen({
        titel: `${gewaehlt.size} Dateien verwerfen?`,
        text: 'Sie werden nicht hochgeladen und aus der Warteschlange gelöscht.',
        bestaetigen: 'Verwerfen',
        gefaehrlich: true,
      });
      if (!ja) return;
    }
    setBusy('sammel');
    try {
      const { data } = await api.post('/uploads/sammel', { ids: [...gewaehlt], aktion });
      const fehl = data.fehlgeschlagen?.length || 0;
      melden(
        `${data.erledigt} erledigt${fehl ? `, ${fehl} fehlgeschlagen` : ''}.`,
        fehl ? 'hinweis' : 'gut',
      );
      setGewaehlt(new Set());
      await laden();
    } catch (err) {
      melden(err.response?.data?.fehler || 'Die Sammelaktion ist fehlgeschlagen.', 'fehler');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
        <CloudUpload size={18} className="text-panel-accent" />
        <h2 className="font-medium">Warten auf Freigabe</h2>
        {dateien.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-panel-accent text-white">{dateien.length}</span>
        )}
      </div>

      {!bereit && (
        <div className="m-4 flex items-start gap-2 text-sm text-panel-orange bg-panel-orange/10 rounded-lg p-3">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            Nextcloud ist nicht verbunden. Bei eingeschalteter Freigabe lädt das <b>Panel</b> hoch,
            nicht n8n — trage die Zugangsdaten unter{' '}
            <span className="font-medium">Einstellungen → Nextcloud</span> ein.
          </span>
        </div>
      )}

      {dateien.length === 0 ? (
        <div className="p-8 text-center text-sm text-panel-muted">
          Nichts zum Freigeben.
          <div className="text-xs mt-1">
            Schalte bei einer Aktion „Vor dem Hochladen fragen" ein, dann landen die Anhänge hier.
          </div>
        </div>
      ) : (
        <>
          <div className="px-4 py-2 border-b border-panel-border flex items-center gap-3 text-xs">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={gewaehlt.size === dateien.length && dateien.length > 0}
                onChange={alleUmschalten}
              />
              <span className="text-panel-muted">Alle</span>
            </label>
            {gewaehlt.size > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-panel-muted">{gewaehlt.size} ausgewählt</span>
                <button
                  className="btn-ghost !py-1 !px-2 hover:text-panel-red"
                  disabled={busy === 'sammel'}
                  onClick={() => sammel('verwerfen')}
                >
                  Alle verwerfen
                </button>
                <button
                  className="btn btn-primary !py-1 !px-3"
                  disabled={busy === 'sammel' || !bereit}
                  onClick={() => sammel('hochladen')}
                >
                  {busy === 'sammel' ? <Loader2 size={13} className="animate-spin" /> : 'Alle hochladen'}
                </button>
              </div>
            )}
          </div>

          <div className="divide-y divide-panel-border">
            {dateien.map((d) => (
              <div key={d.id} className="p-4 flex flex-wrap items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={gewaehlt.has(d.id)}
                  onChange={() => umschalten(d.id)}
                />

                <div className="flex-1 min-w-[14rem]">
                  <button
                    className="flex items-center gap-1.5 text-sm font-medium hover:text-panel-accent text-left"
                    onClick={() => ansehen(d)}
                    title="Ansehen"
                  >
                    <FileText size={15} className="text-panel-accent shrink-0" />
                    <span className="truncate">{d.dateiname}</span>
                    <Eye size={13} className="text-panel-muted shrink-0" />
                  </button>
                  <div className="text-xs text-panel-muted mt-1 truncate" title={d.von}>
                    {d.von || 'unbekannter Absender'} · {groesseText(d.groesse)}
                    {d.konto ? ` · ${d.konto}` : ''}
                  </div>
                  {d.betreff && (
                    <div className="text-xs text-panel-muted truncate" title={d.betreff}>{d.betreff}</div>
                  )}
                  {d.fehler && (
                    <div className="text-xs text-panel-red mt-1">Letzter Versuch: {d.fehler}</div>
                  )}
                </div>

                <div className="flex-1 min-w-[16rem] space-y-1">
                  <label className="block text-[11px] text-panel-muted">Zielordner</label>
                  <input
                    className="input-field font-mono text-xs !py-1"
                    value={feld(d, 'zielpfad')}
                    onChange={(e) => setzeFeld(d.id, 'zielpfad', e.target.value)}
                  />
                  <label className="block text-[11px] text-panel-muted pt-1">Dateiname</label>
                  <input
                    className="input-field font-mono text-xs !py-1"
                    value={feld(d, 'dateiname')}
                    onChange={(e) => setzeFeld(d.id, 'dateiname', e.target.value)}
                  />
                </div>

                <div className="flex items-center gap-2 self-center">
                  <button
                    className="btn-ghost !py-1 !px-2 hover:text-panel-red"
                    disabled={busy === d.id}
                    onClick={() => verwerfen(d)}
                    title="Verwerfen"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className="btn btn-primary !py-1 !px-3 text-sm"
                    disabled={busy === d.id || !bereit}
                    onClick={() => hochladen(d)}
                  >
                    {busy === d.id
                      ? <Loader2 size={13} className="animate-spin" />
                      : <><CloudUpload size={13} /> Hochladen</>}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
