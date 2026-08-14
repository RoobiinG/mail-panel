import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, PlugZap, ShieldCheck, KeyRound, Trash2 } from 'lucide-react';
import api from '../api';

const DIENSTE = [
  { id: 'n8n', label: 'n8n-API' },
  { id: 'mailcow', label: 'Mailcow-API' },
  { id: 'clamav', label: 'ClamAV (clamd)' },
  { id: 'unbound', label: 'unbound (DNSBL-Resolver)' },
  { id: 'nextcloud', label: 'Nextcloud (WebDAV)' },
  { id: 'smtp', label: 'Postausgang (SMTP)' },
];

// Kleiner Block für die Google-Anmeldung — sie läuft über eine Weiterleitung,
// deshalb kein einfaches Eingabefeld.
function GoogleVerbindung() {
  const [status, setStatus] = useState(null);
  const [fehler, setFehler] = useState('');

  const laden = () => api.get('/google/status').then((r) => setStatus(r.data)).catch(() => setStatus(null));
  useEffect(() => { laden(); }, []);

  const verbinden = async () => {
    setFehler('');
    try {
      const r = await api.post('/google/start');
      window.open(r.data.link, '_blank', 'noopener');
    } catch (err) {
      setFehler(err.response?.data?.error || 'Anmeldung konnte nicht gestartet werden.');
    }
  };
  const loesen = async () => { await api.delete('/google').catch(() => {}); laden(); };

  if (!status) return null;
  return (
    <div className="text-sm space-y-2">
      <div className="flex items-center gap-3">
        <span className={status.verbunden ? 'text-panel-green' : 'text-panel-muted'}>
          {status.verbunden ? 'Mit Google verbunden' : 'Noch nicht mit Google verbunden'}
        </span>
        {status.verbunden ? (
          <button onClick={loesen} className="btn-ghost !py-1 !px-2 text-xs">Verbindung lösen</button>
        ) : (
          <button onClick={verbinden} className="btn-ghost !py-1 !px-2 text-xs">Mit Google verbinden</button>
        )}
        <button onClick={laden} className="text-xs text-panel-muted underline">Status prüfen</button>
      </div>
      <p className="text-xs text-panel-muted">
        Diese Adresse muss in der Google Cloud Console als Weiterleitungs-URI stehen:{' '}
        <code className="text-panel-text break-all">{status.rueckkehrAdresse}</code>
      </p>
      {fehler && <p className="text-panel-red text-xs">{fehler}</p>}
    </div>
  );
}

