// Eigene White- und Blacklist. Ein Eintrag ist entweder eine ganze
// Absenderadresse (info@example.org) oder eine Domain (example.org) —
// bei einer Domain zählen auch alle Unterdomains.
const db = require('../db');

const normalisieren = (wert) => String(wert || '').trim().toLowerCase();

// Prüft eine Absenderadresse gegen die Muster einer Liste
function passt(absender, muster) {
  const a = normalisieren(absender);
  const m = normalisieren(muster);
  if (!a || !m) return false;
  if (m.includes('@')) return a === m;
  const domain = a.split('@').pop();
  return domain === m || domain.endsWith(`.${m}`);
}

function eintraege(typ) {
  return db.prepare('SELECT * FROM lists WHERE typ = ? ORDER BY muster').all(typ);
}

// Liefert den Treffer (das Muster) oder null
function pruefe(absender, typ) {
  const treffer = eintraege(typ).find((e) => passt(absender, e.muster));
  return treffer ? treffer.muster : null;
}

function hinzufuegen(typ, muster, kommentar = null) {
  const wert = normalisieren(muster);
  // Adresse oder Domain — alles andere lehnen wir ab
  const istAdresse = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(wert);
  const istDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(wert);
  if (!istAdresse && !istDomain) {
    throw new Error('Bitte eine E-Mail-Adresse oder eine Domain angeben.');
  }
  if (db.prepare('SELECT 1 FROM lists WHERE typ = ? AND muster = ?').get(typ, wert)) {
    throw new Error('Dieser Eintrag steht bereits auf der Liste.');
  }
  // Derselbe Absender darf nicht gleichzeitig auf beiden Listen stehen
  const anderer = typ === 'whitelist' ? 'blacklist' : 'whitelist';
  db.prepare('DELETE FROM lists WHERE typ = ? AND muster = ?').run(anderer, wert);

  const info = db.prepare('INSERT INTO lists (typ, muster, kommentar) VALUES (?, ?, ?)')
    .run(typ, wert, kommentar || null);
  return { id: info.lastInsertRowid, typ, muster: wert, kommentar };
}

function entfernen(id) {
  return db.prepare('DELETE FROM lists WHERE id = ?').run(id).changes > 0;
}

module.exports = { eintraege, pruefe, hinzufuegen, entfernen, passt };
