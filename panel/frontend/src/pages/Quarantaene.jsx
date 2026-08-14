import { useEffect, useState } from 'react';
import { Mail, Trash2, CheckCircle, ShieldAlert, Check } from 'lucide-react';
import api from '../api';

export default function Quarantaene() {
  const [tab, setTab] = useState('n8n');
  const [n8nLogs, setN8nLogs] = useState([]);
  const [mailcowQ, setMailcowQ] = useState([]);
  const [mcDisabled, setMcDisabled] = useState(false);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState('');
  const [mcGewaehlt, setMcGewaehlt] = useState(new Set());

  useEffect(() => {
    ladeDaten(tab);
  }, [tab]);

  const ladeDaten = async (aktTab) => {
    setLaedt(true);
    setFehler('');
    try {
      if (aktTab === 'n8n') {
        const { data } = await api.get('/quarantaene/log');
        setN8nLogs(data);
      } else {
        const { data } = await api.get('/quarantaene/mailcow');
        if (data.disabled) {
          setMcDisabled(true);
        } else {
          setMcDisabled(false);
          setMailcowQ(data);
          setMcGewaehlt(new Set());
        }
      }
    } catch (err) {
      setFehler(err.response?.data?.error || 'Fehler beim Laden');
    } finally {
      setLaedt(false);
    }
  };

  const toggleGewaehlt = (id) => {
    const s = new Set(mcGewaehlt);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setMcGewaehlt(s);
  };

  const toggleAlle = () => {
    if (mcGewaehlt.size === mailcowQ.length) setMcGewaehlt(new Set());
    else setMcGewaehlt(new Set(mailcowQ.map(q => q.id || q.qhash)));
  };

  const ausfuehren = async (aktion) => {
    if (mcGewaehlt.size === 0) return;
    setLaedt(true);
    try {
      const ids = Array.from(mcGewaehlt);
      await api.post(`/quarantaene/mailcow/${aktion}`, { ids });
      await ladeDaten('mailcow');
    } catch (err) {
      setFehler(err.response?.data?.error || `Fehler bei der Aktion ${aktion}`);
      setLaedt(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex gap-2 border-b border-panel-border">
        <button
          onClick={() => setTab('n8n')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'n8n' ? 'border-panel-accent text-panel-accent' : 'border-transparent text-panel-muted hover:text-panel-text'
          }`}
        >
          n8n (KI-Klassifizierung)
        </button>
        <button
          onClick={() => setTab('mailcow')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'mailcow' ? 'border-panel-accent text-panel-accent' : 'border-transparent text-panel-muted hover:text-panel-text'
          }`}
        >
          Mailcow (Rspamd)
        </button>
      </div>

      {fehler && <div className="p-3 bg-panel-red/10 border border-panel-red/30 text-panel-red rounded text-sm">{fehler}</div>}

      {tab === 'n8n' && (
        <div className="card">
          <p className="text-sm text-panel-muted mb-4">
            Dies ist ein schreibgeschütztes Log der Mails, die von den n8n-Workflows (via KI, ClamAV, DNSBL) abgefangen wurden.
            Die eigentlichen E-Mails liegen in den jeweiligen Ordnern (z.B. INBOX/Quarantäne) im IMAP-Postfach.
          </p>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-panel-border text-panel-muted">
                  <th className="py-2 px-3 font-medium">Datum</th>
                  <th className="py-2 px-3 font-medium">Konto</th>
                  <th className="py-2 px-3 font-medium">Absender</th>
                  <th className="py-2 px-3 font-medium">Kategorie</th>
                  <th className="py-2 px-3 font-medium">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-panel-border">
                {n8nLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-panel-muted">{laedt ? 'Lade...' : 'Keine Logs vorhanden.'}</td>
                  </tr>
                ) : (
                  n8nLogs.map(log => (
                    <tr key={log.id} className="hover:bg-panel-surface">
                      <td className="py-2 px-3 text-panel-muted">{new Date(log.created_at).toLocaleString('de-DE')}</td>
                      <td className="py-2 px-3">{log.konto}</td>
                      <td className="py-2 px-3 truncate max-w-[200px]" title={log.von}>{log.von}</td>
                      <td className="py-2 px-3">
                        {log.kategorie === 'Malware' || log.kategorie === 'Phishing' 
                          ? <span className="text-panel-red flex items-center gap-1"><ShieldAlert size={14} /> {log.kategorie}</span>
                          : log.kategorie
                        }
                      </td>
                      <td className="py-2 px-3 text-panel-muted">{log.spam_score !== null ? log.spam_score : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'mailcow' && (
        <div className="card">
          {mcDisabled ? (
            <div className="text-center py-6 text-panel-muted space-y-2">
              <Mail size={32} className="mx-auto opacity-50" />
              <p>Mailcow ist nicht eingerichtet.</p>
              <p className="text-xs">Aktiviere Mailcow in den Einstellungen, um diese Ansicht zu nutzen.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-panel-muted">
                  Zeigt die in Mailcow zurückgehaltenen E-Mails an (Quarantäne). 
                </p>
                <div className="flex gap-2">
                  <button 
                    onClick={() => ausfuehren('delete')} 
                    disabled={mcGewaehlt.size === 0 || laedt} 
                    className="btn-ghost !text-panel-red flex items-center gap-1"
                  >
                    <Trash2 size={16} /> Löschen
                  </button>
                  <button 
                    onClick={() => ausfuehren('deliver')} 
                    disabled={mcGewaehlt.size === 0 || laedt} 
                    className="btn-primary flex items-center gap-1"
                  >
                    <CheckCircle size={16} /> Zustellen
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-panel-border text-panel-muted">
                      <th className="py-2 px-3 w-8">
                        <input 
                          type="checkbox" 
                          checked={mailcowQ.length > 0 && mcGewaehlt.size === mailcowQ.length}
                          onChange={toggleAlle}
                        />
                      </th>
                      <th className="py-2 px-3 font-medium">Datum</th>
                      <th className="py-2 px-3 font-medium">Absender</th>
                      <th className="py-2 px-3 font-medium">Empfänger</th>
                      <th className="py-2 px-3 font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-panel-border">
                    {mailcowQ.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-4 text-center text-panel-muted">{laedt ? 'Lade...' : 'Quarantäne ist leer.'}</td>
                      </tr>
                    ) : (
                      mailcowQ.map(q => {
                        const id = q.id || q.qhash; // id oder qhash je nach mailcow version
                        return (
                          <tr key={id} className="hover:bg-panel-surface">
                            <td className="py-2 px-3">
                              <input 
                                type="checkbox" 
                                checked={mcGewaehlt.has(id)} 
                                onChange={() => toggleGewaehlt(id)}
                              />
                            </td>
                            <td className="py-2 px-3 text-panel-muted">
                              {new Date(q.created ? q.created * 1000 : Date.now()).toLocaleString('de-DE')}
                            </td>
                            <td className="py-2 px-3 truncate max-w-[200px]" title={q.sender}>{q.sender}</td>
                            <td className="py-2 px-3">{q.rcpt}</td>
                            <td className="py-2 px-3 font-mono">{q.score}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
