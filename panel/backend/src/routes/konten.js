// Konten-Verwaltung: CRUD plus automatisches Onboarding in n8n
// (IMAP-Credential anlegen und die Workflows 01/04 verdrahten).
const express = require('express');
const db      = require('../db');
const imap    = require('../services/imap');
const n8n     = require('../services/n8n');
const patcher = require('../services/workflowPatcher');
const { verschluesseln, entschluesseln } = require('../services/crypto');

const router = express.Router();

const oeffentlich = (k) => ({
  id: k.id, name: k.name, host: k.host, port: k.port,
  username: k.username, aktiv: Boolean(k.aktiv), tlsUnsicher: Boolean(k.tls_unsicher),
  folder_spam: k.folder_spam, folder_invoices: k.folder_invoices,
  folder_orders: k.folder_orders, folder_newsletter: k.folder_newsletter,
  folder_archive: k.folder_archive,
  verdrahtet: Boolean(k.n8n_credential_id), created_at: k.created_at,
});

const alleAktiven = () => db.prepare('SELECT * FROM accounts WHERE aktiv = 1 ORDER BY id').all();

// Die fünf Zielordner stehen in jeder Anfrage — einmal einsammeln reicht.
const ordnerFelder = (b = {}) => ({
  folder_spam: b.folder_spam, folder_invoices: b.folder_invoices,
  folder_orders: b.folder_orders, folder_newsletter: b.folder_newsletter,
  folder_archive: b.folder_archive,
});

// Zugangsdaten aus der Anfrage, beim Bearbeiten ergänzt um das gespeicherte Passwort
function zugang(body = {}) {
  const { host, port, username, passwort, id, tlsUnsicher } = body;
  let pw = passwort;
  if (!pw && id) {
    const konto = db.prepare('SELECT password_enc FROM accounts WHERE id = ?').get(id);
    if (konto) pw = entschluesseln(konto.password_enc);
  }
  return { host, port, username, passwort: pw, tlsUnsicher, ...ordnerFelder(body) };
}

// Eingaben prüfen — der Name landet als Knotenname in n8n, deshalb eng begrenzt
function pruefe({ name, host, port, username, passwort }, passwortPflicht = true) {
  if (!name || !/^[\w äöüÄÖÜß.\-]{2,40}$/.test(name)) {
    return 'Name: 2–40 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, Punkt und Bindestrich.';
  }
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return 'Host: ungültiger Hostname.';
  if (!port || Number(port) < 1 || Number(port) > 65535) return 'Port: 1–65535.';
  if (!username) return 'Benutzername fehlt.';
  if (passwortPflicht && !passwort) return 'Passwort fehlt.';
  return null;
}

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY id').all().map(oeffentlich));
});

// Verbindung testen, ohne etwas zu speichern
router.post('/test', async (req, res) => {
  // Beim Bearbeiten darf das Passwort leer bleiben — dann das gespeicherte nehmen
  const daten = zugang(req.body);
  const fehler = pruefe({ name: 'Test', ...daten });
  if (fehler) return res.status(400).json({ error: fehler });
  try {
    res.json(await imap.testVerbindung(daten));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Fehlende Zielordner im Postfach anlegen — freiwillig, wer eigene Ordner
// verwendet, wählt sie stattdessen einfach aus.
router.post('/ordner-anlegen', async (req, res) => {
  const daten = zugang(req.body);
  const fehler = pruefe({ name: 'Test', ...daten });
  if (fehler) return res.status(400).json({ error: fehler });
  try {
    res.json(await imap.ordnerAnlegen(daten));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { name, host, port, username, passwort, tlsUnsicher } = req.body || {};
  const ordner = ordnerFelder(req.body);
  const fehler = pruefe(req.body || {});
  if (fehler) return res.status(400).json({ error: fehler });
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'Ein Konto mit diesem Namen existiert bereits.' });
  }

  let credentialId = null;
  try {
    // Erst prüfen, ob die Zugangsdaten überhaupt stimmen
    await imap.testVerbindung({ host, port, username, passwort, tlsUnsicher, ...ordner });
    credentialId = await n8n.credentialAnlegen({
      name: `Mail-Panel: ${name}`, host, port, username, passwort, tlsUnsicher,
    });

    const info = db.prepare(`
      INSERT INTO accounts (name, host, port, username, password_enc, n8n_credential_id, tls_unsicher,
                            folder_spam, folder_invoices, folder_orders, folder_newsletter, folder_archive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, host, Number(port), username, verschluesseln(passwort), credentialId, tlsUnsicher ? 1 : 0,
           ordner.folder_spam || null, ordner.folder_invoices || null, ordner.folder_orders || null,
           ordner.folder_newsletter || null, ordner.folder_archive || null);

    const sync = await patcher.alleSynchronisieren(alleAktiven());
    res.json({ ok: true, id: info.lastInsertRowid, sync });
  } catch (err) {
    // Angefangenes wieder zurückbauen, damit keine Karteileichen in n8n bleiben
    if (credentialId) {
      db.prepare('DELETE FROM accounts WHERE n8n_credential_id = ?').run(credentialId);
      try { await n8n.credentialLoeschen(credentialId); } catch { /* best effort */ }
    }
    res.status(502).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!konto) return res.status(404).json({ error: 'Konto nicht gefunden.' });

  const { name, host, port, username, passwort, aktiv, tlsUnsicher } = req.body || {};
  const ordner = ordnerFelder(req.body);
  const fehler = pruefe({ name, host, port, username, passwort }, false);
  if (fehler) return res.status(400).json({ error: fehler });

  const neuesPasswort = passwort || entschluesseln(konto.password_enc);
  try {
    await imap.testVerbindung({ host, port, username, passwort: neuesPasswort, tlsUnsicher, ...ordner });

    // n8n kennt kein Aktualisieren per Public API — altes Credential ersetzen
    const neueCredentialId = await n8n.credentialAnlegen({
      name: `Mail-Panel: ${name}`, host, port, username, passwort: neuesPasswort, tlsUnsicher,
    });

    db.prepare(`
      UPDATE accounts SET name = ?, host = ?, port = ?, username = ?, password_enc = ?,
                          n8n_credential_id = ?, aktiv = ?, tls_unsicher = ?,
                          folder_spam = ?, folder_invoices = ?, folder_orders = ?,
                          folder_newsletter = ?, folder_archive = ?
      WHERE id = ?
    `).run(name, host, Number(port), username, verschluesseln(neuesPasswort),
           neueCredentialId, aktiv === false ? 0 : 1, tlsUnsicher ? 1 : 0,
           ordner.folder_spam || null, ordner.folder_invoices || null, ordner.folder_orders || null,
           ordner.folder_newsletter || null, ordner.folder_archive || null,
           konto.id);

    const sync = await patcher.alleSynchronisieren(alleAktiven());
    // Erst nach erfolgreichem Sync entfernen — sonst zeigen die Knoten ins Leere
    try { await n8n.credentialLoeschen(konto.n8n_credential_id); } catch { /* best effort */ }
    res.json({ ok: true, sync });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const konto = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!konto) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  try {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(konto.id);
    const sync = await patcher.alleSynchronisieren(alleAktiven());
    await n8n.credentialLoeschen(konto.n8n_credential_id);
    res.json({ ok: true, sync });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Workflows erneut auf den aktuellen Kontenstand bringen (z.B. nach Workflow-Import)
router.post('/sync', async (req, res) => {
  try {
    res.json({ ok: true, sync: await patcher.alleSynchronisieren(alleAktiven()) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
