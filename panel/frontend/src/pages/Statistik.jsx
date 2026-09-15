// Die Auswertung — vier Fragen, vier Abschnitte.
//
// Vorher: eine Karte je Postfach mit lebenslangen Gesamtzahlen, ohne Zeitraum
// und ohne Kontofilter. Alles außer vier Kategorien landete in einem grauen
// Klumpen "sonstiges" — ausgerechnet die Themen-Sortierung, also die Arbeit,
// um die es hier geht.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  Loader2, AlertCircle, Target, Gauge, AtSign, Coins, Inbox,
} from 'lucide-react';
import api from '../api';
import Karte from '../components/ui/Karte';
import { FARBEN, TOOLTIP_STIL, ACHSE, tagKurz } from '../components/ui/diagramm';

const ZEITRAEUME = [
  { tage: 7, label: '7 Tage' },
  { tage: 30, label: '30 Tage' },
  { tage: 90, label: '90 Tage' },
];

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
    <div className="card !p-4">
      <div className="flex items-center gap-2 text-xs text-panel-muted mb-1">
        <Icon size={14} className="text-panel-accent" /> {titel}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${farben[ton]}`}>{wert}</div>
      {unter && <div className="text-[11px] text-panel-muted mt-0.5">{unter}</div>}
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

  return (
    <div className="space-y-6">
      {/* ── Zeitraum und Postfach ──────────────────────────────────────────── */}
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
          {/* ── Die vier Zahlen, auf die es ankommt ────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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

          {/* ── Wie gut sortiert es? ───────────────────────────────────────── */}
          <Karte title={<><Target size={13} /> Wie gut sortiert es?</>}>
            <p className="text-xs text-panel-muted">
              Wie viel die KI entschieden hat und wie viel bereits eine Regel erledigte — und was
              danach von Hand korrigiert werden musste. Eine niedrige Korrekturzahl bei vielen
              Einordnungen ist das Ziel.
            </p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={verlauf}>
                  <CartesianGrid strokeDasharray="3 3" stroke={FARBEN.rand} vertical={false} />
                  <XAxis dataKey="tagKurz" {...ACHSE} />
                  <YAxis {...ACHSE} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STIL} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="vonKi" name="von der KI" stackId="a" fill={FARBEN.akzent} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="vonRegel" name="von einer Regel" stackId="a" fill={FARBEN.gruen} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="korrigiert" name="später korrigiert" fill={FARBEN.rot} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div>
                <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">
                  Wie sicher war die KI?
                </h3>
                <Rangliste eintraege={(daten.konfidenz || []).map((k) => ({ name: k.stufe, anzahl: k.anzahl }))} />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">
                  Häufigste Begründung
                </h3>
                <Rangliste eintraege={(daten.gruende || []).map((g) => ({ name: g.grund, anzahl: g.anzahl }))} />
              </div>
            </div>
          </Karte>

          {/* ── Wie viel läuft durch? ──────────────────────────────────────── */}
          <Karte title={<><Gauge size={13} /> Wie viel läuft durch?</>}>
            <p className="text-xs text-panel-muted">
              Menge je Tag und daneben, woran es hakte: Zeitüberschreitungen und abgebrochene Bündel
              aus dem Panel-Protokoll. Ein Ausschlag rechts erklärt oft eine Delle links.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="h-52">
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
              <div className="h-52">
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
          </Karte>

          {/* ── Wer schreibt mir? ──────────────────────────────────────────── */}
          <Karte title={<><AtSign size={13} /> Wer schreibt mir?</>}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">Domains</h3>
                <Rangliste eintraege={(daten.domains || []).map((d) => ({ name: d.domain, anzahl: d.anzahl }))} />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">Absender</h3>
                <Rangliste eintraege={(daten.absender || []).map((a) => ({ name: a.von, anzahl: a.anzahl }))} />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">Zielordner</h3>
                <Rangliste eintraege={(daten.zielordner || []).map((z) => ({ name: z.ordner, anzahl: z.anzahl }))} />
              </div>
            </div>

            <div className="pt-2 border-t border-panel-border/50">
              <h3 className="text-xs font-semibold text-panel-muted uppercase tracking-wide mb-2">
                Regeln, die am meisten greifen
              </h3>
              {/* Der Treffer-Zähler einer Regel hat keinen Zeitstempel — er
                  lässt sich ranken, aber nicht über die Zeit auftragen.
                  Deshalb steht ausdrücklich dabei, dass es Gesamtwerte sind. */}
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
            </div>
          </Karte>

          {/* ── Was kostet es? ─────────────────────────────────────────────── */}
          <Karte title={<><Coins size={13} /> Was kostet es?</>}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'von der KI', value: s.vonKi || 0 },
                        { name: 'von einer Regel', value: s.vonRegel || 0 },
                      ].filter((e) => e.value > 0)}
                      dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}
                    >
                      <Cell fill={FARBEN.akzent} />
                      <Cell fill={FARBEN.gruen} />
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STIL} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="space-y-3 text-sm">
                <p className="text-xs text-panel-muted">
                  Jede Mail, die eine Regel erledigt, kostet keine KI-Anfrage. Der grüne Anteil ist
                  also das, was die Regeln eingespart haben.
                </p>
                {daten.budget && (
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-panel-muted">Anbieter</span>
                      <span className="font-medium">{daten.budget.anbieter === 'ollama' ? 'Ollama (lokal)' : 'Gemini'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-panel-muted">Anfragen heute</span>
                      <span className="tabular-nums">
                        {zahl(daten.budget.heuteAnfragen)}
                        {daten.budget.grenze ? ` / ${zahl(daten.budget.grenze)}` : ''}
                      </span>
                    </div>
                    <div className="flex justify-between">
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
          </Karte>
        </>
      )}
    </div>
  );
}
