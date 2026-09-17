const db = require('../db');
const { domain } = require('./sortierung');
const { loggen } = require('./panelLog');

// Große Freemail-Anbieter, bei denen wir NIEMALS eine Domain-Regel ableiten dürfen,
// weil sonst plötzlich das halbe Postfach pauschal als "Rechnung" sortiert wird.
const FREEMAILER = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.de', 'hotmail.com',
  'outlook.com', 'outlook.de', 'web.de', 'gmx.de', 'gmx.net', 't-online.de',
  'icloud.com', 'me.com', 'mac.com', 'posteo.de', 'mailbox.org', 'protonmail.com',
  'proton.me', 'mail.ru', 'yandex.ru', 'aol.com'
]);

function aufraeumen() {
  let zusammengefasst = 0;
  
  // Alle reinen Absender-Regeln (ohne zusätzliche Bedingungen) holen
  const regeln = db.prepare(`
    SELECT id, konto_id, typ, muster, zielordner, aktion, betreff_muster, inhalt_muster, treffer 
    FROM sort_rules 
    WHERE typ = 'absender' 
      AND (betreff_muster IS NULL OR betreff_muster = '')
      AND (inhalt_muster IS NULL OR inhalt_muster = '')
      AND aktion = 'verschieben'
  `).all();
  
  const gruppen = new Map();
  
  for (const r of regeln) {
    const dom = domain(r.muster);
    if (!dom || FREEMAILER.has(dom.toLowerCase())) continue;
    
    const key = `${r.konto_id}|${dom}|${r.zielordner}`;
    if (!gruppen.has(key)) {
      gruppen.set(key, { konto_id: r.konto_id, domain: dom, zielordner: r.zielordner, regeln: [], trefferSumme: 0 });
    }
    
    const gruppe = gruppen.get(key);
    gruppe.regeln.push(r);
    gruppe.trefferSumme += r.treffer || 0;
  }
  
  for (const gruppe of gruppen.values()) {
    // Wenn 3 oder mehr verschiedene Absender derselben Domain im selben Ordner landen
    if (gruppe.regeln.length >= 3) {
      // Prüfen, ob für diese Domain bereits ANDERE, widersprüchliche Domain-Regeln existieren
      const widerspruch = db.prepare(`
         SELECT id FROM sort_rules 
         WHERE konto_id = ? AND typ = 'domain' AND muster = ? AND zielordner != ?
      `).get(gruppe.konto_id, gruppe.domain, gruppe.zielordner);
      
      if (widerspruch) continue; // Zu riskant, nicht zusammenfassen
      
      // Prüfen, ob exakt die passende Domain-Regel vielleicht schon existiert
      const existiert = db.prepare(`
         SELECT id FROM sort_rules
         WHERE konto_id = ? AND typ = 'domain' AND muster = ? AND zielordner = ?
           AND (betreff_muster IS NULL OR betreff_muster = '')
           AND (inhalt_muster IS NULL OR inhalt_muster = '')
      `).get(gruppe.konto_id, gruppe.domain, gruppe.zielordner);
      
      if (!existiert) {
         db.prepare(`
           INSERT INTO sort_rules (konto_id, typ, muster, zielordner, aktion, treffer)
           VALUES (?, 'domain', ?, ?, 'verschieben', ?)
         `).run(gruppe.konto_id, gruppe.domain, gruppe.zielordner, gruppe.trefferSumme);
         
         loggen('info', 'sortierung', `[Aufräumen] Domain-Regel für @${gruppe.domain} erstellt (fasst ${gruppe.regeln.length} Einzelregeln für "${gruppe.zielordner}" zusammen).`);
      } else {
         db.prepare('UPDATE sort_rules SET treffer = treffer + ? WHERE id = ?').run(gruppe.trefferSumme, existiert.id);
         loggen('info', 'sortierung', `[Aufräumen] ${gruppe.regeln.length} überflüssige Einzelregeln für @${gruppe.domain} entfernt (bereits durch Domain-Regel abgedeckt).`);
      }
      
      // Die gebündelten Einzelregeln löschen
      const ids = gruppe.regeln.map(r => r.id);
      db.prepare(`DELETE FROM sort_rules WHERE id IN (${ids.join(',')})`).run();
      
      zusammengefasst += gruppe.regeln.length;
    }
  }
  
  return zusammengefasst;
}

let timer = null;

function zeitplanStarten() {
  if (timer) clearInterval(timer);
  
  // Einmal pro Nacht laufen (alle 24h)
  const EIN_TAG = 24 * 60 * 60 * 1000;
  
  timer = setInterval(() => {
    try {
      aufraeumen();
    } catch (err) {
      loggen('error', 'sortierung', `Fehler beim Aufräumen der Regeln: ${err.message}`);
    }
  }, EIN_TAG);
  
  // Einmal sofort beim Start ausführen (aber leicht verzögert, damit alles andere hochgefahren ist)
  setTimeout(() => {
    try {
      aufraeumen();
    } catch (err) {
      loggen('error', 'sortierung', `Fehler beim initialen Aufräumen der Regeln: ${err.message}`);
    }
  }, 5 * 60 * 1000); // 5 Minuten nach Start
}

function stoppen() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  aufraeumen,
  zeitplanStarten,
  stoppen,
};
