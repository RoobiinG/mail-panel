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
        const res = await api.get('/api/statistik');
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
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <BarChart3 size={20} className="text-panel-accent" /> Statistiken
      </h1>

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
          <div key={konto.name} className="bg-panel-card border border-panel-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-panel-border bg-panel-surface/50 font-medium text-sm flex justify-between items-center">
              <span>{konto.name}</span>
              <span className="text-xs text-panel-muted font-normal">Gesamt: {konto.gesamtMails} klassifiziert</span>
            </div>
            
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              
              {/* KI-Kategorien (Pie Chart) */}
              <div className="col-span-1 lg:col-span-2 border border-panel-border/50 rounded p-4 bg-panel-darker/30">
                <h3 className="text-xs font-semibold text-panel-muted uppercase mb-4 flex items-center gap-1">
                  <Inbox size={12} /> Klassifizierungen
                </h3>
                {pieData.length > 0 ? (
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          innerRadius={40}
                          outerRadius={70}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[entry.name] || COLORS.sonstiges} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#1a1d24', border: '1px solid #333', borderRadius: '4px' }}
                          itemStyle={{ color: '#eee', fontSize: '12px' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-3 mt-2">
                      {pieData.map(d => (
                        <div key={d.name} className="flex items-center gap-1.5 text-[10px] text-panel-muted uppercase">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[d.name] || COLORS.sonstiges }}></span>
                          {d.name} ({d.value})
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="h-48 flex items-center justify-center text-xs text-panel-muted/50">
                    Keine Daten vorhanden
                  </div>
                )}
              </div>

              {/* Unbekannte / Sort-Inbox (Bar Chart) */}
              <div className="col-span-1 lg:col-span-2 border border-panel-border/50 rounded p-4 bg-panel-darker/30">
                <h3 className="text-xs font-semibold text-panel-muted uppercase mb-4 flex items-center gap-1">
                  <ArrowRightLeft size={12} /> Unbekannte Sender
                </h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#888' }} axisLine={false} tickLine={false} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#1a1d24', border: '1px solid #333', borderRadius: '4px', fontSize: '12px' }}
                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                      />
                      <Bar dataKey="anzahl" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Metriken */}
              <div className="col-span-1 lg:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-panel-darker/50 border border-panel-border/40 rounded p-3 text-center">
                  <div className="text-[10px] text-panel-muted uppercase mb-1">Gereinigter Bestand</div>
                  <div className="text-xl font-bold text-panel-text">{konto.bestandErledigt}</div>
                </div>
                <div className="bg-panel-darker/50 border border-panel-border/40 rounded p-3 text-center">
                  <div className="text-[10px] text-panel-muted uppercase flex items-center justify-center gap-1 mb-1">
                    <Target size={10} /> Regel-Treffer
                  </div>
                  <div className="text-xl font-bold text-panel-accent">{konto.regelTreffer}</div>
                </div>
              </div>

            </div>
          </div>
        );
      })}
    </div>
  );
}
