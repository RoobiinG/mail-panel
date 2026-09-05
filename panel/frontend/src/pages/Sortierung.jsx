import React, { useState, useEffect } from 'react';
import {
  Plus, Trash2, CheckCircle2, XCircle, AlertCircle, Inbox, Tag, ArrowRight,
  FolderTree, Sparkles, Lock, Unlock, RefreshCw, Check, Wand2,
  ChevronRight, ChevronDown, Layers, AtSign, History, Undo2
} from 'lucide-react';
import { useMelden } from '../components/ui/Meldungen';
import BelegeKarte from '../components/BelegeKarte';

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

// Eine Registerkarte der Sortierung-Seite. Aktiv = hervorgehoben; die Zahl zeigt,
// wo gerade etwas wartet, damit man den Bereich nicht erst aufklappen muss.
function TabKnopf({ aktiv, onClick, icon: Icon, zahl, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
        aktiv ? 'bg-panel-accent text-white' : 'text-panel-muted hover:text-panel-text hover:bg-panel-bg/60'
      }`}
    >
      <Icon size={16} />
      {children}
      {zahl > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${aktiv ? 'bg-white/25' : 'bg-panel-border/60'}`}>
          {zahl}
        </span>
      )}
    </button>
  );
}

export default function Sortierung() {
  const { melden, nachfragen } = useMelden();
  const [konten, setKonten] = useState([]);
  const [aktivesKonto, setAktivesKonto] = useState('');
  const [tab, setTab] = useState('sortieren');
  
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
  // Aufgeklappter Vorschlag samt seiner wartenden Mails — man soll sehen, wofür
  // man da eigentlich einen Ordner anlegt.
  const [offenerVorschlag, setOffenerVorschlag] = useState(null);
  const [vorschlagMails, setVorschlagMails] = useState({});   // vorschlag_id -> Mails
  const [ordnerJeKonto, setOrdnerJeKonto] = useState({});     // konto_id -> Ordner (für die Umleitung)
  const [umleitZiel, setUmleitZiel] = useState({});           // vorschlag_id -> Zielordner
  const [mailAuswahl, setMailAuswahl] = useState({});         // vorschlag_id -> [mail_id] (leer = alle)
  const [vorschlagAuswahl, setVorschlagAuswahl] = useState([]); // Vorschläge zum Zusammenfassen
  const [sammelName, setSammelName] = useState('');            // Name des Sammelordners
  const [aufgehenZiel, setAufgehenZiel] = useState({});        // katalog_id -> Zielordner

  // Die größten Absender im Posteingang — der schnellste Weg durch einen Berg
  // von Mails, ganz ohne KI.
  const [absender, setAbsender] = useState({ absender: [], aktualisiert: null });
  const [absenderLaeuft, setAbsenderLaeuft] = useState(false);
  const [absenderZiel, setAbsenderZiel] = useState({});         // domain -> Zielordner
  const [absenderArbeit, setAbsenderArbeit] = useState('');     // domain, die gerade läuft
  const [kategorien, setKategorien] = useState(null);           // Vorschläge der KI
  const [kategorienLaeuft, setKategorienLaeuft] = useState(false);
  const [alias, setAlias] = useState([]);                     // umgeleitete Namen des aktiven Kontos
  const [katalogModal, setKatalogModal] = useState({ offen: false, ordner: '', beschreibung: '' });
  const [einleseMeldung, setEinleseMeldung] = useState('');
  const [beschreibungEntwurf, setBeschreibungEntwurf] = useState({});
  const [beschreibungLaeuft, setBeschreibungLaeuft] = useState(null);   // katalog_id

  // Sortier-Inbox nach Absender-Domain gebuendelt
  const [offeneGruppen, setOffeneGruppen] = useState({});   // domain -> aufgeklappt?
  const [gruppenOrdner, setGruppenOrdner] = useState({});   // domain -> Zielordner
  const [gruppenTyp, setGruppenTyp] = useState({});         // domain -> 'domain'|'absender'|'keine'
  const [gruppeLaeuft, setGruppeLaeuft] = useState('');

  // Einzelregeln, die sich zu einer Domain-Regel zusammenfassen lassen
  const [zusammenfassbar, setZusammenfassbar] = useState([]);

  // Was die KI zuletzt entschieden hat — und die Korrektur dazu
  const [entscheidungen, setEntscheidungen] = useState([]);
  const [korrekturOffen, setKorrekturOffen] = useState(null);   // log_id
  const [korrekturOrdner, setKorrekturOrdner] = useState('');
  const [korrekturRegel, setKorrekturRegel] = useState('domain');

  // Nur die Konten holen — alles Weitere hängt am gewählten Konto und wird vom
  // Effekt darunter geladen, sobald eines feststeht.
  const ladenInit = async () => {
    try {
      const { data } = await api.get('/konten');
      setKonten(data || []);
      if (data && data.length > 0) setAktivesKonto(data[0].id);
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
    if (!(await nachfragen({
      titel: 'Regeln zusammenfassen?', text, bestaetigen: 'Zusammenfassen',
    }))) return;
    try {
      const { data } = await api.post('/sortierung/regeln/zusammenfassen', {
        konto_id: aktivesKonto, domain: gruppe.domain, zielordner: gruppe.zielordner,
      });
      const dazu = data.nachsortiert?.verschoben
        ? ` Dabei wurden ${data.nachsortiert.verschoben} wartende Mail(s) mitsortiert.`
        : '';
      melden(`${data.ersetzt} Regeln zu einer Domain-Regel zusammengefasst.${dazu}`);
      regelnLaden(aktivesKonto);
      inboxLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Zusammenfassen', 'fehler');
    }
  };

  const katalogLaden = async (kontoId) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/katalog?konto_id=${kontoId}`);
      setKatalog(data || []);
    } catch { /* leer */ }
  };

  const entscheidungenLaden = async (kontoId) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/entscheidungen?konto_id=${kontoId}&limit=25`);
      setEntscheidungen(data || []);
    } catch { /* leer */ }
  };

  const korrigieren = async (eintrag) => {
    const ziel = korrekturOrdner.trim();
    if (!ziel) return melden('Bitte den richtigen Ordner angeben.', 'hinweis');
    try {
      const { data } = await api.post('/sortierung/korrigieren', {
        log_id: eintrag.id, zielordner: ziel, regelTyp: korrekturRegel,
      });
      const teile = [];
      teile.push(data.verschoben ? `Mail nach „${ziel}" verschoben.` : 'Mail nicht verschoben.');
      if (data.regel) {
        teile.push(`Regel [${data.regel.typ}] ${data.regel.muster} ${data.regel.aktualisiert ? 'geändert' : 'angelegt'}.`);
      }
      if (data.nachsortiert?.verschoben) teile.push(`${data.nachsortiert.verschoben} wartende Mail(s) mitsortiert.`);
      if (data.hinweis) teile.push(data.hinweis);
      melden(teile.join('\n'));
      setKorrekturOffen(null);
      setKorrekturOrdner('');
      entscheidungenLaden(aktivesKonto);
      regelnLaden(aktivesKonto);
      inboxLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler bei der Korrektur', 'fehler');
    }
  };

  // Alles auf dieser Seite gehört zu genau einem Postfach — Vorschläge,
  // wartende Mails, Regeln, Ordner. Ohne das Konto in der Abfrage stand hier
  // alles durcheinander: Vorschläge aus Konto B neben den Ordnern aus Konto A.
  const vorschlaegeLaden = async (kontoId = aktivesKonto) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/vorschlaege?konto_id=${kontoId}`);
      setVorschlaege(data || []);
    } catch { /* leer */ }
  };

  // Ein Postfach, ein Satz Daten. Beim Wechsel wird alles neu geladen — sonst
  // stünden Vorschläge, wartende Mails und Ordner aus verschiedenen Konten
  // nebeneinander, und man ordnet eine Mail in einen Ordner ein, den es in ihrem
  // Postfach gar nicht gibt.
  useEffect(() => {
    if (!aktivesKonto) return;
    setInbox([]); setVorschlaege([]); setKatalog([]); setRegeln([]);
    setOffenerVorschlag(null); setVorschlagMails({}); setMailAuswahl({});
    setAbsender({ absender: [], aktualisiert: null }); setKategorien(null);
    regelnLaden(aktivesKonto);
    katalogLaden(aktivesKonto);
    entscheidungenLaden(aktivesKonto);
    aliasLaden(aktivesKonto);
    vorschlaegeLaden(aktivesKonto);
    inboxLaden(aktivesKonto);
    absenderLaden(aktivesKonto);
  }, [aktivesKonto]);

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
      melden(err.response?.data?.error || 'Fehler beim Speichern', 'fehler');
    }
  };

  const katalogAendern = async (id, felder) => {
    try {
      await api.put(`/sortierung/katalog/${id}`, felder);
      katalogLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Ändern', 'fehler');
    }
  };

  // Die KI aus den bisherigen Absendern eine Beschreibung formulieren lassen.
  // Der Text landet nur im Feld — speichern tut ihn erst der Nutzer, indem er
  // das Feld verlässt. So bleibt die Entscheidung bei ihm.
  const beschreibungVorschlagen = async (o) => {
    setBeschreibungLaeuft(o.id);
    try {
      const { data } = await api.post(`/sortierung/katalog/${o.id}/beschreibung-vorschlagen`);
      setBeschreibungEntwurf(p => ({ ...p, [o.id]: data.beschreibung }));
      melden(`Vorschlag aus ${data.absender} Absender(n). Zum Übernehmen ins Feld klicken und `
        + 'wieder herausklicken — dann wird gespeichert.');
    } catch (err) {
      melden(err.response?.data?.error || 'Vorschlag fehlgeschlagen', 'fehler');
    } finally {
      setBeschreibungLaeuft(null);
    }
  };

  const gelerntLeeren = async (o) => {
    if (!(await nachfragen({
      titel: 'Gelerntes vergessen?',
      text: `Die Absender, die die KI dem Ordner „${o.ordner}" zugeordnet hat, werden entfernt:\n\n`
        + `${o.gelernt}\n\nDeine eigene Beschreibung bleibt unangetastet.`,
      bestaetigen: 'Vergessen',
    }))) return;
    try {
      await api.delete(`/sortierung/katalog/${o.id}/gelernt`);
      katalogLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Vergessen', 'fehler');
    }
  };

  const katalogEntfernen = async (id) => {
    if (!(await nachfragen({
      titel: 'Aus dem Katalog nehmen?',
      text: 'Der Ordner im Postfach bleibt bestehen — es wird nichts verschoben oder gelöscht.',
      bestaetigen: 'Entfernen', gefaehrlich: true,
    }))) return;
    try {
      await api.delete(`/sortierung/katalog/${id}`);
      katalogLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Entfernen', 'fehler');
    }
  };

  const ordnerEinlesen = async () => {
    setEinleseMeldung('Lese …');
    try {
      const { data } = await api.post('/sortierung/katalog/einlesen', { konto_id: aktivesKonto });
      const abo = data.abonniert?.length
        ? ` ${data.abonniert.length} eigene(r) Ordner im Postfach sichtbar gemacht.`
        : '';
      setEinleseMeldung(
        (data.neu?.length ? `${data.neu.length} Ordner übernommen.` : 'Keine neuen Ordner gefunden.') + abo,
      );
      katalogLaden(aktivesKonto);
      setTimeout(() => setEinleseMeldung(''), 8000);
    } catch (err) {
      setEinleseMeldung(err.response?.data?.error || 'Fehler beim Einlesen');
    }
  };

  // Die Stichworte aus den Beschreibungen auf das anwenden, was schon wartet.
  // Erst zählen, dann fragen, dann verschieben — niemand soll überrascht werden.
  const stichworteAnwenden = async () => {
    if (!aktivesKonto) return;
    try {
      const { data: v } = await api.post('/sortierung/stichworte-anwenden', {
        konto_id: aktivesKonto, vorschau: true,
      });
      if (!v.treffer) {
        melden(`Keine der ${v.gesamt} wartenden Mails passt auf ein Stichwort.`);
        return;
      }
      if (!(await nachfragen({
        titel: 'Stichworte anwenden?',
        text: `${v.treffer} von ${v.gesamt} wartenden Mails passen auf ein Stichwort aus einer `
          + `Ordner-Beschreibung.\n\nZiele: ${v.ordner.join(', ')}\n\n`
          + 'Die Mails werden dorthin verschoben.',
        bestaetigen: 'Verschieben',
      }))) return;
      const { data } = await api.post('/sortierung/stichworte-anwenden', { konto_id: aktivesKonto });
      melden(`${data.verschoben} Mail(s) nach Stichwort einsortiert.`
        + (data.fehler?.length ? ` ${data.fehler.length} Fehler — siehe Logs.` : ''));
      inboxLaden();
      katalogLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Anwenden', 'fehler');
    }
  };

  // ─── ORDNER-VORSCHLÄGE ──────────────────────────────────────────────────────

  const vorschlagFreigeben = async (v) => {
    try {
      const { data } = await api.post(`/sortierung/vorschlaege/${v.id}/freigeben`);
      // Auf das Postfach umschalten, zu dem der Vorschlag gehörte — sonst legt
      // man einen Ordner in „Kontakt-E-Mail" an, sieht danach den Katalog von
      // „g.robin.2002" und wundert sich, wo der Ordner geblieben ist.
      if (v.konto_id && v.konto_id !== aktivesKonto) setAktivesKonto(v.konto_id);
      else katalogLaden(aktivesKonto);
      vorschlaegeLaden(); inboxLaden();
      melden(`Ordner "${data.ordner}" in ${v.konto_name || 'dem Postfach'} angelegt.`
        + (data.wartend
          ? ` ${data.verschoben} von ${data.wartend} wartenden Mails einsortiert.`
          : ' Es wartete keine Mail darauf.'));
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Freigeben', 'fehler');
    }
  };

  const vorschlagAblehnen = async (id) => {
    try {
      await api.post(`/sortierung/vorschlaege/${id}/ablehnen`);
      vorschlaegeLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Ablehnen', 'fehler');
    }
  };

  const aliasLaden = async (kontoId) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/alias?konto_id=${kontoId}`);
      setAlias(data || []);
    } catch { /* leer */ }
  };

  // Einen Vorschlag aufklappen: Welche Mails haben ihn ausgelöst? Dazu die Ordner
  // des betroffenen Kontos, damit man die Mails auch woanders hinschieben kann,
  // ohne erst das Konto zu wechseln.
  const mailsLaden = async (vid) => {
    try {
      const { data } = await api.get(`/sortierung/vorschlaege/${vid}/mails`);
      setVorschlagMails(m => ({ ...m, [vid]: data.mails || [] }));
    } catch {
      setVorschlagMails(m => ({ ...m, [vid]: [] }));
    }
  };

  const vorschlagOeffnen = async (v) => {
    if (offenerVorschlag === v.id) { setOffenerVorschlag(null); return; }
    setOffenerVorschlag(v.id);
    if (!vorschlagMails[v.id]) await mailsLaden(v.id);
    if (v.konto_id && !ordnerJeKonto[v.konto_id]) {
      // Was es im Postfach wirklich gibt — nicht nur, was im Themen-Katalog
      // steht. Der Katalog kommt als Rückfall dazu, falls das Postfach gerade
      // nicht erreichbar ist.
      const [postfach, katalogDaten] = await Promise.all([
        api.get(`/sortierung/postfach-ordner?konto_id=${v.konto_id}`).then(r => r.data).catch(() => []),
        api.get(`/sortierung/katalog?konto_id=${v.konto_id}`).then(r => r.data).catch(() => []),
      ]);
      const namen = Array.from(new Set([
        ...(postfach || []),
        ...(katalogDaten || []).filter(k => !k.gesperrt).map(k => k.ordner),
      ])).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
      setOrdnerJeKonto(o => ({ ...o, [v.konto_id]: namen }));
    }
  };

  // Welche Mails eines Vorschlags sind angehakt? Leer = alle.
  const angehakt = (vid) => mailAuswahl[vid] || [];
  const mailUmschalten = (vid, mailId) => setMailAuswahl(a => {
    const jetzt = a[vid] || [];
    return { ...a, [vid]: jetzt.includes(mailId) ? jetzt.filter(x => x !== mailId) : [...jetzt, mailId] };
  });
  const alleUmschalten = (vid, mails) => setMailAuswahl(a => {
    const jetzt = a[vid] || [];
    return { ...a, [vid]: jetzt.length === mails.length ? [] : mails.map(m => m.id) };
  });

  const vorschlagUmleiten = async (v) => {
    const ziel = umleitZiel[v.id];
    if (!ziel) return;
    const auswahl = angehakt(v.id);
    const einzeln = auswahl.length > 0;
    if (!(await nachfragen({
      titel: einzeln ? `${auswahl.length} Mail(s) verschieben?` : 'Alle Mails dorthin verschieben?',
      text: einzeln
        ? `Die ${auswahl.length} angehakten Mails wandern nach "${ziel}".\n\n`
          + `Der Vorschlag "${v.ordner}" bleibt offen — für die übrigen Mails kannst du dich `
          + 'später anders entscheiden.'
        : `Alle wartenden Mails wandern nach "${ziel}" — es entsteht kein neuer Ordner.\n\n`
          + `Schlägt die KI "${v.ordner}" wieder vor, landet die Mail künftig direkt in "${ziel}". `
          + 'Diese Umleitung steht danach unter den Themen-Ordnern und lässt sich dort wieder lösen.',
      bestaetigen: 'Verschieben',
    }))) return;
    try {
      const { data } = await api.post(`/sortierung/vorschlaege/${v.id}/umleiten`, {
        ordner: ziel, mail_ids: einzeln ? auswahl : undefined,
      });
      melden(`${data.verschoben} Mail(s) nach "${data.ordner}" verschoben.`
        + (data.umgeleitet ? ` "${v.ordner}" zeigt künftig dorthin.` : ' Der Vorschlag bleibt offen.'));
      setMailAuswahl(a => ({ ...a, [v.id]: [] }));
      if (data.umgeleitet) setOffenerVorschlag(null);
      else mailsLaden(v.id);   // die verschobenen fallen aus der Liste
      vorschlaegeLaden(); katalogLaden(aktivesKonto); inboxLaden(); aliasLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Verschieben fehlgeschlagen', 'fehler');
    }
  };

  // Mehrere Vorschläge, eine Kategorie: „Plesk", „MC-HOST24" und „Fritzbox"
  // sind dreimal dasselbe. Hier werden sie zu einem Ordner — und jeder Name zur
  // Umleitung, damit sie nie wieder einzeln aufschlagen.
  const vorschlagAuswahlUmschalten = (id) => setVorschlagAuswahl(a =>
    (a.includes(id) ? a.filter(x => x !== id) : [...a, id]));

  const vorschlaegeZusammenfassen = async () => {
    const gewaehlt = vorschlaege.filter(v => vorschlagAuswahl.includes(v.id));
    const ziel = (sammelName || gewaehlt[0]?.ordner || '').trim();
    if (!ziel || gewaehlt.length === 0) return;
    const wartend = gewaehlt.reduce((s, v) => s + (v.wartend || 0), 0);
    if (!(await nachfragen({
      titel: `${gewaehlt.length} Vorschläge zu „${ziel}" zusammenfassen?`,
      text: `${gewaehlt.map(v => `• ${v.ordner}`).join('\n')}\n\n`
        + `Es entsteht ein Ordner „${ziel}"${wartend ? `, die ${wartend} wartenden Mails wandern hinein` : ''}. `
        + 'Jeder dieser Namen wird zur Umleitung: Schlägt die KI ihn wieder vor, landet die Mail '
        + 'künftig ohne Nachfrage dort.',
      bestaetigen: 'Zusammenfassen',
    }))) return;
    try {
      const { data } = await api.post('/sortierung/vorschlaege/zusammenfassen', {
        ordner: ziel, vorschlag_ids: vorschlagAuswahl,
      });
      melden(`${data.zusammengefasst} Vorschläge zu „${data.ordner}" zusammengefasst, `
        + `${data.verschoben} von ${data.wartend} Mail(s) verschoben.`);
      setVorschlagAuswahl([]); setSammelName('');
      vorschlaegeLaden(); katalogLaden(aktivesKonto); inboxLaden(); aliasLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Zusammenfassen fehlgeschlagen', 'fehler');
    }
  };

  // Einen vorhandenen Ordner in einem anderen aufgehen lassen. Hier bewegen sich
  // echte Mails — deshalb erst zählen, dann fragen, dann verschieben.
  const ordnerAufgehenLassen = async (o) => {
    const ziel = (aufgehenZiel[o.id] || '').trim();
    if (!ziel) return;
    try {
      const { data: v } = await api.post(`/sortierung/katalog/${o.id}/aufgehen-in`, { ziel, vorschau: true });
      if (!(await nachfragen({
        titel: `„${o.ordner}" in „${ziel}" aufgehen lassen?`,
        text: `Alle ${v.anzahl} Mail(s) aus „${o.ordner}" wandern nach „${ziel}".\n\n`
          + `Danach ist „${o.ordner}" kein Themen-Ordner mehr, und der Name zeigt als Umleitung `
          + `auf „${ziel}". Der leere Ordner bleibt im Postfach stehen — löschen kannst nur du.`,
        bestaetigen: 'Verschieben',
      }))) return;
      const { data } = await api.post(`/sortierung/katalog/${o.id}/aufgehen-in`, { ziel });
      melden(`${data.verschoben} von ${data.gesamt} Mail(s) nach „${data.ziel}" verschoben. `
        + `„${data.ordner}" zeigt jetzt dorthin.`);
      setAufgehenZiel(z => ({ ...z, [o.id]: '' }));
      katalogLaden(aktivesKonto); aliasLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Zusammenlegen fehlgeschlagen', 'fehler');
    }
  };

  // ─── ABSENDER ────────────────────────────────────────────────────────────────

  const absenderLaden = async (kontoId = aktivesKonto) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/absender?konto_id=${kontoId}`);
      setAbsender(data || { absender: [], aktualisiert: null });
    } catch { /* leer */ }
  };

  const absenderZaehlen = async () => {
    setAbsenderLaeuft(true);
    try {
      const { data } = await api.post('/sortierung/absender-zaehlen', { konto_id: aktivesKonto });
      melden(`${data.gesamt} Mails gezählt, ${data.absender} verschiedene Absender.`
        + (data.ohneAbsender ? ` ${data.ohneAbsender} ohne lesbaren Absender.` : ''));
      absenderLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Zählen fehlgeschlagen', 'fehler');
    } finally {
      setAbsenderLaeuft(false);
    }
  };

  const absenderEinsortieren = async (a) => {
    const ziel = (absenderZiel[a.domain] || '').trim();
    if (!ziel) return;
    if (!(await nachfragen({
      titel: `Alles von @${a.domain} nach „${ziel}"?`,
      text: `${a.anzahl} Mail(s) aus dem Posteingang wandern nach „${ziel}".\n\n`
        + 'Dazu entsteht eine Regel: Künftige Mails dieses Absenders gehen ohne Umweg dorthin — '
        + 'und ohne eine einzige KI-Abfrage.',
      bestaetigen: 'Verschieben',
    }))) return;
    setAbsenderArbeit(a.domain);
    try {
      const { data } = await api.post('/sortierung/absender/einsortieren', {
        konto_id: aktivesKonto, domain: a.domain, zielordner: ziel,
      });
      melden(`${data.verschoben} von ${data.gefunden} Mail(s) nach „${data.ziel}" verschoben. `
        + `Regel für @${data.domain} angelegt.`);
      absenderLaden(); regelnLaden(aktivesKonto); katalogLaden(aktivesKonto); inboxLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Einsortieren fehlgeschlagen', 'fehler');
    } finally {
      setAbsenderArbeit('');
    }
  };

  const kategorienHolen = async () => {
    setKategorienLaeuft(true);
    try {
      const { data } = await api.post('/sortierung/absender/kategorien', { konto_id: aktivesKonto });
      setKategorien(data.gruppen || []);
      if (!data.gruppen?.length) melden('Die KI hat keine Gruppen gefunden.', 'hinweis');
    } catch (err) {
      melden(err.response?.data?.error || 'Gruppieren fehlgeschlagen', 'fehler');
    } finally {
      setKategorienLaeuft(false);
    }
  };

  const kategorieAnwenden = async (g) => {
    if (!(await nachfragen({
      titel: `Kategorie „${g.ordner}" anlegen?`,
      text: `${g.absender.map(d => `• ${d}`).join('\n')}\n\n`
        + `${g.mails} Mail(s) wandern nach „${g.ordner}", und für jeden dieser Absender entsteht `
        + 'eine Regel. Künftige Mails gehen dann ohne KI dorthin.',
      bestaetigen: 'Anlegen & verschieben',
    }))) return;
    setAbsenderArbeit(g.ordner);
    try {
      const { data } = await api.post('/sortierung/absender/kategorie-anwenden', {
        konto_id: aktivesKonto, ordner: g.ordner, absender: g.absender,
      });
      melden(`„${data.ordner}": ${data.regeln} Regeln angelegt, `
        + `${data.verschoben} von ${data.gefunden} Mail(s) verschoben.`);
      setKategorien(k => (k || []).filter(x => x.ordner !== g.ordner));
      absenderLaden(); regelnLaden(aktivesKonto); katalogLaden(aktivesKonto); inboxLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Anwenden fehlgeschlagen', 'fehler');
    } finally {
      setAbsenderArbeit('');
    }
  };

  const aliasLoesen = async (a) => {
    if (!(await nachfragen({
      titel: 'Umleitung lösen?',
      text: `"${a.alias}" zeigt dann nicht mehr auf "${a.ordner}". `
        + 'Schlägt die KI den Namen wieder vor, fragt das Panel wieder nach.',
      bestaetigen: 'Lösen',
    }))) return;
    try {
      await api.delete(`/sortierung/alias/${a.id}`);
      aliasLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Lösen', 'fehler');
    }
  };

  const inboxLaden = async (kontoId = aktivesKonto) => {
    if (!kontoId) return;
    try {
      const { data } = await api.get(`/sortierung/inbox?konto_id=${kontoId}`);
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
        aktion: regelModal.behalten ? 'behalten' : 'verschieben',
      });
      setRegelModal({ offen: false, typ: 'absender', muster: '', zielordner: '', behalten: false });
      regelnLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Speichern', 'fehler');
    }
  };

  // "In Ruhe lassen": eine Regel, die nichts verschiebt. Die Mails bleiben im
  // Posteingang und werden nicht mehr zur Zuordnung vorgelegt — für alles, was
  // man weder sortiert noch ständig wiedersehen möchte.
  const inRuheLassen = async (gruppe) => {
    const wahl = gruppenTyp[gruppe.domain] || (gruppe.absender.size > 1 ? 'domain' : 'absender');
    const typ = wahl === 'absender' ? 'absender' : 'domain';
    const muster = typ === 'domain' ? gruppe.domain : adresse(gruppe.mails[0].von);
    const kontoId = gruppe.mails[0]?.konto_id;
    if (!kontoId) return melden('Zu diesen Mails ist kein Konto hinterlegt.', 'hinweis');
    if (!(await nachfragen({
      titel: 'In Ruhe lassen?',
      text: `Mails von ${typ === 'domain' ? '@' + gruppe.domain : muster} werden künftig nicht mehr `
        + 'verschoben und nicht mehr zur Zuordnung vorgelegt. Sie bleiben einfach im Posteingang liegen.',
      bestaetigen: 'In Ruhe lassen',
    }))) return;
    setGruppeLaeuft(gruppe.domain);
    try {
      const { data } = await api.post('/sortierung/regeln', {
        konto_id: kontoId, typ, muster, aktion: 'behalten',
      });
      melden(`Regel angelegt — ${data.beruhigt || 0} wartende Mail(s) aus der Liste genommen.`);
      inboxLaden();
      regelnLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Anlegen', 'fehler');
    } finally {
      setGruppeLaeuft('');
    }
  };

  const regelLoeschen = async (id) => {
    if (!(await nachfragen({
      titel: 'Regel löschen?',
      text: 'Künftige Mails werden dann wieder von der KI einsortiert.',
      bestaetigen: 'Löschen', gefaehrlich: true,
    }))) return;
    try {
      await api.delete(`/sortierung/regeln/${id}`);
      regelnLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Löschen', 'fehler');
    }
  };

  // ─── INBOX ───────────────────────────────────────────────────────────────────

  const zuordnen = async (mailId) => {
    const zielordner = ordnerWahl[mailId];
    if (!zielordner) return melden('Bitte einen Zielordner angeben.', 'hinweis');
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
      melden(err.response?.data?.error || 'Fehler beim Zuordnen', 'fehler');
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
    if (!zielordner) return melden('Bitte einen Zielordner angeben.', 'hinweis');
    const kontoId = gruppe.mails[0]?.konto_id;
    if (!kontoId) return melden('Zu diesen Mails ist kein Konto hinterlegt.', 'hinweis');

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
      // Eine nackte Fehlerzahl hilft niemandem weiter — sie sagt nicht, was zu
      // tun ist. Veraltete Eintraege sind ausserdem gar kein Fehler: Die Mail
      // wurde vorher schon einsortiert, der Eintrag war nur noch ein Rest.
      const teile = [`${data.verschoben} von ${data.treffer} Mail(s) nach „${zielordner}" verschoben.`];
      if (data.veraltet) {
        teile.push(`${data.veraltet} Eintrag/Einträge lagen nicht mehr im Posteingang `
          + '(vorher schon einsortiert) und wurden aus der Liste entfernt.');
      }
      if (data.fehler?.length) {
        const liste = data.fehler.slice(0, 5).map(f => `• ${f}`).join('\n');
        const rest = data.fehler.length > 5 ? `\n… und ${data.fehler.length - 5} weitere` : '';
        teile.push(`Nicht verschoben:\n${liste}${rest}`);
      }
      melden(teile.join('\n\n'));
      inboxLaden();
      regelnLaden(aktivesKonto);
      katalogLaden(aktivesKonto);
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Sortieren', 'fehler');
    } finally {
      setGruppeLaeuft('');
    }
  };

  const ignorieren = async (mailId) => {
    try {
      await api.post('/sortierung/ignorieren', { id: mailId });
      inboxLaden();
    } catch (err) {
      melden(err.response?.data?.error || 'Fehler beim Ignorieren', 'fehler');
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
      {/* ══ Registerkarten und Postfach-Auswahl ══
          Die Auswahl steht hier oben, weil sie für die ganze Seite gilt: Regeln,
          wartende Mails, Vorschläge und Ordner gehören immer zu genau einem
          Postfach. Vorher stand sie in zwei Karten verstreut, und die Vorschläge
          zeigten alle Konten gemischt — mit den Ordnern des gerade gewählten. */}
      <div className="card !p-2 flex flex-wrap items-center gap-1">
        <TabKnopf aktiv={tab === 'sortieren'} onClick={() => setTab('sortieren')} icon={Inbox} zahl={gefilterteInbox.length}>
          Sortieren
        </TabKnopf>
        <TabKnopf aktiv={tab === 'vorschlaege'} onClick={() => setTab('vorschlaege')} icon={Sparkles} zahl={vorschlaege.length}>
          Vorschläge
        </TabKnopf>
        <TabKnopf aktiv={tab === 'absender'} onClick={() => setTab('absender')} icon={AtSign}
          zahl={absender.absender.length}>
          Absender
        </TabKnopf>
        <TabKnopf aktiv={tab === 'themen'} onClick={() => setTab('themen')} icon={FolderTree} zahl={katalog.length}>
          Themen-Ordner
        </TabKnopf>
        <TabKnopf aktiv={tab === 'belege'} onClick={() => setTab('belege')} icon={Layers}>
          Belege
        </TabKnopf>

        <div className="ml-auto flex items-center gap-2 pr-1">
          <span className="text-xs text-panel-muted hidden sm:inline">Postfach</span>
          <select
            value={aktivesKonto}
            onChange={e => setAktivesKonto(Number(e.target.value))}
            className="text-sm bg-panel-bg rounded px-2 py-1.5 border border-panel-border"
            title="Alles auf dieser Seite gilt für dieses Postfach"
          >
            {konten.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </div>
      </div>

      {/* ══ Belege automatisch in Nextcloud ablegen ══ */}
      {tab === 'belege' && <BelegeKarte />}

      {/* ══ Die größten Absender — Aufräumen ohne KI ══ */}
      {tab === 'absender' && (
        <div className="space-y-6">
          <div className="card !p-0 overflow-hidden">
            <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-3 justify-between items-center">
              <h2 className="font-medium flex items-center gap-2">
                <AtSign size={18} className="text-panel-accent" /> Größte Absender im Posteingang
              </h2>
              <div className="flex items-center gap-2">
                {absender.aktualisiert && (
                  <span className="text-xs text-panel-muted">
                    gezählt am {new Date(absender.aktualisiert.replace(' ', 'T') + 'Z')
                      .toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                )}
                <button onClick={absenderZaehlen} disabled={absenderLaeuft || !aktivesKonto}
                  className="btn-ghost !py-1.5 !px-3 text-sm flex items-center gap-1">
                  <RefreshCw size={14} className={absenderLaeuft ? 'animate-spin' : ''} />
                  {absenderLaeuft ? 'Zähle …' : 'Posteingang zählen'}
                </button>
                {absender.absender.length > 0 && (
                  <button onClick={kategorienHolen} disabled={kategorienLaeuft}
                    className="btn !py-1.5 !px-3 text-sm flex items-center gap-1">
                    <Sparkles size={14} className={kategorienLaeuft ? 'animate-pulse' : ''} />
                    Kategorien vorschlagen
                  </button>
                )}
              </div>
            </div>

            <p className="px-4 pt-3 text-xs text-panel-muted">
              Bei einem großen Posteingang ist die KI das falsche Werkzeug: Sie schafft ein paar
              hundert Mails am Tag. Eine Regel für den größten Absender räumt Tausende ab —
              <span className="text-panel-text"> sofort und ohne KI-Budget</span>. Das Zählen liest
              nur die Absender, keine Inhalte, und dauert bei vielen Mails eine Weile.
            </p>

            {absender.absender.length === 0 ? (
              <p className="p-6 text-center text-panel-muted text-sm">
                Noch nichts gezählt. <span className="text-panel-text">Posteingang zählen</span> sagt
                dir, wer die Masse schickt.
              </p>
            ) : (
              <div className="overflow-auto max-h-[520px] mt-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                      <th className="py-2 px-4">Absender-Domain</th>
                      <th className="py-2 px-4 text-right">Mails</th>
                      <th className="py-2 px-4">Einsortieren nach</th>
                      <th className="py-2 px-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {absender.absender.map(a => (
                      <tr key={a.domain} className="border-b border-panel-border/50 hover:bg-panel-bg/30">
                        <td className="py-2 px-4 font-mono text-panel-accent whitespace-nowrap">
                          @{a.domain}
                          {a.adressen > 1 && (
                            <span className="ml-2 text-[10px] text-panel-muted font-sans">
                              {a.adressen} Adressen
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-4 text-right font-medium whitespace-nowrap">{a.anzahl}</td>
                        <td className="py-2 px-4">
                          {a.regel ? (
                            <span className="text-xs text-panel-muted">
                              Regel vorhanden → <span className="font-mono">{a.regel}</span>
                            </span>
                          ) : (
                            <input
                              type="text"
                              value={absenderZiel[a.domain] || ''}
                              onChange={e => setAbsenderZiel(z => ({ ...z, [a.domain]: e.target.value }))}
                              list="ordner-vorschlaege"
                              placeholder="Ordner …"
                              className="w-full bg-transparent text-sm border-b border-transparent hover:border-panel-border focus:border-panel-accent focus:outline-none"
                            />
                          )}
                        </td>
                        <td className="py-2 px-4 text-right whitespace-nowrap">
                          {!a.regel && absenderZiel[a.domain] && (
                            <button onClick={() => absenderEinsortieren(a)}
                              disabled={absenderArbeit === a.domain}
                              className="btn !py-1 !px-3 text-xs flex items-center gap-1 ml-auto">
                              <ArrowRight size={13} />
                              {absenderArbeit === a.domain ? 'läuft …' : `${a.anzahl} verschieben`}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Was die KI aus der Liste macht — Kategorien statt einzelner Marken */}
          {kategorien && kategorien.length > 0 && (
            <div className="card !p-0 overflow-hidden">
              <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
                <Layers size={18} className="text-panel-accent" />
                <h2 className="font-medium">Vorgeschlagene Kategorien</h2>
                <span className="text-[11px] text-panel-muted hidden sm:inline">
                  aus einer einzigen KI-Abfrage über die Absenderliste — ohne Mailinhalte
                </span>
              </div>
              <div className="divide-y divide-panel-border">
                {kategorien.map(g => (
                  <div key={g.ordner} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-panel-accent">{g.ordner}</span>
                        {g.vorhanden && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-panel-border/50">gibt es schon</span>
                        )}
                        <span className="text-xs text-panel-muted">
                          {g.absender.length} Absender · {g.mails} Mails
                        </span>
                      </div>
                      <div className="text-xs text-panel-muted mt-1 font-mono truncate"
                        title={g.absender.join(', ')}>
                        {g.absender.join(', ')}
                      </div>
                    </div>
                    <button onClick={() => kategorieAnwenden(g)} disabled={absenderArbeit === g.ordner}
                      className="btn !py-1.5 !px-3 text-sm flex items-center gap-1 shrink-0">
                      <Check size={14} />
                      {absenderArbeit === g.ordner ? 'läuft …' : 'Anlegen & verschieben'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'vorschlaege' && (
        <div className="space-y-6">
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
          <div className="px-4 py-2 text-xs text-panel-muted border-b border-panel-border">
            Aufklappen zeigt die Mails, die den Vorschlag ausgelöst haben — und lässt sie
            stattdessen in einen Ordner schieben, den es schon gibt. Mehrere Vorschläge anhaken
            fasst sie zu <span className="text-panel-text">einer Kategorie</span> zusammen:
            aus „Plesk", „MC-HOST24" und „Fritzbox" wird ein Ordner „Server &amp; Hosting".
          </div>

          {/* Sammelleiste — erscheint, sobald etwas angehakt ist */}
          {vorschlagAuswahl.length > 0 && (
            <div className="px-4 py-3 border-b border-panel-border bg-panel-accent/5 flex flex-wrap items-center gap-2">
              <Layers size={16} className="text-panel-accent shrink-0" />
              <span className="text-sm">
                <span className="font-medium">{vorschlagAuswahl.length} Vorschläge</span> zusammenfassen zu
              </span>
              <input
                type="text"
                value={sammelName}
                onChange={e => setSammelName(e.target.value)}
                placeholder={vorschlaege.find(v => v.id === vorschlagAuswahl[0])?.ordner || 'Ordnername'}
                list="ordner-vorschlaege"
                className="input-field !py-1 !text-sm max-w-[220px]"
              />
              <button onClick={vorschlaegeZusammenfassen} className="btn !py-1 !px-3 text-sm flex items-center gap-1">
                <Check size={14} /> Zusammenfassen
              </button>
              <button onClick={() => { setVorschlagAuswahl([]); setSammelName(''); }}
                className="btn-ghost !py-1 !px-2 text-xs text-panel-muted">
                Auswahl aufheben
              </button>
              <span className="w-full text-[11px] text-panel-muted">
                Leer lassen nimmt den ersten angehakten Namen. Ein vorhandener Ordner wird
                genommen, ein neuer angelegt — und jeder der Namen zeigt danach dorthin.
              </span>
            </div>
          )}

          <div className="divide-y divide-panel-border">
            {vorschlaege.map(v => {
              const offen = offenerVorschlag === v.id;
              const mails = vorschlagMails[v.id];
              const ordnerListe = ordnerJeKonto[v.konto_id] || [];
              return (
              <div key={v.id} className={vorschlagAuswahl.includes(v.id) ? 'bg-panel-accent/5' : ''}>
                <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <input type="checkbox" className="mt-1 sm:mt-0 shrink-0"
                    checked={vorschlagAuswahl.includes(v.id)}
                    onChange={() => vorschlagAuswahlUmschalten(v.id)}
                    title="Zum Zusammenfassen anhaken" />
                  <button onClick={() => vorschlagOeffnen(v)}
                    className="flex-1 min-w-0 text-left flex items-start gap-2 group">
                    <span className="text-panel-muted mt-0.5 shrink-0">
                      {offen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-panel-accent group-hover:underline">{v.ordner}</span>
                        <span className="text-xs text-panel-muted">
                          {v.konto_name} · {v.anzahl}× vorgeschlagen
                          {v.wartend > 0 && ` · ${v.wartend} Mail(s) warten`}
                        </span>
                      </span>
                      {v.begruendung && (
                        <span className="block text-xs text-panel-muted truncate mt-1" title={v.begruendung}>
                          {v.begruendung}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => vorschlagAblehnen(v.id)} className="btn-ghost !py-1.5 !px-3 text-sm text-panel-muted hover:text-panel-red">
                      Ablehnen
                    </button>
                    <button onClick={() => vorschlagFreigeben(v)} className="btn !py-1.5 !px-3 text-sm flex items-center gap-1">
                      <Check size={14} /> Anlegen &amp; einsortieren
                    </button>
                  </div>
                </div>

                {offen && (
                  <div className="px-4 pb-4 pl-10 space-y-3">
                    {/* Wofür lege ich diesen Ordner eigentlich an? */}
                    {mails === undefined && <p className="text-xs text-panel-muted">Lade Mails…</p>}
                    {mails && mails.length === 0 && (
                      <p className="text-xs text-panel-muted">
                        Zurzeit wartet keine Mail mehr darauf — der Vorschlag kam von Mails, die
                        inzwischen anders einsortiert wurden.
                      </p>
                    )}
                    {mails && mails.length > 0 && (
                      <div className="border border-panel-border rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-panel-bg/50 text-panel-muted">
                            <tr>
                              <th className="px-3 py-2 w-8">
                                <input type="checkbox"
                                  checked={angehakt(v.id).length === mails.length && mails.length > 0}
                                  onChange={() => alleUmschalten(v.id, mails)}
                                  title="Alle oder keine" />
                              </th>
                              <th className="text-left px-3 py-2 font-medium">Absender</th>
                              <th className="text-left px-3 py-2 font-medium">Betreff</th>
                              <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Sicherheit</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-panel-border">
                            {mails.map(m => (
                              <tr key={m.id} className={angehakt(v.id).includes(m.id) ? 'bg-panel-accent/10' : ''}>
                                <td className="px-3 py-2">
                                  <input type="checkbox"
                                    checked={angehakt(v.id).includes(m.id)}
                                    onChange={() => mailUmschalten(v.id, m.id)} />
                                </td>
                                <td className="px-3 py-2 text-panel-muted whitespace-nowrap">{adresse(m.von)}</td>
                                <td className="px-3 py-2 truncate max-w-[380px]" title={m.betreff || ''}>
                                  {m.betreff || '(kein Betreff)'}
                                </td>
                                <td className="px-3 py-2 text-right text-panel-muted whitespace-nowrap">
                                  {m.ki_konfidenz != null ? `${Math.round(m.ki_konfidenz * 100)} %` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Kein neuer Ordner — dann eben in einen vorhandenen. */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className="text-xs text-panel-muted">
                        {angehakt(v.id).length > 0
                          ? `${angehakt(v.id).length} ausgewählt — einsortieren nach:`
                          : 'Stattdessen einsortieren nach:'}
                      </span>
                      <select
                        value={umleitZiel[v.id] || ''}
                        onChange={e => setUmleitZiel(z => ({ ...z, [v.id]: e.target.value }))}
                        className="input-field !py-1 !text-sm max-w-[240px]"
                      >
                        <option value="">Ordner wählen…</option>
                        {ordnerListe.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <button onClick={() => vorschlagUmleiten(v)} disabled={!umleitZiel[v.id]}
                        className="btn-ghost !py-1 !px-3 text-sm flex items-center gap-1 disabled:opacity-40">
                        <ArrowRight size={14} />
                        {angehakt(v.id).length > 0
                          ? `${angehakt(v.id).length} Mail(s) verschieben`
                          : 'Alle dorthin verschieben'}
                      </button>
                    </div>
                    <p className="text-[11px] text-panel-muted">
                      {angehakt(v.id).length > 0
                        ? 'Nur die angehakten Mails werden verschoben. Der Vorschlag bleibt offen — '
                          + 'für den Rest kannst du dich später anders entscheiden.'
                        : `Ohne Häkchen wandern alle wartenden Mails. Das merkt sich das Panel: Schlägt die KI
                           „${v.ordner}" wieder vor, geht die Mail künftig ohne Nachfrage in den gewählten Ordner.`}
                    </p>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ Letzte Entscheidungen — hier wird die Sortierung besser ══ */}
      {entscheidungen.length > 0 && (
        <div className="card !p-0 overflow-hidden">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex items-center gap-2">
            <History size={18} className="text-panel-accent" />
            <h2 className="font-medium">Letzte Entscheidungen</h2>
            <span className="text-[11px] text-panel-muted hidden sm:inline">
              War etwas falsch? Ein Klick verschiebt die Mail und merkt sich die Korrektur.
            </span>
          </div>
          <div className="overflow-auto max-h-[380px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-panel-border text-left text-panel-muted text-xs bg-panel-bg/30">
                  <th className="py-2 px-4">Absender</th>
                  <th className="py-2 px-4">Betreff</th>
                  <th className="py-2 px-4">Thema</th>
                  <th className="py-2 px-4">Gelandet in</th>
                  <th className="py-2 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {entscheidungen.map(e => (
                  <React.Fragment key={e.id}>
                    <tr className="border-b border-panel-border/50 hover:bg-panel-bg/30 transition-colors">
                      <td className="py-2 px-4 truncate max-w-[200px]" title={e.von}>{e.von}</td>
                      <td className="py-2 px-4 truncate max-w-[240px] text-panel-muted" title={e.betreff}>
                        {e.betreff || '(kein Betreff)'}
                      </td>
                      <td className="py-2 px-4 text-xs whitespace-nowrap">
                        {e.thema
                          ? <>{e.thema}{e.konfidenz != null && <span className="text-panel-muted"> ({Math.round(e.konfidenz * 100)} %)</span>}</>
                          : <span className="text-panel-muted">{e.kategorie || '—'}</span>}
                      </td>
                      <td className="py-2 px-4 font-mono text-panel-accent whitespace-nowrap">
                        {e.korrigiert_zu
                          ? <><span className="line-through text-panel-muted">{e.zielordner}</span> → {e.korrigiert_zu}</>
                          : e.zielordner}
                      </td>
                      <td className="py-2 px-4 text-right whitespace-nowrap">
                        {!e.korrigiert_zu && (
                          <button
                            onClick={() => {
                              setKorrekturOffen(korrekturOffen === e.id ? null : e.id);
                              setKorrekturOrdner('');
                              setKorrekturRegel('domain');
                            }}
                            className="btn-ghost !py-1 !px-2 text-xs flex items-center gap-1 ml-auto"
                            title="Diese Mail gehört woanders hin"
                          >
                            <Undo2 size={14} /> War falsch
                          </button>
                        )}
                      </td>
                    </tr>
                    {korrekturOffen === e.id && (
                      <tr className="bg-panel-bg/50">
                        <td colSpan={5} className="px-4 py-3">
                          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                            <input
                              type="text"
                              autoFocus
                              placeholder={`Richtiger Ordner statt „${e.zielordner}"`}
                              value={korrekturOrdner}
                              onChange={ev => setKorrekturOrdner(ev.target.value)}
                              list="ordner-vorschlaege"
                              className="flex-1 text-sm"
                            />
                            <select
                              value={korrekturRegel}
                              onChange={ev => setKorrekturRegel(ev.target.value)}
                              className="text-sm bg-panel-bg"
                            >
                              <option value="domain">Merken: alles von @{domainVon(e.von)}</option>
                              <option value="absender">Merken: nur {adresse(e.von)}</option>
                              <option value="keine">Nur diese Mail, nichts merken</option>
                            </select>
                            <button onClick={() => korrigieren(e)} className="btn !py-1.5 !px-3 text-sm whitespace-nowrap">
                              Verschieben &amp; merken
                            </button>
                            <button onClick={() => setKorrekturOffen(null)} className="btn-ghost !py-1.5 !px-2 text-sm">
                              Abbrechen
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </div>
      )}

      {/* ══ Themen-Katalog: woraus die KI wählen darf ══ */}
      {tab === 'themen' && (
      <div className="card !p-0 overflow-hidden">
        <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-3 justify-between items-center">
          <h2 className="font-medium flex items-center gap-2">
            <FolderTree size={18} className="text-panel-accent" /> Themen-Ordner
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {einleseMeldung && <span className="text-xs text-panel-muted">{einleseMeldung}</span>}
            <button onClick={stichworteAnwenden} disabled={!aktivesKonto}
              className="btn-ghost !py-1.5 !px-3 text-sm flex items-center gap-1"
              title="Die Stichworte aus den Beschreibungen auf die wartenden Mails anwenden">
              <Wand2 size={14} /> Stichworte anwenden
            </button>
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
        <p className="px-4 pt-2 text-xs text-panel-muted">
          Das Panel wertet die Stichworte auch selbst aus: Steht ein Absender in der Beschreibung
          — etwa „Vodafone, Sky, Telekom“ —, landet seine Mail in diesem Ordner, ganz ohne KI. Aus
          dem Betreff nur bei eindeutigen Wörtern ab fünf Zeichen. <span className="text-panel-text">Stichworte
          anwenden</span> oben wendet das auf die Mails an, die schon warten.
        </p>
        <p className="px-4 pt-2 text-xs text-panel-muted">
          <span className="text-panel-text">Neu:</span> Die KI versteht die Beschreibung als
          <em> Beispiele</em>, nicht als Liste zum Abhaken — steht „Vodafone, Sky, Netflix“ drin,
          gehört auch o2 oder Disney+ hierher. Was sie dabei erkennt, merkt sie sich unter
          „bisher hier gelandet“, und beim nächsten Mal greift schon das Stichwort. Der Zauberstab
          in der Zeile schlägt dir eine Beschreibung aus den bisherigen Absendern vor.
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
                        value={beschreibungEntwurf[o.id] ?? (o.beschreibung || '')}
                        onChange={e => setBeschreibungEntwurf(p => ({ ...p, [o.id]: e.target.value }))}
                        onBlur={() => {
                          const neu = beschreibungEntwurf[o.id];
                          if (neu !== undefined && neu !== (o.beschreibung || '')) {
                            katalogAendern(o.id, { beschreibung: neu });
                          }
                        }}
                        className="w-full bg-transparent text-sm border-b border-transparent hover:border-panel-border focus:border-panel-accent focus:outline-none"
                      />
                      {/* Zwei Ordner, dieselbe Sache: „Fritzbox-Robin" geht in
                          „Fritzbox" auf. Hier bewegen sich echte Mails, deshalb
                          steht die Zahl vorher in der Rückfrage. */}
                      <div className="mt-1 flex items-center gap-1">
                        <input
                          type="text"
                          value={aufgehenZiel[o.id] || ''}
                          onChange={e => setAufgehenZiel(z => ({ ...z, [o.id]: e.target.value }))}
                          list="ordner-vorschlaege"
                          placeholder="aufgehen lassen in …"
                          className="text-[11px] bg-transparent border-b border-transparent hover:border-panel-border focus:border-panel-accent focus:outline-none w-40"
                        />
                        {aufgehenZiel[o.id] && (
                          <button onClick={() => ordnerAufgehenLassen(o)}
                            className="text-panel-accent hover:underline text-[11px] whitespace-nowrap">
                            zusammenlegen
                          </button>
                        )}
                      </div>
                      {/* Was die KI selbst dazugelernt hat — getrennt vom eigenen
                          Text, damit der nie überschrieben wird. */}
                      {o.gelernt && (
                        <div className="mt-1 flex items-start gap-1 text-[10px] text-panel-muted/70">
                          <span className="shrink-0">bisher hier gelandet:</span>
                          <span className="font-mono">{o.gelernt}</span>
                          <button onClick={() => gelerntLeeren(o)} title="Gelerntes vergessen"
                            className="text-panel-muted/60 hover:text-panel-red shrink-0">
                            <XCircle size={11} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-4">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-panel-border/50">
                        {o.quelle === 'ki' ? 'KI' : o.quelle === 'manuell' ? 'manuell' : 'Postfach'}
                      </span>
                    </td>
                    <td className="py-2 px-4 text-center text-xs text-panel-muted">{o.treffer}</td>
                    <td className="py-2 px-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => beschreibungVorschlagen(o)}
                        disabled={beschreibungLaeuft === o.id}
                        className="btn-ghost !px-2"
                        title="Beschreibung von der KI vorschlagen lassen — aus den Absendern, die hier gelandet sind"
                      >
                        <Wand2 size={16} className={beschreibungLaeuft === o.id ? 'animate-pulse text-panel-accent' : 'text-panel-muted'} />
                      </button>
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

        {/* Umgeleitete Namen: „Gaming gehört nach Games". Entsteht, wenn man
            einen Vorschlag in einen vorhandenen Ordner schiebt. */}
        {alias.length > 0 && (
          <div className="border-t border-panel-border p-4">
            <h3 className="text-sm font-medium mb-1">Umgeleitete Namen</h3>
            <p className="text-xs text-panel-muted mb-3">
              Schlägt die KI einen dieser Namen vor, geht die Mail ohne Nachfrage in den Ordner
              dahinter. So bleibt es bei einem Ordner pro Sache.
            </p>
            <div className="flex flex-wrap gap-2">
              {alias.map(a => (
                <span key={a.id}
                  className="flex items-center gap-1.5 text-xs bg-panel-bg/60 border border-panel-border rounded-full pl-3 pr-1.5 py-1">
                  <span className="font-mono text-panel-muted">{a.alias}</span>
                  <ArrowRight size={12} className="text-panel-muted" />
                  <span className="font-mono text-panel-accent">{a.ordner}</span>
                  <button onClick={() => aliasLoesen(a)} className="text-panel-muted hover:text-panel-red px-1"
                    title="Umleitung lösen">
                    <XCircle size={13} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {tab === 'sortieren' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LINKE SEITE: Regeln */}
        <div className="card !p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-panel-border bg-panel-card/50 flex flex-wrap gap-4 justify-between items-center">
            <h2 className="font-medium flex items-center gap-2">
              <Tag size={18} className="text-panel-accent" /> Sortier-Regeln
            </h2>
            <div className="flex items-center gap-3">
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
                      <td className="py-3 px-4 font-mono">
                        {r.aktion === 'behalten'
                          ? <span className="text-panel-muted italic">bleibt im Posteingang</span>
                          : <span className="text-panel-accent">{r.zielordner}</span>}
                      </td>
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
                          className="flex-1 min-w-0 sm:min-w-[10rem] text-sm"
                        />
                        {/* Formularelemente sind global auf w-full gestellt. Nimmt
                            die Auswahl das nicht zurück, beansprucht sie die ganze
                            Zeile und quetscht das Ordner-Feld auf wenige Pixel —
                            genau das war der Fehler. Das min-w-0 oben gehört dazu:
                            flex-1 geht sonst nicht unter die Breite des Inhalts. */}
                        <select
                          value={typ}
                          onChange={e => setGruppenTyp(p => ({ ...p, [gruppe.domain]: e.target.value }))}
                          className="text-sm bg-panel-bg w-full sm:!w-auto shrink-0"
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
                        <button
                          onClick={() => inRuheLassen(gruppe)}
                          disabled={laeuft}
                          className="btn-ghost !py-1.5 !px-3 text-sm whitespace-nowrap disabled:opacity-50"
                          title="Diese Mails nie verschieben — sie bleiben im Posteingang und werden nicht mehr vorgelegt"
                        >
                          In Ruhe lassen
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
      )}

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
                2–40 Zeichen: Buchstaben, Zahlen, Leerzeichen und - _ &amp; + ( )
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

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="w-auto"
                checked={Boolean(regelModal.behalten)}
                onChange={e => setRegelModal(p => ({ ...p, behalten: e.target.checked }))}
              />
              <span>In Ruhe lassen — nicht verschieben, im Posteingang lassen</span>
            </label>

            {!regelModal.behalten && (
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
            )}

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
