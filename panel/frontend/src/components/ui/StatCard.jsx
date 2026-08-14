// Kennzahl-Kachel, identisch zum Überwachungs-Panel.
const colorMap = {
  blue: 'text-panel-accent',
  green: 'text-panel-green',
  red: 'text-panel-red',
  orange: 'text-panel-orange',
  purple: 'text-panel-purple',
};

const barColor = (pct) =>
  pct > 80 ? 'bg-panel-red' : pct > 60 ? 'bg-panel-orange' : 'bg-panel-accent';

export const StatCard = ({ title, value, unit, icon: Icon, color = 'blue', subtitle, percent }) => (
  <div className="bg-panel-card border border-panel-border rounded-lg p-4">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs text-panel-muted mb-1">{title}</p>
        <p className={`text-2xl font-bold ${colorMap[color]}`}>
          {value}
          <span className="text-sm font-normal text-panel-muted ml-1">{unit}</span>
        </p>
        {subtitle && <p className="text-xs text-panel-muted mt-1">{subtitle}</p>}
      </div>
      {Icon && (
        <div className={`p-2 rounded-lg bg-panel-surface ${colorMap[color]}`}>
          <Icon size={18} />
        </div>
      )}
    </div>
    {percent !== undefined && (
      <div className="mt-3">
        <div className="h-1.5 bg-panel-surface rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor(percent)}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      </div>
    )}
  </div>
);
