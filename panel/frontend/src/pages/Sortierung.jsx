import { useState, useEffect } from 'react';
import {
  Plus, Trash2, CheckCircle2, XCircle, AlertCircle, Inbox, Tag, ArrowRight,
  FolderTree, Sparkles, Lock, Unlock, RefreshCw, Check, Wand2,
  ChevronRight, ChevronDown, Layers, AtSign
} from 'lucide-react';

// "Name <a@b.de>" -> "a@b.de" bzw. "b.de"
const adresse = (von) => {
  const roh = String(von || '').toLowerCase().trim();
  const t = roh.match(/<([^>]+)>/);
  return (t ? t[1] : roh).trim();
};
const domainVon = (von) => (adresse(von).split('@')[1] || '').trim();
import api from '../api';

const REGEL_TYPEN = {
  absender: 'Exakter Absender (E-Mail)',
  domain: 'Domain (z.B. amazon.de)',
  betreff: 'Betreff enthält',
};

export default function Sortierung() {
  const [konten, setKonten] = useState([]);
  const [aktivesKonto, setAktivesKonto] = useState('');
  
  const [regeln, setRegeln] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [laedt, setLaedt] = useState(false);

  // Modal: Neue Regel
  const [regelModal, setRegelModal] = useState({
    offen: false, typ: 'absender', muster: '', zielordner: ''
  });

  // State für die Zuordnung in der Inbox (welcher Ordner ist im Dropdown gewählt)
  const [ordnerWahl, setOrdnerWahl] = useState({});
  const [regelAnlegenWahl, setRegelAnlegenWahl] = useState({});

  // Themen-Katalog und die Ordner, die die KI vorgeschlagen hat
  const [katalog, setKatalog] = useState([]);
  const [vorschlaege, setVorschlaege] = useState([]);
  const [katalogModal, setKatalogModal] = useState({ offen: false, ordner: '', beschreibung: '' });
  const [einleseMeldung, setEinleseMeldung] = useState('');
  const [beschreibungEntwurf, setBeschreibungEntwurf] = useState({});

  // Sortier-Inbox nach Absender-Domain gebuendelt
  const [offeneGruppen, setOffeneGruppen] = useState({});   // domain -> aufgeklappt?
  const [gruppenOrdner, setGruppenOrdner] = useState({});   // domain -> Zielordner
  const [gruppenTyp, setGruppenTyp] = useState({});         // domain -> 'domain'|'absender'|'keine'
  const [gruppeLaeuft, setGruppeLaeuft] = useState('');

  // Einzelregeln, die sich zu einer Domain-Regel zusammenfassen lassen
  const [zusammenfassbar, setZusammenfassbar] = useState([]);

  const ladenInit = async () => {
    try {
      const [{ data: accData }, { data: inData }] = await Promise.all([
        api.get('/konten'),
        api.get('/sortierung/inbox')
      ]);
      setKonten(accData || []);
      setInbox(inData || []);
      if (accData && accData.length > 0) {
        setAktivesKonto(accData[0].id);
      }
    } catch { /* leer */ }
  };

  useEffect(() => { ladenInit(); }, []);

  const regelnLaden = async (kontoId) => {
    if (!kontoId) return;
    setLaedt(true);
    try {
      const [{ data }, zus] = await Promise.all([
        api.get(`/sortierung/regeln?konto_id=${kontoId}`),
        api.get(`/sortierung/regeln/zusammenfassbar?konto_id=${kontoId}`).catch(() => ({ data: [] })),
      ]);
      setRegeln(data || []);
      setZusammenfassbar(zus.data || []);
    } catch { /* leer */ } finally {
      setLaedt(false);
    }
  };

  const regelnZusammenfassen = async (gruppe) => {
    const text = `${gruppe.regeln.length} Einzelregeln durch eine Regel für @${gruppe.domain} ersetzen?\n\n`
      + gruppe.regeln.map(r => `  ${r.muster}`).join('\n')
      + `\n\nDie neue Regel deckt auch alle künftigen Adressen dieser Domain ab.`;
    if (!confirm(text)) return;
    try {
      const { data } = await api.post('/sortierung/regeln/zusammenfassen', {
        konto_id: aktivesKonto, domain: gruppe.domain, zielordner: gruppe.zielordner,
      });
      const dazu = data.nachsortiert?.verschoben
        ? ` Dabei wurden ${data.nachsortiert.verschoben} wartende Mail(s) mitsortiert.`
        : '';
      alert(`${data.ersetzt} Regeln zu einer Domain-Regel zusammengefasst.${dazu}`);
      regelnLaden(aktivesKonto);
      inboxLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Zusammenfassen');
    }
  };

  const katalogLaden = async (kontoId) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/katalog?konto_id=${kontoId}`);
      setKatalog(data || []);
    } catch { /* leer */ }
  };

  const vorschlaegeLaden = async () => {
    try {
      const { data } = await api.get('/sortierung/vorschlaege');
      setVorschlaege(data || []);
    } catch { /* leer */ }
  };

  useEffect(() => { regelnLaden(aktivesKonto); katalogLaden(aktivesKonto); }, [aktivesKonto]);
  useEffect(() => { vorschlaegeLaden(); }, []);

  // ─── THEMEN-KATALOG ─────────────────────────────────────────────────────────

  const katalogSpeichern = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sortierung/katalog', {
        konto_id: aktivesKonto,
        ordner: katalogModal.ordner,
        beschreibung: katalogModal.beschreibung,
      });
      setKatalogModal({ offen: false, ordner: '', beschreibung: '' });
      katalogLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Speichern');
    }
  };

  const katalogAendern = async (id, felder) => {
    try {
      await api.put(`/sortierung/katalog/${id}`, felder);
      katalogLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Ändern');
    }
  };

  const katalogEntfernen = async (id) => {
    if (!confirm('Aus dem Katalog nehmen? Der Ordner im Postfach bleibt bestehen.')) return;
    try {
      await api.delete(`/sortierung/katalog/${id}`);
      katalogLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Entfernen');
    }
  };

  const ordnerEinlesen = async () => {
    setEinleseMeldung('Lese …');
    try {
      const { data } = await api.post('/sortierung/katalog/einlesen', { konto_id: aktivesKonto });
      setEinleseMeldung(
        data.neu?.length ? `${data.neu.length} Ordner übernommen.` : 'Keine neuen Ordner gefunden.',
      );
      katalogLaden(aktivesKonto);
      setTimeout(() => setEinleseMeldung(''), 4000);
    } catch (err) {
      setEinleseMeldung(err.response?.data?.error || 'Fehler beim Einlesen');
    }
  };

  // ─── ORDNER-VORSCHLÄGE ──────────────────────────────────────────────────────

  const vorschlagFreigeben = async (id) => {
    try {
      const { data } = await api.post(`/sortierung/vorschlaege/${id}/freigeben`);
      vorschlaegeLaden(); katalogLaden(aktivesKonto); inboxLaden();
      if (data.wartend) alert(`Ordner "${data.ordner}" angelegt. ${data.verschoben} von ${data.wartend} wartenden Mails einsortiert.`);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Freigeben');
    }
  };

  const vorschlagAblehnen = async (id) => {
    try {
      await api.post(`/sortierung/vorschlaege/${id}/ablehnen`);
      vorschlaegeLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Ablehnen');
    }
  };

  const inboxLaden = async () => {
    try {
      const { data } = await api.get('/sortierung/inbox');
      setInbox(data || []);
    } catch { /* leer */ }
  };

  // ─── REGELN ──────────────────────────────────────────────────────────────────

  const regelSpeichern = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sortierung/regeln', {
        konto_id: aktivesKonto,
        typ: regelModal.typ,
        muster: regelModal.muster,
        zielordner: regelModal.zielordner,
      });
      setRegelModal({ offen: false, typ: 'absender', muster: '', zielordner: '' });
      regelnLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Speichern');
    }
  };

  const regelLoeschen = async (id) => {
    if (!confirm('Regel löschen?')) return;
    try {
      await api.delete(`/sortierung/regeln/${id}`);
      regelnLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Löschen');
    }
  };

  // ─── INBOX ───────────────────────────────────────────────────────────────────

  const zuordnen = async (mailId) => {
    const zielordner = ordnerWahl[mailId];
    if (!zielordner) return alert('Bitte einen Zielordner angeben.');
    // '' | 'absender' | 'domain' — das Backend versteht beide Regeltypen
    const anlegen = regelAnlegenWahl[mailId] || false;

    try {
      await api.post('/sortierung/zuordnen', {
        id: mailId,
        zielordner,
        regelAnlegen: anlegen
      });
      // Wenn eine Regel angelegt wurde, laden wir die Regeln neu (falls das selbe Konto aktiv ist)
      const mail = inbox.find(m => m.id === mailId);
      if (anlegen && mail && mail.konto_id === aktivesKonto) {
        regelnLaden(aktivesKonto);
      }
      inboxLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Zuordnen');
    }
  };

  // ─── STAPEL: ALLE MAILS EINER DOMAIN AUF EINMAL ─────────────────────────────

  // Die offenen Mails nach Absender-Domain buendeln. Genau hier liegt die
  // Arbeitsersparnis: 20 Mails von accounts.google.com sind ein Handgriff,
  // nicht zwanzig.
  const gefilterteInbox = aktivesKonto 
    ? inbox.filter(m => m.konto_id === aktivesKonto) 
    : inbox;

  const gruppen = (() => {
    const map = new Map();
    for (const mail of gefilterteInbox) {
      const d = domainVon(mail.von) || '(ohne Absender)';
      if (!map.has(d)) map.set(d, { domain: d, mails: [], absender: new Set() });
      const g = map.get(d);
      g.mails.push(mail);
      g.absender.add(adresse(mail.von));
    }
    return [...map.values()].sort((a, b) => b.mails.length - a.mails.length);
  })();

  const stapelZuordnen = async (gruppe) => {
    const zielordner = (gruppenOrdner[gruppe.domain] || '').trim();
    if (!zielordner) return alert('Bitte einen Zielordner angeben.');
    const kontoId = gruppe.mails[0]?.konto_id;
    if (!kontoId) return alert('Zu diesen Mails ist kein Konto hinterlegt.');

    // Standard: Domain-Regel, wenn mehrere Absender darin stecken
    const typ = gruppenTyp[gruppe.domain] || (gruppe.absender.size > 1 ? 'domain' : 'absender');
    const muster = typ === 'domain' ? gruppe.domain : adresse(gruppe.mails[0].von);

    setGruppeLaeuft(gruppe.domain);
    try {
      const { data } = await api.post('/sortierung/sammel-zuordnen', {
        konto_id: kontoId,
        typ: typ === 'keine' ? 'domain' : typ,
        muster: typ === 'keine' ? gruppe.domain : muster,
        zielordner,
        regelMerken: typ !== 'keine',
      });
      const fehler = data.fehler?.length ? ` (${data.fehler.length} Fehler)` : '';
      alert(`${data.verschoben} von ${data.treffer} Mail(s) nach „${zielordner}" verschoben${fehler}.`);
      inboxLaden();
      regelnLaden(aktivesKonto);
      katalogLaden(aktivesKonto);
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Sortieren');
    } finally {
      setGruppeLaeuft('');
    }
  };

  const ignorieren = async (mailId) => {
    try {
      await api.post('/sortierung/ignorieren', { id: mailId });
      inboxLaden();
    } catch (err) {
      alert(err.response?.data?.error || 'Fehler beim Ignorieren');
    }
  };

  const alleOrdner = Array.from(new Set([
    'Quarantaene', 'Rechnungen', 'Bestellungen', 'Newsletter', 'Archiv',
    ...katalog.map(o => o.ordner),
    ...regeln.map(r => r.zielordner)
  ])).filter(Boolean).sort();

  return (
    <div className="space-y-6">
      <datalist id="ordner-vorschlaege">
        {alleOrdner.map(o => <option key={o} value={o} />)}
      </datalist>
      
      {/* ══ Vorschläge der KI: neue Ordner, die auf Freigabe warten ══ */}
      {vorschlaege.length > 0 && (
        <div className="card !p-0 overflow-hidden">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
            <Sparkles size={18} className="text-panel-accent" />
            <h2 className="font-medium">Neue Ordner-Vorschläge</h2>
            <span className="bg-panel-accent text-white text-xs px-2 py-0.5 rounded-full">
              {vorschlaege.length}
            </span>
          </div>
          <div className="divide-y divide-panel-border">
            {vorschlaege.map(v => (
              <div key={v.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-panel-accent">{v.ordner}</span>
                    <span className="text-xs text-panel-muted">
                      {v.konto_name} · {v.anzahl}× vorgeschlagen
                      {v.wartend > 0 && ` · ${v.wartend} Mail(s) warten`}
                    </span>
                  </div>
                  {v.begruendung && (
                    <div className="text-xs text-panel-muted truncate mt-1" title={v.begruendung}>
                      {v.begruendung}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => vorschlagAblehnen(v.id)} className="btn-ghost !py-1.5 !px-3 text-sm text-panel-muted hover:text-panel-red">
                    Ablehnen
                  </button>
                  <button onClick={() => vorschlagFreigeben(v.id)} className="btn !py-1.5 !px-3 text-sm flex items-center gap-1">
                    <Check size={14} /> Anlegen &amp; einsortieren
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ Themen-Katalog: woraus die KI wählen darf ══ */}
      <div className="card !p-0 overflow-hidden">
        <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-3 justify-between items-center">
          <h2 className="font-medium flex items-center gap-2">
            <FolderTree size={18} className="text-panel-accent" /> Themen-Ordner
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {einleseMeldung && <span className="text-xs text-panel-muted">{einleseMeldung}</span>}
            <button onClick={ordnerEinlesen} disabled={!aktivesKonto}
              className="btn-ghost !py-1.5 !px-3 text-sm flex items-center gap-1">
              <RefreshCw size={14} /> Aus Postfach einlesen
            </button>
            <button onClick={() => setKatalogModal({ offen: true, ordner: '', beschreibung: '' })}
              disabled={!aktivesKonto} className="btn !py-1.5 !px-3 text-sm flex items-center gap-1">
              <Plus size={14} /> Ordner
            </button>
          </div>
        </div>

        <p className="px-4 pt-3 text-xs text-panel-muted">
          Aus diesen Ordnern wählt die KI beim Einsortieren — und nur aus diesen. Die Beschreibung
          geht wörtlich in den Prompt: Ein Satz wie „Spiele, Steam, Konsolen, Gaming-Newsletter“
          verbessert die Treffer deutlich. Gesperrte Ordner werden nie befüllt.
        </p>

        <div className="overflow-auto max-h-[360px] mt-2">
          {katalog.length === 0 ? (
            <p className="p-6 text-center text-panel-muted text-sm">
              Noch keine Themen-Ordner. Mit <span className="text-panel-text">Aus Postfach einlesen</span> übernimmst
              du die Ordner, die es im Konto schon gibt.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                  <th className="py-2 px-4">Ordner</th>
                  <th className="py-2 px-4">Beschreibung für die KI</th>
                  <th className="py-2 px-4">Herkunft</th>
                  <th className="py-2 px-4 text-center">Treffer</th>
                  <th className="py-2 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {katalog.map(o => (
                  <tr key={o.id} className={`border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors ${o.gesperrt ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-4 font-mono text-panel-accent whitespace-nowrap">{o.ordner}</td>
                    <td className="py-2 px-4">
                      <input
                        type="text"
                        placeholder="Wofür ist dieser Ordner?"
                        defaultValue={o.beschreibung || ''}
                        onChange={e => setBeschreibungEntwurf(p => ({ ...p, [o.id]: e.target.value }))}
                        onBlur={() => {
                          const neu = beschreibungEntwurf[o.id];
                          if (neu !== undefined && neu !== (o.beschreibung || '')) {
                            katalogAendern(o.id, { beschreibung: neu });
                          }
                        }}
                        className="w-full bg-transparent text-sm border-b border-transparent hover:border-panel-border focus:border-panel-accent focus:outline-none"
                      />
                    </td>
                    <td className="py-2 px-4">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-panel-border/50">
                        {o.quelle === 'ki' ? 'KI' : o.quelle === 'manuell' ? 'manuell' : 'Postfach'}
                      </span>
                    </td>
                    <td className="py-2 px-4 text-center text-xs text-panel-muted">{o.treffer}</td>
                    <td className="py-2 px-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => katalogAendern(o.id, { gesperrt: !o.gesperrt })}
                        className="btn-ghost !px-2"
                        title={o.gesperrt ? 'Wieder freigeben' : 'Sperren — hier nie einsortieren'}
                      >
                        {o.gesperrt ? <Lock size={16} /> : <Unlock size={16} className="text-panel-muted" />}
                      </button>
                      <button onClick={() => katalogEntfernen(o.id)} className="btn-ghost !px-2 text-panel-red" title="Aus dem Katalog nehmen">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LINKE SEITE: Regeln */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-4 justify-between items-center">
            <h2 className="font-medium flex items-center gap-2">
              <Tag size={18} className="text-panel-accent" /> Sortier-Regeln
            </h2>
            <div className="flex items-center gap-3">
              <select
                value={aktivesKonto}
                onChange={e => setAktivesKonto(Number(e.target.value))}
                className="text-sm bg-panel-bg"
              >
                {konten.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
              <button
                onClick={() => setRegelModal(p => ({ ...p, offen: true }))}
                className="btn !py-1.5 !px-3 text-sm flex items-center gap-1"
                disabled={!aktivesKonto}
              >
                <Plus size={14} /> Regel
              </button>
            </div>
          </div>
          
          {/* Aufgesammelte Einzelregeln zu einer Domain-Regel bündeln */}
          {zusammenfassbar.map(gruppe => (
            <div key={gruppe.domain + gruppe.zielordner}
              className="mx-4 mt-3 p-3 rounded-lg border border-panel-accent/40 bg-panel-accent/5 flex flex-wrap items-center gap-2 text-sm">
              <Layers size={16} className="text-panel-accent shrink-0" />
              <span className="flex-1 min-w-[200px]">
                <span className="font-medium">{gruppe.regeln.length} Einzelregeln</span> für
                {' '}<span className="font-mono">@{gruppe.domain}</span> zeigen alle auf
                {' '}<span className="font-mono text-panel-accent">{gruppe.zielordner}</span>.
                <span className="text-panel-muted"> Eine Domain-Regel erledigt das und deckt künftige Adressen mit ab.</span>
              </span>
              <button onClick={() => regelnZusammenfassen(gruppe)} className="btn !py-1.5 !px-3 text-sm whitespace-nowrap">
                Zusammenfassen
              </button>
            </div>
          ))}

          <div className="flex-1 overflow-auto max-h-[500px]">
            {regeln.length === 0 ? (
              <p className="p-6 text-center text-panel-muted text-sm">
                Keine Regeln für dieses Konto hinterlegt.<br/>
                Mails dieses Kontos, die nicht manuell sortiert werden, landen in der Inbox.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                    <th className="py-2 px-4">Bedingung</th>
                    <th className="py-2 px-4">Zielordner</th>
                    <th className="py-2 px-4 text-center">Treffer</th>
                    <th className="py-2 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {regeln.map(r => (
                    <tr key={r.id} className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="text-xs text-panel-muted">{REGEL_TYPEN[r.typ]}</div>
                        <div className="font-medium truncate max-w-[200px]" title={r.muster}>{r.muster}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-panel-accent">{r.zielordner}</td>
                      <td className="py-3 px-4 text-center text-xs text-panel-muted">{r.treffer}</td>
                      <td className="py-3 px-4 text-right">
                        <button onClick={() => regelLoeschen(r.id)} className="btn-ghost !px-2 text-panel-red" title="Löschen">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* RECHTE SEITE: Sortier-Inbox */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex justify-between items-center">
            <h2 className="font-medium flex items-center gap-2">
              <Inbox size={18} className="text-panel-accent" /> Sortier-Inbox
              <span className="text-[11px] font-normal text-panel-muted hidden sm:inline">
                nach Absender-Domain gebündelt
              </span>
              {gefilterteInbox.length > 0 && (
                <span className="bg-panel-accent text-white text-xs px-2 py-0.5 rounded-full">
                  {gefilterteInbox.length}
                </span>
              )}
            </h2>
            <button onClick={inboxLaden} className="btn-ghost text-xs">Aktualisieren</button>
          </div>
          
          <div className="flex-1 overflow-auto max-h-[500px]">
            {gefilterteInbox.length === 0 ? (
              <div className="p-8 text-center text-panel-muted flex flex-col items-center gap-2">
                <CheckCircle2 size={32} className="text-green-500/50" />
                <p className="text-sm">Nichts offen — alle Mails wurden automatisch einsortiert.</p>
              </div>
            ) : (
              <div className="divide-y divide-panel-border">
                {gruppen.map(gruppe => {
                  const offen = offeneGruppen[gruppe.domain];
                  const typ = gruppenTyp[gruppe.domain] || (gruppe.absender.size > 1 ? 'domain' : 'absender');
                  const laeuft = gruppeLaeuft === gruppe.domain;
                  return (
                    <div key={gruppe.domain}>
                      {/* Kopfzeile der Domain-Gruppe */}
                      <div className="p-3 bg-panel-bg/40 flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => setOffeneGruppen(p => ({ ...p, [gruppe.domain]: !p[gruppe.domain] }))}
                          className="btn-ghost !px-1 shrink-0"
                          title={offen ? 'Einklappen' : 'Mails anzeigen'}
                        >
                          {offen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                        <AtSign size={14} className="text-panel-accent shrink-0" />
                        <span className="font-mono text-sm truncate max-w-[220px]" title={gruppe.domain}>
                          {gruppe.domain}
                        </span>
                        <span className="bg-panel-border/60 text-xs px-1.5 py-0.5 rounded whitespace-nowrap">
                          {gruppe.mails.length} Mail{gruppe.mails.length === 1 ? '' : 's'}
                        </span>
                        {gruppe.absender.size > 1 && (
                          <span className="text-[11px] text-panel-muted whitespace-nowrap">
                            {gruppe.absender.size} Absender
                          </span>
                        )}
                      </div>

                      {/* Ein Handgriff für den ganzen Stapel */}
                      <div className="px-3 pb-3 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center bg-panel-bg/40">
                        <input
                          type="text"
                          placeholder={`Alle ${gruppe.mails.length} nach … (z.B. Google)`}
                          value={gruppenOrdner[gruppe.domain] || ''}
                          onChange={e => setGruppenOrdner(p => ({ ...p, [gruppe.domain]: e.target.value }))}
                          list="ordner-vorschlaege"
                          className="flex-1 text-sm"
                        />
                        <select
                          value={typ}
                          onChange={e => setGruppenTyp(p => ({ ...p, [gruppe.domain]: e.target.value }))}
                          className="text-sm bg-panel-bg"
                          title="Was soll sich das Panel für die Zukunft merken?"
                        >
                          <option value="domain">Regel: ganze Domain</option>
                          <option value="absender">Regel: nur dieser Absender</option>
                          <option value="keine">Nur jetzt, keine Regel</option>
                        </select>
                        <button
                          onClick={() => stapelZuordnen(gruppe)}
                          disabled={laeuft}
                          className="btn !py-1.5 !px-3 text-sm flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-50"
                        >
                          <Layers size={14} /> {laeuft ? 'Läuft …' : `Alle ${gruppe.mails.length} verschieben`}
                        </button>
                      </div>

                      {/* Einzelne Mails erst auf Wunsch */}
                      {offen && gruppe.mails.map(mail => (
                  <div key={mail.id} className="p-4 hover:bg-panel-bg/30 transition-colors">
                    <div className="flex justify-between items-start gap-4 mb-3">
                      <div className="truncate">
                        <div className="text-xs text-panel-muted mb-1 flex items-center gap-2">
                          <span className="bg-panel-border/50 px-1.5 py-0.5 rounded">{mail.account_name || mail.konto}</span>
                          {new Date(mail.created_at).toLocaleString('de-DE')}
                        </div>
                        <div className="font-medium truncate" title={mail.von}>{mail.von}</div>
                        <div className="text-sm text-panel-muted truncate" title={mail.betreff}>{mail.betreff || '(Kein Betreff)'}</div>
                        {(mail.ki_ordner || mail.ki_grund) && (
                          <div className="mt-1.5 text-xs flex items-start gap-1.5 text-panel-muted">
                            <Wand2 size={13} className="text-panel-accent mt-0.5 shrink-0" />
                            <span>
                              {mail.ki_ordner
                                ? <>KI schlug <span className="font-mono text-panel-accent">{mail.ki_ordner}</span> vor
                                    {mail.ki_konfidenz != null && ` (${Math.round(mail.ki_konfidenz * 100)} % sicher)`} — </>
                                : null}
                              {mail.ki_grund}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center bg-panel-bg/50 p-3 rounded-lg border border-panel-border">
                      <div className="flex-1 w-full">
                        <input
                          type="text"
                          placeholder="Zielordner (z.B. Rechnungen)"
                          value={ordnerWahl[mail.id] ?? ''}
                          onChange={e => setOrdnerWahl(p => ({ ...p, [mail.id]: e.target.value }))}
                          list="ordner-vorschlaege"
                          className="w-full text-sm"
                        />
                        {mail.ki_ordner && !ordnerWahl[mail.id] && (
                          <button
                            type="button"
                            onClick={() => setOrdnerWahl(p => ({ ...p, [mail.id]: mail.ki_ordner }))}
                            className="mt-1 text-xs text-panel-accent hover:underline"
                          >
                            Vorschlag „{mail.ki_ordner}“ übernehmen
                          </button>
                        )}
                      </div>
                      <select
                        value={regelAnlegenWahl[mail.id] || ''}
                        onChange={e => setRegelAnlegenWahl(p => ({ ...p, [mail.id]: e.target.value }))}
                        className="text-xs bg-panel-bg whitespace-nowrap"
                        title="Was soll sich das Panel für die Zukunft merken?"
                      >
                        <option value="">Keine Regel merken</option>
                        <option value="absender">Regel: {adresse(mail.von)}</option>
                        <option value="domain">Regel: alles von @{domainVon(mail.von)}</option>
                      </select>
                      <div className="flex gap-2 w-full sm:w-auto mt-2 sm:mt-0">
                        <button onClick={() => ignorieren(mail.id)} className="btn-ghost !px-2 flex-1 sm:flex-none text-panel-muted hover:text-panel-red" title="Ignorieren">
                          <XCircle size={18} />
                        </button>
                        <button onClick={() => zuordnen(mail.id)} className="btn !py-1.5 !px-3 flex-1 sm:flex-none flex items-center justify-center gap-1">
                          Verschieben <ArrowRight size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL: Themen-Ordner aufnehmen */}
      {katalogModal.offen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={katalogSpeichern} className="card w-full max-w-md space-y-4 shadow-2xl">
            <h2 className="text-xl font-semibold">Themen-Ordner aufnehmen</h2>
            <p className="text-xs text-panel-muted">
              Existiert der Ordner im Postfach noch nicht, legt das Panel ihn an. Steht in den
              Einstellungen ein Sammelordner, entsteht er darunter.
            </p>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Ordnername</span>
              <input
                type="text" required autoFocus
                value={katalogModal.ordner}
                onChange={e => setKatalogModal(p => ({ ...p, ordner: e.target.value }))}
                className="w-full font-mono"
                placeholder="z.B. Games"
              />
              <span className="text-[11px] text-panel-muted">
                2–40 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, - und _
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Beschreibung für die KI</span>
              <input
                type="text"
                value={katalogModal.beschreibung}
                onChange={e => setKatalogModal(p => ({ ...p, beschreibung: e.target.value }))}
                className="w-full"
                placeholder="Spiele, Steam, Konsolen, Gaming-Newsletter"
              />
            </label>

            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setKatalogModal({ offen: false, ordner: '', beschreibung: '' })} className="btn-ghost flex-1">Abbrechen</button>
              <button type="submit" className="btn flex-1">Anlegen</button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL */}
      {regelModal.offen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={regelSpeichern} className="card w-full max-w-md space-y-4 shadow-2xl">
            <h2 className="text-xl font-semibold">Neue Sortier-Regel</h2>
            
            <label className="block space-y-1">
              <span className="text-sm font-medium">Bedingungstyp</span>
              <select
                value={regelModal.typ}
                onChange={e => setRegelModal(p => ({ ...p, typ: e.target.value }))}
                className="w-full"
              >
                {Object.entries(REGEL_TYPEN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Muster</span>
              <input
                type="text" required
                value={regelModal.muster}
                onChange={e => setRegelModal(p => ({ ...p, muster: e.target.value }))}
                className="w-full"
                placeholder={regelModal.typ === 'domain' ? 'amazon.de' : '...'}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Zielordner (IMAP)</span>
              <input
                type="text" required
                value={regelModal.zielordner}
                onChange={e => setRegelModal(p => ({ ...p, zielordner: e.target.value }))}
                list="ordner-vorschlaege"
                className="w-full font-mono"
                placeholder="z.B. Rechnungen"
              />
            </label>

            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => setRegelModal({ offen: false })} className="btn-ghost flex-1">Abbrechen</button>
              <button type="submit" className="btn flex-1">Speichern</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
