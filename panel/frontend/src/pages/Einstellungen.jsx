import { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, Loader2, PlugZap, ShieldCheck, Trash2,
  Eye, EyeOff, Save, KeyRound, Cpu, Mail, Cloud, Server,
  Link, Wifi, TestTube2, ChevronDown, ChevronUp,
} from 'lucide-react';
import api from '../api';

// ─── Toggle-Switch ────────────────────────────────────────────────────────────

function Toggle({ on, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
        on ? 'bg-panel-accent' : 'bg-panel-border'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ease-in-out mt-0.5 ${
        on ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

// ─── Passwort-Feld mit Sichtbarkeits-Toggle ───────────────────────────────────

function PwFeld({ label, value, placeholder, disabled, onChange, hinweis }) {
  const [sichtbar, setSichtbar] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-panel-muted">{label}</label>
      {hinweis && <p className="text-[10px] text-panel-muted/60">{hinweis}</p>}
      <div className="relative">
        <input
          type={sichtbar ? 'text' : 'password'}
          value={value || ''}
          placeholder={placeholder}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className="w-full pr-8"
        />
        <button
          type="button"
          onClick={() => setSichtbar(s => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-panel-muted/50 hover:text-panel-muted transition-colors"
          tabIndex={-1}
        >
          {sichtbar ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
      {disabled && (
        <p className="text-[10px] text-panel-muted/50">Über Umgebungsvariable gesetzt</p>
      )}
    </div>
  );
}

// ─── Text-Feld ────────────────────────────────────────────────────────────────

function Feld({ label, value, placeholder, disabled, onChange, hinweis, typ = 'text' }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-panel-muted">{label}</label>
      {hinweis && <p className="text-[10px] text-panel-muted/60">{hinweis}</p>}
      <input
        type={typ}
        value={value || ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-full"
      />
      {disabled && (
        <p className="text-[10px] text-panel-muted/50">Über Umgebungsvariable gesetzt</p>
      )}
    </div>
  );
}

// ─── Sektion (aufklappbar) ────────────────────────────────────────────────────

function Sektion({ icon: Icon, titel, kinder, standard = true }) {
  const [offen, setOffen] = useState(standard);
  return (
    <div className="card !p-0 overflow-hidden">
      <button
        onClick={() => setOffen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-panel-card/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-panel-accent" />}
          <span className="text-sm font-medium text-panel-text">{titel}</span>
        </div>
        {offen ? <ChevronUp size={14} className="text-panel-muted" /> : <ChevronDown size={14} className="text-panel-muted" />}
      </button>
      {offen && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-panel-border/50">
          {kinder}
        </div>
      )}
    </div>
  );
}

// ─── Speichern-Zeile ──────────────────────────────────────────────────────────

function SpeichernZeile({ onSpeichern, meldung }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <button onClick={onSpeichern} className="btn-primary flex items-center gap-1.5 !py-1.5 !px-3 text-sm">
        <Save size={13} />
        Speichern
      </button>
      {meldung && (
        <span className={`text-xs ${meldung.startsWith('Fehler') ? 'text-panel-red' : 'text-panel-accent'}`}>
          {meldung}
        </span>
      )}
    </div>
  );
}

// ─── Verbindungstest-Karte ────────────────────────────────────────────────────

function TestKarte({ id, label, onTest, ergebnis }) {
  const zustand = ergebnis?.[id];
  return (
    <div className="flex items-center justify-between bg-panel-card border border-panel-border rounded-md px-3 py-2">
      <div className="flex-1 min-w-0">
        <span className="text-sm">{label}</span>
        {zustand && zustand !== 'laeuft' && zustand !== 'ok' && (
          <p className="text-[10px] text-panel-red font-mono mt-0.5 break-words">{zustand}</p>
        )}
        {zustand === 'ok' && ergebnis?.[`${id}_hinweis`] && (
          <p className="text-[10px] text-panel-accent mt-0.5">{ergebnis[`${id}_hinweis`]}</p>
        )}
      </div>
      <div className="flex items-center gap-2 ml-3 flex-shrink-0">
        {zustand === 'laeuft' && <Loader2 size={15} className="animate-spin text-panel-muted" />}
        {zustand === 'ok'     && <CheckCircle2 size={15} className="text-panel-accent" />}
        {zustand && zustand !== 'laeuft' && zustand !== 'ok' && (
          <XCircle size={15} className="text-panel-red" />
        )}
        <button
          onClick={() => onTest(id)}
          className="btn-ghost !py-0.5 !px-2 text-xs flex items-center gap-1"
        >
          <TestTube2 size={12} />
          Testen
        </button>
      </div>
    </div>
  );
}

// ─── Google-Verbindung ────────────────────────────────────────────────────────

function GoogleVerbindung() {
  const [status, setStatus] = useState(null);
  const [fehler, setFehler] = useState('');

  const laden = () => api.get('/google/status').then(r => setStatus(r.data)).catch(() => setStatus(null));
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
    <div className="rounded-md border border-panel-border bg-panel-card px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status.verbunden ? 'bg-panel-accent' : 'bg-panel-muted/50'}`} />
          <span className="text-sm">
            {status.verbunden ? 'Verbunden' : 'Nicht verbunden'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {status.verbunden ? (
            <button onClick={loesen} className="btn-ghost !py-0.5 !px-2 text-xs text-panel-red hover:!text-panel-red">
              Verbindung lösen
            </button>
          ) : (
            <button onClick={verbinden} className="btn-ghost !py-0.5 !px-2 text-xs flex items-center gap-1">
              <Link size={12} />
              Mit Google verbinden
            </button>
          )}
          <button onClick={laden} className="text-xs text-panel-muted/60 hover:text-panel-muted transition-colors">
            Prüfen
          </button>
        </div>
      </div>
      <p className="text-[10px] text-panel-muted/60">
        Rücksprung-URI für die Google Cloud Console:{' '}
        <code className="text-panel-text break-all">{status.rueckkehrAdresse}</code>
      </p>
      {fehler && <p className="text-xs text-panel-red">{fehler}</p>}
    </div>
  );
}

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const DIENSTE = [
  { id: 'n8n',      label: 'n8n-API' },
  { id: 'mailcow',  label: 'Mailcow-API' },
  { id: 'gemini',   label: 'Gemini-API (KI-Klassifizierung)' },
  { id: 'google',   label: 'Google-Kalender (OAuth2)' },
  { id: 'clamav',   label: 'ClamAV (clamd)' },
  { id: 'unbound',  label: 'unbound (DNSBL-Resolver)' },
  { id: 'nextcloud',label: 'Nextcloud (WebDAV)' },
  { id: 'smtp',     label: 'Postausgang (SMTP)' },
];

export default function Einstellungen() {
  const [settings, setSettings] = useState(null);
  const [dnsblText, setDnsblText] = useState('');
  const [meldung, setMeldung] = useState({});   // { sektion: 'text' }
  const [tests, setTests] = useState({});        // { dienst: 'laeuft' | 'ok' | Fehlertext }

  // Passkeys
  const [passkeys,    setPasskeys]    = useState([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [pkLaedt,     setPkLaedt]     = useState(false);
  const [pkMeldung,   setPkMeldung]   = useState('');

  // Oberfläche
  const [showPrideFlag, setShowPrideFlag] = useState(
    () => localStorage.getItem('show_pride_flag') !== 'false'
  );

  const togglePrideFlag = (val) => {
    setShowPrideFlag(val);
    localStorage.setItem('show_pride_flag', val);
    window.dispatchEvent(new Event('pride_flag_change'));
  };

  const loadPasskeys = async () => {
    try { const { data } = await api.get('/passkeys'); setPasskeys(data); } catch { /* ignorieren */ }
  };

  useEffect(() => {
    loadPasskeys();
    api.get('/einstellungen').then(res => {
      setSettings(res.data);
      try { setDnsblText(JSON.parse(res.data.dnsbl_listen || '[]').join('\n')); } catch { setDnsblText(''); }
    });
  }, []);

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  const speichern = async (sektion) => {
    setMeldung(m => ({ ...m, [sektion]: '' }));
    const listen = dnsblText.split('\n').map(z => z.trim()).filter(Boolean);
    try {
      await api.put('/einstellungen', { ...settings, dnsbl_listen: JSON.stringify(listen) });
      setMeldung(m => ({ ...m, [sektion]: 'Gespeichert.' }));
      setTimeout(() => setMeldung(m => ({ ...m, [sektion]: '' })), 3000);
    } catch (err) {
      setMeldung(m => ({ ...m, [sektion]: 'Fehler: ' + (err.response?.data?.error || 'Unbekannt') }));
    }
  };

  const testen = async (dienst) => {
    setTests(t => ({ ...t, [dienst]: 'laeuft', [`${dienst}_hinweis`]: '' }));
    try {
      const { data } = await api.post(`/einstellungen/test/${dienst}`);
      setTests(t => ({
        ...t,
        [dienst]:             'ok',
        [`${dienst}_hinweis`]: data.hinweis || '',
      }));
    } catch (err) {
      setTests(t => ({
        ...t,
        [dienst]: err.response?.data?.error || 'Verbindungsfehler',
      }));
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
    } finally { setPkLaedt(false); }
  };

  const deletePasskey = async (id) => {
    if (!confirm('Passkey wirklich löschen?')) return;
    try { await api.delete(`/passkeys/${id}`); await loadPasskeys(); setPkMeldung('Passkey gelöscht'); }
    catch { setPkMeldung('Fehler beim Löschen'); }
  };

  if (!settings) return <p className="text-panel-muted">Lade…</p>;

  return (
    <div className="space-y-4 max-w-3xl">

      {/* ── Verbindungen ─────────────────────────────────────────────────────── */}
      <Sektion icon={Wifi} titel="Verbindungen">
        <p className="text-xs text-panel-muted">
          Zugangsdaten werden verschlüsselt gespeichert. Den n8n-API-Key findest du in n8n
          unter <em>Einstellungen → n8n API</em>.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Feld
            label="n8n-Adresse"
            value={settings.n8n_url}
            placeholder="http://n8n:5678"
            disabled={settings.n8n_url_per_env}
            onChange={v => set('n8n_url', v)}
          />
          <PwFeld
            label="n8n-API-Key"
            value={settings.n8n_api_key}
            placeholder="n8n_api_…"
            disabled={settings.n8n_api_key_per_env}
            onChange={v => set('n8n_api_key', v)}
          />
          <Feld
            label="Mailcow-Adresse (optional)"
            value={settings.mailcow_url}
            placeholder="https://mail.example.org"
            disabled={settings.mailcow_url_per_env}
            onChange={v => set('mailcow_url', v)}
          />
          <PwFeld
            label="Mailcow-API-Key (optional)"
            value={settings.mailcow_api_key}
            placeholder=""
            disabled={settings.mailcow_api_key_per_env}
            onChange={v => set('mailcow_api_key', v)}
          />
        </div>
        <SpeichernZeile onSpeichern={() => speichern('verbindungen')} meldung={meldung.verbindungen} />
      </Sektion>

      {/* ── KI & Benachrichtigungen ───────────────────────────────────────────── */}
      <Sektion icon={Cpu} titel="KI & Benachrichtigungen">
        <p className="text-xs text-panel-muted">
          Die Werte werden bei der Konto-Synchronisierung an die n8n-Workflows verteilt.
          Den Gemini-API-Key bekommst du kostenlos auf{' '}
          <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer"
            className="text-panel-accent hover:underline">aistudio.google.com</a>.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <PwFeld
            label="Gemini API-Key"
            value={settings.gemini_api_key}
            placeholder="AIza…"
            disabled={settings.gemini_api_key_per_env}
            onChange={v => set('gemini_api_key', v)}
            hinweis="Für KI-Klassifizierung (Free Tier genügt)"
          />
          <PwFeld
            label="Google Safe Browsing Key (optional)"
            value={settings.safebrowsing_api_key}
            placeholder=""
            disabled={settings.safebrowsing_api_key_per_env}
            onChange={v => set('safebrowsing_api_key', v)}
            hinweis="Für Link-Prüfung in Mails"
          />
          <PwFeld
            label="Telegram Bot-Token"
            value={settings.telegram_token}
            placeholder="123456:ABC-DEF…"
            disabled={settings.telegram_token_per_env}
            onChange={v => set('telegram_token', v)}
          />
          <Feld
            label="Telegram Chat-ID"
            value={settings.telegram_chat_id}
            placeholder="123456789"
            disabled={settings.telegram_chat_id_per_env}
            onChange={v => set('telegram_chat_id', v)}
          />
        </div>
        <SpeichernZeile onSpeichern={() => speichern('ki')} meldung={meldung.ki} />
      </Sektion>

      {/* ── Postausgang (SMTP) ────────────────────────────────────────────────── */}
      <Sektion icon={Mail} titel="Postausgang (SMTP)" standard={false}>
        <p className="text-xs text-panel-muted">
          Nur für das Abbestellen von Newslettern per Mail. Ohne Angaben bleibt der
          Versand-Knoten in Workflow 06 stillgelegt.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Feld label="SMTP-Server" value={settings.smtp_host} placeholder="mail.example.org"
            disabled={settings.smtp_host_per_env} onChange={v => set('smtp_host', v)} />
          <Feld label="Port" value={settings.smtp_port} placeholder="587" typ="number"
            disabled={settings.smtp_port_per_env} onChange={v => set('smtp_port', v)} />
          <Feld label="Benutzername" value={settings.smtp_user} placeholder="panel@example.org"
            disabled={settings.smtp_user_per_env} onChange={v => set('smtp_user', v)} />
          <PwFeld label="Passwort" value={settings.smtp_passwort} placeholder=""
            disabled={settings.smtp_passwort_per_env} onChange={v => set('smtp_passwort', v)} />
          <div className="sm:col-span-2">
            <Feld label="Absenderadresse" value={settings.smtp_absender} placeholder="panel@example.org"
              disabled={settings.smtp_absender_per_env} onChange={v => set('smtp_absender', v)} />
          </div>
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle
            on={settings.smtp_tls_unsicher === '1'}
            onToggle={() => set('smtp_tls_unsicher', settings.smtp_tls_unsicher === '1' ? '0' : '1')}
          />
          <div>
            <span className="text-sm">Selbstsigniertes Zertifikat akzeptieren</span>
            <p className="text-[10px] text-panel-muted/60">Nur nötig bei eigenen Mailservern ohne offizielles Zertifikat</p>
          </div>
        </label>
        <SpeichernZeile onSpeichern={() => speichern('smtp')} meldung={meldung.smtp} />
      </Sektion>

      {/* ── Ziele für eigene Aktionen ─────────────────────────────────────────── */}
      <Sektion icon={Cloud} titel="Ziele für eigene Aktionen" standard={false}>
        <p className="text-xs text-panel-muted">
          Wohin eigene Aktionen etwas ablegen dürfen. Für Nextcloud ein App-Passwort verwenden
          (Nextcloud → Einstellungen → Sicherheit).
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Feld label="Nextcloud-Adresse" value={settings.nextcloud_url} placeholder="https://cloud.example.org"
            disabled={settings.nextcloud_url_per_env} onChange={v => set('nextcloud_url', v)} />
          <Feld label="Nextcloud-Benutzer" value={settings.nextcloud_user} placeholder="robin"
            disabled={settings.nextcloud_user_per_env} onChange={v => set('nextcloud_user', v)} />
          <PwFeld label="Nextcloud-App-Passwort" value={settings.nextcloud_passwort} placeholder=""
            disabled={settings.nextcloud_passwort_per_env} onChange={v => set('nextcloud_passwort', v)} />
          <Feld label="Nextcloud-Kalender (Name in der Adresse)" value={settings.nextcloud_kalender}
            placeholder="personal" disabled={settings.nextcloud_kalender_per_env}
            onChange={v => set('nextcloud_kalender', v)} />
        </div>

        <div className="border-t border-panel-border/50 pt-3 space-y-3">
          <p className="text-xs text-panel-muted">
            <span className="font-medium text-panel-text">Google-Kalender:</span>{' '}
            Client-ID und Secret aus der Google Cloud Console eintragen, speichern,
            dann die Verbindung herstellen.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Feld label="Google Client-ID" value={settings.google_client_id}
              placeholder="…apps.googleusercontent.com" disabled={settings.google_client_id_per_env}
              onChange={v => set('google_client_id', v)} />
            <PwFeld label="Google Client-Secret" value={settings.google_client_secret}
              placeholder="" disabled={settings.google_client_secret_per_env}
              onChange={v => set('google_client_secret', v)} />
            <Feld label="Google-Kalender-ID" value={settings.google_kalender_id}
              placeholder="primary" disabled={settings.google_kalender_id_per_env}
              onChange={v => set('google_kalender_id', v)} />
          </div>
          <GoogleVerbindung />
        </div>

        <SpeichernZeile onSpeichern={() => speichern('aktionen')} meldung={meldung.aktionen} />
      </Sektion>

      {/* ── Spam-Prüfung ──────────────────────────────────────────────────────── */}
      <Sektion icon={Server} titel="Spam-Prüfung">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-panel-muted">
              Spam-Schwellwert (0–1)
            </label>
            <p className="text-[10px] text-panel-muted/60">
              Ab diesem Score wandert eine Mail in Quarantäne
            </p>
            <input
              type="number" min="0" max="1" step="0.05"
              value={settings.spam_schwellwert}
              onChange={e => set('spam_schwellwert', e.target.value)}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-panel-muted">DNSBL-Listen</label>
            <p className="text-[10px] text-panel-muted/60">Eine Adresse pro Zeile</p>
            <textarea
              rows={4}
              className="font-mono w-full"
              value={dnsblText}
              onChange={e => setDnsblText(e.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-6 flex-wrap">
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle
              on={settings.clamav_aktiv === '1'}
              onToggle={() => set('clamav_aktiv', settings.clamav_aktiv === '1' ? '0' : '1')}
            />
            <span className="text-sm">Virenscan (ClamAV) aktiv</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle
              on={settings.safebrowsing_aktiv === '1'}
              onToggle={() => set('safebrowsing_aktiv', settings.safebrowsing_aktiv === '1' ? '0' : '1')}
            />
            <span className="text-sm">Link-Check (Safe Browsing) aktiv</span>
          </label>
        </div>
        <SpeichernZeile onSpeichern={() => speichern('spam')} meldung={meldung.spam} />
      </Sektion>

      {/* ── Panel-Secret ─────────────────────────────────────────────────────── */}
      <Sektion icon={KeyRound} titel="Panel-Secret für die n8n-Workflows" standard={false}>
        <p className="text-xs text-panel-muted">
          Die Workflows rufen die Prüfdienste des Panels mit diesem Schlüssel auf.
          In n8n als Header-Auth-Credential anlegen: Name{' '}
          <code className="text-panel-text">X-Panel-Secret</code>, Wert:
        </p>
        <code className="block bg-panel-card border border-panel-border rounded-md p-2 text-xs font-mono break-all">
          {settings.panel_secret}
        </code>
      </Sektion>

      {/* ── Passkeys ──────────────────────────────────────────────────────────── */}
      <Sektion icon={ShieldCheck} titel="Passkeys (WebAuthn)" standard={false}>
        <p className="text-xs text-panel-muted">
          Ermöglichen passwortlosen Login per Fingerabdruck, Face ID, Hardware-Key oder Passwort-Manager.
        </p>
        {passkeys.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-panel-text">Registrierte Passkeys ({passkeys.length})</p>
            {passkeys.map(pk => (
              <div key={pk.id} className="flex items-center justify-between p-2 rounded border border-panel-border bg-panel-surface">
                <div>
                  <p className="text-sm font-medium">{pk.name || pk.device_type}</p>
                  <p className="text-xs text-panel-muted">
                    Hinzugefügt am {new Date(pk.created_at).toLocaleDateString('de-DE')}
                  </p>
                </div>
                <button
                  onClick={() => deletePasskey(pk.id)}
                  className="p-1.5 text-panel-red hover:bg-panel-red/10 rounded transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-1">
          <input
            type="text"
            placeholder="Name (z.B. YubiKey)"
            value={passkeyName}
            onChange={e => setPasskeyName(e.target.value)}
            className="flex-1 max-w-[200px]"
          />
          <button onClick={registerPasskey} disabled={pkLaedt} className="btn-primary !py-1.5">
            {pkLaedt ? '…' : '+ Passkey registrieren'}
          </button>
        </div>
        {pkMeldung && (
          <p className={`text-xs mt-1 ${pkMeldung.startsWith('Fehler') ? 'text-panel-red' : 'text-panel-accent'}`}>
            {pkMeldung}
          </p>
        )}
      </Sektion>

      {/* ── Verbindungstests ──────────────────────────────────────────────────── */}
      <Sektion icon={PlugZap} titel="Verbindungstests">
        <p className="text-xs text-panel-muted">
          Prüft die Erreichbarkeit der Dienste aus Sicht des Panel-Backends.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {DIENSTE.map(({ id, label }) => (
            <TestKarte key={id} id={id} label={label} onTest={testen} ergebnis={tests} />
          ))}
        </div>
      </Sektion>

      {/* ── Oberfläche ────────────────────────────────────────────────────────── */}
      <Sektion icon={null} titel="Oberfläche" standard={false}>
        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle on={showPrideFlag} onToggle={() => togglePrideFlag(!showPrideFlag)} />
          <span className="text-sm">Pride Flag im Menü anzeigen</span>
        </label>
      </Sektion>

    </div>
  );
}
