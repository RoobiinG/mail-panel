// Zentraler Log-Service fuer das Mail-Panel.
// Faengt Backend-Fehler, Frontend-Fehler und Container-Status-Probleme.
// Ring-Buffer: maximal MAX_EINTRAEGE in der DB, aeltere werden geloescht.
const db = require('../db');

const MAX_EINTRAEGE = 1000;

// ─── Prepared Statements ─────────────────────────────────────────────────────

const stmtEinfuegen = db.prepare(`
  INSERT INTO panel_logs (level, quelle, nachricht, stack, request_url, request_method)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtAufraumen = db.prepare(`
  DELETE FROM panel_logs WHERE id NOT IN (
    SELECT id FROM panel_logs ORDER BY created_at DESC LIMIT ?
  )
`);

const stmtAnzahl = db.prepare('SELECT COUNT(*) AS n FROM panel_logs');

// ─── Zentrale Log-Funktion ───────────────────────────────────────────────────

/**
 * Schreibt einen Log-Eintrag in die Datenbank.
 * @param {'error'|'warn'|'info'} level
 * @param {string} quelle  z.B. "backend:routes/konten", "frontend", "container:clamav"
 * @param {string} nachricht
 * @param {object} [details]  Optionale Details: stack, requestUrl, requestMethod
 */
function loggen(level, quelle, nachricht, details = {}) {
  try {
    stmtEinfuegen.run(
      level,
      quelle || null,
      String(nachricht).slice(0, 5000),
      details.stack ? String(details.stack).slice(0, 10000) : null,
      details.requestUrl || null,
      details.requestMethod || null,
    );

    // Ring-Buffer: bei jedem 10. Eintrag aufraumen (nicht bei jedem Schreiben)
    const { n } = stmtAnzahl.get();
    if (n > MAX_EINTRAEGE + 100) {
      stmtAufraumen.run(MAX_EINTRAEGE);
    }
  } catch (err) {
    // Letzter Ausweg: auf die Konsole schreiben, damit nichts verloren geht
    console.error('[panelLog] Konnte nicht in DB loggen:', err.message);
    console.error(`[panelLog] Ursprungsfehler: [${level}] ${quelle}: ${nachricht}`);
  }
}

// ─── Process-Error-Handler ───────────────────────────────────────────────────
// Faengt unbehandelte Fehler, damit sie nicht nur in der Konsole verschwinden.

process.on('uncaughtException', (err) => {
  loggen('error', 'backend:uncaughtException', err.message, { stack: err.stack });
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  const nachricht = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  loggen('error', 'backend:unhandledRejection', nachricht, { stack });
  console.error('[unhandledRejection]', reason);
});

// ─── Express Error-Handler (als Middleware) ──────────────────────────────────
// Wird in index.js als letztes app.use() registriert.

function expressErrorHandler(err, req, res, _next) {
  loggen('error', `backend:${req.method} ${req.path}`, err.message, {
    stack: err.stack,
    requestUrl: req.originalUrl,
    requestMethod: req.method,
  });
  console.error(`[Express-Fehler] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: 'Interner Serverfehler' });
}

// ─── Container-Health-Check ──────────────────────────────────────────────────
// Prueft periodisch, ob ClamAV und unbound erreichbar sind.

let healthCheckInterval = null;

function containerHealthCheckStarten(intervallMs = 5 * 60 * 1000) {
  // Beim Start einmal sofort pruefen (verzoegert, damit die Container hochfahren koennen)
  setTimeout(() => containerHealthCheck(), 30000);
  healthCheckInterval = setInterval(() => containerHealthCheck(), intervallMs);
}

async function containerHealthCheck() {
  // ClamAV pruefen
  try {
    const clamav = require('./clamav');
    const ergebnis = await clamav.ping();
    if (!ergebnis) {
      loggen('warn', 'container:clamav', 'ClamAV antwortet nicht auf PING');
    }
  } catch (err) {
    loggen('warn', 'container:clamav', `ClamAV nicht erreichbar: ${err.message}`);
  }

  // unbound/DNS pruefen
  try {
    const dns = require('dns');
    const resolver = new dns.Resolver();
    // unbound laeuft im Docker-Netz unter dem Hostnamen "unbound"
    const unboundIp = await new Promise((resolve, reject) => {
      dns.lookup('unbound', (err, addr) => err ? reject(err) : resolve(addr));
    });
    resolver.setServers([unboundIp]);
    await new Promise((resolve, reject) => {
      resolver.resolve4('example.com', (err, addrs) => err ? reject(err) : resolve(addrs));
    });
  } catch (err) {
    loggen('warn', 'container:unbound', `DNS-Resolver nicht erreichbar: ${err.message}`);
  }
}

module.exports = {
  loggen,
  expressErrorHandler,
  containerHealthCheckStarten,
  containerHealthCheck,
};
