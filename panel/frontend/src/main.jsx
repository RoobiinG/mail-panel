import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// ─── Globaler Fehler-Handler: meldet JS-Fehler an das Backend ────────────────
// Kein eigenes UI — die Fehler tauchen in der Panel-Logs-Seite auf.
function fehlerMelden(message, stack, source = 'JavaScript') {
  try {
    fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        message: String(message).slice(0, 2000),
        stack:   stack ? String(stack).slice(0, 5000) : null,
        url:     window.location.href,
      }),
    }).catch(() => { /* Netzwerkfehler ignorieren */ });
  } catch { /* Stille Fehler */ }
}

window.onerror = (msg, src, line, col, err) => {
  fehlerMelden(
    `${msg} (${src}:${line}:${col})`,
    err?.stack || null,
    'JavaScript',
  );
};

window.onunhandledrejection = (event) => {
  const reason = event.reason;
  fehlerMelden(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack   : null,
    'Promise',
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