export default function Einstellungen() {
  const [settings, setSettings] = useState(null);
  const [dnsblText, setDnsblText] = useState('');
  const [meldung, setMeldung] = useState('');
  const [tests, setTests] = useState({}); // { dienst: 'laeuft' | 'ok' | Fehlertext }

  // Passkeys
  const [passkeys, setPasskeys] = useState([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [pkLaedt, setPkLaedt] = useState(false);
  const [pkMeldung, setPkMeldung] = useState('');

  // Oberfläche
  const [showPrideFlag, setShowPrideFlag] = useState(() => localStorage.getItem('show_pride_flag') !== 'false');

  const togglePrideFlag = (e) => {
    const val = e.target.checked;
    setShowPrideFlag(val);
    localStorage.setItem('show_pride_flag', val);
    window.dispatchEvent(new Event('pride_flag_change'));
  };

  const loadPasskeys = async () => {
    try {
      const { data } = await api.get('/passkeys');
      setPasskeys(data);
    } catch {
      // Fehler ignorieren
    }
  };

  useEffect(() => {
    loadPasskeys();
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

  const registerPasskey = async () => {
    setPkMeldung('');
    setPkLaedt(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const optRes = await api.get('/passkeys/register/start');
      const attResp = await startRegistration({ optionsJSON: optRes.data });
      const name = passkeyName.trim() || 'Passkey';
      await api.post('/passkeys/register/finish', { registration: attResp, name });
      setPasskeyName('');
      await loadPasskeys();
      setPkMeldung(`Passkey "${name}" erfolgreich registriert`);
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Dialog abgebrochen.'
        : err.response?.data?.error || err.message;
      setPkMeldung('Fehler: ' + msg);
    } finally {
      setPkLaedt(false);
    }
  };

  const deletePasskey = async (id) => {
    if (!confirm('Passkey wirklich löschen?')) return;
    try {
      await api.delete(`/passkeys/${id}`);
      await loadPasskeys();
      setPkMeldung('Passkey gelöscht');
    } catch {
      setPkMeldung('Fehler beim Löschen');
    }
  };

  if (!settings) return <p className="text-panel-muted">Lade…</p>;

  // Zugangsdaten-Feld: per Env gesetzte Werte sind nur lesbar
  const zugangsFeld = (key, label, platzhalter, typ = 'text') => (
    <label className="block text-sm space-y-1">
      <span className="text-panel-muted">
        {label}
        {settings[`${key}_per_env`] && <span className="ml-2 text-xs">(per Umgebungsvariable gesetzt)</span>}
      </span>
      <input
        type={typ}
        value={settings[key] || ''}
        placeholder={platzhalter}
        disabled={settings[`${key}_per_env`]}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="card space-y-4">
        <h2 className="font-medium">Verbindungen</h2>
        <p className="text-sm text-panel-muted">
          Zugangsdaten werden verschlüsselt im Panel gespeichert. Der n8n-API-Key wird für die
          Konten-Verwaltung gebraucht (in n8n unter Einstellungen → n8n API erzeugen);
          Mailcow und Safe Browsing sind optional.
        </p>
        {zugangsFeld('n8n_url', 'n8n-Adresse', 'http://n8n:5678')}
        {zugangsFeld('n8n_api_key', 'n8n-API-Key', 'n8n_api_…', 'password')}
        {zugangsFeld('mailcow_url', 'Mailcow-Adresse (optional)', 'https://mail.example.org')}
        {zugangsFeld('mailcow_api_key', 'Mailcow-API-Key (optional)', '', 'password')}
        {zugangsFeld('safebrowsing_api_key', 'Google-Safe-Browsing-Key (optional)', '', 'password')}
        <div className="flex items-center gap-3">
          <button onClick={speichern} className="btn-primary">Speichern</button>
          {meldung && <span className="text-sm text-panel-muted">{meldung}</span>}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium">KI & Benachrichtigungen</h2>
        <p className="text-sm text-panel-muted">
          Konfiguration für die E-Mail-Klassifizierung (Gemini) und Benachrichtigungen (Telegram).
          Die Werte werden bei der Synchronisierung an die n8n-Workflows verteilt.
        </p>
        {zugangsFeld('gemini_api_key', 'Gemini API-Key', '', 'password')}
        {zugangsFeld('telegram_token', 'Telegram Bot-Token', '123456:ABC-DEF1234ghIkl-zyx...', 'password')}
        {zugangsFeld('telegram_chat_id', 'Telegram Chat-ID', '123456789')}
        <div className="flex items-center gap-3">
          <button onClick={speichern} className="btn-primary">Speichern</button>
          {meldung && <span className="text-sm text-panel-muted">{meldung}</span>}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium">Postausgang (SMTP)</h2>
        <p className="text-sm text-panel-muted">
          Nur für das Abbestellen von Newslettern: Manche Verteiler wollen eine Mail an eine
          Abmeldeadresse statt eines Links. Ohne diese Angaben bleibt der Versand-Knoten in
          Workflow 06 stillgelegt — alles andere läuft weiter. Das Panel legt die Zugangsdaten
          anschließend selbst in n8n an.
        </p>
        {zugangsFeld('smtp_host', 'SMTP-Server', 'mail.example.org')}
        {zugangsFeld('smtp_port', 'Port', '587')}
        {zugangsFeld('smtp_user', 'Benutzername', 'panel@example.org')}
        {zugangsFeld('smtp_passwort', 'Passwort', '', 'password')}
        {zugangsFeld('smtp_absender', 'Absenderadresse', 'panel@example.org')}
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="w-auto"
            checked={settings.smtp_tls_unsicher === '1'}
            onChange={(e) => setSettings({ ...settings, smtp_tls_unsicher: e.target.checked ? '1' : '0' })}
          />
          <span className="text-panel-muted">
            Selbstsigniertes Zertifikat akzeptieren
            <span className="block text-xs">Nur nötig bei eigenen Mailservern ohne offizielles Zertifikat</span>
          </span>
        </label>
        <div className="flex items-center gap-3">
          <button onClick={speichern} className="btn-primary">Speichern</button>
          {meldung && <span className="text-sm text-panel-muted">{meldung}</span>}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium">Ziele für eigene Aktionen</h2>
        <p className="text-sm text-panel-muted">
          Wohin eigene Aktionen etwas ablegen dürfen. Für Nextcloud ein App-Passwort
          verwenden (Nextcloud → Einstellungen → Sicherheit), nicht das Konto-Passwort.
          Die Zugangsdaten hinterlegt das Panel anschließend selbst in n8n.
        </p>
        {zugangsFeld('nextcloud_url', 'Nextcloud-Adresse', 'https://cloud.example.org')}
        {zugangsFeld('nextcloud_user', 'Nextcloud-Benutzer', 'robin')}
        {zugangsFeld('nextcloud_passwort', 'Nextcloud-App-Passwort', '', 'password')}
        {zugangsFeld('nextcloud_kalender', 'Nextcloud-Kalender (Name in der Adresse)', 'personal')}

        <div className="pt-2 border-t border-panel-border" />
        <p className="text-sm text-panel-muted">
          Für Google-Termine: Client-ID und Secret aus der Google Cloud Console eintragen,
          speichern und dann unten verbinden. Die Anmeldung läuft im Panel — in n8n musst
          du dafür nichts einrichten.
        </p>
        {zugangsFeld('google_client_id', 'Google Client-ID', '...apps.googleusercontent.com')}
        {zugangsFeld('google_client_secret', 'Google Client-Secret', '', 'password')}
        {zugangsFeld('google_kalender_id', 'Google-Kalender', 'primary')}
        <GoogleVerbindung />

        <div className="flex items-center gap-3">
          <button onClick={speichern} className="btn-primary">Speichern</button>
          {meldung && <span className="text-sm text-panel-muted">{meldung}</span>}
        </div>
      </div>

      <div className="card space-y-2">
        <h2 className="font-medium">Panel-Secret für die n8n-Workflows</h2>
        <p className="text-sm text-panel-muted">
          Die Workflows rufen die Prüfdienste des Panels mit diesem Schlüssel auf. In n8n als
          Header-Auth-Credential anlegen: Name <code className="text-panel-text">X-Panel-Secret</code>,
          Wert:
        </p>
        <code className="block bg-panel-card border border-panel-border rounded-md p-2 text-xs font-mono break-all">
          {settings.panel_secret}
        </code>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium flex items-center gap-2"><ShieldCheck size={18} /> Passkeys (WebAuthn)</h2>
        <p className="text-sm text-panel-muted">
          Passkeys ermöglichen passwortlosen Login per Fingerabdruck, Face ID, Hardware-Key oder Passwort-Manager.
        </p>
        
        {passkeys.length > 0 && (
          <div className="space-y-2 mb-4">
            <p className="text-xs font-medium text-panel-text">Registrierte Passkeys ({passkeys.length})</p>
            <div className="grid gap-2">
              {passkeys.map(pk => (
                <div key={pk.id} className="flex items-center justify-between p-2 rounded border border-panel-border bg-panel-surface">
                  <div>
                    <p className="text-sm font-medium">{pk.name || pk.device_type}</p>
                    <p className="text-xs text-panel-muted">Hinzugefügt am {new Date(pk.created_at).toLocaleDateString()}</p>
                  </div>
                  <button onClick={() => deletePasskey(pk.id)} className="p-1.5 text-panel-red hover:bg-panel-red/10 rounded transition-colors">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <input
            type="text"
            placeholder="Name (z.B. YubiKey)"
            value={passkeyName}
            onChange={e => setPasskeyName(e.target.value)}
            className="flex-1 max-w-[200px]"
          />
          <button onClick={registerPasskey} disabled={pkLaedt} className="btn-primary">
            {pkLaedt ? '…' : '+ Passkey registrieren'}
          </button>
        </div>
        {pkMeldung && <p className="text-sm text-panel-muted mt-2">{pkMeldung}</p>}
      </div>

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

      <div className="card space-y-4">
        <h2 className="font-medium">Oberfläche</h2>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="w-auto"
            checked={showPrideFlag}
            onChange={togglePrideFlag}
          />
          Pride Flag im Menü anzeigen
        </label>
      </div>
    </div>
  );
}
