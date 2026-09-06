import { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, Loader2, PlugZap, ShieldCheck, Trash2,
  Eye, EyeOff, Save, KeyRound, Cpu, Mail, Cloud, Server,
  Link, Wifi, TestTube2, User, Settings2, FolderTree,
} from 'lucide-react';
import api from '../api';
import { useMelden } from '../components/ui/Meldungen';

// ─── Gemeinsame Styles ────────────────────────────────────────────────────────

const inputCls = 'w-full bg-panel-surface border border-panel-border rounded-md px-3 py-2 text-sm text-panel-text focus:outline-none focus:border-panel-accent transition-colors';

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

// ─── Karten-Komponente (wie im Überwachungs-Panel) ────────────────────────────

function Card({ title, children }) {
  return (
    <div className="bg-panel-card border border-panel-border rounded-lg overflow-hidden">
      {title && (
        <div className="px-4 py-2.5 border-b border-panel-border bg-panel-surface/50">
          <h2 className="text-xs font-semibold text-panel-text uppercase tracking-wide flex items-center gap-2">
            {title}
          </h2>
        </div>
      )}
      <div className="p-4 space-y-3">
        {children}
      </div>
    </div>
  );
}

// ─── Passwort-Feld mit Sichtbarkeits-Toggle ───────────────────────────────────

