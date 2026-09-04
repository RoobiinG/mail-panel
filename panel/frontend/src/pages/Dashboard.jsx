import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import {
  AlertTriangle, Inbox, Gauge, ShieldCheck, HardDriveDownload, Target,
  CheckCircle2, XCircle, Workflow, ArrowRight, Archive,
} from 'lucide-react';
import api from '../api';

const COLORS = {
  Clean: '#10B981', // emerald-500
  Spam: '#F59E0B',  // amber-500
  Phishing: '#EF4444', // red-500
  Viren: '#8B5CF6'  // violet-500
};

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

// Eine Statuskachel: Farbe und Symbol sagen auf einen Blick, ob es gut steht.
function StatusKachel({ icon: Icon, titel, wert, unter, ton = 'neutral' }) {
  const toene = {
    gut:     'border-emerald-500/30 bg-emerald-500/5',
    warnung: 'border-yellow-600/40 bg-yellow-500/5',
    schlecht:'border-panel-red/40 bg-panel-red/5',
    neutral: 'border-panel-border',
  };
  const icons = {
    gut: 'text-emerald-500', warnung: 'text-yellow-500',
    schlecht: 'text-panel-red', neutral: 'text-panel-accent',
  };
  return (
    <div className={`card !p-4 border ${toene[ton]}`}>
      <div className="flex items-center gap-2 text-xs text-panel-muted mb-1">
        <Icon size={15} className={icons[ton]} /> {titel}
      </div>
      <div className="text-2xl font-bold text-panel-text leading-tight">{wert}</div>
      {unter && <div className="text-[11px] text-panel-muted mt-0.5">{unter}</div>}
    </div>
  );
}

