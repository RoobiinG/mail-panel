// Die Auswertung — als frei anordbares Widget-Raster.
//
// Die vier Fragen (Qualität, Durchsatz, Absender, Kosten) blieben, aber sie
// steckten in vier großen Karten, deren Reihenfolge feststand: Wer täglich auf
// die Domains schaut, musste trotzdem jedes Mal an zwei Diagrammen vorbei.
// Jetzt ist jeder Abschnitt ein eigenes Widget — verschieben, in der Größe
// ändern, ausblenden. Dieselbe Bauweise wie im Dashboard, aus demselben
// Baukasten (`components/ui/Widgets.jsx`), mit einer eigenen Anordnung je
// Benutzer (`/api/anordnung?seite=statistik`).
//
// Über dem Raster bleibt, was für alle Widgets gilt: Zeitraum und Postfach.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  Loader2, AlertCircle, AlertTriangle, Target, Gauge, AtSign, Coins, Inbox,
  Activity, Filter, Users, Folder, Layers,
} from 'lucide-react';
import api from '../api';
import { Widget, WidgetLeiste, WidgetRaster, useAnordnung } from '../components/ui/Widgets';
import { FARBEN, TOOLTIP_STIL, ACHSE, tagKurz } from '../components/ui/diagramm';

const ZEITRAEUME = [
  { tage: 7, label: '7 Tage' },
  { tage: 30, label: '30 Tage' },
  { tage: 90, label: '90 Tage' },
];

// ─── Der Widget-Katalog ──────────────────────────────────────────────────────
//
// Die vier Fragen sind erhalten geblieben, nur feiner geschnitten: Was vorher
// in einer Karte übereinander lag (Diagramm plus zwei Ranglisten), ist jetzt
// einzeln zu greifen. Die Standard-Anordnung lässt keine Reihe halb leer.
const KATALOG = {
  kennzahlen: { titel: 'Die vier Zahlen',        icon: Inbox,         standard: { x: 0, y: 0,  w: 12, h: 4, minW: 3, minH: 3 } },
  qualitaet:  { titel: 'Wie gut sortiert es?',   icon: Target,        standard: { x: 0, y: 4,  w: 8,  h: 9, minW: 4, minH: 5 } },
  konfidenz:  { titel: 'Wie sicher war die KI?', icon: Gauge,         standard: { x: 8, y: 4,  w: 4,  h: 5, minW: 3, minH: 3 } },
  gruende:    { titel: 'Häufigste Begründung',   icon: Filter,        standard: { x: 8, y: 9,  w: 4,  h: 4, minW: 3, minH: 3 } },
  durchsatz:  { titel: 'Wie viel läuft durch?',  icon: Activity,      standard: { x: 0, y: 13, w: 6,  h: 7, minW: 3, minH: 4 } },
  stoerungen: { titel: 'Was hakte?',             icon: AlertTriangle, standard: { x: 6, y: 13, w: 6,  h: 7, minW: 3, minH: 4 } },
  domains:    { titel: 'Domains',                icon: AtSign,        standard: { x: 0, y: 20, w: 4,  h: 7, minW: 3, minH: 3 } },
  absender:   { titel: 'Absender',               icon: Users,         standard: { x: 4, y: 20, w: 4,  h: 7, minW: 3, minH: 3 } },
  zielordner: { titel: 'Zielordner',             icon: Folder,        standard: { x: 8, y: 20, w: 4,  h: 7, minW: 3, minH: 3 } },
  regeln:     { titel: 'Regeln, die greifen',    icon: Layers,        standard: { x: 0, y: 27, w: 7,  h: 7, minW: 3, minH: 3 } },
  kosten:     { titel: 'Was kostet es?',         icon: Coins,         standard: { x: 7, y: 27, w: 5,  h: 7, minW: 3, minH: 4 } },
};

const zahl = (n) => Number(n || 0).toLocaleString('de-DE');