function PwFeld({ label, value, placeholder, disabled, onChange }) {
  const [sichtbar, setSichtbar] = useState(false);
  return (
    <div className="space-y-1">
      <label className="block text-xs text-panel-muted">{label}</label>
      <div className="relative">
        <input
          type={sichtbar ? 'text' : 'password'}
          value={value || ''}
          placeholder={disabled && !value ? '(über Umgebungsvariable gesetzt)' : (placeholder || '')}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className={inputCls + ' pr-8 disabled:opacity-60'}
        />
        {!disabled && (
          <button
            type="button"
            onClick={() => setSichtbar(s => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-panel-muted hover:text-panel-text transition-colors"
            tabIndex={-1}
          >
            {sichtbar ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Text-Feld ────────────────────────────────────────────────────────────────

function Feld({ label, value, placeholder, disabled, onChange, typ = 'text' }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-panel-muted">{label}</label>
      <input
        type={typ}
        value={value || ''}
        placeholder={disabled && !value ? '(über Umgebungsvariable gesetzt)' : (placeholder || '')}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={inputCls + ' disabled:opacity-60'}
      />
    </div>
  );
}

// ─── Status-Badge ─────────────────────────────────────────────────────────────

const StatusBadge = ({ gesetzt }) => gesetzt
  ? <span className="flex items-center gap-1 text-xs text-panel-accent"><CheckCircle2 size={12} />Konfiguriert</span>
  : <span className="flex items-center gap-1 text-xs text-panel-muted"><XCircle size={12} />Nicht gesetzt</span>;

// ─── Rückmeldungs-Zeile ───────────────────────────────────────────────────────

function Msg({ msg }) {
  if (!msg) return null;
  const ok = !msg.startsWith('Fehler');
  return <p className={`text-xs ${ok ? 'text-panel-accent' : 'text-panel-red'}`}>{msg}</p>;
}

// ─── Speichern-Button ─────────────────────────────────────────────────────────

function SpeichernBtn({ onSpeichern, meldung, laedt }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <button
        onClick={onSpeichern}
        disabled={laedt}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-panel-accent hover:bg-panel-accent/80 text-white text-xs rounded-md transition-colors disabled:opacity-50"
      >
        <Save size={12} />
        Speichern
      </button>
      <Msg msg={meldung} />
    </div>
  );
}

// ─── Verbindungstest-Karte ────────────────────────────────────────────────────

function TestZeile({ id, label, onTest, tests }) {
  const zustand = tests?.[id];
  const hinweis = tests?.[`${id}_hinweis`];
  return (
    <div className="flex items-center justify-between py-2 border-b border-panel-border/50 last:border-0">
      <div className="flex-1 min-w-0 pr-2">
        <span className="text-sm text-panel-text">{label}</span>
        {zustand === 'ok' && hinweis && (
          <p className="text-[10px] text-panel-accent mt-0.5">{hinweis}</p>
        )}
        {zustand && zustand !== 'laeuft' && zustand !== 'ok' && (
          <p className="text-[10px] text-panel-red font-mono mt-0.5 break-words">{zustand}</p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {zustand === 'laeuft' && <Loader2 size={14} className="animate-spin text-panel-muted" />}
        {zustand === 'ok'     && <CheckCircle2 size={14} className="text-panel-accent" />}
        {zustand && zustand !== 'laeuft' && zustand !== 'ok' && (
          <XCircle size={14} className="text-panel-red" />
        )}
        <button
          onClick={() => onTest(id)}
          className="flex items-center gap-1 px-2 py-0.5 text-xs border border-panel-border rounded hover:border-panel-accent hover:text-panel-accent text-panel-muted transition-colors"
        >
          <TestTube2 size={11} />
          Test
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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status.verbunden ? 'bg-panel-accent' : 'bg-panel-border'}`} />
          <StatusBadge gesetzt={status.verbunden} />
        </div>
        <div className="flex items-center gap-2">
          {status.verbunden ? (
            <button onClick={loesen} className="text-xs text-panel-red hover:underline">
              Verbindung lösen
            </button>
          ) : (
            <button
              onClick={verbinden}
              className="flex items-center gap-1 px-2 py-1 text-xs border border-panel-border rounded hover:border-panel-accent hover:text-panel-accent text-panel-muted transition-colors"
            >
              <Link size={11} />
              Verbinden
            </button>
          )}
          <button onClick={laden} className="text-xs text-panel-muted/60 hover:text-panel-muted transition-colors">
            Prüfen
          </button>
        </div>
      </div>
      <p className="text-[10px] text-panel-muted/60">
        Rücksprung-URI:{' '}
        <code className="text-panel-text break-all">{status.rueckkehrAdresse}</code>
      </p>
      {fehler && <p className="text-xs text-panel-red">{fehler}</p>}
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'verbindungen', icon: Wifi,     label: 'Verbindungen'   },
  { id: 'ki',          icon: Cpu,      label: 'KI & Prüfung'   },
  { id: 'dienste',     icon: Cloud,    label: 'Dienste'        },
  { id: 'konto',       icon: ShieldCheck, label: 'Konto'       },
];

const DIENSTE_TESTS = [
  { id: 'n8n',       label: 'n8n-API' },
  { id: 'mailcow',   label: 'Mailcow-API' },
  { id: 'gemini',    label: 'Gemini-API (KI-Klassifizierung)' },
  { id: 'google',    label: 'Google-Kalender (OAuth2)' },
  { id: 'clamav',    label: 'ClamAV (clamd)' },
  { id: 'unbound',   label: 'unbound (DNSBL-Resolver)' },
  { id: 'nextcloud', label: 'Nextcloud (WebDAV)' },
  { id: 'smtp',      label: 'Postausgang (SMTP)' },
];

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

export default function Einstellungen() {
  const { nachfragen } = useMelden();
  const [tab, setTab]         = useState('verbindungen');
  const [settings, setSettings] = useState(null);
  const [dnsblText, setDnsblText] = useState('');
  const [meldung, setMeldung] = useState({});
  const [tests, setTests]     = useState({});

  // Passkeys
  const [passkeys,    setPasskeys]    = useState([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [pkLaedt,     setPkLaedt]     = useState(false);
  const [pkMeldung,   setPkMeldung]   = useState('');

  // Oberfläche
  const [showPrideFlag, setShowPrideFlag] = useState(
    () => localStorage.getItem('show_pride_flag') !== 'false'
  );

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
      setTests(t => ({ ...t, [dienst]: 'ok', [`${dienst}_hinweis`]: data.hinweis || '' }));
    } catch (err) {
      setTests(t => ({ ...t, [dienst]: err.response?.data?.error || 'Verbindungsfehler' }));
    }
  };

  const registerPasskey = async () => {
    setPkMeldung(''); setPkLaedt(true);
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
      const msg = err.name === 'NotAllowedError' ? 'Dialog abgebrochen.' : err.response?.data?.error || err.message;
      setPkMeldung('Fehler: ' + msg);
    } finally { setPkLaedt(false); }
  };

  const deletePasskey = async (id) => {
    if (!(await nachfragen({
      titel: 'Passkey löschen?',
      text: 'Dieses Gerät meldet sich danach wieder mit Benutzername und Passwort an.',
      bestaetigen: 'Löschen', gefaehrlich: true,
    }))) return;
    try { await api.delete(`/passkeys/${id}`); await loadPasskeys(); setPkMeldung('Passkey gelöscht'); }
    catch { setPkMeldung('Fehler beim Löschen'); }
  };

  const togglePrideFlag = (val) => {
    setShowPrideFlag(val);
    localStorage.setItem('show_pride_flag', val);
    window.dispatchEvent(new Event('pride_flag_change'));
  };

  if (!settings) return <p className="text-panel-muted text-sm">Lade…</p>;

  return (
    <div className="space-y-4">

      {/* ── Tab-Bar ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 bg-panel-surface border border-panel-border rounded-lg p-1">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 min-w-[130px] flex items-center justify-center gap-1.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${
              tab === id
                ? 'bg-panel-card text-panel-text font-medium shadow-sm'
                : 'text-panel-muted hover:text-panel-text'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* ═══════════════════ TAB 1: VERBINDUNGEN ════════════════════════════ */}
      {tab === 'verbindungen' && (
        <div className="columns-1 lg:columns-2 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">

          <Card title={<><Wifi size={13} /> n8n &amp; Mailcow</>}>
            <p className="text-xs text-panel-muted">
              Den n8n-API-Key findest du in n8n unter <em>Einstellungen → n8n API</em>.
            </p>
            <Feld label="n8n-Adresse" value={settings.n8n_url} placeholder="http://n8n:5678"
              disabled={settings.n8n_url_per_env} onChange={v => set('n8n_url', v)} />
            <PwFeld label="n8n-API-Key" value={settings.n8n_api_key} placeholder="n8n_api_…"
              disabled={settings.n8n_api_key_per_env} onChange={v => set('n8n_api_key', v)} />
            <div className="pt-2 border-t border-panel-border/50 space-y-3">
              <p className="text-xs text-panel-muted">Mailcow ist optional — nur nötig, wenn du Mailcow-Funktionen nutzt.</p>
              <Feld label="Mailcow-Adresse" value={settings.mailcow_url} placeholder="https://mail.example.org"
                disabled={settings.mailcow_url_per_env} onChange={v => set('mailcow_url', v)} />
              <PwFeld label="Mailcow-API-Key" value={settings.mailcow_api_key} placeholder=""
                disabled={settings.mailcow_api_key_per_env} onChange={v => set('mailcow_api_key', v)} />
            </div>
            <SpeichernBtn onSpeichern={() => speichern('verbindungen')} meldung={meldung.verbindungen} />
          </Card>

          <Card title={<><PlugZap size={13} /> Verbindungstests</>}>
            <p className="text-xs text-panel-muted">
              Prüft die Erreichbarkeit der Dienste aus Sicht des Panel-Backends.
            </p>
            {DIENSTE_TESTS.map(({ id, label }) => (
              <TestZeile key={id} id={id} label={label} onTest={testen} tests={tests} />
            ))}
          </Card>

        </div>
      )}

      {/* ═══════════════════ TAB 2: KI & PRÜFUNG ═══════════════════════════ */}
      {tab === 'ki' && (
        <div className="columns-1 lg:columns-2 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">

          <Card title={<><Cpu size={13} /> KI-Klassifizierung (Gemini)</>}>
            <p className="text-xs text-panel-muted">
              Die Werte werden bei der Konto-Synchronisierung an die n8n-Workflows verteilt.
              Gemini Free Tier genügt.
            </p>
            <div className="pt-2">
              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle
                  on={settings.trockenlauf_aktiv === '1'}
                  onToggle={() => set('trockenlauf_aktiv', settings.trockenlauf_aktiv === '1' ? '0' : '1')}
                />
                <div className="flex flex-col">
                  <span className="text-sm text-panel-text">Trockenlauf aktivieren</span>
                  <span className="text-[10px] text-panel-muted/70">Mails werden von der KI klassifiziert und geloggt, aber nicht verschoben (perfekt zum Testen).</span>
                </div>
              </label>
            </div>
            <PwFeld label="Gemini API-Key" value={settings.gemini_api_key} placeholder="AIza…"
              disabled={settings.gemini_api_key_per_env} onChange={v => set('gemini_api_key', v)} />
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">KI-Einordnungen pro Tag</label>
              <p className="text-[10px] text-panel-muted/60">
                Schützt das Gemini-Tageslimit, wenn ein großer Altbestand aufgearbeitet wird.
                0 = kein Deckel. Sinnvoll ist der Wert nur <span className="text-panel-text">unter</span> dem,
                was Googles Gratis-Tarif am Tag zulässt: Steht er höher, bremst nicht mehr das
                Panel, sondern Google — und dann bricht der Lauf mitten im Stapel mit „too many
                requests" ab, statt sauber zu enden. Im Zweifel lieber zu niedrig.
              </p>
              <input type="number" min="0" step="10" value={settings.gemini_tagesbudget}
                disabled={settings.gemini_tagesbudget_per_env}
                onChange={e => set('gemini_tagesbudget', e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">Belege pro Tag auslesen</label>
              <p className="text-[10px] text-panel-muted/60">
                Eigener Topf fürs Lesen der PDF-Belege, damit es das Einordnungs-Budget nicht
                leersaugt. 0 = kein Deckel.
              </p>
              <input type="number" min="0" step="10" value={settings.beleg_lese_tagesbudget}
                disabled={settings.beleg_lese_tagesbudget_per_env}
                onChange={e => set('beleg_lese_tagesbudget', e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">Bestands-Triage alle … Stunden</label>
              <p className="text-[10px] text-panel-muted/60">
                Arbeitet den Altbestand im Hintergrund ab. 0 = nur manuell. Nach dem Ändern einmal
                auf Workflows → Synchronisieren drücken.
              </p>
              <input type="number" min="0" max="168" step="1" value={settings.bestand_intervall}
                disabled={settings.bestand_intervall_per_env}
                onChange={e => set('bestand_intervall', e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">Ersatz-Modell bei vollem Kontingent</label>
              <p className="text-[10px] text-panel-muted/60">
                Googles Kontingente gelten <span className="text-panel-text">je Modell</span>: Ist das
                Tageslimit des ersten erreicht, hat ein anderes noch sein eigenes. Trägst du hier eines
                ein, schaltet das Panel bei einer Abweisung automatisch um und am nächsten Tag zurück.
                Leer = aus. Bewusst nicht vorbelegt: Das Ersatzmodell ist meist das größere, und mit
                aktivierter Abrechnung kostet jede Anfrage dort mehr.
              </p>
              <input type="text" placeholder="z. B. gemini-3.5-flash — leer lassen = aus"
                value={settings.gemini_modell_ersatz ?? ''}
                disabled={settings.gemini_modell_ersatz_per_env}
                onChange={e => set('gemini_modell_ersatz', e.target.value)} className={inputCls} />
              <p className="text-[10px] text-panel-muted/60">
                Erstes Modell: <span className="font-mono">{settings.gemini_modell || 'gemini-3.5-flash-lite'}</span>.
                Ein Wechsel wirkt sofort — das Panel trägt ihn selbst in die Workflows ein.
              </p>
            </div>

            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">Pause zwischen KI-Anfragen (ms)</label>
              <p className="text-[10px] text-panel-muted/60">
                Der Gratis-Tarif begrenzt auch die Anfragen pro Minute — und Inbox- und
                Bestands-Triage teilen sich dieses Limit. 6000 = 10 Anfragen pro Minute. Ist die
                Pause zu kurz, bricht ein großer Lauf mit „too many requests“ ab.
                Wirkt nach Workflows → Synchronisieren.
              </p>
              <input type="number" min="1000" max="60000" step="500" value={settings.gemini_pause_ms}
                onChange={e => set('gemini_pause_ms', e.target.value)} className={inputCls} />
            </div>
            <SpeichernBtn onSpeichern={() => speichern('ki')} meldung={meldung.ki} />
          </Card>

          <Card title={<><Mail size={13} /> Telegram-Benachrichtigungen</>}>
            <PwFeld label="Bot-Token" value={settings.telegram_token} placeholder="123456:ABC-DEF…"
              disabled={settings.telegram_token_per_env} onChange={v => set('telegram_token', v)} />
            <Feld label="Chat-ID" value={settings.telegram_chat_id} placeholder="123456789"
              disabled={settings.telegram_chat_id_per_env} onChange={v => set('telegram_chat_id', v)} />
            <SpeichernBtn onSpeichern={() => speichern('telegram')} meldung={meldung.telegram} />
          </Card>

          <Card title={<><Server size={13} /> Spam-Prüfung</>}>
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">Spam-Schwellwert (0–1)</label>
              <p className="text-[10px] text-panel-muted/60">Ab diesem Score wandert eine Mail in Quarantäne</p>
              <input type="number" min="0" max="1" step="0.05"
                value={settings.spam_schwellwert}
                onChange={e => set('spam_schwellwert', e.target.value)}
                className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-panel-muted">DNSBL-Listen (eine pro Zeile)</label>
              <textarea rows={4} className="w-full font-mono bg-panel-surface border border-panel-border rounded-md px-3 py-2 text-sm text-panel-text focus:outline-none focus:border-panel-accent resize-none"
                value={dnsblText} onChange={e => setDnsblText(e.target.value)} />
            </div>
            <div className="space-y-2.5">
              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle
                  on={settings.clamav_aktiv === '1'}
                  onToggle={() => set('clamav_aktiv', settings.clamav_aktiv === '1' ? '0' : '1')}
                />
                <span className="text-sm text-panel-text">Virenscan (ClamAV) aktiv</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle
                  on={settings.safebrowsing_aktiv === '1'}
                  onToggle={() => set('safebrowsing_aktiv', settings.safebrowsing_aktiv === '1' ? '0' : '1')}
                />
                <div>
                  <span className="text-sm text-panel-text">Link-Check (Safe Browsing) aktiv</span>
                </div>
              </label>
            </div>
            {settings.safebrowsing_aktiv === '1' && (
              <PwFeld label="Google Safe Browsing API-Key" value={settings.safebrowsing_api_key}
                placeholder="" disabled={settings.safebrowsing_api_key_per_env}
                onChange={v => set('safebrowsing_api_key', v)} />
            )}
            <SpeichernBtn onSpeichern={() => speichern('spam')} meldung={meldung.spam} />
          </Card>

          <Card title={<><FolderTree size={13} /> Automatische Themen-Sortierung</>}>
            <p className="text-xs text-panel-muted">
              Die KI ordnet jede Mail zusätzlich einem Themen-Ordner zu — „alles rund um Games
              in den Games-Ordner“. Welche Ordner sie dabei kennt, steht auf der Seite
              <span className="text-panel-text"> Sortierung → Themen-Ordner</span>.
              Nach jeder Änderung hier einmal <span className="text-panel-text">Workflows →
              Synchronisieren</span> drücken.
            </p>

            <label className="flex items-center gap-3 cursor-pointer pt-1">
              <Toggle
                on={settings.themen_sortierung_aktiv === '1'}
                onToggle={() => set('themen_sortierung_aktiv', settings.themen_sortierung_aktiv === '1' ? '0' : '1')}
              />
              <div className="flex flex-col">
                <span className="text-sm text-panel-text">Themen-Sortierung aktivieren</span>
                <span className="text-[10px] text-panel-muted/70">
                  Ein erkanntes Thema schlägt die festen Kategorien — ein Games-Newsletter landet
                  in Games, nicht in Newsletter. Spam und Viren gehen weiterhin immer in die Quarantäne.
                </span>
              </div>
            </label>

            {settings.themen_sortierung_aktiv === '1' && (
              <>
                <div className="space-y-1">
                  <label className="block text-xs text-panel-muted">Neue Ordner anlegen</label>
                  <select
                    value={settings.themen_ordner_anlegen || 'freigabe'}
                    onChange={e => set('themen_ordner_anlegen', e.target.value)}
                    className={inputCls}
                  >
                    <option value="aus">Nicht anlegen — nur vorhandene Ordner benutzen</option>
                    <option value="freigabe">Erst freigeben — die KI schlägt vor, du bestätigst</option>
                    <option value="auto">Vollautomatisch — die KI legt selbst an</option>
                  </select>
                  <p className="text-[10px] text-panel-muted/60">
                    Vorschläge und Freigabe findest du unter <span className="text-panel-muted">Sortierung</span>.
                    Im Trockenlauf wird nie ein Ordner angelegt.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="block text-xs text-panel-muted">Höchstens KI-Ordner</label>
                    <input type="number" min="1" max="200" step="1"
                      value={settings.themen_ordner_max ?? '25'}
                      onChange={e => set('themen_ordner_max', e.target.value)}
                      className={inputCls} />
                    <p className="text-[10px] text-panel-muted/60">je Konto</p>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-panel-muted">Sicherheit für neuen Ordner</label>
                    <input type="number" min="0" max="1" step="0.05"
                      value={settings.themen_konfidenz ?? '0.7'}
                      onChange={e => set('themen_konfidenz', e.target.value)}
                      className={inputCls} />
                    <p className="text-[10px] text-panel-muted/60">
                      darunter wird kein Ordner angelegt und nichts vorgeschlagen
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs text-panel-muted">Sicherheit für vorhandenen Ordner</label>
                  <input type="number" min="0" max="1" step="0.05"
                    value={settings.themen_konfidenz_vorhanden ?? '0.45'}
                    onChange={e => set('themen_konfidenz_vorhanden', e.target.value)}
                    className={inputCls} />
                  <p className="text-[10px] text-panel-muted/60">
                    Bewusst niedriger: Einen vorhandenen Ordner zu treffen ist mit einem Klick
                    korrigiert, ein neuer Ordner bleibt im Postfach stehen. Steht beides gleich
                    hoch, ist das Aufräumen genauso schwer wie das Zumüllen — und die KI schlägt
                    lieber einen neuen Ordner vor, als einen passenden zu nehmen.
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs text-panel-muted">Sammelordner (optional)</label>
                  <input type="text" placeholder="leer = direkt im Postfach"
                    value={settings.themen_eltern ?? ''}
                    onChange={e => set('themen_eltern', e.target.value)}
                    className={inputCls} />
                  <p className="text-[10px] text-panel-muted/60">
                    Leer lassen ergibt „Games“. Trägst du z.&nbsp;B. <span className="text-panel-muted">Themen</span>
                    {' '}ein, entsteht stattdessen „Themen/Games“ und dein Postfach bleibt aufgeräumt.
                  </p>
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Toggle
                    on={settings.themen_regel_lernen !== '0'}
                    onToggle={() => set('themen_regel_lernen', settings.themen_regel_lernen === '0' ? '1' : '0')}
                  />
                  <div className="flex flex-col">
                    <span className="text-sm text-panel-text">Regeln lernen</span>
                    <span className="text-[10px] text-panel-muted/70">
                      Landen drei Mails desselben Absenders im selben Ordner, entsteht daraus eine
                      feste Regel. Der Absender läuft danach ohne KI durch — das schont das
                      Gemini-Kontingent.
                    </span>
                  </div>
                </label>
              </>
            )}
            <SpeichernBtn onSpeichern={() => speichern('themen')} meldung={meldung.themen} />
          </Card>

        </div>
      )}

      {/* ═══════════════════ TAB 3: DIENSTE ════════════════════════════════ */}
      {tab === 'dienste' && (
        <div className="columns-1 lg:columns-2 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">

          <Card title={<><Mail size={13} /> Postausgang (SMTP)</>}>
            <p className="text-xs text-panel-muted">
              Nur für das Abbestellen von Newslettern per Mail. Ohne Angaben bleibt
              der Versand-Knoten in Workflow 06 stillgelegt.
            </p>
            <Feld label="SMTP-Server" value={settings.smtp_host} placeholder="mail.example.org"
              disabled={settings.smtp_host_per_env} onChange={v => set('smtp_host', v)} />
            <div className="grid grid-cols-2 gap-2">
              <Feld label="Port" value={settings.smtp_port} placeholder="587" typ="number"
                disabled={settings.smtp_port_per_env} onChange={v => set('smtp_port', v)} />
              <Feld label="Benutzername" value={settings.smtp_user} placeholder="panel@example.org"
                disabled={settings.smtp_user_per_env} onChange={v => set('smtp_user', v)} />
            </div>
            <PwFeld label="Passwort" value={settings.smtp_passwort} placeholder=""
              disabled={settings.smtp_passwort_per_env} onChange={v => set('smtp_passwort', v)} />
            <Feld label="Absenderadresse" value={settings.smtp_absender} placeholder="panel@example.org"
              disabled={settings.smtp_absender_per_env} onChange={v => set('smtp_absender', v)} />
            <label className="flex items-center gap-3 cursor-pointer pt-1">
              <Toggle
                on={settings.smtp_tls_unsicher === '1'}
                onToggle={() => set('smtp_tls_unsicher', settings.smtp_tls_unsicher === '1' ? '0' : '1')}
              />
              <div>
                <span className="text-sm text-panel-text">Selbstsigniertes Zertifikat akzeptieren</span>
                <p className="text-[10px] text-panel-muted/60">Nur für eigene Mailserver ohne offizielles Zertifikat</p>
              </div>
            </label>
            <SpeichernBtn onSpeichern={() => speichern('smtp')} meldung={meldung.smtp} />
          </Card>

          <Card title={<><Cloud size={13} /> Nextcloud</>}>
            <p className="text-xs text-panel-muted">
              Für eigene Aktionen — ein App-Passwort verwenden (Nextcloud → Einstellungen → Sicherheit).
            </p>
            <Feld label="Nextcloud-Adresse" value={settings.nextcloud_url} placeholder="https://cloud.example.org"
              disabled={settings.nextcloud_url_per_env} onChange={v => set('nextcloud_url', v)} />
            <Feld label="Benutzername" value={settings.nextcloud_user} placeholder="robin"
              disabled={settings.nextcloud_user_per_env} onChange={v => set('nextcloud_user', v)} />
            <PwFeld label="App-Passwort" value={settings.nextcloud_passwort} placeholder=""
              disabled={settings.nextcloud_passwort_per_env} onChange={v => set('nextcloud_passwort', v)} />
            <Feld label="Kalender (Name in der Adresse)" value={settings.nextcloud_kalender} placeholder="personal"
              disabled={settings.nextcloud_kalender_per_env} onChange={v => set('nextcloud_kalender', v)} />
            <SpeichernBtn onSpeichern={() => speichern('nextcloud')} meldung={meldung.nextcloud} />
          </Card>

          <Card title={<><Cloud size={13} /> Google-Kalender</>}>
            <p className="text-xs text-panel-muted">
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-panel-accent hover:underline">Google Cloud Console</a> öffnen, Projekt anlegen, <em>Google Calendar API</em> aktivieren.
              OAuth-Client (Typ Webanwendung) erstellen und die unten angezeigte Rücksprung-URI eintragen.
            </p>
            <Feld label="Client-ID" value={settings.google_client_id} placeholder="…apps.googleusercontent.com"
              disabled={settings.google_client_id_per_env} onChange={v => set('google_client_id', v)} />
            <PwFeld label="Client-Secret" value={settings.google_client_secret} placeholder=""
              disabled={settings.google_client_secret_per_env} onChange={v => set('google_client_secret', v)} />
            <Feld label="Kalender-ID" value={settings.google_kalender_id} placeholder="primary"
              disabled={settings.google_kalender_id_per_env} onChange={v => set('google_kalender_id', v)} />
            <div className="pt-2 border-t border-panel-border/50">
              <p className="text-xs text-panel-muted mb-2">Google-Verbindung</p>
              <GoogleVerbindung />
            </div>
            <SpeichernBtn onSpeichern={() => speichern('google')} meldung={meldung.google} />
          </Card>

        </div>
      )}

      {/* ═══════════════════ TAB 4: KONTO ═══════════════════════════════════ */}
      {tab === 'konto' && (
        <div className="columns-1 lg:columns-2 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">

          <Card title={<><KeyRound size={13} /> Panel-Secret</>}>
            <p className="text-xs text-panel-muted">
              Die Workflows rufen die Prüfdienste des Panels mit diesem Schlüssel auf.
              In n8n als Header-Auth-Credential anlegen: Name{' '}
              <code className="text-panel-text">X-Panel-Secret</code>, Wert:
            </p>
            <code className="block bg-panel-surface border border-panel-border rounded-md p-2 text-xs font-mono break-all text-panel-text">
              {settings.panel_secret}
            </code>
          </Card>

          <Card title={<><ShieldCheck size={13} /> Passkeys (WebAuthn)</>}>
            <p className="text-xs text-panel-muted">
              Passwortloser Login per Fingerabdruck, Face ID, Hardware-Key oder Passwort-Manager.
            </p>
            {passkeys.length > 0 && (
              <div className="space-y-2">
                {passkeys.map(pk => (
                  <div key={pk.id} className="flex items-center justify-between p-2 rounded border border-panel-border bg-panel-surface">
                    <div>
                      <p className="text-sm font-medium text-panel-text">{pk.name || pk.device_type}</p>
                      <p className="text-xs text-panel-muted">
                        Hinzugefügt {new Date(pk.created_at).toLocaleDateString('de-DE')}
                      </p>
                    </div>
                    <button onClick={() => deletePasskey(pk.id)}
                      className="p-1.5 text-panel-red hover:bg-panel-red/10 rounded transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <input type="text" placeholder="Name (z.B. YubiKey)" value={passkeyName}
                onChange={e => setPasskeyName(e.target.value)}
                className={inputCls + ' flex-1'} />
              <button onClick={registerPasskey} disabled={pkLaedt}
                className="px-3 py-1.5 bg-panel-accent hover:bg-panel-accent/80 text-white text-xs rounded-md transition-colors disabled:opacity-50">
                {pkLaedt ? '…' : '+ Registrieren'}
              </button>
            </div>
            {pkMeldung && (
              <p className={`text-xs ${pkMeldung.startsWith('Fehler') ? 'text-panel-red' : 'text-panel-accent'}`}>
                {pkMeldung}
              </p>
            )}
          </Card>

          <Card title={<><Settings2 size={13} /> Oberfläche</>}>
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle on={showPrideFlag} onToggle={() => togglePrideFlag(!showPrideFlag)} />
              <span className="text-sm text-panel-text">Pride Flag im Menü anzeigen</span>
            </label>
          </Card>

        </div>
      )}
    </div>
  );
}
