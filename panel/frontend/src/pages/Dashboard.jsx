import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import api from '../api';

const COLORS = {
  Clean: '#10B981', // emerald-500
  Spam: '#F59E0B',  // amber-500
  Phishing: '#EF4444', // red-500
  Viren: '#8B5CF6'  // violet-500
};

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [n8n, setN8n] = useState(null);
  const [aufsicht, setAufsicht] = useState(null);
  const [loading, setLoading] = useState(true);

  const laden = async () => {
    try {
      const [stRes, n8nRes, aufRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/dashboard/n8n-status'),
        // Die Aufsicht darf das Dashboard nicht mitreißen, wenn sie klemmt.
        api.get('/aufsicht').catch(() => ({ data: null })),
      ]);
      setStats(stRes.data);
      setN8n(n8nRes.data);
      setAufsicht(aufRes.data);
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
