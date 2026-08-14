// Dialog-Baustein, identisch zum Überwachungs-Panel.
import { X } from 'lucide-react';
import { useEffect } from 'react';

export const Modal = ({ open, onClose, title, children, footer, zIndex = 'z-50' }) => {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    if (open) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={`fixed inset-0 ${zIndex} flex items-center justify-center`}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-panel-card border border-panel-border rounded-lg shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border">
          <h2 className="text-sm font-semibold text-panel-text">{title}</h2>
          <button onClick={onClose} className="text-panel-muted hover:text-panel-text transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-panel-border flex justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
};
