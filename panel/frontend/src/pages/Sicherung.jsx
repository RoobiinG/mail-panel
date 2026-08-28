import { useState, useEffect } from 'react';
import {
  HardDriveDownload, ShieldCheck, Play, PlugZap, AlertTriangle,
  CheckCircle2, Loader2, KeyRound, Server, Info,
} from 'lucide-react';
import api from '../api';

// Postfach-Sicherung: alle Mails verschlüsselt auf einen FTP-Server.
//
// Die beiden Passwortfelder bleiben beim Laden absichtlich leer und werden nur
// gesendet, wenn wirklich etwas eingetippt wurde. Das Panel gibt gespeicherte
// Passwörter nie zurück — angezeigt wird nur, ob eines hinterlegt ist.

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

export default function Sicherung() {
  const [stand, setStand] = useState(null);
  const [form, setForm] = useState(null);
  const [passwort, setPasswort] = useState('');
  const [ftpPasswort, setFtpPasswort] = useState('');
  const [laden, setLaden] = useState(true);
  const [aktion, setAktion] = useState('');
  const [meldung, setMeldung] = useState(null);

  const holen = async () => {
    try {
      const { data } = await api.get('/sicherung');
      setStand(data);
      setForm({
        aktiv: data.aktiv, host: data.host, port: data.port, benutzer: data.benutzer,
        pfad: data.pfad, tls: data.tls, tlsUnsicher: data.tlsUnsicher,
        behalten: data.behalten, intervallStunden: data.intervallStunden,
        dubletten: data.dubletten,
      });
    } catch (err) {
      setMeldung({ art: 'fehler', text: err.response?.data?.error || 'Konnte den Stand nicht laden.' });
    } finally { setLaden(false); }
  };

  useEffect(() => { holen(); }, []);

  const feld = (name) => ({
    value: form?.[name] ?? '',
    onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.value })),
  });
  const haken = (name) => ({
    type: 'checkbox',
    checked: Boolean(form?.[name]),
    onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.checked })),
  });

  const speichern = async () => {
    setAktion('speichern'); setMeldung(null);
    try {
      const nutzlast = { ...form };
      if (passwort) nutzlast.passwort = passwort;
      if (ftpPasswort) nutzlast.ftpPasswort = ftpPasswort;
      const { data } = await api.post('/sicherung', nutzlast);
      setPasswort(''); setFtpPasswort('');
      setMeldung(data.fehlt?.length
        ? { art: 'hinweis', text: `Gespeichert. Zum Sichern fehlt noch: ${data.fehlt.join(', ')}.` }
        : { art: 'gut', text: 'Gespeichert.' });
      holen();
    } catch (err) {
      setMeldung({ art: 'fehler', text: err.response?.data?.error || 'Speichern fehlgeschlagen.' });
    } finally { setAktion(''); }
  };

  const testen = async () => {
    setAktion('testen'); setMeldung(null);
    try {
      const { data } = await api.post('/sicherung/test');
      setMeldung({
        art: 'gut',
        text: `Verbindung steht${data.verschluesselt ? ' (verschlüsselt)' : ' — unverschlüsselt!'}. `
          + `Verzeichnis "${data.pfad}", ${data.vorhandeneStaende} Stand/Stände liegen dort.`,
      });
    } catch (err) {
      setMeldung({ art: 'fehler', text: err.response?.data?.error || 'Verbindung fehlgeschlagen.' });
    } finally { setAktion(''); }
  };

  const starten = async (trockenlauf) => {
    setAktion(trockenlauf ? 'probe' : 'sichern'); setMeldung(null);
    try {
      const { data } = await api.post('/sicherung/starten', { trockenlauf });
      const konten = (data.konten || [])
        .map((k) => `${k.konto}: ${k.fehler ? `FEHLER ${k.fehler}` : `${k.mails} Mails`}`).join(' · ');
      setMeldung({
        art: 'gut',
        text: `${trockenlauf ? 'Probe' : 'Sicherung'} fertig: ${data.mails} Mails, ${mb(data.groesse)}, `
          + `${data.dauer} s. ${konten}`
          + (trockenlauf ? ' — nichts hochgeladen, die Datei liegt im Arbeitsverzeichnis.' : ''),
      });
      holen();
    } catch (err) {
      setMeldung({ art: 'fehler', text: err.response?.data?.error || 'Lauf fehlgeschlagen.' });
    } finally { setAktion(''); }
  };

  if (laden) {
    return <div className="p-8 text-panel-muted flex items-center gap-2">
      <Loader2 size={16} className="animate-spin" /> Lade …
    </div>;
  }

  const letzter = stand?.letzterLauf;
  const laeuft = Boolean(aktion);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-medium flex items-center gap-2">
          <HardDriveDownload size={22} className="text-panel-accent" /> Postfach-Sicherung
        </h1>
        <p className="text-sm text-panel-muted mt-1">
          Holt alle Mails aus jedem Konto, packt sie verschlüsselt zusammen und legt das Archiv
          auf einen FTP-Server. Es wird nur gelesen — im Postfach ändert sich nichts.
        </p>
      </div>

      {meldung && (
        <div className={`card !py-3 flex items-start gap-2 text-sm ${
          meldung.art === 'fehler' ? 'border-panel-red text-panel-red'
            : meldung.art === 'hinweis' ? 'border-yellow-600/60' : 'border-green-600/60'}`}>
          {meldung.art === 'fehler' ? <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />}
          <span>{meldung.text}</span>
        </div>
      )}

      {/* Letzter Stand */}
      <div className="card">
        <h2 className="font-medium mb-3 flex items-center gap-2"><ShieldCheck size={16} /> Letzter Stand</h2>
        {!letzter ? (
          <p className="text-sm text-panel-muted">Noch nie gelaufen.</p>
        ) : letzter.ok ? (
          <div className="text-sm space-y-1">
            <div><span className="text-panel-muted">Wann:</span>{' '}
              {new Date(letzter.zeitpunkt).toLocaleString('de-DE')}
              {letzter.trockenlauf && <span className="text-panel-muted"> (Probe)</span>}</div>
            <div><span className="text-panel-muted">Datei:</span> <span className="font-mono">{letzter.datei}</span></div>
            <div><span className="text-panel-muted">Umfang:</span> {letzter.mails} Mails, {mb(letzter.groesse)},
              gebraucht {letzter.dauer} s</div>
            {(letzter.konten || []).map((k) => (
              <div key={k.konto} className="text-panel-muted">
                • {k.konto}: {k.fehler ? <span className="text-panel-red">{k.fehler}</span> : `${k.mails} Mails`}
                {k.dubletten > 0 && ` (${k.dubletten} Dubletten übersprungen)`}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-panel-red">
            Fehlgeschlagen am {new Date(letzter.zeitpunkt).toLocaleString('de-DE')}: {letzter.fehler}
          </p>
        )}
      </div>

      {/* Verschlüsselung */}
      <div className="card space-y-3">
        <h2 className="font-medium flex items-center gap-2"><KeyRound size={16} /> Verschlüsselung</h2>
        <div className="text-sm text-panel-muted flex items-start gap-2 bg-panel-bg/50 p-3 rounded-lg">
          <Info size={15} className="mt-0.5 shrink-0 text-panel-accent" />
          <span>
            Ohne dieses Passwort lässt sich <strong>keine</strong> Sicherung mehr öffnen — auch von
            mir nicht. Schreib es dir an einen Ort, der nicht auf diesem Server liegt. Änderst du es,
            brauchen ältere Archive weiterhin das alte Passwort.
          </span>
        </div>
        <label className="block">
          <span className="text-sm text-panel-muted">
            Archiv-Passwort {stand?.passwortGesetzt && <span className="text-green-500">— ist gesetzt</span>}
          </span>
          <input type="password" value={passwort} onChange={(e) => setPasswort(e.target.value)}
            placeholder={stand?.passwortGesetzt ? 'Leer lassen = unverändert' : 'Mindestens 12 Zeichen'}
            className="mt-1" autoComplete="new-password" />
        </label>
      </div>

      {/* FTP-Ziel */}
      <div className="card space-y-3">
        <h2 className="font-medium flex items-center gap-2"><Server size={16} /> Ziel (FTP)</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block sm:col-span-2">
            <span className="text-sm text-panel-muted">Server</span>
            <input type="text" placeholder="ftp.beispiel.de" className="mt-1" {...feld('host')} />
          </label>
          <label className="block">
            <span className="text-sm text-panel-muted">Port</span>
            <input type="number" className="mt-1" {...feld('port')} />
          </label>
          <label className="block">
            <span className="text-sm text-panel-muted">Benutzer</span>
            <input type="text" className="mt-1" {...feld('benutzer')} autoComplete="off" />
          </label>
          <label className="block">
            <span className="text-sm text-panel-muted">
              Passwort {stand?.ftpPasswortGesetzt && <span className="text-green-500">— gesetzt</span>}
            </span>
            <input type="password" value={ftpPasswort} onChange={(e) => setFtpPasswort(e.target.value)}
              placeholder={stand?.ftpPasswortGesetzt ? 'Leer lassen = unverändert' : ''}
              className="mt-1" autoComplete="new-password" />
          </label>
          <label className="block">
            <span className="text-sm text-panel-muted">Verzeichnis</span>
            <input type="text" placeholder="/mail-sicherung" className="mt-1" {...feld('pfad')} />
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input {...haken('tls')} className="mt-1" />
          <span>
            <strong>Verschlüsselt verbinden (FTPS)</strong>
            <span className="block text-panel-muted text-xs mt-0.5">
              Empfohlen. Ohne den Haken geht dein FTP-Passwort im Klartext durchs Netz und ist
              mitlesbar. Das Archiv selbst bleibt in beiden Fällen verschlüsselt — deine Mails kann
              also niemand lesen, aber der Zugang zum Server wäre offen. Nur abschalten, wenn dein
              Server FTPS wirklich nicht kann.
            </span>
          </span>
        </label>
        {form?.tls && (
          <label className="flex items-start gap-2 text-sm">
            <input {...haken('tlsUnsicher')} className="mt-1" />
            <span className="text-panel-muted">
              Zertifikat nicht prüfen — nur nötig bei selbst ausgestellten Zertifikaten.
            </span>
          </label>
        )}
      </div>

      {/* Zeitplan */}
      <div className="card space-y-3">
        <h2 className="font-medium">Zeitplan</h2>
        <label className="flex items-center gap-2 text-sm">
          <input {...haken('aktiv')} />
          <span>Regelmäßig automatisch sichern</span>
        </label>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm text-panel-muted">Alle … Stunden</span>
            <input type="number" min="1" className="mt-1" {...feld('intervallStunden')} />
            <span className="text-xs text-panel-muted">168 = wöchentlich</span>
          </label>
          <label className="block">
            <span className="text-sm text-panel-muted">Stände aufheben</span>
            <input type="number" min="1" className="mt-1" {...feld('behalten')} />
            <span className="text-xs text-panel-muted">Ältere löscht das Panel auf dem FTP-Server</span>
          </label>
          <label className="flex items-start gap-2 text-sm mt-6">
            <input {...haken('dubletten')} className="mt-1" />
            <span>
              Dubletten überspringen
              <span className="block text-panel-muted text-xs">
                Gmail führt jede Mail zusätzlich in „Alle Nachrichten"
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={speichern} disabled={laeuft} className="btn disabled:opacity-50">
          {aktion === 'speichern' ? 'Speichert …' : 'Speichern'}
        </button>
        <button onClick={testen} disabled={laeuft} className="btn-ghost flex items-center gap-1 disabled:opacity-50">
          <PlugZap size={15} /> {aktion === 'testen' ? 'Prüft …' : 'Verbindung prüfen'}
        </button>
        <button onClick={() => starten(true)} disabled={laeuft}
          className="btn-ghost flex items-center gap-1 disabled:opacity-50"
          title="Baut und prüft das Archiv, lädt aber nichts hoch">
          <ShieldCheck size={15} /> {aktion === 'probe' ? 'Läuft …' : 'Probelauf'}
        </button>
        <button onClick={() => starten(false)} disabled={laeuft || stand?.fehlt?.length > 0}
          className="btn flex items-center gap-1 disabled:opacity-50"
          title={stand?.fehlt?.length ? `Es fehlt noch: ${stand.fehlt.join(', ')}` : 'Jetzt sichern und hochladen'}>
          <Play size={15} /> {aktion === 'sichern' ? 'Sichert …' : 'Jetzt sichern'}
        </button>
      </div>

      <div className="card !py-3 text-sm text-panel-muted">
        <strong className="text-panel-text">Zurückholen:</strong> Die Datei vom FTP-Server laden und
        <code className="mx-1 px-1 bg-panel-bg rounded">node wiederherstellen.js datei.mpsich</code>
        ausführen. Das Skript liegt im Projektordner unter <span className="font-mono">panel/</span>,
        braucht nur Node und läuft auch ohne das Panel. Heraus kommt je Ordner eine
        <span className="font-mono"> .mbox</span>-Datei, die jedes Mailprogramm einlesen kann.
      </div>
    </div>
  );
}
