// HTTPS auf dem eigenen Port.
//
// Der Test fährt einen echten Server hoch und redet mit ihm — bei einer
// Verschlüsselung nützt es wenig zu prüfen, ob die Funktion „durchläuft".
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const http = require('http');
const { ordner: ARBEIT } = require('./umgebung');

process.env.DATA_DIR = ARBEIT;
const tls = require('../src/services/tls');

// Eine winzige Anwendung statt des ganzen Panels — hier geht es um die Hülle.
const app = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`gesehen:${req.url}`);
};

const offen = [];
after(() => offen.forEach((s) => { try { s.close(); } catch { /* egal */ } }));

function starten(port) {
  return new Promise((fertig) => {
    const server = tls.starten(app, port, (art) => fertig({ server, art }));
    offen.push(server);
  });
}

function holen(gib, port, pfad, folgen = false) {
  return new Promise((fertig, schief) => {
    const anfrage = gib.get({
      host: '127.0.0.1', port, path: pfad,
      rejectUnauthorized: false, // selbst erzeugtes Zertifikat
    }, (antwort) => {
      let text = '';
      antwort.on('data', (d) => { text += d; });
      antwort.on('end', () => fertig({ status: antwort.statusCode, kopf: antwort.headers, text }));
    });
    anfrage.on('error', schief);
    anfrage.setTimeout(5000, () => { anfrage.destroy(new Error('Zeitüberschreitung')); });
    void folgen;
  });
}

describe('modus()', () => {
  test('Standard ist an', () => {
    delete process.env.TLS_MODUS;
    assert.equal(tls.modus(), 'an');
  });
  test('lässt sich abschalten — in mehreren Schreibweisen', () => {
    for (const wert of ['aus', 'AUS', 'off', '0', 'false', 'nein']) {
      process.env.TLS_MODUS = wert;
      assert.equal(tls.modus(), 'aus', `"${wert}" sollte abschalten`);
    }
    delete process.env.TLS_MODUS;
  });
});

describe('Zertifikat', () => {
  test('halb gesetzte Pfade sind ein Fehler, kein stiller Rückfall', () => {
    process.env.TLS_CERT = '/gibt/es/nicht.crt';
    delete process.env.TLS_KEY;
    assert.throws(() => tls.zertifikat(), /beide/);
    delete process.env.TLS_CERT;
  });

  test('ein angegebener, aber fehlender Pfad wird benannt', () => {
    process.env.TLS_CERT = '/gibt/es/nicht.crt';
    process.env.TLS_KEY = '/gibt/es/auch/nicht.key';
    assert.throws(() => tls.zertifikat(), /nicht gefunden/);
    delete process.env.TLS_CERT; delete process.env.TLS_KEY;
  });

  test('ohne Angabe wird eines erzeugt — und beim zweiten Mal wiederverwendet', () => {
    const erst = tls.zertifikat();
    assert.equal(erst.quelle, 'selbst');
    assert.equal(erst.neu, true);
    assert.match(erst.cert.toString(), /BEGIN CERTIFICATE/);
    assert.match(erst.key.toString(), /PRIVATE KEY/);

    const zweit = tls.zertifikat();
    assert.equal(zweit.neu, undefined, 'beim zweiten Aufruf darf kein neues entstehen');
    assert.deepEqual(zweit.cert, erst.cert, 'dasselbe Zertifikat');
  });
});

describe('der laufende Server', () => {
  test('spricht HTTPS und liefert die Anwendung aus', async () => {
    delete process.env.TLS_MODUS;
    const { art } = await starten(38121);
    assert.equal(art.tls, true);
    const antwort = await holen(https, 38121, '/irgendwas');
    assert.equal(antwort.status, 200);
    assert.equal(antwort.text, 'gesehen:/irgendwas');
  });

  // Wer aus Gewohnheit http:// eingibt, soll nicht auf Kauderwelsch starren.
  test('http auf demselben Port leitet auf https um', async () => {
    const antwort = await holen(http, 38121, '/sortierung');
    assert.equal(antwort.status, 308);
    assert.match(antwort.kopf.location, /^https:\/\/.*:38121\/sortierung$/);
  });

  // Ohne diese Ausnahme braeche bei jeder bestehenden Installation die
  // Sortierung, sobald jemand das Update einspielt: n8n ruft das Panel im
  // Docker-Netz ueber http://panel:3002 auf.
  test('die interne Schnittstelle bleibt über http erreichbar', async () => {
    const antwort = await holen(http, 38121, '/api/internal/check');
    assert.equal(antwort.status, 200, 'darf NICHT umgeleitet werden');
    assert.equal(antwort.text, 'gesehen:/api/internal/check');
  });

  // Ein Nginx Proxy Manager davor spricht das Panel innen ueber http an. Eine
  // Umleitung schickte den Browser am Proxy vorbei direkt auf diesen Port.
  test('hinter einem Reverse Proxy wird nicht umgeleitet', async () => {
    const antwort = await new Promise((fertig, schief) => {
      const a = http.get({
        host: '127.0.0.1', port: 38121, path: '/dashboard',
        headers: { 'X-Forwarded-Proto': 'https' },
      }, (r) => {
        let t = ''; r.on('data', (d) => { t += d; });
        r.on('end', () => fertig({ status: r.statusCode, text: t }));
      });
      a.on('error', schief);
    });
    assert.equal(antwort.status, 200, 'darf NICHT umgeleitet werden');
    assert.equal(antwort.text, 'gesehen:/dashboard');
  });

  test('abgeschaltet spricht er schlichtes http', async () => {
    process.env.TLS_MODUS = 'aus';
    const { art } = await starten(38122);
    assert.equal(art.tls, false);
    const antwort = await holen(http, 38122, '/');
    assert.equal(antwort.status, 200);
    assert.equal(antwort.text, 'gesehen:/');
    delete process.env.TLS_MODUS;
  });
});
