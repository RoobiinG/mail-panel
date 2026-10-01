import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Mail, MessageCircle, ShieldCheck, Smartphone } from 'lucide-react';
import api from '../api';
import Karte from '../components/ui/Karte';
import { useMelden } from '../components/ui/Meldungen';

// Die eigene Zwei-Faktor-Anmeldung. Jeder angemeldete Benutzer kann das für sich
// einrichten — dafür braucht es kein besonderes Recht, und niemand kann hier die
// 2FA eines anderen ändern. (Wer sein Gerät verliert, wendet sich an einen Admin:
// Benutzer & Rollen → „2FA zurücksetzen".)
//
// Drei Methoden, beliebig kombinierbar; beim Login sucht man sich eine aus:
//   Authenticator-App   Code aus einer App (Aegis, Google Authenticator, Bitwarden …)
//   E-Mail              Code per Mail über den Postausgang des Panels
//   Discord             Code als Direktnachricht über einen Bot
//
// Eine Methode ist erst aktiv, wenn sie mit einem echten Code bestätigt wurde — so
// sperrt ein Tippfehler in der Adresse niemanden aus. Einrichten und Abschalten
// verlangen das Passwort noch einmal.

const fehlerText = (err, fallback) => err.response?.data?.error || fallback;

// Hält Laden und Fehler einer Aktion zusammen, damit jede Karte nicht dasselbe
// dreimal schreibt.
function useAktion() {
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState('');
  const ausfuehren = async (fn, fallback = 'Das hat nicht geklappt.') => {
    setLaedt(true);
    setFehler('');
    try {
      return await fn();
    } catch (err) {
      setFehler(fehlerText(err, fallback));
      return undefined;
    } finally {
      setLaedt(false);
    }
  };
  return { laedt, fehler, setFehler, ausfuehren };
}

function PasswortFeld({ wert, onChange, autoFocus }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-panel-muted">Dein Passwort (zur Bestätigung)</span>
      <input
        type="password" value={wert} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="current-password" className="w-full"
      />
    </label>
  );
}

function CodeFeld({ wert, onChange, label = 'Code' }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-panel-muted">{label}</span>
      <input
        value={wert} onChange={(e) => onChange(e.target.value)}
        inputMode="numeric" autoComplete="one-time-code" maxLength={7} pattern="[0-9 ]*"
        placeholder="123456" className="w-full tracking-[0.3em] tabular-nums"
      />
    </label>
  );
}

const Fehler = ({ text }) => (text ? <p className="text-xs text-panel-red" role="alert">{text}</p> : null);

const Aktiv = ({ ziel }) => (
  <span className="flex items-center gap-1.5 text-xs text-panel-accent">
    <CheckCircle2 size={13} /> Aktiv{ziel ? ` · ${ziel}` : ''}
  </span>
);

// ─── Abschalten (für jede Methode gleich) ────────────────────────────────────

function Abschalten({ methode, neuLaden }) {
  const { melden, nachfragen } = useMelden();
  const { laedt, fehler, ausfuehren } = useAktion();
  const [offen, setOffen] = useState(false);
  const [passwort, setPasswort] = useState('');

  const abschalten = async (e) => {
    e.preventDefault();
    if (!(await nachfragen({
      titel: 'Methode abschalten?',
      text: 'Danach reicht für diese Methode beim Login kein Code mehr. Hast du keine andere eingerichtet, genügt wieder das Passwort allein.',
      bestaetigen: 'Abschalten', gefaehrlich: true,
    }))) return;
    const ok = await ausfuehren(async () => {
      await api.post(`/zweifaktor/${methode}/deaktivieren`, { passwort });
      return true;
    });
    if (ok) { setOffen(false); setPasswort(''); melden('Methode abgeschaltet.'); neuLaden(); }
  };

  if (!offen) {
    return <button type="button" onClick={() => setOffen(true)} className="btn-ghost text-panel-red">Abschalten</button>;
  }
  return (
    <form onSubmit={abschalten} className="space-y-2 pt-1">
      <PasswortFeld wert={passwort} onChange={setPasswort} autoFocus />
      <Fehler text={fehler} />
      <div className="flex gap-2">
        <button type="button" onClick={() => { setOffen(false); setPasswort(''); }} className="btn-ghost">Abbrechen</button>
        <button type="submit" disabled={laedt || !passwort} className="btn !bg-panel-red hover:!bg-red-700">
          {laedt ? 'Bitte warten…' : 'Abschalten'}
        </button>
      </div>
    </form>
  );
}

// ─── Authenticator-App ───────────────────────────────────────────────────────

