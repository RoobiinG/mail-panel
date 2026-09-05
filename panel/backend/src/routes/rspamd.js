// Die Rspamd-Seite zeigt, was in mailcow an Filtern eingetragen ist.
//
// Sie lief in einen 404, weil die Endpunkte geraten waren: `/get/policy_bl_wl/…`
// und `/get/spam-score/all` gibt es in der mailcow-API nicht. Was es gibt, ist
// pro Domain je eine Liste:
//
//   GET  /api/v1/get/policy_wl_domain/{domain}
//   GET  /api/v1/get/policy_bl_domain/{domain}
//   POST /api/v1/add/domain-policy      { domain, object_list: 'wl'|'bl', object_from }
//
// Die Listen sind in mailcow also domainweise organisiert; eine globale gibt es
// über die API nicht. Deshalb werden hier die Domains geholt und ihre Listen
// zusammengetragen — mit der Domain dran, damit man sieht, wo ein Eintrag gilt.
//
// Zweite Lehre aus dem 404: Ein Teil, der nicht klappt, darf nicht die ganze
// Seite leeren. Jeder Abschnitt trägt seinen Fehler selbst.
const express = require('express');
const db      = require('../db');
const mailcow = require('../services/mailcow');
const { loggen } = require('../services/panelLog');

const router = express.Router();

const nichtEingerichtet = (err) => String(err.message || '').includes('nicht eingerichtet');

// Aus einer mailcow-Antwort eine Liste machen: mal kommt ein Array, mal ein
// einzelnes Objekt, mal ein leerer String.
const alsListe = (daten) => {
  if (Array.isArray(daten)) return daten;
  if (daten && typeof daten === 'object') return [daten];
  return [];
};

async function domainsHolen() {
  const { data } = await mailcow.client().get('/get/domain/all');
  return alsListe(data).map((d) => d.domain_name || d.domain).filter(Boolean);
}

// ─── 1. Whitelist / Blacklist aus mailcow ────────────────────────────────────

router.get('/policy', async (req, res) => {
  const antwort = { whitelist: [], blacklist: [], scores: [], hinweise: [] };

  let domains;
  try {
    domains = await domainsHolen();
  } catch (err) {
    if (nichtEingerichtet(err)) return res.json({ disabled: true });
    // Scheitert schon die Domain-Liste, stimmt etwas Grundsätzliches nicht:
    // Adresse, API-Schlüssel oder die IP-Freigabe des Schlüssels in mailcow.
    return res.status(502).json({
      error: `mailcow antwortet nicht wie erwartet: ${err.message}`,
      hinweis: 'Prüfe unter Einstellungen die mailcow-Adresse und den API-Schlüssel — und in '
        + 'mailcow, ob der Schlüssel für die IP des Panels freigegeben ist.',
    });
  }

  if (domains.length === 0) {
    antwort.hinweise.push('mailcow meldet keine Domains — dann gibt es auch keine Filterlisten.');
    return res.json(antwort);
  }

  for (const domain of domains) {
    for (const [pfad, ziel] of [['policy_wl_domain', 'whitelist'], ['policy_bl_domain', 'blacklist']]) {
      try {
        const { data } = await mailcow.client().get(`/get/${pfad}/${encodeURIComponent(domain)}`);
        for (const eintrag of alsListe(data)) {
          if (!eintrag?.object) continue;
          antwort[ziel].push({ domain, object: eintrag.object, prefid: eintrag.prefid ?? null });
        }
      } catch (err) {
        antwort.hinweise.push(`${domain}: ${ziel} nicht lesbar (${err.message})`);
      }
    }
  }

  // Die Spam-Schwellwerte hängen an den Postfächern. Ältere mailcow-Versionen
  // liefern sie nicht mit — dann bleibt die Tabelle eben leer, statt dass die
  // ganze Seite an einem 404 scheitert.
  try {
    const { data } = await mailcow.client().get('/get/mailbox/all');
    for (const fach of alsListe(data)) {
      const werte = fach.spam_score || fach.attributes?.spam_score;
      if (!werte) continue;
      const [spam, reject] = String(werte).split(',');
      antwort.scores.push({
        object: fach.username || fach.name,
        greylist: fach.attributes?.greylist_enable ?? null,
        spam: spam ?? null,
        reject: reject ?? null,
      });
    }
  } catch (err) {
    antwort.hinweise.push(`Spam-Schwellwerte nicht lesbar (${err.message})`);
  }

  res.json(antwort);
});

// ─── 2. Panel-Whitelist nach mailcow übertragen ──────────────────────────────
//
// mailcow kennt über die API keine globale Liste, sondern nur je Domain. Die
// Panel-Whitelist gilt für alles, also wird sie in jede Domain eingetragen.

router.post('/sync', async (req, res) => {
  try {
    const panelWhitelist = db.prepare('SELECT absender FROM lists WHERE typ = ?').all('whitelist')
      .map((l) => l.absender).filter(Boolean);
    if (panelWhitelist.length === 0) {
      return res.json({ success: true, count: 0, msg: 'Keine Whitelist-Einträge im Panel.' });
    }

    const domains = await domainsHolen();
    if (domains.length === 0) {
      return res.status(400).json({ error: 'mailcow meldet keine Domains.' });
    }

    let count = 0;
    const fehler = [];
    for (const domain of domains) {
      // Erst nachsehen, was schon drinsteht: Einen doppelten Eintrag quittiert
      // mailcow mit einem Fehler, und das wäre keiner, sondern der Normalfall.
      let vorhanden = [];
      try {
        const { data } = await mailcow.client().get(`/get/policy_wl_domain/${encodeURIComponent(domain)}`);
        vorhanden = alsListe(data).map((e) => String(e.object || '').toLowerCase());
      } catch { /* dann eben ohne Vorwissen */ }

      for (const eintrag of panelWhitelist) {
        if (vorhanden.includes(String(eintrag).toLowerCase())) continue;
        try {
          await mailcow.client().post('/add/domain-policy', {
            domain, object_list: 'wl', object_from: eintrag,
          });
          count += 1;
        } catch (err) {
          fehler.push(`${eintrag} → ${domain}: ${err.message}`);
        }
      }
    }

    loggen('info', 'rspamd',
      `${count} Whitelist-Eintrag/Einträge nach mailcow übertragen (${domains.length} Domain(s)).`);
    res.json({
      success: true,
      count,
      domains: domains.length,
      fehler: fehler.slice(0, 5),
      msg: count === 0
        ? 'mailcow hatte alles schon.'
        : `${count} Eintrag/Einträge in ${domains.length} Domain(s) übertragen.`,
    });
  } catch (err) {
    if (nichtEingerichtet(err)) {
      return res.status(400).json({ error: 'mailcow ist nicht eingerichtet.' });
    }
    res.status(502).json({ error: `Übertragen fehlgeschlagen: ${err.message}` });
  }
});

module.exports = router;
