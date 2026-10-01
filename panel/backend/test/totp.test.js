// TOTP ohne Fremdbibliothek: Wenn sich hier ein Zeichen verschiebt, sperrt sich
// jeder aus, der eine Authenticator-App benutzt. Deshalb gegen die Testvektoren
// der RFCs geprüft, nicht nur gegen sich selbst.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const totp = require('../src/services/totp');

// RFC 4226, Anhang D: Schlüssel "12345678901234567890", Zähler 0–9.
const RFC4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
const SCHLUESSEL = Buffer.from('12345678901234567890');
const GEHEIMNIS = totp.base32Kodieren(SCHLUESSEL); // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ

describe('HOTP (RFC 4226)', () => {
  RFC4226.forEach((erwartet, zaehler) => {
    test(`Zähler ${zaehler} → ${erwartet}`, () => {
      assert.equal(totp.hotp(SCHLUESSEL, zaehler), erwartet);
    });
  });
});

describe('TOTP (RFC 6238, Anhang B, SHA-1)', () => {
  // Die 8-stelligen Werte des RFC, auf die letzten sechs gekürzt.
  const vektoren = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ];
  for (const [sekunden, erwartet] of vektoren) {
    test(`t = ${sekunden} s → ${erwartet}`, () => {
      assert.equal(totp.code(GEHEIMNIS, sekunden * 1000), erwartet);
    });
  }
});

describe('base32', () => {
  test('das Testgeheimnis ist das bekannte', () => {
    assert.equal(GEHEIMNIS, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  test('Hin und zurück für alle Längen', () => {
    for (let n = 0; n <= 40; n += 1) {
      const roh = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));
      assert.deepEqual(totp.base32Dekodieren(totp.base32Kodieren(roh)), roh, `Länge ${n}`);
    }
  });

  test('Leerzeichen, Bindestriche und Kleinbuchstaben stören nicht (so tippt man ein Geheimnis ab)', () => {
    assert.deepEqual(totp.base32Dekodieren('gezd gnbv-gy3t qojq'), Buffer.from('1234567890'));
  });

  test('ein ungültiges Zeichen wird abgewiesen', () => {
    assert.throws(() => totp.base32Dekodieren('GEZD1GNB'), /base32/);
  });

  test('ein neues Geheimnis hat 32 Zeichen, 160 Bit', () => {
    const g = totp.neuesGeheimnis();
    assert.match(g, /^[A-Z2-7]{32}$/);
    assert.equal(totp.base32Dekodieren(g).length, 20);
    assert.notEqual(totp.neuesGeheimnis(), g, 'jedes Mal ein anderes');
  });
});

describe('pruefen', () => {
  const jetzt = 1700000000000;
  const schritt = totp.schrittVon(jetzt);
  const codeFuer = (d) => totp.hotp(SCHLUESSEL, schritt + d);

  test('der aktuelle Code gilt — und liefert seinen Zeitschritt', () => {
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(0), { jetzt }), schritt);
  });

  test('der Code des vorigen und des nächsten Schritts gilt (Uhr geht leicht falsch)', () => {
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(-1), { jetzt }), schritt - 1);
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(1), { jetzt }), schritt + 1);
  });

  test('zwei Schritte daneben gilt nicht', () => {
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(-2), { jetzt }), null);
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(2), { jetzt }), null);
  });

  test('ein falscher Code gilt nicht', () => {
    const falsch = String((Number(codeFuer(0)) + 1) % 1000000).padStart(6, '0');
    assert.equal(totp.pruefen(GEHEIMNIS, falsch, { jetzt }), null);
  });

  // Ein mitgelesener Code (Schulterblick, Proxy-Log) darf nicht ein zweites Mal gelten.
  test('Wiederverwendung: derselbe Schritt gilt nach `nachSchritt` nicht mehr', () => {
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(0), { jetzt, nachSchritt: schritt }), null);
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(-1), { jetzt, nachSchritt: schritt }), null, 'ein älterer erst recht');
    assert.equal(totp.pruefen(GEHEIMNIS, codeFuer(1), { jetzt, nachSchritt: schritt }), schritt + 1, 'ein neuerer geht');
  });

  test('Leerzeichen im Code stören nicht ("123 456")', () => {
    const c = codeFuer(0);
    assert.equal(totp.pruefen(GEHEIMNIS, `${c.slice(0, 3)} ${c.slice(3)}`, { jetzt }), schritt);
  });

  test('Eingaben, die keine sechs Ziffern sind, gelten nie', () => {
    for (const x of ['', '12345', '1234567', 'abcdef', '12345a', null, undefined, '12-456', '１２３４５６']) {
      assert.equal(totp.pruefen(GEHEIMNIS, x, { jetzt }), null, JSON.stringify(x));
    }
  });

  test('ein kaputtes oder leeres Geheimnis gilt nie — und wirft nicht', () => {
    assert.equal(totp.pruefen('', codeFuer(0), { jetzt }), null);
    assert.equal(totp.pruefen('11111111', codeFuer(0), { jetzt }), null);
    assert.equal(totp.pruefen(null, codeFuer(0), { jetzt }), null);
  });

  test('führende Nullen bleiben erhalten', () => {
    // t = 1234567890 s hat den Code 005924.
    const t = 1234567890 * 1000;
    assert.equal(totp.pruefen(GEHEIMNIS, '005924', { jetzt: t }), totp.schrittVon(t));
    assert.equal(totp.pruefen(GEHEIMNIS, '5924', { jetzt: t }), null);
  });
});

describe('uri', () => {
  test('so liest jede Authenticator-App es ein', () => {
    const u = new URL(totp.uri({ geheimnis: GEHEIMNIS, konto: 'robin@example.org' }));
    assert.equal(u.protocol, 'otpauth:');
    assert.equal(u.host, 'totp');
    assert.equal(decodeURIComponent(u.pathname), '/Mail-Panel:robin@example.org');
    assert.equal(u.searchParams.get('secret'), GEHEIMNIS);
    assert.equal(u.searchParams.get('issuer'), 'Mail-Panel');
    assert.equal(u.searchParams.get('digits'), '6');
    assert.equal(u.searchParams.get('period'), '30');
    assert.equal(u.searchParams.get('algorithm'), 'SHA1');
  });

  test('Sonderzeichen im Benutzernamen werden kodiert', () => {
    const s = totp.uri({ geheimnis: GEHEIMNIS, konto: 'a b&c?d' });
    assert.ok(!/[ &?].*\?/.test(s.split('?')[0]), s);
    assert.match(s, /a%20b%26c%3Fd/);
  });
});
