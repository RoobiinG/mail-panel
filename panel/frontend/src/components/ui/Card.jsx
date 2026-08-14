// Karten-Baustein, identisch zum Überwachungs-Panel.
export const Card = ({ children, className = '', title, action, accent = false }) => (
  <div className={`bg-panel-card border border-panel-border rounded-lg overflow-hidden ${accent ? 'border-t-2 border-t-panel-accent' : ''} ${className}`}>
    {title && (
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-panel-border bg-panel-surface/40">
        <h3 className="text-xs font-semibold text-panel-text uppercase tracking-wide">{title}</h3>
        {action && <div>{action}</div>}
      </div>
    )}
    <div className="p-4">{children}</div>
  </div>
);
