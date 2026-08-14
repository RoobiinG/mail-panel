// Statusmarke, identisch zum Überwachungs-Panel.
const colors = {
  green: 'bg-panel-green/20 text-panel-green border-panel-green/30',
  red: 'bg-panel-red/20 text-panel-red border-panel-red/30',
  blue: 'bg-panel-accent/20 text-panel-accent border-panel-accent/30',
  orange: 'bg-panel-orange/20 text-panel-orange border-panel-orange/30',
  purple: 'bg-panel-purple/20 text-panel-purple border-panel-purple/30',
  gray: 'bg-panel-muted/20 text-panel-muted border-panel-muted/30',
};

export const Badge = ({ children, color = 'gray', className = '' }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors[color]} ${className}`}>
    {children}
  </span>
);