function TotpKarte({ stand, neuLaden }) {
  const { melden } = useMelden();
  const { laedt, fehler, setFehler, ausfuehren } = useAktion();
  const [schritt, setSchritt] = useState('ruhe'); // ruhe | passwort | code
  const [passwort, setPasswort] = useState('');
  const [daten, setDaten] = useState(null);       // { geheimnis, uri }
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');

  // Der QR-Code entsteht im Browser, aus der Adresse, die das Backend liefert. Das
  // Geheimnis verlässt die Seite nicht — es geht an keinen Fremddienst.
  useEffect(() => {
    if (!daten?.uri) { setQr(''); return undefined; }
    let abgebrochen = false;
    import('qrcode')
      .then((m) => (m.default || m).toDataURL(daten.uri, { margin: 1, width: 200 }))
      .then((url) => { if (!abgebrochen) setQr(url); })
      .catch(() => { if (!abgebrochen) setQr(''); }); // ohne QR bleibt das Geheimnis zum Abtippen
    return () => { abgebrochen = true; };
  }, [daten]);

  const zuruecksetzen = () => { setSchritt('ruhe'); setPasswort(''); setDaten(null); setCode(''); setFehler(''); };

  const starten = async (e) => {
    e.preventDefault();
    const r = await ausfuehren(() => api.post('/zweifaktor/totp/start', { passwort }), 'Die Einrichtung konnte nicht gestartet werden.');
    if (r) { setDaten(r.data); setPasswort(''); setSchritt('code'); }
  };

  const bestaetigen = async (e) => {
    e.preventDefault();
    const r = await ausfuehren(() => api.post('/zweifaktor/totp/bestaetigen', { code }), 'Der Code stimmt nicht.');
    if (r) { melden('Authenticator-App eingerichtet.'); zuruecksetzen(); neuLaden(); }
  };

  return (
    <Karte title={<><Smartphone size={13} /> Authenticator-App</>} aktion={stand.aktiv ? <Aktiv /> : null}>
      <p className="text-xs text-panel-muted">
        Ein Code aus einer App auf deinem Handy (z. B. Aegis, Google Authenticator oder Bitwarden).
        Er wechselt alle 30 Sekunden und funktioniert ohne Netz.
      </p>

      {stand.aktiv && <Abschalten methode="totp" neuLaden={neuLaden} />}

      {!stand.aktiv && schritt === 'ruhe' && (
        <button type="button" onClick={() => setSchritt('passwort')} className="btn">Einrichten</button>
      )}

      {!stand.aktiv && schritt === 'passwort' && (
        <form onSubmit={starten} className="space-y-2">
          <PasswortFeld wert={passwort} onChange={setPasswort} autoFocus />
          <Fehler text={fehler} />
          <div className="flex gap-2">
            <button type="button" onClick={zuruecksetzen} className="btn-ghost">Abbrechen</button>
            <button type="submit" disabled={laedt || !passwort} className="btn">{laedt ? 'Bitte warten…' : 'Weiter'}</button>
          </div>
        </form>
      )}

      {!stand.aktiv && schritt === 'code' && daten && (
        <form onSubmit={bestaetigen} className="space-y-3">
          <ol className="text-xs text-panel-muted list-decimal pl-4 space-y-1">
            <li>Öffne deine Authenticator-App und füge ein neues Konto hinzu.</li>
            <li>Scanne den QR-Code — oder tippe den Schlüssel unten von Hand ein.</li>
            <li>Gib den Code ein, den die App jetzt anzeigt.</li>
          </ol>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {qr
              ? <img src={qr} alt="QR-Code zum Einrichten der Authenticator-App" width="200" height="200" className="rounded bg-white p-1" />
              : <div className="w-[200px] h-[200px] rounded bg-panel-bg border border-panel-border flex items-center justify-center text-xs text-panel-muted text-center p-3">QR-Code wird erzeugt …</div>}
            <div className="space-y-1 min-w-0">
              <span className="block text-xs text-panel-muted">Schlüssel zum Abtippen</span>
              <code className="block text-sm break-all select-all bg-panel-bg border border-panel-border rounded px-2 py-1.5">
                {daten.geheimnis.match(/.{1,4}/g).join(' ')}
              </code>
              <p className="text-[10px] text-panel-muted/70">Zeitbasiert, 6 Stellen, SHA-1 — das sind die Standardwerte jeder App.</p>
            </div>
          </div>
          <CodeFeld wert={code} onChange={setCode} label="Code aus der App" />
          <Fehler text={fehler} />
          <div className="flex gap-2">
            <button type="button" onClick={zuruecksetzen} className="btn-ghost">Abbrechen</button>
            <button type="submit" disabled={laedt || code.replace(/\s/g, '').length !== 6} className="btn">
              {laedt ? 'Bitte warten…' : 'Bestätigen und aktivieren'}
            </button>
          </div>
        </form>
      )}
    </Karte>
  );
}

