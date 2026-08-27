// quiet: true — dotenv 17 gibt sonst bei jedem Start einen Hinweis aus, der im
// Container-Log nur Rauschen ist.
require('dotenv').config({ quiet: true });
// Schlüssel bereitstellen, bevor irgendetwas sie liest (erzeugt sie beim
// Erststart selbst, damit die Installation ohne .env auskommt)
require('./secrets').laden();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const auth         = require('./middleware/auth');
const { rechtErforderlich } = require('./middleware/auth');
const internalAuth = require('./middleware/internalAuth');
const { router: passkeysRoutes } = require('./routes/passkeys');
const { router: logsRoutes, clientError } = require('./routes/logs');
const { router: googleRoutes, rueckkehr: googleRueckkehr } = require('./routes/google');
const panelLog = require('./services/panelLog');

const app = express();
// Reverse Proxy (Nginx Proxy Manager) fuer korrekte Client-IPs und express-rate-limit vertrauen
app.set('trust proxy', 1);

// ─── Sicherheits-Kopfzeilen ──────────────────────────────────────────────────
//
// Das JWT liegt im localStorage bzw. sessionStorage. Eine einzige XSS-Luecke
// wuerde damit eine ganze Sitzung aushaendigen — die Content-Security-Policy ist
// die wirksamste Bremse dagegen. Sie kann hier eng sein: Das Frontend laedt
// weder Schriften noch Skripte von fremden Adressen, und dangerouslySetInnerHTML
// kommt nirgends vor.
//
// 'unsafe-inline' ist nur bei style-src noetig: React setzt Inline-Styles, und
// recharts erzeugt sie zur Laufzeit. Fuer Skripte bleibt es aus — genau dort
// zaehlt es.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  // Greift nur ueber HTTPS; hinter einem Reverse Proxy ist genau das der Fall.
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'same-origin' },
  // Verraet sonst die eingesetzte Technik
  hidePoweredBy: true,
  // Das Panel laedt keine fremden Ressourcen — die Standardwerte wuerden hier
  // nur Verwirrung stiften, wenn spaeter doch mal ein Bild eingebunden wird.
  crossOriginEmbedderPolicy: false,
}));

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
app.use('/api/workflows', auth, rechtErforderlich('workflows'), require('./routes/workflows'));
app.use('/api/aktionen', auth, rechtErforderlich('workflows'), require('./routes/aktionen'));
// Google ruft die Rueckkehr-Adresse im Browser auf — die kann keine Anmeldung
// mitschicken und ist deshalb ueber den state-Parameter abgesichert.
app.get('/api/google/rueckkehr', googleRueckkehr);
app.use('/api/google', auth, rechtErforderlich('einstellungen'), googleRoutes);

// Panel-Logs: Browser-Fehler kommen ohne Anmeldung an (der Fehler kann ja gerade
// die Anmeldung betreffen) — deshalb eine Bremse, damit niemand die Datenbank
// vollschreiben kann.
const rateLimit = require('express-rate-limit');
const clientLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Seit express-rate-limit 8 heisst die Obergrenze "limit"; "max" wurde entfernt.
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Fehlermeldungen — bitte kurz warten.' },
});
app.post('/api/logs/client', clientLogLimiter, express.json({ limit: '64kb' }), clientError);
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
