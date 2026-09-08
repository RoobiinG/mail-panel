// Die Diagnose-Seite: ein Bericht zum Weitergeben, statt einer Shell auf dem
// Server.
//
// Der Hintergrund ist eine Abwägung: Wer beim Fehlersuchen helfen soll, braucht
// Einblick — aber wer Docker ausführen darf, ist faktisch root und käme damit
// auch an die Postfächer. Diese Seite gibt genau das heraus, was zum Suchen
// nötig ist, und nichts darüber hinaus.
import { useState } from 'react';
import {
  Stethoscope, RefreshCw, Copy, Check, Link2, ShieldAlert, ChevronDown, ChevronRight,
} from 'lucide-react';
import api from '../api';
import { useMelden } from '../components/ui/Meldungen';

// Die Abschnitte des Berichts in der Reihenfolge, in der man beim Suchen
// draufschaut: erst „läuft es überhaupt", dann „was hat es getan".
const ABSCHNITTE = [
  { schluessel: 'panel', titel: 'Panel', hinweis: 'Version, Laufzeit, Verschlüsselung' },
  { schluessel: 'maschine', titel: 'Maschine', hinweis: 'Speicher, Platte, Last — eine volle Platte legt Container um' },
  { schluessel: 'dienste', titel: 'Dienste', hinweis: 'Verbindungsversuch zu n8n, ClamAV, unbound, Ollama' },
  { schluessel: 'ki', titel: 'KI', hinweis: 'Anbieter, Modell, Kontingent, letzte Abweisung' },
  { schluessel: 'autoSync', titel: 'Workflow-Abgleich', hinweis: 'wann zuletzt automatisch abgeglichen wurde' },
  { schluessel: 'konfiguration', titel: 'Konfiguration', hinweis: 'Einstellungen — Geheimnisse nur als „gesetzt“' },
  { schluessel: 'konten', titel: 'Konten', hinweis: 'Namen, Hosts, Zielordner — keine Zugangsdaten' },
  { schluessel: 'workflows', titel: 'Workflows in n8n', hinweis: 'Knoten, KI-Adresse, Antwortformat, Auslöser' },
  { schluessel: 'laeufe', titel: 'Letzte Läufe', hinweis: 'Status, Dauer, Fehlerstelle' },
  { schluessel: 'sortierung', titel: 'Sortierung', hinweis: 'Zahlen und Gründe — keine Mailinhalte' },
  { schluessel: 'schema', titel: 'Datenbank-Schema', hinweis: 'zeigt, ob die Migrationen durch sind' },
  { schluessel: 'sicherung', titel: 'Sicherung', hinweis: 'eingerichtet, letzter Lauf' },
  { schluessel: 'logs', titel: 'Logs', hinweis: 'die letzten Zeilen, Adressen unkenntlich gemacht' },
  { schluessel: 'letzteEntscheidungen', titel: 'Letzte Entscheidungen', hinweis: 'nur mit Mailinhalten' },
];

