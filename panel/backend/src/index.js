require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const auth         = require('./middleware/auth');
const internalAuth = require('./middleware/internalAuth');

// ─── Startup-Sicherheitscheck (Muster: Überwachungs-Panel) ───────────────────
for (const [name, minLaenge] of [['JWT_SECRET', 32], ['PANEL_SECRET', 32]]) {
  const wert = process.env[name];
  if (!wert || wert.length < minLaenge || wert.includes('EINTRAGEN')) {
    console.error(`❌ FATAL: ${name} ist nicht gesetzt oder zu unsicher (mindestens ${minLaenge} Zeichen).`);
    console.error(`   Generieren mit: openssl rand -hex 32`);
    process.exit(1);
  }
}

const app = express();
// Reverse Proxy (Nginx Proxy Manager) fuer korrekte Client-IPs und express-rate-limit vertrauen
app.set('trust proxy', 1);

// CORS: Frontend wird vom selben Origin ausgeliefert — Cross-Origin bleibt aus
app.use(cors({ origin: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ─── Routen ──────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/einstellungen', auth, require('./routes/einstellungen'));
// Interne Endpunkte fuer n8n — eigener Shared-Secret-Schutz statt JWT
app.use('/api/internal', internalAuth, require('./routes/internal'));

// ─── Frontend (Vite-Build) ───────────────────────────────────────────────────
const distPfad = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(distPfad));
// SPA-Fallback: alles, was keine API-Route ist, bekommt die index.html
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distPfad, 'index.html')));

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => console.log(`Mail-Panel-Backend läuft auf Port ${PORT}`));
