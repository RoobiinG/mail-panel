// Googles Tag beginnt nicht um unsere Mitternacht.
//
// "Requests per day (RPD) quotas reset at midnight Pacific time" steht in
// Googles Dokumentation. Das Panel rechnete mit der lokalen Mitternacht — und
// hielt damit jede Nacht zwischen 00:00 und 09:00 den Tag fuer neu, waehrend
// Google noch den alten zaehlte. Folge: Der Zaehler stand auf 0, der Deckel war
// aufgehoben, jeder Lauf holte 200 Mails und bekam sie alle abgewiesen. Die
// Laeufe meldeten "erfolgreich" und sortierten keine einzige Mail.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const { kiTag, tagesBeginnIso, offsetStunden } = require('../src/services/kiTag');

describe('Der Tag, nach dem Google zaehlt', () => {
  test('kurz nach unserer Mitternacht ist es bei Google noch gestern', () => {
    // 7. September, 04:27 deutscher Zeit — der Lauf aus dem Betrieb.
    const nachts = new Date('2026-09-07T02:27:00Z'); // 04:27 MESZ
    assert.equal(kiTag(nachts), '2026-09-06',
      'genau daran lag es: das Panel hielt den Tag fuer neu, Google nicht');
  });

  test('ab neun Uhr unserer Zeit ist der neue Tag auch bei Google da', () => {
    const morgens = new Date('2026-09-07T07:30:00Z'); // 09:30 MESZ, 00:30 PDT
    assert.equal(kiTag(morgens), '2026-09-07');
  });

  test('mittags stimmen beide ueberein', () => {
    assert.equal(kiTag(new Date('2026-09-07T12:00:00Z')), '2026-09-07');
  });

  test('die Form ist immer YYYY-MM-DD', () => {
    assert.match(kiTag(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Sommer- und Winterzeit', () => {
  test('im Sommer liegt der Pazifik sieben Stunden hinter UTC', () => {
    assert.equal(offsetStunden(new Date('2026-07-01T12:00:00Z')), 7);
  });

  test('im Winter acht', () => {
    assert.equal(offsetStunden(new Date('2026-01-15T12:00:00Z')), 8);
  });
});

describe('Der Tagesbeginn fuer die Datenbank', () => {
  const alsPazifik = (s) => new Date(`${s.replace(' ', 'T')}Z`)
    .toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' });

  test('trifft genau Mitternacht Pazifik — im Sommer', () => {
    const beginn = tagesBeginnIso(new Date('2026-09-07T02:27:00Z'));
    assert.equal(alsPazifik(beginn), '2026-09-06 00:00:00');
  });

  test('und im Winter', () => {
    const beginn = tagesBeginnIso(new Date('2026-01-15T12:00:00Z'));
    assert.equal(alsPazifik(beginn), '2026-01-15 00:00:00');
  });

  test('die Form passt zu SQLites CURRENT_TIMESTAMP', () => {
    assert.match(tagesBeginnIso(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