// Ein schmaler Fortschrittsbalken.
function Balken({ anteil, ton = 'accent' }) {
  const farbe = { accent: 'bg-panel-accent', warnung: 'bg-yellow-500', rot: 'bg-panel-red', gruen: 'bg-emerald-500' }[ton];
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
  const [loading, setLoading] = useState(true);

  const laden = async () => {
    try {
      const [stRes, n8nRes, aufRes, ueRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/dashboard/n8n-status'),
        // Die Aufsicht darf das Dashboard nicht mitreißen, wenn sie klemmt.
        api.get('/aufsicht').catch(() => ({ data: null })),
        // Die Übersicht fragt Postfächer ab und kann kurz dauern — sie darf den
        // Rest nicht aufhalten und nicht scheitern lassen.
        api.get('/dashboard/uebersicht').catch(() => ({ data: null })),
      ]);
      setStats(stRes.data);
      setN8n(n8nRes.data);
      setAufsicht(aufRes.data);
      setUebersicht(ueRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { laden(); }, []);

  if (loading) return <div className="p-6 text-panel-muted">Lade Dashboard...</div>;
  if (!stats || !stats.summen) return <div className="p-6 text-panel-red">Fehler beim Laden der Dashboard-Statistiken. Bitte überprüfe die Verbindung zur Datenbank oder die Logs.</div>;

  const pieData = [
    { name: 'Spam', value: stats.summen.spam },
    { name: 'Phishing', value: stats.summen.phishing },
    { name: 'Viren', value: stats.summen.viren },
    { name: 'Clean', value: stats.summen.whitelist }
  ].filter(d => d.value > 0);

  // Was die Aufsicht zuletzt gefunden hat. Ein Ausfall soll ins Auge fallen —
  // sechs Tage stille Sortierpause waren genug.
  const befund = aufsicht?.letzterLauf;
  const stoerung = befund && befund.ok === false;

  return (
    <div className="space-y-6">
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
        <div className="card border-yellow-600/60 flex items-start gap-3 text-sm">
          <AlertTriangle size={18} className="text-yellow-500 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Wieder eingeschaltet:</span>{' '}
            {befund.repariert.join(', ')} — war ausgefallen und läuft jetzt wieder.
          </div>
        </div>
      )}

      <div className="flex justify-between items-end">
        <div>
          <p className="text-sm text-panel-muted mt-1">Überblick der letzten 30 Tage</p>
        </div>
        
        {n8n && (
          <div className={`px-4 py-2 rounded flex items-center gap-3 ${n8n.online ? 'bg-panel-darker border border-emerald-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
            <div className={`w-3 h-3 rounded-full ${n8n.online ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500'}`} />
            <div>
              <div className="text-xs font-semibold text-panel-text">n8n Engine</div>
              <div className="text-[10px] text-panel-muted">{n8n.online ? `${n8n.activeWorkflows} Workflows aktiv` : 'Offline'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Betrieb & Sortierung — der tägliche Blick */}
      {uebersicht && (() => {
        const u = uebersicht;
        const auf = u.aufsicht;
        const aufTon = !auf ? 'neutral' : (auf.ok ? 'gut' : 'schlecht');
        const aufWert = !auf ? '—' : (auf.n8nErreichbar === false ? 'n8n weg'
          : auf.ok ? 'Alles läuft' : `${auf.abweichungen?.filter(a => !a.behoben).length || 0} Störung`);
        const sich = u.sicherung;
        const sichTon = !sich?.eingerichtet ? 'warnung' : (sich.letzter?.ok ? 'gut' : (sich.letzter ? 'schlecht' : 'neutral'));
        const quote = u.lernen.trefferquote;
        const b = u.budget;
        const budgetAnteil = b.grenze ? (b.heute / b.grenze) * 100 : 0;
        const bl = u.belege;
        // Bestands-Triage: laeuft der Zeitplan und ist der letzte Lauf lange her,
        // stimmt etwas nicht — dann faellt die Kachel auf.
        const bes = u.bestand;
        const besAlterStd = bes?.letzterLauf
          ? (Date.now() - new Date(bes.letzterLauf).getTime()) / 3600000 : null;
        const besTon = !bes?.letzterLauf ? 'neutral'
          : (bes.intervallStunden > 0 && besAlterStd > bes.intervallStunden * 2) ? 'warnung' : 'gut';
        const leseAnteil = bl?.leseGrenze ? (bl.gelesenHeute / bl.leseGrenze) * 100 : 0;

        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatusKachel icon={ShieldCheck} titel="Aufsicht" ton={aufTon} wert={aufWert}
                unter={auf ? `zuletzt ${new Date(auf.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'noch nicht geprüft'} />
              <StatusKachel icon={Target} titel="Trefferquote (7 T.)"
                ton={quote == null ? 'neutral' : quote >= 90 ? 'gut' : quote >= 75 ? 'warnung' : 'schlecht'}
                wert={quote == null ? '—' : `${quote} %`}
                unter={`${u.lernen.einordnungen7} einsortiert, ${u.lernen.korrigiert7} korrigiert`} />
              <StatusKachel icon={HardDriveDownload} titel="Sicherung" ton={sichTon}
                wert={!sich?.eingerichtet ? 'offen' : sich.letzter?.ok ? 'aktuell' : sich.letzter ? 'Fehler' : 'bereit'}
                unter={sich?.letzter ? `${sich.letzter.mails} Mails, ${new Date(sich.letzter.zeitpunkt).toLocaleDateString('de-DE')}` : 'kein Lauf'} />
              <StatusKachel icon={Inbox} titel="Wartet auf dich"
                ton={u.posteingang.offeneEntscheidungen > 0 ? 'warnung' : 'gut'}
                wert={u.posteingang.offeneEntscheidungen}
                unter="Mails ohne Zuordnung" />
              <StatusKachel icon={Workflow} titel="Bestand sortiert" ton={besTon}
                wert={bes?.letzterLauf ? seit(bes.letzterLauf) : 'nie'}
                unter={bes?.letzterLauf
                  ? `${bes.verarbeitet} von ${bes.gesamt} an die KI · ${new Date(bes.letzterLauf).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                  : (bes?.intervallStunden > 0 ? `Zeitplan: alle ${bes.intervallStunden} h` : 'noch nie gelaufen')} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Sortier-Fortschritt je Postfach */}
              <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Inbox size={16} className="text-panel-accent" /> Sortier-Rückstand
                </h2>
                {u.posteingang.konten.length === 0 ? (
                  <p className="text-sm text-panel-muted">Kein Postfach eingerichtet.</p>
                ) : (
                  <div className="space-y-3">
                    {u.posteingang.konten.map((k) => (
                      <div key={k.konto_id}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium">{k.konto}</span>
                          <span className={k.erreichbar ? 'text-panel-muted' : 'text-panel-red'}>
                            {k.erreichbar ? `${k.wartend} im Posteingang` : 'nicht erreichbar'}
                          </span>
                        </div>
                        {k.erreichbar && (
                          <Balken anteil={k.wartend === 0 ? 100 : Math.max(4, 100 - Math.min(100, k.wartend))}
                            ton={k.wartend === 0 ? 'gruen' : k.wartend > 50 ? 'warnung' : 'accent'} />
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-panel-muted pt-1">
                      Der Posteingang leert sich, während die Sortierung läuft. Ein voller
                      Balken heißt: nichts liegt mehr ungeordnet.
                    </p>
                  </div>
                )}
              </div>

              {/* KI-Tagesbudget */}
              <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Gauge size={16} className="text-panel-accent" /> KI-Tagesbudget
                </h2>
                {b.grenze ? (
                  <div className="space-y-2">
                    <div className="flex justify-between items-end">
                      <span className="text-2xl font-bold">{b.heute}
                        <span className="text-sm text-panel-muted font-normal"> / {b.grenze}</span></span>
                      <span className="text-xs text-panel-muted">{b.rest} übrig heute</span>
                    </div>
                    <Balken anteil={budgetAnteil} ton={b.ausgeschoepft ? 'rot' : budgetAnteil > 80 ? 'warnung' : 'accent'} />
                    <p className="text-xs text-panel-muted pt-1">
                      {b.ausgeschoepft
                        ? 'Heutiges Budget aufgebraucht — die Sortierung eines großen Bestands macht morgen weiter.'
                        : 'So viele Mails ordnet die KI heute noch ein. Schützt das Gemini-Tageslimit.'}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-panel-muted">
                    Kein Tagesbudget gesetzt — die KI ordnet ohne Deckel ein. Unter
                    <span className="font-mono text-panel-accent"> Einstellungen</span> begrenzbar.
                  </p>
                )}
              </div>
            </div>

            {/* Belege in Nextcloud */}
            {bl && (
              <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Archive size={16} className="text-panel-accent" /> Belege in Nextcloud
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <div className="text-2xl font-bold text-emerald-500">{bl.heute}</div>
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
          </div>
        );
      })()}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Gescannte E-Mails', val: stats.summen.total, color: 'text-blue-400' },
          { label: 'Spam geblockt', val: stats.summen.spam, color: 'text-amber-500' },
          { label: 'Phishing erkannt', val: stats.summen.phishing, color: 'text-red-500' },
          { label: 'Viren isoliert', val: stats.summen.viren, color: 'text-violet-500' },
        ].map((kpi, i) => (
          <div key={i} className="card relative overflow-hidden group">
            <div className="text-sm font-medium text-panel-muted mb-1">{kpi.label}</div>
            <div className={`text-3xl font-black ${kpi.color}`}>{kpi.val}</div>
            <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:opacity-10 transition-opacity text-8xl">#</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar Chart */}
        <div className="lg:col-span-2 card">
          <h2 className="text-lg font-semibold mb-6">Tagesverlauf (30 Tage)</h2>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.history} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="tag" tick={{fill: '#6b7280', fontSize: 12}} tickFormatter={(v) => v.split('-').slice(1).join('.')} axisLine={false} tickLine={false} />
                <YAxis tick={{fill: '#6b7280', fontSize: 12}} axisLine={false} tickLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#374151', borderRadius: '8px', color: '#f3f4f6' }}
                  itemStyle={{ fontSize: '13px' }}
                />
                <Bar dataKey="Clean" stackId="a" fill={COLORS.Clean} radius={[0, 0, 4, 4]} />
                <Bar dataKey="Spam" stackId="a" fill={COLORS.Spam} />
                <Bar dataKey="Phishing" stackId="a" fill={COLORS.Phishing} />
                <Bar dataKey="Viren" stackId="a" fill={COLORS.Viren} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart */}
        <div className="card flex flex-col">
          <h2 className="text-lg font-semibold mb-2">Verteilung</h2>
          <div className="flex-1 min-h-[250px]">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%" cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[entry.name]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#374151', borderRadius: '8px', color: '#f3f4f6' }}
                    itemStyle={{ fontSize: '14px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-panel-muted text-sm">
                Keine Daten
              </div>
            )}
          </div>
          
          <div className="flex flex-wrap justify-center gap-4 mt-2">
            {pieData.map(d => (
              <div key={d.name} className="flex items-center gap-2 text-xs text-panel-muted">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[d.name] }} />
                {d.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