function Abschnitt({ titel, hinweis, inhalt, offenStandard }) {
  const [offen, setOffen] = useState(Boolean(offenStandard));
  if (inhalt === undefined) return null;
  return (
    <div className="border border-panel-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOffen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-panel-card/60 hover:bg-panel-bg/40 transition-colors text-left"
      >
        {offen ? <ChevronDown size={14} className="text-panel-muted" /> : <ChevronRight size={14} className="text-panel-muted" />}
        <span className="text-sm font-medium">{titel}</span>
        <span className="text-[11px] text-panel-muted hidden md:inline">{hinweis}</span>
      </button>
      {offen && (
        <pre className="text-[11px] leading-relaxed p-3 overflow-auto max-h-[380px] bg-panel-bg/30 font-mono">
          {JSON.stringify(inhalt, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function Diagnose() {
  const { melden, nachfragen } = useMelden();
  const [bericht, setBericht] = useState(null);
  const [text, setText] = useState('');
  const [laedt, setLaedt] = useState(false);
  const [mitMails, setMitMails] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const [link, setLink] = useState('');

  const erstellen = async (mails = mitMails) => {
    setLaedt(true);
    try {
      const { data } = await api.get(`/diagnose?logs=60${mails ? '&mails=1' : ''}`);
      setBericht(data.bericht);
      setText(data.text);
      setLink('');
    } catch (err) {
      melden(err.response?.data?.error || 'Der Bericht ließ sich nicht erstellen.', 'fehler');
    } finally {
      setLaedt(false);
    }
  };

  // Mailinhalte sind eine bewusste Entscheidung, keine Voreinstellung — deshalb
  // eine Rückfrage, bevor der Schalter umgeht.
  const mailsUmschalten = async (an) => {
    if (an && !(await nachfragen({
      titel: 'Absender und Betreffe mitschicken?',
      text: 'Der Bericht enthält dann die letzten zehn Entscheidungen mit echten Absendern und Betreffen, '
        + 'und in den Logzeilen bleiben Adressen stehen. Nur zuschalten, wenn eine einzelne Fehleinordnung '
        + 'ohne Beispiel nicht zu verstehen ist.',
      bestaetigen: 'Mit Mailinhalten',
      gefaehrlich: true,
    }))) return;
    setMitMails(an);
    if (bericht) erstellen(an);
  };

  const kopieren = async () => {
    await navigator.clipboard.writeText(text);
    setKopiert(true);
    setTimeout(() => setKopiert(false), 2000);
  };

  // Derselbe Weg wie bei den Logs: Der Inhalt wird im Browser verschlüsselt, der
  // Schlüssel steht hinter dem # und wird deshalb nie an den Server geschickt.
  // Wer den Link nicht hat, kann auch mit Zugriff auf die Datenbank nichts lesen.
  const linkErstellen = async () => {
    try {
      const key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const verschluesselt = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text),
      );
      const bytes = new Uint8Array(iv.length + verschluesselt.byteLength);
      bytes.set(iv, 0);
      bytes.set(new Uint8Array(verschluesselt), iv.length);
      // Nicht über den Spread-Operator: Bei einem großen Bericht sprengt das den
      // Aufruf-Stack ("Maximum call stack size exceeded").
      let roh = '';
      for (const b of bytes) roh += String.fromCharCode(b);

      const rawKey = await window.crypto.subtle.exportKey('raw', key);
      const hexKey = Array.from(new Uint8Array(rawKey)).map(b => b.toString(16).padStart(2, '0')).join('');

      const { data } = await api.post('/paste', { payload: btoa(roh) });
      const fertig = `${window.location.origin}/paste/${data.id}#key=${hexKey}`;
      setLink(fertig);
      try { await navigator.clipboard.writeText(fertig); } catch { /* dann von Hand */ }
      melden('Link erstellt und in die Zwischenablage kopiert.');
    } catch (err) {
      melden(`Der Link ließ sich nicht erstellen: ${err.message}`, 'fehler');
    }
  };

  return (
    <div className="space-y-6">
      <div className="card space-y-4">
        <div className="flex items-start gap-3 flex-wrap">
          <Stethoscope size={20} className="text-panel-accent mt-0.5" />
          <div className="flex-1 min-w-[260px]">
            <h1 className="font-medium">Diagnose</h1>
            <p className="text-xs text-panel-muted mt-1 max-w-2xl">
              Sammelt an einer Stelle, was zum Fehlersuchen nötig ist: Zustand der Dienste, Speicher und
              Platte, die Workflows in n8n samt ihrer KI-Adresse, die letzten Läufe mit Fehlerstelle,
              Zahlen zur Sortierung und die letzten Logzeilen. Zum Weitergeben, damit niemand dafür eine
              Shell auf dem Server braucht.
            </p>
          </div>
          <button onClick={() => erstellen()} disabled={laedt}
            className="btn flex items-center gap-2 text-sm whitespace-nowrap">
            <RefreshCw size={14} className={laedt ? 'animate-spin' : ''} />
            {bericht ? 'Neu erstellen' : 'Bericht erstellen'}
          </button>
        </div>

        {/* Was drin ist und was nicht — vor dem Erstellen, nicht danach. */}
        <div className="rounded-lg border border-panel-border bg-panel-bg/30 p-3 space-y-2">
          <p className="text-xs">
            <span className="text-panel-accent font-medium">Nicht enthalten:</span>{' '}
            Passwörter, API-Schlüssel und Token (nur „gesetzt“ / „nicht gesetzt“), Mailinhalte, Betreffe
            und Absenderadressen. Auch in den Logzeilen werden Adressen durch <code>&lt;adresse&gt;</code>
            {' '}ersetzt.
          </p>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={mitMails} className="mt-0.5"
              onChange={ev => mailsUmschalten(ev.target.checked)} />
            <span>
              <span className="inline-flex items-center gap-1 text-panel-red font-medium">
                <ShieldAlert size={12} /> Absender und Betreffe mitschicken
              </span>
              <span className="text-panel-muted">
                {' — '}die letzten zehn Entscheidungen im Klartext. Nur, wenn eine einzelne
                Fehleinordnung ohne Beispiel nicht zu klären ist.
              </span>
            </span>
          </label>
        </div>

        {bericht && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={kopieren} className="btn-ghost flex items-center gap-1.5 text-sm">
              {kopiert ? <Check size={14} className="text-panel-accent" /> : <Copy size={14} />}
              {kopiert ? 'Kopiert' : 'Als Text kopieren'}
            </button>
            <button onClick={linkErstellen} className="btn-ghost flex items-center gap-1.5 text-sm"
              title="Verschlüsselt im Browser; der Schlüssel steht hinter dem # und erreicht den Server nie">
              <Link2 size={14} /> Verschlüsselten Link erstellen
            </button>
            <span className="text-[11px] text-panel-muted">
              {Math.round(text.length / 1024)} kB · erstellt {new Date(bericht.erstellt).toLocaleString('de-DE')}
              {bericht.mitMailinhalten && <span className="text-panel-red"> · mit Mailinhalten</span>}
            </span>
          </div>
        )}

        {link && (
          <div className="text-xs bg-panel-bg/50 border border-panel-border rounded p-2 break-all font-mono">
            {link}
            <p className="text-[11px] text-panel-muted font-sans mt-1">
              Der Link läuft nach sieben Tagen ab. Alles hinter dem <code>#</code> ist der Schlüssel — wer
              den Link weitergibt, gibt den Inhalt weiter.
            </p>
          </div>
        )}
      </div>

      {bericht && (
        <div className="space-y-2">
          {ABSCHNITTE.map((a, i) => (
            <Abschnitt
              key={a.schluessel}
              titel={a.titel}
              hinweis={a.hinweis}
              inhalt={bericht[a.schluessel]}
              offenStandard={i < 4}
            />
          ))}
        </div>
      )}
    </div>
  );
}
