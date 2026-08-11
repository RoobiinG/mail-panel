import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// ─── Globaler Fehler-Handler: meldet JS-Fehler an das Backend ────────────────
// Kein eigenes UI — die Fehler tauchen in der Panel-Logs-Seite auf.
function fehlerMelden(nachricht, stack) {
  try {
    fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nachricht: String(nachricht).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 5000) : null,
        url: window.location.href,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => { /* Netzwerkfehler ignorieren */ });
  } catch { /* Stille Fehler */ }
}

window.onerror = (msg, source, line, col, err) => {
  fehlerMelden(
    `${msg} (${source}:${line}:${col})`,
    err?.stack || null,
  );
};

window.onunhandledrejection = (event) => {
  const reason = event.reason;
  fehlerMelden(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : null,
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
