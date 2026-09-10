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
                    <td colSpan={5} className="py-8 text-center text-panel-muted">{laedt ? 'Sucht Logs...' : 'Keine Quarantäne-Fälle vorhanden.'}</td>
                  </tr>
                ) : (
                  n8nLogs.map(log => {
                    const istGefahr = log.kategorie === 'Malware' || log.kategorie === 'Phishing';
                    const istSpam = log.kategorie === 'Spam';
                    return (
                    <tr key={log.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                      <td className="py-3 px-3 text-panel-muted text-xs whitespace-nowrap">{new Date(log.created_at).toLocaleString('de-DE')}</td>
                      <td className="py-3 px-3 whitespace-nowrap">{log.konto}</td>
                      <td className="py-3 px-3 truncate max-w-[240px]" title={log.von}>{log.von}</td>
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border ${
                          istGefahr 
                            ? 'bg-red-500/10 text-red-400 border-red-500/20' 
                            : istSpam
                              ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                              : 'bg-panel-bg text-panel-muted border-panel-border'
                        }`}>
                          {istGefahr && <ShieldAlert size={12} />}
                          {log.kategorie}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-xs">
                        {log.spam_score !== null ? (
                           <span className={`px-2 py-0.5 rounded font-mono ${
                             log.spam_score >= 0.8 ? 'bg-orange-500/10 text-orange-400' : 'text-panel-muted'
                           }`}>
                             {Number(log.spam_score).toFixed(2)}
                           </span>
                        ) : '—'}
                      </td>
                    </tr>
                    );
                  })
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
                        <td colSpan={5} className="py-8 text-center text-panel-muted">{laedt ? 'Sucht Quarantäne-Mails...' : 'Quarantäne ist leer.'}</td>
                      </tr>
                    ) : (
                      mailcowQ.map(q => {
                        const id = q.id || q.qhash; // id oder qhash je nach mailcow version
                        const scoreNum = parseFloat(q.score) || 0;
                        const scoreGefahr = scoreNum >= 15;
                        const scoreSpam = scoreNum >= 5 && !scoreGefahr;
                        
                        return (
                          <tr key={id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                            <td className="py-3 px-3">
                              <input 
                                type="checkbox" 
                                checked={mcGewaehlt.has(id)} 
                                onChange={() => toggleGewaehlt(id)}
                              />
                            </td>
                            <td className="py-3 px-3 text-xs text-panel-muted whitespace-nowrap">
                              {new Date(q.created ? q.created * 1000 : Date.now()).toLocaleString('de-DE')}
                            </td>
                            <td className="py-3 px-3 truncate max-w-[240px]" title={q.sender}>{q.sender}</td>
                            <td className="py-3 px-3 truncate max-w-[200px]" title={q.rcpt}>{q.rcpt}</td>
                            <td className="py-3 px-3 text-xs">
                              <span className={`px-2 py-0.5 rounded font-mono ${
                                scoreGefahr ? 'bg-red-500/10 text-red-400' 
                                : scoreSpam ? 'bg-orange-500/10 text-orange-400' 
                                : 'text-panel-muted'
                              }`}>
                                {q.score}
                              </span>
                            </td>
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
