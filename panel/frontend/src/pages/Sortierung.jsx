import { useState, useEffect } from 'react';
import {
  FolderInput, Plus, Trash2, CheckCircle2, XCircle, AlertCircle, Inbox, Tag, ArrowRight
} from 'lucide-react';
import api from '../api';

const REGEL_TYPEN = {
  absender: 'Exakter Absender (E-Mail)',
  domain: 'Domain (z.B. amazon.de)',
  betreff: 'Betreff enthält',
};

export default function Sortierung() {
  const [konten, setKonten] = useState([]);
  const [aktivesKonto, setAktivesKonto] = useState('');
  
  const [regeln, setRegeln] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [laedt, setLaedt] = useState(false);

  // Modal: Neue Regel
  const [regelModal, setRegelModal] = useState({
    offen: false, typ: 'absender', muster: '', zielordner: ''
  });

  // State für die Zuordnung in der Inbox (welcher Ordner ist im Dropdown gewählt)
  const [ordnerWahl, setOrdnerWahl] = useState({});
  const [regelAnlegenWahl, setRegelAnlegenWahl] = useState({});

  const ladenInit = async () => {
    try {
      const [{ data: accData }, { data: inData }] = await Promise.all([
        api.get('/konten'),
        api.get('/sortierung/inbox')
      ]);
      setKonten(accData || []);
      setInbox(inData || []);
      if (accData && accData.length > 0) {
        setAktivesKonto(accData[0].id);
      }
    } catch { /* leer */ }
  };

  useEffect(() => { ladenInit(); }, []);

  const regelnLaden = async (kontoId) => {
    if (!kontoId) return;
    setLaedt(true);
    try {
      const { data } = await api.get(`/sortierung/regeln?konto_id=${kontoId}`);
      setRegeln(data || []);
    } catch { /* leer */ } finally {
      setLaedt(false);
    }
  };

  useEffect(() => { regelnLaden(aktivesKonto); }, [aktivesKonto]);

  const inboxLaden = async () => {
    try {
      const { data } = await api.get('/sortierung/inbox');
      setInbox(data || []);
    } catch { /* leer */ }
  };

  // ─── REGELN ──────────────────────────────────────────────────────────────────

  const regelSpeichern = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sortierung/regeln', {
        konto_id: aktivesKonto,
        typ: regelModal.typ,
        muster: regelModal.muster,
        zielordner: regelModal.zielordner,
      });
      setRegelModal({ offen: false, typ: 'absender', muster: '', zielordner: '' });
      regelnLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Speichern');
    }
  };

  const regelLoeschen = async (id) => {
    if (!confirm('Regel löschen?')) return;
    try {
      await api.delete(`/sortierung/regeln/${id}`);
      regelnLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Löschen');
    }
  };

  // ─── INBOX ───────────────────────────────────────────────────────────────────

  const zuordnen = async (mailId) => {
    const zielordner = ordnerWahl[mailId];
    if (!zielordner) return alert('Bitte einen Zielordner angeben.');
    const anlegen = !!regelAnlegenWahl[mailId];

    try {
      await api.post('/sortierung/zuordnen', {
        id: mailId,
        zielordner,
        regelAnlegen: anlegen
      });
      // Wenn eine Regel angelegt wurde, laden wir die Regeln neu (falls das selbe Konto aktiv ist)
      const mail = inbox.find(m => m.id === mailId);
      if (anlegen && mail && mail.konto_id === aktivesKonto) {
        regelnLaden(aktivesKonto);
      }
      inboxLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Zuordnen');
    }
  };

  const ignorieren = async (mailId) => {
    try {
      await api.post('/sortierung/ignorieren', { id: mailId });
      inboxLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Ignorieren');
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold flex items-center gap-2">
        <FolderInput size={24} /> Sortierung
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LINKE SEITE: Regeln */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-4 justify-between items-center">
            <h2 className="font-medium flex items-center gap-2">
              <Tag size={18} className="text-panel-accent" /> Sortier-Regeln
            </h2>
            <div className="flex items-center gap-3">
              <select
                value={aktivesKonto}
                onChange={e => setAktivesKonto(Number(e.target.value))}
                className="text-sm bg-panel-bg"
              >
                {konten.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
              <button
                onClick={() => setRegelModal(p => ({ ...p, offen: true }))}
                className="btn !py-1.5 !px-3 text-sm flex items-center gap-1"
                disabled={!aktivesKonto}
              >
                <Plus size={14} /> Regel
              </button>
            </div>
          </div>
          
          <div className="flex-1 overflow-auto max-h-[500px]">
            {regeln.length === 0 ? (
              <p className="p-6 text-center text-panel-muted text-sm">
                Keine Regeln für dieses Konto hinterlegt.<br/>
                Mails dieses Kontos, die nicht manuell sortiert werden, landen in der Inbox.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                    <th className="py-2 px-4">Bedingung</th>
                    <th className="py-2 px-4">Zielordner</th>
                    <th className="py-2 px-4 text-center">Treffer</th>
                    <th className="py-2 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {regeln.map(r => (
                    <tr key={r.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="text-xs text-panel-muted">{REGEL_TYPEN[r.typ]}</div>
                        <div className="font-medium truncate max-w-[200px]" title={r.muster}>{r.muster}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-panel-accent">{r.zielordner}</td>
                      <td className="py-3 px-4 text-center text-xs text-panel-muted">{r.treffer}</td>
                      <td className="py-3 px-4 text-right">
                        <button onClick={() => regelLoeschen(r.id)} className="btn-ghost !px-2 text-panel-red" title="Löschen">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* RECHTE SEITE: Sortier-Inbox */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex justify-between items-center">
            <h2 className="font-medium flex items-center gap-2">
              <Inbox size={18} className="text-panel-accent" /> Sortier-Inbox
              {inbox.length > 0 && (
                <span className="bg-panel-accent text-white text-xs px-2 py-0.5 rounded-full">
                  {inbox.length}
                </span>
              )}
            </h2>
            <button onClick={inboxLaden} className="btn-ghost text-xs">Aktualisieren</button>
          </div>
          
          <div className="flex-1 overflow-auto max-h-[500px]">
            {inbox.length === 0 ? (
              <div className="p-8 text-center text-panel-muted flex flex-col items-center gap-2">
                <CheckCircle2 size={32} className="text-green-500/50" />
                <p className="text-sm">Inbox ist leer. Alle Mails wurden automatisch zugeordnet.</p>
              </div>
            ) : (
              <div className="divide-y divide-panel-border">
                {inbox.map(mail => (
                  <div key={mail.id} className="p-4 hover:bg-panel-bg/30 transition-colors">
                    <div className="flex justify-between items-start gap-4 mb-3">
                      <div className="truncate">
                        <div className="text-xs text-panel-muted mb-1 flex items-center gap-2">
                          <span className="bg-panel-border/50 px-1.5 py-0.5 rounded">{mail.account_name || mail.konto}</span>
                          {new Date(mail.created_at).toLocaleString('de-DE')}
                        </div>
                        <div className="font-medium truncate" title={mail.von}>{mail.von}</div>
                        <div className="text-sm text-panel-muted truncate" title={mail.betreff}>{mail.betreff || '(Kein Betreff)'}</div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center bg-panel-bg/50 p-3 rounded-lg border border-panel-border">
                      <div className="flex-1 w-full">
                        <input
                          type="text"
                          placeholder="Zielordner (z.B. Rechnungen)"
                          value={ordnerWahl[mail.id] || ''}
                          onChange={e => setOrdnerWahl(p => ({ ...p, [mail.id]: e.target.value }))}
                          className="w-full text-sm"
                        />
                      </div>
                      <label className="flex items-center gap-2 text-xs cursor-pointer whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={!!regelAnlegenWahl[mail.id]}
                          onChange={e => setRegelAnlegenWahl(p => ({ ...p, [mail.id]: e.target.checked }))}
                          className="accent-panel-accent"
                        />
                        Regel für Absender merken
                      </label>
                      <div className="flex gap-2 w-full sm:w-auto mt-2 sm:mt-0">
                        <button onClick={() => ignorieren(mail.id)} className="btn-ghost !px-2 flex-1 sm:flex-none text-panel-muted hover:text-panel-red" title="Ignorieren">
                          <XCircle size={18} />
                        </button>
                        <button onClick={() => zuordnen(mail.id)} className="btn !py-1.5 !px-3 flex-1 sm:flex-none flex items-center justify-center gap-1">
                          Verschieben <ArrowRight size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL */}
      {regelModal.offen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={regelSpeichern} className="card w-full max-w-md space-y-4 shadow-2xl">
            <h2 className="text-xl font-semibold">Neue Sortier-Regel</h2>
            
            <label className="block space-y-1">
              <span className="text-sm font-medium">Bedingungstyp</span>
              <select
                value={regelModal.typ}
                onChange={e => setRegelModal(p => ({ ...p, typ: e.target.value }))}
                className="w-full"
              >
                {Object.entries(REGEL_TYPEN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Muster</span>
              <input
                type="text" required
                value={regelModal.muster}
                onChange={e => setRegelModal(p => ({ ...p, muster: e.target.value }))}
                className="w-full"
                placeholder={regelModal.typ === 'domain' ? 'amazon.de' : '...'}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Zielordner (IMAP)</span>
              <input
                type="text" required
                value={regelModal.zielordner}
                onChange={e => setRegelModal(p => ({ ...p, zielordner: e.target.value }))}
                className="w-full font-mono"
                placeholder="z.B. Rechnungen"
              />
            </label>

            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setRegelModal({ offen: false })} className="btn-ghost flex-1">Abbrechen</button>
              <button type="submit" className="btn flex-1">Speichern</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
