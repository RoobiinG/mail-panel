import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, PlugZap } from 'lucide-react';
import api from '../api';

const DIENSTE = [
  { id: 'n8n', label: 'n8n-API' },
  { id: 'mailcow', label: 'Mailcow-API' },
  { id: 'clamav', label: 'ClamAV (clamd)' },
  { id: 'unbound', label: 'unbound (DNSBL-Resolver)' },
];

export default function Einstellungen() {
  const [settings, setSettings] = useState(null);
  const [dnsblText, setDnsblText] = useState('');
  const [meldung, setMeldung] = useState('');
  const [tests, setTests] = useState({}); // { dienst: 'laeuft' | 'ok' | Fehlertext }

  useEffect(() => {
    api.get('/einstellungen').then((res) => {
      setSettings(res.data);
      try {
        setDnsblText(JSON.parse(res.data.dnsbl_listen || '[]').join('\n'));
      } catch {
        setDnsblText('');
      }
    });
  }, []);

  const speichern = async () => {
    setMeldung('');
    const listen = dnsblText.split('\n').map((z) => z.trim()).filter(Boolean);
    try {
      await api.put('/einstellungen', {
        ...settings,
        dnsbl_listen: JSON.stringify(listen),
      });
      setMeldung('Gespeichert.');
    } catch (err) {
      setMeldung(err.response?.data?.error || 'Speichern fehlgeschlagen.');
    }
  };

  const testen = async (dienst) => {
    setTests((t) => ({ ...t, [dienst]: 'laeuft' }));
    try {
      await api.post(`/einstellungen/test/${dienst}`);
      setTests((t) => ({ ...t, [dienst]: 'ok' }));
    } catch (err) {
      setTests((t) => ({ ...t, [dienst]: err.response?.data?.error || 'Fehler' }));
    }
  };

  if (!settings) return <p className="text-panel-muted">Lade…</p>;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>

      <div className="card space-y-4">
        <h2 className="font-medium">Spam-Prüfung</h2>
        <label className="block text-sm space-y-1">
          <span className="text-panel-muted">Spam-Schwellwert (0–1): ab diesem Score geht eine Mail in Quarantäne</span>
          <input
            type="number" min="0" max="1" step="0.05"
            value={settings.spam_schwellwert}
            onChange={(e) => setSettings({ ...settings, spam_schwellwert: e.target.value })}
          />
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-panel-muted">DNSBL-Listen (eine pro Zeile)</span>
          <textarea
            rows={4}
            className="font-mono"
            value={dnsblText}
            onChange={(e) => setDnsblText(e.target.value)}
          />
        </label>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="w-auto"
              checked={settings.clamav_aktiv === '1'}
              onChange={(e) => setSettings({ ...settings, clamav_aktiv: e.target.checked ? '1' : '0' })}
            />
            Virenscan (ClamAV) aktiv
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="w-auto"
              checked={settings.safebrowsing_aktiv === '1'}
              onChange={(e) => setSettings({ ...settings, safebrowsing_aktiv: e.target.checked ? '1' : '0' })}
            />
            Link-Check (Safe Browsing) aktiv
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={speichern} className="btn-primary">Speichern</button>
          {meldung && <span className="text-sm text-panel-muted">{meldung}</span>}
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="font-medium flex items-center gap-2"><PlugZap size={18} /> Verbindungstests</h2>
        <p className="text-sm text-panel-muted">
          Prüft die Erreichbarkeit der Dienste aus Sicht des Panel-Backends
          (Zugangsdaten kommen aus den Env-Variablen des Containers).
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {DIENSTE.map(({ id, label }) => (
            <div key={id} className="flex items-center justify-between bg-panel-card border border-panel-border rounded-md px-3 py-2">
              <span className="text-sm">{label}</span>
              <div className="flex items-center gap-2">
                {tests[id] === 'laeuft' && <Loader2 size={16} className="animate-spin text-panel-muted" />}
                {tests[id] === 'ok' && <CheckCircle2 size={16} className="text-panel-green" />}
                {tests[id] && tests[id] !== 'laeuft' && tests[id] !== 'ok' && (
                  <span title={tests[id]}><XCircle size={16} className="text-panel-red" /></span>
                )}
                <button onClick={() => testen(id)} className="btn-ghost !py-1 !px-2 text-xs">Testen</button>
              </div>
            </div>
          ))}
        </div>
        {Object.entries(tests).filter(([, v]) => v && v !== 'laeuft' && v !== 'ok').map(([k, v]) => (
          <p key={k} className="text-xs text-panel-red font-mono">{k}: {v}</p>
        ))}
      </div>
    </div>
  );
}
