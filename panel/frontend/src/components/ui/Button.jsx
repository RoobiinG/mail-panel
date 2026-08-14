// Knopf-Baustein, identisch zum Überwachungs-Panel.
const variants = {
  primary: 'bg-panel-accent hover:bg-blue-500 text-white shadow-sm',
  danger:  'bg-panel-red hover:bg-red-500 text-white shadow-sm',
  success: 'bg-panel-green hover:bg-green-500 text-white shadow-sm',
  ghost:   'bg-transparent hover:bg-panel-card text-panel-text border border-panel-border hover:border-panel-muted/50',
  warning: 'bg-panel-orange hover:bg-yellow-500 text-black shadow-sm',
};

const sizes = {
  sm: 'px-2 py-1 text-xs gap-1',
  md: 'px-3 py-1.5 text-sm gap-1.5',
  lg: 'px-4 py-2 text-sm gap-2',
};

export const Button = ({ children, variant = 'primary', size = 'md', className = '', disabled, onClick, type = 'button' }) => (
  <button
    type={type}
    disabled={disabled}
    onClick={onClick}
    className={`inline-flex items-center justify-center ${variants[variant]} ${sizes[size]} rounded-md font-medium
      transition-all duration-150
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-panel-bg
      disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none
      ${className}`}
  >
    {children}
  </button>
);
