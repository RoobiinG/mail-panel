require('dotenv').config();
// Schlüssel bereitstellen, bevor irgendetwas sie liest (erzeugt sie beim
// Erststart selbst, damit die Installation ohne .env auskommt)
require('./secrets').laden();

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const auth         = require('./middleware/auth');
const { rechtErforderlich } = require('./middleware/auth');
const internalAuth = require('./middleware/internalAuth');
const { router: passkeysRoutes } = require('./routes/passkeys');
const { router: logsRoutes, clientError } = require('./routes/logs');
const panelLog = require('./services/panelLog');

const app = express();
// Reverse Proxy (Nginx Proxy Manager) fuer korrekte Client-IPs und express-rate-limit vertrauen
app.set('trust proxy', 1);

// CORS: Frontend wird vom selben Origin ausgeliefert — Cross-Origin bleibt aus
app.use(cors({ origin: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ─── Routen ──────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/konten', auth, rechtErforderlich('konten'), require('./routes/konten'));
app.use('/api/listen', auth, rechtErforderlich('listen'), require('./routes/listen'));
app.use('/api/einstellungen', auth, rechtErforderlich('einstellungen'), require('./routes/einstellungen'));
app.use('/api/passkeys', auth, passkeysRoutes); // eigene Auth-Logik
app.use('/api/quarantaene', auth, rechtErforderlich('quarantaene'), require('./routes/quarantaene'));
app.use('/api/rspamd', auth, rechtErforderlich('rspamd'), require('./routes/rspamd'));
app.use('/api/newsletter', auth, rechtErforderlich('newsletter'), require('./routes/newsletter'));
app.use('/api/dashboard', auth, rechtErforderlich('dashboard'), require('./routes/dashboard'));
app.use('/api/benutzer', auth, rechtErforderlich('benutzer'), require('./routes/benutzer'));
app.use('/api/rollen', auth, rechtErforderlich('benutzer'), require('./routes/rollen'));
app.use('/api/sortierung', auth, rechtErforderlich('sortierung'), require('./routes/sortierung'));

// Panel-Logs
app.post('/api/logs/client', express.json(), clientError); // ohne Auth
app.use('/api/logs', auth, rechtErforderlich('logs'), logsRoutes);
// Interne Endpunkte fuer n8n — eigener Shared-Secret-Schutz statt JWT
app.use('/api/internal', internalAuth, require('./routes/internal'));

// ─── Frontend (Vite-Build) ───────────────────────────────────────────────────
const distPfad = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(distPfad));
// SPA-Fallback: alles, was keine API-Route ist, bekommt die index.html
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distPfad, 'index.html')));

// ─── Express Error-Handler (muss nach allen Routen kommen) ───────────────────
app.use(panelLog.expressErrorHandler);

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => {
  console.log(`Mail-Panel-Backend läuft auf Port ${PORT}`);
  // Container-Health-Check alle 5 Minuten starten
  panelLog.containerHealthCheckStarten();
});
