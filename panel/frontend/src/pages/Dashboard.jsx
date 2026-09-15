// Das Dashboard als frei anordbares Widget-Raster.
//
// Vorher war die Seite eine feste Abfolge von Karten — und das sah man ihr an:
// Der Sortier-Rückstand stand auf halber Breite, weil daneben das KI-Budget
// gehörte; das wird bei Ollama aber gar nicht angezeigt, und übrig blieb eine
// halbe Seite Leere. Die vier Schutz-Kacheln lagen unter den Diagrammen, die
// Postfach-Auswahl mitten im Diagrammkopf. Wer das anders gewichten wollte,
// konnte nichts tun.
//
// Jetzt liegt jede Karte als Widget in einem Raster (react-grid-layout, wie im
// Überwachungs-Panel): am Kopf verschieben, an den Kanten größer ziehen,
// einzeln ausblenden und wieder hereinholen. Die Anordnung hängt am Benutzer
// und liegt im Panel (GET/PUT /api/anordnung) statt im Browser — sie
// gilt deshalb auch am nächsten Gerät.
//
// Außerhalb des Rasters bleibt nur, was keine Kachel sein darf: die Störmeldung
// der Aufsicht. Die soll immer oben stehen und sich nicht wegschieben lassen.
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import {
  AlertTriangle, Inbox, Gauge, ShieldCheck, HardDriveDownload, Target,
  CheckCircle2, Workflow, ArrowRight, Archive, Check, RefreshCw,
  ListChecks, Sparkles, Repeat, CloudUpload, PauseCircle, Activity,
  BarChart3, PieChart as PieSymbol,
} from 'lucide-react';
import api from '../api';
import { useMelden } from '../components/ui/Meldungen';
import { Widget, WidgetLeiste, WidgetRaster, useAnordnung } from '../components/ui/Widgets';
import { FARBEN, TOOLTIP_STIL } from '../components/ui/diagramm';

// Farben aus der gemeinsamen Diagramm-Einstellung. Vorher standen hier eigene
// Hex-Werte, und dieselbe Sache hatte je nach Seite eine andere Farbe: Spam war
// hier bernsteinfarben und in der Statistik rot.
const COLORS = {
  Clean: FARBEN.gruen,
  Spam: FARBEN.orange,
  Phishing: FARBEN.rot,
  Viren: FARBEN.lila,
  Newsletter: FARBEN.akzent,
};

// ─── Der Widget-Katalog ──────────────────────────────────────────────────────
//
// Eine Stelle, die sagt, welche Widgets es gibt, wie sie heißen und wo sie ab
// Werk liegen. Die Standard-Anordnung ist so gewählt, dass keine Reihe halb
// leer bleibt: „Zu tun" oben links neben Betrieb und Belegen, darunter die
// Zustandskacheln über die volle Breite, dann Rückstand und Budget
// nebeneinander, die Diagramme zum Schluss.
//
// Höhe in Rasterzeilen: 30 px je Zeile plus 14 px Abstand, eine Zeile ist also
// 44 px — h: 9 sind rund 380 px.
const KATALOG = {
  zutun:      { titel: 'Zu tun',                          icon: ListChecks,  standard: { x: 0, y: 0,  w: 8,  h: 9,  minW: 4, minH: 3 } },
  betrieb:    { titel: 'Betrieb',                         icon: Activity,    standard: { x: 8, y: 0,  w: 4,  h: 4,  minW: 3, minH: 3 } },
  belege:     { titel: 'Belege in Nextcloud',             icon: Archive,     standard: { x: 8, y: 4,  w: 4,  h: 5,  minW: 3, minH: 3 } },
  zustand:    { titel: 'Zustand',                         icon: Gauge,       standard: { x: 0, y: 9,  w: 12, h: 5,  minW: 3, minH: 3 } },
  rueckstand: { titel: 'Sortier-Rückstand & Posteingang', icon: Inbox,       standard: { x: 0, y: 14, w: 7,  h: 9,  minW: 4, minH: 4 } },
  budget:     { titel: 'KI-Tagesbudget',                  icon: Gauge,       standard: { x: 7, y: 14, w: 5,  h: 9,  minW: 3, minH: 4 } },
  schutz:     { titel: 'Schutzwirkung (30 Tage)',         icon: ShieldCheck, standard: { x: 0, y: 23, w: 12, h: 4,  minW: 3, minH: 3 } },
  verlauf:    { titel: 'Tagesverlauf (30 Tage)',          icon: BarChart3,   standard: { x: 0, y: 27, w: 8,  h: 10, minW: 4, minH: 5 } },
  verteilung: { titel: 'Verteilung',                      icon: PieSymbol,   standard: { x: 8, y: 27, w: 4,  h: 10, minW: 3, minH: 5 } },
};

// ─── Bausteine ───────────────────────────────────────────────────────────────

// Etwas Luft unter dem, was Google zuletzt zugelassen hat: Genau auf die Kante
// zu gehen heißt, beim nächsten Lauf wieder mittendrin abzubrechen.
function empfohlenesBudget(beobachtet) {
  const wert = Math.floor((Number(beobachtet) || 0) * 0.95 / 10) * 10;
  return Math.max(50, wert);
}

