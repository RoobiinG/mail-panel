import { useEffect, useState } from 'react';
import { Sparkles, Plus, Trash2, Loader2, AlertTriangle, X } from 'lucide-react';
import api from '../api';
import { useMelden } from './ui/Meldungen';

// Formular für eine Aktion. Es zeigt genau das, was gespeichert wird — egal ob
// die KI den Entwurf geliefert hat oder man alles selbst einträgt.
function AktionsFormular({ schema, entwurf, onSpeichern, onAbbrechen, fehler, laedt }) {
  const [a, setA] = useState(entwurf);
  const typ = schema.typen[a.typ] || { felder: {} };

  const regelAendern = (i, feld, wert) => {
    const regeln = [...a.bedingung.regeln];
    regeln[i] = { ...regeln[i], [feld]: wert };
    setA({ ...a, bedingung: { ...a.bedingung, regeln } });
  };
  const regelWeg = (i) =>
    setA({ ...a, bedingung: { ...a.bedingung, regeln: a.bedingung.regeln.filter((_, x) => x !== i) } });
  const regelDazu = () =>
    setA({ ...a, bedingung: { ...a.bedingung, regeln: [...a.bedingung.regeln, { feld: 'von', vergleich: 'enthaelt', wert: '' }] } });

  return (
    <div className="card space-y-4 border-panel-accent">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">So habe ich das verstanden</h3>
        <button onClick={onAbbrechen} className="text-panel-muted hover:text-panel-text"><X size={18} /></button>
      </div>
      <p className="text-sm text-panel-muted">
        Prüfe die Regel und ändere, was nicht passt. Gespeichert wird erst mit dem Knopf unten.
      </p>

      <label className="block text-sm space-y-1">
        <span className="text-panel-muted">Name</span>
        <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
      </label>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-panel-muted text-sm">Wenn</span>
          <select
            value={a.bedingung.verknuepfung}
            onChange={(e) => setA({ ...a, bedingung: { ...a.bedingung, verknuepfung: e.target.value } })}
            className="!w-auto text-sm"
          >
            <option value="und">alle Bedingungen zutreffen</option>
            <option value="oder">eine der Bedingungen zutrifft</option>
          </select>
        </div>

        {a.bedingung.regeln.map((r, i) => {
          const feld = schema.felder[r.feld] || {};
          const passende = Object.entries(schema.vergleiche).filter(([, v]) => v.fuer.includes(feld.typ));
          return (
            <div key={i} className="flex flex-wrap gap-2 items-center">
              <select value={r.feld} onChange={(e) => regelAendern(i, 'feld', e.target.value)} className="!w-auto text-sm">
                {Object.entries(schema.felder).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
              </select>
              <select value={r.vergleich} onChange={(e) => regelAendern(i, 'vergleich', e.target.value)} className="!w-auto text-sm">
                {passende.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              {feld.typ === 'auswahl' ? (
                <select value={r.wert} onChange={(e) => regelAendern(i, 'wert', e.target.value)} className="!w-auto text-sm">
                  {feld.werte.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              ) : feld.typ === 'boolean' ? null : (
                <input value={r.wert} onChange={(e) => regelAendern(i, 'wert', e.target.value)} className="!w-auto flex-1 min-w-[10rem] text-sm" />
              )}
              <button onClick={() => regelWeg(i)} className="text-panel-muted hover:text-panel-red"><Trash2 size={15} /></button>
            </div>
          );
        })}
        <button onClick={regelDazu} className="btn-ghost !py-1 !px-2 text-xs flex items-center gap-1">
          <Plus size={13} /> Bedingung
        </button>
      </div>

      <div className="space-y-3">
        <label className="block text-sm space-y-1">
          <span className="text-panel-muted">Dann</span>
          <select value={a.typ} onChange={(e) => setA({ ...a, typ: e.target.value, konfig: {} })}>
            {Object.entries(schema.typen).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
          </select>
        </label>

        {Object.entries(typ.felder).map(([name, f]) => (
          <label key={name} className="block text-sm space-y-1">
            <span className="text-panel-muted">{f.label}</span>
            {f.typ === 'boolean' ? (
              <input type="checkbox" className="w-auto block"
                checked={a.konfig[name] ?? f.standard ?? false}
                onChange={(e) => setA({ ...a, konfig: { ...a.konfig, [name]: e.target.checked } })} />
            ) : f.typ === 'auswahl' ? (
              <select value={a.konfig[name] ?? f.standard}
                onChange={(e) => setA({ ...a, konfig: { ...a.konfig, [name]: e.target.value } })}>
                {f.werte.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            ) : (
              <input type={f.typ === 'zahl' ? 'number' : 'text'} placeholder={f.platzhalter || ''}
                value={a.konfig[name] ?? f.standard ?? ''}
                onChange={(e) => setA({ ...a, konfig: { ...a.konfig, [name]: e.target.value } })} />
            )}
          </label>
        ))}
        <p className="text-xs text-panel-muted">
          Platzhalter in Textfeldern: {schema.platzhalter.join(' ')}
        </p>
      </div>

      {fehler?.length > 0 && (
        <ul className="text-sm text-panel-red list-disc pl-5">
          {fehler.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onAbbrechen} className="btn-ghost">Abbrechen</button>
        <button onClick={() => onSpeichern(a)} disabled={laedt} className="btn-primary">
          {laedt ? 'Speichere und baue in n8n…' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

export default function AktionenBereich() {
  const { nachfragen } = useMelden();
  const [schema, setSchema] = useState(null);
  const [aktionen, setAktionen] = useState([]);
  const [beschreibung, setBeschreibung] = useState('');
  const [entwurf, setEntwurf] = useState(null);
  const [fehler, setFehler] = useState([]);
  const [rueckfrage, setRueckfrage] = useState(null);
  const [denkt, setDenkt] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [meldung, setMeldung] = useState('');

  const laden = () => api.get('/aktionen').then((r) => setAktionen(r.data)).catch(() => setAktionen([]));
  useEffect(() => {
    api.get('/aktionen/schema').then((r) => setSchema(r.data)).catch(() => {});
    laden();
  }, []);

  const uebersetzen = async () => {
    setDenkt(true); setFehler([]); setRueckfrage(null); setMeldung('');
    try {
      const r = await api.post('/aktionen/entwurf', { beschreibung });
      setEntwurf(r.data.aktion);
      setRueckfrage(r.data.rueckfrage);
    } catch (err) {
      setFehler(err.response?.data?.fehler || ['Die KI konnte damit nichts anfangen.']);
      setRueckfrage(err.response?.data?.rueckfrage || null);
    } finally {
      setDenkt(false);
    }
  };

  const leeresFormular = () => {
    setFehler([]); setRueckfrage(null);
    setEntwurf({
      name: '', typ: 'nextcloud_datei',
      bedingung: { verknuepfung: 'und', regeln: [{ feld: 'von', vergleich: 'enthaelt', wert: '' }] },
      konfig: {},
    });
  };

  const speichern = async (a) => {
    setSpeichert(true); setFehler([]);
    try {
      await api.post('/aktionen', a);
      setEntwurf(null); setBeschreibung('');
      await laden();
      setMeldung('Aktion gespeichert und in n8n gebaut.');
    } catch (err) {
      setFehler(err.response?.data?.fehler || ['Speichern fehlgeschlagen.']);
    } finally {
      setSpeichert(false);
    }
  };

  const umschalten = async (a) => {
    await api.put(`/aktionen/${a.id}`, { aktiv: !a.aktiv }).catch(() => {});
    laden();
  };
  const loeschen = async (a) => {
    if (!(await nachfragen({
      titel: `Aktion „${a.name}" entfernen?`,
      text: 'Der zugehörige Knoten in n8n wird zurückgebaut. Mails bleiben unangetastet.',
      bestaetigen: 'Entfernen', gefaehrlich: true,
    }))) return;
    await api.delete(`/aktionen/${a.id}`).catch(() => {});
    laden();
  };

  if (!schema) return null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Eigene Aktionen</h2>
        <p className="text-sm text-panel-muted mt-1">
          Beschreibe in einem Satz, was mit bestimmten Mails passieren soll. Die KI macht
          daraus einen Vorschlag, den du prüfst — gebaut wird er erst nach deiner Bestätigung.
        </p>
      </div>

      <div className="card space-y-3">
        <div className="flex gap-2">
          <input
            value={beschreibung}
            onChange={(e) => setBeschreibung(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && beschreibung.trim() && uebersetzen()}
            placeholder="Rechnungen von amazon.de als PDF in Nextcloud unter Belege/{{jahr}} ablegen"
            className="flex-1"
          />
          <button onClick={uebersetzen} disabled={denkt || !beschreibung.trim()}
            className="btn-primary flex items-center gap-2 whitespace-nowrap">
            {denkt ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {denkt ? 'Überlege…' : 'Vorschlag'}
          </button>
        </div>
        <button onClick={leeresFormular} className="text-xs text-panel-muted hover:text-panel-text underline">
          Lieber selbst eintragen
        </button>

        {rueckfrage && (
          <div className="flex gap-2 text-sm text-panel-orange">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{rueckfrage}</span>
          </div>
        )}
        {!entwurf && fehler.length > 0 && (
          <ul className="text-sm text-panel-red list-disc pl-5">{fehler.map((f, i) => <li key={i}>{f}</li>)}</ul>
        )}
      </div>

      {entwurf && (
        <AktionsFormular
          schema={schema}
          entwurf={entwurf}
          fehler={fehler}
          laedt={speichert}
          onSpeichern={speichern}
          onAbbrechen={() => { setEntwurf(null); setFehler([]); }}
        />
      )}

      {meldung && <div className="card !py-3 text-sm">{meldung}</div>}

      <div className="card !p-0 overflow-hidden">
        {aktionen.length === 0 ? (
          <p className="p-5 text-sm text-panel-muted">Noch keine eigenen Aktionen.</p>
        ) : (
          <ul className="divide-y divide-panel-border">
            {aktionen.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{a.name}</div>
                  <div className="text-xs text-panel-muted">
                    {schema.typen[a.typ]?.label} · {a.bedingung.regeln?.length || 0} Bedingung(en)
                    {a.treffer > 0 && ` · ${a.treffer}× ausgelöst`}
                  </div>
                </div>
                <button onClick={() => umschalten(a)}
                  className={`text-xs px-2 py-1 rounded-full border ${
                    a.aktiv ? 'border-emerald-500/60 text-emerald-500' : 'border-panel-border text-panel-muted'
                  }`}>
                  {a.aktiv ? 'aktiv' : 'aus'}
                </button>
                <button onClick={() => loeschen(a)} className="text-panel-muted hover:text-panel-red">
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
