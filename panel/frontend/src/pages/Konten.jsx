import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle, Loader2, X } from 'lucide-react';
import api from '../api';

const LEER = { name: '', host: '', port: 993, username: '', passwort: '', tlsUnsicher: false };

// Bekannte Anbieter — spart dem Nutzer das Nachschlagen der Serverdaten
const VORLAGEN = [
  { label: 'Gmail (IMAP)', defaultName: 'Gmail', host: 'imap.gmail.com', port: 993 },
  { label: 'Web.de', defaultName: 'Web.de', host: 'imap.web.de', port: 993 },
  { label: 'GMX', defaultName: 'GMX', host: 'imap.gmx.net', port: 993 },
  { label: 'Mailbox.org', defaultName: 'Mailbox', host: 'imap.mailbox.org', port: 993 },
  { label: 'Mailcow / eigener Server', defaultName: 'Mailcow', host: '', port: 993 },
];

export default function Konten() {
  const [konten, setKonten] = useState(null);
  const [formular, setFormular] = useState(null); // null = zu, sonst Konto-Entwurf
  const [test, setTest] = useState(null);         // null | 'laeuft' | {ok} | {error}
  const [meldung, setMeldung] = useState('');
  const [laedt, setLaedt] = useState(false);
  const [zeigeOrdner, setZeigeOrdner] = useState(false);

  const laden = () => api.get('/konten').then((res) => setKonten(res.data));
  useEffect(() => { laden(); }, []);

  const oeffnen = (konto) => {
    setTest(null);
    setMeldung('');
    setZeigeOrdner(false);
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
      <div className="flex items-center justify-end">
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
                    onClick={() => setFormular((f) => ({ ...f, name: f.name || v.defaultName, host: v.host, port: v.port }))}
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
              {Number(formular.port) !== 993 && (
                <p className="text-xs text-panel-orange -mt-1">
                  Empfohlen ist Port 993 (durchgehend verschlüsselt). Auf Port 143 verweigern
                  viele Server die Anmeldung, weil n8n dort kein STARTTLS anbietet.
                </p>
              )}
              <label className="text-sm space-y-1">
                <span className="text-panel-muted">Benutzername / E-Mail-Adresse</span>
                <input value={formular.username} onChange={(e) => setFormular({ ...formular, username: e.target.value })} autoComplete="off" />
              </label>
              <label className="text-sm space-y-1">
                <span className="text-panel-muted flex flex-col">
                  <span>Passwort {formular.id && <span className="text-xs text-panel-text">(leer lassen = unverändert)</span>}</span>
                  <span className="text-xs text-panel-orange mt-0.5">Wichtig: Bei aktiver Zwei-Faktor-Authentifizierung (2FA) musst du hier ein spezielles App-Passwort deines Anbieters eintragen!</span>
                </span>
                <input type="password" value={formular.passwort} onChange={(e) => setFormular({ ...formular, passwort: e.target.value })} autoComplete="new-password" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="w-auto"
                  checked={Boolean(formular.tlsUnsicher)}
                  onChange={(e) => setFormular({ ...formular, tlsUnsicher: e.target.checked })}
                />
                <span className="text-panel-muted">
                  Selbstsigniertes Zertifikat akzeptieren
                  <span className="block text-xs">Nur nötig bei eigenen Mailservern ohne offizielles Zertifikat</span>
                </span>
              </label>

              <div className="pt-2 border-t border-panel-border mt-2">
                <button
                  type="button"
                  onClick={() => setZeigeOrdner(!zeigeOrdner)}
                  className="text-xs text-panel-muted hover:text-panel-text flex items-center gap-1"
                >
                  {zeigeOrdner ? 'Erweiterte Ordner-Einstellungen ausblenden' : 'Erweiterte Optionen: Eigene IMAP-Ordnernamen festlegen'}
                </button>
                
                {zeigeOrdner && (
                  <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-panel-border/50">
                    <label className="text-sm space-y-1">
                      <span className="text-panel-muted">Spam/Quarantäne</span>
                      <input value={formular.folder_spam || ''} onChange={(e) => setFormular({ ...formular, folder_spam: e.target.value })} placeholder="Quarantaene" className="text-xs py-1.5" />
                    </label>
                    <label className="text-sm space-y-1">
                      <span className="text-panel-muted">Rechnungen</span>
                      <input value={formular.folder_invoices || ''} onChange={(e) => setFormular({ ...formular, folder_invoices: e.target.value })} placeholder="Rechnungen" className="text-xs py-1.5" />
                    </label>
                    <label className="text-sm space-y-1">
                      <span className="text-panel-muted">Bestellungen</span>
                      <input value={formular.folder_orders || ''} onChange={(e) => setFormular({ ...formular, folder_orders: e.target.value })} placeholder="Bestellungen" className="text-xs py-1.5" />
                    </label>
                    <label className="text-sm space-y-1">
                      <span className="text-panel-muted">Newsletter</span>
                      <input value={formular.folder_newsletter || ''} onChange={(e) => setFormular({ ...formular, folder_newsletter: e.target.value })} placeholder="Newsletter" className="text-xs py-1.5" />
                    </label>
                    <p className="col-span-2 text-xs text-panel-muted mt-1">
                      Bleiben Felder leer, werden die Standard-Ordnernamen (im Platzhalter angezeigt) verwendet.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <button onClick={testen} className="btn-ghost">Verbindung testen</button>
              {test === 'laeuft' && <Loader2 size={16} className="animate-spin text-panel-muted" />}
              {test?.ok && (
                <span className="flex items-center gap-1 text-panel-green">
                  <CheckCircle2 size={16} /> Verbunden ({test.nachrichten} Mails in der Inbox)
                  {test.fehlendeOrdner?.length > 0 && (
                    <span className="text-panel-orange" title="Wenn du eine eigene Ordnerstruktur nutzt, kannst du dies ignorieren.">
                      — fehlende Ordner (optional): {test.fehlendeOrdner.join(', ')}
                    </span>
                  )}
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