// "vor 3 Std." statt einer nackten Uhrzeit — beim Blick aufs Dashboard will man
// wissen, wie lange es her ist, nicht wann genau.
function seit(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const std = Math.floor(min / 60);
  if (std < 24) return `vor ${std} Std.`;
  const tage = Math.floor(std / 24);
  return `vor ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}`;
}

// Eine Zustandskachel. Flacher als früher: Sie sitzt jetzt in einem Widget, und
// eine Karte in einer Karte mit doppeltem Schatten sah nach Verpackung aus.
function Kachel({ icon: Icon, titel, wert, unter, ton = 'neutral' }) {
  const toene = {
    gut:      'border-panel-green/25 bg-panel-green/5',
    warnung:  'border-panel-orange/30 bg-panel-orange/5',
    schlecht: 'border-panel-red/30 bg-panel-red/10',
    neutral:  'border-panel-border bg-panel-surface/40',
  };
  const farben = {
    gut: 'text-panel-green', warnung: 'text-panel-orange',
    schlecht: 'text-panel-red', neutral: 'text-panel-accent',
  };
  return (
    <div className={`rounded-xl border p-3 ${toene[ton]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-panel-muted/80 mb-1.5">
        <Icon size={13} className={`${farben[ton]} shrink-0`} />
        <span className="truncate">{titel}</span>
      </div>
      <div className="text-xl font-bold leading-tight text-panel-text truncate">{wert}</div>
      {unter && <div className="text-[11px] text-panel-muted mt-0.5 leading-snug">{unter}</div>}
    </div>
  );
}

// ─── Was auf eine Entscheidung wartet ────────────────────────────────────────
//
// Die erste Frage beim Öffnen des Dashboards ist "muss ich etwas tun?" — also
// steht die Antwort oben und nicht zwischen Kennzahlen. Jede Zeile führt mit
// einem Klick genau dorthin, wo die Arbeit liegt; bisher war auf der ganzen
// Seite keine einzige Zahl anklickbar.
function ZuTunZeile({ icon: Icon, zahl, titel, unter, ziel, hinweis }) {
  const inhalt = (
    <>
      <Icon size={18} className="text-panel-accent shrink-0" />
      <span className="text-xl font-semibold tabular-nums w-12 shrink-0">{zahl}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-panel-text">{titel}</span>
        <span className="block text-xs text-panel-muted">{unter}</span>
      </span>
      {ziel && <ArrowRight size={16} className="text-panel-muted shrink-0" />}
    </>
  );

  // Ohne Ziel keine Verlinkung: Für die steckengebliebenen Bestandsmails gibt
  // es (noch) keine eigene Ansicht — ein Link, der irgendwo anders landet,
  // wäre schlechter als keiner.
  if (!ziel) {
    return (
      <div className="list-row flex items-center gap-3 p-3" title={hinweis}>
        {inhalt}
      </div>
    );
  }
  return (
    <Link to={ziel} className="list-row flex items-center gap-3 p-3 hover:bg-panel-bg/40 transition-colors">
      {inhalt}
    </Link>
  );
}

// Ein schmaler Fortschrittsbalken.
function Balken({ anteil, ton = 'accent' }) {
  const farbe = {
    accent: 'bg-panel-accent', warnung: 'bg-panel-orange',
    rot: 'bg-panel-red', gruen: 'bg-panel-green',
  }[ton];
  return (
    <div className="h-2 rounded-full bg-panel-border/50 overflow-hidden">
      <div className={`h-full rounded-full ${farbe} transition-[width] duration-500`}
        style={{ width: `${Math.max(0, Math.min(100, anteil))}%` }} />
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [n8n, setN8n] = useState(null);
  const [aufsicht, setAufsicht] = useState(null);
  const [uebersicht, setUebersicht] = useState(null);
  const [startet, setStartet] = useState(false);
  const [resettet, setResettet] = useState(false);
  const [startMeldung, setStartMeldung] = useState('');
  const [budgetLaeuft, setBudgetLaeuft] = useState(false);
  const [statsKonto, setStatsKonto] = useState('');
  const [loadingStats, setLoadingStats] = useState(true);
  const [uebersichtLaedt, setUebersichtLaedt] = useState(true);
  const [uebersichtFehler, setUebersichtFehler] = useState('');
  const [zuletzt, setZuletzt] = useState(null);
  const { nachfragen } = useMelden();

  // Anordnung, Raster und Rahmen kommen aus dem gemeinsamen Baukasten — die
  // Statistik benutzt denselben.
  const anordnung = useAnordnung(KATALOG, 'dashboard');

  // ── Daten ──────────────────────────────────────────────────────────────────

  // Bestands-Triage von Hand anstoßen. n8n startet den Lauf und antwortet sofort —
  // die Arbeit selbst dauert je nach Bestand Minuten bis Stunden, deshalb wird hier
  // nichts abgewartet. Der Fortschritt ist auf der Kachel und im Rückstand zu sehen.
  const bestandStarten = async () => {
    setStartet(true);
    setStartMeldung('');
    try {
      await api.post('/workflows/bestand-starten');
      setStartMeldung('Gestartet — läuft im Hintergrund.');
      setTimeout(laden, 4000);
    } catch (err) {
      setStartMeldung(err.response?.data?.error || 'Start fehlgeschlagen.');
    } finally {
      setStartet(false);
    }
  };

  // Das Budget auf das setzen, was Google heute tatsächlich zugelassen hat —
  // ein bisschen darunter, damit das Panel vorher stoppt und der Lauf sauber
  // endet, statt mittendrin abzubrechen.
  const budgetUebernehmen = async (beobachtet) => {
    setBudgetLaeuft(true);
    try {
      await api.put('/einstellungen', { gemini_tagesbudget: String(empfohlenesBudget(beobachtet)) });
      await laden();
    } catch { /* die Anzeige bleibt, wie sie war */ } finally {
      setBudgetLaeuft(false);
    }
  };

  const laden = async () => {
    // N8n-Status, Aufsicht und Übersicht asynchron laden, ohne den Rest zu blockieren
    api.get('/dashboard/n8n-status')
      .then(res => setN8n(res.data))
      .catch(console.error);

    api.get('/aufsicht')
      .then(res => setAufsicht(res.data))
      .catch(() => setAufsicht(null));

    // Fehler und "lädt noch" waren bisher nicht zu unterscheiden: Beides
    // setzte die Übersicht auf null, und die Seite zeigte schlicht nichts.
    api.get('/dashboard/uebersicht')
      .then((res) => { setUebersicht(res.data); setUebersichtFehler(''); setZuletzt(new Date()); })
      .catch((err) => {
        setUebersicht(null);
        setUebersichtFehler(err.response?.data?.error || 'Die Übersicht ließ sich nicht laden.');
      })
      .finally(() => setUebersichtLaedt(false));
  };

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const { data } = await api.get(`/dashboard/stats${statsKonto ? `?konto=${encodeURIComponent(statsKonto)}` : ''}`);
      setStats(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingStats(false);
    }
  };

  // Das Dashboard war die einzige Seite, die einmal lud und dann stehenblieb —
  // Workflows, Sicherung und Logs frischen längst selbst auf. Bei einer Seite,
  // die "was ist zu tun" beantworten soll, ist ein veralteter Stand aber das
  // eigentliche Problem: Man sieht Arbeit, die längst erledigt ist.
  useEffect(() => {
    laden();
    const takt = setInterval(laden, 60000);
    // Wer den Reiter wechselt und zurückkommt, will den aktuellen Stand sehen
    // und nicht bis zum nächsten Takt warten.
    const beiRueckkehr = () => { if (!document.hidden) laden(); };
    document.addEventListener('visibilitychange', beiRueckkehr);
    return () => {
      clearInterval(takt);
      document.removeEventListener('visibilitychange', beiRueckkehr);
    };
  }, []);

  useEffect(() => {
    loadStats();
  }, [statsKonto]);

  // Wir blockieren nicht mehr das gesamte Dashboard, wenn nur die Statistiken laden
  const pieData = stats?.summen ? [
    { name: 'Spam', value: stats.summen.spam },
    { name: 'Phishing', value: stats.summen.phishing },
    { name: 'Viren', value: stats.summen.viren },
    { name: 'Newsletter', value: stats.summen.newsletter },
    { name: 'Clean', value: stats.summen.whitelist }
  ].filter(d => d.value > 0) : [];

  // Was die Aufsicht zuletzt gefunden hat. Ein Ausfall soll ins Auge fallen —
  // sechs Tage stille Sortierpause waren genug.
  const befund = aufsicht?.letzterLauf;
  const stoerung = befund && befund.ok === false;

  const u = uebersicht;
  const wartet = (
    <p className="text-sm text-panel-muted">
      {uebersichtLaedt ? 'Wird geladen …' : (uebersichtFehler || 'Keine Daten.')}
    </p>
  );

  // ── Inhalte der Widgets ────────────────────────────────────────────────────
  const widget = (id) => {
    const eintrag = KATALOG[id];
    const rahmen = {
      titel: eintrag.titel, icon: eintrag.icon,
      onAusblenden: () => anordnung.ausblenden(id),
    };

    if (id === 'zutun') {
      const z = u?.zuTun;
      const posten = !z ? [] : [
        {
          schluessel: 'zuordnungen', icon: Inbox, zahl: z.zuordnungen,
          titel: 'Mails warten auf eine Zuordnung',
          unter: 'Die KI war sich nicht sicher genug — entscheide einmal, und die Regel gilt künftig.',
          ziel: '/sortierung',
        },
        {
          schluessel: 'themenVorschlaege', icon: Sparkles, zahl: z.themenVorschlaege,
          titel: 'Vorgeschlagene Themen-Ordner',
          unter: 'Neue Ordner, die erst entstehen, wenn du sie freigibst.',
          ziel: '/sortierung?tab=vorschlaege',
        },
        {
          schluessel: 'nachsortierung', icon: Repeat, zahl: z.nachsortierung,
          titel: 'Vorschläge der Nachsortierung',
          unter: 'Ein Trockenlauf hat gefunden, wofür inzwischen eine Regel etwas anderes sagt.',
          ziel: '/sortierung?tab=nachsortierung',
        },
        {
          schluessel: 'freigaben', icon: CloudUpload, zahl: z.freigaben,
          titel: 'Dateien warten auf Freigabe',
          unter: 'Anhänge, die erst nach deinem Ja in die Ablage wandern.',
          ziel: '/sortierung?tab=freigaben',
        },
        {
          schluessel: 'bestandUnklar', icon: PauseCircle, zahl: z.bestandUnklar,
          titel: 'Bestandsmails sind hängengeblieben',
          unter: 'Zweimal angeboten, beide Male unentscheidbar — sie werden nicht mehr vorgelegt. '
            + '„Gesamten Posteingang neu bewerten" im Rückstands-Widget gibt ihnen eine neue Chance.',
          ziel: null,
        },
      ].filter((p) => (Number(p.zahl) || 0) > 0);

      const zaehler = z && posten.length > 0 ? (
        <span className="bg-panel-accent text-white text-xs px-2 py-0.5 rounded-full tabular-nums shrink-0">
          {z.gesamt.toLocaleString('de-DE')}
        </span>
      ) : null;

      return (
        <Widget {...rahmen} flach aktion={zaehler}>
          {!z ? (
            <div className="p-4">{wartet}</div>
          ) : posten.length === 0 ? (
            <div className="p-6 text-center text-panel-muted flex flex-col items-center gap-2">
              <CheckCircle2 size={26} className="text-panel-green/60" />
              <p className="text-sm">Nichts offen — es wartet gerade keine Entscheidung auf dich.</p>
            </div>
          ) : (
            <div>
              {posten.map((p) => <ZuTunZeile key={p.schluessel} {...p} />)}
            </div>
          )}
        </Widget>
      );
    }

    if (id === 'betrieb') {
      return (
        <Widget {...rahmen}>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${n8n?.online ? 'bg-panel-green shadow-[0_0_8px_rgba(63,185,80,0.6)]' : 'bg-panel-red'}`} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">n8n-Engine</span>
                <span className="block text-xs text-panel-muted">
                  {!n8n ? 'wird geprüft …' : n8n.online ? `${n8n.activeWorkflows} Workflows aktiv` : 'offline — es läuft gerade nichts'}
                </span>
              </span>
              <Link to="/workflows" className="text-panel-muted hover:text-panel-text shrink-0" title="Zu den Workflows">
                <ArrowRight size={16} />
              </Link>
            </div>
            <div className="flex items-center gap-3 pt-3 border-t border-panel-border/60">
              <RefreshCw size={14} className="text-panel-muted shrink-0" />
              <span className="min-w-0 flex-1 text-xs text-panel-muted">
                Frischt sich jede Minute auf
                {zuletzt && <> · zuletzt {zuletzt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</>}
              </span>
              <button type="button" onClick={laden} className="btn btn-ghost !py-1 !px-2 text-xs shrink-0">
                Jetzt
              </button>
            </div>
          </div>
        </Widget>
      );
    }

    if (id === 'zustand') {
      if (!u) return <Widget {...rahmen}>{wartet}</Widget>;
      const auf = u.aufsicht;
      const aufTon = !auf ? 'neutral' : (auf.ok ? 'gut' : 'schlecht');
      const aufWert = !auf ? '—' : (auf.n8nErreichbar === false ? 'n8n weg'
        : auf.ok ? 'Alles läuft' : `${auf.abweichungen?.filter(a => !a.behoben).length || 0} Störung`);
      const sich = u.sicherung;
      const sichTon = !sich?.eingerichtet ? 'warnung' : (sich.letzter?.ok ? 'gut' : (sich.letzter ? 'schlecht' : 'neutral'));
      const quote = u.lernen.trefferquote;
      // Bestands-Triage: laeuft der Zeitplan und ist der letzte Lauf lange her,
      // stimmt etwas nicht — dann faellt die Kachel auf.
      const bes = u.bestand;
      const besAlterStd = bes?.letzterLauf
        ? (Date.now() - new Date(bes.letzterLauf).getTime()) / 3600000 : null;
      const besTon = !bes?.letzterLauf ? 'neutral'
        : (bes.intervallStunden > 0 && besAlterStd > bes.intervallStunden * 2) ? 'warnung' : 'gut';

      return (
        <Widget {...rahmen}>
          <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
            <Kachel icon={ShieldCheck} titel="Aufsicht" ton={aufTon} wert={aufWert}
              unter={auf ? `zuletzt ${new Date(auf.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'noch nicht geprüft'} />
            <Kachel icon={Target} titel="Trefferquote (7 T.)"
              ton={quote == null ? 'neutral' : quote >= 90 ? 'gut' : quote >= 75 ? 'warnung' : 'schlecht'}
              wert={quote == null ? '—' : `${quote.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`}
              unter={`${u.lernen.einordnungen7} einsortiert, ${u.lernen.korrigiert7} korrigiert`} />
            <Kachel icon={HardDriveDownload} titel="Sicherung" ton={sichTon}
              wert={!sich?.eingerichtet ? 'offen' : sich.letzter?.ok ? 'aktuell' : sich.letzter ? 'Fehler' : 'bereit'}
              unter={sich?.letzter ? `${sich.letzter.mails} Mails, ${new Date(sich.letzter.zeitpunkt).toLocaleDateString('de-DE')}` : 'kein Lauf'} />
            <Kachel icon={Inbox} titel="Wartet auf dich"
              ton={u.posteingang.offeneEntscheidungen > 0 ? 'warnung' : 'gut'}
              wert={u.posteingang.offeneEntscheidungen}
              unter="Mails ohne Zuordnung" />
            <Kachel icon={Workflow} titel="Bestand sortiert" ton={besTon}
              wert={bes?.letzterLauf ? seit(bes.letzterLauf) : 'nie'}
              unter={bes?.letzterLauf
                ? `${bes.verarbeitet} von ${bes.gesamt} bearbeitet`
                : (bes?.intervallStunden > 0 ? `Zeitplan: alle ${bes.intervallStunden} h` : 'noch nie gelaufen')} />
          </div>
        </Widget>
      );
    }

    if (id === 'rueckstand') {
      return (
        <Widget {...rahmen}>
          {!u ? wartet : u.posteingang.konten.length === 0 ? (
            <p className="text-sm text-panel-muted">Kein Postfach eingerichtet.</p>
          ) : (
            <div className="space-y-3">
              {u.posteingang.konten.map((konto) => {
                const hatBestand = konto.posteingangGesamt > 0;
                const hatWartend = konto.wartend > 0;
                const istVollstaendig = !hatWartend && (!hatBestand || konto.posteingangGesamt === 0);
                // Hier stand ein Balken, der nichts maß: "100 − (wartend × 3
                // + Posteingang/50)", geklemmt auf 5–95 %. Eine Zahl, die
                // wie ein Anteil aussah, aber keiner war. Jetzt der echte
                // Anteil — wie viel des gezählten Posteingangs bereits
                // einsortiert ist. Ohne Bezugsgröße gibt es keinen Balken.
                const bezug = konto.posteingangGesamt || 0;
                const anteil = bezug > 0
                  ? Math.max(0, Math.min(100, ((bezug - konto.wartend) / bezug) * 100))
                  : null;
                const ton = istVollstaendig ? 'gruen'
                  : (konto.wartend > 20 || konto.posteingangGesamt > 500) ? 'warnung' : 'accent';
                return (
                  <div key={konto.konto_id}>
                    <div className="flex justify-between text-sm mb-1 gap-2 flex-wrap">
                      <span className="font-medium">{konto.konto}</span>
                      <span className={konto.erreichbar ? 'text-panel-muted' : 'text-panel-red'}>
                        {konto.erreichbar ? (
                          <>
                            <span className={hatWartend ? 'text-panel-orange font-medium' : ''}>
                              {konto.wartend} in Sortier-Inbox
                            </span>
                            {hatBestand && (
                              <span className="text-panel-muted"> · {konto.posteingangGesamt.toLocaleString('de-DE')} im Posteingang</span>
                            )}
                          </>
                        ) : 'nicht erreichbar'}
                      </span>
                    </div>
                    {konto.erreichbar && anteil !== null && (
                      <Balken anteil={anteil} ton={ton} />
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-panel-muted pt-1">
                „Sortier-Inbox“ sind Mails, die auf manuelle Freigabe/Zuordnung warten. Ein grüner Balken
                signalisiert, dass weder in der Sortier-Inbox noch im Posteingang unorganisierte Mails liegen.
              </p>
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={bestandStarten} disabled={startet || resettet}
                    className="btn !py-1.5 !px-3 text-sm flex items-center gap-1 disabled:opacity-50">
                    <Workflow size={14} className={startet ? 'animate-spin' : ''} /> {startet ? 'Wird gestartet …' : 'Bestand jetzt sortieren'}
                  </button>
                  {startMeldung && <span className="text-xs text-panel-muted">{startMeldung}</span>}
                </div>
                <div className="flex items-center gap-3 pt-2 mt-2 border-t border-white/5">
                  <button disabled={startet || resettet} onClick={async () => {
                      // Vorher window.confirm — der einzige Systemdialog
                      // im ganzen Panel, mitten in einer Oberfläche, die
                      // für Rückfragen einen eigenen Weg hat.
                      const ok = await nachfragen({
                        titel: 'Gedächtnis des Bestands-Scanners löschen?',
                        text: 'Offene Zuordnungen und der Vermerk, welche Mails schon geprüft wurden, '
                          + 'werden gelöscht. Das Panel bewertet danach den gesamten Posteingang neu — '
                          + 'das kann je nach Bestand dauern. Verschoben wird dabei nichts rückgängig.',
                        bestaetigen: 'Neu bewerten',
                        gefaehrlich: true,
                      });
                      if (!ok) return;
                      setResettet(true);
                      setStartMeldung('Gedächtnis wird geleert …');
                      try {
                        await api.post('/workflows/bestand-reset');
                        setStartMeldung('Gedächtnis geleert. Starte Bestands-Triage …');
                        await bestandStarten();
                      } catch (err) {
                        setStartMeldung(err.response?.data?.error || 'Fehler beim Reset.');
                      } finally {
                        setResettet(false);
                      }
                    }}
                    className="btn btn-ghost !py-1 !px-3 text-[11px] flex items-center gap-1 text-panel-muted hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={resettet ? 'animate-spin' : ''} /> {resettet ? 'Wird zurückgesetzt …' : 'Gesamten Posteingang neu bewerten (Reset)'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Widget>
      );
    }

    if (id === 'budget') {
      const b = u?.budget;
      const budgetAnteil = b?.grenze ? (b.heute / b.grenze) * 100 : 0;
      return (
        <Widget {...rahmen}>
          {!b ? wartet : b.kiAnbieter === 'ollama' ? (
            // Früher verschwand dieses Widget bei Ollama ganz — und daneben
            // klaffte die Lücke, in der es gestanden hätte. Eine Kachel, die
            // selbst sagt, warum sie nichts zu zählen hat, ist ehrlicher.
            <div className="space-y-2 text-sm text-panel-muted">
              <p>
                Die Einordnung läuft über <span className="text-panel-text">Ollama</span> auf eigener
                Hardware. Dort gibt es kein Tageskontingent, das aufgebraucht sein könnte — nur die
                Rechenzeit der Maschine.
              </p>
              {b.mailsHeute > 0 && (
                <p>Heute eingeordnet: <b className="text-panel-text">{b.mailsHeute}</b> Mails.</p>
              )}
            </div>
          ) : (
            <div>
              {b.grenze ? (
                <div className="space-y-2">
                  <div className="flex justify-between items-end gap-2 flex-wrap">
                    <span className="text-2xl font-bold">{b.heute}
                      <span className="text-sm text-panel-muted font-normal"> / {b.grenze} Anfragen</span></span>
                    <span className="text-xs text-panel-muted">{b.rest} übrig heute</span>
                  </div>
                  <Balken anteil={budgetAnteil} ton={b.ausgeschoepft ? 'rot' : budgetAnteil > 80 ? 'warnung' : 'accent'} />
                  {/* Anfragen sind die Währung — Googles Limit zählt die.
                      Mails sind das Ergebnis, und seit der Bündelung stecken
                      mehrere davon in einer Anfrage. Beide Zahlen gehören
                      nebeneinander, sonst versteht niemand den Deckel. */}
                  {b.mailsHeute > 0 && (
                    <p className="text-xs text-panel-muted">
                      Dabei eingeordnet: <b className="text-panel-text">{b.mailsHeute}</b> Mails
                      {b.heute > 0 && <> — rund {Math.round(b.mailsHeute / b.heute)} je Anfrage</>}
                    </p>
                  )}
                  <p className="text-xs text-panel-muted pt-1">
                    {b.ausgeschoepft
                      ? 'Heutiges Kontingent aufgebraucht — die Sortierung eines großen Bestands macht morgen weiter.'
                      : `Googles Tageslimit zählt Anfragen, nicht Mails. Das Panel bündelt bis zu ${b.jeAnfrage * 2} Mails in eine.`}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-panel-muted">
                  Kein Tagesbudget gesetzt — die KI ordnet ohne Deckel ein. Unter
                  <span className="font-mono text-panel-accent"> Einstellungen</span> begrenzbar.
                </p>
              )}

              {/* Was Google heute wirklich zugelassen hat. Einen Rest-Zähler
                  gibt die Gemini-API nicht heraus — das hier ist die Stelle,
                  an der sie abgewiesen hat, und damit die belastbarste Zahl,
                  die zu bekommen ist. */}
              {b.beobachtet && (() => {
                // Nennt Google in der Absage sein Limit („limit: 500, model: …"),
                // gilt das. Die eigene Zählung liegt zwangsläufig darunter: Ein
                // am Gemini-Knoten gestorbener Lauf protokolliert keine seiner
                // Mails, gekostet haben sie trotzdem. Ohne Zahl in der Meldung
                // bleibt der eigene Stand die beste Schätzung.
                const echt = Number(b.beobachtet.limit) > 0;
                const zahl = echt ? b.beobachtet.limit : b.beobachtet.stand;
                return (
                  <div className="mt-3 pt-3 border-t border-panel-border text-xs space-y-2">
                    <p className="text-panel-red">
                      {echt ? (
                        <>
                          Google lässt <span className="font-bold">{zahl}</span> Anfragen pro Tag zu
                          {b.beobachtet.modell && <> für <span className="font-mono">{b.beobachtet.modell}</span></>}
                          {' '}— heute ist das Kontingent aufgebraucht.
                        </>
                      ) : (
                        <>
                          Google hat heute bei <span className="font-bold">{zahl}</span> Abfragen
                          abgewiesen.
                        </>
                      )}
                    </p>
                    <p className="text-panel-muted">
                      {echt ? (
                        <>
                          Diese Zahl steht wörtlich in Googles Absage. Selbst gezählt hat das Panel
                          heute {b.beobachtet.stand} — die Lücke sind Mails aus Läufen, die bei
                          Gemini starben und deshalb nie protokolliert wurden. Bis morgen enden
                          weitere Läufe sofort, statt erst nach Minuten abzubrechen.
                        </>
                      ) : (
                        <>
                          Das ist dein tatsächliches Tageskontingent — einen Rest-Zähler gibt die
                          Gemini-API nicht heraus, das Panel zählt selbst mit und merkt sich, wo
                          Google dichtmacht. Setz das Tagesbudget knapp darunter
                          {b.grenze > zahl && <> (steht auf {b.grenze})</>}, dann enden die
                          Läufe sauber, statt mittendrin abzubrechen.
                        </>
                      )}
                    </p>
                    {b.grenze !== empfohlenesBudget(zahl) && (
                      <button onClick={() => budgetUebernehmen(zahl)}
                        disabled={budgetLaeuft}
                        className="btn !py-1 !px-3 text-xs flex items-center gap-1">
                        <Check size={13} />
                        Budget auf {empfohlenesBudget(zahl)} setzen
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Welches Modell gerade arbeitet — und ob das Panel gewechselt hat */}
              {b.modell && (
                <div className="mt-3 pt-3 border-t border-panel-border text-[11px] text-panel-muted">
                  Modell: <span className="font-mono text-panel-text">{b.modell.aktiv}</span>
                  {b.modell.aufErsatz ? (
                    <> — Ersatzmodell, weil das Kontingent von
                      {' '}<span className="font-mono">{b.modell.primaer}</span> heute leer war.
                      Morgen geht es wieder mit dem ersten weiter.</>
                  ) : b.modell.ersatz ? (
                    <> — bei erschöpftem Kontingent schaltet das Panel auf
                      {' '}<span className="font-mono">{b.modell.ersatz}</span> um.</>
                  ) : (
                    <> — ohne Ersatzmodell. Eines unter <span className="text-panel-text">Einstellungen
                      → KI</span> einzutragen verschafft dir bei vollem Kontingent einen zweiten Topf.</>
                  )}
                </div>
              )}
            </div>
          )}
        </Widget>
      );
    }

    if (id === 'belege') {
      const bl = u?.belege;
      const leseAnteil = bl?.leseGrenze ? (bl.gelesenHeute / bl.leseGrenze) * 100 : 0;
      return (
        <Widget {...rahmen}>
          {!bl ? wartet : (
            <div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-2xl font-bold text-panel-green">{bl.heute}</div>
                  <div className="text-[11px] text-panel-muted">heute abgelegt</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-panel-muted">{bl.uebersprungenHeute}</div>
                  <div className="text-[11px] text-panel-muted">übersprungen (kein Beleg)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-panel-text">{bl.woche}</div>
                  <div className="text-[11px] text-panel-muted">letzte 7 Tage</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-panel-text">
                    {bl.leseGrenze ? `${bl.gelesenHeute}/${bl.leseGrenze}` : bl.gelesenHeute}
                  </div>
                  <div className="text-[11px] text-panel-muted">heute gelesen</div>
                </div>
              </div>
              {bl.leseGrenze ? (
                <div className="mt-3">
                  <Balken anteil={leseAnteil} ton={leseAnteil >= 100 ? 'rot' : leseAnteil > 80 ? 'warnung' : 'accent'} />
                </div>
              ) : null}
            </div>
          )}
        </Widget>
      );
    }

    if (id === 'schutz') {
      const kpis = [
        { label: 'Gescannte E-Mails', wert: stats?.summen?.total ?? 0, farbe: 'text-panel-accent' },
        { label: 'Spam geblockt', wert: stats?.summen?.spam ?? 0, farbe: 'text-panel-orange' },
        { label: 'Phishing erkannt', wert: stats?.summen?.phishing ?? 0, farbe: 'text-panel-red' },
        { label: 'Viren isoliert', wert: stats?.summen?.viren ?? 0, farbe: 'text-panel-purple' },
      ];
      return (
        <Widget {...rahmen}>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            {kpis.map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-panel-border bg-panel-surface/40 p-3">
                <div className="text-[11px] font-semibold tracking-wide text-panel-muted/80 uppercase mb-1 truncate">{kpi.label}</div>
                <div className={`text-3xl font-black tracking-tight ${kpi.farbe}`}>
                  {loadingStats ? <span className="animate-pulse opacity-50">…</span> : kpi.wert.toLocaleString('de-DE')}
                </div>
              </div>
            ))}
          </div>
        </Widget>
      );
    }

    if (id === 'verlauf') {
      // Die Postfach-Auswahl gehört in den Widget-Kopf: Vorher saß sie im
      // Diagramm und wanderte bei jeder Breite woandershin.
      const auswahl = stats?.konten && stats.konten.length > 0 ? (
        <select
          value={statsKonto}
          onChange={(e) => setStatsKonto(e.target.value)}
          className="input-field !py-1 !text-xs !w-auto max-w-[180px] shrink-0"
        >
          <option value="">Alle Postfächer</option>
          {stats.konten.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      ) : null;

      return (
        <Widget {...rahmen} aktion={auswahl}>
          <div className="h-full min-h-[220px] w-full">
            {loadingStats ? (
              <div className="w-full h-full flex items-center justify-center text-panel-muted text-sm">Lade Verlauf …</div>
            ) : !stats?.history ? (
              <div className="w-full h-full flex items-center justify-center text-panel-red text-sm">Fehler beim Laden</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.history} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorClean" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Clean} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.Clean} stopOpacity={0.2} />
                    </linearGradient>
                    <linearGradient id="colorNewsletter" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Newsletter} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.Newsletter} stopOpacity={0.2} />
                    </linearGradient>
                    <linearGradient id="colorSpam" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Spam} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.Spam} stopOpacity={0.2} />
                    </linearGradient>
                    <linearGradient id="colorPhishing" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Phishing} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.Phishing} stopOpacity={0.2} />
                    </linearGradient>
                    <linearGradient id="colorViren" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Viren} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={COLORS.Viren} stopOpacity={0.2} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="tag" tick={{ fill: FARBEN.grau, fontSize: 11, fontWeight: 500 }} tickFormatter={(v) => v.split('-').slice(1).join('.')} axisLine={false} tickLine={false} dy={5} />
                  <YAxis tick={{ fill: FARBEN.grau, fontSize: 11, fontWeight: 500 }} axisLine={false} tickLine={false} dx={-5} />
                  <Tooltip contentStyle={TOOLTIP_STIL} itemStyle={{ fontSize: '13px' }} />
                  <Bar dataKey="Clean" stackId="a" fill="url(#colorClean)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="Newsletter" stackId="a" fill="url(#colorNewsletter)" />
                  <Bar dataKey="Spam" stackId="a" fill="url(#colorSpam)" />
                  <Bar dataKey="Phishing" stackId="a" fill="url(#colorPhishing)" />
                  <Bar dataKey="Viren" stackId="a" fill="url(#colorViren)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Widget>
      );
    }

    if (id === 'verteilung') {
      return (
        <Widget {...rahmen}>
          <div className="h-full flex flex-col">
            <div className="flex-1 min-h-[180px]">
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius="55%" outerRadius="80%"
                      paddingAngle={5} dataKey="value" stroke="none">
                      {pieData.map((teil) => (
                        <Cell key={teil.name} fill={COLORS[teil.name]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STIL} itemStyle={{ fontSize: '14px' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-panel-muted text-sm">
                  Keine Daten
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-center gap-3 mt-2 shrink-0">
              {pieData.map((teil) => (
                <div key={teil.name} className="flex items-center gap-1.5 text-xs text-panel-muted">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[teil.name] }} />
                  {teil.name}
                </div>
              ))}
            </div>
          </div>
        </Widget>
      );
    }

    return null;
  };

  // ── Kopfbereich: Störung, Fehler, Werkzeugleiste ───────────────────────────
  const kopf = (
    <>
      {stoerung && (
        <div className="card border-panel-red bg-panel-red/10 flex items-start gap-3">
          <AlertTriangle size={20} className="text-panel-red mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-medium text-panel-red">
              {befund.n8nErreichbar === false
                ? 'n8n ist nicht erreichbar — es läuft gerade gar nichts.'
                : 'Etwas läuft nicht, was laufen sollte.'}
            </div>
            {befund.fehler && <div className="text-panel-muted mt-1">{befund.fehler}</div>}
            {(befund.abweichungen || []).filter(a => !a.behoben).map((a) => (
              <div key={a.id} className="text-panel-muted mt-1">
                • {a.text}{a.grund && <span className="block ml-3 text-xs">Grund von n8n: {a.grund}</span>}
              </div>
            ))}
            <div className="text-xs text-panel-muted mt-2">
              Zuletzt geprüft: {new Date(befund.zeitpunkt).toLocaleString('de-DE')}
            </div>
          </div>
        </div>
      )}

      {befund?.ok && befund.repariert?.length > 0 && (
        <div className="card border-panel-orange/60 flex items-start gap-3 text-sm">
          <AlertTriangle size={18} className="text-panel-orange mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Wieder eingeschaltet:</span>{' '}
            {befund.repariert.join(', ')} — war ausgefallen und läuft jetzt wieder.
          </div>
        </div>
      )}

      {uebersichtFehler && (
        <div className="card border-panel-orange/40 bg-panel-orange/10 flex items-start gap-2 text-sm">
          <AlertTriangle size={16} className="text-panel-orange mt-0.5 shrink-0" />
          <span>{uebersichtFehler}</span>
        </div>
      )}

      <WidgetLeiste anordnung={anordnung} />
    </>
  );

  return (
    <div className="space-y-4">
      {kopf}
      <WidgetRaster anordnung={anordnung} inhalt={widget} />
    </div>
  );
}
