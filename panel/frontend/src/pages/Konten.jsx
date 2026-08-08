import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle, Loader2, X } from 'lucide-react';
import api from '../api';

const LEER = { name: '', host: '', port: 993, username: '', passwort: '' };

// Bekannte Anbieter — spart dem Nutzer das Nachschlagen der Serverdaten
const VORLAGEN = [
  { label: 'Web.de', host: 'imap.web.de', port: 993 },
  { label: 'GMX', host: 'imap.gmx.net', port: 993 },
  { label: 'Mailbox.org', host: 'imap.mailbox.org', port: 993 },
  { label: 'Mailcow / eigener Server', host: '', port: 993 },
];

export default function Konten() {
  const [konten, setKonten] = useState(null);
  const [formular, setFormular] = useState(null); // null = zu, sonst Konto-Entwurf
  const [test, setTest] = useState(null);         // null | 'laeuft' | {ok} | {error}
  const [meldung, setMeldung] = useState('');
  const [laedt, setLaedt] = useState(false);

  const laden = () => api.get('/konten').then((res) => setKonten(res.data));
  useEffect(() => { laden(); }, []);

  const oeffnen = (konto) => {
    setTest(null);
    setMeldung('');
    setFormular(konto ? { ...konto, passwort: '' } : { ...LEER });
  };

  const testen = async () => {
    setTest('laeuft');
    try {
      const res = await api.post('/konten/test', formular);
      setTest(res.data);
    } catch (err) {
      setTest({ error: err.response?.data?.error || 'Verbindung fehlgeschlagen' });
    }
  };

  const speichern = async () => {
    setLaedt(true);
    setMeldung('');
    try {
      if (formular.id) await api.put(`/konten/${formular.id}`, formular);
      else await api.post('/konten', formular);
      setFormular(null);
      await laden();
      setMeldung('Konto gespeichert und in n8n verdrahtet.');
    } catch (err) {
      setMeldung(err.response?.data?.error || 'Speichern fehlgeschlagen.');
    } finally {
      setLaedt(false);
    }
  };

  const loeschen = async (konto) => {
    if (!window.confirm(`Konto „${konto.name}" wirklich entfernen? Die Knoten in n8n werden zurückgebaut, Mails bleiben unangetastet.`)) return;
    setMeldung('');
    try {
      await api.delete(`/konten/${konto.id}`);
      await laden();
      setMeldung('Konto entfernt.');
    } catch (err) {
      setMeldung(err.response?.data?.error || 'Löschen fehlgeschlagen.');
    }
  };

  const synchronisieren = async () => {
    setMeldung('Synchronisiere…');
    try {
      await api.post('/konten/sync');
      setMeldung('Workflows sind auf dem aktuellen Stand.');
    } catch (err) {
      setMeldung(err.response?.data?.error || 'Sync fehlgeschlagen.');
    }
  };

  if (!konten) return <p className="text-panel-muted">Lade…</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Konten</h1>
        <div className="flex gap-2">
          <button onClick={synchronisieren} className="btn-ghost flex items-center gap-2">
            <RefreshCw size={16} /> Workflows synchronisieren
          </button>
          <button onClick={() => oeffnen(null)} className="btn-primary flex items-center gap-2">
            <Plus size={16} /> IMAP-Konto hinzufügen
          </button>
        </div>
      </div>

      <p className="text-sm text-panel-muted">
        Hier verwaltete IMAP-Konten werden automatisch in n8n eingetragen: Zugangsdaten anlegen,
        Trigger und Verschiebe-Knoten in die Workflows 01 und 04 einbauen. Gmail läuft über OAuth
        und wird direkt in n8n eingerichtet.
      </p>

      {meldung && <div className="card !py-3 text-sm">{meldung}</div>}

      <div className="card !p-0 overflow-hidden">
        {konten.length === 0 ? (
          <p className="p-5 text-sm text-panel-muted">Noch keine Konten angelegt.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-panel-card text-panel-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Server</th>
                <th className="text-left px-4 py-2 font-medium">Benutzer</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {konten.map((k) => (
                <tr key={k.id} className="border-t border-panel-border">
                  <td className="px-4 py-2">{k.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-panel-muted">{k.host}:{k.port}</td>
                  <td className="px-4 py-2 text-panel-muted">{k.username}</td>
                  <td className="px-4 py-2">
                    {k.verdrahtet
                      ? <span className="text-panel-green">in n8n verdrahtet</span>
                      : <span className="text-panel-orange">nicht verdrahtet</span>}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button onClick={() => oeffnen(k)} className="text-panel-muted hover:text-panel-text p-1" title="Bearbeiten">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => loeschen(k)} className="text-panel-muted hover:text-panel-red p-1" title="Entfernen">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {formular && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="card w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{formular.id ? 'Konto bearbeiten' : 'IMAP-Konto hinzufügen'}</h2>
              <button onClick={() => setFormular(null)} className="text-panel-muted hover:text-panel-text">
                <X size={18} />
              </button>
            </div>

            {!formular.id && (
              <div className="flex flex-wrap gap-2">
                {VORLAGEN.map((v) => (
                  <button
                    key={v.label}
                    onClick={() => setFormular((f) => ({ ...f, name: f.name || v.label, host: v.host, port: v.port }))}
                    className="btn-ghost !py-1 !px-2 text-xs"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            )}

            <div className="grid gap-3">
              <label className="text-sm space-y-1">
                <span className="text-panel-muted">Anzeigename (erscheint in n8n und im Digest)</span>
                <input value={formular.name} onChange={(e) => setFormular({ ...formular, name: e.target.value })} />
              </label>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <label className="text-sm space-y-1">
                  <span className="text-panel-muted">IMAP-Server</span>
                  <input value={formular.host} onChange={(e) => setFormular({ ...formular, host: e.target.value })} placeholder="imap.example.org" />
                </label>
                <label className="text-sm space-y-1">
                  <span className="text-panel-muted">Port</span>
                  <input type="number" value={formular.port} onChange={(e) => setFormular({ ...formular, port: e.target.value })} />
                </label>
              </div>
              <label className="text-sm space-y-1">
                <span className="text-panel-muted">Benutzername / E-Mail-Adresse</span>
                <input value={formular.username} onChange={(e) => setFormular({ ...formular, username: e.target.value })} autoComplete="off" />
              </label>
              <label className="text-sm space-y-1">
                <span className="text-panel-muted">
                  Passwort {formular.id && <span className="text-xs">(leer lassen = unverändert)</span>}
                </span>
                <input type="password" value={formular.passwort} onChange={(e) => setFormular({ ...formular, passwort: e.target.value })} autoComplete="new-password" />
              </label>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <button onClick={testen} className="btn-ghost">Verbindung testen</button>
              {test === 'laeuft' && <Loader2 size={16} className="animate-spin text-panel-muted" />}
              {test?.ok && (
                <span className="flex items-center gap-1 text-panel-green">
                  <CheckCircle2 size={16} /> Verbunden ({test.nachrichten} Mails in der Inbox)
                </span>
              )}
              {test?.error && (
                <span className="flex items-center gap-1 text-panel-red">
                  <XCircle size={16} /> {test.error}
                </span>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setFormular(null)} className="btn-ghost">Abbrechen</button>
              <button onClick={speichern} disabled={laedt} className="btn-primary">
                {laedt ? 'Speichere und verdrahte…' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