// ─── E-Mail und Discord: beide schicken einen Code ───────────────────────────
//
// Gleicher Ablauf, anderes Ziel: Passwort + Ziel → Code wird zugestellt → Code
// bestätigen. `felder` beschreibt die Eingaben vor dem Senden.

function CodeMethodeKarte({ id, titel, Icon, text, felder, stand, neuLaden, voraussetzung }) {
  const { melden } = useMelden();
  const { laedt, fehler, setFehler, ausfuehren } = useAktion();
  const [schritt, setSchritt] = useState('ruhe'); // ruhe | formular | code
  const [passwort, setPasswort] = useState('');
  const [werte, setWerte] = useState({});
  const [code, setCode] = useState('');

  const zuruecksetzen = () => { setSchritt('ruhe'); setPasswort(''); setWerte({}); setCode(''); setFehler(''); };

  const senden = async (e) => {
    e.preventDefault();
    const r = await ausfuehren(
      () => api.post(`/zweifaktor/${id}/start`, { passwort, ...werte }),
      'Der Code konnte nicht gesendet werden.',
    );
    if (r) { setPasswort(''); setSchritt('code'); }
  };

  const bestaetigen = async (e) => {
    e.preventDefault();
    const r = await ausfuehren(() => api.post(`/zweifaktor/${id}/bestaetigen`, { code }), 'Der Code stimmt nicht.');
    if (r) { melden(`${titel} eingerichtet.`); zuruecksetzen(); neuLaden(); }
  };

  const fehltVoraussetzung = voraussetzung && !voraussetzung.ok;

  return (
    <Karte title={<><Icon size={13} /> {titel}</>} aktion={stand.aktiv ? <Aktiv ziel={stand.ziel} /> : null}>
      <p className="text-xs text-panel-muted">{text}</p>

      {stand.aktiv && <Abschalten methode={id} neuLaden={neuLaden} />}

      {!stand.aktiv && schritt === 'ruhe' && (
        <>
          {fehltVoraussetzung && <p className="text-xs text-yellow-500">{voraussetzung.hinweis}</p>}
          <button type="button" onClick={() => setSchritt('formular')} className="btn">Einrichten</button>
        </>
      )}

      {!stand.aktiv && schritt === 'formular' && (
        <form onSubmit={senden} className="space-y-2">
          {fehltVoraussetzung && <p className="text-xs text-yellow-500">{voraussetzung.hinweis}</p>}
          {felder.map((f) => (
            <label key={f.name} className="block space-y-1">
              <span className="block text-xs text-panel-muted">{f.label}</span>
              <input
                type={f.typ || 'text'} value={werte[f.name] || ''} placeholder={f.platzhalter}
                onChange={(e) => setWerte((w) => ({ ...w, [f.name]: e.target.value }))}
                autoComplete={f.autoComplete || 'off'} className="w-full"
              />
              {f.hilfe && <span className="block text-[10px] text-panel-muted/70">{f.hilfe}</span>}
            </label>
          ))}
          <PasswortFeld wert={passwort} onChange={setPasswort} />
          <Fehler text={fehler} />
          <div className="flex gap-2">
            <button type="button" onClick={zuruecksetzen} className="btn-ghost">Abbrechen</button>
            <button
              type="submit"
              disabled={laedt || !passwort || felder.some((f) => f.pflicht && !String(werte[f.name] || '').trim())}
              className="btn"
            >
              {laedt ? 'Wird gesendet…' : 'Code senden'}
            </button>
          </div>
        </form>
      )}

      {!stand.aktiv && schritt === 'code' && (
        <form onSubmit={bestaetigen} className="space-y-2">
          <p className="text-xs text-panel-muted">
            Wir haben dir einen Code geschickt. Gib ihn ein — erst dann wird die Methode aktiv.
          </p>
          <CodeFeld wert={code} onChange={setCode} />
          <Fehler text={fehler} />
          <div className="flex gap-2">
            <button type="button" onClick={zuruecksetzen} className="btn-ghost">Abbrechen</button>
            <button type="submit" disabled={laedt || code.replace(/\s/g, '').length !== 6} className="btn">
              {laedt ? 'Bitte warten…' : 'Bestätigen und aktivieren'}
            </button>
          </div>
        </form>
      )}
    </Karte>
  );
}

// ─── Seite ───────────────────────────────────────────────────────────────────

const NAMEN = { totp: 'Authenticator-App', email: 'E-Mail', discord: 'Discord' };