// Eine große Zahl mit Beschriftung. Bewusst schlicht: Die Aussage steckt in der
// Zahl, nicht im Rahmen.
function Kennzahl({ icon: Icon, titel, wert, unter, ton = 'neutral' }) {
  const farben = {
    neutral: 'text-panel-text',
    gut: 'text-panel-green',
    warnung: 'text-panel-orange',
    schlecht: 'text-panel-red',
  };
  return (
    <div className="rounded-xl border border-panel-border bg-panel-surface/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-panel-muted mb-1 truncate">
        <Icon size={13} className="text-panel-accent shrink-0" /> {titel}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${farben[ton]}`}>{wert}</div>
      {unter && <div className="text-[11px] text-panel-muted mt-0.5 leading-snug">{unter}</div>}
    </div>
  );
}

// Balkenliste für Ranglisten — lesbarer als ein Tortendiagramm mit zwölf
// Stücken und ehrlicher als eine Tabelle ohne Größenverhältnis.
function Rangliste({ eintraege, leer = 'Nichts im Zeitraum.' }) {
  if (!eintraege?.length) return <p className="text-xs text-panel-muted">{leer}</p>;
  const groesste = Math.max(...eintraege.map((e) => e.anzahl), 1);
  return (
    <div className="space-y-1.5">
      {eintraege.map((e) => (
        <div key={e.name} className="text-xs">
          <div className="flex justify-between gap-2">
            <span className="truncate text-panel-text" title={e.name}>{e.name}</span>
            <span className="text-panel-muted tabular-nums shrink-0">{zahl(e.anzahl)}</span>
          </div>
          <div className="h-1 mt-1 rounded-full bg-panel-border/40 overflow-hidden">
            <div className="h-full rounded-full bg-panel-accent/70"
              style={{ width: `${(e.anzahl / groesste) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Statistik() {
  const [suchParams, setSuchParams] = useSearchParams();
  const tage = Number(suchParams.get('tage')) || 30;
  const konto = suchParams.get('konto') || '';

  const [daten, setDaten] = useState(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState('');

  // Vor den Abbrüchen weiter unten: Ein Haken darf nicht mal aufgerufen werden
  // und mal nicht.
  const anordnung = useAnordnung(KATALOG, 'statistik');

  useEffect(() => {
    let abgemeldet = false;
    setLaedt(true);
    api.get(`/statistik?tage=${tage}${konto ? `&konto=${encodeURIComponent(konto)}` : ''}`)
      .then((r) => { if (!abgemeldet) { setDaten(r.data); setFehler(''); } })
      .catch((err) => {
        if (!abgemeldet) setFehler(err.response?.data?.error || 'Die Auswertung ließ sich nicht laden.');
      })
      .finally(() => { if (!abgemeldet) setLaedt(false); });
    return () => { abgemeldet = true; };
  }, [tage, konto]);

  const setzen = (schluessel, wert) => {
    const neu = new URLSearchParams(suchParams);
    if (wert) neu.set(schluessel, String(wert)); else neu.delete(schluessel);
    setSuchParams(neu, { replace: true });
  };

  if (laedt && !daten) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="animate-spin text-panel-accent" size={24} />
      </div>
    );
  }
  if (fehler) {
    return (
      <div className="card border-panel-red/30 bg-panel-red/10 text-panel-red text-sm flex items-center gap-2">
        <AlertCircle size={16} /> {fehler}
      </div>
    );
  }

  const s = daten?.summe || {};
  const verlauf = (daten?.verlauf || []).map((z) => ({ ...z, tagKurz: tagKurz(z.tag) }));
  const stoerungen = (daten?.stoerungen || []).map((z) => ({ ...z, tagKurz: tagKurz(z.tag) }));
  const ohneKiAnteil = s.gesamt ? Math.round((s.vonRegel / s.gesamt) * 100) : 0;
  const leer = !s.gesamt;

  // ── Inhalte der Widgets ────────────────────────────────────────────────────
  const widget = (id) => {
    const eintrag = KATALOG[id];
    const rahmen = {
      titel: eintrag.titel, icon: eintrag.icon,
      onAusblenden: () => anordnung.ausblenden(id),
    };

    if (id === 'kennzahlen') {
      return (
        <Widget {...rahmen}>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Kennzahl icon={Inbox} titel="Einsortiert" wert={zahl(s.gesamt)}
              unter={`in ${tage} Tagen`} />
            <Kennzahl icon={Target} titel="Nachträglich korrigiert"
              wert={s.korrekturQuote == null ? '—' : `${s.korrekturQuote} %`}
              ton={s.korrekturQuote == null ? 'neutral' : s.korrekturQuote <= 5 ? 'gut' : s.korrekturQuote <= 15 ? 'warnung' : 'schlecht'}
              unter={`${zahl(s.korrigiert)} von ${zahl(s.gesamt)} geradegezogen`} />
            <Kennzahl icon={Gauge} titel="Liegengeblieben" wert={zahl(s.liegengeblieben)}
              ton={s.liegengeblieben > s.gesamt * 0.3 ? 'warnung' : 'neutral'}
              unter="ohne Zielordner geblieben" />
            <Kennzahl icon={Coins} titel="Ohne KI erledigt" wert={`${ohneKiAnteil} %`}
              ton={ohneKiAnteil >= 30 ? 'gut' : 'neutral'}
              unter={`${zahl(s.vonRegel)} Mails über Regeln`} />
          </div>
        </Widget>
      );
    }

    if (id === 'qualitaet') {
      return (
        <Widget {...rahmen}>
          <div className="h-full flex flex-col gap-2">
            <p className="text-xs text-panel-muted shrink-0">
              Wie viel die KI entschieden hat und wie viel bereits eine Regel erledigte — und was
              danach von Hand korrigiert werden musste. Eine niedrige Korrekturzahl bei vielen
              Einordnungen ist das Ziel.
            </p>
            <div className="flex-1 min-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={verlauf}>
                  <CartesianGrid strokeDasharray="3 3" stroke={FARBEN.rand} vertical={false} />
                  <XAxis dataKey="tagKurz" {...ACHSE} />
                  <YAxis {...ACHSE} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STIL} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="vonKi" name="von der KI" stackId="a" fill={FARBEN.akzent} />
                  <Bar dataKey="vonRegel" name="von einer Regel" stackId="a" fill={FARBEN.gruen} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="korrigiert" name="später korrigiert" fill={FARBEN.rot} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Widget>
      );
    }

    if (id === 'konfidenz') {
      return (
        <Widget {...rahmen}>
          <Rangliste eintraege={(daten.konfidenz || []).map((k) => ({ name: k.stufe, anzahl: k.anzahl }))} />
        </Widget>
      );
    }

    if (id === 'gruende') {
      return (
        <Widget {...rahmen}>
          <Rangliste eintraege={(daten.gruende || []).map((g) => ({ name: g.grund, anzahl: g.anzahl }))} />
        </Widget>
      );
    }

    if (id === 'durchsatz') {
      return (
        <Widget {...rahmen}>
          <div className="h-full flex flex-col gap-2">
            <p className="text-xs text-panel-muted shrink-0">
              Menge je Tag, daneben das, was ohne Zielordner liegen blieb.
            </p>
            <div className="flex-1 min-h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={verlauf}>
                  <CartesianGrid strokeDasharray="3 3" stroke={FARBEN.rand} vertical={false} />
                  <XAxis dataKey="tagKurz" {...ACHSE} />
                  <YAxis {...ACHSE} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STIL} />
                  <Line type="monotone" dataKey="gesamt" name="einsortiert" stroke={FARBEN.akzent}
                    strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="liegengeblieben" name="liegengeblieben"
                    stroke={FARBEN.orange} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Widget>
      );
    }

    if (id === 'stoerungen') {
      return (
        <Widget {...rahmen}>
          <div className="h-full flex flex-col gap-2">
            <p className="text-xs text-panel-muted shrink-0">
              Zeitüberschreitungen und abgebrochene Bündel aus dem Panel-Protokoll. Ein Ausschlag
              hier erklärt oft eine Delle im Durchsatz.
            </p>
            <div className="flex-1 min-h-[160px]">
              {stoerungen.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-panel-muted">
                  Keine Warnungen der KI-Kette im Zeitraum.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stoerungen}>
                    <CartesianGrid strokeDasharray="3 3" stroke={FARBEN.rand} vertical={false} />
                    <XAxis dataKey="tagKurz" {...ACHSE} />
                    <YAxis {...ACHSE} allowDecimals={false} />
                    <Tooltip contentStyle={TOOLTIP_STIL} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                    <Bar dataKey="anzahl" name="Warnungen" fill={FARBEN.orange} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </Widget>
      );
    }

    if (id === 'domains') {
      return (
        <Widget {...rahmen}>
          <Rangliste eintraege={(daten.domains || []).map((d) => ({ name: d.domain, anzahl: d.anzahl }))} />
        </Widget>
      );
    }

    if (id === 'absender') {
      return (
        <Widget {...rahmen}>
          <Rangliste eintraege={(daten.absender || []).map((a) => ({ name: a.von, anzahl: a.anzahl }))} />
        </Widget>
      );
    }

    if (id === 'zielordner') {
      return (
        <Widget {...rahmen}>
          <Rangliste eintraege={(daten.zielordner || []).map((z) => ({ name: z.ordner, anzahl: z.anzahl }))} />
        </Widget>
      );
    }

    if (id === 'regeln') {
      return (
        <Widget {...rahmen}>
          {/* Der Treffer-Zähler einer Regel hat keinen Zeitstempel — er lässt
              sich ranken, aber nicht über die Zeit auftragen. Deshalb steht
              ausdrücklich dabei, dass es Gesamtwerte sind. */}
          <Rangliste
            eintraege={(daten.regeln || []).map((r) => ({
              name: `${r.muster} → ${r.zielordner || 'bleibt liegen'}`,
              anzahl: r.treffer || 0,
            }))}
            leer="Noch keine Regel hat gegriffen."
          />
          <p className="text-[11px] text-panel-muted/70 mt-2">
            Treffer seit Anlegen der Regel — nicht auf den Zeitraum bezogen.
            {daten.newsletterOffen > 0 && ` · ${zahl(daten.newsletterOffen)} Newsletter-Absender noch nicht abbestellt.`}
          </p>
        </Widget>
      );
    }

    if (id === 'kosten') {
      return (
        <Widget {...rahmen}>
          <div className="h-full flex flex-col gap-3">
            <div className="flex-1 min-h-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: 'von der KI', value: s.vonKi || 0 },
                      { name: 'von einer Regel', value: s.vonRegel || 0 },
                    ].filter((e) => e.value > 0)}
                    dataKey="value" nameKey="name" innerRadius="45%" outerRadius="75%" paddingAngle={2}
                  >
                    <Cell fill={FARBEN.akzent} />
                    <Cell fill={FARBEN.gruen} />
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STIL} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-1 text-sm shrink-0">
              <p className="text-xs text-panel-muted">
                Jede Mail, die eine Regel erledigt, kostet keine KI-Anfrage. Der grüne Anteil ist
                also das, was die Regeln eingespart haben.
              </p>
              {daten.budget && (
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between gap-2">
                    <span className="text-panel-muted">Anbieter</span>
                    <span className="font-medium">{daten.budget.anbieter === 'ollama' ? 'Ollama (lokal)' : 'Gemini'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-panel-muted">Anfragen heute</span>
                    <span className="tabular-nums">
                      {zahl(daten.budget.heuteAnfragen)}
                      {daten.budget.grenze ? ` / ${zahl(daten.budget.grenze)}` : ''}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-panel-muted">Mails dabei</span>
                    <span className="tabular-nums">{zahl(daten.budget.heuteMails)}</span>
                  </div>
                  {daten.budget.anbieter === 'ollama' && (
                    <p className="text-[11px] text-panel-muted/70 pt-1">
                      Bei lokaler KI kostet eine Anfrage kein Geld, sondern Rechenzeit — das
                      Tagesbudget greift dort nicht.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </Widget>
      );
    }

    return null;
  };

  return (
    <div className="space-y-4">
      {/* ── Zeitraum und Postfach: gilt für alle Widgets, bleibt deshalb über
             dem Raster stehen und lässt sich nicht verschieben. ──────────── */}
      <div className="card flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-panel-border overflow-hidden">
          {ZEITRAEUME.map((z) => (
            <button
              key={z.tage}
              onClick={() => setzen('tage', z.tage === 30 ? '' : z.tage)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                tage === z.tage ? 'bg-panel-accent text-white' : 'text-panel-muted hover:text-panel-text'
              }`}
            >
              {z.label}
            </button>
          ))}
        </div>

        <select
          value={konto}
          onChange={(e) => setzen('konto', e.target.value)}
          className="text-sm bg-panel-bg w-full sm:!w-auto shrink-0"
        >
          <option value="">Alle Postfächer</option>
          {(daten?.konten || []).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>

        <span className="text-xs text-panel-muted ml-auto">
          {zahl(s.gesamt)} Einordnungen im Zeitraum
        </span>
      </div>

      {leer ? (
        <div className="card text-center text-panel-muted text-sm py-10">
          Im gewählten Zeitraum wurde nichts einsortiert. Ein größeres Fenster zeigt vielleicht mehr.
        </div>
      ) : (
        <>
          <WidgetLeiste anordnung={anordnung} />
          <WidgetRaster anordnung={anordnung} inhalt={widget} />
        </>
      )}
    </div>
  );
}
