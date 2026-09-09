import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Loader2, AlertCircle, BarChart3, Inbox, ArrowRightLeft, Target } from 'lucide-react';
import api from '../api';

const COLORS = {
  clean: '#10b981', // emerald-500
  spam: '#ef4444', // red-500
  phishing: '#a855f7', // purple-500
  newsletter: '#3b82f6', // blue-500
  sonstiges: '#6b7280' // gray-500
};

export default function Statistik() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ladeDaten = async () => {
      try {
        const res = await api.get('/statistik');
        setData(res.data.konten || []);
      } catch (err) {
        setError(err.message || 'Fehler beim Laden der Statistiken');
      } finally {
        setLoading(false);
      }
    };
    ladeDaten();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="animate-spin text-panel-accent" size={24} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-panel-red/10 border border-panel-red/20 rounded-md text-panel-red text-sm flex items-center gap-2">
        <AlertCircle size={16} />
        {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="p-8 text-center text-panel-muted text-sm border border-panel-border rounded-lg bg-panel-surface">
        Es liegen noch keine Statistiken vor.
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-black tracking-tight text-white/95 flex items-center gap-3">
          <div className="p-2 bg-panel-accent/10 rounded-lg border border-panel-accent/20">
            <BarChart3 size={24} className="text-panel-accent" />
          </div>
          Statistiken
        </h1>
        <p className="text-sm text-panel-muted ml-12">Performance und Auswertung aller Postfächer im Detail</p>
      </div>

      {data.map((konto) => {
        const pieData = Object.entries(konto.kategorien)
          .map(([key, value]) => ({ name: key, value }))
          .filter(d => d.value > 0);

        const barData = [
          { name: 'Offen', anzahl: konto.sortInbox.offen, fill: '#f59e0b' },
          { name: 'Zugeordnet', anzahl: konto.sortInbox.zugeordnet, fill: '#10b981' },
          { name: 'Ignoriert', anzahl: konto.sortInbox.ignoriert, fill: '#6b7280' }
        ];

        return (
          <div key={konto.name} className="card card-hover relative overflow-hidden flex flex-col space-y-6 !p-6">
            {/* Background Glows */}
            <div className="absolute -left-12 -top-12 w-48 h-48 rounded-full blur-3xl opacity-5 bg-panel-accent pointer-events-none" />
            <div className="absolute -right-12 -bottom-12 w-48 h-48 rounded-full blur-3xl opacity-5 bg-emerald-500 pointer-events-none" />

            <div className="flex justify-between items-center relative z-10 border-b border-white/5 pb-4">
              <h2 className="text-lg font-bold text-white tracking-wide">{konto.name}</h2>
              <span className="px-3 py-1 rounded-full bg-panel-surface/50 border border-white/10 text-xs font-medium text-panel-muted shadow-inner">
                {konto.gesamtMails} klassifiziert
              </span>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 relative z-10">
              
              {/* KI-Kategorien (Pie Chart) */}
              <div className="col-span-1 lg:col-span-2 bg-black/20 rounded-xl p-5 border border-white/5">
                <h3 className="text-[11px] font-bold tracking-widest text-panel-muted/70 uppercase mb-4 flex items-center gap-2">
                  <Inbox size={14} className="text-panel-accent" /> Klassifizierungen
                </h3>
                {pieData.length > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          innerRadius={55}
                          outerRadius={85}
                          paddingAngle={3}
                          dataKey="value"
                          stroke="none"
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[entry.name] || COLORS.sonstiges} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#1a1d24', border: '1px solid #333', borderRadius: '8px' }}
                          itemStyle={{ color: '#eee', fontSize: '13px', fontWeight: 500 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-3 mt-4">
                      {pieData.map(d => (
                        <div key={d.name} className="flex items-center gap-1.5 text-[11px] font-medium text-panel-muted uppercase bg-white/5 px-2 py-1 rounded-md">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[d.name] || COLORS.sonstiges }}></span>
                          {d.name} <span className="text-white/50 ml-1">{d.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="h-56 flex items-center justify-center text-sm text-panel-muted/50 font-medium">
                    Keine Daten vorhanden
                  </div>
                )}
              </div>

              {/* Unbekannte / Sort-Inbox (Bar Chart) */}
              <div className="col-span-1 lg:col-span-2 bg-black/20 rounded-xl p-5 border border-white/5">
                <h3 className="text-[11px] font-bold tracking-widest text-panel-muted/70 uppercase mb-4 flex items-center gap-2">
                  <ArrowRightLeft size={14} className="text-amber-500" /> Unbekannte Sender
                </h3>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="barOffen" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.2}/>
                        </linearGradient>
                        <linearGradient id="barZugeordnet" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.2}/>
                        </linearGradient>
                        <linearGradient id="barIgnoriert" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6b7280" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="#6b7280" stopOpacity={0.2}/>
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#8b949e', fontWeight: 500 }} axisLine={false} tickLine={false} dy={5} />
                      <YAxis tick={{ fontSize: 11, fill: '#8b949e', fontWeight: 500 }} axisLine={false} tickLine={false} dx={-5} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#1a1d24', border: '1px solid #333', borderRadius: '8px', fontSize: '13px', fontWeight: 500 }}
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      />
                      <Bar dataKey="anzahl" radius={[4, 4, 0, 0]}>
                        {barData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={`url(#bar${entry.name})`} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Metriken */}
              <div className="col-span-1 lg:col-span-4 grid grid-cols-2 gap-4 mt-2">
                <div className="bg-gradient-to-br from-panel-surface/60 to-transparent border border-white/5 rounded-xl p-4 text-center group transition-all duration-300 hover:border-white/10 hover:shadow-lg">
                  <div className="text-[10px] font-bold tracking-widest text-panel-muted/70 uppercase mb-2">Gereinigter Bestand</div>
                  <div className="text-3xl font-black text-white/90 drop-shadow-sm group-hover:scale-105 transition-transform">{konto.bestandErledigt}</div>
                </div>
                <div className="bg-gradient-to-br from-panel-accent/10 to-transparent border border-panel-accent/20 rounded-xl p-4 text-center group transition-all duration-300 hover:border-panel-accent/40 hover:shadow-[0_0_20px_rgba(56,139,253,0.1)]">
                  <div className="text-[10px] font-bold tracking-widest text-panel-accent uppercase flex items-center justify-center gap-1.5 mb-2">
                    <Target size={12} /> Regel-Treffer
                  </div>
                  <div className="text-3xl font-black text-panel-accent drop-shadow-sm group-hover:scale-105 transition-transform">{konto.regelTreffer}</div>
                </div>
              </div>

            </div>
          </div>
        );
      })}
    </div>
  );
}