export default function Sicherheit() {
  const { melden } = useMelden();
  const [stand, setStand] = useState(null);
  const [fehler, setFehler] = useState('');

  const laden = useCallback(async () => {
    try {
      setStand((await api.get('/zweifaktor')).data);
      setFehler('');
    } catch (err) {
      setFehler(fehlerText(err, 'Der Stand ließ sich nicht laden.'));
    }
  }, []);

  useEffect(() => { laden(); }, [laden]);

  const bevorzugtSetzen = async (methode) => {
    try {
      setStand((await api.put('/zweifaktor/bevorzugt', { methode })).data);
      melden(`Beim Login ist jetzt „${NAMEN[methode]}" vorgewählt.`);
    } catch (err) {
      melden(fehlerText(err, 'Das hat nicht geklappt.'), 'fehler');
    }
  };

  if (fehler) return <div className="card text-panel-red border border-panel-red/20">{fehler}</div>;
  if (!stand) return <p className="text-sm text-panel-muted">Lade …</p>;

  const aktive = Object.entries(stand.methoden).filter(([, m]) => m.aktiv).map(([id]) => id);

  return (
    <div className="space-y-4 max-w-3xl">
      <Karte title={<><ShieldCheck size={13} /> Zwei-Faktor-Anmeldung</>}
        aktion={<span className={`text-xs ${aktive.length ? 'text-panel-accent' : 'text-panel-muted'}`}>
          {aktive.length ? `${aktive.length} Methode${aktive.length > 1 ? 'n' : ''} aktiv` : 'Nicht eingerichtet'}
        </span>}>
        <p className="text-sm text-panel-muted">
          Freiwillig, aber stark: Mit einer eingerichteten Methode reicht dein Passwort allein nicht mehr — beim Login
          kommt ein Code dazu. Du kannst alle drei Methoden einrichten und dir bei jeder Anmeldung eine aussuchen.
        </p>
        <p className="text-xs text-panel-muted/80">
          Die Anmeldung per Passkey bleibt ohne zusätzlichen Code: Ein Passkey ist selbst schon Besitz (dein Gerät) und
          Entsperrung (PIN oder Fingerabdruck) in einem.
        </p>

        {aktive.length > 1 && (
          <label className="block space-y-1 pt-1">
            <span className="block text-xs text-panel-muted">Beim Login vorgewählt</span>
            <select value={stand.bevorzugt || ''} onChange={(e) => bevorzugtSetzen(e.target.value)} className="w-full sm:w-72">
              {aktive.map((id) => <option key={id} value={id}>{NAMEN[id]}</option>)}
            </select>
          </label>
        )}
      </Karte>

      <TotpKarte stand={stand.methoden.totp} neuLaden={laden} />

      <CodeMethodeKarte
        id="email" titel="E-Mail" Icon={Mail} stand={stand.methoden.email} neuLaden={laden}
        text="Ein Code per Mail, über den Postausgang des Panels. Praktisch, wenn kein Handy zur Hand ist — aber nur so sicher wie dein Postfach."
        voraussetzung={{
          ok: stand.smtp_bereit,
          hinweis: 'Der Postausgang ist noch nicht eingerichtet (Einstellungen → Dienste → Postausgang). Ohne ihn lässt sich kein Code senden.',
        }}
        felder={[{
          name: 'adresse', label: 'E-Mail-Adresse für die Codes', typ: 'email', platzhalter: 'du@example.org',
          autoComplete: 'email', pflicht: true,
        }]}
      />

      <CodeMethodeKarte
        id="discord" titel="Discord" Icon={MessageCircle} stand={stand.methoden.discord} neuLaden={laden}
        text="Ein Code als Direktnachricht von einem Discord-Bot. Der Bot muss mit dir einen Server teilen, und Direktnachrichten von Servermitgliedern müssen erlaubt sein."
        voraussetzung={{
          ok: stand.discord_global_bereit,
          hinweis: 'Ein Admin hat keinen Panel-Bot hinterlegt (Einstellungen → Dienste → Discord-Bot). Trage unten stattdessen einen eigenen Bot-Token ein.',
        }}
        felder={[
          {
            name: 'user_id', label: 'Deine Discord-Benutzer-ID', platzhalter: '123456789012345678', pflicht: true,
            hilfe: 'In Discord: Einstellungen → Erweitert → Entwicklermodus einschalten, dann Rechtsklick auf dich selbst → „Benutzer-ID kopieren".',
          },
          {
            name: 'bot_token', label: 'Eigener Bot-Token (optional)', typ: 'password', platzhalter: 'leer lassen für den Bot des Panels',
            hilfe: 'Nur nötig, wenn du einen eigenen Bot nutzen willst. Er wird verschlüsselt gespeichert und nie wieder angezeigt.',
          },
        ]}
      />
    </div>
  );
}
